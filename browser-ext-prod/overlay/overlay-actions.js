// ADACEEN | Capa 5 - Ciclo de vida: acciones recomendadas del hub (detectar repo, GitHub, Codespaces, Campus, admin).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

async function detectRepoFromActivePage() {
  overlayState.context = buildPayload();
  const detected = inferRepoFromContext(overlayState.context);
  if (detected) {
    setSetupRepoFullName(detected);
    overlayState.setupWizardStep = 1;
    clearSetupForCurrentUser();
    await persistPreferences();
    overlayState.statusMessage = `Repositorio detectado: ${detected}`;
    try {
      await refreshGithubIntegrationStatus();
    } catch {}
  } else {
    overlayState.statusMessage = "No se pudo detectar owner/repo automaticamente. Pegalo en el campo.";
  }
  renderOverlay();
}

async function refreshGithubStatusFromRecommendedAction() {
  const flow = getSetupFlowState(getPageContext());
  if (!flow.repoReady) {
    overlayState.statusMessage = "Primero confirma el repositorio que vamos a preparar.";
    renderOverlay();
    return;
  }
  if (!flow.configured) {
    overlayState.statusMessage = "El backend aun no tiene GitHub App configurada.";
    renderOverlay();
    return;
  }

  overlayState.githubAppBusy = true;
  overlayState.statusMessage = "Verificando conexion y permisos de GitHub...";
  renderOverlay();

  try {
    await refreshGithubIntegrationStatus();
    const afterRefresh = getSetupFlowState(getPageContext());
    if (!afterRefresh.appConnected && afterRefresh.configured && afterRefresh.repoReady) {
      const linked = await autoLinkGithubInstallation(afterRefresh.repoFullName);
      if (linked) {
        await refreshGithubIntegrationStatus();
      }
    }

    if (!hasBootstrapDetectedInTour()) {
      hydrateBootstrapSignalsFromCodespaceExplorer();
    }

    const finalFlow = getSetupFlowState(getPageContext());
    if ((hasCompletedSetup() || finalFlow.prCreated) && shouldPrepareCodespaceBeforeDashboard(finalFlow)) {
      overlayState.setupWizardStep = 3;
      overlayState.statusMessage = "Entorno detectado. Creando o reanudando Codespace antes de entrar.";
      renderOverlay();
      await bootstrapDevcontainerWithGithubApp();
      return;
    }

    if (hasCompletedSetup() || finalFlow.prCreated) {
      await markSetupCompleted();
      overlayState.statusMessage = "Entorno verificado. Entrando al dashboard principal.";
      await refreshMentorSession();
      return;
    }

    if (finalFlow.accessVerified) {
      overlayState.setupWizardStep = 3;
      overlayState.statusMessage = finalFlow.userHasCodespaceScope
        ? "GitHub conectado. Ya puedes preparar el entorno ADACEEN."
        : "GitHub App lista. Falta conectar tu cuenta GitHub para crear el Codespace.";
    } else if (finalFlow.appConnected) {
      overlayState.setupWizardStep = 2;
      overlayState.statusMessage = "GitHub conectado, pero falta acceso al repositorio confirmado.";
    } else {
      overlayState.setupWizardStep = 2;
      overlayState.statusMessage = "No se detecto una instalacion vinculada para este repositorio.";
    }
  } catch (error) {
    overlayState.statusMessage = `No se pudo actualizar GitHub: ${String(error)}`;
  } finally {
    overlayState.githubAppBusy = false;
    renderOverlay();
  }
}

function openCampusCalendarDraft(options = {}) {
  const context = getPageContext();
  const deadline = toText(context.activityDeadline);
  const analysis = options?.analysis || overlayState.campusAnalysis;

  window.open(buildCampusCalendarDraftUrl(context, analysis), "_blank", "noopener,noreferrer");
  if (!options?.preserveStatus) {
    const taskCount = Number(analysis?.stats?.taskCount) || 0;
    overlayState.statusMessage = taskCount
      ? `Se abrio un borrador en Google Calendar con ${taskCount} tarea(s) detectada(s).`
      : deadline
        ? "Se abrio un borrador en Google Calendar con la fecha detectada en detalles."
        : "Se abrio un borrador en Google Calendar; revisa la fecha antes de guardarlo.";
  }
  renderOverlay();
}

async function openCodespacesPage() {
  const repoFullName = getCurrentRepoFullName();
  if (!repoFullName) {
    overlayState.statusMessage = "No se detecta repositorio para abrir Codespaces.";
    renderOverlay();
    return;
  }

  const context = getPageContext();
  if (toText(context?.pageType) === "codespace") {
    await markSetupCompleted();
    overlayState.statusMessage = "Codespace detectado. Continuando sin reiniciar ni preparar otro entorno.";
    if (hasActiveSession()) {
      await refreshMentorSession();
    } else {
      renderOverlay();
    }
    return;
  }

  const pull = getLatestSetupPullResult();
  const storedCodespaceUrl = getStoredSetupCodespaceUrl();
  if (isDirectCodespaceUrl(storedCodespaceUrl)) {
    window.open(storedCodespaceUrl, "_blank", "noopener,noreferrer");
    overlayState.statusMessage = "Abriendo Codespace existente de la PR de preparacion ADACEEN.";
    renderOverlay();
    return;
  }

  const flow = getSetupFlowState(getPageContext());
  if (flow.accessVerified && flow.userHasCodespaceScope) {
    overlayState.statusMessage = isCodespaceQuickstartUrl(storedCodespaceUrl)
      ? "El enlace guardado es el selector de Codespaces. Creando o reanudando el Codespace automaticamente..."
      : "Preparando o reanudando el Codespace de la PR...";
    renderOverlay();
    await bootstrapDevcontainerWithGithubApp();
    return;
  }

  const codespaceUrl = storedCodespaceUrl
    || buildCodespaceQuickstartUrl(
      repoFullName,
      Number(overlayState.githubAppStatus?.bootstrapPullNumber || pull?.pullNumber) || 0,
      toText(overlayState.githubAppStatus?.bootstrapBranchName || pull?.branchName),
    );

  window.open(codespaceUrl, "_blank", "noopener,noreferrer");
  overlayState.statusMessage = pull?.pullNumber || overlayState.githubAppStatus?.bootstrapPullNumber
    ? "Abriendo Codespaces para la PR de preparacion ADACEEN."
    : `Abriendo Codespaces para ${repoFullName}.`;
  renderOverlay();
}

function openCodespacesManualPage() {
  const repoFullName = getCurrentRepoFullName();
  if (!repoFullName) {
    overlayState.statusMessage = "No se detecta repositorio para abrir Codespaces.";
    renderOverlay();
    return;
  }

  const pull = getLatestSetupPullResult();
  const storedCodespaceUrl = toText(pull?.codespaceUrl)
    || toText(overlayState.githubAppStatus?.bootstrapCodespaceUrl);
  const targetUrl = storedCodespaceUrl
    || buildCodespaceQuickstartUrl(
      repoFullName,
      Number(overlayState.githubAppStatus?.bootstrapPullNumber || pull?.pullNumber) || 0,
      toText(overlayState.githubAppStatus?.bootstrapBranchName || pull?.branchName),
    );

  window.open(targetUrl, "_blank", "noopener,noreferrer");
  overlayState.statusMessage = "Abriendo Codespaces manualmente sin volver a preparar el entorno.";
  renderOverlay();
}

async function reloadAdminUsersFromRecommendedAction() {
  if (!canManageUsersSession()) return;
  overlayState.adminUsersBusy = true;
  overlayState.adminUsersMessage = "Actualizando usuarios...";
  renderOverlay();
  try {
    await reloadAdminUsers();
    overlayState.adminUsersMessage = "Usuarios actualizados.";
  } catch (error) {
    overlayState.adminUsersMessage = `No se pudieron cargar usuarios: ${String(error)}`;
  } finally {
    overlayState.adminUsersBusy = false;
    renderOverlay();
  }
}

async function runRecommendedContextAction(action) {
  const normalized = toText(action);
  if (!normalized) return;

  switch (normalized) {
    case "detect_repo":
      await detectRepoFromActivePage();
      break;
    case "go_step_1":
      overlayState.setupWizardStep = 1;
      overlayState.statusMessage = "";
      renderOverlay();
      break;
    case "go_step_2":
      overlayState.setupWizardStep = 2;
      overlayState.statusMessage = "";
      renderOverlay();
      break;
    case "connect_github":
      overlayState.setupWizardStep = 2;
      await startGithubAppInstallFlow();
      break;
    case "connect_github_user":
      overlayState.setupWizardStep = 3;
      await startGithubUserOAuthFlow();
      break;
    case "refresh_github_status":
      await refreshGithubStatusFromRecommendedAction();
      break;
    case "create_bootstrap_pr":
      overlayState.setupWizardStep = 3;
      await bootstrapDevcontainerWithGithubApp();
      break;
    case "finish_setup":
      await refreshMentorSession();
      break;
    case "analyze_project":
      await analyzeCurrentContext();
      break;
    case "verify_campus_course_access":
      await verifyCampusCourseAccess();
      break;
    case "open_teacher_rag":
      await openTeacherRagPage();
      break;
    case "open_teacher_bitacora":
      await openTeacherBitacoraPage();
      break;
    case "choose_student_course":
      if (overlayState.session?.user?.role === "student") {
        await ensureStudentCourseSelection({ forceOpen: true });
      }
      break;
    case "sync_campus_calendar":
      await syncCampusCalendarToGoogle();
      break;
    case "open_campus_date_source":
      await openCampusDateSourceFromCurrentAnalysis();
      break;
    case "upload_teacher_bitacora":
      await openTeacherBitacoraPage();
      break;
    case "refresh_mentor":
      await refreshMentorSession();
      break;
    case "rerun_ocr":
      await rerunScreenshotOcrFromDashboard();
      break;
    case "open_calendar_draft":
      openCampusCalendarDraft();
      break;
    case "open_setup_pr": {
      const pull = getLatestSetupPullResult();
      const pullUrl = toText(pull?.pullUrl) || toText(overlayState.githubAppStatus?.bootstrapPullUrl);
      const pullNumber = Number(pull?.pullNumber || overlayState.githubAppStatus?.bootstrapPullNumber) || 0;
      if (pullUrl) {
        window.open(pullUrl, "_blank", "noopener,noreferrer");
        overlayState.statusMessage = `Abriendo PR #${pullNumber || "?"}.`;
      } else {
        overlayState.statusMessage = "No hay PR reciente guardado para esta sesion.";
      }
      renderOverlay();
      break;
    }
    case "open_codespaces":
      await openCodespacesPage();
      break;
    case "open_codespaces_manual":
      openCodespacesManualPage();
      break;
    case "open_settings":
      setSettingsOpen(true);
      renderOverlay();
      break;
    case "reload_admin_users":
      await reloadAdminUsersFromRecommendedAction();
      break;
    default:
      overlayState.statusMessage = "Accion no disponible para el contexto actual.";
      renderOverlay();
      break;
  }
}
