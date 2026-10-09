// Simulacion en Chromium real del aviso del codigo de dispositivo (0.7.20):
// la extension real se carga en Chromium (solo con el shadow root del aviso abierto para
// poder leerlo), github.com/login/device se intercepta con una pagina falsa y el codigo
// pendiente se siembra en chrome.storage. Comprueba que el codigo queda escrito en el
// formulario, que la pagina recibe los eventos y que el formulario NO se envia.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const OUT = process.argv[2] || path.join(process.cwd(), "salida");
fs.mkdirSync(OUT, { recursive: true });

const CODE = "WDJB-MJHT";
const BACKEND = "https://app-adaceen-api-eyder05232002.azurewebsites.net";
const USER = { id: "u-alumno", role: "student", email: "alumno@correounivalle.edu.co", displayName: "Alumno Prueba", assignedCourseCodes: ["FPOO"] };
const FILLED = "El codigo ya esta en el formulario: pulsa Continue y autoriza con tu cuenta de GitHub. Esta pestana abrira tu editor sola.";

// Copia de la extension con el shadow root del aviso abierto (lo unico que cambia).
const ext = fs.mkdtempSync(path.join(os.tmpdir(), "adaceen-ext-"));
fs.cpSync(path.join(ROOT, "browser-ext-prod"), ext, { recursive: true });
const wsFile = path.join(ext, "services/workspace.service.js");
const wsSrc = fs.readFileSync(wsFile, "utf8");
if (!wsSrc.includes('host.attachShadow({ mode: "closed" })')) throw new Error("no se encontro el attachShadow del aviso");
fs.writeFileSync(wsFile, wsSrc.replace('host.attachShadow({ mode: "closed" })', 'host.attachShadow({ mode: "open" })'));

const paginaBase = (titulo, cuerpo, script) => `<!doctype html><html><head><meta charset="utf-8"><title>${titulo}</title>
<style>body{font-family:sans-serif;margin:120px auto;max-width:420px} input{font:20px monospace;padding:6px} .boxes input{width:34px;text-align:center;margin:2px} button{margin-top:16px;padding:8px 16px}</style>
</head><body><h1>Device Activation</h1><p>Enter the code displayed on your device</p>${cuerpo}
<script>
window.__events = []; window.__submitted = 0;
document.querySelectorAll("input").forEach((i) => ["input", "change", "paste"].forEach((t) => i.addEventListener(t, (e) => window.__events.push(t + ":" + (i.name || i.id || i.getAttribute("aria-label")) + "=" + (t === "paste" ? e.clipboardData.getData("text/plain") : i.value)))));
document.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); window.__submitted += 1; });
${script || ""}
</script></body></html>`;

// Variante A: un solo campo user_code (XXXX-XXXX) y un oculto con el mismo nombre.
const paginaUnCampo = paginaBase("Device Activation · GitHub", `
<form class="js-device-authorization-form" action="/login/device" method="post">
  <input type="hidden" name="authenticity_token" value="tok">
  <input type="hidden" name="user_code" class="js-user-code-hidden" value="">
  <label for="user-code">Code</label>
  <input type="text" name="user_code" id="user-code" class="form-control input-monospace js-device-code-input" maxlength="9" placeholder="XXXX-XXXX" autocomplete="off" autofocus>
  <button type="submit">Continue</button>
</form>`);

// Variante B: ocho cuadros de un caracter sin nombre; al pegar en el primero, la pagina
// reparte el codigo (como hace GitHub) y compone un oculto user_code.
const paginaOchoCuadros = paginaBase("Device Activation · GitHub", `
<form action="/login/device" method="post">
  <input type="hidden" name="authenticity_token" value="tok">
  <input type="hidden" name="user_code" class="js-user-code" value="">
  <div class="boxes">
    ${Array.from({ length: 8 }, (_, i) => `<input type="text" maxlength="1" class="js-code-box" aria-label="Character ${i + 1}" autocomplete="off">${i === 3 ? " - " : ""}`).join("")}
  </div>
  <button type="submit">Continue</button>
</form>`, `
const boxes = [...document.querySelectorAll(".js-code-box")];
const hidden = document.querySelector(".js-user-code");
const compose = () => { hidden.value = boxes.map((b) => b.value).join("").replace(/^(.{4})(.{4})$/, "$1-$2"); };
boxes[0].addEventListener("paste", (e) => {
  const text = (e.clipboardData.getData("text/plain") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (text.length < 8) return;
  e.preventDefault();
  boxes.forEach((b, i) => { b.value = text[i] || ""; });
  window.__events.push("paste-repartido=" + text);
  compose();
});
boxes.forEach((b) => b.addEventListener("input", compose));
`);

const seed = {
  adaceenSessionId: "sess-browser-1",
  adaceenActiveSessionSnapshot: { sessionId: "sess-browser-1", backendUrl: BACKEND, session: { id: "sess-browser-1", user: USER }, policy: {}, telemetry: [], updatedAt: Date.now() },
  adaceenPrivacyAcceptedByUser: { [USER.id]: true },
  adaceenClientId: "cliente-prueba-123",
};
const handoff = () => ({ userCode: CODE, userId: USER.id, repoFullName: "univalle-fpoo/taller-1", expiresAt: Date.now() + 10 * 60_000, savedAt: Date.now(), aliveAt: Date.now() });

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "adaceen-perfil-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  executablePath: process.env.CHROME_BIN || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  headless: true,
  viewport: { width: 1100, height: 700 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://github.com" });
// Nada sale a la red: el backend responde 503 y github.com/login/device es la pagina falsa.
await context.route((url) => url.origin === BACKEND, (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"ok":false,"error":"simulado"}' }));
let pagina = paginaUnCampo;
await context.route((url) => url.origin === "https://github.com", (route) => {
  if (/^\/login\/device/.test(new URL(route.request().url()).pathname)) {
    return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: pagina });
  }
  return route.fulfill({ status: 204, body: "" });
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20_000 });
const sembrar = async () => {
  await sw.evaluate(async (data) => { await chrome.storage.local.clear(); await chrome.storage.local.set(data); }, { ...seed, adaceenDeviceCodeHandoff: handoff() });
};

const resultados = [];
const corrida = async (nombre, html, esperado) => {
  pagina = html;
  await sembrar();
  const page = await context.newPage();
  const consola = [];
  page.on("console", (m) => consola.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => consola.push(`pageerror: ${e.message}`));
  await page.goto("https://github.com/login/device", { waitUntil: "domcontentloaded" });
  const aviso = page.locator("#adaceen-device-code-helper");
  await aviso.waitFor({ state: "attached", timeout: 20_000 });
  const estado = page.locator("#adaceen-device-code-helper #adaceenDeviceCodeStatus");
  await page.waitForFunction(
    (texto) => document.getElementById("adaceen-device-code-helper")?.shadowRoot?.getElementById("adaceenDeviceCodeStatus")?.textContent === texto,
    FILLED,
    { timeout: 6_000 },
  ).catch(() => {});
  const lectura = await page.evaluate(() => ({
    campos: [...document.querySelectorAll("form input")].filter((i) => i.type !== "hidden" || i.name === "user_code").map((i) => [i.type + ":" + (i.name || i.id || i.getAttribute("aria-label")), i.value]),
    eventos: window.__events,
    enviado: window.__submitted,
    foco: document.activeElement?.tagName + "#" + (document.activeElement?.id || ""),
  }));
  const estadoTexto = await estado.textContent();
  const codigoVisible = await page.locator("#adaceen-device-code-helper #adaceenDeviceCode").textContent();
  let portapapeles = "";
  try { portapapeles = await page.evaluate(() => navigator.clipboard.readText()); } catch (error) { portapapeles = `(no legible: ${error.message})`; }
  await page.screenshot({ path: path.join(OUT, `${nombre}.png`) });
  const ok = estadoTexto === FILLED && lectura.enviado === 0 && esperado(lectura);
  resultados.push({ nombre, ok, estadoTexto, codigoVisible, portapapeles, ...lectura, consola });
  await page.close();
};

await corrida("un-campo", paginaUnCampo, (l) => {
  const valores = Object.fromEntries(l.campos);
  return valores["text:user_code"] === CODE && valores["hidden:user_code"] === CODE && l.eventos.includes("input:user_code=" + CODE);
});
await corrida("ocho-cuadros", paginaOchoCuadros, (l) => {
  const cajas = l.campos.filter(([k]) => k.startsWith("text:")).map(([, v]) => v).join("");
  const valores = Object.fromEntries(l.campos);
  return cajas === CODE.replace("-", "") && valores["hidden:user_code"] === CODE;
});

await context.close();
fs.writeFileSync(path.join(OUT, "resultado.json"), JSON.stringify(resultados, null, 2));
for (const r of resultados) {
  console.log(`${r.ok ? "OK " : "FALLA"} ${r.nombre}: estado="${r.estadoTexto}" enviado=${r.enviado} foco=${r.foco} portapapeles=${r.portapapeles}`);
  console.log(`      campos=${JSON.stringify(r.campos)}`);
  console.log(`      eventos=${JSON.stringify(r.eventos)}`);
  if (r.consola.length) console.log(`      consola=${JSON.stringify(r.consola.slice(0, 6))}`);
}
process.exit(resultados.every((r) => r.ok) ? 0 : 1);
