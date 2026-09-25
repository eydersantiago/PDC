// Cliente del relay de PDC (A15.3): el camino Azure -> VM de editores cuando
// la VM no tiene IP publica.
//
// En lugar de esperar conexiones de Azure (imposible sin IP publica), el
// agente pregunta a PDC por HTTPS de salida (Cloud NAT) si hay peticiones:
//
//   GET  {AGENT_RELAY_URL}/next?wait=25   -> { jobs: [{ id, method, path, body? }] }
//   POST {AGENT_RELAY_URL}/responses      <- { responses: [{ id, status, json }] }
//
// Cada trabajo se reenvia al propio agente local (http://127.0.0.1:8787), asi
// que la logica de preparar y consultar el tunel es exactamente la misma que
// con conexion directa. Solo se reenvian las dos rutas del contrato.
//
// Node puro, sin dependencias (fetch de Node 18+).

export const RUTAS_RELAY = [
  { metodo: "POST", ruta: /^\/workspaces$/ },
  { metodo: "GET", ruta: /^\/workspaces\/[a-z0-9-]{1,28}$/ },
];

export function rutaPermitida(metodo, ruta) {
  return RUTAS_RELAY.some((item) => item.metodo === metodo && item.ruta.test(String(ruta || "")));
}

function dormirPorDefecto(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function crearClienteRelay({
  relayUrl,
  token,
  destino,
  esperaS = 25,
  fetchImpl = fetch,
  dormir = dormirPorDefecto,
  registrar = () => {},
}) {
  const base = String(relayUrl || "").replace(/\/+$/, "");
  let activo = false;
  let conectado = false;
  let sondeo = null;
  const enVuelo = new Set();

  async function atender(trabajo) {
    const id = String(trabajo?.id || "");
    const metodo = String(trabajo?.method || "").toUpperCase();
    const ruta = String(trabajo?.path || "");
    if (!id) return null;
    if (!rutaPermitida(metodo, ruta)) {
      return { id, status: 403, json: { state: "error", code: "route_not_allowed", message: "Ruta no permitida por el relay." } };
    }
    try {
      const respuesta = await fetchImpl(`${destino}${ruta}`, {
        method: metodo,
        headers: {
          Accept: "application/json",
          "x-agent-token": token,
          ...(trabajo.body === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" }),
        },
        ...(trabajo.body === undefined ? {} : { body: JSON.stringify(trabajo.body) }),
        signal: AbortSignal.timeout(60_000),
      });
      const texto = await respuesta.text();
      let json = null;
      try {
        json = texto ? JSON.parse(texto) : null;
      } catch {
        json = null;
      }
      return { id, status: respuesta.status, json };
    } catch (error) {
      registrar("aviso", "el agente local no respondio al relay", { ruta, error: String(error?.message || error) });
      return { id, status: 502, json: { state: "error", code: "agent_local_error", message: "El agente de la VM no respondio." } };
    }
  }

  async function enviar(resultado) {
    if (!resultado) return;
    for (let intento = 0; intento < 3; intento += 1) {
      try {
        const respuesta = await fetchImpl(`${base}/responses`, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8", "x-agent-token": token },
          body: JSON.stringify({ responses: [resultado] }),
          signal: AbortSignal.timeout(15_000),
        });
        if (respuesta.ok) return;
      } catch {
        // se reintenta
      }
      await dormir(1000 * (intento + 1));
    }
    registrar("aviso", "no se pudo devolver una respuesta al relay", { id: resultado.id });
  }

  async function ciclo() {
    let pausa = 1000;
    while (activo) {
      const control = new AbortController();
      sondeo = control;
      const limite = setTimeout(() => control.abort(), (esperaS + 20) * 1000);
      try {
        const respuesta = await fetchImpl(`${base}/next?wait=${esperaS}`, {
          headers: { Accept: "application/json", "x-agent-token": token },
          signal: control.signal,
        });
        if (respuesta.status === 401) {
          registrar("error", "el relay rechazo el token: AGENT_TOKEN no coincide con WORKSPACE_AGENT_TOKEN de PDC");
          conectado = false;
          await dormir(60_000);
          continue;
        }
        if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
        const cuerpo = await respuesta.json().catch(() => ({}));
        if (!conectado) {
          registrar("info", "conectado al relay", { relay: base });
          conectado = true;
        }
        pausa = 1000;
        for (const trabajo of Array.isArray(cuerpo?.jobs) ? cuerpo.jobs : []) {
          const tarea = atender(trabajo).then(enviar).catch((error) => {
            registrar("aviso", "fallo al atender un trabajo del relay", { error: String(error?.message || error) });
          });
          enVuelo.add(tarea);
          tarea.finally(() => enVuelo.delete(tarea));
        }
      } catch (error) {
        if (!activo) break;
        if (conectado) registrar("aviso", "relay sin conexion; se reintenta", { error: String(error?.message || error) });
        conectado = false;
        await dormir(pausa);
        pausa = Math.min(30_000, pausa * 2);
      } finally {
        clearTimeout(limite);
        sondeo = null;
      }
    }
  }

  return {
    iniciar() {
      if (activo) return Promise.resolve();
      activo = true;
      return ciclo();
    },
    async detener() {
      activo = false;
      sondeo?.abort();
      await Promise.allSettled([...enVuelo]);
    },
    atender,
    estado: () => ({ activo, conectado, enVuelo: enVuelo.size }),
  };
}
