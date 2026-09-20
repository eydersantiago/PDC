// ADACEEN | Capa 5 - Ciclo de vida: paleta en linea de VS Code: sondeo del rack y envio de acciones de codigo.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const VSCODE_SYNC_POLL_INTERVAL_MS = 5000;
let vscodeSyncPollTimer = 0;
let vscodeInlinePaletteRaf = 0;
let vscodeInlinePaletteListenersBound = false;

function scheduleVscodeInlinePaletteReposition() {
  if (vscodeInlinePaletteRaf) return;
  vscodeInlinePaletteRaf = window.requestAnimationFrame(() => {
    vscodeInlinePaletteRaf = 0;
    repositionVscodeInlinePalette();
  });
}

function bindVscodeInlinePaletteListeners() {
  if (vscodeInlinePaletteListenersBound) return;
  vscodeInlinePaletteListenersBound = true;
  window.addEventListener("pointermove", (event) => {
    lastPointerPosition = { x: event.clientX, y: event.clientY };
  }, { capture: true, passive: true });
  document.addEventListener("selectionchange", scheduleVscodeInlinePaletteReposition, true);
  window.addEventListener("scroll", scheduleVscodeInlinePaletteReposition, { capture: true, passive: true });
  window.addEventListener("resize", scheduleVscodeInlinePaletteReposition, { passive: true });
  window.addEventListener("keyup", scheduleVscodeInlinePaletteReposition, true);
  window.addEventListener("pointerup", scheduleVscodeInlinePaletteReposition, true);
}

function clearVscodeSyncPolling() {
  if (!vscodeSyncPollTimer) return;
  window.clearInterval(vscodeSyncPollTimer);
  vscodeSyncPollTimer = 0;
}

function startVscodeSyncPolling() {
  if (vscodeSyncPollTimer) return;
  vscodeSyncPollTimer = window.setInterval(async () => {
    if (!overlayHost?.isConnected || document.visibilityState === "hidden") return;
    const context = buildPayload();
    if (!hasActiveSession() || context.pageType !== "codespace" || isAdminSession()) return;
    overlayState.context = context;
    await refreshVscodeSyncState({ silent: true }).catch(() => {});
    renderOverlay();
    queueTabSessionSave();
  }, VSCODE_SYNC_POLL_INTERVAL_MS);
}

async function sendVscodeReplacementOptionByIndex(index, requestedFrom) {
  const rack = overlayState.vscodeSyncState?.latestRack || {};
  const context = getPageContext();
  const options = Array.isArray(overlayState.vscodeSyncState?.resolvedReplacementOptions)
    ? overlayState.vscodeSyncState.resolvedReplacementOptions
    : resolveVscodeReplacementOptions(rack, context);
  const option = options[index];
  if (!option) return;
  try {
    await queueVscodeReplacementOption(option, { requestedFrom });
  } catch (error) {
    overlayState.statusMessage = `No se pudo enviar el reemplazo: ${String(error)}`;
    renderOverlay();
  }
}
