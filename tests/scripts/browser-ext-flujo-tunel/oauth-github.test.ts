import assert from "node:assert/strict";
import test from "node:test";
import { BACKEND, REPO, TUNNEL_URL, SESSION, type Json } from "./harness-config.js";
import { TabEnv } from "./harness-tab.js";
import { FakeBrowser } from "./harness-backend.js";
import { drive, openTab, advance, assertKnownShadowIds, seedLoggedInBrowser } from "./harness-utils.js";

// 18 oct 2026: la direccion de ADACEEN no estaba en las «Redirect URIs» de su OAuth App y GitHub
// mostraba «Be careful! The redirect_uri is not associated with this application» en la ventana
// del OAuth; el overlay seguia en «Esperando autorizacion GitHub» para siempre.
async function openGithubRejectionTab(browser: FakeBrowser, redirectUri: string) {
  const url = `https://github.com/login/oauth/authorize?client_id=Ov23prueba&redirect_uri=${encodeURIComponent(redirectUri)}&scope=read%3Auser+user%3Aemail&state=estado`;
  const tab = new TabEnv(browser, url, "Invalid Redirect URI");
  tab.document.body.textContent = "Be careful! The `redirect_uri` is not associated with this application. The application might be misconfigured or could be trying to redirect you to a website you weren't expecting.";
  tab.load();
  await browser.clock.settle();
  return tab;
}

test("OAuth rechazado por GitHub: aviso en la ventana de GitHub, la espera se corta y el backend lo anota", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, `${REPO}: taller`);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"));
  await browser.clock.until(() => tab.state().loading === false && tab.state().workspaceProvider === "tunnel");
  assert.equal(tab.el("setupPrimaryActionBtn").dataset.contextAction, "connect_github_user");

  await drive(browser, tab.el("setupPrimaryActionBtn").click());
  assert.equal(tab.popups.length, 1, "la ventana del OAuth");
  assert.equal(tab.state().operationTitle, "Esperando autorizacion GitHub");

  // Otra aplicacion con el mismo error en GitHub: no es de ADACEEN, no se toca.
  const otherApp = await openGithubRejectionTab(browser, "https://otra-app.example.com/callback");
  assert.equal(otherApp.document.getElementById("adaceen-github-oauth-error-helper"), null, "sin aviso para otra aplicacion");
  assert.equal(browser.storage.adaceenGithubOAuthRedirectError, undefined);

  // La ventana del OAuth de ADACEEN termina en el rechazo de GitHub.
  const rejected = await openGithubRejectionTab(browser, `${BACKEND}/auth/github/callback`);
  await browser.clock.until(() => !!rejected.document.getElementById("adaceen-github-oauth-error-helper"), 50);
  const helper = rejected.document.getElementById("adaceen-github-oauth-error-helper");
  assert.ok(helper?.shadow, "aviso fijo en la pagina de GitHub");
  const helperText = helper!.shadow!.getElementById("adaceenGithubOAuthErrorText").textContent;
  assert.match(helperText, /no tienes que configurar nada: avisa al docente/, "el estudiante no configura nada en GitHub");
  assert.doesNotMatch(helperText, /Developer settings/, "al estudiante no se le manda a la configuracion de GitHub");
  assert.equal((browser.storage.adaceenGithubOAuthRedirectError as Json)?.redirectUri, `${BACKEND}/auth/github/callback`);
  const reports = browser.requestsTo("/api/github/oauth/redirect-error", "POST");
  assert.equal(reports.length, 1, "el backend lo anota para /api/health y el monitor");
  assert.deepEqual(reports[0].body, { redirectUri: `${BACKEND}/auth/github/callback` });
  assertKnownShadowIds(rejected);

  // La pestana que esperaba deja de esperar en la siguiente consulta y dice que hacer.
  await advance(browser, 3000);
  assert.equal(tab.state().operationKind, "error");
  assert.equal(tab.state().operationTitle, "GitHub no aceptó la conexión");
  assert.match(tab.state().statusMessage, /avisa al docente/);
  const statusChecks = browser.requestsTo("/api/github/oauth/status").length;
  await advance(browser, 20_000);
  assert.equal(browser.requestsTo("/api/github/oauth/status").length, statusChecks, "ya no sigue consultando");
});

test("OAuth rechazado por GitHub: el docente o administrador lee que direccion poner en la OAuth App", async () => {
  const browser = new FakeBrowser();
  browser.session = { ...SESSION, user: { ...SESSION.user, role: "teacher", assignedCourseCodes: [] } };
  seedLoggedInBrowser(browser);
  const rejected = await openGithubRejectionTab(browser, `${BACKEND}/auth/github/callback`);
  await browser.clock.until(() => !!rejected.document.getElementById("adaceen-github-oauth-error-helper"), 50);
  const text = rejected.document.getElementById("adaceen-github-oauth-error-helper")!.shadow!.getElementById("adaceenGithubOAuthErrorText").textContent;
  assert.ok(text.includes(`agregar ${BACKEND}/auth/github/callback en «Redirect URIs»`), text);
  assert.match(text, /Es una sola vez para todos/);
});

test("OAuth sin respuesta: al vencer la espera el overlay lo dice en vez de quedarse esperando", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, `${REPO}: taller`);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"));
  await browser.clock.until(() => tab.state().loading === false && tab.state().workspaceProvider === "tunnel");
  await drive(browser, tab.el("setupPrimaryActionBtn").click());
  assert.equal(tab.state().operationTitle, "Esperando autorizacion GitHub");
  await advance(browser, 185_000);
  assert.equal(tab.state().operationKind, "error");
  assert.equal(tab.state().operationTitle, "No se completó la conexión con GitHub");
  assert.match(tab.state().statusMessage, /vuelve a pulsar el botón para abrir tu editor/);
});

test("0.8.0: «Abrir el ejercicio en mi editor» desde una pagina sin repositorio sigue sola despues de autorizar GitHub", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  // github.com sin repositorio (como /empezar o Campus): antes, al volver del OAuth, pedia pulsar otra vez.
  const tab = await openTab(browser, "https://github.com/", "GitHub");
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"));
  await drive(browser, tab.run("refreshWorkspaceProvider(true)"));
  assert.equal(tab.run("getCurrentRepoFullName()"), "", "la pagina no tiene repositorio");

  browser.prepareSteps = [browser.deviceCode()];
  browser.statusSteps = [browser.deviceCode(), browser.ready()];
  await drive(browser, tab.run(`openMyTunnelEditor({ repoFullName: "${REPO}", buttonLabel: "Abrir el ejercicio en mi editor" })`));
  assert.equal(tab.popups.length, 1, "la ventana de espera sirve para el OAuth");
  const oauthWindow = tab.popups[0];
  assert.match(oauthWindow.currentHref, /^https:\/\/github\.com\/login\/oauth\/authorize/);
  const start = browser.requestsTo("/api/github/oauth/start", "POST");
  assert.deepEqual(start[0].body, { repoFullName: REPO }, "el repositorio va con el OAuth");

  // GitHub autoriza y el callback avisa: el editor se prepara solo, con ese repositorio y en la misma ventana.
  browser.githubConnected = true;
  oauthWindow.location.href = `${BACKEND}/auth/github/callback?code=x&state=estado`;
  const done = tab.dispatchWindowEvent("message", { data: { type: "ADACEEN_GITHUB_OAUTH_CONNECTED", repoFullName: REPO }, origin: BACKEND });
  await browser.clock.until(() => browser.requestsTo("/api/workspaces/prepare", "POST").length > 0, 400);
  assert.equal((browser.requestsTo("/api/workspaces/prepare", "POST")[0].body as Json)?.repoFullName, REPO);
  await browser.clock.until(() => oauthWindow.currentHref === TUNNEL_URL, 800);
  await done;
  assert.equal(oauthWindow.currentHref, TUNNEL_URL, "termina en el editor sin otro clic");
  assert.doesNotMatch(String(tab.state().statusMessage), /Vuelve a tu repositorio/);
  assert.equal(tab.popups.length, 1);
});

async function openGithubPage(browser: FakeBrowser, url: string, title: string, bodyText = "") {
  const tab = new TabEnv(browser, url, title);
  if (bodyText) tab.document.body.textContent = bodyText;
  tab.load();
  await browser.clock.settle();
  return tab;
}

test("0.8.0 (paso 1): en GitHub, iniciar sesion y autorizar a ADACEEN dicen que pulsar y que la ventana sigue sola", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const authorize = `/login/oauth/authorize?client_id=Ov23prueba&redirect_uri=${encodeURIComponent(`${BACKEND}/auth/github/callback`)}&scope=read%3Auser&state=estado`;
  const stepOf = (tab: TabEnv) => tab.document.getElementById("adaceen-github-oauth-step-helper");

  const page = await openGithubPage(browser, `https://github.com${authorize}`, "Authorize application");
  await browser.clock.until(() => !!stepOf(page), 50);
  assert.match(String(stepOf(page)!.shadow!.innerHTML), /Paso 1 de 4 · Tu cuenta de GitHub/);
  assert.match(String(stepOf(page)!.shadow!.getElementById("adaceenGithubOAuthStepText").textContent), /Pulsa el botón verde para autorizar a ADACEEN\. Solo lee tu usuario y tu correo de GitHub/);
  assert.match(String(stepOf(page)!.shadow!.getElementById("adaceenGithubOAuthStepNext").textContent), /No cierres esta ventana/);

  const login = await openGithubPage(browser, `https://github.com/login?client_id=Ov23prueba&return_to=${encodeURIComponent(authorize)}`, "Sign in to GitHub");
  await browser.clock.until(() => !!stepOf(login), 50);
  assert.match(String(stepOf(login)!.shadow!.getElementById("adaceenGithubOAuthStepText").textContent), /^Inicia sesión en GitHub con tu cuenta/);

  // Otra aplicacion, o GitHub rechazando la direccion de ADACEEN: no es el paso 1.
  const other = await openGithubPage(browser, "https://github.com/login/oauth/authorize?client_id=otra&redirect_uri=https%3A%2F%2Fotra.example.com%2Fcb", "Authorize application");
  await advance(browser, 500);
  assert.equal(stepOf(other), null);
  const rejected = await openGithubPage(browser, `https://github.com${authorize}`, "Invalid Redirect URI", "Be careful! The `redirect_uri` is not associated with this application.");
  await browser.clock.until(() => !!rejected.document.getElementById("adaceen-github-oauth-error-helper"), 50);
  assert.equal(stepOf(rejected), null, "con el rechazo sale el otro aviso");
  assertKnownShadowIds(page, login, other, rejected);
});

test("0.8.0 (paso 4): en GitHub, autorizar «Visual Studio Code» lleva la cuenta correcta mientras vale el aviso", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const vscodeAuthorize = "https://github.com/login/oauth/authorize?client_id=01ab8ac9400c4e429b23&redirect_uri=https%3A%2F%2Fvscode.dev%2Fredirect&scope=read%3Auser&state=x";
  const bannerOf = (tab: TabEnv) => tab.document.getElementById("adaceen-tunnel-signin-github");

  // Sin aviso pendiente (otro uso de VS Code), no se muestra nada.
  const none = await openGithubPage(browser, vscodeAuthorize, "Authorize Visual Studio Code");
  await advance(browser, 500);
  assert.equal(bannerOf(none), null);

  browser.storage.adaceenTunnelSignInHint = { userId: SESSION.user.id, tunnelName: "ws-alumno", githubLogin: "alumno", expiresAt: browser.clock.now + 5 * 60_000 };
  const page = await openGithubPage(browser, vscodeAuthorize, "Authorize Visual Studio Code");
  await browser.clock.until(() => !!bannerOf(page), 50);
  assert.match(String(bannerOf(page)!.shadow!.innerHTML), /Paso 4 de 4 · Entrar a VS Code/);
  assert.match(String(bannerOf(page)!.shadow!.getElementById("adaceenTunnelSignInText").textContent), /autoriza «Visual Studio Code» con la cuenta «alumno»/);
  const signIn = await openGithubPage(browser, `https://github.com/login?return_to=${encodeURIComponent(vscodeAuthorize.replace("https://github.com", ""))}`, "Sign in to GitHub");
  await browser.clock.until(() => !!bannerOf(signIn), 50);
  assert.match(String(bannerOf(signIn)!.shadow!.getElementById("adaceenTunnelSignInText").textContent), /GitHub te pide iniciar sesión para que VS Code entre a tu editor/);
  assert.ok(browser.storage.adaceenTunnelSignInHint, "mostrarlo no lo gasta: sigue para vscode.dev");
  assertKnownShadowIds(none, page, signIn);
});
