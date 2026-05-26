function readEnv(name: string) {
  return (process.env[name] || "").trim();
}

function readUrlEnv(name: string) {
  return readEnv(name).replace(/\/+$/, "");
}

function readPositiveIntEnv(name: string, fallback: number) {
  const value = readEnv(name);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.round(parsed));
}

function databaseUrlRequestsSsl(databaseUrl: string) {
  return /[?&]sslmode=(require|verify-ca|verify-full)(?:&|$)/i.test(databaseUrl);
}

function readDatabaseSslMode(databaseUrl: string) {
  const configured = readEnv("DATABASE_SSL_MODE").toLowerCase();
  if (!configured || configured === "auto") {
    return databaseUrlRequestsSsl(databaseUrl) ? "require" : "disable";
  }
  return configured;
}

const databaseUrl = readEnv("DATABASE_URL");
const azureServer = readUrlEnv("AZURE_SERVER_URL") || readUrlEnv("PUBLIC_API_URL");
const publicApiUrl = readUrlEnv("PUBLIC_API_URL") || readUrlEnv("AZURE_SERVER_URL");

export const env = {
  targetMode: (readEnv("AGENT_TARGET") || "local").toLowerCase(),
  azureServer,
  publicApiUrl,
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  maxTabContentChars: readPositiveIntEnv("MAX_TAB_CONTENT_CHARS", 12000),
  maxMentorCodeChars: readPositiveIntEnv("MAX_MENTOR_CODE_CHARS", 6000),
  maxUploadBytes: readPositiveIntEnv("MAX_UPLOAD_BYTES", 8 * 1024 * 1024),
  port: readPositiveIntEnv("PORT", 3000),
  databaseUrl,
  databaseSslMode: readDatabaseSslMode(databaseUrl),
  serviceBusConnectionString: readEnv("AZURE_SERVICEBUS_CONNECTION_STRING"),
  jobsQueueName: readEnv("JOBS_QUEUE_NAME") || "llm-jobs",
  resultsQueueName: readEnv("RESULTS_QUEUE_NAME") || "llm-results",
  workerSharedSecret: readEnv("WORKER_SHARED_SECRET"),
  privacyContactEmail: readEnv("PRIVACY_CONTACT_EMAIL"),
};

export function isAzureMode() {
  return env.targetMode === "azure";
}

export function isQueueMode() {
  return env.targetMode === "queue";
}

export function isOriginAllowed(origin?: string) {
  if (!origin) return true;
  if (env.allowedOrigins.length === 0) return true;
  return env.allowedOrigins.some((allowed) => origin.startsWith(allowed));
}
