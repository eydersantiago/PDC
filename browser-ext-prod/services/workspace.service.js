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
//   POST /api/workspaces/prepare   { repoFullName, force?, reconnect? }
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
// Punto de restauracion (0.8.1): el tunel queda a nombre de la cuenta de GitHub que autoriza el
// codigo de dispositivo, y vscode.dev solo lo encuentra con esa cuenta. Si se autorizo con otra
// (la que estaba abierta en el navegador), vscode.dev dice que no encuentra el tunel: la pestana
// del editor lo detecta y ofrece «Reconectar con mi cuenta» (prepare con reconnect: true, que
// cierra esa sesion en la VM y pide un codigo nuevo, sin tocar los archivos). Antes de llegar
// ahi, el aviso del codigo no lo escribe solo si GitHub tiene abierta otra cuenta y acompana el
// cambio de cuenta hasta volver al codigo.
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
// El mismo paso 4 en la pagina de GitHub donde se autoriza «Visual Studio Code» (0.8.0).
const TUNNEL_SIGNIN_GITHUB_HOST_ID = "adaceen-tunnel-signin-github";
// Punto de restauracion (0.8.1).
const GITHUB_LOGOUT_URL = "https://github.com/logout";
// Iniciar sesion y volver al codigo: GitHub sigue return_to despues de entrar.
const GITHUB_SIGNIN_TO_DEVICE_URL = "https://github.com/login?return_to=%2Flogin%2Fdevice";
const GITHUB_SWITCH_ACCOUNT_HOST_ID = "adaceen-github-switch-account";
// Ya en la cuenta correcta tras cambiarla: se vuelve solo al codigo en este tiempo.
const GITHUB_SWITCH_RETURN_MS = 2500;
const TUNNEL_NOT_FOUND_HOST_ID = "adaceen-tunnel-not-found";
// vscode.dev tarda en decir que no encuentra el tunel: se mira cada 1,5 s durante 3 min.
const TUNNEL_NOT_FOUND_CHECK_MS = 1500;
const TUNNEL_NOT_FOUND_WATCH_MS = 3 * 60 * 1000;
// La cuenta que autorizo el codigo vale lo que vale el tunel: se recuerda 30 dias.
const TUNNEL_DEVICE_ACCOUNT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RECONNECT_BUTTON_LABEL = "Reconectar con mi cuenta";
const SWITCH_GITHUB_ACCOUNT_LABEL = "Usar otra cuenta de GitHub";
// 0.8.2: vscode.dev con la sesion de otra cuenta. «Entrar con <cuenta>» borra la de vscode.dev.
const VSCODE_SESSION_RESET_TTL_MS = 30 * 60 * 1000;
// Sin respuesta del background (la pestana ya se esta yendo): si sigue aqui despues de esto, se
// borra desde la pagina.
const VSCODE_SESSION_RESET_FALLBACK_MS = 2000;
const VSCODE_SESSION_RESET_MANUAL_TEXT = "No se pudo borrar la sesión de vscode.dev desde ADACEEN. Hazlo a mano: ícono a la izquierda de la dirección → «Cookies y datos de sitios» → «Administrar datos en el dispositivo» → borra vscode.dev y recarga la página.";
const VSCODE_CHOOSE_ACCOUNT_LOOP_TEXT = "«Elegir otra cuenta» de vscode.dev no sirve: vuelve a usar la misma sesión.";

function vscodeEnterLabel(expected) {
  return expected ? `Entrar con ${expected}` : "Entrar de nuevo a vscode.dev";
}

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
    // «Cambiar de cuenta» (0.8.1): el estudiante salio de GitHub para entrar con la correcta.
    switching: raw?.switching === true,
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
  const detail = `${firstTimeStepHeading("authorize")} (obligatorio la primera vez): abre ${info.verificationUrl}, escribe el código ${info.userCode}, pulsa Continue y autoriza «Visual Studio Code». Sin este paso tu editor no abre.`;
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
  // Fuera de las paginas del codigo: solo si el estudiante esta cambiando de cuenta (0.8.1).
  if (!step) return showGithubAccountSwitchHelper();
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
        display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; box-sizing: border-box; width: min(640px, calc(100vw - 24px));
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
      button.switch { background: #ffd08a; color: #3b2a06; }
      .head { flex: 1 1 100%; display: grid; gap: 6px; }
      .why { margin: 0; color: #d9eaf0; font-size: 13px; }
      ${FIRST_TIME_STEPS_CSS}
    </style>
    <aside class="box" role="region" aria-label="Codigo de ADACEEN para autorizar tu editor">
      <div class="head">
        <strong class="step-title">${firstTimeStepHeading("authorize")} <span class="must">· obligatorio la primera vez</span></strong>
        ${firstTimeStepsMarkup("authorize")}
        <p class="why">Sin este paso tu editor no abre: GitHub asocia el editor a tu cuenta. Hazlo con la misma cuenta de GitHub que conectaste.</p>
      </div>
      <span>ADACEEN · tu codigo</span>
      <strong class="code" id="adaceenDeviceCode"></strong>
      <button type="button" id="adaceenDeviceCodeCopy">Copiar codigo</button>
      <p class="copy" id="adaceenDeviceCodeStatus" role="status"></p>
      <p class="account" id="adaceenDeviceCodeAccount" role="status" hidden></p>
      <button type="button" class="switch" id="adaceenDeviceCodeSwitch" hidden>Cambiar de cuenta</button>
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
  // 0.8.1: con otra cuenta el codigo no se escribe solo (pulsar Continue dejaria el editor a
  // nombre de esa cuenta) y «Cambiar de cuenta» acompana hasta volver aqui con la correcta.
  const wrongAccount = Boolean(handoff.githubLogin && signedIn && signedIn !== handoff.githubLogin && step !== "done" && step !== "failed");
  const switchEl = root.getElementById("adaceenDeviceCodeSwitch");
  if (accountEl) accountEl.hidden = true;
  if (accountEl && handoff.githubLogin && signedIn && step !== "done") {
    accountEl.hidden = false;
    if (signedIn === handoff.githubLogin) {
      accountEl.className = "account is-ok";
      accountEl.textContent = `Cuenta correcta: estas en GitHub como «${signedIn}».`;
    } else {
      accountEl.className = "account is-wrong";
      accountEl.textContent = `Estas en GitHub como «${signedIn}», pero tu editor es de «${handoff.githubLogin}». Cambia de cuenta antes de autorizar: con otra cuenta, vscode.dev no encontrara tu editor.`;
    }
  }
  if (switchEl) switchEl.hidden = !wrongAccount;
  if (wrongAccount && statusEl) {
    statusEl.textContent = step === "authorize"
      ? `No pulses «Authorize» con «${signedIn}». Pulsa «Cambiar de cuenta», entra con «${handoff.githubLogin}» y ADACEEN te trae de vuelta al codigo.`
      : `No pegues el codigo con «${signedIn}». Pulsa «Cambiar de cuenta», entra con «${handoff.githubLogin}» y ADACEEN te trae de vuelta aqui con el codigo.`;
  }
  // Quien autoriza (o esta por autorizar) el codigo: si despues vscode.dev no encuentra el
  // editor, el aviso de vscode.dev sabe si fue por el codigo o por la entrada a vscode.dev.
  if (signedIn && (step === "authorize" || step === "done")) {
    rememberTunnelDeviceAccount(handoff, signedIn).catch(() => false);
  }
  // Ya en la cuenta correcta despues de cambiarla: se termina el cambio.
  if (handoff.switching && signedIn && signedIn === handoff.githubLogin) {
    updateDeviceCodeHandoff(handoff.userCode, () => ({ switching: false })).catch(() => false);
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
  const canFill = (step === "code" || step === "authorize") && !wrongAccount;
  const tryFill = (attempt = 0) => {
    if (!canFill || fillForm() || attempt >= DEVICE_CODE_FILL_ATTEMPTS - 1) return;
    window.setTimeout(() => tryFill(attempt + 1), DEVICE_CODE_FILL_RETRY_MS);
  };
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(handoff.userCode);
      if (statusEl && !settled && !filled && !wrongAccount) {
        statusEl.textContent = step === "signin"
          ? `Codigo copiado. Inicia sesion${handoff.githubLogin ? ` con «${handoff.githubLogin}»` : ""} y, cuando GitHub lo pida, pegalo y autoriza.`
          : "Codigo copiado: pegalo en el primer cuadro y autoriza. Esta pestana abrira tu editor sola.";
      }
      return true;
    } catch {
      if (statusEl && !settled && !filled && !wrongAccount && step !== "signin") statusEl.textContent = "Escribe el codigo en los cuadros y autoriza. Esta pestana abrira tu editor sola.";
      return false;
    }
  };
  root.getElementById("adaceenDeviceCodeCopy")?.addEventListener("click", () => {
    copyCode().catch(() => {});
  });
  root.getElementById("adaceenDeviceCodeClose")?.addEventListener("click", () => {
    host.remove();
  });
  switchEl?.addEventListener("click", async () => {
    // La espera sigue latiendo en la pestana de ADACEEN: el codigo vale mientras tanto.
    await updateDeviceCodeHandoff(handoff.userCode, () => ({ switching: true })).catch(() => false);
    location.href = GITHUB_LOGOUT_URL;
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

// ---- Cambiar de cuenta de GitHub a mitad del paso 3 (0.8.1) ----

// Despues de «Cambiar de cuenta» el estudiante pasa por github.com/logout y la portada de GitHub
// (o su inicio de sesion, que ya acompana showGithubDeviceCodeHelper): aqui se dice que sigue,
// hasta volver a github.com/login/device con la cuenta del editor.
async function showGithubAccountSwitchHelper() {
  if (toText(location.hostname).toLowerCase() !== "github.com") return false;
  const handoff = await readDeviceCodeHandoff();
  if (!handoff?.switching || handoff.outcome || !handoff.githubLogin) return false;
  if (Date.now() - handoff.aliveAt > DEVICE_CODE_HANDOFF_STALE_MS) return false;
  await syncFromStorageSnapshot({ force: true }).catch(() => false);
  const userId = getCurrentUserId();
  if (!userId || handoff.userId !== userId) return false;

  const expected = handoff.githubLogin;
  const signedIn = readGithubSignedInLogin();
  const onLogout = /^\/logout\/?$/i.test(toText(location.pathname));
  let text = "";
  let action = null;
  if (signedIn && signedIn === expected) {
    text = `Listo: ahora estas en GitHub como «${expected}». Volviendo al codigo...`;
    action = { label: "Seguir con el codigo", href: GITHUB_DEVICE_LOGIN_URL };
  } else if (onLogout) {
    text = `Pulsa «Sign out» en esta pagina para salir de ${signedIn ? `«${signedIn}»` : "esa cuenta"}. Despues entra con «${expected}»: ADACEEN te lleva de vuelta al codigo.`;
  } else if (signedIn) {
    text = `Sigues en GitHub como «${signedIn}». Sal de esa cuenta y entra con «${expected}».`;
    action = { label: `Salir de «${signedIn}»`, href: GITHUB_LOGOUT_URL };
  } else {
    text = `Entra a GitHub con «${expected}». Despues ADACEEN te lleva de vuelta al codigo.`;
    action = { label: `Entrar con «${expected}»`, href: GITHUB_SIGNIN_TO_DEVICE_URL };
  }

  document.getElementById(GITHUB_SWITCH_ACCOUNT_HOST_ID)?.remove();
  const host = document.createElement("div");
  host.id = GITHUB_SWITCH_ACCOUNT_HOST_ID;
  const root = host.attachShadow({ mode: "closed" });
  // Markup fijo; los textos entran con textContent.
  root.innerHTML = `
    <style>
      .box { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483646;
        display: grid; gap: 8px; box-sizing: border-box; width: min(640px, calc(100vw - 24px));
        padding: 12px 44px 12px 16px; border-radius: 10px; background: #06131b; color: #f8fbff;
        border: 1px solid rgba(118, 239, 229, 0.55); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
        font: 14px/1.4 Segoe UI, Arial, sans-serif; }
      p { margin: 0; color: #d9eaf0; }
      .actions { display: flex; gap: 8px; }
      button { font: inherit; font-weight: 700; border-radius: 8px; border: 0; padding: 8px 12px; cursor: pointer;
        background: #dffffb; color: #07353b; }
      button.close { position: absolute; top: 8px; right: 8px; background: transparent; color: #d9eaf0; padding: 4px 8px; }
      button:focus-visible { outline: 3px solid #ffd08a; outline-offset: 2px; }
      ${FIRST_TIME_STEPS_CSS}
    </style>
    <aside class="box" role="region" aria-label="ADACEEN: cambia de cuenta de GitHub">
      <strong class="step-title">${firstTimeStepHeading("authorize")} <span class="must">· cambiar de cuenta</span></strong>
      ${firstTimeStepsMarkup("authorize")}
      <p id="adaceenSwitchText" role="status"></p>
      <div class="actions"><button type="button" id="adaceenSwitchAction" hidden></button></div>
      <button type="button" class="close" id="adaceenSwitchClose" aria-label="Ocultar el aviso">&times;</button>
    </aside>`;
  const textEl = root.getElementById("adaceenSwitchText");
  if (textEl) textEl.textContent = text;
  const actionEl = root.getElementById("adaceenSwitchAction");
  if (actionEl && action) {
    actionEl.hidden = false;
    actionEl.textContent = action.label;
    actionEl.addEventListener("click", () => {
      location.href = action.href;
    });
  }
  root.getElementById("adaceenSwitchClose")?.addEventListener("click", () => host.remove());
  document.documentElement.appendChild(host);
  if (signedIn && signedIn === expected) {
    window.setTimeout(() => {
      if (host.isConnected) location.href = GITHUB_DEVICE_LOGIN_URL;
    }, GITHUB_SWITCH_RETURN_MS);
  }
  return true;
}

// Cuenta de GitHub que autorizo el codigo del tunel, por usuario de ADACEEN (0.8.1).
async function rememberTunnelDeviceAccount(handoff, account) {
  const userId = getCurrentUserId();
  const login = normalizeGithubLoginHint(account);
  if (!userId || !login || !isExtensionRuntimeReady()) return false;
  try {
    await chrome.storage.local.set({
      [STORAGE_KEY_TUNNEL_DEVICE_ACCOUNT]: {
        userId,
        expected: normalizeGithubLoginHint(handoff?.githubLogin),
        account: login,
        at: Date.now(),
        expiresAt: Date.now() + TUNNEL_DEVICE_ACCOUNT_TTL_MS,
      },
    });
    return true;
  } catch {
    return false;
  }
}

async function readTunnelDeviceAccount() {
  if (!isExtensionRuntimeReady()) return null;
  try {
    const raw = (await chrome.storage.local.get([STORAGE_KEY_TUNNEL_DEVICE_ACCOUNT]))?.[STORAGE_KEY_TUNNEL_DEVICE_ACCOUNT];
    if (!raw || !(Number(raw.expiresAt) > Date.now())) return null;
    const userId = getCurrentUserId();
    if (!userId || toText(raw.userId) !== userId) return null;
    const account = normalizeGithubLoginHint(raw.account);
    return account ? { account, expected: normalizeGithubLoginHint(raw.expected) } : null;
  } catch {
    return null;
  }
}

async function clearTunnelDeviceAccount() {
  if (!isExtensionRuntimeReady()) return;
  try {
    await chrome.storage.local.remove([STORAGE_KEY_TUNNEL_DEVICE_ACCOUNT]);
  } catch {}
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

// El aviso de entrar a VS Code que sigue vigente para el usuario de ADACEEN (sin borrarlo).
async function readTunnelSignInHint() {
  if (!isExtensionRuntimeReady()) return null;
  let hint = null;
  try {
    hint = (await chrome.storage.local.get([STORAGE_KEY_TUNNEL_SIGNIN_HINT]))?.[STORAGE_KEY_TUNNEL_SIGNIN_HINT] || null;
  } catch {
    return null;
  }
  if (!hint || !toText(hint.tunnelName)) return null;
  if (!(Number(hint.expiresAt) > Date.now())) {
    await clearTunnelSignInHint();
    return null;
  }
  await syncFromStorageSnapshot({ force: true }).catch(() => false);
  const userId = getCurrentUserId();
  if (!userId || toText(hint.userId) !== userId) return null;
  return hint;
}

// Aviso del paso 4 (0.8.0): arriba, con los pasos, lo que va a pedir VS Code (o GitHub) y la
// cuenta correcta. «Ya entre» lo quita para siempre; si no, vuelve en esta pestana o en la de
// GitHub hasta que vence (10 min).
function mountTunnelSignInBanner({ hostId, label, intro, items, onDone, warning = "" }) {
  document.getElementById(hostId)?.remove();
  const host = document.createElement("div");
  host.id = hostId;
  const root = host.attachShadow({ mode: "closed" });
  // Markup fijo; los textos entran con textContent.
  root.innerHTML = `
    <style>
      .box { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483646;
        display: grid; gap: 8px; box-sizing: border-box; width: min(660px, calc(100vw - 24px));
        padding: 14px 44px 14px 16px; border-radius: 10px; background: #06131b; color: #f8fbff;
        border: 1px solid rgba(118, 239, 229, 0.65); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
        font: 14px/1.45 Segoe UI, Arial, sans-serif; }
      p { margin: 0; color: #d9eaf0; }
      ol.todo { margin: 0; padding-left: 20px; display: grid; gap: 4px; }
      ol.todo li::marker { color: #76efe5; font-weight: 700; }
      .actions { display: flex; gap: 8px; }
      button { font: inherit; border: 0; border-radius: 8px; cursor: pointer; }
      button.done { padding: 7px 12px; font-weight: 700; background: #dffffb; color: #07353b; }
      button.close { position: absolute; top: 8px; right: 8px; background: transparent; color: #d9eaf0; padding: 4px 8px; }
      button:focus-visible { outline: 3px solid #ffd08a; outline-offset: 2px; }
      .warn { padding: 8px 10px; border-radius: 8px; background: #3b2a06; color: #ffe2a3; border: 1px solid #c99a2e; }
      ${FIRST_TIME_STEPS_CSS}
    </style>
    <aside class="box" role="region" aria-label="">
      <strong class="step-title">${firstTimeStepHeading("open")}</strong>
      ${firstTimeStepsMarkup("open")}
      <p class="warn" id="adaceenTunnelSignInWarn" role="status" hidden></p>
      <p id="adaceenTunnelSignInText"></p>
      <ol class="todo" id="adaceenTunnelSignInSteps"></ol>
      <div class="actions"><button type="button" class="done" id="adaceenTunnelSignInDone">Ya entré</button></div>
      <button type="button" class="close" id="adaceenTunnelSignInClose" aria-label="Ocultar el aviso">&times;</button>
    </aside>`;
  root.querySelector("aside")?.setAttribute("aria-label", label);
  const textEl = root.getElementById("adaceenTunnelSignInText");
  if (textEl) textEl.textContent = intro;
  const warnEl = root.getElementById("adaceenTunnelSignInWarn");
  if (warnEl) {
    warnEl.hidden = !warning;
    warnEl.textContent = warning;
  }
  const listEl = root.getElementById("adaceenTunnelSignInSteps");
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    listEl?.appendChild(li);
  }
  root.getElementById("adaceenTunnelSignInClose")?.addEventListener("click", () => host.remove());
  root.getElementById("adaceenTunnelSignInDone")?.addEventListener("click", () => {
    host.remove();
    if (typeof onDone === "function") onDone();
  });
  document.documentElement.appendChild(host);
  return host;
}

function tunnelSignInAccountText(login) {
  return login ? `la cuenta «${login}» (la misma que autorizó el código)` : "la misma cuenta de GitHub que autorizó el código";
}

// En vscode.dev/tunnel/<nombre>: el paso 4. Solo para el usuario de ADACEEN que abrio ese editor
// y en los minutos siguientes; se va con «Ya entre» o al vencer.
async function showTunnelSignInHint() {
  const tunnelName = tunnelNameFromEditorUrl(location.href);
  if (!tunnelName || !isExtensionRuntimeReady()) return false;
  const hint = await readTunnelSignInHint();
  if (!hint || toText(hint.tunnelName).toLowerCase() !== tunnelName) return false;
  const account = tunnelSignInAccountText(normalizeGithubLoginHint(hint.githubLogin));
  const host = mountTunnelSignInBanner({
    hostId: TUNNEL_SIGNIN_HINT_HOST_ID,
    label: "ADACEEN: como entrar a tu editor",
    intro: "Último paso, solo la primera vez: VS Code tiene que confirmar que tu cuenta de GitHub puede entrar a tu editor.",
    items: [
      "Si VS Code pregunta si una extensión puede iniciar sesión con GitHub, pulsa «Allow» (Permitir). Si te deja elegir, elige «GitHub», nunca Microsoft.",
      `En la página de GitHub que se abre, autoriza «Visual Studio Code» con ${account}.`,
      "Vuelve a esta pestaña: en unos segundos aparecen los archivos de tu ejercicio. Entonces pulsa «Ya entré».",
    ],
    onDone: () => {
      clearTunnelSignInHint().catch(() => {});
    },
  });
  // Cuando ya entro, el aviso sobra: se va solo cuando vence.
  window.setTimeout(() => host.remove(), Math.max(0, Number(hint.expiresAt) - Date.now()));
  return true;
}

// La pagina de GitHub que abre VS Code para autorizar «Visual Studio Code» (redirect_uri de
// vscode.dev), o su inicio de sesion previo: el mismo paso 4 con la cuenta correcta.
function isVscodeGithubAuthorizePage(href = location.href) {
  try {
    const url = new URL(toText(href));
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return false;
    const path = url.pathname.toLowerCase();
    let authorize = url;
    if (path === "/login" || path === "/session") {
      const returnTo = toText(url.searchParams.get("return_to"));
      if (!returnTo) return false;
      authorize = new URL(returnTo, "https://github.com");
    }
    if (!authorize.pathname.toLowerCase().startsWith("/login/oauth/authorize")) return false;
    const redirectUri = toText(authorize.searchParams.get("redirect_uri"));
    if (!redirectUri) return false;
    const host = new URL(redirectUri).hostname.toLowerCase();
    return host === "vscode.dev" || host.endsWith(".vscode.dev") || host.includes("vscode-redirect");
  } catch {
    return false;
  }
}

async function showVscodeGithubAuthorizeHelper() {
  if (!isVscodeGithubAuthorizePage()) return false;
  const hint = await readTunnelSignInHint();
  if (!hint) return false;
  const expected = normalizeGithubLoginHint(hint.githubLogin);
  const account = tunnelSignInAccountText(expected);
  const signIn = /^\/(login|session)\/?$/i.test(location.pathname);
  // 0.8.1: con otra cuenta abierta en GitHub, VS Code entraria con esa y no encontraria el editor.
  const signedIn = signIn ? "" : readGithubSignedInLogin();
  const warning = expected && signedIn && signedIn !== expected
    ? `Estás en GitHub como «${signedIn}», pero tu editor es de «${expected}». No autorices con esta cuenta: cambia de cuenta (tu foto, arriba a la derecha) y vuelve a entrar a tu editor.`
    : "";
  mountTunnelSignInBanner({
    warning,
    hostId: TUNNEL_SIGNIN_GITHUB_HOST_ID,
    label: "ADACEEN: autoriza Visual Studio Code",
    intro: signIn
      ? `GitHub te pide iniciar sesión para que VS Code entre a tu editor. Usa ${account}.`
      : `Esta página es de GitHub: autoriza «Visual Studio Code» con ${account} para entrar a tu editor.`,
    items: signIn
      ? ["Inicia sesión con esa cuenta.", "Después pulsa el botón verde para autorizar «Visual Studio Code».", "GitHub te devuelve solo a tu editor."]
      : ["Revisa que arriba a la derecha esté tu cuenta.", "Pulsa el botón verde para autorizar «Visual Studio Code».", "GitHub te devuelve solo a tu editor."],
    onDone: () => {
      clearTunnelSignInHint().catch(() => {});
    },
  });
  return true;
}

// ---- vscode.dev no encuentra el tunel: el punto de restauracion (0.8.1) ----

// vscode.dev (en el idioma del navegador) cuando la cuenta con la que se entro no tiene ese tunel.
const TUNNEL_NOT_FOUND_PATTERNS = [
  /(no se pudo encontrar|no se encontr[oó]|no se puede encontrar|no encontramos)[^.!?]{0,80}t[uú]nel/i,
  /(could ?n[o']?t find|unable to find|cannot find|can't find)[^.!?]{0,80}tunnel/i,
  /tunnel[^.!?]{0,60}(not found|was not found|does not exist)/i,
  /t[uú]nel[^.!?]{0,60}(no existe|no se encontr)/i,
];
const TUNNEL_NOT_FOUND_DIALOG_SELECTOR = '.monaco-dialog-box, [role="dialog"], [role="alertdialog"], .notification-toast';

function isTunnelNotFoundText(value) {
  const text = toText(value).replace(/\s+/g, " ");
  return Boolean(text) && TUNNEL_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(text));
}

// El dialogo de vscode.dev o, si cambia su markup, el texto de la pagina (solo si nombra el tunel).
function tunnelNotFoundOnPage(tunnelName) {
  let nodes = [];
  try {
    nodes = Array.from(document.querySelectorAll(TUNNEL_NOT_FOUND_DIALOG_SELECTOR) || []);
  } catch {
    nodes = [];
  }
  if (nodes.some((node) => isTunnelNotFoundText(node?.innerText || node?.textContent))) return true;
  const body = toText(document.body?.innerText || document.body?.textContent).slice(0, 6000);
  return Boolean(tunnelName) && body.toLowerCase().includes(tunnelName) && isTunnelNotFoundText(body);
}

// Login de GitHub de una URL del editor: vscode.dev/tunnel/<nombre>/home/ws-<login>/...
function tunnelLoginFromEditorUrl(value) {
  if (!isTunnelEditorUrl(value)) return "";
  try {
    const match = new URL(toText(value)).pathname.match(/\/home\/ws-([a-z0-9-]+)(?:\/|$)/i);
    return match ? normalizeGithubLoginHint(match[1]) : "";
  } catch {
    return "";
  }
}

function tunnelEditorPath(value) {
  try {
    return decodeURIComponent(new URL(toText(value)).pathname).toLowerCase().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

// El editor guardado de esta pestana: el de esta carpeta del tunel o, si no, otro del mismo tunel.
function savedEditorForTunnelUrl(value) {
  const tunnelName = tunnelNameFromEditorUrl(value);
  const here = tunnelEditorPath(value);
  if (!tunnelName || !here) return null;
  const editors = listSavedTunnelEditors().filter((record) => tunnelNameFromEditorUrl(record?.webUrl) === tunnelName);
  return editors.find((record) => {
    const path = tunnelEditorPath(record.webUrl);
    return path && (here === path || here.startsWith(`${path}/`));
  }) || editors[0] || null;
}

// Que paso, con lo que se sabe: quien autorizo el codigo (rememberTunnelDeviceAccount), de quien
// es el editor y si ya se borro la sesion de vscode.dev (0.8.2). "device": el codigo lo autorizo
// otra cuenta (reconectar); "vscode": el codigo esta bien y vscode.dev usa otra cuenta guardada
// (entrar de nuevo); "after_reset": ya se volvio a entrar y sigue igual; "unknown": no se sabe.
function tunnelNotFoundCause(device, expected, resetRecently = false) {
  if (device?.account && expected && device.account !== expected) return "device";
  if (resetRecently) return "after_reset";
  if (device?.account && expected) return "vscode";
  return "unknown";
}

// Textos y orden de los botones (el primero es el principal) para cada causa.
function tunnelNotFoundCopy(cause, expected, device) {
  const mine = expected ? `«${expected}»` : "la cuenta de GitHub conectada a ADACEEN";
  const enter = vscodeEnterLabel(expected);
  const reconnectTail = `ADACEEN apaga tu editor un momento y te da un código nuevo para autorizarlo con ${mine}. Tus archivos no se tocan.`;
  const enterTail = `ADACEEN borra la sesión que vscode.dev guarda en este navegador y recarga la página (tus archivos están en la VM y no se tocan). Cuando VS Code lo pida, elige GitHub y autoriza con ${mine}.`;
  const otherAccount = `¿Tu cuenta de GitHub no es ${mine}? Pulsa «${SWITCH_GITHUB_ACCOUNT_LABEL}»: eliges la tuya en GitHub y ADACEEN te prepara un editor a su nombre.`;
  if (cause === "device") {
    return {
      intro: `El código del paso 3 lo autorizó «${device.account}», pero tu editor es de ${mine}. vscode.dev solo encuentra tu editor con la cuenta que autorizó el código.`,
      items: [`Pulsa «${RECONNECT_BUTTON_LABEL}». ${reconnectTail}`, otherAccount],
      order: ["reconnect", "switch", "enter"],
    };
  }
  if (cause === "vscode") {
    return {
      intro: `Tu editor es de ${mine} y el código se autorizó bien, pero vscode.dev está usando otra cuenta de GitHub guardada en este navegador. ${VSCODE_CHOOSE_ACCOUNT_LOOP_TEXT}`,
      items: [`Pulsa «${enter}». ${enterTail}`, `Si sigue sin encontrarlo, pulsa «${RECONNECT_BUTTON_LABEL}». ${reconnectTail}`, otherAccount],
      order: ["enter", "reconnect", "switch"],
    };
  }
  if (cause === "after_reset") {
    return {
      intro: "Ya volviste a entrar a vscode.dev y tu editor sigue sin aparecer.",
      items: [
        `Si en GitHub autorizaste con ${mine}, el código del paso 3 se autorizó con otra cuenta: pulsa «${RECONNECT_BUTTON_LABEL}». ${reconnectTail}`,
        `Si en GitHub quedó otra cuenta, cámbiala (tu foto, arriba a la derecha) y pulsa «${enter}» otra vez.`,
        otherAccount,
      ],
      order: ["reconnect", "enter", "switch"],
    };
  }
  return {
    intro: `vscode.dev no encuentra tu editor con la cuenta de GitHub con la que entraste. Tu editor está a nombre de ${mine} (la cuenta de GitHub conectada a ADACEEN).`,
    items: [
      `Lo más común: vscode.dev usa otra cuenta guardada en este navegador (${VSCODE_CHOOSE_ACCOUNT_LOOP_TEXT.replace(/\.$/, "")}). Pulsa «${enter}». ${enterTail}`,
      `Si sigue igual, pulsa «${RECONNECT_BUTTON_LABEL}». ${reconnectTail}`,
      otherAccount,
    ],
    order: ["enter", "reconnect", "switch"],
  };
}

// Cuando se borro la sesion de vscode.dev para este tunel (por usuario de ADACEEN).
async function markVscodeSessionReset(tunnelName) {
  const userId = getCurrentUserId();
  if (!userId || !tunnelName || !isExtensionRuntimeReady()) return false;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_VSCODE_SESSION_RESET]: { userId, tunnelName, at: Date.now() } });
    return true;
  } catch {
    return false;
  }
}

async function vscodeSessionResetRecently(tunnelName) {
  if (!isExtensionRuntimeReady()) return false;
  try {
    const raw = (await chrome.storage.local.get([STORAGE_KEY_VSCODE_SESSION_RESET]))?.[STORAGE_KEY_VSCODE_SESSION_RESET];
    return Boolean(raw)
      && toText(raw.userId) === getCurrentUserId()
      && toText(raw.tunnelName).toLowerCase() === tunnelName
      && Date.now() - Number(raw.at) < VSCODE_SESSION_RESET_TTL_MS;
  } catch {
    return false;
  }
}

// Lo que la pagina puede borrar de su propio origen (si el background no pudo): almacenamiento,
// bases IndexedDB y caches de vscode.dev. Las cookies quedan; por eso el camino normal es el
// background (browsingData).
async function clearVscodeWebStorageFromPage() {
  try {
    localStorage.clear();
  } catch {}
  try {
    sessionStorage.clear();
  } catch {}
  if (typeof indexedDB !== "undefined" && typeof indexedDB.databases === "function") {
    const databases = await indexedDB.databases();
    await Promise.all(databases.map((database) => new Promise((resolve) => {
      if (!database?.name) {
        resolve();
        return;
      }
      const request = indexedDB.deleteDatabase(database.name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      // Abierta por VS Code: se borra al recargar.
      request.onblocked = () => resolve();
    })));
  }
  if (typeof caches !== "undefined" && typeof caches.keys === "function") {
    for (const key of await caches.keys()) await caches.delete(key);
  }
}

// «Entrar con <cuenta>»: el background borra los datos de vscode.dev y vuelve a abrir el editor;
// VS Code pide iniciar sesion y GitHub usa la cuenta abierta. Antes se deja el aviso del paso 4
// con la cuenta correcta (en vscode.dev y en la pagina de GitHub que autoriza a VS Code).
async function resetVscodeWebSession({ expected, tunnelName }) {
  await saveTunnelSignInHint(location.href, expected).catch(() => false);
  await markVscodeSessionReset(tunnelName);
  let response = null;
  try {
    response = await chrome.runtime.sendMessage({ type: "ADACEEN_RESET_VSCODE_SESSION", origin: location.origin, url: location.href });
  } catch {
    response = null;
  }
  if (response?.ok) return { ok: true };
  if (!response) {
    // La pestana pudo empezar a irse antes de la respuesta: si sigue aqui, se intenta desde la pagina.
    await new Promise((resolve) => window.setTimeout(resolve, VSCODE_SESSION_RESET_FALLBACK_MS));
  }
  try {
    await clearVscodeWebStorageFromPage();
    window.setTimeout(() => location.reload(), 300);
    return { ok: true };
  } catch {
    return { ok: false, error: VSCODE_SESSION_RESET_MANUAL_TEXT };
  }
}

async function showTunnelNotFoundBanner(tunnelName) {
  await syncFromStorageSnapshot({ force: true }).catch(() => false);
  const userId = getCurrentUserId();
  if (!userId) return false;
  const saved = savedEditorForTunnelUrl(location.href);
  const hint = await readTunnelSignInHint();
  const device = await readTunnelDeviceAccount();
  const urlLogin = tunnelLoginFromEditorUrl(location.href);
  // Solo el editor de quien tiene la sesion de ADACEEN (no el enlace de otro estudiante).
  const own = Boolean(saved)
    || toText(hint?.tunnelName).toLowerCase() === tunnelName
    || Boolean(device?.expected && device.expected === urlLogin);
  if (!own) return false;
  const expected = normalizeGithubLoginHint(hint?.githubLogin) || device?.expected || urlLogin
    || normalizeGithubLoginHint(overlayState.githubUserStatus?.accountLogin);
  const repoFullName = parseRepoFullName(saved?.repoFullName) || parseRepoFullName(getLatestSavedTunnelEditor()?.repoFullName);
  const cause = tunnelNotFoundCause(device, expected, await vscodeSessionResetRecently(tunnelName));
  const copy = tunnelNotFoundCopy(cause, expected, device);

  document.getElementById(TUNNEL_NOT_FOUND_HOST_ID)?.remove();
  const host = document.createElement("div");
  host.id = TUNNEL_NOT_FOUND_HOST_ID;
  const root = host.attachShadow({ mode: "closed" });
  // Markup fijo; los textos entran con textContent.
  root.innerHTML = `
    <style>
      .box { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
        display: grid; gap: 8px; box-sizing: border-box; width: min(660px, calc(100vw - 24px));
        padding: 14px 44px 14px 16px; border-radius: 10px; background: #06131b; color: #f8fbff;
        border: 1px solid #c99a2e; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
        font: 14px/1.45 Segoe UI, Arial, sans-serif; }
      strong.title { color: #ffe2a3; font-size: 15px; }
      p { margin: 0; color: #d9eaf0; }
      ol { margin: 0; padding-left: 20px; display: grid; gap: 4px; }
      ol li::marker { color: #ffd08a; font-weight: 700; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      button { font: inherit; border: 0; border-radius: 8px; cursor: pointer; }
      button.primary { padding: 8px 14px; font-weight: 700; background: #ffd08a; color: #3b2a06; }
      button.primary, button.secondary { padding: 8px 14px; font-weight: 700; }
      button.secondary { background: transparent; color: #ffe2a3; border: 1px solid #c99a2e; }
      button[disabled] { opacity: 0.6; cursor: default; }
      button.close { position: absolute; top: 8px; right: 8px; background: transparent; color: #d9eaf0; padding: 4px 8px; }
      button:focus-visible { outline: 3px solid #76efe5; outline-offset: 2px; }
      .status { color: #9ff0c6; }
      .status.is-error { color: #ffb4a8; }
    </style>
    <aside class="box" role="alertdialog" aria-label="ADACEEN: tu editor no aparece con esta cuenta de GitHub">
      <strong class="title">ADACEEN · Tu editor no aparece con esta cuenta de GitHub</strong>
      <p id="adaceenNotFoundText"></p>
      <ol id="adaceenNotFoundSteps"></ol>
      <div class="actions">
        <button type="button" class="secondary" id="adaceenNotFoundEnter"></button>
        <button type="button" class="secondary" id="adaceenNotFoundReconnect"></button>
        <button type="button" class="secondary" id="adaceenNotFoundSwitch"></button>
      </div>
      <p class="status" id="adaceenNotFoundStatus" role="status" hidden></p>
      <button type="button" class="close" id="adaceenNotFoundClose" aria-label="Ocultar el aviso">&times;</button>
    </aside>`;
  const textEl = root.getElementById("adaceenNotFoundText");
  if (textEl) textEl.textContent = copy.intro;
  const listEl = root.getElementById("adaceenNotFoundSteps");
  for (const item of copy.items) {
    const li = document.createElement("li");
    li.textContent = item;
    listEl?.appendChild(li);
  }
  const statusEl = root.getElementById("adaceenNotFoundStatus");
  const setStatus = (text, isError = false) => {
    if (!statusEl) return;
    statusEl.hidden = !text;
    statusEl.className = isError ? "status is-error" : "status";
    statusEl.textContent = text;
  };
  const button = root.getElementById("adaceenNotFoundReconnect");
  const switchButton = root.getElementById("adaceenNotFoundSwitch");
  const enterButton = root.getElementById("adaceenNotFoundEnter");
  if (button) button.textContent = RECONNECT_BUTTON_LABEL;
  if (switchButton) switchButton.textContent = SWITCH_GITHUB_ACCOUNT_LABEL;
  if (enterButton) enterButton.textContent = vscodeEnterLabel(expected);
  // El orden de la causa: el primero es el principal.
  const buttonsByKey = { enter: enterButton, reconnect: button, switch: switchButton };
  copy.order.forEach((key, index) => {
    const element = buttonsByKey[key];
    if (!element) return;
    element.className = index === 0 ? "primary" : "secondary";
    if (element.style) element.style.order = String(index);
  });
  const setBusy = (value) => {
    if (button) button.disabled = value || !repoFullName;
    if (switchButton) switchButton.disabled = value || !repoFullName;
    // Entrar de nuevo no necesita el repositorio: solo borra la sesion de vscode.dev.
    if (enterButton) enterButton.disabled = value;
  };
  setBusy(false);
  if (!repoFullName) {
    setStatus(`Para reconectar, abre tu ejercicio desde ADACEEN («Abrir el ejercicio en mi editor»). «${vscodeEnterLabel(expected)}» funciona igual.`, true);
  }
  let busy = false;
  const failed = (text) => {
    busy = false;
    setBusy(false);
    setStatus(text || "No se pudo reconectar. Vuelve a intentar en un momento.", true);
  };
  button?.addEventListener("click", () => {
    if (busy || !repoFullName) return;
    busy = true;
    setBusy(true);
    // La ventana de espera se abre en el mismo clic (si no, el navegador la bloquea).
    const pendingWindow = openCodespaceWaitingWindow(repoFullName);
    setStatus(`Reconectando: sigue en la pestaña nueva. Allí ADACEEN te da un código nuevo para autorizarlo con ${expected ? `«${expected}»` : "tu cuenta"}.`);
    reconnectTunnelWorkspace({ repoFullName, pendingWindow })
      .then((ready) => {
        if (ready) {
          setStatus("Listo: tu editor abrió en la otra pestaña con tu cuenta. Ya puedes cerrar esta.");
          return;
        }
        failed(toText(overlayState.operationDetail));
      })
      .catch((error) => failed(error?.message || String(error)));
  });
  enterButton?.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    setBusy(true);
    setStatus(`Borrando la sesión de vscode.dev en este navegador; la página se recarga sola. Cuando VS Code lo pida, elige GitHub y autoriza con ${expected ? `«${expected}»` : "tu cuenta"}.`);
    resetVscodeWebSession({ expected, tunnelName })
      .then((result) => {
        if (!result.ok) failed(result.error);
      })
      .catch(() => failed(VSCODE_SESSION_RESET_MANUAL_TEXT));
  });
  switchButton?.addEventListener("click", () => {
    if (busy || !repoFullName) return;
    busy = true;
    setBusy(true);
    // La ventana para GitHub (y despues para la espera del editor) se abre en el mismo clic.
    const pendingWindow = window.open("about:blank", "_blank");
    setStatus("Sigue en la pestaña nueva: elige tu cuenta en GitHub y autoriza a ADACEEN. Después ADACEEN te prepara el editor a su nombre en esa misma pestaña.");
    switchTunnelGithubAccount({ repoFullName, pendingWindow })
      .then((started) => {
        if (!started) failed(toText(overlayState.statusMessage) || "No se pudo abrir GitHub. Vuelve a intentar en un momento.");
      })
      .catch((error) => failed(error?.message || String(error)));
  });
  root.getElementById("adaceenNotFoundClose")?.addEventListener("click", () => host.remove());
  document.documentElement.appendChild(host);
  return true;
}

// En vscode.dev/tunnel/<nombre>: si vscode.dev dice que no encuentra el tunel, el aviso con
// «Reconectar con mi cuenta». Se mira un rato despues de cargar (el dialogo tarda unos segundos).
async function watchTunnelNotFound() {
  const tunnelName = tunnelNameFromEditorUrl(location.href);
  if (!tunnelName || !isExtensionRuntimeReady()) return false;
  const startedAt = Date.now();
  for (;;) {
    if (document.getElementById(TUNNEL_NOT_FOUND_HOST_ID)) return true;
    if (tunnelNotFoundOnPage(tunnelName)) return showTunnelNotFoundBanner(tunnelName);
    if (Date.now() - startedAt >= TUNNEL_NOT_FOUND_WATCH_MS) return false;
    await new Promise((resolve) => window.setTimeout(resolve, TUNNEL_NOT_FOUND_CHECK_MS));
  }
}

// «Reconectar con mi cuenta»: prepare con reconnect (la VM cierra la sesion del tunel de la otra
// cuenta y pide un codigo nuevo); despues, el mismo camino de la primera vez (pasos 3 y 4).
async function reconnectTunnelWorkspace(options = {}) {
  const repoFullName = parseRepoFullName(options?.repoFullName);
  const pendingWindow = options?.pendingWindow && !options.pendingWindow.closed ? options.pendingWindow : null;
  if (!repoFullName || overlayState.githubAppBusy || myTunnelEditorOpening) {
    if (pendingWindow) pendingWindow.close();
    return false;
  }
  myTunnelEditorOpening = true;
  try {
    await syncFromStorageSnapshot({ force: true }).catch(() => false);
    if (!overlayState.workspaceProvider) overlayState.workspaceProvider = "tunnel";
    return await prepareTunnelWorkspace({ pendingWindow, repoFullName, reconnect: true, buttonLabel: RECONNECT_BUTTON_LABEL });
  } finally {
    myTunnelEditorOpening = false;
  }
}

// «Usar otra cuenta de GitHub» (0.8.1): el estudiante conecto a ADACEEN una cuenta que no era la
// suya. GitHub muestra su selector de cuentas; con la nueva, el OAuth sigue como la primera vez
// (continueAfterGithubOAuth prepara el editor de ese repositorio, ahora a nombre de esa cuenta).
async function switchTunnelGithubAccount(options = {}) {
  const repoFullName = parseRepoFullName(options?.repoFullName);
  const pendingWindow = options?.pendingWindow && !options.pendingWindow.closed ? options.pendingWindow : null;
  if (!repoFullName || overlayState.githubAppBusy || myTunnelEditorOpening) {
    if (pendingWindow) pendingWindow.close();
    return false;
  }
  await syncFromStorageSnapshot({ force: true }).catch(() => false);
  if (!overlayState.workspaceProvider) overlayState.workspaceProvider = "tunnel";
  // El token que hay ahora: la espera sigue cuando el backend guarde el de la cuenta elegida.
  try {
    await refreshGithubUserStatus();
  } catch {}
  await clearTunnelDeviceAccount();
  await clearTunnelSignInHint();
  await startGithubUserOAuthFlow({ pendingWindow, repoFullName, selectAccount: true });
  // Sin ventana de GitHub abierta, no arranco (el backend fallo o el navegador la bloqueo).
  return Boolean(getPendingGithubOAuthWindow());
}

// ---- Preparar y abrir ----

// Las diapositivas de la ventana de espera se arman en el clic, antes de saber el material del
// curso (como hace el camino de Codespaces, se consulta y se vuelven a pintar). Sin esperar: la
// preparacion del editor no depende de esto.
function refreshTunnelWaitingSlides(pendingWindow, repoFullName) {
  if (!pendingWindow || typeof refreshCodespaceWaitingContext !== "function") return;
  refreshCodespaceWaitingContext({ reuseCourses: true })
    .then(() => {
      if (typeof updateCodespaceWaitingSlides === "function") updateCodespaceWaitingSlides(pendingWindow, repoFullName);
    })
    .catch(() => {});
}

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

// Devuelve true si el editor quedo listo (y se abrio o se ofrecio abrirlo).
// options.reconnect (0.8.1): la VM cierra la sesion del tunel y pide un codigo nuevo
// (reconnectTunnelWorkspace, el punto de restauracion).
async function prepareTunnelWorkspace(options = {}) {
  const repoFullName = parseRepoFullName(options?.repoFullName) || getCurrentRepoFullName();
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const providedWindow = options?.pendingWindow && !options.pendingWindow.closed ? options.pendingWindow : null;
  if (!repoFullName || !baseUrl || !overlayState.sessionId) {
    if (providedWindow) providedWindow.close();
    overlayState.statusMessage = "Debes iniciar sesion y estar en un repositorio para preparar el editor.";
    renderOverlay();
    return false;
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
      // El repositorio va con el OAuth: al volver se prepara este, aunque la pagina no lo tenga.
      await startGithubUserOAuthFlow({ pendingWindow: providedWindow, repoFullName, buttonLabel: options?.buttonLabel });
    } else if (providedWindow) {
      providedWindow.close();
    }
    return false;
  }

  const force = Boolean(options && options.force);
  const reconnect = Boolean(options && options.reconnect);
  // Lo que se sepa de la cuenta que autorizo el codigo anterior ya no vale: el nuevo lo dira.
  if (reconnect) await clearTunnelDeviceAccount();
  let pendingWindow = providedWindow;
  if (!pendingWindow) {
    pendingWindow = openCodespaceWaitingWindow(repoFullName);
  }
  if (pendingWindow) {
    if (reconnect) {
      updateCodespaceWaitingWindow(pendingWindow, "ADACEEN esta reconectando tu editor", "Apaga tu editor un momento y pide un codigo nuevo para autorizarlo con tu cuenta de GitHub. Tus archivos no se tocan.", "", "");
    } else {
      updateCodespaceWaitingWindow(pendingWindow, "ADACEEN esta preparando tu editor", "Clonando el repositorio en la nube y registrando el tunel...", "", "");
    }
    setTunnelWaitingStep(pendingWindow, "start");
    refreshTunnelWaitingSlides(pendingWindow, repoFullName);
  } else {
    overlayState.operationDetail = "El navegador bloqueo la ventana automatica. Cuando el editor este listo, el boton pasa a Abrir mi editor: pulsalo.";
  }

  overlayState.githubAppBusy = true;
  // Sin aviso "Esto puede tardar...": la ventana de espera ya cuenta el progreso.
  renderOverlay();
  if (reconnect) {
    setOperationProgress("Reconectando tu editor", "Cerrando la sesion anterior de tu editor (la de la otra cuenta de GitHub) y pidiendo un codigo nuevo...");
  } else {
    setOperationProgress(force ? "Rehaciendo el editor" : "Preparando el editor", "Clonando el repositorio y registrando el tunel...");
  }

  let lastInfo = null;
  let shownCode = "";
  let editorReady = false;
  let failureMessage = "";
  let handoffAliveAt = 0;
  try {
    const first = await fetchJsonWithTimeout(`${baseUrl}/api/workspaces/prepare`, {
      method: "POST",
      headers: buildApiHeaders(),
      body: JSON.stringify({ repoFullName, force, ...(reconnect ? { reconnect: true } : {}) }),
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
        return false;
      }
      if (info.status === "ready" && info.webUrl) {
        editorReady = true;
        await finishTunnelWorkspace(pendingWindow, info, repoFullName, { sessionWritten: true, deviceCodeShown: !!shownCode });
        return true;
      }
      if (info.status === "error" && !info.retryable) {
        failureMessage = info.message || "El backend devolvio un error sin detalle.";
        setOperationError("No se pudo preparar el editor", info.message || "El backend devolvio un error sin detalle.");
        updateCodespaceWaitingWindow(pendingWindow, "No se pudo preparar el editor", info.message || "Revisa el estado en ADACEEN.", "", "");
        return false;
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
  return editorReady;
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
