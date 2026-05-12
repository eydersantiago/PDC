import { trimText, uniqueStrings } from "./text-utils.js";

export type CampusSource = "browser_dom" | "moodle_api";

export type CampusActivityType =
  | "assign"
  | "quiz"
  | "resource"
  | "url"
  | "page"
  | "forum"
  | "book"
  | "folder"
  | "unknown";

export type CampusLinkInput = {
  text?: unknown;
  href?: unknown;
  kind?: unknown;
};

export type CampusActivityInput = {
  title?: unknown;
  type?: unknown;
  url?: unknown;
  description?: unknown;
  sectionTitle?: unknown;
  visibleDueText?: unknown;
  dueAt?: unknown;
};

export type CampusAnalyzeInput = {
  courseId?: number | null;
  source?: unknown;
  url?: unknown;
  title?: unknown;
  visibleText?: unknown;
  text?: unknown;
  selection?: unknown;
  links?: CampusLinkInput[];
  activities?: CampusActivityInput[];
};

export type CampusActivity = {
  id: string;
  courseId: number | null;
  title: string;
  type: CampusActivityType;
  url: string;
  description: string;
  sectionTitle: string;
  visibleDueText: string;
  dueAt: string | null;
  source: CampusSource;
};

export type CampusMaterial = {
  title: string;
  type: CampusActivityType;
  url: string;
  sectionTitle: string;
};

export type CampusAgendaItem = {
  title: string;
  type: CampusActivityType;
  url: string;
  dueAt: string | null;
  visibleDueText: string;
};

export type CampusAnalysis = {
  course: {
    id: number | null;
    title: string;
    url: string;
  };
  source: CampusSource;
  summary: string;
  activities: CampusActivity[];
  tasks: CampusActivity[];
  materials: CampusMaterial[];
  agenda: CampusAgendaItem[];
  recommendations: string[];
  links: CampusMaterial[];
  stats: {
    activityCount: number;
    taskCount: number;
    materialCount: number;
    linkCount: number;
    deadlineCount: number;
  };
};

const MAX_TEXT_CHARS = 120000;
const MAX_ITEMS = 160;

const MONTHS: Record<string, number> = {
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

function padNumber(value: number, size = 2) {
  return String(value).padStart(size, "0");
}

function normalizeSource(value: unknown): CampusSource {
  return trimText(value) === "moodle_api" ? "moodle_api" : "browser_dom";
}

function normalizeUrl(value: unknown) {
  return trimText(value).slice(0, 1200);
}

function normalizeShortText(value: unknown, max = 280) {
  return trimText(value)
    .replace(/\s+/g, " ")
    .slice(0, max);
}

function normalizeLongText(value: unknown, max = 8000) {
  return trimText(value)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .slice(0, max);
}

function parseCourseId(courseId: number | null | undefined, url: string) {
  if (Number.isInteger(courseId) && Number(courseId) > 0) {
    return Number(courseId);
  }

  const match = url.match(/[?&]id=(\d+)/i) || url.match(/[?&]courseid=(\d+)/i);
  if (!match) return null;

  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function dedupeKey(...parts: string[]) {
  return parts
    .map((part) => part.toLowerCase().replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("|");
}

function inferActivityType(input: {
  title: string;
  url: string;
  rawType?: unknown;
}): CampusActivityType {
  const rawType = trimText(input.rawType).toLowerCase();
  if (
    rawType === "assign"
    || rawType === "quiz"
    || rawType === "resource"
    || rawType === "url"
    || rawType === "page"
    || rawType === "forum"
    || rawType === "book"
    || rawType === "folder"
  ) {
    return rawType;
  }

  const url = input.url.toLowerCase();
  if (/\/mod\/assign\//.test(url)) return "assign";
  if (/\/mod\/quiz\//.test(url)) return "quiz";
  if (/\/mod\/resource\//.test(url) || /pluginfile\.php/.test(url) || /\.pdf(?:$|[?#])/.test(url)) return "resource";
  if (/\/mod\/url\//.test(url)) return "url";
  if (/\/mod\/page\//.test(url)) return "page";
  if (/\/mod\/forum\//.test(url)) return "forum";
  if (/\/mod\/book\//.test(url)) return "book";
  if (/\/mod\/folder\//.test(url)) return "folder";

  const text = input.title.toLowerCase();
  if (/\b(tarea|entrega|taller|assignment|subir|subida)\b/.test(text)) return "assign";
  if (/\b(quiz|cuestionario|examen|parcial|prueba)\b/.test(text)) return "quiz";
  if (/\b(foro|forum|discusion|discusión)\b/.test(text)) return "forum";
  if (/\b(pdf|archivo|recurso|lectura|diapositiva|presentacion|presentación)\b/.test(text)) return "resource";
  if (/\b(enlace|link|url|video)\b/.test(text)) return "url";
  if (/\b(pagina|página|contenido)\b/.test(text)) return "page";
  if (/\b(libro|book)\b/.test(text)) return "book";

  return "unknown";
}

function isNavigationTitle(title: string) {
  return [
    /^salta al contenido principal$/i,
    /^pagina principal$/i,
    /^página principal$/i,
    /^area personal$/i,
    /^área personal$/i,
    /^mis cursos$/i,
    /^participantes$/i,
    /^calificaciones$/i,
    /^competencias$/i,
    /^expandir colapsar$/i,
    /^curso$/i,
    /^general$/i,
    /^temas antiguos$/i,
    /^\d+\s+hay\s+\d+\s+conversaciones/i,
  ].some((pattern) => pattern.test(title));
}

function isTaskActivity(activity: CampusActivity) {
  const title = activity.title.toLowerCase();
  if (isNavigationTitle(activity.title)) return false;
  if (activity.type === "assign" || activity.type === "quiz") return true;
  if (activity.dueAt || activity.visibleDueText) return true;
  if (activity.type === "forum") {
    return /\b(evaluable|calificable|entrega|actividad|debate|discusion|discusión)\b/.test(title);
  }
  return /\b(tarea|sustentacion|sustentación|entrega|asignacion|asignación|quiz|parcial|proyecto)\b/.test(title);
}

function isMaterialType(type: CampusActivityType) {
  return type === "resource" || type === "url" || type === "page" || type === "book" || type === "folder";
}

function isMaterialActivity(activity: CampusActivity) {
  if (isNavigationTitle(activity.title)) return false;
  return isMaterialType(activity.type);
}

function looksLikeDateSourceTitle(title: string) {
  return /\b(bitacora|bitácora|agenda|cronograma|calendario|fechas?|programacion|programación|evaluacion|evaluación|sesiones?)\b/i
    .test(title);
}

function findDateSourceMaterial(materials: CampusMaterial[]) {
  return materials.find((material) => looksLikeDateSourceTitle(material.title)) || null;
}

function lineLooksLikeDeadline(line: string) {
  return /\b(fecha\s*(de\s*)?(entrega|limite|límite|cierre)|vence|vencimiento|entregar\s+hasta|disponible\s+hasta|apertura|cerrar|cierra|due\s*date|deadline|available\s*until|closes)\b/i
    .test(line);
}

function findVisibleDueText(...values: string[]) {
  const text = values
    .map((value) => normalizeLongText(value, 30000))
    .filter(Boolean)
    .join("\n");
  if (!text) return "";

  const lines = text
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((line) => normalizeShortText(line, 260))
    .filter(Boolean);

  for (const line of lines) {
    if (line.length < 6) continue;
    if (lineLooksLikeDeadline(line)) return line;
  }

  const fallback = text.match(
    /\b(?:entrega|vence|vencimiento|cierre|deadline|due date)\b.{0,100}(?:\d{1,2}\s*(?:de\s*)?(?:ene|enero|feb|febrero|mar|marzo|abr|abril|may|mayo|jun|junio|jul|julio|ago|agosto|sep|sept|septiembre|oct|octubre|nov|noviembre|dic|diciembre)|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)/i,
  );

  return fallback ? normalizeShortText(fallback[0], 260) : "";
}

function isoFromParts(year: number, monthIndex: number, day: number, hour = 0, minute = 0) {
  if (year < 100) year += 2000;
  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  const date = new Date(Date.UTC(year, monthIndex, day, hour, minute, 0, 0));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== monthIndex
    || date.getUTCDate() !== day
  ) {
    return null;
  }

  return `${padNumber(year, 4)}-${padNumber(monthIndex + 1)}-${padNumber(day)}T${padNumber(hour)}:${padNumber(minute)}:00-05:00`;
}

function extractClockTime(value: string) {
  const match = value.match(/\b(\d{1,2})[:h](\d{2})\b/);
  if (!match) return { hour: 0, minute: 0 };

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { hour: 0, minute: 0 };
  }

  return { hour, minute };
}

function parseDueAt(value: string) {
  const explicit = trimText(value);
  if (!explicit) return null;

  const normalized = explicit
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
  const range = normalized.match(
    /\b(\d{1,2})\s*(?:de\s*)?(?:(ene|enero|feb|febrero|mar|marzo|abr|abril|may|mayo|jun|junio|jul|julio|ago|agosto|sep|sept|septiembre|oct|octubre|nov|noviembre|dic|diciembre)\s*)?(?:-|–|a|hasta)\s*(\d{1,2})\s*(?:de\s*)?(ene|enero|feb|febrero|mar|marzo|abr|abril|may|mayo|jun|junio|jul|julio|ago|agosto|sep|sept|septiembre|oct|octubre|nov|noviembre|dic|diciembre)(?:\s*(?:de\s*)?(\d{2,4}))?/,
  );
  if (range) {
    const now = new Date();
    const day = Number(range[3]);
    const monthIndex = MONTHS[range[4]] ?? -1;
    const year = range[5] ? Number(range[5]) : now.getUTCFullYear();
    const fallbackTime = extractClockTime(explicit);
    const parsed = isoFromParts(year, monthIndex, day, fallbackTime.hour || 9, fallbackTime.minute);
    if (parsed) return parsed;
  }

  const directDate = new Date(explicit);
  if (!Number.isNaN(directDate.getTime()) && /\d{4}-\d{1,2}-\d{1,2}/.test(explicit)) {
    return directDate.toISOString();
  }

  const numeric = explicit.match(
    /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?(?:\D{0,24}(\d{1,2})[:h](\d{2}))?/,
  );
  if (numeric) {
    const now = new Date();
    const day = Number(numeric[1]);
    const monthIndex = Number(numeric[2]) - 1;
    const year = numeric[3] ? Number(numeric[3]) : now.getUTCFullYear();
    const fallbackTime = extractClockTime(explicit);
    const hour = numeric[4] ? Number(numeric[4]) : fallbackTime.hour;
    const minute = numeric[5] ? Number(numeric[5]) : fallbackTime.minute;
    const parsed = isoFromParts(year, monthIndex, day, hour, minute);
    if (parsed) return parsed;
  }

  const spanish = explicit
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .match(
      /\b(\d{1,2})\s*(?:de\s*)?(ene|enero|feb|febrero|mar|marzo|abr|abril|may|mayo|jun|junio|jul|julio|ago|agosto|sep|sept|septiembre|oct|octubre|nov|noviembre|dic|diciembre)(?:\s*(?:de\s*)?(\d{2,4}))?(?:\D{0,24}(\d{1,2})[:h](\d{2}))?/,
    );
  if (spanish) {
    const now = new Date();
    const day = Number(spanish[1]);
    const monthIndex = MONTHS[spanish[2]] ?? -1;
    const year = spanish[3] ? Number(spanish[3]) : now.getUTCFullYear();
    const fallbackTime = extractClockTime(explicit);
    const hour = spanish[4] ? Number(spanish[4]) : fallbackTime.hour;
    const minute = spanish[5] ? Number(spanish[5]) : fallbackTime.minute;
    const parsed = isoFromParts(year, monthIndex, day, hour, minute);
    if (parsed) return parsed;
  }

  return null;
}

function normalizeLinks(links: CampusLinkInput[] | undefined) {
  const seen = new Set<string>();
  const output: CampusMaterial[] = [];

  for (const raw of Array.isArray(links) ? links : []) {
    const title = normalizeShortText(raw?.text || "(sin texto)", 160);
    const url = normalizeUrl(raw?.href);
    if (!url || /^javascript:/i.test(url)) continue;
    if (isNavigationTitle(title) && !/\/mod\//i.test(url)) continue;

    const type = inferActivityType({ title, url, rawType: raw?.kind });
    const key = dedupeKey(title, url);
    if (seen.has(key)) continue;
    seen.add(key);

    output.push({
      title,
      type,
      url,
      sectionTitle: "",
    });
    if (output.length >= MAX_ITEMS) break;
  }

  return output;
}

function normalizeActivities(input: CampusAnalyzeInput, source: CampusSource, courseId: number | null, links: CampusMaterial[]) {
  const seen = new Set<string>();
  const output: CampusActivity[] = [];
  const activityInputs = Array.isArray(input.activities) ? input.activities : [];

  function addActivity(raw: CampusActivityInput, index: number) {
    const title = normalizeShortText(raw.title, 220);
    const url = normalizeUrl(raw.url);
    if (!title && !url) return;

    const description = normalizeLongText(raw.description, 4000);
    const sectionTitle = normalizeShortText(raw.sectionTitle, 180);
    const type = inferActivityType({ title: title || url, url, rawType: raw.type });
    const visibleDueText = normalizeShortText(raw.visibleDueText, 260)
      || findVisibleDueText(title, description);
    const explicitDueAt = trimText(raw.dueAt);
    const dueAt = explicitDueAt || parseDueAt(visibleDueText);
    const key = dedupeKey(title, url, type);
    if (seen.has(key)) return;
    seen.add(key);

    output.push({
      id: `${type}-${output.length + 1}-${index}`,
      courseId,
      title: title || "(actividad sin titulo)",
      type,
      url,
      description,
      sectionTitle,
      visibleDueText,
      dueAt: dueAt || null,
      source,
    });
  }

  activityInputs.slice(0, MAX_ITEMS).forEach(addActivity);

  for (const link of links) {
    if (output.length >= MAX_ITEMS) break;
    if (link.type === "unknown" && !/mod\/|pluginfile|\.pdf/i.test(link.url)) continue;
    addActivity({
      title: link.title,
      type: link.type,
      url: link.url,
      sectionTitle: link.sectionTitle,
    }, output.length);
  }

  const currentTitle = normalizeShortText(input.title, 220);
  const currentUrl = normalizeUrl(input.url);
  const visibleText = normalizeLongText(input.visibleText || input.text, MAX_TEXT_CHARS);
  if (currentTitle && currentUrl && /\/mod\/|pluginfile/i.test(currentUrl)) {
    addActivity({
      title: currentTitle,
      url: currentUrl,
      description: visibleText.slice(0, 4000),
      visibleDueText: findVisibleDueText(visibleText),
    }, output.length);
  }

  return output;
}

function looksLikeDateRangeTitle(value: string) {
  const text = trimText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
  return /\b\d{1,2}\s*(?:de\s*)?(?:[a-z]{3,10})?\s*(?:-|–|a|hasta)\s*\d{1,2}\s*(?:de\s*)?[a-z]{3,10}\b/.test(text)
    || /\b\d{1,2}[/-]\d{1,2}\s*(?:-|–|a|hasta)\s*\d{1,2}[/-]\d{1,2}/.test(text);
}

function isSchedulableCalendarMaterial(item: CampusMaterial) {
  const title = item.title.toLowerCase();
  if (item.type === "assign" || item.type === "quiz") return true;
  return /\b(entrega|examen|quiz|cuestionario|parcial|proyecto|asignacion|asignación|tarea)\b/i.test(title);
}

function agendaKey(item: CampusAgendaItem) {
  return [
    item.title
      .toLowerCase()
      .replace(/\b(asignacion|asignación|cuestionario|carpeta|archivo|url)\b/g, "")
      .replace(/\s+/g, " ")
      .trim(),
    item.url,
    item.dueAt || item.visibleDueText,
  ].join("|");
}

function inferAgendaFromOrderedLinks(links: CampusMaterial[]) {
  const output: CampusAgendaItem[] = [];
  let currentDueText = "";
  let currentDueAt: string | null = null;

  for (const link of links) {
    const parsedDueAt = parseDueAt(link.title);
    if (parsedDueAt && looksLikeDateRangeTitle(link.title)) {
      currentDueText = link.title;
      currentDueAt = parsedDueAt;
      continue;
    }

    if (!currentDueAt || !isSchedulableCalendarMaterial(link)) continue;
    output.push({
      title: link.title,
      type: link.type,
      url: link.url,
      dueAt: currentDueAt,
      visibleDueText: currentDueText,
    });
  }

  return output;
}

function buildRecommendations(params: {
  activities: CampusActivity[];
  tasks: CampusActivity[];
  materials: CampusMaterial[];
  visibleText: string;
  linkCount: number;
}) {
  const recommendations: string[] = [];
  const dateSource = findDateSourceMaterial(params.materials);
  const sortedDueTasks = params.tasks
    .filter((task) => task.dueAt || task.visibleDueText)
    .sort((left, right) => {
      const leftTime = left.dueAt ? new Date(left.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
      const rightTime = right.dueAt ? new Date(right.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
      return leftTime - rightTime;
    });

  if (sortedDueTasks[0]) {
    const task = sortedDueTasks[0];
    recommendations.push(`Prioriza "${task.title}" porque tiene una fecha visible asociada.`);
  } else if (dateSource) {
    recommendations.push(`Primero abre "${dateSource.title}" para buscar fechas de actividades antes de agendar.`);
  }

  if (params.tasks.length > 1) {
    recommendations.push(`Organiza ${params.tasks.length} actividades evaluables en una agenda antes de abrir materiales nuevos.`);
  }

  if (params.materials.length > 0) {
    recommendations.push(`Revisa primero los materiales base: hay ${params.materials.length} recurso(s) o enlace(s) detectado(s).`);
  }

  if (/\b(taller|actividad|entrega|rubrica|rúbrica|criterio|evaluacion|evaluación)\b/i.test(params.visibleText)) {
    recommendations.push("Marca palabras de evaluacion, restricciones y entregables antes de pasar al codigo.");
  }

  if (params.activities.length === 0 && params.linkCount > 0) {
    recommendations.push("Abre las secciones del curso para que ADACEEN pueda detectar mas actividades visibles.");
  }

  if (recommendations.length === 0) {
    recommendations.push("Usa Analizar Campus desde la pagina del curso o de una actividad para construir la agenda preliminar.");
  }

  return uniqueStrings(recommendations).slice(0, 6);
}

export function analyzeCampusPage(input: CampusAnalyzeInput): CampusAnalysis {
  const source = normalizeSource(input.source);
  const url = normalizeUrl(input.url);
  const courseId = parseCourseId(input.courseId ?? null, url);
  const courseTitle = normalizeShortText(input.title, 220) || "Campus Virtual";
  const visibleText = normalizeLongText(input.visibleText || input.text, MAX_TEXT_CHARS);
  const links = normalizeLinks(input.links);
  const activities = normalizeActivities(input, source, courseId, links);
  const tasks = activities
    .filter(isTaskActivity)
    .slice(0, MAX_ITEMS);
  const materials = activities
    .filter(isMaterialActivity)
    .map<CampusMaterial>((activity) => ({
      title: activity.title,
      type: activity.type,
      url: activity.url,
      sectionTitle: activity.sectionTitle,
    }))
    .slice(0, MAX_ITEMS);
  const directAgenda = tasks
    .filter((task) => task.dueAt || task.visibleDueText)
    .map<CampusAgendaItem>((task) => ({
      title: task.title,
      type: task.type,
      url: task.url,
      dueAt: task.dueAt,
      visibleDueText: task.visibleDueText,
    }))
    .sort((left, right) => {
      const leftTime = left.dueAt ? new Date(left.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
      const rightTime = right.dueAt ? new Date(right.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
      return leftTime - rightTime;
    })
    .slice(0, MAX_ITEMS);
  const agendaSeen = new Set<string>();
  const agenda = [...directAgenda, ...inferAgendaFromOrderedLinks(links)]
    .filter((item) => {
      const key = agendaKey(item);
      if (agendaSeen.has(key)) return false;
      agendaSeen.add(key);
      return true;
    })
    .sort((left, right) => {
      const leftTime = left.dueAt ? new Date(left.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
      const rightTime = right.dueAt ? new Date(right.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
      return leftTime - rightTime;
    })
    .slice(0, MAX_ITEMS);

  const recommendations = buildRecommendations({
    activities,
    tasks,
    materials,
    visibleText,
    linkCount: links.length,
  });

  const summaryParts = [
    `Campus analizado desde ${source === "browser_dom" ? "la pagina visible" : "Moodle API"}`,
    courseId ? `curso ${courseId}` : "",
    `${activities.length} actividad(es)`,
    `${tasks.length} tarea(s) o evaluable(s)`,
    `${agenda.length} fecha(s) visible(s)`,
  ].filter(Boolean);

  return {
    course: {
      id: courseId,
      title: courseTitle,
      url,
    },
    source,
    summary: `${summaryParts.join(" | ")}.`,
    activities,
    tasks,
    materials,
    agenda,
    recommendations,
    links,
    stats: {
      activityCount: activities.length,
      taskCount: tasks.length,
      materialCount: materials.length,
      linkCount: links.length,
      deadlineCount: agenda.length,
    },
  };
}
