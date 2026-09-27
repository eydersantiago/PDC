// ADACEEN | Capa 4 - UI: pinta overlayState en el DOM del overlay (renderOverlay y listas comunes); cada
// pestana pinta lo suyo desde su archivo (content-home.js, content-tutor.js, content-users.js...).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

// ---- Listas del overlay (ideas, guia, politica, analisis) ----

function clearList(listEl) {
  listEl.textContent = "";
}

function fillList(listEl, items) {
  if (!listEl) return;
  const values = (Array.isArray(items) ? items : []).map((item) => toText(item));
  // Con los mismos datos no se reconstruye: no se pierde el foco ni se repiten anuncios
  // de la region aria-live de respuestas (WCAG 2.4.3 y 4.1.3).
  if (!renderKeyChanged(listEl, JSON.stringify(values)) && listEl.childElementCount === values.length) return;
  clearList(listEl);
  const fragment = document.createDocumentFragment();
  const itemBuilder = listEl?.id?.toLowerCase().includes("guide")
    ? buildOverlayGuideItemTemplate
    : buildOverlayIdeaItemTemplate;

  for (const text of values) {
    fragment.appendChild(itemBuilder(text));
  }
  listEl.appendChild(fragment);
}

function renderGoalButtons() {
  if (!overlayEls?.goalGrid) return;

  const grid = overlayEls.goalGrid;
  const existing = Array.from(grid.querySelectorAll("button.goal-button"));
  const sameGoals = existing.length === LEARNING_GOALS.length
    && existing.every((button, index) => button.dataset.goalId === LEARNING_GOALS[index].id);

  if (!sameGoals) {
    grid.textContent = "";
    const fragment = document.createDocumentFragment();

    for (const goal of LEARNING_GOALS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "goal-button";
      button.dataset.goalId = goal.id;
      button.textContent = goal.label;
      button.addEventListener("click", async () => {
        overlayState.selectedLearningGoal = goal.id;
        await persistPreferences();
        renderGoalButtons();
        if (overlayState.started) {
          await refreshMentorSession({ trigger: "manual", requestedAt: Date.now() });
        } else {
          renderOverlay();
        }
      });

      fragment.appendChild(button);
    }

    grid.appendChild(fragment);
  }

  // Los botones no se recrean en cada render (el foco se conserva) y exponen su estado.
  for (const button of grid.querySelectorAll("button.goal-button")) {
    const selected = button.dataset.goalId === overlayState.selectedLearningGoal;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  }
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
    describeCodeApplicationPolicy(policy),
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

function firstPositiveNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function renderOverlay() {
  if (!overlayEls) return;

  const context = overlayState.context || buildPayload();
  const goal = getLearningGoal(overlayState.selectedLearningGoal);
  const language = inferLanguage(context.filePath, context.languageHint);
  const summary = buildSummaryBlock(context, language);
  const welcome = overlayState.welcome || buildWelcomeText(context, goal);
  const activeTabNotice = typeof getActiveTabConflictNotice === "function"
    ? toText(getActiveTabConflictNotice())
    : "";
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
    : formatTutorStatusText(overlayState.statusMessage)
      || (sectionsUnlocked ? buildMainStatus(context) : "Explora el proyecto para activar pistas y contexto.");
  const showingAuthView = overlayState.started && !hasActiveSession();
  const setupRequired = isGithubOrCodespaceContext(context);
  // El tour de configuracion es del estudiante: el admin y el docente entran al panel.
  const showingSetupView = overlayState.started
    && hasActiveSession()
    && !isAdminSession()
    && !isTeacherSession()
    && setupRequired
    && !hasCompletedSetup(context);
  const showingMainView = overlayState.started && hasActiveSession() && !showingSetupView;
  const showingStudentCourseModal = !!overlayState.studentCourseModalOpen && overlayState.session?.user?.role === "student";
  const showingFirstLoginModal = overlayState.firstLoginConfirmationOpen && hasActiveSession() && !showingStudentCourseModal;
  const showingTabConflictModal = !!activeTabNotice;
  // Con el tunel la GitHub App no interviene: sin "Ajustes avanzados GitHub App" en la tuerca.
  const tunnelProviderActive = isTunnelSetupFlow();
  const showAdvancedGithubBlock = hasActiveSession() && showingMainView && showGithubAppSection && !tunnelProviderActive;
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
  if (typeof renderTeacherBitacoraPage === "function") {
    renderTeacherBitacoraPage();
  }
  if (typeof renderTeacherRagPage === "function") {
    renderTeacherRagPage();
  }
  overlayEls.firstLoginModal.hidden = !showingFirstLoginModal;
  renderStudentCourseModal();
  overlayEls.tabConflictModal.hidden = !showingTabConflictModal;
  if (overlayEls.tabConflictNotice) {
    overlayEls.tabConflictNotice.textContent = activeTabNotice;
  }
  overlayEls.adminUsersSection.hidden = !showingMainView || !canManageUsersSession();
  renderMainTabs(showingMainView);
  renderStudentsPanel(showingMainView);
  renderRagCoursesPanel(showingMainView);
  renderQuizzesPanel(showingMainView);
  renderTeacherOutcomeHelp();
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
  setTextIfChanged(overlayEls.statusText, statusText);
  if (activeTabNotice && overlayEls.statusText?.classList) {
    overlayEls.statusText.classList.add("is-warning");
  } else if (overlayEls.statusText?.classList) {
    overlayEls.statusText.classList.remove("is-warning");
  }
  setTextIfChanged(overlayEls.authError, overlayState.authError || "");
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
  // "Explorar repo" y "OCR visual" solo funcionan dentro del editor: en github.com o en otras
  // paginas no se muestran. En Campus tampoco: "Analizar Campus" y "Sincronizar agenda" son la
  // accion recomendada y la cabecera ya no los repite (auditoria de redundancias, item 10).
  const editorPage = context.pageType === "codespace";
  overlayEls.analyzeProjectBtn.hidden = !editorPage;
  overlayEls.rerunOcrBtn.hidden = !editorPage;
  overlayEls.analyzeProjectBtn.disabled = overlayState.analysisBusy || !showingMainView || !editorPage;
  setTextIfChanged(overlayEls.analyzeProjectBtn, "Explorar repo");
  setTextIfChanged(overlayEls.rerunOcrBtn, "OCR visual");
  overlayEls.rerunOcrBtn.disabled = overlayState.loading
    || overlayState.analysisBusy
    || overlayState.projectContextBusy
    || !canRerunOcr;
  if (overlayEls.githubAppSection) {
    overlayEls.githubAppSection.hidden = tunnelProviderActive;
  }
  overlayEls.githubAppStatusText.textContent = githubAppStatusText;
  overlayEls.githubAppInstallBtn.disabled = overlayState.githubAppBusy || !githubConfigured || !hasActiveSession() || !setupRepoFullName;
  overlayEls.githubAppRefreshBtn.disabled = overlayState.githubAppBusy || !hasActiveSession();
  overlayEls.advancedGithubBlock.hidden = !showAdvancedGithubBlock;
  if (overlayEls.settingsSectionAdvanced) overlayEls.settingsSectionAdvanced.hidden = !showAdvancedGithubBlock;
  overlayEls.advancedGithubNote.textContent = showAdvancedGithubBlock
    ? `Repositorio actual: ${setupRepoFullName || "sin detectar"}. Usa esta opción solo si necesitas rehacer el PR de bootstrap.`
    : "Disponible cuando abras un repositorio GitHub/Codespaces con sesión activa.";
  overlayEls.githubAppBootstrapBtn.disabled = !showAdvancedGithubBlock
    || overlayState.githubAppBusy
    || !githubConfigured
    || !githubInstallation
    || !githubHasRepoAccess;
  setTextIfChanged(overlayEls.setupStatusText, setupStatusText);
  // Una sola tarjeta (el repositorio) y la accion recomendada como boton unico, con el tunel
  // (acceso simplificado, seccion 4) y con Codespaces (auditoria de redundancias, item 2): sin
  // botones que solo cambian de tarjeta ni "Verificar acceso". Con Codespaces el tour sigue
  // pidiendo la GitHub App, la cuenta de GitHub y crea el PR y el Codespace.
  const tunnelSetup = tunnelProviderActive;
  const inferredRepo = inferRepoFromContext(context);
  const repoInferredFromPage = !!setupRepoFullName
    && !!inferredRepo
    && inferredRepo.toLowerCase() === setupRepoFullName.toLowerCase();
  // Con el tunel no se prepara el repositorio (no hay ramas ni PR): se prepara el editor.
  setTextIfChanged(overlayEls.setupViewPill, tunnelSetup ? "Primera vez" : "Configuracion inicial");
  setTextIfChanged(overlayEls.setupViewTitle, tunnelSetup ? "Preparar tu editor" : "Preparar repositorio");
  setTextIfChanged(overlayEls.setupViewCopy, tunnelSetup
    ? "Conecta tu cuenta de GitHub y ADACEEN abrira tu editor en la nube (VS Code en el navegador)."
    : "Confirma el repo, autoriza GitHub y deja Codespaces listo para trabajar.");
  setTextIfChanged(overlayEls.setupStepOneEyebrow, "Repositorio");
  setTextIfChanged(overlayEls.setupStepOneTitle, "Tu repositorio");
  setTextIfChanged(overlayEls.setupStepOneNote, tunnelSetup
    ? "Tu editor en la nube clona este repositorio para ti: no se crean ramas ni PR."
    : "ADACEEN trabajara en una rama de preparacion; la rama principal no se toca.");
  // Sin repo, "Autodetectar repositorio" ya es la accion recomendada; con el repo de la pagina
  // no hace falta.
  overlayEls.setupDetectRepoBtn.hidden = repoInferredFromPage || !setupFlow.repoReady;
  overlayEls.setupStepOneCard.hidden = !showingSetupView;
  if (!overlayEls.setupRepoInput.matches(":focus")) {
    overlayEls.setupRepoInput.value = setupRepoFullName;
  }
  overlayEls.setupDetectRepoBtn.disabled = !showingSetupView || overlayState.githubAppBusy;
  if (overlayEls.setupOpenLocalVscodeBtn) {
    overlayEls.setupOpenLocalVscodeBtn.disabled = !showingSetupView || overlayState.githubAppBusy;
  }
  if (overlayEls.authHelper) {
    // Cuentas demo: solo con el backend local.
    overlayEls.authHelper.hidden = !isLocalBackendUrl(overlayState.backendUrl);
  }
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

    // aria-busy mientras se pide ayuda: el lector anuncia solo la respuesta final.
    overlayEls.tutorResponseRegion?.setAttribute("aria-busy", overlayState.loading ? "true" : "false");
    fillList(overlayEls.ideaList, ideas);
    fillList(overlayEls.guideList, guide);
    // Pestana Tutor sin proyecto leido: dice como activarlo en vez de quedar vacia.
    if (overlayEls.tutorLockedNotice) overlayEls.tutorLockedNotice.hidden = isAdminSession() || sectionsUnlocked;
    overlayEls.studentGoalSection.hidden = isTeacherSession() || isAdminSession() || !sectionsUnlocked;
    overlayEls.studentIdeasSection.hidden = isTeacherSession() || isAdminSession() || !sectionsUnlocked;
    overlayEls.nextStepSection.hidden = isAdminSession() || !sectionsUnlocked;
    overlayEls.previewSection.hidden = isAdminSession() || !sectionsUnlocked;
    overlayEls.teacherPolicySection.hidden = !isTeacherSession() || !sectionsUnlocked;
    // La telemetria reciente vive dentro de la pestana Estudiantes, debajo de la tabla.
    overlayEls.teacherTelemetrySection.hidden = !isTeacherSession() || !sectionsUnlocked || !!overlayState.studentsPanel?.selectedId;
    overlayEls.adminUsersSection.hidden = !canManageUsersSession();

    if (isTeacherSession()) {
      renderTeacherPolicyList();
      renderTelemetryList();
    }
    if (canManageUsersSession()) {
      renderAdminUsersTable();
    }
  }

  renderTutorFeedback(showingMainView
    && !isMinimized
    && !isAdminSession()
    && sectionsUnlocked
    && overlayState.assistantEnabled
    && !overlayState.loading);
  renderGoalButtons();
  syncSettingsInputs();
  setSettingsOpen(overlayState.settingsOpen);
  renderProjectAnalysisWindow();
  syncOverlayLayerFocus();
  scheduleOverlayViewportSync(true);
  queueTabSessionSave();
}
