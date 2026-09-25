#!/usr/bin/env bash
# Crea la VM del worker ADACEEN. Perfiles:
#   bash deploy/gcp/create-vm.sh cpu    -> sin GPU. Unico permitido en prueba gratuita. Modelo 3B.
#   bash deploy/gcp/create-vm.sh t4     -> T4 16 GB.  Barata.        7B holgado.
#   bash deploy/gcp/create-vm.sh l4     -> L4 24 GB.  Recomendado.   14B holgado, 32B entra.
#   bash deploy/gcp/create-vm.sh l4x2   -> 2x L4 48 GB. Para 70B. Necesita cuota global de 2.
# Se puede lanzar desde cualquier carpeta.
#
# A100 (Spot) y V100 (estandar) no se crean de cero: se copian del disco
# de este worker con clone-worker.sh (driver, Ollama y modelo ya listos).
#
# Todos los perfiles con GPU requieren cuenta de PAGO y cuota aprobada.
# El disco sube a 120 GB en los perfiles L4: un 32B Q4 pesa ~20 GB.
#
# Red: por defecto SIN IP publica. La politica de la organizacion
# (constraints/compute.vmExternalIpAccess) la prohibe; la VM sale a internet
# por el Cloud NAT adaceen-nat, que este script crea si falta (lo comparte
# con la VM de editores). CON_IP=1 pide una IP publica efimera, solo para un
# proyecto sin esa politica.
#
# Los secretos van por metadata y NO quedan en el historial del shell ni en la
# linea de comandos: se leen de variables de entorno que exportas antes (SB_CONN,
# WORKER_SECRET, HEARTBEAT_TOKEN) o te los pide, y viajan a gcloud en archivos
# de una carpeta temporal privada que se borra al terminar.
#
# Otras variables: PROYECTO, ZONA (us-central1-a), NOMBRE (adaceen-worker),
# MAQUINA, MODELO, DISCO (120), RAMA (feature/azure-config-observability: la
# rama de PDC que clona el arranque), API_URL (la de produccion; para el latido).
set -euo pipefail

DIR_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/comun-gcp.sh
. "$DIR_SCRIPT/comun-gcp.sh"
requiere_gcloud

PERFIL=${1:-cpu}
PROYECTO=$(resolver_proyecto)
ZONA=${ZONA:-$ZONA_POR_DEFECTO}
NOMBRE=${NOMBRE:-adaceen-worker}
RAMA=${RAMA:-feature/azure-config-observability}
API_URL=${API_URL:-$BACKEND_PRODUCCION}
API_URL=${API_URL%/}

case "$PERFIL" in
  cpu)
    # c3 usa DDR5: mejor ancho de banda de memoria, que es el cuello en CPU.
    # Si c3 no esta disponible en tu zona, prueba n2-standard-8.
    MAQUINA=${MAQUINA:-c3-standard-8}
    MODELO=${MODELO:-qwen2.5:3b-instruct}
    GPU=""
    ;;
  t4)
    # 16 GB VRAM. Barata. 7B holgado, 13B justo.
    MAQUINA=${MAQUINA:-n1-standard-4}
    MODELO=${MODELO:-qwen2.5:7b-instruct}
    GPU="type=nvidia-tesla-t4,count=1"
    ;;
  gpu | l4)
    # 24 GB VRAM. El punto dulce: 14B holgado, 32B entra.
    # g2-standard-8 da 8 vCPU / 32 GB RAM, suficiente para cargar un 32B.
    MAQUINA=${MAQUINA:-g2-standard-8}
    MODELO=${MODELO:-qwen2.5-coder:14b}
    GPU="type=nvidia-l4,count=1"
    ;;
  l4x2)
    # 48 GB VRAM. Para un 70B Q4. Requiere cuota global de 2 GPUs.
    MAQUINA=${MAQUINA:-g2-standard-24}
    MODELO=${MODELO:-qwen2.5:72b-instruct}
    GPU="type=nvidia-l4,count=2"
    ;;
  *) fallar "perfil invalido: usa cpu, t4, gpu|l4 o l4x2" ;;
esac

if [ -z "${SB_CONN:-}" ]; then
  read -rsp "SAS namespace Listen+Send (colab-worker): " SB_CONN || true; echo
fi
[ -n "${SB_CONN:-}" ] || fallar "falta la cadena de conexion de Service Bus (SB_CONN)"
if [ -z "${WORKER_SECRET+x}" ]; then
  read -rsp "WORKER_SHARED_SECRET (Enter si no se usa): " WORKER_SECRET || true; echo
fi
if [ -z "${HEARTBEAT_TOKEN+x}" ]; then
  read -rsp "WORKER_HEARTBEAT_TOKEN del App Service (Enter para no mandar latido): " HEARTBEAT_TOKEN || true; echo
fi
WORKER_SECRET=${WORKER_SECRET:-}
HEARTBEAT_TOKEN=${HEARTBEAT_TOKEN:-}

# Metadata en archivos: nada de secretos en la linea de comandos (ps) ni
# problemas con comas o signos = dentro de los valores.
META=$(mktemp -d "${TMPDIR:-/tmp}/adaceen-meta.XXXXXX")
chmod 700 "$META"
trap 'rm -rf "$META"' EXIT
cp "$DIR_SCRIPT/startup-script.sh" "$META/startup-script"
printf '%s' "$SB_CONN" >"$META/sb-conn"
printf '%s' "$WORKER_SECRET" >"$META/worker-secret"
printf '%s' "$MODELO" >"$META/model-text"
printf '%s' "30" >"$META/idle-minutes"
printf '%s' "gce-$PERFIL" >"$META/worker-id"
printf '%s' "$RAMA" >"$META/branch"
if [ -n "$HEARTBEAT_TOKEN" ]; then
  printf '%s' "$API_URL/api/agent/heartbeat" >"$META/heartbeat-url"
  printf '%s' "$HEARTBEAT_TOKEN" >"$META/heartbeat-token"
else
  aviso "sin WORKER_HEARTBEAT_TOKEN: el worker atiende, pero /api/agent/health y deploy/clase.sh no lo veran"
fi
DESDE_ARCHIVO=""
for archivo in "$META"/*; do
  DESDE_ARCHIVO="${DESDE_ARCHIVO:+$DESDE_ARCHIVO,}$(basename "$archivo")=$archivo"
done

RED=(--no-address)
if [ "${CON_IP:-0}" = "1" ]; then
  RED=()
else
  if [ "${SIN_IP:-}" = "0" ]; then
    aviso "SIN_IP=0 ya no pide IP publica (va contra la politica vmExternalIpAccess); usa CON_IP=1 si tu proyecto la permite"
  fi
  asegurar_nat "$(region_de_zona "$ZONA")"
fi
EXTRA=()
if [ -n "$GPU" ]; then
  EXTRA=(--accelerator="$GPU" --maintenance-policy=TERMINATE)
fi

info "proyecto=$PROYECTO zona=$ZONA maquina=$MAQUINA modelo=$MODELO rama=$RAMA ip_publica=$([ "${CON_IP:-0}" = "1" ] && echo si || echo 'no (Cloud NAT)')"

gcloud compute instances create "$NOMBRE" \
  --project="$PROYECTO" \
  --zone="$ZONA" \
  --machine-type="$MAQUINA" \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size="${DISCO:-120}GB" \
  --boot-disk-type=pd-balanced \
  --provisioning-model=SPOT \
  --instance-termination-action=STOP \
  ${RED[@]+"${RED[@]}"} \
  --metadata-from-file="$DESDE_ARCHIVO" \
  ${EXTRA[@]+"${EXTRA[@]}"}

cat <<FIN

Creada. Notas:

  Red                sin IP publica: sale a internet por el Cloud NAT
                     ${NAT:-$NAT_POR_DEFECTO} (no hay nada escuchando: el worker solo abre
                     conexiones salientes). CON_IP=1 la crea con IP publica.
  --provisioning-model=SPOT
                     ~4x mas barato. Si Google la desaloja se apaga (STOP) y el
                     job vuelve a la cola por el abandon del worker. La vuelves
                     a encender y sigue.

Seguimiento del arranque (tarda ~5 min la primera vez):
  gcloud compute ssh $NOMBRE --zone=$ZONA --tunnel-through-iap \\
    --command='sudo tail -f /var/log/adaceen-startup.log'

Log del worker:
  gcloud compute ssh $NOMBRE --zone=$ZONA --tunnel-through-iap \\
    --command='sudo tail -f /var/log/adaceen-worker.log'

Encender / apagar (con las demas GPU y la VM de editores):
  bash deploy/clase.sh iniciar
  bash deploy/clase.sh terminar

Se apaga sola tras 30 min sin jobs (systemd timer adaceen-idle).
FIN
