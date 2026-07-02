import { env } from "../config/env.js";
import { DEFAULT_RAG_COURSE_CODE, getKnownRagCourseOrDefault, normalizeRagCourseCode } from "./rag-courses.js";
import type {
  GithubMentorContext,
  GithubMentorResult,
  RagCitation,
  RagContextItem,
  RagSource,
  RagSourceChunk,
  RagSourceChunkInput,
} from "../types/app.js";
import { trimText, uniqueStrings } from "./text-utils.js";

export type RagChunkBuildPage = {
  pageNumber?: number | null;
  text: string;
};

const STOPWORDS = new Set([
  "a",
  "al",
  "ante",
  "bajo",
  "cada",
  "como",
  "con",
  "contra",
  "cual",
  "cuando",
  "de",
  "del",
  "desde",
  "donde",
  "el",
  "en",
  "entre",
  "esa",
  "ese",
  "esta",
  "este",
  "esto",
  "la",
  "las",
  "lo",
  "los",
  "mas",
  "muy",
  "o",
  "para",
  "por",
  "que",
  "se",
  "sin",
  "sobre",
  "su",
  "sus",
  "un",
  "una",
  "uno",
  "and",
  "for",
  "from",
  "that",
  "the",
  "this",
  "your",
]);

const SEMANTIC_EXPANSIONS: Record<string, string[]> = {
  abstraccion: ["abstraer", "modelo", "entidad", "responsabilidad", "clase", "diseno"],
  encapsulamiento: ["private", "privado", "atributo", "getter", "setter", "metodo", "invariante"],
  encapsul: ["private", "privado", "atributo", "getter", "setter", "metodo", "invariante"],
  herencia: ["extends", "subclase", "superclase", "clase base", "es un", "reutilizacion"],
  polimorfismo: ["virtual", "override", "sobrescritura", "interfaz", "contrato", "subtipo"],
  modularidad: ["modulo", "libreria", "header", "separacion", "responsabilidad"],
  refactor: ["mejora", "limpieza", "duplicacion", "estructura", "mantenibilidad"],
  compilacion: ["compilar", "g++", "linker", "undefined reference", "build"],
  puntero: ["referencia", "memoria", "new", "delete", "direccion"],
  clase: ["objeto", "atributo", "metodo", "responsabilidad", "constructor"],
  objeto: ["instancia", "clase", "estado", "mensaje", "metodo"],
  prueba: ["test", "assert", "validacion", "caso", "verificar"],
  github: ["commit", "rama", "pull request", "codespace", "repositorio"],
};

function normalizeForSearch(value: string) {
  return trimText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stemToken(token: string) {
  return token
    .replace(/(amientos|imiento|aciones|acion|adoras|adores|adora|ador|idades|idad|mente)$/u, "")
    .replace(/(ando|iendo|ados|adas|ado|ada|icos|icas|ico|ica|es|s)$/u, "")
    .trim();
}

function rawTokens(value: string) {
  return normalizeForSearch(value)
    .split(" ")
    .map((token) => stemToken(token.trim()))
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function tokenize(value: string) {
  return uniqueStrings(rawTokens(value)).slice(0, 100);
}

function expandTokens(tokens: string[]) {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    const additions = SEMANTIC_EXPANSIONS[token] || [];
    for (const addition of additions) {
      for (const nested of rawTokens(addition)) {
        expanded.add(nested);
      }
    }
  }
  return [...expanded].slice(0, 160);
}

function vectorize(value: string) {
  const vector = new Map<string, number>();
  for (const token of rawTokens(value)) {
    vector.set(token, (vector.get(token) || 0) + 1);
  }
  return vector;
}

function vectorizeTokens(tokens: string[]) {
  const vector = new Map<string, number>();
  for (const token of tokens) {
    vector.set(token, (vector.get(token) || 0) + 1);
  }
  return vector;
}

function cosineSimilarity(left: Map<string, number>, right: Map<string, number>) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (const value of left.values()) {
    leftNorm += value * value;
  }
  for (const value of right.values()) {
    rightNorm += value * value;
  }
  for (const [token, value] of left.entries()) {
    dot += value * (right.get(token) || 0);
  }

  if (!leftNorm || !rightNorm) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function metadataString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value
      .map((item) => trimText(String(item ?? "")))
      .filter(Boolean)
      .join(", ");
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return trimText(String(value));
  }
  return "";
}

function metadataToText(metadata: Record<string, unknown>) {
  const preferred = [
    "knowledge_tier",
    "knowledgeTier",
    "context_domain",
    "contextDomain",
    "description",
    "role",
    "category",
    "date",
    "week",
    "source_pdf",
    "path",
    "repoFullName",
    "courseCode",
    "original_url",
    "download_url",
    "rag_use",
    "tags",
  ]
    .map((key) => metadataString(metadata, key))
    .filter(Boolean)
    .join("\n");

  if (preferred) return preferred;

  try {
    return JSON.stringify(metadata);
  } catch {
    return "";
  }
}

export type RagKnowledgeTier = "primary" | "supplemental" | "reference";

function normalizedMetadataProbe(metadata: Record<string, unknown>, sourceType = "") {
  return [
    metadataString(metadata, "knowledge_tier"),
    metadataString(metadata, "knowledgeTier"),
    metadataString(metadata, "context_domain"),
    metadataString(metadata, "contextDomain"),
    metadataString(metadata, "rag_use"),
    metadataString(metadata, "role"),
    metadataString(metadata, "category"),
    metadataString(metadata, "source_pdf"),
    metadataString(metadata, "path"),
    metadataString(metadata, "title"),
    metadataString(metadata, "access_status"),
    sourceType,
  ].join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function getRagKnowledgeTier(metadata: Record<string, unknown>, sourceType = ""): RagKnowledgeTier {
  const explicit = metadataString(metadata, "knowledge_tier") || metadataString(metadata, "knowledgeTier");
  const normalizedExplicit = explicit
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (/^(primary|principal|rag|course_rag|bibliografia|bibliography)$/.test(normalizedExplicit)) return "primary";
  if (/^(supplemental|suplementario|bitacora|actividad|agenda|course_context)$/.test(normalizedExplicit)) return "supplemental";
  if (/^(reference|referencia|omitido|omitted|reference_only)$/.test(normalizedExplicit)) return "reference";

  const probe = normalizedMetadataProbe(metadata, sourceType);
  if (/referencia editorial|libro comercial|descarga libre no verificada|reference_only|omitido|omitted/.test(probe)) {
    return "reference";
  }
  if (/\bbitacora\b|cronograma_bitacora|agenda|actividad_clase|actividad_evaluacion|semana\s+\d+/.test(probe)) {
    return "supplemental";
  }
  return "primary";
}

export function isPrimaryRagSource(source: Pick<RagSource, "metadata" | "sourceType">) {
  return getRagKnowledgeTier(source.metadata || {}, source.sourceType) === "primary";
}

export function isRetrievableRagSource(source: Pick<RagSource, "metadata" | "sourceType">, includeSupplemental = false) {
  const tier = getRagKnowledgeTier(source.metadata || {}, source.sourceType);
  if (tier === "reference") return false;
  return tier === "primary" || includeSupplemental;
}

export function sourceUrl(metadata: Record<string, unknown>) {
  return metadataString(metadata, "download_url")
    || metadataString(metadata, "downloadUrl")
    || metadataString(metadata, "original_url")
    || metadataString(metadata, "originalUrl")
    || metadataString(metadata, "url")
    || metadataString(metadata, "courseMaterialUrl");
}

function truncate(value: string, max: number) {
  const text = trimText(value).replace(/\s+/g, " ");
  if (!text || text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function countTokens(value: string) {
  return rawTokens(value).length;
}

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

function sourceChunks(source: RagSource) {
  const chunks = source.chunks?.length ? source.chunks : fallbackChunksForSource(source);
  return chunks.filter((chunk) => chunk.isActive !== false && trimText(chunk.contentText));
}

function tokenFrequencyScore(text: string, tokens: string[]) {
  const vector = vectorize(text);
  let score = 0;
  let covered = 0;
  for (const token of tokens) {
    const frequency = vector.get(token) || 0;
    if (!frequency) continue;
    covered += 1;
    score += Math.min(Math.log1p(frequency) * 1.5, 4);
  }
  if (tokens.length) {
    score += (covered / tokens.length) * 3;
  }
  return score;
}

function scoreChunk(source: RagSource, chunk: RagSourceChunk, queryTokens: string[], expandedTokens: string[]) {
  const knowledgeTier = getRagKnowledgeTier(source.metadata, source.sourceType);
  const queryText = [...queryTokens, ...expandedTokens].join(" ");
  const supplementalIsDirectlyRelevant = /\b(semana|agenda|actividad|fecha|entrega|tarea|cronograma|bitacora|bitacor)\b/.test(queryText);
  const tierMultiplier = knowledgeTier === "supplemental"
    ? (supplementalIsDirectlyRelevant ? 0.72 : 0.45)
    : 1;
  if (!queryTokens.length) {
    const baseScore = source.scope === "teacher" ? 1.5 : 1;
    return {
      ftsScore: Math.round(baseScore * tierMultiplier * 100) / 100,
      semanticScore: 0,
      score: Math.round(baseScore * tierMultiplier * 100) / 100,
    };
  }

  const titleText = `${source.title}\n${chunk.sourceTitle}\n${chunk.metadata?.title || ""}`;
  const fileText = `${source.fileName}\n${source.sourceType}`;
  const metadataText = `${metadataToText(source.metadata)}\n${metadataToText(chunk.metadata)}`;
  let ftsScore = source.scope === "teacher" ? 0.35 : 0;

  ftsScore += tokenFrequencyScore(titleText, queryTokens) * 2.4;
  ftsScore += tokenFrequencyScore(fileText, queryTokens) * 1.4;
  ftsScore += tokenFrequencyScore(metadataText, queryTokens) * 1.2;
  ftsScore += tokenFrequencyScore(chunk.contentText, queryTokens);
  ftsScore += tokenFrequencyScore(chunk.searchText, expandedTokens) * 0.45;

  const queryVector = vectorizeTokens(expandedTokens);
  const semanticScore = cosineSimilarity(queryVector, vectorize(chunk.searchText)) * 18;
  const score = (ftsScore + semanticScore) * tierMultiplier;

  return { ftsScore, semanticScore, score };
}

function buildExcerpt(chunk: RagSourceChunk, tokens: string[]) {
  const body = trimText(chunk.contentText) || chunk.sourceTitle;
  const paragraphs = body.split(/\n{2,}/).map((item) => trimText(item)).filter(Boolean);
  const hitParagraph = paragraphs.find((paragraph) => {
    const normalized = normalizeForSearch(paragraph);
    return tokens.some((token) => normalized.includes(token));
  });
  if (hitParagraph) return truncate(hitParagraph, 700);
  return truncate(body, 700);
}

function buildCitation(source: RagSource, chunk: RagSourceChunk): RagCitation {
  const mergedMetadata = { ...source.metadata, ...chunk.metadata };
  return {
    marker: chunk.citationLabel,
    label: chunk.citationLabel,
    sourceId: source.id,
    chunkId: chunk.id,
    title: source.title,
    fileName: source.fileName,
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
    url: sourceUrl(mergedMetadata),
  };
}

export function buildRagSearchQuery(question: string, context: GithubMentorContext) {
  return [
    question,
    context.activityTitle,
    context.learningGoal,
    context.ragCourseCode,
    context.courseCode,
    context.repoFullName,
    context.branch,
    context.filePath,
    context.languageHint,
    context.visibleError,
    context.selection,
    context.codeSnippet?.slice(0, 1200),
  ].map((item) => trimText(item)).filter(Boolean).join("\n");
}

export function rankRagSources(
  sources: RagSource[],
  query: string,
  limit = env.ragMaxSources,
): RagContextItem[] {
  const queryTokens = tokenize(query);
  const expandedTokens = expandTokens(queryTokens);
  const ranked = sources
    .filter((source) => source.isActive)
    .filter((source) => isRetrievableRagSource(source, true))
    .flatMap((source) => sourceChunks(source).map((chunk) => {
      const scores = scoreChunk(source, chunk, queryTokens, expandedTokens);
      return { source, chunk, ...scores };
    }))
    .filter((item) => queryTokens.length === 0 || item.score > 0.35)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.source.scope !== right.source.scope) return left.source.scope === "teacher" ? -1 : 1;
      if (left.chunk.chunkIndex !== right.chunk.chunkIndex) return left.chunk.chunkIndex - right.chunk.chunkIndex;
      return right.source.createdAt.localeCompare(left.source.createdAt);
    })
    .slice(0, Math.max(1, limit));

  return ranked.map(({ source, chunk, score, ftsScore, semanticScore }) => {
    const citation = buildCitation(source, chunk);
    const knowledgeTier = getRagKnowledgeTier(source.metadata, source.sourceType);
    return {
      id: source.id,
      sourceId: source.id,
      chunkId: chunk.id,
      scope: source.scope,
      title: source.title,
      sourceType: source.sourceType,
      fileName: source.fileName,
      excerpt: buildExcerpt(chunk, expandedTokens),
      score: Math.round(score * 100) / 100,
      ftsScore: Math.round(ftsScore * 100) / 100,
      semanticScore: Math.round(semanticScore * 100) / 100,
      citation,
      citationLabel: chunk.citationLabel,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      chunkIndex: chunk.chunkIndex,
      metadata: {
        ...source.metadata,
        chunk: chunk.metadata,
        citationLabel: chunk.citationLabel,
        knowledgeTier,
      },
    };
  });
}

export function rankRagChunks(
  chunks: RagSourceChunk[],
  query: string,
  limit = env.ragMaxSources,
): RagContextItem[] {
  const sourcesById = new Map<string, RagSource>();

  for (const chunk of chunks) {
    const existing = sourcesById.get(chunk.sourceId);
    if (existing) {
      existing.chunks = [...(existing.chunks || []), chunk];
      continue;
    }

    sourcesById.set(chunk.sourceId, {
      id: chunk.sourceId,
      scope: chunk.scope,
      teacherUserId: chunk.teacherUserId,
      sourceKey: chunk.sourceKey,
      title: chunk.sourceTitle,
      sourceType: chunk.sourceType,
      fileName: chunk.fileName,
      mimeType: chunk.mimeType,
      contentSha256: "",
      contentText: chunk.contentText,
      metadata: chunk.sourceMetadata,
      isActive: chunk.isActive,
      createdByUserId: null,
      createdAt: chunk.createdAt,
      updatedAt: chunk.createdAt,
      chunks: [chunk],
    });
  }

  return rankRagSources([...sourcesById.values()], query, limit);
}

export function buildRagPromptBlock(items: RagContextItem[]) {
  if (!items.length) return "";

  const block = items.map((item, index) => {
    const url = item.citation.url || sourceUrl(item.metadata);
    return [
      `${index + 1}. ${item.title}`,
      `Cita obligatoria: ${item.citationLabel}`,
      `Alcance: ${item.scope}`,
      `Rol de conocimiento: ${item.metadata.knowledgeTier === "supplemental" ? "contexto suplementario de bitacora/actividad" : "RAG principal del curso"}`,
      `Tipo: ${item.sourceType}`,
      item.fileName ? `Archivo: ${item.fileName}` : "",
      item.pageStart ? `Pagina: ${item.pageEnd && item.pageEnd !== item.pageStart ? `${item.pageStart}-${item.pageEnd}` : item.pageStart}` : "",
      url ? `URL: ${url}` : "",
      `Ranking: FTS ${item.ftsScore}; semantico ${item.semanticScore}; total ${item.score}`,
      `Extracto: ${item.excerpt || "(sin extracto)"}`,
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  return truncate([
    "Fuentes recuperadas y ordenadas por compatibilidad con el archivo, la linea o la pregunta. Prioriza siempre el RAG principal del curso para conceptos, diseno y codigo; usa bitacora/actividades solo como contexto suplementario de semana, ejercicio o entrega. Toda recomendacion basada en estas fuentes debe incluir la cita obligatoria exacta.",
    block,
  ].join("\n\n"), env.ragPromptMaxChars);
}

function hasCitation(value: string, labels: string[]) {
  const text = trimText(value);
  return labels.some((label) => text.includes(label)) || /\[[^\]]+#c\d+(?:\s+p\.\d+(?:-\d+)?)?\]/.test(text);
}

function appendCitation(value: string, label: string, labels: string[]) {
  const text = trimText(value);
  if (!text || hasCitation(text, labels)) return text;
  return `${text} ${label}`;
}

export function ensureMentorResultRagCitations(
  result: GithubMentorResult,
  items: RagContextItem[],
): GithubMentorResult {
  if (!items.length) return result;

  const labels = uniqueStrings(items.map((item) => item.citationLabel).filter(Boolean));
  if (!labels.length) return result;
  const pickLabel = (index: number) => labels[index % Math.min(labels.length, 3)] || labels[0];

  return {
    ...result,
    ideas: result.ideas.map((item, index) => appendCitation(item, pickLabel(index), labels)),
    searches: result.searches.map((item, index) => (
      /revisar|fuente|material|lectura/i.test(item)
        ? appendCitation(item, pickLabel(index), labels)
        : item
    )),
    guide: result.guide.map((item, index) => appendCitation(item, pickLabel(index), labels)),
    analysis_summary: appendCitation(result.analysis_summary, labels[0], labels),
  };
}

export function enrichMentorResultWithRag(
  result: GithubMentorResult,
  items: RagContextItem[],
  maxItems: number,
): GithubMentorResult {
  if (!items.length) return result;

  const top = items[0];
  const labels = items.slice(0, 3).map((item) => `${item.title} ${item.citationLabel}`).join(" | ");
  const enriched = {
    ...result,
    ideas: uniqueStrings([
      `Alinea tu avance con el material base: ${top.title}. ${top.citationLabel}`,
      ...result.ideas,
    ]).slice(0, maxItems),
    searches: uniqueStrings([
      ...result.searches,
      ...items.slice(0, 2).map((item) => `Revisar ${item.title} ${item.citationLabel}`),
    ]).slice(0, maxItems),
    guide: uniqueStrings([
      ...result.guide,
      `Contrasta el siguiente paso con la fuente RAG mas cercana: ${top.title}. ${top.citationLabel}`,
    ]).slice(0, Math.max(4, maxItems + 1)),
    analysis_summary: `${result.analysis_summary} RAG consultado: ${labels}.`,
  };

  return ensureMentorResultRagCitations(enriched, items);
}

export function mapRagSourceForApi(source: RagSource) {
  const courseCode = normalizeRagCourseCode(
    String(source.metadata.courseCode || source.metadata.course_code || DEFAULT_RAG_COURSE_CODE),
  );
  const course = getKnownRagCourseOrDefault(courseCode);
  const chunks = sourceChunks(source);
  const knowledgeTier = getRagKnowledgeTier(source.metadata, source.sourceType);
  return {
    id: source.id,
    scope: source.scope,
    teacherUserId: source.teacherUserId,
    sourceKey: source.sourceKey,
    title: source.title,
    sourceType: source.sourceType,
    fileName: source.fileName,
    mimeType: source.mimeType,
    contentSha256: source.contentSha256,
    textLength: source.contentText.length,
    textPreview: truncate(source.contentText, 360),
    chunkCount: chunks.length,
    chunks: chunks.slice(0, 8).map((chunk) => ({
      id: chunk.id,
      chunkIndex: chunk.chunkIndex,
      citationLabel: chunk.citationLabel,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      tokenCount: chunk.tokenCount,
      textPreview: truncate(chunk.contentText, 260),
      metadata: chunk.metadata,
    })),
    courseCode: course.code,
    courseName: course.name,
    courseShortName: course.shortName,
    knowledgeTier,
    contextDomain: source.metadata.context_domain || source.metadata.contextDomain || (knowledgeTier === "supplemental" ? "bitacora" : "rag"),
    metadata: source.metadata,
    isActive: source.isActive,
    createdByUserId: source.createdByUserId,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}
