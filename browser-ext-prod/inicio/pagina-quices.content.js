// ADACEEN | Paginas /docente/* del backend: /docente/quices (navegador 0.7.15) y /docente/monitor.
// Content script propio (tercera entrada de content_scripts en manifest.json, match
// /docente/*): no carga ni comparte scope con el overlay, y no depende de la ruta exacta.
// Le pasa a la pagina la sesion guardada por la extension (chrome.storage.local, misma
// clave que state/session.state.js) para que el docente no tenga que iniciar sesion otra
// vez; la pagina la usa como cabecera x-session-id contra su propio origen. Solo se manda
// a esta misma pagina (location.origin), nunca a "*".
"use strict";

(function shareAdaceenSessionWithTeacherPage() {
  const STORAGE_KEY_SESSION_ID = "adaceenSessionId";
  const STORAGE_KEY_SESSION_SNAPSHOT = "adaceenActiveSessionSnapshot";

  function readSessionId() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([STORAGE_KEY_SESSION_ID, STORAGE_KEY_SESSION_SNAPSHOT], (stored) => {
          const direct = String((stored && stored[STORAGE_KEY_SESSION_ID]) || "").trim();
          const snapshot = stored && stored[STORAGE_KEY_SESSION_SNAPSHOT];
          const fromSnapshot = snapshot && typeof snapshot === "object" ? String(snapshot.sessionId || "").trim() : "";
          resolve(direct || fromSnapshot);
        });
      } catch {
        resolve("");
      }
    });
  }

  let sent = false;
  async function send() {
    if (sent) return;
    const sessionId = await readSessionId();
    if (!sessionId) return;
    sent = true;
    document.documentElement.dataset.adaceenExtension = String(chrome.runtime.getManifest().version || "");
    window.postMessage({ type: "adaceen:session", sessionId }, location.origin);
  }

  // La pagina pide la sesion al cargar (adaceen:session-request); por si el script llega
  // despues, tambien se manda una vez sin esperar.
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || !event.data || event.data.type !== "adaceen:session-request") return;
    void send();
  });
  void send();
})();
