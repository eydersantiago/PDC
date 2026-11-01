// Telemetria v1.1: eventos (buildTelemetryRow), campos permitidos de metadata y reglas de calidad.
import { randomUUID } from "node:crypto";
import {
  findCatalogEntry,
  isServerOnlyEvent,
  SERVER_ONLY_SOURCES,
  type TelemetryCategory,
  type TelemetrySource
} from "./telemetry-catalog.js";
import { pseudonymize, hashErrorText, hashText, exerciseHash, fileExtension } from "./telemetry-hash.js";
import { type TelemetryActor, actorAnonId } from "./telemetry-actors.js";

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
  /** Piloto AB/BA (A13.1): bloque, cohorte y condicion vigentes al recibir el evento. */
  pilotBlock: number | null;
  pilotCohort: string;
  pilotCondition: string;
};

/**
 * Tipo de cada clave de metadata que se guarda:
 *   - string: texto corto (se recorta a 120 caracteres);
 *   - number: numero finito; uint: entero no negativo; boolean: true o false;
 *   - scalar: cualquiera de los tres (las claves de antes del 30-10-2026, que mandan varios
 *     clientes; tiparlas sin revisar cada cliente podria perder datos sin error).
 * Un valor de otro tipo se descarta: asi una clave de conteo no puede traer un nombre.
 */
export type MetadataValueType = "string" | "number" | "uint" | "boolean" | "scalar";

/**
 * Claves de metadata que se guardan, con su tipo. Todo lo demas se descarta: la metadata no es
 * un lugar para texto libre, codigo ni datos personales.
 */
const METADATA_FIELDS: Readonly<Record<string, MetadataValueType>> = {
  trigger: "scalar",
  pageType: "scalar",
  pageContext: "scalar",
  applyMode: "scalar",
  linesChanged: "scalar",
  charsChanged: "scalar",
  line: "scalar",
  cached: "scalar",
  blocked: "scalar",
  scope: "scalar",
  mode: "scalar",
  reason: "scalar",
  source: "scalar",
  remaining: "scalar",
  maxLines: "scalar",
  allowed: "scalar",
  cacheNamespace: "scalar",
  worker: "scalar",
  ragSources: "scalar",
  stage: "scalar",
  feedback: "scalar",
  status: "scalar",
  provider: "scalar",
  retry: "scalar",
  view: "scalar",
  severity: "scalar",
  errors: "scalar",
  warnings: "scalar",
  // Senales de error y bloqueo de VS Code (A6.2) y fin del episodio (A3.3).
  errorCount: "scalar",
  blockingSeconds: "scalar",
  blockedForMs: "scalar",
  resolvedWhileAway: "scalar",
  // Donde corre VS Code: local (instalado, p. ej. Mac del laboratorio), tunnel,
  // codespaces o remote; y si la interfaz es desktop o web (vscode.dev).
  editorHost: "scalar",
  editorUi: "scalar",
  // Editor por tunel: el fallo fue una espera transitoria (VM apagada o
  // encendiendose) y la ventana siguio esperando; no es un fallo terminal.
  retryable: "scalar",
  // VS Code 0.0.34: accion que pidio el estudiante (insert o replace: codigo bajo
  // demanda, "mejorar la seleccion") y desde donde aplico (ventana flotante,
  // CodeLens, arreglo rapido...).
  requestedAction: "scalar",
  origin: "scalar",
  // VS Code 0.0.36, vscode_dependency_opened: familia de lenguaje del archivo (cpp, python, ...),
  // si la dependencia es implicita (mismo paquete sin import) y si traia un aviso.
  family: "scalar",
  implicit: "scalar",
  warning: "scalar",
  // Navegador 0.8.4, tunnel_vscode_extension_checked: la version de la extension de VS Code que
  // se vio en el editor, la publicada y el numero de este resultado en el aviso (1, 2 o 3).
  vscodeExtensionVersion: "scalar",
  latestVscodeExtensionVersion: "scalar",
  resultIndex: "scalar",
  // Navegador 0.8.5, tunnel_editor_account_switch: cuantas cuentas se cerraron en VS Code.
  signedOutCount: "scalar",
  // tutor_decision bloqueada (28-10-2026): por que no respondio el tutor (src/services/tutor/block-messages.ts).
  cause: "scalar",
  // tutor_decision de VS Code: otra sugerencia pedida sobre el mismo codigo antes de 2 min.
  repeated: "scalar",
  // tutor_decision de VS Code (30-10-2026): pedido explicito que el tutor respondio; sube la etapa
  // (countRecentExplicitEditorRequests).
  explicitRequest: "boolean",
  // vscode_diagram_opened (30-10-2026): cuantas clases tiene el diagrama del taller y cuantas van
  // hechas, a medias o faltan. Solo enteros: nunca nombres de clases ni de archivos.
  diagramClasses: "uint",
  classesDone: "uint",
  classesPartial: "uint",
  classesMissing: "uint",
};

/**
 * ¿Se guarda esta clave de metadata? Un solo espacio de nombres para todos los eventos: lo que
 * el catalogo promete (metadata.<clave>) tiene que estar aqui o se pierde sin error.
 */
export function isAllowedMetadataKey(key: string) {
  return Object.prototype.hasOwnProperty.call(METADATA_FIELDS, key);
}

/** Las claves de metadata que se guardan, con su tipo (para la lista de cumplimiento C03). */
export function listMetadataFields(): Array<{ key: string; type: MetadataValueType }> {
  return Object.entries(METADATA_FIELDS).map(([key, type]) => ({ key, type }));
}

/** El valor tal como se guarda, o undefined si no es del tipo de la clave. */
function metadataValue(type: MetadataValueType, value: unknown): string | number | boolean | undefined {
  const isNumber = typeof value === "number" && Number.isFinite(value);
  switch (type) {
    case "string":
      return typeof value === "string" ? value.slice(0, 120) : undefined;
    case "number":
      return isNumber ? value as number : undefined;
    case "uint":
      return isNumber && Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "scalar":
      if (isNumber || typeof value === "boolean") return value as number | boolean;
      return typeof value === "string" ? value.slice(0, 120) : undefined;
  }
}

function sanitizeMetadata(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isAllowedMetadataKey(key)) continue;
    const stored = metadataValue(METADATA_FIELDS[key], value);
    if (stored !== undefined) clean[key] = stored;
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

/**
 * Cliente sin sesion que cuenta para la alerta «sesiones de cliente sin
 * usuario» (monitor, limpieza del dataset): VS Code o el backend atendiendo a
 * VS Code. El overlay del navegador tambien manda eventos anonimos (se abre
 * antes de iniciar sesion, o queda con la sesion vencida tras otro login),
 * pero ese no es el caso que la alerta vigila; la regla D2 los excluye igual.
 */
export function isAnonymousEditorClient(row: Pick<TelemetryEventRow, "actorKind" | "source" | "channel">) {
  return row.actorKind === "client" && row.source !== "browser_extension" && row.channel !== "overlay";
}

/**
 * Un evento que solo escribe el servidor (tutor_decision, code_application_checked...) con la
 * fuente de un cliente (31-10-2026, CA-016): AppDatabase.insertTelemetryEvents no lo guarda. Es el
 * segundo freno, en el unico punto de escritura; el primero es POST /api/behavior/events. De esas
 * filas salen la etapa del tutor y los KPI P6 y P7.
 */
export function isForgedServerEvent(row: Pick<TelemetryEventRow, "eventType" | "source">) {
  return isServerOnlyEvent(row.eventType) && !(SERVER_ONLY_SOURCES as readonly string[]).includes(row.source);
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
    // Los pone el servidor (AppDatabase.insertTelemetryEvents); el cliente no puede fijarlos.
    pilotBlock: null,
    pilotCohort: "",
    pilotCondition: "",
  };
}

