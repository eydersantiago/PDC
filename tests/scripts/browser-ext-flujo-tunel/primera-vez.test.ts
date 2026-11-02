import assert from "node:assert/strict";
import test from "node:test";
import { BACKEND, REPO, TUNNEL_URL, SESSION, type Json } from "./harness-config.js";
import { FakeBrowser } from "./harness-backend.js";
import { drive, openTab, assertKnownShadowIds, seedLoggedInBrowser } from "./harness-utils.js";
import { EDITOR_KEY, DAY_MS, savedEditorRecord, activeTabReports, workspaceRequestsSince } from "./harness-helpers.js";

test("tunel sin GitHub App: Conectar GitHub -> OAuth -> VM apagada -> codigo en una pestana -> editor listo", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, `${REPO}: taller`);

  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"));
  // Con sesion el icono entra directo: «Empezar» solo navegaba (auditoria, item 13). Como
  // «Empezar», confirma la sesion y el tutor responde una vez.
  assert.equal(tab.state().started, true, "sin pulsar Empezar");
  await browser.clock.until(() => tab.state().loading === false && tab.state().workspaceProvider === "tunnel");
  assert.equal(tab.el("welcomeView").hidden, true);
  assert.equal(browser.requestsTo("/api/auth/me").length, 1, "la sesion se confirma una vez");
  assert.equal(browser.requestsTo("/api/rag/courses").length, 1, "los cursos se piden una vez al entrar");
  assert.equal(browser.requestsTo("/api/github/oauth/status").length, 1);

  // Tour del tunel: un solo paso (Conectar GitHub), sin GitHub App ni botones de navegacion.
  assert.equal(tab.el("setupView").hidden, false, "se muestra el tour");
  assert.equal(tab.el("setupViewTitle").textContent, "Preparar tu editor", "con el tunel no se prepara el repositorio");
  assert.equal(tab.el("setupViewPill").textContent, "Primera vez");
  // Una sola tarjeta: las de la GitHub App y del PR ya no existen (item 2).
  assert.doesNotMatch(
    tab.run<string>("buildOverlayMarkup()"),
    /id="setupStepTwoCard"|id="setupStepThreeCard"|id="setupToStep2Btn"/,
    "sin paso de GitHub App ni 'Autorizar repositorio'",
  );
  assert.equal(tab.el("setupStepOneCard").hidden, false);
  assert.equal(tab.el("setupDetectRepoBtn").hidden, true, "el repo ya se infiere de la pagina");
  assert.equal(tab.el("setupPrimaryActionBtn").dataset.contextAction, "connect_github_user");
  assert.equal(tab.el("setupPrimaryActionBtn").textContent, "Conectar GitHub");
  assert.equal(tab.el("setupSecondaryActionBtn").hidden, true, "boton unico");
  // Filas del contexto: sin «GitHub App: No requerida» ni «Campus: No detectado» (item 5).
  const setupRows = tab.run<Array<{ label: string; status: string }>>("buildConnectionItems(overlayState.context, getSetupFlowState(overlayState.context))");
  assert.deepEqual(Array.from(setupRows, (item) => item.label), ["ADACEEN", "GitHub OAuth", "Editor"], "la fila de Codespaces pasa a ser el editor");
  assert.equal(tab.el("authHelper").hidden, true, "sin cuentas demo con el backend de produccion");
  assert.equal(tab.el("authEmail").value, "", "login sin credenciales precargadas");

  // La VM esta apagada al principio: el backend responde reintentable y la espera sigue.
  browser.prepareSteps = [browser.vmOff()];
  browser.statusSteps = [browser.vmStarting(), browser.vmStarting(), browser.deviceCode(), browser.deviceCode(), browser.deviceCode(), browser.ready()];

  await drive(browser, tab.el("setupPrimaryActionBtn").click());
  assert.equal(tab.popups.length, 1, "una sola ventana para el OAuth");
  const oauthWindow = tab.popups[0];
  assert.match(oauthWindow.currentHref, /^https:\/\/github\.com\/login\/oauth\/authorize/);

  // GitHub autoriza: la ventana pasa al callback del backend (otro origen) y avisa al overlay.
  browser.githubConnected = true;
  oauthWindow.location.href = `${BACKEND}/auth/github/callback?code=x&state=estado`;
  const oauthDone = tab.dispatchWindowEvent("message", { data: { type: "ADACEEN_GITHUB_OAUTH_CONNECTED" }, origin: BACKEND });

  const deviceStep = await browser.clock.until(() => oauthWindow.currentHref === "https://github.com/login/device", 400);
  assert.ok(deviceStep, "la misma ventana pasa a github.com/login/device con el codigo guardado");
  assert.equal((browser.storage.adaceenDeviceCodeHandoff as Json)?.userCode, "WDJB-MJHT");
  assert.ok(browser.requestsTo("/api/workspaces/status").length >= 3, "la VM apagada no corto la espera");
  // La espera tras el clic no es «solo mirar»: el backend puede encender la VM y reenviar el prepare.
  assert.ok(browser.requestsTo("/api/workspaces/status").filter((request) => !request.query.includes("passive=1")).length >= 3);
  assert.equal(tab.popups.length, 1, "sin ventanas extra");

  // En la pestana de GitHub del codigo, el content script muestra el codigo para copiar.
  const deviceTab = await openTab(browser, "https://github.com/login/device", "Device Activation");
  await browser.clock.until(() => !!deviceTab.document.getElementById("adaceen-device-code-helper"), 50);
  const helper = deviceTab.document.getElementById("adaceen-device-code-helper");
  assert.ok(helper?.shadow, "aviso con el codigo en github.com/login/device");
  assert.equal(helper!.shadow!.getElementById("adaceenDeviceCode").textContent, "WDJB-MJHT");
  // 0.8.0: el paso 3 de 4, obligatorio, con la fila de pasos (1 y 2 hechos).
  assert.match(String(helper!.shadow!.innerHTML), /Paso 3 de 4 · Autorizar tu editor <span class="must">· obligatorio la primera vez<\/span>/);
  assert.match(String(helper!.shadow!.innerHTML), /<li class="is-done">1\. Tu cuenta de GitHub<\/li><li class="is-done">2\. Encender tu editor<\/li><li class="is-current" aria-current="step">3\. Autorizar tu editor<\/li><li class="">4\. Entrar a VS Code<\/li>/);

  await browser.clock.until(() => oauthWindow.currentHref === TUNNEL_URL, 400);
  await oauthDone;
  assert.equal(oauthWindow.currentHref, TUNNEL_URL, "la misma pestana termina en el editor");
  assert.equal(oauthWindow.closed, false);
  assert.equal(tab.popups.length, 1);

  // Nada de GitHub App ni de PR con el tunel: ni siquiera se consulta su estado (item 13).
  assert.deepEqual(browser.requestsTo("/api/github-app/status"), []);
  assert.deepEqual(browser.requestsTo("/api/github-app/install-url"), []);
  assert.deepEqual(browser.requestsTo("/github/prepare-environment"), []);
  assert.equal(browser.requestsTo("/api/workspaces/prepare", "POST").length, 1);

  // Editor y setup durables por usuario y repo; el codigo de dispositivo ya no se guarda.
  const saved = (browser.storage.adaceenEditorByUser as Json)?.[`${SESSION.user.id}:${REPO}`] as Json;
  assert.equal(saved?.webUrl, TUNNEL_URL);
  assert.equal((browser.storage.adaceenSetupDoneByUser as Json)?.[`${SESSION.user.id}:${REPO}`], true);
  assert.equal(browser.storage.adaceenDeviceCodeHandoff, undefined);

  // refreshGithubAppStatus ya no borra el setup ni el editor con el tunel, ni siquiera en el
  // caso que antes lo borraba: App instalada con acceso al repo y sin bootstrap de Codespaces.
  browser.appStatus = { configured: true, installation: { accountLogin: "alumno" }, hasRepoAccess: true, bootstrapReady: false };
  await drive(browser, tab.run("refreshGithubAppStatus()"));
  await drive(browser, tab.run("refreshGithubIntegrationStatus()"));
  assert.equal((browser.storage.adaceenSetupDoneByUser as Json)?.[`${SESSION.user.id}:${REPO}`], true);
  assert.equal(tab.run("hasCompletedSetup()"), true);
  assert.equal(tab.run("getStoredSetupCodespaceUrl()"), TUNNEL_URL);
  await browser.clock.until(() => tab.el("mainView").hidden === false, 20);
  assert.equal(tab.el("mainView").hidden, false, "tras preparar el editor se entra al panel");
  assert.equal(tab.el("contextPrimaryActionBtn").dataset.contextAction, "open_my_editor");
  // La tuerca no ofrece la GitHub App con el tunel (item 1) y el panel de github.com no muestra
  // botones que solo funcionan dentro del editor (item 5).
  tab.run("overlayState.settingsOpen = true; renderOverlay()");
  assert.equal(tab.el("advancedGithubBlock").hidden, true, "sin «Ajustes avanzados GitHub App»");
  assert.equal(tab.el("githubAppSection").hidden, true, "sin «Conectar App»");
  tab.run("overlayState.settingsOpen = false; renderOverlay()");
  assert.equal(tab.el("analyzeProjectBtn").hidden, true, "sin «Explorar repo» fuera del editor");
  assert.equal(tab.el("rerunOcrBtn").hidden, true, "sin «OCR visual» fuera del editor");
  assert.deepEqual(browser.unknownRoutes.filter((route) => !route.includes("/api/projects")), []);
  assertKnownShadowIds(tab, deviceTab);
});

test("primera vez: la ventana del OAuth (callback del backend, otro origen) recibe el progreso y el error", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, `${REPO}: taller`);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"));
  await browser.clock.until(() => tab.state().loading === false && tab.state().workspaceProvider === "tunnel");

  // VM apagada al principio y luego un error definitivo (repositorio privado).
  const privateRepo = "No se pudo clonar el repositorio: no existe o es privado.";
  browser.prepareSteps = [browser.vmOff()];
  browser.statusSteps = [browser.agentError(privateRepo)];
  await drive(browser, tab.el("setupPrimaryActionBtn").click());
  const oauthWindow = tab.popups[0];
  browser.githubConnected = true;
  oauthWindow.location.href = `${BACKEND}/auth/github/callback?code=x&state=estado`;
  const oauthDone = tab.dispatchWindowEvent("message", { data: { type: "ADACEEN_GITHUB_OAUTH_CONNECTED" }, origin: BACKEND });

  const updates = () => oauthWindow.messages
    .filter((message) => message.data?.type === "ADACEEN_WAIT_UPDATE" && message.data.title)
    .map((message) => `${message.data.title} | ${message.data.detail}`);
  await browser.clock.until(() => updates().some((line) => line.startsWith("No se pudo preparar el editor")), 400);
  await oauthDone;
  assert.ok(oauthWindow.messages.every((message) => message.targetOrigin === BACKEND), "solo al origen del backend");
  assert.deepEqual(updates(), [
    "ADACEEN esta preparando tu editor | Clonando el repositorio en la nube y registrando el tunel...",
    "El editor esta apagado; avisa al docente | El editor esta apagado. Avisa al docente; esta ventana seguira esperando.",
    `No se pudo preparar el editor | ${privateRepo}`,
  ]);
  assert.equal(oauthWindow.currentHref, `${BACKEND}/auth/github/callback?code=x&state=estado`);
  assert.equal(tab.popups.length, 1);
  // 0.8.0: el paso en curso tambien llega a la pagina del callback (paso 2, encender tu editor).
  const steps = oauthWindow.messages.filter((message) => message.data?.type === "ADACEEN_WAIT_UPDATE" && message.data.step).map((message) => message.data.step);
  assert.ok(steps.includes("start"), `pasos enviados: ${steps.join(", ")}`);
});
test("volver otro dia: el overlay entra solo y 'Abrir mi editor' consulta status y abre", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser, {
    adaceenOverlayPinned: true,
    adaceenSetupDoneByUser: { [EDITOR_KEY]: true },
    adaceenEditorByUser: { [EDITOR_KEY]: savedEditorRecord(browser) },
  });
  browser.githubConnected = true;

  // El overlay fijado se restaura al cargar la pagina y entra sin "Empezar".
  const tab = await openTab(browser, `https://github.com/${REPO}`, `${REPO}: taller`);
  await browser.clock.until(() => tab.state().started === true && tab.state().loading === false, 400);
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 50);
  assert.equal(tab.state().started, true, "sin pulsar Empezar");
  assert.equal(tab.el("mainView").hidden, false);
  assert.equal(tab.el("contextPrimaryActionBtn").dataset.contextAction, "open_my_editor");
  assert.equal(tab.el("contextPrimaryActionBtn").textContent, "Abrir mi editor");
  assert.deepEqual(browser.requestsTo("/intervene"), [], "entrar solo no pide ayuda al tutor");
  assert.deepEqual(browser.requestsTo("/github-mentor"), []);
  assert.ok(browser.requestsTo("/api/auth/me").length >= 1, "la sesion se confirma antes de entrar");
  // Entrar solo no cuenta como pestana activa (active_tab_seen) hasta que el estudiante interactua.
  await browser.clock.until(() => false, 30);
  assert.deepEqual(activeTabReports(browser), [], "sin POST /api/ui/active-tab isActive=true al entrar solo");
  assert.equal(tab.run("buildTabSessionSnapshot().started"), false, "al recargar vuelve a decidir la entrada automatica");

  // Fila "VS Code" fuera del editor web: solo con un rack reciente del repo actual publicado por VS Code.
  const vscodeRow = () => tab
    .run<Array<{ label: string; status: string }>>("buildConnectionItems(overlayState.context, getSetupFlowState(overlayState.context))")
    .find((item) => item.label === "VS Code");
  assert.equal(vscodeRow(), undefined);
  browser.latestRack = { id: "rack-1", source: "vscode_extension", repoFullName: REPO, updatedAt: new Date(browser.clock.now - 2 * 60_000).toISOString() };
  await drive(browser, tab.run("refreshVscodeRackStatus()"));
  assert.equal(vscodeRow()?.status, "Conectado");
  browser.latestRack = { id: "rack-1", source: "vscode_extension", repoFullName: REPO, updatedAt: new Date(browser.clock.now - 30 * 60_000).toISOString() };
  await drive(browser, tab.run("refreshVscodeRackStatus()"));
  assert.equal(vscodeRow(), undefined, "un rack de hace 30 min no cuenta como conectado");
  // El rack que publica el propio overlay al explorar el proyecto (source = pageType) no prueba nada.
  browser.latestRack = { id: "rack-2", source: "codespace", repoFullName: REPO, updatedAt: new Date(browser.clock.now - 60_000).toISOString() };
  await drive(browser, tab.run("refreshVscodeRackStatus()"));
  assert.equal(vscodeRow(), undefined, "un rack del overlay no es VS Code conectado");

  // La presencia de VS Code no retrasa la peticion al tutor (latencyMs del piloto).
  browser.delays["/api/projects/session/state"] = 5000;
  const refreshFrom = browser.requests.length;
  const refreshStartedAt = browser.clock.now;
  await drive(browser, tab.run("refreshMentorSession({ trigger: 'manual', requestedAt: Date.now() })"), 2000);
  const sinceRefresh = browser.requests.slice(refreshFrom);
  const presenceRequest = sinceRefresh.find((request) => request.path === "/api/projects/session/state");
  const tutorRequest = sinceRefresh.find((request) => request.path === "/intervene" || request.path === "/github-mentor");
  assert.ok(presenceRequest && tutorRequest, "hubo consulta de presencia y peticion al tutor");
  assert.ok(tutorRequest!.at - refreshStartedAt < 5000, "el tutor no espera a /api/projects/session/state");
  delete browser.delays["/api/projects/session/state"];
  browser.latestRack = null;
  await browser.clock.until(() => false, 30);

  // El primer clic o tecla dentro del overlay la vuelve pestana activa.
  await Promise.all((tab.shadowListeners.get("pointerdown") || []).map((listener) => listener({ type: "pointerdown" })));
  await browser.clock.until(() => activeTabReports(browser).length > 0, 50);
  assert.equal(activeTabReports(browser).length, 1, "tras interactuar si cuenta como pestana activa");
  assert.equal(tab.run("buildTabSessionSnapshot().started"), true);

  // Un clic: status listo -> la ventana abierta en el mismo clic va al editor, sin prepare.
  browser.statusSteps = [browser.ready()];
  await drive(browser, tab.el("contextPrimaryActionBtn").click());
  await browser.clock.until(() => tab.popups[0]?.currentHref === TUNNEL_URL, 50);
  assert.equal(tab.popups.length, 1);
  assert.equal(tab.popups[0].currentHref, TUNNEL_URL);
  assert.deepEqual(browser.requestsTo("/api/workspaces/prepare"), []);
  // El primer clic en el overlay la vuelve pestana activa.

  // Segundo clic poco despues (pestana cerrada): vuelve a abrir, sin el candado de 5 min.
  tab.popups[0].close();
  browser.statusSteps = [browser.ready()];
  await drive(browser, tab.el("contextPrimaryActionBtn").click());
  await browser.clock.until(() => tab.popups[1]?.currentHref === TUNNEL_URL, 50);
  assert.equal(tab.popups[1]?.currentHref, TUNNEL_URL);

  // VM apagada: status reintentable -> prepare (idempotente), que espera y abre.
  browser.statusSteps = [browser.vmOff(), browser.vmStarting(), browser.ready()];
  browser.prepareSteps = [browser.vmOff()];
  browser.lastWorkspace = null;
  await drive(browser, tab.el("contextPrimaryActionBtn").click(), 2000);
  await browser.clock.until(() => tab.popups[2]?.currentHref === TUNNEL_URL, 400);
  assert.equal(tab.popups[2]?.currentHref, TUNNEL_URL);
  assert.equal(browser.requestsTo("/api/workspaces/prepare", "POST").length, 1);
  const afterPrepare = (browser.storage.adaceenEditorByUser as Json)?.[EDITOR_KEY] as Json;
  assert.ok(Date.parse(String(afterPrepare?.sessionWrittenAt)) > browser.clock.now - 60_000, "prepare renueva la fecha de la sesion de la VM");

  // Sesion de la VM escrita hace mas de 7 dias: "Abrir mi editor" pasa por prepare aunque status diria listo.
  await drive(browser, tab.run(`updateSavedEditorMap((map) => { map["${EDITOR_KEY}"] = { ...map["${EDITOR_KEY}"], sessionWrittenAt: "${new Date(browser.clock.now - 8 * DAY_MS).toISOString()}" }; return map; })`));
  browser.statusSteps = [browser.ready()];
  browser.prepareSteps = [browser.ready()];
  let from = browser.requests.length;
  await drive(browser, tab.el("contextPrimaryActionBtn").click(), 2000);
  await browser.clock.until(() => tab.popups[3]?.currentHref === TUNNEL_URL, 400);
  assert.equal(tab.popups[3]?.currentHref, TUNNEL_URL);
  assert.equal(workspaceRequestsSince(browser, from)[0], "POST /api/workspaces/prepare", "sesion vieja: directo a prepare");
  assert.ok(!workspaceRequestsSince(browser, from).includes("GET /api/workspaces/status"));

  // Tras cerrar sesion, el siguiente "Abrir mi editor" pasa por prepare (renueva la sesion de VS Code).
  await drive(browser, tab.run("logoutFromBackend()"));
  const record = (browser.storage.adaceenEditorByUser as Json)?.[EDITOR_KEY] as Json;
  assert.equal(record?.needsSessionRefresh, true);
  // Vuelve a iniciar sesion (otra pestana deja la sesion en storage) y pulsa "Abrir mi editor".
  browser.storage.adaceenSessionId = SESSION.id;
  browser.storage.adaceenActiveSessionSnapshot = {
    sessionId: SESSION.id,
    backendUrl: BACKEND,
    session: SESSION,
    policy: {},
    telemetry: [],
    updatedAt: browser.clock.now,
  };
  await drive(browser, tab.run("syncFromStorageSnapshot({ force: true })"));
  assert.equal(tab.run("getCurrentUserId()"), SESSION.user.id);
  browser.statusSteps = [browser.ready()];
  browser.prepareSteps = [browser.ready()];
  from = browser.requests.length;
  await drive(browser, tab.run("openMyTunnelEditor()"), 2000);
  await browser.clock.until(() => tab.popups[4]?.currentHref === TUNNEL_URL, 400);
  assert.equal(tab.popups[4]?.currentHref, TUNNEL_URL);
  assert.equal(workspaceRequestsSince(browser, from)[0], "POST /api/workspaces/prepare", "tras cerrar sesion: directo a prepare");
  assert.ok(!workspaceRequestsSince(browser, from).includes("GET /api/workspaces/status"));
  const renewed = (browser.storage.adaceenEditorByUser as Json)?.[EDITOR_KEY] as Json;
  assert.equal(renewed?.needsSessionRefresh, false, "prepare deja la sesion de la VM al dia");
  assertKnownShadowIds(tab);
});
