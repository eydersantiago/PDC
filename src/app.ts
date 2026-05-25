import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import { env, isOriginAllowed } from "./config/env.js";
import { AppDatabase } from "./db/database.js";
import { registerRoutes } from "./routes/register-routes.js";
import { logInfo, logWarn, toErrorFields } from "./services/logger.js";

function getClientIp(req: express.Request) {
  const forwardedFor = req.header("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0]?.trim() || null;
  return req.ip || req.socket.remoteAddress || null;
}

export function createApp(database: AppDatabase) {
  const app = express();

  app.use((req, res, next) => {
    const requestId = req.header("x-request-id") || crypto.randomUUID();
    const startedAt = process.hrtime.bigint();

    res.locals.requestId = requestId;
    res.setHeader("x-request-id", requestId);

    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      logInfo("http_request", {
        request_id: requestId,
        method: req.method,
        path: req.path,
        status_code: res.statusCode,
        duration_ms: Math.round(durationMs),
        content_length: req.header("content-length") || null,
        origin: req.header("origin") || null,
        user_agent: (req.header("user-agent") || "").slice(0, 180) || null,
        client_ip: getClientIp(req),
      });
    });

    next();
  });

  app.use(express.json({ limit: "20mb" }));
  app.use(cors({
    origin: (origin, callback) => isOriginAllowed(origin)
      ? callback(null, true)
      : callback(new Error(`Origin no permitido: ${origin}`), false),
  }));

  if (env.targetMode === "azure" && !env.azureServer) {
    console.warn("[config] AGENT_TARGET=azure pero AZURE_SERVER_URL esta vacia.");
  }

  if (env.targetMode === "queue" && !env.serviceBusConnectionString) {
    console.warn("[config] AGENT_TARGET=queue pero AZURE_SERVICEBUS_CONNECTION_STRING esta vacia.");
  }

  if (env.targetMode === "queue" && !env.workerSharedSecret) {
    console.warn("[config] AGENT_TARGET=queue pero WORKER_SHARED_SECRET esta vacia; heartbeat y smoke-test del worker no estaran disponibles.");
  }

  if (env.targetMode === "queue" && process.env.NODE_ENV === "production" && !env.databaseUrl) {
    console.warn("[config] AGENT_TARGET=queue en produccion sin DATABASE_URL; se usara base en memoria y los jobs no persistiran.");
  }

  registerRoutes(app, database);

  app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const statusCode = typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : 500;
    const message = error instanceof Error ? error.message : String(error);

    logWarn("http_error", {
      request_id: res.locals.requestId || null,
      method: req.method,
      path: req.path,
      status_code: statusCode,
      ...toErrorFields(error),
    });

    res.status(statusCode).json({ ok: false, error: message });
  });

  return app;
}
