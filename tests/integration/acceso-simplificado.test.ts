import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../../src/app.js";
import { env } from "../../src/config/env.js";
import { createDatabase } from "../../src/db/database.js";
import { SESSION_STATE_HEADER } from "../../src/routes/route-utils.js";
import { createWorkspaceRelay } from "../../src/services/workspace-relay.js";

/**
 * Prueba de integracion del acceso simplificado (docs/arquitectura/acceso-simplificado.md),
 * de punta a punta y con el codigo real de cada componente:
 *
 *   navegador (fetch)  ->  backend completo (createApp, pg-mem)  ->  relay  ->
 *   agente de la VM (deploy/gcp/workspaces/agente, sin systemd)  ->  editor-session.json
 *   en un directorio temporal  ->  parser de la extension de VS Code (vscode-ext-prod/src).
 *
 * GitHub es falso (fetch sustituido solo para sus URL). El resto de las peticiones van por
 * HTTP de verdad. Comprueba ademas las reglas de la seccion 1: un login de navegador
 * posterior NO invalida la sesion editor, y logout si (con la cabecera x-adaceen-session).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const VSCODE_SESSION_MODULE = path.join(ROOT, "vscode-ext-prod/src/editor-session.ts");
const VSCODE_IDENTITY_MODULE = path.join(ROOT, "vscode-ext-prod/src/client-identity.ts");
// La prueba cruzada con VS Code necesita el submodulo (el workflow lo clona con submodules: recursive).
const VSCODE_MISSING = !existsSync(VSCODE_SESSION_MODULE) || !existsSync(VSCODE_IDENTITY_MODULE);

const REPO = "Univalle-ADACEEN/Proyecto-Final";
const AGENT_TOKEN = "token-agente-integracion-0123456789";
const PUBLIC_BASE_URL = "https://adaceen.prueba";
const GITHUB_API = "https://api.github.prueba";
const GITHUB_LOGIN = "Estudiante-GH";
const WORKSPACE_LOGIN = "estudiante-gh";
const OAUTH_CODE = "codigo-oauth-falso";
const OAUTH_TOKEN = "gho_token_oauth_integracion";
const VSCODE_GITHUB_TOKEN = "gho_token_vscode_integracion";
const STUDENT = { email: "estudiante@adaceen.edu.co", password: "Estudiante123!" };
const EDITOR_FILE_KEYS = ["version", "sessionId", "backendUrl", "expiresAt", "userName", "userEmail", "writtenAt"];

type Json = Record<string, any>;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function requestUrl(input: string | URL | Request) {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

// GitHub falso: token del OAuth y /user, /user/emails. Todo lo demas va a la red local de verdad.
function installFakeGithub(realFetch: typeof fetch) {
  const calls: string[] = [];
  const fake: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url === "https://github.com/login/oauth/access_token") {
      calls.push("oauth_token");
      const body = JSON.parse(String(init?.body || "{}"));
      if (body.code !== OAUTH_CODE) return jsonResponse(200, { error: "bad_verification_code" });
      return jsonResponse(200, { access_token: OAUTH_TOKEN, token_type: "bearer", scope: "repo,codespace,read:user,user:email" });
    }
    if (url.startsWith(`${GITHUB_API}/`)) {
      const route = url.slice(GITHUB_API.length);
      calls.push(route);
      const auth = new Headers(init?.headers).get("authorization");
      if (auth !== `Bearer ${OAUTH_TOKEN}` && auth !== `Bearer ${VSCODE_GITHUB_TOKEN}`) {
        return jsonResponse(401, { message: "Bad credentials" });
      }
      if (route === "/user") return jsonResponse(200, { login: GITHUB_LOGIN, email: null });
      if (route === "/user/emails") return jsonResponse(200, [{ email: "estudiante@github.prueba", primary: true, verified: true }]);
      return jsonResponse(404, { message: "Not Found" });
    }
    return realFetch(input, init);
  };
  globalThis.fetch = fake;
  return calls;
}

// Lo que se escribe en el log durante la prueba (para comprobar que no salen ids ni codigos).
function captureLogs() {
  const lines: string[] = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const push = (...args: unknown[]) => { lines.push(args.map((arg) => String(arg)).join(" ")); };
  console.log = push;
  console.info = push;
  console.warn = push;
  console.error = push;
  return {
    lines,
    restore() {
      Object.assign(console, original);
    },
  };
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`No llego a tiempo: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("integracion: navegador -> backend -> relay -> agente escribe editor-session.json que acepta VS Code; login no la invalida, logout si", {
  skip: VSCODE_MISSING ? "falta el submodulo vscode-ext-prod (git submodule update --init)" : false,
}, async () => {
  // Modulos de otros componentes, tal como corren alla (JS del agente y TS puro de la extension).
  const agentModule = "../../deploy/gcp/workspaces/agente/agente-workspaces.mjs";
  const relayModule = "../../deploy/gcp/workspaces/agente/relay.mjs";
  const { crearAgente, crearSistemaReal } = await import(agentModule);
  const { crearClienteRelay } = await import(relayModule);
  const vscodeSessionImport = await import(VSCODE_SESSION_MODULE);
  const vscodeIdentityImport = await import(VSCODE_IDENTITY_MODULE);
  // El submodulo es CommonJS: con tsx las exportaciones llegan en default.
  const vscode = (vscodeSessionImport.default ?? vscodeSessionImport) as Json;
  const vscodeIdentity = (vscodeIdentityImport.default ?? vscodeIdentityImport) as Json;
  assert.equal(typeof vscode.parseEditorSessionFile, "function", "parser real de la extension de VS Code");

  const envKeys = [
    "githubOAuthClientId",
    "githubOAuthClientSecret",
    "githubOAuthCallbackUrl",
    "githubApiBaseUrl",
    "allowedOrigins",
    "workspaceProvider",
  ] as const;
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, env[key]]));
  const realFetch = globalThis.fetch;
  const homes = mkdtempSync(path.join(tmpdir(), "adaceen-integracion-"));
  const logs = captureLogs();

  const cleanup: Array<() => Promise<unknown> | unknown> = [];
  try {
    Object.assign(env, {
      githubOAuthClientId: "Ov23liPruebaIntegracion",
      githubOAuthClientSecret: "secreto-oauth-de-prueba",
      githubOAuthCallbackUrl: `${PUBLIC_BASE_URL}/auth/github/callback`,
      githubApiBaseUrl: GITHUB_API,
      allowedOrigins: ["https://vscode.dev"],
      workspaceProvider: "tunnel",
    });
    const githubCalls = installFakeGithub(realFetch);

    // --- Backend completo en memoria (pg-mem), con el proveedor tunnel por relay.
    const database = await createDatabase();
    const relay = createWorkspaceRelay({ staleAfterMs: 10_000 });
    const app = createApp(database, {
      workspace: {
        config: {
          provider: "tunnel",
          transport: "relay",
          agentUrl: "",
          agentToken: AGENT_TOKEN,
          agentTimeoutMs: 8000,
          allowedLogins: [],
          githubApiBaseUrl: GITHUB_API,
        },
        relay,
        autostart: null,
        publicBaseUrl: PUBLIC_BASE_URL,
      },
      editorAuth: { githubApiBaseUrl: GITHUB_API },
    });
    const server = await new Promise<Server>((resolve) => {
      const started = app.listen(0, "127.0.0.1", () => resolve(started));
    });
    cleanup.push(() => database.close());
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    cleanup.push(() => relay.close());
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const backend = `http://127.0.0.1:${address.port}`;

    async function api(method: string, route: string, options: { sessionId?: string; body?: unknown; headers?: Record<string, string> } = {}) {
      const response = await fetch(`${backend}${route}`, {
        method,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          ...(options.sessionId ? { "x-session-id": options.sessionId } : {}),
          ...(options.headers || {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      const text = await response.text();
      let body: Json = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { html: text };
      }
      return { status: response.status, headers: response.headers, body };
    }

    // --- Agente real de la VM: su sistema real escribe en <homes>/ws-<login>; solo systemd es falso.
    const home = path.join(homes, `ws-${WORKSPACE_LOGIN}`);
    mkdirSync(path.join(home, "proyecto", ".git"), { recursive: true });
    writeFileSync(path.join(home, "proyecto", ".git", "config"), `[remote "origin"]\n\turl = https://github.com/${REPO}.git\n`);
    const uid = process.getuid ? process.getuid() : 1000;
    const gid = process.getgid ? process.getgid() : 1000;
    const realSystem = crearSistemaReal(
      { homeBase: homes, codeBin: "/bin/false" },
      { buscarUsuario: async (usuario: string) => (usuario === `ws-${WORKSPACE_LOGIN}` ? { usuario, uid, gid, home } : null) },
    );
    const observed: string[] = [];
    const system = {
      ...realSystem,
      // Tunel ya registrado y corriendo (sin systemctl ni code tunnel en la prueba).
      async observar(login: string) {
        observed.push(login);
        return {
          usuarioExiste: true,
          servicio: { activo: true, arrancando: false, fallido: false, invocacion: "" },
          sesion: true,
          codigoJournal: null,
          nombreTunelReal: null,
        };
      },
      async prepararRehacer() {
        return null;
      },
    };
    const agent = crearAgente({
      config: {
        token: AGENT_TOKEN,
        hosts: ["127.0.0.1"],
        puerto: 0,
        script: "/bin/false",
        codeBin: "/bin/false",
        maxConcurrentes: 1,
        maxCola: 1,
        timeoutScriptMs: 5000,
        esperaPrepararMs: 500,
      },
      sistema: system,
    });
    const [agentServer] = await agent.escuchar();
    cleanup.push(() => agent.cerrar());
    const relayClient = crearClienteRelay({
      relayUrl: `${backend}/api/workspaces/agent`,
      token: AGENT_TOKEN,
      destino: `http://127.0.0.1:${agentServer.address().port}`,
      esperaS: 1,
    });
    void relayClient.iniciar();
    cleanup.push(() => relayClient.detener());
    await waitFor(() => relay.isAgentOnline(), "el agente conectado al relay");

    // --- 1. Login del navegador y GitHub conectado por el OAuth (GitHub falso).
    const login = await api("POST", "/api/auth/login", { body: STUDENT });
    assert.equal(login.status, 200);
    const browserSession = String(login.body.session?.id || "");
    assert.equal(login.body.session?.kind, "browser");
    const studentId = String(login.body.session?.user?.id || "");

    const oauthStart = await api("POST", "/api/github/oauth/start", { sessionId: browserSession, body: { repoFullName: REPO } });
    assert.equal(oauthStart.status, 200, JSON.stringify(oauthStart.body));
    const state = new URL(String(oauthStart.body.authorizeUrl)).searchParams.get("state");
    assert.ok(state);
    const callback = await api("GET", `/auth/github/callback?code=${OAUTH_CODE}&state=${encodeURIComponent(state!)}`);
    assert.equal(callback.status, 200);
    assert.match(String(callback.body.html), /GitHub conectado correctamente/);
    assert.match(String(callback.body.html), /preparando tu editor/, "con el tunel el callback no habla de Codespaces");
    const oauthStatus = await api("GET", "/api/github/oauth/status", { sessionId: browserSession });
    assert.equal(oauthStatus.body.connected, true);
    assert.equal(oauthStatus.body.accountLogin, GITHUB_LOGIN);

    // --- 2. «Preparar mi editor»: prepare por relay; el agente escribe la sesion del editor.
    const sessionFile = path.join(home, ".adaceen", "editor-session.json");
    const prepare = await api("POST", "/api/workspaces/prepare", { sessionId: browserSession, body: { repoFullName: REPO } });
    assert.equal(prepare.status, 200, JSON.stringify(prepare.body));
    assert.equal(prepare.body.status, "ready");
    assert.equal(prepare.body.workspace?.login, WORKSPACE_LOGIN);
    assert.match(String(prepare.body.workspace?.webUrl), /^https:\/\/vscode\.dev\/tunnel\//);
    assert.equal(JSON.stringify(prepare.body).includes("sessionId"), false, "la sesion editor nunca vuelve al navegador");
    assert.deepEqual(observed, [WORKSPACE_LOGIN], "el agente miro el tunel del login que salio de GitHub");

    assert.ok(existsSync(sessionFile), "el agente escribio ~/.adaceen/editor-session.json");
    assert.equal(statSync(path.dirname(sessionFile)).mode & 0o777, 0o700);
    assert.equal(statSync(sessionFile).mode & 0o777, 0o600);
    const fileText = readFileSync(sessionFile, "utf8");
    const fileJson = JSON.parse(fileText) as Json;
    assert.deepEqual(Object.keys(fileJson), EDITOR_FILE_KEYS, "formato del contrato 2.3");
    assert.equal(fileJson.version, 1);
    assert.equal(fileJson.backendUrl, PUBLIC_BASE_URL);
    assert.equal(fileJson.userEmail, STUDENT.email);
    assert.notEqual(fileJson.sessionId, browserSession);
    const tunnelSession = await database.getSession(String(fileJson.sessionId));
    assert.equal(tunnelSession?.kind, "editor");
    assert.equal(tunnelSession?.label, "tunnel");
    assert.equal(tunnelSession?.user.id, studentId);

    // --- 3. La extension de VS Code (codigo real) acepta el archivo y la sesion funciona.
    const parsed = vscode.parseEditorSessionFile(fileText);
    assert.equal(parsed.ok, true, `el parser de VS Code rechazo el archivo: ${parsed.problem}`);
    assert.equal(parsed.session.sessionId, fileJson.sessionId);
    assert.equal(parsed.session.label, "tunnel");
    assert.equal(parsed.session.userEmail, STUDENT.email);
    const days = (parsed.session.expiresAt - Date.now()) / 86_400_000;
    assert.ok(days > 29 && days <= 30, `la sesion editor vence en 30 dias (${days})`);
    assert.equal(parsed.writtenAt, Date.parse(fileJson.writtenAt));
    const resolved = vscode.resolveEditorSession(
      { file: parsed.session, fileWrittenAt: parsed.writtenAt },
      { backendUrl: PUBLIC_BASE_URL, preferNewerFile: true },
    );
    assert.equal(resolved?.source, "file");
    assert.equal(resolved?.sessionId, fileJson.sessionId);

    const httpFetch = (url: string, init: RequestInit) => fetch(url, init);
    const editorHeaders = vscodeIdentity.buildIdentityHeaders(resolved.sessionId) as Record<string, string>;
    assert.equal(editorHeaders["x-session-id"], resolved.sessionId);
    const check = await vscode.requestSessionCheck(httpFetch, { baseUrl: backend, headers: editorHeaders });
    assert.deepEqual(check, { status: "ok", userName: String(login.body.session?.user?.displayName), userEmail: STUDENT.email });

    // La cabecera x-adaceen-session se expone por CORS (vscode.dev lee la respuesta desde el navegador).
    const cors = await api("GET", "/api/auth/me", { sessionId: resolved.sessionId, headers: { Origin: "https://vscode.dev" } });
    assert.equal(cors.status, 200);
    assert.equal(cors.headers.get("access-control-allow-origin"), "https://vscode.dev");
    assert.match(String(cors.headers.get("access-control-expose-headers")), new RegExp(SESSION_STATE_HEADER, "i"));
    assert.equal(cors.body.session?.kind, "editor");

    // --- 4. Un login de navegador posterior (otro equipo) NO invalida la sesion editor.
    const secondLogin = await api("POST", "/api/auth/login", { body: STUDENT });
    assert.equal(secondLogin.status, 200);
    const secondBrowser = String(secondLogin.body.session?.id || "");
    const oldBrowser = await api("GET", "/api/auth/me", { sessionId: browserSession });
    assert.equal(oldBrowser.status, 401, "el login desactiva la sesion browser anterior");
    assert.equal(oldBrowser.headers.get(SESSION_STATE_HEADER), "invalid");
    const stillEditor = await api("GET", "/api/auth/me", { sessionId: resolved.sessionId });
    assert.equal(stillEditor.status, 200, "la sesion editor sigue viva tras otro login");
    assert.equal(stillEditor.headers.get(SESSION_STATE_HEADER), null);
    assert.equal((await vscode.requestSessionCheck(httpFetch, { baseUrl: backend, headers: editorHeaders })).status, "ok");

    // Mac del laboratorio: el navegador pide un codigo y VS Code lo canjea (codigo real de ambos lados).
    const pairing = await api("POST", "/api/auth/editor/pairing-code", { sessionId: secondBrowser, body: {} });
    assert.equal(pairing.status, 200);
    assert.match(String(pairing.body.code), /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    const typed = vscode.classifyConnectInput(String(pairing.body.code).toLowerCase().replace("-", " "));
    assert.equal(typed.kind, "code", "VS Code reconoce el codigo aunque se escriba en minusculas");
    const claimed = await vscode.requestEditorClaim(httpFetch, {
      kind: "code",
      baseUrl: backend,
      body: { code: typed.code, editorHost: "local", label: "vscode-local" },
      label: "vscode-local",
    });
    assert.equal(claimed.ok, true, JSON.stringify(claimed));
    assert.equal(claimed.session.userEmail, STUDENT.email);
    assert.equal((await database.getSession(claimed.session.sessionId))?.label, "vscode-local");
    const reused = await vscode.requestEditorClaim(httpFetch, {
      kind: "code",
      baseUrl: backend,
      body: { code: typed.code },
      label: "codigo",
    });
    assert.equal(reused.ok, false);
    assert.equal(reused.error, "code_not_found", "el codigo es de un solo uso");

    // Cuenta de GitHub de VS Code (canje silencioso o «Con mi cuenta de GitHub»).
    const githubClaim = await vscode.requestEditorClaim(httpFetch, {
      kind: "github",
      baseUrl: backend,
      body: { githubToken: VSCODE_GITHUB_TOKEN, editorHost: "local" },
      label: "github",
    });
    assert.equal(githubClaim.ok, true, JSON.stringify(githubClaim));
    assert.equal(githubClaim.githubLogin, GITHUB_LOGIN);

    // --- 5. Logout en el navegador: desvincula tambien VS Code (todas las sesiones editor).
    const logout = await api("POST", "/api/auth/logout", { sessionId: secondBrowser, body: {} });
    assert.equal(logout.status, 200);
    for (const editorSessionId of [resolved.sessionId, claimed.session.sessionId, githubClaim.session.sessionId]) {
      const me = await api("GET", "/api/auth/me", { sessionId: editorSessionId });
      assert.equal(me.status, 401);
      assert.equal(me.headers.get(SESSION_STATE_HEADER), "invalid");
    }
    const deadCheck = await vscode.requestSessionCheck(httpFetch, { baseUrl: backend, headers: editorHeaders });
    assert.deepEqual(deadCheck, { status: "invalid" });
    // VS Code reconoce la sesion rechazada en cualquier respuesta (tambien en rutas anonimas).
    const anonymous = await fetch(`${backend}/api/workspaces/provider`, { headers: editorHeaders });
    assert.equal(anonymous.status, 200, "la ruta anonima sigue respondiendo");
    assert.equal(vscodeIdentity.rejectedSessionId(editorHeaders, anonymous.headers), resolved.sessionId);

    // --- 6. Volver a entrar y «Abrir mi editor»: la VM recibe una sesion NUEVA y VS Code la acepta.
    const thirdLogin = await api("POST", "/api/auth/login", { body: STUDENT });
    const thirdBrowser = String(thirdLogin.body.session?.id || "");
    const again = await api("POST", "/api/workspaces/prepare", { sessionId: thirdBrowser, body: { repoFullName: REPO } });
    assert.equal(again.body.status, "ready");
    const renewedText = readFileSync(sessionFile, "utf8");
    const renewed = vscode.parseEditorSessionFile(renewedText);
    assert.equal(renewed.ok, true);
    assert.notEqual(renewed.session.sessionId, resolved.sessionId, "tras logout la VM recibe otra sesion");
    const renewedCheck = await vscode.requestSessionCheck(httpFetch, {
      baseUrl: backend,
      headers: vscodeIdentity.buildIdentityHeaders(renewed.session.sessionId),
    });
    assert.equal(renewedCheck.status, "ok");

    // GitHub falso: el backend leyo el login con el token del OAuth y con el de VS Code.
    assert.ok(githubCalls.includes("oauth_token"));
    assert.ok(githubCalls.filter((call) => call === "/user").length >= 2);

    // --- 7. Nada de lo anterior quedo en el log: ni ids de sesion, ni el codigo, ni tokens.
    const secrets = [
      browserSession,
      secondBrowser,
      thirdBrowser,
      String(fileJson.sessionId),
      renewed.session.sessionId,
      claimed.session.sessionId,
      githubClaim.session.sessionId,
      String(pairing.body.code),
      typed.code,
      OAUTH_TOKEN,
      VSCODE_GITHUB_TOKEN,
      AGENT_TOKEN,
    ];
    const logText = logs.lines.join("\n");
    for (const secret of secrets) {
      assert.equal(logText.includes(secret), false, "un id de sesion, codigo o token quedo en el log");
    }
  } finally {
    logs.restore();
    for (const step of cleanup.reverse()) {
      await Promise.resolve().then(step).catch(() => {});
    }
    globalThis.fetch = realFetch;
    Object.assign(env, savedEnv);
    rmSync(homes, { recursive: true, force: true });
  }
});
