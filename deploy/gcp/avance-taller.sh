#!/usr/bin/env bash
# Avance de los estudiantes en los talleres (29-10-2026; el primero, el Sistema bancario).
#
#   bash deploy/gcp/avance-taller.sh activar      sube el arranque nuevo a la VM de editores (aplica al encenderla)
#   bash deploy/gcp/avance-taller.sh estado       ultimo calculo en la VM y lo que vio el backend (no cambia nada)
#   bash deploy/gcp/avance-taller.sh ahora        calcula ya, sin esperar los 10 min (la VM tiene que estar encendida)
#   bash deploy/gcp/avance-taller.sh desactivar   metadata avance=off (deja de calcular en el proximo encendido)
#
# En la VM, avance-ws.py revisa cada 10 min la carpeta del taller (deploy/gcp/workspaces/talleres/*.json)
# en el home de cada estudiante: clases, atributos, metodos con cuerpo, herencia, main y si compila
# (como el estudiante, sin ejecutar nada). Al backend solo van el porcentaje y lo que falta, nunca
# el codigo; el docente lo ve en el monitor (/docente/monitor). No necesita bucket ni permisos nuevos.
#
# Lo instala el startup-ws.sh de la rama de despliegue, pero la VM corre el arranque que tiene en
# su metadata: activar lo sube. Si ya corriste `respaldos.sh activar` con esta rama, ya quedo.
#
# Variables: PROYECTO, VM_EDITORES (adaceen-ws), BACKEND.
set -euo pipefail

DIR_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/comun-gcp.sh
. "$DIR_SCRIPT/comun-gcp.sh"

ACCION="${1:-}"
case "$ACCION" in activar | estado | ahora | desactivar) ;; *)
  sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1 ;;
esac

requiere_gcloud
PROYECTO=$(resolver_proyecto)
VM=${VM_EDITORES:-$VM_EDITORES_POR_DEFECTO}
BACKEND=${BACKEND:-$BACKEND_PRODUCCION}
leer_instancias || fallar "gcloud no pudo listar las VMs de $PROYECTO: $INSTANCIAS_ERROR"
ZONA=$(zona_de "$VM")
[ -n "$ZONA" ] || fallar "no encuentro la VM $VM en $PROYECTO (¿otro proyecto? PROYECTO=<id>)"
ESTADO=$(estado_de "$VM")

ssh_vm() {
  gcloud compute ssh "$VM" --zone="$ZONA" --project="$PROYECTO" --tunnel-through-iap --quiet "$@"
}

visto_por_el_backend() {
  local salud
  salud=$(curl -fsS --max-time 15 "$BACKEND/api/health" 2>/dev/null || true)
  [ -n "$salud" ] || { info "no pude leer $BACKEND/api/health"; return 0; }
  printf '%s' "$salud" | python3 -c 'import json,sys
w=json.load(sys.stdin).get("workshop_progress")
if not w:
    print("[adaceen] el backend todavia no informa el avance (despliega la rama con el avance)")
elif not w.get("last_at"):
    print("[adaceen] el backend no ha recibido ningun informe de avance todavia")
else:
    print("[adaceen] ultimo informe que vio el backend: %s, taller %s, %s estudiantes, %s con la carpeta" % (w["last_at"], w.get("taller"), w.get("students"), w.get("started")))' || true
}

case "$ACCION" in
  activar)
    gcloud compute instances remove-metadata "$VM" --zone="$ZONA" --project="$PROYECTO" --keys=avance --quiet >/dev/null 2>&1 || true
    subir_startup_ws "$VM" "$ZONA" "$PROYECTO"
    ok "startup-script de $VM al dia con esta rama"
    if esta_encendida "$ESTADO"; then
      info "La VM esta $ESTADO: el avance se instala en su proximo encendido. Para no esperar, cuando no haya"
      info "nadie conectado: bash deploy/clase.sh terminar y luego bash deploy/clase.sh iniciar (o apagala y enciendela)."
    else
      ok "se instala al encender la VM (bash deploy/clase.sh iniciar)"
    fi
    ;;
  estado)
    info "VM $VM ($ZONA): $ESTADO"
    if esta_encendida "$ESTADO"; then
      ssh_vm --command='systemctl is-active adaceen-ws-avance.timer >/dev/null 2>&1 && echo "[adaceen] timer activo (cada 10 min)" || echo "[adaceen] AVISO: sin timer adaceen-ws-avance (bash deploy/gcp/avance-taller.sh activar y reinicia la VM)"; sudo journalctl -u adaceen-ws-avance.service -n 4 --no-pager -o cat 2>/dev/null || true'
    fi
    visto_por_el_backend
    ;;
  ahora)
    esta_encendida "$ESTADO" || fallar "la VM $VM esta $ESTADO: enciendela primero (bash deploy/clase.sh iniciar)"
    ssh_vm --command='sudo systemctl start adaceen-ws-avance.service && sudo journalctl -u adaceen-ws-avance.service -n 3 --no-pager -o cat'
    visto_por_el_backend
    ;;
  desactivar)
    gcloud compute instances add-metadata "$VM" --zone="$ZONA" --project="$PROYECTO" --metadata=avance=off --quiet >/dev/null
    ok "metadata avance=off: la VM deja de calcular el avance en su proximo encendido"
    ;;
esac
