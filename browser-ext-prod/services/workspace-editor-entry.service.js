// Entorno por tunel en vscode.dev: aviso guardado de la primera entrada al editor y el punto de
// restauracion cuando vscode.dev no encuentra el tunel (0.8.1). Constantes en workspace.service.js.

// ---- Primera entrada al editor (vscode.dev) ----

// Nombre del tunel de una URL de vscode.dev/tunnel/<nombre>/..., en minusculas; "" si no es una.
function tunnelNameFromEditorUrl(value) {
  if (!isTunnelEditorUrl(value)) return "";
  try {
    const match = new URL(toText(value)).pathname.match(/^\/tunnel\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]).toLowerCase() : "";
  } catch {
    return "";
  }
}

// ¿Este navegador ya abrio alguna vez ese tunel para el usuario actual? (cualquier repositorio:
// el inicio de sesion de vscode.dev es por tunel, no por carpeta).
function tunnelOpenedInThisBrowser(tunnelName) {
  const userId = getCurrentUserId();
  if (!userId || !tunnelName) return false;
  const prefix = `${userId}:`;
  return Object.entries(overlayState.editorByUser || {}).some(([key, record]) => key.startsWith(prefix)
    && toText(record?.openedAt)
    && tunnelNameFromEditorUrl(record?.webUrl) === tunnelName);
}

// Al abrir el editor por primera vez (en este navegador o tras autorizar el codigo), vscode.dev
// pide iniciar sesion para entrar al tunel: la pestana del editor lo avisara una vez.
async function saveTunnelSignInHint(webUrl, githubLogin) {
  const tunnelName = tunnelNameFromEditorUrl(webUrl);
  const userId = getCurrentUserId();
  if (!tunnelName || !userId || !isExtensionRuntimeReady()) return false;
  try {
    await chrome.storage.local.set({
      [STORAGE_KEY_TUNNEL_SIGNIN_HINT]: {
        userId,
        tunnelName,
        githubLogin: normalizeGithubLoginHint(githubLogin),
        expiresAt: Date.now() + TUNNEL_SIGNIN_HINT_TTL_MS,
      },
    });
    return true;
  } catch {
    return false;
  }
}

async function clearTunnelSignInHint() {
  if (!isExtensionRuntimeReady()) return;
  try {
    await chrome.storage.local.remove([STORAGE_KEY_TUNNEL_SIGNIN_HINT]);
  } catch {}
}

// El aviso de entrar a VS Code que sigue vigente para el usuario de ADACEEN (sin borrarlo).
async function readTunnelSignInHint() {
  if (!isExtensionRuntimeReady()) return null;
  let hint = null;
  try {
    hint = (await chrome.storage.local.get([STORAGE_KEY_TUNNEL_SIGNIN_HINT]))?.[STORAGE_KEY_TUNNEL_SIGNIN_HINT] || null;
  } catch {
    return null;
  }
  if (!hint || !toText(hint.tunnelName)) return null;
  if (!(Number(hint.expiresAt) > Date.now())) {
    await clearTunnelSignInHint();
    return null;
  }
  await syncFromStorageSnapshot({ force: true }).catch(() => false);
  const userId = getCurrentUserId();
  if (!userId || toText(hint.userId) !== userId) return null;
  return hint;
}

// El aviso del paso 4 (mountTunnelEntryGuide, showTunnelSignInHint y el de la pagina de GitHub
// que autoriza «Visual Studio Code») esta en tunnel-entry-guide.service.js (0.8.4).

// ---- vscode.dev no encuentra el tunel: el punto de restauracion (0.8.1) ----

// vscode.dev (en el idioma del navegador) cuando la cuenta con la que se entro no tiene ese tunel.
const TUNNEL_NOT_FOUND_PATTERNS = [
  /(no se pudo encontrar|no se encontr[oó]|no se puede encontrar|no encontramos)[^.!?]{0,80}t[uú]nel/i,
  /(could ?n[o']?t find|unable to find|cannot find|can't find)[^.!?]{0,80}tunnel/i,
  /tunnel[^.!?]{0,60}(not found|was not found|does not exist)/i,
  /t[uú]nel[^.!?]{0,60}(no existe|no se encontr)/i,
];

const TUNNEL_NOT_FOUND_DIALOG_SELECTOR = '.monaco-dialog-box, [role="dialog"], [role="alertdialog"], .notification-toast';

function isTunnelNotFoundText(value) {
  const text = toText(value).replace(/\s+/g, " ");
  return Boolean(text) && TUNNEL_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(text));
}

// El dialogo de vscode.dev o, si cambia su markup, el texto de la pagina (solo si nombra el tunel).
function tunnelNotFoundOnPage(tunnelName) {
  let nodes = [];
  try {
    nodes = Array.from(document.querySelectorAll(TUNNEL_NOT_FOUND_DIALOG_SELECTOR) || []);
  } catch {
    nodes = [];
  }
  if (nodes.some((node) => isTunnelNotFoundText(node?.innerText || node?.textContent))) return true;
  const body = toText(document.body?.innerText || document.body?.textContent).slice(0, 6000);
  return Boolean(tunnelName) && body.toLowerCase().includes(tunnelName) && isTunnelNotFoundText(body);
}

// Login de GitHub de una URL del editor: vscode.dev/tunnel/<nombre>/home/ws-<login>/...
function tunnelLoginFromEditorUrl(value) {
  if (!isTunnelEditorUrl(value)) return "";
  try {
    const match = new URL(toText(value)).pathname.match(/\/home\/ws-([a-z0-9-]+)(?:\/|$)/i);
    return match ? normalizeGithubLoginHint(match[1]) : "";
  } catch {
    return "";
  }
}

function tunnelEditorPath(value) {
  try {
    return decodeURIComponent(new URL(toText(value)).pathname).toLowerCase().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

// El editor guardado de esta pestana: el de esta carpeta del tunel o, si no, otro del mismo tunel.
function savedEditorForTunnelUrl(value) {
  const tunnelName = tunnelNameFromEditorUrl(value);
  const here = tunnelEditorPath(value);
  if (!tunnelName || !here) return null;
  const editors = listSavedTunnelEditors().filter((record) => tunnelNameFromEditorUrl(record?.webUrl) === tunnelName);
  return editors.find((record) => {
    const path = tunnelEditorPath(record.webUrl);
    return path && (here === path || here.startsWith(`${path}/`));
  }) || editors[0] || null;
}

// Que paso, con lo que se sabe: quien autorizo el codigo (`device`, rememberTunnelDeviceAccount), de
// quien es el editor (`editorLogin`) y si ya se cambio la cuenta de VS Code (`brake`,
// editorAccountSwitchBrake en editor-account-switch-record.js):
//   device           el codigo lo autorizo otra cuenta (reconectar)
//   vscode           el codigo esta bien y VS Code entro con otra cuenta (cambiarla)
//   after_switch     ya se cambio la cuenta de VS Code y sigue igual (se puede repetir)
//   switch_exhausted ya se cambio EDITOR_ACCOUNT_SWITCH_MAX_ATTEMPTS veces (reconectar)
//   unknown          no se sabe
function tunnelNotFoundCause({ device = null, editorLogin = "", brake = null } = {}) {
  if (device?.account && editorLogin && device.account !== editorLogin) return "device";
  if (brake?.switchedRecently) return brake.exhausted ? "switch_exhausted" : "after_switch";
  if (device?.account && editorLogin) return "vscode";
  return "unknown";
}

// Textos y orden de los botones (el primero es el principal) para cada causa: «vscodeAccount»
// (cambiar la cuenta de VS Code), «reconnect» y «githubAccount» (otra cuenta de GitHub en ADACEEN).
// `canAutoSwitch`: esta editor-account-switch.service.js (si no, el texto dice como hacerlo a mano).
function tunnelNotFoundCopy(cause, { device = null, editorLogin = "", brake = null, canAutoSwitch = true } = {}) {
  const mine = editorLogin ? `«${editorLogin}»` : "la cuenta de GitHub conectada a ADACEEN";
  const change = editorAccountSwitchLabel(editorLogin);
  const reconnectTail = `ADACEEN apaga tu editor un momento y te da un código nuevo para autorizarlo con ${mine}. Tus archivos no se tocan.`;
  const changeTail = canAutoSwitch
    ? `ADACEEN cierra en VS Code la sesión de la otra cuenta (ícono de cuentas, abajo a la izquierda → «Cerrar sesión»), recarga la página y te acompaña a entrar con ${mine}. Tus archivos no se tocan.`
    : EDITOR_ACCOUNT_SWITCH_MANUAL_TEXT;
  const otherAccount = `¿Tu cuenta de GitHub no es ${mine}? Pulsa «${SWITCH_GITHUB_ACCOUNT_LABEL}»: eliges la tuya en GitHub y ADACEEN te prepara un editor a su nombre.`;
  if (cause === "device") {
    return {
      intro: `El código del paso 3 lo autorizó «${device.account}», pero tu editor es de ${mine}. vscode.dev solo encuentra tu editor con la cuenta que autorizó el código.`,
      items: [`Pulsa «${RECONNECT_BUTTON_LABEL}». ${reconnectTail}`, otherAccount],
      order: ["reconnect", "githubAccount", "vscodeAccount"],
    };
  }
  if (cause === "vscode") {
    return {
      intro: `Tu editor es de ${mine} y el código se autorizó bien, pero VS Code entró con otra cuenta de GitHub guardada en este navegador. ${VSCODE_CHOOSE_ACCOUNT_LOOP_TEXT}`,
      items: [`Pulsa «${change}». ${changeTail}`, `Si sigue sin encontrarlo, pulsa «${RECONNECT_BUTTON_LABEL}». ${reconnectTail}`, otherAccount],
      order: ["vscodeAccount", "reconnect", "githubAccount"],
    };
  }
  if (cause === "after_switch" || cause === "switch_exhausted") {
    const closed = brake?.closedLabelsText || "";
    const intro = `Ya cambiaste la cuenta de VS Code${closed ? ` (cerraste ${closed})` : ""} y tu editor sigue sin aparecer.`;
    if (cause === "switch_exhausted") {
      return {
        intro: `${intro} Ya se intentó ${brake.attempts} veces: lo más seguro es reconectar.`,
        items: [
          `Pulsa «${RECONNECT_BUTTON_LABEL}». ${reconnectTail}`,
          `Otra salida: abre este mismo enlace en una ventana de incógnito y entra con ${mine}.`,
          otherAccount,
        ],
        order: ["reconnect", "vscodeAccount", "githubAccount"],
      };
    }
    return {
      intro,
      items: [
        `Si en GitHub elegiste otra cuenta, pulsa «${change}» otra vez y, cuando GitHub pregunte con qué cuenta entrar, elige ${mine}.`,
        `Si entraste con ${mine}, el código del paso 3 se autorizó con otra cuenta: pulsa «${RECONNECT_BUTTON_LABEL}». ${reconnectTail}`,
        otherAccount,
      ],
      order: ["vscodeAccount", "reconnect", "githubAccount"],
    };
  }
  return {
    intro: `vscode.dev no encuentra tu editor con la cuenta de GitHub con la que entraste. Tu editor está a nombre de ${mine} (la cuenta de GitHub conectada a ADACEEN).`,
    items: [
      `Lo más común: VS Code entró con otra cuenta guardada en este navegador (${VSCODE_CHOOSE_ACCOUNT_LOOP_TEXT.replace(/\.$/, "")}). Pulsa «${change}». ${changeTail}`,
      `Si sigue igual, pulsa «${RECONNECT_BUTTON_LABEL}». ${reconnectTail}`,
      otherAccount,
    ],
    order: ["vscodeAccount", "reconnect", "githubAccount"],
  };
}

async function showTunnelNotFoundBanner(tunnelName) {
  await syncFromStorageSnapshot({ force: true }).catch(() => false);
  const userId = getCurrentUserId();
  if (!userId) return false;
  const saved = savedEditorForTunnelUrl(location.href);
  const hint = await readTunnelSignInHint();
  const device = await readTunnelDeviceAccount();
  const urlLogin = tunnelLoginFromEditorUrl(location.href);
  // Solo el editor de quien tiene la sesion de ADACEEN (no el enlace de otro estudiante).
  const own = Boolean(saved)
    || toText(hint?.tunnelName).toLowerCase() === tunnelName
    || Boolean(device?.expected && device.expected === urlLogin);
  if (!own) return false;
  const expected = normalizeGithubLoginHint(hint?.githubLogin) || device?.expected || urlLogin
    || normalizeGithubLoginHint(overlayState.githubUserStatus?.accountLogin);
  const repoFullName = parseRepoFullName(saved?.repoFullName) || parseRepoFullName(getLatestSavedTunnelEditor()?.repoFullName);
  const brake = editorAccountSwitchBrake(await readRecentEditorAccountSwitch(tunnelName));
  // El cambio automatico es opcional (se puede sacar del manifest si una version de vscode.dev lo rompe).
  const canAutoSwitch = typeof startEditorAccountSwitch === "function";
  const cause = tunnelNotFoundCause({ device, editorLogin: expected, brake });
  const copy = tunnelNotFoundCopy(cause, { device, editorLogin: expected, brake, canAutoSwitch });

  document.getElementById(TUNNEL_NOT_FOUND_HOST_ID)?.remove();
  const host = document.createElement("div");
  host.id = TUNNEL_NOT_FOUND_HOST_ID;
  const root = host.attachShadow({ mode: "closed" });
  // Markup fijo; los textos entran con textContent.
  root.innerHTML = `
    <style>
      .box { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
        display: grid; gap: 8px; box-sizing: border-box; width: min(660px, calc(100vw - 24px));
        padding: 14px 44px 14px 16px; border-radius: 10px; background: #06131b; color: #f8fbff;
        border: 1px solid #c99a2e; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
        font: 14px/1.45 Segoe UI, Arial, sans-serif; }
      strong.title { color: #ffe2a3; font-size: 15px; }
      p { margin: 0; color: #d9eaf0; }
      ol { margin: 0; padding-left: 20px; display: grid; gap: 4px; }
      ol li::marker { color: #ffd08a; font-weight: 700; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      button { font: inherit; border: 0; border-radius: 8px; cursor: pointer; }
      button.primary { padding: 8px 14px; font-weight: 700; background: #ffd08a; color: #3b2a06; }
      button.primary, button.secondary { padding: 8px 14px; font-weight: 700; }
      button.secondary { background: transparent; color: #ffe2a3; border: 1px solid #c99a2e; }
      button[disabled] { opacity: 0.6; cursor: default; }
      button.close { position: absolute; top: 8px; right: 8px; background: transparent; color: #d9eaf0; padding: 4px 8px; }
      button:focus-visible { outline: 3px solid #76efe5; outline-offset: 2px; }
      .status { color: #9ff0c6; }
      .status.is-error { color: #ffb4a8; }
    </style>
    <aside class="box" role="alertdialog" aria-label="ADACEEN: tu editor no aparece con esta cuenta de GitHub">
      <strong class="title">ADACEEN · Tu editor no aparece con esta cuenta de GitHub</strong>
      <p id="adaceenNotFoundText"></p>
      <ol id="adaceenNotFoundSteps"></ol>
      <div class="actions">
        <button type="button" class="secondary" id="adaceenNotFoundVscodeAccount"></button>
        <button type="button" class="secondary" id="adaceenNotFoundReconnect"></button>
        <button type="button" class="secondary" id="adaceenNotFoundGithubAccount"></button>
      </div>
      <p class="status" id="adaceenNotFoundStatus" role="status" hidden></p>
      <button type="button" class="close" id="adaceenNotFoundClose" aria-label="Ocultar el aviso">&times;</button>
    </aside>`;
  const textEl = root.getElementById("adaceenNotFoundText");
  if (textEl) textEl.textContent = copy.intro;
  const listEl = root.getElementById("adaceenNotFoundSteps");
  for (const item of copy.items) {
    const li = document.createElement("li");
    li.textContent = item;
    listEl?.appendChild(li);
  }
  const statusEl = root.getElementById("adaceenNotFoundStatus");
  const setStatus = (text, isError = false) => {
    if (!statusEl) return;
    statusEl.hidden = !text;
    statusEl.className = isError ? "status is-error" : "status";
    statusEl.textContent = text;
  };
  const button = root.getElementById("adaceenNotFoundReconnect");
  const githubAccountButton = root.getElementById("adaceenNotFoundGithubAccount");
  const vscodeAccountButton = root.getElementById("adaceenNotFoundVscodeAccount");
  if (button) button.textContent = RECONNECT_BUTTON_LABEL;
  if (githubAccountButton) githubAccountButton.textContent = SWITCH_GITHUB_ACCOUNT_LABEL;
  if (vscodeAccountButton) vscodeAccountButton.textContent = editorAccountSwitchLabel(expected);
  // El orden de la causa: el primero es el principal.
  const buttonsByKey = { vscodeAccount: vscodeAccountButton, reconnect: button, githubAccount: githubAccountButton };
  copy.order.forEach((key, index) => {
    const element = buttonsByKey[key];
    if (!element) return;
    element.className = index === 0 ? "primary" : "secondary";
    if (element.style) element.style.order = String(index);
  });
  const setBusy = (value) => {
    if (button) button.disabled = value || !repoFullName;
    if (githubAccountButton) githubAccountButton.disabled = value || !repoFullName;
    // Cambiar la cuenta de VS Code no necesita el repositorio.
    if (vscodeAccountButton) vscodeAccountButton.disabled = value;
  };
  setBusy(false);
  if (!repoFullName) {
    setStatus(`Para reconectar, abre tu ejercicio desde ADACEEN («Abrir el ejercicio en mi editor»). «${editorAccountSwitchLabel(expected)}» funciona igual.`, true);
  }
  let busy = false;
  const failed = (text) => {
    busy = false;
    setBusy(false);
    setStatus(text || "No se pudo reconectar. Vuelve a intentar en un momento.", true);
  };
  button?.addEventListener("click", () => {
    if (busy || !repoFullName) return;
    busy = true;
    setBusy(true);
    // La ventana de espera se abre en el mismo clic (si no, el navegador la bloquea).
    const pendingWindow = openCodespaceWaitingWindow(repoFullName);
    setStatus(`Reconectando: sigue en la pestaña nueva. Allí ADACEEN te da un código nuevo para autorizarlo con ${expected ? `«${expected}»` : "tu cuenta"}.`);
    reconnectTunnelWorkspace({ repoFullName, pendingWindow })
      .then((ready) => {
        if (ready) {
          setStatus("Listo: tu editor abrió en la otra pestaña con tu cuenta. Ya puedes cerrar esta.");
          return;
        }
        failed(toText(overlayState.operationDetail));
      })
      .catch((error) => failed(error?.message || String(error)));
  });
  // «Cambiar a <cuenta>» (0.8.5): este aviso deja su lugar al del cambio de cuenta
  // (editor-account-switch.service.js), que cierra la sesion de la otra cuenta dentro de VS Code y
  // recarga. Sin ese archivo (sacado del manifest si una version de vscode.dev lo rompe), dice como
  // hacerlo a mano y los demas botones siguen.
  vscodeAccountButton?.addEventListener("click", () => {
    if (busy) return;
    if (!canAutoSwitch) {
      setStatus(EDITOR_ACCOUNT_SWITCH_MANUAL_TEXT, true);
      return;
    }
    busy = true;
    host.remove();
    startEditorAccountSwitch({ editorLogin: expected, tunnelName, attempt: brake.nextAttempt });
  });
  githubAccountButton?.addEventListener("click", () => {
    if (busy || !repoFullName) return;
    busy = true;
    setBusy(true);
    // La ventana para GitHub (y despues para la espera del editor) se abre en el mismo clic.
    const pendingWindow = window.open("about:blank", "_blank");
    setStatus("Sigue en la pestaña nueva: elige tu cuenta en GitHub y autoriza a ADACEEN. Después ADACEEN te prepara el editor a su nombre en esa misma pestaña.");
    switchTunnelGithubAccount({ repoFullName, pendingWindow })
      .then((started) => {
        if (!started) failed(toText(overlayState.statusMessage) || "No se pudo abrir GitHub. Vuelve a intentar en un momento.");
      })
      .catch((error) => failed(error?.message || String(error)));
  });
  root.getElementById("adaceenNotFoundClose")?.addEventListener("click", () => host.remove());
  document.documentElement.appendChild(host);
  return true;
}

// En vscode.dev/tunnel/<nombre>: si vscode.dev dice que no encuentra el tunel, el aviso con
// «Reconectar con mi cuenta». Se mira un rato despues de cargar (el dialogo tarda unos segundos).
async function watchTunnelNotFound() {
  const tunnelName = tunnelNameFromEditorUrl(location.href);
  if (!tunnelName || !isExtensionRuntimeReady()) return false;
  const startedAt = Date.now();
  for (;;) {
    if (document.getElementById(TUNNEL_NOT_FOUND_HOST_ID)) return true;
    if (tunnelNotFoundOnPage(tunnelName)) return showTunnelNotFoundBanner(tunnelName);
    if (Date.now() - startedAt >= TUNNEL_NOT_FOUND_WATCH_MS) return false;
    await new Promise((resolve) => window.setTimeout(resolve, TUNNEL_NOT_FOUND_CHECK_MS));
  }
}

// «Reconectar con mi cuenta»: prepare con reconnect (la VM cierra la sesion del tunel de la otra
// cuenta y pide un codigo nuevo); despues, el mismo camino de la primera vez (pasos 3 y 4).
async function reconnectTunnelWorkspace(options = {}) {
  const repoFullName = parseRepoFullName(options?.repoFullName);
  const pendingWindow = options?.pendingWindow && !options.pendingWindow.closed ? options.pendingWindow : null;
  if (!repoFullName || overlayState.githubAppBusy || myTunnelEditorOpening) {
    if (pendingWindow) pendingWindow.close();
    return false;
  }
  myTunnelEditorOpening = true;
  try {
    await syncFromStorageSnapshot({ force: true }).catch(() => false);
    if (!overlayState.workspaceProvider) overlayState.workspaceProvider = "tunnel";
    return await prepareTunnelWorkspace({ pendingWindow, repoFullName, reconnect: true, buttonLabel: RECONNECT_BUTTON_LABEL });
  } finally {
    myTunnelEditorOpening = false;
  }
}

// «Usar otra cuenta de GitHub» (0.8.1): el estudiante conecto a ADACEEN una cuenta que no era la
// suya. GitHub muestra su selector de cuentas; con la nueva, el OAuth sigue como la primera vez
// (continueAfterGithubOAuth prepara el editor de ese repositorio, ahora a nombre de esa cuenta).
async function switchTunnelGithubAccount(options = {}) {
  const repoFullName = parseRepoFullName(options?.repoFullName);
  const pendingWindow = options?.pendingWindow && !options.pendingWindow.closed ? options.pendingWindow : null;
  if (!repoFullName || overlayState.githubAppBusy || myTunnelEditorOpening) {
    if (pendingWindow) pendingWindow.close();
    return false;
  }
  await syncFromStorageSnapshot({ force: true }).catch(() => false);
  if (!overlayState.workspaceProvider) overlayState.workspaceProvider = "tunnel";
  // El token que hay ahora: la espera sigue cuando el backend guarde el de la cuenta elegida.
  try {
    await refreshGithubUserStatus();
  } catch {}
  await clearTunnelDeviceAccount();
  await clearTunnelSignInHint();
  await startGithubUserOAuthFlow({ pendingWindow, repoFullName, selectAccount: true });
  // Sin ventana de GitHub abierta, no arranco (el backend fallo o el navegador la bloqueo).
  return Boolean(getPendingGithubOAuthWindow());
}
