import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Regresion: el worker debe leer su archivo de configuracion antes de que
 * src/config/env.ts tome los valores. Si un modulo que importa env.ts se
 * importa de forma estatica, el worker arranca sin la cadena de conexion aunque
 * .env.worker (o el worker.env de las Mac del laboratorio) la tenga.
 */
test("worker: toma la configuracion de ADACEEN_WORKER_ENV_FILE (Mac del laboratorio) antes de leer env.ts", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "adaceen-worker-"));
  const envFile = path.join(dir, "worker.env");
  await fsp.writeFile(envFile, [
    "AGENT_TARGET=queue",
    // .invalid nunca resuelve (RFC 2606): el worker intenta conectarse, falla y reintenta.
    "AZURE_SERVICEBUS_CONNECTION_STRING=Endpoint=sb://adaceen-prueba.invalid/;SharedAccessKeyName=worker-mac;SharedAccessKey=abc=",
    "JOBS_QUEUE_NAME=llm-jobs",
    "RESULTS_QUEUE_NAME=llm-results-sessions",
    "QUEUE_WORKER_ID=mac-lab99-m2",
    "QUEUE_WORKER_KINDS=text",
    "SERVICE_BUS_TRANSPORT=amqp",
    "WORKER_HEARTBEAT_URL=",
    "",
  ].join("\n"), "utf8");

  const childEnv: NodeJS.ProcessEnv = { ...process.env, ADACEEN_WORKER_ENV_FILE: envFile, ADACEEN_LOG_LEVEL: "info" };
  for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "AZURE_SERVICEBUS_CONNECTION_STRING", "QUEUE_WORKER_ID", "SERVICE_BUS_TRANSPORT"]) {
    delete childEnv[key];
  }
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/service-bus-ollama-worker.ts"], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 30000);
    const check = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (/Escuchando|No se pudo iniciar/.test(output)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", check);
    child.stderr.on("data", check);
    void exited.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(killTimer);
  await fsp.rm(dir, { recursive: true, force: true });

  assert.doesNotMatch(output, /Faltan: AZURE_SERVICEBUS_CONNECTION_STRING/);
  assert.match(output, /Escuchando llm-jobs -> llm-results-sessions como mac-lab99-m2/);
  assert.match(output, /"transport":"amqp"/);
});
