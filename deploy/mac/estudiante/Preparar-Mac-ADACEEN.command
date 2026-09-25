#!/bin/bash
# Prepara la Mac de un estudiante para ADACEEN. Doble clic, una vez por equipo
# (o por usuario del equipo):
#   1. git: si falta, abre el instalador de Apple (xcode-select --install)
#   2. VS Code en ~/Applications si no esta (descarga oficial, darwin-universal)
#   3. el comando `code` en la Terminal
#   4. la extension de ADACEEN: la que publica el backend en
#      /descargas/adaceen.vsix (o, sin red, un .vsix junto a este archivo)
#   5. abre <backend>/empezar en el navegador
# No pide clave de administrador ni guarda secretos. Se puede abrir otra vez:
# lo que ya esta se deja como esta y la extension se actualiza.
#
# Si macOS dice que no puede abrirlo: clic derecho sobre el archivo > Abrir.
# Si ni asi: abre Terminal y escribe  bash ~/Downloads/Preparar-Mac-ADACEEN.command
#
# Desde Terminal acepta:
#   --backend=<url>     otro backend (defecto: el de produccion, o ADACEEN_BACKEND)
#   --sin-abrir         no abre el navegador al final
#   --simular[=<dir>]   no toca el sistema: escribe en <dir> y muestra lo que haria
#                       (sirve tambien en Linux para revisar)
# Guia: docs/operacion/worker-mac.md, seccion 11.
#
# Se escribe para el bash 3.2 que trae macOS: sin arreglos asociativos ni mapfile.
set -euo pipefail

BACKEND_PRODUCCION="https://app-adaceen-api-eyder05232002.azurewebsites.net"
URL_VSCODE="https://update.code.visualstudio.com/latest/darwin-universal/stable"
NOMBRE_APP="Visual Studio Code.app"
ID_EXTENSION="adaceen.adaceen"
# La que pide la extension (engines.vscode de vscode-ext-prod/package.json).
VSCODE_MINIMO="1.96.0"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
MARCA_INICIO="# >>> ADACEEN: comando code de VS Code >>>"
MARCA_FIN="# <<< ADACEEN <<<"

info() { printf '[adaceen] %s\n' "$*"; }
ok() { printf '[adaceen] ✓ %s\n' "$*"; }
aviso() { printf '[adaceen] AVISO: %s\n' "$*" >&2; }

DIR_SCRIPT="$(cd "$(dirname "$0")" && pwd)"
BACKEND="${ADACEEN_BACKEND:-$BACKEND_PRODUCCION}"
ABRIR=1
SIMULAR=0
DIR_SIMULACION=""
for arg in "$@"; do
  case "$arg" in
    --backend=*) BACKEND="${arg#*=}" ;;
    --sin-abrir) ABRIR=0 ;;
    --simular) SIMULAR=1 ;;
    --simular=*) SIMULAR=1; DIR_SIMULACION="${arg#*=}" ;;
    -h | --help | --ayuda) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) aviso "opcion desconocida: $arg (usa --ayuda)"; exit 1 ;;
  esac
done
BACKEND="${BACKEND%/}"
re_url='^https?://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$'
if ! [[ $BACKEND =~ $re_url ]]; then
  aviso "--backend no es una URL valida: $BACKEND"
  exit 1
fi

# Al terminar, la ventana de Terminal queda abierta hasta Enter (doble clic).
pausa() {
  if [ "$SIMULAR" = 0 ] && [ -t 0 ]; then
    printf '\n'
    read -r -p "Presiona Enter para cerrar esta ventana. " _ || true
  fi
}

if [ "$SIMULAR" = 1 ]; then
  DIR_SIMULACION="${DIR_SIMULACION:-$(mktemp -d "${TMPDIR:-/tmp}/adaceen-estudiante.XXXXXX")}"
  mkdir -p "$DIR_SIMULACION"
  DIR_SIMULACION="$(cd "$DIR_SIMULACION" && pwd)"
  CASA="$DIR_SIMULACION/home"
  APPS_SISTEMA="$DIR_SIMULACION/Applications"
  mkdir -p "$CASA"
  info "SIMULACION: nada se instala; los archivos quedan en $DIR_SIMULACION"
else
  if [ "$(uname -s)" != "Darwin" ]; then
    aviso "este instalador es para macOS (en otro sistema usa --simular)"
    exit 1
  fi
  CASA="$HOME"
  APPS_SISTEMA="/Applications"
fi
APPS_USUARIO="$CASA/Applications"
PENDIENTES=""
anotar_pendiente() { PENDIENTES="${PENDIENTES}  - $*"$'\n'; }

info "Preparando esta Mac para ADACEEN (backend $BACKEND)"

# Proxy del laboratorio: el que tenga configurado la Mac, si la Terminal no trae uno.
if [ "$SIMULAR" = 0 ] && [ -z "${HTTPS_PROXY:-${https_proxy:-}}" ]; then
  proxy_sistema="$(scutil --proxy 2>/dev/null || true)"
  if printf '%s' "$proxy_sistema" | grep -q 'HTTPSEnable : 1'; then
    px_host="$(printf '%s\n' "$proxy_sistema" | awk '/HTTPSProxy :/ {print $3}')"
    px_puerto="$(printf '%s\n' "$proxy_sistema" | awk '/HTTPSPort :/ {print $3}')"
    if [ -n "$px_host" ]; then
      export HTTPS_PROXY="http://$px_host:${px_puerto:-80}" https_proxy="http://$px_host:${px_puerto:-80}"
      info "uso el proxy de la Mac: $px_host:${px_puerto:-80}"
    fi
  fi
fi

# ---------------------------------------------------------------- 1. git
GIT_OK=0
if [ "$SIMULAR" = 1 ]; then
  [ "${ADACEEN_SIM_GIT:-ok}" = "falta" ] || GIT_OK=1
elif xcode-select -p >/dev/null 2>&1 && /usr/bin/git --version >/dev/null 2>&1; then
  GIT_OK=1
elif command -v git >/dev/null 2>&1 && [ "$(command -v git)" != "/usr/bin/git" ] && git --version >/dev/null 2>&1; then
  GIT_OK=1
fi
if [ "$GIT_OK" = 1 ]; then
  if [ "$SIMULAR" = 1 ]; then ok "git instalado"; else ok "git instalado ($(git --version 2>/dev/null | head -n 1))"; fi
else
  if [ "$SIMULAR" = 1 ]; then
    info "(simulado) xcode-select --install"
  else
    xcode-select --install >/dev/null 2>&1 || true
  fi
  aviso "falta git. Se abrio una ventana de Apple para instalar las herramientas de desarrollo (incluyen git):"
  aviso "  haz clic en «Instalar», acepta y espera a que termine (5 a 15 minutos). No hace falta volver a abrir este archivo."
  aviso "  Si no aparecio la ventana, abre Terminal y escribe: xcode-select --install"
  aviso "  Si pide la clave de un administrador y no la tienes, avisa al docente o a soporte del laboratorio (se instala una vez por equipo)."
  anotar_pendiente "git: termina la instalacion de las herramientas de Apple (sin git, VS Code no puede descargar tu repositorio)"
fi

# ---------------------------------------------------------------- 2. VS Code
VSCODE_APP=""
buscar_vscode() {
  local app
  for app in "$APPS_SISTEMA/$NOMBRE_APP" "$APPS_USUARIO/$NOMBRE_APP"; do
    if [ -x "$app/Contents/Resources/app/bin/code" ]; then
      VSCODE_APP="$app"
      return 0
    fi
  done
  if [ "$SIMULAR" = 0 ] && command -v mdfind >/dev/null 2>&1; then
    app="$(mdfind "kMDItemCFBundleIdentifier == 'com.microsoft.VSCode'" 2>/dev/null | head -n 1 || true)"
    if [ -n "$app" ] && [ -x "$app/Contents/Resources/app/bin/code" ]; then
      VSCODE_APP="$app"
      return 0
    fi
  fi
  return 1
}

instalar_vscode() {
  local tmp
  if [ "$SIMULAR" = 1 ]; then
    info "(simulado) descargaria VS Code de $URL_VSCODE y lo dejaria en $APPS_USUARIO"
    return 1
  fi
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/adaceen-vscode.XXXXXX")"
  info "descargando VS Code (unos 250 MB; puede tardar unos minutos)"
  if ! curl -fL --progress-bar -m 1800 "$URL_VSCODE" -o "$tmp/vscode.zip"; then
    rm -rf "$tmp"
    aviso "no pude descargar VS Code (revisa la red)"
    return 1
  fi
  if ! ditto -x -k "$tmp/vscode.zip" "$tmp/app" || [ ! -d "$tmp/app/$NOMBRE_APP" ]; then
    rm -rf "$tmp"
    aviso "el archivo descargado no es VS Code"
    return 1
  fi
  # Firma de Microsoft: si no la tiene, no se instala. La salida de codesign se
  # guarda antes de buscar en ella: con `codesign | grep -q` y pipefail, grep
  # termina en la primera coincidencia, codesign recibe SIGPIPE y una firma
  # buena se tomaria por mala.
  if command -v codesign >/dev/null 2>&1; then
    local firma="" firma_ok=0
    if codesign --verify --strict "$tmp/app/$NOMBRE_APP" >/dev/null 2>&1; then
      firma="$(codesign -dv --verbose=2 "$tmp/app/$NOMBRE_APP" 2>&1 || true)"
      case "$firma" in *"Microsoft Corporation"* | *"TeamIdentifier=UBF8T346G9"*) firma_ok=1 ;; esac
    fi
    if [ "$firma_ok" = 0 ]; then
      rm -rf "$tmp"
      aviso "la descarga de VS Code no tiene la firma de Microsoft: no la instalo"
      return 1
    fi
  fi
  mkdir -p "$APPS_USUARIO"
  # Una copia a medias (sin el ejecutable) no sirve: se reemplaza.
  rm -rf "${APPS_USUARIO:?}/$NOMBRE_APP"
  mv "$tmp/app/$NOMBRE_APP" "$APPS_USUARIO/"
  rm -rf "$tmp"
  return 0
}

if buscar_vscode; then
  ok "VS Code ya esta instalado ($VSCODE_APP)"
elif instalar_vscode && buscar_vscode; then
  ok "VS Code instalado en $VSCODE_APP"
else
  VSCODE_APP="$APPS_USUARIO/$NOMBRE_APP"
  if [ "$SIMULAR" = 0 ]; then
    aviso "no se pudo instalar VS Code. Descargalo de https://code.visualstudio.com, arrastralo a Aplicaciones y vuelve a abrir este archivo."
    anotar_pendiente "VS Code: instalalo desde https://code.visualstudio.com y vuelve a abrir este archivo"
  fi
fi
CODE_CLI="$VSCODE_APP/Contents/Resources/app/bin/code"

# Enlaces vscode:// del navegador («Abrir en VS Code de este equipo»): una app
# copiada por Terminal y nunca abierta puede no estar registrada todavia como
# la que los abre. Se registra (no abre nada; si falla, basta abrir VS Code una vez).
registrar_enlaces() {
  if [ "$SIMULAR" = 1 ]; then
    info "(simulado) lsregister -f $VSCODE_APP (enlaces vscode:// del navegador)"
  elif [ -x "$LSREGISTER" ]; then
    "$LSREGISTER" -f "$VSCODE_APP" >/dev/null 2>&1 || true
  fi
}
if [ -x "$CODE_CLI" ] || [ "$SIMULAR" = 1 ]; then
  registrar_enlaces
fi

# 1 si la version $1 (x.y.z) es anterior a $2.
version_anterior() {
  local a1 a2 a3 b1 b2 b3
  IFS=. read -r a1 a2 a3 _ <<<"$1.0.0"
  IFS=. read -r b1 b2 b3 _ <<<"$2.0.0"
  a1="${a1%%[!0-9]*}"; a2="${a2%%[!0-9]*}"; a3="${a3%%[!0-9]*}"
  b1="${b1%%[!0-9]*}"; b2="${b2%%[!0-9]*}"; b3="${b3%%[!0-9]*}"
  [ "${a1:-0}" -lt "${b1:-0}" ] && return 0
  [ "${a1:-0}" -gt "${b1:-0}" ] && return 1
  [ "${a2:-0}" -lt "${b2:-0}" ] && return 0
  [ "${a2:-0}" -gt "${b2:-0}" ] && return 1
  [ "${a3:-0}" -lt "${b3:-0}" ]
}

# Un VS Code viejo rechaza la extension: se dice que hay que actualizarlo.
VSCODE_VIEJO=0
if [ -x "$CODE_CLI" ]; then
  version_vscode="$("$CODE_CLI" --version 2>/dev/null | head -n 1 || true)"
  if [[ $version_vscode =~ ^[0-9]+\.[0-9]+ ]] && version_anterior "$version_vscode" "$VSCODE_MINIMO"; then
    VSCODE_VIEJO=1
    aviso "este VS Code es la version $version_vscode y la extension de ADACEEN necesita $VSCODE_MINIMO o mas nueva"
    anotar_pendiente "VS Code: actualizalo (en VS Code: menu Code > «Buscar actualizaciones…», o descarga el nuevo de https://code.visualstudio.com) y vuelve a abrir este archivo"
  fi
fi

# ---------------------------------------------------------------- 3. comando code
# Enlace en ~/.local/bin (no pide clave de administrador) y esa carpeta en el
# PATH de las Terminal nuevas (zsh, y bash si el usuario lo usa).
asegurar_comando_code() {
  local bin="$CASA/.local/bin" perfil
  if [ "$SIMULAR" = 0 ] && command -v code >/dev/null 2>&1 && [ "$(command -v code)" != "$bin/code" ]; then
    ok "comando code disponible ($(command -v code))"
    return 0
  fi
  mkdir -p "$bin"
  ln -sf "$CODE_CLI" "$bin/code"
  for perfil in "$CASA/.zprofile" "$CASA/.bash_profile"; do
    # .bash_profile solo si ya existe (quien usa bash); .zprofile siempre (zsh es el de macOS).
    if [ "$perfil" = "$CASA/.bash_profile" ] && [ ! -f "$perfil" ]; then continue; fi
    if ! grep -qF "$MARCA_INICIO" "$perfil" 2>/dev/null; then
      {
        printf '\n%s\n' "$MARCA_INICIO"
        # shellcheck disable=SC2016  # $HOME y $PATH se expanden al abrir la Terminal
        printf '%s\n' 'export PATH="$HOME/.local/bin:$PATH"'
        printf '%s\n' "$MARCA_FIN"
      } >>"$perfil"
    fi
  done
  ok "comando code disponible en las ventanas nuevas de Terminal ($bin/code)"
}
if [ -x "$CODE_CLI" ] || [ "$SIMULAR" = 1 ]; then
  asegurar_comando_code
fi

# ---------------------------------------------------------------- 4. extension
# Primero la que publica el backend (la vigente). Un .vsix junto a este archivo
# solo se usa si no se puede descargar: el zip se suele descomprimir en
# Descargas, donde puede quedar uno viejo, y ese se instala sin --force para que
# VS Code no baje a una version anterior a la que ya tenga.
VSIX=""
VSIX_LOCAL=0
VSIX_TMP=""
limpiar() { [ -z "$VSIX_TMP" ] || rm -rf "$VSIX_TMP"; }
trap limpiar EXIT
if [ "$SIMULAR" = 1 ] && [ "${ADACEEN_SIM_DESCARGAR:-0}" != 1 ]; then
  info "(simulado) descargaria la extension de $BACKEND/descargas/adaceen.vsix"
  VSIX="$DIR_SIMULACION/adaceen.vsix"
else
  VSIX_TMP="$(mktemp -d "${TMPDIR:-/tmp}/adaceen-vsix.XXXXXX")"
  info "descargando la extension de $BACKEND/descargas/adaceen.vsix"
  if curl -fsSL -m 300 "$BACKEND/descargas/adaceen.vsix" -o "$VSIX_TMP/adaceen.vsix" &&
    [ "$(head -c 2 "$VSIX_TMP/adaceen.vsix")" = "PK" ]; then
    VSIX="$VSIX_TMP/adaceen.vsix"
  else
    aviso "no pude descargar la extension de $BACKEND/descargas/adaceen.vsix"
  fi
fi
if [ -z "$VSIX" ]; then
  if [ -f "$DIR_SCRIPT/adaceen.vsix" ]; then
    VSIX="$DIR_SCRIPT/adaceen.vsix"
  else
    # El mas reciente de adaceen-<version>.vsix junto a este archivo.
    # shellcheck disable=SC2012  # nombres controlados (adaceen-X.Y.Z.vsix)
    VSIX="$(ls -t "$DIR_SCRIPT"/adaceen-*.vsix 2>/dev/null | head -n 1 || true)"
  fi
  if [ -n "$VSIX" ]; then
    VSIX_LOCAL=1
    info "extension: uso $(basename "$VSIX") (junto a este archivo); si VS Code ya tiene una version mas nueva, la conserva"
  fi
fi

# Instala el VSIX: el del backend con --force (manda el backend, tambien para
# volver a una version anterior); el de al lado, sin --force (no baja de version).
instalar_vsix() {
  if [ "$VSIX_LOCAL" = 1 ]; then
    "$CODE_CLI" --install-extension "$VSIX" 2>&1
  else
    "$CODE_CLI" --install-extension "$VSIX" --force 2>&1
  fi
}

EXTENSION_OK=0
if [ -z "$VSIX" ]; then
  anotar_pendiente "extension: descarga adaceen.vsix de $BACKEND/empezar, ponla junto a este archivo y vuelve a abrirlo"
elif [ ! -x "$CODE_CLI" ]; then
  if [ "$SIMULAR" = 1 ]; then
    info "(simulado) code --install-extension $VSIX --force"
    EXTENSION_OK=1
  fi
else
  info "instalando la extension en VS Code"
  if salida_vsix="$(instalar_vsix)"; then
    version="$("$CODE_CLI" --list-extensions --show-versions 2>/dev/null | grep -i "^$ID_EXTENSION@" | head -n 1 || true)"
    ok "extension de ADACEEN instalada${version:+ (${version#*@})}. Si VS Code estaba abierto, cierralo y vuelve a abrirlo."
    EXTENSION_OK=1
  else
    aviso "VS Code no pudo instalar la extension:"
    printf '%s\n' "$salida_vsix" | grep -v '^[[:space:]]*$' | tail -n 3 | sed 's/^/    /' >&2
    if [ "$VSCODE_VIEJO" = 1 ]; then
      anotar_pendiente "extension: se instala sola al volver a abrir este archivo con VS Code actualizado"
    else
      anotar_pendiente "extension: en VS Code, menu de extensiones (...) > «Install from VSIX...» y elige adaceen.vsix"
    fi
  fi
fi

# ---------------------------------------------------------------- 5. /empezar
if [ "$ABRIR" = 1 ]; then
  if [ "$SIMULAR" = 1 ]; then
    info "(simulado) open $BACKEND/empezar"
  elif open "$BACKEND/empezar" >/dev/null 2>&1; then
    ok "abri $BACKEND/empezar en el navegador"
  else
    info "abre en el navegador: $BACKEND/empezar"
  fi
fi

printf '\n'
if [ -z "$PENDIENTES" ]; then
  ok "listo: esta Mac ya esta preparada para ADACEEN. Sigue los pasos de la pagina que se abrio."
else
  aviso "casi listo; falta:"
  printf '%s' "$PENDIENTES" >&2
fi
if [ "$SIMULAR" = 1 ]; then
  info "archivos simulados en $DIR_SIMULACION"
fi
pausa
[ "$EXTENSION_OK" = 1 ] || exit 1
