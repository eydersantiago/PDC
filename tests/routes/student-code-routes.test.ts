import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { OAuth2Client } from "google-auth-library";
import { createApp } from "../../src/app.js";
import { env } from "../../src/config/env.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { resetStudentCodeAttemptsForTests } from "../../src/routes/auth-routes.js";
import { maskEmail, normalizeStudentCode, personNamesEqual, personNamesMatch } from "../../src/services/student-code.js";
import { withdrawParticipant } from "../../scripts/lib/retiro.js";

/**
 * Codigo de estudiante como identidad (navegador 0.7.22): Google dice con que correo llega y el
 * codigo dice quien es. Un estudiante no entra sin codigo, un codigo no queda en dos cuentas y un
 * segundo correo con el mismo codigo entra a la misma cuenta (prevalece su user_id): solo, si la
 * cuenta nunca entro, o cuando el docente lo aprueba, si ya entro.
 */

type AuthReply = {
  ok: boolean;
  step?: string;
  error?: string;
  maskedEmail?: string;
  displayName?: string;
  email?: string;
  firstLogin?: boolean;
  session?: { id: string; user: { id: string; email: string; role: string } };
};
type ManagedUser = { id: string; email: string; role: string; isActive: boolean; studentCode?: string | null; loginEmails?: string[]; hasSignedIn?: boolean };
type AccessRequest = { id: string; email: string; studentCode: string; target: { id: string; email: string }; source: { id: string; hasSignedIn: boolean } | null };
type UsersReply = { ok: boolean; users: ManagedUser[]; accessRequests: AccessRequest[]; error?: string };

async function startTestServer() {
  resetStudentCodeAttemptsForTests();
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

async function call<T>(baseUrl: string, method: string, route: string, options: { sessionId?: string; body?: unknown } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(options.sessionId ? { "x-session-id": options.sessionId } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, data: await response.json() as T };
}

/**
 * Google simulado: cada token «token-google-<correo>» es de ese correo. Devuelve la funcion que
 * entra con Google y la que deja todo como estaba.
 */
function simulateGoogle(baseUrl: string) {
  const previous = { clientId: env.googleClientId, password: env.googleDefaultPassword, domain: env.googleAllowedHostedDomain };
  const originalTokenInfo = OAuth2Client.prototype.getTokenInfo;
  const originalFetch = globalThis.fetch;
  env.googleClientId = "cliente-google-de-prueba.apps.googleusercontent.com";
  env.googleDefaultPassword = "ClaveGoogle123!";
  env.googleAllowedHostedDomain = "";
  let currentEmail = "";
  let currentName = "";
  OAuth2Client.prototype.getTokenInfo = async function () {
    return { aud: env.googleClientId, email: currentEmail, email_verified: true } as unknown as Awaited<ReturnType<OAuth2Client["getTokenInfo"]>>;
  };
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input).startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
      return new Response(JSON.stringify({ email: currentEmail, email_verified: true, name: currentName }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  /** name: el nombre de la cuenta de Google (por defecto «Nombre de <usuario>»). */
  const google = (email: string, extra: { studentCode?: string; sessionId?: string; name?: string } = {}) => {
    currentEmail = email;
    currentName = extra.name ?? `Nombre de ${email.split("@")[0]}`;
    return call<AuthReply>(baseUrl, "POST", "/api/auth/google-login", {
      sessionId: extra.sessionId,
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

async function teacherSession(baseUrl: string) {
  const reply = await call<AuthReply>(baseUrl, "POST", "/api/auth/login", { body: { email: "docente@adaceen.edu.co", password: "Docente123!" } });
  assert.equal(reply.status, 200, JSON.stringify(reply.data));
  return String(reply.data.session?.id);
}

async function countUsersWithEmail(database: AppDatabase, email: string) {
  const result = await database.pool.query<{ id: string }>(`select id from users where lower(email) = $1`, [email]);
  return result.rows.length;
}

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

test("codigo de estudiante: un Gmail con el codigo de una cuenta de la lista (no institucional) que nunca entro se une solo (examen 28-10); un codigo de docente no da acceso", async () => {
  const { server, database, baseUrl } = await startTestServer();
  const { google, restore } = simulateGoogle(baseUrl);
  try {
    const teacher = await teacherSession(baseUrl);
    const created = await call<{ ok: boolean; user: ManagedUser }>(baseUrl, "POST", "/api/admin/users", {
      sessionId: teacher,
      body: { role: "student", email: "nina.campus@gmail.com", displayName: "Nina Campos", password: "Temporal123!", studentCode: "2381111" },
    });
    assert.equal(created.status, 200);
    // Examen 28-10-2026: la cuenta de la lista (importada con el Gmail de Campus) nunca entro y su
    // codigo lo puso el docente: Nina entra con otro Gmail, su codigo y su nombre, y se une sola.
    const viaGmail = await google("nina.personal@gmail.com", { studentCode: "2381111", name: "Nina Campos" });
    assert.equal(viaGmail.data.ok, true, JSON.stringify(viaGmail.data));
    assert.equal(viaGmail.data.session?.user.id, created.data.user.id, "llega a la cuenta de la lista");
    // Ya entro: otro correo con el mismo codigo vuelve a pedir aprobacion.
    const intruder = await google("alguien.nuevo@gmail.com", { studentCode: "2381111" });
    assert.equal(intruder.data.step, "pending_approval", "una cuenta en uso no se entrega sin aprobacion");
    assert.equal(intruder.data.session, undefined);

    // Una cuenta de la lista institucional no se entrega a un Gmail con su codigo (aunque no haya
    // entrado): su dueño entra con Google institucional sin codigo.
    const institutional = await call<{ ok: boolean; user: ManagedUser }>(baseUrl, "POST", "/api/admin/users", {
      sessionId: teacher,
      body: { role: "student", email: "olga@correounivalle.edu.co", displayName: "Olga", password: "Temporal123!", studentCode: "2384444" },
    });
    assert.equal(institutional.status, 200);
    const takeoverTry = await google("otra.persona@gmail.com", { studentCode: "2384444" });
    assert.equal(takeoverTry.data.step, "pending_approval");
    const olga = await google("olga@correounivalle.edu.co");
    assert.equal(olga.data.session?.user.id, institutional.data.user.id, "Olga entra con su correo, sin codigo");

    // Un estudiante con codigo que pasa a docente pierde el codigo y sus sesiones.
    const promoted = await database.createManagedUser({ role: "student", email: "pablo@correounivalle.edu.co", displayName: "Pablo", password: "Pablo-12345", teacherUserId: "user-teacher-demo", studentCode: "2382222" });
    const adminSession = "sesion-admin-codigo";
    await database.pool.query("insert into app_sessions (id, user_id) values ($1, 'user-admin-demo')", [adminSession]);
    const toTeacher = await call<{ ok: boolean }>(baseUrl, "PUT", `/api/admin/users/${promoted.id}`, { sessionId: adminSession, body: { role: "teacher" } });
    assert.equal(toTeacher.status, 200, JSON.stringify(toTeacher.data));
    assert.equal(await database.getStudentCodeForUser(promoted.id), null);
    const takeover = await google("pablo.falso@correounivalle.edu.co", { studentCode: "2382222" });
    assert.equal(takeover.data.ok, true, "el codigo quedo libre: es una cuenta nueva, no la del docente");
    assert.notEqual(takeover.data.session?.user.id, promoted.id);
    assert.equal(takeover.data.session?.user.role, "student");

    // Y si un codigo quedara en una cuenta que no es de estudiante, no da acceso.
    await database.pool.query("insert into student_codes (code, user_id) values ('2383333', 'user-teacher-demo')");
    const teacherCode = await google("quien.sea@correounivalle.edu.co", { studentCode: "2383333" });
    assert.equal(teacherCode.status, 400);
    assert.match(String(teacherCode.data.error), /no corresponde a una cuenta de estudiante/);
  } finally {
    restore();
    await stopTestServer(server, database);
  }
});

test("codigo de estudiante: si otro se queda con el codigo al mismo tiempo, la cuenta creada se borra y no queda bloqueada", async () => {
  const { server, database, baseUrl } = await startTestServer();
  const { google, restore } = simulateGoogle(baseUrl);
  const db = database as unknown as { insertStudentCode: (code: string, userId: string, by: string | null) => Promise<boolean> };
  const original = db.insertStudentCode.bind(database);
  let calls = 0;
  try {
    db.insertStudentCode = async (code, userId, by) => {
      calls += 1;
      return calls === 1 ? false : original(code, userId, by);
    };
    const first = await google("rita@correounivalle.edu.co", { studentCode: "2391111" });
    assert.equal(first.data.ok, true, JSON.stringify(first.data));
    const rows = await database.pool.query<{ id: string; is_active: boolean }>(`select id, is_active from users where lower(email) = 'rita@correounivalle.edu.co'`);
    assert.equal(rows.rows.length, 1, "una sola cuenta");
    assert.equal(rows.rows[0].is_active, true);
  } finally {
    db.insertStudentCode = original;
    restore();
    await stopTestServer(server, database);
  }
});

test("codigo de estudiante: demasiados intentos con codigos ajenos se frenan", async () => {
  const { server, database, baseUrl } = await startTestServer();
  const { google, restore } = simulateGoogle(baseUrl);
  try {
    // Esperar la aprobacion pulsando «Revisar de nuevo» (el mismo codigo) no cuenta.
    const owner = await google("dueno@correounivalle.edu.co", { studentCode: "2318888" });
    assert.equal(owner.data.ok, true);
    for (let index = 0; index < 8; index += 1) {
      const waiting = await google("paciente@gmail.com", { studentCode: "2318888" });
      assert.equal(waiting.data.step, "pending_approval", `revision ${index + 1}`);
    }
    const teacher = await teacherSession(baseUrl);
    const request = (await call<UsersReply>(baseUrl, "GET", "/api/admin/users", { sessionId: teacher })).data.accessRequests[0];
    const changed = await call<{ ok: boolean; error?: string }>(baseUrl, "POST", `/api/admin/access-requests/${encodeURIComponent(request.id)}`, {
      sessionId: teacher,
      body: { decision: "approve", studentCode: "2319999" },
    });
    assert.equal(changed.status, 400, "se decide la solicitud que se vio");
    await call(baseUrl, "POST", `/api/admin/access-requests/${encodeURIComponent(request.id)}`, {
      sessionId: teacher,
      body: { decision: "approve", studentCode: "2318888" },
    });
    const approved = await google("paciente@gmail.com", { studentCode: "2318888" });
    assert.equal(approved.data.ok, true, "aprobado entra aunque haya revisado muchas veces");

    // Probar codigos distintos si se frena: al septimo, 429; repetir uno ya probado no.
    for (const code of ["1", "12", "123", "1234", "12345", "123456"]) {
      const miss = await google("prueba.codigos@gmail.com", { studentCode: code });
      assert.equal(miss.status, 400);
    }
    const blocked = await google("prueba.codigos@gmail.com", { studentCode: "2311111" });
    assert.equal(blocked.status, 429);
    assert.match(String(blocked.data.error), /Demasiados intentos/);
    const repeated = await google("prueba.codigos@gmail.com", { studentCode: "12" });
    assert.equal(repeated.status, 400, "repetir un codigo ya probado no revela nada nuevo");
    const otherEmail = await google("otra.persona@correounivalle.edu.co", { studentCode: "2311112" });
    assert.equal(otherEmail.data.ok, true, "el limite es por correo");
  } finally {
    restore();
    await stopTestServer(server, database);
  }
});

test("codigo de estudiante: el retiro encuentra a la persona por cualquier correo y borra tambien la cuenta unida", async () => {
  const { server, database, baseUrl } = await startTestServer();
  const { google, restore } = simulateGoogle(baseUrl);
  try {
    const teacher = await teacherSession(baseUrl);
    const gmail = "tomas.campus@gmail.com";
    await call(baseUrl, "POST", "/api/admin/users/import", {
      sessionId: teacher,
      body: { courseCode: "FPOO", students: [{ email: gmail, displayName: "Tomas Campus" }] },
    });
    const tomas = await google("tomas@correounivalle.edu.co", { studentCode: "2401111" });
    const tomasId = String(tomas.data.session?.user.id);
    await google(gmail, { studentCode: "2401111" });
    const request = (await call<UsersReply>(baseUrl, "GET", "/api/admin/users", { sessionId: teacher })).data.accessRequests[0];
    await call(baseUrl, "POST", `/api/admin/access-requests/${encodeURIComponent(request.id)}`, { sessionId: teacher, body: { decision: "approve" } });

    const report = await withdrawParticipant(database.pool, { email: gmail, confirm: true, salt: "sal-de-prueba" });
    assert.equal(report.found, true);
    assert.equal(report.counts.cuentas, 2, "la cuenta que prevalece y la unida");
    assert.equal(report.counts.student_codes, 1);
    const left = await database.pool.query<{ id: string; is_active: boolean; email: string }>(
      `select id, is_active, email from users where id = $1 or merged_into_user_id = $1`,
      [tomasId],
    );
    assert.equal(left.rows.length, 2);
    assert.ok(left.rows.every((row) => !row.is_active && row.email.endsWith("@retirado.invalid")));
    assert.equal((await database.pool.query(`select email from user_login_emails where user_id = $1`, [tomasId])).rows.length, 0);
    assert.equal((await database.pool.query(`select id from student_access_requests where email = $1`, [gmail])).rows.length, 0);

    // Quien solo pidio entrar (sin cuenta) tambien se puede retirar: su solicitud se borra.
    await google("solo.pidio@gmail.com", { studentCode: "0000001" });
    const onlyRequest = await withdrawParticipant(database.pool, { email: "solo.pidio@gmail.com", confirm: true, salt: "sal-de-prueba" });
    assert.equal(onlyRequest.found, true);
    assert.equal(onlyRequest.counts.student_access_requests_por_correo, 1);
    assert.equal((await database.pool.query(`select id from student_access_requests where email = 'solo.pidio@gmail.com'`)).rows.length, 0);
  } finally {
    restore();
    await stopTestServer(server, database);
  }
});

// «Eliminar seleccionados» (0.7.22): una lista importada con nombres errados se borra y se vuelve a
// importar. Quien nunca entró se borra del todo (con su código y su curso); quien ya entró se
// desactiva y conserva sus datos; docentes, cuentas de otro grupo e ids que no existen no se tocan.
test("0.7.22: eliminar varios estudiantes borra a los que nunca entraron y desactiva a los que ya entraron", async () => {
  const { server, database, baseUrl } = await startTestServer();
  const { google, restore } = simulateGoogle(baseUrl);
  try {
    const teacher = await teacherSession(baseUrl);
    const admin = String((await call<AuthReply>(baseUrl, "POST", "/api/auth/login", { body: { email: "admin@adaceen.edu.co", password: "Admin123!" } })).data.session?.id);
    const teacherId = String((await call<AuthReply>(baseUrl, "GET", "/api/auth/me", { sessionId: teacher })).data.session?.user.id);

    // Lista importada con los nombres mal (y un código), más un estudiante que ya entró.
    const imported = await call<{ ok: boolean; created: Array<{ id: string; email: string }>; error?: string }>(baseUrl, "POST", "/api/admin/users/import", {
      sessionId: teacher,
      body: {
        courseCode: "FPOO",
        students: [
          { email: "carla.campos@correounivalle.edu.co", displayName: "Cccampos Carla", studentCode: "2312001" },
          { email: "dario.mejia@correounivalle.edu.co", displayName: "Dmmejia Dario" },
        ],
      },
    });
    assert.equal(imported.status, 200, imported.data.error);
    const [carla, dario] = imported.data.created;
    const signedIn = await google("elena.ruiz@correounivalle.edu.co", { studentCode: "2312003" });
    assert.equal(signedIn.data.ok, true);
    const elenaId = String(signedIn.data.session?.user.id);

    // El estudiante no puede; la lista vacía es un error.
    const studentSession = String(signedIn.data.session?.id);
    assert.equal((await call(baseUrl, "POST", "/api/admin/users/bulk-delete", { sessionId: studentSession, body: { userIds: [carla.id] } })).status, 403);
    assert.equal((await call(baseUrl, "POST", "/api/admin/users/bulk-delete", { sessionId: teacher, body: { userIds: [] } })).status, 400);

    type Removal = { ok: boolean; deleted: Array<{ id: string }>; deactivated: Array<{ id: string; reason: string }>; skipped: Array<{ id: string; reason: string }> };
    const removed = await call<Removal>(baseUrl, "POST", "/api/admin/users/bulk-delete", {
      sessionId: teacher,
      body: { userIds: [carla.id, dario.id, elenaId, teacherId, "no-existe", carla.id] },
    });
    assert.equal(removed.status, 200, JSON.stringify(removed.data));
    assert.deepEqual(removed.data.deleted.map((entry) => entry.id).sort(), [carla.id, dario.id].sort(), "los que nunca entraron se borran");
    assert.deepEqual(removed.data.deactivated.map((entry) => entry.id), [elenaId]);
    assert.match(removed.data.deactivated[0].reason, /conserva sus datos/);
    assert.deepEqual(removed.data.skipped.map((entry) => entry.id), [teacherId, "no-existe"]);
    assert.equal(await countUsersWithEmail(database, "carla.campos@correounivalle.edu.co"), 0);
    assert.equal(await database.getStudentCodeOwnerId("2312001"), null, "el código queda libre");

    const users = await call<UsersReply>(baseUrl, "GET", "/api/admin/users", { sessionId: teacher });
    assert.equal(users.data.users.find((user) => user.id === elenaId)?.isActive, false);

    // Se vuelve a importar con el nombre correcto: cuenta nueva, con su código.
    const again = await call<{ ok: boolean; created: Array<{ id: string; displayName: string }>; codes: { assigned: number } }>(baseUrl, "POST", "/api/admin/users/import", {
      sessionId: teacher,
      body: { courseCode: "FPOO", students: [{ email: "carla.campos@correounivalle.edu.co", displayName: "Campos Carla", studentCode: "2312001" }] },
    });
    assert.equal(again.data.created[0]?.displayName, "Campos Carla");
    assert.equal(again.data.codes.assigned, 1);

    // El docente no elimina estudiantes de otro grupo; el administrador sí.
    const otherTeacher = await call<{ ok: boolean; user: { id: string } }>(baseUrl, "POST", "/api/admin/users", {
      sessionId: admin,
      body: { role: "teacher", email: "otra.docente@correounivalle.edu.co", displayName: "Otra Docente", password: "Clave1234" },
    });
    const foreign = await call<{ ok: boolean; user: { id: string }; error?: string }>(baseUrl, "POST", "/api/admin/users", {
      sessionId: admin,
      body: { role: "student", email: "fabio.ajeno@correounivalle.edu.co", displayName: "Fabio Ajeno", password: "Clave1234", teacherUserId: otherTeacher.data.user.id },
    });
    assert.equal(foreign.status, 200, foreign.data.error);
    const byTeacher = await call<Removal>(baseUrl, "POST", "/api/admin/users/bulk-delete", { sessionId: teacher, body: { userIds: [foreign.data.user.id] } });
    assert.match(byTeacher.data.skipped[0]?.reason || "", /otro docente/);
    const byAdmin = await call<Removal>(baseUrl, "POST", "/api/admin/users/bulk-delete", { sessionId: admin, body: { userIds: [foreign.data.user.id] } });
    assert.deepEqual(byAdmin.data.deleted.map((entry) => entry.id), [foreign.data.user.id]);

    // «Eliminar» de una fila sigue desactivando (antes su SQL tenía «id» ambiguo en el RETURNING).
    const single = await call<{ ok: boolean; user?: { isActive: boolean }; error?: string }>(baseUrl, "DELETE", `/api/admin/users/${again.data.created[0].id}`, { sessionId: teacher });
    assert.equal(single.status, 200, single.data.error);
    assert.equal(single.data.user?.isActive, false);
  } finally {
    restore();
    await stopTestServer(server, database);
  }
});

test("despues del examen 28-10: el correo institucional nuevo escribe su codigo y llega a su fila de la lista si el nombre coincide", async () => {
  const { server, database, baseUrl } = await startTestServer();
  const { google, restore } = simulateGoogle(baseUrl);
  try {
    const teacher = await teacherSession(baseUrl);
    // La lista de Campus trae a tres con su Gmail: Valentina con codigo, Juan sin codigo y
    // Camila con codigo (alguien intentara entrar con el).
    const imported = await call<{ ok: boolean; created: Array<{ id: string; email: string }> }>(baseUrl, "POST", "/api/admin/users/import", {
      sessionId: teacher,
      body: {
        courseCode: "FPOO",
        students: [
          { email: "valen.rios92@gmail.com", displayName: "Valentina Ríos", studentCode: "2398765" },
          { email: "juanes.paz@hotmail.com", displayName: "Juan Esteban Paz" },
          { email: "cami.leon@gmail.com", displayName: "Camila León", studentCode: "2397777" },
        ],
      },
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.data));
    const rowOf = (email: string) => String(imported.data.created.find((row) => row.email === email)?.id);

    // Sin codigo: lo pide y no crea nada (antes entraba a una cuenta nueva y quedaba duplicado).
    const first = await google("valentina.rios@correounivalle.edu.co", { name: "Valentina Rios" });
    assert.equal(first.data.ok, false);
    assert.equal(first.data.step, "student_code");
    assert.equal(await countUsersWithEmail(database, "valentina.rios@correounivalle.edu.co"), 0);

    // Con el codigo de su fila y su nombre: entra a esa fila (mismo user_id, mismo docente).
    const valentina = await google("valentina.rios@correounivalle.edu.co", { studentCode: "2398765", name: "VALENTINA RIOS GARCIA" });
    assert.equal(valentina.data.ok, true, JSON.stringify(valentina.data));
    assert.equal(valentina.data.session?.user.id, rowOf("valen.rios92@gmail.com"), "llega a su fila de la lista");
    assert.equal(await countUsersWithEmail(database, "valentina.rios@correounivalle.edu.co"), 0, "no se crea otra cuenta");
    const again = await google("valentina.rios@correounivalle.edu.co", { name: "Valentina Rios" });
    assert.equal(again.data.session?.user.id, rowOf("valen.rios92@gmail.com"), "la segunda vez entra sin codigo");

    // Fila sin codigo en la lista: un codigo libre y el mismo nombre la encuentran.
    const juan = await google("juan.paz@correounivalle.edu.co", { studentCode: "2391234", name: "Juan Esteban Paz" });
    assert.equal(juan.data.ok, true, JSON.stringify(juan.data));
    assert.equal(juan.data.session?.user.id, rowOf("juanes.paz@hotmail.com"));
    assert.equal(await database.getStudentCodeForUser(rowOf("juanes.paz@hotmail.com")), "2391234", "la fila queda con su codigo");

    // Un codigo libre y un nombre solo parecido no se lleva una fila: cuenta nueva (y el panel la marca).
    const near = await google("juan.paz2@correounivalle.edu.co", { studentCode: "2391235", name: "Camila Leon Rojas" });
    assert.equal(near.data.ok, true, JSON.stringify(near.data));
    assert.notEqual(near.data.session?.user.id, rowOf("cami.leon@gmail.com"), "Camila Leon Rojas no es la fila de Camila Leon");

    // El codigo de otra fila con otro nombre: no entra; queda pendiente de que el docente apruebe.
    const stranger = await google("pedro.otro@correounivalle.edu.co", { studentCode: "2397777", name: "Pedro Otro" });
    assert.equal(stranger.data.step, "pending_approval", JSON.stringify(stranger.data));
    assert.equal(stranger.data.session, undefined);
    const pending = await call<UsersReply>(baseUrl, "GET", "/api/admin/users", { sessionId: teacher });
    assert.equal(pending.data.accessRequests[0]?.target.id, rowOf("cami.leon@gmail.com"));

    // Codigo libre sin fila con su nombre: cuenta nueva con ese codigo, como siempre.
    const fresh = await google("luis.nuevo@correounivalle.edu.co", { studentCode: "2390001", name: "Luis Nuevo" });
    assert.equal(fresh.data.ok, true, JSON.stringify(fresh.data));
    const freshId = String(fresh.data.session?.user.id);
    assert.equal(await database.getStudentCodeForUser(freshId), "2390001");
    assert.ok(await database.createEditorSession({ userId: freshId, label: "prueba", ttlMs: 60_000 }), "tiene editor");

    // De la lista con correo institucional (importada sin codigo): entra a su cuenta, sin codigo.
    const martaRow = await database.createManagedUser({
      role: "student",
      email: "marta.lista@correounivalle.edu.co",
      displayName: "Marta Lista",
      password: "Temporal-12345",
      teacherUserId: "user-teacher-demo",
    });
    const marta = await google("marta.lista@correounivalle.edu.co");
    assert.equal(marta.data.ok, true, JSON.stringify(marta.data));
    assert.equal(marta.data.session?.user.id, martaRow.id);

    // El arranque no le cierra la sesion: esta identificada por el correo institucional.
    const sessionId = String(marta.data.session?.id);
    await database.closeSessionsOfStudentsWithoutCode();
    assert.ok(await database.getSession(sessionId), "la sesion sigue abierta");
  } finally {
    restore();
    await stopTestServer(server, database);
  }
});

test("panel: los duplicados que ya existen se marcan, sin unir ni mover nada; las cuentas de muestra no cuentan", async () => {
  const { server, database, baseUrl } = await startTestServer();
  const { google, restore } = simulateGoogle(baseUrl);
  try {
    const teacher = await teacherSession(baseUrl);
    // Como quedo el examen: la fila de la lista con el Gmail (nunca entro) y la cuenta nueva con la
    // que el estudiante entro con su correo institucional antes de este cambio.
    const listed = await database.createManagedUser({ role: "student", email: "sara.campus@gmail.com", displayName: "Sara Velásquez", password: "Temporal-12345", teacherUserId: "user-teacher-demo" });
    const entered = await database.createManagedUser({ role: "student", email: "sara.velasquez@correounivalle.edu.co", displayName: "SARA VELASQUEZ", password: "Temporal-12345", teacherUserId: "user-teacher-demo" });
    await database.openSessionForUser(entered.id);
    await database.createManagedUser({ role: "student", email: "tomas@correounivalle.edu.co", displayName: "Tomás Ruiz", password: "Temporal-12345", teacherUserId: "user-teacher-demo" });

    type Students = { totals: { students: number; possibleDuplicates: number; sampleAccounts: number }; students: Array<{ id: string; sampleAccount: boolean; possibleDuplicates: Array<{ otherUserId: string; reason: string }> }> };
    const list = await call<Students>(baseUrl, "GET", "/api/admin/students", { sessionId: teacher });
    assert.equal(list.status, 200, JSON.stringify(list.data));
    const byId = new Map(list.data.students.map((student) => [student.id, student]));
    assert.equal(byId.get(listed.id)?.possibleDuplicates[0]?.otherUserId, entered.id);
    assert.match(String(byId.get(listed.id)?.possibleDuplicates[0]?.reason), /Nunca ha entrado/);
    assert.equal(byId.get(entered.id)?.possibleDuplicates[0]?.otherUserId, listed.id);
    assert.match(String(byId.get(entered.id)?.possibleDuplicates[0]?.reason), /puede ser su fila de la lista/);
    assert.equal(list.data.totals.possibleDuplicates, 2);
    assert.equal(byId.get("user-student-demo")?.sampleAccount, true, "el estudiante demo sale marcado");
    assert.equal(list.data.totals.sampleAccounts, 1);
    assert.equal(list.data.totals.students, 3, "sin el estudiante demo");

    // Marcar no mueve nada: las dos cuentas siguen activas y separadas.
    const rows = await database.pool.query<{ id: string; is_active: boolean; merged_into_user_id: string | null }>(
      `select id, is_active, merged_into_user_id from users where id in ($1, $2)`,
      [listed.id, entered.id],
    );
    assert.deepEqual(rows.rows.map((row) => [row.is_active, row.merged_into_user_id]), [[true, null], [true, null]]);
    // Y la cuenta institucional sigue entrando a la suya.
    const sara = await google("sara.velasquez@correounivalle.edu.co", { name: "Sara Velasquez" });
    assert.equal(sara.data.session?.user.id, entered.id);
  } finally {
    restore();
    await stopTestServer(server, database);
  }
});

test("nombres: misma persona con o sin tildes, en otro orden o con el nombre corto; una sola palabra no basta", () => {
  assert.equal(personNamesMatch("Valentina Ríos", "VALENTINA RIOS GARCIA"), true);
  assert.equal(personNamesMatch("López de la Cruz, Ana", "ana lopez cruz"), true);
  assert.equal(personNamesMatch("Juan Esteban Paz", "Juan Paz"), true);
  assert.equal(personNamesMatch("Juan Esteban Paz", "Juan Pérez"), false);
  assert.equal(personNamesMatch("Nina", "Nina Campos"), false, "una palabra no identifica a nadie");
  assert.equal(personNamesMatch("", "Nina Campos"), false);
  // Sin codigo que diga cual fila es, se exigen las mismas palabras.
  assert.equal(personNamesEqual("Juan Esteban Paz", "JUAN ESTEBAN PAZ"), true);
  assert.equal(personNamesEqual("Paz, Juan Esteban", "juan esteban paz"), true);
  assert.equal(personNamesEqual("Juan Paz", "Juan Esteban Paz"), false, "un nombre mas corto puede ser otro estudiante");
});

test("revision 29-10: sin codigo en la lista, el nombre solo une si tiene 3 palabras y nadie mas se llama asi", async () => {
  const { server, database, baseUrl } = await startTestServer();
  const { google, restore } = simulateGoogle(baseUrl);
  try {
    const teacher = await teacherSession(baseUrl);
    const imported = await call<{ ok: boolean; created: Array<{ id: string; email: string }> }>(baseUrl, "POST", "/api/admin/users/import", {
      sessionId: teacher,
      body: {
        courseCode: "FPOO",
        students: [
          { email: "ana.cruz.77@gmail.com", displayName: "Ana de la Cruz" },
          { email: "sara.toro.1@gmail.com", displayName: "Sara Milena Toro" },
        ],
      },
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.data));
    const rowOf = (email: string) => String(imported.data.created.find((row) => row.email === email)?.id);
    // Otra Sara Milena Toro ya tiene cuenta (otro grupo, ya con su correo institucional).
    await database.createManagedUser({ role: "student", email: "sara.toro@correounivalle.edu.co", displayName: "SARA MILENA TORO", password: "Temporal-12345" });

    // «Ana de la Cruz» son 2 palabras sin conectores: no basta para quedarse con la fila.
    const ana = await google("ana.cruz@correounivalle.edu.co", { studentCode: "2395551", name: "Ana Cruz" });
    assert.equal(ana.data.ok, true, JSON.stringify(ana.data));
    assert.notEqual(ana.data.session?.user.id, rowOf("ana.cruz.77@gmail.com"), "dos palabras no unen");

    // Dos personas con el mismo nombre: no se une ninguna por el nombre.
    const sara = await google("sara.milena.toro@correounivalle.edu.co", { studentCode: "2395552", name: "Sara Milena Toro" });
    assert.equal(sara.data.ok, true, JSON.stringify(sara.data));
    assert.notEqual(sara.data.session?.user.id, rowOf("sara.toro.1@gmail.com"), "el nombre no es unico");
  } finally {
    restore();
    await stopTestServer(server, database);
  }
});
