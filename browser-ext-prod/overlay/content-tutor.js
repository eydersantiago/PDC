// ADACEEN | Capa 4 - UI: pestana «Tutor»: sesion con el tutor, resumen de su respuesta, «Fuentes RAG usadas»
// y la opinion del estudiante sobre la respuesta (A11.2).
// Movido sin cambios desde content-render.js (formato y render del resumen y de las fuentes) y desde
// content-lifecycle.js (refreshMentorSession, aviso de respaldo y listeners, ahora en bindTutorPanel).
// Sin "use strict": el codigo viene de archivos en modo no estricto y se conserva igual.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

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

// ---- Opinion del estudiante sobre la respuesta del tutor (A11.2) ----

function isTutorFeedbackOnScreen() {
  return !!overlayEls?.tutorFeedbackSection
    && !overlayEls.tutorFeedbackSection.hidden
    && !overlayEls.window?.hidden
    && !overlayEls.mainView?.hidden
    && document.visibilityState === "visible";
}

function renderTutorFeedback(visible) {
  const section = overlayEls?.tutorFeedbackSection;
  if (!section) return;
  const state = getTutorResponseFeedbackState();
  const show = !!visible && state.active;
  section.hidden = !show;
  if (!show) return;

  const chosen = state.feedback === "accepted" || state.feedback === "rejected";
  overlayEls.tutorFeedbackAcceptBtn.disabled = state.resolved;
  overlayEls.tutorFeedbackRejectBtn.disabled = state.resolved;
  overlayEls.tutorFeedbackAcceptBtn.classList.toggle("is-chosen", state.feedback === "accepted");
  overlayEls.tutorFeedbackRejectBtn.classList.toggle("is-chosen", state.feedback === "rejected");
  setTextIfChanged(
    overlayEls.tutorFeedbackStatus,
    chosen
      ? (state.feedback === "accepted"
        ? "Gracias. Registramos que esta ayuda te sirvió."
        : "Gracias. Registramos que esta ayuda no te sirvió.")
      : "",
  );

  if (!state.shown && isTutorFeedbackOnScreen()) {
    markTutorResponseShown();
  }
}

// La pestana pudo estar oculta cuando llego la respuesta: se marca como vista al volver.
function refreshTutorFeedbackVisibility() {
  if (!getTutorResponseFeedbackState().shown && isTutorFeedbackOnScreen()) {
    markTutorResponseShown();
  }
}

function handleTutorFeedbackChoice(kind) {
  if (!recordTutorResponseFeedback(kind)) return;
  renderOverlay();
  // Los botones quedan deshabilitados: el foco pasa al mensaje "Gracias" y no se pierde.
  focusOverlayElement(overlayEls?.tutorFeedbackStatus);
}

const MENTOR_FALLBACK_DELAY_MS = 120000;

let mentorFallbackTimer = 0;

function buildMentorFallbackKey(context) {
  return [
    toText(overlayState.sessionId),
    toText(context?.url || location.href),
    toText(context?.filePath),
    toText(context?.selection).slice(0, 80),
  ].join("|");
}

function clearMentorFallbackTimer() {
  if (!mentorFallbackTimer) return;
  window.clearTimeout(mentorFallbackTimer);
  mentorFallbackTimer = 0;
}

function scheduleMentorFallbackStatus(context, startedAt) {
  const fallbackKey = buildMentorFallbackKey(context);
  const elapsedMs = Date.now() - Number(startedAt || Date.now());
  const remainingMs = MENTOR_FALLBACK_DELAY_MS - elapsedMs;

  overlayState.statusMessage = `${buildMainStatus(context)} Cargando apoyo del tutor...`;
  clearMentorFallbackTimer();

  mentorFallbackTimer = window.setTimeout(() => {
    mentorFallbackTimer = 0;
    const currentContext = overlayState.context || buildPayload();
    if (buildMentorFallbackKey(currentContext) !== fallbackKey) return;
    if (overlayState.loading || toText(overlayState.mentorSummary)) return;

    overlayState.statusMessage = `${buildMainStatus(currentContext)} Se usa apoyo local por ahora.`;
    renderOverlay();
  }, Math.max(250, remainingMs));
}

// options.trigger: "manual" (boton o meta elegida), "shortcut" (Ctrl+Enter) o "auto".
// options.requestedAt: instante del clic, para medir latencyMs desde la accion del usuario.
// options.skipModelRequests: entrada automatica al volver otro dia; no pide ayuda al tutor ni
// el consejo del modelo (el estudiante no los pidio y no deben contar en la telemetria del piloto).
// Privacidad pendiente («Aceptar y continuar» abierto): el contexto de la pagina no va al tutor
// (ni al modelo del proyecto) hasta que el estudiante acepta. La primera respuesta que se pidio
// mientras tanto se pide al aceptar.
let mentorDeferredUntilPrivacyAccepted = false;

function takeMentorDeferredUntilPrivacyAccepted() {
  const deferred = mentorDeferredUntilPrivacyAccepted;
  mentorDeferredUntilPrivacyAccepted = false;
  return deferred;
}

async function refreshMentorSession(options = {}) {
  if (!hasActiveSession()) {
    renderOverlay();
    return;
  }

  const tutorTrigger = toText(options?.trigger) || "auto";
  const tutorRequestedAt = Number(options?.requestedAt) || Date.now();
  // La respuesta anterior deja de verse en cuanto se recalcula el contenido.
  clearTutorResponseTracking("replaced");
  clearMentorFallbackTimer();
  overlayState.loading = true;
  overlayState.context = buildPayload();
  overlayState.statusMessage = "Leyendo contexto actual...";
  renderOverlay();

  if (overlayState.session?.user?.role === "student" && typeof ensureStudentCourseSelection === "function") {
    await ensureStudentCourseSelection({ forceOpen: false });
  }

  const context = overlayState.context;
  // Campus: el acceso al curso y la bitacora se verifican solos al entrar (sin await: no
  // retrasa la peticion al tutor); la accion recomendada pasa directo a "Analizar Campus".
  // La bitacora del curso (la verificacion de Campus la trae, o se consulta aparte): el tutor
  // espera hasta 1,5 s para mandar la semana del curso con la primera pregunta (0.7.17).
  let courseBitacoraRequest = null;
  if (isCampusCoursePageContext(context) && typeof verifyCampusCourseAccessOnEntry === "function") {
    courseBitacoraRequest = verifyCampusCourseAccessOnEntry(context).catch(() => {});
  }
  // Docente (0.7.16) y estudiante (0.7.17): el estado de la bitacora se consulta una vez al entrar
  // (sin await) para la linea de Inicio, la accion recomendada y la agenda. En Campus lo trae la
  // verificacion del curso.
  const campusVerifying = typeof isCampusAccessVerificationInFlight === "function" && isCampusAccessVerificationInFlight();
  if (!campusVerifying && typeof ensureTeacherBitacoraLoaded === "function") {
    courseBitacoraRequest = ensureTeacherBitacoraLoaded({ onlyIfUnchecked: true }) || courseBitacoraRequest;
  }
  const language = inferLanguage(context.filePath, context.languageHint);
  const goal = getLearningGoal(overlayState.selectedLearningGoal);
  const detectedRepo = inferRepoFromContext(context);
  const githubContext = isGithubOrCodespaceContext(context);
  if (githubContext && !overlayState.setupRepoFullName && detectedRepo) {
    setSetupRepoFullName(detectedRepo);
  }

  overlayState.welcome = buildWelcomeText(context, goal);
  overlayState.ideas = buildIdeas(context, language, goal.id);
  overlayState.guide = buildGuide(goal.id, context);
  overlayState.statusMessage = buildMainStatus(context);
  if (context.pageType === "codespace") {
    overlayState.analysisUnlocked = true;
  }

  if (githubContext) {
    try {
      await refreshGithubIntegrationStatus();
    } catch {
      overlayState.githubAppStatus = { ...EMPTY_GITHUB_APP_STATUS };
      overlayState.githubUserStatus = { ...EMPTY_GITHUB_USER_STATUS };
    }
    // Tunel sin editor guardado en este navegador: si el backend ya tiene el editor (se
    // preparo en otro navegador o equipo), se ofrece "Abrir mi editor" en vez del tour. Sin
    // await: la consulta no retrasa la entrada ni la peticion al tutor. Para cualquier rol
    // (0.7.20): el docente y el administrador tambien abren repos publicos en su editor;
    // solo se consulta (status), nunca se prepara nada al entrar.
    if (context.pageType !== "codespace" && typeof adoptExistingTunnelEditor === "function") {
      adoptExistingTunnelEditor()
        .then((adopted) => {
          if (adopted && overlayHost?.isConnected) renderOverlay();
        })
        .catch(() => {});
    }
    // Codespaces: una GitHub App ya instalada en la organizacion se vincula sin abrir la
    // pestana de instalacion (sin await, como la consulta anterior).
    if (context.pageType !== "codespace" && typeof autoLinkGithubInstallationOnEntry === "function") {
      autoLinkGithubInstallationOnEntry()
        .then((linked) => {
          if (linked && overlayHost?.isConnected) renderOverlay();
        })
        .catch(() => {});
    }
  } else {
    overlayState.githubAppStatus = { ...EMPTY_GITHUB_APP_STATUS };
    overlayState.githubUserStatus = { ...EMPTY_GITHUB_USER_STATUS };
  }

  overlayState.projectContextMessage = "";
  overlayState.projectContextError = "";

  if (githubContext) {
    try {
      await refreshProjectContextStatus();
    } catch {
      overlayState.projectContextStatus = { ...EMPTY_PROJECT_CONTEXT_STATUS };
    }

    try {
      await refreshProjectContextHistory();
    } catch {
      overlayState.projectContextHistory = [];
    }
  } else {
    overlayState.projectContextStatus = { ...EMPTY_PROJECT_CONTEXT_STATUS };
    overlayState.projectContextHistory = [];
  }

  const privacyPending = overlayState.firstLoginConfirmationOpen === true;
  if (privacyPending) {
    if (options?.skipModelRequests !== true) mentorDeferredUntilPrivacyAccepted = true;
  } else {
    mentorDeferredUntilPrivacyAccepted = false;
  }
  const skipModelRequests = options?.skipModelRequests === true || privacyPending;
  if (githubContext && overlayState.autoConfigEnabled && !skipModelRequests) {
    try {
      await refreshProjectContextInsight();
    } catch {
      overlayState.projectContextInsight = { ...EMPTY_PROJECT_CONTEXT_INSIGHT };
    }
  } else if (githubContext && !skipModelRequests) {
    overlayState.projectContextInsight = {
      ...EMPTY_PROJECT_CONTEXT_INSIGHT,
      configured: true,
      repoFullName: getCurrentRepoFullName(),
      modelEnabled: false,
      summary: "Configuracion automatica desactivada.",
    };
  } else if (!githubContext) {
    overlayState.projectContextInsight = { ...EMPTY_PROJECT_CONTEXT_INSIGHT };
  }

  if (githubContext) {
    await refreshDocumentClassifications();
  } else {
    overlayState.documentClassifications = { ...EMPTY_DOCUMENT_CLASSIFICATION_STATE };
  }

  if (context.pageType === "codespace" && typeof refreshVscodeSyncState === "function") {
    await refreshVscodeSyncState({ silent: true }).catch(() => {});
  } else {
    overlayState.vscodeSyncState = { ...EMPTY_VSCODE_SYNC_STATE };
  }
  // Fila "VS Code" del contexto en github.com: una consulta por actualizacion, sin await para
  // no sumar su viaje a la latencia del tutor (latencyMs se mide desde requestedAt).
  if (githubContext && context.pageType !== "codespace" && !isAdminSession()) {
    refreshVscodePresence()
      .then(() => {
        if (overlayHost?.isConnected) renderOverlay();
      })
      .catch(() => {});
  } else {
    overlayState.vscodePresence = { ...EMPTY_VSCODE_PRESENCE };
  }

  overlayState.ragSources = [];
  if (!skipModelRequests
    && overlayState.assistantEnabled
    && context.pageContext !== "unknown"
    && normalizeBaseUrl(overlayState.backendUrl)) {
    if (courseBitacoraRequest) {
      await Promise.race([courseBitacoraRequest, new Promise((resolve) => setTimeout(resolve, 1500))]);
    }
    const mentorRequestStartedAt = Date.now();
    recordTutorRequestSubmitted(tutorTrigger, context);
    try {
      const remote = await requestBackendMentor(context, language);
      recordTutorResponseReceived(remote, tutorRequestedAt, context);
      clearMentorFallbackTimer();
      if (remote.ideas.length > 0) overlayState.ideas = remote.ideas;
      if (remote.guide.length > 0) overlayState.guide = remote.guide;
      if (remote.welcome) overlayState.welcome = remote.welcome;
      // Con pistas del tutor (no la guia por defecto), el estudiante pasa a la pestana Tutor.
      if (remote.ideas.length > 0) showTutorTabForResponse({ manual: tutorTrigger === "manual" });
      overlayState.mentorSummary = remote.summary || "";
      overlayState.activeRagCourseCode = remote.ragCourseCode || "";
      if (remote.summary) overlayState.statusMessage = remote.summary;
      overlayState.ragSources = Array.isArray(remote.ragSources) ? remote.ragSources : [];
      if (isTeacherSession()) {
        await reloadPolicyAndTelemetry();
        await reloadAdminUsers();
      } else if (isAdminSession()) {
        await reloadAdminUsers();
      }
    } catch {
      scheduleMentorFallbackStatus(context, mentorRequestStartedAt);
    }
  }

  if (canManageUsersSession()) {
    try {
      await reloadAdminUsers();
    } catch {
      overlayState.adminUsers = [];
      overlayState.adminTeachers = [];
    }
  }

  overlayState.loading = false;
  renderOverlay();
  queueTabSessionSave();
}

// Listeners de la pestana Tutor (antes dentro de ensureOverlay, en el mismo orden).
function bindTutorPanel() {
  overlayEls.ragSourcesSection?.addEventListener("toggle", () => {
    overlayState.ragSourcesOpen = overlayEls.ragSourcesSection.open === true;
  });
  overlayEls.refreshBtn.addEventListener("click", async () => {
    await refreshMentorSession({ trigger: "manual", requestedAt: Date.now() });
  });
  overlayEls.tutorFeedbackAcceptBtn?.addEventListener("click", () => {
    handleTutorFeedbackChoice("accepted");
  });
  overlayEls.tutorFeedbackRejectBtn?.addEventListener("click", () => {
    handleTutorFeedbackChoice("rejected");
  });
  overlayEls.analysisCloseBtn.addEventListener("click", () => {
    overlayState.analysisWindowOpen = false;
    renderOverlay();
  });
}
