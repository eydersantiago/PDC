import ExcelJS from "exceljs";
import type { BitacoraAgendaExtraction, BitacoraAgendaItem } from "./document-classifier.js";
import { catalogoActividades, catalogoClasificacionActividad, catalogoEstado, catalogoModalidad, catalogoPeriodicidad, catalogoTipoExamen, getBitacoraTemplateCatalogs, getBitacoraTemplateUiMetadata } from "./bitacora-template.js";
import { trimText } from "./text-utils.js";

export type ParsedBitacoraImportSource = "excel_template" | "pdf_text";

export type ParsedBitacoraImportResult = {
  source: ParsedBitacoraImportSource;
  recognized: boolean;
  detectedTemplate: boolean;
  rowsParsed: number;
  rowsUsed: number;
  warnings: string[];
  validation: BitacoraTemplateValidation;
  bitacoraAgenda: BitacoraAgendaExtraction;
  summary: {
    activities: number;
    exams: number;
    withDate: number;
    withoutDate: number;
    parseWarnings: number;
  };
  textPreview: string;
};

export type BitacoraTemplateValidation = {
  isValid: boolean;
  minimumWeeks: number;
  createdWeeks: number;
  hasActivities: boolean;
  hasExams: boolean;
  errors: string[];
  warnings: string[];
};

export type BitacoraPdfReadiness = {
  score: number;
  canAutoImport: boolean;
  signals: {
    datesDetected: number;
    weekHeadersDetected: number;
    activitySignalsDetected: number;
    chars: number;
  };
  blockers: string[];
  recommendations: string[];
  guidelines: ReturnType<typeof getBitacoraPdfGuidelines>;
};

type BitacoraActivityRow = {
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

const MAX_PREVIEW_CHARS = 2200;
const PDF_CAN_IMPORT_THRESHOLD = 0.42;
const PDF_MAX_FILE_SIZE = 6 * 1024 * 1024;
const DEFAULT_BITACORA_EVENT_HOUR = 9;
const MIN_REQUIRED_WEEKS = 5;

const FILE_TEMPLATE_SHEETS = {
  BITACORA: "Bitacora",
  BITACORA_ACCENTED: "Bitácora",
  ACTIVIDADES: "Actividades",
  EXAMENES: "Exámenes",
  EXAMENES_ALTERNATE: "Examenes",
};

const EXAM_PROFILE: ColumnProfile = {
  sheet: "Exámenes",
  firstRow: 5,
  maxRows: 120,
  weekCol: "A",
  dateCol: "B",
  typeCol: "C",
  titleCol: "D",
  descCol: "H",
};

const ACTIVITIES_PROFILE: ColumnProfile = {
  sheet: "Actividades",
  firstRow: 5,
  maxRows: 160,
  weekCol: "A",
  dateCol: "B",
  typeCol: "C",
  titleCol: "E",
  descCol: "F",
};

function cleanText(value: unknown) {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return trimText(value).replace(/\u00a0/g, " ");
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (typeof value === "object" && "text" in value && typeof value.text === "string") return trimText(value.text).replace(/\u00a0/g, " ");
  if (typeof value === "object" && "result" in value) return cleanText((value as { result?: unknown }).result);
  return "";
}

function pad(value: number, size = 2) {
  return String(value).padStart(size, "0");
}

function normalizeDateText(value: unknown) {
  return trimText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function extractClockTime(value: string) {
  const match = value.match(/\b(\d{1,2})[:h](\d{2})\b/);
  if (!match) return { hour: 0, minute: 0 };

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { hour: DEFAULT_BITACORA_EVENT_HOUR, minute: 0 };
  }

  return { hour, minute };
}

function toIsoFromParts(year: number, monthIndex: number, day: number, hour = DEFAULT_BITACORA_EVENT_HOUR, minute = 0) {
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

  const candidate = new Date(Date.UTC(normalizedYear, monthIndex, day, hour, minute, 0, 0));
  if (
    candidate.getUTCFullYear() !== normalizedYear
    || candidate.getUTCMonth() !== monthIndex
    || candidate.getUTCDate() !== day
  ) {
    return null;
  }

  return `${normalizedYear.toString(10)}-${pad(monthIndex + 1)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00-05:00`;
}

function excelSerialToIso(serial: number) {
  const date = new Date(Math.round((serial - 25569) * 86400_000));
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(DEFAULT_BITACORA_EVENT_HOUR)}:00:00-05:00`;
}

function parseDateFromText(raw: string) {
  const source = normalizeDateText(raw);
  if (!source) return null;

  const isoMatch = source.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    return toIsoFromParts(
      Number(isoMatch[1]),
      Number(isoMatch[2]) - 1,
      Number(isoMatch[3]),
      DEFAULT_BITACORA_EVENT_HOUR,
      0,
    );
  }

  const simple = source.match(
    /\b(\d{1,2})[\/\.-](\d{1,2})(?:[\/\.-](\d{2,4}))?(?:\s+(\d{1,2})[:h](\d{2}))?/,
  );
  if (simple) {
    const now = new Date();
    const day = Number(simple[1]);
    const month = Number(simple[2]) - 1;
    const year = simple[3] ? Number(simple[3]) : now.getUTCFullYear();
    const clock = extractClockTime(source);
    const hour = Number(simple[4]) || clock.hour;
    const minute = Number(simple[5]) || clock.minute;
    return toIsoFromParts(year, month, day, hour, minute);
  }

  const spanish = source.match(
    /\b(\d{1,2})\s*(?:de\s*)?(ene|enero|feb|febrero|mar|marzo|abr|abril|may|mayo|jun|junio|jul|julio|ago|agosto|sept|septiembre|oct|octubre|nov|noviembre|dic|diciembre)(?:\s*(?:de\s*)?(\d{2,4}))?(?:\s+(?:a|hasta|y)\s*)?(?:\d{1,2}\s*(?:de\s*)?(ene|enero|feb|febrero|mar|marzo|abr|abril|may|mayo|jun|junio|jul|julio|ago|agosto|sept|septiembre|oct|octubre|nov|noviembre|dic|diciembre)?\s*(\d{2,4})?)?(?:\D{0,24}(\d{1,2})[:h](\d{2}))?/,
  );
  if (spanish) {
    const now = new Date();
    const day = Number(spanish[1]);
    const monthIndex = MONTHS[spanish[2]] ?? -1;
    const year = spanish[3] ? Number(spanish[3]) : now.getUTCFullYear();
    const clock = extractClockTime(source);
    return toIsoFromParts(year, monthIndex, day, clock.hour, clock.minute);
  }

  return null;
}

function parseDate(value: unknown) {
  if (value == null) return { dateIso: null, visible: "" };

  if (value instanceof Date) {
    const fallback = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}T${pad(DEFAULT_BITACORA_EVENT_HOUR)}:00:00-05:00`;
    return { dateIso: fallback, visible: value.toISOString() };
  }

  if (typeof value === "number") {
    return { dateIso: excelSerialToIso(value), visible: String(value) };
  }

  if (typeof value === "object" && "result" in value) {
    return parseDate((value as { result?: unknown }).result);
  }

  const raw = cleanText(value);
  const visible = raw;
  if (!visible) return { dateIso: null, visible };

  return { dateIso: parseDateFromText(visible), visible };
}

function compact(value: string, max = 320) {
  const text = trimText(value).replace(/\s+/g, " ");
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

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

function validateTemplateRequirements(rows: BitacoraActivityRow[], layout: "weekly" | "legacy") {
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

function collectCatalogCatalog(name: string, value: string, row: number, warnings: string[]) {
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

function parseWeeklyBitacoraRows(worksheet: ExcelJS.Worksheet | null): BitacoraActivityRow[] {
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

function parseWorksheetRows(profile: ColumnProfile, worksheet: ExcelJS.Worksheet | null): BitacoraActivityRow[] {
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

function buildBitacoraAgenda(rows: BitacoraActivityRow[]): BitacoraAgendaExtraction {
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

function getTemplateWorksheet(workbook: ExcelJS.Workbook, expectedNames: string[]) {
  for (const candidate of expectedNames) {
    const found = workbook.getWorksheet(candidate);
    if (found) return found;
  }

  const lowered = workbook.worksheets.find((sheet) =>
    expectedNames.some((name) => sheet.name.toLowerCase() === name.toLowerCase()),
  );
  return lowered || null;
}

function computeTemplateUsage(rows: BitacoraActivityRow[]) {
  const withDate = rows.filter((row) => Boolean(row.dateIso)).length;
  const withoutDate = rows.length - withDate;
  const activities = rows.filter((row) => row.source === "Actividades").length;
  const exams = rows.filter((row) => row.source === "Exámenes").length;
  return { withDate, withoutDate, activities, exams };
}

export async function parseBitacoraTemplateUpload(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const weeklySheet = getTemplateWorksheet(workbook, [
    FILE_TEMPLATE_SHEETS.BITACORA,
    FILE_TEMPLATE_SHEETS.BITACORA_ACCENTED,
    "BITACORA",
  ]);
  const activitiesSheet = getTemplateWorksheet(workbook, [
    FILE_TEMPLATE_SHEETS.ACTIVIDADES,
    "ACTIVIDADES",
  ]);
  const examsSheet = getTemplateWorksheet(workbook, [
    FILE_TEMPLATE_SHEETS.EXAMENES,
    FILE_TEMPLATE_SHEETS.EXAMENES_ALTERNATE,
    "EXAMENES",
  ]);

  const normalizedRows: BitacoraActivityRow[] = weeklySheet
    ? parseWeeklyBitacoraRows(weeklySheet)
    : [
      ...parseWorksheetRows({
        ...ACTIVITIES_PROFILE,
        sheet: "Actividades",
      }, activitiesSheet),
      ...parseWorksheetRows({
        ...EXAM_PROFILE,
        sheet: "Exámenes",
      }, examsSheet),
    ];

  const warnings: string[] = [];
  const rowUsage = computeTemplateUsage(normalizedRows);
  const recognized = Boolean(weeklySheet || activitiesSheet || examsSheet) && normalizedRows.length > 0;
  if (!weeklySheet) {
    for (const row of normalizedRows) {
      if (row.typeValue) {
        collectCatalogCatalog("tipo", row.typeValue, row.sourceLine, warnings);
      }
      if (row.subtypeValue) {
        collectCatalogCatalog("subtipo", row.subtypeValue, row.sourceLine, warnings);
      }
    }
  }

  const agenda = buildBitacoraAgenda(normalizedRows);
  const rowsUsed = agenda.items.length;
  const validation = validateTemplateRequirements(normalizedRows, weeklySheet ? "weekly" : "legacy");

  if (recognized && !agenda.items.length) {
    warnings.push("La plantilla no contiene filas con contenido de agenda usable.");
  }
  if (!weeklySheet && !activitiesSheet && !examsSheet) {
    warnings.push("No se encontró la hoja 'Bitacora' ni las hojas legacy 'Actividades'/'Exámenes'.");
  }
  warnings.push(...validation.warnings);

  return {
    source: "excel_template" as const,
    recognized,
    detectedTemplate: Boolean(weeklySheet || activitiesSheet || examsSheet),
    rowsParsed: normalizedRows.length,
    rowsUsed,
    warnings,
    validation,
    bitacoraAgenda: agenda,
    summary: {
      activities: rowUsage.activities,
      exams: rowUsage.exams,
      withDate: rowUsage.withDate,
      withoutDate: rowUsage.withoutDate,
      parseWarnings: warnings.length + validation.errors.length,
    },
    textPreview: normalizedRows
      .slice(0, 100)
      .map((row) => `${row.source}: ${trimText(row.week)} ${trimText(row.dateText)} ${trimText(row.typeValue)} ${trimText(row.title)}`)
      .join("\n")
      .slice(0, MAX_PREVIEW_CHARS),
  };
}

export function getBitacoraPdfGuidelines() {
  return {
    acceptedFileTypes: ["application/pdf"],
    recommendedPdfTextLayout: [
      "Plantilla por filas semanales con fecha visible.",
      "Primera columna con el número de semana.",
      "Fechas en formato yyyy-mm-dd o dd/mm/aaaa (o dd de mes en español).",
      "Texto de actividad por fila (acción + entregable + evidencia).",
    ],
    acceptedDatePatterns: [
      "\\d{1,2}/\\d{1,2}/\\d{4}",
      "\\d{1,2}-\\d{1,2}-\\d{4}",
      "\\d{1,2} de (enero|feb|febrero|mar|marzo|abr|abril|may|mayo|jun|junio|jul|julio|ago|agosto|sep|septiembre|oct|octubre|nov|noviembre|dic|diciembre)",
      "yyyy-mm-dd",
    ],
    qualitySignals: {
      minCharsForAutoImport: 3000,
      minDateSamplesForHigherConfidence: 2,
      preferredKeywords: [
        "actividad",
        "entrega",
        "tarea",
        "sesión",
        "semana",
        "fecha",
        "examen",
        "quiz",
        "parcial",
      ],
    },
    rejectSignals: [
      "Escaneo borroso sin texto extraíble.",
      "PDF de una sola imagen por página sin OCR.",
      "Tablas rotas con columnas mezcladas o fechas sin separador.",
    ],
    uiTips: getBitacoraTemplateUiMetadata(),
  };
}

export function assessPdfBitacoraReadiness(input: { text: string; fileSize: number; fileName: string }) {
  const text = trimText(input.text);
  const weekHeadersDetected = (text.toLowerCase().match(/semana/g) || []).length;
  const datesDetected = (text.match(/\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{2,4}/g) || []).length
    + (text.toLowerCase().match(/\d{1,2}\s*de\s*(?:ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)/g) || []).length;
  const activitySignalsDetected = (text.toLowerCase().match(/\b(tarea|entrega|actividad|quiz|parcial|examen|proyecto|sesion|seguimiento)\b/g) || []).length;
  const score = Math.min(
    1,
    (
      Math.min(1, (text.length || 1) / 3000) * 0.35
      + Math.min(1, datesDetected / 4) * 0.35
      + Math.min(1, weekHeadersDetected / 3) * 0.15
      + Math.min(1, activitySignalsDetected / 8) * 0.15
    ),
  );

  const recommendations: string[] = [];
  const blockers: string[] = [];

  if (input.fileSize > PDF_MAX_FILE_SIZE) {
    blockers.push("Archivo PDF mayor a 6MB; puede generar inconsistencias al extraer texto.");
  }
  if (!/\.pdf$/i.test(input.fileName)) {
    recommendations.push("Nombra el archivo con extensión .pdf para facilitar la trazabilidad.");
  }
  if (datesDetected < 2) {
    recommendations.push("Incluye más fechas explícitas por fila para que la importación automática sea precisa.");
  }
  if (activitySignalsDetected < 2) {
    recommendations.push("Asegura palabras clave de actividad (entrega, tarea, examen) para facilitar clasificación.");
  }
  if (weekHeadersDetected === 0) {
    recommendations.push("Si es una tabla semanal, agrega la etiqueta 'Semana' en el encabezado.");
  }

  return {
    score,
    canAutoImport: score >= PDF_CAN_IMPORT_THRESHOLD && blockers.length === 0,
    signals: {
      datesDetected: datesDetected,
      weekHeadersDetected,
      activitySignalsDetected,
      chars: text.length,
    },
    blockers,
    recommendations,
    guidelines: getBitacoraPdfGuidelines(),
  };
}
