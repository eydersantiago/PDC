// Pruebas de avance-ws.py (avance de los talleres en la VM de editores, 29-10-2026), sin la VM:
// /home, /etc y /var/lib se cambian a una carpeta temporal, el backend es un servidor HTTP local
// y se compila con el g++ de la maquina (sin g++, la prueba de compilar se omite).
//   node --test deploy/gcp/workspaces/agente/avance-ws.test.mjs
//
// El proyecto «completo» se arma aqui con metodos de una linea a partir de los puntos del taller:
// el repositorio es publico y no debe llevar una solucion del Sistema bancario.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(AQUI, "..", "avance-ws.py");
const TALLERES = path.resolve(AQUI, "..", "talleres");
const BANCO = JSON.parse(readFileSync(path.join(TALLERES, "sistema-bancario-fpoo.json"), "utf8"));

function pythonReal() {
  for (const comando of ["python", "python3"]) {
    try {
      const version = execFileSync(comando, ["-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8" }).trim();
      if (version === "3") return comando;
    } catch {
      // siguiente
    }
  }
  return "";
}
function hay(comando) {
  try {
    execFileSync(comando, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const PYTHON = pythonReal();
// avance-ws.py es de la VM (Linux): runuser, os.geteuid, select sobre tuberias y resource. Desde el
// 02-11-2026 corre en npm test; en Windows se omite.
const omitir = process.platform === "win32" ? "avance-ws.py corre en Linux (la VM de editores)" : PYTHON ? false : "falta python3";
const GPP = hay("g++");

/** Corre codigo de Python con el modulo cargado como `a` y las rutas de la VM cambiadas. */
function correr(codigo, rutas) {
  const preambulo = `
import importlib.util, json, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("avance", ${JSON.stringify(SCRIPT)})
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
a.COMO_ESTUDIANTE = False
import os
os.environ["ADACEEN_AVANCE_PRUEBA"] = "1"  # el --evaluar hijo corre como root en el contenedor
for clave, valor in json.loads(${JSON.stringify(JSON.stringify(rutas))}).items():
    setattr(a, clave, valor)
import os
os.makedirs(a.ESTADO, exist_ok=True)
`;
  return new Promise((resolve) => {
    execFile(PYTHON, ["-c", `${preambulo}\n${codigo}`], { encoding: "utf8", timeout: 120000 }, (error, stdout, stderr) => {
      resolve({ codigo: error ? error.code : 0, stdout, stderr });
    });
  });
}

function escribir(ruta, contenido) {
  mkdirSync(path.dirname(ruta), { recursive: true });
  writeFileSync(ruta, contenido);
}

function entorno() {
  const dir = mkdtempSync(path.join(tmpdir(), "adaceen-avance-"));
  const rutas = {
    TALLERES,
    HOMES: path.join(dir, "home"),
    ESTADO: path.join(dir, "estado"),
    WS_ENV: path.join(dir, "adaceen-ws.env"),
    AGENTE: path.join(dir, "agente.env"),
    PARA_ENTREGAS: path.join(dir, "estado", "para-entregas.json"),
  };
  mkdirSync(rutas.HOMES);
  return { dir, rutas, carpeta: (login) => path.join(rutas.HOMES, `ws-${login}`, BANCO.carpeta) };
}

/** Proyecto con todos los puntos del taller: metodos de una linea, sin logica del ejercicio. */
function proyectoDeStubs(raiz) {
  const clases = new Map();
  const clase = (nombre) => {
    if (!clases.has(nombre)) clases.set(nombre, { base: "", atributos: new Set(), metodos: new Set(), virtuales: new Set() });
    return clases.get(nombre);
  };
  for (const punto of BANCO.puntos) {
    const primero = (nombre) => nombre.split("|")[0];
    if (punto.tipo === "clase") clase(punto.clase);
    if (punto.tipo === "atributos") punto.nombres.forEach((n) => clase(punto.clase).atributos.add(primero(n)));
    if (punto.tipo === "metodos") punto.nombres.forEach((n) => clase(punto.clase).metodos.add(primero(n)));
    if (punto.tipo === "hereda") clase(punto.clase).base = punto.base;
    if (punto.tipo === "virtual") clase(punto.clase).virtuales.add(punto.metodo);
  }
  const orden = [...clases.keys()].sort((x, y) => (clases.get(x).base ? 1 : 0) - (clases.get(y).base ? 1 : 0));
  for (const nombre of orden) {
    const c = clases.get(nombre);
    const lineas = ["#pragma once", c.base ? `#include "${c.base}.h"` : "", `class ${nombre}${c.base ? ` : public ${c.base}` : ""} {`, "public:"];
    for (const a of c.atributos) lineas.push(`    int ${a} = 0;`);
    for (const m of c.metodos) {
      if (m === nombre) lineas.push(`    ${nombre}() {}`, `    ${nombre}(int x) { (void)x; }`);
      else lineas.push(`    ${c.virtuales.has(m) ? "virtual " : ""}int ${m}() { return 0; }`);
    }
    lineas.push("};", "");
    escribir(path.join(raiz, "src", "modelo", `${nombre}.h`), lineas.join("\n"));
    escribir(path.join(raiz, "src", "modelo", `${nombre}.cpp`), `#include "${nombre}.h"\n`);
  }
  const main = BANCO.puntos.filter((p) => p.tipo === "main").flatMap((p) => p.nombres.map((n) => n.split("|")[0]));
  escribir(path.join(raiz, "src", "main.cpp"), [
    ...orden.map((n) => `#include "${n}.h"`),
    "int main() {",
    ...orden.map((n) => `    ${n} v${n};`),
    // Cada nombre que main debe usar, como uso real (no en un comentario).
    ...main.filter((n) => !clases.has(n)).map((n) => `    int u${n} = vCuenta.${n}();`),
    ...main.filter((n) => !clases.has(n)).map((n) => `    (void)u${n};`),
    "    return 0;",
    "}",
    "",
  ].join("\n"));
}

test("avance-ws.py: los puntos del taller suman 100 y cada punto tiene id unico, HU y tipo conocido", { skip: omitir }, () => {
  const ids = BANCO.puntos.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(BANCO.puntos.reduce((s, p) => s + p.peso, 0), 100);
  for (const p of BANCO.puntos) {
    assert.match(p.id, /^[a-z0-9][a-z0-9-]{0,59}$/);
    assert.ok(p.hu && p.texto, p.id);
    assert.ok(["clase", "atributos", "metodos", "hereda", "virtual", "main", "compila"].includes(p.tipo), p.id);
  }
});

test("avance-ws.py: avance parcial; comentarios y textos no cuentan; declarado sin cuerpo cuenta la mitad", { skip: omitir }, async () => {
  const e = entorno();
  const raiz = e.carpeta("ana");
  escribir(path.join(raiz, "src", "modelo", "Cliente.h"), `#pragma once
#include <string>
// class Banco { void imprimirDatos() { } };   comentado: no cuenta
/* class Titularidad { }; */
class Cliente {
    std::string identificacion, nombre;
    std::string telefono{"0"};
public:
    Cliente(std::string i, std::string n, std::string t);
    std::string getIdentificacion() const { return identificacion; }
    std::string getNombre() const;
    std::string getTelefono() const { return telefono; }
    void setIdentificacion(std::string c) { identificacion = c; }
    void setNombre(std::string n) {}
    void setTelefono(std::string t);
};
`);
  escribir(path.join(raiz, "src", "modelo", "Cliente.cpp"), `#include "Cliente.h"
Cliente::Cliente(std::string i, std::string n, std::string t) : identificacion(i), nombre(n), telefono(t) {}
std::string Cliente::getNombre() const { return nombre; }
`);
  escribir(path.join(raiz, "src", "modelo", "Cuenta.h"), `#pragma once
#include <string>
class Cuenta {
    std::string id;
    long saldo = 0;
public:
    Cuenta(std::string id, long saldo);
    virtual bool retirarDinero(long cantidad);
};
class CuentaCorriente : public Cuenta {
    long limiteSobregiro;
public:
    using Cuenta::Cuenta;
    bool retirarDinero(long cantidad) override;
};
`);
  escribir(path.join(raiz, "src", "main.cpp"), `#include <iostream>
#include "Cliente.h"
int main() {
    Cliente c("1", "Ana", "300");
    std::cout << "Banco Titularidad getSaldo" << c.getNombre() << std::endl;
    return 0;
}
`);
  const r = await correr(`
taller = a.cargar_talleres()[0]
print(json.dumps(a.evaluar_estudiante(taller, "ana", ${JSON.stringify(path.join(e.rutas.HOMES, "ws-ana"))})))
`, e.rutas);
  assert.equal(r.codigo, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(res.started, true);
  assert.equal(res.files, 4);
  for (const id of ["cliente-clase", "cliente-atributos", "cliente-constructor", "cliente-get", "cuenta-clase", "cuenta-atributos", "corriente-herencia", "retiro-virtual"]) {
    assert.ok(res.done.includes(id), `${id} completo`);
  }
  // setNombre vacio y setTelefono sin definir: a medias. retirarDinero declarado sin cuerpo: a medias.
  for (const id of ["cliente-set", "retirar", "corriente-retiro"]) assert.ok(res.partial.includes(id), `${id} a medias`);
  // Lo comentado y lo que esta entre comillas no cuenta.
  for (const id of ["banco-clase", "banco-imprimir", "titularidad-clase", "main-operaciones"]) assert.ok(res.missing.includes(id), `${id} falta`);
  assert.ok(res.percent > 25 && res.percent < 55, `parcial: ${res.percent}`);
  if (GPP) assert.equal(typeof res.compiles, "boolean");
});

test("avance-ws.py: un proyecto con todos los puntos llega al 100 % (con g++) y los enlaces simbolicos no dan puntos", { skip: omitir }, async () => {
  const e = entorno();
  proyectoDeStubs(e.carpeta("completo"));
  // beto enlaza la carpeta de otro y un archivo suelto: no se siguen.
  mkdirSync(path.join(e.carpeta("beto"), "src"), { recursive: true });
  symlinkSync(path.join(e.carpeta("completo"), "src", "modelo"), path.join(e.carpeta("beto"), "src", "modelo"));
  symlinkSync(path.join(e.carpeta("completo"), "src", "main.cpp"), path.join(e.carpeta("beto"), "src", "main.cpp"));
  // carla tiene editor pero no la carpeta del taller.
  mkdirSync(path.join(e.rutas.HOMES, "ws-carla", "otro-repo"), { recursive: true });
  const r = await correr(`
taller = a.cargar_talleres()[0]
salida = {}
for login in ("completo", "beto", "carla"):
    salida[login] = a.evaluar_estudiante(taller, login, os.path.join(a.HOMES, "ws-" + login))
print(json.dumps(salida))
`, e.rutas);
  assert.equal(r.codigo, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.deepEqual(res.completo.missing, GPP ? [] : ["compila"], JSON.stringify(res.completo));
  assert.deepEqual(res.completo.partial, []);
  assert.equal(res.completo.percent, GPP ? 100 : 94);
  if (GPP) assert.equal(res.completo.compiles, true);
  assert.equal(res.beto.started, true);
  assert.equal(res.beto.files, 0);
  assert.equal(res.beto.percent, 0);
  assert.equal(res.carla.started, false);
  assert.equal(res.carla.compiles, null);
});

test("avance-ws.py: reusa el resultado si nada cambio y vuelve a calcular cuando cambia un archivo", { skip: omitir || (!GPP && "falta g++") }, async () => {
  const e = entorno();
  const raiz = e.carpeta("ana");
  proyectoDeStubs(raiz);
  const evaluar = `
taller = a.cargar_talleres()[0]
r = a.evaluar_estudiante(taller, "ana", os.path.join(a.HOMES, "ws-ana"))
print(json.dumps(r))
`;
  const primera = JSON.parse((await correr(evaluar, e.rutas)).stdout);
  assert.equal(primera.compiles, true);
  // Se cambia el resultado guardado: si nada cambio en la carpeta, sale el guardado (no se recalcula).
  const guardado = path.join(e.rutas.ESTADO, "sistema-bancario-fpoo--ana.json");
  const datos = JSON.parse(readFileSync(guardado, "utf8"));
  writeFileSync(guardado, JSON.stringify({ ...datos, resultado: { ...datos.resultado, percent: 7 } }));
  const igual = JSON.parse((await correr(evaluar, e.rutas)).stdout);
  assert.equal(igual.percent, 7);
  // Si un archivo cambia, se vuelve a calcular.
  escribir(path.join(raiz, "src", "modelo", "Extra.cpp"), "int x = ;\n");
  const nueva = JSON.parse((await correr(evaluar, e.rutas)).stdout);
  assert.equal(nueva.compiles, false);
  assert.ok(nueva.missing.includes("compila"));
  assert.ok(nueva.percent > 7);
});

test("avance-ws.py: root lanza a cada estudiante con su usuario, sin entorno, con python aislado y tiempo limite", { skip: omitir }, async () => {
  const e = entorno();
  const r = await correr(`
a.COMO_ESTUDIANTE = True
taller = {"taller": "t", "_ruta": "/opt/adaceen/talleres/t.json", "puntos": []}
print(json.dumps(a.comando_evaluar(taller, "ana", "/home/ws-ana", None)))
`, e.rutas);
  assert.equal(r.codigo, 0, r.stderr);
  const comando = JSON.parse(r.stdout);
  assert.match(comando[0], /(^|\/)runuser$/);
  assert.deepEqual(comando.slice(1, 5), ["-u", "ws-ana", "--", "env"]);
  assert.ok(comando.includes("-i") && comando.indexOf("-i") === 5, "env -i: nada del entorno de root");
  assert.ok(comando.includes("timeout") && comando.includes("nice"));
  const py = comando.indexOf("--evaluar");
  assert.equal(comando[py - 1].endsWith("avance-ws.py"), true);
  assert.equal(comando[py - 2], "-I", "python -I: sin site del usuario ni variables PYTHON*");
  assert.deepEqual(comando.slice(py), ["--evaluar", "/opt/adaceen/talleres/t.json", "/home/ws-ana"]);
});

test("avance-ws.py: si se acaba el tiempo de un estudiante, sigue con los demas y no lo repite hasta que cambie algo", { skip: omitir }, async () => {
  const e = entorno();
  mkdirSync(e.carpeta("lento"), { recursive: true });
  const lento = path.join(e.dir, "lento.py");
  writeFileSync(lento, `import sys, time\nsys.stdout.write("HUELLA " + "a" * 64 + "\\n")\nsys.stdout.flush()\nif "--previo" in sys.argv:\n    sys.stdout.write("IGUAL\\n")\n    sys.exit(0)\ntime.sleep(30)\n`);
  const r = await correr(`
a.SCRIPT = ${JSON.stringify(lento)}
a.SEGUNDOS_POR_ESTUDIANTE = -13  # 2 s de plazo desde root
taller = a.cargar_talleres()[0]
import time
t = time.time()
primera = a.evaluar_estudiante(taller, "lento", os.path.join(a.HOMES, "ws-lento"))
segunda = a.evaluar_estudiante(taller, "lento", os.path.join(a.HOMES, "ws-lento"))
print(json.dumps({"primera": primera, "segunda": segunda, "segundos": time.time() - t}))
`, e.rutas);
  assert.equal(r.codigo, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(res.primera.note, "tiempo");
  assert.equal(res.primera.started, true);
  assert.equal(res.segunda.note, "tiempo", "la segunda vez reusa el guardado (IGUAL), sin esperar");
  assert.ok(res.segundos < 10, `tardo ${res.segundos} s`);
});

test("avance-ws.py: un archivo hecho para trabar el lector se lee en segundos (una pasada por archivo)", { skip: omitir }, async () => {
  const e = entorno();
  escribir(path.join(e.carpeta("traba"), "src", "a.h"), "A::b(".repeat(13000) + "\n" + "class A{".repeat(8000));
  const r = await correr(`
import time
taller = a.cargar_talleres()[0]
a.COMPILADOR = ["true"]
t = time.time()
modelo = a.analizar([open(os.path.join(a.HOMES, "ws-traba", "sistema-bancario-fpoo", "src", "a.h")).read()])
print(json.dumps({"segundos": time.time() - t}))
`, e.rutas);
  assert.equal(r.codigo, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).segundos < 10, r.stdout);
});

test("avance-ws.py: un atributo con inicializador, la carpeta de un segundo clon y copias fuera de src/", { skip: omitir }, async () => {
  const e = entorno();
  // nuevo-tunel.sh clona un fork o un segundo clon como <carpeta>-<algo>: tambien se busca ahi.
  const raiz = path.join(e.rutas.HOMES, "ws-ana", `${BANCO.carpeta}-ana`);
  escribir(path.join(raiz, "src", "modelo", "Banco.h"), `#pragma once
#include <vector>
class Titularidad {};
class Banco {
    std::string nombre;
    std::vector<Titularidad> titulares = std::vector<Titularidad>();
};
`);
  // Una copia vieja fuera de src/ con un main distinto: el main de src/ gana.
  escribir(path.join(raiz, "src", "main.cpp"), "int main() { return 0; }\n");
  escribir(path.join(raiz, "respaldo", "main.cpp"), "int main() { Banco b; Cliente c; Titularidad t; return 0; }\n");
  // Clases fuera de src/ (foto del 29-10: 13 archivos y 0 %): cuentan, y se dice que make no las ve.
  escribir(path.join(raiz, "Cliente.h"), "class Cliente { std::string nombre; public: std::string getNombre() { return nombre; } };\n");
  const r = await correr(`
taller = a.cargar_talleres()[0]
print(json.dumps(a.evaluar_estudiante(taller, "ana", os.path.join(a.HOMES, "ws-ana"))))
`, e.rutas);
  assert.equal(r.codigo, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(res.started, true);
  assert.ok(res.done.includes("banco-atributos"), JSON.stringify(res));
  assert.ok(res.missing.includes("main-banco"), "el main de respaldo/ no gana al de src/");
  assert.ok(res.done.includes("cliente-clase"), "la clase fuera de src/ cuenta");
  assert.equal(res.outside, 2, "Cliente.h y respaldo/main.cpp estan fuera de src/");
});

test("avance-ws.py: avisa al backend con el token del agente; manda porcentajes y puntos, nunca el codigo", { skip: omitir }, async () => {
  const e = entorno();
  const raiz = e.carpeta("ana");
  proyectoDeStubs(raiz);
  escribir(path.join(raiz, "src", "modelo", "Notas.h"), "#pragma once\n// SECRETO_DEL_ESTUDIANTE\nclass Notas { int SECRETO_DEL_ESTUDIANTE = 1; };\n");
  mkdirSync(path.join(e.rutas.HOMES, "ws-beto"), { recursive: true });
  mkdirSync(path.join(e.rutas.HOMES, "no-es-estudiante", BANCO.carpeta), { recursive: true });
  const recibidos = [];
  const servidor = http.createServer((req, res) => {
    let cuerpo = "";
    req.on("data", (d) => { cuerpo += d; });
    req.on("end", () => {
      recibidos.push({ url: req.url, token: req.headers["x-agent-token"], cuerpo });
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    });
  });
  await new Promise((resolve) => servidor.listen(0, "127.0.0.1", resolve));
  try {
    writeFileSync(e.rutas.WS_ENV, `ADACEEN_API_URL=http://127.0.0.1:${servidor.address().port}\n`);
    writeFileSync(e.rutas.AGENTE, "AGENT_TOKEN=token-de-prueba\n");
    const r = await correr("sys.exit(a.correr('avisar'))", e.rutas);
    assert.equal(r.codigo, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /2 estudiantes, 1 con la carpeta/);
  } finally {
    await new Promise((resolve) => servidor.close(resolve));
  }
  assert.equal(recibidos.length, 1);
  assert.equal(recibidos[0].url, "/api/workspaces/progress-report");
  assert.equal(recibidos[0].token, "token-de-prueba");
  assert.doesNotMatch(recibidos[0].cuerpo, /SECRETO_DEL_ESTUDIANTE|return 0|#include/);
  const informe = JSON.parse(recibidos[0].cuerpo);
  assert.equal(informe.taller, "sistema-bancario-fpoo");
  assert.equal(informe.points.length, BANCO.puntos.length);
  assert.deepEqual(informe.students.map((s) => s.login), ["ana", "beto"]);
  assert.equal(informe.students[1].started, false);
  assert.ok(informe.students[0].percent >= 90);
});

test("avance-ws.py --json: la foto lleva un informe por taller con todos los estudiantes y no avisa al backend", { skip: omitir }, async () => {
  const e = entorno();
  proyectoDeStubs(e.carpeta("ana"));
  mkdirSync(path.join(e.rutas.HOMES, "ws-beto"), { recursive: true });
  // Sin servidor: si intentara avisar, igual no hay a quien (y la foto no debe intentarlo).
  writeFileSync(e.rutas.WS_ENV, "ADACEEN_API_URL=http://127.0.0.1:9\n");
  writeFileSync(e.rutas.AGENTE, "AGENT_TOKEN=token\n");
  const r = await correr("sys.exit(a.correr('json'))", e.rutas);
  assert.equal(r.codigo, 0, r.stderr);
  const foto = JSON.parse(r.stdout);
  assert.equal(foto.informes.length, 1);
  assert.deepEqual(foto.informes[0].students.map((s) => s.login), ["ana", "beto"]);
  assert.equal(foto.informes[0].points.length, BANCO.puntos.length);
  assert.doesNotMatch(r.stdout, /no se pudo avisar/);
});

// ---- Revision del 29-10 (3.a): la salida del --evaluar es del estudiante (con ptrace la puede
// cambiar): root la lee con tope, la rearma y no se cae con nada que venga ahi.
function hijoFalso(dir, cuerpo) {
  const ruta = path.join(dir, `hijo-${Math.random().toString(36).slice(2)}.py`);
  writeFileSync(ruta, `import sys, json\nH = "b" * 64\n${cuerpo}\n`);
  return ruta;
}

test("avance-ws.py: una salida enorme se corta en el tope y queda como error, sin llenar la memoria de root", { skip: omitir }, async () => {
  const e = entorno();
  mkdirSync(e.carpeta("mallory"), { recursive: true });
  const hijo = hijoFalso(e.dir, `sys.stdout.write("HUELLA " + H + "\\n")\nsys.stdout.flush()\nbloque = "x" * 1048576\nfor _ in range(200):\n    sys.stdout.write(bloque)\n`);
  const r = await correr(`
import resource, time
a.SCRIPT = ${JSON.stringify(hijo)}
taller = a.cargar_talleres()[0]
t = time.time()
res = a.evaluar_estudiante(taller, "mallory", os.path.join(a.HOMES, "ws-mallory"))
print(json.dumps({"res": res, "segundos": time.time() - t, "rss_mb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024}))
`, e.rutas);
  assert.equal(r.codigo, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.res.note, "error");
  assert.ok(out.rss_mb < 150, `root no guarda los 200 MB (maxrss ${out.rss_mb} MB)`);
});

test("avance-ws.py: listas inventadas se rearman (sin repetidos ni cruces) y un JSON armado para romper no tumba la corrida", { skip: omitir }, async () => {
  const e = entorno();
  mkdirSync(e.carpeta("ana"), { recursive: true });
  mkdirSync(e.carpeta("beto"), { recursive: true });
  // ana devuelve «compila» 150 veces; beto, un RESULTADO que hace RecursionError al leerlo.
  const hijo = hijoFalso(e.dir, `
login = sys.argv[sys.argv.index("--evaluar") + 2].rsplit("ws-", 1)[1]
sys.stdout.write("HUELLA " + H + "\\n")
if login == "ana":
    sys.stdout.write("RESULTADO " + json.dumps({"started": True, "percent": 100, "compiles": True, "done": ["compila"] * 150, "partial": ["compila", "retirar"], "missing": [], "files": 1, "lastChangeAt": None}) + "\\n")
else:
    sys.stdout.write("RESULTADO " + "[" * 200000 + "\\n")
`);
  const r = await correr(`
a.SCRIPT = ${JSON.stringify(hijo)}
sys.exit(a.correr("json"))
`, e.rutas);
  assert.equal(r.codigo, 0, r.stderr);
  const foto = JSON.parse(r.stdout); // stdout es solo el JSON (los avisos van a stderr)
  const [ana, beto] = foto.informes[0].students;
  assert.deepEqual(ana.done, ["compila"]);
  assert.deepEqual(ana.partial, ["retirar"]);
  assert.equal(ana.missing.length, BANCO.puntos.length - 2);
  assert.equal(ana.done.length + ana.partial.length + ana.missing.length, BANCO.puntos.length, "cada punto en una sola lista");
  assert.equal(beto.note, "error");
});

test("avance-ws.py: empieza por quien lleva mas tiempo sin evaluarse y lo reusado por plazo va con su nota", { skip: omitir }, async () => {
  const e = entorno();
  for (const login of ["ana", "beto", "carla"]) mkdirSync(e.carpeta(login), { recursive: true });
  const orden = path.join(e.dir, "orden.txt");
  const hijo = hijoFalso(e.dir, `
login = sys.argv[sys.argv.index("--evaluar") + 2].rsplit("ws-", 1)[1]
open(${JSON.stringify(orden)}, "a").write(login + "\\n")
sys.stdout.write("HUELLA " + H + "\\n")
sys.stdout.write("RESULTADO " + json.dumps({"started": True, "percent": 50, "compiles": None, "done": [], "partial": [], "missing": [], "files": 1, "lastChangeAt": None}) + "\\n")
`);
  mkdirSync(e.rutas.ESTADO, { recursive: true });
  // ana se evaluo hace poco; carla hace mucho; beto nunca.
  writeFileSync(path.join(e.rutas.ESTADO, "sistema-bancario-fpoo--ana.json"), JSON.stringify({ huella: null, resultado: { started: true, percent: 80, compiles: true, done: [], partial: [], missing: [], files: 3, lastChangeAt: null }, evaluadoEn: Date.now() / 1000 }));
  writeFileSync(path.join(e.rutas.ESTADO, "sistema-bancario-fpoo--carla.json"), JSON.stringify({ huella: null, resultado: { started: true, percent: 10, compiles: false, done: [], partial: [], missing: [], files: 1, lastChangeAt: null }, evaluadoEn: 1 }));
  const r = await correr(`
a.SCRIPT = ${JSON.stringify(hijo)}
sys.exit(a.correr("json"))
`, e.rutas);
  assert.equal(r.codigo, 0, r.stderr);
  assert.deepEqual(readFileSync(orden, "utf8").trim().split("\n"), ["beto", "carla", "ana"]);
  const foto = JSON.parse(r.stdout);
  assert.deepEqual(foto.informes[0].students.map((s) => s.login), ["ana", "beto", "carla"], "el informe sale en orden de login");

  // Sin plazo para nadie: lo ultimo que se supo, marcado como pendiente.
  const sinPlazo = await correr(`
taller = a.cargar_talleres()[0]
print(json.dumps(a.evaluar_estudiante(taller, "ana", os.path.join(a.HOMES, "ws-ana"), plazo=0)))
`, e.rutas);
  const ana = JSON.parse(sinPlazo.stdout);
  assert.equal(ana.note, "pendiente");
  assert.equal(ana.percent, 50, "el ultimo resultado guardado");
});

// ---- Avisos del revisor (02-11-2026, el caso de Alan): «Class» con mayuscula sigue en 0 %, pero
// el informe lo dice (sin el codigo) para que el estudiante sepa que corregir.
const AVISOS_CODIGO = JSON.parse(readFileSync(path.resolve(AQUI, "..", "..", "..", "..", "tests", "fixtures", "avisos-codigo.json"), "utf8"));

test("avance-ws.py: avisa Class con mayuscula en los .h (no en comentarios, textos ni con class) y el porcentaje no cambia", { skip: omitir }, async () => {
  const e = entorno();
  const clases = (palabra) => `#pragma once\n#include <string>\n${palabra} Cliente {\n    std::string nombre;\n};\n`;
  escribir(path.join(e.carpeta("alan"), "src", "modelo", "Cliente.h"), clases("Class"));
  escribir(path.join(e.carpeta("alan"), "src", "modelo", "Cuenta.h"), "#pragma once\nCLASS Cuenta : public Base {\n};\nStruct Punto {};\n");
  escribir(path.join(e.carpeta("alan"), "src", "main.cpp"), "int main() { return 0; }\n");
  escribir(path.join(e.carpeta("bien"), "src", "modelo", "Cliente.h"), clases("class"));
  escribir(path.join(e.carpeta("bien"), "src", "main.cpp"), "int main() { return 0; }\n");
  // Solo en comentarios y textos: no avisa.
  escribir(path.join(e.carpeta("comenta"), "src", "modelo", "Cliente.h"), `// Class Cliente {\n/* Class Cuenta {\n} */\nconst char* t = "Class Banco {";\n${clases("class")}`);
  const r = await correr(`
taller = a.cargar_talleres()[0]
salida = {}
for login in ("alan", "bien", "comenta"):
    salida[login] = a.evaluar_estudiante(taller, login, os.path.join(a.HOMES, "ws-" + login))
print(json.dumps(salida))
`, e.rutas);
  assert.equal(r.codigo, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.deepEqual(res.alan.codeNotices, [
    { id: "class-mayuscula", paths: ["src/modelo/Cliente.h", "src/modelo/Cuenta.h"] },
    { id: "struct-mayuscula", paths: ["src/modelo/Cuenta.h"] },
  ]);
  assert.deepEqual(res.bien.codeNotices, []);
  assert.deepEqual(res.comenta.codeNotices, []);
  // La carpeta que se evaluo (para las entregas) y cuando.
  assert.equal(res.alan.entrada, BANCO.carpeta);
  assert.ok(Date.parse(res.alan.medidoEn) > Date.now() - 120_000, res.alan.medidoEn);
  // El porcentaje es el de siempre: Class no es una clase de C++.
  assert.ok(res.alan.missing.includes("cliente-clase") && res.alan.missing.includes("cuenta-clase"), JSON.stringify(res.alan));
  assert.ok(res.bien.done.includes("cliente-clase"));
  assert.ok(res.alan.percent < res.bien.percent, `${res.alan.percent} < ${res.bien.percent}`);
  // La huella incluye la VERSION: con el script nuevo se recalcula (y salen los avisos).
  const version = await correr("print(a.VERSION)", e.rutas);
  assert.match(version.stdout.trim(), /^2026-11-03\./);
});

test("avance-ws.py: el detector de la VM da lo mismo que dice tests/fixtures/avisos-codigo.json (los mismos casos del tutor)", { skip: omitir }, async () => {
  const e = entorno();
  const r = await correr(`
casos = json.loads(${JSON.stringify(JSON.stringify(AVISOS_CODIGO.casos))})
print(json.dumps({c["nombre"]: [n["id"] for n in a.avisos_de([("x.h", a.limpiar(c["code"]))])] for c in casos}))
print(json.dumps(list(a.AVISOS)))
`, e.rutas);
  assert.equal(r.codigo, 0, r.stderr);
  const [porCaso, ids] = r.stdout.trim().split("\n").map((linea) => JSON.parse(linea));
  for (const caso of AVISOS_CODIGO.casos) assert.deepEqual(porCaso[caso.nombre], caso.vm, caso.nombre);
  assert.deepEqual(ids, ["class-mayuscula", "struct-mayuscula"]);
});

test("avance-ws.py: validar deja solo avisos conocidos y bien formados (y una carpeta del taller), sin tumbar el resultado", { skip: omitir }, async () => {
  const e = entorno();
  const r = await correr(`
taller = a.cargar_talleres()[0]
base = {"started": True, "percent": 0, "compiles": False, "done": [], "partial": [], "missing": [], "files": 2, "lastChangeAt": None}
casos = {
    "desconocido": [{"id": "borrar-todo", "paths": ["a.h"]}],
    "mezcla": [{"id": "class-mayuscula", "paths": ["b.h", "a.h", "a.h", 7, "x" * 121, "c\\nd.h", "e\\0.h"]}, {"id": "class-mayuscula", "paths": ["z.h"]}, "texto"],
    "muchos": [{"id": "struct-mayuscula", "paths": ["f%d.h" % i for i in range(20)]}],
    "no-lista": "class-mayuscula",
}
salida = {k: a.validar({**base, "codeNotices": v}, taller) for k, v in casos.items()}
salida["sin"] = a.validar(base, taller)
salida["sin-carpeta"] = a.validar({**base, "started": False, "codeNotices": [{"id": "class-mayuscula", "paths": ["a.h"]}]}, taller)
salida["nota"] = a.con_nota({**base, "codeNotices": [{"id": "class-mayuscula", "paths": ["a.h"]}]}, "pendiente", taller)
entradas = {}
for entrada in ("sistema-bancario-fpoo", "sistema-bancario-fpoo-ana", "otro-repo", "../sistema-bancario-fpoo", "sistema-bancario-fpoo/../x", 7, None):
    entradas[str(entrada)] = a.validar({**base, "entrada": entrada}, taller)["entrada"]
salida["entradas"] = entradas
print(json.dumps(salida))
`, e.rutas);
  assert.equal(r.codigo, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.deepEqual(res.desconocido.codeNotices, [], "un id que el backend no conoce no se manda");
  assert.equal(res.desconocido.percent, 0, "el resultado vale igual");
  assert.deepEqual(res.mezcla.codeNotices, [{ id: "class-mayuscula", paths: ["a.h", "b.h"] }]);
  assert.equal(res.muchos.codeNotices[0].paths.length, 6);
  assert.deepEqual(res["no-lista"].codeNotices, []);
  assert.deepEqual(res.sin.codeNotices, []);
  assert.deepEqual(res["sin-carpeta"].codeNotices, []);
  assert.deepEqual(res.nota.codeNotices, [], "lo reusado por plazo no lleva avisos");
  assert.deepEqual(res.entradas, {
    "sistema-bancario-fpoo": "sistema-bancario-fpoo",
    "sistema-bancario-fpoo-ana": "sistema-bancario-fpoo-ana",
    "otro-repo": null,
    "../sistema-bancario-fpoo": null,
    "sistema-bancario-fpoo/../x": null,
    "7": null,
    "None": null,
  });
});

test("avance-ws.py: un taller con un punto aviso-* no se carga (ese prefijo es de los avisos del revisor)", { skip: omitir }, async () => {
  const e = entorno();
  const talleres = path.join(e.dir, "talleres");
  escribir(path.join(talleres, "malo.json"), JSON.stringify({ taller: "malo", carpeta: "malo", puntos: [{ id: "aviso-class", peso: 100, tipo: "clase", clase: "A" }] }));
  escribir(path.join(talleres, "bueno.json"), JSON.stringify({ taller: "bueno", carpeta: "bueno", puntos: [{ id: "clase-a", peso: 100, tipo: "clase", clase: "A" }] }));
  const r = await correr(`print(json.dumps([t["taller"] for t in a.cargar_talleres(${JSON.stringify(talleres)})]))`, e.rutas);
  assert.deepEqual(JSON.parse(r.stdout.trim()), ["bueno"]);
  assert.match(r.stderr, /malo\.json: ids de puntos no validos/);
});

// ---- Entregas automaticas (02-11-2026): el backend responde el codigo del analisis de cada login y
// la corrida deja PARA_ENTREGAS para respaldo-ws.py (sin nombres).
async function backendFalso(respuestas) {
  const recibidos = [];
  const servidor = http.createServer((req, res) => {
    let cuerpo = "";
    req.on("data", (d) => { cuerpo += d; });
    req.on("end", () => {
      const informe = JSON.parse(cuerpo);
      recibidos.push(informe);
      const respuesta = respuestas(informe);
      if (respuesta === 500) res.writeHead(500).end("{}");
      else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(respuesta));
    });
  });
  await new Promise((resolve) => servidor.listen(0, "127.0.0.1", resolve));
  return { recibidos, url: `http://127.0.0.1:${servidor.address().port}`, cerrar: () => new Promise((resolve) => servidor.close(resolve)) };
}

test("avance-ws.py: guarda PARA_ENTREGAS con el codigo, la carpeta evaluada y cuando se midio (0600, de una vez, nada de eso al backend)", { skip: omitir }, async () => {
  const e = entorno();
  proyectoDeStubs(e.carpeta("ana"));
  escribir(path.join(e.carpeta("beto"), "src", "main.cpp"), "int main() { return 0; }\n");
  mkdirSync(path.join(e.rutas.HOMES, "ws-carla"), { recursive: true });
  const codigo = (letra) => letra.repeat(20);
  let respuesta = { ok: true, analysisCodes: { ana: codigo("a"), beto: "NO-ES-UN-CODIGO", carla: codigo("c"), "../x": codigo("d") } };
  const backend = await backendFalso(() => respuesta);
  const contrato = e.rutas.PARA_ENTREGAS;
  try {
    writeFileSync(e.rutas.WS_ENV, `ADACEEN_API_URL=${backend.url}\n`);
    writeFileSync(e.rutas.AGENTE, "AGENT_TOKEN=token-de-prueba\n");
    const r = await correr("sys.exit(a.correr('avisar'))", e.rutas);
    assert.equal(r.codigo, 0, r.stdout + r.stderr);
    assert.ok(backend.recibidos[0].students.every((s) => Array.isArray(s.codeNotices)), "cada estudiante lleva sus avisos (aunque sea [])");
    assert.ok(backend.recibidos[0].students.every((s) => !("entrada" in s) && !("medidoEn" in s)), "la carpeta y la hora se quedan en la VM");
    const datos = JSON.parse(readFileSync(contrato, "utf8"));
    assert.equal(datos.version, 1);
    assert.ok(Date.parse(datos.generadoEn) > Date.now() - 60_000);
    assert.equal(datos.talleres.length, 1);
    const [taller] = datos.talleres;
    assert.deepEqual([taller.taller, taller.titulo, taller.carpeta], [BANCO.taller, BANCO.titulo, BANCO.carpeta]);
    assert.ok(Date.parse(taller.generadoEn) > Date.now() - 60_000, "cada taller con su hora");
    // beto: codigo invalido; carla: sin la carpeta; "../x": no es un login.
    assert.deepEqual(Object.keys(taller.estudiantes), ["ana"]);
    const ana = taller.estudiantes.ana;
    assert.equal(ana.codigo, codigo("a"));
    assert.equal(ana.entrada, BANCO.carpeta);
    assert.ok(Date.parse(ana.medidoEn) > Date.now() - 120_000);
    assert.equal(ana.nota, null);
    assert.ok(ana.avance >= 90);
    assert.equal(typeof ana.compila, GPP ? "boolean" : "object");
    assert.equal((statSync(contrato).mode & 0o777).toString(8), "600");
    assert.deepEqual(readdirSync(path.dirname(contrato)).filter((n) => n.startsWith(".para-entregas-")), [], "sin temporales");

    // Un backend que respondio {} de codigos: nadie (lista vacia, no se conserva la anterior).
    respuesta = { ok: true, analysisCodes: {} };
    await correr("sys.exit(a.correr('avisar'))", e.rutas);
    assert.deepEqual(JSON.parse(readFileSync(contrato, "utf8")).talleres[0].estudiantes, {});

    // Sin codigos (null: no pudo leer las cuentas; o un backend anterior), o el informe no llego:
    // se conserva lo anterior del taller mientras valga.
    respuesta = { ok: true, analysisCodes: { ana: codigo("a") } };
    await correr("sys.exit(a.correr('avisar'))", e.rutas);
    const conAna = JSON.parse(readFileSync(contrato, "utf8")).talleres[0];
    for (const otra of [{ ok: true, analysisCodes: null, history: null }, { ok: true }, 500]) {
      respuesta = otra;
      const corrida = await correr("sys.exit(a.correr('avisar'))", e.rutas);
      assert.equal(corrida.codigo, otra === 500 ? 1 : 0, JSON.stringify(otra));
      assert.deepEqual(JSON.parse(readFileSync(contrato, "utf8")).talleres[0], conAna, JSON.stringify(otra));
    }
    // Si lo anterior ya no vale (mas de 2 horas), no se conserva ni se renueva su fecha.
    const viejo = JSON.parse(readFileSync(contrato, "utf8"));
    viejo.talleres[0].generadoEn = new Date(Date.now() - 3 * 3600_000).toISOString();
    writeFileSync(contrato, JSON.stringify(viejo));
    respuesta = 500;
    await correr("sys.exit(a.correr('avisar'))", e.rutas);
    const sinRenovar = await correr("print(json.dumps(sorted(a.talleres_anteriores())))", e.rutas);
    assert.deepEqual(JSON.parse(sinRenovar.stdout), [], "lo viejo no se renueva (respaldo-ws.py tampoco lo usa)");
    // --sin-avisar y --json no lo escriben.
    rmSync(contrato);
    await correr("sys.exit(a.correr('resumen'))", e.rutas);
    await correr("sys.exit(a.correr('json'))", e.rutas);
    assert.equal(existsSync(contrato), false);
  } finally {
    await backend.cerrar();
  }
});

test("avance-ws.py: con dos talleres, el que no llego al backend conserva su parte y el otro se renueva", { skip: omitir }, async () => {
  const e = entorno();
  const talleres = path.join(e.dir, "talleres");
  for (const nombre of ["taller-a", "taller-b"]) {
    escribir(path.join(talleres, `${nombre}.json`), JSON.stringify({ taller: nombre, titulo: nombre, carpeta: nombre, puntos: [{ id: "clase-a", peso: 100, tipo: "clase", clase: "A" }] }));
    escribir(path.join(e.rutas.HOMES, "ws-ana", nombre, "a.h"), "class A {};\n");
  }
  const codigo = "e5".repeat(10);
  let falla = "";
  const backend = await backendFalso((informe) => (informe.taller === falla ? 500 : { ok: true, analysisCodes: { ana: codigo } }));
  try {
    writeFileSync(e.rutas.WS_ENV, `ADACEEN_API_URL=${backend.url}\n`);
    writeFileSync(e.rutas.AGENTE, "AGENT_TOKEN=token-de-prueba\n");
    await correr(`sys.exit(a.correr('avisar', ${JSON.stringify(talleres)}))`, e.rutas);
    const primera = JSON.parse(readFileSync(e.rutas.PARA_ENTREGAS, "utf8"));
    assert.deepEqual(primera.talleres.map((t) => t.taller), ["taller-a", "taller-b"]);
    falla = "taller-a";
    escribir(path.join(e.rutas.HOMES, "ws-ana", "taller-b", "b.h"), "class B {};\n");
    const r = await correr(`sys.exit(a.correr('avisar', ${JSON.stringify(talleres)}))`, e.rutas);
    assert.equal(r.codigo, 1);
    const segunda = JSON.parse(readFileSync(e.rutas.PARA_ENTREGAS, "utf8"));
    assert.deepEqual(segunda.talleres.map((t) => t.taller), ["taller-a", "taller-b"], "el que fallo no desaparece");
    assert.deepEqual(segunda.talleres[0], primera.talleres[0], "taller-a: lo de antes, tal cual");
    assert.ok(segunda.talleres[1].generadoEn >= primera.talleres[1].generadoEn, "taller-b: de esta corrida");
    assert.equal(segunda.talleres[1].estudiantes.ana.codigo, codigo);
  } finally {
    await backend.cerrar();
  }
});
