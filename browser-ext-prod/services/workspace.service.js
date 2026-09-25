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
    };
    return map;
  });
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

function normalizeDeviceUserCode(value) {
  const code = toText(value).toUpperCase();
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code) ? code : "";
}

// El handoff queda ligado al usuario de ADACEEN que pidio el codigo (equipos compartidos).
async function saveDeviceCodeHandoff(info, repoFullName) {
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

async function showDeviceCodeStep(pendingWindow, info, repoFullName = "") {
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
  if (!(await saveDeviceCodeHandoff(info, repoFullName))) return false;
  const moved = openDeviceLoginInWaitingWindow(pendingWindow, info.verificationUrl);
  if (moved) {
    setOperationProgress(
      `Autoriza tu editor: codigo ${info.userCode}`,
      `La otra pestana abrio github.com/login/device: pega el codigo ${info.userCode} y autoriza. Cuando GitHub confirme, esa misma pestana abrira tu editor.`,
    );
  }
  return moved;
}

// En github.com/login/device: aviso fijo con el codigo y un boton para copiarlo. Solo para el
// usuario de ADACEEN que pidio el codigo, y mientras la espera siga viva.
async function showGithubDeviceCodeHelper() {
  if (!isGithubDeviceLoginPage()) return false;
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
        padding: 12px 16px; border-radius: 10px; background: #06131b; color: #f8fbff;
        border: 1px solid rgba(118, 239, 229, 0.55); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
        font: 14px/1.4 Segoe UI, Arial, sans-serif; }
      .code { font: 700 22px/1.1 ui-monospace, Consolas, monospace; letter-spacing: 2px; color: #76efe5; }
      .copy { flex: 1 1 220px; margin: 0; }
      button { font: inherit; font-weight: 700; border-radius: 8px; border: 0; padding: 8px 12px; cursor: pointer;
        background: #dffffb; color: #07353b; }
      button.close { background: transparent; color: #d9eaf0; padding: 4px 8px; }
      button:focus-visible { outline: 3px solid #ffd08a; outline-offset: 2px; }
    </style>
    <aside class="box" role="region" aria-label="Codigo de ADACEEN para autorizar tu editor">
      <span>ADACEEN · tu codigo</span>
      <strong class="code" id="adaceenDeviceCode"></strong>
      <button type="button" id="adaceenDeviceCodeCopy">Copiar codigo</button>
      <p class="copy" id="adaceenDeviceCodeStatus" role="status">Pegalo aqui y autoriza. Cuando GitHub confirme, esta pestana abrira tu editor sola.</p>
      <button type="button" class="close" id="adaceenDeviceCodeClose" aria-label="Ocultar el codigo">&times;</button>
    </aside>`;
  const codeEl = root.getElementById("adaceenDeviceCode");
  const statusEl = root.getElementById("adaceenDeviceCodeStatus");
  if (codeEl) codeEl.textContent = handoff.userCode;
  // Una vez que ADACEEN deja de esperar, el aviso lo dice y ya no cambia.
  let settled = false;
  let staleTimer = 0;
  const settle = (text) => {
    if (settled) return;
    settled = true;
    if (staleTimer) window.clearInterval(staleTimer);
    if (statusEl) statusEl.textContent = text;
  };
  const stoppedText = "ADACEEN ya no espera este codigo. Si tu editor no se abrio, vuelve a la pestana de ADACEEN y pulsa \"Abrir mi editor\".";
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(handoff.userCode);
      if (statusEl && !settled) statusEl.textContent = "Codigo copiado: pegalo en el primer cuadro y autoriza. Esta pestana abrira tu editor sola.";
      return true;
    } catch {
      if (statusEl && !settled) statusEl.textContent = "Escribe el codigo en los cuadros y autoriza. Esta pestana abrira tu editor sola.";
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

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes?.[STORAGE_KEY_DEVICE_CODE_HANDOFF] || settled || !host.isConnected) return;
    const next = normalizeDeviceCodeHandoff(changes[STORAGE_KEY_DEVICE_CODE_HANDOFF].newValue);
    if (!next) {
      // Editor listo (esta pestana navega al editor), cierre de sesion o caducidad.
      window.setTimeout(() => {
        if (host.isConnected) settle(stoppedText);
      }, DEVICE_CODE_GONE_GRACE_MS);
      return;
    }
    if (next.userId !== handoff.userId) {
      settle(stoppedText);
      return;
    }
    if (next.outcome === "error") {
      const detail = next.message ? ` ${next.message.replace(/[.\s]+$/, "")}.` : "";
      settle(`ADACEEN dejo de esperar.${detail} Vuelve a la pestana de ADACEEN y pulsa "Abrir mi editor".`);
      return;
    }
    if (next.userCode !== handoff.userCode && codeEl) {
      // GitHub emitio otro codigo en la misma espera.
      codeEl.textContent = next.userCode;
      if (statusEl) statusEl.textContent = "Codigo nuevo: pegalo aqui y autoriza. Cuando GitHub confirme, esta pestana abrira tu editor sola.";
    }
    handoff = next;
  });
  // La pestana de origen se recargo o se cerro: la espera dejo de latir.
  staleTimer = window.setInterval(() => {
    if (!host.isConnected) {
      window.clearInterval(staleTimer);
      return;
    }
    if (Date.now() - handoff.aliveAt > DEVICE_CODE_HANDOFF_STALE_MS) settle(stoppedText);
  }, DEVICE_CODE_HELPER_CHECK_MS);

  // Mejor esfuerzo, y solo recien emitido el codigo: con la pestana activa el navegador suele
  // dejar copiar sin clic.
  if (Date.now() - handoff.savedAt < DEVICE_CODE_AUTO_COPY_MS) {
    copyCode().catch(() => {});
  }
  return true;
}

// ---- Preparar y abrir ----

function describeRetryableWorkspaceWait(info) {
  if (info.code === "vm_starting") return "Encendiendo la VM de editores...";
  if (info.code === "agent_unreachable") return "El editor esta apagado; avisa al docente";
  return "Esperando a la VM de editores";
}

// options.sessionWritten: se llega desde prepare (la VM recibio la sesion de VS Code).
async function finishTunnelWorkspace(pendingWindow, info, repoFullName, options = {}) {
  rememberSetupPrResult({ repoFullName }, { codespaceWebUrl: info.webUrl });
  // Durable por usuario y repo: al volver otro dia el overlay ofrece "Abrir mi editor".
  await saveTunnelEditor(repoFullName, info.webUrl, { sessionWritten: options?.sessionWritten === true });
  await markSetupCompleted(repoFullName);
  await clearDeviceCodeHandoff();
  updateCodespaceWaitingWindow(pendingWindow, "Editor listo. Redirigiendo...", "Abriendo VS Code en el navegador.", info.webUrl, "");
  // force: un clic explicito del estudiante (o el final de prepare) siempre navega,
  // aunque hace poco se haya abierto el mismo editor.
  const opened = await navigatePendingCodespaceWindow(pendingWindow, info.webUrl, { force: true });
  await refreshGithubIntegrationStatus().catch(() => {});
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
  // permiso de lectura al repo), pero NO el scope "codespace".
  try {
    await refreshGithubUserStatus();
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
  } else {
    overlayState.operationDetail = "El navegador bloqueo la ventana automatica. Cuando el editor este listo, usa Abrir mi editor.";
  }

  overlayState.githubAppBusy = true;
  // El aviso "Esto puede tardar..." habla de PR y Codespaces: con el tunel la ventana
  // de espera ya cuenta el progreso, asi que no se abre (un clic menos).
  overlayState.processNoticeOpen = false;
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
      if (info.status === "ready" && info.webUrl) {
        editorReady = true;
        await finishTunnelWorkspace(pendingWindow, info, repoFullName, { sessionWritten: true });
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
        await showDeviceCodeStep(pendingWindow, info, repoFullName);
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
    setOperationError(
      "El editor no confirmo a tiempo",
      shownCode
        ? `El codigo ${shownCode} no se autorizo a tiempo. Pulsa "Abrir mi editor" de nuevo para recibir otro.`
        : lastInfo?.retryable
          ? `${lastInfo.message || "La VM de editores sigue sin responder."} Pulsa "Abrir mi editor" de nuevo cuando el docente la encienda.`
          : "El backend no confirmo el tunel. Vuelve a intentar o revisa el estado en ADACEEN.",
    );
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
  if (overlayState.githubAppBusy) {
    overlayState.statusMessage = "ADACEEN ya esta preparando tu editor; la ventana de espera se abrira sola.";
    renderOverlay();
    return false;
  }

  // Desde una pagina sin GitHub el proveedor aun no se consulto: un editor guardado es del
  // tunel (refreshWorkspaceProvider lo corrige en la siguiente consulta).
  if (!overlayState.workspaceProvider && getSavedTunnelEditor(repoFullName)) {
    overlayState.workspaceProvider = "tunnel";
  }
  // La ventana se abre en el mismo clic, antes de cualquier await: asi el navegador no la bloquea.
  const pendingWindow = options?.pendingWindow && !options.pendingWindow.closed
    ? options.pendingWindow
    : openCodespaceWaitingWindow(repoFullName);
  updateCodespaceWaitingWindow(pendingWindow, "Comprobando tu editor", "Revisando que tu editor en la nube este encendido...", "", "");
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
  if (info?.status === "ready" && toSafeHttpUrl(info.webUrl)) {
    return finishTunnelWorkspace(pendingWindow, info, repoFullName);
  }
  await prepareTunnelWorkspace({ pendingWindow, repoFullName });
  return true;
}
