// Salud de la cola vista desde el backend (examen 28-10-2026).
//
// Lo que paso el 27-10 a las 7 p. m.: la V100 seguia mandando latidos (el backend la daba por
// viva) pero no tomo 7 jobs seguidos. Cada estudiante espero los 120 s completos del timeout y
// el tutor dijo «no disponible» al final. El latido va por HTTP y los jobs por Service Bus: un
// enlace AMQP colgado no se nota en el latido.
//
// Aqui se distingue «la GPU esta ocupada» de «la cola no llega al worker»:
//   - Un job que vence sin respuesta mientras ningun worker vivo avanzo (su jobsProcessed, que viene
//     en el latido, no subio; ni se reinicio ni aparecio otro) y ningun otro job respondio desde que
//     se envio: la cola esta sorda. Si alguno avanzo, era carga, no sordera.
//   - Con la cola sorda, los pedidos fallan rapido (InferenceUnavailableError: quien llama usa
//     su respaldo) durante SUSPECT_WINDOW_MS como mucho. Se cierra antes si un job responde o
//     si el contador de los workers avanza (el worker reconecta solo cada 4 min sin mensajes).
//   - Un canario (job de texto minimo, sin estudiante detras) prueba la cola cuando esta
//     sospechosa o cuando lleva un rato sin respuestas en plena clase; asi el primer estudiante
//     de una pausa no es quien descubre la sordera. Solo corre si hubo pedidos reales en la
//     ultima media hora, para no mantener encendida la GPU fuera de clase (el apagado por
//     inactividad cuenta los jobs).
//
// Todo vive en memoria del App Service (una instancia), como el registro de latidos.

/** Cuanto dura como maximo la falla rapida sin una prueba que la confirme. */
export const SUSPECT_WINDOW_MS = 3 * 60_000;
/** Plazo del canario: el modelo cargado responde en menos de 2 s; frio, en ~25 s. */
export const CANARY_TIMEOUT_MS = 45_000;
/** Sin respuestas de la cola en este tiempo (en clase), el canario la prueba. */
export const CANARY_QUIET_MS = 3 * 60_000;
/** El canario solo corre si hubo un pedido real en este tiempo. */
export const CANARY_ACTIVE_WINDOW_MS = 30 * 60_000;
/** Cada cuanto se revisa si toca un canario. */
export const CANARY_TICK_MS = 60_000;

type State = {
  lastSuccessMs: number;
  lastUserRequestMs: number;
  suspectSinceMs: number;
  /** Progreso de los workers vivos cuando se abrio la sospecha. */
  suspectProgress: WorkerProgressSnapshot | null;
  inFlightUser: number;
  canaryRunning: boolean;
  lastCanaryMs: number;
  lastCanaryOk: boolean | null;
  timeoutsWhileDeaf: number;
};

const state: State = {
  lastSuccessMs: 0,
  lastUserRequestMs: 0,
  suspectSinceMs: 0,
  suspectProgress: null,
  inFlightUser: 0,
  canaryRunning: false,
  lastCanaryMs: 0,
  lastCanaryOk: null,
  timeoutsWhileDeaf: 0,
};

export type QueueJobTicket = {
  sentAtMs: number;
  /** Progreso de los workers vivos al enviar (null si no hay latidos). */
  progressAtSend: WorkerProgressSnapshot | null;
  canary: boolean;
};

/** Foto del progreso de los workers vivos (worker-heartbeat.ts): id -> (startedAt, jobs). */
export type WorkerProgressSnapshot = Record<string, { startedAt: string | null; jobs: number }>;

/**
 * Si algun worker avanzo entre dos fotos: proceso mas trabajos, se reinicio (otro startedAt) o
 * aparecio uno nuevo. Que un worker deje de estar vivo no cuenta como avance.
 */
export function workersAdvanced(before: WorkerProgressSnapshot | null, after: WorkerProgressSnapshot | null) {
  if (!before || !after) return false;
  for (const [id, now] of Object.entries(after)) {
    const then = Object.hasOwn(before, id) ? before[id] : undefined;
    if (!then) return true;
    if (then.startedAt !== now.startedAt) return true;
    if (now.jobs > then.jobs) return true;
  }
  return false;
}

/** Al enviar un job: se toma la foto del progreso de los workers. */
export function noteQueueJobSent(input: { nowMs?: number; progress: WorkerProgressSnapshot | null; canary?: boolean }): QueueJobTicket {
  const nowMs = input.nowMs ?? Date.now();
  const canary = input.canary === true;
  if (!canary) {
    state.lastUserRequestMs = nowMs;
    state.inFlightUser += 1;
  }
  return { sentAtMs: nowMs, progressAtSend: input.progress, canary };
}

/** El job termino (con resultado, error del worker o vencido); libera el contador de en curso. */
export function noteQueueJobFinished(ticket: QueueJobTicket) {
  if (!ticket.canary) state.inFlightUser = Math.max(0, state.inFlightUser - 1);
}

/** Llego un resultado (ok o error del worker): la cola llega al worker. */
export function noteQueueResult(nowMs = Date.now()) {
  state.lastSuccessMs = nowMs;
  state.suspectSinceMs = 0;
  state.suspectProgress = null;
  state.timeoutsWhileDeaf = 0;
}

/**
 * Un job vencio sin respuesta. Abre la sospecha solo si nadie respondio desde que se envio y ningun
 * worker vivo avanzo (sin latidos no se sabe: no se abre).
 */
export function noteQueueTimeout(ticket: QueueJobTicket, input: { nowMs?: number; progressNow: WorkerProgressSnapshot | null }) {
  const nowMs = input.nowMs ?? Date.now();
  if (state.lastSuccessMs >= ticket.sentAtMs) return false;
  if (!ticket.progressAtSend || !input.progressNow) return false;
  if (workersAdvanced(ticket.progressAtSend, input.progressNow)) return false;
  if (!state.suspectSinceMs) {
    state.suspectSinceMs = nowMs;
    state.suspectProgress = input.progressNow;
  }
  state.timeoutsWhileDeaf += 1;
  return true;
}

/**
 * Si los pedidos deben fallar rapido ahora. Se cierra sola al pasar SUSPECT_WINDOW_MS (se vuelve
 * a intentar normal) o si algun worker avanzo desde que se abrio.
 */
export function isQueueSuspect(input: { nowMs?: number; progressNow: WorkerProgressSnapshot | null } = { progressNow: null }) {
  const nowMs = input.nowMs ?? Date.now();
  if (!state.suspectSinceMs) return false;
  if (nowMs - state.suspectSinceMs >= SUSPECT_WINDOW_MS || workersAdvanced(state.suspectProgress, input.progressNow)) {
    state.suspectSinceMs = 0;
    state.suspectProgress = null;
    return false;
  }
  return true;
}

/** Si toca mandar un canario ahora. */
export function shouldSendCanary(input: { nowMs?: number; aliveWorkers: number }) {
  const nowMs = input.nowMs ?? Date.now();
  if (input.aliveWorkers <= 0 || state.canaryRunning) return false;
  if (state.inFlightUser > 0) return false;
  if (!state.lastUserRequestMs || nowMs - state.lastUserRequestMs > CANARY_ACTIVE_WINDOW_MS) return false;
  if (state.suspectSinceMs) return true;
  const lastSignal = Math.max(state.lastSuccessMs, state.lastCanaryMs);
  return nowMs - lastSignal >= CANARY_QUIET_MS;
}

export function noteCanaryStart(nowMs = Date.now()) {
  state.canaryRunning = true;
  state.lastCanaryMs = nowMs;
}

export function noteCanaryEnd(ok: boolean) {
  state.canaryRunning = false;
  state.lastCanaryOk = ok;
}

export function describeQueueHealth(nowMs = Date.now()) {
  return {
    queue_suspect: Boolean(state.suspectSinceMs) && nowMs - state.suspectSinceMs < SUSPECT_WINDOW_MS,
    queue_suspect_since: state.suspectSinceMs ? new Date(state.suspectSinceMs).toISOString() : null,
    queue_last_result_at: state.lastSuccessMs ? new Date(state.lastSuccessMs).toISOString() : null,
    queue_last_canary_at: state.lastCanaryMs ? new Date(state.lastCanaryMs).toISOString() : null,
    queue_last_canary_ok: state.lastCanaryOk,
    queue_in_flight: state.inFlightUser,
  };
}

export function resetQueueHealthForTests() {
  state.lastSuccessMs = 0;
  state.lastUserRequestMs = 0;
  state.suspectSinceMs = 0;
  state.suspectProgress = null;
  state.inFlightUser = 0;
  state.canaryRunning = false;
  state.lastCanaryMs = 0;
  state.lastCanaryOk = null;
  state.timeoutsWhileDeaf = 0;
}
