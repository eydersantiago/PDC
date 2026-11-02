import assert from "node:assert/strict";
import test from "node:test";
import { PRIVACY_POLICY_VERSION } from "../../../src/routes/pages/privacy-policy-routes.js";
import { SOURCES, REPO, TUNNEL_URL, SESSION, type Json } from "./harness-config.js";
import { FakeBrowser } from "./harness-backend.js";
import { drive, openTab, advance, assertKnownShadowIds, seedLoggedInBrowser } from "./harness-utils.js";
import { ADMIN_SESSION } from "./harness-helpers.js";

// ---- «Iniciar clase» desde la tuerca del administrador o el docente (navegador 0.7.21) ----

const CLASS_EDITORS_OFF = { name: "adaceen-ws", zone: "us-central1-a", kind: "editors", vmStatus: "TERMINATED", state: "off", startRequestedAt: null, problem: "" };
const CLASS_GPU_OFF = { name: "adaceen-worker-v100", zone: "us-central1-b", kind: "gpu", vmStatus: "TERMINATED", state: "off", startRequestedAt: null, problem: "" };
const CLASS_OFF: Json = {
  configured: true,
  provider: "tunnel",
  editorsNeeded: true,
  editors: CLASS_EDITORS_OFF,
  gpus: [CLASS_GPU_OFF],
  gpu: "off",
  workspaceAgentOnline: false,
  modelWorkersAlive: 0,
  ready: false,
  requestedBy: null,
  requestedAt: null,
  checkedAt: "2026-09-25T13:00:00.000Z",
};
const WORKSPACE_TUNNEL_SETTING: Json = {
  provider: "tunnel",
  source: "extension",
  serverProvider: "codespaces",
  choice: "tunnel",
  updatedAt: "2026-09-25T12:00:00.000Z",
  updatedBy: "Admin Prueba",
  agentConfigured: true,
  agentOnline: false,
  transport: "relay",
  vmAutostart: false,
};

test("0.7.21: «Iniciar clase» en la tuerca enciende la GPU y el editor en la nube y sondea cada 10 s hasta que todo esta listo", async () => {
  const browser = new FakeBrowser();
  browser.session = ADMIN_SESSION;
  browser.provider = "tunnel";
  browser.workspaceSetting = { ...WORKSPACE_TUNNEL_SETTING };
  browser.classStatus = structuredClone(CLASS_OFF);
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-admin": PRIVACY_POLICY_VERSION } });
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => tab.state().loading === false, 400);
  assert.deepEqual(browser.requestsTo("/api/admin/clase/estado"), [], "no se consulta hasta abrir la tuerca");

  // La tuerca muestra la seccion «Clase» con lo que dice el backend.
  await drive(browser, tab.el("settingsBtn").click(), 400);
  await browser.clock.until(() => !!tab.state().classStatus, 400);
  assert.equal(tab.el("settingsSectionClass").hidden, false);
  assert.equal(tab.el("classEditorValue").textContent, "Apagada");
  assert.equal(tab.el("classModelValue").textContent, "Sin servidores; GPU apagada");
  assert.equal(tab.el("settingsSectionClassHint").textContent, "No está lista");
  assert.equal(tab.el("classStartBtn").disabled, false);
  assert.match(tab.el("classStartNote").textContent, /^«Iniciar clase» enciende la GPU y, con el editor en la nube, la VM de editores/);
  assert.equal(browser.requestsTo("/api/admin/clase/estado").length, 1, "una consulta por apertura de la tuerca");

  // Pulsar: POST enseguida (sin «Guardar cambios»); la seccion y la linea de estado dicen que se enciende.
  await drive(browser, tab.el("classStartBtn").click(), 400);
  assert.equal(browser.classStarts, 1);
  assert.equal(tab.el("classEditorValue").textContent, "Encendiendo…");
  assert.equal(tab.el("classModelValue").textContent, "GPU encendiendo…");
  assert.match(tab.el("classStartNote").textContent, /^Encendiendo la VM de editores \(el agente se conecta en 1-2 min\)\. Encendiendo la GPU adaceen-worker-v100 .* Esperando a que todo quede listo…$/);
  assert.equal(tab.el("settingsSectionClassHint").textContent, "Encendiendo…");
  assert.match(tab.el("statusText").textContent, /^Encendiendo la VM de editores/);

  // Sondeo cada 10 s (reloj virtual): en 25 s, dos consultas mas.
  const polled = browser.requestsTo("/api/admin/clase/estado").length;
  await advance(browser, 25_000);
  assert.equal(browser.requestsTo("/api/admin/clase/estado").length, polled + 2);
  assert.equal(browser.classStarts, 1, "el sondeo consulta, no vuelve a encender");

  // El agente se conecto y la GPU manda latido: listo, y el sondeo para.
  browser.classStatus = {
    ...browser.classStatus,
    editors: { ...CLASS_EDITORS_OFF, vmStatus: "RUNNING", state: "running" },
    gpus: [{ ...CLASS_GPU_OFF, vmStatus: "RUNNING", state: "running" }],
    gpu: "running",
    workspaceAgentOnline: true,
    modelWorkersAlive: 1,
    ready: true,
  };
  await advance(browser, 10_000);
  await browser.clock.until(() => tab.state().classStatus?.ready === true, 50);
  assert.equal(tab.el("classEditorValue").textContent, "Conectada");
  assert.equal(tab.el("classModelValue").textContent, "1 servidor(es) vivo(s)");
  assert.equal(tab.el("classStartNote").textContent, "Clase lista: editor y modelo atendiendo.");
  assert.equal(tab.el("classStartNote").classList.contains("is-ready"), true);
  assert.equal(tab.el("classStartNote").classList.contains("is-warning"), false);
  assert.equal(tab.el("settingsSectionClassHint").textContent, "Lista");
  assert.equal(tab.el("statusText").textContent, "Clase lista: editor y modelo atendiendo.");
  assert.equal(tab.state().classStartPollUntil, 0);
  const done = browser.requestsTo("/api/admin/clase/estado").length;
  await advance(browser, 60_000);
  assert.equal(browser.requestsTo("/api/admin/clase/estado").length, done, "listo: no se sigue consultando");
  assertKnownShadowIds(tab);
});

test("0.7.21: un backend anterior lo dice y no deja pulsar; una GPU sin cupo se explica; tope de 15 min; el estudiante no ve la seccion", async () => {
  // Backend anterior a 0.7.21 (404): la seccion lo dice y el boton queda deshabilitado.
  const old = new FakeBrowser();
  old.session = ADMIN_SESSION;
  old.provider = "codespaces";
  seedLoggedInBrowser(old, { adaceenPrivacyAcceptedByUser: { "u-admin": PRIVACY_POLICY_VERSION } });
  const oldTab = await openTab(old, `https://github.com/${REPO}`, REPO);
  await drive(old, oldTab.run("openOverlay({ trigger: 'user' })"));
  await old.clock.until(() => oldTab.state().loading === false, 400);
  await drive(old, oldTab.el("settingsBtn").click(), 400);
  await old.clock.until(() => !!oldTab.state().classStatusError, 400);
  assert.equal(oldTab.el("classStartNote").textContent, "Este backend todavía no permite iniciar la clase desde aquí: llega con la versión 0.7.21.");
  assert.equal(oldTab.el("classStartNote").classList.contains("is-warning"), true);
  assert.equal(oldTab.el("classStartBtn").disabled, true);
  assert.equal(oldTab.el("classEditorValue").textContent, "Sin datos");
  assert.deepEqual(old.requestsTo("/api/admin/clase/estado").map((request) => request.method), ["GET"]);

  // Docente con Codespaces: el editor no hace falta; la GPU que no encendio se explica; «Actualizar estado» vuelve a consultar.
  const teacher = new FakeBrowser();
  teacher.session = { ...SESSION, user: { ...SESSION.user, id: "u-docente", role: "teacher", displayName: "Docente Prueba", assignedCourseCodes: [] } };
  teacher.provider = "codespaces";
  teacher.workspaceSetting = { ...WORKSPACE_TUNNEL_SETTING, provider: "codespaces", choice: "codespaces" };
  teacher.classStatus = {
    ...CLASS_OFF,
    provider: "codespaces",
    editorsNeeded: false,
    gpus: [{ ...CLASS_GPU_OFF, state: "failed", problem: "instances.start HTTP 403 (ZONE_RESOURCE_POOL_EXHAUSTED)" }],
    gpu: "failed",
  };
  seedLoggedInBrowser(teacher, { adaceenPrivacyAcceptedByUser: { "u-docente": PRIVACY_POLICY_VERSION } });
  const teacherTab = await openTab(teacher, `https://github.com/${REPO}`, REPO);
  await drive(teacher, teacherTab.run("openOverlay({ trigger: 'user' })"));
  await teacher.clock.until(() => teacherTab.state().loading === false, 400);
  await drive(teacher, teacherTab.el("settingsBtn").click(), 400);
  await teacher.clock.until(() => !!teacherTab.state().classStatus, 400);
  assert.equal(teacherTab.el("settingsSectionClass").hidden, false);
  assert.equal(teacherTab.el("classEditorValue").textContent, "No hace falta (Codespaces)");
  assert.equal(teacherTab.el("classModelValue").textContent, "GPU no encendió");
  assert.equal(teacherTab.el("classStartNote").textContent, "GPU que no encendió: adaceen-worker-v100 (instances.start HTTP 403 (ZONE_RESOURCE_POOL_EXHAUSTED)).");
  assert.equal(teacherTab.el("classStartNote").classList.contains("is-warning"), true);
  const consulted = teacher.requestsTo("/api/admin/clase/estado").length;
  await drive(teacher, teacherTab.el("classRefreshBtn").click(), 400);
  assert.equal(teacher.requestsTo("/api/admin/clase/estado").length, consulted + 1);

  // Tope de 15 min: si nada queda listo, el sondeo se detiene con el aviso.
  teacher.classStatus = { ...CLASS_OFF, provider: "codespaces", editorsNeeded: false };
  await drive(teacher, teacherTab.el("classStartBtn").click(), 400);
  assert.equal(teacher.classStarts, 1);
  await advance(teacher, 16 * 60_000);
  assert.match(teacherTab.el("classStartNote").textContent, /^Pasaron 15 min y la clase no quedó lista: ningún servidor del modelo manda latido\./);
  assert.equal(teacherTab.el("classStartNote").classList.contains("is-warning"), true);
  assert.equal(teacherTab.state().classStartPollUntil, 0);
  assert.equal(teacher.classStarts, 1, "el sondeo nunca vuelve a encender");
  const stopped = teacher.requestsTo("/api/admin/clase/estado").length;
  await advance(teacher, 60_000);
  assert.equal(teacher.requestsTo("/api/admin/clase/estado").length, stopped);

  // Estudiante: ni la seccion ni la consulta.
  const student = new FakeBrowser();
  student.classStatus = structuredClone(CLASS_OFF);
  seedLoggedInBrowser(student);
  const studentTab = await openTab(student, TUNNEL_URL, "taller-1");
  await drive(student, studentTab.run("openOverlay({ trigger: 'user' })"));
  await student.clock.until(() => studentTab.state().loading === false, 400);
  await drive(student, studentTab.el("settingsBtn").click(), 400);
  assert.equal(studentTab.el("settingsSectionClass").hidden, true);
  assert.deepEqual(student.requestsTo("/api/admin/clase/estado"), []);
  assertKnownShadowIds(oldTab, teacherTab, studentTab);
});

// ---- La ventana de espera sin material del curso (0.7.21) ----

test("0.7.21: la ventana de espera dice claramente cuando el curso no tiene material RAG (ni base ni del profesor)", async () => {
  const browser = new FakeBrowser();
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, `https://github.com/${REPO}`, `${REPO}: taller`);
  // Lineas RAG de la ventana de espera con el rol y la respuesta de /api/rag/sources dados.
  const ragLines = (role: string, sources: Json[], ragError = "", ragFetchedAt = "2026-10-09T12:00:00.000Z"): string[] => JSON.parse(tab.run(`(() => {
    overlayState.session = { ...(overlayState.session || {}), user: { ...(overlayState.session?.user || {}), role: ${JSON.stringify(role)} } };
    overlayState.teacherRagState = null;
    overlayState.ragSources = [];
    overlayState.codespaceWaitingContext = {
      ragCourseCode: "FPOO",
      ragCourseName: "Fundamentos de programacion orientada a objetos",
      ragSources: ${JSON.stringify(sources)},
      courses: [],
      ragFetchedAt: ${JSON.stringify(ragFetchedAt)},
      ragError: ${JSON.stringify(ragError)},
    };
    return JSON.stringify(getWaitingPageRagLines());
  })()`));
  const base = (title: string) => ({ scope: "default", title, courseCode: "FPOO" });
  const propia = (title: string) => ({ scope: "teacher", title, courseCode: "FPOO" });
  const SIN_MATERIAL = "Este curso aun no tiene material en ADACEEN: el tutor responde sin fuentes del curso";

  // Ni base ni del profesor: ya no promete «el material base disponible».
  const estudiante = ragLines("student", []);
  assert.ok(estudiante.includes("Fuentes disponibles: 0 base, 0 del profesor."));
  assert.ok(estudiante.includes(`${SIN_MATERIAL} hasta que tu docente las cargue.`), estudiante.join("\n"));
  assert.ok(!estudiante.some((line) => /material base/.test(line)));
  // El docente sabe donde cargarlas; el administrador no tiene la pestana «RAG».
  assert.ok(ragLines("teacher", []).includes(`${SIN_MATERIAL}. Cargalas en la pestana «RAG».`));
  assert.ok(ragLines("admin", []).includes(`${SIN_MATERIAL} hasta que el docente las cargue en su pestana «RAG».`));

  // Con material base y sin fuentes propias: cuantas usara.
  assert.ok(ragLines("student", [base("Guia FPOO")]).includes("Aun no hay fuentes del profesor para este curso; ADACEEN usara la fuente base."));
  assert.ok(ragLines("student", [base("Guia FPOO"), base("Talleres")]).includes("Aun no hay fuentes del profesor para este curso; ADACEEN usara las 2 fuentes base."));
  // Con fuentes del profesor, como antes.
  assert.ok(ragLines("student", [base("Guia FPOO"), propia("Taller 3")]).includes("Subido por profesor: Taller 3."));

  // Si la consulta fallo, 0 no quiere decir «sin material»: solo se dice que falta refrescar.
  const conError = ragLines("student", [], "tiempo agotado");
  assert.ok(conError.includes("RAG pendiente de refrescar: tiempo agotado"));
  assert.ok(!conError.some((line) => line.startsWith(SIN_MATERIAL)));
  // Ventana recien abierta (aun sin consultar): ni cifras ni «sin material».
  const sinConsultar = ragLines("teacher", [], "", "");
  assert.ok(sinConsultar.includes("Consultando el material del curso..."), sinConsultar.join("\n"));
  assert.ok(!sinConsultar.some((line) => line.startsWith("Fuentes disponibles") || line.startsWith(SIN_MATERIAL)));
});

// ---- Cargar varias fuentes RAG de una vez (piloto con FPOO-01, 0.7.21) ----

test("0.7.21: el docente carga varias fuentes RAG en una sola seleccion; un resumen dice cuantas entraron y cuales no", async () => {
  const browser = new FakeBrowser();
  browser.session = { ...SESSION, user: { ...SESSION.user, id: "u-docente", role: "teacher", displayName: "Docente Prueba", assignedCourseCodes: [] } };
  browser.ragUploadFailures = ["Guia escaneada.pdf"];
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-docente": PRIVACY_POLICY_VERSION } });
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => tab.state().loading === false, 400);
  await drive(browser, tab.el("tabBtnRag").click());
  await browser.clock.until(() => tab.state().teacherRagLoadedAt > 0, 400);
  const fpoo = Array.from(tab.el("ragCourseGroups").children).find((group: any) => group.dataset.courseCode === "FPOO") as any;
  const fpooBody = fpoo.children[1];
  const uploadBtn = fpooBody.children[0].children[2];
  assert.equal(uploadBtn.textContent, "Cargar fuente");
  await drive(browser, uploadBtn.click());
  assert.equal(tab.state().teacherRagState.selectedCourseCode, "FPOO");
  // El selector admite varios archivos (el DOM falso no lee el markup: se mira la plantilla).
  assert.match(SOURCES.get("overlay/templates/tab-panels.template.js")!, /<input id="teacherRagFileInput" type="file" multiple /);

  const getsBefore = browser.requestsTo("/api/rag/sources", "GET").length;
  const input = tab.el("teacherRagFileInput");
  input.files = [
    new File(["guia 1"], "Pilares de POO y Reglas SOLID.pdf"),
    new File(["escaneo"], "Guia escaneada.pdf"),
    new File(["proyecto"], "Enunciado del Proyecto.pdf"),
  ];
  await drive(browser, input.dispatch("change"), 3000);
  await browser.clock.until(() => !tab.state().teacherRagState.busy, 400);

  // Una peticion por archivo, en orden, todas al curso elegido; la lista se refresca una sola vez.
  assert.deepEqual(browser.ragUploads.map((upload) => upload.fileName), ["Pilares de POO y Reglas SOLID.pdf", "Guia escaneada.pdf", "Enunciado del Proyecto.pdf"]);
  assert.deepEqual([...new Set(browser.ragUploads.map((upload) => upload.courseCode))], ["FPOO"]);
  assert.equal(browser.requestsTo("/api/rag/sources", "POST").length, 3);
  assert.equal(browser.requestsTo("/api/rag/sources", "GET").length - getsBefore, 1, "un solo refresco al final, no uno por archivo");
  const state = tab.state().teacherRagState;
  assert.equal(state.message, "Cargadas 2 de 3 fuentes en FPOO.");
  assert.equal(state.error, "No se cargaron: Guia escaneada.pdf (El archivo no tiene texto legible.)");
  assert.equal(input.value, "", "el selector queda limpio para la siguiente carga");
});
