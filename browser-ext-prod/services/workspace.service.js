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
// cambio de cuenta hasta volver al codigo. Si el codigo esta bien pero VS Code entro con otra cuenta
// guardada en vscode.dev, «Cambiar a <cuenta>» cierra esa sesion dentro de VS Code (0.8.5,
// editor-account-switch.service.js, opcional: si no esta, el aviso dice como hacerlo a mano). El
// freno de ese cambio y como se nombran las cuentas vienen de editor-account-switch-record.js, que
// carga antes que este archivo.
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
// El aviso (paso 4) esta en tunnel-entry-guide.service.js.
const TUNNEL_SIGNIN_HINT_TTL_MS = 10 * 60 * 1000;
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
// vscode.dev con la sesion de otra cuenta: «Cambiar a <cuenta>» la cierra dentro de VS Code
// (0.8.5, editor-account-switch.service.js; en la 0.8.2 borraba la sesion guardada de vscode.dev).
const VSCODE_CHOOSE_ACCOUNT_LOOP_TEXT = "«Elegir otra cuenta» de vscode.dev no sirve: vuelve a usar la misma sesión.";

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
