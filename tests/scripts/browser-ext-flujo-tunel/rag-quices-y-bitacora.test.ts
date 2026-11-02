import assert from "node:assert/strict";
import test from "node:test";
import { PRIVACY_POLICY_VERSION } from "../../../src/routes/pages/privacy-policy-routes.js";
import { BACKEND, REPO, SESSION } from "./harness-config.js";
import { FakeBrowser } from "./harness-backend.js";
import { drive, openTab, assertKnownShadowIds, seedLoggedInBrowser } from "./harness-utils.js";
import { openCampusCourse, ADMIN_SESSION } from "./harness-helpers.js";

test("0.7.15: lotes de RAG por curso, lote por estudiante, pestaña «Quices», ayuda de los RA y exportar bitacora", async () => {
  const browser = new FakeBrowser();
  browser.session = { ...SESSION, user: { ...SESSION.user, id: "u-docente", role: "teacher", displayName: "Docente Prueba", assignedCourseCodes: [] } };
  browser.customQuizzes = [
    { id: "cq-1", courseCode: "FPOO", topic: "Encapsulamiento", question: "Cual modificador oculta un atributo?", options: ["private", "public", "static"], correctIndex: 0, explanation: "", followupQuestion: "Da un ejemplo." },
  ];
  browser.quizAttempts = [
    { id: "a-1", studentUserId: "u-est-1", studentName: "Ana María Pérez González", studentEmail: "ana.maria.perez.gonzalez@correounivalle.edu.co", trigger: "teacher_launch", status: "done", topic: "Encapsulamiento", question: "Cual modificador oculta un atributo?", chosenIndex: 0, correct: true, followupScore: 80, launchId: "launch-cq-1", customQuizId: "cq-1", createdAt: "2026-09-27T14:05:00.000Z", answeredAt: "2026-09-27T14:06:00.000Z" },
    { id: "a-2", studentUserId: "u-est-2", studentName: "Bruno Prueba", studentEmail: "bruno@correounivalle.edu.co", trigger: "after_accept", status: "done", topic: "arreglos", question: "Que hace la linea?", chosenIndex: 1, correct: false, followupScore: null, launchId: null, customQuizId: "", createdAt: "2026-09-26T10:00:00.000Z", answeredAt: "2026-09-26T10:01:00.000Z" },
  ];
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-docente": PRIVACY_POLICY_VERSION } });
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);
  const markup = tab.run<string>("buildOverlayMarkup()");

  // --- RAG: la pestaña trae el catalogo de lotes junto con las fuentes.
  await drive(browser, tab.el("tabBtnRag").click());
  await browser.clock.until(() => tab.state().teacherRagLoadedAt > 0 && tab.state().ragLots.loadedAt > 0, 400);
  assert.equal(browser.requestsTo("/api/rag/lots", "GET").length, 1);
  let groups = tab.el("ragCourseGroups").children;
  const fpoo = () => Array.from(tab.el("ragCourseGroups").children).find((group: any) => group.dataset.courseCode === "FPOO") as any;
  assert.equal(fpoo().children[0].children[2].textContent, "Activo: Base del curso", "sin lotes, la base esta activa");
  let toolbar = fpoo().children[1].children[0];
  assert.equal(toolbar.children[0].children[0].textContent, "Lote activo");
  assert.equal(toolbar.children[1].children[0].textContent, "Cargar en");
  assert.equal(toolbar.children[3].textContent, "Nuevo lote");
  // Desactivar una fuente de la base: PUT /api/rag/sources/:id/active y la fuente queda marcada.
  let base = fpoo().children[1].children[2];
  let baseList = base.children[1].children[1];
  assert.equal(baseList.children.length, 2);
  const conceptos = Array.from(baseList.children).find((item: any) => item.children[0].children[0].children[0].textContent === "Conceptos basicos") as any;
  const toggle = Array.from(conceptos.children[0].children[1].children).find((button: any) => button.textContent === "Desactivar") as any;
  assert.ok(toggle, "cada fuente se puede desactivar");
  await drive(browser, toggle.click(), 800);
  await browser.clock.until(() => !tab.state().ragLots.busy, 400);
  assert.deepEqual(browser.ragDisabledSourceIds, ["RAG-FPOO-17"]);
  assert.deepEqual(browser.requestsTo("/api/rag/sources/RAG-FPOO-17/active", "PUT").map((request) => request.body), [{ isActive: false }]);
  base = fpoo().children[1].children[2];
  baseList = base.children[1].children[1];
  const disabledItem = Array.from(baseList.children).find((item: any) => item.children[0].children[0].children[0].textContent === "Conceptos basicos") as any;
  assert.match(disabledItem.className, /is-disabled/);
  assert.match(disabledItem.children[0].children[0].children[1].textContent, /Apagada para tus estudiantes/);
  assert.ok(Array.from(disabledItem.children[0].children[1].children).some((button: any) => button.textContent === "Activar"));
  assert.match(tab.el("ragCoursesMessage").textContent, /apagada: tus estudiantes ya no la reciben/);

  // Nuevo lote: el formulario, POST /api/rag/lots y el lote aparece inactivo con «Activar en el curso».
  await drive(browser, toolbar.children[3].click());
  let form = fpoo().children[1].children[2];
  assert.equal(form.className, "rag-lot-form");
  form.children[0].value = "Enfoque videojuegos";
  form.children[1].value = "Ejemplos con juegos 2D";
  await drive(browser, form.children[3].children[1].click(), 800);
  await browser.clock.until(() => !tab.state().ragLots.busy, 400);
  assert.deepEqual(browser.requestsTo("/api/rag/lots", "POST").map((request) => request.body), [
    { courseCode: "FPOO", name: "Enfoque videojuegos", description: "Ejemplos con juegos 2D", includesBase: true },
  ]);
  assert.equal(tab.state().ragLotFormOpen.FPOO, false, "el formulario se cierra al guardar");
  let lotGroup = fpoo().children[1].children[3];
  assert.equal(lotGroup.children[0].children[0].textContent, "Enfoque videojuegos");
  assert.equal(lotGroup.children[0].children[1].textContent, "Inactivo");
  const activateBtn = lotGroup.children[1].children[1].children[0];
  assert.equal(activateBtn.textContent, "Activar en el curso");
  await drive(browser, activateBtn.click(), 800);
  await browser.clock.until(() => !tab.state().ragLots.busy, 400);
  assert.deepEqual(browser.ragActiveLots, { FPOO: "lote-1" });
  assert.equal(fpoo().children[0].children[2].textContent, "Activo: Enfoque videojuegos");
  toolbar = fpoo().children[1].children[0];
  assert.equal(toolbar.children[0].children[1].value, "lote-1", "el selector muestra el lote activo");
  lotGroup = fpoo().children[1].children[3];
  assert.equal(lotGroup.children[0].children[1].textContent, "Activo");
  // Cargar una fuente dentro del lote: el selector de carga recuerda el lote y la carga lo manda.
  const uploadHere = Array.from(lotGroup.children[1].children[1].children).find((button: any) => button.textContent === "Cargar fuente aqui") as any;
  await drive(browser, uploadHere.click());
  assert.equal(tab.state().ragUploadLotByCourse.FPOO, "lote-1");
  assert.equal(tab.state().teacherRagState.selectedCourseCode, "FPOO");
  assert.match(tab.el("ragCoursesStatus").textContent, /1 lote/);

  // --- Usuarios: «RAG aplicado» y el lote por estudiante en la fila de edicion.
  await drive(browser, tab.el("tabBtnUsuarios").click());
  await browser.clock.until(() => tab.el("adminUsersTableBody").children.length >= 2, 400);
  let rows = tab.el("adminUsersTableBody").children;
  assert.equal(rows[0].children[5].children[0].children[0].textContent, "Enfoque videojuegos", "Ana recibe el lote activo del curso");
  assert.equal(rows[1].children[5].children[0].children[0].textContent, "FPOO: Enfoque videojuegos");
  assert.equal(rows[1].children[5].children[0].children[1].textContent, "FPI: Base del curso");
  await drive(browser, rows[0].children[7].children[0].click());
  const editForm = tab.el("adminUsersTableBody").children[1].children[0].children[0];
  const lotField = Array.from(editForm.children).find((child: any) => child.children[0]?.textContent === "Lote de RAG aplicado (se guarda al cambiar)") as any;
  assert.ok(lotField, "la fila de edicion trae el lote por curso");
  const lotSelect = lotField.children[1].children[0].children[1];
  assert.equal(lotSelect.tagName, "SELECT");
  assert.equal(lotSelect.children[0].textContent, "Lote activo del curso (Enfoque videojuegos)");
  assert.equal(lotSelect.children[1].textContent, "Enfoque videojuegos");
  lotSelect.value = "lote-1";
  await drive(browser, lotSelect.dispatch("change"), 800);
  await browser.clock.until(() => tab.state().adminUsersBusy === false, 400);
  assert.deepEqual(browser.ragStudentLots, [{ studentUserId: "u-est-1", courseCode: "FPOO", lotId: "lote-1" }]);
  assert.deepEqual(browser.requestsTo("/api/rag/students/u-est-1/lot", "PUT").map((request) => request.body), [{ courseCode: "FPOO", lotId: "lote-1" }]);
  assert.match(tab.el("adminUsersStatus").textContent, /Lote de RAG guardado para Ana/);
  rows = tab.el("adminUsersTableBody").children;
  assert.equal(rows[0].children[5].children[0].children[0].className, "admin-chip is-lot-student", "asignado a la persona, no al curso");

  // --- Quices: banco propio, quices hechos con nombre y «Crear quiz» en otra pestaña.
  assert.equal(tab.el("tabBtnQuices").hidden, false);
  assert.deepEqual(browser.requestsTo("/api/quiz/custom"), [], "no se pide hasta abrir la pestaña");
  await drive(browser, tab.el("tabBtnQuices").click());
  await browser.clock.until(() => tab.state().quizzesPanel.loadedAt > 0, 400);
  assert.equal(tab.el("tabPanelQuices").hidden, false);
  assert.equal(browser.requestsTo("/api/quiz/custom", "GET").length, 1);
  assert.equal(browser.requestsTo("/api/quiz/attempts", "GET").length, 1);
  assert.equal(tab.el("quizzesBankList").children.length, 1);
  assert.equal(tab.el("quizzesBankList").children[0].children[0].children[0].textContent, "Encapsulamiento");
  assert.equal(tab.el("quizzesDoneBody").children.length, 2);
  assert.equal(tab.el("quizzesDoneBody").children[0].children[0].children[0].textContent, "Ana María Pérez González");
  assert.equal(tab.el("quizzesDoneBody").children[0].children[1].children[1].textContent, "Mi banco");
  assert.equal(tab.el("quizzesDoneBody").children[0].children[2].children[0].textContent, "Correcta · 80/100");
  assert.equal(tab.el("quizzesDoneBody").children[1].children[1].children[1].textContent, "Tras aceptar");
  assert.equal(tab.el("quizzesDoneBody").children[1].children[2].children[0].textContent, "Incorrecta");
  assert.match(tab.el("quizzesStatus").textContent, /1 quiz propio \| 2 quices hechos/);
  // Lanzar desde el banco: POST /api/quiz/custom/:id/launch y el estado del quiz de la clase.
  const launchBtn = tab.el("quizzesBankList").children[0].children[3].children[0];
  assert.equal(launchBtn.textContent, "Lanzar");
  await drive(browser, launchBtn.click(), 800);
  await browser.clock.until(() => tab.state().quizzesPanel.busy === false, 400);
  assert.deepEqual(browser.customQuizLaunches, ["cq-1"]);
  assert.match(tab.el("quizzesMessage").textContent, /«Encapsulamiento» lanzado a la clase/);
  assert.match(tab.el("teacherQuizStatus").textContent, /Activo: "Encapsulamiento"/);
  const bankItem = tab.el("quizzesBankList").children[0];
  assert.match(bankItem.className, /is-live/);
  const closeBtn = Array.from(bankItem.children[3].children).find((button: any) => button.textContent === "Cerrar") as any;
  await drive(browser, closeBtn.click(), 800);
  await browser.clock.until(() => tab.state().quizzesPanel.busy === false, 400);
  assert.deepEqual(browser.closedLaunches, ["launch-cq-1"]);
  // «Crear quiz» abre /docente/quices del backend en otra pestaña.
  await drive(browser, tab.el("quizzesCreateBtn").click());
  assert.equal(tab.popups.length, 1);
  assert.equal(tab.popups[0].currentHref, `${BACKEND}/docente/quices`);
  assert.match(tab.el("quizzesMessage").textContent, /Se abrio «Crear quiz» en otra pestaña/);
  // «Monitor» abre /docente/monitor (lo de npm run piloto:monitor) en otra pestaña, con la misma sesión.
  assert.equal(tab.el("quizzesMonitorBtn").disabled, false);
  await drive(browser, tab.el("quizzesMonitorBtn").click());
  assert.equal(tab.popups.length, 2);
  assert.equal(tab.popups[1].currentHref, `${BACKEND}/docente/monitor`);
  assert.match(tab.el("quizzesMessage").textContent, /Se abrio «Monitor» en otra pestaña/);
  // Retirar del banco.
  const retireBtn = Array.from(tab.el("quizzesBankList").children[0].children[3].children).find((button: any) => button.textContent === "Retirar") as any;
  await drive(browser, retireBtn.click(), 800);
  await browser.clock.until(() => tab.state().quizzesPanel.busy === false, 400);
  assert.deepEqual(browser.customQuizzes, []);
  assert.equal(tab.el("quizzesBankList").children.length, 0);
  assert.equal(tab.el("quizzesBankEmpty").hidden, false);

  // --- Tuerca: RA1 a RA5 y la ayuda «?» con el peso de cada RA.
  await drive(browser, tab.el("settingsBtn").click(), 400);
  assert.match(markup, /<option value="RA4">RA4<\/option>\s*<option value="RA5">RA5<\/option>/);
  assert.equal(tab.el("teacherOutcomeHelp").hidden, true);
  await drive(browser, tab.el("teacherOutcomeHelpBtn").click());
  assert.equal(tab.el("teacherOutcomeHelp").hidden, false);
  assert.equal(tab.el("teacherOutcomeHelpBtn").getAttribute("aria-expanded"), "true");
  const outcomes = tab.el("teacherOutcomeHelp").children[1].children;
  assert.equal(outcomes.length, 5);
  assert.match(outcomes[0].children[0].children[0].textContent, /RA1 · 15 % de la nota/);
  assert.match(outcomes[2].children[0].children[0].textContent, /RA3 · 29 % de la nota/);
  // 0.7.18 (A10.9): enunciado del programa y competencia de cada RA, antes del reparto.
  assert.match(outcomes[0].children[1].textContent, /^Usa los tipos de datos básicos y los agregados/);
  assert.match(outcomes[3].children[1].textContent, /^Diseña, documenta, implementa y depura un programa/);
  assert.equal(outcomes[0].children[2].textContent, "Competencia C.E.3");
  assert.equal(outcomes[4].children[2].textContent, "Competencia C.G.4 · en el programa: RA5.1");
  assert.match(outcomes[4].children[3].textContent, /Lab 1 1,7 % · Lab 2 0,73 %/);
  assert.match(outcomes[0].className, /is-selected/);
  await drive(browser, tab.el("teacherOutcomeHelpBtn").click());
  assert.equal(tab.el("teacherOutcomeHelp").hidden, true);
  await drive(browser, tab.el("settingsCloseBtn").click(), 400);

  // --- Bitacora: exportar en Excel o CSV solo con una bitacora cargada.
  assert.match(markup, /id="teacherBitacoraExportXlsxBtn"/);
  assert.match(markup, /id="teacherBitacoraExportCsvBtn"/);
  assert.match(markup, /Exportar bitácora \(Excel\)/);
  assert.match(markup, /Exportar bitácora \(CSV\)/);
  assertKnownShadowIds(tab);
  assert.deepEqual(browser.unknownRoutes.filter((route) => !route.includes("/api/projects") && !route.includes("/api/behavior/summary")), []);
});

// ---- Pestaña «Bitácora» del docente (0.7.16) ----

function teacherBitacoraBrowser() {
  const browser = new FakeBrowser();
  browser.session = { ...SESSION, user: { ...SESSION.user, id: "u-docente", role: "teacher", displayName: "Docente Prueba", assignedCourseCodes: [] } };
  browser.bitacoraLatest = null;
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-docente": PRIVACY_POLICY_VERSION } });
  return browser;
}

// Evento de arrastre con un archivo, como el que da el navegador (dataTransfer.types trae "Files").
function fileDrag(file: File) {
  return { dataTransfer: { types: ["Files"], files: [file], dropEffect: "none" } };
}

test("0.7.16: pestaña «Bitácora»: estado en Inicio, «Subir bitácora» en la acción recomendada y soltar el archivo", async () => {
  const browser = teacherBitacoraBrowser();
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false && tab.state().teacherBitacoraStatus.checkedAt > 0, 400);

  // Una sola consulta al entrar, sin abrir la pestaña.
  assert.equal(browser.requestsTo("/api/documents/bitacora/status").length, 1);
  assert.equal(tab.el("tabBtnBitacora").hidden, false);
  assert.equal(tab.el("tabFlagBitacora").hidden, false, "la pestaña avisa que falta la bitácora");
  // Inicio: una línea con el estado que lleva a la pestaña (antes, un botón «Bitacora» en el resumen).
  assert.equal(tab.el("teacherBitacoraHomeLine").hidden, false);
  assert.equal(tab.el("teacherBitacoraHomeChip").textContent, "Falta");
  assert.match(tab.el("teacherBitacoraHomeText").textContent, /Aún no la subes/);
  assert.match(tab.el("teacherBitacoraHomeLine").getAttribute("aria-label"), /^Bitácora del curso, falta: /);
  // La acción recomendada pide subirla; la otra sigue siendo la del repositorio.
  assert.equal(tab.el("contextActionTitle").textContent, "Sube la bitácora del curso");
  assert.equal(tab.el("contextPrimaryActionBtn").dataset.contextAction, "upload_teacher_bitacora");
  assert.equal(tab.el("contextPrimaryActionBtn").textContent, "Subir bitácora");
  assert.equal(tab.el("contextSecondaryActionBtn").dataset.contextAction, "open_local_vscode");

  // «Subir bitácora»: la pestaña y el selector de archivo en el mismo clic.
  let pickerClicks = 0;
  tab.el("teacherBitacoraFileInput").addEventListener("click", () => { pickerClicks += 1; });
  await drive(browser, tab.el("contextPrimaryActionBtn").click());
  assert.equal(tab.state().mainTab, "bitacora");
  assert.equal(tab.el("tabPanelBitacora").hidden, false);
  assert.equal(tab.el("tabPanelInicio").hidden, true);
  assert.equal(tab.el("tabBtnBitacora").getAttribute("aria-selected"), "true");
  assert.equal(pickerClicks, 1, "abre el selector de archivo");
  assert.equal(browser.requestsTo("/api/documents/bitacora/status").length, 1, "el estado de hace menos de un minuto no se vuelve a pedir");
  assert.equal(tab.el("teacherBitacoraStateChip").textContent, "Falta");
  assert.match(tab.el("teacherBitacoraStatusText").textContent, /Aún no has subido la bitácora/);
  assert.equal(tab.el("teacherBitacoraLatestText").textContent, "Aún no hay bitácora cargada.");
  assert.equal(tab.el("teacherBitacoraChooseFileBtn").disabled, false);
  assert.equal(tab.el("teacherBitacoraExportXlsxBtn").disabled, true, "sin bitácora no hay nada que exportar");
  assert.equal(tab.el("teacherBitacoraDeleteLatestBtn").disabled, true);

  // Soltar un archivo que no es Excel ni PDF: no se sube y el estado dice por qué.
  await drive(browser, tab.el("tabPanelBitacora").dispatch("drop", fileDrag(new File(["hola"], "notas.docx"))));
  assert.deepEqual(browser.bitacoraUploads, []);
  assert.match(tab.el("statusText").textContent, /«notas\.docx» no es un Excel \(\.xlsx, \.xls\) ni un PDF/);

  // Arrastrar resalta la zona; soltar el Excel lo sube y la pestaña muestra la bitácora.
  const excel = new File(["xlsx"], "BITACORA.FPOO.2026-2.xlsx");
  await drive(browser, tab.el("tabPanelBitacora").dispatch("dragenter", fileDrag(excel)));
  assert.equal(tab.el("teacherBitacoraDropZone").classList.contains("is-dragover"), true);
  const overEvent = fileDrag(excel);
  await drive(browser, tab.el("tabPanelBitacora").dispatch("dragover", overEvent));
  assert.equal(overEvent.dataTransfer.dropEffect, "copy", "la pestaña acepta el archivo (si no, el navegador lo abriría)");
  await drive(browser, tab.el("tabPanelBitacora").dispatch("drop", fileDrag(excel)), 2000);
  assert.equal(tab.el("teacherBitacoraDropZone").classList.contains("is-dragover"), false);
  assert.deepEqual(browser.bitacoraUploads, ["BITACORA.FPOO.2026-2.xlsx"]);
  assert.equal(browser.requestsTo("/api/documents/bitacora/import", "POST").length, 1);
  assert.equal(tab.el("teacherBitacoraStateChip").textContent, "Cargada");
  assert.match(tab.el("teacherBitacoraLatestText").textContent, /^BITACORA\.FPOO\.2026-2\.xlsx · 2 semanas · actualizada /);
  assert.equal(tab.el("teacherBitacoraDropZone").classList.contains("is-loaded"), true);
  assert.equal(tab.el("tabFlagBitacora").hidden, true);
  assert.equal(tab.el("teacherBitacoraWeekCount").textContent, "2");
  assert.equal(tab.el("teacherBitacoraAgendaList").children.length, 2, "una fila por semana");
  assert.equal(tab.el("teacherBitacoraAgendaList").children[1].children[0].children[0].textContent, "Semana 2");
  assert.equal(tab.el("teacherBitacoraExportXlsxBtn").disabled, false);
  assert.equal(tab.el("teacherBitacoraDeleteLatestBtn").disabled, false);
  assert.equal(tab.state().analysisWindowOpen, false, "el resultado se ve en la pestaña, sin la ventana de análisis");
  assert.match(tab.el("statusText").textContent, /Bitácora subida: 2 registro\(s\)/);

  // Inicio: la línea dice que está cargada y la acción recomendada vuelve a la de siempre.
  await drive(browser, tab.el("tabBtnInicio").click());
  assert.equal(tab.el("teacherBitacoraHomeChip").textContent, "Cargada");
  assert.match(tab.el("teacherBitacoraHomeText").textContent, /^BITACORA\.FPOO\.2026-2\.xlsx · 2 semanas · actualizada /);
  assert.equal(tab.el("contextActionTitle").textContent, "Panel docente");
  assert.equal(tab.el("contextPrimaryActionBtn").dataset.contextAction, "open_settings");
  await drive(browser, tab.el("teacherBitacoraHomeLine").click());
  assert.equal(tab.state().mainTab, "bitacora", "la línea de Inicio lleva a la pestaña");
  assert.equal(tab.document.activeElement, tab.el("tabBtnBitacora"), "el foco pasa a la pestaña (la línea queda oculta)");

  // Markup: la página aparte y el botón «Bitacora» de Inicio ya no existen.
  const markup = tab.run<string>("buildOverlayMarkup()");
  assert.doesNotMatch(markup, /id="teacherBitacoraPage"|id="teacherBitacoraCloseBtn"|id="teacherBitacoraUploadBtn"|id="teacherBitacoraPageStatus"/);
  assert.match(markup, /id="tabPanelBitacora"[\s\S]*id="teacherBitacoraDropZone"[\s\S]*Subir bitácora \(Excel\/PDF\)/);
  assert.match(markup, /<details class="bitacora-fold" id="teacherBitacoraWeeksFold">/);
  assert.match(markup, /<details class="bitacora-fold" id="teacherBitacoraManualFold">/);
  assert.match(markup, /<details class="bitacora-fold is-danger" id="teacherBitacoraDataFold">/);
  assert.match(tab.run<string>("OVERLAY_STYLES"), /\.bitacora-dropzone\.is-dragover \{/);
  assertKnownShadowIds(tab);
  assert.deepEqual(browser.unknownRoutes.filter((route) => !route.includes("/api/projects") && !route.includes("/api/behavior/summary")), []);
});

// 0.7.22: el administrador también tiene «Bitácora»: elige el docente y sube la bitácora de ese docente.
test("0.7.22: el administrador elige el docente en «Bitácora» y sube su bitácora con teacherUserId", async () => {
  const browser = new FakeBrowser();
  browser.session = ADMIN_SESSION;
  browser.adminTeachers = [
    { id: "u-docente", email: "docente@correounivalle.edu.co", displayName: "Docente Prueba" },
    { id: "u-docente-2", email: "victor.bucheli@correounivalle.edu.co", displayName: "Víctor Bucheli" },
  ];
  browser.bitacoraLatest = null;
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-admin": PRIVACY_POLICY_VERSION } });
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => tab.state().loading === false, 400);

  // La pestaña está; al abrirla consulta el estado y trae los docentes.
  assert.equal(tab.el("tabBtnBitacora").hidden, false, "el administrador ve «Bitácora»");
  await drive(browser, tab.el("tabBtnBitacora").click(), 400);
  await browser.clock.until(() => tab.state().teacherBitacoraStatus.checkedAt > 0, 400);
  assert.equal(tab.el("tabPanelBitacora").hidden, false);
  assert.equal(tab.el("teacherBitacoraOwnerField").hidden, false);
  const select = tab.el("teacherBitacoraOwnerSelect");
  assert.equal(select.children.length, 2);
  assert.equal(select.value, "u-docente", "empieza con el que eligió el backend");
  assert.match(tab.el("teacherBitacoraStatusText").textContent, /^Docente Prueba aún no tiene bitácora/);
  assert.equal(tab.el("teacherBitacoraHomeLine").hidden, true, "la línea de Inicio es del docente");
  assert.equal(tab.el("tabFlagBitacora").hidden, true);

  // Cambia de docente: consulta la bitácora de ese docente.
  select.value = "u-docente-2";
  await drive(browser, select.dispatch("change"), 400);
  await browser.clock.until(() => tab.state().teacherBitacoraStatus.checkedAt > 0 && !tab.state().teacherBitacoraStatus.checking, 400);
  const statusRequest = browser.requestsTo("/api/documents/bitacora/status").at(-1);
  assert.match(String(statusRequest?.query), /teacherUserId=u-docente-2/);
  assert.equal(tab.state().bitacoraOwner.teacherUserId, "u-docente-2");
  assert.match(tab.el("teacherBitacoraStatusText").textContent, /^Víctor Bucheli aún no tiene bitácora/);

  // Sube el Excel: va con teacherUserId y queda cargada para ese docente.
  const excel = new File(["xlsx"], "BITACORA.FPOO.2026-2.xlsx");
  await drive(browser, tab.el("tabPanelBitacora").dispatch("drop", fileDrag(excel)), 2000);
  assert.deepEqual(browser.bitacoraUploads, ["BITACORA.FPOO.2026-2.xlsx"]);
  assert.deepEqual(browser.bitacoraUploadOwners, ["u-docente-2"]);
  assert.equal(tab.el("teacherBitacoraStateChip").textContent, "Cargada");
  assert.match(tab.el("teacherBitacoraStatusText").textContent, /^Cargada para Víctor Bucheli\./);
  assertKnownShadowIds(tab);
});

test("0.7.16: docente en Campus sin bitácora: «Subir bitácora» y, al subirla, la acción pasa a «Analizar Campus»", async () => {
  const browser = teacherBitacoraBrowser();
  const tab = await openCampusCourse(browser);
  // La verificación del curso trae también el estado de la bitácora del docente: una sola consulta.
  assert.equal(browser.requestsTo("/api/documents/bitacora/status").length, 1);
  assert.ok(tab.state().teacherBitacoraStatus.checkedAt > 0);
  assert.equal(tab.el("tabFlagBitacora").hidden, false);
  assert.equal(tab.el("contextActionTitle").textContent, "Bitacora requerida");
  assert.match(tab.el("contextActionCopy").textContent, /aún no has subido la bitácora del curso/);
  assert.equal(tab.el("contextPrimaryActionBtn").textContent, "Subir bitácora");
  await drive(browser, tab.el("contextPrimaryActionBtn").click());
  assert.equal(tab.state().mainTab, "bitacora");

  // Con el selector de archivo: sube el PDF y el curso se vuelve a verificar solo.
  const input = tab.el("teacherBitacoraFileInput");
  input.files = [new File(["pdf"], "bitacora-fpoo.pdf")];
  await drive(browser, input.dispatch("change"), 2000);
  await browser.clock.until(() => !tab.run("isCampusAccessVerificationInFlight()"), 400);
  assert.deepEqual(browser.bitacoraUploads, ["bitacora-fpoo.pdf"]);
  assert.equal(browser.requestsTo("/api/documents/bitacora/status").length, 2, "el curso se vuelve a verificar tras subirla");
  assert.equal(tab.state().campusCourseAccess.bitacoraLoaded, true);
  await drive(browser, tab.el("tabBtnInicio").click());
  assert.equal(tab.el("contextActionTitle").textContent, "Agenda Campus");
  assert.equal(tab.el("contextPrimaryActionBtn").textContent, "Analizar Campus");
  assert.equal(tab.el("teacherBitacoraHomeChip").textContent, "Cargada");
  assertKnownShadowIds(tab);
});

test("0.7.16: docente en Campus fuera de un curso sin bitácora: la acción recomendada también es subirla", async () => {
  const browser = teacherBitacoraBrowser();
  const tab = await openTab(browser, "https://campusvirtual.univalle.edu.co/moodle/my/", "Área personal");
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false && tab.state().teacherBitacoraStatus.checkedAt > 0, 400);
  assert.equal(browser.requestsTo("/api/documents/bitacora/status").length, 1);
  assert.equal(tab.el("contextActionTitle").textContent, "Sube la bitácora del curso");
  assert.equal(tab.el("contextPrimaryActionBtn").dataset.contextAction, "upload_teacher_bitacora");
  assert.equal(tab.el("contextSecondaryActionBtn").dataset.contextAction, "open_settings", "sin repositorio, la otra acción es la tuerca");
  assertKnownShadowIds(tab);
});
