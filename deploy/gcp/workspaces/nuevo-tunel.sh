#!/usr/bin/env bash
# Prepara el entorno de UN estudiante en esta VM y deja su tunel corriendo.
#
#   nuevo-tunel.sh <login-github> <url-repo> [carpeta]
#
# Cada repositorio va en su propia carpeta del home (0.7.20): ~/<carpeta>, que
# elige el agente (el nombre del repo; sin argumento, ~/proyecto como antes).
# El mismo tunel sirve todas las carpetas: el segundo repositorio no pide otro
# codigo de dispositivo y abre en https://vscode.dev/tunnel/<nombre>/home/ws-<login>/<carpeta>.
#
# Que hace:
#   1. usuario Linux ws-<login> (home 0700: aislado de los demas estudiantes) y, si el
#      agente la manda en ADACEEN_EDITOR_SESSION_FILE (archivo temporal de
#      root, 0600), la sesion del editor en ~/.adaceen/editor-session.json
#      (contrato 2.3 de docs/arquitectura/acceso-simplificado.md)
#   2. clona el repo en ~/<carpeta> (solo repositorios publicos: clon https sin
#      credenciales) y pone su identidad de git si no tenia una; detecta los
#      lenguajes de todos sus repos (detectar-lenguajes.sh) para instalar solo
#      las extensiones que aplican: cualquier repo publico de GitHub
#   3. ajustes de maquina del servidor de VS Code apuntando al backend
#   4. login del tunel:
#        a) con TOKEN_PRUEBA_TUNEL (solo el spike manual) lo intenta (esperamos
#           401: Dev Tunnels solo acepta tokens emitidos por la app OAuth de VS
#           Code, no los de PDC; se prueba igual para dejarlo documentado)
#        b) sin sesion, el codigo de dispositivo lo pide el servicio del paso 5
#           y queda en su journal, de donde lo lee el agente: el script termina
#           en segundos y la espera sobrevive a un reinicio del agente. Con
#           LOGIN_EN_SCRIPT=1 el script pide el codigo el mismo (spike manual).
#   5. servicio systemd adaceen-tunnel@ws-<login> con la extension ADACEEN
#      preinstalada (plantilla y entorno: tunel-comun.sh). Si ya corria y solo
#      cambiaron las extensiones de lenguaje (un repo de otro lenguaje), no se
#      reinicia mientras el estudiante tenga un editor abierto: se instalan en
#      ese servidor (instalar_extensiones_en_servidor).
#
# Solo root. Nunca escribe la clave del worker en disco del estudiante, y lo
# que va al home del estudiante lo escribe COMO el estudiante (sudo -u): un
# enlace simbolico que haya plantado ahi no le da nada que no tenga ya.
set -euo pipefail

LOGIN=${1:?login de github}
REPO=${2:?url del repo}
CARPETA=${3:-proyecto}
TOKEN=${TOKEN_PRUEBA_TUNEL:-}

LOGIN=$(echo "$LOGIN" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')
if [ -z "$LOGIN" ] || [ ${#LOGIN} -gt 28 ]; then
  echo "login invalido: se espera el usuario de GitHub (ej. eydersantiago), no el correo"; exit 1
fi
# La carpeta del repo: sin barras, sin empezar por punto o guion, sin el
# sufijo de los respaldos (la misma regla que normalizarCarpeta en parse.mjs).
if ! [[ $CARPETA =~ ^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$ ]] || [[ $CARPETA =~ \.bak-[0-9] ]]; then
  echo "carpeta invalida para el repo: $CARPETA"; exit 1
fi
# Solo https://github.com/<dueno>/<nombre>(.git): nada de opciones de git
# (--upload-pack, ext::, file://...). El agente ya la manda asi.
REPO=${REPO%/}
case "$REPO" in *.git) ;; *) REPO="$REPO.git" ;; esac
if ! [[ $REPO =~ ^https://github\.com/[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+\.git$ ]]; then
  echo "url del repo invalida: se espera https://github.com/<dueno>/<nombre>.git"; exit 1
fi
USUARIO="ws-$LOGIN"
HOMEDIR="/home/$USUARIO"
DESTINO="$HOMEDIR/$CARPETA"
source /etc/adaceen-ws.env
# shellcheck source=tunel-comun.sh
source "$(dirname "${BASH_SOURCE[0]}")/tunel-comun.sh"
TUNEL=$(nombre_tunel "$LOGIN")
# Lo que corre como el estudiante (git, code) hereda este directorio: tiene que
# poder entrar (git falla con "failed to stat" en una carpeta de root 0700).
cd /

como() { sudo -u "$USUARIO" -H env HOME="$HOMEDIR" "$@"; }

# Escribe stdin en ~/<ruta> COMO el estudiante: carpetas 0700, archivo con el
# modo pedido, temporal + rename.
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

# 1. usuario
if ! id "$USUARIO" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$USUARIO"
fi
# useradd de Debian 12 deja el home 0755: los demas ws-* leerian su proyecto.
# Tambien para los usuarios de antes (idempotente).
cerrar_home_estudiante "$LOGIN"
# Versiones anteriores creaban ~/.adaceen como root: se le devuelve al
# estudiante (-h: si fuera un enlace, cambia el enlace y no su destino).
if [ -e "$HOMEDIR/.adaceen" ] || [ -L "$HOMEDIR/.adaceen" ]; then
  chown -h "$USUARIO:$USUARIO" "$HOMEDIR/.adaceen"
fi

# Sesion del editor, antes del clon: si el clon falla, VS Code queda
# vinculado igual. El agente la vuelve a escribir al terminar el script.
if [ -n "${ADACEEN_EDITOR_SESSION_FILE:-}" ]; then
  if [ -f "$ADACEEN_EDITOR_SESSION_FILE" ] \
     && escribir_en_home .adaceen/editor-session.json 600 < "$ADACEEN_EDITOR_SESSION_FILE"; then
    echo "--- sesion del editor en ~/.adaceen/editor-session.json"
  else
    echo "--- AVISO: no se pudo escribir la sesion del editor (el agente lo reintenta al terminar)"
  fi
fi

# 2. repo
# Solo repositorios publicos: clon https sin credenciales, como el estudiante
# (GIT_TERMINAL_PROMPT=0: un privado falla enseguida en vez de pedir usuario).
# Para hacer push, VS Code usa la cuenta de GitHub con la que se abrio vscode.dev.
clonar() {
  echo "--- clonando $REPO en ~/$CARPETA"
  GIT_TERMINAL_PROMPT=0 runuser -u "$USUARIO" -- env HOME="$HOMEDIR" git clone "$REPO" "$DESTINO"
}
if [ ! -d "$DESTINO/.git" ]; then
  clonar
fi

# Identidad de git para poder hacer commit desde el editor (sin ella, el
# primer commit falla con "Please tell me who you are"). Solo si el usuario no
# puso una: su login y el correo noreply de GitHub. Con el id numerico de la
# cuenta (ADACEEN_GITHUB_ID, lo manda PDC; es publico) es ID+login, el formato
# de las cuentas creadas desde 2017, que GitHub asocia al perfil.
ID_GITHUB=${ADACEEN_GITHUB_ID:-}
[[ $ID_GITHUB =~ ^[0-9]{1,15}$ ]] || ID_GITHUB=""
CORREO_GIT="$LOGIN@users.noreply.github.com"
[ -z "$ID_GITHUB" ] || CORREO_GIT="$ID_GITHUB+$LOGIN@users.noreply.github.com"
if ! como git config --global user.email >/dev/null 2>&1; then
  como git config --global user.name "$LOGIN"
  como git config --global user.email "$CORREO_GIT"
  echo "--- identidad de git: $LOGIN <$CORREO_GIT>"
fi

# 3. ajustes de maquina: aqui NO va la clave, solo la URL
escribir_en_home .vscode-server/data/Machine/settings.json 644 <<EOF
{
  "adaceen.backend.baseUrl": "$ADACEEN_API_URL",
  "adaceen.backend.autoWorkerEnabled": true,
  "adaceen.backend.workerPollMs": 8000,
  "java.configuration.updateBuildConfiguration": "automatic",
  "python.defaultInterpreterPath": "/usr/bin/python3"
}
EOF

# 4. login del tunel
# `code tunnel user show` imprime "logged in with provider github" (salida 0)
# o "not logged in" (salida 1). Un grep -i "logged in" casa con las dos (era el
# fallo que hacia saltar el login por accidente); aqui se mira el codigo de
# salida y el texto completo, sin tuberias.
sesion_iniciada() {
  local salida
  salida=$(como code tunnel user show 2>/dev/null) || return 1
  salida=${salida,,}
  [[ "$salida" == *"logged in"* && "$salida" != *"not logged in"* ]]
}

if sesion_iniciada; then
  echo "--- ya habia sesion de tunel para $USUARIO"
else
  if [ -n "$TOKEN" ]; then
    echo "--- probando login con token entregado (se espera 401)"
    if como code tunnel user login --provider github --access-token "$TOKEN" && sesion_iniciada; then
      echo "    RESULTADO: el token SI sirvio. Anotar en docs/workspaces-tunnel.md."
    else
      echo "    RESULTADO: el token NO sirvio (esperado). Sigue el codigo de dispositivo."
    fi
  fi
  if ! sesion_iniciada; then
    if [ "${LOGIN_EN_SCRIPT:-0}" = "1" ]; then
      echo "--- login por codigo de dispositivo. Esto es lo que veria el estudiante:"
      echo
      # El CLI imprime algo como:
      #   To grant access to the server, please log into https://github.com/login/device
      #   and use code XXXX-XXXX
      como code tunnel user login --provider github
      echo
    else
      echo "--- sin sesion de tunel: el servicio adaceen-tunnel@$USUARIO pide el codigo de dispositivo (queda en su journal)"
    fi
  fi
fi

# 5. servicio persistente
# Plantilla de la unidad y entorno del tunel en /etc/adaceen-tunnels (de
# root): nombre, extension ADACEEN (el VSIX de /opt/adaceen si esta; si no, la
# del Marketplace) y extensiones por lenguaje del repo.
instalar_unidad_tunel
escribir_entorno_tunel "$LOGIN"
echo "--- extensiones por lenguaje:${EXT_LENGUAJE_TUNEL:- (ninguna, repo sin lenguaje reconocido)}"

UNIDAD="adaceen-tunnel@$USUARIO.service"
systemctl enable "$UNIDAD"
# Ya corriendo con otra plantilla u otro VSIX (cambiados ahora o despues de que
# arranco): se reinicia para tomarlos. Si solo cambio su entorno (las
# extensiones de lenguaje, por un repo nuevo) y el estudiante tiene un editor
# abierto, no se le corta: las extensiones van a ese servidor y el entorno
# nuevo se toma en el proximo arranque del tunel.
ACCION=nada
if ! systemctl is-active --quiet "$UNIDAD"; then
  ACCION=start
elif [ "$UNIDAD_TUNEL_CAMBIO" = 1 ] \
     || tunel_desactualizado "$UNIDAD" "$UNIDAD_TUNEL" /etc/adaceen-ws-tunel.env "$ADACEEN_VSIX"; then
  ACCION=restart
elif [ "$ENTORNO_TUNEL_CAMBIO" = 1 ] || tunel_desactualizado "$UNIDAD" "$DIR_ENTORNOS_TUNEL/$USUARIO.env"; then
  if ! sesion_iniciada; then
    # Esperando que autorice el codigo de dispositivo: reiniciar el tunel
    # invalidaria el codigo que ya ve. Las extensiones nuevas entran en el
    # proximo arranque del tunel.
    echo "--- $USUARIO aun no autoriza el codigo: no se reinicia el tunel"
  elif servidor_vscode_activo "$USUARIO"; then
    # Editor abierto: no se le corta. Las extensiones que falten se instalan en
    # ese servidor en segundo plano (el script termina ya y el repo abre).
    echo "--- $USUARIO tiene un editor abierto: no se reinicia el tunel"
    # shellcheck disable=SC2086  # "--install-extension <id> ..." se parte a proposito
    instalar_extensiones_en_segundo_plano "$USUARIO" $EXT_LENGUAJE_TUNEL
  else
    ACCION=restart
  fi
fi
case "$ACCION" in
  start|restart)
    systemctl "$ACCION" "$UNIDAD"
    sleep 8
    systemctl --no-pager --lines=8 status "$UNIDAD" || true
    ;;
  *) echo "--- tunel de $USUARIO ya corriendo: sin reiniciar" ;;
esac

cat <<EOF

=== tunel listo para $LOGIN ===
  abrir:    https://vscode.dev/tunnel/$TUNEL/home/$USUARIO/$CARPETA
  (con la MISMA cuenta de GitHub que autorizo el codigo)

  log:      journalctl -u adaceen-tunnel@$USUARIO -f
  parar:    systemctl stop adaceen-tunnel@$USUARIO
  quitar:   systemctl disable --now adaceen-tunnel@$USUARIO && userdel -r $USUARIO \\
              && rm -f /etc/adaceen-tunnels/$USUARIO.env
EOF
