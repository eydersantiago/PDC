import assert from "node:assert/strict";
import test from "node:test";
import { REPO, TUNNEL_URL, SESSION, type Json } from "./harness-config.js";
import type { FakePopup } from "./harness-dom.js";
import type { TabEnv } from "./harness-tab.js";
import { FakeBrowser } from "./harness-backend.js";
import { drive, openTab, advance, assertKnownShadowIds, seedLoggedInBrowser } from "./harness-utils.js";
import { repoButton } from "./harness-helpers.js";

test("0.8.4 (paso 3): el aviso del código muestra el dibujo de la pantalla de GitHub y se pliega dejando el código a la vista", async () => {
  const browser = new FakeBrowser();
  browser.githubConnected = true;
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 50);
  await drive(browser, tab.run("refreshWorkspaceProvider(true)"));
  browser.prepareSteps = [browser.deviceCode()];
  browser.statusSteps = [browser.deviceCode()];
  drive(browser, tab.run("prepareTunnelWorkspace()"), 400).catch(() => {});
  await browser.clock.until(() => !!browser.storage.adaceenDeviceCodeHandoff, 50);
  const device = await openTab(browser, "https://github.com/login/device", "Device Activation");
  const helperOf = (t: TabEnv) => t.document.getElementById("adaceen-device-code-helper");
  await browser.clock.until(() => !!helperOf(device), 50);
  const shadow = helperOf(device)!.shadow!;
  assert.equal(shadow.getElementById("adaceenGuideFigure").getAttribute("data-figure"), "github-device-code");
  assert.match(String(shadow.getElementById("adaceenGuideFigureOpen").innerHTML), /<svg/);
  await shadow.getElementById("adaceenDeviceCodeMinimize").click();
  assert.equal(shadow.getElementById("adaceenDeviceCodeBox").hidden, true);
  assert.equal(shadow.getElementById("adaceenDeviceCodePill").hidden, false);
  assert.equal(shadow.getElementById("adaceenDeviceCodePillCode").textContent, "WDJB-MJHT", "plegado sigue a la vista el código");
  await shadow.getElementById("adaceenDeviceCodePill").click();
  assert.equal(shadow.getElementById("adaceenDeviceCodeBox").hidden, false);

  // En una pantalla chica el aviso tapa «Continue» de GitHub: se pliega solo y el anillo marca el botón.
  const otherTab = await openTab(browser, "https://github.com/login/device", "Device Activation");
  const continueButton = otherTab.document.createElement("input");
  continueButton.value = "Continue";
  otherTab.document.body.appendChild(continueButton);
  otherTab.document.querySelectorAll = ((selector: string) => (selector.includes("submit") ? [continueButton] : [])) as any;
  await browser.clock.until(() => !!helperOf(otherTab), 50);
  await advance(browser, 1_000);
  const small = helperOf(otherTab)!.shadow!;
  assert.equal(small.getElementById("adaceenDeviceCodeBox").hidden, true, "no tapa el botón que hay que pulsar");
  assert.equal(small.getElementById("adaceenDeviceCodePill").hidden, false);
  assert.equal(small.getElementById("adaceenGuidePointer").hidden, false);
  assert.equal(small.getElementById("adaceenGuidePointerLabel").textContent, "Pulsa «Continue»");
  assertKnownShadowIds(device, otherTab);
});

test("0.8.4 (paso 3): las reglas del aviso del código son un modelo puro (cuenta, anillo, escribir el código)", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, "https://github.com/login/device", "Device Activation");
  const model = (input: Json) => tab.run<Json>(`buildDeviceCodeHelperModel(${JSON.stringify(input)})`);
  const right = model({ step: "code", expectedLogin: "alumno", signedIn: "alumno" });
  assert.deepEqual([right.figure, right.wrongAccount, right.canFill, (right.pointer as Json)?.kind, (right.account as Json)?.tone], ["github-device-code", false, true, "continue", "ok"]);
  assert.equal((right.pointer as Json)?.label, "Pulsa «Continue»");
  const wrong = model({ step: "authorize", expectedLogin: "alumno", signedIn: "otra-cuenta" });
  assert.deepEqual([wrong.wrongAccount, wrong.canFill, wrong.pointer, (wrong.account as Json)?.tone], [true, false, null, "wrong"]);
  assert.match(String(wrong.statusText), /^No pulses «Authorize» con «otra-cuenta»/);
  assert.equal(wrong.rememberDeviceAccount, true, "quien esta por autorizar queda anotado");
  const signin = model({ step: "signin", expectedLogin: "alumno", signedIn: "" });
  assert.deepEqual([signin.canFill, signin.pointer, signin.account, signin.figure], [false, null, null, ""]);
  assert.match(String(signin.statusText), /con tu cuenta «alumno»/);
  assert.equal(model({ step: "done", expectedLogin: "alumno", signedIn: "alumno", switching: true }).finishAccountSwitch, true);
  assert.equal(model({ step: "failed" }).statusText, model({ step: "code" }).statusText, "el desenlace lo pone settle()");
});

test("0.8.4: la línea «VS Code» de Inicio dice la versión de ADACEEN del editor y avisa si es anterior", async () => {
  const browser = new FakeBrowser();
  browser.githubConnected = true;
  seedLoggedInBrowser(browser);
  browser.latestRack = { id: "rack-1", source: "vscode_extension", repoFullName: REPO, activeFilePath: "src/main.cpp", updatedAt: new Date(browser.clock.now).toISOString(), generatedAt: new Date(browser.clock.now).toISOString() };
  const editor = await openTab(browser, TUNNEL_URL, "taller-1 - Visual Studio Code");
  const lineModel = () => editor.run<Json>("buildVscodeSyncLineModel(buildPayload(), overlayState.vscodeSyncState)");
  // Backend anterior (sin vscodeExtension): igual que antes.
  await drive(browser, editor.run("refreshVscodeSyncState({ silent: true })"));
  assert.equal(editor.run("overlayState.vscodeSyncState.extension"), null);
  const before = lineModel();
  assert.doesNotMatch(String(before.meta), /ADACEEN \d/);
  // Al día en el túnel (otro editor con otra versión no cuenta).
  browser.vscodeExtension = {
    latestVersion: "0.0.37",
    lastSeenEditorHost: "local",
    byEditorHost: {
      tunnel: { status: "up_to_date", latestVersion: "0.0.37", version: "0.0.37", editorHost: "tunnel", lastSeenAt: "2026-10-25T20:00:00.000Z", online: true },
      local: { status: "outdated", latestVersion: "0.0.37", version: "0.0.30", editorHost: "local", lastSeenAt: "2026-10-25T20:01:00.000Z", online: true },
    },
  };
  await drive(browser, editor.run("refreshVscodeSyncState({ silent: true })"));
  assert.match(String(lineModel().meta), /^ADACEEN 0\.0\.37 \(la última\)/);
  // Anterior en el túnel: aviso ámbar y qué pasa.
  (browser.vscodeExtension.byEditorHost as Json).tunnel = { status: "outdated", latestVersion: null, version: "0.0.35", editorHost: "tunnel", lastSeenAt: "2026-10-25T20:00:00.000Z", online: true };
  await drive(browser, editor.run("refreshVscodeSyncState({ silent: true })"));
  const outdated = lineModel();
  assert.match(String(outdated.meta), /^ADACEEN 0\.0\.35 · hay 0\.0\.37: la nueva llega sola al encender el editor/, "la publicada sale del contenedor");
  if (before.kind === "ok") {
    assert.equal(outdated.kind, "warn");
    assert.equal(outdated.status, "VS Code conectado, con una versión anterior de ADACEEN");
  }
  // Sin la publicada en el backend: solo la version, sin decir que es la ultima ni que es anterior.
  browser.vscodeExtension = { latestVersion: null, lastSeenEditorHost: "tunnel", byEditorHost: { tunnel: { status: "latest_version_unknown", latestVersion: null, version: "0.0.37", editorHost: "tunnel", lastSeenAt: "2026-10-25T20:00:00.000Z", online: true } } };
  await drive(browser, editor.run("refreshVscodeSyncState({ silent: true })"));
  assert.match(String(lineModel().meta), /^ADACEEN 0\.0\.37( ·|$)/);
  assert.doesNotMatch(String(lineModel().meta), /la última|hay 0/);
  // Sin version (VS Code 0.0.36 o anterior) y anterior segun el backend: lo dice sin inventar un numero.
  browser.vscodeExtension = { latestVersion: "0.0.37", lastSeenEditorHost: "tunnel", byEditorHost: { tunnel: { status: "outdated", latestVersion: "0.0.37", version: null, editorHost: "tunnel", lastSeenAt: "2026-10-25T20:00:00.000Z", online: true } } };
  await drive(browser, editor.run("refreshVscodeSyncState({ silent: true })"));
  assert.match(String(lineModel().meta), /^Una versión anterior de ADACEEN · hay 0\.0\.37: la nueva llega sola al encender el editor/);
});

test("0.7.20 (acceso al tunel): con la VM apagada, el docente lee que la encienda el (no «avisa al docente»); el estudiante, a quien avisar", async () => {
  const titleOf = (popup: FakePopup) => popup.document.getElementById("adaceenWaitTitle").textContent;
  const detailOf = (popup: FakePopup) => popup.document.getElementById("adaceenWaitDetail").textContent;
  const staffVmOff = (browser: FakeBrowser) => ({
    ...browser.vmOff(),
    message: "La VM de editores esta apagada: enciendela con bash deploy/clase.sh iniciar en Cloud Shell. Esta ventana seguira esperando.",
  });

  const browser = new FakeBrowser();
  browser.session = { ...SESSION, user: { ...SESSION.user, role: "teacher", assignedCourseCodes: [] } };
  browser.githubConnected = true;
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await browser.clock.until(() => !!repoButton(tab), 50);
  browser.prepareSteps = [staffVmOff(browser)];
  browser.statusSteps = [staffVmOff(browser)];
  await repoButton(tab)!.button.click();
  const popup = tab.popups[0];
  await browser.clock.until(() => titleOf(popup) === "La VM de editores esta apagada", 400);
  assert.match(String(detailOf(popup)), /clase\.sh iniciar/);
  // Mientras espera, la ventana consulta el material del curso y lo pinta (antes, sin consultar,
  // salia «0 base, 0 del profesor»). Los cursos ya estaban: no se vuelven a pedir.
  const panelsOf = (target: FakePopup) => String(target.document.getElementById("adaceenWaitPanels").innerHTML);
  await browser.clock.until(() => /Fuentes disponibles: 1 base, 1 del profesor\./.test(panelsOf(popup)), 200);
  assert.match(panelsOf(popup), /Subido por profesor: Taller 2\./);
  assert.equal(browser.requestsTo("/api/rag/sources").length, 1);
  // Se agota la espera (12 min): el boton vuelve y el texto no manda a avisar a nadie.
  await browser.clock.until(() => titleOf(popup) === "El editor no confirmo a tiempo", 4000);
  assert.equal(detailOf(popup), 'La VM de editores sigue apagada. Enciendela con bash deploy/clase.sh iniciar y pulsa "Abrir en mi editor" de nuevo.', "el boton que pulso (el de la pagina), no el del overlay");
  assert.doesNotMatch(String(detailOf(popup)), /docente/);

  // El estudiante sigue leyendo a quien avisar.
  const student = new FakeBrowser();
  student.githubConnected = true;
  seedLoggedInBrowser(student);
  const studentTab = await openTab(student, `https://github.com/${REPO}`, REPO);
  await student.clock.until(() => !!repoButton(studentTab), 50);
  student.prepareSteps = [student.vmOff()];
  student.statusSteps = [student.vmOff()];
  await repoButton(studentTab)!.button.click();
  const studentPopup = studentTab.popups[0];
  await student.clock.until(() => titleOf(studentPopup) === "El editor esta apagado; avisa al docente", 400);
  await student.clock.until(() => titleOf(studentPopup) === "El editor no confirmo a tiempo", 4000);
  assert.equal(detailOf(studentPopup), 'La VM de editores sigue apagada. Pulsa "Abrir en mi editor" de nuevo cuando el docente la encienda.');
});
