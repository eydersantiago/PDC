import { createSign, randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { trimText } from "./text-utils.js";

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

function defaultDevcontainerJson() {
  const payload = {
    name: "ADACEEN Devcontainer",
    image: "mcr.microsoft.com/devcontainers/universal:2",
    customizations: {
      vscode: {
        extensions: [
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
    postCreateCommand: "echo \"ADACEEN bootstrap listo\"",
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
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

async function getFileShaIfExists(
  installationToken: string,
  repo: { owner: string; repo: string },
  filePath: string,
  branch: string,
) {
  try {
    const file = await githubRequest<{ sha?: string }>(
      `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}`,
      { token: installationToken },
    );
    return trimText(file.sha) || null;
  } catch (error) {
    const message = String(error);
    if (message.includes("404")) {
      return null;
    }
    throw error;
  }
}

async function upsertDevcontainerFile(
  installationToken: string,
  repo: { owner: string; repo: string },
  branch: string,
  fileContent: string,
) {
  const path = ".devcontainer/devcontainer.json";
  const currentSha = await getFileShaIfExists(installationToken, repo, path, branch);
  const response = await githubRequest<{ content?: { sha?: string } }>(
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/contents/${encodeURIComponent(path)}`,
    {
      method: "PUT",
      token: installationToken,
      body: {
        message: "chore(devcontainer): bootstrap config for ADACEEN",
        content: Buffer.from(fileContent, "utf8").toString("base64"),
        branch,
        ...(currentSha ? { sha: currentSha } : {}),
      },
    },
  );

  return trimText(response?.content?.sha) || "";
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
  const jsonBody = trimText(input.devcontainerJson) || defaultDevcontainerJson();
  const commitSha = await upsertDevcontainerFile(installationToken, repoInfo, branchName, jsonBody);

  const pull = await createPullRequest(installationToken, repoInfo, {
    title: "chore: bootstrap devcontainer for ADACEEN",
    body: [
      "Este PR agrega `.devcontainer/devcontainer.json` para estandarizar Codespaces.",
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
    pullNumber: pull.number,
    pullUrl: pull.html_url,
  };
}
