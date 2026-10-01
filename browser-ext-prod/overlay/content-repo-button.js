// ADACEEN | Capa 5 - Ciclo de vida: boton «Abrir en mi editor» en la pagina del repositorio de
// GitHub (0.7.20).
//
// Con el editor en la nube (proveedor "tunnel"), el estudiante abre el repositorio que tiene
// delante con un clic, sin abrir el overlay: el backend lo clona en su propia carpeta del mismo
// tunel (el segundo repositorio no pide otro codigo) y la ventana de espera abre
// vscode.dev/tunnel/<nombre>/home/ws-<login>/<carpeta>. Es el mismo flujo que «Abrir mi editor»
// del overlay (openMyTunnelEditor), con el repositorio de la URL.
//
// Donde va: en la cabecera del repositorio, junto a Watch/Fork/Star (ul.pagehead-actions). Si
// GitHub cambia su cabecera, el boton queda flotando arriba a la derecha. Vive en una shadow
// root cerrada: la pagina no lo toca ni lo estiliza. Solo para estudiantes con sesion: el
// docente y el administrador no tienen un editor propio, y sin sesion no se consulta el backend
// en cada pagina de GitHub.
//
// GitHub navega sin recargar (Turbo): el boton se revisa con sus eventos, popstate y un
// MutationObserver que solo compara la URL y si el boton sigue en la pagina.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const REPO_EDITOR_BUTTON_HOST_ID = "adaceen-repo-editor-button";
const REPO_EDITOR_BUTTON_SYNC_MS = 250;
const REPO_EDITOR_BUTTON_LABEL = "Abrir en mi editor";

let repoEditorButtonHost = null;
let repoEditorButtonEls = null;
let repoEditorButtonSlot = "";
let repoEditorButtonRepo = "";
// Repositorio del ultimo clic: un fallo solo se muestra en el boton de ese repositorio.
let repoEditorButtonClickedRepo = "";
let repoEditorButtonSyncTimer = 0;
let repoEditorButtonLastHref = "";
let repoEditorButtonWatching = false;

// owner/repo de una pagina de repositorio de github.com; "" en login, ajustes, la portada...
function repoFromGithubPageUrl(value = location.href) {
  try {
    const url = new URL(toText(value));
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return "";
    if (isGithubFlowPageUrl(url.href)) return "";
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return "";
    return parseRepoFullName(`${parts[0]}/${parts[1]}`);
  } catch {
    return "";
  }
}

function shouldShowRepoEditorButton(repoFullName) {
  if (!repoFullName || !hasActiveSession()) return false;
  if (isTeacherSession() || isAdminSession()) return false;
  return typeof isTunnelProvider === "function" && isTunnelProvider();
}

// Rotulo, ayuda y estado del boton para <repo>.
function describeRepoEditorButton(repoFullName) {
  if (overlayState.githubAppBusy) {
    return {
      label: "Preparando tu editor...",
      title: "ADACEEN esta preparando tu editor; la ventana de espera lo abrira sola.",
      disabled: true,
      state: "busy",
    };
  }
  const saved = typeof getSavedTunnelEditor === "function" ? getSavedTunnelEditor(repoFullName) : null;
  const anyEditor = typeof getLatestSavedTunnelEditor === "function" ? getLatestSavedTunnelEditor() : null;
  const title = saved
    ? `Abre ${repoFullName} en tu editor en la nube (VS Code).`
    : anyEditor
      ? `Agrega ${repoFullName} a tu editor en la nube y lo abre. No te pide otro codigo.`
      : `Prepara tu editor en la nube con ${repoFullName} y lo abre. La primera vez GitHub te pide un codigo de un solo uso.`;
  const failed = toText(overlayState.operationKind) === "error" && toText(overlayState.operationTitle)
    && repoEditorButtonClickedRepo.toLowerCase() === toText(repoFullName).toLowerCase();
  return {
    label: REPO_EDITOR_BUTTON_LABEL,
    title: failed ? `${toText(overlayState.operationTitle)}. ${toText(overlayState.operationDetail)}`.trim() : title,
    disabled: false,
    state: failed ? "error" : "idle",
  };
}

// La cabecera del repositorio (Watch/Fork/Star) o, si GitHub la cambio o la oculta (ventana
// angosta: la lista es d-none por debajo de md), flotando.
function findRepoEditorButtonSlot() {
  const actions = document.querySelector("#repository-container-header ul.pagehead-actions")
    || document.querySelector("ul.pagehead-actions");
  const visible = actions && typeof actions.getClientRects === "function" && actions.getClientRects().length > 0;
  return visible ? { kind: "header", parent: actions } : { kind: "floating", parent: document.documentElement };
}

function buildRepoEditorButtonMarkup(kind) {
  // En la cabecera, el <li> toma el estilo de GitHub (.pagehead-actions > li: float y margen).
  const hostCss = kind === "header"
    ? ":host { all: initial; display: inline-flex; align-items: center; vertical-align: middle; }"
    : ":host { all: initial; position: fixed; top: 72px; right: 16px; z-index: 2147483000; }";
  // Markup fijo; los textos entran con textContent.
  return `
    <style>
      ${hostCss}
      .btn { display: inline-flex; align-items: center; gap: 6px; box-sizing: border-box; min-height: 28px;
        padding: 3px 12px; border-radius: 6px; border: 1px solid rgba(31, 35, 40, 0.15); cursor: pointer;
        background: #1f883d; color: #ffffff; font: 600 12px/20px -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
        white-space: nowrap; box-shadow: 0 1px 0 rgba(31, 35, 40, 0.1); }
      .btn:hover:not([disabled]) { background: #1a7f37; }
      .btn:focus-visible { outline: 2px solid #0969da; outline-offset: 2px; }
      .btn[disabled] { cursor: progress; opacity: 0.75; }
      .btn[data-state="error"] { background: #cf222e; }
      .btn svg { width: 16px; height: 16px; fill: currentColor; flex: none; }
      .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    </style>
    <button class="btn" id="adaceenRepoEditorBtn" type="button" data-state="idle">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25Zm1.75-.25a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25Zm2.03 3.22 2.5 2.5a.75.75 0 0 1 0 1.06l-2.5 2.5a.749.749 0 1 1-1.06-1.06L4.69 8.75 2.72 6.78a.749.749 0 0 1 1.06-1.06ZM7.75 10.5h3.5a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1 0-1.5Z"></path></svg>
      <span id="adaceenRepoEditorLabel">${REPO_EDITOR_BUTTON_LABEL}</span>
    </button>
    <span class="sr" id="adaceenRepoEditorStatus" role="status" aria-live="polite"></span>`;
}

function removeRepoEditorButton() {
  if (repoEditorButtonHost?.isConnected) repoEditorButtonHost.remove();
  repoEditorButtonHost = null;
  repoEditorButtonEls = null;
  repoEditorButtonSlot = "";
}

function mountRepoEditorButton() {
  const slot = findRepoEditorButtonSlot();
  if (repoEditorButtonHost?.isConnected && repoEditorButtonSlot === slot.kind) return repoEditorButtonEls;
  removeRepoEditorButton();
  document.getElementById(REPO_EDITOR_BUTTON_HOST_ID)?.remove();
  // Un <li> no admite shadow root (attachShadow lanza NotSupportedError): en la cabecera el
  // <li> lleva dentro un <span> que la tiene.
  const host = document.createElement(slot.kind === "header" ? "li" : "div");
  host.id = REPO_EDITOR_BUTTON_HOST_ID;
  const shadowHost = slot.kind === "header" ? host.appendChild(document.createElement("span")) : host;
  const root = shadowHost.attachShadow({ mode: "closed" });
  root.innerHTML = buildRepoEditorButtonMarkup(slot.kind);
  const els = {
    button: root.getElementById("adaceenRepoEditorBtn"),
    label: root.getElementById("adaceenRepoEditorLabel"),
    status: root.getElementById("adaceenRepoEditorStatus"),
  };
  els.button?.addEventListener("click", () => {
    onRepoEditorButtonClick().catch(() => {});
  });
  if (slot.kind === "header") slot.parent.insertBefore(host, slot.parent.firstChild);
  else slot.parent.appendChild(host);
  repoEditorButtonHost = host;
  repoEditorButtonEls = els;
  repoEditorButtonSlot = slot.kind;
  return els;
}

function paintRepoEditorButton(repoFullName) {
  const els = mountRepoEditorButton();
  if (!els?.button) return;
  const view = describeRepoEditorButton(repoFullName);
  if (els.label && els.label.textContent !== view.label) els.label.textContent = view.label;
  els.button.disabled = view.disabled;
  els.button.title = view.title;
  els.button.setAttribute("aria-label", `${view.label}: ${repoFullName}`);
  if (els.button.dataset) els.button.dataset.state = view.state;
  const announce = view.state === "busy" ? view.title : view.state === "error" ? view.title : "";
  if (els.status && els.status.textContent !== announce) els.status.textContent = announce;
}

// Con sesion de estudiante y el tunel activo, en la pagina de un repositorio: el boton.
async function syncRepoEditorButton() {
  repoEditorButtonLastHref = location.href;
  const repoFullName = repoFromGithubPageUrl();
  repoEditorButtonRepo = repoFullName;
  if (repoFullName && hasActiveSession() && !isTeacherSession() && !isAdminSession()
    && typeof refreshWorkspaceProvider === "function") {
    // Cacheado 5 min (workspace.service.js): navegar entre repositorios no consulta cada vez.
    await refreshWorkspaceProvider().catch(() => "");
  }
  // Mientras tanto GitHub pudo navegar a otra pagina: manda la URL de ahora.
  if (repoFromGithubPageUrl() !== repoFullName) return syncRepoEditorButton();
  if (!shouldShowRepoEditorButton(repoFullName)) {
    removeRepoEditorButton();
    return false;
  }
  paintRepoEditorButton(repoFullName);
  return true;
}

function syncRepoEditorButtonSoon() {
  if (repoEditorButtonSyncTimer || !repoEditorButtonWatching) return;
  repoEditorButtonSyncTimer = window.setTimeout(() => {
    repoEditorButtonSyncTimer = 0;
    syncRepoEditorButton().catch(() => false);
  }, REPO_EDITOR_BUTTON_SYNC_MS);
}

async function onRepoEditorButtonClick() {
  const repoFullName = repoEditorButtonRepo || repoFromGithubPageUrl();
  if (!repoFullName || overlayState.githubAppBusy) return false;
  if (!hasActiveSession()) {
    // La sesion se cerro en otra pestana: el overlay pide entrar.
    await openOverlay({ trigger: "user" }).catch(() => {});
    return false;
  }
  // El overlay puede estar cerrado: el contexto es esta pagina. La ventana de espera se abre
  // dentro de openMyTunnelEditor antes de su primer await (mismo clic: sin bloqueo de popups).
  if (!overlayHost?.isConnected) overlayState.context = buildPayload();
  repoEditorButtonClickedRepo = repoFullName;
  const opening = openMyTunnelEditor({ repoFullName });
  paintRepoEditorButton(repoFullName);
  try {
    return await opening;
  } finally {
    syncRepoEditorButtonSoon();
  }
}

function watchRepoEditorButton() {
  if (repoEditorButtonWatching) return;
  repoEditorButtonWatching = true;
  const soon = () => syncRepoEditorButtonSoon();
  for (const type of ["turbo:load", "turbo:render", "pjax:end", "visibilitychange"]) {
    document.addEventListener(type, soon);
  }
  window.addEventListener("popstate", soon);
  // La cabecera se oculta o aparece al cambiar el ancho de la ventana.
  window.addEventListener("resize", soon);
  if (typeof MutationObserver === "function") {
    // GitHub cambia el DOM a menudo: el callback solo compara la URL y si el boton sigue puesto.
    const observer = new MutationObserver(() => {
      if (location.href !== repoEditorButtonLastHref || (repoEditorButtonHost && !repoEditorButtonHost.isConnected)) soon();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  // Entrar o salir en otra pestana, o un editor guardado nuevo.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes) return;
    if ([STORAGE_KEY_SESSION_ID, STORAGE_KEY_ACTIVE_SESSION_SNAPSHOT, STORAGE_KEY_EDITOR_BY_USER]
      .some((key) => Object.prototype.hasOwnProperty.call(changes, key))) soon();
  });
}

// Arranque (content-lifecycle.js): solo en github.com.
async function startRepoEditorButton() {
  if (location.hostname.toLowerCase() !== "github.com") return false;
  watchRepoEditorButton();
  await syncFromStorageSnapshot({ force: true }).catch(() => false);
  return syncRepoEditorButton();
}
