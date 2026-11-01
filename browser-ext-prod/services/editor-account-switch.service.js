// Cambiar la cuenta de GitHub dentro de VS Code cuando vscode.dev no encuentra el editor (0.8.5).
//
// Por que: el tunel se encuentra solo con la cuenta de GitHub que autorizo el codigo, y vscode.dev
// guarda su propia sesion de GitHub. Si esa sesion es de otra cuenta, «Elegir otra cuenta» de
// vscode.dev vuelve a pedirla con la misma cuenta (VS Code manda login=<esa cuenta> a GitHub) y se
// cae en un bucle. Cerrar esa sesion dentro de VS Code (Cuentas → «<cuenta> (GitHub)» → «Cerrar
// sesión») hace que la proxima entrada pase por el selector de cuentas de GitHub
// (prompt=select_account), donde se elige la del editor.
//
// «Cambiar a <cuenta>» (aviso de workspace.service.js) lo hace asi:
//   1. cierra el dialogo de vscode.dev («Cancelar»): mientras este abierto, VS Code no muestra la
//      confirmacion de cerrar sesion;
//   2. abre el menu de cuentas de VS Code y, en cada cuenta que no es la del editor (GitHub o
//      Microsoft), pulsa «Cerrar sesión» y la confirmacion;
//   3. deja el paso 4 con la cuenta correcta y recarga: VS Code pide entrar y GitHub muestra su
//      selector de cuentas (tunnel-entry-guide.service.js acompana esa pagina).
// ADACEEN pulsa los botones reales de VS Code con los mismos eventos que el mouse; el anillo marca
// cada uno un momento antes. Si un boton no aparece o no responde, se detiene ahi y lo pide al
// estudiante (el anillo sigue en el boton real, como en el paso 4). Si VS Code no tiene una cuenta
// que cerrar (o esconde el icono de cuentas), borra la sesion guardada de vscode.dev (0.8.2).
// Freno contra el bucle: cada cambio queda guardado por usuario y tunel; si el editor sigue sin
// aparecer despues de EDITOR_ACCOUNT_SWITCH_MAX_ATTEMPTS cambios, el aviso pasa a «Reconectar».
//
// Partes del archivo: lo que hay en pantalla (puro), la decision de cada vistazo (pura:
// stepEditorAccountSwitch), pulsar (eventos), el aviso (vista) y el bucle que las une
// (startEditorAccountSwitch).
//
// Eventos de VS Code (leidos de su codigo, 1.143): el boton de cuentas abre el menu con mousedown;
// cada opcion del menu responde a mouseup (desde 100 ms despues de dibujarse) y una cuenta abre su
// submenu igual; los botones de los dialogos responden a click. El menu de cuentas no va en un
// shadow root.
//
// Depende de (cargan antes): editor-account-switch-record.js (el freno y como se nombran las
// cuentas), guide-kit.js (caja y pasos de los avisos, anillo y plegado), guide-illustrations.js (dibujos),
// workspace.service.js (saveTunnelSignInHint, isTunnelNotFoundText), tunnel-entry-guide.service.js
// (isVscodeSignInDialogText: el dialogo que pide iniciar sesion), telemetry.service.js
// (trackTelemetryEvent) y el mensaje ADACEEN_RESET_VSCODE_SESSION de background.js. Solo lo llama el
// boton del aviso de workspace.service.js, que funciona sin este archivo (dice que hacer a mano).

// ---- Borrar la sesion guardada de vscode.dev (0.8.2; respaldo sin cuenta que cerrar) ----

// Lo que la pagina puede borrar de su propio origen (si el background no pudo): almacenamiento,
// bases IndexedDB y caches de vscode.dev. Las cookies quedan; por eso el camino normal es el
// background (browsingData).
async function clearVscodeWebStorageFromPage() {
  try {
    localStorage.clear();
  } catch {}
  try {
    sessionStorage.clear();
  } catch {}
  if (typeof indexedDB !== "undefined" && typeof indexedDB.databases === "function") {
    const databases = await indexedDB.databases();
    await Promise.all(databases.map((database) => new Promise((resolve) => {
      if (!database?.name) {
        resolve();
        return;
      }
      const request = indexedDB.deleteDatabase(database.name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      // Abierta por VS Code: se borra al recargar.
      request.onblocked = () => resolve();
    })));
  }
  if (typeof caches !== "undefined" && typeof caches.keys === "function") {
    for (const key of await caches.keys()) await caches.delete(key);
  }
}

/**
 * Borra los datos de vscode.dev de este navegador (el background, con browsingData) y vuelve a abrir
 * el editor; si el background no puede, borra desde la pagina y recarga. { ok: true } o
 * { ok: false, manualStepsText } con como hacerlo a mano.
 */
async function resetVscodeWebSession() {
  let response = null;
  try {
    response = await chrome.runtime.sendMessage({ type: "ADACEEN_RESET_VSCODE_SESSION", origin: location.origin, url: location.href });
  } catch {
    response = null;
  }
  if (response?.ok) return { ok: true };
  if (!response) {
    // La pestana pudo empezar a irse antes de la respuesta: si sigue aqui, se intenta desde la pagina.
    await new Promise((resolve) => window.setTimeout(resolve, VSCODE_SESSION_RESET_FALLBACK_MS));
  }
  try {
    await clearVscodeWebStorageFromPage();
    window.setTimeout(() => location.reload(), 300);
    return { ok: true };
  } catch {
    return { ok: false, manualStepsText: VSCODE_SESSION_RESET_MANUAL_TEXT };
  }
}

// ---- Pulsar los botones de VS Code ----

// Un evento de mouse en el centro del nodo, que sube por los padres como uno real. true si se mando
// (no dice si VS Code reacciono: eso lo dice la pantalla siguiente).
function dispatchMouseEventAtCenter(node, type) {
  if (!node || typeof node.dispatchEvent !== "function" || typeof MouseEvent !== "function") return false;
  const rect = guideRectOf(node);
  node.dispatchEvent(new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    buttons: type === "mousedown" ? 1 : 0,
    detail: 1,
    clientX: rect ? Math.round(rect.left + rect.width / 2) : 0,
    clientY: rect ? Math.round(rect.top + rect.height / 2) : 0,
  }));
  return true;
}

// Como el mouse (EDITOR_ACCOUNT_SWITCH_SCREEN_ACTIONS): el boton de cuentas abre con mousedown y las
// opciones del menu con mouseup (se mandan los dos); los botones de un dialogo, con click. true si
// se mandaron los eventos.
function pressEditorAccountSwitchTarget(switchScreen) {
  const target = switchScreen?.target;
  const { press } = editorAccountSwitchScreenAction(switchScreen?.screen);
  if (!target || !press) return false;
  if (press === "mouse") {
    const down = dispatchMouseEventAtCenter(target, "mousedown");
    const up = dispatchMouseEventAtCenter(target, "mouseup");
    return down && up;
  }
  if (typeof target.click !== "function") return false;
  target.click();
  return true;
}

// ---- El aviso ----

// Mientras ADACEEN pulsa, el aviso es angosto y sin dibujo (arriba a la derecha no tapa el dialogo
// de VS Code, que va arriba al centro); si lo tiene que hacer el estudiante, se ensancha con el dibujo.
const EDITOR_ACCOUNT_SWITCH_CSS = `
      .box.at-switch { top: 12px; right: 12px; width: min(400px, calc(100vw - 24px)); max-height: calc(100vh - 24px); }
      .box.at-switch.is-guided { width: min(640px, calc(100vw - 24px)); }
      .box.at-switch:not(.is-guided) .layout { grid-template-columns: minmax(0, 1fr); }
      .box.at-switch:not(.is-guided) .guide-figure { display: none; }
      .pill.at-switch { top: 12px; right: 12px; }
      .title { display: block; color: #ffe2a3; font-size: 15px; font-weight: 800; line-height: 1.3; }
      .status { margin: 0; padding: 8px 10px; border-radius: 8px; background: #0b1a24; color: #9ff0c6; border: 1px solid rgba(159, 240, 198, 0.35); }
      .status.is-warn { background: #3b2a06; color: #ffe2a3; border-color: #c99a2e; }
      .status.is-error { background: #3a1410; color: #ffb4a8; border-color: #c0574a; }
      .actions { flex-wrap: wrap; }
      .actions button[hidden] { display: none; }
      button.secondary { padding: 7px 12px; font-weight: 700; background: transparent; color: #ffe2a3; border: 1px solid #c99a2e; }`;

/**
 * Monta el aviso del cambio de cuenta (arriba a la derecha: el menu de cuentas sale abajo a la
 * izquierda y la confirmacion arriba al centro). Devuelve { host, view } con:
 *   showScreen(switchScreen, { pressedByAdaceen })  «Ahora», dibujo, anillo y no tapar la pantalla
 *   setStatus(text, tone)   la linea de estado (EDITOR_ACCOUNT_SWITCH_STATUS_TONES)
 *   switchToGuidedMode()    ensancha el aviso con el dibujo, muestra «Ya cerré la sesión» y «Borrar
 *                           la sesión de vscode.dev» y lo despliega
 *   setBusy(isBusy)         deshabilita esos dos botones
 *   markDone()              marca el ultimo paso
 *   hidePointer()
 */
function mountEditorAccountSwitchPanel({ editorLogin, onFinish, onReset, onCancel }) {
  document.getElementById(EDITOR_ACCOUNT_SWITCH_HOST_ID)?.remove();
  const host = document.createElement("div");
  host.id = EDITOR_ACCOUNT_SWITCH_HOST_ID;
  const root = host.attachShadow({ mode: "closed" });
  // Markup fijo; los textos entran con textContent.
  root.innerHTML = `
    <style>
      ${GUIDE_PANEL_CSS}
      ${GUIDE_FOLD_CSS}
      ${GUIDE_FIGURES_CSS}
      ${GUIDE_POINTER_CSS}
      ${EDITOR_ACCOUNT_SWITCH_CSS}
    </style>
    <aside class="box at-switch" id="adaceenSwitchBox" role="region" aria-label="ADACEEN: cambiar la cuenta de tu editor">
      <div class="head">
        <strong class="title">ADACEEN · Cambiar la cuenta de tu editor</strong>
        <div class="head-actions">
          <button type="button" class="icon" id="adaceenSwitchMinimize" aria-label="Plegar el aviso" title="Plegar">&#8211;</button>
        </div>
      </div>
      <p id="adaceenSwitchText"></p>
      <div class="layout">
        <ol class="todo" id="adaceenSwitchSteps"></ol>
        ${guideFigureSlotMarkup()}
      </div>
      <p class="status" id="adaceenSwitchStatus" role="status" aria-live="polite"></p>
      <div class="actions">
        <button type="button" class="done" id="adaceenSwitchFinish" hidden>Ya cerré la sesión</button>
        <button type="button" class="secondary" id="adaceenSwitchReset" hidden>Borrar la sesión de vscode.dev</button>
        <button type="button" class="secondary" id="adaceenSwitchCancel">Cancelar</button>
      </div>
    </aside>
    <button type="button" class="pill at-switch" id="adaceenSwitchPill" aria-label="Abrir el aviso de ADACEEN" hidden>
      <span>ADACEEN · Cambiar de cuenta</span><span class="pill-action" id="adaceenSwitchPillAction"></span>
    </button>
    ${guidePointerMarkup()}
    ${guideLightboxMarkup()}`;
  const box = root.getElementById("adaceenSwitchBox");
  const pill = root.getElementById("adaceenSwitchPill");
  const pillAction = root.getElementById("adaceenSwitchPillAction");
  const textEl = root.getElementById("adaceenSwitchText");
  const statusEl = root.getElementById("adaceenSwitchStatus");
  const finishButton = root.getElementById("adaceenSwitchFinish");
  const resetButton = root.getElementById("adaceenSwitchReset");
  const cancelButton = root.getElementById("adaceenSwitchCancel");
  if (textEl) {
    textEl.textContent = editorLogin
      ? `Tu editor es de «${editorLogin}», pero VS Code entró con otra cuenta. ADACEEN cierra en VS Code la sesión de esa otra cuenta y después entras con «${editorLogin}». Tus archivos no se tocan.`
      : "VS Code entró con otra cuenta de GitHub. ADACEEN cierra esa sesión en VS Code y después entras con la de tu editor. Tus archivos no se tocan.";
  }
  const figures = bindGuideFigures(root);
  const pointer = bindGuidePointer(root);
  const steps = bindGuideSteps(root.getElementById("adaceenSwitchSteps"), editorAccountSwitchSteps(editorLogin), figures);
  const folding = createGuideFoldController({ box, pill });
  wireGuideFold(folding, { minimizeButton: root.getElementById("adaceenSwitchMinimize"), pill });
  finishButton?.addEventListener("click", () => onFinish?.());
  resetButton?.addEventListener("click", () => onReset?.());
  cancelButton?.addEventListener("click", () => onCancel?.());

  const TONES = EDITOR_ACCOUNT_SWITCH_STATUS_TONES;
  const view = {
    showScreen(switchScreen = {}, { pressedByAdaceen = false } = {}) {
      steps.markScreen(toText(switchScreen.screen));
      const label = editorAccountSwitchPointerLabel(switchScreen, { pressedByAdaceen });
      if (pillAction) pillAction.textContent = label;
      const target = switchScreen.target && isGuideNodeVisible(switchScreen.target) ? switchScreen.target : null;
      if (target) pointer.place(guideRectOf(target), label);
      else pointer.hide();
      folding.avoidCovering({ avoidArea: switchScreen.avoidArea || null, target });
    },
    setStatus(text, tone = TONES.OK) {
      if (!statusEl) return;
      statusEl.textContent = text;
      statusEl.hidden = !text;
      statusEl.className = tone === TONES.WARN ? "status is-warn" : tone === TONES.ERROR ? "status is-error" : "status";
    },
    switchToGuidedMode() {
      if (finishButton) finishButton.hidden = false;
      if (resetButton) resetButton.hidden = false;
      box?.classList?.add("is-guided");
      // Hay algo nuevo que leer: se despliega (si tapa el boton, se vuelve a plegar solo).
      folding.expandForNewContent();
    },
    setBusy(isBusy) {
      for (const button of [finishButton, resetButton]) if (button) button.disabled = !!isBusy;
    },
    markDone() {
      steps.markScreen(EDITOR_ACCOUNT_SWITCH_DONE_STEP);
    },
    hidePointer() {
      pointer.hide();
    },
  };
  document.documentElement.appendChild(host);
  return { host, view };
}

// ---- El cambio de cuenta ----

// Lo que dice el aviso al pedirselo al estudiante (la accion «guided» de stepEditorAccountSwitch).
function editorAccountSwitchGuidedText({ reason, screen, login = "" }) {
  const R = EDITOR_ACCOUNT_SWITCH_GUIDED_REASONS;
  const after = "Cuando cierres la sesión, ADACEEN sigue solo.";
  if (reason === R.UNKNOWN_DIALOG) return `VS Code muestra otro aviso: léelo y ciérralo tú (ADACEEN no lo toca). Después sigue el anillo. ${after}`;
  if (reason === R.NO_CANCEL) return `Este aviso de VS Code no tiene «Cancelar»: ciérralo tú. Después sigue el anillo. ${after}`;
  if (reason === R.TIME_LIMIT) return `Esto está tardando: sigue tú desde aquí, el anillo te marca qué pulsar. ${after}`;
  if (reason === R.SIGNOUT_REFUSED) return `VS Code no cerró la sesión de ${login ? `«${login}»` : "esa cuenta"} cuando ADACEEN lo confirmó: hazlo tú (el anillo te lo marca). ${after}`;
  return `No pude pulsar ${editorAccountSwitchScreenAction(screen).guidedWhat} por ti. Púlsalo tú: el anillo te lo marca. ${after}`;
}

// Lo que dice el aviso al terminar (outcome y stage de stepEditorAccountSwitch).
function editorAccountSwitchFinishText({ outcome, stage, closedLabels = [], editorLogin = "" }) {
  if (outcome === EDITOR_ACCOUNT_SWITCH_OUTCOMES.SIGNED_OUT) {
    const who = closedLabels.length ? `la sesión de ${formatClosedAccountsList(closedLabels)}` : "la sesión de la otra cuenta";
    return `Listo: cerraste en VS Code ${who}. La página se recarga; cuando VS Code lo pida, entra con ${editorLogin ? `«${editorLogin}»` : "la cuenta de tu editor"}.`;
  }
  return stage === EDITOR_ACCOUNT_SWITCH_STAGES.NO_ACCOUNT
    ? "VS Code no tiene otra cuenta abierta: ADACEEN borra la sesión que vscode.dev guarda en este navegador y recarga la página."
    : "Borrando la sesión que vscode.dev guarda en este navegador; la página se recarga sola.";
}

/**
 * «Cambiar a <cuenta>»: monta el aviso y cierra en VS Code la sesion de las otras cuentas (ver el
 * comienzo del archivo). `editorLogin`: la cuenta del editor (no se cierra); `attempt`: el numero
 * de este cambio para el freno (1 la primera vez). Devuelve { cancel }, lo mismo que «Cancelar».
 */
function startEditorAccountSwitch({ editorLogin = "", tunnelName = "", attempt = 1 } = {}) {
  const O = EDITOR_ACCOUNT_SWITCH_OUTCOMES;
  const startedAt = Date.now();
  let run = createEditorAccountSwitchRun(startedAt);
  let finished = false;
  let timer = 0;
  let hiddenSince = 0;
  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = 0;
  };
  const closedLabels = () => run.signedOut.filter((accountRef) => accountRef.login).map(formatVscodeAccountLabel);
  // retry: el numero de este intento (1 el primero), como lo pide el catalogo de la telemetria.
  const report = (outcome, stage) => {
    trackTelemetryEvent("workflow", "tunnel_editor_account_switch", {
      value: outcome,
      pageContext: "vscode_tunnel",
      durationMs: Date.now() - startedAt,
      metadata: { stage, mode: run.mode, retry: attempt, signedOutCount: run.signedOut.length },
    });
  };
  const stageNow = () => editorAccountSwitchStageOfScreen(run.lastScreen);

  const cancel = () => {
    if (finished) return;
    finished = true;
    stopTimer();
    report(O.CANCELLED, stageNow());
    host.remove();
  };
  const { host, view } = mountEditorAccountSwitchPanel({
    editorLogin,
    onFinish: () => finish(O.SIGNED_OUT, EDITOR_ACCOUNT_SWITCH_STAGES.GUIDED_CONFIRMED),
    onReset: () => finish(O.RESET, EDITOR_ACCOUNT_SWITCH_STAGES.GUIDED_RESET),
    onCancel: cancel,
  });

  async function finish(outcome, stage) {
    if (finished) return;
    finished = true;
    stopTimer();
    view.hidePointer();
    view.setBusy(true);
    view.markDone();
    report(outcome, stage);
    await saveEditorAccountSwitch(tunnelName, { attempts: attempt, signedOut: run.signedOut, outcome });
    // El paso 4 con la cuenta del editor, en vscode.dev y en la pagina de GitHub.
    await saveTunnelSignInHint(location.href, editorLogin).catch(() => false);
    view.setStatus(editorAccountSwitchFinishText({ outcome, stage, closedLabels: closedLabels(), editorLogin }));
    if (outcome === O.SIGNED_OUT) {
      window.setTimeout(() => location.reload(), EDITOR_ACCOUNT_SWITCH_RELOAD_MS);
      return;
    }
    // Sin cuenta que cerrar (o a pedido): se borra la sesion que vscode.dev guarda.
    const result = await resetVscodeWebSession();
    if (!result.ok) view.setStatus(result.manualStepsText, EDITOR_ACCOUNT_SWITCH_STATUS_TONES.ERROR);
  }

  function switchToGuided(action) {
    view.setStatus(editorAccountSwitchGuidedText(action), EDITOR_ACCOUNT_SWITCH_STATUS_TONES.WARN);
    view.switchToGuidedMode();
  }

  // Aplica lo que decidio stepEditorAccountSwitch (o markEditorAccountSwitchPressFailed).
  function apply(step, switchScreen, wasAuto) {
    run = step.run;
    view.showScreen(switchScreen, { pressedByAdaceen: step.pressedByAdaceen });
    const { action } = step;
    if (action.type === "finish") {
      finish(action.outcome, action.stage);
      return;
    }
    if (action.type === "guided") {
      if (wasAuto) switchToGuided(action);
      return;
    }
    if (action.type === "ask_confirm") {
      view.setStatus("No pude comprobar si se cerró la sesión. Si pulsaste «Cerrar sesión» en VS Code, pulsa «Ya cerré la sesión»; si no, púlsalo (el anillo te lo marca).", EDITOR_ACCOUNT_SWITCH_STATUS_TONES.WARN);
      return;
    }
    if (action.type === "press" && !pressEditorAccountSwitchTarget(switchScreen)) {
      apply(markEditorAccountSwitchPressFailed(run, switchScreen), switchScreen, run.mode === EDITOR_ACCOUNT_SWITCH_MODES.AUTO);
    }
  }

  function tick() {
    if (finished || !host.isConnected) {
      stopTimer();
      return;
    }
    const now = Date.now();
    // Con la pestana oculta no se pulsa nada y el tiempo no corre.
    if (document.visibilityState === "hidden") {
      if (!hiddenSince) hiddenSince = now;
      return;
    }
    if (hiddenSince) {
      run = shiftEditorAccountSwitchRun(run, now - hiddenSince);
      hiddenSince = 0;
    }
    let switchScreen;
    try {
      switchScreen = detectEditorAccountSwitchScreen(document, {
        keepLogin: editorLogin,
        alreadySignedOutKeys: run.signedOut.map(vscodeAccountKey),
      });
    } catch (error) {
      console.warn(`[ADACEEN] No se pudo leer la pantalla de VS Code (${error?.message || error}).`);
      return;
    }
    const wasAuto = run.mode === EDITOR_ACCOUNT_SWITCH_MODES.AUTO;
    apply(stepEditorAccountSwitch(run, switchScreen, now), switchScreen, wasAuto);
  }

  view.setStatus("ADACEEN lo está haciendo por ti: mira el anillo. No hace falta tocar nada.");
  timer = setInterval(tick, EDITOR_ACCOUNT_SWITCH_TICK_MS);
  tick();
  return { cancel };
}
