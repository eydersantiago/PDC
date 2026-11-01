"use strict";

// ADACEEN | Capa 4 - UI: pestaña «RAG», estado y cambios de los lotes (0.7.15) y lo que está abierto en la vista.
// Movido sin cambios de content-rag.js.

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
  if (!canManageRagSession() || !overlayState.sessionId) return;
  const state = getRagLotsState();
  if (state.busy) return;
  if (state.loadedAt && Date.now() - state.loadedAt <= RAG_PANEL_STALE_MS) return;
  refreshRagLots().catch(() => {});
}

async function refreshRagLots() {
  if (!canManageRagSession() || !overlayState.sessionId) return null;
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
      ? `«${toText(source.title || source.fileName)}» vuelve a estar disponible para ${ragOwnerWords().students}.`
      : `«${toText(source.title || source.fileName)}» apagada: ${ragOwnerWords().students} ya no la reciben.`,
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
