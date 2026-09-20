// ADACEEN | Capa 3 - Servicios: sincronizacion con la extension de VS Code: rack de contexto y acciones de codigo.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

function toVscodeCodeActionText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .slice(0, 120000);
}

function normalizeVscodeReplacementOptions(value) {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item, index) => {
      const source = item && typeof item === "object" ? item : {};
      return {
        id: toText(source.id) || `option-${index + 1}`,
        label: toText(source.label) || `Opcion ${index + 1}`,
        description: toText(source.description),
        filePath: toText(source.filePath || source.file_path),
        actionType: toText(source.actionType || source.action_type),
        originalText: toVscodeCodeActionText(source.originalText || source.original_text),
        replacementText: toVscodeCodeActionText(source.replacementText || source.replacement_text),
        metadata: source.metadata && typeof source.metadata === "object" ? source.metadata : {},
      };
    })
    .filter((item) => item.label || item.replacementText)
    .slice(0, 8);
}

function normalizeVscodeActionProbe(value) {
  return toText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function inferVscodeReplacementModeFromText(value, fallback = "insert") {
  const probe = normalizeVscodeActionProbe(value);
  const explicit = probe.match(/\b(?:accion|aplicar|modo|action|apply)\s*:\s*(insert|insertar|add|replace|reemplazar|modificar|update|delete|eliminar|borrar|remove)\b/);
  const token = explicit?.[1] || "";
  if (/^(delete|eliminar|borrar|remove)$/.test(token)) return "delete";
  if (/^(replace|reemplazar|modificar|update)$/.test(token)) return "replace";
  if (/^(insert|insertar|add)$/.test(token)) return "insert";
  if (/\b(elimina|eliminar|borra|borrar|quita|quitar|remueve|remover|retira|retirar|delete|remove)\b/.test(probe)) return "delete";
  if (/\b(modifica|modificar|reemplaza|reemplazar|cambia|cambiar|actualiza|actualizar|corrige|corregir|refactoriza|refactorizar|replace|update|fix)\b/.test(probe)) return "replace";
  if (/\b(agrega|agregar|anade|anadir|inserta|insertar|crea|crear|implementa|implementar|completa|completar|add|insert|append)\b/.test(probe)) return "insert";
  return fallback;
}

function extractFirstVscodeCodeFence(value) {
  const match = toText(value).match(/```(?:[A-Za-z0-9_+-]+)?\s*\r?\n([\s\S]*?)```/);
  return match?.[1]?.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd() || "";
}

function commentSyntaxForVscodeFile(filePath) {
  const lower = toText(filePath).toLowerCase();
  if (/\.(py|rb|sh|bash|zsh|ps1|yml|yaml|toml|ini|env)$/i.test(lower)) {
    return { open: "# ", close: "" };
  }
  if (/\.(html|htm|xml|svg|md)$/i.test(lower)) {
    return { open: "<!-- ", close: " -->" };
  }
  if (/\.(css|scss|sass|sql)$/i.test(lower)) {
    return { open: "/* ", close: " */" };
  }
  return { open: "// ", close: "" };
}

function firstNonEmptyLine(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .find((line) => line.trim())
    || "";
}

function lineIndent(value) {
  const match = String(value || "").match(/^[ \t]*/);
  return match ? match[0] : "";
}

function normalizeVscodeTodoText(value) {
  const withoutFences = toText(value)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\b(?:accion|aplicar|modo|action|apply)\s*:\s*(insert|insertar|add|replace|reemplazar|modificar|update|delete|eliminar|borrar|remove)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const clean = withoutFences
    .replace(/^(?:\d+[).]\s*)?(?:resumen|sugerencias del codigo|sugerencias del archivo|riesgos)\s*:?\s*/i, "")
    .replace(/^[-*]\s*/, "")
    .trim();
  return truncateText(clean || "revisar este punto con la sugerencia de ADACEEN", 180);
}

function buildVscodeFallbackReplacementText(rack, context, sourceText) {
  const filePath = toText(rack?.activeFilePath || context?.filePath);
  const codeFence = extractFirstVscodeCodeFence(sourceText);
  if (codeFence.trim()) {
    return codeFence;
  }

  const activeLine = firstNonEmptyLine(rack?.activeCodeSnippet || context?.selection || context?.codeSnippet);
  const indent = lineIndent(activeLine);
  const comment = commentSyntaxForVscodeFile(filePath);
  return `${indent}${comment.open}TODO: ${normalizeVscodeTodoText(sourceText)}${comment.close}`;
}

function normalizeVscodeFilePath(value) {
  return toText(value)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .toLowerCase();
}

function isVscodeRackForDifferentFile(rack, context = {}) {
  const rackPath = normalizeVscodeFilePath(rack?.activeFilePath);
  const contextPath = normalizeVscodeFilePath(context?.filePath);
  if (!rackPath || !contextPath) return false;
  return rackPath !== contextPath
    && !rackPath.endsWith(`/${contextPath}`)
    && !contextPath.endsWith(`/${rackPath}`);
}

function buildContextScopedVscodeRack(rack, context = {}) {
  const sourceRack = rack && typeof rack === "object" ? rack : {};
  if (!isVscodeRackForDifferentFile(sourceRack, context)) {
    return sourceRack;
  }

  return {
    ...sourceRack,
    activeFilePath: toText(context.filePath) || toText(sourceRack.activeFilePath),
    activeCodeSnippet: toVscodeCodeActionText(context.selection || context.codeSnippet || ""),
    activeSuggestion: "",
    replacementOptions: [],
    contextMismatch: true,
  };
}

function appendVscodeCommentToTarget(targetText, commentText) {
  const target = toVscodeCodeActionText(targetText).replace(/\s+$/g, "");
  const comment = toVscodeCodeActionText(commentText).trimEnd();
  if (!target) return comment;
  if (!comment) return target;
  return `${target}\n${comment}`;
}

function buildBrowserDefaultVscodeReplacementOptions(rack, context = {}) {
  const scopedRack = buildContextScopedVscodeRack(rack, context);
  const staleRack = isVscodeRackForDifferentFile(rack, context);
  const filePath = toText(scopedRack.activeFilePath || context.filePath);
  if (!filePath) return [];

  const visibleSelection = toVscodeCodeActionText(context.selection);
  const rackFocusText = staleRack ? "" : toVscodeCodeActionText(rack?.activeCodeSnippet);
  const targetText = visibleSelection || rackFocusText;
  const basisText = targetText || toVscodeCodeActionText(context.codeSnippet || scopedRack.activeCodeSnippet);
  const sourceText = toText(scopedRack.activeSuggestion);
  if (!sourceText.trim()) return [];

  const mode = inferVscodeReplacementModeFromText([
    scopedRack.activeSuggestion,
    scopedRack.actionType,
    scopedRack.applyMode,
  ].map(toText).join("\n"), "insert");
  const commentText = buildVscodeFallbackReplacementText(
    { ...scopedRack, activeCodeSnippet: basisText, activeFilePath: filePath },
    context,
    sourceText,
  );
  const lineText = firstNonEmptyLine(basisText);
  const hasVisibleSelection = !!visibleSelection.trim();
  const targetModeLabel = hasVisibleSelection ? "seleccion" : "linea";
  const originalText = mode === "insert" ? lineText : targetText;
  if ((mode === "replace" || mode === "delete") && !originalText.trim()) return [];

  const replacementText = mode === "delete"
    ? ""
    : mode === "replace" && !extractFirstVscodeCodeFence(sourceText).trim()
      ? appendVscodeCommentToTarget(originalText, commentText)
      : commentText;
  const actionLabel = mode === "delete"
    ? (hasVisibleSelection ? "Eliminar seleccion" : "Eliminar linea actual")
    : mode === "replace"
      ? (hasVisibleSelection ? "Modificar seleccion" : "Modificar linea actual")
      : "Agregar comentario TODO";
  const actionType = mode === "delete"
    ? (hasVisibleSelection ? "delete_selection" : "delete_line")
    : mode === "replace"
      ? (hasVisibleSelection ? "replace_selection" : "replace_line")
      : "insert_after_line";

  return [{
    id: `browser-agent-${mode}`,
    label: actionLabel,
    description: `ADACEEN decidio ${actionLabel.toLowerCase()} sobre la ${targetModeLabel} enfocada.`,
    filePath,
    actionType,
    originalText,
    replacementText,
    metadata: {
      applyMode: mode,
      generatedBy: "browser_overlay_agent_decision",
      source: "browser_overlay",
      rackContextMismatch: staleRack,
    },
  }];
}

function hasUsableVscodeReplacementOption(option) {
  if (!option) return false;
  if (isDeleteVscodeReplacementOption(option)) return true;
  return !!toText(option.replacementText);
}

function enrichVscodeReplacementOption(option, rack, context, index) {
  const sourceText = [
    option?.replacementText,
    rack?.activeSuggestion,
    option?.description,
    option?.label,
  ].map(toText).find(Boolean) || "";
  const mode = inferVscodeReplacementModeFromText([
    option?.actionType,
    option?.id,
    option?.label,
    option?.description,
    option?.metadata?.applyMode,
    sourceText,
  ].map(toText).join("\n"), "insert");

  const optionReplacementText = toVscodeCodeActionText(option?.replacementText);
  const replacementText = optionReplacementText.trim()
    ? optionReplacementText
    : mode === "delete" ? "" : buildVscodeFallbackReplacementText(rack, context, sourceText);
  const hasExplicitActionType = !!toText(option?.actionType);
  const actionType = hasExplicitActionType
    ? toText(option.actionType)
    : mode === "delete"
      ? "delete_line"
      : mode === "replace" && extractFirstVscodeCodeFence(sourceText)
        ? "replace_line"
        : "insert_after_line";

  return {
    id: toText(option?.id) || `resolved-option-${index + 1}`,
    label: toText(option?.label) || (mode === "delete" ? "Eliminar codigo sugerido" : mode === "replace" ? "Modificar codigo sugerido" : "Agregar ayuda sugerida"),
    description: toText(option?.description) || (mode === "delete"
      ? "Elimina el bloque enfocado en VS Code."
      : "Envia una accion aplicable a VS Code basada en la sugerencia actual."),
    filePath: toText(option?.filePath || rack?.activeFilePath || context?.filePath),
    actionType,
    originalText: toVscodeCodeActionText(option?.originalText || rack?.activeCodeSnippet || context?.selection || context?.codeSnippet),
    replacementText,
    metadata: {
      ...(option?.metadata && typeof option.metadata === "object" ? option.metadata : {}),
      applyMode: mode === "replace" && !extractFirstVscodeCodeFence(sourceText) ? "insert" : mode,
      generatedBy: toText(option?.metadata?.generatedBy) || "vscode_rack_resolution",
    },
  };
}

function buildDerivedVscodeReplacementOption(rack, context) {
  const sourceText = toText(rack?.activeSuggestion);
  const filePath = toText(rack?.activeFilePath || context?.filePath);
  if (!sourceText || !filePath) return null;

  const inferredMode = inferVscodeReplacementModeFromText(sourceText, "insert");
  const codeFence = extractFirstVscodeCodeFence(sourceText);
  const safeMode = inferredMode === "replace" && !codeFence ? "insert" : inferredMode;
  const replacementText = safeMode === "delete"
    ? ""
    : buildVscodeFallbackReplacementText(rack, context, sourceText);
  const activeText = toVscodeCodeActionText(rack?.activeCodeSnippet || context?.selection || context?.codeSnippet);

  if (safeMode === "delete" && !activeText.trim()) return null;

  return {
    id: `browser-derived-${safeMode}`,
    label: safeMode === "delete"
      ? "Eliminar bloque enfocado"
      : safeMode === "replace"
        ? "Modificar con codigo sugerido"
        : "Agregar cambio sugerido",
    description: safeMode === "delete"
      ? "Envia a VS Code una accion para eliminar la linea o seleccion activa."
      : codeFence
        ? "Usa el bloque de codigo detectado en la sugerencia para continuar en VS Code."
        : "Convierte la sugerencia en un TODO aplicable cerca del cursor.",
    filePath,
    actionType: safeMode === "delete"
      ? "delete_line"
      : safeMode === "replace"
        ? "replace_line"
        : "insert_after_line",
    originalText: activeText,
    replacementText,
    metadata: {
      applyMode: safeMode,
      generatedBy: "browser_overlay_fallback",
      source: "browser_overlay",
    },
  };
}

function resolveVscodeReplacementOptions(rack, context = {}) {
  const sourceRack = rack && typeof rack === "object" ? rack : {};
  const scopedRack = buildContextScopedVscodeRack(sourceRack, context);
  const sourceOptions = scopedRack.contextMismatch
    ? []
    : normalizeVscodeReplacementOptions(sourceRack.replacementOptions || sourceRack.replacement_options);
  const hydrated = sourceOptions
    .map((option, index) => enrichVscodeReplacementOption(option, scopedRack, context, index))
    .filter((option) => option.label || option.replacementText || isDeleteVscodeReplacementOption(option))
    .slice(0, 8);

  const derived = buildDerivedVscodeReplacementOption(scopedRack, context);
  const defaults = buildBrowserDefaultVscodeReplacementOptions(sourceRack, context);
  const merged = [
    ...hydrated,
    ...(derived ? [derived] : []),
    ...defaults,
  ];
  const seen = new Set();
  const resolved = [];
  for (const option of merged) {
    if (!hasUsableVscodeReplacementOption(option)) continue;
    const key = [
      option.actionType,
      option.filePath,
      option.originalText,
      option.replacementText,
      option.label,
    ].map(toText).join("::");
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push(option);
    if (resolved.length >= 8) break;
  }

  const candidates = resolved.length ? resolved : hydrated;
  if (!candidates.length) return [];

  const agentMode = inferVscodeReplacementModeFromText([
    scopedRack.activeSuggestion,
    scopedRack.applyMode,
    scopedRack.actionType,
  ].map(toText).join("\n"), "");
  const selected = agentMode
    ? candidates.find((option) => vscodeReplacementModeFromOption(option) === agentMode) || candidates[0]
    : candidates[0];
  return selected ? [selected] : [];
}

function isDeleteVscodeReplacementOption(option) {
  const metadata = option?.metadata && typeof option.metadata === "object" ? option.metadata : {};
  return /\b(delete|remove|eliminar|borrar)\b/i.test([
    option?.actionType,
    option?.id,
    option?.label,
    metadata.applyMode,
  ].map(toText).join(" "));
}

function vscodeReplacementModeFromOption(option) {
  if (isDeleteVscodeReplacementOption(option)) return "delete";
  const metadata = option?.metadata && typeof option.metadata === "object" ? option.metadata : {};
  const probe = [
    option?.actionType,
    option?.id,
    option?.label,
    metadata.applyMode,
  ].map(toText).join(" ");
  return inferVscodeReplacementModeFromText(probe, "replace");
}

function normalizeVscodeRackPayload(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    id: toText(source.id),
    source: toText(source.source),
    repoFullName: parseRepoFullName(source.repoFullName || source.repo_full_name || ""),
    branch: toText(source.branch),
    totalEntries: Math.max(0, Number(source.totalEntries || source.total_entries || 0) || 0),
    totalFiles: Math.max(0, Number(source.totalFiles || source.total_files || 0) || 0),
    totalFolders: Math.max(0, Number(source.totalFolders || source.total_folders || 0) || 0),
    activeFilePath: toText(source.activeFilePath || source.active_file_path),
    activeCodeSnippet: toText(source.activeCodeSnippet || source.active_code_snippet),
    activeSuggestion: toText(source.activeSuggestion || source.active_suggestion),
    replacementOptions: normalizeVscodeReplacementOptions(source.replacementOptions || source.replacement_options),
    generatedAt: toText(source.generatedAt || source.generated_at),
    createdAt: toText(source.createdAt || source.created_at),
    updatedAt: toText(source.updatedAt || source.updated_at || source.createdAt || source.created_at),
  };
}

async function refreshVscodeSyncState(options = {}) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const context = getPageContext();
  const repoFullName = getCurrentRepoFullName();
  const silent = options.silent !== false;

  if (!baseUrl || !overlayState.sessionId || context.pageType !== "codespace") {
    overlayState.vscodeSyncState = { ...EMPTY_VSCODE_SYNC_STATE };
    return null;
  }

  overlayState.vscodeSyncState = {
    ...(overlayState.vscodeSyncState || EMPTY_VSCODE_SYNC_STATE),
    busy: !silent,
    error: "",
    message: silent ? toText(overlayState.vscodeSyncState?.message) : "Sincronizando con VS Code...",
  };
  if (!silent) renderOverlay();

  try {
    const query = new URLSearchParams();
    if (context.filePath) {
      query.set("filePath", context.filePath);
    }
    const stateUrl = `${baseUrl}/api/projects/session/state${query.toString() ? `?${query.toString()}` : ""}`;
    const response = await fetchJsonWithTimeout(stateUrl, {
      method: "GET",
      headers: buildApiHeaders(),
    }, BACKEND_TIMEOUT_MS);
    const rack = normalizeVscodeRackPayload(response?.state?.latestRack);
    const fileRack = normalizeVscodeRackPayload(response?.state?.latestRackForFile);
    const sameRepo = !repoFullName
      || !rack.repoFullName
      || rack.repoFullName.toLowerCase() === repoFullName.toLowerCase();
    const fileRackSameRepo = !repoFullName
      || !fileRack.repoFullName
      || fileRack.repoFullName.toLowerCase() === repoFullName.toLowerCase();
    const hasFileRack = !!fileRack.id && fileRackSameRepo;
    const preferredRack = hasFileRack ? fileRack : rack;
    const connected = !!preferredRack.id && (hasFileRack || sameRepo);
    overlayState.vscodeSyncState = {
      connected,
      busy: false,
      error: "",
      message: connected
        ? hasFileRack
          ? "VS Code sincronizado con el archivo activo."
          : "VS Code sincronizado con este Codespace."
        : rack.id
          ? "VS Code publico contexto de otro repositorio."
          : "Aun no hay estado publicado desde VS Code.",
      latestRack: connected ? preferredRack : null,
      latestRackForFile: hasFileRack ? fileRack : null,
      globalLatestRack: !!rack.id && sameRepo ? rack : null,
      resolvedReplacementOptions: [],
      lastAction: overlayState.vscodeSyncState?.lastAction || null,
      updatedAt: preferredRack.updatedAt || rack.updatedAt || "",
      suggestionWaitKey: overlayState.vscodeSyncState?.suggestionWaitKey || "",
      suggestionWaitStartedAt: overlayState.vscodeSyncState?.suggestionWaitStartedAt || 0,
    };
    return overlayState.vscodeSyncState;
  } catch (error) {
    overlayState.vscodeSyncState = {
      ...(overlayState.vscodeSyncState || EMPTY_VSCODE_SYNC_STATE),
      connected: false,
      busy: false,
      error: String(error),
      message: "No se pudo leer el estado de VS Code.",
    };
    return null;
  } finally {
    if (!silent) renderOverlay();
  }
}

async function queueVscodeReplacementOption(option, metadata = {}) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const context = getPageContext();
  const rack = buildContextScopedVscodeRack(overlayState.vscodeSyncState?.latestRack || {}, context);
  const repoFullName = getCurrentRepoFullName() || rack.repoFullName;
  const filePath = toText(option?.filePath || rack.activeFilePath || context.filePath);
  const replacementText = toVscodeCodeActionText(option?.replacementText);
  const optionHasOriginalText = !!option && Object.prototype.hasOwnProperty.call(option, "originalText");
  const originalText = optionHasOriginalText
    ? toVscodeCodeActionText(option.originalText)
    : toVscodeCodeActionText(rack.activeCodeSnippet || context.selection || context.codeSnippet);

  if (!baseUrl || !overlayState.sessionId) {
    throw new Error("Sesion no valida para enviar reemplazos.");
  }
  if (!repoFullName || !filePath) {
    throw new Error("Falta repositorio o archivo activo para el reemplazo.");
  }
  if (!replacementText.trim() && !isDeleteVscodeReplacementOption(option)) {
    throw new Error("La opcion no contiene texto de reemplazo.");
  }

  overlayState.vscodeSyncState = {
    ...(overlayState.vscodeSyncState || EMPTY_VSCODE_SYNC_STATE),
    busy: true,
    error: "",
    message: "Enviando reemplazo a VS Code...",
  };
  renderOverlay();

  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/projects/code-actions`, {
      method: "POST",
      headers: buildApiHeaders(),
      body: JSON.stringify({
        repoFullName,
        branch: toText(rack.branch || context.branch),
        filePath,
        actionType: toText(option?.actionType) || "replace_selection",
        title: toText(option?.label) || "Reemplazo sugerido",
        originalText,
        replacementText,
        metadata: {
          optionId: toText(option?.id),
          optionDescription: toText(option?.description),
          pageType: toText(context.pageType),
          source: "browser_sync_panel",
          ...metadata,
        },
      }),
    }, BACKEND_TIMEOUT_MS);

    overlayState.vscodeSyncState = {
      ...(overlayState.vscodeSyncState || EMPTY_VSCODE_SYNC_STATE),
      busy: false,
      error: "",
      message: "Reemplazo enviado. VS Code lo aplicara cuando confirme la accion.",
      lastAction: response?.action || null,
    };
    overlayState.statusMessage = "Reemplazo enviado a la extension VS Code.";
    return response?.action || null;
  } catch (error) {
    overlayState.vscodeSyncState = {
      ...(overlayState.vscodeSyncState || EMPTY_VSCODE_SYNC_STATE),
      busy: false,
      error: String(error),
      message: "No se pudo enviar el reemplazo a VS Code.",
    };
    throw error;
  } finally {
    renderOverlay();
  }
}
