"use strict";

function normalizeEmailForSessionValidation(value) {
  return toText(value).toLowerCase();
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

async function applyBackendAuthResponse(response, fallbackError = "No se pudo iniciar sesion.") {
  if (!response?.ok || !response?.session?.id) {
    throw new Error(String(response?.error || fallbackError));
  }

  overlayState.sessionId = response.session.id;
  overlayState.session = response.session;
  overlayState.policy = response.policy || { ...DEFAULT_POLICY };
  overlayState.telemetry = Array.isArray(response.telemetry) ? response.telemetry : [];
  overlayState.firstLoginConfirmationOpen = response.firstLogin === true;
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
  if (response.session?.user?.role === "student") {
    await ensureStudentCourseSelection({ forceOpen: false });
  } else {
    overlayState.studentCourseModalOpen = false;
  }
  overlayState.authError = "";
  await persistPreferences();
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

async function logoutFromBackend() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
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
  overlayState.firstLoginConfirmationOpen = false;
  overlayState.studentCourseModalOpen = false;
  overlayState.studentCourseState = { ...EMPTY_STUDENT_COURSE_STATE };
  overlayState.campusCourseAccess = { ...EMPTY_CAMPUS_COURSE_ACCESS_STATE };
  overlayState.authError = "";
  await persistPreferences();
}
