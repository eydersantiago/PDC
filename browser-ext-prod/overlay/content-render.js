// ADACEEN | Capa 4 - UI: pintado principal del overlay (renderOverlay) y listas compartidas.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

function clearList(listEl) {
  listEl.textContent = "";
}

function fillList(listEl, items) {
  clearList(listEl);
  const fragment = document.createDocumentFragment();
  for (const text of items) {
    fragment.appendChild(buildOverlayListItemTemplate(text));
  }
  listEl.appendChild(fragment);
}

function renderGoalButtons() {
  if (!overlayEls?.goalGrid) return;

  overlayEls.goalGrid.textContent = "";
  const fragment = document.createDocumentFragment();

  for (const goal of LEARNING_GOALS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "goal-button";
    button.dataset.goalId = goal.id;
    button.textContent = goal.label;
    button.classList.toggle("is-selected", goal.id === overlayState.selectedLearningGoal);
    button.addEventListener("click", async () => {
      overlayState.selectedLearningGoal = goal.id;
      await persistPreferences();
      renderGoalButtons();
      if (overlayState.started) {
        await refreshMentorSession();
      } else {
        renderOverlay();
      }
    });

    fragment.appendChild(button);
  }

  overlayEls.goalGrid.appendChild(fragment);
}

function renderTeacherPolicyList() {
  if (!overlayEls?.teacherPolicyList) return;
  const policy = overlayState.policy || DEFAULT_POLICY;
  fillList(overlayEls.teacherPolicyList, [
    `Nombre: ${policy.policyName || DEFAULT_POLICY.policyName}`,
    `Resultado: ${policy.outcome || DEFAULT_POLICY.outcome}`,
    `Nivel de ayuda: ${policy.helpLevel || DEFAULT_POLICY.helpLevel}`,
    `Maximo de pistas por ejercicio: ${policy.maxHintsPerExercise == null ? "Ilimitado" : policy.maxHintsPerExercise}`,
    `Intervenciones: ${(policy.allowedInterventions || DEFAULT_POLICY.allowedInterventions).join(", ")}`,
  ]);
}

function renderTelemetryList() {
  if (!overlayEls?.telemetryList) return;

  overlayEls.telemetryList.textContent = "";
  const items = Array.isArray(overlayState.telemetry) ? overlayState.telemetry : [];
  const behaviorMetrics = Array.isArray(overlayState.behaviorMetrics) ? overlayState.behaviorMetrics : [];

  if (items.length === 0 && behaviorMetrics.length === 0) {
    const li = document.createElement("li");
    li.textContent = "Aun no hay intervenciones ni metricas de VS Code registradas.";
    overlayEls.telemetryList.appendChild(li);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const li = document.createElement("li");
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    const detail = document.createElement("span");

    title.textContent = `${item.studentName || "Estudiante"} | ${item.eventType}`;
    meta.textContent = `${item.policyName} | ${item.interventionType} | ${new Date(item.createdAt).toLocaleString()}`;
    detail.textContent = item.reason || item.contextSummary || "Intervencion registrada.";

    li.appendChild(title);
    li.appendChild(meta);
    li.appendChild(detail);
    fragment.appendChild(li);
  }

  for (const metric of behaviorMetrics.slice(0, 8)) {
    const li = document.createElement("li");
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    const detail = document.createElement("span");
    const totalEvents = Number(metric.totalEvents || metric.total_events || 0) || 0;
    const totalCount = Number(metric.totalCount || metric.total_count || totalEvents) || totalEvents;
    const lastAt = toText(metric.lastOccurredAt || metric.last_occurred_at || metric.lastAt || "");
    const lastLabel = lastAt ? new Date(lastAt).toLocaleString() : "sin fecha";

    title.textContent = `VS Code | ${toText(metric.eventType || metric.event_type || "metrica")}`;
    meta.textContent = `${totalEvents} evento(s) | conteo ${totalCount} | ${lastLabel}`;
    detail.textContent = [
      metric.repoFullName || metric.repo_full_name ? `Repo: ${toText(metric.repoFullName || metric.repo_full_name)}` : "",
      metric.source ? `Fuente: ${toText(metric.source)}` : "Fuente: vscode_extension",
      metric.category ? `Categoria: ${toText(metric.category)}` : "Categoria: suggestion",
    ].filter(Boolean).join(" | ");

    li.appendChild(title);
    li.appendChild(meta);
    li.appendChild(detail);
    fragment.appendChild(li);
  }

  overlayEls.telemetryList.appendChild(fragment);
}

function renderOverlay() {
  if (!overlayEls) return;

  const context = getPageContext();
  const goal = getLearningGoal(overlayState.selectedLearningGoal);
  const language = inferLanguage(context.filePath, context.languageHint);
  const summary = buildSummaryBlock(context, language);
  const welcome = overlayState.welcome || buildWelcomeText(context, goal);
  const activeTabNotice = toText(getActiveTabConflictNotice());
  const sectionsUnlocked = overlayState.analysisUnlocked;
  const showGithubAppSection = shouldShowGithubAppSection(context);
  const githubAppStatusText = buildGithubAppStatusText();
  const githubConfigured = !!overlayState.githubAppStatus?.configured;
  const githubInstallation = overlayState.githubAppStatus?.installation;
  const githubHasRepoAccess = overlayState.githubAppStatus?.hasRepoAccess === true;
  const statusText = activeTabNotice
    ? activeTabNotice
    : overlayState.loading
    ? "Preparando contexto..."
    : overlayState.statusMessage
      || (sectionsUnlocked ? buildMainStatus(context) : "Explora el proyecto para activar pistas y contexto.");
  const showingAuthView = overlayState.started && !hasActiveSession();
  const setupRequired = isGithubOrCodespaceContext(context);
  const showingSetupView = overlayState.started
    && hasActiveSession()
    && !isAdminSession()
    && setupRequired
    && !hasCompletedSetup(context);
  const showingMainView = overlayState.started && hasActiveSession() && !showingSetupView;
  const showingStudentCourseModal = !!overlayState.studentCourseModalOpen && overlayState.session?.user?.role === "student";
  const showingFirstLoginModal = overlayState.firstLoginConfirmationOpen && hasActiveSession() && !showingStudentCourseModal;
  const showingProcessNoticeModal = overlayState.processNoticeOpen && hasActiveSession();
  const showingTabConflictModal = !!activeTabNotice;
  const showAdvancedGithubBlock = hasActiveSession() && showingMainView && showGithubAppSection;
  const currentRole = getRoleLabel(overlayState.session?.user?.role);
  const setupFlow = getSetupFlowState(context);
  const setupCurrentStep = resolveCurrentSetupStep(setupFlow);
  const setupActionModel = buildSetupRecommendedAction(context, setupCurrentStep, setupFlow);
  const mainActionModel = buildMainRecommendedAction(context, setupFlow);
  const setupStatusText = showingSetupView && overlayState.statusMessage
    ? overlayState.statusMessage
    : buildSetupStatusText(context, setupCurrentStep, setupFlow);
  const setupRepoFullName = getCurrentRepoFullName();
  const insight = overlayState.projectContextInsight || EMPTY_PROJECT_CONTEXT_INSIGHT;
  const status = overlayState.projectContextStatus || EMPTY_PROJECT_CONTEXT_STATUS;
  const connectedVersion = toText(insight.version || status.latestVersion || status.currentVersion);
  const insightLineParts = [];
  if (!overlayState.autoConfigEnabled) {
    insightLineParts.push("Configuracion automatica desactivada.");
  } else {
    if (insight.mainFilePath) {
      insightLineParts.push(`Archivo principal: ${insight.mainFilePath}.`);
    }
    if (insight.autoAdvice) {
      insightLineParts.push(`Consejo: ${insight.autoAdvice}`);
    }
    if (insight.screenshotUsed && insight.screenshotOcrText) {
      insightLineParts.push(`OCR: ${truncateText(insight.screenshotOcrText, 120)}`);
    }
    if (insight.screenshotSavedPath) {
      insightLineParts.push(`Captura: ${truncateText(insight.screenshotSavedPath, 120)}`);
    }
  }
  const insightLine = insightLineParts.join(" ");

  overlayEls.welcomeView.hidden = overlayState.started;
  overlayEls.authView.hidden = !showingAuthView;
  overlayEls.setupView.hidden = !showingSetupView;
  overlayEls.mainView.hidden = !showingMainView;
  renderTeacherBitacoraPage();
  renderTeacherRagPage();
  overlayEls.firstLoginModal.hidden = !showingFirstLoginModal;
  renderStudentCourseModal();
  overlayEls.processNoticeModal.hidden = !showingProcessNoticeModal;
  overlayEls.tabConflictModal.hidden = !showingTabConflictModal;
  if (overlayEls.tabConflictNotice) {
    overlayEls.tabConflictNotice.textContent = activeTabNotice;
  }
  overlayEls.adminUsersSection.hidden = !showingMainView || !canManageUsersSession();
  const isMinimized = overlayState.minimized === true;
  overlayEls.window.hidden = isMinimized;
  overlayEls.minimizedTabBtn.hidden = !isMinimized;
  overlayEls.shell.classList.toggle("is-minimized", isMinimized);
  overlayEls.shell.classList.toggle("shell-expanded", showingMainView && !isMinimized);
  overlayEls.shell.classList.toggle("has-tab-conflict", showingTabConflictModal);
  renderContextHub("setup", context, setupActionModel, setupFlow);
  renderContextHub("main", context, mainActionModel, setupFlow);

  overlayEls.welcomeContext.textContent = summary.contextLabel;
  overlayEls.welcomeCopy.textContent = welcome;
  overlayEls.mainContext.textContent = summary.contextLabel;
  overlayEls.headerUserTitle.textContent = overlayState.session?.user?.displayName || "ADACEEN";
  overlayEls.headerUserSubtitle.textContent = overlayState.session
    ? `${currentRole} | tutor contextual`
    : "tutor contextual";
  if (overlayEls.minimizedTabTitle) {
    overlayEls.minimizedTabTitle.textContent = overlayState.session?.user?.displayName || "ADACEEN";
  }
  if (overlayEls.minimizedTabSubtitle) {
    overlayEls.minimizedTabSubtitle.textContent = overlayState.session
      ? `${currentRole} | ${summary.contextLabel}`
      : summary.contextLabel;
  }
  overlayEls.roleBadge.textContent = currentRole;
  overlayEls.detailTitle.textContent = summary.detailTitle;
  overlayEls.detailMeta.textContent = summary.detailMeta;
  overlayEls.signalText.textContent = summary.signal;
  overlayEls.previewText.textContent = summary.preview;
  const policyLeadBase = isTeacherSession()
    ? "Estas viendo la politica activa del piloto y puedes gestionar tus estudiantes."
    : (isAdminSession()
      ? "Como admin puedes gestionar estudiantes/profesores aqui. Si necesitas GitHub App o PR, hazlo manualmente desde Configuracion."
      : "La ayuda del estudiante sigue la politica configurada por el docente.");
  overlayEls.policyLead.textContent = insightLine
    ? `${policyLeadBase} ${insightLine}`
    : policyLeadBase;
  overlayEls.sessionBadge.textContent = overlayState.session
    ? `${overlayState.session.user.displayName} | ${currentRole} | ${overlayState.session.user.email}`
      + (connectedVersion ? ` | Version ${connectedVersion}` : " | Version sin contexto")
    : "Sesion sin iniciar.";
  overlayEls.policySectionTitle.textContent = isTeacherSession()
    ? "Politica aplicada"
    : (isAdminSession() ? "Panel administrador" : "Mis parametros asignados");
  overlayEls.teacherSummary.textContent = isAdminSession()
    ? "Admin: crea, edita o desactiva usuarios con rol estudiante/profesor."
    : buildTeacherSummary();
  overlayEls.statusText.textContent = statusText;
  if (activeTabNotice && overlayEls.statusText?.classList) {
    overlayEls.statusText.classList.add("is-warning");
  } else if (overlayEls.statusText?.classList) {
    overlayEls.statusText.classList.remove("is-warning");
  }
  overlayEls.authError.textContent = overlayState.authError || "";
  overlayEls.firstLoginCopy.textContent = overlayState.session?.user?.displayName
    ? `Es la primera vez que ingresas a ADACEEN, ${overlayState.session.user.displayName}. Acepta la politica de privacidad y el uso de datos del piloto para activar tu sesion.`
    : "Es la primera vez que ingresas a ADACEEN con esta cuenta. Acepta la politica de privacidad y el uso de datos del piloto para activar tu sesion.";
  overlayEls.startBtn.disabled = overlayState.loading || showingTabConflictModal;
  overlayEls.refreshBtn.disabled = overlayState.loading || !overlayState.assistantEnabled || !showingMainView || showingTabConflictModal;
  overlayEls.logoutHeaderBtn.disabled = !hasActiveSession();
  const canRerunOcr = showingMainView
    && overlayState.autoConfigEnabled
    && context.pageType === "codespace"
    && !!setupRepoFullName;
  const showingCampusContext = context.pageContext === "campus";
  const showTeacherBitacoraUpload = showingMainView && isTeacherSession();
  const showTeacherRagManage = showingMainView && isTeacherSession();
  if (overlayEls.teacherBitacoraUploadBtn) {
    overlayEls.teacherBitacoraUploadBtn.hidden = !showTeacherBitacoraUpload;
    overlayEls.teacherBitacoraUploadBtn.disabled = overlayState.loading
      || overlayState.analysisBusy
      || !showTeacherBitacoraUpload;
  }
  if (overlayEls.teacherRagManageBtn) {
    overlayEls.teacherRagManageBtn.hidden = !showTeacherRagManage;
    overlayEls.teacherRagManageBtn.disabled = overlayState.loading
      || overlayState.analysisBusy
      || !showTeacherRagManage;
  }
  overlayEls.analyzeProjectBtn.disabled = overlayState.analysisBusy || !showingMainView;
  overlayEls.analyzeProjectBtn.textContent = context.pageContext === "campus"
    ? "Analizar Campus"
    : "Explorar repo";
  overlayEls.rerunOcrBtn.textContent = showingCampusContext ? "Sincronizar agenda" : "OCR visual";
  overlayEls.rerunOcrBtn.disabled = overlayState.loading
    || overlayState.analysisBusy
    || overlayState.projectContextBusy
    || (!showingCampusContext && !canRerunOcr);
  overlayEls.githubAppStatusText.textContent = githubAppStatusText;
  overlayEls.githubAppInstallBtn.disabled = overlayState.githubAppBusy || !githubConfigured || !hasActiveSession() || !setupRepoFullName;
  overlayEls.githubAppRefreshBtn.disabled = overlayState.githubAppBusy || !hasActiveSession();
  overlayEls.advancedGithubBlock.hidden = !showAdvancedGithubBlock;
  overlayEls.advancedGithubNote.textContent = showAdvancedGithubBlock
    ? `Repositorio actual: ${setupRepoFullName || "sin detectar"}. Usa esta opción solo si necesitas rehacer el PR de bootstrap.`
    : "Disponible cuando abras un repositorio GitHub/Codespaces con sesión activa.";
  overlayEls.githubAppBootstrapBtn.disabled = !showAdvancedGithubBlock
    || overlayState.githubAppBusy
    || !githubConfigured
    || !githubInstallation
    || !githubHasRepoAccess;
  overlayEls.setupStatusText.textContent = setupStatusText;
  overlayEls.setupStepOneCard.hidden = !showingSetupView || setupCurrentStep !== 1;
  overlayEls.setupStepTwoCard.hidden = !showingSetupView || setupCurrentStep !== 2;
  overlayEls.setupStepThreeCard.hidden = !showingSetupView || setupCurrentStep !== 3;
  if (!overlayEls.setupRepoInput.matches(":focus")) {
    overlayEls.setupRepoInput.value = setupRepoFullName;
  }
  overlayEls.setupExploreBtn.disabled = overlayState.analysisBusy || !showingSetupView || setupCurrentStep !== 1;
  overlayEls.setupDetectRepoBtn.disabled = !showingSetupView || setupCurrentStep !== 1 || overlayState.githubAppBusy;
  overlayEls.setupToStep2Btn.disabled = !showingSetupView || setupCurrentStep !== 1 || overlayState.githubAppBusy;
  overlayEls.setupInstallAppBtn.disabled = !showingSetupView
    || setupCurrentStep !== 2
    || overlayState.githubAppBusy
    || !setupFlow.configured
    || !setupFlow.repoReady;
  overlayEls.setupRefreshAppBtn.disabled = !showingSetupView
    || setupCurrentStep !== 2
    || overlayState.githubAppBusy
    || !setupFlow.configured
    || !setupFlow.repoReady;
  overlayEls.setupBackToStep1Btn.disabled = !showingSetupView || setupCurrentStep !== 2 || overlayState.githubAppBusy;
  overlayEls.setupToStep3Btn.disabled = !showingSetupView
    || setupCurrentStep !== 2
    || overlayState.githubAppBusy
    || (!BYPASS_GITHUB_APP_INSTALL_VALIDATION && (!setupFlow.appConnected || !setupFlow.accessVerified));
  overlayEls.setupCreatePrBtn.disabled = !showingSetupView
    || setupCurrentStep !== 3
    || overlayState.githubAppBusy
    || (!BYPASS_GITHUB_APP_INSTALL_VALIDATION && (!setupFlow.appConnected || !setupFlow.accessVerified))
    || !setupFlow.userOAuthConfigured
    || !setupFlow.userConnected
    || !setupFlow.userHasCodespaceScope;
  overlayEls.setupCreatePrBtn.textContent = setupFlow.userHasCodespaceScope
    ? "Crear PR y Codespace"
    : "Conectar GitHub para Codespace";
  overlayEls.setupBackToStep2Btn.disabled = !showingSetupView || setupCurrentStep !== 3 || overlayState.githubAppBusy;
  overlayEls.setupContinueBtn.disabled = !showingSetupView || setupCurrentStep !== 3 || overlayState.githubAppBusy;
  overlayEls.setupLogoutBtn.disabled = !showingSetupView;
  overlayEls.authSubmitBtn.disabled = overlayState.authBusy;
  overlayEls.googleAuthBtn.disabled = overlayState.authBusy;
  overlayEls.googleAuthBtn.textContent = overlayState.authBusy ? "Conectando..." : "Continuar con Google";
  overlayEls.authBackBtn.disabled = overlayState.authBusy;
  renderProjectContextSettings();
  renderVscodeSyncPanel(context, showingMainView);
  renderRagSourcesPanel(showingMainView);

  if (!overlayState.started) {
    overlayEls.startBtn.textContent = overlayState.loading ? "Preparando..." : "Empezar";
  }

  if (showingMainView) {
    const ideas = overlayState.assistantEnabled
      ? overlayState.ideas
      : ["El tutor esta pausado. Activalo desde la configuracion para seguir."];
    const guide = overlayState.assistantEnabled
      ? overlayState.guide
      : ["Abre configuracion.", "Activa el tutor.", "Pulsa Actualizar."];

    fillList(overlayEls.ideaList, ideas);
    fillList(overlayEls.guideList, guide);
    overlayEls.studentGoalSection.hidden = isTeacherSession() || isAdminSession() || !sectionsUnlocked;
    overlayEls.studentIdeasSection.hidden = isTeacherSession() || isAdminSession() || !sectionsUnlocked;
    overlayEls.nextStepSection.hidden = isAdminSession() || !sectionsUnlocked;
    overlayEls.previewSection.hidden = isAdminSession() || !sectionsUnlocked;
    overlayEls.teacherPolicySection.hidden = !isTeacherSession() || !sectionsUnlocked;
    overlayEls.teacherTelemetrySection.hidden = !isTeacherSession() || !sectionsUnlocked;
    overlayEls.adminUsersSection.hidden = !canManageUsersSession();

    if (isTeacherSession()) {
      renderTeacherPolicyList();
      renderTelemetryList();
    }
    if (canManageUsersSession()) {
      renderAdminUsersTable();
    }
  }

  renderGoalButtons();
  syncSettingsInputs();
  setSettingsOpen(overlayState.settingsOpen);
  renderProjectAnalysisWindow();
  scheduleOverlayViewportSync(true);
  queueTabSessionSave();
}
