import assert from "node:assert/strict";
import test from "node:test";
import { PRIVACY_POLICY_VERSION } from "../../../src/routes/pages/privacy-policy-routes.js";
import { REPO, TUNNEL_URL, CAMPUS_COURSE_URL, SESSION } from "./harness-config.js";
import { FakeBrowser } from "./harness-backend.js";
import { drive, openTab, assertKnownShadowIds, seedLoggedInBrowser } from "./harness-utils.js";

test("pestañas (0.7.13): cada rol ve las suyas y «Estudiantes» trae sesiones, quices y notas del backend", async () => {
  // --- Estudiante: Inicio y Tutor. Entra en Inicio; al llegar las pistas pasa a Tutor.
  const studentBrowser = new FakeBrowser();
  seedLoggedInBrowser(studentBrowser);
  const studentTab = await openTab(studentBrowser, TUNNEL_URL, "taller-1");
  await drive(studentBrowser, studentTab.run("openOverlay({ trigger: 'user' })"));
  await studentBrowser.clock.until(() => studentTab.state().loading === false, 400);
  assert.equal(studentTab.el("mainView").hidden, false);
  assert.equal(studentTab.el("mainTabBar").hidden, false);
  assert.equal(studentTab.el("tabBtnTutor").hidden, false);
  assert.equal(studentTab.el("tabBtnEstudiantes").hidden, true, "el estudiante no ve a otros estudiantes");
  assert.equal(studentTab.el("tabBtnUsuarios").hidden, true);
  assert.equal(studentTab.state().mainTab, "inicio");
  assert.equal(studentTab.el("tabPanelInicio").hidden, false);
  assert.equal(studentTab.el("tabPanelTutor").hidden, true, "sin pistas todavia, se queda en Inicio");
  studentBrowser.tutorReply = { result: { ideas: ["Revisa el constructor."], guide: ["Compila de nuevo."] } };
  await drive(studentBrowser, studentTab.run("refreshMentorSession({ trigger: 'manual', requestedAt: Date.now() })"), 2000);
  assert.equal(studentTab.state().mainTab, "tutor", "la respuesta del tutor abre la pestaña Tutor");
  assert.equal(studentTab.el("tabPanelTutor").hidden, false);
  assert.equal(studentTab.el("tabPanelInicio").hidden, true);
  assert.equal(studentTab.el("tabBtnTutor").getAttribute("aria-selected"), "true");
  // Si la persona elige Inicio, un refresco automatico no la saca de ahi; pedir ayuda a mano si.
  await drive(studentBrowser, studentTab.el("tabBtnInicio").click());
  assert.equal(studentTab.state().mainTab, "inicio");
  await drive(studentBrowser, studentTab.run("refreshMentorSession({ trigger: 'context', requestedAt: Date.now() })"), 2000);
  assert.equal(studentTab.state().mainTab, "inicio", "respeta la pestaña elegida");
  await drive(studentBrowser, studentTab.run("refreshMentorSession({ trigger: 'manual', requestedAt: Date.now() })"), 2000);
  assert.equal(studentTab.state().mainTab, "tutor", "«Actualizar» muestra la respuesta");
  await drive(studentBrowser, studentTab.el("tabBtnInicio").click());
  // Flecha derecha desde Inicio: Tutor (patron tablist).
  await drive(studentBrowser, studentTab.el("tabBtnInicio").dispatch("keydown", { key: "ArrowRight" }));
  assert.equal(studentTab.state().mainTab, "tutor");
  assert.deepEqual(studentBrowser.requestsTo("/api/admin/students"), [], "el estudiante nunca pide el progreso");
  assertKnownShadowIds(studentTab);

  // --- Docente: Inicio, Tutor, Estudiantes y Usuarios. El progreso se pide solo al abrir la pestaña.
  const browser = new FakeBrowser();
  browser.session = { ...SESSION, user: { ...SESSION.user, id: "u-docente", role: "teacher", displayName: "Docente Prueba", assignedCourseCodes: [] } };
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);
  assert.equal(tab.el("tabBtnTutor").hidden, false);
  assert.equal(tab.el("tabBtnEstudiantes").hidden, false);
  assert.equal(tab.el("tabBtnUsuarios").hidden, false);
  assert.equal(tab.el("tabPanelInicio").hidden, false);
  assert.equal(tab.el("tabPanelEstudiantes").hidden, true);
  assert.deepEqual(browser.requestsTo("/api/admin/students"), [], "sin pedir el progreso hasta abrir la pestaña");

  await drive(browser, tab.el("tabBtnEstudiantes").click());
  await browser.clock.until(() => tab.state().studentsPanel.loadedAt > 0, 400);
  assert.equal(tab.state().mainTab, "estudiantes");
  assert.equal(tab.el("tabPanelEstudiantes").hidden, false);
  assert.equal(tab.el("tabPanelInicio").hidden, true);
  assert.equal(tab.el("tabPanelUsuarios").hidden, true);
  assert.equal(browser.requestsTo("/api/admin/students").length, 1);
  assert.equal(tab.el("tabCountEstudiantes").hidden, false);
  assert.equal(tab.el("tabCountEstudiantes").textContent, "2");
  assert.equal(tab.el("studentsSection").hidden, false);
  assert.equal(tab.el("studentDetailSection").hidden, true);
  assert.equal(tab.el("studentsKpis").children.length, 5, "cinco indicadores del grupo");
  assert.equal(tab.el("studentsKpis").children[3].children[1].textContent, "73/100", "nota promedio");
  const rows = tab.el("studentsTableBody").children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dataset.userId, "u-est-1");
  assert.equal(rows[0].children[6].children[0].textContent, "73/100", "nota sobre 100 en la etiqueta");
  assert.equal(rows[0].children[6].children[1].textContent, "3,7/5", "y la escala de 0 a 5 debajo");
  assert.equal(rows[1].children[6].children[0].textContent, "Sin quices");
  assert.match(tab.el("studentsStatus").textContent, /2 estudiantes/);
  // Volver a la pestaña no repite la peticion (menos de un minuto).
  await drive(browser, tab.el("tabBtnInicio").click());
  await drive(browser, tab.el("tabBtnEstudiantes").click());
  assert.equal(browser.requestsTo("/api/admin/students").length, 1, "la lista fresca no se vuelve a pedir");

  // Buscar filtra por nombre o correo sin pedir nada al backend.
  const search = tab.el("studentsSearchInput");
  search.value = "bruno";
  await drive(browser, search.dispatch("input"));
  assert.equal(tab.el("studentsTableBody").children.length, 1);
  assert.equal(tab.el("studentsTableBody").children[0].dataset.userId, "u-est-2");
  search.value = "";
  await drive(browser, search.dispatch("input"));
  assert.equal(tab.el("studentsTableBody").children.length, 2);

  // Detalle: clic en la fila trae sesiones, intervenciones, quices y linea de tiempo.
  await drive(browser, tab.el("studentsTableBody").children[0].click());
  await browser.clock.until(() => !!tab.state().studentsPanel.detail, 400);
  assert.equal(browser.requestsTo("/api/admin/students/u-est-1").length, 1);
  assert.equal(tab.el("studentDetailSection").hidden, false);
  assert.equal(tab.el("studentsSection").hidden, true, "el detalle ocupa el lugar de la lista, sin scroll");
  assert.equal(tab.el("studentDetailTitle").textContent, "Ana Prueba");
  assert.match(tab.el("studentDetailMeta").textContent, /ana@correounivalle\.edu\.co/);
  assert.match(tab.el("studentDetailMeta").textContent, /Cohorte A/);
  assert.equal(tab.el("studentDetailChip").textContent, "Activo ahora");
  assert.equal(tab.el("studentDetailKpis").children.length, 5);
  assert.equal(tab.el("studentDetailKpis").children[4].children[1].textContent, "73/100 | 3,7/5");
  assert.equal(tab.el("studentDetailTimeline").children.length, 14, "un dia por columna");
  assert.equal(tab.el("studentDetailQuizzes").children.length, 2);
  assert.match(tab.el("studentDetailQuizzes").children[0].children[2].textContent, /Correcto .* seguimiento 80\/100/);
  assert.match(tab.el("studentDetailQuizzes").children[1].children[2].textContent, /Incorrecto .* correcta "Animal"/);
  assert.equal(tab.el("studentDetailSessions").children.length, 2);
  assert.match(tab.el("studentDetailSessions").children[1].children[0].textContent, /VS Code \(tunnel\)/);
  assert.equal(tab.el("studentDetailInterventions").children.length, 1);
  assert.match(tab.el("studentDetailInterventions").children[0].children[0].textContent, /Error de compilacion -> Pista/);
  assert.equal(tab.el("studentDetailActivity").children.length, 2, "ejercicio con pistas + actividad por categoria");
  // El evento en palabras del docente, no su nombre interno.
  assert.equal(tab.el("studentDetailActivity").children[1].children[0].textContent, "Tutor: Pidio ayuda");
  assert.match(tab.el("studentDetailActivity").children[1].children[1].textContent, /^4 veces \| navegador \| /);

  // Volver a la lista y recargar a mano si trae datos nuevos.
  await drive(browser, tab.el("studentDetailBackBtn").click());
  assert.equal(tab.el("studentDetailSection").hidden, true);
  assert.equal(tab.el("studentsSection").hidden, false);
  await drive(browser, tab.el("studentsReloadBtn").click());
  await browser.clock.until(() => !tab.state().studentsPanel.busy, 400);
  assert.equal(browser.requestsTo("/api/admin/students").length, 2, "Recargar si vuelve a pedir");

  // Usuarios: la administracion sigue completa en su pestaña.
  await drive(browser, tab.el("tabBtnUsuarios").click());
  assert.equal(tab.el("tabPanelUsuarios").hidden, false);
  assert.equal(tab.el("adminUsersSection").hidden, false);
  assert.equal(tab.el("tabPanelEstudiantes").hidden, true);
  assert.deepEqual(browser.unknownRoutes.filter((route) => !route.includes("/api/projects") && !route.includes("/api/admin/users")), []);
  assertKnownShadowIds(tab);

  // --- Administrador: Inicio, Estudiantes y Usuarios, sin Tutor.
  const adminBrowser = new FakeBrowser();
  adminBrowser.session = { ...SESSION, user: { ...SESSION.user, id: "u-admin", role: "admin", displayName: "Admin Prueba", assignedCourseCodes: [] } };
  seedLoggedInBrowser(adminBrowser);
  const adminTab = await openTab(adminBrowser, CAMPUS_COURSE_URL, "Curso");
  await drive(adminBrowser, adminTab.run("openOverlay({ trigger: 'user' })"));
  await adminBrowser.clock.until(() => adminTab.state().loading === false, 400);
  assert.equal(adminTab.el("tabBtnTutor").hidden, true, "el administrador no usa el tutor");
  assert.equal(adminTab.el("tabBtnEstudiantes").hidden, false);
  assert.equal(adminTab.el("tabBtnUsuarios").hidden, false);
  await drive(adminBrowser, adminTab.el("tabBtnEstudiantes").click());
  await adminBrowser.clock.until(() => adminTab.state().studentsPanel.loadedAt > 0, 400);
  assert.equal(adminTab.el("studentsTableBody").children.length, 2);
  assert.match(adminTab.el("studentsTableBody").children[0].children[1].children[1].textContent, /Docente Prueba/, "el admin ve el docente de cada estudiante");
  assertKnownShadowIds(adminTab);
});


test("0.7.14: usuarios legibles con edicion por fila, RAG por curso, tuerca por secciones y resumen del tutor separado", async () => {
  const browser = new FakeBrowser();
  browser.session = { ...SESSION, user: { ...SESSION.user, id: "u-docente", role: "teacher", displayName: "Docente Prueba", assignedCourseCodes: [] } };
  browser.tutorReply = {
    result: {
      ideas: ["Revisa el constructor. [RAG-FPOO-17#c1]"],
      guide: ["Compila de nuevo."],
      analysis_summary: "Se detecto Campus Virtual y se priorizaron pistas. RAG consultado: Conceptos basicos [RAG-FPOO-17#c1] | Taller 2 [RAG-T-01#c1]. RAG usado: Conceptos basicos: [RAG-FPOO-17#c1] (Motivo: coincide con objeto.). Politica: explanation con detalle brief.",
    },
    rag_sources: [
      { sourceId: "RAG-FPOO-17", chunkId: "RAG-FPOO-17:chunk:0", courseCode: "FPOO", scope: "default", knowledgeTier: "primary", title: "Conceptos basicos", fileName: "conceptos.html", pageStart: 5, citationLabel: "[RAG-FPOO-17#c1]", score: 12.5, usageReason: "Parte usada: [RAG-FPOO-17#c1]. Motivo: coincide con objeto.", matchedTerms: ["objeto"] },
    ],
  };
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-docente": PRIVACY_POLICY_VERSION } });
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);

  // --- Usuarios: nombre y correo completos como texto; «Editar» abre la fila.
  await drive(browser, tab.el("tabBtnUsuarios").click());
  await browser.clock.until(() => tab.el("adminUsersTableBody").children.length >= 2, 400);
  const rows = tab.el("adminUsersTableBody").children;
  assert.equal(rows.length, 2, "una fila por usuario, sin fila de edicion");
  assert.equal(rows[0].children[1].children[0].tagName, "SPAN", "el nombre es texto, no un campo");
  assert.equal(rows[0].children[1].children[0].textContent, "Ana María Pérez González");
  // El correo va partido antes de la @ con un <wbr> (corta ahi si la columna es angosta): su texto
  // completo, como lo da el DOM real, es el de sus nodos.
  const emailCell = rows[0].children[1].children[1];
  assert.equal(emailCell.textContent + emailCell.children.map((node) => node.textContent).join(""), "ana.maria.perez.gonzalez@correounivalle.edu.co");
  assert.deepEqual(emailCell.children.map((node) => node.tagName), ["#TEXT", "WBR", "#TEXT"]);
  // Dirección B (0.7.22): tras la casilla de selección, la columna «Código» (antes, el rol).
  assert.equal(rows[0].children[2].children[0].textContent, "sin código · no ha entrado");
  assert.equal(rows[0].children[4].children[0].children.length, 1, "un chip por curso");
  assert.equal(rows[1].children[4].children[0].children.length, 2);
  assert.equal(rows[1].children[6].children[0].textContent, "Inactivo");
  // «RAG aplicado» (0.7.15): sin lotes, cada curso del estudiante muestra la base.
  assert.equal(rows[0].children[5].children[0].children[0].textContent, "Base del curso");
  assert.equal(rows[0].children[7].children[0].textContent, "Editar");
  await drive(browser, rows[0].children[7].children[0].click());
  assert.equal(tab.state().adminEditingUserId, "u-est-1");
  const editedRows = tab.el("adminUsersTableBody").children;
  assert.equal(editedRows.length, 3, "la fila de edicion aparece debajo del usuario");
  assert.equal(editedRows[0].children[7].children[0].textContent, "Cancelar");
  const form = editedRows[1].children[0].children[0];
  const nameInput = form.children[0].children[0].children[1];
  assert.equal(nameInput.tagName, "INPUT");
  assert.equal(nameInput.value, "Ana María Pérez González");
  nameInput.value = "Ana María Pérez";
  const saveBtn = form.children[form.children.length - 1].children[1];
  assert.equal(saveBtn.textContent, "Guardar");
  await drive(browser, saveBtn.click(), 800);
  await browser.clock.until(() => tab.state().adminUsersBusy === false, 400);
  assert.equal(browser.adminUserUpdates.length, 1);
  assert.equal(browser.adminUserUpdates[0].id, "u-est-1");
  assert.equal(browser.adminUserUpdates[0].body?.displayName, "Ana María Pérez");
  assert.equal(tab.state().adminEditingUserId, "", "al guardar se cierra la edicion");
  assert.equal(tab.el("adminUsersTableBody").children.length, 2);

  // --- RAG: la pestaña carga cursos y fuentes al abrirse y agrupa por curso.
  assert.deepEqual(browser.requestsTo("/api/rag/sources"), [], "las fuentes no se piden hasta abrir la pestaña");
  await drive(browser, tab.el("tabBtnRag").click());
  await browser.clock.until(() => tab.state().teacherRagLoadedAt > 0, 400);
  assert.equal(tab.state().mainTab, "rag");
  assert.equal(tab.el("tabPanelRag").hidden, false);
  assert.equal(browser.requestsTo("/api/rag/sources").length, 1);
  const groups = tab.el("ragCourseGroups").children;
  assert.equal(groups.length, 2, "un grupo por curso del docente");
  assert.equal(groups[0].dataset.courseCode, "FPI");
  assert.equal(groups[1].dataset.courseCode, "FPOO");
  assert.equal(groups[1].open, true, "el curso por defecto empieza desplegado");
  assert.equal(groups[0].open, false);
  const fpooBody = groups[1].children[1];
  // 0.7.15: la base del curso es el primer grupo dentro del curso (toolbar, nota, base, lotes).
  const fpooBase = fpooBody.children[2];
  assert.equal(fpooBase.children[0].children[0].textContent, "Base del curso");
  const fpooList = fpooBase.children[1].children[1];
  assert.equal(fpooList.children.length, 2, "las dos fuentes de FPOO");
  assert.equal(fpooList.children[0].children[0].children[0].children[0].textContent, "Taller 2", "las cargadas por el docente van primero");
  const fpooActions = fpooList.children[0].children[0].children[1];
  assert.equal(fpooActions.children[fpooActions.children.length - 1].textContent, "Retirar");
  await drive(browser, fpooActions.children[fpooActions.children.length - 1].click(), 800);
  await browser.clock.until(() => !tab.state().teacherRagState.busy, 400);
  assert.deepEqual(browser.ragDeletes, ["RAG-T-01"]);
  const uploadBtn = fpooBody.children[0].children[2];
  assert.equal(uploadBtn.textContent, "Cargar fuente");
  await drive(browser, uploadBtn.click());
  assert.equal(tab.state().teacherRagState.selectedCourseCode, "FPOO", "la carga va al curso del grupo");
  assert.match(tab.el("ragCoursesStatus").textContent, /2 cursos/);
  // «Configurar RAG» de Inicio abre esta pestaña en vez de la pagina emergente.
  await drive(browser, tab.el("tabBtnInicio").click());
  await drive(browser, tab.el("teacherRagManageBtn").click());
  assert.equal(tab.state().mainTab, "rag");
  assert.equal(tab.state().teacherRagPageOpen, false);

  // --- Tuerca: secciones plegables; el docente empieza por su politica.
  await drive(browser, tab.el("settingsBtn").click(), 400);
  assert.equal(tab.state().settingsOpen, true);
  assert.equal(tab.el("settingsSectionPolicy").open, true);
  assert.equal(tab.el("settingsSectionSession").open, false);
  await drive(browser, tab.el("settingsCloseBtn").click(), 400);

  // --- Resumen del tutor: la linea de estado separa deteccion, politica y fuentes.
  await drive(browser, tab.run("refreshMentorSession({ trigger: 'manual', requestedAt: Date.now() })"), 2000);
  assert.equal(
    tab.el("statusText").textContent,
    "Se detecto Campus Virtual y se priorizaron pistas. Politica: explicacion, detalle breve. Fuentes: 1 usada de 2 consultadas (ver «Fuentes RAG usadas»).",
  );
  assert.equal(tab.el("ragSourcesSection").hidden, false);
  assert.equal(tab.el("ragSourcesSection").open, false, "plegada por defecto");
  assert.equal(tab.el("ragSourcesCount").textContent, "1 fuente");
  const citations = tab.el("ragSourcesList").children;
  assert.equal(citations.length, 2, "cabecera del curso + una fuente");
  assert.equal(citations[0].textContent, "FPOO");
  assert.equal(citations[1].children[0].children[1].textContent, "Conceptos basicos");
  assert.equal(citations[1].children[0].children[2].textContent, "RAG principal | p. 5 | [RAG-FPOO-17#c1] | puntaje 12.5");
  assert.equal(citations[1].children[1].hidden, true, "el motivo se despliega con +");
  await drive(browser, citations[1].children[0].children[0].click());
  assert.equal(citations[1].children[1].hidden, false);

  // --- Estudiante: la tuerca empieza por «Sesion y tutor».
  const studentBrowser = new FakeBrowser();
  seedLoggedInBrowser(studentBrowser);
  const studentTab = await openTab(studentBrowser, TUNNEL_URL, "taller-1");
  await drive(studentBrowser, studentTab.run("openOverlay({ trigger: 'user' })"));
  await studentBrowser.clock.until(() => studentTab.state().loading === false, 400);
  await drive(studentBrowser, studentTab.el("settingsBtn").click(), 400);
  assert.equal(studentTab.el("settingsSectionSession").open, true);
  assert.equal(studentTab.el("tabBtnRag").hidden, true, "el estudiante no administra RAG");
  assertKnownShadowIds(tab, studentTab);
});
