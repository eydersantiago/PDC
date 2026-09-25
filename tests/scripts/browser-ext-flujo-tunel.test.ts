import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/**
 * Simulacion del acceso simplificado con el proveedor "tunnel"
 * (docs/arquitectura/acceso-simplificado.md, seccion 4): se cargan los content scripts
 * REALES de la extension (orden de manifest.json) en node:vm con un chrome, un DOM y un
 * backend falsos y un reloj virtual. Cubre:
 *  - primera vez sin GitHub App: Conectar GitHub -> OAuth -> prepare (VM apagada,
 *    reintentable) -> codigo de dispositivo en una sola pestana -> editor listo;
 *  - volver otro dia: el overlay entra solo (sin "Empezar" ni pedir ayuda al tutor) y
 *    "Abrir mi editor" consulta status y abre;
 *  - "Abrir en VS Code de este equipo" y "Copiar sesion" con codigo de un solo uso;
 *  - la pagina /empezar detecta la extension.
 */

const EXT_ROOT = fileURLToPath(new URL("../../browser-ext-prod/", import.meta.url));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, "manifest.json"), "utf8"));
const OVERLAY_SCRIPTS: string[] = MANIFEST.content_scripts[0].js;
const SOURCES = new Map<string, string>(
  [...OVERLAY_SCRIPTS, "inicio/pagina-inicio.content.js"].map((rel) => [rel, fs.readFileSync(path.join(EXT_ROOT, rel), "utf8")]),
);

const BACKEND = "https://app-adaceen-api-eyder05232002.azurewebsites.net";
const REPO = "univalle-fpoo/taller-1";
const TUNNEL_URL = "https://vscode.dev/tunnel/ws-alumno/home/ws-alumno/taller-1";
const SESSION = {
  id: "sess-browser-1",
  user: {
    id: "u-alumno",
    role: "student",
    email: "alumno@correounivalle.edu.co",
    displayName: "Alumno Prueba",
    assignedCourseCodes: ["FPOO"],
  },
};

type Json = Record<string, unknown>;
type Listener = (event: any) => unknown;

// ---- Reloj virtual: los temporizadores solo corren cuando la prueba avanza el tiempo ----

class VirtualClock {
  now = Date.parse("2026-09-25T13:00:00.000Z");
  private seq = 0;
  private timers = new Map<number, { due: number; fn: (...args: unknown[]) => unknown; args: unknown[]; every: number }>();

  setTimeout = (fn: (...args: unknown[]) => unknown, ms?: number, ...args: unknown[]) => {
    const id = ++this.seq;
    this.timers.set(id, { due: this.now + Math.max(0, Number(ms) || 0), fn, args, every: 0 });
    return id;
  };

  setInterval = (fn: (...args: unknown[]) => unknown, ms?: number, ...args: unknown[]) => {
    const id = ++this.seq;
    const every = Math.max(1, Number(ms) || 1);
    this.timers.set(id, { due: this.now + every, fn, args, every });
    return id;
  };

  clear = (id: unknown) => {
    this.timers.delete(Number(id));
  };

  async settle() {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
  }

  async step() {
    let nextId = 0;
    let next: { due: number; fn: (...args: unknown[]) => unknown; args: unknown[]; every: number } | undefined;
    for (const [id, timer] of this.timers) {
      if (!next || timer.due < next.due) {
        next = timer;
        nextId = id;
      }
    }
    if (!next) return false;
    this.now = Math.max(this.now, next.due);
    if (next.every) next.due = this.now + next.every;
    else this.timers.delete(nextId);
    try {
      await next.fn(...next.args);
    } catch {
      // Un temporizador que falla no detiene la simulacion (igual que en el navegador).
    }
    await this.settle();
    return true;
  }

  async until(predicate: () => boolean, maxSteps = 4000) {
    await this.settle();
    for (let i = 0; i < maxSteps; i++) {
      if (predicate()) return true;
      if (!(await this.step())) break;
    }
    return predicate();
  }
}

// ---- DOM minimo ----

class FakeClassList {
  private items = new Set<string>();
  add(...names: string[]) { names.forEach((name) => this.items.add(name)); }
  remove(...names: string[]) { names.forEach((name) => this.items.delete(name)); }
  contains(name: string) { return this.items.has(name); }
  toggle(name: string, force?: boolean) {
    const on = force === undefined ? !this.items.has(name) : force;
    if (on) this.items.add(name);
    else this.items.delete(name);
    return on;
  }
}

class FakeElement {
  tagName: string;
  id = "";
  hidden = false;
  disabled = false;
  value = "";
  href = "";
  rel = "";
  type = "";
  title = "";
  className = "";
  innerText = "";
  scrollTop = 0;
  checked = false;
  tabIndex = 0;
  files: unknown[] = [];
  children: FakeElement[] = [];
  parentNode: FakeElement | FakeShadowRoot | null = null;
  dataset: Record<string, string> = {};
  style: Record<string, unknown> = { setProperty() {}, removeProperty() {} };
  classList = new FakeClassList();
  listeners = new Map<string, Listener[]>();
  attributes = new Map<string, string>();
  shadow: FakeShadowRoot | null = null;
  private text = "";
  private html = "";

  constructor(tagName: string, readonly env: TabEnv) {
    this.tagName = tagName.toUpperCase();
  }

  get textContent() { return this.text; }
  set textContent(value: string) {
    this.text = String(value ?? "");
    this.children = [];
  }
  get innerHTML() { return this.html; }
  set innerHTML(value: string) {
    this.html = String(value ?? "");
    this.children = [];
  }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get parentElement(): FakeElement | null { return this.parentNode instanceof FakeElement ? this.parentNode : null; }
  get isConnected(): boolean {
    let node: FakeElement | FakeShadowRoot | null = this.parentNode;
    while (node) {
      if (node === this.env.document.documentElement) return true;
      node = node instanceof FakeShadowRoot ? node.host : node.parentNode;
    }
    return this === this.env.document.documentElement;
  }
  get offsetWidth() { return 320; }
  get offsetHeight() { return 480; }
  get clientWidth() { return 320; }
  get clientHeight() { return 480; }
  get isContentEditable() { return false; }

  appendChild(child: FakeElement) {
    if (child instanceof FakeFragment) {
      child.children.forEach((item) => this.appendChild(item));
      child.children = [];
      return child;
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...nodes: unknown[]) {
    nodes.forEach((node) => {
      if (node instanceof FakeElement) this.appendChild(node);
      else this.text += String(node ?? "");
    });
  }
  prepend(...nodes: unknown[]) { this.append(...nodes); }
  insertBefore(child: FakeElement) { return this.appendChild(child); }
  replaceChildren(...nodes: unknown[]) {
    this.children = [];
    this.append(...nodes);
  }
  removeChild(child: FakeElement) {
    this.children = this.children.filter((item) => item !== child);
    child.parentNode = null;
    return child;
  }
  remove() {
    const parent = this.parentNode;
    if (parent) parent.children = parent.children.filter((item) => item !== this);
    this.parentNode = null;
  }
  cloneNode() { return new FakeElement(this.tagName, this.env); }
  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, String(value));
    if (name === "id") this.id = String(value);
    if (name === "hidden") this.hidden = true;
  }
  getAttribute(name: string) { return this.attributes.has(name) ? this.attributes.get(name)! : null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  removeAttribute(name: string) {
    this.attributes.delete(name);
    if (name === "hidden") this.hidden = false;
  }
  toggleAttribute(name: string, force?: boolean) {
    const on = force === undefined ? !this.attributes.has(name) : force;
    if (on) this.attributes.set(name, "");
    else this.attributes.delete(name);
    return on;
  }
  addEventListener(type: string, listener: Listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== listener));
  }
  dispatch(type: string, extra: Json = {}) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      button: 0,
      key: "",
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
      ...extra,
    };
    return Promise.all((this.listeners.get(type) || []).map((listener) => listener(event)));
  }
  click() {
    if (this.tagName === "A" && this.href) this.env.openedLinks.push(this.href);
    return this.dispatch("click");
  }
  focus() { this.env.document.activeElement = this; }
  blur() {}
  scrollIntoView() {}
  matches() { return false; }
  closest() { return null; }
  contains(node: unknown) { return node === this; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getElementsByTagName() { return []; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 320, bottom: 480, width: 320, height: 480, x: 0, y: 0 }; }
  getClientRects() { return []; }
  attachShadow() {
    this.shadow = new FakeShadowRoot(this, this.env);
    return this.shadow;
  }
  select() {}
  setSelectionRange() {}
}

class FakeFragment extends FakeElement {}

// Raiz de sombra: el markup se guarda tal cual y cada id pedido se crea al vuelo. Un id que
// no aparece en el markup queda en env.missingShadowIds (en el navegador seria null): asi un
// id mal escrito no pasa inadvertido.
class FakeShadowRoot {
  children: FakeElement[] = [];
  byId = new Map<string, FakeElement>();
  activeElement: FakeElement | null = null;
  private markup = "";
  constructor(readonly host: FakeElement, private env: TabEnv) {}
  get innerHTML() { return this.markup; }
  set innerHTML(value: string) { this.markup = String(value ?? ""); }
  getElementById(id: string) {
    if (!this.markup.includes(`id="${id}"`)) this.env.missingShadowIds.add(id);
    let element = this.byId.get(id);
    if (!element) {
      element = new FakeElement("div", this.env);
      element.id = id;
      element.parentNode = this;
      this.byId.set(id, element);
    }
    return element;
  }
  appendChild(child: FakeElement) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  addEventListener(type: string, listener: Listener) {
    const list = this.env.shadowListeners.get(type) || [];
    list.push(listener);
    this.env.shadowListeners.set(type, list);
  }
  removeEventListener() {}
  contains(node: unknown) { return node instanceof FakeElement && [...this.byId.values()].includes(node); }
}

class FakeDocument {
  documentElement: FakeElement;
  body: FakeElement;
  head: FakeElement;
  activeElement: FakeElement;
  title: string;
  visibilityState = "visible";
  readyState = "complete";
  listeners = new Map<string, Listener[]>();
  written = "";

  constructor(private env: TabEnv, title: string) {
    this.title = title;
    this.documentElement = new FakeElement("html", env);
    this.body = new FakeElement("body", env);
    this.head = new FakeElement("head", env);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }
  createElement(tag: string) { return new FakeElement(tag, this.env); }
  createDocumentFragment() { return new FakeFragment("#fragment", this.env); }
  createTextNode(text: string) {
    const node = new FakeElement("#text", this.env);
    node.textContent = text;
    return node;
  }
  getElementById(id: string): FakeElement | null {
    const search = (node: FakeElement): FakeElement | null => {
      if (node.id === id) return node;
      for (const child of node.children) {
        const found = search(child);
        if (found) return found;
      }
      return null;
    };
    return search(this.documentElement);
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getElementsByTagName() { return []; }
  addEventListener(type: string, listener: Listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener() {}
  hasFocus() { return true; }
  getSelection() { return { toString: () => "", rangeCount: 0, isCollapsed: true }; }
  open() { this.written = ""; }
  write(html: string) { this.written += html; }
  close() {}
}

// Ventana abierta con window.open: documento propio mientras siga en about:blank; al navegar
// a otro origen document y opener dejan de ser accesibles, como en el navegador.
class FakePopup {
  closed = false;
  hrefs: string[] = [];
  private doc: FakePopupDocument;
  private openerRef: unknown;

  constructor(env: TabEnv, url: string) {
    this.doc = new FakePopupDocument(env);
    this.openerRef = env.window;
    this.hrefs.push(url || "about:blank");
  }
  get currentHref() { return this.hrefs[this.hrefs.length - 1]; }
  private get sameOrigin() { return this.currentHref === "about:blank"; }
  get location(): { href: string; assign(value: string): void; replace(value: string): void } {
    const popup = this;
    return {
      get href() { return popup.currentHref; },
      set href(value: string) { popup.hrefs.push(String(value)); },
      assign(value: string) { popup.hrefs.push(String(value)); },
      replace(value: string) { popup.hrefs.push(String(value)); },
    };
  }
  set location(value: { href: string } | string) { this.hrefs.push(typeof value === "string" ? value : value.href); }
  get document() {
    if (!this.sameOrigin) throw new Error("SecurityError: Blocked a frame from accessing a cross-origin frame.");
    return this.doc;
  }
  get opener() { return this.openerRef; }
  set opener(value: unknown) {
    if (!this.sameOrigin) throw new Error("SecurityError: Blocked a frame from accessing a cross-origin frame.");
    this.openerRef = value;
  }
  get navigator() { return { clipboard: { writeText: async () => {} } }; }
  close() { this.closed = true; }
  focus() {}
  postMessage() {}
}

class FakePopupDocument {
  byId = new Map<string, FakeElement>();
  written = "";
  constructor(private env: TabEnv) {}
  open() { this.written = ""; this.byId.clear(); }
  write(html: string) { this.written += html; }
  close() {}
  getElementById(id: string) {
    let element = this.byId.get(id);
    if (!element) {
      element = new FakeElement("div", this.env);
      element.id = id;
      this.byId.set(id, element);
    }
    return element;
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  addEventListener() {}
  createElement(tag: string) { return new FakeElement(tag, this.env); }
}

// ---- Navegador compartido: storage de la extension, backend falso y reloj ----

type WorkspaceStep = Json;

class FakeBrowser {
  clock = new VirtualClock();
  storage: Record<string, unknown> = {};
  storageListeners: Array<(changes: Json, area: string) => void> = [];
  requests: Array<{ method: string; path: string; body: Json | null; headers: Record<string, string>; at: number }> = [];
  // Retraso de respuesta por ruta (ms del reloj virtual).
  delays: Record<string, number> = {};
  // Emparejamiento: "ok", "missing" (backend anterior, 404) o "fail" (fallo pasajero, 503).
  pairingMode: "ok" | "missing" | "fail" = "ok";
  // Estado HTTP de /api/workspaces/provider (200 responde el proveedor).
  providerStatus = 200;
  unknownRoutes: string[] = [];
  clipboard: string[] = [];
  githubConnected = false;
  prepareSteps: WorkspaceStep[] = [];
  statusSteps: WorkspaceStep[] = [];
  lastWorkspace: WorkspaceStep | null = null;
  sessionValid = true;
  pairingCodes = 0;
  // Estado de la GitHub App: por defecto sin instalar (el tunel no la necesita).
  appStatus: Json = { configured: true, installation: null, hasRepoAccess: null, bootstrapReady: false };
  provider = "tunnel";
  // Ultimo rack publicado por VS Code (GET /api/projects/session/state).
  latestRack: Json | null = null;

  chromeFor() {
    const browser = this;
    const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value));
    const pick = (keys: unknown) => {
      const list = keys == null ? Object.keys(browser.storage) : Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys as Json);
      const out: Json = {};
      for (const key of list as string[]) {
        if (Object.prototype.hasOwnProperty.call(browser.storage, key)) out[key] = clone(browser.storage[key]);
      }
      return out;
    };
    const notify = (changes: Json) => {
      if (!Object.keys(changes).length) return;
      for (const listener of [...browser.storageListeners]) {
        browser.clock.setTimeout(() => listener(clone(changes), "local"), 0);
      }
    };
    return {
      runtime: {
        id: "adaceen-test",
        lastError: undefined,
        getManifest: () => clone(MANIFEST),
        getURL: (rel: string) => `chrome-extension://adaceen-test/${rel}`,
        sendMessage: (_message: unknown, callback?: (response: unknown) => void) => {
          if (callback) callback({ ok: false, error: "sin background en la simulacion" });
        },
        onMessage: { addListener() {} },
      },
      storage: {
        local: {
          get: async (keys: unknown) => pick(keys),
          set: async (items: Json) => {
            const changes: Json = {};
            for (const [key, value] of Object.entries(items)) {
              changes[key] = { oldValue: clone(browser.storage[key]), newValue: clone(value) };
              browser.storage[key] = clone(value);
            }
            notify(changes);
          },
          remove: async (keys: unknown) => {
            const changes: Json = {};
            for (const key of (Array.isArray(keys) ? keys : [keys]) as string[]) {
              if (Object.prototype.hasOwnProperty.call(browser.storage, key)) {
                changes[key] = { oldValue: clone(browser.storage[key]) };
                delete browser.storage[key];
              }
            }
            notify(changes);
          },
        },
        onChanged: { addListener: (listener: (changes: Json, area: string) => void) => browser.storageListeners.push(listener) },
      },
    };
  }

  private workspace(status: string, extra: Json = {}) {
    return {
      ok: status !== "error",
      provider: "tunnel",
      status,
      workspace: { login: "alumno", tunnelName: "ws-alumno", webUrl: status === "ready" ? TUNNEL_URL : "", repoFullName: REPO },
      ...extra,
    };
  }

  ready() { return this.workspace("ready"); }
  vmOff() {
    return this.workspace("error", {
      code: "agent_unreachable",
      retryable: true,
      message: "El editor esta apagado. Avisa al docente; esta ventana seguira esperando.",
    });
  }
  vmStarting() {
    return this.workspace("pending", { ok: true, code: "vm_starting", retryable: true, message: "Encendiendo la VM de editores (1-2 min)..." });
  }
  deviceCode(userCode = "WDJB-MJHT") {
    return this.workspace("device_code", {
      ok: true,
      deviceCode: { userCode, verificationUrl: "https://github.com/login/device", expiresAt: new Date(this.clock.now + 14 * 60_000).toISOString() },
    });
  }
  notFound() {
    return this.workspace("error", { code: "not_found", message: "Todavia no hay un editor preparado para tu cuenta." });
  }
  agentError(message = "Tu editor ya tiene otro repositorio abierto.") {
    return this.workspace("error", { code: "repo_conflict", message });
  }

  async fetch(input: unknown, init: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}) {
    const url = new URL(String(input));
    const method = String(init.method || "GET").toUpperCase();
    const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : null;
    this.requests.push({ method, path: url.pathname, body, headers: { ...(init.headers || {}) }, at: this.clock.now });
    const delay = this.delays[url.pathname];
    if (delay) {
      // Como fetch: el AbortController de fetchJsonWithTimeout corta la espera.
      await new Promise((resolve, reject) => {
        this.clock.setTimeout(resolve, delay);
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }
    const reply = (status: number, json: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => structuredClone(json),
    });
    if (url.origin !== BACKEND) return reply(404, { ok: false, error: "fuera del backend" });
    const authed = init.headers?.["x-session-id"] === SESSION.id && this.sessionValid;
    const route = `${method} ${url.pathname}`;

    switch (route) {
      case "GET /api/auth/me":
        return authed ? reply(200, { ok: true, session: SESSION, policy: {}, telemetry: [] }) : reply(401, { ok: false, error: "Sesion no valida." });
      case "POST /api/auth/logout":
        return reply(200, { ok: true });
      case "GET /api/ui/active-tab":
      case "POST /api/ui/active-tab":
        return reply(200, { ok: true, activeTab: null });
      case "POST /api/behavior/events":
        return reply(200, { ok: true, accepted: 0 });
      case "GET /api/workspaces/provider":
        return this.providerStatus === 200
          ? reply(200, { ok: true, provider: this.provider })
          : reply(this.providerStatus, { ok: false, error: `HTTP ${this.providerStatus}` });
      case "GET /api/github/oauth/status":
        return reply(200, {
          ok: true,
          configured: true,
          connected: this.githubConnected,
          accountLogin: this.githubConnected ? "alumno" : "",
          scopes: this.githubConnected ? ["read:user"] : [],
          hasCodespaceScope: false,
        });
      case "GET /api/github-app/status":
        // Sin la GitHub App instalada: el tunel no debe pedirla.
        return reply(200, { ok: true, status: { ...this.appStatus, repoFullName: url.searchParams.get("repoFullName") || "" } });
      case "POST /api/github/oauth/start":
        return reply(200, { ok: true, authorizeUrl: "https://github.com/login/oauth/authorize?client_id=prueba&state=estado" });
      case "POST /api/workspaces/prepare": {
        const next = this.prepareSteps.shift() || this.lastWorkspace || this.ready();
        this.lastWorkspace = next;
        return reply(200, next);
      }
      case "GET /api/workspaces/status": {
        const next = this.statusSteps.shift() || this.lastWorkspace || this.notFound();
        this.lastWorkspace = next;
        return reply(200, next);
      }
      case "POST /api/auth/editor/pairing-code":
        this.pairingCodes += 1;
        if (this.pairingMode === "missing") return reply(404, { ok: false, error: "Ruta no encontrada." });
        if (this.pairingMode === "fail") return reply(503, { ok: false, error: "Servicio no disponible." });
        return authed
          ? reply(200, { ok: true, code: "K7P4-M2QX", expiresAt: new Date(this.clock.now + 600_000).toISOString(), ttlSeconds: 600 })
          : reply(401, { ok: false, error: "Sesion no valida." });
      case "GET /api/projects/session/state":
        return reply(200, { ok: true, state: { latestRack: this.latestRack, latestRackForFile: null } });
      case "POST /intervene":
      case "POST /github-mentor":
        return reply(200, { ok: true, ideas: [], guide: [], welcome: "", summary: "" });
      case "GET /api/documents/classifications":
        return reply(200, { ok: true, items: [] });
      default:
        this.unknownRoutes.push(route);
        return reply(404, { ok: false, error: `ruta no simulada: ${route}` });
    }
  }

  requestsTo(pathname: string, method = "") {
    return this.requests.filter((request) => request.path === pathname && (!method || request.method === method));
  }
}

// ---- Una pestana: contexto vm con window/document/location propios ----

class TabEnv {
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
      structuredClone,
      crypto: globalThis.crypto,
      HTMLElement: FakeElement,
      HTMLAnchorElement: FakeElement,
      Element: FakeElement,
      Node: FakeElement,
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

// Espera una promesa del contexto avanzando el reloj virtual (los temporizadores de la
// extension solo corren cuando la prueba avanza el tiempo).
async function drive<T>(browser: FakeBrowser, promise: Promise<T>, maxSteps = 400): Promise<T> {
  let settled = false;
  const tracked = Promise.resolve(promise).finally(() => {
    settled = true;
  });
  await browser.clock.until(() => settled, maxSteps);
  assert.ok(settled, "la accion no termino dentro del tiempo simulado");
  return tracked;
}

// Carga los scripts y deja terminar el arranque (sincronizacion inicial con storage), como
// cuando el estudiante pulsa el icono con la pagina ya cargada.
async function openTab(browser: FakeBrowser, url: string, title: string, files: string[] = OVERLAY_SCRIPTS) {
  const tab = new TabEnv(browser, url, title).load(files);
  await browser.clock.settle();
  return tab;
}

// Avanza el reloj virtual al menos `ms` (corren los temporizadores vencidos por el camino).
async function advance(browser: FakeBrowser, ms: number) {
  const target = browser.clock.now + ms;
  await browser.clock.until(() => browser.clock.now >= target, 5000);
  if (browser.clock.now < target) browser.clock.now = target;
  await browser.clock.settle();
}

// Todo id pedido a una shadow root existe en su markup (el DOM falso los crea al vuelo).
function assertKnownShadowIds(...tabs: TabEnv[]) {
  for (const tab of tabs) {
    assert.deepEqual([...tab.missingShadowIds].sort(), [], `ids inexistentes en el markup (${tab.url})`);
  }
}

function seedLoggedInBrowser(browser: FakeBrowser, extra: Json = {}) {
  browser.storage = {
    adaceenSessionId: SESSION.id,
    adaceenActiveSessionSnapshot: {
      sessionId: SESSION.id,
      backendUrl: BACKEND,
      session: SESSION,
      policy: {},
      telemetry: [],
      updatedAt: browser.clock.now,
    },
    adaceenPrivacyAcceptedByUser: { [SESSION.user.id]: true },
    adaceenClientId: "cliente-prueba-123",
    ...extra,
  };
}

test("tunel sin GitHub App: Conectar GitHub -> OAuth -> VM apagada -> codigo en una pestana -> editor listo", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, `${REPO}: taller`);

  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"));
  // Sin editor guardado se muestra la bienvenida: "Empezar" sigue siendo el primer paso.
  assert.equal(tab.state().started, false);
  await drive(browser, tab.el("startBtn").click());
  await browser.clock.until(() => tab.state().loading === false && tab.state().workspaceProvider === "tunnel");

  // Tour del tunel: un solo paso (Conectar GitHub), sin GitHub App ni botones de navegacion.
  assert.equal(tab.el("setupView").hidden, false, "se muestra el tour");
  assert.equal(tab.el("setupStepTwoCard").hidden, true, "sin paso de GitHub App");
  assert.equal(tab.el("setupStepThreeCard").hidden, true);
  assert.equal(tab.el("setupToStep2Btn").hidden, true, "sin 'Autorizar repositorio'");
  assert.equal(tab.el("setupDetectRepoBtn").hidden, true, "el repo ya se infiere de la pagina");
  assert.equal(tab.el("setupPrimaryActionBtn").dataset.contextAction, "connect_github_user");
  assert.equal(tab.el("setupPrimaryActionBtn").textContent, "Conectar GitHub");
  assert.equal(tab.el("setupSecondaryActionBtn").hidden, true, "boton unico");
  const setupRows = tab.run<Array<{ label: string; status: string }>>("buildConnectionItems(overlayState.context, getSetupFlowState(overlayState.context))");
  assert.equal(setupRows.find((item) => item.label === "GitHub App")?.status, "No requerida");
  assert.ok(setupRows.some((item) => item.label === "Editor"), "la fila de Codespaces pasa a ser el editor");
  assert.equal(tab.el("authHelper").hidden, true, "sin cuentas demo con el backend de produccion");
  assert.equal(tab.el("authEmail").value, "", "login sin credenciales precargadas");

  // La VM esta apagada al principio: el backend responde reintentable y la espera sigue.
  browser.prepareSteps = [browser.vmOff()];
  browser.statusSteps = [browser.vmStarting(), browser.vmStarting(), browser.deviceCode(), browser.deviceCode(), browser.deviceCode(), browser.ready()];

  await drive(browser, tab.el("setupPrimaryActionBtn").click());
  assert.equal(tab.popups.length, 1, "una sola ventana para el OAuth");
  const oauthWindow = tab.popups[0];
  assert.match(oauthWindow.currentHref, /^https:\/\/github\.com\/login\/oauth\/authorize/);

  // GitHub autoriza: la ventana pasa al callback del backend (otro origen) y avisa al overlay.
  browser.githubConnected = true;
  oauthWindow.location.href = `${BACKEND}/auth/github/callback?code=x&state=estado`;
  const oauthDone = tab.dispatchWindowEvent("message", { data: { type: "ADACEEN_GITHUB_OAUTH_CONNECTED" }, origin: BACKEND });

  const deviceStep = await browser.clock.until(() => oauthWindow.currentHref === "https://github.com/login/device", 400);
  assert.ok(deviceStep, "la misma ventana pasa a github.com/login/device con el codigo guardado");
  assert.equal((browser.storage.adaceenDeviceCodeHandoff as Json)?.userCode, "WDJB-MJHT");
  assert.ok(browser.requestsTo("/api/workspaces/status").length >= 3, "la VM apagada no corto la espera");
  assert.equal(tab.popups.length, 1, "sin ventanas extra");

  // En la pestana de GitHub del codigo, el content script muestra el codigo para copiar.
  const deviceTab = await openTab(browser, "https://github.com/login/device", "Device Activation");
  await browser.clock.until(() => !!deviceTab.document.getElementById("adaceen-device-code-helper"), 50);
  const helper = deviceTab.document.getElementById("adaceen-device-code-helper");
  assert.ok(helper?.shadow, "aviso con el codigo en github.com/login/device");
  assert.equal(helper!.shadow!.getElementById("adaceenDeviceCode").textContent, "WDJB-MJHT");

  await browser.clock.until(() => oauthWindow.currentHref === TUNNEL_URL, 400);
  await oauthDone;
  assert.equal(oauthWindow.currentHref, TUNNEL_URL, "la misma pestana termina en el editor");
  assert.equal(oauthWindow.closed, false);
  assert.equal(tab.popups.length, 1);

  // Nada de GitHub App ni de PR con el tunel.
  assert.deepEqual(browser.requestsTo("/api/github-app/install-url"), []);
  assert.deepEqual(browser.requestsTo("/github/prepare-environment"), []);
  assert.equal(browser.requestsTo("/api/workspaces/prepare", "POST").length, 1);

  // Editor y setup durables por usuario y repo; el codigo de dispositivo ya no se guarda.
  const saved = (browser.storage.adaceenEditorByUser as Json)?.[`${SESSION.user.id}:${REPO}`] as Json;
  assert.equal(saved?.webUrl, TUNNEL_URL);
  assert.equal((browser.storage.adaceenSetupDoneByUser as Json)?.[`${SESSION.user.id}:${REPO}`], true);
  assert.equal(browser.storage.adaceenDeviceCodeHandoff, undefined);

  // refreshGithubAppStatus ya no borra el setup ni el editor con el tunel, ni siquiera en el
  // caso que antes lo borraba: App instalada con acceso al repo y sin bootstrap de Codespaces.
  browser.appStatus = { configured: true, installation: { accountLogin: "alumno" }, hasRepoAccess: true, bootstrapReady: false };
  await drive(browser, tab.run("refreshGithubIntegrationStatus()"));
  assert.equal((browser.storage.adaceenSetupDoneByUser as Json)?.[`${SESSION.user.id}:${REPO}`], true);
  assert.equal(tab.run("hasCompletedSetup()"), true);
  assert.equal(tab.run("getStoredSetupCodespaceUrl()"), TUNNEL_URL);
  await browser.clock.until(() => tab.el("mainView").hidden === false, 20);
  assert.equal(tab.el("mainView").hidden, false, "tras preparar el editor se entra al panel");
  assert.equal(tab.el("contextPrimaryActionBtn").dataset.contextAction, "open_my_editor");
  assert.deepEqual(browser.unknownRoutes.filter((route) => !route.includes("/api/projects") && !route.includes("/api/rag")), []);
  assertKnownShadowIds(tab, deviceTab);
});

const EDITOR_KEY = `${SESSION.user.id}:${REPO}`;
const DAY_MS = 24 * 60 * 60 * 1000;

function savedEditorRecord(browser: FakeBrowser, extra: Json = {}) {
  return {
    repoFullName: REPO,
    webUrl: TUNNEL_URL,
    provider: "tunnel",
    savedAt: new Date(browser.clock.now - DAY_MS).toISOString(),
    // Ayer un prepare escribio la sesion de VS Code en la VM.
    sessionWrittenAt: new Date(browser.clock.now - DAY_MS).toISOString(),
    ...extra,
  };
}

function activeTabReports(browser: FakeBrowser) {
  return browser.requestsTo("/api/ui/active-tab", "POST").filter((request) => request.body?.isActive === true);
}

function workspaceRequestsSince(browser: FakeBrowser, index: number) {
  return browser.requests.slice(index)
    .filter((request) => request.path.startsWith("/api/workspaces/") && request.path !== "/api/workspaces/provider")
    .map((request) => `${request.method} ${request.path}`);
}

test("volver otro dia: el overlay entra solo y 'Abrir mi editor' consulta status y abre", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser, {
    adaceenOverlayPinned: true,
    adaceenSetupDoneByUser: { [EDITOR_KEY]: true },
    adaceenEditorByUser: { [EDITOR_KEY]: savedEditorRecord(browser) },
  });
  browser.githubConnected = true;

  // El overlay fijado se restaura al cargar la pagina y entra sin "Empezar".
  const tab = await openTab(browser, `https://github.com/${REPO}`, `${REPO}: taller`);
  await browser.clock.until(() => tab.state().started === true && tab.state().loading === false, 400);
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 50);
  assert.equal(tab.state().started, true, "sin pulsar Empezar");
  assert.equal(tab.el("mainView").hidden, false);
  assert.equal(tab.el("contextPrimaryActionBtn").dataset.contextAction, "open_my_editor");
  assert.equal(tab.el("contextPrimaryActionBtn").textContent, "Abrir mi editor");
  assert.deepEqual(browser.requestsTo("/intervene"), [], "entrar solo no pide ayuda al tutor");
  assert.deepEqual(browser.requestsTo("/github-mentor"), []);
  assert.ok(browser.requestsTo("/api/auth/me").length >= 1, "la sesion se confirma antes de entrar");
  // Entrar solo no cuenta como pestana activa (active_tab_seen) hasta que el estudiante interactua.
  await browser.clock.until(() => false, 30);
  assert.deepEqual(activeTabReports(browser), [], "sin POST /api/ui/active-tab isActive=true al entrar solo");
  assert.equal(tab.run("buildTabSessionSnapshot().started"), false, "al recargar vuelve a decidir la entrada automatica");

  // Fila "VS Code" fuera del editor web: solo con un rack reciente del repo actual publicado por VS Code.
  const vscodeRow = () => tab
    .run<Array<{ label: string; status: string }>>("buildConnectionItems(overlayState.context, getSetupFlowState(overlayState.context))")
    .find((item) => item.label === "VS Code");
  assert.equal(vscodeRow(), undefined);
  browser.latestRack = { id: "rack-1", source: "vscode_extension", repoFullName: REPO, updatedAt: new Date(browser.clock.now - 2 * 60_000).toISOString() };
  await drive(browser, tab.run("refreshVscodePresence()"));
  assert.equal(vscodeRow()?.status, "Conectado");
  browser.latestRack = { id: "rack-1", source: "vscode_extension", repoFullName: REPO, updatedAt: new Date(browser.clock.now - 30 * 60_000).toISOString() };
  await drive(browser, tab.run("refreshVscodePresence()"));
  assert.equal(vscodeRow(), undefined, "un rack de hace 30 min no cuenta como conectado");
  // El rack que publica el propio overlay al explorar el proyecto (source = pageType) no prueba nada.
  browser.latestRack = { id: "rack-2", source: "codespace", repoFullName: REPO, updatedAt: new Date(browser.clock.now - 60_000).toISOString() };
  await drive(browser, tab.run("refreshVscodePresence()"));
  assert.equal(vscodeRow(), undefined, "un rack del overlay no es VS Code conectado");

  // La presencia de VS Code no retrasa la peticion al tutor (latencyMs del piloto).
  browser.delays["/api/projects/session/state"] = 5000;
  const refreshFrom = browser.requests.length;
  const refreshStartedAt = browser.clock.now;
  await drive(browser, tab.run("refreshMentorSession({ trigger: 'manual', requestedAt: Date.now() })"), 2000);
  const sinceRefresh = browser.requests.slice(refreshFrom);
  const presenceRequest = sinceRefresh.find((request) => request.path === "/api/projects/session/state");
  const tutorRequest = sinceRefresh.find((request) => request.path === "/intervene" || request.path === "/github-mentor");
  assert.ok(presenceRequest && tutorRequest, "hubo consulta de presencia y peticion al tutor");
  assert.ok(tutorRequest!.at - refreshStartedAt < 5000, "el tutor no espera a /api/projects/session/state");
  delete browser.delays["/api/projects/session/state"];
  browser.latestRack = null;
  await browser.clock.until(() => false, 30);

  // El primer clic o tecla dentro del overlay la vuelve pestana activa.
  await Promise.all((tab.shadowListeners.get("pointerdown") || []).map((listener) => listener({ type: "pointerdown" })));
  await browser.clock.until(() => activeTabReports(browser).length > 0, 50);
  assert.equal(activeTabReports(browser).length, 1, "tras interactuar si cuenta como pestana activa");
  assert.equal(tab.run("buildTabSessionSnapshot().started"), true);

  // Un clic: status listo -> la ventana abierta en el mismo clic va al editor, sin prepare.
  browser.statusSteps = [browser.ready()];
  await drive(browser, tab.el("contextPrimaryActionBtn").click());
  await browser.clock.until(() => tab.popups[0]?.currentHref === TUNNEL_URL, 50);
  assert.equal(tab.popups.length, 1);
  assert.equal(tab.popups[0].currentHref, TUNNEL_URL);
  assert.deepEqual(browser.requestsTo("/api/workspaces/prepare"), []);
  // El primer clic en el overlay la vuelve pestana activa.

  // Segundo clic poco despues (pestana cerrada): vuelve a abrir, sin el candado de 5 min.
  tab.popups[0].close();
  browser.statusSteps = [browser.ready()];
  await drive(browser, tab.el("contextPrimaryActionBtn").click());
  await browser.clock.until(() => tab.popups[1]?.currentHref === TUNNEL_URL, 50);
  assert.equal(tab.popups[1]?.currentHref, TUNNEL_URL);

  // VM apagada: status reintentable -> prepare (idempotente), que espera y abre.
  browser.statusSteps = [browser.vmOff(), browser.vmStarting(), browser.ready()];
  browser.prepareSteps = [browser.vmOff()];
  browser.lastWorkspace = null;
  await drive(browser, tab.el("contextPrimaryActionBtn").click(), 2000);
  await browser.clock.until(() => tab.popups[2]?.currentHref === TUNNEL_URL, 400);
  assert.equal(tab.popups[2]?.currentHref, TUNNEL_URL);
  assert.equal(browser.requestsTo("/api/workspaces/prepare", "POST").length, 1);
  const afterPrepare = (browser.storage.adaceenEditorByUser as Json)?.[EDITOR_KEY] as Json;
  assert.ok(Date.parse(String(afterPrepare?.sessionWrittenAt)) > browser.clock.now - 60_000, "prepare renueva la fecha de la sesion de la VM");

  // Sesion de la VM escrita hace mas de 7 dias: "Abrir mi editor" pasa por prepare aunque status diria listo.
  await drive(browser, tab.run(`updateSavedEditorMap((map) => { map["${EDITOR_KEY}"] = { ...map["${EDITOR_KEY}"], sessionWrittenAt: "${new Date(browser.clock.now - 8 * DAY_MS).toISOString()}" }; return map; })`));
  browser.statusSteps = [browser.ready()];
  browser.prepareSteps = [browser.ready()];
  let from = browser.requests.length;
  await drive(browser, tab.el("contextPrimaryActionBtn").click(), 2000);
  await browser.clock.until(() => tab.popups[3]?.currentHref === TUNNEL_URL, 400);
  assert.equal(tab.popups[3]?.currentHref, TUNNEL_URL);
  assert.equal(workspaceRequestsSince(browser, from)[0], "POST /api/workspaces/prepare", "sesion vieja: directo a prepare");
  assert.ok(!workspaceRequestsSince(browser, from).includes("GET /api/workspaces/status"));

  // Tras cerrar sesion, el siguiente "Abrir mi editor" pasa por prepare (renueva la sesion de VS Code).
  await drive(browser, tab.run("logoutFromBackend()"));
  const record = (browser.storage.adaceenEditorByUser as Json)?.[EDITOR_KEY] as Json;
  assert.equal(record?.needsSessionRefresh, true);
  // Vuelve a iniciar sesion (otra pestana deja la sesion en storage) y pulsa "Abrir mi editor".
  browser.storage.adaceenSessionId = SESSION.id;
  browser.storage.adaceenActiveSessionSnapshot = {
    sessionId: SESSION.id,
    backendUrl: BACKEND,
    session: SESSION,
    policy: {},
    telemetry: [],
    updatedAt: browser.clock.now,
  };
  await drive(browser, tab.run("syncFromStorageSnapshot({ force: true })"));
  assert.equal(tab.run("getCurrentUserId()"), SESSION.user.id);
  browser.statusSteps = [browser.ready()];
  browser.prepareSteps = [browser.ready()];
  from = browser.requests.length;
  await drive(browser, tab.run("openMyTunnelEditor()"), 2000);
  await browser.clock.until(() => tab.popups[4]?.currentHref === TUNNEL_URL, 400);
  assert.equal(tab.popups[4]?.currentHref, TUNNEL_URL);
  assert.equal(workspaceRequestsSince(browser, from)[0], "POST /api/workspaces/prepare", "tras cerrar sesion: directo a prepare");
  assert.ok(!workspaceRequestsSince(browser, from).includes("GET /api/workspaces/status"));
  const renewed = (browser.storage.adaceenEditorByUser as Json)?.[EDITOR_KEY] as Json;
  assert.equal(renewed?.needsSessionRefresh, false, "prepare deja la sesion de la VM al dia");
  assertKnownShadowIds(tab);
});

test("con Codespaces el tour sigue pidiendo la GitHub App (sin cambios)", async () => {
  const browser = new FakeBrowser();
  browser.provider = "codespaces";
  seedLoggedInBrowser(browser, {
    // Un editor de tunel guardado de antes no cambia el flujo de Codespaces.
    adaceenEditorByUser: {
      [`${SESSION.user.id}:${REPO}`]: { repoFullName: REPO, webUrl: TUNNEL_URL, provider: "tunnel", savedAt: "2026-09-24T15:00:00.000Z" },
    },
  });
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  assert.equal(tab.state().started, false, "con Codespaces se sigue entrando con Empezar");
  await drive(browser, tab.el("startBtn").click());
  await browser.clock.until(() => tab.state().loading === false && tab.state().workspaceProvider === "codespaces", 400);

  assert.equal(tab.el("setupView").hidden, false, "sin setup completo se muestra el tour");
  assert.equal(tab.el("setupToStep2Btn").hidden, false, "'Autorizar repositorio' sigue en Codespaces");
  assert.equal(tab.el("setupStepOneEyebrow").textContent, "Paso 1 de 3");
  assert.equal(tab.el("setupPrimaryActionBtn").dataset.contextAction, "connect_github", "pide la GitHub App");
  tab.run("overlayState.setupWizardStep = 3");
  assert.equal(tab.run("resolveCurrentSetupStep(getSetupFlowState(overlayState.context))"), 2, "sin App no se pasa al paso 3");

  // Con la App y acceso al repo, el paso 3 sin la cuenta de GitHub conectada ofrece conectarla
  // (su clic ya iniciaba el OAuth; antes quedaba deshabilitado).
  browser.appStatus = { configured: true, installation: { accountLogin: "alumno" }, hasRepoAccess: true, bootstrapReady: false };
  await drive(browser, tab.run("refreshGithubIntegrationStatus()"));
  tab.run("overlayState.setupWizardStep = 3; renderOverlay()");
  assert.equal(tab.run("resolveCurrentSetupStep(getSetupFlowState(overlayState.context))"), 3);
  assert.equal(tab.el("setupCreatePrBtn").disabled, false, "sin OAuth el boton del paso 3 inicia la conexion");
  assert.equal(tab.el("setupCreatePrBtn").textContent, "Conectar GitHub");

  // La ventana del OAuth ya esta en otro origen (callback del backend): se navega al Codespace
  // en su lugar, sin cerrarla ni abrir otra que el navegador bloquearia.
  const oauthWindow = tab.run("window.open('about:blank', '_blank')");
  oauthWindow.location.href = `${BACKEND}/auth/github/callback?code=x&state=estado`;
  const codespaceUrl = "https://fluffy-space-xyz.github.dev/";
  Object.assign(tab.context, { __oauthWindow: oauthWindow });
  const opened = await drive(browser, tab.run(`navigatePendingCodespaceWindow(__oauthWindow, "${codespaceUrl}")`));
  assert.equal(opened, true);
  assert.equal(oauthWindow.currentHref, codespaceUrl);
  assert.equal(oauthWindow.closed, false);
  assert.equal(tab.popups.length, 1, "sin ventanas extra");
  assertKnownShadowIds(tab);
});

test("la entrada automatica solo ocurre donde se ofrece 'Abrir mi editor'", async () => {
  // En el propio editor (vscode.dev/tunnel) y en Campus sigue "Empezar", con su primera
  // respuesta del tutor, y la pestana no se reporta activa por entrar sola.
  const pages: Array<[string, string]> = [
    [TUNNEL_URL, "taller-1 [Tunel]"],
    ["https://campusvirtual.univalle.edu.co/moodle/course/view.php?id=77", "FPOO: Curso"],
  ];
  for (const [url, title] of pages) {
    const browser = new FakeBrowser();
    seedLoggedInBrowser(browser, {
      adaceenOverlayPinned: true,
      adaceenEditorByUser: { [EDITOR_KEY]: savedEditorRecord(browser) },
    });
    browser.githubConnected = true;
    const tab = await openTab(browser, url, title);
    await browser.clock.until(() => tab.run("overlayHost?.isConnected") === true, 400);
    await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 50);
    await advance(browser, 20_000);
    assert.equal(tab.state().started, false, `${url}: sin entrada automatica`);
    assert.equal(tab.el("welcomeView").hidden, false, `${url}: se ve la bienvenida con Empezar`);
    assert.deepEqual(activeTabReports(browser), [], `${url}: sin active_tab_seen`);
    assertKnownShadowIds(tab);
  }

  // Sin editor guardado (lo normal con Codespaces): abrir el overlay no suma /api/auth/me ni
  // /api/rag/courses.
  const browser = new FakeBrowser();
  browser.provider = "codespaces";
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 50);
  assert.equal(tab.state().started, false);
  assert.deepEqual(browser.requestsTo("/api/auth/me"), [], "sin editor guardado no se confirma la sesion");
  assert.deepEqual(browser.requestsTo("/api/rag/courses"), []);
});

test("aviso del codigo de dispositivo: solo para su usuario, sin copiar tarde y dice cuando ADACEEN deja de esperar", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  browser.githubConnected = true;
  const handoff = (extra: Json = {}) => ({
    userCode: "WDJB-MJHT",
    userId: SESSION.user.id,
    repoFullName: REPO,
    expiresAt: browser.clock.now + 10 * 60_000,
    savedAt: browser.clock.now,
    aliveAt: browser.clock.now,
    ...extra,
  });
  const helperOf = (tab: TabEnv) => tab.document.getElementById("adaceen-device-code-helper");
  const statusOf = (tab: TabEnv) => String(helperOf(tab)?.shadow?.getElementById("adaceenDeviceCodeStatus").textContent || "");

  // Codigo de otro usuario de ADACEEN (equipo compartido): ni se muestra ni se copia.
  browser.storage.adaceenDeviceCodeHandoff = handoff({ userId: "u-otro" });
  const otherUser = await openTab(browser, "https://github.com/login/device", "Device Activation");
  await advance(browser, 2_000);
  assert.equal(helperOf(otherUser), null, "no se muestra el codigo de otro usuario");
  assert.deepEqual(browser.clipboard, []);

  // Visita posterior (codigo emitido hace 5 min, espera viva): se muestra, pero sin tocar el portapapeles.
  browser.storage.adaceenDeviceCodeHandoff = handoff({ savedAt: browser.clock.now - 5 * 60_000 });
  const lateVisit = await openTab(browser, "https://github.com/login/device", "Device Activation");
  await browser.clock.until(() => !!helperOf(lateVisit), 50);
  assert.ok(helperOf(lateVisit), "el aviso aparece para su usuario");
  assert.deepEqual(browser.clipboard, [], "una visita tardia no copia sola");
  // La pestana que esperaba se recargo o se cerro (sin latidos): el aviso deja de prometer el editor.
  await advance(browser, 75_000);
  assert.match(statusOf(lateVisit), /ADACEEN ya no espera este codigo/);

  // Flujo real: tras el codigo, el backend responde un error no reintentable. La pestana de
  // github.com/login/device lo dice (antes seguia prometiendo abrir el editor).
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 50);
  await drive(browser, tab.run("fetchCurrentSession()"));
  await drive(browser, tab.run("refreshWorkspaceProvider(true)"));
  browser.prepareSteps = [browser.deviceCode()];
  browser.statusSteps = [browser.deviceCode(), browser.deviceCode(), browser.deviceCode(), browser.agentError()];
  const preparing = tab.run("prepareTunnelWorkspace()");
  await browser.clock.until(() => tab.popups[0]?.currentHref === "https://github.com/login/device", 200);
  const deviceTab = await openTab(browser, "https://github.com/login/device", "Device Activation");
  await browser.clock.until(() => !!helperOf(deviceTab), 50);
  // Recien emitido el codigo (la ventana llego aqui por el flujo) si se copia solo.
  assert.match(statusOf(deviceTab), /^Codigo copiado: .*Esta pestana abrira tu editor sola\.$/);
  await drive(browser, preparing, 2000);
  await advance(browser, 1_000);
  assert.match(statusOf(deviceTab), /ADACEEN dejo de esperar\. Tu editor ya tiene otro repositorio abierto\. .*Abrir mi editor/);
  assert.equal((browser.storage.adaceenDeviceCodeHandoff as Json)?.outcome, "error");

  // Cerrar sesion borra el codigo pendiente.
  browser.storage.adaceenDeviceCodeHandoff = handoff();
  await drive(browser, tab.run("logoutFromBackend()"));
  assert.equal(browser.storage.adaceenDeviceCodeHandoff, undefined);
  assertKnownShadowIds(tab, deviceTab, lateVisit);
});

test("proveedor: un fallo pasajero no fija Codespaces 5 min ni borra el setup", async () => {
  // Con un editor del tunel guardado, el respaldo es el tunel y se reintenta en segundos.
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser, { adaceenEditorByUser: { [EDITOR_KEY]: savedEditorRecord(browser) } });
  browser.providerStatus = 503;
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("syncFromStorageSnapshot({ force: true })"));
  assert.equal(await drive(browser, tab.run("refreshWorkspaceProvider(true)")), "tunnel");
  assert.equal(tab.run("isWorkspaceProviderProvisional()"), true);
  browser.providerStatus = 200;
  const before = browser.requestsTo("/api/workspaces/provider").length;
  await drive(browser, tab.run("refreshWorkspaceProvider()"));
  assert.equal(browser.requestsTo("/api/workspaces/provider").length, before, "dentro de los 15 s usa el respaldo");
  await advance(browser, 16_000);
  await drive(browser, tab.run("refreshWorkspaceProvider()"));
  assert.equal(browser.requestsTo("/api/workspaces/provider").length, before + 1, "pasados 15 s vuelve a consultar");
  assert.equal(tab.run("isWorkspaceProviderProvisional()"), false);

  // Sin editor guardado: Codespaces provisional, y refreshGithubAppStatus no borra el setup.
  const other = new FakeBrowser();
  other.providerStatus = 503;
  other.appStatus = { configured: true, installation: { accountLogin: "alumno" }, hasRepoAccess: true, bootstrapReady: false };
  seedLoggedInBrowser(other, { adaceenSetupDoneByUser: { [EDITOR_KEY]: true } });
  const otherTab = await openTab(other, `https://github.com/${REPO}`, REPO);
  await drive(other, otherTab.run("syncFromStorageSnapshot({ force: true })"));
  otherTab.run("overlayState.context = buildPayload()");
  assert.equal(otherTab.run("getCurrentRepoFullName()"), REPO);
  await drive(other, otherTab.run("refreshGithubIntegrationStatus().catch(() => {})"));
  assert.equal(otherTab.state().workspaceProvider, "codespaces");
  assert.equal(otherTab.run("isWorkspaceProviderProvisional()"), true);
  assert.equal((other.storage.adaceenSetupDoneByUser as Json)?.[EDITOR_KEY], true, "no se borra el setup con un proveedor provisional");
  // 404: backend sin la ruta, Codespaces confirmado (y ahi si se aplica la regla de siempre).
  other.providerStatus = 404;
  await drive(other, otherTab.run("refreshWorkspaceProvider(true)"));
  assert.equal(otherTab.state().workspaceProvider, "codespaces");
  assert.equal(otherTab.run("isWorkspaceProviderProvisional()"), false);
});

test("VS Code de este equipo y 'Copiar sesion' usan un codigo de un solo uso", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"));
  await drive(browser, tab.run("fetchCurrentSession()"));
  // Los enlaces vscode:// no pasan por el DOM de la pagina (el codigo es una credencial).
  const pageAnchors: string[] = [];
  const appendToBody = tab.document.body.appendChild.bind(tab.document.body);
  tab.document.body.appendChild = (child: FakeElement) => {
    if (child.tagName === "A") pageAnchors.push(child.href);
    return appendToBody(child);
  };

  await drive(browser, tab.run("openLocalVscodeClone()"));
  assert.deepEqual(tab.openedLinks, [`vscode://adaceen.adaceen/abrir?code=K7P4-M2QX&repo=${REPO}`]);
  assert.equal(browser.clipboard.length, 0, "ya no se copia la sesion");
  assert.deepEqual(pageAnchors, [], "el enlace con el codigo se pulsa dentro de la shadow root del overlay");

  await drive(browser, tab.run("copyEditorPairingCodeForVscode()"));
  assert.deepEqual(browser.clipboard, ["K7P4-M2QX"]);
  assert.match(tab.state().statusMessage, /ADACEEN: Conectar/);
  assert.doesNotMatch(tab.state().statusMessage, new RegExp(SESSION.id));

  // Fallo pasajero (503): el repo se abre sin codigo y la sesion del navegador NO se copia.
  browser.pairingMode = "fail";
  await drive(browser, tab.run("openLocalVscodeClone()"));
  assert.equal(tab.openedLinks[1], `vscode://adaceen.adaceen/abrir?repo=${REPO}`);
  assert.match(tab.state().statusMessage, /ADACEEN: sin conectar/);
  assert.equal(await drive(browser, tab.run("copyEditorPairingCodeForVscode()")), false);
  assert.match(tab.state().statusMessage, /Pulsa Copiar sesion de nuevo/);
  // Tiempo agotado (arranque en frio del backend): igual, sin copiar la sesion.
  browser.pairingMode = "ok";
  browser.delays["/api/auth/editor/pairing-code"] = 5000;
  await drive(browser, tab.run("openLocalVscodeClone()"));
  assert.equal(tab.openedLinks[2], `vscode://adaceen.adaceen/abrir?repo=${REPO}`);
  assert.match(tab.state().statusMessage, /Tiempo de espera agotado/);
  delete browser.delays["/api/auth/editor/pairing-code"];
  assert.deepEqual(browser.clipboard, ["K7P4-M2QX"], "ningun fallo pasajero copio la sesion");

  // Backend anterior sin emparejamiento (404): se cae al enlace anterior de clonado.
  browser.pairingMode = "missing";
  await drive(browser, tab.run("openLocalVscodeClone()"));
  assert.equal(tab.openedLinks[3], `vscode://vscode.git/clone?url=${encodeURIComponent(`https://github.com/${REPO}.git`)}`);
  assert.equal(browser.clipboard[browser.clipboard.length - 1], SESSION.id);
  assert.match(tab.state().statusMessage, /Configurar sesion compartida/);
  assert.deepEqual(pageAnchors, []);
  assertKnownShadowIds(tab);
});

test("la pagina /empezar detecta la extension con el content script propio", async () => {
  const browser = new FakeBrowser();
  const tab = new TabEnv(browser, `${BACKEND}/empezar`, "Empezar con ADACEEN");
  const messages: Json[] = [];
  tab.window.addEventListener("message", (event: Json) => messages.push(event));
  tab.load(["inicio/pagina-inicio.content.js"]);
  assert.equal(tab.document.documentElement.dataset.adaceenExtension, MANIFEST.version);
  assert.equal(messages.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0].data)), { type: "adaceen:extension", version: MANIFEST.version });
  assert.equal(messages[0].targetOrigin, BACKEND);
});
