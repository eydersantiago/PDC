// Entorno por tunel: «mi editor» (el editor guardado por usuario y repo), «Abrir mi editor» y el
// editor que ya existe en el backend. Las constantes y la preparacion estan en workspace.service.js.

// ---- Editor guardado por usuario y repo ----

function buildSavedEditorKey(userId, repoFullName) {
  const user = toText(userId);
  const repo = parseRepoFullName(repoFullName);
  return user && repo ? `${user}:${repo.toLowerCase()}` : "";
}

function getSavedTunnelEditor(repoOverride = "") {
  const key = buildSavedEditorKey(getCurrentUserId(), parseRepoFullName(repoOverride) || getCurrentRepoFullName());
  if (!key) return null;
  return overlayState.editorByUser?.[key] || null;
}

// El editor guardado mas reciente del usuario (para volver desde una pagina sin repositorio).
function getLatestSavedTunnelEditor() {
  const userId = getCurrentUserId();
  if (!userId) return null;
  const prefix = `${userId}:`;
  return Object.entries(overlayState.editorByUser || {})
    .filter(([key]) => key.startsWith(prefix))
    .map(([, record]) => record)
    .sort((a, b) => toText(b?.savedAt).localeCompare(toText(a?.savedAt)))[0] || null;
}

// Repositorio de "Abrir mi editor": el de la pagina de GitHub o, fuera de GitHub, el ultimo guardado.
function resolveMyEditorRepoFullName() {
  const context = overlayState.context || buildPayload();
  if (isGithubOrCodespaceContext(context)) {
    const current = getCurrentRepoFullName();
    if (current) return current;
  }
  return parseRepoFullName(getLatestSavedTunnelEditor()?.repoFullName);
}

// Rotulo del boton del editor para un repositorio: "Abrir mi editor" con un editor guardado;
// si no (primera preparacion fallida, vencida o en otro navegador), "Preparar mi editor". Los
// mensajes que mandan a pulsarlo usan el mismo rotulo que el boton que se ve.
function myEditorButtonLabel(repoFullName = "") {
  return getSavedTunnelEditor(repoFullName) ? "Abrir mi editor" : "Preparar mi editor";
}

// Boton que hay que volver a pulsar si la espera termina mal: el del overlay o, si se llego
// desde la pagina del repositorio, «Abrir en mi editor» (0.7.20). Solo etiquetas conocidas.
const TUNNEL_RETRY_BUTTON_LABELS = ["Abrir en mi editor", "Abrir mi editor", "Preparar mi editor", "Reconectar con mi cuenta"];

function tunnelRetryButtonLabel(repoFullName = "", requested = "") {
  const label = toText(requested);
  return TUNNEL_RETRY_BUTTON_LABELS.includes(label) ? label : myEditorButtonLabel(repoFullName);
}

// Ultima eleccion de editor del usuario: "local_vscode" (VS Code de este equipo, por ejemplo
// en la Mac del laboratorio) o "cloud" (editor en la nube). Al volver otro dia la accion
// principal es la ultima que uso.
function getLastEditorChoice() {
  const userId = getCurrentUserId();
  return userId ? toText(overlayState.editorChoiceByUser?.[userId]) : "";
}

// Lee, mezcla y escribe solo esta clave (como updateSavedEditorMap): otra pestana pudo
// guardar su eleccion mientras tanto.
async function rememberEditorChoice(choice) {
  const userId = getCurrentUserId();
  if (!userId || !EDITOR_CHOICES.includes(choice)) return false;
  let current = overlayState.editorChoiceByUser || {};
  if (isExtensionRuntimeReady()) {
    try {
      const stored = await chrome.storage.local.get([STORAGE_KEY_EDITOR_CHOICE_BY_USER]);
      current = normalizeEditorChoiceMap(stored?.[STORAGE_KEY_EDITOR_CHOICE_BY_USER]);
    } catch {}
  }
  if (current[userId] === choice && overlayState.editorChoiceByUser?.[userId] === choice) return true;
  const next = normalizeEditorChoiceMap({ ...current, [userId]: choice });
  overlayState.editorChoiceByUser = next;
  if (!isExtensionRuntimeReady()) return false;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_EDITOR_CHOICE_BY_USER]: next });
    return true;
  } catch {
    return false;
  }
}

// Lee, mezcla y escribe solo esta clave: otra pestana pudo guardar su editor mientras tanto.
async function updateSavedEditorMap(mutate) {
  let current = overlayState.editorByUser || {};
  if (isExtensionRuntimeReady()) {
    try {
      const stored = await chrome.storage.local.get([STORAGE_KEY_EDITOR_BY_USER]);
      current = normalizeSavedEditorMap(stored?.[STORAGE_KEY_EDITOR_BY_USER]);
    } catch {}
  }
  const next = normalizeSavedEditorMap(mutate({ ...current }) || current);
  overlayState.editorByUser = next;
  if (!isExtensionRuntimeReady()) return false;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_EDITOR_BY_USER]: next });
    return true;
  } catch {
    return false;
  }
}

// options.sessionWritten: el editor quedo listo tras un prepare, que escribe (o renueva) la
// sesion de VS Code en la VM. Si solo se consulto status, se conserva la fecha anterior.
async function saveTunnelEditor(repoFullName, webUrl, options = {}) {
  const key = buildSavedEditorKey(getCurrentUserId(), repoFullName);
  const safeUrl = toSafeHttpUrl(webUrl);
  if (!key || !isTunnelEditorUrl(safeUrl)) return false;
  const nowIso = new Date(Date.now()).toISOString();
  return updateSavedEditorMap((map) => {
    const previous = map[key] || null;
    const sessionWritten = options?.sessionWritten === true;
    map[key] = {
      repoFullName: parseRepoFullName(repoFullName),
      webUrl: safeUrl,
      provider: "tunnel",
      savedAt: nowIso,
      needsSessionRefresh: sessionWritten ? false : previous?.needsSessionRefresh === true,
      sessionWrittenAt: sessionWritten ? nowIso : toText(previous?.sessionWrittenAt),
      // Cuando este navegador lo abrio por ultima vez (vscode.dev ya conoce la cuenta).
      openedAt: options?.opened === true ? nowIso : toText(previous?.openedAt),
    };
    return map;
  });
}

// editors del backend (0.7.20): los repositorios que ya estan en la VM. Los que este
// navegador no tenia se guardan sin fecha (no pasan a ser «el ultimo editor») y sin
// sesion escrita (el primer «Abrir mi editor» pasa por prepare, que es idempotente); a los
// que ya estaban solo se les corrige la URL si cambio de carpeta.
async function rememberTunnelEditorsFromBackend(editors) {
  const userId = getCurrentUserId();
  const valid = (Array.isArray(editors) ? editors : [])
    .map((item) => ({ repoFullName: parseRepoFullName(item?.repoFullName), webUrl: toSafeHttpUrl(item?.webUrl) }))
    .filter((item) => item.repoFullName && isTunnelEditorUrl(item.webUrl))
    .slice(0, 50);
  if (!userId || !valid.length) return false;
  const missing = valid.filter((item) => overlayState.editorByUser?.[buildSavedEditorKey(userId, item.repoFullName)]?.webUrl !== item.webUrl);
  if (!missing.length) return false;
  return updateSavedEditorMap((map) => {
    for (const item of missing) {
      const key = buildSavedEditorKey(userId, item.repoFullName);
      const previous = map[key] || null;
      map[key] = previous
        ? { ...previous, webUrl: item.webUrl }
        : {
          repoFullName: item.repoFullName,
          webUrl: item.webUrl,
          provider: "tunnel",
          savedAt: "",
          needsSessionRefresh: false,
          sessionWrittenAt: "",
        };
    }
    return map;
  });
}

// Editores guardados del usuario, para la lista de Inicio: el mas reciente primero.
function listSavedTunnelEditors() {
  const userId = getCurrentUserId();
  if (!userId) return [];
  const prefix = `${userId}:`;
  return Object.entries(overlayState.editorByUser || {})
    .filter(([key, record]) => key.startsWith(prefix) && record?.repoFullName)
    .map(([, record]) => record)
    .sort((a, b) => toText(b?.savedAt).localeCompare(toText(a?.savedAt))
      || toText(a?.repoFullName).localeCompare(toText(b?.repoFullName)));
}

// La sesion de VS Code que prepare escribe en la VM vence a los 30 dias y el backend la
// reutiliza mientras le queden mas de 7: pasar por prepare cada 7 dias la renueva a tiempo.
// Sin registro, sin fecha o tras cerrar sesion tambien se pasa por prepare (idempotente).
const SAVED_EDITOR_SESSION_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

function savedEditorNeedsSessionRefresh(saved, now = Date.now()) {
  if (!saved || saved.needsSessionRefresh === true) return true;
  const writtenAt = Date.parse(toText(saved.sessionWrittenAt));
  return !Number.isFinite(writtenAt) || now - writtenAt > SAVED_EDITOR_SESSION_REFRESH_MS;
}

// Al cerrar sesion el backend desactiva tambien las sesiones de VS Code (seccion 1):
// el siguiente "Abrir mi editor" pasa por prepare para escribir una sesion nueva en la VM.
async function markSavedEditorsNeedSessionRefresh(userId) {
  const prefix = `${toText(userId)}:`;
  if (prefix === ":") return false;
  return updateSavedEditorMap((map) => {
    for (const [key, record] of Object.entries(map)) {
      if (key.startsWith(prefix) && record) {
        map[key] = { ...record, needsSessionRefresh: true };
      }
    }
    return map;
  });
}

// «Abrir mi editor» en marcha, desde el clic: entre el clic y el momento en que prepare marca
// githubAppBusy hay esperas (estado, cuenta de GitHub). Sin esto, un doble clic abria dos
// ventanas de espera y mandaba dos prepare.
let myTunnelEditorOpening = false;

function isMyTunnelEditorOpening() {
  return myTunnelEditorOpening;
}

// "Abrir mi editor": consulta el estado y abre; si no esta listo (VM apagada, sin preparar o
// con la sesion de VS Code por renovar) prepara, que es idempotente.
async function openMyTunnelEditor(options = {}) {
  const repoFullName = parseRepoFullName(options?.repoFullName) || resolveMyEditorRepoFullName();
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!repoFullName || !baseUrl || !overlayState.sessionId) {
    overlayState.statusMessage = "Inicia sesion y abre tu repositorio en GitHub para abrir tu editor.";
    renderOverlay();
    return false;
  }
  if (overlayState.githubAppBusy || myTunnelEditorOpening) {
    overlayState.statusMessage = "ADACEEN ya esta preparando tu editor; la ventana de espera se abrira sola.";
    renderOverlay();
    return false;
  }
  myTunnelEditorOpening = true;
  try {
    return await openMyTunnelEditorNow(repoFullName, baseUrl, options);
  } finally {
    myTunnelEditorOpening = false;
  }
}

async function openMyTunnelEditorNow(repoFullName, baseUrl, options = {}) {
  // Desde una pagina sin GitHub el proveedor aun no se consulto: un editor guardado es del
  // tunel (refreshWorkspaceProvider lo corrige en la siguiente consulta).
  if (!overlayState.workspaceProvider && getSavedTunnelEditor(repoFullName)) {
    overlayState.workspaceProvider = "tunnel";
  }
  // La ventana se abre en el mismo clic, antes de cualquier await: asi el navegador no la bloquea.
  const pendingWindow = options?.pendingWindow && !options.pendingWindow.closed
    ? options.pendingWindow
    : openCodespaceWaitingWindow(repoFullName);
  rememberEditorChoice("cloud").catch(() => false);
  updateCodespaceWaitingWindow(pendingWindow, "Comprobando tu editor", "Revisando que tu editor en la nube este encendido...", "", "");
  setTunnelWaitingStep(pendingWindow, overlayState.githubUserStatus?.connected === true ? "start" : "account");
  overlayState.githubAppBusy = true;
  setOperationProgress("Comprobando tu editor", `Revisando tu editor de ${repoFullName}...`);

  const saved = getSavedTunnelEditor(repoFullName);
  let info = null;
  if (!savedEditorNeedsSessionRefresh(saved)) {
    try {
      info = describeWorkspaceStatus(await fetchJsonWithTimeout(
        `${baseUrl}/api/workspaces/status?repoFullName=${encodeURIComponent(repoFullName)}`,
        { method: "GET", headers: buildApiHeaders() },
        WORKSPACE_STATUS_TIMEOUT_MS,
      ));
    } catch (error) {
      // 409: el backend volvio a Codespaces; el editor guardado ya no aplica.
      if (/codespaces/i.test(String(error?.message || error))) {
        overlayState.githubAppBusy = false;
        if (pendingWindow) pendingWindow.close();
        overlayState.workspaceProvider = "codespaces";
        clearOperationProgress("El piloto usa Codespaces: abre tu repositorio en GitHub y usa Abrir Codespaces.");
        renderOverlay();
        return false;
      }
      info = null;
    }
  }

  overlayState.githubAppBusy = false;
  // Solo se abre una URL de VS Code Tunnels (vscode.dev/tunnel/...): otra cosa pasa por prepare.
  if (info?.status === "ready" && isTunnelEditorUrl(toSafeHttpUrl(info.webUrl))) {
    return finishTunnelWorkspace(pendingWindow, info, repoFullName);
  }
  await prepareTunnelWorkspace({ pendingWindow, repoFullName, buttonLabel: options?.buttonLabel });
  return true;
}

// Otro navegador o equipo (item 11 de la auditoria): el editor existe en el backend aunque
// este navegador no lo tenga guardado. Al entrar se consulta una vez por usuario y repo
// (GET /api/workspaces/status); si esta listo se guarda y el overlay ofrece "Abrir mi editor"
// en vez del tour. Se guarda sin fecha de sesion: el primer "Abrir mi editor" pasa por
// prepare (idempotente), que renueva la sesion de VS Code en la VM.
const existingEditorChecks = new Set();

const EXISTING_EDITOR_CHECK_TIMEOUT_MS = 8000;

async function adoptExistingTunnelEditor(repoOverride = "") {
  if (!isTunnelProvider() || isWorkspaceProviderProvisional()) return false;
  // Cualquiera con sesion puede tener editor (0.7.20: el boton de GitHub es para todos).
  if (!hasActiveSession()) return false;
  const repoFullName = parseRepoFullName(repoOverride) || getCurrentRepoFullName();
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const userId = getCurrentUserId();
  const sessionId = toText(overlayState.sessionId);
  const key = buildSavedEditorKey(userId, repoFullName);
  if (!key || !baseUrl || !sessionId) return false;
  // Sin la cuenta de GitHub conectada no puede haber editor (se registra a su nombre).
  if (overlayState.githubUserStatus?.connected !== true || overlayState.githubAppBusy) return false;
  if (getSavedTunnelEditor(repoFullName) || existingEditorChecks.has(key)) return false;
  existingEditorChecks.add(key);
  try {
    // passive=1: solo mirar. Entrar en una pagina no enciende la VM ni reenvia una
    // preparacion pendiente (eso queda para el clic en «Abrir en mi editor»).
    const payload = await fetchJsonWithTimeout(
      `${baseUrl}/api/workspaces/status?repoFullName=${encodeURIComponent(repoFullName)}&passive=1`,
      { method: "GET", headers: buildApiHeaders() },
      EXISTING_EDITOR_CHECK_TIMEOUT_MS,
    );
    const info = describeWorkspaceStatus(payload);
    const workspaceRepo = parseRepoFullName(payload?.workspace?.repoFullName);
    // Mientras tanto pudo cambiar la cuenta (Mac compartida: salir y entrar con otra) o la
    // sesion: el editor de la cuenta anterior no se guarda a nombre de la nueva.
    const sameAccount = () => getCurrentUserId() === userId && toText(overlayState.sessionId) === sessionId;
    let adopted = false;
    if (info.status === "ready" && isTunnelEditorUrl(toSafeHttpUrl(info.webUrl))
      && (!workspaceRepo || workspaceRepo.toLowerCase() === repoFullName.toLowerCase())
      && sameAccount()
      // Mientras tanto pudo empezar una preparacion: esa guarda el editor al terminar.
      && !overlayState.githubAppBusy && !getSavedTunnelEditor(repoFullName)) {
      adopted = await saveTunnelEditor(repoFullName, info.webUrl);
    }
    // Aunque este repositorio no este en la VM, los que si estan se pueden ofrecer (0.7.20).
    if (sameAccount()) await rememberTunnelEditorsFromBackend(info.editors).catch(() => false);
    return adopted;
  } catch {
    return false;
  }
}
