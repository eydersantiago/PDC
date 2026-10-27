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
// En la pagina de GitHub que autoriza «Visual Studio Code» va el mismo paso 4 (arriba, compacto) y,
// desde la 0.8.5, tambien en su selector de cuentas (VS Code lo pide despues de cerrar la sesion de
// otra cuenta, editor-account-switch.service.js): marca la cuenta del editor.
// El anillo, el vigilante, el plegado, la caja y los pasos son comunes (guide-kit.js). El freno del
// cambio de cuenta de VS Code y como se nombran las cuentas vienen de editor-account-switch-record.js
// (carga antes). editor-account-switch.service.js usa isVscodeSignInDialogText de aqui.

const TUNNEL_ENTRY_GUIDE_HOST_ID = "adaceen-tunnel-signin-hint";
// El mismo paso 4 en la pagina de GitHub donde se autoriza «Visual Studio Code» (0.8.0).
const TUNNEL_ENTRY_GUIDE_GITHUB_HOST_ID = "adaceen-tunnel-signin-github";
// Donde va el aviso: abajo a la izquierda en vscode.dev, arriba en GitHub.
const TUNNEL_ENTRY_GUIDE_PLACEMENTS = ["editor", "github"];
// Cada cuanto se pregunta al backend por la extension de VS Code del editor.
const VSCODE_EXTENSION_CHECK_POLL_MS = 5000;
// Con los archivos a la vista y sin noticias de la extension en este tiempo: «no aparece».
const VSCODE_EXTENSION_CHECK_MISSING_AFTER_MS = 60000;
// Telemetria del resultado: a lo sumo estas veces por aviso (el primero y si despues cambia).
const VSCODE_EXTENSION_CHECK_EVENTS_MAX = 3;
// Tope de consultas por aviso (5 min con los archivos a la vista): despues queda lo ultimo que se supo.
const VSCODE_EXTENSION_CHECK_MAX_POLLS = 60;

// ---- Pantallas de vscode.dev (funciones puras sobre un documento) ----

const VSCODE_ENTRY_PATTERNS = Object.freeze({
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
});

// ¿Es el dialogo de VS Code que pide permiso para iniciar sesion con GitHub o Microsoft? (Tambien lo
// usa el cambio de cuenta de VS Code: es el unico, ademas del del tunel, que puede cancelar solo.)
function isVscodeSignInDialogText(text) {
  const value = toText(text);
  return VSCODE_ENTRY_PATTERNS.signIn.test(value) && (VSCODE_ENTRY_PATTERNS.github.test(value) || VSCODE_ENTRY_PATTERNS.microsoft.test(value));
}

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

const VSCODE_EXTENSION_CHECK_WARN_STATES = new Set(["outdated", "unconnected", "missing"]);
const VSCODE_EXTENSION_CHECK_REPORTABLE_STATES = new Set(["ok", "outdated", "unconnected", "version_unverified", "missing"]);

// Estados que ya dicen algo del editor: se mandan a la telemetria.
function isReportableVscodeExtensionCheckState(state) {
  return VSCODE_EXTENSION_CHECK_REPORTABLE_STATES.has(state);
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
 *   hidden              el backend no tiene la ruta (anterior a esta version) o no hay sesion
 *   idle                todavia no se ven los archivos
 *   checking            se ven, pero VS Code aun no se reporto (la primera vez instala la extension)
 *   ok                  esta y es la ultima
 *   outdated            esta, con una version anterior
 *   unconnected         la barra de estado dice «ADACEEN: sin conectar»
 *   version_unverified  esta, pero no se pudo comparar su version (barra de estado, o el backend
 *                       sin la publicada o sin la version del editor)
 *   missing             pasado un minuto con los archivos a la vista, ni rastro
 * Solo cuenta lo que el backend vio hace poco (online): una visita vieja no es este editor.
 * El modelo trae su tono (ok, warn o neutral) y si es terminal; al docente, el comando del
 * arranque de la VM que manda el backend (vmStartupCommand).
 */
function buildVscodeExtensionCheckModel({ report = null, presenceCheckUnsupported = false, statusBar = null, filesVisibleForMs = null } = {}) {
  const model = (state, title, detail = "", extra = {}) => ({
    state,
    title,
    detail,
    staffDetail: "",
    vmStartupCommand: "",
    tone: state === "ok" ? "ok" : VSCODE_EXTENSION_CHECK_WARN_STATES.has(state) ? "warn" : "neutral",
    terminal: isTerminalVscodeExtensionCheckState(state),
    ...extra,
  });
  if (presenceCheckUnsupported) return model("hidden", "");
  const bar = statusBar || { present: false, unconnected: false };
  const found = report?.online ? classifyVscodeExtensionReport(report) : null;
  if (found?.kind === "current") {
    return model("ok", found.version ? `ADACEEN ${found.version} está en tu editor: es la última versión.` : "ADACEEN está en tu editor y al día.");
  }
  if (found?.kind === "outdated") {
    const editorHas = found.version ? `Tu editor tiene ADACEEN ${found.version}` : "Tu editor tiene una versión anterior de ADACEEN";
    const latest = found.latestVersion ? `; la última es ${found.latestVersion}` : "";
    return model("outdated", `${editorHas}${latest}.`,"Funciona igual. La versión nueva llega sola la próxima vez que se encienda tu editor.", report.workspaceVmStartupCommand
      ? { staffDetail: "Docente: para ponerla al día ahora, vuelve a correr el arranque de la VM de editores (reinicia los editores abiertos; mejor entre clases):", vmStartupCommand: report.workspaceVmStartupCommand }
      : {});
  }
  if (found?.kind === "unverified") {
    return model("version_unverified", found.version ? `ADACEEN ${found.version} está en tu editor.` : "ADACEEN está en tu editor.", "No se pudo comparar con la versión publicada. Si algo no aparece, avisa a tu docente.");
  }
  if (bar.unconnected) {
    return model("unconnected", "ADACEEN está en tu editor, pero sin conectar a tu cuenta.", "Pulsa «ADACEEN: sin conectar» en la barra de abajo y elige «Con mi cuenta de GitHub (recomendado)».");
  }
  if (typeof filesVisibleForMs !== "number" || !(filesVisibleForMs >= 0)) return model("idle", "Cuando veas tus archivos, aquí se comprueba que ADACEEN esté en tu editor.");
  if (filesVisibleForMs < VSCODE_EXTENSION_CHECK_MISSING_AFTER_MS) return model("checking", "Buscando ADACEEN en tu editor…", "La primera vez puede tardar un minuto: se instala sola.");
  if (bar.present) return model("version_unverified", "ADACEEN está en tu editor.", "No se pudo confirmar su versión con el servidor. Si algo no aparece, avisa a tu docente.");
  return model("missing", "Todavía no vemos ADACEEN en tu editor.", "Espera unos segundos. Si en la barra de abajo no aparece «ADACEEN», pulsa F1, escribe «Recargar ventana» (Reload Window) y pulsa Enter. Si sigue sin aparecer, avisa a tu docente.");
}

// ---- El aviso del paso 4 ----

// Lo propio del paso 4: donde va (abajo a la izquierda en vscode.dev, arriba en GitHub) y la
// comprobacion de la extension de VS Code. Lo comun esta en GUIDE_PANEL_CSS (guide-kit.js).
const TUNNEL_ENTRY_GUIDE_CSS = `
      .box.at-editor { left: 56px; bottom: 30px; width: min(680px, calc(100vw - 72px)); max-height: calc(100vh - 46px); }
      .box.at-github { top: 12px; left: 50%; transform: translateX(-50%); width: min(720px, calc(100vw - 24px)); max-height: calc(100vh - 24px); }
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
      .pill.at-editor { left: 56px; bottom: 30px; max-width: calc(100vw - 72px); }
      .pill.at-github { top: 12px; left: 50%; transform: translateX(-50%); }
      @media (max-width: 720px) {
        .box.at-editor { left: 8px; right: 8px; width: auto; max-height: calc(100vh - 44px); }
        .pill.at-editor { left: 8px; max-width: calc(100vw - 16px); }
      }`;

// Lista simple, sin pasos elegibles (aviso de GitHub).
function renderTunnelEntryGuideList(listEl, items) {
  for (const item of items || []) {
    const li = document.createElement("li");
    li.className = "plain";
    li.textContent = item;
    listEl?.appendChild(li);
  }
}

/**
 * El cuadro de la comprobacion de la extension de VS Code: `render(model)` lo muestra con su tono
 * (o lo oculta con null o «hidden»), el comando del docente con «Copiar comando», y cambia
 * «Ya entré» por «Listo» cuando la extension esta al dia.
 */
function bindVscodeExtensionCheckView(root, { doneButton }) {
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
    showText(commandEl, model.vmStartupCommand);
    if (copyEl) copyEl.hidden = !model.vmStartupCommand;
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
 * pastilla y no taparlo), setVscodeExtensionCheck(model) (comprobacion de la extension de VS
 * Code) y pointer (el anillo que mueve watchGuideScreen).
 */
function mountTunnelEntryGuide({ hostId, ariaLabel, intro, content, onDone, warning = "", placement }) {
  if (!TUNNEL_ENTRY_GUIDE_PLACEMENTS.includes(placement)) throw new TypeError(`Aviso del paso 4: placement desconocido (${placement}).`);
  if (content?.kind !== "steps" && content?.kind !== "list") throw new TypeError("Aviso del paso 4: content.kind debe ser steps o list.");
  document.getElementById(hostId)?.remove();
  const host = document.createElement("div");
  host.id = hostId;
  const root = host.attachShadow({ mode: "closed" });
  const at = placement === "editor" ? "at-editor" : "at-github";
  // Markup fijo; los textos entran con textContent.
  root.innerHTML = `
    <style>
      ${GUIDE_PANEL_CSS}
      ${TUNNEL_ENTRY_GUIDE_CSS}
      ${GUIDE_FOLD_CSS}
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
  const steps = content.kind === "steps" ? bindGuideSteps(listEl, content.steps, figures) : null;
  if (content.kind === "list") {
    renderTunnelEntryGuideList(listEl, content.items);
    figures.show(content.figure);
  }

  // Plegar y desplegar (a mano, o solo si taparia lo que hay que pulsar).
  const folding = createGuideFoldController({ box, pill, initiallyCollapsed: placement === "editor" && shouldStartGuideCollapsed() });
  wireGuideFold(folding, { minimizeButton: root.getElementById("adaceenTunnelSignInMinimize"), pill });
  root.getElementById("adaceenTunnelSignInClose")?.addEventListener("click", () => host.remove());
  doneButton?.addEventListener("click", () => {
    host.remove();
    if (typeof onDone === "function") onDone();
  });
  const checkView = bindVscodeExtensionCheckView(root, { doneButton });

  // Lo que hay en pantalla (lo pasa el vigilante): paso «Ahora», dibujo, pastilla y no taparlo.
  const setScreen = (entry = {}) => {
    steps?.markScreen(toText(entry.screen));
    if (pillAction) pillAction.textContent = toText(entry.label);
    folding.avoidCovering({ avoidArea: entry.avoidArea || null, target: entry.target || null });
  };

  document.documentElement.appendChild(host);
  return { host, controller: { setScreen, setVscodeExtensionCheck: checkView.render, pointer } };
}

function tunnelEntryAccountText(login) {
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
    { key: "authorize", screens: [], figure: "github-authorize", title: "Autoriza «Visual Studio Code» en GitHub", text: `En la página de GitHub que se abre, si pregunta con qué cuenta entrar, elige ${account}; después autoriza «Visual Studio Code». Que diga «Microsoft» es normal: Visual Studio Code es de Microsoft, pero entras con tu cuenta de GitHub.` },
    { key: "trust", screens: ["trust"], figure: "vscode-trust", title: "Confía en los autores de la carpeta", text: "Si VS Code pregunta si confías en los autores de los archivos, pulsa «Sí, confío en los autores» (Yes, I trust the authors): en modo restringido ADACEEN queda limitado." },
    { key: "files", screens: ["files"], figure: "vscode-files", title: "Ve tus archivos y pulsa «Ya entré»", text: "Vuelve a esta pestaña: en unos segundos aparecen los archivos de tu ejercicio. Entonces pulsa «Ya entré»." },
  ];
}

/**
 * Comprueba la extension ADACEEN de VS Code del editor mientras `isActive()`: pregunta al backend
 * cada VSCODE_EXTENSION_CHECK_POLL_MS y mira la barra de estado. `getFilesVisibleSince()` dice desde
 * cuando se ven los archivos (0 si todavia no). Deja de preguntar con un estado terminal («ok» u
 * «outdated»), si el backend no tiene la ruta o tras VSCODE_EXTENSION_CHECK_MAX_POLLS consultas. Con
 * «ok» llama `onOk` una vez.
 * `reevaluate()` rehace el modelo sin red (el vigilante lo llama en cada vistazo: depende del
 * tiempo y de la barra de estado); con un estado nuevo manda la telemetria y puede detener las consultas.
 */
function startVscodeExtensionCheck({ isActive, getFilesVisibleSince, onModel, onOk }) {
  let report = null;
  let unsupported = false;
  let stopped = false;
  let okNotified = false;
  let inFlight = false;
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
  // Telemetria: cada resultado nuevo que dice algo, a lo sumo VSCODE_EXTENSION_CHECK_EVENTS_MAX veces.
  const reportState = (model) => {
    if (!isReportableVscodeExtensionCheckState(model.state) || sentStates[sentStates.length - 1] === model.state) return;
    if (sentStates.length >= VSCODE_EXTENSION_CHECK_EVENTS_MAX) return;
    sentStates.push(model.state);
    trackTelemetryEvent("workflow", "tunnel_vscode_extension_checked", {
      value: model.state,
      pageContext: "vscode_tunnel",
      durationMs: Date.now() - startedAt,
      metadata: {
        vscodeExtensionVersion: report?.version || "",
        latestVscodeExtensionVersion: report?.latestVersion || "",
        resultIndex: sentStates.length,
      },
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
    // Una sola consulta a la vez: con el backend lento, una respuesta vieja no pisa a una nueva.
    if (inFlight) return;
    if (document.visibilityState !== "hidden") {
      // El tope cuenta desde que se ven los archivos (antes, el estudiante sigue entrando).
      if (filesVisibleSince() > 0) polls += 1;
      inFlight = true;
      let result;
      try {
        result = await fetchVscodeExtensionReport("tunnel");
      } finally {
        inFlight = false;
      }
      if (stopped) return;
      if (result.outcome === "ok") report = result.report;
      else if (result.outcome === "unsupported") unsupported = true;
      else if (result.outcome === "error") {
        // Un error de este codigo, no del backend: se dice en la consola y la comprobacion se oculta.
        console.warn(`[ADACEEN] La comprobación de la extensión de VS Code no se pudo hacer (${result.reason}).`);
        unsupported = true;
      }
      // "retry" (sin red): queda lo ultimo que se supo.
    }
    reevaluate();
    if (unsupported || polls >= VSCODE_EXTENSION_CHECK_MAX_POLLS) stop();
  };
  const timer = setInterval(() => {
    poll().catch(() => {});
  }, VSCODE_EXTENSION_CHECK_POLL_MS);
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
  const account = tunnelEntryAccountText(normalizeGithubLoginHint(hint.githubLogin));
  // Recien cambiada la cuenta de VS Code (0.8.5): el aviso lo dice y nombra la que se cerro.
  const brake = editorAccountSwitchBrake(await readRecentEditorAccountSwitch(tunnelName));
  const switched = brake.switchedRecently;
  const closed = brake.closedLabelsText;
  const { host, controller } = mountTunnelEntryGuide({
    hostId: TUNNEL_ENTRY_GUIDE_HOST_ID,
    ariaLabel: "ADACEEN: como entrar a tu editor",
    intro: switched
      ? `Ya cerraste en VS Code ${closed ? `la sesión de ${closed}` : "la sesión de la otra cuenta"}. Ahora entra con ${account}: cuando GitHub pregunte con qué cuenta, elige esa.`
      : "Último paso, solo la primera vez: VS Code tiene que confirmar que tu cuenta de GitHub puede entrar a tu editor.",
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
      // (sin red; al backend se pregunta cada VSCODE_EXTENSION_CHECK_POLL_MS).
      check?.reevaluate();
    },
  });
  check = startVscodeExtensionCheck({
    isActive,
    getFilesVisibleSince: () => filesVisibleSince,
    onModel: controller.setVscodeExtensionCheck,
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

// Las paginas de GitHub que abre VS Code para autorizar «Visual Studio Code» (redirect_uri de
// vscode.dev): la de autorizar, su selector de cuentas (0.8.5) o su inicio de sesion previo; en
// todas va el mismo paso 4 con la cuenta correcta (showVscodeGithubAuthorizeHelper). Devuelve la URL
// del OAuth (la de return_to si es el inicio de sesion) o null.
function parseVscodeGithubOAuthUrl(href = location.href) {
  try {
    const url = new URL(toText(href));
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return null;
    const path = url.pathname.toLowerCase();
    let oauth = url;
    if (!path.startsWith("/login/oauth/")) {
      const returnTo = toText(url.searchParams.get("return_to"));
      if (!returnTo) return null;
      oauth = new URL(returnTo, "https://github.com");
      if (oauth.hostname.toLowerCase() !== "github.com") return null;
    }
    if (!oauth.pathname.toLowerCase().startsWith("/login/oauth/")) return null;
    const redirectUri = toText(oauth.searchParams.get("redirect_uri"));
    if (!redirectUri) return null;
    const host = new URL(redirectUri).hostname.toLowerCase();
    return host === "vscode.dev" || host.endsWith(".vscode.dev") || host.includes("vscode-redirect") ? oauth : null;
  } catch {
    return null;
  }
}

// Cualquiera de esas paginas (autorizar, selector de cuentas o inicio de sesion previo).
function isVscodeGithubAuthorizePage(href = location.href) {
  return Boolean(parseVscodeGithubOAuthUrl(href));
}

// ---- Selector de cuentas de GitHub (0.8.5; funciones puras sobre un documento) ----

// «Use a different account», «Sign in to another account», «Add account»...
const GITHUB_OTHER_ACCOUNT_PATTERN = /(different|another|other) account|add (an )?account|otra cuenta|agregar (una )?cuenta/i;

// ¿El texto menciona ese login de GitHub como palabra completa? (los logins llevan letras, numeros y guiones)
function textMentionsGithubLogin(text, login) {
  const want = toText(login).toLowerCase();
  if (!want) return false;
  return toText(text).toLowerCase().split(/[^a-z0-9-]+/).includes(want);
}

// ¿Este boton es el de ese login? El login y el nombre suelen ir en elementos pegados (sin espacio en
// textContent): se mira el texto como se ve (innerText) y el de cada elemento de adentro.
function nodeMentionsGithubLogin(node, login) {
  const texts = [node?.innerText, node?.textContent, node?.getAttribute?.("aria-label"), node?.value];
  for (const child of Array.from(node?.querySelectorAll?.("*") || [])) texts.push(child?.textContent);
  return texts.some((text) => textMentionsGithubLogin(text, login));
}

// Sin selector de cuentas en pantalla.
const NO_GITHUB_ACCOUNT_PICKER = Object.freeze({ isAccountPicker: false, isEditorAccountListed: false, target: null, label: "" });

/**
 * El selector de cuentas de GitHub (VS Code lo pide con prompt=select_account cuando no tiene una
 * cuenta con la cual entrar). Siempre devuelve un objeto (NO_GITHUB_ACCOUNT_PICKER si no es esa
 * pantalla): `isAccountPicker` (la URL del OAuth lo pide y no hay boton verde de autorizar),
 * `target` (la cuenta del editor si aparece y, si no, «usar otra cuenta»), `label` (lo que dice el
 * anillo) e `isEditorAccountListed`.
 */
function detectGithubAccountPicker(doc = document, { editorLogin = "", href = location.href } = {}) {
  const oauth = parseVscodeGithubOAuthUrl(href);
  const asked = Boolean(oauth) && (/select_account/i.test(oauth.pathname) || toText(oauth.searchParams.get("prompt")).toLowerCase() === "select_account");
  if (!asked || findGithubGuideButton(doc, "authorize")) return NO_GITHUB_ACCOUNT_PICKER;
  const clickables = Array.from(doc?.querySelectorAll?.('button, a[href], [role="button"], input[type="submit"]') || []).filter(isGuideNodeVisible);
  const mine = editorLogin ? clickables.find((node) => nodeMentionsGithubLogin(node, editorLogin)) : null;
  if (mine) return { isAccountPicker: true, isEditorAccountListed: true, target: mine, label: `Elige «${editorLogin}»` };
  const other = clickables.find((node) => GITHUB_OTHER_ACCOUNT_PATTERN.test(guideNodeText(node))) || null;
  return { isAccountPicker: true, isEditorAccountListed: false, target: other, label: other ? `Pulsa «${guideNodeText(other)}»` : "" };
}

/**
 * Lo que dice el aviso de GitHub en el selector de cuentas (0.8.5). Advierte no elegir la cuenta
 * abierta en GitHub (`signedInLogin`) ni las de GitHub que se cerraron en VS Code (`signedOutLogins`),
 * salvo la del editor.
 */
function githubAccountPickerCopy({ editorLogin = "", isEditorAccountListed = false, signedInLogin = "", signedOutLogins = [] } = {}) {
  const mine = editorLogin ? `«${editorLogin}»` : "la cuenta de tu editor";
  const avoid = [...new Set([signedInLogin, ...signedOutLogins].map(toText).filter((name) => name && name.toLowerCase() !== toText(editorLogin).toLowerCase()))];
  return {
    intro: `GitHub pregunta con qué cuenta entrar a VS Code. Elige ${mine}: es la de tu editor.`,
    items: [
      isEditorAccountListed ? `Elige ${mine} en la lista.` : `${mine} no está en la lista: pulsa «Use a different account» (usar otra cuenta) y entra con ella.`,
      "Después pulsa el botón verde para autorizar «Visual Studio Code». Que diga «Microsoft» es normal: es quien hace VS Code.",
      "GitHub te devuelve solo a tu editor.",
    ],
    warning: avoid.length ? `No elijas ${avoid.map((name) => `«${name}»`).join(" ni ")}: con esa cuenta tu editor no aparece.` : "",
  };
}

async function showVscodeGithubAuthorizeHelper() {
  if (!isVscodeGithubAuthorizePage()) return false;
  const hint = await readTunnelSignInHint();
  if (!hint) return false;
  const expected = normalizeGithubLoginHint(hint.githubLogin);
  const account = tunnelEntryAccountText(expected);
  const signIn = !/^\/login\/oauth\//i.test(location.pathname);
  // 0.8.1: con otra cuenta abierta en GitHub, VS Code entraria con esa y no encontraria el editor.
  const signedIn = signIn ? "" : readGithubSignedInLogin();
  // 0.8.5: el selector de cuentas de GitHub (despues de cerrar la otra cuenta en VS Code).
  const picker = signIn ? NO_GITHUB_ACCOUNT_PICKER : detectGithubAccountPicker(document, { editorLogin: expected });
  if (picker.isAccountPicker) {
    const brake = editorAccountSwitchBrake(await readRecentEditorAccountSwitch(toText(hint.tunnelName)));
    const copy = githubAccountPickerCopy({
      editorLogin: expected,
      isEditorAccountListed: picker.isEditorAccountListed,
      signedInLogin: signedIn,
      signedOutLogins: brake.closedGithubLogins,
    });
    const { host, controller } = mountTunnelEntryGuide({
      warning: copy.warning,
      hostId: TUNNEL_ENTRY_GUIDE_GITHUB_HOST_ID,
      ariaLabel: "ADACEEN: elige tu cuenta de GitHub",
      intro: copy.intro,
      content: { kind: "list", items: copy.items, figure: "github-select-account" },
      placement: "github",
      onDone: () => {
        clearTunnelSignInHint().catch(() => {});
      },
    });
    watchGuideScreen({
      pointer: controller.pointer,
      isActive: () => host.isConnected,
      locate: () => {
        const current = detectGithubAccountPicker(document, { editorLogin: expected });
        return { target: current.target, label: current.label };
      },
      onScreen: controller.setScreen,
    });
    return true;
  }
  const warning = expected && signedIn && signedIn !== expected
    ? `Estás en GitHub como «${signedIn}», pero tu editor es de «${expected}». No autorices con esta cuenta: cambia de cuenta (tu foto, arriba a la derecha) y vuelve a entrar a tu editor.`
    : "";
  const { host, controller } = mountTunnelEntryGuide({
    warning,
    hostId: TUNNEL_ENTRY_GUIDE_GITHUB_HOST_ID,
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
      locate: () => ({ target: findGithubGuideButton(document, "authorize"), label: GITHUB_GUIDE_BUTTONS.authorize.label }),
      onScreen: controller.setScreen,
    });
  }
  return true;
}
