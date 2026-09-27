// ADACEEN | Capa 3 - Servicios: cursos del backend: catalogo de cursos del RAG, cursos asignados y
// seleccion del curso del estudiante, y las casillas de cursos de los formularios.
// Movido sin cambios desde services/backend.service.js.
// Sin "use strict": el codigo viene de backend.service.js (modo no estricto) y se conserva igual.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

function normalizeRagCourseCodeUi(value) {
  const clean = toText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "");
  if (!clean) return "FPOO";
  if (clean === "FPI" || clean.includes("IMPERATIVA")) return "FPI";
  if (clean === "FPOO" || clean === "POO" || clean.includes("OBJETOS")) return "FPOO";
  if (clean === "FPOE" || clean.includes("EVENTOS")) return "FPOE";
  if (clean === "FPFC" || clean.includes("FUNCIONAL") || clean.includes("CONCURRENTE")) return "FPFC";
  return clean;
}

function normalizeCourseCodesUi(values, fallbackToDefault = true) {
  const rawValues = Array.isArray(values)
    ? values
    : toText(values).split(",");
  const codes = rawValues
    .map((value) => toText(value))
    .filter(Boolean)
    .map((value) => normalizeRagCourseCodeUi(value))
    .filter(Boolean);
  const unique = [...new Set(codes)];
  if (unique.length) return unique;
  return fallbackToDefault ? ["FPOO"] : [];
}

const FALLBACK_RAG_COURSES = [
  { code: "FPI", name: "Fundamentos de programación Imperativa", shortName: "Imperativa", isDefault: false },
  { code: "FPOO", name: "Fundamentos de programación orientada a objetos", shortName: "FPOO", isDefault: true },
  { code: "FPOE", name: "Fundamentos de programación orientada a eventos", shortName: "Eventos", isDefault: false },
  { code: "FPFC", name: "Fundamentos de programación funcional y concurrente", shortName: "Funcional y concurrente", isDefault: false },
];

function getRagCourseCatalog() {
  const catalog = Array.isArray(overlayState.ragCourseCatalog)
    ? overlayState.ragCourseCatalog
    : [];
  if (catalog.length) return catalog;
  const teacherCourses = Array.isArray(overlayState.teacherRagState?.courses)
    ? overlayState.teacherRagState.courses
    : [];
  if (teacherCourses.length) return teacherCourses;
  const studentCourses = Array.isArray(overlayState.studentCourseState?.courses)
    ? overlayState.studentCourseState.courses
    : [];
  if (studentCourses.length) return studentCourses;
  return FALLBACK_RAG_COURSES;
}

function updateRagCourseCatalogFromResponse(response) {
  const courses = Array.isArray(response?.courses) ? response.courses : [];
  if (courses.length) {
    overlayState.ragCourseCatalog = courses;
  }
  overlayState.ragDefaultCourseCode = toText(response?.defaultCourseCode || overlayState.ragDefaultCourseCode || "FPOO") || "FPOO";
  return courses;
}

function getStudentAssignedCourseCodes() {
  return normalizeCourseCodesUi(overlayState.session?.user?.assignedCourseCodes, true);
}

function getSelectedStudentCourseCode() {
  const selected = normalizeRagCourseCodeUi(overlayState.studentCourseState?.selectedCourseCode || "FPOO");
  if (overlayState.session?.user?.role !== "student") return selected;
  const allowed = getStudentAssignedCourseCodes();
  return allowed.includes(selected) ? selected : allowed[0] || "FPOO";
}

function getSelectedStudentCourse() {
  const selected = getSelectedStudentCourseCode();
  return getRagCourseCatalog().find((course) => normalizeRagCourseCodeUi(course?.code) === selected)
    || { code: selected, name: selected, shortName: selected };
}

// Al entrar, fetchCurrentSession y refreshMentorSession piden los cursos del estudiante casi a
// la vez: una respuesta de hace menos de 30 s (o la peticion en curso) de la misma sesion se
// reutiliza. options.fresh fuerza la consulta.
const RAG_COURSES_REUSE_MS = 30000;

let ragCoursesRequest = null;

async function fetchRagCoursesForCurrentSession(options = {}) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const sessionId = toText(overlayState.sessionId);
  if (!baseUrl || !sessionId) return null;
  const cacheKey = `${baseUrl}|${sessionId}`;
  if (options?.fresh !== true
    && ragCoursesRequest
    && ragCoursesRequest.key === cacheKey
    && (ragCoursesRequest.pending || Date.now() - ragCoursesRequest.at < RAG_COURSES_REUSE_MS)) {
    return ragCoursesRequest.promise;
  }
  const entry = { key: cacheKey, at: Date.now(), pending: true, promise: null };
  entry.promise = fetchJsonWithTimeout(`${baseUrl}/api/rag/courses`, {
    method: "GET",
    headers: buildApiHeaders(),
  }, BACKEND_TIMEOUT_MS)
    .then((response) => {
      entry.pending = false;
      entry.at = Date.now();
      updateRagCourseCatalogFromResponse(response);
      return response;
    })
    .catch((error) => {
      // Un fallo no se reutiliza: la siguiente llamada vuelve a consultar.
      if (ragCoursesRequest === entry) ragCoursesRequest = null;
      throw error;
    });
  ragCoursesRequest = entry;
  return entry.promise;
}

async function ensureStudentCourseSelection(options = {}) {
  if (overlayState.session?.user?.role !== "student") {
    overlayState.studentCourseModalOpen = false;
    return null;
  }

  overlayState.studentCourseState = {
    ...(overlayState.studentCourseState || EMPTY_STUDENT_COURSE_STATE),
    busy: true,
    error: "",
    message: "",
  };
  renderOverlay();

  try {
    const response = await fetchRagCoursesForCurrentSession();
    const assigned = normalizeCourseCodesUi(response?.assignedCourseCodes || overlayState.session?.user?.assignedCourseCodes, true);
    const courses = Array.isArray(response?.courses) && response.courses.length
      ? response.courses
      : getRagCourseCatalog().filter((course) => assigned.includes(normalizeRagCourseCodeUi(course?.code)));
    const selected = normalizeRagCourseCodeUi(overlayState.studentCourseState?.selectedCourseCode || assigned[0] || "FPOO");
    const nextSelected = assigned.length === 1
      ? assigned[0]
      : (assigned.includes(selected) ? selected : assigned[0] || "FPOO");
    overlayState.session.user.assignedCourseCodes = assigned;
    overlayState.session.user.activeCourseCode = nextSelected;
    overlayState.studentCourseState = {
      courses,
      selectedCourseCode: nextSelected,
      defaultCourseCode: toText(response?.defaultCourseCode || overlayState.ragDefaultCourseCode || "FPOO") || "FPOO",
      busy: false,
      error: "",
      message: assigned.length === 1 ? `Curso activo: ${nextSelected}.` : "",
    };
    overlayState.studentCourseModalOpen = options.forceOpen === true && assigned.length > 1;
    await persistPreferences();
    return overlayState.studentCourseState;
  } catch (error) {
    overlayState.studentCourseState = {
      ...(overlayState.studentCourseState || EMPTY_STUDENT_COURSE_STATE),
      courses: getRagCourseCatalog().filter((course) => getStudentAssignedCourseCodes().includes(normalizeRagCourseCodeUi(course?.code))),
      busy: false,
      error: `No se pudieron cargar cursos: ${String(error?.message || error)}`,
    };
    overlayState.studentCourseModalOpen = options.forceOpen === true;
    return null;
  } finally {
    renderOverlay();
  }
}

async function confirmStudentCourseSelection() {
  if (overlayState.session?.user?.role !== "student") return;
  const selected = getSelectedStudentCourseCode();
  const previous = normalizeRagCourseCodeUi(overlayState.studentCourseState?.selectedCourseCode || "");
  overlayState.studentCourseState = {
    ...(overlayState.studentCourseState || EMPTY_STUDENT_COURSE_STATE),
    selectedCourseCode: selected,
    busy: false,
    error: "",
    message: "Curso activo actualizado.",
  };
  overlayState.session.user.activeCourseCode = selected;
  if (previous && previous !== selected) {
    overlayState.campusCourseAccess = { ...EMPTY_CAMPUS_COURSE_ACCESS_STATE };
    overlayState.campusAnalysis = null;
    overlayState.activeRagCourseCode = "";
  }
  overlayState.studentCourseModalOpen = false;
  await persistPreferences();
  if (overlayState.started) {
    await refreshMentorSession();
  } else {
    renderOverlay();
  }
}

function renderCourseCheckboxGroup(container, selectedCodes, options = {}) {
  if (!container) return;
  const selected = new Set(normalizeCourseCodesUi(selectedCodes, options.fallbackToDefault !== false));
  const courses = getRagCourseCatalog();
  container.textContent = "";
  for (const course of courses) {
    const code = normalizeRagCourseCodeUi(course?.code);
    const label = document.createElement("label");
    label.className = "course-chip";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = code;
    input.checked = selected.has(code);
    input.disabled = options.disabled === true;
    const span = document.createElement("span");
    span.textContent = toText(course?.shortName || course?.code || code);
    label.append(input, span);
    container.appendChild(label);
  }
}

function getCheckedCourseCodes(container) {
  const checked = [...(container?.querySelectorAll?.("input[type='checkbox']:checked") || [])]
    .map((input) => normalizeRagCourseCodeUi(input.value))
    .filter(Boolean);
  return normalizeCourseCodesUi(checked, true);
}

function renderAdminCreateCourseGrid() {
  if (!overlayEls?.adminCreateCourseGrid) return;
  const isStudent = toText(overlayEls.adminCreateRole?.value).toLowerCase() !== "teacher";
  const disabled = overlayState.adminUsersBusy || !isStudent;
  const catalogKey = JSON.stringify(getRagCourseCatalog().map((course) => [toText(course?.code), toText(course?.shortName)]));
  // Sin cambios de catalogo solo se actualiza "disabled": no se pierden las casillas marcadas
  // ni el foco del teclado en cada render.
  if (!renderKeyChanged(overlayEls.adminCreateCourseGrid, catalogKey)) {
    overlayEls.adminCreateCourseGrid.querySelectorAll("input[type='checkbox']").forEach((input) => {
      input.disabled = disabled;
    });
    return;
  }
  renderCourseCheckboxGroup(overlayEls.adminCreateCourseGrid, ["FPOO"], { disabled });
}
