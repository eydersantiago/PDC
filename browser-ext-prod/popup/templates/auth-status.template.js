"use strict";

function applyPopupStatusClass(statusEl, message, kind = "") {
  statusEl.textContent = message;
  statusEl.className = "status";
  if (kind) statusEl.classList.add(kind);
}
