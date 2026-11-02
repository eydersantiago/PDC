import assert from "node:assert/strict";
import test from "node:test";
import { PRIVACY_POLICY_VERSION } from "../../../src/routes/pages/privacy-policy-routes.js";
import { REPO, TUNNEL_URL, SESSION, type Json } from "./harness-config.js";
import { FakeBrowser } from "./harness-backend.js";
import { drive, openTab, advance, assertKnownShadowIds, seedLoggedInBrowser } from "./harness-utils.js";
import { EDITOR_KEY, savedEditorRecord, workspaceRequestsSince, loginFromOverlay } from "./harness-helpers.js";

// ---- Auditoria de redundancias (navegador 0.7.12, tanda 1: estudiante y tunel) ----
test("privacidad en el backend: «Aceptar y continuar» una sola vez en cualquier navegador (contrato (a))", async () => {
  // Primer navegador, backend nuevo sin aceptacion: se pregunta y la aceptacion va al backend.
  const first = new FakeBrowser();
  first.storage = { adaceenClientId: "cliente-prueba-123" };
  first.privacy = { version: null, acceptedAt: null };
  first.firstLogin = true;
  const tab = await openTab(first, `https://github.com/${REPO}`, REPO);
  await loginFromOverlay(first, tab);
  assert.equal(tab.el("firstLoginModal").hidden, false, "la primera vez se pregunta");
  await drive(first, tab.el("firstLoginConfirmBtn").click());
  await first.clock.until(() => first.privacyAcceptances.length > 0, 50);
  assert.deepEqual(first.privacyAcceptances, [{ version: PRIVACY_POLICY_VERSION }]);
  assert.equal(tab.el("firstLoginModal").hidden, true);
  assert.equal((first.storage.adaceenPrivacyAcceptedByUser as Json)?.[SESSION.user.id], PRIVACY_POLICY_VERSION);

  // Otro navegador o equipo: el backend ya tiene esta version aceptada, no se vuelve a preguntar.
  const second = new FakeBrowser();
  second.storage = { adaceenClientId: "cliente-otro-456" };
  second.privacy = { version: PRIVACY_POLICY_VERSION, acceptedAt: "2026-09-25T12:00:00.000Z" };
  const secondTab = await openTab(second, `https://github.com/${REPO}`, REPO);
  await loginFromOverlay(second, secondTab);
  assert.equal(secondTab.state().firstLoginConfirmationOpen, false);
  assert.equal(secondTab.el("firstLoginModal").hidden, true, "sin el modal en el segundo navegador");
  assert.deepEqual(second.requestsTo("/api/auth/privacy-acceptance"), []);
  assert.equal((second.storage.adaceenPrivacyAcceptedByUser as Json)?.[SESSION.user.id], PRIVACY_POLICY_VERSION);

  // Backend anterior (sin el campo privacy ni la ruta, 404): se pregunta y queda solo aqui.
  const old = new FakeBrowser();
  old.storage = { adaceenClientId: "cliente-viejo-789" };
  const oldTab = await openTab(old, `https://github.com/${REPO}`, REPO);
  await loginFromOverlay(old, oldTab);
  assert.equal(oldTab.el("firstLoginModal").hidden, false);
  await drive(old, oldTab.el("firstLoginConfirmBtn").click());
  await old.clock.until(() => old.requestsTo("/api/auth/privacy-acceptance").length > 0, 50);
  assert.equal(oldTab.el("firstLoginModal").hidden, true, "un 404 no deja el modal abierto");
  assert.equal((old.storage.adaceenPrivacyAcceptedByUser as Json)?.[SESSION.user.id], PRIVACY_POLICY_VERSION);
  await drive(old, oldTab.run("fetchCurrentSession()"));
  assert.equal(oldTab.state().firstLoginConfirmationOpen, false, "lo guardado aqui sigue valiendo");

  // Aceptada en este navegador antes de 0.7.12 (solo `true` en local, es la 2026-05-26): desde
  // la politica 2026-10-11 (0.7.22) eso ya no basta, se pregunta de nuevo y se registra la nueva.
  const legacy = new FakeBrowser();
  seedLoggedInBrowser(legacy, { adaceenPrivacyAcceptedByUser: { [SESSION.user.id]: true } });
  legacy.privacy = { version: null, acceptedAt: null };
  const legacyTab = await openTab(legacy, `https://github.com/${REPO}`, REPO);
  await drive(legacy, legacyTab.run("openOverlay({ trigger: 'user' })"));
  await legacy.clock.until(() => !legacyTab.run("savedEditorAutoEnterInFlight"), 400);
  await legacy.clock.until(() => legacyTab.state().loading === false, 400);
  assert.equal(legacyTab.el("firstLoginModal").hidden, false, "la politica cambio: se vuelve a preguntar");
  assert.match(String(legacyTab.el("firstLoginPolicyLink").getAttribute("href")), /\/privacy-policy$/, "el aviso enlaza la politica completa");
  await drive(legacy, legacyTab.el("firstLoginConfirmBtn").click());
  await legacy.clock.until(() => legacy.privacyAcceptances.length > 0, 50);
  assert.equal(legacyTab.el("firstLoginModal").hidden, true);
  assert.deepEqual(legacy.privacyAcceptances, [{ version: PRIVACY_POLICY_VERSION }]);
  assertKnownShadowIds(tab, secondTab, oldTab, legacyTab);
});

test("otro navegador: si el backend ya tiene el editor, se ofrece «Abrir mi editor» sin el tour (item 11)", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  browser.githubConnected = true;
  browser.statusSteps = [browser.ready()];
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.el("mainView").hidden === false, 100);
  assert.equal(tab.el("setupView").hidden, true, "sin el tour");
  assert.equal(tab.el("contextPrimaryActionBtn").dataset.contextAction, "open_my_editor");
  assert.equal(tab.el("contextPrimaryActionBtn").textContent, "Abrir mi editor");
  assert.equal(browser.requestsTo("/api/workspaces/status").length, 1, "una consulta al entrar");
  // 0.7.20: solo mirar (passive=1): entrar en la pagina no enciende la VM ni reenvia nada.
  assert.match(browser.requestsTo("/api/workspaces/status")[0].query, /[?&]passive=1(&|$)/);
  const adopted = (browser.storage.adaceenEditorByUser as Json)?.[EDITOR_KEY] as Json;
  assert.equal(adopted?.webUrl, TUNNEL_URL);
  assert.equal(adopted?.sessionWrittenAt, "", "sin fecha de sesion: el primer clic pasa por prepare");

  // El primer «Abrir mi editor» pasa por prepare (renueva la sesion de VS Code en la VM) y abre.
  browser.prepareSteps = [browser.ready()];
  const from = browser.requests.length;
  await drive(browser, tab.el("contextPrimaryActionBtn").click(), 2000);
  await browser.clock.until(() => tab.popups[0]?.currentHref === TUNNEL_URL, 400);
  assert.equal(tab.popups[0]?.currentHref, TUNNEL_URL);
  assert.equal(workspaceRequestsSince(browser, from)[0], "POST /api/workspaces/prepare");

  // Sin editor en el backend sigue el tour con «Preparar mi editor» y no se repite la consulta.
  const other = new FakeBrowser();
  seedLoggedInBrowser(other);
  other.githubConnected = true;
  other.statusSteps = [other.notFound()];
  const otherTab = await openTab(other, `https://github.com/${REPO}`, REPO);
  await drive(other, otherTab.run("openOverlay({ trigger: 'user' })"));
  await other.clock.until(() => !otherTab.run("savedEditorAutoEnterInFlight"), 400);
  await other.clock.until(() => otherTab.state().loading === false, 100);
  assert.equal(otherTab.el("setupView").hidden, false);
  assert.equal(otherTab.el("setupPrimaryActionBtn").textContent, "Preparar mi editor");
  await drive(other, otherTab.run("refreshMentorSession({ trigger: 'manual', requestedAt: Date.now() })"), 2000);
  assert.equal(other.requestsTo("/api/workspaces/status").length, 1, "una sola vez por pagina");

  // Sin la cuenta de GitHub conectada no puede haber editor: no se consulta.
  const noGithub = new FakeBrowser();
  seedLoggedInBrowser(noGithub);
  const noGithubTab = await openTab(noGithub, `https://github.com/${REPO}`, REPO);
  await drive(noGithub, noGithubTab.run("openOverlay({ trigger: 'user' })"));
  await noGithub.clock.until(() => !noGithubTab.run("savedEditorAutoEnterInFlight"), 400);
  assert.deepEqual(noGithub.requestsTo("/api/workspaces/status"), []);
  assertKnownShadowIds(tab, otherTab, noGithubTab);
});

test("docente en github.com: entra al panel, no al tour del estudiante (item 8)", async () => {
  const browser = new FakeBrowser();
  browser.session = { ...SESSION, user: { ...SESSION.user, role: "teacher", assignedCourseCodes: [] } };
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);
  assert.equal(tab.run("isTeacherSession()"), true);
  assert.equal(tab.el("setupView").hidden, true, "sin «Conectar GitHub» del estudiante");
  assert.equal(tab.el("mainView").hidden, false);
  // Tampoco la accion del estudiante en el panel: ni «Preparar mi editor» (que prepararia un
  // editor a su nombre para el repositorio de un estudiante) ni la consulta del editor.
  assert.equal(tab.el("contextActionTitle").textContent, "Panel docente");
  assert.equal(tab.el("contextPrimaryActionBtn").dataset.contextAction, "open_settings");
  assert.equal(tab.el("contextPrimaryActionBtn").textContent, "Configuracion");
  // Su forma de conectar VS Code sigue a mano (guia, 4.2: «Abrir en VS Code de este equipo»).
  assert.equal(tab.el("contextSecondaryActionBtn").hidden, false);
  assert.equal(tab.el("contextSecondaryActionBtn").dataset.contextAction, "open_local_vscode");
  assert.equal(tab.el("contextSecondaryActionBtn").textContent, "Abrir en VS Code de este equipo");
  await advance(browser, 2_000);
  // 0.7.20: el docente tambien puede tener su editor (boton «Abrir en mi editor»): al entrar
  // se consulta una vez si ya existe, sin preparar nada y sin cambiar el panel.
  assert.ok(browser.requestsTo("/api/workspaces/status").length <= 1, "a lo sumo una consulta del editor del docente");
  assert.deepEqual(browser.requestsTo("/api/workspaces/prepare"), [], "entrar no prepara un editor");
  assert.equal(tab.el("contextActionTitle").textContent, "Panel docente");
  await drive(browser, tab.el("contextPrimaryActionBtn").click(), 400);
  assert.equal(tab.state().settingsOpen, true, "abre la tuerca (quiz, politica y piloto)");
  assert.deepEqual(browser.requestsTo("/api/workspaces/prepare"), []);
  assertKnownShadowIds(tab);
});

test("un solo boton para cerrar sesion: «Salir» de la cabecera (item 12)", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  const markup = tab.run<string>("buildOverlayMarkup()");
  assert.doesNotMatch(markup, /id="setupLogoutBtn"/, "sin «Cerrar sesion» en el tour");
  assert.doesNotMatch(markup, /id="logoutSettingsBtn"/, "sin «Cerrar sesion» en la tuerca");
  assert.match(markup, /id="logoutHeaderBtn"/);
  // La tuerca se abre bajo la cabecera, asi que «Salir» sigue a la vista con ella abierta.
  const styleProps: Record<string, string> = {};
  tab.el("window").style.setProperty = (name: string, value: string) => { styleProps[name] = value; };
  tab.run("overlayState.settingsOpen = true; renderOverlay()");
  assert.equal(styleProps["--adaceen-settings-top"], "480px", "la altura de la cabecera");
  assert.match(tab.run<string>("OVERLAY_STYLES"), /\.settings-panel \{\s+position: absolute;\s+inset: var\(--adaceen-settings-top, 0px\) 0 0 0;/);
  await drive(browser, tab.el("logoutHeaderBtn").click(), 400);
  assert.equal(tab.state().session, null);
  assert.equal(tab.state().settingsOpen, false, "la tuerca se cierra al salir");
  assert.equal(tab.el("authView").hidden, false);
  assertKnownShadowIds(tab);
});

test("Mac del laboratorio: al volver otro dia la accion principal es la ultima eleccion (item 13)", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);
  // Primer dia: «Abrir en VS Code de este equipo» desde la tarjeta del tour.
  await drive(browser, tab.el("setupOpenLocalVscodeBtn").click());
  assert.equal(tab.openedLinks.length, 1);
  assert.equal((browser.storage.adaceenEditorChoiceByUser as Json)?.[SESSION.user.id], "local_vscode");
  assert.equal(tab.el("mainView").hidden, false);
  assert.equal(tab.el("contextPrimaryActionBtn").dataset.contextAction, "open_local_vscode");

  // Otro dia, mismo navegador: la accion principal sigue siendo VS Code de este equipo y el
  // editor en la nube queda de segundo boton.
  const nextDay = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, nextDay.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !nextDay.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => nextDay.state().loading === false, 400);
  assert.equal(nextDay.el("mainView").hidden, false);
  assert.equal(nextDay.el("contextPrimaryActionBtn").dataset.contextAction, "open_local_vscode");
  assert.equal(nextDay.el("contextPrimaryActionBtn").textContent, "Abrir en VS Code de este equipo");
  assert.equal(nextDay.el("contextSecondaryActionBtn").dataset.contextAction, "open_my_editor");
  assert.equal(nextDay.el("contextSecondaryActionBtn").textContent, "Preparar mi editor");
  // La eleccion es por usuario: el texto no afirma que este repo ya se abrio ahi ni que haya
  // un editor en la nube que aun no existe.
  assert.equal(
    nextDay.el("contextActionCopy").textContent,
    `La ultima vez usaste el VS Code de este equipo: abre ${REPO} ahi con un clic. Si prefieres el editor en la nube, pulsa Preparar mi editor.`,
  );

  // Si elige el editor en la nube, esa pasa a ser la principal.
  browser.githubConnected = true;
  browser.prepareSteps = [browser.ready()];
  await drive(browser, nextDay.el("contextSecondaryActionBtn").click(), 2000);
  await browser.clock.until(() => nextDay.popups[0]?.currentHref === TUNNEL_URL, 400);
  assert.equal((browser.storage.adaceenEditorChoiceByUser as Json)?.[SESSION.user.id], "cloud");
  nextDay.run("renderOverlay()");
  assert.equal(nextDay.el("contextPrimaryActionBtn").dataset.contextAction, "open_my_editor");
  assert.equal(nextDay.el("contextPrimaryActionBtn").textContent, "Abrir mi editor");
  assertKnownShadowIds(tab, nextDay);
});

test("sin botones repetidos: paginas sin repo y «Autodetectar» (items 5 y 13)", async () => {
  // github.com sin repositorio y sin editor guardado: «Actualizar» de la cabecera basta.
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, "https://github.com/", "GitHub");
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);
  assert.equal(tab.el("mainView").hidden, false);
  assert.equal(tab.el("contextActionTitle").textContent, "Buscar contexto");
  assert.equal(tab.el("contextPrimaryActionBtn").hidden, true, "sin «Actualizar contexto»");
  assert.equal(tab.el("contextSecondaryActionBtn").hidden, true);
  assert.equal(tab.el("refreshBtn").hidden, false);
  const rows = tab.run<Array<{ label: string }>>("buildConnectionItems(overlayState.context, getSetupFlowState(overlayState.context))");
  assert.deepEqual(Array.from(rows, (item) => item.label), ["ADACEEN", "Editor"], "sin filas «No requerido» ni «No detectado»");
  // Con el tutor pausado «Actualizar» esta deshabilitado: la accion recomendada conserva
  // «Actualizar contexto», que si funciona.
  tab.run("overlayState.assistantEnabled = false; renderOverlay()");
  assert.equal(tab.el("refreshBtn").disabled, true);
  assert.equal(tab.el("contextPrimaryActionBtn").hidden, false);
  assert.equal(tab.el("contextPrimaryActionBtn").textContent, "Actualizar contexto");
  assert.equal(tab.el("contextPrimaryActionBtn").dataset.contextAction, "refresh_mentor");
  assert.doesNotMatch(tab.el("contextActionCopy").textContent, /pulsa Actualizar\./);
  const tutorBefore = browser.requestsTo("/intervene").length + browser.requestsTo("/github-mentor").length;
  await drive(browser, tab.el("contextPrimaryActionBtn").click(), 2000);
  assert.equal(browser.requestsTo("/intervene").length + browser.requestsTo("/github-mentor").length, tutorBefore, "con el tutor pausado no se le pregunta");
  tab.run("overlayState.assistantEnabled = true; renderOverlay()");
  assert.equal(tab.el("contextPrimaryActionBtn").hidden, true);

  // Con un editor guardado: «Abrir mi editor» y nada mas (antes tambien «Actualizar contexto»).
  const saved = new FakeBrowser();
  seedLoggedInBrowser(saved, { adaceenEditorByUser: { [EDITOR_KEY]: savedEditorRecord(saved) } });
  const savedTab = await openTab(saved, "https://github.com/", "GitHub");
  await drive(saved, savedTab.run("openOverlay({ trigger: 'user' })"));
  await saved.clock.until(() => !savedTab.run("savedEditorAutoEnterInFlight"), 400);
  assert.equal(savedTab.el("contextPrimaryActionBtn").dataset.contextAction, "open_my_editor");
  assert.equal(savedTab.el("contextSecondaryActionBtn").hidden, true);

  // Tour del tunel sin repositorio: «Autodetectar repositorio» es la accion recomendada y el
  // «Autodetectar» de la tarjeta no la repite.
  const repoTab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, repoTab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !repoTab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => repoTab.state().loading === false, 400);
  repoTab.run("setSetupRepoFullName(''); overlayState.context = { ...overlayState.context, url: 'https://github.com/', repoFullName: '', pageType: 'github_general', links: [], title: '' }; renderOverlay()");
  assert.equal(repoTab.el("setupPrimaryActionBtn").dataset.contextAction, "detect_repo");
  assert.equal(repoTab.el("setupDetectRepoBtn").hidden, true, "un solo «Autodetectar»");
  assertKnownShadowIds(tab, savedTab, repoTab);
});

test("mensajes y boton del editor dicen lo mismo (item 3)", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("syncFromStorageSnapshot({ force: true })"));
  tab.run("overlayState.context = buildPayload()");
  assert.equal(tab.run("myEditorButtonLabel()"), "Preparar mi editor");
  await drive(browser, tab.run(`saveTunnelEditor("${REPO}", "${TUNNEL_URL}")`));
  assert.equal(tab.run("myEditorButtonLabel()"), "Abrir mi editor");
});
