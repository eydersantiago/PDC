import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { shiftBitacoraAgendaToStart } from "../../../src/services/bitacora/bitacora-dates.js";
import { extractDocumentText } from "../../../src/services/documents/document-text-extraction.js";
import { extractBitacoraAgenda } from "../../../src/services/documents/bitacora-agenda.js";
import { REPO, TUNNEL_URL, CAMPUS_COURSE_URL, SESSION, type Json } from "./harness-config.js";
import { FakeElement } from "./harness-dom.js";
import { TabEnv } from "./harness-tab.js";
import type { FakeBrowser } from "./harness-backend.js";
import { drive, openTab, seedLoggedInBrowser } from "./harness-utils.js";

export const EDITOR_KEY = `${SESSION.user.id}:${REPO}`;
export const DAY_MS = 24 * 60 * 60 * 1000;

export function savedEditorRecord(browser: FakeBrowser, extra: Json = {}) {
  return {
    repoFullName: REPO,
    webUrl: TUNNEL_URL,
    provider: "tunnel",
    savedAt: new Date(browser.clock.now - DAY_MS).toISOString(),
    // Ayer un prepare escribio la sesion de VS Code en la VM.
    sessionWrittenAt: new Date(browser.clock.now - DAY_MS).toISOString(),
    ...extra,
  };
}

export function activeTabReports(browser: FakeBrowser) {
  return browser.requestsTo("/api/ui/active-tab", "POST").filter((request) => request.body?.isActive === true);
}

export function workspaceRequestsSince(browser: FakeBrowser, index: number) {
  return browser.requests.slice(index)
    .filter((request) => request.path.startsWith("/api/workspaces/") && request.path !== "/api/workspaces/provider")
    .map((request) => `${request.method} ${request.path}`);
}

// Codespaces con el modelo de boton unico del tunel (auditoria, item 2): la GitHub App se
// detecta sola tras abrir la instalacion (contrato (d)) y el PR y el Codespace se siguen creando.
export async function openCodespacesTour(browser: FakeBrowser) {
  const tab = await openTab(browser, `https://github.com/${REPO}`, REPO);
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false && tab.state().workspaceProvider === "codespaces", 400);
  return tab;
}

export async function loginFromOverlay(browser: FakeBrowser, tab: TabEnv) {
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 50);
  assert.equal(tab.el("authView").hidden, false, "sin sesion el icono muestra el login");
  tab.el("authEmail").value = SESSION.user.email;
  tab.el("authPassword").value = "clave-del-piloto";
  await drive(browser, tab.el("authSubmitBtn").click(), 2000);
  await browser.clock.until(() => tab.state().loading === false && tab.state().authBusy === false, 400);
}

export async function openCampusCourse(browser: FakeBrowser) {
  const tab = await openTab(browser, CAMPUS_COURSE_URL, "FPOO: Curso");
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => !tab.run("savedEditorAutoEnterInFlight"), 400);
  await browser.clock.until(() => tab.state().loading === false && !tab.run("isCampusAccessVerificationInFlight()"), 400);
  return tab;
}

// La bitacora real de FPOO 2025 (PDF) leida y corrida con el mismo codigo del backend.
export async function fpooBitacoraLatest(startDate = "2026-08-25") {
  const buffer = fs.readFileSync(path.resolve(process.cwd(), "tests/fixtures/bitacora-fpoo-2025.pdf"));
  const extracted = await extractDocumentText({ fileName: "Bitacora FPOO - Hoja 1.pdf", filePath: "Bitacora FPOO - Hoja 1.pdf", mimeType: "application/pdf", extension: "pdf", buffer });
  const agenda = extractBitacoraAgenda(extracted.text);
  const bitacoraAgenda = startDate ? shiftBitacoraAgendaToStart(agenda, startDate)!.agenda : agenda;
  return { id: "bitacora-fpoo", fileName: "Bitacora FPOO - Hoja 1.pdf", filePath: "Bitacora FPOO - Hoja 1.pdf", label: "BITACORA", confidence: 0.94, evidence: [], bitacoraAgenda, classifiedAt: "2026-08-20T12:00:00.000Z", updatedAt: "2026-08-20T12:00:00.000Z" } as Json;
}

// Domingo 27 de septiembre de 2026, 10:00 en Bogota: semana 5 (22 a 28 de septiembre).
export const DOMINGO_SEMANA_5 = Date.parse("2026-09-27T15:00:00.000Z");

export async function openStudentAgenda(browser: FakeBrowser) {
  seedLoggedInBrowser(browser);
  const tab = await openTab(browser, TUNNEL_URL, "taller-1");
  await drive(browser, tab.run("openOverlay({ trigger: 'user' })"));
  await browser.clock.until(() => tab.state().loading === false && tab.state().teacherBitacoraStatus.checkedAt > 0, 400);
  return tab;
}

export const ADMIN_SESSION = {
  ...SESSION,
  user: { ...SESSION.user, id: "u-admin", role: "admin", email: "admin@correounivalle.edu.co", displayName: "Admin Prueba", assignedCourseCodes: [] },
};

// El boton: en la cabecera de GitHub un <li> con un <span> que tiene la shadow root (un <li> no
// la admite); flotando, un <div> que la tiene. El DOM falso no tiene la cabecera: flota.
export function repoButton(tab: TabEnv) {
  const host = tab.document.getElementById("adaceen-repo-editor-button");
  const shadow = host?.shadow || host?.children[0]?.shadow;
  return shadow
    ? { host, button: shadow.getElementById("adaceenRepoEditorBtn"), label: shadow.getElementById("adaceenRepoEditorLabel") }
    : null;
}

export const signInHintOf = (t: TabEnv) => t.document.getElementById("adaceen-tunnel-signin-hint");

export async function openGithubAs(browser: FakeBrowser, url: string, signedIn: string, forms: unknown[] = []) {
  const tab = new TabEnv(browser, url, "GitHub");
  if (signedIn) {
    const meta = new FakeElement("meta", tab);
    meta.setAttribute("content", signedIn);
    tab.document.selectors.set('meta[name="user-login"]', meta);
  }
  if (forms.length) {
    tab.document.querySelectorAll = ((selector: string) => (selector === "form" ? forms : [])) as any;
    Object.assign(tab.context, { Event: class { constructor(readonly type: string, readonly init?: Json) {} } });
  }
  tab.load();
  await browser.clock.settle();
  return tab;
}

export function seedTunnelEditor(browser: FakeBrowser) {
  const iso = new Date(browser.clock.now - 60_000).toISOString();
  browser.storage.adaceenEditorByUser = {
    [EDITOR_KEY]: { repoFullName: REPO, webUrl: TUNNEL_URL, provider: "tunnel", savedAt: iso, needsSessionRefresh: false, sessionWrittenAt: iso, openedAt: iso },
  };
}
