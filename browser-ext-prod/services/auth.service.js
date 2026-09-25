// ADACEEN | Capa 3 - Servicios: login/logout, sesion compartida entre pestanas y privacidad.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

function normalizeEmailForSessionValidation(value) {
  return toText(value).toLowerCase();
}

function getPrivacyAcceptanceKeyForSession(session = overlayState.session) {
  const user = session?.user;
  return toText(user?.id || user?.email).toLowerCase();
}

function hasAcceptedPrivacyForSession(session = overlayState.session) {
  const key = getPrivacyAcceptanceKeyForSession(session);
  return !!key && overlayState.privacyAcceptedByUser?.[key] === true;
}

async function markPrivacyAcceptedForCurrentSession() {
  const key = getPrivacyAcceptanceKeyForSession();
  if (!key) return false;
  overlayState.privacyAcceptedByUser = {
    ...(overlayState.privacyAcceptedByUser || {}),
    [key]: true,
  };
  overlayState.firstLoginConfirmationOpen = false;
  await persistPreferences();
  return true;
}

async function ensureNoConflictingSessionBeforeLogin(email) {
  const requestedEmail = normalizeEmailForSessionValidation(email);
  if (!requestedEmail) return;

  if (overlayState.sessionId && !overlayState.session) {
    try {
      await fetchCurrentSession();
    } catch {}
  }

  const activeEmail = normalizeEmailForSessionValidation(overlayState.session?.user?.email);
  if (overlayState.sessionId && activeEmail && activeEmail !== requestedEmail) {
    throw new Error("Primero tienes que salir de la sesion activa.");
  }
}

function sendRuntimeMessageToBackground(message) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
      reject(new Error("Runtime de la extension no disponible."));
      return;
    }

    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || "No se pudo comunicar con la extension."));
        return;
      }
      resolve(response || {});
    });
  });
}

async function requestGoogleAccessTokenFromBackground() {
  const response = await sendRuntimeMessageToBackground({ type: "ADACEEN_GOOGLE_AUTH" });
  const accessToken = toText(response?.accessToken);
  if (!response?.ok || !accessToken) {
    throw new Error(toText(response?.error) || "No se pudo iniciar sesion con Google.");
  }
  return accessToken;
}

async function clearGoogleAccessTokenFromBackground() {
  try {
    await sendRuntimeMessageToBackground({ type: "ADACEEN_GOOGLE_CLEAR_TOKEN" });
  } catch {}
}

function buildSharedSessionSnapshot() {
  const sessionId = toText(overlayState.sessionId || overlayState.session?.id);
  if (!sessionId || !overlayState.session || typeof overlayState.session !== "object") {
    return null;
  }

  return {
    sessionId,
    backendUrl: normalizeBaseUrl(overlayState.backendUrl) || DEFAULT_BACKEND_URL,
    session: overlayState.session,
    policy: overlayState.policy || { ...DEFAULT_POLICY },
    telemetry: Array.isArray(overlayState.telemetry) ? overlayState.telemetry.slice(0, 50) : [],
    updatedAt: Date.now(),
  };
}

async function publishSharedSessionSnapshot() {
  if (!isExtensionRuntimeReady()) return false;

  const snapshot = buildSharedSessionSnapshot();
  if (!snapshot) return false;

  try {
    await chrome.storage.local.set({ [STORAGE_KEY_ACTIVE_SESSION_SNAPSHOT]: snapshot });
    return true;
  } catch {
    return false;
  }
}

async function clearSharedSessionSnapshot() {
  if (!isExtensionRuntimeReady()) return false;

  try {
    await chrome.storage.local.remove([STORAGE_KEY_ACTIVE_SESSION_SNAPSHOT]);
    return true;
  } catch {
    return false;
  }
}

async function applyBackendAuthResponse(response, fallbackError = "No se pudo iniciar sesion.") {
  if (!response?.ok || !response?.session?.id) {
    throw new Error(String(response?.error || fallbackError));
  }

  overlayState.sessionId = response.session.id;
  overlayState.session = response.session;
  overlayState.policy = response.policy || { ...DEFAULT_POLICY };
  overlayState.telemetry = Array.isArray(response.telemetry) ? response.telemetry : [];
  overlayState.behaviorMetrics = [];
  overlayState.firstLoginConfirmationOpen = response.firstLogin === true || !hasAcceptedPrivacyForSession(response.session);
  if (response.session?.user?.role === "student") {
    const assigned = normalizeCourseCodesUi(response.session.user.assignedCourseCodes, true);
    const selected = assigned.length === 1
      ? assigned[0]
      : (assigned.includes(overlayState.studentCourseState?.selectedCourseCode)
        ? overlayState.studentCourseState.selectedCourseCode
        : assigned[0] || "FPOO");
    overlayState.studentCourseState = {
      ...(overlayState.studentCourseState || EMPTY_STUDENT_COURSE_STATE),
      selectedCourseCode: selected,
    };
    overlayState.session.user.activeCourseCode = selected;
  } else {
    overlayState.studentCourseModalOpen = false;
  }
  overlayState.authError = "";
  await persistPreferences();
  await publishSharedSessionSnapshot();
}

async function fetchCurrentSession() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) return false;

  const response = await fetchJsonWithTimeout(`${baseUrl}/api/auth/me`, {
    method: "GET",
    headers: buildApiHeaders(),
  });

  if (!response?.ok || !response?.session) return false;

  overlayState.session = response.session;
  overlayState.policy = response.policy || { ...DEFAULT_POLICY };
  overlayState.telemetry = Array.isArray(response.telemetry) ? response.telemetry : [];
  overlayState.behaviorMetrics = [];
  overlayState.firstLoginConfirmationOpen = !hasAcceptedPrivacyForSession(response.session);
  if (response.session?.user?.role === "student") {
    await ensureStudentCourseSelection({ forceOpen: false });
  } else {
    overlayState.studentCourseModalOpen = false;
  }
  overlayState.authError = "";
  await persistPreferences();
  await publishSharedSessionSnapshot();
  return true;
}

async function loginToBackend(email, password) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl) {
    throw new Error("Configura primero la URL del backend.");
  }

  await ensureNoConflictingSessionBeforeLogin(email);

  const response = await fetchJsonWithTimeout(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: buildApiHeaders(),
    body: JSON.stringify({ email, password }),
  });

  await applyBackendAuthResponse(response, "No se pudo iniciar sesion.");
}

async function loginToBackendWithGoogle() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl) {
    throw new Error("Configura primero la URL del backend.");
  }

  const accessToken = await requestGoogleAccessTokenFromBackground();
  const response = await fetchJsonWithTimeout(`${baseUrl}/api/auth/google-login`, {
    method: "POST",
    headers: buildApiHeaders(),
    body: JSON.stringify({ accessToken }),
  });

  await applyBackendAuthResponse(response, "No se pudo iniciar sesion con Google.");
}

// Codigo de un solo uso para vincular VS Code sin copiar la sesion
// (docs/arquitectura/acceso-simplificado.md, 2.1). Solo con la sesion del navegador.
// El codigo no se registra en logs: el log de peticiones guarda ruta y estado, no el cuerpo.
const EDITOR_PAIRING_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

async function requestEditorPairingCode(timeoutMs = 8000) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    throw new Error("Inicia sesion en ADACEEN para conectar VS Code.");
  }
  const response = await fetchJsonWithTimeout(`${baseUrl}/api/auth/editor/pairing-code`, {
    method: "POST",
    headers: buildApiHeaders(),
    body: JSON.stringify({}),
  }, timeoutMs);
  const code = toText(response?.code).toUpperCase();
  if (!response?.ok || !EDITOR_PAIRING_CODE_PATTERN.test(code)) {
    throw new Error("El backend no entrego un codigo de emparejamiento valido.");
  }
  const ttlSeconds = Number(response?.ttlSeconds) > 0 ? Number(response.ttlSeconds) : 600;
  return { code, expiresAt: toText(response?.expiresAt), ttlSeconds };
}

// Backend anterior sin emparejamiento: la ruta no existe (404). Solo entonces se usa el camino
// anterior de copiar la sesion del navegador; un fallo pasajero no debe llevar a copiarla.
function isEditorPairingUnsupported(error) {
  return Number(error?.status) === 404;
}

async function logoutFromBackend() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const loggedOutUserId = getCurrentUserId();
  // Lo registrado con la sesion sale con su cabecera x-session-id antes de cerrarla
  // (como maximo 2 s: un backend lento no debe retrasar el cierre de sesion).
  await Promise.race([
    flushTelemetryQueueNow().catch(() => false),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  try {
    if (baseUrl && overlayState.sessionId) {
      await fetchJsonWithTimeout(`${baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: buildApiHeaders(),
        body: JSON.stringify({}),
      });
    }
  } catch {}

  await clearGoogleAccessTokenFromBackground();
  overlayState.sessionId = "";
  overlayState.session = null;
  overlayState.policy = { ...DEFAULT_POLICY };
  overlayState.telemetry = [];
  overlayState.behaviorMetrics = [];
  overlayState.firstLoginConfirmationOpen = false;
  overlayState.studentCourseModalOpen = false;
  overlayState.studentCourseState = { ...EMPTY_STUDENT_COURSE_STATE };
  overlayState.campusCourseAccess = { ...EMPTY_CAMPUS_COURSE_ACCESS_STATE };
  overlayState.authError = "";
  await persistPreferences();
  await clearSharedSessionSnapshot();
  // El backend tambien desvincula VS Code al salir: el proximo "Abrir mi editor" renueva
  // la sesion de la VM con prepare (docs/arquitectura/acceso-simplificado.md, seccion 1).
  if (loggedOutUserId && typeof markSavedEditorsNeedSessionRefresh === "function") {
    await markSavedEditorsNeedSessionRefresh(loggedOutUserId).catch(() => false);
  }
  // Un codigo de dispositivo pendiente no sobrevive al cierre de sesion (equipos compartidos).
  if (typeof clearDeviceCodeHandoff === "function") {
    await clearDeviceCodeHandoff().catch(() => {});
  }
}
