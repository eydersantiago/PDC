// ADACEEN | Capa 4 - UI: la ventana del overlay: posicion dentro del viewport, arrastre, minimizar a la
// pestana lateral, fijar entre paginas y botones de la cabecera (cerrar, minimizar).
// Movido sin cambios desde content-lifecycle.js y content-render.js (startDrag); los listeners de la
// ventana estan en bindWindowControls, llamada desde ensureOverlay.
// Sin "use strict": el codigo viene de archivos en modo no estricto y se conserva igual.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

let overlayViewportSyncFrame = 0;

let overlayViewportListenersBound = false;

// ---- Posicion del overlay dentro del viewport ----

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getViewportMetrics() {
  const viewport = window.visualViewport;
  return {
    width: viewport?.width || window.innerWidth || document.documentElement.clientWidth || 0,
    height: viewport?.height || window.innerHeight || document.documentElement.clientHeight || 0,
    offsetLeft: viewport?.offsetLeft || 0,
    offsetTop: viewport?.offsetTop || 0,
  };
}

function getOverlayViewportBounds() {
  const { width, height, offsetLeft, offsetTop } = getViewportMetrics();
  const rect = overlayHost?.getBoundingClientRect() || { width: 0, height: 0 };
  const minLeft = offsetLeft + OVERLAY_MARGIN;
  const minTop = offsetTop + OVERLAY_MARGIN;
  const maxLeft = Math.max(minLeft, offsetLeft + width - rect.width - OVERLAY_MARGIN);
  const maxTop = Math.max(minTop, offsetTop + height - rect.height - OVERLAY_MARGIN);

  return { minLeft, minTop, maxLeft, maxTop };
}

function placeOverlay(left, top) {
  if (!overlayHost) return;
  overlayHost.style.left = `${Math.round(left)}px`;
  overlayHost.style.top = `${Math.round(top)}px`;
  overlayHost.style.right = "auto";
  overlayHost.style.bottom = "auto";
}

function syncOverlayToViewport(preferCurrentPosition = true) {
  if (!overlayHost) return;

  const rect = overlayHost.getBoundingClientRect();
  const bounds = getOverlayViewportBounds();
  const defaultLeft = bounds.maxLeft;
  const defaultTop = bounds.minTop;
  const nextLeft = clamp(preferCurrentPosition ? rect.left : defaultLeft, bounds.minLeft, bounds.maxLeft);
  const nextTop = clamp(preferCurrentPosition ? rect.top : defaultTop, bounds.minTop, bounds.maxTop);

  placeOverlay(nextLeft, nextTop);
}

function scheduleOverlayViewportSync(preferCurrentPosition = true) {
  if (overlayViewportSyncFrame) {
    window.cancelAnimationFrame(overlayViewportSyncFrame);
  }

  overlayViewportSyncFrame = window.requestAnimationFrame(() => {
    overlayViewportSyncFrame = 0;
    syncOverlayToViewport(preferCurrentPosition);
  });
}

function bindOverlayViewportListeners() {
  if (overlayViewportListenersBound) return;

  const handleViewportChange = () => {
    scheduleOverlayViewportSync(true);
    syncVscodeSyncOverlayToViewport();
  };

  window.addEventListener("resize", handleViewportChange);
  window.visualViewport?.addEventListener("resize", handleViewportChange);
  window.visualViewport?.addEventListener("scroll", handleViewportChange);
  overlayViewportListenersBound = true;
}

const MINIMIZED_TAB_DRAG_THRESHOLD_PX = 6;

let suppressNextMinimizedTabClick = false;

function startMinimizedTabDrag(event) {
  if (!overlayHost || event.button !== 0 || overlayState.minimized !== true) return;

  const target = event.currentTarget;
  const rect = overlayHost.getBoundingClientRect();
  const startX = event.clientX;
  const startY = event.clientY;
  let dragging = false;

  function onMove(moveEvent) {
    const deltaX = moveEvent.clientX - startX;
    const deltaY = moveEvent.clientY - startY;
    if (!dragging && Math.hypot(deltaX, deltaY) < MINIMIZED_TAB_DRAG_THRESHOLD_PX) {
      return;
    }

    dragging = true;
    suppressNextMinimizedTabClick = true;
    target?.classList?.add("is-dragging");
    moveEvent.preventDefault();

    const bounds = getOverlayViewportBounds();
    const nextLeft = clamp(rect.left + deltaX, bounds.minLeft, bounds.maxLeft);
    const nextTop = clamp(rect.top + deltaY, bounds.minTop, bounds.maxTop);
    placeOverlay(nextLeft, nextTop);
  }

  function onUp() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    target?.classList?.remove("is-dragging");
    try {
      target?.releasePointerCapture?.(event.pointerId);
    } catch {}

    if (dragging) {
      window.setTimeout(() => {
        suppressNextMinimizedTabClick = false;
      }, 250);
    }
  }

  try {
    target?.setPointerCapture?.(event.pointerId);
  } catch {}
  window.addEventListener("pointermove", onMove, { passive: false });
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

function getFloatingOverlayViewportBounds(element) {
  const { width, height, offsetLeft, offsetTop } = getViewportMetrics();
  const rect = element?.getBoundingClientRect?.() || { width: 0, height: 0 };
  const minLeft = offsetLeft + OVERLAY_MARGIN;
  const minTop = offsetTop + OVERLAY_MARGIN;
  const maxLeft = Math.max(minLeft, offsetLeft + width - rect.width - OVERLAY_MARGIN);
  const maxTop = Math.max(minTop, offsetTop + height - rect.height - OVERLAY_MARGIN);
  return { minLeft, minTop, maxLeft, maxTop };
}

function placeFloatingOverlay(element, left, top) {
  if (!element) return;
  const bounds = getFloatingOverlayViewportBounds(element);
  element.style.left = `${Math.round(clamp(left, bounds.minLeft, bounds.maxLeft))}px`;
  element.style.top = `${Math.round(clamp(top, bounds.minTop, bounds.maxTop))}px`;
}

async function syncOverlayPinnedState(nextPinnedValue) {
  const shouldBeOpen = nextPinnedValue === true;
  const isOpen = !!(overlayHost?.isConnected && overlayRoot);

  if (shouldBeOpen && !isOpen) {
    await openOverlay({ trigger: "sync" });
    return true;
  }

  if (!shouldBeOpen && isOpen) {
    await closeOverlay({ reason: "sync" });
    return true;
  }

  return false;
}

async function persistOverlayMinimizedPreference() {
  if (!isExtensionRuntimeReady()) return;
  try {
    await chrome.storage.local.set({
      [STORAGE_KEY_OVERLAY_MINIMIZED]: overlayState.minimized === true,
    });
  } catch {}
}

async function setOverlayMinimized(nextMinimized, options = {}) {
  const minimized = nextMinimized === true;
  if (overlayState.minimized === minimized && options.force !== true) {
    return;
  }

  overlayState.minimized = minimized;
  if (minimized) {
    overlayState.settingsOpen = false;
  }

  if (options.persist !== false) {
    await persistOverlayMinimizedPreference();
  }

  if (overlayHost?.isConnected) {
    renderOverlay();
    scheduleOverlayViewportSync(true);
  }
  queueTabSessionSave();
}

async function restorePinnedOverlay() {
  try {
    await loadPreferences();
    const stored = await chrome.storage.local.get([STORAGE_KEY_OVERLAY_PINNED]);
    if (stored[STORAGE_KEY_OVERLAY_PINNED] === true) {
      await openOverlay({ trigger: "restore" });
    }
  } catch {}
}

function startDrag(event) {
  if (!overlayHost || event.button !== 0) return;
  if (event.target.closest("button") || event.target.closest("input") || event.target.closest("select") || event.target.closest("textarea")) {
    return;
  }

  event.preventDefault();
  const rect = overlayHost.getBoundingClientRect();
  const startX = event.clientX;
  const startY = event.clientY;

  function onMove(moveEvent) {
    const deltaX = moveEvent.clientX - startX;
    const deltaY = moveEvent.clientY - startY;
    const bounds = getOverlayViewportBounds();
    const nextLeft = clamp(rect.left + deltaX, bounds.minLeft, bounds.maxLeft);
    const nextTop = clamp(rect.top + deltaY, bounds.minTop, bounds.maxTop);
    placeOverlay(nextLeft, nextTop);
  }

  function onUp() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

// Listeners de la ventana: cerrar, minimizar, pestana lateral y arrastre (antes dentro de ensureOverlay, en el mismo orden).
function bindWindowControls() {
  overlayEls.closeBtn.addEventListener("click", async () => {
    await closeOverlay({ reason: "user" });
  });
  overlayEls.minimizeBtn.addEventListener("click", async () => {
    await setOverlayMinimized(true);
    focusOverlayElement(overlayEls?.minimizedTabBtn);
  });
  overlayEls.minimizedTabBtn.addEventListener("pointerdown", startMinimizedTabDrag);
  overlayEls.minimizedTabBtn.addEventListener("click", async (event) => {
    if (suppressNextMinimizedTabClick) {
      event.preventDefault();
      event.stopPropagation();
      suppressNextMinimizedTabClick = false;
      return;
    }
    await setOverlayMinimized(false);
    focusOverlayElement(overlayEls?.window);
  });
  overlayEls.dragHandle.addEventListener("pointerdown", startDrag);
}
