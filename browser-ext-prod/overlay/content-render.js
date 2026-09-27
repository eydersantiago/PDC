// ADACEEN | Capa 4 - UI: pinta overlayState en el DOM del overlay (renderOverlay y vistas parciales).
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

function shortenCompactId(value, max = 10) {
  const text = toText(value);
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function formatProjectContextTimestamp(value) {
  const text = toText(value);
  if (!text) return "Sin datos";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleString();
}

function normalizeProjectContextStatusPayload(payload) {
  const source = payload?.status || payload?.context || payload || {};
  return {
    configured: !!source.configured,
    repoFullName: toText(source.repoFullName || source.repo_full_name || source.repo || ""),
    hasContext: !!(source.hasContext ?? source.contextReady ?? source.ready ?? source.available),
    latestRequestId: toText(source.latestRequestId || source.requestId || source.latest_request_id || source.currentRequestId || ""),
    latestSnapshotId: toText(source.latestSnapshotId || source.snapshotId || source.latest_snapshot_id || ""),
    latestVersion: toText(source.latestVersion || source.version || source.versionLabel || source.latest_version || ""),
    currentVersion: toText(source.currentVersion || source.current_version || source.versionName || ""),
    updatedAt: toText(source.updatedAt || source.updated_at || source.lastUpdatedAt || source.last_updated_at || ""),
    source: toText(source.source || source.contextSource || source.latestSource || ""),
    summary: toText(source.summary || source.message || source.description || ""),
    details: toText(source.details || source.note || source.extra || ""),
    totalVersions: Math.max(0, Number(source.totalVersions || source.total_versions || source.historyCount || 0) || 0),
    requestStatus: toText(source.requestStatus || source.status || ""),
  };
}

function normalizeProjectContextHistoryPayload(payload) {
  const source = payload?.history || payload?.items || payload?.versions || payload?.rebuilds || payload || [];
  const items = Array.isArray(source) ? source : [];

  return items.map((item) => ({
    requestId: toText(item?.requestId || item?.request_id || item?.id || ""),
    snapshotId: toText(item?.snapshotId || item?.snapshot_id || ""),
    version: toText(item?.version || item?.versionLabel || item?.label || item?.name || ""),
    status: toText(item?.status || item?.state || ""),
    summary: toText(item?.summary || item?.message || item?.description || ""),
    updatedAt: toText(item?.updatedAt || item?.updated_at || item?.createdAt || item?.created_at || ""),
    source: toText(item?.source || item?.origin || ""),
    canRebuild: item?.canRebuild !== false,
  }));
}

function normalizeProjectContextInsightPayload(payload) {
  const source = payload?.insight || payload?.data || payload || {};
  const rawCandidates = Array.isArray(source.candidates) ? source.candidates : [];
  return {
    ...EMPTY_PROJECT_CONTEXT_INSIGHT,
    configured: source.configured !== false,
    repoFullName: toText(source.repoFullName || source.repo_full_name || source.repo || ""),
    hasContext: !!(source.hasContext ?? source.ready ?? source.available),
    requestId: toText(source.requestId || source.request_id || ""),
    snapshotId: toText(source.snapshotId || source.snapshot_id || ""),
    version: toText(source.version || source.latestVersion || ""),
    currentVersion: toText(source.currentVersion || source.current_version || ""),
    source: toText(source.source || ""),
    updatedAt: toText(source.updatedAt || source.updated_at || ""),
    totalFiles: Math.max(0, Number(source.totalFiles || source.total_files || 0) || 0),
    totalBytes: Math.max(0, Number(source.totalBytes || source.total_bytes || 0) || 0),
    summary: toText(source.summary || ""),
    mainFilePath: toText(source.mainFilePath || source.main_file_path || ""),
    mainFileReason: toText(source.mainFileReason || source.main_file_reason || source.reason || ""),
    autoAdvice: toText(source.autoAdvice || source.auto_advice || source.advice || ""),
    modelEnabled: source.modelEnabled !== false,
    modelUsed: source.modelUsed === true,
    modelProvider: toText(source.modelProvider || source.model_provider || ""),
    candidates: rawCandidates
      .map((candidate) => ({
        path: toText(candidate?.path),
        score: Number(candidate?.score) || 0,
        reason: toText(candidate?.reason),
      }))
      .filter((candidate) => !!candidate.path)
      .slice(0, 5),
    modelError: toText(source.modelError || source.model_error || ""),
    storageReadError: toText(source.storageReadError || source.storage_read_error || ""),
    screenshotUsed: source.screenshotUsed === true || source.screenshot_used === true,
    screenshotSource: toText(source.screenshotSource || source.screenshot_source || ""),
    screenshotOcrText: toText(source.screenshotOcrText || source.screenshot_ocr_text || source.ocrText || ""),
    screenshotConfidence: Math.max(0, Number(source.screenshotConfidence || source.screenshot_confidence || source.confidence || 0) || 0),
    screenshotSavedPath: toText(source.screenshotSavedPath || source.screenshot_saved_path || ""),
    screenshotSavedAt: toText(source.screenshotSavedAt || source.screenshot_saved_at || ""),
  };
}

function normalizeDocumentClassificationsPayload(payload) {
  const source = payload?.classifications || payload?.items || payload || [];
  const items = Array.isArray(source) ? source : [];
  return items.map((item) => ({
    id: toText(item?.id),
    repoFullName: toText(item?.repoFullName || item?.repo_full_name),
    requestId: toText(item?.requestId || item?.request_id),
    snapshotId: toText(item?.snapshotId || item?.snapshot_id),
    filePath: toText(item?.filePath || item?.file_path),
    fileName: toText(item?.fileName || item?.file_name),
    label: toText(item?.label || "OTRO").toUpperCase() === "BITACORA" ? "BITACORA" : "OTRO",
    confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0)),
    method: toText(item?.method || "rules"),
    evidence: Array.isArray(item?.evidence)
      ? item.evidence.map(toText).filter(Boolean).slice(0, 8)
      : [],
    reason: toText(item?.reason),
    bitacoraAgenda: normalizeBitacoraAgendaPayload(item?.bitacoraAgenda || item?.bitacora_agenda),
    modelUsed: item?.modelUsed === true || item?.model_used === true,
    modelError: toText(item?.modelError || item?.model_error),
    classifiedAt: toText(item?.classifiedAt || item?.classified_at),
  })).filter((item) => item.filePath || item.fileName);
}

function normalizeBitacoraAgendaPayload(value) {
  const source = value && typeof value === "object" ? value : {};
  const rawItems = Array.isArray(source.items) ? source.items : [];
  return {
    items: rawItems.map((item) => ({
      title: toText(item?.title),
      type: toText(item?.type || "activity"),
      category: toText(item?.category),
      dueAt: toText(item?.dueAt || item?.due_at),
      visibleDueText: toText(item?.visibleDueText || item?.visible_due_text),
      description: toText(item?.description),
      confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0)),
      evidence: Array.isArray(item?.evidence)
        ? item.evidence.map(toText).filter(Boolean).slice(0, 6)
        : [],
    })).filter((item) => item.title).slice(0, 40),
    summary: toText(source.summary),
    warnings: Array.isArray(source.warnings)
      ? source.warnings.map(toText).filter(Boolean).slice(0, 6)
      : [],
  };
}

function normalizeDocumentClassificationState(value) {
  if (Array.isArray(value)) {
    return {
      ...EMPTY_DOCUMENT_CLASSIFICATION_STATE,
      items: normalizeDocumentClassificationsPayload(value),
    };
  }

  const source = value && typeof value === "object" ? value : {};
  return {
    ...EMPTY_DOCUMENT_CLASSIFICATION_STATE,
    items: normalizeDocumentClassificationsPayload(source.items || source.classifications || []),
    busy: source.busy === true,
    message: toText(source.message),
    error: toText(source.error),
  };
}

function buildProjectContextStatusText() {
  const repoFullName = getCurrentRepoFullName();
  const status = overlayState.projectContextStatus || EMPTY_PROJECT_CONTEXT_STATUS;
  const insight = overlayState.projectContextInsight || EMPTY_PROJECT_CONTEXT_INSIGHT;

  if (!repoFullName) {
    return "Abre un repositorio para consultar contexto y versiones.";
  }

  if (!status.configured) {
    return "El backend aun no expone el estado de contexto para este repositorio.";
  }

  if (!status.hasContext) {
    return status.summary || "Aun no se ha guardado contexto para este repo.";
  }

  const parts = [];
  const versionText = insight.version || status.latestVersion || status.currentVersion;
  if (versionText) parts.push(`Version ${versionText}`);
  if (status.latestRequestId) parts.push(`Request ${shortenCompactId(status.latestRequestId)}`);
  if (status.latestSnapshotId) parts.push(`Snapshot ${shortenCompactId(status.latestSnapshotId)}`);
  if (status.updatedAt) parts.push(`Actualizado ${formatProjectContextTimestamp(status.updatedAt)}`);
  if (status.source) parts.push(`Fuente ${status.source}`);
  if (insight.mainFilePath) parts.push(`Principal ${insight.mainFilePath}`);
  if (insight.modelUsed) parts.push(`IA ${insight.modelProvider || "local"}`);
  if (!insight.modelEnabled) parts.push("IA desactivada");
  if (insight.screenshotUsed) {
    const confidence = Math.max(0, Math.round(Number(insight.screenshotConfidence) || 0));
    parts.push(`OCR ${confidence}%`);
  }
  if (insight.screenshotSavedPath) parts.push(`Screenshot ${insight.screenshotSavedPath}`);
  if (insight.autoAdvice) parts.push(truncateText(insight.autoAdvice, 120));
  if (status.summary) parts.push(status.summary);

  return parts.join(" | ") || "Contexto listo para rebuild.";
}

function buildProjectContextHistoryText() {
  const repoFullName = getCurrentRepoFullName();
  const history = Array.isArray(overlayState.projectContextHistory) ? overlayState.projectContextHistory : [];

  if (!repoFullName) {
    return "Abre un repositorio para ver el historial de rebuilds.";
  }

  if (history.length === 0) {
    return "Aun no hay rebuilds guardados para este repositorio.";
  }

  return `${history.length} version${history.length === 1 ? "" : "es"} guardada${history.length === 1 ? "" : "s"} para este repo.`;
}

function renderProjectContextSettings() {
  if (!overlayEls) return;

  const status = overlayState.projectContextStatus || EMPTY_PROJECT_CONTEXT_STATUS;
  const insight = overlayState.projectContextInsight || EMPTY_PROJECT_CONTEXT_INSIGHT;
  const history = Array.isArray(overlayState.projectContextHistory) ? overlayState.projectContextHistory : [];
  const busy = !!overlayState.projectContextBusy;
  const errorMessage = overlayState.projectContextError || "";
  const noticeMessage = overlayState.projectContextMessage || "";
  const insightExtra = [
    insight.summary ? `Resumen: ${insight.summary}` : "",
    insight.mainFilePath ? `Archivo principal: ${insight.mainFilePath}` : "",
    insight.autoAdvice ? `Consejo: ${insight.autoAdvice}` : "",
    insight.screenshotOcrText ? `OCR: ${truncateText(insight.screenshotOcrText, 140)}` : "",
    insight.screenshotSavedPath ? `Screenshot: ${insight.screenshotSavedPath}` : "",
    insight.modelError ? `IA: ${insight.modelError}` : "",
  ].filter(Boolean).join(" | ");

  overlayEls.projectContextStatusText.textContent = errorMessage || noticeMessage || buildProjectContextStatusText();
  overlayEls.projectContextHistoryText.textContent = errorMessage || noticeMessage || buildProjectContextHistoryText();
  if (!errorMessage && !noticeMessage && insightExtra) {
    overlayEls.projectContextStatusText.textContent = `${overlayEls.projectContextStatusText.textContent} | ${truncateText(insightExtra, 360)}`;
  }
  overlayEls.projectContextReadyValue.textContent = status.hasContext ? "Contexto listo" : (status.configured ? "Pendiente" : "Sin datos");
  overlayEls.projectContextVersionValue.textContent = insight.version || status.latestVersion || status.currentVersion || "Sin datos";
  overlayEls.projectContextRequestValue.textContent = status.latestRequestId ? shortenCompactId(status.latestRequestId, 12) : "Sin datos";
  overlayEls.projectContextSnapshotValue.textContent = status.latestSnapshotId ? shortenCompactId(status.latestSnapshotId, 12) : "Sin datos";
  overlayEls.projectContextUpdatedValue.textContent = (insight.updatedAt || status.updatedAt)
    ? formatProjectContextTimestamp(insight.updatedAt || status.updatedAt)
    : "Sin datos";
  overlayEls.projectContextSourceValue.textContent = insight.modelEnabled
    ? `${status.source || insight.source || "Sin datos"}${insight.modelProvider ? ` | ${insight.modelProvider}` : ""}`
    : `${status.source || insight.source || "Sin datos"} | IA OFF`;

  overlayEls.projectContextRefreshBtn.disabled = busy || !getCurrentRepoFullName();
  overlayEls.projectContextHistoryRefreshBtn.disabled = busy || !getCurrentRepoFullName();

  if (!renderKeyChanged(overlayEls.projectContextHistoryList, JSON.stringify([history, busy, getCurrentRepoFullName()]))) {
    return;
  }
  overlayEls.projectContextHistoryList.textContent = "";
  if (history.length === 0) {
    const li = document.createElement("li");
    li.className = "settings-history-item";
    const p = document.createElement("p");
    p.className = "settings-history-empty";
    p.textContent = getCurrentRepoFullName()
      ? "No hay versiones guardadas aun. Usa Refrescar estado para verificar o genera un rebuild."
      : "Abre un repositorio para cargar historial.";
    li.appendChild(p);
    overlayEls.projectContextHistoryList.appendChild(li);
    return;
  }

  const fragment = document.createDocumentFragment();
  history.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = "settings-history-item";

    const top = document.createElement("div");
    top.className = "settings-history-top";

    const left = document.createElement("div");
    const title = document.createElement("p");
    title.className = "settings-history-title";
    title.textContent = item.version || `Version ${history.length - index}`;

    const meta = document.createElement("div");
    meta.className = "settings-history-meta";
    const metaParts = [];
    if (item.status) metaParts.push(item.status);
    if (item.snapshotId) metaParts.push(`Snapshot ${shortenCompactId(item.snapshotId, 12)}`);
    if (item.requestId) metaParts.push(`Request ${shortenCompactId(item.requestId, 12)}`);
    if (item.updatedAt) metaParts.push(formatProjectContextTimestamp(item.updatedAt));
    if (item.source) metaParts.push(item.source);
    meta.textContent = metaParts.length > 0 ? metaParts.join(" | ") : "Version disponible para aplicar rebuild.";

    left.appendChild(title);
    left.appendChild(meta);

    const action = document.createElement("button");
    action.type = "button";
    action.className = "save-button";
    action.textContent = "Aplicar rebuild";
    action.disabled = busy || !item.canRebuild || !getCurrentRepoFullName();
    action.addEventListener("click", async () => {
      await applyProjectContextRebuild(item.requestId);
    });

    top.appendChild(left);
    top.appendChild(action);

    li.appendChild(top);
    if (item.summary) {
      const summary = document.createElement("p");
      summary.className = "settings-note";
      summary.textContent = item.summary;
      li.appendChild(summary);
    }

    fragment.appendChild(li);
  });

  overlayEls.projectContextHistoryList.appendChild(fragment);
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

function startDrag(event) {
  if (!overlayHost || event.button !== 0) return;
  if (event.target.closest("button") || event.target.closest("input") || event.target.closest("select") || event.target.closest("textarea")) {
    return;
  }

  event.preventDefault();
  const rect = overlayHost.getBoundingClientRect();
  const startX = event.clientX;
  const startY = event.clientY;

  function onMove(moveEvent) {
    const deltaX = moveEvent.clientX - startX;
    const deltaY = moveEvent.clientY - startY;
    const bounds = getOverlayViewportBounds();
    const nextLeft = clamp(rect.left + deltaX, bounds.minLeft, bounds.maxLeft);
    const nextTop = clamp(rect.top + deltaY, bounds.minTop, bounds.maxTop);
    placeOverlay(nextLeft, nextTop);
  }

  function onUp() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}
