// ADACEEN | Capa 5 - Ciclo de vida: entrada automática al abrir el overlay (con un editor guardado, al restaurarlo
// fijado o como «Empezar»). Movido sin cambios de content-lifecycle.js.

// Entrada al abrir el overlay (item 13 de la auditoria: «Empezar» solo navegaba). Solo al
// abrirlo el estudiante (icono) o al restaurarlo fijado en la pestana visible; nunca por
// sincronizacion entre pestanas ni en github.com/login/device:
//  - sin sesion se muestra el login directamente;
//  - con un editor guardado (acceso simplificado, seccion 4), en GitHub, en paginas sin
//    contexto y en el propio editor del tunel (vscode.dev), entra sin pedir ayuda al tutor ni
//    contar como pestana activa hasta el primer clic o tecla, y ofrece "Abrir mi editor";
//  - con el icono y sin editor guardado entra como si se pulsara «Empezar» (el tutor
//    responde una vez);
//  - restaurado al cargar una pagina con algo que hacer (un repositorio de GitHub, el editor o
//    Campus), entra como con un editor guardado: sin el tutor ni pestana activa hasta que el
//    estudiante interactua, y sin el aviso de conflicto si otra pestana tiene la sesion activa.
//    Las paginas del propio flujo de GitHub (la ventana del OAuth, la instalacion de la GitHub
//    App, ajustes) y las paginas sin contexto se quedan en la bienvenida, como en 0.7.11.
let savedEditorAutoEnterInFlight = null;

// Donde un editor guardado permite entrar sin el tutor: GitHub, paginas sin contexto y
// vscode.dev (tunel). En Campus y en Codespaces el icono sigue pidiendo la primera respuesta.
function isSavedEditorAutoEnterPage(context) {
  const pageType = toText(context?.pageType);
  if (toText(context?.pageContext) === "campus" || pageType.startsWith("campus")) return false;
  if (pageType === "codespace") return isTunnelEditorPage(context);
  return true;
}

// Restaurado sin editor guardado: solo donde el overlay tiene algo que hacer.
function isRestoreAutoEnterPage(context) {
  const pageType = toText(context?.pageType);
  if (toText(context?.pageContext) === "campus" || pageType.startsWith("campus")) return true;
  if (pageType === "codespace") return true;
  return (pageType === "github_code" || pageType === "github_general")
    && !!parseRepoFullName(context?.repoFullName);
}

// Sin red: hay un editor del tunel guardado para la sesion del snapshot y la pagina lo ofrece.
// Con Codespaces ya confirmado (el caso normal sin editor guardado) no aplica.
function hasSavedEditorForAutoEnter(context) {
  if (!isSavedEditorAutoEnterPage(context)) return false;
  if (typeof getLatestSavedTunnelEditor !== "function" || !getLatestSavedTunnelEditor()) return false;
  return !(overlayState.workspaceProvider === "codespaces"
    && !(typeof isWorkspaceProviderProvisional === "function" && isWorkspaceProviderProvisional()));
}

function noteOverlayInteractionAfterAutoEnter() {
  if (!savedEditorAutoEnterIdle) return;
  savedEditorAutoEnterIdle = false;
  if (overlayState.started && document.visibilityState === "visible") {
    queueActiveTabReport(true);
  }
  queueTabSessionSave();
}

// La sesion del snapshot compartido puede ser vieja: /api/auth/me la confirma (y trae la
// privacidad aceptada en el backend). "unknown": sin red o sin respuesta a tiempo. Con un
// timeout corto: mientras tanto el unico boton es "Preparando..." y un backend frio (Azure)
// puede tardar minutos; al vencer, el icono entra igual, como «Empezar».
const SESSION_CONFIRM_ON_OPEN_TIMEOUT_MS = 10000;

async function confirmSessionOnOpen() {
  try {
    return (await fetchCurrentSession({ timeoutMs: SESSION_CONFIRM_ON_OPEN_TIMEOUT_MS })) ? "valid" : "invalid";
  } catch (error) {
    const status = Number(error?.status);
    return status === 401 || status === 403 ? "invalid" : "unknown";
  }
}

// Entra sin el tutor y sin reportarse como pestana activa hasta la primera interaccion. Al
// restaurar la pagina, otra pestana con la sesion activa no abre el aviso de conflicto.
async function enterOverlayIdle(trigger = "user") {
  savedEditorAutoEnterIdle = true;
  await startExperience({ skipModelRequests: true, quietActiveTabConflict: trigger === "restore" });
  if (!overlayState.started) savedEditorAutoEnterIdle = false;
  return overlayState.started;
}

async function autoEnterWithSavedEditor(trigger) {
  if (!hasSavedEditorForAutoEnter(overlayState.context || buildPayload())) return false;
  if (!hasActiveSession() || isAdminSession()) return false;
  // Con Codespaces el editor guardado (del tunel) no aplica.
  if (typeof refreshWorkspaceProvider === "function") {
    await refreshWorkspaceProvider().catch(() => "");
  }
  if (overlayState.workspaceProvider === "codespaces") return false;
  if (overlayState.started || !overlayHost?.isConnected) return false;
  return enterOverlayIdle(trigger);
}

async function autoEnterOnOpen(trigger) {
  if (overlayState.started) return false;
  if (trigger !== "user" && trigger !== "restore") return false;
  if (document.visibilityState === "hidden") return false;
  if (typeof isGithubDeviceLoginPage === "function" && isGithubDeviceLoginPage()) return false;
  if (getActiveTabConflictNotice()) return false;
  if (trigger === "restore") {
    // La ventana del OAuth, la instalacion de la GitHub App... (github.com/login/*,
    // github.com/apps/*): ni se entra ni se consulta el backend.
    const context = overlayState.context || buildPayload();
    if (isGithubFlowPageUrl(toText(context?.url) || location.href)) return false;
    // Paginas sin contexto y sin un editor guardado que ofrecer: «Empezar», como en 0.7.11.
    if (overlayState.sessionId && !isRestoreAutoEnterPage(context) && !hasSavedEditorForAutoEnter(context)) {
      return false;
    }
  }

  if (!overlayState.sessionId) {
    // Sin sesion, «Empezar» solo llevaba al login.
    overlayState.started = true;
    renderOverlay();
    return true;
  }

  // Mientras se confirma la sesion, la bienvenida dice "Preparando..." en vez de «Empezar».
  overlayState.loading = true;
  renderOverlay();
  let session = "unknown";
  try {
    session = await confirmSessionOnOpen();
  } finally {
    if (!overlayState.started) overlayState.loading = false;
  }
  // El estudiante pudo pulsar «Empezar» o cerrar el overlay mientras tanto.
  if (overlayState.started || !overlayHost?.isConnected) return false;
  if (session === "invalid") {
    resetAuthStateForCrossTabSync("");
    overlayState.authError = "La sesion ya no es valida. Inicia sesion nuevamente.";
    await persistPreferences().catch(() => false);
    if (typeof clearSharedSessionSnapshot === "function") {
      await clearSharedSessionSnapshot().catch(() => false);
    }
    overlayState.started = true;
    renderOverlay();
    return true;
  }
  // Sin respuesta del backend, restaurar la pagina no entra (queda «Empezar»); el icono si,
  // como «Empezar».
  if (session === "unknown" && trigger !== "user") {
    renderOverlay();
    return false;
  }
  if (getActiveTabConflictNotice()) {
    renderOverlay();
    return false;
  }

  if (session === "valid" && await autoEnterWithSavedEditor(trigger)) return true;
  if (overlayState.started || !overlayHost?.isConnected || !overlayState.sessionId) return false;
  if (trigger === "user") {
    await startExperience();
    return overlayState.started;
  }
  if (!isRestoreAutoEnterPage(overlayState.context || buildPayload())) {
    renderOverlay();
    return false;
  }
  return enterOverlayIdle(trigger);
}
