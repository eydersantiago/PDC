#!/bin/bash
# Operacion diaria de ADACEEN en una Mac del laboratorio (lo que dejo
# instalar-worker-mac.sh).
#
#   bash deploy/mac/worker-mac.sh estado        servicios, modelo en memoria, latido en Azure
#   bash deploy/mac/worker-mac.sh iniciar       enciende los servicios (y quedan activos al iniciar sesion)
#   bash deploy/mac/worker-mac.sh detener       los apaga y no vuelven a arrancar hasta "iniciar"
#   bash deploy/mac/worker-mac.sh reiniciar     apaga y enciende (rota los logs de mas de 20 MB)
#   bash deploy/mac/worker-mac.sh logs [worker|ollama|local|llama|nodo]
#   bash deploy/mac/worker-mac.sh velocidad     cuanto tarda una peticion tipica en esta Mac
#   bash deploy/mac/worker-mac.sh desinstalar [--borrar-modelos]
#
# Guia: docs/operacion/worker-mac.md
set -euo pipefail

DIR_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/mac/comun.sh
. "$DIR_SCRIPT/comun.sh"

accion="${1:-estado}"
shift || true

leer_estado || fallar "ADACEEN no esta instalado en esta Mac (corre deploy/mac/instalar-worker-mac.sh)"
MODO="${EST_MODO:-sesion}"
DOMINIO="$(dominio_launchd "$MODO")"
DIR_PLISTS="$(dir_plists "$MODO")"
URL_OLLAMA="http://127.0.0.1:${EST_OLLAMA_PUERTO:-11434}"
URL_LLAMA="http://127.0.0.1:${EST_PUERTO_LLAMA:-8091}"

# co.edu.univalle.adaceen.worker -> worker.log (igual que el instalador).
log_de() { echo "$DIR_LOGS/${1##*.}.log"; }

cargado() { con_permisos "$MODO" launchctl print "$DOMINIO/$1" >/dev/null 2>&1; }

ollama_responde() { curl -s -m 3 "$URL_OLLAMA/api/version" 2>/dev/null | grep -q '"version"'; }

iniciar() {
  local etiqueta
  for etiqueta in $EST_SERVICIOS; do
    [ -f "$DIR_PLISTS/$etiqueta.plist" ] || fallar "falta $DIR_PLISTS/$etiqueta.plist: vuelve a correr el instalador"
    con_permisos "$MODO" launchctl enable "$DOMINIO/$etiqueta" || true
    if cargado "$etiqueta"; then
      con_permisos "$MODO" launchctl kickstart "$DOMINIO/$etiqueta" >/dev/null 2>&1 || true
    else
      rotar_log "$(log_de "$etiqueta")"
      con_permisos "$MODO" launchctl bootstrap "$DOMINIO" "$DIR_PLISTS/$etiqueta.plist"
    fi
    ok "encendido $etiqueta"
  done
}

detener() {
  local etiqueta
  # Primero el worker (deja de tomar trabajos), luego el modelo y al final los nodos y Ollama.
  for etiqueta in "$ETIQUETA_WORKER" "$ETIQUETA_LOCAL" "$ETIQUETA_LLAMA" "$ETIQUETA_NODO" "$ETIQUETA_OLLAMA"; do
    case " $EST_SERVICIOS " in *" $etiqueta "*) ;; *) continue ;; esac
    con_permisos "$MODO" launchctl bootout "$DOMINIO/$etiqueta" >/dev/null 2>&1 || true
    # disable: tampoco arranca en el proximo inicio de sesion o reinicio.
    con_permisos "$MODO" launchctl disable "$DOMINIO/$etiqueta" || true
    ok "apagado $etiqueta"
  done
}

# Los fragmentos de node -e usan plantillas de JavaScript entre comillas simples.
# shellcheck disable=SC2016
estado() {
  local etiqueta detalle pid
  if [ "${EST_ROL:-}" = "nodo" ]; then
    info "rol nodo del cluster, modo $MODO, ${EST_IP_CLUSTER:-?}:${EST_PUERTO_RPC:-50052}, llama.cpp $(cat "${EST_LLAMA_DIR:-/nonexistent}/VERSION" 2>/dev/null || echo '?')"
  else
    info "rol ${EST_ROL:-?}, modo $MODO, modelo ${EST_MODELO:-?}${EST_MODELO_VISION:+ y $EST_MODELO_VISION}, tipos ${EST_TIPOS:-?}, concurrencia ${EST_CONCURRENCIA:-?}${EST_WORKER_ID:+, id $EST_WORKER_ID}$([ "${EST_PRIORIDAD:-normal}" = "backup" ] && echo ", de respaldo")"
  fi
  for etiqueta in $EST_SERVICIOS; do
    if detalle="$(con_permisos "$MODO" launchctl print "$DOMINIO/$etiqueta" 2>/dev/null)"; then
      pid="$(printf '%s\n' "$detalle" | awk '$1 == "pid" {print $3; exit}')"
      if [ -n "$pid" ]; then ok "$etiqueta corriendo (pid $pid)"; else aviso "$etiqueta cargado pero sin proceso: bash deploy/mac/worker-mac.sh logs"; fi
    else
      aviso "$etiqueta apagado (bash deploy/mac/worker-mac.sh iniciar)"
    fi
  done
  case "${EST_ROL:-}" in
    nodo)
      if nc -z -G 2 "${EST_IP_CLUSTER:-}" "${EST_PUERTO_RPC:-50052}" >/dev/null 2>&1; then
        ok "nodo del cluster escuchando en ${EST_IP_CLUSTER:-?}:${EST_PUERTO_RPC:-50052}"
      else
        aviso "el nodo no responde en ${EST_IP_CLUSTER:-?}:${EST_PUERTO_RPC:-50052} (bash deploy/mac/worker-mac.sh logs nodo)"
      fi
      return 0
      ;;
    coordinador)
      if curl -s -m 5 "$URL_LLAMA/health" 2>/dev/null | grep -q '"ok"'; then
        ok "llama-server listo en $URL_LLAMA con ${EST_MODELO:-?}"
      else
        aviso "llama-server no esta listo en $URL_LLAMA (cargando o sin nodos): bash deploy/mac/worker-mac.sh logs llama"
      fi
      local viejo_ifs="$IFS" nodo
      IFS=','
      for nodo in ${EST_NODOS:-}; do
        if nc -z -G 2 "${nodo%:*}" "${nodo##*:}" >/dev/null 2>&1; then ok "nodo $nodo alcanzable"; else aviso "nodo $nodo sin respuesta"; fi
      done
      IFS="$viejo_ifs"
      ;;
  esac
  if [ "${EST_ROL:-}" != "coordinador" ]; then
    if [ "${EST_OLLAMA_GESTIONADO:-1}" = 0 ]; then
      info "Ollama no lo maneja ADACEEN (app de Ollama u otro servicio en $URL_OLLAMA)"
    fi
    if ollama_responde; then
      local en_memoria
      en_memoria="$(curl -s -m 5 "$URL_OLLAMA/api/ps" 2>/dev/null | "${EST_NODE_BIN:-node}" -e 'let t="";process.stdin.on("data",c=>t+=c).on("end",()=>{try{const d=JSON.parse(t);console.log((d.models||[]).map(m=>`${m.name} (${Math.round((m.size_vram||m.size||0)/1e9)} GB)`).join(", ")||"ninguno")}catch{console.log("?")}})' 2>/dev/null || true)"
      [ -n "$en_memoria" ] || en_memoria="?"
      ok "Ollama responde en $URL_OLLAMA; modelos en memoria: $en_memoria"
    else
      aviso "Ollama no responde en $URL_OLLAMA"
    fi
  fi
  if { [ "${EST_ROL:-}" = "servidor" ] || [ "${EST_ROL:-}" = "coordinador" ]; } && [ -n "${EST_WORKER_ID:-}" ]; then
    local vivo
    vivo="$(curl -s -m 10 "${EST_BACKEND_URL:-$BACKEND_PRODUCCION}/api/agent/backend" 2>/dev/null |
      WID="$EST_WORKER_ID" "${EST_NODE_BIN:-node}" -e 'let t="";process.stdin.on("data",c=>t+=c).on("end",()=>{try{const d=JSON.parse(t);const w=(d.listening||[]).find(x=>x.id===process.env.WID);console.log(w?(w.alive?`vivo, ${w.jobsProcessed??0} trabajos, ultimo latido ${w.lastSeenAt}`:`sin latido desde ${w.lastSeenAt}`):"no aparece")}catch{console.log("sin respuesta")}})' 2>/dev/null || true)"
    [ -n "$vivo" ] || vivo="sin respuesta"
    case "$vivo" in
      vivo*) ok "Azure ve a $EST_WORKER_ID: $vivo" ;;
      *) aviso "Azure: $EST_WORKER_ID $vivo (la Mac no esta tomando trabajos o el latido no sale)" ;;
    esac
    if pmset -g assertions 2>/dev/null | grep -q caffeinate; then
      ok "la Mac no se dormira mientras el worker corra (caffeinate)"
    fi
  fi
  if [ "${EST_ROL:-}" = "local" ]; then
    if curl -s -m 3 "http://127.0.0.1:3000/health" 2>/dev/null | grep -q '"mode"'; then
      ok "backend local en http://127.0.0.1:3000"
    else
      aviso "el backend local no responde en http://127.0.0.1:3000"
    fi
  fi
}

case "$accion" in
  estado) estado ;;
  iniciar) iniciar ;;
  detener) detener ;;
  reiniciar)
    detener
    for etiqueta in $EST_SERVICIOS; do rotar_log "$(log_de "$etiqueta")"; done
    iniciar
    ;;
  logs)
    case "${EST_ROL:-}" in nodo) cual="${1:-nodo}" ;; *) cual="${1:-worker}" ;; esac
    case "$cual" in worker | ollama | local | llama | nodo) ;; *) fallar "logs de worker, ollama, local, llama o nodo" ;; esac
    [ -f "$DIR_LOGS/$cual.log" ] || fallar "no hay $DIR_LOGS/$cual.log"
    tail -n 80 -f "$DIR_LOGS/$cual.log"
    ;;
  desinstalar)
    # Los modelos se borran antes de apagar Ollama (el borrado lo hace el servidor).
    # Si Ollama no responde (servicio detenido, o la coordinadora, que solo lo usa
    # para bajar el modelo), se enciende uno temporal solo para borrar.
    if [ "${1:-}" = "--borrar-modelos" ] && [ -n "${EST_OLLAMA_BIN:-}" ] && [ -n "${EST_MODELO:-}${EST_MODELO_VISION:-}" ]; then
      pid_temporal=""
      if ! ollama_responde && [ -x "$EST_OLLAMA_BIN" ]; then
        (
          export OLLAMA_HOST="127.0.0.1:${EST_OLLAMA_PUERTO:-11434}"
          [ -n "${EST_CARPETA_MODELOS:-}" ] && export OLLAMA_MODELS="$EST_CARPETA_MODELOS"
          exec "$EST_OLLAMA_BIN" serve
        ) >/dev/null 2>&1 &
        pid_temporal=$!
        for _ in $(seq 1 20); do
          ollama_responde && break
          sleep 1
        done
      fi
      for modelo in ${EST_MODELO:-} ${EST_MODELO_VISION:-}; do
        if OLLAMA_HOST="127.0.0.1:${EST_OLLAMA_PUERTO:-11434}" "$EST_OLLAMA_BIN" rm "$modelo" >/dev/null 2>&1; then
          ok "modelo $modelo borrado"
        else
          aviso "no pude borrar $modelo (Ollama no responde); borralo luego con: ollama rm $modelo"
        fi
      done
      if [ -n "$pid_temporal" ]; then
        kill "$pid_temporal" >/dev/null 2>&1 || true
        wait "$pid_temporal" 2>/dev/null || true
      fi
    fi
    detener
    for etiqueta in $EST_SERVICIOS; do
      con_permisos "$MODO" launchctl enable "$DOMINIO/$etiqueta" >/dev/null 2>&1 || true
      con_permisos "$MODO" rm -f "$DIR_PLISTS/$etiqueta.plist"
    done
    # Secretos y estado; Node, Ollama y llama.cpp descargados en ~/.adaceen se quitan tambien.
    rm -f "$ARCHIVO_WORKER_ENV" "$ARCHIVO_ESTADO"
    rm -rf "$ADACEEN_HOME/node" "$ADACEEN_HOME/ollama" "$ADACEEN_HOME/llama.cpp" "$ADACEEN_HOME/cache-rpc"
    rmdir "$ADACEEN_HOME" 2>/dev/null || true
    ok "ADACEEN desinstalado de esta Mac (los logs quedan en $DIR_LOGS)"
    ;;
  velocidad)
    case "${EST_ROL:-}" in
      nodo) info "un nodo no atiende solo: mide la velocidad en la Mac coordinadora" ;;
      coordinador) NODE_BIN="${EST_NODE_BIN:-node}" MOTOR=llama URL_LLAMA="$URL_LLAMA" MODELO="${EST_MODELO:-}" bash "$DIR_SCRIPT/velocidad.sh" ;;
      *) NODE_BIN="${EST_NODE_BIN:-node}" URL_OLLAMA="$URL_OLLAMA" MODELO="${EST_MODELO:-qwen2.5-coder:14b}" bash "$DIR_SCRIPT/velocidad.sh" ;;
    esac
    ;;
  *) fallar "accion desconocida: $accion (estado, iniciar, detener, reiniciar, logs, velocidad, desinstalar)" ;;
esac
