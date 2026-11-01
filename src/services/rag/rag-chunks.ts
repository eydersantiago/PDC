// Fragmentos (chunks) de una fuente RAG y sus rotulos de cita.
import { env } from "../../config/env.js";
import type { RagSource, RagSourceChunk, RagSourceChunkInput } from "../../types/app.js";
import { trimText } from "../shared/text-utils.js";
import { metadataToText, countTokens, metadataString, truncate } from "./rag-text.js";

export type RagChunkBuildPage = {
  pageNumber?: number | null;
  text: string;
};

function splitLongUnit(value: string, targetChars: number) {
  const text = trimText(value).replace(/\s+/g, " ");
  if (text.length <= targetChars) return [text].filter(Boolean);

  const sentences = text
    .split(/(?<=[.!?;:])\s+/u)
    .map((item) => trimText(item))
    .filter(Boolean);
  const units = sentences.length > 1 ? sentences : text.match(new RegExp(`.{1,${targetChars}}(?:\\s+|$)`, "gu")) || [text];
  const chunks: string[] = [];
  let current = "";

  for (const unit of units) {
    const candidate = current ? `${current} ${unit}` : unit;
    if (current && candidate.length > targetChars) {
      chunks.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function splitTextUnits(text: string, targetChars: number) {
  return trimText(text)
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .split(/\n{2,}|(?=^#{1,4}\s+)/mu)
    .map((unit) => trimText(unit))
    .filter(Boolean)
    .flatMap((unit) => splitLongUnit(unit, targetChars));
}

function cleanCitationBase(value: string) {
  return trimText(value)
    .replace(/[\[\]\n\r\t]+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 90)
    || "RAG";
}

function pageSuffix(pageStart: number | null, pageEnd: number | null) {
  if (!pageStart) return "";
  if (pageEnd && pageEnd !== pageStart) return ` p.${pageStart}-${pageEnd}`;
  return ` p.${pageStart}`;
}

function citationLabel(base: string, chunkIndex: number, pageStart: number | null, pageEnd: number | null) {
  return `[${cleanCitationBase(base)}#c${chunkIndex + 1}${pageSuffix(pageStart, pageEnd)}]`;
}

function chunkTitle(title: string, pageStart: number | null, pageEnd: number | null) {
  const pageText = pageSuffix(pageStart, pageEnd);
  return pageText ? `${title}${pageText}` : title;
}

type PendingChunkPart = {
  text: string;
  charStart: number;
  charEnd: number;
  pageStart: number | null;
  pageEnd: number | null;
};

function buildChunkInput(params: {
  index: number;
  parts: PendingChunkPart[];
  citationBase: string;
  title: string;
  fileName: string;
  sourceType: string;
  metadata: Record<string, unknown>;
}): RagSourceChunkInput {
  const contentText = params.parts.map((part) => part.text).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  const charStart = Math.min(...params.parts.map((part) => part.charStart));
  const charEnd = Math.max(...params.parts.map((part) => part.charEnd));
  const pages = params.parts
    .flatMap((part) => [part.pageStart, part.pageEnd])
    .filter((page): page is number => Number.isFinite(Number(page)) && Number(page) > 0);
  const pageStart = pages.length ? Math.min(...pages) : null;
  const pageEnd = pages.length ? Math.max(...pages) : null;
  const title = chunkTitle(params.title, pageStart, pageEnd);
  const searchText = [
    params.title,
    title,
    params.fileName,
    params.sourceType,
    metadataToText(params.metadata),
    contentText,
  ].filter(Boolean).join("\n");

  return {
    chunkIndex: params.index,
    contentText,
    searchText,
    tokenCount: countTokens(contentText),
    charStart,
    charEnd,
    pageStart,
    pageEnd,
    citationLabel: citationLabel(params.citationBase, params.index, pageStart, pageEnd),
    metadata: {
      pageStart,
      pageEnd,
      title,
      charStart,
      charEnd,
    },
  };
}

export function buildRagChunksForSource(input: {
  title: string;
  sourceType?: string;
  fileName?: string;
  sourceKey?: string;
  contentText: string;
  metadata?: Record<string, unknown>;
  pages?: RagChunkBuildPage[];
}): RagSourceChunkInput[] {
  const title = trimText(input.title) || trimText(input.fileName) || "Fuente RAG";
  const sourceType = trimText(input.sourceType) || "document";
  const fileName = trimText(input.fileName);
  const metadata = input.metadata || {};
  const targetChars = Math.max(500, Number(env.ragChunkTargetChars) || 1600);
  const overlapChars = Math.max(0, Math.min(targetChars / 2, Number(env.ragChunkOverlapChars) || 0));
  const minChunkChars = Math.max(80, Math.min(targetChars, Number(env.ragMinChunkChars) || 320));
  const maxChunks = Math.max(1, Math.min(500, Number(env.ragMaxChunksPerSource) || 180));
  const citationBase = cleanCitationBase(
    metadataString(metadata, "id")
      || trimText(input.sourceKey)
      || fileName
      || title,
  );
  const sourcePages = (input.pages || [])
    .map((page) => ({
      pageNumber: Number(page.pageNumber) || null,
      text: trimText(page.text),
    }))
    .filter((page) => page.text);
  const fallbackText = trimText(input.contentText);
  const pages = sourcePages.length
    ? sourcePages
    : fallbackText
      ? [{ pageNumber: null, text: fallbackText }]
      : [];
  const parts: PendingChunkPart[] = [];
  let cursor = 0;

  for (const page of pages) {
    for (const unit of splitTextUnits(page.text, targetChars)) {
      const text = trimText(unit);
      if (!text) continue;
      const charStart = cursor;
      const charEnd = cursor + text.length;
      cursor = charEnd + 2;
      parts.push({
        text,
        charStart,
        charEnd,
        pageStart: page.pageNumber,
        pageEnd: page.pageNumber,
      });
    }
  }

  const chunks: RagSourceChunkInput[] = [];
  let current: PendingChunkPart[] = [];
  let currentLength = 0;

  function emitCurrent(force = false) {
    if (!current.length) return;
    const contentLength = current.reduce((total, part) => total + part.text.length + 2, 0);
    if (!force && contentLength < minChunkChars && chunks.length > 0) return;

    chunks.push(buildChunkInput({
      index: chunks.length,
      parts: current,
      citationBase,
      title,
      fileName,
      sourceType,
      metadata,
    }));

    const overlap: PendingChunkPart[] = [];
    let overlapLength = 0;
    for (const part of [...current].reverse()) {
      if (overlapLength >= overlapChars) break;
      overlap.unshift(part);
      overlapLength += part.text.length + 2;
    }
    current = overlap;
    currentLength = overlapLength;
  }

  for (const part of parts) {
    if (chunks.length >= maxChunks) break;
    const nextLength = currentLength + part.text.length + 2;
    if (current.length && nextLength > targetChars) {
      emitCurrent();
    }
    current.push(part);
    currentLength += part.text.length + 2;
  }

  if (chunks.length < maxChunks) {
    emitCurrent(true);
  }

  return chunks.length
    ? chunks.slice(0, maxChunks)
    : fallbackText
      ? [buildChunkInput({
        index: 0,
        parts: [{
          text: truncate(fallbackText, targetChars),
          charStart: 0,
          charEnd: Math.min(fallbackText.length, targetChars),
          pageStart: null,
          pageEnd: null,
        }],
        citationBase,
        title,
        fileName,
        sourceType,
        metadata,
      })]
      : [];
}

function fallbackChunksForSource(source: RagSource): RagSourceChunk[] {
  return buildRagChunksForSource({
    title: source.title,
    sourceType: source.sourceType,
    fileName: source.fileName,
    sourceKey: source.sourceKey,
    contentText: source.contentText,
    metadata: source.metadata,
  }).map((chunk) => ({
    id: `${source.id}:chunk:${chunk.chunkIndex}`,
    sourceId: source.id,
    scope: source.scope,
    teacherUserId: source.teacherUserId,
    sourceKey: source.sourceKey,
    sourceTitle: source.title,
    sourceType: source.sourceType,
    fileName: source.fileName,
    mimeType: source.mimeType,
    sourceMetadata: source.metadata,
    isActive: source.isActive,
    ...chunk,
    createdAt: source.createdAt,
  }));
}

export function sourceChunks(source: RagSource) {
  const chunks = source.chunks?.length ? source.chunks : fallbackChunksForSource(source);
  return chunks.filter((chunk) => chunk.isActive !== false && trimText(chunk.contentText));
}

export function formatRagPageRange(pageStart: number | null, pageEnd: number | null) {
  if (!pageStart) return "";
  if (pageEnd && pageEnd !== pageStart) return `p. ${pageStart}-${pageEnd}`;
  return `p. ${pageStart}`;
}
