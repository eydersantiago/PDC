#!/usr/bin/env bash
# Prepara el entorno de UN estudiante en esta VM y deja su tunel corriendo.
#
#   nuevo-tunel.sh <login-github> <url-repo> [token-acceso-opcional]
#
# Que hace:
#   1. usuario Linux ws-<login> (home 0700: aislado de los demas estudiantes) y, si el
#      agente la manda en ADACEEN_EDITOR_SESSION_FILE (archivo temporal de
#      root, 0600), la sesion del editor en ~/.adaceen/editor-session.json
#      (contrato 2.3 de docs/arquitectura/acceso-simplificado.md)
#   2. clona el repo del estudiante en ~/proyecto y detecta sus lenguajes
#      (detectar-lenguajes.sh) para instalar solo las extensiones que aplican:
#      sirve para cualquier repo de GitHub, no solo Java
#   3. ajustes de maquina del servidor de VS Code apuntando al backend
#   4. login del tunel:
#        a) si llega un token, lo intenta (esperamos 401: Dev Tunnels solo
#           acepta tokens emitidos por la app OAuth de VS Code, no los de PDC;
#           se prueba igual para dejarlo documentado con evidencia)
#        b) sin sesion, el codigo de dispositivo lo pide el servicio del paso 5
#           y queda en su journal, de donde lo lee el agente: el script termina
#           en segundos y la espera sobrevive a un reinicio del agente. Con
#           LOGIN_EN_SCRIPT=1 el script pide el codigo el mismo (spike manual).
#   5. servicio systemd adaceen-tunnel@ws-<login> con la extension ADACEEN
#      preinstalada (plantilla y entorno: tunel-comun.sh); la URL final es
#      https://vscode.dev/tunnel/<nombre>
#
# Solo root. Nunca escribe la clave del worker en disco del estudiante, y lo
# que va al home del estudiante lo escribe COMO el estudiante (sudo -u): un
# enlace simbolico que haya plantado ahi no le da nada que no tenga ya.
set -euo pipefail

LOGIN=${1:?login de github}
REPO=${2:?url del repo}
TOKEN=${3:-}

LOGIN=$(echo "$LOGIN" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')
if [ -z "$LOGIN" ] || [ ${#LOGIN} -gt 28 ]; then
  echo "login invalido: se espera el usuario de GitHub (ej. eydersantiago), no el correo"; exit 1
fi
USUARIO="ws-$LOGIN"
HOMEDIR="/home/$USUARIO"
source /etc/adaceen-ws.env
# shellcheck source=tunel-comun.sh
source "$(dirname "${BASH_SOURCE[0]}")/tunel-comun.sh"
TUNEL=$(nombre_tunel "$LOGIN")

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
if [ ! -d "$HOMEDIR/proyecto/.git" ]; then
  sudo -u "$USUARIO" git clone "$REPO" "$HOMEDIR/proyecto"
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
# Ya corriendo con otra plantilla, otro entorno u otro VSIX (cambiados ahora o
# despues de que arranco): se reinicia para tomarlos.
if systemctl is-active --quiet "$UNIDAD" \
   && { [ "$UNIDAD_TUNEL_CAMBIO$ENTORNO_TUNEL_CAMBIO" != 00 ] \
        || tunel_desactualizado "$UNIDAD" "$UNIDAD_TUNEL" "$DIR_ENTORNOS_TUNEL/$USUARIO.env" \
             /etc/adaceen-ws-tunel.env "$ADACEEN_VSIX"; }; then
  systemctl restart "$UNIDAD"
else
  systemctl start "$UNIDAD"
fi
sleep 8
systemctl --no-pager --lines=8 status "adaceen-tunnel@$USUARIO.service" || true

cat <<EOF

=== tunel listo para $LOGIN ===
  abrir:    https://vscode.dev/tunnel/$TUNEL/home/$USUARIO/proyecto
  (con la MISMA cuenta de GitHub que autorizo el codigo)

  log:      journalctl -u adaceen-tunnel@$USUARIO -f
  parar:    systemctl stop adaceen-tunnel@$USUARIO
  quitar:   systemctl disable --now adaceen-tunnel@$USUARIO && userdel -r $USUARIO \\
              && rm -f /etc/adaceen-tunnels/$USUARIO.env
EOF
