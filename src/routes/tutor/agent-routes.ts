// Rutas del agente: registerAgentRoutes registra, en este orden, inferencia directa, /suggest-tab, /intervene y /github-mentor, y /run.
import type express from "express";
import type { AppDatabase } from "../../db/database.js";
import { type ExtensionUpdateNotifier } from "../../services/extensions/extension-update-notice.js";
import { type ImageUploadMiddleware } from "./agent-route-utils.js";
import { registerAgentSuggestTabRoutes } from "./agent-suggest-tab-routes.js";
import { registerAgentInterventionRoutes } from "./agent-intervention-routes.js";
import { registerAgentInferenceRoutes, registerAgentRunRoute } from "./agent-inference-routes.js";

export function registerAgentRoutes(
  app: express.Express,
  database: AppDatabase,
  upload: ImageUploadMiddleware,
  options: { extensionUpdate?: ExtensionUpdateNotifier } = {},
) {
  registerAgentInferenceRoutes(app, upload);
  registerAgentSuggestTabRoutes(app, database);
  registerAgentInterventionRoutes(app, database, options);
  registerAgentRunRoute(app, upload);
}

