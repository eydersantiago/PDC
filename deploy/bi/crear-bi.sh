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
# LIMITE_CONEXIONES (12),
# CREDENCIALES (~/adaceen-powerbi-lector.txt: host, base, usuario y clave, con permisos 600).
#
# La clave nunca se muestra ni viaja en claro a la base: el servidor recibe solo el verificador
# SCRAM-SHA-256 (calculado aqui con python3), asi no queda en un registro de sentencias. La conexion
# de la app va a psql por variables PG* (no en la linea de comandos, que se ve en ps).
# Las vistas no tienen nombres, correos, logins ni codigos estudiantiles (docs/analitica/excel-power-bi.md).
set -euo pipefail

RG="${RG:-rg-adaceen-azure}"
APP="${APP:-app-adaceen-api-eyder05232002}"
USUARIO="${USUARIO:-powerbi_lector}"
CREDENCIALES="${CREDENCIALES:-$HOME/adaceen-powerbi-lector.txt}"
# Power BI abre varias conexiones al cargar (una por tabla en paralelo): con 5 fallaba con
# «too many connections for role» (29-10). 12 alcanza y deja de sobra para el backend.
LIMITE_CONEXIONES="${LIMITE_CONEXIONES:-12}"
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
[[ $LIMITE_CONEXIONES =~ ^[0-9]{1,2}$ ]] && [ "$LIMITE_CONEXIONES" -ge 1 ] || fallar "LIMITE_CONEXIONES debe ser de 1 a 99"
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
  # Sin TELEMETRY_SALT el backend usa la sal de desarrollo, que es publica en el repositorio: los
  # seudonimos se podrian revertir. Solo el nombre del ajuste, nunca su valor.
  if [ "$ACCION" = "crear" ] && [ "$(az webapp config appsettings list -g "$RG" -n "$APP" --query "[?name=='TELEMETRY_SALT'].name | [0]" -o tsv 2>/dev/null || true)" != "TELEMETRY_SALT" ]; then
    fallar "el App Service no tiene TELEMETRY_SALT: sin ella los codigos del analisis no protegen a nadie (ver .env.example)"
  fi
fi
# host, puerto y base (para las credenciales y el cortafuegos) y la conexion como variables PG*.
eval "$(DATABASE_URL="$DATABASE_URL" python3 -I -c '
import os, shlex, urllib.parse
u = urllib.parse.urlparse(os.environ["DATABASE_URL"])
q = urllib.parse.parse_qs(u.query)
ssl = (q.get("sslmode") or [""])[0] or ("require" if (q.get("ssl") or [""])[0].lower() in ("true", "1", "require") else "")
values = {
    "HOST": u.hostname or "", "PUERTO": str(u.port or 5432), "BASE": urllib.parse.unquote((u.path or "/").lstrip("/")) or "postgres",
    "PGHOST": u.hostname or "", "PGPORT": str(u.port or 5432), "PGDATABASE": urllib.parse.unquote((u.path or "/").lstrip("/")) or "postgres",
    "PGUSER": urllib.parse.unquote(u.username or ""), "PGPASSWORD": urllib.parse.unquote(u.password or ""),
}
if ssl:
    values["PGSSLMODE"] = ssl
for key, value in values.items():
    print("%s=%s" % (key, shlex.quote(value)))
')"
unset DATABASE_URL
export PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD
[ -n "${PGSSLMODE:-}" ] && export PGSSLMODE
[ -n "$HOST" ] || fallar "DATABASE_URL no tiene host"

sql() { psql -v ON_ERROR_STOP=1 -X -q -t -A "$@"; }

existe_rol() { [ "$(sql -c "select count(*) from pg_roles where rolname = '$USUARIO'")" = "1" ]; }

# Servidor flexible de Azure (para el cortafuegos): nombre y grupo, si az lo encuentra.
servidor_azure() {
  command -v az >/dev/null 2>&1 || return 1
  az postgres flexible-server list --query "[?fullyQualifiedDomainName=='$HOST'] | [0].[name, resourceGroup]" -o tsv 2>/dev/null | head -1
}

# az cambio los parametros (29-10-2026, az 2.91): antes -n <servidor> --rule-name <regla>, ahora
# --server-name <servidor> --name <regla>. Se prueba la forma nueva y, si falla, la anterior.
reglas_cortafuegos() {
  local consulta="[].[name, startIpAddress, endIpAddress]"
  az postgres flexible-server firewall-rule list -g "$1" --server-name "$2" --query "$consulta" -o tsv 2>/dev/null \
    || az postgres flexible-server firewall-rule list -g "$1" -n "$2" --query "$consulta" -o tsv 2>/dev/null || true
}

crear_regla() {
  az postgres flexible-server firewall-rule create -g "$1" --server-name "$2" --name "$3" \
      --start-ip-address "$4" --end-ip-address "$4" -o none 2>/dev/null \
    || az postgres flexible-server firewall-rule create -g "$1" -n "$2" --rule-name "$3" \
      --start-ip-address "$4" --end-ip-address "$4" -o none
}

estado_cortafuegos() {
  local datos nombre grupo reglas
  datos="$(servidor_azure || true)"
  if [ -z "$datos" ]; then
    info "cortafuegos: no encontre el servidor $HOST con az (¿otra suscripcion?); revisalo en el portal"
    return 0
  fi
  read -r nombre grupo <<<"$datos"
  reglas="$(reglas_cortafuegos "$grupo" "$nombre")"
  # awk decide solo (sin grep -q, que con pipefail puede cortar el tubo y dar un falso «no»).
  if printf '%s\n' "$reglas" | awk '$2 == "0.0.0.0" && $3 == "0.0.0.0" {f = 1} END {exit !f}'; then
    info "cortafuegos: «servicios de Azure» permitido (lo usa el backend; con eso tambien conecta Power BI en la nube)"
  else
    info "cortafuegos: sin la regla de «servicios de Azure»; Power BI en la nube no podra actualizar (usa Desktop o Excel con --ip, o los CSV en OneDrive)"
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
  info "las reglas powerbi-* del cortafuegos se quitan en el portal o con az postgres flexible-server firewall-rule delete -g <grupo> --server-name <servidor> --name <regla>"
  exit 0
fi

# ---------------------------------------------------------------- crear
faltan="$(sql -c "select string_agg(t, ', ') from unnest(array['workshop_progress_snapshots','analytics_excluded_actors','telemetry_events','app_settings']) as t where to_regclass('public.' || t) is null")"
[ -z "$faltan" ] || fallar "faltan tablas ($faltan): despliega primero el backend con la analitica (las crea al arrancar)"

sql -f "$AQUI/vistas-bi.sql" >/dev/null
ok "esquema bi y vistas al dia ($(sql -c "select count(*) from information_schema.views where table_schema = 'bi'") vistas)"

escribir_credenciales() {
  umask 077
  cat >"$CREDENCIALES" <<FIN
# ADACEEN: usuario de solo lectura para Excel y Power BI (bash deploy/bi/crear-bi.sh, $(date +%F))
Servidor: $HOST
Puerto:   $PUERTO
Base:     $BASE
Usuario:  $USUARIO
Clave:    $1
SSL:      obligatorio (Excel con Npgsql: SSL Mode=Require)
FIN
  chmod 600 "$CREDENCIALES"
}

NUEVA_CLAVE=""
if ! existe_rol || [ "$ROTAR" = 1 ]; then
  NUEVA_CLAVE="$(python3 -I -c 'import secrets; print(secrets.token_urlsafe(24))')"
  # La clave queda guardada ANTES de cambiarla en la base: si algo falla despues, no se pierde. La
  # anterior queda en .anterior hasta que la nueva quede puesta.
  [ -f "$CREDENCIALES" ] && mv -f "$CREDENCIALES" "$CREDENCIALES.anterior"
  escribir_credenciales "$NUEVA_CLAVE"
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
  unset VERIFICADOR NUEVA_CLAVE
  rm -f "$CREDENCIALES.anterior"
  ok "credenciales en $CREDENCIALES (permisos 600): cat $CREDENCIALES para copiarlas; no las subas al repositorio"
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
alter role $USUARIO connection limit $LIMITE_CONEXIONES;
SQL
ok "$USUARIO solo puede leer el esquema bi (solo lectura, $LIMITE_CONEXIONES conexiones, consultas de hasta 2 min)"

# Lo que PUBLIC da a cualquiera (PostgreSQL 14 o anterior: crear en public; siempre: tablas TEMP)
# tambien lo tendria $USUARIO. Se quita solo si el usuario de la app es dueno de public o de la base:
# asi sigue pudiendo crear sus tablas al arrancar (y la app no usa tablas TEMP).
publico="$(sql <<SQL
do \$adaceen\$
declare
  dueno_public boolean := pg_has_role(current_user, (select nspowner from pg_namespace where nspname = 'public'), 'USAGE');
  dueno_base boolean := pg_has_role(current_user, (select datdba from pg_database where datname = current_database()), 'USAGE');
begin
  if has_schema_privilege('$USUARIO', 'public', 'CREATE') and dueno_public then
    execute 'revoke create on schema public from public';
  end if;
  if has_database_privilege('$USUARIO', current_database(), 'TEMP') and dueno_base then
    execute format('revoke temp on database %I from public', current_database());
  end if;
end
\$adaceen\$;
select concat_ws(' ',
  case when has_schema_privilege('$USUARIO', 'public', 'CREATE') then 'crear-en-public' end,
  case when has_database_privilege('$USUARIO', current_database(), 'TEMP') then 'tablas-temp' end);
SQL
)"
if [ -n "$publico" ]; then
  aviso "$USUARIO todavia puede: $publico (lo da PUBLIC y el usuario de la app no es dueno para quitarlo). Quitalo como dueno: revoke create on schema public from public; revoke temp on database $BASE from public"
else
  ok "$USUARIO no puede crear objetos ni tablas temporales"
fi

if [ -n "$IP" ]; then
  datos="$(servidor_azure || true)"
  if [ -z "$datos" ]; then
    aviso "no encontre el servidor $HOST con az: agrega la IP $IP a mano (portal -> el servidor PostgreSQL -> Redes)"
  else
    read -r nombre grupo <<<"$datos"
    regla="powerbi-$(echo "$IP" | tr . -)"
    crear_regla "$grupo" "$nombre" "$regla" "$IP"
    ok "cortafuegos: regla $regla para $IP en $nombre"
  fi
fi

info "base $BASE en $HOST:$PUERTO"
estado_cortafuegos
info "siguiente paso: docs/analitica/excel-power-bi.md (Power BI Desktop o Excel -> PostgreSQL -> esquema bi)"
