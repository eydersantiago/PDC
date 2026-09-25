#!/bin/bash
# Instala ADACEEN en una Mac del laboratorio (Apple Silicon, macOS 14 o superior).
#
# Roles:
#   servidor (por defecto)  La Mac es un servidor de inferencia: Ollama con el
#                           modelo del piloto y el worker de la cola de Azure
#                           (npm run worker:queue). Atiende a estudiantes de
#                           cualquier sala o de cualquier IP a traves de Azure,
#                           igual que la GPU de Google Cloud. Solo abre
#                           conexiones de salida por HTTPS (puerto 443).
#   local                   El modo local de siempre (npm run dev:local): backend
#                           y Ollama en la misma Mac, para una Mac que trabaja
#                           sola. VS Code de esa Mac lo detecta en 127.0.0.1:3000.
#   nodo / coordinador      Cluster: varias Mac juntan su memoria para correr un
#                           modelo que no cabe en una sola (llama.cpp RPC). Cada
#                           nodo presta su memoria con ggml-rpc-server; la
#                           coordinadora corre llama-server con el modelo
#                           repartido entre todas y el worker de la cola. Exige
#                           una red aislada entre las Mac: el RPC no tiene
#                           autenticacion. Es mas lento que un modelo que cabe
#                           en una Mac (docs/operacion/worker-mac.md, seccion 9).
#
# Los servicios quedan en launchd: arrancan solos, se reinician si fallan y la
# Mac no se duerme mientras el worker (o el nodo) corre.
#
# Uso rapido (desde la carpeta del repositorio, en Terminal):
#   bash deploy/mac/instalar-worker-mac.sh --equipo=07 --config=/Volumes/USB/adaceen-mac.env
#   bash deploy/mac/instalar-worker-mac.sh --rol=local
#   bash deploy/mac/instalar-worker-mac.sh --rol=nodo --ip-cluster=10.77.0.2 --red-aislada --version-llama=<tag>
#   bash deploy/mac/instalar-worker-mac.sh --rol=coordinador --nodos=10.77.0.2,10.77.0.3 --config=/Volumes/USB/adaceen-mac.env
#   bash deploy/mac/instalar-worker-mac.sh --simular=/tmp/prueba   # no toca el sistema
#
# Guia completa: docs/operacion/worker-mac.md. Opciones: --ayuda.
set -euo pipefail

DIR_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$DIR_SCRIPT/../.." && pwd)"
# shellcheck source=deploy/mac/comun.sh
. "$DIR_SCRIPT/comun.sh"

ayuda() {
  cat <<'AYUDA'
Instala ADACEEN en una Mac del laboratorio.

  --rol=servidor|local|nodo|coordinador
                            servidor (por defecto): worker de la cola de Azure con Ollama.
                            local: backend y Ollama en esta Mac (npm run dev:local).
                            nodo: presta la memoria de esta Mac a un cluster (ggml-rpc-server).
                            coordinador: corre el modelo repartido entre los nodos y el worker.
  --equipo=07               numero del equipo; el id queda mac-lab07-<chip>
                            (en la coordinadora, mac-lab-cluster07-<chip>).
  --id=<id>                 id completo del worker (manda sobre --equipo).
  --config=<archivo>        archivo con AZURE_SERVICEBUS_CONNECTION_STRING, WORKER_SHARED_SECRET
                            y WORKER_HEARTBEAT_TOKEN (ver deploy/mac/adaceen-mac.ejemplo.env).
                            Sin archivo, se toman del entorno o se preguntan.
  --backend=<url>           API de Azure (por defecto la de produccion).
  --modelo=<tag>            modelo de texto (por defecto qwen2.5-coder:14b, el del piloto;
                            en la coordinadora, qwen2.5-coder:32b).
  --modelo-vision=<tag>     modelo de imagenes (por defecto qwen2.5vl:7b).
  --tipos=text|text,image   trabajos que atiende (por defecto segun la memoria de la Mac).
  --concurrencia=N          trabajos a la vez, de 1 a 8 (por defecto segun la memoria).
  --respaldo                la Mac solo toma los trabajos que los demas servidores (la GPU)
                            no alcanzan a tomar; para Mac lentas junto a una GPU.
  --transporte=websockets|amqp   websockets (por defecto) sale por el 443; amqp usa el 5671.
  --proxy=<url>|ninguno     proxy HTTPS (por defecto el que tenga configurado la Mac).
  --sistema                 servicios de sistema: arrancan con la Mac sin iniciar sesion
                            (pide la clave de administrador).
  --carpeta-modelos=<dir>   donde guarda Ollama los modelos (por defecto ~/.ollama/models).
  --puerto-ollama=11434     puerto local de Ollama.

  Cluster (nodo y coordinador):
  --ip-cluster=<IP>         nodo: IP de esta Mac en la red aislada del cluster.
  --red-aislada             nodo: confirmas que esa IP esta en una red solo para las Mac del
                            cluster (cable Thunderbolt o VLAN propia). Sin esto no se instala.
  --nodos=IP[:puerto],...   coordinador: nodos del cluster (puerto 50052 por defecto).
  --gguf=<archivo>          coordinador: modelo GGUF propio en vez de bajarlo con Ollama.
  --version-llama=<tag>     version de llama.cpp (la misma en todas las Mac del cluster).
  --puerto-rpc=50052        nodo: puerto de ggml-rpc-server.
  --puerto-llama=8091       coordinador: puerto local de llama-server.

  --sin-descargas           no descarga Node, Ollama ni llama.cpp; usa los instalados.
  --forzar                  sigue aunque la Mac no cumpla los minimos.
  --sin-comprobar-red       no prueba la salida a Azure antes de instalar.
  --simular[=<dir>]         no toca el sistema: escribe los archivos en <dir> y muestra
                            lo que haria (sirve tambien en Linux para revisar).
  --ayuda                   esta ayuda.
AYUDA
}

# ---------------------------------------------------------------- opciones
ROL="servidor"
EQUIPO=""
WORKER_ID=""
ARCHIVO_CONFIG=""
BACKEND_URL=""
MODELO="qwen2.5-coder:14b"
MODELO_VISION="qwen2.5vl:7b"
TIPOS=""
CONCURRENCIA=""
PRIORIDAD="normal"
TRANSPORTE="websockets"
PROXY_OPCION=""
MODO="sesion"
CARPETA_MODELOS=""
OLLAMA_PUERTO="11434"
IP_CLUSTER=""
RED_AISLADA=0
NODOS=""
GGUF=""
LLAMA_TAG=""
PUERTO_RPC="50052"
PUERTO_LLAMA="8091"
SIN_DESCARGAS=0
FORZAR=0
COMPROBAR_RED=1
SIMULAR=0
DIR_SIMULACION=""
MODELO_EXPLICITO=0

for arg in "$@"; do
  case "$arg" in
    --rol=*) ROL="${arg#*=}" ;;
    --equipo=*) EQUIPO="${arg#*=}" ;;
    --id=*) WORKER_ID="${arg#*=}" ;;
    --config=*) ARCHIVO_CONFIG="${arg#*=}" ;;
    --backend=*) BACKEND_URL="${arg#*=}" ;;
    --modelo=*) MODELO="${arg#*=}"; MODELO_EXPLICITO=1 ;;
    --modelo-vision=*) MODELO_VISION="${arg#*=}" ;;
    --tipos=*) TIPOS="${arg#*=}" ;;
    --concurrencia=*) CONCURRENCIA="${arg#*=}" ;;
    --respaldo) PRIORIDAD="backup" ;;
    --transporte=*) TRANSPORTE="${arg#*=}" ;;
    --proxy=*) PROXY_OPCION="${arg#*=}" ;;
    --sistema) MODO="sistema" ;;
    --carpeta-modelos=*) CARPETA_MODELOS="${arg#*=}" ;;
    --puerto-ollama=*) OLLAMA_PUERTO="${arg#*=}" ;;
    --ip-cluster=*) IP_CLUSTER="${arg#*=}" ;;
    --red-aislada) RED_AISLADA=1 ;;
    --nodos=*) NODOS="${arg#*=}" ;;
    --gguf=*) GGUF="${arg#*=}" ;;
    --version-llama=*) LLAMA_TAG="${arg#*=}" ;;
    --puerto-rpc=*) PUERTO_RPC="${arg#*=}" ;;
    --puerto-llama=*) PUERTO_LLAMA="${arg#*=}" ;;
    --sin-descargas) SIN_DESCARGAS=1 ;;
    --forzar) FORZAR=1 ;;
    --sin-comprobar-red) COMPROBAR_RED=0 ;;
    --simular) SIMULAR=1 ;;
    --simular=*) SIMULAR=1; DIR_SIMULACION="${arg#*=}" ;;
    --ayuda | -h | --help) ayuda; exit 0 ;;
    *) fallar "opcion desconocida: $arg (usa --ayuda)" ;;
  esac
done

case "$ROL" in servidor | local | nodo | coordinador) ;; *) fallar "--rol debe ser servidor, local, nodo o coordinador" ;; esac
case "$TRANSPORTE" in websockets | amqp) ;; *) fallar "--transporte debe ser websockets o amqp" ;; esac
re_numero='^[0-9]+$'
for puerto in "$OLLAMA_PUERTO" "$PUERTO_RPC" "$PUERTO_LLAMA"; do
  [[ $puerto =~ $re_numero ]] || fallar "los puertos deben ser numeros (recibi: $puerto)"
done
if [ -n "$CONCURRENCIA" ]; then
  if ! [[ $CONCURRENCIA =~ $re_numero ]] || [ "$CONCURRENCIA" -lt 1 ] || [ "$CONCURRENCIA" -gt 8 ]; then
    fallar "--concurrencia debe estar entre 1 y 8"
  fi
fi
if [ -n "$TIPOS" ]; then
  case "$TIPOS" in text | text,image | image,text) ;; *) fallar "--tipos debe ser text o text,image" ;; esac
fi

# Roles del cluster.
NODOS_RPC=""
if [ "$ROL" = "nodo" ]; then
  [ -n "$IP_CLUSTER" ] || fallar "un nodo necesita --ip-cluster=<IP de esta Mac en la red aislada del cluster>"
  if ! es_ip_puerto "$IP_CLUSTER" || [ "${IP_CLUSTER#*:}" != "$IP_CLUSTER" ]; then
    fallar "--ip-cluster debe ser una IPv4 sin puerto (el puerto va en --puerto-rpc)"
  fi
  case "$IP_CLUSTER" in 0.0.0.0 | 127.*) fallar "--ip-cluster debe ser la IP de la red aislada, no $IP_CLUSTER" ;; esac
  if [ "$RED_AISLADA" != 1 ]; then
    fallar "ggml-rpc-server no tiene autenticacion: cualquiera que llegue a $IP_CLUSTER:$PUERTO_RPC puede usarlo. Instala el nodo solo en una red aislada para las Mac del cluster (cable Thunderbolt o VLAN propia) y confirmalo con --red-aislada (docs/operacion/worker-mac.md, seccion 9)"
  fi
fi
if [ "$ROL" = "coordinador" ]; then
  [ -n "$NODOS" ] || fallar "la coordinadora necesita --nodos=IP[:puerto],... (los nodos del cluster)"
  viejo_ifs="$IFS"
  IFS=','
  for nodo in $NODOS; do
    nodo="${nodo// /}"
    [ -n "$nodo" ] || continue
    es_ip_puerto "$nodo" || fallar "nodo invalido en --nodos: $nodo (usa IP o IP:puerto)"
    [ "${nodo#*:}" = "$nodo" ] && nodo="$nodo:50052"
    NODOS_RPC="${NODOS_RPC:+$NODOS_RPC,}$nodo"
  done
  IFS="$viejo_ifs"
  [ -n "$NODOS_RPC" ] || fallar "--nodos no tiene ningun nodo"
  [ "$MODELO_EXPLICITO" = 1 ] || MODELO="qwen2.5-coder:32b"
fi

# En simulacion todo se escribe en una carpeta aparte y nada toca launchd.
if [ "$SIMULAR" = 1 ]; then
  DIR_SIMULACION="${DIR_SIMULACION:-$(mktemp -d "${TMPDIR:-/tmp}/adaceen-simulacion.XXXXXX")}"
  mkdir -p "$DIR_SIMULACION"
  DIR_SIMULACION="$(cd "$DIR_SIMULACION" && pwd)"
  ADACEEN_HOME="$DIR_SIMULACION/adaceen"
  ARCHIVO_ESTADO="$ADACEEN_HOME/instalacion.env"
  ARCHIVO_WORKER_ENV="$ADACEEN_HOME/worker.env"
  DIR_LOGS="$DIR_SIMULACION/Logs/ADACEEN"
  info "SIMULACION: nada se instala; los archivos quedan en $DIR_SIMULACION"
  # En simulacion nunca se pide sudo: todo queda en la carpeta de simulacion.
  con_permisos() {
    shift
    "$@"
  }
fi

# launchctl con sudo en modo sistema; en simulacion solo muestra el comando.
lanzar() {
  if [ "$SIMULAR" = 1 ]; then
    printf '[adaceen] (simulado) %slaunchctl %s\n' "$([ "$MODO" = "sistema" ] && echo 'sudo ')" "$*"
  else
    con_permisos "$MODO" launchctl "$@"
  fi
}

# Que necesita cada rol.
TIENE_WORKER=0
NECESITA_NODE=1
NECESITA_OLLAMA=0
NECESITA_LLAMA=0
case "$ROL" in
  servidor) TIENE_WORKER=1; NECESITA_OLLAMA=1 ;;
  local) NECESITA_OLLAMA=1 ;;
  coordinador) TIENE_WORKER=1; NECESITA_LLAMA=1; [ -n "$GGUF" ] || NECESITA_OLLAMA=1 ;;
  nodo) NECESITA_NODE=0; NECESITA_LLAMA=1 ;;
esac

# ---------------------------------------------------------------- la Mac
if [ ! -f "$REPO_DIR/package.json" ] || [ ! -f "$REPO_DIR/scripts/service-bus-ollama-worker.ts" ]; then
  fallar "no encuentro el repositorio PDC en $REPO_DIR"
fi
if [ "$SIMULAR" = 0 ] && [ "$(id -u)" -eq 0 ]; then
  fallar "no lo corras con sudo: el instalador pide la clave solo para lo que la necesita (--sistema)"
fi

if [ "$SIMULAR" = 1 ]; then
  MACOS="${ADACEEN_SIM_MACOS:-15.0}"
  ARQ="${ADACEEN_SIM_ARQ:-arm64}"
  RAM_GB="${ADACEEN_SIM_RAM_GB:-16}"
  CHIP_TEXTO="${ADACEEN_SIM_CHIP:-Apple M2}"
else
  [ "$(uname -s)" = "Darwin" ] || fallar "este instalador es para macOS (en otro sistema usa --simular)"
  MACOS="$(sw_vers -productVersion)"
  ARQ="$(uname -m)"
  RAM_GB=$(($(sysctl -n hw.memsize) / 1073741824))
  CHIP_TEXTO="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo desconocido)"
fi

info "Mac: macOS $MACOS, $ARQ, ${RAM_GB} GB de memoria, $CHIP_TEXTO"
if [ "${MACOS%%.*}" -lt 14 ]; then
  fallar "Ollama y llama.cpp necesitan macOS 14 (Sonoma) o superior; esta Mac tiene $MACOS"
fi
if [ "$ARQ" != "arm64" ]; then
  if [ "$FORZAR" = 1 ]; then
    aviso "Mac con Intel: el modelo corre solo en la CPU y la latencia pasara de los 8 s del piloto"
  else
    fallar "Mac con Intel: el modelo no usa su GPU y la latencia no cumple el piloto. Usa una Mac con chip Apple (M1 o posterior) o --forzar para probar igual"
  fi
fi

# Chip para el id: "Apple M2 Pro" -> m2pro.
CHIP_ID="$(printf '%s' "$CHIP_TEXTO" | tr '[:upper:]' '[:lower:]' | sed -E 's/^apple //; s/[^a-z0-9]//g')"
re_chip='^m[1-9]'
[[ $CHIP_ID =~ $re_chip ]] || CHIP_ID="cpu"

# Valores por defecto segun la memoria (memoria unificada: el modelo de 14B pesa ~9 GB).
if [ "$ROL" = "servidor" ] || [ "$ROL" = "local" ]; then
  if [ "$RAM_GB" -lt 16 ] && [ "$MODELO_EXPLICITO" = 0 ] && [ "$FORZAR" = 0 ]; then
    fallar "esta Mac tiene ${RAM_GB} GB y el modelo del piloto (qwen2.5-coder:14b) necesita 16 GB. Puedes usar un modelo menor con --modelo=qwen2.5-coder:7b, pero sus respuestas no son comparables con las del piloto: no la enciendas en sesiones del piloto. Tambien puede prestar su memoria a un cluster (--rol=nodo)"
  fi
  if [ -z "$TIPOS" ]; then
    if [ "$RAM_GB" -ge 32 ]; then TIPOS="text,image"; else TIPOS="text"; fi
  fi
  if [ -z "$CONCURRENCIA" ]; then
    if [ "$RAM_GB" -ge 64 ]; then CONCURRENCIA=4; elif [ "$RAM_GB" -ge 32 ]; then CONCURRENCIA=2; else CONCURRENCIA=1; fi
  fi
else
  # El cluster solo atiende texto; cada trabajo extra divide el contexto.
  TIPOS="text"
  CONCURRENCIA="${CONCURRENCIA:-1}"
fi
case "$TIPOS" in *image*) CON_IMAGENES=1 ;; *) CON_IMAGENES=0 ;; esac
if [ "$CON_IMAGENES" = 1 ]; then MODELOS_CARGADOS=2; else MODELOS_CARGADOS=1; fi
if [ "$ROL" != "nodo" ] && [ "$MODELO" != "qwen2.5-coder:14b" ]; then
  aviso "modelo $MODELO distinto al del piloto (qwen2.5-coder:14b): sus respuestas no son comparables; no enciendas esta Mac en sesiones del piloto junto a servidores con otro modelo"
fi

# Espacio: ~9 GB el modelo de texto, ~6 GB el de vision, ~20 GB un 32B; un nodo
# guarda en su cache la parte del modelo que le toca.
case "$ROL" in
  nodo) NECESARIO_GB=12; DIR_ESPACIO="$HOME" ;;
  coordinador) NECESARIO_GB=24; DIR_ESPACIO="${CARPETA_MODELOS:-$HOME/.ollama/models}" ;;
  *) NECESARIO_GB=12; [ "$CON_IMAGENES" = 1 ] && NECESARIO_GB=19; DIR_ESPACIO="${CARPETA_MODELOS:-$HOME/.ollama/models}" ;;
esac
[ -n "$GGUF" ] && NECESARIO_GB=2
if [ "$SIMULAR" = 0 ]; then
  mkdir -p "$DIR_ESPACIO"
  LIBRE_GB=$(($(df -Pk "$DIR_ESPACIO" | awk 'NR==2 {print $4}') / 1048576))
  if [ "$LIBRE_GB" -lt "$NECESARIO_GB" ]; then
    [ "$FORZAR" = 1 ] || fallar "hay ${LIBRE_GB} GB libres en $DIR_ESPACIO y hacen falta unos ${NECESARIO_GB} GB (usa --carpeta-modelos o libera espacio)"
    aviso "poco espacio libre (${LIBRE_GB} GB); sigo por --forzar"
  fi
fi

# ---------------------------------------------------------------- configuracion y secretos
AZURE_SERVICEBUS_CONNECTION_STRING="${AZURE_SERVICEBUS_CONNECTION_STRING:-${SB_CONN:-}}"
WORKER_SHARED_SECRET="${WORKER_SHARED_SECRET:-}"
WORKER_HEARTBEAT_TOKEN="${WORKER_HEARTBEAT_TOKEN:-}"
JOBS_QUEUE_NAME="${JOBS_QUEUE_NAME:-llm-jobs}"
RESULTS_QUEUE_NAME="${RESULTS_QUEUE_NAME:-llm-results-sessions}"
QUEUE_REQUEST_TIMEOUT_MS="${QUEUE_REQUEST_TIMEOUT_MS:-120000}"
PROXY_CONFIG=""
NO_PROXY_CONFIG=""
BACKEND_CONFIG=""
ID_CONFIG=""

# Lee KEY=VALUE sin ejecutar nada; acepta finales de linea de Windows y comillas.
cargar_config() {
  local archivo="$1" linea clave valor
  [ -f "$archivo" ] || fallar "no existe el archivo de configuracion $archivo"
  while IFS= read -r linea || [ -n "$linea" ]; do
    linea="${linea%$'\r'}"
    case "$linea" in '' | '#'*) continue ;; esac
    clave="${linea%%=*}"
    clave="${clave// /}"
    valor="${linea#*=}"
    valor="${valor#\"}"; valor="${valor%\"}"
    valor="${valor#\'}"; valor="${valor%\'}"
    case "$clave" in
      AZURE_SERVICEBUS_CONNECTION_STRING) AZURE_SERVICEBUS_CONNECTION_STRING="$valor" ;;
      WORKER_SHARED_SECRET) WORKER_SHARED_SECRET="$valor" ;;
      WORKER_HEARTBEAT_TOKEN) WORKER_HEARTBEAT_TOKEN="$valor" ;;
      JOBS_QUEUE_NAME) JOBS_QUEUE_NAME="$valor" ;;
      RESULTS_QUEUE_NAME) RESULTS_QUEUE_NAME="$valor" ;;
      QUEUE_REQUEST_TIMEOUT_MS) QUEUE_REQUEST_TIMEOUT_MS="$valor" ;;
      HTTPS_PROXY | https_proxy) PROXY_CONFIG="$valor" ;;
      NO_PROXY | no_proxy) NO_PROXY_CONFIG="$valor" ;;
      BACKEND_URL) BACKEND_CONFIG="$valor" ;;
      QUEUE_WORKER_ID) ID_CONFIG="$valor" ;;
      # Claves que escribe el propio instalador en worker.env: se recalculan.
      AGENT_TARGET | QUEUE_WORKER_* | SERVICE_BUS_TRANSPORT | OLLAMA_* | OPENAI_* | MODEL_* | ADACEEN_* | WORKER_HEARTBEAT_URL | WORKER_HEARTBEAT_INTERVAL_MS) ;;
      '') ;;
      *) aviso "clave desconocida en $archivo: $clave (se ignora)" ;;
    esac
  done <"$archivo"
}

# Una reinstalacion conserva lo que ya estaba (worker.env) salvo que se pase otro.
if [ "$TIENE_WORKER" = 1 ] && [ -f "$ARCHIVO_WORKER_ENV" ] && [ -z "$ARCHIVO_CONFIG" ]; then
  info "reutilizo la configuracion de $ARCHIVO_WORKER_ENV"
  ARCHIVO_CONFIG="$ARCHIVO_WORKER_ENV"
fi
if [ -n "$ARCHIVO_CONFIG" ]; then
  cargar_config "$ARCHIVO_CONFIG"
fi
BACKEND_URL="${BACKEND_URL:-${BACKEND_CONFIG:-$BACKEND_PRODUCCION}}"
BACKEND_URL="${BACKEND_URL%/}"

# Id del worker: --id, --equipo, el de una instalacion anterior o el nombre de la Mac.
PREFIJO_ID="mac-lab"
[ "$ROL" = "coordinador" ] && PREFIJO_ID="mac-lab-cluster"
if [ -z "$WORKER_ID" ]; then
  if [ -n "$EQUIPO" ]; then
    WORKER_ID="$PREFIJO_ID$(printf '%s' "$EQUIPO" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]//g')-$CHIP_ID"
  elif [ -n "$ID_CONFIG" ]; then
    WORKER_ID="$ID_CONFIG"
  elif [ "$ROL" = "coordinador" ]; then
    WORKER_ID="$PREFIJO_ID-$CHIP_ID"
  else
    NOMBRE_EQUIPO="$( (scutil --get LocalHostName 2>/dev/null || hostname) | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-30)"
    WORKER_ID="$PREFIJO_ID-${NOMBRE_EQUIPO:-equipo}-$CHIP_ID"
  fi
fi
WORKER_ID="$(printf '%s' "$WORKER_ID" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]+/-/g' | cut -c1-60)"

if [ "$TIENE_WORKER" = 1 ]; then
  if [ "$SIMULAR" = 1 ]; then
    AZURE_SERVICEBUS_CONNECTION_STRING="${AZURE_SERVICEBUS_CONNECTION_STRING:-Endpoint=sb://simulado.servicebus.windows.net/;SharedAccessKeyName=worker-mac;SharedAccessKey=SIMULADO}"
    WORKER_SHARED_SECRET="${WORKER_SHARED_SECRET:-SIMULADO}"
    WORKER_HEARTBEAT_TOKEN="${WORKER_HEARTBEAT_TOKEN:-SIMULADO}"
  fi
  if [ -z "$AZURE_SERVICEBUS_CONNECTION_STRING" ]; then
    read -rsp "Cadena de conexion de Service Bus (politica con Listen y Send, no RootManage): " AZURE_SERVICEBUS_CONNECTION_STRING
    echo
  fi
  if [ -z "$WORKER_SHARED_SECRET" ]; then
    read -rsp "WORKER_SHARED_SECRET (el mismo del App Service): " WORKER_SHARED_SECRET
    echo
  fi
  if [ -z "$WORKER_HEARTBEAT_TOKEN" ]; then
    read -rsp "WORKER_HEARTBEAT_TOKEN (Enter para no mandar latido): " WORKER_HEARTBEAT_TOKEN
    echo
  fi
  case "$AZURE_SERVICEBUS_CONNECTION_STRING" in
    Endpoint=sb://*SharedAccessKeyName=*SharedAccessKey=*) ;;
    *) fallar "la cadena de conexion no tiene la forma Endpoint=sb://...;SharedAccessKeyName=...;SharedAccessKey=..." ;;
  esac
  case "$AZURE_SERVICEBUS_CONNECTION_STRING" in
    *EntityPath=*) fallar "la cadena es de una sola cola (EntityPath); el worker necesita una politica del namespace con Listen y Send" ;;
  esac
  case "$AZURE_SERVICEBUS_CONNECTION_STRING" in
    *SharedAccessKeyName=RootManageSharedAccessKey*)
      [ "$FORZAR" = 1 ] || fallar "no uses RootManageSharedAccessKey en las Mac: crea una politica con solo Listen y Send (docs/operacion/worker-mac.md)"
      aviso "RootManageSharedAccessKey en una Mac del laboratorio: cambiala por una politica con Listen y Send"
      ;;
  esac
  [ -n "$WORKER_HEARTBEAT_TOKEN" ] || aviso "sin WORKER_HEARTBEAT_TOKEN: la Mac trabaja, pero el monitor y /api/agent/health no la veran"
  SB_HOST="$(printf '%s' "$AZURE_SERVICEBUS_CONNECTION_STRING" | sed -E 's#^.*Endpoint=sb://([^/;]+).*$#\1#')"
fi

# Proxy: opcion, archivo, entorno o el que tenga configurado la Mac.
PROXY_URL=""
if [ "$PROXY_OPCION" = "ninguno" ]; then
  PROXY_URL=""
elif [ -n "$PROXY_OPCION" ]; then
  PROXY_URL="$PROXY_OPCION"
elif [ -n "$PROXY_CONFIG" ]; then
  PROXY_URL="$PROXY_CONFIG"
elif [ -n "${HTTPS_PROXY:-${https_proxy:-}}" ]; then
  PROXY_URL="${HTTPS_PROXY:-${https_proxy:-}}"
elif [ "$SIMULAR" = 0 ]; then
  PROXY_SISTEMA="$(scutil --proxy 2>/dev/null || true)"
  if printf '%s' "$PROXY_SISTEMA" | grep -q 'HTTPSEnable : 1'; then
    PX_HOST="$(printf '%s\n' "$PROXY_SISTEMA" | awk '/HTTPSProxy :/ {print $3}')"
    PX_PUERTO="$(printf '%s\n' "$PROXY_SISTEMA" | awk '/HTTPSPort :/ {print $3}')"
    [ -n "$PX_HOST" ] && PROXY_URL="http://$PX_HOST:${PX_PUERTO:-80}"
  elif printf '%s' "$PROXY_SISTEMA" | grep -q 'ProxyAutoConfigEnable : 1'; then
    aviso "la Mac usa un archivo PAC para el proxy; si el laboratorio exige proxy, pasalo con --proxy=http://host:puerto"
  fi
fi
NO_PROXY_URL="${NO_PROXY_CONFIG:-127.0.0.1,localhost}"
case ",$NO_PROXY_URL," in *,127.0.0.1,*) ;; *) NO_PROXY_URL="127.0.0.1,localhost,$NO_PROXY_URL" ;; esac
if [ -n "$PROXY_URL" ]; then
  case "$PROXY_URL" in
    *@*) info "proxy HTTPS: ${PROXY_URL%%://*}://***@${PROXY_URL#*@}" ;;
    *) info "proxy HTTPS: $PROXY_URL" ;;
  esac
  export HTTPS_PROXY="$PROXY_URL" https_proxy="$PROXY_URL" NO_PROXY="$NO_PROXY_URL" no_proxy="$NO_PROXY_URL"
fi

# ---------------------------------------------------------------- red
if [ "$SIMULAR" = 0 ] && [ "$COMPROBAR_RED" = 1 ] && [ "$ROL" != "nodo" ]; then
  codigo="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$BACKEND_URL/api/health" 2>/dev/null || true)"
  if [ "$codigo" = "200" ]; then
    ok "backend de Azure alcanzable ($BACKEND_URL)"
  else
    aviso "no pude abrir $BACKEND_URL/api/health (HTTP ${codigo:-sin respuesta}); revisa la red o el proxy"
  fi
  if [ "$TIENE_WORKER" = 1 ]; then
    codigo="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "https://$SB_HOST/" 2>/dev/null || true)"
    if [ -n "$codigo" ] && [ "$codigo" != "000" ]; then
      ok "Service Bus alcanzable por HTTPS (443): $SB_HOST"
    else
      fallar "no hay salida HTTPS a $SB_HOST. Sin ella la Mac no recibe trabajos: revisa la red del laboratorio o el proxy (--proxy)"
    fi
    if [ "$TRANSPORTE" = "amqp" ] && ! nc -z -G 5 "$SB_HOST" 5671 >/dev/null 2>&1; then
      aviso "el puerto 5671 (AMQP) esta cerrado en esta red: cambio a --transporte=websockets"
      TRANSPORTE="websockets"
    fi
  fi
fi
if [ "$SIMULAR" = 0 ] && [ "$ROL" = "coordinador" ]; then
  viejo_ifs="$IFS"
  IFS=','
  for nodo in $NODOS_RPC; do
    if nc -z -G 3 "${nodo%:*}" "${nodo##*:}" >/dev/null 2>&1; then
      ok "nodo $nodo alcanzable"
    else
      aviso "no llego al nodo $nodo: instalalo antes (--rol=nodo) o revisa la red del cluster; llama-server lo reintentara"
    fi
  done
  IFS="$viejo_ifs"
fi

# ---------------------------------------------------------------- Node
version_node_ok() {
  local mayor
  mayor="$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$mayor" -ge 22 ] 2>/dev/null
}

NODE_BIN=""
NODE_DIR=""
if [ "$NECESITA_NODE" = 1 ]; then
  for candidato in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node "$ADACEEN_HOME/node/bin/node"; do
    if [ -n "$candidato" ] && [ -x "$candidato" ] && version_node_ok "$candidato"; then
      NODE_BIN="$candidato"
      break
    fi
  done
  if [ -z "$NODE_BIN" ]; then
    if [ "$SIMULAR" = 1 ]; then
      NODE_BIN="$ADACEEN_HOME/node/bin/node"
      info "(simulado) descargaria Node 22 en $ADACEEN_HOME/node"
    elif [ "$SIN_DESCARGAS" = 1 ]; then
      fallar "no encuentro Node 22 o superior (instalalo desde nodejs.org o quita --sin-descargas)"
    else
      info "descargando Node 22 (sin permisos de administrador) en $ADACEEN_HOME/node"
      tmp_node="$(mktemp -d "${TMPDIR:-/tmp}/adaceen-node.XXXXXX")"
      base_node="https://nodejs.org/dist/latest-v22.x"
      curl -fsSL -m 60 "$base_node/SHASUMS256.txt" -o "$tmp_node/SHASUMS256.txt" || fallar "no pude descargar la lista de Node desde nodejs.org"
      linea_node="$(grep -E " node-v22\.[0-9.]+-darwin-arm64\.tar\.gz$" "$tmp_node/SHASUMS256.txt" | head -1)"
      [ -n "$linea_node" ] || fallar "no encontre Node 22 para darwin-arm64 en nodejs.org"
      archivo_node="${linea_node##* }"
      curl -fSL -m 600 "$base_node/$archivo_node" -o "$tmp_node/$archivo_node" || fallar "fallo la descarga de $archivo_node"
      [ "$(shasum -a 256 "$tmp_node/$archivo_node" | awk '{print $1}')" = "${linea_node%% *}" ] ||
        fallar "la suma SHA-256 de $archivo_node no coincide: no lo instalo"
      rm -rf "$ADACEEN_HOME/node"
      mkdir -p "$ADACEEN_HOME/node"
      tar -xzf "$tmp_node/$archivo_node" -C "$ADACEEN_HOME/node" --strip-components=1
      rm -rf "$tmp_node"
      NODE_BIN="$ADACEEN_HOME/node/bin/node"
    fi
  fi
  NODE_DIR="$(dirname "$NODE_BIN")"
  [ "$SIMULAR" = 1 ] || ok "Node $("$NODE_BIN" -v) en $NODE_BIN"

  if [ "$SIMULAR" = 1 ]; then
    info "(simulado) npm ci en $REPO_DIR"
  elif [ -d "$REPO_DIR/node_modules/tsx" ] && [ -d "$REPO_DIR/node_modules/@azure/service-bus" ] &&
    [ -d "$REPO_DIR/node_modules/ws" ] && [ -d "$REPO_DIR/node_modules/https-proxy-agent" ] &&
    [ "$REPO_DIR/node_modules/.package-lock.json" -nt "$REPO_DIR/package-lock.json" ]; then
    ok "dependencias de Node al dia"
  else
    info "instalando dependencias (npm ci)"
    (cd "$REPO_DIR" && PATH="$NODE_DIR:$PATH" "$NODE_DIR/npm" ci --no-audit --no-fund) || fallar "npm ci fallo"
  fi
fi

# ---------------------------------------------------------------- Ollama
OLLAMA_BIN=""
URL_OLLAMA="http://127.0.0.1:$OLLAMA_PUERTO"
ollama_responde() { curl -s -m 3 "$URL_OLLAMA/api/version" 2>/dev/null | grep -q '"version"'; }
if [ "$NECESITA_OLLAMA" = 1 ]; then
  for candidato in "$(command -v ollama 2>/dev/null || true)" /usr/local/bin/ollama /opt/homebrew/bin/ollama \
    /Applications/Ollama.app/Contents/Resources/ollama "$HOME/Applications/Ollama.app/Contents/Resources/ollama" \
    "$ADACEEN_HOME/ollama/ollama"; do
    if [ -n "$candidato" ] && [ -x "$candidato" ]; then
      OLLAMA_BIN="$candidato"
      break
    fi
  done
  if [ -z "$OLLAMA_BIN" ]; then
    if [ "$SIMULAR" = 1 ]; then
      OLLAMA_BIN="$ADACEEN_HOME/ollama/ollama"
      info "(simulado) descargaria Ollama (ollama-darwin.tgz) en $ADACEEN_HOME/ollama"
    elif [ "$SIN_DESCARGAS" = 1 ]; then
      fallar "no encuentro Ollama (instala la app desde ollama.com o quita --sin-descargas)"
    else
      info "descargando Ollama (sin permisos de administrador) en $ADACEEN_HOME/ollama"
      tmp_ollama="$(mktemp -d "${TMPDIR:-/tmp}/adaceen-ollama.XXXXXX")"
      base_ollama="https://github.com/ollama/ollama/releases/latest/download"
      curl -fsSL -m 60 "$base_ollama/sha256sum.txt" -o "$tmp_ollama/sha256sum.txt" || fallar "no pude descargar las sumas de Ollama"
      curl -fSL -m 900 "$base_ollama/ollama-darwin.tgz" -o "$tmp_ollama/ollama-darwin.tgz" || fallar "fallo la descarga de Ollama"
      suma_esperada="$(awk '$2 == "./ollama-darwin.tgz" || $2 == "ollama-darwin.tgz" {print $1}' "$tmp_ollama/sha256sum.txt")"
      if [ -z "$suma_esperada" ] || [ "$(shasum -a 256 "$tmp_ollama/ollama-darwin.tgz" | awk '{print $1}')" != "$suma_esperada" ]; then
        fallar "la suma SHA-256 de Ollama no coincide (puede haber salido una version nueva a mitad de la descarga): vuelve a correr el instalador"
      fi
      rm -rf "$ADACEEN_HOME/ollama"
      mkdir -p "$ADACEEN_HOME/ollama"
      tar -xzf "$tmp_ollama/ollama-darwin.tgz" -C "$ADACEEN_HOME/ollama"
      rm -rf "$tmp_ollama"
      OLLAMA_BIN="$ADACEEN_HOME/ollama/ollama"
    fi
  fi
  [ "$SIMULAR" = 1 ] || ok "Ollama en $OLLAMA_BIN"
fi

# ---------------------------------------------------------------- llama.cpp (cluster)
# Todas las Mac del cluster deben usar la misma version: el protocolo RPC cambia
# entre versiones. La coordinadora imprime la suya para instalar los nodos.
LLAMA_DIR="$ADACEEN_HOME/llama.cpp"
LLAMA_SERVER_BIN=""
RPC_SERVER_BIN=""
buscar_llama() {
  local nombre
  LLAMA_SERVER_BIN=""
  RPC_SERVER_BIN=""
  [ -x "$LLAMA_DIR/llama-server" ] && LLAMA_SERVER_BIN="$LLAMA_DIR/llama-server"
  for nombre in ggml-rpc-server rpc-server; do
    if [ -x "$LLAMA_DIR/$nombre" ]; then
      RPC_SERVER_BIN="$LLAMA_DIR/$nombre"
      break
    fi
  done
  [ -n "$LLAMA_SERVER_BIN" ] && [ -n "$RPC_SERVER_BIN" ]
}
if [ "$NECESITA_LLAMA" = 1 ]; then
  TAG_INSTALADO="$(cat "$LLAMA_DIR/VERSION" 2>/dev/null || true)"
  if [ "$SIMULAR" = 1 ]; then
    LLAMA_TAG="${LLAMA_TAG:-${TAG_INSTALADO:-bSIMULADO}}"
    LLAMA_SERVER_BIN="$LLAMA_DIR/llama-server"
    RPC_SERVER_BIN="$LLAMA_DIR/ggml-rpc-server"
    info "(simulado) descargaria llama.cpp $LLAMA_TAG (llama-$LLAMA_TAG-bin-macos-arm64.tar.gz) en $LLAMA_DIR"
  elif buscar_llama && { [ -z "$LLAMA_TAG" ] || [ "$LLAMA_TAG" = "$TAG_INSTALADO" ]; }; then
    LLAMA_TAG="$TAG_INSTALADO"
    ok "llama.cpp ${LLAMA_TAG:-(version sin registrar)} en $LLAMA_DIR"
  elif [ "$SIN_DESCARGAS" = 1 ]; then
    fallar "no encuentro llama.cpp en $LLAMA_DIR (quita --sin-descargas para bajarlo)"
  else
    if [ -z "$LLAMA_TAG" ]; then
      LLAMA_TAG="$(curl -fsSI -m 30 https://github.com/ggml-org/llama.cpp/releases/latest 2>/dev/null |
        tr -d '\r' | awk -F'/tag/' 'tolower($1) ~ /^location:/ {print $2}' | tail -1)"
      [ -n "$LLAMA_TAG" ] || fallar "no pude averiguar la ultima version de llama.cpp; pasala con --version-llama=<tag>"
    fi
    archivo_llama="llama-$LLAMA_TAG-bin-macos-arm64.tar.gz"
    info "descargando llama.cpp $LLAMA_TAG (sin permisos de administrador) en $LLAMA_DIR"
    tmp_llama="$(mktemp -d "${TMPDIR:-/tmp}/adaceen-llama.XXXXXX")"
    curl -fSL -m 900 "https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_TAG/$archivo_llama" -o "$tmp_llama/$archivo_llama" ||
      fallar "fallo la descarga de $archivo_llama (revisa --version-llama)"
    # GitHub publica la suma SHA-256 de cada archivo en su API; si no responde, se confia en HTTPS.
    suma_llama="$(curl -fsS -m 30 -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/$LLAMA_TAG" 2>/dev/null |
      awk -v nombre="\"$archivo_llama\"" 'index($0, "\"name\": " nombre) {f = 1} f && /"digest":/ {sub(/.*"sha256:/, ""); sub(/".*/, ""); print; exit}' || true)"
    if [ -n "$suma_llama" ]; then
      [ "$(shasum -a 256 "$tmp_llama/$archivo_llama" | awk '{print $1}')" = "$suma_llama" ] ||
        fallar "la suma SHA-256 de $archivo_llama no coincide: no lo instalo"
      ok "suma SHA-256 de llama.cpp verificada"
    else
      aviso "GitHub no devolvio la suma de $archivo_llama; se confia en la descarga por HTTPS"
    fi
    rm -rf "$LLAMA_DIR"
    mkdir -p "$LLAMA_DIR"
    tar -xzf "$tmp_llama/$archivo_llama" -C "$LLAMA_DIR" --strip-components=1
    rm -rf "$tmp_llama"
    printf '%s\n' "$LLAMA_TAG" >"$LLAMA_DIR/VERSION"
    buscar_llama || fallar "el paquete de llama.cpp no trae llama-server y ggml-rpc-server"
    ok "llama.cpp $LLAMA_TAG en $LLAMA_DIR"
  fi
fi

DIR_PLISTS="$(dir_plists "$MODO")"
[ "$SIMULAR" = 1 ] && DIR_PLISTS="$DIR_SIMULACION/$(basename "$DIR_PLISTS")"
DOMINIO="$(dominio_launchd "$MODO")"
TODAS_LAS_ETIQUETAS="$ETIQUETA_WORKER $ETIQUETA_LOCAL $ETIQUETA_LLAMA $ETIQUETA_NODO $ETIQUETA_OLLAMA"

# Si ya estaba instalado, se bajan los servicios antes de tocar nada.
for etiqueta in $TODAS_LAS_ETIQUETAS; do
  for modo_previo in sesion sistema; do
    if [ "$SIMULAR" = 0 ] && [ -f "$(dir_plists "$modo_previo")/$etiqueta.plist" ]; then
      con_permisos "$modo_previo" launchctl bootout "$(dominio_launchd "$modo_previo")/$etiqueta" >/dev/null 2>&1 || true
      if [ "$modo_previo" != "$MODO" ]; then
        con_permisos "$modo_previo" rm -f "$(dir_plists "$modo_previo")/$etiqueta.plist"
      fi
    fi
  done
done
[ "$SIMULAR" = 1 ] || sleep 2

# Un Ollama que ya escucha en el puerto (la app de Ollama o Homebrew) se reutiliza.
# La coordinadora solo usa Ollama para bajar el modelo; los nodos no lo usan.
OLLAMA_GESTIONADO=0
if [ "$ROL" = "servidor" ] || [ "$ROL" = "local" ]; then
  OLLAMA_GESTIONADO=1
fi
if [ "$NECESITA_OLLAMA" = 1 ] && [ "$SIMULAR" = 0 ]; then
  if ollama_responde; then
    OLLAMA_EXTERNO=1
    if [ "$OLLAMA_GESTIONADO" = 1 ]; then
      OLLAMA_GESTIONADO=0
      aviso "ya hay un Ollama escuchando en $URL_OLLAMA (probablemente la app de Ollama): lo reutilizo y no creo otro servicio."
      aviso "  Para que no descargue el modelo de la memoria a los 5 minutos: launchctl setenv OLLAMA_KEEP_ALIVE -1 y reinicia la app."
      aviso "  O cierra la app, quitala de los elementos de inicio y vuelve a correr el instalador para que ADACEEN maneje Ollama."
    fi
  elif curl -s -m 3 -o /dev/null "$URL_OLLAMA/" 2>/dev/null; then
    fallar "el puerto $OLLAMA_PUERTO lo usa otro programa que no es Ollama; elige otro con --puerto-ollama"
  else
    OLLAMA_EXTERNO=0
  fi
fi

# Descarga de modelos: con un Ollama temporal que hereda el proxy de esta
# terminal. El servicio no necesita salir a internet: solo atiende en 127.0.0.1.
PID_TEMPORAL=""
detener_temporal() {
  if [ -n "$PID_TEMPORAL" ]; then
    kill "$PID_TEMPORAL" >/dev/null 2>&1 || true
    wait "$PID_TEMPORAL" 2>/dev/null || true
    PID_TEMPORAL=""
  fi
}
trap detener_temporal EXIT

MODELOS_A_DESCARGAR=""
if [ "$NECESITA_OLLAMA" = 1 ]; then
  MODELOS_A_DESCARGAR="$MODELO"
  [ "$CON_IMAGENES" = 1 ] && MODELOS_A_DESCARGAR="$MODELO $MODELO_VISION"
fi
if [ -n "$MODELOS_A_DESCARGAR" ]; then
  if [ "$SIMULAR" = 1 ]; then
    info "(simulado) descargaria: $MODELOS_A_DESCARGAR"
  else
    if [ "${OLLAMA_EXTERNO:-0}" = 0 ]; then
      mkdir -p "$DIR_LOGS"
      (
        export OLLAMA_HOST="127.0.0.1:$OLLAMA_PUERTO"
        [ -n "$CARPETA_MODELOS" ] && export OLLAMA_MODELS="$CARPETA_MODELOS"
        exec "$OLLAMA_BIN" serve
      ) >>"$DIR_LOGS/ollama-descarga.log" 2>&1 &
      PID_TEMPORAL=$!
      for _ in $(seq 1 30); do
        ollama_responde && break
        sleep 1
      done
      ollama_responde || fallar "Ollama no arranco (revisa $DIR_LOGS/ollama-descarga.log)"
    fi
    for modelo in $MODELOS_A_DESCARGAR; do
      info "descargando $modelo (la primera vez tarda: el de 14B pesa unos 9 GB y el de 32B unos 20 GB)"
      OLLAMA_HOST="127.0.0.1:$OLLAMA_PUERTO" "$OLLAMA_BIN" pull "$modelo" ||
        fallar "no pude descargar $modelo. Si la red del laboratorio lo bloquea, copia la carpeta ~/.ollama/models desde otra Mac (docs/operacion/worker-mac.md)"
    done
    if [ "$ROL" = "coordinador" ]; then
      # El modelo que baja Ollama es un archivo GGUF: llama-server lo usa directamente.
      GGUF="$(OLLAMA_HOST="127.0.0.1:$OLLAMA_PUERTO" "$OLLAMA_BIN" show "$MODELO" --modelfile 2>/dev/null |
        awk '/^FROM \// {print substr($0, 6); exit}')"
      [ -n "$GGUF" ] || fallar "no encontre el archivo del modelo $MODELO en Ollama; pasalo con --gguf=<archivo>"
    fi
    detener_temporal
    ok "modelos listos: $MODELOS_A_DESCARGAR"
  fi
fi
if [ "$ROL" = "coordinador" ]; then
  if [ "$SIMULAR" = 1 ]; then
    GGUF="${GGUF:-$HOME/.ollama/models/blobs/sha256-SIMULADO}"
  else
    [ -f "$GGUF" ] || fallar "no existe el modelo $GGUF"
    [ "$(head -c 4 "$GGUF")" = "GGUF" ] || fallar "$GGUF no es un archivo GGUF (llama.cpp solo lee GGUF); pasa uno con --gguf=<archivo>"
    ok "modelo GGUF: $GGUF"
  fi
fi

# ---------------------------------------------------------------- archivos
mkdir -p "$ADACEEN_HOME" "$DIR_PLISTS" "$DIR_LOGS"
chmod 700 "$ADACEEN_HOME"
FECHA="$(date '+%Y-%m-%d %H:%M')"
URL_LLAMA="http://127.0.0.1:$PUERTO_LLAMA"

if [ "$TIENE_WORKER" = 1 ]; then
  (
    umask 077
    {
      echo "# Generado por deploy/mac/instalar-worker-mac.sh el $FECHA."
      echo "# Tiene secretos: no lo compartas ni lo subas al repositorio (permisos 600)."
      echo "AGENT_TARGET=queue"
      echo "AZURE_SERVICEBUS_CONNECTION_STRING=$AZURE_SERVICEBUS_CONNECTION_STRING"
      echo "JOBS_QUEUE_NAME=$JOBS_QUEUE_NAME"
      echo "RESULTS_QUEUE_NAME=$RESULTS_QUEUE_NAME"
      echo "WORKER_SHARED_SECRET=$WORKER_SHARED_SECRET"
      echo "QUEUE_REQUEST_TIMEOUT_MS=$QUEUE_REQUEST_TIMEOUT_MS"
      echo "QUEUE_WORKER_ID=$WORKER_ID"
      echo "QUEUE_WORKER_MAX_ATTEMPTS=3"
      echo "QUEUE_WORKER_RETRY_DELAY_MS=2000"
      echo "QUEUE_WORKER_LOCK_RENEWAL_MS=0"
      echo "QUEUE_WORKER_CONCURRENCY=$CONCURRENCIA"
      echo "QUEUE_WORKER_KINDS=$TIPOS"
      echo "QUEUE_WORKER_PRIORITY=$PRIORIDAD"
      echo "SERVICE_BUS_TRANSPORT=$TRANSPORTE"
      if [ "$ROL" = "coordinador" ]; then
        echo "# El modelo corre en llama-server, repartido entre los nodos del cluster."
        echo "OPENAI_BASE=$URL_LLAMA/v1"
        echo "QUEUE_WORKER_WARMUP=0"
        echo "# Solo toma trabajos cuando llama-server termino de cargar el modelo en el cluster."
        echo "QUEUE_WORKER_READY_URL=$URL_LLAMA/health"
      else
        echo "OLLAMA_BASE_URL=$URL_OLLAMA"
        echo "OPENAI_BASE=$URL_OLLAMA/v1"
      fi
      echo "OPENAI_API_KEY=dummy"
      echo "MODEL_TEXT=$MODELO"
      echo "OLLAMA_MODEL=$MODELO"
      if [ "$CON_IMAGENES" = 1 ]; then
        echo "MODEL_VISION=$MODELO_VISION"
        echo "OLLAMA_URL=$URL_OLLAMA"
        echo "# Memoria unificada: todas las capas del modelo de vision en la GPU (Metal)."
        echo "OLLAMA_VISION_NUM_GPU=99"
      fi
      echo "ADACEEN_LOG_LEVEL=info"
      echo "ADACEEN_LOG_STACKS=0"
      echo "WORKER_HEARTBEAT_URL=$BACKEND_URL/api/agent/heartbeat"
      echo "WORKER_HEARTBEAT_TOKEN=$WORKER_HEARTBEAT_TOKEN"
      echo "WORKER_HEARTBEAT_INTERVAL_MS=30000"
      echo "BACKEND_URL=$BACKEND_URL"
      if [ -n "$PROXY_URL" ]; then
        echo "HTTPS_PROXY=$PROXY_URL"
        echo "NO_PROXY=$NO_PROXY_URL"
      fi
    } >"$ARCHIVO_WORKER_ENV.tmp"
    mv -f "$ARCHIVO_WORKER_ENV.tmp" "$ARCHIVO_WORKER_ENV"
  )
  chmod 600 "$ARCHIVO_WORKER_ENV"
  ok "configuracion del worker en $ARCHIVO_WORKER_ENV (600)"
fi

# plist <etiqueta> <archivo log> <proceso interactivo 1|0> <directorio de trabajo> -- <argumentos...> -- <VAR=valor...>
escribir_plist() {
  local etiqueta="$1" log="$2" interactivo="$3" directorio="$4"
  shift 4
  [ "$1" = "--" ] && shift
  local destino="$DIR_PLISTS/$etiqueta.plist" tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/adaceen-plist.XXXXXX")"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0">'
    echo '<dict>'
    echo "  <key>Label</key><string>$(escapar_xml "$etiqueta")</string>"
    echo '  <key>ProgramArguments</key>'
    echo '  <array>'
    while [ $# -gt 0 ] && [ "$1" != "--" ]; do
      echo "    <string>$(escapar_xml "$1")</string>"
      shift
    done
    [ $# -gt 0 ] && shift
    echo '  </array>'
    if [ -n "$directorio" ]; then
      echo "  <key>WorkingDirectory</key><string>$(escapar_xml "$directorio")</string>"
    fi
    echo '  <key>EnvironmentVariables</key>'
    echo '  <dict>'
    echo "    <key>HOME</key><string>$(escapar_xml "$HOME")</string>"
    local par
    for par in "$@"; do
      echo "    <key>$(escapar_xml "${par%%=*}")</key><string>$(escapar_xml "${par#*=}")</string>"
    done
    echo '  </dict>'
    if [ "$MODO" = "sistema" ]; then
      echo "  <key>UserName</key><string>$(escapar_xml "$(id -un)")</string>"
      echo "  <key>GroupName</key><string>$(escapar_xml "$(id -gn)")</string>"
      echo '  <key>InitGroups</key><true/>'
    fi
    echo '  <key>RunAtLoad</key><true/>'
    echo '  <key>KeepAlive</key><true/>'
    echo '  <key>ThrottleInterval</key><integer>10</integer>'
    if [ "$interactivo" = 1 ]; then
      # Sin esto macOS puede frenar el proceso en segundo plano y la latencia sube.
      echo '  <key>ProcessType</key><string>Interactive</string>'
    fi
    echo "  <key>StandardOutPath</key><string>$(escapar_xml "$log")</string>"
    echo "  <key>StandardErrorPath</key><string>$(escapar_xml "$log")</string>"
    echo '</dict>'
    echo '</plist>'
  } >"$tmp"
  if [ "$SIMULAR" = 0 ] && command -v plutil >/dev/null 2>&1; then
    plutil -lint "$tmp" >/dev/null || fallar "plist invalido para $etiqueta"
  fi
  if [ "$MODO" = "sistema" ] && [ "$SIMULAR" = 0 ]; then
    sudo install -m 644 -o root -g wheel "$tmp" "$destino"
  else
    install -m 644 "$tmp" "$destino"
  fi
  rm -f "$tmp"
  info "servicio $etiqueta -> $destino"
}

RUTA_BASE="${NODE_DIR:+$NODE_DIR:}/usr/bin:/bin:/usr/sbin:/sbin"
SERVICIOS=""
if [ "$OLLAMA_GESTIONADO" = 1 ]; then
  VARS_OLLAMA="OLLAMA_HOST=127.0.0.1:$OLLAMA_PUERTO OLLAMA_KEEP_ALIVE=-1 OLLAMA_NUM_PARALLEL=$CONCURRENCIA OLLAMA_MAX_LOADED_MODELS=$MODELOS_CARGADOS"
  if [ -n "$CARPETA_MODELOS" ]; then
    # shellcheck disable=SC2086
    escribir_plist "$ETIQUETA_OLLAMA" "$DIR_LOGS/ollama.log" 1 "" -- "$OLLAMA_BIN" serve -- $VARS_OLLAMA "OLLAMA_MODELS=$CARPETA_MODELOS"
  else
    # shellcheck disable=SC2086
    escribir_plist "$ETIQUETA_OLLAMA" "$DIR_LOGS/ollama.log" 1 "" -- "$OLLAMA_BIN" serve -- $VARS_OLLAMA
  fi
  SERVICIOS="$ETIQUETA_OLLAMA"
fi

case "$ROL" in
  nodo)
    # Presta la memoria de esta Mac al cluster. -c guarda en disco los pesos que
    # recibe, para no volver a transferirlos por la red en cada arranque.
    escribir_plist "$ETIQUETA_NODO" "$DIR_LOGS/nodo.log" 1 "" -- \
      /usr/bin/caffeinate -ims "$RPC_SERVER_BIN" -H "$IP_CLUSTER" -p "$PUERTO_RPC" -c -- \
      "PATH=$RUTA_BASE" "LLAMA_CACHE=$ADACEEN_HOME/cache-rpc"
    SERVICIOS="$SERVICIOS $ETIQUETA_NODO"
    ;;
  coordinador)
    # El modelo se reparte entre esta Mac y los nodos en proporcion a su memoria libre.
    CONTEXTO=$((8192 * CONCURRENCIA))
    escribir_plist "$ETIQUETA_LLAMA" "$DIR_LOGS/llama.log" 1 "" -- \
      "$LLAMA_SERVER_BIN" -m "$GGUF" --rpc "$NODOS_RPC" -ngl 999 --host 127.0.0.1 --port "$PUERTO_LLAMA" \
      -c "$CONTEXTO" -np "$CONCURRENCIA" -a "$MODELO" -- \
      "PATH=$RUTA_BASE"
    SERVICIOS="$SERVICIOS $ETIQUETA_LLAMA"
    ;;
esac

if [ "$TIENE_WORKER" = 1 ]; then
  # caffeinate -ims: la Mac no se duerme mientras el worker corre (la pantalla si puede apagarse).
  escribir_plist "$ETIQUETA_WORKER" "$DIR_LOGS/worker.log" 1 "$REPO_DIR" -- \
    /usr/bin/caffeinate -ims "$NODE_BIN" --import tsx scripts/service-bus-ollama-worker.ts -- \
    "PATH=$RUTA_BASE" "ADACEEN_WORKER_ENV_FILE=$ARCHIVO_WORKER_ENV"
  SERVICIOS="$SERVICIOS $ETIQUETA_WORKER"
fi
if [ "$ROL" = "local" ]; then
  if [ "$CON_IMAGENES" = 1 ]; then
    escribir_plist "$ETIQUETA_LOCAL" "$DIR_LOGS/local.log" 0 "$REPO_DIR" -- \
      "$NODE_BIN" --import tsx scripts/dev-local.ts -- \
      "PATH=$RUTA_BASE" "PORT=3000" "ADACEEN_LISTEN_HOST=127.0.0.1" "OLLAMA_BASE_URL=$URL_OLLAMA" \
      "OLLAMA_MODEL=$MODELO" "MODEL_VISION=$MODELO_VISION" "OLLAMA_VISION_NUM_GPU=99"
  else
    escribir_plist "$ETIQUETA_LOCAL" "$DIR_LOGS/local.log" 0 "$REPO_DIR" -- \
      "$NODE_BIN" --import tsx scripts/dev-local.ts -- \
      "PATH=$RUTA_BASE" "PORT=3000" "ADACEEN_LISTEN_HOST=127.0.0.1" "OLLAMA_BASE_URL=$URL_OLLAMA" \
      "OLLAMA_MODEL=$MODELO"
  fi
  SERVICIOS="$SERVICIOS $ETIQUETA_LOCAL"
fi
SERVICIOS="${SERVICIOS# }"

# Un servicio que ya no corresponde (otro rol, o Ollama ahora externo) se quita
# para que launchd no lo vuelva a cargar en el proximo inicio de sesion.
for etiqueta in $TODAS_LAS_ETIQUETAS; do
  case " $SERVICIOS " in *" $etiqueta "*) continue ;; esac
  if [ -f "$DIR_PLISTS/$etiqueta.plist" ]; then
    con_permisos "$MODO" rm -f "$DIR_PLISTS/$etiqueta.plist"
    info "quitado el servicio $etiqueta (ya no corresponde)"
  fi
done
# Los logs se crean con el usuario: en modo sistema launchd los abriria como root.
for etiqueta in $SERVICIOS; do
  touch "$DIR_LOGS/${etiqueta##*.}.log"
done

# El worker.env solo lo usan los roles con worker: en los demas se borra (tiene secretos).
if [ "$TIENE_WORKER" = 0 ] && [ -f "$ARCHIVO_WORKER_ENV" ]; then
  rm -f "$ARCHIVO_WORKER_ENV"
  info "borrado $ARCHIVO_WORKER_ENV: este rol no usa las credenciales de la cola"
fi

{
  echo "# Instalacion de ADACEEN en esta Mac (sin secretos). La lee deploy/mac/worker-mac.sh."
  echo "MODO=$MODO"
  echo "ROL=$ROL"
  echo "REPO_DIR=$REPO_DIR"
  echo "NODE_BIN=$NODE_BIN"
  echo "OLLAMA_BIN=$OLLAMA_BIN"
  echo "OLLAMA_GESTIONADO=$OLLAMA_GESTIONADO"
  echo "OLLAMA_PUERTO=$OLLAMA_PUERTO"
  echo "CARPETA_MODELOS=$CARPETA_MODELOS"
  echo "MODELO=$([ "$ROL" != "nodo" ] && echo "$MODELO")"
  echo "MODELO_VISION=$([ "$CON_IMAGENES" = 1 ] && echo "$MODELO_VISION")"
  echo "TIPOS=$([ "$ROL" != "nodo" ] && echo "$TIPOS")"
  echo "CONCURRENCIA=$CONCURRENCIA"
  echo "PRIORIDAD=$PRIORIDAD"
  echo "WORKER_ID=$([ "$TIENE_WORKER" = 1 ] && echo "$WORKER_ID")"
  echo "BACKEND_URL=$BACKEND_URL"
  echo "NODOS=$NODOS_RPC"
  echo "IP_CLUSTER=$IP_CLUSTER"
  echo "PUERTO_RPC=$PUERTO_RPC"
  echo "PUERTO_LLAMA=$PUERTO_LLAMA"
  echo "LLAMA_DIR=$([ "$NECESITA_LLAMA" = 1 ] && echo "$LLAMA_DIR")"
  echo "GGUF=$GGUF"
  echo "SERVICIOS=$SERVICIOS"
  echo "INSTALADO_EN=$FECHA"
} >"$ARCHIVO_ESTADO"

# ---------------------------------------------------------------- arranque
# Para no confundir el latido de un worker anterior con el de este arranque.
DESDE_MS="$(date +%s)000"
llama_listo() { curl -s -m 5 "$URL_LLAMA/health" 2>/dev/null | grep -q '"ok"'; }
for etiqueta in $SERVICIOS; do
  lanzar enable "$DOMINIO/$etiqueta" || true
  lanzar bootstrap "$DOMINIO" "$DIR_PLISTS/$etiqueta.plist" ||
    fallar "launchd no acepto $etiqueta. En modo sesion, corre el instalador desde la Terminal de la sesion grafica (no por SSH)"
  [ "$SIMULAR" = 1 ] && continue
  if [ "$etiqueta" = "$ETIQUETA_OLLAMA" ]; then
    for _ in $(seq 1 30); do
      ollama_responde && break
      sleep 1
    done
    ollama_responde || fallar "el servicio de Ollama no respondio (revisa $DIR_LOGS/ollama.log)"
  fi
done

if [ "$SIMULAR" = 0 ] && [ "$ROL" = "coordinador" ]; then
  # La primera vez los pesos viajan por la red a los nodos: puede tardar varios
  # minutos. El worker ya esta encendido, pero no toma trabajos hasta que el
  # modelo este listo (QUEUE_WORKER_READY_URL).
  info "cargando $MODELO en el cluster (hasta 20 minutos la primera vez)"
  for i in $(seq 1 240); do
    llama_listo && break
    [ $((i % 12)) = 0 ] && info "  sigue cargando ($((i / 12)) min)"
    sleep 5
  done
  if llama_listo; then
    ok "llama-server listo con $MODELO repartido entre esta Mac y $NODOS_RPC"
  else
    aviso "llama-server no termino de cargar: revisa que los nodos esten encendidos y con la misma version de llama.cpp ($LLAMA_TAG); bash deploy/mac/worker-mac.sh logs llama"
  fi
fi

if [ "$SIMULAR" = 0 ] && [ "$ROL" = "nodo" ]; then
  for _ in $(seq 1 20); do
    nc -z -G 2 "$IP_CLUSTER" "$PUERTO_RPC" >/dev/null 2>&1 && break
    sleep 1
  done
  if nc -z -G 2 "$IP_CLUSTER" "$PUERTO_RPC" >/dev/null 2>&1; then
    ok "nodo escuchando en $IP_CLUSTER:$PUERTO_RPC"
  else
    aviso "el nodo no escucha en $IP_CLUSTER:$PUERTO_RPC: revisa que esa IP sea de esta Mac (bash deploy/mac/worker-mac.sh logs nodo)"
  fi
fi

if [ "$SIMULAR" = 0 ] && [ "$ROL" != "coordinador" ] && [ -n "$MODELOS_A_DESCARGAR" ]; then
  # Precarga: el primer estudiante no espera a que el modelo suba a memoria.
  for modelo in $MODELOS_A_DESCARGAR; do
    if curl -sf -m 300 "$URL_OLLAMA/api/generate" -d "{\"model\":\"$modelo\",\"prompt\":\"\",\"keep_alive\":-1}" >/dev/null; then
      ok "$modelo cargado en memoria"
    else
      aviso "no pude precargar $modelo (se cargara con el primer trabajo)"
    fi
  done
fi

# Prueba de velocidad: cuanto tardaria una peticion tipica.
if [ "$SIMULAR" = 0 ]; then
  if [ "$ROL" = "coordinador" ]; then
    if llama_listo; then
      NODE_BIN="$NODE_BIN" MOTOR=llama URL_LLAMA="$URL_LLAMA" MODELO="$MODELO" bash "$DIR_SCRIPT/velocidad.sh" || true
    fi
  elif [ "$ROL" != "nodo" ]; then
    NODE_BIN="$NODE_BIN" URL_OLLAMA="$URL_OLLAMA" MODELO="$MODELO" bash "$DIR_SCRIPT/velocidad.sh" || true
  fi
fi

if [ "$TIENE_WORKER" = 1 ] && [ "$SIMULAR" = 0 ]; then
  if [ -n "$WORKER_HEARTBEAT_TOKEN" ]; then
    info "esperando el latido de $WORKER_ID en $BACKEND_URL (hasta 90 s)"
    visto=0
    for _ in $(seq 1 18); do
      sleep 5
      if curl -s -m 10 "$BACKEND_URL/api/agent/backend" 2>/dev/null |
        WID="$WORKER_ID" DESDE_MS="$DESDE_MS" "$NODE_BIN" -e 'let t="";process.stdin.on("data",c=>t+=c).on("end",()=>{try{const d=JSON.parse(t);const desde=Number(process.env.DESDE_MS)-5000;process.exit((d.listening||[]).some(w=>w.id===process.env.WID&&w.alive&&Date.parse(w.startedAt||0)>=desde)?0:1)}catch{process.exit(1)}})'; then
        visto=1
        break
      fi
    done
    if [ "$visto" = 1 ]; then
      ok "Azure ya ve a $WORKER_ID escuchando la cola"
    else
      aviso "Azure todavia no ve el latido de $WORKER_ID: revisa bash deploy/mac/worker-mac.sh logs"
    fi
  fi
elif [ "$ROL" = "local" ] && [ "$SIMULAR" = 0 ]; then
  for _ in $(seq 1 30); do
    curl -s -m 3 "http://127.0.0.1:3000/health" 2>/dev/null | grep -q '"mode"' && break
    sleep 2
  done
  if curl -s -m 3 "http://127.0.0.1:3000/health" 2>/dev/null | grep -q '"mode"'; then
    ok "backend local en http://127.0.0.1:3000 (VS Code de esta Mac lo usa solo)"
  else
    aviso "el backend local no respondio: revisa bash deploy/mac/worker-mac.sh logs local"
  fi
fi

echo
case "$ROL" in
  nodo)
    ok "listo: nodo del cluster en $IP_CLUSTER:$PUERTO_RPC, llama.cpp $LLAMA_TAG, modo $MODO"
    info "en la coordinadora usa la misma version: --version-llama=$LLAMA_TAG"
    ;;
  coordinador)
    ok "listo: coordinadora del cluster, modelo $MODELO repartido con $NODOS_RPC, id $WORKER_ID, llama.cpp $LLAMA_TAG"
    info "los nodos deben tener la misma version: --version-llama=$LLAMA_TAG"
    ;;
  *)
    ok "listo: rol $ROL, modo $MODO, modelo $MODELO, tipos $TIPOS, concurrencia $CONCURRENCIA$([ "$TIENE_WORKER" = 1 ] && echo ", id $WORKER_ID")$([ "$PRIORIDAD" = "backup" ] && echo ", de respaldo")"
    ;;
esac
info "estado: bash deploy/mac/worker-mac.sh estado   |   detener: bash deploy/mac/worker-mac.sh detener"
if [ "$SIMULAR" = 1 ]; then
  info "archivos simulados en $DIR_SIMULACION"
fi
