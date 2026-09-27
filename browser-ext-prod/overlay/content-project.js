// ADACEEN | Capa 4 - UI/flujo: exploracion del proyecto (explorador de Codespaces, Campus) y su ventana de analisis.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

function parseExplorerItemType(row, name) {
  const iconLabel = row.querySelector(".monaco-icon-label");
  const classBlob = `${row.className || ""} ${iconLabel?.className || ""}`.toLowerCase();

  if (row.hasAttribute("aria-expanded")) return "folder";
  if (classBlob.includes("folder")) return "folder";
  if (classBlob.includes("file")) return "file";
  if (!/\.[a-z0-9]{1,12}$/i.test(name)) return "folder";
  return "file";
}

function extractCodespaceExplorerEntries(maxItems = 10000) {
  const root = document.querySelector(".explorer-folders-view");
  if (!root) return [];

  const rows = Array.from(root.querySelectorAll(".monaco-list-row, [role='treeitem']"));
  const pathByLevel = [];
  const seen = new Set();
  const entries = [];

  for (const row of rows) {
    if (!(row instanceof HTMLElement)) continue;

    const rawName = toText(
      row.getAttribute("data-resource-name")
      || row.querySelector("[data-resource-name]")?.getAttribute("data-resource-name")
      || row.querySelector(".label-name")?.textContent
      || row.getAttribute("aria-label")
      || "",
    );
    const name = rawName.split(",")[0].trim();
    if (!name || name === "(sin texto)") continue;

    const levelValue = Number(
      row.getAttribute("aria-level")
      || row.dataset.level
      || row.querySelector("[aria-level]")?.getAttribute("aria-level")
      || 1,
    );
    const level = Number.isFinite(levelValue) && levelValue > 0
      ? Math.floor(levelValue)
      : 1;

    const levelIndex = Math.max(0, level - 1);
    const parentPath = levelIndex > 0 ? toText(pathByLevel[levelIndex - 1]) : "";
    const path = parentPath ? `${parentPath}/${name}` : name;
    pathByLevel[levelIndex] = path;
    pathByLevel.length = levelIndex + 1;

    const type = parseExplorerItemType(row, name);
    const key = `${type}|${path.toLowerCase()}`;
    if (seen.has(key)) continue;

    seen.add(key);
    entries.push({ type, name, path, level });
    if (entries.length >= maxItems) break;
  }

  return entries;
}

function buildCodespaceAnalysis(entries) {
  const folders = entries
    .filter((entry) => entry.type === "folder")
    .map((entry) => entry.path);
  const files = entries
    .filter((entry) => entry.type === "file")
    .map((entry) => entry.path);

  return {
    totalEntries: entries.length,
    totalFiles: files.length,
    totalFolders: folders.length,
    folders,
    files,
    generatedAt: new Date().toISOString(),
  };
}

function renderProjectAnalysisWindow() {
  if (!overlayEls?.analysisWindow) return;

  overlayEls.analysisWindow.hidden = !overlayState.analysisWindowOpen;
  if (overlayEls.analysisWindow.hidden) return;

  const context = overlayState.context || buildPayload();
  if (context.pageContext === "campus") {
    renderCampusAnalysisWindow();
    return;
  }

  // En vscode.dev (tunel) el editor es "tu editor", no Codespaces.
  const editorName = isTunnelEditorPage(context) ? "tu editor" : "Codespaces";
  if (overlayEls.analysisTitle) {
    overlayEls.analysisTitle.textContent = `Analisis de archivos en ${editorName}`;
  }

  if (overlayState.analysisBusy) {
    overlayEls.analysisStats.textContent = `Analizando archivos y carpetas visibles en ${editorName}...`;
    fillList(overlayEls.analysisFileList, ["Procesando arbol del explorador..."]);
    return;
  }

  const analysis = overlayState.projectAnalysis;
  if (!analysis) {
    overlayEls.analysisStats.textContent = "Pulsa Explorar repo para leer archivos y carpetas del explorador.";
    fillList(overlayEls.analysisFileList, ["Aun no hay resultados."]);
    return;
  }

  const status = overlayState.projectContextStatus || EMPTY_PROJECT_CONTEXT_STATUS;
  const insight = overlayState.projectContextInsight || EMPTY_PROJECT_CONTEXT_INSIGHT;
  const documentState = normalizeDocumentClassificationState(overlayState.documentClassifications);
  const documentItems = documentState.items || [];
  const versionText = toText(insight.version || status.latestVersion || status.currentVersion);
  const mainFilePath = toText(insight.mainFilePath);
  const statsExtras = [];
  if (versionText) statsExtras.push(`version ${versionText}`);
  if (mainFilePath) statsExtras.push(`archivo principal ${mainFilePath}`);
  if (insight.screenshotUsed) {
    const confidence = Math.max(0, Math.round(Number(insight.screenshotConfidence) || 0));
    statsExtras.push(`OCR ${confidence}%`);
  }
  if (insight.screenshotSavedPath) statsExtras.push("screenshot guardado");
  if (documentItems.length > 0) {
    const bitacoraCount = documentItems.filter((item) => item.label === "BITACORA").length;
    statsExtras.push(`${documentItems.length} documento(s) clasificado(s)`);
    if (bitacoraCount > 0) statsExtras.push(`${bitacoraCount} bitacora(s)`);
  } else if (documentState.busy) {
    statsExtras.push("clasificacion documental en curso");
  }

  overlayEls.analysisStats.textContent =
    `Detectados ${analysis.totalFiles} archivos y ${analysis.totalFolders} carpetas ` +
    `(${analysis.totalEntries} elementos visibles).` +
    (statsExtras.length > 0 ? ` ${statsExtras.join(" | ")}` : "");

  const lines = [
    ...(insight.summary ? [`[resumen] ${truncateText(insight.summary, 260)}`] : []),
    ...(mainFilePath ? [`[archivo principal] ${mainFilePath}`] : []),
    ...(insight.autoAdvice ? [`[consejo] ${truncateText(insight.autoAdvice, 260)}`] : []),
    ...(insight.screenshotOcrText ? [`[ocr] ${truncateText(insight.screenshotOcrText, 260)}`] : []),
    ...(insight.screenshotSavedPath ? [`[screenshot] ${insight.screenshotSavedPath}`] : []),
    ...(documentState.busy && documentItems.length === 0 ? ["[documento] Clasificacion documental pendiente del worker."] : []),
    ...(documentState.error ? [`[documento-error] ${truncateText(documentState.error, 260)}`] : []),
    ...documentItems.flatMap((item) => {
      const percent = Math.round((Number(item.confidence) || 0) * 100);
      const targetPath = item.filePath || item.fileName || "(sin ruta)";
      const evidence = item.evidence.length > 0
        ? `[evidencia] ${truncateText(item.evidence.join("; "), 300)}`
        : "";
      return [
        `[documento] ${item.label} ${percent}% | ${targetPath}`,
        evidence,
        item.reason ? `[razon] ${truncateText(item.reason, 260)}` : "",
      ].filter(Boolean);
    }),
    ...analysis.folders.map((path) => `[carpeta] ${path}`),
    ...analysis.files.map((path) => `[archivo] ${path}`),
  ];

  const visibleLines = lines.slice(0, MAX_ANALYSIS_RENDER_ITEMS);
  if (lines.length > MAX_ANALYSIS_RENDER_ITEMS) {
    visibleLines.push(`... ${lines.length - MAX_ANALYSIS_RENDER_ITEMS} elementos adicionales.`);
  }

  fillList(
    overlayEls.analysisFileList,
    visibleLines.length > 0 ? visibleLines : ["No se detectaron archivos o carpetas visibles."],
  );
}

function formatCampusType(value) {
  const type = toText(value);
  const labels = {
    assign: "tarea",
    quiz: "quiz",
    resource: "recurso",
    url: "enlace",
    page: "pagina",
    forum: "foro",
    book: "libro",
    folder: "carpeta",
    unknown: "actividad",
  };
  return labels[type] || "actividad";
}

function formatCampusDate(value) {
  const text = toText(value);
  if (!text) return "";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleString();
}

function formatCampusLine(prefix, item) {
  const title = toText(item?.title) || "(sin titulo)";
  const type = formatCampusType(item?.type);
  const section = toText(item?.sectionTitle);
  const due = toText(item?.visibleDueText) || formatCampusDate(item?.dueAt);
  const meta = [
    type,
    section ? `seccion: ${section}` : "",
    due ? `fecha: ${due}` : "",
  ].filter(Boolean).join(" | ");
  return `[${prefix}] ${title}${meta ? ` | ${meta}` : ""}`;
}

function renderCampusAnalysisWindow() {
  if (overlayEls.analysisTitle) {
    overlayEls.analysisTitle.textContent = "Analisis de Campus Virtual";
  }

  if (overlayState.analysisBusy) {
    overlayEls.analysisStats.textContent = "Analizando actividades, enlaces y fechas visibles en Campus...";
    fillList(overlayEls.analysisFileList, ["Leyendo contenido visible del curso..."]);
    return;
  }

  const analysis = overlayState.campusAnalysis;
  if (!analysis) {
    overlayEls.analysisStats.textContent = "Pulsa Analizar Campus para leer actividades, materiales y fechas visibles.";
    fillList(overlayEls.analysisFileList, ["Aun no hay resultados de Campus."]);
    return;
  }

  const stats = analysis.stats || {};
  const documentState = normalizeDocumentClassificationState(overlayState.documentClassifications);
  const documentItems = documentState.items || [];
  const documentExtras = [];
  if (documentItems.length > 0) {
    const bitacoraCount = documentItems.filter((item) => item.label === "BITACORA").length;
    const bitacoraAgendaCount = documentItems
      .flatMap((item) => item.bitacoraAgenda?.items || [])
      .length;
    documentExtras.push(`${documentItems.length} documento(s) clasificado(s)`);
    if (bitacoraCount > 0) documentExtras.push(`${bitacoraCount} bitacora(s)`);
    if (bitacoraAgendaCount > 0) documentExtras.push(`${bitacoraAgendaCount} item(s) de agenda`);
  } else if (documentState.busy) {
    documentExtras.push("clasificacion documental en curso");
  }

  const baseStatsText = analysis.summary
    || `Detectadas ${stats.activityCount || 0} actividades, ${stats.taskCount || 0} tareas y ${stats.deadlineCount || 0} fechas visibles.`;
  overlayEls.analysisStats.textContent = documentExtras.length > 0
    ? `${baseStatsText} ${documentExtras.join(" | ")}`
    : baseStatsText;

  const lines = [
    ...(analysis.course?.title ? [`[curso] ${analysis.course.title}${analysis.course.id ? ` | id ${analysis.course.id}` : ""}`] : []),
    ...(documentState.busy && documentItems.length === 0 ? ["[documento] Descargando y clasificando documentos candidatos de Campus..."] : []),
    ...(documentState.error ? [`[documento-error] ${truncateText(documentState.error, 260)}`] : []),
    ...documentItems.flatMap((item) => {
      const percent = Math.round((Number(item.confidence) || 0) * 100);
      const targetPath = item.fileName || item.filePath || "(sin archivo)";
      const evidence = item.evidence.length > 0
        ? `[evidencia] ${truncateText(item.evidence.join("; "), 300)}`
        : "";
      return [
        `[documento] ${item.label} ${percent}% | ${targetPath}`,
        evidence,
        item.reason ? `[razon] ${truncateText(item.reason, 260)}` : "",
        ...(item.bitacoraAgenda?.items || []).map((agendaItem) => {
          const due = agendaItem.visibleDueText || formatCampusDate(agendaItem.dueAt);
          return `[bitacora-agenda] ${agendaItem.title}${due ? ` | fecha: ${due}` : ""}`;
        }),
      ].filter(Boolean);
    }),
    ...analysis.recommendations.map((text) => `[recomendacion] ${text}`),
    ...analysis.agenda.map((item) => formatCampusLine("agenda", item)),
    ...analysis.tasks.map((item) => formatCampusLine("tarea", item)),
    ...analysis.materials.map((item) => formatCampusLine("material", item)),
    ...analysis.activities.map((item) => formatCampusLine("actividad", item)),
    ...analysis.links.slice(0, 40).map((item) => formatCampusLine("link", item)),
  ];

  const visibleLines = unique(lines).slice(0, MAX_ANALYSIS_RENDER_ITEMS);
  if (lines.length > MAX_ANALYSIS_RENDER_ITEMS) {
    visibleLines.push(`... ${lines.length - MAX_ANALYSIS_RENDER_ITEMS} elementos adicionales.`);
  }

  fillList(
    overlayEls.analysisFileList,
    visibleLines.length > 0 ? visibleLines : ["No se detectaron actividades visibles en esta pagina."],
  );
}

async function analyzeCodespaceProject() {
  overlayState.analysisWindowOpen = true;
  overlayState.analysisBusy = true;
  overlayState.statusMessage = "Explorando estructura visible del proyecto...";
  renderOverlay();

  try {
    overlayState.context = buildPayload();
    const context = overlayState.context;

    if (context.pageType !== "codespace") {
      overlayState.projectAnalysis = null;
      overlayState.statusMessage = typeof isTunnelProvider === "function" && isTunnelProvider()
        ? "Este analisis basico solo funciona dentro de tu editor en la nube."
        : "Este analisis basico solo funciona en la interfaz de Codespaces.";
      return;
    }

    const entries = extractCodespaceExplorerEntries();
    overlayState.projectAnalysis = buildCodespaceAnalysis(entries);

    if (entries.length === 0) {
      overlayState.statusMessage = "No se pudieron leer elementos del explorador. Expande archivos y vuelve a analizar.";
      return;
    }

    overlayState.analysisUnlocked = true;
    overlayState.statusMessage =
      `Exploracion lista: ${overlayState.projectAnalysis.totalFiles} archivos y ` +
      `${overlayState.projectAnalysis.totalFolders} carpetas detectados.`;
    overlayState.analysisBusy = false;
    renderOverlay();

    await new Promise((resolve) => setTimeout(resolve, 50));

    let hasConsent = false;
    try {
      hasConsent = await ensureProjectConsentForCurrentUser();
    } catch (error) {
      overlayState.statusMessage =
        `Exploracion lista, pero no se pudo registrar el permiso inicial: ${String(error)}`;
      return;
    }

    if (!hasConsent) {
      overlayState.statusMessage =
        "Exploracion lista. Cuando des permiso, guardaremos el contexto del proyecto en el rack del agente.";
      return;
    }

    const repoFullName = getCurrentRepoFullName() || inferRepoFromContext(context);
    let workerCoordinationNote = "";
    let scanCompletedFromWorker = false;
    if (repoFullName) {
      try {
        const requestResponse = await requestProjectScanFromBackend(repoFullName);
        const requestId = toText(requestResponse?.request?.id);
        if (requestId) {
          overlayState.statusMessage =
            "Solicitud enviada a la extensión VS Code. Esperando archivos con código...";
          renderOverlay();

          const finalStatus = await waitForProjectScanCompletion(requestId, 120000, 2500);
          const finalState = toText(finalStatus?.request?.status).toLowerCase();
          if (finalState === "completed") {
            overlayState.statusMessage =
              "Exploracion lista. La extensión VS Code envió el código al backend y se guardó en almacenamiento local + PostgreSQL.";
            scanCompletedFromWorker = true;
          }
          if (finalState === "failed") {
            workerCoordinationNote =
              "La extensión VS Code reportó error al enviar el código.";
            overlayState.statusMessage = `${workerCoordinationNote} Se intentará guardado básico de respaldo.`;
          } else if (finalState !== "completed") {
            workerCoordinationNote =
              "No llegó respuesta de la extensión VS Code a tiempo.";
            overlayState.statusMessage = `${workerCoordinationNote} Se intentará guardado básico de respaldo.`;
          }
        } else {
          workerCoordinationNote =
            "El backend no creó solicitud para worker VS Code.";
        }
      } catch (error) {
        workerCoordinationNote =
          `No se pudo coordinar escaneo con la extensión VS Code: ${String(error)}.`;
        overlayState.statusMessage = `${workerCoordinationNote} Se intentará guardado básico.`;
      }
    }

    if (scanCompletedFromWorker) {
      await refreshProjectContextPanel();
      await refreshProjectContextInsightFromScreenshot({ silent: false });
      return;
    }

    try {
      const synced = await syncProjectRackToBackend(context, overlayState.projectAnalysis);
      overlayState.statusMessage = synced
        ? workerCoordinationNote
          ? `Exploracion básica guardada en backend (rack). Nota: ${workerCoordinationNote} Revisa Output > ADACEEN en VS Code.`
          : "Exploracion lista y contexto del proyecto guardado en el rack del agente."
        : "Exploracion lista, pero no se pudo guardar el rack de archivos en backend.";
    } catch (error) {
      overlayState.statusMessage =
        `Exploracion lista, pero fallo el guardado del rack en backend: ${String(error)}`;
    }

    await refreshProjectContextInsightFromScreenshot({ silent: true });
  } catch (error) {
    if (!overlayState.projectAnalysis) {
      overlayState.analysisUnlocked = false;
    }
    overlayState.statusMessage = `No se pudo analizar el explorador: ${String(error)}`;
  } finally {
    overlayState.analysisBusy = false;
    renderOverlay();
  }
}

async function analyzeCampusPage() {
  overlayState.analysisWindowOpen = true;
  overlayState.analysisBusy = true;
  overlayState.statusMessage = "Analizando contenido visible de Campus...";
  renderOverlay();

  try {
    overlayState.context = buildPayload();
    const context = overlayState.context;

    if (context.pageContext !== "campus") {
      overlayState.statusMessage = "Este analisis solo se activa dentro de Campus Virtual.";
      return;
    }
    if (!isCampusCoursePageContext(context)) {
      overlayState.statusMessage = "Abre un curso de Campus Virtual para analizar actividades, secciones y fechas.";
      return;
    }
    if (typeof ensureCampusCourseReadyForHtmlAnalysis === "function") {
      const ready = await ensureCampusCourseReadyForHtmlAnalysis();
      if (!ready) return;
    }

    overlayState.documentClassifications = {
      ...EMPTY_DOCUMENT_CLASSIFICATION_STATE,
      message: "Analisis limitado al HTML visible del curso; no se descargaron archivos de bitacora.",
    };
    const analysis = await requestCampusPageAnalysis(context);
    overlayState.campusAnalysis = analysis;
    overlayState.analysisUnlocked = true;
    overlayState.statusMessage = analysis.summary || "Analisis de Campus listo.";

    if (analysis.recommendations.length > 0) {
      overlayState.ideas = analysis.recommendations.slice(0, MAX_LIST_ITEMS);
    }

    const guide = [
      ...analysis.agenda.map((item) => `Agenda: ${item.title}${item.visibleDueText ? ` | ${item.visibleDueText}` : ""}`),
      ...analysis.tasks.map((item) => `Revisa: ${item.title}`),
      ...analysis.materials.map((item) => `Material: ${item.title}`),
    ];
    if (guide.length > 0) {
      overlayState.guide = unique(guide).slice(0, MAX_LIST_ITEMS);
    }

    overlayState.analysisBusy = false;
    renderOverlay();
  } catch (error) {
    overlayState.statusMessage = `No se pudo analizar Campus: ${String(error)}`;
  } finally {
    overlayState.analysisBusy = false;
    renderOverlay();
  }
}

async function analyzeCurrentContext() {
  overlayState.context = buildPayload();
  if (overlayState.context.pageContext === "campus") {
    if (!isCampusCoursePageContext(overlayState.context)) {
      overlayState.statusMessage = "Abre un curso de Campus Virtual para usar Analizar Campus.";
      renderOverlay();
      return;
    }
    await analyzeCampusPage();
    return;
  }

  await analyzeCodespaceProject();
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

// Listeners de contexto del proyecto, OCR visual y GitHub App (movidos desde ensureOverlay, en el mismo orden).
function bindProjectContextPanel() {
  overlayEls.analyzeProjectBtn.addEventListener("click", async () => {
    await analyzeCurrentContext();
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
}
