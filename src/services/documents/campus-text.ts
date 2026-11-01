// Campus: limpieza de texto y enlaces, tipo de actividad y fechas de entrega de una pagina del curso.
import { trimText } from "../shared/text-utils.js";
import { type CampusActivityType } from "./campus-types.js";

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

export function normalizeUrl(value: unknown) {
  return trimText(value).slice(0, 1200);
}

export function normalizeShortText(value: unknown, max = 280) {
  return trimText(value)
    .replace(/\s+/g, " ")
    .slice(0, max);
}

export function normalizeLongText(value: unknown, max = 8000) {
  return trimText(value)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .slice(0, max);
}

export function htmlToText(value: unknown, max = 12000) {
  return normalizeLongText(value, max)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function dedupeKey(...parts: string[]) {
  return parts
    .map((part) => part.toLowerCase().replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("|");
}

export function inferActivityType(input: {
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

export function isNavigationTitle(title: string) {
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

function lineLooksLikeDeadline(line: string) {
  return /\b(fecha\s*(de\s*)?(entrega|limite|límite|cierre)|vence|vencimiento|entregar\s+hasta|disponible\s+hasta|apertura|cerrar|cierra|due\s*date|deadline|available\s*until|closes)\b/i
    .test(line);
}

export function findVisibleDueText(...values: string[]) {
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

export function parseDueAt(value: string) {
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
