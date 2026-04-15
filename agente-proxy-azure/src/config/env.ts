export const env = {
  targetMode: (process.env.AGENT_TARGET || "local").trim().toLowerCase(),
  azureServer: (process.env.AZURE_SERVER_URL || "").trim().replace(/\/+$/, ""),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  maxTabContentChars: +(process.env.MAX_TAB_CONTENT_CHARS || 12000),
  maxMentorCodeChars: +(process.env.MAX_MENTOR_CODE_CHARS || 6000),
  port: +(process.env.PORT || 3000),
  databaseUrl: (process.env.DATABASE_URL || "").trim(),
  databaseSslMode: (process.env.DATABASE_SSL_MODE || "disable").trim().toLowerCase(),
  githubAppId: (process.env.GITHUB_APP_ID || "").trim(),
  githubAppSlug: (process.env.GITHUB_APP_SLUG || "").trim(),
  githubAppPrivateKey: (process.env.GITHUB_APP_PRIVATE_KEY || "")
    .replace(/\\n/g, "\n")
    .trim(),
  githubAppSetupUrl: (process.env.GITHUB_APP_SETUP_URL || "").trim(),
  githubApiBaseUrl: (process.env.GITHUB_API_BASE_URL || "https://api.github.com").trim().replace(/\/+$/, ""),
  projectScansDir: (process.env.PROJECT_SCANS_DIR || "").trim(),
  scanWorkerKey: (process.env.ADACEEN_SCAN_WORKER_KEY || "").trim(),
  googleClientId: (process.env.GOOGLE_CLIENT_ID || "").trim(),
  googleDefaultPassword: (process.env.GOOGLE_DEFAULT_PASSWORD || "").trim(),
  googleAllowedHostedDomain: (process.env.GOOGLE_ALLOWED_HOSTED_DOMAIN || "").trim().toLowerCase(),
};

export function isAzureMode() {
  return env.targetMode === "azure";
}

export function isOriginAllowed(origin?: string) {
  if (!origin) return true;
  if (env.allowedOrigins.length === 0) return true;
  return env.allowedOrigins.some((allowed) => origin.startsWith(allowed));
}
