// ADACEEN | Capa 5 - Ciclo de vida: «pestana activa»: identidad de esta pestana, reporte al backend,
// latido, desactivacion y aviso de conflicto cuando otra pestana tiene la sesion activa.
// Movido sin cambios desde content-lifecycle.js; el listener del aviso esta en bindTabConflictNotice.
// Sin "use strict": el codigo viene de archivos en modo no estricto y se conserva igual.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

const ACTIVE_TAB_POLL_INTERVAL_MS = 9000;

const ACTIVE_TAB_DEACTIVATE_DELAY_MS = 2500;

const ACTIVE_TAB_MIN_REPORT_MS = 900;

const ACTIVE_TAB_INSTANCE_ID_KEY = "adaceenActiveTabInstanceId";

const ACTIVE_TAB_VIEW_CONTEXT_MAX = 280;

let activeTabHeartbeatTimer = 0;

let activeTabSyncTimer = 0;

let activeTabDeactivationTimer = 0;

let activeTabSyncInFlight = null;

let activeTabLastSyncAt = 0;

let activeTabLastReportAt = 0;

let activeTabConflictNotice = "";

let activeTabInstanceId = "";

function getActiveTabInstanceId() {
  if (activeTabInstanceId) {
    return activeTabInstanceId;
  }

  try {
    const stored = sessionStorage.getItem(ACTIVE_TAB_INSTANCE_ID_KEY);
    if (stored && String(stored).trim()) {
      activeTabInstanceId = toText(stored);
      return activeTabInstanceId;
    }
  } catch {}

  const generated = `tab_${Date.now()}_${Math.random().toString(16).replace(".", "")}`;
  activeTabInstanceId = generated;
  try {
    sessionStorage.setItem(ACTIVE_TAB_INSTANCE_ID_KEY, generated);
  } catch {}

  return activeTabInstanceId;
}

function getActiveTabViewContext(context) {
  const nextContext = context || overlayState.context || {};
  const contextLabel = [
    toText(nextContext.pageContext),
    toText(nextContext.pageType),
    toText(nextContext.activityTitle || nextContext.repoFullName || nextContext.url),
  ]
    .filter(Boolean)
    .join(" | ");

  return contextLabel.slice(0, ACTIVE_TAB_VIEW_CONTEXT_MAX);
}

function getActiveTabConflictNotice() {
  return activeTabConflictNotice;
}

function clearActiveTabConflictNotice() {
  if (!activeTabConflictNotice) return;
  activeTabConflictNotice = "";
}

function setActiveTabConflictNotice(message) {
  const nextMessage = toText(message).slice(0, 280);
  if (activeTabConflictNotice === nextMessage) return;
  activeTabConflictNotice = nextMessage;
  if (overlayEls) {
    renderOverlay();
  }
}

function sanitizeActiveTabPayload(value, max) {
  return toText(value).slice(0, Number(max) || 0);
}

// Otra pestana tiene la sesion activa (y no es el Codespace que abrio esta misma pestana).
function isForeignActiveTabState(remoteActiveTab) {
  const localTabId = getActiveTabInstanceId();
  const hasForeignActiveTab = remoteActiveTab?.isActive
    && remoteActiveTab?.tabId
    && remoteActiveTab.tabId !== localTabId
    && !remoteActiveTab.stale;
  return !!hasForeignActiveTab && !shouldIgnoreForeignActiveTabForCodespace(remoteActiveTab);
}

function applyRemoteActiveTabState(remoteActiveTab) {
  if (!isForeignActiveTabState(remoteActiveTab)) {
    clearActiveTabConflictNotice();
    return false;
  }

  const tabLabel = toText(remoteActiveTab.tabTitle) || remoteActiveTab.tabId || "otra pestaña";
  const context = toText(remoteActiveTab.viewContext);
  const message = context
    ? `Sesion activa en otra pestaña: ${tabLabel} (${context}).`
    : `Sesion activa en otra pestaña: ${tabLabel}.`;

  setActiveTabConflictNotice(message);
  if (overlayState.started) {
    overlayState.started = false;
    overlayState.analysisUnlocked = false;
    overlayState.analysisWindowOpen = false;
  }

  return true;
}

async function sendActiveTabState(nextIsActive = true, extraPayload = {}) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const sessionId = toText(overlayState.sessionId);
  const now = Date.now();
  const force = extraPayload?.force === true;
  const payloadExtras = { ...(extraPayload || {}) };
  delete payloadExtras.force;
  if (!baseUrl || !sessionId) return false;
  if (nextIsActive && (!overlayState.started || savedEditorAutoEnterIdle)) {
    return false;
  }
  if (!force && !nextIsActive && now - activeTabLastReportAt < ACTIVE_TAB_DEACTIVATE_DELAY_MS) {
    return false;
  }
  if (!force && nextIsActive && now - activeTabLastReportAt < ACTIVE_TAB_MIN_REPORT_MS) {
    return false;
  }

  const sourceContext = overlayState.context || buildPayload();
  const payload = {
    isActive: !!nextIsActive,
    ...payloadExtras,
    tabId: getActiveTabInstanceId(),
    tabUrl: sanitizeActiveTabPayload(sourceContext.url, 1800),
    tabTitle: sanitizeActiveTabPayload(sourceContext.title, 600),
    viewContext: getActiveTabViewContext(sourceContext),
  };

  if (!nextIsActive) {
    payload.tabId = sanitizeActiveTabPayload(getActiveTabInstanceId(), 220);
  }

  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/ui/active-tab`, {
      method: "POST",
      headers: buildApiHeaders(),
      body: JSON.stringify(payload),
    });
    activeTabLastReportAt = now;

    applyRemoteActiveTabState(response?.activeTab);
    return true;
  } catch {
    return false;
  }
}

function queueActiveTabReport(nextIsActive = true) {
  if (activeTabHeartbeatTimer) {
    window.clearTimeout(activeTabHeartbeatTimer);
  }

  const delayMs = nextIsActive ? 0 : ACTIVE_TAB_DEACTIVATE_DELAY_MS;
  activeTabHeartbeatTimer = window.setTimeout(() => {
    activeTabHeartbeatTimer = 0;
    sendActiveTabState(nextIsActive).catch(() => {});
  }, delayMs);
}

function scheduleActiveTabDeactivation() {
  if (activeTabDeactivationTimer) {
    window.clearTimeout(activeTabDeactivationTimer);
  }

  activeTabDeactivationTimer = window.setTimeout(() => {
    activeTabDeactivationTimer = 0;
    if (document.visibilityState !== "visible") {
      queueActiveTabReport(false);
    }
  }, ACTIVE_TAB_DEACTIVATE_DELAY_MS);
}

function clearActiveTabDeactivation() {
  if (!activeTabDeactivationTimer) return;
  window.clearTimeout(activeTabDeactivationTimer);
  activeTabDeactivationTimer = 0;
}

async function refreshActiveTabStateFromBackend(options = {}) {
  if (activeTabSyncInFlight) return activeTabSyncInFlight;

  const force = options.force === true;
  const now = Date.now();
  if (!force && now - activeTabLastSyncAt < ACTIVE_TAB_POLL_INTERVAL_MS) {
    return false;
  }
  activeTabLastSyncAt = now;

  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) return false;

  activeTabSyncInFlight = (async () => {
    try {
      const response = await fetchJsonWithTimeout(`${baseUrl}/api/ui/active-tab`, {
        method: "GET",
        headers: buildApiHeaders(),
      });
      if (!response?.ok) return false;
      await refreshCodespaceHandoffCache(overlayState.context || buildPayload());
      return applyRemoteActiveTabState(response.activeTab);
    } catch {
      return false;
    }
  })();

  try {
    return await activeTabSyncInFlight;
  } finally {
    activeTabSyncInFlight = null;
  }
}

// Solo consulta: dice si otra pestana tiene la sesion activa sin mostrar el aviso de conflicto.
// Al restaurar el overlay fijado en una pagina que se acaba de cargar (por ejemplo, una
// pestana abierta segundos despues de usar el overlay en otra), esa pestana se queda en la
// bienvenida en vez de abrir "Ya hay una sesion activa".
async function probeForeignActiveTab() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) return false;
  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/ui/active-tab`, {
      method: "GET",
      headers: buildApiHeaders(),
    });
    if (!response?.ok) return false;
    await refreshCodespaceHandoffCache(overlayState.context || buildPayload());
    return isForeignActiveTabState(response.activeTab);
  } catch {
    return false;
  }
}

function syncFromActiveTabStream() {
  if (document.visibilityState === "visible") {
    clearActiveTabDeactivation();
    queueActiveTabReport(true);
  } else {
    scheduleActiveTabDeactivation();
  }

  if (document.visibilityState === "visible") {
    refreshActiveTabStateFromBackend({ force: true }).catch(() => {});
  }
}

function bindActiveTabSyncListeners() {
  const handleForeground = () => {
    if (document.visibilityState === "hidden") {
      scheduleActiveTabDeactivation();
      return;
    }

    clearActiveTabDeactivation();
    syncFromActiveTabStream();
  };

  window.addEventListener("focus", handleForeground);
  window.addEventListener("blur", scheduleActiveTabDeactivation);
  document.addEventListener("visibilitychange", handleForeground);
  window.addEventListener("pageshow", handleForeground);

  if (!activeTabSyncTimer) {
    activeTabSyncTimer = window.setInterval(() => {
      refreshActiveTabStateFromBackend().catch(() => {});
    }, ACTIVE_TAB_POLL_INTERVAL_MS);
  }

  window.addEventListener("beforeunload", () => {
    queueActiveTabReport(false);
    if (activeTabSyncTimer) {
      window.clearInterval(activeTabSyncTimer);
      activeTabSyncTimer = 0;
    }
  });
}

// Listener del aviso de conflicto de pestana activa (antes dentro de ensureOverlay).
function bindTabConflictNotice() {
  overlayEls.tabConflictRefreshBtn?.addEventListener("click", async () => {
    if (!overlayEls.tabConflictRefreshBtn) return;
    overlayState.loading = true;
    renderOverlay();
    await refreshActiveTabStateFromBackend({ force: true }).catch(() => {});
    overlayState.loading = false;
    renderOverlay();
  });
}
