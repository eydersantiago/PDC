"use strict";

// ADACEEN | Capa 3 - Servicios: preparacion del Codespace con la GitHub App: devcontainer, PR y apertura del Codespace.
// Movido sin cambios de github.service.js (constantes, URLs y navegacion).

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
