"use strict";

// ADACEEN | Capa 3 - Servicios: agenda del Campus, leer fechas y titulos del texto (meses, horas, rangos).
// Movido sin cambios de campus-calendar.service.js.

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
