// Campus: analiza una pagina del curso (analyzeCampusPage): actividades, materiales, agenda y recomendaciones.
import { trimText } from "../shared/text-utils.js";
import { type CampusSource, type CampusMaterial, MAX_ITEMS, type CampusAnalyzeInput, MAX_TEXT_CHARS, type CampusAgendaItem, type CampusAnalysis } from "./campus-types.js";
import { normalizeShortText, normalizeUrl, normalizeLongText } from "./campus-text.js";
import { normalizeLinks, normalizeActivities, isTaskActivity, isMaterialActivity, inferAgendaFromOrderedLinks, agendaKey, buildRecommendations } from "./campus-activities.js";

function normalizeSource(value: unknown): CampusSource {
  return trimText(value) === "moodle_api" ? "moodle_api" : "browser_dom";
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
