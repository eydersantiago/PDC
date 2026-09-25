#!/usr/bin/env bash
# Instala el VSIX de la extension de VS Code que fija el submodulo
# vscode-ext-prod en el clon de PDC de la VM (la rama de la metadata "branch").
#
#   instalar-vsix.sh <clon-de-PDC> [destino] [url-de-PDC]
#                    (destino: /opt/adaceen/adaceen.vsix; url-de-PDC: respaldo)
#
# El repo de la extension es publico: se baja por HTTPS de
# raw.githubusercontent.com en el commit fijado, sin credenciales y sin clonar
# el submodulo. Primero package.json (nombre y version) y luego
# <nombre>-<version>.vsix, que es como se guardan los VSIX en ese repo. OJO:
# el .gitignore de vscode-ext-prod ignora *.vsix, asi que cada VSIX se sube
# con `git add -f` (si no, aqui da 404). Antes de reemplazar se comprueba que
# el VSIX sea un zip cuya extension/package.json diga ese mismo nombre y
# version, y solo se reemplaza si el archivo es distinto (un VSIX
# reempaquetado con la misma version tambien llega).
#
# Respaldo: si el commit no trae el VSIX y se paso <url-de-PDC>, se prueba
# <url-de-PDC>/descargas/adaceen.vsix (el que el workflow de despliegue
# empaqueta del mismo submodulo) y se acepta solo si dice ese mismo nombre y
# version. Entonces no se guarda el commit: el proximo arranque lo vuelve a
# buscar en GitHub.
#
# Si algo falla, el VSIX anterior queda como estaba, se explica por que y el
# script sale con 1 (startup-ws.sh lo registra y sigue con el anterior).
# Con <destino>.commit igual al commit fijado no toca la red.
#
# Usa git, curl, unzip y node (los instala startup-ws.sh).
# Pruebas: deploy/gcp/workspaces/agente/vm-scripts.test.mjs
set -euo pipefail

REPO_DIR=${1:?clon de PDC}
DESTINO=${2:-/opt/adaceen/adaceen.vsix}
PDC_URL=${3:-}
PDC_URL=${PDC_URL%/}
# Solo las pruebas lo cambian (servidor local); en la VM, GitHub.
RAW_BASE=${ADACEEN_VSIX_RAW_BASE:-https://raw.githubusercontent.com}
case "$RAW_BASE" in
  https://* | http://127.0.0.1:*) ;;
  *) echo "ADACEEN_VSIX_RAW_BASE debe ser https://" >&2; exit 1 ;;
esac
# El respaldo tambien solo por https (o el servidor local de las pruebas).
case "$PDC_URL" in
  "" | https://* | http://127.0.0.1:*) ;;
  *) echo "--- AVISO VSIX: $PDC_URL no es https; sin respaldo desde PDC" >&2; PDC_URL="" ;;
esac

# Campo de texto de primer nivel del JSON que llega por stdin (vacio si no hay).
campo_json() {
  node -e '
    let texto = "";
    process.stdin.on("data", (trozo) => (texto += trozo)).on("end", () => {
      try {
        const valor = JSON.parse(texto)[process.argv[1]];
        if (typeof valor === "string") process.stdout.write(valor);
      } catch {}
    });' "$1"
}

# "<nombre> <version>" de extension/package.json dentro de un VSIX (vacio si no es uno).
identidad_vsix() {
  local paquete
  [ -f "$1" ] || return 0
  paquete=$(unzip -p "$1" extension/package.json 2>/dev/null) || return 0
  printf '%s %s' "$(campo_json name <<<"$paquete")" "$(campo_json version <<<"$paquete")"
}

version_instalada() {
  local identidad
  identidad=$(identidad_vsix "$DESTINO")
  printf '%s' "${identidad#* }"
}

fallar() {
  local anterior
  anterior=$(version_instalada)
  echo "--- AVISO VSIX: $*. Se conserva el VSIX anterior (${anterior:-ninguno})." >&2
  exit 1
}

# 1. Commit que fija el submodulo en este clon (git ls-tree lee la rama clonada).
tipo="" commit=""
read -r _ tipo commit _ < <(git -C "$REPO_DIR" ls-tree HEAD vscode-ext-prod 2>/dev/null) || true
if [ "$tipo" != commit ] || ! [[ $commit =~ ^[0-9a-f]{40}$ ]]; then
  fallar "el clon $REPO_DIR no fija el submodulo vscode-ext-prod"
fi

# 2. Repo de GitHub del submodulo (.gitmodules).
url=$(git -C "$REPO_DIR" config -f .gitmodules --get submodule.vscode-ext-prod.url 2>/dev/null || true)
url=${url%/}
url=${url%.git}
if ! [[ $url =~ ^(https://github\.com/|git@github\.com:)([A-Za-z0-9-]+)/([A-Za-z0-9._-]+)$ ]]; then
  fallar "vscode-ext-prod no apunta a un repo de GitHub (${url:-sin url})"
fi
REPO_GH="${BASH_REMATCH[2]}/${BASH_REMATCH[3]}"

# Ya instalado desde este mismo commit: nada que hacer.
if [ "$(cat "$DESTINO.commit" 2>/dev/null || true)" = "$commit" ] && [ -n "$(version_instalada)" ]; then
  echo "--- VSIX $(version_instalada) ya instalado (vscode-ext-prod ${commit:0:12})"
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
descargar() {
  curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 10 --max-time 120 -o "$2" "$1"
}
BASE="$RAW_BASE/$REPO_GH/$commit"

# 3. Nombre y version de la extension en ese commit.
descargar "$BASE/package.json" "$TMP/package.json" \
  || fallar "no se pudo bajar package.json de $REPO_GH en ${commit:0:12} (¿commit sin publicar en GitHub?)"
NOMBRE=$(campo_json name < "$TMP/package.json")
VERSION=$(campo_json version < "$TMP/package.json")
if ! [[ $NOMBRE =~ ^[a-z0-9][a-z0-9._-]*$ ]] || ! [[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$ ]]; then
  fallar "package.json de vscode-ext-prod sin nombre o version validos"
fi

# 4. El VSIX de esa version, comprobado antes de reemplazar el anterior. Se
# baja aunque la version instalada sea la misma: el commit cambio, y un VSIX
# reempaquetado con la misma version tiene que llegar igual.
ORIGEN="vscode-ext-prod ${commit:0:12}"
DESDE_PDC=0
if ! descargar "$BASE/$NOMBRE-$VERSION.vsix" "$TMP/nuevo.vsix"; then
  FALTA="no esta $NOMBRE-$VERSION.vsix en $REPO_GH en ${commit:0:12} (¿falta empaquetarlo, o subirlo con git add -f? *.vsix esta en el .gitignore de vscode-ext-prod)"
  if [ -z "$PDC_URL" ] || ! descargar "$PDC_URL/descargas/adaceen.vsix" "$TMP/nuevo.vsix"; then
    fallar "$FALTA"
  fi
  DESDE_PDC=1
  ORIGEN="PDC $PDC_URL/descargas/adaceen.vsix"
fi
IDENTIDAD=$(identidad_vsix "$TMP/nuevo.vsix")
if [ "$IDENTIDAD" != "$NOMBRE $VERSION" ]; then
  if [ "$DESDE_PDC" = 1 ]; then
    fallar "$FALTA; el respaldo de PDC es '${IDENTIDAD:-nada}', no $NOMBRE $VERSION"
  fi
  fallar "$NOMBRE-$VERSION.vsix no es un VSIX de esa version (dice '${IDENTIDAD:-nada}')"
fi
if [ "$DESDE_PDC" = 1 ]; then
  echo "--- AVISO VSIX: $FALTA. Se usa el de PDC, que es la misma version." >&2
fi

if [ -f "$DESTINO" ] && cmp -s "$TMP/nuevo.vsix" "$DESTINO"; then
  echo "--- VSIX $NOMBRE $VERSION ya instalado (mismo archivo; $ORIGEN)"
else
  install -m 644 "$TMP/nuevo.vsix" "$DESTINO.nuevo"
  mv -f "$DESTINO.nuevo" "$DESTINO"
  echo "--- VSIX $NOMBRE $VERSION instalado en $DESTINO ($ORIGEN)"
fi
# El commit solo se guarda si el VSIX salio de el: con el de PDC, el proximo
# arranque lo vuelve a buscar en GitHub.
if [ "$DESDE_PDC" = 1 ]; then
  rm -f "$DESTINO.commit"
else
  echo "$commit" > "$DESTINO.commit"
fi
