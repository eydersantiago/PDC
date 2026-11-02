import assert from "node:assert/strict";
import test from "node:test";
import { OVERLAY_SCRIPTS, TUNNEL_URL, SESSION, type Json } from "./harness-config.js";
import { FakeElement } from "./harness-dom.js";
import { TabEnv } from "./harness-tab.js";
import { FakeBrowser } from "./harness-backend.js";
import { openTab, advance, assertKnownShadowIds, seedLoggedInBrowser } from "./harness-utils.js";
import { type FakeAccount, FakeVscodeAccounts } from "./harness-vscode-accounts.js";
import { signInHintOf, openGithubAs, seedTunnelEditor } from "./harness-helpers.js";

// ---- 0.8.5: cambiar la cuenta de VS Code dentro del editor ----
const notFoundBannerOf = (tab: TabEnv) => tab.document.getElementById("adaceen-tunnel-not-found");
const switchPanelOf = (tab: TabEnv) => tab.document.getElementById("adaceen-editor-account-switch");

async function openEditorWithVscode(browser: FakeBrowser, accounts: FakeAccount[]) {
  const tab = new TabEnv(browser, TUNNEL_URL, "Visual Studio Code");
  const vscode = new FakeVscodeAccounts(tab, accounts);
  const reloads: number[] = [];
  tab.window.location.reload = () => { reloads.push(browser.clock.now); };
  tab.load();
  await browser.clock.settle();
  vscode.showTunnelDialog();
  await browser.clock.until(() => !!notFoundBannerOf(tab), 50);
  return { tab, vscode, reloads };
}

function seedVscodeSessionCase(browser: FakeBrowser) {
  browser.githubConnected = true;
  seedLoggedInBrowser(browser);
  seedTunnelEditor(browser);
  // El codigo lo autorizo la cuenta correcta: lo que falla es la cuenta con la que entro VS Code.
  browser.storage.adaceenTunnelDeviceAccount = { userId: SESSION.user.id, expected: "alumno", account: "alumno", at: browser.clock.now, expiresAt: browser.clock.now + 86_400_000 };
}

const accountSwitchEvents = (browser: FakeBrowser) => browser.requests.flatMap((request) => (request.body as Json)?.events as Json[] || [])
  .filter((event) => event.eventType === "tunnel_editor_account_switch");

test("0.8.5: «Cambiar a <cuenta>» cierra en VS Code la sesión de la otra cuenta (cuentas → cuenta → Cerrar sesión → confirmar) y recarga con el paso 4", async () => {
  const browser = new FakeBrowser();
  seedVscodeSessionCase(browser);
  const { tab, vscode, reloads } = await openEditorWithVscode(browser, [{ login: "eydersantiago", provider: "GitHub" }, { login: "alumno", provider: "GitHub" }]);
  const shadow = notFoundBannerOf(tab)!.shadow!;
  assert.match(String(shadow.getElementById("adaceenNotFoundText").textContent), /el código se autorizó bien, pero VS Code entró con otra cuenta de GitHub guardada en este navegador\. «Elegir otra cuenta» de vscode\.dev no sirve/);
  const change = shadow.getElementById("adaceenNotFoundVscodeAccount");
  assert.equal(change.textContent, "Cambiar a alumno");
  assert.equal(change.className, "primary", "con el código bien, cambiar la cuenta de VS Code es lo principal");
  const steps = (shadow.getElementById("adaceenNotFoundSteps").children || []).map((item) => String(item.textContent));
  assert.match(steps[0], /^Pulsa «Cambiar a alumno»\. ADACEEN cierra en VS Code la sesión de la otra cuenta \(ícono de cuentas, abajo a la izquierda → «Cerrar sesión»\), recarga la página/);

  await change.click();
  assert.equal(notFoundBannerOf(tab), null, "el aviso deja su lugar al del cambio de cuenta");
  const panel = switchPanelOf(tab)!.shadow!;
  assert.match(String(panel.getElementById("adaceenSwitchText").textContent), /^Tu editor es de «alumno», pero VS Code entró con otra cuenta\./);
  assert.match(String(panel.getElementById("adaceenSwitchStatus").textContent), /^ADACEEN lo está haciendo por ti: mira el anillo/);
  // Primero el anillo en el botón real y, un momento después, la pulsación.
  await advance(browser, 200);
  assert.equal(panel.getElementById("adaceenGuidePointer").hidden, false);
  assert.equal(panel.getElementById("adaceenGuidePointerLabel").textContent, "ADACEEN pulsa «Cancelar»", "dice que lo hace ADACEEN");
  assert.deepEqual(vscode.log, [], "todavía no pulsa: se ve el anillo");
  await browser.clock.until(() => reloads.length > 0, 600);
  assert.deepEqual(vscode.log, ["cancelar", "accounts", "menu:eydersantiago", "ask:eydersantiago", "signout:eydersantiago", "accounts"]);
  assert.deepEqual(vscode.accounts.map((account) => account.login), ["alumno"], "la cuenta del editor no se toca");
  assert.ok(!vscode.log.includes("elegir"), "«Elegir otra cuenta» nunca (es el bucle)");
  assert.match(String(panel.getElementById("adaceenSwitchStatus").textContent), /^Listo: cerraste en VS Code la sesión de «eydersantiago \(GitHub\)»\. La página se recarga; cuando VS Code lo pida, entra con «alumno»\./);
  assert.equal((browser.storage.adaceenTunnelSignInHint as Json)?.githubLogin, "alumno", "paso 4 con la cuenta del editor");
  const record = browser.storage.adaceenEditorAccountSwitch as Json;
  assert.deepEqual([record.tunnelName, record.attempts, record.signedOut, record.outcome], ["ws-alumno", 1, [{ provider: "github", login: "eydersantiago" }], "signed_out"]);
  await advance(browser, 10_000);
  const events = accountSwitchEvents(browser);
  assert.deepEqual(events.map((event) => event.value), ["signed_out"]);
  assert.deepEqual(events[0].metadata, { stage: "menu_done", mode: "auto", retry: 1, signedOutCount: 1 });

  // Al recargar, el paso 4 dice que ya se cerró la otra cuenta y con cuál entrar.
  const after = await openTab(browser, TUNNEL_URL, "taller-1 - Visual Studio Code");
  await browser.clock.until(() => !!signInHintOf(after), 50);
  assert.match(String(signInHintOf(after)!.shadow!.getElementById("adaceenTunnelSignInText").textContent), /^Ya cerraste en VS Code la sesión de «eydersantiago \(GitHub\)»\. Ahora entra con la cuenta «alumno» \(la misma que autorizó el código\): cuando GitHub pregunte con qué cuenta, elige esa\./);
  assertKnownShadowIds(tab, after);
});

test("0.8.5: si un botón de VS Code no responde, el aviso se detiene ahí y lo pide con el anillo; cancelar no cuenta y al confirmar sigue solo", async () => {
  const browser = new FakeBrowser();
  seedVscodeSessionCase(browser);
  const { tab, vscode, reloads } = await openEditorWithVscode(browser, [{ login: "eydersantiago", provider: "GitHub" }, { login: "ana@correo.com", provider: "Microsoft" }]);
  vscode.deaf.add("submenu");
  await notFoundBannerOf(tab)!.shadow!.getElementById("adaceenNotFoundVscodeAccount").click();
  const panel = switchPanelOf(tab)!.shadow!;
  const status = panel.getElementById("adaceenSwitchStatus");
  const ringLabel = () => panel.getElementById("adaceenGuidePointerLabel").textContent;
  await browser.clock.until(() => /^No pude pulsar «Cerrar sesión» por ti\./.test(String(status.textContent)), 400);
  assert.equal(status.className, "status is-warn");
  assert.equal(ringLabel(), "Pulsa «Cerrar sesión»", "el anillo sigue en el botón real y ya no dice que lo pulsa ADACEEN");
  assert.equal(panel.getElementById("adaceenSwitchFinish").hidden, false, "«Ya cerré la sesión» a la vista");
  assert.equal(panel.getElementById("adaceenSwitchReset").hidden, false);
  assert.equal(reloads.length, 0);

  // El estudiante pide cerrar sesión, pero cancela la confirmación: ADACEEN abre el menú para
  // comprobarlo, la cuenta sigue y no da nada por cerrado.
  vscode.byHand.signOutInSubmenu();
  await advance(browser, 500);
  assert.equal(ringLabel(), "Pulsa «Cerrar sesión»", "el anillo pasa a la confirmación");
  vscode.byHand.cancelConfirm();
  await browser.clock.until(() => ringLabel() === "Pulsa «eydersantiago (GitHub)»", 200);
  assert.equal(reloads.length, 0, "cancelar no cuenta como cerrar sesión");
  assert.equal(browser.storage.adaceenEditorAccountSwitch, undefined);

  // Ahora sí: abre el submenú, cierra sesión y confirma; ADACEEN lo comprueba y recarga.
  vscode.byHand.openSubmenu("eydersantiago");
  vscode.byHand.signOutInSubmenu();
  await advance(browser, 500);
  assert.equal(vscode.log.filter((entry) => entry.startsWith("signout:")).length, 0, "en modo guiado ADACEEN no confirma");
  vscode.byHand.confirmSignOut("eydersantiago");
  assert.ok(await browser.clock.until(() => reloads.length > 0, 300), "ADACEEN comprueba en el menú que se cerró y recarga");
  assert.deepEqual(vscode.accounts.map((account) => account.login), ["ana@correo.com"], "lo que hizo el estudiante; Microsoft queda para la próxima");
  const record = browser.storage.adaceenEditorAccountSwitch as Json;
  assert.deepEqual([record.outcome, record.signedOut], ["signed_out", [{ provider: "github", login: "eydersantiago" }]]);
  await advance(browser, 10_000);
  assert.deepEqual(accountSwitchEvents(browser).map((event) => (event.metadata as Json).mode), ["guided"]);
  assertKnownShadowIds(tab);
});

test("0.8.5: sin el archivo del cambio de cuenta (si se saca del manifest) el aviso, «Reconectar» y el paso 4 siguen", async () => {
  const browser = new FakeBrowser();
  seedVscodeSessionCase(browser);
  browser.storage.adaceenEditorAccountSwitch = { userId: SESSION.user.id, tunnelName: "ws-alumno", attempts: 1, signedOut: [{ provider: "github", login: "otra" }], outcome: "signed_out", at: browser.clock.now };
  browser.storage.adaceenTunnelSignInHint = { userId: SESSION.user.id, tunnelName: "ws-alumno", githubLogin: "alumno", expiresAt: browser.clock.now + 10 * 60_000 };
  const scripts = OVERLAY_SCRIPTS.filter((rel) => rel !== "services/editor-account-switch.service.js");
  assert.equal(scripts.length, OVERLAY_SCRIPTS.length - 1);
  const tab = new TabEnv(browser, TUNNEL_URL, "Visual Studio Code");
  const vscode = new FakeVscodeAccounts(tab, [{ login: "otra", provider: "GitHub" }]);
  tab.load(scripts);
  await browser.clock.settle();
  vscode.showTunnelDialog();
  await browser.clock.until(() => !!notFoundBannerOf(tab) && !!signInHintOf(tab), 50);
  const shadow = notFoundBannerOf(tab)!.shadow!;
  assert.match(String(shadow.getElementById("adaceenNotFoundText").textContent), /^Ya cambiaste la cuenta de VS Code \(cerraste «otra \(GitHub\)»\)/);
  assert.match(String(signInHintOf(tab)!.shadow!.getElementById("adaceenTunnelSignInText").textContent), /^Ya cerraste en VS Code la sesión de «otra \(GitHub\)»/);
  await shadow.getElementById("adaceenNotFoundVscodeAccount").click();
  assert.match(String(shadow.getElementById("adaceenNotFoundStatus").textContent), /^Hazlo a mano: pulsa «Cancelar» en el aviso de VS Code, el ícono de cuentas/);
  assert.equal(shadow.getElementById("adaceenNotFoundReconnect").disabled, false, "reconectar sigue disponible");
  assertKnownShadowIds(tab);
});

test("0.8.5: sin otra cuenta en VS Code borra la sesión de vscode.dev; el freno pasa a «Reconectar» tras dos cambios", async () => {
  const browser = new FakeBrowser();
  seedVscodeSessionCase(browser);
  const first = await openEditorWithVscode(browser, [{ login: "alumno", provider: "GitHub" }]);
  await notFoundBannerOf(first.tab)!.shadow!.getElementById("adaceenNotFoundVscodeAccount").click();
  await browser.clock.until(() => browser.vscodeResetMessages.length > 0, 400);
  assert.deepEqual(browser.vscodeResetMessages, [{ type: "ADACEEN_RESET_VSCODE_SESSION", origin: "https://vscode.dev", url: TUNNEL_URL }]);
  assert.deepEqual(first.vscode.accounts.map((account) => account.login), ["alumno"], "la del editor no se cierra");
  assert.match(String(switchPanelOf(first.tab)!.shadow!.getElementById("adaceenSwitchStatus").textContent), /^VS Code no tiene otra cuenta abierta: ADACEEN borra la sesión que vscode\.dev guarda/);
  assert.deepEqual(
    [(browser.storage.adaceenEditorAccountSwitch as Json)?.attempts, (browser.storage.adaceenEditorAccountSwitch as Json)?.outcome],
    [1, "reset"],
  );
  assert.equal((browser.storage.adaceenTunnelSignInHint as Json)?.githubLogin, "alumno");

  // Sigue sin aparecer: un cambio más es lo principal.
  const second = await openEditorWithVscode(browser, [{ login: "otra-cuenta", provider: "GitHub" }]);
  let shadow = notFoundBannerOf(second.tab)!.shadow!;
  assert.match(String(shadow.getElementById("adaceenNotFoundText").textContent), /^Ya cambiaste la cuenta de VS Code y tu editor sigue sin aparecer\.$/);
  assert.equal(shadow.getElementById("adaceenNotFoundVscodeAccount").className, "primary");
  await shadow.getElementById("adaceenNotFoundVscodeAccount").click();
  await browser.clock.until(() => second.reloads.length > 0, 600);
  assert.deepEqual((browser.storage.adaceenEditorAccountSwitch as Json)?.attempts, 2);

  // Dos cambios y sigue igual: lo principal es reconectar (o la ventana de incógnito).
  const third = await openEditorWithVscode(browser, [{ login: "otra-cuenta", provider: "GitHub" }]);
  shadow = notFoundBannerOf(third.tab)!.shadow!;
  assert.match(String(shadow.getElementById("adaceenNotFoundText").textContent), /^Ya cambiaste la cuenta de VS Code \(cerraste «otra-cuenta \(GitHub\)»\) y tu editor sigue sin aparecer\. Ya se intentó 2 veces: lo más seguro es reconectar\.$/);
  assert.equal(shadow.getElementById("adaceenNotFoundReconnect").className, "primary");
  assert.equal(shadow.getElementById("adaceenNotFoundVscodeAccount").className, "secondary");
  const steps = (shadow.getElementById("adaceenNotFoundSteps").children || []).map((item) => String(item.textContent));
  assert.match(steps[1], /ventana de incógnito/);

  // Sin el ícono de cuentas (VS Code lo deja esconder) también se borra la sesión guardada.
  delete browser.storage.adaceenEditorAccountSwitch;
  browser.vscodeResetMessages = [];
  const hidden = await openEditorWithVscode(browser, [{ login: "otra-cuenta", provider: "GitHub" }]);
  hidden.vscode.showAccountsButton = false;
  await notFoundBannerOf(hidden.tab)!.shadow!.getElementById("adaceenNotFoundVscodeAccount").click();
  await browser.clock.until(() => browser.vscodeResetMessages.length > 0, 400);
  await advance(browser, 10_000);
  const last = accountSwitchEvents(browser).at(-1)!;
  assert.deepEqual([last.value, (last.metadata as Json).stage], ["reset", "no_account"]);
  assertKnownShadowIds(first.tab, second.tab, third.tab, hidden.tab);
});

test("0.8.5: las reglas del cambio de cuenta son funciones puras (qué cuenta cerrar, qué pantalla, qué hacer en cada vistazo, el freno)", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, TUNNEL_URL, "Visual Studio Code");
  const ctx = tab.context;
  // Lo que viene del contexto de la extensión (otro realm) se compara como datos.
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  const pick = (accounts: Array<[string, string]>, keepLogin: string, alreadySignedOutKeys: string[] = []) => ctx.pickVscodeAccountToSignOut(
    accounts.map(([login, provider]) => ({ login, provider })), { keepLogin, alreadySignedOutKeys },
  )?.login ?? null;
  assert.equal(pick([["alumno", "github"], ["eyder", "github"], ["ana@x.com", "microsoft"]], "alumno"), "eyder", "primero GitHub que no es la del editor");
  assert.equal(pick([["alumno", "github"], ["eyder", "github"], ["ana@x.com", "microsoft"]], "alumno", ["github:eyder"]), "ana@x.com", "después Microsoft");
  assert.equal(pick([["Alumno", "github"]], "alumno"), null, "la del editor nunca (sin importar mayúsculas)");

  // La pantalla con un documento cualquiera: el submenú abierto de la cuenta del editor no se usa.
  const node = (text: string) => Object.assign(tab.document.createElement("li"), { textContent: text });
  const mine = node("alumno (GitHub)");
  const other = node("eyder (GitHub)");
  const signOut = node("Cerrar sesión");
  [mine, other, signOut].forEach((item) => tab.document.body.appendChild(item));
  mine.contains = ((target: unknown) => target === signOut) as any;
  other.contains = ((target: unknown) => target === other) as any;
  const doc = { querySelectorAll: (selector: string) => (selector.includes(".monaco-menu .action-item") ? [mine, signOut, other] : []) };
  const screen = ctx.detectEditorAccountSwitchScreen(doc, { keepLogin: "alumno" });
  assert.deepEqual([screen.screen, screen.target === other, screen.login, plain(screen.accountKeys)], ["menu", true, "eyder", ["github:alumno", "github:eyder"]]);
  assert.equal(ctx.editorAccountSwitchPointerLabel(screen), "Pulsa «eyder (GitHub)»");
  assert.equal(ctx.editorAccountSwitchPointerLabel(screen, { pressedByAdaceen: true }), "ADACEEN pulsa «eyder (GitHub)»", "mientras pulsa ADACEEN");
  other.contains = ((target: unknown) => target === other || target === signOut) as any;
  mine.contains = ((target: unknown) => target === mine) as any;
  assert.equal(ctx.detectEditorAccountSwitchScreen(doc, { keepLogin: "alumno" }).screen, "submenu");
  assert.equal(ctx.editorAccountSwitchLabel(""), "Cambiar de cuenta en VS Code");
  // Solo se cancelan el diálogo del túnel y el que pide iniciar sesión.
  assert.equal(ctx.classifyVscodeDialog("No se pudo encontrar el túnel con el nombre ws-alumno."), "tunnel");
  assert.equal(ctx.classifyVscodeDialog("The extension 'Remote - Tunnels' wants to sign in using GitHub."), "sign_in");
  assert.equal(ctx.classifyVscodeDialog("¿Desea guardar los cambios?"), "other");

  // La decisión de cada vistazo (stepEditorAccountSwitch), con la hora a mano.
  const target = {};
  const view = (kind: string, extra: Json = {}) => ({ screen: kind, target, avoidArea: null, login: "", provider: "", accountCount: 0, accountKeys: [], dialogKind: "", ...extra });
  let run = ctx.createEditorAccountSwitchRun(0);
  const step = (kind: string, now: number, extra: Json = {}) => {
    const result = ctx.stepEditorAccountSwitch(run, view(kind, extra), now);
    run = result.run;
    return result.action.type === "finish" ? `finish:${result.action.outcome}:${result.action.stage}` : result.action.type;
  };
  assert.equal(step("accounts", 0), "wait", "primero el anillo");
  assert.equal(step("accounts", 500), "press");
  assert.equal(step("accounts", 1_000), "wait", "espera a que cambie la pantalla");
  assert.equal(step("accounts", 3_100), "press", "segundo intento");
  assert.equal(step("accounts", 5_700), "guided", "dos intentos sin cambio: lo pide al estudiante");
  assert.equal(ctx.editorAccountSwitchGuidedText({ reason: "no_response", screen: "accounts" }).startsWith("No pude pulsar el ícono de cuentas por ti."), true);
  assert.equal(step("accounts", 6_000), "wait", "en guiado ADACEEN no pulsa");

  run = ctx.createEditorAccountSwitchRun(0);
  let last: any = null;
  const stepFull = (kind: string, now: number, extra: Json = {}) => {
    last = ctx.stepEditorAccountSwitch(run, view(kind, extra), now);
    run = last.run;
    return last;
  };
  assert.equal(stepFull("dialog", 0, { dialogKind: "other" }).action.reason, "unknown_dialog", "un diálogo desconocido no se cancela: lo cierra el estudiante");
  assert.match(ctx.editorAccountSwitchGuidedText(last.action), /^VS Code muestra otro aviso: léelo y ciérralo tú \(ADACEEN no lo toca\)/);
  run = ctx.createEditorAccountSwitchRun(0);
  assert.equal(step("dialog", 0, { dialogKind: "tunnel" }), "wait");
  assert.equal(step("dialog", 500, { dialogKind: "tunnel" }), "press");
  assert.equal(run.dialogCancels, 1);
  assert.equal(stepFull("accounts", 61_000).action.reason, "time_limit", "pasado el minuto, lo que falta lo hace el estudiante");

  // Mandar los eventos falló: en automático, guiado; si era la comprobación en guiado, se pregunta.
  const failed = ctx.markEditorAccountSwitchPressFailed(ctx.createEditorAccountSwitchRun(0), view("submenu"));
  assert.deepEqual([failed.run.mode, failed.action.type, failed.action.reason], ["guided", "guided", "no_response"]);
  assert.equal(ctx.markEditorAccountSwitchPressFailed({ ...ctx.createEditorAccountSwitchRun(0), mode: "guided" }, view("accounts")).action.type, "ask_confirm");

  // Solo el diálogo que pide entrar de nuevo prueba que se cerró; el del túnel no.
  run = { ...ctx.createEditorAccountSwitchRun(0), lastScreen: "confirm", pendingAccount: { provider: "github", login: "eyder" } };
  stepFull("dialog", 100, { dialogKind: "tunnel" });
  assert.deepEqual([run.verifying?.login, run.signedOut.length], ["eyder", 0], "el diálogo del túnel no prueba nada");
  stepFull("dialog", 200, { dialogKind: "sign_in" });
  assert.deepEqual([run.verifying, plain(run.signedOut)], [null, [{ provider: "github", login: "eyder" }]]);
  assert.equal(last.action.type, "finish", "cerrada y VS Code pide entrar: listo");

  // En guiado, ADACEEN abre el menú para comprobar y el anillo lo dice antes de pulsar.
  run = { ...ctx.createEditorAccountSwitchRun(0), mode: "guided", lastScreen: "confirm", pendingAccount: { provider: "github", login: "eyder" } };
  assert.deepEqual([stepFull("accounts", 100).action.type, last.pressedByAdaceen], ["wait", true]);
  assert.deepEqual([stepFull("accounts", 600).action.type, last.pressedByAdaceen], ["press", true]);
  assert.deepEqual([stepFull("accounts", 700).action.type, last.pressedByAdaceen], ["wait", false]);

  // Sin poder comprobarlo en automático cuenta, pero el final lo dice.
  run = { ...ctx.createEditorAccountSwitchRun(0), lastScreen: "confirm", pendingAccount: { provider: "github", login: "eyder" } };
  stepFull("", 100, { target: null });
  stepFull("", 4_200, { target: null });
  assert.equal(run.assumedSignOut, true);
  stepFull("menu", 4_300, { target: null, accountKeys: [], accountCount: 0 });
  assert.equal(stepFull("menu", 7_400, { target: null, accountKeys: [], accountCount: 0 }).action.stage, "unverified");

  // Cerrar sesión: la confirmación que desaparece queda por comprobar en el menú.
  run = ctx.createEditorAccountSwitchRun(0);
  step("submenu", 0, { login: "eyder", provider: "github" });
  step("confirm", 600);
  step("accounts", 700);
  assert.deepEqual([run.verifying?.login, run.signedOut.length], ["eyder", 0]);
  step("menu", 800, { target: null, login: "", accountKeys: ["github:eyder", "github:alumno"], accountCount: 2 });
  assert.deepEqual([run.verifying, run.signedOut.length], [null, 0], "la cuenta sigue en el menú: se canceló");
  step("submenu", 900, { login: "eyder", provider: "github" });
  step("confirm", 1_000);
  step("accounts", 1_100);
  step("menu", 1_200, { target: null, accountKeys: ["github:alumno"], accountCount: 1 });
  assert.deepEqual(plain(run.signedOut), [{ provider: "github", login: "eyder" }], "ya no está: se cerró");
  assert.equal(run.signOutTries["github:eyder"], 2);
  assert.equal(step("menu", 2_000, { target: null, accountKeys: ["github:alumno"], accountCount: 1 }), "finish:signed_out:menu_done");

  // Sin poder comprobarlo: en guiado se pregunta; con la cuenta confirmada dos veces sin cerrarse, guiado.
  run = { ...ctx.createEditorAccountSwitchRun(0), mode: "guided", lastScreen: "confirm", pendingAccount: { provider: "github", login: "eyder" } };
  assert.equal(step("", 100, { target: null }), "wait");
  assert.equal(step("", 4_200, { target: null }), "ask_confirm");
  run = { ...ctx.createEditorAccountSwitchRun(0), signOutTries: { "github:eyder": 2 } };
  assert.equal(step("menu", 100, { login: "eyder", provider: "github", accountKeys: ["github:eyder"] }), "guided");
  // La pestaña oculta corre los tiempos.
  const shifted = ctx.shiftEditorAccountSwitchRun({ ...ctx.createEditorAccountSwitchRun(1_000), current: { key: "x", since: 1_000, presses: 1, lastPressAt: 1_200 } }, 5_000);
  assert.deepEqual([shifted.startedAt, shifted.current.since, shifted.current.lastPressAt], [6_000, 6_000, 6_200]);

  // El freno con lo que necesita cada aviso.
  assert.deepEqual(plain(ctx.editorAccountSwitchBrake(null)), { switchedRecently: false, attempts: 0, exhausted: false, nextAttempt: 1, closedLabels: [], closedLabelsText: "", closedGithubLogins: [] });
  assert.equal(ctx.editorAccountSwitchBrake({ attempts: 3, outcome: "cancelled", signedOut: [] }).attempts, 0, "un cambio cancelado no cuenta");
  const brake = ctx.editorAccountSwitchBrake({ attempts: 2, outcome: "signed_out", signedOut: [{ provider: "github", login: "eyder" }, { provider: "microsoft", login: "ana@x.com" }, "viejo (GitHub)"] });
  assert.deepEqual(
    plain([brake.switchedRecently, brake.exhausted, brake.nextAttempt, brake.closedLabels, brake.closedLabelsText, brake.closedGithubLogins]),
    [true, true, 3, ["eyder (GitHub)", "ana@x.com (Microsoft)"], "«eyder (GitHub)» y «ana@x.com (Microsoft)»", ["eyder"]],
  );
  assert.equal(ctx.tunnelNotFoundCause({ device: { account: "alumno" }, editorLogin: "alumno", brake }), "switch_exhausted");
  assert.equal(ctx.tunnelNotFoundCause({ device: { account: "otra" }, editorLogin: "alumno", brake }), "device", "el código de otra cuenta manda");
});

test("0.8.5 (paso 4): en el selector de cuentas de GitHub marca la cuenta del editor (o «usar otra cuenta») y advierte la que se cerró", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  browser.storage.adaceenTunnelSignInHint = { userId: SESSION.user.id, tunnelName: "ws-alumno", githubLogin: "alumno", expiresAt: browser.clock.now + 5 * 60_000 };
  browser.storage.adaceenEditorAccountSwitch = { userId: SESSION.user.id, tunnelName: "ws-alumno", attempts: 1, signedOut: [{ provider: "github", login: "eydersantiago" }, { provider: "microsoft", login: "ana@correo.com" }], outcome: "signed_out", at: browser.clock.now };
  const picker = "https://github.com/login/oauth/authorize?client_id=01ab8ac9400c4e429b23&redirect_uri=https%3A%2F%2Fvscode.dev%2Fredirect&scope=read%3Auser&prompt=select_account&state=x";
  const bannerOf = (tab: TabEnv) => tab.document.getElementById("adaceen-tunnel-signin-github");
  const pageWith = async (labels: Array<string | [string, string]>) => {
    const tab = new TabEnv(browser, picker, "GitHub");
    const meta = new FakeElement("meta", tab);
    meta.setAttribute("content", "eydersantiago");
    tab.document.selectors.set('meta[name="user-login"]', meta);
    const nodes = labels.map((label) => {
      const node = tab.document.createElement("button");
      const [text, visible] = Array.isArray(label) ? label : [label, label];
      node.textContent = text;
      node.innerText = visible;
      tab.document.body.appendChild(node);
      return node;
    });
    tab.document.querySelectorAll = ((selector: string) => (selector.startsWith("button, a[href]") ? nodes : [])) as any;
    tab.load();
    await browser.clock.until(() => !!bannerOf(tab), 50);
    await advance(browser, 1_000);
    return tab;
  };

  // El login y el nombre en elementos pegados (sin espacio en textContent), como en GitHub: cuenta el texto visible.
  const listed = await pageWith(["eydersantiago Eyder Suárez", ["alumnoAlumno Prueba", "alumno\nAlumno Prueba"], "Use a different account"]);
  let shadow = bannerOf(listed)!.shadow!;
  assert.match(String(shadow.getElementById("adaceenTunnelSignInText").textContent), /^GitHub pregunta con qué cuenta entrar a VS Code\. Elige «alumno»: es la de tu editor\./);
  assert.match(String(shadow.getElementById("adaceenTunnelSignInWarn").textContent), /^No elijas «eydersantiago»: con esa cuenta tu editor no aparece\./);
  assert.equal(shadow.getElementById("adaceenGuidePointerLabel").textContent, "Elige «alumno»");
  assert.equal(shadow.getElementById("adaceenGuideFigure").getAttribute("data-figure"), "github-select-account");

  const missing = await pageWith(["eydersantiago Eyder Suárez", "Use a different account"]);
  shadow = bannerOf(missing)!.shadow!;
  assert.equal(shadow.getElementById("adaceenGuidePointerLabel").textContent, "Pulsa «Use a different account»");
  const items = (shadow.getElementById("adaceenTunnelSignInSteps").children || []).map((item) => String(item.textContent));
  assert.match(items[0], /^«alumno» no está en la lista: pulsa «Use a different account»/);

  // Ya en la página de autorizar (con el botón verde) sigue el paso 4 de siempre.
  const authorize = await openGithubAs(browser, picker.replace("&prompt=select_account", ""), "alumno");
  await browser.clock.until(() => !!bannerOf(authorize), 50);
  assert.match(String(bannerOf(authorize)!.shadow!.getElementById("adaceenTunnelSignInText").textContent), /^Esta página es de GitHub: autoriza «Visual Studio Code»/);
  assertKnownShadowIds(listed, missing, authorize);
});
