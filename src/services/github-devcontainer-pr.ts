// GitHub: revisar el repositorio y abrir el PR que agrega el devcontainer (ramas, archivos, VSIX y pull request).
// Movido sin cambios desde src/services/github-app.ts (solo se agrego "export" y los imports); src/services/github-app.ts lo reexporta.
import { basename, resolve } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { ADACEEN_VSIX_REPO_PATH, DEVCONTAINER_PATH, INSTALL_SCRIPT_PATH, WORKSPACE_EXTENSIONS_PATH, fetchGithubInstallationToken, githubRequest, parseRepoFullName } from "./github-api.js";
import type { GithubRepoInfo, RepoBootstrapSignals, RepoFileSnapshot } from "./github-api.js";
import { buildCodespaceQuickstartUrl } from "./github-codespaces.js";
import { buildDevcontainerJson, buildInstallExtensionsScript, buildWorkspaceExtensionsJson, detectDevcontainerBootstrapMarker, detectInstallScriptMarker, detectWorkspaceExtensionsMarker } from "./github-devcontainer-files.js";
import { trimText, uniqueStrings } from "./text-utils.js";

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

export async function getRepoInfo(installationToken: string, repoFullName: string) {
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

export async function getBranchSha(installationToken: string, repo: { owner: string; repo: string }, branch: string) {
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

export async function tryCreateBranch(
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

export async function createUniqueBranch(
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

export async function getRepoFileSnapshot(
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

export function normalizeFileContent(value: string) {
  return value.replace(/\r\n/g, "\n").trimEnd();
}

export function getAdaceenVsixVersion(filePath: string) {
  const match = basename(filePath).match(/^adaceen-(\d+)\.(\d+)\.(\d+)(?:[.-][\w.-]+)?\.vsix$/i);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function getFileModifiedTimeMs(filePath: string) {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

export function compareAdaceenVsixCandidates(left: string, right: string) {
  const leftVersion = getAdaceenVsixVersion(left);
  const rightVersion = getAdaceenVsixVersion(right);
  if (leftVersion && rightVersion) {
    for (let index = 0; index < leftVersion.length; index += 1) {
      const diff = rightVersion[index] - leftVersion[index];
      if (diff !== 0) return diff;
    }
  } else if (leftVersion) {
    return -1;
  } else if (rightVersion) {
    return 1;
  }

  return getFileModifiedTimeMs(right) - getFileModifiedTimeMs(left);
}

export function listAdaceenVsixFiles(directoryPath: string) {
  try {
    return readdirSync(directoryPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^adaceen(?:-\d+\.\d+\.\d+(?:[.-][\w.-]+)?)?\.vsix$/i.test(entry.name))
      .map((entry) => resolve(directoryPath, entry.name));
  } catch {
    return [];
  }
}

export function expandAdaceenVsixCandidate(candidatePath: string) {
  const cleanPath = trimText(candidatePath);
  if (!cleanPath) return [];

  try {
    const stats = statSync(cleanPath);
    if (stats.isDirectory()) {
      return listAdaceenVsixFiles(cleanPath).sort(compareAdaceenVsixCandidates);
    }
    if (stats.isFile()) {
      return [cleanPath];
    }
  } catch {
    return [cleanPath];
  }

  return [];
}

export function readLocalAdaceenVsix() {
  const configuredCandidates = expandAdaceenVsixCandidate(trimText(process.env.ADACEEN_BOOTSTRAP_VSIX_PATH));
  const candidateDirectories = uniqueStrings([
    resolve(process.cwd(), "vscode-ext-prod"),
    resolve(process.cwd(), "..", "vscode-ext-prod"),
    resolve(process.cwd(), "..", "..", "vscode-ext-prod"),
  ]);
  const discoveredCandidates = candidateDirectories
    .flatMap((directoryPath) => listAdaceenVsixFiles(directoryPath))
    .sort(compareAdaceenVsixCandidates);
  const candidates = uniqueStrings([
    ...configuredCandidates,
    ...discoveredCandidates,
  ]).filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      return {
        localPath: candidate,
        fileName: basename(candidate),
        content: readFileSync(candidate),
      };
    } catch {
      continue;
    }
  }

  return null;
}

export async function upsertRepositoryFile(
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

export async function upsertRepositoryBinaryFile(
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

export async function createPullRequest(
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

  const localVsix = readLocalAdaceenVsix();
  if (!localVsix) {
    throw new Error(
      "No se encontro un VSIX local de ADACEEN para Codespaces. Ejecuta el empaquetado de vscode-ext-prod o configura ADACEEN_BOOTSTRAP_VSIX_PATH antes de crear el PR.",
    );
  }
  const localVsixSha256 = createHash("sha256").update(localVsix.content).digest("hex");

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
    `- \`${ADACEEN_VSIX_REPO_PATH}\` (${localVsix.fileName}, ${localVsix.content.length} bytes, sha256 ${localVsixSha256})`,
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
