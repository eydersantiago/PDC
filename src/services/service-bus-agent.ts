import { randomUUID } from "node:crypto";
import { ServiceBusClient, type ServiceBusReceivedMessage } from "@azure/service-bus";
import { env } from "../config/env.js";
import { trimText } from "./text-utils.js";

export type QueueAgentJobKind = "text" | "image";

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

async function waitForQueueResult(client: ServiceBusClient, jobId: string, timeoutMs: number) {
  const receiver = await client.acceptSession(env.resultsQueueName, jobId, {
    receiveMode: "receiveAndDelete",
  });

  try {
    const messages = await receiver.receiveMessages(1, {
      maxWaitTimeInMs: timeoutMs,
    });
    const message = messages[0];
    if (!message) {
      throw new Error(`Timeout esperando respuesta queue (${Math.round(timeoutMs / 1000)}s).`);
    }

    const result = parseResultBody(message);
    validateQueueResult(jobId, result);
    if (!result.ok) {
      throw new Error(result.error || "Worker local devolvio error sin detalle.");
    }
    return trimText(result.outputText);
  } finally {
    await receiver.close().catch(() => {});
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
}) {
  const config = ensureServiceBusQueueConfigured();
  const jobId = randomUUID();
  const timeoutMs = Math.max(1000, input.timeoutMs || config.timeoutMs);
  const client = new ServiceBusClient(env.serviceBusConnectionString);
  const sender = client.createSender(env.jobsQueueName);

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
    requestedAt: new Date().toISOString(),
  };

  try {
    await sender.sendMessages({
      body,
      messageId: jobId,
      correlationId: jobId,
      contentType: "application/json",
      subject: `adaceen.${input.kind}`,
      applicationProperties: {
        kind: input.kind,
      },
    });

    return await waitForQueueResult(client, jobId, timeoutMs);
  } finally {
    await sender.close().catch(() => {});
    await client.close().catch(() => {});
  }
}
