#!/usr/bin/env bash
# Startup script para el worker ADACEEN en Compute Engine.
# Sirve igual para VM solo-CPU y para VM con GPU: detecta el hardware y se adapta.
# Los secretos llegan por metadata de instancia (ver create-vm.sh).
set -euo pipefail
exec > >(tee -a /var/log/adaceen-startup.log) 2>&1
export HOME=${HOME:-/root}
echo "=== adaceen startup $(date -Is) ==="

meta() {
  curl -sf -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" || true
}

REPO_URL=$(meta repo-url);            REPO_URL=${REPO_URL:-https://github.com/eydersantiago/PDC.git}
BRANCH=$(meta branch);                BRANCH=${BRANCH:-claude/amazing-fermi-f6a23q}
MODEL_TEXT=$(meta model-text);        MODEL_TEXT=${MODEL_TEXT:-qwen2.5:3b-instruct}
SB_CONN=$(meta sb-conn)
WORKER_SECRET=$(meta worker-secret)
TIMEOUT_MS=$(meta timeout-ms);        TIMEOUT_MS=${TIMEOUT_MS:-180000}
IDLE_MINUTES=$(meta idle-minutes);    IDLE_MINUTES=${IDLE_MINUTES:-30}
WORKER_ID=$(meta worker-id);          WORKER_ID=${WORKER_ID:-gce-$(hostname)}
# Latido hacia el API (A15.4). Opcionales: sin ellos el worker funciona igual.
HEARTBEAT_URL=$(meta heartbeat-url)
HEARTBEAT_TOKEN=$(meta heartbeat-token)

if [ -z "$SB_CONN" ]; then
  echo "FATAL: falta la metadata sb-conn"; exit 1
fi

# --- driver NVIDIA, solo si hay GPU y aun no esta ---
if lspci 2>/dev/null | grep -qi nvidia && ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "--- GPU detectada, instalando driver"
  apt-get update -qq && apt-get install -y -qq python3 pciutils
  curl -fsSL -o /tmp/install_gpu_driver.py \
    https://raw.githubusercontent.com/GoogleCloudPlatform/compute-gpu-installation/main/linux/install_gpu_driver.py
  python3 /tmp/install_gpu_driver.py --force || echo "AVISO: el driver fallo, seguimos en CPU"
fi

# --- dependencias base ---
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates zstd

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi

if ! command -v ollama >/dev/null 2>&1; then
  curl -fsSL https://ollama.com/install.sh | sh
fi

# --- repo ---
install -d -o root -g root /opt/adaceen
if [ -d /opt/adaceen/repo/.git ]; then
  git -C /opt/adaceen/repo fetch --depth 1 origin "$BRANCH"
  git -C /opt/adaceen/repo checkout -q "$BRANCH"
  git -C /opt/adaceen/repo reset --hard -q FETCH_HEAD
else
  git clone --depth 1 -b "$BRANCH" "$REPO_URL" /opt/adaceen/repo
fi
cd /opt/adaceen/repo
npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# --- .env.worker (600, solo root) ---
umask 077
cat > /opt/adaceen/repo/.env.worker <<ENVEOF
AGENT_TARGET=queue
AZURE_SERVICEBUS_CONNECTION_STRING=$SB_CONN
JOBS_QUEUE_NAME=llm-jobs
RESULTS_QUEUE_NAME=llm-results-sessions
WORKER_SHARED_SECRET=$WORKER_SECRET
QUEUE_REQUEST_TIMEOUT_MS=$TIMEOUT_MS
QUEUE_WORKER_ID=$WORKER_ID
QUEUE_WORKER_MAX_ATTEMPTS=2
QUEUE_WORKER_RETRY_DELAY_MS=2000
QUEUE_WORKER_LOCK_RENEWAL_MS=0
OPENAI_BASE=http://127.0.0.1:11434/v1
OPENAI_API_KEY=dummy
OLLAMA_BASE_URL=http://127.0.0.1:11434
MODEL_TEXT=$MODEL_TEXT
ADACEEN_LOG_LEVEL=info
ADACEEN_LOG_STACKS=0
WORKER_HEARTBEAT_URL=$HEARTBEAT_URL
WORKER_HEARTBEAT_TOKEN=$HEARTBEAT_TOKEN
WORKER_HEARTBEAT_INTERVAL_MS=30000
ENVEOF
chmod 600 /opt/adaceen/repo/.env.worker
umask 022

# --- ollama como servicio (su instalador ya crea uno; nos aseguramos) ---
systemctl enable --now ollama || true
for _ in $(seq 1 90); do
  curl -sf http://127.0.0.1:11434/api/tags >/dev/null && break
  sleep 2
done

# La descarga se pide por la API, NO con `ollama pull`. Dos razones:
#   1. Los startup scripts corren sin $HOME y el CLI entra en panic.
#   2. Aunque exportes HOME=/root, el CLI guardaria en /root/.ollama mientras
#      que el servicio corre como usuario `ollama` y lee de
#      /usr/share/ollama/.ollama. El modelo quedaria donde nadie lo busca.
# Pidiendoselo al servidor, lo guarda en su propio directorio.
echo "--- descargando $MODEL_TEXT (puede tardar varios minutos)"
curl -sS -X POST http://127.0.0.1:11434/api/pull \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL_TEXT\"}" | tail -2

if ! curl -sf http://127.0.0.1:11434/api/tags | grep -q "$MODEL_TEXT"; then
  echo "FATAL: $MODEL_TEXT no quedo disponible en el servidor de Ollama"
  exit 1
fi
echo "--- modelo listo"

# --- worker como servicio ---
cat > /etc/systemd/system/adaceen-worker.service <<'SVCEOF'
[Unit]
Description=ADACEEN queue worker
After=network-online.target ollama.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/adaceen/repo
ExecStart=/usr/bin/npm run worker:queue
Restart=always
RestartSec=10
StandardOutput=append:/var/log/adaceen-worker.log
StandardError=append:/var/log/adaceen-worker.log

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
# restart y no enable --now: en cada arranque despues del primero el servicio
# ya se levanto solo al bootear, con el .env.worker y el codigo de la vez
# anterior. Sin reiniciarlo no toma el worker-id nuevo ni el git pull de arriba.
systemctl enable adaceen-worker
systemctl restart adaceen-worker

# --- apagado por inactividad ---
# El worker no escribe nada mientras espera, asi que la mtime del log es la
# ultima señal de actividad. Gracia de 20 min tras el arranque para no apagarse
# antes de que llegue el primer job.
cat > /usr/local/bin/adaceen-idle-check <<IDLEEOF
#!/usr/bin/env bash
set -eu
IDLE_MINUTES=$IDLE_MINUTES
LOG=/var/log/adaceen-worker.log
UP=\$(awk '{print int(\$1/60)}' /proc/uptime)
[ "\$UP" -lt 20 ] && exit 0
[ -f "\$LOG" ] || exit 0
LAST=\$(( ( \$(date +%s) - \$(stat -c %Y "\$LOG") ) / 60 ))
if [ "\$LAST" -ge "\$IDLE_MINUTES" ]; then
  logger -t adaceen "inactivo \$LAST min, apagando"
  /sbin/shutdown -h now
fi
IDLEEOF
chmod +x /usr/local/bin/adaceen-idle-check

cat > /etc/systemd/system/adaceen-idle.service <<'ISVCEOF'
[Unit]
Description=Apagar la VM si el worker lleva rato sin actividad
[Service]
Type=oneshot
ExecStart=/usr/local/bin/adaceen-idle-check
ISVCEOF

cat > /etc/systemd/system/adaceen-idle.timer <<'ITMREOF'
[Unit]
Description=Chequeo de inactividad cada 5 min
[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
ITMREOF

systemctl daemon-reload
systemctl enable --now adaceen-idle.timer

echo "=== listo. worker=$WORKER_ID modelo=$MODEL_TEXT idle=${IDLE_MINUTES}min ==="
