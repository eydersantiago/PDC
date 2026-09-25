#!/usr/bin/env bash
# Startup script de la VM de entornos (VS Code Tunnels). Idempotente: corre en
# cada arranque, pero solo instala lo que falte.
#
# Deja la VM lista para que un tunel por estudiante arranque en segundos:
#   - CLI de VS Code en /usr/local/bin/code
#   - herramientas comunes para cualquier repo de GitHub del piloto:
#     git, JDK 17 + Ant + Maven, Python 3 + pip + venv, Node 18 + npm,
#     gcc/g++/make. Las extensiones de VS Code se eligen por repo
#     (detectar-lenguajes.sh); aqui solo van los compiladores/interpretes.
#   - solo root puede hablar con el servidor de metadata (los estudiantes
#     tienen terminal en esta VM y ahi viven los secretos): unidad
#     adaceen-ws-metadata, que en cada arranque corre ANTES que los tuneles
#   - /opt/adaceen/ con los scripts de esta carpeta
#   - /opt/adaceen/adaceen.vsix: el VSIX de la version que fija el submodulo
#     vscode-ext-prod en la rama clonada (instalar-vsix.sh); si no se puede
#     bajar, queda el anterior
#   - timer de apagado por inactividad
#   - agente HTTP de entornos (agente/, fase 2) si la metadata trae
#     workspace-agent-token
#   - tuneles ya preparados: plantilla y entorno al dia (tunel-comun.sh) y
#     reinicio de los que cambiaron (p. ej. con un VSIX nuevo)
#
# Metadata que lee (todas opcionales salvo donde se dice):
#   api-url, repo-url, branch
#   idle-minutes           minutos sin nadie conectado antes de apagar la VM
#                          (defecto 120; 0 = no apagar)
#   scan-worker-key        solo si PDC exige ADACEEN_SCAN_WORKER_KEY: esa misma
#                          clave, que se pasa al tunel (el estudiante la ve en
#                          su terminal: nunca pongas aqui WORKER_SHARED_SECRET)
#   workspace-agent-token  secreto compartido con PDC (WORKSPACE_AGENT_TOKEN);
#                          sin el, el agente no arranca
#   workspace-agent-host   IPs donde escucha el agente, separadas por comas
#                          (defecto: 127.0.0.1 y la IP interna de la VM)
#   workspace-agent-port   defecto 8787
#   workspace-agent-relay  "off" apaga el relay (A15.3); por defecto el agente
#                          recoge las peticiones de PDC en
#                          <api-url>/api/workspaces/agent (la VM no tiene IP
#                          publica y Azure no le puede abrir conexiones)
# worker-secret ya no se usa: era WORKER_SHARED_SECRET (el del worker de GPU)
# y terminaba en el entorno de la terminal de cada estudiante.
set -euo pipefail
exec > >(tee -a /var/log/adaceen-ws-startup.log) 2>&1
echo "=== adaceen-ws startup $(date -Is) ==="

meta() {
  curl -sf -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" || true
}

# Huella de un archivo (vacia si no existe): para saber si algo cambio.
huella() {
  sha256sum "$1" 2>/dev/null | cut -d' ' -f1 || true
}

API_URL_DEFECTO=https://app-adaceen-api-eyder05232002.azurewebsites.net
API_URL=$(meta api-url);           API_URL=${API_URL:-$API_URL_DEFECTO}
# nuevo-tunel.sh carga /etc/adaceen-ws.env con `source` (como root): solo una URL simple.
if ! [[ $API_URL =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$ ]]; then
  echo "--- AVISO: la metadata api-url no es una URL valida; se usa $API_URL_DEFECTO"
  API_URL=$API_URL_DEFECTO
fi
SCAN_WORKER_KEY=$(meta scan-worker-key)
IDLE_MINUTES=$(meta idle-minutes); IDLE_MINUTES=${IDLE_MINUTES:-120}
if ! [[ $IDLE_MINUTES =~ ^[0-9]{1,5}$ ]]; then
  echo "--- AVISO: la metadata idle-minutes no es un numero; se usan 120 min"
  IDLE_MINUTES=120
fi
IDLE_MINUTES=$((10#$IDLE_MINUTES))
REPO_URL=$(meta repo-url);         REPO_URL=${REPO_URL:-https://github.com/eydersantiago/PDC.git}
# Rama de despliegue de PDC: trae los scripts y el agente de entornos.
BRANCH=$(meta branch);             BRANCH=${BRANCH:-feature/azure-config-observability}
ADACEEN_VSIX=/opt/adaceen/adaceen.vsix

export DEBIAN_FRONTEND=noninteractive

# --- paquetes base (una vez) ---
# Marca de version: si cambia esta lista, sube el numero y el startup vuelve
# a instalar en la proxima arrancada.
BASE_VERSION=3
if [ "$(cat /opt/adaceen/.base-version 2>/dev/null)" != "$BASE_VERSION" ]; then
  echo "--- instalando herramientas base (java, python, node, c/c++)"
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends \
    git curl ca-certificates jq unzip iptables \
    openjdk-17-jdk-headless ant maven \
    python3 python3-pip python3-venv \
    nodejs npm \
    build-essential gdb
  mkdir -p /opt/adaceen && echo "$BASE_VERSION" > /opt/adaceen/.base-version
fi

# --- solo root habla con el servidor de metadata ---
# Los estudiantes tienen terminal en esta VM (usuarios ws-*). En la metadata
# estan el token del agente y el token de la cuenta de servicio de la VM. Se
# bloquea el HTTP (80/443) hacia 169.254.169.254 para todo lo que no sea root;
# el DNS (puerto 53 de la misma IP) sigue abierto.
# Las reglas no persisten, por eso van en una unidad: en cada arranque systemd
# la corre ANTES que los tuneles (adaceen-tunnel@ la pide con Wants/After),
# aunque este script falle o tarde. Aqui ademas se aplica ya (primera vez).
cat > /usr/local/sbin/adaceen-ws-bloquear-metadata <<'EOF'
#!/usr/bin/env bash
# Generado por startup-ws.sh (unidad adaceen-ws-metadata). Rechaza el HTTP
# hacia el servidor de metadata para todo lo que no sea root. Idempotente.
if ! command -v iptables >/dev/null 2>&1; then
  echo "AVISO: sin iptables; los usuarios ws-* pueden leer la metadata (y el token del agente)" >&2
  exit 1
fi
fallo=0
for puerto in 80 443; do
  if ! iptables -C OUTPUT -d 169.254.169.254 -p tcp --dport "$puerto" \
       -m owner ! --uid-owner 0 -j REJECT 2>/dev/null; then
    if ! iptables -I OUTPUT -d 169.254.169.254 -p tcp --dport "$puerto" \
         -m owner ! --uid-owner 0 -j REJECT; then
      echo "AVISO: no se pudo bloquear la metadata (puerto $puerto) para usuarios no root" >&2
      fallo=1
    fi
  fi
done
exit "$fallo"
EOF
chmod 755 /usr/local/sbin/adaceen-ws-bloquear-metadata
cat > /etc/systemd/system/adaceen-ws-metadata.service <<'EOF'
[Unit]
Description=ADACEEN ws: solo root habla con el servidor de metadata
# adaceen-tunnel@ arranca despues (After/Wants en su plantilla).

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/adaceen-ws-bloquear-metadata

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable adaceen-ws-metadata.service
if ! systemctl restart adaceen-ws-metadata.service; then
  echo "--- AVISO: no se pudo bloquear la metadata para los usuarios ws-* (journalctl -u adaceen-ws-metadata)"
fi

# --- CLI de VS Code (una vez; es un binario estatico de ~10 MB) ---
if ! command -v code >/dev/null 2>&1; then
  echo "--- instalando CLI de VS Code"
  curl -fsSL 'https://code.visualstudio.com/sha/download?build=stable&os=cli-alpine-x64' \
    -o /tmp/vscode_cli.tar.gz
  tar -xf /tmp/vscode_cli.tar.gz -C /usr/local/bin
  chmod +x /usr/local/bin/code
fi
echo "--- code CLI: $(code --version | head -n 1)"

# --- scripts de esta carpeta, desde el repo ---
mkdir -p /opt/adaceen
# El clon es --depth 1 de UNA rama: si la metadata "branch" cambio, se clona
# de nuevo (es copia de solo lectura, no hay nada que conservar).
RAMA_ACTUAL=$(git -C /opt/adaceen/repo rev-parse --abbrev-ref HEAD 2>/dev/null || true)
if [ -d /opt/adaceen/repo ] && [ "$RAMA_ACTUAL" != "$BRANCH" ]; then
  echo "--- cambio de rama: ${RAMA_ACTUAL:-?} -> $BRANCH"
  rm -rf /opt/adaceen/repo
fi
if [ ! -d /opt/adaceen/repo ]; then
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" /opt/adaceen/repo
# fetch + reset y no pull --ff-only: si la rama se reescribia (push forzado),
# el pull fallaba en silencio y la VM se quedaba para siempre con lo viejo.
elif git -C /opt/adaceen/repo fetch -q --depth 1 origin "$BRANCH"; then
  git -C /opt/adaceen/repo reset -q --hard FETCH_HEAD
else
  echo "--- AVISO: no se pudo actualizar /opt/adaceen/repo; se usan los scripts que ya estaban"
fi
echo "--- PDC $BRANCH @ $(git -C /opt/adaceen/repo rev-parse --short HEAD 2>/dev/null || echo '?')"
cp /opt/adaceen/repo/deploy/gcp/workspaces/*.sh /opt/adaceen/
chmod +x /opt/adaceen/*.sh
# Plantilla y entorno de los tuneles, compartidos con nuevo-tunel.sh. Una
# rama anterior a este cambio no lo trae: entonces se hace como antes.
TUNEL_COMUN=0
if [ -f /opt/adaceen/tunel-comun.sh ]; then
  # shellcheck source=tunel-comun.sh
  source /opt/adaceen/tunel-comun.sh
  TUNEL_COMUN=1
fi

# --- configuracion comun a todos los tuneles ---
# /etc/adaceen-ws.env (solo root) lo carga nuevo-tunel.sh para los ajustes de
# maquina; ya NO llega al entorno de los tuneles.
( umask 077; printf 'ADACEEN_API_URL=%s\n' "$API_URL" > /etc/adaceen-ws.env )
chmod 600 /etc/adaceen-ws.env
# Lo unico comun que si llega al tunel (y por tanto a la terminal del
# estudiante): la clave del worker de escaneo, y solo si PDC la exige.
# Se reescribe solo si cambia: su fecha decide que tuneles se reinician
# (tunel_desactualizado). printf es interno de bash: la clave no sale en ps.
COMUN_ANTES=$(huella /etc/adaceen-ws-tunel.env)
if [ -n "$SCAN_WORKER_KEY" ] && [[ $SCAN_WORKER_KEY =~ ^[A-Za-z0-9._~+/=-]{1,200}$ ]]; then
  COMUN_NUEVO=$(printf 'ADACEEN_SCAN_WORKER_KEY=%s\n' "$SCAN_WORKER_KEY" | sha256sum | cut -d' ' -f1)
  if [ "$COMUN_NUEVO" != "$COMUN_ANTES" ]; then
    ( umask 077; printf 'ADACEEN_SCAN_WORKER_KEY=%s\n' "$SCAN_WORKER_KEY" > /etc/adaceen-ws-tunel.env )
  fi
else
  if [ -n "$SCAN_WORKER_KEY" ]; then
    echo "--- AVISO: scan-worker-key tiene caracteres no admitidos; no se pasa al tunel"
  fi
  rm -f /etc/adaceen-ws-tunel.env
fi
COMUN_CAMBIO=0
[ "$(huella /etc/adaceen-ws-tunel.env)" = "$COMUN_ANTES" ] || COMUN_CAMBIO=1

# --- VSIX de la extension (la version que fija el submodulo vscode-ext-prod) ---
# Si no se puede bajar, instalar-vsix.sh deja el anterior y explica por que.
# Si el commit no trae el VSIX (*.vsix esta en el .gitignore del submodulo),
# prueba el que sirve PDC en /descargas/adaceen.vsix, si es la misma version.
VSIX_ANTES=$(huella "$ADACEEN_VSIX")
if [ ! -f /opt/adaceen/instalar-vsix.sh ]; then
  echo "--- AVISO: la rama $BRANCH no trae instalar-vsix.sh; el VSIX queda como estaba"
elif ! bash /opt/adaceen/instalar-vsix.sh /opt/adaceen/repo "$ADACEEN_VSIX" "$API_URL"; then
  echo "--- AVISO: VSIX sin actualizar; los tuneles siguen con el que habia"
fi
VSIX_CAMBIO=0
[ "$(huella "$ADACEEN_VSIX")" = "$VSIX_ANTES" ] || VSIX_CAMBIO=1

# --- apagado por inactividad ---
# Los servicios adaceen-tunnel@ estan siempre vivos, asi que "hay un proceso
# code tunnel" no dice nada. Lo que delata a un estudiante conectado es el
# servidor de VS Code que el CLI descarga y lanza al abrirse la pagina
# (~/.vscode/cli/servers/<version>/server/...), que se cierra solo unos
# minutos despues de que el estudiante cierra la pestana. Sin ninguno de
# esos durante IDLE_MINUTES, la VM se apaga.
cat > /usr/local/bin/adaceen-ws-idle-check <<'IDLEEOF'
#!/usr/bin/env bash
# Generado por startup-ws.sh:  adaceen-ws-idle-check <minutos>
MINUTOS=${1:-120}
STAMP=/var/run/adaceen-ws-last-active
if pgrep -f 'cli/servers/[^/]*/server' >/dev/null 2>&1; then
  date +%s > "$STAMP"; exit 0
fi
[ -f "$STAMP" ] || date +%s > "$STAMP"
LAST=$(cat "$STAMP"); NOW=$(date +%s)
if [ $(( (NOW - LAST) / 60 )) -ge "$MINUTOS" ]; then
  echo "sin tuneles desde hace $MINUTOS min, apagando" >> /var/log/adaceen-ws-startup.log
  /sbin/shutdown -h now
fi
IDLEEOF
chmod +x /usr/local/bin/adaceen-ws-idle-check

cat > /etc/systemd/system/adaceen-ws-idle.service <<EOF
[Unit]
Description=ADACEEN ws: apagar si no hay tuneles
[Service]
Type=oneshot
ExecStart=/usr/local/bin/adaceen-ws-idle-check $IDLE_MINUTES
EOF
cat > /etc/systemd/system/adaceen-ws-idle.timer <<'EOF'
[Unit]
Description=ADACEEN ws: revisar inactividad cada 5 min
[Timer]
OnBootSec=10min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
if [ "$IDLE_MINUTES" -gt 0 ]; then
  systemctl enable --now adaceen-ws-idle.timer
else
  echo "--- idle-minutes=0: la VM no se apaga sola"
  systemctl disable --now adaceen-ws-idle.timer 2>/dev/null || true
fi

# --- agente HTTP de entornos (fase 2 de docs/workspaces-tunnel.md) ---
# PDC le pide "prepara el editor de <login> con <repo>"; el agente corre
# nuevo-tunel.sh y devuelve el codigo de dispositivo o "ready". El secreto
# compartido llega por la metadata workspace-agent-token y termina en un
# archivo que solo lee root. Sin token, el agente queda apagado.
AGENT_TOKEN=$(meta workspace-agent-token)
AGENT_PORT=$(meta workspace-agent-port); AGENT_PORT=${AGENT_PORT:-8787}
AGENT_HOST=$(meta workspace-agent-host)
if [ -z "$AGENT_HOST" ]; then
  IP_INTERNA=$(curl -sf -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/ip" || true)
  AGENT_HOST="127.0.0.1${IP_INTERNA:+,$IP_INTERNA}"
fi
AGENTE_SRC=/opt/adaceen/repo/deploy/gcp/workspaces/agente
if [ ! -f "$AGENTE_SRC/agente-workspaces.mjs" ]; then
  echo "--- AVISO: la rama $BRANCH no trae deploy/gcp/workspaces/agente; agente sin instalar"
elif ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' 2>/dev/null; then
  echo "--- AVISO: el agente necesita Node 18 o superior; agente sin instalar"
else
  mkdir -p /opt/adaceen/agente
  cp "$AGENTE_SRC/agente-workspaces.mjs" "$AGENTE_SRC/parse.mjs" /opt/adaceen/agente/
  # relay.mjs llega con A15.3: una rama anterior no lo trae (y su agente no lo usa).
  if [ -f "$AGENTE_SRC/relay.mjs" ]; then cp "$AGENTE_SRC/relay.mjs" /opt/adaceen/agente/; fi
  install -m 644 "$AGENTE_SRC/adaceen-workspaces-agent.service" \
    /etc/systemd/system/adaceen-workspaces-agent.service
  systemctl daemon-reload
  # A15.3: el agente le pregunta a PDC por HTTPS de salida (Cloud NAT).
  AGENT_RELAY_URL=""
  if [ "$(meta workspace-agent-relay)" != "off" ]; then
    AGENT_RELAY_URL="${API_URL%/}/api/workspaces/agent"
  fi
  if [ -n "$AGENT_TOKEN" ]; then
    # umask en subshell: el archivo nace 600, sin ventana en que otro lo lea.
    (
      umask 077
      cat > /etc/adaceen-workspaces-agent.env <<EOF
AGENT_TOKEN=$AGENT_TOKEN
AGENT_HOST=$AGENT_HOST
AGENT_PORT=$AGENT_PORT
AGENT_SCRIPT=/opt/adaceen/nuevo-tunel.sh
AGENT_RELAY_URL=$AGENT_RELAY_URL
EOF
    )
    chmod 600 /etc/adaceen-workspaces-agent.env
    systemctl enable adaceen-workspaces-agent.service
    systemctl restart adaceen-workspaces-agent.service
    echo "--- agente de entornos en $AGENT_HOST (puerto $AGENT_PORT)${AGENT_RELAY_URL:+; relay $AGENT_RELAY_URL}"
  else
    echo "--- AVISO: sin metadata workspace-agent-token; agente de entornos apagado"
    systemctl disable --now adaceen-workspaces-agent.service 2>/dev/null || true
  fi
fi

# --- tuneles ya preparados: al dia y arriba tras un reinicio ---
# Van al final: el bloqueo de la metadata y el VSIX ya estan. systemd levanta
# solo los tuneles habilitados al arrancar (despues de adaceen-ws-metadata),
# pero con la plantilla, el entorno y el VSIX de ANTES de este script: se
# reinician los que cambiaron en esta ejecucion y los que arrancaron antes del
# ultimo cambio de su plantilla, entorno o VSIX (tunel_desactualizado: p. ej.
# si un nuevo-tunel.sh instalo la plantilla mientras corria el startup viejo).
# Al arrancar la VM todavia no hay nadie conectado. Los deshabilitados a mano
# no se tocan.
if [ "$TUNEL_COMUN" = 1 ]; then
  cerrar_homes_estudiantes
  instalar_unidad_tunel || echo "--- AVISO: no se pudo escribir la unidad adaceen-tunnel@"
  while IFS= read -r login <&3; do
    unidad="adaceen-tunnel@ws-$login.service"
    if ! escribir_entorno_tunel "$login"; then
      echo "--- AVISO: no se pudo escribir el entorno del tunel de ws-$login"
      continue
    fi
    if ! systemctl is-enabled --quiet "$unidad"; then
      echo "--- $unidad deshabilitado: no se arranca"
      continue
    fi
    accion=start
    if [ "$UNIDAD_TUNEL_CAMBIO$ENTORNO_TUNEL_CAMBIO$VSIX_CAMBIO$COMUN_CAMBIO" != 0000 ] \
       || tunel_desactualizado "$unidad" "$UNIDAD_TUNEL" "$DIR_ENTORNOS_TUNEL/ws-$login.env" \
            /etc/adaceen-ws-tunel.env "$ADACEEN_VSIX"; then
      accion=restart
    fi
    systemctl "$accion" "$unidad" || echo "--- AVISO: fallo systemctl $accion $unidad"
  done 3< <(logins_con_tunel)
else
  for d in /home/ws-*; do
    [ -d "$d" ] || continue
    u=$(basename "$d")
    if [ -f "$d/.adaceen/tunnel.env" ]; then
      systemctl start "adaceen-tunnel@$u.service" || true
    fi
  done
fi

VSIX_ACTUAL=marketplace
if [ -f "$ADACEEN_VSIX" ]; then VSIX_ACTUAL=$ADACEEN_VSIX; fi
echo "=== listo. api=$API_URL idle=${IDLE_MINUTES}min extension=$VSIX_ACTUAL ==="
