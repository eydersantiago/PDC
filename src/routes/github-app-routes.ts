// Rutas de GitHub: registerGithubAppRoutes registra, en este orden, OAuth, GitHub App, preparar el entorno y el PR del devcontainer.
import express from "express";
import type { AppDatabase } from "../db/database.js";
import { registerGithubAppInstallRoutes } from "./github-app-install-routes.js";
import { registerGithubBootstrapRoutes } from "./github-bootstrap-routes.js";
import { registerGithubEnvironmentRoutes } from "./github-environment-routes.js";
import { registerGithubOAuthRoutes } from "./github-oauth-routes.js";

export function registerGithubAppRoutes(app: express.Express, database: AppDatabase) {
  registerGithubOAuthRoutes(app, database);
  registerGithubAppInstallRoutes(app, database);
  registerGithubEnvironmentRoutes(app, database);
  registerGithubBootstrapRoutes(app, database);
}
