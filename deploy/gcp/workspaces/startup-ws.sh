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
BRANCH=$(meta branch);             BRANCH=${BRANCH:-feat/workspace-tunnel}

export DEBIAN_FRONTEND=noninteractive

# --- paquetes base (una vez) ---
# Marca de version: si cambia esta lista, sube el numero y el startup vuelve
# a instalar en la proxima arrancada.
BASE_VERSION=2
if [ "$(cat /opt/adaceen/.base-version 2>/dev/null)" != "$BASE_VERSION" ]; then
  echo "--- instalando herramientas base (java, python, node, c/c++)"
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends \
    git curl ca-certificates jq unzip \
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
if [ ! -d /opt/adaceen/repo ]; then
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" /opt/adaceen/repo
else
  git -C /opt/adaceen/repo pull --ff-only || true
fi
cp /opt/adaceen/repo/deploy/gcp/workspaces/*.sh /opt/adaceen/
chmod +x /opt/adaceen/*.sh

# --- configuracion comun a todos los tuneles ---
# La clave NO se escribe en ningun settings.json: va como variable de entorno
# del proceso del tunel, que es de donde la lee la extension
# (ADACEEN_SCAN_WORKER_KEY). Este archivo solo lo lee root.
cat > /etc/adaceen-ws.env <<EOF
ADACEEN_API_URL=$API_URL
ADACEEN_SCAN_WORKER_KEY=$WORKER_SECRET
EOF
chmod 600 /etc/adaceen-ws.env

# --- apagado por inactividad: sin ningun proceso 'code tunnel' vivo ---
cat > /usr/local/bin/adaceen-ws-idle-check <<IDLEEOF
#!/usr/bin/env bash
STAMP=/var/run/adaceen-ws-last-active
if pgrep -f 'code tunnel' >/dev/null 2>&1; then
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

# --- tuneles ya registrados: volver a levantarlos tras un reinicio ---
for d in /home/ws-*; do
  [ -d "$d" ] || continue
  u=$(basename "$d")
  if [ -f "$d/.adaceen/tunnel.env" ]; then
    systemctl start "adaceen-tunnel@$u.service" || true
  fi
done

echo "=== listo. api=$API_URL idle=${IDLE_MINUTES}min ==="
