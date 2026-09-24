import "dotenv/config";
import { env } from "../src/config/env.js";
import { fail, hasFlag, openDatabasePool, readIntArg } from "./lib/cli.js";

/**
 * Retencion de la telemetria (A7.4): borra de telemetry_events los eventos
 * mas viejos que TELEMETRY_RETENTION_DAYS (365 por defecto).
 *   npm run telemetria:purgar                      # solo cuenta lo que se borraria
 *   npm run telemetria:purgar -- --confirmar       # borra
 *   npm run telemetria:purgar -- --dias=180 --confirmar
 * Exporta antes lo que se vaya a analizar (npm run telemetria:exportar).
 */

async function main() {
  const days = readIntArg("dias", env.telemetryRetentionDays, 1, 3650);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const pool = openDatabasePool();
  try {
    const counted = await pool.query<{ total: string }>(
      "select count(*) as total from telemetry_events where occurred_at < $1::timestamptz",
      [cutoff.toISOString()],
    );
    const total = Number(counted.rows[0]?.total || 0);
    console.log(`[purgar] Retencion: ${days} dias. Eventos anteriores a ${cutoff.toISOString()}: ${total}.`);
    if (!hasFlag("confirmar")) {
      console.log("[purgar] Simulacion: no se borro nada. Agrega --confirmar para borrar.");
      return;
    }
    if (total === 0) return;
    const removed = await pool.query("delete from telemetry_events where occurred_at < $1::timestamptz", [cutoff.toISOString()]);
    console.log(`[purgar] Borrados ${removed.rowCount || 0} eventos.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  fail(String(error instanceof Error ? error.message : error));
});
