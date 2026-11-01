// ADACEEN | Capa 4 - UI: «Inicio», lo que hace el botón de la acción recomendada (detectar el repositorio,
// verificar GitHub, borrador de la agenda). Movido sin cambios de content-home.js.

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
  const flow = getSetupFlowState(overlayState.context || buildPayload());
  if (!flow.repoReady) {
    overlayState.statusMessage = "Primero confirma el repositorio que vamos a preparar.";
    renderOverlay();
    return;
  }
  // Tunel: no hay GitHub App que verificar; solo la cuenta de GitHub y el editor guardado.
  if (typeof isTunnelProvider === "function" && isTunnelProvider()) {
    overlayState.githubAppBusy = true;
    overlayState.statusMessage = "Verificando tu cuenta de GitHub...";
    renderOverlay();
    try {
      await refreshGithubIntegrationStatus().catch(() => {});
      if (hasCompletedSetup()) {
        overlayState.statusMessage = "Tu editor ya estaba preparado. Entrando al dashboard.";
        await refreshMentorSession();
        return;
      }
      const tunnelFlow = getSetupFlowState(overlayState.context || buildPayload());
      overlayState.statusMessage = tunnelFlow.userConnected
        ? "GitHub conectado. Pulsa Preparar mi editor."
        : "Falta conectar tu cuenta de GitHub.";
    } finally {
      overlayState.githubAppBusy = false;
      renderOverlay();
    }
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
    const afterRefresh = getSetupFlowState(overlayState.context || buildPayload());
    if (!afterRefresh.appConnected && afterRefresh.configured && afterRefresh.repoReady) {
      const linked = await autoLinkGithubInstallation(afterRefresh.repoFullName);
      if (linked) {
        await refreshGithubIntegrationStatus();
      }
    }

    if (!hasBootstrapDetectedInTour()) {
      hydrateBootstrapSignalsFromCodespaceExplorer();
    }

    const finalFlow = getSetupFlowState(overlayState.context || buildPayload());
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
  const context = overlayState.context || buildPayload();
  const deadline = toText(context.activityDeadline);
  const analysis = options?.analysis || overlayState.campusAnalysis;

  openExternalUrlSafely(buildCampusCalendarDraftUrl(context, analysis));
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

async function runRecommendedContextAction(action) {
  const normalized = toText(action);
  if (!normalized) return;
  noteOverlayInteractionAfterAutoEnter();

  switch (normalized) {
    case "detect_repo":
      await detectRepoFromActivePage();
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
      setMainTab("rag", { byUser: true, forceRender: true });
      break;
    case "open_teacher_bitacora":
      openTeacherBitacoraTab();
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
      // «Subir bitácora» (0.7.16): la pestana «Bitacora» y el selector de archivo en el mismo clic.
      openTeacherBitacoraTab({ pickFile: true });
      break;
    case "refresh_mentor":
      await refreshMentorSession({ trigger: "manual", requestedAt: Date.now() });
      break;
    case "open_local_vscode":
      await openLocalVscodeClone();
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
        overlayState.statusMessage = openExternalUrlSafely(pullUrl)
          ? `Abriendo PR #${pullNumber || "?"}.`
          : "El enlace del PR no es valido (solo se abren enlaces http/https).";
      } else {
        overlayState.statusMessage = "No hay PR reciente guardado para esta sesion.";
      }
      renderOverlay();
      break;
    }
    case "open_codespaces":
      await openCodespacesPage();
      break;
    case "open_my_editor":
      // Con Codespaces el mismo boton sigue el flujo de siempre.
      if (overlayState.workspaceProvider === "codespaces") {
        await openCodespacesPage();
      } else {
        await openMyTunnelEditor();
      }
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
