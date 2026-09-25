import "dotenv/config";
import fsp from "node:fs/promises";
import path from "node:path";
import { formatNumber } from "../src/services/kpis.js";
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
 */

type KpiItem = { id: string; value: number | null; n: number | null; meets: boolean | null };
type KpisResponse = {
  ok: boolean;
  activity?: { events: number; students: number; studentsByCondition: Record<string, number>; anonymousClientSessions: number; lastEventAt: string | null };
  kpis?: KpiItem[];
  error?: string;
};

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

function kpi(list: KpiItem[] | undefined, id: string) {
  return list?.find((item) => item.id === id) || null;
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
    const recent = new Date(now.getTime() - 10 * 60_000).toISOString();
    const lastFive = new Date(now.getTime() - 5 * 60_000).toISOString();
    const [health, backendHealth, pilot, session, window10, window5, inference] = await Promise.all([
      getJson<{ ok?: boolean; alive_workers?: number; error?: string }>(`${baseUrl}/api/agent/health`, sessionId),
      getJson<{ workspace_provider?: string; workspace_agent_online?: boolean }>(`${baseUrl}/api/health`, sessionId),
      getJson<{ block?: number; counts?: { A: number; B: number; sinAsignar: number }; error?: string }>(`${baseUrl}/api/pilot`, sessionId),
      getJson<KpisResponse>(`${baseUrl}/api/telemetry/kpis?since=${encodeURIComponent(sessionStart)}`, sessionId),
      getJson<KpisResponse>(`${baseUrl}/api/telemetry/kpis?since=${encodeURIComponent(recent)}`, sessionId),
      getJson<KpisResponse>(`${baseUrl}/api/telemetry/kpis?since=${encodeURIComponent(lastFive)}`, sessionId),
      // Servidores de inferencia con latido: GPUs de Google Cloud y Mac del laboratorio.
      getJson<{ listening?: Array<{ id: string; label: string; alive: boolean; kinds?: string; model?: string }> }>(`${baseUrl}/api/agent/backend`, sessionId),
    ]);
    if ([pilot.status, session.status].includes(401) || [pilot.status, session.status].includes(403)) {
      sessionId = await login(baseUrl, email, password);
      continue;
    }

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

    const alerts: string[] = [];
    if (!workerOk) alerts.push(`sin worker (agent/health ${health.status || "sin respuesta"}): el tutor responde degradado`);
    if (backendHealth.status === 0) alerts.push("el backend no responde (/api/health)");
    if (models.length > 1) alerts.push(`servidores con modelos distintos (${models.join(", ")}): las respuestas no son comparables`);
    if (aliveServers.length && !acceptsImages) alerts.push("ningun servidor vivo acepta imagenes (QUEUE_WORKER_KINDS): las preguntas con captura esperan hasta el timeout");
    if (backendHealth.data.workspace_provider === "tunnel" && backendHealth.data.workspace_agent_online === false) {
      alerts.push("la VM de editores no esta conectada al relay: «Preparar entorno» fallara");
    }
    if (t1Recent?.value !== null && t1Recent?.value !== undefined && t1Recent.value > 8) alerts.push(`latencia p50 de 10 min en ${formatNumber(t1Recent.value, 1)} s (> 8 s)`);
    if (t3?.meets === false) alerts.push(`respuestas sin fallo ${formatNumber(t3.value, 1)} % (< 95 %)`);
    if (t4?.meets === false) alerts.push(`eventos perdidos ${formatNumber(t4.value, 1)} % (> 2 %)`);
    if (t5?.meets === false) alerts.push(`duplicados ${formatNumber(t5.value, 1)} % (> 1 %)`);
    if (anonymous) alerts.push(`${anonymous} sesiones de cliente sin usuario: revisa la sesion compartida de VS Code`);
    if (block !== 0 && active === 0) {
      quietSince = quietSince ?? now.getTime();
      if (now.getTime() - quietSince >= 5 * 60_000) alerts.push("bloque activo y ningun estudiante con eventos en 5 min");
    } else {
      quietSince = null;
    }
    if (pilot.data.counts?.sinAsignar) alerts.push(`${pilot.data.counts.sinAsignar} estudiantes sin cohorte`);

    const byCondition = window5.data.activity?.studentsByCondition || {};
    const line = [
      now.toLocaleTimeString("es-CO", { hour12: false }),
      `bloque ${block}`,
      `worker ${workerOk ? "ok" : "CAIDO"}`,
      serversText,
      `activos 5 min ${active} (con tutor ${byCondition.con_tutor ?? 0}, sin tutor ${byCondition.sin_tutor ?? 0})`,
      `p50 10 min ${t1Recent?.value !== null && t1Recent?.value !== undefined ? `${formatNumber(t1Recent.value, 1)} s` : "—"}`,
      `sin fallo ${t3?.value !== null && t3?.value !== undefined ? `${formatNumber(t3.value, 1)} %` : "—"}`,
      `perdidos ${t4?.value !== null && t4?.value !== undefined ? `${formatNumber(t4.value, 1)} %` : "—"}`,
      `eventos ${session.data.activity?.events ?? 0}`,
    ].join(" | ");
    console.log(line);
    for (const alert of alerts) console.log(`  ALERTA: ${alert}`);
    await fsp.appendFile(logPath, `${JSON.stringify({
      at: now.toISOString(),
      block,
      workerOk,
      healthStatus: health.status,
      servers: aliveServers.map((worker) => worker.id),
      activeStudents5m: active,
      byCondition,
      latencyP50Recent: t1Recent?.value ?? null,
      t3: t3?.value ?? null,
      t4: t4?.value ?? null,
      t5: t5?.value ?? null,
      events: session.data.activity?.events ?? 0,
      anonymousClientSessions: anonymous,
      alerts,
    })}\n`, "utf8");
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, intervalS * 1000));
  }
}

main().catch((error) => {
  console.error("[monitor] Fallo:", error);
  process.exitCode = 1;
});
