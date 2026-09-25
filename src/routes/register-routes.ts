import type express from "express";
import type { AppDatabase } from "../db/database.js";
import { createImageUploadMiddleware } from "../http/image-upload.js";
import { registerAdminRoutes } from "./admin-routes.js";
import { registerAgentRoutes } from "./agent-routes.js";
import { registerAuthRoutes } from "./auth-routes.js";
import { registerBehaviorRoutes } from "./behavior-routes.js";
import { registerCampusRoutes } from "./campus-routes.js";
import { registerDocumentRoutes } from "./document-routes.js";
import { registerEditorAuthRoutes, type EditorAuthDeps } from "./editor-auth-routes.js";
import { registerGithubAppRoutes } from "./github-app-routes.js";
import { registerHealthRoutes } from "./health-routes.js";
import { registerPolicyRoutes } from "./policy-routes.js";
import { registerPrivacyPolicyRoutes } from "./privacy-policy-routes.js";
import { registerProjectContextRoutes } from "./project-context-routes.js";
import { registerPilotRoutes } from "./pilot-routes.js";
import { registerProjectScanRoutes } from "./project-scan-routes.js";
import { registerQuizRoutes } from "./quiz-routes.js";
import { registerRagRoutes } from "./rag-routes.js";
import { createSessionStateMiddleware } from "./route-utils.js";
import { registerStartPageRoutes } from "./start-page-routes.js";
import { registerSuggestionRoutes } from "./suggestion-routes.js";
import { registerTelemetryRoutes } from "./telemetry-routes.js";
import { registerUiTabRoutes } from "./ui-tab-routes.js";
import { registerWorkspaceRoutes, type WorkspaceRouteDeps } from "./workspace-routes.js";

// Dependencias inyectables (pruebas de integracion). Vacio = produccion.
export type RouteDeps = {
  workspace?: WorkspaceRouteDeps;
  editorAuth?: EditorAuthDeps;
};

export function registerRoutes(app: express.Express, database: AppDatabase, deps: RouteDeps = {}) {
  const imageUpload = createImageUploadMiddleware();

  // Antes de todas las rutas: marca las respuestas cuyo x-session-id no vale.
  app.use(createSessionStateMiddleware(database));

  registerHealthRoutes(app, database);
  registerPrivacyPolicyRoutes(app);
  registerStartPageRoutes(app);
  registerAuthRoutes(app, database);
  registerEditorAuthRoutes(app, database, deps.editorAuth);
  registerAdminRoutes(app, database);
  registerBehaviorRoutes(app, database);
  registerCampusRoutes(app, database);
  registerDocumentRoutes(app, database);
  registerProjectScanRoutes(app, database);
  registerProjectContextRoutes(app, database);
  registerGithubAppRoutes(app, database);
  registerPolicyRoutes(app, database);
  registerPilotRoutes(app, database);
  registerQuizRoutes(app, database);
  registerRagRoutes(app, database);
  registerAgentRoutes(app, database, imageUpload);
  registerSuggestionRoutes(app, database);
  registerTelemetryRoutes(app, database);
  registerUiTabRoutes(app, database);
  registerWorkspaceRoutes(app, database, deps.workspace);
}
