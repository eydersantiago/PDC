// Cuentas de muestra: las que ADACEEN crea para probar y mostrar, no estudiantes reales.
//   - demo de seeds.ts (src/services/demo-accounts.ts): administrador, docente y estudiante demo;
//   - de prueba por rol (TEST_ACCOUNTS_PASSWORD, src/services/test-accounts.ts);
//   - demo por ruta (DEMO_RUTAS_PASSWORD, src/services/demo-route-accounts.ts).
// Examen del 28-10-2026: el panel decia «3 activos» a las 14:01 y eran 2 estudiantes; el tercero
// era una cuenta demo. Entran al panel marcadas, pero no a los totales ni a los activos del monitor.
import { DEMO_ACCOUNTS } from "./demo-accounts.js";
import { DEMO_ROUTE_ACCOUNT_IDS } from "./demo-route-accounts.js";
import { pseudonymize } from "./telemetry.js";
import { TEST_ACCOUNT_IDS } from "./test-accounts.js";

export const SAMPLE_ACCOUNT_IDS: ReadonlySet<string> = new Set([
  ...DEMO_ACCOUNTS.map((account) => account.id),
  ...TEST_ACCOUNT_IDS,
  ...DEMO_ROUTE_ACCOUNT_IDS,
]);

export function isSampleAccountId(id: string | null | undefined) {
  return Boolean(id) && SAMPLE_ACCOUNT_IDS.has(String(id));
}

let anonIds: { salt: string; ids: Set<string> } | null = null;

/**
 * actorAnonId de las cuentas de muestra en telemetry_events (pseudonymize de "user:<id>", igual que
 * actorFromSession): la telemetria no guarda ids en claro. Se recalcula si cambia la sal.
 */
export function sampleActorAnonIds(): ReadonlySet<string> {
  const salt = pseudonymize("sal");
  if (!anonIds || anonIds.salt !== salt) {
    anonIds = { salt, ids: new Set([...SAMPLE_ACCOUNT_IDS].map((id) => pseudonymize(`user:${id}`))) };
  }
  return anonIds.ids;
}
