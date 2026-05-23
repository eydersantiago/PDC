import express from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { enqueueLlmJob } from "../jobs/enqueue-job.js";
import { JobStore } from "../jobs/job-store.js";
import type { JobInput, JobKind, JobWithResult, WorkerNodeRecord } from "../jobs/job-types.js";
import { logInfo, logWarn, toErrorFields } from "../services/logger.js";
import { trimText } from "../services/text-utils.js";

const jobKindSchema = z.enum([
  "text",
  "image",
  "github_mentor",
  "intervention",
  "document_classification",
]);

const jobInputSchema = z.union([
  z.string(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

const createJobSchema = z.object({
  kind: jobKindSchema,
  model: z.string().min(1).max(120).optional(),
  input: jobInputSchema,
  minVramGb: z.number().int().min(0).max(512).optional(),
  maxOutputChars: z.number().int().min(1).max(120_000).optional(),
}).strict();

const smokeTestSchema = z.object({
  model: z.string().min(1).max(120).optional(),
  modelRoute: z.enum(["primary", "fast", "classifier", "experimental"]).optional(),
  prompt: z.string().min(1).max(2000).optional(),
  minVramGb: z.number().int().min(0).max(512).default(48),
  maxOutputChars: z.number().int().min(1).max(12_000).default(2000),
}).strict();

const heartbeatSchema = z.object({
  workerId: z.string().min(2).max(160),
  workerRole: z.string().min(1).max(160).optional(),
  hostname: z.string().max(260).optional(),
  vramGb: z.number().int().min(0).max(512).optional(),
  observedVramGb: z.number().int().min(0).max(512).optional(),
  supportedModels: z.array(z.string().min(1).max(160)).max(100).optional(),
  ollamaStatus: z.record(z.string(), z.unknown()).optional(),
  maxParallelJobs: z.number().int().min(1).max(64).optional(),
}).strict();

const runningSchema = z.object({
  workerId: z.string().min(1).max(160),
  startedAt: z.string().datetime().optional(),
}).strict();

const completionSchema = z.object({
  workerId: z.string().min(1).max(160).optional(),
  output: z.unknown().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
}).passthrough();

const failureSchema = z.object({
  workerId: z.string().min(1).max(160).optional(),
  error: z.string().min(1).max(4000),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
}).strict();

function stringifyInput(input: JobInput) {
  return typeof input === "string" ? input : JSON.stringify(input);
}

function assertInputSize(input: JobInput) {
  const limit = Math.max(1, env.maxTabContentChars || 12_000);
  const size = stringifyInput(input).length;
  if (size > limit) {
    throw new Error(`Input demasiado grande (${size} caracteres). Limite: ${limit}.`);
  }
}

async function resolveOptionalUserId(database: AppDatabase, req: express.Request) {
  const sessionId = trimText(req.header("x-session-id"));
  if (!sessionId) return null;

  const session = await database.getSession(sessionId);
  return session?.user.id || null;
}

function requireWorkerSecret(req: express.Request, res: express.Response) {
  if (!env.workerSharedSecret) {
    res.status(503).json({ ok: false, error: "WORKER_SHARED_SECRET no esta configurado." });
    return false;
  }

  if (req.header("x-worker-secret") !== env.workerSharedSecret) {
    res.status(401).json({ ok: false, error: "Worker no autorizado." });
    return false;
  }

  return true;
}

function serializeJob(job: JobWithResult) {
  const payload: Record<string, unknown> = {
    job_id: job.id,
    kind: job.kind,
    model: job.model,
    status: job.status,
    min_vram_gb: job.minVramGb,
    worker_id: job.assignedWorkerId,
    created_at: job.createdAt,
    started_at: job.startedAt,
    completed_at: job.completedAt,
    updated_at: job.updatedAt,
  };

  if (job.status === "failed") {
    payload.error = job.error;
  }

  if (job.status === "completed" && job.result) {
    payload.result = {
      output_text: job.result.outputText,
      output_json: job.result.outputJson,
      worker_id: job.result.workerId,
      created_at: job.result.createdAt,
    };
  }

  return payload;
}

function isWorkerOnline(lastSeenAt: string) {
  const lastSeenMs = new Date(lastSeenAt).getTime();
  if (!Number.isFinite(lastSeenMs)) return false;
  return Date.now() - lastSeenMs <= 2 * 60 * 1000;
}

function parseOptionalNumber(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isTruthyQuery(value: unknown) {
  return value === true || value === "true" || value === "1" || value === "yes";
}

function normalizeModelName(value: string) {
  return value.trim().replace(/:latest$/, "");
}

function serializeWorkerHealth(worker: WorkerNodeRecord, options: {
  model?: string;
  minVramGb?: number | null;
  minLoadedVramGb?: number | null;
  requireLoadedModel?: boolean;
}) {
  const online = isWorkerOnline(worker.lastSeenAt);
  const ollama = worker.ollamaStatus && typeof worker.ollamaStatus === "object"
    ? worker.ollamaStatus
    : {};
  const loadedModels = Array.isArray(ollama.loadedModels)
    ? ollama.loadedModels.map((model) => String(model)).filter(Boolean)
    : [];
  const loadedVramGb = Number(ollama.loadedVramGb ?? worker.observedVramGb ?? 0) || 0;
  const model = trimText(options.model);
  const normalizedModel = model ? normalizeModelName(model) : "";
  const supportedModels = worker.supportedModels || [];
  const modelSupported = !normalizedModel
    || supportedModels.some((item) => normalizeModelName(item) === normalizedModel);
  const modelLoaded = !normalizedModel
    || loadedModels.some((item) => normalizeModelName(item) === normalizedModel);
  const capacityOk = options.minVramGb === null || options.minVramGb === undefined
    ? true
    : (worker.vramGb ?? 0) >= options.minVramGb;
  const loadedVramOk = options.minLoadedVramGb === null || options.minLoadedVramGb === undefined
    ? true
    : loadedVramGb >= options.minLoadedVramGb;
  const ready = online
    && capacityOk
    && modelSupported
    && loadedVramOk
    && (!options.requireLoadedModel || modelLoaded);

  return {
    worker_id: worker.workerId,
    worker_role: worker.workerRole,
    hostname: worker.hostname,
    status: online ? "online" : "offline",
    reported_status: worker.status,
    ready,
    checks: {
      online,
      capacity_ok: capacityOk,
      model_supported: modelSupported,
      loaded_vram_ok: loadedVramOk,
      model_loaded: modelLoaded,
    },
    vram_gb: worker.vramGb,
    observed_vram_gb: worker.observedVramGb,
    loaded_vram_gb: loadedVramGb,
    supported_models: supportedModels,
    loaded_models: loadedModels,
    max_parallel_jobs: worker.maxParallelJobs,
    ollama: {
      ok: Boolean(ollama.ok),
      checked_at: typeof ollama.checkedAt === "string" ? ollama.checkedAt : null,
      error: typeof ollama.error === "string" ? ollama.error : null,
      models: Array.isArray(ollama.models) ? ollama.models : [],
    },
    last_seen_at: worker.lastSeenAt,
    created_at: worker.createdAt,
    updated_at: worker.updatedAt,
  };
}

export function registerJobRoutes(app: express.Express, database: AppDatabase) {
  const store = new JobStore(database);

  app.post("/api/jobs", async (req, res) => {
    try {
      const parsed = createJobSchema.parse(req.body || {});
      assertInputSize(parsed.input);

      const userId = await resolveOptionalUserId(database, req);
      const job = await enqueueLlmJob(database, {
        kind: parsed.kind as JobKind,
        model: parsed.model,
        input: parsed.input,
        userId,
        minVramGb: parsed.minVramGb,
        maxOutputChars: parsed.maxOutputChars,
      });

      logInfo("job_enqueued", {
        request_id: res.locals.requestId || null,
        job_id: job.id,
        kind: parsed.kind,
        model: parsed.model || null,
        min_vram_gb: parsed.minVramGb ?? null,
        max_output_chars: parsed.maxOutputChars ?? null,
        input_chars: stringifyInput(parsed.input).length,
        user_id: userId,
      });

      return res.status(202).json({
        job_id: job.id,
        status: job.status,
      });
    } catch (error) {
      const message = error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : String(error);
      const status = /Service Bus|AZURE_SERVICEBUS_CONNECTION_STRING/i.test(message) ? 503 : 400;
      logWarn("job_enqueue_failed", {
        request_id: res.locals.requestId || null,
        status_code: status,
        ...toErrorFields(error),
      });
      return res.status(status).json({ ok: false, error: message });
    }
  });

  app.get("/api/jobs/:jobId", async (req, res) => {
    try {
      const jobId = trimText(req.params.jobId);
      if (!jobId) {
        return res.status(400).json({ ok: false, error: "jobId requerido." });
      }

      const job = await store.getJob(jobId);
      if (!job) {
        return res.status(404).json({ ok: false, error: "Job no encontrado." });
      }

      return res.json({ ok: true, job: serializeJob(job) });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.get("/api/workers", async (_req, res) => {
    try {
      const workers = await store.listWorkers();
      return res.json({
        ok: true,
        workers: workers.map((worker) => ({
          worker_id: worker.workerId,
          worker_role: worker.workerRole,
          hostname: worker.hostname,
          status: isWorkerOnline(worker.lastSeenAt) ? "online" : "offline",
          reported_status: worker.status,
          vram_gb: worker.vramGb,
          observed_vram_gb: worker.observedVramGb,
          supported_models: worker.supportedModels || [],
          ollama: worker.ollamaStatus || {},
          max_parallel_jobs: worker.maxParallelJobs,
          last_seen_at: worker.lastSeenAt,
          created_at: worker.createdAt,
          updated_at: worker.updatedAt,
        })),
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/workers/heartbeat", async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;

    try {
      const parsed = heartbeatSchema.parse(req.body || {});
      const worker = await store.upsertWorkerHeartbeat({
        workerId: parsed.workerId,
        workerRole: parsed.workerRole,
        hostname: parsed.hostname,
        status: "online",
        vramGb: parsed.vramGb,
        observedVramGb: parsed.observedVramGb,
        supportedModels: parsed.supportedModels || [],
        ollamaStatus: parsed.ollamaStatus || {},
        maxParallelJobs: parsed.maxParallelJobs,
      });

      logInfo("worker_heartbeat", {
        request_id: res.locals.requestId || null,
        worker_id: parsed.workerId,
        worker_role: parsed.workerRole || null,
        hostname: parsed.hostname || null,
        vram_gb: parsed.vramGb ?? null,
        observed_vram_gb: parsed.observedVramGb ?? null,
        supported_models_count: parsed.supportedModels?.length || 0,
        max_parallel_jobs: parsed.maxParallelJobs ?? null,
      });

      return res.json({
        ok: true,
        worker: {
          worker_id: worker.workerId,
          worker_role: worker.workerRole,
          last_seen_at: worker.lastSeenAt,
        },
      });
    } catch (error) {
      const message = error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : String(error);
      return res.status(400).json({ ok: false, error: message });
    }
  });

  app.get("/api/ollama/status", async (req, res) => {
    try {
      const minVramGb = parseOptionalNumber(req.query.min_vram_gb);
      const minLoadedVramGb = parseOptionalNumber(req.query.min_loaded_vram_gb);
      const model = trimText(req.query.model);
      const requireLoadedModel = isTruthyQuery(req.query.require_loaded_model);
      const workers = await store.listWorkers();
      const serialized = workers.map((worker) => serializeWorkerHealth(worker, {
        model,
        minVramGb,
        minLoadedVramGb,
        requireLoadedModel,
      }));
      const readyWorkers = serialized.filter((worker) => worker.ready);

      return res.json({
        ok: true,
        mode: env.targetMode,
        gateway: {
          cloudflare: env.targetMode === "local" ? "optional_local_only" : "disabled",
          note: env.targetMode === "local"
            ? "Cloudflare solo debe usarse como tunel local opcional."
            : "Pruebas remotas deben pasar por la pasarela publica de Azure, no por Cloudflare.",
        },
        criteria: {
          model: model || null,
          min_vram_gb: minVramGb,
          min_loaded_vram_gb: minLoadedVramGb,
          require_loaded_model: requireLoadedModel,
        },
        summary: {
          total_workers: serialized.length,
          online_workers: serialized.filter((worker) => worker.status === "online").length,
          ready_workers: readyWorkers.length,
        },
        ready: readyWorkers.length > 0,
        workers: serialized,
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  app.post("/api/ollama/smoke-test", async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;

    try {
      const parsed = smokeTestSchema.parse(req.body || {});
      const routeOrModel = parsed.model || parsed.modelRoute || "primary";
      const prompt = parsed.prompt || [
        "Responde en una sola linea.",
        "Di si ADACEEN esta usando la pasarela Azure -> Service Bus -> worker Ollama local.",
        "Incluye el modelo que estas usando si puedes inferirlo por el contexto.",
      ].join(" ");

      const job = await enqueueLlmJob(database, {
        kind: "text",
        model: routeOrModel,
        input: {
          task: "gateway_smoke_test",
          route: parsed.modelRoute || routeOrModel,
          prompt,
        },
        userId: null,
        minVramGb: parsed.minVramGb,
        maxOutputChars: parsed.maxOutputChars,
      });

      logInfo("smoke_test_enqueued", {
        request_id: res.locals.requestId || null,
        job_id: job.id,
        requested_model_or_route: routeOrModel,
        min_vram_gb: parsed.minVramGb,
      });

      return res.status(202).json({
        ok: true,
        job_id: job.id,
        status: job.status,
        poll_url: `/api/jobs/${job.id}`,
        requested_model_or_route: routeOrModel,
        min_vram_gb: parsed.minVramGb,
      });
    } catch (error) {
      const message = error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : String(error);
      const status = /Service Bus|AZURE_SERVICEBUS_CONNECTION_STRING/i.test(message) ? 503 : 400;
      return res.status(status).json({ ok: false, error: message });
    }
  });

  app.post("/api/internal/jobs/:jobId/running", async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;

    try {
      const jobId = trimText(req.params.jobId);
      const parsed = runningSchema.parse(req.body || {});
      const job = await store.markJobRunning(jobId, parsed.workerId);
      if (!job) {
        return res.status(404).json({ ok: false, error: "Job no encontrado." });
      }

      logInfo("job_running", {
        request_id: res.locals.requestId || null,
        job_id: jobId,
        worker_id: parsed.workerId,
      });

      return res.json({ ok: true, job_id: jobId, status: "running" });
    } catch (error) {
      const message = error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : String(error);
      return res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/api/internal/jobs/:jobId/completed", async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;

    try {
      const jobId = trimText(req.params.jobId);
      const parsed = completionSchema.parse(req.body || {});
      const job = await store.markJobCompleted(jobId, {
        output: parsed.output,
        workerId: parsed.workerId,
        startedAt: parsed.startedAt,
        completedAt: parsed.completedAt,
      });
      if (!job) {
        return res.status(404).json({ ok: false, error: "Job no encontrado." });
      }

      logInfo("job_completed", {
        request_id: res.locals.requestId || null,
        job_id: jobId,
        worker_id: parsed.workerId || null,
      });

      return res.json({ ok: true, job_id: jobId, status: "completed" });
    } catch (error) {
      const message = error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : String(error);
      return res.status(400).json({ ok: false, error: message });
    }
  });

  app.post("/api/internal/jobs/:jobId/failed", async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;

    try {
      const jobId = trimText(req.params.jobId);
      const parsed = failureSchema.parse(req.body || {});
      const job = await store.markJobFailed(jobId, parsed.error, parsed.workerId);
      if (!job) {
        return res.status(404).json({ ok: false, error: "Job no encontrado." });
      }

      logWarn("job_failed", {
        request_id: res.locals.requestId || null,
        job_id: jobId,
        worker_id: parsed.workerId || null,
        error_message: parsed.error,
      });

      return res.json({ ok: true, job_id: jobId, status: "failed" });
    } catch (error) {
      const message = error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : String(error);
      return res.status(400).json({ ok: false, error: message });
    }
  });
}
