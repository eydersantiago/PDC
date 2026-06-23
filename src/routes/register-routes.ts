import type express from "express";
import type { AppDatabase } from "../db/database.js";
import { createImageUploadMiddleware } from "../http/image-upload.js";
import { registerAdminRoutes } from "./admin-routes.js";
import { registerAgentRoutes } from "./agent-routes.js";
import { registerAuthRoutes } from "./auth-routes.js";
import { registerBehaviorRoutes } from "./behavior-routes.js";
import { registerCampusRoutes } from "./campus-routes.js";
import { registerDocumentRoutes } from "./document-routes.js";
  import { registerGithubAppRoutes } from "./github-app-routes.js";
  import { registerHealthRoutes } from "./health-routes.js";
  import { registerPolicyRoutes } from "./policy-routes.js";
  import { registerProjectContextRoutes } from "./project-context-routes.js";
  import { registerProjectScanRoutes } from "./project-scan-routes.js";
  import { registerRagRoutes } from "./rag-routes.js";
  import { registerUiTabRoutes } from "./ui-tab-routes.js";

export function registerRoutes(app: express.Express, database: AppDatabase) {
  const imageUpload = createImageUploadMiddleware();

  registerHealthRoutes(app, database);
  registerAuthRoutes(app, database);
  registerAdminRoutes(app, database);
  registerBehaviorRoutes(app, database);
  registerCampusRoutes(app, database);
  registerDocumentRoutes(app, database);
  registerProjectScanRoutes(app, database);
  registerProjectContextRoutes(app, database);
  registerGithubAppRoutes(app, database);
  registerPolicyRoutes(app, database);
  registerRagRoutes(app, database);
  registerAgentRoutes(app, database, imageUpload);
  registerUiTabRoutes(app, database);
}
