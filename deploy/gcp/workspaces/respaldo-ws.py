#!/usr/bin/env python3
"""Copia de respaldo del trabajo de los estudiantes de la VM de editores (28-10-2026).

La corre como root el timer adaceen-ws-respaldo cada 15 min y, al apagar la VM, el servicio
adaceen-ws-respaldo-final (los dos los instala startup-ws.sh si la metadata respaldo-bucket
existe; la pone `bash deploy/gcp/respaldos.sh activar`).

  respaldo-ws.py                     copia lo que cambio desde la ultima vez
  respaldo-ws.py --al-apagar         lo mismo, con tiempos cortos (la VM se esta apagando)
  respaldo-ws.py --extraer <tar.gz> <carpeta>
                                     restaurar: lo corre respaldos.sh restaurar COMO el
                                     estudiante (runuser), en una carpeta nueva de su home

Que copia: por estudiante (/home/ws-<login>), sus carpetas y archivos de primer nivel que no
empiezan por punto (los repositorios), sin .git, build, node_modules, binarios ni archivos de
mas de 20 MB (la misma regla que deploy/gcp/recoger-entregas.sh). Sin enlaces simbolicos: un
estudiante no puede colar el trabajo de otro. Si nada cambio (huella de rutas, tamanos y
fechas), no sube nada.

A donde: gs://<bucket>/respaldos/<login>/<aaaa-mm-dd>/<hhmm>.tar.gz (hora de Bogota), con el
token de la cuenta de servicio de la VM (solo root llega al servidor de metadata). El bucket
borra solo lo que pasa de la retencion (respaldos.sh activar). Al terminar avisa al backend
(POST /api/workspaces/backup-report, con el token del agente): el «ultimo respaldo» que ve el
administrador. Nunca manda codigo al backend.
"""
import hashlib
import io
import json
import os
import stat
import sys
import tarfile
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

CONFIG = "/etc/adaceen-respaldo.env"
AGENTE = "/etc/adaceen-workspaces-agent.env"
WS_ENV = "/etc/adaceen-ws.env"
ESTADO = "/var/lib/adaceen-respaldo"
HOMES = "/home"
METADATA_TOKEN = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
STORAGE_UPLOAD = "https://storage.googleapis.com/upload/storage/v1/b/"

# La misma regla que recoger-entregas.sh.
EXCLUIR_DIRS = {".git", "build", "__pycache__", ".vscode-server", ".vscode-remote", "node_modules"}
EXCLUIR_ARCH = {"banco", "banco.exe", "a.out"}
EXCLUIR_EXT = (".o", ".d", ".exe", ".zip", ".obj")
MAX_ARCHIVO = 20 * 1024 * 1024
# Tope por estudiante y copia: lo que pase no entra (y queda dicho en el informe).
MAX_ESTUDIANTE = 200 * 1024 * 1024
BOGOTA = timezone(timedelta(hours=-5))


def leer_env(ruta):
    valores = {}
    try:
        with open(ruta, encoding="utf-8") as f:
            for linea in f:
                linea = linea.strip()
                if linea and not linea.startswith("#") and "=" in linea:
                    clave, valor = linea.split("=", 1)
                    valores[clave.strip()] = valor.strip()
    except OSError:
        pass
    return valores


def archivos_de(home):
    """(ruta relativa, ruta absoluta, stat) de lo que se copia, en orden estable."""
    salida = []
    try:
        entradas = sorted(os.listdir(home))
    except OSError:
        return salida
    for nombre in entradas:
        if nombre.startswith("."):
            continue
        ruta = os.path.join(home, nombre)
        try:
            st = os.lstat(ruta)
        except OSError:
            continue
        if stat.S_ISREG(st.st_mode):
            if incluir(nombre, st):
                salida.append((nombre, ruta, st))
            continue
        if not stat.S_ISDIR(st.st_mode) or nombre in EXCLUIR_DIRS:
            continue
        for dirpath, dirnames, filenames in os.walk(ruta, followlinks=False):
            dirnames[:] = sorted(d for d in dirnames if d not in EXCLUIR_DIRS and not os.path.islink(os.path.join(dirpath, d)))
            for f in sorted(filenames):
                absoluta = os.path.join(dirpath, f)
                try:
                    st = os.lstat(absoluta)
                except OSError:
                    continue
                if stat.S_ISREG(st.st_mode) and incluir(f, st):
                    salida.append((os.path.relpath(absoluta, home), absoluta, st))
    return salida


def incluir(nombre, st):
    return nombre not in EXCLUIR_ARCH and not nombre.endswith(EXCLUIR_EXT) and st.st_size <= MAX_ARCHIVO


def huella(archivos):
    h = hashlib.sha256()
    for rel, _abs, st in archivos:
        h.update(f"{rel}\0{st.st_size}\0{st.st_mtime_ns}\n".encode("utf-8", "surrogateescape"))
    return h.hexdigest()


def leer_sin_seguir(ruta):
    """Contenido de un archivo normal sin seguir enlaces (None si cambio o no se puede)."""
    try:
        # En la VM (Linux) estan las dos banderas; getattr solo para correr las pruebas en Windows.
        fd = os.open(ruta, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
    except OSError:
        return None
    with os.fdopen(fd, "rb") as fh:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        datos = fh.read(MAX_ARCHIVO + 1)
    return None if len(datos) > MAX_ARCHIVO else datos


def empaquetar(archivos):
    """tar.gz en memoria; devuelve (bytes, archivos incluidos, omitidos por el tope)."""
    buffer = io.BytesIO()
    total = 0
    incluidos = 0
    omitidos = 0
    with tarfile.open(fileobj=buffer, mode="w:gz", compresslevel=6) as tar:
        for rel, absoluta, st in archivos:
            if total + st.st_size > MAX_ESTUDIANTE:
                omitidos += 1
                continue
            datos = leer_sin_seguir(absoluta)
            if datos is None:
                continue
            info = tarfile.TarInfo(rel)
            info.size = len(datos)
            info.mtime = int(st.st_mtime)
            info.mode = 0o644
            tar.addfile(info, io.BytesIO(datos))
            total += len(datos)
            incluidos += 1
    return buffer.getvalue(), incluidos, omitidos


def token_de_la_vm(espera):
    pedido = urllib.request.Request(METADATA_TOKEN, headers={"Metadata-Flavor": "Google"})
    with urllib.request.urlopen(pedido, timeout=espera) as respuesta:
        return json.load(respuesta)["access_token"]


def subir(bucket, nombre, datos, token, espera):
    url = (STORAGE_UPLOAD + urllib.parse.quote(bucket, safe="")
           + "/o?uploadType=media&name=" + urllib.parse.quote(nombre, safe=""))
    pedido = urllib.request.Request(url, data=datos, method="POST", headers={
        "Authorization": "Bearer " + token,
        "Content-Type": "application/gzip",
    })
    with urllib.request.urlopen(pedido, timeout=espera) as respuesta:
        if respuesta.status >= 300:
            raise RuntimeError(f"HTTP {respuesta.status}")


def avisar_backend(informe, espera):
    api = leer_env(WS_ENV).get("ADACEEN_API_URL", "").rstrip("/")
    token = leer_env(AGENTE).get("AGENT_TOKEN", "")
    if not api or not token:
        return "sin ADACEEN_API_URL o sin token del agente: no se avisa al backend"
    pedido = urllib.request.Request(api + "/api/workspaces/backup-report", data=json.dumps(informe).encode(), method="POST", headers={
        "Content-Type": "application/json",
        "x-agent-token": token,
    })
    try:
        with urllib.request.urlopen(pedido, timeout=espera):
            return ""
    except Exception as error:  # el respaldo ya quedo; solo no se pudo avisar
        return f"no se pudo avisar al backend: {error}"


def respaldar(al_apagar):
    inicio = time.time()
    config = leer_env(CONFIG)
    bucket = config.get("BUCKET", "")
    prefijo = config.get("PREFIJO", "respaldos").strip("/") or "respaldos"
    if not bucket:
        print("sin BUCKET en " + CONFIG + ": respaldo apagado (bash deploy/gcp/respaldos.sh activar)")
        return 0
    espera = 15 if al_apagar else 60
    os.makedirs(ESTADO, mode=0o700, exist_ok=True)
    os.chmod(ESTADO, 0o700)
    ahora = datetime.now(BOGOTA)
    sello = ahora.strftime("%Y-%m-%d") + "/" + ahora.strftime("%H%M")
    token = None
    estudiantes = cambiaron = subidos = fallidos = bytes_subidos = omitidos = 0
    problema = ""
    for entrada in sorted(os.listdir(HOMES)):
        if not entrada.startswith("ws-"):
            continue
        home = os.path.join(HOMES, entrada)
        if os.path.islink(home) or not os.path.isdir(home):
            continue
        login = entrada[3:]
        estudiantes += 1
        archivos = archivos_de(home)
        if not archivos:
            continue
        marca = huella(archivos)
        ruta_huella = os.path.join(ESTADO, login + ".huella")
        try:
            with open(ruta_huella, encoding="utf-8") as f:
                if f.read().strip() == marca:
                    continue
        except OSError:
            pass
        cambiaron += 1
        try:
            datos, _incluidos, sin_lugar = empaquetar(archivos)
            omitidos += sin_lugar
            if token is None:
                token = token_de_la_vm(espera)
            subir(bucket, f"{prefijo}/{login}/{sello}.tar.gz", datos, token, espera)
            with open(ruta_huella, "w", encoding="utf-8") as f:
                f.write(marca)
            subidos += 1
            bytes_subidos += len(datos)
        except Exception as error:
            fallidos += 1
            problema = f"{login}: {error}"[:280]
            print("AVISO: no se pudo respaldar " + login + ": " + str(error))
    if omitidos and not problema:
        problema = f"{omitidos} archivo(s) no entraron: pasaban el tope de {MAX_ESTUDIANTE // (1024 * 1024)} MB por estudiante"
    informe = {
        "finishedAt": datetime.now(timezone.utc).isoformat(),
        "ok": fallidos == 0,
        "students": estudiantes,
        "changed": cambiaron,
        "uploaded": subidos,
        "failed": fallidos,
        "bytes": bytes_subidos,
        "durationMs": int((time.time() - inicio) * 1000),
        "bucket": "gs://" + bucket,
        "problem": problema,
    }
    with open(os.path.join(ESTADO, "ultimo.json"), "w", encoding="utf-8") as f:
        json.dump(informe, f)
    aviso = avisar_backend(informe, espera)
    print(f"respaldo {sello}: {estudiantes} estudiantes, {cambiaron} con cambios, {subidos} copiados, {fallidos} fallidos"
          + (f"; {aviso}" if aviso else ""))
    return 0 if fallidos == 0 else 1


def extraer(archivo, destino):
    """Restaura en una carpeta NUEVA (no pisa nada). Corre como el estudiante."""
    if os.path.lexists(destino):
        print("ya existe " + destino + ": no se pisa nada")
        return 1
    os.makedirs(destino, mode=0o700)
    base = os.path.realpath(destino)
    n = 0
    with tarfile.open(archivo, mode="r:gz") as tar:
        for miembro in tar:
            nombre = os.path.normpath(miembro.name)
            if not miembro.isfile() or nombre.startswith(("/", "..")) or os.path.isabs(nombre):
                continue
            final = os.path.realpath(os.path.join(base, nombre))
            if not final.startswith(base + os.sep):
                continue
            os.makedirs(os.path.dirname(final), mode=0o700, exist_ok=True)
            origen = tar.extractfile(miembro)
            if origen is None:
                continue
            with open(final, "xb") as salida:
                salida.write(origen.read())
            os.utime(final, (miembro.mtime, miembro.mtime))
            n += 1
    print(f"{n} archivos restaurados en {destino}")
    return 0


def main(argv):
    if len(argv) >= 1 and argv[0] == "--extraer":
        if len(argv) != 3:
            print("uso: respaldo-ws.py --extraer <tar.gz> <carpeta nueva>")
            return 2
        return extraer(argv[1], argv[2])
    if os.geteuid() != 0:
        print("el respaldo corre como root (timer adaceen-ws-respaldo)")
        return 2
    os.umask(0o077)
    return respaldar("--al-apagar" in argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
