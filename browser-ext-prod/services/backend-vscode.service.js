// ADACEEN | Capa 3 - Servicios: consentimiento del proyecto, rack de codigo y sincronizacion con la
// extension de VS Code (presencia y estado; las opciones de reemplazo y su cola se quitaron en la 0.8.3).
// Movido sin cambios desde services/backend.service.js.
// Sin "use strict": el codigo viene de backend.service.js (modo no estricto) y se conserva igual.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

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

// 0.8.3: sin la paleta junto al cursor ya no se arman aqui opciones de reemplazo (eran las que,
// sin codigo del tutor, agregaban un comentario «TODO»). VS Code aplica el codigo que escribe el
// tutor desde su propia ventana de la seleccion.

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
    generatedAt: toText(source.generatedAt || source.generated_at),
    createdAt: toText(source.createdAt || source.created_at),
    updatedAt: toText(source.updatedAt || source.updated_at || source.createdAt || source.created_at),
  };
}

// "VS Code conectado" exige actividad reciente: un rack de hace mas de 10 min suele ser de
// una sesion de VS Code que ya no publica (cerrada o desvinculada). Sin fecha se acepta,
// como antes.
const VSCODE_RACK_FRESH_MS = 10 * 60 * 1000;

function isVscodeRackFresh(rack, now = Date.now()) {
  const updatedAt = Date.parse(toText(rack?.updatedAt || rack?.generatedAt));
  if (!Number.isFinite(updatedAt)) return true;
  return now - updatedAt <= VSCODE_RACK_FRESH_MS;
}

// Solo la extension de VS Code publica con source "vscode_extension". Sin racks de VS Code el
// backend devuelve el ultimo de cualquier origen, incluido el que publica este overlay al
// explorar el proyecto (source = pageType, p. ej. "codespace"): ese no prueba que VS Code este
// conectado.
function isRackFromVscodeExtension(rack) {
  return toText(rack?.source) === "vscode_extension";
}

// Fuera del editor web (p. ej. en github.com): una consulta para saber si VS Code (tunel,
// local o Codespace) publico contexto hace poco para el repo actual.
async function refreshVscodePresence() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const repoFullName = getCurrentRepoFullName();
  if (!baseUrl || !overlayState.sessionId || !repoFullName) {
    overlayState.vscodePresence = { ...EMPTY_VSCODE_PRESENCE };
    return overlayState.vscodePresence;
  }
  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/projects/session/state`, {
      method: "GET",
      headers: buildApiHeaders(),
    }, 15000);
    const rack = normalizeVscodeRackPayload(response?.state?.latestRack);
    const sameRepo = !!rack.repoFullName && rack.repoFullName.toLowerCase() === repoFullName.toLowerCase();
    overlayState.vscodePresence = {
      repoFullName,
      connected: !!rack.id && sameRepo && isRackFromVscodeExtension(rack) && isVscodeRackFresh(rack),
      updatedAt: rack.updatedAt,
    };
  } catch {
    overlayState.vscodePresence = { ...EMPTY_VSCODE_PRESENCE };
  }
  return overlayState.vscodePresence;
}

async function refreshVscodeSyncState(options = {}) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const context = overlayState.context || buildPayload();
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
    const fresh = connected && isRackFromVscodeExtension(preferredRack) && isVscodeRackFresh(preferredRack);
    overlayState.vscodeSyncState = {
      connected,
      fresh,
      busy: false,
      error: "",
      message: connected && !fresh
        ? "VS Code no ha publicado contexto en los ultimos 10 min. Abre un archivo en VS Code o revisa que ADACEEN este conectado (barra de estado)."
        : connected
        ? hasFileRack
          ? "VS Code sincronizado con el archivo activo."
          : `VS Code sincronizado con este ${isTunnelEditorPage(context) ? "editor" : "Codespace"}.`
        : rack.id
          ? "VS Code publico contexto de otro repositorio."
          : "Aun no hay estado publicado desde VS Code.",
      latestRack: connected ? preferredRack : null,
      latestRackForFile: hasFileRack ? fileRack : null,
      globalLatestRack: !!rack.id && sameRepo ? rack : null,
      updatedAt: preferredRack.updatedAt || rack.updatedAt || "",
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
