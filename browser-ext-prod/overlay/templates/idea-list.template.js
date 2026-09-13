// ADACEEN | Capa 4 - UI: plantilla de item de idea.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

function buildOverlayIdeaItemTemplate(text) {
  const li = document.createElement("li");
  li.textContent = toText(text);
  return li;
}
