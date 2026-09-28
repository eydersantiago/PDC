// ADACEEN | Capa 3 - Servicios: Campus Virtual: analisis de la pagina y acceso al curso. Documentos, agenda y
// bitacora estan en campus-documents.service.js, campus-calendar.service.js y bitacora.service.js.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

function buildCampusAnalyzePayload(context) {
  const source = context || buildPayload();
  return {
    courseId: Number(source.courseId) || null,
    source: "browser_dom",
    url: toText(source.url),
    title: toText(source.title),
    visibleText: toText(source.text).slice(0, 140000),
    selection: toText(source.selection).slice(0, 8000),
    links: Array.isArray(source.links)
      ? source.links
        .map((link) => ({
          text: toText(link?.text).slice(0, 300),
          href: toText(link?.href).slice(0, 1200),
        }))
        .filter((link) => link.href)
        .slice(0, 300)
      : [],
    activities: Array.isArray(source.campusActivities)
      ? source.campusActivities
        .map((activity) => ({
          title: toText(activity?.title).slice(0, 500),
          type: toText(activity?.type).slice(0, 80),
          url: toText(activity?.url).slice(0, 1200),
          description: toText(activity?.description).slice(0, 12000),
          sectionTitle: toText(activity?.sectionTitle).slice(0, 300),
          sectionHtml: toText(activity?.sectionHtml).slice(0, 30000),
          visibleDueText: toText(activity?.visibleDueText).slice(0, 500),
        }))
        .filter((activity) => activity.title || activity.url)
        .slice(0, 300)
      : [],
  };
}

function normalizeCampusAnalysisForState(raw) {
  const source = raw?.analysis || raw || {};
  const stats = source.stats || {};

  return {
    course: {
      id: Number(source.course?.id) || null,
      title: toText(source.course?.title),
      url: toText(source.course?.url),
    },
    source: toText(source.source) || "browser_dom",
    summary: toText(source.summary),
    recommendations: Array.isArray(source.recommendations)
      ? source.recommendations.map(toText).filter(Boolean).slice(0, 12)
      : [],
    agenda: Array.isArray(source.agenda)
      ? source.agenda.map((item) => ({
        title: toText(item?.title),
        type: toText(item?.type),
        url: toText(item?.url),
        dueAt: toText(item?.dueAt),
        visibleDueText: toText(item?.visibleDueText),
      })).filter((item) => item.title || item.url).slice(0, 120)
      : [],
    tasks: Array.isArray(source.tasks)
      ? source.tasks.map((item) => ({
        title: toText(item?.title),
        type: toText(item?.type),
        url: toText(item?.url),
        sectionTitle: toText(item?.sectionTitle),
        visibleDueText: toText(item?.visibleDueText),
        dueAt: toText(item?.dueAt),
      })).filter((item) => item.title || item.url).slice(0, 120)
      : [],
    materials: Array.isArray(source.materials)
      ? source.materials.map((item) => ({
        title: toText(item?.title),
        type: toText(item?.type),
        url: toText(item?.url),
        sectionTitle: toText(item?.sectionTitle),
      })).filter((item) => item.title || item.url).slice(0, 120)
      : [],
    activities: Array.isArray(source.activities)
      ? source.activities.map((item) => ({
        title: toText(item?.title),
        type: toText(item?.type),
        url: toText(item?.url),
        sectionTitle: toText(item?.sectionTitle),
        visibleDueText: toText(item?.visibleDueText),
        dueAt: toText(item?.dueAt),
      })).filter((item) => item.title || item.url).slice(0, 160)
      : [],
    links: Array.isArray(source.links)
      ? source.links.map((item) => ({
        title: toText(item?.title),
        type: toText(item?.type),
        url: toText(item?.url),
      })).filter((item) => item.title || item.url).slice(0, 160)
      : [],
    stats: {
      activityCount: Number(stats.activityCount) || 0,
      taskCount: Number(stats.taskCount) || 0,
      materialCount: Number(stats.materialCount) || 0,
      linkCount: Number(stats.linkCount) || 0,
      deadlineCount: Number(stats.deadlineCount) || 0,
    },
    analyzedAt: new Date().toISOString(),
  };
}

function normalizeCampusCourseAccessState(payload) {
  return {
    ...EMPTY_CAMPUS_COURSE_ACCESS_STATE,
    ...(payload && typeof payload === "object" ? payload : {}),
    checked: payload?.checked === true,
    checking: payload?.checking === true,
    courseCode: toText(payload?.courseCode),
    accessConfirmed: payload?.accessConfirmed === true,
    bitacoraLoaded: payload?.bitacoraLoaded === true,
    bitacoraSource: payload?.bitacoraSource || null,
    sourceCount: Math.max(0, Number(payload?.sourceCount) || 0),
    error: toText(payload?.error),
    message: toText(payload?.message),
  };
}

function getActiveCampusCourseCode(context = overlayState.context) {
  if (overlayState.session?.user?.role === "student" && typeof getSelectedStudentCourseCode === "function") {
    return normalizeRagCourseCodeUi(getSelectedStudentCourseCode());
  }
  if (overlayState.session?.user?.role === "teacher") {
    const state = normalizeTeacherRagStatePayload(overlayState.teacherRagState);
    return normalizeRagCourseCodeUi(state.selectedCourseCode || context?.activityTitle || context?.title || "FPOO");
  }
  return normalizeRagCourseCodeUi(context?.activityTitle || context?.title || "FPOO");
}

function campusRagSourceText(source) {
  const metadata = source?.metadata && typeof source.metadata === "object" ? source.metadata : {};
  return [
    source?.title,
    source?.fileName,
    source?.sourceType,
    metadata.role,
    metadata.category,
    metadata.description,
    metadata.source_pdf,
    metadata.path,
    metadata.rag_use,
  ].map(toText).filter(Boolean).join(" ");
}

function isCampusBitacoraSource(source) {
  const text = campusRagSourceText(source)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return /\b(bitacora|cronograma|agenda|calendario|programacion|programa semanal)\b/.test(text);
}

function getCurrentCampusCourseAccess(context = overlayState.context) {
  const access = normalizeCampusCourseAccessState(overlayState.campusCourseAccess);
  const courseCode = getActiveCampusCourseCode(context);
  if (!courseCode || access.courseCode !== courseCode) {
    return {
      ...EMPTY_CAMPUS_COURSE_ACCESS_STATE,
      courseCode,
    };
  }
  return access;
}

async function verifyCampusCourseAccess(options = {}) {
  overlayState.context = buildPayload();
  const context = overlayState.context;
  const courseCode = getActiveCampusCourseCode(context);

  if (!isCampusCoursePageContext(context)) {
    overlayState.campusCourseAccess = {
      ...EMPTY_CAMPUS_COURSE_ACCESS_STATE,
      courseCode,
      checked: true,
      message: "Abre un curso de Campus Virtual para verificar acceso.",
    };
    if (!options.silent) {
      overlayState.statusMessage = overlayState.campusCourseAccess.message;
    }
    renderOverlay();
    return overlayState.campusCourseAccess;
  }

  if (overlayState.session?.user?.role === "student" && typeof ensureStudentCourseSelection === "function") {
    await ensureStudentCourseSelection({ forceOpen: false });
  }

  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    overlayState.campusCourseAccess = {
      ...EMPTY_CAMPUS_COURSE_ACCESS_STATE,
      courseCode,
      checked: true,
      error: "Inicia sesion para verificar el acceso al curso.",
    };
    if (!options.silent) overlayState.statusMessage = overlayState.campusCourseAccess.error;
    renderOverlay();
    return overlayState.campusCourseAccess;
  }

  overlayState.campusCourseAccess = {
    ...getCurrentCampusCourseAccess(context),
    courseCode,
    checking: true,
    checked: false,
    error: "",
    message: "Verificando bitacora del curso y acceso del estudiante...",
  };
  if (!options.silent) overlayState.statusMessage = overlayState.campusCourseAccess.message;
  renderOverlay();

  try {
    const response = await fetchJsonWithTimeout(
      `${baseUrl}/api/documents/bitacora/status?courseCode=${encodeURIComponent(courseCode)}`,
      {
        method: "GET",
        headers: buildApiHeaders(),
      },
      BACKEND_TIMEOUT_MS,
    );
    const bitacoraSource = response?.latest || null;
    const responseCourseCode = normalizeRagCourseCodeUi(response?.courseCode || courseCode);
    const rows = Number(response?.summary?.rows) || 0;
    overlayState.campusCourseAccess = {
      checked: true,
      checking: false,
      courseCode: responseCourseCode,
      accessConfirmed: response?.ok === true,
      bitacoraLoaded: !!bitacoraSource,
      bitacoraSource,
      sourceCount: rows,
      error: "",
      message: bitacoraSource
        ? `Acceso confirmado: bitacora disponible para ${responseCourseCode}${rows ? ` (${rows} registro(s))` : ""}.`
        : `Acceso confirmado, pero falta cargar bitacora/agenda para ${responseCourseCode}.`,
    };
    // Docente (0.7.16): para el backend es la misma consulta que el estado de su bitacora, asi que
    // tambien lo actualiza (linea de Inicio y pestana «Bitacora») sin otra peticion.
    if (isTeacherSession() && typeof normalizeTeacherBitacoraStatusPayload === "function") {
      overlayState.teacherBitacoraStatus = { ...normalizeTeacherBitacoraStatusPayload(response), checkedAt: Date.now() };
    }
    if (!options.silent) overlayState.statusMessage = overlayState.campusCourseAccess.message;
    return overlayState.campusCourseAccess;
  } catch (error) {
    overlayState.campusCourseAccess = {
      ...EMPTY_CAMPUS_COURSE_ACCESS_STATE,
      checked: true,
      checking: false,
      courseCode,
      error: `No se pudo confirmar acceso al curso: ${String(error?.message || error)}`,
    };
    if (!options.silent) overlayState.statusMessage = overlayState.campusCourseAccess.error;
    return overlayState.campusCourseAccess;
  } finally {
    renderOverlay();
  }
}

// Campus (auditoria de redundancias, item 10): al entrar en un curso, el acceso y la
// bitacora se verifican en silencio (sin tocar el mensaje de estado) y la accion recomendada
// pasa directo a "Analizar Campus". Una sola verificacion a la vez; un acceso ya confirmado con
// bitacora para ese curso (por ejemplo, restaurado de la pestana) no se vuelve a pedir.
let campusAccessVerifyInFlight = null;

function isCampusAccessVerificationInFlight() {
  return !!campusAccessVerifyInFlight;
}

function verifyCampusCourseAccessOnEntry(context = overlayState.context) {
  if (campusAccessVerifyInFlight) return campusAccessVerifyInFlight;
  if (!isCampusCoursePageContext(context) || !overlayState.sessionId || !hasActiveSession()) {
    return Promise.resolve(null);
  }
  const access = getCurrentCampusCourseAccess(context);
  if (access.checked && access.accessConfirmed && access.bitacoraLoaded) {
    return Promise.resolve(access);
  }
  campusAccessVerifyInFlight = verifyCampusCourseAccess({ silent: true })
    .then((result) => {
      // Si algo falta (fallo o bitacora sin cargar), el aviso tambien va al estado (role=status)
      // para que los lectores de pantalla lo anuncien; si sale bien, el estado no cambia.
      if (result?.checked && (result.error || !result.bitacoraLoaded)
        && isCampusCoursePageContext(overlayState.context)) {
        overlayState.statusMessage = result.error || result.message;
      }
      return result;
    })
    .catch(() => null)
    .finally(() => {
      campusAccessVerifyInFlight = null;
      if (overlayEls) renderOverlay();
    });
  return campusAccessVerifyInFlight;
}

async function ensureCampusCourseReadyForHtmlAnalysis(options = {}) {
  const access = getCurrentCampusCourseAccess(overlayState.context);
  const ready = access.checked && access.accessConfirmed && access.bitacoraLoaded;
  const nextAccess = ready ? access : await verifyCampusCourseAccess({ silent: options.silent === true });
  if (nextAccess.accessConfirmed && nextAccess.bitacoraLoaded) return true;

  overlayState.statusMessage = nextAccess.error
    || nextAccess.message
    || "Confirma acceso y carga una bitacora del curso antes de analizar Campus.";
  renderOverlay();
  return false;
}

async function requestCampusPageAnalysis(context) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl) {
    throw new Error("Base URL vacia.");
  }

  const response = await fetchJsonWithTimeout(`${baseUrl}/api/campus/analyze-page`, {
    method: "POST",
    headers: buildApiHeaders(),
    body: JSON.stringify(buildCampusAnalyzePayload(context)),
  }, BACKEND_TIMEOUT_MS);

  if (!response?.ok) {
    throw new Error(toText(response?.error) || "Respuesta invalida del backend Campus.");
  }

  return normalizeCampusAnalysisForState(response.analysis);
}
