import type express from "express";
import { env } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { getGithubAppConfig } from "../services/github-app.js";

export function registerHealthRoutes(app: express.Express, database: AppDatabase) {
  app.get("/health", (_req, res) => {
    const githubConfig = getGithubAppConfig();
    res.json({
      ok: true,
      mode: env.targetMode === "azure" ? "azure" : "local",
      azure_server: env.targetMode === "azure" ? env.azureServer || null : null,
      max_tab_content_chars: env.maxTabContentChars,
      max_mentor_code_chars: env.maxMentorCodeChars,
      database_provider: database.provider,
      github_app_configured: githubConfig.configured,
      github_app_slug: githubConfig.appSlug || null,
      google_auth_configured: Boolean(env.googleClientId),
    });
  });
}
