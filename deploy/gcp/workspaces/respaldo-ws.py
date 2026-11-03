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

Entregas automaticas (02-11-2026, docs/operacion/entregas-drive.md): despues de la copia, por
cada taller y estudiante de PARA_ENTREGAS (lo deja avance-ws.py con el codigo del analisis que da
el backend), un .zip de la carpeta del taller a gs://<bucket>/entregas/<taller>/<codigo>/
<aaaa-mm-dd>_<hhmm>.zip y su manifiesto .json. Sin login, nombre ni ruta del home: el docente las
ve en Drive solo con el codigo. Se sube si la carpeta cambio y paso ENTREGA_CADA_MIN desde la
anterior (al apagar, sin esperar). ENTREGAS=off en CONFIG las apaga. Si algo falla, la copia de
respaldo vale igual.
"""
import hashlib
import io
import json
import os
import re
import stat
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile
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

# Entregas automaticas. PARA_ENTREGAS lo escribe avance-ws.py (root, en su carpeta 0700).
PARA_ENTREGAS = "/var/lib/adaceen-avance/para-entregas.json"
ENTREGAS_PREFIJO = "entregas"
ENTREGA_CADA_MIN = 60
# Un contrato mas viejo que esto es de cuando el avance dejo de correr: no se usa.
CONTRATO_MAX_EDAD_S = 2 * 60 * 60
MAX_CONTRATO = 2 * 1024 * 1024
MAX_ENTREGA = 50 * 1024 * 1024
MAX_CANDIDATAS = 5
MAX_ENTRADAS = 20000
MAX_PROFUNDIDAD = 20
# Hasta cuando (desde que empezo la corrida) se empiezan entregas: el timer es cada 15 min y al
# apagar systemd espera 80 s (TimeoutStopSec de adaceen-ws-respaldo-final); una entrega empezada
# puede tardar dos esperas de 15 s. Lo que no alcanza sigue en la proxima corrida.
PLAZO_ENTREGAS_S = 10 * 60
PLAZO_ENTREGAS_AL_APAGAR_S = 45
LOGIN_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,38}$")
TALLER_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")
CARPETA_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$")
CODIGO_RE = re.compile(r"^[0-9a-f]{20}$")
PREFIJO_RE = re.compile(r"^[A-Za-z0-9._-]{1,60}(/[A-Za-z0-9._-]{1,60}){0,3}$")
# Un nombre de archivo que puede ir en el zip sin sorpresas al abrirlo en Windows o macOS.
NOMBRE_SEGURO_RE = re.compile(r"^[^\x00-\x1f\x7f\\:*?\"<>|]{1,200}$")


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


class TokenDeLaVm:
    """El token de la VM, pedido una sola vez y solo si hace falta subir algo."""

    def __init__(self, espera):
        self.espera = espera
        self.valor = None

    def __call__(self):
        if self.valor is None:
            self.valor = token_de_la_vm(self.espera)
        return self.valor


def subir(bucket, nombre, datos, token, espera, tipo="application/gzip"):
    url = (STORAGE_UPLOAD + urllib.parse.quote(bucket, safe="")
           + "/o?uploadType=media&name=" + urllib.parse.quote(nombre, safe=""))
    pedido = urllib.request.Request(url, data=datos, method="POST", headers={
        "Authorization": "Bearer " + token,
        "Content-Type": tipo,
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


# =============================================================================================
# Entregas automaticas para el docente, con el codigo del analisis (nunca el login ni el nombre).

def leer_json_sin_seguir(ruta, maximo):
    """El JSON de un archivo normal sin seguir enlaces, o None."""
    try:
        fd = os.open(ruta, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    with os.fdopen(fd, "rb") as fh:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        datos = fh.read(maximo + 1)
    if len(datos) > maximo:
        return None
    try:
        return json.loads(datos)
    except Exception:  # ValueError, RecursionError...
        return None


def validar_contrato(datos, ahora):
    """(talleres, "") del contrato de avance-ws.py, o (None, motivo). Estricto: algo raro y no hay
    entregas en esta corrida (la copia de respaldo sigue igual)."""
    if not isinstance(datos, dict) or datos.get("version") != 1 or not isinstance(datos.get("talleres"), list):
        return None, "no es la version 1"
    try:
        generado = datetime.fromisoformat(str(datos.get("generadoEn"))).timestamp()
    except (TypeError, ValueError, OverflowError):
        return None, "sin fecha"
    if generado - ahora > 5 * 60:
        return None, "tiene una fecha futura"
    if ahora - generado > CONTRATO_MAX_EDAD_S:
        return None, "tiene mas de 2 horas (¿el avance de los talleres esta apagado?)"
    talleres = []
    for taller in datos["talleres"][:50]:
        if not isinstance(taller, dict) or not TALLER_RE.match(str(taller.get("taller", ""))) \
                or not CARPETA_RE.match(str(taller.get("carpeta", ""))) or not isinstance(taller.get("estudiantes"), dict):
            return None, "un taller no es valido"
        estudiantes = {}
        for login, datos_estudiante in taller["estudiantes"].items():
            if not isinstance(login, str) or not LOGIN_RE.match(login) or not isinstance(datos_estudiante, dict):
                return None, "un estudiante no es valido"
            codigo = datos_estudiante.get("codigo")
            avance = datos_estudiante.get("avance")
            compila = datos_estudiante.get("compila")
            if not isinstance(codigo, str) or not CODIGO_RE.match(codigo) or not isinstance(avance, int) \
                    or isinstance(avance, bool) or not 0 <= avance <= 100 or compila not in (True, False, None):
                return None, "un estudiante no es valido"
            estudiantes[login] = {"codigo": codigo, "avance": avance, "compila": compila}
        titulo = "".join(c for c in str(taller.get("titulo") or taller["taller"]) if c.isprintable())[:120]
        talleres.append({"taller": taller["taller"], "titulo": titulo or taller["taller"], "carpeta": taller["carpeta"], "estudiantes": estudiantes})
    return talleres, ""


def config_de_entregas(config):
    """{prefijo, cada_min} o None si ENTREGAS=off en CONFIG."""
    if config.get("ENTREGAS", "on").strip().lower() in ("off", "0", "no", "false"):
        return None
    prefijo = config.get("ENTREGAS_PREFIJO", ENTREGAS_PREFIJO).strip("/")
    cada = config.get("ENTREGA_CADA_MIN", "")
    return {
        "prefijo": prefijo if PREFIJO_RE.match(prefijo) else ENTREGAS_PREFIJO,
        "cada_min": int(cada) if cada.isdigit() and len(cada) <= 4 else ENTREGA_CADA_MIN,
    }


def abrir_carpeta(nombre, dir_fd=None):
    """Una carpeta (nunca un enlace: O_NOFOLLOW con O_DIRECTORY falla si lo es)."""
    return os.open(nombre, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0), dir_fd=dir_fd)


def abrir_partes(raiz_fd, partes):
    """La carpeta raiz/partes[0]/partes[1]/..., abriendo cada parte desde la anterior y sin seguir
    enlaces: un estudiante que cambia una carpeta por un enlace a mitad de camino no lleva a root
    al home de otro."""
    fd = os.dup(raiz_fd)
    try:
        for parte in partes:
            siguiente = abrir_carpeta(parte, fd)
            os.close(fd)
            fd = siguiente
        return fd
    except OSError:
        os.close(fd)
        raise


def archivos_de_entrega(raiz_fd):
    """[(partes de la ruta, stat)] de lo que va en la entrega: la regla de la copia (EXCLUIR_*,
    MAX_ARCHIVO, sin enlaces, solo archivos normales) y ademas sin lo oculto (.vscode, .env...: no es
    parte del trabajo y puede traer la ruta del home). A lo sumo MAX_ENTRADAS entradas."""
    salida = []
    pendientes = [()]
    vistas = 0
    while pendientes and vistas <= MAX_ENTRADAS:
        partes = pendientes.pop()
        try:
            fd = abrir_partes(raiz_fd, partes)
        except OSError:
            continue
        try:
            for nombre in sorted(os.listdir(fd)):
                vistas += 1
                if vistas > MAX_ENTRADAS:
                    break
                if nombre.startswith(".") or not NOMBRE_SEGURO_RE.match(nombre):
                    continue
                try:
                    nombre.encode("utf-8")
                    st = os.stat(nombre, dir_fd=fd, follow_symlinks=False)
                except (OSError, UnicodeEncodeError):
                    continue
                if stat.S_ISDIR(st.st_mode):
                    if nombre not in EXCLUIR_DIRS and len(partes) < MAX_PROFUNDIDAD:
                        pendientes.append(partes + (nombre,))
                elif stat.S_ISREG(st.st_mode) and incluir(nombre, st):
                    salida.append((partes + (nombre,), st))
        except OSError:
            pass
        finally:
            os.close(fd)
    salida.sort(key=lambda archivo: archivo[0])
    return salida


def carpeta_de_entrega(home_fd, nombre):
    """(fd, entrada, archivos) de la carpeta del taller en el home, con la regla de avance-ws.py
    (carpeta_del_taller): <nombre> o <nombre>-<algo>, la de nombre exacto primero, a lo sumo
    MAX_CANDIDATAS, solo carpetas (sin enlaces) y gana la del cambio mas reciente. (None, None, [])
    si no hay. El fd lo cierra quien llama."""
    try:
        entradas = os.listdir(home_fd)
    except OSError:
        return None, None, []
    candidatas = sorted(e for e in entradas if e == nombre or e.startswith(nombre + "-"))
    candidatas = ([nombre] if nombre in candidatas else []) + [e for e in candidatas if e != nombre]
    mejor = None
    for entrada in candidatas[:MAX_CANDIDATAS]:
        try:
            fd = abrir_carpeta(entrada, home_fd)
        except OSError:
            continue
        archivos = archivos_de_entrega(fd)
        reciente = max((st.st_mtime for _partes, st in archivos), default=os.fstat(fd).st_mtime)
        if mejor is None or reciente > mejor[0]:
            if mejor:
                os.close(mejor[1])
            mejor = (reciente, fd, entrada, archivos)
        else:
            os.close(fd)
    return (mejor[1], mejor[2], mejor[3]) if mejor else (None, None, [])


def huella_de_entrega(entrada, archivos):
    h = hashlib.sha256(entrada.encode("utf-8", "surrogateescape") + b"\0")
    for partes, st in archivos:
        h.update(f"{'/'.join(partes)}\0{st.st_size}\0{st.st_mtime_ns}\n".encode("utf-8", "surrogateescape"))
    return h.hexdigest()


def leer_de_entrega(raiz_fd, partes, listado):
    """El contenido de un archivo de la entrega, abierto desde la carpeta del taller sin seguir
    enlaces y solo si es el mismo archivo que se listo (dispositivo e inodo). None si no."""
    try:
        carpeta = abrir_partes(raiz_fd, partes[:-1])
    except OSError:
        return None
    try:
        fd = os.open(partes[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0), dir_fd=carpeta)
    except OSError:
        return None
    finally:
        os.close(carpeta)
    with os.fdopen(fd, "rb") as fh:
        actual = os.fstat(fd)
        if not stat.S_ISREG(actual.st_mode) or (actual.st_dev, actual.st_ino) != (listado.st_dev, listado.st_ino):
            return None
        datos = fh.read(MAX_ARCHIVO + 1)
    return None if len(datos) > MAX_ARCHIVO else datos


def empaquetar_entrega(raiz_fd, carpeta, archivos):
    """(bytes del .zip, archivos incluidos). Cada entrada es <carpeta>/<ruta dentro de la carpeta
    del taller>, con el nombre del taller (aunque la carpeta real sea <carpeta>-2): nada del home ni
    del login. Hasta MAX_ENTREGA en total."""
    buffer = io.BytesIO()
    total = 0
    incluidos = 0
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for partes, st in archivos:
            if total + st.st_size > MAX_ENTREGA:
                continue
            datos = leer_de_entrega(raiz_fd, partes, st)
            if datos is None or total + len(datos) > MAX_ENTREGA:  # pudo crecer desde que se listo
                continue
            # ZIP guarda fechas de 1980 a 2107: una fecha fuera de ahi (un reloj malo) se acota.
            fecha = datetime.fromtimestamp(min(max(st.st_mtime, 315619200), 4102444800), BOGOTA).timetuple()[:6]
            info = zipfile.ZipInfo(carpeta + "/" + "/".join(partes), date_time=fecha)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, datos)
            total += len(datos)
            incluidos += 1
    return buffer.getvalue(), incluidos


def leer_estado_entrega(ruta):
    datos = leer_json_sin_seguir(ruta, 4096)
    return datos if isinstance(datos, dict) else {}


def guardar_estado_entrega(carpeta, nombre, datos):
    fd, temporal = tempfile.mkstemp(prefix=".entrega-", dir=carpeta)  # 0600
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(datos, f)
        os.replace(temporal, os.path.join(carpeta, nombre))
    except OSError:
        try:
            os.unlink(temporal)
        except OSError:
            pass
        raise


def entregar_estudiante(bucket, opciones, taller, login, datos, ahora, token, espera):
    """"subida", "igual", "esperando", "sin-carpeta" o "vacia". Lanza si falla la subida."""
    try:
        home_fd = abrir_carpeta(os.path.join(HOMES, "ws-" + login))
    except OSError:
        return "sin-carpeta"
    try:
        raiz_fd, entrada, archivos = carpeta_de_entrega(home_fd, taller["carpeta"])
    finally:
        os.close(home_fd)
    if raiz_fd is None:
        return "sin-carpeta"
    try:
        if not archivos:
            return "vacia"
        marca = huella_de_entrega(entrada, archivos)
        nombre_estado = f"{taller['taller']}--{datos['codigo']}.json"
        previo = leer_estado_entrega(os.path.join(opciones["estado"], nombre_estado))
        if previo.get("huella") == marca:
            return "igual"
        subido_en = previo.get("subidoEn")
        subido_en = float(subido_en) if isinstance(subido_en, (int, float)) and not isinstance(subido_en, bool) else 0.0
        base = f"{opciones['prefijo']}/{taller['taller']}/{datos['codigo']}/{ahora.strftime('%Y-%m-%d_%H%M')}"
        # En el mismo minuto que la anterior (la copia al apagar justo despues de la del timer) el
        # nombre seria el mismo, y la cuenta de la VM no puede reemplazar objetos: va en la proxima.
        if previo.get("objeto") == base + ".zip":
            return "esperando"
        if not opciones["al_apagar"] and ahora.timestamp() - subido_en < opciones["cada_min"] * 60:
            return "esperando"
        zip_bytes, incluidos = empaquetar_entrega(raiz_fd, taller["carpeta"], archivos)
    finally:
        os.close(raiz_fd)
    if not incluidos:
        return "vacia"
    sha = hashlib.sha256(zip_bytes).hexdigest()
    manifiesto = {
        "version": 1,
        "taller": taller["taller"],
        "titulo": taller["titulo"],
        "codigo": datos["codigo"],
        "fecha": ahora.isoformat(timespec="seconds"),
        "sha256": sha,
        "bytes": len(zip_bytes),
        "archivos": incluidos,
        "avance": datos["avance"],
        "compila": datos["compila"],
    }
    # Primero el zip y despues el manifiesto: el Apps Script de Drive solo lee manifiestos, asi
    # que nunca ve uno sin su zip.
    subir(bucket, base + ".zip", zip_bytes, token(), espera, "application/zip")
    subir(bucket, base + ".json", json.dumps(manifiesto, ensure_ascii=False).encode("utf-8"), token(), espera, "application/json")
    guardar_estado_entrega(opciones["estado"], nombre_estado, {"huella": marca, "subidoEn": ahora.timestamp(), "objeto": base + ".zip"})
    return "subida"


def entregar(bucket, config, ahora, token, espera, al_apagar, plazo):
    """(subidas, fallidas, nota) de las entregas de esta corrida, hasta `plazo` (time.time()). Lo
    que falle aqui no toca la copia de respaldo."""
    opciones = config_de_entregas(config)
    if opciones is None:
        return 0, 0, "entregas apagadas (ENTREGAS=off)"
    # Abrir cada carpeta desde la anterior sin seguir enlaces (dir_fd) es de Linux, como la VM.
    if os.open not in os.supports_dir_fd or not hasattr(os, "O_DIRECTORY") or not hasattr(os, "O_NOFOLLOW"):
        return 0, 0, "sin entregas: este sistema no abre carpetas sin seguir enlaces"
    talleres, motivo = validar_contrato(leer_json_sin_seguir(PARA_ENTREGAS, MAX_CONTRATO), ahora.timestamp())
    if talleres is None:
        return 0, 0, "sin entregas: " + (motivo if os.path.lexists(PARA_ENTREGAS) else "todavia no hay " + os.path.basename(PARA_ENTREGAS))
    opciones["al_apagar"] = al_apagar
    opciones["estado"] = os.path.join(ESTADO, "entregas")
    os.makedirs(opciones["estado"], mode=0o700, exist_ok=True)
    os.chmod(opciones["estado"], 0o700)
    subidas = fallidas = 0
    nota = ""
    for taller in talleres:
        vistos = set()
        for login in sorted(taller["estudiantes"]):
            datos = taller["estudiantes"][login]
            # Dos logins con el mismo codigo (cuentas unidas): una entrega por codigo, la primera.
            if datos["codigo"] in vistos:
                continue
            vistos.add(datos["codigo"])
            if time.time() > plazo:
                return subidas, fallidas, "se acabo el plazo de las entregas: siguen en la proxima corrida"
            try:
                if entregar_estudiante(bucket, opciones, taller, login, datos, ahora, token, espera) == "subida":
                    subidas += 1
            except Exception as error:
                fallidas += 1
                nota = f"entrega de {taller['taller']}/{datos['codigo']}: {error}"[:280]
                print("AVISO: no se pudo subir la entrega " + datos["codigo"] + ": " + str(error))
    return subidas, fallidas, nota


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
    token = TokenDeLaVm(espera)
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
            subir(bucket, f"{prefijo}/{login}/{sello}.tar.gz", datos, token(), espera)
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
    # Las entregas, despues de avisar: si al apagar se acaba el tiempo, la copia y su informe ya
    # quedaron. Sus cuentas van al resumen y a ultimo.json (el backend no las guarda).
    try:
        plazo = inicio + (PLAZO_ENTREGAS_AL_APAGAR_S if al_apagar else PLAZO_ENTREGAS_S)
        entregas, entregas_fallidas, nota_entregas = entregar(bucket, config, ahora, token, espera, al_apagar, plazo)
    except Exception as error:  # nada de las entregas tumba la copia
        entregas, entregas_fallidas, nota_entregas = 0, 1, f"entregas: {error}"[:280]
    try:
        with open(os.path.join(ESTADO, "ultimo.json"), "w", encoding="utf-8") as f:
            json.dump({**informe, "entregas": entregas, "entregasFallidas": entregas_fallidas, "notaEntregas": nota_entregas}, f)
    except OSError:
        pass
    print(f"respaldo {sello}: {estudiantes} estudiantes, {cambiaron} con cambios, {subidos} copiados, {fallidos} fallidos"
          + f"; {entregas} entregas, {entregas_fallidas} fallidas" + (f" ({nota_entregas})" if nota_entregas else "")
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
