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
    // Object.hasOwn: «constructor», «tostring» o «valueof» no son expansiones (antes daban la función del prototipo).
    const additions = Object.hasOwn(SEMANTIC_EXPANSIONS, token) ? SEMANTIC_EXPANSIONS[token] : [];
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
  // El parrafo con mas terminos distintos de la consulta (antes: el primero con alguno, que
  // casi siempre era el comienzo del fragmento aunque hablara de otra cosa).
  let best = "";
  let bestHits = 0;
  for (const paragraph of paragraphs) {
    const normalized = normalizeForSearch(paragraph);
    const hits = tokens.reduce((count, token) => count + (normalized.includes(token) ? 1 : 0), 0);
    if (hits > bestHits) {
      best = paragraph;
      bestHits = hits;
    }
  }
  if (best) return truncate(best, 700);
  return truncate(body, 700);
}

function matchedTermsForChunk(source: RagSource, chunk: RagSourceChunk, queryTokens: string[]) {
  const searchable = normalizeForSearch([
    source.title,
    source.fileName,
    source.sourceType,
    metadataToText(source.metadata),
    metadataToText(chunk.metadata),
    chunk.contentText,
  ].join("\n"));
  return uniqueStrings(queryTokens.filter((token) => searchable.includes(token))).slice(0, 8);
}

/** Terminos distintos de la consulta que aparecen en el fragmento o en los datos de su fuente. */
function countMatchedTerms(source: RagSource, chunk: RagSourceChunk, queryTokens: string[]) {
  const searchable = normalizeForSearch([
    source.title,
    source.fileName,
    metadataToText(source.metadata),
    metadataToText(chunk.metadata),
    chunk.contentText,
  ].join("\n"));
  return uniqueStrings(queryTokens.filter((token) => searchable.includes(token))).length;
}

function formatRagPageRange(pageStart: number | null, pageEnd: number | null) {
  if (!pageStart) return "";
  if (pageEnd && pageEnd !== pageStart) return `p. ${pageStart}-${pageEnd}`;
  return `p. ${pageStart}`;
}

function isOpenableRagHit(source: RagSource, chunk: RagSourceChunk) {
  const mergedMetadata = { ...source.metadata, ...chunk.metadata };
  return !!source.id || !!sourceUrl(mergedMetadata);
}

function buildUsageReason(params: {
  source: RagSource;
  chunk: RagSourceChunk;
  matchedTerms: string[];
  score: number;
  ftsScore: number;
  semanticScore: number;
  knowledgeTier: RagKnowledgeTier;
}) {
  const pageRange = formatRagPageRange(params.chunk.pageStart, params.chunk.pageEnd);
  const role = params.knowledgeTier === "supplemental"
    ? "contexto suplementario de actividad/bitacora"
    : "RAG principal del curso";
  const terms = params.matchedTerms.length
    ? `coincide con ${params.matchedTerms.slice(0, 5).join(", ")}`
    : "fue el fragmento con mejor compatibilidad para el archivo, la pregunta o la seleccion";
  const location = [
    params.chunk.citationLabel,
    pageRange,
  ].filter(Boolean).join(" ");
  return [
    `Parte usada: ${location || params.chunk.citationLabel}.`,
    `Fuente: ${params.source.title || params.source.fileName || "RAG"}.`,
    `Tipo: ${params.source.sourceType || params.source.mimeType || "documento"}.`,
    `Motivo: ${terms}.`,
    `Rol: ${role}.`,
    `Ranking: FTS ${Math.round(params.ftsScore * 100) / 100}, semantico ${Math.round(params.semanticScore * 100) / 100}, total ${Math.round(params.score * 100) / 100}.`,
  ].join(" ");
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
  // Sin el codigo del curso ni la rama: las fuentes ya vienen filtradas por curso y esos
  // terminos solo inflaban las fuentes con "FPOO" en el titulo (revision del 21/10/2026).
  return [
    question,
    context.activityTitle,
    context.learningGoal,
    context.repoFullName,
    context.filePath,
    context.languageHint,
    ...languageQueryNames(context.languageHint),
    context.visibleError,
    context.selection,
    context.codeSnippet?.slice(0, 1200),
    codeConceptTerms(`${context.selection || ""}\n${context.codeSnippet?.slice(0, 4000) || ""}`, context.languageHint).join(" "),
  ].map((item) => trimText(item)).filter(Boolean).join("\n");
}

/**
 * Conceptos del curso que se ven en el codigo (revision de precision, 21/10/2026). El material
 * del curso habla de "herencia" o "polimorfismo", no de "class B : public A" ni de "virtual":
 * estos terminos llevan la consulta del RAG al tema que el estudiante esta trabajando.
 */
const CODE_CONCEPTS: Array<{ pattern: RegExp; terms: string[]; families?: string[] }> = [
  { pattern: /\bclass[ \t]+\w+[ \t]*(?:final[ \t]*)?:[ \t]*(?:public|protected|private)?[ \t]*[A-Za-z_]\w*/, terms: ["herencia", "clase base", "subclase"], families: ["cpp"] },
  { pattern: /\bclass[ \t]+\w+(?:<[^>\n]*>)?[ \t]+extends[ \t]+\w+/, terms: ["herencia", "subclase"] },
  { pattern: /^[ \t]*class[ \t]+\w+[ \t]*\([ \t]*[A-Za-z_]\w*/m, terms: ["herencia", "subclase"], families: ["python"] },
  { pattern: /^[ \t]*class[ \t]+\w+[ \t]*<[ \t]*[A-Z]\w*/m, terms: ["herencia", "subclase"], families: ["ruby"] },
  { pattern: /\b(?:virtual|override|abstract|implements)\b|\)[ \t]*(?:const[ \t]*)?=[ \t]*0[ \t]*;|@(?:Override|abstractmethod)\b/, terms: ["polimorfismo", "metodo virtual", "sobrescritura"] },
  { pattern: /\binterface[ \t]+\w+/, terms: ["interfaz", "polimorfismo"], families: ["java", "csharp", "javascript"] },
  { pattern: /^[ \t]*(?:private|protected)[ \t]*:|\bprivate[ \t]+\w+|\bself\.__\w+|\battr_(?:reader|accessor|writer)\b/m, terms: ["encapsulamiento", "atributo privado"] },
  { pattern: /\b(?:get|set)[A-Z]\w*[ \t]*\(|\bdef[ \t]+(?:get|set)_\w+|@property\b/, terms: ["encapsulamiento", "getter", "setter"] },
  { pattern: /\b([A-Z]\w*)[ \t]*::[ \t]*\1[ \t]*\(|^[ \t]*(?:(?:public|private|protected)[ \t]+)?(?:explicit[ \t]+)?([A-Z]\w*)[ \t]*\([^;{\n]*\)[ \t]*(?::[^{\n]*)?\{|\bdef[ \t]+__init__\b|\bdef[ \t]+initialize\b|\bconstructor[ \t]*\(/m, terms: ["constructor", "inicializacion"] },
  { pattern: /~[ \t]*[A-Z]\w*[ \t]*\(/, terms: ["destructor", "memoria"], families: ["cpp"] },
  { pattern: /\bnew[ \t]+[A-Z]\w*|\bdelete[ \t]*(?:\[[ \t]*\])?[ \t]*\w+|\bmalloc[ \t]*\(|\w+[ \t]*->[ \t]*\w+|\bnullptr\b/, terms: ["puntero", "memoria dinamica"], families: ["cpp"] },
  { pattern: /\b(?:const[ \t]+)?[A-Za-z_][\w:<>]*[ \t]*&[ \t]*[A-Za-z_]\w*[ \t]*[,)=;]/, terms: ["referencia", "paso por referencia"], families: ["cpp"] },
  { pattern: /\b(?:std::)?vector[ \t]*<|\bArrayList[ \t]*<|\bpush_back[ \t]*\(|\.append[ \t]*\(/, terms: ["vector", "coleccion", "arreglo"] },
  { pattern: /\b(?:std::)?(?:map|unordered_map|set)[ \t]*<|\bHashMap[ \t]*<|\bdict[ \t]*\(/, terms: ["coleccion", "diccionario"] },
  { pattern: /\btry[ \t]*[{:]|\bcatch[ \t]*\(|\bthrow\b|\bexcept\b|\braise\b|\brescue\b/, terms: ["excepcion", "manejo de errores"] },
  { pattern: /^[ \t]*#include[ \t]*"|^[ \t]*from[ \t]+\.\S*[ \t]+import\b|^[ \t]*require_relative[ \t]/m, terms: ["modulo", "separacion en archivos"] },
  { pattern: /\btemplate[ \t]*<|\b[A-Z]\w*<[ \t]*T[ \t]*>/, terms: ["plantilla", "programacion generica"] },
  { pattern: /\boperator[ \t]*(?:<<|>>|[-+*\/=<>!\[\]()]+)/, terms: ["sobrecarga de operadores"], families: ["cpp"] },
  { pattern: /\bstatic[ \t]+\w+/, terms: ["miembro estatico"] },
  { pattern: /\b(?:assert|EXPECT_\w+|ASSERT_\w+|unittest|pytest)\b/, terms: ["prueba", "validacion"] },
];

export function codeConceptTerms(code: string, languageHint?: string) {
  const text = String(code || "").slice(0, 12000);
  if (!text.trim()) return [];
  const family = languageFamilyForHint(languageHint);
  const terms: string[] = [];
  for (const concept of CODE_CONCEPTS) {
    if (concept.families && family && !concept.families.includes(family)) continue;
    if (concept.pattern.test(text)) terms.push(...concept.terms);
  }
  return uniqueStrings(terms);
}

/** Palabras reservadas y nombres de biblioteca que no dicen de que tema es el codigo. */
const CODE_NOISE_WORDS = new Set([
  "auto", "bool", "boolean", "break", "case", "catch", "char", "class", "const", "continue", "cout", "cin", "def",
  "default", "delete", "do", "double", "elif", "else", "end", "endl", "enum", "false", "final", "float", "for",
  "from", "function", "if", "import", "in", "include", "int", "is", "let", "long", "main", "namespace", "new",
  "nil", "none", "not", "null", "nullptr", "or", "and", "print", "printf", "println", "private", "protected",
  "public", "puts", "return", "self", "short", "signed", "size", "static", "std", "string", "struct", "switch",
  "system", "this", "throw", "true", "try", "unsigned", "using", "var", "virtual", "void", "while", "iostream",
  "vector", "override", "out", "args", "string", "len", "range", "str", "list", "dict", "max", "min",
]);

/** Identificadores del codigo partidos en palabras (calcularIMC -> calcular imc), sin ruido. */
export function codeIdentifierTerms(code: string, limit = 24) {
  const words: string[] = [];
  for (const match of String(code || "").slice(0, 8000).matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) {
    const parts = match[0]
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/_/g, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter((part) => part.length >= 3 && !CODE_NOISE_WORDS.has(part));
    words.push(...parts);
  }
  return uniqueStrings(words).slice(0, limit);
}

/**
 * Consulta del RAG para una sugerencia del editor: el error visible, el lenguaje, los conceptos
 * que se ven en el codigo y los nombres del codigo enfocado. Sin la pregunta que arma VS Code
 * (es una instruccion de formato: "analiza la seleccion completa...") ni los rotulos del
 * contexto ("Repositorio", "Workspace", "Cursor"), que antes llenaban la consulta de palabras
 * que coinciden con cualquier fuente.
 */
/** Palabras de relleno de los mensajes del compilador (en ingles casi siempre). */
const ERROR_NOISE_WORDS = new Set([
  "error", "errors", "warning", "note", "expected", "before", "after", "was", "were", "not", "in", "of",
  "to", "is", "are", "an", "at", "on", "with", "line", "file", "token", "unexpected", "no", "did", "you",
  "mean", "here", "there", "has", "have", "be", "been", "it", "its", "or", "as", "by", "into", "cannot",
  "can", "could", "would", "will",
]);

/** El error visible sin la ruta, la linea y las palabras de relleno ("archivo.cpp:6:48: error: expected"). */
export function errorQueryTerms(visibleError: string) {
  return trimText(visibleError)
    .slice(0, 500)
    .replace(/(?:[A-Za-z]:)?[\w./\\-]+\.\w+:\d+(?::\d+)?:?/g, " ")
    .split(/[^A-Za-z0-9_+#\u00C0-\u017F]+/)
    .filter((word) => word.length >= 2 && !ERROR_NOISE_WORDS.has(word.toLowerCase()))
    .join(" ");
}

export function buildEditorRagSearchQuery(input: {
  focusCode: string;
  fileCode?: string;
  visibleError?: string;
  languageHint?: string;
  filePath?: string;
}) {
  const focus = trimText(input.focusCode).slice(0, 4000);
  const file = trimText(input.fileCode).slice(0, 12000);
  const fileName = trimText(input.filePath).split("/").pop()?.replace(/\.[A-Za-z0-9]+$/, "") || "";
  return [
    errorQueryTerms(input.visibleError || ""),
    ...languageQueryNames(input.languageHint),
    codeConceptTerms(focus || file, input.languageHint).join(" "),
    focus ? codeConceptTerms(file, input.languageHint).slice(0, 8).join(" ") : "",
    codeIdentifierTerms(focus || file, 16).join(" "),
    fileName.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " "),
  ].map((item) => trimText(item)).filter(Boolean).join("\n");
}

/**
 * Bloque corto del material para los prompts del editor y de la pestaña: etiqueta de cita,
 * titulo y el parrafo que coincide. Sin URL, puntajes ni alcance (antes el bloque llegaba a
 * 6000 caracteres en una sola linea y casi todo era metadato). Se le dice al modelo que lo
 * ignore si no aplica: el material que no tiene que ver distrae a un modelo pequeno.
 */
export function buildCompactRagPromptBlock(
  items: RagContextItem[],
  options: { maxItems?: number; excerptChars?: number } = {},
) {
  const maxItems = Math.max(1, Math.floor(Number(options.maxItems) || 3));
  const excerptChars = Math.max(120, Math.floor(Number(options.excerptChars) || 380));
  const picked = items.slice(0, maxItems);
  if (!picked.length) return "";
  const lines = picked.map((item) => {
    const supplemental = item.metadata.knowledgeTier === "supplemental";
    const page = item.pageStart
      ? ` (p. ${item.pageEnd && item.pageEnd !== item.pageStart ? `${item.pageStart}-${item.pageEnd}` : item.pageStart})`
      : "";
    const excerpt = truncate(item.excerpt || "", excerptChars);
    return [
      `- ${item.citationLabel} ${item.title}${page}${supplemental ? " [actividad o semana del curso]" : ""}`,
      excerpt ? `  ${excerpt}` : "",
    ].filter(Boolean).join("\n");
  });
  return [
    "Material del curso recuperado para este codigo. Usalo solo si aplica; si lo usas, escribe su etiqueta exacta (por ejemplo " + picked[0].citationLabel + "). Si no aplica, no lo menciones.",
    ...lines,
  ].join("\n");
}

/** Opciones de rankRagSources (revision de precision, 21/10/2026). */
export type RagRankOptions = {
  /**
   * Lenguaje del archivo del estudiante (cpp, python, ruby...). Una fuente que trata solo de
   * otro lenguaje (la documentacion de Ruby para un archivo C++) baja su puntaje; una del mismo
   * lenguaje sube un poco. Las fuentes sin lenguaje (programa, semanas, POO general) no cambian.
   */
  languageHint?: string;
  /** Descarta los fragmentos con menos de esta fraccion del puntaje del mejor (0..1). */
  minRelativeScore?: number;
  /** Maximo de fragmentos de una misma fuente (variedad en vez de tres trozos del mismo libro). */
  maxPerSource?: number;
  /**
   * Minimo de terminos distintos de la consulta (sin contar el nombre del lenguaje) que tiene
   * que traer el fragmento. Si ninguno llega, no se cita nada.
   */
  minMatchedTerms?: number;
};

/**
 * Familias de lenguaje que se reconocen en languageHint y en el titulo, la categoria, las
 * etiquetas o la descripcion de una fuente (texto ya normalizado con normalizeForSearch).
 */
const LANGUAGE_FAMILIES: Array<{ family: string; hints: string[]; marker: RegExp }> = [
  { family: "cpp", hints: ["cpp", "c++", "cc", "cxx", "hpp", "hh", "h", "c"], marker: /(?:^|[ +])(?:c\+\+|cpp|stl)(?= |$)/ },
  { family: "python", hints: ["python", "py"], marker: /(?:^|[ +])python(?= |$)/ },
  { family: "java", hints: ["java"], marker: /(?:^|[ +])java(?= |$)/ },
  { family: "javascript", hints: ["javascript", "js", "jsx", "typescript", "ts", "tsx", "javascriptreact", "typescriptreact"], marker: /(?:^|[ +])(?:javascript|typescript|node js|nodejs)(?= |$)/ },
  { family: "ruby", hints: ["ruby", "rb"], marker: /(?:^|[ +])ruby(?= |$)/ },
  { family: "csharp", hints: ["csharp", "cs", "c#"], marker: /(?:^|[ +])(?:c#|csharp)(?= |$)/ },
  { family: "processing", hints: ["processing", "pde"], marker: /(?:^|[ +])processing(?= |$)/ },
];

/** Codigos de curso: todas las fuentes ya vienen filtradas por curso, asi que no informan. */
const COURSE_CODE_TOKENS = new Set(["fpi", "fpoo", "fpoe", "fpfc"]);

export function languageFamilyForHint(languageHint: string | undefined) {
  const clean = trimText(languageHint || "").toLowerCase().replace(/^\./, "");
  if (!clean) return "";
  return LANGUAGE_FAMILIES.find((item) => item.hints.includes(clean))?.family || "";
}

/** Nombres con los que el material del curso se refiere al lenguaje (para la consulta del RAG). */
export function languageQueryNames(languageHint: string | undefined) {
  const family = languageFamilyForHint(languageHint);
  if (family === "cpp") return ["c++", "cpp"];
  if (family === "csharp") return ["c#"];
  return family ? [family] : [];
}

function sourceLanguageFamilies(source: RagSource) {
  const probe = normalizeForSearch([
    source.title,
    metadataString(source.metadata, "category"),
    metadataString(source.metadata, "tags"),
    metadataString(source.metadata, "description"),
    metadataString(source.metadata, "language"),
  ].join(" "));
  return LANGUAGE_FAMILIES.filter((item) => item.marker.test(probe)).map((item) => item.family);
}

function languageAffinity(sourceFamilies: string[], fileFamily: string) {
  if (!fileFamily || !sourceFamilies.length) return 1;
  return sourceFamilies.includes(fileFamily) ? 1.15 : 0.3;
}

export function rankRagSources(
  sources: RagSource[],
  query: string,
  limit = env.ragMaxSources,
  options: RagRankOptions = {},
): RagContextItem[] {
  const queryTokens = tokenize(query).filter((token) => !COURSE_CODE_TOKENS.has(token));
  const expandedTokens = expandTokens(queryTokens);
  const fileFamily = languageFamilyForHint(options.languageHint);
  const affinityBySource = new Map<string, number>();
  const affinityFor = (source: RagSource) => {
    const key = source.id || source.sourceKey || source.title;
    let value = affinityBySource.get(key);
    if (value === undefined) {
      value = languageAffinity(sourceLanguageFamilies(source), fileFamily);
      affinityBySource.set(key, value);
    }
    return value;
  };
  const scored = sources
    .filter((source) => source.isActive)
    .filter((source) => isRetrievableRagSource(source, true))
    .flatMap((source) => sourceChunks(source).map((chunk) => {
      const scores = scoreChunk(source, chunk, queryTokens, expandedTokens);
      return { source, chunk, ...scores, score: scores.score * affinityFor(source) };
    }))
    .filter((item) => queryTokens.length === 0 || item.score > 0.35);
  const topScore = scored.reduce((max, item) => Math.max(max, item.score), 0);
  const minRelative = Math.min(1, Math.max(0, Number(options.minRelativeScore) || 0));
  const perSourceLimit = Math.max(0, Math.floor(Number(options.maxPerSource) || 0));
  const minTerms = Math.max(0, Math.floor(Number(options.minMatchedTerms) || 0));
  const languageTokens = new Set(tokenize(languageQueryNames(options.languageHint).join(" ")));
  const perSource = new Map<string, number>();
  const ranked = scored
    .filter((item) => !minRelative || queryTokens.length === 0 || item.score >= topScore * minRelative)
    .filter((item) => !minTerms || queryTokens.length === 0
      || countMatchedTerms(item.source, item.chunk, queryTokens.filter((token) => !languageTokens.has(token))) >= minTerms)
    .sort((left, right) => {
      const leftOpenable = isOpenableRagHit(left.source, left.chunk);
      const rightOpenable = isOpenableRagHit(right.source, right.chunk);
      if (leftOpenable !== rightOpenable) return leftOpenable ? -1 : 1;
      if (right.score !== left.score) return right.score - left.score;
      if (left.source.scope !== right.source.scope) return left.source.scope === "teacher" ? -1 : 1;
      if (left.chunk.chunkIndex !== right.chunk.chunkIndex) return left.chunk.chunkIndex - right.chunk.chunkIndex;
      return right.source.createdAt.localeCompare(left.source.createdAt);
    })
    .filter((item) => {
      if (!perSourceLimit) return true;
      const key = item.source.id || item.source.sourceKey;
      const used = perSource.get(key) || 0;
      if (used >= perSourceLimit) return false;
      perSource.set(key, used + 1);
      return true;
    })
    .slice(0, Math.max(1, limit));

  return ranked.map(({ source, chunk, score, ftsScore, semanticScore }) => {
    const citation = buildCitation(source, chunk);
    const knowledgeTier = getRagKnowledgeTier(source.metadata, source.sourceType);
    const matchedTerms = matchedTermsForChunk(source, chunk, queryTokens);
    const usageReason = buildUsageReason({
      source,
      chunk,
      matchedTerms,
      score,
      ftsScore,
      semanticScore,
      knowledgeTier,
    });
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
      usageReason,
      matchedTerms,
      isOpenable: isOpenableRagHit(source, chunk),
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
  options: RagRankOptions = {},
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

  return rankRagSources([...sourcesById.values()], query, limit, options);
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
      item.usageReason ? `Parte usada para la sugerencia: ${item.usageReason}` : "",
      `Ranking: FTS ${item.ftsScore}; semantico ${item.semanticScore}; total ${item.score}`,
      `Extracto: ${item.excerpt || "(sin extracto)"}`,
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  return truncate([
    "Fuentes recuperadas y ordenadas por compatibilidad con el archivo, la linea o la pregunta. Prioriza siempre el RAG principal del curso para conceptos, diseno y codigo; usa bitacora/actividades solo como contexto suplementario de semana, ejercicio o entrega. Toda recomendacion basada en estas fuentes debe incluir la cita obligatoria exacta y la parte usada. El modelo puede complementar la explicacion, pero debe separar la evidencia RAG del razonamiento propio.",
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
  // Si el item termina en un bloque de codigo, la cita va en otra linea para
  // no romper el cierre del bloque (```) al mostrarlo como Markdown.
  return /```\s*$/.test(text) ? `${text}\n${label}` : `${text} ${label}`;
}

function buildRagEvidenceSummary(items: RagContextItem[]) {
  return items.slice(0, 2)
    .map((item) => {
      const pageRange = formatRagPageRange(item.pageStart, item.pageEnd);
      const location = [item.citationLabel, pageRange].filter(Boolean).join(" ");
      const reason = trimText(item.usageReason)
        .replace(/^Parte usada:\s*/i, "")
        .replace(/\s+/g, " ");
      return `${item.title}: ${location}${reason ? ` (${truncate(reason, 180)})` : ""}`;
    })
    .filter(Boolean)
    .join(" | ");
}

export function ensureMentorResultRagCitations(
  result: GithubMentorResult,
  items: RagContextItem[],
): GithubMentorResult {
  if (!items.length) return result;

  const labels = uniqueStrings(items.map((item) => item.citationLabel).filter(Boolean));
  if (!labels.length) return result;
  const pickLabel = (index: number) => labels[index % Math.min(labels.length, 3)] || labels[0];
  const evidenceSummary = buildRagEvidenceSummary(items);
  const analysisSummary = evidenceSummary && !/RAG usado|parte usada|fragmento usado/i.test(result.analysis_summary)
    ? `${trimText(result.analysis_summary)} RAG usado: ${evidenceSummary}.`
    : result.analysis_summary;

  return {
    ...result,
    ideas: result.ideas.map((item, index) => appendCitation(item, pickLabel(index), labels)),
    searches: result.searches.map((item, index) => (
      /revisar|fuente|material|lectura/i.test(item)
        ? appendCitation(item, pickLabel(index), labels)
        : item
    )),
    guide: result.guide.map((item, index) => appendCitation(item, pickLabel(index), labels)),
    analysis_summary: appendCitation(analysisSummary, labels[0], labels),
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
    url: sourceUrl(source.metadata),
    isOpenable: !!source.id || !!sourceUrl(source.metadata),
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
    lotId: trimText(String(source.metadata.lotId ?? source.metadata.lot_id ?? "")),
    knowledgeTier,
    contextDomain: source.metadata.context_domain || source.metadata.contextDomain || (knowledgeTier === "supplemental" ? "bitacora" : "rag"),
    metadata: source.metadata,
    isActive: source.isActive,
    createdByUserId: source.createdByUserId,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}
