import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../../src/app.js";
import { env } from "../../src/config/env.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { setTextModelOverrideForTests } from "../../src/services/agent-mode.js";

/**
 * Contrato backend <-> VS Code 0.0.38 (31-10-2026), con el codigo real de los dos lados.
 *
 * Las pruebas de cada repositorio pasaban con sus propios datos de ejemplo mientras el otro lado
 * cambiaba de nombres (my-progress -> workshop-progress/me, missing -> pending, shown -> linesShown,
 * classes -> diagramClasses): el indicador de avance se habria escondido sin un solo error. Aqui
 * la respuesta HTTP real de /suggest-tab y de /api/workshop-progress/me pasa por los lectores de
 * la extension (vscode-ext-prod/src/code-application.ts y workshop-progress.ts, sin vscode) y no
 * se puede perder ningun campo por el camino.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const CODE_APPLICATION_MODULE = path.join(ROOT, "vscode-ext-prod/src/code-application.ts");
const WORKSHOP_PROGRESS_MODULE = path.join(ROOT, "vscode-ext-prod/src/workshop-progress.ts");
const DIAGRAM_MODEL_MODULE = path.join(ROOT, "vscode-ext-prod/src/diagram-model.ts");
// Sin el submodulo (un clon sin --recurse-submodules) no hay con que comparar.
const VSCODE_MISSING = [CODE_APPLICATION_MODULE, WORKSHOP_PROGRESS_MODULE, DIAGRAM_MODEL_MODULE].some((file) => !existsSync(file));

type Json = Record<string, any>;

async function loadExtensionModule(file: string) {
  const imported = await import(file);
  // El submodulo es CommonJS: con tsx las exportaciones llegan en default.
  return (imported.default ?? imported) as Json;
}

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
  return { status: response.status, data: (text ? JSON.parse(text) : {}) as Json };
}

// Codigo ficticio (el repositorio es publico: nada de la solucion del taller).
const SELECTION = ["int main(){", "    cout << \"Hola\";", "    return 0;", "}"].join("\n");
const LONG_MAIN = [
  "int main() {",
  "    Caja caja(1, 1000);",
  "    cout << caja.getTotal() << endl;",
  "    if (caja.sacar(200)) {",
  "        cout << \"Listo\" << endl;",
  "    } else {",
  "        cout << \"No alcanza\" << endl;",
  "    }",
  "    caja.meter(500);",
  "    cout << caja.getTotal() << endl;",
  "    cout << \"Hola\";",
  "    return 0;",
  "}",
].join("\n");
const LONG_INSERT = Array.from({ length: 12 }, (_, index) => `    cout << \"Paso ${index + 1}\" << endl;`).join("\n");

function answer(code: string, applyLine: string, closed = true) {
  return ["1) Resumen:", "- Falta usar las clases en main.", "", "4) Accion:", applyLine, "```cpp", code, ...(closed ? ["```", "", "5) Riesgos:", "- Compila despues de cada cambio."] : [])].join("\n");
}

function suggestBody(requestedAction: "insert" | "replace") {
  return {
    tab_content: `#include <iostream>\nusing namespace std;\n\n${SELECTION}\n`,
    question: "Ayudame con el bloque seleccionado.",
    tab_title: "src/main.cpp",
    tab_url: "vscode://alumno/taller/src/main.cpp",
    suggestion_scope: "cursor",
    filePath: "src/main.cpp",
    languageHint: "cpp",
    selection: SELECTION,
    trigger: "manual",
    requestedAction,
  };
}

test("contrato VS Code: code_application de /suggest-tab llega entero al lector de la extension", { skip: VSCODE_MISSING && "sin el submodulo vscode-ext-prod" }, async () => {
  const contract = await loadExtensionModule(CODE_APPLICATION_MODULE);
  assert.equal(typeof contract.normalizeSuggestionCodeApplication, "function", "lector real de la extension");

  const cases: Array<{ name: string; action: "insert" | "replace"; model: string; truncation: string; cutKind: string | null; reasonCode?: string }> = [
    { name: "reemplazo largo: parcial aplicable", action: "replace", model: answer(LONG_MAIN, "Aplicar: replace"), truncation: "applicable", cutKind: "partial" },
    { name: "insercion larga: trozo cerrado", action: "insert", model: answer(LONG_INSERT, "Aplicar: insert"), truncation: "applicable", cutKind: "prefix" },
    { name: "respuesta cortada a mitad del bloque", action: "insert", model: answer(LONG_INSERT, "Aplicar: insert", false), truncation: "guide", cutKind: null, reasonCode: "code_application_incomplete_reply" },
    { name: "sin recorte", action: "insert", model: answer("    cout << \"Hola\";", "Aplicar: insert"), truncation: "none", cutKind: null },
  ];

  const { server, database, baseUrl } = await startServer();
  try {
    for (const [index, item] of cases.entries()) {
      setTextModelOverrideForTests(async () => item.model);
      // Un cliente por caso: cada uno empieza en la etapa 1 (5 lineas) y no comparte cache.
      const reply = await call(baseUrl, "POST", "/suggest-tab", { body: suggestBody(item.action), headers: { "x-adaceen-client-id": `vscode-contrato-${index}` } });
      assert.equal(reply.status, 200, `${item.name}: ${JSON.stringify(reply.data)}`);
      const wire = reply.data.code_application as Json;
      assert.ok(wire, `${item.name}: sin code_application`);
      assert.equal(wire.truncation, item.truncation, `${item.name}: truncation del backend`);
      if (item.reasonCode) assert.equal(wire.reasonCode, item.reasonCode, `${item.name}: reasonCode del backend`);
      assert.ok("cut" in wire, `${item.name}: cut siempre presente (null sin recorte)`);
      if (item.cutKind) assert.equal(wire.cut?.kind, item.cutKind, `${item.name}: tipo de corte`);

      const read = contract.normalizeSuggestionCodeApplication(wire) as Json;
      assert.ok(read, `${item.name}: la extension no entendio la respuesta`);
      for (const key of ["allowed", "maxLines", "remaining", "requireConfirmation", "countsAsHint", "reason", "reasonCode", "truncation"]) {
        assert.deepEqual(read[key], wire[key], `${item.name}: la extension pierde o cambia ${key}`);
      }
      // cut: todos los campos del backend, con los mismos nombres (si el backend renombra, falla aqui).
      assert.deepEqual(read.cut, wire.cut, `${item.name}: la extension pierde o cambia cut`);
    }
  } finally {
    setTextModelOverrideForTests(null);
    await stopServer(server, database);
  }
});

test("contrato VS Code: /api/workshop-progress/me llega entero al lector y al indicador de la extension", { skip: VSCODE_MISSING && "sin el submodulo vscode-ext-prod" }, async () => {
  const progressModule = await loadExtensionModule(WORKSHOP_PROGRESS_MODULE);
  assert.equal(progressModule.PROGRESS_PATH, "/api/workshop-progress/me", "la extension pide la ruta del backend");
  const original = env.workspaceAgentToken;
  env.workspaceAgentToken = "token-del-agente-de-contrato";
  const { server, database, baseUrl } = await startServer();
  try {
    const ana = await database.createManagedUser({ role: "student", email: "ana.contrato@correounivalle.edu.co", displayName: "Ana", password: "Temporal-12345", teacherUserId: "user-teacher-demo" });
    await database.upsertGithubUserToken({ userId: ana.id, accountLogin: "ana-contrato", accessToken: "gho_contrato" });
    const sessionId = (await database.authenticateUser(ana.email, "Temporal-12345"))!.id;
    const points = Array.from({ length: 12 }, (_, index) => ({ id: `p${index + 1}`, hu: `HU-${Math.floor(index / 4) + 1}`, texto: `Punto ${index + 1}`, peso: 10 }));
    const entry = { login: "ana-contrato", started: true, percent: 35, compiles: true, done: ["p1", "p2"], partial: ["p3", "p4", "p5"], missing: points.slice(5).map((point) => point.id), files: 4, lastChangeAt: new Date().toISOString() };
    const report = { taller: "sistema-bancario-fpoo", titulo: "Sistema bancario", generatedAt: new Date().toISOString(), points, students: [entry] };
    assert.equal((await call(baseUrl, "POST", "/api/workspaces/progress-report", { headers: { "x-agent-token": env.workspaceAgentToken }, body: report })).status, 200);

    const url = progressModule.progressUrl(baseUrl, "eydersantiago/sistema-bancario-fpoo") as string;
    assert.ok(url.startsWith(`${baseUrl}/api/workshop-progress/me?repoFullName=`), url);
    const reply = await call(baseUrl, "GET", url.slice(baseUrl.length), { sessionId });
    assert.equal(reply.status, 200);
    const wire = reply.data;
    assert.equal(wire.status, "en-curso");

    const read = progressModule.normalizeWorkshopProgressReply(wire) as Json;
    assert.ok(read, "la extension no entendio la respuesta");
    assert.equal(read.status, wire.status);
    for (const key of Object.keys(wire.progress)) {
      if (key === "lastChangeAt" && wire.progress[key] === null) continue; // la extension usa '' para «sin dato»
      assert.deepEqual(read.progress[key], wire.progress[key], `la extension pierde o cambia progress.${key}`);
    }
    assert.equal(read.progress.pendingCount, 10, "3 a medias y 7 sin empezar de 12 (2 hechos)");
    assert.equal(read.progress.pending.length, 8, "la lista llega con el tope del backend");
    const pill = progressModule.buildProgressPill(read) as Json;
    assert.ok(pill, "el indicador se muestra");
    assert.match(pill.text, /35/);
    assert.match(pill.title, /… y 2 puntos más/, "el resto de la lista sale de pendingCount");

    // Los estados sin avance tambien se entienden (sin-taller esconde el indicador).
    const none = await call(baseUrl, "GET", "/api/workshop-progress/me?repoFullName=alumno/otro-ejercicio", { sessionId });
    assert.deepEqual(progressModule.normalizeWorkshopProgressReply(none.data), { status: "sin-taller", progress: null });
  } finally {
    env.workspaceAgentToken = original;
    await stopServer(server, database);
  }
});

test("contrato VS Code: las cuentas de vscode_diagram_opened son claves que el backend guarda", { skip: VSCODE_MISSING && "sin el submodulo vscode-ext-prod" }, async () => {
  const diagram = await loadExtensionModule(DIAGRAM_MODEL_MODULE);
  const { listMetadataFields } = await import("../../src/services/telemetry.js");
  assert.equal(typeof diagram.diagramTelemetryMetadata, "function", "metadata real de la extension");
  const metadata = diagram.diagramTelemetryMetadata({ counts: { classes: 6, done: 3, partial: 2, missing: 1 } }) as Json;
  assert.ok(Object.keys(metadata).length >= 4, JSON.stringify(metadata));
  const fields = new Map(listMetadataFields().map((field) => [field.key, field.type]));
  for (const [key, value] of Object.entries(metadata)) {
    assert.equal(fields.get(key), "uint", `el backend descartaria metadata.${key} (no es una cuenta permitida)`);
    assert.ok(Number.isInteger(value) && (value as number) >= 0, `metadata.${key} = ${value}`);
  }
});
