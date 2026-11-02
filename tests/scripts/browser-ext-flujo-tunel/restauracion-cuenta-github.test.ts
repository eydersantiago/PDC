import assert from "node:assert/strict";
import test from "node:test";
import { REPO, TUNNEL_URL, SESSION, type Json } from "./harness-config.js";
import { TabEnv } from "./harness-tab.js";
import { FakeBrowser } from "./harness-backend.js";
import { advance, assertKnownShadowIds, seedLoggedInBrowser } from "./harness-utils.js";
import { openGithubAs, seedTunnelEditor } from "./harness-helpers.js";

// ---- 0.8.1: punto de restauracion (el tunel quedo a nombre de otra cuenta de GitHub) ----

type FakeDeviceField = Json & { value: string; events: string[] };
function fakeDeviceField(attrs: Json = {}): FakeDeviceField {
  return {
    type: "text", name: "", id: "", className: "", value: "", disabled: false, readOnly: false, maxLength: -1, events: [],
    getAttribute(name: string) { return name in attrs ? String(attrs[name]) : null; },
    dispatchEvent(event: { type: string }) { (this as FakeDeviceField).events.push(event.type); return true; },
    ...attrs,
  };
}
test("0.8.1: con otra cuenta abierta en GitHub el codigo no se escribe solo y «Cambiar de cuenta» acompana hasta volver con la correcta", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  browser.storage.adaceenDeviceCodeHandoff = {
    userCode: "WDJB-MJHT",
    userId: SESSION.user.id,
    repoFullName: REPO,
    githubLogin: "alumno",
    expiresAt: browser.clock.now + 10 * 60_000,
    savedAt: browser.clock.now,
    aliveAt: browser.clock.now,
  };
  const helperOf = (tab: TabEnv) => tab.document.getElementById("adaceen-device-code-helper");
  const switchOf = (tab: TabEnv) => tab.document.getElementById("adaceen-github-switch-account");
  const deviceForm = (field: FakeDeviceField) => ({
    getAttribute(name: string) { return name === "action" ? "/login/device" : null; },
    querySelectorAll(selector: string) { return selector === "input" ? [field] : []; },
    submit() {},
    requestSubmit() {},
  });

  // Otra cuenta: aviso, sin escribir el codigo (Continue dejaria el editor a nombre de esa cuenta).
  const wrongField = fakeDeviceField({ name: "user_code", id: "user-code", maxLength: 9 });
  const wrong = await openGithubAs(browser, "https://github.com/login/device", "Otra-Cuenta", [deviceForm(wrongField)]);
  await browser.clock.until(() => !!helperOf(wrong), 50);
  await advance(browser, 3_000);
  const shadow = helperOf(wrong)!.shadow!;
  assert.equal(wrongField.value, "", "con otra cuenta el codigo no se escribe solo");
  assert.equal(shadow.getElementById("adaceenDeviceCodeSwitch").hidden, false);
  assert.match(String(shadow.getElementById("adaceenDeviceCodeStatus").textContent), /^No pegues el codigo con «otra-cuenta»\. Pulsa «Cambiar de cuenta», entra con «alumno»/);
  await shadow.getElementById("adaceenDeviceCodeSwitch").click();
  await browser.clock.settle();
  assert.equal(wrong.window.location.href, "https://github.com/logout");
  assert.equal((browser.storage.adaceenDeviceCodeHandoff as Json).switching, true);

  // En github.com/logout y en la portada, que sigue.
  const logout = await openGithubAs(browser, "https://github.com/logout", "otra-cuenta");
  await browser.clock.until(() => !!switchOf(logout), 50);
  assert.match(String(switchOf(logout)!.shadow!.getElementById("adaceenSwitchText").textContent), /Pulsa «Sign out» en esta pagina para salir de «otra-cuenta»\. Despues entra con «alumno»/);
  assert.match(String(switchOf(logout)!.shadow!.innerHTML), /Paso 3 de 4 · Autorizar tu editor/);
  const out = await openGithubAs(browser, "https://github.com/", "");
  await browser.clock.until(() => !!switchOf(out), 50);
  const signInButton = switchOf(out)!.shadow!.getElementById("adaceenSwitchAction");
  assert.equal(signInButton.textContent, "Entrar con «alumno»");
  await signInButton.click();
  assert.equal(out.window.location.href, "https://github.com/login?return_to=%2Flogin%2Fdevice", "al entrar, GitHub vuelve al codigo");
  // Ya con la correcta: vuelve sola al codigo.
  const back = await openGithubAs(browser, "https://github.com/", "alumno");
  await browser.clock.until(() => !!switchOf(back), 50);
  assert.match(String(switchOf(back)!.shadow!.getElementById("adaceenSwitchText").textContent), /^Listo: ahora estas en GitHub como «alumno»/);
  await advance(browser, 3_000);
  assert.equal(back.window.location.href, "https://github.com/login/device");

  // En el codigo con la cuenta correcta: se escribe solo y el cambio de cuenta termina.
  const rightField = fakeDeviceField({ name: "user_code", id: "user-code", maxLength: 9 });
  const right = await openGithubAs(browser, "https://github.com/login/device", "alumno", [deviceForm(rightField)]);
  await browser.clock.until(() => !!helperOf(right), 50);
  await advance(browser, 3_000);
  assert.equal(rightField.value, "WDJB-MJHT");
  assert.equal(helperOf(right)!.shadow!.getElementById("adaceenDeviceCodeSwitch").hidden, true);
  assert.equal((browser.storage.adaceenDeviceCodeHandoff as Json).switching, false);
  // Fuera del cambio de cuenta, la portada de GitHub no muestra nada.
  const home = await openGithubAs(browser, "https://github.com/", "alumno");
  await advance(browser, 1_000);
  assert.equal(switchOf(home), null);

  // Quien autoriza queda anotado para el aviso de vscode.dev.
  await openGithubAs(browser, "https://github.com/login/device/success", "alumno");
  await advance(browser, 500);
  assert.equal((browser.storage.adaceenTunnelDeviceAccount as Json)?.account, "alumno");
  assert.equal((browser.storage.adaceenTunnelDeviceAccount as Json)?.expected, "alumno");
  assertKnownShadowIds(wrong, logout, out, back, right, home);
});
async function openTunnelNotFound(browser: FakeBrowser, url = TUNNEL_URL) {
  const tab = new TabEnv(browser, url, "Visual Studio Code");
  const dialogs: unknown[] = [];
  tab.document.querySelectorAll = ((selector: string) => (selector.includes("monaco-dialog-box") ? dialogs : [])) as any;
  tab.load();
  await browser.clock.settle();
  return {
    tab,
    // vscode.dev tarda unos segundos en decirlo.
    showDialog(text: string) {
      dialogs.push({ innerText: text, textContent: text });
    },
  };
}

test("0.8.1: vscode.dev no encuentra el tunel -> «Reconectar con mi cuenta» cierra la otra sesion y abre el editor con la correcta", async () => {
  const browser = new FakeBrowser();
  browser.githubConnected = true;
  seedLoggedInBrowser(browser);
  seedTunnelEditor(browser);
  // El codigo lo autorizo otra cuenta (la que estaba abierta en el navegador).
  browser.storage.adaceenTunnelDeviceAccount = { userId: SESSION.user.id, expected: "alumno", account: "otra-cuenta", at: browser.clock.now, expiresAt: browser.clock.now + 86_400_000 };
  const bannerOf = (tab: TabEnv) => tab.document.getElementById("adaceen-tunnel-not-found");

  const { tab, showDialog } = await openTunnelNotFound(browser);
  await advance(browser, 3_000);
  assert.equal(bannerOf(tab), null, "sin el dialogo de vscode.dev no hay aviso");
  showDialog("No se pudo encontrar el túnel con el nombre ws-alumno. Es posible que no tenga acceso.");
  await browser.clock.until(() => !!bannerOf(tab), 50);
  const shadow = bannerOf(tab)!.shadow!;
  assert.match(String(shadow.getElementById("adaceenNotFoundText").textContent), /El código del paso 3 lo autorizó «otra-cuenta», pero tu editor es de «alumno»/);
  const steps = (shadow.getElementById("adaceenNotFoundSteps").children || []).map((item) => String(item.textContent));
  assert.match(steps[0], /^Pulsa «Reconectar con mi cuenta»\. ADACEEN apaga tu editor un momento y te da un código nuevo para autorizarlo con «alumno»\. Tus archivos no se tocan\./);
  assert.match(steps[1], /^¿Tu cuenta de GitHub no es «alumno»\? Pulsa «Usar otra cuenta de GitHub»: eliges la tuya en GitHub/);
  assert.equal(shadow.getElementById("adaceenNotFoundGithubAccount").textContent, "Usar otra cuenta de GitHub");
  const button = shadow.getElementById("adaceenNotFoundReconnect");
  assert.equal(button.textContent, "Reconectar con mi cuenta");

  browser.prepareSteps = [browser.deviceCode("NUEV-0001")];
  browser.statusSteps = [browser.deviceCode("NUEV-0001"), browser.ready()];
  await button.click();
  assert.equal(tab.popups.length, 1, "la ventana de espera se abre en el mismo clic");
  assert.match(String(shadow.getElementById("adaceenNotFoundStatus").textContent), /^Reconectando: sigue en la pestaña nueva/);
  await browser.clock.until(() => tab.popups[0]?.currentHref === TUNNEL_URL, 600);
  const prepare = browser.requestsTo("/api/workspaces/prepare", "POST");
  assert.equal(prepare.length, 1);
  assert.deepEqual(prepare[0].body, { repoFullName: REPO, force: false, reconnect: true });
  assert.ok(tab.popups[0].hrefs.includes("https://github.com/login/device"), "paso 3 con el codigo nuevo");
  assert.equal((browser.storage.adaceenDeviceCodeHandoff as Json | undefined), undefined, "editor listo: el codigo ya no se ofrece");
  assert.equal(browser.storage.adaceenTunnelDeviceAccount, undefined, "la cuenta del codigo anterior se olvida");
  assert.equal((browser.storage.adaceenTunnelSignInHint as Json)?.githubLogin, "alumno", "paso 4 con la cuenta correcta");
  await browser.clock.until(() => /^Listo: tu editor abrió en la otra pestaña/.test(String(shadow.getElementById("adaceenNotFoundStatus").textContent)), 50);
  assertKnownShadowIds(tab);
});

test("0.8.1: el aviso de vscode.dev distingue la entrada con otra cuenta, no aparece en el editor de otro y dice si la VM no sabe reconectar", async () => {
  const browser = new FakeBrowser();
  browser.githubConnected = true;
  seedLoggedInBrowser(browser);
  seedTunnelEditor(browser);
  const bannerOf = (tab: TabEnv) => tab.document.getElementById("adaceen-tunnel-not-found");
  const textOf = (tab: TabEnv) => String(bannerOf(tab)?.shadow?.getElementById("adaceenNotFoundText")?.textContent || "");

  // El codigo se autorizo bien: entro a vscode.dev con otra cuenta (en ingles).
  browser.storage.adaceenTunnelDeviceAccount = { userId: SESSION.user.id, expected: "alumno", account: "alumno", at: browser.clock.now, expiresAt: browser.clock.now + 86_400_000 };
  const vscode = await openTunnelNotFound(browser);
  vscode.showDialog("Could not find the tunnel named 'ws-alumno'. You may not have access to it.");
  await browser.clock.until(() => !!bannerOf(vscode.tab), 50);
  assert.match(textOf(vscode.tab), /el código se autorizó bien, pero VS Code entró con otra cuenta de GitHub guardada en este navegador\. «Elegir otra cuenta» de vscode\.dev no sirve/);

  // Sin saber quien autorizo: las dos causas.
  delete browser.storage.adaceenTunnelDeviceAccount;
  const unknown = await openTunnelNotFound(browser);
  unknown.showDialog("No se pudo encontrar el túnel con el nombre ws-alumno.");
  await browser.clock.until(() => !!bannerOf(unknown.tab), 50);
  assert.match(textOf(unknown.tab), /Tu editor está a nombre de «alumno» \(la cuenta de GitHub conectada a ADACEEN\)/);
  const unknownSteps = (bannerOf(unknown.tab)!.shadow!.getElementById("adaceenNotFoundSteps").children || []).map((item) => String(item.textContent));
  assert.equal(unknownSteps.length, 3, "las tres salidas: reconectar, otra cuenta de GitHub, entrar a vscode.dev con otra");
  assert.match(unknownSteps[0], /^Lo más común: VS Code entró con otra cuenta guardada en este navegador .*Pulsa «Cambiar a alumno»/);
  assert.match(unknownSteps[1], /^Si sigue igual, pulsa «Reconectar con mi cuenta»\. ADACEEN apaga/);

  // La VM con el agente anterior: lo dice y deja volver a intentar.
  browser.prepareSteps = [{
    ok: false, provider: "tunnel", status: "error", code: "reconnect_unsupported",
    message: "Tu editor en la nube todavia no puede reconectarse solo: la VM de editores esta desactualizada. Avisa al docente.",
    workspace: { login: "alumno", tunnelName: "ws-alumno", webUrl: "", repoFullName: REPO },
  }];
  const button = bannerOf(unknown.tab)!.shadow!.getElementById("adaceenNotFoundReconnect");
  await button.click();
  const statusEl = bannerOf(unknown.tab)!.shadow!.getElementById("adaceenNotFoundStatus");
  await browser.clock.until(() => /desactualizada/.test(String(statusEl.textContent)), 200);
  assert.equal(statusEl.className, "status is-error");
  assert.equal(button.disabled, false, "se puede volver a intentar");

  // El editor de otro estudiante (enlace compartido): no es de esta sesion, no hay aviso.
  const foreign = await openTunnelNotFound(browser, "https://vscode.dev/tunnel/ad-otro/home/ws-otro/taller-1");
  foreign.showDialog("No se pudo encontrar el túnel con el nombre ad-otro.");
  await advance(browser, 5_000);
  assert.equal(bannerOf(foreign.tab), null);
  // Un dialogo cualquiera de vscode.dev tampoco.
  const other = await openTunnelNotFound(browser);
  other.showDialog("¿Desea instalar la extensión recomendada?");
  await advance(browser, 5_000);
  assert.equal(bannerOf(other.tab), null);
  assertKnownShadowIds(vscode.tab, unknown.tab, foreign.tab, other.tab);
});

test("0.8.1 (paso 4): autorizar «Visual Studio Code» con otra cuenta abierta en GitHub lo advierte", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  browser.storage.adaceenTunnelSignInHint = { userId: SESSION.user.id, tunnelName: "ws-alumno", githubLogin: "alumno", expiresAt: browser.clock.now + 5 * 60_000 };
  const vscodeAuthorize = "https://github.com/login/oauth/authorize?client_id=01ab8ac9400c4e429b23&redirect_uri=https%3A%2F%2Fvscode.dev%2Fredirect&scope=read%3Auser&state=x";
  const bannerOf = (tab: TabEnv) => tab.document.getElementById("adaceen-tunnel-signin-github");
  const warnOf = (tab: TabEnv) => bannerOf(tab)?.shadow?.getElementById("adaceenTunnelSignInWarn");
  const wrong = await openGithubAs(browser, vscodeAuthorize, "otra-cuenta");
  await browser.clock.until(() => !!bannerOf(wrong), 50);
  assert.equal(warnOf(wrong)?.hidden, false);
  assert.match(String(warnOf(wrong)?.textContent), /Estás en GitHub como «otra-cuenta», pero tu editor es de «alumno»\. No autorices con esta cuenta/);
  const right = await openGithubAs(browser, vscodeAuthorize, "alumno");
  await browser.clock.until(() => !!bannerOf(right), 50);
  assert.equal(warnOf(right)?.hidden, true);
  assertKnownShadowIds(wrong, right);
});

test("0.8.1: «Usar otra cuenta de GitHub» abre el selector de cuentas y prepara el editor cuando GitHub guarda la cuenta elegida", async () => {
  const browser = new FakeBrowser();
  browser.githubConnected = true;
  seedLoggedInBrowser(browser);
  seedTunnelEditor(browser);
  const bannerOf = (tab: TabEnv) => tab.document.getElementById("adaceen-tunnel-not-found");
  const { tab, showDialog } = await openTunnelNotFound(browser);
  showDialog("No se pudo encontrar el túnel con el nombre ws-alumno.");
  await browser.clock.until(() => !!bannerOf(tab), 50);
  const shadow = bannerOf(tab)!.shadow!;
  await shadow.getElementById("adaceenNotFoundGithubAccount").click();
  assert.equal(tab.popups.length, 1, "la ventana de GitHub se abre en el mismo clic");
  await browser.clock.until(() => browser.requestsTo("/api/github/oauth/start", "POST").length > 0, 200);
  assert.deepEqual(browser.requestsTo("/api/github/oauth/start", "POST")[0].body, { repoFullName: REPO, selectAccount: true });
  await browser.clock.until(() => String(tab.popups[0].currentHref).startsWith("https://github.com/login/oauth/authorize"), 100);
  assert.match(String(shadow.getElementById("adaceenNotFoundStatus").textContent), /^Sigue en la pestaña nueva: elige tu cuenta en GitHub/);

  // Mientras GitHub no guarde el token nuevo, la cuenta de antes no cuenta como «conectada».
  await advance(browser, 15_000);
  assert.deepEqual(browser.requestsTo("/api/workspaces/prepare"), []);
  // El estudiante eligio su cuenta: el backend guarda el token y la espera prepara su editor.
  browser.githubAccountLogin = "alumno-real";
  browser.githubUpdatedAt = new Date(browser.clock.now).toISOString();
  browser.prepareSteps = [browser.ready()];
  await browser.clock.until(() => browser.requestsTo("/api/workspaces/prepare", "POST").length > 0, 800);
  const prepare = browser.requestsTo("/api/workspaces/prepare", "POST");
  assert.equal(prepare.length, 1);
  assert.equal((prepare[0].body as Json).repoFullName, REPO);
  assert.equal("reconnect" in (prepare[0].body as Json), false, "otra cuenta: un editor nuevo, no reconectar el de antes");
  await browser.clock.until(() => tab.popups[0]?.currentHref === TUNNEL_URL, 400);
  assertKnownShadowIds(tab);
});
