#!/usr/bin/env bash
# Horario del tutor (28-10-2026; varias GPU escalonadas desde el 1-11-2026): las GPU encendidas de
# 6 a. m. a 11 p. m.; de noche, el backend enciende una si un estudiante pide ayuda (GPU_AUTOSTART)
# y se apaga sola tras 60 min sin trabajos.
#
#   bash deploy/gcp/horario-gpu.sh activar      programa el encendido (escalonado) y el apagado de cada GPU,
#                                               sube el startup-script con el apagado nocturno y lo aplica
#                                               ya en las que estan encendidas
#   bash deploy/gcp/horario-gpu.sh estado       muestra lo que hay (no cambia nada)
#   bash deploy/gcp/horario-gpu.sh desactivar   quita las programaciones y el horario de todas las GPU
#                                               (vuelve el apagado por inactividad de siempre)
#
#   GPUS="adaceen-worker-c adaceen-worker-b adaceen-worker" RG=rg-adaceen-azure bash deploy/gcp/horario-gpu.sh activar
#
# Varias GPU y una sola cuota (incidente del 1-11-2026: la L4 y su copia encendian a las 6:00 en el
# mismo segundo; la copia ocupo el unico cupo de GPU mientras buscaba maquina y fallo por falta de
# L4 en la zona, la original fallo por cuota, y ninguna quedo encendida en todo el dia).
# GPUS es la lista en orden de preferencia (defecto: las de GPUS_POR_DEFECTO que existen en el
# proyecto; GPU=<una> sigue sirviendo). Con la cuota GPUS_ALL_REGIONS en 1 se escalonan: la 1.a
# enciende a la hora de inicio, cada siguiente DESFASE_MINUTOS (15) despues de la anterior, y todas
# se apagan a la hora de fin. Si la 1.a encendio, la 2.a recibe QUOTA_EXCEEDED y no pasa nada; si no
# hubo cupo para la 1.a, enciende la 2.a. Con cuota mayor que 1 (o si no se puede leer) solo se
# programa la 1.a, para no pagar dos GPU a la vez: el respaldo lo hace el backend cuando un
# estudiante pide ayuda (prueba CLASS_GPU_VMS en orden). ESCALONAR=si fuerza el escalonado y
# ESCALONAR=no programa solo la 1.a.
#
# Que hace activar, en orden (se puede repetir: lo que ya esta queda igual):
#   1. Da al agente de servicio de Compute Engine (service-<numero>@compute-system...) el rol
#      roles/compute.instanceAdmin.v1: sin el, Google no puede encender ni apagar las VMs con la
#      programacion.
#   2. Una programacion de instancias por GPU, en su region (son regionales): la 1.a $POLITICA, la
#      2.a $POLITICA-2, la 3.a $POLITICA-3... Son inmutables: si ya existe con otras horas, se
#      rehace. A cada VM le quita las otras $POLITICA* que tenga (la heredada de la imagen de
#      maquina, una puesta a mano) y borra las $POLITICA* de esas regiones que ya no usa ninguna VM.
#   3. Metadata de cada GPU: horario, zona-horaria e idle-minutes-noche, y el startup-script del
#      repositorio (actualizar-gpus.sh). De dia el apagado por inactividad no corre; de noche si.
#   4. En las GPU encendidas aplica el apagado nuevo ya (por ssh, sin reiniciarlas).
#   5. Azure: GPU_SCHEDULE, GPU_SCHEDULE_TZ, GPU_AUTOSTART=on y CLASS_GPU_VMS (las GPU de la lista,
#      nombre:zona, en el mismo orden), en UNA sola llamada (un solo reinicio del App Service, ~1
#      min) y solo lo que cambia. Con RG y la CLI de Azure (az) lo carga; si no, imprime el comando.
#      El encendido de noche usa las credenciales de «Iniciar clase» (crear-cuenta-autoencendido.sh
#      o crear-federacion-autoencendido.sh), que necesitan permiso sobre cada GPU.
#
# Variables: PROYECTO, GPUS (o GPU), HORARIO (06:00-23:00), DESFASE_MINUTOS (15), ESCALONAR (auto,
# si o no), ZONA_HORARIA (America/Bogota), MINUTOS_NOCHE (60), POLITICA (adaceen-gpu-horario), RG y
# APP (App Service), BACKEND (para leer /api/health).
set -euo pipefail

DIR_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/comun-gcp.sh
. "$DIR_SCRIPT/comun-gcp.sh"

ACCION="${1:-}"
case "$ACCION" in activar | estado | desactivar) ;; *)
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  echo "Mas detalle: la cabecera de deploy/gcp/horario-gpu.sh y docs/operacion/runbook.md (Horario del tutor)."
  exit 1 ;;
esac

requiere_gcloud
PROYECTO=$(resolver_proyecto)
GPU=${GPU:-}
GPUS_PEDIDAS=${GPUS:-$GPU}
HORARIO=${HORARIO:-06:00-23:00}
DESFASE_MINUTOS=${DESFASE_MINUTOS:-15}
ESCALONAR=${ESCALONAR:-auto}
ZONA_HORARIA=${ZONA_HORARIA:-America/Bogota}
MINUTOS_NOCHE=${MINUTOS_NOCHE:-60}
POLITICA=${POLITICA:-adaceen-gpu-horario}
APP=${APP:-app-adaceen-api-eyder05232002}
RG=${RG:-}
BACKEND=${BACKEND:-$BACKEND_PRODUCCION}
NOMBRE_VM_RE='^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$'
CUOTA=""
ESCALONADO=0

# POLITICA deja sitio para el sufijo -2, -3... (63 caracteres como maximo).
[[ $POLITICA =~ ^[a-z]([-a-z0-9]{0,56}[a-z0-9])?$ ]] || fallar "POLITICA no es un nombre valido (minusculas, numeros y guiones, hasta 58): $POLITICA"
[[ $HORARIO =~ ^([01][0-9]|2[0-3]):([0-5][0-9])-([01][0-9]|2[0-4]):([0-5][0-9])$ ]] || fallar "HORARIO tiene que ser HH:MM-HH:MM, por ejemplo 06:00-23:00"
INICIO_H=${BASH_REMATCH[1]}; INICIO_M=${BASH_REMATCH[2]}; FIN_H=${BASH_REMATCH[3]}; FIN_M=${BASH_REMATCH[4]}
INICIO_MIN=$((10#$INICIO_H * 60 + 10#$INICIO_M))
FIN_MIN=$((10#$FIN_H * 60 + 10#$FIN_M))
[ "$FIN_MIN" -gt "$INICIO_MIN" ] || fallar "HORARIO: la hora de fin tiene que ser despues de la de inicio"
[[ $ZONA_HORARIA =~ ^[A-Za-z_]+(/[A-Za-z_+-]+)*$ ]] || fallar "ZONA_HORARIA no es valida: $ZONA_HORARIA"
[[ $MINUTOS_NOCHE =~ ^[0-9]{2,4}$ ]] && [ "$((10#$MINUTOS_NOCHE))" -ge 15 ] || fallar "MINUTOS_NOCHE tiene que ser 15 o mas"
[[ $DESFASE_MINUTOS =~ ^[0-9]{1,3}$ ]] && [ "$((10#$DESFASE_MINUTOS))" -ge 1 ] || fallar "DESFASE_MINUTOS tiene que ser un numero de minutos, 1 o mas (defecto 15)"
DESFASE=$((10#$DESFASE_MINUTOS))
case "$ESCALONAR" in auto | si | no) ;; *) fallar "ESCALONAR tiene que ser auto, si o no" ;; esac
# Cron del apagado: "MM HH * * *" (24:00 es la medianoche: 0 0).
CRON_FIN="$((10#$FIN_M)) $((10#$FIN_H % 24)) * * *"

# "HH:MM" de unos minutos del dia; cron "M H * * *" de esos minutos; "HH:MM" de un cron.
hhmm() { printf '%02d:%02d' $(($1 / 60 % 24)) $(($1 % 60)); }
cron_de() { printf '%d %d * * *' $(($1 % 60)) $(($1 / 60 % 24)); }
hora_de_cron() { awk '{ if ($1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/) printf "%02d:%02d", $2, $1; else printf "%s", $0 }' <<<"$1"; }
FIN_TXT=$(hhmm "$FIN_MIN")

ERR=$(mktemp "${TMPDIR:-/tmp}/adaceen-horario.XXXXXX")
trap 'rm -f "$ERR"' EXIT

# ---------------------------------------------------------------- las GPU de la lista
leer_instancias || fallar "gcloud no pudo listar las VMs de $PROYECTO: $INSTANCIAS_ERROR"
avisar_repetidas
NOMBRES=()
ZONAS=()
REGIONES=()
ESTADOS=()
read -r -a LISTA <<<"${GPUS_PEDIDAS:-$GPUS_POR_DEFECTO}"
for vm in "${LISTA[@]}"; do
  [ "$vm" != "ninguna" ] || fallar "el horario necesita al menos una GPU (GPUS=<vm> o GPUS=\"<vm> <vm>\")"
  [[ $vm =~ $NOMBRE_VM_RE ]] || fallar "no es un nombre de VM valido: $vm"
  case " ${NOMBRES[*]} " in *" $vm "*) continue ;; esac
  zona=$(zona_de "$vm")
  if [ -z "$zona" ]; then
    if [ -n "$GPUS_PEDIDAS" ]; then aviso "no existe la GPU $vm en $PROYECTO (se omite)"; else info "no existe la GPU $vm en $PROYECTO (se omite)"; fi
    continue
  fi
  NOMBRES+=("$vm")
  ZONAS+=("$zona")
  REGIONES+=("$(region_de_zona "$zona")")
  ESTADOS+=("$(estado_de "$vm")")
done
[ "${#NOMBRES[@]}" -gt 0 ] || fallar "no encuentro ninguna de las GPU (${GPUS_PEDIDAS:-$GPUS_POR_DEFECTO}) en $PROYECTO (¿otro proyecto? PROYECTO=<id>, o GPUS=\"<vm> <vm>\")"
TOTAL=${#NOMBRES[@]}
# CLASS_GPU_VMS del backend: las mismas GPU, en el mismo orden.
CLASES=""
for i in "${!NOMBRES[@]}"; do CLASES="${CLASES:+$CLASES,}${NOMBRES[$i]}:${ZONAS[$i]}"; done

# ---------------------------------------------------------------- lecturas
# Cuota GPUS_ALL_REGIONS del proyecto (-1 si no se puede leer), como montar-cuenta-nueva.sh.
leer_cuota_gpu() {
  local json
  json=$(gcloud compute project-info describe --project="$PROYECTO" --format=json 2>/dev/null) || { echo -1; return 0; }
  printf '%s' "$json" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    print(next((int(float(q["limit"])) for q in d.get("quotas") or [] if q.get("metric") == "GPUS_ALL_REGIONS"), -1))
except Exception:
    print(-1)' 2>/dev/null || echo -1
}
cuota_txt() { if [ "$CUOTA" -ge 0 ]; then printf '%s' "$CUOTA"; else printf 'no se pudo leer'; fi; }

# Escalonado: con cuota 1 (o ESCALONAR=si) todas; si no, solo la primera.
decidir_escalonado() {
  case "$ESCALONAR" in
    si) ESCALONADO=1 ;;
    no) ESCALONADO=0 ;;
    *) if [ "$CUOTA" = 1 ]; then ESCALONADO=1; else ESCALONADO=0; fi ;;
  esac
}
# Programacion que le toca a la GPU i (0, 1...): nombre (vacio = ninguna) y minutos de encendido.
politica_de_indice() {
  if [ "$1" -gt 0 ] && [ "$ESCALONADO" = 0 ]; then return 0; fi
  if [ "$1" -eq 0 ]; then printf '%s' "$POLITICA"; else printf '%s-%d' "$POLITICA" $(($1 + 1)); fi
}
inicio_de_indice() { printf '%d' $((INICIO_MIN + $1 * DESFASE)); }

meta_de() { # vm zona clave
  gcloud compute instances describe "$1" --zone="$2" --project="$PROYECTO" --format=json 2>/dev/null |
    python3 -c 'import json,sys
d=json.load(sys.stdin)
print(next((i.get("value","") for i in (d.get("metadata") or {}).get("items") or [] if i.get("key")==sys.argv[1]), ""))' "$3" 2>/dev/null || true
}
# Programaciones de una VM cuyo nombre empieza por $POLITICA (una por linea).
politicas_de_vm() { # vm zona
  local salida
  salida=$(gcloud compute instances describe "$1" --zone="$2" --project="$PROYECTO" --format='value(resourcePolicies)' 2>/dev/null) || return 0
  printf '%s\n' "$salida" | tr ';,' '\n' | tr -d ' \t\r' | sed 's#.*/##' |
    awk -v p="$POLITICA" 'NF && index($0, p) == 1' || true
}
# "inicio<TAB>fin<TAB>zona horaria" de una programacion (vacio si no existe).
programacion_de() { # nombre region
  gcloud compute resource-policies describe "$1" --region="$2" --project="$PROYECTO" \
    --format='value(instanceSchedulePolicy.vmStartSchedule.schedule,instanceSchedulePolicy.vmStopSchedule.schedule,instanceSchedulePolicy.timeZone)' 2>/dev/null || true
}
legible() { # "inicio<TAB>fin<TAB>zona" -> "enciende HH:MM, apaga HH:MM (zona)"
  local inicio fin zona
  IFS=$'\t' read -r inicio fin zona <<<"$1"
  printf 'enciende a las %s, apaga a las %s (%s)' "$(hora_de_cron "$inicio")" "$(hora_de_cron "$fin")" "${zona:-?}"
}
agente_compute() {
  local numero
  numero=$(gcloud projects describe "$PROYECTO" --format='value(projectNumber)' 2>/dev/null || true)
  [ -n "$numero" ] && printf 'service-%s@compute-system.iam.gserviceaccount.com\n' "$numero"
}
tiene_permiso_autoencendido() { # vm zona
  grep -q "adaceen-autoencendido@" <<<"$(gcloud compute instances get-iam-policy "$1" --zone="$2" --project="$PROYECTO" --format=json 2>/dev/null || true)"
}
hay_az() { [ -n "$RG" ] && command -v az >/dev/null 2>&1; }
# Ajustes de Azure que toca este script, "NOMBRE<TAB>valor" por linea (solo estos: nunca los secretos).
leer_ajustes_azure() {
  az webapp config appsettings list --name "$APP" --resource-group "$RG" \
    --query "[?name=='GPU_SCHEDULE' || name=='GPU_SCHEDULE_TZ' || name=='GPU_AUTOSTART' || name=='CLASS_GPU_VMS' || name=='WORKSPACE_VM_PROJECT'].[name,value]" \
    -o tsv 2>"$ERR"
}
ajuste_de() { printf '%s\n' "$1" | awk -F'\t' -v n="$2" '$1 == n { sub(/\r$/, "", $2); print $2; exit }'; }
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

# ---------------------------------------------------------------- estado
estado() {
  CUOTA=${CUOTA:-$(leer_cuota_gpu)}
  info "proyecto $PROYECTO; horario $HORARIO ($ZONA_HORARIA); cuota de GPU (GPUS_ALL_REGIONS): $(cuota_txt)"
  local i vm zona region p prog progs h z n sin_permiso="" programadas=0
  local -a encendido=()
  for i in "${!NOMBRES[@]}"; do
    vm=${NOMBRES[$i]}; zona=${ZONAS[$i]}; region=${REGIONES[$i]}
    encendido[i]=""
    progs=$(politicas_de_vm "$vm" "$zona")
    if [ -z "$progs" ]; then
      info "GPU $((i + 1)) $vm ($zona): ${ESTADOS[$i]}; sin programacion de encendido"
    fi
    for p in $progs; do
      prog=$(programacion_de "$p" "$region")
      if [ -n "$prog" ]; then
        info "GPU $((i + 1)) $vm ($zona): ${ESTADOS[$i]}; programacion $p: $(legible "$prog")"
        # Una VM tiene a lo sumo una programacion de instancias: su hora de encendido.
        encendido[i]="$(printf '%s' "$prog" | cut -f1)|$(printf '%s' "$prog" | cut -f3)"
        programadas=$((programadas + 1))
      else
        aviso "GPU $vm ($zona) tiene la programacion $p, pero no pude leerla en $region"
      fi
    done
    h=$(meta_de "$vm" "$zona" horario); z=$(meta_de "$vm" "$zona" zona-horaria); n=$(meta_de "$vm" "$zona" idle-minutes-noche)
    if [ -n "$h" ]; then
      info "  metadata: horario $h (${z:-America/Bogota}); de noche se apaga tras ${n:-60} min sin trabajos"
    else
      info "  metadata: sin horario (apagado por inactividad de siempre: idle-minutes $(meta_de "$vm" "$zona" idle-minutes || true))"
    fi
    if tiene_permiso_autoencendido "$vm" "$zona"; then
      ok "  la cuenta del autoencendido puede encender $vm (encendido de noche desde el backend)"
    else
      sin_permiso="${sin_permiso:+$sin_permiso }$vm"
    fi
  done
  if [ -n "$sin_permiso" ]; then
    aviso "la cuenta adaceen-autoencendido no tiene permiso sobre: $sin_permiso. De noche (o si falla la de la programacion) el backend no podra encenderlas. Dale permiso sobre todas:"
    aviso "  GPUS=\"${NOMBRES[*]}\" bash deploy/gcp/crear-cuenta-autoencendido.sh --sin-clave"
  fi

  # Choques: dos GPU que encienden a la misma hora compiten por la cuota.
  local j hora choques=0
  for i in "${!NOMBRES[@]}"; do
    [ -n "${encendido[i]}" ] || continue
    for ((j = i + 1; j < TOTAL; j++)); do
      [ "${encendido[i]}" = "${encendido[j]}" ] || continue
      choques=1
      hora=$(hora_de_cron "${encendido[i]%%|*}")
      if [ "$CUOTA" = 1 ]; then
        aviso "CHOQUE: ${NOMBRES[$i]} y ${NOMBRES[$j]} encienden a la misma hora ($hora) con cuota de GPU 1: compiten por la unica GPU y pueden quedar las dos apagadas todo el dia (paso el 1-11-2026)."
      else
        aviso "CHOQUE: ${NOMBRES[$i]} y ${NOMBRES[$j]} encienden a la misma hora ($hora) (cuota $(cuota_txt)): con cuota 1 pueden quedar las dos apagadas; con mas, pagas las dos."
      fi
    done
  done
  if [ "$choques" = 1 ]; then
    aviso "  para escalonarlas: GPUS=\"${NOMBRES[*]}\" bash deploy/gcp/horario-gpu.sh activar"
  elif [ "$programadas" -gt 1 ] && [ "$CUOTA" -gt 1 ]; then
    aviso "$programadas GPU con programacion de encendido y cuota $CUOTA: pueden quedar encendidas varias a la vez (pagas cada una). Con ESCALONAR=no queda programada solo la primera."
  elif [ "$programadas" -gt 1 ]; then
    ok "encendidos escalonados: si la primera no encuentra cupo, la siguiente lo intenta despues"
  fi

  local agente
  agente=$(agente_compute || true)
  if [ -n "$agente" ] && grep -q "serviceAccount:$agente" <<<"$(gcloud projects get-iam-policy "$PROYECTO" --format=json 2>/dev/null || true)"; then
    ok "el agente de Compute Engine tiene permisos en el proyecto"
  else
    aviso "no veo al agente de Compute Engine ($agente) en la politica del proyecto: la programacion no podra encender ni apagar las GPU"
  fi
  if hay_az; then
    local ajustes actual
    if ajustes=$(leer_ajustes_azure); then
      actual=$(ajuste_de "$ajustes" CLASS_GPU_VMS)
      if [ "$actual" = "$CLASES" ]; then
        ok "Azure: CLASS_GPU_VMS=$CLASES (el backend prueba las GPU en ese orden)"
      else
        aviso "Azure: CLASS_GPU_VMS es «$actual» y deberia ser $CLASES (en ese orden). Corrige con activar (reinicia el backend ~1 min)"
      fi
    else
      aviso "no pude leer los ajustes de Azure: $(resumir_error "$ERR")"
    fi
  fi
  mostrar_backend
}

# ---------------------------------------------------------------- programaciones
# La programacion nombre en region con encendido cron_inicio (y el apagado de todas). Inmutable: si
# existe con otras horas, se quita de las GPU de la lista que la tienen, se borra y se rehace.
asegurar_programacion() { # nombre region cron_inicio
  local nombre="$1" region="$2" cron_inicio="$3" actual quiero i
  actual=$(programacion_de "$nombre" "$region")
  quiero="$(printf '%s\t%s\t%s' "$cron_inicio" "$CRON_FIN" "$ZONA_HORARIA")"
  if [ -n "$actual" ] && [ "$actual" != "$quiero" ]; then
    info "la programacion $nombre ($region) tiene otras horas ($(legible "$actual")): la rehago"
    for i in "${!NOMBRES[@]}"; do
      [ "${REGIONES[$i]}" = "$region" ] || continue
      if grep -qx "$nombre" <<<"$(politicas_de_vm "${NOMBRES[$i]}" "${ZONAS[$i]}")"; then
        gcloud compute instances remove-resource-policies "${NOMBRES[$i]}" --zone="${ZONAS[$i]}" --project="$PROYECTO" \
          --resource-policies="$nombre" --quiet </dev/null
      fi
    done
    gcloud compute resource-policies delete "$nombre" --region="$region" --project="$PROYECTO" --quiet </dev/null 2>"$ERR" ||
      fallar "no pude borrar $nombre ($region) para rehacerla: $(resumir_error "$ERR"). ¿La usa otra VM? Quitasela (gcloud compute instances remove-resource-policies <vm> --zone=<zona> --resource-policies=$nombre) y vuelve a correr"
    actual=""
  fi
  if [ -z "$actual" ]; then
    gcloud compute resource-policies create instance-schedule "$nombre" --region="$region" --project="$PROYECTO" \
      --vm-start-schedule="$cron_inicio" --vm-stop-schedule="$CRON_FIN" --timezone="$ZONA_HORARIA" \
      --description="ADACEEN: tutor, enciende $(hora_de_cron "$cron_inicio") y apaga $FIN_TXT ($ZONA_HORARIA)" --quiet </dev/null
    ok "programacion $nombre ($region) creada: enciende a las $(hora_de_cron "$cron_inicio") y apaga a las $FIN_TXT ($ZONA_HORARIA)"
  else
    ok "programacion $nombre ($region) ya estaba: enciende a las $(hora_de_cron "$cron_inicio") y apaga a las $FIN_TXT"
  fi
}

# Deja a la GPU i solo con la programacion quiero (vacio: ninguna $POLITICA*). Una VM admite una sola
# programacion de instancias: primero se quitan las otras.
poner_programacion() { # indice quiero
  local vm=${NOMBRES[$1]} zona=${ZONAS[$1]} quiero="$2" p tiene=0 actuales
  actuales=$(politicas_de_vm "$vm" "$zona")
  for p in $actuales; do
    if [ "$p" = "$quiero" ]; then tiene=1; continue; fi
    gcloud compute instances remove-resource-policies "$vm" --zone="$zona" --project="$PROYECTO" --resource-policies="$p" --quiet </dev/null
    ok "$vm ya no tiene la programacion $p"
  done
  [ -n "$quiero" ] || return 0
  if [ "$tiene" = 1 ]; then
    ok "$vm ya tenia la programacion $quiero"
  else
    gcloud compute instances add-resource-policies "$vm" --zone="$zona" --project="$PROYECTO" --resource-policies="$quiero" --quiet </dev/null
    ok "$vm queda con la programacion $quiero"
  fi
}

# Borra las $POLITICA* de las regiones de la lista que no estan en uso ("nombre@region ..."). Si
# Google no deja (la usa otra VM), solo avisa.
limpiar_programaciones() { # en-uso
  local en_uso=" $1 " listado candidatas="" nombre region par
  listado=$(gcloud compute resource-policies list --project="$PROYECTO" --format='value(name,region.basename())' 2>"$ERR") || {
    aviso "no pude listar las programaciones del proyecto ($(resumir_error "$ERR")): no borro las que sobran"
    return 0
  }
  while read -r nombre region; do
    [ -n "$nombre" ] && [ -n "$region" ] || continue
    case "$nombre" in "$POLITICA"*) ;; *) continue ;; esac
    case " ${REGIONES[*]} " in *" $region "*) ;; *) continue ;; esac
    case "$en_uso" in *" $nombre@$region "*) continue ;; esac
    candidatas="$candidatas $nombre@$region"
  done <<<"$listado"
  for par in $candidatas; do
    nombre=${par%@*}; region=${par#*@}
    if gcloud compute resource-policies delete "$nombre" --region="$region" --project="$PROYECTO" --quiet </dev/null >/dev/null 2>"$ERR"; then
      ok "borrada la programacion $nombre ($region): ya no la usa ninguna GPU"
    else
      aviso "no pude borrar la programacion $nombre ($region), quiza la usa otra VM: $(resumir_error "$ERR")"
    fi
  done
}

# Aplica el apagado nuevo en una GPU encendida, sin reiniciarla: carga su startup-script (ya
# actualizado en la metadata) con source y llama instalar_apagado_por_inactividad.
aplicar_en_vivo() { # vm zona
  local vm="$1" zona="$2" salida
  if salida=$(gcloud compute ssh "$vm" --zone="$zona" --project="$PROYECTO" --tunnel-through-iap --quiet \
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
    ok "aplicado en $vm sin reiniciarla: $(printf '%s\n' "$salida" | tail -n 1)"
  else
    aviso "no pude entrar por ssh a $vm ($(printf '%s\n' "$salida" | tail -n 1 | cut -c1-200)); el horario se aplica en su proximo arranque"
  fi
}

# GPU_SCHEDULE, GPU_SCHEDULE_TZ, GPU_AUTOSTART y CLASS_GPU_VMS en una sola llamada (un solo reinicio).
cargar_azure() {
  local -a quiero=("GPU_SCHEDULE=$HORARIO" "GPU_SCHEDULE_TZ=$ZONA_HORARIA" "GPU_AUTOSTART=on" "CLASS_GPU_VMS=$CLASES")
  if ! hay_az; then
    info "Falta cargar en Azure (o corre esto con RG=rg-adaceen-azure y la CLI az), en una sola llamada:"
    info "  az webapp config appsettings set --name $APP --resource-group ${RG:-<grupo>} --settings ${quiero[*]} --output none"
    info "  El App Service se reinicia (~1 min): hazlo cuando no haya estudiantes. CLASS_GPU_VMS es el orden en que el backend prueba las GPU."
    return 0
  fi
  local ajustes leidos=1 par nombre valor actual proyecto_az
  local -a cambios=()
  ajustes=$(leer_ajustes_azure) || { leidos=0; aviso "no pude leer los ajustes de Azure ($(resumir_error "$ERR")): los cargo todos"; }
  for par in "${quiero[@]}"; do
    nombre=${par%%=*}; valor=${par#*=}
    actual=$(ajuste_de "$ajustes" "$nombre")
    if [ "$leidos" = 0 ] || [ "$actual" != "$valor" ]; then
      cambios+=("$par")
      if [ "$nombre" = CLASS_GPU_VMS ] && [ "$leidos" = 1 ]; then
        info "CLASS_GPU_VMS: «${actual:-sin definir}» pasa a $valor (el backend prueba las GPU en ese orden)"
      fi
    fi
  done
  if [ "$leidos" = 1 ]; then
    proyecto_az=$(ajuste_de "$ajustes" WORKSPACE_VM_PROJECT)
    if [ "$proyecto_az" != "$PROYECTO" ]; then
      aviso "Azure: WORKSPACE_VM_PROJECT es «${proyecto_az:-sin definir}» y las GPU estan en $PROYECTO: el backend las buscaria en otro proyecto (lo carga crear-federacion-autoencendido.sh o crear-cuenta-autoencendido.sh)"
    fi
  fi
  if [ "${#cambios[@]}" = 0 ]; then
    ok "Azure ya tenia ${quiero[*]} (no se reinicia)"
    return 0
  fi
  if az webapp config appsettings set --name "$APP" --resource-group "$RG" --settings "${cambios[@]}" --output none 2>"$ERR"; then
    ok "Azure: ${cambios[*]} (el App Service se reinicia, ~1 min)"
  else
    aviso "no pude cargar los ajustes en Azure ($(resumir_error "$ERR")); hazlo a mano, en una sola llamada:"
    aviso "  az webapp config appsettings set --name $APP --resource-group $RG --settings ${quiero[*]} --output none"
  fi
}

# ---------------------------------------------------------------- activar
activar() {
  CUOTA=$(leer_cuota_gpu)
  decidir_escalonado
  info "proyecto $PROYECTO; horario $HORARIO ($ZONA_HORARIA); de noche se apagan tras $MINUTOS_NOCHE min sin trabajos"
  local lista="" i
  for i in "${!NOMBRES[@]}"; do lista="${lista:+$lista, }${NOMBRES[$i]} (${ZONAS[$i]}, ${ESTADOS[$i]})"; done
  info "GPU en orden de preferencia: $lista"
  if [ "$CUOTA" = 0 ]; then
    aviso "la cuota de GPU del proyecto (GPUS_ALL_REGIONS) es 0: ninguna GPU va a encender hasta que Google apruebe 1 (IAM y administracion → Cuotas)"
  fi
  if [ "$TOTAL" -gt 1 ]; then
    if [ "$ESCALONADO" = 1 ]; then
      info "cuota de GPU $(cuota_txt): encendidos escalonados cada $DESFASE min (si la primera encendio, las siguientes reciben QUOTA_EXCEEDED y no pasa nada)"
      if [ "$CUOTA" -gt 1 ]; then aviso "ESCALONAR=si con cuota $CUOTA: pueden quedar encendidas varias GPU a la vez (pagas cada una)"; fi
    elif [ "$ESCALONAR" = no ]; then
      info "ESCALONAR=no: solo ${NOMBRES[0]} tiene programacion de encendido; si no encuentra cupo, el backend prueba las demas cuando un estudiante pide ayuda"
    else
      info "cuota de GPU $(cuota_txt): solo ${NOMBRES[0]} tiene programacion de encendido, para no pagar dos GPU a la vez. Si no encuentra cupo, el backend prueba las demas (CLASS_GPU_VMS, en orden) cuando un estudiante pide ayuda. ESCALONAR=si para escalonarlas igual"
    fi
  fi
  local ultimo
  ultimo=$(inicio_de_indice $((TOTAL - 1)))
  if [ "$ESCALONADO" = 1 ] && [ "$ultimo" -ge "$FIN_MIN" ]; then
    fallar "con $TOTAL GPU cada $DESFASE min la ultima encenderia a las $(hhmm "$ultimo"), despues del fin del horario ($FIN_TXT): baja DESFASE_MINUTOS o quita GPU de la lista"
  fi

  # 1. El agente de Compute Engine enciende y apaga con la programacion.
  local agente
  agente=$(agente_compute || true)
  if [ -z "$agente" ]; then
    aviso "no pude leer el numero del proyecto: da roles/compute.instanceAdmin.v1 al agente de Compute Engine a mano"
  elif gcloud projects add-iam-policy-binding "$PROYECTO" --member="serviceAccount:$agente" \
      --role=roles/compute.instanceAdmin.v1 --condition=None --quiet >/dev/null 2>&1; then
    ok "el agente de Compute Engine puede encender y apagar las GPU con la programacion"
  else
    aviso "no pude dar el rol al agente de Compute Engine. Pidelo a quien administra el proyecto:"
    aviso "  gcloud projects add-iam-policy-binding $PROYECTO --member=serviceAccount:$agente --role=roles/compute.instanceAdmin.v1"
  fi

  # 2. Una programacion por GPU (en su region); a cada VM, solo la suya; fuera las que sobran.
  local nombre en_uso=""
  local -a quiero=()
  for i in "${!NOMBRES[@]}"; do
    quiero[i]=$(politica_de_indice "$i")
    [ -n "${quiero[i]}" ] || continue
    asegurar_programacion "${quiero[i]}" "${REGIONES[$i]}" "$(cron_de "$(inicio_de_indice "$i")")"
    en_uso="$en_uso ${quiero[i]}@${REGIONES[$i]}"
  done
  for i in "${!NOMBRES[@]}"; do
    poner_programacion "$i" "${quiero[i]}"
  done
  limpiar_programaciones "$en_uso"

  # 3. Metadata y startup-script con el apagado nocturno, en todas (tambien las sin programacion:
  # si el backend las enciende de noche, se apagan solas).
  for i in "${!NOMBRES[@]}"; do
    gcloud compute instances add-metadata "${NOMBRES[$i]}" --zone="${ZONAS[$i]}" --project="$PROYECTO" \
      --metadata="horario=$HORARIO,zona-horaria=$ZONA_HORARIA,idle-minutes-noche=$MINUTOS_NOCHE" --quiet </dev/null >/dev/null
  done
  ok "metadata de ${NOMBRES[*]}: horario $HORARIO, zona-horaria $ZONA_HORARIA, idle-minutes-noche $MINUTOS_NOCHE"
  GPUS="${NOMBRES[*]}" PROYECTO="$PROYECTO" bash "$DIR_SCRIPT/actualizar-gpus.sh" </dev/null ||
    aviso "actualizar-gpus.sh no pudo subir el startup-script a todas (arriba el motivo); vuelve a correr activar"

  # 4. Encendidas: el apagado nuevo ya, sin reiniciar.
  for i in "${!NOMBRES[@]}"; do
    nombre=${NOMBRES[$i]}
    if esta_encendida "${ESTADOS[$i]}"; then
      aplicar_en_vivo "$nombre" "${ZONAS[$i]}"
    elif [ -n "${quiero[i]}" ]; then
      info "$nombre esta ${ESTADOS[$i]}: toma el horario en su proximo arranque (la programacion la enciende a las $(hhmm "$(inicio_de_indice "$i")"))"
    else
      info "$nombre esta ${ESTADOS[$i]}: toma el horario cuando la enciendan (el backend de noche, o a mano)"
    fi
  done

  # 5. Azure: el horario que muestra el backend, el encendido de noche y el orden de las GPU.
  cargar_azure
  echo
  estado
}

# ---------------------------------------------------------------- desactivar
desactivar() {
  local i
  for i in "${!NOMBRES[@]}"; do
    poner_programacion "$i" ""
  done
  limpiar_programaciones ""
  for i in "${!NOMBRES[@]}"; do
    gcloud compute instances remove-metadata "${NOMBRES[$i]}" --zone="${ZONAS[$i]}" --project="$PROYECTO" \
      --keys=horario,zona-horaria,idle-minutes-noche --quiet </dev/null >/dev/null 2>&1 || true
  done
  ok "sin horario en ${NOMBRES[*]}: en su proximo arranque vuelve el apagado por inactividad de siempre"
  info "En Azure, para no encenderlas de noche: az webapp config appsettings set --name $APP --resource-group ${RG:-<grupo>} --settings GPU_AUTOSTART=off"
}

case "$ACCION" in
  activar) activar ;;
  estado) estado ;;
  desactivar) desactivar ;;
esac
