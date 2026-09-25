#!/usr/bin/env bash
# Alarma simple del backend en Azure Monitor (A15.4).
#
#   RG=<grupo de recursos> CORREO=<correo del operador> bash deploy/azure/crear-alertas.sh
#   (opcional) APP=<nombre del App Service>   defecto app-adaceen-api-eyder05232002
#
# Crea o actualiza, con la sesion de `az login`:
#   1. el grupo de acciones adaceen-alertas (correo al operador),
#   2. el health check del App Service sobre /api/health (no depende de la GPU:
#      con /api/agent/health, apagar la GPU haria reiniciar la instancia),
#   3. tres alertas de metricas: respuestas 5xx, health check en falla y tiempo
#      de respuesta promedio alto.
# La disponibilidad del tutor (GPU) se vigila durante las sesiones con
# `npm run piloto:monitor` y con el flujo programado de GitHub Actions
# (.github/workflows/salud-produccion.yml); fuera de clase la GPU esta apagada
# a proposito y una alerta en Azure sonaria todo el dia.
set -euo pipefail

RG=${RG:?Falta RG: el grupo de recursos del App Service}
CORREO=${CORREO:?Falta CORREO: quien recibe las alertas}
APP=${APP:-app-adaceen-api-eyder05232002}

command -v az >/dev/null || { echo "Falta la CLI de Azure (az). Instalala o usa Cloud Shell."; exit 1; }

APP_ID=$(az webapp show --resource-group "$RG" --name "$APP" --query id --output tsv)
echo "--- App Service: $APP_ID"

echo "--- 1/3 grupo de acciones adaceen-alertas -> $CORREO"
az monitor action-group create --only-show-errors --output none \
  --resource-group "$RG" --name adaceen-alertas --short-name adaceen \
  --action email operador "$CORREO"
AG_ID=$(az monitor action-group show --resource-group "$RG" --name adaceen-alertas --query id --output tsv)

echo "--- 2/3 health check del App Service en /api/health"
az webapp config set --only-show-errors --output none \
  --resource-group "$RG" --name "$APP" \
  --generic-configurations '{"healthCheckPath": "/api/health"}'

crear_alerta() {
  local nombre=$1 condicion=$2 severidad=$3 descripcion=$4
  if az monitor metrics alert show --resource-group "$RG" --name "$nombre" --output none 2>/dev/null; then
    az monitor metrics alert update --only-show-errors --output none \
      --resource-group "$RG" --name "$nombre" --add-action "$AG_ID" --severity "$severidad" --description "$descripcion"
    echo "    $nombre ya existia: actualizada"
  else
    az monitor metrics alert create --only-show-errors --output none \
      --resource-group "$RG" --name "$nombre" --scopes "$APP_ID" \
      --condition "$condicion" --window-size 5m --evaluation-frequency 1m \
      --severity "$severidad" --action "$AG_ID" --description "$descripcion"
    echo "    $nombre creada"
  fi
}

echo "--- 3/3 alertas de metricas"
crear_alerta adaceen-errores-5xx "total Http5xx > 5" 2 \
  "Mas de 5 respuestas 5xx del backend en 5 minutos"
crear_alerta adaceen-health-check "avg HealthCheckStatus < 100" 1 \
  "El health check /api/health del App Service falla"
crear_alerta adaceen-tiempo-respuesta "avg HttpResponseTime > 10" 3 \
  "Tiempo de respuesta promedio del backend mayor a 10 s en 5 minutos"

cat <<EOF

Listo. Para comprobar:
  az monitor metrics alert list --resource-group $RG --output table
  Portal: App Service $APP -> Alertas.
Las alertas avisan a $CORREO. Anota la fecha en docs/operacion/evidencias-despliegue.md.
EOF
