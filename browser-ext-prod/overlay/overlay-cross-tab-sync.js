// ADACEEN | Capa 5 - Ciclo de vida: sincronizacion de sesion y preferencias entre pestanas via chrome.storage.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const SHARED_STORAGE_SYNC_KEYS = [
  STORAGE_KEY_ENABLED,
  STORAGE_KEY_BACKEND_URL,
  STORAGE_KEY_LEARNING_GOAL,
  STORAGE_KEY_SELECTED_RAG_COURSE,
  STORAGE_KEY_SESSION_ID,
  STORAGE_KEY_ACTIVE_SESSION_SNAPSHOT,
  STORAGE_KEY_PRIVACY_ACCEPTED_BY_USER,
  STORAGE_KEY_PROJECT_CONSENT_BY_USER,
  STORAGE_KEY_SETUP_DONE_BY_USER,
  STORAGE_KEY_AUTO_CONFIG_ENABLED,
  STORAGE_KEY_OVERLAY_PINNED,
  STORAGE_KEY_OVERLAY_MINIMIZED,
];

const FOREGROUND_SYNC_THROTTLE_MS = 1400;
let foregroundSyncInFlight = null;
let lastForegroundSyncAt = 0;
let crossTabSyncListenersBound = false;

function resetAuthStateForCrossTabSync(statusMessage = "") {
  overlayState.sessionId = "";
  overlayState.session = null;
  overlayState.policy = { ...DEFAULT_POLICY };
  overlayState.telemetry = [];
  overlayState.behaviorMetrics = [];
  overlayState.firstLoginConfirmationOpen = false;
  overlayState.studentCourseModalOpen = false;
  overlayState.studentCourseState = { ...EMPTY_STUDENT_COURSE_STATE };
  overlayState.campusCourseAccess = { ...EMPTY_CAMPUS_COURSE_ACCESS_STATE };
  overlayState.processNoticeOpen = false;
  overlayState.authError = "";
  overlayState.githubAppStatus = { ...EMPTY_GITHUB_APP_STATUS };
  overlayState.githubUserStatus = { ...EMPTY_GITHUB_USER_STATUS };
  if (statusMessage) {
    overlayState.statusMessage = statusMessage;
  }
}

function normalizeSharedSessionSnapshot(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!raw) return null;

  const session = raw.session && typeof raw.session === "object" && !Array.isArray(raw.session)
    ? raw.session
    : null;
  const sessionId = toText(raw.sessionId || session?.id);
  if (!sessionId || !session) return null;

  return {
    sessionId,
    backendUrl: normalizeBaseUrl(raw.backendUrl),
    session,
    policy: raw.policy && typeof raw.policy === "object" && !Array.isArray(raw.policy)
      ? raw.policy
      : { ...DEFAULT_POLICY },
    telemetry: Array.isArray(raw.telemetry) ? raw.telemetry : [],
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

function applySharedSessionSnapshot(value) {
  const snapshot = normalizeSharedSessionSnapshot(value);
  if (!snapshot) return false;

  const currentRaw = JSON.stringify({
    sessionId: overlayState.sessionId,
    backendUrl: normalizeBaseUrl(overlayState.backendUrl),
    session: overlayState.session || null,
    policy: overlayState.policy || null,
    telemetry: Array.isArray(overlayState.telemetry) ? overlayState.telemetry : [],
  });

  overlayState.sessionId = snapshot.sessionId;
  if (snapshot.backendUrl) {
    overlayState.backendUrl = snapshot.backendUrl;
  }
  overlayState.session = snapshot.session;
  overlayState.policy = snapshot.policy;
  overlayState.telemetry = snapshot.telemetry;
  overlayState.behaviorMetrics = [];
  overlayState.firstLoginConfirmationOpen = !hasAcceptedPrivacyForSession(snapshot.session);
  overlayState.authError = "";

  const nextRaw = JSON.stringify({
    sessionId: overlayState.sessionId,
    backendUrl: normalizeBaseUrl(overlayState.backendUrl),
    session: overlayState.session || null,
    policy: overlayState.policy || null,
    telemetry: Array.isArray(overlayState.telemetry) ? overlayState.telemetry : [],
  });

  return currentRaw !== nextRaw;
}

function applySharedPreferenceSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return false;

  let changed = false;

  if (Object.prototype.hasOwnProperty.call(snapshot, STORAGE_KEY_ENABLED)) {
    const nextEnabled = typeof snapshot[STORAGE_KEY_ENABLED] === "boolean"
      ? snapshot[STORAGE_KEY_ENABLED]
      : true;
    if (overlayState.assistantEnabled !== nextEnabled) {
      overlayState.assistantEnabled = nextEnabled;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(snapshot, STORAGE_KEY_BACKEND_URL)) {
    const nextBackendUrl = resolveStoredBackendUrl(snapshot[STORAGE_KEY_BACKEND_URL]);
    if (overlayState.backendUrl !== nextBackendUrl) {
      overlayState.backendUrl = nextBackendUrl;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(snapshot, STORAGE_KEY_LEARNING_GOAL)) {
    const nextGoalId = LEARNING_GOALS.some((goal) => goal.id === snapshot[STORAGE_KEY_LEARNING_GOAL])
      ? snapshot[STORAGE_KEY_LEARNING_GOAL]
      : DEFAULT_LEARNING_GOAL;
    if (overlayState.selectedLearningGoal !== nextGoalId) {
      overlayState.selectedLearningGoal = nextGoalId;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(snapshot, STORAGE_KEY_SELECTED_RAG_COURSE)) {
    const nextCourseCode = toText(snapshot[STORAGE_KEY_SELECTED_RAG_COURSE]) || "FPOO";
    if (overlayState.studentCourseState?.selectedCourseCode !== nextCourseCode) {
      overlayState.studentCourseState = {
        ...(overlayState.studentCourseState || EMPTY_STUDENT_COURSE_STATE),
        selectedCourseCode: nextCourseCode,
      };
      overlayState.campusCourseAccess = { ...EMPTY_CAMPUS_COURSE_ACCESS_STATE };
      overlayState.campusAnalysis = null;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(snapshot, STORAGE_KEY_AUTO_CONFIG_ENABLED)) {
    const nextAutoConfigEnabled = typeof snapshot[STORAGE_KEY_AUTO_CONFIG_ENABLED] === "boolean"
      ? snapshot[STORAGE_KEY_AUTO_CONFIG_ENABLED]
      : true;
    if (overlayState.autoConfigEnabled !== nextAutoConfigEnabled) {
      overlayState.autoConfigEnabled = nextAutoConfigEnabled;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(snapshot, STORAGE_KEY_OVERLAY_MINIMIZED)) {
    const nextMinimized = snapshot[STORAGE_KEY_OVERLAY_MINIMIZED] === true;
    if (overlayState.minimized !== nextMinimized) {
      overlayState.minimized = nextMinimized;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(snapshot, STORAGE_KEY_PRIVACY_ACCEPTED_BY_USER)) {
    const nextPrivacyAcceptedByUser =
      snapshot[STORAGE_KEY_PRIVACY_ACCEPTED_BY_USER]
      && typeof snapshot[STORAGE_KEY_PRIVACY_ACCEPTED_BY_USER] === "object"
      && !Array.isArray(snapshot[STORAGE_KEY_PRIVACY_ACCEPTED_BY_USER])
        ? snapshot[STORAGE_KEY_PRIVACY_ACCEPTED_BY_USER]
        : {};
    const currentPrivacyRaw = JSON.stringify(overlayState.privacyAcceptedByUser || {});
    const nextPrivacyRaw = JSON.stringify(nextPrivacyAcceptedByUser);
    if (currentPrivacyRaw !== nextPrivacyRaw) {
      overlayState.privacyAcceptedByUser = nextPrivacyAcceptedByUser;
      if (hasActiveSession()) {
        overlayState.firstLoginConfirmationOpen = !hasAcceptedPrivacyForSession();
      }
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(snapshot, STORAGE_KEY_PROJECT_CONSENT_BY_USER)) {
    const nextConsentByUser =
      snapshot[STORAGE_KEY_PROJECT_CONSENT_BY_USER]
      && typeof snapshot[STORAGE_KEY_PROJECT_CONSENT_BY_USER] === "object"
      && !Array.isArray(snapshot[STORAGE_KEY_PROJECT_CONSENT_BY_USER])
        ? snapshot[STORAGE_KEY_PROJECT_CONSENT_BY_USER]
        : {};
    const currentConsentRaw = JSON.stringify(overlayState.projectConsentByUser || {});
    const nextConsentRaw = JSON.stringify(nextConsentByUser);
    if (currentConsentRaw !== nextConsentRaw) {
      overlayState.projectConsentByUser = nextConsentByUser;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(snapshot, STORAGE_KEY_SETUP_DONE_BY_USER)) {
    const nextSetupDoneByUser =
      snapshot[STORAGE_KEY_SETUP_DONE_BY_USER]
      && typeof snapshot[STORAGE_KEY_SETUP_DONE_BY_USER] === "object"
      && !Array.isArray(snapshot[STORAGE_KEY_SETUP_DONE_BY_USER])
        ? snapshot[STORAGE_KEY_SETUP_DONE_BY_USER]
        : {};
    const currentSetupDoneRaw = JSON.stringify(overlayState.setupDoneByUser || {});
    const nextSetupDoneRaw = JSON.stringify(nextSetupDoneByUser);
    if (currentSetupDoneRaw !== nextSetupDoneRaw) {
      overlayState.setupDoneByUser = nextSetupDoneByUser;
      changed = true;
    }
  }

  return changed;
}

async function syncSessionFromSharedState(nextSessionId, options = {}) {
  const sharedSessionSnapshot = normalizeSharedSessionSnapshot(options.sessionSnapshot);
  const explicitSessionId = options.hasExplicitSessionId === true;
  const requestedSessionId = toText(nextSessionId);
  const incomingSessionId = requestedSessionId || (explicitSessionId ? "" : toText(sharedSessionSnapshot?.sessionId));
  const currentSessionId = toText(overlayState.sessionId);
  const sessionIdChanged = incomingSessionId !== currentSessionId;

  if (!incomingSessionId) {
    if (!currentSessionId && !hasActiveSession()) {
      return false;
    }

    resetAuthStateForCrossTabSync(options.logoutMessage || "Sesion cerrada en otra pestana.");
    if (overlayHost?.isConnected) {
      renderOverlay();
    }
    return true;
  }

  overlayState.sessionId = incomingSessionId;

  const snapshotApplied = sharedSessionSnapshot?.sessionId === incomingSessionId
    ? applySharedSessionSnapshot(sharedSessionSnapshot)
    : false;
  const sessionHydratedForIncoming = hasActiveSession() && toText(overlayState.session?.id) === incomingSessionId;

  if (!sessionIdChanged && sessionHydratedForIncoming && !snapshotApplied) {
    return false;
  }

  if (!sessionHydratedForIncoming) {
    overlayState.session = null;
    overlayState.policy = { ...DEFAULT_POLICY };
    overlayState.telemetry = [];
    overlayState.behaviorMetrics = [];
    overlayState.firstLoginConfirmationOpen = false;
    overlayState.authError = "";
  }

  let restored = sessionHydratedForIncoming;
  let restoredFromBackend = false;
  let restoreError = "";
  if (!restored) {
    try {
      restored = await fetchCurrentSession();
      restoredFromBackend = restored;
    } catch (error) {
      restored = false;
      restoreError = String(error);
    }
  }

  if (!restored) {
    const invalidSession = /sesion no valida|credenciales invalidas|401/i.test(restoreError);
    if (invalidSession) {
      resetAuthStateForCrossTabSync("La sesion ya no es valida. Inicia sesion nuevamente.");
      await persistPreferences().catch(() => {});
      await clearSharedSessionSnapshot().catch(() => {});
    }
  }

  if (overlayHost?.isConnected) {
    if (overlayState.started && hasActiveSession() && sessionIdChanged) {
      await refreshMentorSession();
    } else {
      renderOverlay();
    }
  }

  return sessionIdChanged || snapshotApplied || restoredFromBackend;
}

async function syncOverlayPinnedState(nextPinnedValue) {
  const shouldBeOpen = nextPinnedValue === true;
  const isOpen = !!(overlayHost?.isConnected && overlayRoot);

  if (shouldBeOpen && !isOpen) {
    await openOverlay();
    return true;
  }

  if (!shouldBeOpen && isOpen) {
    await closeOverlay();
    return true;
  }

  return false;
}

async function syncFromStorageSnapshot(options = {}) {
  if (foregroundSyncInFlight) {
    return foregroundSyncInFlight;
  }

  const now = Date.now();
  const force = options.force === true;
  if (!force && now - lastForegroundSyncAt < FOREGROUND_SYNC_THROTTLE_MS) {
    return false;
  }
  lastForegroundSyncAt = now;

  foregroundSyncInFlight = (async () => {
    try {
      await loadPreferences();
      const snapshot = await chrome.storage.local.get(SHARED_STORAGE_SYNC_KEYS);
      const preferencesChanged = applySharedPreferenceSnapshot(snapshot);
      const sessionChanged = await syncSessionFromSharedState(snapshot[STORAGE_KEY_SESSION_ID], {
        hasExplicitSessionId: Object.prototype.hasOwnProperty.call(snapshot, STORAGE_KEY_SESSION_ID),
        sessionSnapshot: snapshot[STORAGE_KEY_ACTIVE_SESSION_SNAPSHOT],
        logoutMessage: "Sesion cerrada en otra pestana.",
      });
      const pinnedChanged = options.skipPinned === true
        ? false
        : await syncOverlayPinnedState(snapshot[STORAGE_KEY_OVERLAY_PINNED]);

      if (!sessionChanged && !pinnedChanged && preferencesChanged && overlayHost?.isConnected) {
        renderOverlay();
      }

      return sessionChanged || pinnedChanged || preferencesChanged;
    } catch {
      return false;
    } finally {
      foregroundSyncInFlight = null;
    }
  })();

  return foregroundSyncInFlight;
}

async function persistOverlayMinimizedPreference() {
  if (!isExtensionRuntimeReady()) return;
  try {
    await chrome.storage.local.set({
      [STORAGE_KEY_OVERLAY_MINIMIZED]: overlayState.minimized === true,
    });
  } catch {}
}

async function setOverlayMinimized(nextMinimized, options = {}) {
  const minimized = nextMinimized === true;
  if (overlayState.minimized === minimized && options.force !== true) {
    return;
  }

  overlayState.minimized = minimized;
  if (minimized) {
    overlayState.settingsOpen = false;
  }

  if (options.persist !== false) {
    await persistOverlayMinimizedPreference();
  }

  if (overlayHost?.isConnected) {
    renderOverlay();
    scheduleOverlayViewportSync(true);
  }
  queueTabSessionSave();
}

function bindCrossTabSyncListeners() {
  if (crossTabSyncListenersBound) return;

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes) return;

    const snapshot = {};
    let hasSharedChanges = false;
    for (const key of SHARED_STORAGE_SYNC_KEYS) {
      if (Object.prototype.hasOwnProperty.call(changes, key)) {
        snapshot[key] = changes[key]?.newValue;
        hasSharedChanges = true;
      }
    }

    if (!hasSharedChanges) return;

    loadPreferences()
      .then(async () => {
        const preferencesChanged = applySharedPreferenceSnapshot(snapshot);
        let sessionChanged = false;
        let pinnedChanged = false;

        if (
          Object.prototype.hasOwnProperty.call(snapshot, STORAGE_KEY_SESSION_ID)
          || Object.prototype.hasOwnProperty.call(snapshot, STORAGE_KEY_ACTIVE_SESSION_SNAPSHOT)
        ) {
          sessionChanged = await syncSessionFromSharedState(snapshot[STORAGE_KEY_SESSION_ID], {
            hasExplicitSessionId: Object.prototype.hasOwnProperty.call(snapshot, STORAGE_KEY_SESSION_ID),
            sessionSnapshot: snapshot[STORAGE_KEY_ACTIVE_SESSION_SNAPSHOT],
            logoutMessage: "Sesion cerrada en otra pestana.",
          });
        }

        if (Object.prototype.hasOwnProperty.call(snapshot, STORAGE_KEY_OVERLAY_PINNED)) {
          pinnedChanged = await syncOverlayPinnedState(snapshot[STORAGE_KEY_OVERLAY_PINNED]);
        }

        if (!sessionChanged && !pinnedChanged && preferencesChanged && overlayHost?.isConnected) {
          renderOverlay();
        }
      })
      .catch(() => {});
  });

  const handleForegroundSync = () => {
    if (document.visibilityState === "hidden") return;
    syncFromStorageSnapshot().catch(() => {});
  };

  document.addEventListener("visibilitychange", handleForegroundSync);
  window.addEventListener("focus", handleForegroundSync);
  window.addEventListener("pageshow", handleForegroundSync);
  crossTabSyncListenersBound = true;
}
