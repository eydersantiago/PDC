// Rutas del monitor del piloto: /docente/monitor, /api/admin/operacion y /api/pilot/monitor; el HTML esta en teacher-monitor-page-html.ts.
import { randomBytes } from "node:crypto";
import type express from "express";
import { env } from "../../config/env.js";
import type { AppDatabase } from "../../db/database.js";
import {
  evaluatePilotMonitor,
  formatPilotMonitorFields,
  monitorWindows,
  type MonitorReading,
  type PilotMonitorInput,
} from "../../services/pilot/pilot-monitor.js";
import { countAliveWorkers, listListeningWorkers } from "../../services/queue/worker-heartbeat.js";
import { getLastWorker } from "../../services/queue/worker-identity.js";
import { describeGpuAutostart } from "../../services/infra/gpu-autostart.js";
import { readMaintenance } from "../../services/infra/maintenance.js";
import { readBackupReport } from "../../services/workspace/workspace-backup.js";
import { describeWorkspaceHealth } from "../platform/health-routes.js";
import { pilotSummary, requirePilotOperator } from "../pilot/pilot-routes.js";
import { errorMessage, resolveSession } from "../route-utils.js";
import { setTeacherPageSecurityHeaders } from "./teacher-page-utils.js";
import { readLiveKpis } from "../pilot/telemetry-routes.js";
import { renderTeacherMonitorPageHtml } from "./teacher-monitor-page-html.js";

/**
 * Monitor en vivo del piloto en el navegador: GET /docente/monitor y GET /api/pilot/monitor.
 *
 * Es lo mismo que muestra `npm run piloto:monitor` en PowerShell (A14.2), pero sin
 * terminal ni contrasena en la linea de comandos: la abre el boton «Monitor» de la
 * pestana «Quices» del overlay en otra pestana del navegador, como «Crear quiz». La
 * sesion llega igual que en /docente/quices: el content script de la extension
 * (browser-ext-prod/inicio/pagina-quices.content.js, que corre en /docente/*) la manda
 * con postMessage ("adaceen:session") y, si no llega, la pagina muestra el inicio de
 * sesion con correo y contrasena (sesion de consola, para no cerrar la del overlay).
 *
 * La pagina solo pinta: cada 15 s pide GET /api/pilot/monitor con la cabecera
 * x-session-id y el backend arma en el propio servidor las mismas respuestas que el
 * script consulta por HTTP (/api/agent/health, /api/health, /api/pilot,
 * /api/telemetry/kpis en tres ventanas y /api/agent/backend) y las evalua con
 * src/services/pilot/pilot-monitor.ts, compartido con el script: mismas alertas y mismo texto.
 * Solo docente (su grupo) o administrador (con teacherUserId), como /api/pilot.
 * CSP con nonce: sin scripts ni estilos externos, y solo conecta con este origen.
 */

function reading<T>(status: number, data: T): MonitorReading<T> {
  return { status, data };
}

/**
 * Una consulta como la ve el script: si falla, queda con codigo 500 y el error en
 * data, y las demas se siguen mostrando (igual que una respuesta fallida por HTTP).
 */
async function attempt<T>(read: () => Promise<MonitorReading<T>>): Promise<MonitorReading<T>> {
  try {
    return await read();
  } catch (error) {
    return reading(500, { error: errorMessage(error) } as T);
  }
}

/** Las siete lecturas del monitor, armadas en el servidor para el grupo de un docente. */
export async function readPilotMonitorInput(
  database: AppDatabase,
  teacherUserId: string,
  now: Date,
  sessionStart: string,
): Promise<PilotMonitorInput> {
  const windows = monitorWindows(now, sessionStart);
  const kpis = (since: string) => attempt<PilotMonitorInput["session"]["data"]>(async () => reading(200, await readLiveKpis(database, { since })));
  const [health, backendHealth, pilot, session, window10, window5, inference] = await Promise.all([
    // GET /api/agent/health: en modo queue, 503 sin ningun worker vivo.
    attempt<PilotMonitorInput["health"]["data"]>(async () => {
      const aliveWorkers = countAliveWorkers();
      if (env.targetMode === "queue" && aliveWorkers === 0) return reading(503, { ok: false, reason: "sin_worker", alive_workers: 0 });
      return reading(200, { ok: true, alive_workers: aliveWorkers });
    }),
    // GET /api/health: el entorno de los estudiantes y su agente.
    attempt<PilotMonitorInput["backendHealth"]["data"]>(async () => reading(200, { ok: true, mode: env.targetMode, ...(await describeWorkspaceHealth(database)) })),
    // GET /api/pilot: bloque vigente y cohortes.
    attempt<PilotMonitorInput["pilot"]["data"]>(async () => reading(200, await pilotSummary(database, teacherUserId))),
    kpis(windows.session),
    kpis(windows.recent),
    kpis(windows.lastFive),
    // GET /api/agent/backend: servidores con latido y quien atendio el ultimo job.
    attempt<PilotMonitorInput["inference"]["data"]>(async () => reading(200, { mode: env.targetMode, worker: getLastWorker(), listening: listListeningWorkers() })),
  ]);
  return { health, backendHealth, pilot, session, window10, window5, inference };
}

// Bloque activo sin estudiantes: desde cuando, por docente (el script lo guarda en una variable).
const quietSinceByTeacher = new Map<string, number>();

export function registerTeacherMonitorPageRoutes(app: express.Express, database: AppDatabase) {
  app.get("/docente/monitor", (_req, res) => {
    const nonce = randomBytes(16).toString("base64");
    setTeacherPageSecurityHeaders(res, nonce);
    res.send(renderTeacherMonitorPageHtml(nonce));
  });

  /**
   * Operacion para la misma pagina (28-10-2026), aparte de la lectura del piloto (no necesita
   * teacherUserId): horario del tutor y ultimo autoencendido, ultima copia de respaldo, aviso
   * «Estamos actualizando» y posibles cuentas duplicadas (del grupo del docente; todas para el
   * administrador). Docente o administrador.
   */
  app.get("/api/admin/operacion", async (req, res) => {
    try {
      const session = await resolveSession(database, req).catch(() => null);
      if (!session) return res.status(401).json({ ok: false, error: "Sesion requerida." });
      if (session.user.role !== "teacher" && session.user.role !== "admin") {
        return res.status(403).json({ ok: false, error: "Solo docentes o administradores." });
      }
      const admin = session.user.role === "admin";
      const [backup, maintenance, duplicates] = await Promise.all([
        readBackupReport(database),
        readMaintenance(database),
        database.listPossibleDuplicateStudents(session.user),
      ]);
      return res.json({
        ok: true,
        viewerRole: session.user.role,
        horario: describeGpuAutostart(),
        // El bucket y el detalle del fallo solo para el administrador.
        respaldo: backup ? (admin ? backup : { ...backup, bucket: "", problem: backup.problem ? "La copia fallo: avisa al administrador." : "" }) : null,
        aviso: maintenance,
        duplicados: duplicates,
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });

  /**
   * Una lectura del monitor para la pagina: {resumen, alertas, leidoEn, desde, linea}.
   * `desde` es el inicio de la sesion del piloto (--desde del script; por defecto ahora).
   * Docente (su grupo) o administrador con teacherUserId, como GET /api/pilot.
   */
  app.get("/api/pilot/monitor", async (req, res) => {
    try {
      const operator = await requirePilotOperator(database, req, res);
      if (!operator) return;
      const now = new Date();
      const desde = typeof req.query.desde === "string" && req.query.desde.trim() ? req.query.desde.trim() : now.toISOString();
      if (Number.isNaN(Date.parse(desde))) return res.status(400).json({ ok: false, error: `Fecha invalida: ${desde}` });
      const input = await readPilotMonitorInput(database, operator.teacherUserId, now, desde);
      const evaluation = evaluatePilotMonitor(input, { now, quietSince: quietSinceByTeacher.get(operator.teacherUserId) ?? null });
      if (evaluation.quietSince === null) quietSinceByTeacher.delete(operator.teacherUserId);
      else quietSinceByTeacher.set(operator.teacherUserId, evaluation.quietSince);
      return res.json({
        ok: true,
        resumen: evaluation.resumen,
        alertas: evaluation.alertas,
        leidoEn: now.toISOString(),
        desde,
        // La linea del script sin la hora: la pagina le pone la hora local del navegador.
        linea: formatPilotMonitorFields(evaluation.resumen).join(" | "),
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });
}
