// ADACEEN | Capa 2 - Contexto: estado del tour de configuracion (repo, GitHub App, OAuth, Codespace).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

function pickSignal(context) {
  return toText(context.visibleError)
    || toText(context.selection)
    || toText(context.activityTitle)
    || (toText(context.codeSnippet) ? "Fragmento de codigo detectado" : "")
    || "Sin senales concretas por ahora";
}

// vscode.dev/tunnel: el editor en la nube del proveedor "tunnel". El overlay lo trata como un
// Codespace (pageType "codespace"), pero sus textos no deben hablar de Codespaces.
function isTunnelEditorPage(context = null) {
  const target = context || overlayState.context || buildPayload();
  return toText(target?.pageType) === "codespace"
    && /^https:\/\/(?:insiders\.)?vscode\.dev\/tunnel\//i.test(toText(target?.url));
}

function friendlyPageContext(pageContext, pageType, url = "") {
  if (pageType === "codespace" && isTunnelEditorPage({ pageType, url })) return "Tu editor en la nube";
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
    const where = isTunnelEditorPage(context) ? "tu editor en la nube" : "Codespaces";
    return `Estas programando en ${where}. Empezaremos con ${goal.label.toLowerCase()} dentro de un cuadro flotante que se queda contigo en la pagina.`;
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
    return `${isTunnelEditorPage(context) ? "Editor en la nube" : "Codespace"} detectado. La ayuda se enfoca en el archivo abierto y el siguiente paso.`;
  }
  if (context.pageType === "github_code") {
    return "Archivo de GitHub detectado. La ayuda se enfoca en el codigo abierto.";
  }
  if (context.pageType === "github_general") {
    return "Repositorio detectado. Abre un archivo si quieres una pista mas concreta.";
  }
  return "Abre una actividad del piloto o un archivo para recibir ayuda mas contextual.";
}

// vscode.dev/tunnel/<nombre>/...: la URL del editor no trae owner/repo. Es el repositorio del
// editor guardado en este navegador con el mismo tunel (el mas reciente).
function repoFromSavedTunnelEditorUrl(url) {
  const tunnelOf = (value) => toText(value).match(/^https:\/\/(?:insiders\.)?vscode\.dev\/tunnel\/([^/?#]+)/i)?.[1]?.toLowerCase() || "";
  const tunnel = tunnelOf(url);
  const userId = getCurrentUserId();
  if (!tunnel || !userId) return "";
  const prefix = `${userId}:`;
  const record = Object.entries(overlayState.editorByUser || {})
    .filter(([key, item]) => key.startsWith(prefix) && tunnelOf(item?.webUrl) === tunnel)
    .map(([, item]) => item)
    .sort((a, b) => toText(b?.savedAt).localeCompare(toText(a?.savedAt)))[0];
  return parseRepoFullName(record?.repoFullName);
}

function inferRepoFromContext(context) {
  if (context && isTunnelEditorPage(context)) {
    const fromSavedEditor = repoFromSavedTunnelEditorUrl(context.url);
    if (fromSavedEditor) return fromSavedEditor;
  }
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

function isCodespaceTutorContext(contextOverride = null) {
  const context = contextOverride || overlayState.context || buildPayload();
  return toText(context?.pageType) === "codespace";
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

// Proveedor "tunnel": el tour no usa la GitHub App (acceso simplificado, seccion 4).
function isTunnelSetupFlow() {
  return typeof isTunnelProvider === "function" && isTunnelProvider();
}

function hasCompletedSetup(contextOverride = null) {
  if (isCodespaceTutorContext(contextOverride)) {
    return true;
  }

  if (hasBootstrapDetectedInTour()) {
    return true;
  }

  // Tunel: un editor ya guardado para este usuario y repo es un setup completo.
  if (isTunnelSetupFlow() && typeof getSavedTunnelEditor === "function" && getSavedTunnelEditor()) {
    return true;
  }

  const userId = getCurrentUserId();
  const key = getSetupCompletionKey();
  if (!userId || !key) return false;
  return overlayState.setupDoneByUser[key] === true || overlayState.setupDoneByUser[userId] === true;
}

async function markSetupCompleted(repoOverride = "") {
  const key = getSetupCompletionKey(repoOverride);
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
  // "Tiene lo necesario para abrir el editor": con Codespaces es el scope
  // codespace; con el tunel basta la cuenta conectada (el tunel se registra
  // con un codigo de dispositivo, no con el token).
  const tunnelProvider = typeof isTunnelProvider === "function" && isTunnelProvider();
  const userHasCodespaceScope = userConnected && (githubUserStatus.hasCodespaceScope === true || tunnelProvider);
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

// El paso sale del estado, no de botones que solo cambian de tarjeta (auditoria de
// redundancias, item 2): con el tunel siempre el 1 (el repositorio; conectar GitHub y preparar
// el editor van en la accion recomendada); con Codespaces, 1 sin repositorio, 2 hasta que la
// GitHub App tenga acceso al repo y 3 (cuenta de GitHub, PR y Codespace) despues.
function resolveCurrentSetupStep(flow) {
  let step = 3;
  if (isTunnelSetupFlow() || !flow.repoReady) {
    step = 1;
  } else if (!BYPASS_GITHUB_APP_INSTALL_VALIDATION && !flow.accessVerified) {
    step = 2;
  }

  overlayState.setupWizardStep = step;
  return step;
}

// Codespaces: tras abrir la instalacion de la GitHub App, ADACEEN consulta su estado solo
// (github.service.js, contrato (d)).
function isWaitingGithubAppInstall() {
  return typeof isWatchingGithubAppInstall === "function" && isWatchingGithubAppInstall();
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
  return `${account}. Aun no se pudo confirmar el acceso a ${repoFullName}.`;
}

function buildSetupStatusText(context, currentStep, flow) {
  const modeLabel = context?.pageType === "codespace"
    ? "Codespaces"
    : context?.pageType === "github_code" || context?.pageType === "github_general"
      ? "GitHub"
      : "fuera de GitHub";

  if (isTunnelSetupFlow()) {
    if (!flow.repoReady) {
      return "Abre tu repositorio en GitHub o escribe owner/repo para preparar tu editor en la nube.";
    }
    if (!flow.userOAuthConfigured) {
      return "El backend aun no tiene GitHub OAuth configurado. Avisa al docente.";
    }
    if (!flow.userConnected) {
      return `Un solo paso: conecta tu cuenta de GitHub. Al volver, ADACEEN preparara tu editor en la nube para ${flow.repoFullName} y lo abrira.`;
    }
    return `GitHub conectado. ADACEEN preparara tu editor en la nube para ${flow.repoFullName} y lo abrira. La primera vez GitHub te pedira un codigo de un solo uso.`;
  }

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
    if (isWaitingGithubAppInstall()) {
      return `Paso 2/3: termina la instalacion de la GitHub App en la pestana de GitHub. ADACEEN la detecta sola y sigue aqui.`;
    }
    if (!flow.appConnected) {
      return `Paso 2/3: instala o autoriza la GitHub App en ${flow.repoFullName}. Esto permite crear el PR de configuracion.`;
    }
    if (!flow.accessVerified) {
      return `Paso 2/3: la GitHub App esta instalada, pero aun no tiene acceso a ${flow.repoFullName}.`;
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

  if (typeof isTunnelProvider === "function" && isTunnelProvider()) {
    return `Paso 3/3 final: ADACEEN preparara tu editor en la nube (VS Code en el navegador) y lo abrira. La primera vez GitHub te pedira un codigo de un solo uso.`;
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
      title: isTunnelEditorPage(context) ? "Editor en la nube detectado" : "Codespace detectado",
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

  const tunnelProvider = isTunnelSetupFlow();
  // Con el tunel el editor en la nube clona el repo sin la GitHub App: su fila no se muestra.
  let githubAppStatus = "";
  let githubAppKind = "idle";
  if (githubContext && !tunnelProvider) {
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

  let githubUserStatusLabel = "";
  let githubUserKind = "idle";
  if (githubContext) {
    if (!githubUserStatus.configured) {
      githubUserStatusLabel = "OAuth pendiente";
      githubUserKind = "warn";
    } else if (!githubUserStatus.connected) {
      githubUserStatusLabel = "Conectar cuenta";
      githubUserKind = "warn";
    } else if (!flow.userHasCodespaceScope) {
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

  if (tunnelProvider) {
    const savedEditor = typeof getSavedTunnelEditor === "function" ? getSavedTunnelEditor() : null;
    if (codespaceDetected) {
      codespaceStatus = "Abierto";
      codespaceKind = "ok";
    } else if (savedEditor) {
      codespaceStatus = "Listo";
      codespaceKind = "ok";
    } else if (githubContext && flow.userConnected) {
      codespaceStatus = "Pendiente";
      codespaceKind = "warn";
    } else {
      codespaceStatus = "No iniciado";
      codespaceKind = "idle";
    }
  }

  // Solo filas que dicen algo util aqui: sin la GitHub App cuando no se usa (tunel o fuera de
  // GitHub), sin la cuenta de GitHub fuera de GitHub y sin Campus fuera de Campus.
  const items = [
    {
      label: "ADACEEN",
      status: hasActiveSession() ? "Conectado" : "No conectado",
      kind: hasActiveSession() ? "ok" : "warn",
    },
    githubContext && !tunnelProvider
      ? { label: "GitHub App", status: githubAppStatus, kind: githubAppKind }
      : null,
    githubContext
      ? { label: "GitHub OAuth", status: githubUserStatusLabel, kind: githubUserKind }
      : null,
    campusDetected
      ? { label: "Campus", status: campusCourseOpen ? "Curso abierto" : "Sin curso", kind: campusCourseOpen ? "ok" : "idle" }
      : null,
    {
      // "Codespaces" solo con ese proveedor confirmado; con el tunel o aun sin consultar
      // (paginas fuera de GitHub), el editor.
      label: overlayState.workspaceProvider === "codespaces" ? "Codespaces" : "Editor",
      status: codespaceStatus,
      kind: codespaceKind,
    },
  ].filter(Boolean);

  // VS Code (tunel, local o Codespace) publico contexto hace poco para este repo.
  const presence = overlayState.vscodePresence || EMPTY_VSCODE_PRESENCE;
  if (githubContext
    && !codespaceDetected
    && presence.connected
    && repoFullName
    && parseRepoFullName(presence.repoFullName).toLowerCase() === repoFullName.toLowerCase()) {
    items.push({ label: "VS Code", status: "Conectado", kind: "ok" });
  }
  return items;
}

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
  return {
    title: saved ? "Tu editor" : "Preparar tu editor",
    copy: saved
      ? `Tu editor en la nube para ${flow.repoFullName} esta guardado. Si la VM estaba apagada, ADACEEN espera a que encienda.`
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

  // El docente no prepara un editor en la nube ni abre Codespaces desde el repositorio de un
  // estudiante (auditoria, item 8): en GitHub y en paginas sin contexto su accion es la tuerca,
  // con el quiz de la clase, la politica del tutor y el piloto. Con un repositorio conserva
  // "Abrir en VS Code de este equipo", su forma de conectar VS Code (guia, 4.2). En Campus y
  // en el editor sigue la accion de esa pagina.
  if (isTeacherSession() && pageContext !== "campus" && pageType !== "codespace") {
    return {
      title: "Panel docente",
      copy: repoFullName
        ? `En Configuracion lanzas el quiz de la clase, ajustas la politica del tutor y diriges el piloto. Para conectar tu VS Code, abre ${repoFullName} en el VS Code de este equipo.`
        : "En Configuracion lanzas el quiz de la clase, ajustas la politica del tutor y diriges el piloto. Cada estudiante prepara su editor con su propia cuenta.",
      primary: { label: "Configuracion", action: "open_settings" },
      secondary: repoFullName
        ? { label: "Abrir en VS Code de este equipo", action: "open_local_vscode" }
        : null,
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
    // Campus (auditoria de redundancias, item 10): el acceso al curso y la bitacora se verifican
    // solos al entrar (verifyCampusCourseAccessOnEntry); "Verificar acceso" solo aparece para
    // reintentar tras un fallo o cuando falta la bitacora, y siempre una sola accion.
    const busy = !!overlayState.analysisBusy;
    const verifying = typeof isCampusAccessVerificationInFlight === "function" && isCampusAccessVerificationInFlight();
    if (access.checking || (!access.checked && verifying)) {
      return {
        title: "Confirmando curso",
        copy: `Verificando el acceso y la bitacora de ${courseCode}...`,
        primary: { label: "Verificando...", action: "verify_campus_course_access", disabled: true },
        secondary: null,
      };
    }
    if (!access.checked || !access.accessConfirmed) {
      // Otra forma de arreglarlo, no el mismo boton dos veces: el docente carga la bitacora y el
      // estudiante con varios cursos elige otro.
      const otherFix = isTeacherSession()
        ? { label: "Bitacora", action: "open_teacher_bitacora", disabled: busy }
        : (typeof getStudentAssignedCourseCodes === "function" && getStudentAssignedCourseCodes().length > 1
          ? { label: "Elegir curso", action: "choose_student_course", disabled: busy }
          : null);
      return {
        title: "Confirmar acceso",
        copy: !access.checked
          ? `Confirma el acceso a ${courseCode} y su bitacora antes de analizar Campus.`
          : access.error || `ADACEEN no pudo confirmar el acceso a ${courseCode} ni su bitacora. Vuelve a intentarlo.`,
        primary: { label: "Verificar acceso", action: "verify_campus_course_access", disabled: busy },
        secondary: otherFix,
      };
    }
    if (!access.bitacoraLoaded) {
      return {
        title: "Bitacora requerida",
        copy: isTeacherSession()
          ? `Acceso confirmado para ${courseCode}, pero falta cargar la bitacora/agenda antes de analizar la pagina.`
          : `Acceso confirmado para ${courseCode}, pero tu docente aun no carga la bitacora del curso. Cuando la cargue, pulsa Verificar acceso.`,
        primary: isTeacherSession()
          ? { label: "Abrir bitacora", action: "open_teacher_bitacora", disabled: busy }
          : { label: "Verificar acceso", action: "verify_campus_course_access", disabled: busy },
        secondary: null,
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

    // Una accion: "Analizar Campus" y, con eventos con fecha, "Sincronizar agenda". Los
    // botones de la cabecera del resumen ya no la repiten en Campus (content-render.js).
    return {
      title: "Agenda Campus",
      copy: calendarEventCount
        ? `Actividad detectada: ${activity}. Hay ${calendarEventCount} evento(s) listo(s) para guardar en Google Calendar.`
        : stats.taskCount
          ? `Actividad detectada: ${activity}. Hay ${stats.taskCount} tarea(s) y ${stats.deadlineCount || 0} fecha(s) visibles para sincronizar.`
        : `Bitacora y acceso confirmados para ${courseCode}. Analiza el HTML visible del curso y luego sincroniza Calendar cuando estes listo.`,
      primary: {
        label: analysis && calendarEventCount ? "Sincronizar agenda" : "Analizar Campus",
        action: analysis && calendarEventCount ? "sync_campus_calendar" : "analyze_project",
        disabled: busy,
      },
      secondary: null,
    };
  }

  if (pageType === "codespace") {
    // En el editor (vscode.dev con el tunel o un Codespace). Con el proyecto ya leido, pedir
    // ayuda es "Actualizar" de la cabecera (Ctrl+Enter): la accion recomendada ya no lo repite
    // con "Solicitar tutoria", ni "Reintentar OCR" repite "OCR visual" de la cabecera.
    const tunnelEditor = isTunnelEditorPage(context);
    if (overlayState.analysisUnlocked) {
      const askHint = overlayState.assistantEnabled
        ? "Pulsa Actualizar (Ctrl+Enter) para pedir una guia contextual."
        : "El tutor esta pausado: reactivalo en Configuracion para pedir una guia.";
      return {
        title: tunnelEditor ? "Tutor en tu editor" : "Tutor en Codespaces",
        copy: repoFullName
          ? `Proyecto activo: ${repoFullName}. ${askHint}`
          : `${tunnelEditor ? "Editor en la nube" : "Codespace"} detectado. ${askHint}`,
        primary: null,
        secondary: null,
      };
    }
    return {
      title: tunnelEditor ? "Tutor en tu editor" : "Tutor en Codespaces",
      copy: repoFullName
        ? `Proyecto activo: ${repoFullName}. El siguiente paso es leer el ${tunnelEditor ? "proyecto" : "workspace"} o pedir una guia contextual.`
        : tunnelEditor
          ? "Editor en la nube detectado. Selecciona codigo o pide una guia contextual."
          : "Codespace detectado. Falta confirmar el repositorio para coordinar el worker.",
      primary: { label: "Analizar proyecto", action: "analyze_project" },
      secondary: null,
    };
  }

  if (isTunnelSetupFlow() && (pageType === "github_code" || pageType === "github_general")) {
    const saved = typeof getSavedTunnelEditor === "function" ? getSavedTunnelEditor() : null;
    const cloudButton = {
      label: myEditorButtonLabel(),
      action: "open_my_editor",
      disabled: !repoFullName || !!overlayState.githubAppBusy,
    };
    const localButton = { label: "Abrir en VS Code de este equipo", action: "open_local_vscode", disabled: !repoFullName };
    // En la Mac del laboratorio, quien uso VS Code de este equipo la ultima vez lo tiene como
    // accion principal; el editor en la nube queda de segundo boton.
    const prefersLocal = typeof getLastEditorChoice === "function" && getLastEditorChoice() === "local_vscode";
    if (prefersLocal) {
      // La eleccion se guarda por usuario, no por repositorio: el texto no afirma que este
      // repositorio ya se abrio ahi, y solo menciona el editor en la nube si existe.
      return {
        title: "Tu VS Code",
        copy: !repoFullName
          ? "Repositorio GitHub detectado. Actualiza contexto para confirmar el owner/repo."
          : `La ultima vez usaste el VS Code de este equipo: abre ${repoFullName} ahi con un clic. `
            + (saved
              ? "Tambien tienes tu editor en la nube."
              : `Si prefieres el editor en la nube, pulsa ${cloudButton.label}.`),
        primary: localButton,
        secondary: cloudButton,
      };
    }
    return {
      title: saved ? "Tu editor" : "Preparar tu editor",
      copy: !repoFullName
        ? "Repositorio GitHub detectado. Actualiza contexto para confirmar el owner/repo."
        : saved
          ? `Tu editor en la nube para ${repoFullName} esta guardado: abrelo con un clic. Tambien puedes usar el VS Code instalado en este equipo.`
          : `ADACEEN preparara tu editor en la nube para ${repoFullName} y lo abrira. Tambien puedes usar el VS Code instalado en este equipo (por ejemplo, en las Mac del laboratorio).`,
      primary: cloudButton,
      secondary: localButton,
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
        ? `GitHub conectado para ${repoFullName}. Puedes abrirlo en la nube o en el VS Code instalado en este equipo (por ejemplo, en las Mac del laboratorio).`
        : "Repositorio GitHub detectado. Actualiza contexto para confirmar el owner/repo.",
      primary: { label: "Abrir Codespaces", action: "open_codespaces", disabled: !repoFullName },
      // VS Code instalado en este equipo: clona el repositorio y copia la sesion.
      secondary: { label: "Abrir en VS Code de este equipo", action: "open_local_vscode", disabled: !repoFullName },
    };
  }

  // Volver otro dia desde una pagina sin repositorio: el ultimo editor guardado, a un clic.
  const latestSaved = typeof getLatestSavedTunnelEditor === "function" ? getLatestSavedTunnelEditor() : null;
  if (latestSaved && pageType !== "codespace" && overlayState.workspaceProvider !== "codespaces") {
    // Sin "Actualizar contexto": era el mismo "Actualizar" de la cabecera.
    return {
      title: "Tu editor",
      copy: `Tu ultimo editor en la nube es ${latestSaved.repoFullName}. Abrelo con un clic; si la VM estaba apagada, ADACEEN espera a que encienda.`,
      primary: { label: "Abrir mi editor", action: "open_my_editor", disabled: !!overlayState.githubAppBusy },
      secondary: null,
    };
  }

  // Sin boton: "Actualizar" de la cabecera hace lo mismo. Con el tutor pausado ese boton esta
  // deshabilitado, asi que la accion recomendada conserva "Actualizar contexto".
  if (!overlayState.assistantEnabled) {
    return {
      title: "Buscar contexto",
      copy: "Abre Campus Virtual o tu repositorio en GitHub para activar acciones especificas. Luego pulsa Actualizar contexto.",
      primary: { label: "Actualizar contexto", action: "refresh_mentor" },
      secondary: null,
    };
  }
  return {
    title: "Buscar contexto",
    copy: "Abre Campus Virtual o tu repositorio en GitHub para activar acciones especificas. Luego pulsa Actualizar.",
    primary: null,
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
