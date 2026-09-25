import assert from "node:assert/strict";
import test from "node:test";
import { cleanPilotDataset, renderCleaningReport } from "../../src/services/pilot-dataset.js";
import { escapeXml, likertSvg, pairedDotsSvg } from "../../src/services/svg-charts.js";
import type { TelemetryEventRow } from "../../src/services/telemetry.js";

/** A14.3: reglas de exclusion D1-D5 y marcas M1-M3 del dataset del piloto. */

let counter = 0;
function row(partial: Partial<TelemetryEventRow>): TelemetryEventRow {
  counter += 1;
  return {
    id: `e-${counter}`,
    schemaVersion: "1.1",
    occurredAt: new Date(Date.UTC(2026, 9, 6, 19, 0, counter)).toISOString(),
    receivedAt: new Date(Date.UTC(2026, 9, 6, 19, 0, counter)).toISOString(),
    source: "vscode_extension",
    channel: "vscode",
    category: "signal",
    eventType: "compile_error_detected",
    actorAnonId: "est-1",
    actorKind: "user",
    actorRole: "student",
    teacherAnonId: "doc-1",
    clientSessionId: "vs-1",
    seq: counter,
    decisionId: "",
    courseCode: "",
    exerciseHash: "ej",
    language: "cpp",
    fileExt: ".cpp",
    policyEventType: "",
    interventionType: "",
    helpStage: "",
    reasonCode: "",
    blocked: null,
    latencyMs: null,
    durationMs: null,
    countValue: null,
    valueText: "",
    errorHash: "",
    contextHash: "",
    metadata: {},
    qualityFlags: [],
    pilotBlock: 1,
    pilotCohort: "A",
    pilotCondition: "con_tutor",
    ...partial,
  };
}

test("dataset del piloto: exclusiones en orden y marcas sin borrar nada", () => {
  const duplicated = row({ seq: 500 });
  const rows = [
    row({}),
    row({ actorRole: "teacher", pilotCondition: "", pilotBlock: null, pilotCohort: "" }),
    row({ actorKind: "client", actorRole: "", clientSessionId: "vs-anonimo", pilotCondition: "" }),
    row({ actorAnonId: "prueba" }),
    row({ pilotCondition: "", pilotBlock: null }),
    duplicated,
    { ...duplicated, id: "copia" },
    row({ qualityFlags: [{ code: "Q5_fecha_futura", severity: "aviso" }] }),
    row({ eventType: "vscode_suggestion_shown", decisionId: "sin-decision" }),
    row({ source: "browser_extension", eventType: "tutor_response_accepted", decisionId: "d-1", clientSessionId: "ov-1", seq: 1 }),
    row({ source: "backend", eventType: "tutor_decision", decisionId: "d-1", clientSessionId: "", seq: null }),
  ];
  const result = cleanPilotDataset({ rows, testActors: ["prueba"] });
  assert.deepEqual(result.report.excludedByRule, {
    D1_no_estudiante: 1,
    D2_cliente_anonimo: 1,
    D3_cuenta_de_prueba: 1,
    D4_sin_condicion: 1,
    D5_duplicado: 1,
  });
  assert.equal(result.kept.length, rows.length - 5);
  assert.equal(result.report.anonymousClientSessions, 1);
  assert.deepEqual(result.report.marks, { M1_fecha_corregida: 1, M2_decision_huerfana: 1, M3_orden_invalido: 1 });
  assert.equal(result.excluded.find((item) => item.rule === "D5_duplicado")?.row.id, "copia", "se queda el primero");
  const report = renderCleaningReport(result, { window: "prueba", generatedAt: "ahora", source: "test" });
  assert.match(report, /D2_cliente_anonimo \| .* \| 1 \|/);
  assert.match(report, /1 sesiones de cliente sin sesion de usuario/);
});

test("graficas: SVG con texto escapado y titulo accesible", () => {
  assert.equal(escapeXml("<a & \"b\">"), "&lt;a &amp; &quot;b&quot;&gt;");
  const svg = pairedDotsSvg({ title: "Tiempo <prueba> & más", unit: "s", leftLabel: "Sin tutor", rightLabel: "Con tutor", pairs: [{ left: 200, right: 120, group: "A" }, { left: 150, right: 160, group: "B" }] });
  assert.ok(svg.startsWith("<svg "));
  assert.ok(svg.trim().endsWith("</svg>"));
  assert.match(svg, /<title>Tiempo &lt;prueba&gt; &amp; más<\/title>/);
  assert.doesNotMatch(svg, /NaN/);
  const likert = likertSvg({ title: "UX", items: [{ label: "UX1", counts: [0, 1, 2, 3, 4] }, { label: "UX2", counts: [0, 0, 0, 0, 0] }] });
  assert.match(likert, /sin respuestas/);
  assert.doesNotMatch(likert, /NaN/);
});
