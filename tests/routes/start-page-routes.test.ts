import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import type { Server } from "node:http";
import express from "express";
import { createApp } from "../../src/app.js";
import { createDatabase } from "../../src/db/database.js";
import {
  cleanChromeWebStoreUrl,
  readUpdateManifest,
  registerStartPageRoutes,
  type StartPageDeps,
} from "../../src/routes/start-page-routes.js";

/**
 * Pagina de inicio /empezar y descargas (acceso simplificado, seccion 6):
 * HTML propio sin recursos externos, archivos del paquete desplegado y 404
 * amable si faltan. Los paquetes firmados (CRX + manifiesto de actualizacion,
 * XPI de Firefox) y el boton de Chrome Web Store son opcionales: solo salen si
 * existen (docs/operacion/publicar-extension.md).
 */

const UPDATE_XML = `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='abcdefghijklmnopabcdefghijklmnop'>
    <updatecheck codebase='https://ejemplo.test/descargas/adaceen.crx' version='0.7.11'/>
  </app>
</gupdate>
`;

// chromeWebStoreUrl vacia: la variable CHROME_WEB_STORE_URL del entorno no influye en las pruebas.
async function startPage(rootDir: string, deps: Omit<StartPageDeps, "rootDir"> = {}) {
  const app = express();
  registerStartPageRoutes(app, { rootDir, chromeWebStoreUrl: "", ...deps });
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No se pudo iniciar servidor de prueba.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function tempRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "adaceen-empezar-"));
}

async function write(root: string, relative: string, content: string | Buffer) {
  const target = path.join(root, relative);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content);
}

function inlineScript(html: string) {
  const match = html.match(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/);
  assert.ok(match, "la pagina trae su script en linea con nonce");
  return { nonce: match[1], code: match[2] };
}

test("/empezar: HTML accesible, sin recursos externos y con CSP de nonce; sin archivos, avisa que faltan", async () => {
  const root = await tempRoot();
  const page = await startPage(root);
  try {
    const response = await fetch(`${page.baseUrl}/empezar`);
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get("content-type")), /text\/html; charset=utf-8/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const html = await response.text();

    assert.match(html, /<html lang="es"/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1" \/>/);
    assert.match(html, /<h1>Empieza con ADACEEN<\/h1>/);
    assert.match(html, /class="skip" href="#paso-navegador"/, "enlace para saltar a los pasos");
    assert.match(html, /aria-live="polite"/);
    assert.equal((html.match(/<ol class="steps">[\s\S]*?<\/ol>/)?.[0].match(/<li>/g) || []).length, 4, "4 pasos para cargar la extension");
    assert.match(html, /chrome:\/\/extensions/);
    assert.match(html, /Modo de desarrollador/);
    // Paso 2 (auditoria de redundancias, punto 13): en Chrome el icono esta en
    // el menu de extensiones hasta fijarlo; despues se inicia sesion y la
    // primera vez se acepta la privacidad. «Empezar» ya no es un paso.
    const entrar = html.match(/<section aria-labelledby="paso-github-titulo">[\s\S]*?<\/section>/)?.[0] || "";
    assert.match(entrar, /menu de extensiones \(el icono de <strong>pieza de rompecabezas<\/strong>\)/);
    assert.match(entrar, /fijala con el alfiler/);
    assert.match(entrar, /Inicia sesion con tu cuenta de ADACEEN\. La primera vez lee la politica de privacidad y pulsa <strong>Aceptar y continuar<\/strong>/);
    assert.doesNotMatch(entrar, /pulsa el boton de ADACEEN/);
    assert.doesNotMatch(entrar, /Empezar/);
    const pasos = (entrar.match(/<li>[\s\S]*?<\/li>/g) || []).map((item) => item.replace(/<[^>]+>/g, ""));
    assert.equal(pasos.length, 4);
    assert.ok(pasos[0].includes("icono de ADACEEN") && pasos[1].includes("Inicia sesion") && pasos[2].includes("Conectar GitHub"), "orden: icono, sesion y privacidad, GitHub");

    // Gatekeeper de macOS 15+: clic derecho -> Abrir ya no basta con archivos descargados.
    assert.match(html, /macOS 15 o posterior[^<]*<strong>Ajustes del Sistema &rarr; Privacidad y seguridad<\/strong>[^<]*<strong>Abrir igualmente<\/strong>/);

    // Sin recursos externos: nada de src/href remotos para cargar, ni hojas de estilo externas.
    assert.doesNotMatch(html, /<script[^>]+src=/);
    assert.doesNotMatch(html, /<link[^>]+stylesheet/);
    assert.doesNotMatch(html, /<img /);
    assert.doesNotMatch(html, /url\(/);

    const csp = String(response.headers.get("content-security-policy"));
    const { nonce, code } = inlineScript(html);
    assert.ok(csp.includes(`script-src 'nonce-${nonce}'`), csp);
    assert.ok(csp.includes("connect-src 'self'"), "el estado sale de /api/health del mismo origen");
    assert.ok(csp.includes("default-src 'none'"));
    // El script compila (sintaxis valida) y escucha el aviso de la extension.
    assert.doesNotThrow(() => new vm.Script(code));
    assert.match(code, /adaceen:extension/);
    assert.match(code, /adaceenExtension/);
    assert.match(code, /\/api\/health/);

    // Sin archivos publicados: avisos en vez de enlaces rotos.
    assert.doesNotMatch(html, /href="\/descargas\//);
    assert.equal((html.match(/class="unavailable"/g) || []).length, 3);
    // Sin XPI firmado, Firefox sigue con la carga temporal; sin CRX no hay nota de politica;
    // sin CHROME_WEB_STORE_URL no hay boton de la tienda.
    assert.match(html, /<h3 id="paso-firefox-titulo">Firefox<\/h3>/);
    assert.match(html, /Cargar complemento temporal\.\.\./);
    assert.match(html, /about:debugging/);
    assert.doesNotMatch(html, /Instalar en Firefox/);
    assert.doesNotMatch(html, /Instalacion por politica/);
    assert.doesNotMatch(html, /Instalar desde Chrome Web Store/);

    const second = await fetch(`${page.baseUrl}/empezar`).then((result) => result.text());
    assert.notEqual(inlineScript(second).nonce, nonce, "nonce nuevo en cada respuesta");
  } finally {
    await page.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("/descargas: sirve los archivos del paquete desplegado y 404 amable si faltan", async () => {
  const root = await tempRoot();
  const zipBytes = Buffer.from("PK\u0003\u0004zip-de-prueba");
  await write(root, "descargas/adaceen-navegador.zip", zipBytes);
  await write(root, "descargas/versiones.json", JSON.stringify({ navegador: "0.7.11", vscode: "0.0.31" }));
  await write(root, "vscode-ext-prod/adaceen.vsix", "vsix-del-workflow");
  await write(root, "descargas/Preparar-Mac-ADACEEN.command", "#!/bin/bash\necho hola\n");
  await write(root, "descargas/adaceen.crx", "Cr24crx-de-prueba");
  await write(root, "descargas/adaceen-update.xml", UPDATE_XML);
  await write(root, "descargas/adaceen.xpi", "xpi-firmado");
  const page = await startPage(root);
  try {
    const html = await fetch(`${page.baseUrl}/empezar`).then((response) => response.text());
    assert.match(html, /data-browser-ext-latest="0\.7\.11"/);
    assert.match(html, /href="\/descargas\/adaceen-navegador\.zip" download/);
    assert.match(html, /zip, version 0\.7\.11/);
    assert.match(html, /href="\/descargas\/adaceen\.vsix" download/);
    assert.match(html, /VSIX, version 0\.0\.31/);
    assert.match(html, /href="\/descargas\/Preparar-Mac-ADACEEN\.command" download/, "sin el zip se ofrece el .command");
    assert.equal((html.match(/class="unavailable"/g) || []).length, 0);

    // XPI firmado: boton «Instalar en Firefox» sin el atributo download (Firefox instala al abrirlo).
    const firefoxButton = html.match(/<a class="button" href="\/descargas\/adaceen\.xpi"[^>]*>/)?.[0] || "";
    assert.ok(firefoxButton, "boton de Firefox");
    assert.doesNotMatch(firefoxButton, /download/);
    assert.match(html, /Instalar en Firefox<span class="button-detail">instalacion permanente, version 0\.7\.11<\/span>/);
    assert.match(html, /<strong>Permitir<\/strong> y luego <strong>Agregar<\/strong>/);
    assert.doesNotMatch(html, /Cargar complemento temporal/);
    // CRX + manifiesto: nota para Sistemas con el id, la URL del manifiesto y el valor de la politica.
    const politica = html.match(/<p class="note" id="politica-laboratorio">[\s\S]*?<\/p>/)?.[0] || "";
    assert.match(politica, /Instalacion por politica \(equipos del laboratorio\)/);
    assert.match(politica, /<code>abcdefghijklmnopabcdefghijklmnop;https:\/\/ejemplo\.test\/descargas\/adaceen-update\.xml<\/code>/);
    assert.match(politica, /ExtensionInstallForcelist/);
    assert.match(politica, /href="\/descargas\/adaceen\.crx" download/);

    const crx = await fetch(`${page.baseUrl}/descargas/adaceen.crx`);
    assert.equal(crx.status, 200);
    assert.equal(crx.headers.get("content-type"), "application/x-chrome-extension");
    assert.equal(crx.headers.get("content-disposition"), "attachment; filename=\"adaceen.crx\"");
    assert.equal(await crx.text(), "Cr24crx-de-prueba");
    const updateXml = await fetch(`${page.baseUrl}/descargas/adaceen-update.xml`);
    assert.equal(updateXml.status, 200);
    assert.equal(updateXml.headers.get("content-type"), "application/xml; charset=utf-8");
    assert.equal(updateXml.headers.get("content-disposition"), "inline; filename=\"adaceen-update.xml\"", "Chrome lo lee, no lo descarga");
    assert.equal(await updateXml.text(), UPDATE_XML);
    const xpi = await fetch(`${page.baseUrl}/descargas/adaceen.xpi`);
    assert.equal(xpi.status, 200);
    assert.equal(xpi.headers.get("content-type"), "application/x-xpinstall");
    assert.equal(xpi.headers.get("content-disposition"), "inline; filename=\"adaceen.xpi\"", "inline: Firefox lo instala en vez de guardarlo");
    assert.equal(await xpi.text(), "xpi-firmado");

    const zip = await fetch(`${page.baseUrl}/descargas/adaceen-navegador.zip`);
    assert.equal(zip.status, 200);
    assert.equal(zip.headers.get("content-type"), "application/zip");
    assert.equal(zip.headers.get("content-disposition"), "attachment; filename=\"adaceen-navegador.zip\"");
    assert.equal(zip.headers.get("cache-control"), "no-cache");
    assert.deepEqual(Buffer.from(await zip.arrayBuffer()), zipBytes);

    const vsix = await fetch(`${page.baseUrl}/descargas/adaceen.vsix`);
    assert.equal(vsix.status, 200, "el VSIX sale de vscode-ext-prod/adaceen.vsix");
    assert.equal(await vsix.text(), "vsix-del-workflow");

    const command = await fetch(`${page.baseUrl}/descargas/Preparar-Mac-ADACEEN.command`);
    assert.equal(command.status, 200);
    assert.match(String(command.headers.get("content-disposition")), /Preparar-Mac-ADACEEN\.command/);

    const missing = await fetch(`${page.baseUrl}/descargas/Preparar-Mac-ADACEEN.zip`);
    assert.equal(missing.status, 404);
    assert.match(String(missing.headers.get("content-type")), /text\/html/);
    const missingHtml = await missing.text();
    assert.match(missingHtml, /todavia no esta disponible/);
    assert.match(missingHtml, /href="\/empezar"/);

    // Con el zip del instalador, la pagina lo prefiere (conserva el permiso de ejecucion).
    await write(root, "descargas/Preparar-Mac-ADACEEN.zip", "zip-mac");
    const withZip = await fetch(`${page.baseUrl}/empezar`).then((response) => response.text());
    assert.match(withZip, /href="\/descargas\/Preparar-Mac-ADACEEN\.zip" download/);

    const head = await fetch(`${page.baseUrl}/descargas/adaceen-navegador.zip`, { method: "HEAD" });
    assert.equal(head.status, 200);
  } finally {
    await page.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("/descargas: en desarrollo toma el VSIX y el zip mas nuevos del repositorio", async () => {
  const root = await tempRoot();
  await write(root, "vscode-ext-prod/adaceen-0.0.9.vsix", "viejo");
  await write(root, "vscode-ext-prod/adaceen-0.0.31.vsix", "nuevo");
  await write(root, "vscode-ext-prod/adaceen-0.0.30.vsix", "anterior");
  await write(root, "dist/extension/adaceen-chromium-0.7.9.zip", "zip-viejo");
  await write(root, "dist/extension/adaceen-chromium-0.7.11.zip", "zip-nuevo");
  await write(root, "dist/extension/adaceen-firefox-0.7.12.zip", "firefox");
  await write(root, "dist/extension/adaceen-0.7.9.crx", "crx-viejo");
  await write(root, "dist/extension/adaceen-0.7.11.crx", "crx-nuevo");
  await write(root, "dist/extension/adaceen-update.xml", UPDATE_XML);
  // El XPI firmado a mano se guarda en deploy/extension/ (opcion A de publicar-extension.md).
  await write(root, "deploy/extension/adaceen-firefox-0.7.9.xpi", "xpi-viejo");
  await write(root, "deploy/extension/adaceen-firefox-0.7.11.xpi", "xpi-nuevo");
  await write(root, "browser-ext-prod/manifest.json", JSON.stringify({ version: "0.7.11" }));
  const page = await startPage(root);
  try {
    assert.equal(await fetch(`${page.baseUrl}/descargas/adaceen.vsix`).then((response) => response.text()), "nuevo");
    assert.equal(await fetch(`${page.baseUrl}/descargas/adaceen-navegador.zip`).then((response) => response.text()), "zip-nuevo");
    assert.equal(await fetch(`${page.baseUrl}/descargas/adaceen.crx`).then((response) => response.text()), "crx-nuevo");
    assert.equal(await fetch(`${page.baseUrl}/descargas/adaceen-update.xml`).then((response) => response.text()), UPDATE_XML);
    assert.equal(await fetch(`${page.baseUrl}/descargas/adaceen.xpi`).then((response) => response.text()), "xpi-nuevo");
    const html = await fetch(`${page.baseUrl}/empezar`).then((response) => response.text());
    assert.match(html, /data-browser-ext-latest="0\.7\.11"/, "version desde el manifest del repo");
    assert.match(html, /Instalar en Firefox/);
    assert.match(html, /Instalacion por politica/);
  } finally {
    await page.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("/empezar: boton de Chrome Web Store solo con una URL https de la tienda, antes del zip; nota de politica solo con un manifiesto legible", async () => {
  const root = await tempRoot();
  await write(root, "descargas/adaceen-navegador.zip", "zip");
  await write(root, "descargas/adaceen.crx", "Cr24");
  await write(root, "descargas/adaceen-update.xml", "<gupdate>sin appid ni codebase</gupdate>\n");
  const storeUrl = "https://chromewebstore.google.com/detail/adaceen/abcdefghijklmnopabcdefghijklmnop";
  const withStore = await startPage(root, { chromeWebStoreUrl: storeUrl });
  const badStore = await startPage(root, { chromeWebStoreUrl: "http://ejemplo.test/no-es-la-tienda" });
  try {
    const html = await fetch(`${withStore.baseUrl}/empezar`).then((response) => response.text());
    const storeButton = html.indexOf("Instalar desde Chrome Web Store");
    const zipButton = html.indexOf("Descargar la extension");
    assert.ok(storeButton > 0 && storeButton < zipButton, "la tienda va antes del zip");
    assert.match(html, /<a class="button" href="https:\/\/chromewebstore\.google\.com\/detail\/adaceen\/abcdefghijklmnopabcdefghijklmnop" rel="noreferrer noopener">Instalar desde Chrome Web Store<span class="button-detail">Chrome y Edge, sin modo de desarrollador<\/span><\/a>/);
    assert.match(html, /<strong>Agregar a Chrome<\/strong>/);
    assert.match(html, /Modo de desarrollador/, "los pasos del zip siguen como alternativa");
    assert.doesNotMatch(html, /Instalacion por politica/, "manifiesto sin appid: la nota no se muestra");

    const other = await fetch(`${badStore.baseUrl}/empezar`).then((response) => response.text());
    assert.doesNotMatch(other, /Instalar desde Chrome Web Store/);
    assert.doesNotMatch(other, /ejemplo\.test/);

    assert.equal(cleanChromeWebStoreUrl(` ${storeUrl} `), storeUrl);
    assert.equal(cleanChromeWebStoreUrl("https://chrome.google.com/webstore/detail/adaceen/abcdefghijklmnopabcdefghijklmnop"), "https://chrome.google.com/webstore/detail/adaceen/abcdefghijklmnopabcdefghijklmnop");
    assert.equal(cleanChromeWebStoreUrl("javascript:alert(1)"), "");
    assert.equal(cleanChromeWebStoreUrl("https://chromewebstore.google.com/detail/x\"><script>"), "");
    assert.equal(cleanChromeWebStoreUrl(undefined), "");

    assert.equal(readUpdateManifest(path.join(root, "descargas/adaceen-update.xml")), null);
    assert.equal(readUpdateManifest(path.join(root, "no-existe.xml")), null);
    await write(root, "descargas/adaceen-update.xml", UPDATE_XML);
    assert.deepEqual(readUpdateManifest(path.join(root, "descargas/adaceen-update.xml")), {
      id: "abcdefghijklmnopabcdefghijklmnop",
      manifestUrl: "https://ejemplo.test/descargas/adaceen-update.xml",
    });
  } finally {
    await withStore.close();
    await badStore.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("/api/health: estado del editor y del modelo para /empezar, sin secretos", async () => {
  const database = await createDatabase();
  const app = createApp(database);
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("sin puerto");
    const health = await fetch(`http://127.0.0.1:${address.port}/api/health`).then((response) => response.json()) as Record<string, unknown>;
    assert.equal(typeof health.model_workers_alive, "number");
    assert.equal(health.model_workers_known_down, false, "sin latidos registrados no se sabe: no se marca caido");
    assert.equal(typeof health.workspace_vm_autostart, "boolean");
    assert.ok("workspace_agent_transport" in health);
    const text = JSON.stringify(health);
    assert.doesNotMatch(text, /PRIVATE KEY|client_email|token-/i);

    const pageResponse = await fetch(`http://127.0.0.1:${address.port}/empezar`);
    assert.equal(pageResponse.status, 200, "createApp registra /empezar");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await database.close();
  }
});

// DOM minimo para ejecutar el script de /empezar sin navegador.
function runPageScript(code: string, options: { latest: string; marker?: string; health?: unknown; healthFails?: boolean }) {
  type Item = { state: string; badge: string; text: string };
  const items: Record<string, Item> = {};
  const element = (id: string) => {
    const item: Item = { state: "checking", badge: "", text: "" };
    items[id] = item;
    return {
      setAttribute: (name: string, value: string) => {
        if (name === "data-state") item.state = value;
      },
      querySelector: (selector: string) => ({
        set textContent(value: string) {
          if (selector === ".badge") item.badge = value;
          else item.text = value;
        },
      }),
    };
  };
  const elements: Record<string, unknown> = {
    "estado-extension": element("estado-extension"),
    "estado-editor": element("estado-editor"),
    "estado-modelo": element("estado-modelo"),
  };
  const listeners: Array<(event: unknown) => void> = [];
  const timers: Array<() => void> = [];
  const root = {
    dataset: options.marker ? { adaceenExtension: options.marker } : {},
    getAttribute: (name: string) => (name === "data-browser-ext-latest" ? options.latest : null),
  };
  const fakeWindow: Record<string, unknown> = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === "message") listeners.push(listener);
    },
    setTimeout: (callback: () => void) => {
      timers.push(callback);
      return timers.length;
    },
    fetch: () => options.healthFails
      ? Promise.reject(new TypeError("sin red"))
      : Promise.resolve({ ok: true, json: () => Promise.resolve(options.health || {}) }),
  };
  fakeWindow.window = fakeWindow;
  const context = vm.createContext({
    window: fakeWindow,
    document: { documentElement: root, getElementById: (id: string) => elements[id] || null, querySelectorAll: () => [] },
    navigator: {},
  });
  vm.runInContext(code, context);
  return {
    items,
    post: (data: unknown, source: unknown = fakeWindow) => listeners.forEach((listener) => listener({ source, data })),
    runTimers: () => timers.splice(0).forEach((callback) => callback()),
  };
}

test("/empezar: el script detecta la extension (postMessage o marca del content script) y muestra el estado", async () => {
  const root = await tempRoot();
  const page = await startPage(root);
  try {
    const { code } = inlineScript(await fetch(`${page.baseUrl}/empezar`).then((response) => response.text()));

    // Sin extension: tras la espera avisa que no la encontro.
    const none = runPageScript(code, { latest: "0.7.11", health: { workspace_provider: "codespaces", mode: "local", target_mode_valid: true } });
    none.runTimers();
    assert.equal(none.items["estado-extension"].state, "warn");
    assert.match(none.items["estado-extension"].text, /no la encontramos/);

    // Aviso por postMessage; mensajes ajenos o de otra ventana se ignoran.
    const posted = runPageScript(code, { latest: "0.7.11" });
    posted.post({ type: "otra-cosa", version: "9.9.9" });
    posted.post({ type: "adaceen:extension", version: "0.7.11" }, { otraVentana: true });
    assert.equal(posted.items["estado-extension"].state, "checking");
    posted.post({ type: "adaceen:extension", version: "0.7.11" });
    assert.equal(posted.items["estado-extension"].state, "ok");
    assert.match(posted.items["estado-extension"].text, /0\.7\.11/);
    posted.runTimers();
    assert.equal(posted.items["estado-extension"].state, "ok", "la espera no pisa la deteccion");

    // Marca del content script con version vieja: pide actualizar.
    const old = runPageScript(code, { latest: "0.7.11", marker: "0.7.10" });
    assert.equal(old.items["estado-extension"].state, "warn");
    assert.match(old.items["estado-extension"].text, /version nueva \(0\.7\.11\)/);

    // Version rara: se muestra instalada sin repetir el texto recibido.
    const weird = runPageScript(code, { latest: "0.7.11" });
    weird.post({ type: "adaceen:extension", version: "<img src=x>" });
    assert.equal(weird.items["estado-extension"].state, "ok");
    assert.doesNotMatch(weird.items["estado-extension"].text, /img/);

    // Estado del servicio: tunel por relay con autoencendido y cola sin workers.
    const health = runPageScript(code, {
      latest: "",
      health: {
        workspace_provider: "tunnel",
        workspace_agent_transport: "relay",
        workspace_agent_online: false,
        workspace_vm_autostart: true,
        mode: "queue",
        model_workers_alive: 0,
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(health.items["estado-editor"].state, "ok");
    assert.match(health.items["estado-editor"].text, /se enciende solo/);
    // 0 equipos sin saber si cayeron (sin token de latidos o backend recien reiniciado): sin alarma.
    assert.equal(health.items["estado-modelo"].state, "ok");
    assert.equal(health.items["estado-modelo"].badge, "Configurado");
    assert.doesNotMatch(health.items["estado-modelo"].text, /Avisa al docente/);

    // Hubo latidos y todos vencieron: ahi si se avisa.
    const down = runPageScript(code, {
      latest: "",
      health: { workspace_provider: "codespaces", mode: "queue", model_workers_alive: 0, model_workers_known_down: true },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(down.items["estado-modelo"].state, "warn");
    assert.equal(down.items["estado-modelo"].badge, "Sin equipos");
    assert.match(down.items["estado-modelo"].text, /Avisa al docente/);

    const online = runPageScript(code, {
      latest: "",
      health: { workspace_provider: "tunnel", workspace_agent_transport: "relay", workspace_agent_online: true, mode: "queue", model_workers_alive: 2 },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(online.items["estado-editor"].badge, "Encendido");
    assert.match(online.items["estado-modelo"].text, /2 equipos/);

    const off = runPageScript(code, {
      latest: "",
      health: { workspace_provider: "tunnel", workspace_agent_transport: "relay", workspace_agent_online: false, workspace_vm_autostart: false, mode: "queue", model_workers_alive: 1 },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(off.items["estado-editor"].state, "warn");
    assert.match(off.items["estado-editor"].text, /Avisa al docente/);

    const failed = runPageScript(code, { latest: "", healthFails: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(failed.items["estado-editor"].state, "bad");
    assert.equal(failed.items["estado-modelo"].state, "bad");
  } finally {
    await page.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});
