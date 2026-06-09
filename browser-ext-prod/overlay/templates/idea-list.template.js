"use strict";

function buildOverlayIdeaItemTemplate(text) {
  const li = document.createElement("li");
  li.textContent = toText(text);
  return li;
}
