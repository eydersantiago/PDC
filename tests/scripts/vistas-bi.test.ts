import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "pg";
import { env } from "../../src/config/env.js";
import { createDatabase } from "../../src/db/database.js";
import { recordWorkshopSnapshots, studentPseudonym } from "../../src/services/learning-analytics.js";
import { actorFromClientId, actorFromSession } from "../../src/services/telemetry.js";
import { saveProgressReport } from "../../src/services/workshop-progress.js";

/**
 * deploy/bi/crear-bi.sh y deploy/bi/vistas-bi.sql (29-10-2026) contra PostgreSQL real: las vistas
 * para Excel y Power BI solo traen estudiantes reales con su seudonimo, y el usuario de solo
 * lectura no ve las tablas de ADACEEN ni puede escribir.
 *
 * Solo corre con PG_ADMIN_URL (como tests/routes/primer-ingreso-institucional.test.ts) y psql:
 *   PG_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres node --import tsx --test tests/scripts/vistas-bi.test.ts
 */

const PG_ADMIN_URL = process.env.PG_ADMIN_URL || "";
const omitir = PG_ADMIN_URL ? false : "sin PG_ADMIN_URL (necesita PostgreSQL real y psql)";
const SCRIPT = path.resolve("deploy/bi/crear-bi.sh");

function bash(args: string[], extraEnv: Record<string, string>) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    execFile("bash", [SCRIPT, ...args], { env: { ...process.env, ...extraEnv }, timeout: 120_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as NodeJS.ErrnoException).code) || 1 : 0, out: `${stdout}${stderr}` });
    });
  });
}

test("vistas bi: solo estudiantes reales con seudonimo, y un usuario que solo lee bi", { skip: omitir }, async () => {
  const name = `vistas_bi_${process.pid}`;
  const role = `bi_prueba_${process.pid}`;
  const admin = new pg.Client({ connectionString: PG_ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const databaseUrl = PG_ADMIN_URL.replace(/\/[^/]*$/, `/${name}`);
  const previous = { url: env.databaseUrl, ssl: env.databaseSslMode };
  env.databaseUrl = databaseUrl;
  env.databaseSslMode = "disable";
  const folder = mkdtempSync(path.join(tmpdir(), "adaceen-bi-"));
  const credentials = path.join(folder, "credenciales.txt");
  const scriptEnv = { DATABASE_URL: databaseUrl, CREDENCIALES: credentials, USUARIO: role };
  const database = await createDatabase();
  try {
    const ana = await database.createManagedUser({ role: "student", email: "ana.bi@correounivalle.edu.co", displayName: "Ana Avanza", password: "Temporal-12345", teacherUserId: "user-teacher-demo" });
    await database.upsertGithubUserToken({ userId: ana.id, accountLogin: "ana-bi", accessToken: "gho_a" });
    await database.upsertGithubUserToken({ userId: "user-student-demo", accountLogin: "demo-bi", accessToken: "gho_d" });
    const points = [{ id: "clase", hu: "HU-1", texto: "Clase", peso: 40 }, { id: "compila", hu: "Programa", texto: "Compila", peso: 60 }];
    const entry = { login: "ana-bi", started: true, percent: 40, compiles: false, done: ["clase"], partial: [], missing: ["compila"], files: 2, outside: 0, lastChangeAt: null };
    for (const [generatedAt, students] of [
      ["2026-10-29T23:00:00.000Z", [entry, { ...entry, login: "demo-bi" }]],
      ["2026-10-30T01:00:00.000Z", [{ ...entry, percent: 100, compiles: true, done: ["clase", "compila"], missing: [] }]],
    ] as const) {
      const report = await saveProgressReport(database, { taller: "taller-bi", titulo: "Taller", generatedAt, points, students: students as any });
      await recordWorkshopSnapshots(database, report);
    }
    const asUser = (id: string, roleCode: string) => actorFromSession({ user: { id, role: roleCode, email: "", displayName: "", teacherUserId: "user-teacher-demo" } as any });
    const event = { source: "browser_extension", category: "tutor", eventType: "tutor_request_submitted", channel: "overlay" } as any;
    await database.insertTelemetryEvents([event], asUser(ana.id, "student"));
    await database.insertTelemetryEvents([event], asUser("user-student-demo", "student"));
    await database.insertTelemetryEvents([event], asUser("user-teacher-demo", "teacher"));
    await database.insertTelemetryEvents([{ ...event, source: "vscode_extension", category: "suggestion", eventType: "vscode_suggestion_shown" }], actorFromClientId("cliente-sin-sesion-1")!);

    const created = await bash([], scriptEnv);
    assert.equal(created.code, 0, created.out);
    assert.match(created.out, /usuario bi_prueba_\d+ creado/);
    assert.equal(statSync(credentials).mode & 0o777, 0o600, "las credenciales quedan con permisos 600");
    const password = /^Clave:\s+(\S+)/m.exec(readFileSync(credentials, "utf8"))?.[1] || "";
    assert.ok(password.length >= 24);
    assert.equal(created.out.includes(password), false, "la clave no sale en pantalla");

    const target = new URL(databaseUrl);
    target.username = role;
    target.password = password;
    const reader = new pg.Client({ connectionString: target.toString() });
    await reader.connect();
    try {
      const anaCode = studentPseudonym(ana.id);
      const events = await reader.query("select actor_anon_id, evento from eventos");
      assert.deepEqual(events.rows, [{ actor_anon_id: anaCode, evento: "tutor_request_submitted" }], "ni la demo, ni el docente, ni el cliente sin sesion");
      const progress = await reader.query("select porcentaje, compila from avance order by captured_at");
      assert.deepEqual(progress.rows, [{ porcentaje: 40, compila: false }, { porcentaje: 100, compila: true }]);
      assert.equal((await reader.query("select porcentaje from avance_actual")).rows[0].porcentaje, 100);
      assert.equal((await reader.query("select count(*)::int as n from avance_puntos")).rows[0].n, 4, "2 fotos x 2 puntos");
      assert.deepEqual((await reader.query("select punto, peso::int as peso from puntos order by punto")).rows, [{ punto: "clase", peso: 40 }, { punto: "compila", peso: 60 }]);
      const summary = (await reader.query("select * from estudiantes")).rows;
      assert.equal(summary.length, 1);
      assert.equal(summary[0].eventos_de_ayuda, "1");
      const personal = await reader.query("select column_name from information_schema.columns where table_schema = 'bi' and column_name ~* 'email|correo|nombre|name|login|codigo|user_id'");
      assert.deepEqual(personal.rows, [], "ninguna columna con datos personales");
      await assert.rejects(reader.query("select count(*) from public.users"), /permission denied/);
      await assert.rejects(reader.query("select count(*) from public.telemetry_events"), /permission denied/);
      await assert.rejects(reader.query("create table bi.otra (a int)"), /read-only/);
    } finally {
      await reader.end();
    }

    // Repetir no cambia la clave; quitar borra el usuario y las vistas, no los datos.
    const again = await bash([], scriptEnv);
    assert.equal(again.code, 0, again.out);
    assert.equal(/^Clave:\s+(\S+)/m.exec(readFileSync(credentials, "utf8"))?.[1], password);
    const removed = await bash(["quitar"], scriptEnv);
    assert.equal(removed.code, 0, removed.out);
    const check = new pg.Client({ connectionString: databaseUrl });
    await check.connect();
    try {
      assert.equal((await check.query("select count(*)::int as n from pg_roles where rolname = $1", [role])).rows[0].n, 0);
      assert.equal((await check.query("select to_regnamespace('bi') as s")).rows[0].s, null);
      assert.equal((await check.query("select count(*)::int as n from workshop_progress_snapshots")).rows[0].n, 2);
    } finally {
      await check.end();
    }
  } finally {
    await bash(["quitar"], scriptEnv).catch(() => null);
    await database.close();
    env.databaseUrl = previous.url;
    env.databaseSslMode = previous.ssl;
    rmSync(folder, { recursive: true, force: true });
    const cleanup = new pg.Client({ connectionString: PG_ADMIN_URL });
    await cleanup.connect();
    await cleanup.query(`drop database if exists ${name}`).catch(() => null);
    await cleanup.end();
  }
});
