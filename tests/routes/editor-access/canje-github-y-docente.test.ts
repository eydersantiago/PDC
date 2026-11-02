import assert from "node:assert/strict";
import test from "node:test";
import { createDatabase } from "../../../src/db/database.js";
import { GITHUB_LOGIN_NOT_LINKED_MESSAGE, STAFF_REQUIRES_CODE_MESSAGE } from "../../../src/routes/auth/editor-auth-routes.js";
import { createAttemptLimiter } from "../../../src/services/vscode/editor-pairing.js";
import type { FetchLike } from "../../../src/services/workspace/workspace-config.js";
import { STUDENT, TEACHER, startFullApp, startEditorApp, stop, call, login, daysFromNow } from "./helpers.js";

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
