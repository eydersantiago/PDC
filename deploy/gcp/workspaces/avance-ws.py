#!/usr/bin/env python3
"""Avance de cada estudiante en un taller, en la VM de editores (29-10-2026).

La corre como root el timer adaceen-ws-avance cada 10 min (lo instala startup-ws.sh). Por cada
taller de /opt/adaceen/talleres/*.json (por ahora el Sistema bancario) y cada estudiante
(/home/ws-<login>), mira la carpeta del taller en su home y calcula un porcentaje con los puntos
del archivo: clases, atributos, metodos con cuerpo, herencia, lo que hace main y si compila.

  avance-ws.py               evalua y avisa al backend (POST /api/workspaces/progress-report)
  avance-ws.py --sin-avisar  evalua e imprime el resumen, sin avisar (para probar en la VM)

Es una estimacion para el docente, no la nota: lee el codigo con reglas sencillas (sin
comentarios ni textos) y no ejecuta el programa del estudiante. Compila como `make` (g++ con
salida a /dev/null), COMO el estudiante (runuser) y con tiempo limite, para que su codigo no lea
nada que el no pueda leer. No sigue enlaces simbolicos. Si nada cambio en sus archivos desde la
ultima vez, reusa el resultado guardado y no compila otra vez.

Al backend solo van el login, el porcentaje, que puntos faltan, si compila, cuantos archivos y
la fecha del ultimo cambio. Nunca el codigo.
"""
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone

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
# Compilar: como el estudiante y con tiempo limite (las mismas banderas que el Makefile del taller).
COMO_ESTUDIANTE = True
COMPILADOR = ["g++", "-std=c++17", "-w"]
SEGUNDOS_POR_ESTUDIANTE = 90
LOGIN_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,38}$")


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


# ---------------------------------------------------------------------------------------------
# Archivos del estudiante (sin seguir enlaces)

def fuentes_de(carpeta):
    """(ruta relativa, ruta absoluta, stat) de los .h/.cpp de la carpeta del taller."""
    salida = []
    total = 0
    for dirpath, dirnames, filenames in os.walk(carpeta, followlinks=False):
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
    h = hashlib.sha256(json.dumps(taller, sort_keys=True).encode())
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


# ---------------------------------------------------------------------------------------------
# Lectura del C++ (reglas sencillas, sin compilador)

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


def cierre(texto, abre):
    """Indice de la llave que cierra la de `abre` (o len(texto) si no cierra)."""
    nivel = 0
    for i in range(abre, len(texto)):
        if texto[i] == "{":
            nivel += 1
        elif texto[i] == "}":
            nivel -= 1
            if nivel == 0:
                return i
    return len(texto)


def cierre_parentesis(texto, abre):
    nivel = 0
    for i in range(abre, len(texto)):
        if texto[i] == "(":
            nivel += 1
        elif texto[i] == ")":
            nivel -= 1
            if nivel == 0:
                return i
    return len(texto)


IDENT = re.compile(r"[A-Za-z_]\w*")
NO_SON_NOMBRES = {"if", "for", "while", "switch", "return", "sizeof", "catch", "decltype", "alignof", "static_assert", "operator"}
ACCESO = re.compile(r"\b(public|private|protected)\s*:")
CLASE_RE = re.compile(r"\b(class|struct)\s+([A-Za-z_]\w*)\s*(?:final\s*)?(:[^{};()]*)?\{")


def tiene_cuerpo(cuerpo):
    return bool(cuerpo.strip())


def miembros_de(cuerpo, nombre_clase):
    """Atributos y metodos declarados en el cuerpo de una clase (solo el primer nivel)."""
    atributos = set()
    metodos = {}  # nombre en minusculas -> {"virtual": bool, "override": bool, "cuerpo": True|False|None}
    i = 0
    n = len(cuerpo)
    inicio = 0

    def registrar(cabecera, bloque):
        cabecera = ACCESO.sub(" ", cabecera).strip()
        if not cabecera:
            return
        palabras = IDENT.findall(cabecera)
        if not palabras or palabras[0] in ("using", "typedef", "friend", "static_assert", "enum", "class", "struct", "union"):
            return
        if "(" in cabecera:
            antes = cabecera[:cabecera.index("(")]
            nombres = IDENT.findall(antes)
            if not nombres:
                return
            nombre = nombres[-1]
            if antes.rstrip().endswith("~" + nombre) or nombre in NO_SON_NOMBRES:
                return
            despues = cabecera[cierre_parentesis(cabecera, cabecera.index("(")) + 1:]
            info = metodos.setdefault(nombre.lower(), {"virtual": False, "override": False, "cuerpo": None})
            info["virtual"] = info["virtual"] or "virtual" in nombres
            info["override"] = info["override"] or bool(re.search(r"\boverride\b", despues))
            if bloque is not None:
                inicializa = nombre == nombre_clase and re.search(r"\)\s*:", cabecera)
                info["cuerpo"] = bool(tiene_cuerpo(bloque) or inicializa) or info["cuerpo"] is True
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
                nivel -= 1
            if ch == "," and nivel == 0:
                partes.append(actual)
                actual = ""
            else:
                actual += ch
        partes.append(actual)
        for parte in partes:
            parte = re.split(r"[=\[{]", parte)[0]
            nombres = IDENT.findall(parte)
            if nombres and nombres[-1] not in ("const", "static", "mutable"):
                atributos.add(nombres[-1].lower())

    while i < n:
        c = cuerpo[i]
        if c == "(":
            i = cierre_parentesis(cuerpo, i) + 1
            continue
        if c == "{":
            fin = cierre(cuerpo, i)
            cabecera = cuerpo[inicio:i]
            if "(" in cabecera:
                registrar(cabecera, cuerpo[i + 1:fin])
                inicio = fin + 1
            elif re.search(r"\b(class|struct|enum|union)\b", cabecera):
                inicio = fin + 1
            else:
                registrar(cabecera, None)  # atributo con llaves: long saldo{0};
                inicio = fin + 1
            i = fin + 1
            if i < n and cuerpo[i] == ";":
                inicio = i + 1
                i += 1
            continue
        if c == ";":
            registrar(cuerpo[inicio:i], None)
            inicio = i + 1
        i += 1
    return atributos, metodos


def definiciones_fuera(texto):
    """{(clase, metodo) en minusculas: tiene cuerpo} de las definiciones Clase::metodo(...) {...}."""
    salida = {}
    for m in re.finditer(r"\b([A-Za-z_]\w*)\s*::\s*(~?[A-Za-z_]\w*)\s*\(", texto):
        clase, metodo = m.group(1), m.group(2)
        if metodo.startswith("~"):
            continue
        cierra = cierre_parentesis(texto, m.end() - 1)
        resto = texto[cierra + 1:cierra + 400]
        d = re.match(r"\s*((?:const|override|noexcept|final|volatile|&|\s)*)(:[^;{}]*)?\{", resto)
        if not d:
            continue
        abre = cierra + 1 + d.end() - 1
        cuerpo = texto[abre + 1:cierre(texto, abre)]
        inicializa = bool(d.group(2)) and metodo == clase
        clave = (clase.lower(), metodo.lower())
        salida[clave] = salida.get(clave, False) or tiene_cuerpo(cuerpo) or inicializa
    return salida


def cuerpo_main(texto):
    m = re.search(r"\bint\s+main\s*\(", texto)
    if not m:
        return None
    cierra = cierre_parentesis(texto, m.end() - 1)
    abre = texto.find("{", cierra)
    if abre < 0:
        return None
    return texto[abre + 1:cierre(texto, abre)]


def analizar(fuentes):
    """Modelo del codigo: clases (bases, atributos, metodos), definiciones fuera y main."""
    clases = {}
    definiciones = {}
    main = None
    for texto in fuentes:
        limpio = limpiar(texto)
        for m in CLASE_RE.finditer(limpio):
            nombre = m.group(2)
            abre = m.end() - 1
            cuerpo = limpio[abre + 1:cierre(limpio, abre)]
            bases = set()
            for parte in (m.group(3) or "")[1:].split(","):
                palabras = [p for p in IDENT.findall(parte) if p not in ("public", "private", "protected", "virtual")]
                if palabras:
                    bases.add(palabras[-1].lower())
            atributos, metodos = miembros_de(cuerpo, nombre)
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
        for clave, con_cuerpo in definiciones_fuera(limpio).items():
            definiciones[clave] = definiciones.get(clave, False) or con_cuerpo
        if main is None:
            main = cuerpo_main(limpio)
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


# ---------------------------------------------------------------------------------------------
# Compilar (solo sintaxis, como el estudiante)

def a_compilar(archivos):
    """Los .cpp que compila el Makefile del taller (src/*.cpp y src/modelo/*.cpp); sin src/, todos."""
    cpps = [rel for rel, _abs, _st in archivos if rel.lower().endswith((".cpp", ".cc", ".cxx"))]
    del_make = [rel for rel in cpps if os.path.dirname(rel) in ("src", os.path.join("src", "modelo"))]
    return del_make or cpps


def compilar(carpeta, archivos, usuario):
    """True si compila y enlaza como `make` (g++ ... -o /dev/null), False si no, None si no se pudo saber.

    Corre como el estudiante (runuser) con tiempo limite: su codigo solo ve lo que el ve. No se
    ejecuta nada de lo que compila (la salida va a /dev/null).
    """
    cpps = a_compilar(archivos)
    if not cpps:
        return None
    incluir = []
    for sub in ("src", os.path.join("src", "modelo"), "include"):
        if os.path.isdir(os.path.join(carpeta, sub)):
            incluir.append("-I" + sub)
    comando = COMPILADOR + incluir + cpps + ["-o", os.devnull]
    if COMO_ESTUDIANTE:
        comando = ["runuser", "-u", usuario, "--", "timeout", "-k", "5", str(SEGUNDOS_POR_ESTUDIANTE), "nice", "-n", "10"] + comando
    try:
        resultado = subprocess.run(comando, cwd=carpeta, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, timeout=SEGUNDOS_POR_ESTUDIANTE + 15,
                                   env={"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"})
    except (OSError, subprocess.TimeoutExpired):
        return None
    if resultado.returncode in (124, 137):  # se acabo el tiempo
        return None
    return resultado.returncode == 0


# ---------------------------------------------------------------------------------------------

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
        try:
            with open(os.path.join(carpeta, nombre), encoding="utf-8") as f:
                taller = json.load(f)
        except (OSError, ValueError) as error:
            print(f"AVISO: {nombre} no es un taller valido: {error}")
            continue
        if not re.match(r"^[a-z0-9][a-z0-9._-]{0,79}$", str(taller.get("taller", ""))) or not taller.get("puntos"):
            print(f"AVISO: {nombre} no trae taller o puntos")
            continue
        if not re.match(r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$", str(taller.get("carpeta", ""))):
            print(f"AVISO: {nombre}: carpeta no valida")
            continue
        talleres.append(taller)
    return talleres


def iso(segundos):
    return datetime.fromtimestamp(segundos, timezone.utc).isoformat() if segundos else None


def evaluar_estudiante(taller, login, home):
    carpeta = os.path.join(home, taller["carpeta"])
    try:
        st = os.lstat(carpeta)
    except OSError:
        return {"login": login, "started": False, "percent": 0, "compiles": None, "done": [], "partial": [],
                "missing": [p["id"] for p in taller["puntos"]], "files": 0, "lastChangeAt": None}
    if not stat.S_ISDIR(st.st_mode):
        return {"login": login, "started": False, "percent": 0, "compiles": None, "done": [], "partial": [],
                "missing": [p["id"] for p in taller["puntos"]], "files": 0, "lastChangeAt": None}
    archivos = fuentes_de(carpeta)
    marca = huella(archivos, taller)
    guardado = os.path.join(ESTADO, f"{taller['taller']}--{login}.json")
    try:
        with open(guardado, encoding="utf-8") as f:
            previo = json.load(f)
        if previo.get("huella") == marca:
            return previo["resultado"]
    except (OSError, ValueError, KeyError):
        pass
    modelo = analizar([leer_sin_seguir(absoluta) for _rel, absoluta, _st in archivos])
    compila = compilar(carpeta, archivos, "ws-" + login)
    porcentaje, completos, medios, faltan = calificar(taller, modelo, compila)
    resultado = {
        "login": login,
        "started": True,
        "percent": porcentaje,
        "compiles": compila,
        "done": completos,
        "partial": medios,
        "missing": faltan,
        "files": len(archivos),
        "lastChangeAt": iso(max((a[2].st_mtime for a in archivos), default=0)),
    }
    if compila is not None:  # sin veredicto de compilacion se vuelve a intentar la proxima vez
        with open(guardado, "w", encoding="utf-8") as f:
            json.dump({"huella": marca, "resultado": resultado}, f)
    return resultado


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


def correr(avisar=True):
    os.makedirs(ESTADO, mode=0o700, exist_ok=True)
    os.chmod(ESTADO, 0o700)
    talleres = cargar_talleres()
    if not talleres:
        print("sin talleres en " + TALLERES)
        return 0
    try:
        entradas = sorted(os.listdir(HOMES))
    except OSError:
        entradas = []
    homes = []
    for entrada in entradas:
        home = os.path.join(HOMES, entrada)
        if entrada.startswith("ws-") and LOGIN_RE.match(entrada[3:]) and not os.path.islink(home) and os.path.isdir(home):
            homes.append((entrada[3:], home))
    fallos = 0
    for taller in talleres:
        estudiantes = []
        for login, home in homes:
            try:
                estudiantes.append(evaluar_estudiante(taller, login, home))
            except Exception as error:  # un estudiante raro no tumba a los demas
                print(f"AVISO: {login}: {error}")
        informe = {
            "taller": taller["taller"],
            "titulo": str(taller.get("titulo", taller["taller"]))[:120],
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "points": [{"id": p["id"], "hu": str(p.get("hu", ""))[:40], "texto": str(p.get("texto", p["id"]))[:160],
                        "peso": float(p.get("peso", 0))} for p in taller["puntos"]],
            "students": estudiantes[:2000],
        }
        empezaron = [e for e in estudiantes if e["started"]]
        promedio = round(sum(e["percent"] for e in empezaron) / len(empezaron)) if empezaron else 0
        aviso = avisar_backend(informe) if avisar else "sin avisar (--sin-avisar)"
        if aviso and avisar:
            fallos += 1
        print(f"avance {taller['taller']}: {len(estudiantes)} estudiantes, {len(empezaron)} con la carpeta, promedio {promedio} %"
              + (f"; {aviso}" if aviso else ""))
        if not avisar:
            for e in estudiantes:
                print(f"  {e['login']}: {e['percent']} %" + ("" if e["started"] else " (sin carpeta)")
                      + ("" if e["compiles"] is None else (", compila" if e["compiles"] else ", no compila")))
    return 0 if fallos == 0 else 1


def main(argv):
    if os.geteuid() != 0:
        print("el avance corre como root (timer adaceen-ws-avance)")
        return 2
    os.umask(0o077)
    return correr(avisar="--sin-avisar" not in argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
