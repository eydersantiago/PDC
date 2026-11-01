"use strict";

// ADACEEN | Capa 3 - Servicios: OAuth de GitHub en las paginas de github.com: paso 1 de la primera vez y
// direccion de regreso rechazada. Movido sin cambios de github-auth.service.js.

// GitHub rechazo la direccion de regreso de ADACEEN (18 oct 2026): en la ventana del OAuth,
// github.com muestra «Be careful! The redirect_uri is not associated with this application»
// porque la direccion no esta en las «Redirect URIs» de la OAuth App. El content script de esa
// pagina lo anota aqui (y en el backend) y la pestana que esperaba deja de esperar.
const GITHUB_OAUTH_REDIRECT_ERROR_KEY = "adaceenGithubOAuthRedirectError";

const GITHUB_OAUTH_REDIRECT_ERROR_HELPER_ID = "adaceen-github-oauth-error-helper";

// Paso 1 de la primera vez (0.8.0): en GitHub (iniciar sesion y autorizar a ADACEEN).
const GITHUB_OAUTH_STEP_HELPER_ID = "adaceen-github-oauth-step-helper";

function getBackendOriginForMessages() {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl) || DEFAULT_BACKEND_URL;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return "";
  }
}

function isTrustedAdaceenBackendOrigin(origin) {
  const expectedOrigin = getBackendOriginForMessages();
  if (origin === expectedOrigin) return true;

  const localOrigins = new Set(["http://127.0.0.1:3000", "http://localhost:3000"]);
  return localOrigins.has(expectedOrigin) && localOrigins.has(toText(origin));
}

// La pagina de GitHub que rechaza la direccion de regreso de ADACEEN: {redirectUri} o null.
// Solo cuenta si el redirect_uri es del backend de ADACEEN (no la de otra aplicacion).
function githubOAuthRedirectErrorOnPage(href = location.href, doc = document) {
  try {
    const url = new URL(toText(href));
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return null;
    if (!url.pathname.toLowerCase().startsWith("/login/oauth/authorize")) return null;
    const redirectUri = toText(url.searchParams.get("redirect_uri"));
    if (!redirectUri) return null;
    let redirectOrigin = "";
    try {
      redirectOrigin = new URL(redirectUri).origin;
    } catch {
      return null;
    }
    if (!isTrustedAdaceenBackendOrigin(redirectOrigin)) return null;
    const title = toText(doc?.title);
    const bodyText = toText(doc?.body?.innerText || doc?.body?.textContent).slice(0, 6000);
    const rejected = /invalid redirect uri/i.test(title)
      || /redirect_uri\W{0,3}\s*is not associated with this application/i.test(bodyText);
    return rejected ? { redirectUri } : null;
  } catch {
    return null;
  }
}

// Que hacer, segun quien lo ve: el estudiante no puede ni debe configurar nada en GitHub.
function githubOAuthRedirectErrorText(role, redirectUri) {
  if (role === "admin" || role === "teacher") {
    return `GitHub rechazó la dirección de regreso de ADACEEN. El dueño de la OAuth App de ADACEEN debe agregar ${redirectUri} en «Redirect URIs» (github.com → Settings → Developer settings → OAuth Apps → la app de ADACEEN), sin «Allow wildcard matching», y pulsar «Update application». Es una sola vez para todos; después vuelve a pulsar el botón para abrir el editor.`;
  }
  return "GitHub no aceptó la conexión con ADACEEN porque la configuración de ADACEEN en GitHub todavía no está lista. No es un problema de tu cuenta y no tienes que configurar nada: avisa al docente y, cuando lo arregle, vuelve a pulsar el botón para abrir tu editor.";
}

async function readGithubOAuthRedirectError() {
  try {
    const stored = await chrome.storage.local.get(GITHUB_OAUTH_REDIRECT_ERROR_KEY);
    const entry = stored?.[GITHUB_OAUTH_REDIRECT_ERROR_KEY];
    return entry && typeof entry === "object" ? entry : null;
  } catch {
    return null;
  }
}

async function reportGithubOAuthRedirectError(redirectUri) {
  const baseUrl = normalizeBaseUrl(overlayState.backendUrl);
  if (!baseUrl || !overlayState.sessionId) return false;
  await fetchJsonWithTimeout(`${baseUrl}/api/github/oauth/redirect-error`, {
    method: "POST",
    headers: buildApiHeaders(),
    body: JSON.stringify({ redirectUri }),
  });
  return true;
}

// En la pagina de GitHub que rechaza la direccion de regreso: aviso fijo arriba (como el del
// codigo en github.com/login/device), lo anota para la pestana que espera y avisa al backend.
async function showGithubOAuthRedirectErrorHelper() {
  if (location.hostname.toLowerCase() !== "github.com" || !location.pathname.toLowerCase().startsWith("/login/oauth/authorize")) return false;
  await syncFromStorageSnapshot({ force: true }).catch(() => false);
  const info = githubOAuthRedirectErrorOnPage();
  if (!info) return false;
  const role = toText(overlayState.session?.user?.role);
  try {
    await chrome.storage.local.set({
      [GITHUB_OAUTH_REDIRECT_ERROR_KEY]: { at: Date.now(), redirectUri: info.redirectUri, userId: typeof getCurrentUserId === "function" ? getCurrentUserId() : "" },
    });
  } catch {
    // Sin storage la pestana que espera termina por tiempo.
  }
  reportGithubOAuthRedirectError(info.redirectUri).catch(() => false);

  document.getElementById(GITHUB_OAUTH_REDIRECT_ERROR_HELPER_ID)?.remove();
  const host = document.createElement("div");
  host.id = GITHUB_OAUTH_REDIRECT_ERROR_HELPER_ID;
  const root = host.attachShadow({ mode: "closed" });
  // Markup fijo; el texto entra con textContent.
  root.innerHTML = `
    <style>
      .box { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483646;
        display: grid; gap: 6px; box-sizing: border-box; width: min(640px, calc(100vw - 24px));
        padding: 12px 44px 12px 16px; border-radius: 10px; background: #2b1d04; color: #fff4dc;
        border: 1px solid #c99a2e; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
        font: 14px/1.45 Segoe UI, Arial, sans-serif; }
      strong { font-size: 15px; }
      p { margin: 0; }
      button { font: inherit; font-weight: 700; border-radius: 8px; border: 0; cursor: pointer; }
      button.close { position: absolute; top: 8px; right: 8px; background: transparent; color: #ffe2a3; padding: 4px 8px; }
      button:focus-visible { outline: 3px solid #ffd08a; outline-offset: 2px; }
    </style>
    <aside class="box" role="alert" aria-label="ADACEEN: GitHub no acepto la conexion">
      <strong>ADACEEN · GitHub no aceptó la conexión</strong>
      <p id="adaceenGithubOAuthErrorText"></p>
      <button type="button" class="close" id="adaceenGithubOAuthErrorClose" aria-label="Ocultar el aviso">&times;</button>
    </aside>`;
  const textEl = root.getElementById("adaceenGithubOAuthErrorText");
  if (textEl) textEl.textContent = githubOAuthRedirectErrorText(role, info.redirectUri);
  root.getElementById("adaceenGithubOAuthErrorClose")?.addEventListener("click", () => host.remove());
  (document.body || document.documentElement).appendChild(host);
  return true;
}

// La pagina de GitHub del OAuth de ADACEEN (autorizar) o su inicio de sesion previo (con
// return_to al autorizar): "authorize", "signin" o "".
function githubOAuthStepPage(href = location.href) {
  try {
    const url = new URL(toText(href));
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return "";
    const path = url.pathname.toLowerCase().replace(/\/+$/, "") || "/";
    let authorize = url;
    let page = "authorize";
    if (path === "/login" || path === "/session") {
      const returnTo = toText(url.searchParams.get("return_to"));
      if (!returnTo) return "";
      authorize = new URL(returnTo, "https://github.com");
      page = "signin";
    }
    if (!authorize.pathname.toLowerCase().startsWith("/login/oauth/authorize")) return "";
    const redirectUri = toText(authorize.searchParams.get("redirect_uri"));
    if (!redirectUri) return "";
    return isTrustedAdaceenBackendOrigin(new URL(redirectUri).origin) ? page : "";
  } catch {
    return "";
  }
}

// Paso 1 (0.8.0): que pulsar en GitHub y que la ventana sigue sola. No aparece si GitHub
// rechazo la direccion de regreso (ese aviso es otro).
async function showGithubOAuthStepHelper() {
  if (location.hostname.toLowerCase() !== "github.com") return false;
  await syncFromStorageSnapshot({ force: true }).catch(() => false);
  const page = githubOAuthStepPage();
  if (!page || githubOAuthRedirectErrorOnPage()) return false;
  document.getElementById(GITHUB_OAUTH_STEP_HELPER_ID)?.remove();
  const host = document.createElement("div");
  host.id = GITHUB_OAUTH_STEP_HELPER_ID;
  const root = host.attachShadow({ mode: "closed" });
  // Markup fijo; los textos entran con textContent.
  root.innerHTML = `
    <style>
      .box { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483646;
        display: grid; gap: 8px; box-sizing: border-box; width: min(640px, calc(100vw - 24px));
        padding: 14px 44px 14px 16px; border-radius: 10px; background: #06131b; color: #f8fbff;
        border: 1px solid rgba(118, 239, 229, 0.65); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
        font: 14px/1.45 Segoe UI, Arial, sans-serif; }
      p { margin: 0; color: #d9eaf0; }
      button { font: inherit; border: 0; border-radius: 8px; cursor: pointer; }
      button.close { position: absolute; top: 8px; right: 8px; background: transparent; color: #d9eaf0; padding: 4px 8px; }
      button:focus-visible { outline: 3px solid #ffd08a; outline-offset: 2px; }
      ${FIRST_TIME_STEPS_CSS}
    </style>
    <aside class="box" role="region" aria-label="ADACEEN: conecta tu cuenta de GitHub">
      <strong class="step-title">${firstTimeStepHeading("account")}</strong>
      ${firstTimeStepsMarkup("account")}
      <p id="adaceenGithubOAuthStepText"></p>
      <p id="adaceenGithubOAuthStepNext"></p>
      <button type="button" class="close" id="adaceenGithubOAuthStepClose" aria-label="Ocultar el aviso">&times;</button>
    </aside>`;
  const textEl = root.getElementById("adaceenGithubOAuthStepText");
  if (textEl) {
    textEl.textContent = page === "signin"
      ? "Inicia sesión en GitHub con tu cuenta (la que usas para el ejercicio). Después GitHub te pide autorizar a ADACEEN."
      : "Pulsa el botón verde para autorizar a ADACEEN. Solo lee tu usuario y tu correo de GitHub: no toca tus repositorios.";
  }
  const nextEl = root.getElementById("adaceenGithubOAuthStepNext");
  if (nextEl) nextEl.textContent = "No cierres esta ventana: después sigue sola con el paso 2 (encender tu editor).";
  root.getElementById("adaceenGithubOAuthStepClose")?.addEventListener("click", () => host.remove());
  (document.body || document.documentElement).appendChild(host);
  return true;
}

// En github.com, el paso 1 o, si GitHub rechazo la direccion de regreso, ese aviso.
async function showGithubOAuthPageHelper() {
  if (await showGithubOAuthRedirectErrorHelper()) return true;
  return showGithubOAuthStepHelper();
}
