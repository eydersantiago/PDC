import "dotenv/config";
import fsp from "node:fs/promises";
import path from "node:path";
import { env } from "../src/config/env.js";
import { mapTelemetryEventRow, type TelemetryEventDbRow } from "../src/db/database.js";
import { parsePilotPlan, type PilotPlan } from "../src/services/pilot-report.js";
import { pseudonymize, type TelemetryEventRow } from "../src/services/telemetry.js";
import { fail, nowStamp, openDatabasePool, readArg } from "./lib/cli.js";
import { QUIZ_COLUMNS, quizExportRecord, type QuizDbRow } from "./lib/exportes.js";
import { readTelemetryFile, writePilotDataset } from "./lib/piloto.js";

/**
 * Limpieza y validacion final del dataset del piloto (A14.3).
 *
 * Desde la base del piloto (DATABASE_URL):
 *   npm run piloto:dataset -- --desde=2026-10-06 --hasta=2026-10-22 [--plan=data/piloto/plan-piloto.json]
 *        [--salida=exportes/piloto-<fecha>]
 * Desde una exportacion (npm run telemetria:exportar -- --url=... --formato=csv):
 *   npm run piloto:dataset -- --entrada=exportes/telemetria.csv [--plan=...]
 *
 * Escribe dataset.csv, excluidos.csv, limpieza.md y diccionario-dataset.md; con
 * acceso a la base y TELEMETRY_SALT tambien quices.csv, bloques.csv y la
 * exclusion de las cuentas de prueba del plan. Nada se borra en la base.
 * La carpeta exportes/ esta en .gitignore.
 */

async function main() {
  const input = readArg("entrada");
  const since = readArg("desde");
  const until = readArg("hasta");
  for (const value of [since, until]) {
    if (value && Number.isNaN(Date.parse(value))) fail(`Fecha invalida: ${value}`);
  }
  const outDir = path.resolve(process.cwd(), readArg("salida", `exportes/piloto-${nowStamp()}`));
  const planPath = readArg("plan");
  const plan: PilotPlan | null = planPath ? parsePilotPlan(await fsp.readFile(planPath, "utf8")) : null;

  let rows: TelemetryEventRow[] = [];
  let testActors: string[] = [];
  let quizzes: Array<Record<string, unknown>> | null = null;
  let blockLog: Array<Record<string, unknown>> | null = null;
  let source = "";

  if (input) {
    rows = await readTelemetryFile(input);
    if (since || until) {
      const from = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
      const to = until ? Date.parse(until) : Number.POSITIVE_INFINITY;
      rows = rows.filter((row) => Date.parse(row.occurredAt) >= from && Date.parse(row.occurredAt) < to);
    }
    source = `archivo ${path.basename(input)}`;
    if (plan?.cuentasPrueba.length) {
      console.warn("[dataset] Con --entrada no se pueden excluir las cuentas de prueba (hace falta la base y la sal). Revisa excluidos.csv a mano.");
    }
  } else {
    const pool = openDatabasePool();
    try {
      const from = since || "1970-01-01";
      const to = until || new Date(Date.now() + 60_000).toISOString();
      const result = await pool.query<TelemetryEventDbRow>(
        `select * from telemetry_events where occurred_at >= $1::timestamptz and occurred_at < $2::timestamptz order by occurred_at asc`,
        [from, to],
      );
      rows = result.rows.map(mapTelemetryEventRow);
      source = "base del piloto (DATABASE_URL)";
      if (env.telemetrySalt) {
        if (plan?.cuentasPrueba.length) {
          const users = await pool.query<{ id: string; email: string }>(
            `select id, email from users where lower(email) = any($1::text[])`,
            [plan.cuentasPrueba.map((email) => email.toLowerCase())],
          );
          testActors = users.rows.map((user) => pseudonymize(`user:${user.id}`));
          const missing = plan.cuentasPrueba.length - users.rows.length;
          if (missing) console.warn(`[dataset] ${missing} cuentas de prueba del plan no existen en la base.`);
        }
        const quizRows = await pool.query<QuizDbRow>(
          `select id, client_key, teacher_user_id, trigger_kind, launch_id, status, language, file_path, topic,
                  correct_index, chosen_index, correct, followup_score, created_at, answered_at, completed_at
           from student_quizzes where created_at >= $1::timestamptz and created_at < $2::timestamptz order by created_at asc`,
          [from, to],
        );
        quizzes = quizRows.rows.map(quizExportRecord);
        const log = await pool.query<{ teacher_user_id: string; block: number; changed_at: string | Date }>(
          `select teacher_user_id, block, changed_at from pilot_block_log where changed_at >= $1::timestamptz and changed_at < $2::timestamptz order by changed_at asc`,
          [from, to],
        );
        blockLog = log.rows.map((item) => ({
          teacher_anon_id: pseudonymize(`user:${item.teacher_user_id}`),
          block: item.block,
          changed_at: new Date(item.changed_at).toISOString(),
        }));
      } else {
        console.warn("[dataset] Sin TELEMETRY_SALT: no se exportan quices ni bloques, ni se excluyen las cuentas de prueba del plan.");
      }
    } finally {
      await pool.end();
    }
  }

  const window = `${since || "inicio"} a ${until || "ahora"}`;
  const { result, files } = await writePilotDataset({
    rows,
    testActors,
    outDir,
    source,
    window,
    quizzes,
    quizColumns: QUIZ_COLUMNS,
    blockLog,
  });
  console.log(`[dataset] ${result.report.input} eventos de entrada, ${result.report.kept} quedan, ${result.excluded.length} excluidos; ${result.report.students} estudiantes.`);
  for (const file of files) console.log(`[dataset] ${path.relative(process.cwd(), file)}`);
  if (result.report.anonymousClientSessions) {
    console.warn(`[dataset] Atencion: ${result.report.anonymousClientSessions} sesiones de cliente sin usuario (ver limpieza.md).`);
  }
}

main().catch((error) => {
  console.error("[dataset] Fallo:", error);
  process.exitCode = 1;
});
