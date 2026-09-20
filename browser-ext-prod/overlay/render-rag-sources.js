// ADACEEN | Capa 4 - UI: panel de fuentes RAG citadas por el tutor.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

// Las fuentes que llegan aqui ya pasaron por normalizeRagSourcesForUi(), que es
// quien resuelve el rango de paginas; aqui solo se formatea.
function formatRagPageRange(source) {
  const start = firstPositiveNumber(source?.pageStart);
  const end = firstPositiveNumber(source?.pageEnd);
  if (!start) return "";
  if (end && end !== start) return `p. ${start}-${end}`;
  return `p. ${start}`;
}

function formatRagScopeLabel(value) {
  const scope = toText(value).toLowerCase();
  if (scope === "teacher") return "Docente";
  if (scope === "default") return "Base";
  return "";
}

function formatRagKnowledgeLabel(source) {
  const knowledgeTier = toText(source?.knowledgeTier || source?.metadata?.knowledgeTier || source?.metadata?.knowledge_tier).toLowerCase();
  const contextDomain = toText(source?.contextDomain || source?.metadata?.contextDomain || source?.metadata?.context_domain).toLowerCase();
  if (knowledgeTier === "supplemental" || contextDomain === "bitacora") return "Suplementario";
  if (knowledgeTier === "primary") return "RAG principal";
  return "";
}

function buildRagSourceViewerHref(rawUrl, source = {}) {
  const text = toText(rawUrl);

  const baseUrl = normalizeBaseUrl(overlayState.backendUrl) || DEFAULT_BACKEND_URL;
  if (!text) {
    const sourceId = toText(source.sourceId || source.source_id || source.id);
    if (!sourceId || !baseUrl) return "";
    try {
      const parsed = new URL(`/api/rag/sources/${encodeURIComponent(sourceId)}/view`, baseUrl);
      const chunkId = toText(source.chunkId || source.chunk_id);
      const courseCode = toText(source.courseCode || source.course_code || overlayState.activeRagCourseCode);
      if (chunkId) parsed.searchParams.set("chunkId", chunkId);
      if (source.pageStart) parsed.searchParams.set("page", String(source.pageStart));
      if (courseCode) parsed.searchParams.set("courseCode", courseCode);
      if (overlayState.sessionId) parsed.searchParams.set("sessionId", overlayState.sessionId);
      return parsed.toString();
    } catch {
      return "";
    }
  }

  try {
    const parsed = new URL(text, baseUrl);
    const isAdaceenViewer = /\/api\/rag\/sources\/[^/]+\/view$/i.test(parsed.pathname);
    if (isAdaceenViewer && overlayState.sessionId && !parsed.searchParams.get("sessionId")) {
      parsed.searchParams.set("sessionId", overlayState.sessionId);
    }
    return isAdaceenViewer ? parsed.toString() : text;
  } catch {
    return text;
  }
}

function ragSourceDisplayScore(source) {
  const score = Number(source?.score) || 0;
  return score > 0 ? `score ${Math.round(score * 100) / 100}` : "";
}

function renderRagSourcesPanel(showingMainView) {
  if (!overlayEls?.ragSourcesSection || !overlayEls?.ragSourcesList) return;

  const sources = Array.isArray(overlayState.ragSources) ? overlayState.ragSources : [];
  const visible = showingMainView && sources.length > 0;
  overlayEls.ragSourcesSection.hidden = !visible;
  overlayEls.ragSourcesList.textContent = "";
  if (!visible) return;

  if (overlayEls.ragActiveCourseBadge) {
    const selectedCourse = getSelectedStudentCourseCode();
    const sourceCourse = toText(sources.find((source) => source.courseCode)?.courseCode);
    const courseCode = toText(overlayState.activeRagCourseCode) || selectedCourse || sourceCourse || toText(overlayState.ragDefaultCourseCode) || "FPOO";
    overlayEls.ragActiveCourseBadge.textContent = `RAG ${courseCode}`;
  }

  const fragment = document.createDocumentFragment();
  const displaySources = sources
    .slice()
    .sort((left, right) => {
      const leftOpenable = !!buildRagSourceViewerHref(left.url || left.viewerUrl, left);
      const rightOpenable = !!buildRagSourceViewerHref(right.url || right.viewerUrl, right);
      if (leftOpenable !== rightOpenable) return leftOpenable ? -1 : 1;
      const scoreDiff = (Number(right.score) || 0) - (Number(left.score) || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return toText(left.title || left.fileName).localeCompare(toText(right.title || right.fileName));
    })
    .slice(0, 5);

  displaySources.forEach((source) => {
    const li = document.createElement("li");
    li.className = "rag-citation-item";

    const title = document.createElement("strong");
    title.textContent = toText(source.title || source.fileName || "Fuente RAG");

    const metaParts = [
      toText(source.courseCode),
      formatRagKnowledgeLabel(source),
      formatRagScopeLabel(source.scope),
      toText(source.fileName),
      formatRagPageRange(source),
      toText(source.citationLabel),
      ragSourceDisplayScore(source),
    ].filter(Boolean);
    const meta = document.createElement("span");
    meta.textContent = metaParts.join(" | ") || "Fuente sin pagina detectada.";

    li.appendChild(title);
    li.appendChild(meta);

    if (source.usageReason) {
      const reason = document.createElement("p");
      reason.textContent = truncateText(source.usageReason, 220);
      li.appendChild(reason);
    }

    if (source.excerpt) {
      const excerpt = document.createElement("p");
      excerpt.textContent = truncateText(source.excerpt, 180);
      li.appendChild(excerpt);
    }

    if (Array.isArray(source.matchedTerms) && source.matchedTerms.length > 0) {
      const terms = document.createElement("span");
      terms.textContent = `Coincide: ${source.matchedTerms.slice(0, 5).join(", ")}`;
      li.appendChild(terms);
    }

    const sourceHref = buildRagSourceViewerHref(source.url || source.viewerUrl, source);
    if (sourceHref) {
      const link = document.createElement("a");
      link.href = sourceHref;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "Abrir parte usada";
      li.appendChild(link);
    }

    fragment.appendChild(li);
  });

  overlayEls.ragSourcesList.appendChild(fragment);
}

// El modo lo decide una sola funcion (services/backend.service.js) para que la
// etiqueta del boton y la accion enviada a VS Code no puedan divergir.
