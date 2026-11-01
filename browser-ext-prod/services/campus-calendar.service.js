// ADACEEN | Capa 3 - Servicios: agenda del Campus: fechas de entrega, recurso con las fechas del curso,
// eventos de calendario y sincronizacion con Google Calendar.
// Movido sin cambios desde services/campus.service.js.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

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
