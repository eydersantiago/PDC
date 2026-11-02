import assert from "node:assert/strict";
import test from "node:test";
import { maskEmail, normalizeStudentCode } from "../../../src/services/auth/student-code.js";
import {
  type AuthReply,
  type ManagedUser,
  type AccessRequest,
  type UsersReply,
  startTestServer,
  stopTestServer,
  call,
  simulateGoogle,
  teacherSession,
  countUsersWithEmail,
} from "./helpers.js";

test("codigo de estudiante: formato y correo enmascarado", () => {
  assert.equal(normalizeStudentCode("2312345"), "2312345");
  assert.equal(normalizeStudentCode(" 231 2345 "), "2312345");
  assert.equal(normalizeStudentCode("2312345-3743"), "2312345", "se descarta el programa");
  assert.equal(normalizeStudentCode("231234"), null);
  assert.equal(normalizeStudentCode("23123456"), null);
  assert.equal(normalizeStudentCode("abc1234"), null);
  assert.equal(normalizeStudentCode(""), null);
  assert.equal(maskEmail("eyder.suarez@correounivalle.edu.co"), "ey***@correounivalle.edu.co");
  assert.equal(maskEmail("a@gmail.com"), "a***@gmail.com");
});

test("codigo de estudiante: Google con Gmail sin codigo no crea la cuenta; con codigo la crea y despues no lo vuelve a pedir", async () => {
  const { server, database, baseUrl } = await startTestServer();
  const { google, restore } = simulateGoogle(baseUrl);
  try {
    const email = "ana.perez@gmail.com";
    const first = await google(email);
    assert.equal(first.status, 200);
    assert.equal(first.data.ok, false);
    assert.equal(first.data.step, "student_code");
    assert.equal(first.data.email, email);
    assert.match(String(first.data.error), /código de estudiante/);
    assert.match(String(first.data.error), /0\.7\.22/, "una extension vieja le dice que actualice");
    assert.equal(first.data.session, undefined);
    assert.equal(await countUsersWithEmail(database, email), 0, "sin codigo no se crea nada");

    const badCode = await google(email, { studentCode: "12345" });
    assert.equal(badCode.status, 400);
    assert.equal(badCode.data.step, "student_code");
    assert.equal(await countUsersWithEmail(database, email), 0);

    const withCode = await google(email, { studentCode: "2312345-3743" });
    assert.equal(withCode.status, 200, JSON.stringify(withCode.data));
    assert.equal(withCode.data.ok, true);
    assert.equal(withCode.data.firstLogin, true);
    const userId = String(withCode.data.session?.user.id);
    assert.equal(await database.getStudentCodeForUser(userId), "2312345");

    const again = await google(email);
    assert.equal(again.data.ok, true, "con codigo ya no lo pide");
    assert.equal(again.data.session?.user.id, userId);
    const otherCode = await google(email, { studentCode: "7654321" });
    assert.equal(otherCode.data.session?.user.id, userId, "un codigo distinto se ignora: la cuenta ya tiene el suyo");
    assert.equal(await database.getStudentCodeForUser(userId), "2312345");
  } finally {
    restore();
    await stopTestServer(server, database);
  }
});

test("codigo de estudiante: un segundo correo con el mismo codigo queda pendiente y, aprobado, entra a la misma cuenta", async () => {
  const { server, database, baseUrl } = await startTestServer();
  const { google, restore } = simulateGoogle(baseUrl);
  try {
    const institutional = "bruno.diaz@correounivalle.edu.co";
    const gmail = "brunito99@gmail.com";
    const created = await google(institutional, { studentCode: "2311111" });
    assert.equal(created.data.ok, true);
    const brunoId = String(created.data.session?.user.id);

    const second = await google(gmail, { studentCode: "2311111" });
    assert.equal(second.status, 200);
    assert.equal(second.data.step, "pending_approval");
    assert.equal(second.data.maskedEmail, "br***@correounivalle.edu.co", "le dice con que correo entro antes");
    assert.equal(second.data.session, undefined, "no entra a una cuenta en uso sin aprobacion");
    assert.equal(await countUsersWithEmail(database, gmail), 0, "no se crea una segunda cuenta");
    const repeated = await google(gmail, { studentCode: "2311111" });
    assert.equal(repeated.data.step, "pending_approval", "sigue pendiente, sin duplicar la solicitud");

    const teacher = await teacherSession(baseUrl);
    const users = await call<UsersReply>(baseUrl, "GET", "/api/admin/users", { sessionId: teacher });
    assert.equal(users.status, 200);
    assert.equal(users.data.accessRequests.length, 1);
    const request = users.data.accessRequests[0];
    assert.equal(request.email, gmail);
    assert.equal(request.studentCode, "2311111");
    assert.equal(request.target.id, brunoId);
    assert.equal(request.source, null, "ese Gmail no tenia cuenta");
    const brunoRow = users.data.users.find((user) => user.id === brunoId);
    assert.equal(brunoRow?.studentCode, "2311111");
    assert.equal(brunoRow?.hasSignedIn, true);

    const approved = await call<{ ok: boolean; accessRequests: AccessRequest[] }>(baseUrl, "POST", `/api/admin/access-requests/${request.id}`, {
      sessionId: teacher,
      body: { decision: "approve" },
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    assert.deepEqual(approved.data.accessRequests, []);

    const viaGmail = await google(gmail);
    assert.equal(viaGmail.data.ok, true, "aprobado: entra sin volver a escribir el codigo");
    assert.equal(viaGmail.data.session?.user.id, brunoId, "prevalece el user_id del codigo");
    assert.equal(viaGmail.data.session?.user.email, institutional);
    const after = await call<UsersReply>(baseUrl, "GET", "/api/admin/users", { sessionId: teacher });
    assert.deepEqual(after.data.users.find((user) => user.id === brunoId)?.loginEmails, [gmail]);

    // Con la sesion abierta (su correo es el institucional), entrar con el Gmail no es «otra sesion».
    const sameAccount = await google(gmail, { sessionId: viaGmail.data.session?.id });
    assert.equal(sameAccount.status, 200, JSON.stringify(sameAccount.data));
    assert.equal(sameAccount.data.session?.user.id, brunoId);
    const otherPerson = await google("dario.otro@correounivalle.edu.co", { sessionId: sameAccount.data.session?.id, studentCode: "2399999" });
    assert.equal(otherPerson.status, 409, "otra persona si tiene que salir primero");

    const decidedTwice = await call<{ ok: boolean; error?: string }>(baseUrl, "POST", `/api/admin/access-requests/${request.id}`, {
      sessionId: teacher,
      body: { decision: "reject" },
    });
    assert.equal(decidedTwice.status, 400);

    const removed = await call<{ ok: boolean }>(baseUrl, "DELETE", `/api/admin/users/${brunoId}/login-emails/${encodeURIComponent(gmail)}`, { sessionId: teacher });
    assert.equal(removed.status, 200);
    const afterRemoval = await call<{ ok: boolean }>(baseUrl, "GET", "/api/auth/me", { sessionId: sameAccount.data.session?.id });
    assert.equal(afterRemoval.status, 401, "quien entro con ese correo sale al quitarlo");
    const gmailAgain = await google(gmail);
    assert.equal(gmailAgain.data.step, "student_code", "sin el acceso, el Gmail vuelve a pedir codigo");
  } finally {
    restore();
    await stopTestServer(server, database);
  }
});

test("codigo de estudiante: la cuenta importada con Gmail se une a la institucional al aprobar y no vuelve a contar", async () => {
  const { server, database, baseUrl } = await startTestServer();
  const { google, restore } = simulateGoogle(baseUrl);
  try {
    const teacher = await teacherSession(baseUrl);
    const gmail = "carla.campus@gmail.com";
    const imported = await call<{ ok: boolean; created: Array<{ id: string }> }>(baseUrl, "POST", "/api/admin/users/import", {
      sessionId: teacher,
      body: { courseCode: "FPOO", students: [{ email: gmail, displayName: "Carla Campus" }] },
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.data));
    const importedId = imported.data.created[0].id;
    assert.equal((await database.listActiveStudents("user-teacher-demo")).some((student) => student.id === importedId), false,
      "la cuenta importada sin codigo no recibe cohorte");

    const institutional = await google("carla.ruiz@correounivalle.edu.co", { studentCode: "2322222" });
    assert.equal(institutional.data.ok, true);
    const carlaId = String(institutional.data.session?.user.id);
    assert.ok((await database.listActiveStudents("user-teacher-demo")).some((student) => student.id === carlaId));

    const viaGmail = await google(gmail, { studentCode: "2322222" });
    assert.equal(viaGmail.data.step, "pending_approval");

    const pending = await call<UsersReply>(baseUrl, "GET", "/api/admin/users", { sessionId: teacher });
    const request = pending.data.accessRequests[0];
    assert.equal(request.source?.id, importedId, "la cuenta importada es la que sobra");
    assert.equal(request.source?.hasSignedIn, false);

    const approved = await call(baseUrl, "POST", `/api/admin/access-requests/${request.id}`, { sessionId: teacher, body: { decision: "approve" } });
    assert.equal(approved.status, 200);
    const merged = await database.pool.query<{ is_active: boolean; merged_into_user_id: string | null }>(
      `select is_active, merged_into_user_id from users where id = $1`,
      [importedId],
    );
    assert.equal(merged.rows[0].is_active, false);
    assert.equal(merged.rows[0].merged_into_user_id, carlaId);
    const listed = await call<UsersReply>(baseUrl, "GET", "/api/admin/users", { sessionId: teacher });
    assert.equal(listed.data.users.some((user) => user.id === importedId), false, "la cuenta unida no aparece en la lista");

    const gmailLogin = await google(gmail);
    assert.equal(gmailLogin.data.session?.user.id, carlaId);

    // Repetir la importacion con el Gmail no crea otra cuenta: es un acceso de Carla.
    const reimport = await call<{ ok: boolean; created: unknown[]; unchanged: Array<{ id: string }>; updated: Array<{ id: string }> }>(
      baseUrl,
      "POST",
      "/api/admin/users/import",
      { sessionId: teacher, body: { courseCode: "FPOO", students: [{ email: gmail, displayName: "Carla Campus" }] } },
    );
    assert.equal(reimport.data.created.length, 0);
    assert.equal([...reimport.data.unchanged, ...reimport.data.updated][0]?.id, carlaId);
  } finally {
    restore();
    await stopTestServer(server, database);
  }
});

test("codigo de estudiante: rechazar no deja entrar; una cuenta que nunca entro se une sola", async () => {
  const { server, database, baseUrl } = await startTestServer();
  const { google, restore } = simulateGoogle(baseUrl);
  try {
    const teacher = await teacherSession(baseUrl);
    await google("dario@correounivalle.edu.co", { studentCode: "2333333" });
    const intruder = await google("otro.estudiante@gmail.com", { studentCode: "2333333" });
    assert.equal(intruder.data.step, "pending_approval");
    const users = await call<UsersReply>(baseUrl, "GET", "/api/admin/users", { sessionId: teacher });
    const rejected = await call(baseUrl, "POST", `/api/admin/access-requests/${users.data.accessRequests[0].id}`, {
      sessionId: teacher,
      body: { decision: "reject" },
    });
    assert.equal(rejected.status, 200);
    const retry = await google("otro.estudiante@gmail.com", { studentCode: "2333333" });
    assert.equal(retry.data.step, "rejected");
    assert.equal(retry.data.session, undefined);

    // El docente crea la cuenta con el codigo (nunca ha entrado): el primer correo que llega con
    // ese codigo y el nombre de la lista entra a ella sin aprobacion.
    const createdByTeacher = await call<{ ok: boolean; user: ManagedUser; error?: string }>(baseUrl, "POST", "/api/admin/users", {
      sessionId: teacher,
      body: { role: "student", email: "elena.campus@gmail.com", displayName: "Elena Campus", password: "Temporal123!", studentCode: "2344444" },
    });
    assert.equal(createdByTeacher.status, 200, JSON.stringify(createdByTeacher.data));
    assert.equal(createdByTeacher.data.user.studentCode, "2344444");
    const elena = await google("elena.mora@correounivalle.edu.co", { studentCode: "2344444", name: "ELENA MORA CAMPUS" });
    assert.equal(elena.data.ok, true, JSON.stringify(elena.data));
    assert.equal(elena.data.session?.user.id, createdByTeacher.data.user.id);
    assert.equal(await countUsersWithEmail(database, "elena.mora@correounivalle.edu.co"), 0);

    // Un codigo repetido no se puede poner a mano.
    const duplicate = await call<{ ok: boolean; error?: string }>(baseUrl, "POST", "/api/admin/users", {
      sessionId: teacher,
      body: { role: "student", email: "fabio@correounivalle.edu.co", displayName: "Fabio", password: "Temporal123!", studentCode: "2344444" },
    });
    assert.equal(duplicate.status, 400);
    assert.match(String(duplicate.data.error), /ya es de otra cuenta/);
    assert.equal(await countUsersWithEmail(database, "fabio@correounivalle.edu.co"), 0);
  } finally {
    restore();
    await stopTestServer(server, database);
  }
});

test("codigo de estudiante: la clave tambien lo pide (correo no institucional); quitarlo cierra las sesiones y sin el no hay editor", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    const teacher = await teacherSession(baseUrl);
    const created = await call<{ ok: boolean; user: ManagedUser }>(baseUrl, "POST", "/api/admin/users", {
      sessionId: teacher,
      body: { role: "student", email: "gina@gmail.com", displayName: "Gina", password: "Gina-12345" },
    });
    const ginaId = created.data.user.id;
    assert.equal(created.data.user.studentCode, null);

    const noCode = await call<AuthReply>(baseUrl, "POST", "/api/auth/login", { body: { email: "gina@gmail.com", password: "Gina-12345" } });
    assert.equal(noCode.status, 200);
    assert.equal(noCode.data.step, "student_code");
    assert.equal(noCode.data.session, undefined);
    const wrongPassword = await call<AuthReply>(baseUrl, "POST", "/api/auth/login", {
      body: { email: "gina@gmail.com", password: "otra-clave", studentCode: "2355555" },
    });
    assert.equal(wrongPassword.status, 401, "la clave se revisa antes que el codigo");
    assert.equal(await database.getStudentCodeForUser(ginaId), null);
    assert.equal(await database.createEditorSession({ userId: ginaId, label: "prueba", ttlMs: 60_000 }), null, "sin codigo no hay editor");

    const withCode = await call<AuthReply>(baseUrl, "POST", "/api/auth/login", {
      body: { email: "gina@gmail.com", password: "Gina-12345", studentCode: "2355555" },
    });
    assert.equal(withCode.data.ok, true, JSON.stringify(withCode.data));
    const sessionId = String(withCode.data.session?.id);
    assert.ok(await database.createEditorSession({ userId: ginaId, label: "prueba", ttlMs: 60_000 }));

    // El docente corrige el codigo (lo quita): la sesion se cierra y al volver lo pide.
    const cleared = await call<{ ok: boolean; user: ManagedUser }>(baseUrl, "PUT", `/api/admin/users/${ginaId}`, {
      sessionId: teacher,
      body: { studentCode: null },
    });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
    assert.equal(cleared.data.user.studentCode, null);
    const me = await call<{ ok: boolean }>(baseUrl, "GET", "/api/auth/me", { sessionId });
    assert.equal(me.status, 401);

    const conflict = await call<{ ok: boolean; error?: string }>(baseUrl, "PUT", `/api/admin/users/${ginaId}`, {
      sessionId: teacher,
      body: { studentCode: "0000001", displayName: "Gina Cambiada" },
    });
    assert.equal(conflict.status, 400, "0000001 es del estudiante demo");
    const unchanged = await database.pool.query<{ display_name: string }>(`select display_name from users where id = $1`, [ginaId]);
    assert.equal(unchanged.rows[0].display_name, "Gina", "si el codigo choca, no se aplica nada");
  } finally {
    await stopTestServer(server, database);
  }
});

test("codigo de estudiante: el arranque cierra las sesiones abiertas de estudiantes sin codigo ni correo institucional", async () => {
  const { server, database } = await startTestServer();
  try {
    const legacy = await database.createManagedUser({
      role: "student",
      email: "hugo@gmail.com",
      displayName: "Hugo",
      password: "Hugo-12345",
      teacherUserId: "user-teacher-demo",
    });
    const session = await database.authenticateUser("hugo@gmail.com", "Hugo-12345");
    assert.ok(session, "sesion de antes de la 0.7.22");
    const demo = await database.authenticateUser("estudiante@adaceen.edu.co", "Estudiante123!");
    const teacher = await database.authenticateUser("docente@adaceen.edu.co", "Docente123!");
    const closed = await database.closeSessionsOfStudentsWithoutCode();
    assert.equal(closed, 1);
    assert.equal(await database.getSession(session.id), null);
    assert.ok(await database.getSession(String(demo?.id)), "el estudiante demo tiene codigo");
    assert.ok(await database.getSession(String(teacher?.id)), "los docentes no llevan codigo");
    assert.equal(await database.studentLacksCode(legacy.id), true);
  } finally {
    await stopTestServer(server, database);
  }
});

test("codigo de estudiante: una solicitud vieja no se aprueba si ese correo ya entro con su propio codigo", async () => {
  const { server, database, baseUrl } = await startTestServer();
  const { google, restore } = simulateGoogle(baseUrl);
  try {
    const teacher = await teacherSession(baseUrl);
    // X entro con su codigo; S tiene cuenta de antes de la 0.7.22 (ya entro, sin codigo).
    const x = await google("xavier@correounivalle.edu.co", { studentCode: "2361111" });
    assert.equal(x.data.ok, true);
    await database.createManagedUser({ role: "student", email: "sara@gmail.com", displayName: "Sara", password: "Sara-12345", teacherUserId: "user-teacher-demo" });
    assert.ok(await database.authenticateUser("sara@gmail.com", "Sara-12345"));
    const typo = await google("sara@gmail.com", { studentCode: "2361111" });
    assert.equal(typo.data.step, "pending_approval", "se equivoco y escribio el codigo de Xavier");
    const stale = (await call<UsersReply>(baseUrl, "GET", "/api/admin/users", { sessionId: teacher })).data.accessRequests[0];
    const own = await google("sara@gmail.com", { studentCode: "2362222" });
    assert.equal(own.data.ok, true, "con su propio codigo entra");
    const saraId = String(own.data.session?.user.id);
    const listed = await call<UsersReply>(baseUrl, "GET", "/api/admin/users", { sessionId: teacher });
    assert.deepEqual(listed.data.accessRequests, [], "la solicitud vieja ya no esta pendiente");
    const late = await call<{ ok: boolean; error?: string }>(baseUrl, "POST", `/api/admin/access-requests/${encodeURIComponent(stale.id)}`, {
      sessionId: teacher,
      body: { decision: "approve" },
    });
    assert.equal(late.status, 400);
    const sara = await database.pool.query<{ is_active: boolean }>(`select is_active from users where id = $1`, [saraId]);
    assert.equal(sara.rows[0].is_active, true, "la cuenta de Sara sigue viva");
    const again = await google("sara@gmail.com");
    assert.equal(again.data.session?.user.id, saraId);
  } finally {
    restore();
    await stopTestServer(server, database);
  }
});

test("codigo de estudiante: un docente no une una cuenta de otro grupo y no ve sus datos", async () => {
  const { server, database, baseUrl } = await startTestServer();
  const { google, restore } = simulateGoogle(baseUrl);
  try {
    const teacher = await teacherSession(baseUrl);
    const otherTeacher = await database.createManagedUser({ role: "teacher", email: "otro.docente@correounivalle.edu.co", displayName: "Otro Docente", password: "Otro-12345" });
    const mine = await google("mia@correounivalle.edu.co", { studentCode: "2371111" });
    assert.equal(mine.data.ok, true);
    // Zoe es del otro docente, ya entro (antes de la 0.7.22) y escribe el codigo de Mia.
    await database.createManagedUser({ role: "student", email: "zoe@gmail.com", displayName: "Zoe Otro Grupo", password: "Zoe-123456", teacherUserId: otherTeacher.id });
    assert.ok(await database.authenticateUser("zoe@gmail.com", "Zoe-123456"));
    const zoe = await google("zoe@gmail.com", { studentCode: "2371111" });
    assert.equal(zoe.data.step, "pending_approval");
    const listed = await call<UsersReply & { accessRequests: Array<AccessRequest & { source: { otherGroup?: boolean; email: string; displayName: string } | null }> }>(
      baseUrl, "GET", "/api/admin/users", { sessionId: teacher },
    );
    const request = listed.data.accessRequests[0];
    assert.equal(request.source?.otherGroup, true);
    assert.equal(request.source?.email, "", "sin el correo de la cuenta del otro grupo");
    assert.equal(request.source?.displayName, "Cuenta de otro grupo");
    const approve = await call<{ ok: boolean; error?: string }>(baseUrl, "POST", `/api/admin/access-requests/${encodeURIComponent(request.id)}`, {
      sessionId: teacher,
      body: { decision: "approve" },
    });
    assert.equal(approve.status, 400);
    assert.match(String(approve.data.error), /solo el administrador/);
    const zoeRow = await database.pool.query<{ is_active: boolean }>(`select is_active from users where lower(email) = 'zoe@gmail.com'`);
    assert.equal(zoeRow.rows[0].is_active, true);
  } finally {
    restore();
    await stopTestServer(server, database);
  }
});
