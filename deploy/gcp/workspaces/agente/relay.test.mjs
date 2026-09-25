// Pruebas del cliente del relay (A15.3) con un PDC y un agente local falsos.
//   node --test deploy/gcp/workspaces/agente/relay.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { leerConfiguracion } from "./parse.mjs";
import { crearClienteRelay, rutaPermitida } from "./relay.mjs";

const TOKEN = "token-de-prueba-del-agente-0123456789";
const RELAY = "https://pdc.prueba/api/workspaces/agent";
const LOCAL = "http://127.0.0.1:8787";

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("relay: solo se reenvian las rutas del contrato del agente", () => {
  assert.equal(rutaPermitida("POST", "/workspaces"), true);
  assert.equal(rutaPermitida("GET", "/workspaces/eydersantiago"), true);
  assert.equal(rutaPermitida("GET", "/health"), false);
  assert.equal(rutaPermitida("DELETE", "/workspaces/eyder"), false);
  assert.equal(rutaPermitida("GET", "/workspaces/../etc/passwd"), false);
  assert.equal(rutaPermitida("POST", "/workspaces/otra"), false);
});

test("relay: la configuracion acepta https y rechaza http externo", () => {
  const base = { AGENT_TOKEN: TOKEN };
  assert.equal(leerConfiguracion(base).relayUrl, "");
  assert.equal(leerConfiguracion({ ...base, AGENT_RELAY_URL: `${RELAY}/` }).relayUrl, RELAY);
  assert.throws(() => leerConfiguracion({ ...base, AGENT_RELAY_URL: "http://pdc.prueba/api" }), /https/);
});

test("relay: recoge los trabajos, los pasa al agente local y devuelve cada respuesta", async () => {
  const enviados = [];
  const locales = [];
  let sondeos = 0;
  let cliente;
  const fetchImpl = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    assert.equal(headers.get("x-agent-token"), TOKEN, `token en ${url}`);
    if (url.startsWith(`${RELAY}/next`)) {
      sondeos += 1;
      if (sondeos === 1) {
        return json(200, {
          ok: true,
          jobs: [
            { id: "11111111-1111-4111-8111-111111111111", method: "POST", path: "/workspaces", body: { login: "eyder", repo: "owner/repo" } },
            { id: "22222222-2222-4222-8222-222222222222", method: "GET", path: "/health" },
          ],
        });
      }
      // Segundo sondeo: el cliente se detiene y el sondeo se corta.
      cliente.detener();
      throw new DOMException("abortado", "AbortError");
    }
    if (url === `${RELAY}/responses`) {
      enviados.push(...JSON.parse(String(init.body)).responses);
      return json(200, { ok: true, accepted: 1 });
    }
    if (url.startsWith(LOCAL)) {
      locales.push({ url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : null });
      return json(200, { state: "device_code", deviceCode: "WXYZ-1234", tunnelName: "ad-eyder" });
    }
    throw new Error(`URL inesperada ${url}`);
  };
  cliente = crearClienteRelay({ relayUrl: RELAY, token: TOKEN, destino: LOCAL, fetchImpl, dormir: async () => {} });
  await cliente.iniciar();
  await cliente.detener();

  assert.deepEqual(locales, [{ url: `${LOCAL}/workspaces`, method: "POST", body: { login: "eyder", repo: "owner/repo" } }]);
  const porId = Object.fromEntries(enviados.map((item) => [item.id, item]));
  assert.equal(porId["11111111-1111-4111-8111-111111111111"].status, 200);
  assert.equal(porId["11111111-1111-4111-8111-111111111111"].json.deviceCode, "WXYZ-1234");
  assert.equal(porId["22222222-2222-4222-8222-222222222222"].status, 403, "ruta fuera del contrato");
});

test("relay: si PDC no responde, espera con retroceso y vuelve a intentar", async () => {
  const pausas = [];
  let intentos = 0;
  let cliente;
  const fetchImpl = async () => {
    intentos += 1;
    if (intentos >= 4) cliente.detener();
    throw new TypeError("fetch failed");
  };
  cliente = crearClienteRelay({ relayUrl: RELAY, token: TOKEN, destino: LOCAL, fetchImpl, dormir: async (ms) => { pausas.push(ms); } });
  await cliente.iniciar();
  assert.deepEqual(pausas.slice(0, 3), [1000, 2000, 4000]);
});
