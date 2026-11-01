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
  overlayState.bitacoraOwner = { ...EMPTY_BITACORA_OWNER_STATE };
  overlayState.ragOwner = { ...EMPTY_RAG_OWNER_STATE };
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
  overlayState.adminSelectedUserIds = [];
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
  ensureAdaceenFonts();
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
  bindAdminImportPanel();
  bindPilotTopicPanel();
  bindTeacherTelemetryReload();
  bindTeacherQuizButtons();

  document.documentElement.appendChild(overlayHost);
  bindOverlayViewportListeners();
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
  overlayState.bitacoraOwner = { ...EMPTY_BITACORA_OWNER_STATE };
  overlayState.ragOwner = { ...EMPTY_RAG_OWNER_STATE };
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
  overlayState.adminSelectedUserIds = [];
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
// github.com/login/device durante la preparacion del tunel: muestra el codigo a copiar (y en
// el inicio de sesion de GitHub previo), y avisa si la cuenta abierta no es la del editor.
showGithubDeviceCodeHelper().catch(() => {});
// La ventana del OAuth en github.com (0.8.0): el paso 1 (iniciar sesion y autorizar a ADACEEN)
// o, si GitHub rechaza la direccion de regreso de ADACEEN, que hacer segun el rol.
showGithubOAuthPageHelper().catch(() => {});
// GitHub, cuando VS Code pide autorizar «Visual Studio Code» para entrar al editor: el paso 4.
showVscodeGithubAuthorizeHelper().catch(() => {});
// vscode.dev la primera vez en el editor: con que cuenta iniciar sesion.
showTunnelSignInHint().catch(() => {});
// vscode.dev no encuentra el tunel (se autorizo con otra cuenta de GitHub): «Reconectar con mi
// cuenta», el punto de restauracion (0.8.1).
watchTunnelNotFound().catch(() => {});
// Pagina de un repositorio de GitHub: «Abrir en mi editor» junto a Watch/Fork/Star (0.7.20).
startRepoEditorButton().catch(() => {});
