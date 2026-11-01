// Importar la bitacora: filas de las hojas (plantilla semanal y por columnas), validacion y agenda.
import ExcelJS from "exceljs";
import type { BitacoraAgendaExtraction, BitacoraAgendaItem } from "../documents/bitacora-agenda.js";
import { catalogoActividades, catalogoClasificacionActividad, catalogoEstado, catalogoModalidad, catalogoPeriodicidad, catalogoTipoExamen, getBitacoraTemplateCatalogs } from "./bitacora-template.js";
import { trimText } from "../shared/text-utils.js";
import { normalizeDateText, cleanText, compact, parseDate } from "./bitacora-import-dates.js";

export type BitacoraActivityRow = {
  week: string;
  dateText: string;
  dateIso: string | null;
  typeValue: string;
  subtypeValue: string;
  title: string;
  description: string;
  notes: string;
  source: "Actividades" | "Exámenes";
  sourceLine: number;
};

type ColumnProfile = {
  weekCol: string;
  dateCol: string;
  typeCol: string;
  titleCol: string;
  descCol: string;
  sheet: "Actividades" | "Exámenes";
  firstRow: number;
  maxRows: number;
};

const MIN_REQUIRED_WEEKS = 5;

export const EXAM_PROFILE: ColumnProfile = {
  sheet: "Exámenes",
  firstRow: 5,
  maxRows: 120,
  weekCol: "A",
  dateCol: "B",
  typeCol: "C",
  titleCol: "D",
  descCol: "H",
};

export const ACTIVITIES_PROFILE: ColumnProfile = {
  sheet: "Actividades",
  firstRow: 5,
  maxRows: 160,
  weekCol: "A",
  dateCol: "B",
  typeCol: "C",
  titleCol: "E",
  descCol: "F",
};

function isRowUseful(values: string[]) {
  return values.some((value) => value.length >= 1);
}

function parseWeekNumber(value: string) {
  const source = trimText(value);
  if (!source) return null;
  const match = source.match(/(\d{1,2})/);
  if (!match) return null;
  const week = Number(match[1]);
  if (!Number.isInteger(week) || week < 1 || week > 20) return null;
  return week;
}

export function validateTemplateRequirements(rows: BitacoraActivityRow[], layout: "weekly" | "legacy") {
  const errors: string[] = [];
  const warnings: string[] = [];
  const weekNumbers = new Set<number>();
  let hasActivities = false;
  let hasExams = false;

  for (const row of rows) {
    const week = parseWeekNumber(row.week);
    if (week) {
      weekNumbers.add(week);
    }

    if (!hasActivities && row.source === "Actividades") {
      if (isRowUseful([row.week, row.dateText, row.typeValue, row.subtypeValue, row.title, row.description])) {
        hasActivities = true;
      }
    }

    if (!hasExams && row.source === "Exámenes") {
      if (isRowUseful([row.dateText, row.typeValue, row.title, row.description])) {
        hasExams = true;
      }
    }
  }

  if (weekNumbers.size < MIN_REQUIRED_WEEKS) {
    errors.push(`La plantilla debe incluir al menos ${MIN_REQUIRED_WEEKS} semanas con información (se detectaron ${weekNumbers.size}).`);
  }

  if (!hasActivities) {
    errors.push(layout === "weekly"
      ? "La hoja 'Bitacora' no tiene filas con actividades en clase."
      : "La hoja 'Actividades' no tiene filas con actividades o evaluaciones.");
  }

  if (!hasExams) {
    errors.push(layout === "weekly"
      ? "La hoja 'Bitacora' no tiene filas con actividades de evaluación."
      : "La hoja 'Exámenes' no tiene filas con evaluaciones.");
  }

  if (!errors.length && weekNumbers.size >= MIN_REQUIRED_WEEKS) {
    warnings.push("La plantilla cumple con los criterios mínimos de estructura.");
  }

  return {
    isValid: errors.length === 0,
    minimumWeeks: MIN_REQUIRED_WEEKS,
    createdWeeks: weekNumbers.size,
    hasActivities,
    hasExams,
    errors,
    warnings,
  };
}

function normalizeActivityClassification(value: string, fallback = "") {
  const text = normalizeDateText(`${value} ${fallback}`);
  if (/\bquiz|cuestionario\b/.test(text)) return "Quiz";
  if (/\bparcial|examen|evaluacion|evaluación|prueba\b/.test(text)) return "Parcial";
  if (/\bproyecto|entrega|sustentacion|sustentación\b/.test(text)) return "Proyecto";
  if (/\bejercicio|taller|laboratorio|practica|práctica\b/.test(text)) return "Ejercicio";
  if (/\bactividad|clase|sesion|sesión\b/.test(text)) return "Actividad";
  return "";
}

function estimateAgendaType(source: "Actividades" | "Exámenes", title: string, typeValue: string, subtype = ""): BitacoraAgendaItem["type"] {
  const classification = normalizeActivityClassification(typeValue, `${title} ${subtype}`);
  if (classification === "Proyecto" || classification === "Parcial" || classification === "Quiz") return "task";
  if (classification === "Actividad" || classification === "Ejercicio") {
    return source === "Exámenes" ? "task" : "activity";
  }

  const search = `${title} ${typeValue} ${subtype}`.toLowerCase();
  if (/examen|quiz|taller|sustentac|parcial|prueba|evalu/.test(search)) return "task";
  if (/seguimiento|reunion|encuentro|reunión|compromis|acuerdo/.test(search)) return "commitment";
  if (/problema|obs|observac|nota|dificultad|bloqueo/.test(search)) return "note";
  return source === "Exámenes" ? "task" : "activity";
}

export function collectCatalogCatalog(name: string, value: string, row: number, warnings: string[]) {
  const text = cleanText(value).toLowerCase();
  if (!text) return;
  const available = getBitacoraTemplateCatalogs();
  const catalogByColumn: Record<string, string[]> = {
    clasificacion: catalogoClasificacionActividad,
    tipo: [...catalogoClasificacionActividad, ...catalogoActividades, ...catalogoTipoExamen],
    subtipo: [...catalogoActividades],
    modalidad: catalogoModalidad,
    estado: catalogoEstado,
    periodicidad: catalogoPeriodicidad,
  };
  if (!catalogByColumn[name]) return;
  const normalizedCatalog = catalogByColumn[name]
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean);
  if (!normalizedCatalog.includes(text)) {
    warnings.push(`Fila ${row}: "${name}" usa un valor fuera del catálogo: "${trimText(value)}".`);
  }
}

function normalizeBitacoraRow(row: BitacoraActivityRow, source: "Actividades" | "Exámenes", rowIndex: number): BitacoraAgendaItem | null {
  const hasTitle = trimText(row.title).length > 0;
  const hasDescription = trimText(row.description).length > 0;
  const hasType = trimText(row.typeValue).length > 0;
  const hasDate = Boolean(row.dateIso);

  if (!hasTitle && !hasDescription && !hasType && !hasDate) return null;
  const category = normalizeActivityClassification(row.typeValue, `${row.title} ${row.subtypeValue}`);

  const title = compact(source === "Exámenes"
    ? (row.title ? `Examen: ${row.title}` : row.description)
    : [
      row.subtypeValue ? `${row.subtypeValue}` : null,
      row.title || row.description,
    ].filter(Boolean).join(" ").trim(), 190);

  const description = compact([
    category ? `Clasificación: ${category}` : null,
    row.typeValue && source === "Actividades" ? `Tipo: ${row.typeValue}` : null,
    row.subtypeValue ? `Subtipo: ${row.subtypeValue}` : null,
    row.dateText ? `Fecha: ${row.dateText}` : null,
    row.notes ? `Notas: ${row.notes}` : null,
    row.description,
  ].filter(Boolean).join(" | "), 500);

  const confidence = hasTitle && hasDate
    ? 0.94
    : hasTitle
      ? 0.84
      : 0.72;

  return {
    title,
    type: estimateAgendaType(source, row.title, row.typeValue, row.subtypeValue),
    ...(category ? { category } : {}),
    dueAt: row.dateIso,
    visibleDueText: row.dateText,
    description: description || "(sin descripción)",
    confidence,
    evidence: [
      `Hoja: ${source}`,
      row.week ? `Semana: ${row.week}` : "Sin semana",
      category ? `Clasificación: ${category}` : "Sin clasificación",
      row.typeValue ? `Tipo: ${row.typeValue}` : "Sin tipo",
      `Fila: ${rowIndex}`,
    ],
  };
}

function normalizeHeaderName(value: string) {
  return normalizeDateText(value)
    .replace(/evaluacion/g, "evaluación")
    .replace(/\s+/g, " ")
    .trim();
}

function findWeeklyHeaderRow(worksheet: ExcelJS.Worksheet) {
  const maxRows = Math.min(10, worksheet.actualRowCount || 10);
  for (let rowIndex = 1; rowIndex <= maxRows; rowIndex += 1) {
    const row = worksheet.getRow(rowIndex);
    const values = Array.from({ length: 8 }, (_, index) => normalizeHeaderName(cleanText(row.getCell(index + 1).value)));
    const joined = values.join(" ");
    if (
      joined.includes("semana")
      && joined.includes("fecha")
      && joined.includes("tema")
      && joined.includes("actividades en clase")
      && joined.includes("actividades evaluación")
    ) {
      return rowIndex;
    }
  }
  return 1;
}

function findWeeklyColumn(row: ExcelJS.Row, candidates: string[], fallback: number) {
  for (let col = 1; col <= 10; col += 1) {
    const header = normalizeHeaderName(cleanText(row.getCell(col).value));
    if (candidates.some((candidate) => header.includes(candidate))) return col;
  }
  return fallback;
}

export function parseWeeklyBitacoraRows(worksheet: ExcelJS.Worksheet | null): BitacoraActivityRow[] {
  const rows: BitacoraActivityRow[] = [];
  if (!worksheet) return rows;

  const headerRow = findWeeklyHeaderRow(worksheet);
  const header = worksheet.getRow(headerRow);
  const weekCol = findWeeklyColumn(header, ["semana"], 1);
  const dateCol = findWeeklyColumn(header, ["fecha"], 2);
  const topicCol = findWeeklyColumn(header, ["tema"], 3);
  const classificationCol = findWeeklyColumn(header, ["clasificacion", "tipo actividad"], 0);
  const classActivityCol = findWeeklyColumn(header, ["actividades en clase"], classificationCol ? 5 : 4);
  const evaluationActivityCol = findWeeklyColumn(header, ["actividades evaluación"], classificationCol ? 6 : 5);
  const firstDataRow = headerRow + 1;
  const parsedRows = worksheet.actualRowCount;
  const maxRows = Math.min(80, Math.max(0, parsedRows - firstDataRow + 1));

  for (let rowIndex = firstDataRow; rowIndex < firstDataRow + maxRows; rowIndex += 1) {
    const row = worksheet.getRow(rowIndex);
    const week = cleanText(row.getCell(weekCol).value);
    const dateParsed = parseDate(row.getCell(dateCol).value);
    const topic = cleanText(row.getCell(topicCol).value);
    const classification = classificationCol ? cleanText(row.getCell(classificationCol).value) : "";
    const classActivity = cleanText(row.getCell(classActivityCol).value);
    const evaluationActivity = cleanText(row.getCell(evaluationActivityCol).value);
    if (!isRowUseful([week, dateParsed.visible, topic, classActivity, evaluationActivity])) continue;

    if (classActivity || topic) {
      rows.push({
        week,
        dateText: dateParsed.visible,
        dateIso: dateParsed.dateIso,
        typeValue: classification || "Actividad en clase",
        subtypeValue: topic,
        title: classActivity || topic,
        description: [
          topic ? `Tema: ${topic}` : "",
          classification ? `Clasificación: ${classification}` : "",
          classActivity ? `Actividades en clase: ${classActivity}` : "",
        ].filter(Boolean).join(" | "),
        notes: evaluationActivity ? `Evaluación relacionada: ${evaluationActivity}` : "",
        source: "Actividades",
        sourceLine: rowIndex,
      });
    }

    if (evaluationActivity) {
      rows.push({
        week,
        dateText: dateParsed.visible,
        dateIso: dateParsed.dateIso,
        typeValue: classification || "Actividad evaluación",
        subtypeValue: topic,
        title: evaluationActivity,
        description: [
          topic ? `Tema: ${topic}` : "",
          classification ? `Clasificación: ${classification}` : "",
          classActivity ? `Actividades en clase: ${classActivity}` : "",
          `Actividades evaluación: ${evaluationActivity}`,
        ].filter(Boolean).join(" | "),
        notes: "",
        source: "Exámenes",
        sourceLine: rowIndex,
      });
    }
  }

  return rows;
}

export function parseWorksheetRows(profile: ColumnProfile, worksheet: ExcelJS.Worksheet | null): BitacoraActivityRow[] {
  const rows: BitacoraActivityRow[] = [];
  if (!worksheet) return rows;

  const parsedRows = worksheet.actualRowCount;
  const maxRows = Math.min(profile.maxRows, Math.max(0, parsedRows - profile.firstRow + 1));

  for (let rowIndex = profile.firstRow; rowIndex < profile.firstRow + maxRows; rowIndex += 1) {
    const row = worksheet.getRow(rowIndex);
    const week = cleanText(row.getCell(profile.weekCol).value);
    const dateRaw = row.getCell(profile.dateCol).value;
    const typeValue = cleanText(row.getCell(profile.typeCol).value);
    const subtitle = profile.sheet === "Exámenes"
      ? ""
      : cleanText(row.getCell("D").value);
    const title = cleanText(row.getCell(profile.titleCol).value);
    const description = cleanText(row.getCell(profile.descCol).value);
    const dateParsed = parseDate(dateRaw);
    const notes = cleanText(profile.sheet === "Exámenes"
      ? `${compact(description, 280)}`
      : cleanText(row.getCell("J").value));
    const rowData: BitacoraActivityRow = {
      week,
      dateText: dateParsed.visible,
      dateIso: dateParsed.dateIso,
      typeValue,
      subtypeValue: subtitle,
      title,
      description,
      notes,
      source: profile.sheet,
      sourceLine: rowIndex,
    };
    if (isRowUseful([week, rowData.dateText, typeValue, subtitle, title, description])) {
      rows.push(rowData);
    }
  }

  return rows;
}

export function buildBitacoraAgenda(rows: BitacoraActivityRow[]): BitacoraAgendaExtraction {
  const seen = new Set<string>();
  const items: BitacoraAgendaItem[] = [];
  let withDate = 0;
  let withoutDate = 0;

  for (const row of rows) {
    const source = row.source;
    const index = seen.size + 1;
    const normalized = normalizeBitacoraRow(row, source, index);
    if (!normalized) continue;

    const key = `${row.title.toLowerCase()}|${row.dateIso || row.dateText}|${source}`.trim();
    if (seen.has(key)) continue;
    seen.add(key);

    if (normalized.dueAt) withDate += 1;
    else withoutDate += 1;
    items.push(normalized);
  }

  if (items.length === 0) {
    return {
      items: [],
      summary: "No se detectaron filas con información para agenda.",
      warnings: ["No hay filas completas en la plantilla o faltan campos clave."],
    };
  }

  return {
    items,
    summary: `Se detectaron ${items.length} registro(s) en la plantilla.`,
    warnings: [],
  };
}
