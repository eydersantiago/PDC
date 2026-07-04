import { randomUUID } from "node:crypto";
import { ServiceBusClient, type ServiceBusReceivedMessage } from "@azure/service-bus";
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
  const body = message.body;
  if (body && typeof body === "object") {
    return body as QueueAgentResult;
  }
  if (typeof body === "string") {
    return JSON.parse(body) as QueueAgentResult;
  }
  if (body instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode(body)) as QueueAgentResult;
  }
  throw new Error("Resultado queue invalido: body no reconocido.");
}

function validateQueueResult(jobId: string, result: QueueAgentResult) {
  if (trimText(result.jobId) !== jobId) {
    throw new Error(`Resultado queue no coincide con jobId ${jobId}.`);
  }
  if (env.workerSharedSecret && result.sharedSecret !== env.workerSharedSecret) {
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

async function waitForQueueResult(
  client: ServiceBusClient,
  jobId: string,
  timeoutMs: number,
  logger: DiagnosticLogger,
) {
  const startedAt = Date.now();
  logger.info("queue.result.session.accept.start", {
    resultsQueueName: env.resultsQueueName,
    timeoutMs,
  });

  const receiver = await client.acceptSession(env.resultsQueueName, jobId, {
    receiveMode: "receiveAndDelete",
  });
  logger.info("queue.result.session.accept.done", {
    durationMs: durationMs(startedAt),
  });

  try {
    const waitStartedAt = Date.now();
    logger.info("queue.result.receive.start", {
      timeoutMs,
    });
    const messages = await receiver.receiveMessages(1, {
      maxWaitTimeInMs: timeoutMs,
    });
    const message = messages[0];
    if (!message) {
      logger.warn("queue.result.receive.timeout", {
        durationMs: durationMs(waitStartedAt),
        timeoutMs,
      });
      throw new Error(`Timeout esperando respuesta queue (${Math.round(timeoutMs / 1000)}s).`);
    }

    logger.info("queue.result.receive.done", {
      durationMs: durationMs(waitStartedAt),
      message: messageSummary(message),
    });
    const result = parseResultBody(message);
    validateQueueResult(jobId, result);
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
    return trimText(result.outputText);
  } finally {
    await receiver.close().catch((error) => {
      logger.warn("queue.result.receiver.close.failed", {
        error: errorSummary(error),
      });
    });
  }
}

export async function runQueueAgentJob(input: {
  kind: QueueAgentJobKind;
  inputText?: string;
  prompt?: string;
  imageBase64?: string;
  imageMimeType?: string;
  imageName?: string;
  timeoutMs?: number;
  diagnostics?: AgentRunDiagnostics;
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

  const body: QueueAgentJob = {
    schemaVersion: 1,
    jobId,
    kind: input.kind,
    inputText: input.inputText,
    prompt: input.prompt,
    imageBase64: input.imageBase64,
    imageMimeType: input.imageMimeType,
    imageName: input.imageName,
    sharedSecret: env.workerSharedSecret || undefined,
    diagnostics: input.diagnostics,
    requestedAt: new Date().toISOString(),
  };

  try {
    const config = ensureServiceBusQueueConfigured();
    const timeoutMs = Math.max(1000, input.timeoutMs || config.timeoutMs);
    client = new ServiceBusClient(env.serviceBusConnectionString);
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

    const output = await waitForQueueResult(client, jobId, timeoutMs, logger);
    logger.info("queue.job.done", {
      durationMs: durationMs(startedAt),
      output: textStats(output),
    });
    return output;
  } catch (error) {
    logger.error("queue.job.failed", {
      durationMs: durationMs(startedAt),
      error: errorSummary(error),
    });
    throw error;
  } finally {
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
