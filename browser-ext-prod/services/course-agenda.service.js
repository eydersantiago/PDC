// ADACEEN | Capa 3 - Servicios: agenda del curso a partir de la bitacora del docente (0.7.17).
// Semanas, semana actual, evaluaciones y entregas proximas, la semana que se manda al tutor y
// los bloques de estudio sugeridos. Todo se calcula con la hora de Bogota (UTC-5, sin horario de
// verano) para que la semana no cambie segun la zona del equipo. La vista esta en
// overlay/content-agenda.js y Google Calendar en services/google-calendar.service.js.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const COURSE_AGENDA_UTC_OFFSET = "-05:00";
const COURSE_AGENDA_OFFSET_MS = 5 * 60 * 60 * 1000;
const COURSE_AGENDA_DAY_MS = 24 * 60 * 60 * 1000;
const COURSE_AGENDA_WEEKDAYS = Object.freeze(["dom", "lun", "mar", "mié", "jue", "vie", "sáb"]);
const COURSE_AGENDA_MONTHS = Object.freeze(["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]);
const COURSE_AGENDA_EVALUATION_CATEGORIES = Object.freeze(["Parcial", "Proyecto", "Quiz"]);

// Sesiones de estudio que se proponen antes de cada evaluacion: dias antes y duracion.
const COURSE_STUDY_PLAN = Object.freeze({
  Parcial: [{ daysBefore: 5, minutes: 120 }, { daysBefore: 2, minutes: 120 }],
  Proyecto: [{ daysBefore: 4, minutes: 90 }, { daysBefore: 1, minutes: 90 }],
  Quiz: [{ daysBefore: 2, minutes: 60 }],
});
// Horas de inicio que se prueban: entre semana en la noche; sabado y domingo en la manana o la tarde.
const COURSE_STUDY_WEEKDAY_STARTS = Object.freeze(["18:30", "20:00", "16:30"]);
const COURSE_STUDY_WEEKEND_STARTS = Object.freeze(["09:00", "15:00", "11:00"]);
const COURSE_STUDY_MAX_EVALUATIONS = 3;

// ---- Fechas (claves «aaaa-mm-dd» en Bogota) ----

function courseDayFromKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(toText(key));
  if (!match) return null;
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const date = new Date(time);
  if (date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) return null;
  return Math.round(time / COURSE_AGENDA_DAY_MS);
}

function courseKeyFromDay(day) {
  return new Date(day * COURSE_AGENDA_DAY_MS).toISOString().slice(0, 10);
}

function courseTodayKey(nowMs = Date.now()) {
  return new Date(nowMs - COURSE_AGENDA_OFFSET_MS).toISOString().slice(0, 10);
}

// «mar 6 oct»
function formatCourseDay(key) {
  const day = courseDayFromKey(key);
  if (day === null) return toText(key);
  const date = new Date(day * COURSE_AGENDA_DAY_MS);
  return `${COURSE_AGENDA_WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${COURSE_AGENDA_MONTHS[date.getUTCMonth()]}`;
}

// «22–28 sep» o «29 sep – 5 oct»
function formatCourseRange(startKey, endKey) {
  const start = courseDayFromKey(startKey);
  const end = courseDayFromKey(endKey);
  if (start === null || end === null) return "";
  const a = new Date(start * COURSE_AGENDA_DAY_MS);
  const b = new Date(end * COURSE_AGENDA_DAY_MS);
  if (a.getUTCMonth() === b.getUTCMonth()) {
    return `${a.getUTCDate()}–${b.getUTCDate()} ${COURSE_AGENDA_MONTHS[b.getUTCMonth()]}`;
  }
  return `${a.getUTCDate()} ${COURSE_AGENDA_MONTHS[a.getUTCMonth()]} – ${b.getUTCDate()} ${COURSE_AGENDA_MONTHS[b.getUTCMonth()]}`;
}

function describeCourseDaysAway(days) {
  if (days === 0) return "hoy";
  if (days === 1) return "mañana";
  if (days > 1) return `en ${days} días`;
  if (days === -1) return "ayer";
  return `hace ${-days} días`;
}

// «09:00» de un dueAt con hora; si no trae, las 9:00.
function courseTimeOf(dueAt) {
  const match = /T(\d{2}):(\d{2})/.exec(toText(dueAt));
  return match ? `${match[1]}:${match[2]}` : "09:00";
}

function courseInstant(dateKey, time) {
  return `${dateKey}T${time}:00${COURSE_AGENDA_UTC_OFFSET}`;
}

function addMinutesToCourseInstant(instant, minutes) {
  const ms = Date.parse(instant) + minutes * 60 * 1000;
  const local = new Date(ms - COURSE_AGENDA_OFFSET_MS).toISOString();
  return `${local.slice(0, 19)}${COURSE_AGENDA_UTC_OFFSET}`;
}

// «9:00–11:00»
function formatCourseTimeRange(startInstant, endInstant) {
  const time = (instant) => {
    const match = /T(\d{2}):(\d{2})/.exec(toText(instant));
    return match ? `${Number(match[1])}:${match[2]}` : "";
  };
  return `${time(startInstant)}–${time(endInstant)}`;
}

// ---- Items de la bitacora ----

function courseAgendaField(text, label) {
  const match = new RegExp(`(?:^|\\|)\\s*${label}\\s*:\\s*([^|]+)`, "i").exec(toText(text));
  return match ? toText(match[1]).trim() : "";
}

function courseAgendaItemWeek(item) {
  for (const evidence of Array.isArray(item?.evidence) ? item.evidence : []) {
    const match = /\bsemana\s*:?\s*(\d{1,2})\b/i.exec(toText(evidence));
    if (match) return Number(match[1]);
  }
  const match = /^\s*semana\s+(\d{1,2})\b/i.exec(toText(item?.description));
  return match ? Number(match[1]) : 0;
}

function courseAgendaItemSheet(item) {
  for (const evidence of Array.isArray(item?.evidence) ? item.evidence : []) {
    const match = /^hoja\s*:\s*(.+)$/i.exec(toText(evidence));
    if (match) return match[1].trim();
  }
  return "";
}

function cleanCourseAgendaTitle(value) {
  return toText(value).replace(/^Examen:\s*/i, "").replace(/\s+/g, " ").trim();
}

function courseEvaluationCategory(item) {
  const category = toText(item?.category) || courseAgendaField(item?.description, "Clasificación");
  if (COURSE_AGENDA_EVALUATION_CATEGORIES.includes(category)) return category;
  const text = toText(item?.title).toLowerCase();
  if (/\b(quiz|quices|cuestionario)\b/.test(text)) return "Quiz";
  if (/\b(examen|parcial)\b/.test(text)) return "Parcial";
  if (/\b(entrega|proyecto|sustentaci[oó]n)\b/.test(text)) return "Proyecto";
  return "Evaluación";
}

// Evaluaciones y entregas: la hoja «Exámenes» de la plantilla (o del PDF) y las tareas marcadas
// como parcial, proyecto o quiz.
function isCourseAgendaEvaluation(item) {
  if (courseAgendaItemSheet(item) === "Exámenes") return true;
  return toText(item?.type) === "task" && COURSE_AGENDA_EVALUATION_CATEGORIES.includes(toText(item?.category));
}

function courseAgendaKeyText(value) {
  return toText(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// Semanas de la agenda: fecha (la mas temprana de la semana), tema, actividades y evaluaciones.
// Las filas sin semana (por ejemplo «OPCIONAL») quedan aparte en extras.
function buildCourseWeeks(items, courseCode = "") {
  const weeks = new Map();
  const extras = [];
  const evaluations = [];
  const seenEvaluations = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const dateKey = toText(item?.dueAt).slice(0, 10);
    const day = courseDayFromKey(dateKey);
    const week = courseAgendaItemWeek(item);
    const description = toText(item?.description);
    if (isCourseAgendaEvaluation(item)) {
      const title = cleanCourseAgendaTitle(item.title) || courseAgendaField(description, "Actividades evaluación");
      if (!title || day === null) continue;
      const key = `bitacora|${courseAgendaKeyText(courseCode)}|s${week}|${courseAgendaKeyText(title)}`;
      if (seenEvaluations.has(key)) continue;
      seenEvaluations.add(key);
      evaluations.push({
        key,
        week,
        title,
        category: courseEvaluationCategory(item),
        dateKey,
        day,
        time: courseTimeOf(item.dueAt),
        topic: courseAgendaField(description, "Tema"),
      });
      continue;
    }
    if (!week) {
      if (day !== null) extras.push({ dateKey, day, title: cleanCourseAgendaTitle(item.title) });
      continue;
    }
    const entry = weeks.get(week) || { week, dateKey: "", day: null, topic: "", activities: [] };
    if (day !== null && (entry.day === null || day < entry.day)) {
      entry.day = day;
      entry.dateKey = dateKey;
    }
    const topic = courseAgendaField(description, "Tema") || cleanCourseAgendaTitle(item.title);
    if (!entry.topic && topic) entry.topic = topic;
    for (const activity of courseAgendaField(description, "Actividades en clase").split(/;\s+/)) {
      const clean = activity.trim();
      if (clean && clean !== entry.topic && !entry.activities.includes(clean)) entry.activities.push(clean);
    }
    weeks.set(week, entry);
  }
  const sortedWeeks = [...weeks.values()].sort((a, b) => a.week - b.week);
  evaluations.sort((a, b) => a.day - b.day || a.week - b.week);
  for (const evaluation of evaluations) {
    const owner = weeks.get(evaluation.week);
    if (owner) {
      owner.evaluations = owner.evaluations || [];
      owner.evaluations.push(evaluation);
    }
  }
  return {
    weeks: sortedWeeks,
    extras: extras.sort((a, b) => a.day - b.day),
    evaluations,
    totalWeeks: sortedWeeks.length ? sortedWeeks[sortedWeeks.length - 1].week : 0,
  };
}

// Semana de hoy: la ultima que ya empezo, hasta el dia antes de la siguiente (o 7 dias).
function resolveCourseWeek(weeksData, todayKey) {
  const today = courseDayFromKey(todayKey);
  const dated = (weeksData?.weeks || []).filter((week) => week.day !== null);
  if (!dated.length || today === null) return { state: "empty", current: null, next: null, endKey: "" };
  if (today < dated[0].day) return { state: "before", current: null, next: dated[0], endKey: "" };
  let index = 0;
  dated.forEach((week, position) => {
    if (week.day <= today) index = position;
  });
  const current = dated[index];
  const next = dated[index + 1] || null;
  const endDay = next ? next.day - 1 : current.day + 6;
  if (today > endDay) return { state: "after", current, next: null, endKey: courseKeyFromDay(endDay) };
  return { state: "current", current, next, endKey: courseKeyFromDay(endDay) };
}

// Bitacora que ve cada rol: el estudiante solo la de su docente (la del backend); el docente la
// suya, con la copia local si el backend aun no respondio.
function getCourseAgendaItem() {
  if (isTeacherSession()) return typeof getTeacherBitacoraDisplayItem === "function" ? getTeacherBitacoraDisplayItem() : null;
  return overlayState.teacherBitacoraStatus?.latest || null;
}

function getCourseAgendaCourseCode() {
  if (overlayState.session?.user?.role === "student" && typeof getSelectedStudentCourseCode === "function") {
    return getSelectedStudentCourseCode();
  }
  const teacherState = typeof normalizeTeacherRagStatePayload === "function"
    ? normalizeTeacherRagStatePayload(overlayState.teacherRagState)
    : null;
  return normalizeRagCourseCodeUi(teacherState?.selectedCourseCode || overlayState.ragDefaultCourseCode || "FPOO");
}

function getCourseAgendaCourseName(courseCode) {
  if (overlayState.session?.user?.role === "student" && typeof getSelectedStudentCourse === "function") {
    return toText(getSelectedStudentCourse()?.name) || courseCode;
  }
  const course = typeof getRagCourseCatalog === "function"
    ? getRagCourseCatalog().find((entry) => normalizeRagCourseCodeUi(entry?.code) === courseCode)
    : null;
  return toText(course?.name) || courseCode;
}

// Se recalcula solo si cambia la agenda, el curso o el dia (renderOverlay corre muchas veces).
let courseAgendaViewCache = { items: null, courseCode: "", todayKey: "", view: null };

// Lo que muestran Inicio y la pestana «Agenda». state: "loading" | "missing" | "error" | "empty"
// | "before" | "current" | "after".
function getCourseAgendaView(nowMs = Date.now()) {
  const status = overlayState.teacherBitacoraStatus || EMPTY_TEACHER_BITACORA_STATUS;
  const item = getCourseAgendaItem();
  const items = Array.isArray(item?.bitacoraAgenda?.items) ? item.bitacoraAgenda.items : [];
  const courseCode = getCourseAgendaCourseCode();
  const todayKey = courseTodayKey(nowMs);
  const cached = courseAgendaViewCache;
  let base = null;
  if (item && cached.items === items && cached.courseCode === courseCode && cached.todayKey === todayKey && cached.view) {
    base = cached.view;
  } else if (item) {
    const weeksData = buildCourseWeeks(items, courseCode);
    const position = resolveCourseWeek(weeksData, todayKey);
    const today = courseDayFromKey(todayKey);
    base = {
      ...weeksData,
      ...position,
      todayKey,
      upcoming: weeksData.evaluations.filter((evaluation) => evaluation.day >= today),
    };
    courseAgendaViewCache = { items, courseCode, todayKey, view: base };
  }

  let state = "loading";
  if (base) state = base.weeks.length ? base.state : "empty";
  else if (status.checking) state = "loading";
  else if (status.error) state = "error";
  else if (Number(status.checkedAt) > 0) state = "missing";
  return {
    state,
    status,
    courseCode,
    courseName: getCourseAgendaCourseName(courseCode),
    todayKey,
    weeks: base?.weeks || [],
    extras: base?.extras || [],
    evaluations: base?.evaluations || [],
    upcoming: base?.upcoming || [],
    totalWeeks: base?.totalWeeks || 0,
    current: base?.current || null,
    next: base?.next || null,
    endKey: base?.endKey || "",
  };
}

// Semana que va con la peticion al tutor (backend: describeCourseWeek). null fuera del semestre.
// Con el tema del piloto puesto en ese curso (0.7.21, pilot-topic.service.js) va esa semana.
function buildCourseWeekForTutor(nowMs = Date.now()) {
  if (!hasActiveSession() || isAdminSession()) return null;
  const view = getCourseAgendaView(nowMs);
  const pilotWeek = typeof buildPilotTopicWeekForTutor === "function" ? buildPilotTopicWeekForTutor(view) : null;
  if (pilotWeek) return pilotWeek;
  if (view.state !== "current" || !view.current) return null;
  return {
    courseCode: view.courseCode,
    week: view.current.week,
    totalWeeks: view.totalWeeks,
    topic: view.current.topic.slice(0, 240),
    weekStart: view.current.dateKey,
    weekEnd: view.endKey,
    upcoming: view.upcoming.slice(0, 3).map((evaluation) => ({
      title: evaluation.title.slice(0, 120),
      date: evaluation.dateKey,
      category: evaluation.category,
    })),
  };
}

// ---- Bloques de estudio sugeridos ----

function courseStudyStarts(day) {
  const weekday = new Date(day * COURSE_AGENDA_DAY_MS).getUTCDay();
  return weekday === 0 || weekday === 6 ? COURSE_STUDY_WEEKEND_STARTS : COURSE_STUDY_WEEKDAY_STARTS;
}

function courseStudyVerb(category) {
  if (category === "Proyecto") return "Avanzar";
  return "Repasar";
}

function describeCourseStudyReason(step, category) {
  const what = category === "Parcial" ? "del parcial" : category === "Quiz" ? "del quiz" : "de la entrega";
  if (step.daysBefore === 1) return `Un día antes ${what}`;
  return `${step.daysBefore} días antes ${what}`;
}

/**
 * Sesiones de estudio antes de las proximas evaluaciones (hasta 3), en horas sin eventos del
 * calendario. busy: [{ startMs, endMs }] de Google Calendar (vacio si no se pudo leer). Cada
 * sesion busca su dia (y los vecinos, sin llegar al de la evaluacion) y la primera hora libre.
 */
function buildCourseStudySuggestions(input) {
  const nowMs = Number(input?.nowMs) || Date.now();
  const today = courseDayFromKey(courseTodayKey(nowMs));
  const busy = (Array.isArray(input?.busy) ? input.busy : [])
    .filter((slot) => Number.isFinite(slot?.startMs) && Number.isFinite(slot?.endMs));
  const taken = [];
  const suggestions = [];
  const evaluations = (Array.isArray(input?.evaluations) ? input.evaluations : [])
    .filter((evaluation) => evaluation.day > today && COURSE_STUDY_PLAN[evaluation.category])
    .slice(0, COURSE_STUDY_MAX_EVALUATIONS);

  for (const evaluation of evaluations) {
    COURSE_STUDY_PLAN[evaluation.category].forEach((step, index) => {
      const target = evaluation.day - step.daysBefore;
      const offsets = [0, 1, -1, 2, -2, 3];
      for (const offset of offsets) {
        const day = target + offset;
        if (day < today || day >= evaluation.day) continue;
        const dateKey = courseKeyFromDay(day);
        for (const time of courseStudyStarts(day)) {
          const start = courseInstant(dateKey, time);
          const end = addMinutesToCourseInstant(start, step.minutes);
          const startMs = Date.parse(start);
          const endMs = Date.parse(end);
          if (startMs <= nowMs) continue;
          const overlaps = (slot) => startMs < slot.endMs && endMs > slot.startMs;
          if (busy.some(overlaps) || taken.some(overlaps)) continue;
          taken.push({ startMs, endMs });
          suggestions.push({
            // Con la fecha de la evaluacion: si el docente la corre, se pueden agregar otros.
            key: `study|${evaluation.key}|${evaluation.dateKey}|${index + 1}`,
            evaluationKey: evaluation.key,
            evaluationTitle: evaluation.title,
            category: evaluation.category,
            title: `${courseStudyVerb(evaluation.category)}: ${evaluation.title}`,
            dateKey,
            start,
            end,
            label: `${formatCourseDay(dateKey)}, ${formatCourseTimeRange(start, end)}`,
            reason: describeCourseStudyReason(step, evaluation.category),
            selected: true,
          });
          return;
        }
      }
    });
  }
  return suggestions.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}
