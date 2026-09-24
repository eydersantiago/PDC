#!/usr/bin/env bash
# Switch de apagado de los recursos del worker en GCP.
#
#   bash teardown.sh            -> estado: que hay encendido y que cuesta
#   bash teardown.sh stop       -> apaga la VM. NO recomendado para ausencias
#                                  largas: el disco sigue costando (~$0.10/GB-mes,
#                                  o sea ~$12/mes con 120 GB).
#   bash teardown.sh destroy    -> borra VM + NAT + router. Gasto a cero.
#
# La regla de firewall allow-iap-ssh no cuesta nada y se conserva.
set -uo pipefail

ZONA=${ZONA:-us-central1-a}
REGION=${REGION:-${ZONA%-*}}
NOMBRE=${NOMBRE:-adaceen-worker}
ROUTER=${ROUTER:-adaceen-router}
NAT=${NAT:-adaceen-nat}
ACCION=${1:-status}

existe_vm() { gcloud compute instances describe "$NOMBRE" --zone="$ZONA" >/dev/null 2>&1; }

estado() {
  echo "== VM"
  gcloud compute instances list --filter="name=$NOMBRE" \
    --format="table(name,zone,machineType.basename(),status,scheduling.provisioningModel)" 2>/dev/null \
    || echo "  (ninguna)"
  echo
  echo "== Discos (cuestan tambien con la VM apagada)"
  gcloud compute disks list --format="table(name,zone.basename(),sizeGb,type.basename(),users.basename())" 2>/dev/null
  echo
  echo "== NAT y router"
  gcloud compute routers list --format="table(name,region.basename(),network.basename())" 2>/dev/null
  echo
  echo "== GPUs en uso"
  gcloud compute regions describe "$REGION" --format=json 2>/dev/null \
    | jq -r '.quotas[] | select(.metric|test("L4|T4")) | select(.usage>0) | "\(.metric): \(.usage)/\(.limit)"' \
    || true
}

case "$ACCION" in
  status) estado ;;

  stop)
    if existe_vm; then
      gcloud compute instances stop "$NOMBRE" --zone="$ZONA" --quiet
      echo
      echo "VM apagada. OJO: el disco de arranque sigue facturando."
      echo "Para ausencias de mas de unos dias usa:  bash teardown.sh destroy"
    else
      echo "No existe la VM $NOMBRE en $ZONA."
    fi
    ;;

  destroy)
    echo "Borrando VM, NAT y router. Se conserva la regla de firewall."
    gcloud compute instances delete "$NOMBRE" --zone="$ZONA" --quiet 2>/dev/null \
      || echo "  (la VM ya no estaba)"
    gcloud compute routers nats delete "$NAT" --router="$ROUTER" --region="$REGION" --quiet 2>/dev/null \
      || echo "  (el NAT ya no estaba)"
    gcloud compute routers delete "$ROUTER" --region="$REGION" --quiet 2>/dev/null \
      || echo "  (el router ya no estaba)"
    echo
    echo "Verificacion:"
    estado
    echo
    echo "Si arriba no aparece ninguna VM ni disco, el gasto quedo en cero."
    echo "Para volver:  bash create-vm.sh l4   (unos 12 min, reinstala el driver)"
    ;;

  *) echo "uso: bash teardown.sh [status|stop|destroy]"; exit 1 ;;
esac
