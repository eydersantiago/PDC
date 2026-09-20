// ADACEEN | Capa 3 - Servicios: URLs, estado, sondeo y apertura del Codespace del estudiante.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const CODESPACE_READY_POLL_INTERVAL_MS = 2000;
const CODESPACE_READY_POLL_TIMEOUT_MS = 420000;
const CODESPACE_READY_POLL_MAX_ATTEMPTS = 120;
const CODESPACE_DIRECT_OPEN_AFTER_ATTEMPTS = 2;
const CODESPACE_NAVIGATION_LOCK_MS = 300000;
let activeCodespaceDiscoveryTracker = null;
let codespaceNavigationLockUntil = 0;
let codespaceNavigationLastUrl = "";

function isCodespaceReadyState(state) {
  const normalized = toText(state).toLowerCase();
  return normalized === "available" || normalized === "ready";
}

function isDirectCodespaceUrl(value) {
  return /^https:\/\/[^/]+\.github\.dev(?:\/|$)/i.test(toText(value));
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
  const pull = getLatestSetupPullResult();
  return toText(pull?.codespaceUrl)
    || toText(overlayState.githubAppStatus?.bootstrapCodespaceUrl);
}

function getStoredSetupPullNumber() {
  const pull = getLatestSetupPullResult();
  return Number(pull?.pullNumber || overlayState.githubAppStatus?.bootstrapPullNumber) || 0;
}

function shouldPrepareCodespaceBeforeDashboard(flow) {
  const currentFlow = flow || getSetupFlowState(getPageContext());
  if (!currentFlow.repoReady || !currentFlow.accessVerified || !currentFlow.userHasCodespaceScope) {
    return false;
  }

  const context = currentFlow.context || getPageContext();
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

async function navigatePendingCodespaceWindow(pendingWindow, codespaceUrl) {
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

  await prepareCodespaceNavigationHandoff(targetUrl, {
    repoFullName: getCurrentRepoFullName(),
  }).catch(() => {});

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
}
