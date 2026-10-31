import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { gzipSync } from "node:zlib";
import { createApp } from "../../src/app.js";
import { env } from "../../src/config/env.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { setTextModelOverrideForTests } from "../../src/services/agent-mode.js";
import { countChangedLines } from "../../src/services/code-cut.js";
import { actorAnonId, actorFromClientId, editorExerciseKey, exerciseHash } from "../../src/services/telemetry.js";

/**
 * El tutor de codigo en VS Code (30-10-2026), de punta a punta en /suggest-tab:
 *   - el caso real: «Proponer una mejora» sobre `int main(){...}` (4 lineas) y el modelo escribe
 *     un main de 14: sale un reemplazo parcial que se puede aplicar (apply-check lo deja) y que
 *     no le quita lineas al estudiante; nada de «// ... recortado» dentro del bloque;
 *   - code_application dice el recorte (truncation, cut, reasonCode) para VS Code 0.0.38;
 *   - la etapa sube con los pedidos explicitos (5, 10, el maximo del docente) y no con los
 *     automaticos, por archivo y en una ventana de 30 min;
 *   - con la referencia del examen, el recorte se hace sobre el unico bloque que queda.
 * Codigo ficticio: nada de la solucion del taller (el repositorio es publico).
 */

type Json = Record<string, any>;

async function startServer() {
  const database = await createDatabase();
  const app = createApp(database, {});
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("sin puerto");
  return { database, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server, database: AppDatabase) {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await database.close();
}

async function call(baseUrl: string, method: string, route: string, options: { sessionId?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(options.sessionId ? { "x-session-id": options.sessionId } : {}),
      ...(options.headers || {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let data: Json = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { text };
  }
  return { status: response.status, data };
}

const CLIENT_ID = "vscode-codigo-0038";
const CLIENT = { "x-adaceen-client-id": CLIENT_ID };

const SELECTION = ["int main(){", "    cout << \"Hola\";", "    return 0;", "}"].join("\n");
const PROPOSED = [
  "int main() {",
  "    Persona persona(\"001\", \"Ana\");",
  "    Caja caja(1, 1000);",
  "    cout << \"Total inicial: \" << caja.getTotal() << endl;",
  "    if (caja.sacar(200)) {",
  "        cout << \"Listo\" << endl;",
  "    } else {",
  "        cout << \"No alcanza\" << endl;",
  "    }",
  "    caja.meter(500);",
  "    cout << \"Total final: \" << caja.getTotal() << endl;",
  "    cout << \"Hola\";",
  "    return 0;",
  "}",
].join("\n");

function modelAnswer(code: string, applyLine = "Aplicar: replace") {
  return ["1) Resumen:", "- El main todavia no usa las clases.", "", "4) Accion:", applyLine, "```cpp", code, "```", "", "5) Riesgos:", "- Compila despues de cada cambio."].join("\n");
}

function suggestBody(extra: Record<string, unknown> = {}) {
  return {
    tab_content: `#include <iostream>\nusing namespace std;\n\n${SELECTION}\n`,
    question: "Mejora el bloque seleccionado.",
    tab_title: "src/main.cpp",
    tab_url: "vscode://alumno/taller/src/main.cpp",
    suggestion_scope: "cursor",
    filePath: "src/main.cpp",
    languageHint: "cpp",
    selection: SELECTION,
    trigger: "manual",
    requestedAction: "replace",
    ...extra,
  };
}

function firstFence(markdown: string) {
  return markdown.match(/```[^\n]*\n([\s\S]*?)```/)?.[1].replace(/\n$/, "") || "";
}

test("/suggest-tab (caso real): el main de 14 lineas sale como reemplazo parcial aplicable y apply-check lo deja aplicar", async () => {
  setTextModelOverrideForTests(async () => modelAnswer(PROPOSED));
  const { server, database, baseUrl } = await startServer();
  try {
    const reply = await call(baseUrl, "POST", "/suggest-tab", { body: suggestBody(), headers: CLIENT });
    assert.equal(reply.status, 200, JSON.stringify(reply.data));
    const output = String(reply.data.output_text);
    assert.equal(reply.data.policy_applied.helpStage, "hint_1");
    assert.match(output, /^Aplicar: replace$/m, "se puede aplicar");
    assert.doesNotMatch(output, /\/\/ \.\.\.|recortado por la politica|completa el resto/);
    const code = firstFence(output);
    const changed = countChangedLines(SELECTION, code);
    assert.ok(changed >= 1 && changed <= 5);
    for (const line of SELECTION.split("\n")) {
      assert.ok(code.split("\n").some((kept) => kept.trim() === line.trim()), `no se pierde: ${line}`);
    }

    // code_application para VS Code 0.0.38: el recorte como dato, no como texto.
    const app = reply.data.code_application;
    assert.equal(app.allowed, true);
    assert.equal(app.maxLines, 5);
    assert.equal(app.reasonCode, "ok");
    assert.equal(app.truncation, "applicable");
    assert.deepEqual(app.cut, { kind: "partial", changesShown: changed, changesTotal: 11 });

    // apply-check con la cuenta de VS Code (measureCodeChange = countChangedLines).
    const check = await call(baseUrl, "POST", "/api/suggestions/apply-check", {
      body: { decisionId: reply.data.decision_id, filePath: "src/main.cpp", language: "cpp", applyMode: "replace", linesChanged: changed, trigger: "manual" },
      headers: CLIENT,
    });
    assert.equal(check.status, 200);
    assert.equal(check.data.allowed, true);

    const decisions = (await database.listTelemetryEvents()).filter((row) => row.eventType === "tutor_decision");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].metadata.reason, "codigo_parcial_aplicable");
    assert.equal(decisions[0].metadata.allowed, true);
    assert.equal(decisions[0].metadata.explicitRequest, true);

    // Pedir y aplicar la misma sugerencia es UN paso (lo mayor, no la suma): la pista 2.
    const next = await call(baseUrl, "POST", "/suggest-tab", { body: suggestBody(), headers: CLIENT });
    assert.equal(next.data.policy_applied.helpStage, "hint_2");
    assert.equal(next.data.code_application.maxLines, 10);
    assert.equal(next.data.code_application.truncation, "applicable");
    assert.deepEqual(next.data.code_application.cut, { kind: "partial", changesShown: 10, changesTotal: 11 });

    // El tercer pedido ya es el ejemplo parcial (maximo del docente, 20): la propuesta entera.
    const third = await call(baseUrl, "POST", "/suggest-tab", { body: suggestBody(), headers: CLIENT });
    assert.equal(third.data.policy_applied.helpStage, "partial_example");
    assert.equal(third.data.code_application.maxLines, 20);
    assert.equal(third.data.code_application.truncation, "none", "sin recorte");
    assert.equal(third.data.code_application.cut, null, "cut va siempre; null sin recorte");
    assert.equal(firstFence(third.data.output_text), PROPOSED);
  } finally {
    setTextModelOverrideForTests(null);
    await stopServer(server, database);
  }
});

test("/suggest-tab: un recorte de guia lo dice en code_application (guide, cut y code_application_too_large)", async () => {
  // Reescritura completa: no es una version del bloque, asi que no hay reemplazo parcial.
  const rewrite = Array.from({ length: 9 }, (_, index) => `    paso_${index + 1}();`).join("\n");
  setTextModelOverrideForTests(async () => modelAnswer(rewrite));
  const { server, database, baseUrl } = await startServer();
  try {
    const reply = await call(baseUrl, "POST", "/suggest-tab", { body: suggestBody(), headers: CLIENT });
    const app = reply.data.code_application;
    assert.equal(app.allowed, false);
    assert.equal(app.reasonCode, "code_application_too_large");
    assert.match(app.reason, /usalo como guia/);
    assert.equal(app.truncation, "guide");
    assert.deepEqual(app.cut, { kind: "prefix", linesShown: 5, linesTotal: 9, endsCleanly: true });
    assert.doesNotMatch(reply.data.output_text, /aplicar\s*:/i);
    assert.match(reply.data.output_text, /```\n\n_El tutor muestra 5 de 9 lineas: el resto lo escribes tu\._/);
    const [decision] = (await database.listTelemetryEvents()).filter((row) => row.eventType === "tutor_decision");
    assert.equal(decision.metadata.reason, "codigo_recortado_guia");
  } finally {
    setTextModelOverrideForTests(null);
    await stopServer(server, database);
  }
});

test("etapa del editor: tres pedidos explicitos suben 5 -> 10 -> maximo; los automaticos, otro archivo y los viejos no", async () => {
  const prompts: string[] = [];
  setTextModelOverrideForTests(async (input) => {
    prompts.push(input);
    return modelAnswer("    cout << \"Total\";", "Aplicar: insert");
  });
  const { server, database, baseUrl } = await startServer();
  try {
    const ask = (extra: Record<string, unknown>) => call(baseUrl, "POST", "/suggest-tab", { body: suggestBody({ requestedAction: undefined, ...extra }), headers: CLIENT });
    const stageOf = (reply: { data: Json }) => [reply.data.policy_applied.helpStage, reply.data.code_application.maxLines];

    // Automaticos primero: no suben ni cuentan.
    assert.deepEqual(stageOf(await ask({ trigger: "cursor_idle" })), ["hint_1", 5]);
    assert.deepEqual(stageOf(await ask({ trigger: "selection", tab_content: `${SELECTION}\n// otro` })), ["hint_1", 5]);

    // «Otra sugerencia» tres veces sobre el mismo archivo.
    assert.deepEqual(stageOf(await ask({ trigger: "manual" })), ["hint_1", 5]);
    assert.deepEqual(stageOf(await ask({ trigger: "manual" })), ["hint_2", 10]);
    assert.match(prompts[prompts.length - 1], /PISTA NIVEL 2 \(editor\)/);
    assert.deepEqual(stageOf(await ask({ trigger: "manual" })), ["partial_example", 20]);
    // Un pedido de codigo tambien es explicito (sin trigger manual).
    assert.deepEqual(stageOf(await ask({ trigger: "selection", requestedAction: "insert" })), ["partial_example", 20]);

    // Un automatico despues no hereda la etapa (no hay aplicaciones) y el cupo sigue intacto.
    const automatic = await ask({ trigger: "cursor_idle", tab_content: `${SELECTION}\n// quieto` });
    assert.deepEqual(stageOf(automatic), ["hint_1", 5]);
    assert.equal(automatic.data.code_application.remaining, 3, "remaining cuenta solo aplicaciones");

    // Otro archivo empieza de cero.
    assert.deepEqual(stageOf(await ask({ trigger: "manual", filePath: "src/otro.cpp", tab_title: "src/otro.cpp" })), ["hint_1", 5]);

    // El resumen del archivo con trigger manual («Otra sugerencia» sin seleccion) no cuenta.
    await ask({ trigger: "manual", suggestion_scope: "file_summary", filePath: "src/tercero.cpp", tab_title: "src/tercero.cpp" });
    await ask({ trigger: "manual", suggestion_scope: "file_summary", filePath: "src/tercero.cpp", tab_title: "src/tercero.cpp" });
    assert.deepEqual(stageOf(await ask({ trigger: "manual", filePath: "src/tercero.cpp", tab_title: "src/tercero.cpp" })), ["hint_1", 5]);

    // Pedidos de hace mas de 30 min no cuentan; los de la ventana si.
    const actor = actorFromClientId(CLIENT_ID)!;
    const old = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const decision = (occurredAt: string) => ({
      source: "backend" as const,
      channel: "vscode",
      category: "tutor",
      eventType: "tutor_decision",
      decisionId: `d-${occurredAt}`,
      exerciseKey: "file:src/viejo.cpp",
      filePath: "src/viejo.cpp",
      blocked: false,
      occurredAt,
      metadata: { trigger: "manual", scope: "cursor", explicitRequest: true },
    });
    await database.insertTelemetryEvents([decision(old), decision(old), decision(old)], actor);
    const viejo = { filePath: "src/viejo.cpp", tab_title: "src/viejo.cpp" };
    assert.deepEqual(stageOf(await ask({ trigger: "manual", ...viejo })), ["hint_1", 5], "los de hace 40 min no cuentan");
    await database.insertTelemetryEvents([decision(recent)], actor);
    assert.deepEqual(stageOf(await ask({ trigger: "manual", ...viejo })), ["partial_example", 20], "el de hace 10 min y el de recien");

    // El metodo de la base, directo: solo pedidos explicitos no bloqueados del editor.
    const since = new Date(Date.now() - 30 * 60 * 1000);
    assert.equal(await database.countRecentExplicitEditorRequests(actorAnonId(actor), exerciseHash("file:src/main.cpp"), since), 4);
    assert.equal(await database.countRecentExplicitEditorRequests(actorAnonId(actor), exerciseHash("file:src/tercero.cpp"), since), 1);
    assert.equal(await database.countRecentExplicitEditorRequests(actorAnonId(actor), exerciseHash("file:src/viejo.cpp"), since), 3);
    assert.equal(await database.countRecentExplicitEditorRequests("", exerciseHash("file:src/main.cpp"), since), 0);
  } finally {
    setTextModelOverrideForTests(null);
    await stopServer(server, database);
  }
});

test("etapa del editor: los pedidos durante una caida del modelo no suben la etapa", async () => {
  let failing = true;
  setTextModelOverrideForTests(async () => {
    if (failing) throw new Error("modelo no disponible (prueba)");
    return modelAnswer("    cout << \"Total\";", "Aplicar: insert");
  });
  const { server, database, baseUrl } = await startServer();
  try {
    const ask = () => call(baseUrl, "POST", "/suggest-tab", { body: suggestBody({ requestedAction: undefined, trigger: "manual" }), headers: CLIENT });
    for (let click = 0; click < 3; click += 1) {
      const reply = await ask();
      assert.equal(reply.data.degraded, true, "sin modelo: mensaje controlado");
    }
    const decisions = (await database.listTelemetryEvents()).filter((row) => row.eventType === "tutor_decision");
    assert.equal(decisions.length, 3);
    assert.ok(decisions.every((row) => row.reasonCode === "model_error_fallback" && row.metadata.explicitRequest === undefined));

    // Vuelve el modelo: el estudiante no recibio ayuda, asi que sigue en la pista 1.
    failing = false;
    const back = await ask();
    assert.equal(back.data.policy_applied.helpStage, "hint_1");
    assert.equal(back.data.code_application.maxLines, 5);
  } finally {
    setTextModelOverrideForTests(null);
    await stopServer(server, database);
  }
});

test("/suggest-tab: una respuesta con la valla a mitad de linea y margen numerado no se reintenta, se guarda y sale limpia", async () => {
  const prompts: string[] = [];
  setTextModelOverrideForTests(async (input) => {
    prompts.push(input);
    if (!/Pedido del estudiante: MEJORAR/.test(input)) return "1) Resumen:\n- Revisa el main.";
    return [
      "1) Resumen:",
      "- Version mejorada.",
      "Aplicar: replace",
      "Codigo: ```cpp",
      " 1>| int main(){",
      " 2 |     cout << \"Hola\";",
      " 3 |     cout << \"Adios\";",
      " 4 |     return 0;",
      " 5 | }",
      "```",
    ].join("\n");
  });
  const { server, database, baseUrl } = await startServer();
  try {
    // Dos «Otra sugerencia» antes: el pedido de codigo queda en el ejemplo parcial (la etapa ya no
    // cambia y la cache de los pedidos siguientes es la misma).
    const plain = { requestedAction: undefined, trigger: "manual" };
    await call(baseUrl, "POST", "/suggest-tab", { body: suggestBody(plain), headers: CLIENT });
    await call(baseUrl, "POST", "/suggest-tab", { body: suggestBody(plain), headers: CLIENT });
    assert.equal(prompts.length, 2);

    const improved = await call(baseUrl, "POST", "/suggest-tab", { body: suggestBody(), headers: CLIENT });
    assert.equal(prompts.length, 3, "sin reintento: la valla a mitad de linea no se toma por un bloque sin cerrar");
    const output = String(improved.data.output_text);
    assert.doesNotMatch(output, /\d+\s*>?\s*\|/, "sin el margen numerado");
    assert.match(output, /```cpp\nint main\(\)\{\n {4}cout << "Hola";\n {4}cout << "Adios";/);
    assert.match(output, /^Aplicar: replace$/m);
    assert.equal(improved.data.code_application.truncation, "none", "una linea cambiada: sin recorte");
    assert.equal(improved.data.code_application.allowed, true);

    // Se guardo: el mismo pedido con un disparador automatico sale de la cache, sin el modelo.
    const again = await call(baseUrl, "POST", "/suggest-tab", { body: suggestBody({ trigger: "selection" }), headers: CLIENT });
    assert.equal(prompts.length, 3, "salio de la cache");
    assert.equal(again.data.cached, true);
    assert.equal(again.data.output_text, output);
  } finally {
    setTextModelOverrideForTests(null);
    await stopServer(server, database);
  }
});

test("etapa del editor: un tutor_decision forjado por un cliente se rechaza y no sube la etapa", async () => {
  setTextModelOverrideForTests(async () => modelAnswer("    cout << \"Total\";", "Aplicar: insert"));
  const { server, database, baseUrl } = await startServer();
  try {
    const forged = (source: string, eventType = "tutor_decision") => ({
      source,
      category: "tutor",
      eventType,
      filePath: "src/forjado.cpp",
      metadata: { explicitRequest: true, trigger: "manual", scope: "cursor" },
    });
    const post = (events: unknown[]) => call(baseUrl, "POST", "/api/behavior/events", { body: { events }, headers: CLIENT });
    const asClient = await post([forged("vscode_extension"), forged("vscode_extension"), forged("vscode_extension")]);
    assert.equal(asClient.status, 400, "tutor_decision solo lo escribe el servidor");
    assert.match(String(asClient.data.error), /tutor_decision/);
    assert.equal((await post([forged("backend", "vscode_suggestion_shown")])).status, 400, "source backend no es de un cliente");
    assert.equal((await post([forged("system", "vscode_suggestion_shown")])).status, 400);
    assert.equal((await post([forged("vscode_extension", "code_application_checked")])).status, 400);
    assert.equal((await post([{ ...forged("vscode_extension", "vscode_suggestion_shown"), category: "suggestion" }])).status, 200, "un evento de cliente sigue entrando");

    // Aunque una fila asi ya estuviera en la base (escrita por un cliente), no cuenta.
    const actor = actorFromClientId(CLIENT_ID)!;
    await database.insertTelemetryEvents([1, 2, 3].map(() => ({
      source: "vscode_extension" as const,
      category: "tutor",
      eventType: "tutor_decision",
      exerciseKey: "file:src/forjado.cpp",
      filePath: "src/forjado.cpp",
      blocked: false,
      metadata: { explicitRequest: true, trigger: "manual", scope: "cursor" },
    })), actor);
    const since = new Date(Date.now() - 30 * 60 * 1000);
    assert.equal(await database.countRecentExplicitEditorRequests(actorAnonId(actor), exerciseHash("file:src/forjado.cpp"), since), 0);

    const reply = await call(baseUrl, "POST", "/suggest-tab", {
      body: suggestBody({ requestedAction: undefined, trigger: "manual", filePath: "src/forjado.cpp", tab_title: "src/forjado.cpp" }),
      headers: CLIENT,
    });
    assert.equal(reply.data.policy_applied.helpStage, "hint_1");
    assert.equal(reply.data.code_application.maxLines, 5);
  } finally {
    setTextModelOverrideForTests(null);
    await stopServer(server, database);
  }
});

test("telemetria: /suggest-tab y apply-check dan el mismo ejercicio para el mismo archivo", async () => {
  setTextModelOverrideForTests(async () => modelAnswer("    cout << \"Total\";", "Aplicar: insert"));
  const { server, database, baseUrl } = await startServer();
  try {
    await call(baseUrl, "POST", "/suggest-tab", { body: suggestBody({ filePath: "src/Cuenta.cpp", tab_title: "src/Cuenta.cpp" }), headers: CLIENT });
    await call(baseUrl, "POST", "/api/suggestions/apply-check", {
      body: { filePath: "SRC/cuenta.CPP", language: "cpp", applyMode: "insert", linesChanged: 1, trigger: "manual" },
      headers: CLIENT,
    });
    const rows = await database.listTelemetryEvents();
    const decision = rows.find((row) => row.eventType === "tutor_decision");
    const check = rows.find((row) => row.eventType === "code_application_checked");
    assert.ok(decision && check);
    assert.equal(decision.exerciseHash, check.exerciseHash);
    assert.equal(decision.exerciseHash, exerciseHash(editorExerciseKey("src/cuenta.cpp")));
  } finally {
    setTextModelOverrideForTests(null);
    await stopServer(server, database);
  }
});

test("/suggest-tab con la referencia del examen: el recorte se hace sobre el unico bloque que queda", async () => {
  const previous = { b64: env.examReferenceB64, mode: env.examReferenceSwitch };
  const reference = {
    version: 1,
    examen: "prueba",
    repo: "eydersantiago/sistema-bancario-fpoo",
    plan: "Plan de prueba",
    errores: "Errores de prueba",
    pasos: [{ id: "main", titulo: "Paso main", archivos: ["src/main.cpp"], apoyo: [], guia: "GUIA-MAIN" }],
    archivos: { "src/main.cpp": "IMPL-DE-PRUEBA" },
  };
  env.examReferenceB64 = gzipSync(Buffer.from(JSON.stringify(reference), "utf8")).toString("base64");
  env.examReferenceSwitch = "";
  const eight = Array.from({ length: 8 }, (_, index) => `    paso_${index + 1}();`).join("\n");
  const twoBlocks = ["1) Resumen:", "- Dos partes.", "", "Aplicar: insert", "```cpp", eight, "```", "", "Despues:", "```cpp", "    otra();", "```"].join("\n");
  setTextModelOverrideForTests(async () => twoBlocks);
  const { server, database, baseUrl } = await startServer();
  try {
    const login = await call(baseUrl, "POST", "/api/auth/login", { body: { email: "estudiante@adaceen.edu.co", password: "Estudiante123!" } });
    const sessionId = String(login.data.session?.id || "");
    const body = suggestBody({ requestedAction: "insert", selection: "", trigger: "manual" });
    const exam = await call(baseUrl, "POST", "/suggest-tab", {
      sessionId,
      headers: CLIENT,
      body: { ...body, repoFullName: "eydersantiago/sistema-bancario-fpoo", tab_url: "vscode://eydersantiago/sistema-bancario-fpoo/src/main.cpp" },
    });
    assert.equal(exam.status, 200);
    assert.doesNotMatch(exam.data.output_text, /otra\(\);/, "solo queda el primer bloque");
    assert.equal(exam.data.code_application.truncation, "applicable", "un solo bloque: el corte cerrado se puede insertar");
    assert.match(exam.data.output_text, /^Aplicar: insert$/m);
    assert.match(exam.data.output_text, /paso_5\(\);\n```/);

    // Fuera del examen la misma respuesta trae dos bloques: VS Code solo aplica el primero, guia.
    const other = await call(baseUrl, "POST", "/suggest-tab", {
      sessionId,
      headers: CLIENT,
      body: { ...body, filePath: "src/otro.cpp", tab_title: "src/otro.cpp", repoFullName: "alumno/taller", tab_url: "vscode://alumno/taller/src/otro.cpp" },
    });
    assert.equal(other.data.code_application.truncation, "guide");
    assert.doesNotMatch(other.data.output_text, /aplicar\s*:/i);
  } finally {
    setTextModelOverrideForTests(null);
    env.examReferenceB64 = previous.b64;
    env.examReferenceSwitch = previous.mode;
    await stopServer(server, database);
  }
});
