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

# La clave de la extension (scanWorkerKey) viaja por metadata igual que en
# el worker; se lee de la variable de entorno o se pide sin eco.
if [ -z "${WORKER_SECRET:-}" ]; then
  read -rsp "WORKER_SHARED_SECRET (Enter si no se usa): " WORKER_SECRET; echo
fi

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
  --metadata=api-url="$API_URL",worker-secret="$WORKER_SECRET",idle-minutes=120

cat <<FIN

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
