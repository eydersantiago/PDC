#!/usr/bin/env bash
# Vistas para Excel y Power BI y su usuario de solo lectura (analitica de aprendizaje, 29-10-2026).
#
#   bash deploy/bi/crear-bi.sh                    esquema bi, vistas (deploy/bi/vistas-bi.sql) y el usuario
#                                                 powerbi_lector (solo SELECT sobre bi, solo lectura)
#   bash deploy/bi/crear-bi.sh --ip=<tu IP>       ademas, una regla del cortafuegos de la base para tu PC
#                                                 (Power BI Desktop o Excel con Power Query)
#   bash deploy/bi/crear-bi.sh --rotar            nueva clave para powerbi_lector
#   bash deploy/bi/crear-bi.sh estado             que hay (vistas, usuario, cortafuegos); no cambia nada
#   bash deploy/bi/crear-bi.sh quitar             borra el usuario y el esquema bi (no toca los datos)
#
# Donde: la Cloud Shell de Azure (shell.azure.com: trae az, psql y python3). La conexion a la base se
# lee del App Service (DATABASE_URL) sin mostrarla; tambien vale DATABASE_URL en el entorno.
# Variables: RG (rg-adaceen-azure), APP (app-adaceen-api-eyder05232002), USUARIO (powerbi_lector),
# CREDENCIALES (~/adaceen-powerbi-lector.txt: host, base, usuario y clave, con permisos 600).
#
# La clave nunca se muestra ni viaja en claro a la base: el servidor recibe solo el verificador
# SCRAM-SHA-256 (calculado aqui con python3), asi no queda en un registro de sentencias.
# Las vistas no tienen nombres, correos, logins ni codigos estudiantiles (docs/analitica/excel-power-bi.md).
set -euo pipefail

RG="${RG:-rg-adaceen-azure}"
APP="${APP:-app-adaceen-api-eyder05232002}"
USUARIO="${USUARIO:-powerbi_lector}"
CREDENCIALES="${CREDENCIALES:-$HOME/adaceen-powerbi-lector.txt}"
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

info() { echo "[adaceen] $*"; }
ok() { echo "[adaceen] ✓ $*"; }
aviso() { echo "[adaceen] AVISO: $*" >&2; }
fallar() { echo "[adaceen] ERROR: $*" >&2; exit 1; }

ACCION="crear"
IP=""
ROTAR=0
for arg in "$@"; do
  case "$arg" in
    crear | estado | quitar) ACCION="$arg" ;;
    --ip=*) IP="${arg#--ip=}" ;;
    --rotar) ROTAR=1 ;;
    -h | --help | --ayuda) sed -n '2,20p' "$0"; exit 0 ;;
    *) fallar "opcion desconocida: $arg (usa crear, estado, quitar, --ip=<IP> o --rotar)" ;;
  esac
done
[[ $USUARIO =~ ^[a-z_][a-z0-9_]{2,40}$ ]] || fallar "USUARIO debe ser minusculas, numeros o _"
if [ -n "$IP" ] && ! [[ $IP =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  fallar "--ip debe ser una IPv4 (la de tu PC: busca «cual es mi IP» en su navegador)"
fi
command -v psql >/dev/null 2>&1 || fallar "falta psql (la Cloud Shell de Azure lo trae)"
command -v python3 >/dev/null 2>&1 || fallar "falta python3"

# ---------------------------------------------------------------- conexion (nunca se imprime)
if [ -z "${DATABASE_URL:-}" ]; then
  command -v az >/dev/null 2>&1 || fallar "sin DATABASE_URL ni az: corre esto en la Cloud Shell de Azure"
  DATABASE_URL="$(az webapp config appsettings list -g "$RG" -n "$APP" --query "[?name=='DATABASE_URL'].value | [0]" -o tsv 2>/dev/null || true)"
  [ -n "$DATABASE_URL" ] && [ "$DATABASE_URL" != "None" ] || fallar "no pude leer DATABASE_URL del App Service $APP ($RG)"
fi
export DATABASE_URL
# host, puerto y base (sin usuario ni clave) para las credenciales y el cortafuegos.
read -r HOST PUERTO BASE < <(python3 -I -c '
import os, urllib.parse
u = urllib.parse.urlparse(os.environ["DATABASE_URL"])
print(u.hostname or "", u.port or 5432, (u.path or "/").lstrip("/") or "postgres")
')
[ -n "$HOST" ] || fallar "DATABASE_URL no tiene host"

sql() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -t -A "$@"; }

existe_rol() { [ "$(sql -c "select count(*) from pg_roles where rolname = '$USUARIO'")" = "1" ]; }

# Servidor flexible de Azure (para el cortafuegos): nombre y grupo, si az lo encuentra.
servidor_azure() {
  command -v az >/dev/null 2>&1 || return 1
  az postgres flexible-server list --query "[?fullyQualifiedDomainName=='$HOST'] | [0].[name, resourceGroup]" -o tsv 2>/dev/null | head -1
}

estado_cortafuegos() {
  local datos nombre grupo reglas
  datos="$(servidor_azure || true)"
  if [ -z "$datos" ]; then
    info "cortafuegos: no encontre el servidor $HOST con az (¿otra suscripcion?); revisalo en el portal"
    return 0
  fi
  read -r nombre grupo <<<"$datos"
  reglas="$(az postgres flexible-server firewall-rule list -g "$grupo" -n "$nombre" --query "[].[name, startIpAddress, endIpAddress]" -o tsv 2>/dev/null || true)"
  if echo "$reglas" | awk '$2 == "0.0.0.0" && $3 == "0.0.0.0"' | grep -q .; then
    ok "cortafuegos: «servicios de Azure» permitido (el servicio de Power BI en la nube puede conectarse)"
  else
    info "cortafuegos: sin la regla de «servicios de Azure»; el servicio de Power BI en la nube no podra actualizar"
  fi
  local propias
  propias="$(echo "$reglas" | awk '$1 ~ /^powerbi-/ {print $1" ("$2")"}' | paste -sd, - || true)"
  [ -n "$propias" ] && info "reglas para PCs: $propias" || info "sin reglas para PCs (bash deploy/bi/crear-bi.sh --ip=<tu IP>)"
}

# ---------------------------------------------------------------- estado
if [ "$ACCION" = "estado" ]; then
  info "base $BASE en $HOST:$PUERTO"
  vistas="$(sql -c "select string_agg(table_name, ', ' order by table_name) from information_schema.views where table_schema = 'bi'")"
  [ -n "$vistas" ] && ok "vistas bi: $vistas" || info "sin esquema bi (bash deploy/bi/crear-bi.sh)"
  if existe_rol; then ok "usuario $USUARIO existe"; else info "sin usuario $USUARIO"; fi
  [ -f "$CREDENCIALES" ] && info "credenciales en $CREDENCIALES" || info "sin archivo de credenciales en esta terminal"
  fotos="$(sql -c "select count(*) from workshop_progress_snapshots" 2>/dev/null || echo "?")"
  info "fotos del avance guardadas: $fotos"
  estado_cortafuegos
  exit 0
fi

# ---------------------------------------------------------------- quitar
if [ "$ACCION" = "quitar" ]; then
  if existe_rol; then
    sql <<SQL
drop owned by $USUARIO;
drop role $USUARIO;
SQL
    ok "usuario $USUARIO borrado"
  else
    info "no habia usuario $USUARIO"
  fi
  sql -c "set client_min_messages = warning" -c "drop schema if exists bi cascade" >/dev/null
  ok "esquema bi borrado (las tablas de ADACEEN no se tocan)"
  [ -f "$CREDENCIALES" ] && rm -f "$CREDENCIALES" && ok "borrado $CREDENCIALES"
  info "las reglas powerbi-* del cortafuegos se quitan en el portal o con az postgres flexible-server firewall-rule delete"
  exit 0
fi

# ---------------------------------------------------------------- crear
faltan="$(sql -c "select string_agg(t, ', ') from unnest(array['workshop_progress_snapshots','analytics_excluded_actors','telemetry_events','app_settings']) as t where to_regclass('public.' || t) is null")"
[ -z "$faltan" ] || fallar "faltan tablas ($faltan): despliega primero el backend con la analitica (las crea al arrancar)"

sql -f "$AQUI/vistas-bi.sql" >/dev/null
ok "esquema bi y vistas al dia ($(sql -c "select count(*) from information_schema.views where table_schema = 'bi'") vistas)"

NUEVA_CLAVE=""
if ! existe_rol || [ "$ROTAR" = 1 ]; then
  NUEVA_CLAVE="$(python3 -I -c 'import secrets; print(secrets.token_urlsafe(24))')"
  VERIFICADOR="$(printf '%s' "$NUEVA_CLAVE" | python3 -I -c '
import base64, hashlib, hmac, os, sys
clave = sys.stdin.read().encode()
sal, vueltas = os.urandom(16), 4096
salada = hashlib.pbkdf2_hmac("sha256", clave, sal, vueltas)
cliente = hmac.new(salada, b"Client Key", hashlib.sha256).digest()
servidor = hmac.new(salada, b"Server Key", hashlib.sha256).digest()
b64 = lambda x: base64.b64encode(x).decode()
print("SCRAM-SHA-256$%d:%s$%s:%s" % (vueltas, b64(sal), b64(hashlib.sha256(cliente).digest()), b64(servidor)))
')"
  if existe_rol; then
    sql -v verificador="$VERIFICADOR" <<SQL >/dev/null
select format('alter role $USUARIO with login password %L', :'verificador') \gexec
SQL
    ok "clave nueva para $USUARIO"
  else
    sql -v verificador="$VERIFICADOR" <<SQL >/dev/null
select format('create role $USUARIO with login password %L', :'verificador') \gexec
SQL
    ok "usuario $USUARIO creado"
  fi
  unset VERIFICADOR
fi

# Permisos: solo leer las vistas bi (las vistas leen las tablas con los permisos de su dueno).
sql <<SQL >/dev/null
select format('grant connect on database %I to $USUARIO', current_database()) \gexec
grant usage on schema bi to $USUARIO;
grant select on all tables in schema bi to $USUARIO;
alter default privileges in schema bi grant select on tables to $USUARIO;
alter role $USUARIO set search_path = bi;
alter role $USUARIO set default_transaction_read_only = on;
alter role $USUARIO set statement_timeout = '120s';
alter role $USUARIO connection limit 5;
SQL
ok "$USUARIO solo puede leer el esquema bi (solo lectura, 5 conexiones, consultas de hasta 2 min)"

if [ -n "$NUEVA_CLAVE" ]; then
  umask 077
  cat >"$CREDENCIALES" <<FIN
# ADACEEN: usuario de solo lectura para Excel y Power BI (bash deploy/bi/crear-bi.sh, $(date +%F))
Servidor: $HOST
Puerto:   $PUERTO
Base:     $BASE
Usuario:  $USUARIO
Clave:    $NUEVA_CLAVE
SSL:      obligatorio (Excel con Npgsql: SSL Mode=Require)
FIN
  chmod 600 "$CREDENCIALES"
  unset NUEVA_CLAVE
  ok "credenciales en $CREDENCIALES (permisos 600): cat $CREDENCIALES para copiarlas; no las subas al repositorio"
fi

if [ -n "$IP" ]; then
  datos="$(servidor_azure || true)"
  if [ -z "$datos" ]; then
    aviso "no encontre el servidor $HOST con az: agrega la IP $IP a mano (portal -> el servidor PostgreSQL -> Redes)"
  else
    read -r nombre grupo <<<"$datos"
    regla="powerbi-$(echo "$IP" | tr . -)"
    az postgres flexible-server firewall-rule create -g "$grupo" -n "$nombre" --rule-name "$regla" \
      --start-ip-address "$IP" --end-ip-address "$IP" -o none
    ok "cortafuegos: regla $regla para $IP en $nombre"
  fi
fi

info "base $BASE en $HOST:$PUERTO"
estado_cortafuegos
info "siguiente paso: docs/analitica/excel-power-bi.md (Power BI Desktop o Excel -> PostgreSQL -> esquema bi)"
