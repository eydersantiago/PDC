import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { lowerExtensionVersion, STORE_COMPATIBLE_MIN_VERSION } from "../../../src/routes/pages/start-page-routes.js";
import { startPage, tempRoot, write, inlineScript } from "./helpers.js";

// DOM minimo para ejecutar el script de /empezar sin navegador.
type PageScriptOptions = {
  latest: string;
  marker?: string;
  health?: unknown;
  healthFails?: boolean;
  /** Pagina con el boton «Agregar ADACEEN a Chrome» (id boton-tienda). */
  store?: boolean;
  /** sessionStorage compartido entre cargas de la pagina; "falla" = el navegador lo bloquea. */
  storage?: Map<string, string> | "falla";
  /** Desplegable #instalacion-manual y el hash de la direccion. */
  manual?: boolean;
  hash?: string;
};

function runPageScript(code: string, options: PageScriptOptions) {
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
  const clicks: Array<() => void> = [];
  if (options.store) {
    elements["boton-tienda"] = {
      addEventListener: (type: string, listener: () => void) => {
        if (type === "click") clicks.push(listener);
      },
    };
  }
  const manual = { open: false };
  if (options.manual) elements["instalacion-manual"] = manual;
  const documentListeners: Array<() => void> = [];
  let reloads = 0;
  const storage = options.storage;
  const sessionStorage = {
    getItem: (key: string) => {
      if (storage === "falla") throw new Error("SecurityError");
      return storage?.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (storage === "falla") throw new Error("SecurityError");
      storage?.set(key, value);
    },
    removeItem: (key: string) => {
      if (storage === "falla") throw new Error("SecurityError");
      storage?.delete(key);
    },
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
    sessionStorage,
    location: { hash: options.hash || "", reload: () => { reloads += 1; } },
    fetch: () => options.healthFails
      ? Promise.reject(new TypeError("sin red"))
      : Promise.resolve({ ok: true, json: () => Promise.resolve(options.health || {}) }),
  };
  fakeWindow.window = fakeWindow;
  const fakeDocument = {
    documentElement: root,
    visibilityState: "visible",
    getElementById: (id: string) => elements[id] || null,
    querySelectorAll: () => [],
    addEventListener: (type: string, listener: () => void) => {
      if (type === "visibilitychange") documentListeners.push(listener);
    },
  };
  const context = vm.createContext({
    window: fakeWindow,
    document: fakeDocument,
    navigator: {},
  });
  vm.runInContext(code, context);
  return {
    items,
    post: (data: unknown, source: unknown = fakeWindow) => listeners.forEach((listener) => listener({ source, data })),
    runTimers: () => timers.splice(0).forEach((callback) => callback()),
    clickStore: () => clicks.forEach((listener) => listener()),
    setVisibility: (state: "visible" | "hidden") => {
      fakeDocument.visibilityState = state;
      documentListeners.forEach((listener) => listener());
    },
    reloads: () => reloads,
    manual,
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

test("/empezar: al volver de la tienda recarga la pagina hasta detectar la extension; #instalacion-manual abre el desplegable", async () => {
  const root = await tempRoot();
  const page = await startPage(root);
  try {
    const { code } = inlineScript(await fetch(`${page.baseUrl}/empezar`).then((response) => response.text()));

    // Pulsa «Agregar ADACEEN a Chrome»: al irse a la tienda no recarga; al volver, si.
    const storage = new Map<string, string>();
    const first = runPageScript(code, { latest: "0.7.22", store: true, storage });
    first.setVisibility("visible");
    assert.equal(first.reloads(), 0, "sin pasar por la tienda no recarga");
    first.clickStore();
    first.setVisibility("hidden");
    assert.equal(first.reloads(), 0);
    first.setVisibility("visible");
    assert.equal(first.reloads(), 1, "vuelve de la tienda: recarga para que llegue el content script");

    // Recargada sin extension todavia: lo dice y vuelve a recargar en el siguiente regreso.
    const second = runPageScript(code, { latest: "0.7.22", store: true, storage });
    second.runTimers();
    assert.equal(second.items["estado-extension"].state, "warn");
    assert.match(second.items["estado-extension"].text, /vuelve a esta pestana: se recarga sola/);
    second.setVisibility("visible");
    assert.equal(second.reloads(), 1);

    // Recargada con la extension: estado listo y ya no recarga mas.
    const third = runPageScript(code, { latest: "0.7.22", store: true, storage, marker: "0.7.22" });
    assert.equal(third.items["estado-extension"].state, "ok");
    assert.equal(storage.size, 0, "olvida que se abrio la tienda");
    third.setVisibility("visible");
    assert.equal(third.reloads(), 0);

    // El navegador bloquea sessionStorage: no falla ni recarga, y el texto pide recargar.
    const blocked = runPageScript(code, { latest: "0.7.22", store: true, storage: "falla" });
    assert.doesNotThrow(() => blocked.clickStore());
    blocked.setVisibility("visible");
    assert.equal(blocked.reloads(), 0);
    blocked.runTimers();
    assert.match(blocked.items["estado-extension"].text, /recarga esta pagina/);

    // Enlace directo a la instalacion manual.
    assert.equal(runPageScript(code, { latest: "", manual: true, hash: "#instalacion-manual" }).manual.open, true);
    assert.equal(runPageScript(code, { latest: "", manual: true }).manual.open, false);
  } finally {
    await page.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("/empezar 0.8.0: con el zip mas nuevo y la tienda en una version compatible, la tienda sigue siendo el camino principal", async () => {
  const root = await tempRoot();
  await write(root, "descargas/adaceen-navegador.zip", "zip");
  await write(root, "descargas/versiones.json", JSON.stringify({ navegador: "0.8.0", vscode: "0.0.33" }));
  const storeUrl = "https://chromewebstore.google.com/detail/gkkcnlcbdjdjcibkkbhpopichconbojg";
  let storeVersion = "0.7.22";
  const page = await startPage(root, { chromeWebStoreUrl: storeUrl, readStoreVersion: async () => storeVersion });
  try {
    // Mientras Google aprueba la 0.8.0, la 0.7.22 de la tienda funciona con este backend.
    const html = await fetch(`${page.baseUrl}/empezar`).then((response) => response.text());
    assert.match(html, /Agregar ADACEEN a Chrome<span class="button-detail">Chrome Web Store, version 0\.7\.22<\/span>/);
    assert.match(html, /data-browser-ext-latest="0\.8\.0" data-browser-ext-store="0\.7\.22"/, "quien tiene la de la tienda no ve «Actualizar»");
    const status = await fetch(`${page.baseUrl}/api/extension/chrome-web-store`).then((response) => response.json()) as { mode: string; minimum_version: string; latest_version: string };
    assert.deepEqual({ mode: status.mode, minimum: status.minimum_version, latest: status.latest_version }, { mode: "principal", minimum: STORE_COMPATIBLE_MIN_VERSION, latest: "0.8.0" });
    // Una version de la tienda que ya no sirve con este backend manda el zip.
    storeVersion = "0.7.21";
    const behind = await fetch(`${page.baseUrl}/empezar`).then((response) => response.text());
    assert.doesNotMatch(behind.match(/<section id="paso-navegador"[\s\S]*?<\/section>/)?.[0] || "", /boton-tienda/);
    assert.match(behind, /data-browser-ext-store=""/);
  } finally {
    await page.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("/empezar 0.8.0: la version minima de la tienda es la menor entre el zip y la compatible", () => {
  assert.equal(lowerExtensionVersion("0.8.0", "0.7.22"), "0.7.22");
  assert.equal(lowerExtensionVersion("0.7.22", "0.7.22"), "0.7.22");
  assert.equal(lowerExtensionVersion("0.7.21", "0.7.22"), "0.7.21", "un zip anterior exige solo su version");
  assert.equal(lowerExtensionVersion("", "0.7.22"), "", "sin zip no se exige version");
});
