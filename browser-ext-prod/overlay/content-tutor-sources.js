// ADACEEN | Capa 4 - UI: pestaña «Tutor», resumen de la respuesta (estado y política) y «Fuentes RAG usadas».
// Movido sin cambios de content-tutor.js.

function formatRagPageRange(source) {
  const citation = source?.citation && typeof source.citation === "object" ? source.citation : {};
  const metadata = source?.metadata && typeof source.metadata === "object" ? source.metadata : {};
  const labelPageRange = parseRagPageRangeFromLabel(source?.citationLabel || citation.label || citation.marker);
  const start = firstPositiveNumber(
    source?.pageStart,
    source?.page_start,
    source?.page,
    source?.pageNumber,
    source?.page_number,
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
  );
  const end = firstPositiveNumber(
    source?.pageEnd,
    source?.page_end,
    citation.pageEnd,
    citation.page_end,
    metadata.pageEnd,
    metadata.page_end,
    labelPageRange.pageEnd,
  );
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
      return toSafeHttpUrl(parsed.toString());
    } catch {
      return "";
    }
  }

  try {
    const parsed = new URL(text, baseUrl);
    // A12.8: los enlaces que vienen del backend o del modelo solo pueden ser http/https.
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    const isAdaceenViewer = /\/api\/rag\/sources\/[^/]+\/view$/i.test(parsed.pathname);
    // A12.8: el visor de fuentes no necesita la sesion; un sessionId en la URL
    // queda en el historial y en capturas. Se quita aunque venga de un backend viejo.
    if (isAdaceenViewer) parsed.searchParams.delete("sessionId");
    return parsed.toString();
  } catch {
    return "";
  }
}

function ragSourceDisplayScore(source) {
  const score = Number(source?.score) || 0;
  return score > 0 ? `score ${Math.round(score * 100) / 100}` : "";
}

// El resumen del tutor llega como un solo parrafo con marcadores ("RAG consultado:",
// "RAG usado:", "Politica:"). Se separa (0.7.14): la linea de estado muestra la deteccion y la
// politica, y las fuentes quedan en «Fuentes RAG usadas», que ya llegan estructuradas.
const TUTOR_INTERVENTION_LABELS = Object.freeze({
  explanation: "explicacion",
  hint: "pista",
  example: "ejemplo parcial",
  mini_quiz: "mini quiz",
  controlled_message: "mensaje controlado",
});

const TUTOR_DETAIL_LABELS = Object.freeze({
  brief: "breve",
  guided: "guiado",
  progressive: "progresivo",
});

function parseTutorSummary(text) {
  const raw = toText(text).replace(/\s+/g, " ").trim();
  const result = { raw, headline: raw, ragConsulted: [], ragUsed: [], policy: "", hasMarkers: false };
  if (!raw) return result;
  const markers = [
    { key: "ragConsulted", regex: /\bRAG consultado:\s*/i },
    { key: "ragUsed", regex: /\bRAG usado:\s*/i },
    { key: "policy", regex: /\bPol[ií]tica:\s*/i },
  ];
  const found = markers
    .map((marker) => {
      const match = marker.regex.exec(raw);
      return match ? { key: marker.key, start: match.index, contentStart: match.index + match[0].length } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.start - right.start);
  if (!found.length) return result;
  result.hasMarkers = true;
  result.headline = raw.slice(0, found[0].start).trim();
  found.forEach((marker, index) => {
    const end = index + 1 < found.length ? found[index + 1].start : raw.length;
    const segment = raw.slice(marker.contentStart, end).trim().replace(/\.\s*$/, "");
    if (marker.key === "policy") {
      result.policy = segment;
      return;
    }
    result[marker.key] = segment
      .split(/\s+\|\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
  });
  return result;
}

function describeTutorPolicy(policyText) {
  const match = /^([a-z_]+)\s+con detalle\s+([a-z_]+)/i.exec(toText(policyText));
  if (!match) return toText(policyText);
  const intervention = TUTOR_INTERVENTION_LABELS[match[1].toLowerCase()] || match[1];
  const detail = TUTOR_DETAIL_LABELS[match[2].toLowerCase()] || match[2];
  return `${intervention}, detalle ${detail}`;
}

// Linea de estado: deteccion + politica + conteo de fuentes; el detalle esta en el panel RAG.
function formatTutorStatusText(text) {
  const parsed = parseTutorSummary(text);
  if (!parsed.hasMarkers) return parsed.raw;
  const parts = [];
  if (parsed.headline) parts.push(parsed.headline);
  if (parsed.policy) parts.push(`Politica: ${describeTutorPolicy(parsed.policy)}.`);
  if (parsed.ragConsulted.length || parsed.ragUsed.length) {
    const consulted = parsed.ragConsulted.length;
    const used = parsed.ragUsed.length;
    parts.push(consulted
      ? `Fuentes: ${used} usada${used === 1 ? "" : "s"} de ${consulted} consultada${consulted === 1 ? "" : "s"} (ver «Fuentes RAG usadas»).`
      : `Fuentes: ${used} usada${used === 1 ? "" : "s"} (ver «Fuentes RAG usadas»).`);
  }
  return parts.join(" ");
}

function renderRagSourcesPanel(showingMainView) {
  if (!overlayEls?.ragSourcesSection || !overlayEls?.ragSourcesList) return;

  const sources = Array.isArray(overlayState.ragSources) ? overlayState.ragSources : [];
  const visible = showingMainView && sources.length > 0;
  overlayEls.ragSourcesSection.hidden = !visible;
  if (!visible) {
    overlayEls.ragSourcesList.textContent = "";
    renderKeyChanged(overlayEls.ragSourcesList, "");
    return;
  }

  const selectedCourse = typeof getSelectedStudentCourseCode === "function"
    ? getSelectedStudentCourseCode()
    : "";
  const sourceCourse = toText(sources.find((source) => source.courseCode)?.courseCode);
  const activeCourseCode = toText(overlayState.activeRagCourseCode) || selectedCourse || sourceCourse || toText(overlayState.ragDefaultCourseCode) || "FPOO";
  if (overlayEls.ragActiveCourseBadge) {
    setTextIfChanged(overlayEls.ragActiveCourseBadge, `RAG ${activeCourseCode}`);
  }
  if (overlayEls.ragSourcesCount) {
    setTextIfChanged(overlayEls.ragSourcesCount, `${sources.length} fuente${sources.length === 1 ? "" : "s"}`);
  }
  if (overlayEls.ragSourcesSection.open !== !!overlayState.ragSourcesOpen) {
    overlayEls.ragSourcesSection.open = !!overlayState.ragSourcesOpen;
  }
  if (overlayEls.ragSourcesNote) {
    const parsed = parseTutorSummary(overlayState.mentorSummary || overlayState.statusMessage);
    const consulted = parsed.ragConsulted.length;
    const used = parsed.ragUsed.length || sources.length;
    setTextIfChanged(overlayEls.ragSourcesNote, consulted
      ? `El tutor consulto ${consulted} fuente${consulted === 1 ? "" : "s"} y uso ${used}. Pulsa + para ver por que se uso cada una.`
      : "Pulsa + para ver por que se uso cada fuente.");
  }

  // Compacta (0.7.14): una linea por fuente (titulo, rol, pagina, score y «Abrir»), agrupadas
  // por curso; el motivo, el fragmento y las coincidencias se despliegan con el boton de la fila.
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
    .slice(0, 6);

  const renderKey = JSON.stringify([
    overlayState.sessionId,
    normalizeBaseUrl(overlayState.backendUrl),
    activeCourseCode,
    displaySources,
  ]);
  if (!renderKeyChanged(overlayEls.ragSourcesList, renderKey)) return;
  overlayEls.ragSourcesList.textContent = "";

  const courseNames = new Map(getRagCourseCatalog().map((course) => [
    normalizeRagCourseCodeUi(course?.code),
    toText(course?.name || course?.shortName || course?.code),
  ]));
  const groups = new Map();
  for (const source of displaySources) {
    const code = normalizeRagCourseCodeUi(source.courseCode) || activeCourseCode;
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(source);
  }

  const fragment = document.createDocumentFragment();
  for (const [code, items] of groups) {
    const header = document.createElement("li");
    header.className = "rag-citation-group";
    header.setAttribute("aria-label", `Curso ${code}`);
    header.textContent = code;
    const headerNote = document.createElement("span");
    headerNote.textContent = `${courseNames.get(code) || "Curso"} | ${items.length} fuente${items.length === 1 ? "" : "s"}`;
    header.appendChild(headerNote);
    fragment.appendChild(header);

    items.forEach((source) => {
      const li = document.createElement("li");
      li.className = "rag-citation-item";
      const titleText = toText(source.title || source.fileName || "Fuente RAG");

      const head = document.createElement("div");
      head.className = "rag-cite-head";

      const detail = document.createElement("div");
      detail.className = "rag-cite-detail";
      detail.hidden = true;
      const detailParts = [];
      if (source.usageReason) detailParts.push(truncateText(toText(source.usageReason).replace(/^Parte usada:\s*/i, ""), 220));
      if (source.excerpt) detailParts.push(truncateText(toText(source.excerpt), 180));
      if (Array.isArray(source.matchedTerms) && source.matchedTerms.length > 0) {
        detailParts.push(`Coincide: ${source.matchedTerms.slice(0, 5).join(", ")}`);
      }
      const fileName = toText(source.fileName);
      if (fileName && fileName !== titleText) detailParts.push(`Archivo: ${fileName}`);
      detailParts.forEach((text) => {
        const line = document.createElement("span");
        line.textContent = text;
        detail.appendChild(line);
      });

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "rag-cite-toggle";
      toggle.textContent = "+";
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-label", `Ver por que se uso ${titleText}`);
      toggle.disabled = detailParts.length === 0;
      toggle.addEventListener("click", () => {
        const open = detail.hidden;
        detail.hidden = !open;
        toggle.textContent = open ? "−" : "+";
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
      });

      const title = document.createElement("span");
      title.className = "rag-cite-title";
      title.textContent = titleText;
      title.title = titleText;

      const meta = document.createElement("span");
      meta.className = "rag-cite-meta";
      meta.textContent = [
        formatRagKnowledgeLabel(source) || formatRagScopeLabel(source.scope),
        formatRagPageRange(source),
        toText(source.citationLabel),
        ragSourceDisplayScore(source).replace(/^score /, "puntaje "),
      ].filter(Boolean).join(" | ");

      head.appendChild(toggle);
      head.appendChild(title);
      head.appendChild(meta);

      const sourceHref = buildRagSourceViewerHref(source.url || source.viewerUrl, source);
      if (sourceHref) {
        const link = document.createElement("a");
        link.className = "rag-cite-link";
        link.href = sourceHref;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "Abrir";
        link.setAttribute(
          "aria-label",
          `Abrir parte usada de ${titleText} (se abre en otra pestaña)`,
        );
        const trackOpen = () => recordRagSourceOpened(source);
        link.addEventListener("click", trackOpen);
        link.addEventListener("auxclick", (event) => {
          if (event.button === 1) trackOpen();
        });
        head.appendChild(link);
      }

      li.appendChild(head);
      li.appendChild(detail);
      fragment.appendChild(li);
    });
  }

  overlayEls.ragSourcesList.appendChild(fragment);
}
