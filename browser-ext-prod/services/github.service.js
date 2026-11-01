// ADACEEN | Capa 3 - Servicios: preparacion del Codespace (descubrimiento, espera en el backend, devcontainer y
// navegacion). OAuth y GitHub App: github-auth.service.js; ventana de espera: codespace-waiting*.service.js.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";
const CODESPACE_READY_POLL_INTERVAL_MS = 2000;
const CODESPACE_READY_POLL_TIMEOUT_MS = 420000;
const CODESPACE_PREPARE_REQUEST_TIMEOUT_MS = 120000;
const CODESPACE_READY_POLL_MAX_ATTEMPTS = 120;
const CODESPACE_DIRECT_OPEN_AFTER_ATTEMPTS = 2;
const CODESPACE_NAVIGATION_LOCK_MS = 300000;
let activeCodespaceDiscoveryTracker = null;
let codespaceNavigationLockUntil = 0;
let codespaceNavigationLastUrl = "";

function setOperationProgress(title, detail = "", kind = "busy", syncStatus = false) {
  overlayState.operationTitle = toText(title);
  overlayState.operationDetail = toText(detail);
  overlayState.operationKind = toText(kind) || "busy";
  if (syncStatus && title) {
    overlayState.statusMessage = overlayState.operationDetail || overlayState.operationTitle;
  }
  renderOverlay();
}

function setOperationError(title, detail = "") {
  setOperationProgress(title || "No se pudo continuar", detail, "error", true);
}

function clearOperationProgress(finalMessage = "") {
  overlayState.operationTitle = "";
  overlayState.operationDetail = "";
  overlayState.operationKind = "busy";
  if (finalMessage) {
    overlayState.statusMessage = finalMessage;
  }
}

function isCodespaceReadyState(state) {
  const normalized = toText(state).toLowerCase();
  return normalized === "available" || normalized === "ready";
}

function isTunnelEditorUrl(value) {
  // VS Code Tunnels: https://vscode.dev/tunnel/<nombre>/<ruta>
  return /^https:\/\/(?:insiders\.)?vscode\.dev\/tunnel\/[^/?#]+/i.test(toText(value));
}

function isDirectCodespaceUrl(value) {
  // "Directa" = una URL que abre el editor sin pasar por codespaces.new:
  // un Codespace (*.github.dev) o un tunel de VS Code (vscode.dev/tunnel/...).
  return /^https:\/\/[^/]+\.github\.dev(?:\/|$)/i.test(toText(value)) || isTunnelEditorUrl(value);
}

function buildCodespaceStatusQuery(input = {}) {
  const params = new URLSearchParams();
  const name = toText(input.name);
  const repoFullName = parseRepoFullName(toText(input.repoFullName));
  const pullNumber = Number(input.pullNumber) || 0;
  const branchName = toText(input.branchName);

  if (name) params.set("name", name);
  if (repoFullName) params.set("repoFullName", repoFullName);
  if (pullNumber > 0) params.set("pullNumber", String(pullNumber));
  if (branchName) params.set("branchName", branchName);
  return params.toString() ? `?${params.toString()}` : "";
}

function isCodespaceLimitError(message) {
  return /limite de codespaces|too many|quota|maximum|exceeded|spending/i.test(String(message));
}

function hasRecentCodespaceNavigation() {
  return Date.now() < codespaceNavigationLockUntil && isDirectCodespaceUrl(codespaceNavigationLastUrl);
}

function encodeCodespacesBranch(branchName) {
  return toText(branchName)
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function buildCodespaceQuickstartUrl(repoFullName, pullNumber = 0, branchName = "") {
  const cleanRepo = parseRepoFullName(repoFullName);
  if (!cleanRepo) return "";

  const [owner, repo] = cleanRepo.split("/");
  const baseUrl = `https://codespaces.new/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const normalizedPullNumber = Number.isFinite(Number(pullNumber))
    ? Math.max(0, Number(pullNumber))
    : 0;

  if (normalizedPullNumber > 0) {
    return `${baseUrl}/pull/${normalizedPullNumber}?quickstart=1`;
  }

  const branchPath = encodeCodespacesBranch(branchName);
  if (branchPath) {
    return `${baseUrl}/tree/${branchPath}?quickstart=1`;
  }

  return `${baseUrl}?quickstart=1`;
}

function isCodespaceQuickstartUrl(value) {
  const target = toText(value);
  return /^https:\/\/codespaces\.new\//i.test(target)
    || /^https:\/\/github\.com\/codespaces\/new(?:\/|$)/i.test(target);
}

function buildCodespaceWebUrlFromName(name) {
  const cleanName = toText(name);
  return cleanName ? `https://${cleanName}.github.dev` : "";
}

function resolveDirectCodespaceUrlFromPayload(payload) {
  const candidates = [
    toText(payload?.codespace?.webUrl),
    buildCodespaceWebUrlFromName(payload?.codespace?.name),
    toText(payload?.bootstrap?.codespaceWebUrl),
    toText(payload?.bootstrapCodespaceUrl),
    toText(payload?.result?.codespaceWebUrl),
    toText(payload?.codespaceWebUrl),
  ].filter(Boolean);

  return candidates.find((url) => isDirectCodespaceUrl(url)) || "";
}

function resolveCodespaceUrlFromBootstrapPayload(payload, fallbackRepo = "") {
  const directUrl = resolveDirectCodespaceUrlFromPayload(payload);
  if (directUrl) return directUrl;

  const result = payload?.result || payload?.bootstrap || payload || {};
  const pullRequest = payload?.pullRequest || {};
  const fallbackUrl = toText(payload?.codespaceUrl)
    || toText(payload?.bootstrap?.codespaceUrl)
    || toText(payload?.result?.codespaceUrl)
    || toText(payload?.codespace?.fallbackUrl)
    || toText(payload?.fallback?.webUrl);
  if (fallbackUrl) return fallbackUrl;

  const repoFullName = toText(result.repoFullName) || toText(payload?.repository) || toText(payload?.repoFullName) || fallbackRepo || getCurrentRepoFullName();
  const pullNumber = Number(result.pullNumber || pullRequest.number || payload?.pullNumber || 0) || 0;
  const branchName = toText(result.branchName || pullRequest.branchName || result.bootstrapBranchName || payload?.branchName || "");
  return buildCodespaceQuickstartUrl(repoFullName, pullNumber, branchName);
}

function rememberSetupPrResult(result, extra = {}) {
  const userId = getCurrentUserId();
  if (!userId) return null;

  const repoFullName = toText(result?.repoFullName) || getCurrentRepoFullName();
  const pullNumber = Number(result?.pullNumber) || 0;
  const branchName = toText(result?.branchName);
  const codespaceUrl = resolveCodespaceUrlFromBootstrapPayload({
    ...extra,
    ...result,
  }, repoFullName);

  const stored = {
    repoFullName,
    pullUrl: toText(result?.pullUrl),
    pullNumber,
    branchName,
    commitSha: toText(result?.commitSha),
    codespaceUrl,
    createdAt: new Date().toISOString(),
  };
  overlayState.setupPrResultByUser[userId] = stored;
  return stored;
}

function getStoredSetupCodespaceUrl() {
  if (typeof isTunnelProvider === "function" && isTunnelProvider() && typeof getSavedTunnelEditor === "function") {
    const saved = getSavedTunnelEditor();
    if (saved?.webUrl) return saved.webUrl;
  }
  const pull = getLatestSetupPullResult();
  return toText(pull?.codespaceUrl)
    || toText(overlayState.githubAppStatus?.bootstrapCodespaceUrl);
}

function getStoredSetupPullNumber() {
  const pull = getLatestSetupPullResult();
  return Number(pull?.pullNumber || overlayState.githubAppStatus?.bootstrapPullNumber) || 0;
}

function shouldPrepareCodespaceBeforeDashboard(flow) {
  const currentFlow = flow || getSetupFlowState(overlayState.context || buildPayload());
  if (!currentFlow.repoReady || !currentFlow.accessVerified || !currentFlow.userHasCodespaceScope) {
    return false;
  }

  const context = currentFlow.context || overlayState.context || buildPayload();
  if (toText(context?.pageType) === "codespace") {
    return false;
  }

  const knownUrl = getStoredSetupCodespaceUrl();
  if (isDirectCodespaceUrl(knownUrl)) return false;

  return !!knownUrl
    || getStoredSetupPullNumber() > 0
    || currentFlow.prCreated
    || hasCompletedSetup();
}

// options.force: navega aunque el candado reciente diga que ya se abrio (clic explicito del
// estudiante en "Abrir mi editor" o final de la preparacion del tunel, sin sondeos en paralelo).
async function navigatePendingCodespaceWindow(pendingWindow, codespaceUrl, options = {}) {
  // A12.8: la ventana de espera es about:blank con el origen de la pagina; una URL
  // javascript: del backend se ejecutaria ahi. Solo se navega a http/https.
  const targetUrl = toSafeHttpUrl(codespaceUrl);
  if (!targetUrl) {
    if (pendingWindow) pendingWindow.close();
    return false;
  }

  const now = Date.now();
  if (options?.force !== true
    && now < codespaceNavigationLockUntil
    && (isDirectCodespaceUrl(targetUrl) || targetUrl === codespaceNavigationLastUrl)) {
    return true;
  }
  codespaceNavigationLastUrl = targetUrl;
  codespaceNavigationLockUntil = now + CODESPACE_NAVIGATION_LOCK_MS;

  if (typeof prepareCodespaceNavigationHandoff === "function") {
    await prepareCodespaceNavigationHandoff(targetUrl, {
      repoFullName: getCurrentRepoFullName(),
    }).catch(() => {});
  }

  if (pendingWindow && !pendingWindow.closed) {
    try {
      // Si la ventana ya esta en otro origen (la del OAuth en el backend o
      // github.com/login/device), opener no se puede escribir, pero location si:
      // eso no es motivo para cerrarla y abrir otra que el navegador bloquearia.
      try {
        pendingWindow.opener = null;
      } catch {}
      pendingWindow.location.href = targetUrl;
      if (activeCodespaceDiscoveryTracker) {
        activeCodespaceDiscoveryTracker.opened = true;
        activeCodespaceDiscoveryTracker.stopped = true;
      }
      if (pendingWindow === pendingGithubOAuthWindow) {
        pendingGithubOAuthWindow = null;
      }
      return true;
    } catch {
      const opened = window.open(targetUrl, "_blank", "noopener,noreferrer");
      try {
        pendingWindow.close();
      } catch {}
      if (!opened) {
        codespaceNavigationLockUntil = 0;
      } else if (activeCodespaceDiscoveryTracker) {
        activeCodespaceDiscoveryTracker.opened = true;
        activeCodespaceDiscoveryTracker.stopped = true;
      }
      return !!opened;
    }
  } else {
    const opened = window.open(targetUrl, "_blank", "noopener,noreferrer");
    if (!opened) {
      codespaceNavigationLockUntil = 0;
    } else if (activeCodespaceDiscoveryTracker) {
      activeCodespaceDiscoveryTracker.opened = true;
      activeCodespaceDiscoveryTracker.stopped = true;
    }
    return !!opened;
  }
  return false;
}
