#!/usr/bin/env bash
# Spike de la opcion A (VS Code Tunnels + vscode.dev), a mano, contigo como
# unico estudiante. Objetivo: responder tres preguntas con evidencia.
#
#   1. Un token OAuth emitido por PDC sirve para registrar el tunel?
#      (Esperado: NO -> el estudiante teclea un codigo una sola vez.)
#   2. Se instala adaceen.adaceen en el servidor del tunel y aparece
#      "GPU: Google Cloud - L4" en la barra de estado con la VM de GPU encendida?
#   3. Cuanto tarda desde 'nuevo-tunel.sh' hasta ver el editor en vscode.dev?
#
# Uso, dentro de la VM (gcloud compute ssh adaceen-ws --tunnel-through-iap):
#   sudo bash /opt/adaceen/spike-tunnel.sh
set -euo pipefail

echo "=== spike tunel $(date -Is)"
read -rp  "Tu login de GitHub: " LOGIN
read -rp  "Repo a clonar [https://github.com/eydersantiago/FadaProyecto.git]: " REPO
REPO=${REPO:-https://github.com/eydersantiago/FadaProyecto.git}
read -rsp "Token OAuth de PDC para probar la pregunta 1 (Enter = saltar): " TOKEN; echo

T0=$(date +%s)
bash /opt/adaceen/nuevo-tunel.sh "$LOGIN" "$REPO" "$TOKEN"
T1=$(date +%s)

cat <<EOF

=== resultado parcial
  tiempo hasta tunel registrado y servicio arriba: $((T1 - T0)) s
  (el primer arranque del servidor baja ~60 MB mas cuando abras la pagina)

Ahora, en tu navegador:
  1. abre la URL de arriba con la cuenta de GitHub '$LOGIN'
  2. cronometra hasta ver el arbol de archivos
  3. mira la barra de estado: debe decir "GPU: Google Cloud - L4"
     (con adaceen-worker encendida) o un aviso si esta apagada
  4. Ctrl+Shift+P -> "ADACEEN: Ver de donde sale la GPU"

Anota los tres numeros en docs/workspaces-tunnel.md, seccion "Spike".
EOF
