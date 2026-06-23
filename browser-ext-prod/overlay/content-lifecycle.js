
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
  STORAGE_KEY_PRIVACY_ACCEPTED_BY_USER,
  STORAGE_KEY_PROJECT_CONSENT_BY_USER,
  STORAGE_KEY_SETUP_DONE_BY_USER,
  STORAGE_KEY_AUTO_CONFIG_ENABLED,
  STORAGE_KEY_OVERLAY_PINNED,
];
const FOREGROUND_SYNC_THROTTLE_MS = 1400;
const ACTIVE_TAB_POLL_INTERVAL_MS = 9000;
const ACTIVE_TAB_DEACTIVATE_DELAY_MS = 2500;
const ACTIVE_TAB_MIN_REPORT_MS = 900;
const ACTIVE_TAB_INSTANCE_ID_KEY = "adaceenActiveTabInstanceId";
const ACTIVE_TAB_VIEW_CONTEXT_MAX = 280;
let tabSessionSaveTimer = 0;
let foregroundSyncInFlight = null;
let lastForegroundSyncAt = 0;
let crossTabSyncListenersBound = false;
let activeTabHeartbeatTimer = 0;
let activeTabSyncTimer = 0;
let activeTabDeactivationTimer = 0;
let activeTabSyncInFlight = null;
let activeTabLastSyncAt = 0;
let activeTabLastReportAt = 0;
let activeTabConflictNotice = "";
let activeTabInstanceId = "";
let overlayOpenInFlight = null;

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
    started: !!overlayState.started,
    settingsOpen: !!overlayState.settingsOpen,
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
    statusMessage: toText(overlayState.statusMessage),
    operationTitle: toText(overlayState.operationTitle),
    operationDetail: toText(overlayState.operationDetail),
    operationKind: toText(overlayState.operationKind),
    processNoticeOpen: !!overlayState.processNoticeOpen,
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
  overlayState.statusMessage = toText(snapshot.statusMessage);
  overlayState.operationTitle = toText(snapshot.operationTitle);
  overlayState.operationDetail = toText(snapshot.operationDetail);
  overlayState.operationKind = toText(snapshot.operationKind) || "busy";
  overlayState.processNoticeOpen = !!snapshot.processNoticeOpen;
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
    overlayState.campusCourseAccess = normalizeCampusCourseAccessState(snapshot.campusCourseAccess || overlayState.campusCourseAccess);
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

function resetOverlayStateForOpen() {
  overlayState.started = false;
  overlayState.settingsOpen = false;
  overlayState.loading = false;
  overlayState.analysisBusy = false;
  overlayState.analysisUnlocked = false;
  overlayState.analysisWindowOpen = false;
  overlayState.projectAnalysis = null;
  overlayState.campusAnalysis = null;
  overlayState.setupRepoFullName = "";
  overlayState.setupWizardStep = 1;
  overlayState.githubAppBusy = false;
  overlayState.githubAppStatus = { ...EMPTY_GITHUB_APP_STATUS };
  overlayState.githubUserStatus = { ...EMPTY_GITHUB_USER_STATUS };
  overlayState.projectContextBusy = false;
  overlayState.projectContextStatus = { ...EMPTY_PROJECT_CONTEXT_STATUS };
  overlayState.projectContextHistory = [];
  overlayState.projectContextInsight = { ...EMPTY_PROJECT_CONTEXT_INSIGHT };
  overlayState.documentClassifications = { ...EMPTY_DOCUMENT_CLASSIFICATION_STATE };
  overlayState.teacherBitacoraPageOpen = false;
  overlayState.teacherBitacoraStatus = { ...EMPTY_TEACHER_BITACORA_STATUS };
  overlayState.teacherRagPageOpen = false;
  overlayState.teacherRagState = { ...EMPTY_TEACHER_RAG_STATE };
  overlayState.campusCourseAccess = { ...EMPTY_CAMPUS_COURSE_ACCESS_STATE };
  overlayState.ragCourseCatalog = [];
  overlayState.ragDefaultCourseCode = "FPOO";
  overlayState.studentCourseModalOpen = false;
  overlayState.studentCourseState = { ...EMPTY_STUDENT_COURSE_STATE };
  overlayState.projectContextMessage = "";
  overlayState.projectContextError = "";
  overlayState.adminUsers = [];
  overlayState.adminTeachers = [];
  overlayState.adminUsersBusy = false;
  overlayState.adminUsersMessage = "";
  overlayState.ideas = [];
  overlayState.guide = [];
  overlayState.welcome = "";
  overlayState.statusMessage = "";
  overlayState.operationTitle = "";
  overlayState.operationDetail = "";
  overlayState.operationKind = "busy";
  overlayState.context = buildPayload();
}

function resetAuthStateForCrossTabSync(statusMessage = "") {
  overlayState.sessionId = "";
  overlayState.session = null;
  overlayState.policy = { ...DEFAULT_POLICY };
  overlayState.telemetry = [];
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
    const nextBackendUrl = normalizeBaseUrl(snapshot[STORAGE_KEY_BACKEND_URL]) || DEFAULT_BACKEND_URL;
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

  return changed;
}

async function syncSessionFromSharedState(nextSessionId, options = {}) {
  const incomingSessionId = toText(nextSessionId);
  const currentSessionId = toText(overlayState.sessionId);
  const hasSessionObject = hasActiveSession();
  const sessionHydratedForIncoming = hasSessionObject && toText(overlayState.session?.id) === incomingSessionId;
  const sessionIdChanged = incomingSessionId !== currentSessionId;

  if (!incomingSessionId) {
    if (!currentSessionId && !hasSessionObject) {
      return false;
    }

    resetAuthStateForCrossTabSync(options.logoutMessage || "Sesion cerrada en otra pestana.");
    if (overlayHost?.isConnected) {
      renderOverlay();
    }
    return true;
  }

  overlayState.sessionId = incomingSessionId;

  if (!sessionIdChanged && sessionHydratedForIncoming) {
    return false;
  }

  if (!sessionHydratedForIncoming) {
    overlayState.session = null;
    overlayState.policy = { ...DEFAULT_POLICY };
    overlayState.telemetry = [];
    overlayState.firstLoginConfirmationOpen = false;
    overlayState.authError = "";
  }

  let restored = sessionHydratedForIncoming;
  let restoreError = "";
  if (!restored) {
    try {
      restored = await fetchCurrentSession();
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
    }
  }

  if (overlayHost?.isConnected) {
    if (overlayState.started && hasActiveSession() && sessionIdChanged) {
      await refreshMentorSession();
    } else {
      renderOverlay();
    }
  }

  return sessionIdChanged;
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
        logoutMessage: "Sesion cerrada en otra pestana.",
      });
      const pinnedChanged = await syncOverlayPinnedState(snapshot[STORAGE_KEY_OVERLAY_PINNED]);

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

function applyRemoteActiveTabState(remoteActiveTab) {
  const localTabId = getActiveTabInstanceId();
  const hasForeignActiveTab = remoteActiveTab?.isActive
    && remoteActiveTab?.tabId
    && remoteActiveTab.tabId !== localTabId
    && !remoteActiveTab.stale;

  if (!hasForeignActiveTab) {
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
  if (!baseUrl || !sessionId) return false;
  if (nextIsActive && !overlayState.started) {
    return false;
  }
  if (!nextIsActive && now - activeTabLastReportAt < ACTIVE_TAB_DEACTIVATE_DELAY_MS) {
    return false;
  }
  if (nextIsActive && now - activeTabLastReportAt < ACTIVE_TAB_MIN_REPORT_MS) {
    return false;
  }

  const sourceContext = overlayState.context || buildPayload();
  const payload = {
    isActive: !!nextIsActive,
    ...extraPayload,
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

        if (Object.prototype.hasOwnProperty.call(snapshot, STORAGE_KEY_SESSION_ID)) {
          sessionChanged = await syncSessionFromSharedState(snapshot[STORAGE_KEY_SESSION_ID], {
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

async function detectRepoFromActivePage() {
  overlayState.context = buildPayload();
  const detected = inferRepoFromContext(overlayState.context);
  if (detected) {
    setSetupRepoFullName(detected);
    overlayState.setupWizardStep = 1;
    clearSetupForCurrentUser();
    await persistPreferences();
    overlayState.statusMessage = `Repositorio detectado: ${detected}`;
    try {
      await refreshGithubIntegrationStatus();
    } catch {}
  } else {
    overlayState.statusMessage = "No se pudo detectar owner/repo automaticamente. Pegalo en el campo.";
  }
  renderOverlay();
}

async function refreshGithubStatusFromRecommendedAction() {
  const flow = getSetupFlowState(overlayState.context || buildPayload());
  if (!flow.repoReady) {
    overlayState.statusMessage = "Primero confirma el repositorio que vamos a preparar.";
    renderOverlay();
    return;
  }
  if (!flow.configured) {
    overlayState.statusMessage = "El backend aun no tiene GitHub App configurada.";
    renderOverlay();
    return;
  }

  overlayState.githubAppBusy = true;
  overlayState.statusMessage = "Verificando conexion y permisos de GitHub...";
  renderOverlay();

  try {
    await refreshGithubIntegrationStatus();
    const afterRefresh = getSetupFlowState(overlayState.context || buildPayload());
    if (!afterRefresh.appConnected && afterRefresh.configured && afterRefresh.repoReady) {
      const linked = await autoLinkGithubInstallation(afterRefresh.repoFullName);
      if (linked) {
        await refreshGithubIntegrationStatus();
      }
    }

    if (!hasBootstrapDetectedInTour()) {
      hydrateBootstrapSignalsFromCodespaceExplorer();
    }

    const finalFlow = getSetupFlowState(overlayState.context || buildPayload());
    if (hasCompletedSetup() || finalFlow.prCreated) {
      await markSetupCompleted();
      overlayState.statusMessage = "Entorno verificado. Entrando al dashboard principal.";
      await refreshMentorSession();
      return;
    }

    if (finalFlow.accessVerified) {
      overlayState.setupWizardStep = 3;
      overlayState.statusMessage = finalFlow.userHasCodespaceScope
        ? "GitHub conectado. Ya puedes preparar el entorno ADACEEN."
        : "GitHub App lista. Falta conectar tu cuenta GitHub para crear el Codespace.";
    } else if (finalFlow.appConnected) {
      overlayState.setupWizardStep = 2;
      overlayState.statusMessage = "GitHub conectado, pero falta acceso al repositorio confirmado.";
    } else {
      overlayState.setupWizardStep = 2;
      overlayState.statusMessage = "No se detecto una instalacion vinculada para este repositorio.";
    }
  } catch (error) {
    overlayState.statusMessage = `No se pudo actualizar GitHub: ${String(error)}`;
  } finally {
    overlayState.githubAppBusy = false;
    renderOverlay();
  }
}

function openCampusCalendarDraft(options = {}) {
  const context = overlayState.context || buildPayload();
  const deadline = toText(context.activityDeadline);
  const analysis = options?.analysis || overlayState.campusAnalysis;

  window.open(buildCampusCalendarDraftUrl(context, analysis), "_blank", "noopener,noreferrer");
  if (!options?.preserveStatus) {
    const taskCount = Number(analysis?.stats?.taskCount) || 0;
    overlayState.statusMessage = taskCount
      ? `Se abrio un borrador en Google Calendar con ${taskCount} tarea(s) detectada(s).`
      : deadline
        ? "Se abrio un borrador en Google Calendar con la fecha detectada en detalles."
        : "Se abrio un borrador en Google Calendar; revisa la fecha antes de guardarlo.";
  }
  renderOverlay();
}

async function openCodespacesPage() {
  const repoFullName = getCurrentRepoFullName();
  if (!repoFullName) {
    overlayState.statusMessage = "No se detecta repositorio para abrir Codespaces.";
    renderOverlay();
    return;
  }
  const pull = getLatestSetupPullResult();
  const storedCodespaceUrl = toText(pull?.codespaceUrl)
    || toText(overlayState.githubAppStatus?.bootstrapCodespaceUrl);
  if (storedCodespaceUrl && !isCodespaceQuickstartUrl(storedCodespaceUrl)) {
    window.open(storedCodespaceUrl, "_blank", "noopener,noreferrer");
    overlayState.statusMessage = "Abriendo Codespace existente de la PR de preparacion ADACEEN.";
    renderOverlay();
    return;
  }

  const flow = getSetupFlowState(overlayState.context || buildPayload());
  if (flow.accessVerified && flow.userHasCodespaceScope) {
    overlayState.statusMessage = "Preparando o reanudando el Codespace de la PR...";
    renderOverlay();
    await bootstrapDevcontainerWithGithubApp();
    return;
  }

  const codespaceUrl = storedCodespaceUrl
    || buildCodespaceQuickstartUrl(
      repoFullName,
      Number(overlayState.githubAppStatus?.bootstrapPullNumber || pull?.pullNumber) || 0,
      toText(overlayState.githubAppStatus?.bootstrapBranchName || pull?.branchName),
    );

  window.open(codespaceUrl, "_blank", "noopener,noreferrer");
  overlayState.statusMessage = pull?.pullNumber || overlayState.githubAppStatus?.bootstrapPullNumber
    ? "Abriendo Codespaces para la PR de preparacion ADACEEN."
    : `Abriendo Codespaces para ${repoFullName}.`;
  renderOverlay();
}

function openCodespacesManualPage() {
  const repoFullName = getCurrentRepoFullName();
  if (!repoFullName) {
    overlayState.statusMessage = "No se detecta repositorio para abrir Codespaces.";
    renderOverlay();
    return;
  }

  const pull = getLatestSetupPullResult();
  const storedCodespaceUrl = toText(pull?.codespaceUrl)
    || toText(overlayState.githubAppStatus?.bootstrapCodespaceUrl);
  const targetUrl = storedCodespaceUrl
    || buildCodespaceQuickstartUrl(
      repoFullName,
      Number(overlayState.githubAppStatus?.bootstrapPullNumber || pull?.pullNumber) || 0,
      toText(overlayState.githubAppStatus?.bootstrapBranchName || pull?.branchName),
    );

  window.open(targetUrl, "_blank", "noopener,noreferrer");
  overlayState.statusMessage = "Abriendo Codespaces manualmente sin volver a preparar el entorno.";
  renderOverlay();
}

async function reloadAdminUsersFromRecommendedAction() {
  if (!canManageUsersSession()) return;
  overlayState.adminUsersBusy = true;
  overlayState.adminUsersMessage = "Actualizando usuarios...";
  renderOverlay();
  try {
    await reloadAdminUsers();
    overlayState.adminUsersMessage = "Usuarios actualizados.";
  } catch (error) {
    overlayState.adminUsersMessage = `No se pudieron cargar usuarios: ${String(error)}`;
  } finally {
    overlayState.adminUsersBusy = false;
    renderOverlay();
  }
}

async function runRecommendedContextAction(action) {
  const normalized = toText(action);
  if (!normalized) return;

  switch (normalized) {
    case "detect_repo":
      await detectRepoFromActivePage();
      break;
    case "go_step_1":
      overlayState.setupWizardStep = 1;
      overlayState.statusMessage = "";
      renderOverlay();
      break;
    case "go_step_2":
      overlayState.setupWizardStep = 2;
      overlayState.statusMessage = "";
      renderOverlay();
      break;
    case "connect_github":
      overlayState.setupWizardStep = 2;
      await startGithubAppInstallFlow();
      break;
    case "connect_github_user":
      overlayState.setupWizardStep = 3;
      await startGithubUserOAuthFlow();
      break;
    case "refresh_github_status":
      await refreshGithubStatusFromRecommendedAction();
      break;
    case "create_bootstrap_pr":
      overlayState.setupWizardStep = 3;
      await bootstrapDevcontainerWithGithubApp();
      break;
    case "finish_setup":
      await refreshMentorSession();
      break;
    case "analyze_project":
      await analyzeCurrentContext();
      break;
    case "verify_campus_course_access":
      await verifyCampusCourseAccess();
      break;
    case "open_teacher_rag":
      await openTeacherRagPage();
      break;
    case "choose_student_course":
      if (overlayState.session?.user?.role === "student") {
        await ensureStudentCourseSelection({ forceOpen: true });
      }
      break;
    case "sync_campus_calendar":
      await syncCampusCalendarToGoogle();
      break;
    case "open_campus_date_source":
      await openCampusDateSourceFromCurrentAnalysis();
      break;
    case "upload_teacher_bitacora":
      await openTeacherBitacoraPage();
      break;
    case "refresh_mentor":
      await refreshMentorSession();
      break;
    case "rerun_ocr":
      await rerunScreenshotOcrFromDashboard();
      break;
    case "open_calendar_draft":
      openCampusCalendarDraft();
      break;
    case "open_setup_pr": {
      const pull = getLatestSetupPullResult();
      const pullUrl = toText(pull?.pullUrl) || toText(overlayState.githubAppStatus?.bootstrapPullUrl);
      const pullNumber = Number(pull?.pullNumber || overlayState.githubAppStatus?.bootstrapPullNumber) || 0;
      if (pullUrl) {
        window.open(pullUrl, "_blank", "noopener,noreferrer");
        overlayState.statusMessage = `Abriendo PR #${pullNumber || "?"}.`;
      } else {
        overlayState.statusMessage = "No hay PR reciente guardado para esta sesion.";
      }
      renderOverlay();
      break;
    }
    case "open_codespaces":
      await openCodespacesPage();
      break;
    case "open_codespaces_manual":
      openCodespacesManualPage();
      break;
    case "open_settings":
      setSettingsOpen(true);
      renderOverlay();
      break;
    case "reload_admin_users":
      await reloadAdminUsersFromRecommendedAction();
      break;
    default:
      overlayState.statusMessage = "Accion no disponible para el contexto actual.";
      renderOverlay();
      break;
  }
}

async function ensureOverlay() {
  await loadPreferences();

  if (overlayHost?.isConnected && overlayRoot) return;
  if (overlayHost && !overlayHost.isConnected) {
    overlayHost = null;
    overlayRoot = null;
    overlayEls = null;
  }

  const existingHost = document.getElementById(OVERLAY_HOST_ID);
  if (existingHost && existingHost !== overlayHost) {
    existingHost.remove();
  }

  overlayHost = document.createElement("div");
  overlayHost.id = OVERLAY_HOST_ID;
  overlayRoot = overlayHost.attachShadow({ mode: "open" });
  overlayRoot.innerHTML = buildOverlayMarkup();

  overlayEls = {
    shell: overlayRoot.getElementById("shell"),
    window: overlayRoot.getElementById("window"),
    dragHandle: overlayRoot.getElementById("dragHandle"),
    headerUserTitle: overlayRoot.getElementById("headerUserTitle"),
    headerUserSubtitle: overlayRoot.getElementById("headerUserSubtitle"),
    settingsBtn: overlayRoot.getElementById("settingsBtn"),
    logoutHeaderBtn: overlayRoot.getElementById("logoutHeaderBtn"),
    closeBtn: overlayRoot.getElementById("closeBtn"),
    settingsCloseBtn: overlayRoot.getElementById("settingsCloseBtn"),
    welcomeView: overlayRoot.getElementById("welcomeView"),
    authView: overlayRoot.getElementById("authView"),
    setupView: overlayRoot.getElementById("setupView"),
    mainView: overlayRoot.getElementById("mainView"),
    firstLoginModal: overlayRoot.getElementById("firstLoginModal"),
    firstLoginCopy: overlayRoot.getElementById("firstLoginCopy"),
    firstLoginConfirmBtn: overlayRoot.getElementById("firstLoginConfirmBtn"),
    firstLoginLogoutBtn: overlayRoot.getElementById("firstLoginLogoutBtn"),
    studentCourseModal: overlayRoot.getElementById("studentCourseModal"),
    studentCourseCopy: overlayRoot.getElementById("studentCourseCopy"),
    studentCourseOptions: overlayRoot.getElementById("studentCourseOptions"),
    studentCourseStatus: overlayRoot.getElementById("studentCourseStatus"),
    studentCourseConfirmBtn: overlayRoot.getElementById("studentCourseConfirmBtn"),
    studentCourseLogoutBtn: overlayRoot.getElementById("studentCourseLogoutBtn"),
    processNoticeModal: overlayRoot.getElementById("processNoticeModal"),
    processNoticeConfirmBtn: overlayRoot.getElementById("processNoticeConfirmBtn"),
    tabConflictModal: overlayRoot.getElementById("tabConflictModal"),
    tabConflictNotice: overlayRoot.getElementById("tabConflictNotice"),
    tabConflictRefreshBtn: overlayRoot.getElementById("tabConflictRefreshBtn"),
    welcomeContext: overlayRoot.getElementById("welcomeContext"),
    welcomeCopy: overlayRoot.getElementById("welcomeCopy"),
    startBtn: overlayRoot.getElementById("startBtn"),
    authEmail: overlayRoot.getElementById("authEmail"),
    authPassword: overlayRoot.getElementById("authPassword"),
    googleAuthBtn: overlayRoot.getElementById("googleAuthBtn"),
    authSubmitBtn: overlayRoot.getElementById("authSubmitBtn"),
    authBackBtn: overlayRoot.getElementById("authBackBtn"),
    authError: overlayRoot.getElementById("authError"),
    setupStepOneCard: overlayRoot.getElementById("setupStepOneCard"),
    setupStepTwoCard: overlayRoot.getElementById("setupStepTwoCard"),
    setupStepThreeCard: overlayRoot.getElementById("setupStepThreeCard"),
    setupContextHub: overlayRoot.getElementById("setupContextHub"),
    setupContextEyebrow: overlayRoot.getElementById("setupContextEyebrow"),
    setupContextTitle: overlayRoot.getElementById("setupContextTitle"),
    setupContextMeta: overlayRoot.getElementById("setupContextMeta"),
    setupContextStateChip: overlayRoot.getElementById("setupContextStateChip"),
    setupConnectionGrid: overlayRoot.getElementById("setupConnectionGrid"),
    setupOperationBanner: overlayRoot.getElementById("setupOperationBanner"),
    setupOperationTitle: overlayRoot.getElementById("setupOperationTitle"),
    setupOperationDetail: overlayRoot.getElementById("setupOperationDetail"),
    setupActionTitle: overlayRoot.getElementById("setupActionTitle"),
    setupActionCopy: overlayRoot.getElementById("setupActionCopy"),
    setupPrimaryActionBtn: overlayRoot.getElementById("setupPrimaryActionBtn"),
    setupSecondaryActionBtn: overlayRoot.getElementById("setupSecondaryActionBtn"),
    setupRepoInput: overlayRoot.getElementById("setupRepoInput"),
    setupExploreBtn: overlayRoot.getElementById("setupExploreBtn"),
    setupDetectRepoBtn: overlayRoot.getElementById("setupDetectRepoBtn"),
    setupToStep2Btn: overlayRoot.getElementById("setupToStep2Btn"),
    setupInstallAppBtn: overlayRoot.getElementById("setupInstallAppBtn"),
    setupRefreshAppBtn: overlayRoot.getElementById("setupRefreshAppBtn"),
    setupBackToStep1Btn: overlayRoot.getElementById("setupBackToStep1Btn"),
    setupToStep3Btn: overlayRoot.getElementById("setupToStep3Btn"),
    setupCreatePrBtn: overlayRoot.getElementById("setupCreatePrBtn"),
    setupStatusText: overlayRoot.getElementById("setupStatusText"),
    setupBackToStep2Btn: overlayRoot.getElementById("setupBackToStep2Btn"),
    setupContinueBtn: overlayRoot.getElementById("setupContinueBtn"),
    setupLogoutBtn: overlayRoot.getElementById("setupLogoutBtn"),
    mainContext: overlayRoot.getElementById("mainContext"),
    roleBadge: overlayRoot.getElementById("roleBadge"),
    refreshBtn: overlayRoot.getElementById("refreshBtn"),
    contextHubSection: overlayRoot.getElementById("contextHubSection"),
    contextEyebrow: overlayRoot.getElementById("contextEyebrow"),
    contextTitle: overlayRoot.getElementById("contextTitle"),
    contextMeta: overlayRoot.getElementById("contextMeta"),
    contextStateChip: overlayRoot.getElementById("contextStateChip"),
    connectionGrid: overlayRoot.getElementById("connectionGrid"),
    contextOperationBanner: overlayRoot.getElementById("contextOperationBanner"),
    contextOperationTitle: overlayRoot.getElementById("contextOperationTitle"),
    contextOperationDetail: overlayRoot.getElementById("contextOperationDetail"),
    contextActionTitle: overlayRoot.getElementById("contextActionTitle"),
    contextActionCopy: overlayRoot.getElementById("contextActionCopy"),
    contextPrimaryActionBtn: overlayRoot.getElementById("contextPrimaryActionBtn"),
    contextSecondaryActionBtn: overlayRoot.getElementById("contextSecondaryActionBtn"),
    teacherBitacoraUploadBtn: overlayRoot.getElementById("teacherBitacoraUploadBtn"),
    teacherBitacoraFileInput: overlayRoot.getElementById("teacherBitacoraFileInput"),
    teacherRagManageBtn: overlayRoot.getElementById("teacherRagManageBtn"),
    teacherRagFileInput: overlayRoot.getElementById("teacherRagFileInput"),
    teacherBitacoraPage: overlayRoot.getElementById("teacherBitacoraPage"),
    teacherBitacoraCloseBtn: overlayRoot.getElementById("teacherBitacoraCloseBtn"),
    teacherBitacoraStatusText: overlayRoot.getElementById("teacherBitacoraStatusText"),
    teacherBitacoraLatestText: overlayRoot.getElementById("teacherBitacoraLatestText"),
    teacherBitacoraAgendaList: overlayRoot.getElementById("teacherBitacoraAgendaList"),
    teacherBitacoraDownloadTemplateBtn: overlayRoot.getElementById("teacherBitacoraDownloadTemplateBtn"),
    teacherBitacoraChooseFileBtn: overlayRoot.getElementById("teacherBitacoraChooseFileBtn"),
    teacherBitacoraDeleteLatestBtn: overlayRoot.getElementById("teacherBitacoraDeleteLatestBtn"),
    teacherBitacoraClearDataBtn: overlayRoot.getElementById("teacherBitacoraClearDataBtn"),
    teacherBitacoraPageStatus: overlayRoot.getElementById("teacherBitacoraPageStatus"),
    teacherRagPage: overlayRoot.getElementById("teacherRagPage"),
    teacherRagCloseBtn: overlayRoot.getElementById("teacherRagCloseBtn"),
    teacherRagStatusText: overlayRoot.getElementById("teacherRagStatusText"),
    teacherRagCourseSelect: overlayRoot.getElementById("teacherRagCourseSelect"),
    teacherRagCourseCode: overlayRoot.getElementById("teacherRagCourseCode"),
    teacherRagCourseName: overlayRoot.getElementById("teacherRagCourseName"),
    teacherRagCourseSummary: overlayRoot.getElementById("teacherRagCourseSummary"),
    teacherRagUploadBtn: overlayRoot.getElementById("teacherRagUploadBtn"),
    teacherRagRefreshBtn: overlayRoot.getElementById("teacherRagRefreshBtn"),
    teacherRagSourceList: overlayRoot.getElementById("teacherRagSourceList"),
    teacherRagPageStatus: overlayRoot.getElementById("teacherRagPageStatus"),
    analyzeProjectBtn: overlayRoot.getElementById("analyzeProjectBtn"),
    rerunOcrBtn: overlayRoot.getElementById("rerunOcrBtn"),
    detailTitle: overlayRoot.getElementById("detailTitle"),
    detailMeta: overlayRoot.getElementById("detailMeta"),
    signalText: overlayRoot.getElementById("signalText"),
    policyLead: overlayRoot.getElementById("policyLead"),
    sessionBadge: overlayRoot.getElementById("sessionBadge"),
    policySectionTitle: overlayRoot.getElementById("policySectionTitle"),
    teacherSummary: overlayRoot.getElementById("teacherSummary"),
    githubAppSection: overlayRoot.getElementById("githubAppSection"),
    githubAppStatusText: overlayRoot.getElementById("githubAppStatusText"),
    githubAppInstallBtn: overlayRoot.getElementById("githubAppInstallBtn"),
    githubAppRefreshBtn: overlayRoot.getElementById("githubAppRefreshBtn"),
    githubAppBootstrapBtn: overlayRoot.getElementById("githubAppBootstrapBtn"),
    projectContextStatusSection: overlayRoot.getElementById("projectContextStatusSection"),
    projectContextStatusText: overlayRoot.getElementById("projectContextStatusText"),
    projectContextReadyValue: overlayRoot.getElementById("projectContextReadyValue"),
    projectContextVersionValue: overlayRoot.getElementById("projectContextVersionValue"),
    projectContextRequestValue: overlayRoot.getElementById("projectContextRequestValue"),
    projectContextSnapshotValue: overlayRoot.getElementById("projectContextSnapshotValue"),
    projectContextUpdatedValue: overlayRoot.getElementById("projectContextUpdatedValue"),
    projectContextSourceValue: overlayRoot.getElementById("projectContextSourceValue"),
    projectContextRefreshBtn: overlayRoot.getElementById("projectContextRefreshBtn"),
    projectContextHistorySection: overlayRoot.getElementById("projectContextHistorySection"),
    projectContextHistoryText: overlayRoot.getElementById("projectContextHistoryText"),
    projectContextHistoryList: overlayRoot.getElementById("projectContextHistoryList"),
    projectContextHistoryRefreshBtn: overlayRoot.getElementById("projectContextHistoryRefreshBtn"),
    adminUsersSection: overlayRoot.getElementById("adminUsersSection"),
    adminUsersStatus: overlayRoot.getElementById("adminUsersStatus"),
    adminReloadUsersBtn: overlayRoot.getElementById("adminReloadUsersBtn"),
    adminCreateRole: overlayRoot.getElementById("adminCreateRole"),
    adminCreateName: overlayRoot.getElementById("adminCreateName"),
    adminCreateEmail: overlayRoot.getElementById("adminCreateEmail"),
    adminCreatePassword: overlayRoot.getElementById("adminCreatePassword"),
    adminCreateTeacher: overlayRoot.getElementById("adminCreateTeacher"),
    adminCreateCourseGrid: overlayRoot.getElementById("adminCreateCourseGrid"),
    adminCreateBtn: overlayRoot.getElementById("adminCreateBtn"),
    adminUsersTableBody: overlayRoot.getElementById("adminUsersTableBody"),
    studentGoalSection: overlayRoot.getElementById("studentGoalSection"),
    studentIdeasSection: overlayRoot.getElementById("studentIdeasSection"),
    nextStepSection: overlayRoot.getElementById("nextStepSection"),
    goalGrid: overlayRoot.getElementById("goalGrid"),
    ideaList: overlayRoot.getElementById("ideaList"),
    guideList: overlayRoot.getElementById("guideList"),
    teacherPolicySection: overlayRoot.getElementById("teacherPolicySection"),
    teacherPolicyList: overlayRoot.getElementById("teacherPolicyList"),
    teacherTelemetrySection: overlayRoot.getElementById("teacherTelemetrySection"),
    telemetryList: overlayRoot.getElementById("telemetryList"),
    reloadTelemetryBtn: overlayRoot.getElementById("reloadTelemetryBtn"),
    previewSection: overlayRoot.getElementById("previewSection"),
    previewText: overlayRoot.getElementById("previewText"),
    statusText: overlayRoot.getElementById("statusText"),
    settingsSessionLabel: overlayRoot.getElementById("settingsSessionLabel"),
    settingsSessionMeta: overlayRoot.getElementById("settingsSessionMeta"),
    teacherEnabled: overlayRoot.getElementById("teacherEnabled"),
    autoConfigEnabled: overlayRoot.getElementById("autoConfigEnabled"),
    teacherSettingsBlock: overlayRoot.getElementById("teacherSettingsBlock"),
    teacherPolicyName: overlayRoot.getElementById("teacherPolicyName"),
    teacherOutcome: overlayRoot.getElementById("teacherOutcome"),
    teacherTone: overlayRoot.getElementById("teacherTone"),
    teacherFrequency: overlayRoot.getElementById("teacherFrequency"),
    teacherHelpLevel: overlayRoot.getElementById("teacherHelpLevel"),
    teacherMiniQuiz: overlayRoot.getElementById("teacherMiniQuiz"),
    teacherNoSolution: overlayRoot.getElementById("teacherNoSolution"),
    teacherMaxHints: overlayRoot.getElementById("teacherMaxHints"),
    teacherAllowExplanation: overlayRoot.getElementById("teacherAllowExplanation"),
    teacherAllowHint: overlayRoot.getElementById("teacherAllowHint"),
    teacherAllowExample: overlayRoot.getElementById("teacherAllowExample"),
    teacherAllowMiniQuizType: overlayRoot.getElementById("teacherAllowMiniQuizType"),
    teacherFallbackMessage: overlayRoot.getElementById("teacherFallbackMessage"),
    teacherCustomInstruction: overlayRoot.getElementById("teacherCustomInstruction"),
    backendUrlInput: overlayRoot.getElementById("backendUrlInput"),
    advancedGithubBlock: overlayRoot.getElementById("advancedGithubBlock"),
    advancedGithubNote: overlayRoot.getElementById("advancedGithubNote"),
    logoutSettingsBtn: overlayRoot.getElementById("logoutSettingsBtn"),
    saveSettingsBtn: overlayRoot.getElementById("saveSettingsBtn"),
    analysisWindow: overlayRoot.getElementById("analysisWindow"),
    analysisCloseBtn: overlayRoot.getElementById("analysisCloseBtn"),
    analysisTitle: overlayRoot.getElementById("analysisTitle"),
    analysisStats: overlayRoot.getElementById("analysisStats"),
    analysisFileList: overlayRoot.getElementById("analysisFileList"),
  };

  overlayEls.closeBtn.addEventListener("click", async () => {
    await closeOverlay();
  });
  overlayEls.settingsBtn.addEventListener("click", () => {
    setSettingsOpen(!overlayState.settingsOpen);
  });
  overlayEls.settingsCloseBtn.addEventListener("click", () => {
    setSettingsOpen(false);
  });
  overlayEls.startBtn.addEventListener("click", async () => {
    await startExperience();
  });
  overlayEls.authSubmitBtn.addEventListener("click", async () => {
    await submitLoginFromOverlay();
  });
  overlayEls.googleAuthBtn.addEventListener("click", async () => {
    await submitGoogleLoginFromOverlay();
  });
  overlayEls.authBackBtn.addEventListener("click", () => {
    overlayState.started = false;
    overlayState.authError = "";
    renderOverlay();
  });
  overlayEls.setupPrimaryActionBtn.addEventListener("click", async () => {
    await runRecommendedContextAction(overlayEls.setupPrimaryActionBtn.dataset.contextAction);
  });
  overlayEls.setupSecondaryActionBtn.addEventListener("click", async () => {
    await runRecommendedContextAction(overlayEls.setupSecondaryActionBtn.dataset.contextAction);
  });
  overlayEls.contextPrimaryActionBtn.addEventListener("click", async () => {
    await runRecommendedContextAction(overlayEls.contextPrimaryActionBtn.dataset.contextAction);
  });
  overlayEls.contextSecondaryActionBtn.addEventListener("click", async () => {
    await runRecommendedContextAction(overlayEls.contextSecondaryActionBtn.dataset.contextAction);
  });
  overlayEls.firstLoginConfirmBtn.addEventListener("click", async () => {
    await markPrivacyAcceptedForCurrentSession();
    renderOverlay();
  });
  overlayEls.firstLoginLogoutBtn.addEventListener("click", async () => {
    await logoutAndReturnToLogin();
  });
  overlayEls.studentCourseConfirmBtn?.addEventListener("click", async () => {
    await confirmStudentCourseSelection();
  });
  overlayEls.studentCourseLogoutBtn?.addEventListener("click", async () => {
    if (overlayEls.studentCourseLogoutBtn.dataset.courseModalAction === "cancel") {
      overlayState.studentCourseModalOpen = false;
      renderOverlay();
      return;
    }
    await logoutAndReturnToLogin();
  });
  overlayEls.processNoticeConfirmBtn.addEventListener("click", () => {
    overlayState.processNoticeOpen = false;
    renderOverlay();
  });
  overlayEls.tabConflictRefreshBtn?.addEventListener("click", async () => {
    if (!overlayEls.tabConflictRefreshBtn) return;
    overlayState.loading = true;
    renderOverlay();
    await refreshActiveTabStateFromBackend({ force: true }).catch(() => {});
    overlayState.loading = false;
    renderOverlay();
  });
  overlayEls.setupRepoInput.addEventListener("input", () => {
    setSetupRepoFullName(overlayEls.setupRepoInput.value);
    overlayState.setupWizardStep = 1;
    clearSetupForCurrentUser();
    persistPreferences().catch(() => {});
    renderOverlay();
  });
  overlayEls.setupExploreBtn.addEventListener("click", async () => {
    await analyzeCodespaceProject();
  });
  overlayEls.setupDetectRepoBtn.addEventListener("click", async () => {
    overlayState.context = buildPayload();
    const detected = inferRepoFromContext(overlayState.context);
    if (detected) {
      setSetupRepoFullName(detected);
      overlayState.setupWizardStep = 1;
      clearSetupForCurrentUser();
      persistPreferences().catch(() => {});
      overlayState.statusMessage = `Repositorio detectado: ${detected}`;
    } else {
      overlayState.statusMessage = "No se pudo detectar owner/repo automaticamente. Pegalo en el campo.";
    }
    try {
      await refreshGithubIntegrationStatus();
    } catch {}
    renderOverlay();
  });
  overlayEls.setupToStep2Btn.addEventListener("click", () => {
    const flow = getSetupFlowState(overlayState.context || buildPayload());
    if (!flow.repoReady) {
      overlayState.statusMessage = "Confirma el repositorio que vamos a preparar antes de autorizar la GitHub App.";
      renderOverlay();
      return;
    }
    overlayState.setupWizardStep = 2;
    overlayState.statusMessage = "";
    renderOverlay();
  });
  overlayEls.setupInstallAppBtn.addEventListener("click", async () => {
    const flow = getSetupFlowState(overlayState.context || buildPayload());
    if (!flow.repoReady) {
      overlayState.statusMessage = "Primero confirma el repositorio que vamos a preparar.";
      renderOverlay();
      return;
    }
    if (!flow.configured) {
      overlayState.statusMessage = "El backend aun no tiene GitHub App configurada.";
      renderOverlay();
      return;
    }
    await startGithubAppInstallFlow();
  });
  overlayEls.setupRefreshAppBtn.addEventListener("click", async () => {
    const flow = getSetupFlowState(overlayState.context || buildPayload());
    if (!flow.repoReady) {
      overlayState.statusMessage = "Primero confirma el repositorio que vamos a preparar.";
      renderOverlay();
      return;
    }
    if (!flow.configured) {
      overlayState.statusMessage = "El backend aun no tiene GitHub App configurada.";
      renderOverlay();
      return;
    }
    overlayState.githubAppBusy = true;
    overlayState.statusMessage = "Verificando que la GitHub App tenga acceso al repositorio confirmado...";
    renderOverlay();
    try {
      await refreshGithubIntegrationStatus();
      const afterRefresh = getSetupFlowState(overlayState.context || buildPayload());
      if (!afterRefresh.appConnected && afterRefresh.configured && afterRefresh.repoReady) {
        const linked = await autoLinkGithubInstallation(afterRefresh.repoFullName);
        if (linked) {
          await refreshGithubIntegrationStatus();
        }
      }

      if (!hasBootstrapDetectedInTour()) {
        hydrateBootstrapSignalsFromCodespaceExplorer();
      }

      const finalFlow = getSetupFlowState(overlayState.context || buildPayload());
      if (hasCompletedSetup() || finalFlow.prCreated) {
        await markSetupCompleted();
        overlayState.statusMessage = "Acceso verificado. Este repo ya tenia configuracion ADACEEN aplicada; entrando al dashboard.";
        await refreshMentorSession();
        return;
      } else if (finalFlow.accessVerified) {
        overlayState.statusMessage = finalFlow.userHasCodespaceScope
          ? "Acceso verificado. Ya puedes preparar PR y Codespace."
          : "Acceso verificado. Conecta tu cuenta GitHub para crear el Codespace.";
      } else if (finalFlow.appConnected) {
        overlayState.statusMessage = "App conectada, pero falta acceso al repositorio confirmado.";
      } else {
        overlayState.statusMessage = "No se detecto una instalacion vinculada para este repositorio.";
      }
    } catch (error) {
      overlayState.statusMessage = `No se pudo actualizar estado GitHub App: ${String(error)}`;
    } finally {
      overlayState.githubAppBusy = false;
      renderOverlay();
    }
  });
  overlayEls.setupBackToStep1Btn.addEventListener("click", () => {
    overlayState.setupWizardStep = 1;
    overlayState.statusMessage = "";
    renderOverlay();
  });
  overlayEls.setupToStep3Btn.addEventListener("click", () => {
    const flow = getSetupFlowState(overlayState.context || buildPayload());
    if (!BYPASS_GITHUB_APP_INSTALL_VALIDATION) {
      if (!flow.appConnected) {
        overlayState.statusMessage = "Primero autoriza la GitHub App para este repositorio.";
        renderOverlay();
        return;
      }
      if (!flow.accessVerified) {
        overlayState.statusMessage = "Primero verifica que la app tenga acceso al repositorio.";
        renderOverlay();
        return;
      }
      // Temporalmente deshabilitado para pruebas de PR:
      // if (!flow.appConnected || !flow.accessVerified) return;
    }
    overlayState.setupWizardStep = 3;
    overlayState.statusMessage = "";
    renderOverlay();
  });
  overlayEls.setupCreatePrBtn.addEventListener("click", async () => {
    const flow = getSetupFlowState(overlayState.context || buildPayload());
    if (!flow.repoReady) {
      overlayState.statusMessage = "Primero confirma el repositorio que vamos a preparar.";
      renderOverlay();
      return;
    }
    if (!BYPASS_GITHUB_APP_INSTALL_VALIDATION) {
      if (!flow.appConnected) {
        overlayState.statusMessage = "Primero autoriza la GitHub App en el Paso 2/3.";
        renderOverlay();
        return;
      }
      if (!flow.accessVerified) {
        overlayState.statusMessage = "Primero verifica el acceso de la GitHub App.";
        renderOverlay();
        return;
      }
      // Temporalmente deshabilitado para pruebas de PR:
      // if (!flow.appConnected || !flow.accessVerified) return;
    }
    if (!flow.userOAuthConfigured || !flow.userConnected || !flow.userHasCodespaceScope) {
      overlayState.statusMessage = "Primero conecta tu cuenta GitHub con permiso Codespaces para automatizar el Codespace.";
      renderOverlay();
      if (flow.userOAuthConfigured) {
        await startGithubUserOAuthFlow();
      }
      return;
    }
    await bootstrapDevcontainerWithGithubApp();
  });
  overlayEls.setupBackToStep2Btn.addEventListener("click", () => {
    overlayState.setupWizardStep = 2;
    overlayState.statusMessage = "";
    renderOverlay();
  });
  overlayEls.setupContinueBtn.addEventListener("click", async () => {
    if (!hasCompletedSetup()) {
      overlayState.statusMessage = "Completa primero la preparacion: autorizar la app y crear el PR de configuracion.";
      renderOverlay();
      return;
    }
    await refreshMentorSession();
  });
  overlayEls.setupLogoutBtn.addEventListener("click", async () => {
    await logoutAndReturnToLogin();
  });
  overlayEls.refreshBtn.addEventListener("click", async () => {
    await refreshMentorSession();
  });
  overlayEls.analyzeProjectBtn.addEventListener("click", async () => {
    await analyzeCurrentContext();
  });
  overlayEls.teacherBitacoraUploadBtn?.addEventListener("click", async () => {
    await openTeacherBitacoraPage();
  });
  overlayEls.teacherRagManageBtn?.addEventListener("click", async () => {
    await openTeacherRagPage();
  });
  overlayEls.teacherBitacoraCloseBtn?.addEventListener("click", () => {
    closeTeacherBitacoraPage();
  });
  overlayEls.teacherRagCloseBtn?.addEventListener("click", () => {
    closeTeacherRagPage();
  });
  overlayEls.teacherRagCourseSelect?.addEventListener("change", async () => {
    await selectTeacherRagCourse(overlayEls.teacherRagCourseSelect.value);
  });
  overlayEls.teacherRagUploadBtn?.addEventListener("click", () => {
    openTeacherRagFilePicker();
  });
  overlayEls.teacherRagRefreshBtn?.addEventListener("click", async () => {
    await refreshTeacherRagSources();
  });
  overlayEls.teacherRagSourceList?.addEventListener("click", async (event) => {
    const button = event.target?.closest?.("[data-rag-delete-id]");
    if (!button) return;
    await deleteTeacherRagSource(button.getAttribute("data-rag-delete-id"));
  });
  overlayEls.teacherBitacoraDownloadTemplateBtn?.addEventListener("click", async () => {
    await downloadTeacherBitacoraTemplate();
  });
  overlayEls.teacherBitacoraChooseFileBtn?.addEventListener("click", () => {
    openTeacherBitacoraFilePicker();
  });
  overlayEls.teacherBitacoraDeleteLatestBtn?.addEventListener("click", async () => {
    await deleteTeacherBitacoraLatest();
  });
  overlayEls.teacherBitacoraClearDataBtn?.addEventListener("click", async () => {
    await clearTeacherBitacoraData();
  });
  overlayEls.teacherBitacoraFileInput?.addEventListener("change", async () => {
    const file = overlayEls.teacherBitacoraFileInput.files?.[0] || null;
    overlayEls.teacherBitacoraFileInput.value = "";
    await uploadTeacherBitacoraFile(file);
  });
  overlayEls.teacherRagFileInput?.addEventListener("change", async () => {
    const file = overlayEls.teacherRagFileInput.files?.[0] || null;
    overlayEls.teacherRagFileInput.value = "";
    await uploadTeacherRagFile(file);
  });
  overlayEls.rerunOcrBtn.addEventListener("click", async () => {
    overlayState.context = buildPayload();
    if (overlayState.context.pageContext === "campus") {
      await syncCampusCalendarToGoogle();
      return;
    }
    await rerunScreenshotOcrFromDashboard();
  });
  overlayEls.githubAppInstallBtn.addEventListener("click", async () => {
    await startGithubAppInstallFlow();
  });
  overlayEls.githubAppRefreshBtn.addEventListener("click", async () => {
    overlayState.githubAppBusy = true;
    renderOverlay();
    try {
      await refreshGithubIntegrationStatus();
      overlayState.statusMessage = "Estado de GitHub App y OAuth actualizado.";
    } catch (error) {
      overlayState.statusMessage = `No se pudo actualizar estado GitHub: ${String(error)}`;
    } finally {
      overlayState.githubAppBusy = false;
      renderOverlay();
    }
  });
  overlayEls.githubAppBootstrapBtn.addEventListener("click", async () => {
    await bootstrapDevcontainerWithGithubApp({ force: true });
  });
  overlayEls.projectContextRefreshBtn.addEventListener("click", async () => {
    await refreshProjectContextPanel();
  });
  overlayEls.projectContextHistoryRefreshBtn.addEventListener("click", async () => {
    await refreshProjectContextPanel();
  });
  overlayEls.adminCreateRole.addEventListener("change", () => {
    renderAdminUsersTable();
  });
  overlayEls.adminReloadUsersBtn.addEventListener("click", async () => {
    if (!canManageUsersSession()) return;
    overlayState.adminUsersBusy = true;
    overlayState.adminUsersMessage = "Actualizando usuarios...";
    renderOverlay();
    try {
      await reloadAdminUsers();
      overlayState.adminUsersMessage = "Usuarios actualizados.";
    } catch (error) {
      overlayState.adminUsersMessage = `No se pudieron cargar usuarios: ${String(error)}`;
    } finally {
      overlayState.adminUsersBusy = false;
      renderOverlay();
    }
  });
  overlayEls.adminCreateBtn.addEventListener("click", async () => {
    if (!canManageUsersSession()) return;
    overlayState.adminUsersBusy = true;
    overlayState.adminUsersMessage = "Creando usuario...";
    renderOverlay();
    try {
      await createAdminUserFromForm();
      overlayEls.adminCreateName.value = "";
      overlayEls.adminCreateEmail.value = "";
      overlayEls.adminCreatePassword.value = "";
      overlayEls.adminCreateTeacher.value = "";
      await reloadAdminUsers();
      overlayState.adminUsersMessage = "Usuario creado correctamente.";
    } catch (error) {
      overlayState.adminUsersMessage = `No se pudo crear usuario: ${String(error)}`;
    } finally {
      overlayState.adminUsersBusy = false;
      renderOverlay();
    }
  });
  overlayEls.analysisCloseBtn.addEventListener("click", () => {
    overlayState.analysisWindowOpen = false;
    renderOverlay();
  });
  overlayEls.logoutHeaderBtn.addEventListener("click", async () => {
    await logoutAndReturnToLogin();
  });
  overlayEls.reloadTelemetryBtn?.addEventListener("click", async () => {
    await reloadPolicyAndTelemetry();
    renderOverlay();
  });
  overlayEls.saveSettingsBtn.addEventListener("click", async () => {
    await saveSettingsFromOverlay();
  });
  overlayEls.logoutSettingsBtn.addEventListener("click", async () => {
    await logoutAndReturnToLogin();
    setSettingsOpen(false);
  });
  overlayEls.dragHandle.addEventListener("pointerdown", startDrag);

  document.documentElement.appendChild(overlayHost);
  bindOverlayViewportListeners();
  overlayState.context = buildPayload();
  overlayEls.authEmail.value = "estudiante@adaceen.edu.co";
  overlayEls.authPassword.value = "Estudiante123!";
  renderOverlay();
  scheduleOverlayViewportSync(false);
}

async function openOverlay() {
  if (overlayOpenInFlight) {
    return overlayOpenInFlight;
  }

  overlayOpenInFlight = (async () => {
    const alreadyOpen = !!(overlayHost?.isConnected && overlayRoot);
    if (!alreadyOpen) {
      resetOverlayStateForOpen();
    } else {
      overlayState.context = buildPayload();
    }

    await ensureOverlay();

    if (!alreadyOpen) {
      const cached = await loadTabSessionSnapshot(overlayState.context || buildPayload());
      if (cached) {
        applyTabSessionSnapshot(cached);
      }
    }

    await chrome.storage.local.set({ [STORAGE_KEY_OVERLAY_PINNED]: true });
    renderOverlay();
    queueTabSessionSave();
    scheduleOverlayViewportSync(false);
  })();

  try {
    return await overlayOpenInFlight;
  } finally {
    overlayOpenInFlight = null;
  }
}

async function closeOverlay() {
  await flushTabSessionSave();
  overlayState.started = false;
  overlayState.settingsOpen = false;
  overlayState.loading = false;
  overlayState.analysisBusy = false;
  overlayState.analysisUnlocked = false;
  overlayState.analysisWindowOpen = false;
  overlayState.projectAnalysis = null;
  overlayState.campusAnalysis = null;
  overlayState.setupRepoFullName = "";
  overlayState.setupWizardStep = 1;
  overlayState.githubAppBusy = false;
  overlayState.githubAppStatus = { ...EMPTY_GITHUB_APP_STATUS };
  overlayState.githubUserStatus = { ...EMPTY_GITHUB_USER_STATUS };
  overlayState.projectContextBusy = false;
  overlayState.projectContextStatus = { ...EMPTY_PROJECT_CONTEXT_STATUS };
  overlayState.projectContextHistory = [];
  overlayState.projectContextInsight = { ...EMPTY_PROJECT_CONTEXT_INSIGHT };
  overlayState.documentClassifications = { ...EMPTY_DOCUMENT_CLASSIFICATION_STATE };
  overlayState.teacherBitacoraPageOpen = false;
  overlayState.teacherBitacoraStatus = { ...EMPTY_TEACHER_BITACORA_STATUS };
  overlayState.teacherRagPageOpen = false;
  overlayState.teacherRagState = { ...EMPTY_TEACHER_RAG_STATE };
  overlayState.campusCourseAccess = { ...EMPTY_CAMPUS_COURSE_ACCESS_STATE };
  overlayState.ragCourseCatalog = [];
  overlayState.ragDefaultCourseCode = "FPOO";
  overlayState.studentCourseModalOpen = false;
  overlayState.studentCourseState = { ...EMPTY_STUDENT_COURSE_STATE };
  overlayState.projectContextMessage = "";
  overlayState.projectContextError = "";
  overlayState.adminUsers = [];
  overlayState.adminTeachers = [];
  overlayState.adminUsersBusy = false;
  overlayState.adminUsersMessage = "";
  overlayState.ideas = [];
  overlayState.guide = [];
  overlayState.welcome = "";
  overlayState.statusMessage = "";
  overlayState.operationTitle = "";
  overlayState.operationDetail = "";
  overlayState.operationKind = "busy";
  overlayState.processNoticeOpen = false;

  try {
    await chrome.storage.local.set({ [STORAGE_KEY_OVERLAY_PINNED]: false });
  } catch {}

  if (overlayHost?.isConnected) {
    overlayHost.remove();
  }

  overlayHost = null;
  overlayRoot = null;
  overlayEls = null;
}

async function refreshMentorSession() {
  if (!hasActiveSession()) {
    renderOverlay();
    return;
  }

  overlayState.loading = true;
  overlayState.context = buildPayload();
  overlayState.statusMessage = "Leyendo contexto actual...";
  renderOverlay();

  if (overlayState.session?.user?.role === "student" && typeof ensureStudentCourseSelection === "function") {
    await ensureStudentCourseSelection({ forceOpen: false });
  }

  const context = overlayState.context;
  const language = inferLanguage(context.filePath, context.languageHint);
  const goal = getLearningGoal(overlayState.selectedLearningGoal);
  const detectedRepo = inferRepoFromContext(context);
  const githubContext = isGithubOrCodespaceContext(context);
  if (githubContext && !overlayState.setupRepoFullName && detectedRepo) {
    setSetupRepoFullName(detectedRepo);
  }

  overlayState.welcome = buildWelcomeText(context, goal);
  overlayState.ideas = buildIdeas(context, language, goal.id);
  overlayState.guide = buildGuide(goal.id, context);
  overlayState.statusMessage = buildMainStatus(context);

  if (githubContext) {
    try {
      await refreshGithubIntegrationStatus();
    } catch {
      overlayState.githubAppStatus = { ...EMPTY_GITHUB_APP_STATUS };
      overlayState.githubUserStatus = { ...EMPTY_GITHUB_USER_STATUS };
    }
  } else {
    overlayState.githubAppStatus = { ...EMPTY_GITHUB_APP_STATUS };
    overlayState.githubUserStatus = { ...EMPTY_GITHUB_USER_STATUS };
  }

  overlayState.projectContextMessage = "";
  overlayState.projectContextError = "";

  if (githubContext) {
    try {
      await refreshProjectContextStatus();
    } catch {
      overlayState.projectContextStatus = { ...EMPTY_PROJECT_CONTEXT_STATUS };
    }

    try {
      await refreshProjectContextHistory();
    } catch {
      overlayState.projectContextHistory = [];
    }
  } else {
    overlayState.projectContextStatus = { ...EMPTY_PROJECT_CONTEXT_STATUS };
    overlayState.projectContextHistory = [];
  }

  if (githubContext && overlayState.autoConfigEnabled) {
    try {
      await refreshProjectContextInsight();
    } catch {
      overlayState.projectContextInsight = { ...EMPTY_PROJECT_CONTEXT_INSIGHT };
    }
  } else if (githubContext) {
    overlayState.projectContextInsight = {
      ...EMPTY_PROJECT_CONTEXT_INSIGHT,
      configured: true,
      repoFullName: getCurrentRepoFullName(),
      modelEnabled: false,
      summary: "Configuracion automatica desactivada.",
    };
  } else {
    overlayState.projectContextInsight = { ...EMPTY_PROJECT_CONTEXT_INSIGHT };
  }

  if (githubContext) {
    await refreshDocumentClassifications();
  } else {
    overlayState.documentClassifications = { ...EMPTY_DOCUMENT_CLASSIFICATION_STATE };
  }

  if (overlayState.assistantEnabled && context.pageContext !== "unknown" && normalizeBaseUrl(overlayState.backendUrl)) {
    try {
      const remote = await requestBackendMentor(context, language);
      if (remote.ideas.length > 0) overlayState.ideas = remote.ideas;
      if (remote.guide.length > 0) overlayState.guide = remote.guide;
      if (remote.welcome) overlayState.welcome = remote.welcome;
      if (remote.summary) overlayState.statusMessage = remote.summary;
      if (isTeacherSession()) {
        await reloadPolicyAndTelemetry();
        await reloadAdminUsers();
      } else if (isAdminSession()) {
        await reloadAdminUsers();
      }
    } catch {
      overlayState.statusMessage = `${buildMainStatus(context)} Se usa apoyo local por ahora.`;
    }
  }

  if (canManageUsersSession()) {
    try {
      await reloadAdminUsers();
    } catch {
      overlayState.adminUsers = [];
      overlayState.adminTeachers = [];
    }
  }

  overlayState.loading = false;
  renderOverlay();
}

async function restorePinnedOverlay() {
  try {
    await loadPreferences();
    const stored = await chrome.storage.local.get([STORAGE_KEY_OVERLAY_PINNED]);
    if (stored[STORAGE_KEY_OVERLAY_PINNED] === true) {
      await openOverlay();
    }
  } catch {}
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_GITHUB_CONTEXT" || message?.type === "GET_PAGE_INFO") {
    try {
      sendResponse({ ok: true, data: buildPayload() });
    } catch (error) {
      sendResponse({ ok: false, error: String(error) });
    }
    return;
  }

  if (message?.type === "ADACEEN_PING") {
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "ADACEEN_OPEN_OVERLAY") {
    openOverlay()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ADACEEN_CLOSE_OVERLAY") {
    closeOverlay()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
});

bindCrossTabSyncListeners();
restorePinnedOverlay().catch(() => {});
syncFromStorageSnapshot({ force: true }).catch(() => {});
bindActiveTabSyncListeners();
refreshActiveTabStateFromBackend({ force: true }).catch(() => {});
