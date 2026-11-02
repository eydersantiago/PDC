import assert from "node:assert/strict";
import test from "node:test";
import { REPO, TUNNEL_URL, STAFF_VM_COMMAND, SESSION, type Json } from "./harness-config.js";
import { FakeElement, type FakeShadowRoot } from "./harness-dom.js";
import { TabEnv } from "./harness-tab.js";
import { FakeBrowser } from "./harness-backend.js";
import { drive, openTab, advance, assertKnownShadowIds, seedLoggedInBrowser } from "./harness-utils.js";
import { EDITOR_KEY, signInHintOf } from "./harness-helpers.js";

test("0.7.20 (acceso al tunel): el aviso del codigo sigue a GitHub (inicio de sesion, codigo, autorizar, listo) y avisa si la cuenta no es la del editor", async () => {
  const browser = new FakeBrowser();
  browser.githubConnected = true;
  seedLoggedInBrowser(browser);
  const handoff = (extra: Json = {}) => ({
    userCode: "WDJB-MJHT",
    userId: SESSION.user.id,
    repoFullName: REPO,
    githubLogin: "alumno",
    expiresAt: browser.clock.now + 10 * 60_000,
    savedAt: browser.clock.now,
    aliveAt: browser.clock.now,
    ...extra,
  });
  const helperOf = (tab: TabEnv) => tab.document.getElementById("adaceen-device-code-helper");
  const textOf = (tab: TabEnv, id: string) => String(helperOf(tab)?.shadow?.getElementById(id)?.textContent || "");
  const accountOf = (tab: TabEnv) => helperOf(tab)?.shadow?.getElementById("adaceenDeviceCodeAccount");
  // GitHub publica la cuenta abierta en <meta name="user-login">.
  const openGithub = async (url: string, signedIn: string) => {
    const tab = new TabEnv(browser, url, "GitHub");
    const meta = new FakeElement("meta", tab);
    meta.setAttribute("content", signedIn);
    tab.document.selectors.set('meta[name="user-login"]', meta);
    tab.load();
    await browser.clock.settle();
    await browser.clock.until(() => !!helperOf(tab), 50);
    return tab;
  };

  // Sin sesion en GitHub, /login/device lleva antes al inicio de sesion: el aviso ya esta ahi,
  // dice con que cuenta entrar y deja el codigo copiado para despues.
  browser.storage.adaceenDeviceCodeHandoff = handoff();
  const signin = await openGithub("https://github.com/login?return_to=%2Flogin%2Fdevice", "");
  assert.equal(textOf(signin, "adaceenDeviceCode"), "WDJB-MJHT");
  assert.match(textOf(signin, "adaceenDeviceCodeStatus"), /Inicia sesion con «alumno» y, cuando GitHub lo pida, pegalo y autoriza/);
  assert.equal(accountOf(signin)?.hidden, true, "sin sesion en GitHub no hay cuenta que comparar");
  assert.deepEqual(browser.clipboard, ["WDJB-MJHT"]);

  // Con otra cuenta abierta: aviso claro antes de autorizar (si no, vscode.dev no encuentra el tunel).
  const wrong = await openGithub("https://github.com/login/device", "Otra-Cuenta");
  assert.equal(accountOf(wrong)?.hidden, false);
  assert.equal(accountOf(wrong)?.className, "account is-wrong");
  assert.match(textOf(wrong, "adaceenDeviceCodeAccount"), /Estas en GitHub como «otra-cuenta», pero tu editor es de «alumno»\. Cambia de cuenta/);
  // Con la correcta, la confirmacion.
  const right = await openGithub("https://github.com/login/device", "Alumno");
  assert.equal(accountOf(right)?.className, "account is-ok");
  assert.match(textOf(right, "adaceenDeviceCodeAccount"), /Cuenta correcta: estas en GitHub como «alumno»/);
  assert.match(textOf(right, "adaceenDeviceCodeStatus"), /^Codigo copiado: pegalo en el primer cuadro y autoriza/);

  // Despues del codigo (autorizar) y al terminar, el texto acompana el paso.
  const authorize = await openGithub("https://github.com/login/device/confirmation", "alumno");
  assert.match(textOf(authorize, "adaceenDeviceCodeStatus"), /^Ultimo paso: autoriza a «Visual Studio Code» en GitHub/);
  const done = await openGithub("https://github.com/login/device/success", "alumno");
  assert.match(textOf(done, "adaceenDeviceCodeStatus"), /^GitHub confirmo el codigo\. En unos segundos esta pestana abre tu editor\./);
  assert.equal(accountOf(done)?.hidden, true, "ya autorizado, la cuenta no se discute");
  const failed = await openGithub("https://github.com/login/device/failure", "alumno");
  assert.match(textOf(failed, "adaceenDeviceCodeStatus"), /^GitHub no autorizo el codigo\. Vuelve a la pestana de ADACEEN y pulsa "Preparar mi editor"/);

  // Otras paginas de GitHub (el OAuth de ADACEEN, ajustes) no muestran el codigo.
  for (const url of ["https://github.com/login/oauth/authorize?client_id=x", "https://github.com/settings/profile"]) {
    const other = await openTab(browser, url, "GitHub");
    await advance(browser, 1_000);
    assert.equal(helperOf(other), null, url);
  }
  assertKnownShadowIds(signin, wrong, right, authorize, done, failed);
});

test("0.8.0 (paso 4): en vscode.dev el editor dice que pulsar y con que cuenta de GitHub entrar, hasta «Ya entré»", async () => {
  const browser = new FakeBrowser();
  browser.githubConnected = true;
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 50);
  await drive(browser, tab.run("refreshWorkspaceProvider(true)"));
  // Codigo de dispositivo y luego listo: el editor abre por primera vez en este navegador.
  browser.prepareSteps = [browser.deviceCode()];
  browser.statusSteps = [browser.deviceCode(), browser.ready()];
  await drive(browser, tab.run("prepareTunnelWorkspace()"), 2000);
  await browser.clock.until(() => tab.popups[0]?.currentHref === TUNNEL_URL, 400);
  const hint = browser.storage.adaceenTunnelSignInHint as Json;
  assert.equal(hint?.tunnelName, "ws-alumno");
  assert.equal(hint?.githubLogin, "alumno", "la cuenta del tunel (workspace.login)");
  assert.ok(((browser.storage.adaceenEditorByUser as Json)?.[EDITOR_KEY] as Json)?.openedAt, "el navegador ya abrio ese tunel");

  // La pestana del editor (vscode.dev) muestra el paso 4 (0.8.0): que pulsar y con que cuenta.
  const hintOf = (t: TabEnv) => t.document.getElementById("adaceen-tunnel-signin-hint");
  // 0.8.4: cada paso es un boton con titulo corto y detalle (se ve el del paso elegido, con su dibujo).
  const itemsOf = (t: TabEnv) => (hintOf(t)?.shadow?.getElementById("adaceenTunnelSignInSteps")?.children || [])
    .map((item) => String(item.children[0]?.children[1]?.children[1]?.textContent ?? item.textContent));
  const editor = await openTab(browser, TUNNEL_URL, "taller-1 - Visual Studio Code");
  await browser.clock.until(() => !!hintOf(editor), 50);
  assert.match(String(hintOf(editor)?.shadow?.innerHTML), /Paso 4 de 4 · Entrar a VS Code/);
  assert.match(String(hintOf(editor)?.shadow?.getElementById("adaceenTunnelSignInText")?.textContent), /Último paso, solo la primera vez/);
  assert.match(itemsOf(editor)[0], /pulsa «Allow» \(Permitir\)\. Si te deja elegir, elige «GitHub», nunca Microsoft/);
  assert.match(itemsOf(editor)[1], /si pregunta con qué cuenta entrar, elige la cuenta «alumno» \(la misma que autorizó el código\); después autoriza «Visual Studio Code»/);
  // 0.8.3 (piloto del 20/10/2026): «Allow» puede salir dos veces, «Microsoft» en la página de
  // GitHub es normal y hay que confiar en la carpeta (sin eso ADACEEN queda limitado).
  assert.match(itemsOf(editor)[0], /Puede preguntarlo dos veces: pulsa «Allow» las dos\./);
  assert.match(itemsOf(editor)[1], /Que diga «Microsoft» es normal/);
  assert.match(itemsOf(editor)[2], /pulsa «Sí, confío en los autores» \(Yes, I trust the authors\)/);
  assert.match(itemsOf(editor)[3], /pulsa «Ya entré»\.$/);
  // Sigue mientras no entre: al recargar vuelve a salir; «Ya entré» lo quita para siempre.
  assert.ok(browser.storage.adaceenTunnelSignInHint, "no se gasta al mostrarse");
  const reload = await openTab(browser, TUNNEL_URL, "taller-1 - Visual Studio Code");
  await browser.clock.until(() => !!hintOf(reload), 50);
  await hintOf(reload)!.shadow!.getElementById("adaceenTunnelSignInDone").click();
  await browser.clock.settle();
  assert.equal(browser.storage.adaceenTunnelSignInHint, undefined, "«Ya entré» lo borra");
  const again = await openTab(browser, TUNNEL_URL, "taller-1 - Visual Studio Code");
  await advance(browser, 1_000);
  assert.equal(hintOf(again), null);

  // Volver a abrirlo desde este navegador (sin codigo) no lo repite: vscode.dev ya conoce la cuenta.
  browser.statusSteps = [browser.ready()];
  await drive(browser, tab.run(`openMyTunnelEditor({ repoFullName: "${REPO}" })`), 2000);
  assert.equal(browser.storage.adaceenTunnelSignInHint, undefined);

  // Otro usuario de ADACEEN en el mismo equipo no ve el aviso de otro.
  browser.storage.adaceenTunnelSignInHint = { userId: "u-otro", tunnelName: "ws-alumno", githubLogin: "otro", expiresAt: browser.clock.now + 60_000 };
  const foreign = await openTab(browser, TUNNEL_URL, "taller-1 - Visual Studio Code");
  await advance(browser, 1_000);
  assert.equal(hintOf(foreign), null);
  assertKnownShadowIds(tab, editor, reload, again, foreign);
});

// ---- 0.8.4: dibujos, anillo sobre el boton real y comprobacion de la extension de VS Code ----
async function openEditorWithSignInHint(setup: (browser: FakeBrowser) => void = () => {}) {
  const browser = new FakeBrowser();
  browser.githubConnected = true;
  seedLoggedInBrowser(browser);
  browser.storage.adaceenTunnelSignInHint = { userId: SESSION.user.id, tunnelName: "ws-alumno", githubLogin: "alumno", expiresAt: browser.clock.now + 10 * 60_000 };
  setup(browser);
  const editor = await openTab(browser, TUNNEL_URL, "taller-1 - Visual Studio Code");
  await browser.clock.until(() => !!signInHintOf(editor), 50);
  return { browser, editor, shadow: signInHintOf(editor)!.shadow! };
}

// Un elemento de la pagina de vscode.dev (conectado al documento, con su texto y sus hijos).
function pageNode(tab: TabEnv, text: string, options: { children?: FakeElement[]; rect?: Json; selectors?: Record<string, FakeElement[]> } = {}) {
  const node = tab.document.createElement("div");
  node.textContent = text;
  tab.document.body.appendChild(node);
  for (const child of options.children || []) node.appendChild(child);
  if (options.rect) node.getBoundingClientRect = () => options.rect as any;
  node.querySelectorAll = ((selector: string) => {
    for (const [key, list] of Object.entries(options.selectors || {})) if (selector.includes(key)) return list;
    return [];
  }) as any;
  return node;
}

function pageButton(tab: TabEnv, text: string, rect?: Json) {
  const button = tab.document.createElement("a");
  button.textContent = text;
  if (rect) button.getBoundingClientRect = () => rect as any;
  return button;
}

// Lo que devuelve document.querySelectorAll de vscode.dev para cada selector.
function showOnPage(tab: TabEnv, nodes: Record<string, FakeElement[]>) {
  tab.document.querySelectorAll = ((selector: string) => {
    for (const [key, list] of Object.entries(nodes)) if (selector.includes(key)) return list;
    return [];
  }) as any;
}

const stepButtonsOf = (shadow: FakeShadowRoot) => shadow.getElementById("adaceenTunnelSignInSteps").children.map((li) => li.children[0]);
const nowTagOf = (shadow: FakeShadowRoot, index: number) => stepButtonsOf(shadow)[index].children[1].children[0].children[0];

test("0.8.4 (paso 4): cada paso trae su dibujo, se amplía con un clic y el aviso va abajo a la izquierda y se pliega", async () => {
  const { editor, shadow } = await openEditorWithSignInHint();
  assert.match(shadow.innerHTML, /class="box at-editor"/, "abajo a la izquierda en vscode.dev");
  const figure = shadow.getElementById("adaceenGuideFigure");
  assert.equal(figure.getAttribute("data-figure"), "vscode-allow", "empieza con el paso 1");
  assert.equal(figure.hidden, false);
  assert.match(String(shadow.getElementById("adaceenGuideFigureOpen").innerHTML), /<svg class="guide-art" viewBox="0 0 320 200"[^>]*aria-hidden="true"/);
  assert.match(String(shadow.getElementById("adaceenGuideFigureCaption").textContent), /Pulsa «Allow»/);
  // Elegir otro paso muestra su dibujo.
  const steps = stepButtonsOf(shadow);
  assert.equal(steps.length, 4);
  await steps[2].click();
  assert.equal(figure.getAttribute("data-figure"), "vscode-trust");
  assert.deepEqual(steps.map((step) => step.getAttribute("aria-current")), ["false", "false", "true", "false"]);
  await steps[1].click();
  assert.equal(figure.getAttribute("data-figure"), "github-authorize");
  // Un clic en el dibujo lo amplía, con su título para el lector de pantalla; «Cerrar», el fondo y Escape lo cierran.
  const lightbox = shadow.getElementById("adaceenGuideLightbox");
  assert.equal(lightbox.hidden, true);
  await shadow.getElementById("adaceenGuideFigureOpen").click();
  assert.equal(lightbox.hidden, false);
  assert.match(String(shadow.getElementById("adaceenGuideLightboxArt").innerHTML), /role="img"[\s\S]*<title>GitHub pide autorizar «Visual Studio Code»<\/title>/);
  assert.equal(shadow.getElementById("adaceenGuideLightboxTitle").textContent, "GitHub pide autorizar «Visual Studio Code»");
  await shadow.getElementById("adaceenGuideLightboxClose").click();
  assert.equal(lightbox.hidden, true);
  await shadow.getElementById("adaceenGuideFigureOpen").click();
  await shadow.getElementById("adaceenGuideLightboxBackdrop").click();
  assert.equal(lightbox.hidden, true);
  await shadow.getElementById("adaceenGuideFigureOpen").click();
  await lightbox.dispatch("keydown", { key: "Escape" });
  assert.equal(lightbox.hidden, true);
  // Plegar a mano deja la pastilla; un clic la vuelve a abrir.
  await shadow.getElementById("adaceenTunnelSignInMinimize").click();
  assert.equal(shadow.getElementById("adaceenTunnelSignInBox").hidden, true);
  assert.equal(shadow.getElementById("adaceenTunnelSignInPill").hidden, false);
  await shadow.getElementById("adaceenTunnelSignInPill").click();
  assert.equal(shadow.getElementById("adaceenTunnelSignInBox").hidden, false);
  // Sin la ruta en el backend (anterior a la 0.8.4) la comprobación no aparece.
  assert.equal(shadow.getElementById("adaceenTunnelSignInCheck").hidden, true);
  assertKnownShadowIds(editor);
});

test("0.8.4 (paso 4): en una ventana muy baja el aviso empieza plegado y la pastilla sigue diciendo qué pulsar", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  browser.storage.adaceenTunnelSignInHint = { userId: SESSION.user.id, tunnelName: "ws-alumno", githubLogin: "alumno", expiresAt: browser.clock.now + 10 * 60_000 };
  const editor = new TabEnv(browser, TUNNEL_URL, "taller-1 - Visual Studio Code");
  editor.window.innerHeight = 500;
  editor.context.innerHeight = 500;
  editor.load();
  await browser.clock.until(() => !!signInHintOf(editor), 50);
  const shadow = signInHintOf(editor)!.shadow!;
  assert.equal(shadow.getElementById("adaceenTunnelSignInBox").hidden, true, "1366x768 al 150 %: no cabe desplegado");
  assert.equal(shadow.getElementById("adaceenTunnelSignInPill").hidden, false);
  const allow = pageButton(editor, "Allow", { left: 600, top: 300, right: 660, bottom: 324, width: 60, height: 24 });
  const dialog = pageNode(editor, "The extension 'Remote - Tunnels' wants to sign in using GitHub.", { children: [allow], selectors: { button: [allow] } });
  showOnPage(editor, { "monaco-dialog-box": [dialog] });
  await advance(browser, 1_000);
  assert.equal(shadow.getElementById("adaceenTunnelSignInPillAction").textContent, "Pulsa «Allow»");
  assert.equal(shadow.getElementById("adaceenTunnelSignInBox").hidden, true, "plegado a mano o por la ventana: sigue plegado");
  assertKnownShadowIds(editor);
});

test("0.8.4 (paso 4): reconoce los diálogos de VS Code, marca «Ahora», pone el anillo en el botón real y no los tapa", async () => {
  const { browser, editor, shadow } = await openEditorWithSignInHint();
  const ring = shadow.getElementById("adaceenGuidePointer");
  const ringLabel = shadow.getElementById("adaceenGuidePointerLabel");
  const box = shadow.getElementById("adaceenTunnelSignInBox");
  const pill = shadow.getElementById("adaceenTunnelSignInPill");
  assert.equal(ring.hidden, true);

  // «Permitir» en un VS Code en español, lejos del aviso: no se pliega.
  const far = { left: 700, top: 200, right: 1000, bottom: 330, width: 300, height: 130 };
  const allowRect = { left: 900, top: 300, right: 980, bottom: 324, width: 80, height: 24 };
  const cancel = pageButton(editor, "Cancelar", far);
  const allow = pageButton(editor, "Permitir", allowRect);
  const dialog = pageNode(editor, "La extensión «Remote - Tunnels» quiere iniciar sesión con GitHub.", { children: [cancel, allow], rect: far, selectors: { button: [cancel, allow] } });
  showOnPage(editor, { "monaco-dialog-box": [dialog] });
  await advance(browser, 1_000);
  assert.equal(nowTagOf(shadow, 0).hidden, false, "«Ahora» en el paso 1");
  assert.equal(nowTagOf(shadow, 2).hidden, true);
  assert.equal(ring.hidden, false, "anillo en el botón real");
  assert.deepEqual([ring.style.left, ring.style.top, ring.style.width, ring.style.height], ["894px", "294px", "92px", "36px"]);
  assert.equal(ringLabel.textContent, "Pulsa «Permitir»");
  assert.equal(shadow.getElementById("adaceenTunnelSignInPillAction").textContent, "Pulsa «Permitir»");
  assert.equal(box.hidden, false, "el diálogo no queda debajo del aviso");

  // Elegir cuenta (lista de VS Code): el paso 1 con su propio dibujo y el anillo en GitHub.
  const githubRow = pageNode(editor, "GitHub", { rect: { left: 500, top: 60, right: 800, bottom: 82, width: 300, height: 22 } });
  const microsoftRow = pageNode(editor, "Microsoft", { rect: { left: 500, top: 84, right: 800, bottom: 106, width: 300, height: 22 } });
  const picker = pageNode(editor, "Select an account", { rect: { left: 480, top: 40, right: 820, bottom: 120, width: 340, height: 80 }, selectors: { "monaco-list-row": [githubRow, microsoftRow] } });
  showOnPage(editor, { "quick-input-widget": [picker] });
  await advance(browser, 1_000);
  assert.equal(shadow.getElementById("adaceenGuideFigure").getAttribute("data-figure"), "vscode-account");
  assert.equal(ringLabel.textContent, "Elige «GitHub»");

  // Confiar en los autores, justo encima del aviso (todo mide 320x480 en la simulación): se pliega
  // solo y la pastilla dice qué pulsar; al cerrarse el diálogo se vuelve a abrir.
  const yes = pageButton(editor, "Sí, confío en los autores Confiar en la carpeta y habilitar todas las características");
  const no = pageButton(editor, "No, no confío en los autores");
  const trust = pageNode(editor, "¿Confía en los autores de los archivos de esta carpeta?", { children: [yes, no], selectors: { button: [yes, no] } });
  showOnPage(editor, { "monaco-dialog-box": [trust] });
  await advance(browser, 1_000);
  assert.equal(nowTagOf(shadow, 2).hidden, false, "«Ahora» en el paso 3");
  assert.equal(ringLabel.textContent, "Pulsa «Sí, confío en los autores»");
  assert.equal(box.hidden, true, "se pliega para no tapar el diálogo");
  assert.equal(pill.hidden, false);
  assert.equal(shadow.getElementById("adaceenTunnelSignInPillAction").textContent, "Pulsa «Sí, confío en los autores»");
  showOnPage(editor, {});
  await advance(browser, 1_000);
  assert.equal(box.hidden, false, "se había plegado solo: se vuelve a abrir");
  assert.equal(ring.hidden, true, "sin diálogo no hay anillo");

  // Abierto a mano con el diálogo encima: no se vuelve a plegar por ese mismo diálogo.
  showOnPage(editor, { "monaco-dialog-box": [trust] });
  await advance(browser, 1_000);
  assert.equal(box.hidden, true);
  await pill.click();
  await advance(browser, 2_000);
  assert.equal(box.hidden, false, "el estudiante lo abrió: se respeta");

  // Un diálogo que no es de la primera entrada no se marca.
  const other = pageNode(editor, "¿Desea guardar los cambios?", { children: [pageButton(editor, "Guardar")], selectors: { button: [] } });
  showOnPage(editor, { "monaco-dialog-box": [other] });
  await advance(browser, 1_000);
  assert.equal(ring.hidden, true);
  assert.deepEqual([0, 1, 2, 3].map((index) => nowTagOf(shadow, index).hidden), [true, true, true, true]);
  assertKnownShadowIds(editor);
});

test("0.8.4 (paso 4): al ver los archivos comprueba que la extensión de VS Code esté en el editor y al día", async () => {
  const { browser, editor, shadow } = await openEditorWithSignInHint((b) => {
    b.vscodePresence = { status: "not_seen", latestVersion: "0.0.37", version: null, editorHost: "tunnel", lastSeenAt: null, online: false };
  });
  const check = shadow.getElementById("adaceenTunnelSignInCheck");
  const title = () => String(shadow.getElementById("adaceenTunnelSignInCheckTitle").textContent);
  const detail = () => String(shadow.getElementById("adaceenTunnelSignInCheckDetail").textContent);
  await advance(browser, 1_000);
  assert.equal(check.hidden, false);
  assert.match(title(), /Cuando veas tus archivos, aquí se comprueba/);
  const presenceRequests = browser.requestsTo("/api/vscode/presence");
  assert.ok(presenceRequests.length >= 1);
  assert.equal(presenceRequests[0].query, "?editorHost=tunnel", "pregunta por el editor del túnel");

  // Se ven los archivos: «buscando» y, sin noticias en un minuto, qué hacer.
  const row = pageNode(editor, "main.cpp");
  editor.document.selectors.set(".explorer-folders-view .monaco-list-row", row);
  await advance(browser, 1_000);
  assert.equal(nowTagOf(shadow, 3).hidden, false, "«Ahora» en el paso 4");
  assert.match(title(), /Buscando ADACEEN en tu editor/);
  await advance(browser, 61_000);
  assert.match(title(), /Todavía no vemos ADACEEN en tu editor/);
  assert.match(detail(), /pulsa F1, escribe «Recargar ventana» \(Reload Window\)/);
  assert.match(check.className, /is-warn/);

  // La barra de estado dice «sin conectar»: qué pulsar.
  const statusItem = pageNode(editor, "ADACEEN: sin conectar");
  showOnPage(editor, { "statusbar-item": [statusItem] });
  await advance(browser, 5_000);
  assert.match(title(), /ADACEEN está en tu editor, pero sin conectar a tu cuenta/);

  // VS Code 0.0.37 se reporta: al día, «Listo» y el aviso ya no vuelve.
  browser.vscodePresence = { status: "up_to_date", latestVersion: "0.0.37", version: "0.0.37", editorHost: "tunnel", lastSeenAt: new Date(browser.clock.now).toISOString(), online: true };
  await advance(browser, 5_000);
  assert.equal(title(), "ADACEEN 0.0.37 está en tu editor: es la última versión.");
  assert.match(check.className, /is-ok/);
  assert.equal(shadow.getElementById("adaceenTunnelSignInDone").textContent, "Listo");
  assert.equal(browser.storage.adaceenTunnelSignInHint, undefined, "entró y está al día: no vuelve");
  const pollsAtOk = browser.requestsTo("/api/vscode/presence").length;
  await advance(browser, 30_000);
  assert.equal(browser.requestsTo("/api/vscode/presence").length, pollsAtOk, "con la respuesta definitiva deja de preguntar");
  // La telemetría guarda cada resultado nuevo (sin datos del estudiante).
  await advance(browser, 10_000);
  const checks = browser.requests.flatMap((request) => (request.body as Json)?.events as Json[] || [])
    .filter((event) => event.eventType === "tunnel_vscode_extension_checked");
  assert.deepEqual(checks.map((event) => event.value), ["missing", "unconnected", "ok"]);
  assert.deepEqual((checks[2].metadata as Json), { vscodeExtensionVersion: "0.0.37", latestVscodeExtensionVersion: "0.0.37", resultIndex: 3 });
  assertKnownShadowIds(editor);
});

test("0.8.4 (paso 4): sin la versión publicada no dice «la última» y una respuesta rara no borra lo que se sabía", async () => {
  const { browser, editor, shadow } = await openEditorWithSignInHint((b) => {
    b.vscodePresence = { status: "latest_version_unknown", latestVersion: null, version: "0.0.37", editorHost: "tunnel", lastSeenAt: "2026-10-25T20:00:00.000Z", online: true };
  });
  const title = () => String(shadow.getElementById("adaceenTunnelSignInCheckTitle").textContent);
  await advance(browser, 1_000);
  assert.equal(title(), "ADACEEN 0.0.37 está en tu editor.");
  assert.match(String(shadow.getElementById("adaceenTunnelSignInCheckDetail").textContent), /No se pudo comparar con la versión publicada/);
  assert.equal(shadow.getElementById("adaceenTunnelSignInDone").textContent, "Ya entré");
  assert.ok(browser.storage.adaceenTunnelSignInHint, "sin comparar no se da por terminado");
  // Un estado que no se conoce (un backend más nuevo): se conserva lo último y se sigue preguntando.
  browser.vscodePresence = { status: "algo_nuevo", latestVersion: "0.0.38", version: "0.0.38", editorHost: "tunnel", lastSeenAt: null, online: true };
  const polls = browser.requestsTo("/api/vscode/presence").length;
  await advance(browser, 10_000);
  assert.ok(browser.requestsTo("/api/vscode/presence").length > polls);
  assert.equal(title(), "ADACEEN 0.0.37 está en tu editor.");
  assertKnownShadowIds(editor);
});

test("0.8.4 (paso 4): con una versión anterior lo dice y, al docente, cómo ponerla al día", async () => {
  const outdated = { status: "outdated", latestVersion: "0.0.37", version: "0.0.35", editorHost: "tunnel", lastSeenAt: "2026-10-25T20:00:00.000Z", online: true };
  const student = await openEditorWithSignInHint((b) => { b.vscodePresence = outdated; });
  await advance(student.browser, 1_000);
  const studentTitle = String(student.shadow.getElementById("adaceenTunnelSignInCheckTitle").textContent);
  assert.equal(studentTitle, "Tu editor tiene ADACEEN 0.0.35; la última es 0.0.37.");
  assert.match(String(student.shadow.getElementById("adaceenTunnelSignInCheckDetail").textContent), /llega sola la próxima vez que se encienda tu editor/);
  assert.equal(student.shadow.getElementById("adaceenTunnelSignInCheckCommand").hidden, true, "el estudiante no ve comandos");
  assert.ok(student.browser.storage.adaceenTunnelSignInHint, "no está al día: el aviso sigue");

  const teacher = await openEditorWithSignInHint((b) => {
    b.session = { ...SESSION, user: { ...SESSION.user, role: "teacher", assignedCourseCodes: [] } };
    seedLoggedInBrowser(b);
    b.storage.adaceenTunnelSignInHint = { userId: SESSION.user.id, tunnelName: "ws-alumno", githubLogin: "alumno", expiresAt: b.clock.now + 10 * 60_000 };
    // VS Code 0.0.36 o anterior (sin version): el backend ya la da por anterior.
    b.vscodePresence = { ...outdated, version: null };
  });
  await advance(teacher.browser, 1_000);
  assert.equal(String(teacher.shadow.getElementById("adaceenTunnelSignInCheckTitle").textContent), "Tu editor tiene una versión anterior de ADACEEN; la última es 0.0.37.");
  assert.match(String(teacher.shadow.getElementById("adaceenTunnelSignInCheckStaff").textContent), /vuelve a correr el arranque de la VM de editores/);
  const command = teacher.shadow.getElementById("adaceenTunnelSignInCheckCommand");
  assert.equal(command.hidden, false);
  assert.match(String(command.textContent), /google_metadata_script_runner startup/);
  assert.equal(String(command.textContent), STAFF_VM_COMMAND, "el comando lo manda el backend (el navegador no lo trae escrito)");
  await teacher.shadow.getElementById("adaceenTunnelSignInCheckCopy").click();
  assert.match(String(teacher.browser.clipboard.at(-1)), /gcloud compute ssh aula-ws/);
  assertKnownShadowIds(student.editor, teacher.editor);
});
