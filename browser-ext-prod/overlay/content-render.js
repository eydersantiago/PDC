
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

  if (items.length === 0) {
    const li = document.createElement("li");
    li.textContent = "Aun no hay intervenciones registradas.";
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

function renderConnectionGrid(container, items) {
  if (!container) return;

  container.textContent = "";
  const fragment = document.createDocumentFragment();

  for (const item of items) {
    const node = document.createElement("div");
    node.className = `connection-item is-${toText(item.kind) || "idle"}`;

    const label = document.createElement("span");
    label.textContent = toText(item.label);

    const status = document.createElement("strong");
    status.textContent = toText(item.status) || "Sin datos";

    node.appendChild(label);
    node.appendChild(status);
    fragment.appendChild(node);
  }

  container.appendChild(fragment);
}

function syncContextActionButton(button, descriptor, fallbackLabel = "Continuar") {
  if (!button) return;

  if (!descriptor) {
    button.hidden = true;
    button.dataset.contextAction = "";
    button.textContent = fallbackLabel;
    button.disabled = true;
    return;
  }

  button.hidden = false;
  button.dataset.contextAction = toText(descriptor.action);
  button.textContent = toText(descriptor.label) || fallbackLabel;
  button.disabled = !!descriptor.disabled || !toText(descriptor.action);
}

function renderOperationBanner(elements) {
  const title = toText(overlayState.operationTitle);
  const detail = toText(overlayState.operationDetail || overlayState.statusMessage);
  const visible = !!title || (!!overlayState.githubAppBusy && !!detail);
  if (!elements?.banner) return;

  elements.banner.hidden = !visible;
  if (!visible) return;

  elements.banner.classList.toggle("is-error", toText(overlayState.operationKind) === "error");
  elements.title.textContent = title || "Preparando entorno";
  elements.detail.textContent = detail || "ADACEEN esta trabajando.";
}

function renderContextHub(prefix, context, actionModel, flow) {
  if (!overlayEls) return;

  const elements = prefix === "setup"
    ? {
      hub: overlayEls.setupContextHub,
      eyebrow: overlayEls.setupContextEyebrow,
      title: overlayEls.setupContextTitle,
      meta: overlayEls.setupContextMeta,
      chip: overlayEls.setupContextStateChip,
      grid: overlayEls.setupConnectionGrid,
      banner: overlayEls.setupOperationBanner,
      operationTitle: overlayEls.setupOperationTitle,
      operationDetail: overlayEls.setupOperationDetail,
      actionTitle: overlayEls.setupActionTitle,
      actionCopy: overlayEls.setupActionCopy,
      primary: overlayEls.setupPrimaryActionBtn,
      secondary: overlayEls.setupSecondaryActionBtn,
    }
    : {
      hub: overlayEls.contextHubSection,
      eyebrow: overlayEls.contextEyebrow,
      title: overlayEls.contextTitle,
      meta: overlayEls.contextMeta,
      chip: overlayEls.contextStateChip,
      grid: overlayEls.connectionGrid,
      banner: overlayEls.contextOperationBanner,
      operationTitle: overlayEls.contextOperationTitle,
      operationDetail: overlayEls.contextOperationDetail,
      actionTitle: overlayEls.contextActionTitle,
      actionCopy: overlayEls.contextActionCopy,
      primary: overlayEls.contextPrimaryActionBtn,
      secondary: overlayEls.contextSecondaryActionBtn,
    };

  if (!elements.hub) return;

  const info = buildContextModuleInfo(context);
  elements.eyebrow.textContent = info.label;
  elements.title.textContent = info.title;
  elements.meta.textContent = info.meta || "Sin detalle adicional.";
  elements.chip.textContent = info.state;
  elements.chip.className = `state-chip is-${toText(info.kind) || "idle"}`;

  renderConnectionGrid(elements.grid, buildConnectionItems(context, flow));
  renderOperationBanner({
    banner: elements.banner,
    title: elements.operationTitle,
    detail: elements.operationDetail,
  });

  const actionWrap = elements.actionTitle?.closest?.(".next-action") || null;
  if (!actionModel) {
    if (actionWrap) actionWrap.hidden = true;
    return;
  }
  if (actionWrap) actionWrap.hidden = false;

  elements.actionTitle.textContent = toText(actionModel?.title) || "Siguiente paso";
  elements.actionCopy.textContent = toText(actionModel?.copy) || "ADACEEN ajustara la accion segun el contexto detectado.";
  syncContextActionButton(elements.primary, actionModel?.primary, "Continuar");
  syncContextActionButton(elements.secondary, actionModel?.secondary, "Actualizar");
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

function renderAdminUsersTable() {
  if (!overlayEls) return;
  if (!canManageUsersSession()) {
    overlayEls.adminUsersSection.hidden = true;
    return;
  }

  const users = Array.isArray(overlayState.adminUsers) ? overlayState.adminUsers : [];
  const teachers = Array.isArray(overlayState.adminTeachers) ? overlayState.adminTeachers : [];
  const busy = !!overlayState.adminUsersBusy;
  const teacherMode = isTeacherSession();

  overlayEls.adminUsersSection.hidden = false;
  overlayEls.adminUsersStatus.textContent = overlayState.adminUsersMessage
    || (teacherMode
      ? `Gestiona estudiantes asignados a tu cuenta (${users.length}).`
      : `Gestiona estudiantes y profesores (${users.length} usuario${users.length === 1 ? "" : "s"}).`);
  overlayEls.adminReloadUsersBtn.disabled = busy;
  overlayEls.adminCreateBtn.disabled = busy;
  overlayEls.adminCreateRole.disabled = busy || teacherMode;
  if (teacherMode) {
    overlayEls.adminCreateRole.value = "student";
  }

  overlayEls.adminCreateTeacher.disabled = busy || teacherMode || overlayEls.adminCreateRole.value !== "student";
  overlayEls.adminCreateTeacher.innerHTML = "";
  const emptyTeacherOption = document.createElement("option");
  emptyTeacherOption.value = "";
  emptyTeacherOption.textContent = teachers.length > 0
    ? "Asignar profesor (opcional)"
    : "Sin profesores activos";
  overlayEls.adminCreateTeacher.appendChild(emptyTeacherOption);
  for (const teacher of teachers) {
    const option = document.createElement("option");
    option.value = toText(teacher.id);
    option.textContent = `${toText(teacher.displayName)} (${toText(teacher.email)})`;
    overlayEls.adminCreateTeacher.appendChild(option);
  }
  if (teacherMode && teachers[0]?.id) {
    overlayEls.adminCreateTeacher.value = toText(teachers[0].id);
  }
  renderAdminCreateCourseGrid();

  overlayEls.adminUsersTableBody.textContent = "";
  if (users.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.textContent = "No hay usuarios administrables.";
    row.appendChild(cell);
    overlayEls.adminUsersTableBody.appendChild(row);
    return;
  }

  const fragment = document.createDocumentFragment();
  users.forEach((user) => {
    const row = document.createElement("tr");
    const role = toText(user.role).toLowerCase() === "teacher" ? "teacher" : "student";

    const nameCell = document.createElement("td");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = toText(user.displayName);
    nameInput.disabled = busy;
    nameCell.appendChild(nameInput);

    const emailCell = document.createElement("td");
    const emailInput = document.createElement("input");
    emailInput.type = "text";
    emailInput.value = toText(user.email);
    emailInput.disabled = busy;
    emailCell.appendChild(emailInput);

    const roleCell = document.createElement("td");
    const roleSelect = document.createElement("select");
    roleSelect.disabled = busy || teacherMode;
    [
      { value: "student", label: "Estudiante" },
      { value: "teacher", label: "Profesor" },
    ].forEach((item) => {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      if (item.value === role) option.selected = true;
      roleSelect.appendChild(option);
    });
    roleCell.appendChild(roleSelect);

    const teacherCell = document.createElement("td");
    const teacherSelect = document.createElement("select");
    teacherSelect.disabled = busy || teacherMode || roleSelect.value !== "student";
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = "Profesor por defecto";
    teacherSelect.appendChild(emptyOption);
    for (const teacher of teachers) {
      const option = document.createElement("option");
      option.value = toText(teacher.id);
      option.textContent = toText(teacher.displayName);
      if (toText(user.teacherUserId) === option.value) option.selected = true;
      teacherSelect.appendChild(option);
    }
    teacherCell.appendChild(teacherSelect);

    const coursesCell = document.createElement("td");
    coursesCell.className = "admin-course-cell";
    const courseGrid = document.createElement("div");
    courseGrid.className = "course-chip-grid";
    renderCourseCheckboxGroup(courseGrid, user.assignedCourseCodes || ["FPOO"], {
      disabled: busy || roleSelect.value !== "student",
      fallbackToDefault: roleSelect.value === "student",
    });
    coursesCell.appendChild(courseGrid);

    function syncRowStudentControls() {
      teacherSelect.disabled = busy || teacherMode || roleSelect.value !== "student";
      const disabledCourses = busy || roleSelect.value !== "student";
      courseGrid.querySelectorAll("input[type='checkbox']").forEach((input) => {
        input.disabled = disabledCourses;
      });
      if (roleSelect.value !== "student") {
        teacherSelect.value = "";
      } else if (!courseGrid.querySelector("input[type='checkbox']:checked")) {
        const firstCourseInput = courseGrid.querySelector("input[type='checkbox']");
        if (firstCourseInput) firstCourseInput.checked = true;
      }
    }

    roleSelect.addEventListener("change", () => {
      syncRowStudentControls();
    });

    const statusCell = document.createElement("td");
    statusCell.textContent = user.isActive === false ? "Inactivo" : "Activo";

    const actionsCell = document.createElement("td");
    actionsCell.className = "admin-actions-cell";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "ghost-button";
    saveBtn.textContent = "Guardar";
    saveBtn.disabled = busy;

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "save-button";
    deleteBtn.textContent = "Eliminar";
    deleteBtn.disabled = busy || user.isActive === false;

    saveBtn.addEventListener("click", async () => {
      overlayState.adminUsersBusy = true;
      overlayState.adminUsersMessage = `Guardando cambios de ${toText(user.displayName)}...`;
      renderOverlay();
      try {
        const payload = {
          role: roleSelect.value === "teacher" ? "teacher" : "student",
          displayName: nameInput.value.trim(),
          email: emailInput.value.trim(),
          teacherUserId: roleSelect.value === "student"
            ? (teacherMode ? toText(overlayState.session?.user?.id) : toText(teacherSelect.value) || null)
            : null,
          assignedCourseCodes: roleSelect.value === "student" ? getCheckedCourseCodes(courseGrid) : [],
        };
        await updateAdminUserRow(toText(user.id), payload);
        await reloadAdminUsers();
        overlayState.adminUsersMessage = "Usuario actualizado.";
      } catch (error) {
        overlayState.adminUsersMessage = `No se pudo actualizar: ${String(error)}`;
      } finally {
        overlayState.adminUsersBusy = false;
        renderOverlay();
      }
    });

    deleteBtn.addEventListener("click", async () => {
      const confirmed = window.confirm(`Se desactivara el usuario ${toText(user.displayName)}. Deseas continuar?`);
      if (!confirmed) return;
      overlayState.adminUsersBusy = true;
      overlayState.adminUsersMessage = `Desactivando ${toText(user.displayName)}...`;
      renderOverlay();
      try {
        await deleteAdminUser(toText(user.id));
        await reloadAdminUsers();
        overlayState.adminUsersMessage = "Usuario desactivado.";
      } catch (error) {
        overlayState.adminUsersMessage = `No se pudo eliminar: ${String(error)}`;
      } finally {
        overlayState.adminUsersBusy = false;
        renderOverlay();
      }
    });

    actionsCell.appendChild(saveBtn);
    actionsCell.appendChild(deleteBtn);

    row.appendChild(nameCell);
    row.appendChild(emailCell);
    row.appendChild(roleCell);
    row.appendChild(teacherCell);
    row.appendChild(coursesCell);
    row.appendChild(statusCell);
    row.appendChild(actionsCell);
    fragment.appendChild(row);
  });

  overlayEls.adminUsersTableBody.appendChild(fragment);
}

function renderStudentCourseModal() {
  if (!overlayEls?.studentCourseModal) return;
  const visible = !!overlayState.studentCourseModalOpen && overlayState.session?.user?.role === "student";
  overlayEls.studentCourseModal.hidden = !visible;
  if (!visible) return;

  const state = overlayState.studentCourseState || EMPTY_STUDENT_COURSE_STATE;
  const assigned = getStudentAssignedCourseCodes();
  const courses = (Array.isArray(state.courses) && state.courses.length ? state.courses : getRagCourseCatalog())
    .filter((course) => assigned.includes(normalizeRagCourseCodeUi(course?.code)));
  const selected = getSelectedStudentCourseCode();

  overlayEls.studentCourseCopy.textContent = courses.length > 1
    ? "Escoge el curso que quieres practicar ahora; las recomendaciones usaran sus fuentes RAG."
    : "Tu docente asigno este curso para practicar; ADACEEN usara sus fuentes RAG.";
  overlayEls.studentCourseOptions.textContent = "";

  if (!courses.length) {
    const empty = document.createElement("p");
    empty.className = "course-empty";
    empty.textContent = state.busy ? "Cargando cursos asignados..." : "No hay cursos asignados. Se usara FPOO por defecto.";
    overlayEls.studentCourseOptions.appendChild(empty);
  } else {
    const fragment = document.createDocumentFragment();
    for (const course of courses) {
      const code = normalizeRagCourseCodeUi(course?.code);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "student-course-option";
      button.classList.toggle("is-selected", code === selected);
      button.disabled = !!state.busy;
      button.dataset.courseCode = code;
      const title = document.createElement("strong");
      title.textContent = toText(course?.shortName || course?.code || code);
      const copy = document.createElement("span");
      copy.textContent = toText(course?.name || code);
      button.append(title, copy);
      button.addEventListener("click", () => {
        const previous = normalizeRagCourseCodeUi(overlayState.studentCourseState?.selectedCourseCode || "");
        overlayState.studentCourseState = {
          ...(overlayState.studentCourseState || EMPTY_STUDENT_COURSE_STATE),
          selectedCourseCode: code,
          error: "",
          message: "",
        };
        if (previous && previous !== code) {
          overlayState.campusCourseAccess = { ...EMPTY_CAMPUS_COURSE_ACCESS_STATE };
          overlayState.campusAnalysis = null;
        }
        renderOverlay();
      });
      fragment.appendChild(button);
    }
    overlayEls.studentCourseOptions.appendChild(fragment);
  }

  overlayEls.studentCourseStatus.textContent = state.error || state.message || `Curso activo: ${selected}.`;
  const hasEnabledCourses = courses.length > 0;
  overlayEls.studentCourseLogoutBtn.textContent = hasEnabledCourses ? "Cancelar" : "Cerrar sesion";
  overlayEls.studentCourseLogoutBtn.dataset.courseModalAction = hasEnabledCourses ? "cancel" : "logout";
  overlayEls.studentCourseConfirmBtn.disabled = !!state.busy;
  overlayEls.studentCourseLogoutBtn.disabled = !!state.busy;
}

function syncSettingsInputs() {
  if (!overlayEls) return;

  const policy = overlayState.policy || DEFAULT_POLICY;
  overlayEls.teacherEnabled.checked = !!overlayState.assistantEnabled;
  overlayEls.autoConfigEnabled.checked = !!overlayState.autoConfigEnabled;
  overlayEls.backendUrlInput.value = overlayState.backendUrl;
  overlayEls.settingsSessionLabel.value = overlayState.session?.user?.displayName || "Sesion sin iniciar";
  overlayEls.settingsSessionMeta.value = overlayState.session
    ? `${getRoleLabel(overlayState.session.user.role)} | ${overlayState.session.user.email}`
    : "Inicia sesion para activar roles, politicas y telemetria.";
  overlayEls.teacherSettingsBlock.hidden = !isTeacherSession();

  if (!isTeacherSession()) return;

  overlayEls.teacherPolicyName.value = policy.policyName || DEFAULT_POLICY.policyName;
  overlayEls.teacherOutcome.value = policy.outcome || DEFAULT_POLICY.outcome;
  overlayEls.teacherTone.value = policy.tone || DEFAULT_POLICY.tone;
  overlayEls.teacherFrequency.value = policy.frequency || DEFAULT_POLICY.frequency;
  overlayEls.teacherHelpLevel.value = policy.helpLevel || DEFAULT_POLICY.helpLevel;
  overlayEls.teacherMiniQuiz.checked = !!policy.allowMiniQuiz;
  overlayEls.teacherNoSolution.checked = !!policy.strictNoSolution;
  overlayEls.teacherMaxHints.value = policy.maxHintsPerExercise == null ? "" : String(policy.maxHintsPerExercise);
  overlayEls.teacherAllowExplanation.checked = (policy.allowedInterventions || []).includes("explanation");
  overlayEls.teacherAllowHint.checked = (policy.allowedInterventions || []).includes("hint");
  overlayEls.teacherAllowExample.checked = (policy.allowedInterventions || []).includes("example");
  overlayEls.teacherAllowMiniQuizType.checked = (policy.allowedInterventions || []).includes("mini_quiz");
  overlayEls.teacherFallbackMessage.value = policy.fallbackMessage || DEFAULT_POLICY.fallbackMessage;
  overlayEls.teacherCustomInstruction.value = policy.customInstruction || "";
}

function setSettingsOpen(nextValue) {
  overlayState.settingsOpen = !!nextValue;
  if (overlayEls?.window) {
    overlayEls.window.classList.toggle("settings-open", overlayState.settingsOpen);
  }
  scheduleOverlayViewportSync(true);
}

async function saveSettingsFromOverlay() {
  overlayState.assistantEnabled = !!overlayEls.teacherEnabled.checked;
  overlayState.autoConfigEnabled = !!overlayEls.autoConfigEnabled.checked;
  overlayState.backendUrl = normalizeBaseUrl(overlayEls.backendUrlInput.value) || DEFAULT_BACKEND_URL;
  await persistPreferences();

  if (isTeacherSession() && overlayState.sessionId) {
    const allowedInterventions = [
      overlayEls.teacherAllowExplanation.checked ? "explanation" : "",
      overlayEls.teacherAllowHint.checked ? "hint" : "",
      overlayEls.teacherAllowExample.checked ? "example" : "",
      overlayEls.teacherAllowMiniQuizType.checked ? "mini_quiz" : "",
    ].filter(Boolean);

    const nextPolicy = {
      policyName: overlayEls.teacherPolicyName.value.trim() || DEFAULT_POLICY.policyName,
      outcome: overlayEls.teacherOutcome.value,
      tone: overlayEls.teacherTone.value,
      frequency: overlayEls.teacherFrequency.value,
      helpLevel: overlayEls.teacherHelpLevel.value,
      allowMiniQuiz: !!overlayEls.teacherMiniQuiz.checked,
      strictNoSolution: !!overlayEls.teacherNoSolution.checked,
      maxHintsPerExercise: overlayEls.teacherMaxHints.value
        ? Math.max(1, Number(overlayEls.teacherMaxHints.value) || DEFAULT_POLICY.maxHintsPerExercise)
        : null,
      fallbackMessage: overlayEls.teacherFallbackMessage.value.trim() || DEFAULT_POLICY.fallbackMessage,
      customInstruction: overlayEls.teacherCustomInstruction.value.trim(),
      allowedInterventions: allowedInterventions.length > 0
        ? allowedInterventions
        : DEFAULT_POLICY.allowedInterventions,
    };

    try {
      const response = await fetchJsonWithTimeout(`${normalizeBaseUrl(overlayState.backendUrl)}/api/policies/current`, {
        method: "PUT",
        headers: buildApiHeaders(),
        body: JSON.stringify(nextPolicy),
      });
      overlayState.policy = response.policy || overlayState.policy;
      overlayState.telemetry = Array.isArray(response.telemetry) ? response.telemetry : overlayState.telemetry;
      overlayState.statusMessage = "Politica docente guardada.";
    } catch (error) {
      overlayState.statusMessage = `No se pudo guardar la politica: ${String(error)}`;
    }
  } else {
    overlayState.statusMessage = "Preferencias tecnicas guardadas.";
  }

  setSettingsOpen(false);
  renderOverlay();

  if (overlayState.started && hasActiveSession()) {
    await refreshMentorSession();
  }
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
    : overlayState.statusMessage
      || (sectionsUnlocked ? buildMainStatus(context) : "Explora el proyecto para activar pistas y contexto.");
  const showingAuthView = overlayState.started && !hasActiveSession();
  const setupRequired = isGithubOrCodespaceContext(context);
  const showingSetupView = overlayState.started
    && hasActiveSession()
    && !isAdminSession()
    && setupRequired
    && !hasCompletedSetup();
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
  if (typeof renderTeacherBitacoraPage === "function") {
    renderTeacherBitacoraPage();
  }
  if (typeof renderTeacherRagPage === "function") {
    renderTeacherRagPage();
  }
  overlayEls.firstLoginModal.hidden = !showingFirstLoginModal;
  renderStudentCourseModal();
  overlayEls.processNoticeModal.hidden = !showingProcessNoticeModal;
  overlayEls.tabConflictModal.hidden = !showingTabConflictModal;
  if (overlayEls.tabConflictNotice) {
    overlayEls.tabConflictNotice.textContent = activeTabNotice;
  }
  overlayEls.adminUsersSection.hidden = !showingMainView || !canManageUsersSession();
  overlayEls.shell.classList.toggle("shell-expanded", showingMainView);
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
  const showTeacherBitacoraUpload = false;
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

async function startExperience() {
  overlayState.started = true;
  overlayState.authError = "";

  if (!overlayState.session && overlayState.sessionId) {
    try {
      const restored = await fetchCurrentSession();
      if (!restored) {
        overlayState.sessionId = "";
        overlayState.session = null;
        await persistPreferences();
      }
    } catch {
      overlayState.sessionId = "";
      overlayState.session = null;
      await persistPreferences();
    }
  }

  if (hasActiveSession()) {
    const hasForeignActiveTab = await refreshActiveTabStateFromBackend({ force: true })
      .catch(() => false);

    if (hasForeignActiveTab) {
      overlayState.started = false;
      overlayState.loading = false;
      overlayState.analysisUnlocked = false;
      overlayState.analysisWindowOpen = false;
      overlayState.statusMessage = "Esta sesión ya está activa en otra pestaña.";
      renderOverlay();
      return;
    }

    await refreshMentorSession();
    queueActiveTabReport(true);
  } else {
    renderOverlay();
  }
}

async function submitLoginFromOverlay() {
  overlayState.authBusy = true;
  overlayState.authError = "";
  renderOverlay();

  try {
    const email = overlayEls.authEmail.value.trim();
    const password = overlayEls.authPassword.value;
    await loginToBackend(email, password);
    await ensureStudentCourseSelection({ forceOpen: overlayState.session?.user?.role === "student" });
    if (overlayState.studentCourseModalOpen) {
      overlayState.statusMessage = "Escoge el curso activo para cargar sus fuentes RAG.";
      return;
    }
    await refreshMentorSession();
    setWelcomeStatusForCurrentUser();
  } catch (error) {
    overlayState.authError = String(error);
    renderOverlay();
  } finally {
    overlayState.authBusy = false;
    renderOverlay();
  }
}

function setWelcomeStatusForCurrentUser() {
  const user = overlayState.session?.user;
  if (!user) return;

  const context = overlayState.context || buildPayload();
  if (isGithubOrCodespaceContext(context) && !hasCompletedSetup()) {
    overlayState.statusMessage = "";
    return;
  }

  const roleLabel = getRoleLabelLower(user.role);
  overlayState.statusMessage = user.role === "admin"
    ? `Bienvenido ${roleLabel} ${user.displayName}. Gestiona usuarios desde el dashboard; GitHub App y PR se ejecutan manualmente en Configuracion.`
    : `Bienvenido ${roleLabel} ${user.displayName}.`;
}

async function submitGoogleLoginFromOverlay() {
  overlayState.authBusy = true;
  overlayState.authError = "";
  renderOverlay();

  try {
    await loginToBackendWithGoogle();
    await ensureStudentCourseSelection({ forceOpen: overlayState.session?.user?.role === "student" });
    if (overlayState.studentCourseModalOpen) {
      overlayState.statusMessage = "Escoge el curso activo para cargar sus fuentes RAG.";
      return;
    }
    await refreshMentorSession();
    setWelcomeStatusForCurrentUser();
  } catch (error) {
    overlayState.authError = String(error);
    renderOverlay();
  } finally {
    overlayState.authBusy = false;
    renderOverlay();
  }
}

async function logoutAndReturnToLogin() {
  await logoutFromBackend();
  overlayState.started = true;
  overlayState.ideas = [];
  overlayState.guide = [];
  overlayState.analysisUnlocked = false;
  overlayState.analysisWindowOpen = false;
  overlayState.projectAnalysis = null;
  overlayState.campusAnalysis = null;
  overlayState.setupRepoFullName = "";
  overlayState.setupWizardStep = 1;
  overlayState.githubAppBusy = false;
  overlayState.githubAppStatus = { ...EMPTY_GITHUB_APP_STATUS };
  overlayState.githubUserStatus = { ...EMPTY_GITHUB_USER_STATUS };
  overlayState.processNoticeOpen = false;
  overlayState.projectContextBusy = false;
  overlayState.projectContextStatus = { ...EMPTY_PROJECT_CONTEXT_STATUS };
  overlayState.projectContextHistory = [];
  overlayState.projectContextInsight = { ...EMPTY_PROJECT_CONTEXT_INSIGHT };
  overlayState.documentClassifications = { ...EMPTY_DOCUMENT_CLASSIFICATION_STATE };
  overlayState.teacherBitacoraPageOpen = false;
  overlayState.teacherBitacoraStatus = { ...EMPTY_TEACHER_BITACORA_STATUS };
  overlayState.teacherRagPageOpen = false;
  overlayState.teacherRagState = { ...EMPTY_TEACHER_RAG_STATE };
  overlayState.campusCourseAccess = { ...EMPTY_CAMPUS_COURSE_ACCESS_STATE };
  overlayState.ragCourseCatalog = [];
  overlayState.ragDefaultCourseCode = "FPOO";
  overlayState.studentCourseModalOpen = false;
  overlayState.studentCourseState = { ...EMPTY_STUDENT_COURSE_STATE };
  overlayState.projectContextMessage = "";
  overlayState.projectContextError = "";
  overlayState.adminUsers = [];
  overlayState.adminTeachers = [];
  overlayState.adminUsersBusy = false;
  overlayState.adminUsersMessage = "";
  overlayState.operationTitle = "";
  overlayState.operationDetail = "";
  overlayState.operationKind = "busy";
  overlayState.statusMessage = "Sesion cerrada.";
  renderOverlay();
}
