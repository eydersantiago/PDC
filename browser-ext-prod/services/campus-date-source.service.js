"use strict";

// ADACEEN | Capa 3 - Servicios: agenda del Campus, el recurso con las fechas del curso: encontrarlo en la
// pagina y abrirlo con un clic izquierdo. Movido sin cambios de campus-calendar.service.js.

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

  // A12.8: la URL viene del analisis del backend; solo se navega a http/https.
  const safeUrl = toSafeHttpUrl(url, location.href);
  if (safeUrl) {
    window.location.assign(safeUrl);
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
