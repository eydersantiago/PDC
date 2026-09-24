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
#   - /opt/adaceen/ con los scripts de esta carpeta
#   - timer de apagado por inactividad
#   - agente HTTP de entornos (agente/, fase 2) si la metadata trae
#     workspace-agent-token
#   - solo root puede hablar con el servidor de metadata (los estudiantes
#     tienen terminal en esta VM y ahi viven los secretos)
#
# Metadata que lee (todas opcionales salvo donde se dice):
#   api-url, worker-secret, idle-minutes, repo-url, branch
#   workspace-agent-token  secreto compartido con PDC (WORKSPACE_AGENT_TOKEN);
#                          sin el, el agente no arranca
#   workspace-agent-host   IPs donde escucha el agente, separadas por comas
#                          (defecto: 127.0.0.1 y la IP interna de la VM)
#   workspace-agent-port   defecto 8787
set -euo pipefail
exec > >(tee -a /var/log/adaceen-ws-startup.log) 2>&1
echo "=== adaceen-ws startup $(date -Is) ==="

meta() {
  curl -sf -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" || true
}

API_URL=$(meta api-url);           API_URL=${API_URL:-https://app-adaceen-api-eyder05232002.azurewebsites.net}
WORKER_SECRET=$(meta worker-secret)
IDLE_MINUTES=$(meta idle-minutes); IDLE_MINUTES=${IDLE_MINUTES:-120}
REPO_URL=$(meta repo-url);         REPO_URL=${REPO_URL:-https://github.com/eydersantiago/PDC.git}
# Rama de despliegue de PDC: trae los scripts y el agente de entornos.
BRANCH=$(meta branch);             BRANCH=${BRANCH:-feature/azure-config-observability}

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
else
  git -C /opt/adaceen/repo pull --ff-only || true
fi
cp /opt/adaceen/repo/deploy/gcp/workspaces/*.sh /opt/adaceen/
chmod +x /opt/adaceen/*.sh

# --- solo root habla con el servidor de metadata ---
# Los estudiantes tienen terminal en esta VM (usuarios ws-*). En la metadata
# estan el token del agente, la clave del worker y el token de la cuenta de
# servicio de la VM. Se bloquea el HTTP (80/443) hacia 169.254.169.254 para
# todo lo que no sea root; el DNS (puerto 53 de la misma IP) sigue abierto.
# Las reglas no persisten: este script las vuelve a poner en cada arranque.
if command -v iptables >/dev/null 2>&1; then
  for puerto in 80 443; do
    if ! iptables -C OUTPUT -d 169.254.169.254 -p tcp --dport "$puerto" \
         -m owner ! --uid-owner 0 -j REJECT 2>/dev/null; then
      iptables -I OUTPUT -d 169.254.169.254 -p tcp --dport "$puerto" \
        -m owner ! --uid-owner 0 -j REJECT \
        || echo "--- AVISO: no se pudo bloquear la metadata (puerto $puerto) para usuarios no root"
    fi
  done
else
  echo "--- AVISO: sin iptables; los usuarios ws-* pueden leer la metadata (y el token del agente)"
fi

# --- configuracion comun a todos los tuneles ---
# La clave NO se escribe en ningun settings.json: va como variable de entorno
# del proceso del tunel, que es de donde la lee la extension
# (ADACEEN_SCAN_WORKER_KEY). Este archivo solo lo lee root.
cat > /etc/adaceen-ws.env <<EOF
ADACEEN_API_URL=$API_URL
ADACEEN_SCAN_WORKER_KEY=$WORKER_SECRET
EOF
chmod 600 /etc/adaceen-ws.env

# --- apagado por inactividad ---
# Los servicios adaceen-tunnel@ estan siempre vivos, asi que "hay un proceso
# code tunnel" no dice nada. Lo que delata a un estudiante conectado es el
# servidor de VS Code que el CLI descarga y lanza al abrirse la pagina
# (~/.vscode/cli/servers/<version>/server/...). Sin ninguno de esos durante
# IDLE_MINUTES, la VM se apaga.
cat > /usr/local/bin/adaceen-ws-idle-check <<IDLEEOF
#!/usr/bin/env bash
STAMP=/var/run/adaceen-ws-last-active
if pgrep -f 'cli/servers/[^/]*/server' >/dev/null 2>&1; then
  date +%s > "\$STAMP"; exit 0
fi
[ -f "\$STAMP" ] || date +%s > "\$STAMP"
LAST=\$(cat "\$STAMP"); NOW=\$(date +%s)
if [ \$(( (NOW - LAST) / 60 )) -ge $IDLE_MINUTES ]; then
  echo "sin tuneles desde hace $IDLE_MINUTES min, apagando" >> /var/log/adaceen-ws-startup.log
  /sbin/shutdown -h now
fi
IDLEEOF
chmod +x /usr/local/bin/adaceen-ws-idle-check

cat > /etc/systemd/system/adaceen-ws-idle.service <<'EOF'
[Unit]
Description=ADACEEN ws: apagar si no hay tuneles
[Service]
Type=oneshot
ExecStart=/usr/local/bin/adaceen-ws-idle-check
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
systemctl enable --now adaceen-ws-idle.timer

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
  install -m 644 "$AGENTE_SRC/adaceen-workspaces-agent.service" \
    /etc/systemd/system/adaceen-workspaces-agent.service
  systemctl daemon-reload
  if [ -n "$AGENT_TOKEN" ]; then
    # umask en subshell: el archivo nace 600, sin ventana en que otro lo lea.
    (
      umask 077
      cat > /etc/adaceen-workspaces-agent.env <<EOF
AGENT_TOKEN=$AGENT_TOKEN
AGENT_HOST=$AGENT_HOST
AGENT_PORT=$AGENT_PORT
AGENT_SCRIPT=/opt/adaceen/nuevo-tunel.sh
EOF
    )
    chmod 600 /etc/adaceen-workspaces-agent.env
    systemctl enable adaceen-workspaces-agent.service
    systemctl restart adaceen-workspaces-agent.service
    echo "--- agente de entornos en $AGENT_HOST (puerto $AGENT_PORT)"
  else
    echo "--- AVISO: sin metadata workspace-agent-token; agente de entornos apagado"
    systemctl disable --now adaceen-workspaces-agent.service 2>/dev/null || true
  fi
fi

# --- tuneles ya registrados: volver a levantarlos tras un reinicio ---
for d in /home/ws-*; do
  [ -d "$d" ] || continue
  u=$(basename "$d")
  if [ -f "$d/.adaceen/tunnel.env" ]; then
    systemctl start "adaceen-tunnel@$u.service" || true
  fi
done

echo "=== listo. api=$API_URL idle=${IDLE_MINUTES}min ==="
