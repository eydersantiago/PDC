// ADACEEN | Capa 3 - Servicios: fuentes RAG por curso que administra el docente.
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

function getSelectedTeacherRagCourse() {
  const state = normalizeTeacherRagStatePayload(overlayState.teacherRagState);
  return state.courses.find((course) => toText(course?.code) === state.selectedCourseCode)
    || state.courses.find((course) => course?.isDefault)
    || { code: state.selectedCourseCode || "FPOO", name: "FPOO", materialUrl: "", isDefault: true };
}

function renderTeacherRagCourseOptions(state) {
  const select = overlayEls?.teacherRagCourseSelect;
  if (!select) return;
  const current = state.selectedCourseCode || "FPOO";
  select.textContent = "";
  const courses = state.courses.length
    ? state.courses
    : [{ code: "FPOO", name: "FPOO", isDefault: true }];
  for (const course of courses) {
    const option = document.createElement("option");
    option.value = toText(course.code);
    option.textContent = `${toText(course.code)} - ${toText(course.name || course.shortName)}`;
    select.appendChild(option);
  }
  select.value = current;
}

function renderTeacherRagCourseSummary(summaryEl, items) {
  if (!summaryEl) return;
  summaryEl.textContent = "";
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    if (!item?.label) continue;
    const chip = document.createElement("span");
    chip.className = `rag-course-stat ${item.kind ? `is-${item.kind}` : ""}`.trim();
    chip.textContent = item.label;
    fragment.appendChild(chip);
  }
  summaryEl.appendChild(fragment);
}

function formatRagSourceCount(count, singular, plural) {
  const value = Math.max(0, Number(count) || 0);
  if (value === 0) return `Sin ${plural}`;
  if (value === 1) return `1 ${singular}`;
  return `${value} ${plural}`;
}

function formatTeacherRagCount(count) {
  const value = Math.max(0, Number(count) || 0);
  if (value === 0) return "Sin fuentes del docente";
  if (value === 1) return "1 fuente del docente";
  return `${value} fuentes del docente`;
}

function getTeacherRagCourseByCode(state, courseCode) {
  const selectedCode = toText(courseCode || state?.selectedCourseCode || "FPOO") || "FPOO";
  return (Array.isArray(state?.courses) ? state.courses : [])
    .find((course) => toText(course?.code) === selectedCode)
    || { code: selectedCode, name: selectedCode, shortName: selectedCode, materialUrl: "" };
}

function buildEmptyTeacherRagSourceMessage(state, selectedCourseCode) {
  const course = getTeacherRagCourseByCode(state, selectedCourseCode);
  const code = toText(course.code || selectedCourseCode || "FPOO") || "FPOO";
  const name = toText(course.name || course.shortName);
  const label = name && name !== code ? `${code} (${name})` : code;
  const hasMaterial = !!toText(course.materialUrl);
  return hasMaterial
    ? `Sin fuentes RAG activas para ${label}. El material base esta enlazado, pero falta cargar una fuente del docente para este curso.`
    : `Sin fuentes RAG activas para ${label}. Carga una fuente del docente para habilitar este curso.`;
}

function renderTeacherRagSourceList(listEl, state) {
  if (!listEl) return;
  listEl.textContent = "";
  const selectedCourseCode = state.selectedCourseCode || "FPOO";
  const sources = state.sources.filter((source) => toText(source.courseCode || source.metadata?.courseCode || "FPOO") === selectedCourseCode);
  if (!sources.length) {
    const empty = document.createElement("li");
    empty.className = "rag-source-item";
    empty.textContent = buildEmptyTeacherRagSourceMessage(state, selectedCourseCode);
    listEl.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const source of sources) {
    const li = document.createElement("li");
    li.className = "rag-source-item";

    const head = document.createElement("div");
    head.className = "rag-source-head";
    const titleBox = document.createElement("div");
    const title = document.createElement("div");
    title.className = "rag-source-title";
    title.textContent = toText(source.title || source.fileName || "Fuente RAG");
    const meta = document.createElement("div");
    meta.className = "rag-source-meta";
    meta.textContent = [
      toText(source.fileName),
      `${Math.round((Number(source.textLength) || 0) / 1000)}k chars`,
      source.createdAt ? new Date(source.createdAt).toLocaleDateString() : "",
    ].filter(Boolean).join(" · ");
    titleBox.append(title, meta);
    head.appendChild(titleBox);

    if (source.scope === "teacher") {
      const removeBtn = document.createElement("button");
      removeBtn.className = "ghost-button danger-button";
      removeBtn.type = "button";
      removeBtn.setAttribute("data-rag-delete-id", toText(source.id));
      removeBtn.textContent = "Eliminar";
      head.appendChild(removeBtn);
    }
    li.appendChild(head);

    const tags = document.createElement("div");
    tags.className = "rag-source-tags";
    for (const tagText of [
      selectedCourseCode,
      source.scope === "default" ? "Default" : "Docente",
      toText(source.sourceType || "documento"),
    ]) {
      const tag = document.createElement("span");
      tag.className = "rag-source-tag";
      tag.textContent = tagText;
      tags.appendChild(tag);
    }
    li.appendChild(tags);

    if (source.textPreview) {
      const preview = document.createElement("div");
      preview.className = "rag-source-meta";
      preview.textContent = toText(source.textPreview).slice(0, 180);
      li.appendChild(preview);
    }
    fragment.appendChild(li);
  }
  listEl.appendChild(fragment);
}

function renderTeacherRagPage() {
  if (!overlayEls?.teacherRagPage) return;
  const visible = !!overlayState.teacherRagPageOpen && isTeacherSession();
  overlayEls.teacherRagPage.hidden = !visible;
  if (!visible) return;

  const state = normalizeTeacherRagStatePayload(overlayState.teacherRagState);
  const course = getSelectedTeacherRagCourse();
  const sources = state.sources.filter((source) => toText(source.courseCode || source.metadata?.courseCode || "FPOO") === state.selectedCourseCode);
  const defaultCount = sources.filter((source) => source.scope === "default").length;
  const teacherCount = sources.filter((source) => source.scope === "teacher").length;
  const courseCode = toText(course.code || state.selectedCourseCode || "FPOO");
  const courseName = toText(course.name || course.shortName || courseCode);
  renderTeacherRagCourseOptions(state);
  overlayEls.teacherRagStatusText.textContent = state.busy
    ? "Actualizando fuentes RAG..."
    : state.error
      ? state.error
      : "FPOO queda como RAG por defecto; puedes cargar fuentes por curso.";
  if (overlayEls.teacherRagCourseCode) overlayEls.teacherRagCourseCode.textContent = courseCode;
  if (overlayEls.teacherRagCourseName) overlayEls.teacherRagCourseName.textContent = courseName;
  renderTeacherRagCourseSummary(overlayEls.teacherRagCourseSummary, [
    { label: formatRagSourceCount(defaultCount, "fuente base", "fuentes base"), kind: defaultCount ? "ok" : "idle" },
    { label: formatTeacherRagCount(teacherCount), kind: teacherCount ? "ok" : "idle" },
    { label: course.materialUrl ? "Material base enlazado" : "Sin material base", kind: course.materialUrl ? "ok" : "warn" },
  ]);
  overlayEls.teacherRagPageStatus.textContent = state.error || state.message || overlayState.statusMessage || "";
  renderTeacherRagSourceList(overlayEls.teacherRagSourceList, state);
  overlayEls.teacherRagCourseSelect.disabled = state.busy;
  overlayEls.teacherRagUploadBtn.disabled = state.busy || overlayState.analysisBusy;
  overlayEls.teacherRagRefreshBtn.disabled = state.busy || overlayState.analysisBusy;
}

async function refreshTeacherRagSources() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !isTeacherSession()) return null;

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
      fetchJsonWithTimeout(`${baseUrl}/api/rag/sources?allCourses=true&limit=300`, {
        method: "GET",
        headers: buildApiHeaders(),
      }, BACKEND_TIMEOUT_MS),
    ]);
    overlayState.teacherRagState = normalizeTeacherRagStatePayload({
      courses: coursesResponse?.courses || [],
      defaultCourseCode: coursesResponse?.defaultCourseCode || "FPOO",
      selectedCourseCode: overlayState.teacherRagState?.selectedCourseCode || coursesResponse?.defaultCourseCode || "FPOO",
      sources: sourcesResponse?.sources || [],
      message: "Fuentes RAG actualizadas.",
    });
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
  overlayState.teacherBitacoraPageOpen = false;
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
  if (!isTeacherSession()) {
    overlayState.statusMessage = "Solo profesores pueden cargar RAG.";
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

async function uploadTeacherRagFile(file) {
  if (!file) return;
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !isTeacherSession()) {
    overlayState.statusMessage = "Inicia sesion como profesor antes de cargar RAG.";
    renderOverlay();
    return;
  }
  if (Number(file.size) > CAMPUS_RAG_UPLOAD_MAX_BYTES) {
    overlayState.statusMessage = `El archivo RAG supera ${Math.round(CAMPUS_RAG_UPLOAD_MAX_BYTES / (1024 * 1024))} MB.`;
    renderOverlay();
    return;
  }

  const state = normalizeTeacherRagStatePayload(overlayState.teacherRagState);
  const course = getSelectedTeacherRagCourse();
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("title", file.name);
  form.append("courseCode", state.selectedCourseCode || "FPOO");
  form.append("description", `Fuente RAG para ${toText(course.name || state.selectedCourseCode)}`);
  form.append("tags", `${state.selectedCourseCode},docente`);

  overlayState.teacherRagState = {
    ...state,
    busy: true,
    error: "",
    message: `Cargando ${file.name}...`,
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
    overlayState.teacherRagState = {
      ...normalizeTeacherRagStatePayload(overlayState.teacherRagState),
      busy: false,
      message: `Fuente RAG cargada en ${state.selectedCourseCode}.`,
      error: "",
    };
    await refreshTeacherRagSources();
  } catch (error) {
    overlayState.teacherRagState = {
      ...normalizeTeacherRagStatePayload(overlayState.teacherRagState),
      busy: false,
      error: `No se pudo cargar RAG: ${String(error?.message || error)}`,
    };
    renderOverlay();
  }
}

async function deleteTeacherRagSource(sourceId) {
  const cleanId = toText(sourceId);
  if (!cleanId) return;
  const confirmed = confirm("Se desactivara esta fuente RAG cargada por el docente. ¿Continuar?");
  if (!confirmed) return;
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !isTeacherSession()) return;

  overlayState.teacherRagState = {
    ...normalizeTeacherRagStatePayload(overlayState.teacherRagState),
    busy: true,
    error: "",
    message: "Eliminando fuente RAG...",
  };
  renderOverlay();

  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/rag/sources/${encodeURIComponent(cleanId)}`, {
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
