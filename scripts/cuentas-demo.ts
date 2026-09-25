import "dotenv/config";
import { fail, hasFlag, openDatabasePool } from "./lib/cli.js";
import { closeDemoAccounts } from "./lib/cuentas-demo.js";

/**
 * Cuentas de demostracion en la base de produccion (C20 de la lista de cumplimiento).
 *   npm run cuentas-demo                 # solo informa
 *   npm run cuentas-demo -- --confirmar  # desactiva estudiante y docente demo y cambia la clave del administrador demo
 *
 * Necesita DATABASE_URL (la del App Service) en .env. Ver docs/operacion/despliegue.md, "Cuentas demo".
 */

async function main() {
  const pool = openDatabasePool();
  try {
    const report = await closeDemoAccounts(pool, { confirm: hasFlag("confirmar") });
    for (const account of report.accounts) {
      const state = !account.exists
        ? "no existe"
        : !account.active
          ? "desactivada"
          : account.publicPassword ? "activa y entra con la clave del repositorio" : "activa con otra clave";
      const verb = account.action === "desactivar"
        ? (report.confirmed ? " -> desactivada" : " -> se desactivaria")
        : account.action === "cambiar_clave"
          ? (report.confirmed ? " -> clave cambiada" : " -> se le cambiaria la clave")
          : "";
      console.log(`[cuentas-demo] ${account.email}: ${state}${verb}`);
    }
    if (report.newAdminPassword) {
      console.log(`[cuentas-demo] Clave nueva de admin@adaceen.edu.co (se muestra una sola vez; guardala en tu gestor de claves): ${report.newAdminPassword}`);
    }
    const pending = report.accounts.some((account) => account.action !== "ninguna");
    if (!report.confirmed) {
      console.log(pending
        ? "[cuentas-demo] Simulacion: no se cambio nada. Agrega --confirmar para aplicarlo."
        : "[cuentas-demo] Ninguna cuenta demo entra con la clave del repositorio (C20 cumple).");
    } else {
      console.log("[cuentas-demo] Listo: ninguna cuenta demo entra con la clave del repositorio (C20).");
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  fail(String(error instanceof Error ? error.message : error));
});
