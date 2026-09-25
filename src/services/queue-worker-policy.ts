import { trimText } from "./text-utils.js";

/**
 * Reglas puras del worker de Service Bus: decidir si un job sigue vigente,
 * si un error merece reintento en otro worker y como liquidar el mensaje.
 * Se mantienen sin dependencias del SDK para poder probarlas en aislamiento.
 */

/** Error de validacion del job: nunca se reintenta, se manda a dead-letter. */
export class JobValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobValidationError";
  }
}

export type JobSettlement = "complete" | "abandon" | "deadLetter";

export type JobFailureDecision = {
  settlement: JobSettlement;
  /** true cuando este worker debe responder el error al backend; false cuando deja el job a otro worker. */
  sendResult: boolean;
  reason: "validation" | "retry" | "attempts_exhausted" | "not_retriable";
};

const RETRIABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const RETRIABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const RETRIABLE_MESSAGE = /fetch failed|socket hang up|network error|connection error|timed? ?out|out of memory|cuda|vram|gpu memory|model .* not (?:found|loaded)|(?:HTTP|status) (?:408|429|50[0234])\b/i;

function readNumeric(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Un error es reintentable cuando apunta a un problema transitorio del worker
 * (Ollama caido, red, sin memoria) y no a un job invalido. En esos casos otro
 * worker con mas recursos puede completar el job.
 */
export function isRetriableJobError(error: unknown): boolean {
  if (error instanceof JobValidationError) return false;
  if (!(error instanceof Error)) return false;

  const extra = error as Error & { code?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown };
  const code = trimText(extra.code).toUpperCase();
  if (code && RETRIABLE_CODES.has(code)) return true;

  const status = readNumeric(extra.status) ?? readNumeric(extra.statusCode);
  if (status !== undefined && RETRIABLE_STATUS.has(status)) return true;

  if (RETRIABLE_MESSAGE.test(error.message)) return true;

  if (extra.cause && extra.cause !== error) {
    return isRetriableJobError(extra.cause);
  }
  return false;
}

export function decideJobFailure(input: {
  error: unknown;
  deliveryCount: number | undefined;
  maxAttempts: number;
}): JobFailureDecision {
  if (input.error instanceof JobValidationError) {
    return { settlement: "deadLetter", sendResult: true, reason: "validation" };
  }
  if (!isRetriableJobError(input.error)) {
    return { settlement: "complete", sendResult: true, reason: "not_retriable" };
  }
  const attempts = Math.max(1, input.deliveryCount ?? 1);
  if (attempts >= Math.max(1, input.maxAttempts)) {
    return { settlement: "complete", sendResult: true, reason: "attempts_exhausted" };
  }
  return { settlement: "abandon", sendResult: false, reason: "retry" };
}

function parseTimestamp(value: unknown) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : undefined;
  }
  const text = trimText(value);
  if (!text) return undefined;
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : undefined;
}

/**
 * El backend espera la respuesta como maximo `timeoutMs` desde que publico el job.
 * Si el worker recibe el job despues de esa ventana (por ejemplo tras estar
 * apagado), nadie va a leer el resultado: se descarta para no bloquear jobs nuevos.
 */
export function isJobStale(input: {
  requestedAt?: unknown;
  enqueuedTimeUtc?: unknown;
  timeoutMs: number;
  now?: number;
}) {
  const startedAt = parseTimestamp(input.requestedAt) ?? parseTimestamp(input.enqueuedTimeUtc);
  if (startedAt === undefined || !(input.timeoutMs > 0)) return false;
  const now = input.now ?? Date.now();
  return now - startedAt > input.timeoutMs;
}

/**
 * Ventana de renovacion automatica del lock. Debe cubrir al menos el tiempo que
 * el backend espera, mas margen, para que un job lento no se re-entregue a otro
 * worker mientras todavia se esta procesando.
 */
export function resolveLockRenewalMs(input: { requestTimeoutMs: number; configuredMs?: number }) {
  const minimum = Math.max(60_000, input.requestTimeoutMs + 30_000);
  const configured = input.configuredMs;
  if (configured !== undefined && Number.isFinite(configured) && configured > 0) {
    return Math.max(minimum, configured);
  }
  return minimum;
}

/**
 * Tipos de job que acepta un worker (QUEUE_WORKER_KINDS). Una Mac sin modelo
 * de vision puede declarar solo "text": los jobs de imagen los libera para
 * que los tome otro worker.
 */
export type WorkerJobKind = "text" | "image";

export function parseWorkerKinds(values: string[] | string | undefined): Set<WorkerJobKind> {
  const list = Array.isArray(values) ? values : String(values || "").split(",");
  const kinds = new Set<WorkerJobKind>();
  for (const value of list) {
    const clean = trimText(value).toLowerCase();
    if (clean === "text" || clean === "image") kinds.add(clean);
  }
  return kinds.size ? kinds : new Set<WorkerJobKind>(["text", "image"]);
}

export function isJobKindSupported(kind: unknown, kinds: Set<WorkerJobKind>) {
  return kinds.has(String(kind) as WorkerJobKind);
}

/**
 * Como espera jobs el worker (QUEUE_WORKER_PRIORITY).
 *
 * - normal: espera en la cola hasta 5 s por llamada; compite de igual a igual.
 * - backup (o respaldo): pide un job con una espera corta y, si no hay, descansa
 *   QUEUE_WORKER_BACKUP_IDLE_MS. Mientras otro worker este libre (siempre
 *   esperando en la cola), casi todos los jobs le llegan a el; los de respaldo
 *   toman los que se acumulan cuando los demas estan ocupados o apagados.
 */
export function resolveReceivePlan(priority: string | undefined, backupIdleMs: number) {
  const clean = trimText(priority).toLowerCase();
  if (clean === "backup" || clean === "respaldo") {
    return { backup: true, maxWaitTimeInMs: 1000, idleDelayMs: Math.max(500, backupIdleMs) };
  }
  return { backup: false, maxWaitTimeInMs: 5000, idleDelayMs: 0 };
}
