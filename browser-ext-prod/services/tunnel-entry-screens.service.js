// Paso 4 de la primera vez, la parte pura: pantallas de vscode.dev y comprobacion de la extension de VS Code.
// Movido sin cambios de tunnel-entry-guide.service.js (constantes, aviso y pagina de GitHub).

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
