#!/usr/bin/env bash
# Crea la VM del worker ADACEEN. Dos perfiles:
#   ./create-vm.sh cpu    -> sin GPU. Unico permitido en prueba gratuita. Modelo 3B.
#   ./create-vm.sh t4     -> T4 16 GB.  Barata.        7B holgado.
#   ./create-vm.sh l4     -> L4 24 GB.  Recomendado.   14B holgado, 32B entra.
#   ./create-vm.sh l4x2   -> 2x L4 48 GB. Para 70B. Necesita cuota global de 2.
#
# A100 (Spot) y V100 (estandar) no se crean de cero: se copian del disco
# de este worker con clone-worker.sh (driver, Ollama y modelo ya listos).
#
# Todos los perfiles con GPU requieren cuenta de PAGO y cuota aprobada.
# El disco sube a 120 GB en los perfiles L4: un 32B Q4 pesa ~20 GB.
#
# Los secretos van por metadata y NO quedan en el historial del shell:
# se leen de variables de entorno que exportas antes, o te los pide.
set -euo pipefail

PERFIL=${1:-cpu}
PROYECTO=${PROYECTO:-$(gcloud config get-value project 2>/dev/null)}
ZONA=${ZONA:-us-central1-a}
NOMBRE=${NOMBRE:-adaceen-worker}

if [ -z "${SB_CONN:-}" ]; then
  read -rsp "SAS namespace Listen+Send (colab-worker): " SB_CONN; echo
fi
if [ -z "${WORKER_SECRET:-}" ]; then
  read -rsp "WORKER_SHARED_SECRET (Enter si no se usa): " WORKER_SECRET; echo
fi

case "$PERFIL" in
  cpu)
    # c3 usa DDR5: mejor ancho de banda de memoria, que es el cuello en CPU.
    # Si c3 no esta disponible en tu zona, prueba n2-standard-8.
    MAQUINA=${MAQUINA:-c3-standard-8}
    MODELO=${MODELO:-qwen2.5:3b-instruct}
    IMAGEN=(--image-family=debian-12 --image-project=debian-cloud)
    EXTRA=()
    ;;
  t4)
    # 16 GB VRAM. Barata. 7B holgado, 13B justo.
    MAQUINA=${MAQUINA:-n1-standard-4}
    MODELO=${MODELO:-qwen2.5:7b-instruct}
    IMAGEN=(--image-family=debian-12 --image-project=debian-cloud)
    EXTRA=(--accelerator=type=nvidia-tesla-t4,count=1 --maintenance-policy=TERMINATE)
    ;;
  gpu|l4)
    # 24 GB VRAM. El punto dulce: 14B holgado, 32B entra.
    # g2-standard-8 da 8 vCPU / 32 GB RAM, suficiente para cargar un 32B.
    MAQUINA=${MAQUINA:-g2-standard-8}
    MODELO=${MODELO:-qwen2.5-coder:14b}
    IMAGEN=(--image-family=debian-12 --image-project=debian-cloud)
    EXTRA=(--accelerator=type=nvidia-l4,count=1 --maintenance-policy=TERMINATE)
    ;;
  l4x2)
    # 48 GB VRAM. Para un 70B Q4. Requiere cuota global de 2 GPUs.
    MAQUINA=${MAQUINA:-g2-standard-24}
    MODELO=${MODELO:-qwen2.5:72b-instruct}
    IMAGEN=(--image-family=debian-12 --image-project=debian-cloud)
    EXTRA=(--accelerator=type=nvidia-l4,count=2 --maintenance-policy=TERMINATE)
    ;;
  *) echo "perfil invalido: usa cpu, t4, gpu|l4 o l4x2"; exit 1 ;;
esac

# Por defecto IP publica efimera. Sin ella la VM no tiene salida a internet
# y el startup script muere en el primer apt-get, salvo que tengas Cloud NAT.
RED=()
if [ "${SIN_IP:-0}" = "1" ]; then
  RED=(--no-address)
  echo "AVISO: --no-address requiere Cloud NAT en la subred o la VM no tendra salida."
fi

echo "proyecto=$PROYECTO zona=$ZONA maquina=$MAQUINA modelo=$MODELO ip_publica=$([ "${SIN_IP:-0}" = "1" ] && echo no || echo si)"

gcloud compute instances create "$NOMBRE" \
  --project="$PROYECTO" \
  --zone="$ZONA" \
  --machine-type="$MAQUINA" \
  "${IMAGEN[@]}" \
  --boot-disk-size="${DISCO:-120}GB" \
  --boot-disk-type=pd-balanced \
  --provisioning-model=SPOT \
  --instance-termination-action=STOP \
  ${RED[@]+"${RED[@]}"} \
  --metadata-from-file=startup-script=startup-script.sh \
  --metadata=sb-conn="$SB_CONN",worker-secret="$WORKER_SECRET",model-text="$MODELO",idle-minutes=30,worker-id="gce-$PERFIL" \
  "${EXTRA[@]}"

cat <<FIN

Creada. Notas:

  IP publica         activada por defecto, solo para que la VM tenga SALIDA
                     (apt, npm, ollama, Service Bus). No hay nada escuchando:
                     el worker solo abre conexiones salientes. Para quitarla,
                     configura Cloud NAT y lanza con  SIN_IP=1 ./create-vm.sh
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

Encender / apagar a mano:
  gcloud compute instances start $NOMBRE --zone=$ZONA
  gcloud compute instances stop  $NOMBRE --zone=$ZONA

Se apaga sola tras 30 min sin jobs (systemd timer adaceen-idle).
FIN
