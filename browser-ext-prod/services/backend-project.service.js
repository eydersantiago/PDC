// ADACEEN | Capa 3 - Servicios: contexto del proyecto (escaneo, estado, historial, insight, documentos
// clasificados) y captura de pantalla con OCR.
// Movido sin cambios desde services/backend.service.js.
// Sin "use strict": el codigo viene de backend.service.js (modo no estricto) y se conserva igual.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

async function requestProjectScanFromBackend(repoFullName) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) return null;
  const cleanRepo = parseRepoFullName(repoFullName);
  if (!cleanRepo) return null;

  return fetchJsonWithTimeout(`${baseUrl}/api/projects/scan/request`, {
    method: "POST",
    headers: buildApiHeaders(),
    body: JSON.stringify({
      repoFullName: cleanRepo,
      source: "dashboard_explore",
    }),
  }, BACKEND_TIMEOUT_MS);
}

async function getProjectScanRequestStatus(requestId) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !requestId) return null;
  return fetchJsonWithTimeout(`${baseUrl}/api/projects/scan/request/${encodeURIComponent(requestId)}`, {
    method: "GET",
    headers: buildApiHeaders(),
  }, BACKEND_TIMEOUT_MS);
}

async function waitForProjectScanCompletion(requestId, timeoutMs = 120000, pollMs = 2500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const response = await getProjectScanRequestStatus(requestId);
    const status = toText(response?.request?.status).toLowerCase();
    if (status === "completed" || status === "failed") {
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return null;
}

async function refreshProjectContextStatus() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const repoFullName = getCurrentRepoFullName();
  if (!baseUrl || !overlayState.sessionId || !repoFullName) {
    overlayState.projectContextStatus = { ...EMPTY_PROJECT_CONTEXT_STATUS };
    return;
  }

  const response = await fetchJsonWithTimeout(
    `${baseUrl}/api/projects/context/status?repoFullName=${encodeURIComponent(repoFullName)}`,
    {
      method: "GET",
      headers: buildApiHeaders(),
    },
    BACKEND_TIMEOUT_MS,
  );

  overlayState.projectContextStatus = {
    ...EMPTY_PROJECT_CONTEXT_STATUS,
    ...normalizeProjectContextStatusPayload(response),
    repoFullName,
  };
}

async function refreshProjectContextHistory() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const repoFullName = getCurrentRepoFullName();
  if (!baseUrl || !overlayState.sessionId || !repoFullName) {
    overlayState.projectContextHistory = [];
    return;
  }

  const response = await fetchJsonWithTimeout(
    `${baseUrl}/api/projects/context/history?repoFullName=${encodeURIComponent(repoFullName)}`,
    {
      method: "GET",
      headers: buildApiHeaders(),
    },
    BACKEND_TIMEOUT_MS,
  );

  overlayState.projectContextHistory = normalizeProjectContextHistoryPayload(response);
}

async function refreshProjectContextInsight() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const repoFullName = getCurrentRepoFullName();
  if (!baseUrl || !overlayState.sessionId || !repoFullName) {
    overlayState.projectContextInsight = { ...EMPTY_PROJECT_CONTEXT_INSIGHT };
    return;
  }

  const useModel = overlayState.autoConfigEnabled ? "1" : "0";
  const response = await fetchJsonWithTimeout(
    `${baseUrl}/api/projects/context/insight?repoFullName=${encodeURIComponent(repoFullName)}&useModel=${useModel}`,
    {
      method: "GET",
      headers: buildApiHeaders(),
    },
    BACKEND_TIMEOUT_MS,
  );

  overlayState.projectContextInsight = normalizeProjectContextInsightPayload(response);
}

async function refreshDocumentClassifications() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const repoFullName = getCurrentRepoFullName();
  if (!baseUrl || !overlayState.sessionId || !repoFullName) {
    overlayState.documentClassifications = { ...EMPTY_DOCUMENT_CLASSIFICATION_STATE };
    return;
  }

  overlayState.documentClassifications = {
    ...normalizeDocumentClassificationState(overlayState.documentClassifications),
    busy: true,
    error: "",
  };

  try {
    const response = await fetchJsonWithTimeout(
      `${baseUrl}/api/documents/classifications?repoFullName=${encodeURIComponent(repoFullName)}&limit=40`,
      {
        method: "GET",
        headers: buildApiHeaders(),
      },
      BACKEND_TIMEOUT_MS,
    );

    const items = normalizeDocumentClassificationsPayload(response);
    overlayState.documentClassifications = {
      items,
      busy: false,
      message: items.length > 0
        ? `${items.length} documento(s) clasificado(s).`
        : "Aun no hay documentos clasificados para este proyecto.",
      error: "",
    };
  } catch (error) {
    overlayState.documentClassifications = {
      ...normalizeDocumentClassificationState(overlayState.documentClassifications),
      busy: false,
      error: `No se pudieron cargar clasificaciones: ${String(error)}`,
    };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function waitForPaintFrames(frames = 1) {
  const total = Math.max(1, Math.floor(Number(frames) || 1));
  for (let index = 0; index < total; index++) {
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
  }
}

async function waitForScreenshotCaptureSettle() {
  await waitForPaintFrames(SCREENSHOT_CAPTURE_PAINT_FRAMES);
  await sleep(SCREENSHOT_CAPTURE_SETTLE_MS);
}

function hideOverlayForScreenshotCapture() {
  if (!overlayHost?.isConnected) {
    return () => {};
  }

  const host = overlayHost;
  const previous = {
    visibility: host.style.visibility,
    opacity: host.style.opacity,
    pointerEvents: host.style.pointerEvents,
    transition: host.style.transition,
    captureHidden: host.getAttribute("data-adaceen-capture-hidden"),
  };

  host.setAttribute("data-adaceen-capture-hidden", "true");
  host.style.transition = "none";
  host.style.visibility = "hidden";
  host.style.opacity = "0";
  host.style.pointerEvents = "none";

  return () => {
    if (!host.isConnected) return;
    host.style.visibility = previous.visibility;
    host.style.opacity = previous.opacity;
    host.style.pointerEvents = previous.pointerEvents;
    host.style.transition = previous.transition;
    if (previous.captureHidden == null) {
      host.removeAttribute("data-adaceen-capture-hidden");
    } else {
      host.setAttribute("data-adaceen-capture-hidden", previous.captureHidden);
    }
  };
}

function buildScreenshotViewportContext() {
  const viewport = getViewportMetrics();
  return {
    width: Math.round(Number(viewport.width) || window.innerWidth || 0),
    height: Math.round(Number(viewport.height) || window.innerHeight || 0),
    offsetLeft: Math.round(Number(viewport.offsetLeft) || 0),
    offsetTop: Math.round(Number(viewport.offsetTop) || 0),
    scrollX: Math.round(Number(window.scrollX) || 0),
    scrollY: Math.round(Number(window.scrollY) || 0),
    devicePixelRatio: Number(window.devicePixelRatio || 1),
  };
}

function buildScreenshotCaptureContext(context) {
  const source = context || buildPayload();
  let explorerEntries = [];
  try {
    explorerEntries = typeof extractCodespaceExplorerEntries === "function"
      ? extractCodespaceExplorerEntries(500)
      : [];
  } catch {
    explorerEntries = [];
  }

  return {
    capturedAt: new Date().toISOString(),
    overlayHidden: true,
    viewport: buildScreenshotViewportContext(),
    url: toText(source.url),
    title: toText(source.title),
    pageContext: toText(source.pageContext),
    pageType: toText(source.pageType),
    repoFullName: toText(source.repoFullName),
    branch: toText(source.branch),
    filePath: toText(source.filePath),
    languageHint: toText(source.languageHint),
    codespaceBreadcrumbs: Array.isArray(source.codespaceBreadcrumbs) ? source.codespaceBreadcrumbs.slice(0, 12) : [],
    codespaceActiveTabs: Array.isArray(source.codespaceActiveTabs) ? source.codespaceActiveTabs.slice(0, 8) : [],
    visibleError: toText(source.visibleError).slice(0, 800),
    selection: toText(source.selection).slice(0, 2400),
    visibleText: toText(source.text).slice(0, 6000),
    codeSnippet: toText(source.codeSnippet).slice(0, 12000),
    codeLineCount: Math.max(0, Number(source.codeLineCount) || 0),
    explorerEntries: explorerEntries
      .map((entry) => ({
        type: toText(entry?.type),
        name: toText(entry?.name),
        path: toText(entry?.path),
        level: Math.max(0, Number(entry?.level) || 0),
      }))
      .filter((entry) => entry.path)
      .slice(0, 500),
  };
}

async function captureVisibleTabDataUrl(options = {}) {
  const hideOverlay = options?.hideOverlay !== false;
  const restoreOverlay = hideOverlay ? hideOverlayForScreenshotCapture() : () => {};
  if (hideOverlay) {
    await waitForScreenshotCaptureSettle();
  }

  try {
    return await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "ADACEEN_CAPTURE_VISIBLE_TAB" }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || "No se pudo capturar la pantalla visible."));
          return;
        }

        const dataUrl = toText(response?.dataUrl);
        if (!response?.ok || !dataUrl) {
          reject(new Error(toText(response?.error) || "No se recibió imagen de captura."));
          return;
        }

        resolve(dataUrl);
      });
    });
  } finally {
    restoreOverlay();
  }
}

async function refreshProjectContextInsightFromScreenshot(options = {}) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const repoFullName = getCurrentRepoFullName();
  const silent = options?.silent !== false;
  if (!overlayState.autoConfigEnabled || !baseUrl || !overlayState.sessionId || !repoFullName) {
    return;
  }

  const context = buildPayload();
  overlayState.context = context;
  if (context.pageType !== "codespace") {
    return;
  }

  try {
    const captureContext = buildScreenshotCaptureContext(context);
    const imageDataUrl = await captureVisibleTabDataUrl({ hideOverlay: true });
    const response = await fetchJsonWithTimeout(
      `${baseUrl}/api/projects/context/screenshot-insight`,
      {
        method: "POST",
        headers: buildApiHeaders(),
        body: JSON.stringify({
          repoFullName,
          imageDataUrl,
          captureContext,
          useModel: true,
        }),
      },
      OCR_BACKEND_TIMEOUT_MS,
    );
    overlayState.projectContextInsight = normalizeProjectContextInsightPayload(response);

    if (!silent && overlayState.projectContextInsight.screenshotUsed) {
      const mainFile = toText(overlayState.projectContextInsight.mainFilePath) || "sin detectar";
      const savedPath = toText(overlayState.projectContextInsight.screenshotSavedPath);
      overlayState.statusMessage = savedPath
        ? `OCR aplicado en screenshot. Archivo principal: ${mainFile}. Captura: ${savedPath}`
        : `OCR aplicado en screenshot. Archivo principal: ${mainFile}.`;
    }
    return true;
  } catch (error) {
    if (!silent) {
      const message = String(error);
      if (/Tiempo de espera agotado/i.test(message)) {
        overlayState.statusMessage =
          "No se pudo aplicar OCR sobre screenshot: el modelo tardó demasiado en responder. Reintenta en unos segundos.";
      } else {
        overlayState.statusMessage = `No se pudo aplicar OCR sobre screenshot: ${message}`;
      }
    }
    return false;
  }
}

async function rerunScreenshotOcrFromDashboard() {
  const context = overlayState.context || buildPayload();
  const repoFullName = getCurrentRepoFullName();

  if (!overlayState.autoConfigEnabled) {
    overlayState.statusMessage = "Activa configuracion automatica para usar OCR.";
    renderOverlay();
    return;
  }
  if (!repoFullName) {
    overlayState.statusMessage = "No se detecta repositorio activo para OCR.";
    renderOverlay();
    return;
  }
  if (context.pageType !== "codespace") {
    overlayState.statusMessage = "Reintentar OCR solo esta disponible en Codespaces.";
    renderOverlay();
    return;
  }

  overlayState.projectContextBusy = true;
  overlayState.projectContextError = "";
  overlayState.projectContextMessage = "Capturando screenshot visible para OCR...";
  overlayState.statusMessage = "Capturando screenshot y aplicando OCR...";
  renderOverlay();

  try {
    const ok = await refreshProjectContextInsightFromScreenshot({ silent: false });
    overlayState.projectContextMessage = ok
      ? "OCR manual actualizado."
      : "OCR manual completado con errores.";
  } finally {
    overlayState.projectContextBusy = false;
    renderOverlay();
  }
}

async function refreshProjectContextPanel() {
  const repoFullName = getCurrentRepoFullName();
  if (!repoFullName) {
    overlayState.projectContextStatus = { ...EMPTY_PROJECT_CONTEXT_STATUS };
    overlayState.projectContextHistory = [];
    overlayState.projectContextInsight = { ...EMPTY_PROJECT_CONTEXT_INSIGHT };
    overlayState.documentClassifications = { ...EMPTY_DOCUMENT_CLASSIFICATION_STATE };
    overlayState.projectContextError = "";
    overlayState.projectContextMessage = "";
    renderOverlay();
    return;
  }

  overlayState.projectContextBusy = true;
  overlayState.projectContextError = "";
  overlayState.projectContextMessage = "Actualizando contexto y rebuilds...";
  renderOverlay();

  try {
    const jobs = [
      refreshProjectContextStatus(),
      refreshProjectContextHistory(),
      refreshDocumentClassifications(),
    ];
    if (overlayState.autoConfigEnabled) {
      jobs.push(refreshProjectContextInsight());
    } else {
      overlayState.projectContextInsight = {
        ...EMPTY_PROJECT_CONTEXT_INSIGHT,
        configured: true,
        repoFullName,
        modelEnabled: false,
        summary: "Configuracion automatica desactivada.",
      };
    }
    await Promise.all(jobs);
    const status = overlayState.projectContextStatus || EMPTY_PROJECT_CONTEXT_STATUS;
    const insight = overlayState.projectContextInsight || EMPTY_PROJECT_CONTEXT_INSIGHT;
    const versionText = insight.version || status.latestVersion || status.currentVersion || "sin version";
    overlayState.projectContextMessage = status.hasContext
      ? `Contexto actualizado para ${repoFullName} (${versionText}).`
      : `Contexto consultado para ${repoFullName}, pero aun no hay versiones guardadas.`;
  } catch (error) {
    overlayState.projectContextError = `No se pudo actualizar el contexto: ${String(error)}`;
  } finally {
    overlayState.projectContextBusy = false;
    renderOverlay();
  }
}

async function applyProjectContextRebuild(requestId = "") {
  const repoFullName = getCurrentRepoFullName();
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !repoFullName) {
    overlayState.projectContextError = "Abre un repositorio y inicia sesion para aplicar rebuild.";
    renderOverlay();
    return;
  }

  overlayState.projectContextBusy = true;
  overlayState.projectContextError = "";
  overlayState.projectContextMessage = requestId
    ? `Aplicando rebuild para ${shortenCompactId(requestId, 12)}...`
    : "Aplicando rebuild para el contexto actual...";
  renderOverlay();

  try {
    await fetchJsonWithTimeout(
      `${baseUrl}/api/projects/context/rebuild`,
      {
        method: "POST",
        headers: buildApiHeaders(),
        body: JSON.stringify({
          repoFullName,
          ...(requestId ? { requestId } : {}),
        }),
      },
      BACKEND_TIMEOUT_MS,
    );

    await refreshProjectContextPanel();
    overlayState.projectContextMessage = requestId
      ? `Rebuild aplicado para ${shortenCompactId(requestId, 12)}.`
      : `Rebuild aplicado para ${repoFullName}.`;
  } catch (error) {
    overlayState.projectContextError = `No se pudo aplicar rebuild: ${String(error)}`;
  } finally {
    overlayState.projectContextBusy = false;
    renderOverlay();
  }
}
