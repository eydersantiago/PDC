import assert from "node:assert/strict";
import test from "node:test";
import { personNamesEqual, personNamesMatch } from "../../../src/services/auth/student-code.js";
import { withdrawParticipant } from "../../../scripts/lib/retiro.js";
import {
  type AuthReply,
  type ManagedUser,
  type UsersReply,
  startTestServer,
  stopTestServer,
  call,
  simulateGoogle,
  teacherSession,
  countUsersWithEmail,
} from "./helpers.js";

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
