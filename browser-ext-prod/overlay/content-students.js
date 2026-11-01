// ADACEEN | Capa 4 - UI: pestanas de la vista principal y pestana "Estudiantes" (0.7.13).
// Las pestanas reparten la vista principal por rol para que cada una quepa en la ventana
// sin scroll largo: Inicio (contexto y resumen), Tutor (pistas del estudiante),
// Agenda (solo estudiante, content-agenda.js), Estudiantes (sesiones, intervenciones, quices y
// nota; docente y administrador), RAG, Quices y Bitacora (solo docente; content-rag.js,
// content-quizzes.js y content-bitacora.js) y Usuarios (administracion). El panel de estudiantes habla con GET /api/admin/students
// y GET /api/admin/students/:userId (services/backend.service.js).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

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
  const scale = formatStudentGradeScale5(grade);
  return `${grade.score}/100${scale ? ` | ${scale}` : ""}`;
}

// La nota en la escala de 0 a 5 («3,7/5»); "" si no hay.
function formatStudentGradeScale5(grade) {
  if (!grade || grade.scale5 === null || grade.scale5 === undefined) return "";
  return `${String(grade.scale5).replace(".", ",")}/5`;
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

// Casillas, «Importar lista» y «Agregar estudiante» (0.7.22), como en «Usuarios». La selección
// se limpia de quien ya no está en la lista; «Seleccionar todos» toma los que muestra la búsqueda.
function renderStudentsManagement(panel, visibleItems) {
  const busy = !!overlayState.adminUsersBusy;
  const present = new Set(panel.items.map((item) => toText(item.id)));
  const checkedIds = getAdminSelection("students").filter((id) => present.has(id));
  if (checkedIds.length !== getAdminSelection("students").length) setAdminSelection("students", checkedIds);
  if (panel.editingId && !present.has(toText(panel.editingId))) panel.editingId = "";
  renderAdminBulkBar({
    bar: overlayEls.studentsBulkBar,
    count: overlayEls.studentsBulkCount,
    deleteBtn: overlayEls.studentsBulkDeleteBtn,
    clearBtn: overlayEls.studentsBulkClearBtn,
    selectAll: overlayEls.studentsSelectAll,
  }, checkedIds.length, visibleItems.map((item) => toText(item.id)), new Set(checkedIds), busy);

  const importState = typeof getAdminImportState === "function" ? getAdminImportState() : { open: false, busy: false };
  if (overlayEls.studentsToggleImportBtn) {
    overlayEls.studentsToggleImportBtn.disabled = busy || !!importState.busy;
    setTextIfChanged(overlayEls.studentsToggleImportBtn, importState.open ? "Ocultar importación" : "Importar lista");
    overlayEls.studentsToggleImportBtn.setAttribute("aria-expanded", importState.open ? "true" : "false");
  }
  if (overlayEls.studentsToggleCreateBtn) {
    const open = !!overlayState.adminCreateFormOpen;
    overlayEls.studentsToggleCreateBtn.disabled = busy;
    setTextIfChanged(overlayEls.studentsToggleCreateBtn, open ? "Ocultar formulario" : "Agregar estudiante");
    overlayEls.studentsToggleCreateBtn.setAttribute("aria-expanded", open ? "true" : "false");
  }
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

  const visibleItems = filterStudentsPanelItems(panel.items, panel.query);
  const visibleCount = visibleItems.length;
  renderStudentsManagement(panel, visibleItems);
  const status = panel.error
    || panel.actionMessage
    || panel.message
    || (panel.loadedAt
      ? `${pluralizeStudentCount(visibleCount, "estudiante", "estudiantes")}${panel.query ? " coinciden" : ""}. Actualizado ${formatStudentRelativeTime(panel.generatedAt || panel.loadedAt).toLowerCase()}. Clic en una fila para ver sesiones, quices y notas.`
      : "Cargando progreso...");
  setTextIfChanged(overlayEls.studentsStatus, status);
  overlayEls.studentsStatus?.classList.toggle("is-loading-note", panel.busy || (!!overlayState.adminUsersBusy && !!panel.actionMessage));

  renderStudentsKpis(panel);
  renderStudentsTable(panel);
  renderStudentDetail(panel);
}

function bindStudentsPanel() {
  if (!overlayEls) return;
  overlayEls.studentsReloadBtn?.addEventListener("click", () => {
    overlayState.studentsPanel.actionMessage = "";
    loadStudentsProgress({ force: true }).catch(() => {});
  });
  overlayEls.studentsSearchInput?.addEventListener("input", (event) => {
    overlayState.studentsPanel.query = toText(event?.target?.value);
    overlayState.studentsPanel.actionMessage = "";
    renderStudentsPanel(true);
  });
  // Gestión como en «Usuarios» (0.7.22).
  overlayEls.studentsSelectAll?.addEventListener("change", () => {
    const panel = overlayState.studentsPanel;
    const visibleIds = filterStudentsPanelItems(panel.items, panel.query).map((item) => toText(item.id));
    setAdminSelectionForVisible("students", visibleIds, overlayEls.studentsSelectAll.checked === true);
  });
  overlayEls.studentsBulkClearBtn?.addEventListener("click", () => {
    setAdminSelection("students", []);
    renderStudentsPanel(true);
  });
  overlayEls.studentsBulkDeleteBtn?.addEventListener("click", async () => {
    await deleteAdminStudents("students", getAdminSelection("students"));
  });
  overlayEls.studentsToggleCreateBtn?.addEventListener("click", () => {
    if (!canManageUsersSession() || overlayState.adminUsersBusy) return;
    overlayState.adminCreateFormOpen = !overlayState.adminCreateFormOpen;
    if (overlayState.adminCreateFormOpen) {
      // Desde «Estudiantes» se agrega un estudiante; el rol se puede cambiar en el formulario.
      if (overlayEls.adminCreateRole) overlayEls.adminCreateRole.value = "student";
      if (typeof getAdminImportState === "function") getAdminImportState().open = false;
    }
    renderOverlay();
  });
  overlayEls.studentDetailBackBtn?.addEventListener("click", () => {
    closeStudentDetail();
  });
  overlayEls.studentDetailReloadBtn?.addEventListener("click", () => {
    const selected = overlayState.studentsPanel?.selectedId;
    if (selected) loadStudentProgressDetail(selected).catch(() => {});
  });
}

// «Recargar» de la telemetria reciente (movido desde ensureOverlay, content-lifecycle.js, sin cambios).
function bindTeacherTelemetryReload() {
  overlayEls.reloadTelemetryBtn?.addEventListener("click", async () => {
    await reloadPolicyAndTelemetry();
    renderOverlay();
  });
}
