#!/usr/bin/env bash
# Piezas del servicio adaceen-tunnel@ws-<login> que comparten nuevo-tunel.sh
# (al preparar a un estudiante) y startup-ws.sh (en cada arranque de la VM).
# Se carga con `source`, solo como root; al cargarse no hace nada.
#
# Seguridad (docs/workspaces-tunnel.md, "Seguridad de la VM"):
#   - el entorno de cada tunel vive en /etc/adaceen-tunnels/ws-<login>.env, de
#     root. Antes estaba en ~/.adaceen/tunnel.env, que es del estudiante:
#     systemd lo lee como root, asi que un enlace simbolico a
#     /etc/adaceen-workspaces-agent.env ponia el token del agente en su terminal.
#   - la unidad NO carga /etc/adaceen-ws.env: solo TUNEL, ADACEEN_EXT y
#     LANG_EXT_ARGS, mas ADACEEN_SCAN_WORKER_KEY si la metadata scan-worker-key
#     existe (/etc/adaceen-ws-tunel.env). Todo lo que llega al proceso del
#     tunel lo ve el estudiante en la terminal de vscode.dev.
#   - arranca despues de adaceen-ws-metadata.service (bloqueo de la metadata
#     para los usuarios no root, lo instala startup-ws.sh). Es Wants y no
#     Requires: si el bloqueo falla, los editores siguen (y el fallo queda en
#     journalctl -u adaceen-ws-metadata).
#   - el home de cada estudiante queda 0700 (cerrar_home_estudiante): useradd
#     de Debian 12 lo crea 0755 y los demas ws-* podrian leer su ~/proyecto.
#
# Pruebas: deploy/gcp/workspaces/agente/vm-scripts.test.mjs

# Rutas (las pruebas las cambian; en la VM valen los defectos).
: "${ADACEEN_DIR:=/opt/adaceen}"
: "${ADACEEN_VSIX:=$ADACEEN_DIR/adaceen.vsix}"
: "${DIR_HOMES:=/home}"
: "${DIR_ENTORNOS_TUNEL:=/etc/adaceen-tunnels}"
: "${UNIDAD_TUNEL:=/etc/systemd/system/adaceen-tunnel@.service}"
DIR_TUNEL_COMUN=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# El mismo login que acepta nuevo-tunel.sh (y el agente, parse.mjs).
LOGIN_TUNEL_RE='^[a-z0-9][a-z0-9-]{0,27}$'

ESCRITURA_CAMBIO=0
UNIDAD_TUNEL_CAMBIO=0
ENTORNO_TUNEL_CAMBIO=0
EXT_LENGUAJE_TUNEL=""

# Deja stdin en <destino> (de root, con <modo>) solo si cambio: temporal en la
# misma carpeta + rename. ESCRITURA_CAMBIO=1 si lo reemplazo.
escribir_si_cambia() {
  local destino=$1 modo=$2 tmp
  ESCRITURA_CAMBIO=0
  tmp=$(mktemp "$destino.XXXXXX") || return 1
  if ! cat > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if [ -f "$destino" ] && cmp -s "$tmp" "$destino"; then
    rm -f "$tmp"
    return 0
  fi
  if ! chmod "$modo" "$tmp" || ! mv -f "$tmp" "$destino"; then
    rm -f "$tmp"
    return 1
  fi
  ESCRITURA_CAMBIO=1
}

# Dev Tunnels limita el nombre a 20 caracteres. El nombre solo tiene que ser
# unico dentro de la cuenta del estudiante, asi que basta un prefijo corto.
nombre_tunel() {
  printf 'ad-%s\n' "${1:0:17}"
}

# "--install-extension <id> ..." segun los lenguajes de <carpeta>
# (detectar-lenguajes.sh): sirve para cualquier repo de GitHub, no solo Java.
args_extensiones_lenguaje() {
  local carpeta=$1 id args=""
  if [ ! -d "$carpeta" ]; then
    return 0
  fi
  while IFS= read -r id; do
    # Solo ids del Marketplace: ni espacios ni opciones coladas en ExecStart.
    if [[ $id =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then
      args="$args --install-extension $id"
    fi
  done < <(bash "$DIR_TUNEL_COMUN/detectar-lenguajes.sh" "$carpeta" 2>/dev/null || true)
  printf '%s' "${args# }"
}

# /etc/adaceen-tunnels/ws-<login>.env: lo unico que usa ExecStart. Deja
# ENTORNO_TUNEL_CAMBIO=1 si cambio (el tunel lo toma al reiniciarse) y en
# EXT_LENGUAJE_TUNEL las extensiones por lenguaje elegidas.
escribir_entorno_tunel() {
  local login=$1 ext="adaceen.adaceen"
  ENTORNO_TUNEL_CAMBIO=0
  if ! [[ $login =~ $LOGIN_TUNEL_RE ]]; then
    echo "login invalido para el tunel: $login" >&2
    return 1
  fi
  # El VSIX de /opt/adaceen (lo pone al dia startup-ws.sh con instalar-vsix.sh)
  # gana al del Marketplace; sin VSIX, la version publicada.
  if [ -f "$ADACEEN_VSIX" ]; then
    ext="$ADACEEN_VSIX"
  fi
  EXT_LENGUAJE_TUNEL=$(args_extensiones_lenguaje "$DIR_HOMES/ws-$login/proyecto")
  if ! mkdir -p "$DIR_ENTORNOS_TUNEL" || ! chmod 700 "$DIR_ENTORNOS_TUNEL"; then
    return 1
  fi
  escribir_si_cambia "$DIR_ENTORNOS_TUNEL/ws-$login.env" 600 <<EOF || return 1
TUNEL=$(nombre_tunel "$login")
ADACEEN_EXT=$ext
LANG_EXT_ARGS=$EXT_LENGUAJE_TUNEL
EOF
  # shellcheck disable=SC2034  # lo leen nuevo-tunel.sh y startup-ws.sh
  ENTORNO_TUNEL_CAMBIO=$ESCRITURA_CAMBIO
}

# Logins con un tunel preparado: entorno en /etc o, de antes de este cambio,
# ~/.adaceen/tunnel.env (solo se mira si existe; root nunca lo lee).
logins_con_tunel() {
  local d usuario login
  for d in "$DIR_HOMES"/ws-*; do
    [ -d "$d" ] || continue
    usuario=${d##*/}
    login=${usuario#ws-}
    [[ $login =~ $LOGIN_TUNEL_RE ]] || continue
    if [ -f "$DIR_ENTORNOS_TUNEL/$usuario.env" ] || [ -f "$d/.adaceen/tunnel.env" ]; then
      printf '%s\n' "$login"
    fi
  done
}

# Home del estudiante 0700. useradd de Debian 12 lo crea 0755 (UMASK 022 y
# HOME_MODE comentado en login.defs): cualquier otro ws-* leeria su
# ~/proyecto desde la terminal de vscode.dev. Nadie mas necesita entrar: el
# tunel corre como el propio estudiante y el agente como root. /home es de
# root, asi que ws-<login> no puede ser un enlace del estudiante; igual se mira.
cerrar_home_estudiante() {
  local home="$DIR_HOMES/ws-$1"
  if [ -d "$home" ] && [ ! -L "$home" ]; then
    chmod 700 "$home"
  fi
}

# Todos los ws-* (tambien los que no llegaron a tener tunel). Idempotente.
cerrar_homes_estudiantes() {
  local d login
  for d in "$DIR_HOMES"/ws-*; do
    login=${d##*/ws-}
    [[ $login =~ $LOGIN_TUNEL_RE ]] || continue
    cerrar_home_estudiante "$login" || echo "--- AVISO: no se pudo cerrar el home de ws-$login"
  done
}

# 0 si <unidad> arranco ANTES del ultimo cambio de alguno de los <archivos>
# (plantilla, entorno, VSIX...): corre con la configuracion vieja y hay que
# reiniciarla. Se mira la hora de arranque y no "que cambio en esta
# ejecucion": asi tambien se reinician los tuneles que systemd levanto con la
# plantilla vieja cuando otro (nuevo-tunel.sh, un arranque anterior) ya la
# habia cambiado. Si no se puede saber (nunca arranco, fecha rara), 1: no se
# reinicia a nadie por las dudas.
tunel_desactualizado() {
  local unidad=$1 inicio arranque archivo cambio
  shift
  # TZ=UTC: systemctl formatea la fecha en el cliente; asi `date -d` la entiende.
  inicio=$(TZ=UTC systemctl show -p ActiveEnterTimestamp --value "$unidad" 2>/dev/null) || return 1
  # Vacio: nunca arranco (y `date -d ""` daria la medianoche de hoy).
  [ -n "$inicio" ] || return 1
  arranque=$(TZ=UTC date -d "$inicio" +%s 2>/dev/null) || return 1
  if ! [[ $arranque =~ ^[0-9]+$ ]] || [ "$arranque" -eq 0 ]; then
    return 1
  fi
  for archivo in "$@"; do
    cambio=$(stat -c %Y "$archivo" 2>/dev/null) || continue
    if [ "$cambio" -gt "$arranque" ]; then
      return 0
    fi
  done
  return 1
}

# Crea el entorno de /etc a quien aun no lo tiene. Va ANTES de cambiar la
# plantilla: con la plantilla nueva y sin ese archivo, su tunel no arrancaria.
migrar_entornos_tunel() {
  local login
  while IFS= read -r login <&3; do
    if [ -f "$DIR_ENTORNOS_TUNEL/ws-$login.env" ]; then
      continue
    fi
    if escribir_entorno_tunel "$login"; then
      echo "--- entorno del tunel de ws-$login movido a $DIR_ENTORNOS_TUNEL"
    else
      echo "--- AVISO: no se pudo crear el entorno del tunel de ws-$login"
    fi
  done 3< <(logins_con_tunel)
}

# Plantilla adaceen-tunnel@.service. Se reescribe siempre (es idempotente)
# para que un cambio aqui llegue a la VM con solo volver a correr el script;
# daemon-reload solo si cambio. Deja UNIDAD_TUNEL_CAMBIO=1 si cambio (los
# tuneles que ya corren la toman al reiniciarse).
instalar_unidad_tunel() {
  UNIDAD_TUNEL_CAMBIO=0
  migrar_entornos_tunel
  escribir_si_cambia "$UNIDAD_TUNEL" 644 <<'EOF' || return 1
[Unit]
Description=ADACEEN tunel de VS Code para %i
# adaceen-ws-metadata: solo root habla con el servidor de metadata. Corre
# antes que cualquier tunel en cada arranque (las reglas no persisten).
After=network-online.target adaceen-ws-metadata.service
Wants=network-online.target adaceen-ws-metadata.service

[Service]
User=%i
WorkingDirectory=/home/%i/proyecto
# Solo lo que usa el tunel: todo lo que llega aqui lo ve el estudiante en su
# terminal. Nada de /etc/adaceen-ws.env ni de secretos de la VM. Los dos
# archivos son de root (tunel-comun.sh).
EnvironmentFile=-/etc/adaceen-ws-tunel.env
EnvironmentFile=/etc/adaceen-tunnels/%i.env
# --install-extension: la extension queda instalada en el servidor antes de
# que el estudiante abra la pagina; el Marketplace es el real, no Open VSX.
# ADACEEN_EXT es el id del Marketplace o la ruta a un .vsix. $LANG_EXT_ARGS
# (sin llaves, a proposito: asi systemd lo parte por espacios) trae las
# extensiones del lenguaje que detecto detectar-lenguajes.sh.
ExecStart=/usr/local/bin/code tunnel --accept-server-license-terms --name ${TUNEL} --install-extension ${ADACEEN_EXT} $LANG_EXT_ARGS
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  UNIDAD_TUNEL_CAMBIO=$ESCRITURA_CAMBIO
  if [ "$UNIDAD_TUNEL_CAMBIO" = 1 ]; then
    systemctl daemon-reload
  fi
}
