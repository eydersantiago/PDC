// ADACEEN | Capa 3 - Servicios: agenda del Campus: fechas de entrega, recurso con las fechas del curso,
// eventos de calendario y sincronizacion con Google Calendar.
// Movido sin cambios desde services/campus.service.js.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const CAMPUS_MONTHS = {
  ene: 0,
  enero: 0,
  feb: 1,
  febrero: 1,
  mar: 2,
  marzo: 2,
  abr: 3,
  abril: 3,
  may: 4,
  mayo: 4,
  jun: 5,
  junio: 5,
  jul: 6,
  julio: 6,
  ago: 7,
  agosto: 7,
  sep: 8,
  sept: 8,
  septiembre: 8,
  oct: 9,
  octubre: 9,
  nov: 10,
  noviembre: 10,
  dic: 11,
  diciembre: 11,
};

function listCalendarItems(items, prefix, maxItems = 8) {
  return (Array.isArray(items) ? items : [])
    .map((item) => toText(item?.title || item))
    .filter(Boolean)
    .slice(0, maxItems)
    .map((title) => `${prefix}: ${title}`);
}

function buildCampusCalendarDraftUrl(context, analysis = overlayState.campusAnalysis) {
  const courseTitle = toText(analysis?.course?.title) || toText(context?.activityTitle) || "Actividad Campus Virtual";
  const deadline = toText(context?.activityDeadline);
  const recommendations = listCalendarItems(analysis?.recommendations, "Recomendacion", 4);
  const tasks = listCalendarItems(analysis?.tasks, "Tarea detectada", 8);
  const materials = listCalendarItems(analysis?.materials, "Material", 6);
  const details = [
    "Actividad detectada por ADACEEN.",
    toText(analysis?.summary),
    deadline ? `Fecha visible: ${deadline}` : "",
    ...recommendations,
    ...tasks,
    ...materials,
    toText(context?.url) ? `Pagina: ${context.url}` : "",
  ].filter(Boolean).join("\n");

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `ADACEEN Campus: ${courseTitle}`,
    details,
  });

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function coerceCalendarDate(value) {
  const date = new Date(toText(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function addCalendarMinutes(date, minutes) {
  return new Date(date.getTime() + (Number(minutes) || 0) * 60 * 1000);
}

function buildCalendarDescription(lines) {
  return lines
    .map((line) => toText(line))
    .filter(Boolean)
    .join("\n");
}

function buildCalendarDateTime(date) {
  return {
    dateTime: date.toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Bogota",
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

function buildProfessorDueEvent(item, context) {
  const dueDate = coerceCalendarDate(item?.dueAt)
    || parseCampusDueDateFromText(item?.visibleDueText)
    || parseCampusDueDateFromText(item?.title);
  if (!dueDate) return null;

  const title = toText(item?.title) || "Actividad Campus Virtual";
  const start = dueDate;
  const end = addCalendarMinutes(start, 30);
  const url = toText(item?.url) || toText(context?.url);

  return {
    summary: `ADACEEN entrega: ${title}`,
    description: buildCalendarDescription([
      "Evento creado por ADACEEN desde una fecha visible de Campus Virtual.",
      "Tipo: tarea programada por el profesor / Campus.",
      toText(item?.visibleDueText) ? `Fecha visible: ${item.visibleDueText}` : "",
      url ? `Pagina: ${url}` : "",
    ]),
    location: url,
    start: buildCalendarDateTime(start),
    end: buildCalendarDateTime(end),
    reminders: {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 24 * 60 },
        { method: "popup", minutes: 60 },
      ],
    },
    extendedProperties: {
      private: {
        adaceen: "campus",
        adaceenType: "professor_due",
      },
    },
  };
}

function buildCampusCalendarEvents(analysis, context) {
  const events = [];
  const agendaItems = [
    ...(Array.isArray(analysis?.agenda) ? analysis.agenda : []),
    ...(Array.isArray(analysis?.tasks) ? analysis.tasks : []),
    ...(Array.isArray(analysis?.activities) ? analysis.activities : []),
  ];
  const seen = new Set();
  const addEvent = (item) => {
    const event = buildProfessorDueEvent(item, context);
    if (!event) return;
    const titleKey = normalizeCampusCalendarTitle(event.summary);
    const key = `${titleKey}|${event.start?.dateTime || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    events.push(event);
  };

  for (const item of agendaItems.slice(0, 20)) {
    addEvent(item);
  }

  const inferredItems = inferCampusCalendarItemsFromOrderedLinks(analysis);
  for (const item of inferredItems.slice(0, 20)) {
    addEvent(item);
  }

  return events;
}

function buildCampusDocumentAgendaAnalysis(documentState = overlayState.documentClassifications) {
  const state = typeof normalizeDocumentClassificationState === "function"
    ? normalizeDocumentClassificationState(documentState)
    : { items: [] };
  const agenda = [];

  for (const documentItem of Array.isArray(state.items) ? state.items : []) {
    if (documentItem.label !== "BITACORA") continue;
    const items = Array.isArray(documentItem.bitacoraAgenda?.items)
      ? documentItem.bitacoraAgenda.items
      : [];
    for (const item of items) {
      agenda.push({
        title: item.title,
        type: item.type === "task" || item.type === "commitment" ? "assign" : "unknown",
        url: documentItem.filePath,
        dueAt: item.dueAt,
        visibleDueText: item.visibleDueText,
        sectionTitle: documentItem.fileName,
      });
    }
  }

  return {
    agenda,
    tasks: [],
    activities: [],
    links: [],
  };
}

function buildCampusDocumentCalendarEvents(context, documentState = overlayState.documentClassifications) {
  return buildCampusCalendarEvents(buildCampusDocumentAgendaAnalysis(documentState), context);
}

function mergeCampusCalendarEvents(groups) {
  const seen = new Set();
  const output = [];
  for (const event of groups.flat()) {
    const key = `${normalizeCampusCalendarTitle(event?.summary)}|${toText(event?.start?.dateTime)}`;
    if (!event || seen.has(key)) continue;
    seen.add(key);
    output.push(event);
  }
  return output;
}

function inferCampusCalendarLinkType(link) {
  const text = normalizeCampusDateText(`${toText(link?.text || link?.title)} ${toText(link?.href || link?.url)}`);
  if (/\b(examen|quiz|cuestionario|parcial|prueba)\b/.test(text) || /\/mod\/quiz\//.test(text)) return "quiz";
  if (/\b(entrega|tarea|asignacion|asignación|assignment|proyecto)\b/.test(text) || /\/mod\/assign\//.test(text)) return "assign";
  return toText(link?.type) || "unknown";
}

function buildCampusCalendarFallbackAnalysis(context) {
  const links = Array.isArray(context?.links) ? context.links : [];
  return {
    links: links.map((link) => ({
      title: toText(link?.text || link?.title),
      type: inferCampusCalendarLinkType(link),
      url: toText(link?.href || link?.url),
    })).filter((link) => link.title || link.url),
    agenda: [],
    tasks: [],
    activities: [],
  };
}

function normalizeCampusCalendarTitle(value) {
  return normalizeCampusDateText(value)
    .replace(/^adaceen entrega:\s*/i, "")
    .replace(/\b(asignacion|asignación|cuestionario|carpeta|archivo|url)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeCampusDateRange(value) {
  const text = normalizeCampusDateText(value);
  return /\b\d{1,2}\s*(?:de\s*)?(?:[a-z]{3,10})?\s*(?:-|–|a|hasta)\s*\d{1,2}\s*(?:de\s*)?[a-z]{3,10}\b/.test(text)
    || /\b\d{1,2}[/-]\d{1,2}\s*(?:-|–|a|hasta)\s*\d{1,2}[/-]\d{1,2}/.test(text);
}

function isCampusSchedulableCalendarItem(item) {
  const type = toText(item?.type);
  const title = normalizeCampusDateText(item?.title);
  if (type === "assign" || type === "quiz") return true;
  return /\b(entrega|examen|quiz|cuestionario|parcial|proyecto|asignacion|asignación|tarea)\b/i.test(title);
}

function inferCampusCalendarItemsFromOrderedLinks(analysis) {
  const links = Array.isArray(analysis?.links) ? analysis.links : [];
  const output = [];
  let currentDueText = "";
  let currentDueDate = null;

  for (const link of links) {
    const title = toText(link?.title);
    const parsedDate = parseCampusDueDateFromText(title);
    if (parsedDate && looksLikeCampusDateRange(title)) {
      currentDueText = title;
      currentDueDate = parsedDate;
      continue;
    }

    if (!currentDueDate || !isCampusSchedulableCalendarItem(link)) continue;
    output.push({
      title,
      type: toText(link?.type) || "assign",
      url: toText(link?.url),
      dueAt: currentDueDate.toISOString(),
      visibleDueText: currentDueText,
      sectionTitle: currentDueText,
    });
  }

  return output;
}

function normalizeCampusDateText(value) {
  return toText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function campusDateFromParts(day, monthIndex, year, hour = 9, minute = 0) {
  const normalizedYear = year && year < 100 ? year + 2000 : (year || new Date().getFullYear());
  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return null;
  const iso = `${String(normalizedYear).padStart(4, "0")}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00-05:00`;
  return coerceCalendarDate(iso);
}

function parseCampusClock(text) {
  const match = normalizeCampusDateText(text).match(/\b(\d{1,2})[:h](\d{2})\b/);
  if (!match) return { hour: 9, minute: 0 };
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return { hour: 9, minute: 0 };
  return { hour, minute };
}

function parseCampusDueDateFromText(value) {
  const text = normalizeCampusDateText(value);
  if (!text) return null;

  const clock = parseCampusClock(text);
  const range = text.match(
    /\b(\d{1,2})\s*(?:de\s*)?([a-z]{3,10})?\s*(?:-|–|a|hasta)\s*(\d{1,2})\s*(?:de\s*)?([a-z]{3,10})(?:\s*(?:de\s*)?(\d{2,4}))?/,
  );
  if (range) {
    const monthKey = range[4];
    const monthIndex = CAMPUS_MONTHS[monthKey];
    if (Number.isInteger(monthIndex)) {
      return campusDateFromParts(Number(range[3]), monthIndex, range[5] ? Number(range[5]) : 0, clock.hour, clock.minute);
    }
  }

  const spanishMatches = [...text.matchAll(/\b(\d{1,2})\s*(?:de\s*)?(enero|ene|febrero|feb|marzo|mar|abril|abr|mayo|may|junio|jun|julio|jul|agosto|ago|septiembre|sept|sep|octubre|oct|noviembre|nov|diciembre|dic)(?:\s*(?:de\s*)?(\d{2,4}))?/g)];
  const lastSpanish = spanishMatches[spanishMatches.length - 1];
  if (lastSpanish) {
    const monthIndex = CAMPUS_MONTHS[lastSpanish[2]];
    if (Number.isInteger(monthIndex)) {
      return campusDateFromParts(Number(lastSpanish[1]), monthIndex, lastSpanish[3] ? Number(lastSpanish[3]) : 0, clock.hour, clock.minute);
    }
  }

  const numericMatches = [...text.matchAll(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?/g)];
  const lastNumeric = numericMatches[numericMatches.length - 1];
  if (lastNumeric) {
    return campusDateFromParts(
      Number(lastNumeric[1]),
      Number(lastNumeric[2]) - 1,
      lastNumeric[3] ? Number(lastNumeric[3]) : 0,
      clock.hour,
      clock.minute,
    );
  }

  return null;
}

async function insertGoogleCalendarEvent(event) {
  const response = await sendRuntimeMessageToBackground({
    type: "ADACEEN_GOOGLE_CALENDAR_INSERT",
    event,
  });

  if (!response?.ok) {
    throw new Error(toText(response?.error) || "Google Calendar no pudo crear el evento.");
  }

  return response.event || {};
}

async function ensureGoogleCalendarAccess() {
  const response = await sendRuntimeMessageToBackground({
    type: "ADACEEN_GOOGLE_CALENDAR_AUTHORIZE",
  });

  if (!response?.ok) {
    throw new Error(toText(response?.error) || "Google Calendar no autorizo la extension.");
  }
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

async function syncCampusCalendarToGoogle() {
  overlayState.context = buildPayload();
  const context = overlayState.context;

  if (!isCampusCoursePageContext(context)) {
    overlayState.statusMessage = "Abre un curso de Campus Virtual para sincronizar tareas con Google Calendar.";
    renderOverlay();
    return;
  }
  if (!await ensureCampusCourseReadyForHtmlAnalysis()) {
    return;
  }

  overlayState.analysisBusy = true;
  overlayState.statusMessage = "Autorizando Google Calendar...";
  renderOverlay();

  try {
    await ensureGoogleCalendarAccess();
    overlayState.statusMessage = "Detectando eventos de Campus para guardar...";
    renderOverlay();

    overlayState.campusAnalysis = await requestCampusPageAnalysis(context);

    const analysis = overlayState.campusAnalysis;
    let events = mergeCampusCalendarEvents([buildCampusCalendarEvents(analysis, context)]);
    if (events.length === 0) {
      events = buildCampusCalendarEvents(buildCampusCalendarFallbackAnalysis(context), context);
    }

    if (events.length === 0) {
      const taskCount = Number(analysis?.stats?.taskCount) || 0;
      overlayState.statusMessage = taskCount
        ? `Se detectaron ${taskCount} actividad(es) en el HTML del curso, pero ninguna tiene fecha clara.`
        : "No hay actividades con fecha clara en el HTML visible del curso.";
      return;
    }

    overlayState.statusMessage = `Creando ${events.length} evento(s) en Google Calendar...`;
    renderOverlay();

    let createdCount = 0;
    let firstEventUrl = "";
    for (const event of events) {
      const created = await insertGoogleCalendarEvent(event);
      createdCount += 1;
      if (!firstEventUrl) firstEventUrl = toText(created?.htmlLink);
    }

    overlayState.analysisUnlocked = true;
    overlayState.statusMessage =
      `Google Calendar actualizado: ${createdCount} evento(s) para tareas y recomendaciones de Campus.`;
    const safeEventUrl = toSafeHttpUrl(firstEventUrl);
    if (safeEventUrl) {
      window.open(safeEventUrl, "_blank", "noopener,noreferrer");
    }
  } catch (error) {
    overlayState.statusMessage =
      `No se pudo crear eventos en Google Calendar: ${String(error)}. Las actividades quedan en el panel de Campus.`;
  } finally {
    overlayState.analysisBusy = false;
    renderOverlay();
  }
}
