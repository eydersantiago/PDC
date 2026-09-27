// ADACEEN | Capa 5 - Ciclo de vida: montaje del overlay, listeners, sincronizacion entre pestanas y arranque.
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
  overlayState.teacherBitacoraPageOpen = false;
  overlayState.teacherBitacoraStatus = { ...EMPTY_TEACHER_BITACORA_STATUS };
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

  overlayEls = {
    shell: overlayRoot.getElementById("shell"),
    window: overlayRoot.getElementById("window"),
    vscodeInlinePalette: overlayRoot.getElementById("vscodeInlinePalette"),
    vscodeInlineStatus: overlayRoot.getElementById("vscodeInlineStatus"),
    vscodeInlineTarget: overlayRoot.getElementById("vscodeInlineTarget"),
    vscodeInlineFile: overlayRoot.getElementById("vscodeInlineFile"),
    vscodeInlineSuggestion: overlayRoot.getElementById("vscodeInlineSuggestion"),
    vscodeInlineActions: overlayRoot.getElementById("vscodeInlineActions"),
    minimizedTabBtn: overlayRoot.getElementById("minimizedTabBtn"),
    minimizedTabTitle: overlayRoot.getElementById("minimizedTabTitle"),
    minimizedTabSubtitle: overlayRoot.getElementById("minimizedTabSubtitle"),
    dragHandle: overlayRoot.getElementById("dragHandle"),
    headerUserTitle: overlayRoot.getElementById("headerUserTitle"),
    headerUserSubtitle: overlayRoot.getElementById("headerUserSubtitle"),
    minimizeBtn: overlayRoot.getElementById("minimizeBtn"),
    settingsBtn: overlayRoot.getElementById("settingsBtn"),
    logoutHeaderBtn: overlayRoot.getElementById("logoutHeaderBtn"),
    closeBtn: overlayRoot.getElementById("closeBtn"),
    settingsPanel: overlayRoot.getElementById("settingsPanel"),
    settingsCloseBtn: overlayRoot.getElementById("settingsCloseBtn"),
    welcomeView: overlayRoot.getElementById("welcomeView"),
    authView: overlayRoot.getElementById("authView"),
    setupView: overlayRoot.getElementById("setupView"),
    mainView: overlayRoot.getElementById("mainView"),
    firstLoginModal: overlayRoot.getElementById("firstLoginModal"),
    firstLoginCopy: overlayRoot.getElementById("firstLoginCopy"),
    firstLoginConfirmBtn: overlayRoot.getElementById("firstLoginConfirmBtn"),
    firstLoginLogoutBtn: overlayRoot.getElementById("firstLoginLogoutBtn"),
    studentCourseModal: overlayRoot.getElementById("studentCourseModal"),
    studentCourseCopy: overlayRoot.getElementById("studentCourseCopy"),
    studentCourseOptions: overlayRoot.getElementById("studentCourseOptions"),
    studentCourseStatus: overlayRoot.getElementById("studentCourseStatus"),
    studentCourseConfirmBtn: overlayRoot.getElementById("studentCourseConfirmBtn"),
    studentCourseLogoutBtn: overlayRoot.getElementById("studentCourseLogoutBtn"),
    tabConflictModal: overlayRoot.getElementById("tabConflictModal"),
    tabConflictNotice: overlayRoot.getElementById("tabConflictNotice"),
    tabConflictRefreshBtn: overlayRoot.getElementById("tabConflictRefreshBtn"),
    welcomeContext: overlayRoot.getElementById("welcomeContext"),
    welcomeCopy: overlayRoot.getElementById("welcomeCopy"),
    startBtn: overlayRoot.getElementById("startBtn"),
    authEmail: overlayRoot.getElementById("authEmail"),
    authPassword: overlayRoot.getElementById("authPassword"),
    authHelper: overlayRoot.getElementById("authHelper"),
    googleAuthBtn: overlayRoot.getElementById("googleAuthBtn"),
    authSubmitBtn: overlayRoot.getElementById("authSubmitBtn"),
    authBackBtn: overlayRoot.getElementById("authBackBtn"),
    authError: overlayRoot.getElementById("authError"),
    setupViewPill: overlayRoot.getElementById("setupViewPill"),
    setupViewTitle: overlayRoot.getElementById("setupViewTitle"),
    setupViewCopy: overlayRoot.getElementById("setupViewCopy"),
    setupStepOneCard: overlayRoot.getElementById("setupStepOneCard"),
    setupStepOneEyebrow: overlayRoot.getElementById("setupStepOneEyebrow"),
    setupStepOneTitle: overlayRoot.getElementById("setupStepOneTitle"),
    setupStepOneNote: overlayRoot.getElementById("setupStepOneNote"),
    setupContextHub: overlayRoot.getElementById("setupContextHub"),
    setupContextEyebrow: overlayRoot.getElementById("setupContextEyebrow"),
    setupContextTitle: overlayRoot.getElementById("setupContextTitle"),
    setupContextMeta: overlayRoot.getElementById("setupContextMeta"),
    setupContextStateChip: overlayRoot.getElementById("setupContextStateChip"),
    setupConnectionGrid: overlayRoot.getElementById("setupConnectionGrid"),
    setupOperationBanner: overlayRoot.getElementById("setupOperationBanner"),
    setupOperationTitle: overlayRoot.getElementById("setupOperationTitle"),
    setupOperationDetail: overlayRoot.getElementById("setupOperationDetail"),
    setupActionTitle: overlayRoot.getElementById("setupActionTitle"),
    setupActionCopy: overlayRoot.getElementById("setupActionCopy"),
    setupPrimaryActionBtn: overlayRoot.getElementById("setupPrimaryActionBtn"),
    setupSecondaryActionBtn: overlayRoot.getElementById("setupSecondaryActionBtn"),
    setupRepoInput: overlayRoot.getElementById("setupRepoInput"),
    setupDetectRepoBtn: overlayRoot.getElementById("setupDetectRepoBtn"),
    setupOpenLocalVscodeBtn: overlayRoot.getElementById("setupOpenLocalVscodeBtn"),
    setupStatusText: overlayRoot.getElementById("setupStatusText"),
    mainContext: overlayRoot.getElementById("mainContext"),
    roleBadge: overlayRoot.getElementById("roleBadge"),
    refreshBtn: overlayRoot.getElementById("refreshBtn"),
    contextHubSection: overlayRoot.getElementById("contextHubSection"),
    contextEyebrow: overlayRoot.getElementById("contextEyebrow"),
    contextTitle: overlayRoot.getElementById("contextTitle"),
    contextMeta: overlayRoot.getElementById("contextMeta"),
    contextStateChip: overlayRoot.getElementById("contextStateChip"),
    connectionGrid: overlayRoot.getElementById("connectionGrid"),
    contextOperationBanner: overlayRoot.getElementById("contextOperationBanner"),
    contextOperationTitle: overlayRoot.getElementById("contextOperationTitle"),
    contextOperationDetail: overlayRoot.getElementById("contextOperationDetail"),
    contextActionTitle: overlayRoot.getElementById("contextActionTitle"),
    contextActionCopy: overlayRoot.getElementById("contextActionCopy"),
    contextPrimaryActionBtn: overlayRoot.getElementById("contextPrimaryActionBtn"),
    contextSecondaryActionBtn: overlayRoot.getElementById("contextSecondaryActionBtn"),
    teacherBitacoraUploadBtn: overlayRoot.getElementById("teacherBitacoraUploadBtn"),
    teacherBitacoraFileInput: overlayRoot.getElementById("teacherBitacoraFileInput"),
    teacherRagManageBtn: overlayRoot.getElementById("teacherRagManageBtn"),
    teacherRagFileInput: overlayRoot.getElementById("teacherRagFileInput"),
    teacherBitacoraPage: overlayRoot.getElementById("teacherBitacoraPage"),
    teacherBitacoraCloseBtn: overlayRoot.getElementById("teacherBitacoraCloseBtn"),
    teacherBitacoraStatusText: overlayRoot.getElementById("teacherBitacoraStatusText"),
    teacherBitacoraLatestText: overlayRoot.getElementById("teacherBitacoraLatestText"),
    teacherBitacoraAgendaList: overlayRoot.getElementById("teacherBitacoraAgendaList"),
    teacherBitacoraDownloadTemplateBtn: overlayRoot.getElementById("teacherBitacoraDownloadTemplateBtn"),
    teacherBitacoraExportXlsxBtn: overlayRoot.getElementById("teacherBitacoraExportXlsxBtn"),
    teacherBitacoraExportCsvBtn: overlayRoot.getElementById("teacherBitacoraExportCsvBtn"),
    teacherBitacoraChooseFileBtn: overlayRoot.getElementById("teacherBitacoraChooseFileBtn"),
    teacherBitacoraManualWeekInput: overlayRoot.getElementById("teacherBitacoraManualWeekInput"),
    teacherBitacoraManualDateInput: overlayRoot.getElementById("teacherBitacoraManualDateInput"),
    teacherBitacoraManualCategorySelect: overlayRoot.getElementById("teacherBitacoraManualCategorySelect"),
    teacherBitacoraManualTitleInput: overlayRoot.getElementById("teacherBitacoraManualTitleInput"),
    teacherBitacoraManualDescriptionInput: overlayRoot.getElementById("teacherBitacoraManualDescriptionInput"),
    teacherBitacoraManualSaveBtn: overlayRoot.getElementById("teacherBitacoraManualSaveBtn"),
    teacherBitacoraManualClearBtn: overlayRoot.getElementById("teacherBitacoraManualClearBtn"),
    teacherBitacoraDeleteLatestBtn: overlayRoot.getElementById("teacherBitacoraDeleteLatestBtn"),
    teacherBitacoraClearDataBtn: overlayRoot.getElementById("teacherBitacoraClearDataBtn"),
    teacherBitacoraPageStatus: overlayRoot.getElementById("teacherBitacoraPageStatus"),
    teacherRagPage: overlayRoot.getElementById("teacherRagPage"),
    teacherRagCloseBtn: overlayRoot.getElementById("teacherRagCloseBtn"),
    teacherRagStatusText: overlayRoot.getElementById("teacherRagStatusText"),
    teacherRagCourseSelect: overlayRoot.getElementById("teacherRagCourseSelect"),
    teacherRagCourseCode: overlayRoot.getElementById("teacherRagCourseCode"),
    teacherRagCourseName: overlayRoot.getElementById("teacherRagCourseName"),
    teacherRagCourseSummary: overlayRoot.getElementById("teacherRagCourseSummary"),
    teacherRagUploadBtn: overlayRoot.getElementById("teacherRagUploadBtn"),
    teacherRagRefreshBtn: overlayRoot.getElementById("teacherRagRefreshBtn"),
    teacherRagSourceList: overlayRoot.getElementById("teacherRagSourceList"),
    teacherRagPageStatus: overlayRoot.getElementById("teacherRagPageStatus"),
    analyzeProjectBtn: overlayRoot.getElementById("analyzeProjectBtn"),
    rerunOcrBtn: overlayRoot.getElementById("rerunOcrBtn"),
    detailTitle: overlayRoot.getElementById("detailTitle"),
    detailMeta: overlayRoot.getElementById("detailMeta"),
    signalText: overlayRoot.getElementById("signalText"),
    policyLead: overlayRoot.getElementById("policyLead"),
    sessionBadge: overlayRoot.getElementById("sessionBadge"),
    policySectionTitle: overlayRoot.getElementById("policySectionTitle"),
    teacherSummary: overlayRoot.getElementById("teacherSummary"),
    githubAppSection: overlayRoot.getElementById("githubAppSection"),
    githubAppStatusText: overlayRoot.getElementById("githubAppStatusText"),
    githubAppInstallBtn: overlayRoot.getElementById("githubAppInstallBtn"),
    githubAppRefreshBtn: overlayRoot.getElementById("githubAppRefreshBtn"),
    githubAppBootstrapBtn: overlayRoot.getElementById("githubAppBootstrapBtn"),
    projectContextStatusSection: overlayRoot.getElementById("projectContextStatusSection"),
    projectContextStatusText: overlayRoot.getElementById("projectContextStatusText"),
    projectContextReadyValue: overlayRoot.getElementById("projectContextReadyValue"),
    projectContextVersionValue: overlayRoot.getElementById("projectContextVersionValue"),
    projectContextRequestValue: overlayRoot.getElementById("projectContextRequestValue"),
    projectContextSnapshotValue: overlayRoot.getElementById("projectContextSnapshotValue"),
    projectContextUpdatedValue: overlayRoot.getElementById("projectContextUpdatedValue"),
    projectContextSourceValue: overlayRoot.getElementById("projectContextSourceValue"),
    projectContextRefreshBtn: overlayRoot.getElementById("projectContextRefreshBtn"),
    projectContextHistorySection: overlayRoot.getElementById("projectContextHistorySection"),
    projectContextHistoryText: overlayRoot.getElementById("projectContextHistoryText"),
    projectContextHistoryList: overlayRoot.getElementById("projectContextHistoryList"),
    projectContextHistoryRefreshBtn: overlayRoot.getElementById("projectContextHistoryRefreshBtn"),
    adminUsersSection: overlayRoot.getElementById("adminUsersSection"),
    adminUsersStatus: overlayRoot.getElementById("adminUsersStatus"),
    adminReloadUsersBtn: overlayRoot.getElementById("adminReloadUsersBtn"),
    adminToggleCreateUserBtn: overlayRoot.getElementById("adminToggleCreateUserBtn"),
    adminCreateForm: overlayRoot.getElementById("adminCreateForm"),
    adminCreateRole: overlayRoot.getElementById("adminCreateRole"),
    adminCreateName: overlayRoot.getElementById("adminCreateName"),
    adminCreateEmail: overlayRoot.getElementById("adminCreateEmail"),
    adminCreatePassword: overlayRoot.getElementById("adminCreatePassword"),
    adminCreateTeacher: overlayRoot.getElementById("adminCreateTeacher"),
    adminCreateCourseGrid: overlayRoot.getElementById("adminCreateCourseGrid"),
    adminCreateBtn: overlayRoot.getElementById("adminCreateBtn"),
    adminUsersTableBody: overlayRoot.getElementById("adminUsersTableBody"),
    studentGoalSection: overlayRoot.getElementById("studentGoalSection"),
    vscodeSyncSection: overlayRoot.getElementById("vscodeSyncSection"),
    vscodeSyncDragHandle: overlayRoot.getElementById("vscodeSyncDragHandle"),
    vscodeCopySessionBtn: overlayRoot.getElementById("vscodeCopySessionBtn"),
    vscodeSyncRefreshBtn: overlayRoot.getElementById("vscodeSyncRefreshBtn"),
    vscodeSyncStatus: overlayRoot.getElementById("vscodeSyncStatus"),
    vscodeSyncMeta: overlayRoot.getElementById("vscodeSyncMeta"),
    vscodeFileTitle: overlayRoot.getElementById("vscodeFileTitle"),
    vscodeFileSummary: overlayRoot.getElementById("vscodeFileSummary"),
    vscodeSuggestionText: overlayRoot.getElementById("vscodeSuggestionText"),
    vscodeReplacementList: overlayRoot.getElementById("vscodeReplacementList"),
    ragSourcesSection: overlayRoot.getElementById("ragSourcesSection"),
    ragActiveCourseBadge: overlayRoot.getElementById("ragActiveCourseBadge"),
    ragSourcesList: overlayRoot.getElementById("ragSourcesList"),
    studentIdeasSection: overlayRoot.getElementById("studentIdeasSection"),
    nextStepSection: overlayRoot.getElementById("nextStepSection"),
    tutorResponseRegion: overlayRoot.getElementById("tutorResponseRegion"),
    tutorFeedbackSection: overlayRoot.getElementById("tutorFeedbackSection"),
    tutorFeedbackAcceptBtn: overlayRoot.getElementById("tutorFeedbackAcceptBtn"),
    tutorFeedbackRejectBtn: overlayRoot.getElementById("tutorFeedbackRejectBtn"),
    tutorFeedbackStatus: overlayRoot.getElementById("tutorFeedbackStatus"),
    goalGrid: overlayRoot.getElementById("goalGrid"),
    ideaList: overlayRoot.getElementById("ideaList"),
    guideList: overlayRoot.getElementById("guideList"),
    teacherPolicySection: overlayRoot.getElementById("teacherPolicySection"),
    teacherPolicyList: overlayRoot.getElementById("teacherPolicyList"),
    teacherTelemetrySection: overlayRoot.getElementById("teacherTelemetrySection"),
    telemetryList: overlayRoot.getElementById("telemetryList"),
    reloadTelemetryBtn: overlayRoot.getElementById("reloadTelemetryBtn"),
    previewSection: overlayRoot.getElementById("previewSection"),
    previewText: overlayRoot.getElementById("previewText"),
    statusText: overlayRoot.getElementById("statusText"),
    settingsSessionLabel: overlayRoot.getElementById("settingsSessionLabel"),
    settingsSessionMeta: overlayRoot.getElementById("settingsSessionMeta"),
    teacherEnabled: overlayRoot.getElementById("teacherEnabled"),
    autoConfigEnabled: overlayRoot.getElementById("autoConfigEnabled"),
    teacherSettingsBlock: overlayRoot.getElementById("teacherSettingsBlock"),
    teacherPolicyName: overlayRoot.getElementById("teacherPolicyName"),
    teacherOutcome: overlayRoot.getElementById("teacherOutcome"),
    teacherTone: overlayRoot.getElementById("teacherTone"),
    teacherFrequency: overlayRoot.getElementById("teacherFrequency"),
    teacherHelpLevel: overlayRoot.getElementById("teacherHelpLevel"),
    teacherMiniQuiz: overlayRoot.getElementById("teacherMiniQuiz"),
    teacherQuizAfterAccept: overlayRoot.getElementById("teacherQuizAfterAccept"),
    teacherQuizTeacherLaunch: overlayRoot.getElementById("teacherQuizTeacherLaunch"),
    teacherQuizFollowUp: overlayRoot.getElementById("teacherQuizFollowUp"),
    teacherQuizEveryN: overlayRoot.getElementById("teacherQuizEveryN"),
    teacherQuizMaxPerSession: overlayRoot.getElementById("teacherQuizMaxPerSession"),
    teacherQuizTopic: overlayRoot.getElementById("teacherQuizTopic"),
    teacherQuizLaunchBtn: overlayRoot.getElementById("teacherQuizLaunchBtn"),
    teacherQuizCloseBtn: overlayRoot.getElementById("teacherQuizCloseBtn"),
    teacherQuizStatus: overlayRoot.getElementById("teacherQuizStatus"),
    teacherOutcomeHelpBtn: overlayRoot.getElementById("teacherOutcomeHelpBtn"),
    teacherOutcomeHelp: overlayRoot.getElementById("teacherOutcomeHelp"),
    teacherCodeApplyAllowed: overlayRoot.getElementById("teacherCodeApplyAllowed"),
    teacherCodeApplyMaxLines: overlayRoot.getElementById("teacherCodeApplyMaxLines"),
    teacherCodeApplyCountsAsHint: overlayRoot.getElementById("teacherCodeApplyCountsAsHint"),
    teacherCodeApplyRequireConfirmation: overlayRoot.getElementById("teacherCodeApplyRequireConfirmation"),
    teacherNoSolution: overlayRoot.getElementById("teacherNoSolution"),
    teacherMaxHints: overlayRoot.getElementById("teacherMaxHints"),
    teacherAllowExplanation: overlayRoot.getElementById("teacherAllowExplanation"),
    teacherAllowHint: overlayRoot.getElementById("teacherAllowHint"),
    teacherAllowExample: overlayRoot.getElementById("teacherAllowExample"),
    teacherFallbackMessage: overlayRoot.getElementById("teacherFallbackMessage"),
    teacherCustomInstruction: overlayRoot.getElementById("teacherCustomInstruction"),
    backendUrlInput: overlayRoot.getElementById("backendUrlInput"),
    advancedGithubBlock: overlayRoot.getElementById("advancedGithubBlock"),
    advancedGithubNote: overlayRoot.getElementById("advancedGithubNote"),
    saveSettingsBtn: overlayRoot.getElementById("saveSettingsBtn"),
    analysisWindow: overlayRoot.getElementById("analysisWindow"),
    analysisCloseBtn: overlayRoot.getElementById("analysisCloseBtn"),
    analysisTitle: overlayRoot.getElementById("analysisTitle"),
    analysisStats: overlayRoot.getElementById("analysisStats"),
    analysisFileList: overlayRoot.getElementById("analysisFileList"),
    // Pestanas de la vista principal y pestana "Estudiantes" (0.7.13, content-students.js).
    mainTabBar: overlayRoot.getElementById("mainTabBar"),
    tabBtnInicio: overlayRoot.getElementById("tabBtnInicio"),
    tabBtnTutor: overlayRoot.getElementById("tabBtnTutor"),
    tabBtnEstudiantes: overlayRoot.getElementById("tabBtnEstudiantes"),
    tabBtnUsuarios: overlayRoot.getElementById("tabBtnUsuarios"),
    tabCountEstudiantes: overlayRoot.getElementById("tabCountEstudiantes"),
    tabPanelInicio: overlayRoot.getElementById("tabPanelInicio"),
    tabPanelTutor: overlayRoot.getElementById("tabPanelTutor"),
    tabPanelEstudiantes: overlayRoot.getElementById("tabPanelEstudiantes"),
    tabPanelUsuarios: overlayRoot.getElementById("tabPanelUsuarios"),
    tabBtnRag: overlayRoot.getElementById("tabBtnRag"),
    tabPanelRag: overlayRoot.getElementById("tabPanelRag"),
    ragCoursesSection: overlayRoot.getElementById("ragCoursesSection"),
    ragCoursesStatus: overlayRoot.getElementById("ragCoursesStatus"),
    ragCoursesRefreshBtn: overlayRoot.getElementById("ragCoursesRefreshBtn"),
    ragCourseGroups: overlayRoot.getElementById("ragCourseGroups"),
    ragCoursesMessage: overlayRoot.getElementById("ragCoursesMessage"),
    tabBtnQuices: overlayRoot.getElementById("tabBtnQuices"),
    tabPanelQuices: overlayRoot.getElementById("tabPanelQuices"),
    quizzesSection: overlayRoot.getElementById("quizzesSection"),
    quizzesStatus: overlayRoot.getElementById("quizzesStatus"),
    quizzesRefreshBtn: overlayRoot.getElementById("quizzesRefreshBtn"),
    quizzesCreateBtn: overlayRoot.getElementById("quizzesCreateBtn"),
    quizzesBankCount: overlayRoot.getElementById("quizzesBankCount"),
    quizzesBankList: overlayRoot.getElementById("quizzesBankList"),
    quizzesBankEmpty: overlayRoot.getElementById("quizzesBankEmpty"),
    quizzesDoneCount: overlayRoot.getElementById("quizzesDoneCount"),
    quizzesDoneSummary: overlayRoot.getElementById("quizzesDoneSummary"),
    quizzesDoneBody: overlayRoot.getElementById("quizzesDoneBody"),
    quizzesDoneEmpty: overlayRoot.getElementById("quizzesDoneEmpty"),
    quizzesMessage: overlayRoot.getElementById("quizzesMessage"),
    ragSourcesNote: overlayRoot.getElementById("ragSourcesNote"),
    ragSourcesCount: overlayRoot.getElementById("ragSourcesCount"),
    tutorLockedNotice: overlayRoot.getElementById("tutorLockedNotice"),
    settingsSectionSession: overlayRoot.getElementById("settingsSectionSession"),
    settingsSectionAdvanced: overlayRoot.getElementById("settingsSectionAdvanced"),
    settingsSectionPolicy: overlayRoot.getElementById("settingsSectionPolicy"),
    settingsSectionQuiz: overlayRoot.getElementById("settingsSectionQuiz"),
    settingsSectionCodeApply: overlayRoot.getElementById("settingsSectionCodeApply"),
    studentsSection: overlayRoot.getElementById("studentsSection"),
    studentsKpis: overlayRoot.getElementById("studentsKpis"),
    studentsSearchInput: overlayRoot.getElementById("studentsSearchInput"),
    studentsReloadBtn: overlayRoot.getElementById("studentsReloadBtn"),
    studentsStatus: overlayRoot.getElementById("studentsStatus"),
    studentsTableBody: overlayRoot.getElementById("studentsTableBody"),
    studentDetailSection: overlayRoot.getElementById("studentDetailSection"),
    studentDetailBackBtn: overlayRoot.getElementById("studentDetailBackBtn"),
    studentDetailTitle: overlayRoot.getElementById("studentDetailTitle"),
    studentDetailMeta: overlayRoot.getElementById("studentDetailMeta"),
    studentDetailChip: overlayRoot.getElementById("studentDetailChip"),
    studentDetailReloadBtn: overlayRoot.getElementById("studentDetailReloadBtn"),
    studentDetailStatus: overlayRoot.getElementById("studentDetailStatus"),
    studentDetailKpis: overlayRoot.getElementById("studentDetailKpis"),
    studentDetailTimeline: overlayRoot.getElementById("studentDetailTimeline"),
    studentDetailTimelineLegend: overlayRoot.getElementById("studentDetailTimelineLegend"),
    studentDetailQuizzes: overlayRoot.getElementById("studentDetailQuizzes"),
    studentDetailSessions: overlayRoot.getElementById("studentDetailSessions"),
    studentDetailInterventions: overlayRoot.getElementById("studentDetailInterventions"),
    studentDetailActivity: overlayRoot.getElementById("studentDetailActivity"),
  };

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
  overlayEls.analyzeProjectBtn.addEventListener("click", async () => {
    await analyzeCurrentContext();
  });
  bindVscodeSyncPanel();
  overlayEls.teacherBitacoraUploadBtn?.addEventListener("click", async () => {
    await openTeacherBitacoraPage();
  });
  // «Configurar RAG» abre la pestana RAG (0.7.14): todos los cursos a la vista, sin pagina aparte.
  overlayEls.teacherRagManageBtn?.addEventListener("click", () => {
    setMainTab("rag", { byUser: true, forceRender: true });
  });
  overlayEls.teacherBitacoraCloseBtn?.addEventListener("click", () => {
    closeTeacherBitacoraPage();
  });
  overlayEls.teacherRagCloseBtn?.addEventListener("click", () => {
    closeTeacherRagPage();
  });
  overlayEls.teacherRagCourseSelect?.addEventListener("change", async () => {
    await selectTeacherRagCourse(overlayEls.teacherRagCourseSelect.value);
  });
  overlayEls.teacherRagUploadBtn?.addEventListener("click", () => {
    openTeacherRagFilePicker();
  });
  overlayEls.teacherRagRefreshBtn?.addEventListener("click", async () => {
    await refreshTeacherRagSources();
  });
  overlayEls.teacherRagSourceList?.addEventListener("click", async (event) => {
    const button = event.target?.closest?.("[data-rag-delete-id]");
    if (!button) return;
    await deleteTeacherRagSource(button.getAttribute("data-rag-delete-id"));
  });
  overlayEls.teacherBitacoraDownloadTemplateBtn?.addEventListener("click", async () => {
    await downloadTeacherBitacoraTemplate();
  });
  overlayEls.teacherBitacoraExportXlsxBtn?.addEventListener("click", async () => {
    await exportTeacherBitacora("xlsx");
  });
  overlayEls.teacherBitacoraExportCsvBtn?.addEventListener("click", async () => {
    await exportTeacherBitacora("csv");
  });
  overlayEls.teacherBitacoraChooseFileBtn?.addEventListener("click", () => {
    openTeacherBitacoraFilePicker();
  });
  overlayEls.teacherBitacoraManualSaveBtn?.addEventListener("click", async () => {
    await saveTeacherBitacoraManualEntry();
  });
  overlayEls.teacherBitacoraManualClearBtn?.addEventListener("click", () => {
    clearTeacherBitacoraManualForm();
  });
  overlayEls.teacherBitacoraDeleteLatestBtn?.addEventListener("click", async () => {
    await deleteTeacherBitacoraLatest();
  });
  overlayEls.teacherBitacoraClearDataBtn?.addEventListener("click", async () => {
    await clearTeacherBitacoraData();
  });
  overlayEls.teacherBitacoraFileInput?.addEventListener("change", async () => {
    const file = overlayEls.teacherBitacoraFileInput.files?.[0] || null;
    overlayEls.teacherBitacoraFileInput.value = "";
    await uploadTeacherBitacoraFile(file);
  });
  overlayEls.teacherRagFileInput?.addEventListener("change", async () => {
    const file = overlayEls.teacherRagFileInput.files?.[0] || null;
    overlayEls.teacherRagFileInput.value = "";
    await uploadTeacherRagFile(file);
  });
  // "OCR visual" solo en el editor: en Campus la agenda se sincroniza desde la accion
  // recomendada ("Sincronizar agenda").
  overlayEls.rerunOcrBtn.addEventListener("click", async () => {
    await rerunScreenshotOcrFromDashboard();
  });
  overlayEls.githubAppInstallBtn.addEventListener("click", async () => {
    await startGithubAppInstallFlow();
  });
  overlayEls.githubAppRefreshBtn.addEventListener("click", async () => {
    overlayState.githubAppBusy = true;
    renderOverlay();
    try {
      await refreshGithubIntegrationStatus();
      overlayState.statusMessage = "Estado de GitHub App y OAuth actualizado.";
    } catch (error) {
      overlayState.statusMessage = `No se pudo actualizar estado GitHub: ${String(error)}`;
    } finally {
      overlayState.githubAppBusy = false;
      renderOverlay();
    }
  });
  overlayEls.githubAppBootstrapBtn.addEventListener("click", async () => {
    await bootstrapDevcontainerWithGithubApp({ force: true });
  });
  overlayEls.projectContextRefreshBtn.addEventListener("click", async () => {
    await refreshProjectContextPanel();
  });
  overlayEls.projectContextHistoryRefreshBtn.addEventListener("click", async () => {
    await refreshProjectContextPanel();
  });
  bindAdminUsersPanel();
  overlayEls.reloadTelemetryBtn?.addEventListener("click", async () => {
    await reloadPolicyAndTelemetry();
    renderOverlay();
  });
  overlayEls.teacherQuizLaunchBtn.addEventListener("click", async () => {
    await launchClassQuiz();
  });
  overlayEls.teacherQuizCloseBtn.addEventListener("click", async () => {
    await closeActiveClassQuiz();
  });

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
  overlayState.teacherBitacoraPageOpen = false;
  overlayState.teacherBitacoraStatus = { ...EMPTY_TEACHER_BITACORA_STATUS };
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
