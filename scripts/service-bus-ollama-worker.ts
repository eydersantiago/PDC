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
import { trimText } from "../src/services/text-utils.js";

dotenv.config();
dotenv.config({ path: ".env.worker", override: true });

const [{ runImage }, { runText }, { env }, { ensureServiceBusQueueConfigured }] = await Promise.all([
  import("../runImage.js"),
  import("../runText.js"),
  import("../src/config/env.js"),
  import("../src/services/service-bus-agent.js"),
]);

const RECONNECT_DELAY_MS = 5000;
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
  if (body && typeof body === "object") {
    return body as QueueAgentJob;
  }
  if (typeof body === "string") {
    return JSON.parse(body) as QueueAgentJob;
  }
  if (body instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode(body)) as QueueAgentJob;
  }
  throw new Error("Job queue invalido: body no reconocido.");
}

function getWorkerId() {
  return trimText(process.env.QUEUE_WORKER_ID)
    || trimText(process.env.ADACEEN_QUEUE_WORKER_ID)
    || `${env.defaultScanWorkerId}-${os.hostname()}`;
}

function validateJob(job: QueueAgentJob) {
  if (job.schemaVersion !== 1) {
    throw new Error("schemaVersion no soportado.");
  }
  if (!trimText(job.jobId)) {
    throw new Error("jobId requerido.");
  }
  if (job.kind !== "text" && job.kind !== "image") {
    throw new Error(`kind no soportado: ${String(job.kind)}`);
  }
  if (env.workerSharedSecret && job.sharedSecret !== env.workerSharedSecret) {
    throw new Error("WORKER_SHARED_SECRET no coincide.");
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
    throw new Error("imageBase64 requerido para job image.");
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
    throw new Error("inputText requerido para job text.");
  }
  return runText(inputText, job.diagnostics);
}

async function sendResult(
  sender: ReturnType<ServiceBusClient["createSender"]>,
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
  });
  logger?.info("queue.result.send.done", {
    durationMs: durationMs(startedAt),
  });
}

async function handleMessage(
  message: ServiceBusReceivedMessage,
  receiver: ReturnType<ServiceBusClient["createReceiver"]>,
  sender: ReturnType<ServiceBusClient["createSender"]>,
  baseLogger: DiagnosticLogger,
) {
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
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error);
    logger.error("queue.job.failed", {
      error: errorSummary(error),
    });
    console.error(`[queue-worker] Job fallo ${jobId}: ${detail}`);

    if (jobId) {
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

    await receiver.completeMessage(message);
    logger.info("queue.message.completed_after_failure");
  }
}

async function runWorker() {
  const config = ensureServiceBusQueueConfigured();
  const workerId = getWorkerId();
  const logger = createDiagnosticLogger("queue-worker", {
    workerId,
    jobsQueueName: config.jobsQueueName,
    resultsQueueName: config.resultsQueueName,
  });
  let client: ServiceBusClient | null = null;
  let receiver: ReturnType<ServiceBusClient["createReceiver"]> | null = null;
  let sender: ReturnType<ServiceBusClient["createSender"]> | null = null;

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
    receiver = client.createReceiver(config.jobsQueueName, { receiveMode: "peekLock" });
    sender = client.createSender(config.resultsQueueName);

    console.log(`[queue-worker] Escuchando ${config.jobsQueueName} -> ${config.resultsQueueName} como ${workerId}.`);
    console.log(`[queue-worker] Ollama/OpenAI base: ${process.env.OPENAI_BASE || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434"}.`);
    logger.info("worker.listen.start", {
      ollamaBase: process.env.OPENAI_BASE || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
      model: process.env.MODEL_TEXT || process.env.OLLAMA_MODEL || "qwen2.5-coder:7b",
    });

    try {
      while (!stopping) {
        const messages = await receiver.receiveMessages(1, { maxWaitTimeInMs: 5000 });
        const message = messages[0];
        if (!message) continue;
        await handleMessage(message, receiver, sender, logger);
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
