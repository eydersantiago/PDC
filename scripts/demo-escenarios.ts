import "dotenv/config";
import { seedTeacherPolicy } from "../src/db/seeds.js";
import { setTextModelOverrideForTests } from "../src/services/agent-mode.js";
import {
  referenceModelOutput,
  referenceSmallFixOutput,
  SCENARIO_CPP_CODE,
  TUTOR_SCENARIOS,
  type ScenarioExpectation,
} from "../src/services/tutor-scenarios.js";
import { describeLatencies, hasFlag, login, readArg, startInProcessBackend, writeTextFile } from "./lib/cli.js";

/**
 * Demo reproducible y prueba de humo de los escenarios S1-S5 (A11.4) que
 * deja la evidencia en Markdown (A10.7).
 *
 * Uso:
 *   npm run demo:escenarios                         # backend en memoria + modelo de referencia (sin GPU)
 *   npm run demo:escenarios -- --modelo-real        # backend en memoria + el modelo de AGENT_TARGET
 *   npm run demo:escenarios -- --url=https://<app>.azurewebsites.net --email=<estudiante> --password=<clave>
 *   ... --salida=docs/evidencias/demo-escenarios.md # guarda la evidencia
 *   ... --json                                      # imprime el resultado en JSON
 *
 * Con --url los eventos quedan en la base del piloto: el script imprime la
 * ventana de tiempo para excluirla del analisis (o correrlo antes del piloto).
 * Sale con codigo 1 si alguna comprobacion falla.
 */

type Check = { name: string; ok: boolean; detail?: string };

type ScenarioRun = {
  id: string;
  titulo: string;
  canal: "overlay" | "editor";
  status: number;
  eventType: string;
  helpStage: string;
  blocked: boolean | null;
  reasonCode: string;
  latencyMs: number;
  checks: Check[];
  excerpt: string;
};

type OverlayResponse = {
  source?: string;
  blocked?: boolean;
  help_stage?: string;
  decision_id?: string | null;
  policy_applied?: { eventType?: string; reasonCode?: string } | null;
  result?: { ideas?: string[]; guide?: string[]; welcome_message?: string };
};

type EditorResponse = {
  output_text?: string;
  blocked?: boolean;
  degraded?: boolean;
  decision_id?: string | null;
  policy_applied?: { eventType?: string; helpStage?: string; reasonCode?: string } | null;
  code_application?: { allowed?: boolean; maxLines?: number; remaining?: number | null } | null;
};

function codeLinesPerBlock(text: string) {
  const blocks = [...String(text || "").matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
  return blocks.map((match) => match[1].replace(/\n$/, "").split("\n").filter((line) => !/recortado por la politica/.test(line)).length);
}

function expectationChecks(expected: ScenarioExpectation, actual: { eventType: string; helpStage: string; blocked: boolean | null; reasonCode: string }) {
  return [
    { name: "evento", ok: actual.eventType === expected.eventType, detail: `${actual.eventType} (esperado ${expected.eventType})` },
    { name: "etapa", ok: actual.helpStage === expected.helpStage, detail: `${actual.helpStage} (esperado ${expected.helpStage})` },
    { name: "bloqueo", ok: actual.blocked === expected.blocked, detail: `${actual.blocked} (esperado ${expected.blocked})` },
    { name: "motivo", ok: actual.reasonCode === expected.reasonCode, detail: `${actual.reasonCode} (esperado ${expected.reasonCode})` },
  ];
}

async function postJson<T>(baseUrl: string, route: string, body: unknown, headers: Record<string, string>) {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({})) as T;
  return { status: response.status, data, latencyMs: Date.now() - startedAt };
}

function excerpt(text: string, maxLines = 14) {
  const lines = String(text || "").split("\n");
  return lines.slice(0, maxLines).join("\n") + (lines.length > maxLines ? "\n..." : "");
}

async function runOverlay(baseUrl: string, sessionId: string) {
  const runs: ScenarioRun[] = [];
  for (const scenario of TUTOR_SCENARIOS) {
    const { status, data, latencyMs } = await postJson<OverlayResponse>(
      baseUrl,
      "/intervene",
      { question: scenario.overlay.question, context: scenario.overlay.context, max_items: 5 },
      { "x-session-id": sessionId },
    );
    const actual = {
      eventType: String(data.policy_applied?.eventType || ""),
      helpStage: String(data.help_stage || ""),
      blocked: typeof data.blocked === "boolean" ? data.blocked : null,
      reasonCode: String(data.policy_applied?.reasonCode || ""),
    };
    const resultText = [data.result?.welcome_message, ...(data.result?.ideas || []), ...(data.result?.guide || [])].join("\n");
    const checks: Check[] = [
      { name: "HTTP 200", ok: status === 200, detail: String(status) },
      ...expectationChecks(scenario.overlay.expected, actual),
      { name: "decision enlazable", ok: Boolean(data.decision_id), detail: String(data.decision_id || "sin decision_id") },
    ];
    const maxLines = actual.helpStage === "hint_1" || actual.helpStage === "controlled" ? 0 : actual.helpStage === "hint_2" ? 2 : actual.helpStage === "explanation" ? 4 : 8;
    const longest = Math.max(0, ...codeLinesPerBlock(resultText));
    checks.push({ name: `codigo <= ${maxLines} lineas`, ok: longest <= maxLines, detail: `${longest} lineas` });
    if (scenario.overlay.expected.blocked) {
      checks.push({
        name: "mensaje controlado del docente, sin codigo",
        ok: Boolean(String(data.result?.welcome_message || "").trim()) && !/```/.test(resultText),
        detail: String(data.result?.welcome_message || "").slice(0, 80),
      });
    }
    runs.push({
      id: scenario.id,
      titulo: scenario.titulo,
      canal: "overlay",
      status,
      ...actual,
      latencyMs,
      checks,
      excerpt: excerpt([data.result?.welcome_message, ...(data.result?.ideas || []).slice(0, 2)].filter(Boolean).join("\n- ")),
    });
  }
  return runs;
}

async function runEditor(baseUrl: string, clientId: string) {
  const runs: ScenarioRun[] = [];
  for (const scenario of TUTOR_SCENARIOS) {
    if (!scenario.editor) continue;
    const { status, data, latencyMs } = await postJson<EditorResponse>(baseUrl, "/suggest-tab", scenario.editor.body, { "x-adaceen-client-id": clientId });
    const actual = {
      eventType: String(data.policy_applied?.eventType || ""),
      helpStage: String(data.policy_applied?.helpStage || ""),
      blocked: typeof data.blocked === "boolean" ? data.blocked : null,
      reasonCode: String(data.policy_applied?.reasonCode || ""),
    };
    const output = String(data.output_text || "");
    const maxLines = Number(data.code_application?.maxLines ?? 0);
    const longest = Math.max(0, ...codeLinesPerBlock(output));
    const hasApply = /aplicar\s*:/i.test(output);
    const checks: Check[] = [
      { name: "HTTP 200", ok: status === 200, detail: String(status) },
      ...expectationChecks(scenario.editor.expected, actual),
      { name: `codigo <= ${maxLines} lineas`, ok: longest <= maxLines, detail: `${longest} lineas` },
      {
        name: "Aplicar solo si se puede aplicar",
        ok: !hasApply || data.code_application?.allowed === true,
        detail: hasApply ? `Aplicar presente, allowed=${data.code_application?.allowed}` : "sin linea Aplicar",
      },
      { name: "decision enlazable", ok: Boolean(data.decision_id), detail: String(data.decision_id || "sin decision_id") },
    ];
    runs.push({ id: scenario.id, titulo: scenario.titulo, canal: "editor", status, ...actual, latencyMs, checks, excerpt: excerpt(output) });
  }
  return runs;
}

async function runProgression(baseUrl: string, sessionId: string) {
  const s1 = TUTOR_SCENARIOS[0].overlay;
  const context = { ...s1.context, activityTitle: `Demo progresion ${Date.now().toString(36)}` };
  const stages: string[] = [];
  let lastReason = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { data } = await postJson<OverlayResponse>(baseUrl, "/intervene", { question: s1.question, context, max_items: 5 }, { "x-session-id": sessionId });
    stages.push(String(data.help_stage || ""));
    lastReason = String(data.policy_applied?.reasonCode || "");
  }
  const expected = ["hint_1", "hint_2", "partial_example", "controlled"];
  return {
    stages,
    lastReason,
    checks: [
      { name: "pista 1 -> pista 2 -> ejemplo parcial -> bloqueo", ok: stages.join(",") === expected.join(","), detail: stages.join(" -> ") },
      { name: "motivo del bloqueo", ok: lastReason === "hint_limit_reached", detail: lastReason },
    ] as Check[],
  };
}

async function runApplyFlow(baseUrl: string, clientId: string, smallFix: () => void) {
  smallFix();
  const filePath = `src/demo-aplicar-${Date.now().toString(36)}.cpp`;
  const body = { ...TUTOR_SCENARIOS[0].editor!.body, filePath, tab_content: `${SCENARIO_CPP_CODE}\n// ${filePath}` };
  const headers = { "x-adaceen-client-id": clientId };
  const steps: string[] = [];
  const first = await postJson<EditorResponse>(baseUrl, "/suggest-tab", body, headers);
  steps.push(`sugerencia 1: etapa ${first.data.policy_applied?.helpStage}, maximo ${first.data.code_application?.maxLines} lineas, cupo ${first.data.code_application?.remaining}`);
  const results: Array<{ allowed?: boolean; reasonCode?: string; remaining?: number | null }> = [];
  for (const lines of [2, 25, 3, 3, 1]) {
    const { data } = await postJson<{ allowed?: boolean; reasonCode?: string; remaining?: number | null }>(
      baseUrl,
      "/api/suggestions/apply-check",
      { decisionId: first.data.decision_id || undefined, filePath, language: "cpp", applyMode: "replace", linesChanged: lines, trigger: "demo" },
      headers,
    );
    results.push(data);
    steps.push(`aplicar ${lines} lineas: ${data.allowed ? "permitido" : "bloqueado"} (${data.reasonCode}), cupo ${data.remaining}`);
  }
  const second = await postJson<EditorResponse>(baseUrl, "/suggest-tab", { ...body, tab_content: `${body.tab_content}\n// segunda` }, headers);
  steps.push(`sugerencia 2: etapa ${second.data.policy_applied?.helpStage}, aplicar permitido=${second.data.code_application?.allowed}`);
  return {
    steps,
    checks: [
      { name: "el primer cambio corto se aplica", ok: results[0]?.allowed === true },
      { name: "un cambio de 25 lineas se bloquea", ok: results[1]?.reasonCode === "code_application_too_large" },
      { name: "el cupo se agota en 3 aplicaciones", ok: results[4]?.reasonCode === "code_application_limit_reached" },
      { name: "sin cupo la sugerencia no ofrece Aplicar", ok: second.data.code_application?.allowed === false && !/aplicar\s*:/i.test(String(second.data.output_text || "")) },
    ] as Check[],
  };
}

function renderMarkdown(input: {
  startedAt: Date;
  finishedAt: Date;
  target: string;
  model: string;
  runs: ScenarioRun[];
  progression: Awaited<ReturnType<typeof runProgression>> | null;
  applyFlow: Awaited<ReturnType<typeof runApplyFlow>> | null;
  degraded: Check[] | null;
}) {
  const allChecks = [
    ...input.runs.flatMap((run) => run.checks),
    ...(input.progression?.checks || []),
    ...(input.applyFlow?.checks || []),
    ...(input.degraded || []),
  ];
  const failed = allChecks.filter((check) => !check.ok).length;
  const mark = (ok: boolean) => (ok ? "OK" : "FALLA");
  const latencies = describeLatencies(input.runs.map((run) => run.latencyMs));
  const lines = [
    "# Evidencia: escenarios S1-S5 del tutor",
    "",
    `- Fecha: ${input.startedAt.toISOString()} a ${input.finishedAt.toISOString()}`,
    `- Backend: ${input.target}`,
    `- Modelo: ${input.model}`,
    `- Politica: "${seedTeacherPolicy.policyName}" (sin solucion completa: ${seedTeacherPolicy.strictNoSolution ? "si" : "no"}, maximo de pistas por ejercicio: ${seedTeacherPolicy.maxHintsPerExercise}, aplicar codigo: hasta ${seedTeacherPolicy.codeApplication.maxLines} lineas con confirmacion)`,
    `- Resultado: ${allChecks.length - failed} de ${allChecks.length} comprobaciones correctas${failed ? ` (${failed} fallan)` : ""}`,
    `- Latencia de la demo (no es la medicion A12.2): p50 ${latencies.p50} ms, p95 ${latencies.p95} ms, n=${latencies.n}`,
    "",
    "Definicion de los escenarios: docs/tutor/escenarios.md. Generado con `npm run demo:escenarios`.",
    "",
    "## Resumen",
    "",
    "| Escenario | Canal | Evento | Etapa | Bloqueado | Motivo | Latencia (ms) | Comprobaciones |",
    "|---|---|---|---|---|---|---|---|",
    ...input.runs.map((run) => {
      const ok = run.checks.filter((check) => check.ok).length;
      return `| ${run.id} ${run.titulo} | ${run.canal} | ${run.eventType || "-"} | ${run.helpStage || "-"} | ${run.blocked === null ? "-" : run.blocked ? "si" : "no"} | ${run.reasonCode || "-"} | ${run.latencyMs} | ${ok}/${run.checks.length} ${mark(ok === run.checks.length)} |`;
    }),
    "",
  ];

  if (input.progression) {
    lines.push("## Ayuda gradual en el overlay (A2.2)", "", `Cuatro pedidos seguidos sobre el mismo ejercicio: ${input.progression.stages.join(" -> ")}.`, "");
    for (const check of input.progression.checks) lines.push(`- ${mark(check.ok)} ${check.name}${check.detail ? `: ${check.detail}` : ""}`);
    lines.push("");
  }
  if (input.applyFlow) {
    lines.push("## Aplicacion de codigo en VS Code (A10.8)", "");
    for (const step of input.applyFlow.steps) lines.push(`- ${step}`);
    lines.push("");
    for (const check of input.applyFlow.checks) lines.push(`- ${mark(check.ok)} ${check.name}`);
    lines.push("");
  }
  if (input.degraded) {
    lines.push("## Degradacion sin modelo (A12.10)", "");
    for (const check of input.degraded) lines.push(`- ${mark(check.ok)} ${check.name}${check.detail ? `: ${check.detail}` : ""}`);
    lines.push("");
  }

  lines.push("## Detalle por escenario", "");
  for (const run of input.runs) {
    lines.push(`### ${run.id} (${run.canal}): ${run.titulo}`, "");
    for (const check of run.checks) lines.push(`- ${mark(check.ok)} ${check.name}${check.detail ? `: ${check.detail}` : ""}`);
    lines.push("", "Respuesta (extracto):", "", "````text", run.excerpt || "(vacia)", "````", "");
  }
  return { markdown: `${lines.join("\n").trimEnd()}\n`, failed, total: allChecks.length };
}

async function main() {
  const targetUrl = readArg("url").replace(/\/+$/, "");
  const useRealModel = Boolean(targetUrl) || hasFlag("modelo-real");
  const startedAt = new Date();
  const backend = targetUrl
    ? { baseUrl: targetUrl, close: async () => {} }
    : await startInProcessBackend();

  let mode: "reference" | "small" | "fail" = "reference";
  if (!useRealModel) {
    setTextModelOverrideForTests(async (input) => {
      if (mode === "fail") throw new Error("modelo apagado (demo)");
      if (mode === "small" && !/Devuelve SOLO JSON valido/.test(input)) return referenceSmallFixOutput();
      return referenceModelOutput(input);
    });
  }

  try {
    const email = readArg("email", targetUrl ? "" : "estudiante@adaceen.edu.co");
    const password = readArg("password", targetUrl ? "" : "Estudiante123!");
    const clientId = readArg("client-id", `demo-escenarios-${Date.now().toString(36)}`);

    let runs: ScenarioRun[] = [];
    let progression: Awaited<ReturnType<typeof runProgression>> | null = null;
    if (email && password) {
      const sessionId = await login(backend.baseUrl, email, password);
      runs = runs.concat(await runOverlay(backend.baseUrl, sessionId));
      progression = await runProgression(backend.baseUrl, sessionId);
    } else {
      console.warn("[demo] Sin --email/--password: se omiten los escenarios del overlay (necesitan sesion de estudiante).");
    }
    runs = runs.concat(await runEditor(backend.baseUrl, clientId));
    const applyFlow = useRealModel ? null : await runApplyFlow(backend.baseUrl, clientId, () => { mode = "small"; });

    let degraded: Check[] | null = null;
    if (!useRealModel) {
      mode = "fail";
      const { data } = await postJson<EditorResponse>(
        backend.baseUrl,
        "/suggest-tab",
        { ...TUTOR_SCENARIOS[0].editor!.body, tab_content: `${SCENARIO_CPP_CODE}\n// sin modelo ${Date.now()}` },
        { "x-adaceen-client-id": clientId },
      );
      degraded = [
        { name: "responde sin error 500", ok: data.degraded === true, detail: `degraded=${data.degraded}` },
        { name: "no inventa ni trae codigo", ok: !/```|aplicar\s*:/i.test(String(data.output_text || "")) },
      ];
    }

    const finishedAt = new Date();
    const rendered = renderMarkdown({
      startedAt,
      finishedAt,
      target: targetUrl || "en memoria (usuarios y politica demo)",
      model: useRealModel ? (targetUrl ? "el del backend (AGENT_TARGET del servidor)" : `AGENT_TARGET=${process.env.AGENT_TARGET || "local"}`) : "salida de referencia (src/services/tutor-scenarios.ts)",
      runs,
      progression,
      applyFlow,
      degraded,
    });

    const output = readArg("salida");
    if (output) {
      const written = await writeTextFile(output, rendered.markdown);
      console.log(`[demo] Evidencia guardada en ${written}`);
    }
    if (hasFlag("json")) {
      console.log(JSON.stringify({ startedAt, finishedAt, runs, progression, applyFlow, degraded, failed: rendered.failed }, null, 2));
    } else {
      console.log(rendered.markdown);
    }
    if (targetUrl) {
      console.log(`[demo] Eventos de la demo entre ${startedAt.toISOString()} y ${finishedAt.toISOString()}: excluye esa ventana del analisis.`);
    }
    if (rendered.failed > 0) process.exitCode = 1;
  } finally {
    setTextModelOverrideForTests(null);
    await backend.close();
  }
}

main().catch((error) => {
  console.error("[demo] Fallo:", error);
  process.exitCode = 1;
});
