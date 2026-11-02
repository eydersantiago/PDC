import assert from "node:assert/strict";
import test from "node:test";
import { PRIVACY_POLICY_VERSION } from "../../../src/routes/pages/privacy-policy-routes.js";
import { REPO, TUNNEL_URL, SESSION } from "./harness-config.js";
import { FakeBrowser } from "./harness-backend.js";
import { drive, openTab, assertKnownShadowIds, seedLoggedInBrowser } from "./harness-utils.js";
import { ADMIN_SESSION } from "./harness-helpers.js";

// ---- Entorno de los estudiantes desde la tuerca del administrador (navegador 0.7.19) ----
test("0.7.19: el administrador elige en la tuerca si los estudiantes usan el editor en la nube o Codespaces", async () => {
  const browser = new FakeBrowser();
  browser.session = ADMIN_SESSION;
  browser.provider = "codespaces";
  browser.workspaceSetting = {
    provider: "codespaces",
    source: "server",
    serverProvider: "codespaces",
    choice: null,
    updatedAt: null,
    updatedBy: null,
    agentConfigured: true,
    agentOnline: false,
    transport: "relay",
    vmAutostart: false,
  };
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-admin": PRIVACY_POLICY_VERSION } });
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => tab.state().loading === false, 400);
  assert.deepEqual(browser.requestsTo("/api/admin/workspace-provider"), [], "no se consulta hasta abrir la tuerca");

  // La tuerca del administrador abre la seccion con lo que dice el backend.
  await drive(browser, tab.el("settingsBtn").click(), 400);
  await browser.clock.until(() => !!tab.state().workspaceProviderSetting, 400);
  const section = tab.el("settingsSectionWorkspace");
  assert.equal(section.hidden, false);
  assert.equal(section.open, true, "el administrador empieza por el entorno de los estudiantes");
  const select = tab.el("workspaceProviderSelect");
  assert.equal(select.value, "server");
  assert.equal(select.disabled, false);
  assert.equal(tab.el("workspaceProviderServerOption").textContent, "Lo que diga el servidor (GitHub Codespaces)");
  assert.equal(tab.el("workspaceProviderActiveValue").textContent, "GitHub Codespaces · del servidor");
  assert.equal(tab.el("workspaceAgentValue").textContent, "Apagada");
  assert.equal(tab.el("workspaceProviderServerValue").textContent, "ADACEEN_WORKSPACE_PROVIDER = codespaces");
  assert.equal(tab.el("workspaceProviderUpdatedValue").textContent, "Nunca: manda el servidor");
  assert.equal(tab.el("workspaceProviderNote").textContent, "Se aplica con «Guardar cambios». Los estudiantes lo ven al recargar la página o en unos minutos.");
  assert.equal(tab.el("workspaceProviderTunnelOption").disabled, false);

  // Un render no pisa lo elegido y sin guardar.
  select.value = "tunnel";
  await drive(browser, tab.run("Promise.resolve(renderOverlay())"));
  assert.equal(select.value, "tunnel");

  // «Guardar cambios»: PUT, el proveedor de este overlay cambia ya y la linea de estado lo dice.
  const providerChecks = browser.requestsTo("/api/workspaces/provider").length;
  await drive(browser, tab.el("saveSettingsBtn").click(), 2000);
  assert.deepEqual(browser.workspaceSettingPuts, [{ provider: "tunnel" }]);
  assert.equal(tab.state().workspaceProvider, "tunnel");
  assert.ok(browser.requestsTo("/api/workspaces/provider").length > providerChecks, "vuelve a consultar el proveedor sin esperar 5 min");
  assert.equal(
    tab.el("statusText").textContent,
    "Entorno de los estudiantes: editor en la nube (túnel de VS Code). Lo verán al recargar la página o en unos minutos. La VM de editores está apagada: enciéndela antes de la clase con bash deploy/clase.sh iniciar.",
  );

  // Al volver a abrir: lo guardado, quien y cuando, y el aviso de la VM apagada.
  await drive(browser, tab.el("settingsBtn").click(), 400);
  await browser.clock.until(() => tab.state().workspaceProviderSettingBusy === false, 400);
  assert.equal(select.value, "tunnel");
  assert.equal(tab.el("workspaceProviderActiveValue").textContent, "Editor en la nube (túnel) · elegido aquí");
  assert.match(tab.el("workspaceProviderUpdatedValue").textContent, / · Admin Prueba$/);
  assert.equal(tab.el("workspaceProviderNote").textContent, "La VM de editores está apagada: enciéndela antes de la clase con bash deploy/clase.sh iniciar.");
  assert.equal(tab.el("workspaceProviderNote").classList.contains("is-warning"), true);
  assert.equal(tab.el("settingsSectionWorkspaceHint").textContent, "Ahora: Editor en la nube (túnel)");

  // Sin cambiar el selector, «Guardar cambios» no vuelve a mandar el entorno.
  await drive(browser, tab.el("saveSettingsBtn").click(), 2000);
  assert.equal(browser.workspaceSettingPuts.length, 1);

  // Volver a lo que diga el servidor.
  await drive(browser, tab.el("settingsBtn").click(), 400);
  await browser.clock.until(() => tab.state().workspaceProviderSettingBusy === false, 400);
  select.value = "server";
  await drive(browser, tab.el("saveSettingsBtn").click(), 2000);
  assert.deepEqual(browser.workspaceSettingPuts.at(-1), { provider: "server" });
  assert.equal(tab.state().workspaceProvider, "codespaces");
  assertKnownShadowIds(tab);
});

test("0.7.19: sin el agente de la VM el tunel no se puede elegir; un backend anterior lo dice; el docente tambien elige; el estudiante no ve la seccion", async () => {
  const browser = new FakeBrowser();
  browser.session = ADMIN_SESSION;
  browser.provider = "codespaces";
  browser.workspaceSetting = {
    provider: "codespaces",
    source: "server",
    serverProvider: "codespaces",
    choice: null,
    updatedAt: null,
    updatedBy: null,
    agentConfigured: false,
    agentOnline: false,
    transport: "relay",
    vmAutostart: false,
  };
  seedLoggedInBrowser(browser, { adaceenPrivacyAcceptedByUser: { "u-admin": PRIVACY_POLICY_VERSION } });
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => tab.state().loading === false, 400);
  await drive(browser, tab.el("settingsBtn").click(), 400);
  await browser.clock.until(() => !!tab.state().workspaceProviderSetting, 400);
  assert.equal(tab.el("workspaceProviderTunnelOption").disabled, true);
  assert.equal(tab.el("workspaceAgentValue").textContent, "Sin configurar");
  assert.equal(
    tab.el("workspaceProviderNote").textContent,
    "Para elegir el editor en la nube falta conectar la VM de editores una vez: bash deploy/produccion.sh aplicar en Cloud Shell.",
  );
  // Si aun asi llega el pedido (otra pestaña, otra version), el backend responde 409 y el selector vuelve.
  const select = tab.el("workspaceProviderSelect");
  select.value = "tunnel";
  await drive(browser, tab.el("saveSettingsBtn").click(), 2000);
  assert.equal(browser.workspaceSettingPuts.length, 1);
  assert.equal(select.value, "server");
  assert.equal(tab.state().workspaceProvider, "codespaces");
  assert.match(tab.el("statusText").textContent, /^No se pudo cambiar el entorno de los estudiantes: Para usar el editor en la nube falta conectar la VM de editores/);

  // Backend anterior a 0.7.19: la seccion lo dice y no se puede elegir.
  const old = new FakeBrowser();
  old.session = ADMIN_SESSION;
  old.provider = "codespaces";
  seedLoggedInBrowser(old, { adaceenPrivacyAcceptedByUser: { "u-admin": PRIVACY_POLICY_VERSION } });
  const oldTab = await openTab(old, `https://github.com/${REPO}`, REPO);
  await drive(old, oldTab.run("openOverlay({ trigger: 'user' })"));
  await old.clock.until(() => oldTab.state().loading === false, 400);
  await drive(old, oldTab.el("settingsBtn").click(), 400);
  await old.clock.until(() => !!oldTab.state().workspaceProviderSettingError, 400);
  assert.equal(oldTab.el("workspaceProviderNote").textContent, "Este backend todavía no permite elegir el entorno desde aquí: llega con la versión 0.7.19.");
  assert.equal(oldTab.el("workspaceProviderSelect").disabled, true);
  await drive(old, oldTab.el("saveSettingsBtn").click(), 2000);
  assert.deepEqual(old.requestsTo("/api/admin/workspace-provider").map((request) => request.method), ["GET"], "sin datos del backend no se manda nada");

  // Docente: ve la seccion (la tuerca empieza por su politica) y la puede cambiar.
  const teacher = new FakeBrowser();
  teacher.session = { ...SESSION, user: { ...SESSION.user, id: "u-docente", role: "teacher", displayName: "Docente Prueba", assignedCourseCodes: [] } };
  teacher.provider = "codespaces";
  teacher.workspaceSetting = { ...browser.workspaceSetting, agentConfigured: true, agentOnline: true };
  seedLoggedInBrowser(teacher, { adaceenPrivacyAcceptedByUser: { "u-docente": PRIVACY_POLICY_VERSION } });
  const teacherTab = await openTab(teacher, `https://github.com/${REPO}`, REPO);
  await drive(teacher, teacherTab.run("openOverlay({ trigger: 'user' })"));
  await teacher.clock.until(() => teacherTab.state().loading === false, 400);
  await drive(teacher, teacherTab.el("settingsBtn").click(), 400);
  await teacher.clock.until(() => !!teacherTab.state().workspaceProviderSetting, 400);
  assert.equal(teacherTab.el("settingsSectionWorkspace").hidden, false);
  assert.equal(teacherTab.el("settingsSectionWorkspace").open, false, "el docente empieza por su politica");
  assert.equal(teacherTab.el("settingsSectionPolicy").open, true);
  assert.equal(teacherTab.el("workspaceAgentValue").textContent, "Conectada");
  teacherTab.el("workspaceProviderSelect").value = "tunnel";
  await drive(teacher, teacherTab.el("saveSettingsBtn").click(), 2000);
  assert.deepEqual(teacher.workspaceSettingPuts, [{ provider: "tunnel" }]);
  assert.equal(teacherTab.state().workspaceProvider, "tunnel");

  // Estudiante: ni la seccion ni la consulta.
  const student = new FakeBrowser();
  seedLoggedInBrowser(student);
  const studentTab = await openTab(student, TUNNEL_URL, "taller-1");
  await drive(student, studentTab.run("openOverlay({ trigger: 'user' })"));
  await student.clock.until(() => studentTab.state().loading === false, 400);
  await drive(student, studentTab.el("settingsBtn").click(), 400);
  assert.equal(studentTab.el("settingsSectionWorkspace").hidden, true);
  assert.deepEqual(student.requestsTo("/api/admin/workspace-provider"), []);
  assertKnownShadowIds(tab, oldTab, teacherTab, studentTab);
});
