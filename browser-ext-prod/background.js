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

// ---- Google sin chrome.identity.getAuthToken (Firefox) ----
// Firefox no implementa getAuthToken, pero si launchWebAuthFlow y getRedirectURL. Con ellos se
// hace el flujo implicito de Google (response_type=token): la ventana de Google vuelve a
// https://<hash-del-id>.extensions.allizom.org/#access_token=...&expires_in=... y el token se
// guarda en chrome.storage.local con su vencimiento (el background de Firefox es una pagina de
// eventos y pierde la memoria). El backend verifica ese access_token igual que el de Chrome
// (tokeninfo + userinfo), asi que no hace falta id_token. El cliente OAuth es de tipo
// «Aplicacion web» y lo pone el empaquetador en el manifest de Firefox
// (adaceenGoogleWebClientId, desde GOOGLE_WEB_CLIENT_ID; docs/operacion/google-oauth-firefox.md).
// Chrome sigue con getAuthToken: este camino solo entra cuando getAuthToken no existe.
const GOOGLE_WEB_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
// select_account: en un equipo compartido el estudiante elige la cuenta en cada inicio de sesion.
const GOOGLE_WEB_AUTH_PROMPT = "select_account";
const GOOGLE_WEB_TOKEN_STORAGE_KEY = "adaceen.googleWebToken";
// Vida que se asume si Google no manda expires_in, y margen para no entregar un token a punto de vencer.
const GOOGLE_WEB_TOKEN_DEFAULT_TTL_S = 3600;
const GOOGLE_WEB_TOKEN_SAFETY_MS = 60 * 1000;
const GOOGLE_WEB_CLIENT_MISSING_MESSAGE = "Inicio de sesion con Google no configurado en este paquete de la extension.";
const GOOGLE_IDENTITY_UNAVAILABLE_MESSAGE = "Chrome Identity API no disponible.";

const CONTENT_SCRIPT_FILES = [
  "state/session.state.js",
  "state/preferences.state.js",
  "overlay/content-context.js",
  "overlay/content-guidance.js",
  "overlay/content-setup.js",
  "overlay/content-setup-actions.js",
  "services/backend.service.js",
  "services/backend-courses.service.js",
  "services/backend-quiz.service.js",
  "services/backend-rag.service.js",
  "services/backend-admin.service.js",
  "services/backend-vscode.service.js",
  "services/backend-project.service.js",
  "services/telemetry.service.js",
  "services/auth.service.js",
  "services/github.service.js",
  "services/github-auth.service.js",
  "services/codespace-waiting-content.service.js",
  "services/codespace-waiting.service.js",
  "services/workspace.service.js",
  "services/campus.service.js",
  "services/campus-documents.service.js",
  "services/campus-calendar.service.js",
  "services/course-agenda.service.js",
  "services/google-calendar.service.js",
  "services/bitacora.service.js",
  "overlay/styles/base.styles.js",
  "overlay/styles/workspace.styles.js",
  "overlay/styles/shell.styles.js",
  "overlay/styles/home.styles.js",
  "overlay/styles/tutor.styles.js",
  "overlay/styles/settings.styles.js",
  "overlay/styles/tabs.styles.js",
  "overlay/styles/students.styles.js",
  "overlay/styles/rag.styles.js",
  "overlay/styles/users.styles.js",
  "overlay/styles/student-detail.styles.js",
  "overlay/styles/a11y-features.styles.js",
  "overlay/styles/quizzes.styles.js",
  "overlay/styles/bitacora.styles.js",
  "overlay/styles/agenda.styles.js",
  "overlay/styles/responsive.styles.js",
  "overlay/content-styles.js",
  "overlay/templates/welcome-view.template.js",
  "overlay/templates/auth-view.template.js",
  "overlay/templates/setup-view.template.js",
  "overlay/templates/main-view.template.js",
  "overlay/templates/guide-list.template.js",
  "overlay/templates/idea-list.template.js",
  "overlay/templates/tab-panels.template.js",
  "overlay/templates/teacher-pages.template.js",
  "overlay/templates/settings-panel.template.js",
  "overlay/templates/shell.template.js",
  "overlay/content-markup.js",
  "overlay/content-a11y.js",
  "overlay/content-render.js",
  "overlay/content-home.js",
  "overlay/content-tutor.js",
  "overlay/content-students.js",
  "overlay/content-users.js",
  "overlay/content-rag.js",
  "overlay/content-rag-page.js",
  "overlay/content-quizzes.js",
  "overlay/content-bitacora.js",
  "overlay/content-agenda.js",
  "overlay/content-settings.js",
  "overlay/content-auth.js",
  "overlay/content-vscode.js",
  "overlay/content-project.js",
  "overlay/content-project-context.js",
  "overlay/content-window.js",
  "overlay/content-tab-session.js",
  "overlay/content-active-tab.js",
  "overlay/content-editor-open.js",
  "overlay/content-lifecycle.js",
];

function extractGoogleAuthToken(result) {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && typeof result.token === "string") {
    return result.token;
  }
  return "";
}

function hasChromeGetAuthToken() {
  return typeof chrome.identity?.getAuthToken === "function";
}

function hasGoogleWebAuthFlow() {
  return typeof chrome.identity?.launchWebAuthFlow === "function"
    && typeof chrome.identity?.getRedirectURL === "function";
}

function getGoogleWebClientId() {
  try {
    const manifest = chrome.runtime?.getManifest?.() || {};
    return String(manifest.adaceenGoogleWebClientId || "").trim();
  } catch {
    return "";
  }
}

// state del flujo OAuth: la respuesta de Google tiene que traer el mismo valor.
function createGoogleWebAuthState() {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID().replace(/-/g, "");
  if (typeof webCrypto?.getRandomValues === "function") {
    const bytes = webCrypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function buildGoogleWebAuthUrl({ clientId, redirectUri, scopes, state, prompt }) {
  const url = new URL(GOOGLE_WEB_AUTH_URL);
  url.searchParams.set("response_type", "token");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", prompt);
  // Un token nuevo conserva los permisos ya concedidos (perfil + Calendar en un solo token).
  url.searchParams.set("include_granted_scopes", "true");
  return url.toString();
}

// Google responde en el fragmento (#access_token=...&expires_in=...&scope=...&state=...) o con
// error=... (en el fragmento o en la query). Devuelve { accessToken, expiresAt, scopes }.
function parseGoogleWebAuthResponse(responseUrl, expectedState, now = Date.now()) {
  const raw = String(responseUrl || "");
  const hashIndex = raw.indexOf("#");
  const fragment = hashIndex >= 0 ? raw.slice(hashIndex + 1) : "";
  const queryIndex = raw.indexOf("?");
  const query = queryIndex >= 0 ? raw.slice(queryIndex + 1, hashIndex >= 0 ? hashIndex : raw.length) : "";
  const params = new URLSearchParams(fragment);
  const error = params.get("error") || new URLSearchParams(query).get("error");
  if (error) {
    throw new Error(`Google no autorizo el acceso (${error}).`);
  }
  if (expectedState && params.get("state") !== expectedState) {
    throw new Error("La respuesta de Google no corresponde a esta solicitud.");
  }
  const accessToken = String(params.get("access_token") || "").trim();
  if (!accessToken) {
    throw new Error("Google no entrego un token de acceso.");
  }
  const expiresIn = Number(params.get("expires_in"));
  const ttlSeconds = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : GOOGLE_WEB_TOKEN_DEFAULT_TTL_S;
  const scopes = String(params.get("scope") || "").split(/\s+/).filter(Boolean);
  return { accessToken, expiresAt: now + ttlSeconds * 1000, scopes };
}

async function readGoogleWebTokenCache() {
  try {
    const stored = await chrome.storage.local.get(GOOGLE_WEB_TOKEN_STORAGE_KEY);
    const entry = stored?.[GOOGLE_WEB_TOKEN_STORAGE_KEY];
    if (!entry || typeof entry !== "object" || typeof entry.accessToken !== "string") return null;
    return {
      accessToken: entry.accessToken,
      expiresAt: Number(entry.expiresAt) || 0,
      scopes: Array.isArray(entry.scopes) ? entry.scopes.map(String) : [],
    };
  } catch {
    return null;
  }
}

async function writeGoogleWebTokenCache(entry) {
  try {
    await chrome.storage.local.set({ [GOOGLE_WEB_TOKEN_STORAGE_KEY]: entry });
  } catch (error) {
    console.warn("[ADACEEN] No se pudo guardar el token de Google.", error);
  }
}

async function clearGoogleWebTokenCache() {
  try {
    await chrome.storage.local.remove(GOOGLE_WEB_TOKEN_STORAGE_KEY);
  } catch {}
}

function isGoogleWebTokenUsable(entry, scopes, now = Date.now()) {
  if (!entry?.accessToken) return false;
  if (entry.expiresAt - GOOGLE_WEB_TOKEN_SAFETY_MS <= now) return false;
  return scopes.every((scope) => entry.scopes.includes(scope));
}

// Equivalente de getAuthToken con launchWebAuthFlow. Sin interactive solo sirve el cache vigente.
async function getGoogleWebAuthToken(interactive, scopes) {
  const cached = await readGoogleWebTokenCache();
  if (isGoogleWebTokenUsable(cached, scopes)) {
    lastGoogleAuthToken = cached.accessToken;
    return cached.accessToken;
  }
  if (!interactive) {
    throw new Error("No hay un token de Google vigente.");
  }
  const clientId = getGoogleWebClientId();
  if (!clientId) {
    console.warn("[ADACEEN] Sin chrome.identity.getAuthToken y sin adaceenGoogleWebClientId en el manifest: no hay login con Google (GOOGLE_WEB_CLIENT_ID al empaquetar).");
    throw new Error(GOOGLE_WEB_CLIENT_MISSING_MESSAGE);
  }

  const state = createGoogleWebAuthState();
  const url = buildGoogleWebAuthUrl({
    clientId,
    redirectUri: chrome.identity.getRedirectURL(),
    scopes,
    state,
    prompt: GOOGLE_WEB_AUTH_PROMPT,
  });
  let responseUrl = "";
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  } catch (error) {
    // Firefox: "User cancelled or denied access." cuando se cierra la ventana.
    throw new Error(String(error?.message || error || "No se pudo autenticar con Google."));
  }

  const entry = parseGoogleWebAuthResponse(responseUrl, state);
  // Si Google no lista los permisos concedidos, se asumen los pedidos.
  if (!entry.scopes.length) entry.scopes = [...scopes];
  await writeGoogleWebTokenCache(entry);
  lastGoogleAuthToken = entry.accessToken;
  return entry.accessToken;
}

function getGoogleAuthToken(interactive = true, scopes = GOOGLE_PROFILE_SCOPES) {
  if (!hasChromeGetAuthToken()) {
    if (hasGoogleWebAuthFlow()) return getGoogleWebAuthToken(interactive, scopes);
    return Promise.reject(new Error(GOOGLE_IDENTITY_UNAVAILABLE_MESSAGE));
  }

  return new Promise((resolve, reject) => {
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
  if (!hasChromeGetAuthToken()) {
    // Firefox: el equivalente de removeCachedAuthToken es borrar el token guardado.
    await clearGoogleWebTokenCache();
    lastGoogleAuthToken = "";
    return;
  }

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

const GOOGLE_CALENDAR_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
// Campos de la lista de eventos que usa la extension (agenda del curso, 0.7.17).
const GOOGLE_CALENDAR_LIST_FIELDS = "items(id,summary,start,end,status,transparency,htmlLink,extendedProperties/private)";
const GOOGLE_CALENDAR_LIST_PARAMS = new Set(["privateExtendedProperty", "timeMin", "timeMax", "singleEvents", "orderBy", "maxResults"]);

async function googleCalendarRequest(url, options = {}) {
  const accessToken = await getGoogleAuthToken(true, GOOGLE_CALENDAR_SCOPES);
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      ...(options.body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(json?.error?.message || `Google Calendar HTTP ${response.status}`));
  }

  return json;
}

async function createGoogleCalendarEvent(event) {
  return googleCalendarRequest(GOOGLE_CALENDAR_EVENTS_URL, { method: "POST", body: event || {} });
}

// Lista eventos del calendario principal; solo pasan los parametros conocidos.
async function listPrimaryCalendarEvents(query) {
  const url = new URL(GOOGLE_CALENDAR_EVENTS_URL);
  for (const [key, value] of Object.entries(query || {})) {
    if (!GOOGLE_CALENDAR_LIST_PARAMS.has(key)) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined && item !== null && item !== "") url.searchParams.append(key, String(item));
    }
  }
  url.searchParams.set("fields", GOOGLE_CALENDAR_LIST_FIELDS);
  const json = await googleCalendarRequest(url.toString());
  return Array.isArray(json?.items) ? json.items : [];
}

async function patchPrimaryCalendarEvent(eventId, patch) {
  const id = String(eventId || "").trim();
  if (!id) throw new Error("Falta el evento de Google Calendar.");
  return googleCalendarRequest(`${GOOGLE_CALENDAR_EVENTS_URL}/${encodeURIComponent(id)}`, { method: "PATCH", body: patch || {} });
}

// Correo de la cuenta de Google con la que Chrome autoriza Calendar.
async function getGoogleCalendarAccountEmail() {
  const json = await googleCalendarRequest("https://www.googleapis.com/oauth2/v3/userinfo");
  return String(json?.email || "").trim().toLowerCase();
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

  if (message?.type === "ADACEEN_GOOGLE_CALENDAR_LIST") {
    listPrimaryCalendarEvents(message.query)
      .then((events) => sendResponse({ ok: true, events }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ADACEEN_GOOGLE_CALENDAR_PATCH") {
    patchPrimaryCalendarEvent(message.eventId, message.patch)
      .then((event) => sendResponse({ ok: true, event }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ADACEEN_GOOGLE_CALENDAR_ACCOUNT") {
    getGoogleCalendarAccountEmail()
      .then((email) => sendResponse({ ok: true, email }))
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
