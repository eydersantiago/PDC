#!/usr/bin/env bash
# Cuenta de servicio para que el backend encienda solo la VM de editores cuando
# un estudiante pide su editor y la VM esta apagada
# (docs/arquitectura/acceso-simplificado.md, seccion 5).
#
#   bash deploy/gcp/crear-cuenta-autoencendido.sh              rol, cuenta, permiso y una clave
#   bash deploy/gcp/crear-cuenta-autoencendido.sh --sin-clave  lo mismo, sin crear clave
#   bash deploy/gcp/crear-cuenta-autoencendido.sh borrar       quita el permiso, la cuenta (con sus claves) y el rol
#
# Minimo privilegio: un rol personalizado con SOLO compute.instances.get y
# compute.instances.start, concedido sobre la VM de editores y no sobre el
# proyecto. Con esa clave se puede encender esa VM y leer su descripcion, que
# incluye la metadata: el token del agente de editores (workspace-agent-token)
# y, si esta, scan-worker-key. No se puede apagarla, ni borrarla, ni tocar las
# GPU. Si la clave se filtra hay que revocarla Y rotar WORKSPACE_AGENT_TOKEN.
# Se puede correr las veces que haga falta: rol, cuenta y permiso quedan
# iguales. La clave NUNCA se muestra en pantalla: queda en un archivo 600 y,
# si este script la carga en Azure (RG y az), se borra al terminar.
#
# Variables: PROYECTO, VM (adaceen-ws), ZONA (defecto: la de la VM),
# CUENTA (adaceen-autoencendido), ROL (adaceenAutoencendido),
# CARPETA_CLAVE (~/.adaceen-autoencendido), NUEVA_CLAVE=1 (otra clave aunque
# ya haya una), RG y APP (App Service): con la CLI de Azure (az) y RG, carga la
# configuracion en Azure ahi mismo, sin mostrar la clave.
set -euo pipefail

DIR_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/comun-gcp.sh
. "$DIR_SCRIPT/comun-gcp.sh"

ACCION="crear"
CON_CLAVE=1
for arg in "$@"; do
  case "$arg" in
    borrar) ACCION="borrar" ;;
    --sin-clave) CON_CLAVE=0 ;;
    -h | --help | --ayuda) sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fallar "opcion desconocida: $arg (usa --sin-clave, borrar o --ayuda)" ;;
  esac
done

requiere_gcloud
PROYECTO=$(resolver_proyecto)
VM=${VM:-$VM_EDITORES_POR_DEFECTO}
CUENTA=${CUENTA:-adaceen-autoencendido}
ROL=${ROL:-adaceenAutoencendido}
APP=${APP:-app-adaceen-api-eyder05232002}
RG=${RG:-}
CARPETA_CLAVE=${CARPETA_CLAVE:-$HOME/.adaceen-autoencendido}
EMAIL="$CUENTA@$PROYECTO.iam.gserviceaccount.com"
ROL_COMPLETO="projects/$PROYECTO/roles/$ROL"
PERMISOS="compute.instances.get,compute.instances.start"
[[ $CUENTA =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || fallar "CUENTA debe tener de 6 a 30 letras minusculas, numeros o guiones"
[[ $ROL =~ ^[A-Za-z0-9_.]{3,64}$ ]] || fallar "ROL solo admite letras, numeros, _ y ."

ERR="$(mktemp "${TMPDIR:-/tmp}/adaceen-iam.XXXXXX")"
trap 'rm -f "$ERR"' EXIT

if [ -z "${ZONA:-}" ]; then
  leer_instancias || fallar "gcloud no pudo listar las VMs de $PROYECTO: $INSTANCIAS_ERROR"
  ZONA="$(zona_de "$VM")"
  # Para borrar no hace falta la VM: si ya no existe, igual se quitan la cuenta y el rol.
  if [ -z "$ZONA" ] && [ "$ACCION" != "borrar" ]; then
    fallar "no existe la VM $VM en $PROYECTO (crea la VM de editores con deploy/gcp/workspaces/create-ws-vm.sh o pasa VM=<nombre>)"
  fi
fi
info "proyecto $PROYECTO | VM $VM (${ZONA:-ya no existe}) | cuenta $EMAIL"

# Reintenta un comando de IAM: una cuenta recien creada tarda unos segundos en existir para los demas servicios.
con_reintentos() {
  local intento
  for intento in 1 2 3 4 5 6; do
    if "$@" >/dev/null 2>"$ERR"; then return 0; fi
    [ "$intento" -lt 6 ] && sleep 5
  done
  return 1
}

if [ "$ACCION" = "borrar" ]; then
  if [ -z "$ZONA" ]; then
    info "la VM $VM ya no existe: no hay permiso que quitar"
  elif gcloud compute instances remove-iam-policy-binding "$VM" --zone="$ZONA" --project="$PROYECTO" \
    --member="serviceAccount:$EMAIL" --role="$ROL_COMPLETO" --quiet >/dev/null 2>"$ERR"; then
    ok "quitado el permiso de $EMAIL sobre $VM"
  else
    info "el permiso sobre $VM ya no estaba"
  fi
  if gcloud iam service-accounts delete "$EMAIL" --project="$PROYECTO" --quiet >/dev/null 2>"$ERR"; then
    ok "borrada la cuenta $EMAIL (y con ella todas sus claves)"
  else
    info "la cuenta $EMAIL ya no estaba"
  fi
  if gcloud iam roles delete "$ROL" --project="$PROYECTO" --quiet >/dev/null 2>"$ERR"; then
    ok "borrado el rol $ROL_COMPLETO"
  else
    info "el rol $ROL_COMPLETO ya no estaba"
  fi
  cat <<FIN

Falta, a mano:
  - En Azure, quitar la configuracion (el backend vuelve a decir «avisa al docente»):
      az webapp config appsettings delete --resource-group ${RG:-<grupo>} --name $APP \\
        --setting-names WORKSPACE_VM_AUTOSTART WORKSPACE_VM_PROJECT WORKSPACE_VM_ZONE WORKSPACE_VM_NAME GCP_SERVICE_ACCOUNT_JSON
  - Borrar las copias locales de la clave:  rm -rf "$CARPETA_CLAVE"
FIN
  exit 0
fi

# ---------------------------------------------------------------- rol
ROL_BORRADO="$(gcloud iam roles describe "$ROL" --project="$PROYECTO" --format='value(deleted)' 2>/dev/null)" && ROL_EXISTE=1 || ROL_EXISTE=0
if [ "$ROL_EXISTE" = 0 ]; then
  gcloud iam roles create "$ROL" --project="$PROYECTO" \
    --title="ADACEEN: encender la VM de editores" \
    --description="Solo consultar y encender la VM de editores (deploy/gcp/crear-cuenta-autoencendido.sh)" \
    --permissions="$PERMISOS" --stage=GA --quiet >/dev/null 2>"$ERR" ||
    fallar "no se pudo crear el rol $ROL: $(resumir_error "$ERR")"
  ok "rol $ROL_COMPLETO creado ($PERMISOS)"
else
  case "$ROL_BORRADO" in
    [Tt]rue)
      gcloud iam roles undelete "$ROL" --project="$PROYECTO" --quiet >/dev/null 2>"$ERR" ||
        fallar "el rol $ROL esta borrado y no se pudo recuperar: $(resumir_error "$ERR")"
      ;;
  esac
  # Deja exactamente esos dos permisos, aunque alguien haya agregado otros.
  gcloud iam roles update "$ROL" --project="$PROYECTO" --permissions="$PERMISOS" --quiet >/dev/null 2>"$ERR" ||
    fallar "no se pudo actualizar el rol $ROL: $(resumir_error "$ERR")"
  ok "rol $ROL_COMPLETO al dia ($PERMISOS)"
fi

# ---------------------------------------------------------------- cuenta
if gcloud iam service-accounts describe "$EMAIL" --project="$PROYECTO" >/dev/null 2>&1; then
  ok "cuenta $EMAIL ya existe"
else
  gcloud iam service-accounts create "$CUENTA" --project="$PROYECTO" \
    --display-name="ADACEEN autoencendido de la VM de editores" \
    --description="La usa el backend en Azure para encender $VM (WORKSPACE_VM_AUTOSTART=gcp)" \
    --quiet >/dev/null 2>"$ERR" ||
    fallar "no se pudo crear la cuenta $CUENTA: $(resumir_error "$ERR")"
  ok "cuenta $EMAIL creada"
fi

# ---------------------------------------------------------------- permiso (solo sobre la VM)
con_reintentos gcloud compute instances add-iam-policy-binding "$VM" --zone="$ZONA" --project="$PROYECTO" \
  --member="serviceAccount:$EMAIL" --role="$ROL_COMPLETO" --quiet ||
  fallar "no se pudo dar el permiso sobre $VM: $(resumir_error "$ERR")"
ok "permiso $ROL sobre la VM $VM (no sobre el proyecto)"

CARGAR_EN_AZURE="az webapp config appsettings set --resource-group ${RG:-<grupo>} --name $APP --output none --settings"
AJUSTES="WORKSPACE_VM_AUTOSTART=gcp WORKSPACE_VM_PROJECT=$PROYECTO WORKSPACE_VM_ZONE=$ZONA WORKSPACE_VM_NAME=$VM"

if [ "$CON_CLAVE" = 0 ]; then
  info "sin clave (--sin-clave). Para crearla: bash deploy/gcp/crear-cuenta-autoencendido.sh"
  exit 0
fi

# ---------------------------------------------------------------- clave
CLAVES="$(gcloud iam service-accounts keys list --iam-account="$EMAIL" --project="$PROYECTO" \
  --managed-by=user --format='value(name.basename(),validAfterTime)' 2>/dev/null || true)"
if [ -n "$CLAVES" ] && [ "${NUEVA_CLAVE:-0}" != 1 ]; then
  info "la cuenta ya tiene clave(s) (id y fecha; el id no es secreto):"
  printf '%s\n' "$CLAVES" | sed 's/^/    /'
  info "si una ya esta cargada en Azure y funciona, no hace falta otra"
  respuesta=""
  if [ -t 0 ]; then
    read -r -p "[adaceen] ¿Crear otra clave? [s/N] " respuesta || respuesta=""
  fi
  case "$respuesta" in
    s | S | si | SI | Si) ;;
    *)
      info "no se creo otra clave (NUEVA_CLAVE=1 para crearla sin preguntar)"
      info "para borrar una: gcloud iam service-accounts keys delete <id> --iam-account=$EMAIL --project=$PROYECTO"
      exit 0
      ;;
  esac
fi

mkdir -p "$CARPETA_CLAVE"
chmod 700 "$CARPETA_CLAVE"
ARCHIVO="$CARPETA_CLAVE/clave-$(date +%Y%m%d-%H%M%S).json"
if ! (umask 077 && gcloud iam service-accounts keys create "$ARCHIVO" --iam-account="$EMAIL" \
  --project="$PROYECTO" --quiet >/dev/null 2>"$ERR"); then
  rm -f "$ARCHIVO"
  if grep -q 'disableServiceAccountKeyCreation' "$ERR"; then
    aviso "la organizacion prohibe crear claves de cuentas de servicio (politica iam.disableServiceAccountKeyCreation)."
    aviso "Un administrador de la organizacion puede exceptuar este proyecto:"
    aviso "  gcloud resource-manager org-policies disable-enforce iam.disableServiceAccountKeyCreation --project=$PROYECTO"
    aviso "y luego vuelves a correr este script. Sin clave no hay autoencendido: el docente enciende la VM con bash deploy/clase.sh iniciar."
    exit 1
  fi
  fallar "no se pudo crear la clave: $(resumir_error "$ERR")"
fi
chmod 600 "$ARCHIVO"
ID_CLAVE="$(python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get("client_email") and "PRIVATE KEY" in d.get("private_key", "")
print(d.get("private_key_id", "?"))
' "$ARCHIVO" 2>/dev/null)" || fallar "la clave creada en $ARCHIVO no tiene el formato esperado"
ok "clave creada en $ARCHIVO (permisos 600; id $ID_CLAVE)"

# Si hay CLI de Azure y grupo de recursos, se carga ahi mismo (la clave va por
# la linea de comandos de az, nunca a la pantalla; --output none evita que az
# imprima la configuracion con sus valores).
CARGADA=0
if [ -n "$RG" ] && command -v az >/dev/null 2>&1; then
  info "cargando la configuracion en el App Service $APP ($RG)..."
  # shellcheck disable=SC2086  # AJUSTES son pares CLAVE=valor sin espacios
  if az webapp config appsettings set --resource-group "$RG" --name "$APP" --output none --settings \
    $AJUSTES GCP_SERVICE_ACCOUNT_JSON="$(base64 <"$ARCHIVO" | tr -d '\n')" 2>"$ERR"; then
    ok "configuracion cargada en Azure; el App Service se reinicia solo (1-2 min)"
    CARGADA=1
    # Azure ya la tiene: una copia menos. Si hiciera falta otra, se crea (NUEVA_CLAVE=1).
    rm -f "$ARCHIVO"
    ok "borre la copia local de la clave ($ARCHIVO)"
  else
    aviso "az no pudo cargarla: $(resumir_error "$ERR")"
  fi
elif [ -n "$RG" ]; then
  aviso "RG=$RG, pero en esta terminal no esta la CLI de Azure (az): no la cargo"
fi

echo
if [ "$CARGADA" = 0 ]; then
  cat <<FIN
Carga la configuracion en Azure con la CLI de Azure, en una terminal donde este
el archivo de la clave (el \$(...) lee el archivo: la clave no se ve en pantalla):

  $CARGAR_EN_AZURE \\
    $AJUSTES \\
    GCP_SERVICE_ACCOUNT_JSON="\$(base64 < $ARCHIVO | tr -d '\\n')"

  Cloud Shell de Google no trae az. NO descargues la clave a tu equipo:
  instala az aqui mismo, entra y corre el comando de arriba:
      curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
      az login --use-device-code
  Despues borra la copia local:  rm -f "$ARCHIVO"

FIN
fi
cat <<FIN
Comprobar: $BACKEND_PRODUCCION/api/health -> "workspace_vm_autostart": true

IMPORTANTE: la clave es un SECRETO. Con ella se puede encender la VM $VM y
leer su metadata, que incluye el token del agente de editores
(workspace-agent-token): con ese token alguien podria hacerse pasar por el
agente y recibir las sesiones de editor de los estudiantes. No la subas al
repositorio, no la pegues en chats, no la copies a otro equipo ni la dejes en
una carpeta compartida.
  - Si se filtro, las dos cosas:
      1. revocarla:  gcloud iam service-accounts keys delete $ID_CLAVE --iam-account=$EMAIL --project=$PROYECTO
      2. rotar WORKSPACE_AGENT_TOKEN en el App Service y en la metadata
         workspace-agent-token de $VM (docs/workspaces-tunnel.md, «rotar el token del agente»)
    y crear otra clave con este script.
  - Para quitar todo (rol, cuenta y claves):
      bash deploy/gcp/crear-cuenta-autoencendido.sh borrar
FIN
