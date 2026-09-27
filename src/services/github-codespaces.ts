// GitHub: Codespaces (buscar, crear, arrancar, esperar y preparar el del estudiante).
// Movido sin cambios desde src/services/github-app.ts (solo se agrego "export" y los imports); src/services/github-app.ts lo reexporta.
import { DEVCONTAINER_PATH, githubRequest, parseRepoFullName, sleep } from "./github-api.js";
import type { GithubCodespaceSummary } from "./github-api.js";
import { trimText } from "./text-utils.js";

export function encodeCodespacesBranch(branchName: string) {
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

export function normalizeCodespacePayload(raw: unknown): GithubCodespaceSummary {
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

export function isAdaceenCodespace(item: GithubCodespaceSummary) {
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

export function codespaceTimestamp(item: GithubCodespaceSummary) {
  const timestamp = Date.parse(trimText(item.updated_at) || trimText(item.created_at));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function sortCodespacesForAdaceen(a: GithubCodespaceSummary, b: GithubCodespaceSummary) {
  const aAdaceen = trimText(a.display_name).toLowerCase() === "adaceen" ? 1 : 0;
  const bAdaceen = trimText(b.display_name).toLowerCase() === "adaceen" ? 1 : 0;
  if (aAdaceen !== bAdaceen) return bAdaceen - aAdaceen;
  return codespaceTimestamp(b) - codespaceTimestamp(a);
}

export function isCodespaceReadyState(state: string) {
  const normalized = trimText(state).toLowerCase();
  return normalized === "available" || normalized === "ready";
}

export function isDevcontainerPathMissingError(error: unknown) {
  const message = trimText(error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("devcontainer")
    && message.includes("does not exist");
}

export async function listCodespacesForRepo(input: {
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

export async function getCodespace(input: { token: string; name: string }) {
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

export async function startCodespace(input: { token: string; name: string }) {
  const response = await githubRequest(
    `/user/codespaces/${encodeURIComponent(input.name)}/start`,
    {
      method: "POST",
      token: input.token,
    },
  );
  return normalizeCodespacePayload(response);
}

export async function createCodespaceFromPullRequest(input: {
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

export async function createCodespaceForRepository(input: {
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

export async function waitForCodespaceAvailable(input: {
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
    if (state === "shutdown" || state === "shut down") {
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
