
const STORAGE_KEY_TAB_SESSION_MAP = "adaceenOverlayTabSessionMap";
const TAB_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const TAB_SESSION_MAX_ENTRIES = 24;
const TAB_SESSION_PREVIEW_CHARS = 1400;
const SHARED_STORAGE_SYNC_KEYS = [
  STORAGE_KEY_ENABLED,
  STORAGE_KEY_BACKEND_URL,
  STORAGE_KEY_LEARNING_GOAL,
  STORAGE_KEY_SESSION_ID,
  STORAGE_KEY_PROJECT_CONSENT_BY_USER,
  STORAGE_KEY_SETUP_DONE_BY_USER,
  STORAGE_KEY_AUTO_CONFIG_ENABLED,
  STORAGE_KEY_OVERLAY_PINNED,
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
    started: !!overlayState.started,
    settingsOpen: !!overlayState.settingsOpen,
    analysisWindowOpen: !!overlayState.analysisWindowOpen,
    analysisUnlocked: !!overlayState.analysisUnlocked,
    setupRepoFullName: toText(overlayState.setupRepoFullName),
    setupWizardStep: Math.max(1, Math.min(3, Number(overlayState.setupWizardStep) || 1)),
    ideas: normalizeSessionList(overlayState.ideas, MAX_LIST_ITEMS),
    guide: normalizeSessionList(overlayState.guide, MAX_LIST_ITEMS),
    welcome: toText(overlayState.welcome),
    statusMessage: toText(overlayState.statusMessage),
    projectContextMessage: toText(overlayState.projectContextMessage),
    projectContextError: toText(overlayState.projectContextError),
    projectContextStatus: normalizeProjectContextStatusPayload(overlayState.projectContextStatus),
    projectContextHistory: normalizeProjectContextHistoryPayload(overlayState.projectContextHistory).slice(0, 12),
    projectContextInsight: normalizeProjectContextInsightPayload(overlayState.projectContextInsight),
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
  overlayState.ideas = normalizeSessionList(snapshot.ideas, MAX_LIST_ITEMS);
  overlayState.guide = normalizeSessionList(snapshot.guide, MAX_LIST_ITEMS);
  overlayState.welcome = toText(snapshot.welcome);
  overlayState.statusMessage = toText(snapshot.statusMessage);
  overlayState.projectContextMessage = toText(snapshot.projectContextMessage);
  overlayState.projectContextError = toText(snapshot.projectContextError);
  overlayState.projectContextStatus = normalizeProjectContextStatusPayload(snapshot.projectContextStatus || overlayState.projectContextStatus);
  overlayState.projectContextHistory = normalizeProjectContextHistoryPayload(snapshot.projectContextHistory).slice(0, 12);
  overlayState.projectContextInsight = normalizeProjectContextInsightPayload(snapshot.projectContextInsight || overlayState.projectContextInsight);
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
  overlayState.setupRepoFullName = "";
  overlayState.setupWizardStep = 1;
  overlayState.githubAppBusy = false;
  overlayState.githubAppStatus = { ...EMPTY_GITHUB_APP_STATUS };
  overlayState.projectContextBusy = false;
  overlayState.projectContextStatus = { ...EMPTY_PROJECT_CONTEXT_STATUS };
  overlayState.projectContextHistory = [];
  overlayState.projectContextInsight = { ...EMPTY_PROJECT_CONTEXT_INSIGHT };
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
  overlayState.context = buildPayload();
}

function resetAuthStateForCrossTabSync(statusMessage = "") {
  overlayState.sessionId = "";
  overlayState.session = null;
  overlayState.policy = { ...DEFAULT_POLICY };
  overlayState.telemetry = [];
  overlayState.firstLoginConfirmationOpen = false;
  overlayState.authError = "";
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

  if (Object.prototype.hasOwnProperty.call(snapshot, STORAGE_KEY_AUTO_CONFIG_ENABLED)) {
    const nextAutoConfigEnabled = typeof snapshot[STORAGE_KEY_AUTO_CONFIG_ENABLED] === "boolean"
      ? snapshot[STORAGE_KEY_AUTO_CONFIG_ENABLED]
      : true;
    if (overlayState.autoConfigEnabled !== nextAutoConfigEnabled) {
      overlayState.autoConfigEnabled = nextAutoConfigEnabled;
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

async function ensureOverlay() {
  await loadPreferences();

  if (overlayHost?.isConnected && overlayRoot) return;

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
  overlayEls.firstLoginConfirmBtn.addEventListener("click", () => {
    overlayState.firstLoginConfirmationOpen = false;
    renderOverlay();
  });
  overlayEls.firstLoginLogoutBtn.addEventListener("click", async () => {
    await logoutAndReturnToLogin();
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
      await refreshGithubAppStatus();
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
      await refreshGithubAppStatus();
      const afterRefresh = getSetupFlowState(overlayState.context || buildPayload());
      if (!afterRefresh.appConnected && afterRefresh.configured && afterRefresh.repoReady) {
        const linked = await autoLinkGithubInstallation(afterRefresh.repoFullName);
        if (linked) {
          await refreshGithubAppStatus();
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
        overlayState.statusMessage = "Acceso verificado. Ya puedes preparar el PR de configuracion.";
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
    await analyzeCodespaceProject();
  });
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
      await refreshGithubAppStatus();
      overlayState.statusMessage = "Estado de GitHub App actualizado.";
    } catch (error) {
      overlayState.statusMessage = `No se pudo actualizar estado GitHub App: ${String(error)}`;
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
    if (!isAdminSession()) return;
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
    if (!isAdminSession()) return;
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
  resetOverlayStateForOpen();

  await ensureOverlay();
  const cached = await loadTabSessionSnapshot(overlayState.context || buildPayload());
  if (cached) {
    applyTabSessionSnapshot(cached);
  }

  await chrome.storage.local.set({ [STORAGE_KEY_OVERLAY_PINNED]: true });
  renderOverlay();
  queueTabSessionSave();
  scheduleOverlayViewportSync(false);
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
  overlayState.setupRepoFullName = "";
  overlayState.setupWizardStep = 1;
  overlayState.githubAppBusy = false;
  overlayState.githubAppStatus = { ...EMPTY_GITHUB_APP_STATUS };
  overlayState.projectContextBusy = false;
  overlayState.projectContextStatus = { ...EMPTY_PROJECT_CONTEXT_STATUS };
  overlayState.projectContextHistory = [];
  overlayState.projectContextInsight = { ...EMPTY_PROJECT_CONTEXT_INSIGHT };
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

  const context = overlayState.context;
  const language = inferLanguage(context.filePath, context.languageHint);
  const goal = getLearningGoal(overlayState.selectedLearningGoal);
  const detectedRepo = inferRepoFromContext(context);
  if (!overlayState.setupRepoFullName && detectedRepo) {
    setSetupRepoFullName(detectedRepo);
  }

  overlayState.welcome = buildWelcomeText(context, goal);
  overlayState.ideas = buildIdeas(context, language, goal.id);
  overlayState.guide = buildGuide(goal.id, context);
  overlayState.statusMessage = buildMainStatus(context);

  try {
    await refreshGithubAppStatus();
  } catch {
    overlayState.githubAppStatus = { ...EMPTY_GITHUB_APP_STATUS };
  }

  overlayState.projectContextMessage = "";
  overlayState.projectContextError = "";

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

  if (overlayState.autoConfigEnabled) {
    try {
      await refreshProjectContextInsight();
    } catch {
      overlayState.projectContextInsight = { ...EMPTY_PROJECT_CONTEXT_INSIGHT };
    }
  } else {
    overlayState.projectContextInsight = {
      ...EMPTY_PROJECT_CONTEXT_INSIGHT,
      configured: true,
      repoFullName: getCurrentRepoFullName(),
      modelEnabled: false,
      summary: "Configuracion automatica desactivada.",
    };
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
      } else if (isAdminSession()) {
        await reloadAdminUsers();
      }
    } catch {
      overlayState.statusMessage = `${buildMainStatus(context)} Se usa apoyo local por ahora.`;
    }
  }

  if (isAdminSession()) {
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
