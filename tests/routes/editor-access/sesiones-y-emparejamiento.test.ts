import assert from "node:assert/strict";
import test from "node:test";
import { createDatabase } from "../../../src/db/database.js";
import { SESSION_STATE_HEADER } from "../../../src/routes/route-utils.js";
import {
  createAttemptLimiter,
  generatePairingCode,
  hashPairingCode,
  normalizePairingCode,
  PAIRING_CODE_ALPHABET,
} from "../../../src/services/vscode/editor-pairing.js";
import { STUDENT, TEACHER, startFullApp, startEditorApp, stop, call, login, daysFromNow } from "./helpers.js";

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
