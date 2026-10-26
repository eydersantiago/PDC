import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import type express from "express";
import { createApp } from "../../src/app.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { clearDownloadVersionsCache, readDownloadVersions, readDownloadVersionsCached } from "../../src/services/download-versions.js";
import { cleanExtensionVersion, compareExtensionVersions } from "../../src/services/extension-version.js";
import {
  clearVscodePresences,
  describeVscodeExtensionForUser,
  describeVscodeExtensionsByEditorHost,
  editorHostFromHeader,
  editorHostFromWorkerId,
  isEditorHost,
  recordVscodePresence,
  readVscodePresence,
  type VscodeExtensionReport,
  type VscodeExtensionsByEditorHost,
} from "../../src/services/vscode-presence.js";
import { workspaceVmStartupCommand } from "../../src/services/workspace-vm-commands.js";
import { CLIENT_VERSION_HEADER, EDITOR_HOST_HEADER } from "../../src/routes/client-headers.js";
import { createVscodePresenceMiddleware, parseVscodeClientHeaders } from "../../src/routes/vscode-presence-routes.js";

/**
 * Guia del tunel (25/10/2026): el aviso del paso 4 en vscode.dev comprueba que la extension
 * ADACEEN de VS Code este en el editor y sea la ultima. El backend lo sabe por las llamadas de
 * VS Code (desde la 0.0.37, x-adaceen-editor-host y x-adaceen-client-version; antes, solo
 * x-adaceen-worker-id), por usuario y por tipo de editor (tunel, VS Code instalado, Codespaces).
 */

type PresenceReply = VscodeExtensionReport & { ok: boolean; error?: string; workspaceVmStartupCommand?: string };

async function startTestServer() {
  clearVscodePresences();
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

async function login(baseUrl: string, email: string, password: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ email, password }),
  });
  const data = await response.json() as { session?: { id?: string }; error?: string };
  assert.equal(response.status, 200, data.error);
  return String(data.session?.id);
}

async function presence(baseUrl: string, sessionId: string, editorHost?: string) {
  const query = editorHost !== undefined ? `?editorHost=${encodeURIComponent(editorHost)}` : "";
  const response = await fetch(`${baseUrl}/api/vscode/presence${query}`, { headers: { "x-session-id": sessionId } });
  return { status: response.status, body: await response.json() as PresenceReply };
}

// VS Code 0.0.36 o anterior: solo el worker id.
function oldVscodeCall(baseUrl: string, sessionId: string, remote: string) {
  return fetch(`${baseUrl}/api/health`, { headers: { "x-session-id": sessionId, "x-adaceen-worker-id": `adaceen-vscode-${remote}` } });
}

// VS Code 0.0.37: el tipo de editor y la version en sus propias cabeceras.
function vscodeCall(baseUrl: string, sessionId: string, editorHost: string, version: string, workerId = `adaceen-vscode-${editorHost}`) {
  return fetch(`${baseUrl}/api/health`, {
    headers: { "x-session-id": sessionId, "x-adaceen-worker-id": workerId, [EDITOR_HOST_HEADER]: editorHost, [CLIENT_VERSION_HEADER]: version },
  });
}

test("la guia sabe si VS Code tiene ADACEEN y si es la ultima version", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    const unauthorized = await fetch(`${baseUrl}/api/vscode/presence`);
    assert.equal(unauthorized.status, 401);

    const sessionId = await login(baseUrl, "estudiante@adaceen.edu.co", "Estudiante123!");
    const latest = readDownloadVersions(process.cwd()).vscode;
    assert.ok(latest, "el repositorio publica una version de VS Code");

    // Sin VS Code visto: camelCase y null donde no hay dato; devuelve el tipo de editor que se pregunto.
    const before = await presence(baseUrl, sessionId, "tunnel");
    assert.equal(before.status, 200);
    assert.deepEqual(before.body, { ok: true, status: "not_seen", editorHost: "tunnel", version: null, latestVersion: latest, lastSeenAt: null, online: false });
    assert.equal(before.body.workspaceVmStartupCommand, undefined, "el estudiante no ve comandos de la VM");

    // VS Code 0.0.36 (sin la cabecera de version) desde el tunel: la publicada ya dice su version,
    // asi que una que no la dice es anterior.
    await oldVscodeCall(baseUrl, sessionId, "tunnel");
    const old = await presence(baseUrl, sessionId, "tunnel");
    assert.deepEqual([old.body.status, old.body.editorHost, old.body.version, old.body.online], ["outdated", "tunnel", null, true]);

    // Una version anterior a la publicada.
    await vscodeCall(baseUrl, sessionId, "tunnel", "0.0.1");
    assert.equal((await presence(baseUrl, sessionId, "tunnel")).body.status, "outdated");

    // La cabecera del editor gana al worker id (ADACEEN_SCAN_WORKER_ID puede cambiarlo).
    await vscodeCall(baseUrl, sessionId, "tunnel", latest, "lab-worker-3");
    const current = await presence(baseUrl, sessionId, "tunnel");
    assert.deepEqual([current.body.status, current.body.version, current.body.latestVersion], ["up_to_date", latest, latest]);
    assert.match(String(current.body.lastSeenAt), /^\d{4}-\d{2}-\d{2}T/);

    // VS Code instalado (la Mac) con otra version no tapa lo que se vio en el tunel.
    await vscodeCall(baseUrl, sessionId, "local", "0.0.1");
    assert.equal((await presence(baseUrl, sessionId, "tunnel")).body.status, "up_to_date", "el tunel sigue al dia");
    const local = await presence(baseUrl, sessionId, "local");
    assert.deepEqual([local.body.status, local.body.editorHost], ["outdated", "local"]);
    assert.equal((await presence(baseUrl, sessionId)).body.editorHost, "local", "sin tipo: el mas reciente");
    assert.equal((await presence(baseUrl, sessionId, "")).body.editorHost, "local", "vacio es lo mismo que sin tipo");
    assert.equal((await presence(baseUrl, sessionId, "codespaces")).body.status, "not_seen");
    // SSH o WSL: «remote», como en la telemetria.
    await vscodeCall(baseUrl, sessionId, "remote", latest);
    assert.equal((await presence(baseUrl, sessionId, "remote")).body.status, "up_to_date");

    // Un tipo de editor que no existe es un error del que llama, no «no visto».
    const wrong = await presence(baseUrl, sessionId, "windows");
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.ok, false);

    // El estado de la sesion (la linea «VS Code» de Inicio) trae todos los editores, en camelCase.
    const stateResponse = await fetch(`${baseUrl}/api/projects/session/state`, { headers: { "x-session-id": sessionId } });
    assert.equal(stateResponse.status, 200);
    const state = (await stateResponse.json() as { state: { vscodeExtension: VscodeExtensionsByEditorHost } }).state;
    assert.equal(state.vscodeExtension.latestVersion, latest);
    assert.equal(state.vscodeExtension.lastSeenEditorHost, "remote");
    assert.equal(state.vscodeExtension.byEditorHost.tunnel?.status, "up_to_date");
    assert.equal(state.vscodeExtension.byEditorHost.local?.status, "outdated");
    assert.equal(state.vscodeExtension.byEditorHost.codespaces, undefined);
    assert.equal(typeof state.vscodeExtension.byEditorHost.tunnel?.lastSeenAt, "string");

    // Una llamada del navegador (sin el editor ni el worker de VS Code) no cuenta como VS Code.
    clearVscodePresences();
    await fetch(`${baseUrl}/api/health`, { headers: { "x-session-id": sessionId, [CLIENT_VERSION_HEADER]: "0.8.4" } });
    assert.equal((await presence(baseUrl, sessionId)).body.status, "not_seen");

    // Con una sesion que no vale no se anota nada y la peticion responde igual.
    const invalid = await vscodeCall(baseUrl, "sesion-que-no-existe", "tunnel", latest);
    assert.equal(invalid.status, 200);
    assert.equal(invalid.headers.get("x-adaceen-session"), "invalid");
    assert.equal((await presence(baseUrl, sessionId, "tunnel")).body.status, "not_seen");

    // Docente: tambien como ponerla al dia en la VM ahora (el navegador no lo trae escrito).
    const teacherSession = await login(baseUrl, "docente@adaceen.edu.co", "Docente123!");
    const teacher = await presence(baseUrl, teacherSession, "tunnel");
    assert.match(String(teacher.body.workspaceVmStartupCommand), /^gcloud compute ssh \S+ --zone=\S+ --tunnel-through-iap --command='sudo google_metadata_script_runner startup'$/);
  } finally {
    await stopTestServer(server, database);
  }
});

test("presencia de VS Code: el editor, la version, la frescura y el olvido", () => {
  clearVscodePresences();
  assert.equal(editorHostFromWorkerId("adaceen-vscode-tunnel"), "tunnel");
  assert.equal(editorHostFromWorkerId("adaceen-vscode-local"), "local");
  assert.equal(editorHostFromWorkerId("adaceen-vscode-codespaces"), "codespaces");
  assert.equal(editorHostFromWorkerId("adaceen-vscode-ssh-remote"), "remote");
  assert.equal(editorHostFromWorkerId("adaceen-browser"), null);
  assert.equal(editorHostFromHeader("tunnel"), "tunnel");
  assert.equal(editorHostFromHeader(" Codespaces "), "codespaces");
  assert.equal(editorHostFromHeader("remote"), "remote");
  assert.equal(editorHostFromHeader(""), null);
  assert.equal(isEditorHost("tunnel"), true);
  assert.equal(isEditorHost("other"), false);
  const t0 = Date.parse("2026-10-25T20:00:00Z");
  recordVscodePresence("u1", { editorHost: "tunnel", version: "0.0.37" }, t0);
  recordVscodePresence("", { editorHost: "tunnel", version: "0.0.37" }, t0);
  recordVscodePresence("u2", { editorHost: "windows" as never, version: "0.0.37" }, t0);
  assert.equal(readVscodePresence("u2", undefined, t0), null, "solo tipos de editor conocidos");
  assert.deepEqual(describeVscodeExtensionForUser("u1", "0.0.37", { editorHost: "tunnel", now: t0 + 60_000 }), {
    status: "up_to_date", latestVersion: "0.0.37", version: "0.0.37", editorHost: "tunnel", lastSeenAt: "2026-10-25T20:00:00.000Z", online: true,
  });
  const later = describeVscodeExtensionForUser("u1", "0.0.38", { editorHost: "tunnel", now: t0 + 120_000 });
  assert.equal(later.status, "outdated");
  assert.equal(later.online, false, "sin llamadas en 2 min: VS Code cerrado");
  // Sin version publicada no se compara nada: no se dice «al dia».
  const unknownLatest = describeVscodeExtensionForUser("u1", null, { editorHost: "tunnel", now: t0 });
  assert.deepEqual([unknownLatest.status, unknownLatest.latestVersion], ["latest_version_unknown", null]);
  assert.equal(describeVscodeExtensionForUser("nadie", "0.0.37", { editorHost: "codespaces" }).editorHost, "codespaces");
  assert.equal(describeVscodeExtensionForUser("nadie", "0.0.37").editorHost, null);
  assert.equal(readVscodePresence("u1", "local", t0), null, "otro tipo de editor");
  // Sin version (0.0.36 o anterior): anterior si la publicada ya dice la suya; si no, no se sabe.
  recordVscodePresence("u1", { editorHost: "tunnel", version: "no-es-version" }, t0);
  assert.equal(describeVscodeExtensionForUser("u1", "0.0.37", { editorHost: "tunnel", now: t0 }).status, "outdated");
  assert.equal(describeVscodeExtensionForUser("u1", "0.0.36", { editorHost: "tunnel", now: t0 }).status, "version_not_reported");
  assert.equal(describeVscodeExtensionForUser("u1", null, { editorHost: "tunnel", now: t0 }).status, "version_not_reported");
  // Por editor: el mas reciente sin tipo, cada uno con tipo.
  recordVscodePresence("u1", { editorHost: "local", version: "0.0.36" }, t0 + 1_000);
  assert.equal(readVscodePresence("u1", undefined, t0 + 2_000)?.editorHost, "local");
  const byEditorHost = describeVscodeExtensionsByEditorHost("u1", "0.0.37", t0 + 2_000);
  assert.deepEqual(Object.keys(byEditorHost.byEditorHost).sort(), ["local", "tunnel"]);
  assert.equal(byEditorHost.lastSeenEditorHost, "local");
  assert.equal(byEditorHost.byEditorHost.local?.status, "outdated");
  assert.equal(readVscodePresence("u1", undefined, t0 + 7 * 60 * 60_000), null, "se olvida a las 6 h");
  assert.deepEqual(describeVscodeExtensionsByEditorHost("u1", "0.0.37", t0 + 7 * 60 * 60_000), { latestVersion: "0.0.37", lastSeenEditorHost: null, byEditorHost: {} });
});

function fakeRequest(headers: Record<string, string>) {
  const res = { locals: {}, headersSent: false, setHeader() {}, removeHeader() {} };
  return {
    header: (name: string) => headers[name.toLowerCase()],
    body: {},
    res,
  } as unknown as express.Request;
}

test("las cabeceras de VS Code y un middleware que nunca frena la peticion", async () => {
  assert.deepEqual(parseVscodeClientHeaders(fakeRequest({ [EDITOR_HOST_HEADER]: "tunnel", [CLIENT_VERSION_HEADER]: " 0.0.37 " })), { editorHost: "tunnel", version: "0.0.37" });
  assert.deepEqual(parseVscodeClientHeaders(fakeRequest({ "x-adaceen-worker-id": "adaceen-vscode-codespaces" })), { editorHost: "codespaces", version: null });
  assert.equal(parseVscodeClientHeaders(fakeRequest({ [CLIENT_VERSION_HEADER]: "0.8.4" })), null, "solo la version no dice que sea VS Code");

  // La base de datos cae a mitad de la consulta: la peticion sigue.
  const failing = { getSession: async () => { throw new Error("base de datos caida"); } } as unknown as AppDatabase;
  const middleware = createVscodePresenceMiddleware(failing);
  await new Promise<void>((resolve) => {
    middleware(fakeRequest({ "x-session-id": "s1", [EDITOR_HOST_HEADER]: "tunnel" }), {} as express.Response, () => resolve());
  });
});

test("el comando de la VM sale de la configuracion del backend", () => {
  assert.equal(
    workspaceVmStartupCommand({ name: "aula-ws", zone: "southamerica-east1-b" }),
    "gcloud compute ssh aula-ws --zone=southamerica-east1-b --tunnel-through-iap --command='sudo google_metadata_script_runner startup'",
  );
  // Vacio o algo que no es un nombre de GCP: los del piloto (no se arma un comando con eso).
  assert.match(workspaceVmStartupCommand({ name: "x; rm -rf /", zone: "" }), /^gcloud compute ssh adaceen-ws --zone=us-central1-a /);
});

test("la version publicada se lee del disco a lo sumo una vez por minuto, y no se puede cambiar", () => {
  clearDownloadVersionsCache();
  const t0 = Date.parse("2026-10-25T20:00:00Z");
  const first = readDownloadVersionsCached(process.cwd(), t0);
  assert.deepEqual(first, readDownloadVersions(process.cwd()));
  assert.equal(Object.isFrozen(first), true);
  assert.equal(readDownloadVersionsCached(process.cwd(), t0 + 30_000), first, "dentro del minuto: el mismo objeto");
  assert.notEqual(readDownloadVersionsCached(process.cwd(), t0 + 61_000), first, "pasado el minuto se vuelve a leer");
  clearDownloadVersionsCache();
  assert.equal(cleanExtensionVersion(" 0.0.37 "), "0.0.37");
  assert.equal(cleanExtensionVersion("v0.0.37"), "");
  assert.ok(compareExtensionVersions("0.0.36", "0.0.37") < 0);
  assert.equal(compareExtensionVersions("1.2", "1.2.0"), 0);
});
