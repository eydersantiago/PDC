"use strict";

// ADACEEN | Capa 3 - Servicios: telemetria v1.1, senales de error y bloqueo visibles en el overlay (A6.2).
// Movido sin cambios de telemetry.service.js (cola y envio por lotes).

// Senales (A6.2): mismas reglas que el contrato compartido para el navegador.
const SIGNAL_DEDUPE_WINDOW_MS = 60 * 1000;

const SIGNAL_BLOCKING_PERSIST_MS = 120 * 1000;

const SIGNAL_BLOCKING_REPEAT_COUNT = 3;

const SIGNAL_BLOCKING_REPEAT_WINDOW_MS = 10 * 60 * 1000;

const SIGNAL_WATCH_INTERVAL_MS = 20 * 1000;

const SIGNAL_MAX_OBSERVATION_GAP_MS = 30 * 1000;

const SIGNAL_MAX_TRACKED_KEYS = 50;

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
