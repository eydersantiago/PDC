import vm from "node:vm";
import { OVERLAY_SCRIPTS, SOURCES, type Json, type Listener } from "./harness-config.js";
import { FakeElement, FakeDocument, FakePopup } from "./harness-dom.js";
import type { FakeBrowser } from "./harness-backend.js";

// ---- Una pestana: contexto vm con window/document/location propios ----

export class TabEnv {
  document: FakeDocument;
  window: Record<string, any>;
  context: vm.Context;
  popups: FakePopup[] = [];
  openedLinks: string[] = [];
  windowListeners = new Map<string, Listener[]>();
  shadowListeners = new Map<string, Listener[]>();
  missingShadowIds = new Set<string>();
  logs: string[] = [];

  constructor(readonly browser: FakeBrowser, readonly url: string, title = "GitHub") {
    this.document = new FakeDocument(this, title);
    const parsed = new URL(url);
    const location = {
      href: parsed.href,
      origin: parsed.origin,
      protocol: parsed.protocol,
      host: parsed.host,
      hostname: parsed.hostname,
      pathname: parsed.pathname,
      search: parsed.search,
      hash: parsed.hash,
      reload() {},
      assign() {},
      replace() {},
    };
    const clock = browser.clock;
    const env = this;
    const quietConsole = {
      log: () => {},
      info: () => {},
      debug: () => {},
      warn: (...args: unknown[]) => env.logs.push(args.map(String).join(" ")),
      error: (...args: unknown[]) => env.logs.push(args.map(String).join(" ")),
    };
    this.window = {
      location,
      innerWidth: 1280,
      innerHeight: 800,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 1,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clear,
      setInterval: clock.setInterval,
      clearInterval: clock.clear,
      requestAnimationFrame: (fn: (time: number) => void) => clock.setTimeout(() => fn(clock.now), 16),
      cancelAnimationFrame: clock.clear,
      getSelection: () => ({ toString: () => "", rangeCount: 0, isCollapsed: true }),
      getComputedStyle: () => ({ getPropertyValue: () => "", display: "block", visibility: "visible", opacity: "1" }),
      confirm: () => true,
      open: (targetUrl?: string) => {
        const popup = new FakePopup(env, String(targetUrl || "about:blank"));
        env.popups.push(popup);
        return popup;
      },
      postMessage: (data: unknown, targetOrigin: string) => {
        env.dispatchWindowEvent("message", { data, origin: location.origin, source: env.window, targetOrigin });
      },
      addEventListener: (type: string, listener: Listener) => {
        const list = env.windowListeners.get(type) || [];
        list.push(listener);
        env.windowListeners.set(type, list);
      },
      removeEventListener: (type: string, listener: Listener) => {
        env.windowListeners.set(type, (env.windowListeners.get(type) || []).filter((item) => item !== listener));
      },
    };
    const globals: Record<string, unknown> = {
      ...this.window,
      window: this.window,
      self: this.window,
      document: this.document,
      navigator: {
        userAgent: "Mozilla/5.0 (Macintosh) Chrome/130.0 Safari/537.36",
        language: "es-CO",
        languages: ["es-CO", "es"],
        clipboard: { writeText: async (text: string) => { browser.clipboard.push(String(text)); } },
      },
      chrome: browser.chromeFor(),
      fetch: (input: unknown, init?: any) => browser.fetch(input, init),
      console: quietConsole,
      URL,
      URLSearchParams,
      AbortController,
      TextEncoder,
      // Subir la bitacora (0.7.16) arma un FormData con el archivo.
      FormData,
      File,
      Blob,
      structuredClone,
      crypto: globalThis.crypto,
      HTMLElement: FakeElement,
      HTMLAnchorElement: FakeElement,
      Element: FakeElement,
      Node: FakeElement,
      MouseEvent: FakeMouseEvent,
      queueMicrotask,
    };
    this.context = vm.createContext(globals);
    // Los scripts ven window.* y los mismos globales sueltos (setTimeout, location...); Date.now
    // sigue al reloj virtual.
    vm.runInContext("Date.now = () => __virtualNow();", Object.assign(this.context, { __virtualNow: () => clock.now }));
  }

  dispatchWindowEvent(type: string, event: Json) {
    return Promise.all((this.windowListeners.get(type) || []).map((listener) => listener(event)));
  }

  load(files: string[] = OVERLAY_SCRIPTS) {
    for (const rel of files) {
      vm.runInContext(SOURCES.get(rel)!, this.context, { filename: rel });
    }
    return this;
  }

  run<T = any>(code: string): T {
    return vm.runInContext(code, this.context) as T;
  }

  state() {
    return this.run<Record<string, any>>("overlayState");
  }

  el(id: string): FakeElement {
    return this.run("overlayEls")?.[id];
  }
}

// Evento de mouse de la simulacion (los content scripts lo crean con new MouseEvent).
class FakeMouseEvent {
  [key: string]: unknown;
  constructor(readonly type: string, init: Json = {}) {
    Object.assign(this, init);
  }
}
