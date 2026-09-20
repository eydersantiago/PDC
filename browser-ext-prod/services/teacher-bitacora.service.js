// ADACEEN | Capa 3 - Servicios: bitacora del docente: estado, plantilla, carga de archivo, registro manual y borrado.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const CAMPUS_BITACORA_UPLOAD_MAX_BYTES = 12 * 1024 * 1024;
const CAMPUS_BITACORA_UPLOAD_TIMEOUT_MS = 120000;
const CAMPUS_BITACORA_UPLOAD_ACCEPT = ".xlsx,.xls,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel";
const CAMPUS_BITACORA_ACTIVITY_CATEGORIES = new Set(["Actividad", "Proyecto", "Ejercicio", "Parcial", "Quiz"]);

function normalizeTeacherBitacoraStatusPayload(payload) {
  const latest = payload?.latest || null;
  return {
    loaded: payload?.loaded === true || !!latest,
    latest,
    summary: payload?.summary || null,
    busy: false,
    error: "",
  };
}

function getLocalLatestBitacoraItem() {
  const state = normalizeDocumentClassificationState(overlayState.documentClassifications);
  const items = Array.isArray(state.items) ? state.items : [];
  return items.find((item) => item.label === "BITACORA") || null;
}

function getTeacherBitacoraDisplayItem() {
  const remoteLatest = overlayState.teacherBitacoraStatus?.latest || null;
  return remoteLatest || getLocalLatestBitacoraItem();
}

function getBitacoraEvidenceValue(item, label) {
  const normalizedLabel = normalizeCampusDateText(label);
  const evidence = Array.isArray(item?.evidence) ? item.evidence : [];
  for (const entry of evidence) {
    const text = toText(entry);
    const parts = text.split(":");
    if (parts.length < 2) continue;
    if (normalizeCampusDateText(parts[0]) === normalizedLabel) {
      return parts.slice(1).join(":").trim();
    }
  }
  return "";
}

function getBitacoraDescriptionValue(item, labels) {
  const description = toText(item?.description);
  if (!description) return "";
  const chunks = description.split("|").map((chunk) => chunk.trim()).filter(Boolean);
  const wanted = labels.map((label) => normalizeCampusDateText(label));
  for (const chunk of chunks) {
    const colon = chunk.indexOf(":");
    if (colon < 0) continue;
    const key = normalizeCampusDateText(chunk.slice(0, colon));
    if (wanted.includes(key)) {
      return chunk.slice(colon + 1).trim();
    }
  }
  return "";
}

function removeRepeatedBitacoraText(value) {
  const text = toText(value).replace(/\s+/g, " ").trim();
  const words = text.split(" ").filter(Boolean);
  for (let size = Math.floor(words.length / 2); size >= 1; size -= 1) {
    const first = words.slice(0, size).join(" ").toLowerCase();
    const second = words.slice(size, size * 2).join(" ").toLowerCase();
    if (first && first === second) {
      return words.slice(0, size).join(" ");
    }
  }
  return text;
}

function cleanBitacoraAgendaTitle(item) {
  const title = toText(item?.title).replace(/^Examen:\s*/i, "").trim();
  return removeRepeatedBitacoraText(title);
}

function getBitacoraItemCategory(item) {
  return toText(item?.category)
    || getBitacoraEvidenceValue(item, "Clasificación")
    || getBitacoraDescriptionValue(item, ["Clasificación", "Tipo"]);
}

function normalizeTeacherBitacoraManualCategory(value) {
  const text = toText(value).trim();
  for (const category of CAMPUS_BITACORA_ACTIVITY_CATEGORIES) {
    if (category.toLowerCase() === text.toLowerCase()) return category;
  }
  return "Actividad";
}

function addUniqueText(list, value) {
  const text = toText(value).replace(/\s+/g, " ").trim();
  if (!text) return;
  if (!list.some((item) => normalizeCampusDateText(item) === normalizeCampusDateText(text))) {
    list.push(text);
  }
}

function groupTeacherBitacoraAgenda(agendaItems) {
  const groups = new Map();
  for (const item of agendaItems) {
    const dateText = toText(item?.visibleDueText) || toText(item?.dueAt).slice(0, 10);
    const week = getBitacoraEvidenceValue(item, "Semana");
    const key = `${week || "sin-semana"}|${dateText || "sin-fecha"}`;
    const group = groups.get(key) || {
      week,
      dateText,
      dueAt: toText(item?.dueAt),
      topic: "",
      classActivities: [],
      evaluations: [],
      projects: [],
      exercises: [],
      quizzes: [],
      partials: [],
    };
    const topic = getBitacoraDescriptionValue(item, ["Tema", "Subtipo"]);
    if (!group.topic && topic) group.topic = topic;

    const source = normalizeCampusDateText(getBitacoraEvidenceValue(item, "Hoja"));
    const itemType = toText(item?.type);
    const category = normalizeTeacherBitacoraManualCategory(getBitacoraItemCategory(item));
    const isEvaluation = source.includes("examen") || itemType === "task" || /^examen:/i.test(toText(item?.title));
    const text = getBitacoraDescriptionValue(item, ["Actividades evaluación", "Evaluacion relacionada", "Actividades en clase"])
      || cleanBitacoraAgendaTitle(item);
    if (category === "Proyecto") {
      addUniqueText(group.projects, text);
    } else if (category === "Ejercicio") {
      addUniqueText(group.exercises, text);
    } else if (category === "Parcial") {
      addUniqueText(group.partials, text);
    } else if (category === "Quiz") {
      addUniqueText(group.quizzes, text);
    } else if (isEvaluation) {
      addUniqueText(group.evaluations, getBitacoraDescriptionValue(item, ["Actividades evaluación", "Evaluacion relacionada"]) || cleanBitacoraAgendaTitle(item));
    } else {
      addUniqueText(group.classActivities, getBitacoraDescriptionValue(item, ["Actividades en clase"]) || cleanBitacoraAgendaTitle(item));
    }
    groups.set(key, group);
  }

  return [...groups.values()].sort((left, right) => {
    const leftDate = toText(left.dueAt || left.dateText);
    const rightDate = toText(right.dueAt || right.dateText);
    if (leftDate && rightDate && leftDate !== rightDate) return leftDate.localeCompare(rightDate);
    return (Number(left.week) || 0) - (Number(right.week) || 0);
  });
}

function appendBitacoraLine(parent, kind, text) {
  if (!text) return;
  const row = document.createElement("div");
  row.className = `bitacora-line bitacora-line-${kind}`;
  const label = document.createElement("span");
  label.className = "bitacora-line-label";
  const labelByKind = {
    class: "Actividad",
    evaluation: "Evaluacion",
    project: "Proyecto",
    exercise: "Ejercicio",
    partial: "Parcial",
    quiz: "Quiz",
  };
  label.textContent = labelByKind[kind] || "Actividad";
  const body = document.createElement("span");
  body.className = "bitacora-line-body";
  body.textContent = text;
  row.append(label, body);
  parent.appendChild(row);
}

function renderTeacherBitacoraAgendaList(listEl, agendaItems) {
  if (!listEl) return;
  listEl.textContent = "";
  listEl.classList.add("bitacora-week-list");
  const groups = groupTeacherBitacoraAgenda(agendaItems);
  if (!groups.length) {
    const empty = document.createElement("li");
    empty.className = "bitacora-week-item bitacora-week-empty";
    empty.textContent = "Sin registros de agenda detectados todavia.";
    listEl.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const group of groups.slice(0, 20)) {
    const li = document.createElement("li");
    li.className = "bitacora-week-item";
    const head = document.createElement("div");
    head.className = "bitacora-week-head";
    const week = document.createElement("strong");
    week.textContent = group.week ? `Semana ${group.week}` : "Sin semana";
    const date = document.createElement("span");
    date.textContent = group.dateText || "Sin fecha";
    head.append(week, date);
    li.appendChild(head);

    if (group.topic) {
      const topic = document.createElement("p");
      topic.className = "bitacora-topic";
      topic.textContent = group.topic;
      li.appendChild(topic);
    }

    const body = document.createElement("div");
    body.className = "bitacora-week-lines";
    for (const classActivity of group.classActivities) appendBitacoraLine(body, "class", classActivity);
    for (const project of group.projects) appendBitacoraLine(body, "project", project);
    for (const exercise of group.exercises) appendBitacoraLine(body, "exercise", exercise);
    for (const partial of group.partials) appendBitacoraLine(body, "partial", partial);
    for (const quiz of group.quizzes) appendBitacoraLine(body, "quiz", quiz);
    for (const evaluation of group.evaluations) appendBitacoraLine(body, "evaluation", evaluation);
    li.appendChild(body);
    fragment.appendChild(li);
  }

  if (groups.length > 20) {
    const more = document.createElement("li");
    more.className = "bitacora-week-item bitacora-week-empty";
    more.textContent = `Mostrando 20 de ${groups.length} semanas detectadas.`;
    fragment.appendChild(more);
  }
  listEl.appendChild(fragment);
}

function renderTeacherBitacoraPage() {
  if (!overlayEls?.teacherBitacoraPage) return;
  const visible = !!overlayState.teacherBitacoraPageOpen && isTeacherSession();
  overlayEls.teacherBitacoraPage.hidden = !visible;
  if (!visible) return;

  const status = overlayState.teacherBitacoraStatus || EMPTY_TEACHER_BITACORA_STATUS;
  const item = getTeacherBitacoraDisplayItem();
  const agendaItems = Array.isArray(item?.bitacoraAgenda?.items) ? item.bitacoraAgenda.items : [];
  const statusText = status.busy
    ? "Consultando bitacora cargada..."
    : status.error
      ? status.error
      : item
        ? "Bitacora cargada. Puedes reemplazarla con un Excel/PDF actualizado."
        : "Aun no hay bitacora cargada para este docente.";

  overlayEls.teacherBitacoraStatusText.textContent = statusText;
  overlayEls.teacherBitacoraPageStatus.textContent = overlayState.documentClassifications?.error
    || overlayState.documentClassifications?.message
    || overlayState.statusMessage
    || "";
  const weekCount = agendaItems.length ? groupTeacherBitacoraAgenda(agendaItems).length : 0;
  overlayEls.teacherBitacoraLatestText.textContent = item
    ? [
      `${toText(item.fileName || item.filePath) || "bitacora"}`,
      `${weekCount} semana(s)`,
      `${agendaItems.length} registro(s)`,
      item.updatedAt || item.classifiedAt ? `Actualizado ${new Date(item.updatedAt || item.classifiedAt).toLocaleString()}` : "",
    ].filter(Boolean).join(" · ")
    : "Aun no hay bitacora cargada. Descarga la plantilla o sube un PDF/Excel.";

  renderTeacherBitacoraAgendaList(overlayEls.teacherBitacoraAgendaList, agendaItems);

  overlayEls.teacherBitacoraDownloadTemplateBtn.disabled = status.busy || overlayState.analysisBusy;
  overlayEls.teacherBitacoraChooseFileBtn.disabled = status.busy || overlayState.analysisBusy;
  if (overlayEls.teacherBitacoraManualSaveBtn) {
    overlayEls.teacherBitacoraManualSaveBtn.disabled = status.busy || overlayState.analysisBusy;
  }
  if (overlayEls.teacherBitacoraManualClearBtn) {
    overlayEls.teacherBitacoraManualClearBtn.disabled = status.busy || overlayState.analysisBusy;
  }
  if (overlayEls.teacherBitacoraDeleteLatestBtn) {
    overlayEls.teacherBitacoraDeleteLatestBtn.disabled = status.busy || overlayState.analysisBusy || !item;
  }
  if (overlayEls.teacherBitacoraClearDataBtn) {
    overlayEls.teacherBitacoraClearDataBtn.disabled = status.busy || overlayState.analysisBusy || !item;
  }
}

async function refreshTeacherBitacoraStatus() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId || !isTeacherSession()) return null;

  overlayState.teacherBitacoraStatus = {
    ...normalizeTeacherBitacoraStatusPayload(overlayState.teacherBitacoraStatus),
    busy: true,
    error: "",
  };
  renderOverlay();

  try {
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/documents/bitacora/status`, {
      method: "GET",
      headers: buildApiHeaders(),
    }, BACKEND_TIMEOUT_MS);
    overlayState.teacherBitacoraStatus = normalizeTeacherBitacoraStatusPayload(response);
    if (response?.latest) {
      const nextItems = mergeUploadedBitacoraClassification(response.latest);
      overlayState.documentClassifications = {
        ...normalizeDocumentClassificationState(overlayState.documentClassifications),
        items: nextItems,
      };
    }
    return overlayState.teacherBitacoraStatus;
  } catch (error) {
    overlayState.teacherBitacoraStatus = {
      ...EMPTY_TEACHER_BITACORA_STATUS,
      busy: false,
      error: `No se pudo consultar la bitacora: ${String(error?.message || error)}`,
    };
    return null;
  } finally {
    renderOverlay();
  }
}

async function openTeacherBitacoraPage() {
  if (!isTeacherSession()) {
    overlayState.statusMessage = "Solo profesores pueden gestionar bitacoras.";
    renderOverlay();
    return;
  }
  overlayState.teacherBitacoraPageOpen = true;
  overlayState.teacherRagPageOpen = false;
  overlayState.analysisWindowOpen = false;
  renderOverlay();
  await refreshTeacherBitacoraStatus();
}

function closeTeacherBitacoraPage() {
  overlayState.teacherBitacoraPageOpen = false;
  renderOverlay();
}

function clearTeacherBitacoraManualForm() {
  if (overlayEls?.teacherBitacoraManualWeekInput) overlayEls.teacherBitacoraManualWeekInput.value = "";
  if (overlayEls?.teacherBitacoraManualDateInput) overlayEls.teacherBitacoraManualDateInput.value = "";
  if (overlayEls?.teacherBitacoraManualCategorySelect) overlayEls.teacherBitacoraManualCategorySelect.value = "Actividad";
  if (overlayEls?.teacherBitacoraManualTitleInput) overlayEls.teacherBitacoraManualTitleInput.value = "";
  if (overlayEls?.teacherBitacoraManualDescriptionInput) overlayEls.teacherBitacoraManualDescriptionInput.value = "";
}

async function saveTeacherBitacoraManualEntry() {
  if (!isTeacherSession()) {
    overlayState.statusMessage = "Solo profesores pueden guardar bitacoras.";
    renderOverlay();
    return;
  }

  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    overlayState.statusMessage = "Inicia sesion como profesor antes de guardar la bitacora.";
    renderOverlay();
    return;
  }

  const title = toText(overlayEls?.teacherBitacoraManualTitleInput?.value).trim();
  const description = toText(overlayEls?.teacherBitacoraManualDescriptionInput?.value).trim();
  if (!title && !description) {
    overlayState.statusMessage = "Escribe un titulo o detalle para guardar el registro.";
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
  overlayState.statusMessage = `Guardando ${category.toLowerCase()} en la bitacora...`;
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
      body: JSON.stringify({
        sourceName: `bitacora_manual_${new Date().toISOString().slice(0, 10)}.json`,
        activities: [item],
        exams: [],
      }),
    }, CAMPUS_BITACORA_UPLOAD_TIMEOUT_MS);

    if (!response?.ok) {
      throw new Error(toText(response?.error) || "No se pudo guardar la bitacora manual.");
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
      message: `Bitacora actualizada: ${rowsUsed} registro(s) manual(es).`,
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
      error: "",
    };
    overlayState.analysisUnlocked = true;
    overlayState.analysisWindowOpen = false;
    overlayState.statusMessage = `Registro clasificado como ${category} y guardado en la bitacora.`;
    clearTeacherBitacoraManualForm();
  } catch (error) {
    const message = `No se pudo guardar la bitacora manual: ${String(error?.message || error)}`;
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

async function downloadTeacherBitacoraTemplate() {
  if (!isTeacherSession()) {
    overlayState.statusMessage = "Solo profesores pueden descargar la plantilla.";
    renderOverlay();
    return;
  }

  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    overlayState.statusMessage = "Inicia sesion como profesor antes de descargar la plantilla.";
    renderOverlay();
    return;
  }

  const context = getPageContext();
  const query = new URLSearchParams();
  const courseName = toText(context.activityTitle || context.title);
  if (courseName) query.set("courseName", courseName.slice(0, 240));
  const url = `${baseUrl}/api/documents/bitacora-template${query.toString() ? `?${query.toString()}` : ""}`;

  overlayState.teacherBitacoraStatus = {
    ...normalizeTeacherBitacoraStatusPayload(overlayState.teacherBitacoraStatus),
    busy: true,
    error: "",
  };
  overlayState.statusMessage = "Descargando plantilla de bitacora...";
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

function openTeacherBitacoraFilePicker() {
  if (!isTeacherSession()) {
    overlayState.statusMessage = "Solo profesores pueden subir bitacoras.";
    renderOverlay();
    return;
  }

  const input = overlayEls?.teacherBitacoraFileInput;
  if (!input) {
    overlayState.statusMessage = "No se encontro el selector de archivo de bitacora.";
    renderOverlay();
    return;
  }

  input.accept = CAMPUS_BITACORA_UPLOAD_ACCEPT;
  input.value = "";
  input.click();
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
  const state = normalizeDocumentClassificationState(overlayState.documentClassifications);
  const normalized = normalizeDocumentClassificationsPayload([rawItem])[0];
  if (!normalized) return state.items || [];

  const key = `${toText(normalized.fileName)}|${toText(normalized.filePath)}`;
  const existing = Array.isArray(state.items) ? state.items : [];
  return [
    normalized,
    ...existing.filter((item) => `${toText(item.fileName)}|${toText(item.filePath)}` !== key),
  ].slice(0, MAX_ANALYSIS_RENDER_ITEMS);
}

function removeTeacherBitacoraLocalItems(options = {}) {
  const state = normalizeDocumentClassificationState(overlayState.documentClassifications);
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
  if (!isTeacherSession()) {
    overlayState.statusMessage = "Solo profesores pueden eliminar bitacoras.";
    renderOverlay();
    return;
  }

  const item = getTeacherBitacoraDisplayItem();
  if (!item) {
    overlayState.statusMessage = "No hay bitacora cargada para eliminar.";
    renderOverlay();
    return;
  }

  const deleteAll = scope === "all";
  const confirmed = confirm(deleteAll
    ? "Se borraran todos los datos de bitacora guardados para este docente. ¿Continuar?"
    : "Se eliminara la bitacora cargada mas reciente. ¿Continuar?");
  if (!confirmed) return;

  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    overlayState.statusMessage = "Inicia sesion como profesor antes de eliminar la bitacora.";
    renderOverlay();
    return;
  }

  overlayState.teacherBitacoraStatus = {
    ...normalizeTeacherBitacoraStatusPayload(overlayState.teacherBitacoraStatus),
    busy: true,
    error: "",
  };
  overlayState.statusMessage = deleteAll
    ? "Borrando datos de bitacora..."
    : "Eliminando bitacora cargada...";
  renderOverlay();

  let refreshed = false;
  try {
    const endpoint = deleteAll ? "data" : "latest";
    const response = await fetchJsonWithTimeout(`${baseUrl}/api/documents/bitacora/${endpoint}`, {
      method: "DELETE",
      headers: buildApiHeaders(),
    }, BACKEND_TIMEOUT_MS);

    if (!response?.ok) {
      throw new Error(toText(response?.error) || "No se pudo eliminar la bitacora.");
    }

    const deleted = Array.isArray(response.deleted) ? response.deleted : [];
    const deletedIds = deleted.map((row) => toText(row?.id)).filter(Boolean);
    removeTeacherBitacoraLocalItems({ all: deleteAll, deletedIds });
    overlayState.statusMessage = deleteAll
      ? `Datos de bitacora borrados: ${Number(response.deletedCount) || 0} registro(s).`
      : Number(response.deletedCount) > 0
        ? "Bitacora eliminada."
        : "No habia bitacora cargada para eliminar.";

    if (deleteAll) {
      overlayState.teacherBitacoraStatus = { ...EMPTY_TEACHER_BITACORA_STATUS };
    } else {
      refreshed = true;
      await refreshTeacherBitacoraStatus();
    }
  } catch (error) {
    overlayState.teacherBitacoraStatus = {
      ...normalizeTeacherBitacoraStatusPayload(overlayState.teacherBitacoraStatus),
      busy: false,
      error: `No se pudo eliminar la bitacora: ${String(error?.message || error)}`,
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

async function uploadTeacherBitacoraFile(file) {
  if (!file) return;

  if (!isTeacherSession()) {
    overlayState.statusMessage = "Solo profesores pueden subir bitacoras.";
    renderOverlay();
    return;
  }

  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) {
    overlayState.statusMessage = "Inicia sesion como profesor antes de subir la bitacora.";
    renderOverlay();
    return;
  }

  if (Number(file.size) > CAMPUS_BITACORA_UPLOAD_MAX_BYTES) {
    overlayState.statusMessage =
      `La bitacora supera ${Math.round(CAMPUS_BITACORA_UPLOAD_MAX_BYTES / (1024 * 1024))} MB.`;
    renderOverlay();
    return;
  }

  const form = new FormData();
  form.append("file", file, file.name);
  form.append("fileName", file.name);

  overlayState.analysisBusy = true;
  overlayState.statusMessage = `Subiendo bitacora: ${file.name}...`;
  overlayState.documentClassifications = {
    ...normalizeDocumentClassificationState(overlayState.documentClassifications),
    busy: true,
    message: `Importando bitacora: ${file.name}...`,
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
      throw new Error(toText(response?.error) || "No se pudo importar la bitacora.");
    }

    const rawItem = response.stored || buildUploadedBitacoraFallbackItem(response, file);
    const nextItems = mergeUploadedBitacoraClassification(rawItem);
    const agendaItems = Array.isArray(response.import?.bitacoraAgenda?.items)
      ? response.import.bitacoraAgenda.items
      : [];
    const rowsUsed = Number(response.import?.rowsUsed) || agendaItems.length || 0;
    const label = toText(response.classification?.label).toUpperCase();
    const okMessage = label === "BITACORA"
      ? `Bitacora importada: ${rowsUsed} registro(s) detectado(s).`
      : "Archivo importado, pero no se confirmo como bitacora estructurada.";

    overlayState.documentClassifications = {
      items: nextItems,
      busy: false,
      message: okMessage,
      error: "",
    };
    overlayState.teacherBitacoraStatus = {
      loaded: label === "BITACORA",
      latest: rawItem,
      summary: {
        fileName: toText(rawItem.fileName || file.name),
        label,
        confidence: Number(rawItem.confidence) || Number(response.classification?.confidence) || 0,
        rows: rowsUsed,
        updatedAt: new Date().toISOString(),
      },
      busy: false,
      error: "",
    };
    overlayState.analysisUnlocked = true;
    overlayState.analysisWindowOpen = !overlayState.teacherBitacoraPageOpen;
    overlayState.statusMessage = okMessage;
  } catch (error) {
    const message = `No se pudo subir la bitacora: ${String(error?.message || error)}`;
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
