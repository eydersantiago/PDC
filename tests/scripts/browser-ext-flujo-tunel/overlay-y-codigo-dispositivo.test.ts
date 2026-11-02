import assert from "node:assert/strict";
import test from "node:test";
import { MANIFEST, OVERLAY_SCRIPTS, BACKEND, REPO, TUNNEL_URL, SESSION, type Json } from "./harness-config.js";
import type { FakeElement } from "./harness-dom.js";
import { TabEnv } from "./harness-tab.js";
import { FakeBrowser } from "./harness-backend.js";
import { drive, openTab, advance, assertKnownShadowIds, seedLoggedInBrowser } from "./harness-utils.js";
import { EDITOR_KEY, savedEditorRecord, activeTabReports } from "./harness-helpers.js";

test("al abrir el overlay: sin «Empezar», y sin pedir ayuda al tutor cuando entra solo", async () => {
  // Restaurado en vscode.dev (tunel, con el editor guardado) o en Campus: entra sin «Empezar»,
  // sin pedir ayuda al tutor y sin reportarse como pestana activa hasta que el estudiante lo usa.
  const pages: Array<[string, string]> = [
    [TUNNEL_URL, "taller-1 [Tunel]"],
    ["https://campusvirtual.univalle.edu.co/moodle/course/view.php?id=77", "FPOO: Curso"],
  ];
  for (const [url, title] of pages) {
    const browser = new FakeBrowser();
    seedLoggedInBrowser(browser, {
      adaceenOverlayPinned: true,
      adaceenEditorByUser: { [EDITOR_KEY]: savedEditorRecord(browser) },
    });
    browser.githubConnected = true;
    const tab = await openTab(browser, url, title);
    await browser.clock.until(() => tab.run("overlayHost?.isConnected") === true, 400);
    await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 50);
    await advance(browser, 20_000);
    assert.equal(tab.state().started, true, `${url}: entra sin «Empezar»`);
    assert.equal(tab.el("mainView").hidden, false, `${url}: panel principal`);
    assert.deepEqual(browser.requestsTo("/intervene"), [], `${url}: sin pedir ayuda al tutor`);
    assert.deepEqual(browser.requestsTo("/github-mentor"), []);
    assert.deepEqual(activeTabReports(browser), [], `${url}: sin active_tab_seen`);
    assert.equal(browser.requestsTo("/api/auth/me").length, 1, `${url}: la sesion se confirma una vez`);
    assert.ok(browser.requestsTo("/api/rag/courses").length <= 1, `${url}: los cursos se piden una vez`);
    assertKnownShadowIds(tab);

    if (url === TUNNEL_URL) {
      // vscode.dev (item 4): textos del editor, no de Codespaces, y el repo del editor guardado.
      assert.equal(tab.run("getCurrentRepoFullName()"), REPO, "el repo sale del editor guardado con ese tunel");
      assert.equal(tab.el("contextActionTitle").textContent, "Tutor en tu editor");
      assert.equal(tab.el("contextSecondaryActionBtn").hidden, true, "sin «Reintentar OCR» (ya esta «OCR visual»)");
      assert.equal(tab.el("mainContext").textContent, "Tu editor en la nube");
      assert.equal(tab.el("contextTitle").textContent, "Editor en la nube detectado");
      assert.equal(tab.el("analyzeProjectBtn").hidden, false, "«Explorar repo» dentro del editor");
      assert.equal(tab.el("rerunOcrBtn").hidden, false);
      assert.equal(tab.el("analyzeProjectBtn").textContent, "Explorar repo");
      assert.equal(tab.el("rerunOcrBtn").textContent, "OCR visual", "en el editor, no «Sincronizar agenda»");
      for (const text of [
        tab.el("statusText").textContent,
        tab.el("welcomeCopy").textContent,
        tab.el("contextActionCopy").textContent,
        tab.el("vscodeSyncMeta").textContent,
      ]) {
        assert.doesNotMatch(String(text), /Codespace/, `sin Codespaces en vscode.dev: ${text}`);
      }
      tab.run("overlayState.analysisWindowOpen = true; renderOverlay()");
      assert.equal(tab.el("analysisTitle").textContent, "Analisis de archivos en tu editor");
      assert.equal(tab.el("analysisStats").textContent, "Pulsa Explorar repo para leer archivos y carpetas del explorador.", "cita el boton que existe");
      tab.run("overlayState.analysisWindowOpen = false; renderOverlay()");
      // «Copiar codigo para VS Code» (item 6): mientras VS Code no se conecta sigue a mano; con
      // VS Code conectado (la VM ya escribio la sesion) no se muestra.
      assert.equal(tab.el("vscodeSyncSection").hidden, false);
      assert.equal(tab.el("vscodeCopySessionBtn").hidden, false);
      browser.latestRack = { id: "rack-1", source: "vscode_extension", repoFullName: REPO, updatedAt: new Date(browser.clock.now - 60_000).toISOString() };
      await drive(browser, tab.run("refreshVscodeSyncState({ silent: true }).then(() => renderOverlay())"));
      assert.equal(tab.state().vscodeSyncState.fresh, true);
      assert.equal(tab.el("vscodeCopySessionBtn").hidden, true, "con VS Code conectado no hace falta el codigo");
      assert.match(tab.el("vscodeSyncMeta").textContent, /sincronizado con este editor/);
      // Con el proyecto leido, pedir ayuda es «Actualizar» de la cabecera (Ctrl+Enter): la accion
      // recomendada ya no lo repite con «Solicitar tutoria».
      assert.equal(tab.el("contextPrimaryActionBtn").hidden, true, "sin «Solicitar tutoria»");
      assert.match(tab.el("contextActionCopy").textContent, /Pulsa Actualizar \(Ctrl\+Enter\) para pedir una guia contextual\./);
      assert.equal(tab.el("refreshBtn").hidden, false);
      assert.equal(tab.el("refreshBtn").disabled, false);
      // El primer clic en el overlay la vuelve pestana activa; el tutor responde cuando se pide.
      await Promise.all((tab.shadowListeners.get("pointerdown") || []).map((listener) => listener({ type: "pointerdown" })));
      await browser.clock.until(() => activeTabReports(browser).length > 0, 50);
      assert.equal(activeTabReports(browser).length, 1);
      await drive(browser, tab.el("refreshBtn").click(), 2000);
      assert.equal(browser.requestsTo("/intervene").length + browser.requestsTo("/github-mentor").length, 1, "«Actualizar» pide ayuda");
    }
  }

  // Con el icono y sin editor guardado (lo normal con Codespaces) entra como «Empezar»: confirma
  // la sesion una vez, pide los cursos una vez (antes dos) y el tutor responde una vez.
  const browser = new FakeBrowser();
  browser.provider = "codespaces";
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);
  assert.equal(tab.state().started, true);
  assert.equal(browser.requestsTo("/api/auth/me").length, 1);
  assert.equal(browser.requestsTo("/api/rag/courses").length, 1);
  assert.equal(browser.requestsTo("/intervene").length + browser.requestsTo("/github-mentor").length, 1, "como «Empezar», el tutor responde una vez");

  // Sin sesion, el icono muestra el login directamente (sin pasar por «Empezar»).
  const anonymous = new FakeBrowser();
  anonymous.storage = { adaceenClientId: "cliente-prueba-123" };
  const loginTab = await openTab(anonymous, `https://github.com/${REPO}`, REPO);
  await drive(anonymous, loginTab.run("openOverlay({ trigger: 'user' })"));
  await anonymous.clock.until(() => !loginTab.run("savedEditorAutoEnterInFlight"), 50);
  assert.equal(loginTab.el("welcomeView").hidden, true);
  assert.equal(loginTab.el("authView").hidden, false, "el login a la vista");
  assert.deepEqual(anonymous.requestsTo("/api/auth/me"), []);

  // Sesion vencida (otro inicio de sesion la cerro): el login con el motivo, sin entrar.
  const expired = new FakeBrowser();
  seedLoggedInBrowser(expired);
  expired.sessionValid = false;
  const expiredTab = await openTab(expired, `https://github.com/${REPO}`, REPO);
  await drive(expired, expiredTab.run("openOverlay({ trigger: 'user' })"));
  await expired.clock.until(() => !expiredTab.run("savedEditorAutoEnterInFlight"), 50);
  assert.equal(expiredTab.el("authView").hidden, false);
  assert.equal(expiredTab.state().authError, "La sesion ya no es valida. Inicia sesion nuevamente.");
  assert.equal(expired.storage.adaceenSessionId, "", "la sesion vencida se olvida");
  assert.equal(expired.storage.adaceenActiveSessionSnapshot, undefined);
  assertKnownShadowIds(tab, loginTab, expiredTab);
});

test("aviso del codigo de dispositivo: solo para su usuario, sin copiar tarde y dice cuando ADACEEN deja de esperar", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  browser.githubConnected = true;
  const handoff = (extra: Json = {}) => ({
    userCode: "WDJB-MJHT",
    userId: SESSION.user.id,
    repoFullName: REPO,
    expiresAt: browser.clock.now + 10 * 60_000,
    savedAt: browser.clock.now,
    aliveAt: browser.clock.now,
    ...extra,
  });
  const helperOf = (tab: TabEnv) => tab.document.getElementById("adaceen-device-code-helper");
  const statusOf = (tab: TabEnv) => String(helperOf(tab)?.shadow?.getElementById("adaceenDeviceCodeStatus").textContent || "");

  // Codigo de otro usuario de ADACEEN (equipo compartido): ni se muestra ni se copia.
  browser.storage.adaceenDeviceCodeHandoff = handoff({ userId: "u-otro" });
  const otherUser = await openTab(browser, "https://github.com/login/device", "Device Activation");
  await advance(browser, 2_000);
  assert.equal(helperOf(otherUser), null, "no se muestra el codigo de otro usuario");
  assert.deepEqual(browser.clipboard, []);

  // Visita posterior (codigo emitido hace 5 min, espera viva): se muestra, pero sin tocar el portapapeles.
  browser.storage.adaceenDeviceCodeHandoff = handoff({ savedAt: browser.clock.now - 5 * 60_000 });
  const lateVisit = await openTab(browser, "https://github.com/login/device", "Device Activation");
  await browser.clock.until(() => !!helperOf(lateVisit), 50);
  assert.ok(helperOf(lateVisit), "el aviso aparece para su usuario");
  assert.deepEqual(browser.clipboard, [], "una visita tardia no copia sola");
  // La pestana que esperaba se recargo o se cerro (sin latidos): el aviso deja de prometer el editor.
  await advance(browser, 75_000);
  // Sin editor guardado el boton de la pestana de ADACEEN es «Preparar mi editor» (item 3).
  assert.match(statusOf(lateVisit), /ADACEEN ya no espera este codigo\. .*pulsa "Preparar mi editor"/);

  // Flujo real: tras el codigo, el backend responde un error no reintentable. La pestana de
  // github.com/login/device lo dice (antes seguia prometiendo abrir el editor).
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 50);
  await drive(browser, tab.run("fetchCurrentSession()"));
  await drive(browser, tab.run("refreshWorkspaceProvider(true)"));
  browser.prepareSteps = [browser.deviceCode()];
  browser.statusSteps = [browser.deviceCode(), browser.deviceCode(), browser.deviceCode(), browser.agentError()];
  const preparing = tab.run("prepareTunnelWorkspace()");
  await browser.clock.until(() => tab.popups[0]?.currentHref === "https://github.com/login/device", 200);
  const deviceTab = await openTab(browser, "https://github.com/login/device", "Device Activation");
  await browser.clock.until(() => !!helperOf(deviceTab), 50);
  // Recien emitido el codigo (la ventana llego aqui por el flujo) si se copia solo.
  assert.match(statusOf(deviceTab), /^Codigo copiado: .*Esta pestana abrira tu editor sola\.$/);
  await drive(browser, preparing, 2000);
  await advance(browser, 1_000);
  assert.match(statusOf(deviceTab), /ADACEEN dejo de esperar\. Tu editor ya tiene otro repositorio abierto\. .*"Preparar mi editor"/);
  assert.doesNotMatch(statusOf(deviceTab), /Abrir mi editor/, "el mensaje cita el boton que se ve");
  assert.equal((browser.storage.adaceenDeviceCodeHandoff as Json)?.outcome, "error");

  // Cerrar sesion borra el codigo pendiente.
  browser.storage.adaceenDeviceCodeHandoff = handoff();
  await drive(browser, tab.run("logoutFromBackend()"));
  assert.equal(browser.storage.adaceenDeviceCodeHandoff, undefined);
  assertKnownShadowIds(tab, deviceTab, lateVisit);
});

test("0.7.20: el codigo se escribe solo en el formulario de github.com/login/device (un campo u ocho cuadros) y nunca se envia", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  browser.githubConnected = true;
  const CODE = "WDJB-MJHT";
  const handoff = () => ({
    userCode: CODE,
    userId: SESSION.user.id,
    repoFullName: REPO,
    expiresAt: browser.clock.now + 10 * 60_000,
    savedAt: browser.clock.now,
    aliveAt: browser.clock.now,
  });
  const helperOf = (tab: TabEnv) => tab.document.getElementById("adaceen-device-code-helper");
  const statusOf = (tab: TabEnv) => String(helperOf(tab)?.shadow?.getElementById("adaceenDeviceCodeStatus").textContent || "");
  const FILLED = "El codigo ya esta en el formulario: pulsa Continue y autoriza con tu cuenta de GitHub. Esta pestana abrira tu editor sola.";

  // Campos del formulario de GitHub, como objetos minimos (lo que usa el autorrelleno).
  type FakeField = Json & { value: string; events: string[] };
  const field = (attrs: Json = {}): FakeField => ({
    type: "text", name: "", id: "", className: "", value: "", disabled: false, readOnly: false, maxLength: -1, events: [],
    getAttribute(name: string) { return name in attrs ? String(attrs[name]) : null; },
    dispatchEvent(event: { type: string }) { (this as FakeField).events.push(event.type); return true; },
    ...attrs,
  });
  const form = (action: string, fields: FakeField[], submits = 0) => ({
    submitted: submits,
    getAttribute(name: string) { return name === "action" ? action : null; },
    querySelectorAll(selector: string) { return selector === "input" ? fields : []; },
    submit() { this.submitted += 1; },
    requestSubmit() { this.submitted += 1; },
  });
  // Pestana de github.com/login/device con un formulario dado (sin Event: los scripts lo toleran).
  const deviceTabWith = async (forms: unknown[], withEvents = true) => {
    const tab = new TabEnv(browser, "https://github.com/login/device", "Device Activation");
    tab.document.querySelectorAll = ((selector: string) => (selector === "form" ? forms : [])) as any;
    if (withEvents) {
      Object.assign(tab.context, { Event: class { constructor(readonly type: string, readonly init?: Json) {} } });
    }
    tab.load(OVERLAY_SCRIPTS);
    await browser.clock.settle();
    await browser.clock.until(() => !!helperOf(tab), 50);
    return tab;
  };

  // (a) Un solo campo user_code, con un campo oculto del mismo nombre y la contrasena de otro formulario intacta.
  browser.storage.adaceenDeviceCodeHandoff = handoff();
  const single = field({ name: "user_code", id: "user-code", maxLength: 9 });
  const hidden = field({ type: "hidden", name: "user_code" });
  const password = field({ type: "password", name: "password" });
  const loginForm = form("/session", [password]);
  const deviceForm = form("/login/device", [hidden, single]);
  const one = await deviceTabWith([loginForm, deviceForm]);
  assert.equal(single.value, CODE, "el codigo queda en el campo");
  assert.deepEqual(single.events, ["input", "change"], "la pagina ve el cambio como si se escribiera");
  assert.equal(hidden.value, CODE, "el campo oculto con el codigo completo tambien");
  assert.equal(password.value, "", "no toca campos de otros formularios");
  assert.equal(deviceForm.submitted, 0, "nunca envia el formulario: autorizar es del estudiante");
  assert.equal(statusOf(one), FILLED);
  // La copia automatica (codigo recien emitido) no tapa el mensaje del codigo puesto.
  assert.deepEqual(browser.clipboard, [CODE]);
  assert.equal(statusOf(one), FILLED);

  // (b) Ocho cuadros de un caracter sin nombre: un caracter por cuadro, en orden.
  browser.clipboard = [];
  browser.storage.adaceenDeviceCodeHandoff = handoff();
  const boxes = Array.from({ length: 8 }, () => field({ maxLength: 1 }));
  const boxesForm = form("/login/device", boxes);
  const eight = await deviceTabWith([boxesForm]);
  assert.equal(boxes.map((box) => box.value).join(""), "WDJBMJHT");
  assert.ok(boxes.every((box) => box.events.includes("input")));
  assert.equal(boxesForm.submitted, 0);
  assert.equal(statusOf(eight), FILLED);

  // (c) Formulario que no se reconoce (GitHub lo cambio): no se toca nada y se sigue pidiendo pegar.
  browser.clipboard = [];
  browser.storage.adaceenDeviceCodeHandoff = handoff();
  const unknown = field({ name: "otp", maxLength: 6 });
  const unknownForm = form("/login/device", [unknown]);
  const other = await deviceTabWith([unknownForm]);
  await advance(browser, 4_000);
  assert.equal(unknown.value, "", "un campo desconocido no se rellena");
  assert.match(statusOf(other), /^Codigo copiado: pegalo en el primer cuadro/);

  // (d) GitHub emite otro codigo en la misma espera: se escribe el nuevo.
  const again = field({ name: "user_code" });
  const againForm = form("/login/device", [again]);
  browser.storage.adaceenDeviceCodeHandoff = handoff();
  const renewed = await deviceTabWith([againForm]);
  assert.equal(again.value, CODE);
  browser.storage.adaceenDeviceCodeHandoff = { ...handoff(), userCode: "ABCD-EFGH" };
  browser.storageListeners.forEach((listener) => listener({ adaceenDeviceCodeHandoff: { newValue: browser.storage.adaceenDeviceCodeHandoff } }, "local"));
  await browser.clock.settle();
  assert.equal(again.value, "ABCD-EFGH", "el codigo nuevo reemplaza al anterior en el formulario");
  assert.equal(statusOf(renewed), FILLED);
  assertKnownShadowIds(one, eight, other, renewed);
});

test("proveedor: un fallo pasajero no fija Codespaces 5 min ni borra el setup", async () => {
  // Con un editor del tunel guardado, el respaldo es el tunel y se reintenta en segundos.
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser, { adaceenEditorByUser: { [EDITOR_KEY]: savedEditorRecord(browser) } });
  browser.providerStatus = 503;
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("syncFromStorageSnapshot({ force: true })"));
  assert.equal(await drive(browser, tab.run("refreshWorkspaceProvider(true)")), "tunnel");
  assert.equal(tab.run("isWorkspaceProviderProvisional()"), true);
  browser.providerStatus = 200;
  const before = browser.requestsTo("/api/workspaces/provider").length;
  await drive(browser, tab.run("refreshWorkspaceProvider()"));
  assert.equal(browser.requestsTo("/api/workspaces/provider").length, before, "dentro de los 15 s usa el respaldo");
  await advance(browser, 16_000);
  await drive(browser, tab.run("refreshWorkspaceProvider()"));
  assert.equal(browser.requestsTo("/api/workspaces/provider").length, before + 1, "pasados 15 s vuelve a consultar");
  assert.equal(tab.run("isWorkspaceProviderProvisional()"), false);

  // Sin editor guardado: Codespaces provisional, y refreshGithubAppStatus no borra el setup.
  const other = new FakeBrowser();
  other.providerStatus = 503;
  other.appStatus = { configured: true, installation: { accountLogin: "alumno" }, hasRepoAccess: true, bootstrapReady: false };
  seedLoggedInBrowser(other, { adaceenSetupDoneByUser: { [EDITOR_KEY]: true } });
  const otherTab = await openTab(other, `https://github.com/${REPO}`, REPO);
  await drive(other, otherTab.run("syncFromStorageSnapshot({ force: true })"));
  otherTab.run("overlayState.context = buildPayload()");
  assert.equal(otherTab.run("getCurrentRepoFullName()"), REPO);
  await drive(other, otherTab.run("refreshGithubIntegrationStatus().catch(() => {})"));
  assert.equal(otherTab.state().workspaceProvider, "codespaces");
  assert.equal(otherTab.run("isWorkspaceProviderProvisional()"), true);
  assert.equal((other.storage.adaceenSetupDoneByUser as Json)?.[EDITOR_KEY], true, "no se borra el setup con un proveedor provisional");
  // 404: backend sin la ruta, Codespaces confirmado (y ahi si se aplica la regla de siempre).
  other.providerStatus = 404;
  await drive(other, otherTab.run("refreshWorkspaceProvider(true)"));
  assert.equal(otherTab.state().workspaceProvider, "codespaces");
  assert.equal(otherTab.run("isWorkspaceProviderProvisional()"), false);
});

test("VS Code de este equipo y 'Copiar sesion' usan un codigo de un solo uso", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"));
  await drive(browser, tab.run("fetchCurrentSession()"));
  // Los enlaces vscode:// no pasan por el DOM de la pagina (el codigo es una credencial).
  const pageAnchors: string[] = [];
  const appendToBody = tab.document.body.appendChild.bind(tab.document.body);
  tab.document.body.appendChild = (child: FakeElement) => {
    if (child.tagName === "A") pageAnchors.push(child.href);
    return appendToBody(child);
  };

  await drive(browser, tab.run("openLocalVscodeClone()"));
  assert.deepEqual(tab.openedLinks, [`vscode://adaceen.adaceen/abrir?code=K7P4-M2QX&repo=${REPO}`]);
  assert.equal(browser.clipboard.length, 0, "ya no se copia la sesion");
  assert.deepEqual(pageAnchors, [], "el enlace con el codigo se pulsa dentro de la shadow root del overlay");

  await drive(browser, tab.run("copyEditorPairingCodeForVscode()"));
  assert.deepEqual(browser.clipboard, ["K7P4-M2QX"]);
  assert.match(tab.state().statusMessage, /ADACEEN: Conectar/);
  assert.match(tab.state().statusMessage, /actualiza su extension de ADACEEN .*la anterior no acepta codigos/, "avisa a quien tiene VS Code 0.0.30 o anterior");
  assert.doesNotMatch(tab.state().statusMessage, new RegExp(SESSION.id));

  // Fallo pasajero (503): el repo se abre sin codigo y la sesion del navegador NO se copia.
  browser.pairingMode = "fail";
  await drive(browser, tab.run("openLocalVscodeClone()"));
  assert.equal(tab.openedLinks[1], `vscode://adaceen.adaceen/abrir?repo=${REPO}`);
  assert.match(tab.state().statusMessage, /ADACEEN: sin conectar/);
  assert.equal(await drive(browser, tab.run("copyEditorPairingCodeForVscode()")), false);
  assert.match(tab.state().statusMessage, /Pulsa Copiar codigo para VS Code de nuevo/);
  // Tiempo agotado (arranque en frio del backend): igual, sin copiar la sesion.
  browser.pairingMode = "ok";
  browser.delays["/api/auth/editor/pairing-code"] = 5000;
  await drive(browser, tab.run("openLocalVscodeClone()"));
  assert.equal(tab.openedLinks[2], `vscode://adaceen.adaceen/abrir?repo=${REPO}`);
  assert.match(tab.state().statusMessage, /Tiempo de espera agotado/);
  delete browser.delays["/api/auth/editor/pairing-code"];
  assert.deepEqual(browser.clipboard, ["K7P4-M2QX"], "ningun fallo pasajero copio la sesion");

  // Backend anterior sin emparejamiento (404): se cae al enlace anterior de clonado.
  browser.pairingMode = "missing";
  await drive(browser, tab.run("openLocalVscodeClone()"));
  assert.equal(tab.openedLinks[3], `vscode://vscode.git/clone?url=${encodeURIComponent(`https://github.com/${REPO}.git`)}`);
  assert.equal(browser.clipboard[browser.clipboard.length - 1], SESSION.id);
  assert.match(tab.state().statusMessage, /Configurar sesion compartida/);
  assert.deepEqual(pageAnchors, []);
  assertKnownShadowIds(tab);
});

test("la pagina /empezar detecta la extension con el content script propio", async () => {
  const browser = new FakeBrowser();
  const tab = new TabEnv(browser, `${BACKEND}/empezar`, "Empezar con ADACEEN");
  const messages: Json[] = [];
  tab.window.addEventListener("message", (event: Json) => messages.push(event));
  tab.load(["inicio/pagina-inicio.content.js"]);
  assert.equal(tab.document.documentElement.dataset.adaceenExtension, MANIFEST.version);
  assert.equal(messages.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0].data)), { type: "adaceen:extension", version: MANIFEST.version });
  assert.equal(messages[0].targetOrigin, BACKEND);
});
