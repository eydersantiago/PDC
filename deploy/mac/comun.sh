# shellcheck shell=bash
# shellcheck disable=SC2034  # las variables las usan los scripts que cargan este archivo
# Rutas y funciones compartidas por instalar-worker-mac.sh y worker-mac.sh.
# Se escribe para el bash 3.2 que trae macOS: sin arreglos asociativos,
# sin ${var,,} y sin mapfile.

ADACEEN_PREFIJO="co.edu.univalle.adaceen"
ETIQUETA_OLLAMA="$ADACEEN_PREFIJO.ollama"
ETIQUETA_WORKER="$ADACEEN_PREFIJO.worker"
ETIQUETA_LOCAL="$ADACEEN_PREFIJO.local"
# Modo cluster (memoria de varias Mac para un modelo mas grande, con llama.cpp RPC):
ETIQUETA_LLAMA="$ADACEEN_PREFIJO.llama"   # llama-server en la Mac coordinadora
ETIQUETA_NODO="$ADACEEN_PREFIJO.nodo"     # ggml-rpc-server en cada Mac nodo

# Todo lo que instala el script vive aqui (fuera del repositorio):
#   worker.env          configuracion y secretos del worker (permisos 600)
#   instalacion.env     que se instalo, sin secretos (lo lee worker-mac.sh)
#   node/, ollama/      Node y Ollama descargados si la Mac no los tenia
#   llama.cpp/          llama.cpp oficial (modo cluster)
#   cache-rpc/          copia local de los pesos que recibe un nodo del cluster
ADACEEN_HOME="${ADACEEN_HOME:-$HOME/.adaceen}"
ARCHIVO_ESTADO="$ADACEEN_HOME/instalacion.env"
ARCHIVO_WORKER_ENV="$ADACEEN_HOME/worker.env"
DIR_LOGS="${ADACEEN_DIR_LOGS:-$HOME/Library/Logs/ADACEEN}"
BACKEND_PRODUCCION="https://app-adaceen-api-eyder05232002.azurewebsites.net"

info() { printf '[adaceen] %s\n' "$*"; }
ok() { printf '[adaceen] ✓ %s\n' "$*"; }
aviso() { printf '[adaceen] AVISO: %s\n' "$*" >&2; }
fallar() {
  printf '[adaceen] ERROR: %s\n' "$*" >&2
  exit 1
}

# "sesion": LaunchAgents del usuario (sin permisos de administrador; corre
# mientras la sesion este abierta). "sistema": LaunchDaemons (arranca con la
# Mac aunque nadie inicie sesion; pide la clave de administrador).
dir_plists() {
  if [ "$1" = "sistema" ]; then echo "/Library/LaunchDaemons"; else echo "$HOME/Library/LaunchAgents"; fi
}

dominio_launchd() {
  if [ "$1" = "sistema" ]; then echo "system"; else echo "gui/$(id -u)"; fi
}

# Ejecuta con sudo solo en modo sistema.
con_permisos() {
  local modo="$1"
  shift
  if [ "$modo" = "sistema" ]; then sudo "$@"; else "$@"; fi
}

escapar_xml() {
  local valor="$1"
  valor="${valor//&/&amp;}"
  valor="${valor//</&lt;}"
  valor="${valor//>/&gt;}"
  printf '%s' "$valor"
}

# Lee instalacion.env sin ejecutarlo: solo claves conocidas, valor tal cual.
leer_estado() {
  [ -f "$ARCHIVO_ESTADO" ] || return 1
  local linea clave valor
  while IFS= read -r linea || [ -n "$linea" ]; do
    linea="${linea%$'\r'}"
    case "$linea" in '' | '#'*) continue ;; esac
    clave="${linea%%=*}"
    valor="${linea#*=}"
    case "$clave" in
      MODO | ROL | REPO_DIR | NODE_BIN | OLLAMA_BIN | OLLAMA_GESTIONADO | OLLAMA_PUERTO | CARPETA_MODELOS | MODELO | MODELO_VISION | TIPOS | CONCURRENCIA | PRIORIDAD | WORKER_ID | BACKEND_URL | SERVICIOS | INSTALADO_EN | NODOS | IP_CLUSTER | PUERTO_RPC | PUERTO_LLAMA | LLAMA_DIR | GGUF)
        printf -v "EST_$clave" '%s' "$valor"
        ;;
    esac
  done <"$ARCHIVO_ESTADO"
  return 0
}

# "10.77.0.2" o "10.77.0.2:50052" -> valido (IPv4 con puerto opcional).
es_ip_puerto() {
  local re='^([0-9]{1,3}\.){3}[0-9]{1,3}(:[0-9]{1,5})?$'
  [[ $1 =~ $re ]]
}

# Rota un log si pasa de 20 MB (launchd no los rota).
rotar_log() {
  local archivo="$1"
  [ -f "$archivo" ] || return 0
  local kb
  kb=$(du -k "$archivo" 2>/dev/null | awk '{print $1}')
  if [ "${kb:-0}" -gt 20480 ]; then
    mv -f "$archivo" "$archivo.1"
    : >"$archivo"
  fi
}
