import assert from "node:assert/strict";
import test from "node:test";
import { PRIVACY_POLICY_VERSION } from "../../../src/routes/pages/privacy-policy-routes.js";
import { REPO, SESSION, type Json } from "./harness-config.js";
import { FakeBrowser } from "./harness-backend.js";
import { drive, openTab, assertKnownShadowIds, seedLoggedInBrowser } from "./harness-utils.js";
import { fpooBitacoraLatest, DOMINGO_SEMANA_5, openStudentAgenda, ADMIN_SESSION } from "./harness-helpers.js";

// ---- Piloto con FPOO-01 (0.7.21): importar la lista de Campus y el tema del piloto ----

// La lista de «Participantes» de Campus como la exporta el curso (BOM, comillas y CRLF): dos
// profesores (el administrador y Victor, que aun no tiene cuenta), tres estudiantes (uno ya
// tiene cuenta y otro usa Gmail) y uno suspendido.
const CAMPUS_ROSTER_CSV = "﻿Nombre,Correo electrónico,Roles,Número de ID,Estatus\r\n"
  + "\"BUCHELI GUERRERO VICTOR ANDRES\",victor.bucheli@correounivalle.edu.co,Profesor Turnitin,,Activo\r\n"
  + "\"SUAREZ ADMIN PRUEBA\",admin@correounivalle.edu.co,Profesor,,Activo\r\n"
  + "\"PEREZ GONZALEZ ANA MARIA\",ana.maria.perez.gonzalez@correounivalle.edu.co,Estudiante,2026001,Activo\r\n"
  + "\"DIAZ DE LA CRUZ BRUNO\",bruno.diaz@correounivalle.edu.co,Estudiante,2026002,Activo\r\n"
  + "\"LOPEZ CARLA\",carla.lopez@gmail.com,Estudiante,2026003,Activo\r\n"
  + "\"MUÑOZ JUAN\",juan.munoz@correounivalle.edu.co,Estudiante,2026004,Suspendido\r\n";

test("0.7.21: el administrador importa la lista de Campus: solo los de la universidad por defecto, crea al docente de la lista y fija el de las cuentas nuevas", async () => {
  const browser = new FakeBrowser();
  browser.session = ADMIN_SESSION;
  browser.defaultTeacher = { teacherUserId: "u-docente", chosenTeacherUserId: null, source: "oldest", chosenInactive: false, updatedAt: null, updatedByName: null };
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-admin": PRIVACY_POLICY_VERSION } });
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => tab.state().loading === false, 400);
  await drive(browser, tab.el("tabBtnUsuarios").click());
  await browser.clock.until(() => tab.el("adminUsersTableBody").children.length >= 2 && !tab.state().adminUsersBusy, 400);

  // Docente de las cuentas nuevas: automatico (el mas antiguo) hasta que se elija.
  assert.equal(tab.el("adminDefaultTeacherRow").hidden, false);
  assert.equal(tab.el("adminDefaultTeacherSelect").value, "");
  assert.deepEqual(tab.el("adminDefaultTeacherSelect").children.map((option) => option.textContent), [
    "El profesor activo más antiguo (automático)",
    "Docente Prueba (docente@correounivalle.edu.co)",
  ]);
  assert.match(tab.el("adminDefaultTeacherNote").textContent, /primera vez con Google.*Ahora: Docente Prueba\./);

  // Importar lista: el CSV de Campus se lee en el navegador.
  assert.equal(tab.el("adminImportPanel").hidden, true);
  await drive(browser, tab.el("adminToggleImportBtn").click());
  assert.equal(tab.el("adminImportPanel").hidden, false);
  assert.equal(tab.el("adminToggleImportBtn").textContent, "Ocultar importación");
  assert.equal(tab.el("adminImportBtn").disabled, true, "sin lista no hay nada que importar");
  const input = tab.el("adminImportFileInput");
  input.files = [new File([CAMPUS_ROSTER_CSV], "participantes FPOO-01.csv")];
  await drive(browser, input.dispatch("change"), 800);
  await browser.clock.until(() => !!tab.state().adminImport?.roster, 400);
  // JSON: los objetos vienen del contexto de la pestaña (otro realm).
  const roster = JSON.parse(JSON.stringify(tab.state().adminImport.roster));
  assert.deepEqual(roster.students.map((student: Json) => [student.email, student.displayName, student.institutional]), [
    ["ana.maria.perez.gonzalez@correounivalle.edu.co", "Perez Gonzalez Ana Maria", true],
    ["bruno.diaz@correounivalle.edu.co", "Diaz de la Cruz Bruno", true],
    ["carla.lopez@gmail.com", "Lopez Carla", false],
  ], "nombres en tipo título; el suspendido queda fuera");
  assert.equal(roster.inactive, 1);
  assert.equal(tab.el("adminImportFileName").textContent, "participantes FPOO-01.csv");
  assert.match(tab.el("adminImportSummary").textContent, /3 estudiantes y 2 docentes\. 2 con correo @correounivalle\.edu\.co y 1 con otro correo \(Gmail u otro\)\. Los de otro correo no se importan/);
  assert.equal(tab.el("adminImportBtn").textContent, "Importar 2 estudiantes");
  assert.equal(tab.el("adminImportIncludeOtherRow").hidden, false);
  assert.equal(tab.el("adminImportIncludeOtherLabel").textContent, "Incluir también el de otro correo");

  // Los docentes de la lista: el administrador es quien importa; Victor no tiene cuenta.
  const teacherItems = tab.el("adminImportTeachers").children;
  assert.equal(teacherItems.length, 2);
  assert.equal(teacherItems[1].children[0].textContent, "Suarez Admin Prueba (Profesor en Campus): eres tú (administrador).");
  assert.equal(teacherItems[0].children[0].textContent, "Bucheli Guerrero Victor Andres (Profesor Turnitin en Campus): sin cuenta en ADACEEN.");
  assert.equal(teacherItems[0].children[1].textContent, "Crear su cuenta de docente");
  assert.equal(tab.state().adminImport.teacherUserId, "u-docente", "mientras tanto, el unico docente activo");
  await drive(browser, teacherItems[0].children[1].click(), 800);
  await browser.clock.until(() => !tab.state().adminImport.busy, 400);
  assert.equal(browser.createdUsers.length, 1);
  assert.equal(browser.createdUsers[0].role, "teacher");
  assert.equal(browser.createdUsers[0].email, "victor.bucheli@correounivalle.edu.co");
  assert.equal(browser.createdUsers[0].displayName, "Bucheli Guerrero Victor Andres");
  assert.ok(String(browser.createdUsers[0].password).length >= 24, "clave al azar: entra con Google");
  assert.equal(tab.state().adminImport.teacherUserId, "u-nuevo-1", "queda elegido para la importación");
  assert.equal(tab.el("adminImportTeacher").value, "u-nuevo-1");
  assert.match(tab.el("adminImportSummary").textContent, /Bucheli Guerrero Victor Andres ya es docente en ADACEEN y queda elegido/);
  assert.equal(tab.el("adminImportTeachers").children[0].children[0].textContent, "Bucheli Guerrero Victor Andres (Profesor Turnitin en Campus): docente en ADACEEN.");
  assert.equal(tab.el("adminImportSetDefaultRow").hidden, false);
  assert.equal(tab.el("adminImportSetDefault").checked, true);
  assert.equal(tab.el("adminImportSetDefaultLabel").textContent, "Quien entre por primera vez con Google también queda con Bucheli Guerrero Victor Andres (curso FPOO)");

  // Importar: solo los dos de la universidad, al docente y curso elegidos; Victor queda como
  // docente de las cuentas nuevas.
  await drive(browser, tab.el("adminImportBtn").click(), 1200);
  await browser.clock.until(() => !tab.state().adminImport.busy, 400);
  assert.equal(browser.importRequests.length, 1);
  assert.deepEqual(browser.importRequests[0], {
    teacherUserId: "u-nuevo-1",
    courseCode: "FPOO",
    // 0.7.22: el «Número de ID» de Campus (codigo de estudiante) viaja con cada estudiante.
    students: [
      { email: "ana.maria.perez.gonzalez@correounivalle.edu.co", displayName: "Perez Gonzalez Ana Maria", studentCode: "2026001" },
      { email: "bruno.diaz@correounivalle.edu.co", displayName: "Diaz de la Cruz Bruno", studentCode: "2026002" },
    ],
  });
  assert.deepEqual(browser.defaultTeacherPuts, [{ teacherUserId: "u-nuevo-1" }]);
  assert.deepEqual(tab.el("adminImportResult").children.map((item) => item.textContent), [
    "1 cuenta nueva con Bucheli Guerrero Victor Andres en FPOO: entran con Google.",
    "1 estudiante ya tenía cuenta y pasó a Bucheli Guerrero Victor Andres en FPOO: Ana María Pérez González.",
  ]);
  assert.equal(tab.el("adminUsersStatus").textContent, "Lista importada: 1 nuevas y 1 actualizadas. Quien entre por primera vez con Google queda con Bucheli Guerrero Victor Andres.");
  assert.equal(tab.el("adminDefaultTeacherSelect").value, "u-nuevo-1");
  assert.match(tab.el("adminDefaultTeacherNote").textContent, /^Quien entra por primera vez con Google, o se crea sin docente, queda con este docente y el curso FPOO\.$/);
  assert.equal(tab.el("adminImportSetDefaultRow").hidden, true, "ya es el docente de las cuentas nuevas");

  // Repetir con los de otro correo: Carla se crea; Ana y Bruno ya estaban.
  tab.el("adminImportIncludeOther").checked = true;
  await drive(browser, tab.el("adminImportIncludeOther").dispatch("change"));
  assert.equal(tab.el("adminImportBtn").textContent, "Importar 3 estudiantes");
  await drive(browser, tab.el("adminImportBtn").click(), 1200);
  await browser.clock.until(() => !tab.state().adminImport.busy, 400);
  assert.equal(browser.importRequests.length, 2);
  assert.equal((browser.importRequests[1].students as Json[]).length, 3);
  assert.deepEqual(browser.defaultTeacherPuts.length, 1, "no se vuelve a guardar el mismo docente");
  assert.deepEqual(tab.el("adminImportResult").children.map((item) => item.textContent), [
    "1 cuenta nueva con Bucheli Guerrero Victor Andres en FPOO: entran con Google.",
    "2 ya estaban así.",
  ]);

  // Cambiar el docente de las cuentas nuevas desde su selector (vuelve al automatico).
  tab.el("adminDefaultTeacherSelect").value = "";
  await drive(browser, tab.el("adminDefaultTeacherSelect").dispatch("change"), 800);
  await browser.clock.until(() => !tab.state().adminUsersBusy, 400);
  assert.deepEqual(browser.defaultTeacherPuts.at(-1), { teacherUserId: null });
  assert.equal(tab.el("adminUsersStatus").textContent, "Las cuentas nuevas quedan con el profesor activo más antiguo.");

  // Una tabla pegada sin encabezado (copiada de la pagina) tambien se lee.
  const parsed = JSON.parse(tab.run<string>("JSON.stringify(parseCourseRoster('Seleccionar \\'ROJAS ELENA\\'\\telena.rojas@correounivalle.edu.co\\tEstudiante\\tNo hay grupos\\nPROFESOR UNO\\tprofe@correounivalle.edu.co\\tProfesor\\t'))")) as Json;
  assert.deepEqual((parsed.students as Json[]).map((student) => [student.email, student.displayName]), [["elena.rojas@correounivalle.edu.co", "Rojas Elena"]]);
  assert.deepEqual((parsed.teachers as Json[]).map((teacher) => teacher.email), ["profe@correounivalle.edu.co"]);

  await drive(browser, tab.el("adminImportCancelBtn").click());
  assert.equal(tab.el("adminImportPanel").hidden, true);
  assertKnownShadowIds(tab);
  assert.deepEqual(browser.unknownRoutes.filter((route) => !route.includes("/api/projects") && !route.includes("/api/behavior/summary")), []);
});

// La tabla de «Participantes» copiada de la página (datos inventados), como llega al
// portapapeles: el encabezado partido en líneas, el rótulo de cada casilla en su línea, el nombre
// con las iniciales del avatar pegadas (Rojas tiene foto: sin iniciales) y el rol, los grupos, el
// acceso y el estatus en líneas aparte. Alvarez es la monitora del curso (Profesor en Campus).
const CAMPUS_ROSTER_PAGE = [
  "Seleccionar todos",
  "Apellido(s)",
  "Ordenar por Apellido(s) Ascendente",
  " / Nombre",
  "Ordenar por Nombre Ascendente",
  "Correo electrónico",
  "Ordenar por Correo electrónico Ascendente",
  "Roles",
  "Estatus",
  "",
  "Seleccionar 'PEREZ GONZALEZ ANA MARIA'",
  "PAPEREZ GONZALEZ ANA MARIA\t2026001-3743\tana.perez@correounivalle.edu.co\t",
  "Estudiante ",
  "No hay grupos\t1 día 2 horas\t",
  "Activo   ",
  "",
  "Seleccionar 'ALVAREZ RUIZ MONICA'",
  "ARALVAREZ RUIZ MONICA\t2242000-3743\tmonica.alvarez@correounivalle.edu.co\t",
  "Profesor ",
  "No hay grupos\t1 día\t",
  "Activo   ",
  "",
  "Seleccionar 'ROJAS LUIS'",
  "ROJAS LUIS\t13070000\tluis.rojas@correounivalle.edu.co\t",
  "Profesor Turnitin ",
  "No hay grupos\t3 días\t",
  "Activo   ",
  "",
  "Seleccionar 'CASTRO MEJIA CAMILO'",
  "CMCASTRO MEJIA CAMILO\t2026003-3743\tcamilo.castro@gmail.com\t",
  "Estudiante ",
  "No hay grupos\t2 horas 5 minutos\t",
  "Activo   ",
  "",
  "Seleccionar 'ALARCON VELEZ LAURA'",
  "ALALARCON VELEZ LAURA\t2026004-3743\tlaura.alarcon@correounivalle.edu.co\t",
  "Estudiante ",
  "No hay grupos\t23 segundos\t",
  "Activo   ",
  "",
  "Seleccionar 'DIAZ DE LA CRUZ BRUNO'",
  "DBDIAZ DE LA CRUZ BRUNO\t2026005-3743\tbruno.diaz@correounivalle.edu.co\t",
  "Estudiante ",
  "No hay grupos\tNunca\t",
  "Suspendido   ",
].join("\n");

test("0.7.21: la tabla copiada de «Participantes» se lee sin las iniciales del avatar y reimportar corrige los nombres mal leídos", async () => {
  const browser = new FakeBrowser();
  browser.session = ADMIN_SESSION;
  // Cuentas de una importación anterior: Ana con las iniciales pegadas, Camilo con el correo y
  // el docente Rojas con iniciales; a Laura alguien le puso el nombre a mano. La monitora es
  // docente en ADACEEN, sin estudiantes, y va primero por nombre.
  browser.adminTeachers = [
    { id: "u-alvarez", email: "monica.alvarez@correounivalle.edu.co", displayName: "Alvarez Ruiz Monica" },
    { id: "u-rojas", email: "luis.rojas@correounivalle.edu.co", displayName: "Rlrojas Luis" },
  ];
  browser.defaultTeacher = { teacherUserId: "u-rojas", chosenTeacherUserId: "u-rojas", source: "admin", chosenInactive: false, updatedAt: null, updatedByName: null };
  browser.adminUsers = [
    { id: "u-alvarez", role: "teacher", email: "monica.alvarez@correounivalle.edu.co", displayName: "Alvarez Ruiz Monica", teacherUserId: null, assignedCourseCodes: [], isActive: true, createdAt: "2026-10-10T12:00:00.000Z" },
    { id: "u-rojas", role: "teacher", email: "luis.rojas@correounivalle.edu.co", displayName: "Rlrojas Luis", teacherUserId: null, assignedCourseCodes: [], isActive: true, createdAt: "2026-10-10T12:00:00.000Z" },
    { id: "u-ana", role: "student", email: "ana.perez@correounivalle.edu.co", displayName: "Paperez Gonzalez Ana Maria", teacherUserId: "u-rojas", teacherDisplayName: "Rlrojas Luis", assignedCourseCodes: ["FPOO"], isActive: true, createdAt: "2026-10-10T12:00:00.000Z" },
    { id: "u-camilo", role: "student", email: "camilo.castro@gmail.com", displayName: "camilo.castro", teacherUserId: "u-rojas", teacherDisplayName: "Rlrojas Luis", assignedCourseCodes: ["FPOO"], isActive: true, createdAt: "2026-10-10T12:00:00.000Z" },
    { id: "u-laura", role: "student", email: "laura.alarcon@correounivalle.edu.co", displayName: "Laura Alarcón", teacherUserId: "u-rojas", teacherDisplayName: "Rlrojas Luis", assignedCourseCodes: ["FPOO"], isActive: true, createdAt: "2026-10-10T12:00:00.000Z" },
  ];
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-admin": PRIVACY_POLICY_VERSION } });
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => tab.state().loading === false, 400);
  await drive(browser, tab.el("tabBtnUsuarios").click());
  await browser.clock.until(() => tab.el("adminUsersTableBody").children.length >= 5 && !tab.state().adminUsersBusy, 400);
  await drive(browser, tab.el("adminToggleImportBtn").click());

  // Pegar la tabla: nombres del rótulo de cada casilla, roles de sus líneas, el suspendido fuera.
  tab.el("adminImportText").value = CAMPUS_ROSTER_PAGE;
  await drive(browser, tab.el("adminImportText").dispatch("input"));
  const roster = JSON.parse(JSON.stringify(tab.state().adminImport.roster));
  assert.deepEqual(roster.students.map((student: Json) => [student.email, student.displayName]), [
    ["ana.perez@correounivalle.edu.co", "Perez Gonzalez Ana Maria"],
    ["camilo.castro@gmail.com", "Castro Mejia Camilo"],
    ["laura.alarcon@correounivalle.edu.co", "Alarcon Velez Laura"],
  ]);
  assert.deepEqual(roster.teachers.map((teacher: Json) => [teacher.email, teacher.displayName, teacher.roleLabel]), [
    ["monica.alvarez@correounivalle.edu.co", "Alvarez Ruiz Monica", "Profesor"],
    ["luis.rojas@correounivalle.edu.co", "Rojas Luis", "Profesor Turnitin"],
  ]);
  assert.equal(roster.inactive, 1);
  assert.match(tab.el("adminImportSummary").textContent, /Lista pegada: 3 estudiantes y 2 docentes\. .*1 suspendido en Campus queda fuera\. Al importar también se corrigen 3 nombres que quedaron mal leídos en una importación anterior\.$/);
  // El docente sugerido es el del grupo, no la monitora que va primero por nombre: el de las
  // cuentas nuevas y, sin él, el que más estudiantes tiene.
  assert.equal(tab.el("adminImportTeacher").value, "u-rojas");
  assert.equal(tab.run<string>("(() => { const saved = overlayState.adminDefaultTeacher; overlayState.adminDefaultTeacher = null; const id = suggestRosterTeacher(getAdminImportState()); overlayState.adminDefaultTeacher = saved; return id; })()"), "u-rojas");

  // Importar: además de la lista, corrige a Ana, Camilo (aunque su Gmail no se importe) y al
  // docente; el nombre que se puso a mano no se toca.
  await drive(browser, tab.el("adminImportBtn").click(), 1200);
  await browser.clock.until(() => !tab.state().adminImport.busy, 600);
  assert.deepEqual((browser.importRequests[0].students as Json[]).map((student) => student.displayName), ["Perez Gonzalez Ana Maria", "Alarcon Velez Laura"]);
  assert.deepEqual(browser.adminUserUpdates.map((update) => [update.id, update.body]), [
    ["u-rojas", { displayName: "Rojas Luis" }],
    ["u-ana", { displayName: "Perez Gonzalez Ana Maria" }],
    ["u-camilo", { displayName: "Castro Mejia Camilo" }],
  ]);
  assert.deepEqual(tab.el("adminImportResult").children.map((item) => item.textContent), [
    "2 ya estaban así.",
    "3 nombres corregidos: habían quedado con las iniciales de Campus o con el correo.",
  ]);
  assert.equal(tab.el("adminUsersStatus").textContent, "Lista importada: 0 nuevas y 0 actualizadas. 3 nombres corregidos.");
  assert.doesNotMatch(tab.el("adminImportSummary").textContent, /se corrigen/, "ya no queda nada que corregir");

  // Copiada desde la columna del nombre (sin rótulos): las iniciales se quitan porque casi todos
  // las traen, salvo donde el correo trae la palabra tal cual (Alarcón).
  const sinRotulos = CAMPUS_ROSTER_PAGE.split("\n").filter((line) => !line.startsWith("Seleccionar")).join("\n");
  tab.run(`window.__rosterSinRotulos = ${JSON.stringify(sinRotulos)}`);
  const parsed = JSON.parse(tab.run<string>("JSON.stringify(parseCourseRoster(window.__rosterSinRotulos))")) as Json;
  assert.deepEqual((parsed.students as Json[]).map((student) => student.displayName), ["Perez Gonzalez Ana Maria", "Castro Mejia Camilo", "Alarcon Velez Laura"]);
  assert.deepEqual((parsed.teachers as Json[]).map((teacher) => teacher.displayName), ["Alvarez Ruiz Monica", "Rojas Luis"]);
  assertKnownShadowIds(tab);
});

test("0.7.21: el docente elige el tema del piloto en «Estudiantes»: semana de la bitácora, tema y repositorio; un backend anterior lo dice", async () => {
  const browser = new FakeBrowser();
  browser.session = { ...SESSION, user: { ...SESSION.user, id: "u-docente", role: "teacher", displayName: "Docente Prueba", assignedCourseCodes: [] } };
  // Viernes 9 de octubre: la proxima clase es la semana 7 (14 de octubre).
  browser.clock.now = Date.parse("2026-10-09T15:00:00.000Z");
  browser.pilotTopicWeeks = [
    { week: 6, dateKey: "2026-10-07", topic: "Herencia y polimorfismo", activities: [] },
    { week: 7, dateKey: "2026-10-14", topic: "Abstracción, encapsulamiento y test", activities: ["Ejercicio IMC"] },
    { week: 8, dateKey: "2026-10-21", topic: "Reutilización de código, modularidad y refactoring", activities: ["Ejercicio Nutrición"] },
  ];
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-docente": PRIVACY_POLICY_VERSION } });
  const tab = await openTab(browser, "https://github.com/vbucheli/IMC", "vbucheli/IMC");
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);
  assert.deepEqual(browser.requestsTo("/api/pilot/topic"), [], "el docente lo consulta al abrir «Estudiantes»");

  await drive(browser, tab.el("tabBtnEstudiantes").click());
  await browser.clock.until(() => tab.state().pilotTopic?.loadedAt > 0, 400);
  assert.equal(browser.requestsTo("/api/pilot/topic", "GET").length, 1);
  assert.equal(tab.el("pilotTopicSection").hidden, false);
  assert.equal(tab.el("pilotTopicTeacherField").hidden, true, "el docente no elige docente");
  assert.equal(tab.el("pilotTopicChip").textContent, "Sin tema");
  assert.match(tab.el("pilotTopicStatus").textContent, /^Sin tema: elige la semana y el ejercicio\./);
  const weekSelect = tab.el("pilotTopicWeek");
  assert.deepEqual(weekSelect.children.map((option) => option.textContent), [
    "Sin semana (solo el tema)",
    "Semana 6 · mié 7 oct · Herencia y polimorfismo",
    "Semana 7 · mié 14 oct · Abstracción, encapsulamiento y test (próxima clase)",
    "Semana 8 · mié 21 oct · Reutilización de código, modularidad y refactoring",
  ]);
  assert.equal(weekSelect.value, "7", "por defecto, la semana de la próxima clase");
  assert.equal(tab.el("pilotTopicTitleInput").value, "Abstracción, encapsulamiento y test");
  assert.equal(tab.el("pilotTopicRepo").value, "");
  // En la página del repositorio, un clic lo pone como ejercicio.
  assert.equal(tab.el("pilotTopicUsePageRepoBtn").hidden, false);
  assert.equal(tab.el("pilotTopicUsePageRepoBtn").textContent, "Usar vbucheli/IMC");
  assert.equal(tab.el("pilotTopicClearBtn").disabled, true, "sin tema no hay que quitar");

  // Cambiar de semana trae su tema (mientras no se haya escrito otro).
  weekSelect.value = "8";
  await drive(browser, weekSelect.dispatch("change"));
  assert.equal(tab.el("pilotTopicTitleInput").value, "Reutilización de código, modularidad y refactoring");
  weekSelect.value = "7";
  await drive(browser, weekSelect.dispatch("change"));
  assert.equal(tab.el("pilotTopicTitleInput").value, "Abstracción, encapsulamiento y test");
  await drive(browser, tab.el("pilotTopicUsePageRepoBtn").click());
  assert.equal(tab.el("pilotTopicRepo").value, "vbucheli/IMC");
  assert.equal(tab.el("pilotTopicUsePageRepoBtn").hidden, true);

  await drive(browser, tab.el("pilotTopicSaveBtn").click(), 800);
  await browser.clock.until(() => !tab.state().pilotTopic.saving, 400);
  assert.deepEqual(browser.pilotTopicPuts, [{ courseCode: "FPOO", week: 7, title: "Abstracción, encapsulamiento y test", repoFullName: "vbucheli/IMC" }]);
  assert.equal(tab.el("pilotTopicChip").textContent, "Semana 7");
  assert.equal(tab.el("pilotTopicStatus").textContent, "Tema del piloto guardado (semana 7 · Abstracción, encapsulamiento y test · ejercicio vbucheli/IMC). Los estudiantes lo ven en Inicio y el tutor se enfoca en esa semana.");
  assert.equal(tab.el("pilotTopicClearBtn").disabled, false);

  // Un repositorio que no es de GitHub: el backend lo rechaza y el estado lo dice.
  tab.el("pilotTopicRepo").value = "https://gitlab.com/x/y";
  await drive(browser, tab.el("pilotTopicRepo").dispatch("input"));
  await drive(browser, tab.el("pilotTopicSaveBtn").click(), 800);
  await browser.clock.until(() => !tab.state().pilotTopic.saving, 400);
  assert.match(tab.el("pilotTopicStatus").textContent, /^No se pudo guardar el tema: El repositorio debe ser usuario\/repositorio/);
  assert.equal(tab.el("pilotTopicStatus").classList.contains("is-warning"), true);
  assert.equal(tab.state().pilotTopic.topic.repoFullName, "vbucheli/IMC", "el tema guardado sigue igual");

  // El tutor del docente tambien va con la semana del tema.
  const tutorWeek = tab.run<Json>("buildPilotTopicWeekForTutor({ courseCode: 'FPOO', weeks: [], totalWeeks: 0, upcoming: [] })");
  assert.equal(tutorWeek.week, 7);
  assert.equal(tutorWeek.topic, "Abstracción, encapsulamiento y test");

  await drive(browser, tab.el("pilotTopicClearBtn").click(), 800);
  await browser.clock.until(() => !tab.state().pilotTopic.saving, 400);
  assert.deepEqual(browser.pilotTopicPuts.at(-1), { clear: true });
  assert.equal(tab.el("pilotTopicChip").textContent, "Sin tema");
  assert.equal(tab.el("pilotTopicStatus").textContent, "Tema del piloto quitado: los estudiantes ya no lo ven en Inicio.");

  // Al abrir un estudiante, la tarjeta deja espacio al detalle.
  await drive(browser, tab.run("openStudentDetail('u-est-1')"), 800);
  assert.equal(tab.el("pilotTopicSection").hidden, true);
  assertKnownShadowIds(tab);

  // Un backend anterior (sin la ruta): lo dice, no deja guardar y no lo vuelve a consultar.
  const old = new FakeBrowser();
  old.session = browser.session;
  old.pilotTopicStatus = 404;
  seedLoggedInBrowser(old, { adaceenPrivacyAcceptedByUser: { "u-docente": PRIVACY_POLICY_VERSION } });
  const oldTab = await openTab(old, `https://github.com/${REPO}`, REPO);
  await drive(old, oldTab.run("openOverlay({ trigger: 'user' })"));
  await old.clock.until(() => oldTab.state().loading === false, 400);
  await drive(old, oldTab.el("tabBtnEstudiantes").click());
  await old.clock.until(() => oldTab.state().pilotTopic?.loadedAt > 0, 400);
  assert.equal(oldTab.el("pilotTopicStatus").textContent, "Este backend todavía no tiene el tema del piloto: llega con la versión 0.7.21.");
  assert.equal(oldTab.el("pilotTopicSaveBtn").disabled, true);
  await drive(old, oldTab.el("tabBtnInicio").click());
  await drive(old, oldTab.el("tabBtnEstudiantes").click());
  assert.equal(old.requestsTo("/api/pilot/topic").length, 1, "no se reintenta en la sesión");
});

test("0.7.21: el estudiante ve el tema de la clase en Inicio, abre el ejercicio en su editor y el tutor va con esa semana", async () => {
  const browser = new FakeBrowser();
  browser.clock.now = DOMINGO_SEMANA_5;
  browser.bitacoraLatest = await fpooBitacoraLatest();
  browser.pilotTopic = { courseCode: "FPOO", week: 7, title: "Abstracción, encapsulamiento y test", repoFullName: "vbucheli/IMC", updatedAt: "2026-09-26T12:00:00.000Z", updatedByName: "Docente Prueba" };
  browser.githubConnected = true;
  const tab = await openStudentAgenda(browser);
  await browser.clock.until(() => tab.state().pilotTopic?.loadedAt > 0, 400);
  assert.equal(browser.requestsTo("/api/pilot/topic").length, 1, "una consulta al entrar");

  // Inicio: el tema con su ejercicio, debajo de la semana del calendario.
  assert.equal(tab.el("pilotTopicHome").hidden, false);
  assert.equal(tab.el("pilotTopicHomeTitle").textContent, "Abstracción, encapsulamiento y test");
  // Dirección B (0.7.22): la semana va junto al título y el ejercicio es un par clave y valor.
  assert.equal(tab.el("pilotTopicHomeWeek").textContent, "FPOO · semana 7");
  assert.equal(tab.el("pilotTopicHomeRepo").textContent, "vbucheli/IMC");
  assert.equal(tab.el("pilotTopicHomeRepo").hidden, false);
  assert.equal(tab.el("pilotTopicOpenBtn").hidden, false);
  assert.equal(tab.el("pilotTopicOpenBtn").textContent, "Abrir el ejercicio en mi editor");
  assert.equal(tab.el("pilotTopicSection").hidden, true, "la tarjeta del docente no es para el estudiante");
  assert.equal(tab.el("agendaHomeEyebrow").textContent, "Estás en FPOO · semana 5 de 16", "la agenda sigue el calendario");

  // El tutor recibe la semana del tema (7), no la del calendario (5).
  const intervene = browser.requestsTo("/intervene")[0];
  assert.ok(intervene, "el tutor respondio al entrar");
  const week7 = tab.run<Json>("getCourseAgendaView().weeks.find((week) => week.week === 7)");
  const week8 = tab.run<Json>("getCourseAgendaView().weeks.find((week) => week.week === 8)");
  const courseWeek = ((intervene.body as Json).context as Json).courseWeek as Json;
  assert.equal(courseWeek.week, 7);
  assert.equal(courseWeek.totalWeeks, 16);
  assert.equal(courseWeek.topic, "Abstracción, encapsulamiento y test");
  assert.equal(courseWeek.weekStart, week7.dateKey);
  assert.equal(courseWeek.weekEnd, tab.run<string>(`courseKeyFromDay(${Number(week8.day) - 1})`));
  assert.equal((courseWeek.upcoming as Json[])[0].title, "Examen (Primer parcial)");

  // «Abrir el ejercicio en mi editor»: el editor en la nube abre ESE repositorio.
  await drive(browser, tab.el("pilotTopicOpenBtn").click(), 800);
  const prepare = browser.requestsTo("/api/workspaces/prepare", "POST").at(-1);
  assert.equal(prepare?.body?.repoFullName, "vbucheli/IMC", "el editor en la nube prepara ese repositorio");
  assert.match(tab.state().statusMessage, /Editor listo/);

  // Con Codespaces, el boton lleva al repositorio en GitHub.
  tab.run("overlayState.workspaceProvider = 'codespaces'; renderOverlay()");
  assert.equal(tab.el("pilotTopicOpenBtn").textContent, "Ver el ejercicio en GitHub");

  // Si el tema es de otro curso, no se muestra ni cambia la semana del tutor.
  tab.run("overlayState.pilotTopic.topic = { ...overlayState.pilotTopic.topic, courseCode: 'FPI' }; renderOverlay()");
  assert.equal(tab.el("pilotTopicHome").hidden, true);
  assert.equal(tab.run<Json>("buildCourseWeekForTutor()").week, 5);
  assertKnownShadowIds(tab);
});
