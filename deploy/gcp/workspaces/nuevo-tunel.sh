#!/usr/bin/env bash
# Prepara el entorno de UN estudiante en esta VM y deja su tunel corriendo.
#
#   nuevo-tunel.sh <login-github> <url-repo> [token-acceso-opcional]
#
# Que hace:
#   1. usuario Linux ws-<login> (aislado de los demas estudiantes)
#   2. clona el repo del estudiante en ~/proyecto
#   3. ajustes de maquina del servidor de VS Code apuntando al backend
#   4. login del tunel:
#        a) si llega un token, lo intenta (esperamos 401: Dev Tunnels solo
#           acepta tokens emitidos por la app OAuth de VS Code, no los de PDC;
#           se prueba igual para dejarlo documentado con evidencia)
#        b) si no, flujo de codigo de dispositivo: imprime la URL y el codigo,
#           y es lo que PDC le mostraria al estudiante en el overlay
#   5. servicio systemd adaceen-tunnel@ws-<login> con la extension ADACEEN
#      preinstalada; la URL final es https://vscode.dev/tunnel/<nombre>
#
# Solo root. Nunca escribe la clave del worker en disco del estudiante.
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
# Dev Tunnels limita el nombre a 20 caracteres. El nombre solo tiene que ser
# unico dentro de la cuenta del estudiante, asi que basta un prefijo corto.
TUNEL="ad-${LOGIN:0:17}"
source /etc/adaceen-ws.env

# 1. usuario
if ! id "$USUARIO" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$USUARIO"
fi
mkdir -p "$HOMEDIR/.adaceen"

# 2. repo
if [ ! -d "$HOMEDIR/proyecto/.git" ]; then
  sudo -u "$USUARIO" git clone "$REPO" "$HOMEDIR/proyecto"
fi

# 3. ajustes de maquina: aqui NO va la clave, solo la URL
mkdir -p "$HOMEDIR/.vscode-server/data/Machine"
cat > "$HOMEDIR/.vscode-server/data/Machine/settings.json" <<EOF
{
  "adaceen.backend.baseUrl": "$ADACEEN_API_URL",
  "adaceen.backend.autoWorkerEnabled": true,
  "adaceen.backend.workerPollMs": 8000,
  "java.configuration.updateBuildConfiguration": "automatic"
}
EOF
chown -R "$USUARIO:$USUARIO" "$HOMEDIR"

# 4. login del tunel
como() { sudo -u "$USUARIO" -H env HOME="$HOMEDIR" "$@"; }

if como code tunnel user show 2>/dev/null | grep -qi "logged in"; then
  echo "--- ya habia sesion de tunel para $USUARIO"
else
  if [ -n "$TOKEN" ]; then
    echo "--- probando login con token entregado (se espera 401)"
    if como code tunnel user login --provider github --access-token "$TOKEN" \
       && como code tunnel user show 2>/dev/null | grep -qi "logged in"; then
      echo "    RESULTADO: el token SI sirvio. Anotar en docs/workspaces-tunnel.md."
    else
      echo "    RESULTADO: el token NO sirvio (esperado). Sigue el codigo de dispositivo."
    fi
  fi
  if ! como code tunnel user show 2>/dev/null | grep -qi "logged in"; then
    echo "--- login por codigo de dispositivo. Esto es lo que veria el estudiante:"
    echo
    # El CLI imprime algo como:
    #   To grant access to the server, please log into https://github.com/login/device
    #   and use code XXXX-XXXX
    como code tunnel user login --provider github
    echo
  fi
fi

# 5. servicio persistente
cat > "$HOMEDIR/.adaceen/tunnel.env" <<EOF
TUNEL=$TUNEL
EOF
chown "$USUARIO:$USUARIO" "$HOMEDIR/.adaceen/tunnel.env"

if [ ! -f /etc/systemd/system/adaceen-tunnel@.service ]; then
  cat > /etc/systemd/system/adaceen-tunnel@.service <<'EOF'
[Unit]
Description=ADACEEN tunel de VS Code para %i
After=network-online.target
Wants=network-online.target

[Service]
User=%i
WorkingDirectory=/home/%i/proyecto
EnvironmentFile=/etc/adaceen-ws.env
EnvironmentFile=/home/%i/.adaceen/tunnel.env
# --install-extension: la extension queda instalada en el servidor antes de
# que el estudiante abra la pagina; el Marketplace es el real, no Open VSX.
ExecStart=/usr/local/bin/code tunnel --accept-server-license-terms --name ${TUNEL} --install-extension adaceen.adaceen --install-extension vscjava.vscode-java-pack
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
fi

systemctl enable --now "adaceen-tunnel@$USUARIO.service"
sleep 8
systemctl --no-pager --lines=8 status "adaceen-tunnel@$USUARIO.service" || true

cat <<EOF

=== tunel listo para $LOGIN ===
  abrir:    https://vscode.dev/tunnel/$TUNEL/home/$USUARIO/proyecto
  (con la MISMA cuenta de GitHub que autorizo el codigo)

  log:      journalctl -u adaceen-tunnel@$USUARIO -f
  parar:    systemctl stop adaceen-tunnel@$USUARIO
  quitar:   systemctl disable --now adaceen-tunnel@$USUARIO && userdel -r $USUARIO
EOF
