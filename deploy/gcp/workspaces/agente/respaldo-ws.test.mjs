// Pruebas de respaldo-ws.py (copia de respaldo de la VM de editores, 28-10-2026), sin Google
// Cloud: Storage, el servidor de metadata y el backend son un servidor HTTP local, y las rutas de
// la VM (/home, /etc, /var/lib) se cambian a una carpeta temporal.
//   node --test deploy/gcp/workspaces/agente/respaldo-ws.test.mjs
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(AQUI, "..", "respaldo-ws.py");

function pythonReal() {
  // "python" primero: en Windows, python3 puede ser el atajo de la tienda, que no es Python.
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
const PYTHON = pythonReal();
const omitir = PYTHON ? false : "falta python3";

/** Corre una funcion del script con las rutas de la VM cambiadas. */
function correr(codigo, rutas) {
  const preambulo = `
import importlib.util, json, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("respaldo", ${JSON.stringify(SCRIPT)})
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
for clave, valor in json.loads(${JSON.stringify(JSON.stringify(rutas))}).items():
    setattr(r, clave, valor)
`;
  return new Promise((resolve) => {
    execFile(PYTHON, ["-c", `${preambulo}\n${codigo}`], { encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ codigo: error ? error.code : 0, stdout, stderr });
    });
  });
}

function escribir(ruta, contenido) {
  mkdirSync(path.dirname(ruta), { recursive: true });
  writeFileSync(ruta, contenido);
}

test("respaldo-ws.py: copia solo el trabajo, sube lo que cambio, avisa al backend y restaura sin pisar nada", { skip: omitir }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "adaceen-respaldo-"));
  const subidas = [];
  const informes = [];
  const servidor = http.createServer((req, res) => {
    const partes = [];
    req.on("data", (parte) => partes.push(parte));
    req.on("end", () => {
      const cuerpo = Buffer.concat(partes);
      if (req.url.startsWith("/token")) {
        assert.equal(req.headers["metadata-flavor"], "Google");
        res.end(JSON.stringify({ access_token: "token-de-prueba" }));
        return;
      }
      if (req.url.startsWith("/upload/")) {
        assert.equal(req.headers.authorization, "Bearer token-de-prueba");
        const url = new URL(req.url, "http://x");
        subidas.push({ bucket: decodeURIComponent(url.pathname.split("/")[2]), nombre: url.searchParams.get("name"), cuerpo });
        res.end("{}");
        return;
      }
      if (req.url === "/api/workspaces/backup-report") {
        assert.equal(req.headers["x-agent-token"], "token-del-agente");
        informes.push(JSON.parse(cuerpo.toString()));
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise((resolve) => servidor.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    const homes = path.join(dir, "home");
    const ana = path.join(homes, "ws-ana");
    escribir(path.join(ana, "sistema-bancario", "main.cpp"), "int main() { return 0; }\n");
    escribir(path.join(ana, "sistema-bancario", ".vscode", "settings.json"), "{}\n");
    escribir(path.join(ana, "sistema-bancario", ".git", "config"), "no va\n");
    escribir(path.join(ana, "sistema-bancario", "build", "main.o"), "no va\n");
    escribir(path.join(ana, "sistema-bancario", "banco"), "binario\n");
    escribir(path.join(ana, "notas.txt"), "apuntes\n");
    escribir(path.join(ana, ".adaceen", "editor-session.json"), "{\"sessionId\":\"secreto\"}\n");
    escribir(path.join(ana, ".vscode-server", "data", "x"), "no va\n");
    escribir(path.join(homes, "ws-beto", "taller", "a.cpp"), "// beto\n");
    escribir(path.join(homes, "no-es-estudiante", "x.cpp"), "// no va\n");
    let enlaces = true;
    try {
      symlinkSync(path.join(homes, "ws-beto", "taller", "a.cpp"), path.join(ana, "sistema-bancario", "copiado.cpp"));
    } catch {
      enlaces = false; // Windows sin permiso para enlaces
    }
    escribir(path.join(dir, "etc", "respaldo.env"), "BUCKET=adaceen-respaldos-prueba\nPREFIJO=respaldos\n");
    escribir(path.join(dir, "etc", "agente.env"), "AGENT_TOKEN=token-del-agente\n");
    escribir(path.join(dir, "etc", "ws.env"), `ADACEEN_API_URL=${base}\n`);
    const rutas = {
      CONFIG: path.join(dir, "etc", "respaldo.env"),
      AGENTE: path.join(dir, "etc", "agente.env"),
      WS_ENV: path.join(dir, "etc", "ws.env"),
      ESTADO: path.join(dir, "var", "respaldo"),
      HOMES: homes,
      METADATA_TOKEN: `${base}/token`,
      STORAGE_UPLOAD: `${base}/upload/`,
      PARA_ENTREGAS: path.join(dir, "var", "avance", "para-entregas.json"),
    };

    // Que entra: los repos y archivos sin punto, sin .git, build, binarios, ni la sesion del editor.
    const lista = await correr("print(json.dumps([rel.replace(chr(92), '/') for rel, _a, _s in r.archivos_de(r.HOMES + '/ws-ana')]))", rutas);
    assert.equal(lista.codigo, 0, lista.stderr);
    assert.deepEqual(JSON.parse(lista.stdout).sort(), ["notas.txt", "sistema-bancario/.vscode/settings.json", "sistema-bancario/main.cpp"]);
    if (!enlaces) console.log("   (sin enlaces simbolicos en este sistema: no se prueba que se ignoran)");

    // Primera copia: los dos estudiantes, un tar.gz por estudiante, y el informe al backend.
    const primera = await correr("sys.exit(r.respaldar(False))", rutas);
    assert.equal(primera.codigo, 0, primera.stderr + primera.stdout);
    assert.deepEqual(subidas.map((s) => s.bucket), ["adaceen-respaldos-prueba", "adaceen-respaldos-prueba"]);
    assert.match(subidas[0].nombre, /^respaldos\/ana\/\d{4}-\d{2}-\d{2}\/\d{4}\.tar\.gz$/);
    assert.match(subidas[1].nombre, /^respaldos\/beto\//);
    assert.equal(informes.length, 1);
    assert.equal(informes[0].ok, true);
    assert.equal(informes[0].students, 2);
    assert.equal(informes[0].changed, 2);
    assert.equal(informes[0].uploaded, 2);
    assert.equal(informes[0].bucket, "gs://adaceen-respaldos-prueba");
    assert.ok(!subidas[0].cuerpo.toString("latin1").includes("secreto"), "la sesion del editor no se copia");

    // Sin cambios: no sube nada (pero avisa que corrio).
    const segunda = await correr("sys.exit(r.respaldar(False))", rutas);
    assert.equal(segunda.codigo, 0, segunda.stderr);
    assert.equal(subidas.length, 2, "nada cambio: nada se sube");
    assert.equal(informes.at(-1).changed, 0);

    // Ana guarda un cambio: solo se sube lo de ella.
    escribir(path.join(ana, "sistema-bancario", "cuenta.cpp"), "class Cuenta {};\n");
    const tercera = await correr("sys.exit(r.respaldar(False))", rutas);
    assert.equal(tercera.codigo, 0, tercera.stderr);
    assert.equal(subidas.length, 3);
    assert.match(subidas[2].nombre, /^respaldos\/ana\//);

    // Restaurar: en una carpeta nueva, con lo de la copia; una carpeta que ya existe no se pisa.
    const tar = path.join(dir, "copia.tar.gz");
    writeFileSync(tar, subidas[2].cuerpo);
    const destino = path.join(dir, "restaurado");
    const restaurar = await correr(`sys.exit(r.extraer(${JSON.stringify(tar)}, ${JSON.stringify(destino)}))`, rutas);
    assert.equal(restaurar.codigo, 0, restaurar.stderr + restaurar.stdout);
    assert.equal(readFileSync(path.join(destino, "sistema-bancario", "cuenta.cpp"), "utf8"), "class Cuenta {};\n");
    assert.equal(readFileSync(path.join(destino, "notas.txt"), "utf8"), "apuntes\n");
    assert.equal(existsSync(path.join(destino, "sistema-bancario", ".git")), false);
    const otraVez = await correr(`sys.exit(r.extraer(${JSON.stringify(tar)}, ${JSON.stringify(destino)}))`, rutas);
    assert.equal(otraVez.codigo, 1, "no pisa una carpeta que ya existe");

    // Un tar con rutas que salen de la carpeta no escribe fuera.
    const malo = await correr(`
import io, tarfile
b = io.BytesIO()
with tarfile.open(fileobj=b, mode="w:gz") as t:
    for nombre in ("../fuera.txt", "/abs.txt", "bien.txt"):
        i = tarfile.TarInfo(nombre); d = b"x"; i.size = len(d); t.addfile(i, io.BytesIO(d))
open(${JSON.stringify(path.join(dir, "malo.tar.gz"))}, "wb").write(b.getvalue())
sys.exit(r.extraer(${JSON.stringify(path.join(dir, "malo.tar.gz"))}, ${JSON.stringify(path.join(dir, "dentro"))}))`, rutas);
    assert.equal(malo.codigo, 0, malo.stderr);
    assert.equal(existsSync(path.join(dir, "fuera.txt")), false);
    assert.equal(existsSync(path.join(dir, "dentro", "bien.txt")), true);
  } finally {
    servidor.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Entregas automaticas (02-11-2026, docs/operacion/entregas-drive.md): un zip por estudiante y
// taller con el codigo del analisis (nunca el login), con su manifiesto, cuando la carpeta cambia.
// Abren cada carpeta sin seguir enlaces (dir_fd, O_NOFOLLOW): Linux, como la VM.
const omitirEntregas = omitir || (process.platform === "win32" ? "las entregas necesitan Linux (como la VM)" : false);
const CODIGO_ANA = "a1".repeat(10);
const CODIGO_BETO = "b2".repeat(10);

async function storageFalso() {
  const subidas = [];
  const informes = [];
  const servidor = http.createServer((req, res) => {
    const partes = [];
    req.on("data", (parte) => partes.push(parte));
    req.on("end", () => {
      const cuerpo = Buffer.concat(partes);
      if (req.url.startsWith("/token")) {
        res.end(JSON.stringify({ access_token: "token-de-prueba" }));
        return;
      }
      if (req.url.startsWith("/upload/")) {
        const url = new URL(req.url, "http://x");
        subidas.push({ nombre: url.searchParams.get("name"), tipo: req.headers["content-type"], cuerpo });
        res.end("{}");
        return;
      }
      if (req.url === "/api/workspaces/backup-report") {
        informes.push(JSON.parse(cuerpo.toString()));
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise((resolve) => servidor.listen(0, "127.0.0.1", resolve));
  return { subidas, informes, base: `http://127.0.0.1:${servidor.address().port}`, cerrar: () => new Promise((resolve) => servidor.close(resolve)) };
}

function entornoEntregas(base, { config = "" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "adaceen-entregas-"));
  const homes = path.join(dir, "home");
  escribir(path.join(dir, "etc", "respaldo.env"), `BUCKET=adaceen-respaldos-prueba\nPREFIJO=respaldos\n${config}`);
  escribir(path.join(dir, "etc", "agente.env"), "AGENT_TOKEN=token-del-agente\n");
  escribir(path.join(dir, "etc", "ws.env"), `ADACEEN_API_URL=${base}\n`);
  const rutas = {
    CONFIG: path.join(dir, "etc", "respaldo.env"),
    AGENTE: path.join(dir, "etc", "agente.env"),
    WS_ENV: path.join(dir, "etc", "ws.env"),
    ESTADO: path.join(dir, "var", "respaldo"),
    HOMES: homes,
    METADATA_TOKEN: `${base}/token`,
    STORAGE_UPLOAD: `${base}/upload/`,
    PARA_ENTREGAS: path.join(dir, "var", "avance", "para-entregas.json"),
  };
  // Como lo deja avance-ws.py: cada estudiante con la carpeta que se evaluo (entrada) y cuando.
  const estudiante = (datos) => ({ entrada: "sistema-bancario-fpoo", medidoEn: new Date().toISOString(), nota: null, ...datos });
  const contrato = (estudiantes, extra = {}) => escribir(rutas.PARA_ENTREGAS, JSON.stringify({
    version: 1,
    generadoEn: new Date().toISOString(),
    talleres: [{
      taller: "sistema-bancario-fpoo", titulo: "Sistema bancario", carpeta: "sistema-bancario-fpoo", generadoEn: new Date().toISOString(),
      estudiantes: Object.fromEntries(Object.entries(estudiantes).map(([login, datos]) => [login, estudiante(datos)])),
    }],
    ...extra,
  }));
  return { dir, homes, rutas, contrato };
}

/** Las entradas de un zip (nombre y contenido), leidas con Python. */
async function entradasDelZip(rutas, cuerpo, dir) {
  const archivo = path.join(dir, `z-${Math.random().toString(36).slice(2)}.zip`);
  writeFileSync(archivo, cuerpo);
  const r = await correr(`
import zipfile
with zipfile.ZipFile(${JSON.stringify(archivo)}) as z:
    print(json.dumps({n: z.read(n).decode("utf-8", "replace") for n in z.namelist()}))
`, rutas);
  assert.equal(r.codigo, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("respaldo-ws.py: entrega con el codigo del analisis: zip y manifiesto, nombres canonicos, sin login ni enlaces a otro", { skip: omitirEntregas }, async () => {
  const storage = await storageFalso();
  const e = entornoEntregas(storage.base);
  try {
    // La carpeta real de ana es la de un segundo clon (<carpeta>-ana): en el zip va con el nombre del taller.
    const ana = path.join(e.homes, "ws-ana");
    escribir(path.join(ana, "sistema-bancario-fpoo-ana", "src", "main.cpp"), "int main() { return 0; } // ana\n");
    escribir(path.join(ana, "sistema-bancario-fpoo-ana", "src", "modelo", "Cuenta.h"), "class Cuenta {};\n");
    escribir(path.join(ana, "sistema-bancario-fpoo-ana", ".git", "config"), "no va\n");
    escribir(path.join(ana, "sistema-bancario-fpoo-ana", ".vscode", "settings.json"), "{\"ruta\": \"/home/ws-ana\"}\n");
    escribir(path.join(ana, "sistema-bancario-fpoo-ana", "build", "main.o"), "no va\n");
    escribir(path.join(ana, "sistema-bancario-fpoo-ana", "banco"), "binario\n");
    escribir(path.join(ana, "otro-repo", "x.cpp"), "// no es del taller\n");
    escribir(path.join(e.homes, "ws-beto", "sistema-bancario-fpoo", "a.cpp"), "// SECRETO_DE_BETO\n");
    // ana enlaza el archivo y la carpeta de beto: no se siguen.
    symlinkSync(path.join(e.homes, "ws-beto", "sistema-bancario-fpoo", "a.cpp"), path.join(ana, "sistema-bancario-fpoo-ana", "src", "copiado.cpp"));
    symlinkSync(path.join(e.homes, "ws-beto", "sistema-bancario-fpoo"), path.join(ana, "sistema-bancario-fpoo-ana", "de-beto"));
    // carla: en el contrato, pero su carpeta del taller es un enlace a la de beto.
    mkdirSync(path.join(e.homes, "ws-carla"), { recursive: true });
    symlinkSync(path.join(e.homes, "ws-beto", "sistema-bancario-fpoo"), path.join(e.homes, "ws-carla", "sistema-bancario-fpoo"));
    // ana: avance-ws.py evaluo su segundo clon; ademas tiene una carpeta con el nombre exacto, mas
    // nueva, que NO se evaluo: se entrega la evaluada (una sola dueña de la eleccion).
    escribir(path.join(ana, "sistema-bancario-fpoo", "src", "otra.cpp"), "// NO_EVALUADA\n");
    e.contrato({
      ana: { codigo: CODIGO_ANA, avance: 42, compila: true, entrada: "sistema-bancario-fpoo-ana", medidoEn: "2026-11-02T19:20:00+00:00" },
      carla: { codigo: "c3".repeat(10), avance: 0, compila: null },
    });

    const r = await correr("sys.exit(r.respaldar(False))", e.rutas);
    assert.equal(r.codigo, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /1 entregas, 0 fallidas/);
    const entregas = storage.subidas.filter((s) => s.nombre.startsWith("entregas/"));
    assert.equal(entregas.length, 2, entregas.map((s) => s.nombre).join(", "));
    const [zip, manifiesto] = entregas;
    assert.match(zip.nombre, new RegExp(`^entregas/sistema-bancario-fpoo/${CODIGO_ANA}/\\d{4}-\\d{2}-\\d{2}_\\d{4}\\.zip$`));
    assert.equal(manifiesto.nombre, zip.nombre.replace(/\.zip$/, ".json"), "el manifiesto va despues, con el mismo nombre");
    assert.equal(zip.tipo, "application/zip");
    assert.equal(manifiesto.tipo, "application/json");
    assert.ok(storage.subidas.filter((s) => s.nombre.startsWith("respaldos/")).every((s) => s.tipo === "application/gzip"), "la copia sigue igual");

    const datos = JSON.parse(manifiesto.cuerpo.toString("utf8"));
    assert.deepEqual(Object.keys(datos).sort(), ["archivos", "avance", "avanceAlDia", "avanceMedidoEn", "bytes", "codigo", "compila", "fecha", "sha256", "taller", "titulo", "version"]);
    assert.equal(datos.avanceMedidoEn, "2026-11-02T19:20:00+00:00");
    assert.equal(datos.avanceAlDia, true);
    assert.equal(datos.version, 1);
    assert.equal(datos.codigo, CODIGO_ANA);
    assert.equal(datos.taller, "sistema-bancario-fpoo");
    assert.equal(datos.titulo, "Sistema bancario");
    assert.equal(datos.sha256, createHash("sha256").update(zip.cuerpo).digest("hex"));
    assert.equal(datos.bytes, zip.cuerpo.length);
    assert.equal(datos.archivos, 2);
    assert.equal(datos.avance, 42);
    assert.equal(datos.compila, true);
    assert.match(datos.fecha, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-05:00$/);

    const contenido = await entradasDelZip(e.rutas, zip.cuerpo, e.dir);
    assert.deepEqual(Object.keys(contenido).sort(), ["sistema-bancario-fpoo/src/main.cpp", "sistema-bancario-fpoo/src/modelo/Cuenta.h"]);
    const todo = zip.cuerpo.toString("latin1") + manifiesto.cuerpo.toString("utf8") + JSON.stringify(contenido);
    for (const secreto of ["SECRETO_DE_BETO", "NO_EVALUADA", "ws-ana", "/home", "ana/", "-ana", "carla", "beto"]) {
      assert.equal(todo.includes(secreto), false, `la entrega no lleva ${secreto}`);
    }
    assert.ok(!entregas.some((s) => s.nombre.includes("c3c3")), "una carpeta del taller que es un enlace no se entrega");
    // El estado de las entregas: carpeta 0700 y archivos 0600, por taller y codigo.
    const estado = path.join(e.rutas.ESTADO, "entregas");
    assert.equal((statSync(estado).mode & 0o777).toString(8), "700");
    const guardado = path.join(estado, `sistema-bancario-fpoo--${CODIGO_ANA}.json`);
    assert.equal((statSync(guardado).mode & 0o777).toString(8), "600");
    assert.equal(JSON.parse(readFileSync(guardado, "utf8")).objeto, zip.nombre);
    // El resumen del respaldo (ultimo.json) cuenta las entregas.
    const ultimo = JSON.parse(readFileSync(path.join(e.rutas.ESTADO, "ultimo.json"), "utf8"));
    assert.deepEqual([ultimo.entregas, ultimo.entregasFallidas, ultimo.ok], [1, 0, true]);
  } finally {
    await storage.cerrar();
    rmSync(e.dir, { recursive: true, force: true });
  }
});

test("respaldo-ws.py: la entrega espera ENTREGA_CADA_MIN y un cambio; al apagar no espera; ENTREGAS=off (metadata entregas=off) las apaga", { skip: omitirEntregas }, async () => {
  const storage = await storageFalso();
  const e = entornoEntregas(storage.base);
  const entregas = () => storage.subidas.filter((s) => s.nombre.startsWith("entregas/") && s.nombre.endsWith(".zip"));
  try {
    const raiz = path.join(e.homes, "ws-beto", "sistema-bancario-fpoo");
    escribir(path.join(raiz, "main.cpp"), "int main() {}\n");
    e.contrato({ beto: { codigo: CODIGO_BETO, avance: 10, compila: false } });
    assert.equal((await correr("sys.exit(r.respaldar(False))", e.rutas)).codigo, 0);
    assert.equal(entregas().length, 1);

    // Nada cambio: no se sube otra.
    await correr("sys.exit(r.respaldar(False))", e.rutas);
    assert.equal(entregas().length, 1);
    // Cambio, pero no han pasado 60 min: espera.
    escribir(path.join(raiz, "Cuenta.h"), "class Cuenta {};\n");
    const espera = await correr("sys.exit(r.respaldar(False))", e.rutas);
    assert.match(espera.stdout, /0 entregas/);
    assert.equal(entregas().length, 1, "el intervalo se respeta");
    // Pasaron los 60 min (la ultima subida fue hace 2 horas): se sube.
    const guardado = path.join(e.rutas.ESTADO, "entregas", `sistema-bancario-fpoo--${CODIGO_BETO}.json`);
    writeFileSync(guardado, JSON.stringify({ ...JSON.parse(readFileSync(guardado, "utf8")), subidoEn: Date.now() / 1000 - 7200, objeto: "otro" }));
    assert.equal((await correr("sys.exit(r.respaldar(False))", e.rutas)).codigo, 0);
    assert.equal(entregas().length, 2);
    // Al apagar no espera el intervalo (la entrega del final de la clase).
    escribir(path.join(raiz, "Banco.h"), "class Banco {};\n");
    writeFileSync(guardado, JSON.stringify({ ...JSON.parse(readFileSync(guardado, "utf8")), objeto: "otro" }));
    assert.equal((await correr("sys.exit(r.respaldar(True))", e.rutas)).codigo, 0);
    assert.equal(entregas().length, 3, "--al-apagar no espera");
    // Un ENTREGA_CADA_MIN en la configuracion no cambia nada: es fijo (startup-ws.sh la reescribe).
    writeFileSync(e.rutas.CONFIG, "BUCKET=adaceen-respaldos-prueba\nENTREGA_CADA_MIN=0\n");
    escribir(path.join(raiz, "Cliente.h"), "class Cliente {};\n");
    await correr("sys.exit(r.respaldar(False))", e.rutas);
    assert.equal(entregas().length, 3, "sigue esperando los 60 min");

    // ENTREGAS=off (lo escribe startup-ws.sh con la metadata entregas=off): la copia sigue, sin entregas.
    writeFileSync(e.rutas.CONFIG, "BUCKET=adaceen-respaldos-prueba\nPREFIJO=respaldos\nENTREGAS=off\n");
    writeFileSync(guardado, JSON.stringify({ ...JSON.parse(readFileSync(guardado, "utf8")), subidoEn: 0, objeto: "otro" }));
    escribir(path.join(raiz, "Titular.h"), "class Titular {};\n");
    const apagadas = await correr("sys.exit(r.respaldar(False))", e.rutas);
    assert.equal(apagadas.codigo, 0, apagadas.stdout);
    assert.match(apagadas.stdout, /entregas apagadas \(metadata entregas=off\)/);
    assert.equal(entregas().length, 3);
    assert.ok(storage.subidas.at(-1).nombre.startsWith("respaldos/beto/"), "la copia de respaldo si se hizo");
  } finally {
    await storage.cerrar();
    rmSync(e.dir, { recursive: true, force: true });
  }
});

test("respaldo-ws.py: sin para-entregas.json, viejo o invalido no hay entregas y la copia sale bien", { skip: omitirEntregas }, async () => {
  const storage = await storageFalso();
  const e = entornoEntregas(storage.base);
  try {
    escribir(path.join(e.homes, "ws-ana", "sistema-bancario-fpoo", "main.cpp"), "int main() {}\n");
    const casos = [
      ["sin archivo", null, /todavia no hay para-entregas\.json/],
      ["viejo", () => e.contrato({ ana: { codigo: CODIGO_ANA, avance: 1, compila: null } }, { generadoEn: new Date(Date.now() - 3 * 3600_000).toISOString() }), /mas de 2 horas/],
      ["otra version", () => e.contrato({}, { version: 2 }), /no es la version 1/],
      // Un estudiante raro se omite y se cuenta (los demas del contrato igual tienen su entrega).
      ["codigo malo", () => e.contrato({ ana: { codigo: "ANA-NO-ES-CODIGO", avance: 1, compila: null } }), /1 estudiante\(s\) del contrato no eran validos/],
      ["login malo", () => e.contrato({ "../root": { codigo: CODIGO_ANA, avance: 1, compila: null } }), /1 estudiante\(s\) del contrato no eran validos/],
      ["carpeta mala", () => escribir(e.rutas.PARA_ENTREGAS, JSON.stringify({ version: 1, generadoEn: new Date().toISOString(), talleres: [{ taller: "t", titulo: "t", carpeta: "../..", estudiantes: {} }] })), /un taller no es valido/],
      ["sin entrada", () => e.contrato({ ana: { codigo: CODIGO_ANA, avance: 1, compila: null, entrada: null } }), /1 estudiante\(s\) del contrato no eran validos/],
      ["entrada de otro taller", () => e.contrato({ ana: { codigo: CODIGO_ANA, avance: 1, compila: null, entrada: "otro-repo" } }), /1 estudiante\(s\) del contrato no eran validos/],
      ["entrada que sale del home", () => e.contrato({ ana: { codigo: CODIGO_ANA, avance: 1, compila: null, entrada: "sistema-bancario-fpoo/../../x" } }), /1 estudiante\(s\) del contrato no eran validos/],
      ["nota rara", () => e.contrato({ ana: { codigo: CODIGO_ANA, avance: 1, compila: null, nota: "otra" } }), /1 estudiante\(s\) del contrato no eran validos/],
      ["no es JSON", () => escribir(e.rutas.PARA_ENTREGAS, "{" + "[".repeat(100000)), /no es la version 1/],
    ];
    for (const [nombre, preparar, motivo] of casos) {
      rmSync(e.rutas.PARA_ENTREGAS, { force: true });
      if (preparar) preparar();
      rmSync(path.join(e.rutas.ESTADO, "ana.huella"), { force: true });
      const antes = storage.subidas.length;
      const r = await correr("sys.exit(r.respaldar(False))", e.rutas);
      assert.equal(r.codigo, 0, `${nombre}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, motivo, nombre);
      const nuevas = storage.subidas.slice(antes);
      assert.deepEqual(nuevas.map((s) => s.nombre.split("/")[0]), ["respaldos"], `${nombre}: solo la copia`);
      assert.equal(storage.informes.at(-1).ok, true, nombre);
    }
    // Un contrato que es un enlace simbolico no se sigue.
    rmSync(e.rutas.PARA_ENTREGAS, { force: true });
    const verdadero = path.join(e.dir, "otro.json");
    writeFileSync(verdadero, JSON.stringify({ version: 1, generadoEn: new Date().toISOString(), talleres: [{ taller: "sistema-bancario-fpoo", titulo: "x", carpeta: "sistema-bancario-fpoo", estudiantes: { ana: { codigo: CODIGO_ANA, avance: 1, compila: null, entrada: "sistema-bancario-fpoo" } } }] }));
    symlinkSync(verdadero, e.rutas.PARA_ENTREGAS);
    rmSync(path.join(e.rutas.ESTADO, "ana.huella"), { force: true });
    const enlace = await correr("sys.exit(r.respaldar(False))", e.rutas);
    assert.equal(enlace.codigo, 0);
    assert.equal(storage.subidas.filter((s) => s.nombre.startsWith("entregas/")).length, 0, "el enlace no se sigue");

    // Un estudiante raro no deja sin entrega a los demas: se omite, se cuenta y ana si sale.
    rmSync(e.rutas.PARA_ENTREGAS, { force: true });
    e.contrato({ ana: { codigo: CODIGO_ANA, avance: 1, compila: null }, beto: { codigo: "NO-ES", avance: 1, compila: null } });
    const mezcla = await correr("sys.exit(r.respaldar(False))", e.rutas);
    assert.equal(mezcla.codigo, 0, mezcla.stdout + mezcla.stderr);
    assert.match(mezcla.stdout, /1 entregas, 0 fallidas \(1 estudiante\(s\) del contrato no eran validos y no tienen entrega\)/);
    assert.equal(mezcla.stdout.includes("NO-ES"), false, "la nota no lleva el dato raro");
    const ultimo = JSON.parse(readFileSync(path.join(e.rutas.ESTADO, "ultimo.json"), "utf8"));
    assert.match(ultimo.notaEntregas, /1 estudiante\(s\) del contrato/);
  } finally {
    await storage.cerrar();
    rmSync(e.dir, { recursive: true, force: true });
  }
});

test("respaldo-ws.py: si falla la subida de una entrega, la copia de respaldo vale y se reintenta despues", { skip: omitirEntregas }, async () => {
  const storage = await storageFalso();
  const e = entornoEntregas(storage.base);
  try {
    escribir(path.join(e.homes, "ws-ana", "sistema-bancario-fpoo", "main.cpp"), "int main() {}\n");
    e.contrato({ ana: { codigo: CODIGO_ANA, avance: 5, compila: true } });
    // El bucket rechaza lo que empieza por entregas/ (por ejemplo, sin permiso en ese prefijo).
    const r = await correr(`
original = r.subir
def subir(bucket, nombre, datos, token, espera, tipo="application/gzip"):
    if nombre.startswith("entregas/"):
        raise RuntimeError("HTTP 403")
    return original(bucket, nombre, datos, token, espera, tipo)
r.subir = subir
sys.exit(r.respaldar(False))`, e.rutas);
    assert.equal(r.codigo, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /1 copiados, 0 fallidos; 0 entregas, 1 fallidas/);
    assert.equal(storage.informes.at(-1).ok, true, "el respaldo salio bien");
    assert.equal(existsSync(path.join(e.rutas.ESTADO, "entregas", `sistema-bancario-fpoo--${CODIGO_ANA}.json`)), false, "sin estado: se reintenta");
    const otra = await correr("sys.exit(r.respaldar(False))", e.rutas);
    assert.match(otra.stdout, /1 entregas, 0 fallidas/);
  } finally {
    await storage.cerrar();
    rmSync(e.dir, { recursive: true, force: true });
  }
});

test("respaldo-ws.py: entrega la carpeta que evaluo avance-ws.py y no otra; un taller viejo del contrato se omite; el avance reusado va marcado", { skip: omitirEntregas }, async () => {
  const storage = await storageFalso();
  const e = entornoEntregas(storage.base);
  try {
    // La evaluada desaparecio (o se cambio por un enlace): sin entrega, aunque haya otra candidata.
    escribir(path.join(e.homes, "ws-ana", "sistema-bancario-fpoo", "main.cpp"), "int main() {}\n");
    symlinkSync(path.join(e.homes, "ws-ana", "sistema-bancario-fpoo"), path.join(e.homes, "ws-ana", "sistema-bancario-fpoo-2"));
    escribir(path.join(e.homes, "ws-beto", "sistema-bancario-fpoo", "main.cpp"), "int main() {}\n");
    e.contrato({
      ana: { codigo: CODIGO_ANA, avance: 5, compila: true, entrada: "sistema-bancario-fpoo-2" },
      beto: { codigo: CODIGO_BETO, avance: 30, compila: false, nota: "tiempo", medidoEn: "2026-11-02T10:00:00+00:00" },
    });
    const r = await correr("sys.exit(r.respaldar(False))", e.rutas);
    assert.equal(r.codigo, 0, r.stdout + r.stderr);
    const zips = storage.subidas.filter((s) => s.nombre.startsWith("entregas/") && s.nombre.endsWith(".zip"));
    assert.deepEqual(zips.map((s) => s.nombre.split("/")[2]), [CODIGO_BETO], "ana: su carpeta evaluada es un enlace, no se entrega ni se busca otra");
    const manifiesto = JSON.parse(storage.subidas.find((s) => s.nombre.endsWith(".json")).cuerpo.toString("utf8"));
    assert.equal(manifiesto.avanceAlDia, false, "con nota: el avance no es del codigo de ahora");
    assert.equal(manifiesto.avanceMedidoEn, "2026-11-02T10:00:00+00:00");

    // Un taller del contrato que no se renovo en 2 horas (su informe no llego) se omite.
    const viejo = new Date(Date.now() - 3 * 3600_000).toISOString();
    escribir(e.rutas.PARA_ENTREGAS, JSON.stringify({
      version: 1, generadoEn: new Date().toISOString(),
      talleres: [{ taller: "sistema-bancario-fpoo", titulo: "x", carpeta: "sistema-bancario-fpoo", generadoEn: viejo, estudiantes: { beto: { codigo: CODIGO_BETO, avance: 1, compila: null, entrada: "sistema-bancario-fpoo", medidoEn: null, nota: null } } }],
    }));
    const r2 = await correr("import time\nfrom datetime import datetime\nprint(json.dumps(r.validar_contrato(r.leer_json_sin_seguir(r.PARA_ENTREGAS, r.MAX_CONTRATO), time.time())))", e.rutas);
    assert.deepEqual(JSON.parse(r2.stdout), [[], 0, ""]);
  } finally {
    await storage.cerrar();
    rmSync(e.dir, { recursive: true, force: true });
  }
});

test("respaldo-ws.py: por_que_no_subir decide igual, mismo minuto, esperando o subir (puro)", { skip: omitir }, async () => {
  const r = await correr(`
from datetime import datetime
ahora = datetime(2026, 11, 2, 14, 30, tzinfo=r.BOGOTA)
def ctx(al_apagar=False):
    return r.ContextoEntregas(bucket="b", obtener_token=lambda: "t", espera=5, al_apagar=al_apagar, ahora=ahora, estado_dir="/x", plazo=0)
base = ctx().objeto_base("t", "${CODIGO_ANA}")
hace = lambda minutos: ahora.timestamp() - minutos * 60
casos = {
    "primera": r.por_que_no_subir({}, "m", base, ctx()),
    "igual": r.por_que_no_subir({"huella": "m", "subidoEn": 0}, "m", base, ctx()),
    "mismo-minuto": r.por_que_no_subir({"huella": "otra", "objeto": base + ".zip", "subidoEn": hace(90)}, "m", base, ctx(True)),
    "esperando": r.por_que_no_subir({"huella": "otra", "subidoEn": hace(59)}, "m", base, ctx()),
    "paso-la-hora": r.por_que_no_subir({"huella": "otra", "subidoEn": hace(61)}, "m", base, ctx()),
    "al-apagar": r.por_que_no_subir({"huella": "otra", "subidoEn": hace(1)}, "m", base, ctx(True)),
    "subido-raro": r.por_que_no_subir({"huella": "otra", "subidoEn": True}, "m", base, ctx()),
}
print(json.dumps({"base": base, "casos": casos}))
`, { HOMES: "/no-existe" });
  assert.equal(r.codigo, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(res.base, `entregas/t/${CODIGO_ANA}/2026-11-02_1430`);
  assert.deepEqual(res.casos, { primera: null, igual: "igual", "mismo-minuto": "mismo-minuto", esperando: "esperando", "paso-la-hora": null, "al-apagar": null, "subido-raro": null });
});

test("avance-ws.py -> respaldo-ws.py: el contrato que escribe el avance lo acepta la copia, tal cual (ida y vuelta)", { skip: omitir }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "adaceen-contrato-"));
  try {
    const contrato = path.join(dir, "avance", "para-entregas.json");
    mkdirSync(path.dirname(contrato), { recursive: true });
    const avance = path.resolve(AQUI, "..", "avance-ws.py");
    const codigo = `
import importlib.util, json, sys, time
sys.dont_write_bytecode = True
def cargar(nombre, ruta):
    spec = importlib.util.spec_from_file_location(nombre, ruta)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
a = cargar("avance", ${JSON.stringify(avance)})
r = cargar("respaldo", ${JSON.stringify(SCRIPT)})
a.PARA_ENTREGAS = r.PARA_ENTREGAS = ${JSON.stringify(contrato)}
taller = {"taller": "sistema-bancario-fpoo", "titulo": "Sistema bancario", "carpeta": "sistema-bancario-fpoo"}
estudiantes = [
    {"login": "ana", "started": True, "percent": 42, "compiles": True, "entrada": "sistema-bancario-fpoo-ana", "medidoEn": a.ahora_iso()},
    {"login": "beto", "started": True, "percent": 10, "compiles": None, "entrada": "sistema-bancario-fpoo", "medidoEn": a.ahora_iso(), "note": "pendiente"},
    {"login": "carla", "started": False, "percent": 0, "compiles": None, "entrada": None},
    {"login": "dani", "started": True, "percent": 5, "compiles": False, "entrada": "sistema-bancario-fpoo"},
]
a.escribir_para_entregas([a.para_entregas(taller, estudiantes, {"ana": "${CODIGO_ANA}", "beto": "${CODIGO_BETO}", "carla": "c3" * 10})])
print(json.dumps(r.validar_contrato(r.leer_json_sin_seguir(r.PARA_ENTREGAS, r.MAX_CONTRATO), time.time())))
print(r.CONTRATO_MAX_EDAD_S == a.CONTRATO_MAX_EDAD_S, r.PARA_ENTREGAS == a.PARA_ENTREGAS)
# Las mismas reglas en los dos scripts: lo que uno escribe el otro no lo rechaza por una diferencia.
print(json.dumps({n: getattr(r, n).pattern == getattr(a, n).pattern for n in ("LOGIN_RE", "TALLER_RE", "CARPETA_RE", "CODIGO_RE")}), r.NOTAS == a.NOTAS)
`;
    const salida = execFileSync(PYTHON, ["-c", codigo], { encoding: "utf8" }).trim().split("\n");
    const [talleres, omitidos, motivo] = JSON.parse(salida[0]);
    assert.equal(motivo, "");
    assert.equal(omitidos, 0, "lo que escribe el avance es todo valido");
    assert.equal(salida[2], '{"LOGIN_RE": true, "TALLER_RE": true, "CARPETA_RE": true, "CODIGO_RE": true} True');
    assert.equal(talleres.length, 1);
    assert.deepEqual(Object.keys(talleres[0].estudiantes), ["ana", "beto"], "carla sin carpeta y dani sin codigo no van");
    assert.deepEqual(talleres[0].estudiantes.ana, { codigo: CODIGO_ANA, avance: 42, compila: true, entrada: "sistema-bancario-fpoo-ana", medidoEn: talleres[0].estudiantes.ana.medidoEn, nota: null });
    assert.equal(talleres[0].estudiantes.beto.nota, "pendiente");
    assert.equal(salida[1], "True True", "mismo nombre de contrato y misma ventana en los dos scripts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
