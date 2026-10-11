import assert from "node:assert/strict";
import test from "node:test";
import { env } from "../../src/config/env.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { DEMO_ACCOUNTS } from "../../src/services/demo-accounts.js";
import {
  adminEmailRejection,
  describeConfiguredAdmins,
  parseAdminEmails,
  teacherWithStudentsReason,
} from "../../src/services/configured-admins.js";

/**
 * ADACEEN_ADMIN_EMAILS: cada arranque pasa a administrador las cuentas activas de esos correos
 * (no crea cuentas ni baja de rol) antes de cerrar las cuentas demo, asi el mismo arranque
 * desactiva al administrador demo cuando era el unico administrador.
 */

const GOOGLE_DEFAULT = "clave-google-por-defecto";

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

async function userRow(database: AppDatabase, email: string) {
  const result = await database.pool.query<{ id: string; role: string; teacher_user_id: string | null; is_active: boolean }>(
    `select u.id, r.code as role, u.teacher_user_id, u.is_active from users u join roles r on r.id = u.role_id where lower(u.email) = lower($1)`,
    [email],
  );
  return result.rows[0];
}

async function canLogin(database: AppDatabase, email: string, password: string) {
  return Boolean(await database.authenticateUser(email, password, { kind: "cli" }));
}

// Reinicio sobre la misma base: lo que hace initialize() despues del esquema (pg-mem no deja
// volver a correr el esquema).
async function restart(database: AppDatabase) {
  await (database as unknown as { seed(): Promise<void> }).seed();
}

test("ADACEEN_ADMIN_EMAILS: lectura de la variable y mensajes", () => {
  assert.deepEqual(parseAdminEmails(""), []);
  assert.deepEqual(
    parseAdminEmails(" Eyder.Suarez@CorreoUnivalle.edu.co ; otra@univalle.edu.co,eyder.suarez@correounivalle.edu.co\notra@univalle.edu.co "),
    ["eyder.suarez@correounivalle.edu.co", "otra@univalle.edu.co"],
  );
  assert.equal(adminEmailRejection("eyder.suarez@correounivalle.edu.co"), "");
  assert.match(adminEmailRejection("sin-arroba"), /no es un correo valido/);
  assert.match(adminEmailRejection("admin@adaceen.edu.co"), /cuenta demo/);
  assert.equal(teacherWithStudentsReason(1), "es docente de 1 estudiante: pasalos a otro docente en «Usuarios» o quita el correo de la variable.");
  assert.match(teacherWithStudentsReason(3), /^es docente de 3 estudiantes:/);
  const { info, warn } = describeConfiguredAdmins({
    promoted: [{ email: "a@x.co", previousRole: "student", passwordReset: true }],
    alreadyAdmin: ["ya@x.co"],
    missing: ["nadie@x.co"],
    inactive: ["apagada@x.co"],
    skipped: [{ email: "admin@adaceen.edu.co", reason: "es una cuenta demo (src/services/demo-accounts.ts)." }],
  });
  assert.deepEqual(info, [
    "[administradores] ADACEEN_ADMIN_EMAILS: a@x.co paso de estudiante a administrador y sus sesiones se cerraron. Entraba con la clave por defecto de las cuentas de Google: ahora entra con Google.",
  ]);
  assert.deepEqual(warn, [
    "[administradores] ADACEEN_ADMIN_EMAILS: no hay cuenta con nadie@x.co: entra una vez con «Continuar con Google» (o creala en «Usuarios») y reinicia el App Service.",
    "[administradores] ADACEEN_ADMIN_EMAILS: apagada@x.co esta desactivada: no pasa a administrador (activala en «Usuarios» y reinicia el App Service).",
    "[administradores] ADACEEN_ADMIN_EMAILS: admin@adaceen.edu.co no pasa a administrador: es una cuenta demo (src/services/demo-accounts.ts).",
  ]);
});

test("ADACEEN_ADMIN_EMAILS: la cuenta de Google pasa a administrador y el mismo arranque desactiva al administrador demo", async () => {
  const saved = { seed: env.seedDemoAccounts, admins: env.adminEmails, google: env.googleDefaultPassword };
  env.seedDemoAccounts = true;
  env.adminEmails = [];
  env.googleDefaultPassword = GOOGLE_DEFAULT;
  const database = await createDatabase();
  try {
    const [demoAdmin] = DEMO_ACCOUNTS;
    // El dueno entra una vez con Google: queda como estudiante del docente demo, con la clave por defecto.
    const email = "eyder.suarez@correounivalle.edu.co";
    const studentSession = await database.authenticateGoogleUser({ email, displayName: "Eyder Suarez", defaultPassword: GOOGLE_DEFAULT });
    assert.equal(studentSession.user.role, "student");
    assert.equal(await canLogin(database, email, GOOGLE_DEFAULT), true, "la cuenta de Google entra con la clave por defecto");

    // Primer arranque de produccion con la variable (y el resto de casos que no se tocan).
    env.seedDemoAccounts = false;
    env.adminEmails = parseAdminEmails(`${email}, nadie@univalle.edu.co, admin@adaceen.edu.co, sin-arroba`);
    let { lines } = await capturingConsole(() => restart(database));
    const row = await userRow(database, email);
    assert.equal(row.role, "admin");
    assert.equal(row.teacher_user_id, null, "un administrador no tiene docente");
    assert.equal(await database.getSession(studentSession.id), null, "su sesion de estudiante se cerro");
    assert.equal(await canLogin(database, email, GOOGLE_DEFAULT), false, "la clave por defecto de Google ya no sirve");
    const googleSession = await database.authenticateGoogleUser({ email, displayName: "Eyder Suarez", defaultPassword: GOOGLE_DEFAULT });
    assert.equal(googleSession.user.role, "admin", "con Google entra como administrador");
    assert.equal(await canLogin(database, demoAdmin.email, demoAdmin.password), false, "el administrador demo se desactivo en el mismo arranque");
    assert.equal(await database.countActiveDemoAccounts(), 0);
    assert.deepEqual(lines, [
      `[administradores] ADACEEN_ADMIN_EMAILS: ${email} paso de estudiante a administrador y sus sesiones se cerraron. Entraba con la clave por defecto de las cuentas de Google: ahora entra con Google.`,
      "[administradores] ADACEEN_ADMIN_EMAILS: no hay cuenta con nadie@univalle.edu.co: entra una vez con «Continuar con Google» (o creala en «Usuarios») y reinicia el App Service.",
      "[administradores] ADACEEN_ADMIN_EMAILS: admin@adaceen.edu.co no pasa a administrador: es una cuenta demo (src/services/demo-accounts.ts).",
      "[administradores] ADACEEN_ADMIN_EMAILS: sin-arroba no pasa a administrador: no es un correo valido.",
      "[cuentas-demo] SEED_DEMO_ACCOUNTS=false: cuentas demo desactivadas al arrancar: admin@adaceen.edu.co, docente@adaceen.edu.co, estudiante@adaceen.edu.co.",
    ]);

    // Un segundo arranque no cambia nada ni repite lo ya hecho; su sesion de administrador sigue.
    env.adminEmails = [email];
    ({ lines } = await capturingConsole(() => restart(database)));
    assert.deepEqual(lines, []);
    assert.ok(await database.getSession(googleSession.id), "la sesion de administrador no se cierra en cada arranque");

    // Quitar el correo de la variable no le quita el rol.
    env.adminEmails = [];
    await restart(database);
    assert.equal((await userRow(database, email)).role, "admin");
  } finally {
    Object.assign(env, { seedDemoAccounts: saved.seed, adminEmails: saved.admins, googleDefaultPassword: saved.google });
    await database.close();
  }
});

test("ADACEEN_ADMIN_EMAILS: no toca a un docente con estudiantes ni una cuenta desactivada; una clave propia se conserva", async () => {
  const saved = { seed: env.seedDemoAccounts, admins: env.adminEmails, google: env.googleDefaultPassword };
  env.seedDemoAccounts = false;
  env.adminEmails = [];
  env.googleDefaultPassword = GOOGLE_DEFAULT;
  const database = await createDatabase();
  try {
    const conGrupo = await database.createManagedUser({ role: "teacher", email: "docente.grupo@univalle.edu.co", displayName: "Docente con grupo", password: "ClaveDocente1!" });
    await database.createManagedUser({ role: "teacher", email: "docente.solo@univalle.edu.co", displayName: "Docente sin grupo", password: "ClavePropia1!" });
    await database.createManagedUser({ role: "student", email: "alumna@correounivalle.edu.co", displayName: "Alumna", password: "ClaveAlumna1!", teacherUserId: conGrupo.id });
    const apagada = await database.createManagedUser({ role: "student", email: "apagada@correounivalle.edu.co", displayName: "Apagada", password: "ClaveApagada1!", teacherUserId: conGrupo.id });
    await database.pool.query("update users set is_active = false where id = $1", [apagada.id]);

    const { lines } = await capturingConsole(() => database.syncConfiguredAdmins([
      "docente.grupo@univalle.edu.co",
      "docente.solo@univalle.edu.co",
      "apagada@correounivalle.edu.co",
    ]));
    assert.equal((await userRow(database, "docente.grupo@univalle.edu.co")).role, "teacher", "sus estudiantes se quedarian sin docente");
    assert.equal((await userRow(database, "docente.solo@univalle.edu.co")).role, "admin");
    assert.equal(await canLogin(database, "docente.solo@univalle.edu.co", "ClavePropia1!"), true, "su clave propia sigue sirviendo");
    const apagadaRow = await userRow(database, "apagada@correounivalle.edu.co");
    assert.equal(apagadaRow.role, "student");
    assert.equal(apagadaRow.is_active, false, "no la reactiva");
    assert.deepEqual(lines, [
      `[administradores] ADACEEN_ADMIN_EMAILS: docente.solo@univalle.edu.co paso de docente a administrador y sus sesiones se cerraron.`,
      "[administradores] ADACEEN_ADMIN_EMAILS: apagada@correounivalle.edu.co esta desactivada: no pasa a administrador (activala en «Usuarios» y reinicia el App Service).",
      "[administradores] ADACEEN_ADMIN_EMAILS: docente.grupo@univalle.edu.co no pasa a administrador: es docente de 2 estudiantes: pasalos a otro docente en «Usuarios» o quita el correo de la variable.",
    ]);
  } finally {
    Object.assign(env, { seedDemoAccounts: saved.seed, adminEmails: saved.admins, googleDefaultPassword: saved.google });
    await database.close();
  }
});
