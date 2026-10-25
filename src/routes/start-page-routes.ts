// Pagina de inicio /empezar y descargas (docs/arquitectura/acceso-simplificado.md, seccion 6).
//
//   GET /empezar                                  HTML sin recursos externos: descargas, 4 pasos
//                                                 para cargar la extension, deteccion de la
//                                                 extension y estado del servicio (/api/health).
//   GET /descargas/adaceen-navegador.zip          extension de navegador (zip de empaquetar-extension.mjs)
//   GET /descargas/adaceen.crx                    la misma extension como CRX3 firmado (empaquetar-crx.mjs),
//                                                 para instalarla por politica en equipos gestionados
//   GET /descargas/adaceen-update.xml             manifiesto de actualizacion de Google que apunta al CRX
//   GET /descargas/adaceen.xpi                    paquete de Firefox firmado por addons.mozilla.org
//                                                 (instalacion permanente con un clic)
//   GET /descargas/adaceen.vsix                   extension de VS Code
//   GET /descargas/Preparar-Mac-ADACEEN.zip       instalador de Mac para estudiantes (con permiso de ejecucion)
//   GET /descargas/Preparar-Mac-ADACEEN.command   el mismo instalador suelto
//
//   GET /api/extension/chrome-web-store           JSON: pagina, id y version de la tienda y si es el
//                                                 camino principal (lo lee Preparar-Mac-ADACEEN.command)
//
// Los archivos salen del paquete desplegado (carpeta descargas/ que arma el
// workflow y vscode-ext-prod/adaceen.vsix); si faltan, 404 con una pagina amable.
// CRX, manifiesto y XPI son opcionales (docs/operacion/publicar-extension.md): la
// pagina solo los ofrece si existen.
// Chrome Web Store (src/services/chrome-web-store.ts): si la tienda ya tiene la
// version del zip (o CHROME_WEB_STORE_MIN_VERSION), el paso 1 es «Agregar ADACEEN a
// Chrome» y el zip queda como instalacion manual en un desplegable; si la tienda esta
// atrasada, manda el zip; si no se pudo consultar, salen los dos por igual.
// CHROME_WEB_STORE_URL cambia la pagina de la tienda ("off" la quita).
// La extension de navegador avisa que esta instalada con un content script
// propio: window.postMessage({ type: "adaceen:extension", version }) y/o
// document.documentElement.dataset.adaceenExtension = version.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type express from "express";
import { env } from "../config/env.js";
import {
  CHROME_WEB_STORE_ID,
  CHROME_WEB_STORE_UPDATE_URL,
  cleanChromeWebStoreUrl,
  cleanExtensionVersion,
  compareExtensionVersions,
  createStoreVersionReader,
  describeChromeWebStore,
  extensionIdFromStoreUrl,
  resolveChromeWebStoreUrl,
  type ChromeWebStoreStatus,
  type StoreVersionReader,
} from "../services/chrome-web-store.js";
import { readDownloadVersions } from "../services/download-versions.js";

export { cleanChromeWebStoreUrl };

export type StartPageDeps = {
  /** Raiz del paquete desplegado (por defecto process.cwd(), como el VSIX de github-app.ts). */
  rootDir?: string;
  /**
   * Pagina de la tienda ya decidida. Sin pasarla se usa CHROME_WEB_STORE_URL (o la del id
   * conocido). Vacia = sin tienda.
   */
  chromeWebStoreUrl?: string;
  /** Version minima de la tienda; por defecto CHROME_WEB_STORE_MIN_VERSION o la del zip. */
  chromeWebStoreMinVersion?: string;
  /** Lector de la version publicada; por defecto el update check de Google con cache. */
  readStoreVersion?: StoreVersionReader;
};

type DownloadKey = "navegador" | "crx" | "actualizacion" | "firefox" | "vsix" | "macZip" | "macCommand";

type DownloadSpec = {
  path: string;
  fileName: string;
  contentType: string;
  /** Rutas relativas a la raiz, en orden de preferencia. */
  candidates: string[];
  /** Respaldo para desarrollo local: el mas nuevo que cumpla el patron en esas carpetas. */
  newestIn?: Array<{ dir: string; pattern: RegExp }>;
  /** inline: el navegador lo abre en vez de guardarlo (Firefox instala el XPI; Chrome lee el XML). */
  disposition?: "attachment" | "inline";
};

const VERSION_PATTERN = "(\\d+)\\.(\\d+)\\.(\\d+)(?:\\.(\\d+))?";

const DOWNLOADS: Record<DownloadKey, DownloadSpec> = {
  navegador: {
    path: "/descargas/adaceen-navegador.zip",
    fileName: "adaceen-navegador.zip",
    contentType: "application/zip",
    candidates: ["descargas/adaceen-navegador.zip"],
    newestIn: [{ dir: "dist/extension", pattern: new RegExp(`^adaceen-chromium-${VERSION_PATTERN}\\.zip$`) }],
  },
  crx: {
    path: "/descargas/adaceen.crx",
    fileName: "adaceen.crx",
    contentType: "application/x-chrome-extension",
    candidates: ["descargas/adaceen.crx"],
    newestIn: [{ dir: "dist/extension", pattern: new RegExp(`^adaceen-${VERSION_PATTERN}\\.crx$`) }],
  },
  actualizacion: {
    path: "/descargas/adaceen-update.xml",
    fileName: "adaceen-update.xml",
    contentType: "application/xml; charset=utf-8",
    candidates: ["descargas/adaceen-update.xml", "dist/extension/adaceen-update.xml"],
    disposition: "inline",
  },
  firefox: {
    path: "/descargas/adaceen.xpi",
    fileName: "adaceen.xpi",
    contentType: "application/x-xpinstall",
    candidates: ["descargas/adaceen.xpi"],
    // deploy/extension/: XPI firmado a mano y guardado en el repositorio (publicar-extension.md, 2.4).
    newestIn: [
      { dir: "deploy/extension", pattern: new RegExp(`^adaceen-firefox-${VERSION_PATTERN}\\.xpi$`) },
      { dir: "dist/extension", pattern: new RegExp(`^adaceen-firefox-${VERSION_PATTERN}\\.xpi$`) },
    ],
    disposition: "inline",
  },
  vsix: {
    path: "/descargas/adaceen.vsix",
    fileName: "adaceen.vsix",
    contentType: "application/octet-stream",
    candidates: ["descargas/adaceen.vsix", "vscode-ext-prod/adaceen.vsix"],
    newestIn: [{ dir: "vscode-ext-prod", pattern: /^adaceen-(\d+)\.(\d+)\.(\d+)\.vsix$/ }],
  },
  macZip: {
    path: "/descargas/Preparar-Mac-ADACEEN.zip",
    fileName: "Preparar-Mac-ADACEEN.zip",
    contentType: "application/zip",
    candidates: ["descargas/Preparar-Mac-ADACEEN.zip"],
  },
  macCommand: {
    path: "/descargas/Preparar-Mac-ADACEEN.command",
    fileName: "Preparar-Mac-ADACEEN.command",
    contentType: "application/octet-stream",
    candidates: ["descargas/Preparar-Mac-ADACEEN.command", "deploy/mac/estudiante/Preparar-Mac-ADACEEN.command"],
  },
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isFile(filePath: string) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function compareVersionParts(left: number[], right: number[]) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function newestMatching(dir: string, pattern: RegExp) {
  let best: { file: string; version: number[] } | null = null;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return "";
  }
  for (const name of names) {
    const match = name.match(pattern);
    if (!match) continue;
    const version = match.slice(1).filter((part) => part !== undefined).map(Number);
    const file = path.join(dir, name);
    if (!isFile(file)) continue;
    if (!best || compareVersionParts(version, best.version) > 0) best = { file, version };
  }
  return best?.file || "";
}

export function resolveDownloadFile(rootDir: string, key: DownloadKey) {
  const spec = DOWNLOADS[key];
  for (const candidate of spec.candidates) {
    const absolute = path.resolve(rootDir, candidate);
    if (isFile(absolute)) return absolute;
  }
  for (const fallback of spec.newestIn || []) {
    const newest = newestMatching(path.resolve(rootDir, fallback.dir), fallback.pattern);
    if (newest) return newest;
  }
  return "";
}

/**
 * Id de la extension y URL del manifiesto de actualizacion, leidos del XML que genera
 * empaquetar-crx.mjs (appid y codebase), para la nota de instalacion por politica.
 */
export function readUpdateManifest(filePath: string) {
  let xml = "";
  try {
    xml = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const id = xml.match(/appid=['"]([a-p]{32})['"]/)?.[1] || "";
  const codebase = xml.match(/codebase=['"]([^'"]+)['"]/)?.[1] || "";
  if (!id || !/^https:\/\//.test(codebase)) return null;
  try {
    return { id, manifestUrl: new URL(DOWNLOADS.actualizacion.fileName, codebase).href };
  } catch {
    return null;
  }
}

// readDownloadVersions vive en src/services/download-versions.ts (la usa tambien la guia del
// tunel); se reexporta para los que la importaban de aqui.
export { readDownloadVersions };

type PolicyInfo = { id: string; manifestUrl: string };

type PageInput = {
  nonce: string;
  available: Record<DownloadKey, boolean>;
  versions: { navegador: string; vscode: string };
  /** Id y manifiesto del CRX publicado, o null si no hay CRX ni XML. */
  policy?: PolicyInfo | null;
  /** Tienda y version publicada (describeChromeWebStore); sin ella, solo el zip. */
  store?: ChromeWebStoreStatus | null;
};

function downloadButton(href: string, label: string, detail: string) {
  return `<a class="button" href="${escapeHtml(href)}" download>${escapeHtml(label)}<span class="button-detail">${escapeHtml(detail)}</span></a>`;
}

// Sin el atributo download: Firefox instala el XPI al abrirlo y la tienda se abre como pagina.
function linkButton(href: string, label: string, detail: string, options: { external?: boolean } = {}) {
  const rel = options.external ? " rel=\"noreferrer noopener\"" : "";
  return `<a class="button" href="${escapeHtml(href)}"${rel}>${escapeHtml(label)}<span class="button-detail">${escapeHtml(detail)}</span></a>`;
}

function unavailable(label: string) {
  return `<p class="unavailable" role="note"><strong>${escapeHtml(label)}:</strong> todavia no esta publicado en este servidor. Avisa al docente.</p>`;
}

// La tienda se abre en otra pestana: al volver, el script recarga /empezar para que el
// content script de la extension recien agregada avise que esta instalada.
function storeButton(url: string, label: string, detail: string) {
  return `<a class="button" id="boton-tienda" href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(label)}<span class="button-detail">${escapeHtml(detail)}</span></a>`;
}

function chromeWebStoreNote() {
  return `<p class="note">Desde la tienda basta con pulsar <strong>Agregar a Chrome</strong> y confirmar: no hay que descomprimir nada ni activar el modo de desarrollador, y se actualiza sola. En Edge acepta antes <strong>Permitir extensiones de otras tiendas</strong>. Los pasos de abajo son para el zip, si la tienda no esta disponible en tu navegador.</p>`;
}

// La carpeta del zip tiene el mismo id que la tienda (campo key del manifest): son la misma
// extension y Chrome no deja tener las dos.
function replaceManualNote() {
  return `<p class="note">Si ya la tenias cargada con el zip, quitala primero en <code>chrome://extensions</code> (boton <strong>Quitar</strong> de ADACEEN): es la misma extension y, mientras este la manual, la tienda la muestra como ya agregada.</p>`;
}

function zipActions(available: boolean, detail: string) {
  return available ? downloadButton(DOWNLOADS.navegador.path, "Descargar la extension", detail) : unavailable("La extension del navegador");
}

function zipSteps() {
  return `<ol class="steps">
          <li>Descomprime el archivo descargado (doble clic). Queda una carpeta <code>adaceen-navegador</code>; dejala donde no la borres.</li>
          <li>Abre una pestana nueva y escribe <code>chrome://extensions</code> en la barra de direcciones (en Edge, <code>edge://extensions</code>).
            <button type="button" class="secondary" data-copy="chrome://extensions">Copiar direccion</button></li>
          <li>Activa <strong>Modo de desarrollador</strong> (arriba a la derecha; en Edge, abajo a la izquierda).</li>
          <li>Pulsa <strong>Cargar descomprimida</strong> (o <strong>Cargar extension sin empaquetar</strong>), elige la carpeta <code>adaceen-navegador</code> y vuelve a esta pagina: en Estado veras la extension instalada.</li>
        </ol>
        <p class="note">Para actualizarla: descarga el zip de nuevo, reemplaza la carpeta y pulsa el boton de recargar de ADACEEN en <code>chrome://extensions</code>.</p>`;
}

/** Paso 1 segun la tienda: principal (tienda + desplegable manual), atrasada, desconocida o sin tienda. */
function browserStepBody(store: ChromeWebStoreStatus | null, zipAvailable: boolean, zipDetail: string) {
  const mode = store?.mode || "desactivada";
  if (store && mode === "principal") {
    return `<p>Chrome, Edge y otros navegadores basados en Chromium la instalan desde la Chrome Web Store; en Firefox, ver mas abajo.</p>
        <div class="actions">
          ${storeButton(store.url, "Agregar ADACEEN a Chrome", `Chrome Web Store, version ${store.version}`)}
        </div>
        <ol class="steps">
          <li>Pulsa <strong>Agregar ADACEEN a Chrome</strong>: la ficha de ADACEEN se abre en una pestana nueva de la Chrome Web Store.</li>
          <li>Alli pulsa <strong>Agregar a Chrome</strong> y confirma con <strong>Agregar extension</strong>. En Edge acepta antes <strong>Permitir extensiones de otras tiendas</strong>.</li>
          <li>Vuelve a esta pestana: se recarga sola y en Estado veras la extension instalada. Desde la tienda se actualiza sola.</li>
        </ol>
        ${replaceManualNote()}
        <details class="manual" id="instalacion-manual">
          <summary>Instalacion manual con el zip (alternativa)</summary>
          <p>Solo si la tienda no abre en tu navegador o no te deja agregarla.</p>
          <div class="actions">
            ${zipActions(zipAvailable, zipDetail)}
          </div>
          ${zipSteps()}
        </details>`;
  }
  const intro = `<p>Funciona en Chrome, Edge y otros navegadores basados en Chromium; en Firefox, ver mas abajo.</p>`;
  if (store && mode === "atrasada") {
    return `${intro}
        <p class="note" id="tienda-atrasada">La Chrome Web Store todavia tiene la version ${escapeHtml(store.version)} de ADACEEN y la vigente es la ${escapeHtml(store.minimum)}. Mientras Google aprueba la nueva, instalala con el zip; cuando la tienda se ponga al dia, esta pagina te llevara alla.</p>
        <div class="actions">
          ${zipActions(zipAvailable, zipDetail)}
        </div>
        ${zipSteps()}`;
  }
  if (store && mode === "desconocida") {
    return `${intro}
        <div class="actions">
          ${storeButton(store.url, "Instalar desde Chrome Web Store", "Chrome y Edge, sin modo de desarrollador")}
          ${zipActions(zipAvailable, zipDetail)}
        </div>
        ${chromeWebStoreNote()}
        ${zipSteps()}`;
  }
  return `${intro}
        <div class="actions">
          ${zipActions(zipAvailable, zipDetail)}
        </div>
        ${zipSteps()}`;
}

function policyNote(policy: PolicyInfo) {
  const forcelist = `${policy.id};${policy.manifestUrl}`;
  return `<p class="note" id="politica-laboratorio"><strong>Instalacion por politica (equipos del laboratorio):</strong> en los equipos que administra Sistemas, Chrome y Edge instalan y actualizan ADACEEN solos con la politica <code>ExtensionInstallForcelist</code> y el valor <code>${escapeHtml(forcelist)}</code> (id de la extension <code>${escapeHtml(policy.id)}</code>; manifiesto de actualizacion <code>${escapeHtml(policy.manifestUrl)}</code>; paquete firmado <a href="${escapeHtml(DOWNLOADS.crx.path)}" download>adaceen.crx</a>). Como aplicarla: <code>docs/operacion/publicar-extension.md</code> del repositorio.</p>`;
}

function firefoxBlock(available: boolean, version: string) {
  if (available) {
    const detail = version ? `instalacion permanente, version ${version}` : "instalacion permanente";
    return `<div class="actions">${linkButton(DOWNLOADS.firefox.path, "Instalar en Firefox", detail)}</div>
        <p class="note">Firefox avisa que este sitio quiere instalar un complemento: pulsa <strong>Permitir</strong> y luego <strong>Agregar</strong>. Queda instalada de forma permanente (no hay que repetirlo al cerrar Firefox) y se actualiza sola. En Firefox no hay inicio de sesion con Google: entra con tu correo y contrasena.</p>`;
  }
  return `<p class="note">Firefox (128 o superior): este servidor todavia no publica el paquete firmado para instalarla de forma permanente. Pide a tu docente <code>adaceen-firefox-&lt;version&gt;.zip</code>, abre <code>about:debugging</code>, entra en <strong>Este Firefox</strong> y pulsa <strong>Cargar complemento temporal...</strong> con ese zip. Se quita al cerrar Firefox, asi que repitelo en cada sesion. Entra con tu correo y contrasena: no hay inicio de sesion con Google.</p>`;
}

export function renderStartPageHtml(input: PageInput) {
  const { nonce, available, versions } = input;
  const policy = input.policy || null;
  const store = input.store || null;
  const navegadorDetail = versions.navegador ? `zip, version ${versions.navegador}` : "zip";
  const vsixDetail = versions.vscode ? `VSIX, version ${versions.vscode}` : "VSIX";
  const macHref = available.macZip ? DOWNLOADS.macZip.path : DOWNLOADS.macCommand.path;
  const macAvailable = available.macZip || available.macCommand;

  return `<!doctype html>
<html lang="es" data-browser-ext-latest="${escapeHtml(versions.navegador)}" data-browser-ext-store="${escapeHtml(store?.mode === "principal" ? store.version : "")}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>ADACEEN - Empezar</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #172033;
        --muted: #4a5868;
        --panel: #ffffff;
        --line: #d5dee8;
        --accent: #0f766e;
        --accent-strong: #0b5f59;
        --accent-soft: #e3f7f3;
        --warn: #8a4b00;
        --warn-soft: #fff4e5;
        --bad: #a3242a;
        --bad-soft: #fdecec;
        --focus: #1d4ed8;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        color: var(--ink);
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 1rem;
        line-height: 1.55;
        background: #f6f8fb;
      }

      .skip {
        position: absolute;
        left: 12px;
        top: -48px;
        padding: 8px 12px;
        border-radius: 6px;
        background: var(--ink);
        color: #ffffff;
      }

      .skip:focus {
        top: 12px;
      }

      main {
        width: min(880px, calc(100% - 32px));
        margin: 0 auto;
        padding: 32px 0 56px;
      }

      header,
      section {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        padding: 20px;
        box-shadow: 0 10px 30px rgba(23, 32, 51, 0.06);
      }

      section {
        margin-top: 14px;
      }

      .eyebrow {
        margin: 0 0 6px;
        color: var(--accent-strong);
        font-size: 0.8rem;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      h1,
      h2 {
        margin: 0;
        line-height: 1.2;
      }

      h1 {
        font-size: clamp(1.7rem, 5vw, 2.5rem);
      }

      h2 {
        font-size: 1.15rem;
      }

      h3 {
        margin: 18px 0 0;
        font-size: 1rem;
        line-height: 1.3;
      }

      p,
      li {
        color: var(--muted);
      }

      .lead {
        margin: 12px 0 0;
        max-width: 720px;
      }

      a {
        color: var(--accent-strong);
        font-weight: 700;
      }

      a:focus-visible,
      button:focus-visible {
        outline: 3px solid var(--focus);
        outline-offset: 2px;
      }

      code {
        padding: 1px 5px;
        border-radius: 4px;
        background: #eef2f6;
        color: var(--ink);
        font-size: 0.95em;
        overflow-wrap: anywhere;
      }

      .status {
        display: grid;
        gap: 10px;
        margin: 14px 0 0;
        padding: 0;
        list-style: none;
      }

      .status li {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 6px 10px;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 10px 12px;
        color: var(--ink);
      }

      .badge {
        display: inline-block;
        min-width: 88px;
        border-radius: 999px;
        padding: 2px 10px;
        background: #eef2f6;
        color: var(--ink);
        font-size: 0.85rem;
        font-weight: 800;
        text-align: center;
      }

      .status li[data-state="ok"] {
        border-color: #b9e3dc;
        background: var(--accent-soft);
      }

      .status li[data-state="ok"] .badge {
        background: var(--accent-strong);
        color: #ffffff;
      }

      .status li[data-state="warn"] {
        border-color: #f0d4b7;
        background: var(--warn-soft);
      }

      .status li[data-state="warn"] .badge {
        background: var(--warn);
        color: #ffffff;
      }

      .status li[data-state="bad"] {
        border-color: #f2c4c6;
        background: var(--bad-soft);
      }

      .status li[data-state="bad"] .badge {
        background: var(--bad);
        color: #ffffff;
      }

      .status-text {
        flex: 1 1 260px;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin: 14px 0 0;
      }

      .button,
      button {
        display: inline-flex;
        flex-direction: column;
        justify-content: center;
        min-height: 44px;
        border: 0;
        border-radius: 8px;
        padding: 10px 16px;
        background: var(--accent-strong);
        color: #ffffff;
        font: inherit;
        font-weight: 800;
        text-decoration: none;
        cursor: pointer;
      }

      button.secondary {
        display: inline-flex;
        min-height: 36px;
        margin-left: 4px;
        padding: 4px 12px;
        border: 1px solid var(--accent-strong);
        background: #ffffff;
        color: var(--accent-strong);
      }

      .button-detail {
        font-size: 0.8rem;
        font-weight: 600;
        opacity: 0.9;
      }

      ol.steps {
        margin: 14px 0 0;
        padding-left: 24px;
      }

      ol.steps li {
        margin-bottom: 10px;
      }

      .note,
      .unavailable {
        margin: 12px 0 0;
        border-radius: 8px;
        padding: 10px 12px;
        background: #f1f5f9;
        font-size: 0.95rem;
      }

      .unavailable {
        background: var(--warn-soft);
        color: var(--ink);
      }

      #tienda-atrasada {
        background: var(--warn-soft);
        color: var(--ink);
      }

      details.manual {
        margin: 16px 0 0;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 0 14px;
      }

      details.manual[open] {
        padding-bottom: 14px;
      }

      details.manual > summary {
        display: flex;
        align-items: center;
        gap: 10px;
        min-height: 44px;
        padding: 8px 0;
        color: var(--ink);
        font-weight: 800;
        cursor: pointer;
        list-style: none;
      }

      details.manual > summary::-webkit-details-marker {
        display: none;
      }

      /* Con display: flex el navegador no dibuja el triangulo: se dibuja aqui. */
      details.manual > summary::before {
        content: "";
        flex: none;
        border-top: 5px solid transparent;
        border-bottom: 5px solid transparent;
        border-left: 7px solid var(--accent-strong);
        transition: transform 0.15s ease;
      }

      details.manual[open] > summary::before {
        transform: rotate(90deg);
      }

      details.manual > summary:focus-visible {
        outline: 3px solid var(--focus);
        outline-offset: 2px;
      }

      details.manual > p:first-of-type {
        margin-top: 0;
      }

      footer {
        margin-top: 18px;
        text-align: center;
        font-size: 0.9rem;
      }

      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        margin: -1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
        border: 0;
      }

      @media (max-width: 520px) {
        header,
        section {
          padding: 16px;
        }

        .button {
          width: 100%;
        }
      }
    </style>
  </head>
  <body>
    <a class="skip" href="#paso-navegador">Saltar a los pasos</a>
    <main>
      <header>
        <p class="eyebrow">ADACEEN</p>
        <h1>Empieza con ADACEEN</h1>
        <p class="lead">
          ADACEEN es tu tutor de programacion: te da pistas en GitHub y en VS Code sin resolverte el ejercicio.
          Haz el paso 1 una sola vez en cada navegador; lo demas lo prepara ADACEEN.
        </p>
      </header>

      <section aria-labelledby="estado-titulo">
        <h2 id="estado-titulo">Estado</h2>
        <ul class="status" aria-live="polite">
          <li id="estado-extension" data-state="checking">
            <span class="badge">Buscando</span>
            <span class="status-text"><strong>Extension del navegador:</strong> <span data-role="text">comprobando si esta instalada...</span></span>
          </li>
          <li id="estado-editor" data-state="checking">
            <span class="badge">Consultando</span>
            <span class="status-text"><strong>Editor en la nube:</strong> <span data-role="text">consultando el servicio...</span></span>
          </li>
          <li id="estado-modelo" data-state="checking">
            <span class="badge">Consultando</span>
            <span class="status-text"><strong>Tutor (modelo):</strong> <span data-role="text">consultando el servicio...</span></span>
          </li>
        </ul>
      </section>

      <section id="paso-navegador" aria-labelledby="paso-navegador-titulo">
        <h2 id="paso-navegador-titulo">1. Instala la extension del navegador</h2>
        ${browserStepBody(store, available.navegador, navegadorDetail)}
        ${policy ? policyNote(policy) : ""}
        <h3 id="paso-firefox-titulo">Firefox</h3>
        ${firefoxBlock(available.firefox, versions.navegador)}
      </section>

      <section aria-labelledby="paso-github-titulo">
        <h2 id="paso-github-titulo">2. Entra y abre tu editor</h2>
        <ol class="steps">
          <li>Abre tu repositorio del curso en <a href="https://github.com" rel="noreferrer">github.com</a> y pulsa el icono de ADACEEN en la barra del navegador. En Chrome, recien cargada, la extension queda dentro del menu de extensiones (el icono de <strong>pieza de rompecabezas</strong>): abrelo y pulsa ADACEEN, o fijala con el alfiler para tener el icono siempre a la vista.</li>
          <li>Inicia sesion con tu cuenta de ADACEEN. La primera vez lee la politica de privacidad y pulsa <strong>Aceptar y continuar</strong>.</li>
          <li>Pulsa <strong>Conectar GitHub</strong>. ADACEEN prepara tu editor y lo abre.</li>
          <li>La primera vez GitHub te pide un codigo de un solo uso para autorizar el editor. Otro dia basta con <strong>Abrir mi editor</strong>.</li>
        </ol>
      </section>

      <section aria-labelledby="paso-vscode-titulo">
        <h2 id="paso-vscode-titulo">3. VS Code en este equipo (opcional)</h2>
        <p>Solo si trabajas con VS Code instalado (por ejemplo, en las Mac del laboratorio). En el editor en la nube no hace falta.</p>
        <div class="actions">
          ${macAvailable ? downloadButton(macHref, "Preparar Mac del laboratorio", available.macZip ? "zip con el instalador" : "instalador") : unavailable("El instalador de Mac")}
          ${available.vsix ? downloadButton(DOWNLOADS.vsix.path, "Descargar extension de VS Code", vsixDetail) : unavailable("La extension de VS Code")}
        </div>
        <ol class="steps">
          <li><strong>Mac:</strong> descomprime el zip y haz doble clic en <code>Preparar-Mac-ADACEEN.command</code>. Si macOS no lo deja abrir, haz clic derecho sobre el archivo y elige <strong>Abrir</strong>; en macOS 15 o posterior ve a <strong>Ajustes del Sistema &rarr; Privacidad y seguridad</strong> y pulsa <strong>Abrir igualmente</strong>. Es una vez por equipo.</li>
          <li><strong>Otro equipo:</strong> en VS Code abre Extensiones, pulsa el menu <strong>...</strong> y elige <strong>Instalar desde VSIX</strong> con el archivo descargado.</li>
          <li>Para vincular VS Code con tu cuenta usa <strong>Abrir en VS Code de este equipo</strong> en el overlay, o en VS Code <strong>ADACEEN: Conectar</strong> con tu cuenta de GitHub.</li>
        </ol>
      </section>

      <footer>
        <a href="/privacy-policy">Politica de privacidad y seguridad</a>
      </footer>
      <p id="aviso" class="sr-only" aria-live="polite"></p>
    </main>
    <script nonce="${escapeHtml(nonce)}">
      (function () {
        "use strict";
        var VERSION_RE = /^\\d+(\\.\\d+){0,3}$/;
        var root = document.documentElement;
        var latest = root.getAttribute("data-browser-ext-latest") || "";
        // Con la tienda como camino principal (0.8.0), quien tiene la version de la tienda esta al
        // dia aunque el zip sea mas nuevo: la tienda se actualiza sola cuando Google aprueba.
        var storeVersion = root.getAttribute("data-browser-ext-store") || "";
        var extensionFound = false;
        // Tras abrir la tienda (otra pestana), al volver se recarga la pagina: el content
        // script de una extension recien agregada solo llega a las pestanas que se cargan despues.
        var STORE_FLAG = "adaceen-tienda-abierta";
        var storeLink = document.getElementById("boton-tienda");

        function storeOpened() {
          try {
            return window.sessionStorage.getItem(STORE_FLAG) === "1";
          } catch (error) {
            return false;
          }
        }

        function rememberStore(opened) {
          try {
            if (opened) window.sessionStorage.setItem(STORE_FLAG, "1");
            else window.sessionStorage.removeItem(STORE_FLAG);
          } catch (error) {
            // Sin sessionStorage la pagina no se recarga sola: el texto pide recargar.
          }
        }

        function setStatus(id, state, badge, text) {
          var item = document.getElementById(id);
          if (!item) return;
          item.setAttribute("data-state", state);
          item.querySelector(".badge").textContent = badge;
          item.querySelector("[data-role=text]").textContent = text;
        }

        function versionParts(value) {
          return String(value).split(".").map(function (part) { return Number(part) || 0; });
        }

        function isOlder(version, reference) {
          var a = versionParts(version);
          var b = versionParts(reference);
          for (var i = 0; i < Math.max(a.length, b.length); i += 1) {
            var diff = (a[i] || 0) - (b[i] || 0);
            if (diff !== 0) return diff < 0;
          }
          return false;
        }

        function showExtension(rawVersion) {
          var version = VERSION_RE.test(String(rawVersion || "")) ? String(rawVersion) : "";
          extensionFound = true;
          rememberStore(false);
          var reference = storeVersion && latest && isOlder(storeVersion, latest) ? storeVersion : latest;
          if (version && reference && isOlder(version, reference)) {
            setStatus("estado-extension", "warn", "Actualizar",
              "instalada (version " + version + "). Hay una version nueva (" + reference + "): si la cargaste con el zip, descargalo de nuevo, reemplaza la carpeta y recarga la extension; desde la tienda, Firefox o la politica del laboratorio se actualiza sola.");
            return;
          }
          setStatus("estado-extension", "ok", "Instalada", version ? "lista (version " + version + ")." : "lista.");
        }

        function readMarker() {
          var marker = root.dataset ? root.dataset.adaceenExtension : "";
          if (marker) showExtension(marker);
        }

        window.addEventListener("message", function (event) {
          if (event.source !== window || !event.data || event.data.type !== "adaceen:extension") return;
          showExtension(event.data.version);
        });
        readMarker();
        if (window.MutationObserver) {
          new MutationObserver(readMarker).observe(root, { attributes: true, attributeFilter: ["data-adaceen-extension"] });
        }
        window.setTimeout(function () {
          if (!extensionFound) {
            setStatus("estado-extension", "warn", "No detectada", storeOpened()
              ? "todavia no la vemos. Cuando termines en la Chrome Web Store vuelve a esta pestana: se recarga sola."
              : "no la encontramos en este navegador. Sigue el paso 1; si ya la instalaste, recarga esta pagina.");
          }
        }, 3000);

        if (storeLink) {
          storeLink.addEventListener("click", function () { rememberStore(true); });
          var reloadAfterStore = function () {
            if (!extensionFound && storeOpened() && document.visibilityState !== "hidden") window.location.reload();
          };
          document.addEventListener("visibilitychange", reloadAfterStore);
          window.addEventListener("pageshow", function (event) {
            if (event && event.persisted) reloadAfterStore();
          });
        }

        // /empezar#instalacion-manual abre el desplegable de la instalacion con el zip.
        var manual = document.getElementById("instalacion-manual");
        var openManualFromHash = function () {
          if (manual && window.location && window.location.hash === "#instalacion-manual") manual.open = true;
        };
        openManualFromHash();
        window.addEventListener("hashchange", openManualFromHash);

        function renderHealth(health) {
          var provider = String(health.workspace_provider || "");
          if (provider === "tunnel") {
            var online = health.workspace_agent_online === true;
            if (health.workspace_agent_transport === "relay" && online) {
              setStatus("estado-editor", "ok", "Encendido", "listo para preparar tu editor.");
            } else if (health.workspace_agent_transport === "relay" && health.workspace_vm_autostart === true) {
              setStatus("estado-editor", "ok", "En reposo", "apagado por ahora; se enciende solo cuando preparas tu editor (1-2 min).");
            } else if (health.workspace_agent_transport === "relay") {
              setStatus("estado-editor", "warn", "Apagado", "la VM de editores esta apagada. Avisa al docente.");
            } else {
              setStatus("estado-editor", "ok", "Configurado", "editor en la nube configurado.");
            }
          } else {
            setStatus("estado-editor", "ok", "Codespaces", "el editor se prepara con GitHub Codespaces desde el overlay.");
          }

          // Solo se alarma si el backend vio latidos y todos vencieron: sin
          // token de latidos, o recien reiniciado (el registro vive en
          // memoria), 0 equipos no significa que el tutor este caido.
          var alive = Number(health.model_workers_alive) || 0;
          if (health.mode === "queue" && alive > 0) {
            setStatus("estado-modelo", "ok", "Disponible", alive === 1 ? "1 equipo atendiendo." : alive + " equipos atendiendo.");
          } else if (health.mode === "queue" && health.model_workers_known_down === true) {
            setStatus("estado-modelo", "warn", "Sin equipos", "los equipos del modelo dejaron de responder; las respuestas pueden fallar. Avisa al docente.");
          } else if (health.mode === "queue") {
            setStatus("estado-modelo", "ok", "Configurado", "modelo configurado; todavia no hay latidos recientes de los equipos.");
          } else if (health.target_mode_valid === false) {
            setStatus("estado-modelo", "bad", "Revisar", "la configuracion del modelo no es valida. Avisa al docente.");
          } else {
            setStatus("estado-modelo", "ok", "Configurado", "modelo configurado.");
          }
        }

        function healthFailed() {
          setStatus("estado-editor", "bad", "Sin datos", "no se pudo consultar el servicio. Recarga en un momento.");
          setStatus("estado-modelo", "bad", "Sin datos", "no se pudo consultar el servicio. Recarga en un momento.");
        }

        if (window.fetch) {
          window.fetch("/api/health", { headers: { Accept: "application/json" }, cache: "no-store", credentials: "omit" })
            .then(function (response) { return response.ok ? response.json() : Promise.reject(new Error("HTTP " + response.status)); })
            .then(renderHealth, healthFailed);
        } else {
          healthFailed();
        }

        Array.prototype.forEach.call(document.querySelectorAll("[data-copy]"), function (button) {
          button.addEventListener("click", function () {
            var value = button.getAttribute("data-copy") || "";
            var aviso = document.getElementById("aviso");
            var done = function (ok) {
              button.textContent = ok ? "Copiado" : "Copialo a mano";
              if (aviso) aviso.textContent = ok ? "Direccion copiada. Pegala en una pestana nueva." : "No se pudo copiar; escribela a mano.";
              window.setTimeout(function () { button.textContent = "Copiar direccion"; }, 2500);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(value).then(function () { done(true); }, function () { done(false); });
            } else {
              done(false);
            }
          });
        });
      })();
    </script>
  </body>
</html>`;
}

function renderMissingDownloadHtml(fileName: string) {
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ADACEEN - Descarga no disponible</title>
    <style>
      body { margin: 0; color: #172033; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f6f8fb; line-height: 1.55; }
      main { width: min(640px, calc(100% - 32px)); margin: 48px auto; padding: 22px; border: 1px solid #d5dee8; border-radius: 8px; background: #ffffff; }
      h1 { margin: 0 0 8px; font-size: 1.4rem; }
      p { color: #4a5868; }
      a { color: #0b5f59; font-weight: 700; }
      code { overflow-wrap: anywhere; }
    </style>
  </head>
  <body>
    <main>
      <h1>Esta descarga todavia no esta disponible</h1>
      <p>El archivo <code>${escapeHtml(fileName)}</code> no esta publicado en este servidor. Avisa al docente; mientras tanto puedes volver a la pagina de inicio.</p>
      <p><a href="/empezar">Volver a Empezar con ADACEEN</a></p>
    </main>
  </body>
</html>`;
}

function setPageSecurityHeaders(res: express.Response, nonce = "") {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; script-src ${nonce ? `'nonce-${nonce}'` : "'none'"}; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
}

/**
 * Version mas vieja de la extension de la tienda con la que este backend sigue funcionando
 * (0.8.0 se publico con la tienda en 0.7.22: el backend acepta las dos). Subirla cuando un cambio
 * del backend deje de servir a las anteriores.
 */
export const STORE_COMPATIBLE_MIN_VERSION = "0.7.22";

/** La menor de dos versiones ("" si falta la primera: sin zip no hay version que exigir). */
export function lowerExtensionVersion(latest: string, floor: string) {
  const a = cleanExtensionVersion(latest);
  const b = cleanExtensionVersion(floor);
  if (!a) return "";
  if (!b) return a;
  return compareExtensionVersions(a, b) <= 0 ? a : b;
}

export function registerStartPageRoutes(app: express.Express, deps: StartPageDeps = {}) {
  const rootDir = () => path.resolve(deps.rootDir || process.cwd());

  // deps.chromeWebStoreUrl ya viene decidida ("" = sin tienda); la variable pasa por
  // resolveChromeWebStoreUrl (vacia = la del id conocido, "off" = sin tienda).
  const chromeWebStoreUrl = () => deps.chromeWebStoreUrl !== undefined
    ? cleanChromeWebStoreUrl(deps.chromeWebStoreUrl)
    : resolveChromeWebStoreUrl(env.chromeWebStoreUrl);
  const readStoreVersion = deps.readStoreVersion || createStoreVersionReader();

  async function storeStatus(latest: string) {
    const url = chromeWebStoreUrl();
    // Sin CHROME_WEB_STORE_MIN_VERSION, la tienda es el camino principal si tiene la version del
    // zip o, aunque sea anterior, una que todavia funciona con este backend
    // (STORE_COMPATIBLE_MIN_VERSION): mientras Google aprueba la nueva, el estudiante instala la
    // de la tienda (que se actualiza sola) en vez del zip en modo de desarrollador.
    const configured = cleanExtensionVersion(deps.chromeWebStoreMinVersion ?? env.chromeWebStoreMinVersion);
    const minimum = configured || lowerExtensionVersion(latest, STORE_COMPATIBLE_MIN_VERSION);
    if (!url) return describeChromeWebStore({ url, version: "", minimum });
    const id = extensionIdFromStoreUrl(url) || CHROME_WEB_STORE_ID;
    const version = await readStoreVersion(id).catch(() => "");
    return describeChromeWebStore({ url, version, minimum });
  }

  app.get("/empezar", async (_req, res) => {
    const root = rootDir();
    const files = Object.fromEntries(
      (Object.keys(DOWNLOADS) as DownloadKey[]).map((key) => [key, resolveDownloadFile(root, key)]),
    ) as Record<DownloadKey, string>;
    const available = Object.fromEntries(
      (Object.keys(files) as DownloadKey[]).map((key) => [key, Boolean(files[key])]),
    ) as Record<DownloadKey, boolean>;
    // La nota de politica solo con el CRX y un manifiesto legible: lo que Chrome va a pedir.
    const policy = available.crx && available.actualizacion ? readUpdateManifest(files.actualizacion) : null;
    const versions = readDownloadVersions(root);
    const store = await storeStatus(versions.navegador);
    const nonce = randomBytes(16).toString("base64");
    setPageSecurityHeaders(res, nonce);
    res.send(renderStartPageHtml({ nonce, available, versions, policy, store }));
  });

  // Para Preparar-Mac-ADACEEN.command: solo agrega la extension de la tienda a Chrome si la
  // tienda es el camino principal (no instala una version atrasada en las Mac del laboratorio).
  app.get("/api/extension/chrome-web-store", async (_req, res) => {
    const versions = readDownloadVersions(rootDir());
    const store = await storeStatus(versions.navegador);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.json({
      mode: store.mode,
      store_url: store.url,
      store_id: store.id,
      store_version: store.version,
      minimum_version: store.minimum,
      latest_version: versions.navegador,
      update_url: store.url ? CHROME_WEB_STORE_UPDATE_URL : "",
    });
  });

  const byPath = new Map(Object.entries(DOWNLOADS).map(([key, spec]) => [spec.path, key as DownloadKey]));
  app.get(Object.values(DOWNLOADS).map((spec) => spec.path), (req, res) => {
    const key = byPath.get(req.path);
    const spec = key ? DOWNLOADS[key] : null;
    const filePath = key ? resolveDownloadFile(rootDir(), key) : "";
    if (!spec || !filePath) {
      setPageSecurityHeaders(res);
      return res.status(404).send(renderMissingDownloadHtml(spec?.fileName || "solicitado"));
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    // root = carpeta del archivo: send solo revisa el nombre (no la ruta completa) contra dotfiles.
    return res.sendFile(path.basename(filePath), {
      root: path.dirname(filePath),
      headers: {
        "Content-Type": spec.contentType,
        "Content-Disposition": `${spec.disposition || "attachment"}; filename="${spec.fileName}"`,
        // Siempre se revalida: al desplegar una version nueva se descarga la nueva.
        "Cache-Control": "no-cache",
      },
    }, (error) => {
      if (error && !res.headersSent) {
        setPageSecurityHeaders(res);
        res.status(404).send(renderMissingDownloadHtml(spec.fileName));
      }
    });
  });
}
