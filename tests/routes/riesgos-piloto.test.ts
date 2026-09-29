import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { createApp } from "../../src/app.js";
import { env } from "../../src/config/env.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { claimCodeActionForUser } from "../../src/routes/project-code-action-routes.js";
import { setTextModelOverrideForTests } from "../../src/services/agent-mode.js";
import { referenceModelOutput, TUTOR_SCENARIOS } from "../../src/services/tutor-scenarios.js";

/**
 * A12.12 · ADACEEN-155: los 7 riesgos de la revision tecnica del 27-sep, del lado del backend.
 * 1 transacciones reales, 2 cola de cambios con lease y complete idempotente, 3 la pestana que
 * se oculta no borra a la activa, 4 escaneo atado a la sesion del dueno y con tope, 5 CORS con
 * la lista de ADACEEN, 6 Idempotency-Key en /intervene. El 7 (botones) es del navegador.
 */

async function startTestServer() {
  const database = await createDatabase();
  const app = createApp(database);
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No se pudo iniciar servidor de prueba.");
  }
  return { database, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopTestServer(server: Server, database: AppDatabase) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await database.close();
}

async function login(baseUrl: string, email: string, password: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ email, password }),
  });
  const data = await response.json() as { session?: { id?: string }; error?: string };
  assert.equal(response.status, 200, data.error);
  return String(data.session?.id || "");
}

async function call<T = Record<string, unknown>>(
  baseUrl: string,
  method: string,
  route: string,
  sessionId: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" }),
      ...(sessionId ? { "x-session-id": sessionId } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: (text ? JSON.parse(text) : {}) as T, headers: response.headers };
}

type ActionReply = {
  ok: boolean;
  error?: string;
  alreadyCompleted?: boolean;
  leaseSeconds?: number;
  action: { id: string; status: string; leaseUntil: string | null; attempts: number; errorMessage: string } | null;
};

async function queueCodeAction(baseUrl: string, sessionId: string, title: string) {
  const reply = await call<ActionReply>(baseUrl, "POST", "/api/projects/code-actions", sessionId, {
    repoFullName: "eyder/lease",
    filePath: "src/main.cpp",
    actionType: "replace_selection",
    title,
    originalText: "int x = 0;",
    replacementText: "int x = 1;",
  });
  assert.equal(reply.status, 200, reply.data.error);
  return String(reply.data.action?.id);
}

test("A12.12-1: withTransaction manda begin, el trabajo y commit/rollback por la misma conexion", async () => {
  // pg-mem no implementa rollback, asi que se prueba la disciplina de conexiones con un pool falso:
  // el fallo del 27-sep era que pool.query("begin") y pool.query("commit") podian caer en
  // conexiones distintas.
  type Call = { client: number; sql: string };
  const calls: Call[] = [];
  const released: Array<{ client: number; error: unknown }> = [];
  let nextClient = 0;
  let failRollback = false;
  const fakePool = {
    async connect() {
      const id = ++nextClient;
      return {
        async query(sql: string) {
          calls.push({ client: id, sql: sql.trim() });
          if (sql.trim() === "rollback" && failRollback) throw new Error("conexion rota");
          return { rows: [], rowCount: 0 };
        },
        release(error?: unknown) {
          released.push({ client: id, error });
        },
      };
    },
    async query() {
      throw new Error("withTransaction no debe usar pool.query");
    },
  };
  const { DatabaseCore } = await import("../../src/db/repos/core.js");
  const core = new DatabaseCore(fakePool as never, "postgres");

  const result = await core.withTransaction(async (client) => {
    await client.query("insert into t values ('a')");
    await client.query("insert into t values ('b')");
    return "hecho";
  });
  assert.equal(result, "hecho");
  assert.deepEqual(calls.map((call) => `${call.client}:${call.sql}`), [
    "1:begin",
    "1:insert into t values ('a')",
    "1:insert into t values ('b')",
    "1:commit",
  ]);
  assert.deepEqual(released, [{ client: 1, error: undefined }]);

  calls.length = 0;
  await assert.rejects(core.withTransaction(async (client) => {
    await client.query("insert into t values ('c')");
    throw new Error("falla a mitad");
  }), /falla a mitad/);
  assert.deepEqual(calls.map((call) => `${call.client}:${call.sql}`), ["2:begin", "2:insert into t values ('c')", "2:rollback"]);
  assert.equal(released.at(-1)?.client, 2);
  assert.equal(released.at(-1)?.error, undefined);

  // Si el rollback falla, la conexion se descarta (release con el error) y se propaga el error original.
  failRollback = true;
  await assert.rejects(core.withTransaction(async () => {
    throw new Error("otra falla");
  }), /otra falla/);
  assert.match(String(released.at(-1)?.error), /conexion rota/);
});

test("A12.12-2: cola de cambios con lease, un reintento, vencimiento y complete idempotente", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    const sessionId = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");
    const consent = await call(baseUrl, "POST", "/api/projects/consent", sessionId, { canRead: true, canModify: true, canAnalyze: true });
    assert.equal(consent.status, 200);
    const studentUserId = (await database.pool.query<{ id: string }>(
      "select id from users where email = 'estudiante@adaceen.edu.co'",
    )).rows[0].id;

    // Reclamo con POST /claim: lease y primer intento.
    const firstId = await queueCodeAction(baseUrl, sessionId, "primero");
    const claimed = await call<ActionReply>(baseUrl, "POST", "/api/projects/code-actions/claim", sessionId, { repoFullName: "eyder/lease" });
    assert.equal(claimed.status, 200, claimed.data.error);
    assert.equal(claimed.data.action?.id, firstId);
    assert.equal(claimed.data.action?.status, "claimed");
    assert.equal(claimed.data.action?.attempts, 1);
    assert.equal(claimed.data.leaseSeconds, env.codeActionLeaseSeconds);
    const leaseMs = new Date(String(claimed.data.action?.leaseUntil)).getTime() - Date.now();
    assert.ok(leaseMs > (env.codeActionLeaseSeconds - 10) * 1000 && leaseMs <= env.codeActionLeaseSeconds * 1000, `lease de ${leaseMs} ms`);

    // Con el lease vigente nadie mas lo recibe.
    const busy = await call<ActionReply>(baseUrl, "POST", "/api/projects/code-actions/claim", sessionId, { repoFullName: "eyder/lease" });
    assert.equal(busy.data.action, null);

    // Lease vencido (VS Code se cerro): vuelve a la cola una vez y se reclama de nuevo.
    const afterLease = new Date(Date.now() + (env.codeActionLeaseSeconds + 5) * 1000);
    const retried = await claimCodeActionForUser(database, {
      userId: studentUserId,
      repoFullName: "eyder/lease",
      workerInstance: "vscode-prueba",
      now: afterLease,
    });
    assert.equal(retried?.id, firstId);
    assert.equal(Number(retried?.attempts), 2);

    // Segundo lease vencido: ya no vuelve, vence con el motivo.
    const afterSecondLease = new Date(afterLease.getTime() + (env.codeActionLeaseSeconds + 5) * 1000);
    const none = await claimCodeActionForUser(database, {
      userId: studentUserId,
      repoFullName: "eyder/lease",
      workerInstance: "vscode-prueba",
      now: afterSecondLease,
    });
    assert.equal(none, null);
    const expired = await database.pool.query<{ status: string; error_message: string }>(
      "select status, error_message from project_code_actions where id = $1",
      [firstId],
    );
    assert.equal(expired.rows[0].status, "expired");
    assert.match(expired.rows[0].error_message, /no confirmo/);

    // complete es idempotente: repetirlo no es un error ni cambia el resultado.
    const secondId = await queueCodeAction(baseUrl, sessionId, "segundo");
    const legacyClaim = await call<ActionReply>(baseUrl, "GET", "/api/projects/code-actions/next?repoFullName=eyder/lease", sessionId);
    assert.equal(legacyClaim.data.action?.id, secondId, "GET /next (VS Code 0.0.32) reclama con el mismo lease");
    assert.ok(legacyClaim.data.action?.leaseUntil);
    const done = await call<ActionReply>(baseUrl, "POST", `/api/projects/code-actions/${secondId}/complete`, sessionId, { metadata: { line: 3 } });
    assert.equal(done.status, 200, done.data.error);
    assert.equal(done.data.action?.status, "completed");
    assert.equal(done.data.action?.leaseUntil, null);
    const again = await call<ActionReply>(baseUrl, "POST", `/api/projects/code-actions/${secondId}/complete`, sessionId, { metadata: { line: 3 } });
    assert.equal(again.status, 200);
    assert.equal(again.data.alreadyCompleted, true);
    const unknown = await call<ActionReply>(baseUrl, "POST", "/api/projects/code-actions/no-existe/complete", sessionId, { metadata: {} });
    assert.equal(unknown.status, 404);

    // Un cambio que espero mas que el TTL vence al reclamar en vez de aplicarse tarde.
    const staleId = await queueCodeAction(baseUrl, sessionId, "viejo");
    const muchLater = new Date(Date.now() + (env.codeActionPendingTtlMinutes + 1) * 60 * 1000);
    const stale = await claimCodeActionForUser(database, {
      userId: studentUserId,
      repoFullName: "eyder/lease",
      workerInstance: "vscode-prueba",
      now: muchLater,
    });
    assert.equal(stale, null);
    const staleRow = await database.pool.query<{ status: string }>("select status from project_code_actions where id = $1", [staleId]);
    assert.equal(staleRow.rows[0].status, "expired");
  } finally {
    await stopTestServer(server, database);
  }
});

test("A12.12-3: la pestana que se oculta no apaga a la que tomo el foco", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    const sessionId = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");
    const report = (tabId: string, isActive: boolean) => call(baseUrl, "POST", "/api/ui/active-tab", sessionId, {
      isActive,
      tabId,
      tabUrl: `https://github.com/eyder/demo?${tabId}`,
      tabTitle: tabId,
      viewContext: "github",
    });

    assert.equal((await report("pestana-a", true)).status, 200);
    assert.equal((await report("pestana-b", true)).status, 200);
    const hidden = await report("pestana-a", false);
    assert.equal(hidden.status, 200);

    const state = await call<{ activeTab: { tabId: string; isActive: boolean } }>(baseUrl, "GET", "/api/ui/active-tab", sessionId);
    assert.equal(state.data.activeTab.tabId, "pestana-b");
    assert.equal(state.data.activeTab.isActive, true, "la pestana B sigue activa");

    // La activa si se apaga cuando es ella la que se oculta.
    await report("pestana-b", false);
    const after = await call<{ activeTab: { tabId: string; isActive: boolean } }>(baseUrl, "GET", "/api/ui/active-tab", sessionId);
    assert.equal(after.data.activeTab.isActive, false);
  } finally {
    await stopTestServer(server, database);
  }
});

test("A12.12-4: el escaneo solo lo reclama y lo envia el VS Code del mismo estudiante, con tope", async () => {
  const scansDir = mkdtempSync(path.join(tmpdir(), "adaceen-escaneos-"));
  const saved = { projectScansDir: env.projectScansDir, scanMaxTotalBytes: env.scanMaxTotalBytes, scanWorkerKey: env.scanWorkerKey };
  Object.assign(env, { projectScansDir: scansDir, scanWorkerKey: "" });
  const { server, database, baseUrl } = await startTestServer();
  try {
    const student = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");
    const teacher = await login(baseUrl, "docente@adaceen.edu.co", "Docente123!");
    const created = await call<{ request: { id: string } }>(baseUrl, "POST", "/api/projects/scan/request", student, { repoFullName: "eyder/escaneo" });
    assert.equal(created.status, 200);
    const requestId = created.data.request.id;
    const next = "/api/projects/scan/request/next?repoFullName=eyder/escaneo";

    // Sin sesion (VS Code 0.0.32 o cualquiera con el nombre del repo): no recibe la solicitud.
    const anonymous = await call<{ request: unknown; needsSession?: boolean }>(baseUrl, "GET", next, "");
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.data.request, null);
    assert.equal(anonymous.data.needsSession, true);

    // Otro usuario con sesion tampoco.
    const other = await call<{ request: unknown }>(baseUrl, "GET", next, teacher);
    assert.equal(other.data.request, null);

    // El VS Code del estudiante si.
    const own = await call<{ request: { id: string; status: string } }>(baseUrl, "GET", next, student);
    assert.equal(own.data.request?.id, requestId);
    assert.equal(own.data.request?.status, "claimed");

    const payload = (content: string) => ({
      repoFullName: "eyder/escaneo",
      totalFiles: 1,
      files: [{ path: "src/main.cpp", bytes: Buffer.byteLength(content), lines: 1, content }],
    });
    const route = `/api/projects/scan/request/${requestId}/result`;
    assert.equal((await call(baseUrl, "POST", route, "", payload("int main(){}"))).status, 401, "sin sesion");
    assert.equal((await call(baseUrl, "POST", route, teacher, payload("int main(){}"))).status, 403, "de otro usuario");

    env.scanMaxTotalBytes = 64;
    const tooBig = await call<{ error: string }>(baseUrl, "POST", route, student, payload("x".repeat(65)));
    assert.equal(tooBig.status, 413, tooBig.data.error);
    env.scanMaxTotalBytes = saved.scanMaxTotalBytes;

    const stored = await call<{ ok: boolean; snapshotId: string; error?: string }>(baseUrl, "POST", route, student, payload("int main(){ return 0; }"));
    assert.equal(stored.status, 200, stored.data.error);
    assert.ok(stored.data.snapshotId);
    const snapshotFiles = await database.pool.query<{ count: string }>(
      "select count(*)::text as count from project_scan_snapshot_files where snapshot_id = $1",
      [stored.data.snapshotId],
    );
    assert.equal(snapshotFiles.rows[0].count, "1", "archivos guardados en la transaccion");

    // Reportar un fallo tambien exige la sesion del dueno.
    const second = await call<{ request: { id: string } }>(baseUrl, "POST", "/api/projects/scan/request", student, { repoFullName: "eyder/escaneo-2" });
    const failRoute = `/api/projects/scan/request/${second.data.request.id}/fail`;
    assert.equal((await call(baseUrl, "POST", failRoute, "", { error: "prueba" })).status, 401);
    assert.equal((await call(baseUrl, "POST", failRoute, teacher, { error: "prueba" })).status, 404);
    assert.equal((await call(baseUrl, "POST", failRoute, student, { error: "El estudiante no autorizo el escaneo." })).status, 200);
  } finally {
    Object.assign(env, saved);
    await stopTestServer(server, database);
    rmSync(scansDir, { recursive: true, force: true });
  }
});

test("A12.12-5: CORS sin ALLOWED_ORIGINS solo responde a los origenes de ADACEEN, sin error 500", async () => {
  const saved = env.allowedOrigins;
  env.allowedOrigins = [];
  const { server, database, baseUrl } = await startTestServer();
  try {
    const preflight = (origin: string) => fetch(`${baseUrl}/api/ui/active-tab`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-session-id,idempotency-key",
      },
    });

    const github = await preflight("https://github.com");
    assert.equal(github.headers.get("access-control-allow-origin"), "https://github.com");
    assert.match(String(github.headers.get("access-control-allow-headers")), /idempotency-key/i);

    const evil = await preflight("https://sitio-ajeno.example");
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
    assert.ok(evil.status < 500, `preflight de un origen ajeno respondio ${evil.status}`);

    const health = await fetch(`${baseUrl}/api/health`, { headers: { Origin: "https://sitio-ajeno.example" } });
    assert.equal(health.status, 200, "un origen ajeno no rompe la peticion");
    assert.equal(health.headers.get("access-control-allow-origin"), null);
    const body = await health.json() as { cors_mode: string };
    assert.equal(body.cors_mode, "default");
  } finally {
    env.allowedOrigins = saved;
    await stopTestServer(server, database);
  }
});

test("A12.12-6: /intervene con la misma Idempotency-Key no vuelve a llamar al modelo ni suma pistas", async () => {
  const { server, database, baseUrl } = await startTestServer();
  const prompts: string[] = [];
  setTextModelOverrideForTests(async (input) => {
    prompts.push(input);
    return referenceModelOutput(input);
  });
  try {
    const sessionId = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");
    const s1 = TUTOR_SCENARIOS[0].overlay;
    const context = { ...s1.context, activityTitle: "Taller idempotencia" };
    const ask = (key?: string) => call<{ help_stage: string; decision_id: string; idempotent_replay?: boolean }>(
      baseUrl,
      "POST",
      "/intervene",
      sessionId,
      { question: s1.question, context, max_items: 5 },
      key ? { "Idempotency-Key": key } : {},
    );

    const first = await ask("clave-prueba-0001");
    const promptsAfterFirst = prompts.length;
    const replay = await ask("clave-prueba-0001");
    assert.equal(replay.status, 200);
    assert.equal(replay.data.idempotent_replay, true);
    assert.equal(replay.data.decision_id, first.data.decision_id);
    assert.equal(replay.data.help_stage, "hint_1");
    assert.equal(prompts.length, promptsAfterFirst, "la repeticion no llamo al modelo");

    // Otra clave es otra peticion: avanza a la pista 2 (la repeticion no gasto cupo).
    const next = await ask("clave-prueba-0002");
    assert.equal(next.data.help_stage, "hint_2");
    assert.notEqual(next.data.decision_id, first.data.decision_id);
  } finally {
    setTextModelOverrideForTests(null);
    await stopTestServer(server, database);
  }
});
