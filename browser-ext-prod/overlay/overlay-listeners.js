// ADACEEN | Capa 5 - Ciclo de vida: registro de los listeners del overlay sobre el mapa de elementos.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

/** Conecta los controles del shell con las acciones del overlay. */
function bindOverlayEventListeners() {
  overlayEls.closeBtn.addEventListener("click", async () => {
    await closeOverlay();
  });
  overlayEls.minimizeBtn.addEventListener("click", async () => {
    await setOverlayMinimized(true);
  });
  overlayEls.minimizedTabBtn.addEventListener("pointerdown", startMinimizedTabDrag);
  overlayEls.minimizedTabBtn.addEventListener("click", async (event) => {
    if (suppressNextMinimizedTabClick) {
      event.preventDefault();
      event.stopPropagation();
      suppressNextMinimizedTabClick = false;
      return;
    }
    await setOverlayMinimized(false);
  });
  overlayEls.settingsBtn.addEventListener("click", () => {
    setSettingsOpen(!overlayState.settingsOpen);
  });
  overlayEls.settingsCloseBtn.addEventListener("click", () => {
    setSettingsOpen(false);
  });
  overlayEls.startBtn.addEventListener("click", async () => {
    await startExperience();
  });
  overlayEls.authSubmitBtn.addEventListener("click", async () => {
    await submitLoginFromOverlay();
  });
  overlayEls.googleAuthBtn.addEventListener("click", async () => {
    await submitGoogleLoginFromOverlay();
  });
  overlayEls.authBackBtn.addEventListener("click", () => {
    overlayState.started = false;
    overlayState.authError = "";
    renderOverlay();
  });
  overlayEls.setupPrimaryActionBtn.addEventListener("click", async () => {
    await runRecommendedContextAction(overlayEls.setupPrimaryActionBtn.dataset.contextAction);
  });
  overlayEls.setupSecondaryActionBtn.addEventListener("click", async () => {
    await runRecommendedContextAction(overlayEls.setupSecondaryActionBtn.dataset.contextAction);
  });
  overlayEls.contextPrimaryActionBtn.addEventListener("click", async () => {
    await runRecommendedContextAction(overlayEls.contextPrimaryActionBtn.dataset.contextAction);
  });
  overlayEls.contextSecondaryActionBtn.addEventListener("click", async () => {
    await runRecommendedContextAction(overlayEls.contextSecondaryActionBtn.dataset.contextAction);
  });
  overlayEls.firstLoginConfirmBtn.addEventListener("click", async () => {
    await markPrivacyAcceptedForCurrentSession();
    renderOverlay();
  });
  overlayEls.firstLoginLogoutBtn.addEventListener("click", async () => {
    await logoutAndReturnToLogin();
  });
  overlayEls.studentCourseConfirmBtn?.addEventListener("click", async () => {
    await confirmStudentCourseSelection();
  });
  overlayEls.studentCourseLogoutBtn?.addEventListener("click", async () => {
    if (overlayEls.studentCourseLogoutBtn.dataset.courseModalAction === "cancel") {
      overlayState.studentCourseModalOpen = false;
      renderOverlay();
      return;
    }
    await logoutAndReturnToLogin();
  });
  overlayEls.processNoticeConfirmBtn.addEventListener("click", () => {
    overlayState.processNoticeOpen = false;
    renderOverlay();
  });
  overlayEls.tabConflictRefreshBtn?.addEventListener("click", async () => {
    if (!overlayEls.tabConflictRefreshBtn) return;
    overlayState.loading = true;
    renderOverlay();
    await refreshActiveTabStateFromBackend({ force: true }).catch(() => {});
    overlayState.loading = false;
    renderOverlay();
  });
  overlayEls.setupRepoInput.addEventListener("input", () => {
    setSetupRepoFullName(overlayEls.setupRepoInput.value);
    overlayState.setupWizardStep = 1;
    clearSetupForCurrentUser();
    persistPreferences().catch(() => {});
    renderOverlay();
  });
  overlayEls.setupExploreBtn.addEventListener("click", async () => {
    await analyzeCodespaceProject();
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
  overlayEls.setupToStep2Btn.addEventListener("click", () => {
    const flow = getSetupFlowState(getPageContext());
    if (!flow.repoReady) {
      overlayState.statusMessage = "Confirma el repositorio que vamos a preparar antes de autorizar la GitHub App.";
      renderOverlay();
      return;
    }
    overlayState.setupWizardStep = 2;
    overlayState.statusMessage = "";
    renderOverlay();
  });
  overlayEls.setupInstallAppBtn.addEventListener("click", async () => {
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
    await startGithubAppInstallFlow();
  });
  overlayEls.setupRefreshAppBtn.addEventListener("click", async () => {
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
    overlayState.statusMessage = "Verificando que la GitHub App tenga acceso al repositorio confirmado...";
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
        overlayState.statusMessage = "Configuracion detectada. Creando o reanudando Codespace antes de entrar.";
        renderOverlay();
        await bootstrapDevcontainerWithGithubApp();
        return;
      }

      if (hasCompletedSetup() || finalFlow.prCreated) {
        await markSetupCompleted();
        overlayState.statusMessage = "Acceso verificado. Este repo ya tenia configuracion ADACEEN aplicada; entrando al dashboard.";
        await refreshMentorSession();
        return;
      } else if (finalFlow.accessVerified) {
        overlayState.statusMessage = finalFlow.userHasCodespaceScope
          ? "Acceso verificado. Ya puedes preparar PR y Codespace."
          : "Acceso verificado. Conecta tu cuenta GitHub para crear el Codespace.";
      } else if (finalFlow.appConnected) {
        overlayState.statusMessage = "App conectada, pero falta acceso al repositorio confirmado.";
      } else {
        overlayState.statusMessage = "No se detecto una instalacion vinculada para este repositorio.";
      }
    } catch (error) {
      overlayState.statusMessage = `No se pudo actualizar estado GitHub App: ${String(error)}`;
    } finally {
      overlayState.githubAppBusy = false;
      renderOverlay();
    }
  });
  overlayEls.setupBackToStep1Btn.addEventListener("click", () => {
    overlayState.setupWizardStep = 1;
    overlayState.statusMessage = "";
    renderOverlay();
  });
  overlayEls.setupToStep3Btn.addEventListener("click", () => {
    const flow = getSetupFlowState(getPageContext());
    if (!BYPASS_GITHUB_APP_INSTALL_VALIDATION) {
      if (!flow.appConnected) {
        overlayState.statusMessage = "Primero autoriza la GitHub App para este repositorio.";
        renderOverlay();
        return;
      }
      if (!flow.accessVerified) {
        overlayState.statusMessage = "Primero verifica que la app tenga acceso al repositorio.";
        renderOverlay();
        return;
      }
    }
    overlayState.setupWizardStep = 3;
    overlayState.statusMessage = "";
    renderOverlay();
  });
  overlayEls.setupCreatePrBtn.addEventListener("click", async () => {
    const flow = getSetupFlowState(getPageContext());
    if (!flow.repoReady) {
      overlayState.statusMessage = "Primero confirma el repositorio que vamos a preparar.";
      renderOverlay();
      return;
    }
    if (!BYPASS_GITHUB_APP_INSTALL_VALIDATION) {
      if (!flow.appConnected) {
        overlayState.statusMessage = "Primero autoriza la GitHub App en el Paso 2/3.";
        renderOverlay();
        return;
      }
      if (!flow.accessVerified) {
        overlayState.statusMessage = "Primero verifica el acceso de la GitHub App.";
        renderOverlay();
        return;
      }
    }
    if (!flow.userOAuthConfigured || !flow.userConnected || !flow.userHasCodespaceScope) {
      overlayState.statusMessage = "Primero conecta tu cuenta GitHub con permiso Codespaces para automatizar el Codespace.";
      renderOverlay();
      if (flow.userOAuthConfigured) {
        await startGithubUserOAuthFlow();
      }
      return;
    }
    await bootstrapDevcontainerWithGithubApp();
  });
  overlayEls.setupBackToStep2Btn.addEventListener("click", () => {
    overlayState.setupWizardStep = 2;
    overlayState.statusMessage = "";
    renderOverlay();
  });
  overlayEls.setupContinueBtn.addEventListener("click", async () => {
    if (!hasCompletedSetup()) {
      overlayState.statusMessage = "Completa primero la preparacion: autorizar la app y crear el PR de configuracion.";
      renderOverlay();
      return;
    }
    await refreshMentorSession();
  });
  overlayEls.setupLogoutBtn.addEventListener("click", async () => {
    await logoutAndReturnToLogin();
  });
  overlayEls.refreshBtn.addEventListener("click", async () => {
    await refreshMentorSession();
  });
  overlayEls.analyzeProjectBtn.addEventListener("click", async () => {
    await analyzeCurrentContext();
  });
  overlayEls.vscodeSyncRefreshBtn?.addEventListener("click", async () => {
    await refreshVscodeSyncState({ silent: false });
  });
  overlayEls.vscodeCopySessionBtn?.addEventListener("click", async () => {
    const value = toText(overlayState.sessionId);
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      overlayState.statusMessage = "Sesion copiada. En VS Code ejecuta ADACEEN: Configurar sesion y pegala.";
    } catch {
      overlayState.statusMessage = `Sesion ADACEEN: ${value}`;
    }
    renderOverlay();
  });
  overlayEls.vscodeInlineActions?.addEventListener("click", async (event) => {
    const button = event.target?.closest?.("[data-vscode-inline-replacement-index]");
    if (!button) return;
    const index = Number(button.getAttribute("data-vscode-inline-replacement-index"));
    await sendVscodeReplacementOptionByIndex(index, "inline_code_palette");
  });
  overlayEls.vscodeSyncDragHandle?.addEventListener("pointerdown", startVscodeSyncOverlayDrag);
  overlayEls.teacherBitacoraUploadBtn?.addEventListener("click", async () => {
    await openTeacherBitacoraPage();
  });
  overlayEls.teacherRagManageBtn?.addEventListener("click", async () => {
    await openTeacherRagPage();
  });
  overlayEls.teacherBitacoraCloseBtn?.addEventListener("click", () => {
    closeTeacherBitacoraPage();
  });
  overlayEls.teacherRagCloseBtn?.addEventListener("click", () => {
    closeTeacherRagPage();
  });
  overlayEls.teacherRagCourseSelect?.addEventListener("change", async () => {
    await selectTeacherRagCourse(overlayEls.teacherRagCourseSelect.value);
  });
  overlayEls.teacherRagUploadBtn?.addEventListener("click", () => {
    openTeacherRagFilePicker();
  });
  overlayEls.teacherRagRefreshBtn?.addEventListener("click", async () => {
    await refreshTeacherRagSources();
  });
  overlayEls.teacherRagSourceList?.addEventListener("click", async (event) => {
    const button = event.target?.closest?.("[data-rag-delete-id]");
    if (!button) return;
    await deleteTeacherRagSource(button.getAttribute("data-rag-delete-id"));
  });
  overlayEls.teacherBitacoraDownloadTemplateBtn?.addEventListener("click", async () => {
    await downloadTeacherBitacoraTemplate();
  });
  overlayEls.teacherBitacoraChooseFileBtn?.addEventListener("click", () => {
    openTeacherBitacoraFilePicker();
  });
  overlayEls.teacherBitacoraManualSaveBtn?.addEventListener("click", async () => {
    await saveTeacherBitacoraManualEntry();
  });
  overlayEls.teacherBitacoraManualClearBtn?.addEventListener("click", () => {
    clearTeacherBitacoraManualForm();
  });
  overlayEls.teacherBitacoraDeleteLatestBtn?.addEventListener("click", async () => {
    await deleteTeacherBitacoraLatest();
  });
  overlayEls.teacherBitacoraClearDataBtn?.addEventListener("click", async () => {
    await clearTeacherBitacoraData();
  });
  overlayEls.teacherBitacoraFileInput?.addEventListener("change", async () => {
    const file = overlayEls.teacherBitacoraFileInput.files?.[0] || null;
    overlayEls.teacherBitacoraFileInput.value = "";
    await uploadTeacherBitacoraFile(file);
  });
  overlayEls.teacherRagFileInput?.addEventListener("change", async () => {
    const file = overlayEls.teacherRagFileInput.files?.[0] || null;
    overlayEls.teacherRagFileInput.value = "";
    await uploadTeacherRagFile(file);
  });
  overlayEls.rerunOcrBtn.addEventListener("click", async () => {
    overlayState.context = buildPayload();
    if (overlayState.context.pageContext === "campus") {
      await syncCampusCalendarToGoogle();
      return;
    }
    await rerunScreenshotOcrFromDashboard();
  });
  overlayEls.githubAppInstallBtn.addEventListener("click", async () => {
    await startGithubAppInstallFlow();
  });
  overlayEls.githubAppRefreshBtn.addEventListener("click", async () => {
    overlayState.githubAppBusy = true;
    renderOverlay();
    try {
      await refreshGithubIntegrationStatus();
      overlayState.statusMessage = "Estado de GitHub App y OAuth actualizado.";
    } catch (error) {
      overlayState.statusMessage = `No se pudo actualizar estado GitHub: ${String(error)}`;
    } finally {
      overlayState.githubAppBusy = false;
      renderOverlay();
    }
  });
  overlayEls.githubAppBootstrapBtn.addEventListener("click", async () => {
    await bootstrapDevcontainerWithGithubApp({ force: true });
  });
  overlayEls.projectContextRefreshBtn.addEventListener("click", async () => {
    await refreshProjectContextPanel();
  });
  overlayEls.projectContextHistoryRefreshBtn.addEventListener("click", async () => {
    await refreshProjectContextPanel();
  });
  overlayEls.adminToggleCreateUserBtn.addEventListener("click", () => {
    if (!canManageUsersSession() || overlayState.adminUsersBusy) return;
    overlayState.adminCreateFormOpen = !overlayState.adminCreateFormOpen;
    renderOverlay();
  });
  overlayEls.adminCreateRole.addEventListener("change", () => {
    renderAdminUsersTable();
  });
  overlayEls.adminReloadUsersBtn.addEventListener("click", async () => {
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
  });
  overlayEls.adminCreateBtn.addEventListener("click", async () => {
    if (!canManageUsersSession()) return;
    overlayState.adminUsersBusy = true;
    overlayState.adminUsersMessage = "Creando usuario...";
    renderOverlay();
    try {
      await createAdminUserFromForm();
      overlayEls.adminCreateName.value = "";
      overlayEls.adminCreateEmail.value = "";
      overlayEls.adminCreatePassword.value = "";
      overlayEls.adminCreateTeacher.value = "";
      await reloadAdminUsers();
      overlayState.adminCreateFormOpen = false;
      overlayState.adminUsersMessage = "Usuario creado correctamente.";
    } catch (error) {
      overlayState.adminUsersMessage = `No se pudo crear usuario: ${String(error)}`;
    } finally {
      overlayState.adminUsersBusy = false;
      renderOverlay();
    }
  });
  overlayEls.analysisCloseBtn.addEventListener("click", () => {
    overlayState.analysisWindowOpen = false;
    renderOverlay();
  });
  overlayEls.logoutHeaderBtn.addEventListener("click", async () => {
    await logoutAndReturnToLogin();
  });
  overlayEls.reloadTelemetryBtn?.addEventListener("click", async () => {
    await reloadPolicyAndTelemetry();
    renderOverlay();
  });
  overlayEls.saveSettingsBtn.addEventListener("click", async () => {
    await saveSettingsFromOverlay();
  });
  overlayEls.logoutSettingsBtn.addEventListener("click", async () => {
    await logoutAndReturnToLogin();
    setSettingsOpen(false);
  });
  overlayEls.dragHandle.addEventListener("pointerdown", startDrag);
}
