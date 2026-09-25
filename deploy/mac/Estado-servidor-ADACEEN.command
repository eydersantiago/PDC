#!/bin/bash
# Doble clic en una Mac del laboratorio con ADACEEN instalado: muestra el
# estado (worker-mac.sh estado: servicios, modelo en memoria y si Azure la ve
# viva) y ofrece encender los servicios que esten apagados.
# Tiene que estar dentro de la carpeta deploy/mac del repositorio PDC.
# Guia: docs/operacion/worker-mac.md, seccion 6.
set -uo pipefail

DIR_SCRIPT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=deploy/mac/comun.sh
. "$DIR_SCRIPT/comun.sh"

pausa() {
  if [ -t 0 ]; then
    printf '\n'
    read -r -p "Presiona Enter para cerrar esta ventana. " _ || true
  fi
}

if [ ! -f "$DIR_SCRIPT/worker-mac.sh" ]; then
  aviso "no encuentro worker-mac.sh junto a este archivo: abre el que esta en la carpeta deploy/mac del repositorio PDC"
  pausa
  exit 1
fi
if [ ! -f "$ARCHIVO_ESTADO" ]; then
  aviso "ADACEEN no esta instalado en esta Mac: doble clic en Instalar-servidor-ADACEEN.command"
  pausa
  exit 1
fi

bash "$DIR_SCRIPT/worker-mac.sh" estado
codigo=$?

# "iniciar" no corta nada: los servicios que ya corren siguen igual.
respuesta=""
if [ -t 0 ]; then
  printf '\n'
  read -r -p "[adaceen] ¿Encender los servicios que esten apagados? [s/N] " respuesta || respuesta=""
fi
case "$respuesta" in
  s | S | si | SI | Si)
    bash "$DIR_SCRIPT/worker-mac.sh" iniciar && sleep 5 && bash "$DIR_SCRIPT/worker-mac.sh" estado
    codigo=$?
    ;;
esac
pausa
exit "$codigo"
