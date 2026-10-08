#!/usr/bin/env bash
# Instala el VSIX de la extension de VS Code que fija el submodulo
# vscode-ext-prod en el clon de PDC de la VM (la rama de la metadata "branch").
#
#   instalar-vsix.sh <clon-de-PDC> [destino] [url-de-PDC]
#                    (destino: /opt/adaceen/adaceen.vsix; url-de-PDC: metadata api-url)
#
# La version esperada es la del commit fijado: su package.json (nombre y
# version) se baja por HTTPS de raw.githubusercontent.com, sin credenciales y
# sin clonar el submodulo (el repo de la extension es publico). El VSIX se
# busca en este orden:
#   1. <url-de-PDC>/descargas/adaceen.vsix: el que el workflow de despliegue
#      empaqueta con vsce del mismo submodulo en cada push (paso "Build ADACEEN
#      VSIX") y que sirve el backend. Se acepta solo si es un zip cuya
#      extension/package.json diga ese mismo nombre y version.
#   2. Respaldo, si PDC no responde o sirve otra version (p. ej. el push aun no
#      se desplego): <nombre>-<version>.vsix en ese commit, en
#      raw.githubusercontent.com. El .gitignore de vscode-ext-prod ignora
#      *.vsix, asi que solo esta si se subio con `git add -f` (opcional).
# Solo se reemplaza el anterior si el archivo es distinto (un VSIX
# reempaquetado con la misma version tambien llega) y, venga de donde venga,
# se guarda el commit en <destino>.commit: con el mismo commit fijado no toca
# la red.
#
# Si algo falla (sin red, commit sin empujar a GitHub, PDC sin esa version y
# el commit sin el VSIX), el VSIX anterior queda como estaba, se explica por
# que (`AVISO VSIX: ...`) y el script sale con 1 (startup-ws.sh lo registra y
# sigue con el anterior). deploy/produccion.sh lee estas lineas del log:
# `VSIX <nombre> <version> instalado`, `ya instalado` y `AVISO VSIX: ...`.
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
# PDC tambien solo por https (o el servidor local de las pruebas).
case "$PDC_URL" in
  "" | https://* | http://127.0.0.1:*) ;;
  *) echo "--- AVISO VSIX: $PDC_URL no es https; no se usa PDC" >&2; PDC_URL="" ;;
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
# Primero el de PDC, que cada despliegue empaqueta del mismo commit.
ORIGEN=""
SIN_PDC="" # por que no sirvio el de PDC (vacio: sirvio, o no hay url de PDC)
if [ -n "$PDC_URL" ]; then
  if ! descargar "$PDC_URL/descargas/adaceen.vsix" "$TMP/nuevo.vsix"; then
    SIN_PDC="PDC no respondio ($PDC_URL/descargas/adaceen.vsix)"
  else
    IDENTIDAD=$(identidad_vsix "$TMP/nuevo.vsix")
    if [ "$IDENTIDAD" = "$NOMBRE $VERSION" ]; then
      ORIGEN="PDC $PDC_URL/descargas/adaceen.vsix"
    else
      SIN_PDC="PDC sirve '${IDENTIDAD:-nada}', no $NOMBRE $VERSION (¿el push aun no se desplego?)"
    fi
  fi
fi
# Respaldo: el VSIX subido al commit del submodulo (git add -f).
if [ -z "$ORIGEN" ]; then
  if ! descargar "$BASE/$NOMBRE-$VERSION.vsix" "$TMP/nuevo.vsix"; then
    fallar "${SIN_PDC:+$SIN_PDC, y }no esta $NOMBRE-$VERSION.vsix en $REPO_GH en ${commit:0:12} (lo publica el despliegue de PDC en /descargas/adaceen.vsix; de respaldo se sube a ese commit con git add -f, porque *.vsix esta en el .gitignore de vscode-ext-prod)"
  fi
  IDENTIDAD=$(identidad_vsix "$TMP/nuevo.vsix")
  if [ "$IDENTIDAD" != "$NOMBRE $VERSION" ]; then
    fallar "${SIN_PDC:+$SIN_PDC, y }$NOMBRE-$VERSION.vsix no es un VSIX de esa version (dice '${IDENTIDAD:-nada}')"
  fi
  if [ -n "$SIN_PDC" ]; then
    echo "--- AVISO VSIX: $SIN_PDC. Se usa $NOMBRE-$VERSION.vsix del commit en GitHub." >&2
  fi
  ORIGEN="vscode-ext-prod ${commit:0:12}"
fi

if [ -f "$DESTINO" ] && cmp -s "$TMP/nuevo.vsix" "$DESTINO"; then
  echo "--- VSIX $NOMBRE $VERSION ya instalado (mismo archivo; $ORIGEN)"
else
  install -m 644 "$TMP/nuevo.vsix" "$DESTINO.nuevo"
  mv -f "$DESTINO.nuevo" "$DESTINO"
  echo "--- VSIX $NOMBRE $VERSION instalado en $DESTINO ($ORIGEN)"
fi
# Venga de PDC o de GitHub, es el VSIX de este commit: el proximo arranque con
# el mismo commit no toca la red.
echo "$commit" > "$DESTINO.commit"
