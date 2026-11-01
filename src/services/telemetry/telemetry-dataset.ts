// Telemetria: integridad del conjunto de datos (A7.6) y exportacion CSV/JSONL sin actor en claro (A7.2).
import { FIELD_DICTIONARY } from "./telemetry-catalog.js";
import { type TelemetryEventRow, type TelemetryQualityFlag } from "./telemetry.js";

// ---------------------------------------------------------------------------
// Integridad del conjunto de datos (A7.6)
// ---------------------------------------------------------------------------

export type DatasetRow = Pick<
  TelemetryEventRow,
  "id" | "eventType" | "occurredAt" | "clientSessionId" | "seq" | "decisionId" | "qualityFlags"
>;

export type DatasetQualityReport = {
  totalEvents: number;
  eventsWithFlags: number;
  flags: Record<string, number>;
  integrity: Record<string, { count: number; examples: string[] }>;
  eventLoss: {
    clientSessions: number;
    expected: number;
    received: number;
    missing: number;
    rate: number;
  };
};

const DECISION_OUTCOMES = new Set(["tutor_response_accepted", "tutor_response_rejected", "tutor_response_ignored"]);

function pushExample(bucket: { count: number; examples: string[] }, id: string) {
  bucket.count += 1;
  if (bucket.examples.length < 5) bucket.examples.push(id);
}

/**
 * Revisa un conjunto de eventos: avisos por evento (Q#), eventos perdidos
 * por huecos de seq (I1), duplicados (I2), orden (I3), contradicciones
 * (I4), decisiones huerfanas (I5) y aplicaciones sin verificar (I6).
 */
export function analyzeTelemetryDataset(rows: DatasetRow[]): DatasetQualityReport {
  const flags: Record<string, number> = {};
  let eventsWithFlags = 0;
  const integrity: DatasetQualityReport["integrity"] = {
    I1_eventos_perdidos: { count: 0, examples: [] },
    I2_duplicados: { count: 0, examples: [] },
    I3_orden_invalido: { count: 0, examples: [] },
    I4_respuesta_contradictoria: { count: 0, examples: [] },
    I5_decision_huerfana: { count: 0, examples: [] },
    I6_aplicada_sin_verificar: { count: 0, examples: [] },
  };

  const seqBySession = new Map<string, number[]>();
  const seen = new Set<string>();
  const decisions = new Set<string>();
  const shownAt = new Map<string, number>();
  const outcomes = new Map<string, Set<string>>();
  const checkedDecisions = new Set<string>();

  const sorted = [...rows].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));

  for (const row of sorted) {
    if (row.qualityFlags.length > 0) eventsWithFlags += 1;
    for (const flag of row.qualityFlags) {
      flags[flag.code] = (flags[flag.code] || 0) + 1;
    }

    if (row.clientSessionId && row.seq !== null && row.seq !== undefined) {
      const key = `${row.clientSessionId}#${row.seq}`;
      if (seen.has(key)) {
        pushExample(integrity.I2_duplicados, row.id);
      } else {
        seen.add(key);
        const list = seqBySession.get(row.clientSessionId) || [];
        list.push(row.seq);
        seqBySession.set(row.clientSessionId, list);
      }
    }

    if (row.eventType === "tutor_decision" && row.decisionId) decisions.add(row.decisionId);
    if (row.eventType === "code_application_checked" && row.decisionId) checkedDecisions.add(row.decisionId);
  }

  for (const row of sorted) {
    const time = Date.parse(row.occurredAt);
    if (row.decisionId && row.eventType !== "tutor_decision" && !decisions.has(row.decisionId)) {
      pushExample(integrity.I5_decision_huerfana, row.id);
    }
    if (row.eventType === "tutor_response_shown" && row.decisionId && !shownAt.has(row.decisionId)) {
      shownAt.set(row.decisionId, time);
    }
    if (DECISION_OUTCOMES.has(row.eventType) && row.decisionId) {
      const shown = shownAt.get(row.decisionId);
      if (shown === undefined || time < shown) {
        pushExample(integrity.I3_orden_invalido, row.id);
      }
      const set = outcomes.get(row.decisionId) || new Set<string>();
      set.add(row.eventType);
      outcomes.set(row.decisionId, set);
      if (set.has("tutor_response_accepted") && set.has("tutor_response_rejected") && set.size >= 2
        && (row.eventType === "tutor_response_accepted" || row.eventType === "tutor_response_rejected")) {
        pushExample(integrity.I4_respuesta_contradictoria, row.id);
      }
    }
    if (row.eventType === "suggestion_completion_applied" && row.decisionId && !checkedDecisions.has(row.decisionId)) {
      pushExample(integrity.I6_aplicada_sin_verificar, row.id);
    }
  }

  let expected = 0;
  let received = 0;
  for (const [session, seqs] of seqBySession) {
    const sortedSeqs = [...seqs].sort((a, b) => a - b);
    const span = sortedSeqs[sortedSeqs.length - 1] - sortedSeqs[0] + 1;
    expected += span;
    received += sortedSeqs.length;
    const missing = span - sortedSeqs.length;
    if (missing > 0) {
      integrity.I1_eventos_perdidos.count += missing;
      if (integrity.I1_eventos_perdidos.examples.length < 5) integrity.I1_eventos_perdidos.examples.push(session);
    }
  }
  const missing = Math.max(0, expected - received);

  return {
    totalEvents: rows.length,
    eventsWithFlags,
    flags,
    integrity,
    eventLoss: {
      clientSessions: seqBySession.size,
      expected,
      received,
      missing,
      rate: expected > 0 ? Number((missing / expected).toFixed(4)) : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Exportacion (A7.2): sin actor en claro, columnas del diccionario
// ---------------------------------------------------------------------------

const ROW_KEY_BY_COLUMN: Record<string, keyof TelemetryEventRow> = {
  id: "id",
  schema_version: "schemaVersion",
  occurred_at: "occurredAt",
  received_at: "receivedAt",
  source: "source",
  channel: "channel",
  category: "category",
  event_type: "eventType",
  actor_anon_id: "actorAnonId",
  actor_kind: "actorKind",
  actor_role: "actorRole",
  teacher_anon_id: "teacherAnonId",
  client_session_id: "clientSessionId",
  seq: "seq",
  decision_id: "decisionId",
  course_code: "courseCode",
  exercise_hash: "exerciseHash",
  language: "language",
  file_ext: "fileExt",
  policy_event_type: "policyEventType",
  intervention_type: "interventionType",
  help_stage: "helpStage",
  reason_code: "reasonCode",
  blocked: "blocked",
  latency_ms: "latencyMs",
  duration_ms: "durationMs",
  count_value: "countValue",
  value_text: "valueText",
  error_hash: "errorHash",
  context_hash: "contextHash",
  metadata: "metadata",
  quality_flags: "qualityFlags",
  pilot_block: "pilotBlock",
  pilot_cohort: "pilotCohort",
  pilot_condition: "pilotCondition",
};

export const EXPORT_COLUMNS = FIELD_DICTIONARY.map((entry) => entry.field);

export function toExportRecord(row: TelemetryEventRow) {
  const record: Record<string, unknown> = {};
  for (const column of EXPORT_COLUMNS) {
    const key = ROW_KEY_BY_COLUMN[column];
    record[column] = key ? row[key] : null;
  }
  return record;
}

function csvCell(value: unknown) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

export function toCsv(rows: TelemetryEventRow[]) {
  const lines = [EXPORT_COLUMNS.join(",")];
  for (const row of rows) {
    const record = toExportRecord(row);
    lines.push(EXPORT_COLUMNS.map((column) => csvCell(record[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Inverso de toExportRecord: lee una fila exportada (CSV o JSONL) para el
 * analisis del piloto sin acceso a la base.
 */
export function fromExportRecord(record: Record<string, unknown>): TelemetryEventRow {
  const text = (column: string) => String(record[column] ?? "");
  const integer = (column: string) => {
    const value = record[column];
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const boolean = (column: string) => {
    const value = record[column];
    if (value === true || value === "true") return true;
    if (value === false || value === "false") return false;
    return null;
  };
  const json = <T>(column: string, fallback: T): T => {
    const value = record[column];
    if (value && typeof value === "object") return value as T;
    if (typeof value === "string" && value.trim()) {
      try {
        return JSON.parse(value) as T;
      } catch {
        return fallback;
      }
    }
    return fallback;
  };
  return {
    id: text("id"),
    schemaVersion: text("schema_version"),
    occurredAt: text("occurred_at"),
    receivedAt: text("received_at"),
    source: text("source"),
    channel: text("channel"),
    category: text("category"),
    eventType: text("event_type"),
    actorAnonId: text("actor_anon_id"),
    actorKind: text("actor_kind"),
    actorRole: text("actor_role"),
    teacherAnonId: text("teacher_anon_id"),
    clientSessionId: text("client_session_id"),
    seq: integer("seq"),
    decisionId: text("decision_id"),
    courseCode: text("course_code"),
    exerciseHash: text("exercise_hash"),
    language: text("language"),
    fileExt: text("file_ext"),
    policyEventType: text("policy_event_type"),
    interventionType: text("intervention_type"),
    helpStage: text("help_stage"),
    reasonCode: text("reason_code"),
    blocked: boolean("blocked"),
    latencyMs: integer("latency_ms"),
    durationMs: integer("duration_ms"),
    countValue: integer("count_value"),
    valueText: text("value_text"),
    errorHash: text("error_hash"),
    contextHash: text("context_hash"),
    metadata: json<Record<string, unknown>>("metadata", {}),
    qualityFlags: json<TelemetryQualityFlag[]>("quality_flags", []),
    pilotBlock: integer("pilot_block"),
    pilotCohort: text("pilot_cohort"),
    pilotCondition: text("pilot_condition"),
  };
}

export function toJsonl(rows: TelemetryEventRow[]) {
  return rows.map((row) => JSON.stringify(toExportRecord(row))).join("\n") + (rows.length ? "\n" : "");
}
