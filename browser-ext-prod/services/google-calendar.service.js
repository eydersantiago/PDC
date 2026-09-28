// ADACEEN | Capa 3 - Servicios: la agenda del curso en Google Calendar (0.7.17). Solo con una
// sesion del correo de la universidad y si la cuenta de Google de Chrome es esa misma. Crea las
// evaluaciones y entregas que faltan (las reconoce por la clave privada adaceenKey, asi que no se
// repiten), mueve las que cambiaron de fecha (el docente corrio la bitacora) y agrega los bloques
// de estudio que el estudiante elija. El background.js habla con la API de Google.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const COURSE_CALENDAR_UNIVERSITY_DOMAIN = "correounivalle.edu.co";
const COURSE_CALENDAR_TIME_ZONE = "America/Bogota";

// ---- Mensajes al background ----

async function requestGoogleCalendarAccount() {
  const response = await sendRuntimeMessageToBackground({ type: "ADACEEN_GOOGLE_CALENDAR_ACCOUNT" });
  if (!response?.ok) throw new Error(toText(response?.error) || "No se pudo leer la cuenta de Google.");
  return toText(response.email).toLowerCase();
}

async function listGoogleCalendarEvents(query) {
  const response = await sendRuntimeMessageToBackground({ type: "ADACEEN_GOOGLE_CALENDAR_LIST", query });
  if (!response?.ok) throw new Error(toText(response?.error) || "Google Calendar no devolvio los eventos.");
  return Array.isArray(response.events) ? response.events : [];
}

async function patchGoogleCalendarEvent(eventId, patch) {
  const response = await sendRuntimeMessageToBackground({ type: "ADACEEN_GOOGLE_CALENDAR_PATCH", eventId, patch });
  if (!response?.ok) throw new Error(toText(response?.error) || "Google Calendar no pudo mover el evento.");
  return response.event || {};
}

// ---- Estado ----

function getCourseCalendarState() {
  const state = overlayState.courseCalendar && typeof overlayState.courseCalendar === "object"
    ? overlayState.courseCalendar
    : EMPTY_COURSE_CALENDAR_STATE;
  return {
    ...EMPTY_COURSE_CALENDAR_STATE,
    ...state,
    suggestions: Array.isArray(state.suggestions) ? state.suggestions : [],
  };
}

function setCourseCalendarState(patch) {
  overlayState.courseCalendar = { ...getCourseCalendarState(), ...patch };
  renderOverlay();
}

// Solo con la sesion del correo de la universidad (la del piloto).
function getCourseCalendarEligibility() {
  const email = toText(overlayState.session?.user?.email).toLowerCase();
  if (!email) return { allowed: false, email, reason: "Inicia sesión para sincronizar con Google Calendar." };
  if (!email.endsWith(`@${COURSE_CALENDAR_UNIVERSITY_DOMAIN}`)) {
    return {
      allowed: false,
      email,
      reason: `Para sincronizar con Google Calendar entra a ADACEEN con tu correo de la universidad (…@${COURSE_CALENDAR_UNIVERSITY_DOMAIN}); ahora estás con ${email}.`,
    };
  }
  return { allowed: true, email, reason: "" };
}

// Autoriza Calendar y comprueba que la cuenta de Google sea la de la sesion. Devuelve el correo o
// deja el motivo en el estado y devuelve "".
async function ensureCourseCalendarAccount() {
  const eligibility = getCourseCalendarEligibility();
  if (!eligibility.allowed) {
    setCourseCalendarState({ busy: false, error: eligibility.reason, message: "" });
    return "";
  }
  await ensureGoogleCalendarAccess();
  const account = await requestGoogleCalendarAccount();
  if (account !== eligibility.email) {
    setCourseCalendarState({
      busy: false,
      account,
      error: `Chrome tiene abierta la cuenta de Google ${account || "(sin correo)"}. Para no llenar otro calendario, sincroniza con la misma cuenta de tu sesión: ${eligibility.email}.`,
      message: "",
    });
    return "";
  }
  overlayState.courseCalendar = { ...getCourseCalendarState(), account };
  return account;
}

// ---- Evaluaciones y entregas ----

function buildCourseEvaluationCalendarEvent(evaluation, courseCode) {
  const start = courseInstant(evaluation.dateKey, evaluation.time || "09:00");
  const end = addMinutesToCourseInstant(start, evaluation.category === "Parcial" ? 120 : 60);
  return {
    summary: `${courseCode}: ${evaluation.title}`,
    description: [
      `${evaluation.category} de la semana ${evaluation.week || "?"} en la bitácora de ${courseCode}.`,
      evaluation.topic ? `Tema: ${evaluation.topic}` : "",
      "Evento creado por ADACEEN desde la bitácora del docente.",
    ].filter(Boolean).join("\n"),
    start: { dateTime: start, timeZone: COURSE_CALENDAR_TIME_ZONE },
    end: { dateTime: end, timeZone: COURSE_CALENDAR_TIME_ZONE },
    reminders: {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 24 * 60 },
        { method: "popup", minutes: 60 },
      ],
    },
    extendedProperties: {
      private: {
        adaceen: "bitacora",
        adaceenCourse: courseCode,
        adaceenKey: evaluation.key,
        adaceenType: "evaluation",
        // Fecha de la bitacora con la que se creo: solo se mueve si la bitacora cambia.
        adaceenDate: evaluation.dateKey,
      },
    },
  };
}

function buildCourseStudyCalendarEvent(suggestion, courseCode) {
  return {
    summary: `${suggestion.title} (${courseCode})`,
    description: [
      `Bloque de estudio sugerido por ADACEEN: ${suggestion.reason.toLowerCase()}.`,
      `Evaluación: ${suggestion.evaluationTitle}.`,
    ].join("\n"),
    start: { dateTime: suggestion.start, timeZone: COURSE_CALENDAR_TIME_ZONE },
    end: { dateTime: suggestion.end, timeZone: COURSE_CALENDAR_TIME_ZONE },
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 30 }] },
    extendedProperties: {
      private: {
        adaceen: "bitacora",
        adaceenCourse: courseCode,
        adaceenKey: suggestion.key,
        adaceenType: "study_block",
      },
    },
  };
}

function courseCalendarEventKey(event) {
  return toText(event?.extendedProperties?.private?.adaceenKey);
}

function courseCalendarEventStart(event) {
  return Date.parse(toText(event?.start?.dateTime || event?.start?.date));
}

async function listCourseCalendarEvents(courseCode) {
  return listGoogleCalendarEvents({
    privateExtendedProperty: ["adaceen=bitacora", `adaceenCourse=${courseCode}`],
    singleEvents: true,
    maxResults: 250,
  });
}

// ---- Evaluaciones que el estudiante ya tenia con otro nombre ----
// Un evento del mismo dia que nombra la misma evaluacion (lo creo el estudiante, o vino de Campus
// con «ADACEEN entrega: ...») cuenta como que ya esta: no se crea otro. Se pide bastante parecido
// para no saltarse una evaluacion por el parcial de otra materia ese mismo dia.

const COURSE_CALENDAR_ORDINALS = Object.freeze({
  primer: "1", primero: "1", primera: "1",
  segundo: "2", segunda: "2",
  tercer: "3", tercero: "3", tercera: "3",
  cuarto: "4", cuarta: "4",
  quinto: "5", quinta: "5",
});
const COURSE_CALENDAR_SKIPPED_WORDS = Object.freeze(["adaceen", "del", "las", "los", "con", "para", "por", "una", "uno", "curso"]);

// «entregas», «entregar» -> «entrega»; «parciales» -> «parcial».
function stemCourseCalendarWord(word) {
  if (/^\d+$/.test(word) || word.length < 5) return word;
  if (/[lnr]es$/.test(word)) return word.slice(0, -2);
  if (/[aeiou]s$/.test(word)) return word.slice(0, -1);
  if (word.length >= 6 && /[aei]r$/.test(word)) return word.slice(0, -1);
  return word;
}

function courseCalendarTitleWords(value) {
  const words = toText(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((word) => COURSE_CALENDAR_ORDINALS[word] || word)
    .filter((word) => word && !COURSE_CALENDAR_SKIPPED_WORDS.includes(word) && (word.length >= 3 || /^\d+$/.test(word)))
    .map(stemCourseCalendarWord);
  return [...new Set(words)];
}

// Dia en Bogota del evento («aaaa-mm-dd»), tambien si es de todo el dia.
function courseCalendarEventDayKey(event) {
  const allDay = toText(event?.start?.date);
  if (/^\d{4}-\d{2}-\d{2}$/.test(allDay)) return allDay;
  const startMs = courseCalendarEventStart(event);
  return Number.isFinite(startMs) ? courseTodayKey(startMs) : "";
}

function isCourseCalendarTwin(evaluation, event, courseCode) {
  if (toText(event?.extendedProperties?.private?.adaceen) === "bitacora") return false;
  if (courseCalendarEventDayKey(event) !== evaluation.dateKey) return false;
  const course = toText(courseCode).toLowerCase();
  const wanted = courseCalendarTitleWords(evaluation.title).filter((word) => word !== course);
  if (!wanted.length) return false;
  const have = new Set(courseCalendarTitleWords(event?.summary));
  const shared = wanted.filter((word) => have.has(word)).length;
  if (shared >= Math.min(2, wanted.length) && shared * 3 >= wanted.length * 2) return true;
  // «Parcial FPOO»: nombra el curso y algo de la evaluacion.
  return !!course && have.has(course) && shared >= 1;
}

// Hora «HH:MM» en Bogota y duracion en minutos de un evento con hora.
function courseCalendarEventTime(event) {
  const startMs = courseCalendarEventStart(event);
  return Number.isFinite(startMs) ? new Date(startMs - COURSE_AGENDA_OFFSET_MS).toISOString().slice(11, 16) : "";
}

function courseCalendarEventMinutes(event) {
  const minutes = Math.round((Date.parse(toText(event?.end?.dateTime)) - courseCalendarEventStart(event)) / 60000);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
}

// ¿El docente cambio la fecha? Se compara con la fecha de la bitacora que guarda el evento, asi
// que si el estudiante lo movio de dia o de hora no se le deshace. Eventos sin esa fecha: por el dia.
function courseEvaluationDateChanged(current, evaluation) {
  const recorded = toText(current?.extendedProperties?.private?.adaceenDate);
  if (/^\d{4}-\d{2}-\d{2}$/.test(recorded)) return recorded !== evaluation.dateKey;
  return courseCalendarEventDayKey(current) !== evaluation.dateKey;
}

// Lleva el evento a la nueva fecha de la bitacora con la hora y la duracion que tenia (el
// estudiante pudo cambiarlas en Google Calendar) y guarda la fecha nueva.
function buildCourseEvaluationMovePatch(current, evaluation, event) {
  const extendedProperties = {
    private: { ...(current?.extendedProperties?.private || {}), ...event.extendedProperties.private, adaceenDate: evaluation.dateKey },
  };
  if (toText(current?.start?.date) && !toText(current?.start?.dateTime)) {
    return { start: { date: evaluation.dateKey }, end: { date: courseKeyFromDay(evaluation.day + 1) }, description: event.description, extendedProperties };
  }
  const start = courseInstant(evaluation.dateKey, courseCalendarEventTime(current) || evaluation.time || "09:00");
  const minutes = courseCalendarEventMinutes(current) || (evaluation.category === "Parcial" ? 120 : 60);
  return {
    start: { dateTime: start, timeZone: COURSE_CALENDAR_TIME_ZONE },
    end: { dateTime: addMinutesToCourseInstant(start, minutes), timeZone: COURSE_CALENDAR_TIME_ZONE },
    description: event.description,
    extendedProperties,
  };
}

// Eventos del calendario (de ADACEEN o no) entre hoy y la ultima evaluacion que falta.
async function listCourseCalendarWindow(evaluations) {
  const last = evaluations[evaluations.length - 1];
  if (!last) return [];
  return listGoogleCalendarEvents({
    timeMin: `${courseTodayKey()}T00:00:00${COURSE_AGENDA_UTC_OFFSET}`,
    timeMax: `${last.dateKey}T23:59:59${COURSE_AGENDA_UTC_OFFSET}`,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 250,
  });
}

// Crea las evaluaciones y entregas que faltan desde hoy, pasa al dia nuevo las que cambiaron de
// fecha en la bitacora (con la hora que tengan) y deja igual las que ya estan: con la clave de
// ADACEEN (aunque el estudiante las haya movido) o con otro nombre el mismo dia.
async function syncCourseEvaluationsToGoogleCalendar() {
  const view = getCourseAgendaView();
  if (!view.upcoming.length) {
    setCourseCalendarState({ error: "", message: "No quedan evaluaciones ni entregas en la bitácora desde hoy." });
    return null;
  }
  setCourseCalendarState({ busy: true, error: "", message: "Conectando con Google Calendar..." });
  try {
    if (!await ensureCourseCalendarAccount()) return null;
    setCourseCalendarState({ busy: true, message: "Revisando los eventos que ya están en tu calendario..." });
    const existing = await listCourseCalendarEvents(view.courseCode);
    const byKey = new Map(existing.map((event) => [courseCalendarEventKey(event), event]).filter(([key]) => key));
    const needsWindow = view.upcoming.some((evaluation) => !byKey.has(evaluation.key));
    const sameDays = needsWindow ? await listCourseCalendarWindow(view.upcoming) : [];
    const result = { created: 0, existing: 0, moved: 0, twins: 0, firstLink: "" };
    for (const evaluation of view.upcoming) {
      const event = buildCourseEvaluationCalendarEvent(evaluation, view.courseCode);
      const current = byKey.get(evaluation.key);
      if (!current) {
        if (sameDays.some((candidate) => isCourseCalendarTwin(evaluation, candidate, view.courseCode))) {
          result.twins += 1;
          continue;
        }
        const created = await insertGoogleCalendarEvent(event);
        result.created += 1;
        if (!result.firstLink) result.firstLink = toText(created?.htmlLink);
      } else if (courseEvaluationDateChanged(current, evaluation)) {
        await patchGoogleCalendarEvent(current.id, buildCourseEvaluationMovePatch(current, evaluation, event));
        result.moved += 1;
      } else {
        result.existing += 1;
      }
    }
    const parts = [
      result.created ? `${pluralizeStudentCount(result.created, "evento creado", "eventos creados")}` : "",
      result.moved ? `${pluralizeStudentCount(result.moved, "con la fecha corregida", "con la fecha corregida")}` : "",
      result.existing ? `${pluralizeStudentCount(result.existing, "ya estaba", "ya estaban")}` : "",
      result.twins ? `${pluralizeStudentCount(result.twins, "ya lo tenías con otro nombre", "ya los tenías con otro nombre")}` : "",
    ].filter(Boolean);
    setCourseCalendarState({
      busy: false,
      error: "",
      lastSync: { ...result, at: Date.now() },
      message: `Google Calendar al día: ${parts.join(", ")}.`,
    });
    return result;
  } catch (error) {
    setCourseCalendarState({ busy: false, message: "", error: `No se pudo sincronizar con Google Calendar: ${String(error?.message || error)}` });
    return null;
  }
}

// ---- Bloques de estudio ----

async function readCourseCalendarBusy(view) {
  const last = view.upcoming.slice(0, COURSE_STUDY_MAX_EVALUATIONS).pop();
  if (!last) return [];
  const events = await listGoogleCalendarEvents({
    timeMin: new Date(Date.now()).toISOString(),
    timeMax: `${last.dateKey}T23:59:59${COURSE_AGENDA_UTC_OFFSET}`,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 250,
  });
  return events
    .filter((event) => event?.start?.dateTime && event?.end?.dateTime && event.transparency !== "transparent")
    .map((event) => ({ startMs: Date.parse(event.start.dateTime), endMs: Date.parse(event.end.dateTime) }));
}

// Propone sesiones de estudio en horas libres. Sin permiso de Calendar las propone igual, sin
// mirar el calendario, y lo dice.
async function suggestCourseStudyBlocks() {
  const view = getCourseAgendaView();
  if (!view.upcoming.length) {
    setCourseCalendarState({ suggestions: [], suggestionsNote: "No quedan evaluaciones ni entregas en la bitácora desde hoy." });
    return [];
  }
  setCourseCalendarState({ busy: true, error: "", message: "Buscando horas libres antes de tus próximas evaluaciones..." });
  let busy = [];
  let checkedCalendar = false;
  try {
    if (getCourseCalendarEligibility().allowed && await ensureCourseCalendarAccount()) {
      busy = await readCourseCalendarBusy(view);
      checkedCalendar = true;
    }
  } catch {
    checkedCalendar = false;
  }
  const suggestions = buildCourseStudySuggestions({ evaluations: view.upcoming, busy, nowMs: Date.now() });
  const state = getCourseCalendarState();
  setCourseCalendarState({
    busy: false,
    message: "",
    error: checkedCalendar ? "" : state.error,
    suggestions,
    suggestionsNote: suggestions.length
      ? (checkedCalendar
        ? "Sesiones en horas libres de tu Google Calendar antes de las próximas evaluaciones. Marca las que quieras agregar."
        : "Sesiones antes de las próximas evaluaciones, sin revisar tu calendario. Marca las que quieras agregar.")
      : "No encontré horas libres antes de las próximas evaluaciones.",
  });
  return suggestions;
}

function toggleCourseStudySuggestion(key, selected) {
  const state = getCourseCalendarState();
  setCourseCalendarState({
    suggestions: state.suggestions.map((suggestion) => (suggestion.key === key ? { ...suggestion, selected: !!selected } : suggestion)),
  });
}

async function addSelectedStudyBlocksToGoogleCalendar() {
  const view = getCourseAgendaView();
  const chosen = getCourseCalendarState().suggestions.filter((suggestion) => suggestion.selected);
  if (!chosen.length) {
    setCourseCalendarState({ error: "", message: "Marca al menos un bloque de estudio." });
    return null;
  }
  setCourseCalendarState({ busy: true, error: "", message: "Agregando los bloques de estudio..." });
  try {
    if (!await ensureCourseCalendarAccount()) return null;
    const existing = await listCourseCalendarEvents(view.courseCode);
    const keys = new Set(existing.map(courseCalendarEventKey).filter(Boolean));
    let created = 0;
    let skipped = 0;
    for (const suggestion of chosen) {
      if (keys.has(suggestion.key)) {
        skipped += 1;
        continue;
      }
      await insertGoogleCalendarEvent(buildCourseStudyCalendarEvent(suggestion, view.courseCode));
      created += 1;
    }
    setCourseCalendarState({
      busy: false,
      error: "",
      suggestions: getCourseCalendarState().suggestions.map((suggestion) => (suggestion.selected ? { ...suggestion, added: true } : suggestion)),
      message: `Bloques de estudio: ${[
        created ? pluralizeStudentCount(created, "agregado", "agregados") : "",
        skipped ? pluralizeStudentCount(skipped, "ya estaba", "ya estaban") : "",
      ].filter(Boolean).join(", ")}.`,
    });
    return { created, skipped };
  } catch (error) {
    setCourseCalendarState({ busy: false, message: "", error: `No se pudieron agregar los bloques: ${String(error?.message || error)}` });
    return null;
  }
}
