// ADACEEN | Capa 4 - UI: pestana «RAG» del docente (0.7.14).
// Todos los cursos del docente como grupos plegables, con sus fuentes base y las que cargo,
// «Cargar fuente» por curso y «Ver» / «Retirar» por fuente. Usa el mismo estado y las mismas
// llamadas que la pagina «Configurar RAG» (services/campus.service.js: refreshTeacherRagSources,
// openTeacherRagFilePicker, uploadTeacherRagFile, deleteTeacherRagSource).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const RAG_PANEL_STALE_MS = 60 * 1000;

const RAG_SOURCE_TYPE_LABELS = Object.freeze({
  document: "Documento",
  web_page: "Pagina web",
  open_book_html: "Libro abierto",
  open_book_html_zip: "Libro abierto (zip)",
  google_drive_file: "Google Drive",
  bitacora: "Bitacora",
  pdf: "PDF",
});

function ragSourceCourseCode(source) {
  return normalizeRagCourseCodeUi(source?.courseCode || source?.metadata?.courseCode || source?.course_code) || "FPOO";
}

function ragCourseCatalogForTeacher(state) {
  const fromState = Array.isArray(state?.courses) && state.courses.length ? state.courses : getRagCourseCatalog();
  return fromState
    .map((course) => ({
      code: normalizeRagCourseCodeUi(course?.code),
      name: toText(course?.name || course?.shortName || course?.code),
      shortName: toText(course?.shortName || course?.code),
      materialUrl: toText(course?.materialUrl),
      isDefault: course?.isDefault === true,
    }))
    .filter((course) => course.code);
}

function isRagPanelStale() {
  const loadedAt = Number(overlayState.teacherRagLoadedAt) || 0;
  return !loadedAt || Date.now() - loadedAt > RAG_PANEL_STALE_MS;
}

function ensureTeacherRagLoaded() {
  if (!isTeacherSession() || !overlayState.sessionId) return;
  const state = normalizeTeacherRagStatePayload(overlayState.teacherRagState);
  if (state.busy || !isRagPanelStale()) return;
  refreshTeacherRagSources().catch(() => {});
}

// Abre el selector de archivo para un curso concreto: la carga usa selectedCourseCode.
function startRagUploadForCourse(courseCode) {
  const code = normalizeRagCourseCodeUi(courseCode) || "FPOO";
  overlayState.teacherRagState = {
    ...normalizeTeacherRagStatePayload(overlayState.teacherRagState),
    selectedCourseCode: code,
    message: "",
    error: "",
  };
  openTeacherRagFilePicker();
}

function isRagCourseOpen(code, catalog, defaultCourseCode) {
  const map = overlayState.ragCoursesOpen && typeof overlayState.ragCoursesOpen === "object" ? overlayState.ragCoursesOpen : {};
  if (Object.prototype.hasOwnProperty.call(map, code)) return map[code] === true;
  // Sin eleccion previa: abierto el curso por defecto (o el primero).
  const first = catalog[0]?.code;
  return code === (defaultCourseCode || first);
}

function rememberRagCourseOpen(code, open) {
  const current = overlayState.ragCoursesOpen && typeof overlayState.ragCoursesOpen === "object" ? overlayState.ragCoursesOpen : {};
  overlayState.ragCoursesOpen = { ...current, [code]: !!open };
}

function formatRagSourceSize(source) {
  const chars = Number(source?.textLength) || 0;
  if (!chars) return "";
  if (chars < 1000) return `${chars} caracteres`;
  return `${Math.round(chars / 1000)}k caracteres`;
}

function ragSourceTypeLabel(source) {
  const type = toText(source?.sourceType).toLowerCase();
  return RAG_SOURCE_TYPE_LABELS[type] || (type ? type.replace(/_/g, " ") : "documento");
}

function buildRagSourceItem(source, courseCode, busy) {
  const li = document.createElement("li");
  li.className = `rag-course-source${source.scope === "teacher" ? " is-teacher" : ""}`;

  const head = document.createElement("div");
  head.className = "rag-course-source-head";
  const titleBox = document.createElement("div");
  titleBox.className = "rag-course-source-titles";
  const title = document.createElement("span");
  title.className = "rag-course-source-title";
  title.textContent = toText(source.title || source.fileName || "Fuente RAG");
  title.title = title.textContent;
  const meta = document.createElement("span");
  meta.className = "rag-course-source-meta";
  meta.textContent = [
    source.scope === "teacher" ? "Cargada por ti" : "Base del curso",
    ragSourceTypeLabel(source),
    toText(source.fileName),
    formatRagSourceSize(source),
    source.createdAt ? new Date(source.createdAt).toLocaleDateString() : "",
  ].filter(Boolean).join(" | ");
  titleBox.appendChild(title);
  titleBox.appendChild(meta);
  head.appendChild(titleBox);

  const actions = document.createElement("div");
  actions.className = "rag-course-source-actions";
  const href = buildRagSourceViewerHref(source.url || source.viewerUrl, { ...source, courseCode });
  if (href) {
    const view = document.createElement("a");
    view.className = "ghost-button analyze-button rag-source-link";
    view.href = href;
    view.target = "_blank";
    view.rel = "noopener noreferrer";
    view.textContent = "Ver";
    view.setAttribute("aria-label", `Ver ${title.textContent} (se abre en otra pestaña)`);
    actions.appendChild(view);
  }
  if (source.scope === "teacher") {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost-button analyze-button danger-button";
    remove.textContent = "Retirar";
    remove.disabled = busy;
    remove.setAttribute("aria-label", `Retirar ${title.textContent} del RAG de ${courseCode}`);
    remove.addEventListener("click", () => {
      deleteTeacherRagSource(toText(source.id)).catch(() => {});
    });
    actions.appendChild(remove);
  }
  head.appendChild(actions);
  li.appendChild(head);

  if (source.textPreview) {
    const preview = document.createElement("p");
    preview.className = "rag-course-source-preview";
    preview.textContent = truncateText(toText(source.textPreview), 160);
    li.appendChild(preview);
  }
  return li;
}

function buildRagCourseGroup(course, sources, state) {
  const group = document.createElement("details");
  group.className = "rag-course-group";
  group.dataset.courseCode = course.code;
  group.open = isRagCourseOpen(course.code, ragCourseCatalogForTeacher(state), state.defaultCourseCode);
  group.addEventListener("toggle", () => {
    rememberRagCourseOpen(course.code, group.open);
  });

  const baseCount = sources.filter((source) => source.scope !== "teacher").length;
  const teacherCount = sources.filter((source) => source.scope === "teacher").length;

  const summary = document.createElement("summary");
  const code = document.createElement("span");
  code.className = "rag-course-code";
  code.textContent = course.code;
  const name = document.createElement("span");
  name.className = "rag-course-name";
  name.textContent = course.name;
  const counts = document.createElement("span");
  counts.className = `rag-course-counts${sources.length ? "" : " is-empty"}`;
  counts.textContent = sources.length
    ? `${pluralizeStudentCount(baseCount, "base", "base")} | ${teacherCount} ${teacherCount === 1 ? "tuya" : "tuyas"}`
    : "Sin fuentes";
  summary.appendChild(code);
  summary.appendChild(name);
  summary.appendChild(counts);
  group.appendChild(summary);

  const body = document.createElement("div");
  body.className = "rag-course-body";

  const toolbar = document.createElement("div");
  toolbar.className = "rag-course-toolbar";
  const upload = document.createElement("button");
  upload.type = "button";
  upload.className = "primary-button analyze-button";
  upload.textContent = "Cargar fuente";
  upload.disabled = state.busy || !!overlayState.analysisBusy;
  upload.setAttribute("aria-label", `Cargar una fuente RAG en ${course.code}`);
  upload.addEventListener("click", () => startRagUploadForCourse(course.code));
  toolbar.appendChild(upload);
  if (course.materialUrl) {
    const material = document.createElement("a");
    material.className = "ghost-button analyze-button rag-source-link";
    material.href = course.materialUrl;
    material.target = "_blank";
    material.rel = "noopener noreferrer";
    material.textContent = "Material base";
    material.setAttribute("aria-label", `Abrir el material base de ${course.code} (se abre en otra pestaña)`);
    toolbar.appendChild(material);
  }
  const hint = document.createElement("span");
  hint.className = "rag-course-hint";
  hint.textContent = course.isDefault ? "Curso por defecto: se usa cuando el estudiante no tiene otro." : "PDF, TXT, MD, DOCX, HTML, CSV o JSON.";
  toolbar.appendChild(hint);
  body.appendChild(toolbar);

  const list = document.createElement("ul");
  list.className = "rag-course-sources";
  if (!sources.length) {
    const empty = document.createElement("li");
    empty.className = "rag-course-source is-empty";
    empty.textContent = "Este curso no tiene fuentes todavia. Carga la primera con «Cargar fuente».";
    list.appendChild(empty);
  } else {
    sources
      .slice()
      .sort((left, right) => {
        if ((left.scope === "teacher") !== (right.scope === "teacher")) return left.scope === "teacher" ? -1 : 1;
        return toText(left.title || left.fileName).localeCompare(toText(right.title || right.fileName), "es");
      })
      .forEach((source) => list.appendChild(buildRagSourceItem(source, course.code, state.busy)));
  }
  body.appendChild(list);
  group.appendChild(body);
  return group;
}

function renderRagCoursesPanel(showingMainView) {
  const section = overlayEls?.ragCoursesSection;
  if (!section) return;
  const allowed = showingMainView && isTeacherSession();
  section.hidden = !allowed;
  if (!allowed) return;

  const state = normalizeTeacherRagStatePayload(overlayState.teacherRagState);
  const catalog = ragCourseCatalogForTeacher(state);
  const byCourse = new Map(catalog.map((course) => [course.code, []]));
  for (const source of state.sources) {
    const code = ragSourceCourseCode(source);
    if (!byCourse.has(code)) byCourse.set(code, []);
    byCourse.get(code).push(source);
  }

  const total = state.sources.length;
  const teacherTotal = state.sources.filter((source) => source.scope === "teacher").length;
  const status = state.busy
    ? "Actualizando fuentes..."
    : (overlayState.teacherRagLoadedAt
      ? `${pluralizeStudentCount(catalog.length, "curso", "cursos")} | ${pluralizeStudentCount(total, "fuente", "fuentes")}, ${teacherTotal} cargada${teacherTotal === 1 ? "" : "s"} por ti. Cada curso muestra sus fuentes; «Cargar fuente» la agrega a ese curso.`
      : "Cargando cursos y fuentes...");
  setTextIfChanged(overlayEls.ragCoursesStatus, status);
  overlayEls.ragCoursesStatus?.classList.toggle("is-loading-note", state.busy);
  setTextIfChanged(overlayEls.ragCoursesMessage, state.error || state.message || "");
  overlayEls.ragCoursesMessage?.classList.toggle("is-warning", !!state.error);
  if (overlayEls.ragCoursesRefreshBtn) overlayEls.ragCoursesRefreshBtn.disabled = state.busy;

  const container = overlayEls.ragCourseGroups;
  if (!container) return;
  const key = JSON.stringify([catalog, state.sources, state.busy, overlayState.ragCoursesOpen, !!overlayState.analysisBusy, normalizeBaseUrl(overlayState.backendUrl)]);
  if (!renderKeyChanged(container, key)) return;
  container.textContent = "";
  const fragment = document.createDocumentFragment();
  for (const course of catalog) {
    fragment.appendChild(buildRagCourseGroup(course, byCourse.get(course.code) || [], state));
  }
  container.appendChild(fragment);
}

function bindRagCoursesPanel() {
  if (!overlayEls) return;
  overlayEls.ragCoursesRefreshBtn?.addEventListener("click", () => {
    refreshTeacherRagSources().catch(() => {});
  });
}
