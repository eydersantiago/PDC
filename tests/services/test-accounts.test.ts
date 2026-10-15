import assert from "node:assert/strict";
import test from "node:test";
import { env } from "../../src/config/env.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import {
  TEST_ACCOUNTS,
  TEST_ACCOUNTS_DEFAULT_COURSE_REPO,
  TEST_ACCOUNTS_DEFAULT_OWN_REPO,
  TEST_TOPIC_TITLES,
  testAccountsPasswordProblem,
  testTeacherTopic,
} from "../../src/services/test-accounts.js";

/**
 * Cuentas de prueba por rol (TEST_ACCOUNTS_PASSWORD, src/services/test-accounts.ts): con la
 * variable cada arranque deja activos a un administrador, dos docentes y tres estudiantes con
 * codigo, curso y docente de prueba, y los temas del piloto (el repositorio del curso y el propio).
 * Sin la variable no se siembran y las que existan se desactivan.
 */

const PASSWORD = "clave-de-prueba-larga";
const ADMIN = TEST_ACCOUNTS.find((account) => account.role === "admin")!;
const COURSE_TEACHER = TEST_ACCOUNTS.find((account) => account.topic === "course")!;
const OWN_TEACHER = TEST_ACCOUNTS.find((account) => account.topic === "own")!;
const STUDENTS = TEST_ACCOUNTS.filter((account) => account.role === "student");

type Saved = Pick<typeof env, "seedDemoAccounts" | "testAccountsPassword" | "testAccountsOwnRepo" | "testAccountsCourseRepo">;

function saveEnv(): Saved {
  return {
    seedDemoAccounts: env.seedDemoAccounts,
    testAccountsPassword: env.testAccountsPassword,
    testAccountsOwnRepo: env.testAccountsOwnRepo,
    testAccountsCourseRepo: env.testAccountsCourseRepo,
  };
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

async function userRow(database: AppDatabase, id: string) {
  const result = await database.pool.query<{ role: string; teacher_user_id: string | null; is_active: boolean; display_name: string }>(
    `select r.code as role, u.teacher_user_id, u.is_active, u.display_name from users u join roles r on r.id = u.role_id where u.id = $1`,
    [id],
  );
  return result.rows[0];
}

async function canLogin(database: AppDatabase, email: string, password: string) {
  return Boolean(await database.authenticateUser(email, password, { kind: "cli" }));
}

test("cuentas de prueba: temas y clave minima", () => {
  assert.equal(testAccountsPasswordProblem(""), "");
  assert.equal(testAccountsPasswordProblem(PASSWORD), "");
  assert.match(testAccountsPasswordProblem("corta"), /menos de 12 caracteres/);

  const vars = { ownRepo: "", courseRepo: "" };
  const courseTopic = { courseCode: "FPOO", week: 8, title: "Reutilizacion de codigo", repoFullName: "vbucheli/Nutricion" };
  assert.deepEqual(testTeacherTopic("course", courseTopic, vars).topic, courseTopic, "copia el tema del curso");
  assert.deepEqual(testTeacherTopic("own", courseTopic, vars).topic, {
    courseCode: "FPOO", week: 8, title: TEST_TOPIC_TITLES.own, repoFullName: TEST_ACCOUNTS_DEFAULT_OWN_REPO,
  }, "repo propio con la semana del curso");
  assert.deepEqual(testTeacherTopic("course", null, vars).topic, {
    courseCode: "FPOO", week: 0, title: TEST_TOPIC_TITLES.course, repoFullName: TEST_ACCOUNTS_DEFAULT_COURSE_REPO,
  }, "sin tema del curso: el repositorio por defecto");

  const fromVars = { ownRepo: "https://github.com/eydersantiago/PDC", courseRepo: "vbucheli/IMC" };
  assert.equal(testTeacherTopic("own", courseTopic, fromVars).topic.repoFullName, "eydersantiago/PDC", "acepta el enlace");
  const course = testTeacherTopic("course", courseTopic, fromVars).topic;
  assert.equal(course.repoFullName, "vbucheli/IMC", "la variable manda sobre el tema copiado");
  assert.equal(course.week, 8);

  const bad = testTeacherTopic("own", null, { ownRepo: "no es un repo", courseRepo: "" });
  assert.equal(bad.topic.repoFullName, TEST_ACCOUNTS_DEFAULT_OWN_REPO);
  assert.match(bad.warning, /TEST_ACCOUNTS_OWN_REPO=no es un repo no es usuario\/repositorio/);
});

test("cuentas de prueba: sin TEST_ACCOUNTS_PASSWORD no se siembran", async () => {
  const saved = saveEnv();
  Object.assign(env, { seedDemoAccounts: true, testAccountsPassword: "" });
  const database = await createDatabase();
  try {
    assert.equal(await database.countActiveTestAccounts(), 0);
    const rows = await database.pool.query(`select id from users where email like 'prueba.%'`);
    assert.equal(rows.rows.length, 0, "ninguna cuenta de prueba en la base");
  } finally {
    Object.assign(env, saved);
    await database.close();
  }
});

test("cuentas de prueba: con la variable quedan listas por rol, con el tema y la politica del curso", async () => {
  const saved = saveEnv();
  Object.assign(env, { seedDemoAccounts: true, testAccountsPassword: "", testAccountsOwnRepo: "", testAccountsCourseRepo: "" });
  const database = await createDatabase();
  try {
    // El docente del curso (aqui el demo, el de las cuentas nuevas) tiene tema y una politica propia.
    await database.setPilotTopic("user-teacher-demo", { courseCode: "FPOO", week: 7, title: "Abstraccion y test", repoFullName: "vbucheli/IMC" }, "user-admin-demo");
    await database.updateTeacherPolicy("user-teacher-demo", { customInstruction: "Instruccion del curso" });

    env.testAccountsPassword = PASSWORD;
    const { lines } = await capturingConsole(() => database.syncTestAccounts());
    assert.ok(lines.some((line) => line.startsWith("[cuentas-prueba] 6 cuentas de prueba activas")), lines.join("\n"));
    assert.ok(!lines.some((line) => line.includes(PASSWORD)), "la clave no sale en el log");
    assert.equal(await database.countActiveTestAccounts(), 6);

    for (const account of TEST_ACCOUNTS) {
      assert.equal(await canLogin(database, account.email, PASSWORD), true, `${account.email} entra con la clave`);
      const row = await userRow(database, account.id);
      assert.equal(row.role, account.role);
      assert.equal(row.teacher_user_id, account.teacherId ?? null);
    }
    for (const student of STUDENTS) {
      assert.equal(await database.studentLacksCode(student.id), false, `${student.email} no pide el codigo`);
    }

    const courseStudents = await database.listActiveStudents(COURSE_TEACHER.id);
    assert.deepEqual(courseStudents.map((item) => item.id).sort(), ["user-test-student-1", "user-test-student-2"], "dos estudiantes para los bloques");
    assert.deepEqual((await database.listActiveStudents(OWN_TEACHER.id)).map((item) => item.id), ["user-test-student-3"]);
    const realStudents = await database.listActiveStudents("user-teacher-demo");
    assert.ok(!realStudents.some((item) => item.id.startsWith("user-test-")), "el grupo del curso no cambia");

    assert.deepEqual(await database.getPilotTopic(COURSE_TEACHER.id).then((topic) => topic && [topic.week, topic.title, topic.repoFullName]),
      [7, "Abstraccion y test", "vbucheli/IMC"], "copia el tema del docente del curso");
    assert.deepEqual(await database.getPilotTopic(OWN_TEACHER.id).then((topic) => topic && [topic.week, topic.repoFullName]),
      [7, TEST_ACCOUNTS_DEFAULT_OWN_REPO], "mi repo, con la semana del curso");

    const studentUser = { id: STUDENTS[0].id, role: "student" as const, email: STUDENTS[0].email, displayName: "", teacherUserId: COURSE_TEACHER.id };
    const policy = await database.getTeacherPolicyForUser(studentUser);
    assert.equal(policy?.teacherUserId, COURSE_TEACHER.id);
    assert.equal(policy?.customInstruction, "Instruccion del curso", "politica copiada del docente del curso");

    const defaultTeacher = await database.getDefaultTeacherChoice();
    assert.ok(!String(defaultTeacher.teacherUserId || "").startsWith("user-test-"), "el docente de las cuentas nuevas no es uno de prueba");

    // Reinicio: lo cambiado en la cuenta vuelve al escenario, pero la politica editada se conserva.
    await database.updateTeacherPolicy(COURSE_TEACHER.id, { customInstruction: "Editada en la prueba" });
    await database.pool.query(`update users set is_active = false, display_name = 'Otro', teacher_user_id = 'user-teacher-demo' where id = $1`, [STUDENTS[0].id]);
    await database.setPilotTopic(OWN_TEACHER.id, { courseCode: "FPOO", week: 3, title: "Otro", repoFullName: "otro/repo" }, ADMIN.id);
    env.testAccountsOwnRepo = "eydersantiago/PDC";
    await capturingConsole(() => database.syncTestAccounts());
    const restored = await userRow(database, STUDENTS[0].id);
    assert.deepEqual([restored.is_active, restored.display_name, restored.teacher_user_id], [true, STUDENTS[0].displayName, COURSE_TEACHER.id]);
    assert.equal((await database.getPilotTopic(OWN_TEACHER.id))?.repoFullName, "eydersantiago/PDC", "el tema sigue a la variable");
    const kept = await database.getTeacherPolicyForUser(studentUser);
    assert.equal(kept?.customInstruction, "Editada en la prueba", "la politica no se pisa al reiniciar");
  } finally {
    Object.assign(env, saved);
    await database.close();
  }
});

test("cuentas de prueba: sin la variable se desactivan, y un correo ocupado no tumba el resto", async () => {
  const saved = saveEnv();
  Object.assign(env, { seedDemoAccounts: true, testAccountsPassword: "" });
  const database = await createDatabase();
  try {
    // Alguien ya tiene el correo del estudiante 3: ese no se siembra y los demas si.
    await database.pool.query(
      `insert into users (id, role_id, teacher_user_id, email, display_name, password_hash) values ('user-otro', 'role-student', null, $1, 'Otro', 'x:y')`,
      [STUDENTS[2].email],
    );
    env.testAccountsPassword = PASSWORD;
    const seeded = await capturingConsole(() => database.syncTestAccounts());
    assert.equal(await database.countActiveTestAccounts(), 5);
    assert.ok(seeded.lines.some((line) => line.includes(`${STUDENTS[2].email} no se sembro`)), seeded.lines.join("\n"));

    const session = await database.authenticateUser(STUDENTS[0].email, PASSWORD, { kind: "browser" });
    assert.ok(session);

    // Clave corta: avisa, no siembra y cierra las que hay. El administrador de prueba se queda
    // mientras sea el unico administrador activo (el demo esta activo, asi que se desactiva).
    env.testAccountsPassword = "corta";
    const closed = await capturingConsole(() => database.syncTestAccounts());
    assert.ok(closed.lines.some((line) => line.includes("menos de 12 caracteres")));
    assert.ok(closed.lines.some((line) => line.startsWith("[cuentas-prueba] Sin TEST_ACCOUNTS_PASSWORD: cuentas de prueba desactivadas")));
    assert.equal(await database.countActiveTestAccounts(), 0);
    assert.equal(await canLogin(database, ADMIN.email, PASSWORD), false);
    const sessions = await database.pool.query<{ is_active: boolean }>(`select is_active from app_sessions where user_id = $1`, [STUDENTS[0].id]);
    assert.ok(sessions.rows.length > 0 && sessions.rows.every((row) => !row.is_active), "sus sesiones se cierran");

    // Unico administrador: el de prueba no se desactiva.
    env.testAccountsPassword = PASSWORD;
    await capturingConsole(() => database.syncTestAccounts());
    await database.pool.query(`update users set is_active = false where id = 'user-admin-demo'`);
    env.testAccountsPassword = "";
    const kept = await capturingConsole(() => database.syncTestAccounts());
    assert.equal((await userRow(database, ADMIN.id)).is_active, true);
    assert.ok(kept.lines.some((line) => line.includes("es el unico administrador activo")));
    assert.equal(await database.countActiveTestAccounts(), 1);
  } finally {
    Object.assign(env, saved);
    await database.close();
  }
});
