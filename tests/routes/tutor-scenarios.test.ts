import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { createApp } from "../../src/app.js";
import { env } from "../../src/config/env.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { seedTeacherPolicy } from "../../src/db/seeds.js";
import { setTextModelOverrideForTests } from "../../src/services/agent-mode.js";
import {
  referenceModelOutput,
  referenceSmallFixOutput,
  SCENARIO_CPP_CODE,
  TUTOR_SCENARIOS,
} from "../../src/services/tutor-scenarios.js";
import { recordWorkerHeartbeat, resetWorkerHeartbeatsForTests } from "../../src/services/worker-heartbeat.js";

/**
 * A9.5 (escenarios S1-S5 en overlay y editor), A10.5 (casos negativos:
 * no inventar, no entregar la solucion, no guardar datos sensibles), A10.8
 * (aplicacion de codigo controlada) y A12.10 (degradacion sin modelo).
 *
 * El modelo se reemplaza por la salida de referencia de
 * src/services/tutor-scenarios.ts: siempre trae 14 lineas de codigo y
 * "Aplicar:", para comprobar que la politica recorta lo que sobra.
 */

async function startTestServer() {
  const database = await createDatabase();
  const app = createApp(database);
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No se pudo iniciar servidor de prueba.");
  }
  return { database, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopTestServer(server: Server, database: AppDatabase) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await database.close();
}

async function login(baseUrl: string, email: string, password: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ email, password }),
  });
  const data = await response.json() as { session?: { id?: string } };
  assert.equal(response.status, 200);
  return String(data.session?.id || "");
}

type ModelMode = "reference" | "small" | "fail";
const modelState = { mode: "reference" as ModelMode, prompts: [] as string[] };

function installReferenceModel() {
  modelState.mode = "reference";
  modelState.prompts = [];
  setTextModelOverrideForTests(async (input) => {
    modelState.prompts.push(input);
    if (modelState.mode === "fail") throw new Error("modelo no disponible (prueba)");
    if (modelState.mode === "small" && !/Devuelve SOLO JSON valido/.test(input)) return referenceSmallFixOutput();
    return referenceModelOutput(input);
  });
}

type InterveneResponse = {
  ok: boolean;
  source: string;
  blocked: boolean;
  help_stage: string;
  decision_id: string | null;
  policy_applied: { eventType: string; blocked: boolean; helpStage: string; reasonCode: string } | null;
  result: { ideas: string[]; searches: string[]; guide: string[]; welcome_message: string };
  rag_sources?: unknown[];
};

type SuggestResponse = {
  ok: boolean;
  output_text: string;
  blocked: boolean;
  degraded?: boolean;
  decision_id: string | null;
  policy_applied: { eventType: string; blocked: boolean; helpStage: string; reasonCode: string } | null;
  code_application: { allowed: boolean; maxLines: number; remaining: number | null; reason: string } | null;
};

async function postJson<T>(baseUrl: string, route: string, body: unknown, headers: Record<string, string>) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() as T };
}

const FALLBACK_START = seedTeacherPolicy.fallbackMessage.slice(0, 30);

test("escenarios S1-S5 en el overlay (/intervene) con la politica base y sin datos sensibles en la traza", async () => {
  const { server, database, baseUrl } = await startTestServer();
  installReferenceModel();
  try {
    const sessionId = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");
    const decisions = new Map<string, string>();

    for (const scenario of TUTOR_SCENARIOS) {
      const promptsBefore = modelState.prompts.length;
      const { status, data } = await postJson<InterveneResponse>(
        baseUrl,
        "/intervene",
        { question: scenario.overlay.question, context: scenario.overlay.context, max_items: 5 },
        { "x-session-id": sessionId },
      );
      const expected = scenario.overlay.expected;
      assert.equal(status, 200, scenario.id);
      assert.equal(data.policy_applied?.eventType, expected.eventType, `${scenario.id} evento`);
      assert.equal(data.blocked, expected.blocked, `${scenario.id} bloqueo`);
      assert.equal(data.help_stage, expected.helpStage, `${scenario.id} etapa`);
      assert.equal(data.policy_applied?.reasonCode, expected.reasonCode, `${scenario.id} motivo`);
      assert.ok(data.decision_id, `${scenario.id} decision_id`);
      decisions.set(String(data.decision_id), scenario.id);
      // A12.8: los enlaces al visor de fuentes no llevan la sesion en la URL.
      const links = JSON.stringify(data.rag_sources || []);
      assert.ok(!links.includes("sessionId"), `${scenario.id}: enlace con sessionId`);
      assert.ok(!links.includes(sessionId), `${scenario.id}: enlace con la sesion`);

      const text = JSON.stringify(data.result);
      if (expected.blocked) {
        // No inventa: mensaje del docente y ninguna llamada al modelo.
        assert.equal(modelState.prompts.length, promptsBefore, `${scenario.id} no llama al modelo`);
        assert.ok(data.result.welcome_message.startsWith(FALLBACK_START), scenario.id);
        assert.doesNotMatch(text, /paso_1\(\);/);
      } else {
        assert.equal(modelState.prompts.length, promptsBefore + 1, `${scenario.id} llama al modelo una vez`);
        assert.equal(data.source, "ai");
        const prompt = modelState.prompts[modelState.prompts.length - 1];
        assert.match(prompt, /Nunca entregues la solucion completa/);
        if (expected.helpStage === "hint_1") {
          assert.match(prompt, /PISTA NIVEL 1\. No escribas codigo/);
          assert.doesNotMatch(text, /paso_1\(\);/, `${scenario.id}: la pista 1 no trae codigo`);
          assert.match(text, /codigo omitido/);
        }
        if (expected.helpStage === "explanation") {
          assert.match(text, /paso_4\(\);/);
          assert.doesNotMatch(text, /paso_5\(\);/, "la explicacion trae maximo 4 lineas");
        }
      }
    }

    // Traza de decisiones: una por escenario, con su motivo.
    const rows = await database.listTelemetryEvents();
    const decisionRows = rows.filter((row) => row.eventType === "tutor_decision" && row.channel === "overlay");
    assert.equal(decisionRows.length, TUTOR_SCENARIOS.length);
    for (const row of decisionRows) {
      const scenario = TUTOR_SCENARIOS.find((item) => item.id === decisions.get(row.decisionId));
      assert.ok(scenario, `decision ${row.decisionId} sin escenario`);
      assert.equal(row.reasonCode, scenario.overlay.expected.reasonCode);
      assert.equal(row.helpStage, scenario.overlay.expected.helpStage);
      assert.equal(row.actorKind, "user");
      assert.equal(row.actorRole, "student");
    }

    // A10.5: ni la telemetria nueva ni el resumen de contexto guardan datos sensibles.
    const legacy = await database.pool.query<{ context_summary: string; reason: string }>(
      "select context_summary, reason from intervention_telemetry",
    );
    const stored = JSON.stringify(rows) + JSON.stringify(legacy.rows);
    for (const secret of [
      "user-student-demo",
      "estudiante@adaceen.edu.co",
      "src/cuenta.cpp",
      "saldo += monto",
      "division by zero",
      "expected ';'",
      "curso-fpoo/taller-1-demo",
      "capital de Francia",
    ]) {
      assert.ok(!stored.includes(secret), `la traza no debe incluir: ${secret}`);
    }
    assert.ok(rows.some((row) => row.errorHash && row.fileExt === ".cpp"));
  } finally {
    setTextModelOverrideForTests(null);
    await stopTestServer(server, database);
  }
});

test("overlay (A2.2): pista 1, pista 2, ejemplo parcial y bloqueo al llegar al maximo de pistas", async () => {
  const { server, database, baseUrl } = await startTestServer();
  installReferenceModel();
  try {
    const sessionId = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");
    const s1 = TUTOR_SCENARIOS[0].overlay;
    const context = { ...s1.context, activityTitle: "Taller 9 - Progresion de pistas" };
    const ask = () => postJson<InterveneResponse>(baseUrl, "/intervene", { question: s1.question, context, max_items: 5 }, { "x-session-id": sessionId });

    const first = await ask();
    const second = await ask();
    const third = await ask();
    const fourth = await ask();

    assert.deepEqual(
      [first, second, third, fourth].map((item) => item.data.help_stage),
      ["hint_1", "hint_2", "partial_example", "controlled"],
    );
    const text = (item: { data: InterveneResponse }) => JSON.stringify(item.data.result);
    assert.doesNotMatch(text(first), /paso_1\(\);/);
    assert.match(text(second), /paso_2\(\);/);
    assert.doesNotMatch(text(second), /paso_3\(\);/);
    assert.match(text(third), /paso_8\(\);/);
    assert.doesNotMatch(text(third), /paso_9\(\);/);
    assert.equal(fourth.data.blocked, true);
    assert.equal(fourth.data.policy_applied?.reasonCode, "hint_limit_reached");
    assert.match(text(fourth), /limite de pistas/);
    assert.equal(modelState.prompts.length, 3, "el bloqueo no llama al modelo");
  } finally {
    setTextModelOverrideForTests(null);
    await stopTestServer(server, database);
  }
});

const VSCODE_CLIENT = { "x-adaceen-client-id": "vscode-prueba-0001" };

test("escenarios del editor (/suggest-tab) con cliente anonimo: etapa, limite y guardarrail", async () => {
  const { server, database, baseUrl } = await startTestServer();
  installReferenceModel();
  try {
    const decisionIds: string[] = [];
    for (const scenario of TUTOR_SCENARIOS) {
      if (!scenario.editor) continue;
      const promptsBefore = modelState.prompts.length;
      const expected = scenario.editor.expected;
      const { status, data } = await postJson<SuggestResponse>(baseUrl, "/suggest-tab", scenario.editor.body, VSCODE_CLIENT);
      assert.equal(status, 200, scenario.id);
      assert.equal(data.policy_applied?.eventType, expected.eventType, `${scenario.id} evento`);
      assert.equal(data.policy_applied?.helpStage, expected.helpStage, `${scenario.id} etapa`);
      assert.equal(data.blocked, expected.blocked, `${scenario.id} bloqueo`);
      assert.match(String(data.decision_id), /^[0-9a-f-]{36}$/);
      decisionIds.push(String(data.decision_id));
      assert.doesNotMatch(data.output_text, /aplicar\s*:/i, `${scenario.id}: sin Aplicar`);

      if (expected.blocked) {
        assert.equal(modelState.prompts.length, promptsBefore, "fuera de dominio no llama al modelo");
        assert.ok(data.output_text.includes(FALLBACK_START));
        assert.equal(data.code_application?.allowed, false);
        continue;
      }
      assert.equal(modelState.prompts.length, promptsBefore + 1);
      const maxLines = expected.helpStage === "explanation" ? 4 : 5;
      assert.equal(data.code_application?.maxLines, maxLines, `${scenario.id} tope de lineas`);
      // La salida de referencia trae 14 lineas: se recorta y ya no se puede aplicar.
      assert.match(data.output_text, new RegExp(`paso_${maxLines}\\(\\);`));
      assert.doesNotMatch(data.output_text, new RegExp(`paso_${maxLines + 1}\\(\\);`));
      assert.match(data.output_text, /recortado por la politica del docente/);
      assert.equal(data.code_application?.allowed, false);
      assert.match(String(data.code_application?.reason), /se recorto/);
    }

    const s1Prompt = modelState.prompts[0];
    assert.match(s1Prompt, /PISTA NIVEL 1 \(editor\)/);
    assert.match(s1Prompt, /Error visible en el editor: cuenta\.cpp:6:48/);
    assert.match(s1Prompt, /No entregues la solucion completa/);

    const rows = await database.listTelemetryEvents();
    const decisionRows = rows.filter((row) => row.eventType === "tutor_decision" && row.channel === "vscode");
    assert.deepEqual(decisionRows.map((row) => row.decisionId).sort(), [...decisionIds].sort());
    assert.ok(decisionRows.every((row) => row.actorKind === "client" && row.actorAnonId.length === 20));
    assert.ok(!JSON.stringify(rows).includes("vscode-prueba-0001"));
    assert.ok(!JSON.stringify(rows).includes("saldo += monto"));

    const missing = await postJson<{ ok: boolean }>(baseUrl, "/suggest-tab", { tab_content: "" }, VSCODE_CLIENT);
    assert.equal(missing.status, 400);
  } finally {
    setTextModelOverrideForTests(null);
    await stopTestServer(server, database);
  }
});

test("aplicacion de codigo (A10.8): apply-check descuenta el cupo y sube la etapa del editor", async () => {
  const { server, database, baseUrl } = await startTestServer();
  installReferenceModel();
  modelState.mode = "small";
  try {
    const filePath = "src/cuenta-aplicar.cpp";
    const body = { ...TUTOR_SCENARIOS[0].editor!.body, filePath, tab_content: `${SCENARIO_CPP_CODE}\n// aplicar` };
    const suggest = () => postJson<SuggestResponse>(baseUrl, "/suggest-tab", body, VSCODE_CLIENT);
    const check = (linesChanged: number, decisionId?: string) =>
      postJson<{ ok: boolean; allowed: boolean; reasonCode: string; remaining: number | null; maxLines: number; decisionId: string | null }>(
        baseUrl,
        "/api/suggestions/apply-check",
        { decisionId, filePath, language: "cpp", applyMode: "replace", linesChanged, charsChanged: linesChanged * 30, trigger: "manual" },
        VSCODE_CLIENT,
      );

    const first = await suggest();
    assert.equal(first.data.policy_applied?.helpStage, "hint_1");
    assert.equal(first.data.code_application?.allowed, true);
    assert.equal(first.data.code_application?.maxLines, 5);
    assert.equal(first.data.code_application?.remaining, 3);
    assert.match(first.data.output_text, /Aplicar: replace/, "el cambio corto se puede aplicar");

    const applied = await check(2, first.data.decision_id || undefined);
    assert.equal(applied.status, 200);
    assert.equal(applied.data.allowed, true);
    assert.equal(applied.data.remaining, 2);
    assert.equal(applied.data.decisionId, first.data.decision_id);

    const second = await suggest();
    assert.equal(second.data.policy_applied?.helpStage, "hint_2");
    assert.equal(second.data.code_application?.maxLines, 10);
    assert.equal(second.data.code_application?.remaining, 2);

    const tooLarge = await check(25);
    assert.equal(tooLarge.data.allowed, false);
    assert.equal(tooLarge.data.reasonCode, "code_application_too_large");
    assert.equal(tooLarge.data.remaining, 2, "un cambio rechazado no gasta cupo");

    assert.equal((await check(3)).data.remaining, 1);
    assert.equal((await check(3)).data.remaining, 0);
    const exhausted = await check(1);
    assert.equal(exhausted.data.allowed, false);
    assert.equal(exhausted.data.reasonCode, "code_application_limit_reached");

    const afterLimit = await suggest();
    assert.equal(afterLimit.data.blocked, false, "la sugerencia sigue como guia");
    assert.equal(afterLimit.data.code_application?.allowed, false);
    assert.doesNotMatch(afterLimit.data.output_text, /aplicar\s*:/i);

    // Otro archivo tiene su propio cupo; sin identidad no hay verificacion.
    const otherFile = await postJson<{ allowed: boolean; remaining: number | null }>(
      baseUrl,
      "/api/suggestions/apply-check",
      { filePath: "src/otro.cpp", applyMode: "insert", linesChanged: 1 },
      VSCODE_CLIENT,
    );
    assert.equal(otherFile.data.allowed, true);
    assert.equal(otherFile.data.remaining, 2);
    const anonymous = await postJson<{ ok: boolean }>(baseUrl, "/api/suggestions/apply-check", { filePath, applyMode: "insert", linesChanged: 1 }, {});
    assert.equal(anonymous.status, 401);
    const invalid = await postJson<{ ok: boolean }>(baseUrl, "/api/suggestions/apply-check", { filePath, applyMode: "pegar", linesChanged: 1 }, VSCODE_CLIENT);
    assert.equal(invalid.status, 400);

    const checks = (await database.listTelemetryEvents()).filter((row) => row.eventType === "code_application_checked");
    assert.equal(checks.length, 6, "401 y 400 no dejan evento");
    assert.equal(checks.filter((row) => row.blocked === false).length, 4);
    assert.ok(checks.every((row) => row.fileExt === ".cpp" && !JSON.stringify(row).includes("cuenta-aplicar")));
  } finally {
    setTextModelOverrideForTests(null);
    await stopTestServer(server, database);
  }
});

test("degradacion (A12.10): sin modelo el tutor responde controlado y la salud avisa si no hay GPU", async () => {
  const { server, database, baseUrl } = await startTestServer();
  const originalMode = env.targetMode;
  const originalToken = env.workerHeartbeatToken;
  installReferenceModel();
  modelState.mode = "fail";
  try {
    const sessionId = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");
    const s1 = TUTOR_SCENARIOS[0];

    const overlay = await postJson<InterveneResponse>(
      baseUrl,
      "/intervene",
      { question: s1.overlay.question, context: { ...s1.overlay.context, activityTitle: "Taller 10 - Sin modelo" }, max_items: 5 },
      { "x-session-id": sessionId },
    );
    assert.equal(overlay.status, 200);
    assert.equal(overlay.data.source, "heuristic");
    assert.equal(overlay.data.blocked, false);
    assert.equal(overlay.data.policy_applied?.reasonCode, "model_error_fallback");

    const editorBody = { ...s1.editor!.body, tab_content: `${SCENARIO_CPP_CODE}\n// sin modelo` };
    const editor = await postJson<SuggestResponse>(baseUrl, "/suggest-tab", editorBody, VSCODE_CLIENT);
    assert.equal(editor.status, 200);
    assert.equal(editor.data.degraded, true);
    assert.match(editor.data.output_text, /no esta disponible/);
    assert.doesNotMatch(editor.data.output_text, /aplicar\s*:|```/i);

    const reasons = (await database.listTelemetryEvents())
      .filter((row) => row.eventType === "tutor_decision")
      .map((row) => row.reasonCode);
    assert.deepEqual(reasons.sort(), ["model_error_fallback", "model_error_fallback"]);

    // Modo cola con latidos: sin worker vivo, la salud responde 503 y el tutor no espera la cola.
    setTextModelOverrideForTests(null);
    resetWorkerHeartbeatsForTests();
    env.targetMode = "queue";
    env.workerHeartbeatToken = "token-latido-de-prueba-123";
    recordWorkerHeartbeat({ workerId: "gpu-l4-prueba", model: "qwen2.5-coder:7b" }, Date.now() - 10 * 60 * 1000);

    const down = await fetch(`${baseUrl}/api/agent/health`);
    assert.equal(down.status, 503);
    assert.equal((await down.json() as { reason: string }).reason, "sin_worker");

    const startedAt = Date.now();
    const fastFail = await postJson<SuggestResponse>(
      baseUrl,
      "/suggest-tab",
      { ...editorBody, tab_content: `${SCENARIO_CPP_CODE}\n// cola caida`, suggestion_scope: "cursor" },
      VSCODE_CLIENT,
    );
    assert.equal(fastFail.status, 200);
    assert.equal(fastFail.data.degraded, true);
    assert.ok(Date.now() - startedAt < 5000, "no espera el timeout de la cola");

    const wrongToken = await fetch(`${baseUrl}/api/agent/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-worker-token": "otro-token" },
      body: JSON.stringify({ workerId: "gpu-l4-prueba" }),
    });
    assert.equal(wrongToken.status, 401);
    const beat = await fetch(`${baseUrl}/api/agent/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-worker-token": env.workerHeartbeatToken },
      body: JSON.stringify({ workerId: "gpu-l4-prueba", model: "qwen2.5-coder:7b", jobsProcessed: 12 }),
    });
    assert.equal(beat.status, 204);

    const up = await fetch(`${baseUrl}/api/agent/health`);
    assert.equal(up.status, 200);
    assert.equal((await up.json() as { alive_workers: number }).alive_workers, 1);
    const backend = await (await fetch(`${baseUrl}/api/agent/backend`)).json() as { listening: Array<{ alive: boolean; jobsProcessed: number }>; alive_workers: number };
    assert.equal(backend.alive_workers, 1);
    assert.equal(backend.listening[0].jobsProcessed, 12);

    env.workerHeartbeatToken = "";
    const notConfigured = await fetch(`${baseUrl}/api/agent/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-worker-token": "x" },
      body: JSON.stringify({ workerId: "gpu-l4-prueba" }),
    });
    assert.equal(notConfigured.status, 503);
  } finally {
    env.targetMode = originalMode;
    env.workerHeartbeatToken = originalToken;
    resetWorkerHeartbeatsForTests();
    setTextModelOverrideForTests(null);
    await stopTestServer(server, database);
  }
});

test("overlay: casos limite de deteccion (\"diagrama\" no es flujo de trabajo; error visible cuenta como dominio)", async () => {
  const { server, database, baseUrl } = await startTestServer();
  installReferenceModel();
  try {
    const sessionId = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");
    const ask = (question: string, context: Record<string, unknown>) =>
      postJson<InterveneResponse>(baseUrl, "/intervene", { question, context, max_items: 5 }, { "x-session-id": sessionId });

    const diagram = await ask("Como paso el enunciado del taller a un diagrama?", {
      pageType: "campus",
      activityTitle: "Taller 5 - Diagramas",
      selection: "Un banco tiene clientes y cada cliente tiene cuentas.",
    });
    assert.equal(diagram.data.policy_applied?.eventType, "design_block");

    const branch = await ask("Como creo una rama para el taller?", { pageType: "github_code", filePath: "README.md", codeSnippet: "# Taller" });
    assert.equal(branch.data.policy_applied?.eventType, "workflow_guidance");

    // Sin palabras del curso en la pregunta, pero con un error en pantalla: es del curso.
    const onlyError = await ask("Y esto por que pasa?", {
      pageType: "codespace",
      filePath: "main.py",
      visibleError: "Traceback (most recent call last):\nIndexError: list index out of range",
      codeSnippet: "notas = []\nprint(notas[0])",
    });
    assert.equal(onlyError.data.policy_applied?.eventType, "runtime_error");
    assert.equal(onlyError.data.blocked, false);
  } finally {
    setTextModelOverrideForTests(null);
    await stopTestServer(server, database);
  }
});
