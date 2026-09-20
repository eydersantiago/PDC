// ADACEEN | Capa 5 - Ciclo de vida: traspaso de estado del overlay cuando el navegador salta al Codespace.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const CODESPACE_HANDOFF_TTL_MS = 15 * 60 * 1000;
let activeCodespaceHandoff = null;

function getUrlHost(value) {
  const text = toText(value);
  if (!text) return "";
  try {
    return new URL(text, location.href).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isCodespaceLikeUrl(value) {
  const text = toText(value);
  if (!text) return false;
  try {
    const url = new URL(text, location.href);
    const host = url.hostname.toLowerCase();
    return host === "github.dev"
      || host.endsWith(".github.dev")
      || host === "app.github.dev"
      || host.endsWith(".app.github.dev")
      || host === "codespaces.new"
      || (host === "github.com" && url.pathname.toLowerCase().includes("/codespaces/"));
  } catch {
    return /(^|\.)github\.dev(?:\/|$)|codespaces\.new\/|github\.com\/codespaces\//i.test(text);
  }
}

function isCodespaceLikeContext(context) {
  const source = context || {};
  return toText(source.pageType) === "codespace"
    || isCodespaceLikeUrl(source.url || location.href);
}

function getCodespaceHandoffRepoFullName(handoff) {
  return parseRepoFullName(
    handoff?.repoFullName
      || handoff?.state?.setupRepoFullName
      || handoff?.state?.context?.repoFullName
      || handoff?.targetUrl
      || handoff?.sourceUrl
      || "",
  );
}

function normalizeCodespaceHandoff(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const ts = Number(raw.ts) || Date.now();
  const expiresAt = Number(raw.expiresAt) || ts + CODESPACE_HANDOFF_TTL_MS;
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;

  return {
    ts,
    expiresAt,
    sessionId: toText(raw.sessionId),
    sourceTabId: toText(raw.sourceTabId),
    sourceUrl: toText(raw.sourceUrl),
    targetUrl: toText(raw.targetUrl),
    repoFullName: parseRepoFullName(raw.repoFullName || ""),
    minimized: raw.minimized === true,
    state: raw.state && typeof raw.state === "object" && !Array.isArray(raw.state)
      ? raw.state
      : null,
  };
}

function isCodespaceHandoffApplicable(context, handoff) {
  const currentContext = context || getPageContext();
  if (!handoff || !isCodespaceLikeContext(currentContext)) return false;
  if (handoff.expiresAt <= Date.now()) return false;

  const currentSessionId = toText(overlayState.sessionId);
  if (handoff.sessionId && currentSessionId && handoff.sessionId !== currentSessionId) {
    return false;
  }

  const currentHost = getUrlHost(currentContext.url || location.href);
  const targetHost = getUrlHost(handoff.targetUrl);
  if (currentHost && targetHost && currentHost === targetHost) {
    return true;
  }

  const currentRepo = parseRepoFullName(currentContext.repoFullName || currentContext.url || "");
  const handoffRepo = getCodespaceHandoffRepoFullName(handoff);
  if (currentRepo && handoffRepo) {
    return currentRepo.toLowerCase() === handoffRepo.toLowerCase();
  }

  return !currentRepo || !handoffRepo;
}

async function readCodespaceNavigationHandoff(context) {
  if (!isExtensionRuntimeReady()) return null;
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY_CODESPACE_HANDOFF]);
    const handoff = normalizeCodespaceHandoff(stored?.[STORAGE_KEY_CODESPACE_HANDOFF]);
    if (!handoff) {
      await chrome.storage.local.remove([STORAGE_KEY_CODESPACE_HANDOFF]).catch(() => {});
      activeCodespaceHandoff = null;
      return null;
    }

    if (!isCodespaceHandoffApplicable(context, handoff)) {
      return null;
    }

    activeCodespaceHandoff = handoff;
    return handoff;
  } catch {
    return null;
  }
}

async function refreshCodespaceHandoffCache(context) {
  const handoff = await readCodespaceNavigationHandoff(context);
  if (handoff) return handoff;
  if (activeCodespaceHandoff && activeCodespaceHandoff.expiresAt <= Date.now()) {
    activeCodespaceHandoff = null;
  }
  return null;
}

function applyCodespaceNavigationHandoff(handoff, context) {
  if (!handoff) return false;

  if (handoff.state) {
    applyTabSessionSnapshot(handoff.state);
  }

  overlayState.context = context || getPageContext();
  overlayState.minimized = handoff.minimized === true || overlayState.minimized === true;
  overlayState.processNoticeOpen = false;
  overlayState.githubAppBusy = false;
  overlayState.loading = false;
  overlayState.operationTitle = "";
  overlayState.operationDetail = "";
  overlayState.operationKind = "busy";
  activeCodespaceHandoff = handoff;

  if (isCodespaceLikeContext(overlayState.context)) {
    overlayState.analysisUnlocked = true;
    if (!overlayState.statusMessage || /preparando|creando|esperando/i.test(overlayState.statusMessage)) {
      overlayState.statusMessage = "Codespace abierto. ADACEEN conserva tu sesion y contexto.";
    }
  }

  return true;
}

async function prepareCodespaceNavigationHandoff(targetUrl, options = {}) {
  const context = getPageContext();
  const now = Date.now();
  const handoff = {
    ts: now,
    expiresAt: now + CODESPACE_HANDOFF_TTL_MS,
    sessionId: toText(overlayState.sessionId),
    sourceTabId: getActiveTabInstanceId(),
    sourceUrl: toText(context.url || location.href),
    targetUrl: toText(targetUrl),
    repoFullName: parseRepoFullName(options.repoFullName || getCurrentRepoFullName() || context.repoFullName || ""),
    minimized: true,
    state: buildTabSessionSnapshot(context),
  };

  overlayState.minimized = true;
  overlayState.settingsOpen = false;
  overlayState.processNoticeOpen = false;
  activeCodespaceHandoff = normalizeCodespaceHandoff(handoff);

  await flushTabSessionSave();

  try {
    await chrome.storage.local.set({
      [STORAGE_KEY_OVERLAY_PINNED]: true,
      [STORAGE_KEY_OVERLAY_MINIMIZED]: true,
      [STORAGE_KEY_CODESPACE_HANDOFF]: handoff,
    });
  } catch {}

  sendActiveTabState(false, {
    force: true,
    transition: "codespace_navigation",
    targetUrl: toText(targetUrl).slice(0, 1800),
  }).catch(() => {});

  if (overlayHost?.isConnected) {
    renderOverlay();
  }
}
