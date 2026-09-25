import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createWorkspaceRelay } from "../../src/services/workspace-relay.js";
import {
  describirMetaDeteccion,
  ESCENARIO_DEFS,
  findMark,
  formatDuration,
  metaDeteccionMs,
  RELAY_VENCE_MS,
  runSimulacro,
  type Lectura,
  type PasoResultado,
  type Tiempos,
} from "../../scripts/lib/simulacro.js";

/**
 * A15.5 · ADACEEN-126 y A13.6 · ADACEEN-114: npm run piloto:simulacro guia
 * el simulacro de docs/operacion/contingencia.md (seccion 9), mide deteccion,
 * degradado y recuperacion sondeando /api/health y no apaga nada. Se prueba
 * con un servidor HTTP falso cuyo estado cambia el "operador" de la prueba.
 */

type State = {
  down: "no" | "503" | "reset";
  alive: number;
  knownDown: boolean;
  agentOnline: boolean;
  agentHealth: number;
};

async function startFakeHealth(state: State) {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    requests.push(`${req.method} ${pathname}`);
    if (state.down === "reset") {
      req.socket.destroy();
      return;
    }
    if (state.down === "503") {
      res.writeHead(503, { "content-type": "text/html" });
      return res.end("<h1>Service Unavailable</h1>");
    }
    if (pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        ok: true,
        mode: "queue",
        worker_heartbeat_configured: true,
        workspace_provider: "tunnel",
        workspace_agent_online: state.agentOnline,
        workspace_agent_transport: "relay",
        model_workers_alive: state.alive,
        model_workers_known_down: state.knownDown,
      }));
    }
    if (pathname === "/api/agent/health") {
      res.writeHead(state.agentHealth, { "content-type": "application/json" });
      return res.end(JSON.stringify(state.agentHealth === 200 ? { ok: true, alive_workers: state.alive } : { ok: false, reason: "sin_worker" }));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

function capture() {
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += String(chunk); });
  return {
    output,
    text: () => text,
    async waitFor(pattern: RegExp, ms = 8_000) {
      const started = Date.now();
      while (!pattern.test(text)) {
        if (Date.now() - started > ms) throw new Error(`No aparecio ${pattern} en:\n${text}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("simulacro: findMark y formatDuration", () => {
  const lectura = (tMs: number, alive: number): Lectura => ({
    at: new Date(tMs).toISOString(), tMs, status: 200, ms: 1, error: null, ok: true, mode: "queue",
    workerHeartbeatConfigured: true, modelWorkersAlive: alive, modelWorkersKnownDown: alive === 0,
    workspaceProvider: "tunnel", workspaceAgentOnline: true, agentHealthStatus: null,
  });
  const lecturas = [lectura(0, 1), lectura(10, 0), lectura(20, 1), lectura(30, 0), lectura(40, 1), lectura(50, 1)];
  const vivo = (item: Lectura) => (item.modelWorkersAlive ?? 0) >= 1;
  assert.equal(findMark(lecturas, 5, 0, (item) => !vivo(item), "primera"), 10);
  assert.equal(findMark(lecturas, 5, 0, vivo, "primera"), 20);
  assert.equal(findMark(lecturas, 5, 0, vivo, "estable"), 40, "la recuperacion es el inicio de la racha final");
  assert.equal(findMark(lecturas.slice(0, 4), 5, 0, vivo, "estable"), null, "sin lectura sana al final no hay recuperacion");
  assert.equal(formatDuration(4_200), "4,2 s");
  assert.equal(formatDuration(42_000), "42 s");
  assert.equal(formatDuration(105_000), "1 min 45 s");
  assert.equal(formatDuration(null), "—");
});

test("simulacro: metas de deteccion con el relay de 60 s y el latido de 120 s", async () => {
  // El relay da al agente por conectado hasta RELAY_VENCE_MS despues del ultimo
  // sondeo: la deteccion del caso 8 nunca baja de 60 s desde el Enter.
  let now = 1_000_000;
  const relay = createWorkspaceRelay({ now: () => now });
  const corte = new AbortController();
  const sondeo = relay.nextJobs(25_000, corte.signal);
  now += 3_000;
  corte.abort();
  await sondeo;
  const parado = now;
  now = parado + RELAY_VENCE_MS;
  assert.equal(relay.isAgentOnline(), true, "sigue conectado hasta 60 s despues del corte");
  now = parado + RELAY_VENCE_MS + 1;
  assert.equal(relay.isAgentOnline(), false);

  const pasoOk = (id: PasoResultado["id"]): PasoResultado => ({ id, titulo: id, tipo: "manual", estado: "ok", at: null, tMs: 0 });
  const evaluar = (escenario: "gpu" | "editor", deteccionMs: number, intervaloMs = 5_000) => {
    const def = ESCENARIO_DEFS[escenario];
    const tiempos: Tiempos = { deteccionMs, degradadoMs: deteccionMs + 1_000, recuperacionMs: 20_000, fueraDeServicioMs: 30_000, completoMs: null };
    return def.filas[0].evaluar({ tiempos, pasos: [pasoOk("degradado")], def, intervaloMs });
  };
  assert.equal(metaDeteccionMs(ESCENARIO_DEFS.editor, 5_000), 120_000);
  assert.equal(metaDeteccionMs(ESCENARIO_DEFS.gpu, 5_000), 155_000);
  assert.equal(metaDeteccionMs(ESCENARIO_DEFS.azure, 5_000), null);
  assert.equal(evaluar("editor", 65_000).paso, true, "65 s: el relay vencio a los 60 s");
  assert.equal(evaluar("editor", 95_000).paso, true, "95 s: sondeo largo de 25 s y un comando lento");
  assert.equal(evaluar("editor", 121_000).paso, false);
  assert.equal(evaluar("gpu", 125_000).paso, true, "125 s: el latido vencio a los 120 s");
  assert.equal(evaluar("gpu", 155_000).paso, true);
  assert.equal(evaluar("gpu", 156_000).paso, false);
  assert.equal(evaluar("gpu", 158_000, 15_000).paso, true, "la meta suma el intervalo de consulta");
  assert.match(evaluar("editor", 70_000).detalle, /detección en 1 min 10 s \(esperado ≤ 2 min 00 s\)/);
  assert.equal(
    describirMetaDeteccion(ESCENARIO_DEFS.gpu, 5_000),
    "≤ 2 min 35 s: 120 s hasta que vence el latido, 30 s de margen para el comando y 5 s de consulta",
  );
  assert.equal(
    describirMetaDeteccion(ESCENARIO_DEFS.editor, 5_000),
    "≤ 2 min 00 s: 60 s sin sondeo del relay, hasta 25 s del último sondeo largo, 30 s de margen para el comando y 5 s de consulta",
  );
  assert.equal(describirMetaDeteccion(ESCENARIO_DEFS.azure, 5_000), "—");
});

test("simulacro gpu: el operador marca la caida y el encendido; el backend los ve", async () => {
  const state: State = { down: "no", alive: 1, knownDown: false, agentOnline: true, agentHealth: 200 };
  const fake = await startFakeHealth(state);
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "adaceen-simulacro-"));
  const input = new PassThrough();
  const screen = capture();
  try {
    const run = runSimulacro({
      backendUrl: fake.baseUrl,
      escenario: "gpu",
      intervaloMs: 20,
      timeoutMs: 1_000,
      limiteMs: 8_000,
      input,
      output: screen.output,
      salida: outDir,
    });
    await screen.waitFor(/Paso 1\/5: Apaga la GPU/);
    assert.match(screen.text(), /Estado inicial: sano/);
    assert.match(screen.text(), /VM_EDITORES=ninguna bash deploy\/clase\.sh terminar/);
    await sleep(60);
    input.write("\n");
    state.alive = 0;
    state.agentHealth = 503;
    await sleep(80);
    state.knownDown = true;
    await screen.waitFor(/Paso 4\/5: Enciende una GPU/);
    await sleep(60);
    input.write("\n");
    state.alive = 1;
    state.knownDown = false;
    state.agentHealth = 200;
    const result = await run;

    assert.deepEqual(result.pasos.map((paso) => [paso.id, paso.estado]), [
      ["caida", "ok"], ["deteccion", "ok"], ["degradado", "ok"], ["recuperar", "ok"], ["recuperacion", "ok"],
    ]);
    const { deteccionMs, degradadoMs, recuperacionMs, fueraDeServicioMs } = result.tiempos;
    assert.ok(deteccionMs !== null && deteccionMs >= 0 && deteccionMs < 2_000, `deteccion ${deteccionMs}`);
    assert.ok(degradadoMs !== null && deteccionMs !== null && degradadoMs >= deteccionMs, "el degradado llega despues de la deteccion");
    assert.ok(recuperacionMs !== null && recuperacionMs >= 0 && recuperacionMs < 2_000, `recuperacion ${recuperacionMs}`);
    assert.ok(fueraDeServicioMs !== null && fueraDeServicioMs > 0);
    assert.equal(result.veredicto, "paso");
    assert.deepEqual(result.filas.map((fila) => [fila.caso, fila.paso]), [["1. Desalojo", true], ["2. Recuperación", true]]);

    const registro = (await fsp.readFile(result.archivos.registro, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(registro[0].evento, "inicio");
    assert.equal(registro[registro.length - 1].evento, "fin");
    assert.ok(registro.some((line) => line.evento === "lectura" && line.agentHealthStatus === 503));
    assert.equal(registro.filter((line) => line.evento === "paso").length, 5);
    const resumen = await fsp.readFile(result.archivos.resumen, "utf8");
    assert.match(resumen, /^# Simulacro de contingencia: GPU apagada o desalojada, y recuperación/);
    assert.match(resumen, /\| 1\. Desalojo \| Sí \|/);
    assert.match(resumen, /\| Detección \| caída → primera lectura que la ve \| [^|]+ \| ≤ 2 min 30 s: 120 s hasta que vence el latido, 30 s de margen para el comando y 0 s de consulta \|/);
    assert.match(path.basename(result.archivos.registro), /^simulacro-gpu-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.jsonl$/);

    // Solo lee: nada de POST, ni otra ruta que la salud.
    assert.ok(fake.requests.length > 5);
    assert.ok(fake.requests.every((line) => line === "GET /api/health" || line === "GET /api/agent/health"), fake.requests.join(", "));
  } finally {
    input.end();
    await fake.close();
    await fsp.rm(outDir, { recursive: true, force: true });
  }
});

test("simulacro azure sin pausas: conexion cortada, 503 y vuelta de los latidos", async () => {
  const state: State = { down: "no", alive: 1, knownDown: false, agentOnline: true, agentHealth: 200 };
  const fake = await startFakeHealth(state);
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "adaceen-simulacro-"));
  const screen = capture();
  const timers = [
    setTimeout(() => { state.down = "reset"; }, 150),
    setTimeout(() => { state.down = "503"; }, 400),
    // Tras un reinicio el backend no recuerda los latidos ni el relay.
    setTimeout(() => { state.down = "no"; state.alive = 0; state.agentOnline = false; }, 650),
    setTimeout(() => { state.alive = 1; state.agentOnline = true; }, 850),
  ];
  try {
    const result = await runSimulacro({
      backendUrl: fake.baseUrl,
      escenario: "azure",
      intervaloMs: 20,
      timeoutMs: 1_000,
      limiteMs: 8_000,
      pausas: false,
      output: screen.output,
      salida: outDir,
    });
    assert.deepEqual(result.pasos.map((paso) => [paso.id, paso.estado]), [
      ["caida", "ok"], ["deteccion", "ok"], ["degradado", "omitido"], ["recuperacion", "ok"], ["completo", "ok"],
    ]);
    assert.ok((result.tiempos.fueraDeServicioMs ?? 0) >= 300, `fuera de servicio ${result.tiempos.fueraDeServicioMs}`);
    assert.ok((result.tiempos.completoMs ?? 0) >= (result.tiempos.recuperacionMs ?? Infinity), "el servicio completo llega despues de responder");
    assert.equal(result.veredicto, "por_confirmar", "el aviso de los clientes lo confirma el operador");
    const registro = (await fsp.readFile(result.archivos.registro, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(registro.some((line) => line.evento === "lectura" && line.status === 0 && /sin conexión/.test(line.error)), "registra la conexion cortada");
    assert.ok(registro.some((line) => line.evento === "lectura" && line.status === 503));
    const resumen = await fsp.readFile(result.archivos.resumen, "utf8");
    assert.match(resumen, /\| Servicio completo \|/);
    assert.match(resumen, /Por confirmar/);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    await fake.close();
    await fsp.rm(outDir, { recursive: true, force: true });
  }
});

test("simulacro editor: limite sin deteccion, «f» termina y Ctrl+C guarda el registro", async () => {
  const state: State = { down: "no", alive: 1, knownDown: false, agentOnline: true, agentHealth: 200 };
  const fake = await startFakeHealth(state);
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "adaceen-simulacro-"));
  try {
    // El agente nunca se desconecta: la deteccion vence el limite y el resultado es "no paso".
    const limite = await runSimulacro({
      backendUrl: fake.baseUrl,
      escenario: "editor",
      intervaloMs: 20,
      timeoutMs: 1_000,
      limiteMs: 150,
      pausas: false,
      output: capture().output,
      salida: outDir,
    });
    assert.equal(limite.pasos.find((paso) => paso.id === "deteccion")?.estado, "sin_detectar");
    assert.equal(limite.veredicto, "no_paso");
    assert.equal(limite.filas[0].paso, false);

    // «f» + Enter en plena espera: el resto queda pendiente y el registro se guarda.
    const input = new PassThrough();
    const screen = capture();
    const run = runSimulacro({
      backendUrl: fake.baseUrl,
      escenario: "editor",
      intervaloMs: 20,
      timeoutMs: 1_000,
      limiteMs: 8_000,
      input,
      output: screen.output,
      salida: outDir,
    });
    await screen.waitFor(/Paso 1\/5: Desconecta el agente/);
    assert.match(screen.text(), /sudo systemctl stop adaceen-workspaces-agent/);
    input.write("\n");
    await screen.waitFor(/Paso 2\/5/);
    input.write("f\n");
    const finished = await run;
    assert.deepEqual(finished.pasos.map((paso) => paso.estado), ["ok", "interrumpido", "pendiente", "pendiente", "pendiente"]);
    assert.equal(finished.veredicto, "no_paso");
    await fsp.stat(finished.archivos.resumen);
    input.end();

    // Ctrl+C (AbortSignal) en un paso manual.
    const controller = new AbortController();
    const aborted = runSimulacro({
      backendUrl: fake.baseUrl,
      escenario: "editor",
      intervaloMs: 20,
      timeoutMs: 1_000,
      input: new PassThrough(),
      output: capture().output,
      salida: outDir,
      signal: controller.signal,
    });
    await sleep(100);
    controller.abort();
    const stopped = await aborted;
    assert.equal(stopped.pasos[0].estado, "interrumpido");
    assert.notEqual(stopped.archivos.registro, finished.archivos.registro, "no pisa el registro anterior");
    const files = await fsp.readdir(outDir);
    assert.equal(files.filter((name) => name.endsWith(".jsonl")).length, 3);
  } finally {
    await fake.close();
    await fsp.rm(outDir, { recursive: true, force: true });
  }
});
