"use strict";

// ADACEEN | Capa 3 - Servicios: espera del Codespace: descubrirlo y esperar a que el backend lo de por listo.
// Movido sin cambios de github.service.js (constantes, URLs y navegacion).

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
