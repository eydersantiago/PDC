// ADACEEN | Capa 4 - UI: pagina RAG del docente anterior a la pestana «RAG» (0.7.14): curso, fuentes,
// cargar y retirar. «Configurar RAG» ya abre la pestana; la pagina y sus listeners se conservan.
// Movido sin cambios desde services/campus.service.js y overlay/content-rag.js (bindTeacherRagPage).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const CAMPUS_RAG_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

const CAMPUS_RAG_UPLOAD_TIMEOUT_MS = 120000;

const CAMPUS_RAG_UPLOAD_ACCEPT = ".pdf,.txt,.md,.doc,.docx,.html,.htm,.csv,.json,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function normalizeTeacherRagStatePayload(payload) {
  return {
    courses: Array.isArray(payload?.courses) ? payload.courses : [],
    sources: Array.isArray(payload?.sources) ? payload.sources : [],
    selectedCourseCode: toText(payload?.selectedCourseCode || payload?.courseCode || overlayState.teacherRagState?.selectedCourseCode || "FPOO") || "FPOO",
    defaultCourseCode: toText(payload?.defaultCourseCode || overlayState.teacherRagState?.defaultCourseCode || "FPOO") || "FPOO",
    busy: payload?.busy === true,
    error: toText(payload?.error),
    message: toText(payload?.message),
  };
}

// ---- Docente del RAG (administrador, 0.7.22) ----
// El administrador gestiona el RAG del docente que elige en «Docente»: cada peticion lleva su
// teacherUserId (consulta o formulario), como la bitacora (services/bitacora.service.js).
function getRagOwnerTeacherId() {
  return isAdminSession() ? toText(overlayState.ragOwner?.teacherUserId) : "";
}

function getRagOwnerName() {
  const id = getRagOwnerTeacherId();
  const teachers = Array.isArray(overlayState.ragOwner?.teachers) ? overlayState.ragOwner.teachers : [];
  const teacher = teachers.find((entry) => toText(entry?.id) === id);
  return toText(teacher?.displayName) || toText(teacher?.email);
}

function withRagOwnerQuery(url) {
  const id = getRagOwnerTeacherId();
  if (!id) return url;
  return `${url}${url.includes("?") ? "&" : "?"}teacherUserId=${encodeURIComponent(id)}`;
}

async function refreshTeacherRagSources() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !canManageRagSession()) return null;

  overlayState.teacherRagState = {
    ...normalizeTeacherRagStatePayload(overlayState.teacherRagState),
    busy: true,
    error: "",
    message: "",
  };
  renderOverlay();

  try {
    const [coursesResponse, sourcesResponse] = await Promise.all([
      fetchJsonWithTimeout(`${baseUrl}/api/rag/courses`, {
        method: "GET",
        headers: buildApiHeaders(),
      }, BACKEND_TIMEOUT_MS),
      fetchJsonWithTimeout(withRagOwnerQuery(`${baseUrl}/api/rag/sources?allCourses=true&limit=300`), {
        method: "GET",
        headers: buildApiHeaders(),
      }, BACKEND_TIMEOUT_MS),
    ]);
    // Administrador: el docente que eligio el backend (o el pedido) y la lista para elegir.
    if (isAdminSession()) {
      overlayState.ragOwner = {
        teacherUserId: toText(sourcesResponse?.teacherUserId),
        teachers: Array.isArray(sourcesResponse?.teachers) ? sourcesResponse.teachers : [],
        message: toText(sourcesResponse?.message),
      };
    }
    overlayState.teacherRagState = normalizeTeacherRagStatePayload({
      courses: coursesResponse?.courses || [],
      defaultCourseCode: coursesResponse?.defaultCourseCode || "FPOO",
      selectedCourseCode: overlayState.teacherRagState?.selectedCourseCode || coursesResponse?.defaultCourseCode || "FPOO",
      sources: sourcesResponse?.sources || [],
      message: "Fuentes RAG actualizadas.",
    });
    overlayState.teacherRagLoadedAt = Date.now();
    return overlayState.teacherRagState;
  } catch (error) {
    overlayState.teacherRagState = {
      ...normalizeTeacherRagStatePayload(overlayState.teacherRagState),
      busy: false,
      error: `No se pudo cargar RAG: ${String(error?.message || error)}`,
    };
    return null;
  } finally {
    renderOverlay();
  }
}

async function openTeacherRagPage() {
  if (!isTeacherSession()) {
    overlayState.statusMessage = "Solo profesores pueden gestionar RAG.";
    renderOverlay();
    return;
  }
  overlayState.teacherRagPageOpen = true;
  overlayState.analysisWindowOpen = false;
  renderOverlay();
  await refreshTeacherRagSources();
}

function closeTeacherRagPage() {
  overlayState.teacherRagPageOpen = false;
  renderOverlay();
}

async function selectTeacherRagCourse(courseCode) {
  overlayState.teacherRagState = {
    ...normalizeTeacherRagStatePayload(overlayState.teacherRagState),
    selectedCourseCode: toText(courseCode) || "FPOO",
    message: "",
    error: "",
  };
  renderOverlay();
}

function openTeacherRagFilePicker() {
  if (!canManageRagSession()) {
    overlayState.statusMessage = "Solo profesores pueden cargar RAG.";
    renderOverlay();
    return;
  }
  if (isAdminSession() && !getRagOwnerTeacherId()) {
    overlayState.teacherRagState = {
      ...normalizeTeacherRagStatePayload(overlayState.teacherRagState),
      error: toText(overlayState.ragOwner?.message) || "Elige el docente en cuyo RAG vas a cargar.",
    };
    renderOverlay();
    return;
  }
  const input = overlayEls?.teacherRagFileInput;
  if (!input) {
    overlayState.statusMessage = "No se encontro el selector de archivo RAG.";
    renderOverlay();
    return;
  }
  input.accept = CAMPUS_RAG_UPLOAD_ACCEPT;
  input.value = "";
  input.click();
}

// Una fuente; devuelve { ok, error }. options.batch = { index, total }: es parte de una carga de
// varios archivos (uploadTeacherRagFiles): avisa el progreso, no refresca la lista en cada uno
// ni deja su propio mensaje final.
async function uploadTeacherRagFile(file, options = {}) {
  if (!file) return { ok: false, error: "" };
  const batch = options?.batch || null;
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !canManageRagSession()) {
    overlayState.statusMessage = "Inicia sesion como profesor antes de cargar RAG.";
    renderOverlay();
    return { ok: false, error: "sin sesion de profesor" };
  }
  const ownerTeacherId = getRagOwnerTeacherId();
  if (isAdminSession() && !ownerTeacherId) {
    return { ok: false, error: "elige el docente" };
  }
  if (Number(file.size) > CAMPUS_RAG_UPLOAD_MAX_BYTES) {
    const tooBig = `supera ${Math.round(CAMPUS_RAG_UPLOAD_MAX_BYTES / (1024 * 1024))} MB`;
    if (!batch) {
      overlayState.statusMessage = `El archivo RAG ${tooBig}.`;
      renderOverlay();
    }
    return { ok: false, error: tooBig };
  }

  const state = normalizeTeacherRagStatePayload(overlayState.teacherRagState);
  const course = getSelectedTeacherRagCourse();
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("title", file.name);
  form.append("courseCode", state.selectedCourseCode || "FPOO");
  form.append("description", `Fuente RAG para ${toText(course.name || state.selectedCourseCode)}`);
  form.append("tags", `${state.selectedCourseCode},docente`);
  // Lote elegido en la pestana RAG para este curso (0.7.15); vacio = base del curso.
  const uploadLotId = toText(overlayState.ragUploadLotByCourse?.[state.selectedCourseCode]);
  if (uploadLotId) form.append("lotId", uploadLotId);
  // Administrador (0.7.22): la fuente entra al RAG del docente elegido.
  if (ownerTeacherId) form.append("teacherUserId", ownerTeacherId);

  overlayState.teacherRagState = {
    ...state,
    busy: true,
    error: "",
    message: batch ? `Cargando ${batch.index} de ${batch.total}: ${file.name}...` : `Cargando ${file.name}...`,
  };
  renderOverlay();

  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/rag/sources`, {
      method: "POST",
      headers: buildMultipartApiHeaders(),
      body: form,
    }, CAMPUS_RAG_UPLOAD_TIMEOUT_MS);
    if (!response?.ok) {
      throw new Error(toText(response?.error) || "No se pudo cargar la fuente RAG.");
    }
    if (batch) return { ok: true, error: "" };
    overlayState.teacherRagState = {
      ...normalizeTeacherRagStatePayload(overlayState.teacherRagState),
      busy: false,
      message: `${uploadLotId ? `Fuente RAG cargada en el lote elegido de ${state.selectedCourseCode}` : `Fuente RAG cargada en ${state.selectedCourseCode}`}${ownerTeacherId && getRagOwnerName() ? ` para ${getRagOwnerName()}` : ""}.`,
      error: "",
    };
    await refreshTeacherRagSources();
    return { ok: true, error: "" };
  } catch (error) {
    const reason = String(error?.message || error);
    if (batch) return { ok: false, error: reason };
    overlayState.teacherRagState = {
      ...normalizeTeacherRagStatePayload(overlayState.teacherRagState),
      busy: false,
      error: `No se pudo cargar RAG: ${reason}`,
    };
    renderOverlay();
    return { ok: false, error: reason };
  }
}

// Varias fuentes de una vez (el selector admite varios archivos, por ejemplo las guias del curso):
// una tras otra al curso y lote elegidos, la lista se refresca una vez y queda un solo resumen
// con las que no se cargaron y por que.
async function uploadTeacherRagFiles(files) {
  const list = Array.from(files || []).filter(Boolean);
  if (list.length <= 1) return uploadTeacherRagFile(list[0] || null);
  const courseCode = normalizeTeacherRagStatePayload(overlayState.teacherRagState).selectedCourseCode || "FPOO";
  const lotChosen = Boolean(toText(overlayState.ragUploadLotByCourse?.[courseCode]));
  const failed = [];
  let loaded = 0;
  for (let index = 0; index < list.length; index += 1) {
    const result = await uploadTeacherRagFile(list[index], { batch: { index: index + 1, total: list.length } });
    if (result?.ok) loaded += 1;
    else failed.push(`${list[index].name}${result?.error ? ` (${result.error})` : ""}`);
  }
  if (loaded > 0) await refreshTeacherRagSources();
  overlayState.teacherRagState = {
    ...normalizeTeacherRagStatePayload(overlayState.teacherRagState),
    busy: false,
    message: `Cargadas ${loaded} de ${list.length} fuentes en ${lotChosen ? `el lote elegido de ${courseCode}` : courseCode}${getRagOwnerTeacherId() && getRagOwnerName() ? ` para ${getRagOwnerName()}` : ""}.`,
    error: failed.length ? `No se cargaron: ${failed.join("; ")}` : "",
  };
  renderOverlay();
  return { ok: failed.length === 0, error: failed.join("; ") };
}

async function deleteTeacherRagSource(sourceId) {
  const cleanId = toText(sourceId);
  if (!cleanId) return;
  const confirmed = confirm("Se desactivara esta fuente RAG cargada por el docente. ¿Continuar?");
  if (!confirmed) return;
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !canManageRagSession()) return;

  overlayState.teacherRagState = {
    ...normalizeTeacherRagStatePayload(overlayState.teacherRagState),
    busy: true,
    error: "",
    message: "Eliminando fuente RAG...",
  };
  renderOverlay();

  try {
    const response = await fetchJsonWithTimeout(withRagOwnerQuery(`${baseUrl}/api/rag/sources/${encodeURIComponent(cleanId)}`), {
      method: "DELETE",
      headers: buildApiHeaders(),
    }, BACKEND_TIMEOUT_MS);
    if (!response?.ok) {
      throw new Error(toText(response?.error) || "No se pudo eliminar la fuente RAG.");
    }
    overlayState.teacherRagState = {
      ...normalizeTeacherRagStatePayload(overlayState.teacherRagState),
      sources: normalizeTeacherRagStatePayload(overlayState.teacherRagState).sources.filter((source) => toText(source.id) !== cleanId),
      busy: false,
      message: "Fuente RAG eliminada.",
      error: "",
    };
  } catch (error) {
    overlayState.teacherRagState = {
      ...normalizeTeacherRagStatePayload(overlayState.teacherRagState),
      busy: false,
      error: `No se pudo eliminar RAG: ${String(error?.message || error)}`,
    };
  } finally {
    renderOverlay();
  }
}

// Listeners del boton «Configurar RAG» de Inicio y de la pagina RAG anterior a la pestana (movidos desde
// ensureOverlay, content-lifecycle.js, sin cambios y en el mismo orden).
function bindTeacherRagPage() {
  // «Configurar RAG» abre la pestana RAG (0.7.14): todos los cursos a la vista, sin pagina aparte.
  overlayEls.teacherRagManageBtn?.addEventListener("click", () => {
    setMainTab("rag", { byUser: true, forceRender: true });
  });
  overlayEls.teacherRagCloseBtn?.addEventListener("click", () => {
    closeTeacherRagPage();
  });
  overlayEls.teacherRagCourseSelect?.addEventListener("change", async () => {
    await selectTeacherRagCourse(overlayEls.teacherRagCourseSelect.value);
  });
  overlayEls.teacherRagUploadBtn?.addEventListener("click", () => {
    openTeacherRagFilePicker();
  });
  overlayEls.teacherRagRefreshBtn?.addEventListener("click", async () => {
    await refreshTeacherRagSources();
  });
  overlayEls.teacherRagSourceList?.addEventListener("click", async (event) => {
    const button = event.target?.closest?.("[data-rag-delete-id]");
    if (!button) return;
    await deleteTeacherRagSource(button.getAttribute("data-rag-delete-id"));
  });
  overlayEls.teacherRagFileInput?.addEventListener("change", async () => {
    const files = Array.from(overlayEls.teacherRagFileInput.files || []);
    overlayEls.teacherRagFileInput.value = "";
    await uploadTeacherRagFiles(files);
  });
}
