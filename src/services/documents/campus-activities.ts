// Campus: actividades, materiales, agenda inferida y recomendaciones a partir de los enlaces de la pagina.
import { trimText, uniqueStrings } from "../shared/text-utils.js";
import { type CampusSource, type CampusActivityType, type CampusActivity, type CampusMaterial, type CampusLinkInput, MAX_ITEMS, type CampusAnalyzeInput, type CampusActivityInput, MAX_TEXT_CHARS, type CampusAgendaItem } from "./campus-types.js";
import { isNavigationTitle, normalizeShortText, normalizeUrl, inferActivityType, dedupeKey, htmlToText, normalizeLongText, findVisibleDueText, parseDueAt } from "./campus-text.js";

export function isTaskActivity(activity: CampusActivity) {
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

export function isMaterialActivity(activity: CampusActivity) {
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

export function normalizeLinks(links: CampusLinkInput[] | undefined) {
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

export function normalizeActivities(input: CampusAnalyzeInput, source: CampusSource, courseId: number | null, links: CampusMaterial[]) {
  const seen = new Set<string>();
  const output: CampusActivity[] = [];
  const activityInputs = Array.isArray(input.activities) ? input.activities : [];

  function addActivity(raw: CampusActivityInput, index: number) {
    const title = normalizeShortText(raw.title, 220);
    const url = normalizeUrl(raw.url);
    if (!title && !url) return;

    const sectionHtmlText = htmlToText(raw.sectionHtml, 6000);
    const description = normalizeLongText(raw.description || sectionHtmlText, 4000);
    const sectionTitle = normalizeShortText(raw.sectionTitle, 180);
    const type = inferActivityType({ title: title || url, url, rawType: raw.type });
    const dueSearchText = `${title} ${description} ${sectionHtmlText}`;
    const visibleDueText = normalizeShortText(raw.visibleDueText, 260)
      || findVisibleDueText(dueSearchText);
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

export function agendaKey(item: CampusAgendaItem) {
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

export function inferAgendaFromOrderedLinks(links: CampusMaterial[]) {
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

export function buildRecommendations(params: {
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
