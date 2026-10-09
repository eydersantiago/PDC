// Estrategia de entorno por tunel de VS Code (plan B a Codespaces).
//
// El backend decide que proveedor esta activo (GET /api/workspaces/provider):
//   - "codespaces": todo sigue igual que hasta ahora.
//   - "tunnel":     "Preparar entorno" pide al backend un editor en la VM de
//                   Google Cloud; la primera vez GitHub exige un codigo de un
//                   solo uso (github.com/login/device), que se le muestra al
//                   estudiante aqui; cuando el tunel esta arriba se abre
//                   https://vscode.dev/tunnel/<nombre>/... en la ventana de
//                   espera, igual que se abriria un Codespace.
//
// Contrato con el backend (rama feat/workspace-tunnel de PDC):
//   GET  /api/workspaces/provider
//        -> { ok, provider: "tunnel" | "codespaces" }
//   POST /api/workspaces/prepare   { repoFullName, force? }
//   GET  /api/workspaces/status?repoFullName=...
//        -> { ok, provider: "tunnel",
//             status: "ready" | "device_code" | "pending" | "error",
//             workspace: { login, tunnelName, webUrl, repoFullName },
//             deviceCode?: { userCode, verificationUrl, expiresAt },
//             message?: string, code?: string, retryable?: boolean }
//
// Acceso simplificado (docs/arquitectura/acceso-simplificado.md, seccion 4):
//   - con el tunel el tour no pide la GitHub App: basta conectar GitHub;
//   - el editor listo se guarda por usuario y repo (STORAGE_KEY_EDITOR_BY_USER)
//     y al volver otro dia "Abrir mi editor" consulta status y abre (o prepara,
//     que es idempotente);
//   - los errores con retryable: true (VM apagada o encendiendose) no cortan la
//     espera: la ventana sigue consultando y muestra el mensaje del backend;
//   - con codigo de dispositivo, la ventana de espera pasa a
//     github.com/login/device (que muestra el codigo) y despues al editor.
//
// Un editor, varios repositorios (0.7.20): el backend clona cada repositorio en su
// propia carpeta del mismo tunel, asi que el editor guardado por usuario y repo ya
// abre la carpeta de ese repositorio (webUrl distinta por repo) y abrir otro repo no
// pide otro codigo. status y prepare traen editors (los repositorios que ya estan en
// la VM): se guardan para ofrecerlos en Inicio («Tus repositorios en el editor») y en
// el boton «Abrir en mi editor» de la pagina de GitHub (content-repo-button.js).
//
// Si el backend no conoce estas rutas (404), el proveedor es "codespaces" y
// este archivo no interviene.

const WORKSPACE_PROVIDER_TTL_MS = 5 * 60 * 1000;
// Tras un fallo pasajero (sin red, timeout o 5xx) el proveedor se vuelve a consultar pronto.
const WORKSPACE_PROVIDER_RETRY_MS = 15000;
const WORKSPACE_PREPARE_TIMEOUT_MS = 120000;
const WORKSPACE_STATUS_TIMEOUT_MS = 15000;
const WORKSPACE_POLL_MS = 3000;
// GitHub deja el codigo de dispositivo vivo ~15 min; se espera algo menos.
const WORKSPACE_POLL_TIMEOUT_MS = 12 * 60 * 1000;
const DEVICE_CODE_HANDOFF_TTL_MS = 15 * 60 * 1000;
// La espera del codigo "late" en el handoff; si deja de latir (la pestana de origen se recargo
// o se cerro), el aviso de github.com/login/device deja de prometer que abrira el editor.
const DEVICE_CODE_HANDOFF_HEARTBEAT_MS = 15000;
const DEVICE_CODE_HANDOFF_STALE_MS = 60000;
const DEVICE_CODE_HELPER_CHECK_MS = 10000;
// Tras un fallo, el desenlace se deja un rato para que el aviso abierto lo muestre.
const DEVICE_CODE_OUTCOME_TTL_MS = 2 * 60 * 1000;
// Si el handoff desaparece (editor listo, cierre de sesion), la pestana suele navegar al
// editor enseguida; si sigue aqui pasado este margen, el aviso lo dice.
const DEVICE_CODE_GONE_GRACE_MS = 8000;
// Copia automatica solo recien emitido el codigo (la ventana de espera llego aqui por el
// flujo); una visita posterior a github.com/login/device no toca el portapapeles.
const DEVICE_CODE_AUTO_COPY_MS = 60000;
const GITHUB_DEVICE_LOGIN_URL = "https://github.com/login/device";
const DEVICE_CODE_HELPER_HOST_ID = "adaceen-device-code-helper";
// Aviso de la primera entrada al editor (vscode.dev pide iniciar sesion): vale unos minutos.
const TUNNEL_SIGNIN_HINT_TTL_MS = 10 * 60 * 1000;
const TUNNEL_SIGNIN_HINT_HOST_ID = "adaceen-tunnel-signin-hint";

let workspaceProviderCheckedAt = 0;
let workspaceProviderInFlight = null;
// true si el valor actual es un respaldo por un fallo pasajero, no la respuesta del backend.
let workspaceProviderProvisional = false;

function isTunnelProvider() {
  return toText(overlayState.workspaceProvider) === "tunnel";
}

function editorNoun(capitalized = false) {
  const noun = isTunnelProvider() ? "editor" : "Codespace";
  return capitalized ? noun.charAt(0).toUpperCase() + noun.slice(1) : noun;
}

async function refreshWorkspaceProvider(force = false) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl) return "";
  const fresh = Date.now() - workspaceProviderCheckedAt < WORKSPACE_PROVIDER_TTL_MS;
  if (!force && fresh && overlayState.workspaceProvider) {
    return overlayState.workspaceProvider;
  }
  // Una sola consulta a la vez: refreshGithubAppStatus y refreshGithubIntegrationStatus
  // la piden en paralelo.
  if (workspaceProviderInFlight) return workspaceProviderInFlight;
  workspaceProviderInFlight = (async () => {
    try {
      const response = await fetchJsonWithTimeout(
        `${baseUrl}/api/workspaces/provider`,
        { method: "GET", headers: buildApiHeaders() },
        8000,
      );
      overlayState.workspaceProvider = toText(response?.provider) || "codespaces";
      workspaceProviderProvisional = false;
      workspaceProviderCheckedAt = Date.now();
    } catch (error) {
      if (Number(error?.status) === 404) {
        // Backend sin la ruta: Codespaces, que es lo de siempre.
        overlayState.workspaceProvider = "codespaces";
        workspaceProviderProvisional = false;
        workspaceProviderCheckedAt = Date.now();
      } else {
        // Sin red, timeout o 5xx (p. ej. arranque en frio del backend): respaldo provisional
        // que no se fija 5 min. Con un editor del tunel guardado se asume el tunel, para no
        // ofrecer "Crear PR y Codespace" a quien ya tiene su editor.
        if (!overlayState.workspaceProvider || workspaceProviderProvisional) {
          overlayState.workspaceProvider = getLatestSavedTunnelEditor() ? "tunnel" : "codespaces";
        }
        workspaceProviderProvisional = true;
        workspaceProviderCheckedAt = Date.now() - WORKSPACE_PROVIDER_TTL_MS + WORKSPACE_PROVIDER_RETRY_MS;
      }
    }
    return overlayState.workspaceProvider;
  })();
  try {
    return await workspaceProviderInFlight;
  } finally {
    workspaceProviderInFlight = null;
  }
}

function isWorkspaceProviderProvisional() {
  return workspaceProviderProvisional;
}

function describeWorkspaceStatus(payload) {
  return {
    status: toText(payload?.status).toLowerCase(),
    webUrl: toText(payload?.workspace?.webUrl),
    login: toText(payload?.workspace?.login),
    userCode: toText(payload?.deviceCode?.userCode),
    verificationUrl: toText(payload?.deviceCode?.verificationUrl) || GITHUB_DEVICE_LOGIN_URL,
    expiresAt: toText(payload?.deviceCode?.expiresAt),
    message: toText(payload?.message),
    code: toText(payload?.code),
    retryable: payload?.retryable === true,
    editors: Array.isArray(payload?.editors) ? payload.editors : [],
  };
}

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
const TUNNEL_RETRY_BUTTON_LABELS = ["Abrir en mi editor", "Abrir mi editor", "Preparar mi editor"];
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

// ---- Codigo de dispositivo en una sola pestana ----

function isGithubDeviceLoginUrl(value) {
  try {
    const url = new URL(toText(value));
    return url.protocol === "https:"
      && url.hostname.toLowerCase() === "github.com"
      && /^\/login\/device(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function isGithubDeviceLoginPage() {
  return isGithubDeviceLoginUrl(location.href);
}

// En que paso del codigo de dispositivo esta una pagina de GitHub:
//  - "signin": GitHub pide iniciar sesion antes de mostrar los cuadros del codigo;
//  - "code": github.com/login/device, los cuadros del codigo;
//  - "authorize": despues del codigo (autorizar Visual Studio Code, elegir cuenta...);
//  - "done" / "failed": GitHub confirmo o rechazo.
// "" en cualquier otra pagina.
function githubDeviceFlowStep(value = location.href) {
  try {
    const url = new URL(toText(value));
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return "";
    const path = url.pathname.toLowerCase().replace(/\/+$/, "") || "/";
    if (path === "/login/device") return "code";
    if (path.startsWith("/login/device/")) {
      if (/success|done|complete/.test(path)) return "done";
      if (/fail|denied|error|cancel/.test(path)) return "failed";
      return "authorize";
    }
    if (path === "/login" || path === "/session" || path.startsWith("/sessions/")) return "signin";
    return "";
  } catch {
    return "";
  }
}

// Cuenta de GitHub abierta en esta pagina (GitHub la publica en <meta name="user-login">), en
// minusculas; "" sin sesion o si GitHub no la publica.
function readGithubSignedInLogin() {
  const meta = document.querySelector('meta[name="user-login"]') || document.querySelector('meta[name="octolytics-actor-login"]');
  return normalizeGithubLoginHint(meta?.getAttribute?.("content"));
}

function normalizeDeviceUserCode(value) {
  const code = toText(value).toUpperCase();
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code) ? code : "";
}

// Login de GitHub en minusculas (como lo usa el tunel), o "".
function normalizeGithubLoginHint(value) {
  const login = toText(value).toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(login) ? login : "";
}

// La cuenta con la que hay que autorizar el codigo y entrar a vscode.dev: la del tunel (el
// backend la manda en workspace.login) o, si no vino, la conectada en ADACEEN.
function expectedTunnelGithubLogin(info) {
  return normalizeGithubLoginHint(info?.login) || normalizeGithubLoginHint(overlayState.githubUserStatus?.accountLogin);
}

// El handoff queda ligado al usuario de ADACEEN que pidio el codigo (equipos compartidos).
async function saveDeviceCodeHandoff(info, repoFullName, buttonLabel = "") {
  const userCode = normalizeDeviceUserCode(info?.userCode);
  const userId = getCurrentUserId();
  if (!userCode || !userId || !isExtensionRuntimeReady()) return false;
  const now = Date.now();
  const reportedExpiry = Date.parse(toText(info?.expiresAt));
  const expiresAt = Number.isFinite(reportedExpiry) && reportedExpiry > now
    ? Math.min(reportedExpiry, now + DEVICE_CODE_HANDOFF_TTL_MS)
    : now + DEVICE_CODE_HANDOFF_TTL_MS;
  try {
    await chrome.storage.local.set({
      [STORAGE_KEY_DEVICE_CODE_HANDOFF]: {
        userCode,
        userId,
        repoFullName: parseRepoFullName(repoFullName),
        githubLogin: expectedTunnelGithubLogin(info),
        buttonLabel: TUNNEL_RETRY_BUTTON_LABELS.includes(toText(buttonLabel)) ? toText(buttonLabel) : "",
        expiresAt,
        savedAt: now,
        aliveAt: now,
      },
    });
    return true;
  } catch {
    return false;
  }
}

function normalizeDeviceCodeHandoff(raw) {
  const userCode = normalizeDeviceUserCode(raw?.userCode);
  const expiresAt = Number(raw?.expiresAt) || 0;
  if (!userCode || expiresAt <= Date.now()) return null;
  return {
    userCode,
    userId: toText(raw?.userId),
    repoFullName: parseRepoFullName(raw?.repoFullName),
    githubLogin: normalizeGithubLoginHint(raw?.githubLogin),
    buttonLabel: TUNNEL_RETRY_BUTTON_LABELS.includes(toText(raw?.buttonLabel)) ? toText(raw?.buttonLabel) : "",
    expiresAt,
    savedAt: Number(raw?.savedAt) || 0,
    aliveAt: Number(raw?.aliveAt) || Number(raw?.savedAt) || 0,
    outcome: toText(raw?.outcome),
    message: toText(raw?.message),
  };
}

async function readDeviceCodeHandoff() {
  if (!isExtensionRuntimeReady()) return null;
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY_DEVICE_CODE_HANDOFF]);
    const raw = stored?.[STORAGE_KEY_DEVICE_CODE_HANDOFF];
    const handoff = normalizeDeviceCodeHandoff(raw);
    if (!handoff) {
      if (raw) await chrome.storage.local.remove([STORAGE_KEY_DEVICE_CODE_HANDOFF]).catch(() => {});
      return null;
    }
    return handoff;
  } catch {
    return null;
  }
}

// Actualiza el handoff solo si sigue siendo el de este codigo (otra espera pudo reemplazarlo).
async function updateDeviceCodeHandoff(userCode, patch) {
  if (!userCode || !isExtensionRuntimeReady()) return false;
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY_DEVICE_CODE_HANDOFF]);
    const raw = stored?.[STORAGE_KEY_DEVICE_CODE_HANDOFF];
    if (!raw || normalizeDeviceUserCode(raw.userCode) !== userCode || raw.outcome) return false;
    await chrome.storage.local.set({ [STORAGE_KEY_DEVICE_CODE_HANDOFF]: { ...raw, ...patch(raw) } });
    return true;
  } catch {
    return false;
  }
}

function touchDeviceCodeHandoff(userCode) {
  return updateDeviceCodeHandoff(userCode, () => ({ aliveAt: Date.now() }));
}

// La espera termino sin editor (error, tiempo agotado o excepcion): el aviso abierto en
// github.com/login/device lo muestra en vez de seguir prometiendo que abrira el editor.
function settleDeviceCodeHandoffWithError(userCode, message) {
  return updateDeviceCodeHandoff(userCode, (raw) => ({
    outcome: "error",
    message: toText(message).slice(0, 280),
    expiresAt: Math.min(Number(raw.expiresAt) || 0, Date.now() + DEVICE_CODE_OUTCOME_TTL_MS),
  }));
}

async function clearDeviceCodeHandoff() {
  if (!isExtensionRuntimeReady()) return;
  try {
    await chrome.storage.local.remove([STORAGE_KEY_DEVICE_CODE_HANDOFF]);
  } catch {}
}

// La ventana de espera pasa a github.com/login/device. Solo esa URL (A12.8): el backend
// no elige a donde navega la ventana.
function openDeviceLoginInWaitingWindow(pendingWindow, verificationUrl) {
  if (!pendingWindow || pendingWindow.closed) return false;
  const target = isGithubDeviceLoginUrl(verificationUrl) ? toSafeHttpUrl(verificationUrl) : GITHUB_DEVICE_LOGIN_URL;
  try {
    pendingWindow.location.href = target;
    return true;
  } catch {
    return false;
  }
}

async function showDeviceCodeStep(pendingWindow, info, repoFullName = "", buttonLabel = "") {
  const detail = `Abre ${info.verificationUrl} y escribe el codigo ${info.userCode}. Es una sola vez: GitHub asocia el editor a tu cuenta.`;
  setOperationProgress(`Autoriza tu editor: codigo ${info.userCode}`, detail);
  updateCodespaceWaitingWindow(
    pendingWindow,
    `Codigo de autorizacion: ${info.userCode}`,
    detail,
    "",
    info.verificationUrl,
  );
  try {
    const quickLink = pendingWindow?.document?.getElementById("adaceenOpenQuickstartLink");
    if (quickLink) quickLink.textContent = `Abrir github.com/login/device (codigo ${info.userCode})`;
  } catch {
    // La ventana pudo navegar a otro origen; no pasa nada.
  }
  try {
    // Mejor esfuerzo: si el navegador lo permite, el codigo queda en el portapapeles.
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(info.userCode).catch(() => {});
    }
  } catch {
    // Sin permiso de portapapeles; el codigo sigue a la vista.
  }

  // Una sola pestana: la ventana de espera pasa a github.com/login/device, donde este mismo
  // content script muestra el codigo (showGithubDeviceCodeHelper), y al confirmar el tunel
  // navigatePendingCodespaceWindow la lleva al editor. Sin el codigo guardado no se navega:
  // la pagina de espera lo sigue mostrando.
  if (!pendingWindow || pendingWindow.closed) return false;
  if (!(await saveDeviceCodeHandoff(info, repoFullName, buttonLabel))) return false;
  const moved = openDeviceLoginInWaitingWindow(pendingWindow, info.verificationUrl);
  if (moved) {
    setOperationProgress(
      `Autoriza tu editor: codigo ${info.userCode}`,
      `La otra pestana abrio github.com/login/device con el codigo ${info.userCode} ya escrito (si no, pegalo): pulsa Continue y autoriza. Cuando GitHub confirme, esa misma pestana abrira tu editor.`,
    );
  }
  return moved;
}

// ---- El codigo puesto solo en el formulario de GitHub (0.7.21; en la rama de la nube, 0.7.20) ----
// github.com/login/device ("Device Activation") pide el codigo en un campo XXXX-XXXX o en
// ocho cuadros de un caracter. Se escribe ahi para que el estudiante solo pulse Continue y
// autorice. Nunca se envia el formulario: autorizar es decision del estudiante. Si GitHub
// cambia el formulario y no se reconoce, no se toca nada y el aviso sigue pidiendo pegarlo.
const DEVICE_CODE_FILL_RETRY_MS = 700;
const DEVICE_CODE_FILL_ATTEMPTS = 4;
const DEVICE_CODE_FILLED_TEXT = "El codigo ya esta en el formulario: pulsa Continue y autoriza con tu cuenta de GitHub. Esta pestana abrira tu editor sola.";

function deviceCodeFieldType(input) {
  return toText(input?.type || input?.getAttribute?.("type") || "text").toLowerCase();
}

function isTypableDeviceCodeField(input) {
  if (!input || input.disabled || input.readOnly) return false;
  return ["text", "tel", "number", "search", ""].includes(deviceCodeFieldType(input));
}

// Los campos donde va el codigo: los que se llaman user_code / device-code (uno o varios)
// o, sin nombre reconocible, ocho o mas cuadros de un caracter.
function deviceCodeFieldsOf(form) {
  const inputs = Array.from(form?.querySelectorAll?.("input") || []).filter(isTypableDeviceCodeField);
  const named = inputs.filter((input) => /user[-_]?code|device[-_]?code/i.test(
    [input.name, input.id, input.className, input.getAttribute?.("aria-label")].map(toText).join(" "),
  ));
  if (named.length) return named;
  const boxes = inputs.filter((input) => Number(input.maxLength ?? input.getAttribute?.("maxlength")) === 1);
  return boxes.length >= 8 ? boxes : [];
}

function deviceCodeFormOf(doc) {
  const forms = Array.from(doc?.querySelectorAll?.("form") || []);
  const withFields = forms.filter((form) => deviceCodeFieldsOf(form).length > 0);
  return withFields.find((form) => /\/login\/device(?:[/?#]|$)/.test(toText(form.getAttribute?.("action"))))
    || withFields[0]
    || null;
}

function composedDeviceCode(fields) {
  return fields.map((field) => toText(field.value)).join("").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function dispatchDeviceCodeInputEvents(field, data) {
  for (const type of ["input", "change"]) {
    let event = null;
    try {
      if (type === "input" && typeof InputEvent === "function") {
        event = new InputEvent(type, { bubbles: true, inputType: "insertText", data });
      } else if (typeof Event === "function") {
        event = new Event(type, { bubbles: true });
      }
    } catch {
      event = null;
    }
    if (!event) continue;
    try {
      field.dispatchEvent?.(event);
    } catch {}
  }
}

// Escribe como lo haria el teclado: el setter nativo (los scripts de la pagina ven el cambio)
// y los eventos input y change.
function setDeviceCodeField(field, value) {
  try {
    const proto = typeof HTMLInputElement === "function" ? HTMLInputElement.prototype : null;
    const setter = proto ? Object.getOwnPropertyDescriptor(proto, "value")?.set : null;
    if (setter && field instanceof HTMLInputElement) setter.call(field, value);
    else field.value = value;
  } catch {
    field.value = value;
  }
  dispatchDeviceCodeInputEvents(field, value);
}

// Como pegar en el primer cuadro: GitHub reparte el codigo entre los cuadros al pegar.
function pasteDeviceCodeInto(field, userCode) {
  if (typeof ClipboardEvent !== "function" || typeof DataTransfer !== "function") return false;
  try {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", userCode);
    field.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    return true;
  } catch {
    return false;
  }
}

// true solo si el codigo quedo en los campos (se comprueba leyendolos despues de escribir).
function fillGithubDeviceCodeForm(userCode) {
  const code = normalizeDeviceUserCode(userCode);
  if (!code) return false;
  const form = deviceCodeFormOf(document);
  const fields = form ? deviceCodeFieldsOf(form) : [];
  if (!fields.length) return false;
  const plain = code.replace("-", "");
  const matches = () => composedDeviceCode(fields) === plain;
  if (!matches()) {
    if (fields.length === 1) {
      setDeviceCodeField(fields[0], code);
    } else {
      pasteDeviceCodeInto(fields[0], code);
      if (!matches()) {
        const chars = fields.length === code.length ? code : plain;
        fields.forEach((field, index) => setDeviceCodeField(field, index < chars.length ? chars[index] : ""));
      }
    }
  }
  if (!matches()) return false;
  // Si el formulario guarda el codigo completo en un campo oculto, tambien se pone ahi.
  for (const hidden of Array.from(form.querySelectorAll?.("input") || [])) {
    if (deviceCodeFieldType(hidden) === "hidden" && /user[-_]?code/i.test(toText(hidden.name)) && toText(hidden.value) !== code) {
      try {
        hidden.value = code;
      } catch {}
    }
  }
  return true;
}

// En github.com/login/device: aviso fijo con el codigo y un boton para copiarlo. Solo para el
// usuario de ADACEEN que pidio el codigo, y mientras la espera siga viva.
async function showGithubDeviceCodeHelper() {
  const step = githubDeviceFlowStep();
  if (!step) return false;
  let handoff = await readDeviceCodeHandoff();
  if (!handoff || handoff.outcome || Date.now() - handoff.aliveAt > DEVICE_CODE_HANDOFF_STALE_MS) return false;
  await syncFromStorageSnapshot({ force: true }).catch(() => false);
  const userId = getCurrentUserId();
  if (!userId || handoff.userId !== userId) return false;

  document.getElementById(DEVICE_CODE_HELPER_HOST_ID)?.remove();
  const host = document.createElement("div");
  host.id = DEVICE_CODE_HELPER_HOST_ID;
  const root = host.attachShadow({ mode: "closed" });
  // Markup fijo; el codigo entra con textContent.
  root.innerHTML = `
    <style>
      .box { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483646;
        display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; max-width: min(640px, calc(100vw - 24px));
        padding: 12px 44px 12px 16px; border-radius: 10px; background: #06131b; color: #f8fbff;
        border: 1px solid rgba(118, 239, 229, 0.55); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
        font: 14px/1.4 Segoe UI, Arial, sans-serif; }
      .code { font: 700 22px/1.1 ui-monospace, Consolas, monospace; letter-spacing: 2px; color: #76efe5; }
      .copy { flex: 1 1 220px; margin: 0; }
      button { font: inherit; font-weight: 700; border-radius: 8px; border: 0; padding: 8px 12px; cursor: pointer;
        background: #dffffb; color: #07353b; }
      button.close { position: absolute; top: 8px; right: 8px; background: transparent; color: #d9eaf0; padding: 4px 8px; }
      button:focus-visible { outline: 3px solid #ffd08a; outline-offset: 2px; }
      .account { flex: 1 1 100%; margin: 0; font-size: 13px; color: #b9d7df; }
      .account.is-ok { color: #9ff0c6; }
      .account.is-wrong { padding: 8px 10px; border-radius: 8px; background: #3b2a06; color: #ffe2a3; border: 1px solid #c99a2e; }
    </style>
    <aside class="box" role="region" aria-label="Codigo de ADACEEN para autorizar tu editor">
      <span>ADACEEN · tu codigo</span>
      <strong class="code" id="adaceenDeviceCode"></strong>
      <button type="button" id="adaceenDeviceCodeCopy">Copiar codigo</button>
      <p class="copy" id="adaceenDeviceCodeStatus" role="status"></p>
      <p class="account" id="adaceenDeviceCodeAccount" role="status" hidden></p>
      <button type="button" class="close" id="adaceenDeviceCodeClose" aria-label="Ocultar el codigo">&times;</button>
    </aside>`;
  const codeEl = root.getElementById("adaceenDeviceCode");
  const statusEl = root.getElementById("adaceenDeviceCodeStatus");
  const accountEl = root.getElementById("adaceenDeviceCodeAccount");
  if (codeEl) codeEl.textContent = handoff.userCode;
  // Lo que toca en este paso de GitHub (el texto inicial; copiar o un desenlace lo cambian).
  const stepText = {
    signin: `Primero inicia sesion en GitHub${handoff.githubLogin ? ` con tu cuenta «${handoff.githubLogin}»` : ""}. Despues GitHub te pide este codigo: pegalo y autoriza.`,
    code: "Pegalo aqui y autoriza. Cuando GitHub confirme, esta pestana abrira tu editor sola.",
    authorize: "Ultimo paso: autoriza a «Visual Studio Code» en GitHub. Cuando GitHub confirme, esta pestana abrira tu editor sola.",
    done: "GitHub confirmo el codigo. En unos segundos esta pestana abre tu editor.",
    failed: "",
  };
  if (statusEl) statusEl.textContent = stepText[step] || stepText.code;
  // La misma cuenta en todo el camino: el tunel queda a nombre de quien autoriza el codigo, y
  // vscode.dev solo lo encuentra con esa cuenta (el fallo mas comun: «no encuentra el tunel»).
  const signedIn = readGithubSignedInLogin();
  if (accountEl) accountEl.hidden = true;
  if (accountEl && handoff.githubLogin && signedIn && step !== "done") {
    accountEl.hidden = false;
    if (signedIn === handoff.githubLogin) {
      accountEl.className = "account is-ok";
      accountEl.textContent = `Cuenta correcta: estas en GitHub como «${signedIn}».`;
    } else {
      accountEl.className = "account is-wrong";
      accountEl.textContent = `Estas en GitHub como «${signedIn}», pero tu editor es de «${handoff.githubLogin}». Cambia de cuenta (tu foto, arriba a la derecha) antes de autorizar: con otra cuenta, vscode.dev no encontrara tu editor.`;
    }
  }
  // Una vez que ADACEEN deja de esperar, el aviso lo dice y ya no cambia.
  let settled = false;
  let staleTimer = 0;
  const settle = (text) => {
    if (settled) return;
    settled = true;
    if (staleTimer) window.clearInterval(staleTimer);
    if (statusEl) statusEl.textContent = text;
  };
  // El boton que vera en la pestana de ADACEEN: "Abrir mi editor" o, sin editor guardado,
  // "Preparar mi editor".
  const buttonLabel = () => tunnelRetryButtonLabel(handoff.repoFullName, handoff.buttonLabel);
  const stoppedText = () => `ADACEEN ya no espera este codigo. Si tu editor no se abrio, vuelve a la pestana de ADACEEN y pulsa "${buttonLabel()}".`;
  // El codigo se escribe solo en el formulario de GitHub (si se reconoce). Mientras este
  // puesto, los mensajes de copiar no lo tapan: lo unico que falta es Continue y autorizar.
  let filled = false;
  const fillForm = () => {
    if (settled || !host.isConnected) return false;
    filled = fillGithubDeviceCodeForm(handoff.userCode);
    if (filled && statusEl) statusEl.textContent = DEVICE_CODE_FILLED_TEXT;
    return filled;
  };
  // La pagina puede pintar los cuadros un instante despues de cargar: unos pocos intentos.
  // Solo en las paginas del codigo (github.com/login/device...), nunca en el inicio de sesion.
  const canFill = step === "code" || step === "authorize";
  const tryFill = (attempt = 0) => {
    if (!canFill || fillForm() || attempt >= DEVICE_CODE_FILL_ATTEMPTS - 1) return;
    window.setTimeout(() => tryFill(attempt + 1), DEVICE_CODE_FILL_RETRY_MS);
  };
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(handoff.userCode);
      if (statusEl && !settled && !filled) {
        statusEl.textContent = step === "signin"
          ? `Codigo copiado. Inicia sesion${handoff.githubLogin ? ` con «${handoff.githubLogin}»` : ""} y, cuando GitHub lo pida, pegalo y autoriza.`
          : "Codigo copiado: pegalo en el primer cuadro y autoriza. Esta pestana abrira tu editor sola.";
      }
      return true;
    } catch {
      if (statusEl && !settled && !filled && step !== "signin") statusEl.textContent = "Escribe el codigo en los cuadros y autoriza. Esta pestana abrira tu editor sola.";
      return false;
    }
  };
  root.getElementById("adaceenDeviceCodeCopy")?.addEventListener("click", () => {
    copyCode().catch(() => {});
  });
  root.getElementById("adaceenDeviceCodeClose")?.addEventListener("click", () => {
    host.remove();
  });
  document.documentElement.appendChild(host);
  // GitHub rechazo el codigo (o se cancelo): no hay nada que esperar en esta pestana.
  if (step === "failed") settle(`GitHub no autorizo el codigo. Vuelve a la pestana de ADACEEN y pulsa "${buttonLabel()}" para recibir otro.`);
  tryFill();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes?.[STORAGE_KEY_DEVICE_CODE_HANDOFF] || settled || !host.isConnected) return;
    const next = normalizeDeviceCodeHandoff(changes[STORAGE_KEY_DEVICE_CODE_HANDOFF].newValue);
    if (!next) {
      // Editor listo (esta pestana navega al editor), cierre de sesion o caducidad.
      window.setTimeout(() => {
        if (host.isConnected) settle(stoppedText());
      }, DEVICE_CODE_GONE_GRACE_MS);
      return;
    }
    if (next.userId !== handoff.userId) {
      settle(stoppedText());
      return;
    }
    if (next.outcome === "error") {
      const detail = next.message ? ` ${next.message.replace(/[.\s]+$/, "")}.` : "";
      settle(`ADACEEN dejo de esperar.${detail} Vuelve a la pestana de ADACEEN y pulsa "${buttonLabel()}".`);
      return;
    }
    const newCode = next.userCode !== handoff.userCode;
    handoff = next;
    if (newCode && codeEl) {
      // GitHub emitio otro codigo en la misma espera: se muestra y se vuelve a escribir.
      codeEl.textContent = next.userCode;
      filled = false;
      if (statusEl) statusEl.textContent = "Codigo nuevo: pegalo aqui y autoriza. Cuando GitHub confirme, esta pestana abrira tu editor sola.";
      tryFill();
    }
  });
  // La pestana de origen se recargo o se cerro: la espera dejo de latir.
  staleTimer = window.setInterval(() => {
    if (!host.isConnected) {
      window.clearInterval(staleTimer);
      return;
    }
    if (Date.now() - handoff.aliveAt > DEVICE_CODE_HANDOFF_STALE_MS) settle(stoppedText());
  }, DEVICE_CODE_HELPER_CHECK_MS);

  // Mejor esfuerzo, y solo recien emitido el codigo: con la pestana activa el navegador suele
  // dejar copiar sin clic. En el inicio de sesion tambien: el codigo espera en el portapapeles.
  if ((step === "code" || step === "signin") && Date.now() - handoff.savedAt < DEVICE_CODE_AUTO_COPY_MS) {
    copyCode().catch(() => {});
  }
  return true;
}

// ---- Primera entrada al editor (vscode.dev) ----

// Nombre del tunel de una URL de vscode.dev/tunnel/<nombre>/..., en minusculas; "" si no es una.
function tunnelNameFromEditorUrl(value) {
  if (!isTunnelEditorUrl(value)) return "";
  try {
    const match = new URL(toText(value)).pathname.match(/^\/tunnel\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]).toLowerCase() : "";
  } catch {
    return "";
  }
}

// ¿Este navegador ya abrio alguna vez ese tunel para el usuario actual? (cualquier repositorio:
// el inicio de sesion de vscode.dev es por tunel, no por carpeta).
function tunnelOpenedInThisBrowser(tunnelName) {
  const userId = getCurrentUserId();
  if (!userId || !tunnelName) return false;
  const prefix = `${userId}:`;
  return Object.entries(overlayState.editorByUser || {}).some(([key, record]) => key.startsWith(prefix)
    && toText(record?.openedAt)
    && tunnelNameFromEditorUrl(record?.webUrl) === tunnelName);
}

// Al abrir el editor por primera vez (en este navegador o tras autorizar el codigo), vscode.dev
// pide iniciar sesion para entrar al tunel: la pestana del editor lo avisara una vez.
async function saveTunnelSignInHint(webUrl, githubLogin) {
  const tunnelName = tunnelNameFromEditorUrl(webUrl);
  const userId = getCurrentUserId();
  if (!tunnelName || !userId || !isExtensionRuntimeReady()) return false;
  try {
    await chrome.storage.local.set({
      [STORAGE_KEY_TUNNEL_SIGNIN_HINT]: {
        userId,
        tunnelName,
        githubLogin: normalizeGithubLoginHint(githubLogin),
        expiresAt: Date.now() + TUNNEL_SIGNIN_HINT_TTL_MS,
      },
    });
    return true;
  } catch {
    return false;
  }
}

async function clearTunnelSignInHint() {
  if (!isExtensionRuntimeReady()) return;
  try {
    await chrome.storage.local.remove([STORAGE_KEY_TUNNEL_SIGNIN_HINT]);
  } catch {}
}

// En vscode.dev/tunnel/<nombre>: «elige GitHub y usa la cuenta X». Una sola vez (se borra al
// mostrarse), solo para el usuario de ADACEEN que abrio ese editor y en los minutos siguientes.
async function showTunnelSignInHint() {
  const tunnelName = tunnelNameFromEditorUrl(location.href);
  if (!tunnelName || !isExtensionRuntimeReady()) return false;
  let hint = null;
  try {
    hint = (await chrome.storage.local.get([STORAGE_KEY_TUNNEL_SIGNIN_HINT]))?.[STORAGE_KEY_TUNNEL_SIGNIN_HINT] || null;
  } catch {
    return false;
  }
  if (!hint || toText(hint.tunnelName).toLowerCase() !== tunnelName) return false;
  if (!(Number(hint.expiresAt) > Date.now())) {
    await clearTunnelSignInHint();
    return false;
  }
  await syncFromStorageSnapshot({ force: true }).catch(() => false);
  const userId = getCurrentUserId();
  if (!userId || toText(hint.userId) !== userId) return false;
  await clearTunnelSignInHint();

  document.getElementById(TUNNEL_SIGNIN_HINT_HOST_ID)?.remove();
  const host = document.createElement("div");
  host.id = TUNNEL_SIGNIN_HINT_HOST_ID;
  const root = host.attachShadow({ mode: "closed" });
  // Markup fijo; la cuenta entra con textContent.
  root.innerHTML = `
    <style>
      .box { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 2147483646;
        display: flex; align-items: flex-start; gap: 12px; max-width: min(620px, calc(100vw - 24px));
        padding: 12px 14px 12px 16px; border-radius: 10px; background: #06131b; color: #f8fbff;
        border: 1px solid rgba(118, 239, 229, 0.55); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
        font: 14px/1.45 Segoe UI, Arial, sans-serif; }
      .text { margin: 0; flex: 1 1 auto; }
      .text strong { color: #76efe5; }
      button { font: inherit; border: 0; border-radius: 8px; padding: 4px 8px; cursor: pointer; background: transparent; color: #d9eaf0; }
      button:focus-visible { outline: 3px solid #ffd08a; outline-offset: 2px; }
    </style>
    <aside class="box" role="note" aria-label="ADACEEN: como entrar a tu editor">
      <p class="text"><strong>ADACEEN · primera vez en tu editor.</strong> <span id="adaceenTunnelSignInText"></span></p>
      <button type="button" id="adaceenTunnelSignInClose" aria-label="Ocultar el aviso">&times;</button>
    </aside>`;
  const textEl = root.getElementById("adaceenTunnelSignInText");
  const login = normalizeGithubLoginHint(hint.githubLogin);
  if (textEl) {
    textEl.textContent = login
      ? `Si vscode.dev te pide iniciar sesion para entrar, elige «GitHub» y usa la cuenta «${login}» (la misma que autorizo el codigo). Con otra cuenta o con Microsoft dira que no encuentra el tunel.`
      : "Si vscode.dev te pide iniciar sesion para entrar, elige «GitHub» y usa la misma cuenta que autorizo el codigo. Con otra cuenta o con Microsoft dira que no encuentra el tunel.";
  }
  root.getElementById("adaceenTunnelSignInClose")?.addEventListener("click", () => host.remove());
  document.documentElement.appendChild(host);
  // Cuando ya entro, el aviso sobra: se va solo a los minutos.
  window.setTimeout(() => host.remove(), TUNNEL_SIGNIN_HINT_TTL_MS);
  return true;
}

// ---- Preparar y abrir ----

// Docente y administrador encienden la VM ellos mismos: no hay a quien "avisar" (0.7.20).
function workspaceViewerIsStaff() {
  const role = overlayState.session?.user?.role;
  return role === "teacher" || role === "admin";
}

function describeRetryableWorkspaceWait(info) {
  if (info.code === "vm_starting") return "Encendiendo la VM de editores...";
  if (info.code === "agent_unreachable") {
    return workspaceViewerIsStaff() ? "La VM de editores esta apagada" : "El editor esta apagado; avisa al docente";
  }
  if (info.code === "busy_other_repo") return "Tu editor termina otro repositorio";
  return "Esperando a la VM de editores";
}

// options.sessionWritten: se llega desde prepare (la VM recibio la sesion de VS Code).
async function finishTunnelWorkspace(pendingWindow, info, repoFullName, options = {}) {
  // Primera vez que este navegador abre ese tunel, o recien autorizado el codigo: vscode.dev
  // pedira iniciar sesion y la pestana del editor lo avisara con la cuenta correcta.
  if (options?.deviceCodeShown === true || !tunnelOpenedInThisBrowser(tunnelNameFromEditorUrl(info.webUrl))) {
    await saveTunnelSignInHint(info.webUrl, expectedTunnelGithubLogin(info)).catch(() => false);
  }
  rememberSetupPrResult({ repoFullName }, { codespaceWebUrl: info.webUrl });
  // Durable por usuario y repo: al volver otro dia el overlay ofrece "Abrir mi editor".
  await saveTunnelEditor(repoFullName, info.webUrl, { sessionWritten: options?.sessionWritten === true, opened: true });
  // Los demas repositorios que ya estan en la VM (0.7.20), para abrirlos tambien con un clic.
  await rememberTunnelEditorsFromBackend(info.editors).catch(() => false);
  await markSetupCompleted(repoFullName);
  await clearDeviceCodeHandoff();
  updateCodespaceWaitingWindow(pendingWindow, "Editor listo. Redirigiendo...", "Abriendo VS Code en el navegador.", info.webUrl, "");
  setTunnelWaitingStep(pendingWindow, "open");
  // force: un clic explicito del estudiante (o el final de prepare) siempre navega,
  // aunque hace poco se haya abierto el mismo editor.
  const opened = await navigatePendingCodespaceWindow(pendingWindow, info.webUrl, { force: true });
  // Sin volver a consultar GitHub: la cuenta se acaba de comprobar al preparar o al entrar, y
  // con el tunel la GitHub App no interviene.
  await rememberEditorChoice("cloud");
  clearOperationProgress(opened
    ? "Editor listo. Abriendolo ahora."
    : `Editor listo en ${info.webUrl}. Usa "Abrir mi editor" si la ventana no se abrio sola.`);
  renderOverlay();
  return opened;
}

async function prepareTunnelWorkspace(options = {}) {
  const repoFullName = parseRepoFullName(options?.repoFullName) || getCurrentRepoFullName();
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const providedWindow = options?.pendingWindow && !options.pendingWindow.closed ? options.pendingWindow : null;
  if (!repoFullName || !baseUrl || !overlayState.sessionId) {
    if (providedWindow) providedWindow.close();
    overlayState.statusMessage = "Debes iniciar sesion y estar en un repositorio para preparar el editor.";
    renderOverlay();
    return;
  }

  // Hace falta la cuenta de GitHub conectada (da el login para el tunel y
  // permiso de lectura al repo), pero NO el scope "codespace". Si se acaba de
  // confirmar (al volver del OAuth), no se pregunta otra vez.
  try {
    await refreshGithubUserStatusIfStale();
  } catch {}
  const githubUserStatus = overlayState.githubUserStatus || EMPTY_GITHUB_USER_STATUS;
  if (!githubUserStatus.connected) {
    overlayState.statusMessage = githubUserStatus.configured
      ? "Conecta tu cuenta de GitHub: el editor se registra a tu nombre."
      : "El backend aun no tiene GitHub OAuth configurado.";
    renderOverlay();
    if (githubUserStatus.configured) {
      // La ventana ya abierta (en el mismo clic) sirve para el OAuth: sin otra ventana bloqueada.
      await startGithubUserOAuthFlow({ pendingWindow: providedWindow });
    } else if (providedWindow) {
      providedWindow.close();
    }
    return;
  }

  const force = Boolean(options && options.force);
  let pendingWindow = providedWindow;
  if (!pendingWindow) {
    pendingWindow = openCodespaceWaitingWindow(repoFullName);
  }
  if (pendingWindow) {
    updateCodespaceWaitingWindow(pendingWindow, "ADACEEN esta preparando tu editor", "Clonando el repositorio en la nube y registrando el tunel...", "", "");
    setTunnelWaitingStep(pendingWindow, "start");
  } else {
    overlayState.operationDetail = "El navegador bloqueo la ventana automatica. Cuando el editor este listo, el boton pasa a Abrir mi editor: pulsalo.";
  }

  overlayState.githubAppBusy = true;
  // Sin aviso "Esto puede tardar...": la ventana de espera ya cuenta el progreso.
  renderOverlay();
  setOperationProgress(force ? "Rehaciendo el editor" : "Preparando el editor", "Clonando el repositorio y registrando el tunel...");

  let lastInfo = null;
  let shownCode = "";
  let editorReady = false;
  let failureMessage = "";
  let handoffAliveAt = 0;
  try {
    const first = await fetchJsonWithTimeout(`${baseUrl}/api/workspaces/prepare`, {
      method: "POST",
      headers: buildApiHeaders(),
      body: JSON.stringify({ repoFullName, force }),
    }, WORKSPACE_PREPARE_TIMEOUT_MS);

    let info = describeWorkspaceStatus(first);
    lastInfo = info;
    const startedAt = Date.now();

    while (Date.now() - startedAt < WORKSPACE_POLL_TIMEOUT_MS) {
      if (pendingWindow && pendingWindow.closed) {
        pendingWindow = null;
      }
      if (info.status === "ready" && info.webUrl && !isTunnelEditorUrl(toSafeHttpUrl(info.webUrl))) {
        // La ventana de espera solo navega a VS Code Tunnels (vscode.dev/tunnel/...).
        failureMessage = "El backend devolvio una direccion de editor que no es de VS Code Tunnels.";
        setOperationError("No se pudo abrir el editor", failureMessage);
        updateCodespaceWaitingWindow(pendingWindow, "No se pudo abrir el editor", `${failureMessage} ${workspaceViewerIsStaff() ? "Revisa que el backend este actualizado." : "Avisa al docente."}`, "", "");
        return;
      }
      if (info.status === "ready" && info.webUrl) {
        editorReady = true;
        await finishTunnelWorkspace(pendingWindow, info, repoFullName, { sessionWritten: true, deviceCodeShown: !!shownCode });
        return;
      }
      if (info.status === "error" && !info.retryable) {
        failureMessage = info.message || "El backend devolvio un error sin detalle.";
        setOperationError("No se pudo preparar el editor", info.message || "El backend devolvio un error sin detalle.");
        updateCodespaceWaitingWindow(pendingWindow, "No se pudo preparar el editor", info.message || "Revisa el estado en ADACEEN.", "", "");
        return;
      }
      if (info.retryable && (info.status === "error" || info.status === "pending")) {
        // VM apagada o encendiendose: no es un fallo, se sigue consultando.
        const title = describeRetryableWorkspaceWait(info);
        const detail = info.message || "La VM de editores aun no responde. Esta ventana seguira esperando.";
        setOperationProgress(title, detail);
        updateCodespaceWaitingWindow(pendingWindow, title, detail, "", "");
      } else if (info.status === "device_code" && info.userCode && info.userCode !== shownCode) {
        shownCode = info.userCode;
        setTunnelWaitingStep(pendingWindow, "authorize");
        await showDeviceCodeStep(pendingWindow, info, repoFullName, options?.buttonLabel);
        handoffAliveAt = Date.now();
      } else if (info.status === "pending" && !shownCode) {
        setOperationProgress("Preparando el editor", info.message || "Arrancando el tunel de VS Code...");
        updateCodespaceWaitingWindow(pendingWindow, "Esperando al editor", info.message || "Arrancando el tunel de VS Code...", "", "");
      }
      // Latido para el aviso de github.com/login/device: esta pestana sigue esperando.
      if (shownCode && Date.now() - handoffAliveAt >= DEVICE_CODE_HANDOFF_HEARTBEAT_MS) {
        handoffAliveAt = Date.now();
        await touchDeviceCodeHandoff(shownCode);
      }

      await new Promise((resolve) => setTimeout(resolve, WORKSPACE_POLL_MS));
      const next = await fetchJsonWithTimeout(
        `${baseUrl}/api/workspaces/status?repoFullName=${encodeURIComponent(repoFullName)}`,
        { method: "GET", headers: buildApiHeaders() },
        WORKSPACE_STATUS_TIMEOUT_MS,
      ).catch(() => null);
      if (next) {
        info = describeWorkspaceStatus(next);
        lastInfo = info;
      }
    }

    failureMessage = "El editor no confirmo a tiempo.";
    const buttonLabel = tunnelRetryButtonLabel(repoFullName, options?.buttonLabel);
    const timeoutDetail = shownCode
      ? `El codigo ${shownCode} no se autorizo a tiempo. Pulsa "${buttonLabel}" de nuevo para recibir otro.`
      : lastInfo?.code === "busy_other_repo"
        ? `Tu editor sigue ocupado preparando otro repositorio. Pulsa "${buttonLabel}" de nuevo en un momento.`
      : lastInfo?.code === "agent_unreachable"
        ? (workspaceViewerIsStaff()
          ? `La VM de editores sigue apagada. Enciendela con bash deploy/clase.sh iniciar y pulsa "${buttonLabel}" de nuevo.`
          : `La VM de editores sigue apagada. Pulsa "${buttonLabel}" de nuevo cuando el docente la encienda.`)
      : lastInfo?.retryable
        ? `${lastInfo.message || "La VM de editores sigue sin responder."} Pulsa "${buttonLabel}" de nuevo en un momento.`
        : "El backend no confirmo el tunel. Vuelve a intentar o revisa el estado en ADACEEN.";
    setOperationError("El editor no confirmo a tiempo", timeoutDetail);
    updateCodespaceWaitingWindow(pendingWindow, "El editor no confirmo a tiempo", timeoutDetail, "", "");
  } catch (error) {
    failureMessage = error?.message || String(error);
    setOperationError("No se pudo preparar el editor", error?.message || String(error));
    updateCodespaceWaitingWindow(pendingWindow, "No se pudo preparar el editor", error?.message || String(error), "", "");
  } finally {
    // Terminada la espera, el codigo de dispositivo ya no se ofrece: con el editor listo el
    // handoff se borra (finishTunnelWorkspace); si no, el aviso de github.com/login/device
    // recibe el desenlace (dejo de esperar) en vez de seguir prometiendo el editor.
    if (!editorReady && shownCode) {
      await settleDeviceCodeHandoffWithError(shownCode, failureMessage);
    }
    overlayState.githubAppBusy = false;
    renderOverlay();
  }
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
