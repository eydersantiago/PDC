"use strict";

function buildOverlayGuideItemTemplate(text) {
  const li = document.createElement("li");
  li.textContent = toText(text);
  return li;
}
