// ADACEEN | Capa 3 - Servicios: cuenta de GitHub del estudiante: OAuth de usuario (ventana y sondeo),
// estado de la integracion y de la GitHub App (instalar, vincular y vigilar la instalacion).
// Movido sin cambios desde services/github.service.js, incluida la llamada de carga
// bindGithubOAuthCallbackListener() al final (se ejecuta justo despues de github.service.js, como antes).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const GITHUB_OAUTH_POLL_INTERVAL_MS = 2500;

const GITHUB_OAUTH_POLL_TIMEOUT_MS = 180000;

// Contrato (d): tras abrir la instalacion de la GitHub App, su estado se consulta cada pocos
// segundos (con limite) y el tour avanza solo, sin "Verificar acceso".
const GITHUB_APP_INSTALL_POLL_INTERVAL_MS = 4000;

const GITHUB_APP_INSTALL_POLL_TIMEOUT_MS = 300000;

// Cada tantas consultas sin acceso se intenta vincular una instalacion hecha sin el enlace de
// ADACEEN (la App ya estaba en la cuenta u organizacion), como hacia "Verificar acceso".
const GITHUB_APP_INSTALL_AUTOLINK_EVERY = 3;

const GITHUB_APP_INSTALL_WAIT_TITLE = "Esperando la GitHub App";

let pendingGithubOAuthWindow = null;

let githubOAuthPollTimer = 0;

let githubOAuthPollStartedAt = 0;

let githubOAuthPollBusy = false;

let githubOAuthContinueInFlight = false;

let githubOAuthCallbackListenerBound = false;

let githubAppInstallWatch = null;

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

function getBackendOriginForMessages() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl) || DEFAULT_BACKEND_URL;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return "";
  }
}

function isTrustedAdaceenBackendOrigin(origin) {
  const expectedOrigin = getBackendOriginForMessages();
  if (origin === expectedOrigin) return true;

  const localOrigins = new Set(["http://127.0.0.1:3000", "http://localhost:3000"]);
  return localOrigins.has(expectedOrigin) && localOrigins.has(toText(origin));
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

async function continueAfterGithubOAuth(source = "oauth") {
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
    if (!flow.repoReady) {
      // El boton del repositorio dice "Abrir mi editor" solo si ya hay un editor guardado.
      overlayState.statusMessage = typeof isTunnelProvider === "function" && isTunnelProvider()
        ? `GitHub conectado. Vuelve a tu repositorio en GitHub y pulsa ${getLatestSavedTunnelEditor() ? "Abrir mi editor" : "Preparar mi editor"}.`
        : "GitHub OAuth conectado. Vuelve al repositorio para abrir el Codespace de la PR.";
      return;
    }

    // Tunel (acceso simplificado, seccion 4): sin GitHub App. Con la cuenta conectada se
    // prepara el editor en la misma ventana del OAuth, sin otro clic.
    if (typeof isTunnelProvider === "function" && isTunnelProvider()) {
      if (!flow.userConnected) {
        overlayState.statusMessage = "GitHub aun no confirma tu cuenta. Pulsa Conectar GitHub de nuevo.";
        return;
      }
      await bootstrapDevcontainerWithGithubApp({ pendingWindow: getPendingGithubOAuthWindow() });
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
    if (!overlayState.sessionId || Date.now() - githubOAuthPollStartedAt > GITHUB_OAUTH_POLL_TIMEOUT_MS) {
      stopGithubOAuthPolling();
      return;
    }

    githubOAuthPollBusy = true;
    try {
      await refreshGithubUserStatus();
      // userHasCodespaceScope ya contempla el tunel (basta la cuenta conectada).
      const flow = getSetupFlowState(overlayState.context || buildPayload());
      if (flow.userHasCodespaceScope) {
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
    continueAfterGithubOAuth("callback").catch(() => {});
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
async function startGithubUserOAuthFlow(options = {}) {
  const repoFullName = getCurrentRepoFullName();
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
      body: JSON.stringify({ repoFullName }),
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
    setOperationProgress(
      "Esperando autorizacion GitHub",
      typeof isTunnelProvider === "function" && isTunnelProvider()
        ? "Al autorizar, ADACEEN preparara y abrira tu editor en esa misma ventana."
        : "Al autorizar, ADACEEN abrira el Codespace automaticamente.",
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

async function refreshGithubAppStatus() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const repoFullName = getCurrentRepoFullName();
  if (!baseUrl || !overlayState.sessionId) {
    overlayState.githubAppStatus = { ...EMPTY_GITHUB_APP_STATUS };
    return;
  }

  const query = repoFullName ? `?repoFullName=${encodeURIComponent(repoFullName)}` : "";
  const response = await fetchJsonWithTimeout(`${baseUrl}/api/github-app/status${query}`, {
    method: "GET",
    headers: buildApiHeaders(),
  });

  overlayState.githubAppStatus = response?.status
    ? { ...EMPTY_GITHUB_APP_STATUS, ...response.status }
    : { ...EMPTY_GITHUB_APP_STATUS };

  // Con el tunel el estado de la GitHub App no dice nada del editor: ni marca el setup ni
  // lo borra, y el editor guardado no se reemplaza por un enlace de Codespaces. El
  // proveedor se consulta antes (cacheado 5 min) para no decidir con el valor viejo.
  if (typeof refreshWorkspaceProvider === "function") {
    await refreshWorkspaceProvider().catch(() => "");
  }
  if (typeof isTunnelProvider === "function" && isTunnelProvider()) {
    return;
  }

  if (overlayState.githubAppStatus.bootstrapReady === true) {
    rememberSetupPrResult({
      repoFullName: toText(overlayState.githubAppStatus.repoFullName) || getCurrentRepoFullName(),
      pullUrl: toText(overlayState.githubAppStatus.bootstrapPullUrl),
      pullNumber: Number(overlayState.githubAppStatus.bootstrapPullNumber) || 0,
      branchName: toText(overlayState.githubAppStatus.bootstrapBranchName),
      codespaceUrl: toText(overlayState.githubAppStatus.bootstrapCodespaceUrl),
    });
    await markSetupCompleted();
    return;
  }

  // Con el proveedor provisional (no se pudo consultar) no se borra nada: podria ser el tunel.
  if (typeof isWorkspaceProviderProvisional === "function" && isWorkspaceProviderProvisional()) {
    return;
  }
  const statusRepo = parseRepoFullName(overlayState.githubAppStatus.repoFullName);
  if (repoFullName
    && statusRepo
    && repoFullName.toLowerCase() === statusRepo.toLowerCase()
    && overlayState.githubAppStatus.hasRepoAccess === true) {
    clearSetupForCurrentUser();
    clearSetupPrResultForCurrentUser();
    await persistPreferences();
  }
}

async function autoLinkGithubInstallation(repoFullName) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) return false;

  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/github-app/link-installation-auto`, {
      method: "POST",
      headers: buildApiHeaders(),
      body: JSON.stringify({ repoFullName }),
    }, BACKEND_TIMEOUT_MS);

    return !!response?.ok;
  } catch {
    return false;
  }
}

// Codespaces: la GitHub App puede estar instalada en la organizacion sin estar vinculada a
// este estudiante. Al llegar al paso de la App se intenta vincularla una vez por usuario y
// repositorio (link-installation-auto, lo que antes hacia "Verificar acceso"): si funciona, el
// tour pasa solo al siguiente boton sin abrir la pestana de instalacion. Con el tunel (o con
// el proveedor sin confirmar) no se hace nada.
const githubAppAutoLinkOnEntryTried = new Set();

async function autoLinkGithubInstallationOnEntry() {
  if (typeof isTunnelProvider === "function" && isTunnelProvider()) return false;
  if (typeof isWorkspaceProviderProvisional === "function" && isWorkspaceProviderProvisional()) return false;
  if (!hasActiveSession() || isAdminSession() || isTeacherSession()) return false;
  if (isWatchingGithubAppInstall() || overlayState.githubAppBusy) return false;
  // Solo en el tour (paso de la GitHub App): con el setup hecho no hace falta.
  if (hasCompletedSetup()) return false;
  const flow = getSetupFlowState(overlayState.context || buildPayload());
  if (!flow.repoReady || !flow.configured || flow.accessVerified) return false;
  const userId = getCurrentUserId();
  const key = `${userId}:${flow.repoFullName.toLowerCase()}`;
  if (!userId || githubAppAutoLinkOnEntryTried.has(key)) return false;
  githubAppAutoLinkOnEntryTried.add(key);
  if (!(await autoLinkGithubInstallation(flow.repoFullName))) return false;
  // Mientras tanto pudo cambiar la cuenta o el repositorio, o empezar la instalacion.
  const currentRepo = parseRepoFullName(getCurrentRepoFullName());
  if (getCurrentUserId() !== userId || currentRepo.toLowerCase() !== flow.repoFullName.toLowerCase()) return false;
  await refreshGithubAppStatus().catch(() => {});
  if (!getSetupFlowState(overlayState.context || buildPayload()).accessVerified) return false;
  stopGithubAppInstallWatch();
  await finishGithubAppInstallWatch();
  return true;
}

async function startGithubAppInstallFlow() {
  const repoFullName = getCurrentRepoFullName();
  if (!repoFullName) {
    overlayState.statusMessage = "Abre un repositorio para iniciar instalacion de GitHub App.";
    renderOverlay();
    return;
  }

  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    overlayState.statusMessage = "Debes iniciar sesion para conectar GitHub App.";
    renderOverlay();
    return;
  }

  overlayState.githubAppBusy = true;
  clearSetupForCurrentUser();
  await persistPreferences();
  setOperationProgress("Conectando GitHub App", "Generando enlace de instalacion...");
  const pendingInstallWindow = window.open("about:blank", "_blank");

  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/github-app/install-url`, {
      method: "POST",
      headers: buildApiHeaders(),
      body: JSON.stringify({ repoFullName }),
    });

    const installUrl = toSafeHttpUrl(response?.installUrl);
    if (!installUrl) {
      throw new Error("No se recibio una URL de instalacion valida.");
    }

    if (pendingInstallWindow) {
      pendingInstallWindow.opener = null;
      pendingInstallWindow.location.href = installUrl;
    } else {
      window.open(installUrl, "_blank", "noopener,noreferrer");
    }
    // La pagina de retorno de la App dice que se puede cerrar la pestana: ADACEEN detecta la
    // instalacion solo y el tour avanza aqui.
    startGithubAppInstallWatch(repoFullName);
    setOperationProgress(
      GITHUB_APP_INSTALL_WAIT_TITLE,
      `Termina la instalacion en la pestana de GitHub y elige ${repoFullName}: ADACEEN la detecta sola y sigue aqui.`,
    );
  } catch (error) {
    if (pendingInstallWindow) {
      pendingInstallWindow.close();
    }
    overlayState.statusMessage = `No se pudo iniciar instalacion GitHub App: ${String(error)}`;
  } finally {
    overlayState.githubAppBusy = false;
    renderOverlay();
  }
}

function isWatchingGithubAppInstall() {
  return !!githubAppInstallWatch;
}

function stopGithubAppInstallWatch() {
  if (!githubAppInstallWatch) return;
  window.clearTimeout(githubAppInstallWatch.timer);
  githubAppInstallWatch = null;
}

function startGithubAppInstallWatch(repoFullName) {
  stopGithubAppInstallWatch();
  const watch = {
    repoFullName: parseRepoFullName(repoFullName),
    userId: getCurrentUserId(),
    startedAt: Date.now(),
    polls: 0,
    timer: 0,
  };
  githubAppInstallWatch = watch;
  scheduleGithubAppInstallPoll(watch);
  return watch;
}

// Una consulta a la vez: la siguiente se programa cuando termina la anterior.
function scheduleGithubAppInstallPoll(watch) {
  watch.timer = window.setTimeout(() => {
    pollGithubAppInstall(watch)
      .catch(() => {})
      .finally(() => {
        if (githubAppInstallWatch === watch) scheduleGithubAppInstallPoll(watch);
      });
  }, GITHUB_APP_INSTALL_POLL_INTERVAL_MS);
}

async function pollGithubAppInstall(watch) {
  if (githubAppInstallWatch !== watch) return;
  // Overlay cerrado, sesion cerrada, otro usuario u otro repositorio: se deja de consultar.
  const currentRepo = parseRepoFullName(getCurrentRepoFullName());
  if (!overlayEls
    || !overlayState.sessionId
    || getCurrentUserId() !== watch.userId
    || !currentRepo
    || currentRepo.toLowerCase() !== watch.repoFullName.toLowerCase()) {
    stopGithubAppInstallWatch();
    if (overlayEls && overlayState.operationTitle === GITHUB_APP_INSTALL_WAIT_TITLE) {
      clearOperationProgress();
      renderOverlay();
    }
    return;
  }
  if (Date.now() - watch.startedAt > GITHUB_APP_INSTALL_POLL_TIMEOUT_MS) {
    stopGithubAppInstallWatch();
    clearOperationProgress(`ADACEEN dejo de esperar la GitHub App. Si ya la instalaste, pulsa Autorizar GitHub App de nuevo y elige ${watch.repoFullName}.`);
    renderOverlay();
    return;
  }

  watch.polls += 1;
  await refreshGithubAppStatus();
  let flow = getSetupFlowState(overlayState.context || buildPayload());
  if (!flow.accessVerified && flow.configured && watch.polls % GITHUB_APP_INSTALL_AUTOLINK_EVERY === 0) {
    if (await autoLinkGithubInstallation(watch.repoFullName)) {
      await refreshGithubAppStatus();
      flow = getSetupFlowState(overlayState.context || buildPayload());
    }
  }
  if (githubAppInstallWatch !== watch) return;
  if (!flow.accessVerified) {
    renderOverlay();
    return;
  }
  stopGithubAppInstallWatch();
  await finishGithubAppInstallWatch();
}

// La App ya tiene acceso al repositorio: el tour pasa solo al siguiente boton. Sin abrir
// ventanas (no hay clic del estudiante que lo permita): la cuenta de GitHub y el Codespace
// siguen con su propio boton.
async function finishGithubAppInstallWatch() {
  await refreshGithubUserStatusIfStale().catch(() => {});
  const flow = getSetupFlowState(overlayState.context || buildPayload());
  let message = "";
  if (hasCompletedSetup() || flow.prCreated) {
    await markSetupCompleted();
    message = `GitHub App lista: ${flow.repoFullName} ya tenia la configuracion ADACEEN.`;
  } else if (!flow.userOAuthConfigured) {
    message = `GitHub App lista: ya tiene acceso a ${flow.repoFullName}. Falta configurar GitHub OAuth en el backend; avisa al docente.`;
  } else if (!flow.userConnected) {
    message = `GitHub App lista: ya tiene acceso a ${flow.repoFullName}. Ahora pulsa Conectar GitHub para crear tu Codespace.`;
  } else if (!flow.userHasCodespaceScope) {
    message = `GitHub App lista: ya tiene acceso a ${flow.repoFullName}. Falta el permiso Codespaces: pulsa Autorizar Codespaces.`;
  } else {
    message = `GitHub App lista: ya tiene acceso a ${flow.repoFullName}. Pulsa Preparar entorno ADACEEN para crear el PR y tu Codespace.`;
  }
  clearOperationProgress(message);
  renderOverlay();
}

bindGithubOAuthCallbackListener();
