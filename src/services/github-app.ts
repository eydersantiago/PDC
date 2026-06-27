import { createSign, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "../config/env.js";
import { trimText, uniqueStrings } from "./text-utils.js";

type GithubRequestOptions = {
  method?: string;
  token?: string;
  body?: unknown;
};

type GithubAppConfig = {
  configured: boolean;
  appId: string;
  appSlug: string;
  privateKey: string;
  setupUrl: string;
  apiBaseUrl: string;
  installUrl: string;
  missing: string[];
};

type GithubInstallationDetails = {
  id: number;
  account?: {
    login?: string;
    type?: string;
  };
  repository_selection?: string;
};

type GithubInstallationSummary = {
  id: number;
  account?: {
    login?: string;
    type?: string;
  };
  repository_selection?: string;
};

type GithubRepoInfo = {
  default_branch: string;
};

type GithubPullRequestSummary = {
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

type GithubCodespaceSummary = {
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

type JsonObject = Record<string, unknown>;

type RepoFileSnapshot = {
  sha: string | null;
  content: string | null;
};

type RepoBootstrapSignals = {
  hasDevcontainerFile: boolean;
  hasInstallScriptFile: boolean;
  hasWorkspaceExtensionsFile: boolean;
  hasDevcontainerMarker: boolean;
  hasInstallScriptMarker: boolean;
  hasWorkspaceExtensionsMarker: boolean;
};

const ADACEEN_EXTENSION_ID = "adaceen.adaceen";
const DEVCONTAINER_PATH = ".devcontainer/devcontainer.json";
const INSTALL_SCRIPT_PATH = ".devcontainer/install-extensions.sh";
const WORKSPACE_EXTENSIONS_PATH = ".vscode/extensions.json";
const ADACEEN_VSIX_REPO_PATH = ".devcontainer/adaceen-0.0.7.vsix";
const FALLBACK_INSTALL_COMMAND = "bash .devcontainer/install-extensions.sh || true";

function toBase64Url(value: string | Buffer) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function parseRepoFullName(repoFullName: string) {
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

function encodeCodespacesBranch(branchName: string) {
  return trimText(branchName)
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function buildCodespaceQuickstartUrl(input: {
  repoFullName: string;
  pullNumber?: number | null;
  branchName?: string | null;
}) {
  const repo = parseRepoFullName(input.repoFullName);
  const baseUrl = `https://codespaces.new/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
  const pullNumber = Number.isFinite(Number(input.pullNumber))
    ? Math.max(0, Number(input.pullNumber))
    : 0;
  if (pullNumber > 0) {
    return `${baseUrl}/pull/${pullNumber}?quickstart=1`;
  }

  const branchPath = encodeCodespacesBranch(input.branchName || "");
  if (branchPath) {
    return `${baseUrl}/tree/${branchPath}?quickstart=1`;
  }

  return `${baseUrl}?quickstart=1`;
}

export function buildCodespaceWebUrlFromName(name?: string | null) {
  const cleanName = trimText(name);
  return cleanName ? `https://${cleanName}.github.dev` : "";
}

function normalizeCodespacePayload(raw: unknown): GithubCodespaceSummary {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const repository = source.repository && typeof source.repository === "object"
    ? source.repository as Record<string, unknown>
    : {};
  const gitStatus = source.git_status && typeof source.git_status === "object"
    ? source.git_status as Record<string, unknown>
    : {};

  return {
    name: trimText(source.name),
    display_name: trimText(source.display_name),
    state: trimText(source.state),
    web_url: trimText(source.web_url),
    url: trimText(source.url),
    start_url: trimText(source.start_url),
    created_at: trimText(source.created_at),
    updated_at: trimText(source.updated_at),
    pulls_url: trimText(source.pulls_url),
    repository: {
      full_name: trimText(repository.full_name),
    },
    git_status: {
      ref: trimText(gitStatus.ref),
    },
  };
}

function isAdaceenCodespace(item: GithubCodespaceSummary) {
  const displayName = trimText(item.display_name).toLowerCase();
  const name = trimText(item.name).toLowerCase();
  return displayName === "adaceen" || name.includes("adaceen");
}

export function isCodespaceForTarget(
  item: GithubCodespaceSummary,
  input: { repoFullName: string; pullNumber?: number | null; branchName?: string | null },
) {
  const repoMatches = trimText(item.repository?.full_name).toLowerCase() === trimText(input.repoFullName).toLowerCase();
  if (!repoMatches) return false;

  const pullNumber = Number.isFinite(Number(input.pullNumber))
    ? Math.max(0, Number(input.pullNumber))
    : 0;

  const branchName = trimText(input.branchName).toLowerCase();
  const itemBranch = trimText(item.git_status?.ref).toLowerCase();
  if (branchName && itemBranch === branchName) return true;

  const pullsUrl = trimText(item.pulls_url).toLowerCase();
  if (pullNumber > 0 && pullsUrl) {
    if (pullsUrl.endsWith(`/pulls/${pullNumber}`) || pullsUrl.includes(`/pulls/${pullNumber}`)) {
      return true;
    }

    return false;
  }

  if (branchName) {
    return isAdaceenCodespace(item);
  }

  return isAdaceenCodespace(item) || !pullNumber;
}

function codespaceTimestamp(item: GithubCodespaceSummary) {
  const timestamp = Date.parse(trimText(item.updated_at) || trimText(item.created_at));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortCodespacesForAdaceen(a: GithubCodespaceSummary, b: GithubCodespaceSummary) {
  const aAdaceen = trimText(a.display_name).toLowerCase() === "adaceen" ? 1 : 0;
  const bAdaceen = trimText(b.display_name).toLowerCase() === "adaceen" ? 1 : 0;
  if (aAdaceen !== bAdaceen) return bAdaceen - aAdaceen;
  return codespaceTimestamp(b) - codespaceTimestamp(a);
}

async function githubRequest<T = unknown>(path: string, options: GithubRequestOptions = {}) {
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

function formatGithubApiError(status: number, path: string, details: string) {
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCodespaceReadyState(state: string) {
  const normalized = trimText(state).toLowerCase();
  return normalized === "available" || normalized === "ready";
}

function isDevcontainerPathMissingError(error: unknown) {
  const message = trimText(error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("devcontainer")
    && message.includes("does not exist");
}

async function listCodespacesForRepo(input: {
  token: string;
  repoFullName: string;
}) {
  const response = await githubRequest<{ codespaces?: unknown[] }>(
    "/user/codespaces?per_page=100",
    { token: input.token },
  );
  const repoFullName = parseRepoFullName(input.repoFullName).fullName.toLowerCase();

  return (Array.isArray(response.codespaces) ? response.codespaces : [])
    .map((item) => normalizeCodespacePayload(item))
    .filter((item) => trimText(item.repository?.full_name).toLowerCase() === repoFullName);
}

async function getCodespace(input: { token: string; name: string }) {
  const response = await githubRequest(
    `/user/codespaces/${encodeURIComponent(input.name)}`,
    { token: input.token },
  );
  return normalizeCodespacePayload(response);
}

export async function getCodespaceStatusForUser(input: { githubUserToken: string; name: string }) {
  const token = trimText(input.githubUserToken);
  const name = trimText(input.name);
  if (!token || !name) {
    throw new Error("Token de usuario y nombre de Codespace requeridos.");
  }

  const current = await getCodespace({ token, name });
  const state = trimText(current.state).toLowerCase();
  const active = state === "shutdown" || state === "shut down"
    ? await startCodespace({ token, name })
    : current;
  const activeState = trimText(active.state).toLowerCase();
  const webUrl = trimText(active.web_url) || buildCodespaceWebUrlFromName(active.name || name);

  return {
    name: trimText(active.name || name),
    state: trimText(active.state || current.state),
    webUrl,
    ready: isCodespaceReadyState(activeState) && !!webUrl,
  };
}

export async function findCodespaceForTargetForUser(input: {
  githubUserToken: string;
  repoFullName: string;
  pullNumber?: number | null;
  branchName?: string | null;
}) {
  const token = trimText(input.githubUserToken);
  const repoFullName = parseRepoFullName(input.repoFullName).fullName;
  if (!token || !repoFullName) {
    throw new Error("Token de usuario y repositorio requeridos para consultar Codespaces.");
  }

  const matching = (await listCodespacesForRepo({ token, repoFullName }))
    .filter((item) => isCodespaceForTarget(item, input))
    .sort(sortCodespacesForAdaceen);
  const selected = matching[0] || null;
  if (!selected?.name) return null;

  return getCodespaceStatusForUser({
    githubUserToken: token,
    name: selected.name,
  });
}

async function startCodespace(input: { token: string; name: string }) {
  const response = await githubRequest(
    `/user/codespaces/${encodeURIComponent(input.name)}/start`,
    {
      method: "POST",
      token: input.token,
    },
  );
  return normalizeCodespacePayload(response);
}

async function createCodespaceFromPullRequest(input: {
  token: string;
  repoFullName: string;
  pullNumber: number;
  geo?: string;
}) {
  const repo = parseRepoFullName(input.repoFullName);
  const path = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls/${encodeURIComponent(String(input.pullNumber))}/codespaces`;
  const baseBody = {
    ...(trimText(input.geo) ? { geo: trimText(input.geo) } : {}),
    display_name: "ADACEEN",
  };

  try {
    const response = await githubRequest(path, {
      method: "POST",
      token: input.token,
      body: {
        ...baseBody,
        devcontainer_path: DEVCONTAINER_PATH,
      },
    });
    return normalizeCodespacePayload(response);
  } catch (error) {
    if (!isDevcontainerPathMissingError(error)) throw error;

    const response = await githubRequest(path, {
      method: "POST",
      token: input.token,
      body: baseBody,
    });
    return normalizeCodespacePayload(response);
  }
}

async function createCodespaceForRepository(input: {
  token: string;
  repoFullName: string;
  branchName?: string | null;
  geo?: string;
}) {
  const repo = parseRepoFullName(input.repoFullName);
  const path = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/codespaces`;
  const baseBody = {
    ...(trimText(input.branchName) ? { ref: trimText(input.branchName) } : {}),
    ...(trimText(input.geo) ? { geo: trimText(input.geo) } : {}),
    display_name: "ADACEEN",
  };

  try {
    const response = await githubRequest(path, {
      method: "POST",
      token: input.token,
      body: {
        ...baseBody,
        devcontainer_path: DEVCONTAINER_PATH,
      },
    });
    return normalizeCodespacePayload(response);
  } catch (error) {
    if (!isDevcontainerPathMissingError(error)) throw error;

    const response = await githubRequest(path, {
      method: "POST",
      token: input.token,
      body: baseBody,
    });
    return normalizeCodespacePayload(response);
  }
}

async function waitForCodespaceAvailable(input: {
  token: string;
  name: string;
  timeoutMs?: number;
  pollMs?: number;
}) {
  const timeoutMs = Math.max(10000, Number(input.timeoutMs) || 180000);
  const pollMs = Math.max(2000, Number(input.pollMs) || 5000);
  const startedAt = Date.now();
  let latest = await getCodespace({ token: input.token, name: input.name });

  while (Date.now() - startedAt <= timeoutMs) {
    const state = trimText(latest.state).toLowerCase();
    if (isCodespaceReadyState(state)) {
      return latest;
    }
    if (state === "shutdown" || state === "shut down") {
      latest = await startCodespace({ token: input.token, name: input.name });
    }
    await sleep(pollMs);
    latest = await getCodespace({ token: input.token, name: input.name });
  }

  return latest;
}

export async function prepareCodespaceForTarget(input: {
  githubUserToken: string;
  repoFullName: string;
  pullNumber?: number | null;
  branchName?: string | null;
  geo?: string;
  timeoutMs?: number;
  pollMs?: number;
}) {
  const token = trimText(input.githubUserToken);
  if (!token) {
    throw new Error("Token de usuario GitHub requerido para automatizar Codespaces.");
  }

  const repoFullName = parseRepoFullName(input.repoFullName).fullName;
  const pullNumber = Number.isFinite(Number(input.pullNumber))
    ? Math.max(0, Number(input.pullNumber))
    : 0;
  const branchName = trimText(input.branchName);
  const quickstartUrl = buildCodespaceQuickstartUrl({ repoFullName, pullNumber, branchName });

  const existing = await listCodespacesForRepo({ token, repoFullName });
  let selected = existing.find((item) => isCodespaceForTarget(item, { repoFullName, pullNumber, branchName })) || null;
  let action: "reused" | "resumed" | "created" = selected ? "reused" : "created";

  if (selected?.name) {
    const state = trimText(selected.state).toLowerCase();
    if (state !== "available") {
      action = "resumed";
      const existingName = selected.name;
      const started = await startCodespace({ token, name: existingName });
      selected = {
        ...selected,
        ...started,
        name: started.name || existingName,
      };
    }
  } else if (pullNumber > 0) {
    selected = await createCodespaceFromPullRequest({
      token,
      repoFullName,
      pullNumber,
      geo: input.geo,
    });
  } else {
    selected = await createCodespaceForRepository({
      token,
      repoFullName,
      branchName,
      geo: input.geo,
    });
  }

  if (!selected?.name) {
    throw new Error("GitHub no devolvio nombre de Codespace.");
  }

  const ready = await waitForCodespaceAvailable({
    token,
    name: selected.name,
    timeoutMs: input.timeoutMs,
    pollMs: input.pollMs,
  });

  const readyWebUrl = trimText(ready.web_url || selected.web_url)
    || buildCodespaceWebUrlFromName(ready.name || selected.name);

  return {
    status: isCodespaceReadyState(ready.state || "") && readyWebUrl
      ? "ready"
      : "pending",
    action,
    repoFullName,
    pullNumber,
    branchName: branchName || trimText(ready.git_status?.ref),
    quickstartUrl,
    codespace: {
      name: trimText(ready.name || selected.name),
      state: trimText(ready.state || selected.state),
      webUrl: readyWebUrl,
      apiUrl: trimText(ready.url || selected.url),
    },
  };
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

function isBootstrapPullRequestCandidate(pull: GithubPullRequestSummary) {
  const headRef = trimText(pull.head?.ref).toLowerCase();
  if (headRef.startsWith("adaceen/devcontainer-bootstrap-")) return true;

  const title = trimText(pull.title).toLowerCase();
  if (title.includes("bootstrap devcontainer") && title.includes("adaceen")) return true;

  const body = trimText(pull.body).toLowerCase();
  if (body.includes("generado automaticamente por adaceen")) return true;

  return false;
}

function isUsableBootstrapPullRequest(pull: GithubPullRequestSummary) {
  const state = trimText(pull.state).toLowerCase();
  const mergedAt = trimText(pull.merged_at);
  return state === "open" || !!mergedAt;
}

export async function findLatestBootstrapPullRequest(input: {
  installationToken: string;
  repoFullName: string;
}) {
  const repo = parseRepoFullName(input.repoFullName);
  const pulls = await githubRequest<GithubPullRequestSummary[]>(
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls?state=all&per_page=100&sort=updated&direction=desc`,
    { token: input.installationToken },
  );

  const items = Array.isArray(pulls) ? pulls : [];
  const match = items.find((item) => (
    isBootstrapPullRequestCandidate(item)
    && isUsableBootstrapPullRequest(item)
  ));
  if (!match) return null;

  const pullNumber = Number.isFinite(Number(match.number))
    ? Math.max(0, Number(match.number))
    : 0;

  return {
    pullNumber,
    pullUrl: trimText(match.html_url),
    state: trimText(match.state),
    mergedAt: trimText(match.merged_at),
    title: trimText(match.title),
    headRef: trimText(match.head?.ref),
  };
}

function asJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return { ...(value as JsonObject) };
}

function parseJsonObject(value: string): JsonObject | null {
  const clean = trimText(value);
  if (!clean) return null;

  try {
    const parsed = JSON.parse(clean);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as JsonObject;
  } catch {
    return null;
  }
}

function toStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => trimText(item)).filter(Boolean);
}

function ensureLifecycleCommand(value: unknown, command: string): unknown {
  if (typeof value === "string") {
    const current = trimText(value);
    if (!current) return command;
    if (current.includes(command)) return current;
    return `${current} && ${command}`;
  }

  if (Array.isArray(value)) {
    const current = value.map((item) => trimText(item)).filter(Boolean);
    if (current.some((item) => item.includes(command))) {
      return current;
    }
    return [...current, command];
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    const alreadyIncluded = Object.values(output).some((item) => typeof item === "string" && item.includes(command));
    if (alreadyIncluded) {
      return output;
    }

    let key = "adaceenBootstrap";
    let counter = 1;
    while (Object.prototype.hasOwnProperty.call(output, key)) {
      counter += 1;
      key = `adaceenBootstrap${counter}`;
    }
    output[key] = command;
    return output;
  }

  return command;
}

function defaultDevcontainerPayload() {
  return {
    name: "ADACEEN Devcontainer",
    image: "mcr.microsoft.com/devcontainers/universal:2",
    customizations: {
      vscode: {
        extensions: [
          ADACEEN_EXTENSION_ID,
          "ms-python.python",
          "ms-vscode.cpptools",
          "eamodio.gitlens",
        ],
        settings: {
          "editor.formatOnSave": true,
          "files.trimTrailingWhitespace": true,
        },
      },
    },
    extensions: [ADACEEN_EXTENSION_ID],
    postCreateCommand: FALLBACK_INSTALL_COMMAND,
    postAttachCommand: FALLBACK_INSTALL_COMMAND,
    updateContentCommand: FALLBACK_INSTALL_COMMAND,
  };
}

function buildDevcontainerJson(rawJson: string) {
  const base = parseJsonObject(rawJson) || defaultDevcontainerPayload();
  const payload = asJsonObject(base);

  if (!trimText(payload.name)) {
    payload.name = "ADACEEN Devcontainer";
  }

  const hasBuild = payload.build != null;
  if (!trimText(payload.image) && !hasBuild) {
    payload.image = "mcr.microsoft.com/devcontainers/universal:2";
  }

  const customizations = asJsonObject(payload.customizations);
  const vscode = asJsonObject(customizations.vscode);
  vscode.extensions = uniqueStrings([
    ...toStringArray(vscode.extensions),
    ADACEEN_EXTENSION_ID,
  ]);

  const settings = asJsonObject(vscode.settings);
  if (settings["editor.formatOnSave"] == null) {
    settings["editor.formatOnSave"] = true;
  }
  if (settings["files.trimTrailingWhitespace"] == null) {
    settings["files.trimTrailingWhitespace"] = true;
  }
  vscode.settings = settings;
  customizations.vscode = vscode;
  payload.customizations = customizations;

  payload.extensions = uniqueStrings([
    ...toStringArray(payload.extensions),
    ADACEEN_EXTENSION_ID,
  ]);
  payload.postCreateCommand = ensureLifecycleCommand(payload.postCreateCommand, FALLBACK_INSTALL_COMMAND);
  payload.postAttachCommand = ensureLifecycleCommand(payload.postAttachCommand, FALLBACK_INSTALL_COMMAND);
  payload.updateContentCommand = ensureLifecycleCommand(payload.updateContentCommand, FALLBACK_INSTALL_COMMAND);

  return `${JSON.stringify(payload, null, 2)}\n`;
}

function buildWorkspaceExtensionsJson(rawJson: string) {
  const payload = asJsonObject(parseJsonObject(rawJson) || {});
  payload.recommendations = uniqueStrings([
    ...toStringArray(payload.recommendations),
    ADACEEN_EXTENSION_ID,
  ]);

  const unwanted = toStringArray(payload.unwantedRecommendations)
    .filter((item) => item.toLowerCase() !== ADACEEN_EXTENSION_ID);
  if (unwanted.length > 0) {
    payload.unwantedRecommendations = uniqueStrings(unwanted);
  } else {
    delete payload.unwantedRecommendations;
  }

  return `${JSON.stringify(payload, null, 2)}\n`;
}

function defaultInstallExtensionsScript() {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "ADACEEN_INSTALL_SCRIPT_VERSION=\"2026-06-08-local-vsix-stable-suggestions\"",
    "ADACEEN_EXTENSION=\"adaceen.adaceen\"",
    "ADACEEN_VSIX_CANDIDATES=(",
    "  \"${ADACEEN_VSIX_PATH:-}\"",
    "  \"adaceen.vsix\"",
    "  \"adaceen-0.0.7.vsix\"",
    "  \"adaceen-0.0.6.vsix\"",
    "  \"adaceen-0.0.5.vsix\"",
    "  \".devcontainer/adaceen.vsix\"",
    "  \".devcontainer/adaceen-0.0.7.vsix\"",
    "  \".devcontainer/adaceen-0.0.6.vsix\"",
    "  \".devcontainer/adaceen-0.0.5.vsix\"",
    ")",
    "",
    "detect_code_cli() {",
    "  if command -v code >/dev/null 2>&1; then",
    "    echo \"code\"",
    "    return 0",
    "  fi",
    "  if command -v code-server >/dev/null 2>&1; then",
    "    echo \"code-server\"",
    "    return 0",
    "  fi",
    "  if command -v code-insiders >/dev/null 2>&1; then",
    "    echo \"code-insiders\"",
    "    return 0",
    "  fi",
    "  local vscode_bin",
    "  vscode_bin=\"$(find /vscode/bin -maxdepth 5 -type f -name code 2>/dev/null | head -n 1 || true)\"",
    "  if [ -n \"${vscode_bin}\" ]; then",
    "    echo \"${vscode_bin}\"",
    "    return 0",
    "  fi",
    "  return 1",
    "}",
    "",
    "if ! CODE_CLI=\"$(detect_code_cli)\"; then",
    "  echo \"[ADACEEN] VS Code CLI no disponible todavia. Se reintentara al adjuntar el Codespace.\"",
    "  exit 0",
    "fi",
    "",
    "for vsix in \"${ADACEEN_VSIX_CANDIDATES[@]}\"; do",
    "  if [ -n \"${vsix}\" ] && [ -f \"${vsix}\" ]; then",
    "    echo \"[ADACEEN] Instalando ADACEEN desde VSIX: ${vsix}\"",
    "    \"${CODE_CLI}\" --install-extension \"${vsix}\" --force || true",
    "    echo \"[ADACEEN] Instalacion completada.\"",
    "    exit 0",
    "  fi",
    "done",
    "",
    "latest_vsix=\"$(",
    "  find . .devcontainer -maxdepth 1 -type f -name 'adaceen-*.vsix' 2>/dev/null \\",
    "    | sort -V \\",
    "    | tail -n 1",
    ")\"",
    "if [ -n \"${latest_vsix}\" ] && [ -f \"${latest_vsix}\" ]; then",
    "  echo \"[ADACEEN] Instalando ultimo VSIX local: ${latest_vsix}\"",
    "  \"${CODE_CLI}\" --install-extension \"${latest_vsix}\" --force || true",
    "  echo \"[ADACEEN] Instalacion completada.\"",
    "  exit 0",
    "fi",
    "",
    "echo \"[ADACEEN] Instalando/actualizando ${ADACEEN_EXTENSION} desde Marketplace...\"",
    "\"${CODE_CLI}\" --install-extension \"${ADACEEN_EXTENSION}\" --force || true",
    "echo \"[ADACEEN] Instalacion completada.\"",
    "",
  ].join("\n");
}

function buildInstallExtensionsScript(rawScript: string) {
  const current = rawScript.replace(/\r\n/g, "\n");
  if (!trimText(current)) {
    return defaultInstallExtensionsScript();
  }

  if (
    current.includes(ADACEEN_EXTENSION_ID)
    && current.includes("--install-extension")
    && !current.includes("ADACEEN_INSTALL_SCRIPT_VERSION=\"2026-06-08-local-vsix-stable-suggestions\"")
  ) {
    return [
      defaultInstallExtensionsScript(),
      "",
      "# Script original conservado debajo; el bloque ADACEEN anterior fuerza la actualizacion primero.",
      current,
    ].join(current.endsWith("\n") ? "\n" : "\n") + (current.endsWith("\n") ? "" : "\n");
  }

  if (current.includes(ADACEEN_EXTENSION_ID) && current.includes("--install-extension")) {
    return current.endsWith("\n") ? current : `${current}\n`;
  }

  const addition = [
    "",
    "# ADACEEN fallback (agregado automaticamente)",
    "ADACEEN_EXTENSION=\"adaceen.adaceen\"",
    "ADACEEN_VSIX_CANDIDATES=(\"${ADACEEN_VSIX_PATH:-}\" \"adaceen.vsix\" \"adaceen-0.0.7.vsix\" \"adaceen-0.0.6.vsix\" \"adaceen-0.0.5.vsix\" \".devcontainer/adaceen.vsix\" \".devcontainer/adaceen-0.0.7.vsix\" \".devcontainer/adaceen-0.0.6.vsix\" \".devcontainer/adaceen-0.0.5.vsix\")",
    "ADACEEN_CODE_CLI=\"\"",
    "if command -v code >/dev/null 2>&1; then",
    "  ADACEEN_CODE_CLI=\"code\"",
    "elif command -v code-server >/dev/null 2>&1; then",
    "  ADACEEN_CODE_CLI=\"code-server\"",
    "elif command -v code-insiders >/dev/null 2>&1; then",
    "  ADACEEN_CODE_CLI=\"code-insiders\"",
    "fi",
    "if [ -n \"${ADACEEN_CODE_CLI}\" ]; then",
    "  ADACEEN_INSTALLED_FROM_VSIX=\"\"",
    "  for vsix in \"${ADACEEN_VSIX_CANDIDATES[@]}\"; do",
    "    if [ -n \"${vsix}\" ] && [ -f \"${vsix}\" ]; then",
    "      \"${ADACEEN_CODE_CLI}\" --install-extension \"${vsix}\" --force || true",
    "      ADACEEN_INSTALLED_FROM_VSIX=\"1\"",
    "      break",
    "    fi",
    "  done",
    "  if [ -z \"${ADACEEN_INSTALLED_FROM_VSIX}\" ]; then",
    "    ADACEEN_LATEST_VSIX=\"$(find . .devcontainer -maxdepth 1 -type f -name 'adaceen-*.vsix' 2>/dev/null | sort -V | tail -n 1)\"",
    "    if [ -n \"${ADACEEN_LATEST_VSIX}\" ] && [ -f \"${ADACEEN_LATEST_VSIX}\" ]; then",
    "      \"${ADACEEN_CODE_CLI}\" --install-extension \"${ADACEEN_LATEST_VSIX}\" --force || true",
    "    else",
    "      \"${ADACEEN_CODE_CLI}\" --install-extension \"${ADACEEN_EXTENSION}\" --force || true",
    "    fi",
    "  fi",
    "fi",
    "",
  ].join("\n");
  return `${current}${current.endsWith("\n") ? "" : "\n"}${addition}`;
}

function detectDevcontainerBootstrapMarker(rawJson: string | null) {
  const text = trimText(rawJson);
  if (!text) return false;

  const parsed = parseJsonObject(text);
  if (!parsed) {
    return text.toLowerCase().includes(ADACEEN_EXTENSION_ID);
  }

  const payload = asJsonObject(parsed);
  const customizations = asJsonObject(payload.customizations);
  const vscode = asJsonObject(customizations.vscode);
  const vscodeExtensions = toStringArray(vscode.extensions).map((item) => item.toLowerCase());
  const rootExtensions = toStringArray(payload.extensions).map((item) => item.toLowerCase());
  const lifecycleFields = [payload.postCreateCommand, payload.postAttachCommand, payload.updateContentCommand]
    .map((value) => JSON.stringify(value || "").toLowerCase());

  return vscodeExtensions.includes(ADACEEN_EXTENSION_ID)
    || rootExtensions.includes(ADACEEN_EXTENSION_ID)
    || lifecycleFields.some((value) => value.includes("install-extensions.sh") || value.includes(ADACEEN_EXTENSION_ID));
}

function detectWorkspaceExtensionsMarker(rawJson: string | null) {
  const text = trimText(rawJson);
  if (!text) return false;

  const parsed = parseJsonObject(text);
  if (!parsed) {
    return text.toLowerCase().includes(ADACEEN_EXTENSION_ID);
  }

  const payload = asJsonObject(parsed);
  const recommendations = toStringArray(payload.recommendations).map((item) => item.toLowerCase());
  return recommendations.includes(ADACEEN_EXTENSION_ID);
}

function detectInstallScriptMarker(rawScript: string | null) {
  const text = trimText(rawScript).toLowerCase();
  if (!text) return false;
  return text.includes(ADACEEN_EXTENSION_ID) && text.includes("--install-extension");
}

export async function inspectRepoBootstrapStatus(input: {
  installationToken: string;
  repoFullName: string;
  branch?: string;
}) {
  const repoInfo = await getRepoInfo(input.installationToken, input.repoFullName);
  const branch = trimText(input.branch) || repoInfo.defaultBranch;

  const [devcontainerFile, installScriptFile, workspaceExtensionsFile] = await Promise.all([
    getRepoFileSnapshot(input.installationToken, repoInfo, DEVCONTAINER_PATH, branch),
    getRepoFileSnapshot(input.installationToken, repoInfo, INSTALL_SCRIPT_PATH, branch),
    getRepoFileSnapshot(input.installationToken, repoInfo, WORKSPACE_EXTENSIONS_PATH, branch),
  ]);

  const signals: RepoBootstrapSignals = {
    hasDevcontainerFile: typeof devcontainerFile.content === "string",
    hasInstallScriptFile: typeof installScriptFile.content === "string",
    hasWorkspaceExtensionsFile: typeof workspaceExtensionsFile.content === "string",
    hasDevcontainerMarker: detectDevcontainerBootstrapMarker(devcontainerFile.content),
    hasInstallScriptMarker: detectInstallScriptMarker(installScriptFile.content),
    hasWorkspaceExtensionsMarker: detectWorkspaceExtensionsMarker(workspaceExtensionsFile.content),
  };

  const signalCount = [
    signals.hasDevcontainerMarker,
    signals.hasInstallScriptMarker,
    signals.hasWorkspaceExtensionsMarker,
  ].filter(Boolean).length;
  const isBootstrapped = signals.hasDevcontainerMarker && signalCount >= 2;

  return {
    repoFullName: repoInfo.fullName,
    branch,
    isBootstrapped,
    signals,
  };
}

async function getRepoInfo(installationToken: string, repoFullName: string) {
  const repo = parseRepoFullName(repoFullName);
  const info = await githubRequest<GithubRepoInfo>(
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`,
    { token: installationToken },
  );
  return {
    ...repo,
    defaultBranch: trimText(info.default_branch) || "main",
  };
}

async function getBranchSha(installationToken: string, repo: { owner: string; repo: string }, branch: string) {
  const ref = await githubRequest<{ object?: { sha?: string } }>(
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/git/ref/heads/${encodeURIComponent(branch)}`,
    { token: installationToken },
  );
  const sha = trimText(ref?.object?.sha);
  if (!sha) {
    throw new Error(`No se pudo leer SHA de la rama base ${branch}.`);
  }
  return sha;
}

async function tryCreateBranch(
  installationToken: string,
  repo: { owner: string; repo: string },
  branch: string,
  sha: string,
) {
  await githubRequest(
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/git/refs`,
    {
      method: "POST",
      token: installationToken,
      body: {
        ref: `refs/heads/${branch}`,
        sha,
      },
    },
  );
}

async function createUniqueBranch(
  installationToken: string,
  repo: { owner: string; repo: string },
  preferredBranch: string,
  baseSha: string,
) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${Math.random().toString(36).slice(2, 7)}`;
    const branch = `${preferredBranch}${suffix}`;
    try {
      await tryCreateBranch(installationToken, repo, branch, baseSha);
      return branch;
    } catch (error) {
      const message = String(error).toLowerCase();
      if (message.includes("422") || message.includes("reference already exists")) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("No se pudo crear una rama unica para bootstrap.");
}

async function getRepoFileSnapshot(
  installationToken: string,
  repo: { owner: string; repo: string },
  filePath: string,
  branch: string,
) {
  try {
    const file = await githubRequest<{
      sha?: string;
      content?: string;
      encoding?: string;
    }>(
      `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}`,
      { token: installationToken },
    );
    const sha = trimText(file.sha) || null;
    const encoding = trimText(file.encoding).toLowerCase();
    const encodedContent = typeof file.content === "string" ? file.content.replace(/\n/g, "") : "";

    let content: string | null = null;
    if (encoding === "base64" && encodedContent) {
      content = Buffer.from(encodedContent, "base64").toString("utf8");
    } else if (typeof file.content === "string") {
      content = file.content;
    }

    return { sha, content } satisfies RepoFileSnapshot;
  } catch (error) {
    const message = String(error);
    if (message.includes("404")) {
      return { sha: null, content: null } satisfies RepoFileSnapshot;
    }
    throw error;
  }
}

function normalizeFileContent(value: string) {
  return value.replace(/\r\n/g, "\n").trimEnd();
}

function readLocalAdaceenVsix() {
  const candidates = uniqueStrings([
    trimText(process.env.ADACEEN_BOOTSTRAP_VSIX_PATH),
    resolve(process.cwd(), "..", "..", "vscode-ext-prod", "adaceen-0.0.7.vsix"),
    resolve(process.cwd(), "..", "vscode-ext-prod", "adaceen-0.0.7.vsix"),
    resolve(process.cwd(), "vscode-ext-prod", "adaceen-0.0.7.vsix"),
    resolve(process.cwd(), "..", "..", "vscode-ext-prod", "adaceen-0.0.6.vsix"),
    resolve(process.cwd(), "..", "vscode-ext-prod", "adaceen-0.0.6.vsix"),
    resolve(process.cwd(), "vscode-ext-prod", "adaceen-0.0.6.vsix"),
  ]).filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      return {
        localPath: candidate,
        content: readFileSync(candidate),
      };
    } catch {
      continue;
    }
  }

  return null;
}

async function upsertRepositoryFile(
  installationToken: string,
  repo: { owner: string; repo: string },
  input: {
    path: string;
    branch: string;
    commitMessage: string;
    fileContent: string;
    currentFile?: RepoFileSnapshot;
  },
) {
  const currentFile = input.currentFile || await getRepoFileSnapshot(
    installationToken,
    repo,
    input.path,
    input.branch,
  );

  if (
    typeof currentFile.content === "string"
    && normalizeFileContent(currentFile.content) === normalizeFileContent(input.fileContent)
  ) {
    return {
      changed: false,
      commitSha: "",
      contentSha: currentFile.sha || "",
    };
  }

  const response = await githubRequest<{ content?: { sha?: string }; commit?: { sha?: string } }>(
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/contents/${encodeURIComponent(input.path)}`,
    {
      method: "PUT",
      token: installationToken,
      body: {
        message: input.commitMessage,
        content: Buffer.from(input.fileContent, "utf8").toString("base64"),
        branch: input.branch,
        ...(currentFile.sha ? { sha: currentFile.sha } : {}),
      },
    },
  );

  return {
    changed: true,
    commitSha: trimText(response?.commit?.sha),
    contentSha: trimText(response?.content?.sha),
  };
}

async function upsertRepositoryBinaryFile(
  installationToken: string,
  repo: { owner: string; repo: string },
  input: {
    path: string;
    branch: string;
    commitMessage: string;
    fileContent: Buffer;
  },
) {
  const currentFile = await getRepoFileSnapshot(
    installationToken,
    repo,
    input.path,
    input.branch,
  );

  const response = await githubRequest<{ content?: { sha?: string }; commit?: { sha?: string } }>(
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/contents/${encodeURIComponent(input.path)}`,
    {
      method: "PUT",
      token: installationToken,
      body: {
        message: input.commitMessage,
        content: input.fileContent.toString("base64"),
        branch: input.branch,
        ...(currentFile.sha ? { sha: currentFile.sha } : {}),
      },
    },
  );

  return {
    changed: true,
    commitSha: trimText(response?.commit?.sha),
    contentSha: trimText(response?.content?.sha),
  };
}

async function createPullRequest(
  installationToken: string,
  repo: { owner: string; repo: string },
  input: {
    title: string;
    body: string;
    head: string;
    base: string;
  },
) {
  return githubRequest<{ number: number; html_url: string }>(
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls`,
    {
      method: "POST",
      token: installationToken,
      body: input,
    },
  );
}

export async function bootstrapDevcontainerPullRequest(input: {
  installationId: string;
  repoFullName: string;
  baseBranch?: string;
  devcontainerJson?: string;
}) {
  const tokenResult = await fetchGithubInstallationToken(input.installationId);
  const installationToken = trimText(tokenResult.token);
  if (!installationToken) {
    throw new Error("No se pudo obtener token de instalacion GitHub.");
  }

  const repoInfo = await getRepoInfo(installationToken, input.repoFullName);
  const baseBranch = trimText(input.baseBranch) || repoInfo.defaultBranch;
  const baseSha = await getBranchSha(installationToken, repoInfo, baseBranch);
  const preferredBranch = `adaceen/devcontainer-bootstrap-${Date.now().toString(36)}`;
  const branchName = await createUniqueBranch(installationToken, repoInfo, preferredBranch, baseSha);

  const [currentDevcontainer, currentInstallScript, currentWorkspaceExtensions] = await Promise.all([
    getRepoFileSnapshot(installationToken, repoInfo, DEVCONTAINER_PATH, branchName),
    getRepoFileSnapshot(installationToken, repoInfo, INSTALL_SCRIPT_PATH, branchName),
    getRepoFileSnapshot(installationToken, repoInfo, WORKSPACE_EXTENSIONS_PATH, branchName),
  ]);

  const rawDevcontainer = trimText(input.devcontainerJson) || currentDevcontainer.content || "";
  const devcontainerBody = buildDevcontainerJson(rawDevcontainer);
  const installScriptBody = buildInstallExtensionsScript(currentInstallScript.content || "");
  const workspaceExtensionsBody = buildWorkspaceExtensionsJson(currentWorkspaceExtensions.content || "");
  const localVsix = readLocalAdaceenVsix();

  const devcontainerWrite = await upsertRepositoryFile(installationToken, repoInfo, {
    path: DEVCONTAINER_PATH,
    branch: branchName,
    commitMessage: "chore(devcontainer): harden config for ADACEEN Codespaces",
    fileContent: devcontainerBody,
    currentFile: currentDevcontainer,
  });

  const installScriptWrite = await upsertRepositoryFile(installationToken, repoInfo, {
    path: INSTALL_SCRIPT_PATH,
    branch: branchName,
    commitMessage: "chore(devcontainer): add extension install fallback script",
    fileContent: installScriptBody,
    currentFile: currentInstallScript,
  });

  const workspaceExtensionsWrite = await upsertRepositoryFile(installationToken, repoInfo, {
    path: WORKSPACE_EXTENSIONS_PATH,
    branch: branchName,
    commitMessage: "chore(vscode): recommend ADACEEN extension in workspace",
    fileContent: workspaceExtensionsBody,
    currentFile: currentWorkspaceExtensions,
  });

  const vsixWrite = localVsix
    ? await upsertRepositoryBinaryFile(installationToken, repoInfo, {
      path: ADACEEN_VSIX_REPO_PATH,
      branch: branchName,
      commitMessage: "chore(vscode): bundle ADACEEN extension preview",
      fileContent: localVsix.content,
    })
    : { changed: false, commitSha: "", contentSha: "" };

  const changedFiles = [
    devcontainerWrite.changed ? DEVCONTAINER_PATH : "",
    installScriptWrite.changed ? INSTALL_SCRIPT_PATH : "",
    workspaceExtensionsWrite.changed ? WORKSPACE_EXTENSIONS_PATH : "",
    vsixWrite.changed ? ADACEEN_VSIX_REPO_PATH : "",
  ].filter(Boolean);

  if (changedFiles.length === 0) {
    throw new Error("No hubo cambios para aplicar: el repositorio ya tiene bootstrap de Codespaces para ADACEEN.");
  }

  const commitSha = [
    vsixWrite.commitSha,
    workspaceExtensionsWrite.commitSha,
    installScriptWrite.commitSha,
    devcontainerWrite.commitSha,
  ].find((value) => Boolean(trimText(value))) || "";

  const pullBodyLines = [
    "Este PR refuerza la configuracion de Codespaces para instalar ADACEEN automaticamente.",
    "",
    "Archivos actualizados:",
    "- `.devcontainer/devcontainer.json` (incluye fallback y merge con config existente)",
    "- `.devcontainer/install-extensions.sh` (instalacion por CLI como respaldo)",
    "- `.vscode/extensions.json` (recomendacion adicional de extension)",
    ...(localVsix ? ["- `.devcontainer/adaceen-0.0.7.vsix` (version local de prueba para Codespaces)"] : []),
    "",
    "Generado automaticamente por ADACEEN usando GitHub App.",
  ];

  const pull = await createPullRequest(installationToken, repoInfo, {
    title: "chore: bootstrap devcontainer for ADACEEN",
    body: pullBodyLines.join("\n"),
    head: branchName,
    base: baseBranch,
  });

  return {
    repoFullName: repoInfo.fullName,
    baseBranch,
    branchName,
    commitSha,
    changedFiles,
    pullNumber: pull.number,
    pullUrl: pull.html_url,
    codespaceUrl: buildCodespaceQuickstartUrl({
      repoFullName: repoInfo.fullName,
      pullNumber: pull.number,
      branchName,
    }),
  };
}
