#!/usr/bin/env bash
# Examen del 28-10-2026 (FPOO-01, 8:00-11:00): prepara Google Cloud para ~40 estudiantes a la vez.
#
#   bash deploy/gcp/preparar-examen.sh antes     VM de editores a $TIPO_EXAMEN (defecto e2-standard-16:
#                                                16 vCPU, 64 GB) y revisa que la V100 este en modo
#                                                clase (estandar, no Spot). No enciende nada mas.
#   bash deploy/gcp/preparar-examen.sh despues   devuelve la VM de editores a $TIPO_NORMAL
#                                                (defecto e2-standard-4) y la deja apagada.
#   bash deploy/gcp/preparar-examen.sh estado    solo muestra tipo y estado (no cambia nada).
#
# Por que: la VM de editores (adaceen-ws) es e2-standard-4 (4 vCPU, 16 GB, sin swap). Cada estudiante
# abre su propio servidor de VS Code con la extension de C/C++ (~0,5-1 GB en uso); con 40 a la vez no
# alcanza la memoria. Cambiar el tipo exige apagarla un momento: cierra los editores abiertos, que
# vuelven al arrancar (los proyectos de los estudiantes quedan en el disco).
#
# Despues de «antes», a las 7:00 del dia del examen: bash deploy/clase.sh iniciar (o ADACEEN-GPU.bat,
# opcion C y luego 1). Costo extra aproximado: ~0,40 USD por hora encendida frente al tipo normal.
#
# Variables: PROYECTO, VM_EDITORES (adaceen-ws), GPU_CLASE (adaceen-worker-v100), TIPO_EXAMEN, TIPO_NORMAL.
set -euo pipefail

DIR_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/comun-gcp.sh
. "$DIR_SCRIPT/comun-gcp.sh"
requiere_gcloud

ACCION="${1:-}"
case "$ACCION" in antes | despues | estado) ;; *)
  sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1 ;;
esac

PROYECTO=$(resolver_proyecto)
VM=${VM_EDITORES:-$VM_EDITORES_POR_DEFECTO}
GPU=${GPU_CLASE:-adaceen-worker-v100}
TIPO_EXAMEN=${TIPO_EXAMEN:-e2-standard-16}
TIPO_NORMAL=${TIPO_NORMAL:-e2-standard-4}
[[ $TIPO_EXAMEN =~ ^[a-z0-9-]+$ && $TIPO_NORMAL =~ ^[a-z0-9-]+$ ]] || fallar "tipo de maquina no valido"

leer_instancias || fallar "no pude listar las VMs de $PROYECTO: $INSTANCIAS_ERROR"
ZONA=$(zona_de "$VM")
[ -n "$ZONA" ] || fallar "no encuentro la VM $VM en $PROYECTO"

tipo_de() {
  gcloud compute instances describe "$1" --zone="$2" --project="$PROYECTO" --format='value(machineType.basename())'
}
modelo_de() {
  gcloud compute instances describe "$1" --zone="$2" --project="$PROYECTO" --format='value(scheduling.provisioningModel)'
}

mostrar() {
  info "$VM: $(estado_de "$VM"), $(tipo_de "$VM" "$ZONA") ($ZONA)"
  local zona_gpu
  zona_gpu=$(zona_de "$GPU")
  if [ -n "$zona_gpu" ]; then
    info "$GPU: $(estado_de "$GPU"), $(modelo_de "$GPU" "$zona_gpu") ($zona_gpu)"
  else
    aviso "no encuentro la GPU $GPU"
  fi
}

cambiar_tipo() {
  local destino="$1" actual estado
  actual=$(tipo_de "$VM" "$ZONA")
  estado=$(estado_de "$VM")
  if [ "$actual" = "$destino" ]; then
    ok "$VM ya es $destino"
    return 0
  fi
  info "$VM: $actual -> $destino (la apago un momento)"
  if esta_encendida "$estado"; then
    gcloud compute instances stop "$VM" --zone="$ZONA" --project="$PROYECTO" --quiet
  fi
  gcloud compute instances set-machine-type "$VM" --zone="$ZONA" --project="$PROYECTO" --machine-type="$destino"
  ok "$VM ahora es $destino"
  if esta_encendida "$estado"; then
    gcloud compute instances start "$VM" --zone="$ZONA" --project="$PROYECTO" --quiet
    ok "$VM encendida otra vez"
  fi
}

case "$ACCION" in
  estado)
    mostrar
    ;;
  antes)
    cambiar_tipo "$TIPO_EXAMEN"
    zona_gpu=$(zona_de "$GPU")
    if [ -n "$zona_gpu" ] && [ "$(modelo_de "$GPU" "$zona_gpu")" = "SPOT" ]; then
      aviso "$GPU esta en Spot: Google la puede apagar en pleno examen. Pasala a modo clase con ADACEEN-GPU.bat (opcion C) antes de encenderla."
    else
      ok "$GPU en modo clase (estandar)"
    fi
    mostrar
    info "A las 7:00 del examen: bash deploy/clase.sh iniciar"
    ;;
  despues)
    cambiar_tipo "$TIPO_NORMAL"
    if esta_encendida "$(estado_de "$VM")"; then
      info "Para apagar todo: bash deploy/clase.sh terminar"
    fi
    mostrar
    ;;
esac
