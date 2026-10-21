// ADACEEN | Capa 4 - UI: estado de VS Code en la pestana «Inicio» de las paginas de editor (vscode.dev
// o Codespaces): una linea con el estado, «Copiar codigo para VS Code» y «Sincronizar», y el sondeo
// del estado cada 5 s.
// 0.8.3 (reunion del 20/10/2026): se quitaron la tarjeta blanca flotante «Contexto de trabajo», que
// seguia al puntero y tapaba el panel, y la paleta junto al cursor, que sin codigo del tutor solo
// podia agregar un comentario «TODO». El resumen del archivo, la sugerencia con su codigo y el
// material del curso estan en VS Code (vista «Este archivo» y ventana de la seleccion, 0.0.34).
// Sin "use strict": el codigo viene de archivos en modo no estricto y se conserva igual.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

const VSCODE_SYNC_POLL_INTERVAL_MS = 5000;

let vscodeSyncPollTimer = 0;

// Estado de la linea «Tu VS Code»: kind pinta el punto (ok, warn, idle o busy).
function buildVscodeSyncLineModel(context, state) {
  const rack = state.latestRack || {};
  const filePath = toText(rack.activeFilePath || context.filePath);
  const fileName = filePath.split(/[\\/]/).filter(Boolean).pop() || "";
  const updatedAt = toText(rack.updatedAt || rack.generatedAt || state.updatedAt);
  // «actualizado hace 3 min» (formato de la tabla de estudiantes) en vez de la fecha completa.
  const updatedLabel = updatedAt && state.connected ? formatStudentRelativeTime(updatedAt).toLowerCase() : "";

  let kind = "idle";
  let status = "VS Code aun no publico contexto";
  if (state.busy) {
    kind = "busy";
    status = "Sincronizando con VS Code...";
  } else if (state.connected && state.fresh) {
    kind = "ok";
    status = "VS Code conectado";
  } else if (state.connected) {
    kind = "warn";
    status = "VS Code sin actividad reciente";
  } else if (state.error) {
    kind = "warn";
  }

  const message = state.error
    ? toText(state.message) || "No se pudo leer el estado de VS Code."
    : toText(state.message);
  const metaParts = [
    fileName,
    updatedLabel ? `actualizado ${updatedLabel}` : "",
    message,
  ].filter(Boolean);
  const meta = metaParts.join(" · ")
    || (isTunnelEditorPage(context)
      ? "Abre un archivo en tu editor: la extension ADACEEN de VS Code se conecta sola."
      : "Abre el archivo en Codespaces y ejecuta ADACEEN en VS Code.");
  return { kind, status, meta };
}

function renderVscodeSyncPanel(context, showingMainView) {
  const section = overlayEls?.vscodeSyncSection;
  if (!section) return;

  // Vive dentro de «Inicio»: en las otras pestanas no se ve y ya no tapa nada.
  const visible = showingMainView && context.pageType === "codespace" && !isAdminSession();
  section.hidden = !visible;
  if (!visible) return;

  const state = overlayState.vscodeSyncState || EMPTY_VSCODE_SYNC_STATE;
  const model = buildVscodeSyncLineModel(context, state);
  section.className = `vscode-link is-${model.kind}`;
  setTextIfChanged(overlayEls.vscodeSyncStatus, model.status);
  setTextIfChanged(overlayEls.vscodeSyncMeta, model.meta);
  // En vscode.dev (tunel) la VM ya escribio la sesion de VS Code: con VS Code conectado el
  // codigo para VS Code no hace falta y el boton no se muestra.
  overlayEls.vscodeCopySessionBtn.hidden = isTunnelEditorPage(context) && !!state.connected && !!state.fresh;
  overlayEls.vscodeCopySessionBtn.disabled = !!state.busy || !overlayState.sessionId;
  overlayEls.vscodeSyncRefreshBtn.disabled = !!state.busy || overlayState.loading || overlayState.analysisBusy;
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
    if (typeof refreshVscodeSyncState !== "function") return;
    await refreshVscodeSyncState({ silent: true }).catch(() => {});
    renderOverlay();
    queueTabSessionSave();
  }, VSCODE_SYNC_POLL_INTERVAL_MS);
}

// Listeners de la linea «Tu VS Code» (antes dentro de ensureOverlay, en el mismo orden).
function bindVscodeSyncPanel() {
  overlayEls.vscodeSyncRefreshBtn?.addEventListener("click", async () => {
    if (typeof refreshVscodeSyncState !== "function") return;
    await refreshVscodeSyncState({ silent: false });
  });
  overlayEls.vscodeCopySessionBtn?.addEventListener("click", async () => {
    await copyEditorPairingCodeForVscode();
  });
}
