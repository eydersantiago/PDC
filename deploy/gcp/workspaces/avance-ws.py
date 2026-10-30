#!/usr/bin/env python3
"""Avance de cada estudiante en un taller, en la VM de editores (29-10-2026).

La corre como root el timer adaceen-ws-avance cada 10 min (lo instala startup-ws.sh). Por cada
taller de /opt/adaceen/talleres/*.json (por ahora el Sistema bancario) y cada estudiante
(/home/ws-<login>), mira la carpeta del taller en su home y calcula un porcentaje con los puntos
del archivo: clases, atributos, metodos con cuerpo, herencia, lo que hace main y si compila.

  avance-ws.py                 evalua y avisa al backend (POST /api/workspaces/progress-report)
  avance-ws.py --sin-avisar    evalua e imprime un resumen, sin avisar (para probar en la VM)
  avance-ws.py --json          evalua e imprime los informes en JSON, sin avisar (la «foto» de
                               deploy/gcp/avance-taller.sh foto)
    [--talleres <carpeta>]     otra carpeta de talleres (la foto los sube a una carpeta temporal)
  avance-ws.py --evaluar <taller.json> <home> [--previo <huella>]
                               UN estudiante; lo corre root COMO el estudiante (runuser)

Root no lee, no recorre ni compila nada de la carpeta de un estudiante: por cada uno lanza este
mismo script con --evaluar como ese estudiante (runuser, env -i, python3 -I, timeout, nice), en /.
Asi un enlace simbolico o una carpeta cambiada a mitad de camino solo lleva a donde el estudiante
ya puede llegar. Root valida lo que devuelve (porcentaje, ids conocidos) y le pone el login el.

Es una estimacion para el docente, no la nota: lee el codigo con reglas sencillas (sin
comentarios ni textos, en una sola pasada por archivo) y no ejecuta el programa. Compila como
`make` con salida a /dev/null. Si nada cambio desde la ultima vez (huella de rutas, tamanos y
fechas, y la VERSION de este script), reusa el resultado guardado, tambien si la vez anterior se
acabo el tiempo. Hay un plazo por estudiante y uno para toda la corrida: lo que no alcanza va con
el resultado anterior o como pendiente, y el informe sale igual.

Al backend solo van el login, el porcentaje, que puntos faltan, si compila, cuantos archivos y
la fecha del ultimo cambio. Nunca el codigo.
"""
import hashlib
import json
import os
import pwd
import re
import select
import stat
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone

VERSION = "2026-10-29.4"
SCRIPT = os.path.abspath(__file__)
TALLERES = "/opt/adaceen/talleres"
AGENTE = "/etc/adaceen-workspaces-agent.env"
WS_ENV = "/etc/adaceen-ws.env"
ESTADO = "/var/lib/adaceen-avance"
HOMES = "/home"

EXTENSIONES = (".h", ".hpp", ".hh", ".cpp", ".cc", ".cxx")
EXCLUIR_DIRS = {".git", "build", "__pycache__", ".vscode", ".vscode-server", "node_modules", "docs"}
MAX_ARCHIVO = 512 * 1024
MAX_TOTAL = 4 * 1024 * 1024
MAX_ARCHIVOS = 200
MAX_COINCIDENCIAS = 3000
# Lo que se recorre de una carpeta (carpetas y archivos) y cuantas carpetas del taller se miran.
MAX_ENTRADAS = 20000
MAX_CANDIDATAS = 5
# Lo que root lee de la salida de un --evaluar: lo demas no se guarda en memoria (con ptrace, el
# estudiante puede escribir lo que quiera en esa salida).
MAX_SALIDA = 64 * 1024
# Un estudiante que se quedo sin tiempo se vuelve a intentar despues de esto aunque nada cambie.
REINTENTAR_TIEMPO_S = 60 * 60
# Plazos: por estudiante (lectura + compilacion) y para toda la corrida (el timer es cada 10 min).
COMO_ESTUDIANTE = True
COMPILADOR = ["g++", "-std=c++17", "-w"]
SEGUNDOS_COMPILAR = 90
SEGUNDOS_POR_ESTUDIANTE = 150
SEGUNDOS_CORRIDA = 8 * 60
PATH_SEGURO = "/usr/local/bin:/usr/bin:/bin"
RUNUSER = "/usr/sbin/runuser" if os.path.exists("/usr/sbin/runuser") else "runuser"
LOGIN_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,38}$")
PUNTO_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,59}$")
TALLER_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")
CARPETA_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$")
HUELLA_RE = re.compile(r"^[0-9a-f]{64}$")


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


def iso(segundos):
    return datetime.fromtimestamp(segundos, timezone.utc).isoformat() if segundos else None


# =============================================================================================
# Parte del estudiante (--evaluar): corre con SU usuario. Nada de esto corre como root.

def fuentes_de(carpeta):
    """(ruta relativa, ruta absoluta, stat) de los .h/.cpp de la carpeta del taller, sin enlaces.
    Recorre a lo sumo MAX_ENTRADAS entradas (una carpeta con millones de archivos no la traba)."""
    salida = []
    total = 0
    vistas = 0
    for dirpath, dirnames, filenames in os.walk(carpeta, followlinks=False):
        vistas += len(dirnames) + len(filenames)
        if vistas > MAX_ENTRADAS:
            return salida
        dirnames[:] = sorted(d for d in dirnames if d not in EXCLUIR_DIRS and not d.startswith(".")
                             and not os.path.islink(os.path.join(dirpath, d)))
        for nombre in sorted(filenames):
            if not nombre.lower().endswith(EXTENSIONES):
                continue
            absoluta = os.path.join(dirpath, nombre)
            try:
                st = os.lstat(absoluta)
            except OSError:
                continue
            if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_ARCHIVO or total + st.st_size > MAX_TOTAL:
                continue
            total += st.st_size
            salida.append((os.path.relpath(absoluta, carpeta), absoluta, st))
            if len(salida) >= MAX_ARCHIVOS:
                return salida
    return salida


def huella(archivos, taller):
    h = hashlib.sha256(VERSION.encode() + b"\0" + json.dumps(taller, sort_keys=True).encode())
    for rel, _abs, st in archivos:
        h.update(f"{rel}\0{st.st_size}\0{st.st_mtime_ns}\n".encode("utf-8", "surrogateescape"))
    return h.hexdigest()


def leer_sin_seguir(ruta):
    try:
        fd = os.open(ruta, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
    except OSError:
        return ""
    with os.fdopen(fd, "rb") as fh:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return ""
        datos = fh.read(MAX_ARCHIVO + 1)
    if len(datos) > MAX_ARCHIVO:
        return ""
    return datos.decode("utf-8", "replace")


def limpiar(texto):
    """Quita comentarios, textos entre comillas y lineas del preprocesador; conserva los saltos."""
    out = []
    i = 0
    n = len(texto)
    inicio_linea = True
    while i < n:
        c = texto[i]
        if inicio_linea and c == "#":
            j = i
            while j < n:  # la directiva sigue en la siguiente linea si termina en \
                k = texto.find("\n", j)
                if k < 0:
                    j = n
                    break
                if texto[k - 1] == "\\":
                    out.append("\n")
                    j = k + 1
                    continue
                j = k
                break
            i = j
            continue
        if c == "/" and i + 1 < n and texto[i + 1] == "/":
            j = texto.find("\n", i)
            i = n if j < 0 else j
            continue
        if c == "/" and i + 1 < n and texto[i + 1] == "*":
            j = texto.find("*/", i + 2)
            fin = n if j < 0 else j + 2
            out.append("\n" * texto.count("\n", i, fin))
            i = fin
            continue
        if c in "\"'":
            j = i + 1
            while j < n and texto[j] != c and texto[j] != "\n":
                j += 2 if texto[j] == "\\" else 1
            out.append(c + c)
            i = j + 1
            continue
        if c == "\n":
            inicio_linea = True
        elif not c.isspace():
            inicio_linea = False
        out.append(c)
        i += 1
    return "".join(out)


def parejas(texto):
    """{indice de { o (: indice de su cierre}, en UNA pasada (sin cierre: len(texto))."""
    pares = {}
    pilas = {"{": [], "(": []}
    cierra = {"}": "{", ")": "("}
    for i, c in enumerate(texto):
        if c in pilas:
            pilas[c].append(i)
        elif c in cierra and pilas[cierra[c]]:
            pares[pilas[cierra[c]].pop()] = i
    for pila in pilas.values():
        for i in pila:
            pares[i] = len(texto)
    return pares


IDENT = re.compile(r"[A-Za-z_]\w*")
NO_ESPACIO = re.compile(r"\S")
NO_SON_NOMBRES = {"if", "for", "while", "switch", "return", "sizeof", "catch", "decltype", "alignof", "static_assert", "operator"}
ACCESO = re.compile(r"\b(public|private|protected)\s*:")
CLASE_RE = re.compile(r"\b(class|struct)\s+([A-Za-z_]\w*)\s*(?:final\s*)?(:[^{};()]{0,300})?\{")
DEFINICION_RE = re.compile(r"\b([A-Za-z_]\w*)\s*::\s*(~?[A-Za-z_]\w*)\s*\(")
TRAS_PARENTESIS = re.compile(r"\s*((?:const|override|noexcept|final|volatile|&|\s)*)(:[^;{}]*)?\{")


def con_cuerpo(texto, abre, cierra):
    return NO_ESPACIO.search(texto, abre + 1, cierra) is not None


def igual_fuera_de_plantillas(cabecera):
    """Posicion del primer = que no esta dentro de <...> (o -1)."""
    nivel = 0
    for i, ch in enumerate(cabecera):
        if ch == "<":
            nivel += 1
        elif ch == ">":
            nivel = max(0, nivel - 1)
        elif ch == "=" and nivel == 0:
            return i
    return -1


def miembros_de(texto, pares, desde, hasta, nombre_clase):
    """Atributos y metodos del primer nivel del cuerpo de una clase (texto[desde:hasta])."""
    atributos = set()
    metodos = {}  # nombre en minusculas -> {"virtual", "override", "cuerpo": True|False|None}

    def registrar(cabecera, cuerpo):
        cabecera = ACCESO.sub(" ", cabecera).strip()
        if not cabecera:
            return
        palabras = IDENT.findall(cabecera)
        if not palabras or palabras[0] in ("using", "typedef", "friend", "static_assert", "enum", "class", "struct", "union"):
            return
        parentesis = cabecera.find("(")
        igual = igual_fuera_de_plantillas(cabecera)
        if parentesis >= 0 and not (0 <= igual < parentesis):
            antes = cabecera[:parentesis]
            nombres = IDENT.findall(antes)
            if not nombres:
                return
            nombre = nombres[-1]
            if antes.rstrip().endswith("~" + nombre) or nombre in NO_SON_NOMBRES:
                return
            nivel = 0
            fin = len(cabecera)
            for k in range(parentesis, len(cabecera)):
                if cabecera[k] == "(":
                    nivel += 1
                elif cabecera[k] == ")":
                    nivel -= 1
                    if nivel == 0:
                        fin = k
                        break
            despues = cabecera[fin + 1:]
            info = metodos.setdefault(nombre.lower(), {"virtual": False, "override": False, "cuerpo": None})
            info["virtual"] = info["virtual"] or "virtual" in nombres
            info["override"] = info["override"] or bool(re.search(r"\boverride\b", despues))
            if cuerpo is not None:
                inicializa = nombre == nombre_clase and re.search(r"\)\s*:", cabecera)
                info["cuerpo"] = bool(cuerpo or inicializa) or info["cuerpo"] is True
            elif re.search(r"=\s*default\b", despues):
                info["cuerpo"] = True
            elif info["cuerpo"] is None:
                info["cuerpo"] = False
            return
        # Atributos: "tipo a, b = 3;" o "tipo a{0};" (las comas dentro de <...> no separan)
        partes = []
        nivel = 0
        actual = ""
        for ch in cabecera:
            if ch == "<":
                nivel += 1
            elif ch == ">":
                nivel = max(0, nivel - 1)
            if ch == "," and nivel == 0:
                partes.append(actual)
                actual = ""
            else:
                actual += ch
        partes.append(actual)
        for parte in partes:
            parte = re.split(r"[=\[{(]", parte)[0]
            nombres = IDENT.findall(parte)
            if nombres and nombres[-1] not in ("const", "static", "mutable"):
                atributos.add(nombres[-1].lower())

    i = desde
    inicio = desde
    while i < hasta:
        c = texto[i]
        if c == "(":
            i = min(pares.get(i, hasta), hasta) + 1
            continue
        if c == "{":
            fin = min(pares.get(i, hasta), hasta)
            cabecera = texto[inicio:i]
            if "(" in cabecera and not (0 <= igual_fuera_de_plantillas(cabecera) < cabecera.find("(")):
                registrar(cabecera, con_cuerpo(texto, i, fin))
            elif not re.search(r"\b(class|struct|enum|union)\b", cabecera):
                registrar(cabecera, None)  # atributo con llaves: long saldo{0};
            inicio = fin + 1
            i = fin + 1
            if i < hasta and texto[i] == ";":
                inicio = i + 1
                i += 1
            continue
        if c == ";":
            registrar(texto[inicio:i], None)
            inicio = i + 1
        i += 1
    return atributos, metodos


def definiciones_fuera(texto, pares):
    """{(clase, metodo) en minusculas: tiene cuerpo} de las definiciones Clase::metodo(...) {...}."""
    salida = {}
    for n, m in enumerate(DEFINICION_RE.finditer(texto)):
        if n >= MAX_COINCIDENCIAS:
            break
        clase, metodo = m.group(1), m.group(2)
        if metodo.startswith("~"):
            continue
        cierra = pares.get(m.end() - 1, len(texto))
        d = TRAS_PARENTESIS.match(texto, cierra + 1, min(len(texto), cierra + 400))
        if not d:
            continue
        abre = d.end() - 1
        cuerpo = con_cuerpo(texto, abre, pares.get(abre, len(texto)))
        inicializa = bool(d.group(2)) and metodo == clase
        clave = (clase.lower(), metodo.lower())
        salida[clave] = salida.get(clave, False) or cuerpo or inicializa
    return salida


def cuerpo_main(texto, pares):
    m = re.search(r"\bint\s+main\s*\(", texto)
    if not m:
        return None
    cierra = pares.get(m.end() - 1, len(texto))
    abre = texto.find("{", cierra)
    if abre < 0:
        return None
    return texto[abre + 1:pares.get(abre, len(texto))]


def analizar(fuentes):
    """Modelo del codigo: clases (bases, atributos, metodos), definiciones fuera y main."""
    clases = {}
    definiciones = {}
    main = None
    for texto in fuentes:
        limpio = limpiar(texto)
        pares = parejas(limpio)
        hasta_aqui = -1  # las clases anidadas no se recorren otra vez (todo queda lineal)
        for n, m in enumerate(CLASE_RE.finditer(limpio)):
            if n >= MAX_COINCIDENCIAS:
                break
            if m.start() < hasta_aqui:
                continue
            nombre = m.group(2)
            abre = m.end() - 1
            cierra = pares.get(abre, len(limpio))
            hasta_aqui = cierra
            bases = set()
            for parte in (m.group(3) or "")[1:].split(","):
                palabras = [p for p in IDENT.findall(parte) if p not in ("public", "private", "protected", "virtual")]
                if palabras:
                    bases.add(palabras[-1].lower())
            atributos, metodos = miembros_de(limpio, pares, abre + 1, cierra, nombre)
            clase = clases.setdefault(nombre.lower(), {"bases": set(), "atributos": set(), "metodos": {}})
            clase["bases"] |= bases
            clase["atributos"] |= atributos
            for clave, info in metodos.items():
                previo = clase["metodos"].get(clave)
                if previo is None:
                    clase["metodos"][clave] = dict(info)
                else:
                    previo["virtual"] = previo["virtual"] or info["virtual"]
                    previo["override"] = previo["override"] or info["override"]
                    previo["cuerpo"] = True if (previo["cuerpo"] or info["cuerpo"]) else (previo["cuerpo"] if info["cuerpo"] is None else info["cuerpo"])
        for clave, cuerpo in definiciones_fuera(limpio, pares).items():
            definiciones[clave] = definiciones.get(clave, False) or cuerpo
        if main is None:
            main = cuerpo_main(limpio, pares)
    return {"clases": clases, "definiciones": definiciones, "main": main}


def alternativas(nombre):
    return [a.strip().lower() for a in nombre.split("|") if a.strip()]


def nota_metodo(modelo, clase, nombre):
    """1 si esta implementado, 0.5 si solo esta declarado, 0 si no esta."""
    datos = modelo["clases"].get(clase.lower())
    mejor = 0.0
    for alt in alternativas(nombre):
        fuera = modelo["definiciones"].get((clase.lower(), alt))
        dentro = datos["metodos"].get(alt) if datos else None
        if fuera or (dentro and dentro["cuerpo"]):
            return 1.0
        if dentro is not None or fuera is False:
            mejor = 0.5
    return mejor


def evaluar_punto(punto, modelo, compila):
    """Fraccion de 0 a 1 del punto."""
    tipo = punto.get("tipo")
    clase = str(punto.get("clase", ""))
    datos = modelo["clases"].get(clase.lower())
    nombres = punto.get("nombres") or []
    if tipo == "clase":
        return 1.0 if datos else 0.0
    if tipo == "atributos":
        if not datos or not nombres:
            return 0.0
        return sum(1 for n in nombres if any(a in datos["atributos"] for a in alternativas(n))) / len(nombres)
    if tipo == "metodos":
        if not nombres:
            return 0.0
        return sum(nota_metodo(modelo, clase, n) for n in nombres) / len(nombres)
    if tipo == "hereda":
        return 1.0 if datos and str(punto.get("base", "")).lower() in datos["bases"] else 0.0
    if tipo == "virtual":
        metodo = str(punto.get("metodo", "")).lower()
        if datos and datos["metodos"].get(metodo, {}).get("virtual"):
            return 1.0
        derivada = modelo["clases"].get(str(punto.get("derivada", "")).lower())
        return 1.0 if derivada and derivada["metodos"].get(metodo, {}).get("override") else 0.0
    if tipo == "main":
        cuerpo = modelo["main"]
        if cuerpo is None or not nombres:
            return 0.0
        usados = {p.lower() for p in IDENT.findall(cuerpo)}
        return sum(1 for n in nombres if any(a in usados for a in alternativas(n))) / len(nombres)
    if tipo == "compila":
        return 1.0 if compila else 0.0
    return 0.0


def calificar(taller, modelo, compila):
    """(porcentaje entero, puntos completos, a medias, faltantes)."""
    total = sum(float(p.get("peso", 0)) for p in taller["puntos"]) or 1.0
    logrado = 0.0
    completos, medios, faltan = [], [], []
    for punto in taller["puntos"]:
        fraccion = evaluar_punto(punto, modelo, compila)
        logrado += fraccion * float(punto.get("peso", 0))
        (completos if fraccion >= 0.999 else medios if fraccion > 0 else faltan).append(punto["id"])
    return int(round(100 * logrado / total)), completos, medios, faltan


def a_compilar(archivos):
    """Los .cpp que compila el Makefile del taller (src/*.cpp y src/modelo/*.cpp); sin src/, todos.
    Con src/, una copia suelta (respaldo/main.cpp) no se compila ni se lee."""
    cpps = [rel for rel, _abs, _st in archivos if rel.lower().endswith((".cpp", ".cc", ".cxx"))]
    if not any(rel.split(os.sep)[0] == "src" for rel, _abs, _st in archivos):
        return cpps
    return [rel for rel in cpps if os.path.dirname(rel) in ("src", os.path.join("src", "modelo"))]


def fuera_de_src(archivos):
    """Cuantos .h/.cpp estan fuera de src/ e include/ habiendo src/ (el Makefile no los compila)."""
    if not any(rel.split(os.sep)[0] == "src" for rel, _abs, _st in archivos):
        return 0
    return sum(1 for rel, _abs, _st in archivos if rel.split(os.sep)[0] not in ("src", "include"))


def a_analizar(archivos):
    """Lo que se lee: todo, con lo que se compila primero (el main de src/ gana a una copia suelta).

    Foto del 29-10: un estudiante con 13 archivos salia en 0 % porque sus clases no estaban en
    src/ (se leia solo src/ e include/). Su trabajo cuenta igual; que el Makefile no lo compile ya
    lo dicen «compila» y `outside`."""
    compilados = set(a_compilar(archivos))
    return [a for a in archivos if a[0] in compilados] + [a for a in archivos if a[0] not in compilados]


def compilar(carpeta, archivos, segundos):
    """True si compila y enlaza como `make` (salida a /dev/null), False si no, None si no se supo.

    Ya corre como el estudiante (--evaluar): no ejecuta lo que compila."""
    cpps = a_compilar(archivos)
    if not cpps or segundos < 5:
        return None
    incluir = []
    for sub in ("src", os.path.join("src", "modelo"), "include"):
        if os.path.isdir(os.path.join(carpeta, sub)):
            incluir.append("-I" + sub)
    # ./ adelante: un archivo que empieza por - no llega a g++ como opcion.
    comando = COMPILADOR + incluir + ["./" + rel for rel in cpps] + ["-o", os.devnull]
    try:
        resultado = subprocess.run(comando, cwd=carpeta, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, timeout=segundos,
                                   env={"PATH": PATH_SEGURO, "LANG": "C.UTF-8"})
    except (OSError, subprocess.TimeoutExpired):
        return None
    return resultado.returncode == 0


def carpeta_del_taller(home, nombre):
    """(carpeta, archivos) del taller en el home: <carpeta>, o la mas reciente de <carpeta>-<algo>
    (un segundo clon o un fork se clonan asi), a lo sumo MAX_CANDIDATAS. (None, []) si no hay."""
    try:
        entradas = os.listdir(home)
    except OSError:
        return None, []
    candidatas = sorted(e for e in entradas if e == nombre or e.startswith(nombre + "-"))
    # La de nombre exacto primero; despues las demas, hasta el tope.
    candidatas = ([nombre] if nombre in candidatas else []) + [e for e in candidatas if e != nombre]
    mejor = None
    for entrada in candidatas[:MAX_CANDIDATAS]:
        ruta = os.path.join(home, entrada)
        try:
            st = os.lstat(ruta)
        except OSError:
            continue
        if not stat.S_ISDIR(st.st_mode):
            continue
        archivos = fuentes_de(ruta)
        reciente = max((a[2].st_mtime for a in archivos), default=st.st_mtime)
        if mejor is None or reciente > mejor[0]:
            mejor = (reciente, ruta, archivos)
    return (mejor[1], mejor[2]) if mejor else (None, [])


def sin_carpeta(taller):
    return {"started": False, "percent": 0, "compiles": None, "done": [], "partial": [],
            "missing": [p["id"] for p in taller["puntos"]], "files": 0, "lastChangeAt": None}


def evaluar(taller, home, previo, salida=None):
    """Un estudiante (ya con su usuario). Escribe HUELLA y luego IGUAL o RESULTADO <json>."""
    salida = salida or sys.stdout
    inicio = time.time()
    carpeta, archivos = carpeta_del_taller(home, taller["carpeta"])
    if carpeta is None:
        salida.write("HUELLA " + hashlib.sha256(b"sin-carpeta" + VERSION.encode()).hexdigest() + "\n")
        salida.write("RESULTADO " + json.dumps(sin_carpeta(taller)) + "\n")
        salida.flush()
        return 0
    marca = huella(archivos, taller)
    salida.write("HUELLA " + marca + "\n")
    salida.flush()  # si se acaba el tiempo, root ya sabe que huella guardar
    if previo and previo == marca:
        salida.write("IGUAL\n")
        salida.flush()
        return 0
    modelo = analizar([leer_sin_seguir(absoluta) for _rel, absoluta, _st in a_analizar(archivos)])
    restante = SEGUNDOS_POR_ESTUDIANTE - (time.time() - inicio) - 10
    compila = compilar(carpeta, archivos, min(SEGUNDOS_COMPILAR, restante))
    porcentaje, completos, medios, faltan = calificar(taller, modelo, compila)
    salida.write("RESULTADO " + json.dumps({
        "started": True,
        "percent": porcentaje,
        "compiles": compila,
        "done": completos,
        "partial": medios,
        "missing": faltan,
        "files": len(archivos),
        "outside": fuera_de_src(archivos),
        "lastChangeAt": iso(max((a[2].st_mtime for a in archivos), default=0)),
    }) + "\n")
    salida.flush()
    return 0


# =============================================================================================
# Parte de root: lista los homes, lanza un --evaluar por estudiante, valida y avisa.

def cargar_talleres(carpeta=None):
    carpeta = carpeta or TALLERES
    talleres = []
    try:
        nombres = sorted(os.listdir(carpeta))
    except OSError:
        return talleres
    for nombre in nombres:
        if not nombre.endswith(".json"):
            continue
        ruta = os.path.join(carpeta, nombre)
        try:
            with open(ruta, encoding="utf-8") as f:
                taller = json.load(f)
        except (OSError, ValueError) as error:
            print(f"AVISO: {nombre} no es un taller valido: {error}", file=sys.stderr)
            continue
        puntos = taller.get("puntos") or []
        if not TALLER_RE.match(str(taller.get("taller", ""))) or not puntos:
            print(f"AVISO: {nombre} no trae taller o puntos", file=sys.stderr)
            continue
        if not CARPETA_RE.match(str(taller.get("carpeta", ""))):
            print(f"AVISO: {nombre}: carpeta no valida", file=sys.stderr)
            continue
        ids = [str(p.get("id", "")) for p in puntos]
        # Las mismas reglas que el backend: un id que no las cumple haria rechazar todo el informe.
        if not all(PUNTO_RE.match(i) for i in ids) or len(set(ids)) != len(ids) or len(ids) > 100:
            print(f"AVISO: {nombre}: ids de puntos no validos o repetidos", file=sys.stderr)
            continue
        taller["_ruta"] = ruta
        talleres.append(taller)
    return talleres


def publico(taller):
    """El taller sin las claves internas (para la huella y para el --evaluar)."""
    return {k: v for k, v in taller.items() if not k.startswith("_")}


def validar(resultado, taller):
    """Lo que devolvio el --evaluar del estudiante, revisado (None si no sirve). Las tres listas se
    rearman en el orden del taller, sin repetidos ni cruces: cada punto queda en una sola (lo que
    no esta en completos ni a medias, falta). Asi nunca pasan del tope del backend."""
    if not isinstance(resultado, dict):
        return None
    orden = [p["id"] for p in taller["puntos"]]
    ids = set(orden)
    try:
        porcentaje = resultado["percent"]
        if not isinstance(porcentaje, int) or isinstance(porcentaje, bool) or not 0 <= porcentaje <= 100:
            return None
        crudas = {}
        for clave in ("done", "partial", "missing"):
            valor = resultado.get(clave, [])
            if not isinstance(valor, list) or len(valor) > 10 * len(orden) or not all(isinstance(v, str) and v in ids for v in valor):
                return None
            crudas[clave] = set(valor)
        listas = {
            "done": [i for i in orden if i in crudas["done"]],
            "partial": [i for i in orden if i in crudas["partial"] and i not in crudas["done"]],
        }
        listas["missing"] = [i for i in orden if i not in crudas["done"] and i not in crudas["partial"]]
        compila = resultado.get("compiles")
        if compila not in (True, False, None):
            return None
        archivos = resultado.get("files", 0)
        if not isinstance(archivos, int) or isinstance(archivos, bool) or not 0 <= archivos <= 100000:
            return None
        cambio = resultado.get("lastChangeAt")
        if cambio is not None and (not isinstance(cambio, str) or len(cambio) > 40):
            return None
        fuera = resultado.get("outside", 0)
        if not isinstance(fuera, int) or isinstance(fuera, bool) or not 0 <= fuera <= archivos:
            fuera = 0
        return {"started": bool(resultado.get("started")), "percent": porcentaje, "compiles": compila,
                **listas, "files": archivos, "outside": fuera, "lastChangeAt": cambio}
    except (KeyError, TypeError):
        return None


def comando_evaluar(taller, login, home, previo):
    base = [sys.executable, "-I", SCRIPT, "--evaluar", taller["_ruta"], home] + (["--previo", previo] if previo else [])
    if not COMO_ESTUDIANTE:
        return base
    return [RUNUSER, "-u", "ws-" + login, "--", "env", "-i", "PATH=" + PATH_SEGURO, "LANG=C.UTF-8", "HOME=" + home,
            "timeout", "-k", "5", str(SEGUNDOS_POR_ESTUDIANTE), "nice", "-n", "10"] + base


def leer_salida(texto):
    marca, igual, resultado = None, False, None
    for linea in (texto or "").splitlines():
        if linea.startswith("HUELLA ") and HUELLA_RE.match(linea[7:].strip()):
            marca = linea[7:].strip()
        elif linea.strip() == "IGUAL":
            igual = True
        elif linea.startswith("RESULTADO "):
            try:
                resultado = json.loads(linea[10:])
            except Exception:  # ValueError, RecursionError (un «[[[[...» armado a proposito)...
                resultado = None
    return marca, igual, resultado


def correr_hijo(comando, segundos):
    """(salida, se_acabo, excedida) del --evaluar: lee a lo sumo MAX_SALIDA bytes y espera a lo sumo
    `segundos`; lo que pase de ahi lo corta y mata el proceso."""
    proceso = subprocess.Popen(comando, cwd="/", stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    limite = time.time() + segundos
    datos = bytearray()
    se_acabo = excedida = False
    fd = proceso.stdout.fileno()
    try:
        while True:
            restante = limite - time.time()
            if restante <= 0:
                se_acabo = True
                break
            listos, _, _ = select.select([fd], [], [], min(restante, 1.0))
            if not listos:
                continue
            trozo = os.read(fd, 65536)
            if not trozo:
                break
            datos += trozo
            if len(datos) > MAX_SALIDA:
                excedida = True
                break
        if not se_acabo and not excedida:
            try:
                proceso.wait(timeout=max(1.0, limite - time.time()))
            except subprocess.TimeoutExpired:
                se_acabo = True
    finally:
        if proceso.poll() is None:
            proceso.kill()
            try:
                proceso.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        proceso.stdout.close()
    if proceso.returncode in (124, 137) and not excedida:
        se_acabo = True
    return bytes(datos[:MAX_SALIDA]).decode("utf-8", "replace"), se_acabo, excedida


def leer_guardado(taller, login):
    try:
        with open(os.path.join(ESTADO, f"{taller['taller']}--{login}.json"), encoding="utf-8") as f:
            previo = json.load(f)
        return previo if isinstance(previo, dict) else {}
    except (OSError, ValueError):
        return {}


def con_nota(resultado, nota, taller, empezo=False):
    """El ultimo resultado que se supo (o uno vacio) con la nota de por que no esta al dia."""
    base = dict(resultado) if isinstance(resultado, dict) and resultado else {**sin_carpeta(taller), "started": empezo}
    base["note"] = nota
    return base


def evaluar_estudiante(taller, login, home, plazo=None):
    """Resultado de un estudiante: lo que devuelve su --evaluar, o el guardado si nada cambio.

    Lo reusado por plazo o error lleva su nota (pendiente, error) para que el docente no lo tome por
    actual. Cada vez se guarda cuando se evaluo (evaluadoEn): la corrida empieza por quien lleva mas
    tiempo sin evaluarse, asi un estudiante lento no deja siempre sin calcular a los que siguen."""
    guardado = os.path.join(ESTADO, f"{taller['taller']}--{login}.json")
    previo = leer_guardado(taller, login)
    previo_huella = previo.get("huella") if isinstance(previo.get("huella"), str) and HUELLA_RE.match(previo.get("huella")) else None
    previo_resultado = previo.get("resultado") if isinstance(previo.get("resultado"), dict) else None
    if plazo is not None and time.time() >= plazo:
        return {"login": login, **con_nota(previo_resultado, "pendiente", taller)}
    # Un «error» se reintenta siempre; un «tiempo» viejo, aunque nada haya cambiado (pudo ser carga).
    if previo_resultado and previo_resultado.get("note") == "error":
        previo_huella = None
    if previo_resultado and previo_resultado.get("note") == "tiempo" and time.time() - float(previo.get("evaluadoEn", 0) or 0) > REINTENTAR_TIEMPO_S:
        previo_huella = None
    salida, se_acabo, excedida = "", False, False
    try:
        salida, se_acabo, excedida = correr_hijo(comando_evaluar(taller, login, home, previo_huella), SEGUNDOS_POR_ESTUDIANTE + 15)
    except OSError as error:
        print(f"AVISO: {login}: {error}", file=sys.stderr)
    marca, igual, resultado = leer_salida(salida)
    if igual and previo_resultado and previo_huella and marca == previo_huella:
        valido = previo_resultado
    elif excedida:
        valido = con_nota(previo_resultado, "error", taller, empezo=True)
    else:
        valido = validar(resultado, taller) if resultado is not None else None
        if valido is None and se_acabo:
            valido = con_nota(previo_resultado, "tiempo", taller, empezo=True)
        elif valido is None:
            valido = con_nota(previo_resultado, "error", taller)
    try:
        with open(guardado, "w", encoding="utf-8") as f:
            # Sin huella (se acabo el tiempo antes de saberla) no hay IGUAL la proxima vez, pero
            # evaluadoEn lo deja al final de la fila.
            json.dump({"huella": marca if marca else None, "resultado": valido, "evaluadoEn": time.time()}, f)
    except OSError:
        pass
    return {"login": login, **valido}


def avisar_backend(informe, espera=30):
    api = leer_env(WS_ENV).get("ADACEEN_API_URL", "").rstrip("/")
    token = leer_env(AGENTE).get("AGENT_TOKEN", "")
    if not api or not token:
        return "sin ADACEEN_API_URL o sin token del agente: no se avisa al backend"
    pedido = urllib.request.Request(api + "/api/workspaces/progress-report", data=json.dumps(informe).encode(), method="POST", headers={
        "Content-Type": "application/json",
        "x-agent-token": token,
    })
    try:
        with urllib.request.urlopen(pedido, timeout=espera):
            return ""
    except Exception as error:
        return f"no se pudo avisar al backend: {error}"


def homes_de_estudiantes():
    try:
        entradas = sorted(os.listdir(HOMES))
    except OSError:
        return []
    homes = []
    for entrada in entradas:
        home = os.path.join(HOMES, entrada)
        login = entrada[3:]
        if not entrada.startswith("ws-") or not LOGIN_RE.match(login) or os.path.islink(home) or not os.path.isdir(home):
            continue
        if COMO_ESTUDIANTE:
            try:
                pwd.getpwnam(entrada)
            except KeyError:
                continue
        homes.append((login, home))
    return homes


def correr(modo="avisar", talleres_dir=None):
    os.makedirs(ESTADO, mode=0o700, exist_ok=True)
    os.chmod(ESTADO, 0o700)
    talleres = cargar_talleres(talleres_dir)
    if not talleres:
        print("sin talleres en " + (talleres_dir or TALLERES), file=sys.stderr)
        return 0
    plazo = time.time() + SEGUNDOS_CORRIDA
    homes = homes_de_estudiantes()
    fallos = 0
    informes = []
    for taller in talleres:
        estudiantes = []
        # Primero quien lleva mas tiempo sin evaluarse (o nunca); el informe sale en orden de login.
        fila = sorted(homes, key=lambda par: (float(leer_guardado(taller, par[0]).get("evaluadoEn", 0) or 0), par[0]))
        for login, home in fila:
            try:
                estudiantes.append(evaluar_estudiante(taller, login, home, plazo))
            except Exception as error:  # un estudiante raro no tumba a los demas
                print(f"AVISO: {login}: {error}", file=sys.stderr)
        estudiantes.sort(key=lambda e: e["login"])
        informe = {
            "taller": taller["taller"],
            "titulo": str(taller.get("titulo", taller["taller"]))[:120],
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "points": [{"id": p["id"], "hu": str(p.get("hu", ""))[:40], "texto": str(p.get("texto", p["id"]))[:160],
                        "peso": float(p.get("peso", 0))} for p in taller["puntos"]],
            "students": estudiantes[:2000],
        }
        informes.append(informe)
        if modo == "json":
            continue
        empezaron = [e for e in estudiantes if e["started"]]
        promedio = round(sum(e["percent"] for e in empezaron) / len(empezaron)) if empezaron else 0
        aviso = avisar_backend(informe) if modo == "avisar" else "sin avisar (--sin-avisar)"
        if aviso and modo == "avisar":
            fallos += 1
        print(f"avance {taller['taller']}: {len(estudiantes)} estudiantes, {len(empezaron)} con la carpeta, promedio {promedio} %"
              + (f"; {aviso}" if aviso else ""))
        if modo == "resumen":
            for e in estudiantes:
                print(f"  {e['login']}: {e['percent']} %" + ("" if e["started"] else " (sin carpeta)")
                      + ("" if e["compiles"] is None else (", compila" if e["compiles"] else ", no compila"))
                      + (f" [{e['note']}]" if e.get("note") else ""))
    if modo == "json":
        print(json.dumps({"version": VERSION, "informes": informes}, ensure_ascii=False))
    return 0 if fallos == 0 else 1


def main(argv):
    if argv and argv[0] == "--evaluar":
        # Como el estudiante. Nunca como root: root lanza esto con runuser y env -i (las pruebas,
        # que corren como root en un contenedor, lo permiten con ADACEEN_AVANCE_PRUEBA=1).
        if os.geteuid() == 0 and os.environ.get("ADACEEN_AVANCE_PRUEBA") != "1":
            print("--evaluar no corre como root", file=sys.stderr)
            return 2
        if len(argv) < 3:
            print("uso: avance-ws.py --evaluar <taller.json> <home> [--previo <huella>]")
            return 2
        with open(argv[1], encoding="utf-8") as f:
            taller = publico(json.load(f))
        previo = argv[4] if len(argv) >= 5 and argv[3] == "--previo" and HUELLA_RE.match(argv[4]) else None
        return evaluar(taller, argv[2], previo)
    if os.geteuid() != 0:
        print("el avance corre como root (timer adaceen-ws-avance)")
        return 2
    os.umask(0o077)
    talleres_dir = None
    if "--talleres" in argv:
        i = argv.index("--talleres")
        talleres_dir = argv[i + 1] if i + 1 < len(argv) else None
    modo = "json" if "--json" in argv else "resumen" if "--sin-avisar" in argv else "avisar"
    return correr(modo, talleres_dir)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
