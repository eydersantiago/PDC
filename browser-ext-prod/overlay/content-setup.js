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

function hasActiveSession() {
  return !!overlayState.session?.user;
}

function isTeacherSession() {
  return overlayState.session?.user?.role === "teacher";
}

function isAdminSession() {
  return overlayState.session?.user?.role === "admin";
}

// Entorno de los estudiantes (0.7.19): lo eligen el administrador y el docente en la tuerca.
function canChooseWorkspaceProvider() {
  return isAdminSession() || isTeacherSession();
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

// Listeners de la vista de preparacion del repositorio (movidos desde ensureOverlay, en el mismo orden).
function bindSetupView() {
  overlayEls.setupPrimaryActionBtn.addEventListener("click", async () => {
    await runRecommendedContextAction(overlayEls.setupPrimaryActionBtn.dataset.contextAction);
  });
  overlayEls.setupSecondaryActionBtn.addEventListener("click", async () => {
    await runRecommendedContextAction(overlayEls.setupSecondaryActionBtn.dataset.contextAction);
  });
  overlayEls.setupRepoInput.addEventListener("input", () => {
    setSetupRepoFullName(overlayEls.setupRepoInput.value);
    overlayState.setupWizardStep = 1;
    clearSetupForCurrentUser();
    persistPreferences().catch(() => {});
    renderOverlay();
  });
  overlayEls.setupDetectRepoBtn.addEventListener("click", async () => {
    overlayState.context = buildPayload();
    const detected = inferRepoFromContext(overlayState.context);
    if (detected) {
      setSetupRepoFullName(detected);
      overlayState.setupWizardStep = 1;
      clearSetupForCurrentUser();
      persistPreferences().catch(() => {});
      overlayState.statusMessage = `Repositorio detectado: ${detected}`;
    } else {
      overlayState.statusMessage = "No se pudo detectar owner/repo automaticamente. Pegalo en el campo.";
    }
    try {
      await refreshGithubIntegrationStatus();
    } catch {}
    renderOverlay();
  });
  // VS Code instalado en este equipo: no hace falta la GitHub App ni el editor en la nube.
  overlayEls.setupOpenLocalVscodeBtn?.addEventListener("click", async () => {
    noteOverlayInteractionAfterAutoEnter();
    if (await openLocalVscodeClone()) {
      await markSetupCompleted();
      renderOverlay();
    }
  });
}
