import { formatNumber } from "./kpis.js";

/**
 * Monitor en vivo del piloto (A14.2): la evaluacion pura de una lectura.
 *
 * La comparten el script de consola (scripts/piloto-monitor.ts, que consulta
 * los endpoints por HTTP y deja el registro JSONL) y la pagina del docente
 * /docente/monitor (src/routes/teacher-monitor-page-routes.ts, que arma las
 * mismas respuestas en el propio servidor con GET /api/pilot/monitor). Asi las
 * reglas de las alertas y el texto de cada una viven en un solo sitio.
 *
 * La entrada son las respuestas JSON de /api/agent/health, /api/health,
 * /api/pilot, /api/telemetry/kpis (tres ventanas) y /api/agent/backend, cada
 * una con su codigo HTTP (0 = sin respuesta).
 */

/** Ventana de la latencia p50 "reciente" (T1 de los ultimos 10 min). */
export const MONITOR_RECENT_WINDOW_MS = 10 * 60_000;
/** Ventana de los estudiantes "activos" (con eventos en los ultimos 5 min). */
export const MONITOR_ACTIVE_WINDOW_MS = 5 * 60_000;
/** Bloque activo sin estudiantes durante este tiempo seguido: alerta. */
export const MONITOR_QUIET_ALERT_MS = 5 * 60_000;
/** Umbral de la alerta de latencia p50 reciente, en segundos. */
export const MONITOR_LATENCY_P50_ALERT_S = 8;

export type MonitorKpiItem = { id: string; value: number | null; n: number | null; meets: boolean | null };

export type MonitorKpisResponse = {
  ok?: boolean;
  activity?: {
    events: number;
    students: number;
    studentsByCondition: Record<string, number>;
    anonymousClientSessions: number;
    lastEventAt: string | null;
  };
  kpis?: MonitorKpiItem[];
  error?: string;
};

export type MonitorListeningWorker = {
  id: string;
  label: string;
  alive: boolean;
  /** Tipos de job que acepta ("text,image" o "text"); vacio o ausente = anterior a QUEUE_WORKER_KINDS. */
  kinds?: string;
  model?: string;
  platform?: string;
  lastSeenAt?: string;
  jobsProcessed?: number | null;
  lastJobAt?: string | null;
  concurrency?: number | null;
};

export type MonitorLastWorker = { id?: string; label?: string; accelerator?: string; observedAt?: string } | null;

/** Una respuesta JSON con su codigo HTTP (0 cuando no hubo respuesta). */
export type MonitorReading<T> = { status: number; data: T; ms?: number };

export type PilotMonitorInput = {
  /** GET /api/agent/health */
  health: MonitorReading<{ ok?: boolean; alive_workers?: number; reason?: string; error?: string }>;
  /** GET /api/health */
  backendHealth: MonitorReading<{
    ok?: boolean;
    mode?: string;
    workspace_provider?: string;
    workspace_agent_online?: boolean;
    workspace_agent_transport?: string | null;
    workspace_vm_autostart?: boolean;
    model_workers_alive?: number;
    error?: string;
  }>;
  /** GET /api/pilot */
  pilot: MonitorReading<{ block?: number; description?: string; counts?: { A: number; B: number; sinAsignar: number }; error?: string }>;
  /** GET /api/telemetry/kpis?since=<inicio de la sesion> */
  session: MonitorReading<MonitorKpisResponse>;
  /** GET /api/telemetry/kpis?since=<hace 10 min> */
  window10: MonitorReading<MonitorKpisResponse>;
  /** GET /api/telemetry/kpis?since=<hace 5 min> */
  window5: MonitorReading<MonitorKpisResponse>;
  /** GET /api/agent/backend */
  inference: MonitorReading<{ mode?: string; worker?: MonitorLastWorker; listening?: MonitorListeningWorker[]; error?: string }>;
};

export type PilotMonitorSummary = {
  /** /api/health: si el backend respondio y en que modo corre (local | azure | queue). */
  backend: { responde: boolean; estado: number; modo: string | null };
  /** /api/agent/health: el camino de inferencia (en modo queue exige un worker vivo). */
  worker: { ok: boolean; estado: number; vivos: number };
  modelo: {
    servidoresVivos: number;
    porTipo: Array<{ etiqueta: string; cantidad: number }>;
    /** Texto de la linea del monitor: "servidores 2 (Mac del laboratorio - M2 x1, Google Cloud - V100 x1)". */
    texto: string;
    aceptaImagenes: boolean;
    /** Modelos distintos entre los servidores vivos (deberia ser uno). */
    modelos: string[];
    servidores: Array<{
      id: string;
      etiqueta: string;
      modelo: string;
      tipos: string;
      plataforma: string;
      ultimoLatido: string | null;
      jobs: number | null;
      ultimoJob: string | null;
    }>;
    /** Quien atendio el ultimo job, si hubo alguno. */
    ultimoAtendio: { id: string; etiqueta: string; vistoEn: string | null } | null;
  };
  editor: {
    proveedor: string | null;
    agenteConectado: boolean | null;
    autoencendido: boolean | null;
    transporte: string | null;
  };
  piloto: {
    bloque: number;
    descripcion: string | null;
    conteos: { A: number; B: number; sinAsignar: number } | null;
    estado: number;
  };
  estudiantes: {
    activos5min: number;
    /** Tal como lo manda /api/telemetry/kpis (con_tutor, sin_tutor). */
    porCondicion: Record<string, number>;
    eventosSesion: number;
    sinUsuario: number;
    ultimoEvento: string | null;
  };
  calidad: {
    latenciaP50Reciente: number | null;
    sinFallo: number | null;
    perdidos: number | null;
    duplicados: number | null;
    cumple: { sinFallo: boolean | null; perdidos: boolean | null; duplicados: boolean | null };
  };
};

export type PilotMonitorEvaluation = {
  resumen: PilotMonitorSummary;
  alertas: string[];
  /** Desde cuando el bloque esta activo sin estudiantes (ms), para la siguiente lectura. */
  quietSince: number | null;
};

/** Los tres "since" de /api/telemetry/kpis que lee cada lectura. */
export function monitorWindows(now: Date, sessionStart: string) {
  return {
    session: sessionStart,
    recent: new Date(now.getTime() - MONITOR_RECENT_WINDOW_MS).toISOString(),
    lastFive: new Date(now.getTime() - MONITOR_ACTIVE_WINDOW_MS).toISOString(),
  };
}

function kpi(list: MonitorKpiItem[] | undefined, id: string) {
  return list?.find((item) => item.id === id) || null;
}

function hasValue(item: MonitorKpiItem | null): item is MonitorKpiItem & { value: number } {
  return item?.value !== null && item?.value !== undefined;
}

export function evaluatePilotMonitor(
  input: PilotMonitorInput,
  options: { now?: Date; quietSince?: number | null } = {},
): PilotMonitorEvaluation {
  const now = options.now ?? new Date();
  const { health, backendHealth, pilot, session, window10, window5, inference } = input;

  const block = pilot.data.block ?? 0;
  const t1Recent = kpi(window10.data.kpis, "T1");
  const t3 = kpi(session.data.kpis, "T3");
  const t4 = kpi(session.data.kpis, "T4");
  const t5 = kpi(session.data.kpis, "T5");
  const active = window5.data.activity?.students ?? 0;
  const anonymous = session.data.activity?.anonymousClientSessions ?? 0;
  const workerOk = health.status === 200;
  const aliveServers = (inference.data.listening || []).filter((worker) => worker.alive);
  const serverCounts = new Map<string, number>();
  for (const worker of aliveServers) serverCounts.set(worker.label, (serverCounts.get(worker.label) || 0) + 1);
  const serversText = aliveServers.length
    ? `servidores ${aliveServers.length} (${[...serverCounts].map(([label, count]) => `${label} x${count}`).join(", ")})`
    : "servidores 0";
  // Un worker sin "kinds" es anterior a QUEUE_WORKER_KINDS y atiende texto e imagenes.
  const acceptsImages = aliveServers.some((worker) => !worker.kinds || worker.kinds.split(",").includes("image"));
  // Todos los servidores del piloto deben usar el mismo modelo (qwen2.5-coder:14b).
  const models = [...new Set(aliveServers.map((worker) => worker.model || "").filter(Boolean))];

  const alertas: string[] = [];
  if (!workerOk) alertas.push(`sin worker (agent/health ${health.status || "sin respuesta"}): el tutor responde degradado`);
  if (backendHealth.status === 0) alertas.push("el backend no responde (/api/health)");
  if (models.length > 1) alertas.push(`servidores con modelos distintos (${models.join(", ")}): las respuestas no son comparables`);
  if (aliveServers.length && !acceptsImages) alertas.push("ningun servidor vivo acepta imagenes (QUEUE_WORKER_KINDS): las preguntas con captura esperan hasta el timeout");
  if (backendHealth.data.workspace_provider === "tunnel" && backendHealth.data.workspace_agent_online === false) {
    alertas.push("la VM de editores no esta conectada al relay: los estudiantes veran «El editor esta apagado» hasta que se encienda (bash deploy/clase.sh iniciar)");
  }
  if (hasValue(t1Recent) && t1Recent.value > MONITOR_LATENCY_P50_ALERT_S) alertas.push(`latencia p50 de 10 min en ${formatNumber(t1Recent.value, 1)} s (> 8 s)`);
  if (t3?.meets === false) alertas.push(`respuestas sin fallo ${formatNumber(t3.value, 1)} % (< 95 %)`);
  if (t4?.meets === false) alertas.push(`eventos perdidos ${formatNumber(t4.value, 1)} % (> 2 %)`);
  if (t5?.meets === false) alertas.push(`duplicados ${formatNumber(t5.value, 1)} % (> 1 %)`);
  if (anonymous) alertas.push(`${anonymous} sesiones de cliente sin usuario: revisa la sesion compartida de VS Code`);
  let quietSince = options.quietSince ?? null;
  if (block !== 0 && active === 0) {
    quietSince = quietSince ?? now.getTime();
    if (now.getTime() - quietSince >= MONITOR_QUIET_ALERT_MS) alertas.push("bloque activo y ningun estudiante con eventos en 5 min");
  } else {
    quietSince = null;
  }
  if (pilot.data.counts?.sinAsignar) alertas.push(`${pilot.data.counts.sinAsignar} estudiantes sin cohorte`);

  const lastWorker = inference.data.worker || null;
  const resumen: PilotMonitorSummary = {
    backend: {
      responde: backendHealth.status !== 0,
      estado: backendHealth.status,
      modo: backendHealth.data.mode || inference.data.mode || null,
    },
    worker: { ok: workerOk, estado: health.status, vivos: health.data.alive_workers ?? aliveServers.length },
    modelo: {
      servidoresVivos: aliveServers.length,
      porTipo: [...serverCounts].map(([etiqueta, cantidad]) => ({ etiqueta, cantidad })),
      texto: serversText,
      aceptaImagenes: acceptsImages,
      modelos: models,
      servidores: aliveServers.map((worker) => ({
        id: worker.id,
        etiqueta: worker.label,
        modelo: worker.model || "",
        tipos: worker.kinds || "",
        plataforma: worker.platform || "",
        ultimoLatido: worker.lastSeenAt || null,
        jobs: worker.jobsProcessed ?? null,
        ultimoJob: worker.lastJobAt ?? null,
      })),
      ultimoAtendio: lastWorker && (lastWorker.id || lastWorker.label)
        ? { id: lastWorker.id || "", etiqueta: lastWorker.label || lastWorker.id || "", vistoEn: lastWorker.observedAt || null }
        : null,
    },
    editor: {
      proveedor: backendHealth.data.workspace_provider || null,
      agenteConectado: typeof backendHealth.data.workspace_agent_online === "boolean" ? backendHealth.data.workspace_agent_online : null,
      autoencendido: typeof backendHealth.data.workspace_vm_autostart === "boolean" ? backendHealth.data.workspace_vm_autostart : null,
      transporte: backendHealth.data.workspace_agent_transport || null,
    },
    piloto: {
      bloque: block,
      descripcion: pilot.data.description || null,
      conteos: pilot.data.counts || null,
      estado: pilot.status,
    },
    estudiantes: {
      activos5min: active,
      porCondicion: window5.data.activity?.studentsByCondition || {},
      eventosSesion: session.data.activity?.events ?? 0,
      sinUsuario: anonymous,
      ultimoEvento: session.data.activity?.lastEventAt ?? null,
    },
    calidad: {
      latenciaP50Reciente: t1Recent?.value ?? null,
      sinFallo: t3?.value ?? null,
      perdidos: t4?.value ?? null,
      duplicados: t5?.value ?? null,
      cumple: { sinFallo: t3?.meets ?? null, perdidos: t4?.meets ?? null, duplicados: t5?.meets ?? null },
    },
  };

  return { resumen, alertas, quietSince };
}

function percentText(value: number | null) {
  return value !== null && value !== undefined ? `${formatNumber(value, 1)} %` : "—";
}

/** Los campos de la linea del monitor, sin la hora (la pagina le pone la hora local del navegador). */
export function formatPilotMonitorFields(resumen: PilotMonitorSummary) {
  const byCondition = resumen.estudiantes.porCondicion;
  const p50 = resumen.calidad.latenciaP50Reciente;
  return [
    `bloque ${resumen.piloto.bloque}`,
    `worker ${resumen.worker.ok ? "ok" : "CAIDO"}`,
    resumen.modelo.texto,
    `activos 5 min ${resumen.estudiantes.activos5min} (con tutor ${byCondition.con_tutor ?? 0}, sin tutor ${byCondition.sin_tutor ?? 0})`,
    `p50 10 min ${p50 !== null && p50 !== undefined ? `${formatNumber(p50, 1)} s` : "—"}`,
    `sin fallo ${percentText(resumen.calidad.sinFallo)}`,
    `perdidos ${percentText(resumen.calidad.perdidos)}`,
    `eventos ${resumen.estudiantes.eventosSesion}`,
  ];
}

/** La linea que imprime npm run piloto:monitor en cada lectura: la hora y los campos. */
export function formatPilotMonitorLine(resumen: PilotMonitorSummary, now: Date) {
  return [now.toLocaleTimeString("es-CO", { hour12: false }), ...formatPilotMonitorFields(resumen)].join(" | ");
}
