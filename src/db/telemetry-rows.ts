// Base de datos: fila de telemetria y su conversion a/desde eventos de comportamiento.
// Movido sin cambios desde src/db/database.ts (solo se agrego "export" a lo que no lo tenia).
import type { TelemetryEventInput, TelemetryEventRow } from "../services/telemetry.js";
import { toIso } from "./rows.js";
import type { BehaviorEventInput } from "../types/app.js";

export type TelemetryEventDbRow = {
  id: string;
  schema_version: string;
  occurred_at: string | Date;
  received_at: string | Date;
  source: string;
  channel: string;
  category: string;
  event_type: string;
  actor_anon_id: string;
  actor_kind: string;
  actor_role: string;
  teacher_anon_id: string;
  client_session_id: string;
  seq: number | null;
  decision_id: string;
  course_code: string;
  exercise_hash: string;
  language: string;
  file_ext: string;
  policy_event_type: string;
  intervention_type: string;
  help_stage: string;
  reason_code: string;
  blocked: boolean | null;
  latency_ms: number | null;
  duration_ms: number | null;
  count_value: number | null;
  value_text: string;
  error_hash: string;
  context_hash: string;
  metadata: unknown;
  quality_flags: unknown;
  pilot_block?: number | null;
  pilot_cohort?: string | null;
  pilot_condition?: string | null;
};

export function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export function mapTelemetryEventRow(row: TelemetryEventDbRow): TelemetryEventRow {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    occurredAt: toIso(row.occurred_at),
    receivedAt: toIso(row.received_at),
    source: row.source,
    channel: row.channel,
    category: row.category,
    eventType: row.event_type,
    actorAnonId: row.actor_anon_id,
    actorKind: row.actor_kind,
    actorRole: row.actor_role,
    teacherAnonId: row.teacher_anon_id,
    clientSessionId: row.client_session_id,
    seq: row.seq === null || row.seq === undefined ? null : Number(row.seq),
    decisionId: row.decision_id,
    courseCode: row.course_code,
    exerciseHash: row.exercise_hash,
    language: row.language,
    fileExt: row.file_ext,
    policyEventType: row.policy_event_type,
    interventionType: row.intervention_type,
    helpStage: row.help_stage,
    reasonCode: row.reason_code,
    blocked: row.blocked === null || row.blocked === undefined ? null : Boolean(row.blocked),
    latencyMs: row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    countValue: row.count_value === null || row.count_value === undefined ? null : Number(row.count_value),
    valueText: row.value_text,
    errorHash: row.error_hash,
    contextHash: row.context_hash,
    metadata: parseJsonColumn<Record<string, unknown>>(row.metadata, {}),
    qualityFlags: parseJsonColumn<TelemetryEventRow["qualityFlags"]>(row.quality_flags, []),
    pilotBlock: row.pilot_block === null || row.pilot_block === undefined ? null : Number(row.pilot_block),
    pilotCohort: row.pilot_cohort || "",
    pilotCondition: row.pilot_condition || "",
  };
}

/** Traduce un evento de comportamiento v1.0/v1.1 al formato unico de telemetria. */
export function behaviorEventToTelemetryInput(event: BehaviorEventInput): TelemetryEventInput {
  return {
    source: event.source,
    category: event.category,
    eventType: event.eventType,
    occurredAt: event.occurredAt || null,
    schemaVersion: event.schemaVersion,
    clientSessionId: event.clientSessionId,
    seq: event.seq ?? null,
    decisionId: event.decisionId,
    exerciseKey: event.filePath ? `file:${event.filePath}` : undefined,
    language: event.language,
    filePath: event.filePath,
    pageContext: event.pageContext,
    latencyMs: event.latencyMs ?? null,
    durationMs: event.durationMs ?? null,
    count: event.count ?? null,
    value: event.value,
    errorHash: event.errorHash,
    contextHash: event.contextHash,
    metadata: event.metadata,
  };
}
