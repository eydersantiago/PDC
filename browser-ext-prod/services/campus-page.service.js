// ADACEEN | Capa 3 - Servicios: lectura del curso de Campus Virtual, verificacion de acceso y analisis del HTML visible.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

function buildCampusAnalyzePayload(context) {
  const source = context || getPageContext();
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

function looksLikeCampusDateSourceTitle(title) {
  return /\b(bitacora|bitácora|agenda|cronograma|fechas?|programacion|programación|evaluacion|evaluación|sesiones?)\b/i
    .test(toText(title));
}

function isCampusCalendarImportExportCandidate(item) {
  const text = `${toText(item?.title)} ${toText(item?.url)}`.toLowerCase();
  return /\/calendar\//i.test(text)
    || /\bir\s+al\s+calendario\b/i.test(text)
    || /\b(importar|exportar)\s+calendarios?\b/i.test(text)
    || /\bcalendar\s+(?:export|import)\b/i.test(text);
}

function scoreCampusDateSourceCandidate(item, sourceKind, index) {
  const title = toText(item?.title);
  const url = toText(item?.url);
  if (!title || !url) return -1;
  if (isCampusCalendarImportExportCandidate(item)) return -1;

  const titleText = title.toLowerCase();
  const urlText = url.toLowerCase();
  let score = 0;

  if (/\b(bitacora|bitácora)\b/i.test(titleText)) score += 120;
  if (/\b(cronograma|fechas?|programacion|programación)\b/i.test(titleText)) score += 90;
  if (/\b(agenda|sesiones?)\b/i.test(titleText)) score += 65;
  if (/\b(evaluacion|evaluación)\b/i.test(titleText)) score += 45;
  if (/\b(bitacora|bitácora|cronograma|fechas?|programacion|programación|agenda|sesiones?|evaluacion|evaluación)\b/i.test(urlText)) {
    score += 70;
  }
  if (score <= 0) return -1;
  if (/pluginfile\.php|\.pdf(?:$|[?#])/i.test(urlText)) score += 55;
  if (/\b(recurso|resource|archivo|file)\b/i.test(`${toText(item?.type)} ${titleText}`)) score += 20;
  if (sourceKind === "materials") score += 12;
  if (sourceKind === "links") score += 6;

  return score > 0 ? score - (Number(index) || 0) / 1000 : -1;
}

function findCampusDateSourceResource(analysis) {
  const groups = [
    ["materials", Array.isArray(analysis?.materials) ? analysis.materials : []],
    ["links", Array.isArray(analysis?.links) ? analysis.links : []],
    ["activities", Array.isArray(analysis?.activities) ? analysis.activities : []],
  ];
  let best = null;
  let bestScore = -1;
  let index = 0;

  for (const [sourceKind, items] of groups) {
    for (const item of items) {
      const score = scoreCampusDateSourceCandidate(item, sourceKind, index);
      index += 1;
      if (score > bestScore) {
        best = item;
        bestScore = score;
      }
    }
  }

  return bestScore > 0 ? best : null;
}

function normalizeCampusComparableUrl(value) {
  try {
    const url = new URL(toText(value), location.href);
    url.hash = "";
    return url.href.replace(/\/+$/g, "").toLowerCase();
  } catch {
    return toText(value).split("#")[0].replace(/\/+$/g, "").toLowerCase();
  }
}

function findCampusDateSourceAnchor(resource) {
  if (isCampusCalendarImportExportCandidate(resource)) return null;

  const targetUrl = normalizeCampusComparableUrl(resource?.url);
  const targetTitle = normalizeText(resource?.title || "").toLowerCase();
  const anchors = Array.from(document.querySelectorAll("a[href]"));

  const scored = anchors.map((anchor, index) => {
    const rawHref = anchor.href || anchor.getAttribute("href");
    const href = normalizeCampusComparableUrl(anchor.href || anchor.getAttribute("href"));
    const text = normalizeText(
      anchor.innerText
      || anchor.textContent
      || anchor.getAttribute("title")
      || anchor.getAttribute("aria-label")
      || "",
    ).toLowerCase();
    const containerText = normalizeText(
      anchor.closest("li, .activity, [data-region='activity-card'], .activity-item, .modtype_resource, .modtype_url")?.textContent
      || "",
    ).toLowerCase();
    const combinedText = `${text} ${containerText}`.trim();
    if (isCampusCalendarImportExportCandidate({ title: combinedText, url: rawHref })) {
      return { anchor, score: -1 };
    }

    const exactUrl = !!targetUrl && href === targetUrl;
    const titleMatches = !!(targetTitle && combinedText) && (
      combinedText === targetTitle
      || combinedText.includes(targetTitle)
      || (targetTitle.includes(text) && text.length > 6)
    );
    let score = 0;

    if (exactUrl) score += 520;
    if (looksLikeCampusDateSourceTitle(combinedText)) score += 140;
    if (/pluginfile\.php|\.pdf(?:$|[?#])/i.test(href) && (exactUrl || titleMatches || looksLikeCampusDateSourceTitle(combinedText))) {
      score += 90;
    }
    if (targetTitle && combinedText) {
      if (combinedText === targetTitle) score += 240;
      else if (combinedText.includes(targetTitle)) score += 210;
      else if (targetTitle.includes(text) && text.length > 6) score += 80;
    }

    return { anchor, score: score - index / 1000 };
  }).filter((entry) => entry.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.anchor || null;
}

function openCampusDateSourceWithLeftClick(resource) {
  const anchor = findCampusDateSourceAnchor(resource);
  const url = toText(resource?.url);

  if (anchor) {
    anchor.scrollIntoView({ block: "center", inline: "center" });
    anchor.focus?.({ preventScroll: true });
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      const isDown = type.endsWith("down");
      const EventCtor = type.startsWith("pointer") && typeof PointerEvent === "function"
        ? PointerEvent
        : MouseEvent;
      anchor.dispatchEvent(new EventCtor(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0,
        buttons: isDown ? 1 : 0,
        pointerType: "mouse",
        isPrimary: true,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      }));
    }
    anchor.click();
    return true;
  }

  if (url) {
    window.location.assign(url);
    return true;
  }

  return false;
}

function openCampusDateSourceFromAnalysisWithLeftClick(analysis, options = {}) {
  const stats = analysis?.stats || {};
  const shouldOpen = options?.force === true
    || (Number(stats.taskCount) > 0 && Number(stats.deadlineCount) === 0);
  if (!shouldOpen) return null;

  const dateSource = findCampusDateSourceResource(analysis);
  if (!dateSource?.url) return null;

  if (!options?.force) {
    const currentUrl = normalizeCampusComparableUrl(options?.currentUrl || location.href);
    const targetUrl = normalizeCampusComparableUrl(dateSource.url);
    if (currentUrl && targetUrl && currentUrl === targetUrl) {
      return { dateSource, opened: false, skipped: true };
    }
  }

  return {
    dateSource,
    opened: openCampusDateSourceWithLeftClick(dateSource),
    skipped: false,
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
  if (overlayState.session?.user?.role === "student") {
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

  if (overlayState.session?.user?.role === "student") {
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

async function openCampusDateSourceFromCurrentAnalysis() {
  overlayState.context = buildPayload();
  const context = overlayState.context;

  if (!isCampusCoursePageContext(context)) {
    overlayState.statusMessage = "Abre Campus Virtual para buscar la bitacora del curso.";
    renderOverlay();
    return;
  }

  overlayState.analysisBusy = true;
  overlayState.statusMessage = "Buscando bitacora o agenda del curso...";
  renderOverlay();

  try {
    const currentUrlKey = toText(context.url).split("#")[0];
    const analysisUrlKey = toText(overlayState.campusAnalysis?.course?.url).split("#")[0];
    if (!overlayState.campusAnalysis || analysisUrlKey !== currentUrlKey) {
      overlayState.campusAnalysis = await requestCampusPageAnalysis(context);
    }

    const dateSource = findCampusDateSourceResource(overlayState.campusAnalysis);
    if (!dateSource?.url) {
      overlayState.statusMessage = "No encontre una bitacora, agenda o calendario visible en esta pagina.";
      return;
    }

    const opened = openCampusDateSourceWithLeftClick(dateSource);
    overlayState.statusMessage = opened
      ? `Abriendo "${dateSource.title}" desde el enlace de Campus...`
      : `No pude abrir "${dateSource.title}" desde esta pagina.`;
  } catch (error) {
    overlayState.statusMessage = `No pude abrir la bitacora: ${String(error)}`;
  } finally {
    overlayState.analysisBusy = false;
    renderOverlay();
  }
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
