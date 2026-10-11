import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { createApp } from "../../src/app.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";

/**
 * Piloto con FPOO-01 (navegador 0.7.21): «Importar lista» en «Usuarios» carga a los
 * estudiantes de un curso de Campus como miembros de un docente y un curso, y el administrador
 * elige el docente de las cuentas nuevas (las que entran por primera vez con Google).
 */

async function startTestServer() {
  const database = await createDatabase();
  const app = createApp(database);
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No se pudo iniciar servidor de prueba.");
  return { database, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopTestServer(server: Server, database: AppDatabase) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await database.close();
}

// Sesion directa en la base, como workspace-routes.test.ts: el login HTTP del administrador
// busca la politica del docente por defecto con un JOIN que pg-mem no soporta.
async function login(database: AppDatabase, email: string, password: string) {
  const session = await database.authenticateUser(email, password);
  assert.ok(session, `login ${email}`);
  return session.id;
}

async function call<T>(baseUrl: string, method: string, route: string, sessionId: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(sessionId ? { "x-session-id": sessionId } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() as T };
}

type Entry = { id?: string; email: string; displayName: string; changes?: string[]; reason?: string };
type ImportReply = {
  ok: boolean;
  error?: string;
  teacherUserId: string;
  courseCode: string;
  created: Entry[];
  updated: Entry[];
  unchanged: Entry[];
  skipped: Entry[];
};
type UsersReply = {
  ok: boolean;
  users: Array<{ id: string; email: string; role: string; teacherUserId: string | null; assignedCourseCodes: string[]; isActive: boolean }>;
  teachers: Array<{ id: string; email: string; displayName: string }>;
  defaultTeacher?: { teacherUserId: string | null; chosenTeacherUserId: string | null; source: string; chosenInactive: boolean; updatedByName: string | null };
};

test("importar lista: crea los nuevos, pasa al docente a los que ya estaban, no toca docentes y se puede repetir", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    const admin = await login(database, "admin@adaceen.edu.co", "Admin123!");
    const victor = await database.createManagedUser({
      role: "teacher",
      email: "victor.bucheli@correounivalle.edu.co",
      displayName: "Victor Bucheli",
      password: "Docente-Piloto-1",
    });
    // Un estudiante que ya entro (queda con el docente demo y FPI) y otro desactivado.
    await database.createManagedUser({
      role: "student",
      email: "ya.entro@correounivalle.edu.co",
      displayName: "Ya Entro",
      password: "Estudiante-1",
      teacherUserId: "user-teacher-demo",
      assignedCourseCodes: ["FPI"],
    });
    const inactive = await database.createManagedUser({
      role: "student",
      email: "desactivado@correounivalle.edu.co",
      displayName: "Cuenta Desactivada",
      password: "Estudiante-1",
      teacherUserId: "user-teacher-demo",
    });
    await database.pool.query(`update users set is_active = false where id = $1`, [inactive.id]);

    const students = [
      { email: "Ana.Perez@correounivalle.edu.co", displayName: "Ana Pérez" },
      { email: "bruno.diaz@correounivalle.edu.co", displayName: "Bruno Díaz" },
      { email: "ana.perez@correounivalle.edu.co", displayName: "Ana repetida" },
      { email: "ya.entro@correounivalle.edu.co", displayName: "YA ENTRO" },
      { email: "docente@adaceen.edu.co", displayName: "Docente Demo" },
      { email: "desactivado@correounivalle.edu.co", displayName: "Desactivado" },
    ];
    const first = await call<ImportReply>(baseUrl, "POST", "/api/admin/users/import", admin, {
      teacherUserId: victor.id,
      courseCode: "fpoo",
      students,
    });
    assert.equal(first.status, 200, first.data.error);
    assert.equal(first.data.teacherUserId, victor.id);
    assert.equal(first.data.courseCode, "FPOO");
    assert.deepEqual(first.data.created.map((entry) => entry.email), ["ana.perez@correounivalle.edu.co", "bruno.diaz@correounivalle.edu.co"], "el correo repetido cuenta una vez");
    assert.equal(first.data.created[0].displayName, "Ana Pérez");
    assert.deepEqual(first.data.updated.map((entry) => [entry.email, entry.changes]), [["ya.entro@correounivalle.edu.co", ["docente", "curso"]]]);
    assert.equal(first.data.updated[0].displayName, "Ya Entro", "el nombre de quien ya estaba no cambia");
    assert.deepEqual(first.data.skipped.map((entry) => entry.email), ["docente@adaceen.edu.co", "desactivado@correounivalle.edu.co"]);
    assert.match(String(first.data.skipped[0].reason), /docente/i);
    assert.match(String(first.data.skipped[1].reason), /desactivada/i);

    const users = await call<UsersReply>(baseUrl, "GET", "/api/admin/users", admin);
    const byEmail = new Map(users.data.users.map((user) => [user.email, user]));
    assert.equal(byEmail.get("ana.perez@correounivalle.edu.co")?.teacherUserId, victor.id);
    assert.deepEqual(byEmail.get("ana.perez@correounivalle.edu.co")?.assignedCourseCodes, ["FPOO"]);
    assert.equal(byEmail.get("ya.entro@correounivalle.edu.co")?.teacherUserId, victor.id);
    assert.deepEqual([...(byEmail.get("ya.entro@correounivalle.edu.co")?.assignedCourseCodes || [])].sort(), ["FPI", "FPOO"], "suma el curso sin quitar los que tenia");
    assert.equal(byEmail.get("desactivado@correounivalle.edu.co")?.isActive, false, "la cuenta desactivada sigue igual");
    assert.equal(byEmail.get("docente@adaceen.edu.co")?.role, "teacher");
    // Las cuentas nuevas no tienen una clave conocida: entran con Google.
    const loginNew = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ email: "ana.perez@correounivalle.edu.co", password: "Admin123!" }),
    });
    assert.notEqual(loginNew.status, 200);

    const again = await call<ImportReply>(baseUrl, "POST", "/api/admin/users/import", admin, {
      teacherUserId: victor.id,
      courseCode: "FPOO",
      students: students.slice(0, 4),
    });
    assert.equal(again.status, 200);
    assert.equal(again.data.created.length, 0);
    assert.equal(again.data.updated.length, 0);
    assert.equal(again.data.unchanged.length, 3, "repetir la importacion no cambia nada");

    const badCourse = await call<ImportReply>(baseUrl, "POST", "/api/admin/users/import", admin, { teacherUserId: victor.id, courseCode: "QUIMICA", students });
    assert.equal(badCourse.status, 400);
    const empty = await call<ImportReply>(baseUrl, "POST", "/api/admin/users/import", admin, { teacherUserId: victor.id, courseCode: "FPOO", students: [] });
    assert.equal(empty.status, 400);
    const notTeacher = await call<ImportReply>(baseUrl, "POST", "/api/admin/users/import", admin, { teacherUserId: "user-student-demo", courseCode: "FPOO", students });
    assert.equal(notTeacher.status, 400, "el docente debe ser un profesor activo");
    assert.match(String(notTeacher.data.error), /profesor activo/);
  } finally {
    await stopTestServer(server, database);
  }
});

test("importar lista como docente: queda en su grupo y no se lleva estudiantes de otro docente", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    const victor = await database.createManagedUser({
      role: "teacher",
      email: "victor.bucheli@correounivalle.edu.co",
      displayName: "Victor Bucheli",
      password: "Docente-Piloto-1",
    });
    const teacher = await login(database, "victor.bucheli@correounivalle.edu.co", "Docente-Piloto-1");
    const student = await login(database, "estudiante@adaceen.edu.co", "Estudiante123!");
    const forbidden = await call<ImportReply>(baseUrl, "POST", "/api/admin/users/import", student, { courseCode: "FPOO", students: [{ email: "x@correounivalle.edu.co" }] });
    assert.equal(forbidden.status, 403);

    const reply = await call<ImportReply>(baseUrl, "POST", "/api/admin/users/import", teacher, {
      teacherUserId: "user-teacher-demo",
      courseCode: "FPOO",
      students: [
        { email: "nueva@correounivalle.edu.co", displayName: "Nueva Estudiante" },
        { email: "estudiante@adaceen.edu.co", displayName: "Estudiante Demo" },
      ],
    });
    assert.equal(reply.status, 200, reply.data.error);
    assert.equal(reply.data.teacherUserId, victor.id, "el docente siempre importa a su grupo");
    assert.deepEqual(reply.data.created.map((entry) => entry.email), ["nueva@correounivalle.edu.co"]);
    assert.deepEqual(reply.data.skipped.map((entry) => entry.email), ["estudiante@adaceen.edu.co"]);
    assert.match(String(reply.data.skipped[0].reason), /otro docente/);
  } finally {
    await stopTestServer(server, database);
  }
});

test("docente de las cuentas nuevas: el administrador lo elige y quien entra con Google por primera vez queda con el", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    const admin = await login(database, "admin@adaceen.edu.co", "Admin123!");
    const teacherSession = await login(database, "docente@adaceen.edu.co", "Docente123!");
    const victor = await database.createManagedUser({
      role: "teacher",
      email: "victor.bucheli@correounivalle.edu.co",
      displayName: "Victor Bucheli",
      password: "Docente-Piloto-1",
    });

    const before = await call<UsersReply>(baseUrl, "GET", "/api/admin/users", admin);
    assert.equal(before.data.defaultTeacher?.source, "oldest");
    assert.equal(before.data.defaultTeacher?.teacherUserId, "user-teacher-demo", "sin eleccion, el profesor activo mas antiguo");
    assert.equal(before.data.defaultTeacher?.chosenTeacherUserId, null);
    const asTeacher = await call<UsersReply>(baseUrl, "GET", "/api/admin/users", teacherSession);
    assert.equal(asTeacher.data.defaultTeacher, undefined, "el docente no ve ni elige el de las cuentas nuevas");
    const teacherPut = await call<UsersReply>(baseUrl, "PUT", "/api/admin/default-teacher", teacherSession, { teacherUserId: victor.id });
    assert.equal(teacherPut.status, 403);

    const invalid = await call<{ ok: boolean; error?: string }>(baseUrl, "PUT", "/api/admin/default-teacher", admin, { teacherUserId: "user-student-demo" });
    assert.equal(invalid.status, 400);
    const chosen = await call<{ ok: boolean; defaultTeacher: UsersReply["defaultTeacher"] }>(baseUrl, "PUT", "/api/admin/default-teacher", admin, { teacherUserId: victor.id });
    assert.equal(chosen.status, 200);
    assert.equal(chosen.data.defaultTeacher?.teacherUserId, victor.id);
    assert.equal(chosen.data.defaultTeacher?.source, "admin");
    assert.equal(chosen.data.defaultTeacher?.updatedByName, "Administrador Demo");

    const google = await database.authenticateGoogleUser({
      email: "Primera.Vez@correounivalle.edu.co",
      displayName: "Primera Vez",
      defaultPassword: "clave-google-larga",
    });
    assert.equal(google.user.teacherUserId, victor.id, "la cuenta nueva de Google queda con el docente elegido");
    const users = await call<UsersReply>(baseUrl, "GET", "/api/admin/users", admin);
    assert.deepEqual(users.data.users.find((user) => user.email === "primera.vez@correounivalle.edu.co")?.assignedCourseCodes, ["FPOO"]);

    // Si el elegido se desactiva, vuelve el mas antiguo y se avisa.
    await database.pool.query(`update users set is_active = false where id = $1`, [victor.id]);
    const afterDeactivate = await call<UsersReply>(baseUrl, "GET", "/api/admin/users", admin);
    assert.equal(afterDeactivate.data.defaultTeacher?.teacherUserId, "user-teacher-demo");
    assert.equal(afterDeactivate.data.defaultTeacher?.chosenInactive, true);

    const reset = await call<{ ok: boolean; defaultTeacher: UsersReply["defaultTeacher"] }>(baseUrl, "PUT", "/api/admin/default-teacher", admin, { teacherUserId: null });
    assert.equal(reset.status, 200);
    assert.equal(reset.data.defaultTeacher?.chosenTeacherUserId, null);
    assert.equal(reset.data.defaultTeacher?.source, "oldest");
  } finally {
    await stopTestServer(server, database);
  }
});
