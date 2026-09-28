// ADACEEN | Capa 4 - UI: integracion con el editor (VS Code / vscode.dev): paleta en linea junto al cursor,
// espera de la sugerencia, opciones de reemplazo y panel flotante de sincronizacion.
// Movido sin cambios desde content-render.js (render y anclaje de la paleta) y desde content-lifecycle.js
// (sondeo, posicion y arrastre del panel y listeners, ahora en bindVscodeSyncPanel).
// Sin "use strict": el codigo viene de archivos en modo no estricto y se conserva igual.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

const VSCODE_SUGGESTION_FALLBACK_DELAY_MS = 120000;

let vscodeSuggestionFallbackTimer = 0;

function normalizedTextForCompare(value) {
  return toText(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function clearVscodeSuggestionFallbackTimer() {
  if (!vscodeSuggestionFallbackTimer) return;
  window.clearTimeout(vscodeSuggestionFallbackTimer);
  vscodeSuggestionFallbackTimer = 0;
}

function scheduleVscodeSuggestionFallbackRender(remainingMs) {
  if (vscodeSuggestionFallbackTimer) return;
  const delay = Math.max(250, Number(remainingMs) || 0);
  vscodeSuggestionFallbackTimer = window.setTimeout(() => {
    vscodeSuggestionFallbackTimer = 0;
    renderOverlay();
  }, delay);
}

function resetVscodeSuggestionWait(state) {
  if (state) {
    state.suggestionWaitKey = "";
    state.suggestionWaitStartedAt = 0;
  }
  clearVscodeSuggestionFallbackTimer();
}

function buildVscodeSuggestionWaitKey(state, rack, filePath, rawSuggestion) {
  return [
    state?.connected ? "connected" : "waiting",
    toText(filePath),
    toText(rack?.id),
    toText(rack?.repoFullName),
    normalizedTextForCompare(rawSuggestion),
  ].join("|");
}

function resolveVscodeSuggestionDisplay(state, rack, filePath, fileSummary, rawSuggestion, options = []) {
  const hasDistinctSuggestion = rawSuggestion
    && normalizedTextForCompare(rawSuggestion) !== normalizedTextForCompare(fileSummary);
  if (hasDistinctSuggestion) {
    resetVscodeSuggestionWait(state);
    return { text: rawSuggestion, loading: false, fallbackVisible: false, source: "suggestion" };
  }

  const summaryText = toText(fileSummary);
  if (summaryText && !/^Aun no hay resumen/i.test(summaryText)) {
    resetVscodeSuggestionWait(state);
    return { text: summaryText, loading: false, fallbackVisible: false, source: "summary" };
  }

  const waitKey = buildVscodeSuggestionWaitKey(state, rack, filePath, rawSuggestion);
  const now = Date.now();
  if (state.suggestionWaitKey !== waitKey || !Number(state.suggestionWaitStartedAt)) {
    state.suggestionWaitKey = waitKey;
    state.suggestionWaitStartedAt = now;
    clearVscodeSuggestionFallbackTimer();
  }

  const elapsedMs = now - Number(state.suggestionWaitStartedAt || now);
  const remainingMs = VSCODE_SUGGESTION_FALLBACK_DELAY_MS - elapsedMs;
  if (remainingMs > 0) {
    scheduleVscodeSuggestionFallbackRender(remainingMs);
    return {
      text: state.connected ? "Cargando sugerencia de linea" : "Cargando contexto de VS Code",
      loading: true,
      fallbackVisible: false,
      source: "loading",
    };
  }

  clearVscodeSuggestionFallbackTimer();
  return {
    text: state.connected
      ? "Aun no hay una sugerencia distinta para la linea activa. Mueve el cursor, selecciona un bloque o refresca desde VS Code."
      : "Esperando sugerencia de la extension VS Code.",
    loading: false,
    fallbackVisible: true,
    source: "fallback",
  };
}

function isVscodeDeleteReplacementOption(option) {
  const metadata = option?.metadata && typeof option.metadata === "object" ? option.metadata : {};
  return /\b(delete|remove|eliminar|borrar)\b/i.test([
    option?.actionType,
    option?.id,
    option?.label,
    metadata.applyMode,
  ].map(toText).join(" "));
}

function vscodeReplacementMode(option) {
  if (isVscodeDeleteReplacementOption(option)) return "delete";
  const metadata = option?.metadata && typeof option.metadata === "object" ? option.metadata : {};
  const probe = [
    option?.actionType,
    option?.id,
    option?.label,
    metadata.applyMode,
  ].map(toText).join(" ").toLowerCase();
  if (/\b(insert|add|completar|insertar)\b/.test(probe)) return "insert";
  return "replace";
}

function vscodeReplacementActionLabel(option) {
  const mode = vscodeReplacementMode(option);
  if (mode === "delete") return "Eliminar";
  if (mode === "insert") return "Agregar";
  return "Modificar";
}

function vscodeReplacementTargetLabel(rack, options) {
  const option = options.find(Boolean) || {};
  const metadata = option.metadata && typeof option.metadata === "object" ? option.metadata : {};
  const line = firstPositiveNumber(metadata.line, metadata.cursorLine, metadata.selectionStartLine);
  const column = firstPositiveNumber(metadata.column, metadata.cursorColumn);
  const parts = [];
  if (line) parts.push(`Linea ${line}`);
  if (column) parts.push(`col ${column}`);
  return parts.join(", ") || (rack.activeFilePath ? "Cursor del editor" : "Editor activo");
}

function rectHasVisibleArea(rect) {
  return !!rect
    && Number.isFinite(rect.top)
    && Number.isFinite(rect.left)
    && rect.bottom >= 0
    && rect.right >= 0
    && rect.top <= window.innerHeight
    && rect.left <= window.innerWidth
    && (rect.width > 0 || rect.height > 0);
}

function pointRectFromRect(rect, xOffset = 0) {
  const left = Number(rect.left) + xOffset;
  return {
    left,
    right: left + 1,
    top: Number(rect.top),
    bottom: Number(rect.bottom),
    width: 1,
    height: Math.max(1, Number(rect.height) || 1),
  };
}

function nodeIsInsideAdaceenOverlay(node) {
  if (!node) return false;
  const root = typeof node.getRootNode === "function" ? node.getRootNode() : null;
  if (root && root === overlayRoot) return true;
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return !!(element && overlayHost && overlayHost.contains(element));
}

function selectionAnchorRect() {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount <= 0 || selection.isCollapsed) return null;

  const range = selection.getRangeAt(0);
  if (nodeIsInsideAdaceenOverlay(range.commonAncestorContainer)) return null;

  const rects = Array.from(range.getClientRects()).filter(rectHasVisibleArea);
  const rect = rects[0] || range.getBoundingClientRect();
  return rectHasVisibleArea(rect) ? rect : null;
}

function visibleRectFromSelectors(selectors, asPoint = true) {
  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll(selector));
    for (const node of nodes) {
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
      const rect = node.getBoundingClientRect();
      if (!rectHasVisibleArea(rect)) continue;
      return asPoint ? pointRectFromRect(rect, Math.min(Math.max(rect.width / 2, 0), 40)) : rect;
    }
  }
  return null;
}

function metadataLineAnchorRect(options) {
  const option = options.find(Boolean) || {};
  const metadata = option.metadata && typeof option.metadata === "object" ? option.metadata : {};
  const line = firstPositiveNumber(metadata.line, metadata.cursorLine, metadata.selectionStartLine);
  if (!line) return null;

  const selectors = [
    `td.blob-code[data-line-number="${line}"]`,
    `td.js-file-line[data-line-number="${line}"]`,
    `td.blob-num[data-line-number="${line}"] + td`,
    `[data-line-number="${line}"]`,
  ];
  return visibleRectFromSelectors(selectors, false);
}

function editorAnchorRect(options) {
  return selectionAnchorRect()
    || visibleRectFromSelectors([
      ".monaco-editor.focused .cursors-layer .cursor",
      ".monaco-editor .cursors-layer .cursor",
      ".monaco-editor.focused .cursor",
      ".monaco-editor .cursor",
    ])
    || metadataLineAnchorRect(options)
    || visibleRectFromSelectors([
      ".monaco-editor.focused .view-overlays .current-line",
      ".monaco-editor .view-overlays .current-line",
      ".monaco-editor.focused .view-lines",
      ".monaco-editor .view-lines",
      "table.js-file-line-container",
      "pre code",
    ]);
}

function placeVscodeInlinePalette(palette, anchorRect) {
  const rect = anchorRect || { left: 18, right: 19, top: 120, bottom: 160, width: 1, height: 40 };
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
  const paletteWidth = Math.min(340, Math.max(280, palette.offsetWidth || 320));
  const paletteHeight = Math.max(120, palette.offsetHeight || 180);
  const gap = 12;
  const margin = 12;

  let left = rect.right + gap;
  let placement = "right";
  if (left + paletteWidth > viewportWidth - margin) {
    left = rect.left - paletteWidth - gap;
    placement = "left";
  }
  if (left < margin) {
    left = Math.min(Math.max(margin, rect.left), Math.max(margin, viewportWidth - paletteWidth - margin));
    placement = "right";
  }

  let top = Math.max(margin, rect.top - 8);
  if (top + paletteHeight > viewportHeight - margin) {
    top = Math.max(margin, viewportHeight - paletteHeight - margin);
  }

  palette.style.left = `${Math.round(left)}px`;
  palette.style.top = `${Math.round(top)}px`;
  palette.classList.toggle("is-left", placement === "left");
}

function hideVscodeInlinePalette() {
  if (overlayEls?.vscodeInlinePalette) {
    overlayEls.vscodeInlinePalette.hidden = true;
  }
}

function vscodeInlineFallbackComment(context, suggestionText) {
  const language = toText(context.languageHint).toLowerCase();
  const filePath = toText(context.filePath).toLowerCase();
  const cleanSuggestion = truncateText(
    toText(suggestionText || "Revisar este bloque seleccionado con ADACEEN").replace(/\s+/g, " "),
    120,
  );
  if (language.includes("xml") || language.includes("html") || /\.(xml|html?)$/i.test(filePath)) {
    return `<!-- TODO: ${cleanSuggestion} -->`;
  }
  if (language.includes("css") || /\.(css|scss)$/i.test(filePath)) {
    return `/* TODO: ${cleanSuggestion} */`;
  }
  if (language.includes("python") || /\.py$/i.test(filePath)) {
    return `# TODO: ${cleanSuggestion}`;
  }
  return `// TODO: ${cleanSuggestion}`;
}

function inferVscodeInlineAgentMode(sourceText) {
  if (typeof inferVscodeReplacementModeFromText === "function") {
    return inferVscodeReplacementModeFromText(sourceText, "insert");
  }
  const probe = toText(sourceText)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (/\b(elimina|eliminar|borra|borrar|quita|quitar|delete|remove)\b/.test(probe)) return "delete";
  if (/\b(modifica|modificar|reemplaza|reemplazar|cambia|cambiar|actualiza|actualizar|replace|update|fix)\b/.test(probe)) return "replace";
  return "insert";
}

function buildVscodeInlineAgentOption(context, suggestionDisplay, rack) {
  const filePath = toText(context.filePath || rack?.activeFilePath);
  const selectionText = toText(context.selection);
  const sourceText = toText(suggestionDisplay?.source === "suggestion" ? suggestionDisplay.text : rack?.activeSuggestion);
  if (!filePath || !selectionText.trim() || !sourceText.trim() || suggestionDisplay?.loading || suggestionDisplay?.fallbackVisible) {
    return null;
  }

  const mode = inferVscodeInlineAgentMode(sourceText);
  const generatedText = typeof buildVscodeFallbackReplacementText === "function"
    ? buildVscodeFallbackReplacementText(
      { ...(rack || {}), activeCodeSnippet: selectionText, activeFilePath: filePath },
      context,
      sourceText,
    )
    : vscodeInlineFallbackComment(context, sourceText);
  const originalText = selectionText;
  const replacementText = mode === "delete"
    ? ""
    : mode === "replace" && !(typeof extractFirstVscodeCodeFence === "function" && extractFirstVscodeCodeFence(sourceText).trim())
      ? `${selectionText.replace(/\s+$/g, "")}\n${generatedText}`
      : generatedText;
  const labels = {
    insert: "Agregar codigo",
    replace: "Modificar codigo",
    delete: "Eliminar codigo",
  };
  const actionTypes = {
    insert: "insert_after_line",
    replace: "replace_selection",
    delete: "delete_selection",
  };

  return {
    id: `inline-agent-${mode}`,
    label: labels[mode],
    description: `ADACEEN decidio ${labels[mode].toLowerCase()} segun la sugerencia cargada.`,
    filePath,
    actionType: actionTypes[mode],
    originalText,
    replacementText,
    metadata: {
      applyMode: mode,
      generatedBy: "browser_inline_palette_agent_decision",
      source: "browser_overlay",
      selectionVisible: true,
      waitingForVscodeRack: !Array.isArray(rack?.replacementOptions) || rack.replacementOptions.length === 0,
    },
  };
}

function renderVscodeInlinePalette(context, showingMainView, suggestionDisplay) {
  if (!overlayEls?.vscodeInlinePalette) return;

  const state = overlayState.vscodeSyncState || EMPTY_VSCODE_SYNC_STATE;
  const rawRack = state.latestRack || {};
  const rack = typeof buildContextScopedVscodeRack === "function"
    ? buildContextScopedVscodeRack(rawRack, context)
    : rawRack;
  const options = typeof resolveVscodeReplacementOptions === "function"
    ? resolveVscodeReplacementOptions(rawRack, context)
    : Array.isArray(rack.replacementOptions) ? rack.replacementOptions : [];
  const agentOption = buildVscodeInlineAgentOption(context, suggestionDisplay, rack);
  const visibleOptions = options.length ? options.slice(0, 1) : (agentOption ? [agentOption] : []);
  const visible = showingMainView
    && context.pageType === "codespace"
    && !isAdminSession()
    && (state.connected || !!agentOption)
    && visibleOptions.length > 0;

  if (!visible) {
    hideVscodeInlinePalette();
    return;
  }

  const anchorRect = editorAnchorRect(visibleOptions);
  if (!anchorRect) {
    hideVscodeInlinePalette();
    return;
  }

  if (state && state !== EMPTY_VSCODE_SYNC_STATE) {
    state.resolvedReplacementOptions = visibleOptions;
  }
  const filePath = toText(rack.activeFilePath || context.filePath);
  const fileName = filePath.split(/[\\/]/).filter(Boolean).pop() || filePath || "archivo activo";
  overlayEls.vscodeInlineStatus.textContent = agentOption && !options.length
    ? "ADACEEN decidio una accion"
    : "ADACEEN sobre el codigo";
  overlayEls.vscodeInlineTarget.textContent = options.length
    ? vscodeReplacementTargetLabel(rack, visibleOptions)
    : "Seleccion visible";
  overlayEls.vscodeInlineFile.textContent = fileName;
  overlayEls.vscodeInlineSuggestion.textContent = truncateText(
    toText(suggestionDisplay?.text || rack.activeSuggestion || "Elige una accion para el codigo seleccionado."),
    260,
  );
  const actionsKey = JSON.stringify([
    !!state.busy,
    visibleOptions.slice(0, 1).map((option) => [
      vscodeReplacementMode(option),
      toText(option.label),
      toText(option.description),
      toText(option.replacementText).length,
    ]),
  ]);
  if (!renderKeyChanged(overlayEls.vscodeInlineActions, actionsKey)) {
    overlayEls.vscodeInlinePalette.hidden = false;
    placeVscodeInlinePalette(overlayEls.vscodeInlinePalette, anchorRect);
    return;
  }
  overlayEls.vscodeInlineActions.textContent = "";

  const fragment = document.createDocumentFragment();
  visibleOptions.slice(0, 1).forEach((option, index) => {
    const mode = vscodeReplacementMode(option);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vscode-inline-action";
    button.textContent = vscodeReplacementActionLabel(option);
    button.title = toText(option.description || option.label);
    button.disabled = !!state.busy || (typeof hasUsableVscodeReplacementOption === "function"
      ? !hasUsableVscodeReplacementOption(option)
      : (mode !== "delete" && !toText(option.replacementText)));
    button.setAttribute("data-mode", mode);
    button.setAttribute("data-vscode-inline-replacement-index", String(index));
    fragment.appendChild(button);
  });

  overlayEls.vscodeInlineActions.appendChild(fragment);
  overlayEls.vscodeInlinePalette.hidden = false;
  placeVscodeInlinePalette(overlayEls.vscodeInlinePalette, anchorRect);
}

function repositionVscodeInlinePalette() {
  if (!overlayEls?.vscodeInlinePalette || overlayEls.vscodeInlinePalette.hidden) return;
  const rawRack = overlayState.vscodeSyncState?.latestRack || {};
  const context = overlayState.context || buildPayload();
  const rack = typeof buildContextScopedVscodeRack === "function"
    ? buildContextScopedVscodeRack(rawRack, context)
    : rawRack;
  const resolvedOptions = Array.isArray(overlayState.vscodeSyncState?.resolvedReplacementOptions)
    ? overlayState.vscodeSyncState.resolvedReplacementOptions
    : [];
  const options = resolvedOptions.length
    ? resolvedOptions
    : typeof resolveVscodeReplacementOptions === "function"
      ? resolveVscodeReplacementOptions(rawRack, context)
      : Array.isArray(rack.replacementOptions) ? rack.replacementOptions : [];
  const anchorRect = editorAnchorRect(options);
  if (!anchorRect) {
    hideVscodeInlinePalette();
    return;
  }
  placeVscodeInlinePalette(overlayEls.vscodeInlinePalette, anchorRect);
}

function renderVscodeSyncPanel(context, showingMainView) {
  if (!overlayEls?.vscodeSyncSection) {
    hideVscodeInlinePalette();
    return;
  }

  // En «Agenda» (0.7.17) la tarjeta del codigo no aporta y, como sigue al puntero, tapaba las
  // sugerencias y el boton para agregarlas: se oculta mientras esa pestana esta abierta.
  const visible = showingMainView && context.pageType === "codespace" && !isAdminSession() && overlayState.mainTab !== "agenda";
  overlayEls.vscodeSyncSection.hidden = !visible;
  if (!visible) {
    resetVscodeSuggestionWait(overlayState.vscodeSyncState);
    if (typeof resetVscodeSyncOverlayPlacement === "function") {
      resetVscodeSyncOverlayPlacement();
    }
    hideVscodeInlinePalette();
    return;
  }

  const state = overlayState.vscodeSyncState || EMPTY_VSCODE_SYNC_STATE;
  const rawRack = state.latestRack || {};
  const rack = typeof buildContextScopedVscodeRack === "function"
    ? buildContextScopedVscodeRack(rawRack, context)
    : rawRack;
  const rackContextMismatch = typeof isVscodeRackForDifferentFile === "function"
    ? isVscodeRackForDifferentFile(rawRack, context)
    : false;
  const options = typeof resolveVscodeReplacementOptions === "function"
    ? resolveVscodeReplacementOptions(rawRack, context)
    : Array.isArray(rack.replacementOptions) ? rack.replacementOptions : [];
  if (state && state !== EMPTY_VSCODE_SYNC_STATE) {
    state.resolvedReplacementOptions = options;
  }
  const filePath = toText(rack.activeFilePath || context.filePath);
  const fileName = filePath.split(/[\\/]/).filter(Boolean).pop() || filePath || "Sin archivo activo";
  const updatedAt = toText(rack.updatedAt || rack.generatedAt || state.updatedAt);
  const updatedLabel = updatedAt ? formatProjectContextTimestamp(updatedAt) : "";
  // Solo la deteccion del tutor: las fuentes y la politica van en sus paneles (0.7.14).
  const mentorSummary = parseTutorSummary(overlayState.mentorSummary).headline;
  const insight = overlayState.projectContextInsight || EMPTY_PROJECT_CONTEXT_INSIGHT;
  const contextStatus = overlayState.projectContextStatus || EMPTY_PROJECT_CONTEXT_STATUS;
  const fileSummary = mentorSummary
    || toText(insight.summary)
    || toText(contextStatus.summary)
    || toText(rack.activeCodeSnippet)
    || "Aun no hay resumen del archivo activo.";
  const statusText = state.busy
    ? "Sincronizando con VS Code..."
    : state.connected && state.fresh
      ? "VS Code conectado"
      : state.connected
        ? "VS Code sin actividad reciente"
        : "VS Code aun no publico contexto";
  const metaParts = [
    filePath ? `Archivo: ${filePath}` : "",
    rackContextMismatch && rawRack.activeFilePath ? `Rack anterior: ${rawRack.activeFilePath}` : "",
    rack.source ? `Fuente: ${rack.source}` : "",
    updatedLabel ? `Actualizado: ${updatedLabel}` : "",
    state.error ? `Error: ${state.error}` : "",
    rackContextMismatch ? "Contexto VS Code desactualizado; usando seleccion visible del navegador." : "",
    state.message && !state.error && !rackContextMismatch ? state.message : "",
  ].filter(Boolean);

  overlayEls.vscodeSyncStatus.textContent = statusText;
  overlayEls.vscodeSyncMeta.textContent = metaParts.join(" | ")
    || (isTunnelEditorPage(context)
      ? "Abre un archivo en tu editor: la extension ADACEEN de VS Code se conecta sola."
      : "Abre el archivo en Codespaces y ejecuta ADACEEN en VS Code.");
  // En vscode.dev (tunel) la VM ya escribio la sesion de VS Code: con VS Code conectado el
  // codigo para VS Code no hace falta y el boton no se muestra.
  overlayEls.vscodeCopySessionBtn.hidden = isTunnelEditorPage(context) && !!state.connected && !!state.fresh;
  overlayEls.vscodeCopySessionBtn.disabled = !!state.busy || !overlayState.sessionId;
  overlayEls.vscodeSyncRefreshBtn.disabled = !!state.busy || overlayState.loading || overlayState.analysisBusy;
  if (overlayEls.vscodeFileTitle) {
    overlayEls.vscodeFileTitle.textContent = fileName;
  }
  if (overlayEls.vscodeFileSummary) {
    overlayEls.vscodeFileSummary.textContent = truncateText(fileSummary, 420);
  }

  const rawSuggestion = toText(rack.activeSuggestion);
  const suggestionDisplay = resolveVscodeSuggestionDisplay(state, rack, filePath, fileSummary, rawSuggestion, options);
  overlayEls.vscodeSuggestionText.textContent = truncateText(suggestionDisplay.text, 900);
  overlayEls.vscodeSuggestionText.classList.toggle("is-loading", suggestionDisplay.loading);
  overlayEls.vscodeSuggestionText.setAttribute("aria-busy", suggestionDisplay.loading ? "true" : "false");

  overlayEls.vscodeReplacementList.textContent = "";
  overlayEls.vscodeReplacementList.hidden = true;
  if (!state.connected) {
    hideVscodeInlinePalette();
    if (typeof positionVscodeSyncOverlay === "function") {
      positionVscodeSyncOverlay();
    }
    return;
  }

  if (!options.length) {
    hideVscodeInlinePalette();
    if (typeof positionVscodeSyncOverlay === "function") {
      positionVscodeSyncOverlay();
    }
    return;
  }
  if (typeof positionVscodeSyncOverlay === "function") {
    positionVscodeSyncOverlay();
  }
  renderVscodeInlinePalette(context, showingMainView, suggestionDisplay);
}

const VSCODE_SYNC_POLL_INTERVAL_MS = 5000;

const VSCODE_SYNC_CURSOR_OFFSET_PX = 18;

let vscodeSyncPollTimer = 0;

let vscodeInlinePaletteRaf = 0;

let vscodeInlinePaletteListenersBound = false;

let vscodeSyncOverlayUserPlaced = false;

let lastPointerPosition = null;

function scheduleVscodeInlinePaletteReposition() {
  if (vscodeInlinePaletteRaf) return;
  vscodeInlinePaletteRaf = window.requestAnimationFrame(() => {
    vscodeInlinePaletteRaf = 0;
    if (typeof repositionVscodeInlinePalette === "function") {
      repositionVscodeInlinePalette();
    }
  });
}

function bindVscodeInlinePaletteListeners() {
  if (vscodeInlinePaletteListenersBound) return;
  vscodeInlinePaletteListenersBound = true;
  window.addEventListener("pointermove", (event) => {
    lastPointerPosition = { x: event.clientX, y: event.clientY };
  }, { capture: true, passive: true });
  document.addEventListener("selectionchange", scheduleVscodeInlinePaletteReposition, true);
  window.addEventListener("scroll", scheduleVscodeInlinePaletteReposition, { capture: true, passive: true });
  window.addEventListener("resize", scheduleVscodeInlinePaletteReposition, { passive: true });
  window.addEventListener("keyup", scheduleVscodeInlinePaletteReposition, true);
  window.addEventListener("pointerup", scheduleVscodeInlinePaletteReposition, true);
}

function clearVscodeSyncPolling() {
  if (!vscodeSyncPollTimer) return;
  window.clearInterval(vscodeSyncPollTimer);
  vscodeSyncPollTimer = 0;
}

function startVscodeSyncPolling() {
  if (vscodeSyncPollTimer) return;
  vscodeSyncPollTimer = window.setInterval(async () => {
    if (!overlayHost?.isConnected || document.visibilityState === "hidden") return;
    const context = buildPayload();
    if (!hasActiveSession() || context.pageType !== "codespace" || isAdminSession()) return;
    overlayState.context = context;
    if (typeof refreshVscodeSyncState !== "function") return;
    await refreshVscodeSyncState({ silent: true }).catch(() => {});
    renderOverlay();
    queueTabSessionSave();
  }, VSCODE_SYNC_POLL_INTERVAL_MS);
}

async function sendVscodeReplacementOptionByIndex(index, requestedFrom) {
  const rack = overlayState.vscodeSyncState?.latestRack || {};
  const context = overlayState.context || buildPayload();
  const options = Array.isArray(overlayState.vscodeSyncState?.resolvedReplacementOptions)
    ? overlayState.vscodeSyncState.resolvedReplacementOptions
    : typeof resolveVscodeReplacementOptions === "function"
      ? resolveVscodeReplacementOptions(rack, context)
      : rack.replacementOptions || [];
  const option = options[index];
  if (!option || typeof queueVscodeReplacementOption !== "function") return;
  try {
    await queueVscodeReplacementOption(option, { requestedFrom });
  } catch (error) {
    overlayState.statusMessage = `No se pudo enviar el reemplazo: ${String(error)}`;
    renderOverlay();
  }
}

function resetVscodeSyncOverlayPlacement() {
  vscodeSyncOverlayUserPlaced = false;
}

function syncVscodeSyncOverlayToViewport() {
  const element = overlayEls?.vscodeSyncSection;
  if (!element || element.hidden) return;
  if (vscodeSyncOverlayUserPlaced) {
    const rect = element.getBoundingClientRect();
    placeFloatingOverlay(element, rect.left, rect.top);
    return;
  }
  positionVscodeSyncOverlay();
}

function positionVscodeSyncOverlay(options = {}) {
  const element = overlayEls?.vscodeSyncSection;
  if (!element || element.hidden) return;
  if (vscodeSyncOverlayUserPlaced && options.force !== true) return;

  const { width, height, offsetLeft, offsetTop } = getViewportMetrics();
  const fallbackPoint = {
    x: offsetLeft + width - 560,
    y: offsetTop + 110,
  };
  const point = lastPointerPosition || fallbackPoint;
  const rect = element.getBoundingClientRect();
  const gap = VSCODE_SYNC_CURSOR_OFFSET_PX;
  let left = point.x + gap;
  let top = point.y + gap;

  if (left + rect.width > offsetLeft + width - OVERLAY_MARGIN) {
    left = point.x - rect.width - gap;
  }
  if (top + rect.height > offsetTop + height - OVERLAY_MARGIN) {
    top = point.y - rect.height - gap;
  }

  placeFloatingOverlay(element, left, top);
}

function startVscodeSyncOverlayDrag(event) {
  const target = event.currentTarget;
  const element = overlayEls?.vscodeSyncSection;
  if (!element || element.hidden || event.button !== 0) return;
  if (event.target?.closest?.("button,input,select,textarea,a")) return;

  event.preventDefault();
  const rect = element.getBoundingClientRect();
  const startX = event.clientX;
  const startY = event.clientY;
  element.classList.add("is-dragging");

  function onMove(moveEvent) {
    moveEvent.preventDefault();
    vscodeSyncOverlayUserPlaced = true;
    placeFloatingOverlay(element, rect.left + moveEvent.clientX - startX, rect.top + moveEvent.clientY - startY);
  }

  function onUp() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    element.classList.remove("is-dragging");
    try {
      target?.releasePointerCapture?.(event.pointerId);
    } catch {}
  }

  try {
    target?.setPointerCapture?.(event.pointerId);
  } catch {}
  window.addEventListener("pointermove", onMove, { passive: false });
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

// Listeners del panel de sincronizacion y de la paleta (antes dentro de ensureOverlay, en el mismo orden).
function bindVscodeSyncPanel() {
  overlayEls.vscodeSyncRefreshBtn?.addEventListener("click", async () => {
    if (typeof refreshVscodeSyncState !== "function") return;
    await refreshVscodeSyncState({ silent: false });
  });
  overlayEls.vscodeCopySessionBtn?.addEventListener("click", async () => {
    await copyEditorPairingCodeForVscode();
  });
  overlayEls.vscodeReplacementList?.addEventListener("click", async (event) => {
    const button = event.target?.closest?.("[data-vscode-replacement-index]");
    if (!button) return;
    const index = Number(button.getAttribute("data-vscode-replacement-index"));
    await sendVscodeReplacementOptionByIndex(index, "overlay_button");
  });
  overlayEls.vscodeInlineActions?.addEventListener("click", async (event) => {
    const button = event.target?.closest?.("[data-vscode-inline-replacement-index]");
    if (!button) return;
    const index = Number(button.getAttribute("data-vscode-inline-replacement-index"));
    await sendVscodeReplacementOptionByIndex(index, "inline_code_palette");
  });
  overlayEls.vscodeSyncDragHandle?.addEventListener("pointerdown", startVscodeSyncOverlayDrag);
}
