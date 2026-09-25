// ADACEEN | Capa 4 - UI: accesibilidad del overlay (A12.9 ADACEEN-140, WCAG 2.1 AA).
// Foco al abrir/cerrar el overlay y sus capas, Escape, atajo Ctrl+Enter, aislamiento del
// teclado frente a los atajos de la pagina y utilidades de render idempotente (un re-render
// con los mismos datos no destruye el elemento enfocado ni repite anuncios de lectores).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const overlayRenderKeys = new WeakMap();
const overlayAccessibilityBoundRoots = new WeakSet();
const overlayFocusState = {
  returnTarget: null,
  lastFocusedInOverlay: null,
  layerVisibility: {},
  layerOpeners: {},
};

// ---- Render idempotente ----

function setTextIfChanged(element, text) {
  if (!element) return;
  const next = text === null || text === undefined ? "" : String(text);
  if (element.textContent !== next) element.textContent = next;
}

// true si la clave de render cambio (y la guarda). Las claves viven en un WeakMap por
// elemento: al remontar el overlay los elementos nuevos siempre se pintan.
function renderKeyChanged(element, key) {
  if (!element) return false;
  const next = String(key);
  if (overlayRenderKeys.get(element) === next) return false;
  overlayRenderKeys.set(element, next);
  return true;
}

// ---- Foco ----

function getOverlayFocusedElement() {
  if (!overlayRoot || !overlayHost?.isConnected) return null;
  return overlayRoot.activeElement || null;
}

function isFocusInsideOverlay() {
  return !!getOverlayFocusedElement();
}

function isPageFocusIdle() {
  const active = document.activeElement;
  return !active || active === document.body || active === document.documentElement || active === overlayHost;
}

function isOverlayElementFocusable(element) {
  if (!element || !element.isConnected || typeof element.focus !== "function") return false;
  if (element.disabled) return false;
  if (element.closest?.("[hidden]")) return false;
  try {
    if (window.getComputedStyle(element).visibility === "hidden") return false;
  } catch {}
  return element.getClientRects().length > 0;
}

function focusOverlayElement(element) {
  if (!element || typeof element.focus !== "function") return false;
  // preventScroll: los paneles entran con transform dentro de un contenedor overflow:hidden;
  // desplazarlo para "mostrar" el foco descuadraria la animacion.
  try {
    element.focus({ preventScroll: true });
  } catch {
    try {
      element.focus();
    } catch {
      return false;
    }
  }
  return getOverlayFocusedElement() === element;
}

// Guarda el elemento de la pagina que tenia el foco antes de abrir el overlay por accion
// del usuario, para devolverselo al cerrar (WCAG 2.4.3).
function rememberOverlayFocusReturnTarget() {
  const active = document.activeElement;
  overlayFocusState.returnTarget = isPageFocusIdle() ? null : active;
}

function restoreOverlayFocusReturnTarget() {
  const target = overlayFocusState.returnTarget;
  overlayFocusState.returnTarget = null;
  if (!target || !target.isConnected || typeof target.focus !== "function") return false;
  try {
    target.focus({ preventScroll: true });
    return true;
  } catch {
    return false;
  }
}

function forgetOverlayFocusReturnTarget() {
  overlayFocusState.returnTarget = null;
}

function focusOverlayMainSurface() {
  if (!overlayEls) return false;
  const target = overlayState.minimized === true ? overlayEls.minimizedTabBtn : overlayEls.window;
  return focusOverlayElement(target);
}

// Tras abrir por accion del usuario: el foco entra al dialogo (o a la pestana minimizada).
function focusOverlayAfterUserOpen() {
  window.requestAnimationFrame(() => {
    focusOverlayMainSurface();
  });
}

function trackOverlayFocus(event) {
  const target = event?.composedPath?.()[0] || event?.target || null;
  if (target && target !== overlayRoot) {
    overlayFocusState.lastFocusedInOverlay = target;
  }
}

function getOverlayFocusLayers() {
  if (!overlayEls) return [];
  const windowVisible = !overlayEls.window?.hidden;
  const layers = [
    { key: "settings", element: overlayEls.settingsPanel, visible: overlayState.settingsOpen === true },
    { key: "analysis", element: overlayEls.analysisWindow, visible: !overlayEls.analysisWindow?.hidden },
    { key: "teacherBitacora", element: overlayEls.teacherBitacoraPage, visible: !overlayEls.teacherBitacoraPage?.hidden },
    { key: "teacherRag", element: overlayEls.teacherRagPage, visible: !overlayEls.teacherRagPage?.hidden },
    { key: "firstLogin", element: overlayEls.firstLoginModal, visible: !overlayEls.firstLoginModal?.hidden },
    { key: "studentCourse", element: overlayEls.studentCourseModal, visible: !overlayEls.studentCourseModal?.hidden },
    { key: "tabConflict", element: overlayEls.tabConflictModal, visible: !overlayEls.tabConflictModal?.hidden },
  ];
  return layers
    .filter((layer) => !!layer.element)
    .map((layer) => ({ ...layer, visible: windowVisible && layer.visible }));
}

function focusWasInsideLayer(layerElement) {
  const active = getOverlayFocusedElement();
  if (active) return layerElement.contains(active);
  const last = overlayFocusState.lastFocusedInOverlay;
  return isPageFocusIdle() && !!last && layerElement.contains(last);
}

// Se llama al final de renderOverlay. Cuando una capa (configuracion, analisis, paginas del
// docente, modales) aparece y el usuario estaba en el overlay, el foco entra a la capa; cuando
// desaparece con el foco dentro, vuelve al control que la abrio. Nunca roba el foco de la pagina.
function syncOverlayLayerFocus() {
  if (!overlayEls) return;
  const focusInside = isFocusInsideOverlay();
  for (const layer of getOverlayFocusLayers()) {
    const wasVisible = overlayFocusState.layerVisibility[layer.key] === true;
    overlayFocusState.layerVisibility[layer.key] = layer.visible;

    if (layer.visible && !wasVisible) {
      if (!focusInside) continue;
      const opener = overlayFocusState.lastFocusedInOverlay;
      overlayFocusState.layerOpeners[layer.key] = opener && !layer.element.contains(opener) ? opener : null;
      focusOverlayElement(layer.element);
    } else if (!layer.visible && wasVisible) {
      const opener = overlayFocusState.layerOpeners[layer.key];
      overlayFocusState.layerOpeners[layer.key] = null;
      if (!focusWasInsideLayer(layer.element)) continue;
      if (!(isOverlayElementFocusable(opener) && focusOverlayElement(opener))) {
        focusOverlayMainSurface();
      }
    }
  }
}

function resetOverlayFocusState() {
  overlayFocusState.lastFocusedInOverlay = null;
  overlayFocusState.layerVisibility = {};
  overlayFocusState.layerOpeners = {};
}

// ---- Teclado ----

function isOverlayEditableTarget(target) {
  if (!target || target.nodeType !== Node.ELEMENT_NODE) return false;
  if (target.isContentEditable) return true;
  const tag = String(target.tagName || "").toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag !== "input") return false;
  const type = String(target.type || "text").toLowerCase();
  return !["button", "submit", "reset", "checkbox", "radio", "file", "range", "color", "image"].includes(type);
}

// Escape cierra primero la capa abierta (configuracion, analisis, paginas del docente,
// avisos) y, si no hay ninguna, el overlay completo.
function handleOverlayEscapeKey() {
  if (overlayState.settingsOpen) {
    setSettingsOpen(false);
    renderOverlay();
    return true;
  }
  if (overlayState.analysisWindowOpen) {
    overlayState.analysisWindowOpen = false;
    renderOverlay();
    return true;
  }
  if (overlayState.teacherRagPageOpen) {
    closeTeacherRagPage();
    return true;
  }
  if (overlayState.teacherBitacoraPageOpen) {
    closeTeacherBitacoraPage();
    return true;
  }
  if (overlayState.studentCourseModalOpen && overlayEls?.studentCourseLogoutBtn?.dataset.courseModalAction === "cancel") {
    overlayState.studentCourseModalOpen = false;
    renderOverlay();
    return true;
  }
  closeOverlay({ reason: "escape" }).catch(() => {});
  return true;
}

// Ctrl+Enter (Cmd+Enter en macOS) dentro del overlay pide ayuda al tutor: value "shortcut".
function requestTutorFromShortcut() {
  if (!overlayEls || overlayEls.window?.hidden || overlayEls.mainView?.hidden) return false;
  if (overlayState.settingsOpen || overlayState.loading || !overlayState.assistantEnabled) return false;
  if (!hasActiveSession() || overlayEls.refreshBtn?.disabled) return false;
  refreshMentorSession({ trigger: "shortcut", requestedAt: Date.now() }).catch(() => {});
  return true;
}

function handleOverlayKeydown(event) {
  if (!event || event.defaultPrevented) return;
  const target = event.composedPath?.()[0] || event.target;

  if (event.key === "Escape" && !event.isComposing) {
    event.preventDefault();
    event.stopPropagation();
    handleOverlayEscapeKey();
    return;
  }

  if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
    if (requestTutorFromShortcut()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  }

  // Mientras se escribe en el overlay, los atajos de GitHub o VS Code web no deben dispararse.
  if (isOverlayEditableTarget(target)) {
    event.stopPropagation();
  }
}

function stopEditableKeyPropagation(event) {
  const target = event?.composedPath?.()[0] || event?.target;
  if (isOverlayEditableTarget(target)) {
    event.stopPropagation();
  }
}

function bindOverlayAccessibility() {
  if (!overlayRoot || overlayAccessibilityBoundRoots.has(overlayRoot)) return;
  overlayAccessibilityBoundRoots.add(overlayRoot);
  resetOverlayFocusState();
  overlayRoot.addEventListener("keydown", handleOverlayKeydown);
  overlayRoot.addEventListener("keyup", stopEditableKeyPropagation);
  overlayRoot.addEventListener("keypress", stopEditableKeyPropagation);
  overlayRoot.addEventListener("focusin", trackOverlayFocus);
}
