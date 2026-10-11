// ADACEEN | Capa 3 - Servicios: tema del piloto (0.7.21, piloto con FPOO-01).
// El docente, o el administrador por él, elige en «Estudiantes» la semana de la bitácora, el
// tema y el repositorio del ejercicio (por ejemplo la semana 7 con vbucheli/IMC). El
// estudiante lo ve en Inicio con «Abrir el ejercicio en mi editor» y el tutor recibe esa semana
// (buildCourseWeekForTutor, course-agenda.service.js) aunque el calendario vaya en otra.
//   GET /api/pilot/topic[?teacherUserId=] -> { teacherUserId, topic, weeks?, teachers? }
//   PUT /api/pilot/topic { teacherUserId?, courseCode, week, title, repoFullName } | { clear: true }
// El estudiante lo consulta al entrar y, si el docente lo cambia en plena clase, lo ve al volver
// a abrir ADACEEN o pulsar «Actualizar» pasados 5 minutos; el docente y el administrador, al abrir
// «Estudiantes» (se reutiliza un minuto). Un backend sin la ruta (404) no se vuelve a consultar
// en la sesión. La vista está en overlay/content-pilot-topic.js.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const PILOT_TOPIC_STALE_MS = 60 * 1000;
const PILOT_TOPIC_STUDENT_STALE_MS = 5 * 60 * 1000;
const PILOT_TOPIC_TIMEOUT_MS = 15000;
const PILOT_TOPIC_UNSUPPORTED_MESSAGE = "Este backend todavía no tiene el tema del piloto: llega con la versión 0.7.21.";

const EMPTY_PILOT_TOPIC_STATE = Object.freeze({
  ownerUserId: "",
  loadedAt: 0,
  busy: false,
  saving: false,
  unsupported: false,
  error: "",
  message: "",
  teacherUserId: "",
  topic: null,
  weeks: [],
  teachers: [],
});

// Estado del tema para la sesión actual (se reinicia si cambia el usuario).
function getPilotTopicState() {
  const userId = toText(overlayState.session?.user?.id);
  const current = overlayState.pilotTopic;
  if (!current || current.ownerUserId !== userId) {
    overlayState.pilotTopic = { ...EMPTY_PILOT_TOPIC_STATE, weeks: [], teachers: [], ownerUserId: userId };
  }
  return overlayState.pilotTopic;
}

function normalizePilotTopicPayload(topic) {
  if (!topic || typeof topic !== "object") return null;
  const week = Number(topic.week);
  return {
    courseCode: normalizeRagCourseCodeUi(topic.courseCode),
    week: Number.isInteger(week) && week > 0 && week <= 30 ? week : 0,
    title: toText(topic.title),
    repoFullName: toText(topic.repoFullName),
    updatedAt: toText(topic.updatedAt),
    updatedByName: toText(topic.updatedByName),
  };
}

function canReadPilotTopic() {
  const role = overlayState.session?.user?.role;
  return role === "student" || role === "teacher" || role === "admin";
}

function canChoosePilotTopic() {
  const role = overlayState.session?.user?.role;
  return role === "teacher" || role === "admin";
}

/**
 * Consulta el tema si la última consulta tiene más de maxAgeMs (un minuto por defecto; el
 * estudiante, al entrar, 5). Devuelve la consulta o null.
 */
function ensurePilotTopicLoaded(options = {}) {
  if (!overlayState.sessionId || !canReadPilotTopic()) return null;
  const state = getPilotTopicState();
  if (state.busy || state.unsupported) return null;
  const maxAgeMs = Number(options.maxAgeMs) > 0 ? Number(options.maxAgeMs) : PILOT_TOPIC_STALE_MS;
  if (state.loadedAt && Date.now() - state.loadedAt <= maxAgeMs) return null;
  const request = refreshPilotTopic();
  request.catch(() => {});
  return request;
}

async function refreshPilotTopic(options = {}) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const state = getPilotTopicState();
  if (!baseUrl || !overlayState.sessionId || !canReadPilotTopic() || state.unsupported) return null;
  const teacherUserId = isAdminSession() ? toText(options.teacherUserId || state.teacherUserId) : "";
  state.busy = true;
  state.error = "";
  try {
    const query = teacherUserId ? `?teacherUserId=${encodeURIComponent(teacherUserId)}` : "";
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/pilot/topic${query}`, {
      method: "GET",
      headers: buildApiHeaders(),
    }, PILOT_TOPIC_TIMEOUT_MS);
    state.teacherUserId = toText(response?.teacherUserId);
    state.topic = normalizePilotTopicPayload(response?.topic);
    state.weeks = (Array.isArray(response?.weeks) ? response.weeks : [])
      .map((week) => ({ week: Number(week?.week) || 0, dateKey: toText(week?.dateKey), topic: toText(week?.topic), activities: Array.isArray(week?.activities) ? week.activities.map(toText) : [] }))
      .filter((week) => week.week > 0);
    state.teachers = (Array.isArray(response?.teachers) ? response.teachers : [])
      .map((teacher) => ({ id: toText(teacher?.id), displayName: toText(teacher?.displayName), email: toText(teacher?.email) }))
      .filter((teacher) => teacher.id);
    state.loadedAt = Date.now();
    return state.topic;
  } catch (error) {
    if (Number(error?.status) === 404) {
      state.unsupported = true;
      state.error = PILOT_TOPIC_UNSUPPORTED_MESSAGE;
    } else {
      state.error = `No se pudo consultar el tema del piloto: ${toText(error?.message) || String(error)}`;
    }
    state.loadedAt = Date.now();
    return null;
  } finally {
    state.busy = false;
    if (overlayHost?.isConnected) renderOverlay();
  }
}

// Guarda (o quita, con null) el tema; devuelve { ok, message }.
async function savePilotTopic(input) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const state = getPilotTopicState();
  if (!baseUrl || !overlayState.sessionId || !canChoosePilotTopic()) {
    return { ok: false, message: "Solo el docente o el administrador eligen el tema del piloto." };
  }
  const body = input
    ? {
      courseCode: toText(input.courseCode) || "FPOO",
      week: Math.max(0, Math.min(30, Math.round(Number(input.week) || 0))),
      title: toText(input.title).slice(0, 160),
      repoFullName: toText(input.repoFullName).slice(0, 300),
    }
    : { clear: true };
  if (isAdminSession()) body.teacherUserId = toText(input?.teacherUserId || state.teacherUserId);
  state.saving = true;
  state.message = input ? "Guardando el tema..." : "Quitando el tema...";
  renderOverlay();
  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/pilot/topic`, {
      method: "PUT",
      headers: buildApiHeaders(),
      body: JSON.stringify(body),
    }, PILOT_TOPIC_TIMEOUT_MS);
    state.topic = normalizePilotTopicPayload(response?.topic);
    state.teacherUserId = toText(response?.teacherUserId) || state.teacherUserId;
    state.message = toText(response?.message) || (input ? "Tema del piloto guardado." : "Tema del piloto quitado.");
    state.error = "";
    return { ok: true, message: state.message };
  } catch (error) {
    const detail = Number(error?.status) === 404 ? PILOT_TOPIC_UNSUPPORTED_MESSAGE : toText(error?.message) || String(error);
    if (Number(error?.status) === 404) state.unsupported = true;
    state.message = "";
    state.error = input ? `No se pudo guardar el tema: ${detail}` : `No se pudo quitar el tema: ${detail}`;
    return { ok: false, message: state.error };
  } finally {
    state.saving = false;
    renderOverlay();
  }
}

// Tema vigente para un curso (el estudiante: el curso que eligió), o null.
function getActivePilotTopic(courseCode) {
  const topic = overlayState.pilotTopic?.ownerUserId === toText(overlayState.session?.user?.id)
    ? overlayState.pilotTopic.topic
    : null;
  if (!topic || (!topic.week && !topic.title)) return null;
  if (courseCode && normalizeRagCourseCodeUi(courseCode) !== topic.courseCode) return null;
  return topic;
}

/**
 * Semana del tema para el tutor (misma forma que buildCourseWeekForTutor): manda sobre la del
 * calendario mientras el docente tenga el tema puesto en ese curso. null sin tema o sin semana.
 */
function buildPilotTopicWeekForTutor(view) {
  const topic = getActivePilotTopic(view?.courseCode);
  if (!topic || !topic.week) return null;
  const weeks = Array.isArray(view.weeks) ? view.weeks : [];
  const index = weeks.findIndex((entry) => entry.week === topic.week);
  const entry = index >= 0 ? weeks[index] : null;
  const next = index >= 0 ? weeks[index + 1] : null;
  let weekEnd = "";
  if (entry && entry.day !== null && entry.day !== undefined) {
    weekEnd = courseKeyFromDay(next && next.day !== null && next.day !== undefined ? next.day - 1 : entry.day + 6);
  }
  return {
    courseCode: view.courseCode,
    week: topic.week,
    totalWeeks: view.totalWeeks,
    topic: (topic.title || entry?.topic || "").slice(0, 240),
    weekStart: entry?.dateKey || "",
    weekEnd,
    upcoming: (Array.isArray(view.upcoming) ? view.upcoming : []).slice(0, 3).map((evaluation) => ({
      title: evaluation.title.slice(0, 120),
      date: evaluation.dateKey,
      category: evaluation.category,
    })),
  };
}
