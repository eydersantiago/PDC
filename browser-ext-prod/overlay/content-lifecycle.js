// ADACEEN | Capa 5 - Ciclo de vida: refresco de la sesion de tutoria y arranque del content script.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const MENTOR_FALLBACK_DELAY_MS = 120000;
let mentorFallbackTimer = 0;

function buildMentorFallbackKey(context) {
  return [
    toText(overlayState.sessionId),
    toText(context?.url || location.href),
    toText(context?.filePath),
    toText(context?.selection).slice(0, 80),
  ].join("|");
}

function clearMentorFallbackTimer() {
  if (!mentorFallbackTimer) return;
  window.clearTimeout(mentorFallbackTimer);
  mentorFallbackTimer = 0;
}

function scheduleMentorFallbackStatus(context, startedAt) {
  const fallbackKey = buildMentorFallbackKey(context);
  const elapsedMs = Date.now() - Number(startedAt || Date.now());
  const remainingMs = MENTOR_FALLBACK_DELAY_MS - elapsedMs;

  overlayState.statusMessage = `${buildMainStatus(context)} Cargando apoyo del tutor...`;
  clearMentorFallbackTimer();

  mentorFallbackTimer = window.setTimeout(() => {
    mentorFallbackTimer = 0;
    const currentContext = getPageContext();
    if (buildMentorFallbackKey(currentContext) !== fallbackKey) return;
    if (overlayState.loading || toText(overlayState.mentorSummary)) return;

    overlayState.statusMessage = `${buildMainStatus(currentContext)} Se usa apoyo local por ahora.`;
    renderOverlay();
  }, Math.max(250, remainingMs));
}

async function refreshMentorSession() {
  if (!hasActiveSession()) {
    renderOverlay();
    return;
  }

  clearMentorFallbackTimer();
  overlayState.loading = true;
  overlayState.context = buildPayload();
  overlayState.statusMessage = "Leyendo contexto actual...";
  renderOverlay();

  if (overlayState.session?.user?.role === "student") {
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
  if (context.pageType === "codespace") {
    overlayState.analysisUnlocked = true;
  }

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

  if (context.pageType === "codespace") {
    await refreshVscodeSyncState({ silent: true }).catch(() => {});
  } else {
    overlayState.vscodeSyncState = { ...EMPTY_VSCODE_SYNC_STATE };
  }

  overlayState.ragSources = [];
  if (overlayState.assistantEnabled && context.pageContext !== "unknown" && normalizeBaseUrl(overlayState.backendUrl)) {
    const mentorRequestStartedAt = Date.now();
    try {
      const remote = await requestBackendMentor(context, language);
      clearMentorFallbackTimer();
      if (remote.ideas.length > 0) overlayState.ideas = remote.ideas;
      if (remote.guide.length > 0) overlayState.guide = remote.guide;
      if (remote.welcome) overlayState.welcome = remote.welcome;
      overlayState.mentorSummary = remote.summary || "";
      overlayState.activeRagCourseCode = remote.ragCourseCode || "";
      if (remote.summary) overlayState.statusMessage = remote.summary;
      overlayState.ragSources = Array.isArray(remote.ragSources) ? remote.ragSources : [];
      if (isTeacherSession()) {
        await reloadPolicyAndTelemetry();
      }
    } catch {
      scheduleMentorFallbackStatus(context, mentorRequestStartedAt);
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
  queueTabSessionSave();
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

// ---- Arranque del content script ----

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
bindGithubOAuthCallbackListener();
restorePinnedOverlay().catch(() => {});
syncFromStorageSnapshot({ force: true }).catch(() => {});
bindActiveTabSyncListeners();
refreshActiveTabStateFromBackend({ force: true }).catch(() => {});
