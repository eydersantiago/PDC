// Rutas del estado de la sesion y del contexto del proyecto (estado, historial, insight, captura y reconstruccion).
// Movido sin cambios desde src/routes/projects/project-context-routes.ts (solo se agrego "export" y los imports).
import express from "express";
import type { AppDatabase } from "../../db/database.js";
import type { LatestVersionProvider } from "../../services/extensions/download-versions.js";
import { registerProjectSessionStatusRoutes } from "./project-session-status-routes.js";
import { registerProjectInsightRoutes } from "./project-insight-routes.js";
import { registerProjectContextRebuildRoutes } from "./project-context-rebuild-routes.js";

export type ProjectContextStateDeps = {
  /** La version publicada de la extension de VS Code (register-routes.ts la lee del disco). */
  latestVscodeVersion: LatestVersionProvider;
};

// Estado de la sesion y contexto del proyecto: estado, historial, insight, captura y reconstruccion.
export function registerProjectContextStateRoutes(app: express.Express, database: AppDatabase, deps: ProjectContextStateDeps) {
  registerProjectSessionStatusRoutes(app, database, deps);
  registerProjectInsightRoutes(app, database);
  registerProjectContextRebuildRoutes(app, database);
}

