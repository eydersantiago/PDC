// Extraer el texto de un documento cargado: PDF, DOCX, texto plano e imagenes (OCR).
import { fileTypeFromBuffer } from "file-type";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import Tesseract from "tesseract.js";
import { trimText } from "../shared/text-utils.js";
import { normalizeExtension, inferExtensionFromName } from "./document-text-utils.js";

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

const DEFAULT_MAX_TEXT_CHARS = 120000;

const OCR_LANGUAGES = process.env.DOCUMENT_OCR_LANGUAGES || "spa+eng";

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
