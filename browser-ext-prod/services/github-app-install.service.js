"use strict";

// ADACEEN | Capa 3 - Servicios: GitHub App del estudiante: estado, instalar, vincular y vigilar la instalacion.
// Movido sin cambios de github-auth.service.js (OAuth de usuario).

// Contrato (d): tras abrir la instalacion de la GitHub App, su estado se consulta cada pocos
// segundos (con limite) y el tour avanza solo, sin "Verificar acceso".
const GITHUB_APP_INSTALL_POLL_INTERVAL_MS = 4000;

const GITHUB_APP_INSTALL_POLL_TIMEOUT_MS = 300000;

// Cada tantas consultas sin acceso se intenta vincular una instalacion hecha sin el enlace de
// ADACEEN (la App ya estaba en la cuenta u organizacion), como hacia "Verificar acceso".
const GITHUB_APP_INSTALL_AUTOLINK_EVERY = 3;

const GITHUB_APP_INSTALL_WAIT_TITLE = "Esperando la GitHub App";

let githubAppInstallWatch = null;

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
