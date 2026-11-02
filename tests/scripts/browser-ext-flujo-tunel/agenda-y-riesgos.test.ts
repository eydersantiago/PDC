import assert from "node:assert/strict";
import test from "node:test";
import { PRIVACY_POLICY_VERSION } from "../../../src/routes/pages/privacy-policy-routes.js";
import { REPO, SESSION, type Json } from "./harness-config.js";
import type { FakeElement } from "./harness-dom.js";
import { FakeBrowser } from "./harness-backend.js";
import { drive, openTab, advance, assertKnownShadowIds, seedLoggedInBrowser } from "./harness-utils.js";
import { fpooBitacoraLatest, DOMINGO_SEMANA_5, openStudentAgenda } from "./harness-helpers.js";

// ---- Agenda del estudiante con la bitacora FPOO corrida al 25 de agosto de 2026 (0.7.17) ----
test("0.7.17: el estudiante ve «Estás en FPOO · semana 5 de 16», el tutor recibe la semana y Calendar solo crea lo que falta", async () => {
  const browser = new FakeBrowser();
  browser.clock.now = DOMINGO_SEMANA_5;
  browser.bitacoraLatest = await fpooBitacoraLatest();
  // Un evento propio del estudiante el jueves 1 de octubre de 18:30 a 20:30.
  browser.calendarEvents.push({ id: "propio-1", summary: "Monitoria de calculo", start: { dateTime: "2026-10-01T18:30:00-05:00" }, end: { dateTime: "2026-10-01T20:30:00-05:00" } });
  const tab = await openStudentAgenda(browser);

  // Inicio: la linea con el curso, la semana, el tema y la proxima evaluacion.
  assert.equal(browser.requestsTo("/api/documents/bitacora/status").length, 1, "una consulta al entrar");
  assert.equal(tab.el("tabBtnAgenda").hidden, false);
  assert.equal(tab.el("agendaHomeLine").hidden, false);
  assert.equal(tab.el("teacherBitacoraHomeLine").hidden, true, "la linea del docente no es para el estudiante");
  assert.equal(tab.el("agendaHomeEyebrow").textContent, "Estás en FPOO · semana 5 de 16");
  assert.equal(tab.el("agendaHomeText").textContent, "Uso de clases de bibliotecas, APIs, y reutilización de código · Próximo: Examen (Primer parcial), mar 6 oct (en 9 días)");
  assert.equal(tab.el("agendaHomeChip").textContent, "Semana 5");

  // El tutor recibe la semana con la primera pregunta.
  const intervene = browser.requestsTo("/intervene")[0];
  assert.ok(intervene, "el tutor respondio al entrar");
  assert.deepEqual((intervene.body as Json).context && ((intervene.body as Json).context as Json).courseWeek, {
    courseCode: "FPOO",
    week: 5,
    totalWeeks: 16,
    topic: "Uso de clases de bibliotecas, APIs, y reutilización de código",
    weekStart: "2026-09-22",
    weekEnd: "2026-09-28",
    upcoming: [
      { title: "Examen (Primer parcial)", date: "2026-10-06", category: "Parcial" },
      { title: "Entrega de proyecto de curso 2", date: "2026-10-13", category: "Proyecto" },
      { title: "Proyecto 3 entrega", date: "2026-11-24", category: "Proyecto" },
    ],
  });

  // En el Tutor (donde entra en el editor) la misma semana, en una linea que lleva a «Agenda».
  // 0.8.3: el estado de VS Code ya no es una tarjeta flotante que sigue al puntero (tapaba la
  // agenda y el panel): es una linea de «Inicio» y en las otras pestanas no se ve.
  assert.equal(tab.el("tutorWeekLine").hidden, false);
  assert.equal(tab.el("tutorWeekChip").textContent, "Semana 5 de 16");
  assert.equal(tab.el("tutorWeekText").textContent, "FPOO: Uso de clases de bibliotecas, APIs, y reutilización de código");
  assert.equal(tab.run(`buildTabPanelInicioTemplate().includes('id="vscodeSyncSection"')`), true, "la linea de VS Code vive en Inicio");
  assert.equal(tab.run(`/vscode-sync-overlay|vscodeInlinePalette|Contexto de trabajo/.test(buildOverlayShellTemplate())`), false, "sin tarjeta ni paleta flotantes");
  assert.equal(tab.el("vscodeSyncSection").hidden, false, "en una pagina de editor la linea se pinta");
  await drive(browser, tab.el("tutorWeekLine").click());
  assert.equal(tab.state().mainTab, "agenda");
  assert.equal(tab.el("tabPanelInicio").hidden, true, "en «Agenda» la linea (en Inicio) no se ve");
  await drive(browser, tab.run("setMainTab('inicio', { byUser: true, forceRender: true })"));
  assert.equal(tab.el("tabPanelInicio").hidden, false);
  assert.equal(tab.el("vscodeSyncSection").hidden, false);

  // «Agenda»: la semana, las proximas evaluaciones y todas las semanas.
  await drive(browser, tab.el("agendaHomeLine").click());
  assert.equal(tab.state().mainTab, "agenda");
  assert.equal(tab.el("tabPanelAgenda").hidden, false);
  assert.equal(tab.document.activeElement, tab.el("tabBtnAgenda"));
  assert.equal(tab.el("agendaTitle").textContent, "Estás en FPOO · semana 5 de 16");
  assert.match(tab.el("agendaStatusText").textContent, /· 22–28 sep · según la bitácora de tu docente\.$/);
  assert.equal(tab.el("agendaWeekCard").hidden, false);
  assert.equal(tab.el("agendaWeekTopic").textContent, "Uso de clases de bibliotecas, APIs, y reutilización de código");
  assert.equal(tab.el("agendaWeekActivities").children[0].textContent, "Software modular, refactoring, reutilización de código y calidad");
  const upcoming = tab.el("agendaUpcomingList").children;
  assert.equal(upcoming.length, 4);
  assert.deepEqual(Array.from(upcoming[0].children, (child) => child.textContent), ["mar 6 oct", "Examen (Primer parcial)", "Parcial · semana 7 · en 9 días"]);
  assert.equal(upcoming[1].children[1].textContent, "Entrega de proyecto de curso 2");
  assert.equal(tab.el("agendaWeeksCount").textContent, "16");
  const weekRows = tab.el("agendaWeeksList").children;
  assert.equal(weekRows.length, 17, "16 semanas y la sesion opcional");
  assert.equal(weekRows[4].className, "agenda-week-row is-current");
  assert.equal(weekRows[4].children[0].textContent, "Semana 5 · 22–28 sep · hoy");
  assert.equal(weekRows[15].children[0].textContent, "Semana 16 · 8–14 dic");
  assert.equal(weekRows[16].children[1].textContent, "OPCIONAL");
  assert.match(tab.el("agendaCalendarNote").textContent, /Pasa a tu Google Calendar \(alumno@correounivalle\.edu\.co\)/);

  // Google Calendar: el primer parcial ya esta (el estudiante lo paso a las 2 p. m.), la entrega 2
  // quedo con la fecha vieja, el estudiante anoto la entrega 3 a su manera, paso la entrega 4 al
  // dia anterior y la entrega final vino de Campus. El parcial de otra materia el dia del segundo
  // parcial no cuenta.
  const keys = tab.run<string[]>("getCourseAgendaView().upcoming.map((evaluation) => evaluation.key)");
  assert.equal(keys.length, 6);
  const courseProps = (key: string) => ({ private: { adaceen: "bitacora", adaceenCourse: "FPOO", adaceenKey: key, adaceenType: "evaluation" } });
  browser.calendarEvents.push(
    { id: "ya-1", summary: "FPOO: Examen (Primer parcial)", start: { dateTime: "2026-10-06T14:00:00-05:00" }, end: { dateTime: "2026-10-06T16:00:00-05:00" }, extendedProperties: courseProps(keys[0]) },
    { id: "vieja-2", summary: "FPOO: Entrega de proyecto de curso 2", start: { dateTime: "2026-10-14T18:00:00-05:00" }, end: { dateTime: "2026-10-14T18:30:00-05:00" }, extendedProperties: courseProps(keys[1]) },
    { id: "propio-3", summary: "Entregar proyecto 3 de POO", start: { dateTime: "2026-11-24T23:00:00-05:00" }, end: { dateTime: "2026-11-24T23:30:00-05:00" } },
    { id: "movida-4", summary: "FPOO: Entrega proyecto 4", start: { dateTime: "2026-11-30T20:00:00-05:00" }, end: { dateTime: "2026-11-30T21:00:00-05:00" }, extendedProperties: { private: { ...courseProps(keys[4]).private, adaceenDate: "2026-12-01" } } },
    { id: "calculo", summary: "Parcial de Cálculo I", start: { dateTime: "2026-12-01T14:00:00-05:00" }, end: { dateTime: "2026-12-01T16:00:00-05:00" } },
    { id: "campus-final", summary: "ADACEEN entrega: Entrega proyecto final", start: { dateTime: "2026-12-08T23:59:00-05:00" }, end: { dateTime: "2026-12-09T00:29:00-05:00" }, extendedProperties: { private: { adaceen: "campus", adaceenType: "professor_due" } } },
  );
  await drive(browser, tab.el("agendaCalendarSyncBtn").click(), 2000);
  assert.equal(tab.el("agendaCalendarStatus").textContent, "Google Calendar al día: 1 evento creado, 1 con la fecha corregida, 2 ya estaban, 2 ya los tenías con otro nombre.");
  const inserted = browser.calendarMessages.filter((message) => message.type === "ADACEEN_GOOGLE_CALENDAR_INSERT").map((message) => message.event as Json);
  assert.deepEqual(inserted.map((event) => event.summary), ["FPOO: Examen (segundo parcial)"]);
  assert.deepEqual(inserted[0].start, { dateTime: "2026-12-01T09:00:00-05:00", timeZone: "America/Bogota" });
  assert.deepEqual(inserted[0].end, { dateTime: "2026-12-01T11:00:00-05:00", timeZone: "America/Bogota" }, "el parcial dura dos horas");
  assert.deepEqual((inserted[0].reminders as Json).overrides, [{ method: "popup", minutes: 1440 }, { method: "popup", minutes: 60 }]);
  assert.deepEqual((inserted[0].extendedProperties as Json).private, { adaceen: "bitacora", adaceenCourse: "FPOO", adaceenKey: keys[3], adaceenType: "evaluation", adaceenDate: "2026-12-01" });
  const byId = (id: string) => browser.calendarEvents.find((event) => event.id === id) as Json;
  const moved = byId("vieja-2");
  assert.deepEqual([(moved.start as Json).dateTime, (moved.end as Json).dateTime], ["2026-10-13T18:00:00-05:00", "2026-10-13T18:30:00-05:00"], "la entrega 2 pasa al dia nuevo con su hora y su duracion");
  assert.equal(((moved.extendedProperties as Json).private as Json).adaceenDate, "2026-10-13", "y guarda la fecha nueva de la bitacora");
  assert.equal((byId("ya-1").start as Json).dateTime, "2026-10-06T14:00:00-05:00", "la hora que puso el estudiante no se deshace");
  assert.equal((byId("movida-4").start as Json).dateTime, "2026-11-30T20:00:00-05:00", "ni el dia, si la bitacora no cambio");
  assert.equal(browser.calendarMessages.filter((message) => message.type === "ADACEEN_GOOGLE_CALENDAR_PATCH").length, 1);
  assert.ok(browser.calendarMessages.some((message) => message.type === "ADACEEN_GOOGLE_CALENDAR_ACCOUNT"), "comprueba la cuenta de Google");
  const windowQuery = browser.calendarMessages.find((message) => message.type === "ADACEEN_GOOGLE_CALENDAR_LIST" && (message.query as Json).timeMin)?.query as Json;
  assert.deepEqual([windowQuery.timeMin, windowQuery.timeMax], ["2026-09-27T00:00:00-05:00", "2026-12-08T23:59:59-05:00"], "mira el calendario de hoy a la ultima entrega");

  // Otra vez: no se repite nada.
  const insertsBefore = browser.calendarEvents.length;
  await drive(browser, tab.el("agendaCalendarSyncBtn").click(), 2000);
  assert.equal(tab.el("agendaCalendarStatus").textContent, "Google Calendar al día: 4 ya estaban, 2 ya los tenías con otro nombre.");
  assert.equal(browser.calendarEvents.length, insertsBefore);

  // Bloques de estudio: horas libres antes de las tres proximas evaluaciones.
  await drive(browser, tab.el("agendaSuggestBtn").click(), 2000);
  assert.equal(tab.el("agendaSuggestionsBlock").hidden, false);
  assert.match(tab.el("agendaSuggestionsNote").textContent, /horas libres de tu Google Calendar/);
  const suggestions = tab.el("agendaSuggestionList").children;
  const suggestionText = (index: number) => suggestions[index].children[0].children[1].children.map((child: FakeElement) => child.textContent).join(" | ");
  assert.equal(suggestions.length, 6);
  assert.equal(suggestionText(0), "Repasar: Examen (Primer parcial) | jue 1 oct, 16:30–18:30 · 5 días antes del parcial", "esquiva la monitoria de 18:30");
  assert.equal(suggestionText(1), "Repasar: Examen (Primer parcial) | dom 4 oct, 9:00–11:00 · 2 días antes del parcial");
  assert.equal(suggestionText(2), "Avanzar: Entrega de proyecto de curso 2 | vie 9 oct, 18:30–20:00 · 4 días antes de la entrega");
  assert.equal(suggestionText(3), "Avanzar: Entrega de proyecto de curso 2 | lun 12 oct, 18:30–20:00 · Un día antes de la entrega");
  // Se desmarca uno y se agregan los otros cinco.
  const checkbox = suggestions[3].children[0].children[0];
  checkbox.checked = false;
  await drive(browser, tab.el("agendaSuggestionList").dispatch("change", { target: checkbox }));
  await drive(browser, tab.el("agendaSuggestionAddBtn").click(), 2000);
  assert.equal(tab.el("agendaCalendarStatus").textContent, "Bloques de estudio: 5 agregados.");
  const studyEvents = browser.calendarEvents.filter((event) => ((event.extendedProperties as Json)?.private as Json)?.adaceenType === "study_block");
  assert.equal(studyEvents.length, 5);
  assert.equal(studyEvents[0].summary, "Repasar: Examen (Primer parcial) (FPOO)");
  assert.deepEqual(studyEvents[0].start, { dateTime: "2026-10-01T16:30:00-05:00", timeZone: "America/Bogota" });

  // Si Chrome tiene otra cuenta de Google, no se toca ese calendario.
  browser.googleAccount = "alumno.personal@gmail.com";
  const eventsBefore = browser.calendarEvents.length;
  await drive(browser, tab.el("agendaCalendarSyncBtn").click(), 2000);
  assert.match(tab.el("agendaCalendarStatus").textContent, /Chrome tiene abierta la cuenta de Google alumno\.personal@gmail\.com\. Para no llenar otro calendario, sincroniza con la misma cuenta de tu sesión: alumno@correounivalle\.edu\.co\./);
  assert.equal(browser.calendarEvents.length, eventsBefore);

  // El docente corre la bitacora una semana (inicio el 1 de septiembre): lo que puso ADACEEN pasa
  // al dia nuevo con su hora, tambien la entrega que el estudiante habia movido; lo que tenia con
  // otro nombre en la fecha vieja ya no cuenta y se crea.
  browser.googleAccount = "alumno@correounivalle.edu.co";
  browser.bitacoraLatest = await fpooBitacoraLatest("2026-09-01");
  await drive(browser, tab.el("agendaRefreshBtn").click(), 2000);
  assert.equal(tab.el("agendaTitle").textContent, "Estás en FPOO · semana 4 de 16");
  await drive(browser, tab.el("agendaCalendarSyncBtn").click(), 2000);
  assert.equal(tab.el("agendaCalendarStatus").textContent, "Google Calendar al día: 2 eventos creados, 4 con la fecha corregida.");
  assert.equal((byId("ya-1").start as Json).dateTime, "2026-10-13T14:00:00-05:00");
  assert.equal((byId("vieja-2").start as Json).dateTime, "2026-10-20T18:00:00-05:00");
  assert.equal((byId("movida-4").start as Json).dateTime, "2026-12-08T20:00:00-05:00");
  assert.equal(((byId("movida-4").extendedProperties as Json).private as Json).adaceenDate, "2026-12-08");
  const lastInserts = browser.calendarMessages.filter((message) => message.type === "ADACEEN_GOOGLE_CALENDAR_INSERT").slice(-2).map((message) => (message.event as Json).summary);
  assert.deepEqual(lastInserts, ["FPOO: Proyecto 3 entrega", "FPOO: Entrega proyecto final"]);
  assertKnownShadowIds(tab);
  assert.deepEqual(browser.unknownRoutes.filter((route) => !route.includes("/api/projects") && !route.includes("/api/behavior/summary")), []);
});

test("0.7.17: sin el correo de la universidad no se sincroniza; sin bitácora la agenda lo dice", async () => {
  const browser = new FakeBrowser();
  browser.clock.now = DOMINGO_SEMANA_5;
  browser.session = { ...SESSION, user: { ...SESSION.user, email: "alumno@gmail.com" } };
  browser.bitacoraLatest = await fpooBitacoraLatest();
  const tab = await openStudentAgenda(browser);
  await drive(browser, tab.el("tabBtnAgenda").click());
  assert.equal(tab.el("agendaCalendarSyncBtn").disabled, true);
  assert.equal(tab.el("agendaCalendarNote").textContent, "Para sincronizar con Google Calendar entra a ADACEEN con tu correo de la universidad (…@correounivalle.edu.co); ahora estás con alumno@gmail.com.");
  // Las sugerencias salen igual, sin revisar el calendario.
  await drive(browser, tab.el("agendaSuggestBtn").click(), 2000);
  assert.match(tab.el("agendaSuggestionsNote").textContent, /sin revisar tu calendario/);
  assert.equal(tab.el("agendaSuggestionAddBtn").disabled, true);
  assert.deepEqual(browser.calendarMessages, [], "sin permiso de Google no se le pide nada al background");

  const noLog = new FakeBrowser();
  noLog.clock.now = DOMINGO_SEMANA_5;
  noLog.bitacoraLatest = null;
  const noLogTab = await openStudentAgenda(noLog);
  assert.equal(noLogTab.el("agendaHomeText").textContent, "Tu docente aún no sube la bitácora del curso.");
  assert.equal(noLogTab.el("agendaHomeChip").textContent, "Sin bitácora");
  assert.equal(noLogTab.el("tutorWeekLine").hidden, true, "sin semana no hay linea en el Tutor");
  assert.equal(noLogTab.run("buildCourseWeekForTutor()"), null);
  const intervene = noLog.requestsTo("/intervene")[0];
  assert.equal(((intervene?.body as Json)?.context as Json)?.courseWeek, undefined, "sin semana, el tutor no la recibe");
  assertKnownShadowIds(tab, noLogTab);
});

test("0.7.17: el docente corre la bitácora de 2025 con «Inicio del semestre» y ve la semana de hoy", async () => {
  const browser = new FakeBrowser();
  browser.clock.now = DOMINGO_SEMANA_5;
  browser.session = { ...SESSION, user: { ...SESSION.user, id: "u-docente", role: "teacher", displayName: "Docente Prueba", assignedCourseCodes: [] } };
  browser.bitacoraLatest = await fpooBitacoraLatest("");
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-docente": PRIVACY_POLICY_VERSION } });
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => tab.state().loading === false && tab.state().teacherBitacoraStatus.checkedAt > 0, 400);
  assert.equal(tab.el("tabBtnAgenda").hidden, true, "«Agenda» es del estudiante");
  assert.equal(tab.el("agendaHomeLine").hidden, true);

  await drive(browser, tab.el("tabBtnBitacora").click());
  assert.equal(tab.el("teacherBitacoraStartDateInput").value, "2025-08-20", "la fecha de la semana 1 que trae el PDF");
  assert.equal(tab.el("teacherBitacoraStatusText").textContent, "Cargada. Si subes otra, reemplaza a esta.", "en 2026 esa bitacora ya termino");
  assert.equal(tab.el("teacherBitacoraStartNote").textContent, "Semana 1: mié 20 ago · semana 16: mié 3 dic. Al cambiar la fecha, todas las semanas se corren igual (cada 7 días).");

  const input = tab.el("teacherBitacoraStartDateInput");
  input.value = "2026-08-25";
  await drive(browser, input.dispatch("input"));
  await drive(browser, tab.el("teacherBitacoraStartApplyBtn").click(), 2000);
  assert.deepEqual(browser.requestsTo("/api/documents/bitacora/start-date", "PUT").map((request) => request.body), [{ startDate: "2026-08-25" }]);
  assert.equal(tab.el("teacherBitacoraStatusText").textContent, "Cargada. Hoy va en la semana 5 de 16. Si subes otra, reemplaza a esta.");
  assert.equal(tab.el("teacherBitacoraStartNote").textContent, "Semana 1: mar 25 ago · semana 16: mar 8 dic. Al cambiar la fecha, todas las semanas se corren igual (cada 7 días).");
  assert.match(tab.el("statusText").textContent, /Fechas corridas: la semana 1 queda el mar 25 ago y la última fecha es el mar 15 dic \(16 semanas\)\./);
  const weeks = tab.el("teacherBitacoraAgendaList").children;
  assert.equal(weeks[4].className, "bitacora-week-item is-current");
  assert.equal(weeks[4].children[0].children[1].textContent, "22-9-2026 · esta semana");
  assert.equal(weeks[0].children[0].children[1].textContent, "25-8-2026");
  assertKnownShadowIds(tab);
});

// ---- Riesgos antes del piloto (navegador 0.7.18, A12.12 · ADACEEN-155) ----

test("0.7.18: el tutor no se repite ante un fallo y lleva Idempotency-Key; la pestaña oculta no sondea y avisa al cerrarse", async () => {
  const browser = new FakeBrowser();
  browser.provider = "codespaces";
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false, 400);

  // «Empezar» pidio ayuda una vez, con su Idempotency-Key.
  const first = browser.requestsTo("/intervene");
  assert.equal(first.length, 1);
  const firstKey = String(first[0].headers["Idempotency-Key"] || "");
  assert.match(firstKey, /^[A-Za-z0-9._:-]{8,128}$/, "clave de idempotencia valida para el backend");
  assert.equal(browser.requestsTo("/github-mentor").length, 0);

  // Un fallo pasajero (503) ya no se repite en /github-mentor: duplicaba el modelo y el cupo.
  browser.interveneStatus = 503;
  const status = await drive(browser, tab.run("requestBackendMentor(overlayState.context || buildPayload(), 'C++').then(() => 0, (error) => error.status)"));
  assert.equal(status, 503);
  assert.equal(browser.requestsTo("/intervene").length, 2);
  assert.equal(browser.requestsTo("/github-mentor").length, 0, "503: sin segundo intento");

  // Un backend sin /intervene (404) si prueba el nombre viejo, con la misma clave.
  browser.interveneStatus = 404;
  await drive(browser, tab.run("requestBackendMentor(overlayState.context || buildPayload(), 'C++')"));
  const intervene404 = browser.requestsTo("/intervene").at(-1)!;
  const mentor = browser.requestsTo("/github-mentor");
  assert.equal(mentor.length, 1);
  assert.equal(mentor[0].headers["Idempotency-Key"], intervene404.headers["Idempotency-Key"]);
  assert.notEqual(intervene404.headers["Idempotency-Key"], firstKey, "cada pedido tiene su clave");
  browser.interveneStatus = 200;

  // Pestaña oculta: no sondea /api/ui/active-tab (antes cada 9 s); al volver, si.
  const getsBefore = browser.requestsTo("/api/ui/active-tab", "GET").length;
  tab.document.visibilityState = "hidden";
  await advance(browser, 60_000);
  assert.equal(browser.requestsTo("/api/ui/active-tab", "GET").length, getsBefore, "oculta, sin sondeo");
  tab.document.visibilityState = "visible";
  await advance(browser, 10_000);
  assert.ok(browser.requestsTo("/api/ui/active-tab", "GET").length > getsBefore, "visible, vuelve a sondear");

  // Al cerrar la pestaña (pagehide) avisa en el acto con su tabId (antes el setTimeout de
  // beforeunload nunca corria).
  const postsBefore = browser.requestsTo("/api/ui/active-tab", "POST").length;
  await tab.dispatchWindowEvent("pagehide", { persisted: false });
  const posts = browser.requestsTo("/api/ui/active-tab", "POST").slice(postsBefore);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body?.isActive, false);
  assert.equal(posts[0].body?.tabId, tab.run("getActiveTabInstanceId()"));

  // Lo oculto se oculta siempre: la regla [hidden] del estilo base gana a display: grid.
  const baseStyles = String(tab.run("OVERLAY_BASE_STYLES"));
  assert.match(baseStyles, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
});
