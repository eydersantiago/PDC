// ADACEEN en Chrome Web Store: id del elemento, pagina de la tienda y version publicada.
//
// /empezar y GET /api/extension/chrome-web-store usan la version publicada para decidir
// si la tienda es el camino principal de instalacion o si todavia esta atrasada respecto
// al zip (docs/operacion/publicar-extension.md, 1.7). La version sale del mismo "update
// check" que usa Chrome para actualizar las extensiones de la tienda:
//
//   GET https://clients2.google.com/service/update2/crx?response=updatecheck&acceptformat=crx3
//       &prodversion=<chrome>&x=id%3D<id>%26uc
//   -> <app appid="<id>" status="ok"><updatecheck status="ok" version="0.7.22" .../></app>
//
// Sin respuesta, con error o con un estado distinto de "ok", la version queda desconocida
// ("") y la pagina muestra la tienda y el zip por igual.

// El campo key de browser-ext-prod/manifest.json da este mismo id: la carpeta del zip y la
// tienda son la misma extension (prueba en tests/services/chrome-web-store.test.ts).
export const CHROME_WEB_STORE_ID = "gkkcnlcbdjdjcibkkbhpopichconbojg";
export const CHROME_WEB_STORE_UPDATE_URL = "https://clients2.google.com/service/update2/crx";
export const DEFAULT_CHROME_WEB_STORE_URL = `https://chromewebstore.google.com/detail/${CHROME_WEB_STORE_ID}`;

// Version de Chrome que se anuncia en la consulta: la tienda solo responde con versiones que
// esa version de Chrome puede instalar (minimum_chrome_version del manifest).
const PRODUCT_VERSION = "141.0.0.0";

const EXTENSION_ID_RE = /^[a-p]{32}$/;
const VERSION_RE = /^\d+(\.\d+){0,3}$/;
// Solo la tienda de Chrome, en https: cualquier otra cosa en la variable se ignora.
const STORE_URL_RE = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com)\/[^\s"'<>]*$/;
// CHROME_WEB_STORE_URL con alguno de estos valores apaga la tienda en /empezar.
const DISABLED_VALUES = new Set(["off", "no", "0", "false", "desactivada", "ninguna"]);

export function cleanChromeWebStoreUrl(value: string | undefined) {
  const text = (value || "").trim();
  return STORE_URL_RE.test(text) ? text : "";
}

/**
 * Pagina de la tienda que ofrece /empezar: la de CHROME_WEB_STORE_URL si es de la tienda,
 * la del id conocido si la variable esta vacia, o ninguna ("") si la variable la apaga o
 * trae otra cosa.
 */
export function resolveChromeWebStoreUrl(value: string | undefined) {
  const text = (value ?? "").trim();
  if (!text) return DEFAULT_CHROME_WEB_STORE_URL;
  if (DISABLED_VALUES.has(text.toLowerCase())) return "";
  return cleanChromeWebStoreUrl(text);
}

/** Id del elemento dentro de la URL de la tienda (/detail/<nombre>/<id> o /detail/<id>). */
export function extensionIdFromStoreUrl(url: string) {
  const segments = url.split(/[?#]/)[0].split("/").filter(Boolean);
  const last = segments[segments.length - 1] || "";
  return EXTENSION_ID_RE.test(last) ? last : "";
}

export function cleanExtensionVersion(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return VERSION_RE.test(text) ? text : "";
}

export function compareExtensionVersions(left: string, right: string) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function chromeWebStoreUpdateCheckUrl(extensionId: string) {
  const query = new URLSearchParams({
    response: "updatecheck",
    acceptformat: "crx3",
    prodversion: PRODUCT_VERSION,
    x: `id=${extensionId}&uc`,
  });
  return `${CHROME_WEB_STORE_UPDATE_URL}?${query.toString()}`;
}

function attribute(tag: string, name: string) {
  return tag.match(new RegExp(`\\s${name}=['"]([^'"]*)['"]`))?.[1] || "";
}

/**
 * Version publicada segun la respuesta XML del update check, o "" si el elemento no
 * existe, no esta disponible para esa version de Chrome o la respuesta no se entiende.
 */
export function parseStoreUpdateResponse(xml: string, extensionId: string) {
  const apps = xml.match(/<app\b[^>]*>[\s\S]*?(<\/app>|$)/g) || [];
  for (const app of apps) {
    const openTag = app.match(/<app\b[^>]*>/)?.[0] || "";
    if (attribute(openTag, "appid") !== extensionId) continue;
    const appStatus = attribute(openTag, "status");
    if (appStatus && appStatus !== "ok") return "";
    const check = app.match(/<updatecheck\b[^>]*>/)?.[0] || "";
    if (attribute(check, "status") !== "ok") return "";
    return cleanExtensionVersion(attribute(check, "version"));
  }
  return "";
}

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export type StoreVersionReaderOptions = {
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Cuanto se guarda una version leida (por defecto 15 minutos). */
  okTtlMs?: number;
  /** Cuanto se espera para reintentar tras un fallo (por defecto 2 minutos). */
  failTtlMs?: number;
  /** Tope de la consulta: /empezar la espera, asi que es corto (por defecto 3 s). */
  timeoutMs?: number;
};

export type StoreVersionReader = (extensionId: string) => Promise<string>;

/**
 * Lector con cache por id: una sola consulta en vuelo a la vez, version leida durante
 * okTtlMs y, tras un fallo, la ultima version buena (si la hubo) durante failTtlMs.
 */
export function createStoreVersionReader(options: StoreVersionReaderOptions = {}): StoreVersionReader {
  const fetchImpl = options.fetchImpl || (globalThis.fetch as unknown as FetchLike);
  const now = options.now || Date.now;
  const okTtlMs = options.okTtlMs ?? 15 * 60_000;
  const failTtlMs = options.failTtlMs ?? 2 * 60_000;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const cache = new Map<string, { version: string; expiresAt: number; lastGood: string }>();
  const inFlight = new Map<string, Promise<string>>();

  async function lookup(extensionId: string) {
    const previous = cache.get(extensionId);
    let version = "";
    try {
      const response = await fetchImpl(chromeWebStoreUpdateCheckUrl(extensionId), {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: "application/xml" },
      });
      if (response.ok) version = parseStoreUpdateResponse(await response.text(), extensionId);
    } catch {
      version = "";
    }
    if (version) {
      cache.set(extensionId, { version, expiresAt: now() + okTtlMs, lastGood: version });
      return version;
    }
    const lastGood = previous?.lastGood || "";
    cache.set(extensionId, { version: lastGood, expiresAt: now() + failTtlMs, lastGood });
    return lastGood;
  }

  return async (extensionId: string) => {
    if (!EXTENSION_ID_RE.test(extensionId)) return "";
    const cached = cache.get(extensionId);
    if (cached && cached.expiresAt > now()) return cached.version;
    const pending = inFlight.get(extensionId);
    if (pending) return pending;
    const request = lookup(extensionId).finally(() => inFlight.delete(extensionId));
    inFlight.set(extensionId, request);
    return request;
  };
}

export type ChromeWebStoreMode = "principal" | "atrasada" | "desconocida" | "desactivada";

export type ChromeWebStoreStatus = {
  mode: ChromeWebStoreMode;
  url: string;
  id: string;
  /** Version publicada en la tienda ("" si no se pudo leer). */
  version: string;
  /** Version que debe tener la tienda para ser el camino principal ("" = cualquiera). */
  minimum: string;
};

/**
 * Como se ofrece la tienda en /empezar:
 *   principal    la tienda tiene la version minima (o mas nueva): boton principal, zip de alternativa
 *   atrasada     la tienda tiene una version anterior: el zip es el camino principal
 *   desconocida  no se pudo leer la version: tienda y zip por igual
 *   desactivada  sin pagina de la tienda: solo el zip
 */
export function describeChromeWebStore(input: { url: string; version: string; minimum: string }): ChromeWebStoreStatus {
  const url = input.url;
  const id = url ? extensionIdFromStoreUrl(url) || CHROME_WEB_STORE_ID : "";
  const version = cleanExtensionVersion(input.version);
  const minimum = cleanExtensionVersion(input.minimum);
  if (!url) return { mode: "desactivada", url: "", id: "", version: "", minimum };
  if (!version) return { mode: "desconocida", url, id, version: "", minimum };
  if (minimum && compareExtensionVersions(version, minimum) < 0) return { mode: "atrasada", url, id, version, minimum };
  return { mode: "principal", url, id, version, minimum };
}
