#!/usr/bin/env bash
# Sube deploy/gcp/startup-script.sh a la metadata de cada VM de GPU.
#
# Cada VM corre la copia del startup-script que guarda en su metadata, no la
# del repositorio: un arreglo del script (rotacion del log, apagado por
# inactividad, cambio de rama) no llega a las GPU ya creadas hasta subirlo.
# Surte efecto en el proximo arranque (bash deploy/clase.sh iniciar); no
# enciende ni reinicia nada. Se puede correr las veces que haga falta.
#
# Latido: las copias A100/V100 hechas con el clone-worker.sh anterior no
# traian heartbeat-url ni heartbeat-token, y sin latido ni deploy/clase.sh ni
# /api/agent/health las ven. Si a una GPU le faltan y otra de la lista los
# tiene, se copian (por archivo: los valores nunca se muestran).
# Rama: esas copias tampoco traian la metadata branch. Sin RAMA, a la GPU que
# no la tenga se le copia la de otra GPU de la lista (la de la L4, de cuyo
# disco salio); si ninguna la tiene, el arranque sigue en la rama que ya tiene
# su clon. Al final se muestra la rama que usara cada VM.
#
#   bash deploy/gcp/actualizar-gpus.sh
#   RAMA=feature/azure-config-observability bash deploy/gcp/actualizar-gpus.sh   # la misma rama en todas
#
# Variables: GPUS (defecto: adaceen-worker-v100 adaceen-worker-a100 adaceen-worker),
# PROYECTO, RAMA (la metadata branch: rama de PDC que clona el arranque; tiene
# que tener el worker con latido, A15.4).
set -euo pipefail

DIR_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/comun-gcp.sh
. "$DIR_SCRIPT/comun-gcp.sh"
requiere_gcloud

PROYECTO=$(resolver_proyecto)
GPUS=${GPUS:-$GPUS_POR_DEFECTO}
RAMA=${RAMA:-}
STARTUP="$DIR_SCRIPT/startup-script.sh"
[ -f "$STARTUP" ] || fallar "no encuentro $STARTUP"
if [ -n "$RAMA" ] && ! [[ $RAMA =~ ^[A-Za-z0-9._/-]{1,200}$ ]]; then
  fallar "RAMA tiene caracteres no validos: $RAMA"
fi

leer_instancias || fallar "gcloud no pudo listar las VMs de $PROYECTO: $INSTANCIAS_ERROR"

# Latido y rama de cada GPU a una carpeta privada: <vm>.heartbeat-url,
# <vm>.heartbeat-token y <vm>.branch.
META=$(mktemp -d "${TMPDIR:-/tmp}/adaceen-meta.XXXXXX")
chmod 700 "$META"
trap 'rm -rf "$META"' EXIT
DONANTE=""
DONANTE_RAMA=""
for vm in $GPUS; do
  zona=$(zona_de "$vm")
  [ -n "$zona" ] || continue
  gcloud compute instances describe "$vm" --zone="$zona" --project="$PROYECTO" --format=json 2>/dev/null |
    python3 -c '
import json, os, sys
try:
    items = (json.load(sys.stdin).get("metadata") or {}).get("items") or []
except Exception:
    sys.exit(0)
for item in items:
    clave = item.get("key")
    if clave in ("heartbeat-url", "heartbeat-token", "branch") and str(item.get("value", "")).strip():
        valor = str(item["value"])
        with open(os.path.join(sys.argv[1], sys.argv[2] + "." + clave), "w") as f:
            f.write(valor.strip() if clave == "branch" else valor)
' "$META" "$vm" || true
  if [ -z "$DONANTE" ] && [ -s "$META/$vm.heartbeat-url" ] && [ -s "$META/$vm.heartbeat-token" ]; then
    DONANTE="$vm"
  fi
  if [ -z "$DONANTE_RAMA" ] && [ -s "$META/$vm.branch" ] && [[ $(cat "$META/$vm.branch") =~ ^[A-Za-z0-9._/-]{1,200}$ ]]; then
    DONANTE_RAMA="$vm"
  fi
done

actualizadas=0
fallidas=0
for vm in $GPUS; do
  zona=$(zona_de "$vm")
  if [ -z "$zona" ]; then
    info "no existe la VM $vm en $PROYECTO (se omite)"
    continue
  fi
  desde_archivo="startup-script=$STARTUP"
  extra=""
  if [ ! -s "$META/$vm.heartbeat-token" ]; then
    if [ -n "$DONANTE" ]; then
      desde_archivo="$desde_archivo,heartbeat-url=$META/$DONANTE.heartbeat-url,heartbeat-token=$META/$DONANTE.heartbeat-token"
      extra=", latido copiado de $DONANTE"
    else
      aviso "$vm no tiene heartbeat-token y ninguna GPU de la lista lo tiene: sin latido, deploy/clase.sh no la vera (ver create-vm.sh)"
    fi
  fi
  # Rama con la que arrancara (la metadata branch; sin ella, la de su clon).
  if [ -n "$RAMA" ]; then
    rama_txt="rama $RAMA"
  elif [ -s "$META/$vm.branch" ]; then
    rama_txt="rama $(cat "$META/$vm.branch")"
  elif [ -n "$DONANTE_RAMA" ]; then
    desde_archivo="$desde_archivo,branch=$META/$DONANTE_RAMA.branch"
    rama_txt="rama $(cat "$META/$DONANTE_RAMA.branch") (copiada de $DONANTE_RAMA)"
  else
    rama_txt="sin metadata branch: sigue en la rama que ya tiene su clon"
    aviso "$vm no tiene metadata branch y ninguna GPU de la lista la tiene: arrancara con la rama de su clon (para fijarla: RAMA=<rama> bash deploy/gcp/actualizar-gpus.sh)"
  fi
  if [ -n "$RAMA" ]; then
    salida=$(gcloud compute instances add-metadata "$vm" --zone="$zona" --project="$PROYECTO" \
      --metadata-from-file="$desde_archivo" --metadata=branch="$RAMA" 2>&1) && r=0 || r=$?
  else
    salida=$(gcloud compute instances add-metadata "$vm" --zone="$zona" --project="$PROYECTO" \
      --metadata-from-file="$desde_archivo" 2>&1) && r=0 || r=$?
  fi
  if [ "$r" = 0 ]; then
    ok "$vm ($zona): startup-script al dia, $rama_txt$extra"
    actualizadas=$((actualizadas + 1))
  else
    aviso "$vm: no se pudo actualizar: $(printf '%s\n' "$salida" | tail -n 1 | cut -c1-300)"
    fallidas=$((fallidas + 1))
  fi
done
info "$actualizadas VM(s) actualizadas. Toman el cambio en su proximo arranque (bash deploy/clase.sh iniciar)."
[ "$fallidas" = 0 ] || exit 1
