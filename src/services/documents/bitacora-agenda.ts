// Agenda de la bitacora: fechas, items por bloque y la tabla semanal (Semana | Fecha | Tema) de los PDF.
import { trimText } from "../shared/text-utils.js";
import { compactText, normalizeDocumentText, roundConfidence } from "./document-text-utils.js";

export type BitacoraAgendaItem = {
  title: string;
  type: "activity" | "task" | "commitment" | "note";
  category?: string;
  dueAt: string | null;
  visibleDueText: string;
  description: string;
  confidence: number;
  evidence: string[];
};

export type BitacoraAgendaExtraction = {
  items: BitacoraAgendaItem[];
  summary: string;
  warnings: string[];
};

const DEFAULT_BITACORA_EVENT_HOUR = 9;

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

function normalizeDateText(value: string) {
  return trimText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function pad(value: number, size = 2) {
  return String(value).padStart(size, "0");
}

function isoFromParts(year: number, monthIndex: number, day: number, hour = DEFAULT_BITACORA_EVENT_HOUR, minute = 0) {
  const normalizedYear = year < 100 ? year + 2000 : year;
  if (
    normalizedYear < 2000
    || monthIndex < 0
    || monthIndex > 11
    || day < 1
    || day > 31
    || hour < 0
    || hour > 23
    || minute < 0
    || minute > 59
  ) {
    return null;
  }

  const date = new Date(Date.UTC(normalizedYear, monthIndex, day, hour, minute, 0, 0));
  if (
    date.getUTCFullYear() !== normalizedYear
    || date.getUTCMonth() !== monthIndex
    || date.getUTCDate() !== day
  ) {
    return null;
  }

  return `${pad(normalizedYear, 4)}-${pad(monthIndex + 1)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00-05:00`;
}

function extractClockTime(value: string) {
  const match = normalizeDateText(value).match(/\b(\d{1,2})[:h](\d{2})\b/);
  if (!match) return { hour: DEFAULT_BITACORA_EVENT_HOUR, minute: 0 };
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { hour: DEFAULT_BITACORA_EVENT_HOUR, minute: 0 };
  }
  return { hour, minute };
}

function parseAgendaDate(value: string) {
  const raw = trimText(value);
  const text = normalizeDateText(raw);
  if (!text) return { dueAt: null, visibleDueText: "" };

  const clock = extractClockTime(text);
  const range = text.match(
    /\b(\d{1,2})\s*(?:de\s*)?(?:([a-z]{3,10})\s*)?(?:-|–|a|hasta)\s*(\d{1,2})\s*(?:de\s*)?([a-z]{3,10})(?:\s*(?:de\s*)?(\d{2,4}))?/,
  );
  if (range) {
    const monthIndex = MONTHS[range[4]] ?? -1;
    const year = range[5] ? Number(range[5]) : new Date().getFullYear();
    const dueAt = isoFromParts(year, monthIndex, Number(range[3]), clock.hour, clock.minute);
    if (dueAt) return { dueAt, visibleDueText: compactText(range[0], 120) };
  }

  const spanishMatches = [...text.matchAll(
    /\b(\d{1,2})\s*(?:de\s*)?(enero|ene|febrero|feb|marzo|mar|abril|abr|mayo|may|junio|jun|julio|jul|agosto|ago|septiembre|sept|sep|octubre|oct|noviembre|nov|diciembre|dic)(?:\s*(?:de\s*)?(\d{2,4}))?/g,
  )];
  const lastSpanish = spanishMatches[spanishMatches.length - 1];
  if (lastSpanish) {
    const monthIndex = MONTHS[lastSpanish[2]] ?? -1;
    const year = lastSpanish[3] ? Number(lastSpanish[3]) : new Date().getFullYear();
    const dueAt = isoFromParts(year, monthIndex, Number(lastSpanish[1]), clock.hour, clock.minute);
    if (dueAt) return { dueAt, visibleDueText: compactText(lastSpanish[0], 120) };
  }

  const numericMatches = [...text.matchAll(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?/g)];
  const lastNumeric = numericMatches[numericMatches.length - 1];
  if (lastNumeric) {
    const year = lastNumeric[3] ? Number(lastNumeric[3]) : new Date().getFullYear();
    const dueAt = isoFromParts(year, Number(lastNumeric[2]) - 1, Number(lastNumeric[1]), clock.hour, clock.minute);
    if (dueAt) return { dueAt, visibleDueText: compactText(lastNumeric[0], 120) };
  }

  return { dueAt: null, visibleDueText: "" };
}

function splitBitacoraChunks(text: string) {
  return trimText(text)
    .replace(/\u00a0/g, " ")
    .split(/\r?\n+|(?<=[.!?])\s+|;+/)
    .map((chunk) => trimText(chunk).replace(/^[\-*\d.)\s]+/, "").trim())
    .filter((chunk) => chunk.length >= 4)
    .slice(0, 500);
}

function classifyAgendaChunkType(chunk: string): BitacoraAgendaItem["type"] {
  const text = normalizeDocumentText(chunk);
  if (/\b(compromiso|pendiente|proxima|proxima\s+sesion|siguiente\s+sesion|por\s+hacer|todo|entrega)\b/.test(text)) {
    return "commitment";
  }
  if (/\b(tarea|actividad|asignacion|quiz|cuestionario|examen|parcial|sustentacion|taller|proyecto)\b/.test(text)) {
    return "task";
  }
  if (/\b(avances?|observaciones?|evidencias?|dificultades?|bloqueos?|acuerdos?)\b/.test(text)) {
    return "note";
  }
  return "activity";
}

function extractAgendaTitle(chunk: string) {
  return compactText(chunk
    .replace(/^semana\s+\d{1,2}\b[:#-]?\s*/i, "")
    .replace(/^fecha\s*[:#-]?\s*\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\s*/i, "")
    .replace(/^(actividades?\s+(realizadas|desarrolladas|ejecutadas)?|compromisos?|pendientes?|tareas?|avances?|observaciones?|evidencias?|dificultades?|bloqueos?|acuerdos?|objetivos?)\s*[:.-]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim(), 180);
}

function looksLikeAgendaChunk(chunk: string) {
  const text = normalizeDocumentText(chunk);
  if (text.length < 6) return false;
  return /\b(actividades?|realizad|desarrollad|ejecutad|compromisos?|pendientes?|tareas?|avances?|evidencias?|observaciones?|dificultades?|bloqueos?|acuerdos?|entregas?|quiz|cuestionarios?|examen|parcial|taller|proyectos?|sustentacion|siguiente\s+sesion|proxima\s+sesion)\b/.test(text);
}

// ---- Tabla semanal (Semana | Fecha | Tema | otra columna) ----
//
// Las bitacoras en PDF (por ejemplo la de FPOO exportada de Google Sheets) salen como texto con
// una fila por semana: «N<tab>d-m-aaaa Tema», a veces con el tema en las lineas siguientes y la
// otra columna (actividades o evaluacion oral) debajo; un tabulador separa columnas cuando
// comparten la linea. Cada fila da un item de la semana (Hoja: Actividades) y un item aparte por
// cada evaluacion o entrega que nombre (Hoja: Exámenes), con las mismas marcas que la plantilla
// en Excel («Semana:», «Tema:», «Actividades en clase:»...), para que la vista, la exportacion y
// la agenda del estudiante las lean igual.

type BitacoraScheduleRow = {
  /** 0 = fila sin numero de semana (por ejemplo «OPCIONAL»). */
  week: number;
  dateText: string;
  dueAt: string;
  visibleDueText: string;
  topic: string;
  activities: string[];
  body: string;
};

const SCHEDULE_ROW_WITH_WEEK = /^\s*(\d{1,2})\s+(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b(.*)$/;

const SCHEDULE_ROW_DATE_ONLY = /^\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b(.*)$/;

const SCHEDULE_LIST_ITEM = /^(?:\d{1,2}[.)]|[-•*])\s/;

// Una linea del tema sigue en la siguiente si termina en una palabra que pide continuacion o en
// «:», «,» o «(», o si la siguiente empieza en minuscula.
const SCHEDULE_CONNECTOR_END = /(?:\b(?:de|del|la|las|el|los|lo|y|e|o|u|a|al|en|con|por|para|sus|su|un|una|unos|unas|que|se|entre|sobre|desde|hacia|como|sin|mediante|segun|según)|[,:;(\-–])$/i;

const SCHEDULE_EVALUATION_KINDS: Array<{ category: string; pattern: RegExp }> = [
  { category: "Parcial", pattern: /\b(examen|parcial)\b/i },
  { category: "Quiz", pattern: /\b(quiz|quices|cuestionario)\b/i },
  { category: "Proyecto", pattern: /\b(entrega|sustentaci[oó]n)\b/i },
];

function splitScheduleCells(line: string) {
  return line
    .replace(/ /g, " ")
    .split(/\t+/)
    .map((cell) => cell.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function continuesScheduleTopic(previous: string, next: string) {
  if (SCHEDULE_LIST_ITEM.test(next)) return false;
  if (/^[a-záéíóúñü]/.test(next)) return true;
  return SCHEDULE_CONNECTOR_END.test(previous.trim());
}

function splitScheduleTopic(firstCells: string[], lineCells: string[][]) {
  const topicParts: string[] = [];
  const activityParts: string[] = [];
  let inTopic = true;
  const push = (cells: string[]) => {
    if (!cells.length) return;
    if (cells.length > 1) {
      // Un tabulador separa las columnas: lo de la izquierda sigue en la columna actual.
      if (inTopic) {
        topicParts.push(cells[0]);
        activityParts.push(...cells.slice(1));
        inTopic = false;
      } else {
        activityParts.push(...cells);
      }
      return;
    }
    const text = cells[0];
    if (inTopic) {
      if (!topicParts.length || continuesScheduleTopic(topicParts[topicParts.length - 1], text)) {
        topicParts.push(text);
        return;
      }
      inTopic = false;
    }
    activityParts.push(text);
  };
  push(firstCells);
  for (const cells of lineCells) push(cells);

  // Parrafos de la otra columna: cada item de lista empieza uno; las lineas partidas se unen.
  const paragraphs: string[] = [];
  for (const part of activityParts) {
    const last = paragraphs[paragraphs.length - 1];
    if (last !== undefined && !SCHEDULE_LIST_ITEM.test(part) && continuesScheduleTopic(last, part)) {
      paragraphs[paragraphs.length - 1] = `${last} ${part}`;
    } else {
      paragraphs.push(part);
    }
  }

  return {
    topic: compactText(topicParts.join(" "), 400),
    activities: paragraphs.map((paragraph) => compactText(paragraph, 400)).filter(Boolean),
  };
}

export function splitBitacoraScheduleRows(text: string) {
  const prepared = trimText(text)
    .replace(/ /g, " ")
    .replace(/[ \t]+(\d{1,2}[ \t]+\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b)/g, "\n$1");
  const lines = prepared.split(/\r?\n+/).filter((line) => line.trim());
  const rows: Array<{ week: number; dateText: string; firstCells: string[]; lineCells: string[][] }> = [];
  let current: (typeof rows)[number] | null = null;

  for (const line of lines) {
    const normalized = normalizeDateText(line.replace(/\t/g, " "));
    if (/^semana\s+fecha\s+tema\b/.test(normalized)) continue;

    const withWeek: RegExpMatchArray | null = line.match(SCHEDULE_ROW_WITH_WEEK);
    const dateOnly: RegExpMatchArray | null = !withWeek && current ? line.match(SCHEDULE_ROW_DATE_ONLY) : null;
    if (withWeek || dateOnly) {
      if (current) rows.push(current);
      current = withWeek
        ? { week: Number(withWeek[1]), dateText: withWeek[2], firstCells: splitScheduleCells(withWeek[3]), lineCells: [] }
        : { week: 0, dateText: dateOnly![1], firstCells: splitScheduleCells(dateOnly![2]), lineCells: [] };
      continue;
    }

    if (current) {
      const cells = splitScheduleCells(line);
      if (cells.length) current.lineCells.push(cells);
    }
  }

  if (current) rows.push(current);

  return rows
    .map((row): BitacoraScheduleRow | null => {
      const date = parseAgendaDate(row.dateText);
      if (!date.dueAt) return null;
      const { topic, activities } = splitScheduleTopic(row.firstCells, row.lineCells);
      return {
        week: row.week,
        dateText: row.dateText,
        dueAt: date.dueAt,
        visibleDueText: date.visibleDueText || row.dateText,
        topic,
        activities,
        body: compactText([topic, ...activities].join(" "), 1000),
      };
    })
    .filter((row): row is BitacoraScheduleRow => !!row);
}

/** Titulo de una evaluacion o entrega: sin guiones bajos y cortado en «:» si el tipo va antes. */
function cleanScheduleEvaluationTitle(text: string, pattern: RegExp) {
  let clean = trimText(text).replace(/_+/g, " ").replace(/\s+/g, " ").replace(/^\d{1,2}[.)]\s+/, "").trim();
  const colon = clean.indexOf(":");
  const match = pattern.exec(clean);
  if (colon > 0 && match && match.index < colon) clean = clean.slice(0, colon).trim();
  if (clean.length > 120 && match && match.index > 0) clean = clean.slice(match.index).trim();
  return compactText(clean.replace(/[.,;:]+$/, ""), 120);
}

function stripAgendaSeparators(value: string) {
  return trimText(value).replace(/\|/g, "/").replace(/\s+/g, " ");
}

function extractBitacoraScheduleAgendaItems(text: string) {
  const rows = splitBitacoraScheduleRows(text);
  const items: BitacoraAgendaItem[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const topic = stripAgendaSeparators(row.topic);
    const activities = row.activities.map(stripAgendaSeparators).filter(Boolean);
    const weekEvidence = row.week ? `Semana: ${row.week}` : "Sin semana";
    const topicCategory = /\b(examen|parcial)\b/i.test(topic) ? "Parcial" : "Actividad";
    const classTitle = compactText(topic || activities[0] || (row.week ? `Semana ${row.week}` : row.visibleDueText), 180);
    const classKey = `${normalizeDocumentText(classTitle)}|${row.dueAt}|clase`;
    if (classTitle && !seen.has(classKey)) {
      seen.add(classKey);
      items.push({
        title: classTitle,
        type: "activity",
        category: topicCategory,
        dueAt: row.dueAt,
        visibleDueText: row.visibleDueText,
        description: compactText([
          `Clasificación: ${topicCategory}`,
          "Tipo: Actividad en clase",
          `Fecha: ${row.visibleDueText}`,
          topic ? `Tema: ${topic}` : "",
          activities.length ? `Actividades en clase: ${activities.join("; ")}` : "",
        ].filter(Boolean).join(" | "), 900),
        confidence: 0.9,
        evidence: ["Hoja: Actividades", weekEvidence, `Clasificación: ${topicCategory}`, "Tipo: Actividad en clase"],
      });
    }

    // Evaluaciones y entregas que nombra la fila (tema u otra columna), cada una aparte.
    for (const candidate of [topic, ...activities]) {
      const kind = SCHEDULE_EVALUATION_KINDS.find((entry) => entry.pattern.test(candidate));
      if (!kind) continue;
      const title = cleanScheduleEvaluationTitle(candidate, kind.pattern);
      const key = `${normalizeDocumentText(title)}|${row.dueAt}|evaluacion`;
      if (!title || seen.has(key)) continue;
      seen.add(key);
      items.push({
        title,
        type: "task",
        category: kind.category,
        dueAt: row.dueAt,
        visibleDueText: row.visibleDueText,
        description: compactText([
          `Clasificación: ${kind.category}`,
          "Tipo: Actividad evaluación",
          `Fecha: ${row.visibleDueText}`,
          topic ? `Tema: ${topic}` : "",
          `Actividades evaluación: ${title}`,
        ].join(" | "), 700),
        confidence: 0.9,
        evidence: ["Hoja: Exámenes", weekEvidence, `Clasificación: ${kind.category}`, "Tipo: Actividad evaluación"],
      });
    }

    if (items.length >= 80) break;
  }

  return items;
}

export function extractBitacoraAgenda(text: string): BitacoraAgendaExtraction {
  const chunks = splitBitacoraChunks(text);
  const items: BitacoraAgendaItem[] = extractBitacoraScheduleAgendaItems(text);
  const warnings: string[] = [];
  const seen = new Set(items.map((item) => `${normalizeDocumentText(item.title)}|${item.dueAt || item.visibleDueText}`));
  let currentDueAt: string | null = null;
  let currentVisibleDueText = "";

  for (const chunk of items.length >= 3 ? [] : chunks) {
    const date = parseAgendaDate(chunk);
    if (date.dueAt) {
      currentDueAt = date.dueAt;
      currentVisibleDueText = date.visibleDueText || compactText(chunk, 120);
    }

    if (!looksLikeAgendaChunk(chunk)) continue;

    const title = extractAgendaTitle(chunk);
    if (!title || /^fecha\b/i.test(title) || /^semana\s+\d+$/i.test(title)) continue;

    const itemDueAt = date.dueAt || currentDueAt;
    const visibleDueText = date.visibleDueText || currentVisibleDueText;
    const key = `${normalizeDocumentText(title)}|${itemDueAt || visibleDueText}`;
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
      title,
      type: classifyAgendaChunkType(chunk),
      dueAt: itemDueAt,
      visibleDueText,
      description: compactText(chunk, 360),
      confidence: roundConfidence(itemDueAt ? 0.82 : 0.62),
      evidence: [
        date.dueAt || currentDueAt ? `Fecha asociada: ${visibleDueText || itemDueAt}` : "",
        `Fragmento: ${compactText(chunk, 160)}`,
      ].filter(Boolean),
    });

    if (items.length >= 30) break;
  }

  if (items.length === 0) {
    warnings.push("No se detectaron actividades o compromisos con estructura suficiente en la bitacora.");
  }

  return {
    items,
    summary: items.length > 0
      ? `Se detectaron ${items.length} actividad(es), compromiso(s) o nota(s) en la bitacora.`
      : "No se detecto agenda estructurada en la bitacora.",
    warnings,
  };
}
