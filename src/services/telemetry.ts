import { createHash, createHmac, randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import type { AppSession } from "../types/app.js";
import {
  FIELD_DICTIONARY,
  findCatalogEntry,
  type TelemetryCategory,
  type TelemetrySource,
} from "./telemetry-catalog.js";

/**
 * Telemetria v1.1 (A4.2, A4.4, A4.5, A5.5, A7.1, A7.2, A7.6).
 *
 * - Un solo formato de evento para overlay, VS Code y backend.
 * - El actor se guarda seudonimizado con HMAC-SHA256 y una sal secreta
 *   (TELEMETRY_SALT): ni id de usuario, ni correo, ni client id en claro.
 * - Los textos de error y de contexto solo se guardan como hash.
 * - Cada evento lleva sus avisos de calidad (reglas Q#) y el conjunto se
 *   puede revisar con las reglas de integridad (I#).
 *
 * Modulo puro: no toca la base de datos (eso lo hace AppDatabase), para
 * poder usarlo desde la base, las rutas y los scripts sin ciclos.
 */

export const TELEMETRY_SCHEMA_VERSION = "1.1";

const DEV_SALT = "adaceen-sal-de-desarrollo-no-usar-en-produccion";
let warnedAboutSalt = false;

function telemetrySalt() {
  if (env.telemetrySalt) return env.telemetrySalt;
  if (!warnedAboutSalt) {
    warnedAboutSalt = true;
    console.warn("[telemetria] TELEMETRY_SALT no esta configurada: se usa una sal de desarrollo. Configurala en produccion.");
  }
  return DEV_SALT;
}

/** HMAC-SHA256 recortado a 20 hex (80 bits): estable y no reversible sin la sal. */
export function pseudonymize(value: string) {
  const clean = String(value || "").trim();
  if (!clean) return "";
  return createHmac("sha256", telemetrySalt()).update(clean).digest("hex").slice(0, 20);
}

/**
 * Normaliza un mensaje de error para que el mismo error de dos estudiantes
 * (u otra linea, u otra ruta) produzca el mismo hash.
 */
export function normalizeErrorText(text: unknown) {
  return String(text || "")
    .toLowerCase()
    .replace(/\r?\n/g, " ")
    .replace(/[a-z]:\\[^\s:'"]*/g, "<ruta>")
    .replace(/(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+/g, "<ruta>")
    .replace(/"[^"]*"|'[^']*'|`[^`]*`|‘[^’]*’/g, "'_'")
    .replace(/0x[0-9a-f]+/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

/** SHA-256 recortado a 16 hex; vacio si no hay texto. */
export function hashText(text: unknown) {
  const clean = String(text || "").trim();
  if (!clean) return "";
  return createHash("sha256").update(clean).digest("hex").slice(0, 16);
}

export function hashErrorText(text: unknown) {
  return hashText(normalizeErrorText(text));
}

export function exerciseHash(exerciseKey: unknown) {
  const clean = String(exerciseKey || "").trim().toLowerCase();
  return clean ? pseudonymize(`exercise:${clean}`) : "";
}

export function fileExtension(filePath: unknown) {
  const base = String(filePath || "").split(/[\\/]/).pop() || "";
  const match = base.match(/(\.[A-Za-z0-9+#_-]{1,10})$/);
  return match ? match[1].toLowerCase() : "";
}

// ---------------------------------------------------------------------------
// Actores
// ---------------------------------------------------------------------------

export type TelemetryActorKind = "user" | "client" | "system";

export type TelemetryActor = {
  kind: TelemetryActorKind;
  /** user:<id> | client:<id> | system: nunca se guarda en claro. */
  key: string;
  role: string;
  /** user:<id> del docente, si se conoce. */
  teacherKey: string;
};

export const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;

export const SYSTEM_ACTOR: TelemetryActor = { kind: "system", key: "system", role: "", teacherKey: "" };

export function actorFromSession(session: Pick<AppSession, "user">): TelemetryActor {
  const user = session.user;
  const teacherId = user.role === "teacher" ? user.id : user.teacherUserId || "";
  return {
    kind: "user",
    key: `user:${user.id}`,
    role: user.role,
    teacherKey: teacherId ? `user:${teacherId}` : "",
  };
}

export function actorFromClientId(clientId: unknown): TelemetryActor | null {
  const clean = String(clientId || "").trim();
  if (!CLIENT_ID_PATTERN.test(clean)) return null;
  return { kind: "client", key: `client:${clean}`, role: "", teacherKey: "" };
}

/** Clave estable del actor para limites por ejercicio (no se guarda en claro). */
export function actorAnonId(actor: TelemetryActor) {
  return actor.kind === "system" ? "" : pseudonymize(actor.key);
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

export type TelemetryEventInput = {
  source?: TelemetrySource;
  channel?: string;
  category?: TelemetryCategory | string;
  eventType: string;
  occurredAt?: string | Date | null;
  schemaVersion?: string;
  clientSessionId?: string;
  seq?: number | null;
  decisionId?: string;
  courseCode?: string;
  /** Actividad o archivo: se guarda solo su HMAC. */
  exerciseKey?: string;
  language?: string;
  /** Se usa solo para sacar la extension; la ruta no se guarda. */
  filePath?: string;
  pageContext?: string;
  policyEventType?: string;
  interventionType?: string;
  helpStage?: string;
  reasonCode?: string;
  blocked?: boolean | null;
  latencyMs?: number | null;
  durationMs?: number | null;
  count?: number | null;
  value?: string;
  /** Texto de error: se convierte en hash y se descarta. */
  errorText?: string;
  errorHash?: string;
  /** Texto de contexto: se convierte en hash y se descarta. */
  contextText?: string;
  contextHash?: string;
  metadata?: Record<string, unknown>;
};

export type TelemetryQualityFlag = {
  code: string;
  severity: "error" | "aviso" | "info";
};

export type TelemetryEventRow = {
  id: string;
  schemaVersion: string;
  occurredAt: string;
  receivedAt: string;
  source: string;
  channel: string;
  category: string;
  eventType: string;
  actorAnonId: string;
  actorKind: string;
  actorRole: string;
  teacherAnonId: string;
  clientSessionId: string;
  seq: number | null;
  decisionId: string;
  courseCode: string;
  exerciseHash: string;
  language: string;
  fileExt: string;
  policyEventType: string;
  interventionType: string;
  helpStage: string;
  reasonCode: string;
  blocked: boolean | null;
  latencyMs: number | null;
  durationMs: number | null;
  countValue: number | null;
  valueText: string;
  errorHash: string;
  contextHash: string;
  metadata: Record<string, unknown>;
  qualityFlags: TelemetryQualityFlag[];
};

/**
 * Claves de metadata que se guardan. Todo lo demas se descarta: la metadata
 * no es un lugar para texto libre, codigo ni datos personales.
 */
const METADATA_WHITELIST = new Set([
  "trigger",
  "pageType",
  "pageContext",
  "applyMode",
  "linesChanged",
  "charsChanged",
  "line",
  "cached",
  "blocked",
  "scope",
  "mode",
  "reason",
  "source",
  "remaining",
  "maxLines",
  "allowed",
  "cacheNamespace",
  "worker",
  "ragSources",
  "stage",
  "feedback",
  "status",
  "provider",
  "retry",
  "view",
  "severity",
  "errors",
  "warnings",
]);

function sanitizeMetadata(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!METADATA_WHITELIST.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
    else if (typeof value === "boolean") clean[key] = value;
    else if (typeof value === "string") clean[key] = value.slice(0, 120);
  }
  return clean;
}

function cleanShort(value: unknown, max: number) {
  return String(value ?? "").trim().slice(0, max);
}

function cleanHex(value: unknown) {
  const clean = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8,64}$/.test(clean) ? clean : "";
}

function cleanInt(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function channelForSource(source: string) {
  if (source === "browser_extension") return "overlay";
  if (source === "vscode_extension") return "vscode";
  if (source === "system") return "system";
  return "backend";
}

const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const OLD_EVENT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Convierte un evento de entrada en la fila que se guarda y calcula sus
 * avisos de calidad. Nunca lanza: lo que no cumple el esquema ya lo
 * rechazo zod en la ruta.
 */
export function buildTelemetryRow(
  actor: TelemetryActor,
  input: TelemetryEventInput,
  now = new Date(),
): TelemetryEventRow {
  const flags: TelemetryQualityFlag[] = [];
  const eventType = cleanShort(input.eventType, 120);
  const catalog = findCatalogEntry(eventType);
  const source = (cleanShort(input.source, 40) || "backend") as TelemetrySource;
  const category = cleanShort(input.category, 40) || catalog?.category || "";

  if (!catalog) {
    flags.push({ code: "Q3_evento_desconocido", severity: "aviso" });
  } else if (category && category !== catalog.category) {
    flags.push({ code: "Q4_categoria_distinta", severity: "aviso" });
  }

  const receivedAt = now.toISOString();
  let occurredAt = receivedAt;
  if (input.occurredAt) {
    const parsed = new Date(input.occurredAt);
    if (!Number.isNaN(parsed.getTime())) {
      if (parsed.getTime() - now.getTime() > FUTURE_TOLERANCE_MS) {
        flags.push({ code: "Q5_fecha_futura", severity: "aviso" });
      } else {
        occurredAt = parsed.toISOString();
        if (now.getTime() - parsed.getTime() > OLD_EVENT_MS) {
          flags.push({ code: "Q6_fecha_antigua", severity: "aviso" });
        }
      }
    }
  }

  const schemaVersion = cleanShort(input.schemaVersion, 20);
  if (!schemaVersion && source !== "backend") {
    flags.push({ code: "Q7_sin_version", severity: "info" });
  }

  const decisionId = cleanShort(input.decisionId, 80);
  if (catalog?.requiresDecision && !decisionId) {
    flags.push({ code: "Q8_sin_decision", severity: "aviso" });
  }

  let errorHash = cleanHex(input.errorHash);
  if (input.errorText) {
    errorHash = hashErrorText(input.errorText);
    flags.push({ code: "Q9_texto_descartado", severity: "info" });
  }
  const contextHash = input.contextText ? hashText(input.contextText) : cleanHex(input.contextHash);

  return {
    id: randomUUID(),
    schemaVersion: schemaVersion || (source === "backend" ? TELEMETRY_SCHEMA_VERSION : "1.0"),
    occurredAt,
    receivedAt,
    source,
    channel: cleanShort(input.channel, 20) || channelForSource(source),
    category,
    eventType,
    actorAnonId: actorAnonId(actor),
    actorKind: actor.kind,
    actorRole: actor.role,
    teacherAnonId: actor.teacherKey ? pseudonymize(actor.teacherKey) : "",
    clientSessionId: cleanShort(input.clientSessionId, 80),
    seq: cleanInt(input.seq, 0, 1_000_000_000),
    decisionId,
    courseCode: cleanShort(input.courseCode, 40),
    exerciseHash: input.exerciseKey ? exerciseHash(input.exerciseKey) : "",
    language: cleanShort(input.language, 40).toLowerCase(),
    fileExt: fileExtension(input.filePath),
    policyEventType: cleanShort(input.policyEventType, 40),
    interventionType: cleanShort(input.interventionType, 40),
    helpStage: cleanShort(input.helpStage, 40),
    reasonCode: cleanShort(input.reasonCode, 60),
    blocked: typeof input.blocked === "boolean" ? input.blocked : null,
    latencyMs: cleanInt(input.latencyMs, 0, 3_600_000),
    durationMs: cleanInt(input.durationMs, 0, 86_400_000),
    countValue: cleanInt(input.count, 0, 1_000_000),
    valueText: cleanShort(input.value, 120),
    errorHash,
    contextHash,
    metadata: sanitizeMetadata({
      ...(input.metadata || {}),
      ...(input.pageContext ? { pageContext: input.pageContext } : {}),
    }),
    qualityFlags: flags,
  };
}

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

export function toJsonl(rows: TelemetryEventRow[]) {
  return rows.map((row) => JSON.stringify(toExportRecord(row))).join("\n") + (rows.length ? "\n" : "");
}
