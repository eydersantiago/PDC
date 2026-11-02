import type { Json, Listener } from "./harness-config.js";
import type { TabEnv } from "./harness-tab.js";

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

const SHADOW_HOST_TAGS = new Set(["article", "aside", "blockquote", "body", "div", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "main", "nav", "p", "section", "span"]);

export class FakeElement {
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
  // Un evento que sube por los padres, como en el navegador (0.8.5: los eventos de mouse que
  // ADACEEN manda a VS Code).
  dispatchEvent(event: any) {
    let stopped = false;
    let node: FakeElement | FakeShadowRoot | null = this;
    while (node instanceof FakeElement && !stopped) {
      const currentTarget = node;
      for (const listener of node.listeners.get(event.type) || []) {
        listener({ ...event, type: event.type, target: this, currentTarget, preventDefault() {}, stopPropagation() { stopped = true; } });
      }
      node = node.parentNode;
    }
    return true;
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
    // Como en el navegador: solo algunos elementos admiten shadow root (un <li> lanza).
    if (!SHADOW_HOST_TAGS.has(this.tagName.toLowerCase()) && !this.tagName.includes("-")) {
      throw new Error(`NotSupportedError: Failed to execute 'attachShadow' on 'Element': This element does not support attachShadow (${this.tagName})`);
    }
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
export class FakeShadowRoot {
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

const GITHUB_NON_REPO_SECTIONS = new Set(["settings", "advisories", "resources", "solutions", "orgs", "marketplace", "sponsors", "topics", "login"]);

export class FakeDocument {
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
  // Selectores que la prueba quiere que existan (p. ej. la cabecera de un repositorio de GitHub).
  selectors = new Map<string, FakeElement>();
  querySelector(selector: string) {
    const set = this.selectors.get(selector);
    if (set) return set;
    // Como GitHub: la pagina de un repositorio publica su owner/repo en esta meta; las demas
    // (ajustes, avisos de seguridad, recursos...) no, aunque su URL tenga dos tramos.
    if (selector === 'meta[name="octolytics-dimension-repository_nwo"]') return this.githubRepoMeta();
    return null;
  }
  githubRepoMeta() {
    const url = new URL(String(this.env.window?.location?.href || this.env.url));
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname !== "github.com" || parts.length < 2 || GITHUB_NON_REPO_SECTIONS.has(parts[0].toLowerCase())) return null;
    const meta = new FakeElement("meta", this.env);
    meta.setAttribute("content", `${parts[0]}/${parts[1]}`);
    return meta;
  }
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
export class FakePopup {
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
