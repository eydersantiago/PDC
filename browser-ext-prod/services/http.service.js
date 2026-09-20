// ADACEEN | Capa 3 - Servicios: cliente HTTP del backend ADACEEN: timeout, cabeceras de sesion y bitacora de peticiones.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const ADACEEN_BACKEND_REQUEST_LOG_KEY = "adaceenBackendRequestLog";
const ADACEEN_BACKEND_REQUEST_LOG_LIMIT = 80;

function getRequestLogChromeStorage() {
  try {
    return typeof chrome !== "undefined" && chrome.storage?.local ? chrome.storage.local : null;
  } catch {
    return null;
  }
}

function summarizeRequestUrl(url) {
  try {
    const parsed = new URL(String(url));
    return {
      origin: parsed.origin,
      path: `${parsed.pathname}${parsed.search ? "?..." : ""}`,
    };
  } catch {
    return {
      origin: "",
      path: String(url || "").slice(0, 240),
    };
  }
}

function summarizeRequestBody(body) {
  if (typeof body === "string") {
    let jsonValid = false;
    try {
      JSON.parse(body);
      jsonValid = true;
    } catch {}
    return {
      bodyType: "string",
      bodyChars: body.length,
      jsonValid,
    };
  }
  if (body == null) {
    return {
      bodyType: "empty",
      bodyChars: 0,
      jsonValid: false,
    };
  }
  return {
    bodyType: Object.prototype.toString.call(body).slice(8, -1).toLowerCase() || typeof body,
    bodyChars: 0,
    jsonValid: false,
  };
}

async function appendBackendRequestLog(entry) {
  const storage = getRequestLogChromeStorage();
  const safeEntry = {
    id: entry.id,
    at: entry.at || new Date().toISOString(),
    method: entry.method || "GET",
    origin: entry.origin || "",
    path: entry.path || "",
    contentType: entry.contentType || "",
    bodyType: entry.bodyType || "empty",
    bodyChars: Number(entry.bodyChars) || 0,
    jsonValid: entry.jsonValid === true,
    status: Number(entry.status) || 0,
    ok: entry.ok === true,
    durationMs: Number(entry.durationMs) || 0,
    error: entry.error ? String(entry.error).slice(0, 240) : "",
  };
  console.debug?.("[ADACEEN] backend request", safeEntry);
  if (!storage) return;

  try {
    const current = await storage.get([ADACEEN_BACKEND_REQUEST_LOG_KEY]);
    const previous = Array.isArray(current?.[ADACEEN_BACKEND_REQUEST_LOG_KEY])
      ? current[ADACEEN_BACKEND_REQUEST_LOG_KEY]
      : [];
    await storage.set({
      [ADACEEN_BACKEND_REQUEST_LOG_KEY]: [safeEntry, ...previous].slice(0, ADACEEN_BACKEND_REQUEST_LOG_LIMIT),
    });
  } catch (error) {
    console.debug?.("[ADACEEN] no se pudo guardar request log", error);
  }
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = BACKEND_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  const requestId = `${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const urlSummary = summarizeRequestUrl(url);
  const bodySummary = summarizeRequestBody(options.body);
  const requestMethod = String(options.method || "GET").toUpperCase();
  const contentType = typeof options.headers?.get === "function"
    ? options.headers.get("content-type")
    : (options.headers?.["Content-Type"] || options.headers?.["content-type"] || "");
  const requestOptions = {
    ...options,
    credentials: options.credentials || "omit",
    signal: controller.signal,
  };
  let responseLogged = false;

  try {
    const response = await fetch(url, requestOptions);
    const json = await response.json().catch(() => ({}));
    await appendBackendRequestLog({
      id: requestId,
      method: requestMethod,
      ...urlSummary,
      contentType,
      ...bodySummary,
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - startedAt,
    });
    responseLogged = true;
    if (!response.ok) {
      throw new Error(String(json.error || `HTTP ${response.status}`));
    }
    return json;
  } catch (error) {
    if (!responseLogged) {
      await appendBackendRequestLog({
        id: requestId,
        method: requestMethod,
        ...urlSummary,
        contentType,
        ...bodySummary,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error?.message || String(error),
      });
    }
    if (error && typeof error === "object" && error.name === "AbortError") {
      const seconds = Math.max(1, Math.round((Number(timeoutMs) || BACKEND_TIMEOUT_MS) / 1000));
      throw new Error(`Tiempo de espera agotado (${seconds}s).`);
    }
    if (error && typeof error === "object" && error.name === "TypeError") {
      throw new Error("No se pudo conectar con el backend. Verifica la URL del backend o recarga la extension.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildApiHeaders() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    ...(overlayState.sessionId ? { "x-session-id": overlayState.sessionId } : {}),
  };
}

/** Cabeceras para subir archivos: el navegador pone el Content-Type del FormData. */

function buildMultipartApiHeaders() {
  return overlayState.sessionId ? { "x-session-id": overlayState.sessionId } : {};
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}
