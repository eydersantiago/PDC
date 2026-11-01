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

// ---- Un editor, varios repositorios (0.7.20) ----
// Los repositorios que ya estan en el editor en la nube de quien inicio sesion (estudiante,
// docente o administrador; guardados en este navegador o los que trae el backend en editors),
// menos el de la pagina, que ya tiene su boton. Cada uno abre su carpeta del mismo tunel.
const EDITOR_REPOS_MAX = 6;

function renderEditorReposList(showingMainView) {
  const section = overlayEls?.editorReposSection;
  const list = overlayEls?.editorReposList;
  if (!section || !list) return;
  const currentRepo = toText(getCurrentRepoFullName()).toLowerCase();
  const visible = showingMainView
    && hasActiveSession()
    && typeof isTunnelProvider === "function" && isTunnelProvider()
    && typeof listSavedTunnelEditors === "function";
  const editors = visible
    ? listSavedTunnelEditors()
      .filter((record) => toText(record.repoFullName).toLowerCase() !== currentRepo)
      .slice(0, EDITOR_REPOS_MAX)
    : [];
  section.hidden = editors.length === 0;
  const busy = !!overlayState.githubAppBusy;
  if (!renderKeyChanged(list, JSON.stringify([editors.map((record) => record.repoFullName), busy]))) return;
  list.replaceChildren();
  for (const record of editors) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "editor-repo-open";
    button.dataset.repo = record.repoFullName;
    button.disabled = busy;
    button.setAttribute("aria-label", `Abrir ${record.repoFullName} en tu editor`);
    const name = document.createElement("span");
    name.className = "editor-repo-name";
    name.textContent = record.repoFullName;
    const go = document.createElement("span");
    go.className = "editor-repo-go";
    go.setAttribute("aria-hidden", "true");
    go.textContent = "Abrir";
    button.append(name, go);
    item.appendChild(button);
    list.appendChild(item);
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
  // Un repositorio de «Tus repositorios en el editor»: la ventana de espera se abre en el mismo
  // clic (openMyTunnelEditor, antes de su primer await).
  overlayEls.editorReposList?.addEventListener("click", async (event) => {
    const button = event?.target?.closest?.(".editor-repo-open") || event?.target;
    const repoFullName = parseRepoFullName(button?.dataset?.repo);
    if (!repoFullName || button.disabled || overlayState.githubAppBusy) return;
    await openMyTunnelEditor({ repoFullName });
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
