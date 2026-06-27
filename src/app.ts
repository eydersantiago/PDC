import express from "express";
import cors from "cors";
import { env, isOriginAllowed, isQueueMode, isValidTargetMode } from "./config/env.js";
import { AppDatabase } from "./db/database.js";
import { registerRoutes } from "./routes/register-routes.js";
import { getServiceBusQueueConfig } from "./services/service-bus-agent.js";

export function createApp(database: AppDatabase) {
  const app = express();

  app.use(express.json({ limit: "20mb" }));
  app.use(cors({
    origin: (origin, callback) => isOriginAllowed(origin)
      ? callback(null, true)
      : callback(new Error(`Origin no permitido: ${origin}`), false),
    credentials: true,
  }));

  if (env.targetMode === "azure" && !env.azureServer) {
    console.warn("[config] AGENT_TARGET=azure pero AZURE_SERVER_URL esta vacia.");
  }
  if (isQueueMode()) {
    const queueConfig = getServiceBusQueueConfig();
    if (!queueConfig.configured) {
      console.warn(`[config] AGENT_TARGET=queue pero faltan: ${queueConfig.missing.join(", ")}.`);
    }
  }
  if (!isValidTargetMode()) {
    console.warn(`[config] AGENT_TARGET invalido: ${env.targetMode}. Usa local, azure o queue.`);
  }

  registerRoutes(app, database);
  return app;
}
