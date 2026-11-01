// Descargas de /empezar: archivos publicados (zip, CRX, XPI, VSIX, instalador de Mac) y el manifiesto de actualizacion.
import fs from "node:fs";
import path from "node:path";

export type DownloadKey = "navegador" | "crx" | "actualizacion" | "firefox" | "vsix" | "macZip" | "macCommand";

export type DownloadSpec = {
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

export const DOWNLOADS: Record<DownloadKey, DownloadSpec> = {
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
