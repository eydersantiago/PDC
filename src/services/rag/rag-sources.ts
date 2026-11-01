// Ranking de fuentes y fragmentos RAG para el tutor y su forma en el API.
import { env } from "../../config/env.js";
import { DEFAULT_RAG_COURSE_CODE, getKnownRagCourseOrDefault, normalizeRagCourseCode } from "./rag-courses.js";
import type {
  RagCitation,
  RagContextItem,
  RagSource,
  RagSourceChunk
} from "../../types/app.js";
import { trimText, uniqueStrings } from "../shared/text-utils.js";
import { metadataToText, truncate, vectorize, getRagKnowledgeTier, vectorizeTokens, cosineSimilarity, normalizeForSearch, sourceUrl, type RagKnowledgeTier, tokenize, expandTokens, isRetrievableRagSource } from "./rag-text.js";
import { formatRagPageRange, sourceChunks } from "./rag-chunks.js";
import { languageFamilyForHint, languageAffinity, sourceLanguageFamilies, languageQueryNames } from "./rag-search-query.js";

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

/** Codigos de curso: todas las fuentes ya vienen filtradas por curso, asi que no informan. */
const COURSE_CODE_TOKENS = new Set(["fpi", "fpoo", "fpoe", "fpfc"]);

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
