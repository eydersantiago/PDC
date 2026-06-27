import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import Tesseract from "tesseract.js";
import { runTextByMode } from "./agent-mode.js";
import { trimText, uniqueStrings } from "./text-utils.js";

export type DocumentClassificationLabel = "BITACORA" | "OTRO";
export type DocumentClassificationMethod = "rules" | "hybrid";

export type DocumentClassifierInput = {
  fileName?: string;
  filePath?: string;
  mimeType?: string;
  extension?: string;
  text?: string;
  buffer?: Buffer;
  useModel?: boolean;
  maxTextChars?: number;
};

export type ExtractedDocumentText = {
  text: string;
  source: "provided_text" | "pdf" | "docx" | "plain_text" | "image_ocr" | "unsupported" | "empty";
  mimeType: string;
  extension: string;
  bytes: number;
  pages?: Array<{
    pageNumber: number;
    text: string;
  }>;
  warnings: string[];
};

export type DocumentClassification = {
  label: DocumentClassificationLabel;
  confidence: number;
  method: DocumentClassificationMethod;
  evidence: string[];
  reason: string;
};

export type DocumentClassificationFeatures = {
  normalizedName: string;
  normalizedTextPreview: string;
  matchedTerms: string[];
  filenameScore: number;
  contentScore: number;
  structureScore: number;
  negativeScore: number;
  textLength: number;
  extractionSource: ExtractedDocumentText["source"];
};

export type DocumentClassificationResult = {
  classification: DocumentClassification;
  extracted: ExtractedDocumentText;
  features: DocumentClassificationFeatures;
  trainingExample: {
    input: {
      fileName: string;
      filePath: string;
      textPreview: string;
    };
    expectedLabel: DocumentClassificationLabel | null;
    predictedLabel: DocumentClassificationLabel;
  };
  modelUsed: boolean;
  modelError: string;
  modelRawOutput: string;
};

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

type RuleEvaluation = {
  classification: DocumentClassification;
  features: DocumentClassificationFeatures;
};

const DEFAULT_MAX_TEXT_CHARS = 120000;
const OCR_LANGUAGES = process.env.DOCUMENT_OCR_LANGUAGES || "spa+eng";
const DEFAULT_BITACORA_EVENT_HOUR = 9;

const SUPPORTED_TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "jsonl",
  "csv",
  "tsv",
  "html",
  "htm",
  "xml",
  "cpp",
  "c",
  "h",
  "hpp",
  "py",
  "js",
  "ts",
  "java",
]);
const SUPPORTED_IMAGE_MIME_PREFIX = "image/";

const BITACORA_TERMS = [
  { pattern: /\bbitacora\b/g, label: "bitacora", weight: 0.32 },
  { pattern: /\blogbook\b/g, label: "logbook", weight: 0.32 },
  { pattern: /\bdiario\s+de\s+campo\b/g, label: "diario de campo", weight: 0.3 },
  { pattern: /\bregistro\s+de\s+actividades\b/g, label: "registro de actividades", weight: 0.3 },
  { pattern: /\bseguimiento\s+semanal\b/g, label: "seguimiento semanal", weight: 0.28 },
  { pattern: /\bregistro\s+de\s+avance(s)?\b/g, label: "registro de avance", weight: 0.28 },
  { pattern: /\binforme\s+semanal\b/g, label: "informe semanal", weight: 0.2 },
  { pattern: /\bcontrol\s+de\s+avance(s)?\b/g, label: "control de avance", weight: 0.2 },
];

const STRUCTURE_TERMS = [
  { pattern: /\bactividades\s+(realizadas|desarrolladas|ejecutadas)\b/g, label: "actividades realizadas", weight: 0.12 },
  { pattern: /\bsemana\s+fecha\s+tema\b/g, label: "tabla semanal con fechas", weight: 0.16 },
  { pattern: /\bactividades\s+(en\s+clase|evaluacion)\b/g, label: "tabla de actividades", weight: 0.12 },
  { pattern: /\bobjetivo(s)?\b/g, label: "objetivos", weight: 0.04 },
  { pattern: /\bavance(s)?\b/g, label: "avances", weight: 0.07 },
  { pattern: /\bdificultad(es)?\b/g, label: "dificultades", weight: 0.07 },
  { pattern: /\bcompromiso(s)?\b/g, label: "compromisos", weight: 0.06 },
  { pattern: /\bevidencia(s)?\b/g, label: "evidencias", weight: 0.05 },
  { pattern: /\bobservacion(es)?\b/g, label: "observaciones", weight: 0.05 },
  { pattern: /\bpendiente(s)?\b/g, label: "pendientes", weight: 0.05 },
  { pattern: /\bsemana\s+\d{1,2}\b/g, label: "semanas numeradas", weight: 0.08 },
  { pattern: /\bfecha\s*[:\-]\s*\d{1,2}\b/g, label: "fechas de registro", weight: 0.08 },
];

const NEGATIVE_TERMS = [
  /\brubrica\b/g,
  /\bsyllabus\b/g,
  /\bsilabo\b/g,
  /\bguia\s+de\s+(laboratorio|aprendizaje|trabajo)\b/g,
  /\benunciado\b/g,
  /\bparcial\b/g,
  /\bexamen\b/g,
  /\bdiapositiva(s)?\b/g,
  /\bpresentacion\b/g,
];

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

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function roundConfidence(value: number) {
  return Math.round(clamp01(value) * 100) / 100;
}

export function normalizeDocumentText(value: string) {
  return trimText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[^\S\r\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .toLowerCase();
}

function compactText(value: string, max = 600) {
  const text = trimText(value).replace(/\s+/g, " ");
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

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

function normalizeExtension(value: unknown) {
  return trimText(value).replace(/^\./, "").toLowerCase();
}

function inferExtensionFromName(value: string) {
  return normalizeExtension(path.extname(trimText(value)));
}

function splitBitacoraChunks(text: string) {
  return trimText(text)
    .replace(/\u00a0/g, " ")
    .split(/\r?\n+|(?<=[.!?])\s+|;+/)
    .map((chunk) => trimText(chunk).replace(/^[\-*\d.)\s]+/, "").trim())
    .filter((chunk) => chunk.length >= 4)
    .slice(0, 500);
}

type BitacoraScheduleRow = {
  week: number;
  dateText: string;
  dueAt: string;
  visibleDueText: string;
  body: string;
};

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

function splitBitacoraScheduleRows(text: string) {
  const prepared = trimText(text)
    .replace(/\u00a0/g, " ")
    .replace(/\s+(\d{1,2}\s+\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b)/g, "\n$1");
  const lines = prepared
    .split(/\r?\n+/)
    .map((line) => trimText(line).replace(/\s+/g, " "))
    .filter(Boolean);
  const rows: Array<{ week: number; dateText: string; body: string }> = [];
  let current: { week: number; dateText: string; body: string } | null = null;

  for (const line of lines) {
    const normalized = normalizeDateText(line);
    if (/^semana\s+fecha\s+tema\b/.test(normalized)) continue;

    const rowMatch = line.match(/^(\d{1,2})\s+(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\s+(.+)$/);
    if (rowMatch) {
      if (current) rows.push(current);
      current = {
        week: Number(rowMatch[1]),
        dateText: rowMatch[2],
        body: rowMatch[3],
      };
      continue;
    }

    if (current) {
      current.body = compactText(`${current.body} ${line}`, 1400);
    }
  }

  if (current) rows.push(current);

  return rows
    .map((row): BitacoraScheduleRow | null => {
      const date = parseAgendaDate(row.dateText);
      if (!date.dueAt) return null;
      return {
        ...row,
        dueAt: date.dueAt,
        visibleDueText: date.visibleDueText || row.dateText,
        body: compactText(row.body, 1000),
      };
    })
    .filter((row): row is BitacoraScheduleRow => !!row);
}

function extractScheduleRowTitle(body: string) {
  const clean = compactText(body, 1000);
  const match = clean.match(
    /\b(quiz\b.*|taller\b.*|parcial\b.*|examen\b.*|entrega\b.*|sustentacion\b.*|sustentación\b.*|evaluacion\b.*|evaluación\b.*|caso\s+de\b.*|registro\s+de\b.*|imc\b.*|nutricion\b.*|nutrición\b.*)/i,
  );
  if (match) {
    const taskText = compactText(match[1], 180);
    const contextText = compactText(clean.slice(0, match.index).replace(/[|,;:-]+$/g, ""), 90);
    if (contextText && taskText.length <= 28) return `${contextText} - ${taskText}`;
    return taskText;
  }

  return extractAgendaTitle(clean);
}

function extractBitacoraScheduleAgendaItems(text: string) {
  const rows = splitBitacoraScheduleRows(text);
  const items: BitacoraAgendaItem[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const title = extractScheduleRowTitle(row.body);
    if (!title) continue;

    const key = `${normalizeDocumentText(title)}|${row.dueAt}`;
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
      title,
      type: classifyAgendaChunkType(title),
      dueAt: row.dueAt,
      visibleDueText: row.visibleDueText,
      description: compactText(`Semana ${row.week}. ${row.body}`, 360),
      confidence: 0.9,
      evidence: [
        `Fila de bitacora: semana ${row.week}`,
        `Fecha asociada: ${row.visibleDueText}`,
      ],
    });

    if (items.length >= 30) break;
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

function decodePlainText(buffer: Buffer, maxTextChars: number) {
  return buffer.toString("utf8").replace(/^\uFEFF/, "").slice(0, maxTextChars);
}

async function extractPdfText(buffer: Buffer, maxTextChars: number) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    const text = trimText(result.text).slice(0, maxTextChars);
    const pages = (result.pages || [])
      .map((page) => ({
        pageNumber: Number(page.num) || 0,
        text: trimText(page.text),
      }))
      .filter((page) => page.pageNumber > 0 && page.text);
    return { text, pages };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractDocxText(buffer: Buffer, maxTextChars: number) {
  const result = await mammoth.extractRawText({ buffer });
  return trimText(result.value).slice(0, maxTextChars);
}

async function extractImageText(buffer: Buffer, maxTextChars: number) {
  const result = await Tesseract.recognize(buffer, OCR_LANGUAGES, {
    logger: () => {},
  });
  return trimText(result.data?.text || "").slice(0, maxTextChars);
}

export async function extractDocumentText(input: DocumentClassifierInput): Promise<ExtractedDocumentText> {
  const warnings: string[] = [];
  const maxTextChars = Math.max(1000, Number(input.maxTextChars) || DEFAULT_MAX_TEXT_CHARS);
  const fileName = trimText(input.fileName || input.filePath);
  const providedExtension = normalizeExtension(input.extension) || inferExtensionFromName(fileName);
  const providedMimeType = trimText(input.mimeType).toLowerCase();

  if (trimText(input.text)) {
    return {
      text: trimText(input.text).slice(0, maxTextChars),
      source: "provided_text",
      mimeType: providedMimeType || "text/plain",
      extension: providedExtension || "txt",
      bytes: Buffer.byteLength(String(input.text || ""), "utf8"),
      warnings,
    };
  }

  const buffer = input.buffer;
  if (!buffer?.length) {
    return {
      text: "",
      source: "empty",
      mimeType: providedMimeType,
      extension: providedExtension,
      bytes: 0,
      warnings: ["No se recibio texto ni contenido binario para extraer."],
    };
  }

  const detected = await fileTypeFromBuffer(buffer).catch(() => undefined);
  const mimeType = providedMimeType || detected?.mime || "";
  const extension = providedExtension || detected?.ext || "";
  const normalizedMime = mimeType.toLowerCase();

  try {
    if (extension === "pdf" || normalizedMime === "application/pdf") {
      const extractedPdf = await extractPdfText(buffer, maxTextChars);
      return {
        text: extractedPdf.text,
        source: "pdf",
        mimeType: normalizedMime || "application/pdf",
        extension: "pdf",
        bytes: buffer.length,
        pages: extractedPdf.pages,
        warnings,
      };
    }

    if (
      extension === "docx"
      || normalizedMime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      return {
        text: await extractDocxText(buffer, maxTextChars),
        source: "docx",
        mimeType: normalizedMime || "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        extension: "docx",
        bytes: buffer.length,
        warnings,
      };
    }

    if (SUPPORTED_TEXT_EXTENSIONS.has(extension) || normalizedMime.startsWith("text/")) {
      return {
        text: decodePlainText(buffer, maxTextChars),
        source: "plain_text",
        mimeType: normalizedMime || "text/plain",
        extension: extension || "txt",
        bytes: buffer.length,
        warnings,
      };
    }

    if (normalizedMime.startsWith(SUPPORTED_IMAGE_MIME_PREFIX) || ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff"].includes(extension)) {
      return {
        text: await extractImageText(buffer, maxTextChars),
        source: "image_ocr",
        mimeType: normalizedMime || detected?.mime || "image/unknown",
        extension: extension || detected?.ext || "image",
        bytes: buffer.length,
        warnings,
      };
    }
  } catch (error) {
    warnings.push(`No se pudo extraer texto: ${String(error)}`);
  }

  return {
    text: "",
    source: "unsupported",
    mimeType: normalizedMime,
    extension,
    bytes: buffer.length,
    warnings: warnings.length ? warnings : ["Tipo de documento no soportado para extraccion."],
  };
}

function scorePatterns(
  target: string,
  patterns: Array<{ pattern: RegExp; label: string; weight: number }>,
) {
  let score = 0;
  const labels: string[] = [];

  for (const item of patterns) {
    const matches = target.match(item.pattern);
    if (!matches?.length) continue;
    score += Math.min(item.weight * matches.length, item.weight * 2);
    labels.push(item.label);
  }

  return { score, labels };
}

function scoreNegativeTerms(target: string) {
  let score = 0;
  for (const pattern of NEGATIVE_TERMS) {
    const matches = target.match(pattern);
    if (matches?.length) score += Math.min(0.08 * matches.length, 0.16);
  }
  return score;
}

export function classifyDocumentByRules(params: {
  fileName?: string;
  filePath?: string;
  text?: string;
  extracted?: ExtractedDocumentText;
}): RuleEvaluation {
  const displayName = trimText(params.filePath || params.fileName);
  const normalizedName = normalizeDocumentText(displayName);
  const normalizedText = normalizeDocumentText(params.text || "");
  const textPreview = compactText(normalizedText, 900);

  const filenameSignals = scorePatterns(normalizedName, BITACORA_TERMS);
  const contentSignals = scorePatterns(normalizedText, BITACORA_TERMS);
  const structureSignals = scorePatterns(normalizedText, STRUCTURE_TERMS);
  const scheduleRows = splitBitacoraScheduleRows(params.text || "");
  const scheduleLabels = scheduleRows.length >= 4 ? ["filas semanales con fechas"] : [];
  const scheduleScore = scheduleRows.length >= 4 ? 0.18 : scheduleRows.length >= 2 ? 0.08 : 0;
  const hasBitacoraSignal = filenameSignals.labels.length > 0 || contentSignals.labels.length > 0;
  const rawNegativeScore = scoreNegativeTerms(`${normalizedName}\n${normalizedText}`);
  const negativeScore = scheduleRows.length >= 4 && hasBitacoraSignal
    ? Math.min(rawNegativeScore, 0.08)
    : rawNegativeScore;

  const filenameScore = Math.min(0.46, filenameSignals.score * 1.25);
  const contentScore = Math.min(0.5, contentSignals.score);
  const structureScore = Math.min(0.34, structureSignals.score + scheduleScore);
  const rawScore = clamp01(filenameScore + contentScore + structureScore - negativeScore);

  const matchedTerms = uniqueStrings([
    ...filenameSignals.labels,
    ...contentSignals.labels,
    ...structureSignals.labels,
    ...scheduleLabels,
  ]);

  const evidence: string[] = [];
  for (const label of uniqueStrings(filenameSignals.labels)) {
    evidence.push(`El nombre del archivo contiene "${label}".`);
  }
  for (const label of uniqueStrings(contentSignals.labels)) {
    evidence.push(`El texto extraido contiene "${label}".`);
  }
  for (const label of uniqueStrings(structureSignals.labels).slice(0, 4)) {
    evidence.push(`El texto tiene una senal de seguimiento: "${label}".`);
  }
  if (scheduleRows.length >= 4) {
    evidence.push(`El texto tiene ${scheduleRows.length} fila(s) semanales con fecha.`);
  }
  if (negativeScore > 0 && rawScore < 0.5) {
    evidence.push("Tambien aparecen senales de otro tipo de documento academico.");
  }

  const label: DocumentClassificationLabel = rawScore >= 0.55 ? "BITACORA" : "OTRO";
  const confidence = label === "BITACORA"
    ? Math.max(0.56, Math.min(0.94, rawScore))
    : Math.max(0.52, Math.min(0.92, 1 - rawScore));

  const reason = label === "BITACORA"
    ? "El documento contiene senales de seguimiento periodico de actividades o avances."
    : "No hay senales suficientes para clasificarlo como bitacora o registro de seguimiento.";

  return {
    classification: {
      label,
      confidence: roundConfidence(confidence),
      method: "rules",
      evidence: evidence.slice(0, 8),
      reason,
    },
    features: {
      normalizedName,
      normalizedTextPreview: textPreview,
      matchedTerms,
      filenameScore: roundConfidence(filenameScore),
      contentScore: roundConfidence(contentScore),
      structureScore: roundConfidence(structureScore),
      negativeScore: roundConfidence(negativeScore),
      textLength: normalizedText.length,
      extractionSource: params.extracted?.source || "provided_text",
    },
  };
}

function extractJsonObject(rawOutput: string) {
  const raw = trimText(rawOutput);
  if (!raw) return null;

  const candidates = [raw];
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(raw.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }

  return null;
}

function normalizeModelLabel(value: unknown): DocumentClassificationLabel | null {
  const label = normalizeDocumentText(trimText(value))
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  if (label === "BITACORA") return "BITACORA";
  if (label === "OTRO" || label === "NO BITACORA") return "OTRO";
  return null;
}

function parseModelClassification(rawOutput: string): DocumentClassification | null {
  const parsed = extractJsonObject(rawOutput);
  if (!parsed) return null;

  const label = normalizeModelLabel(parsed.label);
  if (!label) return null;

  const confidence = clamp01(Number(parsed.confidence));
  const rawEvidence = Array.isArray(parsed.evidence) ? parsed.evidence : [];
  const evidence = rawEvidence
    .map((item) => compactText(String(item || ""), 180))
    .filter(Boolean)
    .slice(0, 6);

  return {
    label,
    confidence: roundConfidence(confidence || 0.65),
    method: "hybrid",
    evidence,
    reason: compactText(String(parsed.reason || ""), 360)
      || (label === "BITACORA"
        ? "El modelo local confirmo senales de bitacora."
        : "El modelo local no encontro senales suficientes de bitacora."),
  };
}

function buildClassificationPrompt(params: {
  fileName: string;
  filePath: string;
  extracted: ExtractedDocumentText;
  rules: DocumentClassification;
}) {
  const text = compactText(params.extracted.text, 9000);
  return [
    "Eres un clasificador documental academico para ADACEEN/PDC.",
    "Decide si el documento es una bitacora academica o similar.",
    "Incluye como BITACORA: bitacora, diario de campo, registro de actividades, seguimiento semanal, logbook, registro de avance o control periodico de avances.",
    "No incluyas como BITACORA: rubricas, guias, parciales, diapositivas, silabos, enunciados o material de lectura sin seguimiento periodico.",
    "El campo label debe ser exactamente \"BITACORA\" o exactamente \"OTRO\".",
    "No uses \"BITACORA|OTRO\", listas, markdown ni texto adicional fuera del JSON.",
    "Responde SOLO JSON valido con este formato exacto:",
    "{\"label\":\"BITACORA\",\"confidence\":0.0,\"evidence\":[\"...\"],\"reason\":\"...\"}",
    "",
    `fileName: ${params.fileName || "(sin nombre)"}`,
    `filePath: ${params.filePath || "(sin ruta)"}`,
    `extractionSource: ${params.extracted.source}`,
    `rulesLabel: ${params.rules.label}`,
    `rulesConfidence: ${params.rules.confidence}`,
    `rulesEvidence: ${params.rules.evidence.join(" | ") || "(sin evidencia)"}`,
    "",
    "Texto extraido:",
    text || "(sin texto extraido)",
  ].join("\n");
}

function mergeRuleAndModel(rule: DocumentClassification, model: DocumentClassification) {
  const sameLabel = rule.label === model.label;
  const evidence = uniqueStrings([
    ...rule.evidence,
    ...model.evidence.map((item) => `LLM local: ${item}`),
  ]).slice(0, 8);

  if (sameLabel) {
    return {
      label: rule.label,
      confidence: roundConfidence(Math.max(rule.confidence, (rule.confidence + model.confidence) / 2)),
      method: "hybrid" as const,
      evidence,
      reason: model.reason || rule.reason,
    };
  }

  if (rule.label === "BITACORA" && rule.confidence >= 0.78) {
    return {
      label: "BITACORA" as const,
      confidence: roundConfidence(Math.max(0.62, rule.confidence * 0.9)),
      method: "hybrid" as const,
      evidence: uniqueStrings([...evidence, "Las reglas locales tienen evidencia fuerte aunque el modelo discrepo."]).slice(0, 8),
      reason: rule.reason,
    };
  }

  if (model.label === "BITACORA" && model.confidence >= 0.68) {
    return {
      label: "BITACORA" as const,
      confidence: roundConfidence(Math.max(model.confidence * 0.95, rule.confidence)),
      method: "hybrid" as const,
      evidence,
      reason: model.reason,
    };
  }

  return {
    label: "OTRO" as const,
    confidence: roundConfidence(Math.max(0.55, model.label === "OTRO" ? model.confidence : rule.confidence)),
    method: "hybrid" as const,
    evidence,
    reason: model.label === "OTRO" ? model.reason : rule.reason,
  };
}

export async function classifyDocument(input: DocumentClassifierInput): Promise<DocumentClassificationResult> {
  const fileName = trimText(input.fileName || path.basename(trimText(input.filePath)));
  const filePath = trimText(input.filePath);
  const extracted = await extractDocumentText(input);
  const ruleEvaluation = classifyDocumentByRules({
    fileName,
    filePath,
    text: extracted.text,
    extracted,
  });

  let classification = ruleEvaluation.classification;
  let modelUsed = false;
  let modelError = "";
  let modelRawOutput = "";

  const shouldUseModel = input.useModel !== false
    && extracted.text.length > 0
    && (classification.label === "BITACORA" || classification.confidence < 0.82);

  if (shouldUseModel) {
    try {
      const prompt = buildClassificationPrompt({
        fileName,
        filePath,
        extracted,
        rules: classification,
      });
      modelRawOutput = await runTextByMode(prompt);
      const modelClassification = parseModelClassification(modelRawOutput);
      if (modelClassification) {
        classification = mergeRuleAndModel(classification, modelClassification);
        modelUsed = true;
      } else {
        modelError = "El modelo local no devolvio JSON valido.";
      }
    } catch (error) {
      modelError = trimText(String(error));
    }
  }

  return {
    classification,
    extracted,
    features: {
      ...ruleEvaluation.features,
      extractionSource: extracted.source,
    },
    trainingExample: {
      input: {
        fileName,
        filePath,
        textPreview: compactText(extracted.text, 1600),
      },
      expectedLabel: null,
      predictedLabel: classification.label,
    },
    modelUsed,
    modelError,
    modelRawOutput,
  };
}
