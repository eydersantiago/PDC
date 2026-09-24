// ADACEEN | Capa 3 - Servicios: telemetria v1.1 del overlay (A11.2 ADACEEN-98, A4.2, A6.2 ADACEEN-63).
// Cola en memoria con envio por lotes a POST {backendUrl}/api/behavior/events (cada 5 s o al
// juntar 10 eventos), un reintento ante error transitorio y vaciado con fetch keepalive en
// pagehide. Sin persistencia offline: lo que no se logra enviar se descarta (el hueco en `seq`
// permite medir la perdida).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const TELEMETRY_SCHEMA_VERSION = "1.1";
const TELEMETRY_SOURCE = "browser_extension";
const TELEMETRY_ENDPOINT_PATH = "/api/behavior/events";
const TELEMETRY_FLUSH_INTERVAL_MS = 5000;
const TELEMETRY_BATCH_SIZE = 10;
const TELEMETRY_MAX_EVENTS_PER_REQUEST = 50;
const TELEMETRY_MAX_QUEUE_LENGTH = 200;
const TELEMETRY_RETRY_DELAY_MS = 1500;
const TELEMETRY_REQUEST_TIMEOUT_MS = 15000;
// keepalive limita a 64 KiB el cuerpo de las peticiones pendientes; se deja margen.
const TELEMETRY_KEEPALIVE_MAX_BODY_BYTES = 60000;
const TELEMETRY_ERROR_TEXT_MAX = 300;
const TELEMETRY_TEXT_FIELDS = [
  ["pageContext", 120],
  ["repoFullName", 240],
  ["branch", 160],
  ["filePath", 700],
  ["language", 120],
  ["subjectId", 220],
  ["value", 1000],
  ["decisionId", 80],
  ["errorText", TELEMETRY_ERROR_TEXT_MAX],
];

// Senales (A6.2): mismas reglas que el contrato compartido para el navegador.
const SIGNAL_DEDUPE_WINDOW_MS = 60 * 1000;
const SIGNAL_BLOCKING_PERSIST_MS = 120 * 1000;
const SIGNAL_BLOCKING_REPEAT_COUNT = 3;
const SIGNAL_BLOCKING_REPEAT_WINDOW_MS = 10 * 60 * 1000;
const SIGNAL_WATCH_INTERVAL_MS = 20 * 1000;
const SIGNAL_MAX_OBSERVATION_GAP_MS = 30 * 1000;
const SIGNAL_MAX_TRACKED_KEYS = 50;

const telemetryQueueState = {
  queue: [],
  seq: 0,
  clientSessionId: "",
  clientIdPromise: null,
  flushTimer: 0,
  flushInFlight: null,
  lifecycleBound: false,
  unloading: false,
  sentEvents: 0,
  droppedEvents: 0,
  lastError: "",
};

const overlayTelemetryState = {
  openedAt: 0,
  openTrigger: "",
};

const tutorResponseTracker = {
  current: null,
};

// Las claves de deduplicacion son hashes del texto normalizado: el texto del error solo
// viaja en el evento (errorText) y el servidor lo convierte en errorHash.
const visibleErrorSignalState = {
  currentKey: "",
  firstSeenAt: 0,
  lastSeenAt: 0,
  visibleMs: 0,
  blockingEmittedForEpisode: false,
  lastContext: null,
  lastDetectedAtByKey: new Map(),
  appearancesByKey: new Map(),
  lastBlockingAtByKey: new Map(),
  watchTimer: 0,
};

// ---- Identidad del cliente ----

function generateTelemetryId(prefix = "") {
  let raw = "";
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      raw = crypto.randomUUID().replace(/-/g, "");
    } else if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      raw = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    raw = "";
  }
  if (!raw) {
    raw = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
  }
  return `${prefix}${raw}`.slice(0, 80);
}

// Un id aleatorio por carga de pagina: agrupa los eventos y da sentido al contador `seq`.
function getTelemetryClientSessionId() {
  if (!telemetryQueueState.clientSessionId) {
    telemetryQueueState.clientSessionId = generateTelemetryId("cs_");
  }
  return telemetryQueueState.clientSessionId;
}

async function persistAdaceenClientId(clientId) {
  if (!isExtensionRuntimeReady()) return false;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_CLIENT_ID]: clientId });
    return true;
  } catch {
    return false;
  }
}

async function ensureAdaceenClientId() {
  if (isValidAdaceenClientId(overlayState.clientId)) return overlayState.clientId;
  if (!telemetryQueueState.clientIdPromise) {
    telemetryQueueState.clientIdPromise = (async () => {
      let clientId = "";
      try {
        if (isExtensionRuntimeReady()) {
          const stored = await chrome.storage.local.get([STORAGE_KEY_CLIENT_ID]);
          if (isValidAdaceenClientId(stored?.[STORAGE_KEY_CLIENT_ID])) {
            clientId = toText(stored[STORAGE_KEY_CLIENT_ID]);
          }
        }
      } catch {
        clientId = "";
      }
      if (!clientId) {
        clientId = generateTelemetryId();
        await persistAdaceenClientId(clientId);
      }
      if (!isValidAdaceenClientId(overlayState.clientId)) {
        overlayState.clientId = clientId;
      }
      return overlayState.clientId;
    })().finally(() => {
      telemetryQueueState.clientIdPromise = null;
    });
  }
  return telemetryQueueState.clientIdPromise;
}

// Para pagehide, donde no se puede esperar a chrome.storage. loadPreferences ya lo carga al
// arrancar, asi que generar uno nuevo aqui es un caso excepcional.
function getAdaceenClientIdSync() {
  if (isValidAdaceenClientId(overlayState.clientId)) return overlayState.clientId;
  const clientId = generateTelemetryId();
  overlayState.clientId = clientId;
  persistAdaceenClientId(clientId).catch(() => false);
  return clientId;
}

// ---- Construccion de eventos ----

function isTelemetryTransportReady() {
  return isExtensionRuntimeReady() && !!normalizeBaseUrl(overlayState.backendUrl);
}

function sanitizeTelemetryString(value, max) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, Math.max(0, Number(max) || 0));
}

function clampTelemetryInteger(value, min, max) {
  if (value === null || value === undefined || value === "") return null;
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return null;
  return Math.min(max, Math.max(min, number));
}

function sanitizeTelemetryMetadata(metadata) {
  const out = {};
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return out;
  let count = 0;
  for (const [rawKey, value] of Object.entries(metadata)) {
    if (count >= 20) break;
    const key = sanitizeTelemetryString(rawKey, 60);
    if (!key) continue;
    if (typeof value === "string") {
      const text = sanitizeTelemetryString(value, 300);
      if (!text) continue;
      out[key] = text;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === "boolean") {
      out[key] = value;
    } else {
      continue;
    }
    count += 1;
  }
  return out;
}

function nextTelemetrySeq() {
  const seq = telemetryQueueState.seq;
  telemetryQueueState.seq = (seq + 1) % 1000000000;
  return seq;
}

// Solo claves del esquema estricto v1.1 del backend (contrato, seccion 2).
function buildTelemetryEvent(category, eventType, fields = {}) {
  const source = fields && typeof fields === "object" ? fields : {};
  const event = {
    source: TELEMETRY_SOURCE,
    category: sanitizeTelemetryString(category, 40),
    eventType: sanitizeTelemetryString(eventType, 120),
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    seq: nextTelemetrySeq(),
    clientSessionId: getTelemetryClientSessionId(),
    occurredAt: new Date().toISOString(),
  };

  for (const [key, max] of TELEMETRY_TEXT_FIELDS) {
    const text = sanitizeTelemetryString(source[key], max);
    if (text) event[key] = text;
  }

  const durationMs = clampTelemetryInteger(source.durationMs, 0, 86400000);
  if (durationMs !== null) event.durationMs = durationMs;
  const count = clampTelemetryInteger(source.count, 1, 100000);
  if (count !== null) event.count = count;
  const latencyMs = clampTelemetryInteger(source.latencyMs, 0, 600000);
  if (latencyMs !== null) event.latencyMs = latencyMs;

  const metadata = sanitizeTelemetryMetadata(source.metadata);
  if (Object.keys(metadata).length > 0) event.metadata = metadata;
  return event;
}

function buildTelemetryContextFields(context) {
  const source = context && typeof context === "object" ? context : {};
  return {
    pageContext: toText(source.pageContext),
    repoFullName: toText(source.repoFullName),
    branch: toText(source.branch),
    filePath: toText(source.filePath),
    language: toText(source.languageHint),
  };
}

function trackTelemetryEvent(category, eventType, fields = {}) {
  if (!isTelemetryTransportReady()) return null;

  let event = null;
  try {
    event = buildTelemetryEvent(category, eventType, fields);
  } catch {
    return null;
  }
  if (!event.category || !event.eventType) return null;

  const queue = telemetryQueueState.queue;
  queue.push(event);
  if (queue.length > TELEMETRY_MAX_QUEUE_LENGTH) {
    const overflow = queue.length - TELEMETRY_MAX_QUEUE_LENGTH;
    queue.splice(0, overflow);
    telemetryQueueState.droppedEvents += overflow;
  }

  bindTelemetryPageLifecycle();
  if (!isValidAdaceenClientId(overlayState.clientId)) {
    ensureAdaceenClientId().catch(() => "");
  }
  if (telemetryQueueState.unloading) return event;

  if (queue.length >= TELEMETRY_BATCH_SIZE) {
    flushTelemetryQueue().catch(() => false);
  } else {
    scheduleTelemetryFlush();
  }
  return event;
}

// ---- Envio por lotes ----

function scheduleTelemetryFlush(delayMs = TELEMETRY_FLUSH_INTERVAL_MS) {
  if (telemetryQueueState.flushTimer) return;
  telemetryQueueState.flushTimer = setTimeout(() => {
    telemetryQueueState.flushTimer = 0;
    flushTelemetryQueue().catch(() => false);
  }, Math.max(0, Number(delayMs) || 0));
}

function clearTelemetryFlushTimer() {
  if (!telemetryQueueState.flushTimer) return;
  clearTimeout(telemetryQueueState.flushTimer);
  telemetryQueueState.flushTimer = 0;
}

function buildTelemetryHeaders(clientId) {
  return {
    ...buildApiHeaders(),
    "x-adaceen-client-id": clientId,
  };
}

function createTelemetryError(message, status = 0) {
  const error = new Error(message);
  error.status = Number(status) || 0;
  return error;
}

function isRetryableTelemetryError(error) {
  const status = Number(error?.status) || 0;
  // Red caida, timeout, 408/425/429 o 5xx. Un 400/401/403 no cambia al reintentar.
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
}

async function postTelemetryEvents(events) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl) throw createTelemetryError("Sin URL de backend.", 400);

  const clientId = await ensureAdaceenClientId();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEMETRY_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${TELEMETRY_ENDPOINT_PATH}`, {
      method: "POST",
      headers: buildTelemetryHeaders(clientId),
      body: JSON.stringify({ events }),
      credentials: "omit",
      signal: controller.signal,
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw createTelemetryError(toText(json?.error) || `HTTP ${response.status}`, response.status);
    }
    if (Array.isArray(json?.flags) && json.flags.length > 0) {
      console.debug?.("[ADACEEN] telemetria: avisos de calidad del servidor", json.flags);
    }
    return json;
  } catch (error) {
    if (error && typeof error === "object" && error.name === "AbortError") {
      throw createTelemetryError("Tiempo de espera agotado.", 0);
    }
    if (error && typeof error === "object" && typeof error.status === "number") {
      throw error;
    }
    throw createTelemetryError(String(error?.message || error), 0);
  } finally {
    clearTimeout(timeout);
  }
}

async function sendTelemetryBatch(events) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await postTelemetryEvents(events);
      telemetryQueueState.sentEvents += events.length;
      telemetryQueueState.lastError = "";
      return true;
    } catch (error) {
      telemetryQueueState.lastError = String(error?.message || error).slice(0, 240);
      if (attempt > 0 || !isRetryableTelemetryError(error)) break;
      await new Promise((resolve) => setTimeout(resolve, TELEMETRY_RETRY_DELAY_MS));
    }
  }
  telemetryQueueState.droppedEvents += events.length;
  console.debug?.("[ADACEEN] telemetria descartada", {
    events: events.length,
    error: telemetryQueueState.lastError,
  });
  return false;
}

async function flushTelemetryQueue() {
  clearTelemetryFlushTimer();
  if (telemetryQueueState.flushInFlight) {
    // Al terminar el envio en curso se revisa la cola otra vez (ver finally).
    return telemetryQueueState.flushInFlight;
  }
  if (!telemetryQueueState.queue.length || !isTelemetryTransportReady()) return false;

  const batch = telemetryQueueState.queue.splice(0, TELEMETRY_MAX_EVENTS_PER_REQUEST);
  telemetryQueueState.flushInFlight = (async () => {
    try {
      return await sendTelemetryBatch(batch);
    } finally {
      telemetryQueueState.flushInFlight = null;
      if (!telemetryQueueState.unloading && telemetryQueueState.queue.length > 0) {
        scheduleTelemetryFlush(telemetryQueueState.queue.length >= TELEMETRY_BATCH_SIZE ? 0 : TELEMETRY_FLUSH_INTERVAL_MS);
      }
    }
  })();
  return telemetryQueueState.flushInFlight;
}

// Vacia la cola antes de un cambio de identidad (logout): lo registrado con la sesion
// sale con la cabecera de esa sesion.
async function flushTelemetryQueueNow() {
  for (let round = 0; round < 4; round++) {
    if (telemetryQueueState.flushInFlight) {
      await telemetryQueueState.flushInFlight.catch(() => false);
      continue;
    }
    if (!telemetryQueueState.queue.length) return true;
    await flushTelemetryQueue().catch(() => false);
  }
  return telemetryQueueState.queue.length === 0;
}

function measureTelemetryBytes(text) {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return String(text || "").length * 3;
  }
}

function chunkTelemetryEventsForKeepalive(events) {
  const chunks = [];
  let current = [];
  let currentBytes = 16;
  for (const event of events) {
    const size = measureTelemetryBytes(JSON.stringify(event)) + 1;
    if (size + 16 > TELEMETRY_KEEPALIVE_MAX_BODY_BYTES) {
      telemetryQueueState.droppedEvents += 1;
      continue;
    }
    if (current.length > 0
      && (current.length >= TELEMETRY_MAX_EVENTS_PER_REQUEST || currentBytes + size > TELEMETRY_KEEPALIVE_MAX_BODY_BYTES)) {
      chunks.push(current);
      current = [];
      currentBytes = 16;
    }
    current.push(event);
    currentBytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// pagehide: la pagina se va; fetch keepalive deja que la peticion termine despues.
function flushTelemetryQueueWithKeepalive() {
  clearTelemetryFlushTimer();
  const queue = telemetryQueueState.queue;
  if (!queue.length || !isTelemetryTransportReady()) return 0;

  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const headers = buildTelemetryHeaders(getAdaceenClientIdSync());
  const events = queue.splice(0, queue.length);
  let sent = 0;
  for (const chunk of chunkTelemetryEventsForKeepalive(events)) {
    try {
      fetch(`${baseUrl}${TELEMETRY_ENDPOINT_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ events: chunk }),
        credentials: "omit",
        keepalive: true,
      }).catch(() => {
        telemetryQueueState.droppedEvents += chunk.length;
      });
      sent += chunk.length;
    } catch {
      telemetryQueueState.droppedEvents += chunk.length;
    }
  }
  return sent;
}

function bindTelemetryPageLifecycle() {
  if (telemetryQueueState.lifecycleBound) return;
  telemetryQueueState.lifecycleBound = true;
  window.addEventListener("pagehide", handleTelemetryPageHide);
  window.addEventListener("pageshow", handleTelemetryPageShow);
  document.addEventListener("visibilitychange", handleTelemetryVisibilityChange);
}

function handleTelemetryPageHide(event) {
  telemetryQueueState.unloading = true;
  // Con bfcache (persisted) la pagina puede volver tal cual: no se cierra nada.
  if (!event?.persisted) {
    try {
      if (overlayHost?.isConnected) {
        finalizeTutorResponseTracking("pagehide");
        recordOverlayClosed("pagehide");
      }
    } catch {}
  }
  stopErrorSignalWatch();
  flushTelemetryQueueWithKeepalive();
}

function handleTelemetryPageShow() {
  telemetryQueueState.unloading = false;
  if (telemetryQueueState.queue.length > 0) scheduleTelemetryFlush();
}

function handleTelemetryVisibilityChange() {
  if (document.visibilityState === "hidden") {
    flushTelemetryQueue().catch(() => false);
    return;
  }
  // Una respuesta que llego con la pestana oculta se marca como mostrada al volver.
  if (typeof refreshTutorFeedbackVisibility === "function") {
    try {
      refreshTutorFeedbackVisibility();
    } catch {}
  }
}

// ---- Ciclo de vida del overlay (A11.2) ----

function recordOverlayOpened(trigger = "auto") {
  overlayTelemetryState.openedAt = Date.now();
  overlayTelemetryState.openTrigger = sanitizeTelemetryString(trigger, 40) || "auto";
  const context = overlayState.context || {};
  return trackTelemetryEvent("navigation", "overlay_opened", {
    ...buildTelemetryContextFields(context),
    metadata: {
      trigger: overlayTelemetryState.openTrigger,
      pageType: toText(context.pageType),
      minimized: overlayState.minimized === true,
      extensionVersion: ADACEEN_BROWSER_EXTENSION_VERSION,
    },
  });
}

function recordOverlayClosed(reason = "user") {
  if (!overlayTelemetryState.openedAt) return null;
  const durationMs = Date.now() - overlayTelemetryState.openedAt;
  const trigger = overlayTelemetryState.openTrigger;
  overlayTelemetryState.openedAt = 0;
  overlayTelemetryState.openTrigger = "";
  const context = overlayState.context || {};
  return trackTelemetryEvent("navigation", "overlay_closed", {
    ...buildTelemetryContextFields(context),
    durationMs,
    metadata: {
      reason: sanitizeTelemetryString(reason, 40) || "user",
      trigger,
      pageType: toText(context.pageType),
    },
  });
}

// ---- Ciclo de vida de las respuestas del tutor (A11.2) ----

function normalizeTutorRequestTrigger(value) {
  const text = toText(value).toLowerCase();
  return text === "manual" || text === "shortcut" ? text : "auto";
}

function normalizeTutorResponseSource(source, blocked) {
  const text = sanitizeTelemetryString(source, 40).toLowerCase();
  if (text) return text;
  return blocked ? "policy" : "heuristic";
}

function recordTutorRequestSubmitted(trigger, context) {
  const source = context || overlayState.context || {};
  return trackTelemetryEvent("tutor", "tutor_request_submitted", {
    ...buildTelemetryContextFields(source),
    value: normalizeTutorRequestTrigger(trigger),
    metadata: { pageType: toText(source.pageType) },
  });
}

function recordTutorResponseReceived(result, requestedAt, context) {
  // Una respuesta mostrada que se reemplaza sin opinion cuenta como ignorada.
  finalizeTutorResponseTracking("replaced");
  const source = context || overlayState.context || {};
  const now = Date.now();
  const decisionId = sanitizeTelemetryString(result?.decisionId, 80);
  const blocked = result?.blocked === true;
  const responseSource = normalizeTutorResponseSource(result?.source, blocked);
  tutorResponseTracker.current = {
    decisionId,
    source: responseSource,
    blocked,
    receivedAt: now,
    shownAt: 0,
    resolved: false,
    feedback: "",
  };
  trackTelemetryEvent("tutor", "tutor_response_received", {
    ...buildTelemetryContextFields(source),
    decisionId,
    latencyMs: now - (Number(requestedAt) || now),
    value: responseSource,
    metadata: { blocked, pageType: toText(source.pageType) },
  });
  return tutorResponseTracker.current;
}

function markTutorResponseShown() {
  const current = tutorResponseTracker.current;
  if (!current || current.shownAt || current.resolved) return false;
  current.shownAt = Date.now();
  const context = overlayState.context || {};
  trackTelemetryEvent("tutor", "tutor_response_shown", {
    ...buildTelemetryContextFields(context),
    decisionId: current.decisionId,
    metadata: { source: current.source, pageType: toText(context.pageType) },
  });
  return true;
}

function recordTutorResponseFeedback(kind) {
  const current = tutorResponseTracker.current;
  if (!current || current.resolved) return false;
  if (!current.shownAt) markTutorResponseShown();
  const now = Date.now();
  const accepted = kind === "accepted";
  current.resolved = true;
  current.feedback = accepted ? "accepted" : "rejected";
  const context = overlayState.context || {};
  trackTelemetryEvent("tutor", accepted ? "tutor_response_accepted" : "tutor_response_rejected", {
    ...buildTelemetryContextFields(context),
    decisionId: current.decisionId,
    durationMs: now - (current.shownAt || now),
    metadata: { source: current.source, pageType: toText(context.pageType) },
  });
  return true;
}

// tutor_response_ignored: la respuesta se vio y el estudiante no eligio antes de que
// se reemplazara, se cerrara el overlay o se fuera de la pagina.
function finalizeTutorResponseTracking(reason = "replaced") {
  const current = tutorResponseTracker.current;
  if (!current || current.resolved || !current.shownAt) return false;
  const now = Date.now();
  current.resolved = true;
  current.feedback = "ignored";
  const context = overlayState.context || {};
  trackTelemetryEvent("tutor", "tutor_response_ignored", {
    ...buildTelemetryContextFields(context),
    decisionId: current.decisionId,
    durationMs: now - current.shownAt,
    metadata: {
      reason: sanitizeTelemetryString(reason, 40) || "replaced",
      source: current.source,
      pageType: toText(context.pageType),
    },
  });
  return true;
}

function clearTutorResponseTracking(reason = "replaced") {
  finalizeTutorResponseTracking(reason);
  tutorResponseTracker.current = null;
}

function getTutorResponseFeedbackState() {
  const current = tutorResponseTracker.current;
  return {
    active: !!current,
    decisionId: toText(current?.decisionId),
    shown: !!current?.shownAt,
    resolved: current?.resolved === true,
    feedback: toText(current?.feedback),
  };
}

function recordRagSourceOpened(source) {
  const item = source && typeof source === "object" ? source : {};
  const key = toText(item.sourceId || item.id || item.chunkId);
  const title = truncateText(toText(item.title || item.fileName || item.citationLabel), 80);
  const context = overlayState.context || {};
  return trackTelemetryEvent("tutor", "rag_source_opened", {
    ...buildTelemetryContextFields(context),
    decisionId: toText(tutorResponseTracker.current?.decisionId),
    value: key || title || "fuente_rag",
    metadata: {
      courseCode: toText(item.courseCode),
      page: Number(item.pageStart) || 0,
      scope: toText(item.scope),
      pageType: toText(context.pageType),
    },
  });
}

// ---- Senales de error y bloqueo (A6.2) ----

function shouldObserveErrorSignals() {
  return isTelemetryTransportReady()
    && !telemetryQueueState.unloading
    && overlayState.assistantEnabled !== false
    && overlayState.started === true
    && !!overlayHost?.isConnected;
}

function normalizeSignalErrorText(value) {
  return toText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/0x[0-9a-f]+/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .replace(/[\s.,;:]+$/g, "")
    .trim()
    .slice(0, TELEMETRY_ERROR_TEXT_MAX);
}

// FNV-1a de 32 bits: basta para deduplicar sin guardar el texto del error.
function hashSignalKey(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, "0")}:${text.length}`;
}

function buildSignalContext(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  return {
    pageContext: toText(source.pageContext),
    pageType: toText(source.pageType),
    repoFullName: toText(source.repoFullName),
    branch: toText(source.branch),
    filePath: toText(source.filePath),
    languageHint: toText(source.languageHint),
  };
}

function buildSignalEventFields(signalContext) {
  return {
    ...buildTelemetryContextFields(signalContext),
    metadata: { pageType: toText(signalContext?.pageType) },
  };
}

function pruneSignalHistory(now) {
  const state = visibleErrorSignalState;
  for (const [key, appearances] of state.appearancesByKey) {
    const recent = appearances.filter((at) => now - at <= SIGNAL_BLOCKING_REPEAT_WINDOW_MS);
    if (recent.length) state.appearancesByKey.set(key, recent);
    else state.appearancesByKey.delete(key);
  }
  for (const map of [state.lastDetectedAtByKey, state.lastBlockingAtByKey]) {
    for (const [key, at] of map) {
      if (now - at > SIGNAL_BLOCKING_REPEAT_WINDOW_MS) map.delete(key);
    }
    while (map.size > SIGNAL_MAX_TRACKED_KEYS) {
      map.delete(map.keys().next().value);
    }
  }
  while (state.appearancesByKey.size > SIGNAL_MAX_TRACKED_KEYS) {
    state.appearancesByKey.delete(state.appearancesByKey.keys().next().value);
  }
}

function resetVisibleErrorEpisode() {
  const state = visibleErrorSignalState;
  state.currentKey = "";
  state.firstSeenAt = 0;
  state.lastSeenAt = 0;
  state.visibleMs = 0;
  state.blockingEmittedForEpisode = false;
}

function emitBlockingSignal(key, errorText, signalContext, now, reason) {
  const state = visibleErrorSignalState;
  state.blockingEmittedForEpisode = true;
  const lastBlockingAt = state.lastBlockingAtByKey.get(key) || 0;
  if (lastBlockingAt && now - lastBlockingAt < SIGNAL_BLOCKING_REPEAT_WINDOW_MS) return null;
  state.lastBlockingAtByKey.set(key, now);
  const fields = buildSignalEventFields(signalContext);
  const appearances = state.appearancesByKey.get(key) || [];
  // durationMs = persistencia del episodio actual; count = apariciones en la ventana de 10 min.
  return trackTelemetryEvent("signal", "blocking_detected", {
    ...fields,
    errorText,
    durationMs: state.visibleMs,
    count: Math.max(1, appearances.length),
    metadata: {
      ...fields.metadata,
      reason,
      windowMs: appearances.length ? Math.max(0, now - appearances[0]) : 0,
    },
  });
}

// Se llama desde buildPayload (content-context.js), donde el overlay detecta el error visible.
// error_detected: cada aparicion, deduplicada 60 s por texto normalizado.
// blocking_detected: el mismo error visible >= 120 s o 3 apariciones en 10 min (1 vez / 10 min).
function observeVisibleErrorSignal(payload) {
  const state = visibleErrorSignalState;
  if (!shouldObserveErrorSignals()) {
    resetVisibleErrorEpisode();
    stopErrorSignalWatch();
    return null;
  }

  // Una pestana oculta no "muestra" errores: no se abre ni se corta el episodio.
  if (document.visibilityState === "hidden") return null;

  const rawError = toText(payload?.visibleError);
  const normalized = normalizeSignalErrorText(rawError);
  if (!normalized) {
    resetVisibleErrorEpisode();
    stopErrorSignalWatch();
    return null;
  }

  const now = Date.now();
  const key = hashSignalKey(normalized);
  const errorText = rawError.slice(0, TELEMETRY_ERROR_TEXT_MAX);
  const signalContext = buildSignalContext(payload);
  state.lastContext = signalContext;
  pruneSignalHistory(now);

  let emitted = null;
  if (key !== state.currentKey) {
    state.currentKey = key;
    state.firstSeenAt = now;
    state.lastSeenAt = now;
    state.visibleMs = 0;
    state.blockingEmittedForEpisode = false;

    const appearances = (state.appearancesByKey.get(key) || [])
      .filter((at) => now - at <= SIGNAL_BLOCKING_REPEAT_WINDOW_MS);
    appearances.push(now);
    state.appearancesByKey.set(key, appearances);

    const lastDetectedAt = state.lastDetectedAtByKey.get(key) || 0;
    if (!lastDetectedAt || now - lastDetectedAt >= SIGNAL_DEDUPE_WINDOW_MS) {
      state.lastDetectedAtByKey.set(key, now);
      emitted = trackTelemetryEvent("signal", "error_detected", {
        ...buildSignalEventFields(signalContext),
        errorText,
      });
    }
    if (appearances.length >= SIGNAL_BLOCKING_REPEAT_COUNT) {
      emitBlockingSignal(key, errorText, signalContext, now, "repeated");
    }
  } else {
    // Solo se acumula tiempo con la pestana visible (las ocultas salen arriba); un hueco
    // largo entre observaciones cuenta como maximo 30 s.
    const gap = Math.max(0, now - (state.lastSeenAt || now));
    state.visibleMs += Math.min(gap, SIGNAL_MAX_OBSERVATION_GAP_MS);
    state.lastSeenAt = now;
    if (!state.blockingEmittedForEpisode && state.visibleMs >= SIGNAL_BLOCKING_PERSIST_MS) {
      emitBlockingSignal(key, errorText, signalContext, now, "persistent");
    }
  }

  ensureErrorSignalWatch();
  return emitted;
}

// Mientras hay un error visible se re-evalua cada 20 s (sin reconstruir todo el contexto)
// para medir la persistencia aunque nadie llame a buildPayload.
function ensureErrorSignalWatch() {
  if (visibleErrorSignalState.watchTimer) return;
  visibleErrorSignalState.watchTimer = setInterval(runErrorSignalWatchTick, SIGNAL_WATCH_INTERVAL_MS);
}

function stopErrorSignalWatch() {
  if (!visibleErrorSignalState.watchTimer) return;
  clearInterval(visibleErrorSignalState.watchTimer);
  visibleErrorSignalState.watchTimer = 0;
}

function runErrorSignalWatchTick() {
  const state = visibleErrorSignalState;
  if (!state.currentKey || !shouldObserveErrorSignals()) {
    resetVisibleErrorEpisode();
    stopErrorSignalWatch();
    return;
  }
  if (document.visibilityState === "hidden") {
    state.lastSeenAt = Date.now();
    return;
  }
  if (Date.now() - state.lastSeenAt < SIGNAL_WATCH_INTERVAL_MS - 1000) return;

  let visibleError = "";
  try {
    visibleError = detectVisibleError(extractSelectionText(4000), extractVisibleText(14000));
  } catch {
    visibleError = "";
  }
  observeVisibleErrorSignal({ ...(state.lastContext || {}), visibleError });
}

function stopVisibleErrorSignals() {
  stopErrorSignalWatch();
  resetVisibleErrorEpisode();
}
