import type express from "express";
import { corsMode, env, isValidTargetMode } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { getDefaultVmAutostarter } from "../services/gcp-compute.js";
import { getGithubAppConfig } from "../services/github-app.js";
import { getServiceBusQueueConfig } from "../services/service-bus-agent.js";
import { countAliveWorkers, isInferenceKnownDown } from "../services/worker-heartbeat.js";
import { resolveWorkspaceConfig } from "../services/workspace-provider.js";
import { readWorkspaceProviderChoice, resolveWorkspaceProviderState } from "../services/workspace-provider-choice.js";
import { workspaceRelay } from "../services/workspace-relay.js";
import { PRIVACY_POLICY_VERSION } from "./privacy-policy-routes.js";

export function registerHealthRoutes(app: express.Express, database: AppDatabase) {
  app.get(["/health", "/api/health"], async (_req, res) => {
    const githubConfig = getGithubAppConfig();
    const queueConfig = getServiceBusQueueConfig();
    // Entorno activo (0.7.19): el que se eligio en la tuerca de la extension o la variable.
    const workspace = resolveWorkspaceProviderState(env.workspaceProvider, await readWorkspaceProviderChoice(database));
    const tunnelInUse = workspace.provider === "tunnel" || workspace.serverProvider === "tunnel";
    const autostarter = tunnelInUse ? getDefaultVmAutostarter() : null;
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
      workspace_provider: workspace.provider,
      // "extension" si lo eligio un administrador o docente en la tuerca; workspace_provider_server es
      // ADACEEN_WORKSPACE_PROVIDER, lo que configura y comprueba deploy/produccion.sh.
      workspace_provider_source: workspace.source,
      workspace_provider_server: workspace.serverProvider,
      workspace_agent_online: workspaceRelay.isAgentOnline(),
      // Para /empezar: como llega el backend al agente, si enciende la VM solo
      // y cuantos workers del modelo mandaron latido (sin nombres ni tokens).
      // known_down solo es true si hubo latidos y todos vencieron: sin token
      // de latidos o recien reiniciado el backend no se sabe (y no se alarma).
      workspace_agent_transport: tunnelInUse ? resolveWorkspaceConfig().transport : null,
      workspace_vm_autostart: Boolean(autostarter),
      // Con que entra el backend a Google Cloud: "key" (GCP_SERVICE_ACCOUNT_JSON) o
      // "federation" (identidad administrada de Azure, sin clave); null sin autoencendido.
      workspace_vm_auth: autostarter?.authMode ?? null,
      model_workers_alive: countAliveWorkers(),
      model_workers_known_down: isInferenceKnownDown(),
      telemetry_retention_days: env.telemetryRetentionDays,
      privacy_policy_version: PRIVACY_POLICY_VERSION,
      // "default": solo los origenes de ADACEEN; "custom": ALLOWED_ORIGINS; "open": "*" (A12.12).
      cors_mode: corsMode(),
    });
  });
}
