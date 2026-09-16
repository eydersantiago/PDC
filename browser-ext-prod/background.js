"use strict";

let lastGoogleAuthToken = "";
const GOOGLE_PROFILE_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];
const GOOGLE_CALENDAR_SCOPES = [
  ...GOOGLE_PROFILE_SCOPES,
  "https://www.googleapis.com/auth/calendar.events",
];

const CONTENT_SCRIPT_FILES = [
  "state/text.util.js",
  "state/session.state.js",
  "state/preferences.state.js",
  "overlay/content-context.js",
  "overlay/content-guidance.js",
  "overlay/content-session.js",
  "overlay/content-setup.js",
  "overlay/content-action-model.js",
  "services/http.service.js",
  "services/rag-courses.service.js",
  "services/admin-users.service.js",
  "services/vscode-sync.service.js",
  "services/project-context.service.js",
  "services/screenshot-ocr.service.js",
  "services/mentor.service.js",
  "services/auth.service.js",
  "services/operation-progress.service.js",
  "services/codespace-waiting-window.service.js",
  "services/codespaces.service.js",
  "services/github-app.service.js",
  "services/github-oauth.service.js",
  "services/campus-page.service.js",
  "services/campus-documents.service.js",
  "services/campus-calendar.service.js",
  "services/teacher-rag.service.js",
  "services/teacher-bitacora.service.js",
  "overlay/content-styles.js",
  "overlay/templates/welcome-view.template.js",
  "overlay/templates/auth-view.template.js",
  "overlay/templates/setup-view.template.js",
  "overlay/templates/main-view.template.js",
  "overlay/templates/list-item.template.js",
  "overlay/templates/shell.template.js",
  "overlay/content-markup.js",
  "overlay/render-payload-normalizers.js",
  "overlay/render-context-hub.js",
  "overlay/render-rag-sources.js",
  "overlay/render-vscode-panel.js",
  "overlay/render-admin-users.js",
  "overlay/render-settings.js",
  "overlay/render-session-flow.js",
  "overlay/content-render.js",
  "overlay/content-project.js",
  "overlay/overlay-viewport.js",
  "overlay/overlay-vscode-palette.js",
  "overlay/overlay-tab-session.js",
  "overlay/overlay-cross-tab-sync.js",
  "overlay/overlay-active-tab.js",
  "overlay/overlay-codespace-handoff.js",
  "overlay/overlay-actions.js",
  "overlay/overlay-elements.js",
  "overlay/overlay-listeners.js",
  "overlay/overlay-mount.js",
  "overlay/content-lifecycle.js",
];

function extractGoogleAuthToken(result) {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && typeof result.token === "string") {
  return result.token;
  }
  return "";
}

function getGoogleAuthToken(interactive = true, scopes = GOOGLE_PROFILE_SCOPES) {
  return new Promise((resolve, reject) => {
    if (!chrome.identity?.getAuthToken) {
      reject(new Error("Chrome Identity API no disponible."));
      return;
    }

    chrome.identity.getAuthToken({ interactive, scopes }, (result) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || "No se pudo autenticar con Google."));
        return;
      }

      const token = extractGoogleAuthToken(result);
      if (!token) {
        reject(new Error("Google no entrego un token de acceso."));
        return;
      }

      lastGoogleAuthToken = token;
      resolve(token);
    });
  });
}

function removeCachedGoogleAuthToken(token) {
  return new Promise((resolve) => {
    if (!chrome.identity?.removeCachedAuthToken || !token) {
      resolve();
      return;
    }

    chrome.identity.removeCachedAuthToken({ token }, () => {
      resolve();
    });
  });
}

async function clearGoogleAuthToken() {
  let token = lastGoogleAuthToken;

  if (!token) {
    try {
      token = await getGoogleAuthToken(false, GOOGLE_PROFILE_SCOPES);
    } catch {
      token = "";
    }
  }

  await removeCachedGoogleAuthToken(token);
  lastGoogleAuthToken = "";
}

async function createGoogleCalendarEvent(event) {
  const accessToken = await getGoogleAuthToken(true, GOOGLE_CALENDAR_SCOPES);
  const response = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(event || {}),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(json?.error?.message || `Google Calendar HTTP ${response.status}`));
  }

  return json;
}

async function authorizeGoogleCalendar() {
  await getGoogleAuthToken(true, GOOGLE_CALENDAR_SCOPES);
  return true;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ADACEEN_PING" });
    return;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: CONTENT_SCRIPT_FILES,
    });
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  try {
    await ensureContentScript(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: "ADACEEN_OPEN_OVERLAY" });
  } catch (error) {
    console.warn("[ADACEEN] No se pudo abrir el overlay en esta pagina.", error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ADACEEN_GOOGLE_AUTH") {
    getGoogleAuthToken(true)
      .then((accessToken) => sendResponse({ ok: true, accessToken }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ADACEEN_GOOGLE_CLEAR_TOKEN") {
    clearGoogleAuthToken()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ADACEEN_GOOGLE_CALENDAR_INSERT") {
    createGoogleCalendarEvent(message.event)
      .then((event) => sendResponse({ ok: true, event }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ADACEEN_GOOGLE_CALENDAR_AUTHORIZE") {
    authorizeGoogleCalendar()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type !== "ADACEEN_CAPTURE_VISIBLE_TAB") {
    return;
  }

  const windowId = Number(sender?.tab?.windowId);
  const handleCapture = (dataUrl) => {
    const runtimeError = chrome.runtime.lastError;
    if (runtimeError) {
      sendResponse({ ok: false, error: runtimeError.message || "No se pudo capturar la pantalla." });
      return;
    }
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
      sendResponse({ ok: false, error: "No se recibio imagen valida de la captura." });
      return;
    }

    sendResponse({ ok: true, dataUrl });
  };

  if (Number.isFinite(windowId) && windowId >= 0) {
    chrome.tabs.captureVisibleTab(windowId, { format: "png" }, handleCapture);
  } else {
    chrome.tabs.captureVisibleTab({ format: "png" }, handleCapture);
  }
  return true;
});
