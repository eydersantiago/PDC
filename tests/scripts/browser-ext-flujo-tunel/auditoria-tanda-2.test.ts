import assert from "node:assert/strict";
import test from "node:test";
import { PRIVACY_POLICY_VERSION } from "../../../src/routes/pages/privacy-policy-routes.js";
import { REPO, CAMPUS_COURSE_URL, SESSION, type Json } from "./harness-config.js";
import { FakeBrowser } from "./harness-backend.js";
import { drive, openTab, advance, assertKnownShadowIds, seedLoggedInBrowser } from "./harness-utils.js";
import { openCodespacesTour, loginFromOverlay, openCampusCourse } from "./harness-helpers.js";

// ---- Auditoria de redundancias (navegador 0.7.12, tanda 2: Codespaces, docente y Campus) ----

function campusBrowser() {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  return browser;
}
test("Campus: el acceso se verifica solo al entrar y queda una sola accion (item 10)", async () => {
  const browser = campusBrowser();
  const tab = await openCampusCourse(browser);
  assert.equal(tab.el("mainView").hidden, false);
  // Verificado en silencio: una consulta, sin pisar el mensaje de estado y sin «Verificar acceso».
  assert.equal(browser.requestsTo("/api/documents/bitacora/status").length, 1, "una verificacion al entrar");
  assert.doesNotMatch(String(tab.state().statusMessage), /Acceso confirmado|Verificando bitacora/);
  assert.equal(tab.state().campusCourseAccess.accessConfirmed, true);
  assert.equal(tab.el("contextActionTitle").textContent, "Agenda Campus");
  assert.equal(tab.el("contextPrimaryActionBtn").dataset.contextAction, "analyze_project");
  assert.equal(tab.el("contextPrimaryActionBtn").textContent, "Analizar Campus");
  assert.equal(tab.el("contextSecondaryActionBtn").hidden, true, "sin «Verificar acceso» al lado");
  // La cabecera del resumen ya no repite «Analizar Campus» ni «Sincronizar agenda».
  assert.equal(tab.el("analyzeProjectBtn").hidden, true);
  assert.equal(tab.el("rerunOcrBtn").hidden, true);
  const rows = tab.run<Array<{ label: string }>>("buildConnectionItems(overlayState.context, getSetupFlowState(overlayState.context))");
  assert.deepEqual(Array.from(rows, (item) => item.label), ["ADACEEN", "Campus", "Editor"]);

  // «Analizar Campus» no vuelve a verificar y, con fechas, la accion pasa a «Sincronizar agenda».
  await drive(browser, tab.el("contextPrimaryActionBtn").click(), 2000);
  assert.equal(browser.requestsTo("/api/campus/analyze-page", "POST").length, 1);
  assert.equal(browser.requestsTo("/api/documents/bitacora/status").length, 1, "el acceso ya estaba confirmado");
  tab.run("overlayState.analysisWindowOpen = false; renderOverlay()");
  assert.equal(tab.el("contextPrimaryActionBtn").dataset.contextAction, "sync_campus_calendar");
  assert.equal(tab.el("contextPrimaryActionBtn").textContent, "Sincronizar agenda");
  assert.equal(tab.el("contextSecondaryActionBtn").hidden, true);

  // Al actualizar no se vuelve a pedir un acceso ya confirmado.
  await drive(browser, tab.run("refreshMentorSession({ trigger: 'manual', requestedAt: Date.now() })"), 2000);
  assert.equal(browser.requestsTo("/api/documents/bitacora/status").length, 1);
  assertKnownShadowIds(tab);
});

test("Campus: si la verificacion falla o falta la bitacora, «Verificar acceso» es la unica accion (item 10)", async () => {
  // Fallo del backend: un boton para reintentar, sin pares repetidos.
  const browser = campusBrowser();
  browser.bitacoraStatus = 500;
  const tab = await openCampusCourse(browser);
  assert.equal(tab.el("contextActionTitle").textContent, "Confirmar acceso");
  assert.match(tab.el("contextActionCopy").textContent, /No se pudo confirmar acceso al curso/);
  // El fallo tambien va al estado (role=status) para los lectores de pantalla.
  assert.match(tab.el("statusText").textContent, /No se pudo confirmar acceso al curso/);
  assert.equal(tab.el("contextPrimaryActionBtn").textContent, "Verificar acceso");
  assert.equal(tab.el("contextSecondaryActionBtn").hidden, true, "un solo curso: sin «Elegir curso»");
  browser.bitacoraStatus = 200;
  await drive(browser, tab.el("contextPrimaryActionBtn").click(), 2000);
  assert.equal(browser.requestsTo("/api/documents/bitacora/status").length, 2);
  assert.equal(tab.el("contextPrimaryActionBtn").textContent, "Analizar Campus");

  // Sin bitacora cargada por el docente: «Verificar acceso» una vez (antes con «Actualizar acceso»).
  const noLog = campusBrowser();
  noLog.bitacoraLatest = null;
  const noLogTab = await openCampusCourse(noLog);
  assert.equal(noLogTab.el("contextActionTitle").textContent, "Bitacora requerida");
  assert.match(noLogTab.el("contextActionCopy").textContent, /tu docente aun no carga la bitacora/);
  assert.match(noLogTab.el("statusText").textContent, /falta cargar bitacora/);
  assert.equal(noLogTab.el("contextPrimaryActionBtn").textContent, "Verificar acceso");
  assert.equal(noLogTab.el("contextSecondaryActionBtn").hidden, true);

  // Mientras verifica al entrar: «Verificando...» deshabilitado, sin otro boton.
  const slow = campusBrowser();
  slow.delays["/api/documents/bitacora/status"] = 3000;
  const slowTab = await openTab(slow, CAMPUS_COURSE_URL, "FPOO: Curso");
  await drive(slow, slowTab.run("openOverlay({ trigger: 'user' })"));
  await slow.clock.until(() => slow.requestsTo("/api/documents/bitacora/status").length > 0, 400);
  slowTab.run("renderOverlay()");
  assert.equal(slowTab.el("contextActionTitle").textContent, "Confirmando curso");
  assert.equal(slowTab.el("contextPrimaryActionBtn").disabled, true);
  assert.equal(slowTab.el("contextSecondaryActionBtn").hidden, true);
  await slow.clock.until(() => !slowTab.run("isCampusAccessVerificationInFlight()"), 400);
  assert.equal(slowTab.el("contextPrimaryActionBtn").textContent, "Analizar Campus");
  assertKnownShadowIds(tab, noLogTab, slowTab);
});

test("docente: una sola casilla de mini quiz y el aviso del backend en «Lanzar quiz» (item 9, contrato (c)); el piloto ya no esta en el overlay (0.7.15)", async () => {
  const browser = new FakeBrowser();
  browser.session = { ...SESSION, user: { ...SESSION.user, role: "teacher", assignedCourseCodes: [] } };
  browser.policy = {
    policyName: "RF-05 base del piloto",
    allowMiniQuiz: false,
    allowedInterventions: ["explanation", "hint", "example"],
    quizSettings: { triggers: ["after_accept"], everyNAccepts: 1, maxPerSession: null, followUpOnWrong: true },
  };
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);
  tab.run("overlayState.settingsOpen = true; renderOverlay()");
  await advance(browser, 1_000);
  assert.equal(tab.el("teacherSettingsBlock").hidden, false);

  // «Mini quiz» de «Intervenciones habilitadas» ya no existe: «Permitir mini quiz» escribe las dos cosas.
  const markup = tab.run<string>("buildOverlayMarkup()");
  assert.doesNotMatch(markup, /id="teacherAllowMiniQuizType"/);
  assert.doesNotMatch(markup, /<span>Mini quiz<\/span>/);
  assert.match(markup, /Permitir mini quiz/);
  assert.equal(tab.el("teacherMiniQuiz").checked, false);
  assert.equal(tab.el("teacherQuizTeacherLaunch").checked, false);

  // «Lanzar quiz» con el quiz apagado: el backend lo activa (contrato (c)) y el overlay muestra
  // su mensaje y marca las casillas, sin borrar lo que el docente tenia sin guardar.
  const autoEnabledPolicy = {
    ...browser.policy,
    allowMiniQuiz: true,
    quizSettings: { triggers: ["teacher_launch"], everyNAccepts: 1, maxPerSession: null, followUpOnWrong: true },
  };
  // Texto de POST /api/quiz/launches (src/routes/quiz/quiz-routes.ts) con el mini quiz apagado.
  const launchMessage = "Quiz lanzado. Se activo «Permitir mini quiz» con «Cuando yo lo lance a la clase» en tus parametros para que llegue a tus estudiantes.";
  browser.quizLaunchReply = { autoEnabled: true, message: launchMessage, policy: autoEnabledPolicy };
  browser.policy = autoEnabledPolicy;
  tab.el("teacherPolicyName").value = "Politica sin guardar";
  tab.el("teacherQuizTopic").value = "encapsulamiento";
  await drive(browser, tab.el("teacherQuizLaunchBtn").click(), 2000);
  assert.equal(browser.requestsTo("/api/quiz/launches", "POST").length, 1);
  assert.ok(tab.el("teacherQuizStatus").textContent.startsWith(launchMessage), tab.el("teacherQuizStatus").textContent);
  assert.match(tab.el("teacherQuizStatus").textContent, /Activo: "encapsulamiento"/);
  assert.equal(tab.el("teacherMiniQuiz").checked, true);
  assert.equal(tab.el("teacherQuizTeacherLaunch").checked, true);
  assert.equal(tab.el("teacherQuizAfterAccept").checked, false);
  tab.run("renderOverlay()");
  assert.equal(tab.el("teacherPolicyName").value, "Politica sin guardar", "lo no guardado se conserva");
  assert.equal(tab.el("teacherMiniQuiz").checked, true);

  // «Guardar cambios» no apaga lo que el backend activo y escribe el tipo mini_quiz con la misma casilla.
  await drive(browser, tab.el("saveSettingsBtn").click(), 2000);
  let saved = browser.requestsTo("/api/policies/current", "PUT").at(-1)?.body as Json;
  assert.equal(saved?.policyName, "Politica sin guardar");
  assert.equal(saved?.allowMiniQuiz, true);
  assert.deepEqual(saved?.allowedInterventions, ["explanation", "hint", "example", "mini_quiz"]);
  assert.deepEqual((saved?.quizSettings as Json)?.triggers, ["teacher_launch"]);
  // Apagar la casilla quita las dos cosas.
  tab.run("overlayState.settingsOpen = true; renderOverlay()");
  tab.el("teacherMiniQuiz").checked = false;
  await drive(browser, tab.el("saveSettingsBtn").click(), 2000);
  saved = browser.requestsTo("/api/policies/current", "PUT").at(-1)?.body as Json;
  assert.equal(saved?.allowMiniQuiz, false);
  assert.deepEqual(saved?.allowedInterventions, ["explanation", "hint", "example"]);

  // El piloto con y sin tutor sale del overlay (0.7.15): «eso va internamente», con
  // npm run piloto:bloque. La tuerca no lo consulta ni lo muestra.
  assert.doesNotMatch(markup, /Piloto con y sin tutor|Asignar grupos A y B|Iniciar bloque 1|teacherPilotBlock1Btn|settingsSectionPilot/);
  assert.deepEqual(browser.requestsTo("/api/pilot"), [], "la tuerca ya no consulta el piloto");
  // Lanzar un quiz vive en la pestana «Quices»; la tuerca solo dice cuando sale el mini quiz.
  assert.match(markup, /id="tabPanelQuices"[\s\S]*id="teacherQuizTopic"/);
  assert.match(markup, /usa la pestaña «Quices»/);
  assertKnownShadowIds(tab);
});

// ---- Revision de las tandas 1 y 2 (navegador 0.7.12) ----

function tutorRequests(browser: FakeBrowser) {
  return browser.requestsTo("/intervene").length + browser.requestsTo("/github-mentor").length;
}

async function restoreTab(browser: FakeBrowser, url: string, title: string) {
  const tab = await openTab(browser, url, title);
  await browser.clock.until(() => tab.run("overlayHost?.isConnected") === true, 400);
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);
  return tab;
}

test("ventanas del flujo de GitHub con el overlay fijado: sin entrar, sin repositorio falso ni aviso de otra pestana", async () => {
  // Las rutas de GitHub no son un owner: ni la ventana del OAuth ni la instalacion de la App
  // tienen repositorio.
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser, { adaceenOverlayPinned: true });
  // La pestana del overlay sigue activa unos segundos despues de abrir la ventana del OAuth.
  browser.activeTab = {
    isActive: true,
    tabId: "pestana-del-overlay",
    tabTitle: REPO,
    tabUrl: `https://github.com/${REPO}`,
    viewContext: `github | github_general | ${REPO}`,
  };
  const oauthTab = await restoreTab(browser, "https://github.com/login/oauth/authorize?client_id=prueba&state=estado", "Authorize application");
  await advance(browser, 3_000);
  assert.equal(oauthTab.state().started, false, "la ventana del OAuth no entra sola");
  assert.equal(oauthTab.el("welcomeView").hidden, false);
  assert.equal(oauthTab.el("setupView").hidden, true, "sin el tour ni «Conectar GitHub» encima de Authorize");
  assert.equal(oauthTab.el("tabConflictModal").hidden, true, "sin «Sesion activa en otra pestaña»");
  assert.equal(oauthTab.run("buildPayload().pageType"), "other");
  assert.equal(oauthTab.run("getCurrentRepoFullName()"), "", "login/oauth no es un repositorio");
  for (const route of ["/api/auth/me", "/github-mentor", "/intervene", "/api/workspaces/provider", "/api/github/oauth/status", "/api/github-app/status", "/api/ui/active-tab"]) {
    assert.deepEqual(browser.requestsTo(route), [], `la ventana del OAuth no pide ${route}`);
  }
  for (const url of [
    "https://github.com/login/oauth/authorize?client_id=prueba",
    "https://github.com/apps/adaceen-piloto/installations/new?state=estado-app",
    "https://github.com/settings/installations",
    "https://github.com/orgs/univalle-fpoo/repositories",
  ]) {
    assert.equal(oauthTab.run(`parseRepoFullName(${JSON.stringify(url)})`), "", url);
    assert.equal(oauthTab.run(`isGithubFlowPageUrl(${JSON.stringify(url)})`), true, url);
  }
  assert.equal(oauthTab.run(`parseRepoFullName("https://github.com/${REPO}/blob/main/src/Main.java")`), REPO);
  assert.equal(oauthTab.run(`isGithubFlowPageUrl("https://github.com/${REPO}")`), false);

  // Con Codespaces, la pestana de instalacion de la App tampoco entra ni consulta la App con
  // un repositorio "apps/adaceen-piloto".
  const codespaces = new FakeBrowser();
  codespaces.provider = "codespaces";
  seedLoggedInBrowser(codespaces, { adaceenOverlayPinned: true });
  const installTab = await restoreTab(codespaces, "https://github.com/apps/adaceen-piloto/installations/new?state=estado-app", "Install ADACEEN");
  await advance(codespaces, 3_000);
  assert.equal(installTab.state().started, false);
  assert.equal(installTab.el("setupView").hidden, true);
  assert.equal(installTab.run("getCurrentRepoFullName()"), "");
  assert.deepEqual(codespaces.requestsTo("/api/github-app/status"), []);
  assert.deepEqual(codespaces.requestsTo("/api/auth/me"), []);

  // Una pagina con repositorio restaurada mientras otra pestana tiene la sesion activa: se queda
  // en la bienvenida, sin el aviso de conflicto.
  const repoTab = await restoreTab(browser, `https://github.com/${REPO}`, REPO);
  await advance(browser, 3_000);
  assert.equal(repoTab.state().started, false);
  assert.equal(repoTab.el("welcomeView").hidden, false);
  assert.equal(repoTab.el("tabConflictModal").hidden, true, "sin el aviso al restaurar");
  assert.notEqual(repoTab.state().statusMessage, "Esta sesión ya está activa en otra pestaña.");
  assert.equal(tutorRequests(browser), 0);
  // Sin otra pestana activa, esa misma pagina entra sola, sin el tutor.
  browser.activeTab = null;
  const freeRepoTab = await restoreTab(browser, `https://github.com/${REPO}`, REPO);
  assert.equal(freeRepoTab.state().started, true, "con un repositorio si entra al restaurar");
  assert.equal(tutorRequests(browser), 0);

  // Una pagina sin contexto y sin un editor guardado: «Empezar», sin consultar el backend.
  const empty = new FakeBrowser();
  seedLoggedInBrowser(empty, { adaceenOverlayPinned: true });
  const emptyTab = await restoreTab(empty, "https://github.com/", "GitHub");
  assert.equal(emptyTab.state().started, false);
  assert.equal(emptyTab.el("welcomeView").hidden, false);
  assert.deepEqual(empty.requestsTo("/api/auth/me"), []);
  assertKnownShadowIds(oauthTab, installTab, repoTab, freeRepoTab, emptyTab);
});

test("privacidad pendiente: la pagina no va al tutor hasta «Aceptar y continuar»", async () => {
  // Sesion guardada sin la aceptacion (el estudiante cerro el overlay con el modal abierto) y
  // backend sin registro: el icono entra, pero el tutor no recibe el archivo abierto.
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: {} });
  browser.privacy = { version: null, acceptedAt: null };
  const tab = await openTab(browser, `https://github.com/${REPO}/blob/main/src/Main.java`, "Main.java");
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);
  assert.equal(tab.el("firstLoginModal").hidden, false, "se pregunta");
  assert.equal(tutorRequests(browser), 0, "sin pedir ayuda al tutor antes de aceptar");
  await drive(browser, tab.el("firstLoginConfirmBtn").click(), 2000);
  await browser.clock.until(() => tab.state().loading === false, 400);
  assert.deepEqual(browser.privacyAcceptances, [{ version: PRIVACY_POLICY_VERSION }]);
  assert.equal(tutorRequests(browser), 1, "al aceptar, el tutor responde una vez");

  // Primer inicio de sesion: igual, el tutor espera a la aceptacion.
  const fresh = new FakeBrowser();
  fresh.storage = { adaceenClientId: "cliente-nuevo-321" };
  fresh.privacy = { version: null, acceptedAt: null };
  fresh.firstLogin = true;
  const loginTab = await openTab(fresh, `https://github.com/${REPO}/blob/main/src/Main.java`, "Main.java");
  await loginFromOverlay(fresh, loginTab);
  assert.equal(loginTab.el("firstLoginModal").hidden, false);
  assert.equal(tutorRequests(fresh), 0);
  await drive(fresh, loginTab.el("firstLoginConfirmBtn").click(), 2000);
  await fresh.clock.until(() => loginTab.state().loading === false, 400);
  assert.equal(tutorRequests(fresh), 1);
  assertKnownShadowIds(tab, loginTab);
});

test("al abrir con el backend frio, «Preparando...» dura como mucho 10 s y el icono entra igual", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  browser.delays["/api/auth/me"] = 200_000;
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await advance(browser, 1_000);
  assert.equal(tab.el("startBtn").textContent, "Preparando...");
  assert.equal(tab.el("startBtn").disabled, true);
  await browser.clock.until(() => tab.state().started === true, 400);
  assert.ok(browser.clock.now - Date.parse("2026-09-25T13:00:00.000Z") < 15_000, "entra antes de 15 s (antes, hasta 120 s)");
  assert.equal(tab.state().started, true, "como «Empezar»");
  assertKnownShadowIds(tab);
});

test("Codespaces: una GitHub App ya instalada en la organizacion se vincula sin abrir la pestana de instalacion", async () => {
  const browser = new FakeBrowser();
  browser.provider = "codespaces";
  browser.appAutoLink = true;
  seedLoggedInBrowser(browser);
  const tab = await openCodespacesTour(browser);
  await browser.clock.until(() => tab.el("setupPrimaryActionBtn").dataset.contextAction === "connect_github_user", 400);
  assert.equal(browser.requestsTo("/api/github-app/link-installation-auto", "POST").length, 1);
  assert.equal(tab.el("setupPrimaryActionBtn").textContent, "Conectar GitHub", "el paso de la App se salta solo");
  assert.equal(tab.popups.length, 0, "sin abrir la instalacion");
  assert.deepEqual(browser.requestsTo("/api/github-app/install-url"), []);
  assert.match(tab.state().statusMessage, new RegExp(`^GitHub App lista: ya tiene acceso a ${REPO}\\. Ahora pulsa Conectar GitHub`));
  // Una vez por usuario y repositorio: al actualizar no se vuelve a intentar.
  await drive(browser, tab.run("refreshMentorSession({ trigger: 'manual', requestedAt: Date.now() })"), 2000);
  assert.equal(browser.requestsTo("/api/github-app/link-installation-auto", "POST").length, 1);

  // Con el tunel no se intenta nunca (la App no interviene).
  const tunnel = new FakeBrowser();
  tunnel.appAutoLink = true;
  seedLoggedInBrowser(tunnel);
  const tunnelTab = await openTab(tunnel, `https://github.com/${REPO}`, REPO);
  await drive(tunnel, tunnelTab.run("openOverlay({ trigger: 'user' })"));
  await tunnel.clock.until(() => !tunnelTab.run("savedEditorAutoEnterInFlight"), 400);
  await tunnel.clock.until(() => tunnelTab.state().loading === false, 400);
  await advance(tunnel, 2_000);
  assert.deepEqual(tunnel.requestsTo("/api/github-app/link-installation-auto"), []);
  assertKnownShadowIds(tab, tunnelTab);
});

test("otro navegador: si la cuenta cambia mientras se consulta el editor, no se guarda a nombre de la nueva", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  browser.githubConnected = true;
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("syncFromStorageSnapshot({ force: true })"));
  tab.run("overlayState.context = buildPayload()");
  await drive(browser, tab.run("refreshGithubIntegrationStatus()"));
  browser.statusSteps = [browser.ready()];
  browser.delays["/api/workspaces/status"] = 6_000;
  const pending = tab.run("adoptExistingTunnelEditor()");
  await browser.clock.settle();
  assert.equal(browser.requestsTo("/api/workspaces/status").length, 1);
  // En la Mac compartida: sale y entra otra cuenta en la misma pestana antes de la respuesta.
  tab.run("overlayState.session = { ...overlayState.session, id: 'sess-otro', user: { ...overlayState.session.user, id: 'u-otro' } }; overlayState.sessionId = 'sess-otro'");
  assert.equal(await drive(browser, pending), false);
  assert.deepEqual(browser.storage.adaceenEditorByUser ?? {}, {}, "el editor de la cuenta anterior no se guarda");
});
