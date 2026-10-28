#!/usr/bin/env bash
# Exporta la configuracion de Google Cloud de ADACEEN a un archivo privado, para montarla igual en
# otra cuenta o proyecto con creditos (deploy/gcp/montar-cuenta-nueva.sh).
#
#   bash deploy/gcp/exportar-cuenta.sh [archivo]     (defecto: ~/adaceen-cuenta.env)
#
# Lee la metadata de la GPU y de la VM de editores del proyecto actual (PROYECTO o el de gcloud):
# secretos de la cola, del latido y del agente de editores, rama, modelo, tipos de maquina y
# minutos de inactividad. El archivo queda con permisos 600 y NUNCA se imprime su contenido.
# Guardalo fuera del repositorio (por ejemplo en tu PC) y no lo compartas: con el se atiende la
# cola de produccion.
#
# Variables: PROYECTO, GPU_ORIGEN (defecto: la primera de adaceen-worker-v100, adaceen-worker,
# adaceen-worker-a100 que exista), VM_EDITORES (adaceen-ws).
set -euo pipefail

DIR_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/comun-gcp.sh
. "$DIR_SCRIPT/comun-gcp.sh"
requiere_gcloud
command -v python3 >/dev/null 2>&1 || fallar "falta python3"

DESTINO=${1:-$HOME/adaceen-cuenta.env}
PROYECTO=$(resolver_proyecto)
VM_WS=${VM_EDITORES:-$VM_EDITORES_POR_DEFECTO}

leer_instancias || fallar "no pude listar las VMs de $PROYECTO: $INSTANCIAS_ERROR"
GPU=${GPU_ORIGEN:-}
if [ -z "$GPU" ]; then
  for candidata in adaceen-worker-v100 adaceen-worker adaceen-worker-a100; do
    if [ -n "$(zona_de "$candidata")" ]; then GPU=$candidata; break; fi
  done
fi
[ -n "$GPU" ] && [ -n "$(zona_de "$GPU")" ] || fallar "no encuentro una VM de GPU en $PROYECTO"
[ -n "$(zona_de "$VM_WS")" ] || fallar "no encuentro la VM de editores $VM_WS en $PROYECTO"

PRIV=$(mktemp -d "${TMPDIR:-/tmp}/adaceen-export.XXXXXX")
chmod 700 "$PRIV"
trap 'rm -rf "$PRIV"' EXIT
gcloud compute instances describe "$GPU" --zone="$(zona_de "$GPU")" --project="$PROYECTO" --format=json >"$PRIV/gpu.json"
gcloud compute instances describe "$VM_WS" --zone="$(zona_de "$VM_WS")" --project="$PROYECTO" --format=json >"$PRIV/ws.json"

umask 077
python3 - "$PRIV/gpu.json" "$PRIV/ws.json" "$DESTINO" "$PROYECTO" "$GPU" <<'PY'
import json, shlex, sys
from datetime import datetime, timezone

gpu, ws = (json.load(open(path)) for path in sys.argv[1:3])
destino, proyecto, nombre_gpu = sys.argv[3:6]

def meta(vm):
    return {item["key"]: item.get("value", "") for item in vm.get("metadata", {}).get("items", [])}

g, w = meta(gpu), meta(ws)
latido = g.get("heartbeat-url", "")
api = w.get("api-url") or (latido.rsplit("/api/agent/heartbeat", 1)[0] if latido else "")
valores = {
    "ORIGEN_PROYECTO": proyecto,
    "ORIGEN_GPU": nombre_gpu,
    "ZONA": gpu.get("zone", "").rsplit("/", 1)[-1] or "us-central1-a",
    "API_URL": api,
    "RAMA": g.get("branch") or w.get("branch") or "feature/azure-config-observability",
    "MODELO": g.get("model-text", "qwen2.5-coder:14b"),
    "IDLE_MINUTOS": g.get("idle-minutes", "180"),
    "IDLE_MINUTOS_WS": w.get("idle-minutes", "120"),
    "TIPO_GPU": gpu.get("machineType", "").rsplit("/", 1)[-1],
    "TIPO_WS": ws.get("machineType", "").rsplit("/", 1)[-1],
    "SB_CONN": g.get("sb-conn", ""),
    "WORKER_SECRET": g.get("worker-secret", ""),
    "HEARTBEAT_TOKEN": g.get("heartbeat-token", ""),
    "WORKSPACE_AGENT_TOKEN": w.get("workspace-agent-token", ""),
    "SCAN_WORKER_KEY": w.get("scan-worker-key", ""),
}
faltan = [k for k in ("SB_CONN", "HEARTBEAT_TOKEN", "WORKSPACE_AGENT_TOKEN", "API_URL") if not valores[k]]
with open(destino, "w") as f:
    f.write("# Configuracion de ADACEEN en Google Cloud (deploy/gcp/exportar-cuenta.sh)\n")
    f.write(f"# Exportada de {proyecto} el {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC. CONTIENE SECRETOS: no la subas a ningun repositorio.\n")
    for clave, valor in valores.items():
        f.write(f"{clave}={shlex.quote(str(valor))}\n")
print("faltan: " + ", ".join(faltan) if faltan else "completo")
PY
chmod 600 "$DESTINO"
ok "configuracion exportada a $DESTINO (permisos 600; no se muestra su contenido)"
info "Para llevarla a tu PC desde Cloud Shell: menu ⋮ → Descargar → $DESTINO"
info "En la cuenta nueva: PROYECTO=<id-nuevo> bash deploy/gcp/montar-cuenta-nueva.sh $DESTINO"
