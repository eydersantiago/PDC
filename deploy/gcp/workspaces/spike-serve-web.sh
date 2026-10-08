#!/usr/bin/env bash
# Spike: VS Code Web servido desde ESTA VM con `code serve-web`, un servidor
# por estudiante, sin Dev Tunnels, sin codigo de dispositivo de GitHub y sin
# inicio de sesion en vscode.dev (docs/workspaces-serve-web.md).
#
#   spike-serve-web.sh <login-github> [url-repo] [--mostrar-token]
#   spike-serve-web.sh rotar  <login-github>                  token nuevo + reinicio
#   spike-serve-web.sh quitar <login-github> [--borrar-usuario]
#
# Que hace (preparar), en el mismo orden que nuevo-tunel.sh:
#   1. usuario Linux ws-<login> (home 0700, aislado de los demas ws-*)
#   2. clona el repo en ~/proyecto COMO el estudiante (si falta) y escribe los
#      ajustes de maquina del servidor de VS Code (misma ruta que el tunel:
#      ~/.vscode-server/data/Machine/settings.json)
#   3. token de conexion en /etc/adaceen-web/ws-<login>.token (0600, de root).
#      systemd se lo pasa al servicio con LoadCredential=: nunca va en la linea
#      de comandos (ps la ve cualquier ws-*) ni en un archivo que otro
#      estudiante pueda leer. El CLI lo copia a ~/.vscode/cli/serve-web-token
#      (0600 del propio estudiante: es su llave, no la de nadie mas).
#   4. puerto estable por login: 20000 + CRC(login) mod 10000, el siguiente
#      libre si choca con otro login; queda en /etc/adaceen-web/ws-<login>.env
#   5. plantilla systemd adaceen-web@.service (User=%i; code serve-web en
#      127.0.0.1:<puerto> bajo /ws-<login>/) y arranque del servicio
#   6. extension ADACEEN (/opt/adaceen/adaceen.vsix si existe, si no la del
#      Marketplace) y las del lenguaje del repo. `code serve-web` NO tiene
#      --install-extension (cli/src/commands/args.rs): se instalan con el
#      servidor que el CLI baja a ~/.vscode/cli/serve-web/<commit>/bin/, que si
#      lo tiene, en ~/.vscode-server/extensions (la misma carpeta del tunel).
# Imprime la URL local; el token solo con --mostrar-token.
#
# Solo root. Idempotente: volver a correrlo conserva token y puerto, rescribe
# la plantilla solo si cambio y reinicia el servicio solo si hace falta.
# Pruebas: deploy/gcp/workspaces/agente/vm-scripts.test.mjs (se carga con
# `source` y se llaman las funciones con rutas temporales y comandos falsos).
set -euo pipefail

# Rutas y comandos (las pruebas los cambian; en la VM valen los defectos).
: "${ADACEEN_DIR:=/opt/adaceen}"
: "${ADACEEN_VSIX:=$ADACEEN_DIR/adaceen.vsix}"
: "${ADACEEN_WS_ENV:=/etc/adaceen-ws.env}"
: "${DIR_HOMES:=/home}"
: "${DIR_WEB:=/etc/adaceen-web}"
: "${UNIDAD_WEB:=/etc/systemd/system/adaceen-web@.service}"
: "${CODE_BIN:=/usr/local/bin/code}"
: "${HOST_WEB:=127.0.0.1}"
: "${PUERTO_BASE:=20000}"
: "${PUERTO_RANGO:=10000}"
# Segundos de espera a que el CLI baje el servidor web (primer arranque,
# ~100 MB por estudiante) antes de instalar las extensiones.
: "${ESPERA_SERVIDOR_S:=90}"
DIR_SPIKE_WEB=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# escribir_si_cambia, args_extensiones_lenguaje, cerrar_home_estudiante,
# tunel_desactualizado y LOGIN_TUNEL_RE: las mismas piezas del tunel.
# shellcheck source=tunel-comun.sh
source "$DIR_SPIKE_WEB/tunel-comun.sh"

UNIDAD_WEB_CAMBIO=0
ENTORNO_WEB_CAMBIO=0
TOKEN_WEB_CAMBIO=0

exigir_root() {
  if [ "$(id -u)" != 0 ]; then
    echo "solo root (sudo bash $0 ...)" >&2
    return 1
  fi
}

# Lo que acepta nuevo-tunel.sh: minusculas, digitos y guiones, 28 como maximo.
normalizar_login() {
  local login
  login=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')
  if ! [[ $login =~ $LOGIN_TUNEL_RE ]]; then
    echo "login invalido: se espera el usuario de GitHub (ej. eydersantiago), no el correo" >&2
    return 1
  fi
  printf '%s\n' "$login"
}

como() { sudo -u "$USUARIO" -H env HOME="$HOMEDIR" "$@"; }

# Escribe stdin en ~/<ruta> COMO el estudiante (el mismo bloque que
# nuevo-tunel.sh): carpetas 0700, archivo con el modo pedido, temporal + rename.
# shellcheck disable=SC2016  # las variables se expanden en el bash del estudiante
ESCRIBIR_EN_HOME='set -eu
umask 077
destino=$HOME/$1
carpeta=$(dirname "$destino")
mkdir -p "$carpeta"
chmod 700 "$carpeta"
tmp=$(mktemp "$destino.XXXXXX")
if ! cat > "$tmp"; then rm -f "$tmp"; exit 1; fi
chmod "$2" "$tmp"
mv -f "$tmp" "$destino"'
escribir_en_home() { como bash -c "$ESCRIBIR_EN_HOME" escribir-en-home "$1" "$2"; }

# --- puerto por login ---
# CRC del login (cksum) sobre el rango: el mismo login da siempre el mismo
# puerto, y dos logins distintos chocan pocas veces (se resuelve abajo).
puerto_de_login() {
  local crc
  crc=$(printf '%s' "$1" | cksum | cut -d' ' -f1)
  printf '%s\n' $((PUERTO_BASE + crc % PUERTO_RANGO))
}

# 0 si otro login ya tiene ese puerto en $DIR_WEB.
puerto_ocupado() {
  local puerto=$1 propio=$2 archivo
  for archivo in "$DIR_WEB"/ws-*.env; do
    [ -f "$archivo" ] || continue
    [ "$archivo" = "$DIR_WEB/ws-$propio.env" ] && continue
    if grep -qx "PUERTO=$puerto" "$archivo"; then
      return 0
    fi
  done
  return 1
}

# El puerto guardado si ya lo tiene; si no, el del CRC o el siguiente libre.
asignar_puerto() {
  local login=$1 guardado puerto intentos=0
  if [ -f "$DIR_WEB/ws-$login.env" ]; then
    guardado=$(sed -n 's/^PUERTO=\([0-9]\{1,5\}\)$/\1/p' "$DIR_WEB/ws-$login.env" | head -n 1)
    if [ -n "$guardado" ]; then
      printf '%s\n' "$guardado"
      return 0
    fi
  fi
  puerto=$(puerto_de_login "$login")
  while puerto_ocupado "$puerto" "$login"; do
    intentos=$((intentos + 1))
    if [ "$intentos" -ge "$PUERTO_RANGO" ]; then
      echo "sin puertos libres en $PUERTO_BASE-$((PUERTO_BASE + PUERTO_RANGO - 1))" >&2
      return 1
    fi
    puerto=$((PUERTO_BASE + (puerto - PUERTO_BASE + 1) % PUERTO_RANGO))
  done
  printf '%s\n' "$puerto"
}

# --- token de conexion (de root) ---
token_nuevo() {
  openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

# Crea el token si falta (o siempre, con rotar=1). Deja TOKEN_WEB_CAMBIO=1 si
# lo escribio. El valor nunca se imprime aqui.
escribir_token_web() {
  local login=$1 rotar=${2:-0} archivo="$DIR_WEB/ws-$login.token" token
  TOKEN_WEB_CAMBIO=0
  if [ "$rotar" != 1 ] && [ -s "$archivo" ]; then
    return 0
  fi
  token=$(token_nuevo)
  # Solo lo que acepta el servidor (serverConnectionToken.ts: [0-9A-Za-z_-]+).
  if ! [[ $token =~ ^[0-9A-Za-z_-]{32,}$ ]]; then
    echo "no se pudo generar el token" >&2
    return 1
  fi
  # Sin tuberia: escribir_si_cambia debe correr en este shell para dejar
  # ESCRITURA_CAMBIO (el ultimo tramo de una tuberia es un subshell).
  escribir_si_cambia "$archivo" 600 <<< "$token" || return 1
  TOKEN_WEB_CAMBIO=$ESCRITURA_CAMBIO
}

leer_token_web() {
  head -n 1 "$DIR_WEB/ws-$1.token"
}

# /etc/adaceen-web/ws-<login>.env: lo unico que usa ExecStart.
escribir_entorno_web() {
  local login=$1 puerto=$2
  ENTORNO_WEB_CAMBIO=0
  escribir_si_cambia "$DIR_WEB/ws-$login.env" 600 <<EOF || return 1
PUERTO=$puerto
HOST_WEB=$HOST_WEB
EOF
  ENTORNO_WEB_CAMBIO=$ESCRITURA_CAMBIO
}

# Plantilla adaceen-web@.service. Se reescribe siempre (idempotente);
# daemon-reload solo si cambio.
instalar_unidad_web() {
  UNIDAD_WEB_CAMBIO=0
  escribir_si_cambia "$UNIDAD_WEB" 644 <<'EOF' || return 1
[Unit]
Description=ADACEEN VS Code Web (code serve-web) para %i
# adaceen-ws-metadata: solo root habla con el servidor de metadata (como el tunel).
After=network-online.target adaceen-ws-metadata.service
Wants=network-online.target adaceen-ws-metadata.service

[Service]
User=%i
WorkingDirectory=/home/%i
# Solo el puerto y el host (de root, 0600). Nada de /etc/adaceen-ws.env ni de
# secretos de la VM: todo lo que llega aqui lo ve el estudiante en su terminal.
EnvironmentFile=/etc/adaceen-web/%i.env
# El token lo lee systemd como root y lo deja en un directorio privado del
# servicio (%d = $CREDENTIALS_DIRECTORY, systemd 250+; Debian 12 trae 252).
# Asi no va en la linea de comandos (ps la ve cualquier ws-*) ni en un
# archivo legible por otros estudiantes. --connection-token (valor en la
# linea) queda prohibido por eso mismo.
LoadCredential=token:/etc/adaceen-web/%i.token
# Escucha solo dentro de la VM; la entrada publica llega por el proxy de
# rutas (docs/workspaces-serve-web.md). --server-base-path /%i/: un camino
# por estudiante, para que un solo host sirva a todos.
ExecStart=/usr/local/bin/code serve-web --host ${HOST_WEB} --port ${PUERTO} --server-base-path /%i/ --connection-token-file %d/token --default-folder /home/%i/proyecto --accept-server-license-terms --disable-telemetry
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  UNIDAD_WEB_CAMBIO=$ESCRITURA_CAMBIO
  if [ "$UNIDAD_WEB_CAMBIO" = 1 ]; then
    systemctl daemon-reload
  fi
}

# El servidor web que bajo el CLI (el mas reciente), o nada.
servidor_web_de() {
  local home=$1 candidato ultimo=""
  for candidato in "$home"/.vscode/cli/serve-web/*/bin/code-server; do
    [ -x "$candidato" ] || continue
    if [ -z "$ultimo" ] || [ "$candidato" -nt "$ultimo" ]; then
      ultimo=$candidato
    fi
  done
  [ -n "$ultimo" ] || return 1
  printf '%s\n' "$ultimo"
}

# Extension ADACEEN y las del lenguaje, con el servidor del CLI, como el
# estudiante. Si el servidor aun no bajo (primer arranque), espera hasta
# ESPERA_SERVIDOR_S; si no aparece, avisa y sigue (se puede repetir el script).
instalar_extensiones_web() {
  local login=$1 ext="adaceen.adaceen" servidor="" esperado=0 args
  if [ -f "$ADACEEN_VSIX" ]; then
    ext="$ADACEEN_VSIX"
  fi
  until servidor=$(servidor_web_de "$HOMEDIR"); do
    if [ "$esperado" -ge "$ESPERA_SERVIDOR_S" ]; then
      echo "--- AVISO: el CLI aun no bajo el servidor web (~/.vscode/cli/serve-web/*/bin/code-server);"
      echo "    vuelve a correr el script cuando journalctl -u adaceen-web@$USUARIO diga 'Web UI available'"
      return 0
    fi
    sleep 5
    esperado=$((esperado + 5))
  done
  args=$(args_extensiones_lenguaje "$HOMEDIR/proyecto")
  echo "--- extensiones: $ext${args:+ $args}"
  # shellcheck disable=SC2086  # args son ids del Marketplace separados por espacios
  como "$servidor" --accept-server-license-terms --install-extension "$ext" $args \
    || echo "--- AVISO: fallo la instalacion de extensiones (ver arriba); el editor funciona sin ellas"
}

url_local() {
  local login=$1 puerto=$2 token=$3
  printf 'http://127.0.0.1:%s/ws-%s/?tkn=%s\n' "$puerto" "$login" "$token"
}

preparar() {
  local login=$1 repo=$2 mostrar=${3:-0} puerto token unidad api_url
  USUARIO="ws-$login"
  HOMEDIR="$DIR_HOMES/$USUARIO"
  case "$repo" in
    -* | '' | *[[:space:]]*) echo "url del repo invalida: $repo" >&2; return 1 ;;
  esac
  if [ ! -x "$CODE_BIN" ]; then
    echo "--- AVISO: no esta el CLI de VS Code en $CODE_BIN (lo instala startup-ws.sh); el servicio no arrancara"
  fi
  if [ -f "$ADACEEN_WS_ENV" ]; then
    # shellcheck source=/dev/null
    api_url=$(. "$ADACEEN_WS_ENV"; printf '%s' "${ADACEEN_API_URL:-}")
  fi
  api_url=${api_url:-https://app-adaceen-api-eyder05232002.azurewebsites.net}

  # 1. usuario
  if ! getent passwd "$USUARIO" >/dev/null 2>&1; then
    useradd -m -s /bin/bash "$USUARIO"
  fi
  cerrar_home_estudiante "$login"

  # 2. repo y ajustes de maquina (como el estudiante)
  if [ ! -d "$HOMEDIR/proyecto/.git" ]; then
    como git clone "$repo" "$HOMEDIR/proyecto"
  fi
  escribir_en_home .vscode-server/data/Machine/settings.json 644 <<EOF
{
  "adaceen.backend.baseUrl": "$api_url",
  "adaceen.backend.autoWorkerEnabled": true,
  "adaceen.backend.workerPollMs": 8000,
  "java.configuration.updateBuildConfiguration": "automatic",
  "python.defaultInterpreterPath": "/usr/bin/python3"
}
EOF

  # 3 y 4. token y puerto (de root)
  mkdir -p "$DIR_WEB" && chmod 700 "$DIR_WEB"
  escribir_token_web "$login"
  puerto=$(asignar_puerto "$login")
  escribir_entorno_web "$login" "$puerto"
  if [ "$TOKEN_WEB_CAMBIO" = 1 ]; then
    echo "--- puerto $puerto para $USUARIO, token nuevo en $DIR_WEB/$USUARIO.token"
  else
    echo "--- puerto $puerto para $USUARIO, token de antes"
  fi

  # 5. servicio
  instalar_unidad_web
  unidad="adaceen-web@$USUARIO.service"
  systemctl enable "$unidad"
  if systemctl is-active --quiet "$unidad" \
     && { [ "$UNIDAD_WEB_CAMBIO$ENTORNO_WEB_CAMBIO$TOKEN_WEB_CAMBIO" != 000 ] \
          || tunel_desactualizado "$unidad" "$UNIDAD_WEB" "$DIR_WEB/$USUARIO.env" \
               "$DIR_WEB/$USUARIO.token" "$ADACEEN_VSIX"; }; then
    systemctl restart "$unidad"
  else
    systemctl start "$unidad"
  fi

  # 6. extensiones (necesita el servidor que baja el CLI al arrancar)
  instalar_extensiones_web "$login"

  token=$(leer_token_web "$login")
  cat <<EOF

=== VS Code Web listo para $login ===
  servicio: $unidad  (escucha en $HOST_WEB:$puerto, camino /ws-$login/)
EOF
  if [ "$mostrar" = 1 ]; then
    echo "  abrir:    $(url_local "$login" "$puerto" "$token")"
  else
    echo "  abrir:    $(url_local "$login" "$puerto" '<token>')   (el token: --mostrar-token)"
  fi
  cat <<EOF
  La primera vez el navegador guarda el token en la cookie vscode-tkn (una
  semana) y la URL queda sin ?tkn=.

  Desde tu portatil: el servicio escucha solo en $HOST_WEB de la VM, asi que
  start-iap-tunnel (que entra por la IP interna) no llega; reenvia el puerto
  por SSH a traves de IAP y abre la URL de arriba en el navegador:
    gcloud compute ssh adaceen-ws --zone=us-central1-a --tunnel-through-iap -- -N -L $puerto:127.0.0.1:$puerto
  (Con HOST_WEB=<ip-interna> y una regla de firewall tcp:$puerto para
   35.235.240.0/20 sirve el start-iap-tunnel de docs/workspaces-tunnel.md.)

  log:      journalctl -u $unidad -f
  parar:    systemctl stop $unidad
  rotar:    bash $0 rotar $login
  quitar:   bash $0 quitar $login [--borrar-usuario]
EOF
}

rotar() {
  local login=$1 unidad
  USUARIO="ws-$login"
  if [ ! -f "$DIR_WEB/ws-$login.token" ]; then
    echo "no hay token para $USUARIO (primero: $0 $login <repo>)" >&2
    return 1
  fi
  escribir_token_web "$login" 1
  unidad="adaceen-web@$USUARIO.service"
  # El servidor lee el archivo del token al arrancar: hay que reiniciarlo. La
  # cookie vieja deja de valer; el estudiante vuelve a entrar desde ADACEEN.
  systemctl restart "$unidad"
  echo "--- token de $USUARIO rotado y servicio reiniciado"
}

quitar() {
  local login=$1 borrar_usuario=${2:-0}
  USUARIO="ws-$login"
  systemctl disable --now "adaceen-web@$USUARIO.service" || true
  rm -f "$DIR_WEB/ws-$login.env" "$DIR_WEB/ws-$login.token"
  echo "--- servicio, puerto y token de $USUARIO eliminados"
  if [ "$borrar_usuario" = 1 ]; then
    # Tambien se lleva ~/proyecto y el tunel, si lo tenia: solo para logins de prueba.
    if getent passwd "$USUARIO" >/dev/null 2>&1; then
      systemctl disable --now "adaceen-tunnel@$USUARIO.service" 2>/dev/null || true
      userdel -r "$USUARIO"
      rm -f "$DIR_ENTORNOS_TUNEL/$USUARIO.env"
      echo "--- usuario $USUARIO y su home borrados"
    fi
  else
    echo "    (el usuario y ~/proyecto siguen; --borrar-usuario los quita)"
  fi
}

uso() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//' >&2
}

main() {
  local accion=${1:-} login repo mostrar=0 borrar=0 arg
  case "$accion" in
    '' | -h | --help) uso; return 1 ;;
    quitar)
      exigir_root
      login=$(normalizar_login "${2:?login de github}")
      for arg in "${@:3}"; do [ "$arg" = --borrar-usuario ] && borrar=1; done
      quitar "$login" "$borrar" ;;
    rotar)
      exigir_root
      login=$(normalizar_login "${2:?login de github}")
      rotar "$login" ;;
    *)
      exigir_root
      login=$(normalizar_login "$accion")
      repo=https://github.com/eydersantiago/FadaProyecto.git
      for arg in "${@:2}"; do
        case "$arg" in
          --mostrar-token) mostrar=1 ;;
          *) repo=$arg ;;
        esac
      done
      preparar "$login" "$repo" "$mostrar" ;;
  esac
}

# Las pruebas cargan este archivo con `source` y llaman a las funciones.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
