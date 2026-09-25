// ADACEEN | Pagina de inicio /empezar del backend (docs/arquitectura/acceso-simplificado.md, 4 y 6).
// Content script propio (segunda entrada de content_scripts en manifest.json): no carga ni
// comparte scope con el overlay. Solo avisa a la pagina que la extension esta instalada y su
// version; la pagina lo lee de data-adaceen-extension o del mensaje "adaceen:extension".
"use strict";

(function announceAdaceenExtension() {
  let version = "";
  try {
    version = String(chrome.runtime.getManifest().version || "");
  } catch {
    version = "";
  }
  if (!version) return;
  document.documentElement.dataset.adaceenExtension = version;
  // Solo a la misma pagina (location.origin), nunca a "*".
  window.postMessage({ type: "adaceen:extension", version }, location.origin);
})();
