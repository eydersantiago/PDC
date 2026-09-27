// ADACEEN | Capa 4 - UI: pagina de la bitacora del docente (cargar, descargar la plantilla, exportar en
// Excel/CSV, registro manual y borrar). Los listeners vienen de ensureOverlay (content-lifecycle.js) sin cambios;
// las llamadas estan en services/campus.service.js.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

// Listeners de la bitacora del docente (antes dentro de ensureOverlay, en el mismo orden).
function bindTeacherBitacoraPanel() {
  overlayEls.teacherBitacoraUploadBtn?.addEventListener("click", async () => {
    await openTeacherBitacoraPage();
  });
  overlayEls.teacherBitacoraCloseBtn?.addEventListener("click", () => {
    closeTeacherBitacoraPage();
  });
  overlayEls.teacherBitacoraDownloadTemplateBtn?.addEventListener("click", async () => {
    await downloadTeacherBitacoraTemplate();
  });
  overlayEls.teacherBitacoraExportXlsxBtn?.addEventListener("click", async () => {
    await exportTeacherBitacora("xlsx");
  });
  overlayEls.teacherBitacoraExportCsvBtn?.addEventListener("click", async () => {
    await exportTeacherBitacora("csv");
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
}

function appendBitacoraLine(parent, kind, text) {
  if (!text) return;
  const row = document.createElement("div");
  row.className = `bitacora-line bitacora-line-${kind}`;
  const label = document.createElement("span");
  label.className = "bitacora-line-label";
  const labelByKind = {
    class: "Actividad",
    evaluation: "Evaluacion",
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

function renderTeacherBitacoraAgendaList(listEl, agendaItems) {
  if (!listEl) return;
  listEl.textContent = "";
  listEl.classList.add("bitacora-week-list");
  const groups = groupTeacherBitacoraAgenda(agendaItems);
  if (!groups.length) {
    const empty = document.createElement("li");
    empty.className = "bitacora-week-item bitacora-week-empty";
    empty.textContent = "Sin registros de agenda detectados todavia.";
    listEl.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const group of groups.slice(0, 20)) {
    const li = document.createElement("li");
    li.className = "bitacora-week-item";
    const head = document.createElement("div");
    head.className = "bitacora-week-head";
    const week = document.createElement("strong");
    week.textContent = group.week ? `Semana ${group.week}` : "Sin semana";
    const date = document.createElement("span");
    date.textContent = group.dateText || "Sin fecha";
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

function renderTeacherBitacoraPage() {
  if (!overlayEls?.teacherBitacoraPage) return;
  const visible = !!overlayState.teacherBitacoraPageOpen && isTeacherSession();
  overlayEls.teacherBitacoraPage.hidden = !visible;
  if (!visible) return;

  const status = overlayState.teacherBitacoraStatus || EMPTY_TEACHER_BITACORA_STATUS;
  const item = getTeacherBitacoraDisplayItem();
  const agendaItems = Array.isArray(item?.bitacoraAgenda?.items) ? item.bitacoraAgenda.items : [];
  const statusText = status.busy
    ? "Consultando bitacora cargada..."
    : status.error
      ? status.error
      : item
        ? "Bitacora cargada. Puedes reemplazarla con un Excel/PDF actualizado."
        : "Aun no hay bitacora cargada para este docente.";

  overlayEls.teacherBitacoraStatusText.textContent = statusText;
  overlayEls.teacherBitacoraPageStatus.textContent = overlayState.documentClassifications?.error
    || overlayState.documentClassifications?.message
    || overlayState.statusMessage
    || "";
  const weekCount = agendaItems.length ? groupTeacherBitacoraAgenda(agendaItems).length : 0;
  overlayEls.teacherBitacoraLatestText.textContent = item
    ? [
      `${toText(item.fileName || item.filePath) || "bitacora"}`,
      `${weekCount} semana(s)`,
      `${agendaItems.length} registro(s)`,
      item.updatedAt || item.classifiedAt ? `Actualizado ${new Date(item.updatedAt || item.classifiedAt).toLocaleString()}` : "",
    ].filter(Boolean).join(" · ")
    : "Aun no hay bitacora cargada. Descarga la plantilla o sube un PDF/Excel.";

  renderTeacherBitacoraAgendaList(overlayEls.teacherBitacoraAgendaList, agendaItems);

  overlayEls.teacherBitacoraDownloadTemplateBtn.disabled = status.busy || overlayState.analysisBusy;
  overlayEls.teacherBitacoraChooseFileBtn.disabled = status.busy || overlayState.analysisBusy;
  // Exportar (0.7.15) solo con una bitacora cargada.
  const canExport = !status.busy && !overlayState.analysisBusy && agendaItems.length > 0;
  if (overlayEls.teacherBitacoraExportXlsxBtn) overlayEls.teacherBitacoraExportXlsxBtn.disabled = !canExport;
  if (overlayEls.teacherBitacoraExportCsvBtn) overlayEls.teacherBitacoraExportCsvBtn.disabled = !canExport;
  if (overlayEls.teacherBitacoraManualSaveBtn) {
    overlayEls.teacherBitacoraManualSaveBtn.disabled = status.busy || overlayState.analysisBusy;
  }
  if (overlayEls.teacherBitacoraManualClearBtn) {
    overlayEls.teacherBitacoraManualClearBtn.disabled = status.busy || overlayState.analysisBusy;
  }
  if (overlayEls.teacherBitacoraDeleteLatestBtn) {
    overlayEls.teacherBitacoraDeleteLatestBtn.disabled = status.busy || overlayState.analysisBusy || !item;
  }
  if (overlayEls.teacherBitacoraClearDataBtn) {
    overlayEls.teacherBitacoraClearDataBtn.disabled = status.busy || overlayState.analysisBusy || !item;
  }
}

async function openTeacherBitacoraPage() {
  if (!isTeacherSession()) {
    overlayState.statusMessage = "Solo profesores pueden gestionar bitacoras.";
    renderOverlay();
    return;
  }
  overlayState.teacherBitacoraPageOpen = true;
  overlayState.teacherRagPageOpen = false;
  overlayState.analysisWindowOpen = false;
  renderOverlay();
  await refreshTeacherBitacoraStatus();
}

function closeTeacherBitacoraPage() {
  overlayState.teacherBitacoraPageOpen = false;
  renderOverlay();
}

function clearTeacherBitacoraManualForm() {
  if (overlayEls?.teacherBitacoraManualWeekInput) overlayEls.teacherBitacoraManualWeekInput.value = "";
  if (overlayEls?.teacherBitacoraManualDateInput) overlayEls.teacherBitacoraManualDateInput.value = "";
  if (overlayEls?.teacherBitacoraManualCategorySelect) overlayEls.teacherBitacoraManualCategorySelect.value = "Actividad";
  if (overlayEls?.teacherBitacoraManualTitleInput) overlayEls.teacherBitacoraManualTitleInput.value = "";
  if (overlayEls?.teacherBitacoraManualDescriptionInput) overlayEls.teacherBitacoraManualDescriptionInput.value = "";
}

function openTeacherBitacoraFilePicker() {
  if (!isTeacherSession()) {
    overlayState.statusMessage = "Solo profesores pueden subir bitacoras.";
    renderOverlay();
    return;
  }

  const input = overlayEls?.teacherBitacoraFileInput;
  if (!input) {
    overlayState.statusMessage = "No se encontro el selector de archivo de bitacora.";
    renderOverlay();
    return;
  }

  input.accept = CAMPUS_BITACORA_UPLOAD_ACCEPT;
  input.value = "";
  input.click();
}
