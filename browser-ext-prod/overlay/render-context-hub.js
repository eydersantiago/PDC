// ADACEEN | Capa 4 - UI: hub de contexto: modulo detectado, conexiones, banner de operacion y accion recomendada.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

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
