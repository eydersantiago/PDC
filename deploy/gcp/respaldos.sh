#!/usr/bin/env bash
# Respaldo del trabajo de los estudiantes en la VM de editores (28-10-2026).
#
#   bash deploy/gcp/respaldos.sh activar               bucket, permisos, copia cada 15 min e instantanea diaria
#   bash deploy/gcp/respaldos.sh estado                que hay y el ultimo respaldo (no cambia nada)
#   bash deploy/gcp/respaldos.sh listar <login>        las copias de un estudiante (login de GitHub)
#   bash deploy/gcp/respaldos.sh restaurar <login> [aaaa-mm-dd/hhmm]
#                                                      deja esa copia (o la ultima) en una carpeta nueva
#                                                      restaurado-<fecha> de su editor; no pisa nada
#   bash deploy/gcp/respaldos.sh ahora                 una copia ya (la VM tiene que estar encendida)
#   bash deploy/gcp/respaldos.sh desactivar            deja de copiar (conserva bucket e instantaneas)
#
# Dos capas:
#   1. Copia cada 15 min (y al apagar la VM) de lo que cambio en las carpetas de cada estudiante,
#      a gs://$BUCKET/respaldos/<login>/<aaaa-mm-dd>/<hhmm>.tar.gz (deploy/gcp/workspaces/respaldo-ws.py).
#      El bucket es privado y borra solo lo que pasa de $RETENCION dias.
#   2. Instantanea diaria del disco completo de la VM (3:00 a. m. de Bogota, se guardan
#      $DIAS_INSTANTANEAS dias): la de las 21:37 del 28-10 se hizo a mano; esta sale sola.
#
# activar necesita la VM APAGADA la primera vez: la cuenta de servicio de la VM tiene que poder
# escribir en Storage (alcance devstorage.read_write) y Google solo cambia eso con la VM apagada.
# Si esta encendida, hace lo demas y dice que falta. La copia empieza en el siguiente encendido.
#
# Variables: PROYECTO, VM_EDITORES (adaceen-ws), BUCKET (<proyecto>-adaceen-respaldos),
# RETENCION (30), DIAS_INSTANTANEAS (7), POLITICA_DISCO (adaceen-ws-diario), BACKEND.
set -euo pipefail

DIR_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/comun-gcp.sh
. "$DIR_SCRIPT/comun-gcp.sh"

ACCION="${1:-}"
case "$ACCION" in activar | estado | listar | restaurar | ahora | desactivar) ;; *)
  sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1 ;;
esac

requiere_gcloud
PROYECTO=$(resolver_proyecto)
VM=${VM_EDITORES:-$VM_EDITORES_POR_DEFECTO}
BUCKET=${BUCKET:-$PROYECTO-adaceen-respaldos}
RETENCION=${RETENCION:-30}
DIAS_INSTANTANEAS=${DIAS_INSTANTANEAS:-7}
POLITICA_DISCO=${POLITICA_DISCO:-adaceen-ws-diario}
BACKEND=${BACKEND:-$BACKEND_PRODUCCION}
# Debe coincidir con la que acepta startup-ws.sh.
[[ $BUCKET =~ ^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$ ]] || fallar "BUCKET no es un nombre valido: $BUCKET"
[[ $RETENCION =~ ^[0-9]{1,4}$ ]] && [ "$RETENCION" -ge 1 ] || fallar "RETENCION tiene que ser un numero de dias"
[[ $DIAS_INSTANTANEAS =~ ^[0-9]{1,3}$ ]] && [ "$DIAS_INSTANTANEAS" -ge 1 ] || fallar "DIAS_INSTANTANEAS tiene que ser un numero de dias"

leer_instancias || fallar "gcloud no pudo listar las VMs de $PROYECTO: $INSTANCIAS_ERROR"
ZONA=$(zona_de "$VM")
[ -n "$ZONA" ] || fallar "no encuentro la VM $VM en $PROYECTO (¿otro proyecto? PROYECTO=<id>)"
REGION=$(region_de_zona "$ZONA")
ESTADO=$(estado_de "$VM")

describir() { gcloud compute instances describe "$VM" --zone="$ZONA" --project="$PROYECTO" --format="value($1)" 2>/dev/null || true; }
cuenta_vm() { describir 'serviceAccounts[0].email'; }
alcances_vm() { describir 'serviceAccounts[0].scopes' | tr ';,' '\n\n' | sed '/^$/d'; }
disco_vm() { describir 'disks[0].source.basename()'; }
puede_escribir() { alcances_vm | grep -Eq 'devstorage\.(read_write|full_control)$|/cloud-platform$'; }
bucket_existe() { gcloud storage buckets describe "gs://$BUCKET" --project="$PROYECTO" >/dev/null 2>&1; }
politica_existe() { gcloud compute resource-policies describe "$POLITICA_DISCO" --region="$REGION" --project="$PROYECTO" >/dev/null 2>&1; }
disco_tiene_politica() {
  gcloud compute disks describe "$(disco_vm)" --zone="$ZONA" --project="$PROYECTO" --format='value(resourcePolicies)' 2>/dev/null |
    tr ';,' '\n\n' | grep -q "/$POLITICA_DISCO\$"
}
validar_login() {
  [[ ${1:-} =~ ^[a-z0-9][a-z0-9-]{0,27}$ ]] || fallar "falta el login de GitHub del estudiante (minusculas, como en /home/ws-<login>): ${1:-}"
}
requiere_encendida() {
  esta_encendida "$ESTADO" || fallar "la VM $VM esta $ESTADO: enciendela primero (bash deploy/clase.sh iniciar)"
}
ssh_vm() {
  gcloud compute ssh "$VM" --zone="$ZONA" --project="$PROYECTO" --tunnel-through-iap --quiet "$@"
}

activar() {
  info "proyecto $PROYECTO; VM $VM ($ZONA, $ESTADO); bucket gs://$BUCKET; retencion $RETENCION dias"
  local cuenta pendiente=""
  cuenta=$(cuenta_vm)
  [ -n "$cuenta" ] || fallar "la VM $VM no tiene cuenta de servicio: no puede escribir en Storage"

  # 1. Bucket privado, con borrado automatico.
  if bucket_existe; then
    ok "el bucket gs://$BUCKET ya existe"
  else
    gcloud storage buckets create "gs://$BUCKET" --project="$PROYECTO" --location="$REGION" \
      --uniform-bucket-level-access --public-access-prevention --quiet
    ok "bucket gs://$BUCKET creado en $REGION (privado)"
  fi
  local reglas
  reglas=$(mktemp "${TMPDIR:-/tmp}/adaceen-ciclo.XXXXXX.json")
  printf '{"rule":[{"action":{"type":"Delete"},"condition":{"age":%s}}]}\n' "$RETENCION" >"$reglas"
  gcloud storage buckets update "gs://$BUCKET" --project="$PROYECTO" --lifecycle-file="$reglas" --quiet >/dev/null
  rm -f "$reglas"
  ok "las copias de mas de $RETENCION dias se borran solas"

  # 2. La cuenta de la VM solo crea objetos en ese bucket (no lee ni borra).
  gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --project="$PROYECTO" \
    --member="serviceAccount:$cuenta" --role=roles/storage.objectCreator --quiet >/dev/null
  ok "$cuenta puede crear copias en gs://$BUCKET (sin leer ni borrar)"

  # 3. Alcance de Storage de la VM (solo con la VM apagada).
  if puede_escribir; then
    ok "la VM ya puede escribir en Storage"
  elif esta_encendida "$ESTADO" || [ "$ESTADO" = "STOPPING" ]; then
    pendiente="la VM $VM esta $ESTADO: apagala (bash deploy/clase.sh terminar, cuando no haya nadie) y vuelve a correr bash deploy/gcp/respaldos.sh activar"
    aviso "$pendiente"
  else
    local alcances
    alcances=$( (alcances_vm | sed 's#devstorage\.read_only$#devstorage.read_write#'; echo https://www.googleapis.com/auth/devstorage.read_write) | sort -u | paste -sd, -)
    gcloud compute instances set-service-account "$VM" --zone="$ZONA" --project="$PROYECTO" \
      --service-account="$cuenta" --scopes="$alcances" --quiet >/dev/null
    ok "la VM puede escribir en Storage (alcance devstorage.read_write)"
  fi

  # 4. Metadata: startup-ws.sh instala la copia cada 15 min y al apagar.
  gcloud compute instances add-metadata "$VM" --zone="$ZONA" --project="$PROYECTO" --metadata="respaldo-bucket=$BUCKET" --quiet >/dev/null
  ok "metadata respaldo-bucket=$BUCKET (la copia arranca en el proximo encendido de la VM)"

  # 5. Instantanea diaria del disco (8:00 UTC = 3:00 a. m. de Bogota).
  if politica_existe; then
    ok "la programacion de instantaneas $POLITICA_DISCO ya existe"
  else
    gcloud compute resource-policies create snapshot-schedule "$POLITICA_DISCO" --region="$REGION" --project="$PROYECTO" \
      --daily-schedule --start-time=08:00 --max-retention-days="$DIAS_INSTANTANEAS" \
      --on-source-disk-delete=keep-auto-snapshots --storage-location="$REGION" \
      --description="ADACEEN: disco de la VM de editores, cada dia a las 3:00 de Bogota" --quiet
    ok "programacion de instantaneas $POLITICA_DISCO: cada dia a las 3:00 a. m. de Bogota, $DIAS_INSTANTANEAS dias"
  fi
  if disco_tiene_politica; then
    ok "el disco $(disco_vm) ya tiene la instantanea diaria"
  else
    gcloud compute disks add-resource-policies "$(disco_vm)" --zone="$ZONA" --project="$PROYECTO" --resource-policies="$POLITICA_DISCO" --quiet
    ok "el disco $(disco_vm) queda con la instantanea diaria"
  fi
  echo
  estado
  if [ -n "$pendiente" ]; then
    aviso "FALTA: $pendiente"
    exit 1
  fi
}

estado() {
  info "VM $VM ($ZONA): $ESTADO; cuenta $(cuenta_vm)"
  if puede_escribir; then ok "la VM puede escribir en Storage"; else aviso "la VM todavia no puede escribir en Storage (bash deploy/gcp/respaldos.sh activar con la VM apagada)"; fi
  local meta
  meta=$(gcloud compute instances describe "$VM" --zone="$ZONA" --project="$PROYECTO" --format=json 2>/dev/null |
    python3 -c 'import json,sys
d=json.load(sys.stdin)
print(next((i.get("value","") for i in (d.get("metadata") or {}).get("items") or [] if i.get("key")=="respaldo-bucket"), ""))' 2>/dev/null || true)
  if [ -n "$meta" ]; then ok "metadata respaldo-bucket=$meta"; else info "sin metadata respaldo-bucket: la VM no copia"; fi
  if bucket_existe; then
    ok "bucket gs://$BUCKET"
    local ultimas
    ultimas=$(gcloud storage ls -l "gs://$BUCKET/respaldos/**" --project="$PROYECTO" 2>/dev/null | grep -v '^TOTAL' | sort -k2 | tail -n 5 || true)
    if [ -n "$ultimas" ]; then
      info "ultimas copias:"
      printf '%s\n' "$ultimas" | sed 's/^/    /'
    else
      info "todavia no hay copias en el bucket"
    fi
  else
    info "sin bucket gs://$BUCKET"
  fi
  if politica_existe && disco_tiene_politica; then
    ok "instantanea diaria del disco ($POLITICA_DISCO)"
  else
    info "sin instantanea diaria del disco"
  fi
  local fotos
  fotos=$(gcloud compute snapshots list --project="$PROYECTO" --filter="sourceDisk~/$(disco_vm)\$" --sort-by=~creationTimestamp --limit=3 --format='value(name,creationTimestamp,status)' 2>/dev/null || true)
  if [ -n "$fotos" ]; then
    info "instantaneas del disco (las 3 mas nuevas):"
    printf '%s\n' "$fotos" | sed 's/^/    /'
  fi
  local salud
  salud=$(curl -fsS --max-time 15 "$BACKEND/api/health" 2>/dev/null || true)
  if [ -n "$salud" ]; then
    printf '%s' "$salud" | python3 -c 'import json,sys
b=json.load(sys.stdin).get("workspace_backup")
if not b:
    print("[adaceen] el backend todavia no informa respaldos (despliega la rama con los respaldos)")
elif not b.get("last_at"):
    print("[adaceen] el backend no ha recibido ningun respaldo todavia")
else:
    print("[adaceen] ultimo respaldo que vio el backend: %s, %s, %s estudiantes, %s con cambios" % (b["last_at"], "bien" if b.get("ok") else "FALLO", b.get("students"), b.get("changed")))' || true
  fi
}

listar() {
  validar_login "${1:-}"
  gcloud storage ls -l "gs://$BUCKET/respaldos/$1/**" --project="$PROYECTO" 2>/dev/null | grep -v '^TOTAL' | sort -k2 ||
    info "no hay copias de $1 en gs://$BUCKET"
}

restaurar() {
  validar_login "${1:-}"
  local login="$1" sello="${2:-}" objeto
  requiere_encendida
  if [ -n "$sello" ]; then
    [[ $sello =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}/[0-9]{4}$ ]] || fallar "la copia se indica como aaaa-mm-dd/hhmm (bash deploy/gcp/respaldos.sh listar $login)"
    objeto="gs://$BUCKET/respaldos/$login/$sello.tar.gz"
  else
    objeto=$(gcloud storage ls "gs://$BUCKET/respaldos/$login/**" --project="$PROYECTO" 2>/dev/null | grep '\.tar\.gz$' | sort | tail -n 1 || true)
    [ -n "$objeto" ] || fallar "no hay copias de $login en gs://$BUCKET"
    sello=${objeto#gs://$BUCKET/respaldos/$login/}
    sello=${sello%.tar.gz}
  fi
  local carpeta="restaurado-${sello//\//-}" local_tmp nombre
  local_tmp=$(mktemp -d "${TMPDIR:-/tmp}/adaceen-restaurar.XXXXXX")
  trap 'rm -rf "$local_tmp"' RETURN
  nombre="adaceen-restaurar-$login-${sello//\//-}.tar.gz"
  gcloud storage cp "$objeto" "$local_tmp/$nombre" --project="$PROYECTO" --quiet
  gcloud compute scp "$local_tmp/$nombre" "$VM:~/$nombre" --zone="$ZONA" --project="$PROYECTO" --tunnel-through-iap --quiet
  # En la VM: la copia pasa a un archivo de root y se extrae COMO el estudiante, en una carpeta
  # nueva de su home (respaldo-ws.py --extraer no pisa nada).
  ssh_vm --command="sudo bash -s -- '$login' '$nombre' '$carpeta'" <<'REMOTO'
set -eu
login=$1; nombre=$2; carpeta=$3
origen="$HOME/$nombre"
[ -n "${SUDO_USER:-}" ] && origen="$(getent passwd "$SUDO_USER" | cut -d: -f6)/$nombre"
id "ws-$login" >/dev/null 2>&1 || { echo "no existe el usuario ws-$login en la VM"; rm -f "$origen"; exit 1; }
copia=$(mktemp /tmp/adaceen-restaurar.XXXXXX.tar.gz)
install -m 644 "$origen" "$copia"
rm -f "$origen"
runuser -u "ws-$login" -- python3 /opt/adaceen/respaldo-ws.py --extraer "$copia" "/home/ws-$login/$carpeta"
rm -f "$copia"
REMOTO
  ok "$login: la copia $sello quedo en la carpeta $carpeta de su editor (no se piso nada; que copie lo que necesite)"
}

ahora() {
  requiere_encendida
  ssh_vm --command='sudo systemctl start adaceen-ws-respaldo.service && sudo journalctl -u adaceen-ws-respaldo.service -n 3 --no-pager -o cat'
}

desactivar() {
  gcloud compute instances remove-metadata "$VM" --zone="$ZONA" --project="$PROYECTO" --keys=respaldo-bucket --quiet >/dev/null 2>&1 || true
  ok "sin metadata respaldo-bucket: la VM deja de copiar en su proximo encendido"
  if disco_tiene_politica; then
    gcloud compute disks remove-resource-policies "$(disco_vm)" --zone="$ZONA" --project="$PROYECTO" --resource-policies="$POLITICA_DISCO" --quiet
    ok "el disco ya no tiene instantanea diaria"
  fi
  info "El bucket gs://$BUCKET y las instantaneas se conservan (borralos a mano si ya no sirven)."
}

case "$ACCION" in
  activar) activar ;;
  estado) estado ;;
  listar) listar "${2:-}" ;;
  restaurar) restaurar "${2:-}" "${3:-}" ;;
  ahora) ahora ;;
  desactivar) desactivar ;;
esac
