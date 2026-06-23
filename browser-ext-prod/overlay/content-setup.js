
function pickSignal(context) {
  return toText(context.visibleError)
    || toText(context.selection)
    || toText(context.activityTitle)
    || (toText(context.codeSnippet) ? "Fragmento de codigo detectado" : "")
    || "Sin senales concretas por ahora";
}

function friendlyPageContext(pageContext, pageType) {
  if (pageType === "codespace") return "GitHub / Codespaces";
  if (pageContext === "campus") return "Campus Virtual";
  if (pageContext === "github") return "GitHub";
  return "Pagina abierta";
}

function buildWelcomeText(context, goal) {
  if (context.pageContext === "campus") {
    return `Estas en Campus Virtual. Empezaremos con ${goal.label.toLowerCase()} usando el enunciado y las senales visibles como guia.`;
  }
  if (context.pageType === "codespace") {
    return `Estas programando en Codespaces. Empezaremos con ${goal.label.toLowerCase()} dentro de un cuadro flotante que se queda contigo en la pagina.`;
  }
  if (context.pageType === "github_code") {
    return `Estas en GitHub con un archivo abierto. Empezaremos con ${goal.label.toLowerCase()} tomando ese archivo como punto de partida.`;
  }
  return "Abrire una vista flotante simple para acompanarte paso a paso. Cuando pulses Empezar, reducire la ayuda a lo esencial.";
}

function buildMainStatus(context) {
  if (!overlayState.assistantEnabled) {
    return "El tutor esta pausado. Puedes reactivarlo en configuracion.";
  }
  if (context.pageContext === "campus") {
    return "Campus detectado. La ayuda se enfoca en el enunciado y la senal visible.";
  }
  if (context.pageType === "codespace") {
    return "Codespace detectado. La ayuda se enfoca en el archivo abierto y el siguiente paso.";
  }
  if (context.pageType === "github_code") {
    return "Archivo de GitHub detectado. La ayuda se enfoca en el codigo abierto.";
  }
  if (context.pageType === "github_general") {
    return "Repositorio detectado. Abre un archivo si quieres una pista mas concreta.";
  }
  return "Abre una actividad del piloto o un archivo para recibir ayuda mas contextual.";
}

function parseRepoFullName(value) {
  const text = toText(value)
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\/(tree|blob)\/.*$/i, "")
    .replace(/[?#].*$/g, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  if (!text) return "";

  const match = text.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) return "";
  return `${match[1]}/${match[2]}`;
}

function detectRepoFromLinks(links) {
  const candidates = Array.isArray(links) ? links : [];
  for (const item of candidates) {
    const href = parseRepoFullName(item?.href || "");
    if (href) return href;
    const text = parseRepoFullName(item?.text || "");
    if (text) return text;
  }
  return "";
}

function inferRepoFromContext(context) {
  const direct = parseRepoFullName(context?.repoFullName || "");
  if (direct) return direct;
  const fromUrl = parseRepoFullName(context?.url || "");
  if (fromUrl) return fromUrl;
  const fromTitle = parseRepoFullName(context?.title || "");
  if (fromTitle) return fromTitle;
  return detectRepoFromLinks(context?.links);
}

function getCurrentRepoFullName() {
  const fromSetup = parseRepoFullName(overlayState.setupRepoFullName);
  if (fromSetup) return fromSetup;
  return inferRepoFromContext(overlayState.context || {});
}

function setSetupRepoFullName(value) {
  overlayState.setupRepoFullName = parseRepoFullName(value);
  if (overlayEls?.setupRepoInput && overlayEls.setupRepoInput.value !== overlayState.setupRepoFullName) {
    overlayEls.setupRepoInput.value = overlayState.setupRepoFullName;
  }
}

function getSetupCompletionKey(repoOverride = "") {
  const userId = getCurrentUserId();
  const repoFullName = parseRepoFullName(repoOverride) || getCurrentRepoFullName();
  if (!userId || !repoFullName) return "";
  return `${userId}:${repoFullName.toLowerCase()}`;
}

function normalizeRepoRelativePath(value) {
  return toText(value)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .toLowerCase();
}

function hasBootstrapByProjectAnalysis() {
  const analysis = overlayState.projectAnalysis;
  if (!analysis || !Array.isArray(analysis.files)) return false;

  const files = new Set(
    analysis.files
      .map((item) => normalizeRepoRelativePath(item))
      .filter(Boolean),
  );

  const hasDevcontainerJson = files.has(".devcontainer/devcontainer.json");
  const markers = [
    hasDevcontainerJson,
    files.has(".devcontainer/install-extensions.sh"),
    files.has(".vscode/extensions.json"),
  ].filter(Boolean).length;

  return hasDevcontainerJson && markers >= 2;
}

function hasBootstrapByStatusSignals() {
  const signals = overlayState.githubAppStatus?.bootstrapSignals;
  if (!signals || typeof signals !== "object") return false;

  const hasDevcontainerMarker = signals.hasDevcontainerMarker === true;
  const markerCount = [
    signals.hasDevcontainerMarker === true,
    signals.hasInstallScriptMarker === true,
    signals.hasWorkspaceExtensionsMarker === true,
  ].filter(Boolean).length;

  return hasDevcontainerMarker && markerCount >= 2;
}

function hasBootstrapDetectedInTour() {
  return hasServerCompletedSetup()
    || hasBootstrapByStatusSignals()
    || hasBootstrapByProjectAnalysis();
}

function hydrateBootstrapSignalsFromCodespaceExplorer() {
  const context = overlayState.context || buildPayload();
  if (context.pageType !== "codespace") return false;
  if (hasBootstrapByProjectAnalysis()) return true;

  try {
    const entries = extractCodespaceExplorerEntries();
    if (!Array.isArray(entries) || entries.length === 0) return false;

    const analysis = buildCodespaceAnalysis(entries);
    if (!analysis || !Array.isArray(analysis.files)) return false;

    overlayState.projectAnalysis = analysis;
    overlayState.analysisUnlocked = true;
    return hasBootstrapByProjectAnalysis();
  } catch {
    return false;
  }
}

function hasServerCompletedSetup() {
  const status = overlayState.githubAppStatus || EMPTY_GITHUB_APP_STATUS;
  const currentRepo = getCurrentRepoFullName();
  const statusRepo = parseRepoFullName(status.repoFullName);

  if (currentRepo && statusRepo && currentRepo.toLowerCase() !== statusRepo.toLowerCase()) {
    return false;
  }

  return status.bootstrapReady === true;
}

function hasCompletedSetup() {
  if (hasBootstrapDetectedInTour()) {
    return true;
  }

  const userId = getCurrentUserId();
  const key = getSetupCompletionKey();
  if (!userId || !key) return false;
  return overlayState.setupDoneByUser[key] === true || overlayState.setupDoneByUser[userId] === true;
}

async function markSetupCompleted() {
  const key = getSetupCompletionKey();
  if (!key) return;
  overlayState.setupDoneByUser[key] = true;
  await persistPreferences();
}

function clearSetupForCurrentUser() {
  const key = getSetupCompletionKey();
  if (!key) return;
  overlayState.setupDoneByUser[key] = false;
}

function isGithubOrCodespaceContext(context) {
  const pageType = toText(context?.pageType);
  return pageType === "github_code" || pageType === "github_general" || pageType === "codespace";
}

function shouldShowGithubAppSection(context) {
  return isGithubOrCodespaceContext(context);
}

function canCreateBootstrapPr() {
  return !!overlayState.githubAppStatus?.configured
    && !!overlayState.githubAppStatus?.installation
    && overlayState.githubAppStatus?.hasRepoAccess === true
    && !!overlayState.githubUserStatus?.connected
    && overlayState.githubUserStatus?.hasCodespaceScope === true
    && !!getCurrentRepoFullName();
}

function getSetupFlowState(context) {
  const repoFullName = getCurrentRepoFullName();
  const status = overlayState.githubAppStatus || EMPTY_GITHUB_APP_STATUS;
  const githubUserStatus = overlayState.githubUserStatus || EMPTY_GITHUB_USER_STATUS;
  const configured = !!status.configured;
  const explored = !!overlayState.analysisUnlocked;
  const repoReady = !!repoFullName;
  const appConnected = repoReady && !!status.installation;
  const accessVerified = appConnected && status.hasRepoAccess === true;
  const userOAuthConfigured = githubUserStatus.configured === true;
  const userConnected = githubUserStatus.connected === true;
  const userHasCodespaceScope = userConnected && githubUserStatus.hasCodespaceScope === true;
  const bootstrapDetected = hasBootstrapDetectedInTour();
  const prCreated = accessVerified && bootstrapDetected;

  return {
    configured,
    explored,
    repoReady,
    appConnected,
    accessVerified,
    userOAuthConfigured,
    userConnected,
    userHasCodespaceScope,
    bootstrapDetected,
    prCreated,
    repoFullName,
    context,
  };
}

function resolveCurrentSetupStep(flow) {
  let step = Number(overlayState.setupWizardStep) || 1;
  step = Math.max(1, Math.min(3, step));

  if (step > 1 && !flow.repoReady) {
    step = 1;
  }
  if (!BYPASS_GITHUB_APP_INSTALL_VALIDATION) {
    if (step > 2 && !flow.accessVerified) {
      step = 2;
    }
    // Temporalmente deshabilitado para pruebas de PR:
    // if (step > 2 && !flow.accessVerified) step = 2;
  }

  overlayState.setupWizardStep = step;
  return step;
}

function buildGithubAppStatusText() {
  const repoFullName = getCurrentRepoFullName();
  const status = overlayState.githubAppStatus || EMPTY_GITHUB_APP_STATUS;

  if (!repoFullName) {
    return "Abre o pega un repositorio de GitHub/Codespaces para preparar ADACEEN.";
  }

  if (!status.configured) {
    return status.missingConfig?.length
      ? `Backend sin configurar GitHub App. Faltan: ${status.missingConfig.join(", ")}.`
      : "Backend sin configurar GitHub App.";
  }

  if (!status.installation) {
    return `Repo confirmado: ${repoFullName}. Falta autorizar la GitHub App para este usuario.`;
  }

  const account = status.installation.accountLogin
    ? `Instalada en ${status.installation.accountLogin}`
    : "Instalacion detectada";
  if (status.bootstrapReady === true) {
    return `${account}. ${repoFullName} ya tiene configuracion ADACEEN detectada.`;
  }
  if (status.hasRepoAccess === true) {
    return `${account}. La app ya tiene acceso a ${repoFullName}.`;
  }
  if (status.hasRepoAccess === false) {
    return `${account}. Falta confirmar acceso a ${repoFullName}.`;
  }
  return `${account}. Verifica acceso para continuar.`;
}

function buildSetupStatusText(context, currentStep, flow) {
  const modeLabel = context?.pageType === "codespace"
    ? "Codespaces"
    : context?.pageType === "github_code" || context?.pageType === "github_general"
      ? "GitHub"
      : "fuera de GitHub";

  if (flow.prCreated) {
    return "Listo: ADACEEN ya encontro la preparacion del repositorio. Puedes abrir el Codespace o entrar al dashboard.";
  }

  if (currentStep === 1) {
    if (!flow.repoReady) {
      return `Paso 1/3 en ${modeLabel}: confirma el repositorio. ADACEEN necesita el owner/repo antes de pedir permisos.`;
    }
    return `Paso 1/3 listo: ${flow.repoFullName}. Ahora autoriza la GitHub App para que pueda crear la rama y el PR.`;
  }

  if (currentStep === 2) {
    if (!flow.configured) {
      return `Paso 2/3 bloqueado: el backend no tiene configurada la GitHub App.`;
    }
    if (!flow.appConnected) {
      return `Paso 2/3: instala o autoriza la GitHub App en ${flow.repoFullName}. Esto permite crear el PR de configuracion.`;
    }
    if (!flow.accessVerified) {
      return `Paso 2/3: GitHub App detectada. Verifica que tenga acceso a este repositorio.`;
    }
    return `Paso 2/3 listo: GitHub App tiene acceso. Falta conectar tu cuenta para Codespaces y preparar el entorno.`;
  }

  if (!flow.userOAuthConfigured) {
    return `Paso 3/3 bloqueado: falta configurar GitHub OAuth en backend para crear el Codespace del estudiante.`;
  }
  if (!flow.userConnected) {
    return `Paso 3/3: conecta tu cuenta GitHub. El Codespace se creara en tu cuenta, con tus permisos.`;
  }
  if (!flow.userHasCodespaceScope) {
    return `Paso 3/3: falta el permiso Codespaces. Vuelve a autorizar GitHub para automatizar la apertura del entorno.`;
  }

  return `Paso 3/3 final: ADACEEN creara el PR, creara o reanudara el Codespace y lo abrira automaticamente.`;
}

function buildContextModuleInfo(context) {
  const pageType = toText(context?.pageType);
  const pageContext = toText(context?.pageContext);
  const repoFullName = getCurrentRepoFullName() || inferRepoFromContext(context || {});
  const branch = toText(context?.branch);
  const activityTitle = toText(context?.activityTitle);
  const activityDeadline = toText(context?.activityDeadline);
  const filePath = toText(context?.filePath);
  const title = toText(context?.title);
  const campusCourseOpen = isCampusCoursePageContext(context);

  if (pageType === "codespace") {
    return {
      label: "Contexto actual",
      title: "Codespace detectado",
      meta: [
        repoFullName ? `Proyecto: ${repoFullName}` : "Proyecto pendiente",
        filePath ? `Archivo: ${filePath}` : "",
      ].filter(Boolean).join(" | "),
      state: repoFullName ? "Activo" : "Sin repositorio",
      kind: repoFullName ? "ok" : "warn",
    };
  }

  if (pageType === "github_code" || pageType === "github_general") {
    return {
      label: "Contexto actual",
      title: "GitHub detectado",
      meta: [
        repoFullName ? `Repositorio: ${repoFullName}` : "Repositorio pendiente",
        branch ? `Rama: ${branch}` : "",
        filePath ? `Archivo: ${filePath}` : "",
      ].filter(Boolean).join(" | "),
      state: repoFullName ? "Repo listo" : "Detectando",
      kind: repoFullName ? "ok" : "warn",
    };
  }

  if (pageContext === "campus") {
    return {
      label: "Contexto actual",
      title: campusCourseOpen ? "Curso de Campus detectado" : "Campus Virtual detectado",
      meta: [
        campusCourseOpen && activityTitle ? `Curso: ${activityTitle}` : "Abre un curso para analizar actividades",
        campusCourseOpen && activityDeadline ? `Fecha: ${activityDeadline}` : "",
      ].filter(Boolean).join(" | "),
      state: campusCourseOpen ? "Curso abierto" : "Fuera de curso",
      kind: campusCourseOpen ? "ok" : "idle",
    };
  }

  return {
    label: "Contexto actual",
    title: "Pagina sin modulo ADACEEN",
    meta: title || "Abre Campus Virtual, GitHub o Codespaces para activar acciones.",
    state: "Sin contexto",
    kind: "idle",
  };
}

function buildConnectionItems(context, flow) {
  const pageType = toText(context?.pageType);
  const pageContext = toText(context?.pageContext);
  const status = overlayState.projectContextStatus || EMPTY_PROJECT_CONTEXT_STATUS;
  const repoFullName = getCurrentRepoFullName();
  const githubContext = isGithubOrCodespaceContext(context);
  const githubUserStatus = overlayState.githubUserStatus || EMPTY_GITHUB_USER_STATUS;
  const campusDetected = pageContext === "campus";
  const campusCourseOpen = isCampusCoursePageContext(context);
  const codespaceDetected = pageType === "codespace";

  let githubAppStatus = "No requerido aqui";
  let githubAppKind = "idle";
  if (githubContext) {
    if (!repoFullName) {
      githubAppStatus = "Repositorio pendiente";
      githubAppKind = "warn";
    } else if (!flow.configured) {
      githubAppStatus = "Backend pendiente";
      githubAppKind = "warn";
    } else if (!flow.appConnected) {
      githubAppStatus = "App pendiente";
      githubAppKind = "warn";
    } else if (!flow.accessVerified) {
      githubAppStatus = "Permiso pendiente";
      githubAppKind = "warn";
    } else {
      githubAppStatus = "App lista";
      githubAppKind = "ok";
    }
  }

  let githubUserStatusLabel = "No requerido aqui";
  let githubUserKind = "idle";
  if (githubContext) {
    if (!githubUserStatus.configured) {
      githubUserStatusLabel = "OAuth pendiente";
      githubUserKind = "warn";
    } else if (!githubUserStatus.connected) {
      githubUserStatusLabel = "Conectar cuenta";
      githubUserKind = "warn";
    } else if (githubUserStatus.hasCodespaceScope !== true) {
      githubUserStatusLabel = "Permiso Codespaces";
      githubUserKind = "warn";
    } else {
      githubUserStatusLabel = githubUserStatus.accountLogin
        ? `@${githubUserStatus.accountLogin}`
        : "Cuenta lista";
      githubUserKind = "ok";
    }
  }

  let codespaceStatus = "No iniciado";
  let codespaceKind = "idle";
  if (codespaceDetected && status.hasContext) {
    codespaceStatus = "Worker listo";
    codespaceKind = "ok";
  } else if (codespaceDetected) {
    codespaceStatus = "Detectado";
    codespaceKind = "ok";
  } else if (flow.bootstrapDetected) {
    codespaceStatus = "Listo";
    codespaceKind = "ok";
  } else if (githubContext && flow.accessVerified && flow.userHasCodespaceScope) {
    codespaceStatus = "Pendiente";
    codespaceKind = "warn";
  } else if (githubContext && flow.accessVerified) {
    codespaceStatus = "OAuth pendiente";
    codespaceKind = "warn";
  }

  return [
    {
      label: "ADACEEN",
      status: hasActiveSession() ? "Conectado" : "No conectado",
      kind: hasActiveSession() ? "ok" : "warn",
    },
    {
      label: "GitHub App",
      status: githubAppStatus,
      kind: githubAppKind,
    },
    {
      label: "GitHub OAuth",
      status: githubUserStatusLabel,
      kind: githubUserKind,
    },
    {
      label: "Campus",
      status: campusCourseOpen ? "Curso abierto" : (campusDetected ? "Sin curso" : "No detectado"),
      kind: campusCourseOpen ? "ok" : "idle",
    },
    {
      label: "Codespaces",
      status: codespaceStatus,
      kind: codespaceKind,
    },
  ];
}

function buildSetupRecommendedAction(context, currentStep, flow) {
  const pullResult = getLatestSetupPullResult();
  const storedCodespaceUrl = toText(pullResult?.codespaceUrl)
    || toText(overlayState.githubAppStatus?.bootstrapCodespaceUrl);
  const storedPullNumber = Number(pullResult?.pullNumber || overlayState.githubAppStatus?.bootstrapPullNumber) || 0;

  if (flow.repoReady && overlayState.githubAppBusy && overlayState.operationTitle) {
    return {
      title: "Preparando Codespace",
      copy: "ADACEEN sigue intentando abrirlo automaticamente. Si GitHub ya lo muestra en tu cuenta, puedes abrirlo manualmente sin crear otro proceso.",
      primary: { label: "Abrir Codespaces manualmente", action: "open_codespaces_manual" },
      secondary: { label: "Actualizar estado", action: "refresh_github_status" },
    };
  }

  if (flow.repoReady && (storedCodespaceUrl || storedPullNumber > 0)) {
    return {
      title: "Codespace solicitado",
      copy: storedCodespaceUrl
        ? `ADACEEN ya tiene un enlace directo para el Codespace de ${flow.repoFullName}.`
        : `ADACEEN ya creo la PR #${storedPullNumber}. Puedes abrir su Codespace o reintentar la preparacion automatica.`,
      primary: { label: "Abrir Codespace de la PR", action: "open_codespaces" },
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

  if (!flow.repoReady) {
    return {
      title: "Confirmar repositorio",
      copy: "Primero confirma el repositorio. Si estas en GitHub, usa Autodetectar; si no, pega owner/repo.",
      primary: { label: "Autodetectar repositorio", action: "detect_repo" },
      secondary: { label: "Leer archivos", action: "analyze_project" },
    };
  }

  if (!flow.configured) {
    return {
      title: "Backend GitHub pendiente",
      copy: "El servidor aun no tiene credenciales de GitHub App para generar el enlace de autorizacion.",
      primary: { label: "Actualizar estado", action: "refresh_github_status" },
      secondary: { label: "Volver al repo", action: "go_step_1" },
    };
  }

  if (!flow.appConnected) {
    return {
      title: "Autorizar repositorio",
      copy: `Instala la GitHub App en ${flow.repoFullName}. ADACEEN solo la usa para crear la rama y el PR de configuracion.`,
      primary: { label: "Autorizar GitHub App", action: "connect_github" },
      secondary: { label: "Actualizar estado", action: "refresh_github_status" },
    };
  }

  if (!flow.accessVerified) {
    return {
      title: "Permiso pendiente",
      copy: `La app esta instalada, pero falta verificar acceso a ${flow.repoFullName}.`,
      primary: { label: "Verificar acceso", action: "refresh_github_status" },
      secondary: { label: "Conectar otra vez", action: "connect_github" },
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
      secondary: { label: "Volver", action: "go_step_2" },
    };
  }

  if (!flow.userConnected) {
    return {
      title: "Conectar cuenta GitHub",
      copy: `Ahora conecta tu cuenta personal. Este permiso permite crear o reanudar tu Codespace para la PR de ${flow.repoFullName}.`,
      primary: { label: "Conectar GitHub", action: "connect_github_user" },
      secondary: { label: "Actualizar estado", action: "refresh_github_status" },
    };
  }

  if (!flow.userHasCodespaceScope) {
    return {
      title: "Permiso Codespaces pendiente",
      copy: "La cuenta GitHub esta conectada, pero falta el scope codespace. Vuelve a autorizar para permitir crear o reanudar Codespaces.",
      primary: { label: "Autorizar Codespaces", action: "connect_github_user" },
      secondary: { label: "Actualizar estado", action: "refresh_github_status" },
    };
  }

  return {
    title: "Preparar entorno",
    copy: `Todo listo. ADACEEN creara el PR, preparara el Codespace y lo abrira automaticamente. No necesitas crear el Codespace manualmente.`,
    primary: { label: "Preparar entorno ADACEEN", action: "create_bootstrap_pr" },
    secondary: currentStep === 3
      ? { label: "Volver", action: "go_step_2" }
      : { label: "Actualizar estado", action: "refresh_github_status" },
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

function buildMainRecommendedAction(context, flow) {
  const pageType = toText(context?.pageType);
  const pageContext = toText(context?.pageContext);
  const repoFullName = getCurrentRepoFullName();
  const pullResult = getLatestSetupPullResult();
  const statusCodespaceUrl = toText(overlayState.githubAppStatus?.bootstrapCodespaceUrl);
  const statusPullNumber = Number(overlayState.githubAppStatus?.bootstrapPullNumber) || 0;

  if (isAdminSession()) {
    return {
      title: "Administrar ADACEEN",
      copy: "Gestiona usuarios y roles del piloto desde el panel principal.",
      primary: { label: "Recargar usuarios", action: "reload_admin_users" },
      secondary: { label: "Configuracion", action: "open_settings" },
    };
  }

  if (pageContext === "campus") {
    if (!isCampusCoursePageContext(context)) {
      return null;
    }

    const activity = toText(context?.activityTitle) || "Actividad del Campus";
    const access = typeof getCurrentCampusCourseAccess === "function"
      ? getCurrentCampusCourseAccess(context)
      : { checked: false, checking: false, accessConfirmed: false, bitacoraLoaded: false, courseCode: "" };
    const courseCode = typeof getActiveCampusCourseCode === "function"
      ? getActiveCampusCourseCode(context)
      : toText(access.courseCode || "FPOO");
    if (access.checking) {
      return {
        title: "Confirmando curso",
        copy: `Verificando acceso del estudiante y bitacora subida para ${courseCode}.`,
        primary: { label: "Verificando", action: "verify_campus_course_access", disabled: true },
        secondary: { label: "Actualizar", action: "verify_campus_course_access", disabled: true },
      };
    }
    if (!access.checked || !access.accessConfirmed) {
      return {
        title: "Confirmar acceso",
        copy: `Antes de analizar Campus, confirma que el estudiante tiene acceso a ${courseCode} y que el curso tiene bitacora subida.`,
        primary: { label: "Verificar acceso", action: "verify_campus_course_access", disabled: !!overlayState.analysisBusy },
        secondary: isTeacherSession()
          ? { label: "Configurar RAG", action: "open_teacher_rag", disabled: !!overlayState.analysisBusy }
          : { label: "Elegir curso", action: "choose_student_course", disabled: !!overlayState.analysisBusy },
      };
    }
    if (!access.bitacoraLoaded) {
      return {
        title: "Bitacora requerida",
        copy: `Acceso confirmado para ${courseCode}, pero falta una fuente tipo bitacora o cronograma antes de analizar la pagina.`,
        primary: isTeacherSession()
          ? { label: "Configurar RAG", action: "open_teacher_rag", disabled: !!overlayState.analysisBusy }
          : { label: "Actualizar acceso", action: "verify_campus_course_access", disabled: !!overlayState.analysisBusy },
        secondary: { label: "Verificar acceso", action: "verify_campus_course_access", disabled: !!overlayState.analysisBusy },
      };
    }

    const analysis = overlayState.campusAnalysis;
    const stats = analysis?.stats || {};
    let calendarEventCount = 0;
    if (analysis && typeof buildCampusCalendarEvents === "function") {
      try {
        const campusEvents = buildCampusCalendarEvents(analysis, context);
        calendarEventCount = typeof mergeCampusCalendarEvents === "function"
          ? mergeCampusCalendarEvents([campusEvents]).length
          : campusEvents.length;
      } catch {
        calendarEventCount = 0;
      }
    }

    return {
      title: "Agenda Campus",
      copy: calendarEventCount
        ? `Actividad detectada: ${activity}. Hay ${calendarEventCount} evento(s) listo(s) para guardar en Google Calendar.`
        : stats.taskCount
          ? `Actividad detectada: ${activity}. Hay ${stats.taskCount} tarea(s) y ${stats.deadlineCount || 0} fecha(s) visibles para sincronizar.`
        : `Bitacora y acceso confirmados para ${courseCode}. Analiza el HTML visible del curso y luego sincroniza Calendar cuando estes listo.`,
      primary: {
        label: analysis && calendarEventCount ? "Sincronizar Calendar" : "Analizar Campus",
        action: analysis && calendarEventCount ? "sync_campus_calendar" : "analyze_project",
        disabled: !!overlayState.analysisBusy,
      },
      secondary: {
        label: analysis ? "Ver analisis" : "Verificar acceso",
        action: analysis ? "analyze_project" : "verify_campus_course_access",
        disabled: !!overlayState.analysisBusy,
      },
    };
  }

  if (pageType === "codespace") {
    return {
      title: "Tutor en Codespaces",
      copy: repoFullName
        ? `Proyecto activo: ${repoFullName}. El siguiente paso es leer el workspace o pedir una guia contextual.`
        : "Codespace detectado. Falta confirmar el repositorio para coordinar el worker.",
      primary: { label: overlayState.analysisUnlocked ? "Solicitar tutoria" : "Analizar proyecto", action: overlayState.analysisUnlocked ? "refresh_mentor" : "analyze_project" },
      secondary: { label: "Reintentar OCR", action: "rerun_ocr", disabled: !repoFullName },
    };
  }

  if (pageType === "github_code" || pageType === "github_general") {
    if (pullResult?.pullUrl || statusCodespaceUrl || statusPullNumber > 0) {
      return {
        title: "PR creado",
        copy: pullResult?.codespaceUrl || statusCodespaceUrl
          ? `El PR de configuracion para ${repoFullName || "este repositorio"} ya tiene enlace directo de Codespaces.`
          : `El PR de configuracion para ${repoFullName || "este repositorio"} esta disponible.`,
        primary: { label: "Abrir Codespace de la PR", action: "open_codespaces" },
        secondary: { label: "Ver PR creado", action: "open_setup_pr" },
      };
    }

    return {
      title: "Repositorio listo",
      copy: repoFullName
        ? `GitHub conectado para ${repoFullName}. Puedes abrir Codespaces o actualizar la guia.`
        : "Repositorio GitHub detectado. Actualiza contexto para confirmar el owner/repo.",
      primary: { label: "Abrir Codespaces", action: "open_codespaces", disabled: !repoFullName },
      secondary: { label: "Actualizar contexto", action: "refresh_mentor" },
    };
  }

  return {
    title: "Buscar contexto",
    copy: "Abre Campus Virtual, GitHub o Codespaces para activar acciones especificas.",
    primary: { label: "Actualizar contexto", action: "refresh_mentor" },
    secondary: null,
  };
}

function hasActiveSession() {
  return !!overlayState.session?.user;
}

function isTeacherSession() {
  return overlayState.session?.user?.role === "teacher";
}

function isAdminSession() {
  return overlayState.session?.user?.role === "admin";
}

function canManageUsersSession() {
  return isAdminSession() || isTeacherSession();
}

function getRoleLabel(role) {
  if (role === "teacher") return "Profesor";
  if (role === "admin") return "Admin";
  return "Estudiante";
}

function getRoleLabelLower(role) {
  if (role === "teacher") return "profesor";
  if (role === "admin") return "admin";
  return "estudiante";
}

function buildTeacherSummary() {
  const settings = overlayState.policy || DEFAULT_POLICY;
  const toneMap = { warm: "calido", direct: "directo", socratic: "socratico" };
  const frequencyMap = { low: "baja", medium: "media", high: "alta" };
  const helpMap = { progressive: "progresiva", hint_only: "solo pistas", partial_example: "ejemplo parcial" };
  const hintLimit = settings.maxHintsPerExercise == null ? "pistas ilimitadas" : `max ${settings.maxHintsPerExercise} pistas`;

  return [
    `${settings.policyName || "Politica docente"}`,
    `tono ${toneMap[settings.tone] || "calido"}`,
    `frecuencia ${frequencyMap[settings.frequency] || "media"}`,
    `ayuda ${helpMap[settings.helpLevel] || "progresiva"}`,
    hintLimit,
    settings.outcome,
  ].join(" | ");
}
