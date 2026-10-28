import type express from "express";
import { corsMode, env, isValidTargetMode } from "../config/env.js";
import type { AppDatabase } from "../db/database.js";
import { demoRoutesUntil } from "../services/demo-route-accounts.js";
import { getDefaultVmAutostarter } from "../services/gcp-compute.js";
import { describeGpuAutostart } from "../services/gpu-autostart.js";
import { readMaintenance } from "../services/maintenance.js";
import { describeBackupForHealth, readBackupReport } from "../services/workspace-backup.js";
import { describeWorkshopProgressForHealth, readProgressReport } from "../services/workshop-progress.js";
import { getGithubAppConfig } from "../services/github-app.js";
import { getGithubOAuthConfig } from "../services/github-oauth.js";
import { describeGithubOAuthCallback } from "../services/github-oauth-callback-state.js";
import { getServiceBusQueueConfig } from "../services/service-bus-agent.js";
import { countAliveWorkers, isInferenceKnownDown } from "../services/worker-heartbeat.js";
import { describeQueueHealth } from "../services/queue-health.js";
import { describeExamReference } from "../services/exam-reference.js";
import { resolveWorkspaceConfig } from "../services/workspace-provider.js";
import { readWorkspaceProviderChoice, resolveWorkspaceProviderState } from "../services/workspace-provider-choice.js";
import { workspaceRelay } from "../services/workspace-relay.js";
import { resolveGithubOAuthCallbackUrl } from "./github-oauth-routes.js";
import { PRIVACY_POLICY_VERSION } from "./privacy-policy-routes.js";

/**
 * Entorno de los estudiantes, su agente y los workers del modelo, tal como los
 * muestra /api/health. Lo reutiliza el monitor del piloto (GET /api/pilot/monitor)
 * en el propio servidor, sin pasar por HTTP.
 */
export async function describeWorkspaceHealth(database: AppDatabase) {
  // Entorno activo (0.7.19): el que se eligio en la tuerca de la extension o la variable.
  const workspace = resolveWorkspaceProviderState(env.workspaceProvider, await readWorkspaceProviderChoice(database));
  const tunnelInUse = workspace.provider === "tunnel" || workspace.serverProvider === "tunnel";
  const autostarter = tunnelInUse ? getDefaultVmAutostarter() : null;
  return {
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
    // Horario del tutor (GPU_SCHEDULE) y autoencendido de noche: el ultimo intento, si funciono y
    // por que no (28-10-2026, src/services/gpu-autostart.ts).
    gpu_autostart: describeGpuAutostart(),
    // Ultima copia de respaldo del trabajo de los estudiantes (VM de editores, cada 15 min).
    workspace_backup: describeBackupForHealth(await readBackupReport(database)),
    // Ultimo informe del avance de los talleres (VM de editores, cada 10 min): solo cuando y cuantos.
    workshop_progress: describeWorkshopProgressForHealth(await readProgressReport(database)),
    // La cola llega o no al worker aunque tenga latido (examen 28-10-2026, queue-health.ts).
    ...describeQueueHealth(),
    // Conectar GitHub (la primera vez que un estudiante abre su editor): la direccion de regreso
    // que manda ADACEEN y si GitHub la acepta (verificado, rechazado o sin_verificar).
    ...(await describeGithubOAuthCallback(database, resolveGithubOAuthCallbackUrl(), getGithubOAuthConfig().configured)),
  };
}

export function registerHealthRoutes(app: express.Express, database: AppDatabase) {
  app.get(["/health", "/api/health"], async (_req, res) => {
    const githubConfig = getGithubAppConfig();
    const queueConfig = getServiceBusQueueConfig();
    const workspace = await describeWorkspaceHealth(database);
    const maintenance = await readMaintenance(database);
    res.json({
      ok: true,
      // Aviso «Estamos actualizando» (src/services/maintenance.ts).
      maintenance: { active: maintenance.active, message: maintenance.active ? maintenance.message : null, until: maintenance.active ? maintenance.until : null },
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
      ...workspace,
      telemetry_retention_days: env.telemetryRetentionDays,
      privacy_policy_version: PRIVACY_POLICY_VERSION,
      // Cuentas demo de seeds.ts: en produccion SEED_DEMO_ACCOUNTS=false y 0 activas (lo comprueba
      // deploy/produccion.sh verificar). Con seeded true pueden ser 3.
      demo_accounts_seeded: env.seedDemoAccounts,
      demo_accounts_active: await database.countActiveDemoAccounts(),
      // Cuentas de prueba por rol (TEST_ACCOUNTS_PASSWORD): 6 con la variable, 0 sin ella.
      test_accounts_active: await database.countActiveTestAccounts(),
      // Cuentas demo por ruta (DEMO_RUTAS_PASSWORD): 16 con la variable hasta su ultimo dia, 0 sin ella.
      demo_route_accounts_active: await database.countActiveDemoRouteAccounts(),
      demo_route_accounts_until: env.demoRoutesPassword ? demoRoutesUntil(env.demoRoutesUntil).until : null,
      // "default": solo los origenes de ADACEEN; "custom": ALLOWED_ORIGINS; "open": "*" (A12.12).
      cors_mode: corsMode(),
      // Examen 28-10-2026: si el tutor tiene la referencia privada (EXAM_REFERENCE_B64), sin contenido.
      ...describeExamReference(),
    });
  });
}
