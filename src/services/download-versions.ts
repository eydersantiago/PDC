// Versiones de lo que se descarga (extension de navegador y de VS Code): las publica el
// workflow en descargas/versiones.json; en desarrollo salen de los manifiestos del repositorio.
// Las leen la pagina /empezar, /api/extension/chrome-web-store y la guia del tunel (que compara
// la extension de VS Code del editor con la publicada).
import fs from "node:fs";
import path from "node:path";
import { cleanExtensionVersion } from "./extension-version.js";

/** Solo lectura: la version en cache es el mismo objeto para todos los que la piden. */
export type DownloadVersions = Readonly<{ navegador: string; vscode: string }>;

/** La guia del tunel pregunta cada 5 s por estudiante: el disco se lee a lo sumo una vez por minuto. */
export const DOWNLOAD_VERSIONS_CACHE_MS = 60_000;

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Versiones de lo que se descarga: descargas/versiones.json (lo escribe el
 * workflow) o, en desarrollo, los manifiestos del repositorio.
 */
export function readDownloadVersions(rootDir: string): DownloadVersions {
  const published = readJsonFile(path.resolve(rootDir, "descargas/versiones.json"));
  const manifest = published ? null : readJsonFile(path.resolve(rootDir, "browser-ext-prod/manifest.json"));
  const vscodePackage = published ? null : readJsonFile(path.resolve(rootDir, "vscode-ext-prod/package.json"));
  return Object.freeze({
    navegador: cleanExtensionVersion(published?.navegador ?? manifest?.version),
    vscode: cleanExtensionVersion(published?.vscode ?? vscodePackage?.version),
  });
}

const cachedVersions = new Map<string, { readAt: number; versions: DownloadVersions }>();

/** readDownloadVersions con cache por carpeta: un despliegue nuevo se ve en menos de un minuto. */
export function readDownloadVersionsCached(rootDir: string, now = Date.now()): DownloadVersions {
  const key = path.resolve(rootDir);
  const cached = cachedVersions.get(key);
  if (cached && now - cached.readAt >= 0 && now - cached.readAt < DOWNLOAD_VERSIONS_CACHE_MS) {
    return cached.versions;
  }
  const versions = readDownloadVersions(key);
  cachedVersions.set(key, { readAt: now, versions });
  return versions;
}

/** Solo las pruebas. */
export function clearDownloadVersionsCache() {
  cachedVersions.clear();
}
