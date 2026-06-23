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
  // Modo de operación: "local" o "azure"
  targetMode: readString("AGENT_TARGET", "local").toLowerCase(),
  // URL del servidor Azure (sin barra al final), requerido si AGENT_TARGET=azure
  azureServer: trimTrailingSlash(readString("AZURE_SERVER_URL")),
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
};

export function isAzureMode() {
  return env.targetMode === "azure";
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
