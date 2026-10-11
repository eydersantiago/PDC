// ADACEEN | Capa 4 - UI: tema del piloto (0.7.21, piloto con FPOO-01).
// - Docente y administrador: tarjeta «Tema del piloto» arriba de la pestaña «Estudiantes»: la
//   semana de la bitácora (por defecto la de la próxima clase), el tema (se llena con el de esa
//   semana) y el repositorio público del ejercicio, con «Usar <repo>» si la página abierta es
//   un repositorio de GitHub. El administrador elige además el docente.
// - Estudiante: en Inicio, «Tema de la clase» con «Abrir el ejercicio en mi editor» (el editor en
//   la nube abre ese repositorio en su carpeta, como el botón de la página del repositorio) o
//   «Ver el ejercicio en GitHub» con Codespaces.
// Datos y backend en services/pilot-topic.service.js.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const PILOT_TOPIC_OPEN_LABEL = "Abrir el ejercicio en mi editor";
const PILOT_TOPIC_GITHUB_LABEL = "Ver el ejercicio en GitHub";
const PILOT_TOPIC_FALLBACK_WEEKS = 16;

// ---- Formulario del docente ----

// Semana por defecto: la de la próxima clase (la primera con fecha desde hoy) o la última.
function defaultPilotTopicWeek(weeks, nowMs = Date.now()) {
  if (!weeks.length) return 0;
  const todayKey = courseTodayKey(nowMs);
  const upcoming = weeks.find((week) => week.dateKey && week.dateKey >= todayKey);
  return (upcoming || weeks[weeks.length - 1]).week;
}

function findPilotTopicWeek(weeks, weekNumber) {
  return weeks.find((week) => week.week === Number(weekNumber)) || null;
}

// Borrador del formulario: se rehace solo cuando llegan datos nuevos (otro docente, otro tema o
// la primera consulta), no en cada render, para no pisar lo que se está escribiendo.
function syncPilotTopicDraft(state) {
  const key = JSON.stringify([state.teacherUserId, state.topic, state.weeks.map((week) => week.week), state.loadedAt > 0]);
  if (state.draftKey === key && state.draft) return state.draft;
  const topic = state.topic;
  const week = topic ? topic.week : defaultPilotTopicWeek(state.weeks);
  state.draft = {
    week,
    title: topic ? topic.title : findPilotTopicWeek(state.weeks, week)?.topic || "",
    repoFullName: topic ? topic.repoFullName : "",
  };
  state.draftKey = key;
  state.draftApplied = false;
  return state.draft;
}

function describePilotTopicWeekOption(week, nextClassWeek) {
  const parts = [`Semana ${week.week}`];
  if (week.dateKey) parts.push(formatCourseDay(week.dateKey));
  if (week.topic) parts.push(week.topic);
  const label = parts.join(" · ");
  const short = label.length > 100 ? `${label.slice(0, 97)}...` : label;
  return week.week === nextClassWeek ? `${short} (próxima clase)` : short;
}

function describePilotTopicSummary(topic) {
  return [
    topic.week ? `Semana ${topic.week}` : "",
    topic.title,
    topic.repoFullName ? `ejercicio ${topic.repoFullName}` : "",
  ].filter(Boolean).join(" · ");
}

function currentPagePilotRepo() {
  if (typeof parseRepoFullName !== "function") return "";
  return parseRepoFullName(location.href) || "";
}

function renderPilotTopicPanel(showingMainView) {
  const section = overlayEls?.pilotTopicSection;
  if (!section) return;
  const studentsPanel = overlayState.studentsPanel || {};
  const allowed = showingMainView && canChoosePilotTopic() && !studentsPanel.selectedId;
  section.hidden = !allowed;
  if (!allowed) return;
  const state = getPilotTopicState();
  const draft = syncPilotTopicDraft(state);
  const admin = isAdminSession();
  const busy = state.busy || state.saving;

  // Docente (solo el administrador lo elige).
  if (overlayEls.pilotTopicTeacherField) overlayEls.pilotTopicTeacherField.hidden = !admin;
  if (admin && overlayEls.pilotTopicTeacher) {
    const teachersKey = JSON.stringify([state.teachers, state.teacherUserId]);
    if (renderKeyChanged(overlayEls.pilotTopicTeacher, teachersKey)) {
      overlayEls.pilotTopicTeacher.textContent = "";
      if (!state.teachers.length) {
        const empty = document.createElement("option");
        empty.value = "";
        empty.textContent = state.loadedAt ? "No hay profesores activos" : "Cargando docentes...";
        overlayEls.pilotTopicTeacher.appendChild(empty);
      }
      for (const teacher of state.teachers) {
        const option = document.createElement("option");
        option.value = teacher.id;
        option.textContent = teacher.email ? `${teacher.displayName} (${teacher.email})` : teacher.displayName;
        overlayEls.pilotTopicTeacher.appendChild(option);
      }
      overlayEls.pilotTopicTeacher.value = state.teacherUserId;
    }
    overlayEls.pilotTopicTeacher.disabled = busy || state.teachers.length < 2;
  }

  // Semanas de la bitácora (o 1 a 16 si el docente aún no la sube), con la del tema guardado.
  const weeks = state.weeks.length
    ? [...state.weeks]
    : Array.from({ length: PILOT_TOPIC_FALLBACK_WEEKS }, (_unused, index) => ({ week: index + 1, dateKey: "", topic: "", activities: [] }));
  if (draft.week && !weeks.some((week) => week.week === draft.week)) {
    weeks.push({ week: draft.week, dateKey: "", topic: "", activities: [] });
    weeks.sort((a, b) => a.week - b.week);
  }
  const todayKey = courseTodayKey();
  const nextClassWeek = weeks.find((week) => week.dateKey && week.dateKey >= todayKey)?.week || 0;
  const weeksKey = JSON.stringify([weeks.map((week) => [week.week, week.dateKey, week.topic]), nextClassWeek, state.draftKey]);
  if (overlayEls.pilotTopicWeek && renderKeyChanged(overlayEls.pilotTopicWeek, weeksKey)) {
    overlayEls.pilotTopicWeek.textContent = "";
    const none = document.createElement("option");
    none.value = "0";
    none.textContent = "Sin semana (solo el tema)";
    overlayEls.pilotTopicWeek.appendChild(none);
    for (const week of weeks) {
      const option = document.createElement("option");
      option.value = String(week.week);
      option.textContent = describePilotTopicWeekOption(week, nextClassWeek);
      overlayEls.pilotTopicWeek.appendChild(option);
    }
    overlayEls.pilotTopicWeek.value = String(draft.week || 0);
  }
  if (!state.draftApplied) {
    if (overlayEls.pilotTopicWeek) overlayEls.pilotTopicWeek.value = String(draft.week || 0);
    if (overlayEls.pilotTopicTitleInput) overlayEls.pilotTopicTitleInput.value = draft.title;
    if (overlayEls.pilotTopicRepo) overlayEls.pilotTopicRepo.value = draft.repoFullName;
    state.draftApplied = true;
  }
  if (overlayEls.pilotTopicWeek) overlayEls.pilotTopicWeek.disabled = busy || state.unsupported;
  if (overlayEls.pilotTopicTitleInput) overlayEls.pilotTopicTitleInput.disabled = busy || state.unsupported;
  if (overlayEls.pilotTopicRepo) overlayEls.pilotTopicRepo.disabled = busy || state.unsupported;

  const pageRepo = currentPagePilotRepo();
  if (overlayEls.pilotTopicUsePageRepoBtn) {
    const show = !!pageRepo && pageRepo.toLowerCase() !== toText(draft.repoFullName).toLowerCase() && !state.unsupported;
    overlayEls.pilotTopicUsePageRepoBtn.hidden = !show;
    if (show) setTextIfChanged(overlayEls.pilotTopicUsePageRepoBtn, `Usar ${pageRepo}`);
    overlayEls.pilotTopicUsePageRepoBtn.disabled = busy;
  }

  const topic = state.topic;
  let status = "";
  if (state.error) status = state.error;
  else if (state.message) status = state.message;
  else if (state.busy && !state.loadedAt) status = "Consultando el tema del piloto...";
  else if (topic) {
    const who = topic.updatedByName ? ` Lo puso ${topic.updatedByName}.` : "";
    status = `Ahora: ${describePilotTopicSummary(topic)}. Los estudiantes lo ven en Inicio y el tutor se enfoca en esa semana.${who}`;
  } else {
    status = "Sin tema: elige la semana y el ejercicio. Los estudiantes lo verán en Inicio, con un botón para abrir el ejercicio, y el tutor se enfocará en esa semana.";
  }
  if (!state.error && !state.weeks.length && state.loadedAt && !state.unsupported) {
    status += " La bitácora del docente no trae semanas: escribe el tema a mano.";
  }
  setTextIfChanged(overlayEls.pilotTopicStatus, status);
  overlayEls.pilotTopicStatus?.classList.toggle("is-warning", !!state.error);
  overlayEls.pilotTopicStatus?.classList.toggle("is-loading-note", busy);

  const chip = topic ? (topic.week ? `Semana ${topic.week}` : "Tema puesto") : "Sin tema";
  setTextIfChanged(overlayEls.pilotTopicChip, chip);
  overlayEls.pilotTopicChip?.classList.toggle("is-ok", !!topic);
  if (overlayEls.pilotTopicSaveBtn) overlayEls.pilotTopicSaveBtn.disabled = busy || state.unsupported || (admin && !state.teacherUserId);
  if (overlayEls.pilotTopicClearBtn) overlayEls.pilotTopicClearBtn.disabled = busy || state.unsupported || !topic;
}

// ---- Inicio del estudiante ----

function renderPilotTopicHome(showingMainView) {
  const card = overlayEls?.pilotTopicHome;
  if (!card) return;
  const student = overlayState.session?.user?.role === "student";
  const courseCode = student && typeof getSelectedStudentCourseCode === "function" ? getSelectedStudentCourseCode() : "";
  const topic = student && showingMainView ? getActivePilotTopic(courseCode) : null;
  card.hidden = !topic;
  if (!topic) return;
  setTextIfChanged(overlayEls.pilotTopicHomeTitle, topic.title || `Semana ${topic.week}`);
  const meta = [
    topic.week ? `${topic.courseCode} · semana ${topic.week}` : topic.courseCode,
    topic.repoFullName ? `Ejercicio: ${topic.repoFullName}` : "",
  ].filter(Boolean).join(" · ");
  setTextIfChanged(overlayEls.pilotTopicHomeMeta, meta);
  const button = overlayEls.pilotTopicOpenBtn;
  if (button) {
    button.hidden = !topic.repoFullName;
    setTextIfChanged(button, overlayState.workspaceProvider === "codespaces" ? PILOT_TOPIC_GITHUB_LABEL : PILOT_TOPIC_OPEN_LABEL);
    button.disabled = !!overlayState.githubAppBusy;
  }
}

function openPilotTopicExercise() {
  const topic = getActivePilotTopic(typeof getSelectedStudentCourseCode === "function" ? getSelectedStudentCourseCode() : "");
  const repoFullName = toText(topic?.repoFullName);
  if (!repoFullName) return false;
  if (overlayState.workspaceProvider === "codespaces") {
    window.open(`https://github.com/${repoFullName}`, "_blank", "noopener");
    return true;
  }
  // La ventana de espera se abre dentro de openMyTunnelEditor antes de su primer await (mismo
  // clic: sin bloqueo de ventanas emergentes).
  openMyTunnelEditor({ repoFullName, buttonLabel: PILOT_TOPIC_OPEN_LABEL }).catch(() => false);
  return true;
}

// ---- Eventos ----

function bindPilotTopicPanel() {
  overlayEls.pilotTopicTeacher?.addEventListener("change", () => {
    const state = getPilotTopicState();
    const teacherUserId = toText(overlayEls.pilotTopicTeacher.value);
    if (!teacherUserId || teacherUserId === state.teacherUserId) return;
    state.teacherUserId = teacherUserId;
    state.message = "";
    refreshPilotTopic({ teacherUserId }).catch(() => {});
    renderOverlay();
  });
  overlayEls.pilotTopicWeek?.addEventListener("change", () => {
    const state = getPilotTopicState();
    const draft = syncPilotTopicDraft(state);
    const previous = findPilotTopicWeek(state.weeks, draft.week);
    const next = findPilotTopicWeek(state.weeks, overlayEls.pilotTopicWeek.value);
    draft.week = Number(overlayEls.pilotTopicWeek.value) || 0;
    // El tema sigue a la semana mientras no se haya escrito otro.
    const title = toText(overlayEls.pilotTopicTitleInput?.value);
    if (!title || title === toText(previous?.topic)) {
      draft.title = toText(next?.topic);
      if (overlayEls.pilotTopicTitleInput) overlayEls.pilotTopicTitleInput.value = draft.title;
    }
    state.message = "";
    renderOverlay();
  });
  overlayEls.pilotTopicTitleInput?.addEventListener("input", () => {
    syncPilotTopicDraft(getPilotTopicState()).title = toText(overlayEls.pilotTopicTitleInput.value);
  });
  overlayEls.pilotTopicRepo?.addEventListener("input", () => {
    syncPilotTopicDraft(getPilotTopicState()).repoFullName = toText(overlayEls.pilotTopicRepo.value);
    renderPilotTopicPanel(true);
  });
  overlayEls.pilotTopicUsePageRepoBtn?.addEventListener("click", () => {
    const repo = currentPagePilotRepo();
    if (!repo) return;
    syncPilotTopicDraft(getPilotTopicState()).repoFullName = repo;
    if (overlayEls.pilotTopicRepo) overlayEls.pilotTopicRepo.value = repo;
    renderOverlay();
  });
  overlayEls.pilotTopicSaveBtn?.addEventListener("click", async () => {
    const state = getPilotTopicState();
    const draft = syncPilotTopicDraft(state);
    draft.week = Number(overlayEls.pilotTopicWeek?.value) || 0;
    draft.title = toText(overlayEls.pilotTopicTitleInput?.value);
    draft.repoFullName = toText(overlayEls.pilotTopicRepo?.value);
    // El curso del tema guardado o, si no hay, el del contexto del docente (el de su RAG).
    const courseCode = state.topic?.courseCode || (typeof getCourseAgendaCourseCode === "function" ? getCourseAgendaCourseCode() : "FPOO");
    const result = await savePilotTopic({ ...draft, courseCode, teacherUserId: state.teacherUserId });
    overlayState.statusMessage = result.message;
    renderOverlay();
  });
  overlayEls.pilotTopicClearBtn?.addEventListener("click", async () => {
    const result = await savePilotTopic(null);
    overlayState.statusMessage = result.message;
    renderOverlay();
  });
  overlayEls.pilotTopicOpenBtn?.addEventListener("click", () => {
    openPilotTopicExercise();
  });
}
