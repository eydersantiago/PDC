"use strict";

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ADACEEN_PING" });
    return;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  try {
    await ensureContentScript(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: "ADACEEN_OPEN_OVERLAY" });
  } catch (error) {
    console.warn("[ADACEEN] No se pudo abrir el overlay en esta pagina.", error);
  }
});
