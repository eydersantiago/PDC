import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import express from "express";
import { env } from "../../src/config/env.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { hashPassword } from "../../src/db/rows.js";
import { registerHealthRoutes } from "../../src/routes/health-routes.js";
import { DEMO_ACCOUNTS, DEMO_ADMIN_KEPT_WARNING } from "../../src/services/demo-accounts.js";

/**
 * Cuentas demo fuera de produccion (SEED_DEMO_ACCOUNTS): con false seed() no siembra las
 * cuentas ni la politica demo (los roles si) y al arrancar desactiva las que existan; el
 * administrador demo solo si hay otro administrador activo. /api/health informa
 * demo_accounts_seeded y demo_accounts_active (deploy/produccion.sh verificar los comprueba).
 */

async function startHealthServer(database: AppDatabase) {
  const app = express();
  registerHealthRoutes(app, database);
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No se pudo iniciar servidor de prueba.");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function readHealth(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  return await response.json() as { demo_accounts_seeded: boolean; demo_accounts_active: number };
}

async function countRows(database: AppDatabase, table: string) {
  const result = await database.pool.query<{ count: string }>(`select count(*)::text as count from ${table}`);
  return Number(result.rows[0]?.count || 0);
}

async function canLogin(database: AppDatabase, account: { email: string; password: string }) {
  return Boolean(await database.authenticateUser(account.email, account.password, { kind: "cli" }));
}

// Captura console.info y console.warn mientras corre work.
async function capturingConsole<T>(work: () => Promise<T>) {
  const lines: string[] = [];
  const saved = { info: console.info, warn: console.warn };
  console.info = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    const result = await work();
    return { result, lines };
  } finally {
    Object.assign(console, saved);
  }
}

test("cuentas demo: con SEED_DEMO_ACCOUNTS=true (por defecto) se siembran y /api/health lo informa", async () => {
  const saved = env.seedDemoAccounts;
  env.seedDemoAccounts = true;
  const database = await createDatabase();
  const { server, baseUrl } = await startHealthServer(database);
  try {
    for (const account of DEMO_ACCOUNTS) {
      assert.equal(await canLogin(database, account), true, `${account.email} entra con la clave del repositorio`);
    }
    assert.equal(await countRows(database, "teacher_policies"), 1, "la politica demo se siembra");
    const health = await readHealth(baseUrl);
    assert.equal(health.demo_accounts_seeded, true);
    assert.equal(health.demo_accounts_active, 3);
  } finally {
    env.seedDemoAccounts = saved;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.close();
  }
});

test("cuentas demo: con SEED_DEMO_ACCOUNTS=false no se siembran (los roles si) y /api/health lo informa", async () => {
  const saved = env.seedDemoAccounts;
  env.seedDemoAccounts = false;
  const { result: database, lines } = await capturingConsole(() => createDatabase());
  const { server, baseUrl } = await startHealthServer(database);
  try {
    assert.equal(await countRows(database, "users"), 0, "ninguna cuenta demo");
    assert.equal(await countRows(database, "teacher_policies"), 0, "sin la politica demo");
    assert.equal(await countRows(database, "roles"), 3, "los roles si se siembran");
    for (const account of DEMO_ACCOUNTS) {
      assert.equal(await canLogin(database, account), false, `${account.email} no existe`);
    }
    assert.deepEqual(lines, [], "sin cuentas que desactivar no avisa nada");
    const health = await readHealth(baseUrl);
    assert.equal(health.demo_accounts_seeded, false);
    assert.equal(health.demo_accounts_active, 0);
  } finally {
    env.seedDemoAccounts = saved;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.close();
  }
});

test("cuentas demo: al arrancar con SEED_DEMO_ACCOUNTS=false se desactivan las que existian; el administrador demo solo si hay otro administrador", async () => {
  const saved = env.seedDemoAccounts;
  env.seedDemoAccounts = true;
  const database = await createDatabase();
  const { server, baseUrl } = await startHealthServer(database);
  try {
    const [admin, teacher, student] = DEMO_ACCOUNTS;
    const studentSession = await database.authenticateUser(student.email, student.password);
    assert.ok(studentSession);

    // Lo que hace el arranque con la base ya sembrada y SEED_DEMO_ACCOUNTS=false (pg-mem no deja
    // volver a correr initialize(), que es quien llama a syncDemoAccounts()).
    env.seedDemoAccounts = false;
    let { lines } = await capturingConsole(() => database.syncDemoAccounts());
    assert.equal(await canLogin(database, student), false, "el estudiante demo ya no entra");
    assert.equal(await canLogin(database, teacher), false, "el docente demo ya no entra");
    assert.equal(await database.getSession(studentSession.id), null, "la sesion del estudiante demo se cerro");
    assert.equal(await canLogin(database, admin), true, "el administrador demo se queda: es el unico administrador");
    assert.ok(lines.some((line) => /desactivadas al arrancar: docente@adaceen\.edu\.co, estudiante@adaceen\.edu\.co/.test(line)), lines.join("\n"));
    assert.ok(lines.includes(DEMO_ADMIN_KEPT_WARNING), lines.join("\n"));
    assert.match(DEMO_ADMIN_KEPT_WARNING, /unico administrador activo/);
    assert.match(DEMO_ADMIN_KEPT_WARNING, /npm run cuentas-demo -- --confirmar/);
    assert.match(DEMO_ADMIN_KEPT_WARNING, /Crea otro administrador/);
    let health = await readHealth(baseUrl);
    assert.equal(health.demo_accounts_seeded, false);
    assert.equal(health.demo_accounts_active, 1);

    // Un segundo arranque no vuelve a sembrarlas ni avisa dos veces de lo ya desactivado.
    ({ lines } = await capturingConsole(() => database.syncDemoAccounts()));
    assert.equal(await countRows(database, "users"), 3);
    assert.deepEqual(lines, [DEMO_ADMIN_KEPT_WARNING]);

    // Con otro administrador activo, el siguiente arranque desactiva tambien al administrador demo.
    await database.pool.query(
      `insert into users (id, role_id, teacher_user_id, email, display_name, password_hash)
       values ('user-admin-real', 'role-admin', null, 'admin.real@univalle.edu.co', 'Administradora', $1)`,
      [hashPassword("ClaveReal123!")],
    );
    ({ lines } = await capturingConsole(() => database.syncDemoAccounts()));
    assert.equal(await canLogin(database, admin), false, "el administrador demo ya no entra");
    assert.ok(await database.authenticateUser("admin.real@univalle.edu.co", "ClaveReal123!", { kind: "cli" }), "el otro administrador sigue entrando");
    assert.deepEqual(lines, ["[cuentas-demo] SEED_DEMO_ACCOUNTS=false: cuentas demo desactivadas al arrancar: admin@adaceen.edu.co."]);
    health = await readHealth(baseUrl);
    assert.equal(health.demo_accounts_active, 0);

    // Volver a true no reactiva nada: "on conflict do nothing" respeta lo desactivado.
    env.seedDemoAccounts = true;
    await database.syncDemoAccounts();
    assert.equal(await canLogin(database, student), false);
    assert.equal((await readHealth(baseUrl)).demo_accounts_active, 0);
  } finally {
    env.seedDemoAccounts = saved;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.close();
  }
});
