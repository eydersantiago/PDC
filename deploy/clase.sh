#!/usr/bin/env bash
# Iniciar y terminar una clase del piloto desde Cloud Shell, con un solo comando.
#
#   bash deploy/clase.sh iniciar    enciende la GPU y la VM de editores, espera a que Azure
#                                   los vea listos e imprime el enlace para estudiantes
#   bash deploy/clase.sh terminar   apaga las GPU y la VM de editores
#   bash deploy/clase.sh estado     que hay encendido y si el servicio esta listo (no cambia nada)
#
# Se puede correr las veces que haga falta: lo que ya esta encendido (o apagado)
# se deja como esta. No muestra secretos: solo lee /api/health y
# /api/agent/backend, que no los tienen, y el estado de las VMs.
#
# Variables (todas opcionales):
#   PROYECTO      proyecto de Google Cloud (defecto: el de gcloud config, o adaceen-508504)
#   GPUS          VMs de GPU en orden de preferencia (defecto: adaceen-worker-v100
#                 adaceen-worker-a100 adaceen-worker); "ninguna" para no usar GPU
#                 (por ejemplo, solo con las Mac del laboratorio)
#   GPU_MODO      una (defecto: la primera que encienda; la cuota del proyecto es de
#                 1 GPU) o todas
#   VM_EDITORES   VM de editores (defecto adaceen-ws); "ninguna" para no tocarla. Con
#                 el proveedor codespaces no se enciende (no hace falta)
#   BACKEND       API de Azure (defecto: la de produccion)
#   ESPERA_MAX    segundos maximos de espera en iniciar (defecto 900)
#   INTERVALO     segundos entre consultas (defecto 10)
# Las zonas no se configuran: se leen de las VMs.
#
# Guia: docs/operacion/runbook.md, seccion «Ciclo de cada clase».
set -euo pipefail

DIR_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/comun-gcp.sh
. "$DIR_SCRIPT/gcp/comun-gcp.sh"

ayuda() {
  sed -n '2,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

ACCION="${1:-}"
case "$ACCION" in
  iniciar | terminar | estado) ;;
  -h | --help | --ayuda) ayuda; exit 0 ;;
  "") ayuda; exit 1 ;;
  *) fallar "accion desconocida: $ACCION (usa iniciar, terminar o estado)" ;;
esac

requiere_gcloud
command -v curl >/dev/null 2>&1 || fallar "falta curl"
command -v python3 >/dev/null 2>&1 || fallar "falta python3"

PROYECTO=$(resolver_proyecto)
GPUS=${GPUS-$GPUS_POR_DEFECTO}
[ "$GPUS" = "ninguna" ] && GPUS=""
GPU_MODO=${GPU_MODO:-una}
case "$GPU_MODO" in una | todas) ;; *) fallar "GPU_MODO debe ser una o todas" ;; esac
VM_EDITORES=${VM_EDITORES-$VM_EDITORES_POR_DEFECTO}
[ "$VM_EDITORES" = "ninguna" ] && VM_EDITORES=""
BACKEND=${BACKEND:-$BACKEND_PRODUCCION}
BACKEND=${BACKEND%/}
[[ $BACKEND =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$ ]] || fallar "BACKEND no es una URL valida: $BACKEND"
ESPERA_MAX=${ESPERA_MAX:-900}
[[ $ESPERA_MAX =~ ^[0-9]+$ ]] || fallar "ESPERA_MAX debe ser un numero de segundos"
INTERVALO=${INTERVALO:-10}
[[ $INTERVALO =~ ^[0-9]+(\.[0-9]+)?$ ]] || fallar "INTERVALO debe ser un numero de segundos"
ENLACE="$BACKEND/empezar"

# ---------------------------------------------------------------- servicio (Azure)
# Campos de /api/health, una linea cada uno (solo letras, numeros, . _ -).
# shellcheck disable=SC2016
PY_SALUD='
import json, re, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if not isinstance(d, dict):
    sys.exit(1)
def v(clave):
    x = d.get(clave)
    if isinstance(x, bool):
        return "si" if x else "no"
    if x is None:
        return ""
    return re.sub(r"[^A-Za-z0-9._-]", "", str(x))[:40]
for clave in ("mode", "workspace_provider", "workspace_agent_online", "workspace_agent_transport",
              "worker_heartbeat_configured", "model_workers_alive"):
    print(v(clave))
'
# /api/agent/backend: cuantos servidores del modelo mandan latido, sus ids y si hay una GPU de Google Cloud.
PY_SERVIDORES='
import json, re, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
lista = d.get("listening") if isinstance(d, dict) else None
if not isinstance(lista, list):
    sys.exit(1)
vivos = [w for w in lista if isinstance(w, dict) and w.get("alive")]
ids = [re.sub(r"[^A-Za-z0-9._-]", "", str(w.get("id", "")))[:60] for w in vivos]
print(len(vivos))
print(" ".join(i for i in ids if i))
print("si" if any(w.get("provider") == "gcp" for w in vivos) else "no")
'

leer_servicio() {
  S_RESPONDE=0; S_MODO=""; S_PROVEEDOR=""; S_AGENTE=""; S_TRANSPORTE=""; S_LATIDO=""; S_VIVOS=""
  S_LISTA=0; S_IDS=""; S_GPU_VIVA=""
  local cuerpo campos
  if cuerpo="$(curl -fsS -m 15 "$BACKEND/api/health" 2>/dev/null)" &&
    campos="$(printf '%s' "$cuerpo" | python3 -c "$PY_SALUD" 2>/dev/null)"; then
    S_RESPONDE=1
    {
      IFS= read -r S_MODO
      IFS= read -r S_PROVEEDOR
      IFS= read -r S_AGENTE
      IFS= read -r S_TRANSPORTE
      IFS= read -r S_LATIDO
      IFS= read -r S_VIVOS
    } <<<"$campos" || true
  fi
  if cuerpo="$(curl -fsS -m 15 "$BACKEND/api/agent/backend" 2>/dev/null)" &&
    campos="$(printf '%s' "$cuerpo" | python3 -c "$PY_SERVIDORES" 2>/dev/null)"; then
    local cuantos
    {
      IFS= read -r cuantos
      IFS= read -r S_IDS
      IFS= read -r S_GPU_VIVA
    } <<<"$campos" || true
    S_LISTA=1
    [[ $S_VIVOS =~ ^[0-9]+$ ]] || S_VIVOS="$cuantos"
  fi
  [[ $S_VIVOS =~ ^[0-9]+$ ]] || S_VIVOS=""
}

# La VM de editores hace falta con el proveedor tunnel (o si no se sabe cual es).
necesita_editores() {
  [ -n "$VM_EDITORES" ] || return 1
  [ -n "$(zona_de "$VM_EDITORES")" ] || return 1
  case "$S_PROVEEDOR" in tunnel | "") return 0 ;; esac
  return 1
}

# Deja E/M/G en si, no o na (no aplica) con su texto: editor, modelo y GPU.
# GPU_ESPERADA=1 cuando hay una GPU encendida: entonces se espera su latido.
# E_SIN_VM=1 cuando el editor no puede quedar listo esperando (la VM no existe
# en el proyecto): iniciar no espera en vano.
GPU_ESPERADA=0
evaluar() {
  local estado_vm
  E_SIN_VM=0
  if [ -z "$VM_EDITORES" ]; then
    E=na; E_TXT="no se usa (VM_EDITORES=ninguna)"
  elif [ -n "$S_PROVEEDOR" ] && [ "$S_PROVEEDOR" != "tunnel" ]; then
    E=na; E_TXT="no hace falta (proveedor $S_PROVEEDOR)"
  elif [ -z "$(zona_de "$VM_EDITORES")" ]; then
    if [ "$S_AGENTE" = "si" ]; then
      E=si; E_TXT="listo (agente de editores conectado)"
    elif [ "$S_PROVEEDOR" = "tunnel" ]; then
      E=no; E_TXT="no encuentro la VM $VM_EDITORES en $PROYECTO (usa PROYECTO=<proyecto> o VM_EDITORES=<vm>)"
      E_SIN_VM=1
    else
      E=na; E_TXT="no hay VM $VM_EDITORES en $PROYECTO"
    fi
  else
    estado_vm="$(estado_de "$VM_EDITORES")"
    if [ "$S_RESPONDE" = 0 ]; then
      E=no; E_TXT="sin respuesta de $BACKEND/api/health"
    elif [ "$S_AGENTE" = "si" ]; then
      E=si; E_TXT="listo (agente de $VM_EDITORES conectado)"
    elif [ "$S_TRANSPORTE" = "direct" ] || [ -z "$S_AGENTE" ]; then
      # /api/health no puede confirmarlo (transporte directo o backend anterior): basta la VM encendida.
      if [ "$estado_vm" = "RUNNING" ]; then
        E=si; E_TXT="VM $VM_EDITORES encendida (el backend no informa el agente)"
      else
        E=no; E_TXT="VM $VM_EDITORES en ${estado_vm:-?}"
      fi
    elif [ "$estado_vm" != "RUNNING" ]; then
      E=no; E_TXT="VM $VM_EDITORES en ${estado_vm:-?}"
    else
      E=no; E_TXT="VM encendida; el agente todavia no se conecta (tarda 1-2 min)"
    fi
  fi

  if [ "$S_RESPONDE" = 0 ]; then
    M=no; M_TXT="sin respuesta de $BACKEND/api/health"
  elif [ -n "$S_MODO" ] && [ "$S_MODO" != "queue" ]; then
    M=na; M_TXT="el backend esta en modo $S_MODO (no usa la cola)"
  elif [ "$S_LATIDO" = "no" ]; then
    M=na; M_TXT="sin WORKER_HEARTBEAT_TOKEN en Azure no se puede confirmar"
  elif [ -n "$S_VIVOS" ] && [ "$S_VIVOS" -ge 1 ]; then
    M=si; M_TXT="$S_VIVOS servidor(es) vivo(s)${S_IDS:+: $S_IDS}"
  else
    M=no; M_TXT="ningun servidor del modelo manda latido todavia"
  fi

  if [ "$GPU_ESPERADA" = 0 ] || [ "$M" = "na" ] || [ "$S_LISTA" = 0 ]; then
    G=na; G_TXT=""
  elif [ "$S_GPU_VIVA" = "si" ]; then
    G=si; G_TXT="la GPU manda latido"
  else
    G=no; G_TXT="la GPU todavia arranca (2-5 min; la primera vez hasta 12)"
  fi
}

listo() {
  [ "$E" != "no" ] && [ "$M" != "no" ] && [ "$G" != "no" ]
}

resumen() {
  printf 'editor: %s | modelo: %s%s' "$E_TXT" "$M_TXT" "${G_TXT:+ | $G_TXT}"
}

# ---------------------------------------------------------------- VMs
ERR_GCLOUD="$(mktemp "${TMPDIR:-/tmp}/adaceen-clase.XXXXXX")"
trap 'rm -f "$ERR_GCLOUD"' EXIT

# Motivo corto (y en castellano cuando se reconoce) del ultimo error de gcloud.
motivo_gcloud() {
  local texto
  texto="$(resumir_error "$ERR_GCLOUD")"
  case "$texto" in
    *GPUS_ALL_REGIONS* | *QUOTA* | *[Qq]uota*) printf 'sin cuota de GPU (la del proyecto es 1: ¿hay otra GPU encendida?). %s' "$texto" ;;
    *RESOURCE_POOL_EXHAUSTED* | *"does not have enough resources"* | *STOCKOUT*) printf 'Google no tiene cupo en la zona ahora. %s' "$texto" ;;
    *) printf '%s' "${texto:-error de gcloud}" ;;
  esac
}

# Espera a que la VM llegue a un estado (p. ej. TERMINATED tras un STOPPING).
esperar_estado() {
  local vm="$1" zona="$2" objetivo="$3" max="$4" t=0 actual
  while [ "$t" -lt "$max" ]; do
    actual="$(gcloud compute instances describe "$vm" --zone="$zona" --project="$PROYECTO" --format='value(status)' 2>/dev/null || true)"
    [ "$actual" = "$objetivo" ] && return 0
    sleep 5
    t=$((t + 5))
  done
  return 1
}

# Enciende una VM (espera a que la operacion termine). 1 si no pudo.
encender() {
  local vm="$1" zona="$2" estado="$3"
  case "$estado" in
    STOPPING | SUSPENDING)
      info "$vm se esta apagando; espero a que termine para encenderla"
      esperar_estado "$vm" "$zona" "$([ "$estado" = SUSPENDING ] && echo SUSPENDED || echo TERMINATED)" 180 || true
      estado="$(gcloud compute instances describe "$vm" --zone="$zona" --project="$PROYECTO" --format='value(status)' 2>/dev/null || true)"
      ;;
  esac
  if [ "$estado" = "SUSPENDED" ]; then
    gcloud compute instances resume "$vm" --zone="$zona" --project="$PROYECTO" --quiet >/dev/null 2>"$ERR_GCLOUD"
  else
    gcloud compute instances start "$vm" --zone="$zona" --project="$PROYECTO" --quiet >/dev/null 2>"$ERR_GCLOUD"
  fi
}

iniciar_gpus() {
  local vm zona estado encendidas=""
  if [ -z "$GPUS" ]; then
    info "sin GPU (GPUS=ninguna): atienden los servidores que ya esten encendidos (Mac del laboratorio)"
    return 0
  fi
  for vm in $GPUS; do
    zona="$(zona_de "$vm")"
    if [ -z "$zona" ]; then
      info "no existe la VM $vm en $PROYECTO (se omite)"
      continue
    fi
    estado="$(estado_de "$vm")"
    if esta_encendida "$estado"; then
      encendidas="$encendidas $vm"
      ok "GPU $vm ya encendida ($zona, $estado)"
      GPU_ESPERADA=1
    fi
  done
  if [ "$GPU_MODO" = "una" ] && [ -n "$encendidas" ]; then
    return 0
  fi
  for vm in $GPUS; do
    zona="$(zona_de "$vm")"
    [ -n "$zona" ] || continue
    estado="$(estado_de "$vm")"
    esta_encendida "$estado" && continue
    info "encendiendo la GPU $vm ($zona)..."
    if encender "$vm" "$zona" "$estado"; then
      ok "GPU $vm encendida; el worker tarda 2-5 min en tomar trabajos"
      GPU_ESPERADA=1
      [ "$GPU_MODO" = "una" ] && return 0
    else
      aviso "$vm no encendio: $(motivo_gcloud)"
    fi
  done
  if [ "$GPU_ESPERADA" = 0 ]; then
    aviso "ninguna GPU encendio. Contingencia 2 (docs/operacion/contingencia.md); si hay Mac del laboratorio encendidas, atienden ellas"
  fi
}

iniciar_editores() {
  local zona estado
  if ! necesita_editores; then
    evaluar
    info "VM de editores: $E_TXT"
    return 0
  fi
  zona="$(zona_de "$VM_EDITORES")"
  estado="$(estado_de "$VM_EDITORES")"
  if esta_encendida "$estado"; then
    ok "VM de editores $VM_EDITORES ya encendida ($zona, $estado)"
    return 0
  fi
  info "encendiendo la VM de editores $VM_EDITORES ($zona)..."
  if encender "$VM_EDITORES" "$zona" "$estado"; then
    ok "VM de editores encendida; el agente se conecta en 1-2 min"
  else
    aviso "la VM de editores no encendio: $(motivo_gcloud)"
  fi
}

# Espera hasta ESPERA_MAX a que editor y modelo esten listos. 0 si lo estan.
esperar_listo() {
  local inicio ahora limite ultimo="" ultimo_aviso texto
  inicio="$(date +%s)"
  limite=$((inicio + ESPERA_MAX))
  ultimo_aviso="$inicio"
  while :; do
    leer_servicio
    leer_instancias || true
    evaluar
    listo && return 0
    # Sin la VM de editores en el proyecto no hay nada que esperar.
    [ "$E_SIN_VM" = 1 ] && return 1
    ahora="$(date +%s)"
    [ "$ahora" -ge "$limite" ] && return 1
    texto="$(resumen)"
    if [ "$texto" != "$ultimo" ] || [ $((ahora - ultimo_aviso)) -ge 60 ]; then
      info "esperando ($((ahora - inicio)) s de ${ESPERA_MAX} max): $texto"
      ultimo="$texto"
      ultimo_aviso="$ahora"
    fi
    sleep "$INTERVALO"
  done
}

mostrar_vms() {
  local vm zona estado
  for vm in $GPUS; do
    zona="$(zona_de "$vm")"
    if [ -z "$zona" ]; then info "GPU $vm: no existe en $PROYECTO"; continue; fi
    estado="$(estado_de "$vm")"
    if esta_encendida "$estado"; then ok "GPU $vm ($zona): $estado"; else info "GPU $vm ($zona): $estado"; fi
  done
  if [ -n "$VM_EDITORES" ]; then
    zona="$(zona_de "$VM_EDITORES")"
    if [ -z "$zona" ]; then
      info "VM de editores $VM_EDITORES: no existe en $PROYECTO"
    else
      estado="$(estado_de "$VM_EDITORES")"
      if esta_encendida "$estado"; then ok "VM de editores $VM_EDITORES ($zona): $estado"; else info "VM de editores $VM_EDITORES ($zona): $estado"; fi
    fi
  fi
}

# ---------------------------------------------------------------- acciones
accion_estado() {
  info "proyecto $PROYECTO | backend $BACKEND"
  leer_instancias || fallar "gcloud no pudo listar las VMs de $PROYECTO: $INSTANCIAS_ERROR"
  avisar_repetidas
  mostrar_vms
  leer_servicio
  for vm in $GPUS; do esta_encendida "$(estado_de "$vm")" && GPU_ESPERADA=1; done
  evaluar
  if [ "$S_RESPONDE" = 1 ]; then
    info "backend: modo ${S_MODO:-?}, proveedor de editores ${S_PROVEEDOR:-?}"
  fi
  if [ "$E" = "no" ]; then aviso "editor: $E_TXT"; else info "editor: $E_TXT"; fi
  if [ "$M" = "no" ]; then aviso "modelo: $M_TXT"; else info "modelo: $M_TXT"; fi
  [ -n "$G_TXT" ] && info "GPU: $G_TXT"
  if listo; then
    ok "listo para la clase"
  else
    info "no esta listo: bash deploy/clase.sh iniciar"
  fi
  info "enlace para estudiantes: $ENLACE"
}

accion_iniciar() {
  local vm hay_alguna=0 buscadas=""
  info "proyecto $PROYECTO | backend $BACKEND"
  leer_instancias || fallar "gcloud no pudo listar las VMs de $PROYECTO: $INSTANCIAS_ERROR (¿gcloud auth login?)"
  avisar_repetidas
  # Ninguna de las VMs en el proyecto: casi siempre gcloud config apunta a otro
  # proyecto. Se dice ya, en vez de esperar ESPERA_MAX a algo que no llegara.
  if [ -n "$GPUS$VM_EDITORES" ]; then
    for vm in $GPUS $VM_EDITORES; do
      buscadas="${buscadas:+$buscadas }$vm"
      [ -n "$(zona_de "$vm")" ] && hay_alguna=1
    done
    if [ "$hay_alguna" = 0 ]; then
      fallar "no encuentro ninguna de las VMs ($buscadas) en el proyecto $PROYECTO. Si es otro proyecto: PROYECTO=$PROYECTO_POR_DEFECTO bash deploy/clase.sh iniciar (o gcloud config set project $PROYECTO_POR_DEFECTO)"
    fi
  fi
  leer_servicio
  if [ "$S_RESPONDE" = 0 ]; then
    aviso "el backend no responde en $BACKEND/api/health; enciendo igual y sigo intentando"
  fi
  iniciar_gpus
  iniciar_editores
  info "esperando a que Azure vea el editor y el modelo (hasta $ESPERA_MAX s)"
  if esperar_listo; then
    ok "editor: $E_TXT"
    ok "modelo: $M_TXT"
  else
    if [ "$E" != "no" ] && [ "$M" != "no" ]; then
      # Solo falta la GPU: atienden los demas servidores (por ejemplo las Mac).
      aviso "la GPU no mando latido en $ESPERA_MAX s, pero ya atienden: ${S_IDS:-otros servidores}"
      aviso "revisa la GPU: gcloud compute ssh <vm> --tunnel-through-iap --command='sudo tail -n 50 /var/log/adaceen-startup.log'"
    else
      printf '\n'
      [ "$E" = "no" ] && aviso "editor no listo: $E_TXT"
      [ "$M" = "no" ] && aviso "modelo no listo: $M_TXT"
      aviso "revisa docs/operacion/runbook.md (seccion 5). Puedes volver a correr este comando: no repite lo ya hecho."
      info "enlace para estudiantes (cuando este listo): $ENLACE"
      exit 1
    fi
  fi
  printf '\n'
  ok "clase lista. Enlace para estudiantes:"
  printf '\n    %s\n\n' "$ENLACE"
  info "al terminar: bash deploy/clase.sh terminar"
}

accion_terminar() {
  local vm zona estado apagando="" fallas=0 t=0 pendientes
  info "proyecto $PROYECTO"
  leer_instancias || fallar "gcloud no pudo listar las VMs de $PROYECTO: $INSTANCIAS_ERROR (¿gcloud auth login?)"
  avisar_repetidas
  for vm in $GPUS $VM_EDITORES; do
    zona="$(zona_de "$vm")"
    [ -n "$zona" ] || continue
    estado="$(estado_de "$vm")"
    case "$estado" in
      TERMINATED | STOPPED | SUSPENDED)
        ok "$vm ya estaba apagada ($estado)"
        continue
        ;;
    esac
    if gcloud compute instances stop "$vm" --zone="$zona" --project="$PROYECTO" --async --quiet >/dev/null 2>"$ERR_GCLOUD"; then
      info "apagando $vm ($zona)..."
      apagando="$apagando $vm"
    else
      aviso "no se pudo apagar $vm: $(motivo_gcloud)"
      fallas=$((fallas + 1))
    fi
  done
  # Espera (hasta 5 min) a que queden TERMINATED, para decir la verdad al final.
  while [ -n "$apagando" ] && [ "$t" -lt 300 ]; do
    leer_instancias || true
    pendientes=""
    for vm in $apagando; do
      case "$(estado_de "$vm")" in TERMINATED | STOPPED | SUSPENDED | "") ok "$vm apagada" ;; *) pendientes="$pendientes $vm" ;; esac
    done
    apagando="$pendientes"
    [ -n "$apagando" ] || break
    sleep 5
    t=$((t + 5))
  done
  if [ -n "$apagando" ]; then
    aviso "siguen apagandose:$apagando (revisa en unos minutos con: bash deploy/clase.sh estado)"
  fi
  info "las Mac del laboratorio no se tocan (no cuestan por hora): bash deploy/mac/worker-mac.sh detener en cada una si hace falta"
  info "despues de la clase: calidad de datos y exportes (docs/operacion/runbook.md, seccion 3)"
  [ "$fallas" = 0 ] || exit 1
}

case "$ACCION" in
  estado) accion_estado ;;
  iniciar) accion_iniciar ;;
  terminar) accion_terminar ;;
esac
