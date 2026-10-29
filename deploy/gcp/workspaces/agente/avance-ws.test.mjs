// Pruebas de avance-ws.py (avance de los talleres en la VM de editores, 29-10-2026), sin la VM:
// /home, /etc y /var/lib se cambian a una carpeta temporal, el backend es un servidor HTTP local
// y se compila con el g++ de la maquina (sin g++, la prueba de compilar se omite).
//   node --test deploy/gcp/workspaces/agente/avance-ws.test.mjs
//
// El proyecto «completo» se arma aqui con metodos de una linea a partir de los puntos del taller:
// el repositorio es publico y no debe llevar una solucion del Sistema bancario.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
const omitir = PYTHON ? false : "falta python3";
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
  assert.deepEqual(comando.slice(0, 5), ["runuser", "-u", "ws-ana", "--", "env"]);
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
  // Una copia vieja fuera de src/ con un main distinto no se lee.
  escribir(path.join(raiz, "respaldo", "main.cpp"), "int main() { Banco b; Cliente c; Titularidad t; return 0; }\n");
  const r = await correr(`
taller = a.cargar_talleres()[0]
print(json.dumps(a.evaluar_estudiante(taller, "ana", os.path.join(a.HOMES, "ws-ana"))))
`, e.rutas);
  assert.equal(r.codigo, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(res.started, true);
  assert.ok(res.done.includes("banco-atributos"), JSON.stringify(res));
  assert.ok(res.missing.includes("main-banco"), "el main de respaldo/ no cuenta");
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
