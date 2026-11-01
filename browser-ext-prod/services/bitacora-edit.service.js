"use strict";

// ADACEEN | Capa 3 - Servicios: cambios en la bitacora del docente: registro manual, borrar y fecha de inicio.
// Movido sin cambios de bitacora.service.js (estado, permisos y agenda).

async function saveTeacherBitacoraManualEntry() {
  if (!ensureBitacoraEditable("Solo profesores pueden guardar la bitácora.")) return;

  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    overlayState.statusMessage = "Inicia sesión como profesor antes de guardar la bitácora.";
    renderOverlay();
    return;
  }

  const title = toText(overlayEls?.teacherBitacoraManualTitleInput?.value).trim();
  const description = toText(overlayEls?.teacherBitacoraManualDescriptionInput?.value).trim();
  if (!title && !description) {
    overlayState.statusMessage = "Escribe un título o un detalle para guardar el registro.";
    renderOverlay();
    return;
  }

  const category = normalizeTeacherBitacoraManualCategory(overlayEls?.teacherBitacoraManualCategorySelect?.value);
  const weekValue = Number(overlayEls?.teacherBitacoraManualWeekInput?.value) || 0;
  const item = {
    ...(weekValue >= 1 && weekValue <= 20 ? { week: weekValue } : {}),
    dueAt: toText(overlayEls?.teacherBitacoraManualDateInput?.value).trim(),
    title: title || description.slice(0, 120) || category,
    type: category,
    description,
  };

  overlayState.analysisBusy = true;
  overlayState.statusMessage = `Guardando ${category.toLowerCase()} en la bitácora...`;
  overlayState.documentClassifications = {
    ...normalizeDocumentClassificationState(overlayState.documentClassifications),
    busy: true,
    message: `Guardando ${category.toLowerCase()} manual...`,
    error: "",
  };
  renderOverlay();

  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/documents/bitacora/manual`, {
      method: "POST",
      headers: buildApiHeaders(),
      body: JSON.stringify(withBitacoraOwnerBody({
        sourceName: `bitacora_manual_${new Date().toISOString().slice(0, 10)}.json`,
        activities: [item],
        exams: [],
      })),
    }, CAMPUS_BITACORA_UPLOAD_TIMEOUT_MS);

    if (!response?.ok) {
      throw new Error(toText(response?.error) || "No se pudo guardar el registro manual.");
    }

    const rawItem = response.stored || buildUploadedBitacoraFallbackItem(response, { name: "bitacora_manual.json" });
    const nextItems = mergeUploadedBitacoraClassification(rawItem);
    const agendaItems = Array.isArray(response.import?.bitacoraAgenda?.items)
      ? response.import.bitacoraAgenda.items
      : [];
    const rowsUsed = Number(response.import?.rowsUsed) || agendaItems.length || 0;

    overlayState.documentClassifications = {
      items: nextItems,
      busy: false,
      message: `Bitácora actualizada: ${rowsUsed} registro(s) manual(es).`,
      error: "",
    };
    overlayState.teacherBitacoraStatus = {
      loaded: true,
      latest: rawItem,
      summary: {
        fileName: toText(rawItem.fileName || "bitacora_manual.json"),
        label: "BITACORA",
        confidence: Number(rawItem.confidence) || Number(response.classification?.confidence) || 0,
        rows: rowsUsed,
        updatedAt: new Date().toISOString(),
      },
      busy: false,
      checking: false,
      error: "",
      checkedAt: Date.now(),
    };
    overlayState.analysisUnlocked = true;
    overlayState.analysisWindowOpen = false;
    overlayState.statusMessage = `Registro clasificado como ${category} y guardado en la bitácora.`;
    clearTeacherBitacoraManualForm();
    syncCampusAccessAfterBitacoraChange();
  } catch (error) {
    const message = `No se pudo guardar el registro manual: ${String(error?.message || error)}`;
    overlayState.documentClassifications = {
      ...normalizeDocumentClassificationState(overlayState.documentClassifications),
      busy: false,
      message: "",
      error: message,
    };
    overlayState.teacherBitacoraStatus = {
      ...normalizeTeacherBitacoraStatusPayload(overlayState.teacherBitacoraStatus),
      busy: false,
      error: message,
    };
    overlayState.statusMessage = message;
  } finally {
    overlayState.analysisBusy = false;
    renderOverlay();
  }
}

function removeTeacherBitacoraLocalItems(options = {}) {
  const state = typeof normalizeDocumentClassificationState === "function"
    ? normalizeDocumentClassificationState(overlayState.documentClassifications)
    : { items: [] };
  const deletedIds = new Set((Array.isArray(options.deletedIds) ? options.deletedIds : []).map(toText).filter(Boolean));
  const removeAll = options.all === true;
  const existing = Array.isArray(state.items) ? state.items : [];
  const nextItems = existing.filter((item) => {
    if (item.label !== "BITACORA") return true;
    if (removeAll) return false;
    return deletedIds.size > 0 ? !deletedIds.has(toText(item.id)) : false;
  });

  overlayState.documentClassifications = {
    ...state,
    items: nextItems,
    busy: false,
  };
}

async function deleteTeacherBitacoraData(scope) {
  if (!ensureBitacoraEditable("Solo profesores pueden eliminar la bitácora.")) return;

  const item = getTeacherBitacoraDisplayItem();
  if (!item) {
    overlayState.statusMessage = "No hay bitácora cargada para eliminar.";
    renderOverlay();
    return;
  }

  const deleteAll = scope === "all";
  const ownerName = getBitacoraOwnerName();
  const confirmed = confirm(deleteAll
    ? (ownerName
      ? `Se borrarán todas las bitácoras de ${ownerName} y sus estudiantes se quedarán sin agenda. ¿Continuar?`
      : "Se borrarán todas las bitácoras que has subido y tus estudiantes se quedarán sin agenda. ¿Continuar?")
    : (ownerName
      ? `Se eliminará la bitácora más reciente de ${ownerName}. ¿Continuar?`
      : "Se eliminará la bitácora más reciente. ¿Continuar?"));
  if (!confirmed) return;

  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    overlayState.statusMessage = "Inicia sesión como profesor antes de eliminar la bitácora.";
    renderOverlay();
    return;
  }

  overlayState.teacherBitacoraStatus = {
    ...normalizeTeacherBitacoraStatusPayload(overlayState.teacherBitacoraStatus),
    busy: true,
    error: "",
  };
  overlayState.statusMessage = deleteAll
    ? "Borrando los datos de la bitácora..."
    : "Eliminando la bitácora cargada...";
  renderOverlay();

  let refreshed = false;
  try {
    const endpoint = deleteAll ? "data" : "latest";
    const response = await fetchJsonWithTimeout(withBitacoraOwnerQuery(`${baseUrl}/api/documents/bitacora/${endpoint}`), {
      method: "DELETE",
      headers: buildApiHeaders(),
    }, BACKEND_TIMEOUT_MS);

    if (!response?.ok) {
      throw new Error(toText(response?.error) || "No se pudo eliminar la bitácora.");
    }

    const deleted = Array.isArray(response.deleted) ? response.deleted : [];
    const deletedIds = deleted.map((row) => toText(row?.id)).filter(Boolean);
    removeTeacherBitacoraLocalItems({ all: deleteAll, deletedIds });
    overlayState.statusMessage = deleteAll
      ? `Datos de la bitácora borrados: ${Number(response.deletedCount) || 0} registro(s).`
      : Number(response.deletedCount) > 0
        ? "Bitácora eliminada."
        : "No había bitácora cargada para eliminar.";

    if (deleteAll) {
      overlayState.teacherBitacoraStatus = { ...EMPTY_TEACHER_BITACORA_STATUS, checkedAt: Date.now() };
    } else {
      refreshed = true;
      await refreshTeacherBitacoraStatus();
    }
    syncCampusAccessAfterBitacoraChange();
  } catch (error) {
    overlayState.teacherBitacoraStatus = {
      ...normalizeTeacherBitacoraStatusPayload(overlayState.teacherBitacoraStatus),
      busy: false,
      error: `No se pudo eliminar la bitácora: ${String(error?.message || error)}`,
    };
    overlayState.statusMessage = overlayState.teacherBitacoraStatus.error;
  } finally {
    if (!refreshed) {
      overlayState.teacherBitacoraStatus = {
        ...normalizeTeacherBitacoraStatusPayload(overlayState.teacherBitacoraStatus),
        busy: false,
      };
      renderOverlay();
    }
  }
}

async function deleteTeacherBitacoraLatest() {
  await deleteTeacherBitacoraData("latest");
}

async function clearTeacherBitacoraData() {
  await deleteTeacherBitacoraData("all");
}

// «Inicio del semestre» (0.7.17): PUT /api/documents/bitacora/start-date corre las fechas de la
// bitacora para que la semana 1 quede ese dia; sus estudiantes la ven asi al consultar.
async function applyTeacherBitacoraStartDate(startDate) {
  const value = toText(startDate).trim();
  if (!ensureBitacoraEditable("Solo profesores pueden cambiar las fechas de la bitácora.")) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    overlayState.statusMessage = "Elige la fecha de inicio del semestre.";
    renderOverlay();
    return null;
  }
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    overlayState.statusMessage = "Inicia sesión como profesor antes de cambiar las fechas.";
    renderOverlay();
    return null;
  }

  overlayState.teacherBitacoraStatus = {
    ...normalizeTeacherBitacoraStatusPayload(overlayState.teacherBitacoraStatus),
    busy: true,
    error: "",
  };
  overlayState.statusMessage = `Corriendo las fechas de la bitácora al ${value}...`;
  renderOverlay();

  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/documents/bitacora/start-date`, {
      method: "PUT",
      headers: buildApiHeaders(),
      body: JSON.stringify(withBitacoraOwnerBody({ startDate: value })),
    }, BACKEND_TIMEOUT_MS);
    if (!response?.ok || !response.latest) {
      throw new Error(toText(response?.error) || "El backend no devolvio la bitacora.");
    }
    overlayState.teacherBitacoraStatus = {
      ...normalizeTeacherBitacoraStatusPayload({ loaded: true, latest: response.latest, summary: overlayState.teacherBitacoraStatus?.summary }),
      checkedAt: Date.now(),
    };
    overlayState.documentClassifications = {
      ...normalizeDocumentClassificationState(overlayState.documentClassifications),
      items: mergeUploadedBitacoraClassification(response.latest),
    };
    const range = typeof formatCourseDay === "function"
      ? `la semana 1 queda el ${formatCourseDay(toText(response.firstDate))} y la última fecha es el ${formatCourseDay(toText(response.lastDate))}`
      : `de ${toText(response.firstDate)} a ${toText(response.lastDate)}`;
    overlayState.statusMessage = `Fechas corridas: ${range} (${pluralizeStudentCount(response.weeks, "semana", "semanas")}).`;
    syncCampusAccessAfterBitacoraChange();
    return response;
  } catch (error) {
    overlayState.teacherBitacoraStatus = {
      ...normalizeTeacherBitacoraStatusPayload(overlayState.teacherBitacoraStatus),
      busy: false,
    };
    overlayState.statusMessage = `No se pudieron correr las fechas: ${String(error?.message || error)}`;
    return null;
  } finally {
    renderOverlay();
  }
}
