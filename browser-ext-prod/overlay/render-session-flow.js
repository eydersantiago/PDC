// ADACEEN | Capa 4 - UI: flujo de sesion del overlay: empezar, iniciar sesion, cerrar sesion y arrastre de la ventana.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

function startDrag(event) {
  if (!overlayHost || event.button !== 0) return;
  if (event.target.closest("button") || event.target.closest("input") || event.target.closest("select") || event.target.closest("textarea")) {
    return;
  }

  event.preventDefault();
  const rect = overlayHost.getBoundingClientRect();
  const startX = event.clientX;
  const startY = event.clientY;

  function onMove(moveEvent) {
    const deltaX = moveEvent.clientX - startX;
    const deltaY = moveEvent.clientY - startY;
    const bounds = getOverlayViewportBounds();
    const nextLeft = clamp(rect.left + deltaX, bounds.minLeft, bounds.maxLeft);
    const nextTop = clamp(rect.top + deltaY, bounds.minTop, bounds.maxTop);
    placeOverlay(nextLeft, nextTop);
  }

  function onUp() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

async function startExperience() {
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
    const hasForeignActiveTab = await refreshActiveTabStateFromBackend({ force: true })
      .catch(() => false);

    if (hasForeignActiveTab) {
      overlayState.started = false;
      overlayState.loading = false;
      overlayState.analysisUnlocked = false;
      overlayState.analysisWindowOpen = false;
      overlayState.statusMessage = "Esta sesión ya está activa en otra pestaña.";
      renderOverlay();
      return;
    }

    await refreshMentorSession();
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

  const context = getPageContext();
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
  overlayState.processNoticeOpen = false;
  overlayState.projectContextBusy = false;
  overlayState.projectContextStatus = { ...EMPTY_PROJECT_CONTEXT_STATUS };
  overlayState.projectContextHistory = [];
  overlayState.projectContextInsight = { ...EMPTY_PROJECT_CONTEXT_INSIGHT };
  overlayState.documentClassifications = { ...EMPTY_DOCUMENT_CLASSIFICATION_STATE };
  overlayState.teacherBitacoraPageOpen = false;
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
