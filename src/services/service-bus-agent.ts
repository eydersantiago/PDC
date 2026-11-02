import { randomUUID } from "node:crypto";
import { ServiceBusClient, type ServiceBusReceivedMessage } from "@azure/service-bus";
import { createServiceBusClient } from "./service-bus-client.js";
import { env } from "../config/env.js";
import {
  base64Stats,
  createDiagnosticLogger,
  durationMs,
  errorSummary,
  shortId,
  textStats,
  type DiagnosticLogger,
} from "./diagnostics.js";
import { trimText } from "./text-utils.js";
import { serializableGeneration, type TextGenerationOptions } from "./text-generation.js";
import { noteQueueJobFinished, noteQueueJobSent, noteQueueResult, noteQueueTimeout } from "./queue-health.js";
import { withDeadline } from "./queue-worker-policy.js";
import { aliveWorkerProgress } from "./worker-heartbeat.js";
import { isPartialMessage, parseQueueMessageBody, readPartialMessage } from "./queue-stream.js";

/** El job vencio sin que llegara un resultado (ningun worker lo respondio a tiempo). */
export class QueueTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueTimeoutError";
  }
}

export type QueueAgentJobKind = "text" | "image";

export type AgentRunDiagnostics = {
  requestId?: string;
  route?: string;
  scope?: string;
  cacheNamespace?: string;
  source?: string;
  telemetryId?: string;
};

export type QueueAgentJob = {
  schemaVersion: 1;
  jobId: string;
  kind: QueueAgentJobKind;
  inputText?: string;
  /**
   * Perfil de generacion del pedido de texto (temperatura, tope de salida, JSON). Un worker
   * anterior lo ignora y responde como antes.
   */
  generation?: TextGenerationOptions;
  /**
   * Respuesta en vivo (01-11-2026, solo texto): el worker publica el texto acumulado como
   * adaceen.partial en la sesion del resultado antes del adaceen.result (queue-stream.ts). Un
   * worker anterior lo ignora y manda solo el resultado.
   */
  stream?: boolean;
  prompt?: string;
  imageBase64?: string;
  imageMimeType?: string;
  imageName?: string;
  sharedSecret?: string;
  diagnostics?: AgentRunDiagnostics;
  requestedAt: string;
};

export type QueueAgentResult = {
  schemaVersion: 1;
  jobId: string;
  ok: boolean;
  outputText?: string;
  error?: string;
  workerId?: string;
  sharedSecret?: string;
  completedAt: string;
};

export function getServiceBusQueueConfig() {
  const missing = [];
  if (!env.serviceBusConnectionString) missing.push("AZURE_SERVICEBUS_CONNECTION_STRING");
  if (!env.jobsQueueName) missing.push("JOBS_QUEUE_NAME");
  if (!env.resultsQueueName) missing.push("RESULTS_QUEUE_NAME");

  return {
    configured: missing.length === 0,
    missing,
    jobsQueueName: env.jobsQueueName,
    resultsQueueName: env.resultsQueueName,
    timeoutMs: env.queueRequestTimeoutMs,
  };
}

export function ensureServiceBusQueueConfigured() {
  const config = getServiceBusQueueConfig();
  if (!config.configured) {
    throw new Error(`Modo queue no configurado. Faltan: ${config.missing.join(", ")}`);
  }
  return config;
}

function parseResultBody(message: ServiceBusReceivedMessage): QueueAgentResult {
  return parseQueueMessageBody(message.body) as QueueAgentResult;
}

function validateQueueResult(jobId: string, result: QueueAgentResult, sharedSecret = env.workerSharedSecret) {
  if (trimText(result.jobId) !== jobId) {
    throw new Error(`Resultado queue no coincide con jobId ${jobId}.`);
  }
  if (sharedSecret && result.sharedSecret !== sharedSecret) {
    throw new Error("Resultado queue rechazado: WORKER_SHARED_SECRET no coincide.");
  }
}

function messageSummary(message: ServiceBusReceivedMessage) {
  return {
    messageId: shortId(message.messageId, 64),
    correlationId: shortId(message.correlationId, 64),
    sessionId: shortId(message.sessionId, 64),
    subject: trimText(message.subject),
    contentType: trimText(message.contentType),
    deliveryCount: message.deliveryCount,
    enqueuedTimeUtc: message.enqueuedTimeUtc?.toISOString(),
    lockedUntilUtc: message.lockedUntilUtc?.toISOString(),
    applicationProperties: {
      kind: trimText(message.applicationProperties?.kind),
      requestId: shortId(message.applicationProperties?.requestId, 64),
      route: trimText(message.applicationProperties?.route),
      scope: trimText(message.applicationProperties?.scope),
    },
  };
}

/** Lo minimo del receptor de sesion que usa waitForQueueResult (para probarlo con uno falso). */
export type QueueSessionReceiver = {
  receiveMessages(maxMessageCount: number, options?: { maxWaitTimeInMs?: number }): Promise<ServiceBusReceivedMessage[]>;
  close(): Promise<void>;
};

/** Lo minimo del cliente: abrir la sesion del trabajo en la cola de resultados. */
export type QueueSessionClient = {
  acceptSession(queueName: string, sessionId: string, options: { receiveMode: "receiveAndDelete" }): Promise<QueueSessionReceiver>;
};

/**
 * Espera el resultado del trabajo en su sesion de la cola de resultados. Con onPartial (respuesta
 * en vivo, 01-11-2026) recibe en bucle: cada adaceen.partial valido (este jobId, el secreto, seq
 * mayor que el ultimo) llama onPartial con el texto acumulado; uno repetido, atrasado o de otro
 * trabajo se descarta. Cualquier otro mensaje es el resultado, como antes (un worker anterior solo
 * manda ese). El plazo total es el mismo: timeoutMs desde que se abre la sesion.
 */
export async function waitForQueueResult(
  client: QueueSessionClient,
  jobId: string,
  timeoutMs: number,
  logger: DiagnosticLogger,
  options: { onPartial?: (text: string) => void; resultsQueueName?: string; sharedSecret?: string } = {},
) {
  const startedAt = Date.now();
  const resultsQueueName = options.resultsQueueName ?? env.resultsQueueName;
  const sharedSecret = options.sharedSecret ?? env.workerSharedSecret;
  logger.info("queue.result.session.accept.start", {
    resultsQueueName,
    timeoutMs,
  });

  const receiver = await client.acceptSession(resultsQueueName, jobId, {
    receiveMode: "receiveAndDelete",
  });
  logger.info("queue.result.session.accept.done", {
    durationMs: durationMs(startedAt),
  });

  try {
    const waitStartedAt = Date.now();
    const deadline = waitStartedAt + timeoutMs;
    logger.info("queue.result.receive.start", {
      timeoutMs,
      stream: Boolean(options.onPartial),
    });
    let lastSeq = 0;
    let partials = 0;
    let ignored = 0;
    let message: ServiceBusReceivedMessage | undefined;
    for (;;) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      // De a uno: en receiveAndDelete el SDK devuelve apenas llega el primero.
      const messages = await receiver.receiveMessages(1, {
        maxWaitTimeInMs: remainingMs,
      });
      const received = messages[0];
      if (!received) break;
      if (!isPartialMessage(received)) {
        message = received;
        break;
      }
      const partial = readPartialMessage(received, { jobId, lastSeq, sharedSecret });
      if (!partial.ok || !options.onPartial) {
        ignored += 1;
        logger.debug("queue.partial.ignored", { reason: partial.ok ? "sin_stream" : partial.reason });
        continue;
      }
      lastSeq = partial.seq;
      partials += 1;
      if (partials === 1) {
        // Un parcial tambien dice que la cola llega al worker (queue-health.ts).
        noteQueueResult();
        logger.info("queue.partial.first", { durationMs: durationMs(waitStartedAt) });
      }
      try {
        options.onPartial(partial.text);
      } catch (error) {
        logger.warn("queue.partial.callback.failed", { error: errorSummary(error) });
      }
    }
    if (!message) {
      logger.warn("queue.result.receive.timeout", {
        durationMs: durationMs(waitStartedAt),
        timeoutMs,
        partials,
      });
      throw new QueueTimeoutError(`Timeout esperando respuesta queue (${Math.round(timeoutMs / 1000)}s).`);
    }

    logger.info("queue.result.receive.done", {
      durationMs: durationMs(waitStartedAt),
      message: messageSummary(message),
      ...(options.onPartial ? { partials, ignored } : {}),
    });
    const result = parseResultBody(message);
    validateQueueResult(jobId, result, sharedSecret);
    // Llego respuesta (aunque sea un error del worker): la cola llega al worker.
    noteQueueResult();
    logger.info("queue.result.validated", {
      ok: result.ok,
      workerId: trimText(result.workerId),
      completedAt: trimText(result.completedAt),
      output: textStats(result.outputText),
      error: result.error ? textStats(result.error) : undefined,
    });
    if (!result.ok) {
      throw new Error(result.error || "Worker local devolvio error sin detalle.");
    }
    return {
      outputText: trimText(result.outputText),
      workerId: trimText(result.workerId),
    };
  } finally {
    await receiver.close().catch((error) => {
      logger.warn("queue.result.receiver.close.failed", {
        error: errorSummary(error),
      });
    });
  }
}

/**
 * Variante que conserva el workerId del resultado. runQueueAgentJob se
 * mantiene como envoltorio para no tocar a los llamadores que solo
 * necesitan el texto.
 */
export async function runQueueAgentJobDetailed(input: {
  kind: QueueAgentJobKind;
  inputText?: string;
  generation?: TextGenerationOptions;
  prompt?: string;
  imageBase64?: string;
  imageMimeType?: string;
  imageName?: string;
  timeoutMs?: number;
  diagnostics?: AgentRunDiagnostics;
  /** Canario de salud de la cola (queue-health.ts): no cuenta como pedido de un usuario. */
  canary?: boolean;
  /**
   * Respuesta en vivo (01-11-2026, solo texto): el job sale con stream: true y onPartial recibe el
   * texto acumulado que publica el worker. Con un worker anterior solo llega el resultado.
   */
  onPartial?: (text: string) => void;
}) {
  const jobId = randomUUID();
  const startedAt = Date.now();
  const logger = createDiagnosticLogger("service-bus-agent", {
    jobId,
    kind: input.kind,
    requestId: shortId(input.diagnostics?.requestId, 64),
    route: trimText(input.diagnostics?.route),
    scope: trimText(input.diagnostics?.scope),
    jobsQueueName: env.jobsQueueName,
    resultsQueueName: env.resultsQueueName,
  });
  let client: ServiceBusClient | null = null;
  let sender: ReturnType<ServiceBusClient["createSender"]> | null = null;

  const stream = input.kind === "text" && typeof input.onPartial === "function";
  // Despues de devolver (o del plazo propio de abajo) ningun parcial atrasado llega a quien llamo.
  let settled = false;
  const onPartial = stream
    ? (text: string) => {
      if (!settled) input.onPartial!(text);
    }
    : undefined;
  const body: QueueAgentJob = {
    schemaVersion: 1,
    jobId,
    kind: input.kind,
    inputText: input.inputText,
    ...(serializableGeneration(input.generation) ? { generation: serializableGeneration(input.generation) } : {}),
    ...(stream ? { stream: true } : {}),
    prompt: input.prompt,
    imageBase64: input.imageBase64,
    imageMimeType: input.imageMimeType,
    imageName: input.imageName,
    sharedSecret: env.workerSharedSecret || undefined,
    diagnostics: input.diagnostics,
    requestedAt: new Date().toISOString(),
  };

  const ticket = noteQueueJobSent({ progress: aliveWorkerProgress(), canary: input.canary === true });
  try {
    const config = ensureServiceBusQueueConfigured();
    const timeoutMs = Math.max(1000, input.timeoutMs || config.timeoutMs);
    client = createServiceBusClient(env.serviceBusConnectionString);
    sender = client.createSender(env.jobsQueueName);
    logger.info("queue.job.start", {
      timeoutMs,
      inputText: textStats(input.inputText),
      prompt: textStats(input.prompt),
      imageBase64: input.imageBase64 ? base64Stats(input.imageBase64) : undefined,
      imageMimeType: trimText(input.imageMimeType),
      imageName: trimText(input.imageName),
      diagnostics: input.diagnostics || {},
    });
    const sendStartedAt = Date.now();
    logger.info("queue.job.send.start", {
      contentType: "application/json",
      bodyEncoding: "json-string",
      body: textStats(JSON.stringify(body)),
      subject: `adaceen.${input.kind}`,
    });
    await sender.sendMessages({
      body: JSON.stringify(body),
      messageId: jobId,
      correlationId: jobId,
      contentType: "application/json",
      subject: `adaceen.${input.kind}`,
      // Nadie leera un resultado despues del timeout: Service Bus expira el job por si mismo.
      timeToLive: timeoutMs,
      applicationProperties: {
        kind: input.kind,
        requestId: input.diagnostics?.requestId || "",
        route: input.diagnostics?.route || "",
        scope: input.diagnostics?.scope || "",
      },
    });
    logger.info("queue.job.send.done", {
      durationMs: durationMs(sendStartedAt),
    });

    // Plazo propio (examen 28-10): si acceptSession o receiveMessages se cuelgan, el pedido no queda
    // esperando para siempre ni deja el contador de pedidos en curso arriba (sin canario).
    const result = await withDeadline(
      waitForQueueResult(client, jobId, timeoutMs, logger, { onPartial }),
      timeoutMs + 30_000,
      `Timeout esperando respuesta queue (${Math.round(timeoutMs / 1000)}s, sin respuesta de Service Bus).`,
    ).catch((error) => {
      if (error instanceof Error && !(error instanceof QueueTimeoutError) && /sin respuesta de Service Bus/.test(error.message)) {
        throw new QueueTimeoutError(error.message);
      }
      throw error;
    });
    logger.info("queue.job.done", {
      durationMs: durationMs(startedAt),
      output: textStats(result.outputText),
      workerId: result.workerId,
    });
    return result;
  } catch (error) {
    if (error instanceof QueueTimeoutError) {
      const deaf = noteQueueTimeout(ticket, { progressNow: aliveWorkerProgress() });
      if (deaf) {
        logger.warn("queue.deaf.suspected", {
          detail: "ningun worker tomo el job y su contador no avanzo: los pedidos fallan rapido hasta que la cola responda",
        });
      }
    }
    logger.error("queue.job.failed", {
      durationMs: durationMs(startedAt),
      error: errorSummary(error),
    });
    throw error;
  } finally {
    settled = true;
    noteQueueJobFinished(ticket);
    await sender?.close().catch((error) => {
      logger.warn("queue.sender.close.failed", {
        error: errorSummary(error),
      });
    });
    await client?.close().catch((error) => {
      logger.warn("queue.client.close.failed", {
        error: errorSummary(error),
      });
    });
  }
}

export async function runQueueAgentJob(
  input: Parameters<typeof runQueueAgentJobDetailed>[0],
) {
  const result = await runQueueAgentJobDetailed(input);
  return result.outputText;
}
