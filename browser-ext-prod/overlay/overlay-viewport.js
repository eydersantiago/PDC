// ADACEEN | Capa 5 - Ciclo de vida: posicion del overlay y de los paneles flotantes dentro del viewport (incluye arrastre).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

let overlayViewportSyncFrame = 0;
let overlayViewportListenersBound = false;

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
const VSCODE_SYNC_CURSOR_OFFSET_PX = 18;
let suppressNextMinimizedTabClick = false;
let vscodeSyncOverlayUserPlaced = false;
let lastPointerPosition = null;

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

function resetVscodeSyncOverlayPlacement() {
  vscodeSyncOverlayUserPlaced = false;
}

function syncVscodeSyncOverlayToViewport() {
  const element = overlayEls?.vscodeSyncSection;
  if (!element || element.hidden) return;
  if (vscodeSyncOverlayUserPlaced) {
    const rect = element.getBoundingClientRect();
    placeFloatingOverlay(element, rect.left, rect.top);
    return;
  }
  positionVscodeSyncOverlay();
}

function positionVscodeSyncOverlay(options = {}) {
  const element = overlayEls?.vscodeSyncSection;
  if (!element || element.hidden) return;
  if (vscodeSyncOverlayUserPlaced && options.force !== true) return;

  const { width, height, offsetLeft, offsetTop } = getViewportMetrics();
  const fallbackPoint = {
    x: offsetLeft + width - 560,
    y: offsetTop + 110,
  };
  const point = lastPointerPosition || fallbackPoint;
  const rect = element.getBoundingClientRect();
  const gap = VSCODE_SYNC_CURSOR_OFFSET_PX;
  let left = point.x + gap;
  let top = point.y + gap;

  if (left + rect.width > offsetLeft + width - OVERLAY_MARGIN) {
    left = point.x - rect.width - gap;
  }
  if (top + rect.height > offsetTop + height - OVERLAY_MARGIN) {
    top = point.y - rect.height - gap;
  }

  placeFloatingOverlay(element, left, top);
}

function startVscodeSyncOverlayDrag(event) {
  const target = event.currentTarget;
  const element = overlayEls?.vscodeSyncSection;
  if (!element || element.hidden || event.button !== 0) return;
  if (event.target?.closest?.("button,input,select,textarea,a")) return;

  event.preventDefault();
  const rect = element.getBoundingClientRect();
  const startX = event.clientX;
  const startY = event.clientY;
  element.classList.add("is-dragging");

  function onMove(moveEvent) {
    moveEvent.preventDefault();
    vscodeSyncOverlayUserPlaced = true;
    placeFloatingOverlay(element, rect.left + moveEvent.clientX - startX, rect.top + moveEvent.clientY - startY);
  }

  function onUp() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    element.classList.remove("is-dragging");
    try {
      target?.releasePointerCapture?.(event.pointerId);
    } catch {}
  }

  try {
    target?.setPointerCapture?.(event.pointerId);
  } catch {}
  window.addEventListener("pointermove", onMove, { passive: false });
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}
