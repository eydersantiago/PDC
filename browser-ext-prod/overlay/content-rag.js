// ADACEEN | Capa 4 - UI: pestana «RAG» del docente (0.7.14; lotes en 0.7.15).
// Todos los cursos del docente como grupos plegables. En cada curso: la base (fuentes del
// programa y las que el docente cargo sin lote), los lotes con otro enfoque y cual esta
// activo (lo que reciben sus estudiantes, salvo los que tienen un lote asignado en
// «Usuarios»). Cada fuente se puede ver, apagar o encender para los estudiantes y, si es del
// docente, retirar. El administrador (0.7.22) tiene la misma pestaña con el campo «Docente» y
// gestiona el RAG de ese docente (cada peticion lleva teacherUserId). Usa el estado y las llamadas de services/campus.service.js
// (refreshTeacherRagSources, openTeacherRagFilePicker, uploadTeacherRagFile,
// deleteTeacherRagSource) y de services/backend.service.js (fetchRagLotCatalog,
// requestRagLotChange).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const RAG_PANEL_STALE_MS = 60 * 1000;

function ragSourceCourseCode(source) {
  return normalizeRagCourseCodeUi(source?.courseCode || source?.metadata?.courseCode || source?.course_code) || "FPOO";
}

function ragSourceLotIdUi(source) {
  return toText(source?.lotId || source?.metadata?.lotId || source?.metadata?.lot_id);
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

// Textos de la pestaña: el docente habla de lo suyo; el administrador, del docente elegido (0.7.22).
function ragOwnerWords() {
  if (!isAdminSession()) return { by: "por ti", students: "tus estudiantes", loaded: "cargaste" };
  return { by: "por el docente", students: "sus estudiantes", loaded: "cargó el docente" };
}

function ensureTeacherRagLoaded() {
  if (!canManageRagSession() || !overlayState.sessionId) return;
  const state = normalizeTeacherRagStatePayload(overlayState.teacherRagState);
  if (!state.busy && isRagPanelStale()) {
    refreshTeacherRagSources().catch(() => {});
  }
  ensureRagLotsLoaded();
}

function buildRagCourseGroup(course, sources, state) {
  const lotsState = getRagLotsState();
  const courseLots = getRagLotsForCourse(course.code);
  const lots = Array.isArray(courseLots?.lots) ? courseLots.lots : [];
  const activeLotId = toText(courseLots?.activeLotId);
  const activeLotName = toText(courseLots?.activeLotName) || lotsState.baseLotName || "Base del curso";
  const busy = !!state.busy || !!lotsState.busy;

  const group = document.createElement("details");
  group.className = "rag-course-group";
  group.dataset.courseCode = course.code;
  group.open = isRagCourseOpen(course.code, ragCourseCatalogForTeacher(state), state.defaultCourseCode);
  group.addEventListener("toggle", () => {
    rememberRagCourseOpen(course.code, group.open);
  });

  const baseSources = sources.filter((source) => !ragSourceLotIdUi(source));
  const lotSources = new Map(lots.map((lot) => [toText(lot.id), []]));
  const orphanSources = [];
  sources.forEach((source) => {
    const lotId = ragSourceLotIdUi(source);
    if (!lotId) return;
    if (lotSources.has(lotId)) lotSources.get(lotId).push(source);
    else orphanSources.push(source);
  });

  const summary = document.createElement("summary");
  const code = document.createElement("span");
  code.className = "rag-course-code";
  code.textContent = course.code;
  const name = document.createElement("span");
  name.className = "rag-course-name";
  name.textContent = course.name;
  const active = document.createElement("span");
  active.className = `rag-course-active${activeLotId ? " is-lot" : ""}`;
  active.textContent = `Activo: ${activeLotName}`;
  const counts = document.createElement("span");
  counts.className = `rag-course-counts${sources.length ? "" : " is-empty"}`;
  counts.textContent = sources.length
    ? `${pluralizeStudentCount(countEnabled(baseSources), "fuente base", "fuentes base")} | ${pluralizeStudentCount(lots.length, "lote", "lotes")}`
    : "Sin fuentes";
  summary.appendChild(code);
  summary.appendChild(name);
  summary.appendChild(active);
  summary.appendChild(counts);
  group.appendChild(summary);

  const body = document.createElement("div");
  body.className = "rag-course-body";

  // Barra del curso: lote activo, cargar fuente (en la base o en un lote), nuevo lote y material.
  const toolbar = document.createElement("div");
  toolbar.className = "rag-course-toolbar";
  const activeLabel = document.createElement("label");
  activeLabel.className = "rag-course-select";
  const activeCaption = document.createElement("span");
  activeCaption.textContent = "Lote activo";
  const activeSelect = document.createElement("select");
  activeSelect.disabled = busy;
  activeSelect.setAttribute("aria-label", `Lote activo de ${course.code}`);
  const baseOption = document.createElement("option");
  baseOption.value = "";
  baseOption.textContent = lotsState.baseLotName || "Base del curso";
  activeSelect.appendChild(baseOption);
  lots.forEach((lot) => {
    const option = document.createElement("option");
    option.value = toText(lot.id);
    option.textContent = toText(lot.name);
    activeSelect.appendChild(option);
  });
  activeSelect.value = activeLotId;
  activeSelect.addEventListener("change", () => {
    setActiveRagLot(course.code, activeSelect.value).catch(() => {});
  });
  activeLabel.appendChild(activeCaption);
  activeLabel.appendChild(activeSelect);
  toolbar.appendChild(activeLabel);

  const uploadLabel = document.createElement("label");
  uploadLabel.className = "rag-course-select";
  const uploadCaption = document.createElement("span");
  uploadCaption.textContent = "Cargar en";
  const uploadSelect = document.createElement("select");
  uploadSelect.disabled = busy;
  uploadSelect.setAttribute("aria-label", `Donde cargar la siguiente fuente de ${course.code}`);
  const uploadBase = document.createElement("option");
  uploadBase.value = "";
  uploadBase.textContent = lotsState.baseLotName || "Base del curso";
  uploadSelect.appendChild(uploadBase);
  lots.forEach((lot) => {
    const option = document.createElement("option");
    option.value = toText(lot.id);
    option.textContent = toText(lot.name);
    uploadSelect.appendChild(option);
  });
  const rememberedUploadLot = getRagUploadLot(course.code);
  uploadSelect.value = lots.some((lot) => toText(lot.id) === rememberedUploadLot) ? rememberedUploadLot : "";
  if (uploadSelect.value !== rememberedUploadLot) setRagUploadLot(course.code, uploadSelect.value);
  uploadSelect.addEventListener("change", () => setRagUploadLot(course.code, uploadSelect.value));
  uploadLabel.appendChild(uploadCaption);
  uploadLabel.appendChild(uploadSelect);
  toolbar.appendChild(uploadLabel);

  const upload = document.createElement("button");
  upload.type = "button";
  upload.className = "primary-button analyze-button";
  upload.textContent = "Cargar fuente";
  upload.disabled = busy || !!overlayState.analysisBusy;
  upload.setAttribute("aria-label", `Cargar una fuente RAG en ${course.code}`);
  upload.addEventListener("click", () => startRagUploadForCourse(course.code));
  toolbar.appendChild(upload);

  const newLot = document.createElement("button");
  newLot.type = "button";
  newLot.className = "ghost-button analyze-button";
  newLot.textContent = "Nuevo lote";
  newLot.disabled = busy;
  newLot.setAttribute("aria-expanded", isRagLotFormOpen(course.code) ? "true" : "false");
  newLot.setAttribute("aria-label", `Crear un lote de RAG en ${course.code}`);
  newLot.addEventListener("click", () => setRagLotFormOpen(course.code, !isRagLotFormOpen(course.code)));
  toolbar.appendChild(newLot);

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
  body.appendChild(toolbar);

  const hint = document.createElement("p");
  hint.className = "rag-course-hint";
  hint.textContent = course.isDefault
    ? "Curso por defecto: se usa cuando el estudiante no tiene otro. PDF, TXT, MD, DOCX, HTML, CSV o JSON."
    : (isAdminSession()
      ? "PDF, TXT, MD, DOCX, HTML, CSV o JSON. Sus estudiantes reciben el lote activo."
      : "PDF, TXT, MD, DOCX, HTML, CSV o JSON. Tus estudiantes reciben el lote activo; en «Usuarios» puedes asignarle otro a alguien.");
  body.appendChild(hint);

  if (isRagLotFormOpen(course.code)) {
    body.appendChild(buildRagLotForm(course, busy));
  }

  // Base del curso: el programa y lo que cargaste sin lote.
  const base = document.createElement("details");
  base.className = `rag-lot-group is-base${activeLotId ? "" : " is-active"}`;
  // Con un lote activo, la base empieza plegada para que el lote se vea de una.
  base.open = !activeLotId;
  const baseSummary = document.createElement("summary");
  const baseName = document.createElement("span");
  baseName.className = "rag-lot-name";
  baseName.textContent = lotsState.baseLotName || "Base del curso";
  baseSummary.appendChild(baseName);
  const baseBadge = document.createElement("span");
  baseBadge.className = `rag-lot-badge${activeLotId ? "" : " is-active"}`;
  baseBadge.textContent = activeLotId ? (lots.find((lot) => toText(lot.id) === activeLotId)?.includesBase ? "Incluida en el lote activo" : "Fuera del lote activo") : "Activa";
  baseSummary.appendChild(baseBadge);
  const baseCounts = document.createElement("span");
  baseCounts.className = "rag-course-counts";
  baseCounts.textContent = `${countEnabled(baseSources)} de ${baseSources.length} activas`;
  baseSummary.appendChild(baseCounts);
  base.appendChild(baseSummary);
  const baseBody = document.createElement("div");
  baseBody.className = "rag-lot-body";
  const baseInfo = document.createElement("p");
  baseInfo.className = "rag-lot-info";
  baseInfo.textContent = `Las fuentes del programa del curso y las que ${ragOwnerWords().loaded} sin lote. «Desactivar» las apaga para ${ragOwnerWords().students} sin borrarlas.`;
  baseBody.appendChild(baseInfo);
  baseBody.appendChild(buildRagSourceList(baseSources, course.code, busy, "Este curso no tiene fuentes base todavia. Carga la primera con «Cargar fuente»."));
  base.appendChild(baseBody);
  body.appendChild(base);

  lots.forEach((lot) => {
    body.appendChild(buildRagLotGroup(course, lot, lotSources.get(toText(lot.id)) || [], busy, toText(lot.id) === activeLotId));
  });
  if (orphanSources.length) {
    body.appendChild(buildRagLotGroup(course, { id: "", name: "Fuentes de lotes retirados", description: "", includesBase: false }, orphanSources, busy, false));
  }

  group.appendChild(body);
  return group;
}

// Selector «Docente» del administrador (0.7.22): los docentes activos que trae GET /api/rag/sources.
function renderRagOwnerField(visible, busy) {
  const field = overlayEls?.ragOwnerField;
  const select = overlayEls?.ragOwnerSelect;
  if (!field || !select) return;
  field.hidden = !visible;
  if (!visible) return;
  const owner = overlayState.ragOwner || EMPTY_RAG_OWNER_STATE;
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

function renderRagCoursesPanel(showingMainView) {
  const section = overlayEls?.ragCoursesSection;
  if (!section) return;
  const allowed = showingMainView && canManageRagSession();
  section.hidden = !allowed;
  if (!allowed) return;

  const state = normalizeTeacherRagStatePayload(overlayState.teacherRagState);
  const lotsState = getRagLotsState();
  const admin = isAdminSession();
  renderRagOwnerField(admin, !!state.busy || !!lotsState.busy);
  const catalog = ragCourseCatalogForTeacher(state);
  const byCourse = new Map(catalog.map((course) => [course.code, []]));
  for (const source of state.sources) {
    const code = ragSourceCourseCode(source);
    if (!byCourse.has(code)) byCourse.set(code, []);
    byCourse.get(code).push(source);
  }

  const total = state.sources.length;
  const teacherTotal = state.sources.filter((source) => source.scope === "teacher").length;
  const lotTotal = lotsState.courses.reduce((sum, course) => sum + (Array.isArray(course?.lots) ? course.lots.length : 0), 0);
  const words = ragOwnerWords();
  const ownerName = admin ? getRagOwnerName() : "";
  const loadedStatus = `${pluralizeStudentCount(catalog.length, "curso", "cursos")} | ${pluralizeStudentCount(total, "fuente", "fuentes")}, ${teacherTotal} cargada${teacherTotal === 1 ? "" : "s"} ${words.by} | ${pluralizeStudentCount(lotTotal, "lote", "lotes")}. Cada curso tiene su base y sus lotes; el lote activo es el que reciben ${words.students}.`;
  const status = state.busy || lotsState.busy
    ? "Actualizando cursos, lotes y fuentes..."
    : (overlayState.teacherRagLoadedAt
      ? (admin && !getRagOwnerTeacherId()
        ? (toText(overlayState.ragOwner?.message) || "Elige el docente cuyo RAG vas a gestionar.")
        : `${ownerName ? `RAG de ${ownerName}: ` : ""}${loadedStatus}`)
      : "Cargando cursos, lotes y fuentes...");
  setTextIfChanged(overlayEls.ragCoursesStatus, status);
  overlayEls.ragCoursesStatus?.classList.toggle("is-loading-note", state.busy || lotsState.busy);
  // El ultimo cambio de lotes pesa mas que «Fuentes RAG actualizadas.».
  const message = state.error || lotsState.error || lotsState.message || state.message || "";
  setTextIfChanged(overlayEls.ragCoursesMessage, message);
  overlayEls.ragCoursesMessage?.classList.toggle("is-warning", !!(state.error || lotsState.error));
  if (overlayEls.ragCoursesRefreshBtn) overlayEls.ragCoursesRefreshBtn.disabled = state.busy || lotsState.busy;

  const container = overlayEls.ragCourseGroups;
  if (!container) return;
  const key = JSON.stringify([
    catalog,
    state.sources,
    state.busy,
    lotsState.courses,
    lotsState.disabledSourceIds,
    lotsState.busy,
    overlayState.ragCoursesOpen,
    overlayState.ragLotFormOpen,
    overlayState.ragUploadLotByCourse,
    getRagOwnerTeacherId(),
    !!overlayState.analysisBusy,
    normalizeBaseUrl(overlayState.backendUrl),
  ]);
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
  // Administrador (0.7.22): al cambiar de docente se consulta el RAG y los lotes de ese docente.
  overlayEls.ragOwnerSelect?.addEventListener("change", async () => {
    const teacherUserId = toText(overlayEls.ragOwnerSelect.value);
    if (!isAdminSession() || !teacherUserId || teacherUserId === getRagOwnerTeacherId()) return;
    overlayState.ragOwner = { ...overlayState.ragOwner, teacherUserId };
    overlayState.teacherRagState = {
      ...normalizeTeacherRagStatePayload(overlayState.teacherRagState),
      sources: [],
      message: "",
      error: "",
    };
    overlayState.ragLots = { ...EMPTY_RAG_LOTS_STATE };
    overlayState.ragUploadLotByCourse = {};
    overlayState.ragLotFormOpen = {};
    await refreshTeacherRagSources();
    await refreshRagLots();
  });
  overlayEls.ragCoursesRefreshBtn?.addEventListener("click", () => {
    overlayState.ragLots = { ...getRagLotsState(), message: "" };
    refreshTeacherRagSources().catch(() => {});
    refreshRagLots().catch(() => {});
  });
}
