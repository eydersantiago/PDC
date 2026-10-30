#!/usr/bin/env bash
# Avance de los estudiantes en los talleres (29-10-2026; el primero, el Sistema bancario).
#
#   bash deploy/gcp/avance-taller.sh foto         calcula AHORA el avance con el evaluador de esta rama, sin desplegar ni
#                                                 instalar nada, y lo deja en ~/avance-taller-<fecha>.json (la VM encendida)
#   bash deploy/gcp/avance-taller.sh activar      sube el arranque nuevo a la VM de editores (aplica al encenderla)
#   bash deploy/gcp/avance-taller.sh estado       ultimo calculo en la VM y lo que vio el backend (no cambia nada)
#   bash deploy/gcp/avance-taller.sh ahora        calcula ya, sin esperar los 10 min (con el timer instalado)
#   bash deploy/gcp/avance-taller.sh desactivar   metadata avance=off (deja de calcular en el proximo encendido)
#
# En la VM, avance-ws.py revisa la carpeta del taller (deploy/gcp/workspaces/talleres/*.json) en el
# home de cada estudiante: clases, atributos, metodos con cuerpo, herencia, main y si compila. Todo
# lo que toca la carpeta de un estudiante corre con SU usuario (runuser), con tiempo limite y sin
# ejecutar su programa. Al backend solo van el porcentaje y lo que falta, nunca el codigo; el
# docente lo ve en el monitor (/docente/monitor). No necesita bucket ni permisos nuevos.
#
# Lo instala el startup-ws.sh de la rama de despliegue, pero la VM corre el arranque que tiene en
# su metadata: activar lo sube (con los cuidados de subir_startup_ws, en comun-gcp.sh). Si ya
# corriste `respaldos.sh activar` con esta rama, ya quedo.
#
# Variables: PROYECTO, VM_EDITORES (adaceen-ws), BACKEND, FORZAR_STARTUP=1 (ver subir_startup_ws).
set -euo pipefail

DIR_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/comun-gcp.sh
. "$DIR_SCRIPT/comun-gcp.sh"

ACCION="${1:-}"
case "$ACCION" in foto | activar | estado | ahora | desactivar) ;; *)
  sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1 ;;
esac

requiere_gcloud
PROYECTO=$(resolver_proyecto)
VM=${VM_EDITORES:-$VM_EDITORES_POR_DEFECTO}
BACKEND=${BACKEND:-$BACKEND_PRODUCCION}
leer_instancias || fallar "gcloud no pudo listar las VMs de $PROYECTO: $INSTANCIAS_ERROR"
ZONA=$(zona_de "$VM")
[ -n "$ZONA" ] || fallar "no encuentro la VM $VM en $PROYECTO (¿otro proyecto? PROYECTO=<id>)"
ESTADO=$(estado_de "$VM")

ssh_vm() {
  gcloud compute ssh "$VM" --zone="$ZONA" --project="$PROYECTO" --tunnel-through-iap --quiet "$@"
}

pista_ssh() {
  aviso "si ssh no conecta, falta la regla de IAP (una vez): gcloud compute firewall-rules create adaceen-iap-ssh --project=$PROYECTO --network=default --allow=tcp:22 --source-ranges=35.235.240.0/20"
}

visto_por_el_backend() {
  local salud
  salud=$(curl -fsS --max-time 15 "$BACKEND/api/health" 2>/dev/null || true)
  [ -n "$salud" ] || { info "no pude leer $BACKEND/api/health"; return 0; }
  printf '%s' "$salud" | python3 -c 'import json,sys
w=json.load(sys.stdin).get("workshop_progress")
if not w:
    print("[adaceen] el backend todavia no informa el avance (despliega la rama con el avance)")
elif not w.get("last_at"):
    print("[adaceen] el backend no ha recibido ningun informe de avance todavia")
else:
    print("[adaceen] ultimo informe que vio el backend: %s, taller %s, %s estudiantes, %s con la carpeta" % (w["last_at"], w.get("taller"), w.get("students"), w.get("started")))' || true
}

# La foto: el evaluador y los talleres de esta rama van a una carpeta temporal de la VM, root
# lanza a cada estudiante con su usuario (como el timer) y devuelve el JSON; no avisa al backend
# ni deja nada instalado. Sirve antes de desplegar.
foto() {
  esta_encendida "$ESTADO" || fallar "la VM $VM esta $ESTADO: enciendela primero (bash deploy/clase.sh iniciar)"
  local tmp sello salida subida
  sello=$(TZ=America/Bogota date +%Y%m%d-%H%M)
  # Nombre unico: una subida que quedo de un intento fallido no se mezcla con esta.
  subida="adaceen-avance-foto-$sello-$$"
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/adaceen-foto.XXXXXX")
  mkdir -p "$tmp/$subida/talleres"
  cp "$DIR_SCRIPT/workspaces/avance-ws.py" "$tmp/$subida/"
  cp "$DIR_SCRIPT"/workspaces/talleres/*.json "$tmp/$subida/talleres/"
  info "subiendo el evaluador a $VM ($ZONA) y calculando (puede tardar unos minutos con muchos estudiantes)..."
  if ! gcloud compute scp --recurse "$tmp/$subida" "$VM:~/" --zone="$ZONA" --project="$PROYECTO" --tunnel-through-iap --quiet; then
    rm -rf "$tmp"
    pista_ssh
    fallar "no pude copiar el evaluador a $VM"
  fi
  rm -rf "$tmp"
  salida="$HOME/avance-taller-$sello.json"
  # En la VM: se copia a una carpeta de root (los estudiantes la leen, no la cambian), se borra la
  # subida y se corre con --json. Solo el JSON sale entre las marcas.
  if ! ssh_vm --command="sudo bash -s -- '$subida'" >"$salida.crudo" <<'REMOTO'
set -eu
[[ ${1:-} =~ ^adaceen-avance-foto-[0-9-]+$ ]] || { echo "subida no valida" >&2; exit 1; }
origen="$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)/$1"
dir=$(mktemp -d /tmp/adaceen-foto.XXXXXX)
trap 'rm -rf "$dir" "$origen"' EXIT
chmod 755 "$dir"
install -m 644 "$origen/avance-ws.py" "$dir/avance-ws.py"
mkdir "$dir/talleres"
install -m 644 "$origen"/talleres/*.json "$dir/talleres/"
chmod 755 "$dir/talleres"
rm -rf "$origen"
echo "===ADACEEN-FOTO==="
python3 -I "$dir/avance-ws.py" --json --talleres "$dir/talleres"
echo "===FIN==="
REMOTO
  then
    pista_ssh
    fallar "no pude correr el evaluador en $VM (lo que salio: $salida.crudo)"
  fi
  python3 -c 'import json,sys
texto=open(sys.argv[1], encoding="utf-8", errors="replace").read()
a=texto.find("===ADACEEN-FOTO===")
b=texto.find("===FIN===", a)
if a < 0 or b < 0:
    sys.exit("el evaluador no devolvio la foto")
datos=json.loads(texto[a+len("===ADACEEN-FOTO==="):b].strip())
open(sys.argv[2], "w", encoding="utf-8").write(json.dumps(datos, ensure_ascii=False, indent=1))
for inf in datos["informes"]:
    e=inf["students"]
    con=[x for x in e if x["started"]]
    prom=round(sum(x["percent"] for x in con)/len(con)) if con else 0
    print("[adaceen] %s: %d estudiantes con editor, %d con la carpeta del taller, promedio %d %%, compilan %d" % (inf["titulo"], len(e), len(con), prom, sum(1 for x in con if x["compiles"])))' "$salida.crudo" "$salida" ||
    fallar "no pude leer la foto (lo que salio: $salida.crudo)"
  rm -f "$salida.crudo"
  ok "foto en $salida (solo logins de GitHub, porcentajes y puntos; sin codigo)"
  info "Para bajarla a tu PC: cloudshell download $salida"
}

case "$ACCION" in
  foto) foto ;;
  activar)
    gcloud compute instances remove-metadata "$VM" --zone="$ZONA" --project="$PROYECTO" --keys=avance --quiet >/dev/null 2>&1 || true
    subir_startup_ws "$VM" "$ZONA" "$PROYECTO"
    ok "startup-script de $VM al dia con esta rama"
    if esta_encendida "$ESTADO"; then
      info "La VM esta $ESTADO: el avance se instala en su proximo encendido. Para no esperar, cuando no haya"
      info "nadie conectado: bash deploy/clase.sh terminar y luego bash deploy/clase.sh iniciar (o apagala y enciendela)."
    else
      ok "se instala al encender la VM (bash deploy/clase.sh iniciar)"
    fi
    ;;
  estado)
    info "VM $VM ($ZONA): $ESTADO"
    if esta_encendida "$ESTADO"; then
      ssh_vm --command='systemctl is-active adaceen-ws-avance.timer >/dev/null 2>&1 && echo "[adaceen] timer activo (cada 10 min)" || echo "[adaceen] AVISO: sin timer adaceen-ws-avance (bash deploy/gcp/avance-taller.sh activar y reinicia la VM)"; sudo journalctl -u adaceen-ws-avance.service -n 4 --no-pager -o cat 2>/dev/null || true' || pista_ssh
    fi
    visto_por_el_backend
    ;;
  ahora)
    esta_encendida "$ESTADO" || fallar "la VM $VM esta $ESTADO: enciendela primero (bash deploy/clase.sh iniciar)"
    ssh_vm --command='sudo systemctl start adaceen-ws-avance.service && sudo journalctl -u adaceen-ws-avance.service -n 3 --no-pager -o cat' || pista_ssh
    visto_por_el_backend
    ;;
  desactivar)
    gcloud compute instances add-metadata "$VM" --zone="$ZONA" --project="$PROYECTO" --metadata=avance=off --quiet >/dev/null
    ok "metadata avance=off: la VM deja de calcular el avance en su proximo encendido"
    ;;
esac
