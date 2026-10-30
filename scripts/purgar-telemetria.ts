import "dotenv/config";
import { env } from "../src/config/env.js";
import { fail, hasFlag, openDatabasePool, readIntArg } from "./lib/cli.js";

/**
 * Retencion de la telemetria (A7.4): borra lo mas viejo que TELEMETRY_RETENTION_DAYS (365 por
 * defecto) de telemetry_events y, desde la analitica de aprendizaje (29-10-2026), tambien la
 * historia del avance de los talleres y el registro de consultas «¿Quien es este codigo?».
 *   npm run telemetria:purgar                      # solo cuenta lo que se borraria
 *   npm run telemetria:purgar -- --confirmar       # borra
 *   npm run telemetria:purgar -- --dias=180 --confirmar
 * Exporta antes lo que se vaya a analizar (npm run telemetria:exportar -- --con-avance).
 */

const TABLES = [
  { table: "telemetry_events", column: "occurred_at", label: "eventos" },
  { table: "workshop_progress_snapshots", column: "captured_at", label: "fotos del avance" },
  { table: "pseudonym_lookups", column: "created_at", label: "consultas de codigos" },
] as const;

async function main() {
  const days = readIntArg("dias", env.telemetryRetentionDays, 1, 3650);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const pool = openDatabasePool();
  try {
    const totals: Array<{ table: string; column: string; label: string; total: number }> = [];
    for (const item of TABLES) {
      try {
        const counted = await pool.query<{ total: string }>(
          `select count(*) as total from ${item.table} where ${item.column} < $1::timestamptz`,
          [cutoff],
        );
        totals.push({ ...item, total: Number(counted.rows[0]?.total || 0) });
      } catch (error) {
        // Una base anterior a la analitica no tiene las tablas nuevas: se dice, no se calla.
        console.warn(`[purgar] AVISO: no pude contar ${item.table} (${error instanceof Error ? error.message : error}); no se purga.`);
      }
    }
    console.log(`[purgar] Retencion: ${days} dias. Anteriores a ${cutoff}: ${totals.map((item) => `${item.total} ${item.label}`).join(", ")}.`);
    if (!hasFlag("confirmar")) {
      console.log("[purgar] Simulacion: no se borro nada. Agrega --confirmar para borrar.");
      return;
    }
    for (const item of totals) {
      if (item.total === 0) continue;
      const removed = await pool.query(`delete from ${item.table} where ${item.column} < $1::timestamptz`, [cutoff]);
      console.log(`[purgar] Borrados ${removed.rowCount || 0} ${item.label}.`);
    }
    // La ultima foto de cada estudiante solo sirve si queda historia: sin fotos, se quita tambien.
    await pool.query(
      `delete from workshop_progress_last l
       where not exists (select 1 from workshop_progress_snapshots s where s.taller = l.taller and s.actor_anon_id = l.actor_anon_id)`,
    ).catch(() => null);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  fail(String(error instanceof Error ? error.message : error));
});
