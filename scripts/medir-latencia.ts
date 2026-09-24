import "dotenv/config";
import fsp from "node:fs/promises";
import { setTextModelOverrideForTests } from "../src/services/agent-mode.js";
import { referenceModelOutput, TUTOR_SCENARIOS } from "../src/services/tutor-scenarios.js";
import {
  describeLatencies,
  hasFlag,
  login,
  openDatabasePool,
  readArg,
  readIntArg,
  startInProcessBackend,
  writeTextFile,
} from "./lib/cli.js";

/**
 * Latencia del tutor (A12.2): p50 y p95 por canal y escenario.
 *
 * Medicion en vivo (peticiones reales):
 *   npm run medir:latencia -- --url=https://<app>.azurewebsites.net --n=30 [--concurrencia=2]
 *        [--email=<estudiante> --password=<clave>]   # agrega el overlay (/intervene)
 *        [--con-cache]                               # mide respuestas repetidas (cache del servidor)
 *   Sin --url usa el backend en memoria; con --modelo-real llama al modelo de AGENT_TARGET,
 *   sin el mide solo el costo del servidor con la salida de referencia.
 *
 * Latencia del piloto (lo que midio el servidor en cada decision, columna latency_ms):
 *   npm run medir:latencia -- --desde-export=telemetria.jsonl
 *   npm run medir:latencia -- --desde-bd [--desde=2026-09-01] [--hasta=2026-12-01]
 *
 * --salida=<archivo.md> guarda el reporte; --umbral-p95=<ms> sale con codigo 1 si algun grupo lo supera.
 */

type Sample = { group: string; ms: number; ok: boolean; degraded: boolean };

type Row = { event_type?: string; channel?: string; policy_event_type?: string; help_stage?: string; latency_ms?: number | string | null; blocked?: boolean | string | null };

async function runLive(baseUrl: string, options: { n: number; concurrency: number; useCache: boolean; sessionId: string }) {
  const editorScenarios = TUTOR_SCENARIOS.filter((scenario) => scenario.editor && !scenario.editor.expected.blocked);
  const overlayScenarios = options.sessionId ? TUTOR_SCENARIOS.filter((scenario) => !scenario.overlay.expected.blocked) : [];
  const jobs: Array<() => Promise<Sample>> = [];
  const runId = Date.now().toString(36);

  for (let index = 0; index < options.n; index += 1) {
    const editor = editorScenarios[index % editorScenarios.length];
    jobs.push(async () => {
      const suffix = options.useCache ? "" : `\n// medicion ${runId}-${index}`;
      const body = { ...editor.editor!.body, tab_content: `${editor.editor!.body.tab_content}${suffix}` };
      const startedAt = performance.now();
      const response = await fetch(`${baseUrl}/suggest-tab`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8", "x-adaceen-client-id": `latencia-${runId}` },
        body: JSON.stringify(body),
      }).catch(() => null);
      const data = response ? await response.json().catch(() => ({})) as { degraded?: boolean } : {};
      return { group: `editor ${editor.id}`, ms: Math.round(performance.now() - startedAt), ok: Boolean(response?.ok), degraded: data.degraded === true };
    });
    if (overlayScenarios.length) {
      const overlay = overlayScenarios[index % overlayScenarios.length];
      jobs.push(async () => {
        const context = { ...overlay.overlay.context, activityTitle: `${overlay.overlay.context.activityTitle || "medicion"} ${runId}-${index}` };
        const startedAt = performance.now();
        const response = await fetch(`${baseUrl}/intervene`, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8", "x-session-id": options.sessionId },
          body: JSON.stringify({ question: overlay.overlay.question, context, max_items: 5 }),
        }).catch(() => null);
        const data = response ? await response.json().catch(() => ({})) as { source?: string } : {};
        return { group: `overlay ${overlay.id}`, ms: Math.round(performance.now() - startedAt), ok: Boolean(response?.ok), degraded: data.source === "heuristic" };
      });
    }
  }

  const samples: Sample[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      samples.push(await job());
    }
  };
  await Promise.all(Array.from({ length: options.concurrency }, worker));
  return samples;
}

function parseRecords(raw: string, fileName: string): Row[] {
  const text = raw.trim();
  if (!text) return [];
  if (fileName.endsWith(".csv")) {
    const [headerLine, ...lines] = text.split(/\r?\n/);
    const headers = headerLine.split(",");
    return lines.map((line) => {
      // CSV de exportar-telemetria: solo metadata y quality_flags llevan comillas; latencia y columnas cortas no.
      const cells: string[] = [];
      let current = "";
      let quoted = false;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (char === "\"" && line[index + 1] === "\"" && quoted) {
          current += "\"";
          index += 1;
        } else if (char === "\"") {
          quoted = !quoted;
        } else if (char === "," && !quoted) {
          cells.push(current);
          current = "";
        } else {
          current += char;
        }
      }
      cells.push(current);
      return Object.fromEntries(headers.map((header, index) => [header, cells[index]])) as Row;
    });
  }
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Row);
}

function samplesFromRows(rows: Row[]): Sample[] {
  return rows
    .filter((row) => row.event_type === "tutor_decision" && row.latency_ms !== null && row.latency_ms !== undefined && row.latency_ms !== "")
    .map((row) => ({
      group: `${row.channel || "?"} ${row.policy_event_type || "sin_evento"}${String(row.blocked) === "true" ? " (bloqueada)" : ""}`,
      ms: Number(row.latency_ms),
      ok: true,
      degraded: false,
    }))
    .filter((sample) => Number.isFinite(sample.ms));
}

function render(samples: Sample[], title: string, threshold: number | null) {
  const groups = new Map<string, Sample[]>();
  for (const sample of samples) {
    const channel = sample.group.split(" ")[0];
    for (const key of [sample.group, `${channel} (todos)`]) {
      groups.set(key, [...(groups.get(key) || []), sample]);
    }
  }
  const lines = [`# ${title}`, "", `- Fecha: ${new Date().toISOString()}`, `- Muestras: ${samples.length}`];
  if (threshold) lines.push(`- Umbral p95: ${threshold} ms`);
  lines.push(
    "",
    "| Grupo | n | p50 (ms) | p95 (ms) | max (ms) | media (ms) | errores | degradadas |",
    "|---|---|---|---|---|---|---|---|",
  );
  let overThreshold = false;
  for (const [group, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const stats = describeLatencies(list.filter((item) => item.ok).map((item) => item.ms));
    const errors = list.filter((item) => !item.ok).length;
    const degraded = list.filter((item) => item.degraded).length;
    if (threshold && stats.p95 !== null && stats.p95 > threshold) overThreshold = true;
    lines.push(`| ${group} | ${stats.n} | ${stats.p50 ?? "-"} | ${stats.p95 ?? "-"} | ${stats.max ?? "-"} | ${stats.mean ?? "-"} | ${errors} | ${degraded} |`);
  }
  lines.push("", "p50/p95 por rango mas cercano. \"degradadas\": respuesta controlada sin modelo (editor) o heuristica (overlay).", "");
  return { markdown: lines.join("\n"), overThreshold };
}

async function main() {
  const threshold = readArg("umbral-p95") ? Number(readArg("umbral-p95")) : null;
  let samples: Sample[] = [];
  let title = "Latencia del tutor";

  const exportFile = readArg("desde-export");
  if (exportFile) {
    samples = samplesFromRows(parseRecords(await fsp.readFile(exportFile, "utf8"), exportFile));
    title = `Latencia registrada en el piloto (${exportFile})`;
  } else if (hasFlag("desde-bd")) {
    const pool = openDatabasePool();
    try {
      const since = readArg("desde", "1970-01-01");
      const until = readArg("hasta", new Date(Date.now() + 60_000).toISOString());
      const result = await pool.query<Row>(
        `select event_type, channel, policy_event_type, help_stage, latency_ms, blocked
         from telemetry_events
         where event_type = 'tutor_decision' and occurred_at >= $1::timestamptz and occurred_at < $2::timestamptz`,
        [since, until],
      );
      samples = samplesFromRows(result.rows);
      title = `Latencia registrada en el piloto (${since} a ${until})`;
    } finally {
      await pool.end();
    }
  } else {
    const targetUrl = readArg("url").replace(/\/+$/, "");
    const backend = targetUrl ? { baseUrl: targetUrl, close: async () => {} } : await startInProcessBackend();
    const realModel = Boolean(targetUrl) || hasFlag("modelo-real");
    if (!realModel) setTextModelOverrideForTests(async (input) => referenceModelOutput(input));
    try {
      const email = readArg("email", targetUrl ? "" : "estudiante@adaceen.edu.co");
      const password = readArg("password", targetUrl ? "" : "Estudiante123!");
      const sessionId = email && password ? await login(backend.baseUrl, email, password) : "";
      samples = await runLive(backend.baseUrl, {
        n: readIntArg("n", 20, 1, 1000),
        concurrency: readIntArg("concurrencia", 1, 1, 16),
        useCache: hasFlag("con-cache"),
        sessionId,
      });
      title = `Latencia medida contra ${targetUrl || "backend en memoria"} (${realModel ? "modelo real" : "salida de referencia: solo costo del servidor"})`;
    } finally {
      setTextModelOverrideForTests(null);
      await backend.close();
    }
  }

  if (!samples.length) {
    console.log("No hay muestras de latencia.");
    return;
  }
  const report = render(samples, title, threshold);
  const output = readArg("salida");
  if (output) console.log(`[latencia] Reporte guardado en ${await writeTextFile(output, report.markdown)}`);
  console.log(report.markdown);
  if (report.overThreshold) {
    console.error(`[latencia] Algun grupo supera el p95 de ${threshold} ms.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[latencia] Fallo:", error);
  process.exitCode = 1;
});
