#!/usr/bin/env bash
# Monta ADACEEN en otra cuenta o proyecto de Google Cloud con creditos, desde la configuracion
# exportada con deploy/gcp/exportar-cuenta.sh. Corre en Cloud Shell DE LA CUENTA NUEVA.
#
#   PROYECTO=<id-del-proyecto-nuevo> bash deploy/gcp/montar-cuenta-nueva.sh ~/adaceen-cuenta.env [perfil]
#
#   perfil: v100 (defecto; la del piloto), l4, t4 o cpu (sin GPU, modelo 3B; sirve en prueba gratuita)
#
# Que hace (se puede repetir: lo que ya existe se deja):
#   1. revisa que el proyecto tenga facturacion (sin ella no hay VMs) y avisa si la cuota de GPU es 0;
#   2. activa Compute Engine e IAP, la regla de firewall para SSH por IAP y el Cloud NAT;
#   3. crea la VM de editores (adaceen-ws) con el MISMO token del agente: Azure no cambia;
#   4. crea la GPU en modo clase (estandar) con la misma cola, latido y clave: el backend la ve sola.
# Nada de esto toca Azure ni el proyecto original. El worker de la cuenta nueva se llama
# gce-<perfil>-b para distinguirlo en /api/agent/backend.
#
# Importante:
#   - Prueba gratuita: Google NO deja poner GPU hasta pasar la cuenta a pago (los creditos se
#     conservan) y la cuota de GPU nueva es 0: pidela en IAM y administracion → Cuotas
#     («GPUs (all regions)» = 1 y la de tu GPU en la region). Puede tardar o ser rechazada.
#   - Solo UNA VM de editores debe estar encendida a la vez (el agente se conecta al backend con el
#     mismo token): apaga la de la cuenta vieja antes de encender esta.
#   - Despues, para encender y apagar: PROYECTO=<id-nuevo> bash deploy/clase.sh iniciar | terminar.
#     En ADACEEN-GPU.bat cambia el proyecto por el nuevo.
set -euo pipefail

DIR_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/comun-gcp.sh
. "$DIR_SCRIPT/comun-gcp.sh"
requiere_gcloud

ARCHIVO=${1:-}
PERFIL=${2:-${PERFIL_GPU:-v100}}
[ -n "$ARCHIVO" ] && [ -f "$ARCHIVO" ] || fallar "uso: PROYECTO=<id-nuevo> bash deploy/gcp/montar-cuenta-nueva.sh <archivo.env> [v100|l4|t4|cpu]"
case "$PERFIL" in v100 | l4 | t4 | cpu) ;; *) fallar "perfil invalido: v100, l4, t4 o cpu" ;; esac
[ -n "${PROYECTO:-}" ] || fallar "indica el proyecto NUEVO: PROYECTO=<id> bash $0 $ARCHIVO"

# shellcheck disable=SC1090
set -a; . "$ARCHIVO"; set +a
for clave in SB_CONN HEARTBEAT_TOKEN WORKSPACE_AGENT_TOKEN API_URL; do
  [ -n "${!clave:-}" ] || fallar "al archivo le falta $clave: vuelve a exportarlo con exportar-cuenta.sh"
done
if [ "${ORIGEN_PROYECTO:-}" = "$PROYECTO" ] && [ "${FORZAR:-0}" != "1" ]; then
  fallar "$PROYECTO es el proyecto de origen; este script es para otro proyecto (FORZAR=1 para seguir igual)"
fi
ZONA=${ZONA_NUEVA:-${ZONA:-$ZONA_POR_DEFECTO}}
REGION=$(region_de_zona "$ZONA")

info "proyecto nuevo: $PROYECTO  zona: $ZONA  GPU: $PERFIL  rama: ${RAMA:-}"

# 1. Facturacion y cuota
FACTURACION=$(gcloud billing projects describe "$PROYECTO" --format='value(billingEnabled)' 2>/dev/null || true)
if [ "$FACTURACION" != "True" ]; then
  fallar "el proyecto $PROYECTO no tiene una cuenta de facturacion vinculada (Facturacion → Vincular). Sin ella no se pueden crear VMs."
fi
ok "facturacion activa"

info "activando Compute Engine e IAP (la primera vez tarda ~1 min)"
gcloud services enable compute.googleapis.com iap.googleapis.com --project="$PROYECTO" --quiet

if [ "$PERFIL" != "cpu" ]; then
  CUOTA=$(gcloud compute project-info describe --project="$PROYECTO" --format=json 2>/dev/null \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(next((int(q['limit']) for q in d.get('quotas',[]) if q.get('metric')=='GPUS_ALL_REGIONS'), -1))" 2>/dev/null || echo -1)
  if [ "$CUOTA" = "0" ]; then
    aviso "la cuota «GPUs (all regions)» es 0: la GPU no va a encender hasta que Google apruebe 1 (IAM y administracion → Cuotas). La VM se crea igual."
  fi
fi

# 2. Red: SSH por IAP y salida a internet por Cloud NAT (las VMs no llevan IP publica)
if ! gcloud compute firewall-rules describe adaceen-iap-ssh --project="$PROYECTO" >/dev/null 2>&1; then
  info "creando la regla de firewall adaceen-iap-ssh (SSH solo desde IAP)"
  gcloud compute firewall-rules create adaceen-iap-ssh --project="$PROYECTO" --network="${RED_VPC:-default}" \
    --direction=INGRESS --allow=tcp:22 --source-ranges=35.235.240.0/20 --quiet
fi
asegurar_nat "$REGION"
leer_instancias || fallar "no pude listar las VMs de $PROYECTO: $INSTANCIAS_ERROR"

# 3. VM de editores con el mismo token del agente (Azure no cambia)
VM_WS=${VM_EDITORES:-$VM_EDITORES_POR_DEFECTO}
if [ -n "$(zona_de "$VM_WS")" ]; then
  ok "$VM_WS ya existe"
else
  info "creando la VM de editores $VM_WS (${TIPO_WS:-e2-standard-4})"
  (
    cd "$DIR_SCRIPT/workspaces"
    PROYECTO="$PROYECTO" ZONA="$ZONA" NOMBRE="$VM_WS" TAMANO="${TIPO_WS:-e2-standard-4}" API_URL="$API_URL" \
      WORKSPACE_AGENT_TOKEN="$WORKSPACE_AGENT_TOKEN" SCAN_WORKER_KEY="${SCAN_WORKER_KEY:-}" \
      bash create-ws-vm.sh 2>&1 | sed "s/$WORKSPACE_AGENT_TOKEN/(el mismo token de Azure)/g"
  )
fi

# 4. GPU en modo clase (estandar), con la misma cola, latido y clave
case "$PERFIL" in
  v100) NOMBRE_GPU=adaceen-worker-v100 ;;
  l4) NOMBRE_GPU=adaceen-worker ;;
  t4) NOMBRE_GPU=adaceen-worker-t4 ;;
  cpu) NOMBRE_GPU=adaceen-worker-cpu ;;
esac
if [ -n "$(zona_de "$NOMBRE_GPU")" ]; then
  ok "$NOMBRE_GPU ya existe"
else
  info "creando la GPU $NOMBRE_GPU (modo clase)"
  PROYECTO="$PROYECTO" ZONA="$ZONA" NOMBRE="$NOMBRE_GPU" RAMA="${RAMA:-feature/azure-config-observability}" \
    API_URL="$API_URL" MODELO="${MODELO:-}" SB_CONN="$SB_CONN" WORKER_SECRET="${WORKER_SECRET:-}" \
    HEARTBEAT_TOKEN="$HEARTBEAT_TOKEN" MODALIDAD=estandar WORKER_ID="gce-$PERFIL-b" \
    IDLE_MINUTOS="${IDLE_MINUTOS:-180}" \
    bash "$DIR_SCRIPT/create-vm.sh" "$PERFIL"
fi

cat <<FIN

Listo en $PROYECTO. Siguientes pasos:
  1. Apaga la VM de editores de la cuenta vieja (solo una puede estar encendida).
  2. Enciende la clase en la cuenta nueva:
       PROYECTO=$PROYECTO GPUS="$NOMBRE_GPU" bash deploy/clase.sh iniciar
     La primera vez la GPU instala driver, Ollama y el modelo (~10-15 min).
  3. Comprueba en /api/agent/backend que aparece gce-$PERFIL-b.
FIN
