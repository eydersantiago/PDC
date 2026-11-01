// Dibujos de las pantallas de la primera vez (0.8.4), en el shadow DOM de cada aviso: hueco del dibujo,
// dibujo ampliado, su CSS y bindGuideFigures. Movido sin cambios de guide-illustrations.js (los dibujos).

// ---- Dibujo del paso y dibujo ampliado (en el shadow DOM de cada aviso) ----

// Hueco del dibujo: un boton con el SVG (un clic lo amplia) y su pie. Ids fijos: cada aviso
// tiene su propio shadow root.
function guideFigureSlotMarkup() {
  return `<figure class="guide-figure" id="adaceenGuideFigure" hidden>`
    + `<button type="button" class="guide-figure-open" id="adaceenGuideFigureOpen" aria-label="Ampliar el dibujo"></button>`
    + `<figcaption class="guide-figure-caption" id="adaceenGuideFigureCaption"></figcaption>`
    + `</figure>`;
}

// Dibujo ampliado. Va al nivel del shadow root, fuera del aviso: un aviso centrado con transform
// haria que position: fixed se mida desde el aviso y no desde la ventana.
function guideLightboxMarkup() {
  return `<div class="guide-lightbox" id="adaceenGuideLightbox" hidden>`
    + `<div class="guide-lightbox-backdrop" id="adaceenGuideLightboxBackdrop"></div>`
    + `<div class="guide-lightbox-panel" id="adaceenGuideLightboxPanel" role="dialog" aria-modal="true" aria-labelledby="adaceenGuideLightboxTitle">`
    + `<div class="guide-lightbox-head"><strong id="adaceenGuideLightboxTitle"></strong>`
    + `<button type="button" class="guide-lightbox-close" id="adaceenGuideLightboxClose">Cerrar</button></div>`
    + `<div class="guide-lightbox-art" id="adaceenGuideLightboxArt"></div>`
    + `<p class="guide-lightbox-caption" id="adaceenGuideLightboxCaption"></p>`
    + `</div></div>`;
}

const GUIDE_FIGURES_CSS = `
      .guide-figure { margin: 0; display: grid; gap: 4px; width: 232px; max-width: 100%; justify-self: end; }
      .guide-figure[hidden] { display: none; }
      .guide-figure-open { display: block; width: 100%; padding: 0; border: 1px solid rgba(224, 248, 250, 0.35);
        border-radius: 8px; background: #0b1a24; cursor: zoom-in; overflow: hidden; line-height: 0; }
      .guide-figure-open:hover { border-color: #76efe5; }
      .guide-figure-open:focus-visible { outline: 3px solid #ffd08a; outline-offset: 2px; }
      .guide-art { display: block; width: 100%; height: auto; }
      .guide-figure-caption { margin: 0; color: #b9d7df; font-size: 12px; line-height: 1.35; }
      .guide-figure-caption::after { content: " · Clic para ampliar"; color: #76efe5; }
      .guide-lightbox { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center;
        padding: 12px; box-sizing: border-box; font: 14px/1.45 "Segoe UI", Arial, sans-serif; }
      .guide-lightbox[hidden] { display: none; }
      .guide-lightbox-backdrop { position: absolute; inset: 0; background: rgba(3, 10, 15, 0.72); }
      .guide-lightbox-panel { position: relative; box-sizing: border-box; width: min(760px, 94vw); max-height: 94vh;
        overflow: auto; overscroll-behavior: contain; display: grid; gap: 10px; padding: 14px 16px 16px; border-radius: 12px;
        background: #06131b; color: #f8fbff; border: 1px solid rgba(118, 239, 229, 0.65); box-shadow: 0 18px 48px rgba(0, 0, 0, 0.55); }
      .guide-lightbox-head { position: sticky; top: -14px; display: flex; align-items: center; justify-content: space-between; gap: 12px;
        margin: -14px -16px 0; padding: 12px 16px; background: #06131b; }
      .guide-lightbox-head strong { font-size: 15px; }
      .guide-lightbox-close { flex: none; font: inherit; font-weight: 700; border: 0; border-radius: 8px; padding: 7px 12px;
        background: #dffffb; color: #07353b; cursor: pointer; }
      .guide-lightbox-close:focus-visible { outline: 3px solid #ffd08a; outline-offset: 2px; }
      .guide-lightbox-art .guide-art { max-height: calc(88vh - 110px); width: 100%; }
      .guide-lightbox-caption { margin: 0; color: #d9eaf0; }`;

/**
 * Conecta el hueco del dibujo y el dibujo ampliado de un aviso (guideFigureSlotMarkup,
 * guideLightboxMarkup y GUIDE_FIGURES_CSS). Devuelve:
 *   show(key)  pone en el hueco el dibujo `key` ("" lo oculta); true si quedo visible
 *   open(key)  lo amplia (sin `key`, el del hueco); true si se abrio
 *   close()    cierra el ampliado y devuelve el foco al dibujo
 * Un clic en el dibujo lo amplia; «Cerrar», el fondo o Escape lo cierran. Sin el markup lo dice
 * en la consola y no hace nada; una clave desconocida tambien se avisa.
 */
function bindGuideFigures(root) {
  const figure = root?.getElementById?.("adaceenGuideFigure");
  const openButton = root?.getElementById?.("adaceenGuideFigureOpen");
  const caption = root?.getElementById?.("adaceenGuideFigureCaption");
  const lightbox = root?.getElementById?.("adaceenGuideLightbox");
  const closeButton = root?.getElementById?.("adaceenGuideLightboxClose");
  if (!figure || !openButton || !lightbox) {
    console.warn("[ADACEEN] Aviso sin hueco de dibujo: faltan guideFigureSlotMarkup() o guideLightboxMarkup().");
    return { show: () => false, open: () => false, close() {} };
  }
  const known = (key) => {
    if (hasGuideFigure(key)) return true;
    if (key) console.warn(`[ADACEEN] Dibujo de la guia desconocido: ${key}`);
    return false;
  };
  const show = (key) => {
    if (!known(key)) {
      figure.hidden = true;
      figure.setAttribute?.("data-figure", "");
      return false;
    }
    const spec = GUIDE_FIGURES[key];
    if (figure.getAttribute?.("data-figure") !== key) {
      openButton.innerHTML = guideFigureSvg(key, { decorative: true });
      figure.setAttribute?.("data-figure", key);
    }
    openButton.setAttribute?.("aria-label", `Ampliar el dibujo: ${spec.title}`);
    if (caption) caption.textContent = spec.caption;
    figure.hidden = false;
    return true;
  };
  const close = () => {
    if (lightbox.hidden) return;
    lightbox.hidden = true;
    openButton.focus?.();
  };
  const open = (key = figure.getAttribute?.("data-figure")) => {
    if (!known(key)) return false;
    const spec = GUIDE_FIGURES[key];
    const art = root.getElementById("adaceenGuideLightboxArt");
    const title = root.getElementById("adaceenGuideLightboxTitle");
    const lightboxCaption = root.getElementById("adaceenGuideLightboxCaption");
    if (art) art.innerHTML = guideFigureSvg(key);
    if (title) title.textContent = spec.title;
    if (lightboxCaption) lightboxCaption.textContent = spec.caption;
    lightbox.hidden = false;
    closeButton?.focus?.();
    return true;
  };
  // Estado inicial explicito (no depender del atributo hidden del markup).
  lightbox.hidden = true;
  openButton.addEventListener("click", () => open());
  closeButton?.addEventListener("click", close);
  root.getElementById("adaceenGuideLightboxBackdrop")?.addEventListener("click", close);
  lightbox.addEventListener("keydown", (event) => {
    if (event?.key === "Escape") {
      event.stopPropagation?.();
      close();
    }
  });
  return { show, open, close };
}
