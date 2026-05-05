"use strict";

async function loadPreferences() {
  if (preferencesLoaded) return;

  try {
    const stored = await chrome.storage.local.get([
      STORAGE_KEY_ENABLED,
      STORAGE_KEY_BACKEND_URL,
      STORAGE_KEY_LEARNING_GOAL,
      STORAGE_KEY_SESSION_ID,
      STORAGE_KEY_PROJECT_CONSENT_BY_USER,
      STORAGE_KEY_SETUP_DONE_BY_USER,
      STORAGE_KEY_AUTO_CONFIG_ENABLED,
    ]);

    overlayState.assistantEnabled = typeof stored[STORAGE_KEY_ENABLED] === "boolean"
      ? stored[STORAGE_KEY_ENABLED]
      : true;
    overlayState.backendUrl = normalizeBaseUrl(stored[STORAGE_KEY_BACKEND_URL]) || DEFAULT_BACKEND_URL;
    overlayState.selectedLearningGoal = LEARNING_GOALS.some((goal) => goal.id === stored[STORAGE_KEY_LEARNING_GOAL])
      ? stored[STORAGE_KEY_LEARNING_GOAL]
      : DEFAULT_LEARNING_GOAL;
    overlayState.sessionId = toText(stored[STORAGE_KEY_SESSION_ID]);
    overlayState.autoConfigEnabled = typeof stored[STORAGE_KEY_AUTO_CONFIG_ENABLED] === "boolean"
      ? stored[STORAGE_KEY_AUTO_CONFIG_ENABLED]
      : true;
    overlayState.projectConsentByUser =
      stored[STORAGE_KEY_PROJECT_CONSENT_BY_USER]
      && typeof stored[STORAGE_KEY_PROJECT_CONSENT_BY_USER] === "object"
        ? stored[STORAGE_KEY_PROJECT_CONSENT_BY_USER]
        : {};
    overlayState.setupDoneByUser =
      stored[STORAGE_KEY_SETUP_DONE_BY_USER]
      && typeof stored[STORAGE_KEY_SETUP_DONE_BY_USER] === "object"
        ? stored[STORAGE_KEY_SETUP_DONE_BY_USER]
        : {};
  } catch {
    overlayState.assistantEnabled = true;
    overlayState.backendUrl = DEFAULT_BACKEND_URL;
    overlayState.selectedLearningGoal = DEFAULT_LEARNING_GOAL;
    overlayState.autoConfigEnabled = true;
    overlayState.sessionId = "";
    overlayState.session = null;
    overlayState.policy = { ...DEFAULT_POLICY };
    overlayState.projectConsentByUser = {};
    overlayState.setupDoneByUser = {};
  }

  preferencesLoaded = true;
}

async function persistPreferences() {
  await chrome.storage.local.set({
    [STORAGE_KEY_ENABLED]: overlayState.assistantEnabled,
    [STORAGE_KEY_BACKEND_URL]: overlayState.backendUrl,
    [STORAGE_KEY_LEARNING_GOAL]: overlayState.selectedLearningGoal,
    [STORAGE_KEY_SESSION_ID]: overlayState.sessionId,
    [STORAGE_KEY_PROJECT_CONSENT_BY_USER]: overlayState.projectConsentByUser,
    [STORAGE_KEY_SETUP_DONE_BY_USER]: overlayState.setupDoneByUser,
    [STORAGE_KEY_AUTO_CONFIG_ENABLED]: overlayState.autoConfigEnabled,
  });
}
