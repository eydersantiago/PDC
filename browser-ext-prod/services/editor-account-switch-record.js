// El registro del cambio de cuenta de VS Code (0.8.5): el freno contra el bucle y como se nombran
// las cuentas. Carga antes que workspace.service.js: lo leen el aviso «Tu editor no aparece…»
// (workspace.service.js), el paso 4 y el selector de cuentas de GitHub (tunnel-entry-guide.service.js)
// y lo escribe el cambio de cuenta (editor-account-switch.service.js). Aqui no hay nada de la pagina
// de VS Code: si el cambio de cuenta falla con una version nueva de vscode.dev y se saca del
// manifest, el aviso, «Reconectar con mi cuenta» y el paso 4 siguen igual.
//
// Registro (chrome.storage.local, STORAGE_KEY_EDITOR_ACCOUNT_SWITCH; uno por navegador):
//   { userId, tunnelName, attempts, signedOut: [{ provider, login }], outcome, at }
// Vale EDITOR_ACCOUNT_SWITCH_TTL_MS para ese usuario y ese tunel. Se guarda solo al terminar un cambio
// (outcome signed_out o reset); un cambio cancelado no se guarda ni cuenta para el freno.

// Un cambio cuenta para el freno durante este tiempo.
const EDITOR_ACCOUNT_SWITCH_TTL_MS = 30 * 60 * 1000;
// Cambios que se ofrecen como accion principal antes de pasar a «Reconectar con mi cuenta».
const EDITOR_ACCOUNT_SWITCH_MAX_ATTEMPTS = 2;

// Como termina un cambio. Es `value` de la telemetria tunnel_editor_account_switch (catalogo del
// backend) y `outcome` del registro.
const EDITOR_ACCOUNT_SWITCH_OUTCOMES = Object.freeze({
  SIGNED_OUT: "signed_out",
  RESET: "reset",
  CANCELLED: "cancelled",
});

const VSCODE_ACCOUNT_PROVIDER_LABELS = Object.freeze({ github: "GitHub", microsoft: "Microsoft" });

/** Clave de una cuenta ({ provider, login }) para compararlas: «github:eyder». */
function vscodeAccountKey(accountRef) {
  return `${toText(accountRef?.provider).toLowerCase()}:${toText(accountRef?.login).toLowerCase()}`;
}

/** Como la muestra VS Code: «eyder (GitHub)». Solo para mostrar; se guarda { provider, login }. */
function formatVscodeAccountLabel(accountRef) {
  const provider = VSCODE_ACCOUNT_PROVIDER_LABELS[toText(accountRef?.provider).toLowerCase()] || "";
  return provider ? `${toText(accountRef.login)} (${provider})` : toText(accountRef?.login);
}

// «a», «a» y «b», «a», «b» y «c»: las cuentas cerradas en una frase.
function formatClosedAccountsList(labels) {
  const quoted = (labels || []).map((name) => `«${name}»`);
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} y ${quoted[quoted.length - 1]}` : quoted.join("");
}

// Cambiar la cuenta de VS Code a mano (sin editor-account-switch.service.js en el manifest).
const EDITOR_ACCOUNT_SWITCH_MANUAL_TEXT = "Hazlo a mano: pulsa «Cancelar» en el aviso de VS Code, el ícono de cuentas (abajo a la izquierda) → la otra cuenta → «Cerrar sesión», confirma y recarga la página. Cuando VS Code lo pida, entra con tu cuenta.";

// El boton del aviso que empieza el cambio.
function editorAccountSwitchLabel(editorLogin) {
  return editorLogin ? `Cambiar a ${editorLogin}` : "Cambiar de cuenta en VS Code";
}

// Cuentas guardadas: solo las que tienen login (una cuenta cerrada sin saber cual no se nombra).
function normalizeSignedOutAccounts(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((accountRef) => accountRef && typeof accountRef === "object" && toText(accountRef.login))
    .map((accountRef) => ({ provider: toText(accountRef.provider).toLowerCase(), login: toText(accountRef.login) }));
}

/**
 * El ultimo cambio de cuenta de este usuario en ese tunel, si fue hace menos de
 * EDITOR_ACCOUNT_SWITCH_TTL_MS: { attempts, signedOut: [{ provider, login }], outcome }; si no, null.
 */
async function readRecentEditorAccountSwitch(tunnelName) {
  if (!tunnelName || !isExtensionRuntimeReady()) return null;
  try {
    const raw = (await chrome.storage.local.get([STORAGE_KEY_EDITOR_ACCOUNT_SWITCH]))?.[STORAGE_KEY_EDITOR_ACCOUNT_SWITCH];
    const fresh = Boolean(raw)
      && toText(raw.userId) === getCurrentUserId()
      && toText(raw.tunnelName).toLowerCase() === toText(tunnelName).toLowerCase()
      && Date.now() - Number(raw.at) < EDITOR_ACCOUNT_SWITCH_TTL_MS;
    if (!fresh) return null;
    return {
      attempts: Math.max(1, Number(raw.attempts) || 1),
      signedOut: normalizeSignedOutAccounts(raw.signedOut),
      outcome: toText(raw.outcome),
    };
  } catch {
    return null;
  }
}

async function saveEditorAccountSwitch(tunnelName, { attempts = 1, signedOut = [], outcome = "" } = {}) {
  const userId = getCurrentUserId();
  if (!userId || !tunnelName || !isExtensionRuntimeReady()) return false;
  try {
    await chrome.storage.local.set({
      [STORAGE_KEY_EDITOR_ACCOUNT_SWITCH]: { userId, tunnelName, attempts, signedOut: normalizeSignedOutAccounts(signedOut), outcome, at: Date.now() },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * El freno, con lo que necesita cada aviso (puro; `recent` es lo de readRecentEditorAccountSwitch):
 *   switchedRecently     hubo un cambio terminado hace poco (signed_out o reset) en este tunel
 *   attempts             cuantos cambios terminados van (0 si ninguno)
 *   exhausted            ya van EDITOR_ACCOUNT_SWITCH_MAX_ATTEMPTS: lo principal es reconectar
 *   nextAttempt          el numero del proximo cambio
 *   closedLabels         las cuentas cerradas, como las muestra VS Code («eyder (GitHub)»)
 *   closedLabelsText     las mismas en una frase («a» y «b»; "" si ninguna)
 *   closedGithubLogins   los logins de GitHub cerrados (el selector de GitHub advierte no elegirlos)
 */
function editorAccountSwitchBrake(recent) {
  const O = EDITOR_ACCOUNT_SWITCH_OUTCOMES;
  const switchedRecently = Boolean(recent) && (recent.outcome === O.SIGNED_OUT || recent.outcome === O.RESET);
  const attempts = switchedRecently ? Math.max(1, Number(recent.attempts) || 1) : 0;
  const signedOut = switchedRecently ? normalizeSignedOutAccounts(recent.signedOut) : [];
  const closedLabels = signedOut.map(formatVscodeAccountLabel);
  return {
    switchedRecently,
    attempts,
    exhausted: attempts >= EDITOR_ACCOUNT_SWITCH_MAX_ATTEMPTS,
    nextAttempt: attempts + 1,
    closedLabels,
    closedLabelsText: formatClosedAccountsList(closedLabels),
    closedGithubLogins: signedOut.filter((accountRef) => accountRef.provider === "github").map((accountRef) => accountRef.login),
  };
}
