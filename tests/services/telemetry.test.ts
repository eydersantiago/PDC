import assert from "node:assert/strict";
import test from "node:test";
import {
  actorAnonId,
  actorFromClientId,
  actorFromSession,
  analyzeTelemetryDataset,
  buildTelemetryRow,
  EXPORT_COLUMNS,
  hashErrorText,
  pseudonymize,
  toCsv,
  toJsonl,
  type DatasetRow,
  type TelemetryEventRow,
} from "../../src/services/telemetry.js";
import { EVENT_CATALOG, FIELD_DICTIONARY, QUALITY_RULES } from "../../src/services/telemetry-catalog.js";

/**
 * A4.4 / A7.1 / A7.6 / A10.5: seudonimizacion, minimizacion, reglas de
 * calidad por evento (Q#) e integridad del conjunto (I#).
 */

const CLIENT_ID = "cliente-piloto-0001";
const RAW_ERROR = "C:\\Users\\ana.perez\\taller\\main.cpp:12:5: error: 'x' was not declared in this scope";
const NOW = new Date("2026-09-23T15:00:00.000Z");

test("telemetria: el actor se seudonimiza y nunca se guarda en claro", () => {
  const client = actorFromClientId(CLIENT_ID);
  assert.ok(client);
  assert.equal(actorFromClientId("corto"), null);
  assert.equal(actorFromClientId("con espacios invalidos"), null);

  const anon = actorAnonId(client);
  assert.match(anon, /^[0-9a-f]{20}$/);
  assert.equal(anon, pseudonymize(`client:${CLIENT_ID}`), "estable entre llamadas");
  assert.ok(!anon.includes(CLIENT_ID));
  assert.notEqual(pseudonymize("user:a"), pseudonymize("user:b"));

  const student = actorFromSession({
    user: {
      id: "user-student-demo",
      role: "student",
      email: "estudiante@adaceen.edu.co",
      displayName: "Estudiante Demo",
      teacherUserId: "user-teacher-demo",
    },
  });
  assert.equal(student.teacherKey, "user:user-teacher-demo");
  const row = buildTelemetryRow(student, { eventType: "tutor_decision", source: "backend", decisionId: "d-1" }, NOW);
  const serialized = JSON.stringify(row);
  assert.ok(!serialized.includes("user-student-demo"));
  assert.ok(!serialized.includes("user-teacher-demo"));
  assert.ok(!serialized.includes("estudiante@adaceen.edu.co"));
  assert.match(row.teacherAnonId, /^[0-9a-f]{20}$/);
});

test("telemetria (A10.5): el texto del error, la ruta, el codigo y la metadata libre no se guardan", () => {
  const actor = actorFromClientId(CLIENT_ID)!;
  const row = buildTelemetryRow(actor, {
    source: "vscode_extension",
    schemaVersion: "1.1",
    eventType: "compile_error_detected",
    filePath: "C:\\Users\\ana.perez\\taller\\main.cpp",
    exerciseKey: "file:c:\\users\\ana.perez\\taller\\main.cpp",
    errorText: RAW_ERROR,
    contextText: "int main() { int x = 1; return x }",
    metadata: {
      severity: "error",
      errors: 1,
      email: "ana.perez@correounivalle.edu.co",
      code: "int x = 1;",
      path: "C:\\Users\\ana.perez",
      nested: { a: 1 },
      reason: "x".repeat(300),
    },
  }, NOW);

  const serialized = JSON.stringify(row);
  for (const secret of ["ana.perez", "was not declared", "int main", "correounivalle", "C:\\\\Users"]) {
    assert.ok(!serialized.includes(secret), `no debe aparecer: ${secret}`);
  }
  assert.equal(row.fileExt, ".cpp");
  assert.equal(row.errorHash, hashErrorText(RAW_ERROR));
  assert.match(row.contextHash, /^[0-9a-f]{16}$/);
  assert.match(row.exerciseHash, /^[0-9a-f]{20}$/);
  assert.deepEqual(Object.keys(row.metadata).sort(), ["errors", "reason", "severity"]);
  assert.equal(String(row.metadata.reason).length, 120);
  assert.ok(row.qualityFlags.some((flag) => flag.code === "Q9_texto_descartado"));

  // El mismo error en otra maquina y otra linea da el mismo hash (comparables entre estudiantes).
  assert.equal(
    hashErrorText("/home/luis/taller/main.cpp:40:9: error: 'total' was not declared in this scope"),
    hashErrorText(RAW_ERROR),
  );
});

test("telemetria: reglas de calidad por evento Q3-Q8", () => {
  const actor = actorFromClientId(CLIENT_ID)!;
  const codes = (input: Parameters<typeof buildTelemetryRow>[1]) =>
    buildTelemetryRow(actor, input, NOW).qualityFlags.map((flag) => flag.code);

  assert.deepEqual(codes({ source: "browser_extension", schemaVersion: "1.1", eventType: "overlay_opened" }), []);
  assert.ok(codes({ source: "browser_extension", schemaVersion: "1.1", eventType: "evento_inventado" }).includes("Q3_evento_desconocido"));
  assert.ok(codes({ source: "browser_extension", schemaVersion: "1.1", eventType: "overlay_opened", category: "quiz" }).includes("Q4_categoria_distinta"));

  const future = buildTelemetryRow(actor, {
    source: "browser_extension",
    schemaVersion: "1.1",
    eventType: "overlay_opened",
    occurredAt: "2026-09-23T16:00:00.000Z",
  }, NOW);
  assert.ok(future.qualityFlags.some((flag) => flag.code === "Q5_fecha_futura"));
  assert.equal(future.occurredAt, NOW.toISOString(), "se corrige a received_at");

  assert.ok(codes({ source: "browser_extension", schemaVersion: "1.1", eventType: "overlay_opened", occurredAt: "2026-09-01T00:00:00.000Z" }).includes("Q6_fecha_antigua"));
  assert.ok(codes({ source: "browser_extension", eventType: "overlay_opened" }).includes("Q7_sin_version"));
  assert.ok(codes({ source: "browser_extension", schemaVersion: "1.1", eventType: "tutor_response_shown" }).includes("Q8_sin_decision"));

  // Todas las reglas y todos los eventos del catalogo estan documentados.
  assert.deepEqual(
    QUALITY_RULES.map((rule) => rule.code.split("_")[0]),
    ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8", "Q9", "I1", "I2", "I3", "I4", "I5", "I6"],
  );
  assert.ok(EVENT_CATALOG.every((entry) => entry.eventType && entry.category && entry.purpose));
});

function datasetRow(partial: Partial<DatasetRow> & Pick<DatasetRow, "id" | "eventType">): DatasetRow {
  return {
    occurredAt: "2026-09-23T10:00:00.000Z",
    clientSessionId: "",
    seq: null,
    decisionId: "",
    qualityFlags: [],
    ...partial,
  };
}

test("telemetria (A7.6): integridad del conjunto I1-I6 y tasa de eventos perdidos", () => {
  const at = (second: number) => `2026-09-23T10:00:${String(second).padStart(2, "0")}.000Z`;
  const rows: DatasetRow[] = [
    // Sesion s1: seq 1, 2, 4, 5 (falta la 3) y la 2 repetida.
    datasetRow({ id: "e1", eventType: "overlay_opened", clientSessionId: "s1", seq: 1, occurredAt: at(1) }),
    datasetRow({ id: "e2", eventType: "tutor_request_submitted", clientSessionId: "s1", seq: 2, occurredAt: at(2) }),
    datasetRow({ id: "e2-dup", eventType: "tutor_request_submitted", clientSessionId: "s1", seq: 2, occurredAt: at(2) }),
    datasetRow({ id: "d1", eventType: "tutor_decision", decisionId: "dec-1", occurredAt: at(3) }),
    datasetRow({ id: "e4", eventType: "tutor_response_shown", clientSessionId: "s1", seq: 4, decisionId: "dec-1", occurredAt: at(4) }),
    datasetRow({ id: "e5", eventType: "tutor_response_accepted", clientSessionId: "s1", seq: 5, decisionId: "dec-1", occurredAt: at(5) }),
    // I4: la misma decision tambien aparece rechazada.
    datasetRow({ id: "e6", eventType: "tutor_response_rejected", decisionId: "dec-1", occurredAt: at(6) }),
    // I3: aceptada antes de mostrarse.
    datasetRow({ id: "d2", eventType: "tutor_decision", decisionId: "dec-2", occurredAt: at(7) }),
    datasetRow({ id: "e7", eventType: "tutor_response_accepted", decisionId: "dec-2", occurredAt: at(8) }),
    datasetRow({ id: "e8", eventType: "tutor_response_shown", decisionId: "dec-2", occurredAt: at(9) }),
    // I5: decision que no esta en el conjunto.
    datasetRow({ id: "e9", eventType: "tutor_response_shown", decisionId: "dec-perdida", occurredAt: at(10) }),
    // I6: aplicada sin apply-check de la misma decision.
    datasetRow({ id: "d3", eventType: "tutor_decision", decisionId: "dec-3", occurredAt: at(11) }),
    datasetRow({ id: "e10", eventType: "suggestion_completion_applied", decisionId: "dec-3", occurredAt: at(12) }),
    datasetRow({ id: "e11", eventType: "overlay_closed", occurredAt: at(13), qualityFlags: [{ code: "Q7_sin_version", severity: "info" }] }),
  ];

  const report = analyzeTelemetryDataset(rows);
  assert.equal(report.totalEvents, rows.length);
  assert.equal(report.eventsWithFlags, 1);
  assert.equal(report.flags.Q7_sin_version, 1);
  assert.equal(report.integrity.I1_eventos_perdidos.count, 1);
  assert.deepEqual(report.integrity.I1_eventos_perdidos.examples, ["s1"]);
  assert.deepEqual(report.integrity.I2_duplicados.examples, ["e2-dup"]);
  assert.deepEqual(report.integrity.I3_orden_invalido.examples, ["e7"]);
  assert.deepEqual(report.integrity.I4_respuesta_contradictoria.examples, ["e6"]);
  assert.deepEqual(report.integrity.I5_decision_huerfana.examples, ["e9"]);
  assert.deepEqual(report.integrity.I6_aplicada_sin_verificar.examples, ["e10"]);
  assert.deepEqual(report.eventLoss, { clientSessions: 1, expected: 5, received: 4, missing: 1, rate: 0.2 });

  const clean = analyzeTelemetryDataset([]);
  assert.equal(clean.eventLoss.rate, 0);
  assert.equal(clean.totalEvents, 0);
});

test("telemetria (A7.2): la exportacion solo trae columnas del diccionario", () => {
  const actor = actorFromClientId(CLIENT_ID)!;
  const row: TelemetryEventRow = buildTelemetryRow(actor, {
    source: "browser_extension",
    schemaVersion: "1.1",
    eventType: "error_detected",
    errorText: RAW_ERROR,
    metadata: { pageType: "github_code" },
    clientSessionId: "s-1",
    seq: 3,
  }, NOW);

  assert.deepEqual(EXPORT_COLUMNS, FIELD_DICTIONARY.map((entry) => entry.field));
  for (const forbidden of ["email", "user_id", "student_user_id", "file_path", "error_text", "context_text", "code"]) {
    assert.ok(!EXPORT_COLUMNS.includes(forbidden), forbidden);
  }

  const csv = toCsv([row]);
  const [header, line] = csv.trim().split("\n");
  assert.equal(header, EXPORT_COLUMNS.join(","));
  assert.ok(line.includes(row.actorAnonId));
  assert.ok(!csv.includes(CLIENT_ID));
  assert.ok(!csv.includes("was not declared"));

  const jsonl = toJsonl([row, row]);
  const records = jsonl.trim().split("\n").map((item) => JSON.parse(item) as Record<string, unknown>);
  assert.equal(records.length, 2);
  assert.deepEqual(Object.keys(records[0]), EXPORT_COLUMNS);
  assert.equal(toJsonl([]), "");
});
