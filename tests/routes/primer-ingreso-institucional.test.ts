import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import pg from "pg";
import { OAuth2Client } from "google-auth-library";
import { createApp } from "../../src/app.js";
import { env } from "../../src/config/env.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { resetStudentCodeAttemptsForTests } from "../../src/routes/auth-routes.js";
import { resolveExamPreset } from "../../src/services/exam-preset.js";

/**
 * Prueba del 28-10-2026 (examen): alguien que ya esta en la base (importado por la lista o creado
 * por el docente) y llega por PRIMERA vez a la extension con su correo institucional de Google.
 * Corre contra PostgreSQL real (PG_ADMIN_URL), una base nueva por caso, con el mismo flujo que la
 * extension 0.8.5: POST /api/auth/google-login sin studentCode; el codigo solo se manda si el
 * backend devuelve step "student_code".
 *
 * Solo corre con PG_ADMIN_URL (conexion de administrador, por ejemplo
 * postgresql://postgres@127.0.0.1:5432/postgres); sin ella se omite (CI usa pg-mem):
 *   PG_ADMIN_URL=... node --import tsx --test tests/routes/primer-ingreso-institucional.test.ts
 */

const PG_ADMIN_URL = process.env.PG_ADMIN_URL || "";
const omitir = PG_ADMIN_URL ? false : "sin PG_ADMIN_URL (necesita PostgreSQL real)";
let dbCounter = 0;

type AuthReply = {
  ok: boolean;
  step?: string;
  error?: string;
  maskedEmail?: string;
  firstLogin?: boolean;
  session?: { id: string; user: { id: string; email: string; role: string; teacherUserId?: string | null } };
  user?: { id: string; email: string; role: string };
};

async function freshDatabaseUrl() {
  const name = `primer_ingreso_${process.pid}_${++dbCounter}`;
  const admin = new pg.Client({ connectionString: PG_ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();
  return PG_ADMIN_URL.replace(/\/[^/]*$/, `/${name}`);
}

const previousDb = { url: env.databaseUrl, ssl: env.databaseSslMode };

async function startServer() {
  resetStudentCodeAttemptsForTests();
  env.databaseUrl = await freshDatabaseUrl();
  env.databaseSslMode = "disable";
  const database = await createDatabase();
  assert.equal((database as unknown as { provider: string }).provider, "postgres", "la prueba corre en PostgreSQL real");
  const app = createApp(database);
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("sin puerto");
  return { database, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server, database: AppDatabase) {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await database.close();
  env.databaseUrl = previousDb.url;
  env.databaseSslMode = previousDb.ssl;
}

async function call<T>(baseUrl: string, method: string, route: string, options: { sessionId?: string; body?: unknown } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(options.sessionId ? { "x-session-id": options.sessionId } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, data: (await response.json()) as T };
}

/** Google simulado (igual que student-code-routes.test.ts): el token dice con que correo llega. */
function simulateGoogle(baseUrl: string) {
  const previous = { clientId: env.googleClientId, password: env.googleDefaultPassword, domain: env.googleAllowedHostedDomain };
  const originalTokenInfo = OAuth2Client.prototype.getTokenInfo;
  const originalFetch = globalThis.fetch;
  env.googleClientId = "cliente-google-de-prueba.apps.googleusercontent.com";
  env.googleDefaultPassword = "ClaveGoogle123!";
  env.googleAllowedHostedDomain = "";
  let currentEmail = "";
  OAuth2Client.prototype.getTokenInfo = async function () {
    return { aud: env.googleClientId, email: currentEmail, email_verified: true } as unknown as Awaited<ReturnType<OAuth2Client["getTokenInfo"]>>;
  };
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input).startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
      return new Response(JSON.stringify({ email: currentEmail, email_verified: true, name: `Nombre Google ${currentEmail.split("@")[0]}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  /** Como la extension: primero sin codigo; con codigo solo si se lo piden. */
  const google = (email: string, extra: { studentCode?: string } = {}) => {
    currentEmail = email;
    return call<AuthReply>(baseUrl, "POST", "/api/auth/google-login", {
      body: { accessToken: `token-google-${email}-0000000000`, ...(extra.studentCode === undefined ? {} : { studentCode: extra.studentCode }) },
    });
  };
  const restore = () => {
    globalThis.fetch = originalFetch;
    OAuth2Client.prototype.getTokenInfo = originalTokenInfo;
    env.googleClientId = previous.clientId;
    env.googleDefaultPassword = previous.password;
    env.googleAllowedHostedDomain = previous.domain;
  };
  return { google, restore };
}

/** Escenario del examen: Victor es el docente de las cuentas nuevas y tiene el tema fijado. */
async function examSetup(database: AppDatabase, baseUrl: string) {
  const admin = await database.authenticateUser("admin@adaceen.edu.co", "Admin123!");
  assert.ok(admin);
  const victor = await database.createManagedUser({
    role: "teacher",
    email: "victor.bucheli@correounivalle.edu.co",
    displayName: "Victor Bucheli",
    password: "Docente-Piloto-1",
  });
  const chosen = await call<{ ok: boolean; error?: string }>(baseUrl, "PUT", "/api/admin/default-teacher", { sessionId: admin.id, body: { teacherUserId: victor.id } });
  assert.equal(chosen.status, 200, chosen.data.error);
  const preset = resolveExamPreset();
  assert.ok(preset);
  await database.pool.query(`delete from app_settings where setting_key = $1`, [preset.settingKey]);
  await database.syncExamPreset(preset);
  return { adminSession: admin.id, victor };
}

async function importList(baseUrl: string, adminSession: string, teacherUserId: string, students: Array<{ email: string; displayName: string; studentCode?: string }>) {
  const reply = await call<{ ok: boolean; error?: string; created: Array<{ id: string; email: string }> }>(baseUrl, "POST", "/api/admin/users/import", {
    sessionId: adminSession,
    body: { teacherUserId, courseCode: "FPOO", students },
  });
  assert.equal(reply.status, 200, reply.data.error);
  return reply.data.created;
}

async function studentCount(database: AppDatabase) {
  const result = await database.pool.query<{ n: string }>(`select count(*)::text as n from users where role_id = 'role-student'`);
  return Number(result.rows[0].n);
}

async function userRow(database: AppDatabase, id: string) {
  const result = await database.pool.query<{ email: string; teacher_user_id: string | null; is_active: boolean; display_name: string }>(
    `select email, teacher_user_id, is_active, display_name from users where id = $1`,
    [id],
  );
  return result.rows[0];
}

/** Lo que hace el estudiante despues de entrar: me, tema del examen y codigo para VS Code. */
async function checkUsableSession(baseUrl: string, sessionId: string, expectedUserId: string) {
  const me = await call<AuthReply>(baseUrl, "GET", "/api/auth/me", { sessionId });
  assert.equal(me.status, 200, "la sesion sirve en /api/auth/me");
  const topic = await call<{ ok: boolean; topic: { title?: string; repoFullName?: string } | null }>(baseUrl, "GET", "/api/pilot/topic", { sessionId });
  assert.equal(topic.status, 200);
  assert.match(String(topic.data.topic?.title), /Sistema bancario/, "Inicio muestra el parcial");
  assert.equal(topic.data.topic?.repoFullName, "eydersantiago/sistema-bancario-fpoo");
  const pairing = await call<{ ok: boolean; code?: string; error?: string }>(baseUrl, "POST", "/api/auth/editor/pairing-code", { sessionId });
  assert.equal(pairing.status, 200, `pide el codigo de VS Code: ${pairing.data.error}`);
  const claimed = await call<{ ok: boolean; user?: { id: string }; error?: string }>(baseUrl, "POST", "/api/auth/editor/claim", {
    body: { code: pairing.data.code, editorHost: "local", label: "vscode-local" },
  });
  assert.equal(claimed.status, 200, `VS Code entra con el codigo: ${claimed.data.error}`);
  assert.equal(claimed.data.user?.id, expectedUserId, "VS Code queda en la misma cuenta");
}

test("1. importado por la lista con correo institucional y SIN codigo: entra directo a su cuenta", { skip: omitir }, async () => {
  const { server, database, baseUrl } = await startServer();
  const { google, restore } = simulateGoogle(baseUrl);
  try {
    const { adminSession, victor } = await examSetup(database, baseUrl);
    const [imported] = await importList(baseUrl, adminSession, victor.id, [{ email: "laura.gomez@correounivalle.edu.co", displayName: "Laura Gómez" }]);
    const before = await studentCount(database);

    const first = await google("laura.gomez@correounivalle.edu.co");
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.ok, true);
    assert.equal(first.data.step, undefined, "no pide el codigo");
    assert.equal(first.data.firstLogin, true, "es su primer ingreso");
    assert.equal(first.data.session?.user.id, imported.id, "entra a la cuenta importada (mismo user_id)");
    assert.equal(await studentCount(database), before, "no crea otra cuenta");
    const row = await userRow(database, imported.id);
    assert.equal(row.teacher_user_id, victor.id, "sigue con el docente de la lista");
    assert.equal(row.display_name, "Laura Gómez", "conserva el nombre de la lista");
    await checkUsableSession(baseUrl, String(first.data.session?.id), imported.id);

    const again = await google("laura.gomez@correounivalle.edu.co");
    assert.equal(again.data.session?.user.id, imported.id);
    assert.equal(again.data.firstLogin, false);
  } finally {
    restore();
    await stopServer(server, database);
  }
});

test("2. importado con el codigo de «Participantes» (2312345-3743): entra directo, sin volver a pedirlo", { skip: omitir }, async () => {
  const { server, database, baseUrl } = await startServer();
  const { google, restore } = simulateGoogle(baseUrl);
  try {
    const { adminSession, victor } = await examSetup(database, baseUrl);
    const [imported] = await importList(baseUrl, adminSession, victor.id, [{ email: "mateo.ruiz@correounivalle.edu.co", displayName: "Mateo Ruiz", studentCode: "2312345-3743" }]);
    const before = await studentCount(database);
    const first = await google("mateo.ruiz@correounivalle.edu.co");
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.step, undefined);
    assert.equal(first.data.session?.user.id, imported.id);
    assert.equal(await studentCount(database), before);
    assert.equal(await database.getStudentCodeForUser(imported.id), "2312345", "conserva el codigo");
    await checkUsableSession(baseUrl, String(first.data.session?.id), imported.id);
  } finally {
    restore();
    await stopServer(server, database);
  }
});

test("3. Google entrega el correo con mayusculas: llega a la misma cuenta", { skip: omitir }, async () => {
  const { server, database, baseUrl } = await startServer();
  const { google, restore } = simulateGoogle(baseUrl);
  try {
    const { adminSession, victor } = await examSetup(database, baseUrl);
    const [imported] = await importList(baseUrl, adminSession, victor.id, [{ email: "Sofia.Lopez@CorreoUnivalle.edu.co", displayName: "Sofía López" }]);
    const before = await studentCount(database);
    const first = await google("SOFIA.LOPEZ@correounivalle.edu.co");
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.session?.user.id, imported.id);
    assert.equal(await studentCount(database), before);
  } finally {
    restore();
    await stopServer(server, database);
  }
});

test("4. creado a mano por el docente en «Usuarios» con correo institucional: entra directo", { skip: omitir }, async () => {
  const { server, database, baseUrl } = await startServer();
  const { google, restore } = simulateGoogle(baseUrl);
  try {
    const { victor } = await examSetup(database, baseUrl);
    const teacher = await database.authenticateUser("victor.bucheli@correounivalle.edu.co", "Docente-Piloto-1");
    assert.ok(teacher);
    const created = await call<{ ok: boolean; user?: { id: string }; error?: string }>(baseUrl, "POST", "/api/admin/users", {
      sessionId: teacher.id,
      body: { role: "student", email: "camilo.vera@correounivalle.edu.co", displayName: "Camilo Vera", password: "Temporal-12345" },
    });
    assert.equal(created.status, 200, created.data.error);
    const userId = String(created.data.user?.id);
    const before = await studentCount(database);
    const first = await google("camilo.vera@correounivalle.edu.co");
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.session?.user.id, userId);
    assert.equal(await studentCount(database), before);
    assert.equal((await userRow(database, userId)).teacher_user_id, victor.id);
    await checkUsableSession(baseUrl, String(first.data.session?.id), userId);
  } finally {
    restore();
    await stopServer(server, database);
  }
});

test("5. cuenta de la lista desactivada: no entra y no se crea otra", { skip: omitir }, async () => {
  const { server, database, baseUrl } = await startServer();
  const { google, restore } = simulateGoogle(baseUrl);
  try {
    const { adminSession, victor } = await examSetup(database, baseUrl);
    const [imported] = await importList(baseUrl, adminSession, victor.id, [{ email: "pedro.mora@correounivalle.edu.co", displayName: "Pedro Mora" }]);
    await database.pool.query(`update users set is_active = false where id = $1`, [imported.id]);
    const before = await studentCount(database);
    const first = await google("pedro.mora@correounivalle.edu.co");
    assert.notEqual(first.status, 200);
    assert.equal(first.data.session, undefined);
    assert.equal(await studentCount(database), before);
    console.log(`   [5] respuesta: ${first.status} ${JSON.stringify(first.data)}`);
  } finally {
    restore();
    await stopServer(server, database);
  }
});

test("6. importado con su Gmail (Campus) y llega con el institucional: ¿misma cuenta?", { skip: omitir }, async () => {
  const { server, database, baseUrl } = await startServer();
  const { google, restore } = simulateGoogle(baseUrl);
  try {
    const { adminSession, victor } = await examSetup(database, baseUrl);
    const [withCode, withoutCode] = await importList(baseUrl, adminSession, victor.id, [
      { email: "valen.rios92@gmail.com", displayName: "Valentina Ríos", studentCode: "2398765" },
      { email: "juanes.paz@hotmail.com", displayName: "Juan Esteban Paz" },
    ]);
    const before = await studentCount(database);

    const a = await google("valentina.rios@correounivalle.edu.co");
    const b = await google("juan.paz@correounivalle.edu.co");
    const after = await studentCount(database);
    console.log(`   [6a] Gmail+codigo en la lista -> institucional: status ${a.status}, step ${a.data.step}, user ${a.data.session?.user.id === withCode.id ? "MISMA cuenta" : "OTRA cuenta"}`);
    console.log(`   [6b] Hotmail sin codigo en la lista -> institucional: status ${b.status}, step ${b.data.step}, user ${b.data.session?.user.id === withoutCode.id ? "MISMA cuenta" : "OTRA cuenta"}`);
    console.log(`   [6] estudiantes antes ${before}, despues ${after}`);
    const newRows = await database.pool.query<{ email: string; teacher_user_id: string }>(
      `select email, teacher_user_id from users where email in ('valentina.rios@correounivalle.edu.co','juan.paz@correounivalle.edu.co')`,
    );
    for (const row of newRows.rows) console.log(`   [6] cuenta nueva ${row.email} con docente ${row.teacher_user_id === victor.id ? "Victor" : row.teacher_user_id}`);

    // Si escribiera el codigo en su primer ingreso (la extension no se lo pide), se uniria a la de la lista:
    await database.pool.query(`delete from app_sessions where user_id in (select id from users where email = 'valentina.rios@correounivalle.edu.co')`);
    await database.pool.query(`delete from user_course_assignments where user_id in (select id from users where email = 'valentina.rios@correounivalle.edu.co')`);
    await database.pool.query(`delete from users where email = 'valentina.rios@correounivalle.edu.co'`);
    const typed = await google("valentina.rios@correounivalle.edu.co", { studentCode: "2398765" });
    console.log(`   [6c] institucional + codigo escrito: status ${typed.status}, user ${typed.data.session?.user.id === withCode.id ? "MISMA cuenta" : "OTRA cuenta"}`);
  } finally {
    restore();
    await stopServer(server, database);
  }
});

test("7. esta en la lista con el institucional pero entra primero con su Gmail", { skip: omitir }, async () => {
  const { server, database, baseUrl } = await startServer();
  const { google, restore } = simulateGoogle(baseUrl);
  try {
    const { adminSession, victor } = await examSetup(database, baseUrl);
    const [coded, plain] = await importList(baseUrl, adminSession, victor.id, [
      { email: "ana.mejia@correounivalle.edu.co", displayName: "Ana Mejía", studentCode: "2311111" },
      { email: "luis.cano@correounivalle.edu.co", displayName: "Luis Cano" },
    ]);
    const before = await studentCount(database);

    const a1 = await google("ana.mejia.personal@gmail.com");
    const a2 = await google("ana.mejia.personal@gmail.com", { studentCode: "2311111" });
    console.log(`   [7a] lista con codigo; Gmail sin codigo -> ${a1.status} step ${a1.data.step}; Gmail + su codigo -> ${a2.status} step ${a2.data.step}${a2.data.session?.user.id === coded.id ? " (MISMA cuenta)" : ""}`);
    const a3 = await google("ana.mejia@correounivalle.edu.co");
    console.log(`   [7a] luego con el institucional -> ${a3.status}, ${a3.data.session?.user.id === coded.id ? "MISMA cuenta" : "OTRA cuenta"}`);

    const b1 = await google("luis.cano.personal@gmail.com", { studentCode: "2322222" });
    console.log(`   [7b] lista SIN codigo; Gmail + su codigo -> ${b1.status} step ${b1.data.step}, ${b1.data.session?.user.id === plain.id ? "MISMA cuenta" : b1.data.session ? "OTRA cuenta (nueva)" : "sin sesion"}`);
    const b2 = await google("luis.cano@correounivalle.edu.co");
    console.log(`   [7b] luego con el institucional -> ${b2.status}, ${b2.data.session?.user.id === plain.id ? "cuenta de la lista" : "otra"}`);
    console.log(`   [7] estudiantes antes ${before}, despues ${await studentCount(database)}`);
  } finally {
    restore();
    await stopServer(server, database);
  }
});
