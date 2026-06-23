"use strict";

function isExtensionRuntimeReady() {
  return typeof chrome !== "undefined" && !!chrome.runtime?.id && !!chrome.storage?.local;
}

function applyPreferenceDefaults() {
  overlayState.assistantEnabled = true;
  overlayState.backendUrl = DEFAULT_BACKEND_URL;
  overlayState.selectedLearningGoal = DEFAULT_LEARNING_GOAL;
  overlayState.studentCourseState = { ...EMPTY_STUDENT_COURSE_STATE };
  overlayState.campusCourseAccess = { ...EMPTY_CAMPUS_COURSE_ACCESS_STATE };
  overlayState.autoConfigEnabled = true;
  overlayState.sessionId = "";
  overlayState.session = null;
  overlayState.policy = { ...DEFAULT_POLICY };
  overlayState.privacyAcceptedByUser = {};
  overlayState.projectConsentByUser = {};
  overlayState.setupDoneByUser = {};
}

function resolveStoredBackendUrl(value) {
  const clean = normalizeBaseUrl(value);
  if (!clean || LEGACY_LOCAL_BACKEND_URLS.has(clean)) return DEFAULT_BACKEND_URL;
  return clean;
}

async function loadPreferences() {
  if (preferencesLoaded) return;
  if (!isExtensionRuntimeReady()) {
    applyPreferenceDefaults();
    preferencesLoaded = true;
    return;
  }

  try {
    const stored = await chrome.storage.local.get([
      STORAGE_KEY_ENABLED,
      STORAGE_KEY_BACKEND_URL,
      STORAGE_KEY_LEARNING_GOAL,
      STORAGE_KEY_SELECTED_RAG_COURSE,
      STORAGE_KEY_SESSION_ID,
      STORAGE_KEY_PRIVACY_ACCEPTED_BY_USER,
      STORAGE_KEY_PROJECT_CONSENT_BY_USER,
      STORAGE_KEY_SETUP_DONE_BY_USER,
      STORAGE_KEY_AUTO_CONFIG_ENABLED,
    ]);

    overlayState.assistantEnabled = typeof stored[STORAGE_KEY_ENABLED] === "boolean"
      ? stored[STORAGE_KEY_ENABLED]
      : true;
    overlayState.backendUrl = resolveStoredBackendUrl(stored[STORAGE_KEY_BACKEND_URL]);
    overlayState.selectedLearningGoal = LEARNING_GOALS.some((goal) => goal.id === stored[STORAGE_KEY_LEARNING_GOAL])
      ? stored[STORAGE_KEY_LEARNING_GOAL]
      : DEFAULT_LEARNING_GOAL;
    overlayState.studentCourseState = {
      ...EMPTY_STUDENT_COURSE_STATE,
      selectedCourseCode: toText(stored[STORAGE_KEY_SELECTED_RAG_COURSE]) || "FPOO",
    };
    overlayState.sessionId = toText(stored[STORAGE_KEY_SESSION_ID]);
    overlayState.privacyAcceptedByUser =
      stored[STORAGE_KEY_PRIVACY_ACCEPTED_BY_USER]
      && typeof stored[STORAGE_KEY_PRIVACY_ACCEPTED_BY_USER] === "object"
      && !Array.isArray(stored[STORAGE_KEY_PRIVACY_ACCEPTED_BY_USER])
        ? stored[STORAGE_KEY_PRIVACY_ACCEPTED_BY_USER]
        : {};
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
    applyPreferenceDefaults();
  }

  preferencesLoaded = true;
}

async function persistPreferences() {
  if (!isExtensionRuntimeReady()) return false;

  try {
    await chrome.storage.local.set({
      [STORAGE_KEY_ENABLED]: overlayState.assistantEnabled,
      [STORAGE_KEY_BACKEND_URL]: overlayState.backendUrl,
      [STORAGE_KEY_LEARNING_GOAL]: overlayState.selectedLearningGoal,
      [STORAGE_KEY_SELECTED_RAG_COURSE]: overlayState.studentCourseState?.selectedCourseCode || "FPOO",
      [STORAGE_KEY_SESSION_ID]: overlayState.sessionId,
      [STORAGE_KEY_PRIVACY_ACCEPTED_BY_USER]: overlayState.privacyAcceptedByUser,
      [STORAGE_KEY_PROJECT_CONSENT_BY_USER]: overlayState.projectConsentByUser,
      [STORAGE_KEY_SETUP_DONE_BY_USER]: overlayState.setupDoneByUser,
      [STORAGE_KEY_AUTO_CONFIG_ENABLED]: overlayState.autoConfigEnabled,
    });
    return true;
  } catch {
    return false;
  }
}
