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
 *  - la pagina /empezar detecta la extension;
 *  - auditoria de redundancias (0.7.12): sin «Empezar», privacidad aceptada en el backend,
 *    editor preparado en otro navegador, tunel sin GitHub App en la tuerca ni en las filas,
 *    vscode.dev sin textos de Codespaces, docente sin tour, un solo «Salir», ultima eleccion
 *    de editor en la Mac y sin botones ni peticiones repetidas;
 *  - tanda 2: Codespaces con boton unico (la GitHub App se detecta sola y se siguen creando
 *    el PR y el Codespace), una sola casilla de mini quiz y los avisos del backend al lanzar
 *    un quiz o iniciar un bloque del piloto, y Campus verificado en silencio con una accion.
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
const CODESPACE_URL = "https://fluffy-space-xyz.github.dev/";
const CAMPUS_COURSE_URL = "https://campusvirtual.univalle.edu.co/moodle/course/view.php?id=77";
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
  // postMessage que recibio (se entrega solo si targetOrigin es el origen actual).
  messages: Array<{ data: any; targetOrigin: string }> = [];
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
  postMessage(data: unknown, targetOrigin: string) {
    let origin = "";
    try {
      origin = new URL(this.currentHref).origin;
    } catch {}
    if (targetOrigin === "*" || targetOrigin === origin) this.messages.push({ data: structuredClone(data), targetOrigin });
  }
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
  // Privacidad en el backend (contrato (a)): undefined = backend anterior, sin el campo
  // privacy en login ni en /api/auth/me y sin POST /api/auth/privacy-acceptance (404).
  privacy: Json | undefined = undefined;
  privacyAcceptances: Json[] = [];
  firstLogin = false;
  // Sesion que devuelven login y /api/auth/me (por ejemplo, la de un docente).
  session: typeof SESSION = SESSION;
  // Politica que devuelven login y /api/auth/me.
  policy: Json = {};
  // Scope codespace de la cuenta de GitHub (Codespaces).
  githubCodespaceScope = false;
  // POST /api/github-app/link-installation-auto: sin una instalacion que vincular (404). Con
  // true, la App ya estaba instalada en la organizacion y queda vinculada con acceso al repo.
  appAutoLink = false;
  // Pestana activa que reporta GET /api/ui/active-tab (null: ninguna).
  activeTab: Json | null = null;
  // GET /api/documents/bitacora/status (Campus): estado HTTP y bitacora del curso.
  bitacoraStatus = 200;
  bitacoraLatest: Json | null = { id: "bitacora-1", title: "Bitacora FPOO 2026-2" };
  // Piloto: respuesta de PUT /api/pilot/block y de POST /api/quiz/launches (contratos (b) y (c)).
  pilotBlockReply: Json | null = null;
  quizLaunchReply: Json | null = null;
  quizLaunches: Json[] = [];

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
        return authed
          ? reply(200, { ok: true, session: this.session, policy: this.policy, telemetry: [], ...(this.privacy ? { privacy: this.privacy } : {}) })
          : reply(401, { ok: false, error: "Sesion no valida." });
      case "POST /api/auth/login":
      case "POST /api/auth/google-login":
        this.sessionValid = true;
        return reply(200, {
          ok: true,
          session: this.session,
          policy: this.policy,
          telemetry: [],
          firstLogin: this.firstLogin,
          ...(this.privacy ? { privacy: this.privacy } : {}),
        });
      case "POST /api/auth/privacy-acceptance":
        if (!this.privacy) return reply(404, { ok: false, error: "Ruta no encontrada." });
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        this.privacyAcceptances.push(body || {});
        this.privacy = { version: String(body?.version || ""), acceptedAt: new Date(this.clock.now).toISOString() };
        return reply(200, { ok: true, privacy: this.privacy });
      case "GET /api/rag/courses":
        return reply(200, { ok: true, courses: [{ code: "FPOO", name: "FPOO" }], assignedCourseCodes: ["FPOO"], defaultCourseCode: "FPOO" });
      case "POST /api/auth/logout":
        return reply(200, { ok: true });
      case "GET /api/ui/active-tab":
      case "POST /api/ui/active-tab":
        return reply(200, { ok: true, activeTab: this.activeTab });
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
          scopes: this.githubConnected ? ["read:user", ...(this.githubCodespaceScope ? ["codespace"] : [])] : [],
          hasCodespaceScope: this.githubConnected && this.githubCodespaceScope,
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
      // ---- Codespaces: GitHub App, PR y Codespace ----
      case "POST /api/github-app/install-url":
        return reply(200, { ok: true, installUrl: "https://github.com/apps/adaceen-piloto/installations/new?state=estado-app" });
      case "POST /api/github-app/link-installation-auto":
        if (!this.appAutoLink) {
          return reply(404, { ok: false, error: `No se encontro una instalacion con acceso a ${body?.repoFullName}.` });
        }
        this.appStatus = { ...this.appStatus, installation: { accountLogin: "univalle-fpoo" }, hasRepoAccess: true };
        return reply(200, { ok: true, linkedInstallation: { installationId: "99" } });
      case "POST /github/prepare-environment":
        // Como el backend: la preparacion queda registrada y /api/github-app/status la reporta.
        this.appStatus = {
          ...this.appStatus,
          bootstrapReady: true,
          bootstrapPullNumber: 7,
          bootstrapPullUrl: `https://github.com/${REPO}/pull/7`,
          bootstrapBranchName: "adaceen/devcontainer",
          bootstrapCodespaceUrl: CODESPACE_URL,
        };
        return reply(200, {
          ok: true,
          status: "ready",
          automation: "created",
          repository: REPO,
          pullRequest: { number: 7, url: `https://github.com/${REPO}/pull/7`, branchName: "adaceen/devcontainer" },
          codespace: { name: "fluffy-space-xyz", webUrl: CODESPACE_URL, state: "Available", ready: true },
          fallback: { webUrl: `https://codespaces.new/${REPO}` },
        });
      case "GET /api/github/codespaces/status":
        return reply(200, { ok: true, found: false, codespace: null });
      case "GET /api/rag/sources":
        return reply(200, { ok: true, courseCode: "FPOO", sources: [] });
      // ---- Campus ----
      case "GET /api/documents/bitacora/status":
        return this.bitacoraStatus === 200
          ? reply(200, { ok: true, courseCode: "FPOO", latest: this.bitacoraLatest, summary: { rows: this.bitacoraLatest ? 12 : 0 } })
          : reply(this.bitacoraStatus, { ok: false, error: "No se pudo leer la bitacora." });
      case "POST /api/campus/analyze-page":
        return reply(200, {
          ok: true,
          analysis: {
            course: { id: 77, title: "FPOO", url: CAMPUS_COURSE_URL },
            summary: "Curso con 1 tarea con fecha.",
            agenda: [{ title: "Taller 1: clases y objetos", type: "assign", url: `${CAMPUS_COURSE_URL}#taller-1`, dueAt: "2026-10-02T22:00:00.000Z" }],
            stats: { activityCount: 1, taskCount: 1, deadlineCount: 1 },
          },
        });
      // ---- Docente: politica, quiz de la clase y piloto ----
      case "GET /api/policies/current":
        return reply(200, { ok: true, policy: this.policy, telemetry: [] });
      case "PUT /api/policies/current":
        this.policy = { ...this.policy, ...(body || {}) };
        return reply(200, { ok: true, policy: this.policy, telemetry: [] });
      case "POST /api/quiz/launches": {
        const launch = { id: `quiz-${this.quizLaunches.length + 1}`, topic: String(body?.topic || ""), active: true, results: { answered: 0, correct: 0 } };
        this.quizLaunches.unshift(launch);
        return reply(200, { ok: true, launch, ...(this.quizLaunchReply || {}) });
      }
      case "GET /api/quiz/launches":
        return reply(200, { ok: true, launches: this.quizLaunches });
      case "GET /api/pilot":
        return reply(200, { ok: true, block: 0, counts: { A: 0, B: 0, sinAsignar: 2 } });
      case "PUT /api/pilot/block":
        return reply(200, {
          ok: true,
          block: Number(body?.block) || 0,
          counts: { A: 1, B: 1, sinAsignar: 0 },
          ...(this.pilotBlockReply || {}),
        });
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
      session: browser.session,
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
  // Con sesion el icono entra directo: «Empezar» solo navegaba (auditoria, item 13). Como
  // «Empezar», confirma la sesion y el tutor responde una vez.
  assert.equal(tab.state().started, true, "sin pulsar Empezar");
  await browser.clock.until(() => tab.state().loading === false && tab.state().workspaceProvider === "tunnel");
  assert.equal(tab.el("welcomeView").hidden, true);
  assert.equal(browser.requestsTo("/api/auth/me").length, 1, "la sesion se confirma una vez");
  assert.equal(browser.requestsTo("/api/rag/courses").length, 1, "los cursos se piden una vez al entrar");
  assert.equal(browser.requestsTo("/api/github/oauth/status").length, 1);

  // Tour del tunel: un solo paso (Conectar GitHub), sin GitHub App ni botones de navegacion.
  assert.equal(tab.el("setupView").hidden, false, "se muestra el tour");
  assert.equal(tab.el("setupViewTitle").textContent, "Preparar tu editor", "con el tunel no se prepara el repositorio");
  assert.equal(tab.el("setupViewPill").textContent, "Primera vez");
  // Una sola tarjeta: las de la GitHub App y del PR ya no existen (item 2).
  assert.doesNotMatch(
    tab.run<string>("buildOverlayMarkup()"),
    /id="setupStepTwoCard"|id="setupStepThreeCard"|id="setupToStep2Btn"/,
    "sin paso de GitHub App ni 'Autorizar repositorio'",
  );
  assert.equal(tab.el("setupStepOneCard").hidden, false);
  assert.equal(tab.el("setupDetectRepoBtn").hidden, true, "el repo ya se infiere de la pagina");
  assert.equal(tab.el("setupPrimaryActionBtn").dataset.contextAction, "connect_github_user");
  assert.equal(tab.el("setupPrimaryActionBtn").textContent, "Conectar GitHub");
  assert.equal(tab.el("setupSecondaryActionBtn").hidden, true, "boton unico");
  // Filas del contexto: sin «GitHub App: No requerida» ni «Campus: No detectado» (item 5).
  const setupRows = tab.run<Array<{ label: string; status: string }>>("buildConnectionItems(overlayState.context, getSetupFlowState(overlayState.context))");
  assert.deepEqual(Array.from(setupRows, (item) => item.label), ["ADACEEN", "GitHub OAuth", "Editor"], "la fila de Codespaces pasa a ser el editor");
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

  // Nada de GitHub App ni de PR con el tunel: ni siquiera se consulta su estado (item 13).
  assert.deepEqual(browser.requestsTo("/api/github-app/status"), []);
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
  await drive(browser, tab.run("refreshGithubAppStatus()"));
  await drive(browser, tab.run("refreshGithubIntegrationStatus()"));
  assert.equal((browser.storage.adaceenSetupDoneByUser as Json)?.[`${SESSION.user.id}:${REPO}`], true);
  assert.equal(tab.run("hasCompletedSetup()"), true);
  assert.equal(tab.run("getStoredSetupCodespaceUrl()"), TUNNEL_URL);
  await browser.clock.until(() => tab.el("mainView").hidden === false, 20);
  assert.equal(tab.el("mainView").hidden, false, "tras preparar el editor se entra al panel");
  assert.equal(tab.el("contextPrimaryActionBtn").dataset.contextAction, "open_my_editor");
  // La tuerca no ofrece la GitHub App con el tunel (item 1) y el panel de github.com no muestra
  // botones que solo funcionan dentro del editor (item 5).
  tab.run("overlayState.settingsOpen = true; renderOverlay()");
  assert.equal(tab.el("advancedGithubBlock").hidden, true, "sin «Ajustes avanzados GitHub App»");
  assert.equal(tab.el("githubAppSection").hidden, true, "sin «Conectar App»");
  tab.run("overlayState.settingsOpen = false; renderOverlay()");
  assert.equal(tab.el("analyzeProjectBtn").hidden, true, "sin «Explorar repo» fuera del editor");
  assert.equal(tab.el("rerunOcrBtn").hidden, true, "sin «OCR visual» fuera del editor");
  assert.deepEqual(browser.unknownRoutes.filter((route) => !route.includes("/api/projects")), []);
  assertKnownShadowIds(tab, deviceTab);
});

test("primera vez: la ventana del OAuth (callback del backend, otro origen) recibe el progreso y el error", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, `${REPO}: taller`);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"));
  await browser.clock.until(() => tab.state().loading === false && tab.state().workspaceProvider === "tunnel");

  // VM apagada al principio y luego un error definitivo (repositorio privado).
  const privateRepo = "No se pudo clonar el repositorio: no existe o es privado.";
  browser.prepareSteps = [browser.vmOff()];
  browser.statusSteps = [browser.agentError(privateRepo)];
  await drive(browser, tab.el("setupPrimaryActionBtn").click());
  const oauthWindow = tab.popups[0];
  browser.githubConnected = true;
  oauthWindow.location.href = `${BACKEND}/auth/github/callback?code=x&state=estado`;
  const oauthDone = tab.dispatchWindowEvent("message", { data: { type: "ADACEEN_GITHUB_OAUTH_CONNECTED" }, origin: BACKEND });

  const updates = () => oauthWindow.messages
    .filter((message) => message.data?.type === "ADACEEN_WAIT_UPDATE")
    .map((message) => `${message.data.title} | ${message.data.detail}`);
  await browser.clock.until(() => updates().some((line) => line.startsWith("No se pudo preparar el editor")), 400);
  await oauthDone;
  assert.ok(oauthWindow.messages.every((message) => message.targetOrigin === BACKEND), "solo al origen del backend");
  assert.deepEqual(updates(), [
    "ADACEEN esta preparando tu editor | Clonando el repositorio en la nube y registrando el tunel...",
    "El editor esta apagado; avisa al docente | El editor esta apagado. Avisa al docente; esta ventana seguira esperando.",
    `No se pudo preparar el editor | ${privateRepo}`,
  ]);
  assert.equal(oauthWindow.currentHref, `${BACKEND}/auth/github/callback?code=x&state=estado`);
  assert.equal(tab.popups.length, 1);
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

// Codespaces con el modelo de boton unico del tunel (auditoria, item 2): la GitHub App se
// detecta sola tras abrir la instalacion (contrato (d)) y el PR y el Codespace se siguen creando.
async function openCodespacesTour(browser: FakeBrowser) {
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false && tab.state().workspaceProvider === "codespaces", 400);
  return tab;
}

const CODESPACES_TOUR_REMOVED_IDS = [
  "setupToStep2Btn",
  "setupStepTwoCard",
  "setupStepThreeCard",
  "setupInstallAppBtn",
  "setupRefreshAppBtn",
  "setupBackToStep1Btn",
  "setupToStep3Btn",
  "setupCreatePrBtn",
  "setupBackToStep2Btn",
  "setupContinueBtn",
  "setupExploreBtn",
  "processNoticeModal",
  "processNoticeConfirmBtn",
];

test("Codespaces: boton unico, la GitHub App se detecta sola y se crean el PR y el Codespace (item 2, contrato (d))", async () => {
  const browser = new FakeBrowser();
  browser.provider = "codespaces";
  seedLoggedInBrowser(browser, {
    // Un editor de tunel guardado de antes no cambia el flujo de Codespaces.
    adaceenEditorByUser: {
      [`${SESSION.user.id}:${REPO}`]: { repoFullName: REPO, webUrl: TUNNEL_URL, provider: "tunnel", savedAt: "2026-09-24T15:00:00.000Z" },
    },
  });
  const tab = await openCodespacesTour(browser);
  // El icono entra directo tambien con Codespaces (sin «Empezar»).
  assert.equal(tab.state().started, true, "sin pulsar Empezar");

  // Una tarjeta (el repositorio) y un solo boton: sin «Autorizar repositorio», «Abrir
  // instalacion», «Verificar acceso», «Preparar entorno», «Crear PR», «Ir al dashboard» ni
  // el aviso «Entendido».
  assert.equal(tab.el("setupView").hidden, false, "sin setup completo se muestra el tour");
  assert.equal(tab.el("setupViewTitle").textContent, "Preparar repositorio");
  assert.equal(tab.el("setupStepOneTitle").textContent, "Tu repositorio");
  assert.equal(tab.el("setupStepOneCard").hidden, false);
  const markup = tab.run<string>("buildOverlayMarkup()");
  for (const id of CODESPACES_TOUR_REMOVED_IDS) {
    assert.doesNotMatch(markup, new RegExp(`id="${id}"`), `sin ${id}`);
  }
  assert.doesNotMatch(markup, /Verificar acceso|Entendido|Abrir instalacion/);
  assert.equal(tab.el("setupDetectRepoBtn").hidden, true, "el repo ya sale de la pagina");
  assert.equal(tab.el("setupOpenLocalVscodeBtn").disabled, false, "VS Code de este equipo sigue a mano");
  assert.equal(tab.el("setupPrimaryActionBtn").dataset.contextAction, "connect_github", "pide la GitHub App");
  assert.equal(tab.el("setupPrimaryActionBtn").textContent, "Autorizar GitHub App");
  assert.equal(tab.el("setupSecondaryActionBtn").hidden, true, "boton unico");
  const setupStatus = () => tab.run<string>("(() => { const flow = getSetupFlowState(overlayState.context); return buildSetupStatusText(overlayState.context, resolveCurrentSetupStep(flow), flow); })()");
  assert.match(setupStatus(), /^Paso 2\/3: instala o autoriza la GitHub App/);
  assert.ok(browser.requestsTo("/api/github-app/status").length >= 1, "con Codespaces si se consulta la GitHub App");
  const rows = tab.run<Array<{ label: string; status: string }>>("buildConnectionItems(overlayState.context, getSetupFlowState(overlayState.context))");
  assert.deepEqual(Array.from(rows, (item) => item.label), ["ADACEEN", "GitHub App", "GitHub OAuth", "Codespaces"]);
  tab.run("overlayState.setupWizardStep = 3");
  assert.equal(tab.run("resolveCurrentSetupStep(getSetupFlowState(overlayState.context))"), 2, "sin App no se pasa al paso 3");

  // Al llegar al paso de la App se intento una vez vincular una instalacion hecha fuera del
  // enlace (aqui no la hay: 404) antes de pedir que se abra la pestana de instalacion.
  assert.equal(browser.requestsTo("/api/github-app/link-installation-auto", "POST").length, 1, "una vinculacion al entrar");

  // 1) «Autorizar GitHub App» abre la instalacion (sin opener) y ADACEEN consulta el estado
  // cada pocos segundos: sin «Verificar acceso».
  const statusBefore = browser.requestsTo("/api/github-app/status").length;
  const linksBefore = browser.requestsTo("/api/github-app/link-installation-auto", "POST").length;
  await drive(browser, tab.el("setupPrimaryActionBtn").click());
  assert.equal(tab.popups.length, 1);
  const installWindow = tab.popups[0];
  assert.match(installWindow.currentHref, /^https:\/\/github\.com\/apps\/[^/]+\/installations\/new/);
  assert.equal(installWindow.opener, null, "la pagina de GitHub no alcanza la pestana del overlay");
  assert.equal(tab.run("isWatchingGithubAppInstall()"), true);
  assert.equal(tab.el("setupActionTitle").textContent, "Esperando la GitHub App");
  assert.match(setupStatus(), /^Paso 2\/3: termina la instalacion de la GitHub App en la pestana de GitHub\. ADACEEN la detecta sola/);
  assert.equal(tab.el("setupOperationBanner").hidden, false);
  assert.equal(tab.el("setupOperationTitle").textContent, "Esperando la GitHub App");
  assert.equal(tab.el("setupPrimaryActionBtn").textContent, "Autorizar GitHub App", "si cerro la pestana, la vuelve a abrir");
  assert.equal(tab.el("setupSecondaryActionBtn").hidden, true);
  await advance(browser, 13_000);
  const polled = browser.requestsTo("/api/github-app/status").length - statusBefore;
  assert.ok(polled >= 3 && polled <= 4, `consulta cada 4 s (${polled} consultas en 13 s)`);
  assert.equal(browser.requestsTo("/api/github-app/link-installation-auto", "POST").length - linksBefore, 1, "prueba vincular una instalacion hecha fuera del enlace");

  // La pagina de retorno de la App registra la instalacion: el tour avanza solo.
  browser.appStatus = { configured: true, installation: { accountLogin: "alumno" }, hasRepoAccess: true, bootstrapReady: false };
  await advance(browser, 4_500);
  assert.equal(tab.run("isWatchingGithubAppInstall()"), false, "deja de consultar al detectarla");
  assert.equal(tab.el("setupPrimaryActionBtn").dataset.contextAction, "connect_github_user");
  assert.equal(tab.el("setupPrimaryActionBtn").textContent, "Conectar GitHub");
  assert.equal(tab.el("setupSecondaryActionBtn").hidden, true);
  assert.equal(tab.el("setupOperationBanner").hidden, true);
  assert.match(tab.el("setupStatusText").textContent, new RegExp(`^GitHub App lista: ya tiene acceso a ${REPO}\\. Ahora pulsa Conectar GitHub`));
  const afterDetect = browser.requestsTo("/api/github-app/status").length;
  await advance(browser, 30_000);
  assert.equal(browser.requestsTo("/api/github-app/status").length, afterDetect, "sin consultas despues de detectarla");
  assert.equal(browser.requestsTo("/api/github-app/install-url", "POST").length, 1);

  // 2) «Conectar GitHub»: OAuth y, al volver, el PR y el Codespace se crean y se abren en esa
  // misma ventana (sin «Preparar entorno ADACEEN» ni «Entendido»).
  await drive(browser, tab.el("setupPrimaryActionBtn").click());
  assert.equal(tab.popups.length, 2);
  const oauthWindow = tab.popups[1];
  assert.match(oauthWindow.currentHref, /^https:\/\/github\.com\/login\/oauth\/authorize/);
  browser.githubConnected = true;
  browser.githubCodespaceScope = true;
  oauthWindow.location.href = `${BACKEND}/auth/github/callback?code=x&state=estado`;
  const oauthDone = tab.dispatchWindowEvent("message", { data: { type: "ADACEEN_GITHUB_OAUTH_CONNECTED" }, origin: BACKEND });
  await browser.clock.until(() => oauthWindow.currentHref === CODESPACE_URL, 400);
  await oauthDone;
  assert.equal(oauthWindow.currentHref, CODESPACE_URL, "la ventana del OAuth termina en el Codespace");
  assert.equal(oauthWindow.closed, false);
  assert.equal(tab.popups.length, 2, "sin ventanas extra");
  const prepared = browser.requestsTo("/github/prepare-environment", "POST");
  assert.equal(prepared.length, 1, "un PR y un Codespace");
  assert.equal(prepared[0].body?.repoFullName, REPO);
  assert.equal(prepared[0].body?.mode, "pr-codespace");
  assert.match(String(prepared[0].body?.devcontainerJson), /adaceen\.adaceen/);
  assert.deepEqual(browser.requestsTo("/api/workspaces/prepare"), [], "con Codespaces no se prepara el tunel");
  assert.equal((browser.storage.adaceenSetupDoneByUser as Json)?.[EDITOR_KEY], true);
  await browser.clock.until(() => tab.el("mainView").hidden === false, 50);
  assert.equal(tab.el("mainView").hidden, false, "tras crear el Codespace se entra al panel");
  assert.equal(tab.el("contextPrimaryActionBtn").dataset.contextAction, "open_codespaces");
  assert.equal(tab.el("contextPrimaryActionBtn").textContent, "Abrir Codespace de la PR");

  // En el panel principal con Codespaces, la tuerca conserva los ajustes de la GitHub App.
  tab.run("overlayState.settingsOpen = true; renderOverlay()");
  assert.equal(tab.el("advancedGithubBlock").hidden, false, "Codespaces sigue con «Rehacer PR devcontainer»");
  assert.equal(tab.el("githubAppSection").hidden, false);
  assert.deepEqual(browser.unknownRoutes.filter((route) => !route.includes("/api/projects")), []);
  assertKnownShadowIds(tab);
});

test("Codespaces: la espera de la GitHub App tiene limite, se corta al cerrar y entra si el repo ya estaba preparado", async () => {
  // Nunca se instala: a los 5 min deja de consultar y lo dice.
  const browser = new FakeBrowser();
  browser.provider = "codespaces";
  seedLoggedInBrowser(browser);
  const tab = await openCodespacesTour(browser);
  const before = browser.requestsTo("/api/github-app/status").length;
  await drive(browser, tab.el("setupPrimaryActionBtn").click());
  await advance(browser, 6 * 60_000);
  assert.equal(tab.run("isWatchingGithubAppInstall()"), false);
  const polled = browser.requestsTo("/api/github-app/status").length - before;
  assert.ok(polled >= 70 && polled <= 80, `con limite (${polled} consultas en 5 min)`);
  assert.match(tab.el("setupStatusText").textContent, /ADACEEN dejo de esperar la GitHub App\. Si ya la instalaste, pulsa Autorizar GitHub App de nuevo/);
  assert.equal(tab.el("setupOperationBanner").hidden, true);
  assert.equal(tab.el("setupPrimaryActionBtn").dataset.contextAction, "connect_github");

  // Cerrar el overlay corta la espera.
  await drive(browser, tab.el("setupPrimaryActionBtn").click());
  assert.equal(tab.run("isWatchingGithubAppInstall()"), true);
  await drive(browser, tab.run("closeOverlay({ reason: 'user' })"));
  assert.equal(tab.run("isWatchingGithubAppInstall()"), false);
  const afterClose = browser.requestsTo("/api/github-app/status").length;
  await advance(browser, 20_000);
  assert.equal(browser.requestsTo("/api/github-app/status").length, afterClose, "sin consultas con el overlay cerrado");

  // El repo ya tenia la preparacion de ADACEEN (PR de otro companero): al detectar la App se
  // entra al panel, que ofrece abrir el Codespace de esa PR.
  const ready = new FakeBrowser();
  ready.provider = "codespaces";
  seedLoggedInBrowser(ready);
  const readyTab = await openCodespacesTour(ready);
  await drive(ready, readyTab.el("setupPrimaryActionBtn").click());
  ready.appStatus = {
    configured: true,
    installation: { accountLogin: "alumno" },
    hasRepoAccess: true,
    bootstrapReady: true,
    bootstrapPullNumber: 3,
    bootstrapCodespaceUrl: `https://codespaces.new/${REPO}/pull/3`,
  };
  await advance(ready, 4_500);
  assert.equal(readyTab.run("isWatchingGithubAppInstall()"), false);
  await ready.clock.until(() => readyTab.el("mainView").hidden === false, 50);
  assert.equal(readyTab.el("mainView").hidden, false, "setup completo sin otro clic");
  assert.equal(readyTab.el("contextPrimaryActionBtn").dataset.contextAction, "open_codespaces");
  assert.match(readyTab.state().statusMessage, /GitHub App lista: .* ya tenia la configuracion ADACEEN/);
  assert.deepEqual(ready.requestsTo("/github/prepare-environment"), [], "sin clic no se abre ninguna ventana");

  // Con la App y la cuenta (scope codespace) ya listas: un boton, «Preparar entorno ADACEEN»,
  // abre la ventana de espera en el mismo clic y termina en el Codespace, sin «Entendido».
  const connected = new FakeBrowser();
  connected.provider = "codespaces";
  connected.githubConnected = true;
  connected.githubCodespaceScope = true;
  connected.appStatus = { configured: true, installation: { accountLogin: "alumno" }, hasRepoAccess: true, bootstrapReady: false };
  seedLoggedInBrowser(connected);
  const connectedTab = await openCodespacesTour(connected);
  assert.equal(connectedTab.el("setupView").hidden, false);
  assert.equal(connectedTab.el("setupPrimaryActionBtn").dataset.contextAction, "create_bootstrap_pr");
  assert.equal(connectedTab.el("setupPrimaryActionBtn").textContent, "Preparar entorno ADACEEN");
  assert.equal(connectedTab.el("setupSecondaryActionBtn").hidden, true, "sin «Volver» ni «Actualizar estado»");
  assert.match(connectedTab.el("setupActionCopy").textContent, /puede tardar cerca de 2 minutos/);
  await drive(connected, connectedTab.el("setupPrimaryActionBtn").click(), 2000);
  await connected.clock.until(() => connectedTab.popups[0]?.currentHref === CODESPACE_URL, 400);
  assert.equal(connectedTab.popups.length, 1, "la ventana de espera del mismo clic");
  assert.equal(connectedTab.popups[0].currentHref, CODESPACE_URL);
  assert.equal(connected.requestsTo("/github/prepare-environment", "POST").length, 1);
  assert.equal(connectedTab.state().processNoticeOpen, undefined, "sin el aviso «Entendido»");
  assertKnownShadowIds(tab, readyTab, connectedTab);
});

test("al abrir el overlay: sin «Empezar», y sin pedir ayuda al tutor cuando entra solo", async () => {
  // Restaurado en vscode.dev (tunel, con el editor guardado) o en Campus: entra sin «Empezar»,
  // sin pedir ayuda al tutor y sin reportarse como pestana activa hasta que el estudiante lo usa.
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
    assert.equal(tab.state().started, true, `${url}: entra sin «Empezar»`);
    assert.equal(tab.el("mainView").hidden, false, `${url}: panel principal`);
    assert.deepEqual(browser.requestsTo("/intervene"), [], `${url}: sin pedir ayuda al tutor`);
    assert.deepEqual(browser.requestsTo("/github-mentor"), []);
    assert.deepEqual(activeTabReports(browser), [], `${url}: sin active_tab_seen`);
    assert.equal(browser.requestsTo("/api/auth/me").length, 1, `${url}: la sesion se confirma una vez`);
    assert.ok(browser.requestsTo("/api/rag/courses").length <= 1, `${url}: los cursos se piden una vez`);
    assertKnownShadowIds(tab);

    if (url === TUNNEL_URL) {
      // vscode.dev (item 4): textos del editor, no de Codespaces, y el repo del editor guardado.
      assert.equal(tab.run("getCurrentRepoFullName()"), REPO, "el repo sale del editor guardado con ese tunel");
      assert.equal(tab.el("contextActionTitle").textContent, "Tutor en tu editor");
      assert.equal(tab.el("contextSecondaryActionBtn").hidden, true, "sin «Reintentar OCR» (ya esta «OCR visual»)");
      assert.equal(tab.el("mainContext").textContent, "Tu editor en la nube");
      assert.equal(tab.el("contextTitle").textContent, "Editor en la nube detectado");
      assert.equal(tab.el("analyzeProjectBtn").hidden, false, "«Explorar repo» dentro del editor");
      assert.equal(tab.el("rerunOcrBtn").hidden, false);
      assert.equal(tab.el("analyzeProjectBtn").textContent, "Explorar repo");
      assert.equal(tab.el("rerunOcrBtn").textContent, "OCR visual", "en el editor, no «Sincronizar agenda»");
      for (const text of [
        tab.el("statusText").textContent,
        tab.el("welcomeCopy").textContent,
        tab.el("contextActionCopy").textContent,
        tab.el("vscodeSyncMeta").textContent,
      ]) {
        assert.doesNotMatch(String(text), /Codespace/, `sin Codespaces en vscode.dev: ${text}`);
      }
      tab.run("overlayState.analysisWindowOpen = true; renderOverlay()");
      assert.equal(tab.el("analysisTitle").textContent, "Analisis de archivos en tu editor");
      assert.equal(tab.el("analysisStats").textContent, "Pulsa Explorar repo para leer archivos y carpetas del explorador.", "cita el boton que existe");
      tab.run("overlayState.analysisWindowOpen = false; renderOverlay()");
      // «Copiar codigo para VS Code» (item 6): mientras VS Code no se conecta sigue a mano; con
      // VS Code conectado (la VM ya escribio la sesion) no se muestra.
      assert.equal(tab.el("vscodeSyncSection").hidden, false);
      assert.equal(tab.el("vscodeCopySessionBtn").hidden, false);
      browser.latestRack = { id: "rack-1", source: "vscode_extension", repoFullName: REPO, updatedAt: new Date(browser.clock.now - 60_000).toISOString() };
      await drive(browser, tab.run("refreshVscodeSyncState({ silent: true }).then(() => renderOverlay())"));
      assert.equal(tab.state().vscodeSyncState.fresh, true);
      assert.equal(tab.el("vscodeCopySessionBtn").hidden, true, "con VS Code conectado no hace falta el codigo");
      assert.match(tab.el("vscodeSyncMeta").textContent, /sincronizado con este editor/);
      // Con el proyecto leido, pedir ayuda es «Actualizar» de la cabecera (Ctrl+Enter): la accion
      // recomendada ya no lo repite con «Solicitar tutoria».
      assert.equal(tab.el("contextPrimaryActionBtn").hidden, true, "sin «Solicitar tutoria»");
      assert.match(tab.el("contextActionCopy").textContent, /Pulsa Actualizar \(Ctrl\+Enter\) para pedir una guia contextual\./);
      assert.equal(tab.el("refreshBtn").hidden, false);
      assert.equal(tab.el("refreshBtn").disabled, false);
      // El primer clic en el overlay la vuelve pestana activa; el tutor responde cuando se pide.
      await Promise.all((tab.shadowListeners.get("pointerdown") || []).map((listener) => listener({ type: "pointerdown" })));
      await browser.clock.until(() => activeTabReports(browser).length > 0, 50);
      assert.equal(activeTabReports(browser).length, 1);
      await drive(browser, tab.el("refreshBtn").click(), 2000);
      assert.equal(browser.requestsTo("/intervene").length + browser.requestsTo("/github-mentor").length, 1, "«Actualizar» pide ayuda");
    }
  }

  // Con el icono y sin editor guardado (lo normal con Codespaces) entra como «Empezar»: confirma
  // la sesion una vez, pide los cursos una vez (antes dos) y el tutor responde una vez.
  const browser = new FakeBrowser();
  browser.provider = "codespaces";
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);
  assert.equal(tab.state().started, true);
  assert.equal(browser.requestsTo("/api/auth/me").length, 1);
  assert.equal(browser.requestsTo("/api/rag/courses").length, 1);
  assert.equal(browser.requestsTo("/intervene").length + browser.requestsTo("/github-mentor").length, 1, "como «Empezar», el tutor responde una vez");

  // Sin sesion, el icono muestra el login directamente (sin pasar por «Empezar»).
  const anonymous = new FakeBrowser();
  anonymous.storage = { adaceenClientId: "cliente-prueba-123" };
  const loginTab = await openTab(anonymous, `https://github.com/${REPO}`, REPO);
  await drive(anonymous, loginTab.run("openOverlay({ trigger: 'user' })"));
  await anonymous.clock.until(() => !loginTab.run("savedEditorAutoEnterInFlight"), 50);
  assert.equal(loginTab.el("welcomeView").hidden, true);
  assert.equal(loginTab.el("authView").hidden, false, "el login a la vista");
  assert.deepEqual(anonymous.requestsTo("/api/auth/me"), []);

  // Sesion vencida (otro inicio de sesion la cerro): el login con el motivo, sin entrar.
  const expired = new FakeBrowser();
  seedLoggedInBrowser(expired);
  expired.sessionValid = false;
  const expiredTab = await openTab(expired, `https://github.com/${REPO}`, REPO);
  await drive(expired, expiredTab.run("openOverlay({ trigger: 'user' })"));
  await expired.clock.until(() => !expiredTab.run("savedEditorAutoEnterInFlight"), 50);
  assert.equal(expiredTab.el("authView").hidden, false);
  assert.equal(expiredTab.state().authError, "La sesion ya no es valida. Inicia sesion nuevamente.");
  assert.equal(expired.storage.adaceenSessionId, "", "la sesion vencida se olvida");
  assert.equal(expired.storage.adaceenActiveSessionSnapshot, undefined);
  assertKnownShadowIds(tab, loginTab, expiredTab);
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
  // Sin editor guardado el boton de la pestana de ADACEEN es «Preparar mi editor» (item 3).
  assert.match(statusOf(lateVisit), /ADACEEN ya no espera este codigo\. .*pulsa "Preparar mi editor"/);

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
  assert.match(statusOf(deviceTab), /ADACEEN dejo de esperar\. Tu editor ya tiene otro repositorio abierto\. .*"Preparar mi editor"/);
  assert.doesNotMatch(statusOf(deviceTab), /Abrir mi editor/, "el mensaje cita el boton que se ve");
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
  assert.match(tab.state().statusMessage, /actualiza su extension de ADACEEN .*la anterior no acepta codigos/, "avisa a quien tiene VS Code 0.0.30 o anterior");
  assert.doesNotMatch(tab.state().statusMessage, new RegExp(SESSION.id));

  // Fallo pasajero (503): el repo se abre sin codigo y la sesion del navegador NO se copia.
  browser.pairingMode = "fail";
  await drive(browser, tab.run("openLocalVscodeClone()"));
  assert.equal(tab.openedLinks[1], `vscode://adaceen.adaceen/abrir?repo=${REPO}`);
  assert.match(tab.state().statusMessage, /ADACEEN: sin conectar/);
  assert.equal(await drive(browser, tab.run("copyEditorPairingCodeForVscode()")), false);
  assert.match(tab.state().statusMessage, /Pulsa Copiar codigo para VS Code de nuevo/);
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

// ---- Auditoria de redundancias (navegador 0.7.12, tanda 1: estudiante y tunel) ----

async function loginFromOverlay(browser: FakeBrowser, tab: TabEnv) {
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 50);
  assert.equal(tab.el("authView").hidden, false, "sin sesion el icono muestra el login");
  tab.el("authEmail").value = SESSION.user.email;
  tab.el("authPassword").value = "clave-del-piloto";
  await drive(browser, tab.el("authSubmitBtn").click(), 2000);
  await browser.clock.until(() => tab.state().loading === false && tab.state().authBusy === false, 400);
}

test("privacidad en el backend: «Aceptar y continuar» una sola vez en cualquier navegador (contrato (a))", async () => {
  // Primer navegador, backend nuevo sin aceptacion: se pregunta y la aceptacion va al backend.
  const first = new FakeBrowser();
  first.storage = { adaceenClientId: "cliente-prueba-123" };
  first.privacy = { version: null, acceptedAt: null };
  first.firstLogin = true;
  const tab = await openTab(first, `https://github.com/${REPO}`, REPO);
  await loginFromOverlay(first, tab);
  assert.equal(tab.el("firstLoginModal").hidden, false, "la primera vez se pregunta");
  await drive(first, tab.el("firstLoginConfirmBtn").click());
  await first.clock.until(() => first.privacyAcceptances.length > 0, 50);
  assert.deepEqual(first.privacyAcceptances, [{ version: "2026-05-26" }]);
  assert.equal(tab.el("firstLoginModal").hidden, true);
  assert.equal((first.storage.adaceenPrivacyAcceptedByUser as Json)?.[SESSION.user.id], "2026-05-26");

  // Otro navegador o equipo: el backend ya tiene esta version aceptada, no se vuelve a preguntar.
  const second = new FakeBrowser();
  second.storage = { adaceenClientId: "cliente-otro-456" };
  second.privacy = { version: "2026-05-26", acceptedAt: "2026-09-25T12:00:00.000Z" };
  const secondTab = await openTab(second, `https://github.com/${REPO}`, REPO);
  await loginFromOverlay(second, secondTab);
  assert.equal(secondTab.state().firstLoginConfirmationOpen, false);
  assert.equal(secondTab.el("firstLoginModal").hidden, true, "sin el modal en el segundo navegador");
  assert.deepEqual(second.requestsTo("/api/auth/privacy-acceptance"), []);
  assert.equal((second.storage.adaceenPrivacyAcceptedByUser as Json)?.[SESSION.user.id], "2026-05-26");

  // Backend anterior (sin el campo privacy ni la ruta, 404): se pregunta y queda solo aqui.
  const old = new FakeBrowser();
  old.storage = { adaceenClientId: "cliente-viejo-789" };
  const oldTab = await openTab(old, `https://github.com/${REPO}`, REPO);
  await loginFromOverlay(old, oldTab);
  assert.equal(oldTab.el("firstLoginModal").hidden, false);
  await drive(old, oldTab.el("firstLoginConfirmBtn").click());
  await old.clock.until(() => old.requestsTo("/api/auth/privacy-acceptance").length > 0, 50);
  assert.equal(oldTab.el("firstLoginModal").hidden, true, "un 404 no deja el modal abierto");
  assert.equal((old.storage.adaceenPrivacyAcceptedByUser as Json)?.[SESSION.user.id], "2026-05-26");
  await drive(old, oldTab.run("fetchCurrentSession()"));
  assert.equal(oldTab.state().firstLoginConfirmationOpen, false, "lo guardado aqui sigue valiendo");

  // Aceptada en este navegador antes de 0.7.12 (solo `true` en local) y backend nuevo sin
  // registro: no se vuelve a preguntar y se registra en el backend.
  const legacy = new FakeBrowser();
  seedLoggedInBrowser(legacy);
  legacy.privacy = { version: null, acceptedAt: null };
  const legacyTab = await openTab(legacy, `https://github.com/${REPO}`, REPO);
  await drive(legacy, legacyTab.run("openOverlay({ trigger: 'user' })"));
  await legacy.clock.until(() => !legacyTab.run("savedEditorAutoEnterInFlight"), 400);
  await legacy.clock.until(() => legacy.privacyAcceptances.length > 0, 50);
  assert.equal(legacyTab.el("firstLoginModal").hidden, true);
  assert.deepEqual(legacy.privacyAcceptances, [{ version: "2026-05-26" }]);
  assertKnownShadowIds(tab, secondTab, oldTab, legacyTab);
});

test("otro navegador: si el backend ya tiene el editor, se ofrece «Abrir mi editor» sin el tour (item 11)", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  browser.githubConnected = true;
  browser.statusSteps = [browser.ready()];
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.el("mainView").hidden === false, 100);
  assert.equal(tab.el("setupView").hidden, true, "sin el tour");
  assert.equal(tab.el("contextPrimaryActionBtn").dataset.contextAction, "open_my_editor");
  assert.equal(tab.el("contextPrimaryActionBtn").textContent, "Abrir mi editor");
  assert.equal(browser.requestsTo("/api/workspaces/status").length, 1, "una consulta al entrar");
  const adopted = (browser.storage.adaceenEditorByUser as Json)?.[EDITOR_KEY] as Json;
  assert.equal(adopted?.webUrl, TUNNEL_URL);
  assert.equal(adopted?.sessionWrittenAt, "", "sin fecha de sesion: el primer clic pasa por prepare");

  // El primer «Abrir mi editor» pasa por prepare (renueva la sesion de VS Code en la VM) y abre.
  browser.prepareSteps = [browser.ready()];
  const from = browser.requests.length;
  await drive(browser, tab.el("contextPrimaryActionBtn").click(), 2000);
  await browser.clock.until(() => tab.popups[0]?.currentHref === TUNNEL_URL, 400);
  assert.equal(tab.popups[0]?.currentHref, TUNNEL_URL);
  assert.equal(workspaceRequestsSince(browser, from)[0], "POST /api/workspaces/prepare");

  // Sin editor en el backend sigue el tour con «Preparar mi editor» y no se repite la consulta.
  const other = new FakeBrowser();
  seedLoggedInBrowser(other);
  other.githubConnected = true;
  other.statusSteps = [other.notFound()];
  const otherTab = await openTab(other, `https://github.com/${REPO}`, REPO);
  await drive(other, otherTab.run("openOverlay({ trigger: 'user' })"));
  await other.clock.until(() => !otherTab.run("savedEditorAutoEnterInFlight"), 400);
  await other.clock.until(() => otherTab.state().loading === false, 100);
  assert.equal(otherTab.el("setupView").hidden, false);
  assert.equal(otherTab.el("setupPrimaryActionBtn").textContent, "Preparar mi editor");
  await drive(other, otherTab.run("refreshMentorSession({ trigger: 'manual', requestedAt: Date.now() })"), 2000);
  assert.equal(other.requestsTo("/api/workspaces/status").length, 1, "una sola vez por pagina");

  // Sin la cuenta de GitHub conectada no puede haber editor: no se consulta.
  const noGithub = new FakeBrowser();
  seedLoggedInBrowser(noGithub);
  const noGithubTab = await openTab(noGithub, `https://github.com/${REPO}`, REPO);
  await drive(noGithub, noGithubTab.run("openOverlay({ trigger: 'user' })"));
  await noGithub.clock.until(() => !noGithubTab.run("savedEditorAutoEnterInFlight"), 400);
  assert.deepEqual(noGithub.requestsTo("/api/workspaces/status"), []);
  assertKnownShadowIds(tab, otherTab, noGithubTab);
});

test("docente en github.com: entra al panel, no al tour del estudiante (item 8)", async () => {
  const browser = new FakeBrowser();
  browser.session = { ...SESSION, user: { ...SESSION.user, role: "teacher", assignedCourseCodes: [] } };
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);
  assert.equal(tab.run("isTeacherSession()"), true);
  assert.equal(tab.el("setupView").hidden, true, "sin «Conectar GitHub» del estudiante");
  assert.equal(tab.el("mainView").hidden, false);
  // Tampoco la accion del estudiante en el panel: ni «Preparar mi editor» (que prepararia un
  // editor a su nombre para el repositorio de un estudiante) ni la consulta del editor.
  assert.equal(tab.el("contextActionTitle").textContent, "Panel docente");
  assert.equal(tab.el("contextPrimaryActionBtn").dataset.contextAction, "open_settings");
  assert.equal(tab.el("contextPrimaryActionBtn").textContent, "Configuracion");
  // Su forma de conectar VS Code sigue a mano (guia, 4.2: «Abrir en VS Code de este equipo»).
  assert.equal(tab.el("contextSecondaryActionBtn").hidden, false);
  assert.equal(tab.el("contextSecondaryActionBtn").dataset.contextAction, "open_local_vscode");
  assert.equal(tab.el("contextSecondaryActionBtn").textContent, "Abrir en VS Code de este equipo");
  await advance(browser, 2_000);
  assert.deepEqual(browser.requestsTo("/api/workspaces/status"), [], "sin buscar un editor del docente");
  await drive(browser, tab.el("contextPrimaryActionBtn").click(), 400);
  assert.equal(tab.state().settingsOpen, true, "abre la tuerca (quiz, politica y piloto)");
  assert.deepEqual(browser.requestsTo("/api/workspaces/prepare"), []);
  assertKnownShadowIds(tab);
});

test("un solo boton para cerrar sesion: «Salir» de la cabecera (item 12)", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  const markup = tab.run<string>("buildOverlayMarkup()");
  assert.doesNotMatch(markup, /id="setupLogoutBtn"/, "sin «Cerrar sesion» en el tour");
  assert.doesNotMatch(markup, /id="logoutSettingsBtn"/, "sin «Cerrar sesion» en la tuerca");
  assert.match(markup, /id="logoutHeaderBtn"/);
  // La tuerca se abre bajo la cabecera, asi que «Salir» sigue a la vista con ella abierta.
  const styleProps: Record<string, string> = {};
  tab.el("window").style.setProperty = (name: string, value: string) => { styleProps[name] = value; };
  tab.run("overlayState.settingsOpen = true; renderOverlay()");
  assert.equal(styleProps["--adaceen-settings-top"], "480px", "la altura de la cabecera");
  assert.match(tab.run<string>("OVERLAY_STYLES"), /\.settings-panel \{\s+position: absolute;\s+inset: var\(--adaceen-settings-top, 0px\) 0 0 0;/);
  await drive(browser, tab.el("logoutHeaderBtn").click(), 400);
  assert.equal(tab.state().session, null);
  assert.equal(tab.state().settingsOpen, false, "la tuerca se cierra al salir");
  assert.equal(tab.el("authView").hidden, false);
  assertKnownShadowIds(tab);
});

test("Mac del laboratorio: al volver otro dia la accion principal es la ultima eleccion (item 13)", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);
  // Primer dia: «Abrir en VS Code de este equipo» desde la tarjeta del tour.
  await drive(browser, tab.el("setupOpenLocalVscodeBtn").click());
  assert.equal(tab.openedLinks.length, 1);
  assert.equal((browser.storage.adaceenEditorChoiceByUser as Json)?.[SESSION.user.id], "local_vscode");
  assert.equal(tab.el("mainView").hidden, false);
  assert.equal(tab.el("contextPrimaryActionBtn").dataset.contextAction, "open_local_vscode");

  // Otro dia, mismo navegador: la accion principal sigue siendo VS Code de este equipo y el
  // editor en la nube queda de segundo boton.
  const nextDay = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, nextDay.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !nextDay.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => nextDay.state().loading === false, 400);
  assert.equal(nextDay.el("mainView").hidden, false);
  assert.equal(nextDay.el("contextPrimaryActionBtn").dataset.contextAction, "open_local_vscode");
  assert.equal(nextDay.el("contextPrimaryActionBtn").textContent, "Abrir en VS Code de este equipo");
  assert.equal(nextDay.el("contextSecondaryActionBtn").dataset.contextAction, "open_my_editor");
  assert.equal(nextDay.el("contextSecondaryActionBtn").textContent, "Preparar mi editor");
  // La eleccion es por usuario: el texto no afirma que este repo ya se abrio ahi ni que haya
  // un editor en la nube que aun no existe.
  assert.equal(
    nextDay.el("contextActionCopy").textContent,
    `La ultima vez usaste el VS Code de este equipo: abre ${REPO} ahi con un clic. Si prefieres el editor en la nube, pulsa Preparar mi editor.`,
  );

  // Si elige el editor en la nube, esa pasa a ser la principal.
  browser.githubConnected = true;
  browser.prepareSteps = [browser.ready()];
  await drive(browser, nextDay.el("contextSecondaryActionBtn").click(), 2000);
  await browser.clock.until(() => nextDay.popups[0]?.currentHref === TUNNEL_URL, 400);
  assert.equal((browser.storage.adaceenEditorChoiceByUser as Json)?.[SESSION.user.id], "cloud");
  nextDay.run("renderOverlay()");
  assert.equal(nextDay.el("contextPrimaryActionBtn").dataset.contextAction, "open_my_editor");
  assert.equal(nextDay.el("contextPrimaryActionBtn").textContent, "Abrir mi editor");
  assertKnownShadowIds(tab, nextDay);
});

test("sin botones repetidos: paginas sin repo y «Autodetectar» (items 5 y 13)", async () => {
  // github.com sin repositorio y sin editor guardado: «Actualizar» de la cabecera basta.
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, "https://github.com/", "GitHub");
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);
  assert.equal(tab.el("mainView").hidden, false);
  assert.equal(tab.el("contextActionTitle").textContent, "Buscar contexto");
  assert.equal(tab.el("contextPrimaryActionBtn").hidden, true, "sin «Actualizar contexto»");
  assert.equal(tab.el("contextSecondaryActionBtn").hidden, true);
  assert.equal(tab.el("refreshBtn").hidden, false);
  const rows = tab.run<Array<{ label: string }>>("buildConnectionItems(overlayState.context, getSetupFlowState(overlayState.context))");
  assert.deepEqual(Array.from(rows, (item) => item.label), ["ADACEEN", "Editor"], "sin filas «No requerido» ni «No detectado»");
  // Con el tutor pausado «Actualizar» esta deshabilitado: la accion recomendada conserva
  // «Actualizar contexto», que si funciona.
  tab.run("overlayState.assistantEnabled = false; renderOverlay()");
  assert.equal(tab.el("refreshBtn").disabled, true);
  assert.equal(tab.el("contextPrimaryActionBtn").hidden, false);
  assert.equal(tab.el("contextPrimaryActionBtn").textContent, "Actualizar contexto");
  assert.equal(tab.el("contextPrimaryActionBtn").dataset.contextAction, "refresh_mentor");
  assert.doesNotMatch(tab.el("contextActionCopy").textContent, /pulsa Actualizar\./);
  const tutorBefore = browser.requestsTo("/intervene").length + browser.requestsTo("/github-mentor").length;
  await drive(browser, tab.el("contextPrimaryActionBtn").click(), 2000);
  assert.equal(browser.requestsTo("/intervene").length + browser.requestsTo("/github-mentor").length, tutorBefore, "con el tutor pausado no se le pregunta");
  tab.run("overlayState.assistantEnabled = true; renderOverlay()");
  assert.equal(tab.el("contextPrimaryActionBtn").hidden, true);

  // Con un editor guardado: «Abrir mi editor» y nada mas (antes tambien «Actualizar contexto»).
  const saved = new FakeBrowser();
  seedLoggedInBrowser(saved, { adaceenEditorByUser: { [EDITOR_KEY]: savedEditorRecord(saved) } });
  const savedTab = await openTab(saved, "https://github.com/", "GitHub");
  await drive(saved, savedTab.run("openOverlay({ trigger: 'user' })"));
  await saved.clock.until(() => !savedTab.run("savedEditorAutoEnterInFlight"), 400);
  assert.equal(savedTab.el("contextPrimaryActionBtn").dataset.contextAction, "open_my_editor");
  assert.equal(savedTab.el("contextSecondaryActionBtn").hidden, true);

  // Tour del tunel sin repositorio: «Autodetectar repositorio» es la accion recomendada y el
  // «Autodetectar» de la tarjeta no la repite.
  const repoTab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, repoTab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !repoTab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => repoTab.state().loading === false, 400);
  repoTab.run("setSetupRepoFullName(''); overlayState.context = { ...overlayState.context, url: 'https://github.com/', repoFullName: '', pageType: 'github_general', links: [], title: '' }; renderOverlay()");
  assert.equal(repoTab.el("setupPrimaryActionBtn").dataset.contextAction, "detect_repo");
  assert.equal(repoTab.el("setupDetectRepoBtn").hidden, true, "un solo «Autodetectar»");
  assertKnownShadowIds(tab, savedTab, repoTab);
});

test("mensajes y boton del editor dicen lo mismo (item 3)", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("syncFromStorageSnapshot({ force: true })"));
  tab.run("overlayState.context = buildPayload()");
  assert.equal(tab.run("myEditorButtonLabel()"), "Preparar mi editor");
  await drive(browser, tab.run(`saveTunnelEditor("${REPO}", "${TUNNEL_URL}")`));
  assert.equal(tab.run("myEditorButtonLabel()"), "Abrir mi editor");
});

// ---- Auditoria de redundancias (navegador 0.7.12, tanda 2: Codespaces, docente y Campus) ----

function campusBrowser() {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  return browser;
}

async function openCampusCourse(browser: FakeBrowser) {
  const tab = await openTab(browser, CAMPUS_COURSE_URL, "FPOO: Curso");
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false && !tab.run("isCampusAccessVerificationInFlight()"), 400);
  return tab;
}

test("Campus: el acceso se verifica solo al entrar y queda una sola accion (item 10)", async () => {
  const browser = campusBrowser();
  const tab = await openCampusCourse(browser);
  assert.equal(tab.el("mainView").hidden, false);
  // Verificado en silencio: una consulta, sin pisar el mensaje de estado y sin «Verificar acceso».
  assert.equal(browser.requestsTo("/api/documents/bitacora/status").length, 1, "una verificacion al entrar");
  assert.doesNotMatch(String(tab.state().statusMessage), /Acceso confirmado|Verificando bitacora/);
  assert.equal(tab.state().campusCourseAccess.accessConfirmed, true);
  assert.equal(tab.el("contextActionTitle").textContent, "Agenda Campus");
  assert.equal(tab.el("contextPrimaryActionBtn").dataset.contextAction, "analyze_project");
  assert.equal(tab.el("contextPrimaryActionBtn").textContent, "Analizar Campus");
  assert.equal(tab.el("contextSecondaryActionBtn").hidden, true, "sin «Verificar acceso» al lado");
  // La cabecera del resumen ya no repite «Analizar Campus» ni «Sincronizar agenda».
  assert.equal(tab.el("analyzeProjectBtn").hidden, true);
  assert.equal(tab.el("rerunOcrBtn").hidden, true);
  const rows = tab.run<Array<{ label: string }>>("buildConnectionItems(overlayState.context, getSetupFlowState(overlayState.context))");
  assert.deepEqual(Array.from(rows, (item) => item.label), ["ADACEEN", "Campus", "Editor"]);

  // «Analizar Campus» no vuelve a verificar y, con fechas, la accion pasa a «Sincronizar agenda».
  await drive(browser, tab.el("contextPrimaryActionBtn").click(), 2000);
  assert.equal(browser.requestsTo("/api/campus/analyze-page", "POST").length, 1);
  assert.equal(browser.requestsTo("/api/documents/bitacora/status").length, 1, "el acceso ya estaba confirmado");
  tab.run("overlayState.analysisWindowOpen = false; renderOverlay()");
  assert.equal(tab.el("contextPrimaryActionBtn").dataset.contextAction, "sync_campus_calendar");
  assert.equal(tab.el("contextPrimaryActionBtn").textContent, "Sincronizar agenda");
  assert.equal(tab.el("contextSecondaryActionBtn").hidden, true);

  // Al actualizar no se vuelve a pedir un acceso ya confirmado.
  await drive(browser, tab.run("refreshMentorSession({ trigger: 'manual', requestedAt: Date.now() })"), 2000);
  assert.equal(browser.requestsTo("/api/documents/bitacora/status").length, 1);
  assertKnownShadowIds(tab);
});

test("Campus: si la verificacion falla o falta la bitacora, «Verificar acceso» es la unica accion (item 10)", async () => {
  // Fallo del backend: un boton para reintentar, sin pares repetidos.
  const browser = campusBrowser();
  browser.bitacoraStatus = 500;
  const tab = await openCampusCourse(browser);
  assert.equal(tab.el("contextActionTitle").textContent, "Confirmar acceso");
  assert.match(tab.el("contextActionCopy").textContent, /No se pudo confirmar acceso al curso/);
  // El fallo tambien va al estado (role=status) para los lectores de pantalla.
  assert.match(tab.el("statusText").textContent, /No se pudo confirmar acceso al curso/);
  assert.equal(tab.el("contextPrimaryActionBtn").textContent, "Verificar acceso");
  assert.equal(tab.el("contextSecondaryActionBtn").hidden, true, "un solo curso: sin «Elegir curso»");
  browser.bitacoraStatus = 200;
  await drive(browser, tab.el("contextPrimaryActionBtn").click(), 2000);
  assert.equal(browser.requestsTo("/api/documents/bitacora/status").length, 2);
  assert.equal(tab.el("contextPrimaryActionBtn").textContent, "Analizar Campus");

  // Sin bitacora cargada por el docente: «Verificar acceso» una vez (antes con «Actualizar acceso»).
  const noLog = campusBrowser();
  noLog.bitacoraLatest = null;
  const noLogTab = await openCampusCourse(noLog);
  assert.equal(noLogTab.el("contextActionTitle").textContent, "Bitacora requerida");
  assert.match(noLogTab.el("contextActionCopy").textContent, /tu docente aun no carga la bitacora/);
  assert.match(noLogTab.el("statusText").textContent, /falta cargar bitacora/);
  assert.equal(noLogTab.el("contextPrimaryActionBtn").textContent, "Verificar acceso");
  assert.equal(noLogTab.el("contextSecondaryActionBtn").hidden, true);

  // Mientras verifica al entrar: «Verificando...» deshabilitado, sin otro boton.
  const slow = campusBrowser();
  slow.delays["/api/documents/bitacora/status"] = 3000;
  const slowTab = await openTab(slow, CAMPUS_COURSE_URL, "FPOO: Curso");
  await drive(slow, slowTab.run("openOverlay({ trigger: 'user' })"));
  await slow.clock.until(() => slow.requestsTo("/api/documents/bitacora/status").length > 0, 400);
  slowTab.run("renderOverlay()");
  assert.equal(slowTab.el("contextActionTitle").textContent, "Confirmando curso");
  assert.equal(slowTab.el("contextPrimaryActionBtn").disabled, true);
  assert.equal(slowTab.el("contextSecondaryActionBtn").hidden, true);
  await slow.clock.until(() => !slowTab.run("isCampusAccessVerificationInFlight()"), 400);
  assert.equal(slowTab.el("contextPrimaryActionBtn").textContent, "Analizar Campus");
  assertKnownShadowIds(tab, noLogTab, slowTab);
});

test("docente: una sola casilla de mini quiz y los avisos del backend en «Lanzar quiz» e «Iniciar bloque 1» (item 9, contratos (b) y (c))", async () => {
  const browser = new FakeBrowser();
  browser.session = { ...SESSION, user: { ...SESSION.user, role: "teacher", assignedCourseCodes: [] } };
  browser.policy = {
    policyName: "RF-05 base del piloto",
    allowMiniQuiz: false,
    allowedInterventions: ["explanation", "hint", "example"],
    quizSettings: { triggers: ["after_accept"], everyNAccepts: 1, maxPerSession: null, followUpOnWrong: true },
  };
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);
  tab.run("overlayState.settingsOpen = true; renderOverlay()");
  await advance(browser, 1_000);
  assert.equal(tab.el("teacherSettingsBlock").hidden, false);

  // «Mini quiz» de «Intervenciones habilitadas» ya no existe: «Permitir mini quiz» escribe las dos cosas.
  const markup = tab.run<string>("buildOverlayMarkup()");
  assert.doesNotMatch(markup, /id="teacherAllowMiniQuizType"/);
  assert.doesNotMatch(markup, /<span>Mini quiz<\/span>/);
  assert.match(markup, /Permitir mini quiz/);
  assert.equal(tab.el("teacherMiniQuiz").checked, false);
  assert.equal(tab.el("teacherQuizTeacherLaunch").checked, false);

  // «Lanzar quiz» con el quiz apagado: el backend lo activa (contrato (c)) y el overlay muestra
  // su mensaje y marca las casillas, sin borrar lo que el docente tenia sin guardar.
  const autoEnabledPolicy = {
    ...browser.policy,
    allowMiniQuiz: true,
    quizSettings: { triggers: ["teacher_launch"], everyNAccepts: 1, maxPerSession: null, followUpOnWrong: true },
  };
  // Texto de POST /api/quiz/launches (src/routes/quiz-routes.ts) con el mini quiz apagado.
  const launchMessage = "Quiz lanzado. Se activo «Permitir mini quiz» con «Cuando yo lo lance a la clase» en tus parametros para que llegue a tus estudiantes.";
  browser.quizLaunchReply = { autoEnabled: true, message: launchMessage, policy: autoEnabledPolicy };
  browser.policy = autoEnabledPolicy;
  tab.el("teacherPolicyName").value = "Politica sin guardar";
  tab.el("teacherQuizTopic").value = "encapsulamiento";
  await drive(browser, tab.el("teacherQuizLaunchBtn").click(), 2000);
  assert.equal(browser.requestsTo("/api/quiz/launches", "POST").length, 1);
  assert.ok(tab.el("teacherQuizStatus").textContent.startsWith(launchMessage), tab.el("teacherQuizStatus").textContent);
  assert.match(tab.el("teacherQuizStatus").textContent, /Activo: "encapsulamiento"/);
  assert.equal(tab.el("teacherMiniQuiz").checked, true);
  assert.equal(tab.el("teacherQuizTeacherLaunch").checked, true);
  assert.equal(tab.el("teacherQuizAfterAccept").checked, false);
  tab.run("renderOverlay()");
  assert.equal(tab.el("teacherPolicyName").value, "Politica sin guardar", "lo no guardado se conserva");
  assert.equal(tab.el("teacherMiniQuiz").checked, true);

  // «Guardar cambios» no apaga lo que el backend activo y escribe el tipo mini_quiz con la misma casilla.
  await drive(browser, tab.el("saveSettingsBtn").click(), 2000);
  let saved = browser.requestsTo("/api/policies/current", "PUT").at(-1)?.body as Json;
  assert.equal(saved?.policyName, "Politica sin guardar");
  assert.equal(saved?.allowMiniQuiz, true);
  assert.deepEqual(saved?.allowedInterventions, ["explanation", "hint", "example", "mini_quiz"]);
  assert.deepEqual((saved?.quizSettings as Json)?.triggers, ["teacher_launch"]);
  // Apagar la casilla quita las dos cosas.
  tab.run("overlayState.settingsOpen = true; renderOverlay()");
  tab.el("teacherMiniQuiz").checked = false;
  await drive(browser, tab.el("saveSettingsBtn").click(), 2000);
  saved = browser.requestsTo("/api/policies/current", "PUT").at(-1)?.body as Json;
  assert.equal(saved?.allowMiniQuiz, false);
  assert.deepEqual(saved?.allowedInterventions, ["explanation", "hint", "example"]);

  // «Iniciar bloque 1» sin «Asignar grupos A y B» antes: el backend los asigna (contrato (b)) y el
  // estado lo dice despues del bloque en curso.
  tab.run("overlayState.settingsOpen = true; renderOverlay()");
  // Texto de PUT /api/pilot/block (src/routes/pilot-routes.ts) cuando asigna los grupos solo.
  const blockMessage = "Grupos A y B asignados automaticamente al iniciar el bloque (2 estudiantes; semilla: user-teacher-demo:2026-09-25).";
  browser.pilotBlockReply = { assignedAutomatically: true, added: 2, message: blockMessage };
  await drive(browser, tab.el("teacherPilotBlock1Btn").click(), 2000);
  assert.deepEqual(browser.requestsTo("/api/pilot/assign"), [], "sin asignar antes");
  assert.equal(
    tab.el("teacherPilotStatus").textContent,
    `En curso: bloque 1 (A con tutor, B sin tutor). Grupo A: 1, grupo B: 1. ${blockMessage}`,
  );
  assert.equal(tab.el("teacherPilotBlock1Btn").getAttribute("aria-pressed"), "true");
  assert.match(markup, /Si aún no hay grupos, iniciar un bloque los asigna solo/);
  // Sin aviso (los grupos ya estaban): solo el estado.
  browser.pilotBlockReply = null;
  await drive(browser, tab.el("teacherPilotBlock2Btn").click(), 2000);
  assert.equal(tab.el("teacherPilotStatus").textContent, "En curso: bloque 2 (A sin tutor, B con tutor). Grupo A: 1, grupo B: 1.");
  assertKnownShadowIds(tab);
});

// ---- Revision de las tandas 1 y 2 (navegador 0.7.12) ----

function tutorRequests(browser: FakeBrowser) {
  return browser.requestsTo("/intervene").length + browser.requestsTo("/github-mentor").length;
}

async function restoreTab(browser: FakeBrowser, url: string, title: string) {
  const tab = await openTab(browser, url, title);
  await browser.clock.until(() => tab.run("overlayHost?.isConnected") === true, 400);
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);
  return tab;
}

test("ventanas del flujo de GitHub con el overlay fijado: sin entrar, sin repositorio falso ni aviso de otra pestana", async () => {
  // Las rutas de GitHub no son un owner: ni la ventana del OAuth ni la instalacion de la App
  // tienen repositorio.
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser, { adaceenOverlayPinned: true });
  // La pestana del overlay sigue activa unos segundos despues de abrir la ventana del OAuth.
  browser.activeTab = {
    isActive: true,
    tabId: "pestana-del-overlay",
    tabTitle: REPO,
    tabUrl: `https://github.com/${REPO}`,
    viewContext: `github | github_general | ${REPO}`,
  };
  const oauthTab = await restoreTab(browser, "https://github.com/login/oauth/authorize?client_id=prueba&state=estado", "Authorize application");
  await advance(browser, 3_000);
  assert.equal(oauthTab.state().started, false, "la ventana del OAuth no entra sola");
  assert.equal(oauthTab.el("welcomeView").hidden, false);
  assert.equal(oauthTab.el("setupView").hidden, true, "sin el tour ni «Conectar GitHub» encima de Authorize");
  assert.equal(oauthTab.el("tabConflictModal").hidden, true, "sin «Sesion activa en otra pestaña»");
  assert.equal(oauthTab.run("buildPayload().pageType"), "other");
  assert.equal(oauthTab.run("getCurrentRepoFullName()"), "", "login/oauth no es un repositorio");
  for (const route of ["/api/auth/me", "/github-mentor", "/intervene", "/api/workspaces/provider", "/api/github/oauth/status", "/api/github-app/status", "/api/ui/active-tab"]) {
    assert.deepEqual(browser.requestsTo(route), [], `la ventana del OAuth no pide ${route}`);
  }
  for (const url of [
    "https://github.com/login/oauth/authorize?client_id=prueba",
    "https://github.com/apps/adaceen-piloto/installations/new?state=estado-app",
    "https://github.com/settings/installations",
    "https://github.com/orgs/univalle-fpoo/repositories",
  ]) {
    assert.equal(oauthTab.run(`parseRepoFullName(${JSON.stringify(url)})`), "", url);
    assert.equal(oauthTab.run(`isGithubFlowPageUrl(${JSON.stringify(url)})`), true, url);
  }
  assert.equal(oauthTab.run(`parseRepoFullName("https://github.com/${REPO}/blob/main/src/Main.java")`), REPO);
  assert.equal(oauthTab.run(`isGithubFlowPageUrl("https://github.com/${REPO}")`), false);

  // Con Codespaces, la pestana de instalacion de la App tampoco entra ni consulta la App con
  // un repositorio "apps/adaceen-piloto".
  const codespaces = new FakeBrowser();
  codespaces.provider = "codespaces";
  seedLoggedInBrowser(codespaces, { adaceenOverlayPinned: true });
  const installTab = await restoreTab(codespaces, "https://github.com/apps/adaceen-piloto/installations/new?state=estado-app", "Install ADACEEN");
  await advance(codespaces, 3_000);
  assert.equal(installTab.state().started, false);
  assert.equal(installTab.el("setupView").hidden, true);
  assert.equal(installTab.run("getCurrentRepoFullName()"), "");
  assert.deepEqual(codespaces.requestsTo("/api/github-app/status"), []);
  assert.deepEqual(codespaces.requestsTo("/api/auth/me"), []);

  // Una pagina con repositorio restaurada mientras otra pestana tiene la sesion activa: se queda
  // en la bienvenida, sin el aviso de conflicto.
  const repoTab = await restoreTab(browser, `https://github.com/${REPO}`, REPO);
  await advance(browser, 3_000);
  assert.equal(repoTab.state().started, false);
  assert.equal(repoTab.el("welcomeView").hidden, false);
  assert.equal(repoTab.el("tabConflictModal").hidden, true, "sin el aviso al restaurar");
  assert.notEqual(repoTab.state().statusMessage, "Esta sesión ya está activa en otra pestaña.");
  assert.equal(tutorRequests(browser), 0);
  // Sin otra pestana activa, esa misma pagina entra sola, sin el tutor.
  browser.activeTab = null;
  const freeRepoTab = await restoreTab(browser, `https://github.com/${REPO}`, REPO);
  assert.equal(freeRepoTab.state().started, true, "con un repositorio si entra al restaurar");
  assert.equal(tutorRequests(browser), 0);

  // Una pagina sin contexto y sin un editor guardado: «Empezar», sin consultar el backend.
  const empty = new FakeBrowser();
  seedLoggedInBrowser(empty, { adaceenOverlayPinned: true });
  const emptyTab = await restoreTab(empty, "https://github.com/", "GitHub");
  assert.equal(emptyTab.state().started, false);
  assert.equal(emptyTab.el("welcomeView").hidden, false);
  assert.deepEqual(empty.requestsTo("/api/auth/me"), []);
  assertKnownShadowIds(oauthTab, installTab, repoTab, freeRepoTab, emptyTab);
});

test("privacidad pendiente: la pagina no va al tutor hasta «Aceptar y continuar»", async () => {
  // Sesion guardada sin la aceptacion (el estudiante cerro el overlay con el modal abierto) y
  // backend sin registro: el icono entra, pero el tutor no recibe el archivo abierto.
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: {} });
  browser.privacy = { version: null, acceptedAt: null };
  const tab = await openTab(browser, `https://github.com/${REPO}/blob/main/src/Main.java`, "Main.java");
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);
  assert.equal(tab.el("firstLoginModal").hidden, false, "se pregunta");
  assert.equal(tutorRequests(browser), 0, "sin pedir ayuda al tutor antes de aceptar");
  await drive(browser, tab.el("firstLoginConfirmBtn").click(), 2000);
  await browser.clock.until(() => tab.state().loading === false, 400);
  assert.deepEqual(browser.privacyAcceptances, [{ version: "2026-05-26" }]);
  assert.equal(tutorRequests(browser), 1, "al aceptar, el tutor responde una vez");

  // Primer inicio de sesion: igual, el tutor espera a la aceptacion.
  const fresh = new FakeBrowser();
  fresh.storage = { adaceenClientId: "cliente-nuevo-321" };
  fresh.privacy = { version: null, acceptedAt: null };
  fresh.firstLogin = true;
  const loginTab = await openTab(fresh, `https://github.com/${REPO}/blob/main/src/Main.java`, "Main.java");
  await loginFromOverlay(fresh, loginTab);
  assert.equal(loginTab.el("firstLoginModal").hidden, false);
  assert.equal(tutorRequests(fresh), 0);
  await drive(fresh, loginTab.el("firstLoginConfirmBtn").click(), 2000);
  await fresh.clock.until(() => loginTab.state().loading === false, 400);
  assert.equal(tutorRequests(fresh), 1);
  assertKnownShadowIds(tab, loginTab);
});

test("al abrir con el backend frio, «Preparando...» dura como mucho 10 s y el icono entra igual", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  browser.delays["/api/auth/me"] = 200_000;
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await advance(browser, 1_000);
  assert.equal(tab.el("startBtn").textContent, "Preparando...");
  assert.equal(tab.el("startBtn").disabled, true);
  await browser.clock.until(() => tab.state().started === true, 400);
  assert.ok(browser.clock.now - Date.parse("2026-09-25T13:00:00.000Z") < 15_000, "entra antes de 15 s (antes, hasta 120 s)");
  assert.equal(tab.state().started, true, "como «Empezar»");
  assertKnownShadowIds(tab);
});

test("Codespaces: una GitHub App ya instalada en la organizacion se vincula sin abrir la pestana de instalacion", async () => {
  const browser = new FakeBrowser();
  browser.provider = "codespaces";
  browser.appAutoLink = true;
  seedLoggedInBrowser(browser);
  const tab = await openCodespacesTour(browser);
  await browser.clock.until(() => tab.el("setupPrimaryActionBtn").dataset.contextAction === "connect_github_user", 400);
  assert.equal(browser.requestsTo("/api/github-app/link-installation-auto", "POST").length, 1);
  assert.equal(tab.el("setupPrimaryActionBtn").textContent, "Conectar GitHub", "el paso de la App se salta solo");
  assert.equal(tab.popups.length, 0, "sin abrir la instalacion");
  assert.deepEqual(browser.requestsTo("/api/github-app/install-url"), []);
  assert.match(tab.state().statusMessage, new RegExp(`^GitHub App lista: ya tiene acceso a ${REPO}\\. Ahora pulsa Conectar GitHub`));
  // Una vez por usuario y repositorio: al actualizar no se vuelve a intentar.
  await drive(browser, tab.run("refreshMentorSession({ trigger: 'manual', requestedAt: Date.now() })"), 2000);
  assert.equal(browser.requestsTo("/api/github-app/link-installation-auto", "POST").length, 1);

  // Con el tunel no se intenta nunca (la App no interviene).
  const tunnel = new FakeBrowser();
  tunnel.appAutoLink = true;
  seedLoggedInBrowser(tunnel);
  const tunnelTab = await openTab(tunnel, `https://github.com/${REPO}`, REPO);
  await drive(tunnel, tunnelTab.run("openOverlay({ trigger: 'user' })"));
  await tunnel.clock.until(() => !tunnelTab.run("savedEditorAutoEnterInFlight"), 400);
  await tunnel.clock.until(() => tunnelTab.state().loading === false, 400);
  await advance(tunnel, 2_000);
  assert.deepEqual(tunnel.requestsTo("/api/github-app/link-installation-auto"), []);
  assertKnownShadowIds(tab, tunnelTab);
});

test("otro navegador: si la cuenta cambia mientras se consulta el editor, no se guarda a nombre de la nueva", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  browser.githubConnected = true;
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("syncFromStorageSnapshot({ force: true })"));
  tab.run("overlayState.context = buildPayload()");
  await drive(browser, tab.run("refreshGithubIntegrationStatus()"));
  browser.statusSteps = [browser.ready()];
  browser.delays["/api/workspaces/status"] = 6_000;
  const pending = tab.run("adoptExistingTunnelEditor()");
  await browser.clock.settle();
  assert.equal(browser.requestsTo("/api/workspaces/status").length, 1);
  // En la Mac compartida: sale y entra otra cuenta en la misma pestana antes de la respuesta.
  tab.run("overlayState.session = { ...overlayState.session, id: 'sess-otro', user: { ...overlayState.session.user, id: 'u-otro' } }; overlayState.sessionId = 'sess-otro'");
  assert.equal(await drive(browser, pending), false);
  assert.deepEqual(browser.storage.adaceenEditorByUser ?? {}, {}, "el editor de la cuenta anterior no se guarda");
});
