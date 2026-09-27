// ADACEEN | Capa 5 - Ciclo de vida: montaje del overlay, listeners, sincronizacion entre pestanas y arranque.
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
const ACTIVE_TAB_POLL_INTERVAL_MS = 9000;
const ACTIVE_TAB_DEACTIVATE_DELAY_MS = 2500;
const ACTIVE_TAB_MIN_REPORT_MS = 900;

const ACTIVE_TAB_INSTANCE_ID_KEY = "adaceenActiveTabInstanceId";
const ACTIVE_TAB_VIEW_CONTEXT_MAX = 280;
const CODESPACE_HANDOFF_TTL_MS = 15 * 60 * 1000;
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
// Entrada automatica con un editor guardado (autoEnterWithSavedEditor): la pestana no cuenta
// como activa (POST /api/ui/active-tab -> active_tab_seen) hasta que el estudiante interactua
// con el overlay; asi entrar solo no infla el KPI "uso del agente".
let savedEditorAutoEnterIdle = false;
let overlayOpenInFlight = null;
let activeCodespaceHandoff = null;

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

function resetOverlayStateForOpen() {
  clearMentorFallbackTimer();
  savedEditorAutoEnterIdle = false;
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
  overlayState.codespaceWaitingContext = { ...EMPTY_CODESPACE_WAITING_CONTEXT };
  overlayState.campusCourseAccess = { ...EMPTY_CAMPUS_COURSE_ACCESS_STATE };
  overlayState.ragCourseCatalog = [];
  overlayState.ragDefaultCourseCode = "FPOO";
  overlayState.studentCourseModalOpen = false;
  overlayState.studentCourseState = { ...EMPTY_STUDENT_COURSE_STATE };
  overlayState.vscodeSyncState = { ...EMPTY_VSCODE_SYNC_STATE };
  overlayState.ragSources = [];
  overlayState.projectContextMessage = "";
  overlayState.projectContextError = "";
  overlayState.adminUsers = [];
  overlayState.adminTeachers = [];
  overlayState.adminCreateFormOpen = false;
  overlayState.adminUsersBusy = false;
  overlayState.adminUsersMessage = "";
  overlayState.adminEditingUserId = "";
  overlayState.teacherRagLoadedAt = 0;
  overlayState.ragCoursesOpen = {};
  overlayState.ragLots = { ...EMPTY_RAG_LOTS_STATE };
  overlayState.ragLotFormOpen = {};
  overlayState.ragUploadLotByCourse = {};
  overlayState.quizzesPanel = { ...EMPTY_QUIZZES_PANEL_STATE };
  overlayState.teacherOutcomeHelpOpen = false;
  overlayState.mainTab = "inicio";
  overlayState.mainTabChosenByUser = false;
  overlayState.studentsPanel = { ...EMPTY_STUDENTS_PANEL_STATE };
  overlayState.settingsSectionsInitialized = false;
  overlayState.ideas = [];
  overlayState.guide = [];
  overlayState.welcome = "";
  overlayState.mentorSummary = "";
  overlayState.activeRagCourseCode = "";
  overlayState.statusMessage = "";
  overlayState.operationTitle = "";
  overlayState.operationDetail = "";
  overlayState.operationKind = "busy";
  overlayState.context = buildPayload();
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
      || ((host === "vscode.dev" || host === "insiders.vscode.dev") && url.pathname.toLowerCase().startsWith("/tunnel/"))
      || (host === "github.com" && url.pathname.toLowerCase().includes("/codespaces/"));
  } catch {
    return /(^|\.)github\.dev(?:\/|$)|codespaces\.new\/|github\.com\/codespaces\/|vscode\.dev\/tunnel\//i.test(text);
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
  const currentContext = context || overlayState.context || buildPayload();
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

  overlayState.context = context || buildPayload();
  overlayState.minimized = handoff.minimized === true || overlayState.minimized === true;
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
  const context = overlayState.context || buildPayload();
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

function shouldIgnoreForeignActiveTabForCodespace(remoteActiveTab) {
  const currentContext = overlayState.context || buildPayload();
  if (!remoteActiveTab?.isActive || !isCodespaceLikeContext(currentContext)) {
    return false;
  }

  const remoteTabId = toText(remoteActiveTab.tabId);
  const currentRepo = parseRepoFullName(currentContext.repoFullName || currentContext.url || "");
  const remoteRepo = parseRepoFullName(remoteActiveTab.tabUrl || remoteActiveTab.viewContext || "");
  const handoff = activeCodespaceHandoff;

  if (handoff && isCodespaceHandoffApplicable(currentContext, handoff)) {
    if (handoff.sourceTabId && remoteTabId === handoff.sourceTabId) {
      return true;
    }
    const handoffRepo = getCodespaceHandoffRepoFullName(handoff);
    if (currentRepo && handoffRepo && currentRepo.toLowerCase() === handoffRepo.toLowerCase()) {
      return true;
    }
    if (!currentRepo || !handoffRepo) {
      return true;
    }
  }

  if (currentRepo && remoteRepo && currentRepo.toLowerCase() === remoteRepo.toLowerCase()) {
    return !isCodespaceLikeUrl(remoteActiveTab.tabUrl);
  }

  return false;
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

// A12.8: toda URL que llega del backend, del modelo o de la pagina se abre solo si es
// http/https y siempre sin opener ni referrer.
function openExternalUrlSafely(url) {
  const safeUrl = toSafeHttpUrl(url);
  if (!safeUrl) return false;
  window.open(safeUrl, "_blank", "noopener,noreferrer");
  return true;
}

/**
 * VS Code instalado en este equipo (por ejemplo, las Mac del laboratorio):
 * la extension Git de VS Code clona el repositorio con vscode://vscode.git/clone.
 * Solo repositorios de github.com con owner/repo valido.
 */
function buildLocalVscodeCloneUrl(repoFullName) {
  const repo = parseRepoFullName(repoFullName);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.+$)[A-Za-z0-9._-]{1,100}$/.test(repo || "")) return "";
  return `vscode://vscode.git/clone?url=${encodeURIComponent(`https://github.com/${repo}.git`)}`;
}

// VS Code 0.0.31 (acceso simplificado, seccion 3): el enlace lleva un codigo de un solo uso;
// la extension lo canjea contra su backend, clona o abre el repo y queda vinculada. Sin
// codigo (pairingCode vacio) solo clona o abre el repo.
function buildLocalVscodeOpenUrl(pairingCode, repoFullName) {
  const repo = parseRepoFullName(repoFullName);
  const code = toText(pairingCode).toUpperCase();
  if (!buildLocalVscodeCloneUrl(repo) || (code && !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code))) return "";
  const [owner, name] = repo.split("/");
  const repoParam = `repo=${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  return code
    ? `vscode://adaceen.adaceen/abrir?code=${encodeURIComponent(code)}&${repoParam}`
    : `vscode://adaceen.adaceen/abrir?${repoParam}`;
}

// El enlace se crea y se pulsa dentro de la shadow root cerrada del overlay: el codigo de
// emparejamiento del href no queda al alcance de los scripts de la pagina (MutationObserver o
// listeners de click en document solo ven el host del overlay).
function openExternalProtocolLink(url) {
  const container = overlayRoot || document.body;
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noopener noreferrer";
  link.style.display = "none";
  container.appendChild(link);
  link.click();
  link.remove();
}

// El navegador solo abre vscode:// con el gesto del clic (unos 5 s): el codigo se pide con un
// limite corto y, si no llega, se usa el enlace anterior.
const LOCAL_VSCODE_PAIRING_TIMEOUT_MS = 3500;

async function openLocalVscodeClone() {
  const repoFullName = getCurrentRepoFullName();
  const cloneUrl = buildLocalVscodeCloneUrl(repoFullName);
  if (!cloneUrl) {
    overlayState.statusMessage = "No se detecto el repositorio (owner/repo) de esta pagina. Usa Autodetectar o escribe owner/repo.";
    renderOverlay();
    return false;
  }

  let pairing = null;
  let pairingError = null;
  try {
    pairing = await requestEditorPairingCode(LOCAL_VSCODE_PAIRING_TIMEOUT_MS);
  } catch (error) {
    pairingError = error;
  }
  const openUrl = pairing ? buildLocalVscodeOpenUrl(pairing.code, repoFullName) : "";
  if (openUrl) {
    openExternalProtocolLink(openUrl);
    overlayState.statusMessage = `Abriendo ${repoFullName} en el VS Code de este equipo: si ya estaba clonado se abre esa carpeta; si no, elige donde guardarlo. ADACEEN se conecta solo. Si no pasa nada, instala o actualiza la extension ADACEEN de VS Code (pagina Empezar del backend).`;
    // Al volver otro dia, "Abrir en VS Code de este equipo" es la accion principal.
    await rememberEditorChoice("local_vscode").catch(() => false);
    renderOverlay();
    return true;
  }

  if (!isEditorPairingUnsupported(pairingError)) {
    // Fallo pasajero (tiempo agotado, 5xx, sin red) o sesion vencida: el repo se abre igual, sin
    // codigo, y la sesion del navegador NO se copia (moriria en el siguiente login y los eventos
    // de VS Code quedarian anonimos). VS Code se conecta con "ADACEEN: sin conectar".
    openExternalProtocolLink(buildLocalVscodeOpenUrl("", repoFullName));
    await rememberEditorChoice("local_vscode").catch(() => false);
    const reason = toText(pairingError?.message).replace(/[.\s]+$/, "") || "sin respuesta";
    overlayState.statusMessage = `Abriendo ${repoFullName} en el VS Code de este equipo. No se pudo pedir el codigo de conexion (${reason}): pulsa este boton de nuevo, o en VS Code pulsa "ADACEEN: sin conectar" en la barra de estado y elige "Con mi cuenta de GitHub".`;
    renderOverlay();
    return true;
  }

  // Backend anterior sin emparejamiento (404): enlace de clonado y la sesion al portapapeles,
  // que VS Code acepta con "ADACEEN: Configurar sesion compartida".
  let sessionCopied = false;
  const sessionId = toText(overlayState.sessionId);
  if (sessionId) {
    try {
      await navigator.clipboard.writeText(sessionId);
      sessionCopied = true;
    } catch {
      sessionCopied = false;
    }
  }
  openExternalProtocolLink(cloneUrl);
  await rememberEditorChoice("local_vscode").catch(() => false);
  overlayState.statusMessage = sessionCopied
    ? `Abriendo VS Code de este equipo para clonar ${repoFullName}: elige una carpeta. Tu sesion quedo copiada; en VS Code pulsa F1, ejecuta "ADACEEN: Configurar sesion compartida" y pegala.`
    : `Abriendo VS Code de este equipo para clonar ${repoFullName}: elige una carpeta. Luego configura la sesion compartida (F1, "ADACEEN: Configurar sesion compartida").`;
  renderOverlay();
  return true;
}

// "Copiar codigo para VS Code" de la seccion VS Code (el boton de la sesion hasta 0.7.11): copia
// un codigo de un solo uso (10 min) que VS Code canjea con "ADACEEN: Conectar". Solo con un backend sin emparejamiento (404) copia la sesion,
// como antes; ante un fallo pasajero pide volver a intentar.
async function copyEditorPairingCodeForVscode() {
  let pairing = null;
  let pairingError = null;
  try {
    pairing = await requestEditorPairingCode();
  } catch (error) {
    pairingError = error;
  }
  if (!pairing && !isEditorPairingUnsupported(pairingError)) {
    const reason = toText(pairingError?.message).replace(/[.\s]+$/, "") || "sin respuesta";
    overlayState.statusMessage = `No se pudo pedir el codigo para VS Code (${reason}). Pulsa Copiar codigo para VS Code de nuevo en unos segundos.`;
    renderOverlay();
    return false;
  }
  if (pairing) {
    const minutes = Math.max(1, Math.round(pairing.ttlSeconds / 60));
    let copied = false;
    try {
      await navigator.clipboard.writeText(pairing.code);
      copied = true;
    } catch {
      copied = false;
    }
    // Una VS Code anterior a la 0.0.31 no tiene "ADACEEN: Conectar" ni canjea codigos: su
    // "Configurar sesion compartida" aceptaria el codigo sin conectar nada.
    const oldVscodeHint = " Si VS Code no tiene ese comando, actualiza su extension de ADACEEN (Descargar extension de VS Code, en /empezar): la anterior no acepta codigos.";
    overlayState.statusMessage = copied
      ? `Codigo copiado (un solo uso, vale ${minutes} min). En VS Code pulsa F1, ejecuta "ADACEEN: Conectar", elige "Tengo un codigo o sesion" y pegalo.${oldVscodeHint}`
      : `Codigo para VS Code: ${pairing.code} (un solo uso, vale ${minutes} min). En VS Code pulsa F1, ejecuta "ADACEEN: Conectar" y elige "Tengo un codigo o sesion".${oldVscodeHint}`;
    renderOverlay();
    return true;
  }

  const value = toText(overlayState.sessionId);
  if (!value) return false;
  try {
    await navigator.clipboard.writeText(value);
    overlayState.statusMessage = "Sesion copiada. En VS Code pulsa F1, ejecuta \"ADACEEN: Configurar sesion compartida\" y pegala.";
  } catch {
    overlayState.statusMessage = `Sesion ADACEEN: ${value}`;
  }
  renderOverlay();
  return true;
}

async function openCodespacesPage() {
  const repoFullName = getCurrentRepoFullName();
  if (!repoFullName) {
    overlayState.statusMessage = "No se detecta repositorio para abrir Codespaces.";
    renderOverlay();
    return;
  }

  const context = overlayState.context || buildPayload();
  if (toText(context?.pageType) === "codespace") {
    await markSetupCompleted();
    overlayState.statusMessage = "Codespace detectado. Continuando sin reiniciar ni preparar otro entorno.";
    if (hasActiveSession()) {
      await refreshMentorSession();
    } else {
      renderOverlay();
    }
    return;
  }

  // Tunel: "Abrir mi editor" (estado y abrir, o preparar). No exige la GitHub App.
  if (typeof isTunnelProvider === "function" && isTunnelProvider()) {
    await openMyTunnelEditor({ repoFullName });
    return;
  }

  const pull = getLatestSetupPullResult();
  const storedCodespaceUrl = getStoredSetupCodespaceUrl();
  if (isDirectCodespaceUrl(storedCodespaceUrl) && openExternalUrlSafely(storedCodespaceUrl)) {
    overlayState.statusMessage = "Abriendo Codespace existente de la PR de preparacion ADACEEN.";
    renderOverlay();
    return;
  }

  const flow = getSetupFlowState(overlayState.context || buildPayload());
  if (flow.accessVerified && flow.userHasCodespaceScope) {
    overlayState.statusMessage = isCodespaceQuickstartUrl(storedCodespaceUrl)
      ? "El enlace guardado es el selector de Codespaces. Creando o reanudando el Codespace automaticamente..."
      : "Preparando o reanudando el Codespace de la PR...";
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

  if (!openExternalUrlSafely(codespaceUrl)) {
    overlayState.statusMessage = "El enlace del Codespace no es valido (solo se abren enlaces http/https).";
    renderOverlay();
    return;
  }
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

  overlayState.statusMessage = openExternalUrlSafely(targetUrl)
    ? "Abriendo Codespaces manualmente sin volver a preparar el entorno."
    : "El enlace del Codespace no es valido (solo se abren enlaces http/https).";
  renderOverlay();
}

async function ensureOverlay() {
  await loadPreferences();

  if (overlayHost?.isConnected && overlayRoot) {
    bindVscodeInlinePaletteListeners();
    startVscodeSyncPolling();
    return;
  }
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
  // A12.8: raiz cerrada; el JavaScript de la pagina no puede leer los campos del overlay
  // (p. ej. la contrasena) con host.shadowRoot. El overlay usa solo la referencia overlayRoot.
  overlayRoot = overlayHost.attachShadow({ mode: "closed" });
  overlayRoot.innerHTML = buildOverlayMarkup();
  // Tras una entrada automatica, el primer clic o tecla en el overlay la vuelve una pestana activa.
  overlayRoot.addEventListener("pointerdown", noteOverlayInteractionAfterAutoEnter, true);
  overlayRoot.addEventListener("keydown", noteOverlayInteractionAfterAutoEnter, true);

  overlayEls = {
    shell: overlayRoot.getElementById("shell"),
    window: overlayRoot.getElementById("window"),
    vscodeInlinePalette: overlayRoot.getElementById("vscodeInlinePalette"),
    vscodeInlineStatus: overlayRoot.getElementById("vscodeInlineStatus"),
    vscodeInlineTarget: overlayRoot.getElementById("vscodeInlineTarget"),
    vscodeInlineFile: overlayRoot.getElementById("vscodeInlineFile"),
    vscodeInlineSuggestion: overlayRoot.getElementById("vscodeInlineSuggestion"),
    vscodeInlineActions: overlayRoot.getElementById("vscodeInlineActions"),
    minimizedTabBtn: overlayRoot.getElementById("minimizedTabBtn"),
    minimizedTabTitle: overlayRoot.getElementById("minimizedTabTitle"),
    minimizedTabSubtitle: overlayRoot.getElementById("minimizedTabSubtitle"),
    dragHandle: overlayRoot.getElementById("dragHandle"),
    headerUserTitle: overlayRoot.getElementById("headerUserTitle"),
    headerUserSubtitle: overlayRoot.getElementById("headerUserSubtitle"),
    minimizeBtn: overlayRoot.getElementById("minimizeBtn"),
    settingsBtn: overlayRoot.getElementById("settingsBtn"),
    logoutHeaderBtn: overlayRoot.getElementById("logoutHeaderBtn"),
    closeBtn: overlayRoot.getElementById("closeBtn"),
    settingsPanel: overlayRoot.getElementById("settingsPanel"),
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
    tabConflictModal: overlayRoot.getElementById("tabConflictModal"),
    tabConflictNotice: overlayRoot.getElementById("tabConflictNotice"),
    tabConflictRefreshBtn: overlayRoot.getElementById("tabConflictRefreshBtn"),
    welcomeContext: overlayRoot.getElementById("welcomeContext"),
    welcomeCopy: overlayRoot.getElementById("welcomeCopy"),
    startBtn: overlayRoot.getElementById("startBtn"),
    authEmail: overlayRoot.getElementById("authEmail"),
    authPassword: overlayRoot.getElementById("authPassword"),
    authHelper: overlayRoot.getElementById("authHelper"),
    googleAuthBtn: overlayRoot.getElementById("googleAuthBtn"),
    authSubmitBtn: overlayRoot.getElementById("authSubmitBtn"),
    authBackBtn: overlayRoot.getElementById("authBackBtn"),
    authError: overlayRoot.getElementById("authError"),
    setupViewPill: overlayRoot.getElementById("setupViewPill"),
    setupViewTitle: overlayRoot.getElementById("setupViewTitle"),
    setupViewCopy: overlayRoot.getElementById("setupViewCopy"),
    setupStepOneCard: overlayRoot.getElementById("setupStepOneCard"),
    setupStepOneEyebrow: overlayRoot.getElementById("setupStepOneEyebrow"),
    setupStepOneTitle: overlayRoot.getElementById("setupStepOneTitle"),
    setupStepOneNote: overlayRoot.getElementById("setupStepOneNote"),
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
    setupDetectRepoBtn: overlayRoot.getElementById("setupDetectRepoBtn"),
    setupOpenLocalVscodeBtn: overlayRoot.getElementById("setupOpenLocalVscodeBtn"),
    setupStatusText: overlayRoot.getElementById("setupStatusText"),
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
    teacherBitacoraExportXlsxBtn: overlayRoot.getElementById("teacherBitacoraExportXlsxBtn"),
    teacherBitacoraExportCsvBtn: overlayRoot.getElementById("teacherBitacoraExportCsvBtn"),
    teacherBitacoraChooseFileBtn: overlayRoot.getElementById("teacherBitacoraChooseFileBtn"),
    teacherBitacoraManualWeekInput: overlayRoot.getElementById("teacherBitacoraManualWeekInput"),
    teacherBitacoraManualDateInput: overlayRoot.getElementById("teacherBitacoraManualDateInput"),
    teacherBitacoraManualCategorySelect: overlayRoot.getElementById("teacherBitacoraManualCategorySelect"),
    teacherBitacoraManualTitleInput: overlayRoot.getElementById("teacherBitacoraManualTitleInput"),
    teacherBitacoraManualDescriptionInput: overlayRoot.getElementById("teacherBitacoraManualDescriptionInput"),
    teacherBitacoraManualSaveBtn: overlayRoot.getElementById("teacherBitacoraManualSaveBtn"),
    teacherBitacoraManualClearBtn: overlayRoot.getElementById("teacherBitacoraManualClearBtn"),
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
    adminToggleCreateUserBtn: overlayRoot.getElementById("adminToggleCreateUserBtn"),
    adminCreateForm: overlayRoot.getElementById("adminCreateForm"),
    adminCreateRole: overlayRoot.getElementById("adminCreateRole"),
    adminCreateName: overlayRoot.getElementById("adminCreateName"),
    adminCreateEmail: overlayRoot.getElementById("adminCreateEmail"),
    adminCreatePassword: overlayRoot.getElementById("adminCreatePassword"),
    adminCreateTeacher: overlayRoot.getElementById("adminCreateTeacher"),
    adminCreateCourseGrid: overlayRoot.getElementById("adminCreateCourseGrid"),
    adminCreateBtn: overlayRoot.getElementById("adminCreateBtn"),
    adminUsersTableBody: overlayRoot.getElementById("adminUsersTableBody"),
    studentGoalSection: overlayRoot.getElementById("studentGoalSection"),
    vscodeSyncSection: overlayRoot.getElementById("vscodeSyncSection"),
    vscodeSyncDragHandle: overlayRoot.getElementById("vscodeSyncDragHandle"),
    vscodeCopySessionBtn: overlayRoot.getElementById("vscodeCopySessionBtn"),
    vscodeSyncRefreshBtn: overlayRoot.getElementById("vscodeSyncRefreshBtn"),
    vscodeSyncStatus: overlayRoot.getElementById("vscodeSyncStatus"),
    vscodeSyncMeta: overlayRoot.getElementById("vscodeSyncMeta"),
    vscodeFileTitle: overlayRoot.getElementById("vscodeFileTitle"),
    vscodeFileSummary: overlayRoot.getElementById("vscodeFileSummary"),
    vscodeSuggestionText: overlayRoot.getElementById("vscodeSuggestionText"),
    vscodeReplacementList: overlayRoot.getElementById("vscodeReplacementList"),
    ragSourcesSection: overlayRoot.getElementById("ragSourcesSection"),
    ragActiveCourseBadge: overlayRoot.getElementById("ragActiveCourseBadge"),
    ragSourcesList: overlayRoot.getElementById("ragSourcesList"),
    studentIdeasSection: overlayRoot.getElementById("studentIdeasSection"),
    nextStepSection: overlayRoot.getElementById("nextStepSection"),
    tutorResponseRegion: overlayRoot.getElementById("tutorResponseRegion"),
    tutorFeedbackSection: overlayRoot.getElementById("tutorFeedbackSection"),
    tutorFeedbackAcceptBtn: overlayRoot.getElementById("tutorFeedbackAcceptBtn"),
    tutorFeedbackRejectBtn: overlayRoot.getElementById("tutorFeedbackRejectBtn"),
    tutorFeedbackStatus: overlayRoot.getElementById("tutorFeedbackStatus"),
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
    teacherQuizAfterAccept: overlayRoot.getElementById("teacherQuizAfterAccept"),
    teacherQuizTeacherLaunch: overlayRoot.getElementById("teacherQuizTeacherLaunch"),
    teacherQuizFollowUp: overlayRoot.getElementById("teacherQuizFollowUp"),
    teacherQuizEveryN: overlayRoot.getElementById("teacherQuizEveryN"),
    teacherQuizMaxPerSession: overlayRoot.getElementById("teacherQuizMaxPerSession"),
    teacherQuizTopic: overlayRoot.getElementById("teacherQuizTopic"),
    teacherQuizLaunchBtn: overlayRoot.getElementById("teacherQuizLaunchBtn"),
    teacherQuizCloseBtn: overlayRoot.getElementById("teacherQuizCloseBtn"),
    teacherQuizStatus: overlayRoot.getElementById("teacherQuizStatus"),
    teacherOutcomeHelpBtn: overlayRoot.getElementById("teacherOutcomeHelpBtn"),
    teacherOutcomeHelp: overlayRoot.getElementById("teacherOutcomeHelp"),
    teacherCodeApplyAllowed: overlayRoot.getElementById("teacherCodeApplyAllowed"),
    teacherCodeApplyMaxLines: overlayRoot.getElementById("teacherCodeApplyMaxLines"),
    teacherCodeApplyCountsAsHint: overlayRoot.getElementById("teacherCodeApplyCountsAsHint"),
    teacherCodeApplyRequireConfirmation: overlayRoot.getElementById("teacherCodeApplyRequireConfirmation"),
    teacherNoSolution: overlayRoot.getElementById("teacherNoSolution"),
    teacherMaxHints: overlayRoot.getElementById("teacherMaxHints"),
    teacherAllowExplanation: overlayRoot.getElementById("teacherAllowExplanation"),
    teacherAllowHint: overlayRoot.getElementById("teacherAllowHint"),
    teacherAllowExample: overlayRoot.getElementById("teacherAllowExample"),
    teacherFallbackMessage: overlayRoot.getElementById("teacherFallbackMessage"),
    teacherCustomInstruction: overlayRoot.getElementById("teacherCustomInstruction"),
    backendUrlInput: overlayRoot.getElementById("backendUrlInput"),
    advancedGithubBlock: overlayRoot.getElementById("advancedGithubBlock"),
    advancedGithubNote: overlayRoot.getElementById("advancedGithubNote"),
    saveSettingsBtn: overlayRoot.getElementById("saveSettingsBtn"),
    analysisWindow: overlayRoot.getElementById("analysisWindow"),
    analysisCloseBtn: overlayRoot.getElementById("analysisCloseBtn"),
    analysisTitle: overlayRoot.getElementById("analysisTitle"),
    analysisStats: overlayRoot.getElementById("analysisStats"),
    analysisFileList: overlayRoot.getElementById("analysisFileList"),
    // Pestanas de la vista principal y pestana "Estudiantes" (0.7.13, content-students.js).
    mainTabBar: overlayRoot.getElementById("mainTabBar"),
    tabBtnInicio: overlayRoot.getElementById("tabBtnInicio"),
    tabBtnTutor: overlayRoot.getElementById("tabBtnTutor"),
    tabBtnEstudiantes: overlayRoot.getElementById("tabBtnEstudiantes"),
    tabBtnUsuarios: overlayRoot.getElementById("tabBtnUsuarios"),
    tabCountEstudiantes: overlayRoot.getElementById("tabCountEstudiantes"),
    tabPanelInicio: overlayRoot.getElementById("tabPanelInicio"),
    tabPanelTutor: overlayRoot.getElementById("tabPanelTutor"),
    tabPanelEstudiantes: overlayRoot.getElementById("tabPanelEstudiantes"),
    tabPanelUsuarios: overlayRoot.getElementById("tabPanelUsuarios"),
    tabBtnRag: overlayRoot.getElementById("tabBtnRag"),
    tabPanelRag: overlayRoot.getElementById("tabPanelRag"),
    ragCoursesSection: overlayRoot.getElementById("ragCoursesSection"),
    ragCoursesStatus: overlayRoot.getElementById("ragCoursesStatus"),
    ragCoursesRefreshBtn: overlayRoot.getElementById("ragCoursesRefreshBtn"),
    ragCourseGroups: overlayRoot.getElementById("ragCourseGroups"),
    ragCoursesMessage: overlayRoot.getElementById("ragCoursesMessage"),
    tabBtnQuices: overlayRoot.getElementById("tabBtnQuices"),
    tabPanelQuices: overlayRoot.getElementById("tabPanelQuices"),
    quizzesSection: overlayRoot.getElementById("quizzesSection"),
    quizzesStatus: overlayRoot.getElementById("quizzesStatus"),
    quizzesRefreshBtn: overlayRoot.getElementById("quizzesRefreshBtn"),
    quizzesCreateBtn: overlayRoot.getElementById("quizzesCreateBtn"),
    quizzesBankCount: overlayRoot.getElementById("quizzesBankCount"),
    quizzesBankList: overlayRoot.getElementById("quizzesBankList"),
    quizzesBankEmpty: overlayRoot.getElementById("quizzesBankEmpty"),
    quizzesDoneCount: overlayRoot.getElementById("quizzesDoneCount"),
    quizzesDoneSummary: overlayRoot.getElementById("quizzesDoneSummary"),
    quizzesDoneBody: overlayRoot.getElementById("quizzesDoneBody"),
    quizzesDoneEmpty: overlayRoot.getElementById("quizzesDoneEmpty"),
    quizzesMessage: overlayRoot.getElementById("quizzesMessage"),
    ragSourcesNote: overlayRoot.getElementById("ragSourcesNote"),
    ragSourcesCount: overlayRoot.getElementById("ragSourcesCount"),
    tutorLockedNotice: overlayRoot.getElementById("tutorLockedNotice"),
    settingsSectionSession: overlayRoot.getElementById("settingsSectionSession"),
    settingsSectionAdvanced: overlayRoot.getElementById("settingsSectionAdvanced"),
    settingsSectionPolicy: overlayRoot.getElementById("settingsSectionPolicy"),
    settingsSectionQuiz: overlayRoot.getElementById("settingsSectionQuiz"),
    settingsSectionCodeApply: overlayRoot.getElementById("settingsSectionCodeApply"),
    studentsSection: overlayRoot.getElementById("studentsSection"),
    studentsKpis: overlayRoot.getElementById("studentsKpis"),
    studentsSearchInput: overlayRoot.getElementById("studentsSearchInput"),
    studentsReloadBtn: overlayRoot.getElementById("studentsReloadBtn"),
    studentsStatus: overlayRoot.getElementById("studentsStatus"),
    studentsTableBody: overlayRoot.getElementById("studentsTableBody"),
    studentDetailSection: overlayRoot.getElementById("studentDetailSection"),
    studentDetailBackBtn: overlayRoot.getElementById("studentDetailBackBtn"),
    studentDetailTitle: overlayRoot.getElementById("studentDetailTitle"),
    studentDetailMeta: overlayRoot.getElementById("studentDetailMeta"),
    studentDetailChip: overlayRoot.getElementById("studentDetailChip"),
    studentDetailReloadBtn: overlayRoot.getElementById("studentDetailReloadBtn"),
    studentDetailStatus: overlayRoot.getElementById("studentDetailStatus"),
    studentDetailKpis: overlayRoot.getElementById("studentDetailKpis"),
    studentDetailTimeline: overlayRoot.getElementById("studentDetailTimeline"),
    studentDetailTimelineLegend: overlayRoot.getElementById("studentDetailTimelineLegend"),
    studentDetailQuizzes: overlayRoot.getElementById("studentDetailQuizzes"),
    studentDetailSessions: overlayRoot.getElementById("studentDetailSessions"),
    studentDetailInterventions: overlayRoot.getElementById("studentDetailInterventions"),
    studentDetailActivity: overlayRoot.getElementById("studentDetailActivity"),
  };

  bindOverlayAccessibility();
  bindMainTabs();
  bindStudentsPanel();
  bindRagCoursesPanel();
  bindQuizzesPanel();
  bindTutorPanel();
  bindWindowControls();
  bindSettingsPanel();
  bindAuthControls();
  overlayEls.setupPrimaryActionBtn.addEventListener("click", async () => {
    await runRecommendedContextAction(overlayEls.setupPrimaryActionBtn.dataset.contextAction);
  });
  overlayEls.setupSecondaryActionBtn.addEventListener("click", async () => {
    await runRecommendedContextAction(overlayEls.setupSecondaryActionBtn.dataset.contextAction);
  });
  bindHomePanel();
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
  // VS Code instalado en este equipo: no hace falta la GitHub App ni el editor en la nube.
  overlayEls.setupOpenLocalVscodeBtn?.addEventListener("click", async () => {
    noteOverlayInteractionAfterAutoEnter();
    if (await openLocalVscodeClone()) {
      await markSetupCompleted();
      renderOverlay();
    }
  });
  overlayEls.analyzeProjectBtn.addEventListener("click", async () => {
    await analyzeCurrentContext();
  });
  bindVscodeSyncPanel();
  overlayEls.teacherBitacoraUploadBtn?.addEventListener("click", async () => {
    await openTeacherBitacoraPage();
  });
  // «Configurar RAG» abre la pestana RAG (0.7.14): todos los cursos a la vista, sin pagina aparte.
  overlayEls.teacherRagManageBtn?.addEventListener("click", () => {
    setMainTab("rag", { byUser: true, forceRender: true });
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
  overlayEls.teacherBitacoraExportXlsxBtn?.addEventListener("click", async () => {
    await exportTeacherBitacora("xlsx");
  });
  overlayEls.teacherBitacoraExportCsvBtn?.addEventListener("click", async () => {
    await exportTeacherBitacora("csv");
  });
  overlayEls.teacherBitacoraChooseFileBtn?.addEventListener("click", () => {
    openTeacherBitacoraFilePicker();
  });
  overlayEls.teacherBitacoraManualSaveBtn?.addEventListener("click", async () => {
    await saveTeacherBitacoraManualEntry();
  });
  overlayEls.teacherBitacoraManualClearBtn?.addEventListener("click", () => {
    clearTeacherBitacoraManualForm();
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
  // "OCR visual" solo en el editor: en Campus la agenda se sincroniza desde la accion
  // recomendada ("Sincronizar agenda").
  overlayEls.rerunOcrBtn.addEventListener("click", async () => {
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
  bindAdminUsersPanel();
  overlayEls.reloadTelemetryBtn?.addEventListener("click", async () => {
    await reloadPolicyAndTelemetry();
    renderOverlay();
  });
  overlayEls.teacherQuizLaunchBtn.addEventListener("click", async () => {
    await launchClassQuiz();
  });
  overlayEls.teacherQuizCloseBtn.addEventListener("click", async () => {
    await closeActiveClassQuiz();
  });

  document.documentElement.appendChild(overlayHost);
  bindOverlayViewportListeners();
  bindVscodeInlinePaletteListeners();
  startVscodeSyncPolling();
  overlayState.context = buildPayload();
  // Las cuentas demo solo se precargan con el backend local (npm run dev); en el piloto
  // el login llega vacio.
  if (isLocalBackendUrl(overlayState.backendUrl)) {
    overlayEls.authEmail.value = "estudiante@adaceen.edu.co";
    overlayEls.authPassword.value = "Estudiante123!";
  }
  renderOverlay();
  scheduleOverlayViewportSync(false);
}

// Entrada al abrir el overlay (item 13 de la auditoria: «Empezar» solo navegaba). Solo al
// abrirlo el estudiante (icono) o al restaurarlo fijado en la pestana visible; nunca por
// sincronizacion entre pestanas ni en github.com/login/device:
//  - sin sesion se muestra el login directamente;
//  - con un editor guardado (acceso simplificado, seccion 4), en GitHub, en paginas sin
//    contexto y en el propio editor del tunel (vscode.dev), entra sin pedir ayuda al tutor ni
//    contar como pestana activa hasta el primer clic o tecla, y ofrece "Abrir mi editor";
//  - con el icono y sin editor guardado entra como si se pulsara «Empezar» (el tutor
//    responde una vez);
//  - restaurado al cargar una pagina con algo que hacer (un repositorio de GitHub, el editor o
//    Campus), entra como con un editor guardado: sin el tutor ni pestana activa hasta que el
//    estudiante interactua, y sin el aviso de conflicto si otra pestana tiene la sesion activa.
//    Las paginas del propio flujo de GitHub (la ventana del OAuth, la instalacion de la GitHub
//    App, ajustes) y las paginas sin contexto se quedan en la bienvenida, como en 0.7.11.
let savedEditorAutoEnterInFlight = null;

// Donde un editor guardado permite entrar sin el tutor: GitHub, paginas sin contexto y
// vscode.dev (tunel). En Campus y en Codespaces el icono sigue pidiendo la primera respuesta.
function isSavedEditorAutoEnterPage(context) {
  const pageType = toText(context?.pageType);
  if (toText(context?.pageContext) === "campus" || pageType.startsWith("campus")) return false;
  if (pageType === "codespace") return isTunnelEditorPage(context);
  return true;
}

// Restaurado sin editor guardado: solo donde el overlay tiene algo que hacer.
function isRestoreAutoEnterPage(context) {
  const pageType = toText(context?.pageType);
  if (toText(context?.pageContext) === "campus" || pageType.startsWith("campus")) return true;
  if (pageType === "codespace") return true;
  return (pageType === "github_code" || pageType === "github_general")
    && !!parseRepoFullName(context?.repoFullName);
}

// Sin red: hay un editor del tunel guardado para la sesion del snapshot y la pagina lo ofrece.
// Con Codespaces ya confirmado (el caso normal sin editor guardado) no aplica.
function hasSavedEditorForAutoEnter(context) {
  if (!isSavedEditorAutoEnterPage(context)) return false;
  if (typeof getLatestSavedTunnelEditor !== "function" || !getLatestSavedTunnelEditor()) return false;
  return !(overlayState.workspaceProvider === "codespaces"
    && !(typeof isWorkspaceProviderProvisional === "function" && isWorkspaceProviderProvisional()));
}

function noteOverlayInteractionAfterAutoEnter() {
  if (!savedEditorAutoEnterIdle) return;
  savedEditorAutoEnterIdle = false;
  if (overlayState.started && document.visibilityState === "visible") {
    queueActiveTabReport(true);
  }
  queueTabSessionSave();
}

// La sesion del snapshot compartido puede ser vieja: /api/auth/me la confirma (y trae la
// privacidad aceptada en el backend). "unknown": sin red o sin respuesta a tiempo. Con un
// timeout corto: mientras tanto el unico boton es "Preparando..." y un backend frio (Azure)
// puede tardar minutos; al vencer, el icono entra igual, como «Empezar».
const SESSION_CONFIRM_ON_OPEN_TIMEOUT_MS = 10000;

async function confirmSessionOnOpen() {
  try {
    return (await fetchCurrentSession({ timeoutMs: SESSION_CONFIRM_ON_OPEN_TIMEOUT_MS })) ? "valid" : "invalid";
  } catch (error) {
    const status = Number(error?.status);
    return status === 401 || status === 403 ? "invalid" : "unknown";
  }
}

// Entra sin el tutor y sin reportarse como pestana activa hasta la primera interaccion. Al
// restaurar la pagina, otra pestana con la sesion activa no abre el aviso de conflicto.
async function enterOverlayIdle(trigger = "user") {
  savedEditorAutoEnterIdle = true;
  await startExperience({ skipModelRequests: true, quietActiveTabConflict: trigger === "restore" });
  if (!overlayState.started) savedEditorAutoEnterIdle = false;
  return overlayState.started;
}

async function autoEnterWithSavedEditor(trigger) {
  if (!hasSavedEditorForAutoEnter(overlayState.context || buildPayload())) return false;
  if (!hasActiveSession() || isAdminSession()) return false;
  // Con Codespaces el editor guardado (del tunel) no aplica.
  if (typeof refreshWorkspaceProvider === "function") {
    await refreshWorkspaceProvider().catch(() => "");
  }
  if (overlayState.workspaceProvider === "codespaces") return false;
  if (overlayState.started || !overlayHost?.isConnected) return false;
  return enterOverlayIdle(trigger);
}

async function autoEnterOnOpen(trigger) {
  if (overlayState.started) return false;
  if (trigger !== "user" && trigger !== "restore") return false;
  if (document.visibilityState === "hidden") return false;
  if (typeof isGithubDeviceLoginPage === "function" && isGithubDeviceLoginPage()) return false;
  if (getActiveTabConflictNotice()) return false;
  if (trigger === "restore") {
    // La ventana del OAuth, la instalacion de la GitHub App... (github.com/login/*,
    // github.com/apps/*): ni se entra ni se consulta el backend.
    const context = overlayState.context || buildPayload();
    if (isGithubFlowPageUrl(toText(context?.url) || location.href)) return false;
    // Paginas sin contexto y sin un editor guardado que ofrecer: «Empezar», como en 0.7.11.
    if (overlayState.sessionId && !isRestoreAutoEnterPage(context) && !hasSavedEditorForAutoEnter(context)) {
      return false;
    }
  }

  if (!overlayState.sessionId) {
    // Sin sesion, «Empezar» solo llevaba al login.
    overlayState.started = true;
    renderOverlay();
    return true;
  }

  // Mientras se confirma la sesion, la bienvenida dice "Preparando..." en vez de «Empezar».
  overlayState.loading = true;
  renderOverlay();
  let session = "unknown";
  try {
    session = await confirmSessionOnOpen();
  } finally {
    if (!overlayState.started) overlayState.loading = false;
  }
  // El estudiante pudo pulsar «Empezar» o cerrar el overlay mientras tanto.
  if (overlayState.started || !overlayHost?.isConnected) return false;
  if (session === "invalid") {
    resetAuthStateForCrossTabSync("");
    overlayState.authError = "La sesion ya no es valida. Inicia sesion nuevamente.";
    await persistPreferences().catch(() => false);
    if (typeof clearSharedSessionSnapshot === "function") {
      await clearSharedSessionSnapshot().catch(() => false);
    }
    overlayState.started = true;
    renderOverlay();
    return true;
  }
  // Sin respuesta del backend, restaurar la pagina no entra (queda «Empezar»); el icono si,
  // como «Empezar».
  if (session === "unknown" && trigger !== "user") {
    renderOverlay();
    return false;
  }
  if (getActiveTabConflictNotice()) {
    renderOverlay();
    return false;
  }

  if (session === "valid" && await autoEnterWithSavedEditor(trigger)) return true;
  if (overlayState.started || !overlayHost?.isConnected || !overlayState.sessionId) return false;
  if (trigger === "user") {
    await startExperience();
    return overlayState.started;
  }
  if (!isRestoreAutoEnterPage(overlayState.context || buildPayload())) {
    renderOverlay();
    return false;
  }
  return enterOverlayIdle(trigger);
}

// options.trigger: "user" (clic en el icono), "restore" (overlay fijado al cargar la pagina),
// "sync" (otra pestana) o "auto". Solo con "user" se mueve el foco al overlay (WCAG 2.4.3).
async function openOverlay(options = {}) {
  if (overlayOpenInFlight) {
    return overlayOpenInFlight;
  }

  const trigger = toText(options?.trigger) || "auto";
  const userInitiated = trigger === "user";
  overlayOpenInFlight = (async () => {
    const alreadyOpen = !!(overlayHost?.isConnected && overlayRoot);
    if (userInitiated && !isFocusInsideOverlay()) {
      rememberOverlayFocusReturnTarget();
    }
    if (!alreadyOpen) {
      resetOverlayStateForOpen();
    } else {
      overlayState.context = buildPayload();
    }

    await ensureOverlay();
    await syncFromStorageSnapshot({ force: true, skipPinned: true }).catch(() => {});

    if (!alreadyOpen) {
      const currentContext = overlayState.context || buildPayload();
      const handoff = await readCodespaceNavigationHandoff(currentContext);
      if (handoff) {
        applyCodespaceNavigationHandoff(handoff, currentContext);
      } else {
        const cached = await loadTabSessionSnapshot(currentContext);
        if (cached) {
          applyTabSessionSnapshot(cached);
        }
      }
    }

    await chrome.storage.local.set({ [STORAGE_KEY_OVERLAY_PINNED]: true });
    renderOverlay();
    if (!alreadyOpen) {
      recordOverlayOpened(trigger);
    }
    if (userInitiated) {
      focusOverlayAfterUserOpen();
    }
    if (activeCodespaceHandoff && overlayState.started && document.visibilityState === "visible") {
      queueActiveTabReport(true);
    }
    queueTabSessionSave();
    scheduleOverlayViewportSync(false);
    if (!alreadyOpen && !overlayState.started && !savedEditorAutoEnterInFlight) {
      // Sin await: el tutor puede tardar y el overlay ya esta visible con la bienvenida.
      savedEditorAutoEnterInFlight = autoEnterOnOpen(trigger)
        .catch(() => false)
        .finally(() => {
          savedEditorAutoEnterInFlight = null;
        });
    }
  })();

  try {
    return await overlayOpenInFlight;
  } finally {
    overlayOpenInFlight = null;
  }
}

// options.reason: "user" (boton cerrar), "escape", "sync" (otra pestana) o "message".
async function closeOverlay(options = {}) {
  const reason = toText(options?.reason) || "user";
  const wasOpen = !!overlayHost?.isConnected;
  const focusWasInside = isFocusInsideOverlay();
  if (wasOpen) {
    clearTutorResponseTracking("overlay_closed");
    recordOverlayClosed(reason);
  }
  stopVisibleErrorSignals();
  if (typeof stopGithubAppInstallWatch === "function") stopGithubAppInstallWatch();
  await flushTabSessionSave();
  clearMentorFallbackTimer();
  clearVscodeSyncPolling();
  if (vscodeInlinePaletteRaf) {
    window.cancelAnimationFrame(vscodeInlinePaletteRaf);
    vscodeInlinePaletteRaf = 0;
  }
  savedEditorAutoEnterIdle = false;
  overlayState.started = false;
  overlayState.settingsOpen = false;
  overlayState.minimized = false;
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
  overlayState.codespaceWaitingContext = { ...EMPTY_CODESPACE_WAITING_CONTEXT };
  overlayState.campusCourseAccess = { ...EMPTY_CAMPUS_COURSE_ACCESS_STATE };
  overlayState.ragCourseCatalog = [];
  overlayState.ragDefaultCourseCode = "FPOO";
  overlayState.studentCourseModalOpen = false;
  overlayState.studentCourseState = { ...EMPTY_STUDENT_COURSE_STATE };
  overlayState.projectContextMessage = "";
  overlayState.projectContextError = "";
  overlayState.adminUsers = [];
  overlayState.adminTeachers = [];
  overlayState.adminCreateFormOpen = false;
  overlayState.adminUsersBusy = false;
  overlayState.adminUsersMessage = "";
  overlayState.ideas = [];
  overlayState.guide = [];
  overlayState.welcome = "";
  overlayState.mentorSummary = "";
  overlayState.activeRagCourseCode = "";
  overlayState.statusMessage = "";
  overlayState.operationTitle = "";
  overlayState.operationDetail = "";
  overlayState.operationKind = "busy";

  try {
    await chrome.storage.local.set({
      [STORAGE_KEY_OVERLAY_PINNED]: false,
      [STORAGE_KEY_OVERLAY_MINIMIZED]: false,
    });
  } catch {}

  if (overlayHost?.isConnected) {
    overlayHost.remove();
  }

  overlayHost = null;
  overlayRoot = null;
  overlayEls = null;
  resetOverlayFocusState();
  if (focusWasInside || reason === "escape" || reason === "user") {
    restoreOverlayFocusReturnTarget();
  } else {
    forgetOverlayFocusReturnTarget();
  }
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
    openOverlay({ trigger: "user" })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ADACEEN_CLOSE_OVERLAY") {
    closeOverlay({ reason: "message" })
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
// github.com/login/device durante la preparacion del tunel: muestra el codigo a copiar.
showGithubDeviceCodeHelper().catch(() => {});
