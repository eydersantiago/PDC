#!/usr/bin/env bash
# Federacion de identidades (Workload Identity Federation) para que el backend en
# Azure encienda la VM de editores y las GPU SIN clave de cuenta de servicio
# (docs/arquitectura/acceso-simplificado.md, seccion 5; docs/operacion/runbook.md, 0).
# Sirve cuando la organizacion de Google Cloud prohibe crear claves
# (iam.disableServiceAccountKeyCreation): el App Service pide el token de su
# identidad administrada y Google lo canjea por uno de la cuenta de servicio.
#
#   bash deploy/gcp/crear-federacion-autoencendido.sh            pool, proveedor OIDC de Azure, permiso y variables en Azure
#   bash deploy/gcp/crear-federacion-autoencendido.sh --github   ademas, un proveedor para GitHub Actions del repositorio
#   bash deploy/gcp/crear-federacion-autoencendido.sh borrar     quita permisos, proveedores y pool
#
# Antes: bash deploy/gcp/crear-cuenta-autoencendido.sh --sin-clave (rol minimo, cuenta
# y permiso sobre la VM de editores y las GPU). Se puede correr las veces que haga
# falta: lo que ya existe se reutiliza o se pone al dia. Nunca imprime secretos
# (aqui no hay ninguno: el pool, el proveedor, el principalId y el correo de la
# cuenta no lo son).
#
# Variables: PROYECTO, CUENTA (adaceen-autoencendido), POOL (adaceen-azure),
# PROVEEDOR (azure), RECURSO_AZURE (api://adaceen-gcp: audience que pide la identidad
# administrada; con az se registra esa aplicacion en Azure AD si falta), TENANT_ID
# (defecto: el de `az account show`), RG y APP (App Service: con az, habilita la
# identidad administrada, da el permiso a su principalId y carga las variables),
# PRINCIPAL_ID (sin az: el principalId de la identidad administrada), VM (adaceen-ws)
# y GPUS (para WORKSPACE_VM_* y CLASS_GPU_VMS; zonas leidas de las VMs),
# REPO_GITHUB (eydersantiago/PDC) y PROVEEDOR_GITHUB (github) con --github.
set -euo pipefail

DIR_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/comun-gcp.sh
. "$DIR_SCRIPT/comun-gcp.sh"

ACCION="crear"
CON_GITHUB=0
for arg in "$@"; do
  case "$arg" in
    borrar) ACCION="borrar" ;;
    --github) CON_GITHUB=1 ;;
    -h | --help | --ayuda) sed -n '2,29p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fallar "opcion desconocida: $arg (usa --github, borrar o --ayuda)" ;;
  esac
done

requiere_gcloud
PROYECTO=$(resolver_proyecto)
CUENTA=${CUENTA:-adaceen-autoencendido}
POOL=${POOL:-adaceen-azure}
PROVEEDOR=${PROVEEDOR:-azure}
PROVEEDOR_GITHUB=${PROVEEDOR_GITHUB:-github}
REPO_GITHUB=${REPO_GITHUB:-eydersantiago/PDC}
RECURSO_AZURE=${RECURSO_AZURE:-api://adaceen-gcp}
APP=${APP:-app-adaceen-api-eyder05232002}
RG=${RG:-}
TENANT_ID=${TENANT_ID:-}
PRINCIPAL_ID=${PRINCIPAL_ID:-}
VM=${VM:-$VM_EDITORES_POR_DEFECTO}
GPUS=${GPUS-$GPUS_POR_DEFECTO}
[ "$GPUS" = "ninguna" ] && GPUS=""
EMAIL="$CUENTA@$PROYECTO.iam.gserviceaccount.com"
[[ $CUENTA =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || fallar "CUENTA debe tener de 6 a 30 letras minusculas, numeros o guiones"
[[ $POOL =~ ^[a-z][a-z0-9-]{2,30}[a-z0-9]$ ]] || fallar "POOL debe tener de 4 a 32 letras minusculas, numeros o guiones"
[[ $PROVEEDOR =~ ^[a-z][a-z0-9-]{2,30}[a-z0-9]$ ]] || fallar "PROVEEDOR debe tener de 4 a 32 letras minusculas, numeros o guiones"
[[ $PROVEEDOR_GITHUB =~ ^[a-z][a-z0-9-]{2,30}[a-z0-9]$ ]] || fallar "PROVEEDOR_GITHUB debe tener de 4 a 32 letras minusculas, numeros o guiones"
[[ $REPO_GITHUB =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fallar "REPO_GITHUB debe ser dueno/repositorio"
[[ $RECURSO_AZURE =~ ^[A-Za-z][A-Za-z0-9+.-]*://[^[:space:]]+$ ]] || fallar "RECURSO_AZURE debe ser una URI (p. ej. api://adaceen-gcp)"

ERR="$(mktemp "${TMPDIR:-/tmp}/adaceen-wif.XXXXXX")"
trap 'rm -f "$ERR"' EXIT

HAY_AZ=0
command -v az >/dev/null 2>&1 && HAY_AZ=1

NUMERO="$(gcloud projects describe "$PROYECTO" --format='value(projectNumber)' 2>"$ERR")" ||
  fallar "no pude leer el numero del proyecto $PROYECTO: $(resumir_error "$ERR") (¿gcloud auth login?)"
[[ $NUMERO =~ ^[0-9]+$ ]] || fallar "el numero del proyecto $PROYECTO no es un numero: $NUMERO"
POOL_RUTA="projects/$NUMERO/locations/global/workloadIdentityPools/$POOL"
AUDIENCE="//iam.googleapis.com/$POOL_RUTA/providers/$PROVEEDOR"
PROVEEDOR_GITHUB_RUTA="$POOL_RUTA/providers/$PROVEEDOR_GITHUB"
MIEMBRO_GITHUB="principalSet://iam.googleapis.com/$POOL_RUTA/attribute.repository/$REPO_GITHUB"
info "proyecto $PROYECTO ($NUMERO) | cuenta $EMAIL | pool $POOL | proveedor $PROVEEDOR"

# Identidad administrada del App Service: su principalId es el "subject" del token de Azure.
if [ -z "$PRINCIPAL_ID" ] && [ "$HAY_AZ" = 1 ] && [ -n "$RG" ]; then
  if PRINCIPAL_ID="$(az webapp identity assign --resource-group "$RG" --name "$APP" --query principalId -o tsv 2>"$ERR")"; then
    PRINCIPAL_ID="${PRINCIPAL_ID//[[:space:]]/}"
    ok "identidad administrada del App Service $APP habilitada (principalId $PRINCIPAL_ID)"
  else
    PRINCIPAL_ID=""
    aviso "az no pudo habilitar la identidad administrada de $APP ($RG): $(resumir_error "$ERR")"
  fi
fi
if [ -n "$PRINCIPAL_ID" ] && ! [[ $PRINCIPAL_ID =~ ^[0-9a-fA-F-]{36}$ ]]; then
  fallar "PRINCIPAL_ID no parece un id de Azure (GUID): $PRINCIPAL_ID"
fi
MIEMBRO_AZURE="principal://iam.googleapis.com/$POOL_RUTA/subject/${PRINCIPAL_ID:-<principalId>}"

# Reintenta un comando de IAM: un recurso recien creado tarda unos segundos en existir para los demas servicios.
con_reintentos() {
  local intento
  for intento in 1 2 3 4 5 6; do
    if "$@" >/dev/null 2>"$ERR"; then return 0; fi
    [ "$intento" -lt 6 ] && sleep 5
  done
  return 1
}

proveedor_existe() {
  gcloud iam workload-identity-pools providers describe "$1" --workload-identity-pool="$POOL" \
    --location=global --project="$PROYECTO" >/dev/null 2>&1
}

# ---------------------------------------------------------------- borrar
if [ "$ACCION" = "borrar" ]; then
  if [ -n "$PRINCIPAL_ID" ]; then
    if gcloud iam service-accounts remove-iam-policy-binding "$EMAIL" --project="$PROYECTO" \
      --role=roles/iam.workloadIdentityUser --member="$MIEMBRO_AZURE" --quiet >/dev/null 2>"$ERR"; then
      ok "quitado el permiso de la identidad administrada ($PRINCIPAL_ID) sobre $EMAIL"
    else
      info "la identidad administrada ya no tenia permiso sobre $EMAIL"
    fi
  else
    aviso "sin PRINCIPAL_ID (ni az con RG) no puedo quitar el permiso de la identidad administrada; al borrar el pool deja de valer igual"
  fi
  if gcloud iam service-accounts remove-iam-policy-binding "$EMAIL" --project="$PROYECTO" \
    --role=roles/iam.workloadIdentityUser --member="$MIEMBRO_GITHUB" --quiet >/dev/null 2>"$ERR"; then
    ok "quitado el permiso de GitHub Actions ($REPO_GITHUB) sobre $EMAIL"
  else
    info "GitHub Actions no tenia permiso sobre $EMAIL"
  fi
  for proveedor in "$PROVEEDOR" "$PROVEEDOR_GITHUB"; do
    if gcloud iam workload-identity-pools providers delete "$proveedor" --workload-identity-pool="$POOL" \
      --location=global --project="$PROYECTO" --quiet >/dev/null 2>"$ERR"; then
      ok "borrado el proveedor $proveedor"
    else
      info "el proveedor $proveedor ya no estaba"
    fi
  done
  if gcloud iam workload-identity-pools delete "$POOL" --location=global --project="$PROYECTO" --quiet >/dev/null 2>"$ERR"; then
    ok "borrado el pool $POOL (Google lo conserva 30 dias; este script lo recupera si se vuelve a correr)"
  else
    info "el pool $POOL ya no estaba"
  fi
  cat <<FIN

Falta, a mano:
  - En Azure, quitar las variables (el backend vuelve a la clave, si la hay, o a «avisa al docente»):
      az webapp config appsettings delete --resource-group ${RG:-<grupo>} --name $APP \\
        --setting-names GCP_WORKLOAD_IDENTITY_AUDIENCE GCP_SERVICE_ACCOUNT_EMAIL GCP_AZURE_TOKEN_RESOURCE
  - En GitHub, si se uso --github: borrar los secretos GCP_WORKLOAD_IDENTITY_PROVIDER y GCP_SERVICE_ACCOUNT.
  - La cuenta y el rol los quita: bash deploy/gcp/crear-cuenta-autoencendido.sh borrar
FIN
  exit 0
fi

# ---------------------------------------------------------------- cuenta (la crea crear-cuenta-autoencendido.sh)
gcloud iam service-accounts describe "$EMAIL" --project="$PROYECTO" >/dev/null 2>&1 ||
  fallar "no existe la cuenta $EMAIL. Primero: bash deploy/gcp/crear-cuenta-autoencendido.sh --sin-clave"
ok "cuenta $EMAIL existe"

# Directorio de Azure: hace falta antes de crear nada (sin el no hay proveedor que configurar).
# Los tokens de la identidad administrada (api-version 2019-08-01) los emite
# https://sts.windows.net/<tenant>/ con sub = principalId y aud = el recurso pedido.
if [ -z "$TENANT_ID" ] && [ "$HAY_AZ" = 1 ]; then
  TENANT_ID="$(az account show --query tenantId -o tsv 2>/dev/null || true)"
  TENANT_ID="${TENANT_ID//[[:space:]]/}"
fi
[ -n "$TENANT_ID" ] || fallar "falta TENANT_ID (el id del directorio de Azure: Azure Portal -> Microsoft Entra ID -> Tenant ID, o az account show --query tenantId -o tsv). Pasalo: TENANT_ID=<id> bash deploy/gcp/crear-federacion-autoencendido.sh"
[[ $TENANT_ID =~ ^[0-9a-fA-F-]{36}$ ]] || fallar "TENANT_ID no parece un id de Azure (GUID): $TENANT_ID"
ISSUER_AZURE="https://sts.windows.net/$TENANT_ID/"

# ---------------------------------------------------------------- APIs
if gcloud services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  --project="$PROYECTO" --quiet >/dev/null 2>"$ERR"; then
  ok "APIs de IAM, IAM Credentials y STS habilitadas"
else
  aviso "no pude habilitar las APIs (iam, iamcredentials, sts): $(resumir_error "$ERR"). Si ya estan habilitadas, sigue"
fi

# ---------------------------------------------------------------- pool
ESTADO_POOL="$(gcloud iam workload-identity-pools describe "$POOL" --location=global --project="$PROYECTO" \
  --format='value(state)' 2>/dev/null)" && POOL_EXISTE=1 || POOL_EXISTE=0
if [ "$POOL_EXISTE" = 0 ]; then
  gcloud iam workload-identity-pools create "$POOL" --location=global --project="$PROYECTO" \
    --display-name="ADACEEN: backend en Azure" \
    --description="Identidades externas que encienden las VMs del piloto (deploy/gcp/crear-federacion-autoencendido.sh)" \
    --quiet >/dev/null 2>"$ERR" || fallar "no se pudo crear el pool $POOL: $(resumir_error "$ERR")"
  ok "pool $POOL creado"
else
  case "$ESTADO_POOL" in
    DELETED)
      gcloud iam workload-identity-pools undelete "$POOL" --location=global --project="$PROYECTO" --quiet >/dev/null 2>"$ERR" ||
        fallar "el pool $POOL esta borrado y no se pudo recuperar: $(resumir_error "$ERR")"
      ok "pool $POOL recuperado"
      ;;
    *) ok "pool $POOL ya existe" ;;
  esac
fi

# ---------------------------------------------------------------- proveedor OIDC de Azure
if proveedor_existe "$PROVEEDOR"; then
  gcloud iam workload-identity-pools providers update-oidc "$PROVEEDOR" --workload-identity-pool="$POOL" \
    --location=global --project="$PROYECTO" --issuer-uri="$ISSUER_AZURE" --allowed-audiences="$RECURSO_AZURE" \
    --attribute-mapping="google.subject=assertion.sub" --quiet >/dev/null 2>"$ERR" ||
    fallar "no se pudo actualizar el proveedor $PROVEEDOR: $(resumir_error "$ERR")"
  ok "proveedor $PROVEEDOR al dia (issuer $ISSUER_AZURE, audience $RECURSO_AZURE)"
else
  con_reintentos gcloud iam workload-identity-pools providers create-oidc "$PROVEEDOR" --workload-identity-pool="$POOL" \
    --location=global --project="$PROYECTO" --display-name="Identidad administrada del App Service" \
    --issuer-uri="$ISSUER_AZURE" --allowed-audiences="$RECURSO_AZURE" \
    --attribute-mapping="google.subject=assertion.sub" --quiet ||
    fallar "no se pudo crear el proveedor $PROVEEDOR: $(resumir_error "$ERR")"
  ok "proveedor $PROVEEDOR creado (issuer $ISSUER_AZURE, audience $RECURSO_AZURE)"
fi

# ---------------------------------------------------------------- permiso de la identidad administrada
PERMISO_AZURE=0
if [ -n "$PRINCIPAL_ID" ]; then
  con_reintentos gcloud iam service-accounts add-iam-policy-binding "$EMAIL" --project="$PROYECTO" \
    --role=roles/iam.workloadIdentityUser --member="$MIEMBRO_AZURE" --quiet ||
    fallar "no se pudo dar el permiso a la identidad administrada: $(resumir_error "$ERR")"
  ok "la identidad administrada ($PRINCIPAL_ID) puede impersonar a $EMAIL (roles/iam.workloadIdentityUser)"
  PERMISO_AZURE=1
else
  aviso "sin PRINCIPAL_ID (y sin az con RG) no puedo dar el permiso a la identidad administrada; el comando va al final"
fi

# ---------------------------------------------------------------- --github: proveedor para GitHub Actions
if [ "$CON_GITHUB" = 1 ]; then
  ISSUER_GITHUB="https://token.actions.githubusercontent.com"
  MAPEO_GITHUB="google.subject=assertion.sub,attribute.repository=assertion.repository"
  CONDICION_GITHUB="assertion.repository == \"$REPO_GITHUB\""
  if proveedor_existe "$PROVEEDOR_GITHUB"; then
    gcloud iam workload-identity-pools providers update-oidc "$PROVEEDOR_GITHUB" --workload-identity-pool="$POOL" \
      --location=global --project="$PROYECTO" --issuer-uri="$ISSUER_GITHUB" \
      --attribute-mapping="$MAPEO_GITHUB" --attribute-condition="$CONDICION_GITHUB" --quiet >/dev/null 2>"$ERR" ||
      fallar "no se pudo actualizar el proveedor $PROVEEDOR_GITHUB: $(resumir_error "$ERR")"
    ok "proveedor $PROVEEDOR_GITHUB al dia (solo el repositorio $REPO_GITHUB)"
  else
    con_reintentos gcloud iam workload-identity-pools providers create-oidc "$PROVEEDOR_GITHUB" --workload-identity-pool="$POOL" \
      --location=global --project="$PROYECTO" --display-name="GitHub Actions de $REPO_GITHUB" \
      --issuer-uri="$ISSUER_GITHUB" --attribute-mapping="$MAPEO_GITHUB" --attribute-condition="$CONDICION_GITHUB" --quiet ||
      fallar "no se pudo crear el proveedor $PROVEEDOR_GITHUB: $(resumir_error "$ERR")"
    ok "proveedor $PROVEEDOR_GITHUB creado (solo el repositorio $REPO_GITHUB)"
  fi
  con_reintentos gcloud iam service-accounts add-iam-policy-binding "$EMAIL" --project="$PROYECTO" \
    --role=roles/iam.workloadIdentityUser --member="$MIEMBRO_GITHUB" --quiet ||
    fallar "no se pudo dar el permiso a GitHub Actions: $(resumir_error "$ERR")"
  ok "GitHub Actions de $REPO_GITHUB puede impersonar a $EMAIL"
fi

# ---------------------------------------------------------------- aplicacion en Azure AD para RECURSO_AZURE
# La identidad administrada solo recibe tokens para recursos registrados en el
# directorio: con api://... hace falta una aplicacion con ese Application ID URI.
if [ "$HAY_AZ" = 1 ]; then
  case "$RECURSO_AZURE" in
    api://*)
      APP_ID="$(az ad app list --identifier-uri "$RECURSO_AZURE" --query '[0].appId' -o tsv 2>/dev/null || true)"
      APP_ID="${APP_ID//[[:space:]]/}"
      if [ -z "$APP_ID" ]; then
        if APP_ID="$(az ad app create --display-name "ADACEEN federacion con Google Cloud" --identifier-uris "$RECURSO_AZURE" --query appId -o tsv 2>"$ERR")"; then
          APP_ID="${APP_ID//[[:space:]]/}"
          ok "aplicacion $RECURSO_AZURE registrada en Azure AD (appId $APP_ID)"
        else
          APP_ID=""
          aviso "az no pudo registrar la aplicacion $RECURSO_AZURE: $(resumir_error "$ERR"). Sin ella la identidad administrada no recibe tokens para ese recurso: registrala a mano (Microsoft Entra ID -> App registrations, Application ID URI $RECURSO_AZURE) o usa RECURSO_AZURE=https://management.azure.com/"
        fi
      else
        ok "aplicacion $RECURSO_AZURE ya registrada en Azure AD (appId $APP_ID)"
      fi
      if [ -n "$APP_ID" ] && ! az ad sp show --id "$APP_ID" >/dev/null 2>&1; then
        if az ad sp create --id "$APP_ID" --output none 2>"$ERR"; then
          ok "service principal de la aplicacion creado"
        else
          aviso "az no pudo crear el service principal de $APP_ID: $(resumir_error "$ERR")"
        fi
      fi
      ;;
  esac
fi

# ---------------------------------------------------------------- variables del App Service
AJUSTES="GCP_WORKLOAD_IDENTITY_AUDIENCE=$AUDIENCE GCP_SERVICE_ACCOUNT_EMAIL=$EMAIL GCP_AZURE_TOKEN_RESOURCE=$RECURSO_AZURE"
if leer_instancias; then
  ZONA_VM="$(zona_de "$VM")"
  if [ -n "$ZONA_VM" ]; then
    AJUSTES="$AJUSTES WORKSPACE_VM_AUTOSTART=gcp WORKSPACE_VM_PROJECT=$PROYECTO WORKSPACE_VM_ZONE=$ZONA_VM WORKSPACE_VM_NAME=$VM"
  else
    aviso "no existe la VM de editores $VM en $PROYECTO: no cargo WORKSPACE_VM_* (crea la VM y vuelve a correr, o VM=<nombre>)"
  fi
  CLASS_GPU_VMS=""
  for gpu in $GPUS; do
    zona="$(zona_de "$gpu")"
    if [ -n "$zona" ]; then
      CLASS_GPU_VMS="${CLASS_GPU_VMS:+$CLASS_GPU_VMS,}$gpu:$zona"
    else
      info "no existe la GPU $gpu en $PROYECTO (se omite de CLASS_GPU_VMS)"
    fi
  done
  if [ -n "$CLASS_GPU_VMS" ]; then
    AJUSTES="$AJUSTES CLASS_GPU_VMS=$CLASS_GPU_VMS"
    [ -n "$ZONA_VM" ] || AJUSTES="$AJUSTES WORKSPACE_VM_PROJECT=$PROYECTO"
  fi
else
  aviso "gcloud no pudo listar las VMs de $PROYECTO ($INSTANCIAS_ERROR): cargo solo las variables de la federacion"
fi

CARGADA=0
if [ "$HAY_AZ" = 1 ] && [ -n "$RG" ]; then
  info "cargando la configuracion en el App Service $APP ($RG)..."
  # shellcheck disable=SC2086  # AJUSTES son pares CLAVE=valor sin espacios
  if az webapp config appsettings set --resource-group "$RG" --name "$APP" --output none --settings $AJUSTES 2>"$ERR"; then
    ok "configuracion cargada en Azure; el App Service se reinicia solo (1-2 min)"
    CARGADA=1
  else
    aviso "az no pudo cargarla: $(resumir_error "$ERR")"
  fi
  # Si queda la clave, el backend la prefiere y la federacion no se usa (solo el nombre, nunca el valor).
  if az webapp config appsettings list --resource-group "$RG" --name "$APP" \
    --query "[?name=='GCP_SERVICE_ACCOUNT_JSON'].name" -o tsv 2>/dev/null | grep -q GCP_SERVICE_ACCOUNT_JSON; then
    aviso "el App Service todavia tiene GCP_SERVICE_ACCOUNT_JSON: el backend usa la clave y no la federacion. Para pasar a la federacion:"
    aviso "  az webapp config appsettings delete --resource-group $RG --name $APP --setting-names GCP_SERVICE_ACCOUNT_JSON"
  fi
elif [ -n "$RG" ]; then
  aviso "RG=$RG, pero en esta terminal no esta la CLI de Azure (az): no la cargo"
fi

echo
if [ "$PERMISO_AZURE" = 0 ] || [ "$CARGADA" = 0 ]; then
  cat <<FIN
Falta hacer con la CLI de Azure (az), en una terminal donde este (Cloud Shell de Google
no la trae: curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash; az login --use-device-code),
o vuelve a correr este script con RG=${RG:-<grupo>} donde este az:

FIN
  if [ "$PERMISO_AZURE" = 0 ]; then
    cat <<FIN
  1. Habilitar la identidad administrada del App Service y leer su principalId:
       az webapp identity assign --resource-group ${RG:-<grupo>} --name $APP --query principalId -o tsv
  2. Darle permiso para impersonar a la cuenta (en Cloud Shell de Google):
       gcloud iam service-accounts add-iam-policy-binding $EMAIL --project=$PROYECTO \\
         --role=roles/iam.workloadIdentityUser \\
         --member="principal://iam.googleapis.com/$POOL_RUTA/subject/<principalId>"
     (o PRINCIPAL_ID=<principalId> bash deploy/gcp/crear-federacion-autoencendido.sh)
FIN
  fi
  if [ "$CARGADA" = 0 ]; then
    cat <<FIN
  3. Cargar la configuracion (no hay secretos; --output none evita que az la repita):
       az webapp config appsettings set --resource-group ${RG:-<grupo>} --name $APP --output none --settings \\
         $AJUSTES
FIN
  fi
  echo
fi
cat <<FIN
Comprobar: $BACKEND_PRODUCCION/api/health -> "workspace_vm_autostart": true y "workspace_vm_auth": "federation"
  (con la clave todavia cargada dice "key": borra GCP_SERVICE_ACCOUNT_JSON del App Service).
Audience:  $AUDIENCE
Cuenta:    $EMAIL
Recurso:   $RECURSO_AZURE
Si un dia la organizacion deja crear claves no hace falta cambiar nada: la federacion sigue valiendo.
Para quitar todo: bash deploy/gcp/crear-federacion-autoencendido.sh borrar
FIN
if [ "$CON_GITHUB" = 1 ]; then
  cat <<FIN

GitHub Actions ($REPO_GITHUB): guarda estos dos valores como secretos del repositorio
(Settings -> Secrets and variables -> Actions); los lee .github/workflows/operacion.yml
con google-github-actions/auth (sin clave):
  GCP_WORKLOAD_IDENTITY_PROVIDER=$PROVEEDOR_GITHUB_RUTA
  GCP_SERVICE_ACCOUNT=$EMAIL
FIN
fi
