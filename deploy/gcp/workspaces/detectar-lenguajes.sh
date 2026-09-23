#!/usr/bin/env bash
# Mira que lenguajes hay en un repo (por extension de archivo) y devuelve la
# lista de extensiones de VS Code que conviene instalar en el tunel, una por
# linea. No instala nada: solo decide.
#
#   detectar-lenguajes.sh <carpeta-del-repo>
#
# La tabla es la misma que usa PDC para elegir la imagen del devcontainer
# (src/services/github-app.ts, DEVCONTAINER_IMAGE_BY_LANGUAGE), para que un
# estudiante vea lo mismo entre en Codespaces o por el tunel.
set -euo pipefail

DIR=${1:?carpeta del repo}

# extension de archivo -> extension de VS Code (id del Marketplace)
declare -A POR_EXT=(
  [java]="vscjava.vscode-java-pack"
  [kt]="fwcd.kotlin"
  [py]="ms-python.python"
  [ipynb]="ms-toolsai.jupyter"
  [js]="dbaeumer.vscode-eslint"
  [jsx]="dbaeumer.vscode-eslint"
  [ts]="dbaeumer.vscode-eslint"
  [tsx]="dbaeumer.vscode-eslint"
  [vue]="Vue.volar"
  [c]="ms-vscode.cpptools"
  [h]="ms-vscode.cpptools"
  [cpp]="ms-vscode.cpptools"
  [hpp]="ms-vscode.cpptools"
  [cc]="ms-vscode.cpptools"
  [cs]="ms-dotnettools.csdevkit"
  [go]="golang.go"
  [rs]="rust-lang.rust-analyzer"
  [php]="bmewburn.vscode-intelephense-client"
  [rb]="Shopify.ruby-lsp"
  [dart]="Dart-Code.dart-code"
  [sql]="mtxr.sqltools"
)

# Cuenta archivos por extension, ignorando dependencias y salidas de build.
# Un lenguaje "cuenta" si tiene al menos 2 archivos, para que un script suelto
# no arrastre un paquete entero de extensiones.
declare -A CONTEO=()
while IFS= read -r f; do
  ext="${f##*.}"
  ext="${ext,,}"
  [ -n "${POR_EXT[$ext]:-}" ] || continue
  CONTEO[$ext]=$(( ${CONTEO[$ext]:-0} + 1 ))
done < <(find "$DIR" -type f \
  -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/build/*' \
  -not -path '*/dist/*' -not -path '*/target/*' -not -path '*/venv/*' \
  -not -path '*/.venv/*' -not -path '*/__pycache__/*' 2>/dev/null | head -n 5000)

declare -A ELEGIDAS=()
for ext in "${!CONTEO[@]}"; do
  n=${CONTEO[$ext]}
  [ "$n" -ge 2 ] || continue
  ELEGIDAS[${POR_EXT[$ext]}]=1
done

# Si el repo no tiene nada reconocible, no se instala nada extra: VS Code ya
# trae resaltado para casi todo y ADACEEN funciona sobre cualquier texto.
for id in "${!ELEGIDAS[@]}"; do
  echo "$id"
done | sort
