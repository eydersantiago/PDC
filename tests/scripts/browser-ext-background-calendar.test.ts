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
 */

type Json = Record<string, unknown>;
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function loadBackground(replies: (call: Call) => { status: number; json: unknown }) {
  const calls: Call[] = [];
  let onMessage: ((message: Json, sender: Json, sendResponse: (response: Json) => void) => unknown) | null = null;
  const chrome = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener: (listener: typeof onMessage) => { onMessage = listener; } },
    },
    action: { onClicked: { addListener() {} } },
    identity: {
      getAuthToken: (_details: Json, callback: (token: string) => void) => callback("token-prueba"),
      removeCachedAuthToken: (_details: Json, callback: () => void) => callback(),
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
  vm.runInContext(source, vm.createContext({ chrome, fetch, URL, console: { log() {}, warn() {}, error() {} } }), { filename: "background.js" });
  assert.ok(onMessage, "background.js registra onMessage");
  // La respuesta se crea dentro del vm (otro realm): se copia para comparar con deepEqual.
  const send = (message: Json) => new Promise<Json>((resolve) => {
    const keepOpen = onMessage!(message, {}, (response: Json) => resolve(JSON.parse(JSON.stringify(response))));
    assert.equal(keepOpen, true, `${String(message.type)} responde asincrono`);
  });
  return { calls, send };
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
