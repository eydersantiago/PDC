import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { createApp } from "../../src/app.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import {
  browserExtensionTarget,
  clientBrowserExtensionVersion,
  createExtensionUpdateNotifier,
  LEGACY_BROWSER_EXTENSION_VERSION,
  UPDATE_NOTICE_INTERVAL_MS,
  withUpdateNotice,
} from "../../src/services/extension-update-notice.js";

/**
 * Aviso de version nueva de la extension del navegador (29-10-2026): la 0.8.5 no tiene como
 * enterarse de la 0.8.6; el backend se lo dice al final del saludo del tutor.
 */

type Json = Record<string, any>;

async function startServer(target: () => Promise<string>) {
  const database = await createDatabase();
  const app = createApp(database, { extensionUpdate: createExtensionUpdateNotifier({ enabled: () => true, target }) });
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("sin puerto");
  return { database, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server, database: AppDatabase) {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await database.close();
}

async function intervene(baseUrl: string, sessionId: string, headers: Record<string, string> = {}, repo = "curso/taller") {
  const response = await fetch(`${baseUrl}/intervene`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", "x-session-id": sessionId, ...headers },
    body: JSON.stringify({
      question: "Ayudame con este ejercicio de clases",
      context: { pageType: "github_general", pageContext: "github", url: `https://github.com/${repo}`, repoFullName: repo },
    }),
  });
  return { status: response.status, data: await response.json() as Json };
}

test("aviso de version: a quien llega sin cabecera (0.8.5 o anterior) le dice que hay otra y como actualizar, una vez cada 30 min", async () => {
  let storeVersion = "0.8.5";
  const { server, database, baseUrl } = await startServer(async () => storeVersion);
  try {
    const session = await database.authenticateUser("estudiante@adaceen.edu.co", "Estudiante123!");
    assert.ok(session);
    // Mientras la tienda tenga la 0.8.5 (Google revisando la 0.8.6), no se invita a nada.
    const before = await intervene(baseUrl, session.id);
    assert.equal(before.status, 200);
    assert.equal(before.data.extension_update, undefined);
    assert.doesNotMatch(String(before.data.result.welcome_message), /versión nueva/);

    storeVersion = "0.8.6";
    const legacy = await intervene(baseUrl, session.id, {}, "curso/otro");
    const welcome = String(legacy.data.result.welcome_message);
    assert.match(welcome, /En esta página de GitHub no hay código/, "el saludo del tutor sigue primero");
    assert.match(welcome, /Hay una versión nueva de ADACEEN \(0\.8\.6\)/);
    assert.match(welcome, /chrome:\/\/extensions/);
    assert.ok(welcome.includes(`${baseUrl}/empezar`), "el enlace para el zip es el de este backend");
    assert.ok(legacy.data.extension_update?.notice);

    // La misma persona no lo vuelve a ver en 30 min, ni en la respuesta repetida.
    const again = await intervene(baseUrl, session.id, {}, "curso/tercero");
    assert.doesNotMatch(String(again.data.result.welcome_message), /versión nueva/);

    // Con la 0.8.6 (que manda su version) no hay aviso.
    const other = await database.authenticateUser("docente@adaceen.edu.co", "Docente123!");
    assert.ok(other);
    const current = await intervene(baseUrl, other.id, { "x-adaceen-client-version": "0.8.6" });
    assert.doesNotMatch(String(current.data.result.welcome_message), /versión nueva/);
    assert.equal(current.data.extension_update, undefined);
  } finally {
    await stopServer(server, database);
  }
});

test("aviso de version: reglas puras (a que version se invita, version del cliente, sin tocar la respuesta original)", async () => {
  assert.equal(browserExtensionTarget({ storeUrl: "https://chromewebstore.google.com/detail/x", storeVersion: "0.8.6", zipVersion: "0.8.7" }), "0.8.6",
    "con tienda, la de la tienda (la que Chrome instala)");
  assert.equal(browserExtensionTarget({ storeUrl: "https://chromewebstore.google.com/detail/x", storeVersion: "", zipVersion: "0.8.7" }), "",
    "si la tienda no responde, no se invita");
  assert.equal(browserExtensionTarget({ storeUrl: "", storeVersion: "", zipVersion: "0.8.7" }), "0.8.7", "sin tienda, el zip");
  assert.equal(clientBrowserExtensionVersion(undefined), LEGACY_BROWSER_EXTENSION_VERSION);
  assert.equal(clientBrowserExtensionVersion("no-es-version"), LEGACY_BROWSER_EXTENSION_VERSION);
  assert.equal(clientBrowserExtensionVersion("0.8.7"), "0.8.7");

  const reply = { ok: true, result: { welcome_message: "Hola.", ideas: ["a"] } };
  const withNotice = withUpdateNotice(reply, "Hay una versión nueva.");
  assert.equal(reply.result.welcome_message, "Hola.", "la respuesta en cache no cambia");
  assert.equal((withNotice.result as Json).welcome_message, "Hola. Hay una versión nueva.");
  assert.equal(withUpdateNotice(reply, ""), reply);

  let now = 1_000_000;
  const notifier = createExtensionUpdateNotifier({ enabled: () => true, target: async () => "0.8.6" });
  const ask = (actorKey: string, header?: string) => notifier.noticeFor({ actorKey, clientVersionHeader: header, startPageUrl: "https://x/empezar", now });
  assert.match(await ask("user:a"), /0\.8\.6/);
  assert.equal(await ask("user:a"), "");
  now += UPDATE_NOTICE_INTERVAL_MS;
  assert.match(await ask("user:a"), /0\.8\.6/, "pasados 30 min se repite");
  assert.equal(await ask("user:b", "0.8.6"), "");
  assert.equal(await ask("user:c", "0.8.7"), "", "una version mas nueva que la tienda no se avisa");
  assert.equal(await createExtensionUpdateNotifier({ enabled: () => false, target: async () => "0.8.6" })
    .noticeFor({ actorKey: "user:a", clientVersionHeader: undefined, startPageUrl: "" }), "", "EXTENSION_UPDATE_NOTICE=off");
  // Por defecto, dentro de las pruebas queda apagado (no consulta la tienda).
  assert.equal(await createExtensionUpdateNotifier({ target: async () => assert.fail("no debe consultar") })
    .noticeFor({ actorKey: "user:a", clientVersionHeader: undefined, startPageUrl: "" }), "");
});
