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

const EDITOR_ACCOUNT_SWITCH_HOST_ID = "adaceen-editor-account-switch";
const EDITOR_ACCOUNT_SWITCH_TICK_MS = 250;
// El anillo se ve en el boton este tiempo antes de que ADACEEN lo pulse (y el menu ya responde).
const EDITOR_ACCOUNT_SWITCH_DWELL_MS = 450;
// Despues de pulsar, lo que se espera a que cambie la pantalla; dos intentos por pantalla.
const EDITOR_ACCOUNT_SWITCH_STEP_WAIT_MS = 2500;
const EDITOR_ACCOUNT_SWITCH_PRESS_TRIES = 2;
// El menu abierto sin cuentas que cerrar (o sin icono de cuentas) durante esto: no hay que cerrar nada.
const EDITOR_ACCOUNT_SWITCH_EMPTY_WAIT_MS = 3000;
// Un menu con cuentas, pero ninguna para cerrar: se mira este tiempo (por si aun carga).
const EDITOR_ACCOUNT_SWITCH_MENU_SETTLE_MS = 700;
const EDITOR_ACCOUNT_SWITCH_MAX_SIGNOUTS = 3;
const EDITOR_ACCOUNT_SWITCH_MAX_DIALOG_CANCELS = 3;
// Veces que ADACEEN confirma «Cerrar sesión» de una misma cuenta antes de pedirlo al estudiante.
const EDITOR_ACCOUNT_SWITCH_MAX_SIGNOUT_TRIES = 2;
// Tras la confirmacion: lo que se espera para comprobar que la cuenta ya no esta (menu de cuentas o
// VS Code pidiendo entrar de nuevo).
const EDITOR_ACCOUNT_SWITCH_VERIFY_MS = 4000;
// Tope de lo automatico: despues, lo que falte se pide al estudiante.
const EDITOR_ACCOUNT_SWITCH_AUTO_LIMIT_MS = 60 * 1000;
// Tras cerrar la sesion: el aviso dice lo que sigue y la pagina se recarga.
const EDITOR_ACCOUNT_SWITCH_RELOAD_MS = 2500;
// Borrar la sesion de vscode.dev (0.8.2): sin respuesta del background (la pestana ya se esta
// yendo), si sigue aqui despues de esto, se borra desde la pagina.
const VSCODE_SESSION_RESET_FALLBACK_MS = 2000;
const VSCODE_SESSION_RESET_MANUAL_TEXT = "No se pudo borrar la sesión de vscode.dev desde ADACEEN. Hazlo a mano: ícono a la izquierda de la dirección → «Cookies y datos de sitios» → «Administrar datos en el dispositivo» → borra vscode.dev y recarga la página.";

/** @typedef {"dialog" | "confirm" | "submenu" | "menu" | "accounts" | ""} EditorAccountSwitchScreenKind */

// Pantallas de VS Code durante el cambio ("" = no se ve el boton de cuentas).
const EDITOR_ACCOUNT_SWITCH_SCREENS = Object.freeze({
  DIALOG: "dialog",
  CONFIRM: "confirm",
  SUBMENU: "submenu",
  MENU: "menu",
  ACCOUNTS: "accounts",
  NONE: "",
});
// Que se hace en cada pantalla: como se pulsa (como el mouse: mousedown y mouseup; o click) y que
// dice el aviso si ADACEEN no pudo pulsarlo.
const EDITOR_ACCOUNT_SWITCH_SCREEN_ACTIONS = Object.freeze({
  [EDITOR_ACCOUNT_SWITCH_SCREENS.DIALOG]: { press: "click", guidedWhat: "«Cancelar» en el aviso de VS Code" },
  [EDITOR_ACCOUNT_SWITCH_SCREENS.CONFIRM]: { press: "click", guidedWhat: "«Cerrar sesión»" },
  [EDITOR_ACCOUNT_SWITCH_SCREENS.SUBMENU]: { press: "mouse", guidedWhat: "«Cerrar sesión»" },
  [EDITOR_ACCOUNT_SWITCH_SCREENS.MENU]: { press: "mouse", guidedWhat: "la otra cuenta en el menú" },
  [EDITOR_ACCOUNT_SWITCH_SCREENS.ACCOUNTS]: { press: "mouse", guidedWhat: "el ícono de cuentas" },
  [EDITOR_ACCOUNT_SWITCH_SCREENS.NONE]: { press: "", guidedWhat: "el ícono de cuentas de VS Code" },
});

function editorAccountSwitchScreenAction(screenKind) {
  return EDITOR_ACCOUNT_SWITCH_SCREEN_ACTIONS[toText(screenKind)] || EDITOR_ACCOUNT_SWITCH_SCREEN_ACTIONS[EDITOR_ACCOUNT_SWITCH_SCREENS.NONE];
}

// Pseudo-pantalla del ultimo paso del aviso (entrar con la cuenta del editor): no es de VS Code.
const EDITOR_ACCOUNT_SWITCH_DONE_STEP = "done";

// Que dialogo de VS Code es: el del tunel que no se encuentra, uno que pide iniciar sesion (los dos
// se pueden cancelar: despues se recarga) u otro (no se toca: lo cierra el estudiante).
const EDITOR_ACCOUNT_SWITCH_DIALOG_KINDS = Object.freeze({ TUNNEL: "tunnel", SIGN_IN: "sign_in", OTHER: "other" });

// Quien pulsa: ADACEEN o el estudiante (metadata.mode de la telemetria).
const EDITOR_ACCOUNT_SWITCH_MODES = Object.freeze({ AUTO: "auto", GUIDED: "guided" });

// Por que se le pide al estudiante (la accion «guided» de stepEditorAccountSwitch).
const EDITOR_ACCOUNT_SWITCH_GUIDED_REASONS = Object.freeze({
  NO_RESPONSE: "no_response",
  UNKNOWN_DIALOG: "unknown_dialog",
  NO_CANCEL: "no_cancel",
  TIME_LIMIT: "time_limit",
  SIGNOUT_REFUSED: "signout_refused",
});

// Donde termino (metadata.stage de la telemetria): la pantalla de VS Code en ese momento o el motivo.
const EDITOR_ACCOUNT_SWITCH_STAGES = Object.freeze({
  DIALOG: "dialog",
  CONFIRM: "confirm",
  SUBMENU: "submenu",
  MENU: "menu",
  ACCOUNTS: "accounts",
  NO_ACCOUNTS_BUTTON: "no_accounts_button",
  MENU_DONE: "menu_done",
  NO_ACCOUNT: "no_account",
  ACCOUNTS_GONE: "accounts_gone",
  GUIDED_CONFIRMED: "guided_confirmed",
  GUIDED_RESET: "guided_reset",
  UNVERIFIED: "unverified",
});

// La pantalla de VS Code -> el stage de la telemetria (explicito: renombrar una pantalla no cambia
// lo que guarda el backend).
const EDITOR_ACCOUNT_SWITCH_STAGE_OF_SCREEN = Object.freeze({
  [EDITOR_ACCOUNT_SWITCH_SCREENS.DIALOG]: EDITOR_ACCOUNT_SWITCH_STAGES.DIALOG,
  [EDITOR_ACCOUNT_SWITCH_SCREENS.CONFIRM]: EDITOR_ACCOUNT_SWITCH_STAGES.CONFIRM,
  [EDITOR_ACCOUNT_SWITCH_SCREENS.SUBMENU]: EDITOR_ACCOUNT_SWITCH_STAGES.SUBMENU,
  [EDITOR_ACCOUNT_SWITCH_SCREENS.MENU]: EDITOR_ACCOUNT_SWITCH_STAGES.MENU,
  [EDITOR_ACCOUNT_SWITCH_SCREENS.ACCOUNTS]: EDITOR_ACCOUNT_SWITCH_STAGES.ACCOUNTS,
  [EDITOR_ACCOUNT_SWITCH_SCREENS.NONE]: EDITOR_ACCOUNT_SWITCH_STAGES.NO_ACCOUNTS_BUTTON,
});

function editorAccountSwitchStageOfScreen(screenKind) {
  return EDITOR_ACCOUNT_SWITCH_STAGE_OF_SCREEN[toText(screenKind)] || EDITOR_ACCOUNT_SWITCH_STAGES.NO_ACCOUNTS_BUTTON;
}

// Tono de la linea de estado del aviso.
const EDITOR_ACCOUNT_SWITCH_STATUS_TONES = Object.freeze({ OK: "ok", WARN: "warn", ERROR: "error" });

// ---- Lo que hay en pantalla en VS Code (funciones puras sobre un documento) ----

const VSCODE_ACCOUNT_PATTERNS = Object.freeze({
  accountsButton: /^(accounts|cuentas)\b/i,
  // «eydersantiago (GitHub)», «ana@correo.com (Microsoft)»: cada cuenta del menu de cuentas.
  accountItem: /^(.+?)\s*\((github|microsoft)\)$/i,
  signOut: /^(sign out|cerrar (la )?sesi[oó]n)$/i,
  cancel: /^(cancel|cancelar)$/i,
});

// El boton de cuentas de la barra de actividades (abajo a la izquierda, encima del engranaje).
function findVscodeAccountsButton(doc = document) {
  const nodes = Array.from(doc?.querySelectorAll?.(".codicon-accounts-view-bar-icon, .action-label[aria-label]") || []).filter(isGuideNodeVisible);
  return nodes.find((node) => node.classList?.contains?.("codicon-accounts-view-bar-icon"))
    || nodes.find((node) => VSCODE_ACCOUNT_PATTERNS.accountsButton.test(toText(node.getAttribute?.("aria-label"))))
    || null;
}

/**
 * Las opciones visibles de los menus de VS Code (el de cuentas y su submenu, que va dentro de la
 * opcion de la cuenta): { node, label, login, provider, isSignOut }. `login` y `provider` solo en
 * las cuentas («x (GitHub)»); `isSignOut`, en «Cerrar sesión».
 */
function readVscodeMenuItems(doc = document) {
  const nodes = Array.from(doc?.querySelectorAll?.(".monaco-menu .action-item") || []).filter(isGuideNodeVisible);
  return nodes.map((node) => {
    // La etiqueta propia va antes que el submenu: la primera .action-label es la suya.
    const label = guideNodeText(node.querySelector?.(".action-label") || node);
    const match = label.match(VSCODE_ACCOUNT_PATTERNS.accountItem);
    return {
      node,
      label,
      login: match ? match[1].trim() : "",
      provider: match ? match[2].toLowerCase() : "",
      isSignOut: VSCODE_ACCOUNT_PATTERNS.signOut.test(label),
    };
  }).filter((menuEntry) => menuEntry.label);
}

/**
 * La cuenta del menu que hay que cerrar: una de GitHub que no es la del editor (`keepLogin`) y,
 * despues, una de Microsoft (con ella vscode.dev tampoco encuentra el editor). `keepLogin` nunca se
 * cierra; vacio, cualquier cuenta de GitHub se puede cerrar. `alreadySignedOutKeys`: las ya cerradas
 * (vscodeAccountKey). null si no queda ninguna.
 */
function pickVscodeAccountToSignOut(accounts, { keepLogin = "", alreadySignedOutKeys = [] } = {}) {
  const keep = toText(keepLogin).toLowerCase();
  const open = (accounts || []).filter((accountRef) => toText(accountRef?.login) && !alreadySignedOutKeys.includes(vscodeAccountKey(accountRef)));
  return open.find((accountRef) => accountRef.provider === "github" && accountRef.login.toLowerCase() !== keep)
    || open.find((accountRef) => accountRef.provider === "microsoft")
    || null;
}

/**
 * La pantalla del cambio de cuenta en VS Code. Siempre devuelve un objeto:
 *   { screen, target, avoidArea, login, provider, accountCount, accountKeys, dialogKind }
 * `screen` (EDITOR_ACCOUNT_SWITCH_SCREENS):
 *   dialog    un dialogo de VS Code; `dialogKind` (EDITOR_ACCOUNT_SWITCH_DIALOG_KINDS) y `target`: «Cancelar»
 *   confirm   la confirmacion de cerrar sesion; `target`: «Cerrar sesión»
 *   submenu   el submenu de una cuenta; `target`: «Cerrar sesión»
 *   menu      el menu de cuentas; `target`: la cuenta que hay que cerrar (null si no queda), con
 *             `login`, `provider`, `accountCount` y `accountKeys` (las cuentas que muestra, vscodeAccountKey)
 *   accounts  nada abierto; `target`: el boton de cuentas
 *   ""        no se ve el boton de cuentas
 * `avoidArea`: el dialogo que el aviso no debe tapar. Las opciones son las de pickVscodeAccountToSignOut.
 */
function detectEditorAccountSwitchScreen(doc = document, { keepLogin = "", alreadySignedOutKeys = [] } = {}) {
  const S = EDITOR_ACCOUNT_SWITCH_SCREENS;
  const none = { screen: S.NONE, target: null, avoidArea: null, login: "", provider: "", accountCount: 0, accountKeys: [], dialogKind: "" };
  // VS Code muestra un dialogo a la vez: el que se ve.
  const dialog = Array.from(doc?.querySelectorAll?.(".monaco-dialog-box") || []).find(isGuideNodeVisible);
  if (dialog) {
    const buttons = guideButtonsIn(dialog);
    const signOut = buttons.find((button) => VSCODE_ACCOUNT_PATTERNS.signOut.test(guideNodeText(button)));
    if (signOut) return { ...none, screen: S.CONFIRM, target: signOut, avoidArea: dialog };
    const cancel = buttons.find((button) => VSCODE_ACCOUNT_PATTERNS.cancel.test(guideNodeText(button))) || null;
    return { ...none, screen: S.DIALOG, target: cancel, avoidArea: dialog, dialogKind: classifyVscodeDialog(guideNodeText(dialog)) };
  }
  const menuEntries = readVscodeMenuItems(doc);
  if (menuEntries.length) {
    const accounts = menuEntries.filter((menuEntry) => menuEntry.login);
    const accountKeys = accounts.map(vscodeAccountKey);
    const choice = pickVscodeAccountToSignOut(accounts, { keepLogin, alreadySignedOutKeys });
    const signOutEntry = menuEntries.find((menuEntry) => menuEntry.isSignOut);
    // «Cerrar sesión» solo si es el de la cuenta que hay que cerrar (no el del submenu de la del editor).
    const owner = signOutEntry ? accounts.find((menuEntry) => menuEntry.node !== signOutEntry.node && menuEntry.node.contains?.(signOutEntry.node)) : null;
    if (signOutEntry && (!owner || (choice && vscodeAccountKey(owner) === vscodeAccountKey(choice)))) {
      const accountRef = owner || choice;
      return { ...none, screen: S.SUBMENU, target: signOutEntry.node, login: accountRef?.login || "", provider: accountRef?.provider || "", accountCount: accounts.length, accountKeys };
    }
    return { ...none, screen: S.MENU, target: choice?.node || null, login: choice?.login || "", provider: choice?.provider || "", accountCount: accounts.length, accountKeys };
  }
  const button = findVscodeAccountsButton(doc);
  return button ? { ...none, screen: S.ACCOUNTS, target: button } : none;
}

// Que dialogo de VS Code es, por su texto (EDITOR_ACCOUNT_SWITCH_DIALOG_KINDS).
function classifyVscodeDialog(text) {
  const K = EDITOR_ACCOUNT_SWITCH_DIALOG_KINDS;
  if (isTunnelNotFoundText(text)) return K.TUNNEL;
  if (isVscodeSignInDialogText(text)) return K.SIGN_IN;
  return K.OTHER;
}

// Lo que dice el anillo en cada pantalla ("" si no hay nada que pulsar). Mientras pulsa ADACEEN
// (`pressedByAdaceen`), lo dice, para que el estudiante no lo pulse a la vez.
function editorAccountSwitchPointerLabel(switchScreen, { pressedByAdaceen = false } = {}) {
  if (!switchScreen?.target) return "";
  if (switchScreen.screen === EDITOR_ACCOUNT_SWITCH_SCREENS.ACCOUNTS) return pressedByAdaceen ? "ADACEEN abre tus cuentas" : "Pulsa aquí: tus cuentas";
  const what = switchScreen.screen === EDITOR_ACCOUNT_SWITCH_SCREENS.MENU ? formatVscodeAccountLabel(switchScreen) : guideNodeText(switchScreen.target);
  return pressedByAdaceen ? `ADACEEN pulsa «${what}»` : `Pulsa «${what}»`;
}

/**
 * Los pasos del aviso, con las pantallas de VS Code en que va cada uno (bindGuideSteps
 * marca «Ahora» y cambia el dibujo) y su dibujo.
 */
function editorAccountSwitchSteps(editorLogin) {
  const S = EDITOR_ACCOUNT_SWITCH_SCREENS;
  const mine = editorLogin ? `«${editorLogin}»` : "la cuenta de tu editor";
  return [
    { key: "dialog", screens: [S.DIALOG], figure: "vscode-tunnel-cancel", title: "Cierra el aviso de VS Code", text: "Pulsa «Cancelar» en el aviso «No se pudo encontrar el túnel». «Elegir otra cuenta» no sirve aquí: vuelve a usar la misma sesión." },
    { key: "accounts", screens: [S.ACCOUNTS], figure: "vscode-accounts-open", title: "Abre tus cuentas de VS Code", text: "Pulsa el ícono de cuentas: abajo a la izquierda, encima del engranaje (puede verse como tu foto de GitHub)." },
    { key: "signout", screens: [S.MENU, S.SUBMENU, S.CONFIRM], figure: "vscode-accounts-signout", figureForScreen: { [S.CONFIRM]: "vscode-signout-confirm" }, title: "Cierra la sesión de la otra cuenta", text: `En la cuenta que no es ${mine}, pulsa «Cerrar sesión» (Sign Out) y confírmalo. La cuenta ${mine} no se toca.` },
    { key: "enter", screens: [EDITOR_ACCOUNT_SWITCH_DONE_STEP], figure: "github-select-account", title: `Entra con ${mine}`, text: `La página se recarga sola. VS Code te pide entrar: «Allow» (Permitir), GitHub y, cuando GitHub pregunte con qué cuenta, elige ${mine}. Tus archivos no se tocan.` },
  ];
}

// ---- Lo que toca en cada vistazo (pura) ----

/**
 * El estado de un cambio en curso: quien pulsa (`mode`), las cuentas ya cerradas
 * ({ provider, login }), la que esta por cerrarse (`pendingAccount`) y la que se confirmo pero falta
 * comprobar (`verifying`: { provider, login, since }), la pantalla anterior, cuanto lleva la actual y
 * cuantas veces se pulso, cuantos dialogos se cancelaron y cuantas veces se confirmo cada cuenta.
 */
function createEditorAccountSwitchRun(startedAt) {
  return {
    mode: EDITOR_ACCOUNT_SWITCH_MODES.AUTO,
    startedAt,
    signedOut: [],
    pendingAccount: null,
    verifying: null,
    lastScreen: EDITOR_ACCOUNT_SWITCH_SCREENS.NONE,
    current: { key: "", since: startedAt, presses: 0, lastPressAt: 0 },
    dialogCancels: 0,
    signOutTries: {},
    // Alguna cuenta se dio por cerrada sin comprobarlo (en automatico, al vencer la comprobacion).
    assumedSignOut: false,
  };
}

// La pestana estuvo oculta `gapMs`: los tiempos del cambio se corren (no cuenta como espera).
function shiftEditorAccountSwitchRun(run, gapMs) {
  if (!(gapMs > 0)) return run;
  const shift = (value) => (value > 0 ? value + gapMs : value);
  return {
    ...run,
    startedAt: run.startedAt + gapMs,
    verifying: run.verifying ? { ...run.verifying, since: run.verifying.since + gapMs } : null,
    current: { ...run.current, since: shift(run.current.since), lastPressAt: shift(run.current.lastPressAt) },
  };
}

/**
 * Un vistazo: con el estado del cambio (`run`), la pantalla que se ve (detectEditorAccountSwitchScreen)
 * y la hora, devuelve el estado nuevo y que hacer. No toca nada; startEditorAccountSwitch lo aplica.
 *   { type: "wait" }                         esperar (el anillo ya marca el boton)
 *   { type: "press" }                        pulsar `switchScreen.target`
 *   { type: "guided", reason, screen, login } pedirselo al estudiante desde aqui
 *                                            (EDITOR_ACCOUNT_SWITCH_GUIDED_REASONS)
 *   { type: "ask_confirm" }                  no se pudo comprobar la cuenta cerrada: que lo diga el
 *                                            estudiante («Ya cerré la sesión»)
 *   { type: "finish", outcome, stage }       terminar (EDITOR_ACCOUNT_SWITCH_OUTCOMES y _STAGES)
 * y `pressedByAdaceen`: si el boton marcado lo va a pulsar ADACEEN (el anillo lo dice).
 * Reglas:
 *   - Cuando desaparece la confirmacion, la cuenta queda por comprobar: cuenta como cerrada si el
 *     menu de cuentas ya no la muestra o VS Code muestra el dialogo que pide entrar de nuevo; si el
 *     menu la sigue mostrando (se pulso «Cancelar»), no. Para comprobar, ADACEEN abre el menu tambien
 *     en modo guiado. Sin comprobar en EDITOR_ACCOUNT_SWITCH_VERIFY_MS: en automatico cuenta (la
 *     confirmo ADACEEN) y el final lo dice (stage «unverified»); en guiado se pregunta.
 *   - Con una cerrada y comprobada, termina ante cualquier dialogo de VS Code (ya no hace falta
 *     cancelarlo: se recarga), en modo guiado o cuando el menu ya no tiene cuentas que cerrar.
 *   - Cada pantalla se pulsa despues de verse EDITOR_ACCOUNT_SWITCH_DWELL_MS y a lo sumo
 *     EDITOR_ACCOUNT_SWITCH_PRESS_TRIES veces; solo se cancelan el dialogo del tunel y el que pide
 *     iniciar sesion.
 */
function stepEditorAccountSwitch(run, switchScreen, now) {
  const S = EDITOR_ACCOUNT_SWITCH_SCREENS;
  const O = EDITOR_ACCOUNT_SWITCH_OUTCOMES;
  const STAGES = EDITOR_ACCOUNT_SWITCH_STAGES;
  const M = EDITOR_ACCOUNT_SWITCH_MODES;
  const K = EDITOR_ACCOUNT_SWITCH_DIALOG_KINDS;
  const next = { ...run, signedOut: [...run.signedOut], current: { ...run.current }, signOutTries: { ...run.signOutTries } };
  const R = EDITOR_ACCOUNT_SWITCH_GUIDED_REASONS;
  const kind = toText(switchScreen?.screen);
  const result = (state, action, pressedByAdaceen = state.mode === M.AUTO) => ({ run: state, action, pressedByAdaceen });
  const wait = () => result(next, { type: "wait" });
  const guided = (reason) => result({ ...next, mode: M.GUIDED }, { type: "guided", reason, screen: kind, login: toText(switchScreen?.login) });
  const finish = (outcome, stage) => result(next, {
    type: "finish",
    outcome,
    stage: outcome === O.SIGNED_OUT && next.assumedSignOut ? STAGES.UNVERIFIED : stage,
  });
  const settleVerified = ({ assumed = false } = {}) => {
    const closed = next.verifying;
    next.verifying = null;
    if (assumed) next.assumedSignOut = true;
    if (!next.signedOut.some((accountRef) => vscodeAccountKey(accountRef) === vscodeAccountKey(closed))) {
      next.signedOut.push({ provider: closed.provider, login: closed.login });
    }
  };

  // La confirmacion se cerro: la cuenta queda por comprobar.
  if (next.lastScreen === S.CONFIRM && kind !== S.CONFIRM && next.pendingAccount) {
    next.verifying = { ...next.pendingAccount, since: now };
    next.pendingAccount = null;
    // Comprobar es una pantalla nueva (en guiado, ADACEEN vuelve a abrir el menu).
    next.current = { key: "", since: now, presses: 0, lastPressAt: 0 };
  }
  if ((kind === S.MENU || kind === S.SUBMENU) && switchScreen.login) {
    next.pendingAccount = { provider: switchScreen.provider, login: switchScreen.login };
  }
  if (kind === S.CONFIRM && next.lastScreen !== S.CONFIRM && next.pendingAccount) {
    const tryKey = vscodeAccountKey(next.pendingAccount);
    next.signOutTries[tryKey] = (next.signOutTries[tryKey] || 0) + 1;
  }
  next.lastScreen = kind;

  if (next.verifying) {
    // Solo el dialogo que pide entrar de nuevo prueba que se cerro; otro dialogo no dice nada.
    if (kind === S.DIALOG && switchScreen.dialogKind === K.SIGN_IN) settleVerified();
    else if (kind === S.MENU || kind === S.SUBMENU) {
      if ((switchScreen.accountKeys || []).includes(vscodeAccountKey(next.verifying))) next.verifying = null;
      else settleVerified();
    } else if (now - next.verifying.since > EDITOR_ACCOUNT_SWITCH_VERIFY_MS) {
      if (next.mode === M.AUTO) settleVerified({ assumed: true });
      else {
        next.verifying = null;
        return result(next, { type: "ask_confirm" });
      }
    } else if (kind === S.ACCOUNTS && next.mode === M.GUIDED) {
      // En guiado, ADACEEN abre el menu solo para comprobar (y el anillo dice que lo hace ADACEEN).
      const key = `verify:${kind}`;
      if (key !== next.current.key) next.current = { key, since: now, presses: 0, lastPressAt: 0 };
      if (now - next.current.since >= EDITOR_ACCOUNT_SWITCH_DWELL_MS && next.current.presses === 0) {
        next.current.presses = 1;
        next.current.lastPressAt = now;
        return result(next, { type: "press" }, true);
      }
      return result(next, { type: "wait" }, next.current.presses === 0);
    }
  }

  if (next.signedOut.length && kind !== S.CONFIRM && !next.verifying
    && (next.signedOut.length >= EDITOR_ACCOUNT_SWITCH_MAX_SIGNOUTS || kind === S.DIALOG || next.mode === EDITOR_ACCOUNT_SWITCH_MODES.GUIDED)) {
    return finish(O.SIGNED_OUT, editorAccountSwitchStageOfScreen(kind));
  }
  if (next.mode !== M.AUTO) return wait();
  if (now - next.startedAt > EDITOR_ACCOUNT_SWITCH_AUTO_LIMIT_MS) return guided(R.TIME_LIMIT);
  // VS Code no cierra esa cuenta aunque ADACEEN lo confirme: que lo intente el estudiante.
  if ((kind === S.MENU || kind === S.SUBMENU) && switchScreen.login
    && (next.signOutTries[vscodeAccountKey(switchScreen)] || 0) >= EDITOR_ACCOUNT_SWITCH_MAX_SIGNOUT_TRIES) {
    return guided(R.SIGNOUT_REFUSED);
  }

  const key = `${kind}:${vscodeAccountKey(switchScreen)}:${switchScreen?.target ? "t" : "-"}`;
  if (key !== next.current.key) next.current = { key, since: now, presses: 0, lastPressAt: 0 };
  const shownFor = now - next.current.since;

  if (!switchScreen?.target) {
    if (kind === S.MENU) {
      const settle = switchScreen.accountCount > 0 ? EDITOR_ACCOUNT_SWITCH_MENU_SETTLE_MS : EDITOR_ACCOUNT_SWITCH_EMPTY_WAIT_MS;
      if (shownFor < settle) return wait();
      return next.signedOut.length ? finish(O.SIGNED_OUT, STAGES.MENU_DONE) : finish(O.RESET, STAGES.NO_ACCOUNT);
    }
    if (kind === S.NONE) {
      if (shownFor < EDITOR_ACCOUNT_SWITCH_EMPTY_WAIT_MS || next.verifying) return wait();
      return next.signedOut.length ? finish(O.SIGNED_OUT, STAGES.ACCOUNTS_GONE) : finish(O.RESET, STAGES.NO_ACCOUNT);
    }
    // Un dialogo sin «Cancelar»: lo cierra el estudiante.
    return shownFor >= EDITOR_ACCOUNT_SWITCH_DWELL_MS ? guided(R.NO_CANCEL) : wait();
  }
  // Un dialogo que no es del tunel ni pide iniciar sesion no se cancela: lo decide el estudiante.
  if (kind === S.DIALOG && switchScreen.dialogKind === K.OTHER) return guided(R.UNKNOWN_DIALOG);
  if (shownFor < EDITOR_ACCOUNT_SWITCH_DWELL_MS) return wait();
  if (next.current.presses > 0 && now - next.current.lastPressAt < EDITOR_ACCOUNT_SWITCH_STEP_WAIT_MS) return wait();
  if (next.current.presses >= EDITOR_ACCOUNT_SWITCH_PRESS_TRIES) return guided(R.NO_RESPONSE);
  if (kind === S.DIALOG) {
    if (next.dialogCancels >= EDITOR_ACCOUNT_SWITCH_MAX_DIALOG_CANCELS) return guided(R.NO_RESPONSE);
    next.dialogCancels += 1;
  }
  next.current.presses += 1;
  next.current.lastPressAt = now;
  return result(next, { type: "press" });
}

/**
 * No se pudieron mandar los eventos al boton marcado (pura): en automatico, se le pide al
 * estudiante desde ahi; si era ADACEEN abriendo el menu para comprobar (guiado), se pregunta.
 */
function markEditorAccountSwitchPressFailed(run, switchScreen) {
  if (run.mode === EDITOR_ACCOUNT_SWITCH_MODES.AUTO) {
    return {
      run: { ...run, mode: EDITOR_ACCOUNT_SWITCH_MODES.GUIDED },
      action: { type: "guided", reason: EDITOR_ACCOUNT_SWITCH_GUIDED_REASONS.NO_RESPONSE, screen: toText(switchScreen?.screen), login: toText(switchScreen?.login) },
      pressedByAdaceen: false,
    };
  }
  return { run: { ...run, verifying: null }, action: { type: "ask_confirm" }, pressedByAdaceen: false };
}

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
