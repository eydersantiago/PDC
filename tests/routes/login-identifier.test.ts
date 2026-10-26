import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { createApp } from "../../src/app.js";
import { env } from "../../src/config/env.js";
import { createDatabase } from "../../src/db/database.js";
import { DEMO_ACCOUNTS } from "../../src/services/demo-accounts.js";
import { DEMO_ROUTE_ACCOUNTS } from "../../src/services/demo-route-accounts.js";
import { LOCAL_ACCOUNTS_DOMAIN, loginEmailFromIdentifier } from "../../src/services/login-identifier.js";
import { TEST_ACCOUNTS } from "../../src/services/test-accounts.js";

/**
 * Usuario en lugar de correo (src/services/login-identifier.ts): con clave se entra escribiendo solo
 * «demo.a.e1» o «demo.b.docente», y el servidor completa @adaceen.edu.co. Sirve con la extension de
 * la tienda, que manda lo escrito tal cual.
 */

const PASSWORD = "clave-demo-rutas-larga";
const BEFORE_END = new Date("2026-11-01T12:00:00-05:00");

type AuthReply = { ok: boolean; error?: string; session?: { id?: string; user?: { email?: string; role?: string } } };

test("usuario sin @: completa el dominio de las cuentas con clave y deja igual lo demas", () => {
  // Todas las cuentas con clave que siembra el servidor estan en ese dominio: con el usuario basta.
  for (const account of [...DEMO_ACCOUNTS, ...TEST_ACCOUNTS, ...DEMO_ROUTE_ACCOUNTS]) {
    assert.ok(account.email.endsWith(`@${LOCAL_ACCOUNTS_DOMAIN}`), account.email);
    assert.equal(loginEmailFromIdentifier(account.email.split("@")[0]), account.email);
  }
  assert.equal(loginEmailFromIdentifier("demo.a.e1"), "demo.a.e1@adaceen.edu.co");
  assert.equal(loginEmailFromIdentifier("  demo.b.docente "), "demo.b.docente@adaceen.edu.co");
  assert.equal(loginEmailFromIdentifier("prueba_e-1"), "prueba_e-1@adaceen.edu.co");
  assert.equal(loginEmailFromIdentifier("x"), "x@adaceen.edu.co");
  // Un correo completo, de cualquier dominio, no cambia (solo se le quitan los espacios).
  assert.equal(loginEmailFromIdentifier(" Ana@CorreoUnivalle.edu.co "), "Ana@CorreoUnivalle.edu.co");
  assert.equal(loginEmailFromIdentifier("demo.a.e1@adaceen.edu.co"), "demo.a.e1@adaceen.edu.co");
  // Lo que no es un usuario sigue igual y la validacion del correo lo rechaza.
  for (const typed of ["", "demo a e1", ".demo", "demo.", "demo..a", "demo/a", "ñandú"]) {
    assert.equal(loginEmailFromIdentifier(typed), typed.trim(), typed);
  }
  assert.equal(loginEmailFromIdentifier("a".repeat(65)), "a".repeat(65), "mas de 64 caracteres no es un usuario");
});

test("usuario sin @: /api/auth/login entra con demo.a.e1 y demo.b.docente", async () => {
  const saved = { seedDemoAccounts: env.seedDemoAccounts, testAccountsPassword: env.testAccountsPassword, demoRoutesPassword: env.demoRoutesPassword, demoRoutesOrg: env.demoRoutesOrg, demoRoutesUntil: env.demoRoutesUntil };
  Object.assign(env, { seedDemoAccounts: true, testAccountsPassword: "", demoRoutesPassword: PASSWORD, demoRoutesOrg: "", demoRoutesUntil: "" });
  // createDatabase ya las siembra si hoy es antes de DEMO_RUTAS_HASTA; la prueba no depende del dia.
  const savedInfo = console.info;
  console.info = () => {};
  const database = await createDatabase();
  const app = createApp(database);
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  try {
    await database.syncDemoRouteAccounts(BEFORE_END);
    console.info = savedInfo;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No se pudo iniciar servidor de prueba.");
    const login = async (email: string, password = PASSWORD, sessionId = "") => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8", ...(sessionId ? { "x-session-id": sessionId } : {}) },
        body: JSON.stringify({ email, password, sessionKind: "cli" }),
      });
      return { status: response.status, data: await response.json() as AuthReply };
    };

    const student = await login("demo.a.e1");
    assert.equal(student.status, 200, student.data.error);
    assert.equal(student.data.session?.user?.email, "demo.a.e1@adaceen.edu.co");
    assert.equal(student.data.session?.user?.role, "student", "el estudiante demo no pide codigo");

    const teacher = await login(" DEMO.B.Docente ");
    assert.equal(teacher.status, 200, teacher.data.error);
    assert.equal(teacher.data.session?.user?.email, "demo.b.docente@adaceen.edu.co");
    assert.equal(teacher.data.session?.user?.role, "teacher");

    const fullEmail = await login("demo.c.e3@adaceen.edu.co");
    assert.equal(fullEmail.status, 200, "el correo completo sigue entrando");

    const seeded = await login("estudiante", "Estudiante123!");
    assert.equal(seeded.status, 200, "tambien las cuentas semilla");

    assert.equal((await login("demo.a.e1", "otra-clave-larga")).status, 401, "con otra clave no entra");
    assert.equal((await login("demo.z.e9")).status, 401, "un usuario que no existe no entra");

    // Con la sesion de demo.a.e1 abierta: el mismo usuario vuelve a entrar y otro tiene que salir primero.
    // (Cada login cierra las sesiones anteriores del mismo usuario y tipo: se sigue con la nueva.)
    const again = await login("demo.a.e1", PASSWORD, String(student.data.session?.id));
    assert.equal(again.status, 200, "el usuario de la sesion abierta es el mismo correo");
    const other = await login("demo.b.docente", PASSWORD, String(again.data.session?.id));
    assert.equal(other.status, 409);
    assert.match(String(other.data.error), /salir de la sesion activa/);

    const notUser = await login("demo a e1");
    assert.equal(notUser.status, 400);
    assert.match(String(notUser.data.error), /correo o tu usuario/);
  } finally {
    console.info = savedInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    Object.assign(env, saved);
    await database.close();
  }
});
