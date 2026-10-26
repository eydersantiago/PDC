import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  CHROME_WEB_STORE_ID,
  DEFAULT_CHROME_WEB_STORE_URL,
  chromeWebStoreUpdateCheckUrl,
  createStoreVersionReader,
  describeChromeWebStore,
  extensionIdFromStoreUrl,
  parseStoreUpdateResponse,
  resolveChromeWebStoreUrl,
} from "../../src/services/chrome-web-store.js";
import { compareExtensionVersions } from "../../src/services/extension-version.js";

/**
 * Version de ADACEEN en Chrome Web Store (src/services/chrome-web-store.ts): con ella
 * /empezar decide si la tienda es el camino principal o si sigue el zip.
 */

function idFromKey(key: string) {
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((char) => String.fromCharCode(97 + parseInt(char, 16))).join("");
}

function updateXml(version: string, options: { appStatus?: string; checkStatus?: string; appid?: string } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0" server="prod">
  <daystart elapsed_days="7230" elapsed_seconds="51000"/>
  <app appid="${options.appid || CHROME_WEB_STORE_ID}" cohort="1::" status="${options.appStatus || "ok"}">
    <updatecheck codebase="https://clients2.googleusercontent.com/crx/blobs/x/ADACEEN.crx" fp="1.abc" hash_sha256="abc" protected="0" size="123456" status="${options.checkStatus || "ok"}" version="${version}"/>
  </app>
</gupdate>`;
}

test("tienda: el id conocido es el que da el campo key del manifest (zip y tienda son la misma extension)", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "browser-ext-prod", "manifest.json"), "utf8"));
  assert.equal(idFromKey(manifest.key), CHROME_WEB_STORE_ID);
  assert.equal(DEFAULT_CHROME_WEB_STORE_URL, `https://chromewebstore.google.com/detail/${CHROME_WEB_STORE_ID}`);
});

test("tienda: URL de la variable (vacia = la del id conocido, off = sin tienda) e id dentro de la URL", () => {
  assert.equal(resolveChromeWebStoreUrl(undefined), DEFAULT_CHROME_WEB_STORE_URL);
  assert.equal(resolveChromeWebStoreUrl("  "), DEFAULT_CHROME_WEB_STORE_URL);
  for (const off of ["off", "OFF", "no", "0", "desactivada"]) assert.equal(resolveChromeWebStoreUrl(off), "", off);
  const custom = "https://chromewebstore.google.com/detail/adaceen/abcdefghijklmnopabcdefghijklmnop";
  assert.equal(resolveChromeWebStoreUrl(custom), custom);
  assert.equal(resolveChromeWebStoreUrl("https://ejemplo.test/adaceen"), "", "otra pagina no es la tienda");

  assert.equal(extensionIdFromStoreUrl(custom), "abcdefghijklmnopabcdefghijklmnop");
  assert.equal(extensionIdFromStoreUrl(`${DEFAULT_CHROME_WEB_STORE_URL}?hl=es-419`), CHROME_WEB_STORE_ID);
  assert.equal(extensionIdFromStoreUrl("https://chromewebstore.google.com/detail/adaceen"), "");
});

test("tienda: la consulta es el update check de Google con el id codificado en x", () => {
  const url = new URL(chromeWebStoreUpdateCheckUrl(CHROME_WEB_STORE_ID));
  assert.equal(url.origin + url.pathname, "https://clients2.google.com/service/update2/crx");
  assert.equal(url.searchParams.get("response"), "updatecheck");
  assert.equal(url.searchParams.get("acceptformat"), "crx3");
  assert.equal(url.searchParams.get("x"), `id=${CHROME_WEB_STORE_ID}&uc`);
  assert.match(url.search, /x=id%3Dgkkcnlcbdjdjcibkkbhpopichconbojg%26uc/);
});

test("tienda: lee la version solo de una respuesta ok del mismo id", () => {
  assert.equal(parseStoreUpdateResponse(updateXml("0.7.22"), CHROME_WEB_STORE_ID), "0.7.22");
  assert.equal(parseStoreUpdateResponse(updateXml("0.7.22").replace(/"/g, "'"), CHROME_WEB_STORE_ID), "0.7.22", "comillas simples");
  assert.equal(parseStoreUpdateResponse(updateXml("", { checkStatus: "noupdate" }), CHROME_WEB_STORE_ID), "");
  assert.equal(parseStoreUpdateResponse(updateXml("0.7.22", { appStatus: "error-unknownApplication" }), CHROME_WEB_STORE_ID), "");
  assert.equal(parseStoreUpdateResponse(updateXml("0.7.22", { appid: "abcdefghijklmnopabcdefghijklmnop" }), CHROME_WEB_STORE_ID), "");
  assert.equal(parseStoreUpdateResponse(updateXml("<script>"), CHROME_WEB_STORE_ID), "");
  assert.equal(parseStoreUpdateResponse("<html>Error 502</html>", CHROME_WEB_STORE_ID), "");
  assert.ok(compareExtensionVersions("0.7.22", "0.7.3") > 0);
  assert.ok(compareExtensionVersions("0.7.2", "0.7.22") < 0);
  assert.equal(compareExtensionVersions("0.7.22", "0.7.22.0"), 0);
});

test("tienda: el lector guarda la version, no repite consultas en vuelo y tras un fallo conserva la ultima buena", async () => {
  let clock = 1_000;
  const calls: string[] = [];
  const replies: Array<() => Promise<{ ok: boolean; status: number; text(): Promise<string> }>> = [];
  const reader = createStoreVersionReader({
    now: () => clock,
    okTtlMs: 1_000,
    failTtlMs: 100,
    fetchImpl: async (url, init) => {
      calls.push(url);
      assert.ok(init?.signal, "la consulta lleva tope de tiempo");
      const next = replies.shift();
      if (!next) throw new Error("sin respuesta preparada");
      return next();
    },
  });

  assert.equal(await reader("no-es-un-id"), "", "un id invalido no consulta");
  assert.equal(calls.length, 0);

  replies.push(async () => ({ ok: true, status: 200, text: async () => updateXml("0.7.22") }));
  const [first, second] = await Promise.all([reader(CHROME_WEB_STORE_ID), reader(CHROME_WEB_STORE_ID)]);
  assert.equal(first, "0.7.22");
  assert.equal(second, "0.7.22");
  assert.equal(calls.length, 1, "una sola consulta en vuelo");
  assert.match(calls[0], /x=id%3Dgkkcnlcbdjdjcibkkbhpopichconbojg%26uc/);

  clock += 500;
  assert.equal(await reader(CHROME_WEB_STORE_ID), "0.7.22");
  assert.equal(calls.length, 1, "dentro del plazo usa la cache");

  clock += 600;
  replies.push(async () => { throw new TypeError("fetch failed"); });
  assert.equal(await reader(CHROME_WEB_STORE_ID), "0.7.22", "sin red conserva la ultima version buena");
  assert.equal(calls.length, 2);

  clock += 50;
  assert.equal(await reader(CHROME_WEB_STORE_ID), "0.7.22");
  assert.equal(calls.length, 2, "tras un fallo espera failTtlMs para reintentar");

  clock += 100;
  replies.push(async () => ({ ok: true, status: 200, text: async () => updateXml("0.7.23") }));
  assert.equal(await reader(CHROME_WEB_STORE_ID), "0.7.23");

  const fresh = createStoreVersionReader({
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => "no" }),
  });
  assert.equal(await fresh(CHROME_WEB_STORE_ID), "", "sin version buena previa queda desconocida");
});

test("tienda: modo segun la version publicada y la minima", () => {
  const url = DEFAULT_CHROME_WEB_STORE_URL;
  assert.deepEqual(describeChromeWebStore({ url: "", version: "0.7.22", minimum: "0.7.22" }), {
    mode: "desactivada", url: "", id: "", version: "", minimum: "0.7.22",
  });
  assert.equal(describeChromeWebStore({ url, version: "", minimum: "0.7.22" }).mode, "desconocida");
  assert.equal(describeChromeWebStore({ url, version: "0.7.22", minimum: "0.7.22" }).mode, "principal");
  assert.equal(describeChromeWebStore({ url, version: "0.7.23", minimum: "0.7.22" }).mode, "principal");
  assert.equal(describeChromeWebStore({ url, version: "0.7.2", minimum: "" }).mode, "principal", "sin minima basta con que haya version");
  const behind = describeChromeWebStore({ url, version: "0.7.2", minimum: "0.7.22" });
  assert.deepEqual(behind, { mode: "atrasada", url, id: CHROME_WEB_STORE_ID, version: "0.7.2", minimum: "0.7.22" });
  assert.equal(
    describeChromeWebStore({ url: "https://chromewebstore.google.com/detail/adaceen", version: "0.7.22", minimum: "" }).id,
    CHROME_WEB_STORE_ID,
    "una URL sin id usa el id conocido",
  );
});
