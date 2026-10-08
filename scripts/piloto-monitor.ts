import "dotenv/config";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  evaluatePilotMonitor,
  formatPilotMonitorLine,
  monitorWindows,
  type MonitorKpisResponse,
  type PilotMonitorInput,
} from "../src/services/pilot-monitor.js";
import { fail, hasFlag, login, nowStamp, readArg, readIntArg } from "./lib/cli.js";

/**
 * Monitor en vivo de una sesion del piloto (A14.2): worker, servidores de
 * inferencia vivos (Google Cloud o Mac del laboratorio), bloque vigente,
 * estudiantes activos, calidad de la telemetria (eventos perdidos y
 * duplicados) y latencia reciente, con alertas.
 *
 *   npm run piloto:monitor -- --url=https://<app>.azurewebsites.net --email=<docente> --password=<clave>
 *        [--intervalo=30] [--desde=<ISO, inicio de la sesion>] [--registro=exportes/monitor-<fecha>.jsonl] [--una-vez]
 *
 * Cada lectura queda en el registro JSONL (evidencia de la sesion y base del
 * KPI de disponibilidad). Ctrl+C para terminar.
 *
 * Las reglas de las alertas y el texto de la linea estan en
 * src/services/pilot-monitor.ts, compartidas con la pagina /docente/monitor
 * (el docente ve lo mismo en el navegador, sin PowerShell).
 */

async function getJson<T>(url: string, sessionId: string) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { headers: { "x-session-id": sessionId } });
    const data = await response.json().catch(() => ({})) as T;
    return { status: response.status, data, ms: Date.now() - startedAt };
  } catch (error) {
    return { status: 0, data: { error: String(error) } as T, ms: Date.now() - startedAt };
  }
}

/** Las siete consultas de una lectura, por HTTP y con la sesion de consola. */
async function readMonitorInput(baseUrl: string, sessionId: string, now: Date, sessionStart: string): Promise<PilotMonitorInput> {
  const windows = monitorWindows(now, sessionStart);
  const [health, backendHealth, pilot, session, window10, window5, inference] = await Promise.all([
    getJson<PilotMonitorInput["health"]["data"]>(`${baseUrl}/api/agent/health`, sessionId),
    getJson<PilotMonitorInput["backendHealth"]["data"]>(`${baseUrl}/api/health`, sessionId),
    getJson<PilotMonitorInput["pilot"]["data"]>(`${baseUrl}/api/pilot`, sessionId),
    getJson<MonitorKpisResponse>(`${baseUrl}/api/telemetry/kpis?since=${encodeURIComponent(windows.session)}`, sessionId),
    getJson<MonitorKpisResponse>(`${baseUrl}/api/telemetry/kpis?since=${encodeURIComponent(windows.recent)}`, sessionId),
    getJson<MonitorKpisResponse>(`${baseUrl}/api/telemetry/kpis?since=${encodeURIComponent(windows.lastFive)}`, sessionId),
    // Servidores de inferencia con latido: GPUs de Google Cloud y Mac del laboratorio.
    getJson<PilotMonitorInput["inference"]["data"]>(`${baseUrl}/api/agent/backend`, sessionId),
  ]);
  return { health, backendHealth, pilot, session, window10, window5, inference };
}

async function main() {
  const baseUrl = readArg("url").replace(/\/+$/, "");
  const email = readArg("email");
  const password = readArg("password");
  if (!baseUrl || !email || !password) fail("Uso: npm run piloto:monitor -- --url=<backend> --email=<docente> --password=<clave>");
  const intervalS = readIntArg("intervalo", 30, 10, 600);
  const sessionStart = readArg("desde", new Date().toISOString());
  if (Number.isNaN(Date.parse(sessionStart))) fail(`Fecha invalida: ${sessionStart}`);
  const logPath = path.resolve(process.cwd(), readArg("registro", `exportes/monitor-${nowStamp()}.jsonl`));
  await fsp.mkdir(path.dirname(logPath), { recursive: true });
  let sessionId = await login(baseUrl, email, password);
  const once = hasFlag("una-vez");
  let quietSince: number | null = null;

  console.log(`[monitor] ${baseUrl} desde ${sessionStart}; cada ${intervalS} s; registro en ${path.relative(process.cwd(), logPath)}`);
  for (;;) {
    const now = new Date();
    const input = await readMonitorInput(baseUrl, sessionId, now, sessionStart);
    const { pilot, session } = input;
    if ([pilot.status, session.status].includes(401) || [pilot.status, session.status].includes(403)) {
      sessionId = await login(baseUrl, email, password);
      continue;
    }

    const evaluation = evaluatePilotMonitor(input, { now, quietSince });
    quietSince = evaluation.quietSince;
    const { resumen, alertas } = evaluation;

    console.log(formatPilotMonitorLine(resumen, now));
    for (const alert of alertas) console.log(`  ALERTA: ${alert}`);
    await fsp.appendFile(logPath, `${JSON.stringify({
      at: now.toISOString(),
      block: resumen.piloto.bloque,
      workerOk: resumen.worker.ok,
      healthStatus: resumen.worker.estado,
      servers: resumen.modelo.servidores.map((worker) => worker.id),
      activeStudents5m: resumen.estudiantes.activos5min,
      byCondition: resumen.estudiantes.porCondicion,
      latencyP50Recent: resumen.calidad.latenciaP50Reciente,
      t3: resumen.calidad.sinFallo,
      t4: resumen.calidad.perdidos,
      t5: resumen.calidad.duplicados,
      events: resumen.estudiantes.eventosSesion,
      anonymousClientSessions: resumen.estudiantes.sinUsuario,
      alerts: alertas,
    })}\n`, "utf8");
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, intervalS * 1000));
  }
}

main().catch((error) => {
  console.error("[monitor] Fallo:", error);
  process.exitCode = 1;
});
