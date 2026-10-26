// Piezas comunes de las guias de la primera vez (0.8.4). Las usan el aviso del codigo en GitHub
// (paso 3, workspace.service.js) y el de la entrada a VS Code (paso 4, tunnel-entry-guide.service.js);
// carga antes que los dos, que dependen de aqui y no uno del otro.
//   - Que hay en pantalla: texto y visibilidad de un nodo, sus botones y el boton verde de GitHub.
//   - El anillo sobre el boton real (bindGuidePointer) y el vigilante que lo sigue (watchGuideScreen).
//   - El plegado del aviso en su pastilla: a mano o solo, si desplegado taparia lo que hay que
//     pulsar (createGuideFoldController, wireGuideFold).
// Sin "use strict", como el resto de los content scripts.

// Cada cuanto se mira que hay en pantalla (dialogo de VS Code, archivos, boton de GitHub).
const GUIDE_WATCH_MS = 800;
// Ventanas mas bajas o angostas que esto: el aviso del editor empieza plegado.
const GUIDE_START_COLLAPSED_MAX_HEIGHT = 560;
const GUIDE_START_COLLAPSED_MAX_WIDTH = 480;

// ---- Que hay en pantalla (funciones puras sobre un documento) ----

function guideNodeText(node) {
  const text = toText(node?.textContent) || toText(node?.getAttribute?.("aria-label")) || toText(node?.value);
  return text.replace(/\s+/g, " ").trim();
}

// Visible en la pagina: conectado, con tamano y sin display: none ni visibility: hidden.
function isGuideNodeVisible(node) {
  if (!node || node.hidden || node.isConnected === false) return false;
  try {
    const rect = typeof node.getBoundingClientRect === "function" ? node.getBoundingClientRect() : null;
    if (rect && (!(rect.width > 0) || !(rect.height > 0))) return false;
    const style = typeof getComputedStyle === "function" ? getComputedStyle(node) : null;
    if (style && (style.display === "none" || style.visibility === "hidden")) return false;
  } catch {
    return false;
  }
  return true;
}

function guideButtonsIn(container) {
  const nodes = container?.querySelectorAll?.('.monaco-button, button, [role="button"], input[type="submit"]') || [];
  return Array.from(nodes).filter(isGuideNodeVisible);
}

// Boton verde de GitHub que hay que pulsar: «Continue» (el codigo del editor) o «Authorize …».
function findGithubGuideButton(doc, kind) {
  const pattern = kind === "continue" ? /^continue$/i : /^authorize\b/i;
  const nodes = Array.from(doc?.querySelectorAll?.('button[type="submit"], input[type="submit"], button.btn-primary') || []);
  return nodes.filter(isGuideNodeVisible).find((node) => pattern.test(guideNodeText(node))) || null;
}

function guideRectOf(node) {
  try {
    return node && typeof node.getBoundingClientRect === "function" ? node.getBoundingClientRect() : null;
  } catch {
    return null;
  }
}

// ---- No tapar lo que hay que pulsar ----

function guideRectsOverlap(a, b, margin = 8) {
  if (!a || !b) return false;
  return a.left < b.right + margin && b.left < a.right + margin && a.top < b.bottom + margin && b.top < a.bottom + margin;
}

/** ¿El aviso desplegado taparia el dialogo o el boton? Entonces se pliega solo. */
function shouldAutoCollapseGuide(bannerRect, rects) {
  if (!bannerRect || !(bannerRect.width > 0) || !(bannerRect.height > 0)) return false;
  return (rects || []).some((rect) => rect && rect.width > 0 && rect.height > 0 && guideRectsOverlap(bannerRect, rect));
}

function shouldStartGuideCollapsed() {
  const height = Number(window.innerHeight) || 0;
  const width = Number(window.innerWidth) || 0;
  return (height > 0 && height < GUIDE_START_COLLAPSED_MAX_HEIGHT) || (width > 0 && width < GUIDE_START_COLLAPSED_MAX_WIDTH);
}

/**
 * Plegado de un aviso en su pastilla: a mano (se respeta) o solo, cuando el aviso desplegado
 * taparia lo que hay que pulsar (se deshace solo cuando eso desaparece). Si el estudiante lo
 * despliega con el dialogo encima, ese mismo dialogo no lo vuelve a plegar.
 */
function createGuideFoldController({ box, pill }) {
  let collapsed = false;
  let automatic = false;
  let keepOpenFor = null;
  let lastArea = null;
  const setCollapsed = (value, { automatic: byItself = false } = {}) => {
    collapsed = !!value;
    automatic = collapsed && byItself;
    if (box) box.hidden = collapsed;
    if (pill) pill.hidden = !collapsed;
  };
  return {
    setCollapsed,
    isCollapsed: () => collapsed,
    collapse: () => setCollapsed(true),
    // Desplegar a mano: lo que esta en pantalla ahora ya no lo vuelve a plegar.
    expand: () => {
      keepOpenFor = lastArea;
      setCollapsed(false);
    },
    // En cada vistazo: `avoidArea` (dialogo, lista o boton; sin ella, `target`) y `target` no se tapan.
    avoidCovering({ avoidArea = null, target = null } = {}) {
      const current = avoidArea || target || null;
      if (current !== lastArea) {
        lastArea = current;
        if (!current && automatic) setCollapsed(false);
      }
      if (!current || collapsed || keepOpenFor === current) return;
      if (shouldAutoCollapseGuide(guideRectOf(box), [guideRectOf(current), guideRectOf(target)])) setCollapsed(true, { automatic: true });
    },
  };
}

// El boton de plegar y la pastilla de un aviso, con el foco donde sigue la lectura.
function wireGuideFold(folding, { minimizeButton, pill }) {
  minimizeButton?.addEventListener("click", () => {
    folding.collapse();
    pill?.focus?.();
  });
  pill?.addEventListener("click", () => {
    folding.expand();
    minimizeButton?.focus?.();
  });
}

// ---- Anillo sobre el boton real ----

function guidePointerMarkup() {
  return `<div class="guide-pointer" id="adaceenGuidePointer" hidden></div>`
    + `<div class="guide-pointer-label" id="adaceenGuidePointerLabel" hidden></div>`;
}

const GUIDE_POINTER_CSS = `
      .guide-pointer { position: fixed; z-index: 2147483647; pointer-events: none; box-sizing: border-box;
        border: 3px solid #ffb020; border-radius: 9px; box-shadow: 0 0 0 4px rgba(255, 176, 32, 0.35), 0 0 22px rgba(255, 176, 32, 0.55);
        animation: adaceen-guide-pulse 1.4s ease-in-out infinite; }
      .guide-pointer[hidden], .guide-pointer-label[hidden] { display: none; }
      .guide-pointer-label { position: fixed; z-index: 2147483647; pointer-events: none; box-sizing: border-box; max-width: calc(100vw - 16px);
        padding: 5px 10px; border-radius: 8px; background: #06131b; color: #ffffff; border: 1.5px solid #ffb020;
        font: 700 13px/1.3 "Segoe UI", Arial, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      @keyframes adaceen-guide-pulse { 0%, 100% { box-shadow: 0 0 0 4px rgba(255, 176, 32, 0.35), 0 0 22px rgba(255, 176, 32, 0.55); }
        50% { box-shadow: 0 0 0 8px rgba(255, 176, 32, 0.18), 0 0 30px rgba(255, 176, 32, 0.7); } }
      @media (prefers-reduced-motion: reduce) { .guide-pointer { animation: none; } }`;

/**
 * El anillo y su etiqueta del shadow root de un aviso (guidePointerMarkup y GUIDE_POINTER_CSS).
 * `place(rect, label)` lo pone alrededor de `rect` (coordenadas de la ventana: sirve con zoom y
 * cualquier resolucion) con la etiqueta debajo, o arriba si no cabe, siempre dentro de la ventana.
 * Empieza oculto. Si falta el markup lo dice en la consola y no hace nada.
 */
function bindGuidePointer(root) {
  const ring = root?.getElementById?.("adaceenGuidePointer") || null;
  const tag = root?.getElementById?.("adaceenGuidePointerLabel") || null;
  if (!ring) console.warn("[ADACEEN] Aviso sin anillo de la guia: falta guidePointerMarkup().");
  const hide = () => {
    if (ring) ring.hidden = true;
    if (tag) tag.hidden = true;
  };
  const place = (rect, label = "") => {
    if (!ring || !rect) return;
    const pad = 6;
    ring.style.left = `${Math.round(rect.left - pad)}px`;
    ring.style.top = `${Math.round(rect.top - pad)}px`;
    ring.style.width = `${Math.round(rect.width + pad * 2)}px`;
    ring.style.height = `${Math.round(rect.height + pad * 2)}px`;
    ring.hidden = false;
    if (!tag) return;
    tag.textContent = label;
    tag.hidden = !label;
    if (!label) return;
    const viewportWidth = Number(window.innerWidth) || 1280;
    const viewportHeight = Number(window.innerHeight) || 800;
    const estimatedWidth = Math.min(viewportWidth - 16, label.length * 7.4 + 24);
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - estimatedWidth / 2), Math.max(8, viewportWidth - estimatedWidth - 8));
    const below = rect.bottom + pad + 8;
    const top = below + 30 <= viewportHeight ? below : Math.max(8, rect.top - pad - 38);
    tag.style.left = `${Math.round(left)}px`;
    tag.style.top = `${Math.round(top)}px`;
  };
  hide();
  return { place, hide };
}

/**
 * Mira cada GUIDE_WATCH_MS que hay en pantalla con `locate()` ({ target, label, ... }), pasa el
 * resultado a `onScreen` y marca `target` con `pointer` (bindGuidePointer); mientras haya objetivo,
 * lo sigue en cada cuadro (si el dialogo se mueve o la ventana cambia de tamano). Se detiene solo
 * cuando `isActive()` deja de ser verdad (el aviso salio de la pagina).
 */
function watchGuideScreen({ pointer, isActive, locate, onScreen }) {
  if (typeof locate !== "function") throw new TypeError("watchGuideScreen necesita locate().");
  const active = typeof isActive === "function" ? isActive : () => true;
  let tracked = null;
  let label = "";
  let frame = 0;
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 100);
  const cancelRaf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout;
  const track = () => {
    frame = 0;
    if (!active() || !tracked || !isGuideNodeVisible(tracked)) {
      pointer?.hide();
      return;
    }
    pointer?.place(guideRectOf(tracked), label);
    frame = raf(track);
  };
  const tick = () => {
    if (!active()) {
      stop();
      return;
    }
    if (document.visibilityState === "hidden") return;
    let screen = null;
    try {
      screen = locate();
    } catch {
      screen = null;
    }
    if (typeof onScreen === "function") onScreen(screen || {});
    const target = screen?.target && isGuideNodeVisible(screen.target) ? screen.target : null;
    label = toText(screen?.label);
    if (target !== tracked) {
      tracked = target;
      if (frame) cancelRaf(frame);
      frame = 0;
      if (tracked) track();
      else pointer?.hide();
    }
  };
  const timer = setInterval(tick, GUIDE_WATCH_MS);
  function stop() {
    clearInterval(timer);
    if (frame) cancelRaf(frame);
    frame = 0;
    tracked = null;
    pointer?.hide();
  }
  tick();
  return { stop, tick };
}
