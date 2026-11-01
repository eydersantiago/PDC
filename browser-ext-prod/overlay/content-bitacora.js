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
  // Administrador (0.7.22): al cambiar de docente se consulta la bitácora de ese docente.
  overlayEls.teacherBitacoraOwnerSelect?.addEventListener("change", async () => {
    const teacherUserId = toText(overlayEls.teacherBitacoraOwnerSelect.value);
    if (!isAdminSession() || !teacherUserId || teacherUserId === getBitacoraOwnerTeacherId()) return;
    overlayState.bitacoraOwner = { ...overlayState.bitacoraOwner, teacherUserId };
    overlayState.teacherBitacoraStatus = { ...EMPTY_TEACHER_BITACORA_STATUS };
    if (overlayEls.teacherBitacoraStartDateInput) {
      delete overlayEls.teacherBitacoraStartDateInput.dataset.userEdited;
      overlayEls.teacherBitacoraStartDateInput.value = "";
    }
    await refreshTeacherBitacoraStatus();
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
  if (!canLoadBitacoraStatus() || !overlayState.sessionId) return null;
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

// ---- Acciones ----

// Lleva a la pestana «Bitacora». pickFile: ademas abre el selector de archivo («Subir bitácora»
// de la accion recomendada; tiene que ser en el mismo clic para que el navegador lo permita).
// El foco pasa a la pestana: el boton que se pulso (en Inicio) queda oculto.
function openTeacherBitacoraTab(options = {}) {
  if (!canEditCourseBitacora()) {
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
  if (!ensureBitacoraEditable("Solo profesores pueden subir bitácoras.")) return;

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
