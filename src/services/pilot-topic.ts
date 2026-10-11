// Tema del piloto (navegador 0.7.21, 9 de octubre de 2026).
//
// El docente, o el administrador en su nombre, elige en la pestana «Estudiantes» una semana de
// su bitacora, un titulo y el repositorio publico del ejercicio (por ejemplo la semana 7 con
// vbucheli/IMC). Sus estudiantes lo ven en Inicio con «Abrir el ejercicio en mi editor» y el
// tutor recibe esa semana (buildCourseWeekForTutor en el navegador) aunque el calendario vaya en
// otra. Se guarda en pilot_topics (una fila por docente) y lo sirven GET y PUT /api/pilot/topic
// (src/routes/pilot-routes.ts). Aqui: normalizar lo que llega y las semanas de la bitacora para
// elegir, con la misma lectura que la agenda del navegador (services/course-agenda.service.js).
import type { BitacoraAgendaItem } from "./document-classifier.js";
import { trimText } from "./text-utils.js";

export const PILOT_TOPIC_MAX_WEEK = 30;
export const PILOT_TOPIC_TITLE_MAX = 160;

export type PilotTopic = {
  courseCode: string;
  /** Semana de la bitacora (1 a 30); 0 si el docente solo escribio el titulo. */
  week: number;
  title: string;
  /** «usuario/repositorio» de GitHub, o "" sin ejercicio. */
  repoFullName: string;
  updatedAt: string | null;
  updatedByUserId: string | null;
  updatedByName: string | null;
};

export type PilotTopicInput = Pick<PilotTopic, "courseCode" | "week" | "title" | "repoFullName">;

/** Una semana de la bitacora para el selector del tema. */
export type PilotTopicWeek = {
  week: number;
  /** Primer dia con fecha de la semana (aaaa-mm-dd) o "". */
  dateKey: string;
  topic: string;
  activities: string[];
};

const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const EVALUATION_CATEGORIES = ["Parcial", "Proyecto", "Quiz"];

/**
 * «usuario/repositorio» de lo que escriba el docente: usuario/repositorio, el enlace de GitHub
 * (con https, www, .git, /tree/... o ?tab=...) o git@github.com:usuario/repositorio.git. "" si
 * no es un repositorio de GitHub.
 */
export function normalizePilotTopicRepo(value: unknown): string {
  const text = trimText(value).replace(/\s+/g, "");
  if (!text) return "";
  const path = text
    .replace(/^git@github\.com:/i, "")
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return "";
  const parts = path.split(/[?#]/)[0].split("/").filter(Boolean);
  if (parts.length < 2) return "";
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  if (!GITHUB_OWNER.test(owner) || !GITHUB_REPO.test(repo) || /^\.+$/.test(repo)) return "";
  return `${owner}/${repo}`;
}

/** Titulo en una linea y recortado. */
export function normalizePilotTopicTitle(value: unknown): string {
  return trimText(value).replace(/\s+/g, " ").slice(0, PILOT_TOPIC_TITLE_MAX);
}

function agendaField(text: string, label: string) {
  const match = new RegExp(`(?:^|\\|)\\s*${label}\\s*:\\s*([^|]+)`, "i").exec(text);
  return match ? match[1].trim() : "";
}

function agendaItemWeek(item: Partial<BitacoraAgendaItem>) {
  for (const evidence of Array.isArray(item.evidence) ? item.evidence : []) {
    const match = /\bsemana\s*:?\s*(\d{1,2})\b/i.exec(trimText(evidence));
    if (match) return Number(match[1]);
  }
  const match = /^\s*semana\s+(\d{1,2})\b/i.exec(trimText(item.description));
  return match ? Number(match[1]) : 0;
}

function agendaItemSheet(item: Partial<BitacoraAgendaItem>) {
  for (const evidence of Array.isArray(item.evidence) ? item.evidence : []) {
    const match = /^hoja\s*:\s*(.+)$/i.exec(trimText(evidence));
    if (match) return match[1].trim();
  }
  return "";
}

// Evaluaciones y entregas (hoja «Exámenes» o tareas Parcial/Proyecto/Quiz): no dan el tema.
function isAgendaEvaluation(item: Partial<BitacoraAgendaItem>) {
  if (agendaItemSheet(item) === "Exámenes") return true;
  return trimText(item.type) === "task" && EVALUATION_CATEGORIES.includes(trimText(item.category));
}

/**
 * Semanas de la bitacora para elegir el tema: numero, primer dia con fecha, tema (el campo
 * «Tema» o el titulo) y las actividades en clase. Sin las evaluaciones, como la agenda del
 * navegador (buildCourseWeeks).
 */
export function summarizeBitacoraWeeks(items: unknown): PilotTopicWeek[] {
  const weeks = new Map<number, PilotTopicWeek>();
  for (const raw of Array.isArray(items) ? items : []) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Partial<BitacoraAgendaItem>;
    const week = agendaItemWeek(item);
    if (!week || week > PILOT_TOPIC_MAX_WEEK || isAgendaEvaluation(item)) continue;
    const description = trimText(item.description);
    const entry = weeks.get(week) || { week, dateKey: "", topic: "", activities: [] };
    const dateKey = trimText(item.dueAt).slice(0, 10);
    if (DATE_KEY.test(dateKey) && (!entry.dateKey || dateKey < entry.dateKey)) entry.dateKey = dateKey;
    const title = trimText(item.title).replace(/^Examen:\s*/i, "").replace(/\s+/g, " ");
    const topic = agendaField(description, "Tema") || title;
    if (!entry.topic && topic) entry.topic = topic.slice(0, 240);
    for (const activity of agendaField(description, "Actividades en clase").split(/;\s+/)) {
      const clean = activity.trim();
      if (clean && clean !== entry.topic && !entry.activities.includes(clean) && entry.activities.length < 5) {
        entry.activities.push(clean.slice(0, 200));
      }
    }
    weeks.set(week, entry);
  }
  return [...weeks.values()].sort((a, b) => a.week - b.week);
}
