import type express from "express";
import { env, isValidTargetMode } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { getGithubAppConfig } from "../services/github-app.js";
import { getServiceBusQueueConfig } from "../services/service-bus-agent.js";
import { workspaceRelay } from "../services/workspace-relay.js";
import { PRIVACY_POLICY_VERSION } from "./privacy-policy-routes.js";

export function registerHealthRoutes(app: express.Express, database: AppDatabase) {
  app.get(["/health", "/api/health"], (_req, res) => {
    const githubConfig = getGithubAppConfig();
    const queueConfig = getServiceBusQueueConfig();
    res.json({
      ok: true,
      mode: isValidTargetMode() ? env.targetMode : "invalid",
      target_mode_valid: isValidTargetMode(),
      azure_server: env.targetMode === "azure" ? env.azureServer || null : null,
      queue_configured: queueConfig.configured,
      queue_missing_config: queueConfig.missing,
      jobs_queue_name: env.targetMode === "queue" ? queueConfig.jobsQueueName : null,
      results_queue_name: env.targetMode === "queue" ? queueConfig.resultsQueueName : null,
      max_tab_content_chars: env.maxTabContentChars,
      max_mentor_code_chars: env.maxMentorCodeChars,
      database_provider: database.provider,
      github_app_configured: githubConfig.configured,
      github_app_slug: githubConfig.appSlug || null,
      google_auth_configured: Boolean(env.googleClientId),
      // Comprobaciones del runbook antes de cada sesion (sin exponer valores).
      telemetry_salt_configured: Boolean(env.telemetrySalt),
      worker_heartbeat_configured: Boolean(env.workerHeartbeatToken),
      workspace_provider: env.workspaceProvider,
      workspace_agent_online: workspaceRelay.isAgentOnline(),
      telemetry_retention_days: env.telemetryRetentionDays,
      privacy_policy_version: PRIVACY_POLICY_VERSION,
    });
  });
}
