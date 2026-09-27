// ADACEEN | Capa 4 - UI: pestana «RAG» del docente (0.7.14; lotes en 0.7.15).
// Todos los cursos del docente como grupos plegables. En cada curso: la base (fuentes del
// programa y las que el docente cargo sin lote), los lotes con otro enfoque y cual esta
// activo (lo que reciben sus estudiantes, salvo los que tienen un lote asignado en
// «Usuarios»). Cada fuente se puede ver, apagar o encender para los estudiantes y, si es del
// docente, retirar. Usa el estado y las llamadas de services/campus.service.js
// (refreshTeacherRagSources, openTeacherRagFilePicker, uploadTeacherRagFile,
// deleteTeacherRagSource) y de services/backend.service.js (fetchRagLotCatalog,
// requestRagLotChange).
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

function ensureTeacherRagLoaded() {
  if (!isTeacherSession() || !overlayState.sessionId) return;
  const state = normalizeTeacherRagStatePayload(overlayState.teacherRagState);
  if (!state.busy && isRagPanelStale()) {
    refreshTeacherRagSources().catch(() => {});
  }
  ensureRagLotsLoaded();
}

// ---- Lotes (0.7.15) ----

function getRagLotsState() {
  const state = overlayState.ragLots && typeof overlayState.ragLots === "object" ? overlayState.ragLots : EMPTY_RAG_LOTS_STATE;
  return {
    ...EMPTY_RAG_LOTS_STATE,
    ...state,
    courses: Array.isArray(state.courses) ? state.courses : [],
    disabledSourceIds: Array.isArray(state.disabledSourceIds) ? state.disabledSourceIds : [],
  };
}

function getRagLotsForCourse(courseCode) {
  const code = normalizeRagCourseCodeUi(courseCode);
  return getRagLotsState().courses.find((course) => normalizeRagCourseCodeUi(course?.courseCode) === code) || null;
}

function ensureRagLotsLoaded() {
  if (!isTeacherSession() || !overlayState.sessionId) return;
  const state = getRagLotsState();
  if (state.busy) return;
  if (state.loadedAt && Date.now() - state.loadedAt <= RAG_PANEL_STALE_MS) return;
  refreshRagLots().catch(() => {});
}

async function refreshRagLots() {
  if (!isTeacherSession() || !overlayState.sessionId) return null;
  overlayState.ragLots = { ...getRagLotsState(), busy: true, error: "" };
  renderOverlay();
  try {
    const catalog = await fetchRagLotCatalog();
    overlayState.ragLots = { ...getRagLotsState(), ...catalog, busy: false, loadedAt: Date.now(), error: "" };
  } catch (error) {
    overlayState.ragLots = { ...getRagLotsState(), busy: false, error: `No se pudieron cargar los lotes: ${String(error?.message || error)}` };
  } finally {
    renderOverlay();
  }
  return overlayState.ragLots;
}

// Un cambio de lote: se guarda, se toma el catalogo que devuelve el backend y se refrescan las
// fuentes cuando hace falta (retirar un lote saca sus fuentes del alcance de los estudiantes).
async function applyRagLotChange(path, method, body, successMessage, options = {}) {
  overlayState.ragLots = { ...getRagLotsState(), busy: true, error: "", message: "" };
  renderOverlay();
  try {
    const response = await requestRagLotChange(path, method, body);
    const catalog = response?.catalog ? normalizeRagLotCatalog(response.catalog) : null;
    overlayState.ragLots = {
      ...getRagLotsState(),
      ...(catalog || {}),
      busy: false,
      loadedAt: catalog ? Date.now() : 0,
      message: successMessage,
      error: "",
    };
    overlayState.teacherRagState = { ...normalizeTeacherRagStatePayload(overlayState.teacherRagState), message: "" };
    if (!catalog) await refreshRagLots();
    if (options.refreshSources) await refreshTeacherRagSources();
    if (options.refreshUsers && typeof reloadAdminUsers === "function" && Array.isArray(overlayState.adminUsers) && overlayState.adminUsers.length) {
      await reloadAdminUsers().catch(() => {});
    }
    return response;
  } catch (error) {
    overlayState.ragLots = { ...getRagLotsState(), busy: false, error: String(error?.message || error) };
    return null;
  } finally {
    renderOverlay();
  }
}

function setActiveRagLot(courseCode, lotId) {
  const code = normalizeRagCourseCodeUi(courseCode) || "FPOO";
  const lot = getRagLotsForCourse(code)?.lots?.find((item) => toText(item.id) === toText(lotId)) || null;
  return applyRagLotChange(
    `/api/rag/courses/${encodeURIComponent(code)}/active-lot`,
    "PUT",
    { lotId: toText(lotId) || null },
    lot ? `«${toText(lot.name)}» es ahora el lote activo de ${code}.` : `${code} vuelve a la base del curso.`,
    { refreshUsers: true },
  );
}

function createRagLot(courseCode, input) {
  const code = normalizeRagCourseCodeUi(courseCode) || "FPOO";
  return applyRagLotChange(
    "/api/rag/lots",
    "POST",
    { courseCode: code, name: toText(input?.name), description: toText(input?.description), includesBase: input?.includesBase !== false },
    `Lote «${toText(input?.name)}» creado en ${code}. Actívalo cuando quieras que lo reciban tus estudiantes.`,
  );
}

function retireRagLot(lot) {
  return applyRagLotChange(
    `/api/rag/lots/${encodeURIComponent(toText(lot?.id))}`,
    "DELETE",
    undefined,
    `Lote «${toText(lot?.name)}» retirado. Sus fuentes quedan guardadas pero fuera del RAG.`,
    { refreshSources: true, refreshUsers: true },
  );
}

async function setRagSourceEnabled(source, enabled) {
  const id = toText(source?.id);
  if (!id) return null;
  const response = await applyRagLotChange(
    `/api/rag/sources/${encodeURIComponent(id)}/active`,
    "PUT",
    { isActive: !!enabled },
    enabled
      ? `«${toText(source.title || source.fileName)}» vuelve a estar disponible para tus estudiantes.`
      : `«${toText(source.title || source.fileName)}» apagada: tus estudiantes ya no la reciben.`,
  );
  if (response) {
    // La respuesta no trae catalogo: se refleja el cambio en la lista sin volver a pedir todo.
    const state = getRagLotsState();
    const disabled = new Set(state.disabledSourceIds);
    if (enabled) disabled.delete(id); else disabled.add(id);
    overlayState.ragLots = { ...state, disabledSourceIds: [...disabled], loadedAt: Date.now() };
    const ragState = normalizeTeacherRagStatePayload(overlayState.teacherRagState);
    overlayState.teacherRagState = {
      ...ragState,
      sources: ragState.sources.map((item) => (toText(item.id) === id ? { ...item, isEnabled: !!enabled } : item)),
    };
    renderOverlay();
  }
  return response;
}

function isRagSourceEnabled(source) {
  if (source?.isEnabled === false) return false;
  return !getRagLotsState().disabledSourceIds.includes(toText(source?.id));
}

function isRagLotFormOpen(code) {
  const map = overlayState.ragLotFormOpen && typeof overlayState.ragLotFormOpen === "object" ? overlayState.ragLotFormOpen : {};
  return map[code] === true;
}

function setRagLotFormOpen(code, open) {
  const current = overlayState.ragLotFormOpen && typeof overlayState.ragLotFormOpen === "object" ? overlayState.ragLotFormOpen : {};
  overlayState.ragLotFormOpen = { ...current, [code]: !!open };
  renderOverlay();
}

function getRagUploadLot(code) {
  const map = overlayState.ragUploadLotByCourse && typeof overlayState.ragUploadLotByCourse === "object" ? overlayState.ragUploadLotByCourse : {};
  return toText(map[code]);
}

function setRagUploadLot(code, lotId) {
  const current = overlayState.ragUploadLotByCourse && typeof overlayState.ragUploadLotByCourse === "object" ? overlayState.ragUploadLotByCourse : {};
  overlayState.ragUploadLotByCourse = { ...current, [code]: toText(lotId) };
}

// Abre el selector de archivo para un curso concreto: la carga usa selectedCourseCode y el
// lote elegido para ese curso (ragUploadLotByCourse).
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
  const enabled = isRagSourceEnabled(source);
  const li = document.createElement("li");
  li.className = `rag-course-source${source.scope === "teacher" ? " is-teacher" : ""}${enabled ? "" : " is-disabled"}`;

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
    enabled ? "" : "Apagada para tus estudiantes",
    source.scope === "teacher" ? "Cargada por ti" : "Programa del curso",
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
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "ghost-button analyze-button";
  toggle.textContent = enabled ? "Desactivar" : "Activar";
  toggle.disabled = busy;
  toggle.setAttribute("aria-pressed", enabled ? "true" : "false");
  toggle.setAttribute("aria-label", `${enabled ? "Desactivar" : "Activar"} ${title.textContent} para los estudiantes de ${courseCode}`);
  toggle.addEventListener("click", () => {
    setRagSourceEnabled(source, !enabled).catch(() => {});
  });
  actions.appendChild(toggle);
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

function sortRagSources(sources) {
  return sources
    .slice()
    .sort((left, right) => {
      if ((left.scope === "teacher") !== (right.scope === "teacher")) return left.scope === "teacher" ? -1 : 1;
      return toText(left.title || left.fileName).localeCompare(toText(right.title || right.fileName), "es");
    });
}

function buildRagSourceList(sources, courseCode, busy, emptyText) {
  const list = document.createElement("ul");
  list.className = "rag-course-sources";
  if (!sources.length) {
    const empty = document.createElement("li");
    empty.className = "rag-course-source is-empty";
    empty.textContent = emptyText;
    list.appendChild(empty);
  } else {
    sortRagSources(sources).forEach((source) => list.appendChild(buildRagSourceItem(source, courseCode, busy)));
  }
  return list;
}

function countEnabled(sources) {
  return sources.filter((source) => isRagSourceEnabled(source)).length;
}

function buildRagLotForm(course, busy) {
  const form = document.createElement("div");
  form.className = "rag-lot-form";
  form.setAttribute("role", "group");
  form.setAttribute("aria-label", `Nuevo lote de RAG en ${course.code}`);

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.maxLength = 80;
  nameInput.placeholder = "Nombre del lote, por ejemplo: enfoque videojuegos";
  nameInput.setAttribute("aria-label", `Nombre del nuevo lote de ${course.code}`);
  nameInput.disabled = busy;

  const descriptionInput = document.createElement("input");
  descriptionInput.type = "text";
  descriptionInput.maxLength = 400;
  descriptionInput.placeholder = "Para que sirve este enfoque (opcional)";
  descriptionInput.setAttribute("aria-label", `Descripcion del nuevo lote de ${course.code}`);
  descriptionInput.disabled = busy;

  const includesLabel = document.createElement("label");
  includesLabel.className = "check-item rag-lot-includes";
  const includesText = document.createElement("span");
  includesText.textContent = "Incluye la base del curso";
  const includesInput = document.createElement("input");
  includesInput.type = "checkbox";
  includesInput.checked = true;
  includesInput.disabled = busy;
  includesLabel.appendChild(includesText);
  includesLabel.appendChild(includesInput);

  const actions = document.createElement("div");
  actions.className = "rag-lot-form-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ghost-button analyze-button";
  cancel.textContent = "Cancelar";
  cancel.disabled = busy;
  cancel.addEventListener("click", () => setRagLotFormOpen(course.code, false));
  const save = document.createElement("button");
  save.type = "button";
  save.className = "primary-button analyze-button";
  save.textContent = "Guardar lote";
  save.disabled = busy;
  save.addEventListener("click", async () => {
    const name = toText(nameInput.value);
    if (name.length < 2) {
      overlayState.ragLots = { ...getRagLotsState(), error: "El lote necesita un nombre de al menos 2 caracteres." };
      renderOverlay();
      return;
    }
    const created = await createRagLot(course.code, { name, description: toText(descriptionInput.value), includesBase: includesInput.checked });
    if (created) setRagLotFormOpen(course.code, false);
  });
  actions.appendChild(cancel);
  actions.appendChild(save);

  form.appendChild(nameInput);
  form.appendChild(descriptionInput);
  form.appendChild(includesLabel);
  form.appendChild(actions);
  return form;
}

function buildRagLotGroup(course, lot, sources, busy, isActive) {
  const group = document.createElement("details");
  group.className = `rag-lot-group${isActive ? " is-active" : ""}`;
  group.open = isActive;
  const summary = document.createElement("summary");
  const name = document.createElement("span");
  name.className = "rag-lot-name";
  name.textContent = toText(lot.name);
  summary.appendChild(name);
  const badge = document.createElement("span");
  badge.className = `rag-lot-badge${isActive ? " is-active" : ""}`;
  badge.textContent = isActive ? "Activo" : "Inactivo";
  summary.appendChild(badge);
  const counts = document.createElement("span");
  counts.className = "rag-course-counts";
  counts.textContent = `${pluralizeStudentCount(sources.length, "fuente", "fuentes")}${lot.includesBase ? " + base" : ""}`;
  summary.appendChild(counts);
  group.appendChild(summary);

  const body = document.createElement("div");
  body.className = "rag-lot-body";
  const info = document.createElement("p");
  info.className = "rag-lot-info";
  info.textContent = [
    toText(lot.description),
    lot.includesBase
      ? "Los estudiantes con este lote reciben sus fuentes y las de la base del curso."
      : "Los estudiantes con este lote reciben solo estas fuentes (sin la base).",
  ].filter(Boolean).join(" ");
  body.appendChild(info);

  const actions = document.createElement("div");
  actions.className = "rag-lot-actions";
  if (!isActive) {
    const activate = document.createElement("button");
    activate.type = "button";
    activate.className = "primary-button analyze-button";
    activate.textContent = "Activar en el curso";
    activate.disabled = busy;
    activate.setAttribute("aria-label", `Activar el lote ${toText(lot.name)} en ${course.code}`);
    activate.addEventListener("click", () => {
      setActiveRagLot(course.code, lot.id).catch(() => {});
    });
    actions.appendChild(activate);
  }
  const upload = document.createElement("button");
  upload.type = "button";
  upload.className = "ghost-button analyze-button";
  upload.textContent = "Cargar fuente aqui";
  upload.disabled = busy || !!overlayState.analysisBusy;
  upload.setAttribute("aria-label", `Cargar una fuente en el lote ${toText(lot.name)} de ${course.code}`);
  upload.addEventListener("click", () => {
    setRagUploadLot(course.code, lot.id);
    startRagUploadForCourse(course.code);
  });
  actions.appendChild(upload);
  const retire = document.createElement("button");
  retire.type = "button";
  retire.className = "ghost-button analyze-button danger-button";
  retire.textContent = "Retirar lote";
  retire.disabled = busy;
  retire.setAttribute("aria-label", `Retirar el lote ${toText(lot.name)} de ${course.code}`);
  retire.addEventListener("click", () => {
    const confirmed = window.confirm(`Se retira el lote «${toText(lot.name)}» de ${course.code}. Sus fuentes dejan de llegar a los estudiantes y el curso vuelve a la base si estaba activo. Continuar?`);
    if (!confirmed) return;
    retireRagLot(lot).catch(() => {});
  });
  actions.appendChild(retire);
  body.appendChild(actions);

  body.appendChild(buildRagSourceList(sources, course.code, busy, "Este lote no tiene fuentes todavia. «Cargar fuente aqui» agrega la primera."));
  group.appendChild(body);
  return group;
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
    : "PDF, TXT, MD, DOCX, HTML, CSV o JSON. Tus estudiantes reciben el lote activo; en «Usuarios» puedes asignarle otro a alguien.";
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
  baseInfo.textContent = "Las fuentes del programa del curso y las que cargaste sin lote. «Desactivar» las apaga para tus estudiantes sin borrarlas.";
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

function renderRagCoursesPanel(showingMainView) {
  const section = overlayEls?.ragCoursesSection;
  if (!section) return;
  const allowed = showingMainView && isTeacherSession();
  section.hidden = !allowed;
  if (!allowed) return;

  const state = normalizeTeacherRagStatePayload(overlayState.teacherRagState);
  const lotsState = getRagLotsState();
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
  const status = state.busy || lotsState.busy
    ? "Actualizando cursos, lotes y fuentes..."
    : (overlayState.teacherRagLoadedAt
      ? `${pluralizeStudentCount(catalog.length, "curso", "cursos")} | ${pluralizeStudentCount(total, "fuente", "fuentes")}, ${teacherTotal} cargada${teacherTotal === 1 ? "" : "s"} por ti | ${pluralizeStudentCount(lotTotal, "lote", "lotes")}. Cada curso tiene su base y sus lotes; el lote activo es el que reciben tus estudiantes.`
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
  overlayEls.ragCoursesRefreshBtn?.addEventListener("click", () => {
    overlayState.ragLots = { ...getRagLotsState(), message: "" };
    refreshTeacherRagSources().catch(() => {});
    refreshRagLots().catch(() => {});
  });
}
