// Simulacion en Chromium real del cambio de cuenta de VS Code (navegador 0.8.5).
// La extension real se carga en Chromium (con los shadow roots abiertos para poder leerlos);
// vscode.dev se intercepta con un workbench falso que copia las clases y los eventos del VS Code
// real (1.143): mousedown en el boton de cuentas, mouseup en las opciones del menu (registrado
// 100 ms despues de dibujarlas), click en los botones de los dialogos y un dialogo a la vez.
// Uso: node docs/evidencias/overlay-0.8.5/sim-cambio-cuenta.mjs <carpeta de la extension> <carpeta de salida>
// (la carpeta de la extension: browser-ext-prod o dist/extension/adaceen-chromium-0.8.5.zip descomprimido;
// CHROME_BIN si Chromium no esta donde Playwright lo busca).
// Resultado del 26/10/2026 (paquete 0.8.5): 4/4 (automatico, guiado con una cancelacion, selector de GitHub
// con y sin la cuenta del editor).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// playwright desde el proyecto o, si no esta, desde PLAYWRIGHT_DIR (carpeta node_modules con playwright).
const require = createRequire(process.env.PLAYWRIGHT_DIR ? `${process.env.PLAYWRIGHT_DIR}/` : import.meta.url);
const { chromium } = require("playwright");

const SRC = path.resolve(process.argv[2]);
const OUT = path.resolve(process.argv[3] || "salida");
fs.mkdirSync(OUT, { recursive: true });
const HERE = path.dirname(new URL(import.meta.url).pathname);
const FAKE_VSCODE = fs.readFileSync(path.join(HERE, "vscode-falso.html"), "utf8");

const BACKEND = "https://app-adaceen-api-eyder05232002.azurewebsites.net";
const USER = { id: "u-alumno", role: "student", email: "alumno@correounivalle.edu.co", displayName: "Alumno Prueba", assignedCourseCodes: ["FPOO"] };
const REPO = "univalle-fpoo/taller-relaciones";
const TUNNEL_URL = "https://vscode.dev/tunnel/ad-montysansu-cmyk/home/ws-montysansu-cmyk/taller-relaciones?vscode-lang=es-us";
const PICKER_URL = "https://github.com/login/oauth/authorize?client_id=01ab8ac9400c4e429b23&redirect_uri=https%3A%2F%2Fvscode.dev%2Fredirect&scope=read%3Auser&prompt=select_account&state=x";

// Copia de la extension con los shadow roots abiertos (lo unico que cambia).
const ext = fs.mkdtempSync(path.join(os.tmpdir(), "adaceen-ext-"));
fs.cpSync(SRC, ext, { recursive: true });
for (const rel of ["services/workspace.service.js", "services/tunnel-entry-guide.service.js", "services/editor-account-switch.service.js"]) {
  const file = path.join(ext, rel);
  const source = fs.readFileSync(file, "utf8");
  if (!source.includes('attachShadow({ mode: "closed" })')) throw new Error(`sin attachShadow cerrado en ${rel}`);
  fs.writeFileSync(file, source.replaceAll('attachShadow({ mode: "closed" })', 'attachShadow({ mode: "open" })'));
}

const pickerPage = (accounts) => `<!doctype html><html><head><meta charset="utf-8"><meta name="user-login" content="eydersantiago"><title>Select account · GitHub</title>
<style>body{font-family:-apple-system,Segoe UI,sans-serif;background:#fff;color:#1f2328;margin:0}header{height:64px;background:#f6f8fa;border-bottom:1px solid #d0d7de}
main{max-width:340px;margin:60px auto;text-align:center}.acc{display:flex;gap:10px;align-items:center;width:100%;padding:10px 12px;margin:8px 0;border:1px solid #d0d7de;border-radius:6px;background:#fff;font:inherit;cursor:pointer;text-align:left}
.av{width:28px;height:28px;border-radius:50%;background:#8c959f}small{color:#59636e;display:block}a{color:#0969da}</style></head>
<body><header></header><main><h2>Select an account</h2><p>to continue to <b>Visual Studio Code</b></p>
${accounts.map(([login, name]) => `<form method="post"><button class="acc" type="button"><span class="av"></span><span><b>${login}</b><small>${name}</small></span></button></form>`).join("")}
<p><a href="/login?add_account=1">Use a different account</a></p></main></body></html>`;

const seed = () => ({
  adaceenSessionId: "sess-browser-1",
  adaceenActiveSessionSnapshot: { sessionId: "sess-browser-1", backendUrl: BACKEND, session: { id: "sess-browser-1", user: USER }, policy: {}, telemetry: [], updatedAt: Date.now() },
  adaceenPrivacyAcceptedByUser: { [USER.id]: "2026-10-11" },
  adaceenClientId: "cliente-prueba-123",
  adaceenEditorByUser: {
    [`${USER.id}:${REPO}`]: { repoFullName: REPO, webUrl: TUNNEL_URL, provider: "tunnel", savedAt: new Date().toISOString(), needsSessionRefresh: false, sessionWrittenAt: new Date().toISOString(), openedAt: new Date().toISOString() },
  },
  // El codigo del paso 3 lo autorizo la cuenta correcta: falla la cuenta con la que entro VS Code.
  adaceenTunnelDeviceAccount: { userId: USER.id, expected: "montysansu-cmyk", account: "montysansu-cmyk", at: Date.now(), expiresAt: Date.now() + 86_400_000 },
});

const resultados = [];
const anota = (nombre, ok, detalle) => {
  resultados.push({ nombre, ok, ...detalle });
  console.log(`${ok ? "OK   " : "FALLA"} ${nombre}${detalle?.nota ? `: ${detalle.nota}` : ""}`);
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "adaceen-perfil-"));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_BIN || undefined,
  headless: true,
  viewport: { width: 1366, height: 768 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let pickerAccounts = [["eydersantiago", "Eyder Santiago"], ["montysansu-cmyk", "Monty Sansu"]];
await context.route((url) => url.origin === BACKEND, (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"ok":false,"error":"simulado"}' }));
await context.route((url) => url.hostname === "vscode.dev", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: FAKE_VSCODE }));
await context.route((url) => url.hostname === "github.com", (route) => {
  if (new URL(route.request().url()).pathname.startsWith("/login/oauth/")) {
    return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: pickerPage(pickerAccounts) });
  }
  return route.fulfill({ status: 204, body: "" });
});
let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20_000 });
const sembrar = async (extra = {}) => sw.evaluate(async (data) => { await chrome.storage.local.clear(); await chrome.storage.local.set(data); }, { ...seed(), ...extra });
const storage = async (key) => sw.evaluate(async (k) => (await chrome.storage.local.get([k]))[k], key);

const shadowText = (page, hostId, id) => page.evaluate(([h, i]) => document.getElementById(h)?.shadowRoot?.getElementById(i)?.textContent ?? null, [hostId, id]);
const ringOf = (page, hostId) => page.evaluate((h) => {
  const root = document.getElementById(h)?.shadowRoot;
  const ring = root?.getElementById("adaceenGuidePointer");
  if (!ring || ring.hidden) return null;
  return { label: root.getElementById("adaceenGuidePointerLabel")?.textContent || "", left: ring.style.left, top: ring.style.top, width: ring.style.width, height: ring.style.height };
}, hostId);

// Mira el anillo cada 60 ms y saca una captura cada vez que cambia lo que dice.
async function seguirAnillo(page, hostId, prefijo, hasta, maxMs = 20_000) {
  const vistos = [];
  const inicio = Date.now();
  let ultimo = "";
  while (Date.now() - inicio < maxMs) {
    let ring = null;
    try {
      ring = await ringOf(page, hostId);
    } catch {
      break; // la pagina se esta recargando
    }
    const label = ring?.label || "";
    const clave = ring ? `${label}@${ring.top}` : "";
    if (label && clave !== ultimo) {
      ultimo = clave;
      vistos.push({ ms: Date.now() - inicio, ...ring });
      await page.screenshot({ path: path.join(OUT, `${prefijo}-${String(vistos.length).padStart(2, "0")}.png`) }).catch(() => {});
    }
    if (await hasta().catch(() => true)) break;
    await page.waitForTimeout(60);
  }
  return vistos;
}

// ---- A: automatico de punta a punta ----
{
  await sembrar();
  const page = await context.newPage();
  const consola = [];
  page.on("console", (m) => { if (["error", "warning"].includes(m.type())) consola.push(`${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => consola.push(`pageerror: ${e.message}`));
  await page.goto(TUNNEL_URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!document.getElementById("adaceen-tunnel-not-found")?.shadowRoot, null, { timeout: 15_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, "A-00-aviso.png") });
  const boton = await shadowText(page, "adaceen-tunnel-not-found", "adaceenNotFoundVscodeAccount");
  let recargas = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) recargas += 1; });
  await page.locator("#adaceen-tunnel-not-found #adaceenNotFoundVscodeAccount").click();
  const anillos = await seguirAnillo(page, "adaceen-editor-account-switch", "A", async () => recargas > 0);
  const estadoFinal = resultados.length; // marcador
  await page.waitForFunction(() => document.readyState === "complete" && !!document.getElementById("adaceen-tunnel-signin-hint")?.shadowRoot, null, { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1_600);
  const paso4 = await shadowText(page, "adaceen-tunnel-signin-hint", "adaceenTunnelSignInText");
  const anilloPaso4 = await ringOf(page, "adaceen-tunnel-signin-hint");
  await page.screenshot({ path: path.join(OUT, "A-99-paso4-tras-recargar.png") });
  const log = await page.evaluate(() => window.__log);
  const registro = await storage("adaceenEditorAccountSwitch");
  const hint = await storage("adaceenTunnelSignInHint");
  const esperado = ["cancelar-tunel", "cuentas", "menu-abierto", "submenu:eydersantiago", "pide-cerrar:eydersantiago", "cerro:eydersantiago"];
  const ok = boton === "Cambiar a montysansu-cmyk"
    && esperado.every((paso, i) => log[i] === paso)
    && !log.includes("elegir-otra-cuenta")
    && registro?.outcome === "signed_out" && registro?.signedOut?.[0]?.login === "eydersantiago"
    && hint?.githubLogin === "montysansu-cmyk"
    && /^Ya cerraste en VS Code la sesión de «eydersantiago \(GitHub\)»/.test(paso4 || "")
    && anilloPaso4?.label === "Pulsa «Permitir»";
  anota("A automatico: cierra la otra cuenta en VS Code y recarga con el paso 4", ok, { boton, log, anillos, registro, paso4, anilloPaso4, consola, nota: `log=${JSON.stringify(log)}` });
  void estadoFinal;
  await page.close();
}

// ---- B: un boton que no responde a la pagina: se detiene y el estudiante lo pulsa con el mouse ----
{
  await sembrar();
  const page = await context.newPage();
  await page.goto("about:blank");
  const consola = [];
  page.on("pageerror", (e) => consola.push(`pageerror: ${e.message}`));
  await page.goto(`${TUNNEL_URL}&deaf=submenu`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(`${TUNNEL_URL}&deaf=submenu`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!document.getElementById("adaceen-tunnel-not-found")?.shadowRoot, null, { timeout: 15_000 });
  await page.locator("#adaceen-tunnel-not-found #adaceenNotFoundVscodeAccount").click();
  await page.waitForFunction(() => /^No pude pulsar/.test(document.getElementById("adaceen-editor-account-switch")?.shadowRoot?.getElementById("adaceenSwitchStatus")?.textContent || ""), null, { timeout: 20_000 });
  const estado = await shadowText(page, "adaceen-editor-account-switch", "adaceenSwitchStatus");
  const anillo = await ringOf(page, "adaceen-editor-account-switch");
  await page.screenshot({ path: path.join(OUT, "B-01-guiado.png") });
  // El estudiante pulsa «Cerrar sesión» con el mouse (evento de verdad), pero cancela la confirmacion:
  // ADACEEN abre el menu para comprobarlo y, como la cuenta sigue, no la da por cerrada.
  let recargas = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) recargas += 1; });
  await page.locator(".monaco-submenu .action-label", { hasText: "Cerrar sesión" }).click();
  await page.waitForSelector(".monaco-dialog-box", { timeout: 5_000 });
  await page.locator(".monaco-dialog-box .monaco-button", { hasText: "Cancelar" }).click();
  await page.waitForFunction(() => document.getElementById("adaceen-editor-account-switch")?.shadowRoot?.getElementById("adaceenGuidePointerLabel")?.textContent === "Pulsa «eydersantiago (GitHub)»", null, { timeout: 8_000 }).catch(() => {});
  const anilloTrasCancelar = await ringOf(page, "adaceen-editor-account-switch");
  const registroTrasCancelar = await storage("adaceenEditorAccountSwitch");
  await page.screenshot({ path: path.join(OUT, "B-02a-cancelo.png") });
  // Ahora si: la cuenta, «Cerrar sesión» y confirmar, todo con el mouse.
  // Como una persona: VS Code escucha cada opcion 100 ms despues de dibujarla.
  await page.locator(".monaco-menu .action-label", { hasText: "eydersantiago (GitHub)" }).click();
  await page.waitForTimeout(300);
  await page.locator(".monaco-submenu .action-label", { hasText: "Cerrar sesión" }).click();
  await page.waitForSelector(".monaco-dialog-box", { timeout: 5_000 });
  await page.waitForTimeout(900);
  const anilloConfirma = await ringOf(page, "adaceen-editor-account-switch");
  await page.screenshot({ path: path.join(OUT, "B-02-confirmar.png") });
  await page.locator(".monaco-dialog-box .monaco-button", { hasText: "Cerrar sesión" }).click();
  await page.waitForFunction(() => /^Listo/.test(document.getElementById("adaceen-editor-account-switch")?.shadowRoot?.getElementById("adaceenSwitchStatus")?.textContent || ""), null, { timeout: 5_000 }).catch(() => {});
  await page.screenshot({ path: path.join(OUT, "B-03-listo.png") });
  const deadline = Date.now() + 6_000;
  while (!recargas && Date.now() < deadline) await page.waitForTimeout(100);
  const registro = await storage("adaceenEditorAccountSwitch");
  const ok = /^No pude pulsar «Cerrar sesión» por ti\./.test(estado || "") && anillo?.label === "Pulsa «Cerrar sesión»"
    && anilloTrasCancelar?.label === "Pulsa «eydersantiago (GitHub)»" && !registroTrasCancelar
    && anilloConfirma?.label === "Pulsa «Cerrar sesión»" && registro?.outcome === "signed_out" && recargas > 0;
  anota("B guiado: se detiene en el boton que no responde, cancelar no cuenta y sigue cuando el estudiante confirma", ok, { estado, anillo, anilloTrasCancelar, registroTrasCancelar, anilloConfirma, registro, recargas, consola });
  await page.close();
}

// ---- C: selector de cuentas de GitHub ----
for (const [nombre, cuentas, esperado] of [
  ["C1 selector con la cuenta del editor", [["eydersantiago", "Eyder Santiago"], ["montysansu-cmyk", "Monty Sansu"]], "Elige «montysansu-cmyk»"],
  ["C2 selector sin la cuenta del editor", [["eydersantiago", "Eyder Santiago"]], "Pulsa «Use a different account»"],
]) {
  await sembrar({
    adaceenTunnelSignInHint: { userId: USER.id, tunnelName: "ad-montysansu-cmyk", githubLogin: "montysansu-cmyk", expiresAt: Date.now() + 10 * 60_000 },
    adaceenEditorAccountSwitch: { userId: USER.id, tunnelName: "ad-montysansu-cmyk", attempts: 1, signedOut: [{ provider: "github", login: "eydersantiago" }], outcome: "signed_out", at: Date.now() },
  });
  pickerAccounts = cuentas;
  const page = await context.newPage();
  await page.goto(PICKER_URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!document.getElementById("adaceen-tunnel-signin-github")?.shadowRoot, null, { timeout: 15_000 });
  await page.waitForTimeout(1_200);
  const anillo = await ringOf(page, "adaceen-tunnel-signin-github");
  const aviso = await shadowText(page, "adaceen-tunnel-signin-github", "adaceenTunnelSignInWarn");
  const archivo = nombre.startsWith("C1") ? "C-01-selector.png" : "C-02-selector-sin-cuenta.png";
  await page.screenshot({ path: path.join(OUT, archivo) });
  anota(nombre, anillo?.label === esperado && /No elijas «eydersantiago»/.test(aviso || ""), { anillo, aviso });
  await page.close();
}

await context.close();
fs.writeFileSync(path.join(OUT, "resultado.json"), JSON.stringify(resultados, null, 2));
process.exit(resultados.every((r) => r.ok) ? 0 : 1);
