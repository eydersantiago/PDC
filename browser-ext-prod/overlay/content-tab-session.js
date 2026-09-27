// ADACEEN | Capa 5 - Ciclo de vida: estado del overlay por pestana (guardar y restaurar la sesion de cada
// pestana) y sincronizacion entre pestanas a traves de chrome.storage (sesion y preferencias compartidas).
// Movido sin cambios desde content-lifecycle.js.
// Sin "use strict": el codigo viene de archivos en modo no estricto y se conserva igual.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

const STORAGE_KEY_TAB_SESSION_MAP = "adaceenOverlayTabSessionMap";

const TAB_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const TAB_SESSION_MAX_ENTRIES = 24;

const TAB_SESSION_PREVIEW_CHARS = 1400;

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
  STORAGE_KEY_EDITOR_BY_USER,
  STORAGE_KEY_EDITOR_CHOICE_BY_USER,
  STORAGE_KEY_AUTO_CONFIG_ENABLED,
  STORAGE_KEY_OVERLAY_PINNED,
  STORAGE_KEY_OVERLAY_MINIMIZED,
];

const FOREGROUND_SYNC_THROTTLE_MS = 1400;

let tabSessionSaveTimer = 0;

let foregroundSyncInFlight = null;

let lastForegroundSyncAt = 0;

let crossTabSyncListenersBound = false;

function buildTabSessionKey(context) {
  const raw = toText(context?.url || overlayState?.context?.url || location.href || "");
  if (!raw) {
    return "";
  }

  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    const normalized = `${parsed.origin}${parsed.pathname}`.toLowerCase();
    return `${toText(overlayState?.session?.id || overlayState.sessionId || overlayState?.session?.user?.id || "anonymous")}:${normalized}`;
  } catch {
    return `${toText(overlayState?.session?.id || overlayState.sessionId || overlayState?.session?.user?.id || "anonymous")}:${raw
      .split("#")[0]
      .toLowerCase()}`;
  }
}

function compactTabSessionText(value, max = TAB_SESSION_PREVIEW_CHARS) {
  const text = toText(value);
  if (!text) return "";
  if (!Number.isFinite(max) || max <= 0) return "";
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

function normalizeSessionList(values, limit) {
  if (!Array.isArray(values)) return [];
  return values
    .filter((item) => typeof item === "string" && item.trim())
    .slice(0, Math.max(1, Number(limit) || 1));
}

function buildTabSessionSnapshot(context) {
  const payload = context || overlayState.context || buildPayload();
  return {
    ts: Date.now(),
    // Una entrada automatica sin interaccion no se restaura como iniciada: al recargar, la
    // pestana vuelve a decidir con autoEnterWithSavedEditor.
    started: !!overlayState.started && !savedEditorAutoEnterIdle,
    settingsOpen: !!overlayState.settingsOpen,
    minimized: !!overlayState.minimized,
    analysisWindowOpen: !!overlayState.analysisWindowOpen,
    analysisUnlocked: !!overlayState.analysisUnlocked,
    setupRepoFullName: toText(overlayState.setupRepoFullName),
    setupWizardStep: Math.max(1, Math.min(3, Number(overlayState.setupWizardStep) || 1)),
    setupPrResultByUser: overlayState.setupPrResultByUser && typeof overlayState.setupPrResultByUser === "object"
      ? overlayState.setupPrResultByUser
      : {},
    ideas: normalizeSessionList(overlayState.ideas, MAX_LIST_ITEMS),
    guide: normalizeSessionList(overlayState.guide, MAX_LIST_ITEMS),
    welcome: toText(overlayState.welcome),
    mentorSummary: toText(overlayState.mentorSummary),
    activeRagCourseCode: toText(overlayState.activeRagCourseCode),
    statusMessage: toText(overlayState.statusMessage),
    operationTitle: toText(overlayState.operationTitle),
    operationDetail: toText(overlayState.operationDetail),
    operationKind: toText(overlayState.operationKind),
    projectContextMessage: toText(overlayState.projectContextMessage),
    projectContextError: toText(overlayState.projectContextError),
    projectContextStatus: normalizeProjectContextStatusPayload(overlayState.projectContextStatus),
    projectContextHistory: normalizeProjectContextHistoryPayload(overlayState.projectContextHistory).slice(0, 12),
    projectContextInsight: normalizeProjectContextInsightPayload(overlayState.projectContextInsight),
    documentClassifications: normalizeDocumentClassificationState(overlayState.documentClassifications),
    campusAnalysis: overlayState.campusAnalysis || null,
    campusCourseAccess: typeof normalizeCampusCourseAccessState === "function"
      ? normalizeCampusCourseAccessState(overlayState.campusCourseAccess)
      : overlayState.campusCourseAccess,
    context: {
      url: compactTabSessionText(toText(payload.url).split("#")[0], 600),
      title: compactTabSessionText(payload.title, 280),
      pageContext: toText(payload.pageContext),
      pageType: toText(payload.pageType),
      repoOwner: toText(payload.repoOwner),
      repoName: toText(payload.repoName),
      repoFullName: toText(payload.repoFullName),
      branch: toText(payload.branch),
      filePath: toText(payload.filePath),
      languageHint: toText(payload.languageHint),
      activityTitle: compactTabSessionText(payload.activityTitle, 260),
      activityDeadline: compactTabSessionText(payload.activityDeadline, 260),
      visibleError: compactTabSessionText(payload.visibleError, 420),
      codeSnippet: compactTabSessionText(payload.codeSnippet, 900),
      codeLineCount: Number(payload.codeLineCount) || 0,
    },
  };
}

function pruneTabSessionStore(store, now = Date.now()) {
  const entries = Object.entries(store || {})
    .filter((entry) => {
      const payload = entry[1];
      return payload && typeof payload === "object" && Number.isFinite(Number(payload.ts));
    })
    .filter((entry) => {
      const payload = entry[1];
      return now - Number(payload.ts) <= TAB_SESSION_TTL_MS;
    })
    .sort((a, b) => Number(b[1].ts) - Number(a[1].ts));

  const pruned = {};
  for (let i = 0; i < entries.length && i < TAB_SESSION_MAX_ENTRIES; i++) {
    const [key, payload] = entries[i];
    pruned[key] = payload;
  }
  return pruned;
}

async function loadTabSessionSnapshot(context) {
  const key = buildTabSessionKey(context);
  if (!key) return null;

  try {
    const raw = await chrome.storage.local.get([STORAGE_KEY_TAB_SESSION_MAP]);
    const storageMap = raw?.[STORAGE_KEY_TAB_SESSION_MAP];
    const data = (storageMap && typeof storageMap === "object" && !Array.isArray(storageMap))
      ? storageMap
      : {};
    const payload = data[key];

    if (!payload || !payload.state || !Number.isFinite(Number(payload.ts))) {
      return null;
    }

    const now = Date.now();
    if (now - Number(payload.ts) > TAB_SESSION_TTL_MS) {
      const pruned = pruneTabSessionStore(data, now);
      delete pruned[key];
      await chrome.storage.local.set({ [STORAGE_KEY_TAB_SESSION_MAP]: pruned });
      return null;
    }

    return payload.state;
  } catch {
    return null;
  }
}

function applyTabSessionSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;

  overlayState.started = !!snapshot.started;
  overlayState.settingsOpen = !!snapshot.settingsOpen;
  overlayState.minimized = !!snapshot.minimized;
  overlayState.analysisWindowOpen = !!snapshot.analysisWindowOpen;
  overlayState.analysisUnlocked = !!snapshot.analysisUnlocked;
  overlayState.setupRepoFullName = toText(snapshot.setupRepoFullName);
  overlayState.setupWizardStep = Math.max(1, Math.min(3, Number(snapshot.setupWizardStep) || 1));
  overlayState.setupPrResultByUser = snapshot.setupPrResultByUser && typeof snapshot.setupPrResultByUser === "object"
    ? snapshot.setupPrResultByUser
    : overlayState.setupPrResultByUser;
  overlayState.ideas = normalizeSessionList(snapshot.ideas, MAX_LIST_ITEMS);
  overlayState.guide = normalizeSessionList(snapshot.guide, MAX_LIST_ITEMS);
  overlayState.welcome = toText(snapshot.welcome);
  overlayState.mentorSummary = toText(snapshot.mentorSummary);
  overlayState.activeRagCourseCode = toText(snapshot.activeRagCourseCode);
  overlayState.statusMessage = toText(snapshot.statusMessage);
  // La espera de la GitHub App no sobrevive a una recarga (la consulta periodica se corto):
  // su aviso no se restaura para no prometer una deteccion que ya no ocurre.
  const restoredOperationTitle = toText(snapshot.operationTitle);
  const staleAppWait = restoredOperationTitle === GITHUB_APP_INSTALL_WAIT_TITLE
    && !(typeof isWatchingGithubAppInstall === "function" && isWatchingGithubAppInstall());
  overlayState.operationTitle = staleAppWait ? "" : restoredOperationTitle;
  overlayState.operationDetail = staleAppWait ? "" : toText(snapshot.operationDetail);
  overlayState.operationKind = (staleAppWait ? "" : toText(snapshot.operationKind)) || "busy";
  overlayState.projectContextMessage = toText(snapshot.projectContextMessage);
  overlayState.projectContextError = toText(snapshot.projectContextError);
  overlayState.projectContextStatus = normalizeProjectContextStatusPayload(snapshot.projectContextStatus || overlayState.projectContextStatus);
  overlayState.projectContextHistory = normalizeProjectContextHistoryPayload(snapshot.projectContextHistory).slice(0, 12);
  overlayState.projectContextInsight = normalizeProjectContextInsightPayload(snapshot.projectContextInsight || overlayState.projectContextInsight);
  overlayState.documentClassifications = normalizeDocumentClassificationState(snapshot.documentClassifications || overlayState.documentClassifications);
  overlayState.campusAnalysis = snapshot.campusAnalysis && typeof snapshot.campusAnalysis === "object"
    ? snapshot.campusAnalysis
    : overlayState.campusAnalysis;
  if (typeof normalizeCampusCourseAccessState === "function") {
    // Una verificacion que quedo a medias al guardar la pestana no sigue en curso.
    overlayState.campusCourseAccess = {
      ...normalizeCampusCourseAccessState(snapshot.campusCourseAccess || overlayState.campusCourseAccess),
      checking: false,
    };
  }
}

async function persistTabSessionSnapshot() {
  const key = buildTabSessionKey(overlayState.context || buildPayload());
  if (!key) return;

  try {
    const raw = await chrome.storage.local.get([STORAGE_KEY_TAB_SESSION_MAP]);
    const storageMap = raw?.[STORAGE_KEY_TAB_SESSION_MAP];
    const existing = (storageMap && typeof storageMap === "object" && !Array.isArray(storageMap))
      ? storageMap
      : {};

    const pruned = pruneTabSessionStore({
      ...existing,
      [key]: {
        ts: Date.now(),
        state: buildTabSessionSnapshot(overlayState.context || buildPayload()),
      },
    }, Date.now());

    await chrome.storage.local.set({ [STORAGE_KEY_TAB_SESSION_MAP]: pruned });
  } catch {}
}

function queueTabSessionSave() {
  if (tabSessionSaveTimer) {
    return;
  }

  tabSessionSaveTimer = window.setTimeout(async () => {
    tabSessionSaveTimer = 0;
    await persistTabSessionSnapshot();
  }, 500);
}

async function flushTabSessionSave() {
  if (!tabSessionSaveTimer) {
    await persistTabSessionSnapshot();
    return;
  }

  window.clearTimeout(tabSessionSaveTimer);
  tabSessionSaveTimer = 0;
  await persistTabSessionSnapshot();
}

function resetAuthStateForCrossTabSync(statusMessage = "") {
  overlayState.sessionId = "";
  overlayState.session = null;
  overlayState.mainTab = "inicio";
  overlayState.mainTabChosenByUser = false;
  overlayState.studentsPanel = { ...EMPTY_STUDENTS_PANEL_STATE };
  overlayState.quizzesPanel = { ...EMPTY_QUIZZES_PANEL_STATE };
  overlayState.ragLots = { ...EMPTY_RAG_LOTS_STATE };
  overlayState.policy = { ...DEFAULT_POLICY };
  overlayState.telemetry = [];
  overlayState.behaviorMetrics = [];
  overlayState.firstLoginConfirmationOpen = false;
  overlayState.studentCourseModalOpen = false;
  overlayState.studentCourseState = { ...EMPTY_STUDENT_COURSE_STATE };
  overlayState.campusCourseAccess = { ...EMPTY_CAMPUS_COURSE_ACCESS_STATE };
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
  overlayState.firstLoginConfirmationOpen = typeof hasAcceptedPrivacyForSession === "function"
    ? !hasAcceptedPrivacyForSession(snapshot.session)
    : false;
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
    const nextBackendUrl = typeof resolveStoredBackendUrl === "function"
      ? resolveStoredBackendUrl(snapshot[STORAGE_KEY_BACKEND_URL])
      : normalizeBaseUrl(snapshot[STORAGE_KEY_BACKEND_URL]) || DEFAULT_BACKEND_URL;
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
      if (hasActiveSession() && typeof hasAcceptedPrivacyForSession === "function") {
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

  if (Object.prototype.hasOwnProperty.call(snapshot, STORAGE_KEY_EDITOR_BY_USER)) {
    const nextEditorByUser = normalizeSavedEditorMap(snapshot[STORAGE_KEY_EDITOR_BY_USER]);
    if (JSON.stringify(overlayState.editorByUser || {}) !== JSON.stringify(nextEditorByUser)) {
      overlayState.editorByUser = nextEditorByUser;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(snapshot, STORAGE_KEY_EDITOR_CHOICE_BY_USER)) {
    const nextEditorChoiceByUser = normalizeEditorChoiceMap(snapshot[STORAGE_KEY_EDITOR_CHOICE_BY_USER]);
    if (JSON.stringify(overlayState.editorChoiceByUser || {}) !== JSON.stringify(nextEditorChoiceByUser)) {
      overlayState.editorChoiceByUser = nextEditorChoiceByUser;
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
      if (typeof clearSharedSessionSnapshot === "function") {
        await clearSharedSessionSnapshot().catch(() => {});
      }
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
