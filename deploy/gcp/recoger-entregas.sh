#!/usr/bin/env bash
# Exporta de una vez el trabajo de TODOS los estudiantes desde la VM de editores.
#
#   bash recoger-entregas.sh              (carpeta sistema-bancario-fpoo)
#   CARPETA=otro-repo bash recoger-entregas.sh
#
# Correr en Cloud Shell con la cuenta duena del proyecto (la del .bat). Copia
# /home/ws-<login>/<CARPETA> de cada estudiante a UN solo zip en tu Cloud Shell:
#   entregas/<login>/...        el codigo tal como esta en su editor
#   entregas/LISTA.csv          login, nombre, correo, archivos, ultimo cambio, si armo su zip
# No toca nada de los estudiantes: solo lee. Se puede correr las veces que
# quieras (por ejemplo a mitad del examen, como respaldo, y al final).
# Para bajarlo a tu PC: cloudshell download ~/entregas-....zip
#
# Variables: PROYECTO (defecto adaceen-508504), VM_EDITORES (adaceen-ws), CARPETA.
set -euo pipefail

PROYECTO=${PROYECTO:-$(gcloud config get-value project 2>/dev/null || true)}
[ -n "$PROYECTO" ] && [ "$PROYECTO" != "(unset)" ] || PROYECTO=adaceen-508504
VM=${VM_EDITORES:-adaceen-ws}
CARPETA=${CARPETA:-sistema-bancario-fpoo}
[[ $CARPETA =~ ^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$ ]] || { echo "CARPETA no valida: $CARPETA"; exit 1; }

ZONA=$(gcloud compute instances list --project="$PROYECTO" --filter="name=$VM" --format='value(zone.basename())' | head -1)
[ -n "$ZONA" ] || { echo "No encuentro la VM $VM en $PROYECTO (¿cuenta correcta?)."; exit 1; }
ESTADO=$(gcloud compute instances describe "$VM" --zone="$ZONA" --project="$PROYECTO" --format='value(status)')
[ "$ESTADO" = "RUNNING" ] || { echo "La VM $VM esta $ESTADO: enciendela primero (los archivos siguen en su disco)."; exit 1; }

SELLO=$(TZ=America/Bogota date +%Y%m%d-%H%M)
NOMBRE="entregas-$CARPETA-$SELLO.zip"
echo "[adaceen] Recogiendo $CARPETA de cada estudiante en $VM ($ZONA)..."

# El recolector corre como root en la VM y deja el zip en el home de quien
# entra por ssh, 0600: los estudiantes tienen terminal en esa VM y no deben
# poder leerlo. No sigue enlaces simbolicos (un estudiante podria plantar uno
# hacia el trabajo de otro) y solo copia archivos normales.
gcloud compute ssh "$VM" --zone="$ZONA" --project="$PROYECTO" --tunnel-through-iap --quiet \
  --command="sudo python3 - '$CARPETA' '$NOMBRE'" <<'PY'
import csv, io, json, os, pwd, stat, sys, zipfile
from datetime import datetime, timezone, timedelta

carpeta, nombre = sys.argv[1], sys.argv[2]
bogota = timezone(timedelta(hours=-5))
EXCLUIR_DIRS = {".git", "build", "__pycache__", ".vscode-server", ".vscode-remote", "node_modules"}
EXCLUIR_ARCH = {"banco", "banco.exe", "a.out"}
EXCLUIR_EXT = (".o", ".d", ".exe", ".zip", ".obj")
MAX_ARCHIVO = 20 * 1024 * 1024

quien = os.environ.get("SUDO_USER") or "root"
info = pwd.getpwnam(quien)
destino = os.path.join(info.pw_dir, nombre)
os.umask(0o077)

def leer_sesion(home):
    ruta = os.path.join(home, ".adaceen", "editor-session.json")
    try:
        st = os.lstat(ruta)
        if not stat.S_ISREG(st.st_mode) or st.st_size > 65536:
            return "", ""
        with open(ruta, encoding="utf-8") as f:
            datos = json.load(f)
        # Solo nombre y correo: el sessionId nunca sale de la VM.
        return str(datos.get("userName") or ""), str(datos.get("userEmail") or "")
    except Exception:
        return "", ""

filas = []
with zipfile.ZipFile(destino, "w", zipfile.ZIP_DEFLATED) as zf:
    for entrada in sorted(os.listdir("/home")):
        if not entrada.startswith("ws-"):
            continue
        home = os.path.join("/home", entrada)
        if os.path.islink(home) or not os.path.isdir(home):
            continue
        login = entrada[3:]
        nombre_est, correo = leer_sesion(home)
        raiz = os.path.join(home, carpeta)
        fila = {"login_github": login, "nombre": nombre_est, "correo": correo,
                "archivos": 0, "cpp_h": 0, "ultimo_cambio": "", "armo_su_zip": "no", "nota": ""}
        if os.path.islink(raiz) or not os.path.isdir(raiz):
            fila["nota"] = "no abrio el ejercicio"
            filas.append(fila)
            continue
        ultimo = 0.0
        for dirpath, dirnames, filenames in os.walk(raiz, followlinks=False):
            dirnames[:] = sorted(d for d in dirnames if d not in EXCLUIR_DIRS and not os.path.islink(os.path.join(dirpath, d)))
            for f in sorted(filenames):
                ruta = os.path.join(dirpath, f)
                try:
                    st = os.lstat(ruta)
                except OSError:
                    continue
                if not stat.S_ISREG(st.st_mode):
                    continue
                if f.startswith("entrega-") and f.endswith(".zip"):
                    fila["armo_su_zip"] = datetime.fromtimestamp(st.st_mtime, bogota).strftime("%H:%M")
                if f in EXCLUIR_ARCH or f.endswith(EXCLUIR_EXT) or st.st_size > MAX_ARCHIVO:
                    continue
                rel = os.path.relpath(ruta, raiz)
                try:
                    fd = os.open(ruta, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                except OSError:
                    continue
                with os.fdopen(fd, "rb") as fh:
                    if not stat.S_ISREG(os.fstat(fd).st_mode):
                        continue
                    contenido = fh.read(MAX_ARCHIVO + 1)
                if len(contenido) > MAX_ARCHIVO:
                    continue
                zi = zipfile.ZipInfo(os.path.join("entregas", login, rel), datetime.fromtimestamp(st.st_mtime).timetuple()[:6])
                zi.compress_type = zipfile.ZIP_DEFLATED
                zf.writestr(zi, contenido)
                fila["archivos"] += 1
                if f.endswith((".cpp", ".h", ".hpp", ".cc")):
                    fila["cpp_h"] += 1
                    ultimo = max(ultimo, st.st_mtime)
        if ultimo:
            fila["ultimo_cambio"] = datetime.fromtimestamp(ultimo, bogota).strftime("%Y-%m-%d %H:%M")
        filas.append(fila)
    texto = io.StringIO()
    w = csv.DictWriter(texto, fieldnames=list(filas[0].keys()) if filas else ["login_github"])
    w.writeheader()
    w.writerows(filas)
    zf.writestr("entregas/LISTA.csv", "﻿" + texto.getvalue())
os.chown(destino, info.pw_uid, info.pw_gid)
os.chmod(destino, 0o600)

con = sum(1 for f in filas if not f["nota"])
print(f"[adaceen] {len(filas)} estudiantes en la VM; {con} con la carpeta {carpeta}.")
for f in filas:
    print(f"  {f['login_github']:<24} {f['nombre'][:28]:<28} {f['cpp_h']:>3} .cpp/.h  ultimo {f['ultimo_cambio'] or '-':<16}  zip {f['armo_su_zip']:<5} {f['nota']}")
PY

gcloud compute scp "$VM:~/$NOMBRE" "$HOME/$NOMBRE" --zone="$ZONA" --project="$PROYECTO" --tunnel-through-iap --quiet
gcloud compute ssh "$VM" --zone="$ZONA" --project="$PROYECTO" --tunnel-through-iap --quiet --command="rm -f ~/$NOMBRE"
chmod 600 "$HOME/$NOMBRE"
echo
echo "[adaceen] Listo: ~/$NOMBRE ($(du -h "$HOME/$NOMBRE" | cut -f1))."
echo "[adaceen] Para bajarlo a tu PC:  cloudshell download ~/$NOMBRE"
