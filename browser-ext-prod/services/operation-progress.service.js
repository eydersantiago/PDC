// ADACEEN | Capa 3 - Servicios: banner de operacion en curso (titulo, detalle y estado) compartido por los flujos largos.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

function setOperationProgress(title, detail = "", kind = "busy", syncStatus = false) {
  overlayState.operationTitle = toText(title);
  overlayState.operationDetail = toText(detail);
  overlayState.operationKind = toText(kind) || "busy";
  if (syncStatus && title) {
    overlayState.statusMessage = overlayState.operationDetail || overlayState.operationTitle;
  }
  renderOverlay();
}

function setOperationError(title, detail = "") {
  setOperationProgress(title || "No se pudo continuar", detail, "error", true);
}

function clearOperationProgress(finalMessage = "") {
  overlayState.operationTitle = "";
  overlayState.operationDetail = "";
  overlayState.operationKind = "busy";
  if (finalMessage) {
    overlayState.statusMessage = finalMessage;
  }
}
