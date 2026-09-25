import "dotenv/config";
import { env } from "../src/config/env.js";
import { fail, hasFlag, openDatabasePool, readArg } from "./lib/cli.js";
import { withdrawParticipant } from "./lib/retiro.js";

/**
 * Retiro de un participante del piloto (A13.3, C07).
 *   npm run piloto:retiro -- --correo=<correo del estudiante>              # solo cuenta
 *   npm run piloto:retiro -- --correo=<correo del estudiante> --confirmar  # borra y anonimiza
 *
 * Necesita DATABASE_URL (base del piloto) y TELEMETRY_SALT (la del App
 * Service). Anota la fecha y el seudonimo en el registro de consentimientos,
 * no el correo. Si ya habia exportaciones, vuelve a correr piloto:dataset.
 */

async function main() {
  const email = readArg("correo");
  if (!email) fail("Falta --correo=<correo del estudiante>.");
  const pool = openDatabasePool();
  try {
    const report = await withdrawParticipant(pool, { email, confirm: hasFlag("confirmar"), salt: env.telemetrySalt });
    if (!report.found) fail("No hay una cuenta con ese correo.");
    console.log(`[retiro] Seudonimo del participante: ${report.actorAnonId}`);
    for (const [table, total] of Object.entries(report.counts)) {
      console.log(`[retiro] ${table}: ${total}`);
    }
    if (report.snapshotFiles.length) {
      console.log("[retiro] Archivos de instantaneas para borrar a mano en el almacenamiento del App Service:");
      for (const file of report.snapshotFiles) console.log(`  ${file}`);
    }
    console.log(report.confirmed
      ? "[retiro] Datos borrados, sesiones cerradas y cuenta anonimizada. Vuelve a generar el dataset si ya lo habias exportado."
      : "[retiro] Simulacion: no se borro nada. Agrega --confirmar para borrar.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  fail(String(error instanceof Error ? error.message : error));
});
