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
//     (fetchVscodeExtensionReport en backend-vscode.service.js, que pregunta al backend).
// En la pagina de GitHub que autoriza «Visual Studio Code» va el mismo paso 4 (arriba, compacto).
// El anillo, el vigilante y el plegado son comunes con el paso 3 (guide-kit.js).

const TUNNEL_SIGNIN_HINT_HOST_ID = "adaceen-tunnel-signin-hint";
// El mismo paso 4 en la pagina de GitHub donde se autoriza «Visual Studio Code» (0.8.0).
const TUNNEL_SIGNIN_GITHUB_HOST_ID = "adaceen-tunnel-signin-github";
// Donde va el aviso: abajo a la izquierda en vscode.dev, arriba en GitHub.
const TUNNEL_SIGNIN_PLACEMENTS = ["editor", "github"];
// Cada cuanto se pregunta al backend por la extension de VS Code del editor.
const TUNNEL_ENTRY_CHECK_POLL_MS = 5000;
// Con los archivos a la vista y sin noticias de la extension en este tiempo: «no aparece».
const TUNNEL_ENTRY_MISSING_AFTER_MS = 60000;
// Telemetria del resultado: a lo sumo estas veces por aviso (el primero y si despues cambia).
const TUNNEL_ENTRY_CHECK_EVENTS_MAX = 3;
// Tope de consultas por aviso (5 min con los archivos a la vista): despues queda lo ultimo que se supo.
const TUNNEL_ENTRY_CHECK_MAX_POLLS = 60;

// ---- Pantallas de vscode.dev (funciones puras sobre un documento) ----

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

/**
 * Las pantallas de la primera entrada en vscode.dev y lo que dice el anillo en cada una, con el
 * texto del boton en el idioma de VS Code. Cada paso del aviso declara en que pantallas va
 * (`screens` en tunnelEntrySteps).
 */
const VSCODE_ENTRY_SCREENS = Object.freeze({
  allow: { pointerLabel: (buttonText) => (VSCODE_ENTRY_PATTERNS.permitir.test(buttonText) ? "Pulsa «Permitir»" : "Pulsa «Allow»") },
  account: { pointerLabel: () => "Elige «GitHub»" },
  trust: {
    pointerLabel: (buttonText) => (VSCODE_ENTRY_PATTERNS.spanishTrust.test(buttonText) ? "Pulsa «Sí, confío en los autores»" : "Pulsa «Yes, I trust the authors»"),
  },
  files: { pointerLabel: () => "" },
});

/**
 * La pantalla de la primera entrada que muestra vscode.dev: `screen` es «allow» (permiso para
 * iniciar sesion con GitHub), «account» (elegir GitHub o Microsoft), «trust» (confiar en los
 * autores), «files» (ya se ven los archivos) o "". `target` es lo que hay que pulsar y
 * `avoidArea`, el dialogo o la lista que el aviso no debe tapar.
 */
function detectVscodeEntryScreen(doc = document) {
  const patterns = VSCODE_ENTRY_PATTERNS;
  const dialogs = Array.from(doc?.querySelectorAll?.(".monaco-dialog-box") || []).filter(isGuideNodeVisible);
  for (const dialog of dialogs) {
    const text = guideNodeText(dialog);
    const buttons = guideButtonsIn(dialog);
    if (patterns.trust.test(text) && patterns.authors.test(text)) {
      return { screen: "trust", target: buttons.find((button) => patterns.trustYes.test(guideNodeText(button))) || null, avoidArea: dialog };
    }
    const githubButton = buttons.find((button) => patterns.github.test(guideNodeText(button)));
    if (githubButton && buttons.some((button) => patterns.microsoft.test(guideNodeText(button)))) {
      return { screen: "account", target: githubButton, avoidArea: dialog };
    }
    const allowButton = buttons.find((button) => patterns.allow.test(guideNodeText(button)));
    if (allowButton && patterns.github.test(text) && patterns.signIn.test(text)) {
      return { screen: "allow", target: allowButton, avoidArea: dialog };
    }
  }
  const picker = Array.from(doc?.querySelectorAll?.(".quick-input-widget") || []).find(isGuideNodeVisible);
  if (picker) {
    const rows = Array.from(picker.querySelectorAll?.(".monaco-list-row") || []).filter(isGuideNodeVisible);
    const githubRow = rows.find((row) => patterns.github.test(guideNodeText(row)));
    if (githubRow && rows.some((row) => patterns.microsoft.test(guideNodeText(row)))) {
      return { screen: "account", target: githubRow, avoidArea: picker };
    }
  }
  const fileRow = doc?.querySelector?.(".explorer-folders-view .monaco-list-row");
  if (isGuideNodeVisible(fileRow)) return { screen: "files", target: null, avoidArea: null };
  return { screen: "", target: null, avoidArea: null };
}

// Lo que dice el anillo en la pantalla detectada ("" si no hay nada que pulsar).
function vscodeEntryPointerLabel(entry) {
  const screen = toText(entry?.screen);
  if (!Object.prototype.hasOwnProperty.call(VSCODE_ENTRY_SCREENS, screen)) return "";
  return VSCODE_ENTRY_SCREENS[screen].pointerLabel(guideNodeText(entry?.target));
}

/** Items de la extension ADACEEN en la barra de estado de VS Code («ADACEEN: <nombre>», «ADACEEN: sin conectar»). */
function readVscodeStatusBarAdaceen(doc = document) {
  const texts = Array.from(doc?.querySelectorAll?.(".statusbar-item") || [])
    .map(guideNodeText)
    .filter((text) => /\bADACEEN\b/i.test(text));
  return { present: texts.length > 0, unconnected: texts.some((text) => /sin conectar/i.test(text)) };
}

// ---- Comprobacion de la extension de VS Code (pura) ----

const VSCODE_CHECK_WARN_STATES = new Set(["outdated", "unconnected", "missing"]);
const VSCODE_CHECK_REPORTABLE_STATES = new Set(["ok", "outdated", "unconnected", "installed", "missing"]);

// Estados que ya dicen algo del editor: se mandan a la telemetria.
function isReportableVscodeExtensionCheckState(state) {
  return VSCODE_CHECK_REPORTABLE_STATES.has(state);
}

// Estados que no cambian sin reiniciar el editor: se deja de preguntar al backend. «missing» no:
// una primera instalacion lenta termina en «ok».
function isTerminalVscodeExtensionCheckState(state) {
  return state === "ok" || state === "outdated";
}

/**
 * Lo que dice el aviso de la extension ADACEEN de VS Code. `report` es lo que devolvio
 * fetchVscodeExtensionReport (normalizado); `filesVisibleForMs`, cuanto hace que se ven los
 * archivos (null si todavia no):
 *   hidden       el backend no tiene la ruta (anterior a esta version) o no hay sesion
 *   idle         todavia no se ven los archivos
 *   checking     se ven, pero VS Code aun no se reporto (la primera vez instala la extension)
 *   ok           esta y es la ultima
 *   outdated     esta, con una version anterior (o sin version: anterior a la 0.0.37)
 *   unconnected  la barra de estado dice «ADACEEN: sin conectar»
 *   installed    esta, pero no se pudo comparar su version (barra de estado o backend sin la publicada)
 *   missing      pasado un minuto con los archivos a la vista, ni rastro
 * Solo cuenta lo que el backend vio hace poco (online): una visita vieja no es este editor.
 * El modelo trae su tono (ok, warn o neutral) y si es terminal; al docente, `staffCommand` del backend.
 */
function buildVscodeExtensionCheckModel({ report = null, presenceCheckUnsupported = false, statusBar = null, filesVisibleForMs = null } = {}) {
  const model = (state, title, detail = "", extra = {}) => ({
    state,
    title,
    detail,
    staffDetail: "",
    staffCommand: "",
    tone: state === "ok" ? "ok" : VSCODE_CHECK_WARN_STATES.has(state) ? "warn" : "neutral",
    terminal: isTerminalVscodeExtensionCheckState(state),
    ...extra,
  });
  if (presenceCheckUnsupported) return model("hidden", "");
  const bar = statusBar || { present: false, unconnected: false };
  const online = !!report?.online;
  const version = report?.version || "";
  const latest = report?.latestVersion || "";
  if (online && report.status === "up_to_date") {
    return model("ok", version ? `ADACEEN ${version} está en tu editor: es la última versión.` : "ADACEEN está en tu editor y al día.");
  }
  if (online && isVscodeExtensionOutdated(report)) {
    const title = report.status === "outdated" && version
      ? `Tu editor tiene ADACEEN ${version}${latest ? `; la última es ${latest}` : ""}.`
      : `Tu editor tiene una versión anterior de ADACEEN${latest ? `; la última es ${latest}` : ""}.`;
    return model("outdated", title, "Funciona igual. La versión nueva llega sola la próxima vez que se encienda tu editor.", report.staffCommand
      ? { staffDetail: "Docente: para ponerla al día ahora, vuelve a correr el arranque de la VM de editores (reinicia los editores abiertos; mejor entre clases):", staffCommand: report.staffCommand }
      : {});
  }
  if (online && report.status === "latest_unknown") {
    return model("installed", version ? `ADACEEN ${version} está en tu editor.` : "ADACEEN está en tu editor.", "No se pudo comparar con la versión publicada. Si algo no aparece, avisa a tu docente.");
  }
  if (bar.unconnected) {
    return model("unconnected", "ADACEEN está en tu editor, pero sin conectar a tu cuenta.", "Pulsa «ADACEEN: sin conectar» en la barra de abajo y elige «Con mi cuenta de GitHub (recomendado)».");
  }
  if (typeof filesVisibleForMs !== "number" || !(filesVisibleForMs >= 0)) return model("idle", "Cuando veas tus archivos, aquí se comprueba que ADACEEN esté en tu editor.");
  if (filesVisibleForMs < TUNNEL_ENTRY_MISSING_AFTER_MS) return model("checking", "Buscando ADACEEN en tu editor…", "La primera vez puede tardar un minuto: se instala sola.");
  if (bar.present) return model("installed", "ADACEEN está en tu editor.", "No se pudo confirmar su versión con el servidor. Si algo no aparece, avisa a tu docente.");
  return model("missing", "Todavía no vemos ADACEEN en tu editor.", "Espera unos segundos. Si en la barra de abajo no aparece «ADACEEN», pulsa F1, escribe «Recargar ventana» (Reload Window) y pulsa Enter. Si sigue sin aparecer, avisa a tu docente.");
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
 * Los pasos elegibles del aviso de vscode.dev: cada uno es un boton con titulo corto y, solo el
 * elegido, el detalle (el aviso cabe en pantallas bajas sin desplazarse) y su dibujo.
 * `markScreen(screen)` marca con «Ahora» el paso que declara esa pantalla de VS Code (`screens`)
 * y lo elige, con el dibujo propio de la pantalla si lo tiene (`figureForScreen`).
 */
function bindEntrySteps(listEl, steps, figures) {
  const rows = new Map();
  let nowKey = "";
  let nowFigure = "";
  const select = (key, figureKey = "") => {
    const step = steps.find((item) => item.key === key);
    if (!step) return;
    for (const [stepKey, row] of rows) row.button.setAttribute("aria-current", stepKey === key ? "true" : "false");
    figures.show(figureKey || step.figure);
  };
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
    const nowTag = document.createElement("span");
    nowTag.className = "step-now";
    nowTag.textContent = "Ahora";
    nowTag.hidden = true;
    title.appendChild(nowTag);
    const detail = document.createElement("span");
    detail.className = "step-detail";
    detail.textContent = step.text;
    body.appendChild(title);
    body.appendChild(detail);
    button.appendChild(num);
    button.appendChild(body);
    button.addEventListener("click", () => select(step.key));
    li.appendChild(button);
    listEl?.appendChild(li);
    rows.set(step.key, { button, nowTag });
  }
  if (steps.length) select(steps[0].key);
  const markScreen = (screen) => {
    const step = (screen && steps.find((item) => (item.screens || []).includes(screen))) || null;
    const key = step?.key || "";
    const figureKey = (step && step.figureForScreen?.[screen]) || "";
    if (key === nowKey && figureKey === nowFigure) return;
    nowKey = key;
    nowFigure = figureKey;
    for (const [stepKey, row] of rows) row.nowTag.hidden = stepKey !== key;
    if (key) select(key, figureKey);
  };
  return { select, markScreen };
}

// Lista simple, sin pasos elegibles (aviso de GitHub).
function renderPlainSteps(listEl, items) {
  for (const item of items || []) {
    const li = document.createElement("li");
    li.className = "plain";
    li.textContent = item;
    listEl?.appendChild(li);
  }
}

/**
 * El cuadro de la comprobacion de la extension: `render(model)` lo muestra con su tono (o lo
 * oculta con null o «hidden»), el comando del docente con «Copiar comando», y cambia «Ya entré»
 * por «Listo» cuando la extension esta al dia.
 */
function bindExtensionCheckView(root, { doneButton }) {
  const checkEl = root.getElementById("adaceenTunnelSignInCheck");
  const titleEl = root.getElementById("adaceenTunnelSignInCheckTitle");
  const detailEl = root.getElementById("adaceenTunnelSignInCheckDetail");
  const staffEl = root.getElementById("adaceenTunnelSignInCheckStaff");
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
  const showText = (el, text) => {
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
  };
  const render = (model) => {
    const visible = !!model && model.state !== "hidden";
    if (doneButton) doneButton.textContent = visible && model.state === "ok" ? "Listo" : "Ya entré";
    if (!checkEl) return;
    checkEl.hidden = !visible;
    if (!visible) return;
    checkEl.className = `check ${model.tone === "ok" ? "is-ok" : model.tone === "warn" ? "is-warn" : ""}`.trim();
    if (titleEl) titleEl.textContent = model.title;
    showText(detailEl, model.detail);
    showText(staffEl, model.staffDetail);
    showText(commandEl, model.staffCommand);
    if (copyEl) copyEl.hidden = !model.staffCommand;
  };
  render(null);
  return { render };
}

/**
 * Monta el aviso del paso 4 y devuelve { host, controller }.
 *   content    { kind: "steps", steps }: pasos elegibles con su dibujo (vscode.dev), o
 *              { kind: "list", items, figure }: texto y un dibujo fijo (GitHub)
 *   placement  "editor" (abajo a la izquierda, vscode.dev) o "github" (arriba)
 *   ariaLabel  nombre de la region para el lector de pantalla
 * controller: setScreen(entry) (pantalla de VS Code o boton de GitHub: paso «Ahora», dibujo,
 * pastilla y no taparlo), setCheck(model) (comprobacion de la extension) y pointer (el anillo
 * que mueve watchGuideScreen).
 */
function mountTunnelSignInBanner({ hostId, ariaLabel, intro, content, onDone, warning = "", placement }) {
  if (!TUNNEL_SIGNIN_PLACEMENTS.includes(placement)) throw new TypeError(`Aviso del paso 4: placement desconocido (${placement}).`);
  if (content?.kind !== "steps" && content?.kind !== "list") throw new TypeError("Aviso del paso 4: content.kind debe ser steps o list.");
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
  const box = root.getElementById("adaceenTunnelSignInBox");
  const pill = root.getElementById("adaceenTunnelSignInPill");
  const pillAction = root.getElementById("adaceenTunnelSignInPillAction");
  const doneButton = root.getElementById("adaceenTunnelSignInDone");
  box?.setAttribute("aria-label", ariaLabel);
  const textEl = root.getElementById("adaceenTunnelSignInText");
  if (textEl) textEl.textContent = intro;
  const warnEl = root.getElementById("adaceenTunnelSignInWarn");
  if (warnEl) {
    warnEl.hidden = !warning;
    warnEl.textContent = warning;
  }

  const figures = bindGuideFigures(root);
  const pointer = bindGuidePointer(root);
  const listEl = root.getElementById("adaceenTunnelSignInSteps");
  const steps = content.kind === "steps" ? bindEntrySteps(listEl, content.steps, figures) : null;
  if (content.kind === "list") {
    renderPlainSteps(listEl, content.items);
    figures.show(content.figure);
  }

  // Plegar y desplegar (a mano, o solo si taparia lo que hay que pulsar).
  const folding = createGuideFoldController({ box, pill });
  wireGuideFold(folding, { minimizeButton: root.getElementById("adaceenTunnelSignInMinimize"), pill });
  root.getElementById("adaceenTunnelSignInClose")?.addEventListener("click", () => host.remove());
  doneButton?.addEventListener("click", () => {
    host.remove();
    if (typeof onDone === "function") onDone();
  });
  const checkView = bindExtensionCheckView(root, { doneButton });

  // Lo que hay en pantalla (lo pasa el vigilante): paso «Ahora», dibujo, pastilla y no taparlo.
  const setScreen = (entry = {}) => {
    steps?.markScreen(toText(entry.screen));
    if (pillAction) pillAction.textContent = toText(entry.label);
    folding.avoidCovering({ avoidArea: entry.avoidArea || null, target: entry.target || null });
  };

  folding.setCollapsed(placement === "editor" && shouldStartGuideCollapsed());
  document.documentElement.appendChild(host);
  return { host, controller: { setScreen, setCheck: checkView.render, pointer } };
}

function tunnelSignInAccountText(login) {
  return login ? `la cuenta «${login}» (la misma que autorizó el código)` : "la misma cuenta de GitHub que autorizó el código";
}

/**
 * Los cuatro pasos de vscode.dev con su dibujo. `screens`: las pantallas de VS Code en que va el
 * paso (detectVscodeEntryScreen); `figureForScreen`: el dibujo propio de alguna de ellas.
 * Autorizar en GitHub no tiene pantalla en vscode.dev (la tiene el aviso de GitHub).
 */
function tunnelEntrySteps(account) {
  // 0.8.3 (piloto del 20/10/2026): «Allow» puede salir dos veces, la página de GitHub dice
  // «Microsoft» y VS Code pregunta si confías en la carpeta; sin confiar, ADACEEN queda limitado.
  return [
    { key: "allow", screens: ["allow", "account"], figure: "vscode-allow", figureForScreen: { account: "vscode-account" }, title: "Permite que VS Code entre con GitHub", text: "Si VS Code pregunta si una extensión puede iniciar sesión con GitHub, pulsa «Allow» (Permitir). Si te deja elegir, elige «GitHub», nunca Microsoft. Puede preguntarlo dos veces: pulsa «Allow» las dos." },
    { key: "authorize", screens: [], figure: "github-authorize", title: "Autoriza «Visual Studio Code» en GitHub", text: `En la página de GitHub que se abre, autoriza «Visual Studio Code» con ${account}. Que diga «Microsoft» es normal: Visual Studio Code es de Microsoft, pero entras con tu cuenta de GitHub.` },
    { key: "trust", screens: ["trust"], figure: "vscode-trust", title: "Confía en los autores de la carpeta", text: "Si VS Code pregunta si confías en los autores de los archivos, pulsa «Sí, confío en los autores» (Yes, I trust the authors): en modo restringido ADACEEN queda limitado." },
    { key: "files", screens: ["files"], figure: "vscode-files", title: "Ve tus archivos y pulsa «Ya entré»", text: "Vuelve a esta pestaña: en unos segundos aparecen los archivos de tu ejercicio. Entonces pulsa «Ya entré»." },
  ];
}

/**
 * Comprueba la extension ADACEEN de VS Code del editor mientras `isActive()`: pregunta al backend
 * cada TUNNEL_ENTRY_CHECK_POLL_MS y mira la barra de estado. `getFilesVisibleSince()` dice desde
 * cuando se ven los archivos (0 si todavia no). Deja de preguntar con un estado terminal («ok» u
 * «outdated»), si el backend no tiene la ruta o tras TUNNEL_ENTRY_CHECK_MAX_POLLS consultas. Con
 * «ok» llama `onOk` una vez.
 * `reevaluate()` rehace el modelo sin red (el vigilante lo llama en cada vistazo: depende del
 * tiempo y de la barra de estado); con un estado nuevo manda la telemetria y puede detener las consultas.
 */
function startTunnelExtensionCheck({ isActive, getFilesVisibleSince, onModel, onOk }) {
  let report = null;
  let unsupported = false;
  let stopped = false;
  let okNotified = false;
  let polls = 0;
  const sentStates = [];
  const startedAt = Date.now();
  const filesVisibleSince = () => (typeof getFilesVisibleSince === "function" ? Number(getFilesVisibleSince()) || 0 : 0);
  const currentModel = () => {
    const since = filesVisibleSince();
    return buildVscodeExtensionCheckModel({
      report,
      presenceCheckUnsupported: unsupported,
      statusBar: readVscodeStatusBarAdaceen(document),
      filesVisibleForMs: since > 0 ? Date.now() - since : null,
    });
  };
  // Telemetria: cada resultado nuevo que dice algo, a lo sumo TUNNEL_ENTRY_CHECK_EVENTS_MAX veces.
  const reportState = (model) => {
    if (!isReportableVscodeExtensionCheckState(model.state) || sentStates[sentStates.length - 1] === model.state) return;
    if (sentStates.length >= TUNNEL_ENTRY_CHECK_EVENTS_MAX) return;
    sentStates.push(model.state);
    trackTelemetryEvent("workflow", "tunnel_vscode_extension_checked", {
      value: model.state,
      pageContext: "vscode_tunnel",
      durationMs: Date.now() - startedAt,
      metadata: { version: report?.version || "", latestVersion: report?.latestVersion || "", attempt: sentStates.length },
    });
  };
  const reevaluate = () => {
    const model = currentModel();
    if (typeof onModel === "function") onModel(model);
    reportState(model);
    if (model.state === "ok" && !okNotified) {
      okNotified = true;
      if (typeof onOk === "function") onOk(model);
    }
    if (model.terminal) stop();
    return model;
  };
  const poll = async () => {
    if (stopped || !isActive()) {
      stop();
      return;
    }
    if (document.visibilityState !== "hidden") {
      // El tope cuenta desde que se ven los archivos (antes, el estudiante sigue entrando).
      if (filesVisibleSince() > 0) polls += 1;
      const result = await fetchVscodeExtensionReport("tunnel");
      if (stopped) return;
      if (result.outcome === "ok") report = result.report;
      else if (result.outcome === "unsupported") unsupported = true;
      // "retry" (sin red): queda lo ultimo que se supo.
    }
    reevaluate();
    if (unsupported || polls >= TUNNEL_ENTRY_CHECK_MAX_POLLS) stop();
  };
  const timer = setInterval(() => {
    poll().catch(() => {});
  }, TUNNEL_ENTRY_CHECK_POLL_MS);
  function stop() {
    stopped = true;
    clearInterval(timer);
  }
  poll().catch(() => {});
  return { stop, reevaluate };
}

// En vscode.dev/tunnel/<nombre>: el paso 4. Solo para el usuario de ADACEEN que abrio ese editor
// y en los minutos siguientes; se va con «Ya entre» o al vencer.
async function showTunnelSignInHint() {
  const tunnelName = tunnelNameFromEditorUrl(location.href);
  if (!tunnelName || !isExtensionRuntimeReady()) return false;
  const hint = await readTunnelSignInHint();
  if (!hint || toText(hint.tunnelName).toLowerCase() !== tunnelName) return false;
  const account = tunnelSignInAccountText(normalizeGithubLoginHint(hint.githubLogin));
  const { host, controller } = mountTunnelSignInBanner({
    hostId: TUNNEL_SIGNIN_HINT_HOST_ID,
    ariaLabel: "ADACEEN: como entrar a tu editor",
    intro: "Último paso, solo la primera vez: VS Code tiene que confirmar que tu cuenta de GitHub puede entrar a tu editor.",
    content: { kind: "steps", steps: tunnelEntrySteps(account) },
    placement: "editor",
    onDone: () => {
      clearTunnelSignInHint().catch(() => {});
    },
  });
  const isActive = () => host.isConnected;
  let filesVisibleSince = 0;
  let check = null;
  const watcher = watchGuideScreen({
    pointer: controller.pointer,
    isActive,
    locate: () => {
      const entry = detectVscodeEntryScreen(document);
      return { ...entry, label: vscodeEntryPointerLabel(entry) };
    },
    onScreen: (entry) => {
      controller.setScreen(entry);
      if (entry.screen === "files" && !filesVisibleSince) filesVisibleSince = Date.now();
      // La comprobacion depende del tiempo y de la barra de estado: se rehace en cada vistazo
      // (sin red; al backend se pregunta cada TUNNEL_ENTRY_CHECK_POLL_MS).
      check?.reevaluate();
    },
  });
  check = startTunnelExtensionCheck({
    isActive,
    getFilesVisibleSince: () => filesVisibleSince,
    onModel: controller.setCheck,
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
  const { host, controller } = mountTunnelSignInBanner({
    warning,
    hostId: TUNNEL_SIGNIN_GITHUB_HOST_ID,
    ariaLabel: "ADACEEN: autoriza Visual Studio Code",
    intro: signIn
      ? `GitHub te pide iniciar sesión para que VS Code entre a tu editor. Usa ${account}.`
      : `Esta página es de GitHub: autoriza «Visual Studio Code» con ${account} para entrar a tu editor.`,
    content: {
      kind: "list",
      items: signIn
        ? ["Inicia sesión con esa cuenta.", "Después pulsa el botón verde para autorizar «Visual Studio Code».", "GitHub te devuelve solo a tu editor."]
        : ["Revisa que arriba a la derecha esté tu cuenta.", "Pulsa el botón verde para autorizar «Visual Studio Code». Que diga «Microsoft» es normal: es quien hace VS Code.", "GitHub te devuelve solo a tu editor."],
      figure: "github-authorize",
    },
    placement: "github",
    onDone: () => {
      clearTunnelSignInHint().catch(() => {});
    },
  });
  // El anillo va al boton verde solo con la cuenta correcta (con otra, no hay que pulsarlo).
  if (!signIn && !warning) {
    watchGuideScreen({
      pointer: controller.pointer,
      isActive: () => host.isConnected,
      locate: () => ({ target: findGithubGuideButton(document, "authorize"), label: "Pulsa el botón verde «Authorize»" }),
      onScreen: controller.setScreen,
    });
  }
  return true;
}
