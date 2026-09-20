// ADACEEN | Capa 3 - Servicios: OAuth de la cuenta GitHub del estudiante y continuacion automatica tras autorizar.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const GITHUB_OAUTH_POLL_INTERVAL_MS = 2500;
const GITHUB_OAUTH_POLL_TIMEOUT_MS = 180000;
let pendingGithubOAuthWindow = null;
let githubOAuthPollTimer = 0;
let githubOAuthPollStartedAt = 0;
let githubOAuthPollBusy = false;
let githubOAuthContinueInFlight = false;
let githubOAuthCallbackListenerBound = false;

async function refreshGithubUserStatus() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    overlayState.githubUserStatus = { ...EMPTY_GITHUB_USER_STATUS };
    return;
  }

  const response = await fetchJsonWithTimeout(`${baseUrl}/api/github/oauth/status`, {
    method: "GET",
    headers: buildApiHeaders(),
  });

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
    setOperationProgress(
      "GitHub conectado",
      source === "callback"
        ? "Preparando Codespace de la PR asociada..."
        : "OAuth detectado. Preparando Codespace de la PR asociada...",
    );

    await refreshGithubIntegrationStatus();
    let flow = getSetupFlowState(getPageContext());
    if (!flow.repoReady) {
      overlayState.statusMessage = "GitHub OAuth conectado. Vuelve al repositorio para abrir el Codespace de la PR.";
      return;
    }

    if (!flow.appConnected && flow.configured && flow.repoReady) {
      const linked = await autoLinkGithubInstallation(flow.repoFullName);
      if (linked) {
        await refreshGithubIntegrationStatus();
        flow = getSetupFlowState(getPageContext());
      }
    }

    if (!flow.accessVerified) {
      overlayState.setupWizardStep = 2;
      overlayState.statusMessage = "GitHub OAuth conectado. Falta verificar la GitHub App para crear el PR.";
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
    overlayState.statusMessage = `GitHub OAuth conectado, pero no se pudo abrir Codespaces: ${String(error)}`;
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
      const status = overlayState.githubUserStatus || EMPTY_GITHUB_USER_STATUS;
      if (status.connected && status.hasCodespaceScope === true) {
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

async function startGithubUserOAuthFlow() {
  const repoFullName = getCurrentRepoFullName();
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    overlayState.statusMessage = "Debes iniciar sesion en ADACEEN para conectar GitHub.";
    renderOverlay();
    return;
  }

  overlayState.githubAppBusy = true;
  setOperationProgress("Conectando GitHub", "Generando enlace OAuth...");
  const pendingOAuthWindow = window.open("about:blank", "_blank");
  pendingGithubOAuthWindow = pendingOAuthWindow;

  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/github/oauth/start`, {
      method: "POST",
      headers: buildApiHeaders(),
      body: JSON.stringify({ repoFullName }),
    });

    const authorizeUrl = toText(response?.authorizeUrl);
    if (!authorizeUrl) {
      throw new Error("No se recibio URL OAuth de GitHub.");
    }

    if (pendingOAuthWindow) {
      pendingOAuthWindow.location.href = authorizeUrl;
    } else {
      pendingGithubOAuthWindow = window.open(authorizeUrl, "_blank");
    }
    startGithubOAuthPolling();
    setOperationProgress("Esperando autorizacion GitHub", "Al autorizar, ADACEEN abrira el Codespace automaticamente.");
  } catch (error) {
    if (pendingOAuthWindow) pendingOAuthWindow.close();
    pendingGithubOAuthWindow = null;
    overlayState.statusMessage = `No se pudo iniciar OAuth GitHub: ${String(error)}`;
  } finally {
    overlayState.githubAppBusy = false;
    renderOverlay();
  }
}
