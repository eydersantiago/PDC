import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import type { Server } from "node:http";
import { createApp } from "../../src/app.js";
import { env } from "../../src/config/env.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";

/**
 * Pagina de retorno de la GitHub App (auditoria de redundancias, punto 2):
 * dice que se puede cerrar la pestana y que ADACEEN lo detecta solo. La
 * extension lo detecta consultando /api/github-app/status, que desde el
 * retorno ya trae la instalacion. La pestana de la instalacion se abre sin
 * opener, asi que la pagina no manda postMessage.
 */

async function startTestServer() {
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

async function loginStudent(baseUrl: string) {
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "estudiante@adaceen.edu.co", password: "Estudiante123!" }),
  });
  return String((await loginResponse.json() as { session: { id: string } }).session.id);
}

type AppStatus = { ok: boolean; status: { installation: { installationId: string } | null } };

test("GitHub App: el retorno dice que se puede cerrar la pestana y status ya ve la instalacion", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    const sessionId = await loginStudent(baseUrl);
    const status = async () => {
      const response = await fetch(`${baseUrl}/api/github-app/status`, { headers: { "x-session-id": sessionId } });
      return await response.json() as AppStatus;
    };

    // Antes de instalar: la consulta periodica de la extension no ve instalacion.
    assert.equal((await status()).status.installation, null);

    await database.createGithubInstallState({
      userId: "user-student-demo",
      sessionId,
      repoFullName: "curso/tarea-1",
      state: "estado-retorno-app",
    });
    // GitHub vuelve a esta URL en la pestana de la instalacion (sin la sesion de ADACEEN).
    const callback = await fetch(`${baseUrl}/api/github-app/callback?state=estado-retorno-app&installation_id=424242&setup_action=install`);
    assert.equal(callback.status, 200);
    const html = await callback.text();

    // Pagina en espanol, con titulo y legible en el movil.
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<html lang="es">/);
    assert.match(html, /<meta charset="utf-8">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(html, /<title>ADACEEN<\/title>/);

    // Lo primero que se lee es la instruccion; los datos tecnicos van plegados al final.
    const body = html.slice(html.indexOf("<body"));
    const firstAfterHeading = body.slice(body.indexOf("</h2>") + 5).trim();
    assert.ok(firstAfterHeading.startsWith("<h3>Ya puedes cerrar esta pestana.</h3>"), firstAfterHeading.slice(0, 80));
    assert.match(html, /GitHub App conectada correctamente\. ADACEEN detecta la instalacion solo y sigue en la pestana donde lo estabas usando: no hace falta pulsar nada mas\./);
    // Respaldo que sirve con cualquier version de la extension: al recargar vuelve a leer el estado.
    assert.match(html, /Si esa pestana no avanza en un minuto, recargala\./);
    assert.match(html, /<details>\s*<summary>Detalles tecnicos<\/summary>\s*<p>Accion: install<\/p>\s*<p>Installation ID: 424242<\/p>\s*<\/details>/);
    assert.ok(body.indexOf("Ya puedes cerrar") < body.indexOf("Installation ID"), "la instruccion va antes que el ID");
    assert.doesNotMatch(html, /volver a la extension/, "ya no pide volver a mano");
    assert.doesNotMatch(html, /Verificar acceso/);
    // Sin postMessage: la extension abre la instalacion sin opener y no lo escucha.
    assert.doesNotMatch(html, /<script/);
    assert.doesNotMatch(html, /postMessage|ADACEEN_GITHUB_APP_INSTALLED/);

    // La siguiente consulta de la extension ya ve la instalacion: puede avanzar sola.
    const after = await status();
    assert.equal(after.ok, true);
    assert.equal(after.status.installation?.installationId, "424242");

    // El enlace es de un solo uso: repetirlo no vuelve a instalar.
    const reused = await fetch(`${baseUrl}/api/github-app/callback?state=estado-retorno-app&installation_id=424242`);
    assert.equal(reused.status, 400);
    assert.match(await reused.text(), /expiro o ya fue usado/);
  } finally {
    await stopTestServer(server, database);
  }
});

test("GitHub App: un installation_id que no es numero se rechaza sin gastar el enlace ni repetirlo en la pagina", async () => {
  const { server, database, baseUrl } = await startTestServer();
  try {
    const sessionId = await loginStudent(baseUrl);
    await database.createGithubInstallState({ userId: "user-student-demo", sessionId, repoFullName: "curso/tarea-1", state: "estado-escape" });

    for (const hostile of ["</script><script>alert(1)</script><b>1</b>", "77 7", "7e3", "-1", "1".repeat(21)]) {
      const response = await fetch(`${baseUrl}/api/github-app/callback?state=estado-escape&installation_id=${encodeURIComponent(hostile)}&setup_action=update`);
      assert.equal(response.status, 400, `rechaza ${JSON.stringify(hostile)}`);
      const html = await response.text();
      assert.match(html, /El installation_id del callback no es valido\./);
      assert.doesNotMatch(html, /<b>1<\/b>|alert\(1\)/, "no repite lo que vino en la URL");
      assert.doesNotMatch(html, /<script/);
    }
    const noInstallation = await fetch(`${baseUrl}/api/github-app/status`, { headers: { "x-session-id": sessionId } });
    assert.equal((await noInstallation.json() as AppStatus).status.installation, null, "no se vinculo nada");

    // El enlace sigue sirviendo con el installation_id de verdad.
    const valid = await fetch(`${baseUrl}/api/github-app/callback?state=estado-escape&installation_id=12345678901234567890&setup_action=update`);
    assert.equal(valid.status, 200);
    assert.match(await valid.text(), /Installation ID: 12345678901234567890/);
  } finally {
    await stopTestServer(server, database);
  }
});

test("OAuth de GitHub: el aviso a la extension escapa lo que vino del cliente dentro del script", async () => {
  const GITHUB_API = "https://api.github.prueba";
  const envKeys = ["githubOAuthClientId", "githubOAuthClientSecret", "githubOAuthCallbackUrl", "githubApiBaseUrl"] as const;
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, env[key]]));
  const realFetch = globalThis.fetch;
  Object.assign(env, {
    githubOAuthClientId: "Ov23liPruebaCallback",
    githubOAuthClientSecret: "secreto-oauth-de-prueba",
    githubOAuthCallbackUrl: "https://adaceen.prueba/auth/github/callback",
    githubApiBaseUrl: GITHUB_API,
  });
  // GitHub falso: solo sus URL; lo demas va al servidor local de verdad.
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url === "https://github.com/login/oauth/access_token") return json({ access_token: "gho_prueba", token_type: "bearer", scope: "repo,codespace" });
    if (url === `${GITHUB_API}/user`) return json({ login: "Estudiante-GH", email: "estudiante@github.prueba" });
    return realFetch(input, init);
  }) as typeof fetch;
  const { server, database, baseUrl } = await startTestServer();
  try {
    const sessionId = await loginStudent(baseUrl);
    const hostile = "</script><script>alert(1)</script>";
    const start = await realFetch(`${baseUrl}/api/github/oauth/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({ repoFullName: hostile }),
    });
    assert.equal(start.status, 200);
    const state = new URL((await start.json() as { authorizeUrl: string }).authorizeUrl).searchParams.get("state");
    assert.ok(state);

    const callback = await realFetch(`${baseUrl}/auth/github/callback?code=codigo&state=${encodeURIComponent(state)}`);
    assert.equal(callback.status, 200);
    const html = await callback.text();
    assert.match(html, /GitHub conectado correctamente para ADACEEN\./);
    assert.match(html, /<html lang="es">/);
    // Dos scripts propios (espera del editor y aviso): el valor no abre ni cierra otro.
    assert.equal((html.match(/<script>/g) || []).length, 2);
    assert.equal((html.match(/<\/script>/g) || []).length, 2);
    assert.doesNotMatch(html, /alert\(1\)<\/script>/);

    const posted: unknown[] = [];
    const notify = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).find((code) => code.includes("postMessage"));
    assert.ok(notify);
    vm.runInNewContext(notify, {
      window: {
        opener: { closed: false, postMessage: (payload: unknown) => posted.push(payload) },
        setInterval: () => 1,
        clearInterval: () => {},
      },
    });
    const payload = posted[0] as { type: string; repoFullName: string; accountLogin: string };
    assert.equal(payload.type, "ADACEEN_GITHUB_OAUTH_CONNECTED");
    assert.equal(payload.repoFullName, hostile, "el valor llega intacto al aviso");
    assert.equal(payload.accountLogin, "Estudiante-GH");
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(env, savedEnv);
    await stopTestServer(server, database);
  }
});

test("OAuth de GitHub: /api/health dice si GitHub acepta la direccion de regreso (rechazado, verificado)", async () => {
  const GITHUB_API = "https://api.github.prueba";
  const CALLBACK = "https://adaceen.prueba/auth/github/callback";
  const envKeys = ["githubOAuthClientId", "githubOAuthClientSecret", "githubOAuthCallbackUrl", "githubApiBaseUrl"] as const;
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, env[key]]));
  const realFetch = globalThis.fetch;
  Object.assign(env, {
    githubOAuthClientId: "Ov23liPruebaCallback",
    githubOAuthClientSecret: "secreto-oauth-de-prueba",
    githubOAuthCallbackUrl: CALLBACK,
    githubApiBaseUrl: GITHUB_API,
  });
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url === "https://github.com/login/oauth/access_token") return json({ access_token: "gho_prueba", token_type: "bearer", scope: "read:user,user:email" });
    if (url === `${GITHUB_API}/user`) return json({ login: "Estudiante-GH", email: "estudiante@github.prueba" });
    return realFetch(input, init);
  }) as typeof fetch;
  const { server, database, baseUrl } = await startTestServer();
  type Health = { github_oauth_configured: boolean; github_oauth_callback_url: string | null; github_oauth_callback_state: string; github_oauth_callback_checked_at: string | null };
  const health = async () => await (await realFetch(`${baseUrl}/api/health`)).json() as Health;
  const report = (sessionId: string, redirectUri: string) => realFetch(`${baseUrl}/api/github/oauth/redirect-error`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify({ redirectUri }),
  });
  try {
    const initial = await health();
    assert.equal(initial.github_oauth_configured, true);
    assert.equal(initial.github_oauth_callback_url, CALLBACK);
    assert.equal(initial.github_oauth_callback_state, "sin_verificar", "nadie ha conectado GitHub todavia");
    assert.equal(initial.github_oauth_callback_checked_at, null);

    assert.equal((await report("", CALLBACK)).status, 401, "sin sesion no se anota");
    const sessionId = await loginStudent(baseUrl);
    // Otra direccion (no la de este servidor) no se anota.
    const other = await report(sessionId, "https://otra.prueba/callback");
    assert.equal(other.status, 200);
    assert.deepEqual(await other.json(), { ok: true, recorded: false, callbackUrl: CALLBACK });
    assert.equal((await health()).github_oauth_callback_state, "sin_verificar");

    // La extension vio «The redirect_uri is not associated with this application».
    const rejected = await report(sessionId, CALLBACK);
    assert.deepEqual(await rejected.json(), { ok: true, recorded: true, callbackUrl: CALLBACK });
    const afterReject = await health();
    assert.equal(afterReject.github_oauth_callback_state, "rechazado");
    assert.ok(afterReject.github_oauth_callback_checked_at);

    // Corregida la OAuth App, el siguiente callback que llega bien lo deja verificado.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const start = await realFetch(`${baseUrl}/api/github/oauth/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({ repoFullName: "curso/tarea-1" }),
    });
    const state = new URL((await start.json() as { authorizeUrl: string }).authorizeUrl).searchParams.get("state");
    const callback = await realFetch(`${baseUrl}/auth/github/callback?code=codigo&state=${encodeURIComponent(String(state))}`);
    assert.equal(callback.status, 200);
    const verified = await health();
    assert.equal(verified.github_oauth_callback_state, "verificado");
    assert.ok(Date.parse(String(verified.github_oauth_callback_checked_at)) >= Date.parse(String(afterReject.github_oauth_callback_checked_at)));
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(env, savedEnv);
    await stopTestServer(server, database);
  }
});

test("OAuth de GitHub con el editor en la nube: la pagina dice el paso 2 de 4, sigue los pasos de la extension y, sin avisos, que pulsar", async () => {
  const GITHUB_API = "https://api.github.prueba";
  const envKeys = ["githubOAuthClientId", "githubOAuthClientSecret", "githubOAuthCallbackUrl", "githubApiBaseUrl", "workspaceProvider"] as const;
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, env[key]]));
  const realFetch = globalThis.fetch;
  Object.assign(env, {
    githubOAuthClientId: "Ov23liPruebaCallback",
    githubOAuthClientSecret: "secreto-oauth-de-prueba",
    githubOAuthCallbackUrl: "https://adaceen.prueba/auth/github/callback",
    githubApiBaseUrl: GITHUB_API,
    workspaceProvider: "tunnel",
  });
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url === "https://github.com/login/oauth/access_token") return json({ access_token: "gho_prueba", token_type: "bearer", scope: "read:user,user:email" });
    if (url === `${GITHUB_API}/user`) return json({ login: "Estudiante-GH", email: "estudiante@github.prueba" });
    return realFetch(input, init);
  }) as typeof fetch;
  const { server, database, baseUrl } = await startTestServer();
  try {
    const sessionId = await loginStudent(baseUrl);
    const start = await realFetch(`${baseUrl}/api/github/oauth/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({ repoFullName: "curso/tarea-1" }),
    });
    const state = new URL((await start.json() as { authorizeUrl: string }).authorizeUrl).searchParams.get("state");
    const html = await (await realFetch(`${baseUrl}/auth/github/callback?code=codigo&state=${encodeURIComponent(String(state))}`)).text();
    assert.match(html, /GitHub conectado correctamente para ADACEEN\./);
    assert.match(html, /<li data-adaceen-wait-step="account" class="is-done">1\. Tu cuenta de GitHub<\/li><li data-adaceen-wait-step="start" class="is-current" aria-current="step">2\. Encender tu editor<\/li><li data-adaceen-wait-step="authorize" class="">3\. Autorizar tu editor<\/li><li data-adaceen-wait-step="open" class="">4\. Entrar a VS Code<\/li>/);
    assert.match(html, /<p class="adaceen-step" id="adaceenWaitStep">Paso 2 de 4 · Encender tu editor<\/p>/);
    assert.match(html, /<p class="adaceen-fallback" id="adaceenWaitFallback" hidden>¿Sigue igual\? Vuelve a la pestaña de ADACEEN/);
    assert.equal((html.match(/<script>/g) || []).length, 2, "los mismos dos scripts");

    // El script de la espera, con un DOM minimo.
    const waitScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).find((code) => code.includes("adaceenWaitFallback"));
    assert.ok(waitScript);
    const run = () => {
      const element = (extra: Record<string, unknown> = {}) => ({ textContent: "", hidden: true, ...extra });
      const items = ["account", "start", "authorize", "open"].map((id) => {
        const attrs: Record<string, string> = { "data-adaceen-wait-step": id };
        return { className: "", attrs, getAttribute: (name: string) => attrs[name] ?? null, setAttribute: (name: string, value: string) => { attrs[name] = value; }, removeAttribute: (name: string) => { delete attrs[name]; } };
      });
      const byId: Record<string, ReturnType<typeof element>> = {
        adaceenWaitFallback: element(),
        adaceenWaitTitle: element(),
        adaceenWaitDetail: element(),
        adaceenWaitStep: element(),
      };
      const timers: Array<() => void> = [];
      const listeners: Array<(event: unknown) => void> = [];
      const opener = { closed: false };
      vm.runInNewContext(String(waitScript), {
        document: { getElementById: (id: string) => byId[id] || null, querySelectorAll: () => items },
        window: { opener, addEventListener: (_type: string, listener: (event: unknown) => void) => listeners.push(listener), setTimeout: (fn: () => void) => timers.push(fn) },
      });
      return { byId, items, timers, send: (data: unknown, source: unknown = opener) => listeners.forEach((listener) => listener({ source, data })) };
    };
    // Sin avisos de la extension (0.7.22 desde una pagina sin repositorio): al vencer, que pulsar.
    const silent = run();
    silent.timers.forEach((fn) => fn());
    assert.equal(silent.byId.adaceenWaitFallback.hidden, false);
    // Con la extension 0.8.0: el paso 3 y sin el aviso; un mensaje de otra ventana no cuenta.
    const live = run();
    live.send({ type: "ADACEEN_WAIT_UPDATE", step: "authorize" }, {});
    assert.equal(live.items[2].className, "", "solo la ventana que la abrio");
    live.send({ type: "ADACEEN_WAIT_UPDATE", step: "authorize" });
    live.send({ type: "ADACEEN_WAIT_UPDATE", title: "Codigo de autorizacion: WDJB-MJHT", detail: "Paso 3 de 4 · Autorizar tu editor (obligatorio la primera vez)" });
    live.timers.forEach((fn) => fn());
    assert.equal(live.byId.adaceenWaitFallback.hidden, true);
    assert.deepEqual(live.items.map((item) => item.className), ["is-done", "is-done", "is-current", ""]);
    assert.equal(live.byId.adaceenWaitStep.textContent, "Paso 3 de 4 · Autorizar tu editor");
    assert.equal(live.byId.adaceenWaitTitle.textContent, "Codigo de autorizacion: WDJB-MJHT");
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(env, savedEnv);
    await stopTestServer(server, database);
  }
});
