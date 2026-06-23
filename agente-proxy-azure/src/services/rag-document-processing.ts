import path from "node:path";
import { PDFParse } from "pdf-parse";
import { env } from "../config/env.js";
import {
  extractDocumentText,
  type DocumentClassifierInput,
  type ExtractedDocumentText,
} from "./document-classifier.js";
import { trimText } from "./text-utils.js";

export type RagDocumentPage = {
  pageNumber: number | null;
  text: string;
  charStart: number;
  charEnd: number;
};

export type RagDocumentExtraction = Omit<ExtractedDocumentText, "pages"> & {
  pages: RagDocumentPage[];
  totalPages: number | null;
  truncated: boolean;
};

export type RagTextChunk = {
  index: number;
  text: string;
  pageStart: number | null;
  pageEnd: number | null;
  charStart: number;
  charEnd: number;
  estimatedTokens: number;
};

export type RagChunkOptions = {
  targetChars?: number;
  overlapChars?: number;
  minChunkChars?: number;
  maxChunks?: number;
};

function normalizeExtension(value: unknown) {
  return trimText(value).replace(/^\./, "").toLowerCase();
}

function inferExtensionFromName(value: string) {
  return normalizeExtension(path.extname(trimText(value)));
}

function cleanExtractedText(value: string) {
  return trimText(value)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\r?\n/g, "\n")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .replace(/[ \t]{2,}/g, " ");
}

function estimateTokens(value: string) {
  const words = trimText(value).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words * 1.25));
}

function singlePageExtraction(extracted: ExtractedDocumentText): RagDocumentExtraction {
  const text = cleanExtractedText(extracted.text);
  return {
    ...extracted,
    text,
    pages: text
      ? [{
          pageNumber: null,
          text,
          charStart: 0,
          charEnd: text.length,
        }]
      : [],
    totalPages: null,
    truncated: extracted.text.length > text.length,
  };
}

async function extractPdfForRag(
  input: DocumentClassifierInput,
  maxTextChars: number,
): Promise<RagDocumentExtraction> {
  const buffer = input.buffer;
  const warnings: string[] = [];
  if (!buffer?.length) {
    return {
      text: "",
      source: "empty",
      mimeType: trimText(input.mimeType).toLowerCase() || "application/pdf",
      extension: "pdf",
      bytes: 0,
      warnings: ["No se recibio contenido PDF para extraer."],
      pages: [],
      totalPages: null,
      truncated: false,
    };
  }

  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    let text = "";
    let truncated = false;
    const pages: RagDocumentPage[] = [];

    for (const page of result.pages || []) {
      const cleanPageText = cleanExtractedText(page.text || "");
      if (!cleanPageText) continue;

      const separatorLength = text ? 2 : 0;
      const remaining = maxTextChars - text.length - separatorLength;
      if (remaining <= 0) {
        truncated = true;
        break;
      }

      const pageText = cleanPageText.length > remaining
        ? cleanPageText.slice(0, remaining)
        : cleanPageText;
      if (pageText.length < cleanPageText.length) {
        truncated = true;
      }

      if (text) text += "\n\n";
      const charStart = text.length;
      text += pageText;
      const charEnd = text.length;
      pages.push({
        pageNumber: Number.isFinite(Number(page.num)) ? Number(page.num) : null,
        text: pageText,
        charStart,
        charEnd,
      });

      if (truncated) break;
    }

    if (!text && trimText(result.text)) {
      text = cleanExtractedText(result.text).slice(0, maxTextChars);
      pages.push({
        pageNumber: null,
        text,
        charStart: 0,
        charEnd: text.length,
      });
      truncated = cleanExtractedText(result.text).length > text.length;
    }

    if (truncated) {
      warnings.push(`Texto PDF truncado a ${maxTextChars} caracteres para ingesta RAG.`);
    }

    return {
      text,
      source: "pdf",
      mimeType: "application/pdf",
      extension: "pdf",
      bytes: buffer.length,
      warnings,
      pages,
      totalPages: Number.isFinite(Number(result.total)) ? Number(result.total) : pages.length || null,
      truncated,
    };
  } catch (error) {
    return {
      text: "",
      source: "unsupported",
      mimeType: trimText(input.mimeType).toLowerCase() || "application/pdf",
      extension: "pdf",
      bytes: buffer.length,
      warnings: [`No se pudo extraer texto del PDF: ${String(error)}`],
      pages: [],
      totalPages: null,
      truncated: false,
    };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

export async function extractRagDocumentText(input: DocumentClassifierInput): Promise<RagDocumentExtraction> {
  const maxTextChars = Math.max(1000, Number(input.maxTextChars) || env.ragMaxExtractedTextChars);
  const fileName = trimText(input.fileName || input.filePath);
  const extension = normalizeExtension(input.extension) || inferExtensionFromName(fileName);
  const mimeType = trimText(input.mimeType).toLowerCase();

  if (input.buffer?.length && (extension === "pdf" || mimeType === "application/pdf")) {
    return extractPdfForRag(input, maxTextChars);
  }

  const extracted = await extractDocumentText({
    ...input,
    maxTextChars,
    useModel: false,
  });
  return singlePageExtraction(extracted);
}

function chunkEndAtBoundary(text: string, start: number, minEnd: number, idealEnd: number) {
  if (idealEnd >= text.length) return text.length;

  const safeMinEnd = Math.max(start + 1, Math.min(minEnd, idealEnd));
  const window = text.slice(safeMinEnd, idealEnd + 1);
  const pattern = /(\n{2,}|\n|[.!?;:]\s+)/g;
  let best = -1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(window))) {
    best = safeMinEnd + match.index + match[0].length;
  }

  return best > start ? best : idealEnd;
}

function nextChunkStart(text: string, currentStart: number, currentEnd: number, overlapChars: number) {
  if (currentEnd >= text.length) return text.length;
  const overlapped = Math.max(currentStart + 1, currentEnd - overlapChars);
  const boundary = text.indexOf(" ", overlapped);
  if (boundary >= 0 && boundary < currentEnd) return boundary + 1;
  return overlapped;
}

function pageSpanForRange(pages: RagDocumentPage[], start: number, end: number) {
  const pageNumbers = pages
    .filter((page) => page.pageNumber != null && page.charEnd > start && page.charStart < end)
    .map((page) => Number(page.pageNumber))
    .filter((pageNumber) => Number.isFinite(pageNumber));

  if (!pageNumbers.length) {
    return { pageStart: null, pageEnd: null };
  }

  return {
    pageStart: Math.min(...pageNumbers),
    pageEnd: Math.max(...pageNumbers),
  };
}

function normalizeChunkOptions(options?: RagChunkOptions) {
  const targetChars = Math.max(600, Number(options?.targetChars) || env.ragChunkTargetChars);
  const overlapChars = Math.max(0, Math.min(targetChars - 1, Number(options?.overlapChars) || env.ragChunkOverlapChars));
  const minChunkChars = Math.max(120, Math.min(targetChars, Number(options?.minChunkChars) || env.ragMinChunkChars));
  const maxChunks = Math.max(1, Math.round(Number(options?.maxChunks) || env.ragMaxChunksPerSource));
  return { targetChars, overlapChars, minChunkChars, maxChunks };
}

export function chunkRagDocument(
  extraction: Pick<RagDocumentExtraction, "text" | "pages">,
  options?: RagChunkOptions,
) {
  const text = cleanExtractedText(extraction.text);
  if (!text) return [];

  const { targetChars, overlapChars, minChunkChars, maxChunks } = normalizeChunkOptions(options);
  const pages = extraction.pages?.length
    ? extraction.pages
    : [{
        pageNumber: null,
        text,
        charStart: 0,
        charEnd: text.length,
      }];
  const chunks: RagTextChunk[] = [];
  let start = 0;

  while (start < text.length && chunks.length < maxChunks) {
    while (start < text.length && /\s/.test(text[start] || "")) start += 1;
    if (start >= text.length) break;

    const idealEnd = Math.min(text.length, start + targetChars);
    const minEnd = Math.min(text.length, start + minChunkChars);
    let end = chunkEndAtBoundary(text, start, minEnd, idealEnd);
    if (end <= start) end = Math.min(text.length, start + targetChars);

    let chunkText = trimText(text.slice(start, end));
    if (!chunkText) {
      start = end + 1;
      continue;
    }

    if (chunkText.length < minChunkChars && chunks.length > 0 && end >= text.length) {
      const previous = chunks[chunks.length - 1];
      const mergedText = trimText(`${previous.text}\n\n${chunkText}`);
      const span = pageSpanForRange(pages, previous.charStart, end);
      chunks[chunks.length - 1] = {
        ...previous,
        text: mergedText,
        charEnd: end,
        pageStart: span.pageStart,
        pageEnd: span.pageEnd,
        estimatedTokens: estimateTokens(mergedText),
      };
      break;
    }

    const span = pageSpanForRange(pages, start, end);
    chunks.push({
      index: chunks.length + 1,
      text: chunkText,
      pageStart: span.pageStart,
      pageEnd: span.pageEnd,
      charStart: start,
      charEnd: end,
      estimatedTokens: estimateTokens(chunkText),
    });

    start = nextChunkStart(text, start, end, overlapChars);
  }

  return chunks;
}
