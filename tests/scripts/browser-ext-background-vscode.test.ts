import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

/**
 * background.js y la sesion de vscode.dev (navegador 0.8.2): «Entrar con <cuenta>» en el aviso de
 * vscode.dev pide ADACEEN_RESET_VSCODE_SESSION. El service worker real en node:vm con chrome.tabs y
 * chrome.browsingData falsos: solo vscode.dev, solo URLs de un tunel y siempre de vuelta al editor.
 */

type Json = Record<string, unknown>;

function loadBackground(options: { browsingData?: Json | null } = {}) {
  const log: string[] = [];
  let onMessage: ((message: Json, sender: Json, sendResponse: (response: Json) => void) => unknown) | null = null;
  const updatedListeners = new Set<(tabId: number, info: Json) => void>();
  const chrome: Json = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener: (listener: typeof onMessage) => { onMessage = listener; } },
      getManifest: () => ({ version: "0.8.2" }),
    },
    action: { onClicked: { addListener() {} } },
    identity: {},
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    tabs: {
      sendMessage: async () => ({}),
      captureVisibleTab() {},
      update: async (tabId: number, props: { url: string }) => {
        log.push(`tabs.update ${tabId} ${props.url}`);
        // El navegador termina de cargar y avisa.
        setTimeout(() => updatedListeners.forEach((listener) => listener(tabId, { status: "complete" })), 5);
        return {};
      },
      onUpdated: {
        addListener: (listener: (tabId: number, info: Json) => void) => updatedListeners.add(listener),
        removeListener: (listener: (tabId: number, info: Json) => void) => updatedListeners.delete(listener),
      },
    },
    scripting: { executeScript: async () => [] },
  };
  if (options.browsingData !== null) {
    chrome.browsingData = options.browsingData || {
      remove: async (filter: Json, types: Json) => {
        log.push(`browsingData.remove ${JSON.stringify(filter)} ${Object.keys(types).sort().join(",")}`);
      },
    };
  }
  const source = fs.readFileSync(path.resolve(process.cwd(), "browser-ext-prod/background.js"), "utf8");
  const context = vm.createContext({ chrome, fetch: async () => ({}), URL, URLSearchParams, setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} } });
  vm.runInContext(source, context, { filename: "background.js" });
  const send = (message: Json, sender: Json = { tab: { id: 7 } }) => {
    let response: Json | null = null;
    onMessage!(message, sender, (value: Json) => { response = JSON.parse(JSON.stringify(value)); });
    return response as Json | null;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
  return { send, log, settle };
}

const EDITOR = "https://vscode.dev/tunnel/ad-alumno/home/ws-alumno/taller-1?vscode-lang=es-us";

test("0.8.2: borra solo los datos de vscode.dev, despues de salir de la pagina, y vuelve al editor", async () => {
  const bg = loadBackground();
  assert.deepEqual(bg.send({ type: "ADACEEN_RESET_VSCODE_SESSION", origin: "https://vscode.dev", url: EDITOR }), { ok: true });
  assert.deepEqual(bg.log, [], "responde antes de mover la pestana");
  await bg.settle();
  assert.deepEqual(bg.log, [
    "tabs.update 7 about:blank",
    'browsingData.remove {"origins":["https://vscode.dev"]} cacheStorage,cookies,fileSystems,indexedDB,localStorage,serviceWorkers',
    `tabs.update 7 ${EDITOR}`,
  ]);
});

test("0.8.2: se niega fuera de un tunel de vscode.dev y sin browsingData", async () => {
  const bg = loadBackground();
  for (const message of [
    { origin: "https://github.com", url: "https://github.com/login" },
    { origin: "https://vscode.dev", url: "https://vscode.dev/github/alumno/repo" },
    { origin: "https://vscode.dev", url: "https://evil.example/tunnel/x" },
    { origin: "https://insiders.vscode.dev", url: EDITOR },
  ]) {
    const response = bg.send({ type: "ADACEEN_RESET_VSCODE_SESSION", ...message });
    assert.equal(response?.ok, false, JSON.stringify(message));
  }
  await bg.settle();
  assert.deepEqual(bg.log, [], "nada se borra ni se navega");
  const without = loadBackground({ browsingData: null });
  assert.match(String(without.send({ type: "ADACEEN_RESET_VSCODE_SESSION", origin: "https://vscode.dev", url: EDITOR })?.error), /no deja borrar/);
});

test("0.8.2: Firefox (sin origins) borra por nombre de host; si todo falla, la pestana igual vuelve al editor", async () => {
  const calls: string[] = [];
  const firefox = loadBackground({
    browsingData: {
      remove: async (filter: Json) => {
        calls.push(JSON.stringify(filter));
        if ("origins" in filter) throw new Error("Type error for parameter options: Unexpected property \"origins\"");
      },
    },
  });
  firefox.send({ type: "ADACEEN_RESET_VSCODE_SESSION", origin: "https://vscode.dev", url: EDITOR });
  await firefox.settle();
  assert.deepEqual(calls, ['{"origins":["https://vscode.dev"]}', '{"hostnames":["vscode.dev"]}']);
  assert.equal(firefox.log.at(-1), `tabs.update 7 ${EDITOR}`);

  const broken = loadBackground({ browsingData: { remove: async () => { throw new Error("fallo"); } } });
  broken.send({ type: "ADACEEN_RESET_VSCODE_SESSION", origin: "https://vscode.dev", url: EDITOR });
  await broken.settle();
  assert.deepEqual(broken.log, ["tabs.update 7 about:blank", `tabs.update 7 ${EDITOR}`]);
});
