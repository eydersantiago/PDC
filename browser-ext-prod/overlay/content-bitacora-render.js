"use strict";

// ADACEEN | Capa 4 - UI: «Bitácora» del docente, render de la pestaña y de la línea de Inicio (agenda, campo
// «Docente» y fecha de inicio). Movido sin cambios de content-bitacora.js.

// ---- Render ----

function appendBitacoraLine(parent, kind, text) {
  if (!text) return;
  const row = document.createElement("div");
  row.className = `bitacora-line bitacora-line-${kind}`;
  const label = document.createElement("span");
  label.className = "bitacora-line-label";
  const labelByKind = {
    class: "Actividad",
    evaluation: "Evaluación",
    project: "Proyecto",
    exercise: "Ejercicio",
    partial: "Parcial",
    quiz: "Quiz",
  };
  label.textContent = labelByKind[kind] || "Actividad";
  const body = document.createElement("span");
  body.className = "bitacora-line-body";
  body.textContent = text;
  row.append(label, body);
  parent.appendChild(row);
}

function renderTeacherBitacoraAgendaList(listEl, agendaItems, currentWeek = 0) {
  if (!listEl) return;
  listEl.textContent = "";
  listEl.classList.add("bitacora-week-list");
  const groups = groupTeacherBitacoraAgenda(agendaItems);
  if (!groups.length) {
    const empty = document.createElement("li");
    empty.className = "bitacora-week-item bitacora-week-empty";
    empty.textContent = "Sin semanas detectadas todavía.";
    listEl.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const group of groups.slice(0, 20)) {
    const li = document.createElement("li");
    const isCurrent = currentWeek > 0 && Number(group.week) === currentWeek;
    li.className = `bitacora-week-item${isCurrent ? " is-current" : ""}`;
    const head = document.createElement("div");
    head.className = "bitacora-week-head";
    const week = document.createElement("strong");
    week.textContent = group.week ? `Semana ${group.week}` : "Sin semana";
    const date = document.createElement("span");
    date.textContent = `${group.dateText || "Sin fecha"}${isCurrent ? " · esta semana" : ""}`;
    head.append(week, date);
    li.appendChild(head);

    if (group.topic) {
      const topic = document.createElement("p");
      topic.className = "bitacora-topic";
      topic.textContent = group.topic;
      li.appendChild(topic);
    }

    const body = document.createElement("div");
    body.className = "bitacora-week-lines";
    for (const classActivity of group.classActivities) appendBitacoraLine(body, "class", classActivity);
    for (const project of group.projects) appendBitacoraLine(body, "project", project);
    for (const exercise of group.exercises) appendBitacoraLine(body, "exercise", exercise);
    for (const partial of group.partials) appendBitacoraLine(body, "partial", partial);
    for (const quiz of group.quizzes) appendBitacoraLine(body, "quiz", quiz);
    for (const evaluation of group.evaluations) appendBitacoraLine(body, "evaluation", evaluation);
    li.appendChild(body);
    fragment.appendChild(li);
  }

  if (groups.length > 20) {
    const more = document.createElement("li");
    more.className = "bitacora-week-item bitacora-week-empty";
    more.textContent = `Mostrando 20 de ${groups.length} semanas detectadas.`;
    fragment.appendChild(more);
  }
  listEl.appendChild(fragment);
}

// Linea de Inicio: el estado de la bitacora y, al pulsarla, la pestana «Bitacora».
function renderTeacherBitacoraHomeLine(visible, view) {
  const line = overlayEls?.teacherBitacoraHomeLine;
  if (!line) return;
  line.hidden = !visible;
  if (!visible) return;
  let text = "Consultando la bitácora...";
  if (view.state === "loaded") text = buildTeacherBitacoraSummaryLine(view);
  else if (view.state === "missing") text = "Aún no la subes: súbela en Excel o PDF para armar la agenda del curso.";
  else if (view.state === "error") text = "Hubo un problema con la bitácora. Ábrela para ver el detalle.";
  setTextIfChanged(overlayEls.teacherBitacoraHomeText, text);
  setTeacherBitacoraChip(overlayEls.teacherBitacoraHomeChip, view.state);
  line.classList.toggle("is-missing", view.state === "missing");
  const chip = (TEACHER_BITACORA_CHIPS[view.state] || TEACHER_BITACORA_CHIPS.unknown).text.toLowerCase();
  const label = `Bitácora del curso, ${chip}: ${text.replace(/\.$/, "")}. Abre la pestaña Bitácora.`;
  if (line.getAttribute("aria-label") !== label) line.setAttribute("aria-label", label);
}

function renderTeacherBitacoraPanel(showingMainView) {
  if (!overlayEls) return;
  const allowed = showingMainView && canEditCourseBitacora();
  if (overlayEls.teacherBitacoraSection) overlayEls.teacherBitacoraSection.hidden = !allowed;
  if (!allowed) {
    if (overlayEls.teacherBitacoraHomeLine) overlayEls.teacherBitacoraHomeLine.hidden = true;
    if (overlayEls.tabFlagBitacora) overlayEls.tabFlagBitacora.hidden = true;
    return;
  }
  const admin = isAdminSession();
  const view = getTeacherBitacoraView();
  // La linea de Inicio y la marca de la pestaña son del docente (su propia bitácora).
  renderTeacherBitacoraHomeLine(!admin, view);
  if (overlayEls.tabFlagBitacora) overlayEls.tabFlagBitacora.hidden = admin || view.state !== "missing";

  const { status } = view;
  const ownerMissing = admin && !getBitacoraOwnerTeacherId();
  const working = !!status.busy || !!overlayState.analysisBusy || ownerMissing;
  renderTeacherBitacoraOwnerField(admin, !!status.busy || !!overlayState.analysisBusy);
  const uploading = !!overlayState.analysisBusy && !!overlayState.documentClassifications?.busy;
  // Semana de hoy segun la bitacora (0.7.17), la misma que ven los estudiantes en «Agenda».
  const course = typeof getCourseAgendaView === "function" ? getCourseAgendaView() : null;
  const currentWeek = course?.state === "current" && course.current ? course.current.week : 0;
  const ownerName = admin ? getBitacoraOwnerName() : "";
  let statusText = "Abre la pestaña para consultar la bitácora.";
  if (status.checking) statusText = "Consultando la bitácora cargada...";
  else if (status.error) statusText = status.error;
  else if (ownerMissing) statusText = toText(overlayState.bitacoraOwner?.message) || "Elige el docente de la bitácora.";
  else if (view.state === "loaded") {
    const loadedFor = ownerName ? `Cargada para ${ownerName}.` : "Cargada.";
    statusText = currentWeek
      ? `${loadedFor} Hoy va en la semana ${currentWeek} de ${course.totalWeeks}. Si subes otra, reemplaza a esta.`
      : `${loadedFor} Si subes otra, reemplaza a esta.`;
  }
  else if (view.state === "missing") {
    statusText = ownerName
      ? `${ownerName} aún no tiene bitácora. Súbela aquí: con ella ADACEEN arma la agenda del curso y sus estudiantes pueden analizar Campus.`
      : "Aún no has subido la bitácora. Con ella ADACEEN arma la agenda del curso y tus estudiantes pueden analizar Campus.";
  }
  setTextIfChanged(overlayEls.teacherBitacoraStatusText, statusText);
  overlayEls.teacherBitacoraStatusText?.classList.toggle("is-warning", !!status.error);
  setTeacherBitacoraChip(overlayEls.teacherBitacoraStateChip, view.state);

  const zone = overlayEls.teacherBitacoraDropZone;
  zone?.classList.toggle("is-loaded", view.state === "loaded");
  zone?.classList.toggle("is-busy", uploading);
  setTextIfChanged(
    overlayEls.teacherBitacoraLatestText,
    uploading
      ? toText(overlayState.documentClassifications?.message) || "Subiendo la bitácora..."
      : (view.state === "loaded" ? buildTeacherBitacoraSummaryLine(view) : "Aún no hay bitácora cargada."),
  );
  setTextIfChanged(
    overlayEls.teacherBitacoraDropHint,
    view.state === "loaded"
      ? "Para cambiarla, arrastra aquí el Excel o el PDF nuevo, o elígelo con el botón."
      : "Arrastra aquí el Excel o el PDF de la bitácora, o elígelo con el botón. Si aún no la tienes, descarga la plantilla.",
  );

  // «Actualizar» sigue activo sin docente elegido: vuelve a pedir la lista.
  if (overlayEls.teacherBitacoraRefreshBtn) overlayEls.teacherBitacoraRefreshBtn.disabled = !!status.busy || !!overlayState.analysisBusy;
  if (overlayEls.teacherBitacoraChooseFileBtn) overlayEls.teacherBitacoraChooseFileBtn.disabled = working;
  if (overlayEls.teacherBitacoraDownloadTemplateBtn) overlayEls.teacherBitacoraDownloadTemplateBtn.disabled = working;
  // Exportar (0.7.15) solo con una bitacora cargada.
  const canExport = !working && view.agendaItems.length > 0;
  if (overlayEls.teacherBitacoraExportXlsxBtn) overlayEls.teacherBitacoraExportXlsxBtn.disabled = !canExport;
  if (overlayEls.teacherBitacoraExportCsvBtn) overlayEls.teacherBitacoraExportCsvBtn.disabled = !canExport;
  if (overlayEls.teacherBitacoraManualSaveBtn) overlayEls.teacherBitacoraManualSaveBtn.disabled = working;
  if (overlayEls.teacherBitacoraManualClearBtn) overlayEls.teacherBitacoraManualClearBtn.disabled = working;
  if (overlayEls.teacherBitacoraDeleteLatestBtn) overlayEls.teacherBitacoraDeleteLatestBtn.disabled = working || !view.item;
  if (overlayEls.teacherBitacoraClearDataBtn) overlayEls.teacherBitacoraClearDataBtn.disabled = working || !view.item;

  if (overlayEls.teacherBitacoraWeekCount) {
    overlayEls.teacherBitacoraWeekCount.hidden = !view.weekCount;
    setTextIfChanged(overlayEls.teacherBitacoraWeekCount, view.weekCount ? String(view.weekCount) : "");
  }
  const listEl = overlayEls.teacherBitacoraAgendaList;
  const agendaKey = JSON.stringify([toText(view.item?.id), view.updatedAt, view.agendaItems.length, view.state, currentWeek]);
  if (listEl && renderKeyChanged(listEl, agendaKey)) {
    renderTeacherBitacoraAgendaList(listEl, view.agendaItems, currentWeek);
  }
  renderTeacherBitacoraStartRow(view, course, working);
}

// Selector «Docente» del administrador (0.7.22): los docentes activos que trae el estado.
function renderTeacherBitacoraOwnerField(visible, busy) {
  const field = overlayEls?.teacherBitacoraOwnerField;
  const select = overlayEls?.teacherBitacoraOwnerSelect;
  if (!field || !select) return;
  field.hidden = !visible;
  if (!visible) return;
  const owner = overlayState.bitacoraOwner || EMPTY_BITACORA_OWNER_STATE;
  const teachers = Array.isArray(owner.teachers) ? owner.teachers : [];
  const key = JSON.stringify(teachers.map((teacher) => [toText(teacher?.id), toText(teacher?.displayName), toText(teacher?.email)]));
  if (renderKeyChanged(select, key)) {
    select.textContent = "";
    if (!teachers.length) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = owner.message ? "Sin docentes activos" : "Consultando docentes...";
      select.appendChild(empty);
    }
    teachers.forEach((teacher) => {
      const option = document.createElement("option");
      option.value = toText(teacher.id);
      const name = toText(teacher.displayName) || toText(teacher.email);
      option.textContent = teacher.email && name !== teacher.email ? `${name} · ${toText(teacher.email)}` : name;
      select.appendChild(option);
    });
  }
  const teacherUserId = toText(owner.teacherUserId);
  if (teacherUserId && select.value !== teacherUserId) select.value = teacherUserId;
  select.disabled = busy || teachers.length < 2;
}

// «Inicio del semestre» (0.7.17): la fecha de la semana 1 y hasta donde llega la bitacora.
function renderTeacherBitacoraStartRow(view, course, working) {
  const input = overlayEls?.teacherBitacoraStartDateInput;
  const weeks = course?.weeks || [];
  const first = weeks.find((week) => week.dateKey) || null;
  const last = [...weeks].reverse().find((week) => week.dateKey) || null;
  if (input && first && input.dataset.userEdited !== "1" && input.value !== first.dateKey) {
    input.value = first.dateKey;
  }
  if (input) input.disabled = working || !view.item;
  if (overlayEls.teacherBitacoraStartApplyBtn) {
    overlayEls.teacherBitacoraStartApplyBtn.disabled = working || !view.item || !toText(input?.value);
  }
  setTextIfChanged(
    overlayEls.teacherBitacoraStartNote,
    first && last
      ? `Semana 1: ${formatCourseDay(first.dateKey)} · semana ${last.week}: ${formatCourseDay(last.dateKey)}. Al cambiar la fecha, todas las semanas se corren igual (cada 7 días).`
      : "La semana 1 queda ese día y las demás conservan su distancia (cada 7 días).",
  );
}
