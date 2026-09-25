#!/usr/bin/env bash
# Despliegue a produccion desde Google Cloud Shell, en el orden de
# docs/operacion/despliegue.md: variables del App Service, VM de editores y GPU.
#
#   bash deploy/produccion.sh [revisar]   solo lee, no cambia nada (accion por defecto):
#                                         herramientas, ~/PDC, variables de Azure (el
#                                         nombre y si estan vacias, nunca el valor),
#                                         huellas de los tokens, una sola instancia,
#                                         /api/health, VMs y la lista exacta de lo que
#                                         haria "aplicar"
#   bash deploy/produccion.sh aplicar [--sin-vm] [--sin-gpu] [--encender-vm]
#                                         hace esos cambios en orden; se puede repetir:
#                                         lo que ya esta hecho no se vuelve a hacer
#   bash deploy/produccion.sh verificar   las comprobaciones de las secciones 3 y 4.5
#                                         que no necesitan a un estudiante; resumen ✓/✗
#
#   --sin-vm       no toca la VM de editores (ni su metadata ni WORKSPACE_AGENT_TOKEN)
#   --sin-gpu      no toca las GPU
#   --encender-vm  si la VM de editores esta apagada, la enciende para que corra el
#                  arranque nuevo (sin esta opcion lo corre la proxima vez que se encienda)
#
# aplicar, en este orden (los pasos 1 a 11 de la guia): (1) comprueba todo
# antes de cambiar nada; (2) en UN solo cambio de Azure, las variables que
# faltan (ADACEEN_WORKSPACE_PROVIDER=tunnel, PUBLIC_BASE_URL,
# WORKSPACE_AGENT_TRANSPORT=relay si tenia otro valor, TELEMETRY_SALT solo si
# no existe, WORKER_HEARTBEAT_TOKEN copiado de una GPU si falta) y borra
# WORKSPACE_AGENT_URL si tiene valor; (3) espera a que /api/health muestre la
# version nueva (el push de la seccion 2); (4) vuelve a comprobar ~/PDC y az;
# (5) pide confirmacion antes de rotar el token (no lo hagas durante una
# clase); (6) guarda la rama y el startup-script de adaceen-ws y la rama de
# cada GPU en ~/adaceen-respaldo-<fecha>/; (7) pone en la metadata
# scan-worker-key si Azure tiene ADACEEN_SCAN_WORKER_KEY; (8) rota
# WORKSPACE_AGENT_TOKEN en Azure y en la metadata, con la rama y el
# startup-ws.sh nuevo, en una sola cadena; (9) corre el arranque por IAP;
# (10) espera workspace_agent_online; (11) actualizar-gpus.sh con la rama de
# produccion. Si az falla, corta antes de tocar la VM.
#
# Nunca muestra secretos: de los tokens solo imprime huellas (los 12 primeros
# caracteres del SHA-256, las mismas que dan los comandos del anexo de la guia).
#
# Variables (opcionales): RG (rg-adaceen-azure), APP (app-adaceen-api-eyder05232002),
# PROYECTO, VM_EDITORES (adaceen-ws), GPUS, BACKEND, ESPERA_MAX (segundos maximos
# de cada espera, 900), INTERVALO (segundos entre consultas, 10), CONFIRMAR=1
# (rota el token sin preguntar).
set -euo pipefail

DIR_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$DIR_SCRIPT/.." && pwd)"
# shellcheck source=deploy/gcp/comun-gcp.sh
. "$DIR_SCRIPT/gcp/comun-gcp.sh"

ayuda() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
}

ACCION=""
SIN_VM=0
SIN_GPU=0
ENCENDER_VM=0
for arg in "$@"; do
  case "$arg" in
    revisar | aplicar | verificar)
      [ -z "$ACCION" ] || fallar "una sola accion: revisar, aplicar o verificar"
      ACCION="$arg"
      ;;
    --sin-vm) SIN_VM=1 ;;
    --sin-gpu) SIN_GPU=1 ;;
    --encender-vm) ENCENDER_VM=1 ;;
    -h | --help | --ayuda) ayuda; exit 0 ;;
    *) fallar "opcion desconocida: $arg (acciones: revisar, aplicar, verificar; opciones: --sin-vm, --sin-gpu, --encender-vm)" ;;
  esac
done
ACCION=${ACCION:-revisar}

RAMA_PRODUCCION="feature/azure-config-observability"
FLUJO="https://github.com/eydersantiago/PDC/actions/workflows/feature-azure-config-observability_app-adaceen-api-eyder05232002.yml"
STARTUP_WS="$REPO/deploy/gcp/workspaces/startup-ws.sh"
STARTUP_GPU="$REPO/deploy/gcp/startup-script.sh"
MANIFEST="$REPO/browser-ext-prod/manifest.json"

RG=${RG:-rg-adaceen-azure}
APP=${APP:-app-adaceen-api-eyder05232002}
[[ $RG =~ ^[A-Za-z0-9._()-]{1,90}$ ]] || fallar "RG no es un nombre de grupo de recursos valido"
[[ $APP =~ ^[A-Za-z0-9-]{2,60}$ ]] || fallar "APP no es un nombre de App Service valido"
VM_EDITORES=${VM_EDITORES-$VM_EDITORES_POR_DEFECTO}
[ "$VM_EDITORES" = "ninguna" ] && VM_EDITORES=""
GPUS=${GPUS-$GPUS_POR_DEFECTO}
[ "$GPUS" = "ninguna" ] && GPUS=""
[ -n "$VM_EDITORES" ] || SIN_VM=1
[ -n "$GPUS" ] || SIN_GPU=1
BACKEND=${BACKEND:-$BACKEND_PRODUCCION}
BACKEND=${BACKEND%/}
[[ $BACKEND =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$ ]] || fallar "BACKEND no es una URL valida: $BACKEND"
ESPERA_MAX=${ESPERA_MAX:-900}
[[ $ESPERA_MAX =~ ^[0-9]+$ ]] || fallar "ESPERA_MAX debe ser un numero de segundos"
INTERVALO=${INTERVALO:-10}
[[ $INTERVALO =~ ^[0-9]+(\.[0-9]+)?$ ]] || fallar "INTERVALO debe ser un numero de segundos"
CONFIRMAR=${CONFIRMAR:-0}

# Carpeta privada: la lista de variables de Azure y la metadata de las VMs
# traen secretos; viven aqui (700) y se borran al salir.
PRIV="$(mktemp -d "${TMPDIR:-/tmp}/adaceen-produccion.XXXXXX")"
chmod 700 "$PRIV"
trap 'rm -rf "$PRIV"' EXIT

mal() { printf '[adaceen] ✗ %s\n' "$*"; }
titulo() { printf '\n[adaceen] == %s\n' "$*"; }
corto() { printf '%s' "${1:0:7}"; }
ruta_repo() { printf '%s' "${REPO/#"$HOME"/\~}"; }

# ---------------------------------------------------------------- lecturas (python3)
# Todo lo que toca valores secretos pasa por aqui y sale como huella o como
# si/no. Huella = 12 primeros caracteres del SHA-256 de "valor\n", lo mismo que
# `gcloud ... --format="value(...)" | sha256sum | cut -c1-12` y
# `az ... -o tsv | sha256sum | cut -c1-12` del anexo de la guia.
PY=$(
  cat <<'FIN'
import hashlib, json, os, re, sys
from urllib.parse import urlsplit

def huella(valor):
    return hashlib.sha256((valor + "\n").encode("utf-8")).hexdigest()[:12] if valor.strip() else ""

def si(condicion):
    return "si" if condicion else "no"

def limpio(valor, largo=120):
    return re.sub(r"[^A-Za-z0-9._/:@-]", "", str(valor))[:largo]

def leer_json(ruta):
    try:
        if ruta == "-":
            return json.load(sys.stdin)
        with open(ruta, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None

def metadata(ruta):
    d = leer_json(ruta)
    if not isinstance(d, dict):
        sys.exit(1)
    items = (d.get("metadata") or {}).get("items") or []
    return {str(i.get("key")): str(i.get("value") or "") for i in items if isinstance(i, dict)}

def ajustes(ruta):
    d = leer_json(ruta)
    if not isinstance(d, list):
        sys.exit(1)
    return {str(i.get("name")): str(i.get("value") or "") for i in d if isinstance(i, dict) and i.get("name")}

def igual_a_archivo(valor, ruta):
    try:
        with open(ruta, encoding="utf-8") as f:
            return valor.rstrip() == f.read().rstrip()
    except OSError:
        return False

def escribir_privado(ruta, valor):
    fd = os.open(ruta, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(valor)

# isOriginAllowed de src/config/env.ts.
def origen_permitido(origen, lista):
    p = urlsplit(origen)
    host = (p.hostname or "").lower()
    host_puerto = p.netloc.lower()
    for crudo in lista:
        x = crudo.strip().lower()
        if not x:
            continue
        if x == "*":
            return True
        if "://" in x:
            q = urlsplit(x)
            if q.scheme == p.scheme and q.netloc.lower() == host_puerto:
                return True
            continue
        if x.startswith("*."):
            if host == x[2:] or host.endswith("." + x[2:]):
                return True
            continue
        if ":" in x:
            if host_puerto == x:
                return True
            continue
        if host == x or f"{p.scheme}://{host_puerto}" == f"{p.scheme}://{x}":
            return True
    return False

def origenes_del_overlay(manifest):
    d = leer_json(manifest) or {}
    salida = []
    for bloque in d.get("content_scripts") or []:
        for patron in bloque.get("matches") or []:
            m = re.match(r"^(https?)://([^/]+)/", str(patron))
            if m and f"{m.group(1)}://{m.group(2)}" not in salida:
                salida.append(f"{m.group(1)}://{m.group(2)}")
    return salida

# Un patron *.dominio del manifest queda cubierto por "*" o por un *.dominio igual o mas amplio.
def cubierto(origen, lista):
    host = origen.split("://", 1)[1]
    if not host.startswith("*."):
        return origen_permitido(origen, lista)
    sufijo = host[2:].lower()
    for crudo in lista:
        x = crudo.strip().lower()
        if x == "*" or (x.startswith("*.") and (sufijo == x[2:] or sufijo.endswith("." + x[2:]))):
            return True
    return False

NOMBRES = [
    "ADACEEN_WORKSPACE_PROVIDER", "PUBLIC_BASE_URL", "WORKSPACE_AGENT_URL", "WORKSPACE_AGENT_TRANSPORT",
    "WORKSPACE_AGENT_TOKEN", "TELEMETRY_SALT", "WORKER_HEARTBEAT_TOKEN", "AGENT_TARGET",
    "ADACEEN_SCAN_WORKER_KEY", "ALLOWED_ORIGINS", "WORKSPACE_ALLOWED_LOGINS", "EDITOR_SESSION_TTL_DAYS",
    "WORKSPACE_VM_AUTOSTART", "WORKSPACE_VM_PROJECT", "WORKSPACE_VM_ZONE", "WORKSPACE_VM_NAME",
    "GCP_SERVICE_ACCOUNT_JSON",
]

orden = sys.argv[1]
if orden == "vm":
    # vm <describe.json> <startup-script local>
    m = metadata(sys.argv[2])
    arranque = m.get("startup-script", "")
    print("rama=" + limpio(m.get("branch", "").strip()))
    print("startup=" + ("ausente" if not arranque.strip() else "nuevo" if igual_a_archivo(arranque, sys.argv[3]) else "otro"))
    print("token=" + huella(m.get("workspace-agent-token", "")))
    print("scan=" + huella(m.get("scan-worker-key", "")))
    print("latido=" + huella(m.get("heartbeat-token", "")))
    print("latido_url=" + si(m.get("heartbeat-url", "").strip()))
    print("worker_id=" + limpio(m.get("worker-id", "").strip(), 60))
    print("worker_secret=" + si(m.get("worker-secret", "").strip()))
elif orden == "meta-a-archivo":
    # meta-a-archivo <describe.json> <clave> <destino>: el valor, a un archivo 600
    valor = metadata(sys.argv[2]).get(sys.argv[3], "")
    if not valor.strip():
        sys.exit(1)
    escribir_privado(sys.argv[4], valor)
elif orden == "azure":
    # azure <appsettings.json> <backend> <manifest>
    a = ajustes(sys.argv[2])
    backend = sys.argv[3].rstrip("/")
    val = lambda n: a.get(n, "").strip()
    for n in NOMBRES:
        print(f"var.{n}=" + ("ausente" if n not in a else "valor" if val(n) else "vacia"))
    print("proveedor_ok=" + si(val("ADACEEN_WORKSPACE_PROVIDER").lower() == "tunnel"))
    print("url_publica_ok=" + si(val("PUBLIC_BASE_URL").rstrip("/") == backend))
    print("agente_url=" + si(val("WORKSPACE_AGENT_URL")))
    print("transporte_ok=" + si(val("WORKSPACE_AGENT_TRANSPORT").lower() in ("", "relay")))
    print("cola_ok=" + si(val("AGENT_TARGET").lower() == "queue"))
    print("sal=" + si(val("TELEMETRY_SALT")))
    print("latido=" + huella(a.get("WORKER_HEARTBEAT_TOKEN", "")))
    print("token=" + huella(a.get("WORKSPACE_AGENT_TOKEN", "")))
    print("scan=" + huella(a.get("ADACEEN_SCAN_WORKER_KEY", "")))
    origenes = [o for o in val("ALLOWED_ORIGINS").split(",") if o.strip()]
    if not origenes:
        print("origenes=todos")
    else:
        # El content script de /empezar corre en el propio backend: ahi no hay CORS.
        propio = "{0.scheme}://{0.netloc}".format(urlsplit(backend)).lower()
        faltan = [o for o in origenes_del_overlay(sys.argv[4]) if o.lower() != propio and not cubierto(o, origenes)]
        print("origenes=" + ("cubre" if not faltan else "faltan:" + " ".join(re.sub(r"[^A-Za-z0-9.:/*-]", "", o) for o in faltan)))
    logins = [l.strip() for l in val("WORKSPACE_ALLOWED_LOGINS").split(",") if l.strip()]
    print("logins=" + ("abierta" if not logins or "*" in logins else f"lista:{len(logins)}"))
    print("autoencendido=" + str(sum(1 for n in NOMBRES if n.startswith(("WORKSPACE_VM_", "GCP_SERVICE")) and val(n))))
elif orden == "nombres":
    # nombres <appsettings.json>: todas las variables, sin valores
    for n, v in sorted(ajustes(sys.argv[2]).items()):
        print(f"{n} {'con valor' if v.strip() else 'vacia'}")
elif orden == "azure-a-archivo":
    # azure-a-archivo <appsettings.json> <NOMBRE> <destino>
    valor = ajustes(sys.argv[2]).get(sys.argv[3], "").strip()
    if not valor:
        sys.exit(1)
    escribir_privado(sys.argv[4], valor)
elif orden == "salud":
    # salud <health.json>: campos de /api/health, sin valores raros
    d = leer_json(sys.argv[2])
    if not isinstance(d, dict):
        sys.exit(1)
    print("responde=si")
    # workspace_vm_autostart solo existe desde 5d94351 (acceso simplificado).
    print("nueva=" + si("workspace_vm_autostart" in d))
    for clave in ("ok", "mode", "queue_configured", "database_provider", "telemetry_salt_configured",
                  "worker_heartbeat_configured", "workspace_provider", "workspace_agent_transport",
                  "workspace_agent_online", "workspace_vm_autostart", "model_workers_alive",
                  "model_workers_known_down"):
        x = d.get(clave)
        print(f"{clave}=" + (si(x) if isinstance(x, bool) else "" if x is None else limpio(x, 40)))
elif orden == "empezar":
    # empezar <html>: lo que se comprueba de /empezar
    with open(sys.argv[2], encoding="utf-8", errors="replace") as f:
        html = f.read()
    print("titulo=" + si("Empieza con ADACEEN" in html))
    m = re.search(r'data-browser-ext-latest="([0-9.]*)"', html)
    print("navegador=" + (m.group(1) if m else ""))
    m = re.search(r"VSIX, version ([0-9.]+)", html)
    print("vscode=" + (m.group(1) if m else ""))
    print("sin_publicar=" + str(html.count("todavia no esta publicado en este servidor")))
elif orden == "version":
    # version <package.json|manifest.json|->
    d = leer_json(sys.argv[2])
    v = d.get("version") if isinstance(d, dict) else None
    if not isinstance(v, str) or not re.match(r"^\d+(\.\d+){0,3}$", v):
        sys.exit(1)
    print(v)
elif orden == "ocultar":
    # ocultar <carpeta privada>: el texto de stdin sin ningun secreto conocido
    texto = sys.stdin.read()
    secretos = set()
    carpeta = sys.argv[2]
    for nombre in os.listdir(carpeta):
        ruta = os.path.join(carpeta, nombre)
        if nombre.startswith("secreto-"):
            with open(ruta, encoding="utf-8", errors="replace") as f:
                secretos.add(f.read().strip())
        elif nombre.endswith(".json"):
            d = leer_json(ruta)
            if isinstance(d, list):
                secretos.update(str(i.get("value") or "") for i in d if isinstance(i, dict))
            elif isinstance(d, dict):
                secretos.update(str(i.get("value") or "") for i in ((d.get("metadata") or {}).get("items") or [])
                                if isinstance(i, dict) and i.get("key") != "startup-script")
    for s in sorted((s for s in secretos if len(s) >= 8), key=len, reverse=True):
        texto = texto.replace(s, "***")
    sys.stdout.write(texto)
FIN
)
py() { python3 -c "$PY" "$@"; }

# Error de az o gcloud, corto y sin secretos (por si la herramienta repite sus argumentos).
error_limpio() {
  py ocultar "$PRIV" <"$1" >"$PRIV/err-limpio" 2>/dev/null || : >"$PRIV/err-limpio"
  resumir_error "$PRIV/err-limpio" || true
}

# ---------------------------------------------------------------- herramientas
herramientas() {
  requiere_gcloud
  local falta="" h
  for h in curl python3 git sha256sum "$@"; do
    command -v "$h" >/dev/null 2>&1 || falta="$falta $h"
  done
  [ -z "$falta" ] || fallar "falta:$falta (Cloud Shell de Google los trae)"
  PROYECTO=$(resolver_proyecto)
}

AZ_ESTADO=""
comprobar_az() {
  if ! command -v az >/dev/null 2>&1; then
    AZ_ESTADO=sin-az
    return 1
  fi
  if ! az account show --output none >/dev/null 2>&1; then
    AZ_ESTADO=sin-login
    return 1
  fi
  AZ_ESTADO=listo
}

explicar_az() {
  case "$AZ_ESTADO" in
    sin-az)
      aviso "falta la CLI de Azure (az): Cloud Shell de Google no la trae. Instalala en esta sesion (se pierde si la sesion se reinicia) y entra:"
      aviso "    curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash"
      aviso "    az login --use-device-code"
      ;;
    sin-login)
      aviso "az no tiene la sesion iniciada (o se vencio): az login --use-device-code"
      ;;
  esac
  return 0
}

encabezado() {
  info "proyecto $PROYECTO | App Service $APP ($RG) | backend $BACKEND"
  if [ "$PROYECTO" != "$PROYECTO_POR_DEFECTO" ]; then
    aviso "el proyecto de gcloud es $PROYECTO; el del piloto es $PROYECTO_POR_DEFECTO (PROYECTO=$PROYECTO_POR_DEFECTO bash deploy/produccion.sh $ACCION)"
  fi
  return 0
}

# ---------------------------------------------------------------- ~/PDC
# REPO_ESTADO: desplegado (HEAD = feature/azure-config-observability en GitHub),
# push-pendiente (GitHub esta detras de HEAD: el push sera fast-forward),
# distinto, sin-remoto o sin-git.
REPO_LOCAL=""
REPO_RAMA=""
REPO_REMOTO=""
REPO_ESTADO=""
REPO_CAMBIOS=""
REMOTO_AL_EMPEZAR=""
leer_repo() {
  REPO_LOCAL=""; REPO_RAMA=""; REPO_REMOTO=""; REPO_ESTADO="sin-git"; REPO_CAMBIOS=""
  REPO_LOCAL="$(git -C "$REPO" rev-parse HEAD 2>/dev/null)" || { REPO_LOCAL=""; return 0; }
  REPO_RAMA="$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  REPO_CAMBIOS="$(git -C "$REPO" status --porcelain -- deploy/gcp/workspaces/startup-ws.sh deploy/gcp/startup-script.sh 2>/dev/null || true)"
  REPO_REMOTO="$(git -C "$REPO" ls-remote origin "refs/heads/$RAMA_PRODUCCION" 2>/dev/null | awk 'NR == 1 { print $1 }')" || REPO_REMOTO=""
  if [ -z "$REPO_REMOTO" ]; then
    REPO_ESTADO="sin-remoto"
  elif [ "$REPO_REMOTO" = "$REPO_LOCAL" ]; then
    REPO_ESTADO="desplegado"
  elif git -C "$REPO" merge-base --is-ancestor "$REPO_REMOTO" "$REPO_LOCAL" 2>/dev/null; then
    REPO_ESTADO="push-pendiente"
  else
    REPO_ESTADO="distinto"
  fi
  [ -n "$REMOTO_AL_EMPEZAR" ] || REMOTO_AL_EMPEZAR="$REPO_REMOTO"
}

comando_push() {
  case "$REPO_RAMA" in
    "" | HEAD | "$RAMA_PRODUCCION") printf 'git push origin <tu rama>:%s' "$RAMA_PRODUCCION" ;;
    *) printf 'git push origin %s:%s' "$REPO_RAMA" "$RAMA_PRODUCCION" ;;
  esac
}

explicar_repo() {
  case "$REPO_ESTADO" in
    desplegado)
      ok "$(ruta_repo) en $(corto "$REPO_LOCAL") ($REPO_RAMA): es lo desplegado en $RAMA_PRODUCCION"
      ;;
    push-pendiente)
      info "$(ruta_repo) en $(corto "$REPO_LOCAL") ($REPO_RAMA); $RAMA_PRODUCCION en GitHub sigue en $(corto "$REPO_REMOTO"), que es ancestro: el push sera fast-forward"
      info "falta el push (seccion 2, en PowerShell): $(comando_push)"
      ;;
    distinto)
      aviso "$(ruta_repo) en $(corto "$REPO_LOCAL") no es lo desplegado en $RAMA_PRODUCCION ($(corto "$REPO_REMOTO")) ni lo contiene. Ponlo al dia:"
      aviso "    cd ~/PDC && git fetch origin && git checkout $RAMA_PRODUCCION && git pull --ff-only"
      ;;
    sin-remoto)
      aviso "no pude leer $RAMA_PRODUCCION en GitHub (git ls-remote origin): ¿$(ruta_repo) es un clon de eydersantiago/PDC?"
      ;;
    sin-git)
      aviso "$(ruta_repo) no es un clon de git: cd ~ && git clone https://github.com/eydersantiago/PDC.git"
      ;;
  esac
  if [ -n "$REPO_CAMBIOS" ]; then
    aviso "cambios locales en los scripts de arranque (se subirian a la metadata): git -C ~/PDC checkout -- deploy/gcp/workspaces/startup-ws.sh deploy/gcp/startup-script.sh"
  fi
  return 0
}

exigir_repo_desplegado() {
  leer_repo
  if [ "$REPO_ESTADO" != "desplegado" ] || [ -n "$REPO_CAMBIOS" ]; then
    explicar_repo
    fallar "los scripts de arranque que se suben salen de $(ruta_repo): tiene que estar en el commit desplegado de $RAMA_PRODUCCION y sin cambios. Arreglalo y vuelve a correr: bash deploy/produccion.sh $ACCION"
  fi
}

# ---------------------------------------------------------------- Azure
declare -A AZ=()
AZ_LEIDO=0
AZ_ERROR=""
leer_azure() {
  AZ=()
  AZ_LEIDO=0
  AZ_ERROR=""
  if [ "$AZ_ESTADO" != "listo" ]; then
    AZ_ERROR="az no esta listo"
    return 1
  fi
  if ! az webapp config appsettings list --resource-group "$RG" --name "$APP" --output json >"$PRIV/azure.json" 2>"$PRIV/err"; then
    AZ_ERROR="$(error_limpio "$PRIV/err")"
    return 1
  fi
  local k v
  while IFS='=' read -r k v; do
    if [ -n "$k" ]; then AZ["$k"]="$v"; fi
  done < <(py azure "$PRIV/azure.json" "$BACKEND" "$MANIFEST" 2>/dev/null)
  if [ -z "${AZ[sal]:-}" ]; then
    AZ_ERROR="la respuesta de az no es la lista de variables del App Service"
    return 1
  fi
  AZ_LEIDO=1
}

INSTANCIAS_APP=""
leer_capacidad() {
  local plan
  INSTANCIAS_APP=""
  plan="$(az webapp show --resource-group "$RG" --name "$APP" --query appServicePlanId --output tsv 2>/dev/null)" || return 1
  [ -n "$plan" ] || return 1
  INSTANCIAS_APP="$(az appservice plan show --ids "$plan" --query sku.capacity --output tsv 2>/dev/null | tr -d '[:space:]')" || return 1
  [[ $INSTANCIAS_APP =~ ^[0-9]+$ ]]
}

# ---------------------------------------------------------------- VMs
# M[<vm>.<dato>]: leida, rama, startup (nuevo|otro|ausente), token, scan,
# latido (huellas), latido_url, worker_id, worker_secret.
declare -A M=()
leer_vm() {
  local vm="$1" zona startup="$STARTUP_GPU" k v
  if [ "$vm" = "$VM_EDITORES" ]; then startup="$STARTUP_WS"; fi
  M["$vm.leida"]=no
  zona="$(zona_de "$vm")"
  [ -n "$zona" ] || return 1
  if ! gcloud compute instances describe "$vm" --zone="$zona" --project="$PROYECTO" --format=json >"$PRIV/$vm.json" 2>"$PRIV/err"; then
    aviso "no pude leer la metadata de $vm: $(error_limpio "$PRIV/err")"
    return 1
  fi
  while IFS='=' read -r k v; do
    if [ -n "$k" ]; then M["$vm.$k"]="$v"; fi
  done < <(py vm "$PRIV/$vm.json" "$startup" 2>/dev/null)
  if [ -z "${M[$vm.startup]:-}" ]; then
    aviso "la descripcion de $vm no tiene el formato esperado"
    return 1
  fi
  M["$vm.leida"]=si
}

leer_vms() {
  local vm
  for vm in $VM_EDITORES $GPUS; do
    leer_vm "$vm" || true
  done
}

# Primera GPU (en el orden de GPUS) con heartbeat-url y heartbeat-token: la misma
# que elige actualizar-gpus.sh para copiar el latido a las GPU que no lo tienen.
gpu_con_latido() {
  local vm
  for vm in $GPUS; do
    if [ -n "${M[$vm.latido]:-}" ] && [ "${M[$vm.latido_url]:-}" = "si" ]; then
      printf '%s' "$vm"
      return 0
    fi
  done
  return 0
}

# Huella con la que tiene que coincidir el heartbeat-token de cada GPU: la de
# WORKER_HEARTBEAT_TOKEN en Azure si tiene valor; si no, la de la GPU que aplicar
# copia a Azure.
latido_de_referencia() {
  local donante
  if [ "$AZ_LEIDO" = 1 ] && [ -n "${AZ[latido]:-}" ]; then
    printf '%s' "${AZ[latido]}"
    return 0
  fi
  donante="$(gpu_con_latido)"
  if [ -n "$donante" ]; then printf '%s' "${M[$donante.latido]}"; fi
  return 0
}

# GPU con un heartbeat-token distinto de la referencia: su latido no se veria.
gpus_con_otro_latido() {
  local vm ref salida=""
  ref="$(latido_de_referencia)"
  [ -n "$ref" ] || return 0
  for vm in $GPUS; do
    [ "${M[$vm.leida]:-no}" = "si" ] || continue
    if [ -n "${M[$vm.latido]:-}" ] && [ "${M[$vm.latido]}" != "$ref" ]; then salida="${salida:+$salida }$vm"; fi
  done
  printf '%s' "$salida"
}

# Aviso para las GPU de gpus_con_otro_latido (vacio si no hay ninguna).
aviso_otro_latido() {
  local gpus="$1" referencia
  [ -n "$gpus" ] || return 0
  if [ "$AZ_LEIDO" = 1 ] && [ -n "${AZ[latido]:-}" ]; then
    referencia="a WORKER_HEARTBEAT_TOKEN de Azure"
  else
    referencia="al de $(gpu_con_latido), que aplicar copia a Azure"
  fi
  printf 'el heartbeat-token de %s no es igual %s: aplicar no lo cambia y esa GPU no se veria (runbook, seccion 5)' "${gpus// /, }" "$referencia"
}

# ---------------------------------------------------------------- /api/health
declare -A S=()
leer_salud() {
  local k v
  S=()
  S[responde]=no
  curl -fsS -m 15 "$BACKEND/api/health" >"$PRIV/salud.json" 2>/dev/null || return 1
  while IFS='=' read -r k v; do
    if [ -n "$k" ]; then S["$k"]="$v"; fi
  done < <(py salud "$PRIV/salud.json" 2>/dev/null)
  [ "${S[responde]}" = "si" ]
}

version_lista() {
  [ "${S[nueva]:-}" = "si" ] && [ "${S[workspace_provider]:-}" = "tunnel" ] && [ "${S[workspace_agent_transport]:-}" = "relay" ]
}

texto_salud() {
  if [ "${S[responde]:-no}" != "si" ]; then
    printf 'sin respuesta de %s/api/health' "$BACKEND"
  elif [ "${S[nueva]:-}" != "si" ]; then
    printf 'version anterior (sin workspace_vm_autostart)'
  else
    printf 'version nueva, workspace_provider=%s, workspace_agent_transport=%s, workspace_agent_online=%s' \
      "${S[workspace_provider]:-?}" "${S[workspace_agent_transport]:-?}" "${S[workspace_agent_online]:-?}"
  fi
}

# ---------------------------------------------------------------- plan
# Lo que haria (o hace) aplicar, calculado de lo leido. Solo nombres y huellas.
P_AJUSTES=()
P_PROVEEDOR=0; P_URL_PUBLICA=0; P_TRANSPORTE=0; P_SAL=0; P_LATIDO_DE=""; P_BORRAR_URL=0
P_SCAN=0; P_ROTAR=0; P_RAMA_WS=0; P_ARRANQUE=""; P_GPU=0; P_GPU_MOTIVOS=""; P_OTRO_LATIDO=""
planear() {
  local vm estado motivo donante
  P_AJUSTES=()
  P_PROVEEDOR=0; P_URL_PUBLICA=0; P_TRANSPORTE=0; P_SAL=0; P_LATIDO_DE=""; P_BORRAR_URL=0
  P_SCAN=0; P_ROTAR=0; P_RAMA_WS=0; P_ARRANQUE=""; P_GPU=0; P_GPU_MOTIVOS=""; P_OTRO_LATIDO=""
  donante="$(gpu_con_latido)"

  if [ "$AZ_LEIDO" = 1 ]; then
    if [ "${AZ[proveedor_ok]}" != "si" ]; then P_PROVEEDOR=1; P_AJUSTES+=("ADACEEN_WORKSPACE_PROVIDER=tunnel"); fi
    if [ "${AZ[url_publica_ok]}" != "si" ]; then P_URL_PUBLICA=1; P_AJUSTES+=("PUBLIC_BASE_URL=$BACKEND"); fi
    if [ "${AZ[transporte_ok]}" != "si" ]; then P_TRANSPORTE=1; P_AJUSTES+=("WORKSPACE_AGENT_TRANSPORT=relay"); fi
    if [ "${AZ[sal]}" != "si" ]; then P_SAL=1; P_AJUSTES+=("TELEMETRY_SALT (nuevo, al azar; no existia)"); fi
    if [ -z "${AZ[latido]}" ] && [ -n "$donante" ]; then
      P_LATIDO_DE="$donante"
      P_AJUSTES+=("WORKER_HEARTBEAT_TOKEN (copiado de la metadata de $donante)")
    fi
    if [ "${AZ[agente_url]}" = "si" ]; then P_BORRAR_URL=1; fi
  fi

  if [ "$SIN_VM" = 0 ] && [ "${M[$VM_EDITORES.leida]:-no}" = "si" ]; then
    if [ "$AZ_LEIDO" = 1 ] && [ -n "${AZ[scan]}" ] && [ "${AZ[scan]}" != "${M[$VM_EDITORES.scan]:-}" ]; then
      P_SCAN=1
    fi
    if [ "${M[$VM_EDITORES.startup]}" != "nuevo" ] || [ -z "${M[$VM_EDITORES.token]}" ] ||
      { [ "$AZ_LEIDO" = 1 ] && [ "${AZ[token]}" != "${M[$VM_EDITORES.token]}" ]; }; then
      P_ROTAR=1
    elif [ "${M[$VM_EDITORES.rama]}" != "$RAMA_PRODUCCION" ]; then
      P_RAMA_WS=1
    fi
    if [ "$P_ROTAR$P_RAMA_WS$P_SCAN" != "000" ] || [ "${S[workspace_agent_online]:-}" != "si" ]; then
      estado="$(estado_de "$VM_EDITORES")"
      case "$estado" in
        RUNNING) P_ARRANQUE="iap" ;;
        TERMINATED | STOPPED | SUSPENDED)
          if [ "$ENCENDER_VM" = 1 ]; then P_ARRANQUE="encender"; else P_ARRANQUE="apagada"; fi
          ;;
        *) P_ARRANQUE="otro" ;;
      esac
    fi
  fi

  if [ "$SIN_GPU" = 0 ]; then
    P_OTRO_LATIDO="$(gpus_con_otro_latido)"
    for vm in $GPUS; do
      [ "${M[$vm.leida]:-no}" = "si" ] || continue
      motivo=""
      [ "${M[$vm.startup]}" = "nuevo" ] || motivo="startup-script anterior"
      [ "${M[$vm.rama]}" = "$RAMA_PRODUCCION" ] || motivo="${motivo:+$motivo, }rama ${M[$vm.rama]:-sin metadata branch}"
      if [ -z "${M[$vm.latido]}" ] && [ -n "$donante" ]; then motivo="${motivo:+$motivo, }sin latido"; fi
      if [ -n "$motivo" ]; then
        P_GPU=1
        P_GPU_MOTIVOS="${P_GPU_MOTIVOS:+$P_GPU_MOTIVOS; }$vm: $motivo"
      fi
    done
  fi
  return 0
}

mostrar_plan() {
  local n=0 estado
  linea() { n=$((n + 1)); printf '    %d. %s\n' "$n" "$*"; }
  info "\"aplicar\" haria, en este orden:"
  if [ "$AZ_LEIDO" != 1 ]; then
    linea "Azure: no se puede saber sin az (ver arriba)"
  else
    if [ "${#P_AJUSTES[@]}" -gt 0 ]; then
      linea "Azure, un solo appsettings set (--output none, un reinicio de ~1 min): $(printf '%s, ' "${P_AJUSTES[@]}" | sed 's/, $//')"
    fi
    if [ "$P_BORRAR_URL" = 1 ]; then linea "Azure: borrar WORKSPACE_AGENT_URL (tiene valor: el transporte seria direct)"; fi
  fi
  if [ "$SIN_VM" = 0 ] || [ "$SIN_GPU" = 0 ]; then
    if version_lista; then
      linea "/api/health ya muestra la version nueva con el proveedor tunnel: no espera"
    else
      linea "esperar (hasta $ESPERA_MAX s) a que /api/health muestre la version nueva con tunnel y relay; ahora: $(texto_salud)"
    fi
  fi
  if [ "$P_ROTAR$P_RAMA_WS$P_SCAN$P_GPU" != "0000" ]; then
    linea "guardar para volver atras la rama y el startup-script de $VM_EDITORES y la rama de cada GPU en ~/adaceen-respaldo-<fecha>/"
  fi
  if [ "$SIN_VM" = 1 ]; then
    linea "VM de editores: nada (--sin-vm o VM_EDITORES=ninguna)"
  elif [ "${M[$VM_EDITORES.leida]:-no}" != "si" ]; then
    linea "VM de editores: no encuentro $VM_EDITORES en $PROYECTO"
  else
    if [ "$P_SCAN" = 1 ]; then linea "$VM_EDITORES: metadata scan-worker-key = ADACEEN_SCAN_WORKER_KEY de Azure"; fi
    if [ "$P_ROTAR" = 1 ]; then
      linea "$VM_EDITORES: pedir confirmacion y, en una cadena, WORKSPACE_AGENT_TOKEN nuevo en Azure y en la metadata con branch=$RAMA_PRODUCCION y el startup-ws.sh de $(ruta_repo)"
    elif [ "$P_RAMA_WS" = 1 ]; then
      linea "$VM_EDITORES: metadata branch=$RAMA_PRODUCCION (el token y el startup-ws.sh ya estan al dia)"
    fi
    estado="$(estado_de "$VM_EDITORES")"
    case "$P_ARRANQUE" in
      iap) linea "$VM_EDITORES ($estado): correr el arranque por IAP y esperar workspace_agent_online" ;;
      encender) linea "$VM_EDITORES ($estado): encenderla (--encender-vm); el arranque corre solo; esperar workspace_agent_online" ;;
      apagada) linea "$VM_EDITORES ($estado): nada mas; el arranque nuevo corre al encenderla (o usa --encender-vm)" ;;
      otro) linea "$VM_EDITORES ($estado): nada mas; vuelve a correr aplicar cuando termine de cambiar de estado" ;;
    esac
    if [ "$P_ROTAR$P_RAMA_WS$P_SCAN" = "000" ] && [ -z "$P_ARRANQUE" ]; then
      linea "$VM_EDITORES: nada (rama, startup-ws.sh y token al dia; agente conectado)"
    fi
  fi
  if [ "$SIN_GPU" = 1 ]; then
    linea "GPU: nada (--sin-gpu o GPUS=ninguna)"
  elif [ "$P_GPU" = 1 ]; then
    linea "GPU: RAMA=$RAMA_PRODUCCION bash deploy/gcp/actualizar-gpus.sh ($P_GPU_MOTIVOS); no enciende nada"
  else
    linea "GPU: nada (startup-script, rama y latido al dia)"
  fi
  if [ -n "$P_OTRO_LATIDO" ]; then mal "$(aviso_otro_latido "$P_OTRO_LATIDO")"; fi
  unset -f linea
}

# ---------------------------------------------------------------- respaldo
RESPALDO=""
asegurar_respaldo() {
  [ -z "$RESPALDO" ] || return 0
  local vm zona rama
  RESPALDO="$HOME/adaceen-respaldo-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$RESPALDO"
  chmod 700 "$RESPALDO"
  {
    printf 'Respaldo de bash deploy/produccion.sh aplicar, %s. Guia: docs/operacion/despliegue.md, seccion 8.\n' "$(date -Is)"
    printf 'Commit de %s en GitHub al empezar: %s\n\n' "$RAMA_PRODUCCION" "${REMOTO_AL_EMPEZAR:-?}"
  } >"$RESPALDO/volver-atras.txt"

  if [ -n "$VM_EDITORES" ] && [ "${M[$VM_EDITORES.leida]:-no}" = "si" ]; then
    zona="$(zona_de "$VM_EDITORES")"
    rama="${M[$VM_EDITORES.rama]}"
    printf 'vm=%s\nzona=%s\nestado=%s\nrama=%s\n' "$VM_EDITORES" "$zona" "$(estado_de "$VM_EDITORES")" "$rama" >"$RESPALDO/$VM_EDITORES.txt"
    if [ "${M[$VM_EDITORES.startup]}" = "nuevo" ]; then
      printf 'VM de editores: ya tenia el startup-ws.sh nuevo (respaldo anterior: ls -d ~/adaceen-respaldo-*).\n' >>"$RESPALDO/volver-atras.txt"
    elif py meta-a-archivo "$PRIV/$VM_EDITORES.json" startup-script "$RESPALDO/startup-ws-anterior.sh" 2>/dev/null; then
      {
        printf 'VM de editores (%s, %s), rama anterior: %s\n' "$VM_EDITORES" "$zona" "${rama:-vacia}"
        if [ -n "$rama" ]; then
          printf '  gcloud compute instances add-metadata %s --zone=%s --metadata=branch=%s --metadata-from-file=startup-script=%s/startup-ws-anterior.sh\n' "$VM_EDITORES" "$zona" "$rama" "$RESPALDO"
        else
          printf '  gcloud compute instances add-metadata %s --zone=%s --metadata-from-file=startup-script=%s/startup-ws-anterior.sh\n' "$VM_EDITORES" "$zona" "$RESPALDO"
          printf '  gcloud compute instances remove-metadata %s --zone=%s --keys=branch\n' "$VM_EDITORES" "$zona"
        fi
        printf '  y luego correr el arranque (anexo, seccion 4.4).\n'
      } >>"$RESPALDO/volver-atras.txt"
    else
      printf 'VM de editores: no tenia startup-script en la metadata.\n' >>"$RESPALDO/volver-atras.txt"
    fi
  fi

  : >"$RESPALDO/gpus.txt"
  for vm in $GPUS; do
    [ "${M[$vm.leida]:-no}" = "si" ] || continue
    printf '%s %s worker-id=%s rama=%s\n' "$vm" "$(zona_de "$vm")" "${M[$vm.worker_id]:--}" "${M[$vm.rama]:--}" >>"$RESPALDO/gpus.txt"
  done
  {
    printf '\nGPU (vm zona worker-id rama), para volver: RAMA=<rama anotada> bash deploy/gcp/actualizar-gpus.sh\n'
    sed 's/^/  /' "$RESPALDO/gpus.txt"
  } >>"$RESPALDO/volver-atras.txt"
  if [ -f "$PRIV/azure.json" ]; then
    py nombres "$PRIV/azure.json" >"$RESPALDO/azure-variables.txt" 2>/dev/null || true
  fi
  ok "respaldo para volver atras en ${RESPALDO/#"$HOME"/\~}/ (volver-atras.txt tiene los comandos)"
}

# ---------------------------------------------------------------- IAP
# Lo que corre en la VM de editores. Del log del arranque, solo el ultimo
# arranque y solo sus lineas --- y === (no tienen secretos).
# shellcheck disable=SC2016
REMOTO_LOG='sudo tac /var/log/adaceen-ws-startup.log 2>/dev/null | sed "/^=== adaceen-ws startup /q" | tac | grep -E "^(---|===)" | tail -n 40 | sed "s/^/log=/"'
REMOTO_ARRANQUE="sudo google_metadata_script_runner startup >/dev/null 2>&1; $REMOTO_LOG"
# relay=: el ultimo de los tres eventos del relay que registra relay.mjs.
# bloqueo=: el codigo de salida de curl como el usuario nobody (7 = conexion
# rechazada, lo que hace la regla REJECT de adaceen-ws-metadata; 0 = la lee) o
# sin-prueba si no hay usuario nobody o curl.
# shellcheck disable=SC2016
REMOTO_VERIFICAR='echo "metadata=$(systemctl is-active adaceen-ws-metadata 2>/dev/null)"; echo "agente=$(systemctl is-active adaceen-workspaces-agent 2>/dev/null)"; echo "relay=$(sudo journalctl -u adaceen-workspaces-agent -n 200 --no-pager 2>/dev/null | grep -oE "conectado al relay|el relay rechazo el token|relay sin conexion" | tail -n 1)"; if id nobody >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then sudo -u nobody curl -s -m 3 -H "Metadata-Flavor: Google" http://169.254.169.254/ >/dev/null 2>&1; echo "bloqueo=$?"; else echo "bloqueo=sin-prueba"; fi; '"$REMOTO_LOG"

# Sin la terminal como entrada: ssh no se come lo que se escriba mientras corre.
por_iap() {
  local comando="$1" salida="$2"
  gcloud compute ssh "$VM_EDITORES" --zone="$(zona_de "$VM_EDITORES")" --project="$PROYECTO" \
    --tunnel-through-iap --quiet --command="$comando" </dev/null >"$salida" 2>"$PRIV/err-ssh"
}

# La version de VS Code que fija el commit de ~/PDC: el package.json del commit
# del submodulo (git ls-tree), nunca el de la copia de trabajo, que puede estar
# en otro commit (un ~/PDC viejo sin git submodule update).
version_vscode_esperada() {
  local tipo="" commit=""
  read -r _ tipo commit _ < <(git -C "$REPO" ls-tree HEAD vscode-ext-prod 2>/dev/null) || true
  case "$tipo" in
    commit)
      [[ $commit =~ ^[0-9a-f]{40}$ ]] || return 0
      # Con el submodulo clonado, ese commit se lee sin red; si no, de GitHub (como instalar-vsix.sh).
      if [ -e "$REPO/vscode-ext-prod/.git" ] &&
        git -C "$REPO/vscode-ext-prod" show "$commit:package.json" 2>/dev/null | py version - 2>/dev/null; then
        return 0
      fi
      curl -fsS -m 15 "https://raw.githubusercontent.com/eydersantiago/vscode-ext-prod/$commit/package.json" 2>/dev/null |
        py version - 2>/dev/null || true
      ;;
    tree)
      # vscode-ext-prod como carpeta normal (una copia sin submodulo): la del commit.
      git -C "$REPO" show "HEAD:vscode-ext-prod/package.json" 2>/dev/null | py version - 2>/dev/null || true
      ;;
  esac
  return 0
}

# Lee las lineas log= del ultimo arranque. LOG_FALTA: lo que no aparecio;
# LOG_AVISOS: avisos con lo que hay que hacer (una por linea).
LOG_LINEAS=""
LOG_FALTA=""
LOG_AVISOS=""
analizar_log() {
  local archivo="$1" vscode="$2" linea vsix vsix_ok=0
  LOG_LINEAS="$(sed -n 's/^log=//p' "$archivo")"
  LOG_FALTA=""
  LOG_AVISOS=""
  if [ -z "$LOG_LINEAS" ]; then
    LOG_FALTA="no pude leer /var/log/adaceen-ws-startup.log"
    return 0
  fi
  grep -qF -- "--- PDC $RAMA_PRODUCCION @" <<<"$LOG_LINEAS" || LOG_FALTA="${LOG_FALTA:+$LOG_FALTA, }«--- PDC $RAMA_PRODUCCION @»"
  vsix="$(grep -E '^--- VSIX .*instalado' <<<"$LOG_LINEAS" || true)"
  if [ -n "$vsix" ] && grep -qF -- "${vscode:-instalado}" <<<"$vsix"; then vsix_ok=1; fi
  [ "$vsix_ok" = 1 ] || LOG_FALTA="${LOG_FALTA:+$LOG_FALTA, }VSIX ${vscode:-nuevo} instalado"
  grep -qF -- "--- agente de entornos en" <<<"$LOG_LINEAS" || LOG_FALTA="${LOG_FALTA:+$LOG_FALTA, }«--- agente de entornos en»"
  grep -q '^=== listo\.' <<<"$LOG_LINEAS" || LOG_FALTA="${LOG_FALTA:+$LOG_FALTA, }«=== listo.»"
  while IFS= read -r linea; do
    case "$linea" in
      "--- AVISO VSIX:"*)
        [ "$vsix_ok" = 1 ] && continue
        LOG_AVISOS="$LOG_AVISOS$linea -> quedo el VSIX anterior: revisa la seccion 0.3 (VSIX en GitHub) y vuelve a correr aplicar"$'\n'
        ;;
      *"sin metadata workspace-agent-token"*)
        LOG_AVISOS="$LOG_AVISOS$linea -> fallo el add-metadata del token: vuelve a correr bash deploy/produccion.sh aplicar"$'\n'
        ;;
      *"no trae deploy/gcp/workspaces/agente"*)
        LOG_AVISOS="$LOG_AVISOS$linea -> la metadata branch apunta a otra rama: vuelve a correr bash deploy/produccion.sh aplicar"$'\n'
        ;;
      "--- AVISO"*)
        LOG_AVISOS="$LOG_AVISOS$linea -> revisa el log completo (anexo, seccion 4.4)"$'\n'
        ;;
    esac
  done <<<"$LOG_LINEAS"
  LOG_AVISOS="${LOG_AVISOS%$'\n'}"
  return 0
}

mostrar_log() {
  info "ultimo arranque de $VM_EDITORES (lineas --- y === de /var/log/adaceen-ws-startup.log):"
  printf '%s\n' "$LOG_LINEAS" | sed 's/^/    /'
}

# ---------------------------------------------------------------- revisar
BLOQUEOS=()
mostrar_variables() {
  local n estado nota
  for n in ADACEEN_WORKSPACE_PROVIDER PUBLIC_BASE_URL WORKSPACE_AGENT_URL WORKSPACE_AGENT_TRANSPORT \
    WORKSPACE_AGENT_TOKEN TELEMETRY_SALT WORKER_HEARTBEAT_TOKEN AGENT_TARGET ADACEEN_SCAN_WORKER_KEY \
    ALLOWED_ORIGINS WORKSPACE_ALLOWED_LOGINS EDITOR_SESSION_TTL_DAYS WORKSPACE_VM_AUTOSTART; do
    estado="${AZ[var.$n]:-?}"
    nota=""
    case "$n" in
      ADACEEN_WORKSPACE_PROVIDER) if [ "${AZ[proveedor_ok]}" = "si" ]; then nota="✓ tunnel"; else nota="-> aplicar pone tunnel"; fi ;;
      PUBLIC_BASE_URL) if [ "${AZ[url_publica_ok]}" = "si" ]; then nota="✓ la del backend"; else nota="-> aplicar pone $BACKEND"; fi ;;
      WORKSPACE_AGENT_URL) if [ "${AZ[agente_url]}" = "si" ]; then nota="-> aplicar la borra (con valor el transporte es direct)"; else nota="✓"; fi ;;
      WORKSPACE_AGENT_TRANSPORT) if [ "${AZ[transporte_ok]}" = "si" ]; then nota="✓"; else nota="-> aplicar pone relay"; fi ;;
      WORKSPACE_AGENT_TOKEN) nota="se rota con la VM (huellas abajo)" ;;
      TELEMETRY_SALT) if [ "${AZ[sal]}" = "si" ]; then nota="✓ no se toca"; else nota="-> aplicar la crea (no existia)"; fi ;;
      WORKER_HEARTBEAT_TOKEN)
        if [ -n "${AZ[latido]}" ]; then nota="huellas abajo"
        elif [ -n "$P_LATIDO_DE" ]; then nota="-> aplicar la copia de $P_LATIDO_DE"
        else nota="✗ ninguna GPU tiene heartbeat-url y heartbeat-token (deploy/gcp/create-vm.sh; runbook, seccion 5)"; fi
        ;;
      AGENT_TARGET) if [ "${AZ[cola_ok]}" = "si" ]; then nota="✓ queue"; else nota="✗ no es queue: revisa la cola (docs/operacion/prerrequisitos.md)"; fi ;;
      ADACEEN_SCAN_WORKER_KEY) if [ "$estado" = "valor" ]; then nota="la misma en la metadata scan-worker-key (huellas abajo)"; else nota="✓"; fi ;;
      ALLOWED_ORIGINS)
        case "${AZ[origenes]}" in
          todos) nota="vacia: CORS acepta cualquier origen (riesgo anotado en pendientes)" ;;
          cubre) nota="✓ incluye los origenes del overlay" ;;
          *) nota="✗ no cubre: ${AZ[origenes]#faltan:} (anexo, seccion 1.5)" ;;
        esac
        ;;
      WORKSPACE_ALLOWED_LOGINS)
        case "${AZ[logins]}" in
          abierta) nota="cualquier estudiante con GitHub conectado" ;;
          *) nota="lista de ${AZ[logins]#lista:} login(s): debe incluir los de la prueba (o poner *)" ;;
        esac
        ;;
      EDITOR_SESSION_TTL_DAYS) nota="opcional (30 dias si no esta)" ;;
      WORKSPACE_VM_AUTOSTART) nota="opcional; autoencendido: ${AZ[autoencendido]} de 5 variables con valor" ;;
    esac
    printf '    %-28s %-10s %s\n' "$n" "$(case "$estado" in valor) echo "con valor" ;; *) echo "$estado" ;; esac)" "$nota"
  done
}

# Una fila de huellas: variable, huella en Azure, VM, huella en la VM y conclusion.
fila_huella() {
  printf '    %-24s Azure %-14s %-20s %-14s %s\n' "$1" "${2:-(sin valor)}" "$3" "${4:-(sin valor)}" "$5"
}

mostrar_huellas() {
  local vm azure lado conclusion donante referencia
  info "huellas (12 caracteres del SHA-256; iguales = mismo valor):"
  if [ -n "$VM_EDITORES" ] && [ "${M[$VM_EDITORES.leida]:-no}" = "si" ]; then
    azure="${AZ[token]:-}"
    lado="${M[$VM_EDITORES.token]:-}"
    if [ -n "$azure" ] && [ "$azure" = "$lado" ]; then conclusion="✓ iguales"; else conclusion="distintas o sin valor: aplicar las rota"; fi
    fila_huella WORKSPACE_AGENT_TOKEN "$azure" "$VM_EDITORES" "$lado" "$conclusion"
    azure="${AZ[scan]:-}"
    lado="${M[$VM_EDITORES.scan]:-}"
    if [ -n "$azure$lado" ]; then
      if [ "$azure" = "$lado" ]; then conclusion="✓ iguales"
      elif [ -n "$azure" ]; then conclusion="-> aplicar la copia a la VM"
      else conclusion="Azure no la exige (sobra en la VM)"; fi
      fila_huella ADACEEN_SCAN_WORKER_KEY "$azure" "$VM_EDITORES" "$lado" "$conclusion"
    fi
  fi
  donante="$(gpu_con_latido)"
  referencia="$(latido_de_referencia)"
  for vm in $GPUS; do
    [ "${M[$vm.leida]:-no}" = "si" ] || continue
    azure="${AZ[latido]:-}"
    lado="${M[$vm.latido]:-}"
    if [ -n "$lado" ] && [ "$azure" = "$lado" ]; then conclusion="✓ iguales"
    elif [ -z "$lado" ] && [ -n "$donante" ]; then conclusion="-> actualizar-gpus.sh le copia el de $donante"
    elif [ -z "$lado" ]; then conclusion="✗ ninguna GPU tiene heartbeat-url y heartbeat-token para copiarle (runbook, seccion 5)"
    elif [ -z "$azure" ] && [ -z "$donante" ]; then conclusion="✗ ninguna GPU tiene heartbeat-url y heartbeat-token (runbook, seccion 5)"
    elif [ -z "$azure" ] && [ "$lado" = "$referencia" ]; then conclusion="-> aplicar copia a Azure el de $donante"
    elif [ -z "$azure" ]; then conclusion="✗ distinta de la de $donante, que aplicar copia a Azure: esta GPU no se veria (runbook, seccion 5)"
    else conclusion="✗ distintas: esa GPU no se vera (runbook, seccion 5)"; fi
    fila_huella WORKER_HEARTBEAT_TOKEN "$azure" "$vm" "$lado" "$conclusion"
  done
}

mostrar_vms() {
  local vm zona
  for vm in $VM_EDITORES $GPUS; do
    zona="$(zona_de "$vm")"
    if [ -z "$zona" ]; then
      info "$vm: no existe en $PROYECTO"
      continue
    fi
    if [ "${M[$vm.leida]:-no}" != "si" ]; then
      aviso "$vm ($zona): $(estado_de "$vm"), metadata ilegible"
      continue
    fi
    local arranque="${M[$vm.startup]}"
    case "$arranque" in nuevo) arranque="el de $(ruta_repo)" ;; otro) arranque="otro (anterior)" ;; esac
    if [ "$vm" = "$VM_EDITORES" ]; then
      info "$vm ($zona): $(estado_de "$vm") | rama ${M[$vm.rama]:-(sin metadata branch)} | startup-script: $arranque"
      if [ "${M[$vm.worker_secret]}" = "si" ]; then
        info "    tiene worker-secret, que ya no se usa (opcional: gcloud compute instances remove-metadata $vm --zone=$zona --keys=worker-secret)"
      fi
    else
      info "$vm ($zona): $(estado_de "$vm") | rama ${M[$vm.rama]:-(sin metadata branch)} | worker-id ${M[$vm.worker_id]:-(sin worker-id)} | startup-script: $arranque"
      case "${M[$vm.worker_id]}" in
        gce-*) ;;
        *) aviso "$vm: worker-id deberia empezar por gce- para que clase.sh la reconozca: gcloud compute instances add-metadata $vm --zone=$zona --metadata=worker-id=gce-<perfil>" ;;
      esac
    fi
  done
}

accion_revisar() {
  local k
  herramientas
  encabezado
  titulo "herramientas"
  ok "gcloud, curl, python3 y git"
  command -v openssl >/dev/null 2>&1 || BLOQUEOS+=("falta openssl (aplicar genera TELEMETRY_SALT y el token con openssl rand)")
  if comprobar_az; then
    ok "az con la sesion iniciada"
  else
    explicar_az
    BLOQUEOS+=("az no esta listo")
  fi

  titulo "repositorio"
  leer_repo
  explicar_repo
  case "$REPO_ESTADO" in desplegado | push-pendiente) ;; *) BLOQUEOS+=("$(ruta_repo) no esta en el commit que se despliega") ;; esac
  [ -z "$REPO_CAMBIOS" ] || BLOQUEOS+=("cambios locales en los scripts de arranque")

  leer_instancias || fallar "gcloud no pudo listar las VMs de $PROYECTO: $INSTANCIAS_ERROR (¿gcloud auth login?)"
  avisar_repetidas
  leer_vms
  leer_salud || true

  titulo "App Service $APP (variables: nombre y si tienen valor; nunca el valor)"
  if [ "$AZ_ESTADO" = "listo" ]; then
    if leer_azure; then
      planear
      mostrar_variables
    else
      aviso "az no pudo leer las variables de $APP en $RG: $AZ_ERROR"
      BLOQUEOS+=("az no puede leer el App Service")
    fi
    if leer_capacidad; then
      if [ "$INSTANCIAS_APP" = 1 ]; then ok "una sola instancia"; else aviso "el plan tiene $INSTANCIAS_APP instancias: debe ser 1 (el relay vive en la memoria del proceso)"; fi
    else
      aviso "no pude leer cuantas instancias tiene el plan del App Service"
    fi
    info "revisa tambien en el portal que no haya escalado automatico (App Service -> Escalar horizontalmente)"
  else
    info "sin az no puedo leer las variables"
  fi
  planear

  titulo "/api/health"
  if [ "${S[responde]:-no}" = "si" ]; then
    if [ "${S[nueva]}" = "si" ]; then ok "version nueva desplegada (trae workspace_vm_autostart)"; else info "version anterior (sin workspace_vm_autostart): falta el push o el flujo no termino"; fi
    for k in mode queue_configured database_provider telemetry_salt_configured worker_heartbeat_configured \
      workspace_provider workspace_agent_transport workspace_agent_online model_workers_alive model_workers_known_down; do
      printf '    %-28s %s\n' "$k" "${S[$k]:-(no esta)}"
    done
  else
    aviso "sin respuesta de $BACKEND/api/health"
  fi

  titulo "VM de editores y GPU"
  mostrar_vms
  if [ "$AZ_LEIDO" = 1 ]; then mostrar_huellas; fi

  titulo "plan"
  mostrar_plan
  if [ "$SIN_VM" = 0 ] && [ "$P_ROTAR" = 1 ]; then
    info "rotar el token pide confirmacion (CONFIRMAR=1 para no preguntar). No lo hagas durante una clase."
  fi
  printf '\n'
  if [ "${#BLOQUEOS[@]}" -gt 0 ]; then
    mal "antes de aplicar: $(printf '%s; ' "${BLOQUEOS[@]}" | sed 's/; $//')"
    exit 1
  fi
  ok "revisar no cambio nada. Siguiente: bash deploy/produccion.sh aplicar"
}

# ---------------------------------------------------------------- aplicar
PENDIENTES=()
NOTAS=()

aplicar_variables() {
  local ajustes=() nombres=()
  if [ "$P_PROVEEDOR" = 1 ]; then ajustes+=("ADACEEN_WORKSPACE_PROVIDER=tunnel"); nombres+=(ADACEEN_WORKSPACE_PROVIDER); fi
  if [ "$P_URL_PUBLICA" = 1 ]; then ajustes+=("PUBLIC_BASE_URL=$BACKEND"); nombres+=(PUBLIC_BASE_URL); fi
  if [ "$P_TRANSPORTE" = 1 ]; then ajustes+=("WORKSPACE_AGENT_TRANSPORT=relay"); nombres+=(WORKSPACE_AGENT_TRANSPORT); fi
  if [ "$P_SAL" = 1 ]; then
    (umask 077 && openssl rand -hex 32 | tr -d '\n' >"$PRIV/secreto-sal")
    [ -s "$PRIV/secreto-sal" ] || fallar "openssl no genero TELEMETRY_SALT; no se toco nada"
    ajustes+=("TELEMETRY_SALT=$(cat "$PRIV/secreto-sal")")
    nombres+=(TELEMETRY_SALT)
  fi
  if [ -n "$P_LATIDO_DE" ]; then
    py meta-a-archivo "$PRIV/$P_LATIDO_DE.json" heartbeat-token "$PRIV/secreto-latido" ||
      fallar "no pude leer heartbeat-token de $P_LATIDO_DE; no se toco nada"
    ajustes+=("WORKER_HEARTBEAT_TOKEN=$(cat "$PRIV/secreto-latido")")
    nombres+=(WORKER_HEARTBEAT_TOKEN)
  fi
  if [ "${#ajustes[@]}" -gt 0 ]; then
    info "Azure: ${nombres[*]} en un solo cambio (el App Service se reinicia, ~1 min)"
    if ! az webapp config appsettings set --resource-group "$RG" --name "$APP" --output none \
      --settings "${ajustes[@]}" >/dev/null 2>"$PRIV/err"; then
      fallar "az no pudo cargar las variables: $(error_limpio "$PRIV/err"). No se toco nada mas (ni la VM ni las GPU)."
    fi
    ok "variables cargadas en Azure: ${nombres[*]}"
  else
    ok "variables del App Service: nada que crear"
  fi
  if [ "$P_BORRAR_URL" = 1 ]; then
    if ! az webapp config appsettings delete --resource-group "$RG" --name "$APP" \
      --setting-names WORKSPACE_AGENT_URL --output none >/dev/null 2>"$PRIV/err"; then
      fallar "az no pudo borrar WORKSPACE_AGENT_URL: $(error_limpio "$PRIV/err"). No se toco la VM ni las GPU."
    fi
    ok "WORKSPACE_AGENT_URL borrada (el transporte vuelve a ser relay)"
  fi
}

aplicar_scan() {
  [ "$P_SCAN" = 1 ] || return 0
  py azure-a-archivo "$PRIV/azure.json" ADACEEN_SCAN_WORKER_KEY "$PRIV/secreto-scan" ||
    fallar "no pude leer ADACEEN_SCAN_WORKER_KEY de Azure"
  if ! gcloud compute instances add-metadata "$VM_EDITORES" --zone="$(zona_de "$VM_EDITORES")" --project="$PROYECTO" \
    --metadata-from-file=scan-worker-key="$PRIV/secreto-scan" >/dev/null 2>"$PRIV/err"; then
    fallar "gcloud no pudo poner scan-worker-key en $VM_EDITORES: $(error_limpio "$PRIV/err")"
  fi
  ok "$VM_EDITORES: scan-worker-key igual a ADACEEN_SCAN_WORKER_KEY de Azure (esa clave llega a la terminal de cada estudiante)"
}

esperar_version() {
  local inicio ahora limite ultimo_aviso
  leer_salud || true
  if version_lista; then
    ok "/api/health: $(texto_salud)"
    return 0
  fi
  leer_repo
  if [ "$REPO_ESTADO" = "push-pendiente" ]; then
    info "falta el push. En PowerShell (seccion 2 de la guia): $(comando_push)"
  fi
  info "espero hasta $ESPERA_MAX s a que /api/health muestre la version nueva con tunnel y relay (el flujo tarda 3-5 min: $FLUJO)"
  inicio="$(date +%s)"
  limite=$((inicio + ESPERA_MAX))
  ultimo_aviso="$inicio"
  while :; do
    ahora="$(date +%s)"
    [ "$ahora" -lt "$limite" ] || break
    sleep "$INTERVALO"
    leer_salud || true
    if version_lista; then
      ok "/api/health: $(texto_salud)"
      return 0
    fi
    ahora="$(date +%s)"
    if [ $((ahora - ultimo_aviso)) -ge 60 ]; then
      leer_repo
      if [ "$REPO_ESTADO" = "push-pendiente" ]; then
        info "esperando ($((ahora - inicio)) s de $ESPERA_MAX): GitHub sigue en $(corto "$REPO_REMOTO"), falta el push; $(texto_salud)"
      else
        info "esperando ($((ahora - inicio)) s de $ESPERA_MAX): $(texto_salud)"
      fi
      ultimo_aviso="$ahora"
    fi
  done
  leer_repo
  if [ "${S[nueva]:-}" != "si" ] && [ "$REPO_ESTADO" = "push-pendiente" ]; then
    fallar "pasaron $ESPERA_MAX s y $RAMA_PRODUCCION sigue en $(corto "$REPO_REMOTO") en GitHub: todavia no se hizo el push. Hazlo en PowerShell ($(comando_push)) y vuelve a correr bash deploy/produccion.sh aplicar (lo ya hecho no se repite). La VM y las GPU no se tocaron."
  elif [ "${S[nueva]:-}" != "si" ]; then
    fallar "pasaron $ESPERA_MAX s y /api/health no muestra la version nueva ($(texto_salud)). Mira el flujo: $FLUJO. Cuando termine, vuelve a correr bash deploy/produccion.sh aplicar. La VM y las GPU no se tocaron."
  fi
  fallar "la version nueva responde, pero $(texto_salud): revisa ADACEEN_WORKSPACE_PROVIDER, WORKSPACE_AGENT_URL y WORKSPACE_AGENT_TRANSPORT (bash deploy/produccion.sh revisar). La VM y las GPU no se tocaron."
}

confirmar_rotacion() {
  local respuesta=""
  aviso "voy a rotar WORKSPACE_AGENT_TOKEN (en Azure y en la metadata de $VM_EDITORES) y subir el startup-ws.sh nuevo."
  aviso "No lo hagas durante una clase: entre los dos cambios «Preparar mi editor» no funciona, y el primer arranque nuevo reinicia todos los tuneles (quien este conectado se reconecta a los pocos segundos)."
  if [ "$CONFIRMAR" = 1 ]; then
    info "CONFIRMAR=1: sigo sin preguntar"
    return 0
  fi
  if [ ! -t 0 ]; then
    fallar "no hay terminal para confirmar. Sin clase en curso: CONFIRMAR=1 bash deploy/produccion.sh aplicar. La VM no se toco."
  fi
  # Lo escrito o pegado antes de la pregunta no la contesta: si se pego un bloque
  # entero, la linea siguiente esperaba en la terminal y read la tomaria.
  local descartadas=0 _linea
  while IFS= read -r -t 0.2 _linea; do descartadas=$((descartadas + 1)); done
  if [ "$descartadas" -gt 0 ]; then
    aviso "descarte $descartadas linea(s) escritas o pegadas antes de esta pregunta (no se ejecutan): pega y corre un comando a la vez"
  fi
  read -r -p "[adaceen] ¿Rotar ahora? Escribe si para seguir: " respuesta || respuesta=""
  case "$respuesta" in
    si | SI | Si | s | S) return 0 ;;
  esac
  fallar "no se roto el token ni se toco la VM. Cuando no haya clase: bash deploy/produccion.sh aplicar (o --sin-vm para hacer solo las GPU)"
}

# Como la seccion 4.3 de la guia: token nuevo && Azure && metadata. Si az falla,
# la VM no recibe el token y los dos lados siguen con el mismo.
rotar_token() {
  local zona fallo="openssl"
  zona="$(zona_de "$VM_EDITORES")"
  (umask 077 && openssl rand -hex 32 | tr -d '\n' >"$PRIV/secreto-token") &&
    [ -s "$PRIV/secreto-token" ] &&
    fallo="az" &&
    az webapp config appsettings set --resource-group "$RG" --name "$APP" --output none \
      --settings "WORKSPACE_AGENT_TOKEN=$(cat "$PRIV/secreto-token")" >/dev/null 2>"$PRIV/err" &&
    fallo="gcloud" &&
    gcloud compute instances add-metadata "$VM_EDITORES" --zone="$zona" --project="$PROYECTO" \
      --metadata=branch="$RAMA_PRODUCCION" \
      --metadata-from-file="startup-script=$STARTUP_WS,workspace-agent-token=$PRIV/secreto-token" >/dev/null 2>"$PRIV/err" &&
    fallo=""
  case "$fallo" in
    "")
      ok "token rotado en Azure y en la VM (huella nueva $(printf '%s\n' "$(cat "$PRIV/secreto-token")" | sha256sum | cut -c1-12)); $VM_EDITORES con branch=$RAMA_PRODUCCION y el startup-ws.sh nuevo"
      ;;
    openssl) fallar "openssl no genero el token; no se toco nada" ;;
    az) fallar "az no pudo cambiar WORKSPACE_AGENT_TOKEN: $(error_limpio "$PRIV/err"). La VM no se toco: Azure y la VM siguen con el mismo token." ;;
    gcloud) fallar "Azure ya tiene el token nuevo pero $VM_EDITORES no: $(error_limpio "$PRIV/err"). «Preparar mi editor» no funciona hasta que vuelvas a correr bash deploy/produccion.sh aplicar (genera otro token y lo pone en los dos lados)." ;;
  esac
}

correr_arranque() {
  local estado vscode
  estado="$(estado_de "$VM_EDITORES")"
  case "$P_ARRANQUE" in
    "")
      ok "$VM_EDITORES: nada cambio y el agente esta conectado; no hace falta correr el arranque"
      ;;
    iap)
      info "corriendo el arranque nuevo de $VM_EDITORES por IAP (unos minutos)..."
      if ! por_iap "$REMOTO_ARRANQUE" "$PRIV/ssh"; then
        aviso "no pude entrar por IAP: $(error_limpio "$PRIV/err-ssh")"
        PENDIENTES+=("correr el arranque de $VM_EDITORES (anexo, seccion 4.4)")
        P_ARRANQUE="fallo"
        return 0
      fi
      vscode="$(version_vscode_esperada)"
      analizar_log "$PRIV/ssh" "$vscode"
      mostrar_log
      if [ -n "$LOG_FALTA" ]; then aviso "en el log falta: $LOG_FALTA"; fi
      if [ -n "$LOG_AVISOS" ]; then
        while IFS= read -r linea; do aviso "$linea"; done <<<"$LOG_AVISOS"
      fi
      if [ -z "$LOG_FALTA$LOG_AVISOS" ]; then ok "arranque nuevo sin avisos"; else PENDIENTES+=("avisos del arranque de $VM_EDITORES"); fi
      ;;
    encender)
      info "encendiendo $VM_EDITORES ($estado); el arranque nuevo corre solo..."
      if [ "$estado" = "SUSPENDED" ]; then
        gcloud compute instances resume "$VM_EDITORES" --zone="$(zona_de "$VM_EDITORES")" --project="$PROYECTO" --quiet >/dev/null 2>"$PRIV/err" || {
          aviso "no encendio: $(error_limpio "$PRIV/err")"
          PENDIENTES+=("encender $VM_EDITORES")
          P_ARRANQUE="apagada"
        }
      else
        gcloud compute instances start "$VM_EDITORES" --zone="$(zona_de "$VM_EDITORES")" --project="$PROYECTO" --quiet >/dev/null 2>"$PRIV/err" || {
          aviso "no encendio: $(error_limpio "$PRIV/err")"
          PENDIENTES+=("encender $VM_EDITORES")
          P_ARRANQUE="apagada"
        }
      fi
      ;;
    apagada)
      info "$VM_EDITORES esta $estado: el arranque nuevo corre solo la proxima vez que se encienda (bash deploy/clase.sh iniciar). Para hacerlo ya: bash deploy/produccion.sh aplicar --encender-vm"
      NOTAS+=("$VM_EDITORES esta apagada: el arranque nuevo corre y el agente se conecta al encenderla (bash deploy/clase.sh iniciar o aplicar --encender-vm)")
      ;;
    otro)
      aviso "$VM_EDITORES esta en $estado: vuelve a correr bash deploy/produccion.sh aplicar en un minuto"
      PENDIENTES+=("$VM_EDITORES en $estado")
      ;;
  esac
}

esperar_agente() {
  local inicio ahora limite ultimo_aviso
  case "$P_ARRANQUE" in "" | iap | encender) ;; *) return 0 ;; esac
  leer_salud || true
  if [ "${S[workspace_agent_online]:-}" = "si" ] && [ "$P_ARRANQUE" = "" ]; then
    return 0
  fi
  info "espero hasta $ESPERA_MAX s a que /api/health diga workspace_agent_online: true (1 a 2 min; Azure se reinicia tras el cambio de token)"
  inicio="$(date +%s)"
  limite=$((inicio + ESPERA_MAX))
  ultimo_aviso="$inicio"
  while [ "${S[workspace_agent_online]:-}" != "si" ]; do
    ahora="$(date +%s)"
    if [ "$ahora" -ge "$limite" ]; then
      aviso "pasaron $ESPERA_MAX s y el agente de $VM_EDITORES no se conecta al relay. Mira: bash deploy/produccion.sh verificar (si el journal dice «el relay rechazo el token», vuelve a correr aplicar)"
      PENDIENTES+=("workspace_agent_online sigue en false")
      return 0
    fi
    if [ $((ahora - ultimo_aviso)) -ge 60 ]; then
      info "esperando ($((ahora - inicio)) s de $ESPERA_MAX): $(texto_salud)"
      ultimo_aviso="$ahora"
    fi
    sleep "$INTERVALO"
    leer_salud || true
  done
  ok "workspace_agent_online: true (transporte ${S[workspace_agent_transport]:-?})"
  if [ "$P_ARRANQUE" = "encender" ] && por_iap "$REMOTO_LOG" "$PRIV/ssh"; then
    analizar_log "$PRIV/ssh" "$(version_vscode_esperada)"
    mostrar_log
    if [ -n "$LOG_FALTA$LOG_AVISOS" ]; then
      aviso "el arranque tiene avisos o le falta algo: bash deploy/produccion.sh verificar"
      PENDIENTES+=("avisos del arranque de $VM_EDITORES")
    fi
  fi
}

aplicar_vm() {
  if [ "$SIN_VM" = 1 ]; then
    info "VM de editores: no se toca (--sin-vm)"
    return 0
  fi
  titulo "VM de editores $VM_EDITORES"
  exigir_repo_desplegado
  # Entre las variables y este paso pasan el push y el flujo: az puede haberse vencido.
  if ! comprobar_az; then
    explicar_az
    fallar "az dejo de estar listo: la VM no se toco. Arreglalo y vuelve a correr bash deploy/produccion.sh aplicar"
  fi
  leer_azure || fallar "az no pudo leer las variables de $APP: $AZ_ERROR. La VM no se toco."
  leer_instancias || fallar "gcloud no pudo listar las VMs de $PROYECTO: $INSTANCIAS_ERROR"
  leer_vm "$VM_EDITORES" || fallar "no pude leer $VM_EDITORES; no se toco"
  leer_salud || true
  planear
  if [ "$P_ROTAR" = 1 ]; then confirmar_rotacion; fi
  if [ "$P_ROTAR$P_RAMA_WS$P_SCAN" != "000" ]; then asegurar_respaldo; fi
  # Seccion 1.4 de la guia: la clave de escaneo que exige Azure, en la metadata.
  aplicar_scan
  if [ "$P_ROTAR" = 1 ]; then
    rotar_token
  elif [ "$P_RAMA_WS" = 1 ]; then
    if ! gcloud compute instances add-metadata "$VM_EDITORES" --zone="$(zona_de "$VM_EDITORES")" --project="$PROYECTO" \
      --metadata=branch="$RAMA_PRODUCCION" >/dev/null 2>"$PRIV/err"; then
      fallar "gcloud no pudo poner branch=$RAMA_PRODUCCION en $VM_EDITORES: $(error_limpio "$PRIV/err")"
    fi
    ok "$VM_EDITORES: branch=$RAMA_PRODUCCION"
  else
    ok "$VM_EDITORES ya tiene branch=$RAMA_PRODUCCION, el startup-ws.sh nuevo y el mismo token que Azure (huella ${M[$VM_EDITORES.token]}): no se rota"
  fi
  correr_arranque
  esperar_agente
}

aplicar_gpus() {
  local vm zona
  if [ "$SIN_GPU" = 1 ]; then
    info "GPU: no se tocan (--sin-gpu)"
    return 0
  fi
  titulo "GPU"
  exigir_repo_desplegado
  leer_instancias || fallar "gcloud no pudo listar las VMs de $PROYECTO: $INSTANCIAS_ERROR"
  for vm in $GPUS; do leer_vm "$vm" || true; done
  planear
  for vm in $GPUS; do
    [ "${M[$vm.leida]:-no}" = "si" ] || continue
    zona="$(zona_de "$vm")"
    case "${M[$vm.worker_id]}" in
      gce-*) ;;
      *) aviso "$vm: worker-id deberia empezar por gce- para que clase.sh la reconozca: gcloud compute instances add-metadata $vm --zone=$zona --metadata=worker-id=gce-<perfil>" ;;
    esac
  done
  if [ -n "$P_OTRO_LATIDO" ]; then
    mal "$(aviso_otro_latido "$P_OTRO_LATIDO")"
    PENDIENTES+=("heartbeat-token distinto en ${P_OTRO_LATIDO// /, }")
  fi
  if [ "$P_GPU" = 0 ]; then
    ok "GPU: startup-script, rama $RAMA_PRODUCCION y latido al dia"
    return 0
  fi
  asegurar_respaldo
  if RAMA="$RAMA_PRODUCCION" PROYECTO="$PROYECTO" GPUS="$GPUS" bash "$DIR_SCRIPT/gcp/actualizar-gpus.sh" </dev/null; then
    ok "GPU al dia; no se encendio nada: el cambio vale desde el proximo bash deploy/clase.sh iniciar"
  else
    PENDIENTES+=("actualizar-gpus.sh fallo en alguna GPU (ver arriba)")
  fi
}

accion_aplicar() {
  local nota
  herramientas openssl
  encabezado
  # Todo lo que puede cortar se comprueba antes de cambiar nada.
  if ! comprobar_az; then
    explicar_az
    fallar "sin az no se puede aplicar. No se toco nada."
  fi
  leer_instancias || fallar "gcloud no pudo listar las VMs de $PROYECTO: $INSTANCIAS_ERROR (¿gcloud auth login?)"
  avisar_repetidas
  if [ "$SIN_VM" = 0 ] && [ -z "$(zona_de "$VM_EDITORES")" ]; then
    fallar "no encuentro la VM $VM_EDITORES en $PROYECTO (PROYECTO=$PROYECTO_POR_DEFECTO bash deploy/produccion.sh aplicar, o --sin-vm). No se toco nada."
  fi
  leer_repo
  if [ "$SIN_VM" = 0 ] || [ "$SIN_GPU" = 0 ]; then
    case "$REPO_ESTADO" in
      desplegado | push-pendiente) ;;
      *) explicar_repo; fallar "No se toco nada." ;;
    esac
    [ -z "$REPO_CAMBIOS" ] || { explicar_repo; fallar "No se toco nada."; }
  fi
  leer_azure || fallar "az no pudo leer las variables de $APP en $RG: $AZ_ERROR. No se toco nada."
  leer_vms
  leer_salud || true
  planear
  titulo "plan"
  mostrar_plan

  titulo "variables del App Service"
  aplicar_variables
  if [ "$SIN_VM" = 0 ] || [ "$SIN_GPU" = 0 ]; then
    titulo "version desplegada"
    esperar_version
  fi
  aplicar_vm
  aplicar_gpus

  printf '\n'
  if [ -n "$RESPALDO" ]; then info "respaldo para volver atras: ${RESPALDO/#"$HOME"/\~}/volver-atras.txt"; fi
  for nota in "${NOTAS[@]}"; do info "$nota"; done
  if [ "${#PENDIENTES[@]}" -gt 0 ]; then
    mal "aplicar termino con pendientes: $(printf '%s; ' "${PENDIENTES[@]}" | sed 's/; $//')"
    info "puedes volver a correr bash deploy/produccion.sh aplicar: no repite lo ya hecho"
    exit 1
  fi
  ok "aplicar termino. Siguiente: bash deploy/produccion.sh verificar"
}

# ---------------------------------------------------------------- verificar
N_OK=0
N_MAL=0
N_OMITIDO=0
FALLAS=()
chequeo() {
  case "$1" in
    si)
      N_OK=$((N_OK + 1))
      ok "$2"
      ;;
    no)
      N_MAL=$((N_MAL + 1))
      mal "$2"
      if [ -n "${3:-}" ]; then printf '      -> %s\n' "$3"; fi
      FALLAS+=("$2")
      ;;
    *)
      N_OMITIDO=$((N_OMITIDO + 1))
      info "- $2${3:+ ($3)}"
      ;;
  esac
  return 0
}

# si si todas las condiciones (cada una entre [ ]) se cumplen; no si alguna falla.
# Uso: chequeo "$(todas [ a = b ] -- [ c = d ])" "texto"
todas() {
  local cond=()
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--" ]; then
      if ! "${cond[@]}" 2>/dev/null; then echo no; return 0; fi
      cond=()
    else
      cond+=("$1")
    fi
    shift
  done
  if [ "${#cond[@]}" -gt 0 ] && ! "${cond[@]}" 2>/dev/null; then echo no; return 0; fi
  echo si
}

verificar_backend() {
  local k v archivo cabeceras codigo disposicion esperado_nav esperado_vsc publicado local_zip gpu_encendida=0 vm
  titulo "backend (seccion 3)"
  if [ "${S[responde]:-no}" != "si" ]; then
    chequeo no "/api/health responde" "Azure puede tardar mientras reinicia (AGENTS.md); vuelve a intentar en un minuto"
  else
    chequeo "$(todas [ "${S[ok]:-}" = si ])" "/api/health responde con ok: true"
    chequeo "$(todas [ "${S[nueva]:-}" = si ])" "version nueva desplegada (/api/health trae workspace_vm_autostart)" "mira el flujo: $FLUJO"
    chequeo "$(todas [ "${S[mode]:-}" = queue ] -- [ "${S[queue_configured]:-}" = si ])" \
      "mode queue y queue_configured true" "configuracion de la cola: docs/operacion/prerrequisitos.md"
    chequeo "$(todas [ "${S[database_provider]:-}" = postgres ])" "database_provider postgres"
    chequeo "$(todas [ "${S[telemetry_salt_configured]:-}" = si ] -- [ "${S[worker_heartbeat_configured]:-}" = si ])" \
      "telemetry_salt_configured y worker_heartbeat_configured true" "bash deploy/produccion.sh aplicar"
    chequeo "$(todas [ "${S[workspace_provider]:-}" = tunnel ] -- [ "${S[workspace_agent_transport]:-}" = relay ])" \
      "workspace_provider tunnel y workspace_agent_transport relay" "bash deploy/produccion.sh aplicar"
    if [ "$SIN_VM" = 0 ]; then
      chequeo "$(todas [ "${S[workspace_agent_online]:-}" = si ])" "workspace_agent_online true" \
        "bash deploy/produccion.sh aplicar (o aplicar --encender-vm si la VM esta apagada)"
    fi
    for vm in $GPUS; do
      if esta_encendida "$(estado_de "$vm")"; then gpu_encendida=1; fi
    done
    if [ "$gpu_encendida" = 1 ]; then
      chequeo "$(todas [ "${S[model_workers_alive]:-0}" -ge 1 ])" "con una GPU encendida, model_workers_alive ${S[model_workers_alive]:-?} (1 o mas)" \
        "la GPU tarda 2-5 min en mandar latido; runbook, seccion 5"
    else
      info "model_workers_alive ${S[model_workers_alive]:-?}, model_workers_known_down ${S[model_workers_known_down]:-?} (con las GPU apagadas se espera 0 y no)"
    fi
  fi

  archivo="$PRIV/empezar.html"
  esperado_nav="$(py version "$MANIFEST" 2>/dev/null || true)"
  esperado_vsc="$(version_vscode_esperada)"
  if curl -fsS -m 20 "$BACKEND/empezar" >"$archivo" 2>/dev/null; then
    declare -A E=()
    while IFS='=' read -r k v; do
      if [ -n "$k" ]; then E["$k"]="$v"; fi
    done < <(py empezar "$archivo" 2>/dev/null)
    chequeo "$(todas [ "${E[titulo]:-no}" = si ] -- [ "${E[sin_publicar]:-1}" = 0 ])" \
      "/empezar muestra «Empieza con ADACEEN» y todas las descargas publicadas" \
      "si dice que un archivo no esta publicado, revisa el paso Create deployment package del flujo (seccion 2)"
    chequeo "$(todas [ -n "${E[navegador]:-}" ] -- [ "${E[navegador]:-}" = "$esperado_nav" ])" \
      "/empezar ofrece la extension de navegador ${E[navegador]:-?} ($(ruta_repo) tiene la ${esperado_nav:-?})"
    if [ -n "$esperado_vsc" ]; then
      chequeo "$(todas [ "${E[vscode]:-}" = "$esperado_vsc" ])" \
        "/empezar ofrece la extension de VS Code ${E[vscode]:-?} (el submodulo fija la $esperado_vsc)"
    else
      chequeo omitido "/empezar ofrece la extension de VS Code ${E[vscode]:-?}" "no pude leer la version del submodulo para compararla"
    fi
  else
    chequeo no "$BACKEND/empezar responde" "si no existe, el backend es el anterior: mira el flujo (seccion 2)"
  fi

  for k in adaceen-navegador.zip adaceen.vsix Preparar-Mac-ADACEEN.zip; do
    cabeceras="$(curl -sSI -m 20 "$BACKEND/descargas/$k" 2>/dev/null | tr -d '\r' || true)"
    codigo="$(awk 'toupper($1) ~ /^HTTP\// { c = $2 } END { print c }' <<<"$cabeceras")"
    disposicion="$(grep -i '^content-disposition:' <<<"$cabeceras" || true)"
    chequeo "$(todas [ "$codigo" = 200 ] -- grep -qF "attachment; filename=\"$k\"" <<<"$disposicion")" \
      "/descargas/$k: ${codigo:-sin respuesta}, con Content-Disposition: attachment" "un 404 es que el flujo no la empaqueto (seccion 2)"
  done

  if curl -fsS -m 60 -o "$PRIV/navegador.zip" "$BACKEND/descargas/adaceen-navegador.zip" 2>/dev/null; then
    publicado="$(sha256sum "$PRIV/navegador.zip" | cut -d' ' -f1)"
    local_zip="$REPO/dist/extension/adaceen-chromium-$esperado_nav.zip"
    # El zip es reproducible (scripts/empaquetar-extension.mjs): se arma aqui y se compara.
    if [ -n "$esperado_nav" ] && command -v node >/dev/null 2>&1 && [ -f "$REPO/scripts/empaquetar-extension.mjs" ] &&
      (cd "$REPO" && node scripts/empaquetar-extension.mjs >/dev/null 2>&1) && [ -f "$local_zip" ]; then
      chequeo "$(todas [ "$(sha256sum "$local_zip" | cut -d' ' -f1)" = "$publicado" ])" \
        "el zip publicado es el que sale de $(ruta_repo) (SHA-256 $publicado)" "el flujo empaqueto otro commit: compara con git log -1"
    else
      chequeo omitido "SHA-256 del zip publicado: $publicado" "sin node o sin scripts/empaquetar-extension.mjs no lo comparo"
    fi
  fi
}

verificar_azure() {
  titulo "App Service (variables, sin valores)"
  if ! comprobar_az; then
    explicar_az
    chequeo omitido "variables, huellas e instancias del App Service" "sin az"
    return 0
  fi
  if ! leer_azure; then
    chequeo no "az lee las variables de $APP" "$AZ_ERROR"
    return 0
  fi
  chequeo "$(todas [ "${AZ[proveedor_ok]:-}" = si ] -- [ "${AZ[url_publica_ok]:-}" = si ] -- [ "${AZ[agente_url]:-}" = no ] -- [ "${AZ[transporte_ok]:-}" = si ])" \
    "ADACEEN_WORKSPACE_PROVIDER tunnel, PUBLIC_BASE_URL la del backend, WORKSPACE_AGENT_URL sin valor" "bash deploy/produccion.sh aplicar"
  chequeo "$(todas [ "${AZ[sal]:-}" = si ] -- [ -n "${AZ[latido]:-}" ])" "TELEMETRY_SALT y WORKER_HEARTBEAT_TOKEN con valor" "bash deploy/produccion.sh aplicar"
  if leer_capacidad; then
    chequeo "$(todas [ "$INSTANCIAS_APP" = 1 ])" "una sola instancia del App Service ($INSTANCIAS_APP)" "el relay vive en la memoria del proceso: deja 1 instancia"
  else
    chequeo omitido "una sola instancia" "no pude leer el plan del App Service"
  fi
}

verificar_vm() {
  local zona estado salida vscode clase linea relay bloqueo
  [ "$SIN_VM" = 0 ] || return 0
  titulo "VM de editores $VM_EDITORES (seccion 4.5)"
  zona="$(zona_de "$VM_EDITORES")"
  if [ -z "$zona" ] || ! leer_vm "$VM_EDITORES"; then
    chequeo no "existe la VM $VM_EDITORES en $PROYECTO" "PROYECTO=$PROYECTO_POR_DEFECTO bash deploy/produccion.sh verificar"
    return 0
  fi
  chequeo "$(todas [ "${M[$VM_EDITORES.rama]:-}" = "$RAMA_PRODUCCION" ] -- [ "${M[$VM_EDITORES.startup]:-}" = nuevo ])" \
    "metadata de $VM_EDITORES: branch=$RAMA_PRODUCCION y el startup-ws.sh de $(ruta_repo)" "bash deploy/produccion.sh aplicar"
  if [ "$AZ_LEIDO" = 1 ]; then
    chequeo "$(todas [ -n "${AZ[token]:-}" ] -- [ "${AZ[token]:-}" = "${M[$VM_EDITORES.token]:-}" ])" \
      "WORKSPACE_AGENT_TOKEN igual en Azure y en la metadata (huella ${M[$VM_EDITORES.token]:-sin valor})" \
      "bash deploy/produccion.sh aplicar (rota el token en los dos lados)"
    if [ -n "${AZ[scan]:-}" ]; then
      chequeo "$(todas [ "${AZ[scan]:-}" = "${M[$VM_EDITORES.scan]:-}" ])" "scan-worker-key igual a ADACEEN_SCAN_WORKER_KEY" "bash deploy/produccion.sh aplicar"
    fi
  fi
  estado="$(estado_de "$VM_EDITORES")"
  if [ "$estado" != "RUNNING" ]; then
    chequeo no "$VM_EDITORES encendida (esta en $estado)" "bash deploy/clase.sh iniciar, o bash deploy/produccion.sh aplicar --encender-vm"
    return 0
  fi
  salida="$PRIV/ssh-verificar"
  if ! por_iap "$REMOTO_VERIFICAR" "$salida"; then
    chequeo no "entrar por IAP a $VM_EDITORES" "$(error_limpio "$PRIV/err-ssh")"
  else
    chequeo "$(todas grep -qx 'metadata=active' "$salida")" "servicio adaceen-ws-metadata active" "en la VM: sudo journalctl -u adaceen-ws-metadata"
    chequeo "$(todas grep -qx 'agente=active' "$salida")" "servicio adaceen-workspaces-agent active" "bash deploy/produccion.sh aplicar"
    relay="$(sed -n 's/^relay=//p' "$salida")"
    case "${relay%%$'\n'*}" in
      "conectado al relay") chequeo si "journal del agente: el ultimo evento del relay es «conectado al relay»" ;;
      "el relay rechazo el token")
        chequeo no "journal del agente: «el relay rechazo el token»" "Azure y la VM tienen tokens distintos: bash deploy/produccion.sh aplicar"
        ;;
      "relay sin conexion")
        chequeo no "journal del agente: el ultimo evento del relay es «relay sin conexion; se reintenta»" \
          "el agente perdio la conexion y reintenta (por ejemplo, mientras Azure reinicia): espera un minuto y vuelve a correr verificar"
        ;;
      *) chequeo no "journal del agente: no dice «conectado al relay» en las ultimas 200 lineas" "bash deploy/produccion.sh aplicar" ;;
    esac
    bloqueo="$(sed -n 's/^bloqueo=//p' "$salida" | head -n 1)"
    case "$bloqueo" in
      7) chequeo si "la metadata esta bloqueada para quien no es root (probado con el usuario nobody: conexion rechazada)" ;;
      0)
        chequeo no "la metadata esta bloqueada para quien no es root: el usuario nobody la lee" \
          "en la VM: sudo journalctl -u adaceen-ws-metadata (docs/workspaces-tunnel.md, Seguridad de la VM)"
        ;;
      *)
        case "$bloqueo" in
          sin-prueba) bloqueo="la VM no tiene el usuario nobody o curl" ;;
          "") bloqueo="sin respuesta" ;;
          *) bloqueo="curl termino con el codigo ${bloqueo//[^0-9]/}" ;;
        esac
        chequeo omitido "la metadata esta bloqueada para quien no es root" \
          "no pude probarlo con el usuario nobody: $bloqueo; se prueba con el estudiante (anexo, seccion 4.5)"
        ;;
    esac
    vscode="$(version_vscode_esperada)"
    analizar_log "$salida" "$vscode"
    if [ -n "$LOG_LINEAS" ]; then mostrar_log; fi
    if [ -z "$LOG_FALTA$LOG_AVISOS" ]; then
      chequeo si "ultimo arranque: PDC $RAMA_PRODUCCION, VSIX ${vscode:-nuevo}, agente con relay y listo, sin avisos"
    else
      chequeo no "ultimo arranque completo y sin avisos" "${LOG_FALTA:+falta: $LOG_FALTA. }$(tr '\n' ' ' <<<"$LOG_AVISOS")"
    fi
  fi
  clase="$(BACKEND="$BACKEND" PROYECTO="$PROYECTO" GPUS="$GPUS" VM_EDITORES="$VM_EDITORES" bash "$DIR_SCRIPT/clase.sh" estado </dev/null 2>&1 || true)"
  while IFS= read -r linea; do
    case "$linea" in *"] editor:"* | *"AVISO: editor:"*) printf '    %s\n' "$linea" ;; esac
  done <<<"$clase"
  chequeo "$(todas grep -qF "editor: listo (agente de $VM_EDITORES conectado)" <<<"$clase")" \
    "bash deploy/clase.sh estado: editor listo (agente de $VM_EDITORES conectado)"
}

verificar_gpus() {
  local vm
  [ "$SIN_GPU" = 0 ] || return 0
  titulo "GPU (seccion 5)"
  for vm in $GPUS; do
    if [ -z "$(zona_de "$vm")" ]; then
      info "$vm: no existe en $PROYECTO (se omite)"
      continue
    fi
    if ! leer_vm "$vm"; then
      chequeo no "$vm: metadata legible"
      continue
    fi
    chequeo "$(todas [ "${M[$vm.startup]:-}" = nuevo ] -- [ "${M[$vm.rama]:-}" = "$RAMA_PRODUCCION" ])" \
      "$vm: startup-script de $(ruta_repo) y branch=$RAMA_PRODUCCION" "bash deploy/produccion.sh aplicar"
    if [ "$AZ_LEIDO" = 1 ]; then
      chequeo "$(todas [ -n "${M[$vm.latido]:-}" ] -- [ "${M[$vm.latido]:-}" = "${AZ[latido]:-}" ])" \
        "$vm: heartbeat-token igual a WORKER_HEARTBEAT_TOKEN (huella ${M[$vm.latido]:-sin valor})" "runbook, seccion 5"
    else
      chequeo "$(todas [ -n "${M[$vm.latido]:-}" ])" "$vm: tiene heartbeat-token" "runbook, seccion 5"
    fi
    case "${M[$vm.worker_id]:-}" in
      gce-*) chequeo si "$vm: worker-id ${M[$vm.worker_id]}" ;;
      *) chequeo no "$vm: worker-id ${M[$vm.worker_id]:-vacio} (debe empezar por gce-)" \
        "gcloud compute instances add-metadata $vm --zone=$(zona_de "$vm") --metadata=worker-id=gce-<perfil>" ;;
    esac
  done
}

accion_verificar() {
  local f
  herramientas
  encabezado
  comprobar_az || true
  leer_instancias || fallar "gcloud no pudo listar las VMs de $PROYECTO: $INSTANCIAS_ERROR (¿gcloud auth login?)"
  avisar_repetidas
  leer_salud || true
  verificar_backend
  verificar_azure
  verificar_vm
  verificar_gpus

  printf '\n'
  info "falta lo que necesita un estudiante real: despues del primer «Preparar mi editor» (paso P1.4 de la prueba), el archivo editor-session.json de ws-<login> (anexo, seccion 4.5)"
  if [ "$N_MAL" -gt 0 ]; then
    mal "verificar: $N_OK ✓, $N_MAL ✗, $N_OMITIDO sin comprobar"
    for f in "${FALLAS[@]}"; do printf '    ✗ %s\n' "$f"; done
    exit 1
  fi
  ok "verificar: $N_OK ✓, 0 ✗, $N_OMITIDO sin comprobar"
}

case "$ACCION" in
  revisar) accion_revisar ;;
  aplicar) accion_aplicar ;;
  verificar) accion_verificar ;;
esac
