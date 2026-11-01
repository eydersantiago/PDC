"use strict";

// ADACEEN | Capa 4 - UI: página RAG del docente anterior a la pestaña «RAG», el render (curso, resumen y
// lista de fuentes). Movido sin cambios de content-rag-page.js.

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
  const courses = state.courses.length
    ? state.courses
    : [{ code: "FPOO", name: "FPOO", isDefault: true }];
  // Las opciones solo se recrean si cambia el catalogo (un render no cierra la lista abierta).
  if (renderKeyChanged(select, JSON.stringify(courses.map((course) => [toText(course.code), toText(course.name || course.shortName)])))) {
    select.textContent = "";
    for (const course of courses) {
      const option = document.createElement("option");
      option.value = toText(course.code);
      option.textContent = `${toText(course.code)} - ${toText(course.name || course.shortName)}`;
      select.appendChild(option);
    }
  }
  if (select.value !== current) select.value = current;
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
  const selectedCourseCode = state.selectedCourseCode || "FPOO";
  const sources = state.sources.filter((source) => toText(source.courseCode || source.metadata?.courseCode || "FPOO") === selectedCourseCode);
  // Sin cambios no se recrea la lista: el foco en "Eliminar" no se pierde en cada render.
  if (!renderKeyChanged(listEl, JSON.stringify([selectedCourseCode, sources, state.courses]))) return;
  listEl.textContent = "";
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
