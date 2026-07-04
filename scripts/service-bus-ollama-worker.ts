import dotenv from "dotenv";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ServiceBusClient, type ServiceBusReceivedMessage } from "@azure/service-bus";
import type { QueueAgentJob, QueueAgentResult } from "../src/services/service-bus-agent.js";
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
    console.warn(`[queue-worker] Timeout cerrando enlace AMQP; se ignora para mantener el worker vivo: ${detail}`);
    return;
  }

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

async function runImageJob(job: QueueAgentJob) {
  const imageBase64 = trimText(job.imageBase64);
  if (!imageBase64) {
    throw new Error("imageBase64 requerido para job image.");
  }

  const extension = trimText(job.imageName).split(".").pop() || "png";
  const imagePath = path.join(os.tmpdir(), `adaceen-${job.jobId}.${extension}`);
  await fsp.writeFile(imagePath, Buffer.from(imageBase64, "base64"));

  try {
    return await runImage(imagePath, trimText(job.prompt));
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
  return runText(inputText);
}

async function sendResult(
  sender: ReturnType<ServiceBusClient["createSender"]>,
  jobId: string,
  result: Omit<QueueAgentResult, "schemaVersion" | "jobId" | "completedAt">,
) {
  const body: QueueAgentResult = {
    schemaVersion: 1,
    jobId,
    ...result,
    workerId: result.workerId || getWorkerId(),
    sharedSecret: env.workerSharedSecret || undefined,
    completedAt: new Date().toISOString(),
  };

  await sender.sendMessages({
    body,
    messageId: `${jobId}:result`,
    correlationId: jobId,
    sessionId: jobId,
    contentType: "application/json",
    subject: "adaceen.result",
  });
}

async function handleMessage(
  message: ServiceBusReceivedMessage,
  receiver: ReturnType<ServiceBusClient["createReceiver"]>,
  sender: ReturnType<ServiceBusClient["createSender"]>,
) {
  let jobId = trimText(message.correlationId || message.messageId);

  try {
    const job = parseJobBody(message);
    jobId = trimText(job.jobId) || jobId;
    const startedAt = Date.now();
    console.log(`[queue-worker] Job recibido ${jobId} (${job.kind}).`);

    const outputText = await processJob(job);
    await sendResult(sender, jobId, {
      ok: true,
      outputText,
    });
    await receiver.completeMessage(message);
    console.log(`[queue-worker] Job completado ${jobId} en ${Date.now() - startedAt}ms.`);
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error);
    console.error(`[queue-worker] Job fallo ${jobId}: ${detail}`);

    if (jobId) {
      await sendResult(sender, jobId, {
        ok: false,
        error: detail,
      }).catch((sendError) => {
        console.error(`[queue-worker] No se pudo enviar error para ${jobId}: ${String(sendError)}`);
      });
    }

    await receiver.completeMessage(message);
  }
}

async function runWorker() {
  const config = ensureServiceBusQueueConfigured();
  const workerId = getWorkerId();
  let client: ServiceBusClient | null = null;
  let receiver: ReturnType<ServiceBusClient["createReceiver"]> | null = null;
  let sender: ReturnType<ServiceBusClient["createSender"]> | null = null;

  const closeResources = async () => {
    await receiver?.close().catch(() => {});
    await sender?.close().catch(() => {});
    await client?.close().catch(() => {});
    receiver = null;
    sender = null;
    client = null;
  };

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log("[queue-worker] Cerrando...");
    await closeResources();
  };

  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });

  while (!stopping) {
    client = new ServiceBusClient(env.serviceBusConnectionString);
    receiver = client.createReceiver(config.jobsQueueName, { receiveMode: "peekLock" });
    sender = client.createSender(config.resultsQueueName);

    console.log(`[queue-worker] Escuchando ${config.jobsQueueName} -> ${config.resultsQueueName} como ${workerId}.`);
    console.log(`[queue-worker] Ollama/OpenAI base: ${process.env.OPENAI_BASE || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434"}.`);

    try {
      while (!stopping) {
        const messages = await receiver.receiveMessages(1, { maxWaitTimeInMs: 5000 });
        const message = messages[0];
        if (!message) continue;
        await handleMessage(message, receiver, sender);
      }
    } catch (error) {
      if (stopping) break;
      console.error(`[queue-worker] Conexion Service Bus inestable; reconectando en ${RECONNECT_DELAY_MS}ms: ${errorDetail(error)}`);
      await closeResources();
      await delay(RECONNECT_DELAY_MS);
    }
  }

  await closeResources();
}

runWorker().catch((error) => {
  console.error("[queue-worker] No se pudo iniciar.", error);
  process.exitCode = 1;
});
