// Entorno por tunel, paso 3: el codigo de dispositivo en una sola pestana (handoff en storage) y el
// codigo puesto solo en el formulario de github.com/login/device. Constantes en workspace.service.js.

// ---- Codigo de dispositivo en una sola pestana ----

function isGithubDeviceLoginUrl(value) {
  try {
    const url = new URL(toText(value));
    return url.protocol === "https:"
      && url.hostname.toLowerCase() === "github.com"
      && /^\/login\/device(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function isGithubDeviceLoginPage() {
  return isGithubDeviceLoginUrl(location.href);
}

// En que paso del codigo de dispositivo esta una pagina de GitHub:
//  - "signin": GitHub pide iniciar sesion antes de mostrar los cuadros del codigo;
//  - "code": github.com/login/device, los cuadros del codigo;
//  - "authorize": despues del codigo (autorizar Visual Studio Code, elegir cuenta...);
//  - "done" / "failed": GitHub confirmo o rechazo.
// "" en cualquier otra pagina.
function githubDeviceFlowStep(value = location.href) {
  try {
    const url = new URL(toText(value));
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return "";
    const path = url.pathname.toLowerCase().replace(/\/+$/, "") || "/";
    if (path === "/login/device") return "code";
    if (path.startsWith("/login/device/")) {
      if (/success|done|complete/.test(path)) return "done";
      if (/fail|denied|error|cancel/.test(path)) return "failed";
      return "authorize";
    }
    if (path === "/login" || path === "/session" || path.startsWith("/sessions/")) return "signin";
    return "";
  } catch {
    return "";
  }
}

// Cuenta de GitHub abierta en esta pagina (GitHub la publica en <meta name="user-login">), en
// minusculas; "" sin sesion o si GitHub no la publica.
function readGithubSignedInLogin() {
  const meta = document.querySelector('meta[name="user-login"]') || document.querySelector('meta[name="octolytics-actor-login"]');
  return normalizeGithubLoginHint(meta?.getAttribute?.("content"));
}

function normalizeDeviceUserCode(value) {
  const code = toText(value).toUpperCase();
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code) ? code : "";
}

// Login de GitHub en minusculas (como lo usa el tunel), o "".
function normalizeGithubLoginHint(value) {
  const login = toText(value).toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(login) ? login : "";
}

// La cuenta con la que hay que autorizar el codigo y entrar a vscode.dev: la del tunel (el
// backend la manda en workspace.login) o, si no vino, la conectada en ADACEEN.
function expectedTunnelGithubLogin(info) {
  return normalizeGithubLoginHint(info?.login) || normalizeGithubLoginHint(overlayState.githubUserStatus?.accountLogin);
}

// El handoff queda ligado al usuario de ADACEEN que pidio el codigo (equipos compartidos).
async function saveDeviceCodeHandoff(info, repoFullName, buttonLabel = "") {
  const userCode = normalizeDeviceUserCode(info?.userCode);
  const userId = getCurrentUserId();
  if (!userCode || !userId || !isExtensionRuntimeReady()) return false;
  const now = Date.now();
  const reportedExpiry = Date.parse(toText(info?.expiresAt));
  const expiresAt = Number.isFinite(reportedExpiry) && reportedExpiry > now
    ? Math.min(reportedExpiry, now + DEVICE_CODE_HANDOFF_TTL_MS)
    : now + DEVICE_CODE_HANDOFF_TTL_MS;
  try {
    await chrome.storage.local.set({
      [STORAGE_KEY_DEVICE_CODE_HANDOFF]: {
        userCode,
        userId,
        repoFullName: parseRepoFullName(repoFullName),
        githubLogin: expectedTunnelGithubLogin(info),
        buttonLabel: TUNNEL_RETRY_BUTTON_LABELS.includes(toText(buttonLabel)) ? toText(buttonLabel) : "",
        expiresAt,
        savedAt: now,
        aliveAt: now,
      },
    });
    return true;
  } catch {
    return false;
  }
}

function normalizeDeviceCodeHandoff(raw) {
  const userCode = normalizeDeviceUserCode(raw?.userCode);
  const expiresAt = Number(raw?.expiresAt) || 0;
  if (!userCode || expiresAt <= Date.now()) return null;
  return {
    userCode,
    userId: toText(raw?.userId),
    repoFullName: parseRepoFullName(raw?.repoFullName),
    githubLogin: normalizeGithubLoginHint(raw?.githubLogin),
    buttonLabel: TUNNEL_RETRY_BUTTON_LABELS.includes(toText(raw?.buttonLabel)) ? toText(raw?.buttonLabel) : "",
    expiresAt,
    savedAt: Number(raw?.savedAt) || 0,
    aliveAt: Number(raw?.aliveAt) || Number(raw?.savedAt) || 0,
    outcome: toText(raw?.outcome),
    message: toText(raw?.message),
    // «Cambiar de cuenta» (0.8.1): el estudiante salio de GitHub para entrar con la correcta.
    switching: raw?.switching === true,
  };
}

async function readDeviceCodeHandoff() {
  if (!isExtensionRuntimeReady()) return null;
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY_DEVICE_CODE_HANDOFF]);
    const raw = stored?.[STORAGE_KEY_DEVICE_CODE_HANDOFF];
    const handoff = normalizeDeviceCodeHandoff(raw);
    if (!handoff) {
      if (raw) await chrome.storage.local.remove([STORAGE_KEY_DEVICE_CODE_HANDOFF]).catch(() => {});
      return null;
    }
    return handoff;
  } catch {
    return null;
  }
}

// Actualiza el handoff solo si sigue siendo el de este codigo (otra espera pudo reemplazarlo).
async function updateDeviceCodeHandoff(userCode, patch) {
  if (!userCode || !isExtensionRuntimeReady()) return false;
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY_DEVICE_CODE_HANDOFF]);
    const raw = stored?.[STORAGE_KEY_DEVICE_CODE_HANDOFF];
    if (!raw || normalizeDeviceUserCode(raw.userCode) !== userCode || raw.outcome) return false;
    await chrome.storage.local.set({ [STORAGE_KEY_DEVICE_CODE_HANDOFF]: { ...raw, ...patch(raw) } });
    return true;
  } catch {
    return false;
  }
}

function touchDeviceCodeHandoff(userCode) {
  return updateDeviceCodeHandoff(userCode, () => ({ aliveAt: Date.now() }));
}

// La espera termino sin editor (error, tiempo agotado o excepcion): el aviso abierto en
// github.com/login/device lo muestra en vez de seguir prometiendo que abrira el editor.
function settleDeviceCodeHandoffWithError(userCode, message) {
  return updateDeviceCodeHandoff(userCode, (raw) => ({
    outcome: "error",
    message: toText(message).slice(0, 280),
    expiresAt: Math.min(Number(raw.expiresAt) || 0, Date.now() + DEVICE_CODE_OUTCOME_TTL_MS),
  }));
}

async function clearDeviceCodeHandoff() {
  if (!isExtensionRuntimeReady()) return;
  try {
    await chrome.storage.local.remove([STORAGE_KEY_DEVICE_CODE_HANDOFF]);
  } catch {}
}

// La ventana de espera pasa a github.com/login/device. Solo esa URL (A12.8): el backend
// no elige a donde navega la ventana.
function openDeviceLoginInWaitingWindow(pendingWindow, verificationUrl) {
  if (!pendingWindow || pendingWindow.closed) return false;
  const target = isGithubDeviceLoginUrl(verificationUrl) ? toSafeHttpUrl(verificationUrl) : GITHUB_DEVICE_LOGIN_URL;
  try {
    pendingWindow.location.href = target;
    return true;
  } catch {
    return false;
  }
}

async function showDeviceCodeStep(pendingWindow, info, repoFullName = "", buttonLabel = "") {
  const detail = `${firstTimeStepHeading("authorize")} (obligatorio la primera vez): abre ${info.verificationUrl}, escribe el código ${info.userCode}, pulsa Continue y autoriza «Visual Studio Code». Sin este paso tu editor no abre.`;
  setOperationProgress(`Autoriza tu editor: codigo ${info.userCode}`, detail);
  updateCodespaceWaitingWindow(
    pendingWindow,
    `Codigo de autorizacion: ${info.userCode}`,
    detail,
    "",
    info.verificationUrl,
  );
  try {
    const quickLink = pendingWindow?.document?.getElementById("adaceenOpenQuickstartLink");
    if (quickLink) quickLink.textContent = `Abrir github.com/login/device (codigo ${info.userCode})`;
  } catch {
    // La ventana pudo navegar a otro origen; no pasa nada.
  }
  try {
    // Mejor esfuerzo: si el navegador lo permite, el codigo queda en el portapapeles.
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(info.userCode).catch(() => {});
    }
  } catch {
    // Sin permiso de portapapeles; el codigo sigue a la vista.
  }

  // Una sola pestana: la ventana de espera pasa a github.com/login/device, donde este mismo
  // content script muestra el codigo (showGithubDeviceCodeHelper), y al confirmar el tunel
  // navigatePendingCodespaceWindow la lleva al editor. Sin el codigo guardado no se navega:
  // la pagina de espera lo sigue mostrando.
  if (!pendingWindow || pendingWindow.closed) return false;
  if (!(await saveDeviceCodeHandoff(info, repoFullName, buttonLabel))) return false;
  const moved = openDeviceLoginInWaitingWindow(pendingWindow, info.verificationUrl);
  if (moved) {
    setOperationProgress(
      `Autoriza tu editor: codigo ${info.userCode}`,
      `La otra pestana abrio github.com/login/device con el codigo ${info.userCode} ya escrito (si no, pegalo): pulsa Continue y autoriza. Cuando GitHub confirme, esa misma pestana abrira tu editor.`,
    );
  }
  return moved;
}

// ---- El codigo puesto solo en el formulario de GitHub (0.7.21; en la rama de la nube, 0.7.20) ----
// github.com/login/device ("Device Activation") pide el codigo en un campo XXXX-XXXX o en
// ocho cuadros de un caracter. Se escribe ahi para que el estudiante solo pulse Continue y
// autorice. Nunca se envia el formulario: autorizar es decision del estudiante. Si GitHub
// cambia el formulario y no se reconoce, no se toca nada y el aviso sigue pidiendo pegarlo.
const DEVICE_CODE_FILL_RETRY_MS = 700;

const DEVICE_CODE_FILL_ATTEMPTS = 4;

const DEVICE_CODE_FILLED_TEXT = "El codigo ya esta en el formulario: pulsa Continue y autoriza con tu cuenta de GitHub. Esta pestana abrira tu editor sola.";

function deviceCodeFieldType(input) {
  return toText(input?.type || input?.getAttribute?.("type") || "text").toLowerCase();
}

function isTypableDeviceCodeField(input) {
  if (!input || input.disabled || input.readOnly) return false;
  return ["text", "tel", "number", "search", ""].includes(deviceCodeFieldType(input));
}

// Los campos donde va el codigo: los que se llaman user_code / device-code (uno o varios)
// o, sin nombre reconocible, ocho o mas cuadros de un caracter.
function deviceCodeFieldsOf(form) {
  const inputs = Array.from(form?.querySelectorAll?.("input") || []).filter(isTypableDeviceCodeField);
  const named = inputs.filter((input) => /user[-_]?code|device[-_]?code/i.test(
    [input.name, input.id, input.className, input.getAttribute?.("aria-label")].map(toText).join(" "),
  ));
  if (named.length) return named;
  const boxes = inputs.filter((input) => Number(input.maxLength ?? input.getAttribute?.("maxlength")) === 1);
  return boxes.length >= 8 ? boxes : [];
}

function deviceCodeFormOf(doc) {
  const forms = Array.from(doc?.querySelectorAll?.("form") || []);
  const withFields = forms.filter((form) => deviceCodeFieldsOf(form).length > 0);
  return withFields.find((form) => /\/login\/device(?:[/?#]|$)/.test(toText(form.getAttribute?.("action"))))
    || withFields[0]
    || null;
}

function composedDeviceCode(fields) {
  return fields.map((field) => toText(field.value)).join("").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function dispatchDeviceCodeInputEvents(field, data) {
  for (const type of ["input", "change"]) {
    let event = null;
    try {
      if (type === "input" && typeof InputEvent === "function") {
        event = new InputEvent(type, { bubbles: true, inputType: "insertText", data });
      } else if (typeof Event === "function") {
        event = new Event(type, { bubbles: true });
      }
    } catch {
      event = null;
    }
    if (!event) continue;
    try {
      field.dispatchEvent?.(event);
    } catch {}
  }
}

// Escribe como lo haria el teclado: el setter nativo (los scripts de la pagina ven el cambio)
// y los eventos input y change.
function setDeviceCodeField(field, value) {
  try {
    const proto = typeof HTMLInputElement === "function" ? HTMLInputElement.prototype : null;
    const setter = proto ? Object.getOwnPropertyDescriptor(proto, "value")?.set : null;
    if (setter && field instanceof HTMLInputElement) setter.call(field, value);
    else field.value = value;
  } catch {
    field.value = value;
  }
  dispatchDeviceCodeInputEvents(field, value);
}

// Como pegar en el primer cuadro: GitHub reparte el codigo entre los cuadros al pegar.
function pasteDeviceCodeInto(field, userCode) {
  if (typeof ClipboardEvent !== "function" || typeof DataTransfer !== "function") return false;
  try {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", userCode);
    field.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    return true;
  } catch {
    return false;
  }
}

// true solo si el codigo quedo en los campos (se comprueba leyendolos despues de escribir).
function fillGithubDeviceCodeForm(userCode) {
  const code = normalizeDeviceUserCode(userCode);
  if (!code) return false;
  const form = deviceCodeFormOf(document);
  const fields = form ? deviceCodeFieldsOf(form) : [];
  if (!fields.length) return false;
  const plain = code.replace("-", "");
  const matches = () => composedDeviceCode(fields) === plain;
  if (!matches()) {
    if (fields.length === 1) {
      setDeviceCodeField(fields[0], code);
    } else {
      pasteDeviceCodeInto(fields[0], code);
      if (!matches()) {
        const chars = fields.length === code.length ? code : plain;
        fields.forEach((field, index) => setDeviceCodeField(field, index < chars.length ? chars[index] : ""));
      }
    }
  }
  if (!matches()) return false;
  // Si el formulario guarda el codigo completo en un campo oculto, tambien se pone ahi.
  for (const hidden of Array.from(form.querySelectorAll?.("input") || [])) {
    if (deviceCodeFieldType(hidden) === "hidden" && /user[-_]?code/i.test(toText(hidden.name)) && toText(hidden.value) !== code) {
      try {
        hidden.value = code;
      } catch {}
    }
  }
  return true;
}
