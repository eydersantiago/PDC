// Paso 4 de la primera vez: entrar a VS Code (0.8.0; movido de workspace.service.js en la 0.8.4).
//
// En vscode.dev/tunnel/<nombre>, la primera vez, VS Code pide permiso para iniciar sesion con
// GitHub, abre la pagina de GitHub que autoriza «Visual Studio Code» y pregunta si se confia en
// los autores de la carpeta. El aviso de ADACEEN acompana cada pantalla y, desde la 0.8.4:
//   - muestra el dibujo de la pantalla del paso (guide-illustrations.js), que se amplia con un clic;
//   - mira que dialogo de VS Code esta en pantalla, marca su paso con «Ahora» y pone un anillo
//     alrededor del boton real (el anillo no captura clics);
//   - va abajo a la izquierda y se pliega en una pastilla que sigue diciendo que pulsar: solo,
//     si iba a tapar el dialogo, y al empezar, en ventanas muy bajas;
//   - comprueba que la extension ADACEEN de VS Code este en el editor y sea la ultima
//     (GET /api/vscode/presence?host=tunnel, que el backend llena con las llamadas de VS Code).
// En la pagina de GitHub que autoriza «Visual Studio Code» va el mismo paso 4 (arriba, compacto).

const TUNNEL_SIGNIN_HINT_HOST_ID = "adaceen-tunnel-signin-hint";
// El mismo paso 4 en la pagina de GitHub donde se autoriza «Visual Studio Code» (0.8.0).
const TUNNEL_SIGNIN_GITHUB_HOST_ID = "adaceen-tunnel-signin-github";
// Cada cuanto se mira que hay en pantalla (dialogo de VS Code, archivos, boton de GitHub).
const GUIDE_WATCH_MS = 800;
// Cada cuanto se pregunta al backend por la extension de VS Code del editor.
const TUNNEL_ENTRY_CHECK_POLL_MS = 5000;
const TUNNEL_ENTRY_CHECK_TIMEOUT_MS = 8000;
// Con los archivos a la vista y sin noticias de la extension en este tiempo: «no aparece».
const TUNNEL_ENTRY_MISSING_AFTER_MS = 60000;
// Telemetria del resultado: a lo sumo estas veces por aviso (el primero y si despues cambia).
const TUNNEL_ENTRY_CHECK_EVENTS_MAX = 3;
// Tope de consultas por aviso (5 min): despues queda lo ultimo que se supo.
const TUNNEL_ENTRY_CHECK_MAX_POLLS = 60;
// Ventanas mas bajas o angostas que esto: el aviso empieza plegado.
const GUIDE_START_COLLAPSED_MAX_HEIGHT = 560;
const GUIDE_START_COLLAPSED_MAX_WIDTH = 480;
// Arranque de la VM de editores: baja el VSIX vigente y reinicia los editores abiertos.
const TUNNEL_VM_REFRESH_COMMAND = "gcloud compute ssh adaceen-ws --zone=us-central1-a --tunnel-through-iap --command='sudo google_metadata_script_runner startup'";

// ---- Que hay en pantalla (funciones puras sobre un documento) ----

const VSCODE_ENTRY_PATTERNS = {
  github: /\bgithub\b/i,
  microsoft: /\bmicrosoft\b/i,
  signIn: /(sign[\s-]?in|log[\s-]?in|iniciar (la )?sesi[oó]n|inicie sesi[oó]n)/i,
  allow: /^(allow|permitir)$/i,
  trust: /(trust|conf[ií]a|conf[ií]o|confiar)/i,
  authors: /(author|autor)/i,
  // Sin \b: en JavaScript \b solo ve letras ASCII y «Sí,» no tendria limite despues de la «í».
  trustYes: /^(yes|s[ií])(?=$|[\s,.;:!])/i,
  permitir: /permitir/i,
  spanishTrust: /conf[ií]o/i,
};

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

/**
 * La pantalla de la primera entrada que muestra vscode.dev: «allow» (permiso para iniciar
 * sesion con GitHub), «account» (elegir GitHub o Microsoft), «trust» (confiar en los autores),
 * «files» (ya se ven los archivos) o "". `target` es lo que hay que pulsar y `area`, el
 * dialogo o la lista (para no taparlos).
 */
function detectVscodeEntryScreen(doc = document) {
  const patterns = VSCODE_ENTRY_PATTERNS;
  const dialogs = Array.from(doc?.querySelectorAll?.(".monaco-dialog-box") || []).filter(isGuideNodeVisible);
  for (const dialog of dialogs) {
    const text = guideNodeText(dialog);
    const buttons = guideButtonsIn(dialog);
    if (patterns.trust.test(text) && patterns.authors.test(text)) {
      return { step: "trust", target: buttons.find((button) => patterns.trustYes.test(guideNodeText(button))) || null, area: dialog };
    }
    const githubButton = buttons.find((button) => patterns.github.test(guideNodeText(button)));
    if (githubButton && buttons.some((button) => patterns.microsoft.test(guideNodeText(button)))) {
      return { step: "account", target: githubButton, area: dialog };
    }
    const allowButton = buttons.find((button) => patterns.allow.test(guideNodeText(button)));
    if (allowButton && patterns.github.test(text) && patterns.signIn.test(text)) {
      return { step: "allow", target: allowButton, area: dialog };
    }
  }
  const picker = Array.from(doc?.querySelectorAll?.(".quick-input-widget") || []).find(isGuideNodeVisible);
  if (picker) {
    const rows = Array.from(picker.querySelectorAll?.(".monaco-list-row") || []).filter(isGuideNodeVisible);
    const githubRow = rows.find((row) => patterns.github.test(guideNodeText(row)));
    if (githubRow && rows.some((row) => patterns.microsoft.test(guideNodeText(row)))) {
      return { step: "account", target: githubRow, area: picker };
    }
  }
  const fileRow = doc?.querySelector?.(".explorer-folders-view .monaco-list-row");
  if (isGuideNodeVisible(fileRow)) return { step: "files", target: null, area: null };
  return { step: "", target: null, area: null };
}

// Lo que dice el anillo, con el texto del boton en el idioma de VS Code.
function vscodeEntryPointerLabel(screen) {
  const label = guideNodeText(screen?.target);
  if (screen?.step === "allow") return VSCODE_ENTRY_PATTERNS.permitir.test(label) ? "Pulsa «Permitir»" : "Pulsa «Allow»";
  if (screen?.step === "account") return "Elige «GitHub»";
  if (screen?.step === "trust") return VSCODE_ENTRY_PATTERNS.spanishTrust.test(label) ? "Pulsa «Sí, confío en los autores»" : "Pulsa «Yes, I trust the authors»";
  return "";
}

/** Items de la extension ADACEEN en la barra de estado de VS Code («ADACEEN: <nombre>», «ADACEEN: sin conectar»). */
function readVscodeStatusBarAdaceen(doc = document) {
  const texts = Array.from(doc?.querySelectorAll?.(".statusbar-item") || [])
    .map(guideNodeText)
    .filter((text) => /\bADACEEN\b/i.test(text));
  return { present: texts.length > 0, unconnected: texts.some((text) => /sin conectar/i.test(text)) };
}

// Boton verde de GitHub que hay que pulsar: «Continue» (el codigo del editor) o «Authorize …».
function findGithubGuideButton(doc, kind) {
  const pattern = kind === "continue" ? /^continue$/i : /^authorize\b/i;
  const nodes = Array.from(doc?.querySelectorAll?.('button[type="submit"], input[type="submit"], button.btn-primary') || []);
  return nodes.filter(isGuideNodeVisible).find((node) => pattern.test(guideNodeText(node))) || null;
}

// ---- Comprobacion de la extension de VS Code (pura) ----

function cleanGuideVersion(value) {
  const text = toText(value);
  return /^\d+(\.\d+){1,3}$/.test(text) ? text : "";
}

/**
 * Lo que dice el aviso de la extension ADACEEN de VS Code:
 *   hidden       el backend no tiene la ruta (anterior a esta version) o no hay sesion
 *   idle         todavia no se ven los archivos
 *   checking     se ven, pero VS Code aun no se reporto (la primera vez instala la extension)
 *   ok           esta y es la ultima
 *   outdated     esta, con una version anterior (o sin version: anterior a la 0.0.37)
 *   unconnected  la barra de estado dice «ADACEEN: sin conectar»
 *   installed    esta en la barra de estado, pero el backend no la vio
 *   missing      pasado un minuto con los archivos a la vista, ni rastro
 * Solo cuenta lo que el backend vio hace poco (fresh): una visita vieja no es este editor.
 */
function buildVscodeExtensionCheckModel({ presence = null, unavailable = false, statusBar = null, filesVisibleMs = -1, staff = false } = {}) {
  if (unavailable) return { state: "hidden", title: "", detail: "", staffDetail: "", command: "" };
  const bar = statusBar || { present: false, unconnected: false };
  const fresh = !!presence?.fresh;
  const version = cleanGuideVersion(presence?.version);
  const latest = cleanGuideVersion(presence?.latest_version);
  const model = (state, title, detail = "", extra = {}) => ({ state, title, detail, staffDetail: "", command: "", ...extra });
  if (fresh && presence.status === "up_to_date") {
    return model("ok", version ? `ADACEEN ${version} está en tu editor: es la última versión.` : "ADACEEN está en tu editor y al día.");
  }
  if (fresh && (presence.status === "outdated" || presence.status === "unknown_version")) {
    const title = presence.status === "outdated" && version
      ? `Tu editor tiene ADACEEN ${version}${latest ? `; la última es ${latest}` : ""}.`
      : `Tu editor tiene una versión anterior de ADACEEN${latest ? `; la última es ${latest}` : ""}.`;
    return model("outdated", title, "Funciona igual. La versión nueva llega sola la próxima vez que se encienda tu editor.", staff
      ? { staffDetail: "Docente: para ponerla al día ahora, vuelve a correr el arranque de la VM de editores (reinicia los editores abiertos; mejor entre clases):", command: TUNNEL_VM_REFRESH_COMMAND }
      : {});
  }
  if (bar.unconnected) {
    return model("unconnected", "ADACEEN está en tu editor, pero sin conectar a tu cuenta.", "Pulsa «ADACEEN: sin conectar» en la barra de abajo y elige «Con mi cuenta de GitHub (recomendado)».");
  }
  if (!(filesVisibleMs >= 0)) return model("idle", "Cuando veas tus archivos, aquí se comprueba que ADACEEN esté en tu editor.");
  if (filesVisibleMs < TUNNEL_ENTRY_MISSING_AFTER_MS) return model("checking", "Buscando ADACEEN en tu editor…", "La primera vez puede tardar un minuto: se instala sola.");
  if (bar.present) return model("installed", "ADACEEN está en tu editor.", "No se pudo confirmar su versión con el servidor. Si algo no aparece, avisa a tu docente.");
  return model("missing", "Todavía no vemos ADACEEN en tu editor.", "Espera unos segundos. Si en la barra de abajo no aparece «ADACEEN», pulsa F1, escribe «Recargar ventana» (Reload Window) y pulsa Enter. Si sigue sin aparecer, avisa a tu docente.");
}

// Estados que ya dicen algo (se mandan a la telemetria).
function isFinalVscodeExtensionCheck(state) {
  return state === "ok" || state === "outdated" || state === "unconnected" || state === "installed" || state === "missing";
}

// La extension de VS Code del editor (tunel) segun el backend; unavailable: ruta o sesion que no hay.
async function fetchTunnelVscodePresence() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) return { unavailable: true, presence: null };
  try {
    const payload = await fetchJsonWithTimeout(`${baseUrl}/api/vscode/presence?host=tunnel`, { method: "GET", headers: buildApiHeaders() }, TUNNEL_ENTRY_CHECK_TIMEOUT_MS);
    return { unavailable: false, presence: payload && typeof payload === "object" ? payload : null };
  } catch (error) {
    const status = Number(error?.status) || 0;
    // 404: backend anterior a la 0.8.4; 400/401/403: sin sesion valida. Sin red: se reintenta.
    if (status === 404 || status === 400 || status === 401 || status === 403) return { unavailable: true, presence: null };
    return { unavailable: false, presence: null, failed: true };
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

function guideRectOf(node) {
  try {
    return node && typeof node.getBoundingClientRect === "function" ? node.getBoundingClientRect() : null;
  } catch {
    return null;
  }
}

/**
 * Plegado de un aviso en su pastilla: a mano (se respeta) o solo, cuando el aviso desplegado
 * taparia lo que hay que pulsar (se deshace solo cuando eso desaparece). Si el estudiante lo
 * despliega con el dialogo encima, ese mismo dialogo no lo vuelve a plegar.
 */
function createGuideCollapse({ box, pill }) {
  let collapsed = false;
  let automatic = false;
  let keepOpenFor = null;
  let lastArea = null;
  const set = (value, { auto = false } = {}) => {
    collapsed = !!value;
    automatic = collapsed && auto;
    if (box) box.hidden = collapsed;
    if (pill) pill.hidden = !collapsed;
  };
  return {
    set,
    isCollapsed: () => collapsed,
    collapse: () => set(true),
    expand: () => {
      keepOpenFor = lastArea;
      set(false);
    },
    // En cada vistazo: `area` (dialogo, lista o boton) y `target` no se pueden tapar.
    follow(area, target) {
      const current = area || null;
      if (current !== lastArea) {
        lastArea = current;
        if (!current && automatic) set(false);
      }
      if (!current || collapsed || keepOpenFor === current) return;
      if (shouldAutoCollapseGuide(guideRectOf(box), [guideRectOf(current), guideRectOf(target)])) set(true, { auto: true });
    },
  };
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

function hideGuidePointer(root) {
  const ring = root?.getElementById?.("adaceenGuidePointer");
  const tag = root?.getElementById?.("adaceenGuidePointerLabel");
  if (ring) ring.hidden = true;
  if (tag) tag.hidden = true;
}

// Pone el anillo alrededor de `rect` (coordenadas de la ventana: sirve con zoom y cualquier
// resolucion) y la etiqueta debajo, o arriba si no cabe, siempre dentro de la ventana.
function placeGuidePointer(root, rect, label) {
  const ring = root?.getElementById?.("adaceenGuidePointer");
  const tag = root?.getElementById?.("adaceenGuidePointerLabel");
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
}

/**
 * Mira cada GUIDE_WATCH_MS que hay en pantalla con `locate()` ({ target, label, area, ... }),
 * pasa el resultado a `onScreen` y marca `target` con el anillo; mientras haya objetivo, lo
 * sigue en cada cuadro (si el dialogo se mueve o la ventana cambia de tamano). Se detiene solo
 * cuando el aviso deja de estar en la pagina.
 */
function watchGuideScreen(host, root, { locate, onScreen } = {}) {
  let tracked = null;
  let label = "";
  let frame = 0;
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 100);
  const cancelRaf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout;
  const track = () => {
    frame = 0;
    if (!host.isConnected || !tracked || !isGuideNodeVisible(tracked)) {
      hideGuidePointer(root);
      return;
    }
    placeGuidePointer(root, guideRectOf(tracked), label);
    frame = raf(track);
  };
  const tick = () => {
    if (!host.isConnected) {
      stop();
      return;
    }
    if (document.visibilityState === "hidden") return;
    let screen = null;
    try {
      screen = typeof locate === "function" ? locate() : null;
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
      else hideGuidePointer(root);
    }
  };
  const timer = setInterval(tick, GUIDE_WATCH_MS);
  function stop() {
    clearInterval(timer);
    if (frame) cancelRaf(frame);
    frame = 0;
    tracked = null;
    hideGuidePointer(root);
  }
  tick();
  return { stop, tick };
}

// ---- El aviso del paso 4 ----

const TUNNEL_SIGNIN_BANNER_CSS = `
      .box { position: fixed; z-index: 2147483646; box-sizing: border-box; display: grid; gap: 8px;
        padding: 14px 16px; border-radius: 10px; background: #06131b; color: #f8fbff;
        border: 1px solid rgba(118, 239, 229, 0.65); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
        font: 14px/1.45 "Segoe UI", Arial, sans-serif; overflow: auto; overscroll-behavior: contain; }
      .box[hidden], .pill[hidden] { display: none; }
      .box.at-editor { left: 56px; bottom: 30px; width: min(680px, calc(100vw - 72px)); max-height: calc(100vh - 46px); }
      .box.at-github { top: 12px; left: 50%; transform: translateX(-50%); width: min(720px, calc(100vw - 24px)); max-height: calc(100vh - 24px); }
      .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
      .head-actions { display: flex; gap: 2px; flex: none; margin: -6px -8px 0 0; }
      p { margin: 0; color: #d9eaf0; }
      .layout { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: start; }
      ol.todo { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; counter-reset: paso; }
      ol.todo li { counter-increment: paso; }
      ol.todo li.plain { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 6px; color: #d9eaf0; }
      ol.todo li.plain::before, .step-num::before { content: counter(paso); }
      ol.todo li.plain::before, .step-num { width: 20px; height: 20px; border-radius: 50%; background: #123e49; color: #76efe5;
        font-size: 12px; font-weight: 800; display: inline-grid; place-items: center; line-height: 1; margin-top: 1px; }
      .step { width: 100%; display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 6px; align-items: start; padding: 6px 8px;
        border-radius: 8px; border: 1px solid transparent; background: transparent; color: #d9eaf0; font: inherit; text-align: left; cursor: pointer; }
      .step:hover { border-color: rgba(118, 239, 229, 0.3); }
      .step[aria-current="true"] { background: rgba(118, 239, 229, 0.1); border-color: rgba(118, 239, 229, 0.5); color: #ffffff; }
      .step-body { display: grid; gap: 2px; min-width: 0; }
      .step-title-line { color: #ffffff; font-weight: 700; }
      .step-detail { display: none; color: #d9eaf0; font-weight: 400; }
      .step[aria-current="true"] .step-detail { display: block; }
      .step-now { margin-left: 6px; padding: 1px 7px; border-radius: 999px; background: #ffd08a; color: #3b2a06; font-size: 11px; font-weight: 800; white-space: nowrap; }
      .step-now[hidden] { display: none; }
      .actions { display: flex; gap: 8px; }
      button { font: inherit; border: 0; border-radius: 8px; cursor: pointer; }
      button.done { padding: 7px 12px; font-weight: 700; background: #dffffb; color: #07353b; }
      button.icon { background: transparent; color: #d9eaf0; padding: 4px 8px; font-size: 16px; line-height: 1; }
      button:focus-visible { outline: 3px solid #ffd08a; outline-offset: 2px; }
      .warn { padding: 8px 10px; border-radius: 8px; background: #3b2a06; color: #ffe2a3; border: 1px solid #c99a2e; }
      .check { display: grid; gap: 4px; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(224, 248, 250, 0.3); background: #0b1a24; }
      .check[hidden] { display: none; }
      .check strong { color: #ffffff; }
      .check.is-ok { border-color: rgba(159, 240, 198, 0.6); background: #0c2a1f; }
      .check.is-ok strong { color: #9ff0c6; }
      .check.is-warn { border-color: #c99a2e; background: #2a1f07; }
      .check.is-warn strong { color: #ffe2a3; }
      .check code { display: block; padding: 6px 8px; border-radius: 6px; background: #020a0f; color: #d9eaf0;
        font: 12px/1.4 ui-monospace, Consolas, monospace; white-space: pre-wrap; word-break: break-all; }
      .check code[hidden], .check p[hidden], .check button[hidden] { display: none; }
      .check button { justify-self: start; padding: 5px 10px; font-weight: 700; background: #dffffb; color: #07353b; }
      .pill { position: fixed; z-index: 2147483646; box-sizing: border-box; display: inline-flex; align-items: center; gap: 8px;
        max-width: calc(100vw - 16px); padding: 8px 14px; border-radius: 999px; background: #06131b; color: #f8fbff;
        border: 1px solid rgba(118, 239, 229, 0.65); box-shadow: 0 10px 26px rgba(0, 0, 0, 0.4); cursor: pointer;
        font: 700 13px/1.3 "Segoe UI", Arial, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .pill.at-editor { left: 56px; bottom: 30px; max-width: calc(100vw - 72px); }
      .pill.at-github { top: 12px; left: 50%; transform: translateX(-50%); }
      .pill-action { color: #ffd08a; }
      .pill-action:empty { display: none; }
      @media (max-width: 720px) {
        .box.at-editor { left: 8px; right: 8px; width: auto; max-height: calc(100vh - 44px); }
        .pill.at-editor { left: 8px; max-width: calc(100vw - 16px); }
      }
      @media (max-width: 640px) {
        .layout { grid-template-columns: minmax(0, 1fr); }
        .layout .guide-figure { justify-self: start; width: min(280px, 100%); }
      }
      @media (max-height: 720px) {
        .box { gap: 6px; padding: 10px 12px; font-size: 13px; }
        .step { padding: 4px 6px; }
        .layout .guide-figure { width: 180px; }
        .guide-figure-caption { display: none; }
      }`;

/**
 * Monta el aviso del paso 4. `steps`: [{ key, title, text, figure }] (cada paso se puede
 * elegir para ver su dibujo); `figure`: el dibujo fijo de un aviso sin pasos elegibles;
 * `placement`: "editor" (abajo a la izquierda, vscode.dev) o "github" (arriba).
 * Devuelve el host con `controller` ({ setScreen, setCheck, collapse, expand }).
 */
function mountTunnelSignInBanner({ hostId, label, intro, items = [], steps = [], figure = "", onDone, warning = "", placement = "github" }) {
  document.getElementById(hostId)?.remove();
  const host = document.createElement("div");
  host.id = hostId;
  const root = host.attachShadow({ mode: "closed" });
  const at = placement === "editor" ? "at-editor" : "at-github";
  // Markup fijo; los textos entran con textContent.
  root.innerHTML = `
    <style>
      ${TUNNEL_SIGNIN_BANNER_CSS}
      ${FIRST_TIME_STEPS_CSS}
      ${GUIDE_FIGURES_CSS}
      ${GUIDE_POINTER_CSS}
    </style>
    <aside class="box ${at}" id="adaceenTunnelSignInBox" role="region" aria-label="">
      <div class="head">
        <strong class="step-title">${firstTimeStepHeading("open")}</strong>
        <div class="head-actions">
          <button type="button" class="icon" id="adaceenTunnelSignInMinimize" aria-label="Plegar la guía" title="Plegar">&#8211;</button>
          <button type="button" class="icon" id="adaceenTunnelSignInClose" aria-label="Ocultar el aviso" title="Ocultar">&times;</button>
        </div>
      </div>
      ${firstTimeStepsMarkup("open")}
      <p class="warn" id="adaceenTunnelSignInWarn" role="status" hidden></p>
      <p id="adaceenTunnelSignInText"></p>
      <div class="layout">
        <ol class="todo" id="adaceenTunnelSignInSteps"></ol>
        ${guideFigureSlotMarkup()}
      </div>
      <section class="check" id="adaceenTunnelSignInCheck" role="status" aria-live="polite" hidden>
        <strong id="adaceenTunnelSignInCheckTitle"></strong>
        <p id="adaceenTunnelSignInCheckDetail"></p>
        <p id="adaceenTunnelSignInCheckStaff" hidden></p>
        <code id="adaceenTunnelSignInCheckCommand" hidden></code>
        <button type="button" id="adaceenTunnelSignInCheckCopy" hidden>Copiar comando</button>
      </section>
      <div class="actions"><button type="button" class="done" id="adaceenTunnelSignInDone">Ya entré</button></div>
    </aside>
    <button type="button" class="pill ${at}" id="adaceenTunnelSignInPill" aria-label="Abrir la guía de ADACEEN" hidden>
      <span>Guía de ADACEEN · Paso 4</span><span class="pill-action" id="adaceenTunnelSignInPillAction"></span>
    </button>
    ${guidePointerMarkup()}
    ${guideLightboxMarkup()}`;
  root.getElementById("adaceenTunnelSignInBox")?.setAttribute("aria-label", label);
  const textEl = root.getElementById("adaceenTunnelSignInText");
  if (textEl) textEl.textContent = intro;
  const warnEl = root.getElementById("adaceenTunnelSignInWarn");
  if (warnEl) {
    warnEl.hidden = !warning;
    warnEl.textContent = warning;
  }

  const box = root.getElementById("adaceenTunnelSignInBox");
  const pill = root.getElementById("adaceenTunnelSignInPill");
  const pillAction = root.getElementById("adaceenTunnelSignInPillAction");
  const doneButton = root.getElementById("adaceenTunnelSignInDone");
  const figures = bindGuideFigures(root);

  // Pasos: elegibles (cada uno con su dibujo) o texto simple (aviso de GitHub).
  const listEl = root.getElementById("adaceenTunnelSignInSteps");
  const stepButtons = new Map();
  const stepNowTags = new Map();
  const selectable = steps.length > 0;
  let selectedKey = "";
  let nowKey = "";
  const selectStep = (key, figureKey = "") => {
    const step = steps.find((item) => item.key === key);
    if (!step) return;
    selectedKey = key;
    for (const [stepKey, button] of stepButtons) button.setAttribute("aria-current", stepKey === key ? "true" : "false");
    showGuideFigure(root, figureKey || step.figure);
  };
  if (selectable) {
    // Cada paso: titulo corto en una linea y, solo el elegido, el detalle (el aviso cabe en
    // pantallas bajas sin desplazarse).
    for (const step of steps) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "step";
      button.setAttribute("aria-current", "false");
      const num = document.createElement("span");
      num.className = "step-num";
      num.setAttribute("aria-hidden", "true");
      const body = document.createElement("span");
      body.className = "step-body";
      const title = document.createElement("strong");
      title.className = "step-title-line";
      title.textContent = step.title || step.text;
      const now = document.createElement("span");
      now.className = "step-now";
      now.textContent = "Ahora";
      now.hidden = true;
      title.appendChild(now);
      const detail = document.createElement("span");
      detail.className = "step-detail";
      detail.textContent = step.text;
      body.appendChild(title);
      body.appendChild(detail);
      button.appendChild(num);
      button.appendChild(body);
      button.addEventListener("click", () => selectStep(step.key));
      li.appendChild(button);
      listEl?.appendChild(li);
      stepButtons.set(step.key, button);
      stepNowTags.set(step.key, now);
    }
    selectStep(steps[0].key);
  } else {
    for (const item of items) {
      const li = document.createElement("li");
      li.className = "plain";
      li.textContent = item;
      listEl?.appendChild(li);
    }
    showGuideFigure(root, figure);
  }

  // Plegar y desplegar (a mano, o solo si taparia lo que hay que pulsar).
  const folding = createGuideCollapse({ box, pill });
  root.getElementById("adaceenTunnelSignInMinimize")?.addEventListener("click", () => {
    folding.collapse();
    pill?.focus?.();
  });
  pill?.addEventListener("click", () => {
    folding.expand();
    root.getElementById("adaceenTunnelSignInMinimize")?.focus?.();
  });
  root.getElementById("adaceenTunnelSignInClose")?.addEventListener("click", () => host.remove());
  doneButton?.addEventListener("click", () => {
    host.remove();
    if (typeof onDone === "function") onDone();
  });

  // Pantalla de VS Code (la pone el vigilante del editor): paso «Ahora», dibujo y pastilla.
  // Elegir la cuenta es parte del paso 1, con su propio dibujo.
  let nowFigure = "";
  const setScreen = (screen = {}) => {
    const map = { allow: "allow", account: "allow", trust: "trust", files: "files" };
    const key = map[screen.step] || "";
    const figureKey = screen.step === "account" ? "vscode-account" : "";
    if (key !== nowKey || figureKey !== nowFigure) {
      nowKey = key;
      nowFigure = figureKey;
      for (const [stepKey, tag] of stepNowTags) tag.hidden = stepKey !== key;
      if (key) selectStep(key, figureKey);
    }
    if (pillAction) pillAction.textContent = toText(screen.label);
    folding.follow(screen.area || screen.target, screen.target);
  };

  // Comprobacion de la extension de VS Code.
  const checkEl = root.getElementById("adaceenTunnelSignInCheck");
  const commandEl = root.getElementById("adaceenTunnelSignInCheckCommand");
  const copyEl = root.getElementById("adaceenTunnelSignInCheckCopy");
  copyEl?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(toText(commandEl?.textContent));
      copyEl.textContent = "Comando copiado";
    } catch {
      copyEl.textContent = "Cópialo a mano";
    }
  });
  const setCheck = (model) => {
    if (!checkEl) return;
    const visible = !!model && model.state !== "hidden";
    checkEl.hidden = !visible;
    if (!visible) return;
    checkEl.className = `check ${model.state === "ok" ? "is-ok" : ["outdated", "unconnected", "missing"].includes(model.state) ? "is-warn" : ""}`.trim();
    const titleEl = root.getElementById("adaceenTunnelSignInCheckTitle");
    const detailEl = root.getElementById("adaceenTunnelSignInCheckDetail");
    const staffEl = root.getElementById("adaceenTunnelSignInCheckStaff");
    if (titleEl) titleEl.textContent = model.title;
    if (detailEl) {
      detailEl.textContent = model.detail;
      detailEl.hidden = !model.detail;
    }
    if (staffEl) {
      staffEl.textContent = model.staffDetail;
      staffEl.hidden = !model.staffDetail;
    }
    if (commandEl) {
      commandEl.textContent = model.command;
      commandEl.hidden = !model.command;
    }
    if (copyEl) copyEl.hidden = !model.command;
    if (doneButton) doneButton.textContent = model.state === "ok" ? "Listo" : "Ya entré";
  };

  // Estado inicial explicito (no depender del atributo hidden del markup).
  hideGuidePointer(root);
  setCheck(null);
  folding.set(placement === "editor" && shouldStartGuideCollapsed());
  document.documentElement.appendChild(host);
  host.controller = {
    root,
    setScreen,
    setCheck,
    collapse: () => folding.collapse(),
    expand: () => folding.set(false),
    isCollapsed: () => folding.isCollapsed(),
    selectedStep: () => selectedKey,
    openFigure: (key) => figures.open(key),
  };
  return host;
}

function tunnelSignInAccountText(login) {
  return login ? `la cuenta «${login}» (la misma que autorizó el código)` : "la misma cuenta de GitHub que autorizó el código";
}

// Los cuatro pasos de vscode.dev con su dibujo.
function tunnelEntrySteps(account) {
  // 0.8.3 (piloto del 20/10/2026): «Allow» puede salir dos veces, la página de GitHub dice
  // «Microsoft» y VS Code pregunta si confías en la carpeta; sin confiar, ADACEEN queda limitado.
  return [
    { key: "allow", figure: "vscode-allow", title: "Permite que VS Code entre con GitHub", text: "Si VS Code pregunta si una extensión puede iniciar sesión con GitHub, pulsa «Allow» (Permitir). Si te deja elegir, elige «GitHub», nunca Microsoft. Puede preguntarlo dos veces: pulsa «Allow» las dos." },
    { key: "authorize", figure: "github-authorize", title: "Autoriza «Visual Studio Code» en GitHub", text: `En la página de GitHub que se abre, autoriza «Visual Studio Code» con ${account}. Que diga «Microsoft» es normal: Visual Studio Code es de Microsoft, pero entras con tu cuenta de GitHub.` },
    { key: "trust", figure: "vscode-trust", title: "Confía en los autores de la carpeta", text: "Si VS Code pregunta si confías en los autores de los archivos, pulsa «Sí, confío en los autores» (Yes, I trust the authors): en modo restringido ADACEEN queda limitado." },
    { key: "files", figure: "vscode-files", title: "Ve tus archivos y pulsa «Ya entré»", text: "Vuelve a esta pestaña: en unos segundos aparecen los archivos de tu ejercicio. Entonces pulsa «Ya entré»." },
  ];
}

/**
 * Comprueba la extension ADACEEN de VS Code del editor mientras el aviso este en la pagina:
 * pregunta al backend cada TUNNEL_ENTRY_CHECK_POLL_MS y mira la barra de estado. `filesSince()`
 * dice desde cuando se ven los archivos (0 si todavia no). Deja de preguntar con una respuesta
 * definitiva del backend («ok» u «outdated»: no cambia sin reiniciar el editor), si el backend
 * no tiene la ruta o tras TUNNEL_ENTRY_CHECK_MAX_POLLS consultas. Con «ok» llama `onOk` una vez.
 */
function startTunnelExtensionCheck(host, { filesSince, onModel, onOk } = {}) {
  let presence = null;
  let unavailable = false;
  let stopped = false;
  let okNotified = false;
  let polls = 0;
  const sentStates = [];
  const startedAt = Date.now();
  const render = () => {
    const since = typeof filesSince === "function" ? filesSince() : 0;
    const model = buildVscodeExtensionCheckModel({
      presence,
      unavailable,
      statusBar: readVscodeStatusBarAdaceen(document),
      filesVisibleMs: since > 0 ? Date.now() - since : -1,
      staff: workspaceViewerIsStaff(),
    });
    if (typeof onModel === "function") onModel(model);
    if (isFinalVscodeExtensionCheck(model.state) && sentStates[sentStates.length - 1] !== model.state && sentStates.length < TUNNEL_ENTRY_CHECK_EVENTS_MAX) {
      sentStates.push(model.state);
      trackTelemetryEvent("workflow", "tunnel_vscode_extension_checked", {
        value: model.state,
        pageContext: "vscode_tunnel",
        durationMs: Date.now() - startedAt,
        metadata: { version: cleanGuideVersion(presence?.version), latest: cleanGuideVersion(presence?.latest_version), attempt: sentStates.length },
      });
    }
    if (model.state === "ok" && !okNotified) {
      okNotified = true;
      if (typeof onOk === "function") onOk(model);
    }
    if (model.state === "ok" || model.state === "outdated") stop();
    return model;
  };
  const poll = async () => {
    if (stopped || !host.isConnected) {
      stop();
      return;
    }
    if (document.visibilityState !== "hidden") {
      // El tope cuenta desde que se ven los archivos (antes, el estudiante sigue entrando).
      if (typeof filesSince === "function" && filesSince() > 0) polls += 1;
      const result = await fetchTunnelVscodePresence();
      if (stopped) return;
      unavailable = result.unavailable;
      if (!result.failed) presence = result.presence;
    }
    render();
    if (unavailable || polls >= TUNNEL_ENTRY_CHECK_MAX_POLLS) stop();
  };
  const timer = setInterval(() => {
    poll().catch(() => {});
  }, TUNNEL_ENTRY_CHECK_POLL_MS);
  function stop() {
    stopped = true;
    clearInterval(timer);
  }
  poll().catch(() => {});
  return { stop, render };
}

// En vscode.dev/tunnel/<nombre>: el paso 4. Solo para el usuario de ADACEEN que abrio ese editor
// y en los minutos siguientes; se va con «Ya entre» o al vencer.
async function showTunnelSignInHint() {
  const tunnelName = tunnelNameFromEditorUrl(location.href);
  if (!tunnelName || !isExtensionRuntimeReady()) return false;
  const hint = await readTunnelSignInHint();
  if (!hint || toText(hint.tunnelName).toLowerCase() !== tunnelName) return false;
  const account = tunnelSignInAccountText(normalizeGithubLoginHint(hint.githubLogin));
  const host = mountTunnelSignInBanner({
    hostId: TUNNEL_SIGNIN_HINT_HOST_ID,
    label: "ADACEEN: como entrar a tu editor",
    intro: "Último paso, solo la primera vez: VS Code tiene que confirmar que tu cuenta de GitHub puede entrar a tu editor.",
    steps: tunnelEntrySteps(account),
    placement: "editor",
    onDone: () => {
      clearTunnelSignInHint().catch(() => {});
    },
  });
  const controller = host.controller;
  let filesSince = 0;
  let check = null;
  const watcher = watchGuideScreen(host, controller.root, {
    locate: () => {
      const screen = detectVscodeEntryScreen(document);
      return { ...screen, label: vscodeEntryPointerLabel(screen) };
    },
    onScreen: (screen) => {
      controller.setScreen(screen);
      if (screen.step === "files" && !filesSince) filesSince = Date.now();
      // La comprobacion depende del tiempo y de la barra de estado: se rehace en cada vistazo
      // (sin red; al backend se pregunta cada TUNNEL_ENTRY_CHECK_POLL_MS).
      check?.render();
    },
  });
  check = startTunnelExtensionCheck(host, {
    filesSince: () => filesSince,
    onModel: (model) => controller.setCheck(model),
    // Entro y la extension esta al dia: el aviso ya no vuelve (queda a la vista con «Listo»).
    onOk: () => {
      clearTunnelSignInHint().catch(() => {});
    },
  });
  // Cuando ya entro, el aviso sobra: se va solo cuando vence.
  window.setTimeout(() => {
    host.remove();
    watcher.stop();
    check.stop();
  }, Math.max(0, Number(hint.expiresAt) - Date.now()));
  return true;
}

// La pagina de GitHub que abre VS Code para autorizar «Visual Studio Code» (redirect_uri de
// vscode.dev), o su inicio de sesion previo: el mismo paso 4 con la cuenta correcta.
function isVscodeGithubAuthorizePage(href = location.href) {
  try {
    const url = new URL(toText(href));
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return false;
    const path = url.pathname.toLowerCase();
    let authorize = url;
    if (path === "/login" || path === "/session") {
      const returnTo = toText(url.searchParams.get("return_to"));
      if (!returnTo) return false;
      authorize = new URL(returnTo, "https://github.com");
    }
    if (!authorize.pathname.toLowerCase().startsWith("/login/oauth/authorize")) return false;
    const redirectUri = toText(authorize.searchParams.get("redirect_uri"));
    if (!redirectUri) return false;
    const host = new URL(redirectUri).hostname.toLowerCase();
    return host === "vscode.dev" || host.endsWith(".vscode.dev") || host.includes("vscode-redirect");
  } catch {
    return false;
  }
}

async function showVscodeGithubAuthorizeHelper() {
  if (!isVscodeGithubAuthorizePage()) return false;
  const hint = await readTunnelSignInHint();
  if (!hint) return false;
  const expected = normalizeGithubLoginHint(hint.githubLogin);
  const account = tunnelSignInAccountText(expected);
  const signIn = /^\/(login|session)\/?$/i.test(location.pathname);
  // 0.8.1: con otra cuenta abierta en GitHub, VS Code entraria con esa y no encontraria el editor.
  const signedIn = signIn ? "" : readGithubSignedInLogin();
  const warning = expected && signedIn && signedIn !== expected
    ? `Estás en GitHub como «${signedIn}», pero tu editor es de «${expected}». No autorices con esta cuenta: cambia de cuenta (tu foto, arriba a la derecha) y vuelve a entrar a tu editor.`
    : "";
  const host = mountTunnelSignInBanner({
    warning,
    hostId: TUNNEL_SIGNIN_GITHUB_HOST_ID,
    label: "ADACEEN: autoriza Visual Studio Code",
    intro: signIn
      ? `GitHub te pide iniciar sesión para que VS Code entre a tu editor. Usa ${account}.`
      : `Esta página es de GitHub: autoriza «Visual Studio Code» con ${account} para entrar a tu editor.`,
    items: signIn
      ? ["Inicia sesión con esa cuenta.", "Después pulsa el botón verde para autorizar «Visual Studio Code».", "GitHub te devuelve solo a tu editor."]
      : ["Revisa que arriba a la derecha esté tu cuenta.", "Pulsa el botón verde para autorizar «Visual Studio Code». Que diga «Microsoft» es normal: es quien hace VS Code.", "GitHub te devuelve solo a tu editor."],
    figure: "github-authorize",
    placement: "github",
    onDone: () => {
      clearTunnelSignInHint().catch(() => {});
    },
  });
  // El anillo va al boton verde solo con la cuenta correcta (con otra, no hay que pulsarlo).
  if (!signIn && !warning) {
    watchGuideScreen(host, host.controller.root, {
      locate: () => ({ target: findGithubGuideButton(document, "authorize"), label: "Pulsa el botón verde «Authorize»" }),
      onScreen: (screen) => host.controller.setScreen(screen),
    });
  }
  return true;
}
