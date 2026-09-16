// ADACEEN | Capa 2 - Contexto: estado del tour de configuracion (repositorio, GitHub App, OAuth y bootstrap detectado).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

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
  const context = getPageContext();
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
  const context = contextOverride || getPageContext();
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

function hasCompletedSetup(contextOverride = null) {
  if (isCodespaceTutorContext(contextOverride)) {
    return true;
  }

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
  if (!BYPASS_GITHUB_APP_INSTALL_VALIDATION && step > 2 && !flow.accessVerified) {
    step = 2;
  }

  overlayState.setupWizardStep = step;
  return step;
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
