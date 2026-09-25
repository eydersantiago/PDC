#!/bin/bash
# Doble clic en la Mac que atiende el modelo (rol servidor): instala o
# reinstala ADACEEN con instalar-worker-mac.sh, sin escribir rutas.
#   - Busca el archivo de configuracion adaceen-mac.env en una memoria USB
#     (/Volumes/<memoria>/adaceen-mac.env), en el Escritorio o en Descargas.
#     Si no esta, el instalador pide los valores (se escriben sin verse), o
#     reutiliza los de una instalacion anterior. Si la Mac ya tiene una
#     configuracion instalada, la conserva salvo que se responda «s» (por
#     ejemplo tras rotar la clave). Tiene secretos: si estaba en el Escritorio
#     o en Descargas, al terminar ofrece borrarlo.
#   - La primera vez pregunta el numero del equipo (el id queda mac-labNN-<chip>).
# Tiene que estar dentro de la carpeta deploy/mac del repositorio PDC.
# Desde Terminal acepta las mismas opciones del instalador, por ejemplo:
#   ./deploy/mac/Instalar-servidor-ADACEEN.command --respaldo
# Guia: docs/operacion/worker-mac.md, seccion 4.
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

ARGS=("$@")
tiene_opcion() {
  local arg
  for arg in ${ARGS[@]+"${ARGS[@]}"}; do
    case "$arg" in "$1"*) return 0 ;; esac
  done
  return 1
}

if [ ! -f "$DIR_SCRIPT/instalar-worker-mac.sh" ]; then
  aviso "no encuentro instalar-worker-mac.sh junto a este archivo: abre el que esta en la carpeta deploy/mac del repositorio PDC"
  pausa
  exit 1
fi

SIMULANDO=0
if tiene_opcion --simular; then SIMULANDO=1; fi

# Archivo de configuracion (con secretos): el primero que aparezca. En una
# simulacion no se mira la memoria USB (solo el Escritorio y Descargas).
# CONFIG_EN_CASA: el encontrado en el Escritorio o en Descargas, para ofrecer
# borrarlo al terminar (las Mac del laboratorio las usan otras personas).
CONFIG_EN_CASA=""
if ! tiene_opcion --config=; then
  config=""
  candidatos="$HOME/Desktop/adaceen-mac.env
$HOME/Downloads/adaceen-mac.env"
  if [ "$SIMULANDO" = 0 ]; then
    for candidato in /Volumes/*/adaceen-mac.env; do
      [ -f "$candidato" ] && candidatos="$candidato
$candidatos"
    done
  fi
  while IFS= read -r candidato; do
    if [ -f "$candidato" ]; then
      config="$candidato"
      break
    fi
  done <<EOF_CANDIDATOS
$candidatos
EOF_CANDIDATOS
  case "$config" in "$HOME/Desktop/"* | "$HOME/Downloads/"*) CONFIG_EN_CASA="$config" ;; esac
  # Ya instalada: se conserva. Un adaceen-mac.env viejo (de antes de rotar la
  # clave) en Descargas o en una USB no debe reemplazar una que funciona.
  if [ -n "$config" ] && [ -f "$ARCHIVO_WORKER_ENV" ]; then
    info "esta Mac ya tiene la configuracion instalada ($ARCHIVO_WORKER_ENV)"
    respuesta=""
    read -r -p "[adaceen] ¿Reemplazarla con $config? Solo hace falta si cambiaron las claves [s/N] " respuesta || respuesta=""
    case "$respuesta" in
      s | S | si | SI | Si) ;;
      *)
        info "conservo la configuracion instalada"
        config=""
        ;;
    esac
  fi
  if [ -n "$config" ]; then
    info "uso la configuracion de $config"
    ARGS+=("--config=$config")
  elif [ -f "$ARCHIVO_WORKER_ENV" ]; then
    info "reutilizo la configuracion de la instalacion anterior"
  else
    info "no encontre adaceen-mac.env (memoria USB, Escritorio o Descargas): el instalador te pedira los valores"
  fi
  case "$config" in /Volumes/*) info "al terminar, retira la memoria USB y guardala (tiene secretos)" ;; esac
fi

# Ofrece borrar el adaceen-mac.env del Escritorio o de Descargas (tiene la
# cadena de Service Bus y los tokens). Enter = borrarlo; sin respuesta, no.
ofrecer_borrar_config() {
  local respuesta=""
  [ -n "$CONFIG_EN_CASA" ] && [ -f "$CONFIG_EN_CASA" ] || return 0
  printf '\n'
  aviso "$CONFIG_EN_CASA tiene secretos (la clave de Service Bus y los tokens) y esta Mac la usan otras personas"
  if ! read -r -p "[adaceen] ¿Borrarlo ahora? Ya quedo instalado [S/n] " respuesta; then
    respuesta="n"
  fi
  case "$respuesta" in
    n | N | no | NO | No)
      aviso "no lo borre: borralo tu (a la Papelera, y vaciala) antes de dejar la Mac"
      ;;
    *)
      if [ "$SIMULANDO" = 1 ]; then
        info "(simulado) borraria $CONFIG_EN_CASA"
      elif rm -f "$CONFIG_EN_CASA" && [ ! -e "$CONFIG_EN_CASA" ]; then
        ok "borre $CONFIG_EN_CASA"
      else
        aviso "no pude borrar $CONFIG_EN_CASA: borralo tu antes de dejar la Mac"
      fi
      ;;
  esac
}

# Numero del equipo, solo la primera vez (despues se reutiliza el id).
if ! tiene_opcion --equipo= && ! tiene_opcion --id= && [ ! -f "$ARCHIVO_ESTADO" ]; then
  equipo=""
  read -r -p "[adaceen] Numero de este equipo (por ejemplo 07; Enter para usar el nombre de la Mac): " equipo || equipo=""
  equipo="$(printf '%s' "$equipo" | tr -cd 'A-Za-z0-9')"
  if [ -n "$equipo" ]; then ARGS+=("--equipo=$equipo"); fi
fi

bash "$DIR_SCRIPT/instalar-worker-mac.sh" ${ARGS[@]+"${ARGS[@]}"}
codigo=$?
printf '\n'
if [ "$codigo" = 0 ]; then
  ok "instalacion terminada. Para revisarla otro dia: doble clic en Estado-servidor-ADACEEN.command"
  ofrecer_borrar_config
else
  aviso "el instalador termino con errores (arriba dice que falta). Puedes volver a abrir este archivo."
fi
pausa
exit "$codigo"
