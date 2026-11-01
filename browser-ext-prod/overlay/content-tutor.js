// ADACEEN | Capa 4 - UI: pestana «Tutor»: sesion con el tutor, resumen de su respuesta, «Fuentes RAG usadas»
// y la opinion del estudiante sobre la respuesta (A11.2).
// Movido sin cambios desde content-render.js (formato y render del resumen y de las fuentes) y desde
// content-lifecycle.js (refreshMentorSession, aviso de respaldo y listeners, ahora en bindTutorPanel).
// Sin "use strict": el codigo viene de archivos en modo no estricto y se conserva igual.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

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
  // Tema del piloto (0.7.21): el estudiante lo consulta al entrar, y de nuevo pasados 5 minutos
  // (Inicio y la semana del tutor); el docente, al abrir «Estudiantes».
  const pilotTopicRequest = overlayState.session?.user?.role === "student" && typeof ensurePilotTopicLoaded === "function"
    ? ensurePilotTopicLoaded({ maxAgeMs: PILOT_TOPIC_STUDENT_STALE_MS })
    : null;
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
    refreshVscodeRackStatus()
      .then(() => {
        if (overlayHost?.isConnected) renderOverlay();
      })
      .catch(() => {});
  } else {
    overlayState.vscodeRackStatus = { ...EMPTY_VSCODE_RACK_STATUS };
  }

  overlayState.ragSources = [];
  if (!skipModelRequests
    && overlayState.assistantEnabled
    && context.pageContext !== "unknown"
    && normalizeBaseUrl(overlayState.backendUrl)) {
    if (courseBitacoraRequest || pilotTopicRequest) {
      await Promise.race([
        Promise.all([courseBitacoraRequest, pilotTopicRequest].filter(Boolean).map((request) => Promise.resolve(request).catch(() => null))),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
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
