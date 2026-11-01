// ADACEEN | Capa 3 - Servicios: bitacora del docente: estado, agrupar la agenda, registro manual,
// plantilla, exportar (Excel/CSV), subir y borrar. La vista (pestana «Bitacora», 0.7.16) esta en
// overlay/content-bitacora.js. Movido desde services/campus.service.js; en la 0.7.16 el estado guarda
// cuando se consulto (checkedAt) y un cambio de bitacora vuelve a verificar el curso de Campus abierto.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const CAMPUS_BITACORA_UPLOAD_MAX_BYTES = 12 * 1024 * 1024;

const CAMPUS_BITACORA_UPLOAD_TIMEOUT_MS = 120000;

const CAMPUS_BITACORA_UPLOAD_ACCEPT = ".xlsx,.xls,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel";

const CAMPUS_BITACORA_ACTIVITY_CATEGORIES = new Set(["Actividad", "Proyecto", "Ejercicio", "Parcial", "Quiz"]);

// checkedAt se conserva al renormalizar el estado actual; la respuesta del backend no lo trae (lo
// pone quien consulta). busy desactiva los botones; checking marca la consulta del estado.
function normalizeTeacherBitacoraStatusPayload(payload) {
  const latest = payload?.latest || null;
  return {
    loaded: payload?.loaded === true || !!latest,
    latest,
    summary: payload?.summary || null,
    busy: false,
    checking: false,
    error: "",
    checkedAt: Math.max(0, Number(payload?.checkedAt) || 0),
  };
}

// Campus (0.7.16): con un curso de Campus abierto, subir o borrar la bitacora vuelve a verificar
// el curso para que la accion recomendada cambie sola («Bitacora requerida» -> «Analizar Campus»).
function syncCampusAccessAfterBitacoraChange() {
  const context = overlayState.context;
  if (typeof isCampusCoursePageContext !== "function" || !isCampusCoursePageContext(context)) return;
  overlayState.campusCourseAccess = { ...EMPTY_CAMPUS_COURSE_ACCESS_STATE };
  if (typeof verifyCampusCourseAccessOnEntry === "function") {
    verifyCampusCourseAccessOnEntry(context).catch(() => {});
  }
}

function getLocalLatestBitacoraItem() {
  const state = typeof normalizeDocumentClassificationState === "function"
    ? normalizeDocumentClassificationState(overlayState.documentClassifications)
    : { items: [] };
  const items = Array.isArray(state.items) ? state.items : [];
  return items.find((item) => item.label === "BITACORA") || null;
}

// La copia local es la del docente; el administrador solo ve la del docente que eligio.
function getTeacherBitacoraDisplayItem() {
  const remoteLatest = overlayState.teacherBitacoraStatus?.latest || null;
  return remoteLatest || (isTeacherSession() ? getLocalLatestBitacoraItem() : null);
}

function getBitacoraEvidenceValue(item, label) {
  const normalizedLabel = normalizeCampusDateText(label);
  const evidence = Array.isArray(item?.evidence) ? item.evidence : [];
  for (const entry of evidence) {
    const text = toText(entry);
    const parts = text.split(":");
    if (parts.length < 2) continue;
    if (normalizeCampusDateText(parts[0]) === normalizedLabel) {
      return parts.slice(1).join(":").trim();
    }
  }
  return "";
}

function getBitacoraDescriptionValue(item, labels) {
  const description = toText(item?.description);
  if (!description) return "";
  const chunks = description.split("|").map((chunk) => chunk.trim()).filter(Boolean);
  const wanted = labels.map((label) => normalizeCampusDateText(label));
  for (const chunk of chunks) {
    const colon = chunk.indexOf(":");
    if (colon < 0) continue;
    const key = normalizeCampusDateText(chunk.slice(0, colon));
    if (wanted.includes(key)) {
      return chunk.slice(colon + 1).trim();
    }
  }
  return "";
}

function removeRepeatedBitacoraText(value) {
  const text = toText(value).replace(/\s+/g, " ").trim();
  const words = text.split(" ").filter(Boolean);
  for (let size = Math.floor(words.length / 2); size >= 1; size -= 1) {
    const first = words.slice(0, size).join(" ").toLowerCase();
    const second = words.slice(size, size * 2).join(" ").toLowerCase();
    if (first && first === second) {
      return words.slice(0, size).join(" ");
    }
  }
  return text;
}

function cleanBitacoraAgendaTitle(item) {
  const title = toText(item?.title).replace(/^Examen:\s*/i, "").trim();
  return removeRepeatedBitacoraText(title);
}

function getBitacoraItemCategory(item) {
  return toText(item?.category)
    || getBitacoraEvidenceValue(item, "Clasificación")
    || getBitacoraDescriptionValue(item, ["Clasificación", "Tipo"]);
}

function normalizeTeacherBitacoraManualCategory(value) {
  const text = toText(value).trim();
  for (const category of CAMPUS_BITACORA_ACTIVITY_CATEGORIES) {
    if (category.toLowerCase() === text.toLowerCase()) return category;
  }
  return "Actividad";
}

function addUniqueText(list, value) {
  const text = toText(value).replace(/\s+/g, " ").trim();
  if (!text) return;
  if (!list.some((item) => normalizeCampusDateText(item) === normalizeCampusDateText(text))) {
    list.push(text);
  }
}

function groupTeacherBitacoraAgenda(agendaItems) {
  const groups = new Map();
  for (const item of agendaItems) {
    const dateText = toText(item?.visibleDueText) || toText(item?.dueAt).slice(0, 10);
    const week = getBitacoraEvidenceValue(item, "Semana");
    const key = `${week || "sin-semana"}|${dateText || "sin-fecha"}`;
    const group = groups.get(key) || {
      week,
      dateText,
      dueAt: toText(item?.dueAt),
      topic: "",
      classActivities: [],
      evaluations: [],
      projects: [],
      exercises: [],
      quizzes: [],
      partials: [],
    };
    const topic = getBitacoraDescriptionValue(item, ["Tema", "Subtipo"]);
    if (!group.topic && topic) group.topic = topic;

    const source = normalizeCampusDateText(getBitacoraEvidenceValue(item, "Hoja"));
    const itemType = toText(item?.type);
    const category = normalizeTeacherBitacoraManualCategory(getBitacoraItemCategory(item));
    const isEvaluation = source.includes("examen") || itemType === "task" || /^examen:/i.test(toText(item?.title));
    const text = getBitacoraDescriptionValue(item, ["Actividades evaluación", "Evaluacion relacionada", "Actividades en clase"])
      || cleanBitacoraAgendaTitle(item);
    if (category === "Proyecto") {
      addUniqueText(group.projects, text);
    } else if (category === "Ejercicio") {
      addUniqueText(group.exercises, text);
    } else if (category === "Parcial") {
      addUniqueText(group.partials, text);
    } else if (category === "Quiz") {
      addUniqueText(group.quizzes, text);
    } else if (isEvaluation) {
      addUniqueText(group.evaluations, getBitacoraDescriptionValue(item, ["Actividades evaluación", "Evaluacion relacionada"]) || cleanBitacoraAgendaTitle(item));
    } else {
      addUniqueText(group.classActivities, getBitacoraDescriptionValue(item, ["Actividades en clase"]) || cleanBitacoraAgendaTitle(item));
    }
    groups.set(key, group);
  }

  return [...groups.values()].sort((left, right) => {
    const leftDate = toText(left.dueAt || left.dateText);
    const rightDate = toText(right.dueAt || right.dateText);
    if (leftDate && rightDate && leftDate !== rightDate) return leftDate.localeCompare(rightDate);
    return (Number(left.week) || 0) - (Number(right.week) || 0);
  });
}

// La bitacora la leen el docente (la suya) y el estudiante (la de su docente, para su agenda,
// 0.7.17). El administrador no tiene bitacora propia: gestiona la de un docente (0.7.22).
function canReadCourseBitacora() {
  const role = overlayState.session?.user?.role;
  return role === "teacher" || role === "student";
}

// Quien consulta el estado en la pestaña «Bitácora»: docente, estudiante y administrador.
function canLoadBitacoraStatus() {
  return canReadCourseBitacora() || isAdminSession();
}

// Quien la cambia (subir, registro manual, fechas, exportar, borrar): el docente, la suya, y el
// administrador, la del docente elegido (teacherUserId en cada peticion).
function canEditCourseBitacora() {
  return isTeacherSession() || isAdminSession();
}

function getBitacoraOwnerTeacherId() {
  return isAdminSession() ? toText(overlayState.bitacoraOwner?.teacherUserId) : "";
}

function getBitacoraOwnerName() {
  const id = getBitacoraOwnerTeacherId();
  const teachers = Array.isArray(overlayState.bitacoraOwner?.teachers) ? overlayState.bitacoraOwner.teachers : [];
  const teacher = teachers.find((entry) => toText(entry?.id) === id);
  return toText(teacher?.displayName) || toText(teacher?.email);
}

function withBitacoraOwnerQuery(url) {
  const id = getBitacoraOwnerTeacherId();
  if (!id) return url;
  return `${url}${url.includes("?") ? "&" : "?"}teacherUserId=${encodeURIComponent(id)}`;
}

function withBitacoraOwnerBody(body) {
  const id = getBitacoraOwnerTeacherId();
  return id ? { ...body, teacherUserId: id } : body;
}

// Antes de cambiar algo: el administrador tiene que haber elegido el docente.
function ensureBitacoraEditable(deniedMessage) {
  if (!canEditCourseBitacora()) {
    overlayState.statusMessage = deniedMessage;
    renderOverlay();
    return false;
  }
  if (isAdminSession() && !getBitacoraOwnerTeacherId()) {
    overlayState.statusMessage = toText(overlayState.bitacoraOwner?.message) || "Elige el docente de la bitácora.";
    renderOverlay();
    return false;
  }
  return true;
}

// Consulta en curso, para que el tutor pueda esperar la semana antes de pedir ayuda.
let teacherBitacoraStatusRequest = null;

function waitForTeacherBitacoraStatus(maxMs = 1500) {
  if (!teacherBitacoraStatusRequest) return Promise.resolve(null);
  return Promise.race([
    teacherBitacoraStatusRequest.catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), maxMs)),
  ]);
}

function refreshTeacherBitacoraStatus() {
  if (teacherBitacoraStatusRequest) return teacherBitacoraStatusRequest;
  const request = requestTeacherBitacoraStatus();
  teacherBitacoraStatusRequest = request;
  request.finally(() => {
    if (teacherBitacoraStatusRequest === request) teacherBitacoraStatusRequest = null;
  }).catch(() => {});
  return request;
}

async function requestTeacherBitacoraStatus() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !canLoadBitacoraStatus()) return null;

  overlayState.teacherBitacoraStatus = {
    ...normalizeTeacherBitacoraStatusPayload(overlayState.teacherBitacoraStatus),
    busy: true,
    checking: true,
    error: "",
  };
  renderOverlay();

  try {
    const response = await fetchJsonWithTimeout(withBitacoraOwnerQuery(`${baseUrl}/api/documents/bitacora/status`), {
      method: "GET",
      headers: buildApiHeaders(),
    }, BACKEND_TIMEOUT_MS);
    overlayState.teacherBitacoraStatus = { ...normalizeTeacherBitacoraStatusPayload(response), checkedAt: Date.now() };
    // Administrador (0.7.22): el docente que eligio el backend (o el pedido) y la lista para elegir.
    if (isAdminSession()) {
      overlayState.bitacoraOwner = {
        teacherUserId: toText(response?.teacherUserId),
        teachers: Array.isArray(response?.teachers) ? response.teachers : [],
        message: toText(response?.message),
      };
    }
    // La copia local (documentClassifications) es la del docente; el estudiante no la mezcla.
    if (response?.latest && isTeacherSession()) {
      const nextItems = mergeUploadedBitacoraClassification(response.latest);
      overlayState.documentClassifications = {
        ...normalizeDocumentClassificationState(overlayState.documentClassifications),
        items: nextItems,
      };
    }
    return overlayState.teacherBitacoraStatus;
  } catch (error) {
    overlayState.teacherBitacoraStatus = {
      ...EMPTY_TEACHER_BITACORA_STATUS,
      busy: false,
      error: `No se pudo consultar la bitácora: ${String(error?.message || error)}`,
    };
    return null;
  } finally {
    renderOverlay();
  }
}
