// Rutas de /empezar, /api/extension/chrome-web-store y /descargas/*; el HTML esta en start-page-html.ts y los archivos en start-page-downloads.ts.
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
// Chrome Web Store (src/services/extensions/chrome-web-store.ts): si la tienda ya tiene la
// version del zip (o CHROME_WEB_STORE_MIN_VERSION), el paso 1 es «Agregar ADACEEN a
// Chrome» y el zip queda como instalacion manual en un desplegable; si la tienda esta
// atrasada, manda el zip; si no se pudo consultar, salen los dos por igual.
// CHROME_WEB_STORE_URL cambia la pagina de la tienda ("off" la quita).
// La extension de navegador avisa que esta instalada con un content script
// propio: window.postMessage({ type: "adaceen:extension", version }) y/o
// document.documentElement.dataset.adaceenExtension = version.
import { randomBytes } from "node:crypto";
import path from "node:path";
import type express from "express";
import { env } from "../../config/env.js";
import {
  CHROME_WEB_STORE_ID,
  CHROME_WEB_STORE_UPDATE_URL,
  cleanChromeWebStoreUrl,
  createStoreVersionReader,
  describeChromeWebStore,
  extensionIdFromStoreUrl,
  resolveChromeWebStoreUrl,
  type StoreVersionReader,
} from "../../services/extensions/chrome-web-store.js";
import { readDownloadVersions } from "../../services/extensions/download-versions.js";
import { describeGpuAutostart } from "../../services/infra/gpu-autostart.js";
import { cleanExtensionVersion, compareExtensionVersions } from "../../services/extensions/extension-version.js";
import { type DownloadKey, DOWNLOADS, resolveDownloadFile, readUpdateManifest } from "./start-page-downloads.js";
import { renderStartPageHtml, renderMissingDownloadHtml } from "./start-page-html.js";

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
    const gpu = describeGpuAutostart();
    const schedule = gpu.schedule_text ? { text: gpu.schedule_text, autostart: gpu.enabled } : null;
    const nonce = randomBytes(16).toString("base64");
    setPageSecurityHeaders(res, nonce);
    res.send(renderStartPageHtml({ nonce, available, versions, policy, store, schedule }));
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
