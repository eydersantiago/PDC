// ADACEEN | Capa 1 - Estado: carga y persistencia de preferencias en chrome.storage.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
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
  overlayState.editorByUser = {};
  overlayState.editorChoiceByUser = {};
  overlayState.minimized = false;
}

function resolveStoredBackendUrl(value) {
  const clean = normalizeBaseUrl(value);
  // Solo se aceptan URL http/https (A12.8): un valor manipulado en storage no debe
  // terminar como base de enlaces o peticiones.
  return clean && toSafeHttpUrl(clean) ? clean : DEFAULT_BACKEND_URL;
}

// Editores en la nube guardados (tunel). Solo se aceptan enlaces http/https a vscode.dev/tunnel
// (A12.8) y claves "<userId>:<owner/repo>"; lo demas se descarta al leer.
const SAVED_EDITOR_MAX_ENTRIES = 40;

function normalizeSavedEditorMap(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const entries = [];
  for (const [key, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const separator = key.indexOf(":");
    const userId = separator > 0 ? key.slice(0, separator) : "";
    const repoFullName = parseRepoFullName(raw.repoFullName);
    const webUrl = toSafeHttpUrl(raw.webUrl);
    if (!userId || !repoFullName || !/^https:\/\/(?:insiders\.)?vscode\.dev\/tunnel\//i.test(webUrl)) continue;
    entries.push([`${userId}:${repoFullName.toLowerCase()}`, {
      repoFullName,
      webUrl,
      provider: "tunnel",
      savedAt: toText(raw.savedAt),
      // Tras cerrar sesion el backend desactiva las sesiones de VS Code: el siguiente
      // "Abrir mi editor" pasa por prepare, que escribe una sesion nueva en la VM.
      needsSessionRefresh: raw.needsSessionRefresh === true,
      // Ultimo prepare que escribio la sesion de VS Code en la VM (savedAt cambia en cada
      // apertura). Pasados 7 dias, "Abrir mi editor" vuelve a pasar por prepare.
      sessionWrittenAt: toText(raw.sessionWrittenAt),
    }]);
  }
  entries
    .sort((a, b) => toText(b[1].savedAt).localeCompare(toText(a[1].savedAt)))
    .slice(0, SAVED_EDITOR_MAX_ENTRIES)
    .forEach(([key, record]) => {
      out[key] = record;
    });
  return out;
}

// Ultima eleccion de editor por usuario: solo "local_vscode" (VS Code de este equipo) o
// "cloud" (editor en la nube); lo demas se descarta al leer.
const EDITOR_CHOICES = ["local_vscode", "cloud"];

function normalizeEditorChoiceMap(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [userId, choice] of Object.entries(value)) {
    if (toText(userId) && EDITOR_CHOICES.includes(choice)) out[userId] = choice;
  }
  return out;
}

function isValidAdaceenClientId(value) {
  return /^[A-Za-z0-9_-]{8,80}$/.test(toText(value));
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
      STORAGE_KEY_OVERLAY_MINIMIZED,
      STORAGE_KEY_CLIENT_ID,
      STORAGE_KEY_EDITOR_BY_USER,
      STORAGE_KEY_EDITOR_CHOICE_BY_USER,
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
    // Se escribe aparte (saveTunnelEditor en workspace.service.js), no en persistPreferences:
    // asi una pestana con el mapa viejo no borra el editor que guardo otra.
    overlayState.editorByUser = normalizeSavedEditorMap(stored[STORAGE_KEY_EDITOR_BY_USER]);
    // Tambien se escribe aparte (rememberEditorChoice en workspace.service.js).
    overlayState.editorChoiceByUser = normalizeEditorChoiceMap(stored[STORAGE_KEY_EDITOR_CHOICE_BY_USER]);
    overlayState.minimized = stored[STORAGE_KEY_OVERLAY_MINIMIZED] === true;
    if (isValidAdaceenClientId(stored[STORAGE_KEY_CLIENT_ID])) {
      overlayState.clientId = toText(stored[STORAGE_KEY_CLIENT_ID]);
    }
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
      [STORAGE_KEY_OVERLAY_MINIMIZED]: overlayState.minimized === true,
    });
    return true;
  } catch {
    return false;
  }
}
