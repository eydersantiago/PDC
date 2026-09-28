import type { BitacoraAgendaExtraction, BitacoraAgendaItem } from "./document-classifier.js";
import { trimText } from "./text-utils.js";

/**
 * «Inicio del semestre» (navegador 0.7.17): corre todas las fechas de la bitacora cargada para
 * que la semana 1 quede en la fecha elegida. Todas se mueven el mismo numero de dias, asi que las
 * semanas conservan su distancia (cada 7 dias en una bitacora semanal) y las filas sin semana
 * (por ejemplo «OPCIONAL») se mueven igual. Sirve para reutilizar la bitacora de otro semestre:
 * la de FPOO 2025 (semana 1 el 20-8-2025) con inicio el 2026-08-25 deja la semana 16 el
 * 2026-12-08 y la opcional el 2026-12-15.
 */

export const BITACORA_START_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const DAY_MS = 24 * 60 * 60 * 1000;

export type BitacoraDateShift = {
  agenda: BitacoraAgendaExtraction;
  startDate: string;
  previousStartDate: string;
  shiftDays: number;
  firstDate: string;
  lastDate: string;
  weeks: number;
};

/** Dias desde 1970-01-01 de una fecha «aaaa-mm-dd»; null si no es una fecha real. */
export function bitacoraDayNumber(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimText(value));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const time = Date.UTC(year, month, day);
  const date = new Date(time);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  return Math.round(time / DAY_MS);
}

function dateFromDayNumber(dayNumber: number) {
  return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);
}

/** Semana de un item segun sus marcas («Semana: 5»); 0 si no tiene. */
export function bitacoraItemWeek(item: Pick<BitacoraAgendaItem, "evidence" | "description">) {
  for (const evidence of Array.isArray(item.evidence) ? item.evidence : []) {
    const match = /\bsemana\s*:?\s*(\d{1,2})\b/i.exec(String(evidence));
    if (match) return Number(match[1]);
  }
  const match = /^\s*semana\s+(\d{1,2})\b/i.exec(String(item.description || ""));
  return match ? Number(match[1]) : 0;
}

/** Fecha visible con el mismo estilo que la original («20-8-2025», «11/02/2026»...). */
function formatVisibleDate(isoDate: string, previousVisible: string) {
  const [year, month, day] = isoDate.split("-");
  const previous = /^(\d{1,2})([/-])(\d{1,2})\2(\d{2,4})$/.exec(trimText(previousVisible));
  const separator = previous?.[2] || "-";
  const padded = !!previous && (/^0\d$/.test(previous[1]) || /^0\d$/.test(previous[3]));
  const dayText = padded ? day : String(Number(day));
  const monthText = padded ? month : String(Number(month));
  return `${dayText}${separator}${monthText}${separator}${year}`;
}

function shiftItem(item: BitacoraAgendaItem, shiftDays: number): BitacoraAgendaItem {
  const match = /^(\d{4}-\d{2}-\d{2})(.*)$/.exec(trimText(item.dueAt));
  const dayNumber = match ? bitacoraDayNumber(match[1]) : null;
  if (!match || dayNumber === null) return item;
  const nextDate = dateFromDayNumber(dayNumber + shiftDays);
  const previousVisible = trimText(item.visibleDueText);
  const visibleDueText = formatVisibleDate(nextDate, previousVisible);
  const description = previousVisible
    ? String(item.description || "").split(`Fecha: ${previousVisible}`).join(`Fecha: ${visibleDueText}`)
    : String(item.description || "");
  return {
    ...item,
    dueAt: `${nextDate}${match[2]}`,
    visibleDueText,
    description,
  };
}

/**
 * Corre la agenda para que la semana 1 (o, sin semanas, la primera fecha) quede en startDate.
 * null si startDate no es una fecha real o la agenda no tiene fechas.
 */
export function shiftBitacoraAgendaToStart(agenda: BitacoraAgendaExtraction | null | undefined, startDate: string): BitacoraDateShift | null {
  const start = bitacoraDayNumber(startDate);
  if (start === null) return null;
  const items = Array.isArray(agenda?.items) ? agenda.items : [];
  const dated = items
    .map((item) => ({ item, date: trimText(item.dueAt).slice(0, 10) }))
    .filter((entry) => bitacoraDayNumber(entry.date) !== null);
  if (!dated.length) return null;

  const weekOne = dated.filter((entry) => bitacoraItemWeek(entry.item) === 1);
  const previousStartDate = (weekOne.length ? weekOne : dated).map((entry) => entry.date).sort()[0];
  const shiftDays = start - (bitacoraDayNumber(previousStartDate) as number);
  const shiftedItems = items.map((item) => shiftItem(item, shiftDays));
  const shiftedDates = shiftedItems
    .map((item) => trimText(item.dueAt).slice(0, 10))
    .filter((date) => bitacoraDayNumber(date) !== null)
    .sort();
  const weeks = new Set(shiftedItems.map((item) => bitacoraItemWeek(item)).filter((week) => week > 0)).size;

  return {
    agenda: {
      items: shiftedItems,
      summary: String(agenda?.summary || ""),
      warnings: Array.isArray(agenda?.warnings) ? agenda.warnings : [],
    },
    startDate,
    previousStartDate,
    shiftDays,
    firstDate: shiftedDates[0],
    lastDate: shiftedDates[shiftedDates.length - 1],
    weeks,
  };
}
