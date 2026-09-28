// ADACEEN | Capa 4 - UI: bitacora del docente. Desde la 0.7.16 es la pestana «Bitacora» (antes una
// pagina aparte que se abria con el boton «Bitacora» de Inicio, poco visible): el estado arriba,
// «Subir bitácora (Excel/PDF)» con una zona para soltar el archivo, la plantilla y exportar (Excel/CSV),
// y plegados las semanas cargadas, el registro manual y borrar. En Inicio, una linea con el estado
// lleva a la pestana. Las llamadas estan en services/bitacora.service.js.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

// El estado se reutiliza un minuto al volver a la pestana (como «Quices» y «RAG»).
const TEACHER_BITACORA_STALE_MS = 60 * 1000;

// Archivos que acepta la bitacora (los mismos que el selector: CAMPUS_BITACORA_UPLOAD_ACCEPT).
const TEACHER_BITACORA_FILE_PATTERN = /\.(xlsx|xls|pdf)$/i;

// Listeners de la bitacora del docente (llamada desde ensureOverlay, content-lifecycle.js).
function bindTeacherBitacoraPanel() {
  overlayEls.teacherBitacoraHomeLine?.addEventListener("click", () => {
    openTeacherBitacoraTab();
  });
  overlayEls.teacherBitacoraRefreshBtn?.addEventListener("click", async () => {
    await refreshTeacherBitacoraStatus();
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
  overlayEls.teacherBitacoraStartDateInput?.addEventListener("input", () => {
    overlayEls.teacherBitacoraStartDateInput.dataset.userEdited = "1";
    if (overlayEls.teacherBitacoraStartApplyBtn) overlayEls.teacherBitacoraStartApplyBtn.disabled = !overlayEls.teacherBitacoraStartDateInput.value;
  });
  overlayEls.teacherBitacoraStartApplyBtn?.addEventListener("click", async () => {
    const input = overlayEls.teacherBitacoraStartDateInput;
    const applied = await applyTeacherBitacoraStartDate(input?.value);
    if (applied && input) {
      delete input.dataset.userEdited;
      renderOverlay();
    }
  });
  overlayEls.teacherBitacoraFileInput?.addEventListener("change", async () => {
    const file = overlayEls.teacherBitacoraFileInput.files?.[0] || null;
    overlayEls.teacherBitacoraFileInput.value = "";
    await uploadTeacherBitacoraFile(file);
  });
  bindTeacherBitacoraDropZone();
}

// ---- Arrastrar y soltar ----

function isFileDragEvent(event) {
  const types = event?.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types).includes("Files");
}

function isAcceptedTeacherBitacoraFile(file) {
  return TEACHER_BITACORA_FILE_PATTERN.test(toText(file?.name));
}

function setTeacherBitacoraDropHighlight(active) {
  overlayEls?.teacherBitacoraDropZone?.classList?.toggle("is-dragover", !!active);
}

// Toda la pestana recibe el archivo (la zona se resalta al pasar por encima). Soltar un archivo en
// cualquier otra parte de la ventana no hace nada: sin esto el navegador lo abriria y la pagina
// se iria. Los eventos siguen subiendo a la pagina (sin stopPropagation) para no dejar a medias
// sus propios avisos de arrastre; preventDefault le indica que el archivo ya se uso.
function bindTeacherBitacoraDropZone() {
  const target = overlayEls?.tabPanelBitacora;
  if (!target) return;
  let depth = 0;
  target.addEventListener("dragenter", (event) => {
    if (!isFileDragEvent(event)) return;
    event.preventDefault();
    depth += 1;
    setTeacherBitacoraDropHighlight(true);
  });
  target.addEventListener("dragover", (event) => {
    if (!isFileDragEvent(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  target.addEventListener("dragleave", (event) => {
    if (!isFileDragEvent(event)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) setTeacherBitacoraDropHighlight(false);
  });
  target.addEventListener("drop", async (event) => {
    if (!isFileDragEvent(event)) return;
    event.preventDefault();
    depth = 0;
    setTeacherBitacoraDropHighlight(false);
    await handleDroppedTeacherBitacoraFile(event.dataTransfer?.files?.[0] || null);
  });
  // Fuera de la pestana el cursor dice que ahi no se puede soltar (dropEffect "none").
  const windowEl = overlayEls?.window;
  windowEl?.addEventListener("dragover", (event) => {
    if (!isFileDragEvent(event) || event.defaultPrevented) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
  });
  windowEl?.addEventListener("drop", (event) => {
    if (isFileDragEvent(event)) event.preventDefault();
  });
}

async function handleDroppedTeacherBitacoraFile(file) {
  if (!file) return;
  const status = overlayState.teacherBitacoraStatus || EMPTY_TEACHER_BITACORA_STATUS;
  if (status.busy || overlayState.analysisBusy) {
    overlayState.statusMessage = "Espera a que termine lo que está en curso y vuelve a soltar el archivo.";
    renderOverlay();
    return;
  }
  if (!isAcceptedTeacherBitacoraFile(file)) {
    overlayState.statusMessage = `«${toText(file.name) || "Ese archivo"}» no es un Excel (.xlsx, .xls) ni un PDF: sube la bitácora en uno de esos formatos.`;
    renderOverlay();
    return;
  }
  await uploadTeacherBitacoraFile(file);
}

// ---- Estado ----

// Consulta el estado al abrir la pestana (se reutiliza un minuto) y, con onlyIfUnchecked, una
// sola vez al entrar para la linea de Inicio, la accion recomendada y la semana del tutor
// (content-tutor.js). Docente y estudiante (su agenda, 0.7.17). Devuelve la consulta, si la hay.
function ensureTeacherBitacoraLoaded(options = {}) {
  if (!canReadCourseBitacora() || !overlayState.sessionId) return null;
  const status = overlayState.teacherBitacoraStatus || EMPTY_TEACHER_BITACORA_STATUS;
  if (status.busy) return null;
  const checkedAt = Number(status.checkedAt) || 0;
  if (checkedAt && (options.onlyIfUnchecked || Date.now() - checkedAt <= TEACHER_BITACORA_STALE_MS)) return null;
  const request = refreshTeacherBitacoraStatus();
  request.catch(() => {});
  return request;
}

// true cuando el backend ya respondio que este docente no tiene bitacora cargada.
function isTeacherBitacoraMissing() {
  if (!isTeacherSession()) return false;
  const status = overlayState.teacherBitacoraStatus || EMPTY_TEACHER_BITACORA_STATUS;
  return Number(status.checkedAt) > 0 && !status.checking && !status.error && !getTeacherBitacoraDisplayItem();
}

// Semanas de la agenda: se agrupa una vez por agenda (renderOverlay corre muchas veces).
let teacherBitacoraWeekCountCache = { items: null, count: 0 };

function countTeacherBitacoraWeeks(agendaItems) {
  if (!agendaItems.length) return 0;
  if (teacherBitacoraWeekCountCache.items !== agendaItems) {
    teacherBitacoraWeekCountCache = { items: agendaItems, count: groupTeacherBitacoraAgenda(agendaItems).length };
  }
  return teacherBitacoraWeekCountCache.count;
}

// Lo que muestran la linea de Inicio y la pestana. state: "busy" | "loaded" | "missing" | "error" | "unknown".
function getTeacherBitacoraView() {
  const status = overlayState.teacherBitacoraStatus || EMPTY_TEACHER_BITACORA_STATUS;
  const item = getTeacherBitacoraDisplayItem();
  const agendaItems = Array.isArray(item?.bitacoraAgenda?.items) ? item.bitacoraAgenda.items : [];
  const weekCount = countTeacherBitacoraWeeks(agendaItems);
  const rowCount = agendaItems.length || Math.max(0, Number(status.summary?.rows) || 0);
  // Con una bitacora cargada el estado sigue "loaded" aunque se este consultando o descargando.
  let state = "unknown";
  if (item) state = "loaded";
  else if (status.checking) state = "busy";
  else if (status.error) state = "error";
  else if (Number(status.checkedAt) > 0) state = "missing";
  return {
    status,
    item,
    agendaItems,
    weekCount,
    rowCount,
    state,
    fileName: item ? (toText(item.fileName || item.filePath || item.title) || "bitácora") : "",
    updatedAt: item ? toText(item.updatedAt || item.classifiedAt || status.summary?.updatedAt) : "",
  };
}

const TEACHER_BITACORA_CHIPS = Object.freeze({
  busy: { text: "Consultando", kind: "" },
  loaded: { text: "Cargada", kind: "is-ok" },
  missing: { text: "Falta", kind: "is-warn" },
  error: { text: "Error", kind: "is-warn" },
  unknown: { text: "Sin consultar", kind: "" },
});

function setTeacherBitacoraChip(chip, state) {
  if (!chip) return;
  const config = TEACHER_BITACORA_CHIPS[state] || TEACHER_BITACORA_CHIPS.unknown;
  setTextIfChanged(chip, config.text);
  chip.classList.toggle("is-ok", config.kind === "is-ok");
  chip.classList.toggle("is-warn", config.kind === "is-warn");
}

function describeTeacherBitacoraUpdate(value) {
  const text = toText(value);
  if (!text || Number.isNaN(Date.parse(text))) return "";
  return `actualizada ${formatStudentRelativeTime(text).toLowerCase()}`;
}

// Resumen de una linea: archivo, semanas (o registros) y cuando se actualizo.
function buildTeacherBitacoraSummaryLine(view) {
  return [
    view.fileName,
    view.weekCount
      ? pluralizeStudentCount(view.weekCount, "semana", "semanas")
      : (view.rowCount ? pluralizeStudentCount(view.rowCount, "registro", "registros") : ""),
    describeTeacherBitacoraUpdate(view.updatedAt),
  ].filter(Boolean).join(" · ");
}

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
  const allowed = showingMainView && isTeacherSession();
  if (overlayEls.teacherBitacoraSection) overlayEls.teacherBitacoraSection.hidden = !allowed;
  if (!allowed) {
    if (overlayEls.teacherBitacoraHomeLine) overlayEls.teacherBitacoraHomeLine.hidden = true;
    if (overlayEls.tabFlagBitacora) overlayEls.tabFlagBitacora.hidden = true;
    return;
  }
  const view = getTeacherBitacoraView();
  renderTeacherBitacoraHomeLine(true, view);
  if (overlayEls.tabFlagBitacora) overlayEls.tabFlagBitacora.hidden = view.state !== "missing";

  const { status } = view;
  const working = !!status.busy || !!overlayState.analysisBusy;
  const uploading = !!overlayState.analysisBusy && !!overlayState.documentClassifications?.busy;
  // Semana de hoy segun la bitacora (0.7.17), la misma que ven los estudiantes en «Agenda».
  const course = typeof getCourseAgendaView === "function" ? getCourseAgendaView() : null;
  const currentWeek = course?.state === "current" && course.current ? course.current.week : 0;
  let statusText = "Abre la pestaña para consultar la bitácora.";
  if (status.checking) statusText = "Consultando la bitácora cargada...";
  else if (status.error) statusText = status.error;
  else if (view.state === "loaded") {
    statusText = currentWeek
      ? `Cargada. Hoy va en la semana ${currentWeek} de ${course.totalWeeks}. Si subes otra, reemplaza a esta.`
      : "Cargada. Si subes otra, reemplaza a esta.";
  }
  else if (view.state === "missing") {
    statusText = "Aún no has subido la bitácora. Con ella ADACEEN arma la agenda del curso y tus estudiantes pueden analizar Campus.";
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

  if (overlayEls.teacherBitacoraRefreshBtn) overlayEls.teacherBitacoraRefreshBtn.disabled = working;
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

// ---- Acciones ----

// Lleva a la pestana «Bitacora». pickFile: ademas abre el selector de archivo («Subir bitácora»
// de la accion recomendada; tiene que ser en el mismo clic para que el navegador lo permita).
// El foco pasa a la pestana: el boton que se pulso (en Inicio) queda oculto.
function openTeacherBitacoraTab(options = {}) {
  if (!isTeacherSession()) {
    overlayState.statusMessage = "Solo profesores pueden gestionar la bitácora.";
    renderOverlay();
    return;
  }
  overlayState.teacherRagPageOpen = false;
  overlayState.analysisWindowOpen = false;
  setMainTab("bitacora", { byUser: true, forceRender: true, focus: options.focus !== false });
  if (options.pickFile) openTeacherBitacoraFilePicker();
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
    overlayState.statusMessage = "Solo profesores pueden subir bitácoras.";
    renderOverlay();
    return;
  }

  const input = overlayEls?.teacherBitacoraFileInput;
  if (!input) {
    overlayState.statusMessage = "No se encontró el selector de archivo de la bitácora.";
    renderOverlay();
    return;
  }

  input.accept = CAMPUS_BITACORA_UPLOAD_ACCEPT;
  input.value = "";
  input.click();
}
