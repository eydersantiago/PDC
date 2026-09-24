#!/usr/bin/env bash
# Crea una copia del worker ADACEEN con otra GPU a partir del disco del
# worker L4 (driver NVIDIA, Ollama y el modelo ya descargado).
#
#   ./clone-worker.sh a100   -> adaceen-worker-a100  a2-highgpu-1g, Spot
#   ./clone-worker.sh v100   -> adaceen-worker-v100  n1-standard-8 + V100, estandar
#
# Por que asi y no con una imagen de maquina: el disco de la L4 (serie G2)
# usa interfaz NVMe, y A2/N1 solo arrancan con SCSI. Una imagen de maquina
# conserva la interfaz y la creacion falla; un snapshot del disco no.
#
# La metadata (startup-script, sb-conn, worker-secret) se copia de la VM
# original a una carpeta temporal privada (700) y se borra al terminar.
# El script nunca imprime esos valores.
#
# Cuotas del proyecto (sep 2026): Google aprueba A100/H100 solo en Spot; la
# V100 bajo demanda ya venia habilitada. GPUS_ALL_REGIONS = 1: la L4 tiene
# que estar apagada mientras la copia arranca por primera vez.
set -euo pipefail

PERFIL=${1:?usa a100 o v100}
ORIGEN=${ORIGEN:-adaceen-worker}
ORIGEN_ZONA=${ORIGEN_ZONA:-us-central1-a}
SNAP=${SNAP:-adaceen-worker-snap}
ZONAS=${ZONAS:-"us-central1-a us-central1-b us-central1-c us-central1-f"}

case "$PERFIL" in
  a100)
    MAQ=(--machine-type=a2-highgpu-1g --accelerator=type=nvidia-tesla-a100,count=1
         --provisioning-model=SPOT --instance-termination-action=STOP) ;;
  v100)
    MAQ=(--machine-type=n1-standard-8 --accelerator=type=nvidia-tesla-v100,count=1
         --provisioning-model=STANDARD --maintenance-policy=TERMINATE) ;;
  *) echo "perfil invalido: usa a100 o v100"; exit 1 ;;
esac
NOMBRE="adaceen-worker-$PERFIL"

if ! gcloud compute snapshots describe "$SNAP" >/dev/null 2>&1; then
  echo "--- creando el snapshot $SNAP del disco de $ORIGEN"
  gcloud compute snapshots create "$SNAP" --source-disk="$ORIGEN" \
    --source-disk-zone="$ORIGEN_ZONA" --storage-location=us-central1
fi

META=$(mktemp -d); chmod 700 "$META"; trap 'rm -rf "$META"' EXIT
gcloud compute instances describe "$ORIGEN" --zone="$ORIGEN_ZONA" --format=json |
  python3 -c '
import json, sys, os
m = {i["key"]: i["value"] for i in json.load(sys.stdin)["metadata"]["items"]}
for k in ("startup-script", "sb-conn", "worker-secret"):
    open(os.path.join(sys.argv[1], k), "w").write(m.get(k, ""))
open(os.path.join(sys.argv[1], "model-text"), "w").write(m.get("model-text", "qwen2.5-coder:14b"))
' "$META"
MODELO=$(cat "$META/model-text")

for Z in $ZONAS; do
  echo "--- probando $NOMBRE en $Z"
  if gcloud compute instances create "$NOMBRE" --zone="$Z" "${MAQ[@]}" --no-address \
       --create-disk=boot=yes,name="$NOMBRE",source-snapshot="$SNAP",size=120,type=pd-balanced,auto-delete=yes \
       --metadata-from-file=startup-script="$META/startup-script",sb-conn="$META/sb-conn",worker-secret="$META/worker-secret" \
       --metadata=model-text="$MODELO",idle-minutes=180,worker-id="gce-$PERFIL"; then
    echo "--- creada en $Z. Pon esa zona en ADACEEN-GPU.bat (GPU*_Z)."
    exit 0
  fi
done
echo "Ninguna zona tuvo cupo para $PERFIL. Prueba mas tarde."
exit 1
