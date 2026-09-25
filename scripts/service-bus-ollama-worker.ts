import dotenv from "dotenv";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ServiceBusClient, ServiceBusReceivedMessage } from "@azure/service-bus";
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
  isJobKindSupported,
  isJobStale,
  parseWorkerKinds,
  resolveLockRenewalMs,
  resolveReceivePlan,
  type JobFailureDecision,
  type WorkerJobKind,
} from "../src/services/queue-worker-policy.js";
import { trimText } from "../src/services/text-utils.js";

dotenv.config();
// Las Mac del laboratorio guardan su configuracion fuera del repositorio
// (deploy/mac/instalar-worker-mac.sh la deja en ~/.adaceen/worker.env).
dotenv.config({ path: process.env.ADACEEN_WORKER_ENV_FILE?.trim() || ".env.worker", override: true });

// Todo lo que lee src/config/env.ts se importa despues de cargar .env.worker:
// env.ts toma los valores al importarse. Un import estatico de estos modulos
// dejaria al worker sin la cadena de conexion.
const [
  { runImage },
  { runText },
  { env },
  { ensureServiceBusQueueConfigured },
  { createServiceBusClient, describeServiceBusTransport },
  { postJson },
] = await Promise.all([
  import("../runImage.js"),
  import("../runText.js"),
  import("../src/config/env.js"),
  import("../src/services/service-bus-agent.js"),
  import("../src/services/service-bus-client.js"),
  import("../src/services/proxy-post.js"),
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
  concurrency: number;
  kinds: WorkerJobKind[];
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
      // postJson sale por HTTPS_PROXY si la red lo exige (laboratorio con proxy) y directo si no.
      const response = await postJson(url, {
        workerId: input.workerId,
        model: input.model,
        jobsProcessed: input.stats.jobsProcessed,
        lastJobAt: input.stats.lastJobAt,
        startedAt,
        // Donde corre (darwin-arm64 en las Mac del laboratorio, linux-x64 en Google Cloud).
        platform: `${os.platform()}-${os.arch()}`,
        concurrency: input.concurrency,
        kinds: input.kinds.join(","),
      }, { headers: { "x-worker-token": token }, timeoutMs: 10000 });
      if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
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
/**
 * Archivo de ultimo trabajo (QUEUE_WORKER_LAST_JOB_FILE): tras cada trabajo
 * atendido el worker escribe ahi la hora. El apagado por inactividad de la GPU
 * (deploy/gcp/startup-script.sh) mira la fecha de ese archivo; antes miraba la
 * del log, y un latido fallido lo renovaba cada 5 min, asi que la VM no se
 * apagaba nunca. Sin la variable no hace nada. Un fallo al escribir nunca
 * detiene al worker.
 */
function createLastJobRecorder(filePath: string, logger: ReturnType<typeof createDiagnosticLogger>) {
  if (!filePath) return () => {};
  let directoryReady = false;
  let failures = 0;
  return () => {
    void (async () => {
      try {
        if (!directoryReady) {
          await fsp.mkdir(path.dirname(filePath), { recursive: true });
          directoryReady = true;
        }
        await fsp.writeFile(filePath, `${new Date().toISOString()}\n`, "utf8");
        failures = 0;
      } catch (error) {
        failures += 1;
        // Solo el primero y luego cada 50, para no llenar el log.
        if (failures === 1 || failures % 50 === 0) {
          logger.warn("worker.last_job_file.failed", { failures, error: errorSummary(error) });
        }
      }
    })();
  };
}

/**
 * Precarga del modelo de texto al arrancar el worker: el primer estudiante no
 * espera a que el modelo suba a memoria (unos segundos en una GPU, mas en una
 * Mac recien encendida). Usa la API nativa de Ollama; si el servidor no es
 * Ollama, solo queda un aviso en el log. QUEUE_WORKER_WARMUP=0 la desactiva.
 */
function warmUpTextModel(logger: ReturnType<typeof createDiagnosticLogger>) {
  if (trimText(process.env.QUEUE_WORKER_WARMUP) === "0") return;
  const model = trimText(process.env.MODEL_TEXT) || trimText(process.env.OLLAMA_MODEL);
  if (!model) return;
  const base = (trimText(process.env.OLLAMA_BASE_URL) || trimText(process.env.OPENAI_BASE) || "http://127.0.0.1:11434")
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "");
  const startedAt = Date.now();
  void fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: "", keep_alive: -1 }),
    signal: AbortSignal.timeout(300000),
  })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      logger.info("worker.warmup.done", { model, durationMs: durationMs(startedAt) });
    })
    .catch((error) => logger.warn("worker.warmup.failed", { model, error: errorSummary(error) }));
}

/**
 * QUEUE_WORKER_READY_URL: si esta definida, el worker solo pide jobs mientras
 * esa URL responde 2xx. La usa el cluster de Mac: llama-server tarda minutos en
 * cargar un modelo repartido entre varias Mac y responde 503 mientras tanto; sin
 * esta espera el worker tomaria jobs que fallarian. Se consulta cada 2 s como
 * mucho.
 */
function createReadinessCheck(url: string) {
  if (!url) return async () => true;
  let lastCheck = 0;
  let lastResult = false;
  return async () => {
    const now = Date.now();
    if (now - lastCheck < 2000) return lastResult;
    lastCheck = now;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      lastResult = response.ok;
    } catch {
      lastResult = false;
    }
    return lastResult;
  };
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
  kinds: Set<WorkerJobKind>,
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

    // Un job invalido va a dead-letter antes de mirar el tipo.
    validateJob(job);
    // Un tipo que este worker no atiende (por ejemplo imagen en una Mac sin modelo de vision)
    // se libera sin contarlo como fallo, para que lo tome otro worker.
    if (!isJobKindSupported(job.kind, kinds)) {
      logger.info("queue.job.kind_skipped", { kind: job.kind, deliveryCount: message.deliveryCount });
      console.log(`[queue-worker] Job ${jobId} (${job.kind}) liberado: este worker solo atiende ${[...kinds].join(", ")}.`);
      await receiver.abandonMessage(message);
      return "retry";
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
  // Varios jobs a la vez (QUEUE_WORKER_CONCURRENCY): cada uno con su propio receptor
  // sobre la misma conexion. Ollama debe permitir otras tantas peticiones (OLLAMA_NUM_PARALLEL).
  const concurrency = env.queueWorkerConcurrency;
  const kinds = parseWorkerKinds(env.queueWorkerKinds);
  const receivePlan = resolveReceivePlan(env.queueWorkerPriority, env.queueWorkerBackupIdleMs);
  const readyUrl = trimText(process.env.QUEUE_WORKER_READY_URL);
  const isModelReady = createReadinessCheck(readyUrl);
  let modelWasReady: boolean | null = null;
  const transport = describeServiceBusTransport();
  const logger = createDiagnosticLogger("queue-worker", {
    workerId,
    jobsQueueName: config.jobsQueueName,
    resultsQueueName: config.resultsQueueName,
  });
  let client: ServiceBusClient | null = null;
  let receivers: Receiver[] = [];
  let sender: Sender | null = null;
  const stats = { jobsProcessed: 0, lastJobAt: null as string | null };
  const stopHeartbeat = startHeartbeat({
    workerId,
    model: process.env.MODEL_TEXT || process.env.OLLAMA_MODEL || "",
    stats,
    concurrency,
    kinds: [...kinds],
    logger,
  });
  warmUpTextModel(logger);
  const recordLastJob = createLastJobRecorder(trimText(process.env.QUEUE_WORKER_LAST_JOB_FILE), logger);

  const closeResources = async () => {
    for (const receiver of receivers) {
      await receiver.close().catch((error) => {
        logger.warn("worker.receiver.close.failed", {
          error: errorSummary(error),
        });
      });
    }
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
    receivers = [];
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
    logger.info("worker.servicebus.connect.start", { transport: transport.transport, viaProxy: transport.viaProxy });
    client = createServiceBusClient();
    const activeClient = client;
    receivers = Array.from({ length: concurrency }, () => activeClient.createReceiver(config.jobsQueueName, {
      receiveMode: "peekLock",
      maxAutoLockRenewalDurationInMs: lockRenewalMs,
    }));
    sender = activeClient.createSender(config.resultsQueueName);
    const activeSender = sender;

    console.log(`[queue-worker] Escuchando ${config.jobsQueueName} -> ${config.resultsQueueName} como ${workerId} (${concurrency} a la vez; tipos: ${[...kinds].join(", ")}).`);
    console.log(`[queue-worker] Service Bus por ${transport.transport === "websockets" ? `WebSockets (HTTPS 443)${transport.viaProxy ? " con proxy" : ""}` : "AMQP (5671)"}.`);
    console.log(`[queue-worker] Ollama/OpenAI base: ${process.env.OPENAI_BASE || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434"}.`);
    if (receivePlan.backup) {
      console.log(`[queue-worker] Modo respaldo: toma los jobs que los demas servidores no alcanzan a tomar (descanso de ${receivePlan.idleDelayMs} ms).`);
    }
    logger.info("worker.listen.start", {
      ollamaBase: process.env.OPENAI_BASE || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
      model: process.env.MODEL_TEXT || process.env.OLLAMA_MODEL || "qwen2.5-coder:7b",
      requestTimeoutMs: config.timeoutMs,
      lockRenewalMs,
      maxAttempts: env.queueWorkerMaxAttempts,
      retryDelayMs: env.queueWorkerRetryDelayMs,
      concurrency,
      kinds: [...kinds],
      transport: transport.transport,
      viaProxy: transport.viaProxy,
      priority: receivePlan.backup ? "backup" : "normal",
    });

    // Si un receptor pierde la conexion, los demas terminan su job y se reconecta todo.
    let broken: unknown = null;
    const receiveLoop = async (receiver: Receiver) => {
      try {
        while (!stopping && !broken) {
          // Sin modelo listo (llama-server cargando o sin nodos) no se piden jobs.
          const ready = await isModelReady();
          if (ready !== modelWasReady) {
            modelWasReady = ready;
            if (readyUrl) logger.info(ready ? "worker.model.ready" : "worker.model.not_ready", { readyUrl });
            if (readyUrl && !ready) console.log(`[queue-worker] Esperando al modelo (${readyUrl}) antes de tomar jobs.`);
          }
          if (!ready) {
            await delay(2000);
            continue;
          }
          const messages = await receiver.receiveMessages(1, { maxWaitTimeInMs: receivePlan.maxWaitTimeInMs });
          const message = messages[0];
          if (!message) {
            // Respaldo: descansa entre consultas para que los jobs le lleguen primero a los demas.
            if (receivePlan.idleDelayMs > 0 && !stopping) await delay(receivePlan.idleDelayMs);
            continue;
          }
          const outcome = await handleMessage(message, receiver, activeSender, logger, config.timeoutMs, kinds);
          if (outcome !== "retry") {
            stats.jobsProcessed += 1;
            stats.lastJobAt = new Date().toISOString();
            recordLastJob();
          }
          // Tras liberar un job, damos margen para que otro worker lo tome antes de volver a competir.
          if (outcome === "retry" && env.queueWorkerRetryDelayMs > 0) {
            await delay(env.queueWorkerRetryDelayMs);
          }
        }
      } catch (error) {
        if (!stopping) broken = broken || error;
      }
    };
    await Promise.all(receivers.map((receiver) => receiveLoop(receiver)));

    if (stopping) break;
    if (broken) {
      logger.error("worker.servicebus.connection.failed", {
        reconnectDelayMs: RECONNECT_DELAY_MS,
        error: errorSummary(broken),
      });
      console.error(`[queue-worker] Conexion Service Bus inestable; reconectando en ${RECONNECT_DELAY_MS}ms: ${errorDetail(broken)}`);
    }
    await closeResources();
    await delay(RECONNECT_DELAY_MS);
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
