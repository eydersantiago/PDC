# shellcheck shell=bash
# shellcheck disable=SC2034  # las variables las usan los scripts que cargan este archivo
# Valores y funciones compartidas por los scripts de Google Cloud:
# deploy/clase.sh, teardown.sh, create-vm.sh, clone-worker.sh,
# actualizar-gpus.sh y crear-cuenta-autoencendido.sh.
#
# Los nombres por defecto son los del piloto (docs/operacion/runbook.md). Las
# zonas de las VMs no se fijan: se leen de `gcloud compute instances list`,
# porque clone-worker.sh crea cada copia en la primera zona con cupo.

PROYECTO_POR_DEFECTO="adaceen-508504"
ZONA_POR_DEFECTO="us-central1-a"
BACKEND_PRODUCCION="https://app-adaceen-api-eyder05232002.azurewebsites.net"
# Orden en que se intentan encender (el de ADACEEN-GPU.bat): la V100 bajo
# demanda, la A100 Spot y la L4 original. La cuota GPUS_ALL_REGIONS es 1: se
# enciende una sola.
GPUS_POR_DEFECTO="adaceen-worker-v100 adaceen-worker-a100 adaceen-worker"
VM_EDITORES_POR_DEFECTO="adaceen-ws"
ROUTER_POR_DEFECTO="adaceen-router"
NAT_POR_DEFECTO="adaceen-nat"

info() { printf '[adaceen] %s\n' "$*"; }
ok() { printf '[adaceen] ✓ %s\n' "$*"; }
aviso() { printf '[adaceen] AVISO: %s\n' "$*" >&2; }
fallar() {
  printf '[adaceen] ERROR: %s\n' "$*" >&2
  exit 1
}

requiere_gcloud() {
  command -v gcloud >/dev/null 2>&1 ||
    fallar "no encuentro gcloud. Corre esto en Cloud Shell (https://shell.cloud.google.com) o instala la CLI de Google Cloud"
}

# Proyecto: la variable PROYECTO, el de `gcloud config` o el del piloto.
resolver_proyecto() {
  local proyecto="${PROYECTO:-}"
  if [ -z "$proyecto" ]; then
    proyecto="$(gcloud config get-value project 2>/dev/null || true)"
    proyecto="${proyecto%%[[:space:]]*}"
  fi
  if [ -z "$proyecto" ] || [ "$proyecto" = "(unset)" ]; then
    proyecto="$PROYECTO_POR_DEFECTO"
  fi
  printf '%s\n' "$proyecto"
}

# "us-central1-a" -> "us-central1"
region_de_zona() { printf '%s\n' "${1%-*}"; }

# Lee las VMs del proyecto a INSTANCIAS: una por linea, "nombre zona estado".
# Necesita PROYECTO. Devuelve 1 (con el motivo en INSTANCIAS_ERROR) si gcloud
# falla; entonces INSTANCIAS conserva la lectura anterior (un fallo pasajero de
# gcloud en medio de una espera no hace "desaparecer" las VMs).
INSTANCIAS=""
INSTANCIAS_ERROR=""
leer_instancias() {
  local err salida
  err="$(mktemp "${TMPDIR:-/tmp}/adaceen-gcloud.XXXXXX")"
  if salida="$(gcloud compute instances list --project="$PROYECTO" \
    --format='value(name,zone.basename(),status)' 2>"$err")"; then
    INSTANCIAS="$salida"
    INSTANCIAS_ERROR=""
    rm -f "$err"
    return 0
  fi
  INSTANCIAS_ERROR="$(resumir_error "$err")"
  rm -f "$err"
  return 1
}

# Zona y estado de una VM segun la ultima lectura (vacio si no existe).
zona_de() { printf '%s\n' "$INSTANCIAS" | awk -v n="$1" '$1 == n {print $2; exit}'; }
estado_de() { printf '%s\n' "$INSTANCIAS" | awk -v n="$1" '$1 == n {print $3; exit}'; }

# Avisa si un nombre esta en mas de una zona (GCE lo permite, por ejemplo al
# repetir clone-worker.sh): estos scripts manejan solo la primera.
avisar_repetidas() {
  local repetidas
  repetidas="$(printf '%s\n' "$INSTANCIAS" | awk 'NF { n[$1]++; z[$1] = z[$1] " " $2 } END { for (k in n) if (n[k] > 1) printf "%s (%s); ", k, substr(z[k], 2) }')"
  if [ -n "$repetidas" ]; then
    aviso "VMs con el mismo nombre en varias zonas: ${repetidas%; }. Solo se maneja la primera; borra la que sobre (gcloud compute instances delete <vm> --zone=<zona>)"
  fi
  return 0
}

# Encendida o de camino a estarlo.
esta_encendida() {
  case "$1" in RUNNING | PROVISIONING | STAGING | REPAIRING) return 0 ;; esac
  return 1
}

# Ultima linea util del error de gcloud (sin las lineas de ayuda), para mostrarla corta.
resumir_error() {
  local archivo="$1"
  [ -f "$archivo" ] || return 0
  grep -v '^[[:space:]]*$' "$archivo" | grep -v -i '^ *- *$' | tail -n 2 | tr '\n' ' ' | cut -c1-300
}

# Crea el router y el Cloud NAT si faltan: las VMs sin IP publica salen a
# internet por ahi (apt, npm, Ollama, Service Bus). Idempotente. RED_VPC: red
# de la subred (defecto default).
asegurar_nat() {
  local region="$1" router="${ROUTER:-$ROUTER_POR_DEFECTO}" nat="${NAT:-$NAT_POR_DEFECTO}" red="${RED_VPC:-default}"
  if ! gcloud compute routers describe "$router" --region="$region" --project="$PROYECTO" >/dev/null 2>&1; then
    info "creando el router $router en $region (red $red)"
    gcloud compute routers create "$router" --network="$red" --region="$region" --project="$PROYECTO" --quiet
  fi
  if ! gcloud compute routers nats describe "$nat" --router="$router" --region="$region" --project="$PROYECTO" >/dev/null 2>&1; then
    info "creando el Cloud NAT $nat (salida a internet de las VMs sin IP publica)"
    gcloud compute routers nats create "$nat" --router="$router" --region="$region" --project="$PROYECTO" \
      --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges --quiet
  fi
}
