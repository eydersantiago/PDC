#!/usr/bin/env bash
# Crea una copia del worker ADACEEN con otra GPU a partir del disco del
# worker L4 (driver NVIDIA, Ollama y el modelo ya descargado).
#
#   bash deploy/gcp/clone-worker.sh a100   -> adaceen-worker-a100  a2-highgpu-1g, Spot
#   bash deploy/gcp/clone-worker.sh v100   -> adaceen-worker-v100  n1-standard-8 + V100, estandar
#
# Por que asi y no con una imagen de maquina: el disco de la L4 (serie G2)
# usa interfaz NVMe, y A2/N1 solo arrancan con SCSI. Una imagen de maquina
# conserva la interfaz y la creacion falla; un snapshot del disco no.
#
# La metadata de la VM original (sb-conn, worker-secret, heartbeat-url,
# heartbeat-token, branch, model-text...) se copia completa a una carpeta
# temporal privada (700) y se borra al terminar. Cambian worker-id
# (gce-<perfil>) e idle-minutes (180), y el startup-script es el de este
# repositorio (deploy/gcp/startup-script.sh), no la copia vieja de la L4.
# El script nunca imprime esos valores.
#
# Cuotas del proyecto (sep 2026): Google aprueba A100/H100 solo en Spot; la
# V100 bajo demanda ya venia habilitada. GPUS_ALL_REGIONS = 1: la L4 tiene
# que estar apagada mientras la copia arranca por primera vez.
set -euo pipefail

DIR_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/comun-gcp.sh
. "$DIR_SCRIPT/comun-gcp.sh"
requiere_gcloud

PERFIL=${1:?usa a100 o v100}
PROYECTO=$(resolver_proyecto)
ORIGEN=${ORIGEN:-adaceen-worker}
ORIGEN_ZONA=${ORIGEN_ZONA:-$ZONA_POR_DEFECTO}
SNAP=${SNAP:-adaceen-worker-snap}
ZONAS=${ZONAS:-"us-central1-a us-central1-b us-central1-c us-central1-f"}
STARTUP=${STARTUP:-$DIR_SCRIPT/startup-script.sh}

case "$PERFIL" in
  a100)
    MAQ=(--machine-type=a2-highgpu-1g --accelerator="type=nvidia-tesla-a100,count=1"
         --provisioning-model=SPOT --instance-termination-action=STOP) ;;
  v100)
    MAQ=(--machine-type=n1-standard-8 --accelerator="type=nvidia-tesla-v100,count=1"
         --provisioning-model=STANDARD --maintenance-policy=TERMINATE) ;;
  *) fallar "perfil invalido: usa a100 o v100" ;;
esac
NOMBRE="adaceen-worker-$PERFIL"

# GCE admite el mismo nombre en otra zona: correrlo otra vez crearia una
# segunda copia que clase.sh y teardown.sh no verian (manejan la primera) y
# que seguiria cobrando.
leer_instancias || fallar "gcloud no pudo listar las VMs de $PROYECTO: $INSTANCIAS_ERROR"
YA_EN="$(zona_de "$NOMBRE")"
if [ -n "$YA_EN" ]; then
  fallar "ya existe $NOMBRE en $YA_EN: no creo otra. Para rehacerla, borrala antes: gcloud compute instances delete $NOMBRE --zone=$YA_EN --project=$PROYECTO"
fi

if ! gcloud compute snapshots describe "$SNAP" --project="$PROYECTO" >/dev/null 2>&1; then
  info "creando el snapshot $SNAP del disco de $ORIGEN"
  gcloud compute snapshots create "$SNAP" --project="$PROYECTO" --source-disk="$ORIGEN" \
    --source-disk-zone="$ORIGEN_ZONA" --storage-location=us-central1
fi

META=$(mktemp -d "${TMPDIR:-/tmp}/adaceen-meta.XXXXXX")
chmod 700 "$META"
trap 'rm -rf "$META"' EXIT
# Cada clave de la metadata a un archivo con su nombre (las claves de GCE son
# letras, numeros, - y _). Los valores van por stdin: nunca se imprimen.
gcloud compute instances describe "$ORIGEN" --zone="$ORIGEN_ZONA" --project="$PROYECTO" --format=json |
  python3 -c '
import json, os, re, sys
dest = sys.argv[1]
items = (json.load(sys.stdin).get("metadata") or {}).get("items") or []
for item in items:
    clave = str(item.get("key", ""))
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", clave):
        continue
    with open(os.path.join(dest, clave), "w") as f:
        f.write(str(item.get("value", "")))
' "$META"
[ -s "$META/sb-conn" ] || fallar "la VM $ORIGEN no tiene la metadata sb-conn: no hay nada que copiar"
[ -s "$META/model-text" ] || printf '%s' "qwen2.5-coder:14b" >"$META/model-text"
if [ -f "$STARTUP" ]; then
  cp "$STARTUP" "$META/startup-script"
else
  aviso "no encuentro $STARTUP: la copia usa el startup-script de $ORIGEN"
fi
printf '%s' "gce-$PERFIL" >"$META/worker-id"
printf '%s' "180" >"$META/idle-minutes"
if [ ! -s "$META/heartbeat-token" ]; then
  aviso "$ORIGEN no tiene heartbeat-token en su metadata: la copia atendera, pero sin latido (clase.sh y /api/agent/health no la veran)"
fi
DESDE_ARCHIVO=""
for archivo in "$META"/*; do
  DESDE_ARCHIVO="${DESDE_ARCHIVO:+$DESDE_ARCHIVO,}$(basename "$archivo")=$archivo"
done

for Z in $ZONAS; do
  info "probando $NOMBRE en $Z"
  if gcloud compute instances create "$NOMBRE" --project="$PROYECTO" --zone="$Z" "${MAQ[@]}" --no-address \
       --create-disk="boot=yes,name=$NOMBRE,source-snapshot=$SNAP,size=120,type=pd-balanced,auto-delete=yes" \
       --metadata-from-file="$DESDE_ARCHIVO"; then
    ok "creada en $Z. deploy/clase.sh la encuentra sola (y en ADACEEN-GPU.bat va en GPU*_Z)."
    exit 0
  fi
done
fallar "ninguna zona tuvo cupo para $PERFIL. Prueba mas tarde."
