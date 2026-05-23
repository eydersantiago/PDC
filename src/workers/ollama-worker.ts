import dotenv from "dotenv";
import os from "node:os";
import type {
  ProcessErrorArgs,
  ServiceBusReceivedMessage,
  ServiceBusReceiver,
  ServiceBusSender,
} from "@azure/service-bus";
import {
  closeServiceBusClient,
  createJobsReceiver,
  createResultsSender,
  getServiceBusQueueNames,
} from "../queue/service-bus.js";
import { logDebug, logError, logInfo, logWarn, toErrorFields } from "../services/logger.js";
import {
  generateWithOllama,
  normalizeOllamaBaseUrl,
} from "./ollama-client.js";
import type {
  JobInput,
  LlmJobMessage,
  LlmJobResultMessage,
  OllamaRuntimeStatus,
  SelectedOllamaModel,
  WorkerConfig,
  WorkerModelRoute,
} from "./types.js";

dotenv.config({ path: ".env.worker" });

const DEFAULT_PRIMARY_MODEL = "qwen3-coder:30b";
const DEFAULT_FAST_MODEL = "qwen2.5-coder:7b";
const DEFAULT_CLASSIFIER_MODEL = "qwen2.5:7b";

const ROUTE_ALIASES: Record<string, WorkerModelRoute> = {
  main: "primary",
  primary: "primary",
  code: "primary",
  coder: "primary",
  code_mentor: "primary",
  local_gpu_coder: "primary",
  quick: "fast",
  fast: "fast",
  summary: "fast",
  summarizer: "fast",
  resumen: "fast",
  classifier: "classifier",
  classification: "classifier",
  clasificador: "classifier",
  document_classification: "classifier",
  experimental: "experimental",
  next: "experimental",
  qwen_next: "experimental",
};

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.round(parsed));
}

function parseOptionalInt(value: string | undefined) {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round(parsed));
}

function parseCsv(value: string | undefined) {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function compactUnique(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => (value || "").trim()).filter(Boolean))];
}

function readModelEnv(name: string, fallback: string) {
  const value = (process.env[name] || "").trim();
  return value || fallback;
}

function readConfig(): WorkerConfig {
  const queueNames = getServiceBusQueueNames();
  const ollamaModel = readModelEnv("OLLAMA_MODEL", DEFAULT_PRIMARY_MODEL);
  const ollamaFastModel = readModelEnv("OLLAMA_FAST_MODEL", DEFAULT_FAST_MODEL);
  const ollamaClassifierModel = readModelEnv("OLLAMA_CLASSIFIER_MODEL", DEFAULT_CLASSIFIER_MODEL);
  const ollamaExperimentalModel = (process.env.OLLAMA_EXPERIMENTAL_MODEL || "").trim() || null;
  const supportedModels = parseCsv(process.env.SUPPORTED_MODELS);

  return {
    workerId: (process.env.WORKER_ID || `worker-${os.hostname()}`).trim(),
    workerRole: (process.env.WORKER_ROLE || "local_gpu_coder").trim(),
    hostname: os.hostname(),
    serviceBusConnectionString: (process.env.AZURE_SERVICEBUS_CONNECTION_STRING || "").trim(),
    jobsQueueName: queueNames.jobsQueueName,
    resultsQueueName: queueNames.resultsQueueName,
    ollamaBaseUrl: normalizeOllamaBaseUrl(
      process.env.OLLAMA_BASE_URL || process.env.OLLAMA_URL || "http://127.0.0.1:11434",
    ),
    ollamaModel,
    ollamaFastModel,
    ollamaClassifierModel,
    ollamaExperimentalModel,
    ollamaContext: parsePositiveInt(process.env.OLLAMA_CONTEXT, 8192),
    ollamaFastContext: parsePositiveInt(process.env.OLLAMA_FAST_CONTEXT, 4096),
    ollamaClassifierContext: parsePositiveInt(process.env.OLLAMA_CLASSIFIER_CONTEXT, 4096),
    ollamaExperimentalContext: parsePositiveInt(process.env.OLLAMA_EXPERIMENTAL_CONTEXT, 8192),
    supportedModels: supportedModels.length > 0
      ? supportedModels
      : compactUnique([
        ollamaModel,
        ollamaFastModel,
        ollamaClassifierModel,
        ollamaExperimentalModel,
      ]),
    maxParallelJobs: parsePositiveInt(
      process.env.WORKER_MAX_CONCURRENCY || process.env.MAX_PARALLEL_JOBS,
      1,
    ),
    vramGb: parseOptionalInt(process.env.VRAM_GB),
    adaceenApiUrl: (process.env.ADACEEN_API_URL || process.env.PUBLIC_API_URL || "")
      .trim()
      .replace(/\/+$/, ""),
    workerSharedSecret: (process.env.WORKER_SHARED_SECRET || "").trim(),
    ollamaTimeoutMs: parsePositiveInt(process.env.OLLAMA_TIMEOUT_MS, 120_000),
    ollamaStatusTimeoutMs: parsePositiveInt(process.env.OLLAMA_STATUS_TIMEOUT_MS, 2500),
  };
}

function requireConfig(config: WorkerConfig) {
  if (!config.serviceBusConnectionString) {
    throw new Error("Falta AZURE_SERVICEBUS_CONNECTION_STRING en .env.worker.");
  }

  if (!config.ollamaModel) {
    throw new Error("Falta OLLAMA_MODEL en .env.worker.");
  }
}

function parseBody(body: unknown): LlmJobMessage {
  if (typeof body === "string") {
    return JSON.parse(body) as LlmJobMessage;
  }

  if (body instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode(body)) as LlmJobMessage;
  }

  return body as LlmJobMessage;
}

function stringifyInput(input: JobInput) {
  return typeof input === "string" ? input : JSON.stringify(input, null, 2);
}

function collectImages(input: JobInput) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];

  const record = input as Record<string, unknown>;
  const images = record.images;
  if (Array.isArray(images)) {
    return images.map((image) => String(image)).filter(Boolean);
  }

  const singleImage = record.imageBase64 || record.image;
  return singleImage ? [String(singleImage)] : [];
}

function readNumberField(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
}

async function fetchOllamaRuntimeStatus(config: WorkerConfig): Promise<OllamaRuntimeStatus> {
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ollamaStatusTimeoutMs);

  try {
    const response = await fetch(`${config.ollamaBaseUrl}/api/ps`, {
      signal: controller.signal,
    });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`Ollama /api/ps HTTP ${response.status}: ${text.slice(0, 1000)}`);
    }

    const data = text ? JSON.parse(text) as Record<string, unknown> : {};
    const modelsRaw = Array.isArray(data.models) ? data.models : [];
    const models = modelsRaw
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map((item) => ({
        name: String(item.name || item.model || "").trim(),
        model: String(item.model || item.name || "").trim(),
        sizeBytes: readNumberField(item, ["size", "size_bytes", "sizeBytes"]),
        sizeVramBytes: readNumberField(item, ["size_vram", "size_vram_bytes", "sizeVramBytes"]),
        details: item.details,
      }))
      .filter((item) => item.name || item.model);

    const loadedVramBytes = models.reduce((sum, item) => sum + item.sizeVramBytes, 0);

    return {
      ok: true,
      checkedAt,
      loadedModels: models.map((item) => item.model || item.name),
      loadedVramBytes,
      loadedVramGb: Math.round((loadedVramBytes / 1024 ** 3) * 10) / 10,
      models,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      checkedAt,
      loadedModels: [],
      loadedVramBytes: 0,
      loadedVramGb: 0,
      models: [],
      error: controller.signal.aborted
        ? `Timeout consultando Ollama /api/ps despues de ${config.ollamaStatusTimeoutMs} ms.`
        : message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function readStringField(input: JobInput, keys: string[]) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";

  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function routeAlias(value: string | null | undefined) {
  const normalized = (value || "").trim().toLowerCase();
  return ROUTE_ALIASES[normalized] || null;
}

function looksLikeFastTask(job: LlmJobMessage) {
  const inputText = stringifyInput(job.input).toLowerCase();
  const task = readStringField(job.input, ["task", "type", "purpose", "intent", "route"]).toLowerCase();
  const combined = `${task}\n${inputText}`;

  return [
    "resumen",
    "resume",
    "summarize",
    "summary",
    "extract",
    "extrae",
    "intencion",
    "intent",
    "campus",
  ].some((keyword) => combined.includes(keyword));
}

function looksLikeClassifierTask(job: LlmJobMessage) {
  const task = readStringField(job.input, ["task", "type", "purpose", "intent", "route"]).toLowerCase();
  const inputText = stringifyInput(job.input).toLowerCase();
  const combined = `${task}\n${inputText}`;

  return [
    "clasifica",
    "clasificar",
    "classifier",
    "classification",
    "document_classification",
    "category",
    "categoria",
  ].some((keyword) => combined.includes(keyword));
}

function buildPrompt(job: LlmJobMessage) {
  if (job.kind === "github_mentor") {
    return [
      "Eres ADACEEN, tutor contextual para estudiantes de programacion.",
      "Responde en JSON estricto con estas claves:",
      "ideas: string[], searches: string[], guide: string[], welcome_message: string, analysis_summary: string.",
      "Da pistas progresivas; no entregues una solucion completa si el contexto parece un ejercicio evaluable.",
      "",
      "Solicitud:",
      stringifyInput(job.input),
    ].join("\n");
  }

  if (job.kind === "intervention") {
    return [
      "Eres ADACEEN. Genera una intervencion breve, segura y accionable para aprendizaje de programacion.",
      "Prioriza pistas y preguntas orientadoras antes que soluciones completas.",
      "",
      stringifyInput(job.input),
    ].join("\n");
  }

  if (job.kind === "document_classification") {
    return [
      "Clasifica el documento del usuario y devuelve JSON con category, confidence y rationale.",
      "",
      stringifyInput(job.input),
    ].join("\n");
  }

  if (job.kind === "image") {
    return typeof job.input === "string"
      ? job.input
      : String((job.input as Record<string, unknown>).prompt || "Describe y analiza la imagen.");
  }

  return stringifyInput(job.input);
}

function modelForRoute(route: WorkerModelRoute, config: WorkerConfig) {
  if (route === "fast") {
    return {
      model: config.ollamaFastModel,
      context: config.ollamaFastContext,
      reason: "tarea rapida/resumen",
    };
  }

  if (route === "classifier") {
    return {
      model: config.ollamaClassifierModel,
      context: config.ollamaClassifierContext,
      reason: "clasificacion/documento",
    };
  }

  if (route === "experimental") {
    if (!config.ollamaExperimentalModel) {
      throw new Error("OLLAMA_EXPERIMENTAL_MODEL no esta configurado para esta ruta.");
    }

    return {
      model: config.ollamaExperimentalModel,
      context: config.ollamaExperimentalContext,
      reason: "ruta experimental",
    };
  }

  return {
    model: config.ollamaModel,
    context: config.ollamaContext,
    reason: "razonamiento/codigo principal",
  };
}

function selectModel(job: LlmJobMessage, config: WorkerConfig): SelectedOllamaModel {
  const requestedModel = (job.model || "").trim();
  const requestedRoute = routeAlias(requestedModel)
    || routeAlias(readStringField(job.input, ["modelRoute", "model_route", "route", "workerRole", "worker_role"]));

  if (requestedRoute) {
    const routed = modelForRoute(requestedRoute, config);
    return { route: requestedRoute, ...routed };
  }

  if (requestedModel) {
    return {
      route: "explicit",
      model: requestedModel,
      context: config.ollamaContext,
      reason: "modelo explicito del job",
    };
  }

  if (job.kind === "document_classification" || (job.kind === "text" && looksLikeClassifierTask(job))) {
    const routed = modelForRoute("classifier", config);
    return { route: "classifier", ...routed };
  }

  if (job.kind === "text" && looksLikeFastTask(job)) {
    const routed = modelForRoute("fast", config);
    return { route: "fast", ...routed };
  }

  const routed = modelForRoute("primary", config);
  return { route: "primary", ...routed };
}

function isModelSupported(selection: SelectedOllamaModel, config: WorkerConfig) {
  return config.supportedModels.includes(selection.model);
}

async function callOllama(
  job: LlmJobMessage,
  config: WorkerConfig,
  selection: SelectedOllamaModel,
) {
  return generateWithOllama({
    baseUrl: config.ollamaBaseUrl,
    model: selection.model,
    prompt: buildPrompt(job),
    images: job.kind === "image" ? collectImages(job.input) : [],
    context: selection.context,
    timeoutMs: config.ollamaTimeoutMs,
    maxOutputChars: job.maxOutputChars,
  });
}

async function postBackend(config: WorkerConfig, path: string, body: unknown) {
  if (!config.adaceenApiUrl || !config.workerSharedSecret) return;

  const response = await fetch(`${config.adaceenApiUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-worker-secret": config.workerSharedSecret,
      "x-worker-id": config.workerId,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Backend ${path} HTTP ${response.status}: ${text.slice(0, 1000)}`);
  }
}

async function sendResult(sender: ServiceBusSender, result: LlmJobResultMessage) {
  await sender.sendMessages({
    body: result,
    contentType: "application/json",
    messageId: `${result.jobId}:${result.status}:${result.completedAt || result.startedAt || Date.now()}`,
    subject: result.status,
    applicationProperties: {
      jobId: result.jobId,
      status: result.status,
      workerId: result.workerId || "",
    },
  });
}

async function reportRunning(
  sender: ServiceBusSender,
  config: WorkerConfig,
  job: LlmJobMessage,
  startedAt: string,
) {
  const result: LlmJobResultMessage = {
    jobId: job.jobId,
    status: "running",
    workerId: config.workerId,
    startedAt,
  };

  await sendResult(sender, result);
  await postBackend(config, `/api/internal/jobs/${job.jobId}/running`, {
    workerId: config.workerId,
    startedAt,
  }).catch((error) => logWarn("worker_http_running_failed", {
    job_id: job.jobId,
    worker_id: config.workerId,
    ...toErrorFields(error),
  }));

  logInfo("worker_reported_running", {
    job_id: job.jobId,
    worker_id: config.workerId,
  });
}

async function reportCompleted(
  sender: ServiceBusSender,
  config: WorkerConfig,
  job: LlmJobMessage,
  startedAt: string,
  output: string,
  selection: SelectedOllamaModel,
) {
  const completedAt = new Date().toISOString();
  const result: LlmJobResultMessage = {
    jobId: job.jobId,
    status: "completed",
    output: {
      text: output,
      model: selection.model,
      modelRoute: selection.route,
      modelReason: selection.reason,
    },
    workerId: config.workerId,
    startedAt,
    completedAt,
  };

  await sendResult(sender, result);
  await postBackend(config, `/api/internal/jobs/${job.jobId}/completed`, {
    workerId: config.workerId,
    output: result.output,
    startedAt,
    completedAt,
  }).catch((error) => logWarn("worker_http_completed_failed", {
    job_id: job.jobId,
    worker_id: config.workerId,
    ...toErrorFields(error),
  }));

  logInfo("worker_reported_completed", {
    job_id: job.jobId,
    worker_id: config.workerId,
    model: selection.model,
    route: selection.route,
  });
}

async function reportFailed(
  sender: ServiceBusSender,
  config: WorkerConfig,
  job: LlmJobMessage,
  error: unknown,
  startedAt?: string,
) {
  const completedAt = new Date().toISOString();
  const message = error instanceof Error ? error.message : String(error);
  const result: LlmJobResultMessage = {
    jobId: job.jobId,
    status: "failed",
    error: message.slice(0, 4000),
    workerId: config.workerId,
    startedAt,
    completedAt,
  };

  await sendResult(sender, result);
  await postBackend(config, `/api/internal/jobs/${job.jobId}/failed`, {
    workerId: config.workerId,
    error: result.error,
    startedAt,
    completedAt,
  }).catch((httpError) => logWarn("worker_http_failed_failed", {
    job_id: job.jobId,
    worker_id: config.workerId,
    ...toErrorFields(httpError),
  }));

  logWarn("worker_reported_failed", {
    job_id: job.jobId,
    worker_id: config.workerId,
    error_message: result.error,
  });
}

async function postHeartbeat(config: WorkerConfig) {
  const ollamaStatus = await fetchOllamaRuntimeStatus(config);
  await postBackend(config, "/api/workers/heartbeat", {
    workerId: config.workerId,
    workerRole: config.workerRole,
    hostname: config.hostname,
    vramGb: config.vramGb,
    observedVramGb: Math.ceil(ollamaStatus.loadedVramGb),
    supportedModels: config.supportedModels,
    ollamaStatus,
    maxParallelJobs: config.maxParallelJobs,
  }).then(() => {
    logDebug("worker_heartbeat_sent", {
      worker_id: config.workerId,
      observed_vram_gb: Math.ceil(ollamaStatus.loadedVramGb),
    });
  }).catch((error) => logWarn("worker_heartbeat_failed", {
    worker_id: config.workerId,
    ...toErrorFields(error),
  }));
}

async function settleAfterReportFailure(
  receiver: ServiceBusReceiver,
  message: ServiceBusReceivedMessage,
  error: unknown,
) {
  if ((message.deliveryCount || 0) >= 5) {
    await receiver.deadLetterMessage(message, {
      deadLetterReason: "WorkerReportFailed",
      deadLetterErrorDescription: String(error).slice(0, 1024),
    });
    return;
  }

  await receiver.abandonMessage(message);
}

async function handleMessage(
  receiver: ServiceBusReceiver,
  resultSender: ServiceBusSender,
  config: WorkerConfig,
  message: ServiceBusReceivedMessage,
) {
  const job = parseBody(message.body);
  if (!job?.jobId || !job.kind) {
    logWarn("worker_job_invalid", {
      message_id: message.messageId || null,
      delivery_count: message.deliveryCount || 0,
    });
    await receiver.deadLetterMessage(message, {
      deadLetterReason: "InvalidJobMessage",
      deadLetterErrorDescription: "El mensaje no contiene jobId/kind.",
    });
    return;
  }

  let selection: SelectedOllamaModel;
  try {
    selection = selectModel(job, config);
  } catch (error) {
    logWarn("worker_job_route_unavailable", {
      job_id: job.jobId,
      worker_id: config.workerId,
      ...toErrorFields(error),
    });
    await reportFailed(resultSender, config, job, error).catch(() => {});
    await receiver.deadLetterMessage(message, {
      deadLetterReason: "ModelRouteUnavailable",
      deadLetterErrorDescription: String(error).slice(0, 1024),
    });
    return;
  }

  if (!isModelSupported(selection, config)) {
    const error = `Modelo no soportado por ${config.workerId}: ${selection.model}.`;
    logWarn("worker_job_unsupported_model", {
      job_id: job.jobId,
      worker_id: config.workerId,
      model: selection.model,
    });
    await reportFailed(resultSender, config, job, error).catch(() => {});
    await receiver.deadLetterMessage(message, {
      deadLetterReason: "UnsupportedModel",
      deadLetterErrorDescription: error,
    });
    return;
  }

  if (job.minVramGb !== undefined && job.minVramGb !== null && config.vramGb !== null && config.vramGb < job.minVramGb) {
    const error = `VRAM insuficiente en ${config.workerId}: ${config.vramGb} GB reportados, job requiere ${job.minVramGb} GB.`;
    logWarn("worker_job_insufficient_vram", {
      job_id: job.jobId,
      worker_id: config.workerId,
      worker_vram_gb: config.vramGb,
      min_vram_gb: job.minVramGb,
      delivery_count: message.deliveryCount || 0,
    });
    if ((message.deliveryCount || 0) >= 5) {
      await reportFailed(resultSender, config, job, error).catch(() => {});
      await receiver.deadLetterMessage(message, {
        deadLetterReason: "InsufficientVram",
        deadLetterErrorDescription: error,
      });
      return;
    }

    await receiver.abandonMessage(message);
    return;
  }

  const startedAt = new Date().toISOString();
  try {
    logInfo("worker_job_started", {
      job_id: job.jobId,
      worker_id: config.workerId,
      kind: job.kind,
      route: selection.route,
      model: selection.model,
      context: selection.context,
      delivery_count: message.deliveryCount || 0,
    });
    await reportRunning(resultSender, config, job, startedAt);
    const output = await callOllama(job, config, selection);
    await reportCompleted(resultSender, config, job, startedAt, output, selection);
    await receiver.completeMessage(message);
  } catch (error) {
    logWarn("worker_job_error", {
      job_id: job.jobId,
      worker_id: config.workerId,
      ...toErrorFields(error),
    });
    try {
      await reportFailed(resultSender, config, job, error, startedAt);
      await receiver.completeMessage(message);
    } catch (reportError) {
      await settleAfterReportFailure(receiver, message, reportError);
    }
  }
}

async function startWorker() {
  const config = readConfig();
  requireConfig(config);

  const receiver = createJobsReceiver();
  const resultSender = createResultsSender();

  await postHeartbeat(config);
  const heartbeatTimer = setInterval(() => {
    void postHeartbeat(config);
  }, 30_000);

  const subscription = receiver.subscribe(
    {
      processMessage: async (message) => {
        await handleMessage(receiver, resultSender, config, message);
      },
      processError: async (args: ProcessErrorArgs) => {
        logError("worker_receive_error", toErrorFields(args.error));
      },
    },
    {
      autoCompleteMessages: false,
      maxConcurrentCalls: config.maxParallelJobs,
    },
  );

  logInfo("worker_started", {
    worker_id: config.workerId,
    worker_role: config.workerRole,
    jobs_queue: config.jobsQueueName,
    results_queue: config.resultsQueueName,
    primary_model: config.ollamaModel,
    ollama_base_url: config.ollamaBaseUrl,
    max_parallel_jobs: config.maxParallelJobs,
  });

  async function shutdown(signal: string) {
    logInfo("worker_shutdown", {
      worker_id: config.workerId,
      signal,
    });
    clearInterval(heartbeatTimer);
    await subscription.close().catch(() => {});
    await receiver.close().catch(() => {});
    await resultSender.close().catch(() => {});
    await closeServiceBusClient().catch(() => {});
    process.exit(0);
  }

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

startWorker().catch((error) => {
  logError("worker_start_failed", toErrorFields(error));
  process.exitCode = 1;
});
