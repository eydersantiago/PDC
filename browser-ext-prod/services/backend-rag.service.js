// ADACEEN | Capa 3 - Servicios: lotes de RAG por curso y normalizacion de las fuentes RAG para la UI.
// Movido sin cambios desde services/backend.service.js.
// Sin "use strict": el codigo viene de backend.service.js (modo no estricto) y se conserva igual.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

// Lotes de RAG (0.7.15): catalogo por curso (base, lotes, activo y fuentes apagadas).
async function fetchRagLotCatalog() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !isTeacherSession()) {
    throw new Error("Sesion no valida para administrar lotes de RAG.");
  }
  const response = await fetchJsonWithTimeout(`${baseUrl}/api/rag/lots`, {
    method: "GET",
    headers: buildApiHeaders(),
  }, 20000);
  if (!response?.ok) {
    throw new Error(toText(response?.error) || "No se pudieron cargar los lotes de RAG.");
  }
  return normalizeRagLotCatalog(response);
}

function normalizeRagLotCatalog(response) {
  return {
    courses: Array.isArray(response?.courses) ? response.courses : [],
    disabledSourceIds: Array.isArray(response?.disabledSourceIds) ? response.disabledSourceIds.map(toText) : [],
    baseLotName: toText(response?.baseLotName) || "Base del curso",
  };
}

// Cada cambio devuelve el catalogo actualizado (catalog) o se vuelve a pedir.
async function requestRagLotChange(path, method, body) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !isTeacherSession()) {
    throw new Error("Sesion no valida para administrar lotes de RAG.");
  }
  const response = await fetchJsonWithTimeout(`${baseUrl}${path}`, {
    method,
    headers: buildApiHeaders(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, 20000);
  if (!response?.ok) {
    throw new Error(toText(response?.error) || "No se pudo guardar el cambio del lote.");
  }
  return response;
}

function firstPositiveNumberUi(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function parseRagPageRangeFromLabel(label) {
  const match = toText(label).match(/\bp\.\s*(\d+)(?:\s*-\s*(\d+))?/i);
  if (!match) return { pageStart: null, pageEnd: null };
  const pageStart = firstPositiveNumberUi(match[1]);
  const pageEnd = firstPositiveNumberUi(match[2]) || pageStart;
  return { pageStart, pageEnd };
}

function normalizeRagSourcesForUi(value) {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item) => {
      const source = item && typeof item === "object" ? item : {};
      const citation = source.citation && typeof source.citation === "object" ? source.citation : {};
      const metadata = source.metadata && typeof source.metadata === "object" ? source.metadata : {};
      const citationLabel = toText(source.citationLabel || citation.label || citation.marker);
      const labelPageRange = parseRagPageRangeFromLabel(citationLabel);
      const url = toText(source.url || source.viewerUrl || metadata.viewerUrl || citation.url);
      const externalUrl = toText(source.externalUrl || metadata.externalUrl || citation.externalUrl);
      const sourceId = toText(source.sourceId || source.source_id || source.id || citation.sourceId || citation.source_id);
      const chunkId = toText(source.chunkId || source.chunk_id || citation.chunkId || citation.chunk_id);
      return {
        id: toText(source.id),
        sourceId,
        chunkId,
        scope: toText(source.scope),
        courseCode: normalizeRagCourseCodeUi(source.courseCode || source.course_code || metadata.courseCode || metadata.course_code),
        title: toText(source.title || citation.title),
        fileName: toText(source.fileName || citation.fileName),
        sourceType: toText(source.sourceType),
        knowledgeTier: toText(source.knowledgeTier || metadata.knowledgeTier || metadata.knowledge_tier),
        contextDomain: toText(source.contextDomain || metadata.contextDomain || metadata.context_domain),
        citationLabel,
        pageStart: firstPositiveNumberUi(
          source.pageStart,
          source.page_start,
          source.page,
          source.pageNumber,
          source.page_number,
          citation.pageStart,
          citation.page_start,
          citation.page,
          citation.pageNumber,
          citation.page_number,
          metadata.pageStart,
          metadata.page_start,
          metadata.page,
          metadata.pageNumber,
          metadata.page_number,
          labelPageRange.pageStart,
        ),
        pageEnd: firstPositiveNumberUi(
          source.pageEnd,
          source.page_end,
          citation.pageEnd,
          citation.page_end,
          metadata.pageEnd,
          metadata.page_end,
          labelPageRange.pageEnd,
        ),
        excerpt: toText(source.excerpt),
        usageReason: toText(source.usageReason || source.usage_reason || metadata.usageReason || metadata.usage_reason),
        matchedTerms: Array.isArray(source.matchedTerms || source.matched_terms)
          ? (source.matchedTerms || source.matched_terms).map(toText).filter(Boolean).slice(0, 8)
          : [],
        url,
        viewerUrl: url,
        externalUrl,
        isOpenable: Boolean(source.isOpenable || source.is_openable || url || sourceId),
        score: Number(source.score) || 0,
        ftsScore: Number(source.ftsScore || source.fts_score) || 0,
        semanticScore: Number(source.semanticScore || source.semantic_score) || 0,
      };
    })
    .filter((item) => item.title || item.fileName || item.citationLabel)
    .sort((left, right) => {
      if (left.isOpenable !== right.isOpenable) return left.isOpenable ? -1 : 1;
      if (right.score !== left.score) return right.score - left.score;
      return toText(left.title || left.fileName).localeCompare(toText(right.title || right.fileName));
    })
    .slice(0, 5);
}
