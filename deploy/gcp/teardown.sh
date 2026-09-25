#!/usr/bin/env bash
# Switch de apagado de los recursos del worker en GCP. Para el dia a dia de
# una clase usa deploy/clase.sh (iniciar/terminar); esto es para ausencias largas.
#
#   bash deploy/gcp/teardown.sh           -> estado: que hay encendido y que cuesta
#   bash deploy/gcp/teardown.sh stop      -> apaga TODAS las GPU. NO recomendado para
#                                            ausencias largas: el disco sigue costando
#                                            (~$0.10/GB-mes, o sea ~$12/mes por GPU con 120 GB).
#   bash deploy/gcp/teardown.sh destroy   -> borra las VMs de GPU (y sus discos). El NAT
#                                            y el router solo se borran si ya no queda
#                                            ninguna VM en la region: la VM de editores
#                                            (adaceen-ws) sale a internet por ese NAT.
#
# Variables: GPUS (defecto: adaceen-worker-v100 adaceen-worker-a100 adaceen-worker),
# NOMBRE (una sola VM, como antes), PROYECTO, REGION (us-central1), ROUTER, NAT,
# CONFIRMAR=1 (destroy sin preguntar, para correrlo sin terminal).
# La regla de firewall allow-iap-ssh no cuesta nada y se conserva; el snapshot
# adaceen-worker-snap (con el que clone-worker.sh rehace A100/V100) tambien.
set -uo pipefail

DIR_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/comun-gcp.sh
. "$DIR_SCRIPT/comun-gcp.sh"
requiere_gcloud

PROYECTO=$(resolver_proyecto)
REGION=${REGION:-$(region_de_zona "${ZONA:-$ZONA_POR_DEFECTO}")}
GPUS=${NOMBRE:-${GPUS:-$GPUS_POR_DEFECTO}}
ROUTER=${ROUTER:-$ROUTER_POR_DEFECTO}
NAT=${NAT:-$NAT_POR_DEFECTO}
ACCION=${1:-status}

estado() {
  echo "== VMs del proyecto $PROYECTO"
  gcloud compute instances list --project="$PROYECTO" \
    --format="table(name,zone.basename(),machineType.basename(),status,scheduling.provisioningModel)" 2>/dev/null \
    || echo "  (ninguna)"
  echo
  echo "== Discos (cuestan tambien con la VM apagada)"
  gcloud compute disks list --project="$PROYECTO" --format="table(name,zone.basename(),sizeGb,type.basename(),users.basename())" 2>/dev/null
  echo
  echo "== Snapshots (cuestan ~\$0.05/GB-mes)"
  gcloud compute snapshots list --project="$PROYECTO" --format="table(name,diskSizeGb,storageBytes.size(units_out=G))" 2>/dev/null
  echo
  echo "== NAT y router"
  gcloud compute routers list --project="$PROYECTO" --format="table(name,region.basename(),network.basename())" 2>/dev/null
  echo
  echo "== GPUs en uso"
  gcloud compute regions describe "$REGION" --project="$PROYECTO" --format=json 2>/dev/null \
    | python3 -c '
import json, sys
try:
    cuotas = json.load(sys.stdin).get("quotas") or []
except Exception:
    sys.exit(0)
for q in cuotas:
    if "GPU" in q.get("metric", "") and q.get("usage", 0) > 0:
        print("  %s: %g/%g" % (q["metric"], q["usage"], q["limit"]))
' || true
}

leer_instancias || fallar "gcloud no pudo listar las VMs de $PROYECTO: $INSTANCIAS_ERROR"

case "$ACCION" in
  status | estado) estado ;;

  stop)
    alguna=0
    for vm in $GPUS; do
      zona=$(zona_de "$vm")
      if [ -z "$zona" ]; then
        info "no existe la VM $vm (se omite)"
        continue
      fi
      alguna=1
      if esta_encendida "$(estado_de "$vm")"; then
        gcloud compute instances stop "$vm" --zone="$zona" --project="$PROYECTO" --quiet &&
          ok "$vm apagada"
      else
        ok "$vm ya estaba apagada ($(estado_de "$vm"))"
      fi
    done
    [ "$alguna" = 1 ] || info "no hay ninguna GPU de la lista ($GPUS)"
    echo
    echo "OJO: los discos de arranque siguen facturando."
    echo "Para ausencias de mas de unos dias usa:  bash deploy/gcp/teardown.sh destroy"
    ;;

  destroy)
    A_BORRAR=""
    for vm in $GPUS; do
      [ -n "$(zona_de "$vm")" ] && A_BORRAR="$A_BORRAR $vm"
    done
    A_BORRAR="${A_BORRAR# }"
    if [ -n "$A_BORRAR" ]; then
      echo "Se borraran estas VMs con sus discos: $A_BORRAR"
      case " $A_BORRAR " in
        *" adaceen-worker "*) echo "  (incluye la L4, adaceen-worker: su disco es el origen de clone-worker.sh; el snapshot se conserva. Para borrar solo una: NOMBRE=<vm>)" ;;
      esac
      if [ "${CONFIRMAR:-0}" != 1 ]; then
        if [ ! -t 0 ]; then
          fallar "destroy borra VMs y discos: confirma con CONFIRMAR=1 (o correlo en una terminal)"
        fi
        read -r -p "Escribe BORRAR para confirmar: " respuesta || respuesta=""
        [ "$respuesta" = "BORRAR" ] || fallar "cancelado: no se borro nada"
      fi
      for vm in $A_BORRAR; do
        if gcloud compute instances delete "$vm" --zone="$(zona_de "$vm")" --project="$PROYECTO" --quiet; then
          ok "$vm borrada"
        else
          aviso "no se pudo borrar $vm"
        fi
      done
    else
      info "no queda ninguna GPU de la lista ($GPUS)"
    fi

    # El NAT solo se borra si ya nadie sale por el: quedan VMs en la region (por
    # ejemplo la de editores, que no tiene IP publica) -> se conserva.
    leer_instancias || true
    RESTANTES=$(printf '%s\n' "$INSTANCIAS" | awk -v r="$REGION-" 'NF >= 2 && index($2, r) == 1 {print $1}' | tr '\n' ' ')
    RESTANTES="${RESTANTES% }"
    if [ -n "$RESTANTES" ]; then
      info "se conservan el NAT $NAT y el router $ROUTER: los usa $RESTANTES"
    else
      echo "Borrando NAT y router (ya no queda ninguna VM en $REGION)."
      gcloud compute routers nats delete "$NAT" --router="$ROUTER" --region="$REGION" --project="$PROYECTO" --quiet 2>/dev/null \
        || echo "  (el NAT ya no estaba)"
      gcloud compute routers delete "$ROUTER" --region="$REGION" --project="$PROYECTO" --quiet 2>/dev/null \
        || echo "  (el router ya no estaba)"
    fi
    echo
    echo "Verificacion:"
    estado
    echo
    echo "Si arriba no aparece ninguna VM de GPU ni su disco, el gasto de las GPU quedo en cero."
    echo "Para volver:  bash deploy/gcp/create-vm.sh l4   (unos 12 min, reinstala el driver; crea el NAT si falta)"
    echo "              bash deploy/gcp/clone-worker.sh v100   (y a100, desde el snapshot)"
    ;;

  *) echo "uso: bash deploy/gcp/teardown.sh [status|stop|destroy]"; exit 1 ;;
esac
