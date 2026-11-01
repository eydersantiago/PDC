// ADACEEN | Capa 2 - Contexto: la acción recomendada del tour de configuración (Codespaces y túnel) y el
// último PR del entorno. Movido sin cambios de content-setup-actions.js.

function buildSetupRecommendedAction(context, currentStep, flow) {
  const pullResult = getLatestSetupPullResult();
  const storedCodespaceUrl = toText(pullResult?.codespaceUrl)
    || toText(overlayState.githubAppStatus?.bootstrapCodespaceUrl);
  const storedPullNumber = Number(pullResult?.pullNumber || overlayState.githubAppStatus?.bootstrapPullNumber) || 0;
  const pageType = toText(context?.pageType);

  if (isTunnelSetupFlow()) {
    return buildTunnelSetupRecommendedAction(flow);
  }

  // Solo con la App lista se prepara el Codespace: antes, "ocupado" es el enlace de la App o del OAuth.
  if (flow.repoReady && flow.accessVerified && overlayState.githubAppBusy && overlayState.operationTitle) {
    return {
      title: `Preparando ${editorNoun(true)}`,
      copy: "ADACEEN sigue intentando abrirlo automaticamente. Si GitHub ya lo muestra en tu cuenta, puedes abrirlo manualmente sin crear otro proceso.",
      primary: { label: "Abrir Codespaces manualmente", action: "open_codespaces_manual" },
      secondary: { label: "Actualizar estado", action: "refresh_github_status" },
    };
  }

  if (flow.repoReady && (storedCodespaceUrl || storedPullNumber > 0)) {
    if (pageType === "codespace") {
      return {
        title: `${editorNoun(true)} detectado`,
        copy: `Ya estas dentro del entorno. ADACEEN no necesita preparar ni reanudar otro ${editorNoun()}.`,
        primary: { label: "Continuar aqui", action: "open_codespaces" },
        secondary: { label: "Actualizar estado", action: "refresh_github_status" },
      };
    }

    const hasDirectCodespaceUrl = typeof isDirectCodespaceUrl === "function"
      && isDirectCodespaceUrl(storedCodespaceUrl);
    const pendingCodespaceCopy = storedPullNumber > 0
      ? `ADACEEN ya creo la PR #${storedPullNumber}. Puedes abrir su Codespace o reintentar la preparacion automatica.`
      : "ADACEEN tiene un enlace de selector, pero aun falta confirmar el Codespace directo. Preparalo para que se abra automaticamente.";
    return {
      title: hasDirectCodespaceUrl ? `${editorNoun(true)} listo` : `${editorNoun(true)} pendiente`,
      copy: hasDirectCodespaceUrl
        ? `ADACEEN ya tiene un enlace directo para el ${editorNoun()} de ${flow.repoFullName}.`
        : pendingCodespaceCopy,
      primary: { label: hasDirectCodespaceUrl ? `Abrir ${editorNoun()}` : `Preparar ${editorNoun()}`, action: "open_codespaces" },
      secondary: overlayState.githubAppBusy
        ? { label: "Actualizar estado", action: "refresh_github_status" }
        : { label: "Reintentar preparacion", action: "create_bootstrap_pr" },
    };
  }

  if (flow.bootstrapDetected || flow.prCreated || hasCompletedSetup()) {
    return {
      title: "Entorno listo",
      copy: flow.repoFullName
        ? `${flow.repoFullName} ya tiene preparacion ADACEEN detectada.`
        : "La preparacion inicial ya esta completa.",
      primary: { label: "Ir al dashboard", action: "finish_setup" },
      secondary: { label: "Actualizar estado", action: "refresh_github_status" },
    };
  }

  // Codespaces con un boton unico, como el tunel (auditoria de redundancias, item 2): sin
  // "Actualizar estado" ni "Volver" al lado de cada paso. La GitHub App se detecta sola tras
  // abrir la instalacion (sin "Verificar acceso") y la cuenta de GitHub, al volver del OAuth.
  if (!flow.repoReady) {
    return {
      title: "Confirmar repositorio",
      copy: "Primero confirma el repositorio. Si estas en GitHub, usa Autodetectar; si no, pega owner/repo.",
      primary: { label: "Autodetectar repositorio", action: "detect_repo" },
      secondary: null,
    };
  }

  if (!flow.configured) {
    return {
      title: "Backend GitHub pendiente",
      copy: "El servidor aun no tiene credenciales de GitHub App para generar el enlace de autorizacion. Avisa al docente.",
      primary: { label: "Actualizar estado", action: "refresh_github_status" },
      secondary: null,
    };
  }

  const waitingApp = isWaitingGithubAppInstall();
  if (!flow.appConnected || !flow.accessVerified) {
    const copy = waitingApp
      ? `Termina la instalacion en la pestana de GitHub y elige ${flow.repoFullName}. ADACEEN la detecta sola y sigue aqui; si cerraste esa pestana, pulsa Autorizar GitHub App otra vez.`
      : !flow.appConnected
        ? `Instala la GitHub App en ${flow.repoFullName}. ADACEEN solo la usa para crear la rama y el PR de configuracion, y detecta la instalacion sola.`
        : `La GitHub App esta instalada, pero aun no tiene acceso a ${flow.repoFullName}. Pulsa Autorizar GitHub App y agrega este repositorio; ADACEEN lo detecta solo.`;
    return {
      title: waitingApp ? "Esperando la GitHub App" : (!flow.appConnected ? "Autorizar repositorio" : "Permiso pendiente"),
      copy,
      primary: { label: "Autorizar GitHub App", action: "connect_github" },
      secondary: null,
    };
  }

  if (!flow.userOAuthConfigured) {
    const invalidConfig = overlayState.githubUserStatus?.invalidConfig;
    const configHint = Array.isArray(invalidConfig) && invalidConfig.length
      ? invalidConfig.join(" ")
      : "El backend necesita GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET y callback para crear Codespaces con la cuenta del estudiante.";
    return {
      title: "OAuth GitHub pendiente",
      copy: configHint,
      primary: { label: "Actualizar estado", action: "refresh_github_status" },
      secondary: null,
    };
  }

  if (!flow.userConnected) {
    return {
      title: "Conectar cuenta GitHub",
      copy: `Ahora conecta tu cuenta personal. Al volver, ADACEEN creara el PR y tu Codespace para ${flow.repoFullName} y lo abrira en esa misma ventana.`,
      primary: { label: "Conectar GitHub", action: "connect_github_user" },
      secondary: null,
    };
  }

  if (!flow.userHasCodespaceScope) {
    return {
      title: "Permiso Codespaces pendiente",
      copy: "La cuenta GitHub esta conectada, pero falta el scope codespace. Vuelve a autorizar para permitir crear o reanudar Codespaces.",
      primary: { label: "Autorizar Codespaces", action: "connect_github_user" },
      secondary: null,
    };
  }

  return {
    title: "Preparar entorno",
    copy: `Todo listo. ADACEEN creara el PR, preparara el Codespace y lo abrira automaticamente (puede tardar cerca de 2 minutos). No necesitas crear el Codespace manualmente.`,
    primary: { label: "Preparar entorno ADACEEN", action: "create_bootstrap_pr" },
    secondary: null,
  };
}

// Tunel: un boton unico. Sin la GitHub App ni botones que solo cambian de tarjeta.
function buildTunnelSetupRecommendedAction(flow) {
  if (overlayState.githubAppBusy) {
    return {
      title: "Preparando tu editor",
      copy: "ADACEEN sigue preparando tu editor en la nube. La ventana de espera lo abrira sola cuando este listo.",
      primary: { label: "Preparando...", action: "open_my_editor", disabled: true },
      secondary: null,
    };
  }

  if (!flow.repoReady) {
    return {
      title: "Confirmar repositorio",
      copy: "Abre tu repositorio en GitHub o escribe owner/repo en el campo de abajo.",
      primary: { label: "Autodetectar repositorio", action: "detect_repo" },
      secondary: null,
    };
  }

  if (!flow.userOAuthConfigured) {
    return {
      title: "OAuth GitHub pendiente",
      copy: "El backend necesita GITHUB_OAUTH_CLIENT_ID y GITHUB_OAUTH_CLIENT_SECRET para conectar tu cuenta. Avisa al docente.",
      primary: { label: "Actualizar estado", action: "refresh_github_status" },
      secondary: null,
    };
  }

  if (!flow.userConnected) {
    return {
      title: "Conectar GitHub",
      copy: `Un solo paso: conecta tu cuenta de GitHub. Al volver, ADACEEN preparara y abrira tu editor en la nube para ${flow.repoFullName}.`,
      primary: { label: "Conectar GitHub", action: "connect_github_user" },
      secondary: null,
    };
  }

  const saved = typeof getSavedTunnelEditor === "function" ? getSavedTunnelEditor() : null;
  // Con otro repositorio ya en el editor (0.7.20), este se agrega en su carpeta sin otro codigo.
  const otherEditor = !saved && typeof getLatestSavedTunnelEditor === "function" ? getLatestSavedTunnelEditor() : null;
  return {
    title: saved ? "Tu editor" : "Preparar tu editor",
    copy: saved
      ? `Tu editor en la nube para ${flow.repoFullName} esta guardado. Si la VM estaba apagada, ADACEEN espera a que encienda.`
      : otherEditor
        ? `ADACEEN agregara ${flow.repoFullName} a tu editor en la nube, en su propia carpeta, y lo abrira. No te pedira otro codigo.`
        : `GitHub conectado. ADACEEN preparara tu editor en la nube para ${flow.repoFullName} y lo abrira. La primera vez GitHub te pedira un codigo de un solo uso.`,
    primary: { label: myEditorButtonLabel(), action: "open_my_editor" },
    secondary: null,
  };
}

function getLatestSetupPullResult() {
  const userId = getCurrentUserId();
  if (!userId || !overlayState.setupPrResultByUser) return null;
  const stored = overlayState.setupPrResultByUser[userId] || null;
  if (!stored) return null;

  const currentRepo = getCurrentRepoFullName();
  const storedRepo = parseRepoFullName(stored.repoFullName);
  if (currentRepo && storedRepo && currentRepo.toLowerCase() !== storedRepo.toLowerCase()) {
    return null;
  }

  const status = overlayState.githubAppStatus || EMPTY_GITHUB_APP_STATUS;
  const statusRepo = parseRepoFullName(status.repoFullName);
  const statusMatchesCurrentRepo = !!currentRepo
    && !!statusRepo
    && currentRepo.toLowerCase() === statusRepo.toLowerCase();
  if (statusMatchesCurrentRepo && status.bootstrapReady === false && !overlayState.githubAppBusy) {
    return null;
  }

  return stored;
}

function clearSetupPrResultForCurrentUser() {
  const userId = getCurrentUserId();
  if (!userId || !overlayState.setupPrResultByUser) return;
  delete overlayState.setupPrResultByUser[userId];
}
