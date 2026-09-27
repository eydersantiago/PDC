// ADACEEN | Capa 5 - Ciclo de vida: abrir el editor del estudiante: traspaso de estado al navegar a un
// Codespace, abrir Codespaces, clonar/abrir en VS Code local (protocolo vscode://) y copiar el codigo de
// emparejamiento. Movido sin cambios desde content-lifecycle.js.
// Sin "use strict": el codigo viene de archivos en modo no estricto y se conserva igual.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

const CODESPACE_HANDOFF_TTL_MS = 15 * 60 * 1000;

let activeCodespaceHandoff = null;

function getUrlHost(value) {
  const text = toText(value);
  if (!text) return "";
  try {
    return new URL(text, location.href).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isCodespaceLikeUrl(value) {
  const text = toText(value);
  if (!text) return false;
  try {
    const url = new URL(text, location.href);
    const host = url.hostname.toLowerCase();
    return host === "github.dev"
      || host.endsWith(".github.dev")
      || host === "app.github.dev"
      || host.endsWith(".app.github.dev")
      || host === "codespaces.new"
      || ((host === "vscode.dev" || host === "insiders.vscode.dev") && url.pathname.toLowerCase().startsWith("/tunnel/"))
      || (host === "github.com" && url.pathname.toLowerCase().includes("/codespaces/"));
  } catch {
    return /(^|\.)github\.dev(?:\/|$)|codespaces\.new\/|github\.com\/codespaces\/|vscode\.dev\/tunnel\//i.test(text);
  }
}

function isCodespaceLikeContext(context) {
  const source = context || {};
  return toText(source.pageType) === "codespace"
    || isCodespaceLikeUrl(source.url || location.href);
}

function getCodespaceHandoffRepoFullName(handoff) {
  return parseRepoFullName(
    handoff?.repoFullName
      || handoff?.state?.setupRepoFullName
      || handoff?.state?.context?.repoFullName
      || handoff?.targetUrl
      || handoff?.sourceUrl
      || "",
  );
}

function normalizeCodespaceHandoff(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const ts = Number(raw.ts) || Date.now();
  const expiresAt = Number(raw.expiresAt) || ts + CODESPACE_HANDOFF_TTL_MS;
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;

  return {
    ts,
    expiresAt,
    sessionId: toText(raw.sessionId),
    sourceTabId: toText(raw.sourceTabId),
    sourceUrl: toText(raw.sourceUrl),
    targetUrl: toText(raw.targetUrl),
    repoFullName: parseRepoFullName(raw.repoFullName || ""),
    minimized: raw.minimized === true,
    state: raw.state && typeof raw.state === "object" && !Array.isArray(raw.state)
      ? raw.state
      : null,
  };
}

function isCodespaceHandoffApplicable(context, handoff) {
  const currentContext = context || overlayState.context || buildPayload();
  if (!handoff || !isCodespaceLikeContext(currentContext)) return false;
  if (handoff.expiresAt <= Date.now()) return false;

  const currentSessionId = toText(overlayState.sessionId);
  if (handoff.sessionId && currentSessionId && handoff.sessionId !== currentSessionId) {
    return false;
  }

  const currentHost = getUrlHost(currentContext.url || location.href);
  const targetHost = getUrlHost(handoff.targetUrl);
  if (currentHost && targetHost && currentHost === targetHost) {
    return true;
  }

  const currentRepo = parseRepoFullName(currentContext.repoFullName || currentContext.url || "");
  const handoffRepo = getCodespaceHandoffRepoFullName(handoff);
  if (currentRepo && handoffRepo) {
    return currentRepo.toLowerCase() === handoffRepo.toLowerCase();
  }

  return !currentRepo || !handoffRepo;
}

async function readCodespaceNavigationHandoff(context) {
  if (!isExtensionRuntimeReady()) return null;
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY_CODESPACE_HANDOFF]);
    const handoff = normalizeCodespaceHandoff(stored?.[STORAGE_KEY_CODESPACE_HANDOFF]);
    if (!handoff) {
      await chrome.storage.local.remove([STORAGE_KEY_CODESPACE_HANDOFF]).catch(() => {});
      activeCodespaceHandoff = null;
      return null;
    }

    if (!isCodespaceHandoffApplicable(context, handoff)) {
      return null;
    }

    activeCodespaceHandoff = handoff;
    return handoff;
  } catch {
    return null;
  }
}

async function refreshCodespaceHandoffCache(context) {
  const handoff = await readCodespaceNavigationHandoff(context);
  if (handoff) return handoff;
  if (activeCodespaceHandoff && activeCodespaceHandoff.expiresAt <= Date.now()) {
    activeCodespaceHandoff = null;
  }
  return null;
}

function applyCodespaceNavigationHandoff(handoff, context) {
  if (!handoff) return false;

  if (handoff.state) {
    applyTabSessionSnapshot(handoff.state);
  }

  overlayState.context = context || buildPayload();
  overlayState.minimized = handoff.minimized === true || overlayState.minimized === true;
  overlayState.githubAppBusy = false;
  overlayState.loading = false;
  overlayState.operationTitle = "";
  overlayState.operationDetail = "";
  overlayState.operationKind = "busy";
  activeCodespaceHandoff = handoff;

  if (isCodespaceLikeContext(overlayState.context)) {
    overlayState.analysisUnlocked = true;
    if (!overlayState.statusMessage || /preparando|creando|esperando/i.test(overlayState.statusMessage)) {
      overlayState.statusMessage = "Codespace abierto. ADACEEN conserva tu sesion y contexto.";
    }
  }

  return true;
}

async function prepareCodespaceNavigationHandoff(targetUrl, options = {}) {
  const context = overlayState.context || buildPayload();
  const now = Date.now();
  const handoff = {
    ts: now,
    expiresAt: now + CODESPACE_HANDOFF_TTL_MS,
    sessionId: toText(overlayState.sessionId),
    sourceTabId: getActiveTabInstanceId(),
    sourceUrl: toText(context.url || location.href),
    targetUrl: toText(targetUrl),
    repoFullName: parseRepoFullName(options.repoFullName || getCurrentRepoFullName() || context.repoFullName || ""),
    minimized: true,
    state: buildTabSessionSnapshot(context),
  };

  overlayState.minimized = true;
  overlayState.settingsOpen = false;
  activeCodespaceHandoff = normalizeCodespaceHandoff(handoff);

  await flushTabSessionSave();

  try {
    await chrome.storage.local.set({
      [STORAGE_KEY_OVERLAY_PINNED]: true,
      [STORAGE_KEY_OVERLAY_MINIMIZED]: true,
      [STORAGE_KEY_CODESPACE_HANDOFF]: handoff,
    });
  } catch {}

  sendActiveTabState(false, {
    force: true,
    transition: "codespace_navigation",
    targetUrl: toText(targetUrl).slice(0, 1800),
  }).catch(() => {});

  if (overlayHost?.isConnected) {
    renderOverlay();
  }
}

function shouldIgnoreForeignActiveTabForCodespace(remoteActiveTab) {
  const currentContext = overlayState.context || buildPayload();
  if (!remoteActiveTab?.isActive || !isCodespaceLikeContext(currentContext)) {
    return false;
  }

  const remoteTabId = toText(remoteActiveTab.tabId);
  const currentRepo = parseRepoFullName(currentContext.repoFullName || currentContext.url || "");
  const remoteRepo = parseRepoFullName(remoteActiveTab.tabUrl || remoteActiveTab.viewContext || "");
  const handoff = activeCodespaceHandoff;

  if (handoff && isCodespaceHandoffApplicable(currentContext, handoff)) {
    if (handoff.sourceTabId && remoteTabId === handoff.sourceTabId) {
      return true;
    }
    const handoffRepo = getCodespaceHandoffRepoFullName(handoff);
    if (currentRepo && handoffRepo && currentRepo.toLowerCase() === handoffRepo.toLowerCase()) {
      return true;
    }
    if (!currentRepo || !handoffRepo) {
      return true;
    }
  }

  if (currentRepo && remoteRepo && currentRepo.toLowerCase() === remoteRepo.toLowerCase()) {
    return !isCodespaceLikeUrl(remoteActiveTab.tabUrl);
  }

  return false;
}

// A12.8: toda URL que llega del backend, del modelo o de la pagina se abre solo si es
// http/https y siempre sin opener ni referrer.
function openExternalUrlSafely(url) {
  const safeUrl = toSafeHttpUrl(url);
  if (!safeUrl) return false;
  window.open(safeUrl, "_blank", "noopener,noreferrer");
  return true;
}

/**
 * VS Code instalado en este equipo (por ejemplo, las Mac del laboratorio):
 * la extension Git de VS Code clona el repositorio con vscode://vscode.git/clone.
 * Solo repositorios de github.com con owner/repo valido.
 */
function buildLocalVscodeCloneUrl(repoFullName) {
  const repo = parseRepoFullName(repoFullName);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.+$)[A-Za-z0-9._-]{1,100}$/.test(repo || "")) return "";
  return `vscode://vscode.git/clone?url=${encodeURIComponent(`https://github.com/${repo}.git`)}`;
}

// VS Code 0.0.31 (acceso simplificado, seccion 3): el enlace lleva un codigo de un solo uso;
// la extension lo canjea contra su backend, clona o abre el repo y queda vinculada. Sin
// codigo (pairingCode vacio) solo clona o abre el repo.
function buildLocalVscodeOpenUrl(pairingCode, repoFullName) {
  const repo = parseRepoFullName(repoFullName);
  const code = toText(pairingCode).toUpperCase();
  if (!buildLocalVscodeCloneUrl(repo) || (code && !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code))) return "";
  const [owner, name] = repo.split("/");
  const repoParam = `repo=${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  return code
    ? `vscode://adaceen.adaceen/abrir?code=${encodeURIComponent(code)}&${repoParam}`
    : `vscode://adaceen.adaceen/abrir?${repoParam}`;
}

// El enlace se crea y se pulsa dentro de la shadow root cerrada del overlay: el codigo de
// emparejamiento del href no queda al alcance de los scripts de la pagina (MutationObserver o
// listeners de click en document solo ven el host del overlay).
function openExternalProtocolLink(url) {
  const container = overlayRoot || document.body;
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noopener noreferrer";
  link.style.display = "none";
  container.appendChild(link);
  link.click();
  link.remove();
}

// El navegador solo abre vscode:// con el gesto del clic (unos 5 s): el codigo se pide con un
// limite corto y, si no llega, se usa el enlace anterior.
const LOCAL_VSCODE_PAIRING_TIMEOUT_MS = 3500;

async function openLocalVscodeClone() {
  const repoFullName = getCurrentRepoFullName();
  const cloneUrl = buildLocalVscodeCloneUrl(repoFullName);
  if (!cloneUrl) {
    overlayState.statusMessage = "No se detecto el repositorio (owner/repo) de esta pagina. Usa Autodetectar o escribe owner/repo.";
    renderOverlay();
    return false;
  }

  let pairing = null;
  let pairingError = null;
  try {
    pairing = await requestEditorPairingCode(LOCAL_VSCODE_PAIRING_TIMEOUT_MS);
  } catch (error) {
    pairingError = error;
  }
  const openUrl = pairing ? buildLocalVscodeOpenUrl(pairing.code, repoFullName) : "";
  if (openUrl) {
    openExternalProtocolLink(openUrl);
    overlayState.statusMessage = `Abriendo ${repoFullName} en el VS Code de este equipo: si ya estaba clonado se abre esa carpeta; si no, elige donde guardarlo. ADACEEN se conecta solo. Si no pasa nada, instala o actualiza la extension ADACEEN de VS Code (pagina Empezar del backend).`;
    // Al volver otro dia, "Abrir en VS Code de este equipo" es la accion principal.
    await rememberEditorChoice("local_vscode").catch(() => false);
    renderOverlay();
    return true;
  }

  if (!isEditorPairingUnsupported(pairingError)) {
    // Fallo pasajero (tiempo agotado, 5xx, sin red) o sesion vencida: el repo se abre igual, sin
    // codigo, y la sesion del navegador NO se copia (moriria en el siguiente login y los eventos
    // de VS Code quedarian anonimos). VS Code se conecta con "ADACEEN: sin conectar".
    openExternalProtocolLink(buildLocalVscodeOpenUrl("", repoFullName));
    await rememberEditorChoice("local_vscode").catch(() => false);
    const reason = toText(pairingError?.message).replace(/[.\s]+$/, "") || "sin respuesta";
    overlayState.statusMessage = `Abriendo ${repoFullName} en el VS Code de este equipo. No se pudo pedir el codigo de conexion (${reason}): pulsa este boton de nuevo, o en VS Code pulsa "ADACEEN: sin conectar" en la barra de estado y elige "Con mi cuenta de GitHub".`;
    renderOverlay();
    return true;
  }

  // Backend anterior sin emparejamiento (404): enlace de clonado y la sesion al portapapeles,
  // que VS Code acepta con "ADACEEN: Configurar sesion compartida".
  let sessionCopied = false;
  const sessionId = toText(overlayState.sessionId);
  if (sessionId) {
    try {
      await navigator.clipboard.writeText(sessionId);
      sessionCopied = true;
    } catch {
      sessionCopied = false;
    }
  }
  openExternalProtocolLink(cloneUrl);
  await rememberEditorChoice("local_vscode").catch(() => false);
  overlayState.statusMessage = sessionCopied
    ? `Abriendo VS Code de este equipo para clonar ${repoFullName}: elige una carpeta. Tu sesion quedo copiada; en VS Code pulsa F1, ejecuta "ADACEEN: Configurar sesion compartida" y pegala.`
    : `Abriendo VS Code de este equipo para clonar ${repoFullName}: elige una carpeta. Luego configura la sesion compartida (F1, "ADACEEN: Configurar sesion compartida").`;
  renderOverlay();
  return true;
}

// "Copiar codigo para VS Code" de la seccion VS Code (el boton de la sesion hasta 0.7.11): copia
// un codigo de un solo uso (10 min) que VS Code canjea con "ADACEEN: Conectar". Solo con un backend sin emparejamiento (404) copia la sesion,
// como antes; ante un fallo pasajero pide volver a intentar.
async function copyEditorPairingCodeForVscode() {
  let pairing = null;
  let pairingError = null;
  try {
    pairing = await requestEditorPairingCode();
  } catch (error) {
    pairingError = error;
  }
  if (!pairing && !isEditorPairingUnsupported(pairingError)) {
    const reason = toText(pairingError?.message).replace(/[.\s]+$/, "") || "sin respuesta";
    overlayState.statusMessage = `No se pudo pedir el codigo para VS Code (${reason}). Pulsa Copiar codigo para VS Code de nuevo en unos segundos.`;
    renderOverlay();
    return false;
  }
  if (pairing) {
    const minutes = Math.max(1, Math.round(pairing.ttlSeconds / 60));
    let copied = false;
    try {
      await navigator.clipboard.writeText(pairing.code);
      copied = true;
    } catch {
      copied = false;
    }
    // Una VS Code anterior a la 0.0.31 no tiene "ADACEEN: Conectar" ni canjea codigos: su
    // "Configurar sesion compartida" aceptaria el codigo sin conectar nada.
    const oldVscodeHint = " Si VS Code no tiene ese comando, actualiza su extension de ADACEEN (Descargar extension de VS Code, en /empezar): la anterior no acepta codigos.";
    overlayState.statusMessage = copied
      ? `Codigo copiado (un solo uso, vale ${minutes} min). En VS Code pulsa F1, ejecuta "ADACEEN: Conectar", elige "Tengo un codigo o sesion" y pegalo.${oldVscodeHint}`
      : `Codigo para VS Code: ${pairing.code} (un solo uso, vale ${minutes} min). En VS Code pulsa F1, ejecuta "ADACEEN: Conectar" y elige "Tengo un codigo o sesion".${oldVscodeHint}`;
    renderOverlay();
    return true;
  }

  const value = toText(overlayState.sessionId);
  if (!value) return false;
  try {
    await navigator.clipboard.writeText(value);
    overlayState.statusMessage = "Sesion copiada. En VS Code pulsa F1, ejecuta \"ADACEEN: Configurar sesion compartida\" y pegala.";
  } catch {
    overlayState.statusMessage = `Sesion ADACEEN: ${value}`;
  }
  renderOverlay();
  return true;
}

async function openCodespacesPage() {
  const repoFullName = getCurrentRepoFullName();
  if (!repoFullName) {
    overlayState.statusMessage = "No se detecta repositorio para abrir Codespaces.";
    renderOverlay();
    return;
  }

  const context = overlayState.context || buildPayload();
  if (toText(context?.pageType) === "codespace") {
    await markSetupCompleted();
    overlayState.statusMessage = "Codespace detectado. Continuando sin reiniciar ni preparar otro entorno.";
    if (hasActiveSession()) {
      await refreshMentorSession();
    } else {
      renderOverlay();
    }
    return;
  }

  // Tunel: "Abrir mi editor" (estado y abrir, o preparar). No exige la GitHub App.
  if (typeof isTunnelProvider === "function" && isTunnelProvider()) {
    await openMyTunnelEditor({ repoFullName });
    return;
  }

  const pull = getLatestSetupPullResult();
  const storedCodespaceUrl = getStoredSetupCodespaceUrl();
  if (isDirectCodespaceUrl(storedCodespaceUrl) && openExternalUrlSafely(storedCodespaceUrl)) {
    overlayState.statusMessage = "Abriendo Codespace existente de la PR de preparacion ADACEEN.";
    renderOverlay();
    return;
  }

  const flow = getSetupFlowState(overlayState.context || buildPayload());
  if (flow.accessVerified && flow.userHasCodespaceScope) {
    overlayState.statusMessage = isCodespaceQuickstartUrl(storedCodespaceUrl)
      ? "El enlace guardado es el selector de Codespaces. Creando o reanudando el Codespace automaticamente..."
      : "Preparando o reanudando el Codespace de la PR...";
    renderOverlay();
    await bootstrapDevcontainerWithGithubApp();
    return;
  }

  const codespaceUrl = storedCodespaceUrl
    || buildCodespaceQuickstartUrl(
      repoFullName,
      Number(overlayState.githubAppStatus?.bootstrapPullNumber || pull?.pullNumber) || 0,
      toText(overlayState.githubAppStatus?.bootstrapBranchName || pull?.branchName),
    );

  if (!openExternalUrlSafely(codespaceUrl)) {
    overlayState.statusMessage = "El enlace del Codespace no es valido (solo se abren enlaces http/https).";
    renderOverlay();
    return;
  }
  overlayState.statusMessage = pull?.pullNumber || overlayState.githubAppStatus?.bootstrapPullNumber
    ? "Abriendo Codespaces para la PR de preparacion ADACEEN."
    : `Abriendo Codespaces para ${repoFullName}.`;
  renderOverlay();
}

function openCodespacesManualPage() {
  const repoFullName = getCurrentRepoFullName();
  if (!repoFullName) {
    overlayState.statusMessage = "No se detecta repositorio para abrir Codespaces.";
    renderOverlay();
    return;
  }

  const pull = getLatestSetupPullResult();
  const storedCodespaceUrl = toText(pull?.codespaceUrl)
    || toText(overlayState.githubAppStatus?.bootstrapCodespaceUrl);
  const targetUrl = storedCodespaceUrl
    || buildCodespaceQuickstartUrl(
      repoFullName,
      Number(overlayState.githubAppStatus?.bootstrapPullNumber || pull?.pullNumber) || 0,
      toText(overlayState.githubAppStatus?.bootstrapBranchName || pull?.branchName),
    );

  overlayState.statusMessage = openExternalUrlSafely(targetUrl)
    ? "Abriendo Codespaces manualmente sin volver a preparar el entorno."
    : "El enlace del Codespace no es valido (solo se abren enlaces http/https).";
  renderOverlay();
}
