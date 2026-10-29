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
#   horario        horario del tutor, HH:MM-HH:MM (deploy/gcp/horario-gpu.sh, 28-10-2026):
#                  dentro de el la VM NO se apaga por inactividad (la apaga la
#                  programacion de instancias de Google a la hora de fin); fuera,
#                  se apaga tras idle-minutes-noche sin trabajos
#   zona-horaria   zona del horario (defecto America/Bogota)
#   idle-minutes-noche  minutos sin trabajos fuera del horario (defecto 60)
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

# Horario valido para la metadata horario: HH:MM-HH:MM con la hora de fin despues de la de inicio
# (24:00 vale como fin). Imprime "inicio fin" en minutos desde la medianoche; falla si no sirve.
#   minutos_de_horario 06:00-23:00   ->  360 1380
minutos_de_horario() {
  local h="$1"
  [[ $h =~ ^([01][0-9]|2[0-3]):([0-5][0-9])-([01][0-9]|2[0-4]):([0-5][0-9])$ ]] || return 1
  local inicio=$((10#${BASH_REMATCH[1]} * 60 + 10#${BASH_REMATCH[2]}))
  local fin=$((10#${BASH_REMATCH[3]} * 60 + 10#${BASH_REMATCH[4]}))
  [ "$fin" -le 1440 ] && [ "$fin" -gt "$inicio" ] || return 1
  echo "$inicio $fin"
}

# Escribe el chequeo de inactividad que corre el timer adaceen-idle cada 5 min.
#   escribir_chequeo_inactividad <destino> <minutos> <archivo de actividad> [archivo uptime] [comando de apagado]
#                                [horario] [zona horaria] [minutos fuera del horario] [comando de la hora HHMM]
# La ultima actividad es la fecha de modificacion del archivo de actividad:
#   - el que escribe el worker tras cada trabajo (QUEUE_WORKER_LAST_JOB_FILE);
#   - o, con una rama cuyo worker todavia no lo escribe, el log del worker
#     (como antes: un latido fallido renueva el log y la VM puede no apagarse).
# La cuenta empieza, como pronto, al arrancar la VM, y hay 20 min de gracia
# tras el arranque para que llegue el primer trabajo. 0 minutos = no apagar.
# Con horario (28-10-2026): dentro de el nunca se apaga por inactividad (de dia el tutor responde
# al instante; la apaga Google a la hora de fin); fuera de el, tras los minutos fuera del horario.
escribir_chequeo_inactividad() {
  local destino="$1" minutos="$2" fuente="$3"
  local uptime="${4:-/proc/uptime}" apagar="${5:-/sbin/shutdown -h now}"
  local horario="${6:-}" zona="${7:-America/Bogota}" noche="${8:-60}" hora="${9:-}"
  local rango=""
  if [ -n "$horario" ]; then
    rango="$(minutos_de_horario "$horario")" || { echo "AVISO: horario $horario no valido; el apagado no mira la hora"; rango=""; }
  fi
  [ -n "$hora" ] || hora="TZ=$(printf %q "$zona") date +%H%M"
  {
    echo '#!/usr/bin/env bash'
    echo '# Generado por startup-script.sh (timer adaceen-idle): apaga la VM tras IDLE_MINUTES sin trabajos.'
    printf 'IDLE_MINUTES=%q\n' "$minutos"
    printf 'FUENTE=%q\n' "$fuente"
    printf 'UPTIME=%q\n' "$uptime"
    printf 'apagar() { %s; }\n' "$apagar"
    if [ -n "$rango" ]; then
      printf 'HORARIO=%q\n' "$horario"
      printf 'INICIO=%q\nFIN=%q\n' "${rango% *}" "${rango#* }"
      printf 'IDLE_NOCHE=%q\n' "$noche"
      printf 'hora_local() { %s; }\n' "$hora"
      cat <<'HORARIOEOF'
AHORA_HHMM=$(hora_local)
AHORA_MIN=$((10#${AHORA_HHMM:0:2} * 60 + 10#${AHORA_HHMM:2:2}))
# Dentro del horario del tutor no se apaga por inactividad.
if [ "$AHORA_MIN" -ge "$INICIO" ] && [ "$AHORA_MIN" -lt "$FIN" ]; then exit 0; fi
IDLE_MINUTES=$IDLE_NOCHE
HORARIOEOF
    fi
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

# Instala el apagado por inactividad (chequeo, servicio y timer adaceen-idle cada 5 min). Lo usa el
# arranque y, sin reiniciar la GPU, deploy/gcp/horario-gpu.sh activar (por ssh, con source).
#   instalar_apagado_por_inactividad <minutos> <archivo de actividad> [horario] [zona] [minutos fuera del horario]
instalar_apagado_por_inactividad() {
  local IDLE_MINUTES="$1" ACTIVIDAD="$2" HORARIO="${3:-}" ZONA_HORARIA="${4:-America/Bogota}" IDLE_NOCHE="${5:-60}"
  escribir_chequeo_inactividad /usr/local/bin/adaceen-idle-check "$IDLE_MINUTES" "$ACTIVIDAD" /proc/uptime "/sbin/shutdown -h now" "$HORARIO" "$ZONA_HORARIA" "$IDLE_NOCHE"
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
  if [ "$IDLE_MINUTES" -gt 0 ] || [ -n "$HORARIO" ]; then
    systemctl enable --now adaceen-idle.timer
  else
    echo "--- idle-minutes=0 y sin horario: la VM no se apaga sola"
    systemctl disable --now adaceen-idle.timer 2>/dev/null || true
  fi
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

# Pedidos a la vez en la GPU (examen 28-10-2026): con 40 estudiantes, uno a la vez se queda
# corto. Con metadata ollama-num-parallel = 1..4 se usa ese valor; sin ella (o "auto"), 2 si la
# GPU tiene al menos 15 GB (V100 16 GB, L4, A100: el 14B Q4 ocupa ~9 GB y cada ventana de 8192
# tokens ~1,5 GB) y 1 si no o si aun no hay driver.
#   paralelo_ollama <metadata> <MiB de la GPU o vacio>
paralelo_ollama() {
  local pedido="$1" mib="$2"
  case "$pedido" in
    1 | 2 | 3 | 4) echo "$pedido"; return 0 ;;
  esac
  if [[ $mib =~ ^[0-9]+$ ]] && [ "$mib" -ge 15000 ]; then echo 2; else echo 1; fi
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
# Horario del tutor (deploy/gcp/horario-gpu.sh): vacio = como antes, sin mirar la hora.
HORARIO=$(meta horario)
ZONA_HORARIA=$(meta zona-horaria);   ZONA_HORARIA=${ZONA_HORARIA:-America/Bogota}
IDLE_NOCHE=$(meta idle-minutes-noche); IDLE_NOCHE=${IDLE_NOCHE:-60}
WORKER_ID=$(meta worker-id);          WORKER_ID=${WORKER_ID:-gce-$(hostname)}
# Latido hacia el API (A15.4). Opcionales: sin ellos el worker funciona igual.
HEARTBEAT_URL=$(meta heartbeat-url)
HEARTBEAT_TOKEN=$(meta heartbeat-token)
# Lo escribe el worker tras cada trabajo; lo lee el apagado por inactividad.
ULTIMO_TRABAJO=/var/lib/adaceen/ultimo-trabajo
# Ventana de contexto del modelo (tokens). Sin fijarla, Ollama usa la suya por defecto y corta
# en silencio el comienzo de un prompt largo (alli van las reglas del formato): revision de
# precision del 21/10/2026. El worker la pide en cada llamada y el backend ajusta el prompt a ella.
NUM_CTX=$(meta model-num-ctx);        NUM_CTX=${NUM_CTX:-8192}
case "$NUM_CTX" in
  ''|*[!0-9]*) echo "AVISO: la metadata model-num-ctx no es un numero; se usa 8192"; NUM_CTX=8192 ;;
esac
# El mismo rango que acepta el worker (modelNumCtx): fuera de el, worker y Ollama usarian
# ventanas distintas y el primer pedido recargaria el modelo.
if [ ${#NUM_CTX} -gt 6 ] || [ "$NUM_CTX" -lt 2048 ] || [ "$NUM_CTX" -gt 131072 ]; then
  echo "AVISO: model-num-ctx=$NUM_CTX fuera de 2048-131072; se usa 8192"
  NUM_CTX=8192
fi

if ! [[ $IDLE_MINUTES =~ ^[0-9]{1,5}$ ]]; then
  echo "AVISO: la metadata idle-minutes no es un numero; se usan 30 min"
  IDLE_MINUTES=30
fi
IDLE_MINUTES=$((10#$IDLE_MINUTES))
if ! [[ $IDLE_NOCHE =~ ^[0-9]{1,4}$ ]] || [ "$((10#$IDLE_NOCHE))" -lt 15 ]; then
  echo "AVISO: la metadata idle-minutes-noche no es un numero de 15 o mas; se usan 60 min"
  IDLE_NOCHE=60
fi
IDLE_NOCHE=$((10#$IDLE_NOCHE))
if [ -n "$HORARIO" ] && ! minutos_de_horario "$HORARIO" >/dev/null; then
  echo "AVISO: la metadata horario ($HORARIO) no es HH:MM-HH:MM; el apagado no mira la hora"
  HORARIO=""
fi
if ! [[ $ZONA_HORARIA =~ ^[A-Za-z_]+(/[A-Za-z_+-]+)*$ ]] || [ ! -e "/usr/share/zoneinfo/$ZONA_HORARIA" ]; then
  echo "AVISO: la metadata zona-horaria ($ZONA_HORARIA) no existe; se usa America/Bogota"
  ZONA_HORARIA=America/Bogota
fi

if [ -z "$SB_CONN" ]; then
  echo "FATAL: falta la metadata sb-conn"; exit 1
fi

# --- precarga del modelo en la GPU, en paralelo con el resto del arranque ---
# Leer el modelo (~9 GB) del disco tarda ~55 s: es el tope de lectura de un
# pd-balanced de 120 GB. Se lanza ya, para que coincida con apt/npm/git en
# vez de sumarse al final. OLLAMA_KEEP_ALIVE=-1 evita que Ollama lo saque de
# la GPU tras 5 min sin preguntas (la VM ya se apaga sola por inactividad).
OLLAMA_CAMBIO=0
if [ ! -f /etc/systemd/system/ollama.service.d/keepalive.conf ]; then
  install -d /etc/systemd/system/ollama.service.d
  printf '[Service]\nEnvironment="OLLAMA_KEEP_ALIVE=-1"\n' > /etc/systemd/system/ollama.service.d/keepalive.conf
  OLLAMA_CAMBIO=1
fi
# Ventana de contexto por defecto del servidor (la misma que pide el worker) y tantos pedidos a la
# vez como atiende el worker (paralelo_ollama): la memoria no se reparte entre ventanas sin uso.
VRAM_MIB=$(timeout 20 nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -dc '0-9' || true)
PARALELO=$(paralelo_ollama "$(meta ollama-num-parallel)" "$VRAM_MIB")
echo "--- GPU ${VRAM_MIB:-sin driver} MiB: $PARALELO pedido(s) a la vez"
CONTEXTO_CONF=$(printf '[Service]\nEnvironment="OLLAMA_CONTEXT_LENGTH=%s"\nEnvironment="OLLAMA_NUM_PARALLEL=%s"\n' "$NUM_CTX" "$PARALELO")
if [ "$(cat /etc/systemd/system/ollama.service.d/contexto.conf 2>/dev/null)" != "$CONTEXTO_CONF" ]; then
  install -d /etc/systemd/system/ollama.service.d
  printf '%s\n' "$CONTEXTO_CONF" > /etc/systemd/system/ollama.service.d/contexto.conf
  OLLAMA_CAMBIO=1
fi
if [ "$OLLAMA_CAMBIO" = 1 ]; then
  systemctl daemon-reload
  systemctl try-restart ollama || true
fi
(
  for _ in $(seq 1 150); do curl -sf http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 2; done
  T0=$(date +%s)
  # Con la misma num_ctx que pide el worker: si no, el primer pedido recargaria el modelo.
  curl -sf -X POST http://127.0.0.1:11434/api/generate -H "Content-Type: application/json" \
    -d "{\"model\":\"$MODEL_TEXT\",\"keep_alive\":-1,\"options\":{\"num_ctx\":$NUM_CTX}}" >/dev/null \
    && echo "--- modelo precargado en la GPU en $(( $(date +%s) - T0 )) s (num_ctx $NUM_CTX)"
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
QUEUE_WORKER_CONCURRENCY=$PARALELO
QUEUE_WORKER_MAX_ATTEMPTS=2
QUEUE_WORKER_RETRY_DELAY_MS=2000
QUEUE_WORKER_LOCK_RENEWAL_MS=0
QUEUE_WORKER_LAST_JOB_FILE=$ULTIMO_TRABAJO
OPENAI_BASE=http://127.0.0.1:11434/v1
OPENAI_API_KEY=dummy
OLLAMA_BASE_URL=http://127.0.0.1:11434
MODEL_TEXT=$MODEL_TEXT
MODEL_NUM_CTX=$NUM_CTX
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

# Si con $PARALELO el modelo no cabe entero en la GPU (Ollama pasaria capas a la CPU y todo iria
# mas lento), se vuelve a 1 pedido a la vez antes de levantar el worker.
if [ "$PARALELO" -gt 1 ]; then
  CABE=""
  for _ in $(seq 1 60); do
    CABE=$(curl -sf http://127.0.0.1:11434/api/ps | python3 -c "import json,sys; m=[x for x in json.load(sys.stdin).get('models',[])]; print('' if not m else ('si' if all(int(x.get('size_vram',0))>=int(x.get('size',1)) for x in m) else 'no'))" 2>/dev/null || true)
    [ -n "$CABE" ] && break
    sleep 3
  done
  if [ "$CABE" = "no" ]; then
    echo "AVISO: con $PARALELO pedidos a la vez el modelo no cabe en la GPU; vuelvo a 1"
    PARALELO=1
    printf '[Service]\nEnvironment="OLLAMA_CONTEXT_LENGTH=%s"\nEnvironment="OLLAMA_NUM_PARALLEL=1"\n' "$NUM_CTX" > /etc/systemd/system/ollama.service.d/contexto.conf
    sed -i 's/^QUEUE_WORKER_CONCURRENCY=.*/QUEUE_WORKER_CONCURRENCY=1/' /opt/adaceen/repo/.env.worker
    systemctl daemon-reload
    systemctl restart ollama || true
    for _ in $(seq 1 60); do curl -sf http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 2; done
    curl -sf -X POST http://127.0.0.1:11434/api/generate -H "Content-Type: application/json" \
      -d "{\"model\":\"$MODEL_TEXT\",\"keep_alive\":-1,\"options\":{\"num_ctx\":$NUM_CTX}}" >/dev/null || true
  elif [ "$CABE" = "si" ]; then
    echo "--- el modelo cabe entero en la GPU con $PARALELO pedidos a la vez"
  else
    echo "AVISO: no pude comprobar si el modelo cabe en la GPU con $PARALELO pedidos a la vez"
  fi
fi

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

systemctl daemon-reload
systemctl enable --now adaceen-logrotate.timer || echo "AVISO: no se pudo activar la rotacion horaria del log"

# --- apagado por inactividad ---
# Ver escribir_chequeo_inactividad arriba: cuenta desde el ultimo trabajo
# atendido (o desde el arranque), no desde la ultima linea del log; con horario,
# solo fuera de el.
instalar_apagado_por_inactividad "$IDLE_MINUTES" "$ACTIVIDAD" "$HORARIO" "$ZONA_HORARIA" "$IDLE_NOCHE"

if [ -n "$HORARIO" ]; then
  echo "=== listo. worker=$WORKER_ID modelo=$MODEL_TEXT horario=$HORARIO ($ZONA_HORARIA): de dia no se apaga sola; fuera, tras ${IDLE_NOCHE}min sin trabajos (actividad: $ACTIVIDAD) ==="
else
  echo "=== listo. worker=$WORKER_ID modelo=$MODEL_TEXT idle=${IDLE_MINUTES}min (actividad: $ACTIVIDAD) ==="
fi
