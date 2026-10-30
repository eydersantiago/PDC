import "dotenv/config";
import { env } from "../src/config/env.js";
import { mapTelemetryEventRow, type TelemetryEventDbRow } from "../src/db/database.js";
import { queryWorkshopSnapshots } from "../src/db/repos/analytics.js";
import { pointDefinitionsToCsv, snapshotPointsToCsv, snapshotsToCsv } from "../src/services/learning-analytics.js";
import { WORKSHOP_PROGRESS_KEY_PREFIX, type ProgressReport } from "../src/services/workshop-progress.js";
import { analyzeTelemetryDataset, toCsv, toJsonl, type TelemetryEventRow } from "../src/services/telemetry.js";
import { fail, hasFlag, login, nowStamp, openDatabasePool, readArg, writeTextFile } from "./lib/cli.js";
import { quizExportRecord, quizzesToCsv, type QuizDbRow } from "./lib/exportes.js";

/**
 * Exporta el conjunto de datos del piloto (A7.2) para el analisis de ciencia
 * de datos, sin identificadores en claro.
 *
 * Desde la base (DATABASE_URL):
 *   npm run telemetria:exportar -- [--desde=2026-09-01] [--hasta=2026-12-15] [--formato=jsonl|csv]
 *        [--salida=exportes/telemetria.jsonl] [--con-quices] [--calidad]
 * Desde el backend (sin acceso a la base; docente o administrador):
 *   npm run telemetria:exportar -- --url=https://<app>.azurewebsites.net --email=<docente> --password=<clave>
 *
 * --con-quices agrega los intentos del mini quiz con el mismo actor_anon_id
 * (exige la TELEMETRY_SALT del servidor para que los ids coincidan).
 * --con-avance agrega la historia del avance de los talleres (29-10-2026), siempre en CSV y con el
 * mismo actor_anon_id: <salida>-avance.csv (una fila por foto), -avance-puntos.csv (una por foto y
 * punto) y -avance-definiciones.csv (lo que vale cada punto). Funciona con --url y con la base.
 * La carpeta exportes/ esta en .gitignore: no subas exportaciones al repositorio.
 */

async function main() {
  const format = readArg("formato", "jsonl").toLowerCase() === "csv" ? "csv" : "jsonl";
  const since = readArg("desde", "");
  const until = readArg("hasta", "");
  for (const value of [since, until]) {
    if (value && Number.isNaN(Date.parse(value))) fail(`Fecha invalida: ${value}`);
  }
  const output = readArg("salida", `exportes/telemetria-${nowStamp()}.${format}`);
  const targetUrl = readArg("url").replace(/\/+$/, "");

  let content = "";
  let rows: TelemetryEventRow[] = [];
  if (targetUrl) {
    const email = readArg("email");
    const password = readArg("password");
    if (!email || !password) fail("Con --url hacen falta --email y --password de un docente o administrador.");
    const sessionId = await login(targetUrl, email, password);
    const query = new URLSearchParams({ format, limit: "200000", ...(since ? { since } : {}), ...(until ? { until } : {}) });
    const response = await fetch(`${targetUrl}/api/telemetry/export?${query}`, { headers: { "x-session-id": sessionId } });
    if (!response.ok) fail(`El backend respondio ${response.status}: ${await response.text()}`);
    content = await response.text();
    if (hasFlag("con-quices")) console.warn("[exportar] --con-quices solo funciona con acceso directo a la base; se omite.");
    if (hasFlag("con-avance")) {
      const files: Record<string, string> = {};
      for (const layout of ["fotos", "puntos", "definiciones"]) {
        const avanceQuery = new URLSearchParams({ layout, ...(since ? { since } : {}), ...(until ? { until } : {}) });
        const avance = await fetch(`${targetUrl}/api/analytics/workshop-progress/export?${avanceQuery}`, { headers: { "x-session-id": sessionId } });
        if (!avance.ok) fail(`El backend respondio ${avance.status} al exportar el avance: ${await avance.text()}`);
        files[layout] = await avance.text();
      }
      await writeAvance(output, files.fotos, files.puntos, files.definiciones);
    }
  } else {
    const pool = openDatabasePool();
    try {
      const result = await pool.query<TelemetryEventDbRow>(
        `select * from telemetry_events
         where occurred_at >= $1::timestamptz and occurred_at < $2::timestamptz
         order by occurred_at asc`,
        [since || "1970-01-01", until || new Date(Date.now() + 60_000).toISOString()],
      );
      rows = result.rows.map(mapTelemetryEventRow);
      content = format === "csv" ? toCsv(rows) : toJsonl(rows);

      if (hasFlag("con-quices")) {
        if (!env.telemetrySalt) fail("--con-quices necesita TELEMETRY_SALT (la misma del App Service) para que actor_anon_id coincida.");
        const quizzes = await pool.query<QuizDbRow>(
          `select id, client_key, teacher_user_id, trigger_kind, launch_id, status, language, file_path, topic,
                  correct_index, chosen_index, correct, followup_score, created_at, answered_at, completed_at
           from student_quizzes
           where created_at >= $1::timestamptz and created_at < $2::timestamptz
           order by created_at asc`,
          [since || "1970-01-01", until || new Date(Date.now() + 60_000).toISOString()],
        );
        const records = quizzes.rows.map(quizExportRecord);
        const quizOutput = output.replace(/(\.[a-z]+)?$/, `-quices.${format}`);
        const quizContent = format === "csv"
          ? quizzesToCsv(records)
          : records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
        console.log(`[exportar] ${records.length} intentos de quiz -> ${await writeTextFile(quizOutput, quizContent)}`);
      }

      if (hasFlag("con-avance")) {
        const snapshots = await queryWorkshopSnapshots(pool, { since, until });
        const settings = await pool.query<{ setting_value: string }>(
          `select setting_value from app_settings where setting_key like $1 order by setting_key asc`,
          [`${WORKSHOP_PROGRESS_KEY_PREFIX}%`],
        );
        const definitions = settings.rows.map((row) => {
          try {
            return pointDefinitionsToCsv(JSON.parse(row.setting_value) as ProgressReport);
          } catch {
            return "";
          }
        }).filter(Boolean);
        // Un solo encabezado aunque haya varios talleres.
        const merged = definitions.length
          ? [definitions[0].split("\n")[0], ...definitions.flatMap((text) => text.trim().split("\n").slice(1))].join("\n") + "\n"
          : pointDefinitionsToCsv(null);
        await writeAvance(output, snapshotsToCsv(snapshots), snapshotPointsToCsv(snapshots), merged);
      }
    } finally {
      await pool.end();
    }
  }

  const written = await writeTextFile(output, content);
  const count = content.trim() ? content.trim().split("\n").length - (format === "csv" ? 1 : 0) : 0;
  console.log(`[exportar] ${count} eventos -> ${written}`);

  if (hasFlag("calidad") && rows.length) {
    const report = analyzeTelemetryDataset(rows);
    console.log(JSON.stringify({ totalEvents: report.totalEvents, eventsWithFlags: report.eventsWithFlags, flags: report.flags, eventLoss: report.eventLoss }, null, 2));
  }
}

/** Escribe los tres CSV del avance junto a la salida principal. */
async function writeAvance(output: string, fotos: string, puntos: string, definiciones: string) {
  const base = output.replace(/(\.[a-z]+)?$/, "");
  const count = (text: string) => Math.max(0, text.trim().split("\n").length - 1);
  console.log(`[exportar] ${count(fotos)} fotos del avance -> ${await writeTextFile(`${base}-avance.csv`, fotos)}`);
  console.log(`[exportar] ${count(puntos)} filas por punto -> ${await writeTextFile(`${base}-avance-puntos.csv`, puntos)}`);
  console.log(`[exportar] ${count(definiciones)} puntos de los talleres -> ${await writeTextFile(`${base}-avance-definiciones.csv`, definiciones)}`);
}

main().catch((error) => {
  console.error("[exportar] Fallo:", error);
  process.exitCode = 1;
});
