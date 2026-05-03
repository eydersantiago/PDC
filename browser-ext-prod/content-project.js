
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

  if (overlayState.analysisBusy) {
    overlayEls.analysisStats.textContent = "Analizando archivos y carpetas visibles en Codespaces...";
    fillList(overlayEls.analysisFileList, ["Procesando arbol del explorador..."]);
    return;
  }

  const analysis = overlayState.projectAnalysis;
  if (!analysis) {
    overlayEls.analysisStats.textContent = "Pulsa Explorar proyecto para leer archivos y carpetas del explorador.";
    fillList(overlayEls.analysisFileList, ["Aun no hay resultados."]);
    return;
  }

  const status = overlayState.projectContextStatus || EMPTY_PROJECT_CONTEXT_STATUS;
  const insight = overlayState.projectContextInsight || EMPTY_PROJECT_CONTEXT_INSIGHT;
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
      overlayState.statusMessage = "Este analisis basico solo funciona en la interfaz de Codespaces.";
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
