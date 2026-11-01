// Rutas de inferencia directa: /run-text, /run-image, /run y el estado y latido de los workers.
import fsp from "node:fs/promises";
import type express from "express";
import { env } from "../../config/env.js";
import { durationMs, errorSummary, textStats } from "../../services/shared/diagnostics.js";
import { runImageByMode, runTextByMode, runTextByModeDetailed } from "../../services/tutor/agent-mode.js";
import { getServiceBusQueueConfig } from "../../services/queue/service-bus-agent.js";
import { describeWorker, getLastWorker } from "../../services/queue/worker-identity.js";
import { countAliveWorkers, isHeartbeatTokenValid, listListeningWorkers, recordWorkerHeartbeat } from "../../services/queue/worker-heartbeat.js";
import { trimText } from "../../services/shared/text-utils.js";
import { serializableGeneration, type TextGenerationOptions } from "../../services/tutor/text-generation.js";
import { type ImageUploadMiddleware, getRequestId, agentRoutesLog } from "./agent-route-utils.js";

export function registerAgentInferenceRoutes(app: express.Express, upload: ImageUploadMiddleware) {
  app.post("/run-text", async (req, res) => {
    const requestId = getRequestId(req);
    const startedAt = Date.now();
    const logger = agentRoutesLog.child({ requestId, route: "/run-text", mode: env.targetMode });
    try {
      const input = trimText(req.body?.input_as_text);
      logger.info("run-text.request.start", {
        input: textStats(input),
        contentLength: trimText(req.header("content-length")),
      });
      if (!input) {
        logger.warn("run-text.request.invalid", {
          reason: "input_as_text requerido",
        });
        return res.status(400).json({ ok: false, error: "input_as_text requerido" });
      }

      // generation: el perfil que manda otro backend encadenado (AGENT_TARGET=azure).
      const generation = req.body?.generation && typeof req.body.generation === "object"
        ? serializableGeneration(req.body.generation as TextGenerationOptions)
        : undefined;
      const { outputText: output, worker } = await runTextByModeDetailed(input, {
        requestId,
        route: "/run-text",
      }, generation);
      logger.info("run-text.request.done", {
        durationMs: durationMs(startedAt),
        output: textStats(output),
        worker: worker.id || worker.provider,
      });
      // worker es aditivo: los clientes que solo leen output_text no se rompen.
      return res.json({ ok: true, output_text: output, worker });
    } catch (error) {
      logger.error("run-text.request.failed", {
        durationMs: durationMs(startedAt),
        error: errorSummary(error),
      });
      return res.status(500).json({ ok: false, error: String(error) });
    }
  });

  /**
   * Estado del backend de inferencia, para que un cliente pueda mostrar
   * de donde sale la GPU sin tener que lanzar un job primero.
   *
   * - mode: local | azure | queue (AGENT_TARGET)
   * - worker: quien atendio el ultimo job, si hubo alguno
   * - queue: nombres de cola cuando el modo es queue
   */
  app.get("/api/agent/backend", (_req, res) => {
    const mode = env.targetMode;
    const lastWorker = getLastWorker();
    const queueConfig = mode === "queue" ? getServiceBusQueueConfig() : null;

    // Latidos (A15.4): quien esta escuchando la cola ahora, no solo quien atendio el ultimo job.
    const listening = listListeningWorkers();
    return res.json({
      ok: true,
      mode,
      worker: lastWorker,
      listening,
      alive_workers: listening.filter((worker) => worker.alive).length,
      // Cuando todavia no ha pasado ningun job, al menos decimos que se espera.
      expected: lastWorker
        ? null
        : describeWorker(mode === "local" ? "" : undefined, { mode }),
      queue: queueConfig
        ? {
            configured: queueConfig.configured,
            missing: queueConfig.missing,
            jobsQueueName: queueConfig.jobsQueueName,
            resultsQueueName: queueConfig.resultsQueueName,
          }
        : null,
      checkedAt: new Date().toISOString(),
    });
  });

  /**
   * Latido de un worker de GPU (A15.4). Cabecera x-worker-token con
   * WORKER_HEARTBEAT_TOKEN. Sin token configurado en el servidor: 503.
   */
  app.post("/api/agent/heartbeat", (req, res) => {
    if (!env.workerHeartbeatToken) {
      return res.status(503).json({ ok: false, error: "WORKER_HEARTBEAT_TOKEN no configurado en el servidor." });
    }
    if (!isHeartbeatTokenValid(req.header("x-worker-token"))) {
      return res.status(401).json({ ok: false, error: "Token de worker invalido." });
    }
    const entry = recordWorkerHeartbeat({
      workerId: trimText(req.body?.workerId),
      model: trimText(req.body?.model),
      jobsProcessed: Number(req.body?.jobsProcessed),
      lastJobAt: trimText(req.body?.lastJobAt),
      startedAt: trimText(req.body?.startedAt),
      platform: trimText(req.body?.platform),
      concurrency: Number(req.body?.concurrency),
      kinds: trimText(req.body?.kinds),
    });
    if (!entry) {
      return res.status(400).json({ ok: false, error: "workerId requerido." });
    }
    return res.status(204).end();
  });

  /**
   * Salud del camino de inferencia: en modo queue exige al menos un worker
   * con latido reciente. Sirve para una alerta de disponibilidad (Azure
   * Monitor / prueba de disponibilidad) que avise cuando no hay GPU.
   */
  app.get("/api/agent/health", (_req, res) => {
    const aliveWorkers = countAliveWorkers();
    if (env.targetMode === "queue" && aliveWorkers === 0) {
      return res.status(503).json({ ok: false, reason: "sin_worker", mode: env.targetMode, alive_workers: 0 });
    }
    return res.json({ ok: true, mode: env.targetMode, alive_workers: aliveWorkers });
  });

  app.post("/run-image", upload.single("image"), async (req, res) => {
    const requestId = getRequestId(req);
    const startedAt = Date.now();
    const logger = agentRoutesLog.child({ requestId, route: "/run-image", mode: env.targetMode });
    try {
      logger.info("run-image.request.start", {
        hasFile: Boolean(req.file),
        mimetype: req.file?.mimetype || "",
        originalname: req.file?.originalname || "",
        size: req.file?.size || 0,
        prompt: textStats(req.body?.prompt),
      });
      if (!req.file) {
        logger.warn("run-image.request.invalid", {
          reason: "image requerida",
        });
        return res.status(400).json({ ok: false, error: "image requerida" });
      }

      const prompt = trimText(req.body?.prompt);
      const output = await runImageByMode(req.file, prompt, { requestId, route: "/run-image" });
      logger.info("run-image.request.done", {
        durationMs: durationMs(startedAt),
        output: textStats(output),
      });
      return res.json({ ok: true, output_text: output });
    } catch (error) {
      logger.error("run-image.request.failed", {
        durationMs: durationMs(startedAt),
        error: errorSummary(error),
      });
      return res.status(500).json({ ok: false, error: String(error) });
    } finally {
      if (req.file?.path) {
        await fsp.unlink(req.file.path).catch(() => {});
      }
    }
  });
}

export function registerAgentRunRoute(app: express.Express, upload: ImageUploadMiddleware) {
  app.post("/run", upload.single("image"), async (req, res) => {
    const requestId = getRequestId(req);
    const startedAt = Date.now();
    const logger = agentRoutesLog.child({ requestId, route: "/run", mode: env.targetMode });
    try {
      logger.info("run.request.start", {
        hasFile: Boolean(req.file),
        input: textStats(req.body?.input_as_text),
        prompt: textStats(req.body?.prompt),
        mimetype: req.file?.mimetype || "",
        originalname: req.file?.originalname || "",
        size: req.file?.size || 0,
      });
      if (req.file) {
        const prompt = trimText(req.body?.prompt);
        const output = await runImageByMode(req.file, prompt, { requestId, route: "/run" });
        logger.info("run.request.done", {
          durationMs: durationMs(startedAt),
          kind: "image",
          output: textStats(output),
        });
        return res.json({ ok: true, output_text: output });
      }

      const input = trimText(req.body?.input_as_text);
      if (!input) {
        logger.warn("run.request.invalid", {
          reason: "input_as_text requerido",
        });
        return res.status(400).json({ ok: false, error: "input_as_text requerido" });
      }

      const output = await runTextByMode(input, { requestId, route: "/run" });
      logger.info("run.request.done", {
        durationMs: durationMs(startedAt),
        kind: "text",
        output: textStats(output),
      });
      return res.json({ ok: true, output_text: output });
    } catch (error) {
      logger.error("run.request.failed", {
        durationMs: durationMs(startedAt),
        error: errorSummary(error),
      });
      return res.status(500).json({ ok: false, error: String(error) });
    } finally {
      if (req.file?.path) {
        await fsp.unlink(req.file.path).catch(() => {});
      }
    }
  });
}
