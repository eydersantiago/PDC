"use strict";

const GITHUB_OAUTH_POLL_INTERVAL_MS = 2500;
const GITHUB_OAUTH_POLL_TIMEOUT_MS = 180000;
const CODESPACE_READY_POLL_INTERVAL_MS = 2000;
const CODESPACE_READY_POLL_TIMEOUT_MS = 420000;
const CODESPACE_PREPARE_REQUEST_TIMEOUT_MS = 120000;
const CODESPACE_READY_POLL_MAX_ATTEMPTS = 120;
const CODESPACE_DIRECT_OPEN_AFTER_ATTEMPTS = 2;
const CODESPACE_NAVIGATION_LOCK_MS = 300000;
let pendingGithubOAuthWindow = null;
let githubOAuthPollTimer = 0;
let githubOAuthPollStartedAt = 0;
let githubOAuthPollBusy = false;
let githubOAuthContinueInFlight = false;
let githubOAuthCallbackListenerBound = false;
let activeCodespaceDiscoveryTracker = null;
let codespaceNavigationLockUntil = 0;
let codespaceNavigationLastUrl = "";

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

function setOperationProgress(title, detail = "", kind = "busy", syncStatus = false) {
  overlayState.operationTitle = toText(title);
  overlayState.operationDetail = toText(detail);
  overlayState.operationKind = toText(kind) || "busy";
  if (syncStatus && title) {
    overlayState.statusMessage = overlayState.operationDetail || overlayState.operationTitle;
  }
  renderOverlay();
}

function setOperationError(title, detail = "") {
  setOperationProgress(title || "No se pudo continuar", detail, "error", true);
}

function clearOperationProgress(finalMessage = "") {
  overlayState.operationTitle = "";
  overlayState.operationDetail = "";
  overlayState.operationKind = "busy";
  if (finalMessage) {
    overlayState.statusMessage = finalMessage;
  }
}

function escapeWaitingPageText(value) {
  return toText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function isCodespaceReadyState(state) {
  const normalized = toText(state).toLowerCase();
  return normalized === "available" || normalized === "ready";
}

function isDirectCodespaceUrl(value) {
  return /^https:\/\/[^/]+\.github\.dev(?:\/|$)/i.test(toText(value));
}

function openCodespaceWaitingWindow(repoFullName) {
  const pendingWindow = window.open("about:blank", "_blank");
  if (!pendingWindow) return null;

  try {
    const repo = escapeWaitingPageText(repoFullName || "repositorio");
    pendingWindow.document.open();
    pendingWindow.document.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>ADACEEN preparando Codespace</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: Segoe UI, Arial, sans-serif;
      background: #f6fbfb;
      color: #173046;
    }
    main {
      width: min(520px, calc(100vw - 40px));
      border: 1px solid #cfe3df;
      border-radius: 12px;
      background: #fffefb;
      padding: 24px;
      box-shadow: 0 18px 40px rgba(28, 58, 70, 0.12);
    }
    .row { display: flex; align-items: center; gap: 14px; }
    .spinner {
      width: 28px;
      height: 28px;
      border: 4px solid #d5ebe7;
      border-top-color: #0b7a75;
      border-radius: 999px;
      animation: spin 0.8s linear infinite;
      flex: 0 0 auto;
    }
    h1 { margin: 0 0 6px; font-size: 20px; line-height: 1.2; }
    p { margin: 0; color: #526574; line-height: 1.45; }
    .repo { margin-top: 14px; padding: 10px; border-radius: 8px; background: #eefbf8; color: #0b625d; font-weight: 700; overflow-wrap: anywhere; }
    .manual-link {
      display: none;
      width: fit-content;
      max-width: 100%;
      margin-top: 16px;
      padding: 10px 14px;
      border-radius: 8px;
      background: #0b7a75;
      color: #ffffff;
      font-weight: 700;
      text-decoration: none;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <main>
    <div class="row">
      <span class="spinner" aria-hidden="true"></span>
      <div>
        <h1 id="adaceenWaitTitle">ADACEEN esta preparando tu Codespace</h1>
        <p id="adaceenWaitDetail">Estamos creando o reutilizando la PR, iniciando Codespaces y esperando la URL lista.</p>
      </div>
    </div>
    <div class="repo">${repo}</div>
    <a class="manual-link" id="adaceenOpenCodespaceLink" href="#" rel="noopener noreferrer">Abrir Codespace ahora</a>
    <a class="manual-link" id="adaceenOpenQuickstartLink" href="#" rel="noopener noreferrer">Abrir selector de Codespaces</a>
  </main>
</body>
</html>`);
    pendingWindow.document.close();
  } catch {
    // Si el navegador impide escribir en la ventana, igual conservamos el handle para redirigirla.
  }

  return pendingWindow;
}

function updateCodespaceWaitingWindow(pendingWindow, title, detail, directUrl = "", quickstartUrl = "") {
  if (!pendingWindow || pendingWindow.closed) return;

  try {
    const titleEl = pendingWindow.document.getElementById("adaceenWaitTitle");
    const detailEl = pendingWindow.document.getElementById("adaceenWaitDetail");
    const directLink = pendingWindow.document.getElementById("adaceenOpenCodespaceLink");
    const quickstartLink = pendingWindow.document.getElementById("adaceenOpenQuickstartLink");
    if (titleEl) titleEl.textContent = toText(title) || "ADACEEN esta preparando tu Codespace";
    if (detailEl) detailEl.textContent = toText(detail) || "GitHub sigue preparando el contenedor.";
    if (directLink) {
      const href = toText(directUrl);
      directLink.style.display = href ? "inline-block" : "none";
      if (href) directLink.href = href;
    }
    if (quickstartLink) {
      const href = toText(quickstartUrl);
      quickstartLink.style.display = href ? "inline-block" : "none";
      if (href) quickstartLink.href = href;
    }
  } catch {
    // La ventana puede haber navegado fuera de nuestro origen; en ese caso no se puede actualizar.
  }
}

function buildCodespaceStatusQuery(input = {}) {
  const params = new URLSearchParams();
  const name = toText(input.name);
  const repoFullName = parseRepoFullName(toText(input.repoFullName));
  const pullNumber = Number(input.pullNumber) || 0;
  const branchName = toText(input.branchName);

  if (name) params.set("name", name);
  if (repoFullName) params.set("repoFullName", repoFullName);
  if (pullNumber > 0) params.set("pullNumber", String(pullNumber));
  if (branchName) params.set("branchName", branchName);
  return params.toString() ? `?${params.toString()}` : "";
}

function isCodespaceLimitError(message) {
  return /limite de codespaces|too many|quota|maximum|exceeded|spending/i.test(String(message));
}

function hasRecentCodespaceNavigation() {
  return Date.now() < codespaceNavigationLockUntil && /^https:\/\/[^/]+\.github\.dev/i.test(codespaceNavigationLastUrl);
}

function beginCodespaceDiscoveryPolling(input = {}) {
  const tracker = input.tracker || { opened: false, stopped: false };
  if (activeCodespaceDiscoveryTracker && activeCodespaceDiscoveryTracker !== tracker) {
    activeCodespaceDiscoveryTracker.stopped = true;
  }
  activeCodespaceDiscoveryTracker = tracker;
  const repoFullName = parseRepoFullName(input.repoFullName);
  const pendingWindow = input.pendingWindow || null;
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!repoFullName || !baseUrl || !overlayState.sessionId) {
    tracker.stopped = true;
    return tracker;
  }

  const branchName = toText(input.branchName);
  const pullNumber = Number(input.pullNumber) || 0;
  const startedAt = Date.now();

  (async () => {
    let attempt = 0;
    while (!tracker.stopped
      && !tracker.opened
      && Date.now() - startedAt <= CODESPACE_READY_POLL_TIMEOUT_MS
      && attempt < CODESPACE_READY_POLL_MAX_ATTEMPTS) {
      if (hasRecentCodespaceNavigation()) {
        tracker.opened = true;
        tracker.stopped = true;
        return;
      }
      attempt += 1;
      try {
        setOperationProgress(
          "Buscando Codespace creado",
          `Comprobando GitHub cada 2 segundos para ${repoFullName}. Intento ${attempt}.`,
        );
        updateCodespaceWaitingWindow(
          pendingWindow,
          "ADACEEN esta buscando tu Codespace",
          "Si GitHub ya lo creo, esta ventana se abrira automaticamente.",
        );

        const query = buildCodespaceStatusQuery({ repoFullName, pullNumber, branchName });
        const response = await fetchJsonWithTimeout(`${baseUrl}/api/github/codespaces/status${query}`, {
          method: "GET",
          headers: buildApiHeaders(),
        }, 10000);
        const codespace = response?.codespace || null;
        const name = toText(codespace?.name);
        const state = toText(codespace?.state) || "creado";
        const webUrl = toText(codespace?.webUrl) || buildCodespaceWebUrlFromName(name);

        if (name && webUrl) {
          tracker.codespace = codespace;
          tracker.opened = navigatePendingCodespaceWindow(pendingWindow, webUrl);
          tracker.stopped = true;
          rememberSetupPrResult({
            repoFullName,
            pullNumber,
            branchName,
            codespaceUrl: webUrl,
          }, { codespace });
          clearOperationProgress(tracker.opened
            ? `Codespace encontrado (${state}). Abriendolo ahora.`
            : `Codespace encontrado (${state}), pero el navegador bloqueo la apertura. Usa Abrir Codespace de la PR.`);
          renderOverlay();
          return;
        }
      } catch (error) {
        const message = String(error);
        if (isCodespaceLimitError(message)) {
          tracker.error = message;
          tracker.stopped = true;
          if (pendingWindow && !pendingWindow.closed) pendingWindow.close();
          setOperationError(
            "Limite de Codespaces alcanzado",
            "GitHub no permitio crear o iniciar otro Codespace. Cierra, detiene o elimina Codespaces que no uses en https://github.com/codespaces y vuelve a intentar.",
          );
          renderOverlay();
          return;
        }
      }

      await new Promise((resolve) => window.setTimeout(resolve, CODESPACE_READY_POLL_INTERVAL_MS));
    }

    if (!tracker.opened && !tracker.stopped) {
      tracker.stopped = true;
      setOperationError(
        "Codespace no confirmado",
        "ADACEEN dejo de consultar automaticamente para evitar un ciclo largo. Usa Abrir Codespace de la PR o reintenta.",
      );
      updateCodespaceWaitingWindow(
        pendingWindow,
        "Codespace no confirmado",
        "ADACEEN detuvo la comprobacion automatica. Vuelve al panel para abrirlo manualmente o reintentar.",
      );
      renderOverlay();
    }
  })().catch(() => {});

  return tracker;
}

async function waitForCodespaceReadyFromBackend(codespaceName, pendingWindow, pullNumber = 0, fallbackWebUrl = "") {
  const name = toText(codespaceName);
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  const knownWebUrl = toText(fallbackWebUrl) || buildCodespaceWebUrlFromName(name);
  if (!name || !baseUrl || !overlayState.sessionId) {
    return knownWebUrl ? navigatePendingCodespaceWindow(pendingWindow, knownWebUrl) : false;
  }

  const startedAt = Date.now();
  let attempt = 0;
  while (Date.now() - startedAt <= CODESPACE_READY_POLL_TIMEOUT_MS
    && attempt < CODESPACE_READY_POLL_MAX_ATTEMPTS) {
    if (hasRecentCodespaceNavigation()) {
      return true;
    }
    attempt += 1;
    setOperationProgress(
      "Esperando Codespace listo",
      `GitHub esta preparando el contenedor${pullNumber ? ` de la PR #${pullNumber}` : ""}. Intento ${attempt}.`,
    );
    updateCodespaceWaitingWindow(
      pendingWindow,
      "ADACEEN esta esperando a GitHub",
      "El Codespace ya fue solicitado. ADACEEN lo abrira cuando GitHub confirme el estado o tengamos una URL directa.",
      knownWebUrl,
    );

    try {
      const query = buildCodespaceStatusQuery({ name });
      const response = await fetchJsonWithTimeout(`${baseUrl}/api/github/codespaces/status${query}`, {
        method: "GET",
        headers: buildApiHeaders(),
      }, 10000);
      const codespace = response?.codespace || {};
      const state = toText(codespace.state) || "preparando";
      const webUrl = toText(codespace.webUrl) || knownWebUrl;
      const canOpenDirectly = !!webUrl
        && !/failed|deleted|unavailable|error/i.test(state)
        && (codespace.ready === true
          || isCodespaceReadyState(state)
          || attempt >= CODESPACE_DIRECT_OPEN_AFTER_ATTEMPTS);

      setOperationProgress(
        "Esperando Codespace listo",
        canOpenDirectly
          ? `Estado GitHub: ${state}. Abriendo el entorno ahora.`
          : `Estado GitHub: ${state}. Se abrira automaticamente cuando este disponible.`,
      );
      updateCodespaceWaitingWindow(
        pendingWindow,
        `Codespace en estado ${state}`,
        canOpenDirectly
          ? "ADACEEN ya tiene una URL directa y va a redirigir esta ventana."
          : "No cierres esta ventana; ADACEEN la redirigira al entorno cuando GitHub termine.",
        webUrl,
      );

      if (canOpenDirectly) {
        return navigatePendingCodespaceWindow(pendingWindow, webUrl);
      }
    } catch (error) {
      const message = String(error);
      if (isCodespaceLimitError(message)) {
        if (pendingWindow && !pendingWindow.closed) pendingWindow.close();
        setOperationError(
          "Limite de Codespaces alcanzado",
          "GitHub no permitio crear o iniciar otro Codespace. Cierra, detiene o elimina Codespaces que no uses en https://github.com/codespaces y vuelve a intentar.",
        );
        renderOverlay();
        return false;
      }
      if (knownWebUrl && attempt >= CODESPACE_DIRECT_OPEN_AFTER_ATTEMPTS) {
        setOperationProgress(
          "Abriendo Codespace",
          "GitHub ya creo el Codespace, pero no confirmo el estado a tiempo. Abriendo la URL directa.",
        );
        updateCodespaceWaitingWindow(
          pendingWindow,
          "Abriendo Codespace",
          "ADACEEN usara la URL directa del Codespace para evitar que esta ventana quede cargando.",
          knownWebUrl,
        );
        return navigatePendingCodespaceWindow(pendingWindow, knownWebUrl);
      }
    }

    await new Promise((resolve) => window.setTimeout(resolve, CODESPACE_READY_POLL_INTERVAL_MS));
  }

  updateCodespaceWaitingWindow(
    pendingWindow,
    "GitHub sigue preparando el Codespace",
    "Puedes dejar esta ventana abierta o volver a ADACEEN y usar Abrir Codespace cuando el estado cambie.",
  );
  return false;
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
    let flow = getSetupFlowState(overlayState.context || buildPayload());
    if (!flow.repoReady) {
      overlayState.statusMessage = "GitHub OAuth conectado. Vuelve al repositorio para abrir el Codespace de la PR.";
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

async function refreshGithubIntegrationStatus() {
  const results = await Promise.allSettled([
    refreshGithubAppStatus(),
    refreshGithubUserStatus(),
  ]);
  const failed = results.find((result) => result.status === "rejected");
  if (failed && failed.status === "rejected") {
    throw failed.reason;
  }
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
    }, 25000);

    return !!response?.ok;
  } catch {
    return false;
  }
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

    const installUrl = toText(response?.installUrl);
    if (!installUrl) {
      throw new Error("No se recibio URL de instalacion.");
    }

    if (pendingInstallWindow) {
      pendingInstallWindow.opener = null;
      pendingInstallWindow.location.href = installUrl;
    } else {
      window.open(installUrl, "_blank", "noopener,noreferrer");
    }
    setOperationProgress("Esperando instalacion GitHub App", "Al terminar, vuelve aqui y pulsa Actualizar estado.");
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

function encodeCodespacesBranch(branchName) {
  return toText(branchName)
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function buildCodespaceQuickstartUrl(repoFullName, pullNumber = 0, branchName = "") {
  const cleanRepo = parseRepoFullName(repoFullName);
  if (!cleanRepo) return "";

  const [owner, repo] = cleanRepo.split("/");
  const baseUrl = `https://codespaces.new/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const normalizedPullNumber = Number.isFinite(Number(pullNumber))
    ? Math.max(0, Number(pullNumber))
    : 0;

  if (normalizedPullNumber > 0) {
    return `${baseUrl}/pull/${normalizedPullNumber}?quickstart=1`;
  }

  const branchPath = encodeCodespacesBranch(branchName);
  if (branchPath) {
    return `${baseUrl}/tree/${branchPath}?quickstart=1`;
  }

  return `${baseUrl}?quickstart=1`;
}

function isCodespaceQuickstartUrl(value) {
  return /^https:\/\/codespaces\.new\//i.test(toText(value));
}

function buildCodespaceWebUrlFromName(name) {
  const cleanName = toText(name);
  return cleanName ? `https://${cleanName}.github.dev` : "";
}

function resolveDirectCodespaceUrlFromPayload(payload) {
  const candidates = [
    toText(payload?.codespace?.webUrl),
    buildCodespaceWebUrlFromName(payload?.codespace?.name),
    toText(payload?.bootstrap?.codespaceWebUrl),
    toText(payload?.bootstrapCodespaceUrl),
    toText(payload?.result?.codespaceWebUrl),
    toText(payload?.codespaceWebUrl),
  ].filter(Boolean);

  return candidates.find((url) => isDirectCodespaceUrl(url)) || "";
}

function resolveCodespaceUrlFromBootstrapPayload(payload, fallbackRepo = "") {
  const directUrl = resolveDirectCodespaceUrlFromPayload(payload);
  if (directUrl) return directUrl;

  const result = payload?.result || payload?.bootstrap || payload || {};
  const pullRequest = payload?.pullRequest || {};
  const fallbackUrl = toText(payload?.codespaceUrl)
    || toText(payload?.bootstrap?.codespaceUrl)
    || toText(payload?.result?.codespaceUrl)
    || toText(payload?.codespace?.fallbackUrl)
    || toText(payload?.fallback?.webUrl);
  if (fallbackUrl) return fallbackUrl;

  const repoFullName = toText(result.repoFullName) || toText(payload?.repository) || toText(payload?.repoFullName) || fallbackRepo || getCurrentRepoFullName();
  const pullNumber = Number(result.pullNumber || pullRequest.number || payload?.pullNumber || 0) || 0;
  const branchName = toText(result.branchName || pullRequest.branchName || result.bootstrapBranchName || payload?.branchName || "");
  return buildCodespaceQuickstartUrl(repoFullName, pullNumber, branchName);
}

function rememberSetupPrResult(result, extra = {}) {
  const userId = getCurrentUserId();
  if (!userId) return null;

  const repoFullName = toText(result?.repoFullName) || getCurrentRepoFullName();
  const pullNumber = Number(result?.pullNumber) || 0;
  const branchName = toText(result?.branchName);
  const codespaceUrl = resolveCodespaceUrlFromBootstrapPayload({
    ...extra,
    ...result,
  }, repoFullName);

  const stored = {
    repoFullName,
    pullUrl: toText(result?.pullUrl),
    pullNumber,
    branchName,
    commitSha: toText(result?.commitSha),
    codespaceUrl,
    createdAt: new Date().toISOString(),
  };
  overlayState.setupPrResultByUser[userId] = stored;
  return stored;
}

function navigatePendingCodespaceWindow(pendingWindow, codespaceUrl) {
  const targetUrl = toText(codespaceUrl);
  if (!targetUrl) {
    if (pendingWindow) pendingWindow.close();
    return false;
  }

  const now = Date.now();
  if (now < codespaceNavigationLockUntil
    && (/^https:\/\/[^/]+\.github\.dev/i.test(targetUrl) || targetUrl === codespaceNavigationLastUrl)) {
    return true;
  }
  codespaceNavigationLastUrl = targetUrl;
  codespaceNavigationLockUntil = now + CODESPACE_NAVIGATION_LOCK_MS;

  if (pendingWindow && !pendingWindow.closed) {
    try {
      pendingWindow.opener = null;
      pendingWindow.location.href = targetUrl;
      if (activeCodespaceDiscoveryTracker) {
        activeCodespaceDiscoveryTracker.opened = true;
        activeCodespaceDiscoveryTracker.stopped = true;
      }
      if (pendingWindow === pendingGithubOAuthWindow) {
        pendingGithubOAuthWindow = null;
      }
      return true;
    } catch {
      const opened = window.open(targetUrl, "_blank", "noopener,noreferrer");
      try {
        pendingWindow.close();
      } catch {}
      if (!opened) {
        codespaceNavigationLockUntil = 0;
      } else if (activeCodespaceDiscoveryTracker) {
        activeCodespaceDiscoveryTracker.opened = true;
        activeCodespaceDiscoveryTracker.stopped = true;
      }
      return !!opened;
    }
  } else {
    const opened = window.open(targetUrl, "_blank", "noopener,noreferrer");
    if (!opened) {
      codespaceNavigationLockUntil = 0;
    } else if (activeCodespaceDiscoveryTracker) {
      activeCodespaceDiscoveryTracker.opened = true;
      activeCodespaceDiscoveryTracker.stopped = true;
    }
    return !!opened;
  }
  return false;
}

function buildGithubBootstrapDevcontainerJson() {
  const backendBaseUrl = normalizeBaseUrl(overlayState.backendUrl) || DEFAULT_BACKEND_URL;
  const payload = {
    name: "ADACEEN Devcontainer",
    image: "mcr.microsoft.com/devcontainers/universal:2",
    customizations: {
      vscode: {
        extensions: [
          "adaceen.adaceen",
          "ms-python.python",
          "ms-vscode.cpptools",
          "eamodio.gitlens",
        ],
        settings: {
          "editor.formatOnSave": true,
          "files.trimTrailingWhitespace": true,
          "adaceen.backend.baseUrl": backendBaseUrl,
        },
      },
    },
    extensions: [
      "adaceen.adaceen",
    ],
    postCreateCommand: "bash .devcontainer/install-extensions.sh || true",
    postAttachCommand: "bash .devcontainer/install-extensions.sh || true",
    updateContentCommand: "bash .devcontainer/install-extensions.sh || true",
  };
  return JSON.stringify(payload, null, 2);
}

async function bootstrapDevcontainerWithGithubApp(options = {}) {
  const repoFullName = getCurrentRepoFullName();
  if (!repoFullName) {
    overlayState.statusMessage = "No se detecta repositorio activo para crear el PR.";
    renderOverlay();
    return;
  }

  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    overlayState.statusMessage = "Debes iniciar sesion para crear el PR.";
    renderOverlay();
    return;
  }

  const force = Boolean(options && options.force);
  const providedPendingWindow = options?.pendingWindow && !options.pendingWindow.closed
    ? options.pendingWindow
    : null;
  let pendingCodespaceWindow = providedPendingWindow;
  const initialGithubUserStatus = overlayState.githubUserStatus || EMPTY_GITHUB_USER_STATUS;
  if (!pendingCodespaceWindow
    && initialGithubUserStatus.connected
    && initialGithubUserStatus.hasCodespaceScope === true) {
    pendingCodespaceWindow = openCodespaceWaitingWindow(repoFullName);
  }

  try {
    await refreshGithubUserStatus();
  } catch {}

  const githubUserStatus = overlayState.githubUserStatus || EMPTY_GITHUB_USER_STATUS;
  if (!githubUserStatus.connected || githubUserStatus.hasCodespaceScope !== true) {
    if (pendingCodespaceWindow && pendingCodespaceWindow !== providedPendingWindow) {
      pendingCodespaceWindow.close();
    }
    overlayState.statusMessage = githubUserStatus.configured
      ? "Conecta tu cuenta de GitHub para que ADACEEN cree tu Codespace personal."
      : "El backend aun no tiene GitHub OAuth configurado para crear Codespaces por estudiante.";
    renderOverlay();
    if (githubUserStatus.configured) {
      await startGithubUserOAuthFlow();
    }
    return;
  }

  if (!force) {
    overlayState.processNoticeOpen = true;
    renderOverlay();
  }
  overlayState.githubAppBusy = true;
  if (activeCodespaceDiscoveryTracker) {
    activeCodespaceDiscoveryTracker.stopped = true;
    activeCodespaceDiscoveryTracker = null;
  }
  setOperationProgress(
    force ? "Rehaciendo entorno ADACEEN" : "Creando repositorio ADACEEN",
    "Creando o reutilizando la rama y el PR de configuracion...",
  );
  if (!pendingCodespaceWindow) {
    pendingCodespaceWindow = openCodespaceWaitingWindow(repoFullName);
  }
  if (!pendingCodespaceWindow) {
    overlayState.operationDetail = "El navegador bloqueo la ventana automatica. Cuando el Codespace este listo, usa Abrir Codespace.";
    renderOverlay();
  }
  const codespaceOpenTracker = {
    opened: false,
    stopped: false,
    error: "",
    codespace: null,
  };
  let keepCodespacePolling = false;
  const previousPull = getLatestSetupPullResult();
  const initialPullNumber = Number(previousPull?.pullNumber || overlayState.githubAppStatus?.bootstrapPullNumber) || 0;
  const initialBranchName = toText(previousPull?.branchName || overlayState.githubAppStatus?.bootstrapBranchName);
  if (pendingCodespaceWindow) {
    beginCodespaceDiscoveryPolling({
      repoFullName,
      branchName: initialBranchName,
      pullNumber: initialPullNumber,
      pendingWindow: pendingCodespaceWindow,
      tracker: codespaceOpenTracker,
    });
  }

  try {
    setOperationProgress(
      force ? "Rehaciendo entorno ADACEEN" : "Creando repositorio ADACEEN",
      "Aplicando devcontainer, creando PR y preparando Codespace...",
    );
    const response = await fetchJsonWithTimeout(`${baseUrl}/github/prepare-environment`, {
      method: "POST",
      headers: buildApiHeaders(),
      body: JSON.stringify({
        repoFullName,
        force,
        mode: "pr-codespace",
        devcontainerJson: buildGithubBootstrapDevcontainerJson(),
      }),
    }, CODESPACE_PREPARE_REQUEST_TIMEOUT_MS);

    if (response?.pullRequest || response?.codespace) {
      const pullRequest = response.pullRequest || {};
      const codespaceName = toText(response?.codespace?.name);
      const directCodespaceUrl = resolveDirectCodespaceUrlFromPayload(response);
      const quickstartUrl = toText(response?.codespace?.fallbackUrl)
        || toText(response?.fallback?.webUrl)
        || resolveCodespaceUrlFromBootstrapPayload(response, repoFullName);
      const targetPullNumber = Number(pullRequest.number) || 0;
      const targetBranchName = toText(pullRequest.branchName);
      const remembered = rememberSetupPrResult({
        repoFullName: response.repository || repoFullName,
        pullUrl: pullRequest.url,
        pullNumber: targetPullNumber,
        branchName: targetBranchName,
        codespaceUrl: directCodespaceUrl
          || (codespaceName ? buildCodespaceWebUrlFromName(codespaceName) : "")
          || quickstartUrl,
      }, response);
      let openedCodespace = codespaceOpenTracker.opened;
      if (openedCodespace) {
        codespaceOpenTracker.stopped = true;
      } else if (response.status === "ready") {
        openedCodespace = navigatePendingCodespaceWindow(
          pendingCodespaceWindow,
          directCodespaceUrl || remembered?.codespaceUrl,
        );
      } else if (codespaceName) {
        openedCodespace = await waitForCodespaceReadyFromBackend(
          codespaceName,
          pendingCodespaceWindow,
          Number(remembered?.pullNumber) || 0,
          directCodespaceUrl || remembered?.codespaceUrl,
        );
      } else {
        if (targetPullNumber > 0 || targetBranchName) {
          beginCodespaceDiscoveryPolling({
            repoFullName,
            branchName: targetBranchName,
            pullNumber: targetPullNumber,
            pendingWindow: pendingCodespaceWindow,
            tracker: codespaceOpenTracker,
          });
          keepCodespacePolling = true;
        }
        updateCodespaceWaitingWindow(
          pendingCodespaceWindow,
          "Codespace pendiente",
          "ADACEEN no recibio una URL directa todavia. Puedes abrir el selector de Codespaces o esperar el sondeo.",
          "",
          isCodespaceQuickstartUrl(quickstartUrl) ? quickstartUrl : "",
        );
      }
      await markSetupCompleted();
      setOperationProgress("Actualizando estado", "Confirmando PR y Codespace en ADACEEN...");
      await refreshGithubIntegrationStatus();
      if (openedCodespace) {
        clearOperationProgress(response.status === "ready"
          ? `Codespace listo para la PR #${remembered?.pullNumber || "?"}. Abriendolo ahora.`
          : `Codespace listo para la PR #${remembered?.pullNumber || "?"}. Abriendolo ahora.`);
      } else {
        const reason = response.status === "pending" && codespaceName
          ? "GitHub sigue preparando el contenedor. Puedes usar Abrir Codespace cuando cambie a Available."
          : (toText(response?.fallbackReason) || "GitHub no devolvio nombre ni web_url del Codespace.");
        if (isCodespaceLimitError(reason)) {
          setOperationError(
            "Limite de Codespaces alcanzado",
            "GitHub no permitio crear o iniciar otro Codespace. Cierra, detiene o elimina Codespaces que no uses en https://github.com/codespaces y vuelve a intentar.",
          );
        } else {
          clearOperationProgress(`No se pudo abrir Codespaces automaticamente: ${reason}`);
        }
      }
      return;
    }

    if (response?.alreadyBootstrapped === true) {
      const existingPullUrl = toText(response?.bootstrap?.pullUrl);
      const existingPullNumber = Number(response?.bootstrap?.pullNumber) || 0;
      const existingCodespaceUrl = resolveCodespaceUrlFromBootstrapPayload(response, repoFullName);
      const existingReason = toText(response?.reason);
      rememberSetupPrResult({
        repoFullName: toText(response?.bootstrap?.repoFullName) || repoFullName,
        pullUrl: existingPullUrl,
        pullNumber: existingPullNumber,
        branchName: toText(response?.bootstrap?.branchName),
        codespaceUrl: existingCodespaceUrl,
      });
      await markSetupCompleted();
      const openedCodespace = codespaceOpenTracker.opened
        || navigatePendingCodespaceWindow(pendingCodespaceWindow, existingCodespaceUrl);
      clearOperationProgress(existingPullUrl
        ? `Este repo ya tenia bootstrap (${existingReason || "detectado"}): PR #${existingPullNumber || "?"}. ${openedCodespace ? "Abriendo Codespaces de esa PR." : existingPullUrl}`
        : `Este repo ya estaba bootstrap (${existingReason || "detectado"}).${openedCodespace ? " Abriendo Codespaces." : ""}`);
      await refreshGithubIntegrationStatus();
      return;
    }

    const remembered = rememberSetupPrResult(response?.result || {}, response);
    const pullUrl = toText(remembered?.pullUrl || response?.result?.pullUrl);
    const pullNumber = Number(remembered?.pullNumber || response?.result?.pullNumber) || 0;
    const openedCodespace = codespaceOpenTracker.opened
      || navigatePendingCodespaceWindow(pendingCodespaceWindow, remembered?.codespaceUrl);
    await markSetupCompleted();
    clearOperationProgress(pullUrl
      ? `PR ${force ? "rehecho" : "creado"} (#${pullNumber}). ${openedCodespace ? "Abriendo Codespaces de esa PR." : pullUrl}`
      : `PR de bootstrap ${force ? "rehecho" : "creado"}.${openedCodespace ? " Abriendo Codespaces." : ""}`);
    await refreshGithubIntegrationStatus();
  } catch (error) {
    if (codespaceOpenTracker.opened) {
      await markSetupCompleted();
      clearOperationProgress("Codespace encontrado y abierto. ADACEEN continuara desde el entorno.");
      return;
    }
    if (pendingCodespaceWindow && pendingCodespaceWindow !== providedPendingWindow) {
      pendingCodespaceWindow.close();
    }
    if (isCodespaceLimitError(error)) {
      setOperationError(
        "Limite de Codespaces alcanzado",
        "GitHub no permitio crear o iniciar otro Codespace. Cierra, detiene o elimina Codespaces que no uses en https://github.com/codespaces y vuelve a intentar.",
      );
    } else {
      clearOperationProgress(`No se pudo ${force ? "rehacer" : "crear"} el PR de bootstrap: ${String(error)}`);
    }
  } finally {
    if (!keepCodespacePolling) {
      codespaceOpenTracker.stopped = true;
    }
    overlayState.processNoticeOpen = false;
    overlayState.githubAppBusy = false;
    renderOverlay();
  }
}

bindGithubOAuthCallbackListener();
