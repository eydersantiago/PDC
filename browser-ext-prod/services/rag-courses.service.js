// ADACEEN | Capa 3 - Servicios: catalogo de cursos RAG y curso activo del estudiante.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

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

async function fetchRagCoursesForCurrentSession() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) return null;
  const response = await fetchJsonWithTimeout(`${baseUrl}/api/rag/courses`, {
    method: "GET",
    headers: buildApiHeaders(),
  }, BACKEND_TIMEOUT_MS);
  updateRagCourseCatalogFromResponse(response);
  return response;
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
  renderCourseCheckboxGroup(overlayEls.adminCreateCourseGrid, ["FPOO"], {
    disabled: overlayState.adminUsersBusy || !isStudent,
  });
}

function parseRagPageRangeFromLabel(label) {
  const match = toText(label).match(/\bp\.\s*(\d+)(?:\s*-\s*(\d+))?/i);
  if (!match) return { pageStart: null, pageEnd: null };
  const pageStart = firstPositiveNumber(match[1]);
  const pageEnd = firstPositiveNumber(match[2]) || pageStart;
  return { pageStart, pageEnd };
}

function normalizeRagSourcesForUi(value) {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item) => {
      const source = item && typeof item === "object" ? item : {};
      const citation = source.citation && typeof source.citation === "object" ? source.citation : {};
      const metadata = source.metadata && typeof source.metadata === "object" ? source.metadata : {};
      const citationLabel = toText(source.citationLabel || citation.label || citation.marker);
      const labelPageRange = parseRagPageRangeFromLabel(citationLabel);
      const url = toText(source.url || source.viewerUrl || metadata.viewerUrl || citation.url);
      const externalUrl = toText(source.externalUrl || metadata.externalUrl || citation.externalUrl);
      const sourceId = toText(source.sourceId || source.source_id || source.id || citation.sourceId || citation.source_id);
      const chunkId = toText(source.chunkId || source.chunk_id || citation.chunkId || citation.chunk_id);
      return {
        id: toText(source.id),
        sourceId,
        chunkId,
        scope: toText(source.scope),
        courseCode: normalizeRagCourseCodeUi(source.courseCode || source.course_code || metadata.courseCode || metadata.course_code),
        title: toText(source.title || citation.title),
        fileName: toText(source.fileName || citation.fileName),
        sourceType: toText(source.sourceType),
        knowledgeTier: toText(source.knowledgeTier || metadata.knowledgeTier || metadata.knowledge_tier),
        contextDomain: toText(source.contextDomain || metadata.contextDomain || metadata.context_domain),
        citationLabel,
        pageStart: firstPositiveNumber(
          source.pageStart,
          source.page_start,
          source.page,
          source.pageNumber,
          source.page_number,
          citation.pageStart,
          citation.page_start,
          citation.page,
          citation.pageNumber,
          citation.page_number,
          metadata.pageStart,
          metadata.page_start,
          metadata.page,
          metadata.pageNumber,
          metadata.page_number,
          labelPageRange.pageStart,
        ),
        pageEnd: firstPositiveNumber(
          source.pageEnd,
          source.page_end,
          citation.pageEnd,
          citation.page_end,
          metadata.pageEnd,
          metadata.page_end,
          labelPageRange.pageEnd,
        ),
        excerpt: toText(source.excerpt),
        usageReason: toText(source.usageReason || source.usage_reason || metadata.usageReason || metadata.usage_reason),
        matchedTerms: Array.isArray(source.matchedTerms || source.matched_terms)
          ? (source.matchedTerms || source.matched_terms).map(toText).filter(Boolean).slice(0, 8)
          : [],
        url,
        viewerUrl: url,
        externalUrl,
        isOpenable: Boolean(source.isOpenable || source.is_openable || url || sourceId),
        score: Number(source.score) || 0,
        ftsScore: Number(source.ftsScore || source.fts_score) || 0,
        semanticScore: Number(source.semanticScore || source.semantic_score) || 0,
      };
    })
    .filter((item) => item.title || item.fileName || item.citationLabel)
    .sort((left, right) => {
      if (left.isOpenable !== right.isOpenable) return left.isOpenable ? -1 : 1;
      if (right.score !== left.score) return right.score - left.score;
      return toText(left.title || left.fileName).localeCompare(toText(right.title || right.fileName));
    })
    .slice(0, 5);
}
