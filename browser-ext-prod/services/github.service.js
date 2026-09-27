// ADACEEN | Capa 3 - Servicios: GitHub App, OAuth de usuario y preparacion de Codespaces.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";
const CODESPACE_READY_POLL_INTERVAL_MS = 2000;
const CODESPACE_READY_POLL_TIMEOUT_MS = 420000;
const CODESPACE_PREPARE_REQUEST_TIMEOUT_MS = 120000;
const CODESPACE_READY_POLL_MAX_ATTEMPTS = 120;
const CODESPACE_DIRECT_OPEN_AFTER_ATTEMPTS = 2;
const CODESPACE_NAVIGATION_LOCK_MS = 300000;
let activeCodespaceDiscoveryTracker = null;
let codespaceNavigationLockUntil = 0;
let codespaceNavigationLastUrl = "";

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

function isCodespaceReadyState(state) {
  const normalized = toText(state).toLowerCase();
  return normalized === "available" || normalized === "ready";
}

function isTunnelEditorUrl(value) {
  // VS Code Tunnels: https://vscode.dev/tunnel/<nombre>/<ruta>
  return /^https:\/\/(?:insiders\.)?vscode\.dev\/tunnel\/[^/?#]+/i.test(toText(value));
}

function isDirectCodespaceUrl(value) {
  // "Directa" = una URL que abre el editor sin pasar por codespaces.new:
  // un Codespace (*.github.dev) o un tunel de VS Code (vscode.dev/tunnel/...).
  return /^https:\/\/[^/]+\.github\.dev(?:\/|$)/i.test(toText(value)) || isTunnelEditorUrl(value);
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
  return Date.now() < codespaceNavigationLockUntil && isDirectCodespaceUrl(codespaceNavigationLastUrl);
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
        }, BACKEND_TIMEOUT_MS);
        const codespace = response?.codespace || null;
        const name = toText(codespace?.name);
        const state = toText(codespace?.state) || "creado";
        const webUrl = toText(codespace?.webUrl) || buildCodespaceWebUrlFromName(name);

        if (name && webUrl) {
          tracker.codespace = codespace;
          tracker.opened = await navigatePendingCodespaceWindow(pendingWindow, webUrl);
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
    return knownWebUrl ? await navigatePendingCodespaceWindow(pendingWindow, knownWebUrl) : false;
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
      }, BACKEND_TIMEOUT_MS);
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
        return await navigatePendingCodespaceWindow(pendingWindow, webUrl);
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
        return await navigatePendingCodespaceWindow(pendingWindow, knownWebUrl);
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
  const target = toText(value);
  return /^https:\/\/codespaces\.new\//i.test(target)
    || /^https:\/\/github\.com\/codespaces\/new(?:\/|$)/i.test(target);
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

function getStoredSetupCodespaceUrl() {
  if (typeof isTunnelProvider === "function" && isTunnelProvider() && typeof getSavedTunnelEditor === "function") {
    const saved = getSavedTunnelEditor();
    if (saved?.webUrl) return saved.webUrl;
  }
  const pull = getLatestSetupPullResult();
  return toText(pull?.codespaceUrl)
    || toText(overlayState.githubAppStatus?.bootstrapCodespaceUrl);
}

function getStoredSetupPullNumber() {
  const pull = getLatestSetupPullResult();
  return Number(pull?.pullNumber || overlayState.githubAppStatus?.bootstrapPullNumber) || 0;
}

function shouldPrepareCodespaceBeforeDashboard(flow) {
  const currentFlow = flow || getSetupFlowState(overlayState.context || buildPayload());
  if (!currentFlow.repoReady || !currentFlow.accessVerified || !currentFlow.userHasCodespaceScope) {
    return false;
  }

  const context = currentFlow.context || overlayState.context || buildPayload();
  if (toText(context?.pageType) === "codespace") {
    return false;
  }

  const knownUrl = getStoredSetupCodespaceUrl();
  if (isDirectCodespaceUrl(knownUrl)) return false;

  return !!knownUrl
    || getStoredSetupPullNumber() > 0
    || currentFlow.prCreated
    || hasCompletedSetup();
}

// options.force: navega aunque el candado reciente diga que ya se abrio (clic explicito del
// estudiante en "Abrir mi editor" o final de la preparacion del tunel, sin sondeos en paralelo).
async function navigatePendingCodespaceWindow(pendingWindow, codespaceUrl, options = {}) {
  // A12.8: la ventana de espera es about:blank con el origen de la pagina; una URL
  // javascript: del backend se ejecutaria ahi. Solo se navega a http/https.
  const targetUrl = toSafeHttpUrl(codespaceUrl);
  if (!targetUrl) {
    if (pendingWindow) pendingWindow.close();
    return false;
  }

  const now = Date.now();
  if (options?.force !== true
    && now < codespaceNavigationLockUntil
    && (isDirectCodespaceUrl(targetUrl) || targetUrl === codespaceNavigationLastUrl)) {
    return true;
  }
  codespaceNavigationLastUrl = targetUrl;
  codespaceNavigationLockUntil = now + CODESPACE_NAVIGATION_LOCK_MS;

  if (typeof prepareCodespaceNavigationHandoff === "function") {
    await prepareCodespaceNavigationHandoff(targetUrl, {
      repoFullName: getCurrentRepoFullName(),
    }).catch(() => {});
  }

  if (pendingWindow && !pendingWindow.closed) {
    try {
      // Si la ventana ya esta en otro origen (la del OAuth en el backend o
      // github.com/login/device), opener no se puede escribir, pero location si:
      // eso no es motivo para cerrarla y abrir otra que el navegador bloquearia.
      try {
        pendingWindow.opener = null;
      } catch {}
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

  // Con el proveedor "tunnel" el entorno no es un Codespace: lo prepara la VM
  // de Google Cloud y se abre en vscode.dev. Todo ese camino vive en
  // workspace.service.js; aqui solo se desvia.
  if (typeof refreshWorkspaceProvider === "function") {
    // Un proveedor provisional (fallo pasajero al consultarlo) se confirma antes de crear
    // una PR: con el tunel no se debe crear.
    const provisional = typeof isWorkspaceProviderProvisional === "function" && isWorkspaceProviderProvisional();
    await refreshWorkspaceProvider(provisional).catch(() => "");
  }
  if (typeof isTunnelProvider === "function" && isTunnelProvider()) {
    await prepareTunnelWorkspace({ force, pendingWindow: options?.pendingWindow });
    return;
  }

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

  await refreshCodespaceWaitingContext().catch(() => false);
  if (pendingCodespaceWindow) {
    updateCodespaceWaitingSlides(pendingCodespaceWindow, repoFullName);
  }

  // Sin el aviso "Entendido": la ventana de espera y el banner de progreso ya dicen que tarda.
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
    updateCodespaceWaitingSlides(pendingCodespaceWindow, repoFullName);
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
        openedCodespace = await navigatePendingCodespaceWindow(
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
        || (isDirectCodespaceUrl(existingCodespaceUrl)
          ? await navigatePendingCodespaceWindow(pendingCodespaceWindow, existingCodespaceUrl)
          : false);
      if (!openedCodespace && (existingPullNumber > 0 || toText(response?.bootstrap?.branchName))) {
        beginCodespaceDiscoveryPolling({
          repoFullName,
          branchName: toText(response?.bootstrap?.branchName),
          pullNumber: existingPullNumber,
          pendingWindow: pendingCodespaceWindow,
          tracker: codespaceOpenTracker,
        });
        keepCodespacePolling = true;
      }
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
      || (isDirectCodespaceUrl(remembered?.codespaceUrl)
        ? await navigatePendingCodespaceWindow(pendingCodespaceWindow, remembered?.codespaceUrl)
        : false);
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
    overlayState.githubAppBusy = false;
    renderOverlay();
  }
}
