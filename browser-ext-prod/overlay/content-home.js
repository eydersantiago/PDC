// ADACEEN | Capa 4 - UI: pestana «Inicio»: centro de contexto, conexiones, accion recomendada, aviso de
// operacion en curso y selector de cursos del estudiante.
// Movido sin cambios desde content-render.js (render de la vista) y desde content-lifecycle.js (acciones
// recomendadas y listeners, ahora en bindHomePanel).
// Sin "use strict": el codigo viene de archivos en modo no estricto y se conserva igual.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

function renderConnectionGrid(container, items) {
  if (!container) return;

  container.textContent = "";
  const fragment = document.createDocumentFragment();

  for (const item of items) {
    const node = document.createElement("div");
    node.className = `connection-item is-${toText(item.kind) || "idle"}`;

    const label = document.createElement("span");
    label.textContent = toText(item.label);

    const status = document.createElement("strong");
    status.textContent = toText(item.status) || "Sin datos";

    node.appendChild(label);
    node.appendChild(status);
    fragment.appendChild(node);
  }

  container.appendChild(fragment);
}

function syncContextActionButton(button, descriptor, fallbackLabel = "Continuar") {
  if (!button) return;

  if (!descriptor) {
    button.hidden = true;
    button.dataset.contextAction = "";
    button.textContent = fallbackLabel;
    button.disabled = true;
    return;
  }

  button.hidden = false;
  button.dataset.contextAction = toText(descriptor.action);
  button.textContent = toText(descriptor.label) || fallbackLabel;
  button.disabled = !!descriptor.disabled || !toText(descriptor.action);
}

function renderOperationBanner(elements) {
  const title = toText(overlayState.operationTitle);
  const detail = toText(overlayState.operationDetail || overlayState.statusMessage);
  const visible = !!title || (!!overlayState.githubAppBusy && !!detail);
  if (!elements?.banner) return;

  elements.banner.hidden = !visible;
  if (!visible) return;

  elements.banner.classList.toggle("is-error", toText(overlayState.operationKind) === "error");
  elements.title.textContent = title || "Preparando entorno";
  elements.detail.textContent = detail || "ADACEEN esta trabajando.";
}

function renderContextHub(prefix, context, actionModel, flow) {
  if (!overlayEls) return;

  const elements = prefix === "setup"
    ? {
      hub: overlayEls.setupContextHub,
      eyebrow: overlayEls.setupContextEyebrow,
      title: overlayEls.setupContextTitle,
      meta: overlayEls.setupContextMeta,
      chip: overlayEls.setupContextStateChip,
      grid: overlayEls.setupConnectionGrid,
      banner: overlayEls.setupOperationBanner,
      operationTitle: overlayEls.setupOperationTitle,
      operationDetail: overlayEls.setupOperationDetail,
      actionTitle: overlayEls.setupActionTitle,
      actionCopy: overlayEls.setupActionCopy,
      primary: overlayEls.setupPrimaryActionBtn,
      secondary: overlayEls.setupSecondaryActionBtn,
    }
    : {
      hub: overlayEls.contextHubSection,
      eyebrow: overlayEls.contextEyebrow,
      title: overlayEls.contextTitle,
      meta: overlayEls.contextMeta,
      chip: overlayEls.contextStateChip,
      grid: overlayEls.connectionGrid,
      banner: overlayEls.contextOperationBanner,
      operationTitle: overlayEls.contextOperationTitle,
      operationDetail: overlayEls.contextOperationDetail,
      actionTitle: overlayEls.contextActionTitle,
      actionCopy: overlayEls.contextActionCopy,
      primary: overlayEls.contextPrimaryActionBtn,
      secondary: overlayEls.contextSecondaryActionBtn,
    };

  if (!elements.hub) return;

  const info = buildContextModuleInfo(context);
  elements.eyebrow.textContent = info.label;
  elements.title.textContent = info.title;
  elements.meta.textContent = info.meta || "Sin detalle adicional.";
  elements.chip.textContent = info.state;
  elements.chip.className = `state-chip is-${toText(info.kind) || "idle"}`;

  renderConnectionGrid(elements.grid, buildConnectionItems(context, flow));
  renderOperationBanner({
    banner: elements.banner,
    title: elements.operationTitle,
    detail: elements.operationDetail,
  });

  const actionWrap = elements.actionTitle?.closest?.(".next-action") || null;
  if (!actionModel) {
    if (actionWrap) actionWrap.hidden = true;
    return;
  }
  if (actionWrap) actionWrap.hidden = false;

  elements.actionTitle.textContent = toText(actionModel?.title) || "Siguiente paso";
  elements.actionCopy.textContent = toText(actionModel?.copy) || "ADACEEN ajustara la accion segun el contexto detectado.";
  syncContextActionButton(elements.primary, actionModel?.primary, "Continuar");
  syncContextActionButton(elements.secondary, actionModel?.secondary, "Actualizar");
}

function renderStudentCourseModal() {
  if (!overlayEls?.studentCourseModal) return;
  const visible = !!overlayState.studentCourseModalOpen && overlayState.session?.user?.role === "student";
  overlayEls.studentCourseModal.hidden = !visible;
  if (!visible) return;

  const state = overlayState.studentCourseState || EMPTY_STUDENT_COURSE_STATE;
  const assigned = getStudentAssignedCourseCodes();
  const courses = (Array.isArray(state.courses) && state.courses.length ? state.courses : getRagCourseCatalog())
    .filter((course) => assigned.includes(normalizeRagCourseCodeUi(course?.code)));
  const selected = getSelectedStudentCourseCode();

  overlayEls.studentCourseCopy.textContent = courses.length > 1
    ? "Escoge el curso que quieres practicar ahora; las recomendaciones usaran sus fuentes RAG."
    : "Tu docente asigno este curso para practicar; ADACEEN usara sus fuentes RAG.";
  const optionsKey = JSON.stringify([
    !!state.busy,
    courses.map((course) => [normalizeRagCourseCodeUi(course?.code), toText(course?.shortName || course?.code), toText(course?.name)]),
  ]);
  // Con las mismas opciones no se recrean los botones (el foco se conserva); solo cambia la seleccion.
  if (renderKeyChanged(overlayEls.studentCourseOptions, optionsKey)) {
    overlayEls.studentCourseOptions.textContent = "";
    if (!courses.length) {
      const empty = document.createElement("p");
      empty.className = "course-empty";
      empty.textContent = state.busy ? "Cargando cursos asignados..." : "No hay cursos asignados. Se usara FPOO por defecto.";
      overlayEls.studentCourseOptions.appendChild(empty);
    }
    const fragment = document.createDocumentFragment();
    for (const course of courses) {
      const code = normalizeRagCourseCodeUi(course?.code);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "student-course-option";
      button.disabled = !!state.busy;
      button.dataset.courseCode = code;
      const title = document.createElement("strong");
      title.textContent = toText(course?.shortName || course?.code || code);
      const copy = document.createElement("span");
      copy.textContent = toText(course?.name || code);
      button.append(title, copy);
      button.addEventListener("click", () => {
        const previous = normalizeRagCourseCodeUi(overlayState.studentCourseState?.selectedCourseCode || "");
        overlayState.studentCourseState = {
          ...(overlayState.studentCourseState || EMPTY_STUDENT_COURSE_STATE),
          selectedCourseCode: code,
          error: "",
          message: "",
        };
        if (previous && previous !== code) {
          overlayState.campusCourseAccess = { ...EMPTY_CAMPUS_COURSE_ACCESS_STATE };
          overlayState.campusAnalysis = null;
        }
        renderOverlay();
      });
      fragment.appendChild(button);
    }
    overlayEls.studentCourseOptions.appendChild(fragment);
  }
  for (const button of overlayEls.studentCourseOptions.querySelectorAll("button.student-course-option")) {
    const isSelected = button.dataset.courseCode === selected;
    button.classList.toggle("is-selected", isSelected);
    button.setAttribute("aria-pressed", isSelected ? "true" : "false");
  }

  setTextIfChanged(overlayEls.studentCourseStatus, state.error || state.message || `Curso activo: ${selected}.`);
  const hasEnabledCourses = courses.length > 0;
  overlayEls.studentCourseLogoutBtn.textContent = hasEnabledCourses ? "Cancelar" : "Cerrar sesion";
  overlayEls.studentCourseLogoutBtn.dataset.courseModalAction = hasEnabledCourses ? "cancel" : "logout";
  overlayEls.studentCourseConfirmBtn.disabled = !!state.busy;
  overlayEls.studentCourseLogoutBtn.disabled = !!state.busy;
}

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

// Listeners de la pestana Inicio y del selector de cursos (antes dentro de ensureOverlay, en el mismo orden).
function bindHomePanel() {
  overlayEls.contextPrimaryActionBtn.addEventListener("click", async () => {
    await runRecommendedContextAction(overlayEls.contextPrimaryActionBtn.dataset.contextAction);
  });
  overlayEls.contextSecondaryActionBtn.addEventListener("click", async () => {
    await runRecommendedContextAction(overlayEls.contextSecondaryActionBtn.dataset.contextAction);
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
}
