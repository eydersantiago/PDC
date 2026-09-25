#!/usr/bin/env bash
# Startup script para el worker ADACEEN en Compute Engine.
# Sirve igual para VM solo-CPU y para VM con GPU: detecta el hardware y se adapta.
# Los secretos llegan por metadata de instancia (ver create-vm.sh).
#
# OJO: la VM corre la copia de este archivo que tiene en su metadata
# (startup-script), no la del repositorio. Tras cambiarlo, subelo a las GPU con
#   bash deploy/gcp/actualizar-gpus.sh
#
# Metadata que lee:
#   sb-conn (obligatoria), worker-secret, model-text, timeout-ms, worker-id,
#   repo-url, heartbeat-url, heartbeat-token
#   branch         rama de PDC (sin ella: la del clon que ya tenga la VM, o
#                  feature/azure-config-observability si no hay clon)
#   idle-minutes   minutos sin trabajos antes de apagar la VM (defecto 30; 0 = no apagar)
set -euo pipefail

# ---------------------------------------------------------------- funciones
# Van antes que nada para poder probarlas cargando el archivo con `source`
# (deploy/gcp/operacion.test.mjs).

# Deja en <dir> el ultimo commit de <rama>. El clon es --depth 1 de UNA rama:
# antes se hacia "git checkout <rama>" y, si la metadata branch de una GPU ya
# creada cambiaba, esa rama no existia en el clon y el arranque abortaba (el
# worker seguia con el codigo viejo y sin reiniciarse). Ahora se trae la rama
# pedida y el checkout se apunta a ese commit con -B.
# Si no se puede traer (red, rama inexistente) se sigue con el codigo que habia.
sincronizar_repo() {
  local url="$1" rama="$2" dir="$3"
  [ -n "$dir" ] || return 1
  if [ ! -d "$dir/.git" ]; then
    # Copia de solo lectura: si quedo a medias, se clona de nuevo.
    rm -rf "$dir"
    git clone -q --depth 1 --branch "$rama" "$url" "$dir" || return 1
    return 0
  fi
  git -C "$dir" remote set-url origin "$url" || return 1
  if git -C "$dir" fetch -q --depth 1 origin "$rama"; then
    git -C "$dir" checkout -q -f -B "$rama" FETCH_HEAD || return 1
  else
    echo "AVISO: no se pudo traer la rama $rama de $url; el worker sigue con el codigo que ya estaba ($(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?'))"
  fi
  return 0
}

# Rama que se clona:
#   resolver_rama <metadata branch> <dir del clon> <rama por defecto>
# Con la metadata branch, esa. Sin ella y con un clon que ya existe, la rama
# en que esta ese clon: las copias A100/V100 hechas con el clone-worker.sh
# anterior no tienen metadata branch, y su clon (el del disco de la L4) esta en
# la rama de la L4. Antes el checkout a la rama por defecto abortaba y seguian
# con ese codigo; ahora que el cambio de rama funciona, sin esto pasarian a la
# rama por defecto (otro worker, quiza sin latido). Sin metadata ni clon: la
# rama por defecto.
resolver_rama() {
  local pedida="$1" dir="$2" defecto="$3" actual=""
  if [ -n "$pedida" ]; then
    printf '%s\n' "$pedida"
    return 0
  fi
  if [ -d "$dir/.git" ]; then
    actual="$(git -C "$dir" symbolic-ref -q --short HEAD 2>/dev/null || true)"
  fi
  printf '%s\n' "${actual:-$defecto}"
}

# Escribe el chequeo de inactividad que corre el timer adaceen-idle cada 5 min.
#   escribir_chequeo_inactividad <destino> <minutos> <archivo de actividad> [archivo uptime] [comando de apagado]
# La ultima actividad es la fecha de modificacion del archivo de actividad:
#   - el que escribe el worker tras cada trabajo (QUEUE_WORKER_LAST_JOB_FILE);
#   - o, con una rama cuyo worker todavia no lo escribe, el log del worker
#     (como antes: un latido fallido renueva el log y la VM puede no apagarse).
# La cuenta empieza, como pronto, al arrancar la VM, y hay 20 min de gracia
# tras el arranque para que llegue el primer trabajo. 0 minutos = no apagar.
escribir_chequeo_inactividad() {
  local destino="$1" minutos="$2" fuente="$3"
  local uptime="${4:-/proc/uptime}" apagar="${5:-/sbin/shutdown -h now}"
  {
    echo '#!/usr/bin/env bash'
    echo '# Generado por startup-script.sh (timer adaceen-idle): apaga la VM tras IDLE_MINUTES sin trabajos.'
    printf 'IDLE_MINUTES=%q\n' "$minutos"
    printf 'FUENTE=%q\n' "$fuente"
    printf 'UPTIME=%q\n' "$uptime"
    printf 'apagar() { %s; }\n' "$apagar"
    cat <<'IDLEEOF'
set -eu
[ "$IDLE_MINUTES" -gt 0 ] || exit 0
UP=$(awk '{print int($1)}' "$UPTIME")
if [ "$UP" -lt 1200 ]; then exit 0; fi
AHORA=$(date +%s)
REF=$((AHORA - UP))
if [ -f "$FUENTE" ]; then
  M=$(stat -c %Y "$FUENTE")
  if [ "$M" -gt "$REF" ]; then REF=$M; fi
fi
LAST=$(( (AHORA - REF) / 60 ))
if [ "$LAST" -ge "$IDLE_MINUTES" ]; then
  logger -t adaceen "inactivo $LAST min (sin trabajos), apagando" 2>/dev/null || true
  apagar
fi
IDLEEOF
  } >"$destino"
  chmod 755 "$destino"
}

# Rotacion de los logs del worker y del arranque: `copytruncate` porque
# systemd los tiene abiertos en modo append. La corre el logrotate diario de
# Debian y, para que un log desbocado no llene el disco, un timer propio cada hora.
escribir_logrotate() {
  local destino="$1"
  cat >"$destino" <<'ROTEOF'
# Generado por startup-script.sh
/var/log/adaceen-worker.log /var/log/adaceen-startup.log {
  size 50M
  rotate 5
  compress
  delaycompress
  missingok
  notifempty
  copytruncate
}
ROTEOF
  chmod 644 "$destino"
}

# Cargado con source (pruebas): solo las funciones. `return` solo vale dentro
# de un source; ejecutado (como lo corre la VM, o por stdin) sigue de largo.
if (return 0 2>/dev/null); then return 0; fi

# ---------------------------------------------------------------- arranque
exec > >(tee -a /var/log/adaceen-startup.log) 2>&1
export HOME=${HOME:-/root}
echo "=== adaceen startup $(date -Is) ==="

meta() {
  curl -sf -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" || true
}

REPO_URL=$(meta repo-url);            REPO_URL=${REPO_URL:-https://github.com/eydersantiago/PDC.git}
# Sin metadata branch sigue en la rama del clon que ya tiene (ver resolver_rama).
BRANCH_META=$(meta branch)
BRANCH=$(resolver_rama "$BRANCH_META" /opt/adaceen/repo feature/azure-config-observability)
if [ -z "$BRANCH_META" ]; then
  echo "--- sin metadata branch: uso la rama $BRANCH (la del clon, o la de produccion si no hay clon)"
fi
MODEL_TEXT=$(meta model-text);        MODEL_TEXT=${MODEL_TEXT:-qwen2.5:3b-instruct}
SB_CONN=$(meta sb-conn)
WORKER_SECRET=$(meta worker-secret)
TIMEOUT_MS=$(meta timeout-ms);        TIMEOUT_MS=${TIMEOUT_MS:-180000}
IDLE_MINUTES=$(meta idle-minutes);    IDLE_MINUTES=${IDLE_MINUTES:-30}
WORKER_ID=$(meta worker-id);          WORKER_ID=${WORKER_ID:-gce-$(hostname)}
# Latido hacia el API (A15.4). Opcionales: sin ellos el worker funciona igual.
HEARTBEAT_URL=$(meta heartbeat-url)
HEARTBEAT_TOKEN=$(meta heartbeat-token)
# Lo escribe el worker tras cada trabajo; lo lee el apagado por inactividad.
ULTIMO_TRABAJO=/var/lib/adaceen/ultimo-trabajo

if ! [[ $IDLE_MINUTES =~ ^[0-9]{1,5}$ ]]; then
  echo "AVISO: la metadata idle-minutes no es un numero; se usan 30 min"
  IDLE_MINUTES=30
fi
IDLE_MINUTES=$((10#$IDLE_MINUTES))

if [ -z "$SB_CONN" ]; then
  echo "FATAL: falta la metadata sb-conn"; exit 1
fi

# --- precarga del modelo en la GPU, en paralelo con el resto del arranque ---
# Leer el modelo (~9 GB) del disco tarda ~55 s: es el tope de lectura de un
# pd-balanced de 120 GB. Se lanza ya, para que coincida con apt/npm/git en
# vez de sumarse al final. OLLAMA_KEEP_ALIVE=-1 evita que Ollama lo saque de
# la GPU tras 5 min sin preguntas (la VM ya se apaga sola por inactividad).
if [ ! -f /etc/systemd/system/ollama.service.d/keepalive.conf ]; then
  install -d /etc/systemd/system/ollama.service.d
  printf '[Service]\nEnvironment="OLLAMA_KEEP_ALIVE=-1"\n' > /etc/systemd/system/ollama.service.d/keepalive.conf
  systemctl daemon-reload
  systemctl try-restart ollama || true
fi
(
  for _ in $(seq 1 150); do curl -sf http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 2; done
  T0=$(date +%s)
  curl -sf -X POST http://127.0.0.1:11434/api/generate -H "Content-Type: application/json" \
    -d "{\"model\":\"$MODEL_TEXT\",\"keep_alive\":-1}" >/dev/null \
    && echo "--- modelo precargado en la GPU en $(( $(date +%s) - T0 )) s"
) &

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
apt-get install -y -qq git curl ca-certificates zstd logrotate

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi

if ! command -v ollama >/dev/null 2>&1; then
  curl -fsSL https://ollama.com/install.sh | sh
fi

# --- repo ---
install -d -o root -g root /opt/adaceen
if ! sincronizar_repo "$REPO_URL" "$BRANCH" /opt/adaceen/repo; then
  echo "FATAL: no se pudo clonar $REPO_URL (rama $BRANCH)"; exit 1
fi
echo "--- PDC $(git -C /opt/adaceen/repo rev-parse --abbrev-ref HEAD) @ $(git -C /opt/adaceen/repo rev-parse --short HEAD)"
cd /opt/adaceen/repo
npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# Una rama anterior a QUEUE_WORKER_LAST_JOB_FILE no escribe el archivo de
# ultimo trabajo: con ella el apagado sigue mirando el log (como antes).
ACTIVIDAD=/var/log/adaceen-worker.log
if grep -q QUEUE_WORKER_LAST_JOB_FILE scripts/service-bus-ollama-worker.ts 2>/dev/null; then
  ACTIVIDAD=$ULTIMO_TRABAJO
  install -d -m 755 "$(dirname "$ULTIMO_TRABAJO")"
else
  echo "AVISO: el worker de la rama $BRANCH no escribe $ULTIMO_TRABAJO; el apagado por inactividad mira el log"
fi
# Sin latido la GPU atiende, pero ni /api/agent/health ni deploy/clase.sh la ven.
if [ -n "$HEARTBEAT_TOKEN" ] && ! grep -q WORKER_HEARTBEAT_URL scripts/service-bus-ollama-worker.ts 2>/dev/null; then
  echo "AVISO: el worker de la rama $BRANCH no manda latido (A15.4); usa una rama con latido: RAMA=<rama> bash deploy/gcp/actualizar-gpus.sh"
fi

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
QUEUE_WORKER_LAST_JOB_FILE=$ULTIMO_TRABAJO
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

# --- rotacion de logs ---
escribir_logrotate /etc/logrotate.d/adaceen-worker
cat > /etc/systemd/system/adaceen-logrotate.service <<'LRSVCEOF'
[Unit]
Description=Rotar los logs del worker ADACEEN si pasan de 50 MB
[Service]
Type=oneshot
ExecStart=/usr/sbin/logrotate /etc/logrotate.d/adaceen-worker
LRSVCEOF
cat > /etc/systemd/system/adaceen-logrotate.timer <<'LRTMREOF'
[Unit]
Description=Revisar cada hora el tamano de los logs del worker ADACEEN
[Timer]
OnBootSec=15min
OnUnitActiveSec=1h
[Install]
WantedBy=timers.target
LRTMREOF

# --- apagado por inactividad ---
# Ver escribir_chequeo_inactividad arriba: cuenta desde el ultimo trabajo
# atendido (o desde el arranque), no desde la ultima linea del log.
escribir_chequeo_inactividad /usr/local/bin/adaceen-idle-check "$IDLE_MINUTES" "$ACTIVIDAD"

cat > /etc/systemd/system/adaceen-idle.service <<'ISVCEOF'
[Unit]
Description=Apagar la VM si el worker lleva rato sin trabajos
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
systemctl enable --now adaceen-logrotate.timer || echo "AVISO: no se pudo activar la rotacion horaria del log"
if [ "$IDLE_MINUTES" -gt 0 ]; then
  systemctl enable --now adaceen-idle.timer
else
  echo "--- idle-minutes=0: la VM no se apaga sola"
  systemctl disable --now adaceen-idle.timer 2>/dev/null || true
fi

echo "=== listo. worker=$WORKER_ID modelo=$MODEL_TEXT idle=${IDLE_MINUTES}min (actividad: $ACTIVIDAD) ==="
