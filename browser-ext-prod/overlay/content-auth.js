// ADACEEN | Capa 4 - UI: entrar y salir (bienvenida, login con correo o Google, primer ingreso y «Salir»).
// Movido sin cambios desde content-render.js (startExperience, login, logout) y desde content-lifecycle.js
// (listeners de esas vistas, ahora en bindAuthControls, llamada desde ensureOverlay).
// Sin "use strict": el codigo viene de archivos en modo no estricto y se conserva igual.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

// options.skipModelRequests: entrada automatica con un editor guardado (content-lifecycle.js).
async function startExperience(options = {}) {
  overlayState.started = true;
  overlayState.authError = "";

  if (!overlayState.session && overlayState.sessionId) {
    try {
      const restored = await fetchCurrentSession();
      if (!restored) {
        overlayState.sessionId = "";
        overlayState.session = null;
        await persistPreferences();
      }
    } catch {
      overlayState.sessionId = "";
      overlayState.session = null;
      await persistPreferences();
    }
  }

  if (hasActiveSession()) {
    // options.quietActiveTabConflict: overlay restaurado al cargar la pagina. Si otra pestana
    // tiene la sesion activa, se queda en la bienvenida sin el aviso de conflicto.
    const quietConflict = options?.quietActiveTabConflict === true;
    const hasForeignActiveTab = await (quietConflict
      ? probeForeignActiveTab()
      : refreshActiveTabStateFromBackend({ force: true }))
      .catch(() => false);

    if (hasForeignActiveTab) {
      overlayState.started = false;
      overlayState.loading = false;
      overlayState.analysisUnlocked = false;
      overlayState.analysisWindowOpen = false;
      if (!quietConflict) overlayState.statusMessage = "Esta sesión ya está activa en otra pestaña.";
      renderOverlay();
      return;
    }

    await refreshMentorSession({ skipModelRequests: options?.skipModelRequests === true });
    queueActiveTabReport(true);
  } else {
    renderOverlay();
  }
}

async function submitLoginFromOverlay() {
  overlayState.authBusy = true;
  overlayState.authError = "";
  renderOverlay();

  try {
    const email = overlayEls.authEmail.value.trim();
    const password = overlayEls.authPassword.value;
    await loginToBackend(email, password);
    await ensureStudentCourseSelection({ forceOpen: overlayState.session?.user?.role === "student" });
    if (overlayState.studentCourseModalOpen) {
      overlayState.statusMessage = "Escoge el curso activo para cargar sus fuentes RAG.";
      return;
    }
    await refreshMentorSession();
    setWelcomeStatusForCurrentUser();
  } catch (error) {
    overlayState.authError = String(error);
    renderOverlay();
  } finally {
    overlayState.authBusy = false;
    renderOverlay();
  }
}

function setWelcomeStatusForCurrentUser() {
  const user = overlayState.session?.user;
  if (!user) return;

  const context = overlayState.context || buildPayload();
  if (isGithubOrCodespaceContext(context) && !hasCompletedSetup(context)) {
    overlayState.statusMessage = "";
    return;
  }

  const roleLabel = getRoleLabelLower(user.role);
  overlayState.statusMessage = user.role === "admin"
    ? `Bienvenido ${roleLabel} ${user.displayName}. Gestiona usuarios desde el dashboard; GitHub App y PR se ejecutan manualmente en Configuracion.`
    : `Bienvenido ${roleLabel} ${user.displayName}.`;
}

async function submitGoogleLoginFromOverlay() {
  overlayState.authBusy = true;
  overlayState.authError = "";
  renderOverlay();

  try {
    await loginToBackendWithGoogle();
    await ensureStudentCourseSelection({ forceOpen: overlayState.session?.user?.role === "student" });
    if (overlayState.studentCourseModalOpen) {
      overlayState.statusMessage = "Escoge el curso activo para cargar sus fuentes RAG.";
      return;
    }
    await refreshMentorSession();
    setWelcomeStatusForCurrentUser();
  } catch (error) {
    overlayState.authError = String(error);
    renderOverlay();
  } finally {
    overlayState.authBusy = false;
    renderOverlay();
  }
}

async function logoutAndReturnToLogin() {
  clearTutorResponseTracking("logout");
  await logoutFromBackend();
  overlayState.started = true;
  overlayState.ideas = [];
  overlayState.guide = [];
  overlayState.analysisUnlocked = false;
  overlayState.analysisWindowOpen = false;
  overlayState.projectAnalysis = null;
  overlayState.campusAnalysis = null;
  overlayState.setupRepoFullName = "";
  overlayState.setupWizardStep = 1;
  overlayState.githubAppBusy = false;
  overlayState.githubAppStatus = { ...EMPTY_GITHUB_APP_STATUS };
  overlayState.githubUserStatus = { ...EMPTY_GITHUB_USER_STATUS };
  overlayState.projectContextBusy = false;
  overlayState.projectContextStatus = { ...EMPTY_PROJECT_CONTEXT_STATUS };
  overlayState.projectContextHistory = [];
  overlayState.projectContextInsight = { ...EMPTY_PROJECT_CONTEXT_INSIGHT };
  overlayState.documentClassifications = { ...EMPTY_DOCUMENT_CLASSIFICATION_STATE };
  overlayState.teacherBitacoraStatus = { ...EMPTY_TEACHER_BITACORA_STATUS };
  overlayState.teacherRagPageOpen = false;
  overlayState.teacherRagState = { ...EMPTY_TEACHER_RAG_STATE };
  overlayState.codespaceWaitingContext = { ...EMPTY_CODESPACE_WAITING_CONTEXT };
  overlayState.campusCourseAccess = { ...EMPTY_CAMPUS_COURSE_ACCESS_STATE };
  overlayState.ragCourseCatalog = [];
  overlayState.ragDefaultCourseCode = "FPOO";
  overlayState.studentCourseModalOpen = false;
  overlayState.studentCourseState = { ...EMPTY_STUDENT_COURSE_STATE };
  overlayState.projectContextMessage = "";
  overlayState.projectContextError = "";
  overlayState.adminUsers = [];
  overlayState.adminTeachers = [];
  overlayState.adminUsersBusy = false;
  overlayState.adminUsersMessage = "";
  overlayState.operationTitle = "";
  overlayState.operationDetail = "";
  overlayState.operationKind = "busy";
  overlayState.statusMessage = "Sesion cerrada.";
  renderOverlay();
}

// Listeners de bienvenida, login, primer ingreso y «Salir» (antes dentro de ensureOverlay, en el mismo orden).
function bindAuthControls() {
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
  overlayEls.firstLoginConfirmBtn.addEventListener("click", async () => {
    await markPrivacyAcceptedForCurrentSession();
    renderOverlay();
    // La respuesta del tutor que se pidio con la privacidad pendiente llega ahora.
    if (takeMentorDeferredUntilPrivacyAccepted() && overlayState.started && hasActiveSession()
      && !overlayState.firstLoginConfirmationOpen) {
      await refreshMentorSession();
    }
  });
  overlayEls.firstLoginLogoutBtn.addEventListener("click", async () => {
    await logoutAndReturnToLogin();
  });
  // Un solo boton para cerrar sesion: "Salir" de la cabecera, visible en todas las vistas
  // (antes tambien "Cerrar sesion" en el tour y en la tuerca, que hacian lo mismo).
  overlayEls.logoutHeaderBtn.addEventListener("click", async () => {
    await logoutAndReturnToLogin();
    if (overlayState.settingsOpen) {
      setSettingsOpen(false);
      renderOverlay();
    }
  });
}
