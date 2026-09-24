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
//   POST /api/workspaces/prepare   { repoFullName, force? }
//   GET  /api/workspaces/status?repoFullName=...
//        -> { ok, provider: "tunnel",
//             status: "ready" | "device_code" | "pending" | "error",
//             workspace: { login, tunnelName, webUrl, repoFullName },
//             deviceCode?: { userCode, verificationUrl, expiresAt },
//             message?: string }
//
// Si el backend no conoce estas rutas (404), el proveedor es "codespaces" y
// este archivo no interviene.

const WORKSPACE_PROVIDER_TTL_MS = 5 * 60 * 1000;
const WORKSPACE_PREPARE_TIMEOUT_MS = 120000;
const WORKSPACE_POLL_MS = 3000;
// GitHub deja el codigo de dispositivo vivo ~15 min; se espera algo menos.
const WORKSPACE_POLL_TIMEOUT_MS = 12 * 60 * 1000;

let workspaceProviderCheckedAt = 0;

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
  try {
    const response = await fetchJsonWithTimeout(
      `${baseUrl}/api/workspaces/provider`,
      { method: "GET", headers: buildApiHeaders() },
      8000,
    );
    overlayState.workspaceProvider = toText(response?.provider) || "codespaces";
  } catch {
    // Backend sin la ruta (o sin red): se asume Codespaces, que es lo de siempre.
    overlayState.workspaceProvider = overlayState.workspaceProvider || "codespaces";
  }
  workspaceProviderCheckedAt = Date.now();
  return overlayState.workspaceProvider;
}

function describeWorkspaceStatus(payload) {
  return {
    status: toText(payload?.status).toLowerCase(),
    webUrl: toText(payload?.workspace?.webUrl),
    login: toText(payload?.workspace?.login),
    userCode: toText(payload?.deviceCode?.userCode),
    verificationUrl: toText(payload?.deviceCode?.verificationUrl) || "https://github.com/login/device",
    message: toText(payload?.message),
  };
}

function showDeviceCodeStep(pendingWindow, info) {
  const detail = `Abre ${info.verificationUrl} y escribe el codigo ${info.userCode}. Es una sola vez: GitHub asocia el editor a tu cuenta.`;
  setOperationProgress(`Autoriza tu editor: codigo ${info.userCode}`, detail);
  updateCodespaceWaitingWindow(
    pendingWindow,
    `Codigo de autorizacion: ${info.userCode}`,
    detail,
    "",
    info.verificationUrl,
  );
  try {
    const quickLink = pendingWindow?.document?.getElementById("adaceenOpenQuickstartLink");
    if (quickLink) quickLink.textContent = `Abrir github.com/login/device (codigo ${info.userCode})`;
  } catch {
    // La ventana pudo navegar a otro origen; no pasa nada.
  }
  try {
    // Mejor esfuerzo: si el navegador lo permite, el codigo queda en el portapapeles.
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(info.userCode).catch(() => {});
    }
  } catch {
    // Sin permiso de portapapeles; el codigo sigue a la vista.
  }
}

async function finishTunnelWorkspace(pendingWindow, info, repoFullName) {
  rememberSetupPrResult({ repoFullName }, { codespaceWebUrl: info.webUrl });
  await markSetupCompleted();
  updateCodespaceWaitingWindow(pendingWindow, "Editor listo. Redirigiendo...", "Abriendo VS Code en el navegador.", info.webUrl, "");
  const opened = await navigatePendingCodespaceWindow(pendingWindow, info.webUrl);
  await refreshGithubIntegrationStatus().catch(() => {});
  clearOperationProgress(opened
    ? "Editor listo. Abriendolo ahora."
    : `Editor listo en ${info.webUrl}. Usa "Abrir editor" si la ventana no se abrio sola.`);
  return opened;
}

async function prepareTunnelWorkspace(options = {}) {
  const repoFullName = getCurrentRepoFullName();
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!repoFullName || !baseUrl || !overlayState.sessionId) {
    overlayState.statusMessage = "Debes iniciar sesion y estar en un repositorio para preparar el editor.";
    renderOverlay();
    return;
  }

  // Hace falta la cuenta de GitHub conectada (da el login para el tunel y
  // permiso de lectura al repo), pero NO el scope "codespace".
  try {
    await refreshGithubUserStatus();
  } catch {}
  const githubUserStatus = overlayState.githubUserStatus || EMPTY_GITHUB_USER_STATUS;
  if (!githubUserStatus.connected) {
    overlayState.statusMessage = githubUserStatus.configured
      ? "Conecta tu cuenta de GitHub: el editor se registra a tu nombre."
      : "El backend aun no tiene GitHub OAuth configurado.";
    renderOverlay();
    if (githubUserStatus.configured) {
      await startGithubUserOAuthFlow();
    }
    return;
  }

  const force = Boolean(options && options.force);
  let pendingWindow = options?.pendingWindow && !options.pendingWindow.closed ? options.pendingWindow : null;
  if (!pendingWindow) {
    pendingWindow = openCodespaceWaitingWindow(repoFullName);
  }
  if (pendingWindow) {
    updateCodespaceWaitingWindow(pendingWindow, "ADACEEN esta preparando tu editor", "Clonando el repositorio en la nube y registrando el tunel...", "", "");
  } else {
    overlayState.operationDetail = "El navegador bloqueo la ventana automatica. Cuando el editor este listo, usa Abrir editor.";
  }

  overlayState.githubAppBusy = true;
  overlayState.processNoticeOpen = !force;
  renderOverlay();
  setOperationProgress(force ? "Rehaciendo el editor" : "Preparando el editor", "Clonando el repositorio y registrando el tunel...");

  try {
    const first = await fetchJsonWithTimeout(`${baseUrl}/api/workspaces/prepare`, {
      method: "POST",
      headers: buildApiHeaders(),
      body: JSON.stringify({ repoFullName, force }),
    }, WORKSPACE_PREPARE_TIMEOUT_MS);

    let info = describeWorkspaceStatus(first);
    let shownCode = "";
    const startedAt = Date.now();

    while (Date.now() - startedAt < WORKSPACE_POLL_TIMEOUT_MS) {
      if (pendingWindow && pendingWindow.closed) {
        pendingWindow = null;
      }
      if (info.status === "ready" && info.webUrl) {
        await finishTunnelWorkspace(pendingWindow, info, repoFullName);
        return;
      }
      if (info.status === "error") {
        setOperationError("No se pudo preparar el editor", info.message || "El backend devolvio un error sin detalle.");
        updateCodespaceWaitingWindow(pendingWindow, "No se pudo preparar el editor", info.message || "Revisa el estado en ADACEEN.", "", "");
        return;
      }
      if (info.status === "device_code" && info.userCode && info.userCode !== shownCode) {
        shownCode = info.userCode;
        showDeviceCodeStep(pendingWindow, info);
      } else if (info.status === "pending" && !shownCode) {
        setOperationProgress("Preparando el editor", info.message || "Arrancando el tunel de VS Code...");
        updateCodespaceWaitingWindow(pendingWindow, "Esperando al editor", info.message || "Arrancando el tunel de VS Code...", "", "");
      }

      await new Promise((resolve) => setTimeout(resolve, WORKSPACE_POLL_MS));
      const next = await fetchJsonWithTimeout(
        `${baseUrl}/api/workspaces/status?repoFullName=${encodeURIComponent(repoFullName)}`,
        { method: "GET", headers: buildApiHeaders() },
        15000,
      ).catch(() => null);
      if (next) {
        info = describeWorkspaceStatus(next);
      }
    }

    setOperationError(
      "El editor no confirmo a tiempo",
      shownCode
        ? `El codigo ${shownCode} no se autorizo a tiempo. Pulsa "Preparar entorno" de nuevo para recibir otro.`
        : "El backend no confirmo el tunel. Vuelve a intentar o revisa el estado en ADACEEN.",
    );
  } catch (error) {
    setOperationError("No se pudo preparar el editor", error?.message || String(error));
  } finally {
    overlayState.githubAppBusy = false;
    renderOverlay();
  }
}
