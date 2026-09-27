// GitHub: tipos, constantes, peticiones a la API, configuracion y token de la GitHub App e instalaciones.
// Movido sin cambios desde src/services/github-app.ts (solo se agrego "export" y los imports); src/services/github-app.ts lo reexporta.
import { createSign, randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { trimText } from "./text-utils.js";

export type GithubRequestOptions = {
  method?: string;
  token?: string;
  body?: unknown;
};

export type GithubAppConfig = {
  configured: boolean;
  appId: string;
  appSlug: string;
  privateKey: string;
  setupUrl: string;
  apiBaseUrl: string;
  installUrl: string;
  missing: string[];
};

export type GithubInstallationDetails = {
  id: number;
  account?: {
    login?: string;
    type?: string;
  };
  repository_selection?: string;
};

export type GithubInstallationSummary = {
  id: number;
  account?: {
    login?: string;
    type?: string;
  };
  repository_selection?: string;
};

export type GithubRepoInfo = {
  default_branch: string;
};

export type GithubPullRequestSummary = {
  number?: number;
  html_url?: string;
  state?: string;
  merged_at?: string | null;
  title?: string;
  body?: string;
  head?: {
    ref?: string;
  };
};

export type GithubCodespaceSummary = {
  name?: string;
  display_name?: string;
  state?: string;
  web_url?: string;
  url?: string;
  start_url?: string;
  created_at?: string;
  updated_at?: string;
  repository?: {
    full_name?: string;
  };
  git_status?: {
    ref?: string;
  };
  pulls_url?: string;
};

export type JsonObject = Record<string, unknown>;

export type RepoFileSnapshot = {
  sha: string | null;
  content: string | null;
};

export type RepoBootstrapSignals = {
  hasDevcontainerFile: boolean;
  hasInstallScriptFile: boolean;
  hasWorkspaceExtensionsFile: boolean;
  hasDevcontainerMarker: boolean;
  hasInstallScriptMarker: boolean;
  hasWorkspaceExtensionsMarker: boolean;
};

export const ADACEEN_EXTENSION_ID = "adaceen.adaceen";

export const DEVCONTAINER_PATH = ".devcontainer/devcontainer.json";

export const INSTALL_SCRIPT_PATH = ".devcontainer/install-extensions.sh";

export const WORKSPACE_EXTENSIONS_PATH = ".vscode/extensions.json";

export const ADACEEN_VSIX_REPO_PATH = ".devcontainer/adaceen.vsix";

export const ADACEEN_INSTALL_SCRIPT_VERSION = "2026-06-29-rag-actions-vsix-refresh";

export const FALLBACK_INSTALL_COMMAND = "bash .devcontainer/install-extensions.sh || true";

export function toBase64Url(value: string | Buffer) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function parseRepoFullName(repoFullName: string) {
  const clean = trimText(repoFullName).replace(/^https?:\/\/github\.com\//i, "");
  const parts = clean.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("repoFullName invalido. Usa formato owner/repo.");
  }

  return {
    owner: parts[0],
    repo: parts[1].replace(/\.git$/i, ""),
    fullName: `${parts[0]}/${parts[1].replace(/\.git$/i, "")}`,
  };
}

export async function githubRequest<T = unknown>(path: string, options: GithubRequestOptions = {}) {
  const url = `${env.githubApiBaseUrl}${path}`;
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json; charset=utf-8",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "adaceen-github-app/1.0",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body == null ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text || null;
  }

  if (!response.ok) {
    const details = typeof json === "object" && json && "message" in json
      ? String((json as { message?: unknown }).message || "")
      : "";
    throw new Error(formatGithubApiError(response.status, path, details));
  }

  return json as T;
}

export function formatGithubApiError(status: number, path: string, details: string) {
  const cleanDetails = trimText(details);
  const lower = `${path} ${cleanDetails}`.toLowerCase();
  const prefix = `GitHub API ${status} ${path}`;

  if (path.includes("/codespaces")) {
    const limitSignals = [
      "maximum",
      "too many",
      "limit",
      "quota",
      "spending",
      "usage",
      "exceeded",
      "cannot create more",
    ];
    if (limitSignals.some((signal) => lower.includes(signal))) {
      return [
        "Limite de Codespaces alcanzado en tu cuenta de GitHub.",
        "Cierra, detiene o elimina Codespaces que no estes usando en https://github.com/codespaces y vuelve a intentar.",
        cleanDetails ? `Detalle GitHub: ${cleanDetails}` : prefix,
      ].join(" ");
    }

    if (lower.includes("disabled") || lower.includes("not enabled")) {
      return [
        "Codespaces no esta habilitado para esta cuenta, organizacion o repositorio.",
        "Activalo en GitHub o pide acceso al propietario.",
        cleanDetails ? `Detalle GitHub: ${cleanDetails}` : prefix,
      ].join(" ");
    }
  }

  return `${prefix}${cleanDetails ? `: ${cleanDetails}` : ""}`;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getGithubAppConfig(): GithubAppConfig {
  const missing: string[] = [];
  if (!env.githubAppId) missing.push("GITHUB_APP_ID");
  if (!env.githubAppSlug) missing.push("GITHUB_APP_SLUG");
  if (!env.githubAppPrivateKey) missing.push("GITHUB_APP_PRIVATE_KEY");

  const installUrl = env.githubAppSlug
    ? `https://github.com/apps/${encodeURIComponent(env.githubAppSlug)}/installations/new`
    : "";

  return {
    configured: missing.length === 0,
    appId: env.githubAppId,
    appSlug: env.githubAppSlug,
    privateKey: env.githubAppPrivateKey,
    setupUrl: env.githubAppSetupUrl,
    apiBaseUrl: env.githubApiBaseUrl,
    installUrl,
    missing,
  };
}

export function buildGithubAppInstallUrl(state: string) {
  const config = getGithubAppConfig();
  if (!config.configured) {
    throw new Error(`GitHub App no configurada. Faltan: ${config.missing.join(", ")}`);
  }

  return `${config.installUrl}?state=${encodeURIComponent(state)}`;
}

export function generateInstallStateToken() {
  return randomBytes(20).toString("hex");
}

export function createGithubAppJwt() {
  const config = getGithubAppConfig();
  if (!config.configured) {
    throw new Error(`GitHub App no configurada. Faltan: ${config.missing.join(", ")}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const header = toBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = toBase64Url(JSON.stringify({
    iat: now - 60,
    exp: now + 540,
    iss: config.appId,
  }));

  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(config.privateKey);
  const encodedSignature = toBase64Url(signature);
  return `${signingInput}.${encodedSignature}`;
}

export async function fetchGithubInstallationDetails(installationId: string) {
  const appJwt = createGithubAppJwt();
  return githubRequest<GithubInstallationDetails>(`/app/installations/${encodeURIComponent(installationId)}`, {
    token: appJwt,
  });
}

export async function listGithubAppInstallations() {
  const appJwt = createGithubAppJwt();
  return githubRequest<GithubInstallationSummary[]>("/app/installations", {
    token: appJwt,
  });
}

export async function fetchGithubInstallationToken(installationId: string) {
  const appJwt = createGithubAppJwt();
  return githubRequest<{
    token: string;
    expires_at: string;
    permissions?: Record<string, string>;
    repository_selection?: string;
  }>(
    `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: "POST",
      token: appJwt,
      body: {},
    },
  );
}

export async function installationCanAccessRepo(installationToken: string, repoFullName: string) {
  const repo = parseRepoFullName(repoFullName);
  try {
    await githubRequest(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`, {
      token: installationToken,
    });
    return true;
  } catch {
    return false;
  }
}

export async function findGithubInstallationForRepo(repoFullName: string) {
  const installs = await listGithubAppInstallations();
  const items = Array.isArray(installs) ? installs : [];

  for (const item of items) {
    const installationId = String(item?.id || "").trim();
    if (!installationId) continue;

    try {
      const token = await fetchGithubInstallationToken(installationId);
      const hasAccess = await installationCanAccessRepo(token.token, repoFullName);
      if (!hasAccess) continue;

      return {
        installationId,
        accountLogin: trimText(item?.account?.login),
        accountType: trimText(item?.account?.type),
        repositorySelection: trimText(item?.repository_selection),
      };
    } catch {
      continue;
    }
  }

  return null;
}
