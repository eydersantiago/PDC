// Respuesta del tutor en vivo por la cola (01-11-2026): el worker publica el texto que el modelo
// lleva escrito en la misma sesion del resultado, y el backend lo reenvia a VS Code mientras espera
// el resultado de siempre. Modulo sin Service Bus ni env: lo usan el worker
// (scripts/service-bus-ollama-worker.ts) y el backend (service-bus-agent.ts), y se prueba solo.
//
// Mensajes en la cola de resultados (sesion = correlationId = jobId):
//   adaceen.partial  { schemaVersion: 1, jobId, seq, partialText, workerId, sharedSecret }
//                    texto ACUMULADO (no el pedazo nuevo), a lo sumo uno cada ~500 ms, TTL corto;
//                    messageId `${jobId}:p${seq}`.
//   adaceen.result   el QueueAgentResult de siempre, el ultimo.
// Solo si el job trae stream: true (un backend anterior no lo pone y nunca recibe parciales). Un
// worker anterior ignora el campo y manda solo el resultado: el backend espera igual.
import type { ServiceBusMessage, ServiceBusReceivedMessage } from "@azure/service-bus";
import type { QueueAgentResult } from "./service-bus-agent.js";

export const QUEUE_PARTIAL_SUBJECT = "adaceen.partial";
export const QUEUE_RESULT_SUBJECT = "adaceen.result";
/** Como mucho un parcial por este intervalo (por trabajo). */
export const QUEUE_PARTIAL_INTERVAL_MS = 500;
/** Un parcial solo sirve mientras el backend espera: si nadie lo lee, que expire pronto. */
export const QUEUE_PARTIAL_TIME_TO_LIVE_MS = 60_000;
/**
 * Tope del texto de un parcial: los mensajes de Service Bus tienen 256 KB (Standard). Pasado el
 * tope no se publican mas parciales: el resultado trae todo.
 */
export const QUEUE_PARTIAL_MAX_CHARS = 60_000;
/** Lo que espera stop() a un parcial que se esta enviando antes de mandar el resultado. */
const STOP_WAIT_MS = 5_000;

export type QueueAgentPartial = {
  schemaVersion: 1;
  jobId: string;
  /** 1, 2, 3...: el backend descarta uno repetido o que llega fuera de orden. */
  seq: number;
  /** Todo lo que el modelo lleva escrito. */
  partialText: string;
  workerId?: string;
  sharedSecret?: string;
};

/** Lo minimo de un sender de Service Bus que usa este modulo (para probarlo con uno falso). */
export type QueueMessageSender = {
  sendMessages(message: ServiceBusMessage): Promise<void>;
};

export function buildPartialMessage(input: {
  jobId: string;
  seq: number;
  partialText: string;
  workerId?: string;
  sharedSecret?: string;
  timeToLiveMs?: number;
}): ServiceBusMessage {
  const body: QueueAgentPartial = {
    schemaVersion: 1,
    jobId: input.jobId,
    seq: input.seq,
    partialText: input.partialText,
    workerId: input.workerId || undefined,
    sharedSecret: input.sharedSecret || undefined,
  };
  return {
    body: JSON.stringify(body),
    messageId: `${input.jobId}:p${input.seq}`,
    correlationId: input.jobId,
    sessionId: input.jobId,
    contentType: "application/json",
    subject: QUEUE_PARTIAL_SUBJECT,
    timeToLive: input.timeToLiveMs ?? QUEUE_PARTIAL_TIME_TO_LIVE_MS,
  };
}

/** El resultado de siempre (el mismo mensaje que mandaba el worker antes del 01-11-2026). */
export function buildResultMessage(body: QueueAgentResult, timeToLiveMs: number): ServiceBusMessage {
  return {
    body: JSON.stringify(body),
    messageId: `${body.jobId}:result`,
    correlationId: body.jobId,
    sessionId: body.jobId,
    contentType: "application/json",
    subject: QUEUE_RESULT_SUBJECT,
    // El resultado puede citar codigo del estudiante (A7.5): si el API ya no lo
    // espera, que expire en vez de quedarse hasta el TTL por defecto de la cola.
    timeToLive: timeToLiveMs,
  };
}

/** El cuerpo de un mensaje de la cola como objeto (string JSON, bytes o ya objeto). */
export function parseQueueMessageBody(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !(body instanceof Uint8Array)) return body as Record<string, unknown>;
  if (typeof body === "string") return JSON.parse(body) as Record<string, unknown>;
  if (body instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  throw new Error("Mensaje de la cola invalido: body no reconocido.");
}

/** El job pide la respuesta en vivo: solo de texto y con stream: true (un backend anterior no lo pone). */
export function jobWantsStream(job: { kind?: unknown; stream?: unknown }) {
  return job.kind === "text" && job.stream === true;
}

export function isPartialMessage(message: Pick<ServiceBusReceivedMessage, "subject">) {
  return String(message.subject || "").trim() === QUEUE_PARTIAL_SUBJECT;
}

/**
 * Un parcial valido de este trabajo, o por que se descarta: otro jobId, el secreto no coincide,
 * seq repetido o fuera de orden (no mayor que el ultimo aceptado), o sin texto.
 */
export function readPartialMessage(
  message: Pick<ServiceBusReceivedMessage, "body">,
  expected: { jobId: string; lastSeq: number; sharedSecret?: string },
): { ok: true; seq: number; text: string } | { ok: false; reason: "invalido" | "otro_job" | "secreto" | "repetido" } {
  let body: Record<string, unknown>;
  try {
    body = parseQueueMessageBody(message.body);
  } catch {
    return { ok: false, reason: "invalido" };
  }
  if (String(body.jobId ?? "").trim() !== expected.jobId) return { ok: false, reason: "otro_job" };
  if (expected.sharedSecret && body.sharedSecret !== expected.sharedSecret) return { ok: false, reason: "secreto" };
  const seq = Number(body.seq);
  if (!Number.isSafeInteger(seq) || seq <= 0 || typeof body.partialText !== "string") return { ok: false, reason: "invalido" };
  if (seq <= expected.lastSeq) return { ok: false, reason: "repetido" };
  return { ok: true, seq, text: body.partialText };
}

type TimerHandle = unknown;

export type PartialPublisherOptions = {
  /** Manda el parcial numero seq con el texto acumulado. */
  send: (seq: number, text: string) => Promise<void>;
  intervalMs?: number;
  /** Tras tantos fallos seguidos deja de publicar (el trabajo sigue). */
  maxFailures?: number;
  onError?: (error: unknown, failures: number) => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
};

/**
 * Publica el texto acumulado con un tope de frecuencia: el primero sale enseguida y despues, como
 * mucho, uno por intervalo (siempre el ultimo texto; los intermedios se saltan). Nunca dos envios
 * a la vez, asi que llegan en orden. Un fallo al enviar no lanza: se cuenta y, tras maxFailures
 * seguidos, deja de publicar. stop() cancela lo pendiente y espera (con tope) el envio en curso,
 * para que el resultado salga despues del ultimo parcial.
 */
export function createPartialPublisher(options: PartialPublisherOptions) {
  const intervalMs = Math.max(0, options.intervalMs ?? QUEUE_PARTIAL_INTERVAL_MS);
  const maxFailures = Math.max(1, options.maxFailures ?? 5);
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: TimerHandle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let latest = "";
  let published = "";
  let seq = 0;
  let sent = 0;
  let failures = 0;
  let totalFailures = 0;
  let lastSendAt = Number.NEGATIVE_INFINITY;
  let timer: TimerHandle | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  const flush = () => {
    timer = null;
    if (stopped || inFlight || !latest || latest === published) return;
    const text = latest;
    seq += 1;
    lastSendAt = now();
    let attempt: Promise<void>;
    try {
      attempt = Promise.resolve(options.send(seq, text));
    } catch (error) {
      attempt = Promise.reject(error);
    }
    inFlight = attempt.then(
      () => {
        sent += 1;
        failures = 0;
      },
      (error) => {
        failures += 1;
        totalFailures += 1;
        try {
          options.onError?.(error, failures);
        } catch {
          // El aviso no puede tumbar el trabajo.
        }
        if (failures >= maxFailures) stopped = true;
      },
    ).finally(() => {
      // El texto no se reintenta: el siguiente parcial (o el resultado) ya lo trae.
      published = text;
      inFlight = null;
      schedule();
    });
  };

  const schedule = () => {
    if (stopped || timer !== null || inFlight || !latest || latest === published) return;
    const wait = Math.max(0, lastSendAt + intervalMs - now());
    if (wait === 0) {
      flush();
    } else {
      timer = setTimer(flush, wait);
    }
  };

  return {
    push(text: string) {
      if (stopped) return;
      latest = String(text ?? "");
      schedule();
    },
    async stop() {
      stopped = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      if (inFlight) {
        let waitTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          inFlight,
          new Promise<void>((resolve) => {
            waitTimer = setTimeout(resolve, STOP_WAIT_MS);
          }),
        ]);
        if (waitTimer) clearTimeout(waitTimer);
      }
      return { sent, failures: totalFailures };
    },
  };
}

type PartialLogger = {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
};

/**
 * Corre un trabajo de texto con parciales (job.stream): `run` recibe a quien avisar con el texto
 * acumulado y devuelve el texto final. Los parciales salen por `sender` con su tope de frecuencia;
 * al terminar (bien o mal) se detienen antes de devolver, asi el resultado que el worker manda
 * despues es el ultimo mensaje de la sesion. Un parcial que no se pudo mandar no cambia nada.
 */
export async function runTextJobWithPartials(input: {
  jobId: string;
  sender: QueueMessageSender;
  run: (onText: (accumulatedText: string) => void) => Promise<string>;
  workerId?: string;
  sharedSecret?: string;
  intervalMs?: number;
  timeToLiveMs?: number;
  logger?: PartialLogger;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}) {
  const publisher = createPartialPublisher({
    intervalMs: input.intervalMs,
    now: input.now,
    setTimer: input.setTimer,
    clearTimer: input.clearTimer,
    send: (seq, text) => input.sender.sendMessages(buildPartialMessage({
      jobId: input.jobId,
      seq,
      partialText: text,
      workerId: input.workerId,
      sharedSecret: input.sharedSecret,
      timeToLiveMs: input.timeToLiveMs,
    })),
    onError: (error, failures) => {
      if (failures === 1 || failures % 10 === 0) {
        input.logger?.warn("queue.partial.send.failed", {
          failures,
          error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : String(error).slice(0, 300),
        });
      }
    },
  });
  try {
    return await input.run((text) => {
      if (text.length <= QUEUE_PARTIAL_MAX_CHARS) publisher.push(text);
    });
  } finally {
    const stats = await publisher.stop();
    input.logger?.info("queue.partial.done", stats);
  }
}
