import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { shiftBitacoraAgendaToStart } from "../../src/services/bitacora-dates.js";
import { extractBitacoraAgenda, extractDocumentText } from "../../src/services/document-classifier.js";

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

const SHADOW_HOST_TAGS = new Set(["article", "aside", "blockquote", "body", "div", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "main", "nav", "p", "section", "span"]);

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

const GITHUB_NON_REPO_SECTIONS = new Set(["settings", "advisories", "resources", "solutions", "orgs", "marketplace", "sponsors", "topics", "login"]);

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

// Resumen de un estudiante como lo devuelve GET /api/admin/students (services/student-progress.ts).
function studentProgressFixture(id: string, displayName: string, email: string, grade: Json): Json {
  const withQuizzes = grade.score !== null;
  return {
    id,
    displayName,
    email,
    isActive: true,
    createdAt: "2026-09-01T12:00:00.000Z",
    teacherUserId: "u-docente",
    teacherDisplayName: "Docente Prueba",
    assignedCourseCodes: ["FPOO"],
    pilotCohort: withQuizzes ? "A" : null,
    sessions: { total: withQuizzes ? 3 : 0, browser: withQuizzes ? 2 : 0, editor: withQuizzes ? 1 : 0, cli: 0, active: withQuizzes ? 1 : 0, firstSeenAt: withQuizzes ? "2026-09-20T12:00:00.000Z" : null, lastSeenAt: withQuizzes ? "2026-09-25T12:50:00.000Z" : null, activeNow: withQuizzes },
    interventions: { total: withQuizzes ? 3 : 0, blocked: withQuizzes ? 1 : 0, hints: withQuizzes ? 2 : 0, explanations: 0, examples: 0, miniQuizzes: 0, lastAt: withQuizzes ? "2026-09-25T12:10:00.000Z" : null },
    quizzes: { total: withQuizzes ? 2 : 0, answered: withQuizzes ? 2 : 0, correct: withQuizzes ? 1 : 0, correctRate: withQuizzes ? 50 : null, followUps: withQuizzes ? 1 : 0, averageFollowUpScore: withQuizzes ? 80 : null, skipped: 0, lastAt: withQuizzes ? "2026-09-25T12:20:00.000Z" : null },
    activity: { events: withQuizzes ? 4 : 0, byCategory: withQuizzes ? { tutor: 4 } : {}, totalDurationMs: 0, lastAt: withQuizzes ? "2026-09-25T12:30:00.000Z" : null },
    exercises: { total: withQuizzes ? 1 : 0, hints: withQuizzes ? 2 : 0, lastAt: withQuizzes ? "2026-09-25T12:10:00.000Z" : null },
    grade: { ...grade, correctRate: withQuizzes ? 50 : null, averageFollowUpScore: withQuizzes ? 80 : null, formula: withQuizzes ? "60 % aciertos (50) + 40 % seguimiento (80)." : "Sin quices respondidos." },
    lastActivityAt: withQuizzes ? "2026-09-25T12:50:00.000Z" : null,
  };
}

class FakeBrowser {
  clock = new VirtualClock();
  storage: Record<string, unknown> = {};
  storageListeners: Array<(changes: Json, area: string) => void> = [];
  requests: Array<{ method: string; path: string; query: string; body: Json | null; headers: Record<string, string>; at: number }> = [];
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
  // Respuesta del tutor (POST /intervene): sin pistas salvo que la prueba las ponga en result.
  tutorReply: Json = { ideas: [], guide: [], welcome: "", summary: "" };
  // Estado HTTP de POST /intervene (0.7.18): 404 es un backend sin la ruta; 503, un fallo pasajero.
  interveneStatus = 200;
  // Usuarios administrables (GET/PUT /api/admin/users) y fuentes RAG por curso (0.7.14).
  adminUsers: Json[] = [
    { id: "u-est-1", role: "student", email: "ana.maria.perez.gonzalez@correounivalle.edu.co", displayName: "Ana María Pérez González", teacherUserId: "u-docente", teacherDisplayName: "Docente Prueba", assignedCourseCodes: ["FPOO"], isActive: true, createdAt: "2026-09-01T12:00:00.000Z" },
    { id: "u-est-2", role: "student", email: "bruno@correounivalle.edu.co", displayName: "Bruno Prueba", teacherUserId: "u-docente", teacherDisplayName: "Docente Prueba", assignedCourseCodes: ["FPOO", "FPI"], isActive: false, createdAt: "2026-09-01T12:00:00.000Z" },
  ];
  adminUserUpdates: Array<{ id: string; body: Json | null }> = [];
  ragSources: Json[] = [
    { id: "RAG-FPOO-17", courseCode: "FPOO", scope: "default", title: "Conceptos basicos", fileName: "conceptos.html", sourceType: "web_page", textLength: 48000, createdAt: "2026-08-20T12:00:00.000Z" },
    { id: "RAG-T-01", courseCode: "FPOO", scope: "teacher", title: "Taller 2", fileName: "taller-2.pdf", sourceType: "document", textLength: 9800, createdAt: "2026-09-20T12:00:00.000Z" },
    { id: "RAG-FPI-01", courseCode: "FPI", scope: "default", title: "Estructuras de control", fileName: "control.html", sourceType: "web_page", textLength: 30000, createdAt: "2026-08-20T12:00:00.000Z" },
  ];
  ragDeletes: string[] = [];
  // POST /api/rag/sources (fuentes del docente, una por peticion) y los archivos que el backend rechaza.
  ragUploads: Json[] = [];
  ragUploadFailures: string[] = [];
  // Pestana Estudiantes (0.7.13): GET /api/admin/students y /api/admin/students/:id.
  students: Json[] = [
    studentProgressFixture("u-est-1", "Ana Prueba", "ana@correounivalle.edu.co", { score: 73, scale5: 3.7, level: "medio", label: "Medio" }),
    studentProgressFixture("u-est-2", "Bruno Prueba", "bruno@correounivalle.edu.co", { score: null, scale5: null, level: "sin_datos", label: "Sin quices" }),
  ];
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
  // Respuesta de POST /api/quiz/launches (contrato (c)). El piloto ya no se maneja desde el
  // overlay (0.7.15): va por npm run piloto:bloque.
  quizLaunchReply: Json | null = null;
  quizLaunches: Json[] = [];
  // Lotes de RAG (0.7.15): GET /api/rag/lots y sus cambios.
  ragLots: Json[] = [];
  ragActiveLots: Record<string, string> = {};
  ragDisabledSourceIds: string[] = [];
  ragStudentLots: Array<{ studentUserId: string; courseCode: string; lotId: string | null }> = [];
  // Banco de quices y quices hechos (0.7.15).
  customQuizzes: Json[] = [];
  quizAttempts: Json[] = [];
  customQuizLaunches: string[] = [];
  closedLaunches: string[] = [];
  // Bitacoras subidas con POST /api/documents/bitacora/import (0.7.16): nombre de cada archivo.
  bitacoraUploads: string[] = [];
  // Google Calendar simulado (0.7.17): la cuenta de Google de Chrome, los eventos del calendario
  // principal y los mensajes que el overlay le manda al background.
  googleAccount = "alumno@correounivalle.edu.co";
  // Entorno de los estudiantes (0.7.19): GET/PUT /api/admin/workspace-provider. null es un
  // backend anterior (404); workspaceSettingPuts guarda lo que manda «Guardar cambios».
  workspaceSetting: Json | null = null;
  workspaceSettingPuts: Json[] = [];
  // «Iniciar clase» (0.7.21): GET /api/admin/clase/estado y POST /api/admin/clase/iniciar. null es
  // un backend anterior (404); classStarts cuenta los «Iniciar clase» recibidos.
  classStatus: Json | null = null;
  classStarts = 0;
  calendarEvents: Json[] = [];
  calendarMessages: Json[] = [];
  // Tema del piloto (0.7.21): GET/PUT /api/pilot/topic. Con pilotTopicStatus 404 es un backend
  // anterior; pilotTopicWeeks son las semanas de la bitacora del docente.
  pilotTopic: Json | null = null;
  pilotTopicStatus = 200;
  pilotTopicWeeks: Json[] = [];
  pilotTopicPuts: Json[] = [];
  // «Importar lista» y docente de las cuentas nuevas (0.7.21). defaultTeacher null: GET
  // /api/admin/users no lo trae (un docente o un backend anterior).
  adminTeachers: Json[] = [{ id: "u-docente", email: "docente@correounivalle.edu.co", displayName: "Docente Prueba" }];
  importRequests: Json[] = [];
  importStatus = 200;
  defaultTeacher: Json | null = null;
  defaultTeacherPuts: Json[] = [];
  createdUsers: Json[] = [];

  // Lo que hace background.js con la API de Google Calendar.
  backgroundMessage(message: Json): Json {
    this.calendarMessages.push(structuredClone(message));
    const privateProps = (event: Json) => ((event.extendedProperties as Json)?.private || {}) as Record<string, string>;
    switch (message.type) {
      case "ADACEEN_GOOGLE_CALENDAR_AUTHORIZE":
        return { ok: true };
      case "ADACEEN_GOOGLE_CALENDAR_ACCOUNT":
        return { ok: true, email: this.googleAccount };
      case "ADACEEN_GOOGLE_CALENDAR_LIST": {
        const query = (message.query || {}) as Json;
        const filters = ([] as string[]).concat((query.privateExtendedProperty as string[]) || []);
        const timeMin = query.timeMin ? Date.parse(String(query.timeMin)) : -Infinity;
        const timeMax = query.timeMax ? Date.parse(String(query.timeMax)) : Infinity;
        const events = this.calendarEvents.filter((event) => {
          const props = privateProps(event);
          if (!filters.every((filter) => { const [key, value] = filter.split("="); return props[key] === value; })) return false;
          const start = Date.parse(String((event.start as Json)?.dateTime || ""));
          return start >= timeMin && start <= timeMax;
        });
        return { ok: true, events: structuredClone(events) };
      }
      case "ADACEEN_GOOGLE_CALENDAR_INSERT": {
        const event = { ...(structuredClone(message.event) as Json), id: `evt-${this.calendarEvents.length + 1}`, htmlLink: `https://calendar.google.com/event?eid=evt-${this.calendarEvents.length + 1}` };
        this.calendarEvents.push(event);
        return { ok: true, event: structuredClone(event) };
      }
      case "ADACEEN_GOOGLE_CALENDAR_PATCH": {
        const event = this.calendarEvents.find((item) => item.id === message.eventId);
        if (!event) return { ok: false, error: "Not Found" };
        Object.assign(event, structuredClone(message.patch));
        return { ok: true, event: structuredClone(event) };
      }
      default:
        return { ok: false, error: "sin background en la simulacion" };
    }
  }

  sessionRole() {
    return String(((this.session as Json).user as Json)?.role || "");
  }

  // Catalogo de lotes como lo arma GET /api/rag/lots (src/routes/rag-routes.ts).
  ragLotCatalog() {
    const courses = ["FPI", "FPOO", "FPOE", "FPFC"].map((courseCode) => {
      const lots = this.ragLots.filter((lot) => lot.courseCode === courseCode).map((lot) => ({
        ...lot,
        sourceCount: this.ragSources.filter((source) => source.lotId === lot.id).length,
        activeSourceCount: this.ragSources.filter((source) => source.lotId === lot.id && !this.ragDisabledSourceIds.includes(String(source.id))).length,
        isCourseActive: this.ragActiveLots[courseCode] === lot.id,
      }));
      const active = lots.find((lot) => lot.isCourseActive) || null;
      const base = this.ragSources.filter((source) => source.courseCode === courseCode && !source.lotId);
      return {
        courseCode,
        courseName: courseCode,
        courseShortName: courseCode,
        activeLotId: active ? active.id : "",
        activeLotName: active ? active.name : "Base del curso",
        base: { sourceCount: base.length, activeSourceCount: base.filter((source) => !this.ragDisabledSourceIds.includes(String(source.id))).length, defaultCount: base.filter((source) => source.scope === "default").length, teacherCount: base.filter((source) => source.scope === "teacher").length },
        lots,
      };
    });
    return { baseLotName: "Base del curso", courses, disabledSourceIds: [...this.ragDisabledSourceIds] };
  }

  // «RAG aplicado» por estudiante y curso, como lo calcula GET /api/admin/users.
  appliedRagLots(user: Json) {
    const codes = Array.isArray(user.assignedCourseCodes) ? user.assignedCourseCodes as string[] : [];
    const out: Record<string, Json> = {};
    for (const code of codes) {
      const assigned = this.ragStudentLots.find((item) => item.studentUserId === user.id && item.courseCode === code);
      const assignedLot = assigned ? this.ragLots.find((lot) => lot.id === assigned.lotId) : null;
      const activeLot = this.ragLots.find((lot) => lot.id === this.ragActiveLots[code]) || null;
      out[code] = assignedLot
        ? { lotId: assignedLot.id, lotName: assignedLot.name, origin: "student" }
        : activeLot
          ? { lotId: activeLot.id, lotName: activeLot.name, origin: "teacher" }
          : { lotId: "", lotName: "Base del curso", origin: "base" };
    }
    return out;
  }

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
        sendMessage: (message: unknown, callback?: (response: unknown) => void) => {
          const response = browser.backgroundMessage((message || {}) as Json);
          if (callback) callback(response);
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
    this.requests.push({ method, path: url.pathname, query: url.search, body, headers: { ...(init.headers || {}) }, at: this.clock.now });
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
        return reply(200, {
          ok: true,
          courses: [
            { code: "FPI", name: "Fundamentos de programacion Imperativa", shortName: "Imperativa", materialUrl: "https://drive.google.com/x", isDefault: false },
            { code: "FPOO", name: "Fundamentos de programacion orientada a objetos", shortName: "FPOO", materialUrl: "https://drive.google.com/y", isDefault: true },
          ],
          assignedCourseCodes: ["FPOO"],
          defaultCourseCode: "FPOO",
        });
      case "POST /api/auth/logout":
        return reply(200, { ok: true });
      case "GET /api/ui/active-tab":
      case "POST /api/ui/active-tab":
        return reply(200, { ok: true, activeTab: this.activeTab });
      case "POST /api/behavior/events":
        return reply(200, { ok: true, accepted: 0 });
      case "GET /api/admin/clase/estado":
        if (!this.classStatus) return reply(404, { ok: false, error: "Ruta no encontrada." });
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        return reply(200, { ok: true, ...this.classStatus });
      case "POST /api/admin/clase/iniciar": {
        if (!this.classStatus) return reply(404, { ok: false, error: "Ruta no encontrada." });
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        this.classStarts += 1;
        // Como src/services/class-start.ts: la VM de editores y la primera GPU quedan "starting".
        const editors = this.classStatus.editors as Json | null;
        const gpus = (this.classStatus.gpus as Json[]) || [];
        this.classStatus = {
          ...this.classStatus,
          editors: editors ? { ...editors, state: "starting", startRequestedAt: new Date(this.clock.now).toISOString() } : null,
          gpus: gpus.map((gpu, index) => (index === 0 ? { ...gpu, state: "starting", startRequestedAt: new Date(this.clock.now).toISOString() } : gpu)),
          gpu: gpus.length ? "starting" : "none",
          requestedBy: "Admin Prueba (admin, u-admin)",
          requestedAt: new Date(this.clock.now).toISOString(),
        };
        return reply(200, {
          ok: true,
          ...this.classStatus,
          actions: ["instances.start adaceen-ws", "instances.start adaceen-worker-v100"],
          message: "Encendiendo la VM de editores (el agente se conecta en 1-2 min). Encendiendo la GPU adaceen-worker-v100 (2-5 min; la primera vez hasta 12).",
        });
      }
      case "GET /api/admin/workspace-provider":
        if (!this.workspaceSetting) return reply(404, { ok: false, error: "Ruta no encontrada." });
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        return reply(200, { ok: true, ...this.workspaceSetting });
      case "PUT /api/admin/workspace-provider": {
        if (!this.workspaceSetting) return reply(404, { ok: false, error: "Ruta no encontrada." });
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        this.workspaceSettingPuts.push(body || {});
        const requested = String(body?.provider || "");
        // Como src/routes/workspace-routes.ts: el tunel sin el agente configurado es 409.
        if (requested === "tunnel" && !this.workspaceSetting.agentConfigured) {
          const message = "Para usar el editor en la nube falta conectar la VM de editores una vez: corre bash deploy/produccion.sh aplicar en Cloud Shell.";
          return reply(409, { ok: false, code: "agent_not_configured", error: message, message });
        }
        const choice = requested === "server" ? null : requested;
        const provider = choice || String(this.workspaceSetting.serverProvider);
        this.workspaceSetting = {
          ...this.workspaceSetting,
          provider,
          choice,
          source: choice ? "extension" : "server",
          updatedAt: new Date(this.clock.now).toISOString(),
          updatedBy: "Admin Prueba",
        };
        this.provider = provider;
        const target = provider === "tunnel" ? "editor en la nube (túnel de VS Code)" : "GitHub Codespaces";
        return reply(200, {
          ok: true,
          ...this.workspaceSetting,
          message: `Entorno de los estudiantes: ${target}. Lo verán al recargar la página o en unos minutos.`,
          ...(provider === "tunnel" && this.workspaceSetting.agentOnline === false && !this.workspaceSetting.vmAutostart
            ? { warning: "La VM de editores está apagada: enciéndela antes de la clase con bash deploy/clase.sh iniciar." }
            : {}),
        });
      }
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
        if (this.interveneStatus !== 200) return reply(this.interveneStatus, { ok: false, error: `HTTP ${this.interveneStatus}` });
        return reply(200, { ok: true, ...this.tutorReply });
      case "POST /github-mentor":
        return reply(200, { ok: true, ...this.tutorReply });
      case "GET /api/admin/students":
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        return reply(200, {
          ok: true,
          generatedAt: new Date(this.clock.now).toISOString(),
          viewerRole: String((this.session as Json)?.user && ((this.session as Json).user as Json).role),
          totals: { students: this.students.length, activeNow: 1, withQuizzes: 1, averageGrade: 73, interventions: 3, blocked: 1 },
          students: this.students,
        });
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
      case "POST /api/rag/sources": {
        // Como src/routes/rag-routes.ts: una fuente del docente por peticion (multipart).
        const form = init.body instanceof FormData ? init.body : null;
        const file = form?.get("file") as { name?: string } | null;
        const fileName = String(file?.name || form?.get("title") || "fuente");
        this.ragUploads.push({ fileName, courseCode: String(form?.get("courseCode") || ""), lotId: String(form?.get("lotId") || "") });
        if (this.ragUploadFailures.includes(fileName)) return reply(422, { ok: false, error: "El archivo no tiene texto legible." });
        const source = { id: `RAG-T-${this.ragUploads.length + 10}`, courseCode: String(form?.get("courseCode") || "FPOO"), scope: "teacher", title: fileName, fileName, sourceType: "document", textLength: 1200, createdAt: new Date(this.clock.now).toISOString() };
        this.ragSources.push(source);
        return reply(200, { ok: true, source });
      }
      case "GET /api/rag/sources":
        return reply(200, {
          ok: true,
          courseCode: "FPOO",
          sources: this.ragSources.map((source) => ({ ...source, lotId: source.lotId || "", isEnabled: !this.ragDisabledSourceIds.includes(String(source.id)) })),
        });
      case "GET /api/admin/users":
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        return reply(200, {
          ok: true,
          users: this.adminUsers.map((user) => (user.role === "student" ? { ...user, ragLots: this.appliedRagLots(user) } : { ...user, ragLots: {} })),
          teachers: this.adminTeachers,
          ...(this.defaultTeacher && this.sessionRole() === "admin" ? { defaultTeacher: this.defaultTeacher } : {}),
        });
      case "POST /api/admin/users": {
        // Como src/routes/admin-routes.ts: un docente queda en teachers.
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        this.createdUsers.push(structuredClone(body || {}));
        const user = { id: `u-nuevo-${this.createdUsers.length}`, role: String(body?.role || "student"), email: String(body?.email || "").toLowerCase(), displayName: String(body?.displayName || ""), teacherUserId: null, assignedCourseCodes: [], isActive: true, createdAt: new Date(this.clock.now).toISOString() };
        if (user.role === "teacher") this.adminTeachers.push({ id: user.id, email: user.email, displayName: user.displayName });
        this.adminUsers.push(user);
        return reply(200, { ok: true, user });
      }
      case "POST /api/admin/users/import": {
        // Como importCourseMembers (src/db/repos/users.ts): por correo, crea, actualiza o se salta.
        if (this.importStatus !== 200) return reply(this.importStatus, { ok: false, error: "Ruta no encontrada." });
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        this.importRequests.push(structuredClone(body || {}));
        const role = this.sessionRole();
        const teacherUserId = role === "teacher" ? String((this.session.user as Json).id) : String(body?.teacherUserId || "u-docente");
        const teacher = this.adminTeachers.find((entry) => entry.id === teacherUserId);
        const courseCode = String(body?.courseCode || "FPOO");
        const result = { teacherUserId, courseCode, created: [] as Json[], updated: [] as Json[], unchanged: [] as Json[], skipped: [] as Json[] };
        for (const student of (body?.students as Json[]) || []) {
          const email = String(student.email || "").toLowerCase();
          const existing = this.adminUsers.find((user) => String(user.email).toLowerCase() === email);
          if (!existing) {
            const user = { id: `u-imp-${this.adminUsers.length + 1}`, role: "student", email, displayName: String(student.displayName || email), teacherUserId, teacherDisplayName: String(teacher?.displayName || ""), assignedCourseCodes: [courseCode], isActive: true, createdAt: new Date(this.clock.now).toISOString() };
            this.adminUsers.push(user);
            result.created.push({ id: user.id, email, displayName: user.displayName });
            continue;
          }
          if (existing.role !== "student") {
            result.skipped.push({ email, displayName: existing.displayName, reason: "Es docente en ADACEEN." });
            continue;
          }
          if (existing.isActive === false) {
            result.skipped.push({ email, displayName: existing.displayName, reason: "La cuenta esta desactivada: activala en la lista si debe entrar." });
            continue;
          }
          const codes = (existing.assignedCourseCodes as string[]) || [];
          const changes = [...(existing.teacherUserId !== teacherUserId ? ["docente"] : []), ...(codes.includes(courseCode) ? [] : ["curso"])];
          if (!changes.length) {
            result.unchanged.push({ id: existing.id, email, displayName: existing.displayName });
            continue;
          }
          existing.teacherUserId = teacherUserId;
          existing.teacherDisplayName = String(teacher?.displayName || "");
          existing.assignedCourseCodes = codes.includes(courseCode) ? codes : [...codes, courseCode];
          result.updated.push({ id: existing.id, email, displayName: existing.displayName, changes });
        }
        return reply(200, { ok: true, ...result });
      }
      case "PUT /api/admin/default-teacher": {
        if (!this.defaultTeacher) return reply(404, { ok: false, error: "Ruta no encontrada." });
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        this.defaultTeacherPuts.push(structuredClone(body || {}));
        const chosen = body?.teacherUserId ? String(body.teacherUserId) : null;
        this.defaultTeacher = { teacherUserId: chosen || "u-docente", chosenTeacherUserId: chosen, source: chosen ? "admin" : "oldest", chosenInactive: false, updatedAt: new Date(this.clock.now).toISOString(), updatedByName: "Admin Prueba" };
        return reply(200, { ok: true, defaultTeacher: this.defaultTeacher });
      }
      // ---- Tema del piloto (0.7.21) ----
      case "GET /api/pilot/topic": {
        if (this.pilotTopicStatus !== 200) return reply(this.pilotTopicStatus, { ok: false, error: "Ruta no encontrada." });
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        const role = this.sessionRole();
        if (role === "student") return reply(200, { ok: true, teacherUserId: "u-docente", topic: this.pilotTopic });
        return reply(200, {
          ok: true,
          teacherUserId: role === "admin" ? (url.searchParams.get("teacherUserId") || "u-docente") : String((this.session.user as Json).id),
          topic: this.pilotTopic,
          weeks: this.pilotTopicWeeks,
          ...(role === "admin" ? { teachers: this.adminTeachers } : {}),
        });
      }
      case "PUT /api/pilot/topic": {
        if (this.pilotTopicStatus !== 200) return reply(this.pilotTopicStatus, { ok: false, error: "Ruta no encontrada." });
        if (!authed) return reply(401, { ok: false, error: "Sesion no valida." });
        this.pilotTopicPuts.push(structuredClone(body || {}));
        const teacherUserId = this.sessionRole() === "admin" ? String(body?.teacherUserId || "") : String((this.session.user as Json).id);
        if (this.sessionRole() === "admin" && !teacherUserId) return reply(400, { ok: false, error: "Indica teacherUserId: el piloto va por docente." });
        if (body?.clear) {
          this.pilotTopic = null;
          return reply(200, { ok: true, teacherUserId, topic: null, message: "Tema del piloto quitado: los estudiantes ya no lo ven en Inicio." });
        }
        // Como normalizePilotTopicRepo (src/services/pilot-topic.ts), sin los casos raros.
        const rawRepo = String(body?.repoFullName || "").trim();
        const repo = rawRepo.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "").replace(/\.git$/i, "").split(/[?#]/)[0].split("/").slice(0, 2).join("/");
        if (rawRepo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
          return reply(400, { ok: false, error: "El repositorio debe ser usuario/repositorio o su enlace de GitHub (https://github.com/usuario/repositorio)." });
        }
        const week = Number(body?.week) || 0;
        const title = String(body?.title || "").trim() || String((this.pilotTopicWeeks.find((entry) => entry.week === week) as Json | undefined)?.topic || "");
        if (!week && !title) return reply(400, { ok: false, error: "Elige una semana de la bitacora o escribe el tema." });
        this.pilotTopic = { courseCode: String(body?.courseCode || "FPOO"), week, title, repoFullName: rawRepo ? repo : "", updatedAt: new Date(this.clock.now).toISOString(), updatedByUserId: "u-docente", updatedByName: this.sessionRole() === "admin" ? "Admin Prueba" : "Docente Prueba" };
        const what = [week ? `semana ${week}` : "", title, rawRepo ? `ejercicio ${repo}` : ""].filter(Boolean).join(" · ");
        return reply(200, { ok: true, teacherUserId, topic: this.pilotTopic, message: `Tema del piloto guardado (${what}). Los estudiantes lo ven en Inicio y el tutor se enfoca en esa semana.` });
      }
      // ---- Campus ----
      case "POST /api/documents/bitacora/import": {
        // Como src/routes/document-routes: clasifica el archivo y, si es bitacora, queda como la ultima.
        const form = init.body instanceof FormData ? init.body : null;
        const fileName = String(form?.get("fileName") || "bitacora.xlsx");
        this.bitacoraUploads.push(fileName);
        const agenda = {
          items: [
            { title: "Programa y reglas de juego", type: "activity", category: "Actividad", dueAt: "2026-08-10", visibleDueText: "10-08-2026", description: "Tema: Programa del curso | Actividades en clase: Programa y reglas de juego", evidence: ["Semana: 1", "Hoja: Bitacora"] },
            { title: "Quiz Pilares", type: "task", category: "Quiz", dueAt: "2026-08-17", visibleDueText: "17-08-2026", description: "Tema: Pilares de la POO | Actividades evaluación: Quiz Pilares", evidence: ["Semana: 2", "Hoja: Bitacora"] },
          ],
          summary: "",
          warnings: [],
        };
        const stored = { id: `bitacora-${this.bitacoraUploads.length + 1}`, fileName, filePath: fileName, label: "BITACORA", confidence: 0.97, method: "rules", evidence: [], bitacoraAgenda: agenda, classifiedAt: new Date(this.clock.now).toISOString(), updatedAt: new Date(this.clock.now).toISOString() };
        this.bitacoraLatest = stored;
        return reply(200, { ok: true, stored, classification: { label: "BITACORA", confidence: 0.97 }, import: { rowsUsed: agenda.items.length, bitacoraAgenda: agenda } });
      }
      case "PUT /api/documents/bitacora/start-date": {
        // Como src/routes/bitacora-data-routes.ts (0.7.17): corre la bitacora del docente.
        const latest = this.bitacoraLatest as Json | null;
        if (!latest) return reply(404, { ok: false, error: "No hay bitacora cargada. Subela primero." });
        const shift = shiftBitacoraAgendaToStart(latest.bitacoraAgenda as Parameters<typeof shiftBitacoraAgendaToStart>[0], String(body?.startDate || ""));
        if (!shift) return reply(400, { ok: false, error: "Fecha de inicio invalida: usa aaaa-mm-dd." });
        this.bitacoraLatest = { ...latest, bitacoraAgenda: shift.agenda, updatedAt: new Date(this.clock.now).toISOString() };
        return reply(200, { ok: true, latest: this.bitacoraLatest, startDate: shift.startDate, previousStartDate: shift.previousStartDate, shiftDays: shift.shiftDays, firstDate: shift.firstDate, lastDate: shift.lastDate, weeks: shift.weeks });
      }
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
      // ---- Lotes de RAG (0.7.15) ----
      case "GET /api/rag/lots":
        return reply(200, { ok: true, ...this.ragLotCatalog() });
      case "POST /api/rag/lots": {
        const lot = {
          id: `lote-${this.ragLots.length + 1}`,
          courseCode: String(body?.courseCode || "FPOO"),
          name: String(body?.name || ""),
          description: String(body?.description || ""),
          includesBase: body?.includesBase !== false,
          isActive: true,
        };
        this.ragLots.push(lot);
        return reply(201, { ok: true, lot, catalog: this.ragLotCatalog() });
      }
      case "GET /api/quiz/custom":
        return reply(200, {
          ok: true,
          quizzes: this.customQuizzes.map((quiz) => ({
            ...quiz,
            launchCount: this.customQuizLaunches.filter((id) => id === quiz.id).length,
            lastLaunchedAt: this.customQuizLaunches.includes(String(quiz.id)) ? "2026-09-27T14:00:00.000Z" : null,
            activeLaunchId: this.customQuizLaunches.includes(String(quiz.id)) && !this.closedLaunches.includes(`launch-${quiz.id}`) ? `launch-${quiz.id}` : null,
            results: { total: 0, answered: 0, correct: 0, correctRate: null },
          })),
          launches: [],
        });
      case "GET /api/quiz/attempts":
        return reply(200, { ok: true, attempts: this.quizAttempts, summary: { total: this.quizAttempts.length, students: 1, answered: this.quizAttempts.length, correct: 1, correctRate: 50, followUps: 0, skipped: 0 } });
      default: {
        const activeLotMatch = route.match(/^PUT \/api\/rag\/courses\/([^/]+)\/active-lot$/);
        if (activeLotMatch) {
          const courseCode = decodeURIComponent(activeLotMatch[1]);
          const lotId = String(body?.lotId || "");
          if (lotId && !this.ragLots.some((lot) => lot.id === lotId && lot.courseCode === courseCode)) {
            return reply(400, { ok: false, error: "El lote no existe o no es de este curso." });
          }
          if (lotId) this.ragActiveLots[courseCode] = lotId; else delete this.ragActiveLots[courseCode];
          return reply(200, { ok: true, courseCode, activeLotId: lotId, catalog: this.ragLotCatalog() });
        }
        const lotDeleteMatch = route.match(/^DELETE \/api\/rag\/lots\/([^/]+)$/);
        if (lotDeleteMatch) {
          const id = decodeURIComponent(lotDeleteMatch[1]);
          if (!this.ragLots.some((lot) => lot.id === id)) return reply(404, { ok: false, error: "Lote no encontrado." });
          this.ragLots = this.ragLots.filter((lot) => lot.id !== id);
          for (const [courseCode, activeId] of Object.entries(this.ragActiveLots)) {
            if (activeId === id) delete this.ragActiveLots[courseCode];
          }
          this.ragStudentLots = this.ragStudentLots.filter((item) => item.lotId !== id);
          return reply(200, { ok: true, removed: true, id, catalog: this.ragLotCatalog() });
        }
        const sourceActiveMatch = route.match(/^PUT \/api\/rag\/sources\/([^/]+)\/active$/);
        if (sourceActiveMatch) {
          const id = decodeURIComponent(sourceActiveMatch[1]);
          this.ragDisabledSourceIds = this.ragDisabledSourceIds.filter((item) => item !== id);
          if (body?.isActive === false) this.ragDisabledSourceIds.push(id);
          return reply(200, { ok: true, id, isEnabled: body?.isActive !== false });
        }
        const studentLotMatch = route.match(/^PUT \/api\/rag\/students\/([^/]+)\/lot$/);
        if (studentLotMatch) {
          const studentUserId = decodeURIComponent(studentLotMatch[1]);
          const courseCode = String(body?.courseCode || "");
          const lotId = body?.lotId ? String(body.lotId) : null;
          this.ragStudentLots = this.ragStudentLots.filter((item) => !(item.studentUserId === studentUserId && item.courseCode === courseCode));
          if (lotId) this.ragStudentLots.push({ studentUserId, courseCode, lotId });
          return reply(200, { ok: true, studentUserId, courseCode, lotId });
        }
        const customLaunchMatch = route.match(/^POST \/api\/quiz\/custom\/([^/]+)\/launch$/);
        if (customLaunchMatch) {
          const id = decodeURIComponent(customLaunchMatch[1]);
          const quiz = this.customQuizzes.find((item) => item.id === id);
          if (!quiz) return reply(404, { ok: false, error: "Quiz no encontrado." });
          this.customQuizLaunches.push(id);
          const launch = { id: `launch-${id}`, topic: String(quiz.topic), active: true, customQuizId: id, results: { answered: 0, correct: 0 } };
          this.quizLaunches.unshift(launch);
          return reply(200, { ok: true, launch, ...(this.quizLaunchReply || {}) });
        }
        const customDeleteMatch = route.match(/^DELETE \/api\/quiz\/custom\/([^/]+)$/);
        if (customDeleteMatch) {
          const id = decodeURIComponent(customDeleteMatch[1]);
          if (!this.customQuizzes.some((item) => item.id === id)) return reply(404, { ok: false, error: "Quiz no encontrado." });
          this.customQuizzes = this.customQuizzes.filter((item) => item.id !== id);
          return reply(200, { ok: true, removed: true });
        }
        const closeLaunchMatch = route.match(/^POST \/api\/quiz\/launches\/([^/]+)\/close$/);
        if (closeLaunchMatch) {
          const id = decodeURIComponent(closeLaunchMatch[1]);
          this.closedLaunches.push(id);
          this.quizLaunches = this.quizLaunches.map((launch) => (launch.id === id ? { ...launch, active: false } : launch));
          return reply(200, { ok: true });
        }
        const updateMatch = route.match(/^PUT \/api\/admin\/users\/([^/]+)$/);
        if (updateMatch) {
          const id = decodeURIComponent(updateMatch[1]);
          this.adminUserUpdates.push({ id, body });
          this.adminUsers = this.adminUsers.map((user) => (user.id === id ? { ...user, ...(body || {}) } : user));
          return reply(200, { ok: true, user: this.adminUsers.find((user) => user.id === id) });
        }
        const ragDeleteMatch = route.match(/^DELETE \/api\/rag\/sources\/([^/]+)$/);
        if (ragDeleteMatch) {
          const id = decodeURIComponent(ragDeleteMatch[1]);
          this.ragDeletes.push(id);
          this.ragSources = this.ragSources.filter((source) => source.id !== id);
          return reply(200, { ok: true });
        }
        const detailMatch = route.match(/^GET \/api\/admin\/students\/([^/]+)$/);
        if (detailMatch) {
          const student = this.students.find((item) => item.id === decodeURIComponent(detailMatch[1]));
          if (!student) return reply(404, { ok: false, error: "Estudiante no encontrado." });
          return reply(200, {
            ok: true,
            generatedAt: new Date(this.clock.now).toISOString(),
            student,
            sessions: [
              { kind: "browser", label: null, createdAt: "2026-09-25T12:00:00.000Z", lastSeenAt: "2026-09-25T12:50:00.000Z", expiresAt: null, isActive: true, durationMinutes: 50 },
              { kind: "editor", label: "tunnel", createdAt: "2026-09-24T12:00:00.000Z", lastSeenAt: "2026-09-24T13:00:00.000Z", expiresAt: "2026-10-24T12:00:00.000Z", isActive: false, durationMinutes: 60 },
            ],
            interventions: [
              { id: "i-1", eventType: "compile_error", interventionType: "hint", detailLevel: "guided", policyName: "RF-05", exerciseKey: "taller-1", blocked: false, reason: "", contextSummary: "Error en Main.java", createdAt: "2026-09-25T12:10:00.000Z" },
            ],
            quizzes: [
              { id: "q-1", trigger: "after_accept", status: "done", topic: "arreglos", question: "Que hace la linea?", language: "java", filePath: "src/Main.java", answered: true, correct: true, chosenOption: "Inicializa", correctOption: "Inicializa", followupAnswered: true, followupScore: 80, followupFeedback: "Bien explicado.", createdAt: "2026-09-25T12:20:00.000Z", answeredAt: "2026-09-25T12:21:00.000Z", completedAt: "2026-09-25T12:22:00.000Z" },
              { id: "q-2", trigger: "teacher_launch", status: "done", topic: "herencia", question: "Cual es la superclase?", language: "java", filePath: "", answered: true, correct: false, chosenOption: "Object", correctOption: "Animal", followupAnswered: false, followupScore: null, followupFeedback: "", createdAt: "2026-09-24T12:20:00.000Z", answeredAt: "2026-09-24T12:21:00.000Z", completedAt: "2026-09-24T12:21:00.000Z" },
            ],
            activity: [
              { category: "tutor", eventType: "tutor_request_submitted", source: "browser_extension", totalEvents: 4, totalCount: 4, totalDurationMs: 0, lastOccurredAt: "2026-09-25T12:30:00.000Z" },
            ],
            exercises: [{ exerciseKey: "taller-1", hintCount: 2, lastInterventionAt: "2026-09-25T12:10:00.000Z" }],
            timeline: Array.from({ length: 14 }, (_, index) => ({ day: `2026-09-${String(12 + index).padStart(2, "0")}`, sessions: index === 13 ? 1 : 0, interventions: index === 13 ? 1 : 0, quizzes: index >= 12 ? 1 : 0 })),
          });
        }
        this.unknownRoutes.push(route);
        return reply(404, { ok: false, error: `ruta no simulada: ${route}` });
      }
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
  // La espera tras el clic no es «solo mirar»: el backend puede encender la VM y reenviar el prepare.
  assert.ok(browser.requestsTo("/api/workspaces/status").filter((request) => !request.query.includes("passive=1")).length >= 3);
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

test("0.7.20: el codigo se escribe solo en el formulario de github.com/login/device (un campo u ocho cuadros) y nunca se envia", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  browser.githubConnected = true;
  const CODE = "WDJB-MJHT";
  const handoff = () => ({
    userCode: CODE,
    userId: SESSION.user.id,
    repoFullName: REPO,
    expiresAt: browser.clock.now + 10 * 60_000,
    savedAt: browser.clock.now,
    aliveAt: browser.clock.now,
  });
  const helperOf = (tab: TabEnv) => tab.document.getElementById("adaceen-device-code-helper");
  const statusOf = (tab: TabEnv) => String(helperOf(tab)?.shadow?.getElementById("adaceenDeviceCodeStatus").textContent || "");
  const FILLED = "El codigo ya esta en el formulario: pulsa Continue y autoriza con tu cuenta de GitHub. Esta pestana abrira tu editor sola.";

  // Campos del formulario de GitHub, como objetos minimos (lo que usa el autorrelleno).
  type FakeField = Json & { value: string; events: string[] };
  const field = (attrs: Json = {}): FakeField => ({
    type: "text", name: "", id: "", className: "", value: "", disabled: false, readOnly: false, maxLength: -1, events: [],
    getAttribute(name: string) { return name in attrs ? String(attrs[name]) : null; },
    dispatchEvent(event: { type: string }) { (this as FakeField).events.push(event.type); return true; },
    ...attrs,
  });
  const form = (action: string, fields: FakeField[], submits = 0) => ({
    submitted: submits,
    getAttribute(name: string) { return name === "action" ? action : null; },
    querySelectorAll(selector: string) { return selector === "input" ? fields : []; },
    submit() { this.submitted += 1; },
    requestSubmit() { this.submitted += 1; },
  });
  // Pestana de github.com/login/device con un formulario dado (sin Event: los scripts lo toleran).
  const deviceTabWith = async (forms: unknown[], withEvents = true) => {
    const tab = new TabEnv(browser, "https://github.com/login/device", "Device Activation");
    tab.document.querySelectorAll = ((selector: string) => (selector === "form" ? forms : [])) as any;
    if (withEvents) {
      Object.assign(tab.context, { Event: class { constructor(readonly type: string, readonly init?: Json) {} } });
    }
    tab.load(OVERLAY_SCRIPTS);
    await browser.clock.settle();
    await browser.clock.until(() => !!helperOf(tab), 50);
    return tab;
  };

  // (a) Un solo campo user_code, con un campo oculto del mismo nombre y la contrasena de otro formulario intacta.
  browser.storage.adaceenDeviceCodeHandoff = handoff();
  const single = field({ name: "user_code", id: "user-code", maxLength: 9 });
  const hidden = field({ type: "hidden", name: "user_code" });
  const password = field({ type: "password", name: "password" });
  const loginForm = form("/session", [password]);
  const deviceForm = form("/login/device", [hidden, single]);
  const one = await deviceTabWith([loginForm, deviceForm]);
  assert.equal(single.value, CODE, "el codigo queda en el campo");
  assert.deepEqual(single.events, ["input", "change"], "la pagina ve el cambio como si se escribiera");
  assert.equal(hidden.value, CODE, "el campo oculto con el codigo completo tambien");
  assert.equal(password.value, "", "no toca campos de otros formularios");
  assert.equal(deviceForm.submitted, 0, "nunca envia el formulario: autorizar es del estudiante");
  assert.equal(statusOf(one), FILLED);
  // La copia automatica (codigo recien emitido) no tapa el mensaje del codigo puesto.
  assert.deepEqual(browser.clipboard, [CODE]);
  assert.equal(statusOf(one), FILLED);

  // (b) Ocho cuadros de un caracter sin nombre: un caracter por cuadro, en orden.
  browser.clipboard = [];
  browser.storage.adaceenDeviceCodeHandoff = handoff();
  const boxes = Array.from({ length: 8 }, () => field({ maxLength: 1 }));
  const boxesForm = form("/login/device", boxes);
  const eight = await deviceTabWith([boxesForm]);
  assert.equal(boxes.map((box) => box.value).join(""), "WDJBMJHT");
  assert.ok(boxes.every((box) => box.events.includes("input")));
  assert.equal(boxesForm.submitted, 0);
  assert.equal(statusOf(eight), FILLED);

  // (c) Formulario que no se reconoce (GitHub lo cambio): no se toca nada y se sigue pidiendo pegar.
  browser.clipboard = [];
  browser.storage.adaceenDeviceCodeHandoff = handoff();
  const unknown = field({ name: "otp", maxLength: 6 });
  const unknownForm = form("/login/device", [unknown]);
  const other = await deviceTabWith([unknownForm]);
  await advance(browser, 4_000);
  assert.equal(unknown.value, "", "un campo desconocido no se rellena");
  assert.match(statusOf(other), /^Codigo copiado: pegalo en el primer cuadro/);

  // (d) GitHub emite otro codigo en la misma espera: se escribe el nuevo.
  const again = field({ name: "user_code" });
  const againForm = form("/login/device", [again]);
  browser.storage.adaceenDeviceCodeHandoff = handoff();
  const renewed = await deviceTabWith([againForm]);
  assert.equal(again.value, CODE);
  browser.storage.adaceenDeviceCodeHandoff = { ...handoff(), userCode: "ABCD-EFGH" };
  browser.storageListeners.forEach((listener) => listener({ adaceenDeviceCodeHandoff: { newValue: browser.storage.adaceenDeviceCodeHandoff } }, "local"));
  await browser.clock.settle();
  assert.equal(again.value, "ABCD-EFGH", "el codigo nuevo reemplaza al anterior en el formulario");
  assert.equal(statusOf(renewed), FILLED);
  assertKnownShadowIds(one, eight, other, renewed);
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
  // 0.7.20: solo mirar (passive=1): entrar en la pagina no enciende la VM ni reenvia nada.
  assert.match(browser.requestsTo("/api/workspaces/status")[0].query, /[?&]passive=1(&|$)/);
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
  // 0.7.20: el docente tambien puede tener su editor (boton «Abrir en mi editor»): al entrar
  // se consulta una vez si ya existe, sin preparar nada y sin cambiar el panel.
  assert.ok(browser.requestsTo("/api/workspaces/status").length <= 1, "a lo sumo una consulta del editor del docente");
  assert.deepEqual(browser.requestsTo("/api/workspaces/prepare"), [], "entrar no prepara un editor");
  assert.equal(tab.el("contextActionTitle").textContent, "Panel docente");
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

test("docente: una sola casilla de mini quiz y el aviso del backend en «Lanzar quiz» (item 9, contrato (c)); el piloto ya no esta en el overlay (0.7.15)", async () => {
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

  // El piloto con y sin tutor sale del overlay (0.7.15): «eso va internamente», con
  // npm run piloto:bloque. La tuerca no lo consulta ni lo muestra.
  assert.doesNotMatch(markup, /Piloto con y sin tutor|Asignar grupos A y B|Iniciar bloque 1|teacherPilotBlock1Btn|settingsSectionPilot/);
  assert.deepEqual(browser.requestsTo("/api/pilot"), [], "la tuerca ya no consulta el piloto");
  // Lanzar un quiz vive en la pestana «Quices»; la tuerca solo dice cuando sale el mini quiz.
  assert.match(markup, /id="tabPanelQuices"[\s\S]*id="teacherQuizTopic"/);
  assert.match(markup, /usa la pestaña «Quices»/);
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


test("pestañas (0.7.13): cada rol ve las suyas y «Estudiantes» trae sesiones, quices y notas del backend", async () => {
  // --- Estudiante: Inicio y Tutor. Entra en Inicio; al llegar las pistas pasa a Tutor.
  const studentBrowser = new FakeBrowser();
  seedLoggedInBrowser(studentBrowser);
  const studentTab = await openTab(studentBrowser, TUNNEL_URL, "taller-1");
  await drive(studentBrowser, studentTab.run("openOverlay({ trigger: 'user' })"));
  await studentBrowser.clock.until(() => studentTab.state().loading === false, 400);
  assert.equal(studentTab.el("mainView").hidden, false);
  assert.equal(studentTab.el("mainTabBar").hidden, false);
  assert.equal(studentTab.el("tabBtnTutor").hidden, false);
  assert.equal(studentTab.el("tabBtnEstudiantes").hidden, true, "el estudiante no ve a otros estudiantes");
  assert.equal(studentTab.el("tabBtnUsuarios").hidden, true);
  assert.equal(studentTab.state().mainTab, "inicio");
  assert.equal(studentTab.el("tabPanelInicio").hidden, false);
  assert.equal(studentTab.el("tabPanelTutor").hidden, true, "sin pistas todavia, se queda en Inicio");
  studentBrowser.tutorReply = { result: { ideas: ["Revisa el constructor."], guide: ["Compila de nuevo."] } };
  await drive(studentBrowser, studentTab.run("refreshMentorSession({ trigger: 'manual', requestedAt: Date.now() })"), 2000);
  assert.equal(studentTab.state().mainTab, "tutor", "la respuesta del tutor abre la pestaña Tutor");
  assert.equal(studentTab.el("tabPanelTutor").hidden, false);
  assert.equal(studentTab.el("tabPanelInicio").hidden, true);
  assert.equal(studentTab.el("tabBtnTutor").getAttribute("aria-selected"), "true");
  // Si la persona elige Inicio, un refresco automatico no la saca de ahi; pedir ayuda a mano si.
  await drive(studentBrowser, studentTab.el("tabBtnInicio").click());
  assert.equal(studentTab.state().mainTab, "inicio");
  await drive(studentBrowser, studentTab.run("refreshMentorSession({ trigger: 'context', requestedAt: Date.now() })"), 2000);
  assert.equal(studentTab.state().mainTab, "inicio", "respeta la pestaña elegida");
  await drive(studentBrowser, studentTab.run("refreshMentorSession({ trigger: 'manual', requestedAt: Date.now() })"), 2000);
  assert.equal(studentTab.state().mainTab, "tutor", "«Actualizar» muestra la respuesta");
  await drive(studentBrowser, studentTab.el("tabBtnInicio").click());
  // Flecha derecha desde Inicio: Tutor (patron tablist).
  await drive(studentBrowser, studentTab.el("tabBtnInicio").dispatch("keydown", { key: "ArrowRight" }));
  assert.equal(studentTab.state().mainTab, "tutor");
  assert.deepEqual(studentBrowser.requestsTo("/api/admin/students"), [], "el estudiante nunca pide el progreso");
  assertKnownShadowIds(studentTab);

  // --- Docente: Inicio, Tutor, Estudiantes y Usuarios. El progreso se pide solo al abrir la pestaña.
  const browser = new FakeBrowser();
  browser.session = { ...SESSION, user: { ...SESSION.user, id: "u-docente", role: "teacher", displayName: "Docente Prueba", assignedCourseCodes: [] } };
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);
  assert.equal(tab.el("tabBtnTutor").hidden, false);
  assert.equal(tab.el("tabBtnEstudiantes").hidden, false);
  assert.equal(tab.el("tabBtnUsuarios").hidden, false);
  assert.equal(tab.el("tabPanelInicio").hidden, false);
  assert.equal(tab.el("tabPanelEstudiantes").hidden, true);
  assert.deepEqual(browser.requestsTo("/api/admin/students"), [], "sin pedir el progreso hasta abrir la pestaña");

  await drive(browser, tab.el("tabBtnEstudiantes").click());
  await browser.clock.until(() => tab.state().studentsPanel.loadedAt > 0, 400);
  assert.equal(tab.state().mainTab, "estudiantes");
  assert.equal(tab.el("tabPanelEstudiantes").hidden, false);
  assert.equal(tab.el("tabPanelInicio").hidden, true);
  assert.equal(tab.el("tabPanelUsuarios").hidden, true);
  assert.equal(browser.requestsTo("/api/admin/students").length, 1);
  assert.equal(tab.el("tabCountEstudiantes").hidden, false);
  assert.equal(tab.el("tabCountEstudiantes").textContent, "2");
  assert.equal(tab.el("studentsSection").hidden, false);
  assert.equal(tab.el("studentDetailSection").hidden, true);
  assert.equal(tab.el("studentsKpis").children.length, 5, "cinco indicadores del grupo");
  assert.equal(tab.el("studentsKpis").children[3].children[1].textContent, "73/100", "nota promedio");
  const rows = tab.el("studentsTableBody").children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dataset.userId, "u-est-1");
  assert.equal(rows[0].children[5].children[0].textContent, "73/100", "nota sobre 100 en la etiqueta");
  assert.equal(rows[0].children[5].children[1].textContent, "3,7/5", "y la escala de 0 a 5 debajo");
  assert.equal(rows[1].children[5].children[0].textContent, "Sin quices");
  assert.match(tab.el("studentsStatus").textContent, /2 estudiantes/);
  // Volver a la pestaña no repite la peticion (menos de un minuto).
  await drive(browser, tab.el("tabBtnInicio").click());
  await drive(browser, tab.el("tabBtnEstudiantes").click());
  assert.equal(browser.requestsTo("/api/admin/students").length, 1, "la lista fresca no se vuelve a pedir");

  // Buscar filtra por nombre o correo sin pedir nada al backend.
  const search = tab.el("studentsSearchInput");
  search.value = "bruno";
  await drive(browser, search.dispatch("input"));
  assert.equal(tab.el("studentsTableBody").children.length, 1);
  assert.equal(tab.el("studentsTableBody").children[0].dataset.userId, "u-est-2");
  search.value = "";
  await drive(browser, search.dispatch("input"));
  assert.equal(tab.el("studentsTableBody").children.length, 2);

  // Detalle: clic en la fila trae sesiones, intervenciones, quices y linea de tiempo.
  await drive(browser, tab.el("studentsTableBody").children[0].click());
  await browser.clock.until(() => !!tab.state().studentsPanel.detail, 400);
  assert.equal(browser.requestsTo("/api/admin/students/u-est-1").length, 1);
  assert.equal(tab.el("studentDetailSection").hidden, false);
  assert.equal(tab.el("studentsSection").hidden, true, "el detalle ocupa el lugar de la lista, sin scroll");
  assert.equal(tab.el("studentDetailTitle").textContent, "Ana Prueba");
  assert.match(tab.el("studentDetailMeta").textContent, /ana@correounivalle\.edu\.co/);
  assert.match(tab.el("studentDetailMeta").textContent, /Cohorte A/);
  assert.equal(tab.el("studentDetailChip").textContent, "Activo ahora");
  assert.equal(tab.el("studentDetailKpis").children.length, 5);
  assert.equal(tab.el("studentDetailKpis").children[4].children[1].textContent, "73/100 | 3,7/5");
  assert.equal(tab.el("studentDetailTimeline").children.length, 14, "un dia por columna");
  assert.equal(tab.el("studentDetailQuizzes").children.length, 2);
  assert.match(tab.el("studentDetailQuizzes").children[0].children[2].textContent, /Correcto .* seguimiento 80\/100/);
  assert.match(tab.el("studentDetailQuizzes").children[1].children[2].textContent, /Incorrecto .* correcta "Animal"/);
  assert.equal(tab.el("studentDetailSessions").children.length, 2);
  assert.match(tab.el("studentDetailSessions").children[1].children[0].textContent, /VS Code \(tunnel\)/);
  assert.equal(tab.el("studentDetailInterventions").children.length, 1);
  assert.match(tab.el("studentDetailInterventions").children[0].children[0].textContent, /Error de compilacion -> Pista/);
  assert.equal(tab.el("studentDetailActivity").children.length, 2, "ejercicio con pistas + actividad por categoria");
  // El evento en palabras del docente, no su nombre interno.
  assert.equal(tab.el("studentDetailActivity").children[1].children[0].textContent, "Tutor: Pidio ayuda");
  assert.match(tab.el("studentDetailActivity").children[1].children[1].textContent, /^4 veces \| navegador \| /);

  // Volver a la lista y recargar a mano si trae datos nuevos.
  await drive(browser, tab.el("studentDetailBackBtn").click());
  assert.equal(tab.el("studentDetailSection").hidden, true);
  assert.equal(tab.el("studentsSection").hidden, false);
  await drive(browser, tab.el("studentsReloadBtn").click());
  await browser.clock.until(() => !tab.state().studentsPanel.busy, 400);
  assert.equal(browser.requestsTo("/api/admin/students").length, 2, "Recargar si vuelve a pedir");

  // Usuarios: la administracion sigue completa en su pestaña.
  await drive(browser, tab.el("tabBtnUsuarios").click());
  assert.equal(tab.el("tabPanelUsuarios").hidden, false);
  assert.equal(tab.el("adminUsersSection").hidden, false);
  assert.equal(tab.el("tabPanelEstudiantes").hidden, true);
  assert.deepEqual(browser.unknownRoutes.filter((route) => !route.includes("/api/projects") && !route.includes("/api/admin/users")), []);
  assertKnownShadowIds(tab);

  // --- Administrador: Inicio, Estudiantes y Usuarios, sin Tutor.
  const adminBrowser = new FakeBrowser();
  adminBrowser.session = { ...SESSION, user: { ...SESSION.user, id: "u-admin", role: "admin", displayName: "Admin Prueba", assignedCourseCodes: [] } };
  seedLoggedInBrowser(adminBrowser);
  const adminTab = await openTab(adminBrowser, CAMPUS_COURSE_URL, "Curso");
  await drive(adminBrowser, adminTab.run("openOverlay({ trigger: 'user' })"));
  await adminBrowser.clock.until(() => adminTab.state().loading === false, 400);
  assert.equal(adminTab.el("tabBtnTutor").hidden, true, "el administrador no usa el tutor");
  assert.equal(adminTab.el("tabBtnEstudiantes").hidden, false);
  assert.equal(adminTab.el("tabBtnUsuarios").hidden, false);
  await drive(adminBrowser, adminTab.el("tabBtnEstudiantes").click());
  await adminBrowser.clock.until(() => adminTab.state().studentsPanel.loadedAt > 0, 400);
  assert.equal(adminTab.el("studentsTableBody").children.length, 2);
  assert.match(adminTab.el("studentsTableBody").children[0].children[0].children[1].textContent, /Docente Prueba/, "el admin ve el docente de cada estudiante");
  assertKnownShadowIds(adminTab);
});


test("0.7.14: usuarios legibles con edicion por fila, RAG por curso, tuerca por secciones y resumen del tutor separado", async () => {
  const browser = new FakeBrowser();
  browser.session = { ...SESSION, user: { ...SESSION.user, id: "u-docente", role: "teacher", displayName: "Docente Prueba", assignedCourseCodes: [] } };
  browser.tutorReply = {
    result: {
      ideas: ["Revisa el constructor. [RAG-FPOO-17#c1]"],
      guide: ["Compila de nuevo."],
      analysis_summary: "Se detecto Campus Virtual y se priorizaron pistas. RAG consultado: Conceptos basicos [RAG-FPOO-17#c1] | Taller 2 [RAG-T-01#c1]. RAG usado: Conceptos basicos: [RAG-FPOO-17#c1] (Motivo: coincide con objeto.). Politica: explanation con detalle brief.",
    },
    rag_sources: [
      { sourceId: "RAG-FPOO-17", chunkId: "RAG-FPOO-17:chunk:0", courseCode: "FPOO", scope: "default", knowledgeTier: "primary", title: "Conceptos basicos", fileName: "conceptos.html", pageStart: 5, citationLabel: "[RAG-FPOO-17#c1]", score: 12.5, usageReason: "Parte usada: [RAG-FPOO-17#c1]. Motivo: coincide con objeto.", matchedTerms: ["objeto"] },
    ],
  };
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-docente": true } });
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);

  // --- Usuarios: nombre y correo completos como texto; «Editar» abre la fila.
  await drive(browser, tab.el("tabBtnUsuarios").click());
  await browser.clock.until(() => tab.el("adminUsersTableBody").children.length >= 2, 400);
  const rows = tab.el("adminUsersTableBody").children;
  assert.equal(rows.length, 2, "una fila por usuario, sin fila de edicion");
  assert.equal(rows[0].children[0].children[0].tagName, "SPAN", "el nombre es texto, no un campo");
  assert.equal(rows[0].children[0].children[0].textContent, "Ana María Pérez González");
  // El correo va partido antes de la @ con un <wbr> (corta ahi si la columna es angosta): su texto
  // completo, como lo da el DOM real, es el de sus nodos.
  const emailCell = rows[0].children[0].children[1];
  assert.equal(emailCell.textContent + emailCell.children.map((node) => node.textContent).join(""), "ana.maria.perez.gonzalez@correounivalle.edu.co");
  assert.deepEqual(emailCell.children.map((node) => node.tagName), ["#TEXT", "WBR", "#TEXT"]);
  assert.equal(rows[0].children[1].children[0].textContent, "Estudiante");
  assert.equal(rows[0].children[3].children[0].children.length, 1, "un chip por curso");
  assert.equal(rows[1].children[3].children[0].children.length, 2);
  assert.equal(rows[1].children[5].children[0].textContent, "Inactivo");
  // «RAG aplicado» (0.7.15): sin lotes, cada curso del estudiante muestra la base.
  assert.equal(rows[0].children[4].children[0].children[0].textContent, "Base del curso");
  assert.equal(rows[0].children[6].children[0].textContent, "Editar");
  await drive(browser, rows[0].children[6].children[0].click());
  assert.equal(tab.state().adminEditingUserId, "u-est-1");
  const editedRows = tab.el("adminUsersTableBody").children;
  assert.equal(editedRows.length, 3, "la fila de edicion aparece debajo del usuario");
  assert.equal(editedRows[0].children[6].children[0].textContent, "Cancelar");
  const form = editedRows[1].children[0].children[0];
  const nameInput = form.children[0].children[0].children[1];
  assert.equal(nameInput.tagName, "INPUT");
  assert.equal(nameInput.value, "Ana María Pérez González");
  nameInput.value = "Ana María Pérez";
  const saveBtn = form.children[form.children.length - 1].children[1];
  assert.equal(saveBtn.textContent, "Guardar");
  await drive(browser, saveBtn.click(), 800);
  await browser.clock.until(() => tab.state().adminUsersBusy === false, 400);
  assert.equal(browser.adminUserUpdates.length, 1);
  assert.equal(browser.adminUserUpdates[0].id, "u-est-1");
  assert.equal(browser.adminUserUpdates[0].body?.displayName, "Ana María Pérez");
  assert.equal(tab.state().adminEditingUserId, "", "al guardar se cierra la edicion");
  assert.equal(tab.el("adminUsersTableBody").children.length, 2);

  // --- RAG: la pestaña carga cursos y fuentes al abrirse y agrupa por curso.
  assert.deepEqual(browser.requestsTo("/api/rag/sources"), [], "las fuentes no se piden hasta abrir la pestaña");
  await drive(browser, tab.el("tabBtnRag").click());
  await browser.clock.until(() => tab.state().teacherRagLoadedAt > 0, 400);
  assert.equal(tab.state().mainTab, "rag");
  assert.equal(tab.el("tabPanelRag").hidden, false);
  assert.equal(browser.requestsTo("/api/rag/sources").length, 1);
  const groups = tab.el("ragCourseGroups").children;
  assert.equal(groups.length, 2, "un grupo por curso del docente");
  assert.equal(groups[0].dataset.courseCode, "FPI");
  assert.equal(groups[1].dataset.courseCode, "FPOO");
  assert.equal(groups[1].open, true, "el curso por defecto empieza desplegado");
  assert.equal(groups[0].open, false);
  const fpooBody = groups[1].children[1];
  // 0.7.15: la base del curso es el primer grupo dentro del curso (toolbar, nota, base, lotes).
  const fpooBase = fpooBody.children[2];
  assert.equal(fpooBase.children[0].children[0].textContent, "Base del curso");
  const fpooList = fpooBase.children[1].children[1];
  assert.equal(fpooList.children.length, 2, "las dos fuentes de FPOO");
  assert.equal(fpooList.children[0].children[0].children[0].children[0].textContent, "Taller 2", "las cargadas por el docente van primero");
  const fpooActions = fpooList.children[0].children[0].children[1];
  assert.equal(fpooActions.children[fpooActions.children.length - 1].textContent, "Retirar");
  await drive(browser, fpooActions.children[fpooActions.children.length - 1].click(), 800);
  await browser.clock.until(() => !tab.state().teacherRagState.busy, 400);
  assert.deepEqual(browser.ragDeletes, ["RAG-T-01"]);
  const uploadBtn = fpooBody.children[0].children[2];
  assert.equal(uploadBtn.textContent, "Cargar fuente");
  await drive(browser, uploadBtn.click());
  assert.equal(tab.state().teacherRagState.selectedCourseCode, "FPOO", "la carga va al curso del grupo");
  assert.match(tab.el("ragCoursesStatus").textContent, /2 cursos/);
  // «Configurar RAG» de Inicio abre esta pestaña en vez de la pagina emergente.
  await drive(browser, tab.el("tabBtnInicio").click());
  await drive(browser, tab.el("teacherRagManageBtn").click());
  assert.equal(tab.state().mainTab, "rag");
  assert.equal(tab.state().teacherRagPageOpen, false);

  // --- Tuerca: secciones plegables; el docente empieza por su politica.
  await drive(browser, tab.el("settingsBtn").click(), 400);
  assert.equal(tab.state().settingsOpen, true);
  assert.equal(tab.el("settingsSectionPolicy").open, true);
  assert.equal(tab.el("settingsSectionSession").open, false);
  await drive(browser, tab.el("settingsCloseBtn").click(), 400);

  // --- Resumen del tutor: la linea de estado separa deteccion, politica y fuentes.
  await drive(browser, tab.run("refreshMentorSession({ trigger: 'manual', requestedAt: Date.now() })"), 2000);
  assert.equal(
    tab.el("statusText").textContent,
    "Se detecto Campus Virtual y se priorizaron pistas. Politica: explicacion, detalle breve. Fuentes: 1 usada de 2 consultadas (ver «Fuentes RAG usadas»).",
  );
  assert.equal(tab.el("ragSourcesSection").hidden, false);
  assert.equal(tab.el("ragSourcesSection").open, false, "plegada por defecto");
  assert.equal(tab.el("ragSourcesCount").textContent, "1 fuente");
  const citations = tab.el("ragSourcesList").children;
  assert.equal(citations.length, 2, "cabecera del curso + una fuente");
  assert.equal(citations[0].textContent, "FPOO");
  assert.equal(citations[1].children[0].children[1].textContent, "Conceptos basicos");
  assert.equal(citations[1].children[0].children[2].textContent, "RAG principal | p. 5 | [RAG-FPOO-17#c1] | puntaje 12.5");
  assert.equal(citations[1].children[1].hidden, true, "el motivo se despliega con +");
  await drive(browser, citations[1].children[0].children[0].click());
  assert.equal(citations[1].children[1].hidden, false);

  // --- Estudiante: la tuerca empieza por «Sesion y tutor».
  const studentBrowser = new FakeBrowser();
  seedLoggedInBrowser(studentBrowser);
  const studentTab = await openTab(studentBrowser, TUNNEL_URL, "taller-1");
  await drive(studentBrowser, studentTab.run("openOverlay({ trigger: 'user' })"));
  await studentBrowser.clock.until(() => studentTab.state().loading === false, 400);
  await drive(studentBrowser, studentTab.el("settingsBtn").click(), 400);
  assert.equal(studentTab.el("settingsSectionSession").open, true);
  assert.equal(studentTab.el("tabBtnRag").hidden, true, "el estudiante no administra RAG");
  assertKnownShadowIds(tab, studentTab);
});

test("0.7.15: lotes de RAG por curso, lote por estudiante, pestaña «Quices», ayuda de los RA y exportar bitacora", async () => {
  const browser = new FakeBrowser();
  browser.session = { ...SESSION, user: { ...SESSION.user, id: "u-docente", role: "teacher", displayName: "Docente Prueba", assignedCourseCodes: [] } };
  browser.customQuizzes = [
    { id: "cq-1", courseCode: "FPOO", topic: "Encapsulamiento", question: "Cual modificador oculta un atributo?", options: ["private", "public", "static"], correctIndex: 0, explanation: "", followupQuestion: "Da un ejemplo." },
  ];
  browser.quizAttempts = [
    { id: "a-1", studentUserId: "u-est-1", studentName: "Ana María Pérez González", studentEmail: "ana.maria.perez.gonzalez@correounivalle.edu.co", trigger: "teacher_launch", status: "done", topic: "Encapsulamiento", question: "Cual modificador oculta un atributo?", chosenIndex: 0, correct: true, followupScore: 80, launchId: "launch-cq-1", customQuizId: "cq-1", createdAt: "2026-09-27T14:05:00.000Z", answeredAt: "2026-09-27T14:06:00.000Z" },
    { id: "a-2", studentUserId: "u-est-2", studentName: "Bruno Prueba", studentEmail: "bruno@correounivalle.edu.co", trigger: "after_accept", status: "done", topic: "arreglos", question: "Que hace la linea?", chosenIndex: 1, correct: false, followupScore: null, launchId: null, customQuizId: "", createdAt: "2026-09-26T10:00:00.000Z", answeredAt: "2026-09-26T10:01:00.000Z" },
  ];
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-docente": true } });
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);
  const markup = tab.run<string>("buildOverlayMarkup()");

  // --- RAG: la pestaña trae el catalogo de lotes junto con las fuentes.
  await drive(browser, tab.el("tabBtnRag").click());
  await browser.clock.until(() => tab.state().teacherRagLoadedAt > 0 && tab.state().ragLots.loadedAt > 0, 400);
  assert.equal(browser.requestsTo("/api/rag/lots", "GET").length, 1);
  let groups = tab.el("ragCourseGroups").children;
  const fpoo = () => Array.from(tab.el("ragCourseGroups").children).find((group: any) => group.dataset.courseCode === "FPOO") as any;
  assert.equal(fpoo().children[0].children[2].textContent, "Activo: Base del curso", "sin lotes, la base esta activa");
  let toolbar = fpoo().children[1].children[0];
  assert.equal(toolbar.children[0].children[0].textContent, "Lote activo");
  assert.equal(toolbar.children[1].children[0].textContent, "Cargar en");
  assert.equal(toolbar.children[3].textContent, "Nuevo lote");
  // Desactivar una fuente de la base: PUT /api/rag/sources/:id/active y la fuente queda marcada.
  let base = fpoo().children[1].children[2];
  let baseList = base.children[1].children[1];
  assert.equal(baseList.children.length, 2);
  const conceptos = Array.from(baseList.children).find((item: any) => item.children[0].children[0].children[0].textContent === "Conceptos basicos") as any;
  const toggle = Array.from(conceptos.children[0].children[1].children).find((button: any) => button.textContent === "Desactivar") as any;
  assert.ok(toggle, "cada fuente se puede desactivar");
  await drive(browser, toggle.click(), 800);
  await browser.clock.until(() => !tab.state().ragLots.busy, 400);
  assert.deepEqual(browser.ragDisabledSourceIds, ["RAG-FPOO-17"]);
  assert.deepEqual(browser.requestsTo("/api/rag/sources/RAG-FPOO-17/active", "PUT").map((request) => request.body), [{ isActive: false }]);
  base = fpoo().children[1].children[2];
  baseList = base.children[1].children[1];
  const disabledItem = Array.from(baseList.children).find((item: any) => item.children[0].children[0].children[0].textContent === "Conceptos basicos") as any;
  assert.match(disabledItem.className, /is-disabled/);
  assert.match(disabledItem.children[0].children[0].children[1].textContent, /Apagada para tus estudiantes/);
  assert.ok(Array.from(disabledItem.children[0].children[1].children).some((button: any) => button.textContent === "Activar"));
  assert.match(tab.el("ragCoursesMessage").textContent, /apagada: tus estudiantes ya no la reciben/);

  // Nuevo lote: el formulario, POST /api/rag/lots y el lote aparece inactivo con «Activar en el curso».
  await drive(browser, toolbar.children[3].click());
  let form = fpoo().children[1].children[2];
  assert.equal(form.className, "rag-lot-form");
  form.children[0].value = "Enfoque videojuegos";
  form.children[1].value = "Ejemplos con juegos 2D";
  await drive(browser, form.children[3].children[1].click(), 800);
  await browser.clock.until(() => !tab.state().ragLots.busy, 400);
  assert.deepEqual(browser.requestsTo("/api/rag/lots", "POST").map((request) => request.body), [
    { courseCode: "FPOO", name: "Enfoque videojuegos", description: "Ejemplos con juegos 2D", includesBase: true },
  ]);
  assert.equal(tab.state().ragLotFormOpen.FPOO, false, "el formulario se cierra al guardar");
  let lotGroup = fpoo().children[1].children[3];
  assert.equal(lotGroup.children[0].children[0].textContent, "Enfoque videojuegos");
  assert.equal(lotGroup.children[0].children[1].textContent, "Inactivo");
  const activateBtn = lotGroup.children[1].children[1].children[0];
  assert.equal(activateBtn.textContent, "Activar en el curso");
  await drive(browser, activateBtn.click(), 800);
  await browser.clock.until(() => !tab.state().ragLots.busy, 400);
  assert.deepEqual(browser.ragActiveLots, { FPOO: "lote-1" });
  assert.equal(fpoo().children[0].children[2].textContent, "Activo: Enfoque videojuegos");
  toolbar = fpoo().children[1].children[0];
  assert.equal(toolbar.children[0].children[1].value, "lote-1", "el selector muestra el lote activo");
  lotGroup = fpoo().children[1].children[3];
  assert.equal(lotGroup.children[0].children[1].textContent, "Activo");
  // Cargar una fuente dentro del lote: el selector de carga recuerda el lote y la carga lo manda.
  const uploadHere = Array.from(lotGroup.children[1].children[1].children).find((button: any) => button.textContent === "Cargar fuente aqui") as any;
  await drive(browser, uploadHere.click());
  assert.equal(tab.state().ragUploadLotByCourse.FPOO, "lote-1");
  assert.equal(tab.state().teacherRagState.selectedCourseCode, "FPOO");
  assert.match(tab.el("ragCoursesStatus").textContent, /1 lote/);

  // --- Usuarios: «RAG aplicado» y el lote por estudiante en la fila de edicion.
  await drive(browser, tab.el("tabBtnUsuarios").click());
  await browser.clock.until(() => tab.el("adminUsersTableBody").children.length >= 2, 400);
  let rows = tab.el("adminUsersTableBody").children;
  assert.equal(rows[0].children[4].children[0].children[0].textContent, "Enfoque videojuegos", "Ana recibe el lote activo del curso");
  assert.equal(rows[1].children[4].children[0].children[0].textContent, "FPOO: Enfoque videojuegos");
  assert.equal(rows[1].children[4].children[0].children[1].textContent, "FPI: Base del curso");
  await drive(browser, rows[0].children[6].children[0].click());
  const editForm = tab.el("adminUsersTableBody").children[1].children[0].children[0];
  const lotField = Array.from(editForm.children).find((child: any) => child.children[0]?.textContent === "Lote de RAG aplicado (se guarda al cambiar)") as any;
  assert.ok(lotField, "la fila de edicion trae el lote por curso");
  const lotSelect = lotField.children[1].children[0].children[1];
  assert.equal(lotSelect.tagName, "SELECT");
  assert.equal(lotSelect.children[0].textContent, "Lote activo del curso (Enfoque videojuegos)");
  assert.equal(lotSelect.children[1].textContent, "Enfoque videojuegos");
  lotSelect.value = "lote-1";
  await drive(browser, lotSelect.dispatch("change"), 800);
  await browser.clock.until(() => tab.state().adminUsersBusy === false, 400);
  assert.deepEqual(browser.ragStudentLots, [{ studentUserId: "u-est-1", courseCode: "FPOO", lotId: "lote-1" }]);
  assert.deepEqual(browser.requestsTo("/api/rag/students/u-est-1/lot", "PUT").map((request) => request.body), [{ courseCode: "FPOO", lotId: "lote-1" }]);
  assert.match(tab.el("adminUsersStatus").textContent, /Lote de RAG guardado para Ana/);
  rows = tab.el("adminUsersTableBody").children;
  assert.equal(rows[0].children[4].children[0].children[0].className, "admin-chip is-lot-student", "asignado a la persona, no al curso");

  // --- Quices: banco propio, quices hechos con nombre y «Crear quiz» en otra pestaña.
  assert.equal(tab.el("tabBtnQuices").hidden, false);
  assert.deepEqual(browser.requestsTo("/api/quiz/custom"), [], "no se pide hasta abrir la pestaña");
  await drive(browser, tab.el("tabBtnQuices").click());
  await browser.clock.until(() => tab.state().quizzesPanel.loadedAt > 0, 400);
  assert.equal(tab.el("tabPanelQuices").hidden, false);
  assert.equal(browser.requestsTo("/api/quiz/custom", "GET").length, 1);
  assert.equal(browser.requestsTo("/api/quiz/attempts", "GET").length, 1);
  assert.equal(tab.el("quizzesBankList").children.length, 1);
  assert.equal(tab.el("quizzesBankList").children[0].children[0].children[0].textContent, "Encapsulamiento");
  assert.equal(tab.el("quizzesDoneBody").children.length, 2);
  assert.equal(tab.el("quizzesDoneBody").children[0].children[0].children[0].textContent, "Ana María Pérez González");
  assert.equal(tab.el("quizzesDoneBody").children[0].children[1].children[1].textContent, "Mi banco");
  assert.equal(tab.el("quizzesDoneBody").children[0].children[2].children[0].textContent, "Correcta · 80/100");
  assert.equal(tab.el("quizzesDoneBody").children[1].children[1].children[1].textContent, "Tras aceptar");
  assert.equal(tab.el("quizzesDoneBody").children[1].children[2].children[0].textContent, "Incorrecta");
  assert.match(tab.el("quizzesStatus").textContent, /1 quiz propio \| 2 quices hechos/);
  // Lanzar desde el banco: POST /api/quiz/custom/:id/launch y el estado del quiz de la clase.
  const launchBtn = tab.el("quizzesBankList").children[0].children[3].children[0];
  assert.equal(launchBtn.textContent, "Lanzar");
  await drive(browser, launchBtn.click(), 800);
  await browser.clock.until(() => tab.state().quizzesPanel.busy === false, 400);
  assert.deepEqual(browser.customQuizLaunches, ["cq-1"]);
  assert.match(tab.el("quizzesMessage").textContent, /«Encapsulamiento» lanzado a la clase/);
  assert.match(tab.el("teacherQuizStatus").textContent, /Activo: "Encapsulamiento"/);
  const bankItem = tab.el("quizzesBankList").children[0];
  assert.match(bankItem.className, /is-live/);
  const closeBtn = Array.from(bankItem.children[3].children).find((button: any) => button.textContent === "Cerrar") as any;
  await drive(browser, closeBtn.click(), 800);
  await browser.clock.until(() => tab.state().quizzesPanel.busy === false, 400);
  assert.deepEqual(browser.closedLaunches, ["launch-cq-1"]);
  // «Crear quiz» abre /docente/quices del backend en otra pestaña.
  await drive(browser, tab.el("quizzesCreateBtn").click());
  assert.equal(tab.popups.length, 1);
  assert.equal(tab.popups[0].currentHref, `${BACKEND}/docente/quices`);
  assert.match(tab.el("quizzesMessage").textContent, /Se abrio «Crear quiz» en otra pestaña/);
  // «Monitor» abre /docente/monitor (lo de npm run piloto:monitor) en otra pestaña, con la misma sesión.
  assert.equal(tab.el("quizzesMonitorBtn").disabled, false);
  await drive(browser, tab.el("quizzesMonitorBtn").click());
  assert.equal(tab.popups.length, 2);
  assert.equal(tab.popups[1].currentHref, `${BACKEND}/docente/monitor`);
  assert.match(tab.el("quizzesMessage").textContent, /Se abrio «Monitor» en otra pestaña/);
  // Retirar del banco.
  const retireBtn = Array.from(tab.el("quizzesBankList").children[0].children[3].children).find((button: any) => button.textContent === "Retirar") as any;
  await drive(browser, retireBtn.click(), 800);
  await browser.clock.until(() => tab.state().quizzesPanel.busy === false, 400);
  assert.deepEqual(browser.customQuizzes, []);
  assert.equal(tab.el("quizzesBankList").children.length, 0);
  assert.equal(tab.el("quizzesBankEmpty").hidden, false);

  // --- Tuerca: RA1 a RA5 y la ayuda «?» con el peso de cada RA.
  await drive(browser, tab.el("settingsBtn").click(), 400);
  assert.match(markup, /<option value="RA4">RA4<\/option>\s*<option value="RA5">RA5<\/option>/);
  assert.equal(tab.el("teacherOutcomeHelp").hidden, true);
  await drive(browser, tab.el("teacherOutcomeHelpBtn").click());
  assert.equal(tab.el("teacherOutcomeHelp").hidden, false);
  assert.equal(tab.el("teacherOutcomeHelpBtn").getAttribute("aria-expanded"), "true");
  const outcomes = tab.el("teacherOutcomeHelp").children[1].children;
  assert.equal(outcomes.length, 5);
  assert.match(outcomes[0].children[0].children[0].textContent, /RA1 · 15 % de la nota/);
  assert.match(outcomes[2].children[0].children[0].textContent, /RA3 · 29 % de la nota/);
  // 0.7.18 (A10.9): enunciado del programa y competencia de cada RA, antes del reparto.
  assert.match(outcomes[0].children[1].textContent, /^Usa los tipos de datos básicos y los agregados/);
  assert.match(outcomes[3].children[1].textContent, /^Diseña, documenta, implementa y depura un programa/);
  assert.equal(outcomes[0].children[2].textContent, "Competencia C.E.3");
  assert.equal(outcomes[4].children[2].textContent, "Competencia C.G.4 · en el programa: RA5.1");
  assert.match(outcomes[4].children[3].textContent, /Lab 1 1,7 % · Lab 2 0,73 %/);
  assert.match(outcomes[0].className, /is-selected/);
  await drive(browser, tab.el("teacherOutcomeHelpBtn").click());
  assert.equal(tab.el("teacherOutcomeHelp").hidden, true);
  await drive(browser, tab.el("settingsCloseBtn").click(), 400);

  // --- Bitacora: exportar en Excel o CSV solo con una bitacora cargada.
  assert.match(markup, /id="teacherBitacoraExportXlsxBtn"/);
  assert.match(markup, /id="teacherBitacoraExportCsvBtn"/);
  assert.match(markup, /Exportar bitácora \(Excel\)/);
  assert.match(markup, /Exportar bitácora \(CSV\)/);
  assertKnownShadowIds(tab);
  assert.deepEqual(browser.unknownRoutes.filter((route) => !route.includes("/api/projects") && !route.includes("/api/behavior/summary")), []);
});

// ---- Pestaña «Bitácora» del docente (0.7.16) ----

function teacherBitacoraBrowser() {
  const browser = new FakeBrowser();
  browser.session = { ...SESSION, user: { ...SESSION.user, id: "u-docente", role: "teacher", displayName: "Docente Prueba", assignedCourseCodes: [] } };
  browser.bitacoraLatest = null;
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-docente": true } });
  return browser;
}

// Evento de arrastre con un archivo, como el que da el navegador (dataTransfer.types trae "Files").
function fileDrag(file: File) {
  return { dataTransfer: { types: ["Files"], files: [file], dropEffect: "none" } };
}

test("0.7.16: pestaña «Bitácora»: estado en Inicio, «Subir bitácora» en la acción recomendada y soltar el archivo", async () => {
  const browser = teacherBitacoraBrowser();
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false && tab.state().teacherBitacoraStatus.checkedAt > 0, 400);

  // Una sola consulta al entrar, sin abrir la pestaña.
  assert.equal(browser.requestsTo("/api/documents/bitacora/status").length, 1);
  assert.equal(tab.el("tabBtnBitacora").hidden, false);
  assert.equal(tab.el("tabFlagBitacora").hidden, false, "la pestaña avisa que falta la bitácora");
  // Inicio: una línea con el estado que lleva a la pestaña (antes, un botón «Bitacora» en el resumen).
  assert.equal(tab.el("teacherBitacoraHomeLine").hidden, false);
  assert.equal(tab.el("teacherBitacoraHomeChip").textContent, "Falta");
  assert.match(tab.el("teacherBitacoraHomeText").textContent, /Aún no la subes/);
  assert.match(tab.el("teacherBitacoraHomeLine").getAttribute("aria-label"), /^Bitácora del curso, falta: /);
  // La acción recomendada pide subirla; la otra sigue siendo la del repositorio.
  assert.equal(tab.el("contextActionTitle").textContent, "Sube la bitácora del curso");
  assert.equal(tab.el("contextPrimaryActionBtn").dataset.contextAction, "upload_teacher_bitacora");
  assert.equal(tab.el("contextPrimaryActionBtn").textContent, "Subir bitácora");
  assert.equal(tab.el("contextSecondaryActionBtn").dataset.contextAction, "open_local_vscode");

  // «Subir bitácora»: la pestaña y el selector de archivo en el mismo clic.
  let pickerClicks = 0;
  tab.el("teacherBitacoraFileInput").addEventListener("click", () => { pickerClicks += 1; });
  await drive(browser, tab.el("contextPrimaryActionBtn").click());
  assert.equal(tab.state().mainTab, "bitacora");
  assert.equal(tab.el("tabPanelBitacora").hidden, false);
  assert.equal(tab.el("tabPanelInicio").hidden, true);
  assert.equal(tab.el("tabBtnBitacora").getAttribute("aria-selected"), "true");
  assert.equal(pickerClicks, 1, "abre el selector de archivo");
  assert.equal(browser.requestsTo("/api/documents/bitacora/status").length, 1, "el estado de hace menos de un minuto no se vuelve a pedir");
  assert.equal(tab.el("teacherBitacoraStateChip").textContent, "Falta");
  assert.match(tab.el("teacherBitacoraStatusText").textContent, /Aún no has subido la bitácora/);
  assert.equal(tab.el("teacherBitacoraLatestText").textContent, "Aún no hay bitácora cargada.");
  assert.equal(tab.el("teacherBitacoraChooseFileBtn").disabled, false);
  assert.equal(tab.el("teacherBitacoraExportXlsxBtn").disabled, true, "sin bitácora no hay nada que exportar");
  assert.equal(tab.el("teacherBitacoraDeleteLatestBtn").disabled, true);

  // Soltar un archivo que no es Excel ni PDF: no se sube y el estado dice por qué.
  await drive(browser, tab.el("tabPanelBitacora").dispatch("drop", fileDrag(new File(["hola"], "notas.docx"))));
  assert.deepEqual(browser.bitacoraUploads, []);
  assert.match(tab.el("statusText").textContent, /«notas\.docx» no es un Excel \(\.xlsx, \.xls\) ni un PDF/);

  // Arrastrar resalta la zona; soltar el Excel lo sube y la pestaña muestra la bitácora.
  const excel = new File(["xlsx"], "BITACORA.FPOO.2026-2.xlsx");
  await drive(browser, tab.el("tabPanelBitacora").dispatch("dragenter", fileDrag(excel)));
  assert.equal(tab.el("teacherBitacoraDropZone").classList.contains("is-dragover"), true);
  const overEvent = fileDrag(excel);
  await drive(browser, tab.el("tabPanelBitacora").dispatch("dragover", overEvent));
  assert.equal(overEvent.dataTransfer.dropEffect, "copy", "la pestaña acepta el archivo (si no, el navegador lo abriría)");
  await drive(browser, tab.el("tabPanelBitacora").dispatch("drop", fileDrag(excel)), 2000);
  assert.equal(tab.el("teacherBitacoraDropZone").classList.contains("is-dragover"), false);
  assert.deepEqual(browser.bitacoraUploads, ["BITACORA.FPOO.2026-2.xlsx"]);
  assert.equal(browser.requestsTo("/api/documents/bitacora/import", "POST").length, 1);
  assert.equal(tab.el("teacherBitacoraStateChip").textContent, "Cargada");
  assert.match(tab.el("teacherBitacoraLatestText").textContent, /^BITACORA\.FPOO\.2026-2\.xlsx · 2 semanas · actualizada /);
  assert.equal(tab.el("teacherBitacoraDropZone").classList.contains("is-loaded"), true);
  assert.equal(tab.el("tabFlagBitacora").hidden, true);
  assert.equal(tab.el("teacherBitacoraWeekCount").textContent, "2");
  assert.equal(tab.el("teacherBitacoraAgendaList").children.length, 2, "una fila por semana");
  assert.equal(tab.el("teacherBitacoraAgendaList").children[1].children[0].children[0].textContent, "Semana 2");
  assert.equal(tab.el("teacherBitacoraExportXlsxBtn").disabled, false);
  assert.equal(tab.el("teacherBitacoraDeleteLatestBtn").disabled, false);
  assert.equal(tab.state().analysisWindowOpen, false, "el resultado se ve en la pestaña, sin la ventana de análisis");
  assert.match(tab.el("statusText").textContent, /Bitácora subida: 2 registro\(s\)/);

  // Inicio: la línea dice que está cargada y la acción recomendada vuelve a la de siempre.
  await drive(browser, tab.el("tabBtnInicio").click());
  assert.equal(tab.el("teacherBitacoraHomeChip").textContent, "Cargada");
  assert.match(tab.el("teacherBitacoraHomeText").textContent, /^BITACORA\.FPOO\.2026-2\.xlsx · 2 semanas · actualizada /);
  assert.equal(tab.el("contextActionTitle").textContent, "Panel docente");
  assert.equal(tab.el("contextPrimaryActionBtn").dataset.contextAction, "open_settings");
  await drive(browser, tab.el("teacherBitacoraHomeLine").click());
  assert.equal(tab.state().mainTab, "bitacora", "la línea de Inicio lleva a la pestaña");
  assert.equal(tab.document.activeElement, tab.el("tabBtnBitacora"), "el foco pasa a la pestaña (la línea queda oculta)");

  // Markup: la página aparte y el botón «Bitacora» de Inicio ya no existen.
  const markup = tab.run<string>("buildOverlayMarkup()");
  assert.doesNotMatch(markup, /id="teacherBitacoraPage"|id="teacherBitacoraCloseBtn"|id="teacherBitacoraUploadBtn"|id="teacherBitacoraPageStatus"/);
  assert.match(markup, /id="tabPanelBitacora"[\s\S]*id="teacherBitacoraDropZone"[\s\S]*Subir bitácora \(Excel\/PDF\)/);
  assert.match(markup, /<details class="bitacora-fold" id="teacherBitacoraWeeksFold">/);
  assert.match(markup, /<details class="bitacora-fold" id="teacherBitacoraManualFold">/);
  assert.match(markup, /<details class="bitacora-fold is-danger" id="teacherBitacoraDataFold">/);
  assert.match(tab.run<string>("OVERLAY_STYLES"), /\.bitacora-dropzone\.is-dragover \{/);
  assertKnownShadowIds(tab);
  assert.deepEqual(browser.unknownRoutes.filter((route) => !route.includes("/api/projects") && !route.includes("/api/behavior/summary")), []);
});

test("0.7.16: docente en Campus sin bitácora: «Subir bitácora» y, al subirla, la acción pasa a «Analizar Campus»", async () => {
  const browser = teacherBitacoraBrowser();
  const tab = await openCampusCourse(browser);
  // La verificación del curso trae también el estado de la bitácora del docente: una sola consulta.
  assert.equal(browser.requestsTo("/api/documents/bitacora/status").length, 1);
  assert.ok(tab.state().teacherBitacoraStatus.checkedAt > 0);
  assert.equal(tab.el("tabFlagBitacora").hidden, false);
  assert.equal(tab.el("contextActionTitle").textContent, "Bitacora requerida");
  assert.match(tab.el("contextActionCopy").textContent, /aún no has subido la bitácora del curso/);
  assert.equal(tab.el("contextPrimaryActionBtn").textContent, "Subir bitácora");
  await drive(browser, tab.el("contextPrimaryActionBtn").click());
  assert.equal(tab.state().mainTab, "bitacora");

  // Con el selector de archivo: sube el PDF y el curso se vuelve a verificar solo.
  const input = tab.el("teacherBitacoraFileInput");
  input.files = [new File(["pdf"], "bitacora-fpoo.pdf")];
  await drive(browser, input.dispatch("change"), 2000);
  await browser.clock.until(() => !tab.run("isCampusAccessVerificationInFlight()"), 400);
  assert.deepEqual(browser.bitacoraUploads, ["bitacora-fpoo.pdf"]);
  assert.equal(browser.requestsTo("/api/documents/bitacora/status").length, 2, "el curso se vuelve a verificar tras subirla");
  assert.equal(tab.state().campusCourseAccess.bitacoraLoaded, true);
  await drive(browser, tab.el("tabBtnInicio").click());
  assert.equal(tab.el("contextActionTitle").textContent, "Agenda Campus");
  assert.equal(tab.el("contextPrimaryActionBtn").textContent, "Analizar Campus");
  assert.equal(tab.el("teacherBitacoraHomeChip").textContent, "Cargada");
  assertKnownShadowIds(tab);
});

test("0.7.16: docente en Campus fuera de un curso sin bitácora: la acción recomendada también es subirla", async () => {
  const browser = teacherBitacoraBrowser();
  const tab = await openTab(browser, "https://campusvirtual.univalle.edu.co/moodle/my/", "Área personal");
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false && tab.state().teacherBitacoraStatus.checkedAt > 0, 400);
  assert.equal(browser.requestsTo("/api/documents/bitacora/status").length, 1);
  assert.equal(tab.el("contextActionTitle").textContent, "Sube la bitácora del curso");
  assert.equal(tab.el("contextPrimaryActionBtn").dataset.contextAction, "upload_teacher_bitacora");
  assert.equal(tab.el("contextSecondaryActionBtn").dataset.contextAction, "open_settings", "sin repositorio, la otra acción es la tuerca");
  assertKnownShadowIds(tab);
});

// ---- Agenda del estudiante con la bitacora FPOO corrida al 25 de agosto de 2026 (0.7.17) ----

// La bitacora real de FPOO 2025 (PDF) leida y corrida con el mismo codigo del backend.
async function fpooBitacoraLatest(startDate = "2026-08-25") {
  const buffer = fs.readFileSync(path.resolve(process.cwd(), "tests/fixtures/bitacora-fpoo-2025.pdf"));
  const extracted = await extractDocumentText({ fileName: "Bitacora FPOO - Hoja 1.pdf", filePath: "Bitacora FPOO - Hoja 1.pdf", mimeType: "application/pdf", extension: "pdf", buffer });
  const agenda = extractBitacoraAgenda(extracted.text);
  const bitacoraAgenda = startDate ? shiftBitacoraAgendaToStart(agenda, startDate)!.agenda : agenda;
  return { id: "bitacora-fpoo", fileName: "Bitacora FPOO - Hoja 1.pdf", filePath: "Bitacora FPOO - Hoja 1.pdf", label: "BITACORA", confidence: 0.94, evidence: [], bitacoraAgenda, classifiedAt: "2026-08-20T12:00:00.000Z", updatedAt: "2026-08-20T12:00:00.000Z" } as Json;
}

// Domingo 27 de septiembre de 2026, 10:00 en Bogota: semana 5 (22 a 28 de septiembre).
const DOMINGO_SEMANA_5 = Date.parse("2026-09-27T15:00:00.000Z");

async function openStudentAgenda(browser: FakeBrowser) {
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, TUNNEL_URL, "taller-1");
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => tab.state().loading === false && tab.state().teacherBitacoraStatus.checkedAt > 0, 400);
  return tab;
}

test("0.7.17: el estudiante ve «Estás en FPOO · semana 5 de 16», el tutor recibe la semana y Calendar solo crea lo que falta", async () => {
  const browser = new FakeBrowser();
  browser.clock.now = DOMINGO_SEMANA_5;
  browser.bitacoraLatest = await fpooBitacoraLatest();
  // Un evento propio del estudiante el jueves 1 de octubre de 18:30 a 20:30.
  browser.calendarEvents.push({ id: "propio-1", summary: "Monitoria de calculo", start: { dateTime: "2026-10-01T18:30:00-05:00" }, end: { dateTime: "2026-10-01T20:30:00-05:00" } });
  const tab = await openStudentAgenda(browser);

  // Inicio: la linea con el curso, la semana, el tema y la proxima evaluacion.
  assert.equal(browser.requestsTo("/api/documents/bitacora/status").length, 1, "una consulta al entrar");
  assert.equal(tab.el("tabBtnAgenda").hidden, false);
  assert.equal(tab.el("agendaHomeLine").hidden, false);
  assert.equal(tab.el("teacherBitacoraHomeLine").hidden, true, "la linea del docente no es para el estudiante");
  assert.equal(tab.el("agendaHomeEyebrow").textContent, "Estás en FPOO · semana 5 de 16");
  assert.equal(tab.el("agendaHomeText").textContent, "Uso de clases de bibliotecas, APIs, y reutilización de código · Próximo: Examen (Primer parcial), mar 6 oct (en 9 días)");
  assert.equal(tab.el("agendaHomeChip").textContent, "Semana 5");

  // El tutor recibe la semana con la primera pregunta.
  const intervene = browser.requestsTo("/intervene")[0];
  assert.ok(intervene, "el tutor respondio al entrar");
  assert.deepEqual((intervene.body as Json).context && ((intervene.body as Json).context as Json).courseWeek, {
    courseCode: "FPOO",
    week: 5,
    totalWeeks: 16,
    topic: "Uso de clases de bibliotecas, APIs, y reutilización de código",
    weekStart: "2026-09-22",
    weekEnd: "2026-09-28",
    upcoming: [
      { title: "Examen (Primer parcial)", date: "2026-10-06", category: "Parcial" },
      { title: "Entrega de proyecto de curso 2", date: "2026-10-13", category: "Proyecto" },
      { title: "Proyecto 3 entrega", date: "2026-11-24", category: "Proyecto" },
    ],
  });

  // En el Tutor (donde entra en el editor) la misma semana, en una linea que lleva a «Agenda». Ahi
  // la tarjeta del codigo, que sigue al puntero, se oculta para no tapar las sugerencias.
  assert.equal(tab.el("tutorWeekLine").hidden, false);
  assert.equal(tab.el("tutorWeekChip").textContent, "Semana 5 de 16");
  assert.equal(tab.el("tutorWeekText").textContent, "FPOO: Uso de clases de bibliotecas, APIs, y reutilización de código");
  assert.equal(tab.el("vscodeSyncSection").hidden, false, "en el Tutor sigue la tarjeta del codigo");
  await drive(browser, tab.el("tutorWeekLine").click());
  assert.equal(tab.state().mainTab, "agenda");
  assert.equal(tab.el("vscodeSyncSection").hidden, true, "la tarjeta del codigo no tapa la agenda");
  await drive(browser, tab.run("setMainTab('inicio', { byUser: true, forceRender: true })"));
  assert.equal(tab.el("vscodeSyncSection").hidden, false);

  // «Agenda»: la semana, las proximas evaluaciones y todas las semanas.
  await drive(browser, tab.el("agendaHomeLine").click());
  assert.equal(tab.state().mainTab, "agenda");
  assert.equal(tab.el("tabPanelAgenda").hidden, false);
  assert.equal(tab.document.activeElement, tab.el("tabBtnAgenda"));
  assert.equal(tab.el("agendaTitle").textContent, "Estás en FPOO · semana 5 de 16");
  assert.match(tab.el("agendaStatusText").textContent, /· 22–28 sep · según la bitácora de tu docente\.$/);
  assert.equal(tab.el("agendaWeekCard").hidden, false);
  assert.equal(tab.el("agendaWeekTopic").textContent, "Uso de clases de bibliotecas, APIs, y reutilización de código");
  assert.equal(tab.el("agendaWeekActivities").children[0].textContent, "Software modular, refactoring, reutilización de código y calidad");
  const upcoming = tab.el("agendaUpcomingList").children;
  assert.equal(upcoming.length, 4);
  assert.deepEqual(Array.from(upcoming[0].children, (child) => child.textContent), ["mar 6 oct", "Examen (Primer parcial)", "Parcial · semana 7 · en 9 días"]);
  assert.equal(upcoming[1].children[1].textContent, "Entrega de proyecto de curso 2");
  assert.equal(tab.el("agendaWeeksCount").textContent, "16");
  const weekRows = tab.el("agendaWeeksList").children;
  assert.equal(weekRows.length, 17, "16 semanas y la sesion opcional");
  assert.equal(weekRows[4].className, "agenda-week-row is-current");
  assert.equal(weekRows[4].children[0].textContent, "Semana 5 · 22–28 sep · hoy");
  assert.equal(weekRows[15].children[0].textContent, "Semana 16 · 8–14 dic");
  assert.equal(weekRows[16].children[1].textContent, "OPCIONAL");
  assert.match(tab.el("agendaCalendarNote").textContent, /Pasa a tu Google Calendar \(alumno@correounivalle\.edu\.co\)/);

  // Google Calendar: el primer parcial ya esta (el estudiante lo paso a las 2 p. m.), la entrega 2
  // quedo con la fecha vieja, el estudiante anoto la entrega 3 a su manera, paso la entrega 4 al
  // dia anterior y la entrega final vino de Campus. El parcial de otra materia el dia del segundo
  // parcial no cuenta.
  const keys = tab.run<string[]>("getCourseAgendaView().upcoming.map((evaluation) => evaluation.key)");
  assert.equal(keys.length, 6);
  const courseProps = (key: string) => ({ private: { adaceen: "bitacora", adaceenCourse: "FPOO", adaceenKey: key, adaceenType: "evaluation" } });
  browser.calendarEvents.push(
    { id: "ya-1", summary: "FPOO: Examen (Primer parcial)", start: { dateTime: "2026-10-06T14:00:00-05:00" }, end: { dateTime: "2026-10-06T16:00:00-05:00" }, extendedProperties: courseProps(keys[0]) },
    { id: "vieja-2", summary: "FPOO: Entrega de proyecto de curso 2", start: { dateTime: "2026-10-14T18:00:00-05:00" }, end: { dateTime: "2026-10-14T18:30:00-05:00" }, extendedProperties: courseProps(keys[1]) },
    { id: "propio-3", summary: "Entregar proyecto 3 de POO", start: { dateTime: "2026-11-24T23:00:00-05:00" }, end: { dateTime: "2026-11-24T23:30:00-05:00" } },
    { id: "movida-4", summary: "FPOO: Entrega proyecto 4", start: { dateTime: "2026-11-30T20:00:00-05:00" }, end: { dateTime: "2026-11-30T21:00:00-05:00" }, extendedProperties: { private: { ...courseProps(keys[4]).private, adaceenDate: "2026-12-01" } } },
    { id: "calculo", summary: "Parcial de Cálculo I", start: { dateTime: "2026-12-01T14:00:00-05:00" }, end: { dateTime: "2026-12-01T16:00:00-05:00" } },
    { id: "campus-final", summary: "ADACEEN entrega: Entrega proyecto final", start: { dateTime: "2026-12-08T23:59:00-05:00" }, end: { dateTime: "2026-12-09T00:29:00-05:00" }, extendedProperties: { private: { adaceen: "campus", adaceenType: "professor_due" } } },
  );
  await drive(browser, tab.el("agendaCalendarSyncBtn").click(), 2000);
  assert.equal(tab.el("agendaCalendarStatus").textContent, "Google Calendar al día: 1 evento creado, 1 con la fecha corregida, 2 ya estaban, 2 ya los tenías con otro nombre.");
  const inserted = browser.calendarMessages.filter((message) => message.type === "ADACEEN_GOOGLE_CALENDAR_INSERT").map((message) => message.event as Json);
  assert.deepEqual(inserted.map((event) => event.summary), ["FPOO: Examen (segundo parcial)"]);
  assert.deepEqual(inserted[0].start, { dateTime: "2026-12-01T09:00:00-05:00", timeZone: "America/Bogota" });
  assert.deepEqual(inserted[0].end, { dateTime: "2026-12-01T11:00:00-05:00", timeZone: "America/Bogota" }, "el parcial dura dos horas");
  assert.deepEqual((inserted[0].reminders as Json).overrides, [{ method: "popup", minutes: 1440 }, { method: "popup", minutes: 60 }]);
  assert.deepEqual((inserted[0].extendedProperties as Json).private, { adaceen: "bitacora", adaceenCourse: "FPOO", adaceenKey: keys[3], adaceenType: "evaluation", adaceenDate: "2026-12-01" });
  const byId = (id: string) => browser.calendarEvents.find((event) => event.id === id) as Json;
  const moved = byId("vieja-2");
  assert.deepEqual([(moved.start as Json).dateTime, (moved.end as Json).dateTime], ["2026-10-13T18:00:00-05:00", "2026-10-13T18:30:00-05:00"], "la entrega 2 pasa al dia nuevo con su hora y su duracion");
  assert.equal(((moved.extendedProperties as Json).private as Json).adaceenDate, "2026-10-13", "y guarda la fecha nueva de la bitacora");
  assert.equal((byId("ya-1").start as Json).dateTime, "2026-10-06T14:00:00-05:00", "la hora que puso el estudiante no se deshace");
  assert.equal((byId("movida-4").start as Json).dateTime, "2026-11-30T20:00:00-05:00", "ni el dia, si la bitacora no cambio");
  assert.equal(browser.calendarMessages.filter((message) => message.type === "ADACEEN_GOOGLE_CALENDAR_PATCH").length, 1);
  assert.ok(browser.calendarMessages.some((message) => message.type === "ADACEEN_GOOGLE_CALENDAR_ACCOUNT"), "comprueba la cuenta de Google");
  const windowQuery = browser.calendarMessages.find((message) => message.type === "ADACEEN_GOOGLE_CALENDAR_LIST" && (message.query as Json).timeMin)?.query as Json;
  assert.deepEqual([windowQuery.timeMin, windowQuery.timeMax], ["2026-09-27T00:00:00-05:00", "2026-12-08T23:59:59-05:00"], "mira el calendario de hoy a la ultima entrega");

  // Otra vez: no se repite nada.
  const insertsBefore = browser.calendarEvents.length;
  await drive(browser, tab.el("agendaCalendarSyncBtn").click(), 2000);
  assert.equal(tab.el("agendaCalendarStatus").textContent, "Google Calendar al día: 4 ya estaban, 2 ya los tenías con otro nombre.");
  assert.equal(browser.calendarEvents.length, insertsBefore);

  // Bloques de estudio: horas libres antes de las tres proximas evaluaciones.
  await drive(browser, tab.el("agendaSuggestBtn").click(), 2000);
  assert.equal(tab.el("agendaSuggestionsBlock").hidden, false);
  assert.match(tab.el("agendaSuggestionsNote").textContent, /horas libres de tu Google Calendar/);
  const suggestions = tab.el("agendaSuggestionList").children;
  const suggestionText = (index: number) => suggestions[index].children[0].children[1].children.map((child: FakeElement) => child.textContent).join(" | ");
  assert.equal(suggestions.length, 6);
  assert.equal(suggestionText(0), "Repasar: Examen (Primer parcial) | jue 1 oct, 16:30–18:30 · 5 días antes del parcial", "esquiva la monitoria de 18:30");
  assert.equal(suggestionText(1), "Repasar: Examen (Primer parcial) | dom 4 oct, 9:00–11:00 · 2 días antes del parcial");
  assert.equal(suggestionText(2), "Avanzar: Entrega de proyecto de curso 2 | vie 9 oct, 18:30–20:00 · 4 días antes de la entrega");
  assert.equal(suggestionText(3), "Avanzar: Entrega de proyecto de curso 2 | lun 12 oct, 18:30–20:00 · Un día antes de la entrega");
  // Se desmarca uno y se agregan los otros cinco.
  const checkbox = suggestions[3].children[0].children[0];
  checkbox.checked = false;
  await drive(browser, tab.el("agendaSuggestionList").dispatch("change", { target: checkbox }));
  await drive(browser, tab.el("agendaSuggestionAddBtn").click(), 2000);
  assert.equal(tab.el("agendaCalendarStatus").textContent, "Bloques de estudio: 5 agregados.");
  const studyEvents = browser.calendarEvents.filter((event) => ((event.extendedProperties as Json)?.private as Json)?.adaceenType === "study_block");
  assert.equal(studyEvents.length, 5);
  assert.equal(studyEvents[0].summary, "Repasar: Examen (Primer parcial) (FPOO)");
  assert.deepEqual(studyEvents[0].start, { dateTime: "2026-10-01T16:30:00-05:00", timeZone: "America/Bogota" });

  // Si Chrome tiene otra cuenta de Google, no se toca ese calendario.
  browser.googleAccount = "alumno.personal@gmail.com";
  const eventsBefore = browser.calendarEvents.length;
  await drive(browser, tab.el("agendaCalendarSyncBtn").click(), 2000);
  assert.match(tab.el("agendaCalendarStatus").textContent, /Chrome tiene abierta la cuenta de Google alumno\.personal@gmail\.com\. Para no llenar otro calendario, sincroniza con la misma cuenta de tu sesión: alumno@correounivalle\.edu\.co\./);
  assert.equal(browser.calendarEvents.length, eventsBefore);

  // El docente corre la bitacora una semana (inicio el 1 de septiembre): lo que puso ADACEEN pasa
  // al dia nuevo con su hora, tambien la entrega que el estudiante habia movido; lo que tenia con
  // otro nombre en la fecha vieja ya no cuenta y se crea.
  browser.googleAccount = "alumno@correounivalle.edu.co";
  browser.bitacoraLatest = await fpooBitacoraLatest("2026-09-01");
  await drive(browser, tab.el("agendaRefreshBtn").click(), 2000);
  assert.equal(tab.el("agendaTitle").textContent, "Estás en FPOO · semana 4 de 16");
  await drive(browser, tab.el("agendaCalendarSyncBtn").click(), 2000);
  assert.equal(tab.el("agendaCalendarStatus").textContent, "Google Calendar al día: 2 eventos creados, 4 con la fecha corregida.");
  assert.equal((byId("ya-1").start as Json).dateTime, "2026-10-13T14:00:00-05:00");
  assert.equal((byId("vieja-2").start as Json).dateTime, "2026-10-20T18:00:00-05:00");
  assert.equal((byId("movida-4").start as Json).dateTime, "2026-12-08T20:00:00-05:00");
  assert.equal(((byId("movida-4").extendedProperties as Json).private as Json).adaceenDate, "2026-12-08");
  const lastInserts = browser.calendarMessages.filter((message) => message.type === "ADACEEN_GOOGLE_CALENDAR_INSERT").slice(-2).map((message) => (message.event as Json).summary);
  assert.deepEqual(lastInserts, ["FPOO: Proyecto 3 entrega", "FPOO: Entrega proyecto final"]);
  assertKnownShadowIds(tab);
  assert.deepEqual(browser.unknownRoutes.filter((route) => !route.includes("/api/projects") && !route.includes("/api/behavior/summary")), []);
});

test("0.7.17: sin el correo de la universidad no se sincroniza; sin bitácora la agenda lo dice", async () => {
  const browser = new FakeBrowser();
  browser.clock.now = DOMINGO_SEMANA_5;
  browser.session = { ...SESSION, user: { ...SESSION.user, email: "alumno@gmail.com" } };
  browser.bitacoraLatest = await fpooBitacoraLatest();
  const tab = await openStudentAgenda(browser);
  await drive(browser, tab.el("tabBtnAgenda").click());
  assert.equal(tab.el("agendaCalendarSyncBtn").disabled, true);
  assert.equal(tab.el("agendaCalendarNote").textContent, "Para sincronizar con Google Calendar entra a ADACEEN con tu correo de la universidad (…@correounivalle.edu.co); ahora estás con alumno@gmail.com.");
  // Las sugerencias salen igual, sin revisar el calendario.
  await drive(browser, tab.el("agendaSuggestBtn").click(), 2000);
  assert.match(tab.el("agendaSuggestionsNote").textContent, /sin revisar tu calendario/);
  assert.equal(tab.el("agendaSuggestionAddBtn").disabled, true);
  assert.deepEqual(browser.calendarMessages, [], "sin permiso de Google no se le pide nada al background");

  const noLog = new FakeBrowser();
  noLog.clock.now = DOMINGO_SEMANA_5;
  noLog.bitacoraLatest = null;
  const noLogTab = await openStudentAgenda(noLog);
  assert.equal(noLogTab.el("agendaHomeText").textContent, "Tu docente aún no sube la bitácora del curso.");
  assert.equal(noLogTab.el("agendaHomeChip").textContent, "Sin bitácora");
  assert.equal(noLogTab.el("tutorWeekLine").hidden, true, "sin semana no hay linea en el Tutor");
  assert.equal(noLogTab.run("buildCourseWeekForTutor()"), null);
  const intervene = noLog.requestsTo("/intervene")[0];
  assert.equal(((intervene?.body as Json)?.context as Json)?.courseWeek, undefined, "sin semana, el tutor no la recibe");
  assertKnownShadowIds(tab, noLogTab);
});

test("0.7.17: el docente corre la bitácora de 2025 con «Inicio del semestre» y ve la semana de hoy", async () => {
  const browser = new FakeBrowser();
  browser.clock.now = DOMINGO_SEMANA_5;
  browser.session = { ...SESSION, user: { ...SESSION.user, id: "u-docente", role: "teacher", displayName: "Docente Prueba", assignedCourseCodes: [] } };
  browser.bitacoraLatest = await fpooBitacoraLatest("");
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-docente": true } });
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => tab.state().loading === false && tab.state().teacherBitacoraStatus.checkedAt > 0, 400);
  assert.equal(tab.el("tabBtnAgenda").hidden, true, "«Agenda» es del estudiante");
  assert.equal(tab.el("agendaHomeLine").hidden, true);

  await drive(browser, tab.el("tabBtnBitacora").click());
  assert.equal(tab.el("teacherBitacoraStartDateInput").value, "2025-08-20", "la fecha de la semana 1 que trae el PDF");
  assert.equal(tab.el("teacherBitacoraStatusText").textContent, "Cargada. Si subes otra, reemplaza a esta.", "en 2026 esa bitacora ya termino");
  assert.equal(tab.el("teacherBitacoraStartNote").textContent, "Semana 1: mié 20 ago · semana 16: mié 3 dic. Al cambiar la fecha, todas las semanas se corren igual (cada 7 días).");

  const input = tab.el("teacherBitacoraStartDateInput");
  input.value = "2026-08-25";
  await drive(browser, input.dispatch("input"));
  await drive(browser, tab.el("teacherBitacoraStartApplyBtn").click(), 2000);
  assert.deepEqual(browser.requestsTo("/api/documents/bitacora/start-date", "PUT").map((request) => request.body), [{ startDate: "2026-08-25" }]);
  assert.equal(tab.el("teacherBitacoraStatusText").textContent, "Cargada. Hoy va en la semana 5 de 16. Si subes otra, reemplaza a esta.");
  assert.equal(tab.el("teacherBitacoraStartNote").textContent, "Semana 1: mar 25 ago · semana 16: mar 8 dic. Al cambiar la fecha, todas las semanas se corren igual (cada 7 días).");
  assert.match(tab.el("statusText").textContent, /Fechas corridas: la semana 1 queda el mar 25 ago y la última fecha es el mar 15 dic \(16 semanas\)\./);
  const weeks = tab.el("teacherBitacoraAgendaList").children;
  assert.equal(weeks[4].className, "bitacora-week-item is-current");
  assert.equal(weeks[4].children[0].children[1].textContent, "22-9-2026 · esta semana");
  assert.equal(weeks[0].children[0].children[1].textContent, "25-8-2026");
  assertKnownShadowIds(tab);
});

// ---- Riesgos antes del piloto (navegador 0.7.18, A12.12 · ADACEEN-155) ----

test("0.7.18: el tutor no se repite ante un fallo y lleva Idempotency-Key; la pestaña oculta no sondea y avisa al cerrarse", async () => {
  const browser = new FakeBrowser();
  browser.provider = "codespaces";
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);

  // «Empezar» pidio ayuda una vez, con su Idempotency-Key.
  const first = browser.requestsTo("/intervene");
  assert.equal(first.length, 1);
  const firstKey = String(first[0].headers["Idempotency-Key"] || "");
  assert.match(firstKey, /^[A-Za-z0-9._:-]{8,128}$/, "clave de idempotencia valida para el backend");
  assert.equal(browser.requestsTo("/github-mentor").length, 0);

  // Un fallo pasajero (503) ya no se repite en /github-mentor: duplicaba el modelo y el cupo.
  browser.interveneStatus = 503;
  const status = await drive(browser, tab.run("requestBackendMentor(overlayState.context || buildPayload(), 'C++').then(() => 0, (error) => error.status)"));
  assert.equal(status, 503);
  assert.equal(browser.requestsTo("/intervene").length, 2);
  assert.equal(browser.requestsTo("/github-mentor").length, 0, "503: sin segundo intento");

  // Un backend sin /intervene (404) si prueba el nombre viejo, con la misma clave.
  browser.interveneStatus = 404;
  await drive(browser, tab.run("requestBackendMentor(overlayState.context || buildPayload(), 'C++')"));
  const intervene404 = browser.requestsTo("/intervene").at(-1)!;
  const mentor = browser.requestsTo("/github-mentor");
  assert.equal(mentor.length, 1);
  assert.equal(mentor[0].headers["Idempotency-Key"], intervene404.headers["Idempotency-Key"]);
  assert.notEqual(intervene404.headers["Idempotency-Key"], firstKey, "cada pedido tiene su clave");
  browser.interveneStatus = 200;

  // Pestaña oculta: no sondea /api/ui/active-tab (antes cada 9 s); al volver, si.
  const getsBefore = browser.requestsTo("/api/ui/active-tab", "GET").length;
  tab.document.visibilityState = "hidden";
  await advance(browser, 60_000);
  assert.equal(browser.requestsTo("/api/ui/active-tab", "GET").length, getsBefore, "oculta, sin sondeo");
  tab.document.visibilityState = "visible";
  await advance(browser, 10_000);
  assert.ok(browser.requestsTo("/api/ui/active-tab", "GET").length > getsBefore, "visible, vuelve a sondear");

  // Al cerrar la pestaña (pagehide) avisa en el acto con su tabId (antes el setTimeout de
  // beforeunload nunca corria).
  const postsBefore = browser.requestsTo("/api/ui/active-tab", "POST").length;
  await tab.dispatchWindowEvent("pagehide", { persisted: false });
  const posts = browser.requestsTo("/api/ui/active-tab", "POST").slice(postsBefore);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body?.isActive, false);
  assert.equal(posts[0].body?.tabId, tab.run("getActiveTabInstanceId()"));

  // Lo oculto se oculta siempre: la regla [hidden] del estilo base gana a display: grid.
  const baseStyles = String(tab.run("OVERLAY_BASE_STYLES"));
  assert.match(baseStyles, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
});


// ---- Entorno de los estudiantes desde la tuerca del administrador (navegador 0.7.19) ----

const ADMIN_SESSION = {
  ...SESSION,
  user: { ...SESSION.user, id: "u-admin", role: "admin", email: "admin@correounivalle.edu.co", displayName: "Admin Prueba", assignedCourseCodes: [] },
};

test("0.7.19: el administrador elige en la tuerca si los estudiantes usan el editor en la nube o Codespaces", async () => {
  const browser = new FakeBrowser();
  browser.session = ADMIN_SESSION;
  browser.provider = "codespaces";
  browser.workspaceSetting = {
    provider: "codespaces",
    source: "server",
    serverProvider: "codespaces",
    choice: null,
    updatedAt: null,
    updatedBy: null,
    agentConfigured: true,
    agentOnline: false,
    transport: "relay",
    vmAutostart: false,
  };
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-admin": true } });
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => tab.state().loading === false, 400);
  assert.deepEqual(browser.requestsTo("/api/admin/workspace-provider"), [], "no se consulta hasta abrir la tuerca");

  // La tuerca del administrador abre la seccion con lo que dice el backend.
  await drive(browser, tab.el("settingsBtn").click(), 400);
  await browser.clock.until(() => !!tab.state().workspaceProviderSetting, 400);
  const section = tab.el("settingsSectionWorkspace");
  assert.equal(section.hidden, false);
  assert.equal(section.open, true, "el administrador empieza por el entorno de los estudiantes");
  const select = tab.el("workspaceProviderSelect");
  assert.equal(select.value, "server");
  assert.equal(select.disabled, false);
  assert.equal(tab.el("workspaceProviderServerOption").textContent, "Lo que diga el servidor (GitHub Codespaces)");
  assert.equal(tab.el("workspaceProviderActiveValue").textContent, "GitHub Codespaces · del servidor");
  assert.equal(tab.el("workspaceAgentValue").textContent, "Apagada");
  assert.equal(tab.el("workspaceProviderServerValue").textContent, "ADACEEN_WORKSPACE_PROVIDER = codespaces");
  assert.equal(tab.el("workspaceProviderUpdatedValue").textContent, "Nunca: manda el servidor");
  assert.equal(tab.el("workspaceProviderNote").textContent, "Se aplica con «Guardar cambios». Los estudiantes lo ven al recargar la página o en unos minutos.");
  assert.equal(tab.el("workspaceProviderTunnelOption").disabled, false);

  // Un render no pisa lo elegido y sin guardar.
  select.value = "tunnel";
  await drive(browser, tab.run("Promise.resolve(renderOverlay())"));
  assert.equal(select.value, "tunnel");

  // «Guardar cambios»: PUT, el proveedor de este overlay cambia ya y la linea de estado lo dice.
  const providerChecks = browser.requestsTo("/api/workspaces/provider").length;
  await drive(browser, tab.el("saveSettingsBtn").click(), 2000);
  assert.deepEqual(browser.workspaceSettingPuts, [{ provider: "tunnel" }]);
  assert.equal(tab.state().workspaceProvider, "tunnel");
  assert.ok(browser.requestsTo("/api/workspaces/provider").length > providerChecks, "vuelve a consultar el proveedor sin esperar 5 min");
  assert.equal(
    tab.el("statusText").textContent,
    "Entorno de los estudiantes: editor en la nube (túnel de VS Code). Lo verán al recargar la página o en unos minutos. La VM de editores está apagada: enciéndela antes de la clase con bash deploy/clase.sh iniciar.",
  );

  // Al volver a abrir: lo guardado, quien y cuando, y el aviso de la VM apagada.
  await drive(browser, tab.el("settingsBtn").click(), 400);
  await browser.clock.until(() => tab.state().workspaceProviderSettingBusy === false, 400);
  assert.equal(select.value, "tunnel");
  assert.equal(tab.el("workspaceProviderActiveValue").textContent, "Editor en la nube (túnel) · elegido aquí");
  assert.match(tab.el("workspaceProviderUpdatedValue").textContent, / · Admin Prueba$/);
  assert.equal(tab.el("workspaceProviderNote").textContent, "La VM de editores está apagada: enciéndela antes de la clase con bash deploy/clase.sh iniciar.");
  assert.equal(tab.el("workspaceProviderNote").classList.contains("is-warning"), true);
  assert.equal(tab.el("settingsSectionWorkspaceHint").textContent, "Ahora: Editor en la nube (túnel)");

  // Sin cambiar el selector, «Guardar cambios» no vuelve a mandar el entorno.
  await drive(browser, tab.el("saveSettingsBtn").click(), 2000);
  assert.equal(browser.workspaceSettingPuts.length, 1);

  // Volver a lo que diga el servidor.
  await drive(browser, tab.el("settingsBtn").click(), 400);
  await browser.clock.until(() => tab.state().workspaceProviderSettingBusy === false, 400);
  select.value = "server";
  await drive(browser, tab.el("saveSettingsBtn").click(), 2000);
  assert.deepEqual(browser.workspaceSettingPuts.at(-1), { provider: "server" });
  assert.equal(tab.state().workspaceProvider, "codespaces");
  assertKnownShadowIds(tab);
});

test("0.7.19: sin el agente de la VM el tunel no se puede elegir; un backend anterior lo dice; el docente tambien elige; el estudiante no ve la seccion", async () => {
  const browser = new FakeBrowser();
  browser.session = ADMIN_SESSION;
  browser.provider = "codespaces";
  browser.workspaceSetting = {
    provider: "codespaces",
    source: "server",
    serverProvider: "codespaces",
    choice: null,
    updatedAt: null,
    updatedBy: null,
    agentConfigured: false,
    agentOnline: false,
    transport: "relay",
    vmAutostart: false,
  };
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-admin": true } });
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => tab.state().loading === false, 400);
  await drive(browser, tab.el("settingsBtn").click(), 400);
  await browser.clock.until(() => !!tab.state().workspaceProviderSetting, 400);
  assert.equal(tab.el("workspaceProviderTunnelOption").disabled, true);
  assert.equal(tab.el("workspaceAgentValue").textContent, "Sin configurar");
  assert.equal(
    tab.el("workspaceProviderNote").textContent,
    "Para elegir el editor en la nube falta conectar la VM de editores una vez: bash deploy/produccion.sh aplicar en Cloud Shell.",
  );
  // Si aun asi llega el pedido (otra pestaña, otra version), el backend responde 409 y el selector vuelve.
  const select = tab.el("workspaceProviderSelect");
  select.value = "tunnel";
  await drive(browser, tab.el("saveSettingsBtn").click(), 2000);
  assert.equal(browser.workspaceSettingPuts.length, 1);
  assert.equal(select.value, "server");
  assert.equal(tab.state().workspaceProvider, "codespaces");
  assert.match(tab.el("statusText").textContent, /^No se pudo cambiar el entorno de los estudiantes: Para usar el editor en la nube falta conectar la VM de editores/);

  // Backend anterior a 0.7.19: la seccion lo dice y no se puede elegir.
  const old = new FakeBrowser();
  old.session = ADMIN_SESSION;
  old.provider = "codespaces";
  seedLoggedInBrowser(old, { adaceenPrivacyAcceptedByUser: { "u-admin": true } });
  const oldTab = await openTab(old, `https://github.com/${REPO}`, REPO);
  await drive(old, oldTab.run("openOverlay({ trigger: 'user' })"));
  await old.clock.until(() => oldTab.state().loading === false, 400);
  await drive(old, oldTab.el("settingsBtn").click(), 400);
  await old.clock.until(() => !!oldTab.state().workspaceProviderSettingError, 400);
  assert.equal(oldTab.el("workspaceProviderNote").textContent, "Este backend todavía no permite elegir el entorno desde aquí: llega con la versión 0.7.19.");
  assert.equal(oldTab.el("workspaceProviderSelect").disabled, true);
  await drive(old, oldTab.el("saveSettingsBtn").click(), 2000);
  assert.deepEqual(old.requestsTo("/api/admin/workspace-provider").map((request) => request.method), ["GET"], "sin datos del backend no se manda nada");

  // Docente: ve la seccion (la tuerca empieza por su politica) y la puede cambiar.
  const teacher = new FakeBrowser();
  teacher.session = { ...SESSION, user: { ...SESSION.user, id: "u-docente", role: "teacher", displayName: "Docente Prueba", assignedCourseCodes: [] } };
  teacher.provider = "codespaces";
  teacher.workspaceSetting = { ...browser.workspaceSetting, agentConfigured: true, agentOnline: true };
  seedLoggedInBrowser(teacher, { adaceenPrivacyAcceptedByUser: { "u-docente": true } });
  const teacherTab = await openTab(teacher, `https://github.com/${REPO}`, REPO);
  await drive(teacher, teacherTab.run("openOverlay({ trigger: 'user' })"));
  await teacher.clock.until(() => teacherTab.state().loading === false, 400);
  await drive(teacher, teacherTab.el("settingsBtn").click(), 400);
  await teacher.clock.until(() => !!teacherTab.state().workspaceProviderSetting, 400);
  assert.equal(teacherTab.el("settingsSectionWorkspace").hidden, false);
  assert.equal(teacherTab.el("settingsSectionWorkspace").open, false, "el docente empieza por su politica");
  assert.equal(teacherTab.el("settingsSectionPolicy").open, true);
  assert.equal(teacherTab.el("workspaceAgentValue").textContent, "Conectada");
  teacherTab.el("workspaceProviderSelect").value = "tunnel";
  await drive(teacher, teacherTab.el("saveSettingsBtn").click(), 2000);
  assert.deepEqual(teacher.workspaceSettingPuts, [{ provider: "tunnel" }]);
  assert.equal(teacherTab.state().workspaceProvider, "tunnel");

  // Estudiante: ni la seccion ni la consulta.
  const student = new FakeBrowser();
  seedLoggedInBrowser(student);
  const studentTab = await openTab(student, TUNNEL_URL, "taller-1");
  await drive(student, studentTab.run("openOverlay({ trigger: 'user' })"));
  await student.clock.until(() => studentTab.state().loading === false, 400);
  await drive(student, studentTab.el("settingsBtn").click(), 400);
  assert.equal(studentTab.el("settingsSectionWorkspace").hidden, true);
  assert.deepEqual(student.requestsTo("/api/admin/workspace-provider"), []);
  assertKnownShadowIds(tab, oldTab, teacherTab, studentTab);
});

// ---- Un editor, varios repositorios (0.7.20) ----

const OTHER_REPO = "univalle-fpoo/taller-2";
const OTHER_TUNNEL_URL = "https://vscode.dev/tunnel/ws-alumno/home/ws-alumno/taller-2";

// Respuesta del backend 0.7.20 para OTHER_REPO: webUrl de su carpeta y los editors de la VM.
function otherRepoWorkspace(status: string, extra: Json = {}) {
  return {
    ok: status !== "error",
    provider: "tunnel",
    status,
    workspace: { login: "alumno", tunnelName: "ws-alumno", webUrl: status === "ready" ? OTHER_TUNNEL_URL : "", repoFullName: OTHER_REPO },
    editors: [
      { repoFullName: REPO, webUrl: TUNNEL_URL },
      { repoFullName: OTHER_REPO, webUrl: OTHER_TUNNEL_URL },
      { repoFullName: "otra-cuenta/ajeno", webUrl: "https://evil.example/x" },
    ],
    ...extra,
  };
}

// El boton: en la cabecera de GitHub un <li> con un <span> que tiene la shadow root (un <li> no
// la admite); flotando, un <div> que la tiene. El DOM falso no tiene la cabecera: flota.
function repoButton(tab: TabEnv) {
  const host = tab.document.getElementById("adaceen-repo-editor-button");
  const shadow = host?.shadow || host?.children[0]?.shadow;
  return shadow
    ? { host, button: shadow.getElementById("adaceenRepoEditorBtn"), label: shadow.getElementById("adaceenRepoEditorLabel") }
    : null;
}

test("0.7.20: «Abrir en mi editor» en la pagina del repositorio abre ESE repositorio en su carpeta, sin abrir el overlay", async () => {
  const browser = new FakeBrowser();
  browser.githubConnected = true;
  seedLoggedInBrowser(browser, { adaceenEditorByUser: { [EDITOR_KEY]: savedEditorRecord(browser) } });
  const tab = await openTab(browser, `https://github.com/${OTHER_REPO}`, `${OTHER_REPO}: taller 2`);

  await browser.clock.until(() => !!repoButton(tab), 50);
  const ui = repoButton(tab);
  assert.ok(ui, "boton en la pagina del repositorio");
  assert.equal(tab.run("overlayHost"), null, "sin abrir el overlay");
  assert.equal(ui!.label.textContent, "Abrir en mi editor");
  assert.match(ui!.button.title, /Agrega univalle-fpoo\/taller-2 a tu editor en la nube y lo abre\. No te pide otro codigo/);
  assert.equal(ui!.button.getAttribute("aria-label"), `Abrir en mi editor: ${OTHER_REPO}`);

  // Un clic: la ventana se abre en el mismo clic; sin editor guardado para ESTE repo va directo a
  // prepare (que lo clona en su carpeta) y abre su URL.
  browser.prepareSteps = [otherRepoWorkspace("pending", { message: "Clonando el repositorio..." })];
  browser.statusSteps = [otherRepoWorkspace("pending", { message: "Clonando el repositorio..." }), otherRepoWorkspace("ready")];
  await ui!.button.click();
  assert.equal(tab.popups.length, 1, "la ventana de espera se abre en el clic (sin bloqueo de popups)");
  await advance(browser, 400);
  assert.equal(repoButton(tab)!.label.textContent, "Preparando tu editor...");
  assert.equal(repoButton(tab)!.button.disabled, true);
  await browser.clock.until(() => tab.popups[0]?.currentHref === OTHER_TUNNEL_URL, 400);
  assert.equal(tab.popups[0].currentHref, OTHER_TUNNEL_URL, "abre la carpeta de ese repositorio");
  const prepares = browser.requests.filter((request) => request.path === "/api/workspaces/prepare");
  assert.equal(prepares.length, 1);
  assert.equal(prepares[0].body?.repoFullName, OTHER_REPO, "el repositorio de la pagina");
  await advance(browser, 400);
  assert.equal(repoButton(tab)!.label.textContent, "Abrir en mi editor");
  assert.equal(repoButton(tab)!.button.disabled, false);

  // Los dos repositorios quedan guardados (el de antes sin tocar); lo ajeno de editors no entra.
  const saved = browser.storage.adaceenEditorByUser as Record<string, Json>;
  assert.equal(saved[`${SESSION.user.id}:${OTHER_REPO}`]?.webUrl, OTHER_TUNNEL_URL);
  assert.equal(saved[EDITOR_KEY]?.webUrl, TUNNEL_URL);
  assert.equal(Object.keys(saved).some((key) => key.includes("ajeno")), false);

  // En el editor (vscode.dev) el repositorio sale de la carpeta de la URL, no del ultimo guardado.
  const editorTab = await openTab(browser, TUNNEL_URL, "taller-1 - Visual Studio Code");
  await drive(browser, editorTab.run("syncFromStorageSnapshot({ force: true })"));
  assert.equal(editorTab.run("inferRepoFromContext(buildPayload())"), REPO);
  const otherEditorTab = await openTab(browser, `${OTHER_TUNNEL_URL}/src`, "taller-2 - Visual Studio Code");
  await drive(browser, otherEditorTab.run("syncFromStorageSnapshot({ force: true })"));
  assert.equal(otherEditorTab.run("inferRepoFromContext(buildPayload())"), OTHER_REPO);
  assert.equal(repoButton(editorTab), null, "en el editor no hay boton de GitHub");

  // Inicio: «Tus repositorios en el editor» ofrece los otros a un clic (no el de la pagina).
  // (El traspaso al editor dejo el overlay fijado y minimizado en esta pestana, como siempre.)
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"));
  if (!tab.state().started) await drive(browser, tab.run("enterOverlayIdle('user')"));
  await browser.clock.until(() => tab.el("mainView")?.hidden === false, 200);
  assert.equal(tab.el("mainView").hidden, false);
  assert.equal(tab.el("editorReposSection").hidden, false);
  const items = tab.el("editorReposList").children;
  assert.deepEqual(items.map((item) => item.children[0].dataset.repo), [REPO]);
  browser.statusSteps = [browser.ready()];
  await tab.el("editorReposList").dispatch("click", { target: items[0].children[0] });
  await browser.clock.until(() => tab.popups[1]?.currentHref === TUNNEL_URL, 200);
  assert.equal(tab.popups[1]?.currentHref, TUNNEL_URL, "abre el otro repositorio en su carpeta");
  assertKnownShadowIds(tab, editorTab, otherEditorTab);
});

test("0.7.20: el boton aparece para cualquiera con sesion (estudiante, docente o administrador), con el tunel y en la pagina de un repositorio; sigue la navegacion de GitHub", async () => {
  // Sin sesion: ni boton ni consulta del proveedor en cada pagina de GitHub.
  const anonymous = new FakeBrowser();
  const anonTab = await openTab(anonymous, `https://github.com/${REPO}`, REPO);
  await advance(anonymous, 1000);
  assert.equal(repoButton(anonTab), null);
  assert.deepEqual(anonymous.requestsTo("/api/workspaces/provider"), []);

  // Docente y administrador: tambien (cualquier repositorio publico, propio o de un estudiante).
  for (const role of ["teacher", "admin"]) {
    const other = new FakeBrowser();
    other.session = { ...SESSION, user: { ...SESSION.user, role, assignedCourseCodes: [] } };
    seedLoggedInBrowser(other);
    const otherTab = await openTab(other, `https://github.com/${REPO}`, REPO);
    await advance(other, 1000);
    assert.ok(repoButton(otherTab), `boton para ${role}`);
    assert.equal(repoButton(otherTab)!.label.textContent, "Abrir en mi editor");
  }

  // Codespaces: el boton es del editor en la nube.
  const codespaces = new FakeBrowser();
  codespaces.provider = "codespaces";
  seedLoggedInBrowser(codespaces);
  const codespacesTab = await openTab(codespaces, `https://github.com/${REPO}`, REPO);
  await advance(codespaces, 1000);
  assert.equal(repoButton(codespacesTab), null);

  // Estudiante con el tunel: no en ajustes ni en la portada; si en el repositorio. GitHub navega
  // sin recargar (Turbo): el boton sigue la URL.
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, "https://github.com/settings/profile", "Settings");
  await advance(browser, 1000);
  assert.equal(repoButton(tab), null, "github.com/settings no es un repositorio");
  const navigate = async (url: string) => {
    tab.window.location.href = url;
    await Promise.all((tab.document.listeners.get("turbo:load") || []).map((listener) => listener({ type: "turbo:load" })));
    await advance(browser, 600);
  };
  await navigate(`https://github.com/${REPO}/tree/main/src`);
  assert.ok(repoButton(tab), "pagina del repositorio (tambien dentro de una carpeta)");
  assert.match(repoButton(tab)!.button.title, new RegExp(`Prepara tu editor en la nube con ${REPO}`), "sin editores: la primera vez pide un codigo");
  await navigate("https://github.com/");
  assert.equal(repoButton(tab), null, "la portada no es un repositorio");
  await navigate(`https://github.com/${OTHER_REPO}`);
  assert.ok(repoButton(tab));
  assert.equal(tab.run("repoEditorButtonRepo"), OTHER_REPO);
  assert.ok(browser.requestsTo("/api/workspaces/provider").length <= 1, "el proveedor se consulta una vez (cache de 5 min)");
  assertKnownShadowIds(tab);
});

test("0.7.20: en la cabecera real de GitHub el boton va junto a Watch/Fork/Star (un <li> con un <span> que tiene la shadow root)", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = new TabEnv(browser, `https://github.com/${REPO}`, REPO);
  // La lista de acciones de la cabecera (Watch, Fork, Star), visible.
  const actions = new FakeElement("ul", tab);
  const watch = new FakeElement("li", tab);
  actions.appendChild(watch);
  (actions as unknown as { getClientRects: () => unknown[] }).getClientRects = () => [{ width: 300, height: 28 }];
  tab.document.body.appendChild(actions);
  tab.document.selectors.set("#repository-container-header ul.pagehead-actions", actions);
  tab.load();
  await browser.clock.settle();
  await browser.clock.until(() => !!repoButton(tab), 50);
  const host = tab.document.getElementById("adaceen-repo-editor-button");
  assert.equal(host?.tagName, "LI");
  assert.equal(host?.parentNode, actions, "dentro de la lista de acciones de la cabecera");
  assert.equal(host?.children[0]?.tagName, "SPAN", "la shadow root va en un <span>: un <li> no la admite");
  assert.equal(repoButton(tab)!.label.textContent, "Abrir en mi editor");

  // Ventana angosta: GitHub oculta la lista (d-none por debajo de md) y el boton pasa a flotar.
  (actions as unknown as { getClientRects: () => unknown[] }).getClientRects = () => [];
  await Promise.all((tab.windowListeners.get("resize") || []).map((listener) => listener({ type: "resize" })));
  await advance(browser, 600);
  const floating = tab.document.getElementById("adaceen-repo-editor-button");
  assert.equal(floating?.tagName, "DIV");
  assert.equal(floating?.parentNode, tab.document.documentElement);
  assert.equal(actions.children.length, 1, "sin restos en la cabecera");
  assertKnownShadowIds(tab);
});

test("0.7.20: solo repositorios publicos: en uno privado el boton dice «Solo repos publicos» y no abre nada", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = new TabEnv(browser, `https://github.com/${OTHER_REPO}`, OTHER_REPO);
  // Lo que GitHub publica en la pagina: <meta name="octolytics-dimension-repository_public">.
  const meta = (name: string, content: string) => {
    const element = new FakeElement("meta", tab);
    element.setAttribute("name", name);
    element.setAttribute("content", content);
    tab.document.selectors.set(`meta[name="${name}"]`, element);
    return element;
  };
  const nwo = meta("octolytics-dimension-repository_nwo", OTHER_REPO);
  const visibility = meta("octolytics-dimension-repository_public", "false");
  tab.load();
  await browser.clock.settle();
  await browser.clock.until(() => !!repoButton(tab), 50);
  const ui = repoButton(tab)!;
  assert.equal(ui.label.textContent, "Solo repos publicos");
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.button.dataset.state, "private");
  assert.match(ui.button.title, /solo repositorios publicos/);
  await ui.button.click();
  await advance(browser, 1000);
  assert.equal(tab.popups.length, 0, "no abre la ventana de espera");
  assert.deepEqual(browser.requestsTo("/api/workspaces/prepare"), []);
  assert.deepEqual(browser.requestsTo("/api/workspaces/status"), []);

  // La meta de otro repositorio (pagina anterior, Turbo) no cuenta; la etiqueta de la cabecera si.
  nwo.setAttribute("content", "otra/cosa");
  const header = new FakeElement("div", tab);
  const label = new FakeElement("span", tab);
  label.textContent = "Public";
  (header as unknown as { querySelectorAll: () => FakeElement[] }).querySelectorAll = () => [label];
  tab.document.selectors.set("#repository-container-header", header);
  tab.run("syncRepoEditorButtonSoon()");
  await advance(browser, 600);
  assert.equal(repoButton(tab)!.label.textContent, "Abrir en mi editor");
  assert.equal(repoButton(tab)!.button.disabled, false);
  label.textContent = "Internal";
  tab.run("syncRepoEditorButtonSoon()");
  await advance(browser, 600);
  assert.equal(repoButton(tab)!.label.textContent, "Solo repos publicos", "interno tampoco");
  // Publico por la meta: se abre normal.
  nwo.setAttribute("content", OTHER_REPO);
  visibility.setAttribute("content", "true");
  tab.run("syncRepoEditorButtonSoon()");
  await advance(browser, 600);
  assert.equal(repoButton(tab)!.label.textContent, "Abrir en mi editor");
  assertKnownShadowIds(tab);
});

test("0.7.20 (verificacion): sin boton fuera de un repositorio, un doble clic abre una sola ventana, solo URLs del tunel y un script huerfano suelta el boton", async () => {
  const browser = new FakeBrowser();
  browser.githubConnected = true;
  seedLoggedInBrowser(browser);
  // github.com/advisories/GHSA-...: dos tramos en la URL, pero GitHub no la publica como repositorio.
  const advisory = await openTab(browser, "https://github.com/advisories/GHSA-abcd-efgh-ijkl", "Advisory");
  await advance(browser, 1000);
  assert.equal(repoButton(advisory), null, "un aviso de seguridad no es un repositorio");

  // Doble clic mientras la cuenta de GitHub tarda en responder: ocupado desde el primer clic.
  const tab = await openTab(browser, `https://github.com/${OTHER_REPO}`, OTHER_REPO);
  await browser.clock.until(() => !!repoButton(tab), 50);
  browser.delays["/api/github/oauth/status"] = 1500;
  browser.prepareSteps = [otherRepoWorkspace("ready")];
  const ui = repoButton(tab)!;
  await ui.button.click();
  assert.equal(repoButton(tab)!.label.textContent, "Preparando tu editor...", "ocupado desde el clic");
  assert.equal(repoButton(tab)!.button.disabled, true);
  await ui.button.click();
  assert.equal(await tab.run(`openMyTunnelEditor({ repoFullName: "${OTHER_REPO}" })`), false, "el overlay tampoco abre otra");
  await browser.clock.until(() => tab.popups[0]?.currentHref === OTHER_TUNNEL_URL, 400);
  assert.equal(tab.popups.length, 1, "una sola ventana de espera");
  assert.equal(browser.requestsTo("/api/workspaces/prepare").length, 1, "un solo prepare");
  delete browser.delays["/api/github/oauth/status"];
  await advance(browser, 600);
  assert.equal(repoButton(tab)!.label.textContent, "Abrir en mi editor");

  // La ventana de espera solo navega a VS Code Tunnels, aunque el backend diga otra cosa.
  browser.prepareSteps = [{ ...otherRepoWorkspace("ready"), workspace: { ...(otherRepoWorkspace("ready").workspace as Json), webUrl: "https://evil.example/tunnel/x" } }];
  const storedBefore = JSON.stringify(browser.storage.adaceenEditorByUser);
  await drive(browser, tab.run(`prepareTunnelWorkspace({ repoFullName: "${OTHER_REPO}" })`), 2000);
  assert.ok(tab.popups.every((popup) => !String(popup.currentHref || "").startsWith("https://evil.example")), "no navega fuera del tunel");
  assert.equal(JSON.stringify(browser.storage.adaceenEditorByUser), storedBefore, "ni la guarda");

  // La extension se recargo con la pestana abierta: el script viejo suelta su boton y no pelea
  // con el de la copia nueva.
  await advance(browser, 600);
  assert.ok(repoButton(tab));
  tab.run("delete chrome.runtime.id");
  tab.run("syncRepoEditorButtonSoon()");
  await advance(browser, 600);
  assert.equal(repoButton(tab), null, "el huerfano quita su boton");
  const fresh = new FakeElement("div", tab);
  fresh.id = "adaceen-repo-editor-button";
  tab.document.documentElement.appendChild(fresh);
  await Promise.all((tab.document.listeners.get("turbo:load") || []).map((listener) => listener({ type: "turbo:load" })));
  await advance(browser, 600);
  assert.equal(tab.document.getElementById("adaceen-repo-editor-button"), fresh, "no toca el boton de la copia nueva");
});

test("0.7.20 (acceso al tunel): el aviso del codigo sigue a GitHub (inicio de sesion, codigo, autorizar, listo) y avisa si la cuenta no es la del editor", async () => {
  const browser = new FakeBrowser();
  browser.githubConnected = true;
  seedLoggedInBrowser(browser);
  const handoff = (extra: Json = {}) => ({
    userCode: "WDJB-MJHT",
    userId: SESSION.user.id,
    repoFullName: REPO,
    githubLogin: "alumno",
    expiresAt: browser.clock.now + 10 * 60_000,
    savedAt: browser.clock.now,
    aliveAt: browser.clock.now,
    ...extra,
  });
  const helperOf = (tab: TabEnv) => tab.document.getElementById("adaceen-device-code-helper");
  const textOf = (tab: TabEnv, id: string) => String(helperOf(tab)?.shadow?.getElementById(id)?.textContent || "");
  const accountOf = (tab: TabEnv) => helperOf(tab)?.shadow?.getElementById("adaceenDeviceCodeAccount");
  // GitHub publica la cuenta abierta en <meta name="user-login">.
  const openGithub = async (url: string, signedIn: string) => {
    const tab = new TabEnv(browser, url, "GitHub");
    const meta = new FakeElement("meta", tab);
    meta.setAttribute("content", signedIn);
    tab.document.selectors.set('meta[name="user-login"]', meta);
    tab.load();
    await browser.clock.settle();
    await browser.clock.until(() => !!helperOf(tab), 50);
    return tab;
  };

  // Sin sesion en GitHub, /login/device lleva antes al inicio de sesion: el aviso ya esta ahi,
  // dice con que cuenta entrar y deja el codigo copiado para despues.
  browser.storage.adaceenDeviceCodeHandoff = handoff();
  const signin = await openGithub("https://github.com/login?return_to=%2Flogin%2Fdevice", "");
  assert.equal(textOf(signin, "adaceenDeviceCode"), "WDJB-MJHT");
  assert.match(textOf(signin, "adaceenDeviceCodeStatus"), /Inicia sesion con «alumno» y, cuando GitHub lo pida, pegalo y autoriza/);
  assert.equal(accountOf(signin)?.hidden, true, "sin sesion en GitHub no hay cuenta que comparar");
  assert.deepEqual(browser.clipboard, ["WDJB-MJHT"]);

  // Con otra cuenta abierta: aviso claro antes de autorizar (si no, vscode.dev no encuentra el tunel).
  const wrong = await openGithub("https://github.com/login/device", "Otra-Cuenta");
  assert.equal(accountOf(wrong)?.hidden, false);
  assert.equal(accountOf(wrong)?.className, "account is-wrong");
  assert.match(textOf(wrong, "adaceenDeviceCodeAccount"), /Estas en GitHub como «otra-cuenta», pero tu editor es de «alumno»\. Cambia de cuenta/);
  // Con la correcta, la confirmacion.
  const right = await openGithub("https://github.com/login/device", "Alumno");
  assert.equal(accountOf(right)?.className, "account is-ok");
  assert.match(textOf(right, "adaceenDeviceCodeAccount"), /Cuenta correcta: estas en GitHub como «alumno»/);
  assert.match(textOf(right, "adaceenDeviceCodeStatus"), /^Codigo copiado: pegalo en el primer cuadro y autoriza/);

  // Despues del codigo (autorizar) y al terminar, el texto acompana el paso.
  const authorize = await openGithub("https://github.com/login/device/confirmation", "alumno");
  assert.match(textOf(authorize, "adaceenDeviceCodeStatus"), /^Ultimo paso: autoriza a «Visual Studio Code» en GitHub/);
  const done = await openGithub("https://github.com/login/device/success", "alumno");
  assert.match(textOf(done, "adaceenDeviceCodeStatus"), /^GitHub confirmo el codigo\. En unos segundos esta pestana abre tu editor\./);
  assert.equal(accountOf(done)?.hidden, true, "ya autorizado, la cuenta no se discute");
  const failed = await openGithub("https://github.com/login/device/failure", "alumno");
  assert.match(textOf(failed, "adaceenDeviceCodeStatus"), /^GitHub no autorizo el codigo\. Vuelve a la pestana de ADACEEN y pulsa "Preparar mi editor"/);

  // Otras paginas de GitHub (el OAuth de ADACEEN, ajustes) no muestran el codigo.
  for (const url of ["https://github.com/login/oauth/authorize?client_id=x", "https://github.com/settings/profile"]) {
    const other = await openTab(browser, url, "GitHub");
    await advance(browser, 1_000);
    assert.equal(helperOf(other), null, url);
  }
  assertKnownShadowIds(signin, wrong, right, authorize, done, failed);
});

test("0.7.20 (acceso al tunel): la primera vez en vscode.dev, una sola vez, el editor dice con que cuenta de GitHub entrar", async () => {
  const browser = new FakeBrowser();
  browser.githubConnected = true;
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 50);
  await drive(browser, tab.run("refreshWorkspaceProvider(true)"));
  // Codigo de dispositivo y luego listo: el editor abre por primera vez en este navegador.
  browser.prepareSteps = [browser.deviceCode()];
  browser.statusSteps = [browser.deviceCode(), browser.ready()];
  await drive(browser, tab.run("prepareTunnelWorkspace()"), 2000);
  await browser.clock.until(() => tab.popups[0]?.currentHref === TUNNEL_URL, 400);
  const hint = browser.storage.adaceenTunnelSignInHint as Json;
  assert.equal(hint?.tunnelName, "ws-alumno");
  assert.equal(hint?.githubLogin, "alumno", "la cuenta del tunel (workspace.login)");
  assert.ok(((browser.storage.adaceenEditorByUser as Json)?.[EDITOR_KEY] as Json)?.openedAt, "el navegador ya abrio ese tunel");

  // La pestana del editor (vscode.dev) lo muestra y lo gasta.
  const hintOf = (t: TabEnv) => t.document.getElementById("adaceen-tunnel-signin-hint");
  const editor = await openTab(browser, TUNNEL_URL, "taller-1 - Visual Studio Code");
  await browser.clock.until(() => !!hintOf(editor), 50);
  assert.match(String(hintOf(editor)?.shadow?.getElementById("adaceenTunnelSignInText")?.textContent), /elige «GitHub» y usa la cuenta «alumno» \(la misma que autorizo el codigo\)/);
  assert.equal(browser.storage.adaceenTunnelSignInHint, undefined, "una sola vez");
  const again = await openTab(browser, TUNNEL_URL, "taller-1 - Visual Studio Code");
  await advance(browser, 1_000);
  assert.equal(hintOf(again), null);

  // Volver a abrirlo desde este navegador (sin codigo) no lo repite: vscode.dev ya conoce la cuenta.
  browser.statusSteps = [browser.ready()];
  await drive(browser, tab.run(`openMyTunnelEditor({ repoFullName: "${REPO}" })`), 2000);
  assert.equal(browser.storage.adaceenTunnelSignInHint, undefined);

  // Otro usuario de ADACEEN en el mismo equipo no ve el aviso de otro.
  browser.storage.adaceenTunnelSignInHint = { userId: "u-otro", tunnelName: "ws-alumno", githubLogin: "otro", expiresAt: browser.clock.now + 60_000 };
  const foreign = await openTab(browser, TUNNEL_URL, "taller-1 - Visual Studio Code");
  await advance(browser, 1_000);
  assert.equal(hintOf(foreign), null);
  assertKnownShadowIds(tab, editor, again, foreign);
});

test("0.7.20 (acceso al tunel): con la VM apagada, el docente lee que la encienda el (no «avisa al docente»); el estudiante, a quien avisar", async () => {
  const titleOf = (popup: FakePopup) => popup.document.getElementById("adaceenWaitTitle").textContent;
  const detailOf = (popup: FakePopup) => popup.document.getElementById("adaceenWaitDetail").textContent;
  const staffVmOff = (browser: FakeBrowser) => ({
    ...browser.vmOff(),
    message: "La VM de editores esta apagada: enciendela con bash deploy/clase.sh iniciar en Cloud Shell. Esta ventana seguira esperando.",
  });

  const browser = new FakeBrowser();
  browser.session = { ...SESSION, user: { ...SESSION.user, role: "teacher", assignedCourseCodes: [] } };
  browser.githubConnected = true;
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await browser.clock.until(() => !!repoButton(tab), 50);
  browser.prepareSteps = [staffVmOff(browser)];
  browser.statusSteps = [staffVmOff(browser)];
  await repoButton(tab)!.button.click();
  const popup = tab.popups[0];
  await browser.clock.until(() => titleOf(popup) === "La VM de editores esta apagada", 400);
  assert.match(String(detailOf(popup)), /clase\.sh iniciar/);
  // Mientras espera, la ventana consulta el material del curso y lo pinta (antes, sin consultar,
  // salia «0 base, 0 del profesor»). Los cursos ya estaban: no se vuelven a pedir.
  const panelsOf = (target: FakePopup) => String(target.document.getElementById("adaceenWaitPanels").innerHTML);
  await browser.clock.until(() => /Fuentes disponibles: 1 base, 1 del profesor\./.test(panelsOf(popup)), 200);
  assert.match(panelsOf(popup), /Subido por profesor: Taller 2\./);
  assert.equal(browser.requestsTo("/api/rag/sources").length, 1);
  // Se agota la espera (12 min): el boton vuelve y el texto no manda a avisar a nadie.
  await browser.clock.until(() => titleOf(popup) === "El editor no confirmo a tiempo", 4000);
  assert.equal(detailOf(popup), 'La VM de editores sigue apagada. Enciendela con bash deploy/clase.sh iniciar y pulsa "Abrir en mi editor" de nuevo.', "el boton que pulso (el de la pagina), no el del overlay");
  assert.doesNotMatch(String(detailOf(popup)), /docente/);

  // El estudiante sigue leyendo a quien avisar.
  const student = new FakeBrowser();
  student.githubConnected = true;
  seedLoggedInBrowser(student);
  const studentTab = await openTab(student, `https://github.com/${REPO}`, REPO);
  await student.clock.until(() => !!repoButton(studentTab), 50);
  student.prepareSteps = [student.vmOff()];
  student.statusSteps = [student.vmOff()];
  await repoButton(studentTab)!.button.click();
  const studentPopup = studentTab.popups[0];
  await student.clock.until(() => titleOf(studentPopup) === "El editor esta apagado; avisa al docente", 400);
  await student.clock.until(() => titleOf(studentPopup) === "El editor no confirmo a tiempo", 4000);
  assert.equal(detailOf(studentPopup), 'La VM de editores sigue apagada. Pulsa "Abrir en mi editor" de nuevo cuando el docente la encienda.');
});

// ---- «Iniciar clase» desde la tuerca del administrador o el docente (navegador 0.7.21) ----

const CLASS_EDITORS_OFF = { name: "adaceen-ws", zone: "us-central1-a", kind: "editors", vmStatus: "TERMINATED", state: "off", startRequestedAt: null, problem: "" };
const CLASS_GPU_OFF = { name: "adaceen-worker-v100", zone: "us-central1-b", kind: "gpu", vmStatus: "TERMINATED", state: "off", startRequestedAt: null, problem: "" };
const CLASS_OFF: Json = {
  configured: true,
  provider: "tunnel",
  editorsNeeded: true,
  editors: CLASS_EDITORS_OFF,
  gpus: [CLASS_GPU_OFF],
  gpu: "off",
  workspaceAgentOnline: false,
  modelWorkersAlive: 0,
  ready: false,
  requestedBy: null,
  requestedAt: null,
  checkedAt: "2026-09-25T13:00:00.000Z",
};
const WORKSPACE_TUNNEL_SETTING: Json = {
  provider: "tunnel",
  source: "extension",
  serverProvider: "codespaces",
  choice: "tunnel",
  updatedAt: "2026-09-25T12:00:00.000Z",
  updatedBy: "Admin Prueba",
  agentConfigured: true,
  agentOnline: false,
  transport: "relay",
  vmAutostart: false,
};

test("0.7.21: «Iniciar clase» en la tuerca enciende la GPU y el editor en la nube y sondea cada 10 s hasta que todo esta listo", async () => {
  const browser = new FakeBrowser();
  browser.session = ADMIN_SESSION;
  browser.provider = "tunnel";
  browser.workspaceSetting = { ...WORKSPACE_TUNNEL_SETTING };
  browser.classStatus = structuredClone(CLASS_OFF);
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-admin": true } });
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => tab.state().loading === false, 400);
  assert.deepEqual(browser.requestsTo("/api/admin/clase/estado"), [], "no se consulta hasta abrir la tuerca");

  // La tuerca muestra la seccion «Clase» con lo que dice el backend.
  await drive(browser, tab.el("settingsBtn").click(), 400);
  await browser.clock.until(() => !!tab.state().classStatus, 400);
  assert.equal(tab.el("settingsSectionClass").hidden, false);
  assert.equal(tab.el("classEditorValue").textContent, "Apagada");
  assert.equal(tab.el("classModelValue").textContent, "Sin servidores; GPU apagada");
  assert.equal(tab.el("settingsSectionClassHint").textContent, "No está lista");
  assert.equal(tab.el("classStartBtn").disabled, false);
  assert.match(tab.el("classStartNote").textContent, /^«Iniciar clase» enciende la GPU y, con el editor en la nube, la VM de editores/);
  assert.equal(browser.requestsTo("/api/admin/clase/estado").length, 1, "una consulta por apertura de la tuerca");

  // Pulsar: POST enseguida (sin «Guardar cambios»); la seccion y la linea de estado dicen que se enciende.
  await drive(browser, tab.el("classStartBtn").click(), 400);
  assert.equal(browser.classStarts, 1);
  assert.equal(tab.el("classEditorValue").textContent, "Encendiendo…");
  assert.equal(tab.el("classModelValue").textContent, "GPU encendiendo…");
  assert.match(tab.el("classStartNote").textContent, /^Encendiendo la VM de editores \(el agente se conecta en 1-2 min\)\. Encendiendo la GPU adaceen-worker-v100 .* Esperando a que todo quede listo…$/);
  assert.equal(tab.el("settingsSectionClassHint").textContent, "Encendiendo…");
  assert.match(tab.el("statusText").textContent, /^Encendiendo la VM de editores/);

  // Sondeo cada 10 s (reloj virtual): en 25 s, dos consultas mas.
  const polled = browser.requestsTo("/api/admin/clase/estado").length;
  await advance(browser, 25_000);
  assert.equal(browser.requestsTo("/api/admin/clase/estado").length, polled + 2);
  assert.equal(browser.classStarts, 1, "el sondeo consulta, no vuelve a encender");

  // El agente se conecto y la GPU manda latido: listo, y el sondeo para.
  browser.classStatus = {
    ...browser.classStatus,
    editors: { ...CLASS_EDITORS_OFF, vmStatus: "RUNNING", state: "running" },
    gpus: [{ ...CLASS_GPU_OFF, vmStatus: "RUNNING", state: "running" }],
    gpu: "running",
    workspaceAgentOnline: true,
    modelWorkersAlive: 1,
    ready: true,
  };
  await advance(browser, 10_000);
  await browser.clock.until(() => tab.state().classStatus?.ready === true, 50);
  assert.equal(tab.el("classEditorValue").textContent, "Conectada");
  assert.equal(tab.el("classModelValue").textContent, "1 servidor(es) vivo(s)");
  assert.equal(tab.el("classStartNote").textContent, "Clase lista: editor y modelo atendiendo.");
  assert.equal(tab.el("classStartNote").classList.contains("is-ready"), true);
  assert.equal(tab.el("classStartNote").classList.contains("is-warning"), false);
  assert.equal(tab.el("settingsSectionClassHint").textContent, "Lista");
  assert.equal(tab.el("statusText").textContent, "Clase lista: editor y modelo atendiendo.");
  assert.equal(tab.state().classStartPollUntil, 0);
  const done = browser.requestsTo("/api/admin/clase/estado").length;
  await advance(browser, 60_000);
  assert.equal(browser.requestsTo("/api/admin/clase/estado").length, done, "listo: no se sigue consultando");
  assertKnownShadowIds(tab);
});

test("0.7.21: un backend anterior lo dice y no deja pulsar; una GPU sin cupo se explica; tope de 15 min; el estudiante no ve la seccion", async () => {
  // Backend anterior a 0.7.21 (404): la seccion lo dice y el boton queda deshabilitado.
  const old = new FakeBrowser();
  old.session = ADMIN_SESSION;
  old.provider = "codespaces";
  seedLoggedInBrowser(old, { adaceenPrivacyAcceptedByUser: { "u-admin": true } });
  const oldTab = await openTab(old, `https://github.com/${REPO}`, REPO);
  await drive(old, oldTab.run("openOverlay({ trigger: 'user' })"));
  await old.clock.until(() => oldTab.state().loading === false, 400);
  await drive(old, oldTab.el("settingsBtn").click(), 400);
  await old.clock.until(() => !!oldTab.state().classStatusError, 400);
  assert.equal(oldTab.el("classStartNote").textContent, "Este backend todavía no permite iniciar la clase desde aquí: llega con la versión 0.7.21.");
  assert.equal(oldTab.el("classStartNote").classList.contains("is-warning"), true);
  assert.equal(oldTab.el("classStartBtn").disabled, true);
  assert.equal(oldTab.el("classEditorValue").textContent, "Sin datos");
  assert.deepEqual(old.requestsTo("/api/admin/clase/estado").map((request) => request.method), ["GET"]);

  // Docente con Codespaces: el editor no hace falta; la GPU que no encendio se explica; «Actualizar estado» vuelve a consultar.
  const teacher = new FakeBrowser();
  teacher.session = { ...SESSION, user: { ...SESSION.user, id: "u-docente", role: "teacher", displayName: "Docente Prueba", assignedCourseCodes: [] } };
  teacher.provider = "codespaces";
  teacher.workspaceSetting = { ...WORKSPACE_TUNNEL_SETTING, provider: "codespaces", choice: "codespaces" };
  teacher.classStatus = {
    ...CLASS_OFF,
    provider: "codespaces",
    editorsNeeded: false,
    gpus: [{ ...CLASS_GPU_OFF, state: "failed", problem: "instances.start HTTP 403 (ZONE_RESOURCE_POOL_EXHAUSTED)" }],
    gpu: "failed",
  };
  seedLoggedInBrowser(teacher, { adaceenPrivacyAcceptedByUser: { "u-docente": true } });
  const teacherTab = await openTab(teacher, `https://github.com/${REPO}`, REPO);
  await drive(teacher, teacherTab.run("openOverlay({ trigger: 'user' })"));
  await teacher.clock.until(() => teacherTab.state().loading === false, 400);
  await drive(teacher, teacherTab.el("settingsBtn").click(), 400);
  await teacher.clock.until(() => !!teacherTab.state().classStatus, 400);
  assert.equal(teacherTab.el("settingsSectionClass").hidden, false);
  assert.equal(teacherTab.el("classEditorValue").textContent, "No hace falta (Codespaces)");
  assert.equal(teacherTab.el("classModelValue").textContent, "GPU no encendió");
  assert.equal(teacherTab.el("classStartNote").textContent, "GPU que no encendió: adaceen-worker-v100 (instances.start HTTP 403 (ZONE_RESOURCE_POOL_EXHAUSTED)).");
  assert.equal(teacherTab.el("classStartNote").classList.contains("is-warning"), true);
  const consulted = teacher.requestsTo("/api/admin/clase/estado").length;
  await drive(teacher, teacherTab.el("classRefreshBtn").click(), 400);
  assert.equal(teacher.requestsTo("/api/admin/clase/estado").length, consulted + 1);

  // Tope de 15 min: si nada queda listo, el sondeo se detiene con el aviso.
  teacher.classStatus = { ...CLASS_OFF, provider: "codespaces", editorsNeeded: false };
  await drive(teacher, teacherTab.el("classStartBtn").click(), 400);
  assert.equal(teacher.classStarts, 1);
  await advance(teacher, 16 * 60_000);
  assert.match(teacherTab.el("classStartNote").textContent, /^Pasaron 15 min y la clase no quedó lista: ningún servidor del modelo manda latido\./);
  assert.equal(teacherTab.el("classStartNote").classList.contains("is-warning"), true);
  assert.equal(teacherTab.state().classStartPollUntil, 0);
  assert.equal(teacher.classStarts, 1, "el sondeo nunca vuelve a encender");
  const stopped = teacher.requestsTo("/api/admin/clase/estado").length;
  await advance(teacher, 60_000);
  assert.equal(teacher.requestsTo("/api/admin/clase/estado").length, stopped);

  // Estudiante: ni la seccion ni la consulta.
  const student = new FakeBrowser();
  student.classStatus = structuredClone(CLASS_OFF);
  seedLoggedInBrowser(student);
  const studentTab = await openTab(student, TUNNEL_URL, "taller-1");
  await drive(student, studentTab.run("openOverlay({ trigger: 'user' })"));
  await student.clock.until(() => studentTab.state().loading === false, 400);
  await drive(student, studentTab.el("settingsBtn").click(), 400);
  assert.equal(studentTab.el("settingsSectionClass").hidden, true);
  assert.deepEqual(student.requestsTo("/api/admin/clase/estado"), []);
  assertKnownShadowIds(oldTab, teacherTab, studentTab);
});

// ---- La ventana de espera sin material del curso (0.7.21) ----

test("0.7.21: la ventana de espera dice claramente cuando el curso no tiene material RAG (ni base ni del profesor)", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, `${REPO}: taller`);
  // Lineas RAG de la ventana de espera con el rol y la respuesta de /api/rag/sources dados.
  const ragLines = (role: string, sources: Json[], ragError = "", ragFetchedAt = "2026-10-09T12:00:00.000Z"): string[] => JSON.parse(tab.run(`(() => {
    overlayState.session = { ...(overlayState.session || {}), user: { ...(overlayState.session?.user || {}), role: ${JSON.stringify(role)} } };
    overlayState.teacherRagState = null;
    overlayState.ragSources = [];
    overlayState.codespaceWaitingContext = {
      ragCourseCode: "FPOO",
      ragCourseName: "Fundamentos de programacion orientada a objetos",
      ragSources: ${JSON.stringify(sources)},
      courses: [],
      ragFetchedAt: ${JSON.stringify(ragFetchedAt)},
      ragError: ${JSON.stringify(ragError)},
    };
    return JSON.stringify(getWaitingPageRagLines());
  })()`));
  const base = (title: string) => ({ scope: "default", title, courseCode: "FPOO" });
  const propia = (title: string) => ({ scope: "teacher", title, courseCode: "FPOO" });
  const SIN_MATERIAL = "Este curso aun no tiene material en ADACEEN: el tutor responde sin fuentes del curso";

  // Ni base ni del profesor: ya no promete «el material base disponible».
  const estudiante = ragLines("student", []);
  assert.ok(estudiante.includes("Fuentes disponibles: 0 base, 0 del profesor."));
  assert.ok(estudiante.includes(`${SIN_MATERIAL} hasta que tu docente las cargue.`), estudiante.join("\n"));
  assert.ok(!estudiante.some((line) => /material base/.test(line)));
  // El docente sabe donde cargarlas; el administrador no tiene la pestana «RAG».
  assert.ok(ragLines("teacher", []).includes(`${SIN_MATERIAL}. Cargalas en la pestana «RAG».`));
  assert.ok(ragLines("admin", []).includes(`${SIN_MATERIAL} hasta que el docente las cargue en su pestana «RAG».`));

  // Con material base y sin fuentes propias: cuantas usara.
  assert.ok(ragLines("student", [base("Guia FPOO")]).includes("Aun no hay fuentes del profesor para este curso; ADACEEN usara la fuente base."));
  assert.ok(ragLines("student", [base("Guia FPOO"), base("Talleres")]).includes("Aun no hay fuentes del profesor para este curso; ADACEEN usara las 2 fuentes base."));
  // Con fuentes del profesor, como antes.
  assert.ok(ragLines("student", [base("Guia FPOO"), propia("Taller 3")]).includes("Subido por profesor: Taller 3."));

  // Si la consulta fallo, 0 no quiere decir «sin material»: solo se dice que falta refrescar.
  const conError = ragLines("student", [], "tiempo agotado");
  assert.ok(conError.includes("RAG pendiente de refrescar: tiempo agotado"));
  assert.ok(!conError.some((line) => line.startsWith(SIN_MATERIAL)));
  // Ventana recien abierta (aun sin consultar): ni cifras ni «sin material».
  const sinConsultar = ragLines("teacher", [], "", "");
  assert.ok(sinConsultar.includes("Consultando el material del curso..."), sinConsultar.join("\n"));
  assert.ok(!sinConsultar.some((line) => line.startsWith("Fuentes disponibles") || line.startsWith(SIN_MATERIAL)));
});

// ---- Cargar varias fuentes RAG de una vez (piloto con FPOO-01, 0.7.21) ----

test("0.7.21: el docente carga varias fuentes RAG en una sola seleccion; un resumen dice cuantas entraron y cuales no", async () => {
  const browser = new FakeBrowser();
  browser.session = { ...SESSION, user: { ...SESSION.user, id: "u-docente", role: "teacher", displayName: "Docente Prueba", assignedCourseCodes: [] } };
  browser.ragUploadFailures = ["Guia escaneada.pdf"];
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-docente": true } });
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => tab.state().loading === false, 400);
  await drive(browser, tab.el("tabBtnRag").click());
  await browser.clock.until(() => tab.state().teacherRagLoadedAt > 0, 400);
  const fpoo = Array.from(tab.el("ragCourseGroups").children).find((group: any) => group.dataset.courseCode === "FPOO") as any;
  const fpooBody = fpoo.children[1];
  const uploadBtn = fpooBody.children[0].children[2];
  assert.equal(uploadBtn.textContent, "Cargar fuente");
  await drive(browser, uploadBtn.click());
  assert.equal(tab.state().teacherRagState.selectedCourseCode, "FPOO");
  // El selector admite varios archivos (el DOM falso no lee el markup: se mira la plantilla).
  assert.match(SOURCES.get("overlay/templates/tab-panels.template.js")!, /<input id="teacherRagFileInput" type="file" multiple /);

  const getsBefore = browser.requestsTo("/api/rag/sources", "GET").length;
  const input = tab.el("teacherRagFileInput");
  input.files = [
    new File(["guia 1"], "Pilares de POO y Reglas SOLID.pdf"),
    new File(["escaneo"], "Guia escaneada.pdf"),
    new File(["proyecto"], "Enunciado del Proyecto.pdf"),
  ];
  await drive(browser, input.dispatch("change"), 3000);
  await browser.clock.until(() => !tab.state().teacherRagState.busy, 400);

  // Una peticion por archivo, en orden, todas al curso elegido; la lista se refresca una sola vez.
  assert.deepEqual(browser.ragUploads.map((upload) => upload.fileName), ["Pilares de POO y Reglas SOLID.pdf", "Guia escaneada.pdf", "Enunciado del Proyecto.pdf"]);
  assert.deepEqual([...new Set(browser.ragUploads.map((upload) => upload.courseCode))], ["FPOO"]);
  assert.equal(browser.requestsTo("/api/rag/sources", "POST").length, 3);
  assert.equal(browser.requestsTo("/api/rag/sources", "GET").length - getsBefore, 1, "un solo refresco al final, no uno por archivo");
  const state = tab.state().teacherRagState;
  assert.equal(state.message, "Cargadas 2 de 3 fuentes en FPOO.");
  assert.equal(state.error, "No se cargaron: Guia escaneada.pdf (El archivo no tiene texto legible.)");
  assert.equal(input.value, "", "el selector queda limpio para la siguiente carga");
});

// ---- Piloto con FPOO-01 (0.7.21): importar la lista de Campus y el tema del piloto ----

// La lista de «Participantes» de Campus como la exporta el curso (BOM, comillas y CRLF): dos
// profesores (el administrador y Victor, que aun no tiene cuenta), tres estudiantes (uno ya
// tiene cuenta y otro usa Gmail) y uno suspendido.
const CAMPUS_ROSTER_CSV = "﻿Nombre,Correo electrónico,Roles,Número de ID,Estatus\r\n"
  + "\"BUCHELI GUERRERO VICTOR ANDRES\",victor.bucheli@correounivalle.edu.co,Profesor Turnitin,,Activo\r\n"
  + "\"SUAREZ ADMIN PRUEBA\",admin@correounivalle.edu.co,Profesor,,Activo\r\n"
  + "\"PEREZ GONZALEZ ANA MARIA\",ana.maria.perez.gonzalez@correounivalle.edu.co,Estudiante,2026001,Activo\r\n"
  + "\"DIAZ DE LA CRUZ BRUNO\",bruno.diaz@correounivalle.edu.co,Estudiante,2026002,Activo\r\n"
  + "\"LOPEZ CARLA\",carla.lopez@gmail.com,Estudiante,2026003,Activo\r\n"
  + "\"MUÑOZ JUAN\",juan.munoz@correounivalle.edu.co,Estudiante,2026004,Suspendido\r\n";

test("0.7.21: el administrador importa la lista de Campus: solo los de la universidad por defecto, crea al docente de la lista y fija el de las cuentas nuevas", async () => {
  const browser = new FakeBrowser();
  browser.session = ADMIN_SESSION;
  browser.defaultTeacher = { teacherUserId: "u-docente", chosenTeacherUserId: null, source: "oldest", chosenInactive: false, updatedAt: null, updatedByName: null };
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-admin": true } });
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => tab.state().loading === false, 400);
  await drive(browser, tab.el("tabBtnUsuarios").click());
  await browser.clock.until(() => tab.el("adminUsersTableBody").children.length >= 2 && !tab.state().adminUsersBusy, 400);

  // Docente de las cuentas nuevas: automatico (el mas antiguo) hasta que se elija.
  assert.equal(tab.el("adminDefaultTeacherRow").hidden, false);
  assert.equal(tab.el("adminDefaultTeacherSelect").value, "");
  assert.deepEqual(tab.el("adminDefaultTeacherSelect").children.map((option) => option.textContent), [
    "El profesor activo más antiguo (automático)",
    "Docente Prueba (docente@correounivalle.edu.co)",
  ]);
  assert.match(tab.el("adminDefaultTeacherNote").textContent, /primera vez con Google.*Ahora: Docente Prueba\./);

  // Importar lista: el CSV de Campus se lee en el navegador.
  assert.equal(tab.el("adminImportPanel").hidden, true);
  await drive(browser, tab.el("adminToggleImportBtn").click());
  assert.equal(tab.el("adminImportPanel").hidden, false);
  assert.equal(tab.el("adminToggleImportBtn").textContent, "Ocultar importación");
  assert.equal(tab.el("adminImportBtn").disabled, true, "sin lista no hay nada que importar");
  const input = tab.el("adminImportFileInput");
  input.files = [new File([CAMPUS_ROSTER_CSV], "participantes FPOO-01.csv")];
  await drive(browser, input.dispatch("change"), 800);
  await browser.clock.until(() => !!tab.state().adminImport?.roster, 400);
  // JSON: los objetos vienen del contexto de la pestaña (otro realm).
  const roster = JSON.parse(JSON.stringify(tab.state().adminImport.roster));
  assert.deepEqual(roster.students.map((student: Json) => [student.email, student.displayName, student.institutional]), [
    ["ana.maria.perez.gonzalez@correounivalle.edu.co", "Perez Gonzalez Ana Maria", true],
    ["bruno.diaz@correounivalle.edu.co", "Diaz de la Cruz Bruno", true],
    ["carla.lopez@gmail.com", "Lopez Carla", false],
  ], "nombres en tipo título; el suspendido queda fuera");
  assert.equal(roster.inactive, 1);
  assert.equal(tab.el("adminImportFileName").textContent, "participantes FPOO-01.csv");
  assert.match(tab.el("adminImportSummary").textContent, /3 estudiantes y 2 docentes\. 2 con correo @correounivalle\.edu\.co y 1 con otro correo \(Gmail u otro\)\. Los de otro correo no se importan/);
  assert.equal(tab.el("adminImportBtn").textContent, "Importar 2 estudiantes");
  assert.equal(tab.el("adminImportIncludeOtherRow").hidden, false);
  assert.equal(tab.el("adminImportIncludeOtherLabel").textContent, "Incluir también el de otro correo");

  // Los docentes de la lista: el administrador es quien importa; Victor no tiene cuenta.
  const teacherItems = tab.el("adminImportTeachers").children;
  assert.equal(teacherItems.length, 2);
  assert.equal(teacherItems[1].children[0].textContent, "Suarez Admin Prueba (Profesor en Campus): eres tú (administrador).");
  assert.equal(teacherItems[0].children[0].textContent, "Bucheli Guerrero Victor Andres (Profesor Turnitin en Campus): sin cuenta en ADACEEN.");
  assert.equal(teacherItems[0].children[1].textContent, "Crear su cuenta de docente");
  assert.equal(tab.state().adminImport.teacherUserId, "u-docente", "mientras tanto, el unico docente activo");
  await drive(browser, teacherItems[0].children[1].click(), 800);
  await browser.clock.until(() => !tab.state().adminImport.busy, 400);
  assert.equal(browser.createdUsers.length, 1);
  assert.equal(browser.createdUsers[0].role, "teacher");
  assert.equal(browser.createdUsers[0].email, "victor.bucheli@correounivalle.edu.co");
  assert.equal(browser.createdUsers[0].displayName, "Bucheli Guerrero Victor Andres");
  assert.ok(String(browser.createdUsers[0].password).length >= 24, "clave al azar: entra con Google");
  assert.equal(tab.state().adminImport.teacherUserId, "u-nuevo-1", "queda elegido para la importación");
  assert.equal(tab.el("adminImportTeacher").value, "u-nuevo-1");
  assert.match(tab.el("adminImportSummary").textContent, /Bucheli Guerrero Victor Andres ya es docente en ADACEEN y queda elegido/);
  assert.equal(tab.el("adminImportTeachers").children[0].children[0].textContent, "Bucheli Guerrero Victor Andres (Profesor Turnitin en Campus): docente en ADACEEN.");
  assert.equal(tab.el("adminImportSetDefaultRow").hidden, false);
  assert.equal(tab.el("adminImportSetDefault").checked, true);
  assert.equal(tab.el("adminImportSetDefaultLabel").textContent, "Quien entre por primera vez con Google también queda con Bucheli Guerrero Victor Andres (curso FPOO)");

  // Importar: solo los dos de la universidad, al docente y curso elegidos; Victor queda como
  // docente de las cuentas nuevas.
  await drive(browser, tab.el("adminImportBtn").click(), 1200);
  await browser.clock.until(() => !tab.state().adminImport.busy, 400);
  assert.equal(browser.importRequests.length, 1);
  assert.deepEqual(browser.importRequests[0], {
    teacherUserId: "u-nuevo-1",
    courseCode: "FPOO",
    students: [
      { email: "ana.maria.perez.gonzalez@correounivalle.edu.co", displayName: "Perez Gonzalez Ana Maria" },
      { email: "bruno.diaz@correounivalle.edu.co", displayName: "Diaz de la Cruz Bruno" },
    ],
  });
  assert.deepEqual(browser.defaultTeacherPuts, [{ teacherUserId: "u-nuevo-1" }]);
  assert.deepEqual(tab.el("adminImportResult").children.map((item) => item.textContent), [
    "1 cuenta nueva con Bucheli Guerrero Victor Andres en FPOO: entran con Google.",
    "1 estudiante ya tenía cuenta y pasó a Bucheli Guerrero Victor Andres en FPOO: Ana María Pérez González.",
  ]);
  assert.equal(tab.el("adminUsersStatus").textContent, "Lista importada: 1 nuevas y 1 actualizadas. Quien entre por primera vez con Google queda con Bucheli Guerrero Victor Andres.");
  assert.equal(tab.el("adminDefaultTeacherSelect").value, "u-nuevo-1");
  assert.match(tab.el("adminDefaultTeacherNote").textContent, /^Quien entra por primera vez con Google, o se crea sin docente, queda con este docente y el curso FPOO\.$/);
  assert.equal(tab.el("adminImportSetDefaultRow").hidden, true, "ya es el docente de las cuentas nuevas");

  // Repetir con los de otro correo: Carla se crea; Ana y Bruno ya estaban.
  tab.el("adminImportIncludeOther").checked = true;
  await drive(browser, tab.el("adminImportIncludeOther").dispatch("change"));
  assert.equal(tab.el("adminImportBtn").textContent, "Importar 3 estudiantes");
  await drive(browser, tab.el("adminImportBtn").click(), 1200);
  await browser.clock.until(() => !tab.state().adminImport.busy, 400);
  assert.equal(browser.importRequests.length, 2);
  assert.equal((browser.importRequests[1].students as Json[]).length, 3);
  assert.deepEqual(browser.defaultTeacherPuts.length, 1, "no se vuelve a guardar el mismo docente");
  assert.deepEqual(tab.el("adminImportResult").children.map((item) => item.textContent), [
    "1 cuenta nueva con Bucheli Guerrero Victor Andres en FPOO: entran con Google.",
    "2 ya estaban así.",
  ]);

  // Cambiar el docente de las cuentas nuevas desde su selector (vuelve al automatico).
  tab.el("adminDefaultTeacherSelect").value = "";
  await drive(browser, tab.el("adminDefaultTeacherSelect").dispatch("change"), 800);
  await browser.clock.until(() => !tab.state().adminUsersBusy, 400);
  assert.deepEqual(browser.defaultTeacherPuts.at(-1), { teacherUserId: null });
  assert.equal(tab.el("adminUsersStatus").textContent, "Las cuentas nuevas quedan con el profesor activo más antiguo.");

  // Una tabla pegada sin encabezado (copiada de la pagina) tambien se lee.
  const parsed = JSON.parse(tab.run<string>("JSON.stringify(parseCourseRoster('Seleccionar \\'ROJAS ELENA\\'\\telena.rojas@correounivalle.edu.co\\tEstudiante\\tNo hay grupos\\nPROFESOR UNO\\tprofe@correounivalle.edu.co\\tProfesor\\t'))")) as Json;
  assert.deepEqual((parsed.students as Json[]).map((student) => [student.email, student.displayName]), [["elena.rojas@correounivalle.edu.co", "Rojas Elena"]]);
  assert.deepEqual((parsed.teachers as Json[]).map((teacher) => teacher.email), ["profe@correounivalle.edu.co"]);

  await drive(browser, tab.el("adminImportCancelBtn").click());
  assert.equal(tab.el("adminImportPanel").hidden, true);
  assertKnownShadowIds(tab);
  assert.deepEqual(browser.unknownRoutes.filter((route) => !route.includes("/api/projects") && !route.includes("/api/behavior/summary")), []);
});

test("0.7.21: el docente elige el tema del piloto en «Estudiantes»: semana de la bitácora, tema y repositorio; un backend anterior lo dice", async () => {
  const browser = new FakeBrowser();
  browser.session = { ...SESSION, user: { ...SESSION.user, id: "u-docente", role: "teacher", displayName: "Docente Prueba", assignedCourseCodes: [] } };
  // Viernes 9 de octubre: la proxima clase es la semana 7 (14 de octubre).
  browser.clock.now = Date.parse("2026-10-09T15:00:00.000Z");
  browser.pilotTopicWeeks = [
    { week: 6, dateKey: "2026-10-07", topic: "Herencia y polimorfismo", activities: [] },
    { week: 7, dateKey: "2026-10-14", topic: "Abstracción, encapsulamiento y test", activities: ["Ejercicio IMC"] },
    { week: 8, dateKey: "2026-10-21", topic: "Reutilización de código, modularidad y refactoring", activities: ["Ejercicio Nutrición"] },
  ];
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-docente": true } });
  const tab = await openTab(browser, "https://github.com/vbucheli/IMC", "vbucheli/IMC");
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);
  assert.deepEqual(browser.requestsTo("/api/pilot/topic"), [], "el docente lo consulta al abrir «Estudiantes»");

  await drive(browser, tab.el("tabBtnEstudiantes").click());
  await browser.clock.until(() => tab.state().pilotTopic?.loadedAt > 0, 400);
  assert.equal(browser.requestsTo("/api/pilot/topic", "GET").length, 1);
  assert.equal(tab.el("pilotTopicSection").hidden, false);
  assert.equal(tab.el("pilotTopicTeacherField").hidden, true, "el docente no elige docente");
  assert.equal(tab.el("pilotTopicChip").textContent, "Sin tema");
  assert.match(tab.el("pilotTopicStatus").textContent, /^Sin tema: elige la semana y el ejercicio\./);
  const weekSelect = tab.el("pilotTopicWeek");
  assert.deepEqual(weekSelect.children.map((option) => option.textContent), [
    "Sin semana (solo el tema)",
    "Semana 6 · mié 7 oct · Herencia y polimorfismo",
    "Semana 7 · mié 14 oct · Abstracción, encapsulamiento y test (próxima clase)",
    "Semana 8 · mié 21 oct · Reutilización de código, modularidad y refactoring",
  ]);
  assert.equal(weekSelect.value, "7", "por defecto, la semana de la próxima clase");
  assert.equal(tab.el("pilotTopicTitleInput").value, "Abstracción, encapsulamiento y test");
  assert.equal(tab.el("pilotTopicRepo").value, "");
  // En la página del repositorio, un clic lo pone como ejercicio.
  assert.equal(tab.el("pilotTopicUsePageRepoBtn").hidden, false);
  assert.equal(tab.el("pilotTopicUsePageRepoBtn").textContent, "Usar vbucheli/IMC");
  assert.equal(tab.el("pilotTopicClearBtn").disabled, true, "sin tema no hay que quitar");

  // Cambiar de semana trae su tema (mientras no se haya escrito otro).
  weekSelect.value = "8";
  await drive(browser, weekSelect.dispatch("change"));
  assert.equal(tab.el("pilotTopicTitleInput").value, "Reutilización de código, modularidad y refactoring");
  weekSelect.value = "7";
  await drive(browser, weekSelect.dispatch("change"));
  assert.equal(tab.el("pilotTopicTitleInput").value, "Abstracción, encapsulamiento y test");
  await drive(browser, tab.el("pilotTopicUsePageRepoBtn").click());
  assert.equal(tab.el("pilotTopicRepo").value, "vbucheli/IMC");
  assert.equal(tab.el("pilotTopicUsePageRepoBtn").hidden, true);

  await drive(browser, tab.el("pilotTopicSaveBtn").click(), 800);
  await browser.clock.until(() => !tab.state().pilotTopic.saving, 400);
  assert.deepEqual(browser.pilotTopicPuts, [{ courseCode: "FPOO", week: 7, title: "Abstracción, encapsulamiento y test", repoFullName: "vbucheli/IMC" }]);
  assert.equal(tab.el("pilotTopicChip").textContent, "Semana 7");
  assert.equal(tab.el("pilotTopicStatus").textContent, "Tema del piloto guardado (semana 7 · Abstracción, encapsulamiento y test · ejercicio vbucheli/IMC). Los estudiantes lo ven en Inicio y el tutor se enfoca en esa semana.");
  assert.equal(tab.el("pilotTopicClearBtn").disabled, false);

  // Un repositorio que no es de GitHub: el backend lo rechaza y el estado lo dice.
  tab.el("pilotTopicRepo").value = "https://gitlab.com/x/y";
  await drive(browser, tab.el("pilotTopicRepo").dispatch("input"));
  await drive(browser, tab.el("pilotTopicSaveBtn").click(), 800);
  await browser.clock.until(() => !tab.state().pilotTopic.saving, 400);
  assert.match(tab.el("pilotTopicStatus").textContent, /^No se pudo guardar el tema: El repositorio debe ser usuario\/repositorio/);
  assert.equal(tab.el("pilotTopicStatus").classList.contains("is-warning"), true);
  assert.equal(tab.state().pilotTopic.topic.repoFullName, "vbucheli/IMC", "el tema guardado sigue igual");

  // El tutor del docente tambien va con la semana del tema.
  const tutorWeek = tab.run<Json>("buildPilotTopicWeekForTutor({ courseCode: 'FPOO', weeks: [], totalWeeks: 0, upcoming: [] })");
  assert.equal(tutorWeek.week, 7);
  assert.equal(tutorWeek.topic, "Abstracción, encapsulamiento y test");

  await drive(browser, tab.el("pilotTopicClearBtn").click(), 800);
  await browser.clock.until(() => !tab.state().pilotTopic.saving, 400);
  assert.deepEqual(browser.pilotTopicPuts.at(-1), { clear: true });
  assert.equal(tab.el("pilotTopicChip").textContent, "Sin tema");
  assert.equal(tab.el("pilotTopicStatus").textContent, "Tema del piloto quitado: los estudiantes ya no lo ven en Inicio.");

  // Al abrir un estudiante, la tarjeta deja espacio al detalle.
  await drive(browser, tab.run("openStudentDetail('u-est-1')"), 800);
  assert.equal(tab.el("pilotTopicSection").hidden, true);
  assertKnownShadowIds(tab);

  // Un backend anterior (sin la ruta): lo dice, no deja guardar y no lo vuelve a consultar.
  const old = new FakeBrowser();
  old.session = browser.session;
  old.pilotTopicStatus = 404;
  seedLoggedInBrowser(old, { adaceenPrivacyAcceptedByUser: { "u-docente": true } });
  const oldTab = await openTab(old, `https://github.com/${REPO}`, REPO);
  await drive(old, oldTab.run("openOverlay({ trigger: 'user' })"));
  await old.clock.until(() => oldTab.state().loading === false, 400);
  await drive(old, oldTab.el("tabBtnEstudiantes").click());
  await old.clock.until(() => oldTab.state().pilotTopic?.loadedAt > 0, 400);
  assert.equal(oldTab.el("pilotTopicStatus").textContent, "Este backend todavía no tiene el tema del piloto: llega con la versión 0.7.21.");
  assert.equal(oldTab.el("pilotTopicSaveBtn").disabled, true);
  await drive(old, oldTab.el("tabBtnInicio").click());
  await drive(old, oldTab.el("tabBtnEstudiantes").click());
  assert.equal(old.requestsTo("/api/pilot/topic").length, 1, "no se reintenta en la sesión");
});

test("0.7.21: el estudiante ve el tema de la clase en Inicio, abre el ejercicio en su editor y el tutor va con esa semana", async () => {
  const browser = new FakeBrowser();
  browser.clock.now = DOMINGO_SEMANA_5;
  browser.bitacoraLatest = await fpooBitacoraLatest();
  browser.pilotTopic = { courseCode: "FPOO", week: 7, title: "Abstracción, encapsulamiento y test", repoFullName: "vbucheli/IMC", updatedAt: "2026-09-26T12:00:00.000Z", updatedByName: "Docente Prueba" };
  browser.githubConnected = true;
  const tab = await openStudentAgenda(browser);
  await browser.clock.until(() => tab.state().pilotTopic?.loadedAt > 0, 400);
  assert.equal(browser.requestsTo("/api/pilot/topic").length, 1, "una consulta al entrar");

  // Inicio: el tema con su ejercicio, debajo de la semana del calendario.
  assert.equal(tab.el("pilotTopicHome").hidden, false);
  assert.equal(tab.el("pilotTopicHomeTitle").textContent, "Abstracción, encapsulamiento y test");
  assert.equal(tab.el("pilotTopicHomeMeta").textContent, "FPOO · semana 7 · Ejercicio: vbucheli/IMC");
  assert.equal(tab.el("pilotTopicOpenBtn").hidden, false);
  assert.equal(tab.el("pilotTopicOpenBtn").textContent, "Abrir el ejercicio en mi editor");
  assert.equal(tab.el("pilotTopicSection").hidden, true, "la tarjeta del docente no es para el estudiante");
  assert.equal(tab.el("agendaHomeEyebrow").textContent, "Estás en FPOO · semana 5 de 16", "la agenda sigue el calendario");

  // El tutor recibe la semana del tema (7), no la del calendario (5).
  const intervene = browser.requestsTo("/intervene")[0];
  assert.ok(intervene, "el tutor respondio al entrar");
  const week7 = tab.run<Json>("getCourseAgendaView().weeks.find((week) => week.week === 7)");
  const week8 = tab.run<Json>("getCourseAgendaView().weeks.find((week) => week.week === 8)");
  const courseWeek = ((intervene.body as Json).context as Json).courseWeek as Json;
  assert.equal(courseWeek.week, 7);
  assert.equal(courseWeek.totalWeeks, 16);
  assert.equal(courseWeek.topic, "Abstracción, encapsulamiento y test");
  assert.equal(courseWeek.weekStart, week7.dateKey);
  assert.equal(courseWeek.weekEnd, tab.run<string>(`courseKeyFromDay(${Number(week8.day) - 1})`));
  assert.equal((courseWeek.upcoming as Json[])[0].title, "Examen (Primer parcial)");

  // «Abrir el ejercicio en mi editor»: el editor en la nube abre ESE repositorio.
  await drive(browser, tab.el("pilotTopicOpenBtn").click(), 800);
  const prepare = browser.requestsTo("/api/workspaces/prepare", "POST").at(-1);
  assert.equal(prepare?.body?.repoFullName, "vbucheli/IMC", "el editor en la nube prepara ese repositorio");
  assert.match(tab.state().statusMessage, /Editor listo/);

  // Con Codespaces, el boton lleva al repositorio en GitHub.
  tab.run("overlayState.workspaceProvider = 'codespaces'; renderOverlay()");
  assert.equal(tab.el("pilotTopicOpenBtn").textContent, "Ver el ejercicio en GitHub");

  // Si el tema es de otro curso, no se muestra ni cambia la semana del tutor.
  tab.run("overlayState.pilotTopic.topic = { ...overlayState.pilotTopic.topic, courseCode: 'FPI' }; renderOverlay()");
  assert.equal(tab.el("pilotTopicHome").hidden, true);
  assert.equal(tab.run<Json>("buildCourseWeekForTutor()").week, 5);
  assertKnownShadowIds(tab);
});
