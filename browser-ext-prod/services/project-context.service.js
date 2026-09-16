// ADACEEN | Capa 3 - Servicios: consentimiento, escaneo del proyecto, contexto guardado y rebuilds.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

async function fetchProjectConsentStatus() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) return false;

  const response = await fetchJsonWithTimeout(`${baseUrl}/api/projects/consent`, {
    method: "GET",
    headers: buildApiHeaders(),
  });

  return !!response?.consent?.granted;
}

async function grantProjectConsent() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    throw new Error("Sesion no valida para registrar permisos.");
  }

  const response = await fetchJsonWithTimeout(`${baseUrl}/api/projects/consent`, {
    method: "POST",
    headers: buildApiHeaders(),
    body: JSON.stringify({
      canRead: true,
      canModify: true,
      canAnalyze: true,
    }),
  });

  return !!response?.consent?.granted;
}

async function ensureProjectConsentForCurrentUser() {
  const userId = getCurrentUserId();
  if (!userId) return false;
  if (overlayState.projectConsentByUser[userId] === true) return true;

  try {
    const grantedRemotely = await fetchProjectConsentStatus();
    if (grantedRemotely) {
      overlayState.projectConsentByUser[userId] = true;
      await persistPreferences();
      return true;
    }
  } catch {}

  const accepted = window.confirm(
    "Dar permiso para leer, modificar y hacer analisis sobre tu entorno?\n\n" +
    "Esto se solicitara solo una vez por usuario para guardar contexto del proyecto.",
  );
  if (!accepted) {
    return false;
  }

  const granted = await grantProjectConsent();
  if (!granted) {
    return false;
  }

  overlayState.projectConsentByUser[userId] = true;
  await persistPreferences();
  return true;
}

async function syncProjectRackToBackend(context, analysis) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !analysis) return false;

  const payload = {
    source: toText(context.pageType) || "codespace",
    repoFullName: toText(context.repoFullName),
    branch: toText(context.branch),
    generatedAt: toText(analysis.generatedAt),
    totalEntries: Number(analysis.totalEntries) || 0,
    totalFiles: Number(analysis.totalFiles) || 0,
    totalFolders: Number(analysis.totalFolders) || 0,
    files: Array.isArray(analysis.files) ? analysis.files.slice(0, 10000) : [],
    folders: Array.isArray(analysis.folders) ? analysis.folders.slice(0, 10000) : [],
    activeFilePath: toText(context.filePath),
    activeCodeSnippet: toText(context.codeSnippet).slice(0, 120000),
    activeSuggestion: toText(overlayState.vscodeSyncState?.latestRack?.activeSuggestion),
    replacementOptions: Array.isArray(overlayState.vscodeSyncState?.latestRack?.replacementOptions)
      ? overlayState.vscodeSyncState.latestRack.replacementOptions.slice(0, 8)
      : [],
  };

  const response = await fetchJsonWithTimeout(`${baseUrl}/api/projects/rack`, {
    method: "POST",
    headers: buildApiHeaders(),
    body: JSON.stringify(payload),
  }, BACKEND_TIMEOUT_MS);

  return !!response?.ok;
}

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
    await sleep(pollMs);
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
