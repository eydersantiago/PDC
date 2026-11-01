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
