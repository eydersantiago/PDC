// ADACEEN | Capa 3 - Servicios: cuenta de GitHub del estudiante: OAuth de usuario (ventana y sondeo),
// estado de la integracion y de la GitHub App (instalar, vincular y vigilar la instalacion).
// Movido sin cambios desde services/github.service.js, incluida la llamada de carga
// bindGithubOAuthCallbackListener() al final (se ejecuta justo despues de github.service.js, como antes).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const GITHUB_OAUTH_POLL_INTERVAL_MS = 2500;

const GITHUB_OAUTH_POLL_TIMEOUT_MS = 180000;

const GITHUB_OAUTH_WAIT_TITLE = "Esperando autorizacion GitHub";

let pendingGithubOAuthWindow = null;

// El repositorio (y el boton) con que se empezo a conectar GitHub (0.8.0): «Abrir el ejercicio
// en mi editor» desde Inicio funciona en paginas sin repositorio (/empezar, Campus). Antes, al
// volver del OAuth se calculaba con la pagina, no habia repositorio y el estudiante tenia que
// pulsar otra vez; ahora el editor se prepara solo en la misma ventana.
let pendingGithubOAuthTarget = null;

let githubOAuthPollTimer = 0;

let githubOAuthPollStartedAt = 0;

let githubOAuthPollBusy = false;

let githubOAuthContinueInFlight = false;

let githubOAuthCallbackListenerBound = false;

// Ultima consulta de /api/github/oauth/status (con que sesion y cuando).
let githubUserStatusCheckedAt = 0;

let githubUserStatusCheckedFor = "";

const GITHUB_USER_STATUS_REUSE_MS = 10000;

async function refreshGithubUserStatus() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    overlayState.githubUserStatus = { ...EMPTY_GITHUB_USER_STATUS };
    githubUserStatusCheckedAt = 0;
    return;
  }

  const response = await fetchJsonWithTimeout(`${baseUrl}/api/github/oauth/status`, {
    method: "GET",
    headers: buildApiHeaders(),
  });
  githubUserStatusCheckedAt = Date.now();
  githubUserStatusCheckedFor = toText(overlayState.sessionId);

  overlayState.githubUserStatus = {
    ...EMPTY_GITHUB_USER_STATUS,
    configured: response?.configured === true,
    missingConfig: Array.isArray(response?.missingConfig) ? response.missingConfig : [],
    invalidConfig: Array.isArray(response?.invalidConfig) ? response.invalidConfig : [],
    connected: response?.connected === true,
    accountLogin: toText(response?.accountLogin),
    accountEmail: toText(response?.accountEmail),
    scopes: Array.isArray(response?.scopes) ? response.scopes.map((item) => toText(item)).filter(Boolean) : [],
    hasCodespaceScope: response?.hasCodespaceScope === true,
    updatedAt: toText(response?.updatedAt),
  };
}

// Una cuenta conectada consultada hace unos segundos (por ejemplo, al volver del OAuth justo
// antes de preparar el editor) no se vuelve a pedir. "No conectada" siempre se confirma.
async function refreshGithubUserStatusIfStale(maxAgeMs = GITHUB_USER_STATUS_REUSE_MS) {
  const fresh = githubUserStatusCheckedAt > 0
    && githubUserStatusCheckedFor === toText(overlayState.sessionId)
    && Date.now() - githubUserStatusCheckedAt < maxAgeMs;
  if (fresh && overlayState.githubUserStatus?.connected === true) return;
  await refreshGithubUserStatus();
}

// La pestana que espera el OAuth: si esa ventana termino en el rechazo de GitHub, deja de
// esperar y dice que hacer (antes seguia en «Esperando autorizacion GitHub»).
async function stopWaitingAfterGithubOAuthRedirectError() {
  const failure = await readGithubOAuthRedirectError();
  if (!failure || !(Number(failure.at) >= githubOAuthPollStartedAt)) return false;
  const userId = typeof getCurrentUserId === "function" ? getCurrentUserId() : "";
  if (failure.userId && userId && failure.userId !== userId) return false;
  stopGithubOAuthPolling();
  setOperationError("GitHub no aceptó la conexión", githubOAuthRedirectErrorText(toText(overlayState.session?.user?.role), toText(failure.redirectUri)));
  return true;
}

// Se acabo el tiempo de espera del OAuth sin respuesta: la espera no se queda pegada.
function giveUpGithubOAuthWait() {
  if (overlayState.operationTitle !== GITHUB_OAUTH_WAIT_TITLE) return;
  setOperationError(
    "No se completó la conexión con GitHub",
    "ADACEEN dejó de esperar la autorización de GitHub. Si cerraste esa ventana o GitHub mostró un error, vuelve a pulsar el botón para abrir tu editor.",
  );
}

function stopGithubOAuthPolling() {
  if (githubOAuthPollTimer) {
    window.clearInterval(githubOAuthPollTimer);
    githubOAuthPollTimer = 0;
  }
  githubOAuthPollBusy = false;
  githubOAuthPollStartedAt = 0;
}

function getPendingGithubOAuthWindow() {
  if (pendingGithubOAuthWindow && !pendingGithubOAuthWindow.closed) {
    return pendingGithubOAuthWindow;
  }
  pendingGithubOAuthWindow = null;
  return null;
}

// payload: el aviso del callback del backend ({repoFullName, accountLogin}), si llego por ahi.
async function continueAfterGithubOAuth(source = "oauth", payload = null) {
  if (githubOAuthContinueInFlight) return;
  githubOAuthContinueInFlight = true;
  stopGithubOAuthPolling();

  try {
    if (!overlayHost?.isConnected) {
      await openOverlay();
    }

    overlayState.githubAppBusy = true;
    const tunnelBefore = typeof isTunnelProvider === "function" && isTunnelProvider();
    setOperationProgress(
      "GitHub conectado",
      tunnelBefore
        ? "Preparando tu editor en la nube..."
        : source === "callback"
          ? "Preparando Codespace de la PR asociada..."
          : "OAuth detectado. Preparando Codespace de la PR asociada...",
    );

    try {
      await refreshGithubIntegrationStatus();
    } catch (error) {
      // Con el tunel la GitHub App no interviene: si su estado falla, se sigue igual.
      if (!(typeof isTunnelProvider === "function" && isTunnelProvider())) throw error;
    }
    let flow = getSetupFlowState(overlayState.context || buildPayload());

    // Tunel (acceso simplificado, seccion 4): sin GitHub App. Con la cuenta conectada se
    // prepara el editor en la misma ventana del OAuth, sin otro clic, con el repositorio con
    // que se empezo (0.8.0) aunque la pagina no tenga uno.
    if (typeof isTunnelProvider === "function" && isTunnelProvider()) {
      const target = pendingGithubOAuthTarget;
      const repoFullName = parseRepoFullName(target?.repoFullName)
        || parseRepoFullName(payload?.repoFullName)
        || flow.repoFullName;
      if (!repoFullName) {
        overlayState.statusMessage = `GitHub conectado. Vuelve a tu repositorio en GitHub y pulsa ${getLatestSavedTunnelEditor() ? "Abrir mi editor" : "Preparar mi editor"}.`;
        return;
      }
      if (!flow.userConnected) {
        overlayState.statusMessage = "GitHub aun no confirma tu cuenta. Pulsa Conectar GitHub de nuevo.";
        return;
      }
      pendingGithubOAuthTarget = null;
      await prepareTunnelWorkspace({
        pendingWindow: getPendingGithubOAuthWindow(),
        repoFullName,
        buttonLabel: toText(target?.buttonLabel),
      });
      return;
    }

    if (!flow.repoReady) {
      // El boton del repositorio dice "Abrir mi editor" solo si ya hay un editor guardado.
      overlayState.statusMessage = typeof isTunnelProvider === "function" && isTunnelProvider()
        ? `GitHub conectado. Vuelve a tu repositorio en GitHub y pulsa ${getLatestSavedTunnelEditor() ? "Abrir mi editor" : "Preparar mi editor"}.`
        : "GitHub OAuth conectado. Vuelve al repositorio para abrir el Codespace de la PR.";
      return;
    }

    if (!flow.appConnected && flow.configured && flow.repoReady) {
      const linked = await autoLinkGithubInstallation(flow.repoFullName);
      if (linked) {
        await refreshGithubIntegrationStatus();
        flow = getSetupFlowState(overlayState.context || buildPayload());
      }
    }

    if (!flow.accessVerified) {
      overlayState.setupWizardStep = 2;
      overlayState.statusMessage = "GitHub OAuth conectado. Falta la GitHub App para crear el PR: pulsa Autorizar GitHub App.";
      return;
    }

    if (!flow.userHasCodespaceScope) {
      overlayState.setupWizardStep = 3;
      overlayState.statusMessage = "GitHub OAuth conectado, pero falta el permiso Codespaces.";
      return;
    }

    overlayState.setupWizardStep = 3;
    await bootstrapDevcontainerWithGithubApp({ pendingWindow: getPendingGithubOAuthWindow() });
  } catch (error) {
    overlayState.statusMessage = typeof isTunnelProvider === "function" && isTunnelProvider()
      ? `GitHub conectado, pero no se pudo preparar tu editor: ${String(error)}`
      : `GitHub OAuth conectado, pero no se pudo abrir Codespaces: ${String(error)}`;
  } finally {
    overlayState.githubAppBusy = false;
    githubOAuthContinueInFlight = false;
    renderOverlay();
  }
}

function startGithubOAuthPolling() {
  stopGithubOAuthPolling();
  githubOAuthPollStartedAt = Date.now();
  githubOAuthPollTimer = window.setInterval(async () => {
    if (githubOAuthPollBusy || githubOAuthContinueInFlight) return;
    if (!overlayState.sessionId) {
      stopGithubOAuthPolling();
      return;
    }
    if (Date.now() - githubOAuthPollStartedAt > GITHUB_OAUTH_POLL_TIMEOUT_MS) {
      stopGithubOAuthPolling();
      giveUpGithubOAuthWait();
      return;
    }

    githubOAuthPollBusy = true;
    try {
      if (await stopWaitingAfterGithubOAuthRedirectError()) return;
      await refreshGithubUserStatus();
      // userHasCodespaceScope ya contempla el tunel (basta la cuenta conectada).
      const flow = getSetupFlowState(overlayState.context || buildPayload());
      // Cambiando de cuenta (0.8.1): la de antes ya estaba conectada; se espera el token nuevo.
      const target = pendingGithubOAuthTarget;
      const waitingNewAccount = target?.switchAccount === true
        && toText(overlayState.githubUserStatus?.updatedAt) === toText(target.previousUpdatedAt);
      if (flow.userHasCodespaceScope && !waitingNewAccount) {
        await continueAfterGithubOAuth("poll");
      }
    } catch {
      // El postMessage del callback es el camino principal; este polling es respaldo.
    } finally {
      githubOAuthPollBusy = false;
    }
  }, GITHUB_OAUTH_POLL_INTERVAL_MS);
}

function bindGithubOAuthCallbackListener() {
  if (githubOAuthCallbackListenerBound) return;
  window.addEventListener("message", (event) => {
    const data = event?.data || {};
    if (data?.type !== "ADACEEN_GITHUB_OAUTH_CONNECTED") return;
    if (!isTrustedAdaceenBackendOrigin(event.origin)) return;
    continueAfterGithubOAuth("callback", data).catch(() => {});
  });
  githubOAuthCallbackListenerBound = true;
}

async function refreshGithubIntegrationStatus() {
  // Proveedor del entorno (codespaces | tunnel) primero: cacheado 5 min y nunca falla (sin la
  // ruta, Codespaces). Con el tunel confirmado la GitHub App no interviene y su estado no se
  // pide (antes se consultaba dos veces en cada entrada sin usarlo).
  const provider = typeof refreshWorkspaceProvider === "function"
    ? await refreshWorkspaceProvider().catch(() => "")
    : "";
  const tunnelConfirmed = provider === "tunnel"
    && !(typeof isWorkspaceProviderProvisional === "function" && isWorkspaceProviderProvisional());
  if (tunnelConfirmed) {
    overlayState.githubAppStatus = { ...EMPTY_GITHUB_APP_STATUS };
  }
  const results = await Promise.allSettled([
    tunnelConfirmed ? Promise.resolve() : refreshGithubAppStatus(),
    refreshGithubUserStatus(),
  ]);
  const failed = results.find((result) => result.status === "rejected");
  if (failed && failed.status === "rejected") {
    throw failed.reason;
  }
}

// options.pendingWindow: ventana ya abierta en el mismo clic (por ejemplo, la de espera de
// "Abrir mi editor"); se reutiliza para no abrir otra que el navegador bloquearia.
// options.selectAccount (0.8.1): cambiar la cuenta de GitHub ya conectada. GitHub muestra su
// selector de cuentas y la espera no sigue hasta que el backend guarda el token nuevo (con la
// cuenta de antes ya conectada, la consulta diria «conectado» al instante).
async function startGithubUserOAuthFlow(options = {}) {
  const repoFullName = parseRepoFullName(options?.repoFullName) || getCurrentRepoFullName();
  const selectAccount = options?.selectAccount === true;
  pendingGithubOAuthTarget = repoFullName
    ? {
      repoFullName,
      buttonLabel: toText(options?.buttonLabel),
      startedAt: Date.now(),
      ...(selectAccount ? { switchAccount: true, previousUpdatedAt: toText(overlayState.githubUserStatus?.updatedAt) } : {}),
    }
    : null;
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const providedWindow = options?.pendingWindow && !options.pendingWindow.closed ? options.pendingWindow : null;
  if (!baseUrl || !overlayState.sessionId) {
    if (providedWindow) providedWindow.close();
    overlayState.statusMessage = "Debes iniciar sesion en ADACEEN para conectar GitHub.";
    renderOverlay();
    return;
  }

  overlayState.githubAppBusy = true;
  setOperationProgress("Conectando GitHub", "Generando enlace OAuth...");
  const pendingOAuthWindow = providedWindow || window.open("about:blank", "_blank");
  pendingGithubOAuthWindow = pendingOAuthWindow;

  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/github/oauth/start`, {
      method: "POST",
      headers: buildApiHeaders(),
      body: JSON.stringify({ repoFullName, ...(selectAccount ? { selectAccount: true } : {}) }),
    });

    const authorizeUrl = toSafeHttpUrl(response?.authorizeUrl);
    if (!authorizeUrl) {
      throw new Error("No se recibio una URL OAuth de GitHub valida.");
    }

    if (pendingOAuthWindow) {
      pendingOAuthWindow.location.href = authorizeUrl;
    } else {
      pendingGithubOAuthWindow = window.open(authorizeUrl, "_blank");
    }
    startGithubOAuthPolling();
    // Sin saber aun el entorno (pagina sin GitHub) no se promete un Codespace.
    const tunnelWait = typeof isTunnelProvider === "function" && isTunnelProvider();
    setOperationProgress(
      GITHUB_OAUTH_WAIT_TITLE,
      tunnelWait
        ? "Al autorizar, ADACEEN preparara y abrira tu editor en esa misma ventana."
        : overlayState.workspaceProvider === "codespaces"
          ? "Al autorizar, ADACEEN abrira el Codespace automaticamente."
          : "Al autorizar, ADACEEN seguira solo en esa misma ventana.",
    );
  } catch (error) {
    if (pendingOAuthWindow) pendingOAuthWindow.close();
    pendingGithubOAuthWindow = null;
    overlayState.statusMessage = `No se pudo iniciar OAuth GitHub: ${String(error)}`;
  } finally {
    overlayState.githubAppBusy = false;
    renderOverlay();
  }
}

bindGithubOAuthCallbackListener();
