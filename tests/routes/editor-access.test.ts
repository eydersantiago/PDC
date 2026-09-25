import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import express from "express";
import { createApp } from "../../src/app.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { registerAuthRoutes } from "../../src/routes/auth-routes.js";
import {
  GITHUB_LOGIN_NOT_LINKED_MESSAGE,
  registerEditorAuthRoutes,
  STAFF_REQUIRES_CODE_MESSAGE,
  type EditorAuthDeps,
} from "../../src/routes/editor-auth-routes.js";
import { createSessionStateMiddleware, SESSION_STATE_HEADER } from "../../src/routes/route-utils.js";
import {
  createAttemptLimiter,
  generatePairingCode,
  hashPairingCode,
  normalizePairingCode,
  PAIRING_CODE_ALPHABET,
} from "../../src/services/editor-pairing.js";
import type { FetchLike } from "../../src/services/workspace-provider.js";

/**
 * Acceso simplificado (docs/arquitectura/acceso-simplificado.md, secciones 1 y 2):
 * sesiones por tipo, aviso de sesion invalida, codigos de emparejamiento y
 * canje con la cuenta de GitHub de VS Code.
 */

const STUDENT = { email: "estudiante@adaceen.edu.co", password: "Estudiante123!" };
const TEACHER = { email: "docente@adaceen.edu.co", password: "Docente123!" };

type Started = { database: AppDatabase; server: Server; baseUrl: string };

async function listen(app: express.Express, database: AppDatabase): Promise<Started> {
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No se pudo iniciar servidor de prueba.");
  return { database, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function startFullApp() {
  const database = await createDatabase();
  return listen(createApp(database), database);
}

// App minima con el lector de GitHub y los limitadores inyectados (sin red).
async function startEditorApp(deps: EditorAuthDeps = {}) {
  const database = await createDatabase();
  const app = express();
  app.use(express.json());
  app.use(createSessionStateMiddleware(database));
  registerAuthRoutes(app, database);
  registerEditorAuthRoutes(app, database, deps);
  return listen(app, database);
}

async function stop({ server, database }: Started) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await database.close();
}

type Json = Record<string, unknown> & {
  ok?: boolean;
  error?: string;
  message?: string;
  code?: string;
  sessionId?: string;
  expiresAt?: string;
  ttlSeconds?: number;
  githubLogin?: string;
  user?: { id?: string; role?: string; email?: string; displayName?: string };
  session?: { id?: string; kind?: string; expiresAt?: string | null };
};

async function call(baseUrl: string, method: string, route: string, options: {
  sessionId?: string;
  body?: unknown;
  headers?: Record<string, string>;
} = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(options.sessionId ? { "x-session-id": options.sessionId } : {}),
      ...(options.headers || {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let data: Json = {};
  try {
    data = text ? JSON.parse(text) as Json : {};
  } catch {
    data = {};
  }
  return { status: response.status, headers: response.headers, data };
}

async function login(baseUrl: string, account: { email: string; password: string }, sessionKind?: string) {
  const result = await call(baseUrl, "POST", "/api/auth/login", {
    body: { ...account, ...(sessionKind ? { sessionKind } : {}) },
  });
  assert.equal(result.status, 200, `login ${account.email}`);
  return result.data;
}

function daysFromNow(iso: string | null | undefined) {
  return (Date.parse(String(iso)) - Date.now()) / (24 * 60 * 60 * 1000);
}

test("codigos de emparejamiento: formato, alfabeto y normalizacion", () => {
  for (let index = 0; index < 50; index += 1) {
    const code = generatePairingCode();
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    for (const char of code.replace("-", "")) {
      assert.ok(PAIRING_CODE_ALPHABET.includes(char), `caracter ${char} fuera del alfabeto`);
    }
  }
  assert.equal(normalizePairingCode(" k7p4-m2qx "), "K7P4M2QX");
  assert.equal(normalizePairingCode("K7P4 M2QX"), "K7P4M2QX");
  assert.equal(normalizePairingCode("K7P4-M2Q"), "", "7 caracteres");
  assert.equal(normalizePairingCode("K7P4-M2Q0"), "", "el 0 no esta en el alfabeto");
  assert.equal(normalizePairingCode("K7P4-M2QI"), "", "la I no esta en el alfabeto");
  assert.equal(normalizePairingCode(12345678), "");
  assert.equal(hashPairingCode("K7P4M2QX").length, 64);
  assert.notEqual(hashPairingCode("K7P4M2QX"), "K7P4M2QX");
});

test("limitador: bloquea tras 20 fallos por clave y se libera al pasar la ventana", () => {
  let now = 1_000_000;
  const limiter = createAttemptLimiter({ limit: 20, windowMs: 60_000, now: () => now });
  for (let index = 0; index < 19; index += 1) limiter.recordFailure("10.0.0.1");
  assert.equal(limiter.isBlocked("10.0.0.1"), false);
  limiter.recordFailure("10.0.0.1");
  assert.equal(limiter.isBlocked("10.0.0.1"), true);
  assert.equal(limiter.isBlocked("10.0.0.2"), false, "otra IP no se ve afectada");
  now += 60_001;
  assert.equal(limiter.isBlocked("10.0.0.1"), false);
});

test("sesiones por tipo: login browser y cli no se pisan; editor sobrevive al login y cae con logout", async () => {
  const started = await startFullApp();
  const { baseUrl, database } = started;
  try {
    const browser = await login(baseUrl, STUDENT);
    assert.equal(browser.session?.kind, "browser");
    assert.equal(browser.session?.expiresAt, null, "las sesiones del navegador no vencen");
    const browserId = String(browser.session?.id);

    const editor = await database.createEditorSession({
      userId: String((await database.getSession(browserId))?.user.id),
      label: "codigo",
      ttlMs: 30 * 24 * 60 * 60 * 1000,
    });
    assert.ok(editor);
    assert.equal(editor.kind, "editor");
    assert.equal(editor.label, "codigo");
    assert.ok(daysFromNow(editor.expiresAt) > 29.9);

    const cli = await login(baseUrl, STUDENT, "cli");
    assert.equal(cli.session?.kind, "cli");
    const cliId = String(cli.session?.id);
    assert.ok(await database.getSession(browserId), "el login cli no cierra la sesion del navegador");
    assert.ok(await database.getSession(editor.id), "ni la de VS Code");

    const browserAgain = await login(baseUrl, STUDENT);
    const browserAgainId = String(browserAgain.session?.id);
    assert.equal(await database.getSession(browserId), null, "el nuevo login browser reemplaza al anterior");
    assert.ok(await database.getSession(cliId), "pero no toca la sesion cli");
    assert.ok(await database.getSession(editor.id), "ni la editor (antes moria en silencio)");

    const secondCli = await login(baseUrl, STUDENT, "cli");
    assert.equal(await database.getSession(cliId), null, "un login cli solo reemplaza al cli anterior");
    assert.ok(await database.getSession(browserAgainId));

    const invalidKind = await call(baseUrl, "POST", "/api/auth/login", { body: { ...STUDENT, sessionKind: "editor" } });
    assert.equal(invalidKind.status, 400, "editor no se pide por login");

    const logout = await call(baseUrl, "POST", "/api/auth/logout", { sessionId: browserAgainId });
    assert.equal(logout.status, 200);
    assert.equal(await database.getSession(browserAgainId), null);
    assert.equal(await database.getSession(editor.id), null, "salir en el navegador desvincula VS Code");
    assert.ok(await database.getSession(String(secondCli.session?.id)), "la sesion cli sigue");
  } finally {
    await stop(started);
  }
});

test("sesiones editor: getSession rechaza las vencidas y se conservan como mucho 10 activas", async () => {
  const database = await createDatabase();
  try {
    const session = await database.authenticateUser(STUDENT.email, STUDENT.password);
    assert.ok(session);
    const userId = session.user.id;
    const created = await database.createEditorSession({ userId, label: "tunnel", ttlMs: 10 * 24 * 60 * 60 * 1000 });
    assert.ok(created);
    assert.ok(await database.getSession(created.id));

    await database.pool.query(`update app_sessions set expires_at = $2 where id = $1`, [created.id, new Date(Date.now() - 1000)]);
    assert.equal(await database.getSession(created.id), null, "vencida = invalida");

    const ids: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const next = await database.createEditorSession({ userId, label: "codigo", ttlMs: 24 * 60 * 60 * 1000 });
      assert.ok(next);
      ids.push(next.id);
    }
    const active = await database.pool.query<{ id: string }>(
      `select id from app_sessions where user_id = $1 and kind = 'editor' and is_active = true`,
      [userId],
    );
    assert.equal(active.rows.length, 10);
    assert.ok(active.rows.some((row) => row.id === ids.at(-1)), "la recien creada sigue activa");
    assert.ok(await database.getSession(session.id), "las editor no tocan la sesion del navegador");

    assert.equal(await database.createEditorSession({ userId: "no-existe", label: "codigo", ttlMs: 1000 }), null);
  } finally {
    await database.close();
  }
});

test("sesiones editor: la poda respeta la del tunel y las usadas hace poco", async () => {
  const database = await createDatabase();
  try {
    const session = await database.authenticateUser(STUDENT.email, STUDENT.password);
    assert.ok(session);
    const userId = session.user.id;
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);
    const tunnel = await database.createEditorSession({ userId, label: "tunnel", ttlMs: 30 * 24 * 60 * 60 * 1000 });
    const usedDaily = await database.createEditorSession({ userId, label: "codigo", ttlMs: 30 * 24 * 60 * 60 * 1000 });
    assert.ok(tunnel && usedDaily);
    // Las dos son las mas viejas; la del tunel no se uso hace dias, la otra se usa a diario.
    await database.pool.query(`update app_sessions set created_at = $2, last_seen_at = $2 where id = $1`, [tunnel.id, hoursAgo(100)]);
    await database.pool.query(`update app_sessions set created_at = $2, last_seen_at = $3 where id = $1`, [usedDaily.id, hoursAgo(90), hoursAgo(0.1)]);

    for (let index = 0; index < 12; index += 1) {
      const next = await database.createEditorSession({ userId, label: "vscode-local", ttlMs: 24 * 60 * 60 * 1000 });
      assert.ok(next);
      await database.pool.query(`update app_sessions set last_seen_at = $2 where id = $1`, [next.id, hoursAgo(50 - index)]);
    }
    const active = await database.pool.query<{ id: string }>(
      `select id from app_sessions where user_id = $1 and kind = 'editor' and is_active = true`,
      [userId],
    );
    assert.equal(active.rows.length, 10);
    assert.ok(await database.getSession(tunnel.id), "la sesion del tunel sigue valida aunque sea la mas vieja");
    assert.ok(await database.getSession(usedDaily.id), "la usada hace poco sigue valida");
  } finally {
    await database.close();
  }
});

test("x-adaceen-session: invalid en toda respuesta con x-session-id que no vale (y expuesta por CORS)", async () => {
  const started = await startFullApp();
  const { baseUrl } = started;
  try {
    const health = await call(baseUrl, "GET", "/api/health", { sessionId: "sesion-que-no-existe" });
    assert.equal(health.status, 200, "las rutas anonimas siguen respondiendo");
    assert.equal(health.headers.get(SESSION_STATE_HEADER), "invalid");

    const provider = await call(baseUrl, "GET", "/api/workspaces/provider", { sessionId: "sesion-que-no-existe" });
    assert.equal(provider.headers.get(SESSION_STATE_HEADER), "invalid");

    const me = await call(baseUrl, "GET", "/api/auth/me", { sessionId: "sesion-que-no-existe" });
    assert.equal(me.status, 401, "las que exigen sesion siguen dando 401");
    assert.equal(me.headers.get(SESSION_STATE_HEADER), "invalid");

    const valid = await login(baseUrl, STUDENT);
    const ok = await call(baseUrl, "GET", "/api/auth/me", { sessionId: String(valid.session?.id) });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get(SESSION_STATE_HEADER), null, "sesion valida: sin cabecera");

    const anonymous = await call(baseUrl, "GET", "/api/health");
    assert.equal(anonymous.headers.get(SESSION_STATE_HEADER), null, "sin x-session-id: sin cabecera");

    await call(baseUrl, "POST", "/api/auth/logout", { sessionId: String(valid.session?.id) });
    const afterLogout = await call(baseUrl, "GET", "/api/health", { sessionId: String(valid.session?.id) });
    assert.equal(afterLogout.headers.get(SESSION_STATE_HEADER), "invalid", "inactiva tambien es invalida");

    // Las respuestas que entregan una sesion nueva no llevan la marca aunque llegue un x-session-id viejo.
    const relogin = await call(baseUrl, "POST", "/api/auth/login", { sessionId: "sesion-vieja", body: STUDENT });
    assert.equal(relogin.status, 200);
    assert.equal(relogin.headers.get(SESSION_STATE_HEADER), null);
    const failedLogin = await call(baseUrl, "POST", "/api/auth/login", { sessionId: "sesion-vieja", body: { ...STUDENT, password: "otra-clave" } });
    assert.equal(failedLogin.status, 401);
    assert.equal(failedLogin.headers.get(SESSION_STATE_HEADER), "invalid");

    const cors = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: "https://github.com", "x-session-id": "sesion-que-no-existe" },
    });
    const exposed = String(cors.headers.get("access-control-expose-headers") || "").toLowerCase();
    assert.ok(exposed.includes(SESSION_STATE_HEADER), `Access-Control-Expose-Headers: ${exposed}`);
  } finally {
    await stop(started);
  }
});

test("emparejamiento con codigo: navegador lo pide, VS Code lo canjea una sola vez", async () => {
  const started = await startEditorApp();
  const { baseUrl, database } = started;
  try {
    const browser = await login(baseUrl, STUDENT);
    const browserId = String(browser.session?.id);

    assert.equal((await call(baseUrl, "POST", "/api/auth/editor/pairing-code")).status, 401);
    const cookieOnly = await call(baseUrl, "POST", "/api/auth/editor/pairing-code", {
      headers: { Cookie: `adaceen_session_id=${browserId}` },
    });
    assert.equal(cookieOnly.status, 401, "con la cookie sola otra pagina no puede pedir un codigo");

    const issued = await call(baseUrl, "POST", "/api/auth/editor/pairing-code", { sessionId: browserId });
    assert.equal(issued.status, 200);
    assert.equal(issued.data.ok, true);
    assert.match(String(issued.data.code), /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(issued.data.ttlSeconds, 600);
    const minutes = (Date.parse(String(issued.data.expiresAt)) - Date.now()) / 60_000;
    assert.ok(minutes > 9.9 && minutes <= 10.01, `vence en 10 min (${minutes})`);
    assert.equal(issued.headers.get("cache-control"), "no-store");

    const stored = await database.pool.query<{ code_hash: string }>(`select code_hash from editor_pairing_codes`);
    assert.equal(stored.rows.length, 1);
    assert.notEqual(stored.rows[0].code_hash, String(issued.data.code).replace("-", ""), "solo se guarda el hash");
    assert.equal(stored.rows[0].code_hash, hashPairingCode(normalizePairingCode(issued.data.code)));

    // Minusculas, sin guion y con espacios: se normaliza.
    const typed = String(issued.data.code).toLowerCase().replace("-", " ");
    const claimed = await call(baseUrl, "POST", "/api/auth/editor/claim", {
      body: { code: typed, editorHost: "local", label: "vscode-local" },
    });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.data.ok, true);
    assert.equal(claimed.data.user?.email, STUDENT.email);
    assert.equal(claimed.data.user?.role, "student");
    assert.ok(daysFromNow(claimed.data.expiresAt) > 29.9, "la sesion editor vence a los 30 dias");
    const editorSession = await database.getSession(String(claimed.data.sessionId));
    assert.equal(editorSession?.kind, "editor");
    assert.equal(editorSession?.label, "vscode-local");
    assert.ok(await database.getSession(browserId), "el navegador sigue con su sesion");

    const again = await call(baseUrl, "POST", "/api/auth/editor/claim", { body: { code: issued.data.code }, sessionId: "sesion-vieja-de-vscode" });
    assert.equal(again.status, 404, "un solo uso");
    assert.equal(again.data.error, "code_not_found");
    assert.equal(again.headers.get(SESSION_STATE_HEADER), "invalid");

    // Una sesion editor no reparte codigos.
    const fromEditor = await call(baseUrl, "POST", "/api/auth/editor/pairing-code", { sessionId: String(claimed.data.sessionId) });
    assert.equal(fromEditor.status, 403);

    const badFormat = await call(baseUrl, "POST", "/api/auth/editor/claim", { body: { code: "123" } });
    assert.equal(badFormat.status, 400);
    assert.equal(badFormat.data.error, "invalid_code");

    // Label raro -> "codigo".
    const other = await call(baseUrl, "POST", "/api/auth/editor/pairing-code", { sessionId: browserId });
    const claimedDefault = await call(baseUrl, "POST", "/api/auth/editor/claim", {
      body: { code: other.data.code, label: "<script>" },
      sessionId: "sesion-vieja-de-vscode",
    });
    assert.equal(claimedDefault.status, 200);
    assert.equal(claimedDefault.headers.get(SESSION_STATE_HEADER), null, "el canje bueno no marca invalida la sesion nueva");
    assert.equal((await database.getSession(String(claimedDefault.data.sessionId)))?.label, "codigo");
  } finally {
    await stop(started);
  }
});

test("emparejamiento con codigo: pedir otro invalida el anterior y los vencidos no se canjean", async () => {
  const started = await startEditorApp();
  const { baseUrl, database } = started;
  try {
    const browserId = String((await login(baseUrl, STUDENT)).session?.id);
    const first = await call(baseUrl, "POST", "/api/auth/editor/pairing-code", { sessionId: browserId });
    const second = await call(baseUrl, "POST", "/api/auth/editor/pairing-code", { sessionId: browserId });
    assert.notEqual(first.data.code, second.data.code);

    const stale = await call(baseUrl, "POST", "/api/auth/editor/claim", { body: { code: first.data.code } });
    assert.equal(stale.status, 404, "el codigo anterior quedo invalidado");

    // Codigo vencido: se escribe directo en la base con vencimiento pasado.
    const session = await database.getSession(browserId);
    await database.createEditorPairingCode({
      userId: String(session?.user.id),
      codeHash: hashPairingCode("ABCD2345"),
      expiresAt: new Date(Date.now() - 1000),
    });
    const expired = await call(baseUrl, "POST", "/api/auth/editor/claim", { body: { code: "ABCD-2345" } });
    assert.equal(expired.status, 404);
    assert.equal(expired.data.error, "code_not_found");

    // Un usuario desactivado no recibe sesion aunque el codigo sea bueno.
    const teacherId = String((await login(baseUrl, TEACHER)).session?.id);
    const teacherCode = await call(baseUrl, "POST", "/api/auth/editor/pairing-code", { sessionId: teacherId });
    const teacher = await database.getSession(teacherId);
    await database.pool.query(`update users set is_active = false where id = $1`, [teacher?.user.id]);
    const inactive = await call(baseUrl, "POST", "/api/auth/editor/claim", { body: { code: teacherCode.data.code } });
    assert.equal(inactive.status, 404);
  } finally {
    await stop(started);
  }
});

test("emparejamiento: 20 intentos fallidos por minuto e IP -> 429; los canjes buenos no gastan cupo", async () => {
  let now = 5_000_000;
  const clock = () => now;
  const started = await startEditorApp({ now: clock, claimLimiter: createAttemptLimiter({ now: clock }) });
  const { baseUrl } = started;
  try {
    const browserId = String((await login(baseUrl, STUDENT)).session?.id);
    const fromLab = { "x-forwarded-for": "198.51.100.7:51000" };

    // Un laboratorio entero sale por la misma IP: los canjes buenos pasan.
    for (let index = 0; index < 22; index += 1) {
      const code = await call(baseUrl, "POST", "/api/auth/editor/pairing-code", { sessionId: browserId });
      const ok = await call(baseUrl, "POST", "/api/auth/editor/claim", { body: { code: code.data.code }, headers: fromLab });
      assert.equal(ok.status, 200, `canje bueno ${index}`);
    }

    for (let index = 0; index < 20; index += 1) {
      const wrong = await call(baseUrl, "POST", "/api/auth/editor/claim", { body: { code: "ZZZZ-ZZZZ" }, headers: fromLab });
      assert.equal(wrong.status, 404);
    }
    const blocked = await call(baseUrl, "POST", "/api/auth/editor/claim", { body: { code: "ZZZZ-ZZZZ" }, headers: fromLab });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.data.error, "too_many_attempts");
    assert.equal(blocked.headers.get("retry-after"), "60");

    // El cliente no puede cambiar de IP anteponiendo otra en X-Forwarded-For.
    const spoofed = await call(baseUrl, "POST", "/api/auth/editor/claim", {
      body: { code: "ZZZZ-ZZZZ" },
      headers: { "x-forwarded-for": "203.0.113.99, 198.51.100.7:51001" },
    });
    assert.equal(spoofed.status, 429);

    const otherIp = await call(baseUrl, "POST", "/api/auth/editor/claim", {
      body: { code: "ZZZZ-ZZZZ" },
      headers: { "x-forwarded-for": "198.51.100.8:40000" },
    });
    assert.equal(otherIp.status, 404, "otra IP no esta bloqueada");

    now += 61_000;
    const later = await call(baseUrl, "POST", "/api/auth/editor/claim", { body: { code: "ZZZZ-ZZZZ" }, headers: fromLab });
    assert.equal(later.status, 404, "al minuto se libera");
  } finally {
    await stop(started);
  }
});

test("canje con GitHub de VS Code: token invalido, login no vinculado y ok (sin guardar el token)", async () => {
  const githubCalls: Array<{ url: string; authorization: string }> = [];
  const logins: Record<string, string> = {
    "gho_token_bueno": "Estudiante-GH",
    "gho_token_sin_vinculo": "alguien-mas",
  };
  const fetchImpl: FetchLike = async (url, init) => {
    const authorization = new Headers(init?.headers).get("authorization") || "";
    githubCalls.push({ url, authorization });
    const token = authorization.replace(/^Bearer /, "");
    if (token === "gho_github_caido") return new Response("{}", { status: 503 });
    const login = logins[token];
    return login
      ? new Response(JSON.stringify({ login }), { status: 200, headers: { "Content-Type": "application/json" } })
      : new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
  };
  const started = await startEditorApp({ fetch: fetchImpl, githubApiBaseUrl: "https://api.github.invalid" });
  const { baseUrl, database } = started;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const logged: string[] = [];
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    const session = await database.authenticateUser(STUDENT.email, STUDENT.password);
    assert.ok(session);
    // El OAuth de ADACEEN vinculo antes "estudiante-gh" (otra mayuscula); gana la fila mas reciente.
    await database.upsertGithubUserToken({ userId: session.user.id, accountLogin: "estudiante-gh", accessToken: "gho_oauth_adaceen" });

    const missing = await call(baseUrl, "POST", "/api/auth/editor/github", { body: {} });
    assert.equal(missing.status, 400);
    assert.equal(missing.data.error, "missing_token");

    const invalid = await call(baseUrl, "POST", "/api/auth/editor/github", { body: { githubToken: "gho_revocado" } });
    assert.equal(invalid.status, 401);
    assert.equal(invalid.data.error, "github_token_invalid");

    const unlinked = await call(baseUrl, "POST", "/api/auth/editor/github", { body: { githubToken: "gho_token_sin_vinculo" } });
    assert.equal(unlinked.status, 404);
    assert.equal(unlinked.data.error, "github_login_not_linked");
    assert.equal(unlinked.data.message, GITHUB_LOGIN_NOT_LINKED_MESSAGE);

    const down = await call(baseUrl, "POST", "/api/auth/editor/github", { body: { githubToken: "gho_github_caido" } });
    assert.equal(down.status, 502);
    assert.equal(down.data.error, "github_unavailable");

    const ok = await call(baseUrl, "POST", "/api/auth/editor/github", { body: { githubToken: "gho_token_bueno", editorHost: "tunnel" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.ok, true);
    assert.equal(ok.data.githubLogin, "Estudiante-GH");
    assert.equal(ok.data.user?.id, session.user.id);
    const editor = await database.getSession(String(ok.data.sessionId));
    assert.equal(editor?.kind, "editor");
    assert.equal(editor?.label, "github");
    assert.ok(daysFromNow(editor?.expiresAt) > 29.9);
    assert.ok(await database.getSession(session.id), "no cierra la sesion del navegador");

    assert.ok(githubCalls.every((item) => item.url === "https://api.github.invalid/user"));
    const stored = await database.getGithubUserTokenForUser(session.user.id);
    assert.equal(stored?.accessToken, "gho_oauth_adaceen", "el token de VS Code no reemplaza al del OAuth");
    const dump = JSON.stringify((await database.pool.query(`select * from app_sessions`)).rows);
    assert.doesNotMatch(dump, /gho_token_bueno/);
    assert.ok(logged.every((line) => !/gho_|Bearer/.test(line)), "ni el token ni la cabecera llegan a los logs");
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    await stop(started);
  }
});

test("canje con GitHub: con varias cuentas vinculadas al mismo login gana la mas reciente", async () => {
  const database = await createDatabase();
  try {
    const student = await database.authenticateUser(STUDENT.email, STUDENT.password);
    const teacher = await database.authenticateUser(TEACHER.email, TEACHER.password);
    assert.ok(student && teacher);
    await database.upsertGithubUserToken({ userId: teacher.user.id, accountLogin: "Compartido", accessToken: "gho_a" });
    await database.upsertGithubUserToken({ userId: student.user.id, accountLogin: "compartido", accessToken: "gho_b" });
    await database.pool.query(`update github_user_tokens set updated_at = $2 where user_id = $1`, [teacher.user.id, new Date(Date.now() - 60_000)]);
    assert.equal((await database.findUserByGithubLogin("COMPARTIDO"))?.id, student.user.id);
    await database.pool.query(`update github_user_tokens set updated_at = $2 where user_id = $1`, [teacher.user.id, new Date(Date.now() + 60_000)]);
    assert.equal((await database.findUserByGithubLogin("compartido"))?.id, teacher.user.id);
    assert.equal(await database.findUserByGithubLogin("nadie"), null);
    assert.equal(await database.findUserByGithubLogin(""), null);
  } finally {
    await database.close();
  }
});

test("canje con GitHub: el limitador cuenta los fallos por IP", async () => {
  const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
  let now = 9_000_000;
  const clock = () => now;
  const started = await startEditorApp({ fetch: fetchImpl, githubLimiter: createAttemptLimiter({ now: clock }), now: clock });
  try {
    for (let index = 0; index < 20; index += 1) {
      const result = await call(started.baseUrl, "POST", "/api/auth/editor/github", { body: { githubToken: `gho_malo_${index}` } });
      assert.equal(result.status, 401);
    }
    const blocked = await call(started.baseUrl, "POST", "/api/auth/editor/github", { body: { githubToken: "gho_otro" } });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.data.error, "too_many_attempts");
    // El canje con codigo tiene su propio cupo.
    const claim = await call(started.baseUrl, "POST", "/api/auth/editor/claim", { body: { code: "ZZZZ-ZZZZ" } });
    assert.equal(claim.status, 404);
    now += 61_000;
    const later = await call(started.baseUrl, "POST", "/api/auth/editor/github", { body: { githubToken: "gho_otro" } });
    assert.equal(later.status, 401);
  } finally {
    await stop(started);
  }
});

test("canje con GitHub: login sin vincular no gasta el cupo de la IP del laboratorio", async () => {
  // Todos los tokens son validos pero de cuentas que no conectaron GitHub en ADACEEN.
  const fetchImpl: FetchLike = async (_url, init) => {
    const token = (new Headers(init?.headers).get("authorization") || "").replace(/^Bearer /, "");
    const login = token === "gho_vinculado" ? "Estudiante-GH" : `sin-vincular-${token.slice(-2)}`;
    return new Response(JSON.stringify({ login }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  let now = 7_000_000;
  const clock = () => now;
  const started = await startEditorApp({ fetch: fetchImpl, githubLimiter: createAttemptLimiter({ now: clock }), now: clock });
  try {
    const student = await started.database.authenticateUser(STUDENT.email, STUDENT.password);
    assert.ok(student);
    await started.database.upsertGithubUserToken({ userId: student.user.id, accountLogin: "Estudiante-GH", accessToken: "gho_oauth" });
    const lab = { "x-forwarded-for": "190.1.2.3" };
    for (let index = 10; index < 40; index += 1) {
      const result = await call(started.baseUrl, "POST", "/api/auth/editor/github", { body: { githubToken: `gho_${index}` }, headers: lab });
      assert.equal(result.status, 404);
      assert.equal(result.data.error, "github_login_not_linked");
    }
    const linked = await call(started.baseUrl, "POST", "/api/auth/editor/github", { body: { githubToken: "gho_vinculado" }, headers: lab });
    assert.equal(linked.status, 200, "30 cuentas sin vincular desde la misma IP no bloquean a la siguiente");
  } finally {
    await stop(started);
  }
});

test("canje con GitHub: docentes y administradores no reciben sesion (se vinculan con el codigo del navegador)", async () => {
  const fetchImpl: FetchLike = async () =>
    new Response(JSON.stringify({ login: "Docente-GH" }), { status: 200, headers: { "Content-Type": "application/json" } });
  const started = await startEditorApp({ fetch: fetchImpl });
  try {
    const teacher = await started.database.authenticateUser(TEACHER.email, TEACHER.password);
    assert.ok(teacher);
    await started.database.upsertGithubUserToken({ userId: teacher.user.id, accountLogin: "Docente-GH", accessToken: "gho_oauth_docente" });
    const before = (await started.database.pool.query(`select count(*)::int as n from app_sessions where kind = 'editor'`)).rows[0].n;

    const refused = await call(started.baseUrl, "POST", "/api/auth/editor/github", { body: { githubToken: "gho_de_otra_app" } });
    assert.equal(refused.status, 404);
    assert.equal(refused.data.error, "github_login_not_linked", "la extension 0.0.31 ya muestra este error con su message");
    assert.equal(refused.data.reason, "staff_requires_code");
    assert.equal(refused.data.message, STAFF_REQUIRES_CODE_MESSAGE);
    assert.equal(refused.data.sessionId, undefined);
    const after = (await started.database.pool.query(`select count(*)::int as n from app_sessions where kind = 'editor'`)).rows[0].n;
    assert.equal(after, before, "no se crea ninguna sesion editor");

    // El codigo del navegador sigue sirviendo para el docente.
    const browser = await login(started.baseUrl, TEACHER);
    const issued = await call(started.baseUrl, "POST", "/api/auth/editor/pairing-code", { sessionId: String(browser.session?.id) });
    assert.equal(issued.status, 200);
    const claimed = await call(started.baseUrl, "POST", "/api/auth/editor/claim", { body: { code: issued.data.code } });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.data.user?.role, "teacher");
  } finally {
    await stop(started);
  }
});

test("el docente no ve ids de sesion de sus estudiantes (eventos ni telemetria de intervenciones)", async () => {
  const started = await startFullApp();
  const { baseUrl, database } = started;
  try {
    // El estudiante vincula VS Code con un codigo y VS Code manda un evento con esa sesion editor.
    const browser = await login(baseUrl, STUDENT);
    const issued = await call(baseUrl, "POST", "/api/auth/editor/pairing-code", { sessionId: String(browser.session?.id) });
    const claimed = await call(baseUrl, "POST", "/api/auth/editor/claim", { body: { code: issued.data.code } });
    const editorId = String(claimed.data.sessionId);
    assert.ok(editorId);
    const event = await call(baseUrl, "POST", "/api/behavior/events", {
      sessionId: editorId,
      body: { events: [{ source: "vscode_extension", category: "cursor_idle", eventType: "cursor_idle_5s_detected", durationMs: 5000 }] },
    });
    assert.equal(event.status, 200);
    const studentId = String(claimed.data.user?.id);
    await database.recordTelemetry({
      sessionId: editorId,
      studentUserId: studentId,
      teacherUserId: "user-teacher-demo",
      eventType: "cursor_idle_5s",
      interventionType: "hint",
      detailLevel: "low",
      policyName: "prueba",
      exerciseKey: null,
      blocked: false,
      reason: "prueba",
      contextSummary: "prueba",
      policySnapshot: {},
    });

    const teacher = await login(baseUrl, TEACHER);
    const teacherId = String(teacher.session?.id);
    const events = await call(baseUrl, "GET", `/api/behavior/events?userId=${encodeURIComponent(studentId)}`, { sessionId: teacherId });
    assert.equal(events.status, 200);
    const items = (events.data as { items?: Array<{ sessionId?: unknown; eventType?: string }> }).items || [];
    assert.ok(items.some((item) => item.eventType === "cursor_idle_5s_detected"), "el docente sigue viendo los eventos");
    assert.ok(items.every((item) => item.sessionId === null));
    assert.doesNotMatch(JSON.stringify(events.data), new RegExp(editorId));

    const me = await call(baseUrl, "GET", "/api/auth/me", { sessionId: teacherId });
    const telemetry = (me.data as { telemetry?: unknown[] }).telemetry || [];
    assert.ok(telemetry.length >= 1, "la telemetria de intervenciones sigue llegando al docente");
    assert.doesNotMatch(JSON.stringify(me.data), new RegExp(editorId));
    const relogin = await login(baseUrl, TEACHER);
    assert.doesNotMatch(JSON.stringify(relogin), new RegExp(editorId));
  } finally {
    await stop(started);
  }
});
