import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

/**
 * background.js y Google Calendar (navegador 0.7.17): el service worker real en node:vm con un
 * chrome.identity y un fetch falsos. Comprueba que la lista solo pase los parametros conocidos
 * (con privateExtendedProperty repetido para filtrar por la clave de ADACEEN), que PATCH mueva el
 * evento por su id, que la cuenta salga de userinfo y que los errores de Google lleguen al overlay.
 *
 * Firefox (sin chrome.identity.getAuthToken): el mismo background con un chrome.identity que solo
 * tiene launchWebAuthFlow y getRedirectURL. Comprueba la URL del flujo implicito de Google, el
 * parseo del fragmento (access_token, expires_in, scope, state), el cache en chrome.storage.local,
 * la ampliacion de permisos para Calendar, el borrado al salir y los errores con mensaje claro.
 */

type Json = Record<string, unknown>;
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
type Launch = { url: URL; interactive: boolean };
type LoadOptions = {
  /** Reemplaza chrome.identity (por defecto, el de Chrome con getAuthToken). */
  identity?: Json;
  /** Lo que devuelve chrome.runtime.getManifest(). */
  manifest?: Json;
  /** Contenido de chrome.storage.local (se comparte con la prueba). */
  storage?: Map<string, unknown>;
};

const PROFILE_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];
const CALENDAR_SCOPES = [...PROFILE_SCOPES, "https://www.googleapis.com/auth/calendar.events"];
const WEB_CLIENT_ID = "web-firefox.apps.googleusercontent.com";
// Lo que devuelve browser.identity.getRedirectURL() en Firefox para el id adaceen@univalle.edu.co.
const FIREFOX_REDIRECT_URL = "https://c9877db3762dafe589f3da2d95a4276b8e397dcf.extensions.allizom.org/";
const TOKEN_STORAGE_KEY = "adaceen.googleWebToken";

function loadBackground(replies: (call: Call) => { status: number; json: unknown }, options: LoadOptions = {}) {
  const calls: Call[] = [];
  const storage = options.storage || new Map<string, unknown>();
  let onMessage: ((message: Json, sender: Json, sendResponse: (response: Json) => void) => unknown) | null = null;
  const chrome = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener: (listener: typeof onMessage) => { onMessage = listener; } },
      getManifest: () => options.manifest || { version: "0.0.0" },
    },
    action: { onClicked: { addListener() {} } },
    identity: options.identity || {
      getAuthToken: (_details: Json, callback: (token: string) => void) => callback("token-prueba"),
      removeCachedAuthToken: (_details: Json, callback: () => void) => callback(),
    },
    storage: {
      local: {
        get: async (key: string) => (storage.has(key) ? { [key]: storage.get(key) } : {}),
        set: async (items: Json) => { for (const [key, value] of Object.entries(items)) storage.set(key, value); },
        remove: async (key: string) => { storage.delete(key); },
      },
    },
    tabs: { sendMessage: async () => ({}), captureVisibleTab() {} },
    scripting: { executeScript: async () => [] },
  };
  const fetch = async (input: unknown, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const call = { url: String(input), method: String(init.method || "GET"), headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const reply = replies(call);
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.json };
  };
  const source = fs.readFileSync(path.resolve(process.cwd(), "browser-ext-prod/background.js"), "utf8");
  const context = vm.createContext({ chrome, fetch, URL, URLSearchParams, crypto: globalThis.crypto, console: { log() {}, warn() {}, error() {} } });
  vm.runInContext(source, context, { filename: "background.js" });
  assert.ok(onMessage, "background.js registra onMessage");
  // La respuesta se crea dentro del vm (otro realm): se copia para comparar con deepEqual.
  const send = (message: Json) => new Promise<Json>((resolve) => {
    const keepOpen = onMessage!(message, {}, (response: Json) => resolve(JSON.parse(JSON.stringify(response))));
    assert.equal(keepOpen, true, `${String(message.type)} responde asincrono`);
  });
  const storedToken = () => (storage.has(TOKEN_STORAGE_KEY) ? JSON.parse(JSON.stringify(storage.get(TOKEN_STORAGE_KEY))) as Json : null);
  return { calls, send, storage, storedToken, context };
}

test("background: lista, mueve y lee la cuenta de Google Calendar", async () => {
  const { calls, send } = loadBackground((call) => {
    if (call.url.includes("/oauth2/v3/userinfo")) return { status: 200, json: { email: "Alumno@CorreoUnivalle.edu.co" } };
    if (call.method === "PATCH") return { status: 200, json: { id: "evt 1", start: (call.body as Json).start } };
    return { status: 200, json: { items: [{ id: "evt-1", summary: "FPOO: Examen (Primer parcial)" }] } };
  });

  const listed = await send({
    type: "ADACEEN_GOOGLE_CALENDAR_LIST",
    query: { privateExtendedProperty: ["adaceen=bitacora", "adaceenCourse=FPOO"], singleEvents: true, maxResults: 250, q: "no se pasa", showDeleted: true },
  });
  assert.deepEqual(listed, { ok: true, events: [{ id: "evt-1", summary: "FPOO: Examen (Primer parcial)" }] });
  const listUrl = new URL(calls[0].url);
  assert.equal(`${listUrl.origin}${listUrl.pathname}`, "https://www.googleapis.com/calendar/v3/calendars/primary/events");
  assert.deepEqual(listUrl.searchParams.getAll("privateExtendedProperty"), ["adaceen=bitacora", "adaceenCourse=FPOO"]);
  assert.equal(listUrl.searchParams.get("singleEvents"), "true");
  assert.equal(listUrl.searchParams.get("q"), null, "solo los parametros conocidos");
  assert.equal(listUrl.searchParams.get("showDeleted"), null);
  assert.match(String(listUrl.searchParams.get("fields")), /extendedProperties\/private/);
  assert.equal(calls[0].headers.Authorization, "Bearer token-prueba");

  const patched = await send({
    type: "ADACEEN_GOOGLE_CALENDAR_PATCH",
    eventId: "evt 1",
    patch: { start: { dateTime: "2026-10-13T09:00:00-05:00", timeZone: "America/Bogota" } },
  });
  assert.equal(patched.ok, true);
  assert.equal(calls[1].method, "PATCH");
  assert.equal(calls[1].url, "https://www.googleapis.com/calendar/v3/calendars/primary/events/evt%201");
  assert.deepEqual(calls[1].body, { start: { dateTime: "2026-10-13T09:00:00-05:00", timeZone: "America/Bogota" } });
  assert.equal(calls[1].headers["Content-Type"], "application/json; charset=utf-8");

  assert.deepEqual(await send({ type: "ADACEEN_GOOGLE_CALENDAR_ACCOUNT" }), { ok: true, email: "alumno@correounivalle.edu.co" });
  assert.equal(calls[2].url, "https://www.googleapis.com/oauth2/v3/userinfo");

  const missingId = await send({ type: "ADACEEN_GOOGLE_CALENDAR_PATCH", eventId: "", patch: {} });
  assert.equal(missingId.ok, false);
  assert.match(String(missingId.error), /Falta el evento/);
});

test("background: los errores de Google Calendar llegan con su mensaje", async () => {
  const { send } = loadBackground(() => ({ status: 403, json: { error: { message: "Insufficient Permission" } } }));
  const created = await send({ type: "ADACEEN_GOOGLE_CALENDAR_INSERT", event: { summary: "x" } });
  assert.equal(created.ok, false);
  assert.match(String(created.error), /Insufficient Permission/);
  const listed = await send({ type: "ADACEEN_GOOGLE_CALENDAR_LIST", query: {} });
  assert.match(String(listed.error), /Insufficient Permission/);
});

// ---- Firefox: chrome.identity sin getAuthToken ----

type WebAuthReply = (launch: Launch, index: number) => string | Promise<string>;

// Respuesta de Google como la ve launchWebAuthFlow: la URL de redireccion con el token en el fragmento.
function googleRedirect(launch: Launch, fragment: Record<string, string | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fragment)) {
    if (value !== undefined) params.set(key, value);
  }
  if (!params.has("state") && fragment.state !== "") params.set("state", String(launch.url.searchParams.get("state")));
  return `${FIREFOX_REDIRECT_URL}#${params.toString()}`;
}

function firefoxIdentity(reply: WebAuthReply) {
  const launches: Launch[] = [];
  const identity = {
    getRedirectURL: () => FIREFOX_REDIRECT_URL,
    launchWebAuthFlow: async (details: { url: string; interactive: boolean }) => {
      const launch = { url: new URL(details.url), interactive: details.interactive === true };
      launches.push(launch);
      return reply(launch, launches.length);
    },
  };
  return { identity, launches };
}

test("background (Firefox): login por launchWebAuthFlow, cache en storage y Calendar con mas permisos", async () => {
  // Google devuelve un token nuevo por ventana, con los permisos pedidos (include_granted_scopes).
  const { identity, launches } = firefoxIdentity((launch, index) => googleRedirect(launch, {
    access_token: `token-web-${index}`,
    token_type: "Bearer",
    expires_in: "3599",
    scope: String(launch.url.searchParams.get("scope")),
  }));
  const { calls, send, storedToken } = loadBackground(
    () => ({ status: 200, json: { items: [] } }),
    { identity, manifest: { version: "0.7.20", adaceenGoogleWebClientId: WEB_CLIENT_ID } },
  );

  const before = Date.now();
  assert.deepEqual(await send({ type: "ADACEEN_GOOGLE_AUTH" }), { ok: true, accessToken: "token-web-1" });
  assert.equal(launches.length, 1);
  const first = launches[0];
  assert.equal(first.interactive, true);
  assert.equal(`${first.url.origin}${first.url.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(first.url.searchParams.get("response_type"), "token", "flujo implicito: el backend verifica un access_token");
  assert.equal(first.url.searchParams.get("client_id"), WEB_CLIENT_ID);
  assert.equal(first.url.searchParams.get("redirect_uri"), FIREFOX_REDIRECT_URL);
  assert.equal(first.url.searchParams.get("scope"), PROFILE_SCOPES.join(" "));
  assert.equal(first.url.searchParams.get("prompt"), "select_account");
  assert.equal(first.url.searchParams.get("include_granted_scopes"), "true");
  assert.match(String(first.url.searchParams.get("state")), /^[A-Za-z0-9]{16,}$/);

  const cached = storedToken();
  assert.ok(cached, "el token queda en chrome.storage.local");
  assert.equal(cached.accessToken, "token-web-1");
  assert.deepEqual(cached.scopes, PROFILE_SCOPES);
  const expiresAt = Number(cached.expiresAt);
  assert.ok(expiresAt >= before + 3599 * 1000 && expiresAt <= Date.now() + 3599 * 1000, "expiresAt = ahora + expires_in");

  // Segundo login: sale del cache sin abrir otra ventana.
  assert.deepEqual(await send({ type: "ADACEEN_GOOGLE_AUTH" }), { ok: true, accessToken: "token-web-1" });
  assert.equal(launches.length, 1);

  // Calendar pide un permiso que el token del login no tiene: otra ventana con los tres permisos.
  const listed = await send({ type: "ADACEEN_GOOGLE_CALENDAR_LIST", query: { singleEvents: true } });
  assert.deepEqual(listed, { ok: true, events: [] });
  assert.equal(launches.length, 2);
  assert.equal(launches[1].url.searchParams.get("scope"), CALENDAR_SCOPES.join(" "));
  assert.equal(calls[0].headers.Authorization, "Bearer token-web-2");
  assert.deepEqual(storedToken()?.scopes, CALENDAR_SCOPES);

  // El token de Calendar tambien cubre el perfil: el login no abre otra ventana.
  assert.deepEqual(await send({ type: "ADACEEN_GOOGLE_AUTH" }), { ok: true, accessToken: "token-web-2" });
  assert.deepEqual(await send({ type: "ADACEEN_GOOGLE_CALENDAR_AUTHORIZE" }), { ok: true });
  assert.equal(launches.length, 2);

  // Salir borra el token guardado (equivalente de removeCachedAuthToken); el proximo login vuelve a Google.
  assert.deepEqual(await send({ type: "ADACEEN_GOOGLE_CLEAR_TOKEN" }), { ok: true });
  assert.equal(storedToken(), null);
  assert.deepEqual(await send({ type: "ADACEEN_GOOGLE_AUTH" }), { ok: true, accessToken: "token-web-3" });
  assert.equal(launches.length, 3);
});

test("background (Firefox): token vencido, sin interactive, state ajeno, acceso denegado y ventana cerrada", async () => {
  let mode: "ok" | "wrong-state" | "denied" | "cancel" | "no-expires" = "ok";
  const { identity, launches } = firefoxIdentity((launch, index) => {
    if (mode === "cancel") throw new Error("User cancelled or denied access.");
    if (mode === "denied") return `${FIREFOX_REDIRECT_URL}?error=access_denied#error=access_denied`;
    if (mode === "wrong-state") return googleRedirect(launch, { access_token: "ajeno", expires_in: "3599", state: "otro-state" });
    if (mode === "no-expires") return googleRedirect(launch, { access_token: `token-sin-expires-${index}` });
    return googleRedirect(launch, { access_token: `token-web-${index}`, expires_in: "3599" });
  });
  const storage = new Map<string, unknown>();
  storage.set(TOKEN_STORAGE_KEY, { accessToken: "token-vencido", expiresAt: Date.now() - 1000, scopes: PROFILE_SCOPES });
  const { send, storedToken, context } = loadBackground(
    () => ({ status: 200, json: {} }),
    { identity, storage, manifest: { adaceenGoogleWebClientId: WEB_CLIENT_ID } },
  );

  // Vencido: no se entrega; se abre Google otra vez.
  assert.deepEqual(await send({ type: "ADACEEN_GOOGLE_AUTH" }), { ok: true, accessToken: "token-web-1" });
  assert.equal(launches.length, 1);
  // Sin scope en la respuesta se asumen los pedidos.
  assert.deepEqual(storedToken()?.scopes, PROFILE_SCOPES);

  // interactive: false solo devuelve el cache vigente; nunca abre una ventana.
  const getGoogleAuthToken = context.getGoogleAuthToken as (interactive: boolean, scopes: string[]) => Promise<string>;
  assert.equal(await getGoogleAuthToken(false, PROFILE_SCOPES), "token-web-1");
  await assert.rejects(getGoogleAuthToken(false, CALENDAR_SCOPES), /No hay un token de Google vigente/);
  assert.equal(launches.length, 1);

  await send({ type: "ADACEEN_GOOGLE_CLEAR_TOKEN" });
  mode = "wrong-state";
  const wrongState = await send({ type: "ADACEEN_GOOGLE_AUTH" });
  assert.equal(wrongState.ok, false);
  assert.match(String(wrongState.error), /no corresponde a esta solicitud/);
  assert.equal(storedToken(), null, "un token con otro state no se guarda");

  mode = "denied";
  const denied = await send({ type: "ADACEEN_GOOGLE_AUTH" });
  assert.equal(denied.ok, false);
  assert.match(String(denied.error), /access_denied/);

  mode = "cancel";
  const cancelled = await send({ type: "ADACEEN_GOOGLE_CALENDAR_AUTHORIZE" });
  assert.equal(cancelled.ok, false);
  assert.match(String(cancelled.error), /User cancelled or denied access/);
  assert.equal(storedToken(), null);

  mode = "no-expires";
  const before = Date.now();
  const noExpires = await send({ type: "ADACEEN_GOOGLE_AUTH" });
  assert.equal(noExpires.ok, true);
  const expiresAt = Number(storedToken()?.expiresAt);
  assert.ok(expiresAt >= before + 3600 * 1000 && expiresAt <= Date.now() + 3600 * 1000, "sin expires_in se asume una hora");
});

test("background (Firefox): sin cliente web en el manifest o sin launchWebAuthFlow, el error es claro", async () => {
  // Paquete de Firefox generado sin GOOGLE_WEB_CLIENT_ID: no se abre ninguna ventana.
  const { identity, launches } = firefoxIdentity(() => { throw new Error("no debe llamarse"); });
  const withoutClient = loadBackground(() => ({ status: 200, json: {} }), { identity, manifest: { version: "0.7.20" } });
  const login = await withoutClient.send({ type: "ADACEEN_GOOGLE_AUTH" });
  assert.deepEqual(login, { ok: false, error: "Error: Inicio de sesion con Google no configurado en este paquete de la extension." });
  const calendar = await withoutClient.send({ type: "ADACEEN_GOOGLE_CALENDAR_LIST", query: {} });
  assert.match(String(calendar.error), /no configurado en este paquete/);
  assert.equal(launches.length, 0);
  assert.deepEqual(await withoutClient.send({ type: "ADACEEN_GOOGLE_CLEAR_TOKEN" }), { ok: true });

  // Navegador sin getAuthToken ni launchWebAuthFlow: el mensaje de siempre.
  const withoutIdentity = loadBackground(() => ({ status: 200, json: {} }), { identity: {}, manifest: { adaceenGoogleWebClientId: WEB_CLIENT_ID } });
  const unavailable = await withoutIdentity.send({ type: "ADACEEN_GOOGLE_AUTH" });
  assert.deepEqual(unavailable, { ok: false, error: "Error: Chrome Identity API no disponible." });
  assert.match(String((await withoutIdentity.send({ type: "ADACEEN_GOOGLE_CALENDAR_AUTHORIZE" })).error), /Chrome Identity API no disponible/);
});
