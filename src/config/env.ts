import { trimText } from "../services/text-utils.js";

function readString(name: string, fallback = "") {
  return (process.env[name] || fallback).trim();
}

function readNumber(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readCsv(name: string, fallback = "") {
  const raw = readString(name);
  return (raw || fallback)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function readPositiveNumber(name: string, fallback: number) {
  const parsed = readNumber(name, fallback);
  return parsed > 0 ? parsed : fallback;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export const env = {
  // Modo de operación: "local", "azure" o "queue"
  targetMode: readString("AGENT_TARGET", "local").toLowerCase(),
  // URL del servidor Azure (sin barra al final), requerido si AGENT_TARGET=azure
  azureServer: trimTrailingSlash(readString("AZURE_SERVER_URL")),
  serviceBusConnectionString: readString("AZURE_SERVICEBUS_CONNECTION_STRING"),
  jobsQueueName: readString("JOBS_QUEUE_NAME", "adaceen-jobs") || "adaceen-jobs",
  resultsQueueName: readString("RESULTS_QUEUE_NAME", "adaceen-results") || "adaceen-results",
  workerSharedSecret: readString("WORKER_SHARED_SECRET"),
  queueRequestTimeoutMs: readPositiveNumber("QUEUE_REQUEST_TIMEOUT_MS", 120000),
  // Worker queue: intentos entre workers antes de responder error, pausa tras liberar un job
  // y ventana de renovacion automatica del lock (0 = derivar de QUEUE_REQUEST_TIMEOUT_MS).
  queueWorkerMaxAttempts: Math.floor(readPositiveNumber("QUEUE_WORKER_MAX_ATTEMPTS", 3)),
  queueWorkerRetryDelayMs: Math.max(0, readNumber("QUEUE_WORKER_RETRY_DELAY_MS", 2000)),
  queueWorkerLockRenewalMs: Math.max(0, readNumber("QUEUE_WORKER_LOCK_RENEWAL_MS", 0)),
  // Transporte de Service Bus: amqp (puerto 5671) o websockets (HTTPS, puerto 443; con HTTPS_PROXY si lo hay).
  // Las Mac del laboratorio usan websockets porque la red de la universidad solo deja salir HTTPS.
  serviceBusTransport: readString("SERVICE_BUS_TRANSPORT", "amqp").toLowerCase(),
  // Jobs que un worker atiende a la vez (1 a 8) y tipos que acepta (text, image).
  queueWorkerConcurrency: Math.min(8, Math.max(1, Math.floor(readNumber("QUEUE_WORKER_CONCURRENCY", 1)))),
  queueWorkerKinds: readCsv("QUEUE_WORKER_KINDS", "text,image"),
  // normal: compite por cada job. backup (respaldo): solo toma jobs que nadie
  // tomo, para que una Mac lenta no suba la latencia mientras la GPU esta libre.
  queueWorkerPriority: readString("QUEUE_WORKER_PRIORITY", "normal").toLowerCase(),
  queueWorkerBackupIdleMs: Math.max(500, readNumber("QUEUE_WORKER_BACKUP_IDLE_MS", 3000)),
  publicApiUrl: trimTrailingSlash(readString("PUBLIC_API_URL")),

  // Orígenes permitidos para CORS, separados por comas. Si está vacío, se permiten todos.
  allowedOrigins: readCsv("ALLOWED_ORIGINS"),
  maxTabContentChars: readNumber("MAX_TAB_CONTENT_CHARS", 12000),
  maxMentorCodeChars: readNumber("MAX_MENTOR_CODE_CHARS", 6000),
  port: readNumber("PORT", 3000),
  dashboardRoute: readString("DASHBOARD_ROUTE", "/dashboard") || "/dashboard",
  uploadsDir: readString("UPLOADS_DIR", "uploads") || "uploads",
  imageUploadMaxBytes: readPositiveNumber("IMAGE_UPLOAD_MAX_BYTES", 8 * 1024 * 1024),
  imageUploadAllowedMimeTypes: readCsv(
    "IMAGE_UPLOAD_ALLOWED_MIME_TYPES",
    "image/png,image/jpeg,image/webp,image/gif,image/bmp,image/tiff",
  ),
  databaseUrl: readString("DATABASE_URL"),
  databaseSslMode: readString("DATABASE_SSL_MODE", "disable").toLowerCase(),

  // GitHub App credentials
  githubAppId: readString("GITHUB_APP_ID"),
  githubAppSlug: readString("GITHUB_APP_SLUG"),
  githubAppPrivateKey: readString("GITHUB_APP_PRIVATE_KEY")
    .replace(/\\n/g, "\n")
    .trim(),
  githubAppSetupUrl: readString("GITHUB_APP_SETUP_URL"),
  githubApiBaseUrl: trimTrailingSlash(readString("GITHUB_API_BASE_URL", "https://api.github.com")),
  githubOAuthClientId: readString("GITHUB_OAUTH_CLIENT_ID"),
  githubOAuthClientSecret: readString("GITHUB_OAUTH_CLIENT_SECRET"),
  githubOAuthCallbackUrl: readString("GITHUB_OAUTH_CALLBACK_URL"),
  githubOAuthScopes: readString("GITHUB_OAUTH_SCOPES", "repo codespace read:user user:email") || "repo codespace read:user user:email",
  githubCodespacesUserToken: readString("GITHUB_CODESPACES_USER_TOKEN"),
  githubCodespacesGeo: readString("GITHUB_CODESPACES_GEO", "UsEast") || "UsEast",
  githubCodespacesWaitTimeoutMs: readPositiveNumber("GITHUB_CODESPACES_WAIT_TIMEOUT_MS", 180000),
  githubCodespacesPollMs: readPositiveNumber("GITHUB_CODESPACES_POLL_MS", 5000),
  projectScansDir: readString("PROJECT_SCANS_DIR"),
  projectScreenshotsDir: readString("PROJECT_SCREENSHOTS_DIR"),
  ragSeedPath: readString("RAG_SEED_PATH", "data/rag/rag_sources_seed.jsonl") || "data/rag/rag_sources_seed.jsonl",
  ragUploadMaxBytes: readPositiveNumber("RAG_UPLOAD_MAX_BYTES", 20 * 1024 * 1024),
  ragMaxExtractedTextChars: readPositiveNumber("RAG_MAX_EXTRACTED_TEXT_CHARS", 180000),
  ragChunkTargetChars: readPositiveNumber("RAG_CHUNK_TARGET_CHARS", 1600),
  ragChunkOverlapChars: readPositiveNumber("RAG_CHUNK_OVERLAP_CHARS", 220),
  ragMinChunkChars: readPositiveNumber("RAG_MIN_CHUNK_CHARS", 320),
  ragMaxChunksPerSource: readPositiveNumber("RAG_MAX_CHUNKS_PER_SOURCE", 180),
  ragMaxSources: readPositiveNumber("RAG_MAX_SOURCES", 5),
  ragPromptMaxChars: readPositiveNumber("RAG_PROMPT_MAX_CHARS", 6000),
  defaultScanSource: readString("DEFAULT_SCAN_SOURCE", "dashboard_explore") || "dashboard_explore",
  defaultScanWorkerId: readString("DEFAULT_SCAN_WORKER_ID", "vscode-ext-worker") || "vscode-ext-worker",
  scanWorkerKey: readString("ADACEEN_SCAN_WORKER_KEY"),
  googleClientId: readString("GOOGLE_CLIENT_ID"),
  googleDefaultPassword: readString("GOOGLE_DEFAULT_PASSWORD"),
  googleAllowedHostedDomain: readString("GOOGLE_ALLOWED_HOSTED_DOMAIN").toLowerCase(),
  privacyContactEmail: readString("PRIVACY_CONTACT_EMAIL"),

  // Telemetria v1.1: sal secreta para seudonimizar a los actores (HMAC-SHA256).
  // Sin ella se usa una sal de desarrollo y el backend avisa en el log.
  telemetrySalt: readString("TELEMETRY_SALT"),
  // Dias que se guardan los eventos antes de que el script de purga los borre.
  telemetryRetentionDays: Math.floor(readPositiveNumber("TELEMETRY_RETENTION_DAYS", 365)),

  // Latido de los workers de GPU (POST /api/agent/heartbeat).
  workerHeartbeatToken: readString("WORKER_HEARTBEAT_TOKEN"),
  // Un worker se considera vivo si mando latido en esta ventana.
  workerHeartbeatStaleMs: readPositiveNumber("WORKER_HEARTBEAT_STALE_MS", 120000),

  // Entornos de los estudiantes: "codespaces" (por defecto) o "tunnel" (VS Code Tunnels en Google Cloud).
  workspaceProvider: readString("ADACEEN_WORKSPACE_PROVIDER", "codespaces").toLowerCase() === "tunnel"
    ? "tunnel" as const
    : "codespaces" as const,
  // Agente HTTP de la VM de editores (fase 2 del plan de tuneles).
  workspaceAgentUrl: trimTrailingSlash(readString("WORKSPACE_AGENT_URL")),
  workspaceAgentToken: readString("WORKSPACE_AGENT_TOKEN"),
  workspaceAgentTimeoutMs: readPositiveNumber("WORKSPACE_AGENT_TIMEOUT_MS", 15000),
  // Como llega PDC al agente: "direct" (HTTP a WORKSPACE_AGENT_URL) o "relay"
  // (el agente consulta a PDC; para la VM sin IP publica). Vacio: relay si no hay URL.
  workspaceAgentTransport: readString("WORKSPACE_AGENT_TRANSPORT").toLowerCase(),
  // Logins de GitHub autorizados en el piloto (vacio o "*" = cualquiera con cuenta conectada).
  workspaceAllowedLogins: readCsv("WORKSPACE_ALLOWED_LOGINS").map((login) => login.toLowerCase()),
  // Encendido automatico de la VM de editores (acceso simplificado, seccion 5).
  // Vacio = desactivado: con el agente desconectado se responde como siempre.
  workspaceVmAutostart: readString("WORKSPACE_VM_AUTOSTART").toLowerCase(),
  workspaceVmProject: readString("WORKSPACE_VM_PROJECT"),
  workspaceVmZone: readString("WORKSPACE_VM_ZONE"),
  workspaceVmName: readString("WORKSPACE_VM_NAME"),
  // Clave JSON (o en base64) de una cuenta con solo compute.instances.get/start sobre esa VM.
  gcpServiceAccountJson: readString("GCP_SERVICE_ACCOUNT_JSON"),

  // Sesiones de VS Code (emparejadas o escritas por la VM): dias de vigencia.
  editorSessionTtlDays: readPositiveNumber("EDITOR_SESSION_TTL_DAYS", 30),
  // URL publica de este backend que se escribe en la sesion del editor del tunel.
  // Sin PUBLIC_BASE_URL se usa PUBLIC_API_URL y, si tampoco esta, la URL de la peticion.
  publicBaseUrl: trimTrailingSlash(readString("PUBLIC_BASE_URL") || readString("PUBLIC_API_URL")),
};

export function isAzureMode() {
  return env.targetMode === "azure";
}

export function isQueueMode() {
  return env.targetMode === "queue";
}

export function isValidTargetMode() {
  return ["local", "azure", "queue"].includes(env.targetMode);
}

export function isOriginAllowed(origin?: string) {
  if (!origin) return true;
  if (env.allowedOrigins.length === 0) return true;

  const parsedOrigin = (() => {
    try {
      return new URL(origin);
    } catch {
      return null;
    }
  })();
  if (!parsedOrigin) return false;

  const requestedHost = parsedOrigin.hostname.toLowerCase();
  const requestedHostWithPort = `${parsedOrigin.host}`.toLowerCase();
  const requestedOrigin = `${parsedOrigin.protocol}//${parsedOrigin.host}`.toLowerCase();

  return env.allowedOrigins.some((allowedRaw) => {
    const allowed = trimText(allowedRaw).toLowerCase();
    if (!allowed) return false;
    if (allowed === "*") return true;

    if (allowed.includes("://")) {
      try {
        const allowedOrigin = new URL(allowed);
        return allowedOrigin.protocol === parsedOrigin.protocol
          && `${allowedOrigin.host}`.toLowerCase() === requestedHostWithPort;
      } catch {
        return false;
      }
    }

    if (allowed.startsWith("*.")) {
      const suffix = allowed.slice(2);
      return requestedHost === suffix || requestedHost.endsWith(`.${suffix}`);
    }

    if (allowed.includes(":")) {
      return requestedHostWithPort === allowed;
    }

    return requestedHost === allowed || requestedOrigin === `${parsedOrigin.protocol}//${allowed}`.toLowerCase();
  });
}
