import dotenv from "dotenv";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ServiceBusClient, type ServiceBusReceivedMessage } from "@azure/service-bus";
import type { QueueAgentJob, QueueAgentResult } from "../src/services/service-bus-agent.js";
import {
  base64Stats,
  createDiagnosticLogger,
  durationMs,
  errorSummary,
  shortId,
  textStats,
  type DiagnosticLogger,
} from "../src/services/diagnostics.js";
import {
  JobValidationError,
  decideJobFailure,
  isJobStale,
  resolveLockRenewalMs,
  type JobFailureDecision,
} from "../src/services/queue-worker-policy.js";
import { trimText } from "../src/services/text-utils.js";

dotenv.config();
dotenv.config({ path: ".env.worker", override: true });

const [{ runImage }, { runText }, { env }, { ensureServiceBusQueueConfigured }] = await Promise.all([
  import("../runImage.js"),
  import("../runText.js"),
  import("../src/config/env.js"),
  import("../src/services/service-bus-agent.js"),
]);

type Receiver = ReturnType<ServiceBusClient["createReceiver"]>;
type Sender = ReturnType<ServiceBusClient["createSender"]>;

/** El API espera un resultado a lo sumo QUEUE_REQUEST_TIMEOUT_MS; se deja el doble de margen. */
function resultTimeToLiveMs() {
  return Math.max(60_000, env.queueRequestTimeoutMs * 2);
}
type MessageOutcome = "processed" | "retry" | "stale";

const RECONNECT_DELAY_MS = 5000;

/**
 * Latido hacia el API (A15.4): cada WORKER_HEARTBEAT_INTERVAL_MS el worker
 * avisa que sigue escuchando la cola. Sin WORKER_HEARTBEAT_URL no hace nada.
 * Un fallo del latido nunca detiene al worker.
 */
function startHeartbeat(input: {
  workerId: string;
  model: string;
  stats: { jobsProcessed: number; lastJobAt: string | null };
  logger: ReturnType<typeof createDiagnosticLogger>;
}) {
  const url = trimText(process.env.WORKER_HEARTBEAT_URL);
  const token = trimText(process.env.WORKER_HEARTBEAT_TOKEN);
  if (!url || !token) {
    input.logger.info("worker.heartbeat.disabled", { reason: url ? "sin token" : "sin url" });
    return () => {};
  }
  const intervalMs = Math.max(5000, Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS) || 30000);
  const startedAt = new Date().toISOString();
  let failures = 0;
  const beat = async () => {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-worker-token": token },
        body: JSON.stringify({
          workerId: input.workerId,
          model: input.model,
          jobsProcessed: input.stats.jobsProcessed,
          lastJobAt: input.stats.lastJobAt,
          startedAt,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (failures > 0) input.logger.info("worker.heartbeat.recovered", { failures });
      failures = 0;
    } catch (error) {
      failures += 1;
      // Solo se registra el primero y luego cada 10 para no llenar el log.
      if (failures === 1 || failures % 10 === 0) {
        input.logger.warn("worker.heartbeat.failed", { failures, error: errorSummary(error) });
      }
    }
  };
  void beat();
  const timer = setInterval(() => { void beat(); }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
const processLog = createDiagnosticLogger("queue-worker");

let stopping = false;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorDetail(error: unknown) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function isAmqpCloseTimeout(error: unknown) {
  const detail = errorDetail(error);
  return /OperationTimeoutError/i.test(detail)
    && /Unable to close (?:the receiver|the amqp session)|operation timeout/i.test(detail);
}

process.on("unhandledRejection", (reason) => {
  const detail = errorDetail(reason);
  if (isAmqpCloseTimeout(reason)) {
    processLog.warn("worker.unhandled_rejection.ignored", {
      error: errorSummary(reason),
    });
    console.warn(`[queue-worker] Timeout cerrando enlace AMQP; se ignora para mantener el worker vivo: ${detail}`);
    return;
  }

  processLog.error("worker.unhandled_rejection", {
    error: errorSummary(reason),
  });
  console.error(`[queue-worker] Rechazo no manejado: ${detail}`);
});

function parseJobBody(message: ServiceBusReceivedMessage): QueueAgentJob {
  const body = message.body;
  try {
    if (body && typeof body === "object" && !(body instanceof Uint8Array)) {
      return body as QueueAgentJob;
    }
    if (typeof body === "string") {
      return JSON.parse(body) as QueueAgentJob;
    }
    if (body instanceof Uint8Array) {
      return JSON.parse(new TextDecoder().decode(body)) as QueueAgentJob;
    }
  } catch (error) {
    throw new JobValidationError(`Job queue invalido: ${errorDetail(error)}`);
  }
  throw new JobValidationError("Job queue invalido: body no reconocido.");
}

function getWorkerId() {
  return trimText(process.env.QUEUE_WORKER_ID)
    || trimText(process.env.ADACEEN_QUEUE_WORKER_ID)
    || `${env.defaultScanWorkerId}-${os.hostname()}`;
}

function validateJob(job: QueueAgentJob) {
  if (job.schemaVersion !== 1) {
    throw new JobValidationError("schemaVersion no soportado.");
  }
  if (!trimText(job.jobId)) {
    throw new JobValidationError("jobId requerido.");
  }
  if (job.kind !== "text" && job.kind !== "image") {
    throw new JobValidationError(`kind no soportado: ${String(job.kind)}`);
  }
  if (env.workerSharedSecret && job.sharedSecret !== env.workerSharedSecret) {
    throw new JobValidationError("WORKER_SHARED_SECRET no coincide.");
  }
}

function jobSummary(job: QueueAgentJob) {
  return {
    schemaVersion: job.schemaVersion,
    jobId: shortId(job.jobId, 64),
    kind: job.kind,
    requestedAt: trimText(job.requestedAt),
    diagnostics: job.diagnostics || {},
    inputText: textStats(job.inputText),
    prompt: textStats(job.prompt),
    imageBase64: job.imageBase64 ? base64Stats(job.imageBase64) : undefined,
    imageMimeType: trimText(job.imageMimeType),
    imageName: trimText(job.imageName),
  };
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

async function runImageJob(job: QueueAgentJob) {
  const imageBase64 = trimText(job.imageBase64);
  if (!imageBase64) {
    throw new JobValidationError("imageBase64 requerido para job image.");
  }

  const extension = trimText(job.imageName).split(".").pop() || "png";
  const imagePath = path.join(os.tmpdir(), `adaceen-${job.jobId}.${extension}`);
  await fsp.writeFile(imagePath, Buffer.from(imageBase64, "base64"));

  try {
    return await runImage(imagePath, trimText(job.prompt), job.diagnostics);
  } finally {
    await fsp.unlink(imagePath).catch(() => {});
  }
}

async function processJob(job: QueueAgentJob) {
  validateJob(job);
  if (job.kind === "image") {
    return runImageJob(job);
  }

  const inputText = trimText(job.inputText);
  if (!inputText) {
    throw new JobValidationError("inputText requerido para job text.");
  }
  return runText(inputText, job.diagnostics);
}

async function sendResult(
  sender: Sender,
  jobId: string,
  result: Omit<QueueAgentResult, "schemaVersion" | "jobId" | "completedAt">,
  logger?: DiagnosticLogger,
) {
  const startedAt = Date.now();
  const body: QueueAgentResult = {
    schemaVersion: 1,
    jobId,
    ...result,
    workerId: result.workerId || getWorkerId(),
    sharedSecret: env.workerSharedSecret || undefined,
    completedAt: new Date().toISOString(),
  };

  logger?.info("queue.result.send.start", {
    ok: result.ok,
    contentType: "application/json",
    bodyEncoding: "json-string",
    body: textStats(JSON.stringify(body)),
    output: textStats(result.outputText),
    error: result.error ? textStats(result.error) : undefined,
  });
  await sender.sendMessages({
    body: JSON.stringify(body),
    messageId: `${jobId}:result`,
    correlationId: jobId,
    sessionId: jobId,
    contentType: "application/json",
    subject: "adaceen.result",
    // El resultado puede citar codigo del estudiante (A7.5): si el API ya no lo
    // espera, que expire en vez de quedarse hasta el TTL por defecto de la cola.
    timeToLive: resultTimeToLiveMs(),
  });
  logger?.info("queue.result.send.done", {
    durationMs: durationMs(startedAt),
  });
}

async function settleFailedMessage(
  receiver: Receiver,
  message: ServiceBusReceivedMessage,
  decision: JobFailureDecision,
  detail: string,
  logger: DiagnosticLogger,
) {
  try {
    if (decision.settlement === "abandon") {
      await receiver.abandonMessage(message);
    } else if (decision.settlement === "deadLetter") {
      await receiver.deadLetterMessage(message, {
        deadLetterReason: "JobValidationError",
        deadLetterErrorDescription: detail.slice(0, 4096),
      });
    } else {
      await receiver.completeMessage(message);
    }
    logger.info("queue.message.settled_after_failure", {
      settlement: decision.settlement,
      reason: decision.reason,
      deliveryCount: message.deliveryCount,
    });
  } catch (error) {
    // Si el lock ya expiro, Service Bus re-entrega el mensaje por su cuenta.
    logger.warn("queue.message.settle.failed", {
      settlement: decision.settlement,
      error: errorSummary(error),
    });
  }
}

async function handleMessage(
  message: ServiceBusReceivedMessage,
  receiver: Receiver,
  sender: Sender,
  baseLogger: DiagnosticLogger,
  requestTimeoutMs: number,
): Promise<MessageOutcome> {
  let jobId = trimText(message.correlationId || message.messageId);
  let logger = baseLogger.child({
    jobId: shortId(jobId, 64),
    messageId: shortId(message.messageId, 64),
  });
  logger.info("queue.message.received", {
    message: messageSummary(message),
  });

  try {
    const job = parseJobBody(message);
    jobId = trimText(job.jobId) || jobId;
    logger = baseLogger.child({
      jobId: shortId(jobId, 64),
      kind: job.kind,
      requestId: shortId(job.diagnostics?.requestId, 64),
      route: job.diagnostics?.route || "",
      scope: job.diagnostics?.scope || "",
    });
    logger.info("queue.job.received", {
      message: messageSummary(message),
      job: jobSummary(job),
    });

    // El backend ya dejo de esperar este job: responderlo solo retrasa a los nuevos.
    if (isJobStale({
      requestedAt: job.requestedAt,
      enqueuedTimeUtc: message.enqueuedTimeUtc,
      timeoutMs: requestTimeoutMs,
    })) {
      logger.warn("queue.job.stale", {
        requestedAt: trimText(job.requestedAt),
        enqueuedTimeUtc: message.enqueuedTimeUtc?.toISOString(),
        requestTimeoutMs,
      });
      console.warn(`[queue-worker] Job ${jobId} descartado: supero los ${Math.round(requestTimeoutMs / 1000)}s que espera el backend.`);
      await receiver.completeMessage(message);
      return "stale";
    }

    const startedAt = Date.now();
    console.log(`[queue-worker] Job recibido ${jobId} (${job.kind}).`);

    logger.info("queue.job.process.start");
    const outputText = await processJob(job);
    logger.info("queue.job.process.done", {
      durationMs: durationMs(startedAt),
      output: textStats(outputText),
    });
    await sendResult(sender, jobId, {
      ok: true,
      outputText,
    }, logger);
    await receiver.completeMessage(message);
    logger.info("queue.message.completed", {
      durationMs: durationMs(startedAt),
    });
    console.log(`[queue-worker] Job completado ${jobId} en ${Date.now() - startedAt}ms.`);
    return "processed";
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error);
    const decision = decideJobFailure({
      error,
      deliveryCount: message.deliveryCount,
      maxAttempts: env.queueWorkerMaxAttempts,
    });
    logger.error("queue.job.failed", {
      error: errorSummary(error),
      decision,
      deliveryCount: message.deliveryCount,
      maxAttempts: env.queueWorkerMaxAttempts,
    });
    if (decision.settlement === "abandon") {
      console.warn(`[queue-worker] Job ${jobId} fallo (intento ${message.deliveryCount ?? 1}/${env.queueWorkerMaxAttempts}); se libera para otro worker: ${detail}`);
    } else {
      console.error(`[queue-worker] Job fallo ${jobId}: ${detail}`);
    }

    if (decision.sendResult && jobId) {
      await sendResult(sender, jobId, {
        ok: false,
        error: detail,
      }, logger).catch((sendError) => {
        logger.error("queue.result.error_send.failed", {
          error: errorSummary(sendError),
        });
        console.error(`[queue-worker] No se pudo enviar error para ${jobId}: ${String(sendError)}`);
      });
    }

    await settleFailedMessage(receiver, message, decision, detail, logger);
    return decision.settlement === "abandon" ? "retry" : "processed";
  }
}

async function runWorker() {
  const config = ensureServiceBusQueueConfigured();
  const workerId = getWorkerId();
  const lockRenewalMs = resolveLockRenewalMs({
    requestTimeoutMs: config.timeoutMs,
    configuredMs: env.queueWorkerLockRenewalMs || undefined,
  });
  const logger = createDiagnosticLogger("queue-worker", {
    workerId,
    jobsQueueName: config.jobsQueueName,
    resultsQueueName: config.resultsQueueName,
  });
  let client: ServiceBusClient | null = null;
  let receiver: Receiver | null = null;
  let sender: Sender | null = null;
  const stats = { jobsProcessed: 0, lastJobAt: null as string | null };
  const stopHeartbeat = startHeartbeat({
    workerId,
    model: process.env.MODEL_TEXT || process.env.OLLAMA_MODEL || "",
    stats,
    logger,
  });

  const closeResources = async () => {
    await receiver?.close().catch((error) => {
      logger.warn("worker.receiver.close.failed", {
        error: errorSummary(error),
      });
    });
    await sender?.close().catch((error) => {
      logger.warn("worker.sender.close.failed", {
        error: errorSummary(error),
      });
    });
    await client?.close().catch((error) => {
      logger.warn("worker.client.close.failed", {
        error: errorSummary(error),
      });
    });
    receiver = null;
    sender = null;
    client = null;
  };

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    stopHeartbeat();
    logger.info("worker.stop.start");
    console.log("[queue-worker] Cerrando...");
    await closeResources();
    logger.info("worker.stop.done");
  };

  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });

  while (!stopping) {
    logger.info("worker.servicebus.connect.start");
    client = new ServiceBusClient(env.serviceBusConnectionString);
    receiver = client.createReceiver(config.jobsQueueName, {
      receiveMode: "peekLock",
      maxAutoLockRenewalDurationInMs: lockRenewalMs,
    });
    sender = client.createSender(config.resultsQueueName);

    console.log(`[queue-worker] Escuchando ${config.jobsQueueName} -> ${config.resultsQueueName} como ${workerId}.`);
    console.log(`[queue-worker] Ollama/OpenAI base: ${process.env.OPENAI_BASE || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434"}.`);
    logger.info("worker.listen.start", {
      ollamaBase: process.env.OPENAI_BASE || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
      model: process.env.MODEL_TEXT || process.env.OLLAMA_MODEL || "qwen2.5-coder:7b",
      requestTimeoutMs: config.timeoutMs,
      lockRenewalMs,
      maxAttempts: env.queueWorkerMaxAttempts,
      retryDelayMs: env.queueWorkerRetryDelayMs,
    });

    try {
      while (!stopping) {
        const messages = await receiver.receiveMessages(1, { maxWaitTimeInMs: 5000 });
        const message = messages[0];
        if (!message) continue;
        const outcome = await handleMessage(message, receiver, sender, logger, config.timeoutMs);
        stats.jobsProcessed += 1;
        stats.lastJobAt = new Date().toISOString();
        // Tras liberar un job, damos margen para que otro worker lo tome antes de volver a competir.
        if (outcome === "retry" && env.queueWorkerRetryDelayMs > 0) {
          await delay(env.queueWorkerRetryDelayMs);
        }
      }
    } catch (error) {
      if (stopping) break;
      logger.error("worker.servicebus.connection.failed", {
        reconnectDelayMs: RECONNECT_DELAY_MS,
        error: errorSummary(error),
      });
      console.error(`[queue-worker] Conexion Service Bus inestable; reconectando en ${RECONNECT_DELAY_MS}ms: ${errorDetail(error)}`);
      await closeResources();
      await delay(RECONNECT_DELAY_MS);
    }
  }

  await closeResources();
  logger.info("worker.exited");
}

runWorker().catch((error) => {
  processLog.error("worker.boot.failed", {
    error: errorSummary(error),
  });
  console.error("[queue-worker] No se pudo iniciar.", error);
  process.exitCode = 1;
});
