// Importar la bitacora del docente: plantilla en Excel (parseBitacoraTemplateUpload) y guia y revision previa de un PDF.
import ExcelJS from "exceljs";
import type { BitacoraAgendaExtraction } from "../documents/bitacora-agenda.js";
import { getBitacoraTemplateUiMetadata } from "./bitacora-template.js";
import { trimText } from "../shared/text-utils.js";
import { type BitacoraActivityRow, parseWeeklyBitacoraRows, parseWorksheetRows, ACTIVITIES_PROFILE, EXAM_PROFILE, collectCatalogCatalog, buildBitacoraAgenda, validateTemplateRequirements } from "./bitacora-import-rows.js";

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

const MAX_PREVIEW_CHARS = 2200;
const PDF_CAN_IMPORT_THRESHOLD = 0.42;
const PDF_MAX_FILE_SIZE = 6 * 1024 * 1024;

const FILE_TEMPLATE_SHEETS = {
  BITACORA: "Bitacora",
  BITACORA_ACCENTED: "Bitácora",
  ACTIVIDADES: "Actividades",
  EXAMENES: "Exámenes",
  EXAMENES_ALTERNATE: "Examenes",
};

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
