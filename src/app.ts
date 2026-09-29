import express from "express";
import cors from "cors";
import { env, isOriginAllowed, isQueueMode, isValidTargetMode } from "./config/env.js";
import { AppDatabase } from "./db/database.js";
import { registerRoutes, type RouteDeps } from "./routes/register-routes.js";
import { SESSION_STATE_HEADER } from "./routes/route-utils.js";
import { getServiceBusQueueConfig } from "./services/service-bus-agent.js";

const rejectedOrigins = new Set<string>();

function warnRejectedOrigin(origin: string | undefined) {
  const key = String(origin || "");
  if (rejectedOrigins.has(key) || rejectedOrigins.size >= 200) return;
  rejectedOrigins.add(key);
  console.warn(`[cors] Origen no permitido: ${key}. Si es de ADACEEN, agregalo a ALLOWED_ORIGINS.`);
}

// deps solo lo usan las pruebas (proveedor de editores y GitHub falsos); en
// produccion todo sale de las variables de entorno.
export function createApp(database: AppDatabase, deps: RouteDeps = {}) {
  const app = express();

  app.use(express.json({ limit: "20mb" }));
  app.use(cors({
    // Un origen no permitido se queda sin cabeceras CORS (el navegador bloquea la respuesta y la
    // preflight), en vez de un error 500 en cada peticion. Se avisa una vez por origen.
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) return callback(null, true);
      warnRejectedOrigin(origin);
      return callback(null, false);
    },
    credentials: true,
    // VS Code y el overlay leen si su x-session-id dejo de valer.
    exposedHeaders: [SESSION_STATE_HEADER],
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

  registerRoutes(app, database, deps);
  return app;
}
