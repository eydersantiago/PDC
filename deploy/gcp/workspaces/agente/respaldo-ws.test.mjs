// Pruebas de respaldo-ws.py (copia de respaldo de la VM de editores, 28-10-2026), sin Google
// Cloud: Storage, el servidor de metadata y el backend son un servidor HTTP local, y las rutas de
// la VM (/home, /etc, /var/lib) se cambian a una carpeta temporal.
//   node --test deploy/gcp/workspaces/agente/respaldo-ws.test.mjs
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
