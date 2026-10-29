#!/usr/bin/env bash
# Horario del tutor (28-10-2026): la GPU encendida de 6 a. m. a 11 p. m.; de noche, el backend la
# enciende si un estudiante pide ayuda (GPU_AUTOSTART) y se apaga sola tras 60 min sin trabajos.
#
#   bash deploy/gcp/horario-gpu.sh activar      programa el encendido y el apagado, sube el startup-script
#                                               con el apagado nocturno y lo aplica ya si la GPU esta encendida
#   bash deploy/gcp/horario-gpu.sh estado       muestra lo que hay (no cambia nada)
#   bash deploy/gcp/horario-gpu.sh desactivar   quita la programacion y el horario (vuelve el apagado
#                                               por inactividad de siempre)
#
# Que hace activar, en orden (se puede repetir: lo que ya esta queda igual):
#   1. Da al agente de servicio de Compute Engine (service-<numero>@compute-system...) el rol
#      roles/compute.instanceAdmin.v1: sin el, Google no puede encender ni apagar la VM con la
#      programacion.
#   2. Crea la programacion de instancias $POLITICA (encender a la hora de inicio, apagar a la de
#      fin, en $ZONA_HORARIA) y se la pone a la GPU. Si ya existia con otras horas, la rehace.
#   3. Metadata de la GPU: horario, zona-horaria e idle-minutes-noche, y el startup-script del
#      repositorio (actualizar-gpus.sh). De dia el apagado por inactividad no corre.
#   4. Si la GPU esta encendida, aplica el apagado nuevo ya (por ssh, sin reiniciarla).
#   5. Azure: GPU_SCHEDULE, GPU_SCHEDULE_TZ y GPU_AUTOSTART=on. Con RG y la CLI de Azure (az) lo
#      carga; si no, imprime el comando. El encendido de noche usa las credenciales y CLASS_GPU_VMS
#      de «Iniciar clase» (crear-cuenta-autoencendido.sh o crear-federacion-autoencendido.sh).
#
# Variables: PROYECTO, GPU (adaceen-worker, la L4), HORARIO (06:00-23:00), ZONA_HORARIA
# (America/Bogota), MINUTOS_NOCHE (60), POLITICA (adaceen-gpu-horario), RG y APP (App Service),
# BACKEND (para leer /api/health).
set -euo pipefail

DIR_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/comun-gcp.sh
. "$DIR_SCRIPT/comun-gcp.sh"

ACCION="${1:-}"
case "$ACCION" in activar | estado | desactivar) ;; *)
  sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1 ;;
esac

requiere_gcloud
PROYECTO=$(resolver_proyecto)
GPU=${GPU:-adaceen-worker}
HORARIO=${HORARIO:-06:00-23:00}
ZONA_HORARIA=${ZONA_HORARIA:-America/Bogota}
MINUTOS_NOCHE=${MINUTOS_NOCHE:-60}
POLITICA=${POLITICA:-adaceen-gpu-horario}
APP=${APP:-app-adaceen-api-eyder05232002}
RG=${RG:-}
BACKEND=${BACKEND:-$BACKEND_PRODUCCION}

[[ $GPU =~ ^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || fallar "GPU no es un nombre de VM valido: $GPU"
[[ $POLITICA =~ ^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || fallar "POLITICA no es un nombre valido: $POLITICA"
[[ $HORARIO =~ ^([01][0-9]|2[0-3]):([0-5][0-9])-([01][0-9]|2[0-4]):([0-5][0-9])$ ]] || fallar "HORARIO tiene que ser HH:MM-HH:MM, por ejemplo 06:00-23:00"
INICIO_H=${BASH_REMATCH[1]}; INICIO_M=${BASH_REMATCH[2]}; FIN_H=${BASH_REMATCH[3]}; FIN_M=${BASH_REMATCH[4]}
[ $((10#$FIN_H * 60 + 10#$FIN_M)) -gt $((10#$INICIO_H * 60 + 10#$INICIO_M)) ] || fallar "HORARIO: la hora de fin tiene que ser despues de la de inicio"
[[ $ZONA_HORARIA =~ ^[A-Za-z_]+(/[A-Za-z_+-]+)*$ ]] || fallar "ZONA_HORARIA no es valida: $ZONA_HORARIA"
[[ $MINUTOS_NOCHE =~ ^[0-9]{2,4}$ ]] && [ "$((10#$MINUTOS_NOCHE))" -ge 15 ] || fallar "MINUTOS_NOCHE tiene que ser 15 o mas"
# Cron de la programacion: "MM HH * * *" (24:00 es la medianoche: 0 0).
CRON_INICIO="$((10#$INICIO_M)) $((10#$INICIO_H)) * * *"
CRON_FIN="$((10#$FIN_M)) $((10#$FIN_H % 24)) * * *"

leer_instancias || fallar "gcloud no pudo listar las VMs de $PROYECTO: $INSTANCIAS_ERROR"
ZONA=$(zona_de "$GPU")
[ -n "$ZONA" ] || fallar "no encuentro la GPU $GPU en $PROYECTO (¿otro proyecto? PROYECTO=<id> o GPU=<vm>)"
REGION=$(region_de_zona "$ZONA")
ESTADO=$(estado_de "$GPU")

meta_de() {
  gcloud compute instances describe "$GPU" --zone="$ZONA" --project="$PROYECTO" --format=json 2>/dev/null |
    python3 -c 'import json,sys
d=json.load(sys.stdin)
print(next((i.get("value","") for i in (d.get("metadata") or {}).get("items") or [] if i.get("key")==sys.argv[1]), ""))' "$1" 2>/dev/null || true
}
politicas_de_gpu() {
  gcloud compute instances describe "$GPU" --zone="$ZONA" --project="$PROYECTO" --format='value(resourcePolicies)' 2>/dev/null || true
}
tiene_politica() { politicas_de_gpu | tr ';,' '\n\n' | grep -q "/$POLITICA\$"; }
programacion_actual() {
  gcloud compute resource-policies describe "$POLITICA" --region="$REGION" --project="$PROYECTO" \
    --format='value(instanceSchedulePolicy.vmStartSchedule.schedule,instanceSchedulePolicy.vmStopSchedule.schedule,instanceSchedulePolicy.timeZone)' 2>/dev/null || true
}
agente_compute() {
  local numero
  numero=$(gcloud projects describe "$PROYECTO" --format='value(projectNumber)' 2>/dev/null || true)
  [ -n "$numero" ] && printf 'service-%s@compute-system.iam.gserviceaccount.com\n' "$numero"
}
mostrar_backend() {
  local salud
  salud=$(curl -fsS --max-time 15 "$BACKEND/api/health" 2>/dev/null || true)
  if [ -z "$salud" ]; then
    aviso "no pude leer $BACKEND/api/health"
    return 0
  fi
  printf '%s' "$salud" | python3 -c 'import json,sys
h=json.load(sys.stdin).get("gpu_autostart") or {}
if not h:
    print("[adaceen] el backend todavia no informa el horario (despliega la rama con el horario del tutor)")
    sys.exit(0)
print("[adaceen] backend: horario %s (%s), encendido de noche %s, ahora %s" % (h.get("schedule") or "sin GPU_SCHEDULE", h.get("timezone") or "-", "activo" if h.get("enabled") else "apagado (GPU_AUTOSTART)", "dentro del horario" if h.get("within_schedule") else "fuera del horario"))
a=h.get("last_attempt")
print("[adaceen] ultimo intento de encendido: %s" % (("%s, %s: %s" % (a.get("at"), "encendiendo " + (a.get("vm") or "") if a.get("ok") else "fallo", a.get("detail"))) if a else "ninguno desde que arranco el backend"))' || true
}

estado() {
  info "proyecto $PROYECTO; GPU $GPU ($ZONA): $ESTADO"
  local prog
  prog=$(programacion_actual)
  if [ -n "$prog" ]; then
    info "programacion $POLITICA: $(printf '%s' "$prog" | tr '\t' ' ')"
    if tiene_politica; then ok "la GPU tiene la programacion"; else aviso "la programacion existe pero la GPU no la tiene (bash deploy/gcp/horario-gpu.sh activar)"; fi
  else
    info "sin programacion $POLITICA en $REGION"
  fi
  local h z n
  h=$(meta_de horario); z=$(meta_de zona-horaria); n=$(meta_de idle-minutes-noche)
  if [ -n "$h" ]; then
    info "metadata: horario $h (${z:-America/Bogota}); de noche se apaga tras ${n:-60} min sin trabajos"
  else
    info "metadata: sin horario (apagado por inactividad de siempre: idle-minutes $(meta_de idle-minutes || true))"
  fi
  local agente
  agente=$(agente_compute || true)
  if [ -n "$agente" ] && gcloud projects get-iam-policy "$PROYECTO" --format=json 2>/dev/null | grep -q "serviceAccount:$agente"; then
    ok "el agente de Compute Engine tiene permisos en el proyecto"
  else
    aviso "no veo al agente de Compute Engine ($agente) en la politica del proyecto: la programacion no podra encender ni apagar la GPU"
  fi
  if gcloud compute instances get-iam-policy "$GPU" --zone="$ZONA" --project="$PROYECTO" --format=json 2>/dev/null | grep -q "adaceen-autoencendido@"; then
    ok "la cuenta del autoencendido puede encender $GPU (encendido de noche desde el backend)"
  else
    aviso "la cuenta adaceen-autoencendido no tiene permiso sobre $GPU: de noche el backend no podra encenderla (GPUS=$GPU bash deploy/gcp/crear-cuenta-autoencendido.sh --sin-clave)"
  fi
  mostrar_backend
}

# Aplica el apagado nuevo en la GPU encendida, sin reiniciarla: carga su startup-script (ya
# actualizado en la metadata) con source y llama instalar_apagado_por_inactividad.
aplicar_en_vivo() {
  local salida
  if salida=$(gcloud compute ssh "$GPU" --zone="$ZONA" --project="$PROYECTO" --tunnel-through-iap --quiet \
    --command="sudo bash -s -- '$HORARIO' '$ZONA_HORARIA' '$MINUTOS_NOCHE'" 2>&1 <<'REMOTO'
set -eu
tmp=$(mktemp)
curl -sf -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/attributes/startup-script >"$tmp"
# shellcheck disable=SC1090
source "$tmp"
rm -f "$tmp"
fuente=$(sed -n 's/^FUENTE=//p' /usr/local/bin/adaceen-idle-check 2>/dev/null || true)
[ -n "$fuente" ] || fuente=/var/log/adaceen-worker.log
minutos=$(sed -n 's/^IDLE_MINUTES=//p' /usr/local/bin/adaceen-idle-check 2>/dev/null | head -n 1 || true)
instalar_apagado_por_inactividad "${minutos:-30}" "$fuente" "$1" "$2" "$3"
echo "apagado por inactividad: horario $1 ($2), $3 min de noche"
REMOTO
  ); then
    ok "aplicado en $GPU sin reiniciarla: $(printf '%s\n' "$salida" | tail -n 1)"
  else
    aviso "no pude entrar por ssh a $GPU ($(printf '%s\n' "$salida" | tail -n 1 | cut -c1-200)); el horario se aplica en su proximo arranque"
  fi
}

activar() {
  info "proyecto $PROYECTO; GPU $GPU ($ZONA, $ESTADO); horario $HORARIO ($ZONA_HORARIA); de noche se apaga tras $MINUTOS_NOCHE min sin trabajos"

  # 1. El agente de Compute Engine enciende y apaga con la programacion.
  local agente
  agente=$(agente_compute || true)
  if [ -z "$agente" ]; then
    aviso "no pude leer el numero del proyecto: da roles/compute.instanceAdmin.v1 al agente de Compute Engine a mano"
  elif gcloud projects add-iam-policy-binding "$PROYECTO" --member="serviceAccount:$agente" \
      --role=roles/compute.instanceAdmin.v1 --condition=None --quiet >/dev/null 2>&1; then
    ok "el agente de Compute Engine puede encender y apagar la GPU con la programacion"
  else
    aviso "no pude dar el rol al agente de Compute Engine. Pidelo a quien administra el proyecto:"
    aviso "  gcloud projects add-iam-policy-binding $PROYECTO --member=serviceAccount:$agente --role=roles/compute.instanceAdmin.v1"
  fi

  # 2. La programacion de instancias (inmutable: si cambian las horas, se rehace).
  local actual quiero
  actual=$(programacion_actual)
  quiero="$(printf '%s\t%s\t%s' "$CRON_INICIO" "$CRON_FIN" "$ZONA_HORARIA")"
  if [ -n "$actual" ] && [ "$actual" != "$quiero" ]; then
    info "la programacion $POLITICA tiene otras horas ($(printf '%s' "$actual" | tr '\t' ' ')): la rehago"
    if tiene_politica; then
      gcloud compute instances remove-resource-policies "$GPU" --zone="$ZONA" --project="$PROYECTO" --resource-policies="$POLITICA" --quiet
    fi
    gcloud compute resource-policies delete "$POLITICA" --region="$REGION" --project="$PROYECTO" --quiet
    actual=""
  fi
  if [ -z "$actual" ]; then
    gcloud compute resource-policies create instance-schedule "$POLITICA" --region="$REGION" --project="$PROYECTO" \
      --vm-start-schedule="$CRON_INICIO" --vm-stop-schedule="$CRON_FIN" --timezone="$ZONA_HORARIA" \
      --description="ADACEEN: tutor de $HORARIO ($ZONA_HORARIA)" --quiet
    ok "programacion $POLITICA creada: enciende $CRON_INICIO y apaga $CRON_FIN ($ZONA_HORARIA)"
  else
    ok "programacion $POLITICA ya estaba con esas horas"
  fi
  if tiene_politica; then
    ok "$GPU ya tenia la programacion"
  else
    gcloud compute instances add-resource-policies "$GPU" --zone="$ZONA" --project="$PROYECTO" --resource-policies="$POLITICA" --quiet
    ok "$GPU queda con la programacion"
  fi

  # 3. Metadata y startup-script con el apagado nocturno.
  gcloud compute instances add-metadata "$GPU" --zone="$ZONA" --project="$PROYECTO" \
    --metadata="horario=$HORARIO,zona-horaria=$ZONA_HORARIA,idle-minutes-noche=$MINUTOS_NOCHE" --quiet >/dev/null
  ok "metadata: horario $HORARIO, zona-horaria $ZONA_HORARIA, idle-minutes-noche $MINUTOS_NOCHE"
  GPUS="$GPU" bash "$DIR_SCRIPT/actualizar-gpus.sh"

  # 4. Encendida: el apagado nuevo ya, sin reiniciar.
  if esta_encendida "$ESTADO"; then
    aplicar_en_vivo
  else
    info "$GPU esta $ESTADO: toma el horario en su proximo arranque (la programacion la enciende a las $INICIO_H:$INICIO_M)"
  fi

  # 5. Azure: el horario que muestra el backend y el encendido de noche.
  local ajustes="GPU_SCHEDULE=$HORARIO GPU_SCHEDULE_TZ=$ZONA_HORARIA GPU_AUTOSTART=on"
  if [ -n "$RG" ] && command -v az >/dev/null 2>&1; then
    # shellcheck disable=SC2086  # los ajustes van separados a proposito
    if az webapp config appsettings set --name "$APP" --resource-group "$RG" --settings $ajustes --output none; then
      ok "Azure: $ajustes (el App Service se reinicia, ~1 min)"
      local gpus
      gpus=$(az webapp config appsettings list --name "$APP" --resource-group "$RG" --query "[?name=='CLASS_GPU_VMS'].value" -o tsv 2>/dev/null || true)
      case ",$gpus," in
        *",$GPU:"*) ok "CLASS_GPU_VMS incluye $GPU" ;;
        *) aviso "CLASS_GPU_VMS ($gpus) no incluye $GPU: de noche el backend encenderia otra GPU o ninguna. Agregala: $GPU:$ZONA" ;;
      esac
    else
      aviso "no pude cargar los ajustes en Azure; hazlo a mano (abajo)"
    fi
  else
    info "Falta un ajuste en Azure (o corre esto con RG=rg-adaceen-azure y la CLI az):"
    info "  az webapp config appsettings set --name $APP --resource-group <grupo> --settings $ajustes"
    info "  y que CLASS_GPU_VMS incluya $GPU:$ZONA"
  fi
  echo
  estado
}

desactivar() {
  if tiene_politica; then
    gcloud compute instances remove-resource-policies "$GPU" --zone="$ZONA" --project="$PROYECTO" --resource-policies="$POLITICA" --quiet
    ok "$GPU ya no tiene la programacion $POLITICA"
  fi
  if [ -n "$(programacion_actual)" ]; then
    gcloud compute resource-policies delete "$POLITICA" --region="$REGION" --project="$PROYECTO" --quiet || aviso "no pude borrar $POLITICA (quiza la usa otra VM)"
  fi
  gcloud compute instances remove-metadata "$GPU" --zone="$ZONA" --project="$PROYECTO" --keys=horario,zona-horaria,idle-minutes-noche --quiet >/dev/null 2>&1 || true
  ok "sin horario: en su proximo arranque vuelve el apagado por inactividad de siempre"
  info "En Azure, para no encenderla de noche: az webapp config appsettings set --name $APP --resource-group <grupo> --settings GPU_AUTOSTART=off"
}

case "$ACCION" in
  activar) activar ;;
  estado) estado ;;
  desactivar) desactivar ;;
esac
