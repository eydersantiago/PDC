"use strict";

// ADACEEN | Capa 3 - Servicios: telemetria v1.1, ciclo de vida del overlay y de las respuestas del tutor (A11.2).
// Movido sin cambios de telemetry.service.js (cola y envio por lotes).

const overlayTelemetryState = {
  openedAt: 0,
  openTrigger: "",
};

const tutorResponseTracker = {
  current: null,
};

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
