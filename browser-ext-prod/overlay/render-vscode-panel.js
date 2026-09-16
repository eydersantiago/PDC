// ADACEEN | Capa 4 - UI: panel y paleta flotante de VS Code dentro del Codespace.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const VSCODE_SUGGESTION_FALLBACK_DELAY_MS = 120000;
let vscodeSuggestionFallbackTimer = 0;

/**
 * Devuelve siempre un objeto propio de overlayState sobre el que se puede escribir.
 * Nunca la constante EMPTY_VSCODE_SYNC_STATE, que es la plantilla compartida.
 */
function getMutableVscodeSyncState() {
  if (!overlayState.vscodeSyncState || typeof overlayState.vscodeSyncState !== "object") {
    overlayState.vscodeSyncState = { ...EMPTY_VSCODE_SYNC_STATE };
  }
  return overlayState.vscodeSyncState;
}

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

function vscodeReplacementActionLabel(option) {
  const mode = vscodeReplacementModeFromOption(option);
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

function buildVscodeInlineAgentOption(context, suggestionDisplay, rack) {
  const filePath = toText(context.filePath || rack?.activeFilePath);
  const selectionText = toText(context.selection);
  const sourceText = toText(suggestionDisplay?.source === "suggestion" ? suggestionDisplay.text : rack?.activeSuggestion);
  if (!filePath || !selectionText.trim() || !sourceText.trim() || suggestionDisplay?.loading || suggestionDisplay?.fallbackVisible) {
    return null;
  }

  const mode = inferVscodeReplacementModeFromText(sourceText, "insert");
  const generatedText = buildVscodeFallbackReplacementText(
    { ...(rack || {}), activeCodeSnippet: selectionText, activeFilePath: filePath },
    context,
    sourceText,
  );
  const originalText = selectionText;
  const replacementText = mode === "delete"
    ? ""
    : mode === "replace" && !extractFirstVscodeCodeFence(sourceText).trim()
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

  const state = getMutableVscodeSyncState();
  const rawRack = state.latestRack || {};
  const rack = buildContextScopedVscodeRack(rawRack, context);
  const options = resolveVscodeReplacementOptions(rawRack, context);
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

  state.resolvedReplacementOptions = visibleOptions;
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
  overlayEls.vscodeInlineActions.textContent = "";

  const fragment = document.createDocumentFragment();
  visibleOptions.slice(0, 1).forEach((option, index) => {
    const mode = vscodeReplacementModeFromOption(option);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vscode-inline-action";
    button.textContent = vscodeReplacementActionLabel(option);
    button.title = toText(option.description || option.label);
    button.disabled = !!state.busy || !hasUsableVscodeReplacementOption(option);
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
  const context = getPageContext();
  const resolvedOptions = Array.isArray(overlayState.vscodeSyncState?.resolvedReplacementOptions)
    ? overlayState.vscodeSyncState.resolvedReplacementOptions
    : [];
  const options = resolvedOptions.length
    ? resolvedOptions
    : resolveVscodeReplacementOptions(rawRack, context);
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

  const visible = showingMainView && context.pageType === "codespace" && !isAdminSession();
  overlayEls.vscodeSyncSection.hidden = !visible;
  if (!visible) {
    resetVscodeSuggestionWait(getMutableVscodeSyncState());
    resetVscodeSyncOverlayPlacement();
    hideVscodeInlinePalette();
    return;
  }

  const state = getMutableVscodeSyncState();
  const rawRack = state.latestRack || {};
  const rack = buildContextScopedVscodeRack(rawRack, context);
  const rackContextMismatch = isVscodeRackForDifferentFile(rawRack, context);
  const options = resolveVscodeReplacementOptions(rawRack, context);
  state.resolvedReplacementOptions = options;
  const filePath = toText(rack.activeFilePath || context.filePath);
  const fileName = filePath.split(/[\\/]/).filter(Boolean).pop() || filePath || "Sin archivo activo";
  const updatedAt = toText(rack.updatedAt || rack.generatedAt || state.updatedAt);
  const updatedLabel = updatedAt ? formatProjectContextTimestamp(updatedAt) : "";
  const mentorSummary = toText(overlayState.mentorSummary);
  const insight = overlayState.projectContextInsight || EMPTY_PROJECT_CONTEXT_INSIGHT;
  const contextStatus = overlayState.projectContextStatus || EMPTY_PROJECT_CONTEXT_STATUS;
  const fileSummary = mentorSummary
    || toText(insight.summary)
    || toText(contextStatus.summary)
    || toText(rack.activeCodeSnippet)
    || "Aun no hay resumen del archivo activo.";
  const statusText = state.busy
    ? "Sincronizando con VS Code..."
    : state.connected
      ? "VS Code conectado"
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
  overlayEls.vscodeSyncMeta.textContent = metaParts.join(" | ") || "Abre el archivo en Codespaces y ejecuta ADACEEN en VS Code.";
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

  positionVscodeSyncOverlay();
  if (!state.connected || !options.length) {
    hideVscodeInlinePalette();
    return;
  }

  renderVscodeInlinePalette(context, showingMainView, suggestionDisplay);
}
