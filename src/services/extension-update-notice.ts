// Aviso de version nueva de la extension del navegador, desde el backend (29-10-2026).
//
// La extension instalada no tiene como enterarse de que hay otra version: la 0.8.5 y las
// anteriores ni siquiera le dicen su version al backend. Lo que si muestran todas es la respuesta
// del tutor (/intervene). Entonces, cuando quien pide ayuda tiene una version anterior a la que
// puede instalar, el backend le agrega a esa respuesta una linea con como actualizar.
//
//   - Version del cliente: la cabecera x-adaceen-client-version (desde la 0.8.6). Sin cabecera
//     es la 0.8.5 o anterior (LEGACY_BROWSER_EXTENSION_VERSION).
//   - Version a la que se invita: la que la Chrome Web Store tiene publicada (la que Chrome
//     instala sola); sin tienda, la del zip publicado. Si la tienda no responde, no se avisa (no
//     se invita a una version que quiza no se puede bajar).
//   - Una vez cada 30 min por persona: no tapa al tutor.
//   - EXTENSION_UPDATE_NOTICE=off lo apaga.
import { env, isOffSwitch } from "../config/env.js";
import {
  CHROME_WEB_STORE_ID,
  createStoreVersionReader,
  extensionIdFromStoreUrl,
  resolveChromeWebStoreUrl,
  type StoreVersionReader,
} from "./chrome-web-store.js";
import { readDownloadVersionsCached } from "./download-versions.js";
import { cleanExtensionVersion, compareExtensionVersions } from "./extension-version.js";

/** La ultima version que no manda x-adaceen-client-version. */
export const LEGACY_BROWSER_EXTENSION_VERSION = "0.8.5";
export const UPDATE_NOTICE_INTERVAL_MS = 30 * 60 * 1000;
const MAX_TRACKED = 5000;

/**
 * Version a la que conviene invitar ("" si no se sabe: entonces no se avisa). Con tienda, la que
 * la tienda publica (la que Chrome instala; mientras Google revisa la nueva, la tienda sigue con
 * la anterior y no se invita a una que no se puede bajar). Sin tienda, la del zip publicado.
 */
export function browserExtensionTarget(input: { storeUrl: string; storeVersion: string; zipVersion: string }) {
  if (!input.storeUrl) return cleanExtensionVersion(input.zipVersion);
  return cleanExtensionVersion(input.storeVersion);
}

/** La version del cliente segun la cabecera; sin cabecera valida, la ultima que no la mandaba. */
export function clientBrowserExtensionVersion(header: string | undefined | null) {
  return cleanExtensionVersion(header ?? "") || LEGACY_BROWSER_EXTENSION_VERSION;
}

export function buildUpdateNoticeText(target: string, startPageUrl: string) {
  return `Hay una versión nueva de ADACEEN (${target}). Si la instalaste desde la Chrome Web Store, Chrome la pone sola en unas horas; para tenerla ya, abre chrome://extensions, activa «Modo de desarrollador» y pulsa «Actualizar». Si la cargaste con el zip, bájala de nuevo en ${startPageUrl}.`;
}

export type ExtensionUpdateNotifier = {
  /** El texto del aviso para esta persona ahora, o "" (al dia, ya avisada hace poco, o apagado). */
  noticeFor(input: { actorKey: string; clientVersionHeader: string | undefined; startPageUrl: string; now?: number }): Promise<string>;
};

export function createExtensionUpdateNotifier(options: {
  /** Version a la que se invita; por defecto la de la tienda y el zip publicado (con cache). */
  target?: () => Promise<string>;
  rootDir?: string;
  readStoreVersion?: StoreVersionReader;
  enabled?: () => boolean;
} = {}): ExtensionUpdateNotifier {
  const readStoreVersion = options.readStoreVersion || createStoreVersionReader();
  const rootDir = options.rootDir || process.cwd();
  // Dentro de `node --test` (NODE_TEST_CONTEXT) el aviso por defecto queda apagado: la version
  // de la tienda cambia sola cuando Google aprueba una nueva y no debe cambiar lo que responden
  // las pruebas del tutor en el workflow de despliegue. Sus pruebas lo encienden con `enabled`.
  const enabled = options.enabled || (() => !process.env.NODE_TEST_CONTEXT
    && !isOffSwitch(env.extensionUpdateNotice));
  const target = options.target || (async () => {
    const storeUrl = resolveChromeWebStoreUrl(env.chromeWebStoreUrl);
    const id = storeUrl ? extensionIdFromStoreUrl(storeUrl) || CHROME_WEB_STORE_ID : "";
    const storeVersion = id ? await readStoreVersion(id).catch(() => "") : "";
    return browserExtensionTarget({ storeUrl, storeVersion, zipVersion: readDownloadVersionsCached(rootDir).navegador });
  });
  const lastShown = new Map<string, number>();

  return {
    async noticeFor({ actorKey, clientVersionHeader, startPageUrl, now = Date.now() }) {
      if (!enabled() || !actorKey) return "";
      const previous = lastShown.get(actorKey);
      if (previous !== undefined && now - previous < UPDATE_NOTICE_INTERVAL_MS) return "";
      const wanted = cleanExtensionVersion(await target().catch(() => ""));
      if (!wanted) return "";
      if (compareExtensionVersions(clientBrowserExtensionVersion(clientVersionHeader), wanted) >= 0) return "";
      if (lastShown.size >= MAX_TRACKED) {
        for (const [key, at] of lastShown) if (now - at >= UPDATE_NOTICE_INTERVAL_MS) lastShown.delete(key);
        if (lastShown.size >= MAX_TRACKED) lastShown.clear();
      }
      lastShown.set(actorKey, now);
      return buildUpdateNoticeText(wanted, startPageUrl);
    },
  };
}

/**
 * La respuesta de /intervene con el aviso al final del saludo (lo que muestran todas las
 * versiones del overlay). No toca la respuesta original: las caches de respuestas la reusan.
 */
export function withUpdateNotice<T extends Record<string, unknown>>(reply: T, notice: string): T {
  if (!notice) return reply;
  const result = reply.result && typeof reply.result === "object" ? reply.result as Record<string, unknown> : null;
  if (!result) return reply;
  const welcome = typeof result.welcome_message === "string" ? result.welcome_message.trim() : "";
  return {
    ...reply,
    extension_update: { notice },
    // Con espacio y no con salto de linea: el overlay muestra el saludo como texto corrido.
    result: { ...result, welcome_message: welcome ? `${welcome} ${notice}` : notice },
  };
}
