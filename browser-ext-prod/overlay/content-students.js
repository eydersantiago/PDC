// ADACEEN | Capa 4 - UI: pestanas de la vista principal y pestana "Estudiantes" (0.7.13).
// Las pestanas reparten la vista principal por rol para que cada una quepa en la ventana
// sin scroll largo: Inicio (contexto y resumen), Tutor (pistas del estudiante),
// Estudiantes (sesiones, intervenciones, quices y nota; docente y administrador) y
// Usuarios (administracion). El panel de estudiantes habla con GET /api/admin/students
// y GET /api/admin/students/:userId (services/backend.service.js).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const MAIN_TAB_LABELS = Object.freeze({
  inicio: "Inicio",
  tutor: "Tutor",
  estudiantes: "Estudiantes",
  usuarios: "Usuarios",
});

const STUDENT_SESSION_KIND_LABELS = Object.freeze({
  browser: "Navegador",
  editor: "VS Code",
  cli: "Consola",
});

const STUDENT_INTERVENTION_LABELS = Object.freeze({
  explanation: "Explicacion",
  hint: "Pista",
  example: "Ejemplo",
  mini_quiz: "Mini quiz",
  controlled_message: "Mensaje controlado",
});

const STUDENT_EVENT_LABELS = Object.freeze({
  compile_error: "Error de compilacion",
  runtime_error: "Error en ejecucion",
  concept_question: "Pregunta conceptual",
  design_block: "Bloqueo de diseno",
  workflow_guidance: "Guia de flujo",
  insufficient_context: "Contexto insuficiente",
  out_of_domain: "Fuera de dominio",
  code_suggestion: "Sugerencia de codigo",
});

const STUDENT_ACTIVITY_CATEGORY_LABELS = Object.freeze({
  suggestion: "Sugerencias",
  cursor_idle: "Cursor inactivo",
  codespace: "Entorno",
  github_pr: "Pull requests",
  navigation: "Navegacion",
  project_context: "Contexto del proyecto",
  intervention: "Intervenciones",
  error: "Errores",
  workflow: "Flujo de trabajo",
  tutor: "Tutor",
  signal: "Senales",
  code_application: "Codigo aplicado",
  quiz: "Quices",
});

// ---- Pestanas ----

// Pestanas que ve el rol de la sesion actual, en el orden de la barra.
function getAvailableMainTabs() {
  if (isAdminSession()) return ["inicio", "estudiantes", "usuarios"];
  if (isTeacherSession()) return ["inicio", "tutor", "estudiantes", "usuarios"];
  return ["inicio", "tutor"];
}

function normalizeMainTab(value) {
  const tab = toText(value).toLowerCase();
  const available = getAvailableMainTabs();
  return available.includes(tab) ? tab : available[0];
}

function getMainTabButton(tab) {
  if (!overlayEls) return null;
  if (tab === "tutor") return overlayEls.tabBtnTutor;
  if (tab === "estudiantes") return overlayEls.tabBtnEstudiantes;
  if (tab === "usuarios") return overlayEls.tabBtnUsuarios;
  return overlayEls.tabBtnInicio;
}

function getMainTabPanel(tab) {
  if (!overlayEls) return null;
  if (tab === "tutor") return overlayEls.tabPanelTutor;
  if (tab === "estudiantes") return overlayEls.tabPanelEstudiantes;
  if (tab === "usuarios") return overlayEls.tabPanelUsuarios;
  return overlayEls.tabPanelInicio;
}

// Cambia de pestana. byUser: la eligio la persona (no se salta sola a "tutor" despues).
function setMainTab(tab, options = {}) {
  const next = normalizeMainTab(tab);
  const changed = overlayState.mainTab !== next;
  overlayState.mainTab = next;
  if (options.byUser) overlayState.mainTabChosenByUser = true;
  if (next === "estudiantes" && typeof ensureStudentsProgressLoaded === "function") {
    ensureStudentsProgressLoaded();
  }
  if (changed || options.forceRender) {
    renderOverlay();
  }
  if (options.focus) {
    const button = getMainTabButton(next);
    if (button && typeof button.focus === "function") button.focus();
  }
  return next;
}

// Llegan pistas del tutor: se abre "Tutor". Si la persona pidio la ayuda («Actualizar»,
// Ctrl+Enter) siempre; si fue un refresco automatico, solo cuando no eligio otra pestana.
function showTutorTabForResponse(options = {}) {
  if (isAdminSession()) return;
  if (!options.manual && overlayState.mainTabChosenByUser) return;
  overlayState.mainTab = normalizeMainTab("tutor");
}

function renderMainTabs(showingMainView) {
  if (!overlayEls?.mainTabBar) return;
  const available = getAvailableMainTabs();
  const active = normalizeMainTab(overlayState.mainTab);
  overlayState.mainTab = active;
  for (const tab of MAIN_TAB_IDS) {
    const button = getMainTabButton(tab);
    const panel = getMainTabPanel(tab);
    const visible = available.includes(tab);
    const isActive = visible && tab === active;
    if (button) {
      button.hidden = !visible;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", isActive ? "true" : "false");
      button.tabIndex = isActive ? 0 : -1;
    }
    if (panel) {
      panel.hidden = !showingMainView || !isActive;
    }
  }
  overlayEls.mainTabBar.hidden = !showingMainView || available.length < 2;

  const count = Array.isArray(overlayState.studentsPanel?.items) ? overlayState.studentsPanel.items.length : 0;
  if (overlayEls.tabCountEstudiantes) {
    overlayEls.tabCountEstudiantes.hidden = count === 0;
    setTextIfChanged(overlayEls.tabCountEstudiantes, count > 0 ? String(count) : "");
  }
}

// Flechas, Inicio y Fin mueven el foco y activan la pestana (patron tablist de WAI-ARIA).
function handleMainTabKeydown(event) {
  const key = toText(event?.key);
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
  const available = getAvailableMainTabs();
  const current = available.indexOf(normalizeMainTab(overlayState.mainTab));
  let index = current;
  if (key === "ArrowLeft") index = (current - 1 + available.length) % available.length;
  if (key === "ArrowRight") index = (current + 1) % available.length;
  if (key === "Home") index = 0;
  if (key === "End") index = available.length - 1;
  event.preventDefault?.();
  setMainTab(available[index], { byUser: true, focus: true });
}

function bindMainTabs() {
  if (!overlayEls) return;
  for (const tab of MAIN_TAB_IDS) {
    const button = getMainTabButton(tab);
    if (!button) continue;
    button.addEventListener("click", () => {
      setMainTab(tab, { byUser: true, forceRender: true });
    });
    button.addEventListener("keydown", handleMainTabKeydown);
  }
}

// ---- Formato ----

function formatStudentRelativeTime(value, now = Date.now()) {
  const text = toText(value);
  if (!text) return "Sin actividad";
  const time = Date.parse(text);
  if (Number.isNaN(time)) return text;
  const diff = Math.max(0, now - time);
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "Ahora mismo";
  if (minutes < 60) return `Hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Hace ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `Hace ${days} d`;
  return new Date(time).toLocaleDateString();
}

function formatStudentDateTime(value) {
  const text = toText(value);
  if (!text) return "Sin fecha";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

function formatStudentDuration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  if (total < 1) return "< 1 min";
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function formatStudentGrade(grade) {
  if (!grade || grade.score === null || grade.score === undefined) return "Sin quices";
  const scale = grade.scale5 === null || grade.scale5 === undefined ? "" : ` | ${String(grade.scale5).replace(".", ",")}/5`;
  return `${grade.score}/100${scale}`;
}

function studentGradeLevel(grade) {
  const level = toText(grade?.level);
  return ["alto", "medio", "bajo"].includes(level) ? level : "sin_datos";
}

function studentQuizResultLabel(quiz) {
  if (!quiz?.answered) return quiz?.status === "skipped" ? "Omitido" : "Sin responder";
  return quiz.correct ? "Correcto" : "Incorrecto";
}

function pluralizeStudentCount(count, singular, plural) {
  const value = Number(count) || 0;
  return `${value} ${value === 1 ? singular : plural}`;
}

// ---- Carga ----

function resetStudentsPanel() {
  overlayState.studentsPanel = { ...EMPTY_STUDENTS_PANEL_STATE };
}

function isStudentsPanelStale() {
  const panel = overlayState.studentsPanel;
  return !panel || !panel.loadedAt || Date.now() - panel.loadedAt > STUDENTS_PANEL_STALE_MS;
}

async function loadStudentsProgress(options = {}) {
  const panel = overlayState.studentsPanel;
  if (!panel || panel.busy || !canManageUsersSession()) return;
  if (!options.force && !isStudentsPanelStale()) return;
  panel.busy = true;
  panel.error = "";
  panel.message = "Cargando progreso...";
  renderOverlay();
  try {
    const response = await fetchStudentsProgress();
    panel.items = response.students;
    panel.totals = response.totals;
    panel.generatedAt = response.generatedAt;
    panel.loadedAt = Date.now();
    panel.message = "";
    if (panel.selectedId && !panel.items.some((item) => toText(item.id) === panel.selectedId)) {
      panel.selectedId = "";
      panel.detail = null;
    }
  } catch (error) {
    panel.error = `No se pudo cargar el progreso: ${error?.message || error}`;
    panel.message = "";
  } finally {
    panel.busy = false;
    renderOverlay();
  }
}

function ensureStudentsProgressLoaded() {
  if (!canManageUsersSession() || !overlayState.sessionId) return;
  if (!isStudentsPanelStale()) return;
  loadStudentsProgress().catch(() => {});
}

async function loadStudentProgressDetail(studentUserId, options = {}) {
  const panel = overlayState.studentsPanel;
  const userId = toText(studentUserId);
  if (!panel || !userId || !canManageUsersSession()) return;
  if (panel.detailBusy && panel.selectedId === userId) return;
  panel.selectedId = userId;
  if (panel.detail?.student?.id !== userId) panel.detail = null;
  panel.detailBusy = true;
  panel.detailError = "";
  renderOverlay();
  try {
    const detail = await fetchStudentProgressDetail(userId, options.limit);
    // Si mientras tanto se eligio otro estudiante, no se pisa su detalle.
    if (overlayState.studentsPanel !== panel || panel.selectedId !== userId) return;
    panel.detail = detail;
    panel.detailLoadedAt = Date.now();
    // La fila de la lista se actualiza con el resumen fresco del detalle.
    panel.items = panel.items.map((item) => (toText(item.id) === userId ? detail.student : item));
  } catch (error) {
    if (panel.selectedId === userId) {
      panel.detailError = `No se pudo cargar el detalle: ${error?.message || error}`;
    }
  } finally {
    if (panel.selectedId === userId) panel.detailBusy = false;
    renderOverlay();
  }
}

function openStudentDetail(studentUserId) {
  loadStudentProgressDetail(studentUserId).catch(() => {});
}

function closeStudentDetail() {
  const panel = overlayState.studentsPanel;
  if (!panel) return;
  panel.selectedId = "";
  panel.detail = null;
  panel.detailError = "";
  panel.detailBusy = false;
  renderOverlay();
  // El foco vuelve a la lista (WCAG 2.4.3): al boton Recargar, siempre visible.
  if (typeof focusOverlayElement === "function") {
    focusOverlayElement(overlayEls?.studentsReloadBtn);
  }
}

// ---- Render ----

function createKpiTile(label, value, note = "", modifier = "") {
  const tile = document.createElement("div");
  tile.className = `kpi-tile${modifier ? ` ${modifier}` : ""}`;
  const labelEl = document.createElement("span");
  labelEl.className = "kpi-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("strong");
  valueEl.className = "kpi-value";
  valueEl.textContent = value;
  tile.appendChild(labelEl);
  tile.appendChild(valueEl);
  if (note) {
    const noteEl = document.createElement("span");
    noteEl.className = "kpi-note";
    noteEl.textContent = note;
    tile.appendChild(noteEl);
  }
  return tile;
}

function createDetailListItem(title, meta = "", detail = "") {
  const li = document.createElement("li");
  const titleEl = document.createElement("span");
  titleEl.className = "item-title";
  titleEl.textContent = title;
  li.appendChild(titleEl);
  if (meta) {
    const metaEl = document.createElement("span");
    metaEl.className = "item-meta";
    metaEl.textContent = meta;
    li.appendChild(metaEl);
  }
  if (detail) {
    const detailEl = document.createElement("span");
    detailEl.textContent = detail;
    li.appendChild(detailEl);
  }
  return li;
}

function fillDetailList(element, items, emptyText) {
  if (!element) return;
  element.textContent = "";
  if (!items.length) {
    element.appendChild(createDetailListItem(emptyText));
    return;
  }
  const fragment = document.createDocumentFragment();
  items.forEach((item) => fragment.appendChild(item));
  element.appendChild(fragment);
}

function filterStudentsPanelItems(items, query) {
  const needle = toText(query).toLowerCase();
  if (!needle) return items;
  return items.filter((item) => {
    const haystack = [
      item.displayName,
      item.email,
      item.teacherDisplayName,
      item.pilotCohort,
      ...(Array.isArray(item.assignedCourseCodes) ? item.assignedCourseCodes : []),
    ].map((value) => toText(value).toLowerCase()).join(" ");
    return haystack.includes(needle);
  });
}

function renderStudentsKpis(panel) {
  const container = overlayEls?.studentsKpis;
  if (!container) return;
  const totals = panel.totals;
  const key = JSON.stringify([totals, panel.items.length, panel.busy]);
  if (!renderKeyChanged(container, key)) return;
  container.textContent = "";
  if (!totals) return;
  const fragment = document.createDocumentFragment();
  fragment.appendChild(createKpiTile("Estudiantes", String(totals.students ?? panel.items.length), isTeacherSession() ? "asignados a tu cuenta" : "en el piloto"));
  fragment.appendChild(createKpiTile("Activos ahora", String(totals.activeNow ?? 0), "sesion viva en 15 min", Number(totals.activeNow) > 0 ? "is-accent" : ""));
  fragment.appendChild(createKpiTile("Con quices", String(totals.withQuizzes ?? 0), "han recibido mini quiz"));
  fragment.appendChild(createKpiTile(
    "Nota promedio",
    totals.averageGrade === null || totals.averageGrade === undefined ? "--" : `${totals.averageGrade}/100`,
    "60 % aciertos + 40 % seguimiento",
  ));
  fragment.appendChild(createKpiTile(
    "Intervenciones",
    String(totals.interventions ?? 0),
    `${pluralizeStudentCount(totals.blocked ?? 0, "bloqueada", "bloqueadas")} por la politica`,
    Number(totals.blocked) > 0 ? "is-warning" : "",
  ));
  container.appendChild(fragment);
}

function renderStudentsTable(panel) {
  const body = overlayEls?.studentsTableBody;
  if (!body) return;
  const visible = filterStudentsPanelItems(panel.items, panel.query);
  const now = Date.now();
  const key = JSON.stringify([visible, panel.selectedId, panel.busy, panel.error, Math.floor(now / 60000)]);
  if (!renderKeyChanged(body, key)) return;
  body.textContent = "";

  const appendNotice = (message, className, loading = false) => {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.className = `${className}${loading ? " is-loading-note" : ""}`;
    cell.textContent = message;
    row.appendChild(cell);
    body.appendChild(row);
  };

  if (panel.busy && panel.items.length === 0) {
    appendNotice("Cargando progreso de los estudiantes", "admin-loading-cell", true);
    return;
  }
  if (panel.error && panel.items.length === 0) {
    appendNotice(panel.error, "admin-empty-cell");
    return;
  }
  if (panel.items.length === 0) {
    appendNotice(isTeacherSession()
      ? "Aun no tienes estudiantes asignados. Crealos en la pestaña Usuarios."
      : "No hay estudiantes registrados.", "admin-empty-cell");
    return;
  }
  if (visible.length === 0) {
    appendNotice("Ningun estudiante coincide con la busqueda.", "admin-empty-cell");
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of visible) {
    const id = toText(item.id);
    const row = document.createElement("tr");
    row.className = `student-row${panel.selectedId === id ? " is-selected" : ""}${item.isActive === false ? " is-inactive" : ""}`;
    row.dataset.userId = id;
    row.setAttribute("aria-label", `Ver detalle de ${toText(item.displayName) || toText(item.email)}`);

    const studentCell = document.createElement("td");
    studentCell.className = "student-cell";
    const dot = document.createElement("span");
    dot.className = `online-dot${item.sessions?.activeNow ? "" : " is-off"}`;
    dot.title = item.sessions?.activeNow ? "Activo ahora" : "Sin sesion activa";
    // El nombre es un boton: abre el detalle tambien desde el teclado (la fila no recibe foco).
    const name = document.createElement("button");
    name.type = "button";
    name.className = "student-name";
    name.setAttribute("aria-label", `Ver detalle de ${toText(item.displayName) || toText(item.email)}`);
    name.appendChild(dot);
    name.appendChild(document.createTextNode(toText(item.displayName) || "Estudiante"));
    name.addEventListener("click", (event) => {
      event.stopPropagation?.();
      openStudentDetail(id);
    });
    const email = document.createElement("span");
    email.className = "student-email";
    const emailParts = [toText(item.email)];
    if (isAdminSession() && item.teacherDisplayName) emailParts.push(toText(item.teacherDisplayName));
    if (item.pilotCohort) emailParts.push(`cohorte ${toText(item.pilotCohort)}`);
    if (item.isActive === false) emailParts.push("inactivo");
    email.textContent = emailParts.filter(Boolean).join(" | ");
    studentCell.appendChild(name);
    studentCell.appendChild(email);

    const sessionsCell = document.createElement("td");
    const sessions = item.sessions || {};
    sessionsCell.textContent = String(sessions.total || 0);
    const sessionsNote = document.createElement("span");
    sessionsNote.className = "cell-note";
    sessionsNote.textContent = `${sessions.browser || 0} nav | ${sessions.editor || 0} VS Code`;
    sessionsCell.appendChild(sessionsNote);

    const activityCell = document.createElement("td");
    activityCell.textContent = formatStudentRelativeTime(item.lastActivityAt, now);
    const activityNote = document.createElement("span");
    activityNote.className = "cell-note";
    activityNote.textContent = item.lastActivityAt ? formatStudentDateTime(item.lastActivityAt) : "sin registros";
    activityCell.appendChild(activityNote);

    const tutorCell = document.createElement("td");
    const interventions = item.interventions || {};
    tutorCell.textContent = String(interventions.total || 0);
    const tutorNote = document.createElement("span");
    tutorNote.className = "cell-note";
    tutorNote.textContent = `${interventions.hints || 0} pistas | ${interventions.blocked || 0} bloq.`;
    tutorCell.appendChild(tutorNote);

    const quizCell = document.createElement("td");
    const quizzes = item.quizzes || {};
    quizCell.textContent = `${quizzes.correct || 0}/${quizzes.answered || 0}`;
    const quizNote = document.createElement("span");
    quizNote.className = "cell-note";
    quizNote.textContent = quizzes.total
      ? `${pluralizeStudentCount(quizzes.total, "quiz", "quices")}${quizzes.correctRate === null || quizzes.correctRate === undefined ? "" : ` | ${quizzes.correctRate} % aciertos`}`
      : "sin quices";
    quizCell.appendChild(quizNote);

    const gradeCell = document.createElement("td");
    const gradeChip = document.createElement("span");
    gradeChip.className = `grade-chip is-${studentGradeLevel(item.grade)}`;
    gradeChip.textContent = formatStudentGrade(item.grade);
    gradeChip.title = toText(item.grade?.formula);
    gradeCell.appendChild(gradeChip);

    row.addEventListener("click", () => openStudentDetail(id));
    row.appendChild(studentCell);
    row.appendChild(sessionsCell);
    row.appendChild(activityCell);
    row.appendChild(tutorCell);
    row.appendChild(quizCell);
    row.appendChild(gradeCell);
    fragment.appendChild(row);
  }
  body.appendChild(fragment);
}

function renderStudentTimeline(timeline) {
  const container = overlayEls?.studentDetailTimeline;
  if (!container) return;
  const points = Array.isArray(timeline) ? timeline : [];
  if (overlayEls.studentDetailTimelineLegend) overlayEls.studentDetailTimelineLegend.hidden = points.length === 0;
  const key = JSON.stringify(points);
  if (!renderKeyChanged(container, key)) return;
  container.textContent = "";
  if (!points.length) return;
  const max = Math.max(1, ...points.map((point) => (Number(point.sessions) || 0) + (Number(point.interventions) || 0) + (Number(point.quizzes) || 0)));
  const fragment = document.createDocumentFragment();
  for (const point of points) {
    const day = document.createElement("div");
    day.className = "timeline-day";
    const sessions = Number(point.sessions) || 0;
    const interventions = Number(point.interventions) || 0;
    const quizzes = Number(point.quizzes) || 0;
    day.title = `${toText(point.day)}: ${pluralizeStudentCount(sessions, "sesion", "sesiones")}, ${pluralizeStudentCount(interventions, "intervencion", "intervenciones")}, ${pluralizeStudentCount(quizzes, "quiz", "quices")}`;
    const bars = [
      ["is-quizzes", quizzes],
      ["is-interventions", interventions],
      ["is-sessions", sessions],
    ];
    for (const [className, value] of bars) {
      if (!value) continue;
      const bar = document.createElement("span");
      bar.className = `timeline-bar ${className}`;
      bar.style.height = `${Math.max(6, Math.round((value / max) * 100))}%`;
      day.appendChild(bar);
    }
    fragment.appendChild(day);
  }
  container.appendChild(fragment);
  container.setAttribute("aria-label", `Actividad de los ultimos ${points.length} dias: ${points.reduce((sum, point) => sum + (Number(point.sessions) || 0), 0)} sesiones, ${points.reduce((sum, point) => sum + (Number(point.interventions) || 0), 0)} intervenciones y ${points.reduce((sum, point) => sum + (Number(point.quizzes) || 0), 0)} quices`);
}

function renderStudentDetail(panel) {
  const section = overlayEls?.studentDetailSection;
  if (!section) return;
  const open = !!panel.selectedId;
  section.hidden = !open;
  if (overlayEls.studentsSection) overlayEls.studentsSection.hidden = open;
  if (!open) return;

  const summary = panel.detail?.student || panel.items.find((item) => toText(item.id) === panel.selectedId) || null;
  const detail = panel.detail;
  const name = toText(summary?.displayName) || "Estudiante";
  setTextIfChanged(overlayEls.studentDetailTitle, name);
  const metaParts = [toText(summary?.email)];
  if (summary?.teacherDisplayName) metaParts.push(`Docente: ${toText(summary.teacherDisplayName)}`);
  if (summary?.pilotCohort) metaParts.push(`Cohorte ${toText(summary.pilotCohort)}`);
  if (Array.isArray(summary?.assignedCourseCodes) && summary.assignedCourseCodes.length) {
    metaParts.push(`Cursos: ${summary.assignedCourseCodes.map(toText).join(", ")}`);
  }
  if (summary?.isActive === false) metaParts.push("Cuenta inactiva");
  setTextIfChanged(overlayEls.studentDetailMeta, metaParts.filter(Boolean).join(" | ") || "Sin datos");

  const chip = overlayEls.studentDetailChip;
  if (chip) {
    const activeNow = !!summary?.sessions?.activeNow;
    const lastSeen = summary?.sessions?.lastSeenAt;
    setTextIfChanged(chip, activeNow ? "Activo ahora" : (lastSeen ? `Ultima sesion ${formatStudentRelativeTime(lastSeen).toLowerCase()}` : "Sin sesiones"));
    chip.classList.toggle("is-ok", activeNow);
  }

  // Solo habla cuando hay algo que decir (cargando o error): asi el detalle cabe sin scroll.
  const statusText = panel.detailError || (panel.detailBusy ? "Cargando detalle..." : "");
  setTextIfChanged(overlayEls.studentDetailStatus, statusText);
  if (overlayEls.studentDetailStatus) overlayEls.studentDetailStatus.hidden = !statusText;
  overlayEls.studentDetailStatus?.classList.toggle("is-loading-note", panel.detailBusy && !panel.detailError);
  if (overlayEls.studentDetailReloadBtn) overlayEls.studentDetailReloadBtn.disabled = panel.detailBusy;

  const kpis = overlayEls.studentDetailKpis;
  if (kpis) {
    const key = JSON.stringify([summary, panel.detailBusy]);
    if (renderKeyChanged(kpis, key)) {
      kpis.textContent = "";
      if (summary) {
        const sessions = summary.sessions || {};
        const interventions = summary.interventions || {};
        const quizzes = summary.quizzes || {};
        const exercises = summary.exercises || {};
        const grade = summary.grade || {};
        const fragment = document.createDocumentFragment();
        fragment.appendChild(createKpiTile("Sesiones", String(sessions.total || 0), `${sessions.browser || 0} navegador | ${sessions.editor || 0} VS Code${sessions.cli ? ` | ${sessions.cli} consola` : ""}`));
        fragment.appendChild(createKpiTile("Intervenciones", String(interventions.total || 0), `${interventions.hints || 0} pistas | ${interventions.explanations || 0} explic. | ${interventions.blocked || 0} bloqueadas`, Number(interventions.blocked) > 0 ? "is-warning" : ""));
        fragment.appendChild(createKpiTile("Pistas usadas", String(exercises.hints || 0), pluralizeStudentCount(exercises.total || 0, "ejercicio", "ejercicios")));
        fragment.appendChild(createKpiTile("Quices", `${quizzes.correct || 0}/${quizzes.answered || 0}`, quizzes.total
          ? `${quizzes.total} recibidos${quizzes.correctRate === null || quizzes.correctRate === undefined ? "" : ` | ${quizzes.correctRate} % aciertos`}${quizzes.skipped ? ` | ${quizzes.skipped} omitidos` : ""}`
          : "sin quices todavia"));
        fragment.appendChild(createKpiTile("Nota de quices", formatStudentGrade(grade), toText(grade.formula) || "Sin quices respondidos.", grade.level === "alto" ? "is-accent" : (grade.level === "bajo" ? "is-warning" : "")));
        kpis.appendChild(fragment);
      }
    }
  }

  renderStudentTimeline(detail?.timeline || []);

  const listsKey = JSON.stringify([detail, panel.detailBusy, panel.detailError]);
  if (!renderKeyChanged(section, listsKey)) return;

  const loadingItem = (text) => [createDetailListItem(text)];
  if (!detail) {
    const placeholder = panel.detailBusy ? "Cargando..." : (panel.detailError || "Sin datos.");
    fillDetailList(overlayEls.studentDetailQuizzes, loadingItem(placeholder), placeholder);
    fillDetailList(overlayEls.studentDetailSessions, loadingItem(placeholder), placeholder);
    fillDetailList(overlayEls.studentDetailInterventions, loadingItem(placeholder), placeholder);
    fillDetailList(overlayEls.studentDetailActivity, loadingItem(placeholder), placeholder);
    return;
  }

  fillDetailList(
    overlayEls.studentDetailQuizzes,
    detail.quizzes.map((quiz) => {
      const li = createDetailListItem(
        toText(quiz.topic) || toText(quiz.question) || "Mini quiz",
        `${quiz.trigger === "teacher_launch" ? "Lanzado por el docente" : "Tras aplicar codigo"} | ${formatStudentDateTime(quiz.createdAt)}${quiz.filePath ? ` | ${toText(quiz.filePath)}` : ""}`,
      );
      const result = document.createElement("span");
      result.className = `quiz-result ${quiz.answered ? (quiz.correct ? "is-ok" : "is-wrong") : "is-pending"}`;
      const parts = [studentQuizResultLabel(quiz)];
      if (quiz.answered && quiz.chosenOption) parts.push(`eligio "${truncateText(quiz.chosenOption, 60)}"`);
      if (quiz.answered && !quiz.correct && quiz.correctOption) parts.push(`correcta "${truncateText(quiz.correctOption, 60)}"`);
      if (quiz.followupScore !== null && quiz.followupScore !== undefined) parts.push(`seguimiento ${quiz.followupScore}/100`);
      result.textContent = parts.join(" | ");
      li.appendChild(result);
      if (quiz.followupFeedback) {
        const feedback = document.createElement("span");
        feedback.className = "item-meta";
        feedback.textContent = truncateText(quiz.followupFeedback, 160);
        li.appendChild(feedback);
      }
      return li;
    }),
    "Aun no ha recibido mini quices.",
  );

  fillDetailList(
    overlayEls.studentDetailSessions,
    detail.sessions.map((session) => createDetailListItem(
      `${STUDENT_SESSION_KIND_LABELS[toText(session.kind)] || toText(session.kind) || "Sesion"}${session.label ? ` (${toText(session.label)})` : ""}${session.isActive ? " | activa" : ""}`,
      `${formatStudentDateTime(session.createdAt)} | duro ${formatStudentDuration(session.durationMinutes)}${session.expiresAt ? ` | vence ${formatStudentDateTime(session.expiresAt)}` : ""}`,
    )),
    "Sin sesiones registradas.",
  );

  fillDetailList(
    overlayEls.studentDetailInterventions,
    detail.interventions.map((item) => createDetailListItem(
      `${STUDENT_EVENT_LABELS[toText(item.eventType)] || toText(item.eventType) || "Evento"} -> ${STUDENT_INTERVENTION_LABELS[toText(item.interventionType)] || toText(item.interventionType) || "intervencion"}${item.blocked ? " (bloqueada)" : ""}`,
      `${formatStudentDateTime(item.createdAt)} | ${toText(item.policyName) || "politica"} | ${toText(item.detailLevel) || "nivel"}${item.exerciseKey ? ` | ${toText(item.exerciseKey)}` : ""}`,
      truncateText(toText(item.reason) || toText(item.contextSummary), 140),
    )),
    "Sin intervenciones del tutor.",
  );

  const activityItems = detail.activity.map((item) => createDetailListItem(
    `${STUDENT_ACTIVITY_CATEGORY_LABELS[toText(item.category)] || toText(item.category) || "Actividad"}: ${toText(item.eventType)}`,
    `${pluralizeStudentCount(item.totalEvents, "evento", "eventos")}${item.totalDurationMs ? ` | ${formatStudentDuration(item.totalDurationMs / 60000)}` : ""} | ${toText(item.source) || "fuente"} | ${formatStudentRelativeTime(item.lastOccurredAt).toLowerCase()}`,
  ));
  const exerciseItems = detail.exercises.map((item) => createDetailListItem(
    `Ejercicio ${toText(item.exerciseKey)}`,
    `${pluralizeStudentCount(item.hintCount, "pista usada", "pistas usadas")} | ${formatStudentRelativeTime(item.lastInterventionAt).toLowerCase()}`,
  ));
  fillDetailList(overlayEls.studentDetailActivity, [...exerciseItems, ...activityItems], "Sin actividad registrada.");
}

function renderStudentsPanel(showingMainView) {
  if (!overlayEls?.studentsSection) return;
  const panel = overlayState.studentsPanel || { ...EMPTY_STUDENTS_PANEL_STATE };
  const allowed = showingMainView && canManageUsersSession();
  if (!allowed) {
    overlayEls.studentsSection.hidden = true;
    if (overlayEls.studentDetailSection) overlayEls.studentDetailSection.hidden = true;
    return;
  }
  overlayEls.studentsSection.hidden = !!panel.selectedId;
  if (overlayEls.studentsReloadBtn) overlayEls.studentsReloadBtn.disabled = panel.busy;
  if (overlayEls.studentsSearchInput && overlayEls.studentsSearchInput.value !== panel.query) {
    overlayEls.studentsSearchInput.value = panel.query;
  }

  const visibleCount = filterStudentsPanelItems(panel.items, panel.query).length;
  const status = panel.error
    || panel.message
    || (panel.loadedAt
      ? `${pluralizeStudentCount(visibleCount, "estudiante", "estudiantes")}${panel.query ? " coinciden" : ""}. Actualizado ${formatStudentRelativeTime(panel.generatedAt || panel.loadedAt).toLowerCase()}. Clic en una fila para ver sesiones, quices y notas.`
      : "Cargando progreso...");
  setTextIfChanged(overlayEls.studentsStatus, status);
  overlayEls.studentsStatus?.classList.toggle("is-loading-note", panel.busy);

  renderStudentsKpis(panel);
  renderStudentsTable(panel);
  renderStudentDetail(panel);
}

function bindStudentsPanel() {
  if (!overlayEls) return;
  overlayEls.studentsReloadBtn?.addEventListener("click", () => {
    loadStudentsProgress({ force: true }).catch(() => {});
  });
  overlayEls.studentsSearchInput?.addEventListener("input", (event) => {
    overlayState.studentsPanel.query = toText(event?.target?.value);
    renderStudentsPanel(true);
  });
  overlayEls.studentDetailBackBtn?.addEventListener("click", () => {
    closeStudentDetail();
  });
  overlayEls.studentDetailReloadBtn?.addEventListener("click", () => {
    const selected = overlayState.studentsPanel?.selectedId;
    if (selected) loadStudentProgressDetail(selected).catch(() => {});
  });
}
