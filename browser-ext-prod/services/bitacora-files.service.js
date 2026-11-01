"use strict";

// ADACEEN | Capa 3 - Servicios: archivos de la bitacora del docente: plantilla, exportar (Excel/CSV) y subir.
// Movido sin cambios de bitacora.service.js (estado, permisos y agenda).

async function downloadTeacherBitacoraTemplate() {
  if (!ensureBitacoraEditable("Solo profesores pueden descargar la plantilla.")) return;

  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    overlayState.statusMessage = "Inicia sesión como profesor antes de descargar la plantilla.";
    renderOverlay();
    return;
  }

  const context = overlayState.context || buildPayload();
  const query = new URLSearchParams();
  const courseName = toText(context.activityTitle || context.title);
  if (courseName) query.set("courseName", courseName.slice(0, 240));
  if (getBitacoraOwnerTeacherId()) query.set("teacherUserId", getBitacoraOwnerTeacherId());
  const url = `${baseUrl}/api/documents/bitacora-template${query.toString() ? `?${query.toString()}` : ""}`;

  overlayState.teacherBitacoraStatus = {
    ...normalizeTeacherBitacoraStatusPayload(overlayState.teacherBitacoraStatus),
    busy: true,
    error: "",
  };
  overlayState.statusMessage = "Descargando la plantilla de la bitácora...";
  renderOverlay();

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: buildMultipartApiHeaders(),
    });
    if (!response.ok) {
      const json = await response.json().catch(() => ({}));
      throw new Error(toText(json.error) || `HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = `plantilla_bitacora_${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(downloadUrl);
    overlayState.statusMessage = "Plantilla descargada.";
  } catch (error) {
    overlayState.statusMessage = `No se pudo descargar la plantilla: ${String(error?.message || error)}`;
  } finally {
    overlayState.teacherBitacoraStatus = {
      ...normalizeTeacherBitacoraStatusPayload(overlayState.teacherBitacoraStatus),
      busy: false,
      error: "",
    };
    renderOverlay();
  }
}

// Exportar la bitacora cargada (0.7.15): GET /api/documents/bitacora/export?format=xlsx|csv con
// el diseno de la plantilla; el Excel se puede volver a cargar aqui, el CSV va a Excel o Power BI.
async function exportTeacherBitacora(format = "xlsx") {
  if (!ensureBitacoraEditable("Solo profesores pueden exportar la bitácora.")) return;
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    overlayState.statusMessage = "Inicia sesión como profesor antes de exportar la bitácora.";
    renderOverlay();
    return;
  }
  const kind = format === "csv" ? "csv" : "xlsx";
  const query = new URLSearchParams({ format: kind });
  const courseCode = normalizeRagCourseCodeUi(getActiveCampusCourseCode());
  if (courseCode) query.set("courseCode", courseCode);
  if (getBitacoraOwnerTeacherId()) query.set("teacherUserId", getBitacoraOwnerTeacherId());
  const url = `${baseUrl}/api/documents/bitacora/export?${query.toString()}`;

  overlayState.teacherBitacoraStatus = {
    ...normalizeTeacherBitacoraStatusPayload(overlayState.teacherBitacoraStatus),
    busy: true,
    error: "",
  };
  overlayState.statusMessage = `Exportando la bitácora en ${kind === "csv" ? "CSV" : "Excel"}...`;
  renderOverlay();

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: buildMultipartApiHeaders(),
    });
    if (!response.ok) {
      const json = await response.json().catch(() => ({}));
      throw new Error(toText(json.error) || `HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const disposition = toText(response.headers.get("content-disposition"));
    const match = /filename="([^"]+)"/.exec(disposition);
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = match?.[1] || `bitacora_${courseCode.toLowerCase() || "curso"}_${new Date().toISOString().slice(0, 10)}.${kind}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(downloadUrl);
    overlayState.statusMessage = kind === "csv" ? "Bitácora exportada en CSV." : "Bitácora exportada en Excel.";
  } catch (error) {
    overlayState.statusMessage = `No se pudo exportar la bitácora: ${String(error?.message || error)}`;
  } finally {
    overlayState.teacherBitacoraStatus = {
      ...normalizeTeacherBitacoraStatusPayload(overlayState.teacherBitacoraStatus),
      busy: false,
      error: "",
    };
    renderOverlay();
  }
}

function buildUploadedBitacoraFallbackItem(response, file) {
  const classification = response?.classification || {};
  const importResult = response?.import || {};
  return {
    id: `teacher-bitacora-${Date.now()}`,
    repoFullName: "",
    requestId: "",
    snapshotId: "",
    filePath: toText(file?.name) || "bitacora_import",
    fileName: toText(file?.name) || "bitacora_import",
    label: toText(classification.label).toUpperCase() === "BITACORA" ? "BITACORA" : "OTRO",
    confidence: Math.max(0, Math.min(1, Number(classification.confidence) || 0)),
    method: toText(classification.method || "rules"),
    evidence: Array.isArray(classification.evidence)
      ? classification.evidence.map(toText).filter(Boolean).slice(0, 8)
      : [],
    reason: toText(classification.reason),
    bitacoraAgenda: importResult.bitacoraAgenda || { items: [], summary: "", warnings: [] },
    modelUsed: response?.modelUsed === true,
    modelError: toText(response?.modelError),
    classifiedAt: new Date().toISOString(),
  };
}

function mergeUploadedBitacoraClassification(rawItem) {
  const state = typeof normalizeDocumentClassificationState === "function"
    ? normalizeDocumentClassificationState(overlayState.documentClassifications)
    : { items: [] };
  const normalized = typeof normalizeDocumentClassificationsPayload === "function"
    ? normalizeDocumentClassificationsPayload([rawItem])[0]
    : rawItem;
  if (!normalized) return state.items || [];

  const key = `${toText(normalized.fileName)}|${toText(normalized.filePath)}`;
  const existing = Array.isArray(state.items) ? state.items : [];
  return [
    normalized,
    ...existing.filter((item) => `${toText(item.fileName)}|${toText(item.filePath)}` !== key),
  ].slice(0, MAX_ANALYSIS_RENDER_ITEMS);
}

async function uploadTeacherBitacoraFile(file) {
  if (!file) return;

  if (!ensureBitacoraEditable("Solo profesores pueden subir la bitácora.")) return;

  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    overlayState.statusMessage = "Inicia sesión como profesor antes de subir la bitácora.";
    renderOverlay();
    return;
  }

  if (Number(file.size) > CAMPUS_BITACORA_UPLOAD_MAX_BYTES) {
    overlayState.statusMessage =
      `La bitácora supera ${Math.round(CAMPUS_BITACORA_UPLOAD_MAX_BYTES / (1024 * 1024))} MB.`;
    renderOverlay();
    return;
  }

  const form = new FormData();
  form.append("file", file, file.name);
  form.append("fileName", file.name);
  if (getBitacoraOwnerTeacherId()) form.append("teacherUserId", getBitacoraOwnerTeacherId());

  overlayState.analysisBusy = true;
  overlayState.statusMessage = `Subiendo la bitácora: ${file.name}...`;
  overlayState.documentClassifications = {
    ...normalizeDocumentClassificationState(overlayState.documentClassifications),
    busy: true,
    message: `Subiendo ${file.name}...`,
    error: "",
  };
  renderOverlay();

  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/documents/bitacora/import`, {
      method: "POST",
      headers: buildMultipartApiHeaders(),
      body: form,
    }, CAMPUS_BITACORA_UPLOAD_TIMEOUT_MS);

    if (!response?.ok) {
      throw new Error(toText(response?.error) || "No se pudo importar la bitácora.");
    }

    const rawItem = response.stored || buildUploadedBitacoraFallbackItem(response, file);
    const nextItems = mergeUploadedBitacoraClassification(rawItem);
    const agendaItems = Array.isArray(response.import?.bitacoraAgenda?.items)
      ? response.import.bitacoraAgenda.items
      : [];
    const rowsUsed = Number(response.import?.rowsUsed) || agendaItems.length || 0;
    const label = toText(response.classification?.label).toUpperCase();
    const okMessage = label === "BITACORA"
      ? `Bitácora subida: ${rowsUsed} registro(s) detectado(s).`
      : `Se subió ${file.name}, pero no parece una bitácora con semanas y fechas: revisa que siga la plantilla.`;

    overlayState.documentClassifications = {
      items: nextItems,
      busy: false,
      message: okMessage,
      error: "",
    };
    // Un archivo que no es bitacora no reemplaza la cargada: el backend la sigue dando como la ultima.
    overlayState.teacherBitacoraStatus = label === "BITACORA"
      ? {
        loaded: true,
        latest: rawItem,
        summary: {
          fileName: toText(rawItem.fileName || file.name),
          label,
          confidence: Number(rawItem.confidence) || Number(response.classification?.confidence) || 0,
          rows: rowsUsed,
          updatedAt: new Date().toISOString(),
        },
        busy: false,
        checking: false,
        error: "",
        checkedAt: Date.now(),
      }
      : { ...normalizeTeacherBitacoraStatusPayload(overlayState.teacherBitacoraStatus), busy: false, error: "" };
    overlayState.analysisUnlocked = true;
    // El resultado se ve en la pestana «Bitacora» (0.7.16): la ventana de analisis ya no se abre.
    overlayState.analysisWindowOpen = false;
    overlayState.statusMessage = okMessage;
    if (label === "BITACORA") syncCampusAccessAfterBitacoraChange();
  } catch (error) {
    const message = `No se pudo subir la bitácora: ${String(error?.message || error)}`;
    overlayState.documentClassifications = {
      ...normalizeDocumentClassificationState(overlayState.documentClassifications),
      busy: false,
      message: "",
      error: message,
    };
    overlayState.statusMessage = message;
  } finally {
    overlayState.analysisBusy = false;
    renderOverlay();
  }
}
