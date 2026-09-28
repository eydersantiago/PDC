// ADACEEN | Capa 5 - Ciclo de vida: montar el overlay (ensureOverlay llama a los bind...() de cada pestana),
// abrirlo y cerrarlo, entrada automatica y arranque. La sincronizacion entre pestanas esta en
// content-tab-session.js y content-active-tab.js; la ventana, en content-window.js.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
// Entrada automatica con un editor guardado (autoEnterWithSavedEditor): la pestana no cuenta
// como activa (POST /api/ui/active-tab -> active_tab_seen) hasta que el estudiante interactua
// con el overlay; asi entrar solo no infla el KPI "uso del agente".
let savedEditorAutoEnterIdle = false;
let overlayOpenInFlight = null;

function resetOverlayStateForOpen() {
  clearMentorFallbackTimer();
  savedEditorAutoEnterIdle = false;
  overlayState.started = false;
  overlayState.settingsOpen = false;
  overlayState.loading = false;
  overlayState.analysisBusy = false;
  overlayState.analysisUnlocked = false;
  overlayState.analysisWindowOpen = false;
  overlayState.projectAnalysis = null;
  overlayState.campusAnalysis = null;
  overlayState.setupRepoFullName = "";
  overlayState.setupWizardStep = 1;
  overlayState.githubAppBusy = false;
  overlayState.githubAppStatus = { ...EMPTY_GITHUB_APP_STATUS };
  overlayState.githubUserStatus = { ...EMPTY_GITHUB_USER_STATUS };
  overlayState.projectContextBusy = false;
  overlayState.projectContextStatus = { ...EMPTY_PROJECT_CONTEXT_STATUS };
  overlayState.projectContextHistory = [];
  overlayState.projectContextInsight = { ...EMPTY_PROJECT_CONTEXT_INSIGHT };
  overlayState.documentClassifications = { ...EMPTY_DOCUMENT_CLASSIFICATION_STATE };
  overlayState.teacherBitacoraStatus = { ...EMPTY_TEACHER_BITACORA_STATUS };
  overlayState.courseCalendar = { ...EMPTY_COURSE_CALENDAR_STATE };
  overlayState.teacherRagPageOpen = false;
  overlayState.teacherRagState = { ...EMPTY_TEACHER_RAG_STATE };
  overlayState.codespaceWaitingContext = { ...EMPTY_CODESPACE_WAITING_CONTEXT };
  overlayState.campusCourseAccess = { ...EMPTY_CAMPUS_COURSE_ACCESS_STATE };
  overlayState.ragCourseCatalog = [];
  overlayState.ragDefaultCourseCode = "FPOO";
  overlayState.studentCourseModalOpen = false;
  overlayState.studentCourseState = { ...EMPTY_STUDENT_COURSE_STATE };
  overlayState.vscodeSyncState = { ...EMPTY_VSCODE_SYNC_STATE };
  overlayState.ragSources = [];
  overlayState.projectContextMessage = "";
  overlayState.projectContextError = "";
  overlayState.adminUsers = [];
  overlayState.adminTeachers = [];
  overlayState.adminCreateFormOpen = false;
  overlayState.adminUsersBusy = false;
  overlayState.adminUsersMessage = "";
  overlayState.adminEditingUserId = "";
  overlayState.teacherRagLoadedAt = 0;
  overlayState.ragCoursesOpen = {};
  overlayState.ragLots = { ...EMPTY_RAG_LOTS_STATE };
  overlayState.ragLotFormOpen = {};
  overlayState.ragUploadLotByCourse = {};
  overlayState.quizzesPanel = { ...EMPTY_QUIZZES_PANEL_STATE };
  overlayState.teacherOutcomeHelpOpen = false;
  overlayState.mainTab = "inicio";
  overlayState.mainTabChosenByUser = false;
  overlayState.studentsPanel = { ...EMPTY_STUDENTS_PANEL_STATE };
  overlayState.settingsSectionsInitialized = false;
  overlayState.ideas = [];
  overlayState.guide = [];
  overlayState.welcome = "";
  overlayState.mentorSummary = "";
  overlayState.activeRagCourseCode = "";
  overlayState.statusMessage = "";
  overlayState.operationTitle = "";
  overlayState.operationDetail = "";
  overlayState.operationKind = "busy";
  overlayState.context = buildPayload();
}

async function ensureOverlay() {
  await loadPreferences();

  if (overlayHost?.isConnected && overlayRoot) {
    bindVscodeInlinePaletteListeners();
    startVscodeSyncPolling();
    return;
  }
  if (overlayHost && !overlayHost.isConnected) {
    overlayHost = null;
    overlayRoot = null;
    overlayEls = null;
  }

  const existingHost = document.getElementById(OVERLAY_HOST_ID);
  if (existingHost && existingHost !== overlayHost) {
    existingHost.remove();
  }

  overlayHost = document.createElement("div");
  overlayHost.id = OVERLAY_HOST_ID;
  // A12.8: raiz cerrada; el JavaScript de la pagina no puede leer los campos del overlay
  // (p. ej. la contrasena) con host.shadowRoot. El overlay usa solo la referencia overlayRoot.
  overlayRoot = overlayHost.attachShadow({ mode: "closed" });
  overlayRoot.innerHTML = buildOverlayMarkup();
  // Tras una entrada automatica, el primer clic o tecla en el overlay la vuelve una pestana activa.
  overlayRoot.addEventListener("pointerdown", noteOverlayInteractionAfterAutoEnter, true);
  overlayRoot.addEventListener("keydown", noteOverlayInteractionAfterAutoEnter, true);

  overlayEls = queryOverlayElements();

  bindOverlayAccessibility();
  bindMainTabs();
  bindStudentsPanel();
  bindRagCoursesPanel();
  bindQuizzesPanel();
  bindTutorPanel();
  bindWindowControls();
  bindSettingsPanel();
  bindAuthControls();
  bindSetupView();
  bindHomePanel();
  bindTabConflictNotice();
  bindProjectContextPanel();
  bindVscodeSyncPanel();
  bindTeacherBitacoraPanel();
  bindCourseAgendaPanel();
  bindTeacherRagPage();
  bindAdminUsersPanel();
  bindTeacherTelemetryReload();
  bindTeacherQuizButtons();

  document.documentElement.appendChild(overlayHost);
  bindOverlayViewportListeners();
  bindVscodeInlinePaletteListeners();
  startVscodeSyncPolling();
  overlayState.context = buildPayload();
  // Las cuentas demo solo se precargan con el backend local (npm run dev); en el piloto
  // el login llega vacio.
  if (isLocalBackendUrl(overlayState.backendUrl)) {
    overlayEls.authEmail.value = "estudiante@adaceen.edu.co";
    overlayEls.authPassword.value = "Estudiante123!";
  }
  renderOverlay();
  scheduleOverlayViewportSync(false);
}

// Entrada al abrir el overlay (item 13 de la auditoria: «Empezar» solo navegaba). Solo al
// abrirlo el estudiante (icono) o al restaurarlo fijado en la pestana visible; nunca por
// sincronizacion entre pestanas ni en github.com/login/device:
//  - sin sesion se muestra el login directamente;
//  - con un editor guardado (acceso simplificado, seccion 4), en GitHub, en paginas sin
//    contexto y en el propio editor del tunel (vscode.dev), entra sin pedir ayuda al tutor ni
//    contar como pestana activa hasta el primer clic o tecla, y ofrece "Abrir mi editor";
//  - con el icono y sin editor guardado entra como si se pulsara «Empezar» (el tutor
//    responde una vez);
//  - restaurado al cargar una pagina con algo que hacer (un repositorio de GitHub, el editor o
//    Campus), entra como con un editor guardado: sin el tutor ni pestana activa hasta que el
//    estudiante interactua, y sin el aviso de conflicto si otra pestana tiene la sesion activa.
//    Las paginas del propio flujo de GitHub (la ventana del OAuth, la instalacion de la GitHub
//    App, ajustes) y las paginas sin contexto se quedan en la bienvenida, como en 0.7.11.
let savedEditorAutoEnterInFlight = null;

// Donde un editor guardado permite entrar sin el tutor: GitHub, paginas sin contexto y
// vscode.dev (tunel). En Campus y en Codespaces el icono sigue pidiendo la primera respuesta.
function isSavedEditorAutoEnterPage(context) {
  const pageType = toText(context?.pageType);
  if (toText(context?.pageContext) === "campus" || pageType.startsWith("campus")) return false;
  if (pageType === "codespace") return isTunnelEditorPage(context);
  return true;
}

// Restaurado sin editor guardado: solo donde el overlay tiene algo que hacer.
function isRestoreAutoEnterPage(context) {
  const pageType = toText(context?.pageType);
  if (toText(context?.pageContext) === "campus" || pageType.startsWith("campus")) return true;
  if (pageType === "codespace") return true;
  return (pageType === "github_code" || pageType === "github_general")
    && !!parseRepoFullName(context?.repoFullName);
}

// Sin red: hay un editor del tunel guardado para la sesion del snapshot y la pagina lo ofrece.
// Con Codespaces ya confirmado (el caso normal sin editor guardado) no aplica.
function hasSavedEditorForAutoEnter(context) {
  if (!isSavedEditorAutoEnterPage(context)) return false;
  if (typeof getLatestSavedTunnelEditor !== "function" || !getLatestSavedTunnelEditor()) return false;
  return !(overlayState.workspaceProvider === "codespaces"
    && !(typeof isWorkspaceProviderProvisional === "function" && isWorkspaceProviderProvisional()));
}

function noteOverlayInteractionAfterAutoEnter() {
  if (!savedEditorAutoEnterIdle) return;
  savedEditorAutoEnterIdle = false;
  if (overlayState.started && document.visibilityState === "visible") {
    queueActiveTabReport(true);
  }
  queueTabSessionSave();
}

// La sesion del snapshot compartido puede ser vieja: /api/auth/me la confirma (y trae la
// privacidad aceptada en el backend). "unknown": sin red o sin respuesta a tiempo. Con un
// timeout corto: mientras tanto el unico boton es "Preparando..." y un backend frio (Azure)
// puede tardar minutos; al vencer, el icono entra igual, como «Empezar».
const SESSION_CONFIRM_ON_OPEN_TIMEOUT_MS = 10000;

async function confirmSessionOnOpen() {
  try {
    return (await fetchCurrentSession({ timeoutMs: SESSION_CONFIRM_ON_OPEN_TIMEOUT_MS })) ? "valid" : "invalid";
  } catch (error) {
    const status = Number(error?.status);
    return status === 401 || status === 403 ? "invalid" : "unknown";
  }
}

// Entra sin el tutor y sin reportarse como pestana activa hasta la primera interaccion. Al
// restaurar la pagina, otra pestana con la sesion activa no abre el aviso de conflicto.
async function enterOverlayIdle(trigger = "user") {
  savedEditorAutoEnterIdle = true;
  await startExperience({ skipModelRequests: true, quietActiveTabConflict: trigger === "restore" });
  if (!overlayState.started) savedEditorAutoEnterIdle = false;
  return overlayState.started;
}

async function autoEnterWithSavedEditor(trigger) {
  if (!hasSavedEditorForAutoEnter(overlayState.context || buildPayload())) return false;
  if (!hasActiveSession() || isAdminSession()) return false;
  // Con Codespaces el editor guardado (del tunel) no aplica.
  if (typeof refreshWorkspaceProvider === "function") {
    await refreshWorkspaceProvider().catch(() => "");
  }
  if (overlayState.workspaceProvider === "codespaces") return false;
  if (overlayState.started || !overlayHost?.isConnected) return false;
  return enterOverlayIdle(trigger);
}

async function autoEnterOnOpen(trigger) {
  if (overlayState.started) return false;
  if (trigger !== "user" && trigger !== "restore") return false;
  if (document.visibilityState === "hidden") return false;
  if (typeof isGithubDeviceLoginPage === "function" && isGithubDeviceLoginPage()) return false;
  if (getActiveTabConflictNotice()) return false;
  if (trigger === "restore") {
    // La ventana del OAuth, la instalacion de la GitHub App... (github.com/login/*,
    // github.com/apps/*): ni se entra ni se consulta el backend.
    const context = overlayState.context || buildPayload();
    if (isGithubFlowPageUrl(toText(context?.url) || location.href)) return false;
    // Paginas sin contexto y sin un editor guardado que ofrecer: «Empezar», como en 0.7.11.
    if (overlayState.sessionId && !isRestoreAutoEnterPage(context) && !hasSavedEditorForAutoEnter(context)) {
      return false;
    }
  }

  if (!overlayState.sessionId) {
    // Sin sesion, «Empezar» solo llevaba al login.
    overlayState.started = true;
    renderOverlay();
    return true;
  }

  // Mientras se confirma la sesion, la bienvenida dice "Preparando..." en vez de «Empezar».
  overlayState.loading = true;
  renderOverlay();
  let session = "unknown";
  try {
    session = await confirmSessionOnOpen();
  } finally {
    if (!overlayState.started) overlayState.loading = false;
  }
  // El estudiante pudo pulsar «Empezar» o cerrar el overlay mientras tanto.
  if (overlayState.started || !overlayHost?.isConnected) return false;
  if (session === "invalid") {
    resetAuthStateForCrossTabSync("");
    overlayState.authError = "La sesion ya no es valida. Inicia sesion nuevamente.";
    await persistPreferences().catch(() => false);
    if (typeof clearSharedSessionSnapshot === "function") {
      await clearSharedSessionSnapshot().catch(() => false);
    }
    overlayState.started = true;
    renderOverlay();
    return true;
  }
  // Sin respuesta del backend, restaurar la pagina no entra (queda «Empezar»); el icono si,
  // como «Empezar».
  if (session === "unknown" && trigger !== "user") {
    renderOverlay();
    return false;
  }
  if (getActiveTabConflictNotice()) {
    renderOverlay();
    return false;
  }

  if (session === "valid" && await autoEnterWithSavedEditor(trigger)) return true;
  if (overlayState.started || !overlayHost?.isConnected || !overlayState.sessionId) return false;
  if (trigger === "user") {
    await startExperience();
    return overlayState.started;
  }
  if (!isRestoreAutoEnterPage(overlayState.context || buildPayload())) {
    renderOverlay();
    return false;
  }
  return enterOverlayIdle(trigger);
}

// options.trigger: "user" (clic en el icono), "restore" (overlay fijado al cargar la pagina),
// "sync" (otra pestana) o "auto". Solo con "user" se mueve el foco al overlay (WCAG 2.4.3).
async function openOverlay(options = {}) {
  if (overlayOpenInFlight) {
    return overlayOpenInFlight;
  }

  const trigger = toText(options?.trigger) || "auto";
  const userInitiated = trigger === "user";
  overlayOpenInFlight = (async () => {
    const alreadyOpen = !!(overlayHost?.isConnected && overlayRoot);
    if (userInitiated && !isFocusInsideOverlay()) {
      rememberOverlayFocusReturnTarget();
    }
    if (!alreadyOpen) {
      resetOverlayStateForOpen();
    } else {
      overlayState.context = buildPayload();
    }

    await ensureOverlay();
    await syncFromStorageSnapshot({ force: true, skipPinned: true }).catch(() => {});

    if (!alreadyOpen) {
      const currentContext = overlayState.context || buildPayload();
      const handoff = await readCodespaceNavigationHandoff(currentContext);
      if (handoff) {
        applyCodespaceNavigationHandoff(handoff, currentContext);
      } else {
        const cached = await loadTabSessionSnapshot(currentContext);
        if (cached) {
          applyTabSessionSnapshot(cached);
        }
      }
    }

    await chrome.storage.local.set({ [STORAGE_KEY_OVERLAY_PINNED]: true });
    renderOverlay();
    if (!alreadyOpen) {
      recordOverlayOpened(trigger);
    }
    if (userInitiated) {
      focusOverlayAfterUserOpen();
    }
    if (activeCodespaceHandoff && overlayState.started && document.visibilityState === "visible") {
      queueActiveTabReport(true);
    }
    queueTabSessionSave();
    scheduleOverlayViewportSync(false);
    if (!alreadyOpen && !overlayState.started && !savedEditorAutoEnterInFlight) {
      // Sin await: el tutor puede tardar y el overlay ya esta visible con la bienvenida.
      savedEditorAutoEnterInFlight = autoEnterOnOpen(trigger)
        .catch(() => false)
        .finally(() => {
          savedEditorAutoEnterInFlight = null;
        });
    }
  })();

  try {
    return await overlayOpenInFlight;
  } finally {
    overlayOpenInFlight = null;
  }
}

// options.reason: "user" (boton cerrar), "escape", "sync" (otra pestana) o "message".
async function closeOverlay(options = {}) {
  const reason = toText(options?.reason) || "user";
  const wasOpen = !!overlayHost?.isConnected;
  const focusWasInside = isFocusInsideOverlay();
  if (wasOpen) {
    clearTutorResponseTracking("overlay_closed");
    recordOverlayClosed(reason);
  }
  stopVisibleErrorSignals();
  if (typeof stopGithubAppInstallWatch === "function") stopGithubAppInstallWatch();
  await flushTabSessionSave();
  clearMentorFallbackTimer();
  clearVscodeSyncPolling();
  if (vscodeInlinePaletteRaf) {
    window.cancelAnimationFrame(vscodeInlinePaletteRaf);
    vscodeInlinePaletteRaf = 0;
  }
  savedEditorAutoEnterIdle = false;
  overlayState.started = false;
  overlayState.settingsOpen = false;
  overlayState.minimized = false;
  overlayState.loading = false;
  overlayState.analysisBusy = false;
  overlayState.analysisUnlocked = false;
  overlayState.analysisWindowOpen = false;
  overlayState.projectAnalysis = null;
  overlayState.campusAnalysis = null;
  overlayState.setupRepoFullName = "";
  overlayState.setupWizardStep = 1;
  overlayState.githubAppBusy = false;
  overlayState.githubAppStatus = { ...EMPTY_GITHUB_APP_STATUS };
  overlayState.githubUserStatus = { ...EMPTY_GITHUB_USER_STATUS };
  overlayState.projectContextBusy = false;
  overlayState.projectContextStatus = { ...EMPTY_PROJECT_CONTEXT_STATUS };
  overlayState.projectContextHistory = [];
  overlayState.projectContextInsight = { ...EMPTY_PROJECT_CONTEXT_INSIGHT };
  overlayState.documentClassifications = { ...EMPTY_DOCUMENT_CLASSIFICATION_STATE };
  overlayState.teacherBitacoraStatus = { ...EMPTY_TEACHER_BITACORA_STATUS };
  overlayState.courseCalendar = { ...EMPTY_COURSE_CALENDAR_STATE };
  overlayState.teacherRagPageOpen = false;
  overlayState.teacherRagState = { ...EMPTY_TEACHER_RAG_STATE };
  overlayState.codespaceWaitingContext = { ...EMPTY_CODESPACE_WAITING_CONTEXT };
  overlayState.campusCourseAccess = { ...EMPTY_CAMPUS_COURSE_ACCESS_STATE };
  overlayState.ragCourseCatalog = [];
  overlayState.ragDefaultCourseCode = "FPOO";
  overlayState.studentCourseModalOpen = false;
  overlayState.studentCourseState = { ...EMPTY_STUDENT_COURSE_STATE };
  overlayState.projectContextMessage = "";
  overlayState.projectContextError = "";
  overlayState.adminUsers = [];
  overlayState.adminTeachers = [];
  overlayState.adminCreateFormOpen = false;
  overlayState.adminUsersBusy = false;
  overlayState.adminUsersMessage = "";
  overlayState.ideas = [];
  overlayState.guide = [];
  overlayState.welcome = "";
  overlayState.mentorSummary = "";
  overlayState.activeRagCourseCode = "";
  overlayState.statusMessage = "";
  overlayState.operationTitle = "";
  overlayState.operationDetail = "";
  overlayState.operationKind = "busy";

  try {
    await chrome.storage.local.set({
      [STORAGE_KEY_OVERLAY_PINNED]: false,
      [STORAGE_KEY_OVERLAY_MINIMIZED]: false,
    });
  } catch {}

  if (overlayHost?.isConnected) {
    overlayHost.remove();
  }

  overlayHost = null;
  overlayRoot = null;
  overlayEls = null;
  resetOverlayFocusState();
  if (focusWasInside || reason === "escape" || reason === "user") {
    restoreOverlayFocusReturnTarget();
  } else {
    forgetOverlayFocusReturnTarget();
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_GITHUB_CONTEXT" || message?.type === "GET_PAGE_INFO") {
    try {
      sendResponse({ ok: true, data: buildPayload() });
    } catch (error) {
      sendResponse({ ok: false, error: String(error) });
    }
    return;
  }

  if (message?.type === "ADACEEN_PING") {
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "ADACEEN_OPEN_OVERLAY") {
    openOverlay({ trigger: "user" })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ADACEEN_CLOSE_OVERLAY") {
    closeOverlay({ reason: "message" })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
});

bindCrossTabSyncListeners();
restorePinnedOverlay().catch(() => {});
syncFromStorageSnapshot({ force: true }).catch(() => {});
bindActiveTabSyncListeners();
refreshActiveTabStateFromBackend({ force: true }).catch(() => {});
// github.com/login/device durante la preparacion del tunel: muestra el codigo a copiar.
showGithubDeviceCodeHelper().catch(() => {});
