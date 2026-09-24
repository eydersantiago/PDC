import "dotenv/config";
import fsp from "node:fs/promises";
import { mapTelemetryEventRow, type TelemetryEventDbRow } from "../src/db/database.js";
import { analyzeTelemetryDataset, type DatasetRow } from "../src/services/telemetry.js";
import {
  fail,
  hasFlag,
  login,
  openDatabasePool,
  readArg,
  readIntArg,
  startInProcessBackend,
  writeTextFile,
} from "./lib/cli.js";

/**
 * Estabilidad de la telemetria (A12.3): eventos perdidos, duplicados y
 * orden, con las reglas I1-I6 de src/services/telemetry.ts.
 *
 * Revisar datos reales:
 *   npm run estabilidad:eventos -- --desde-export=exportes/telemetria.jsonl [--umbral=0.02]
 *   npm run estabilidad:eventos -- --desde-bd [--desde=2026-09-01] [--hasta=...]
 *
 * Prueba de carga sintetica (un cliente manda eventos con seq y se cuenta que llego):
 *   npm run estabilidad:eventos -- --simular [--eventos=500] [--lote=25] [--concurrencia=4] [--descartar=0.05]
 *   npm run estabilidad:eventos -- --simular --url=https://<app> --email=<docente> --password=<clave>
 * --descartar hace que el cliente "pierda" esa fraccion antes de enviar, para
 * comprobar que el estimador por huecos de seq la detecta. Los eventos
 * sinteticos usan client_session_id "estabilidad-..." y metadata.trigger=sync.
 *
 * --salida=<archivo.md> guarda el reporte; --umbral=<tasa> sale con 1 si la perdida la supera.
 */

type Report = ReturnType<typeof analyzeTelemetryDataset>;

function parseExport(raw: string, fileName: string): DatasetRow[] {
  const text = raw.trim();
  if (!text) return [];
  if (fileName.endsWith(".csv")) {
    fail("Para revisar la estabilidad usa la exportacion JSONL (--formato=jsonl): conserva quality_flags como objeto.");
  }
  return text.split(/\r?\n/).filter(Boolean).map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    return {
      id: String(record.id || ""),
      eventType: String(record.event_type || ""),
      occurredAt: String(record.occurred_at || ""),
      clientSessionId: String(record.client_session_id || ""),
      seq: record.seq === null || record.seq === undefined ? null : Number(record.seq),
      decisionId: String(record.decision_id || ""),
      qualityFlags: Array.isArray(record.quality_flags) ? record.quality_flags as DatasetRow["qualityFlags"] : [],
    };
  });
}

function renderReport(title: string, report: Report, extra: string[] = []) {
  const lines = [
    `# ${title}`,
    "",
    `- Fecha: ${new Date().toISOString()}`,
    `- Eventos revisados: ${report.totalEvents} (con avisos de calidad: ${report.eventsWithFlags})`,
    `- Sesiones de cliente con seq: ${report.eventLoss.clientSessions}`,
    `- Eventos esperados por seq: ${report.eventLoss.expected}, recibidos: ${report.eventLoss.received}, perdidos: ${report.eventLoss.missing} (tasa ${(report.eventLoss.rate * 100).toFixed(2)} %)`,
    ...extra,
    "",
    "| Regla | Casos | Ejemplos |",
    "|---|---|---|",
    ...Object.entries(report.integrity).map(([code, bucket]) => `| ${code} | ${bucket.count} | ${bucket.examples.join(", ") || "-"} |`),
    "",
    "| Aviso por evento | Casos |",
    "|---|---|",
    ...(Object.entries(report.flags).length
      ? Object.entries(report.flags).map(([code, count]) => `| ${code} | ${count} |`)
      : ["| (ninguno) | 0 |"]),
    "",
  ];
  return lines.join("\n");
}

async function simulate() {
  const targetUrl = readArg("url").replace(/\/+$/, "");
  const total = readIntArg("eventos", 300, 1, 20_000);
  const batchSize = readIntArg("lote", 25, 1, 50);
  const concurrency = readIntArg("concurrencia", 4, 1, 16);
  const discard = Math.min(0.9, Math.max(0, Number(readArg("descartar", "0")) || 0));
  const backend = targetUrl ? { baseUrl: targetUrl, close: async () => {}, database: null } : await startInProcessBackend();
  const sessionKey = `estabilidad-${Date.now().toString(36)}`;
  const clientId = `${sessionKey}-cliente`;
  const startedAt = new Date(Date.now() - 1000);

  try {
    // El primer y el ultimo evento siempre se mandan: el estimador solo ve huecos entre ambos.
    const kept: number[] = [];
    for (let seq = 1; seq <= total; seq += 1) {
      if (seq === 1 || seq === total || Math.random() >= discard) kept.push(seq);
    }
    const batches: number[][] = [];
    for (let index = 0; index < kept.length; index += batchSize) batches.push(kept.slice(index, index + batchSize));

    let httpErrors = 0;
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        const batch = batches[next];
        next += 1;
        const response = await fetch(`${backend.baseUrl}/api/behavior/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8", "x-adaceen-client-id": clientId },
          body: JSON.stringify({
            events: batch.map((seq) => ({
              source: "browser_extension",
              category: "navigation",
              eventType: "overlay_opened",
              schemaVersion: "1.1",
              clientSessionId: sessionKey,
              seq,
              metadata: { trigger: "sync" },
            })),
          }),
        }).catch(() => null);
        if (!response?.ok) httpErrors += 1;
      }
    };
    const sendStarted = Date.now();
    await Promise.all(Array.from({ length: concurrency }, worker));
    const sendMs = Date.now() - sendStarted;

    let rows: DatasetRow[] = [];
    if (backend.database) {
      rows = (await backend.database.listTelemetryEvents()).filter((row) => row.clientSessionId === sessionKey);
    } else {
      const email = readArg("email");
      const password = readArg("password");
      if (!email || !password) fail("Con --url hacen falta --email y --password de un docente para leer lo que llego.");
      const sessionId = await login(backend.baseUrl, email, password);
      const response = await fetch(`${backend.baseUrl}/api/telemetry/export?format=jsonl&since=${encodeURIComponent(startedAt.toISOString())}`, {
        headers: { "x-session-id": sessionId },
      });
      if (!response.ok) fail(`El backend respondio ${response.status} al exportar.`);
      rows = parseExport(await response.text(), "export.jsonl").filter((row) => row.clientSessionId === sessionKey);
    }

    const report = analyzeTelemetryDataset(rows);
    const discarded = total - kept.length;
    const extra = [
      `- Simulacion: ${total} eventos numerados, ${discarded} descartados por el cliente a proposito, ${kept.length} enviados en ${batches.length} lotes de hasta ${batchSize} (concurrencia ${concurrency}) en ${sendMs} ms.`,
      `- Lotes con error HTTP: ${httpErrors}.`,
      `- Guardados en telemetry_events: ${rows.length} de ${kept.length} enviados.`,
      `- El estimador por seq detecto ${report.eventLoss.missing} de ${discarded} descartes (${discarded ? Math.round((report.eventLoss.missing / discarded) * 100) : 100} %).`,
      `- Sesion sintetica: ${sessionKey} (excluirla del analisis si se corrio contra el piloto).`,
    ];
    const ok = rows.length === kept.length && report.eventLoss.missing === discarded && report.integrity.I2_duplicados.count === 0;
    return { markdown: renderReport(`Estabilidad de eventos: simulacion contra ${targetUrl || "backend en memoria"}`, report, extra), ok, report };
  } finally {
    await backend.close();
  }
}

async function main() {
  let markdown = "";
  let report: Report | null = null;
  let ok = true;

  const exportFile = readArg("desde-export");
  if (exportFile) {
    report = analyzeTelemetryDataset(parseExport(await fsp.readFile(exportFile, "utf8"), exportFile));
    markdown = renderReport(`Estabilidad de eventos: ${exportFile}`, report);
  } else if (hasFlag("desde-bd")) {
    const pool = openDatabasePool();
    try {
      const result = await pool.query<TelemetryEventDbRow>(
        `select * from telemetry_events where occurred_at >= $1::timestamptz and occurred_at < $2::timestamptz order by occurred_at asc`,
        [readArg("desde", "1970-01-01"), readArg("hasta", new Date(Date.now() + 60_000).toISOString())],
      );
      report = analyzeTelemetryDataset(result.rows.map(mapTelemetryEventRow));
      markdown = renderReport("Estabilidad de eventos: base del piloto", report);
    } finally {
      await pool.end();
    }
  } else if (hasFlag("simular")) {
    const simulation = await simulate();
    markdown = simulation.markdown;
    report = simulation.report;
    ok = simulation.ok;
  } else {
    fail("Indica --desde-export=<archivo.jsonl>, --desde-bd o --simular (ver el encabezado del script).");
  }

  const output = readArg("salida");
  if (output) console.log(`[estabilidad] Reporte guardado en ${await writeTextFile(output, markdown)}`);
  console.log(markdown);

  const threshold = readArg("umbral") ? Number(readArg("umbral")) : null;
  if (threshold !== null && report && report.eventLoss.rate > threshold) {
    console.error(`[estabilidad] La tasa de perdida ${report.eventLoss.rate} supera el umbral ${threshold}.`);
    process.exitCode = 1;
  }
  if (!ok) {
    console.error("[estabilidad] La simulacion no cuadra: revisa el reporte.");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[estabilidad] Fallo:", error);
  process.exitCode = 1;
});
