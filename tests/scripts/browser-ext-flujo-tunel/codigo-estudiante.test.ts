import assert from "node:assert/strict";
import test from "node:test";
import { PRIVACY_POLICY_VERSION } from "../../../src/routes/pages/privacy-policy-routes.js";
import { REPO, SESSION } from "./harness-config.js";
import { studentProgressFixture } from "./harness-browser.js";
import { FakeBrowser } from "./harness-backend.js";
import { drive, openTab, assertKnownShadowIds, seedLoggedInBrowser } from "./harness-utils.js";
import { loginFromOverlay, ADMIN_SESSION } from "./harness-helpers.js";

// ---- Codigo de estudiante (0.7.22) ----

test("0.7.22: sin codigo no se entra; el overlay lo pide, lo valida y espera la aprobacion si el codigo ya tiene cuenta", async () => {
  const browser = new FakeBrowser();
  browser.storage = { adaceenClientId: "cliente-prueba-123", adaceenPrivacyAcceptedByUser: { [SESSION.user.id]: PRIVACY_POLICY_VERSION } };
  browser.loginSteps = [
    { body: { ok: false, step: "student_code", error: "Para entrar, escribe tu código de estudiante (7 dígitos). Si no ves dónde escribirlo, actualiza ADACEEN a la versión 0.7.22 o superior.", email: SESSION.user.email, displayName: "Estudiante Prueba", codeLength: 7 } },
    { status: 400, body: { ok: false, step: "student_code", error: "El código de estudiante tiene 7 dígitos, por ejemplo 2312345.", codeLength: 7 } },
  ];
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await loginFromOverlay(browser, tab);

  // Paso del codigo: la tarjeta del login se oculta y aparece la del codigo.
  assert.equal(tab.el("authView").hidden, false, "sigue en la vista de acceso");
  assert.equal(tab.el("authLoginCard").hidden, true);
  assert.equal(tab.el("studentCodeCard").hidden, false);
  // Dirección B (0.7.22): «Código de estudiante», el correo con el que entró y «paso 2/2».
  assert.equal(tab.el("authTitle").textContent, "Código de estudiante");
  assert.equal(tab.el("studentCodeWho").textContent, SESSION.user.email);
  assert.equal(tab.el("studentCodeWhoLine").hidden, false);
  assert.equal(tab.el("studentCodeStepCount").textContent, "paso 2/2");
  assert.equal(tab.el("studentCodeReview").hidden, true, "el resumen es de la espera");
  assert.equal(tab.el("studentCodeStatus").textContent, "", "el texto para extensiones viejas no se repite");
  assert.equal(tab.el("authSubmitBtn").textContent, "Entrar");
  assert.equal(tab.el("authBackBtn").textContent, "Usar otra cuenta");
  assert.equal(tab.state().session, null, "sin sesion todavia");

  // Mal escrito: lo dice sin llamar al backend.
  const loginsBefore = browser.requestsTo("/api/auth/login", "POST").length;
  tab.el("studentCodeInput").value = "12345";
  await drive(browser, tab.el("authSubmitBtn").click());
  assert.equal(browser.requestsTo("/api/auth/login", "POST").length, loginsBefore);
  // Dirección B (0.7.22): dice cuántos dígitos faltan.
  assert.equal(tab.el("studentCodeStatus").textContent, "Faltan 2 dígitos. El código tiene 7, por ejemplo 2312345.");
  assert.equal(tab.el("studentCodeInput").getAttribute("aria-invalid"), "true");

  // El backend lo rechaza (400 con el paso): se muestra su mensaje.
  tab.el("studentCodeInput").value = "2312345";
  await drive(browser, tab.el("authSubmitBtn").click(), 2000);
  await browser.clock.until(() => tab.state().authBusy === false, 400);
  assert.equal(tab.el("studentCodeStatus").textContent, "El código de estudiante tiene 7 dígitos, por ejemplo 2312345.");

  // Con el codigo bueno entra: el login lleva el codigo y la clave de antes.
  tab.el("studentCodeInput").value = " 2312345-3743 ";
  await drive(browser, tab.el("authSubmitBtn").click(), 2000);
  await browser.clock.until(() => tab.state().loading === false && tab.state().authBusy === false, 400);
  const lastLogin = browser.requestsTo("/api/auth/login", "POST").at(-1);
  assert.deepEqual(lastLogin?.body, { email: SESSION.user.email, password: "clave-del-piloto", studentCode: "2312345-3743" });
  assert.equal(tab.state().studentCodeStep, null);
  assert.equal(tab.state().sessionId, SESSION.id);
  assert.equal(tab.el("authView").hidden, true, "entro al panel");

  // Otro navegador: el codigo ya tiene una cuenta que entro con otro correo.
  const second = new FakeBrowser();
  second.storage = { adaceenClientId: "cliente-otro-456" };
  second.loginSteps = [
    { body: { ok: false, step: "student_code", error: "Para entrar…", email: "ana.gmail@gmail.com", displayName: "Ana" } },
    { body: { ok: false, step: "pending_approval", error: "Tu código ya está registrado con otro correo (an***@correounivalle.edu.co). Entra con ese correo, o espera a que tu docente apruebe este acceso: después podrás entrar con cualquiera de los dos.", maskedEmail: "an***@correounivalle.edu.co", requestedAt: "2026-10-11T22:00:00.000Z" } },
    { body: { ok: false, step: "pending_approval", error: "Tu código ya está registrado con otro correo (an***@correounivalle.edu.co).", maskedEmail: "an***@correounivalle.edu.co" } },
  ];
  const secondTab = await openTab(second, `https://github.com/${REPO}`, REPO);
  await loginFromOverlay(second, secondTab);
  secondTab.el("studentCodeInput").value = "2312345";
  await drive(second, secondTab.el("authSubmitBtn").click(), 2000);
  await second.clock.until(() => secondTab.state().authBusy === false, 400);
  assert.equal(secondTab.el("authTitle").textContent, "Tu docente tiene que aprobar este correo");
  assert.equal(secondTab.el("studentCodeField").hidden, true, "ya no pide el codigo");
  assert.equal(secondTab.el("studentCodeStepCount").textContent, "en revisión");
  // El resumen dice el codigo, el correo (enmascarado) con el que ya entro y cuando se pidio.
  assert.equal(secondTab.el("studentCodeReview").hidden, false);
  assert.equal(secondTab.el("studentCodeReviewCode").textContent, "2312345");
  assert.equal(secondTab.el("studentCodeReviewEmail").textContent, "an***@correounivalle.edu.co");
  assert.ok(secondTab.el("studentCodeReviewAt").textContent.length > 0);
  assert.equal(secondTab.el("studentCodeStatus").textContent, "", "el resumen ya lo dice");
  assert.equal(secondTab.el("authSubmitBtn").textContent, "Revisar de nuevo");
  // «Revisar de nuevo» repite el login con el mismo codigo.
  await drive(second, secondTab.el("authSubmitBtn").click(), 2000);
  await second.clock.until(() => secondTab.state().authBusy === false, 400);
  assert.equal(second.requestsTo("/api/auth/login", "POST").at(-1)?.body?.studentCode, "2312345");
  assert.equal(secondTab.el("authTitle").textContent, "Tu docente tiene que aprobar este correo");
  // «Usar otra cuenta» vuelve al inicio de sesion.
  await drive(second, secondTab.el("authBackBtn").click());
  assert.equal(secondTab.state().studentCodeStep, null);
  assert.equal(secondTab.el("authLoginCard").hidden, false);
  assert.equal(secondTab.el("studentCodeCard").hidden, true);
  assert.equal(secondTab.el("authTitle").textContent, "Entrar");
  assert.equal(secondTab.el("studentCodeWhoLine").hidden, true);
  assertKnownShadowIds(tab, secondTab);
});

// 0.7.22: una lista importada con nombres errados se borra marcando las casillas (o «Seleccionar
// todos») y «Eliminar seleccionados»; quien ya entró solo se desactiva.
test("0.7.22: «Usuarios» marca estudiantes con casillas y los elimina juntos", async () => {
  const browser = new FakeBrowser();
  browser.session = { ...SESSION, user: { ...SESSION.user, id: "u-docente", role: "teacher", displayName: "Docente Prueba", assignedCourseCodes: [] } };
  browser.adminUsers = [
    { id: "u-imp-1", role: "student", email: "carla.campos@correounivalle.edu.co", displayName: "Cccampos Carla", teacherUserId: "u-docente", teacherDisplayName: "Docente Prueba", assignedCourseCodes: ["FPOO"], isActive: true, createdAt: "2026-10-12T12:00:00.000Z", studentCode: null, loginEmails: [], hasSignedIn: false },
    { id: "u-imp-2", role: "student", email: "dario.mejia@correounivalle.edu.co", displayName: "Dmmejia Dario", teacherUserId: "u-docente", teacherDisplayName: "Docente Prueba", assignedCourseCodes: ["FPOO"], isActive: true, createdAt: "2026-10-12T12:00:00.000Z", studentCode: null, loginEmails: [], hasSignedIn: false },
    { id: "u-ent", role: "student", email: "elena.ruiz@correounivalle.edu.co", displayName: "Elena Ruiz", teacherUserId: "u-docente", teacherDisplayName: "Docente Prueba", assignedCourseCodes: ["FPOO"], isActive: true, createdAt: "2026-10-01T12:00:00.000Z", studentCode: "2312003", loginEmails: [], hasSignedIn: true },
  ];
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-docente": PRIVACY_POLICY_VERSION } });
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);
  await drive(browser, tab.el("tabBtnUsuarios").click());
  await browser.clock.until(() => tab.el("adminUsersTableBody").children.length >= 3, 400);

  // Una casilla por estudiante; la barra aparece al marcar.
  const checkbox = (row: number) => tab.el("adminUsersTableBody").children[row].children[0].children[0];
  assert.equal(checkbox(0).type, "checkbox");
  assert.equal(checkbox(0).getAttribute("aria-label"), "Seleccionar a Cccampos Carla");
  assert.equal(tab.el("adminUsersBulkBar").hidden, true);
  checkbox(0).checked = true;
  await drive(browser, checkbox(0).dispatch("change"));
  assert.equal(tab.el("adminUsersBulkBar").hidden, false);
  assert.equal(tab.el("adminUsersBulkCount").textContent, "1 seleccionado");
  assert.equal(tab.el("adminUsersSelectAll").indeterminate, true, "a medias: solo uno de tres");

  // «Seleccionar todos» marca los que muestra la búsqueda.
  tab.el("adminUsersSearch").value = "correounivalle";
  await drive(browser, tab.el("adminUsersSearch").dispatch("input"));
  tab.el("adminUsersSelectAll").checked = true;
  await drive(browser, tab.el("adminUsersSelectAll").dispatch("change"));
  assert.equal(tab.el("adminUsersBulkCount").textContent, "3 seleccionados");
  assert.equal(tab.el("adminUsersSelectAll").checked, true);

  // Eliminar: confirma diciendo qué pasa con cada grupo y manda los ids.
  let question = "";
  tab.window.confirm = (text: string) => { question = text; return true; };
  await drive(browser, tab.el("adminUsersBulkDeleteBtn").click(), 2000);
  await browser.clock.until(() => tab.state().adminUsersBusy === false, 400);
  assert.match(question, /Vas a eliminar 3 estudiantes\./);
  assert.match(question, /2 nunca han entrado: se borran del todo/);
  assert.match(question, /1 ya entró: se desactiva y conserva sus datos del piloto/);
  assert.deepEqual((browser.bulkDeletes[0].userIds as string[]).sort(), ["u-ent", "u-imp-1", "u-imp-2"]);
  assert.equal(tab.el("adminUsersStatus").textContent, "Listo: 2 eliminados, 1 desactivado (ya habían entrado: conservan sus datos). Si se importaron con el nombre errado, vuelve a importar la lista.");
  assert.equal(tab.el("adminUsersBulkBar").hidden, true, "la selección se limpia");
  assert.equal(tab.el("adminUsersTableBody").children.length, 1, "quedan solo los que ya habían entrado");
  assertKnownShadowIds(tab);
});

// 0.7.22: «Estudiantes» gestiona como «Usuarios» (solo estudiantes) y conserva la analítica:
// casillas con «Seleccionar todos» y tramo con Shift, «Eliminar seleccionados», «Editar» y
// «Eliminar» por fila, e «Importar lista» y «Agregar estudiante» con los mismos formularios.
test("0.7.22: «Estudiantes» selecciona, edita, elimina, importa y agrega como «Usuarios»", async () => {
  const browser = new FakeBrowser();
  browser.session = { ...SESSION, user: { ...SESSION.user, id: "u-docente", role: "teacher", displayName: "Docente Prueba", assignedCourseCodes: [] } };
  const account = (id: string, displayName: string, email: string, hasSignedIn: boolean, studentCode: string | null) => ({
    id, role: "student", email, displayName, teacherUserId: "u-docente", teacherDisplayName: "Docente Prueba",
    assignedCourseCodes: ["FPOO"], isActive: true, createdAt: "2026-10-12T12:00:00.000Z", studentCode, loginEmails: [], hasSignedIn,
  });
  browser.adminUsers = [
    account("u-imp-1", "Cccampos Carla", "carla.campos@correounivalle.edu.co", false, null),
    account("u-ent", "Elena Ruiz", "elena.ruiz@correounivalle.edu.co", true, "2312003"),
    account("u-imp-2", "Dmmejia Dario", "dario.mejia@correounivalle.edu.co", false, null),
  ];
  browser.students = [
    studentProgressFixture("u-imp-1", "Cccampos Carla", "carla.campos@correounivalle.edu.co", { score: null, scale5: null, level: "sin_datos", label: "Sin quices" }),
    studentProgressFixture("u-ent", "Elena Ruiz", "elena.ruiz@correounivalle.edu.co", { score: 73, scale5: 3.7, level: "medio", label: "Medio" }),
    studentProgressFixture("u-imp-2", "Dmmejia Dario", "dario.mejia@correounivalle.edu.co", { score: null, scale5: null, level: "sin_datos", label: "Sin quices" }),
  ];
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-docente": PRIVACY_POLICY_VERSION } });
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);
  await drive(browser, tab.el("tabBtnEstudiantes").click());
  await browser.clock.until(() => tab.state().studentsPanel.loadedAt > 0, 400);

  // La analítica sigue: indicadores, sesiones, tutor, quices y nota; a los lados, casilla y acciones.
  const rows = () => tab.el("studentsTableBody").children;
  assert.equal(rows().length, 3);
  assert.equal(tab.el("studentsKpis").children.length, 5, "los cinco indicadores siguen");
  assert.equal(rows()[1].children.length, 8, "casilla, estudiante, sesiones, actividad, tutor, quices, nota y acciones");
  assert.equal(rows()[1].children[6].children[0].textContent, "73/100", "la nota sigue en su columna");
  const box = (row: number) => rows()[row].children[0].children[0];
  assert.equal(box(0).type, "checkbox");
  assert.equal(box(0).getAttribute("aria-label"), "Seleccionar a Cccampos Carla");
  assert.equal(rows()[0].children[7].children[0].textContent, "Editar");
  assert.equal(rows()[0].children[7].children[1].textContent, "Eliminar");

  // Uno, y con Shift el tramo hasta otro (uno a muchos).
  assert.equal(tab.el("studentsBulkBar").hidden, true);
  await drive(browser, box(0).dispatch("click"));
  box(0).checked = true;
  await drive(browser, box(0).dispatch("change"));
  assert.equal(tab.el("studentsBulkCount").textContent, "1 seleccionado");
  assert.equal(tab.el("studentsSelectAll").indeterminate, true);
  await drive(browser, box(2).dispatch("click", { shiftKey: true }));
  box(2).checked = true;
  await drive(browser, box(2).dispatch("change"));
  assert.equal(tab.el("studentsBulkCount").textContent, "3 seleccionados", "Shift marca el tramo");
  assert.equal(tab.el("studentsSelectAll").checked, true);
  assert.equal((tab.state().adminSelectedUserIds || []).length, 0, "la selección de «Usuarios» es aparte");
  await drive(browser, tab.el("studentsBulkClearBtn").click());
  assert.equal(tab.el("studentsBulkBar").hidden, true);

  // «Seleccionar todos» con la búsqueda: solo los visibles.
  tab.el("studentsSearchInput").value = "dario";
  await drive(browser, tab.el("studentsSearchInput").dispatch("input"));
  tab.el("studentsSelectAll").checked = true;
  await drive(browser, tab.el("studentsSelectAll").dispatch("change"));
  assert.deepEqual([...tab.state().studentsPanel.checkedIds], ["u-imp-2"]);
  tab.el("studentsSearchInput").value = "";
  await drive(browser, tab.el("studentsSearchInput").dispatch("input"));

  // Editar: el mismo formulario de «Usuarios», debajo de la fila.
  await drive(browser, rows()[1].children[7].children[0].click());
  assert.equal(tab.state().studentsPanel.editingId, "u-ent");
  assert.equal(rows().length, 4, "la fila de edición aparece debajo");
  assert.equal(rows()[1].children[7].children[0].textContent, "Cancelar");
  const form = rows()[2].children[0].children[0];
  const nameInput = form.children[0].children[0].children[1];
  assert.equal(nameInput.value, "Elena Ruiz");
  const codeInput = form.children[2].children[0].children[1];
  assert.equal(codeInput.value, "2312003", "trae el código de la cuenta");
  nameInput.value = "Elena Ruiz Gómez";
  const saveBtn = form.children[form.children.length - 1].children[1];
  const progressBefore = browser.requestsTo("/api/admin/students").length;
  await drive(browser, saveBtn.click(), 800);
  await browser.clock.until(() => tab.state().adminUsersBusy === false, 400);
  assert.equal(browser.adminUserUpdates.length, 1);
  assert.equal(browser.adminUserUpdates[0].id, "u-ent");
  assert.equal(browser.adminUserUpdates[0].body?.displayName, "Elena Ruiz Gómez");
  assert.equal(tab.state().studentsPanel.editingId, "", "al guardar se cierra");
  assert.equal(tab.el("studentsStatus").textContent, "Usuario actualizado.");
  assert.ok(browser.requestsTo("/api/admin/students").length > progressBefore, "la lista se recarga");

  // Eliminar de una fila: como las casillas (nunca entró: se borra del todo).
  let question = "";
  tab.window.confirm = (text: string) => { question = text; return true; };
  await drive(browser, rows()[0].children[7].children[1].click(), 2000);
  await browser.clock.until(() => tab.state().adminUsersBusy === false, 400);
  await browser.clock.until(() => !tab.state().studentsPanel.busy, 400);
  assert.match(question, /Vas a eliminar a Cccampos Carla\./);
  assert.match(question, /Nunca ha entrado: se borra del todo/);
  assert.deepEqual(browser.bulkDeletes[0].userIds, ["u-imp-1"]);
  assert.equal(tab.el("studentsStatus").textContent, "Listo: 1 eliminado. Si se importaron con el nombre errado, vuelve a importar la lista.");
  assert.equal(rows().length, 2, "sale de la lista");

  // «Eliminar seleccionados» con la que quedó marcada por la búsqueda.
  assert.equal(tab.el("studentsBulkCount").textContent, "1 seleccionado");
  await drive(browser, tab.el("studentsBulkDeleteBtn").click(), 2000);
  await browser.clock.until(() => tab.state().adminUsersBusy === false, 400);
  await browser.clock.until(() => !tab.state().studentsPanel.busy, 400);
  assert.deepEqual(browser.bulkDeletes[1].userIds, ["u-imp-2"]);
  assert.equal(tab.el("studentsBulkBar").hidden, true);
  assert.equal(rows().length, 1);

  // «Importar lista» y «Agregar estudiante»: los formularios de «Usuarios» se abren aquí.
  await drive(browser, tab.el("studentsToggleImportBtn").click());
  assert.equal(tab.el("adminImportPanel").hidden, false);
  assert.equal(tab.el("adminImportPanel").parentElement, tab.el("studentsFormsHost"));
  assert.equal(tab.el("studentsToggleImportBtn").textContent, "Ocultar importación");
  await drive(browser, tab.el("studentsToggleCreateBtn").click());
  assert.equal(tab.el("adminImportPanel").hidden, true, "uno a la vez");
  assert.equal(tab.el("adminCreateForm").hidden, false);
  assert.equal(tab.el("adminCreateForm").parentElement, tab.el("studentsFormsHost"));
  assert.equal(tab.el("adminCreateRole").value, "student");
  tab.el("adminCreateName").value = "Fabio Lara";
  tab.el("adminCreateEmail").value = "fabio.lara@correounivalle.edu.co";
  await drive(browser, tab.el("adminCreateBtn").click(), 800);
  await browser.clock.until(() => tab.state().adminUsersBusy === false, 400);
  assert.equal(browser.createdUsers.length, 1);
  assert.equal(browser.createdUsers[0].email, "fabio.lara@correounivalle.edu.co");
  assert.equal(tab.el("studentsStatus").textContent, "Usuario creado correctamente.");

  // En «Usuarios» los formularios vuelven a su sitio.
  await drive(browser, tab.el("tabBtnUsuarios").click());
  assert.equal(tab.el("adminCreateForm").parentElement, tab.el("adminUsersFormsHost"));
  assert.equal(tab.el("adminImportPanel").parentElement, tab.el("adminUsersFormsHost"));
  assertKnownShadowIds(tab);
});

test("0.7.22: «Usuarios» muestra el codigo, los otros correos y las solicitudes de acceso para aprobar", async () => {
  const browser = new FakeBrowser();
  browser.session = { ...SESSION, user: { ...SESSION.user, id: "u-docente", role: "teacher", displayName: "Docente Prueba", assignedCourseCodes: [] } };
  browser.adminUsers = [
    { id: "u-est-1", role: "student", email: "ana.maria.perez.gonzalez@correounivalle.edu.co", displayName: "Ana María Pérez González", teacherUserId: "u-docente", teacherDisplayName: "Docente Prueba", assignedCourseCodes: ["FPOO"], isActive: true, createdAt: "2026-09-01T12:00:00.000Z", studentCode: "2312345", loginEmails: [], hasSignedIn: true },
    { id: "u-est-3", role: "student", email: "carla.campus@gmail.com", displayName: "Carla Campus", teacherUserId: "u-docente", teacherDisplayName: "Docente Prueba", assignedCourseCodes: ["FPOO"], isActive: true, createdAt: "2026-09-01T12:00:00.000Z", studentCode: null, loginEmails: [], hasSignedIn: false },
  ];
  browser.accessRequests = [
    { id: "sol-1", email: "ana.gmail@gmail.com", displayName: "Ana Gmail", studentCode: "2312345", status: "pending", createdAt: "2026-10-11T22:00:00.000Z", target: { id: "u-est-1", displayName: "Ana María Pérez González", email: "ana.maria.perez.gonzalez@correounivalle.edu.co", teacherUserId: "u-docente" }, source: null },
  ];
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-docente": PRIVACY_POLICY_VERSION } });
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);
  await drive(browser, tab.el("tabBtnUsuarios").click());
  await browser.clock.until(() => tab.el("adminUsersTableBody").children.length >= 2, 400);

  const rows = tab.el("adminUsersTableBody").children;
  // Dirección B (0.7.22): el código tiene su columna (tras la casilla y el usuario; antes «Rol»).
  const codeCell = (row: number) => rows[row].children[2].children.map((node) => node.textContent).join(" | ");
  assert.equal(codeCell(0), "2312345");
  assert.equal(codeCell(1), "sin código · no ha entrado");

  assert.equal(tab.el("adminAccessRequests").hidden, false);
  const items = tab.el("adminAccessRequestList").children;
  assert.equal(items.length, 1);
  assert.match(items[0].children[0].children.map((node) => node.textContent).join("") + items[0].children[0].textContent, /escribió el código 2312345, que es de Ana María Pérez González/);
  const [rejectBtn, approveBtn] = items[0].children[1].children;
  assert.equal(rejectBtn.textContent, "Rechazar");
  assert.equal(approveBtn.textContent, "Aprobar");
  tab.window.confirm = () => true;
  await drive(browser, approveBtn.click(), 2000);
  await browser.clock.until(() => tab.state().adminUsersBusy === false, 400);
  assert.deepEqual(browser.accessDecisions, [{ id: "sol-1", body: { decision: "approve", studentCode: "2312345" } }]);
  assert.equal(tab.el("adminAccessRequests").hidden, true, "sin solicitudes, el bloque se oculta");
  assert.equal(tab.el("adminUsersStatus").textContent, "Listo: ana.gmail@gmail.com entra a la cuenta de Ana María Pérez González.");
  const afterRows = tab.el("adminUsersTableBody").children;
  assert.ok(afterRows[0].children[1].children.map((node) => node.textContent).includes("También entra con ana.gmail@gmail.com"));

  // Editar: el codigo se corrige y solo viaja si cambio.
  await drive(browser, afterRows[1].children[7].children[0].click());
  const form = tab.el("adminUsersTableBody").children[2].children[0].children[0];
  const codeRow = form.children[2];
  const codeInput = codeRow.children[0].children[1];
  assert.equal(codeInput.getAttribute("aria-label"), "Código de estudiante de Carla Campus");
  codeInput.value = "2398765";
  const saveBtn = form.children.at(-1).children[1];
  assert.equal(saveBtn.textContent, "Guardar");
  await drive(browser, saveBtn.click(), 2000);
  await browser.clock.until(() => tab.state().adminUsersBusy === false, 400);
  assert.equal(browser.adminUserUpdates.at(-1)?.body?.studentCode, "2398765");
  assertKnownShadowIds(tab);
});

// 0.7.22: el administrador también tiene «RAG»: elige el docente y carga fuentes en el RAG de ese
// docente (lo que el docente de un curso real no alcanzó a subir).
test("0.7.22: el administrador elige el docente en «RAG» y carga varias fuentes en su RAG con teacherUserId", async () => {
  const browser = new FakeBrowser();
  browser.session = ADMIN_SESSION;
  browser.adminTeachers = [
    { id: "u-docente", email: "docente@correounivalle.edu.co", displayName: "Docente Prueba" },
    { id: "u-docente-2", email: "victor.bucheli@correounivalle.edu.co", displayName: "Víctor Bucheli" },
  ];
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-admin": PRIVACY_POLICY_VERSION } });
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => tab.state().loading === false, 400);

  // La pestaña está; al abrirla trae las fuentes del docente que eligió el backend y la lista.
  assert.equal(tab.el("tabBtnRag").hidden, false, "el administrador ve «RAG»");
  assert.equal(tab.el("tabBtnTutor").hidden, true, "el administrador sigue sin tutor");
  await drive(browser, tab.el("tabBtnRag").click(), 400);
  await browser.clock.until(() => tab.state().teacherRagLoadedAt > 0 && !tab.state().teacherRagState.busy, 400);
  assert.equal(tab.el("ragCoursesSection").hidden, false);
  assert.equal(tab.el("ragOwnerField").hidden, false);
  const select = tab.el("ragOwnerSelect");
  assert.equal(select.children.length, 2);
  assert.equal(select.value, "u-docente", "empieza con el que eligió el backend");
  assert.match(tab.el("ragCoursesStatus").textContent, /^RAG de Docente Prueba: .*cargada por el docente/);
  assert.ok(tab.state().teacherRagState.sources.some((source: any) => source.id === "RAG-T-01"));

  // Cambia de docente: fuentes y lotes de ese docente (su RAG está vacío: solo el programa).
  select.value = "u-docente-2";
  await drive(browser, select.dispatch("change"), 400);
  await browser.clock.until(() => !tab.state().teacherRagState.busy && !tab.state().ragLots.busy, 400);
  assert.match(String(browser.requestsTo("/api/rag/sources", "GET").at(-1)?.query), /teacherUserId=u-docente-2/);
  assert.match(String(browser.requestsTo("/api/rag/lots", "GET").at(-1)?.query), /teacherUserId=u-docente-2/);
  assert.equal(tab.state().ragOwner.teacherUserId, "u-docente-2");
  assert.ok(!tab.state().teacherRagState.sources.some((source: any) => source.scope === "teacher"), "no mezcla las del otro docente");
  assert.match(tab.el("ragCoursesStatus").textContent, /^RAG de Víctor Bucheli: /);

  // Carga dos guías de una vez en FPOO: cada una va con teacherUserId y queda en el RAG de Víctor.
  const fpoo = Array.from(tab.el("ragCourseGroups").children).find((group: any) => group.dataset.courseCode === "FPOO") as any;
  const uploadBtn = fpoo.children[1].children[0].children[2];
  assert.equal(uploadBtn.textContent, "Cargar fuente");
  await drive(browser, uploadBtn.click());
  const input = tab.el("teacherRagFileInput");
  input.files = [new File(["guia 1"], "Guia 1 - Clases.pdf"), new File(["guia 2"], "Guia 2 - Herencia.pdf")];
  await drive(browser, input.dispatch("change"), 3000);
  await browser.clock.until(() => !tab.state().teacherRagState.busy, 400);
  assert.deepEqual(browser.ragUploads.map((upload) => [upload.fileName, upload.courseCode, upload.owner]), [
    ["Guia 1 - Clases.pdf", "FPOO", "u-docente-2"],
    ["Guia 2 - Herencia.pdf", "FPOO", "u-docente-2"],
  ]);
  assert.equal(tab.state().teacherRagState.message, "Cargadas 2 de 2 fuentes en FPOO para Víctor Bucheli.");
  assert.equal(tab.state().teacherRagState.sources.filter((source: any) => source.scope === "teacher").length, 2);
  assertKnownShadowIds(tab);
});
