#!/usr/bin/env bash
# Crea la VM de entornos de edicion (VS Code Tunnels) para el piloto ADACEEN.
#
#   ./create-ws-vm.sh            -> e2-standard-4 (4 vCPU / 16 GB), ~0,13 USD/h
#   TAMANO=e2-standard-8 ./create-ws-vm.sh
#
# No lleva GPU: aqui solo corren editores. La GPU sigue en adaceen-worker.
# Con 300 USD de credito, esta VM encendida 8 h al dia durante todo el
# piloto cuesta menos de 35 USD al mes.
#
# La VM no expone puertos ni tiene IP externa (la politica de la organizacion
# lo prohibe: constraints/compute.vmExternalIpAccess). Sale a internet por el
# Cloud NAT adaceen-nat que ya usa el worker; cada estudiante llega por
# vscode.dev a traves de Dev Tunnels, que es una conexion saliente.
set -euo pipefail

PROYECTO=${PROYECTO:-$(gcloud config get-value project 2>/dev/null)}
ZONA=${ZONA:-us-central1-a}
NOMBRE=${NOMBRE:-adaceen-ws}
TAMANO=${TAMANO:-e2-standard-4}
DISCO=${DISCO:-60}
API_URL=${API_URL:-https://app-adaceen-api-eyder05232002.azurewebsites.net}

# Esta VM ya NO recibe WORKER_SHARED_SECRET (worker-secret): terminaba en el
# entorno de la terminal de cada estudiante. Solo si PDC exige
# ADACEEN_SCAN_WORKER_KEY a la extension, exporta esa misma clave como
# SCAN_WORKER_KEY: va a la metadata scan-worker-key y de ahi al tunel (el
# estudiante la puede ver; es una clave para editores, no un secreto del backend).
SCAN_WORKER_KEY=${SCAN_WORKER_KEY:-}

# Secreto compartido entre PDC y el agente de entornos de la VM (fase 2):
# en Azure va como WORKSPACE_AGENT_TOKEN. Si no llega, se genera uno.
if [ -z "${WORKSPACE_AGENT_TOKEN:-}" ]; then
  WORKSPACE_AGENT_TOKEN=$(openssl rand -hex 32 2>/dev/null \
    || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
fi

METADATA="api-url=$API_URL,idle-minutes=120,workspace-agent-token=$WORKSPACE_AGENT_TOKEN"
if [ -n "$SCAN_WORKER_KEY" ]; then METADATA="$METADATA,scan-worker-key=$SCAN_WORKER_KEY"; fi

echo "proyecto=$PROYECTO zona=$ZONA vm=$NOMBRE tipo=$TAMANO disco=${DISCO}GB"

gcloud compute instances create "$NOMBRE" \
  --project="$PROYECTO" \
  --zone="$ZONA" \
  --machine-type="$TAMANO" \
  --no-address \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size="${DISCO}GB" \
  --boot-disk-type=pd-balanced \
  --metadata-from-file=startup-script=startup-ws.sh \
  --metadata="$METADATA"

cat <<FIN

Token del agente de entornos (copialo a Azure como WORKSPACE_AGENT_TOKEN;
queda tambien en la metadata workspace-agent-token de la VM):
  $WORKSPACE_AGENT_TOKEN

Creada. La VM NO es Spot a proposito: un desalojo en mitad de una sesion
de clase tumba a todos los estudiantes a la vez.

Seguimiento del arranque (~2 min):
  gcloud compute ssh $NOMBRE --zone=$ZONA --tunnel-through-iap \\
    --command='sudo tail -f /var/log/adaceen-ws-startup.log'

Spike a mano (un solo estudiante, tu):
  gcloud compute ssh $NOMBRE --zone=$ZONA --tunnel-through-iap
  sudo bash /opt/adaceen/spike-tunnel.sh

Encender / apagar:
  gcloud compute instances start $NOMBRE --zone=$ZONA
  gcloud compute instances stop  $NOMBRE --zone=$ZONA

Se apaga sola tras 120 min sin ningun tunel activo (timer adaceen-ws-idle).
FIN
