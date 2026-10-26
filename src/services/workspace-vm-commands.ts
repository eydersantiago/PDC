// Comandos de Cloud Shell para la VM de editores que el backend muestra solo a docentes y
// administradores (workspacePayloadForRole y GET /api/vscode/presence). Salen de
// WORKSPACE_VM_NAME y WORKSPACE_VM_ZONE; sin ellas (o con un valor que no es un nombre de GCP),
// los del piloto. Asi la extension de navegador, que pasa por la revision de Chrome Web Store, no
// lleva escrito el nombre de la VM ni su zona.
import { env } from "../config/env.js";

const PILOT_VM = { name: "adaceen-ws", zone: "us-central1-a" };
const VM_NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;
const VM_ZONE_RE = /^[a-z]+-[a-z]+\d+-[a-z]$/;

export type WorkspaceVmRef = { name?: string; zone?: string };

function pick(value: string | undefined, pattern: RegExp, fallback: string) {
  const text = (value || "").trim();
  return pattern.test(text) ? text : fallback;
}

/**
 * Vuelve a correr el arranque de la VM: baja el VSIX publicado, actualiza el agente y reinicia los
 * editores abiertos (mejor entre clases).
 */
export function workspaceVmStartupCommand(vm: WorkspaceVmRef = { name: env.workspaceVmName, zone: env.workspaceVmZone }) {
  const name = pick(vm.name, VM_NAME_RE, PILOT_VM.name);
  const zone = pick(vm.zone, VM_ZONE_RE, PILOT_VM.zone);
  return `gcloud compute ssh ${name} --zone=${zone} --tunnel-through-iap --command='sudo google_metadata_script_runner startup'`;
}
