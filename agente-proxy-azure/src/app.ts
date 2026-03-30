import express from "express";
import cors from "cors";
import { env, isOriginAllowed } from "./config/env.js";
import { AppDatabase } from "./db/database.js";
import { registerRoutes } from "./routes/register-routes.js";

export function createApp(database: AppDatabase) {
  const app = express();

  app.use(express.json({ limit: "20mb" }));
  app.use(cors({
    origin: (origin, callback) => isOriginAllowed(origin)
      ? callback(null, true)
      : callback(new Error(`Origin no permitido: ${origin}`), false),
  }));

  if (env.targetMode === "azure" && !env.azureServer) {
    console.warn("[config] AGENT_TARGET=azure pero AZURE_SERVER_URL esta vacia.");
  }

  registerRoutes(app, database);
  return app;
}
