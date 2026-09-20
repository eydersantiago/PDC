// ADACEEN | Capa 4 - UI: normalizacion de las respuestas del backend que la UI pinta (contexto y documentos).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

function shortenCompactId(value, max = 10) {
  const text = toText(value);
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function formatProjectContextTimestamp(value) {
  const text = toText(value);
  if (!text) return "Sin datos";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleString();
}

function normalizeProjectContextStatusPayload(payload) {
  const source = payload?.status || payload?.context || payload || {};
  return {
    configured: !!source.configured,
    repoFullName: toText(source.repoFullName || source.repo_full_name || source.repo || ""),
    hasContext: !!(source.hasContext ?? source.contextReady ?? source.ready ?? source.available),
    latestRequestId: toText(source.latestRequestId || source.requestId || source.latest_request_id || source.currentRequestId || ""),
    latestSnapshotId: toText(source.latestSnapshotId || source.snapshotId || source.latest_snapshot_id || ""),
    latestVersion: toText(source.latestVersion || source.version || source.versionLabel || source.latest_version || ""),
    currentVersion: toText(source.currentVersion || source.current_version || source.versionName || ""),
    updatedAt: toText(source.updatedAt || source.updated_at || source.lastUpdatedAt || source.last_updated_at || ""),
    source: toText(source.source || source.contextSource || source.latestSource || ""),
    summary: toText(source.summary || source.message || source.description || ""),
    details: toText(source.details || source.note || source.extra || ""),
    totalVersions: Math.max(0, Number(source.totalVersions || source.total_versions || source.historyCount || 0) || 0),
    requestStatus: toText(source.requestStatus || source.status || ""),
  };
}

function normalizeProjectContextHistoryPayload(payload) {
  const source = payload?.history || payload?.items || payload?.versions || payload?.rebuilds || payload || [];
  const items = Array.isArray(source) ? source : [];

  return items.map((item) => ({
    requestId: toText(item?.requestId || item?.request_id || item?.id || ""),
    snapshotId: toText(item?.snapshotId || item?.snapshot_id || ""),
    version: toText(item?.version || item?.versionLabel || item?.label || item?.name || ""),
    status: toText(item?.status || item?.state || ""),
    summary: toText(item?.summary || item?.message || item?.description || ""),
    updatedAt: toText(item?.updatedAt || item?.updated_at || item?.createdAt || item?.created_at || ""),
    source: toText(item?.source || item?.origin || ""),
    canRebuild: item?.canRebuild !== false,
  }));
}

function normalizeProjectContextInsightPayload(payload) {
  const source = payload?.insight || payload?.data || payload || {};
  const rawCandidates = Array.isArray(source.candidates) ? source.candidates : [];
  return {
    ...EMPTY_PROJECT_CONTEXT_INSIGHT,
    configured: source.configured !== false,
    repoFullName: toText(source.repoFullName || source.repo_full_name || source.repo || ""),
    hasContext: !!(source.hasContext ?? source.ready ?? source.available),
    requestId: toText(source.requestId || source.request_id || ""),
    snapshotId: toText(source.snapshotId || source.snapshot_id || ""),
    version: toText(source.version || source.latestVersion || ""),
    currentVersion: toText(source.currentVersion || source.current_version || ""),
    source: toText(source.source || ""),
    updatedAt: toText(source.updatedAt || source.updated_at || ""),
    totalFiles: Math.max(0, Number(source.totalFiles || source.total_files || 0) || 0),
    totalBytes: Math.max(0, Number(source.totalBytes || source.total_bytes || 0) || 0),
    summary: toText(source.summary || ""),
    mainFilePath: toText(source.mainFilePath || source.main_file_path || ""),
    mainFileReason: toText(source.mainFileReason || source.main_file_reason || source.reason || ""),
    autoAdvice: toText(source.autoAdvice || source.auto_advice || source.advice || ""),
    modelEnabled: source.modelEnabled !== false,
    modelUsed: source.modelUsed === true,
    modelProvider: toText(source.modelProvider || source.model_provider || ""),
    candidates: rawCandidates
      .map((candidate) => ({
        path: toText(candidate?.path),
        score: Number(candidate?.score) || 0,
        reason: toText(candidate?.reason),
      }))
      .filter((candidate) => !!candidate.path)
      .slice(0, 5),
    modelError: toText(source.modelError || source.model_error || ""),
    storageReadError: toText(source.storageReadError || source.storage_read_error || ""),
    screenshotUsed: source.screenshotUsed === true || source.screenshot_used === true,
    screenshotSource: toText(source.screenshotSource || source.screenshot_source || ""),
    screenshotOcrText: toText(source.screenshotOcrText || source.screenshot_ocr_text || source.ocrText || ""),
    screenshotConfidence: Math.max(0, Number(source.screenshotConfidence || source.screenshot_confidence || source.confidence || 0) || 0),
    screenshotSavedPath: toText(source.screenshotSavedPath || source.screenshot_saved_path || ""),
    screenshotSavedAt: toText(source.screenshotSavedAt || source.screenshot_saved_at || ""),
  };
}

function normalizeDocumentClassificationsPayload(payload) {
  const source = payload?.classifications || payload?.items || payload || [];
  const items = Array.isArray(source) ? source : [];
  return items.map((item) => ({
    id: toText(item?.id),
    repoFullName: toText(item?.repoFullName || item?.repo_full_name),
    requestId: toText(item?.requestId || item?.request_id),
    snapshotId: toText(item?.snapshotId || item?.snapshot_id),
    filePath: toText(item?.filePath || item?.file_path),
    fileName: toText(item?.fileName || item?.file_name),
    label: toText(item?.label || "OTRO").toUpperCase() === "BITACORA" ? "BITACORA" : "OTRO",
    confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0)),
    method: toText(item?.method || "rules"),
    evidence: Array.isArray(item?.evidence)
      ? item.evidence.map(toText).filter(Boolean).slice(0, 8)
      : [],
    reason: toText(item?.reason),
    bitacoraAgenda: normalizeBitacoraAgendaPayload(item?.bitacoraAgenda || item?.bitacora_agenda),
    modelUsed: item?.modelUsed === true || item?.model_used === true,
    modelError: toText(item?.modelError || item?.model_error),
    classifiedAt: toText(item?.classifiedAt || item?.classified_at),
  })).filter((item) => item.filePath || item.fileName);
}

function normalizeBitacoraAgendaPayload(value) {
  const source = value && typeof value === "object" ? value : {};
  const rawItems = Array.isArray(source.items) ? source.items : [];
  return {
    items: rawItems.map((item) => ({
      title: toText(item?.title),
      type: toText(item?.type || "activity"),
      category: toText(item?.category),
      dueAt: toText(item?.dueAt || item?.due_at),
      visibleDueText: toText(item?.visibleDueText || item?.visible_due_text),
      description: toText(item?.description),
      confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0)),
      evidence: Array.isArray(item?.evidence)
        ? item.evidence.map(toText).filter(Boolean).slice(0, 6)
        : [],
    })).filter((item) => item.title).slice(0, 40),
    summary: toText(source.summary),
    warnings: Array.isArray(source.warnings)
      ? source.warnings.map(toText).filter(Boolean).slice(0, 6)
      : [],
  };
}

function normalizeDocumentClassificationState(value) {
  if (Array.isArray(value)) {
    return {
      ...EMPTY_DOCUMENT_CLASSIFICATION_STATE,
      items: normalizeDocumentClassificationsPayload(value),
    };
  }

  const source = value && typeof value === "object" ? value : {};
  return {
    ...EMPTY_DOCUMENT_CLASSIFICATION_STATE,
    items: normalizeDocumentClassificationsPayload(source.items || source.classifications || []),
    busy: source.busy === true,
    message: toText(source.message),
    error: toText(source.error),
  };
}
