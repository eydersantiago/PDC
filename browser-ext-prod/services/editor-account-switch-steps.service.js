// Cambiar la cuenta de VS Code (0.8.5), la parte pura: constantes, lo que hay en pantalla en VS Code y
// la decision de cada vistazo (stepEditorAccountSwitch). Movido sin cambios de editor-account-switch.service.js.

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
