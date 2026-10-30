import path from "node:path";
import type express from "express";
import type { AppDatabase } from "../db/database.js";
import { createImageUploadMiddleware } from "../http/image-upload.js";
import { latestVscodeVersionProvider } from "../services/download-versions.js";
import { registerAdminRoutes } from "./admin-routes.js";
import { registerAgentRoutes } from "./agent-routes.js";
import { createExtensionUpdateNotifier, type ExtensionUpdateNotifier } from "../services/extension-update-notice.js";
import { registerAuthRoutes } from "./auth-routes.js";
import { registerBehaviorRoutes } from "./behavior-routes.js";
import { registerCampusRoutes } from "./campus-routes.js";
import { registerClassRoutes, type ClassRouteDeps } from "./class-routes.js";
import { registerDocumentRoutes } from "./document-routes.js";
import { registerEditorAuthRoutes, type EditorAuthDeps } from "./editor-auth-routes.js";
import { registerGithubAppRoutes } from "./github-app-routes.js";
import { registerHealthRoutes } from "./health-routes.js";
import { registerMaintenanceRoutes } from "./maintenance-routes.js";
import { registerPolicyRoutes } from "./policy-routes.js";
import { registerPrivacyPolicyRoutes } from "./privacy-policy-routes.js";
import { registerProjectContextRoutes } from "./project-context-routes.js";
import { registerPilotRoutes } from "./pilot-routes.js";
import { registerProjectScanRoutes } from "./project-scan-routes.js";
import { registerQuizRoutes } from "./quiz-routes.js";
import { registerRagRoutes } from "./rag-routes.js";
import { createSessionStateMiddleware } from "./route-utils.js";
import { registerStartPageRoutes } from "./start-page-routes.js";
import { registerTeacherMonitorPageRoutes } from "./teacher-monitor-page-routes.js";
import { registerTeacherQuizPageRoutes } from "./teacher-quiz-page-routes.js";
import { registerStudentProgressRoutes } from "./student-progress-routes.js";
import { registerLearningAnalyticsRoutes } from "./learning-analytics-routes.js";
import { registerSuggestionRoutes } from "./suggestion-routes.js";
import { registerTelemetryRoutes } from "./telemetry-routes.js";
import { registerUiTabRoutes } from "./ui-tab-routes.js";
import { createVscodePresenceMiddleware, registerVscodePresenceRoutes } from "./vscode-presence-routes.js";
import { registerWorkspaceRoutes, type WorkspaceRouteDeps } from "./workspace-routes.js";

// Dependencias inyectables (pruebas de integracion). Vacio = produccion.
export type RouteDeps = {
  workspace?: WorkspaceRouteDeps;
  editorAuth?: EditorAuthDeps;
  classStart?: ClassRouteDeps;
  /** Carpeta con descargas/versiones.json y los manifiestos; vacio = process.cwd(). */
  rootDir?: string;
  /** Aviso de version nueva de la extension del navegador (pruebas: version de la tienda fija). */
  extensionUpdate?: ExtensionUpdateNotifier;
};

export function registerRoutes(app: express.Express, database: AppDatabase, deps: RouteDeps = {}) {
  const imageUpload = createImageUploadMiddleware();
  // La version publicada de la extension de VS Code (a lo sumo una lectura del disco por minuto):
  // con ella comparan la guia del tunel (GET /api/vscode/presence) y la linea «VS Code» de Inicio.
  const rootDir = path.resolve(deps.rootDir || process.cwd());
  const latestVscodeVersion = latestVscodeVersionProvider(rootDir);

  // Antes de todas las rutas: marca las respuestas cuyo x-session-id no vale.
  app.use(createSessionStateMiddleware(database));
  // Despues: anota que extension de VS Code llama y desde que editor (guia del tunel).
  app.use(createVscodePresenceMiddleware(database));

  registerHealthRoutes(app, database);
  registerMaintenanceRoutes(app, database);
  registerPrivacyPolicyRoutes(app);
  registerStartPageRoutes(app, deps.rootDir ? { rootDir } : {});
  registerVscodePresenceRoutes(app, database, { latestVscodeVersion });
  registerTeacherQuizPageRoutes(app);
  registerTeacherMonitorPageRoutes(app, database);
  registerAuthRoutes(app, database);
  registerEditorAuthRoutes(app, database, deps.editorAuth);
  registerAdminRoutes(app, database);
  registerStudentProgressRoutes(app, database);
  registerLearningAnalyticsRoutes(app, database);
  registerBehaviorRoutes(app, database);
  registerCampusRoutes(app, database);
  registerDocumentRoutes(app, database);
  registerProjectScanRoutes(app, database);
  registerProjectContextRoutes(app, database, { latestVscodeVersion });
  registerGithubAppRoutes(app, database);
  registerPolicyRoutes(app, database);
  registerPilotRoutes(app, database);
  registerQuizRoutes(app, database);
  registerRagRoutes(app, database);
  registerAgentRoutes(app, database, imageUpload, {
    extensionUpdate: deps.extensionUpdate || createExtensionUpdateNotifier({ rootDir }),
  });
  registerSuggestionRoutes(app, database);
  registerTelemetryRoutes(app, database);
  registerUiTabRoutes(app, database);
  registerWorkspaceRoutes(app, database, deps.workspace);
  registerClassRoutes(app, database, deps.classStart);
}
