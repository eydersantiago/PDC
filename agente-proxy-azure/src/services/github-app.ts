import { createSign, randomBytes } from "node:crypto";
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

async function githubRequest<T = unknown>(path: string, options: GithubRequestOptions = {}) {
  const url = `${env.githubApiBaseUrl}${path}`;
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json; charset=utf-8",
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
    throw new Error(`GitHub API ${response.status} ${path}${details ? `: ${details}` : ""}`);
  }

  return json as T;
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
  const match = items.find((item) => isBootstrapPullRequestCandidate(item));
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
    "ADACEEN_EXTENSION=\"adaceen.adaceen\"",
    "",
    "detect_code_cli() {",
    "  if command -v code >/dev/null 2>&1; then",
    "    echo \"code\"",
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
    "if \"${CODE_CLI}\" --list-extensions | tr '[:upper:]' '[:lower:]' | grep -qx \"${ADACEEN_EXTENSION}\"; then",
    "  echo \"[ADACEEN] ${ADACEEN_EXTENSION} ya esta instalada.\"",
    "  exit 0",
    "fi",
    "",
    "echo \"[ADACEEN] Instalando ${ADACEEN_EXTENSION}...\"",
    "\"${CODE_CLI}\" --install-extension \"${ADACEEN_EXTENSION}\" --force",
    "echo \"[ADACEEN] Instalacion completada.\"",
    "",
  ].join("\n");
}

function buildInstallExtensionsScript(rawScript: string) {
  const current = rawScript.replace(/\r\n/g, "\n");
  if (!trimText(current)) {
    return defaultInstallExtensionsScript();
  }

  if (current.includes(ADACEEN_EXTENSION_ID) && current.includes("--install-extension")) {
    return current.endsWith("\n") ? current : `${current}\n`;
  }

  const addition = [
    "",
    "# ADACEEN fallback (agregado automaticamente)",
    "if command -v code >/dev/null 2>&1; then",
    "  code --install-extension \"adaceen.adaceen\" --force || true",
    "elif command -v code-insiders >/dev/null 2>&1; then",
    "  code-insiders --install-extension \"adaceen.adaceen\" --force || true",
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

  const changedFiles = [
    devcontainerWrite.changed ? DEVCONTAINER_PATH : "",
    installScriptWrite.changed ? INSTALL_SCRIPT_PATH : "",
    workspaceExtensionsWrite.changed ? WORKSPACE_EXTENSIONS_PATH : "",
  ].filter(Boolean);

  if (changedFiles.length === 0) {
    throw new Error("No hubo cambios para aplicar: el repositorio ya tiene bootstrap de Codespaces para ADACEEN.");
  }

  const commitSha = [
    workspaceExtensionsWrite.commitSha,
    installScriptWrite.commitSha,
    devcontainerWrite.commitSha,
  ].find((value) => Boolean(trimText(value))) || "";

  const pull = await createPullRequest(installationToken, repoInfo, {
    title: "chore: bootstrap devcontainer for ADACEEN",
    body: [
      "Este PR refuerza la configuracion de Codespaces para instalar ADACEEN automaticamente.",
      "",
      "Archivos actualizados:",
      "- `.devcontainer/devcontainer.json` (incluye fallback y merge con config existente)",
      "- `.devcontainer/install-extensions.sh` (instalacion por CLI como respaldo)",
      "- `.vscode/extensions.json` (recomendacion adicional de extension)",
      "",
      "Generado automaticamente por ADACEEN usando GitHub App.",
    ].join("\n"),
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
  };
}
