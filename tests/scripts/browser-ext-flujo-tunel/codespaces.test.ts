import assert from "node:assert/strict";
import test from "node:test";
import { BACKEND, REPO, TUNNEL_URL, CODESPACE_URL, SESSION, type Json } from "./harness-config.js";
import { FakeBrowser } from "./harness-backend.js";
import { drive, advance, assertKnownShadowIds, seedLoggedInBrowser } from "./harness-utils.js";
import { EDITOR_KEY, openCodespacesTour } from "./harness-helpers.js";

const CODESPACES_TOUR_REMOVED_IDS = [
  "setupToStep2Btn",
  "setupStepTwoCard",
  "setupStepThreeCard",
  "setupInstallAppBtn",
  "setupRefreshAppBtn",
  "setupBackToStep1Btn",
  "setupToStep3Btn",
  "setupCreatePrBtn",
  "setupBackToStep2Btn",
  "setupContinueBtn",
  "setupExploreBtn",
  "processNoticeModal",
  "processNoticeConfirmBtn",
];

test("Codespaces: boton unico, la GitHub App se detecta sola y se crean el PR y el Codespace (item 2, contrato (d))", async () => {
  const browser = new FakeBrowser();
  browser.provider = "codespaces";
  seedLoggedInBrowser(browser, {
    // Un editor de tunel guardado de antes no cambia el flujo de Codespaces.
    adaceenEditorByUser: {
      [`${SESSION.user.id}:${REPO}`]: { repoFullName: REPO, webUrl: TUNNEL_URL, provider: "tunnel", savedAt: "2026-09-24T15:00:00.000Z" },
    },
  });
  const tab = await openCodespacesTour(browser);
  // El icono entra directo tambien con Codespaces (sin «Empezar»).
  assert.equal(tab.state().started, true, "sin pulsar Empezar");

  // Una tarjeta (el repositorio) y un solo boton: sin «Autorizar repositorio», «Abrir
  // instalacion», «Verificar acceso», «Preparar entorno», «Crear PR», «Ir al dashboard» ni
  // el aviso «Entendido».
  assert.equal(tab.el("setupView").hidden, false, "sin setup completo se muestra el tour");
  assert.equal(tab.el("setupViewTitle").textContent, "Preparar repositorio");
  assert.equal(tab.el("setupStepOneTitle").textContent, "Tu repositorio");
  assert.equal(tab.el("setupStepOneCard").hidden, false);
  const markup = tab.run<string>("buildOverlayMarkup()");
  for (const id of CODESPACES_TOUR_REMOVED_IDS) {
    assert.doesNotMatch(markup, new RegExp(`id="${id}"`), `sin ${id}`);
  }
  assert.doesNotMatch(markup, /Verificar acceso|Entendido|Abrir instalacion/);
  assert.equal(tab.el("setupDetectRepoBtn").hidden, true, "el repo ya sale de la pagina");
  assert.equal(tab.el("setupOpenLocalVscodeBtn").disabled, false, "VS Code de este equipo sigue a mano");
  assert.equal(tab.el("setupPrimaryActionBtn").dataset.contextAction, "connect_github", "pide la GitHub App");
  assert.equal(tab.el("setupPrimaryActionBtn").textContent, "Autorizar GitHub App");
  assert.equal(tab.el("setupSecondaryActionBtn").hidden, true, "boton unico");
  const setupStatus = () => tab.run<string>("(() => { const flow = getSetupFlowState(overlayState.context); return buildSetupStatusText(overlayState.context, resolveCurrentSetupStep(flow), flow); })()");
  assert.match(setupStatus(), /^Paso 2\/3: instala o autoriza la GitHub App/);
  assert.ok(browser.requestsTo("/api/github-app/status").length >= 1, "con Codespaces si se consulta la GitHub App");
  const rows = tab.run<Array<{ label: string; status: string }>>("buildConnectionItems(overlayState.context, getSetupFlowState(overlayState.context))");
  assert.deepEqual(Array.from(rows, (item) => item.label), ["ADACEEN", "GitHub App", "GitHub OAuth", "Codespaces"]);
  tab.run("overlayState.setupWizardStep = 3");
  assert.equal(tab.run("resolveCurrentSetupStep(getSetupFlowState(overlayState.context))"), 2, "sin App no se pasa al paso 3");

  // Al llegar al paso de la App se intento una vez vincular una instalacion hecha fuera del
  // enlace (aqui no la hay: 404) antes de pedir que se abra la pestana de instalacion.
  assert.equal(browser.requestsTo("/api/github-app/link-installation-auto", "POST").length, 1, "una vinculacion al entrar");

  // 1) «Autorizar GitHub App» abre la instalacion (sin opener) y ADACEEN consulta el estado
  // cada pocos segundos: sin «Verificar acceso».
  const statusBefore = browser.requestsTo("/api/github-app/status").length;
  const linksBefore = browser.requestsTo("/api/github-app/link-installation-auto", "POST").length;
  await drive(browser, tab.el("setupPrimaryActionBtn").click());
  assert.equal(tab.popups.length, 1);
  const installWindow = tab.popups[0];
  assert.match(installWindow.currentHref, /^https:\/\/github\.com\/apps\/[^/]+\/installations\/new/);
  assert.equal(installWindow.opener, null, "la pagina de GitHub no alcanza la pestana del overlay");
  assert.equal(tab.run("isWatchingGithubAppInstall()"), true);
  assert.equal(tab.el("setupActionTitle").textContent, "Esperando la GitHub App");
  assert.match(setupStatus(), /^Paso 2\/3: termina la instalacion de la GitHub App en la pestana de GitHub\. ADACEEN la detecta sola/);
  assert.equal(tab.el("setupOperationBanner").hidden, false);
  assert.equal(tab.el("setupOperationTitle").textContent, "Esperando la GitHub App");
  assert.equal(tab.el("setupPrimaryActionBtn").textContent, "Autorizar GitHub App", "si cerro la pestana, la vuelve a abrir");
  assert.equal(tab.el("setupSecondaryActionBtn").hidden, true);
  await advance(browser, 13_000);
  const polled = browser.requestsTo("/api/github-app/status").length - statusBefore;
  assert.ok(polled >= 3 && polled <= 4, `consulta cada 4 s (${polled} consultas en 13 s)`);
  assert.equal(browser.requestsTo("/api/github-app/link-installation-auto", "POST").length - linksBefore, 1, "prueba vincular una instalacion hecha fuera del enlace");

  // La pagina de retorno de la App registra la instalacion: el tour avanza solo.
  browser.appStatus = { configured: true, installation: { accountLogin: "alumno" }, hasRepoAccess: true, bootstrapReady: false };
  await advance(browser, 4_500);
  assert.equal(tab.run("isWatchingGithubAppInstall()"), false, "deja de consultar al detectarla");
  assert.equal(tab.el("setupPrimaryActionBtn").dataset.contextAction, "connect_github_user");
  assert.equal(tab.el("setupPrimaryActionBtn").textContent, "Conectar GitHub");
  assert.equal(tab.el("setupSecondaryActionBtn").hidden, true);
  assert.equal(tab.el("setupOperationBanner").hidden, true);
  assert.match(tab.el("setupStatusText").textContent, new RegExp(`^GitHub App lista: ya tiene acceso a ${REPO}\\. Ahora pulsa Conectar GitHub`));
  const afterDetect = browser.requestsTo("/api/github-app/status").length;
  await advance(browser, 30_000);
  assert.equal(browser.requestsTo("/api/github-app/status").length, afterDetect, "sin consultas despues de detectarla");
  assert.equal(browser.requestsTo("/api/github-app/install-url", "POST").length, 1);

  // 2) «Conectar GitHub»: OAuth y, al volver, el PR y el Codespace se crean y se abren en esa
  // misma ventana (sin «Preparar entorno ADACEEN» ni «Entendido»).
  await drive(browser, tab.el("setupPrimaryActionBtn").click());
  assert.equal(tab.popups.length, 2);
  const oauthWindow = tab.popups[1];
  assert.match(oauthWindow.currentHref, /^https:\/\/github\.com\/login\/oauth\/authorize/);
  browser.githubConnected = true;
  browser.githubCodespaceScope = true;
  oauthWindow.location.href = `${BACKEND}/auth/github/callback?code=x&state=estado`;
  const oauthDone = tab.dispatchWindowEvent("message", { data: { type: "ADACEEN_GITHUB_OAUTH_CONNECTED" }, origin: BACKEND });
  await browser.clock.until(() => oauthWindow.currentHref === CODESPACE_URL, 400);
  await oauthDone;
  assert.equal(oauthWindow.currentHref, CODESPACE_URL, "la ventana del OAuth termina en el Codespace");
  assert.equal(oauthWindow.closed, false);
  assert.equal(tab.popups.length, 2, "sin ventanas extra");
  const prepared = browser.requestsTo("/github/prepare-environment", "POST");
  assert.equal(prepared.length, 1, "un PR y un Codespace");
  assert.equal(prepared[0].body?.repoFullName, REPO);
  assert.equal(prepared[0].body?.mode, "pr-codespace");
  assert.match(String(prepared[0].body?.devcontainerJson), /adaceen\.adaceen/);
  assert.deepEqual(browser.requestsTo("/api/workspaces/prepare"), [], "con Codespaces no se prepara el tunel");
  assert.equal((browser.storage.adaceenSetupDoneByUser as Json)?.[EDITOR_KEY], true);
  await browser.clock.until(() => tab.el("mainView").hidden === false, 50);
  assert.equal(tab.el("mainView").hidden, false, "tras crear el Codespace se entra al panel");
  assert.equal(tab.el("contextPrimaryActionBtn").dataset.contextAction, "open_codespaces");
  assert.equal(tab.el("contextPrimaryActionBtn").textContent, "Abrir Codespace de la PR");

  // En el panel principal con Codespaces, la tuerca conserva los ajustes de la GitHub App.
  tab.run("overlayState.settingsOpen = true; renderOverlay()");
  assert.equal(tab.el("advancedGithubBlock").hidden, false, "Codespaces sigue con «Rehacer PR devcontainer»");
  assert.equal(tab.el("githubAppSection").hidden, false);
  assert.deepEqual(browser.unknownRoutes.filter((route) => !route.includes("/api/projects")), []);
  assertKnownShadowIds(tab);
});

test("Codespaces: la espera de la GitHub App tiene limite, se corta al cerrar y entra si el repo ya estaba preparado", async () => {
  // Nunca se instala: a los 5 min deja de consultar y lo dice.
  const browser = new FakeBrowser();
  browser.provider = "codespaces";
  seedLoggedInBrowser(browser);
  const tab = await openCodespacesTour(browser);
  const before = browser.requestsTo("/api/github-app/status").length;
  await drive(browser, tab.el("setupPrimaryActionBtn").click());
  await advance(browser, 6 * 60_000);
  assert.equal(tab.run("isWatchingGithubAppInstall()"), false);
  const polled = browser.requestsTo("/api/github-app/status").length - before;
  assert.ok(polled >= 70 && polled <= 80, `con limite (${polled} consultas en 5 min)`);
  assert.match(tab.el("setupStatusText").textContent, /ADACEEN dejo de esperar la GitHub App\. Si ya la instalaste, pulsa Autorizar GitHub App de nuevo/);
  assert.equal(tab.el("setupOperationBanner").hidden, true);
  assert.equal(tab.el("setupPrimaryActionBtn").dataset.contextAction, "connect_github");

  // Cerrar el overlay corta la espera.
  await drive(browser, tab.el("setupPrimaryActionBtn").click());
  assert.equal(tab.run("isWatchingGithubAppInstall()"), true);
  await drive(browser, tab.run("closeOverlay({ reason: 'user' })"));
  assert.equal(tab.run("isWatchingGithubAppInstall()"), false);
  const afterClose = browser.requestsTo("/api/github-app/status").length;
  await advance(browser, 20_000);
  assert.equal(browser.requestsTo("/api/github-app/status").length, afterClose, "sin consultas con el overlay cerrado");

  // El repo ya tenia la preparacion de ADACEEN (PR de otro companero): al detectar la App se
  // entra al panel, que ofrece abrir el Codespace de esa PR.
  const ready = new FakeBrowser();
  ready.provider = "codespaces";
  seedLoggedInBrowser(ready);
  const readyTab = await openCodespacesTour(ready);
  await drive(ready, readyTab.el("setupPrimaryActionBtn").click());
  ready.appStatus = {
    configured: true,
    installation: { accountLogin: "alumno" },
    hasRepoAccess: true,
    bootstrapReady: true,
    bootstrapPullNumber: 3,
    bootstrapCodespaceUrl: `https://codespaces.new/${REPO}/pull/3`,
  };
  await advance(ready, 4_500);
  assert.equal(readyTab.run("isWatchingGithubAppInstall()"), false);
  await ready.clock.until(() => readyTab.el("mainView").hidden === false, 50);
  assert.equal(readyTab.el("mainView").hidden, false, "setup completo sin otro clic");
  assert.equal(readyTab.el("contextPrimaryActionBtn").dataset.contextAction, "open_codespaces");
  assert.match(readyTab.state().statusMessage, /GitHub App lista: .* ya tenia la configuracion ADACEEN/);
  assert.deepEqual(ready.requestsTo("/github/prepare-environment"), [], "sin clic no se abre ninguna ventana");

  // Con la App y la cuenta (scope codespace) ya listas: un boton, «Preparar entorno ADACEEN»,
  // abre la ventana de espera en el mismo clic y termina en el Codespace, sin «Entendido».
  const connected = new FakeBrowser();
  connected.provider = "codespaces";
  connected.githubConnected = true;
  connected.githubCodespaceScope = true;
  connected.appStatus = { configured: true, installation: { accountLogin: "alumno" }, hasRepoAccess: true, bootstrapReady: false };
  seedLoggedInBrowser(connected);
  const connectedTab = await openCodespacesTour(connected);
  assert.equal(connectedTab.el("setupView").hidden, false);
  assert.equal(connectedTab.el("setupPrimaryActionBtn").dataset.contextAction, "create_bootstrap_pr");
  assert.equal(connectedTab.el("setupPrimaryActionBtn").textContent, "Preparar entorno ADACEEN");
  assert.equal(connectedTab.el("setupSecondaryActionBtn").hidden, true, "sin «Volver» ni «Actualizar estado»");
  assert.match(connectedTab.el("setupActionCopy").textContent, /puede tardar cerca de 2 minutos/);
  await drive(connected, connectedTab.el("setupPrimaryActionBtn").click(), 2000);
  await connected.clock.until(() => connectedTab.popups[0]?.currentHref === CODESPACE_URL, 400);
  assert.equal(connectedTab.popups.length, 1, "la ventana de espera del mismo clic");
  assert.equal(connectedTab.popups[0].currentHref, CODESPACE_URL);
  assert.equal(connected.requestsTo("/github/prepare-environment", "POST").length, 1);
  assert.equal(connectedTab.state().processNoticeOpen, undefined, "sin el aviso «Entendido»");
  assertKnownShadowIds(tab, readyTab, connectedTab);
});
