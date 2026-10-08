// Pruebas de los scripts de la VM de editores que no necesitan la VM:
//   - instalar-vsix.sh contra un servidor HTTP local que imita
//     raw.githubusercontent.com y el /descargas/adaceen.vsix de PDC (sin red)
//   - tunel-comun.sh (entorno de cada tunel en /etc, migracion desde
//     ~/.adaceen/tunnel.env, plantilla de la unidad, homes 0700, cuando
//     reiniciar un tunel) con carpetas temporales en lugar de /home, /etc y
//     /opt, y systemctl falso
//   - el escritor "como el estudiante" de nuevo-tunel.sh
//   node --test deploy/gcp/workspaces/agente/*.test.mjs
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const CARPETA = path.resolve(AQUI, "..");
const INSTALAR_VSIX = path.join(CARPETA, "instalar-vsix.sh");
const TUNEL_COMUN = path.join(CARPETA, "tunel-comun.sh");
const NUEVO_TUNEL = path.join(CARPETA, "nuevo-tunel.sh");

function hay(comando) {
  try {
    execFileSync("sh", ["-c", `command -v ${comando}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const FALTAN = ["bash", "git", "curl", "unzip"].filter((comando) => !hay(comando));
const BASH_4 = hay("bash") && Number(execFileSync("bash", ["-c", "echo ${BASH_VERSINFO[0]}"]).toString().trim()) >= 4;
// `date -d` y `stat -c` de GNU (los de la VM, Debian); en Mac no estan.
const GNU = (() => {
  try {
    execFileSync("date", ["-d", "@0", "+%s"], { stdio: "ignore" });
    execFileSync("stat", ["-c", "%Y", "/"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// Corre un comando sin bloquear el event loop (el servidor de prueba vive en
// este mismo proceso) y devuelve {codigo, stdout, stderr}.
function correr(comando, argumentos, opciones = {}) {
  return new Promise((resolve) => {
    execFile(comando, argumentos, { timeout: 30000, ...opciones }, (error, stdout, stderr) => {
      resolve({ codigo: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function modo(ruta) {
  return lstatSync(ruta).mode & 0o777;
}

// --- zip minimo (sin compresion) para fabricar VSIX de prueba ---
const TABLA_CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = TABLA_CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zip(entradas) {
  const locales = [];
  const centrales = [];
  let desplazamiento = 0;
  for (const [nombre, texto] of Object.entries(entradas)) {
    const datos = Buffer.from(texto);
    const nombreBytes = Buffer.from(nombre);
    const crc = crc32(datos);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(datos.length, 18);
    local.writeUInt32LE(datos.length, 22);
    local.writeUInt16LE(nombreBytes.length, 26);
    locales.push(local, nombreBytes, datos);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(datos.length, 20);
    central.writeUInt32LE(datos.length, 24);
    central.writeUInt16LE(nombreBytes.length, 28);
    central.writeUInt32LE(desplazamiento, 42);
    centrales.push(central, nombreBytes);
    desplazamiento += local.length + nombreBytes.length + datos.length;
  }
  const directorio = Buffer.concat(centrales);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(Object.keys(entradas).length, 8);
  fin.writeUInt16LE(Object.keys(entradas).length, 10);
  fin.writeUInt32LE(directorio.length, 12);
  fin.writeUInt32LE(desplazamiento, 16);
  return Buffer.concat([...locales, directorio, fin]);
}
function vsix(nombre, version) {
  return zip({
    "extension.vsixmanifest": "<PackageManifest/>",
    "extension/package.json": JSON.stringify({ name: nombre, publisher: "adaceen", version }),
  });
}

// Repo git con el submodulo vscode-ext-prod fijado en `commit`.
function crearClonPdc(dir, { commit, url = "https://github.com/eydersantiago/vscode-ext-prod.git" }) {
  const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.name=p", "-c", "user.email=p@p", ...args], { stdio: "pipe" });
  mkdirSync(dir, { recursive: true });
  git("init", "-q");
  writeFileSync(path.join(dir, ".gitmodules"), `[submodule "vscode-ext-prod"]\n\tpath = vscode-ext-prod\n\turl = ${url}\n`);
  git("add", ".gitmodules");
  git("update-index", "--add", "--cacheinfo", `160000,${commit},vscode-ext-prod`);
  git("commit", "-q", "-m", "pdc");
}
function fijarCommit(dir, commit) {
  const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.name=p", "-c", "user.email=p@p", ...args], { stdio: "pipe" });
  git("update-index", "--cacheinfo", `160000,${commit},vscode-ext-prod`);
  git("commit", "-q", "-m", "sube el submodulo");
}

// Imita raw.githubusercontent.com: /<owner>/<repo>/<commit>/<archivo>.
async function servidorRaw(archivos) {
  const pedidos = [];
  const servidor = http.createServer((req, res) => {
    pedidos.push(req.url);
    const cuerpo = archivos[req.url];
    if (cuerpo === undefined) {
      res.writeHead(404).end("404: Not Found");
      return;
    }
    res.writeHead(200).end(cuerpo);
  });
  await new Promise((resolve) => servidor.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${servidor.address().port}`,
    pedidos,
    cerrar: () => new Promise((resolve) => servidor.close(resolve)),
  };
}

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const COMMIT_C = "c".repeat(40);
const RAIZ = "/eydersantiago/vscode-ext-prod";

test("instalar-vsix.sh: baja el VSIX de la version fijada, lo comprueba y conserva el anterior si algo falla", { skip: FALTAN.length ? `faltan ${FALTAN.join(", ")}` : false }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vsix-"));
  const vsix31 = vsix("adaceen", "0.0.31");
  const raw = await servidorRaw({
    [`${RAIZ}/${COMMIT_A}/package.json`]: JSON.stringify({ name: "adaceen", version: "0.0.31" }),
    [`${RAIZ}/${COMMIT_A}/adaceen-0.0.31.vsix`]: vsix31,
    // B: package.json dice 0.0.32 pero el VSIX con ese nombre trae otra version.
    [`${RAIZ}/${COMMIT_B}/package.json`]: JSON.stringify({ name: "adaceen", version: "0.0.32" }),
    [`${RAIZ}/${COMMIT_B}/adaceen-0.0.32.vsix`]: vsix("adaceen", "0.0.30"),
    // C: la version no tiene VSIX empaquetado (404).
    [`${RAIZ}/${COMMIT_C}/package.json`]: JSON.stringify({ name: "adaceen", version: "0.0.33" }),
  });
  try {
    const clon = path.join(dir, "repo");
    const destino = path.join(dir, "opt", "adaceen.vsix");
    mkdirSync(path.dirname(destino));
    crearClonPdc(clon, { commit: COMMIT_A });
    const env = { ...process.env, ADACEEN_VSIX_RAW_BASE: raw.base };
    const instalar = () => correr("bash", [INSTALAR_VSIX, clon, destino], { env });

    const primera = await instalar();
    assert.equal(primera.codigo, 0, primera.stderr);
    assert.match(primera.stdout, /adaceen 0\.0\.31 instalado/);
    assert.deepEqual(readFileSync(destino), vsix31);
    assert.equal(modo(destino), 0o644);
    assert.equal(readFileSync(`${destino}.commit`, "utf8").trim(), COMMIT_A);
    assert.deepEqual(readdirSync(path.dirname(destino)).sort(), ["adaceen.vsix", "adaceen.vsix.commit"]);

    // Mismo commit: no toca la red.
    const pedidosAntes = raw.pedidos.length;
    const segunda = await instalar();
    assert.equal(segunda.codigo, 0, segunda.stderr);
    assert.match(segunda.stdout, /0\.0\.31 ya instalado/);
    assert.equal(raw.pedidos.length, pedidosAntes);

    // VSIX con otra version adentro: falla y deja el anterior.
    fijarCommit(clon, COMMIT_B);
    const mentira = await instalar();
    assert.equal(mentira.codigo, 1);
    assert.match(mentira.stderr, /AVISO VSIX: adaceen-0\.0\.32\.vsix no es un VSIX de esa version/);
    assert.match(mentira.stderr, /Se conserva el VSIX anterior \(0\.0\.31\)/);
    assert.deepEqual(readFileSync(destino), vsix31);
    assert.equal(readFileSync(`${destino}.commit`, "utf8").trim(), COMMIT_A);

    // Version sin VSIX publicado: falla y deja el anterior.
    fijarCommit(clon, COMMIT_C);
    const sinVsix = await instalar();
    assert.equal(sinVsix.codigo, 1);
    assert.match(sinVsix.stderr, /no esta adaceen-0\.0\.33\.vsix/);
    // El aviso dice de donde sale (el despliegue de PDC) y el respaldo: subirlo
    // al commit con git add -f, porque el .gitignore de vscode-ext-prod ignora *.vsix.
    assert.match(sinVsix.stderr, /despliegue de PDC en \/descargas\/adaceen\.vsix.*git add -f/);
    assert.deepEqual(readFileSync(destino), vsix31);

    // Commit que GitHub no tiene (p. ej. submodulo sin empujar).
    fijarCommit(clon, "d".repeat(40));
    const sinCommit = await instalar();
    assert.equal(sinCommit.codigo, 1);
    assert.match(sinCommit.stderr, /no se pudo bajar package\.json/);
    assert.deepEqual(readFileSync(destino), vsix31);

    // Solo https (o el servidor local de las pruebas).
    const inseguro = await correr("bash", [INSTALAR_VSIX, clon, destino], { env: { ...env, ADACEEN_VSIX_RAW_BASE: "http://evil.example" } });
    assert.equal(inseguro.codigo, 1);

    // Submodulo que no es de GitHub, o clon sin submodulo.
    const otroClon = path.join(dir, "otro");
    crearClonPdc(otroClon, { commit: COMMIT_A, url: "https://gitlab.example/x/y.git" });
    const noGithub = await correr("bash", [INSTALAR_VSIX, otroClon, destino], { env });
    assert.equal(noGithub.codigo, 1);
    assert.match(noGithub.stderr, /no apunta a un repo de GitHub/);
    const vacio = path.join(dir, "vacio");
    mkdirSync(vacio);
    const sinSubmodulo = await correr("bash", [INSTALAR_VSIX, vacio, destino], { env });
    assert.equal(sinSubmodulo.codigo, 1);
    assert.match(sinSubmodulo.stderr, /no fija el submodulo/);
    assert.deepEqual(readFileSync(destino), vsix31);
  } finally {
    await raw.cerrar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("instalar-vsix.sh: con otro commit baja aunque la version sea la misma; el VSIX sale de PDC y, si PDC no responde o sirve otra version, del commit en GitHub", { skip: FALTAN.length ? `faltan ${FALTAN.join(", ")}` : false }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vsix-"));
  const COMMIT_E = "e".repeat(40);
  const COMMIT_F = "f".repeat(40);
  const COMMIT_1 = "1".repeat(40);
  const COMMIT_2 = "2".repeat(40);
  const COMMIT_3 = "3".repeat(40);
  const COMMIT_4 = "4".repeat(40);
  const primero = vsix("adaceen", "0.0.31");
  // Reempaquetado con la misma version (el contrato fija 0.0.31): otro contenido.
  const corregido = zip({
    "extension.vsixmanifest": "<PackageManifest/>",
    "extension/package.json": JSON.stringify({ name: "adaceen", publisher: "adaceen", version: "0.0.31" }),
    "extension/out/arreglo.js": "// corregido",
  });
  // La 0.0.33 como la empaqueta el despliegue de PDC y como la subio alguien al
  // commit con git add -f: misma version, otro archivo.
  const dePdc33 = vsix("adaceen", "0.0.33");
  const deGithub33 = zip({
    "extension.vsixmanifest": "<PackageManifest/>",
    "extension/package.json": JSON.stringify({ name: "adaceen", publisher: "adaceen", version: "0.0.33" }),
    "extension/out/a-mano.js": "// empaquetado a mano",
  });
  const paquete = (version) => JSON.stringify({ name: "adaceen", version });
  const raw = await servidorRaw({
    [`${RAIZ}/${COMMIT_A}/package.json`]: paquete("0.0.31"),
    [`${RAIZ}/${COMMIT_A}/adaceen-0.0.31.vsix`]: primero,
    [`${RAIZ}/${COMMIT_E}/package.json`]: paquete("0.0.31"),
    [`${RAIZ}/${COMMIT_E}/adaceen-0.0.31.vsix`]: corregido,
    // F: otro commit con el mismo archivo (p. ej. solo cambio el README).
    [`${RAIZ}/${COMMIT_F}/package.json`]: paquete("0.0.31"),
    [`${RAIZ}/${COMMIT_F}/adaceen-0.0.31.vsix`]: corregido,
    // 1 y 2: el VSIX no se subio al commit (*.vsix ignorado, sin git add -f): lo normal.
    [`${RAIZ}/${COMMIT_1}/package.json`]: paquete("0.0.32"),
    [`${RAIZ}/${COMMIT_2}/package.json`]: paquete("0.0.33"),
    // 3 y 4: el commit si trae su VSIX (git add -f, el respaldo).
    [`${RAIZ}/${COMMIT_3}/package.json`]: paquete("0.0.33"),
    [`${RAIZ}/${COMMIT_3}/adaceen-0.0.33.vsix`]: deGithub33,
    [`${RAIZ}/${COMMIT_4}/package.json`]: paquete("0.0.33"),
    [`${RAIZ}/${COMMIT_4}/adaceen-0.0.33.vsix`]: deGithub33,
  });
  // PDC sirve /descargas/adaceen.vsix (lo empaqueta el workflow de despliegue);
  // de entrada, la 0.0.32.
  const descargasPdc = { "/descargas/adaceen.vsix": vsix("adaceen", "0.0.32") };
  const pdc = await servidorRaw(descargasPdc);
  // Un PDC sin el VSIX (404): el backend viejo, o caido.
  const pdcSinVsix = await servidorRaw({});
  const pedidosVsix = (servidor, commit) => servidor.pedidos.filter((pedido) => pedido === `${RAIZ}/${commit}/adaceen-0.0.33.vsix`).length;
  try {
    const clon = path.join(dir, "repo");
    const destino = path.join(dir, "opt", "adaceen.vsix");
    mkdirSync(path.dirname(destino));
    crearClonPdc(clon, { commit: COMMIT_A });
    const env = { ...process.env, ADACEEN_VSIX_RAW_BASE: raw.base };
    const instalar = (...extra) => correr("bash", [INSTALAR_VSIX, clon, destino, ...extra], { env });

    assert.equal((await instalar()).codigo, 0);
    assert.deepEqual(readFileSync(destino), primero);

    // Mismo nombre y version, commit nuevo con otro archivo: se reemplaza.
    fijarCommit(clon, COMMIT_E);
    const reempaquetado = await instalar();
    assert.equal(reempaquetado.codigo, 0, reempaquetado.stderr);
    assert.match(reempaquetado.stdout, /adaceen 0\.0\.31 instalado/);
    assert.deepEqual(readFileSync(destino), corregido);
    assert.equal(readFileSync(`${destino}.commit`, "utf8").trim(), COMMIT_E);

    // Commit nuevo con el mismo archivo: no se toca (los tuneles no se reinician).
    fijarCommit(clon, COMMIT_F);
    const igual = await instalar();
    assert.equal(igual.codigo, 0, igual.stderr);
    assert.match(igual.stdout, /0\.0\.31 ya instalado \(mismo archivo/);
    assert.deepEqual(readFileSync(destino), corregido);
    assert.equal(readFileSync(`${destino}.commit`, "utf8").trim(), COMMIT_F);

    // Con url de PDC, el VSIX sale de PDC (es la version del commit, aunque el
    // commit no lo traiga), sin aviso, sin pedirselo a GitHub y guardando el commit.
    fijarCommit(clon, COMMIT_1);
    const dePdc = await instalar(`${pdc.base}/`);
    assert.equal(dePdc.codigo, 0, dePdc.stderr);
    assert.doesNotMatch(dePdc.stderr, /AVISO/);
    assert.match(dePdc.stdout, /adaceen 0\.0\.32 instalado .*\(PDC http:\/\/127\.0\.0\.1:\d+\/descargas\/adaceen\.vsix\)/);
    assert.deepEqual(readFileSync(destino), vsix("adaceen", "0.0.32"));
    assert.equal(readFileSync(`${destino}.commit`, "utf8").trim(), COMMIT_1);
    assert.deepEqual(pdc.pedidos, ["/descargas/adaceen.vsix"]);
    assert.ok(!raw.pedidos.includes(`${RAIZ}/${COMMIT_1}/adaceen-0.0.32.vsix`), "con el de PDC no se busca el VSIX en GitHub");
    // Siguiente arranque con el mismo commit: no toca la red (ni PDC ni GitHub).
    const pedidosRaw = raw.pedidos.length;
    const otraVez = await instalar(pdc.base);
    assert.equal(otraVez.codigo, 0, otraVez.stderr);
    assert.match(otraVez.stdout, /0\.0\.32 ya instalado \(vscode-ext-prod 111111111111\)/);
    assert.equal(raw.pedidos.length, pedidosRaw);
    assert.deepEqual(pdc.pedidos, ["/descargas/adaceen.vsix"]);

    // El push fija la 0.0.33 pero PDC todavia sirve la 0.0.32 (el despliegue no
    // termino) y el commit no trae el VSIX: queda el anterior, y el aviso dice las
    // dos cosas y el respaldo (git add -f).
    fijarCommit(clon, COMMIT_2);
    const sinDesplegar = await instalar(pdc.base);
    assert.equal(sinDesplegar.codigo, 1);
    assert.match(sinDesplegar.stderr, /AVISO VSIX: PDC sirve 'adaceen 0\.0\.32', no adaceen 0\.0\.33 \(¿el push aun no se desplego\?\), y no esta adaceen-0\.0\.33\.vsix en eydersantiago\/vscode-ext-prod en 222222222222 \(.*git add -f.*\)\. Se conserva el VSIX anterior \(0\.0\.32\)/);
    assert.deepEqual(readFileSync(destino), vsix("adaceen", "0.0.32"));
    assert.equal(readFileSync(`${destino}.commit`, "utf8").trim(), COMMIT_1);
    assert.deepEqual(readdirSync(path.dirname(destino)).sort(), ["adaceen.vsix", "adaceen.vsix.commit"], "sin temporales");

    // Mismo caso, pero el commit trae su VSIX (git add -f): es el respaldo mientras
    // PDC sirve otra version. Aviso, y el commit queda guardado.
    fijarCommit(clon, COMMIT_3);
    const respaldo = await instalar(pdc.base);
    assert.equal(respaldo.codigo, 0, respaldo.stderr);
    assert.match(respaldo.stderr, /^--- AVISO VSIX: PDC sirve 'adaceen 0\.0\.32', no adaceen 0\.0\.33 \(¿el push aun no se desplego\?\)\. Se usa adaceen-0\.0\.33\.vsix del commit en GitHub\.$/m);
    assert.match(respaldo.stdout, /adaceen 0\.0\.33 instalado .*\(vscode-ext-prod 333333333333\)/);
    assert.deepEqual(readFileSync(destino), deGithub33);
    assert.equal(readFileSync(`${destino}.commit`, "utf8").trim(), COMMIT_3);

    // PDC no responde (404): el mismo respaldo, con el motivo en el aviso.
    fijarCommit(clon, COMMIT_4);
    const pdcCaido = await instalar(pdcSinVsix.base);
    assert.equal(pdcCaido.codigo, 0, pdcCaido.stderr);
    assert.match(pdcCaido.stderr, /AVISO VSIX: PDC no respondio \(http:\/\/127\.0\.0\.1:\d+\/descargas\/adaceen\.vsix\)\. Se usa adaceen-0\.0\.33\.vsix del commit en GitHub/);
    assert.match(pdcCaido.stdout, /0\.0\.33 ya instalado \(mismo archivo; vscode-ext-prod 444444444444\)/);
    assert.equal(readFileSync(`${destino}.commit`, "utf8").trim(), COMMIT_4);
    assert.deepEqual(pdcSinVsix.pedidos, ["/descargas/adaceen.vsix"]);

    // Ya desplegado: PDC sirve la 0.0.33. Con un commit nuevo gana el de PDC aunque el
    // commit traiga el suyo (misma version, otro archivo) y no se le pide a GitHub.
    descargasPdc["/descargas/adaceen.vsix"] = dePdc33;
    fijarCommit(clon, COMMIT_3);
    const desplegado = await instalar(pdc.base);
    assert.equal(desplegado.codigo, 0, desplegado.stderr);
    assert.doesNotMatch(desplegado.stderr, /AVISO/);
    assert.match(desplegado.stdout, /adaceen 0\.0\.33 instalado .*\(PDC http:\/\/127\.0\.0\.1:\d+\/descargas\/adaceen\.vsix\)/);
    assert.deepEqual(readFileSync(destino), dePdc33);
    assert.equal(readFileSync(`${destino}.commit`, "utf8").trim(), COMMIT_3);
    assert.equal(pedidosVsix(raw, COMMIT_3), 1, "el VSIX del commit 3 solo se pidio a GitHub cuando PDC servia otra version");

    // Una url de PDC que no es https se ignora (y sin PDC, el commit sin VSIX falla como antes).
    fijarCommit(clon, COMMIT_2);
    const pedidosPdc = pdc.pedidos.length;
    const inseguro = await instalar("http://evil.example");
    assert.equal(inseguro.codigo, 1);
    assert.match(inseguro.stderr, /no es https; no se usa PDC/);
    assert.match(inseguro.stderr, /AVISO VSIX: no esta adaceen-0\.0\.33\.vsix/);
    assert.equal(pdc.pedidos.length, pedidosPdc);
    assert.deepEqual(readFileSync(destino), dePdc33);
    assert.deepEqual(readdirSync(path.dirname(destino)).sort(), ["adaceen.vsix", "adaceen.vsix.commit"], "sin temporales");
  } finally {
    await raw.cerrar();
    await pdc.cerrar();
    await pdcSinVsix.cerrar();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Corre funciones de tunel-comun.sh con rutas temporales y systemctl falso.
function correrTunelComun(rutas, guion) {
  return correr("bash", ["-c", `set -euo pipefail
source "$TUNEL_COMUN"
systemctl() { echo "systemctl $*" >> "$LOG_SYSTEMCTL"; }
${guion}`], {
    env: {
      ...process.env,
      TUNEL_COMUN,
      ADACEEN_VSIX: rutas.vsix,
      DIR_HOMES: rutas.homes,
      DIR_ENTORNOS_TUNEL: rutas.entornos,
      UNIDAD_TUNEL: rutas.unidad,
      LOG_SYSTEMCTL: rutas.log,
    },
  });
}

function leerEntorno(ruta) {
  return Object.fromEntries(
    readFileSync(ruta, "utf8").trim().split("\n").map((linea) => [linea.slice(0, linea.indexOf("=")), linea.slice(linea.indexOf("=") + 1)]),
  );
}

test("tunel-comun.sh: entorno de root en /etc, migracion desde ~/.adaceen/tunnel.env y plantilla sin secretos", { skip: FALTAN.includes("bash") ? "falta bash" : false }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tunel-comun-"));
  try {
    const rutas = {
      homes: path.join(dir, "home"),
      entornos: path.join(dir, "etc", "adaceen-tunnels"),
      unidad: path.join(dir, "etc", "adaceen-tunnel@.service"),
      vsix: path.join(dir, "opt", "adaceen.vsix"),
      log: path.join(dir, "systemctl.log"),
    };
    mkdirSync(path.join(dir, "etc"), { recursive: true });
    mkdirSync(path.join(dir, "opt"));
    // ana: repo Java, tunel preparado con la version nueva (sin entorno aun).
    mkdirSync(path.join(rutas.homes, "ws-ana", "proyecto", "src"), { recursive: true });
    writeFileSync(path.join(rutas.homes, "ws-ana", "proyecto", "src", "A.java"), "class A {}");
    writeFileSync(path.join(rutas.homes, "ws-ana", "proyecto", "src", "B.java"), "class B {}");
    // vieja: tunel de antes de este cambio (entorno en su home).
    mkdirSync(path.join(rutas.homes, "ws-vieja", ".adaceen"), { recursive: true });
    writeFileSync(path.join(rutas.homes, "ws-vieja", ".adaceen", "tunnel.env"), "TUNEL=ad-vieja\nADACEEN_EXT=adaceen.adaceen\n");
    // trampa: su tunnel.env es un enlace a un secreto de root; root no lo lee.
    const secreto = path.join(dir, "etc", "adaceen-workspaces-agent.env");
    writeFileSync(secreto, "AGENT_TOKEN=secreto-que-no-debe-salir\n");
    mkdirSync(path.join(rutas.homes, "ws-trampa", ".adaceen"), { recursive: true });
    symlinkSync(secreto, path.join(rutas.homes, "ws-trampa", ".adaceen", "tunnel.env"));
    // sin tunel: no se toca.
    mkdirSync(path.join(rutas.homes, "ws-sin"), { recursive: true });

    const primera = await correrTunelComun(rutas, `
instalar_unidad_tunel
echo "unidad=$UNIDAD_TUNEL_CAMBIO"
escribir_entorno_tunel ana
echo "entorno=$ENTORNO_TUNEL_CAMBIO ext=$EXT_LENGUAJE_TUNEL"
escribir_entorno_tunel ana
echo "entorno2=$ENTORNO_TUNEL_CAMBIO"
instalar_unidad_tunel
echo "unidad2=$UNIDAD_TUNEL_CAMBIO"
echo "logins=$(logins_con_tunel | tr '\\n' ' ')"
if escribir_entorno_tunel 'Mal;login'; then echo "malo=aceptado"; else echo "malo=rechazado"; fi
nombre_tunel "un-login-muy-largo-de-github-28"
`);
    assert.equal(primera.codigo, 0, primera.stderr);
    assert.match(primera.stdout, /^unidad=1$/m);
    assert.match(primera.stdout, /^entorno=1 /m);
    assert.match(primera.stdout, /^entorno2=0$/m, "sin cambios no hay que reiniciar");
    assert.match(primera.stdout, /^unidad2=0$/m);
    assert.match(primera.stdout, /^logins=ana trampa vieja $/m);
    assert.match(primera.stdout, /^malo=rechazado$/m);
    assert.match(primera.stdout, /^ad-un-login-muy-larg$/m, "Dev Tunnels: maximo 20 caracteres");
    assert.equal(readFileSync(rutas.log, "utf8"), "systemctl daemon-reload\n", "daemon-reload solo cuando la plantilla cambia");

    // Plantilla: entorno de root, nada de /etc/adaceen-ws.env ni del home, despues del bloqueo de metadata.
    const unidad = readFileSync(rutas.unidad, "utf8");
    assert.match(unidad, /^EnvironmentFile=\/etc\/adaceen-tunnels\/%i\.env$/m);
    assert.match(unidad, /^EnvironmentFile=-\/etc\/adaceen-ws-tunel\.env$/m);
    assert.doesNotMatch(unidad, /^EnvironmentFile=\/etc\/adaceen-ws\.env$/m);
    assert.doesNotMatch(unidad, /^EnvironmentFile=.*\/home\//m);
    assert.match(unidad, /^After=network-online\.target adaceen-ws-metadata\.service$/m);
    assert.match(unidad, /^Wants=network-online\.target adaceen-ws-metadata\.service$/m);
    assert.match(unidad, /^User=%i$/m);
    assert.equal(modo(rutas.unidad), 0o644);

    // Entornos: carpeta 0700, archivos 0600 de root, con lo que usa ExecStart.
    assert.equal(modo(rutas.entornos), 0o700);
    assert.deepEqual(readdirSync(rutas.entornos).sort(), ["ws-ana.env", "ws-trampa.env", "ws-vieja.env"]);
    const ana = leerEntorno(path.join(rutas.entornos, "ws-ana.env"));
    assert.equal(modo(path.join(rutas.entornos, "ws-ana.env")), 0o600);
    assert.equal(ana.TUNEL, "ad-ana");
    assert.equal(ana.ADACEEN_EXT, "adaceen.adaceen", "sin VSIX, la del Marketplace");
    if (BASH_4) assert.equal(ana.LANG_EXT_ARGS, "--install-extension vscjava.vscode-java-pack");
    assert.deepEqual(leerEntorno(path.join(rutas.entornos, "ws-vieja.env")), { TUNEL: "ad-vieja", ADACEEN_EXT: "adaceen.adaceen", LANG_EXT_ARGS: "" });
    assert.equal(readFileSync(path.join(rutas.entornos, "ws-trampa.env"), "utf8").includes("secreto"), false);
    assert.equal(existsSync(path.join(rutas.homes, "ws-sin", ".adaceen")), false);

    // Con VSIX en /opt/adaceen: el entorno cambia (hay que reiniciar) y apunta al VSIX.
    writeFileSync(rutas.vsix, vsix("adaceen", "0.0.31"));
    const conVsix = await correrTunelComun(rutas, `
escribir_entorno_tunel vieja
echo "entorno=$ENTORNO_TUNEL_CAMBIO"
`);
    assert.equal(conVsix.codigo, 0, conVsix.stderr);
    assert.match(conVsix.stdout, /^entorno=1$/m);
    assert.equal(leerEntorno(path.join(rutas.entornos, "ws-vieja.env")).ADACEEN_EXT, rutas.vsix);
    assert.deepEqual(readdirSync(rutas.entornos).sort(), ["ws-ana.env", "ws-trampa.env", "ws-vieja.env"], "sin temporales");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// El bloque ESCRIBIR_EN_HOME de nuevo-tunel.sh, tal cual (corre como el estudiante).
function escritorDeNuevoTunel() {
  const texto = readFileSync(NUEVO_TUNEL, "utf8");
  const coincidencia = texto.match(/^ESCRIBIR_EN_HOME='([\s\S]*?)'$/m);
  assert.ok(coincidencia, "nuevo-tunel.sh define ESCRIBIR_EN_HOME");
  return coincidencia[1];
}

test("nuevo-tunel.sh: el escritor del home deja carpeta 0700, archivo con su modo y reemplaza enlaces sin seguirlos", { skip: FALTAN.includes("bash") ? "falta bash" : false }, async () => {
  const escritor = escritorDeNuevoTunel();
  const home = mkdtempSync(path.join(tmpdir(), "home-estudiante-"));
  try {
    const escribir = (ruta, modoArchivo, contenido) => new Promise((resolve) => {
      const hijo = execFile("bash", ["-c", escritor, "escribir-en-home", ruta, modoArchivo], { env: { ...process.env, HOME: home } }, (error, stdout, stderr) => {
        resolve({ codigo: error ? error.code : 0, stderr: String(stderr) });
      });
      hijo.stdin.end(contenido);
    });

    const sesion = await escribir(".adaceen/editor-session.json", "600", "{\"version\":1}\n");
    assert.equal(sesion.codigo, 0, sesion.stderr);
    assert.equal(readFileSync(path.join(home, ".adaceen", "editor-session.json"), "utf8"), "{\"version\":1}\n");
    assert.equal(modo(path.join(home, ".adaceen")), 0o700);
    assert.equal(modo(path.join(home, ".adaceen", "editor-session.json")), 0o600);

    const ajustes = await escribir(".vscode-server/data/Machine/settings.json", "644", "{}\n");
    assert.equal(ajustes.codigo, 0, ajustes.stderr);
    assert.equal(modo(path.join(home, ".vscode-server", "data", "Machine", "settings.json")), 0o644);

    // Un enlace en el destino se reemplaza (mv), no se escribe a traves de el.
    const otro = path.join(home, "otro-archivo");
    writeFileSync(otro, "intacto");
    rmSync(path.join(home, ".adaceen", "editor-session.json"));
    symlinkSync(otro, path.join(home, ".adaceen", "editor-session.json"));
    const reemplazo = await escribir(".adaceen/editor-session.json", "600", "nuevo\n");
    assert.equal(reemplazo.codigo, 0, reemplazo.stderr);
    assert.equal(readFileSync(otro, "utf8"), "intacto");
    assert.equal(lstatSync(path.join(home, ".adaceen", "editor-session.json")).isSymbolicLink(), false);
    assert.deepEqual(readdirSync(path.join(home, ".adaceen")), ["editor-session.json"], "sin temporales");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("tunel-comun.sh: homes de los estudiantes 0700 sin seguir enlaces", { skip: FALTAN.includes("bash") ? "falta bash" : false }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "homes-"));
  try {
    const homes = path.join(dir, "home");
    const afuera = path.join(dir, "afuera");
    for (const carpeta of ["ws-ana", "ws-bob", "ws-Mal", "otro"]) mkdirSync(path.join(homes, carpeta), { recursive: true });
    mkdirSync(afuera);
    for (const carpeta of ["ws-ana", "ws-bob", "ws-Mal", "otro"]) chmodSync(path.join(homes, carpeta), 0o755);
    chmodSync(afuera, 0o755);
    symlinkSync(afuera, path.join(homes, "ws-enlace"));
    const rutas = { homes, entornos: path.join(dir, "etc"), unidad: path.join(dir, "unidad"), vsix: path.join(dir, "vsix"), log: path.join(dir, "log") };
    const resultado = await correrTunelComun(rutas, `
cerrar_homes_estudiantes
cerrar_homes_estudiantes
cerrar_home_estudiante no-existe
echo fin
`);
    assert.equal(resultado.codigo, 0, resultado.stderr);
    assert.match(resultado.stdout, /^fin$/m);
    assert.equal(modo(path.join(homes, "ws-ana")), 0o700);
    assert.equal(modo(path.join(homes, "ws-bob")), 0o700);
    assert.equal(modo(path.join(homes, "ws-Mal")), 0o755, "login que no acepta nuevo-tunel.sh: no se toca");
    assert.equal(modo(path.join(homes, "otro")), 0o755, "solo ws-*");
    assert.equal(modo(afuera), 0o755, "un enlace no se sigue");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tunel-comun.sh: tunel_desactualizado compara la hora de arranque de la unidad con la de sus archivos", { skip: FALTAN.includes("bash") ? "falta bash" : !GNU ? "sin date -d / stat -c de GNU" : false }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "desactualizado-"));
  try {
    const rutas = { homes: path.join(dir, "home"), entornos: path.join(dir, "etc"), unidad: path.join(dir, "unidad"), vsix: path.join(dir, "vsix"), log: path.join(dir, "log") };
    const plantilla = path.join(dir, "plantilla");
    const entorno = path.join(dir, "entorno");
    const vsixNuevo = path.join(dir, "nuevo.vsix");
    for (const archivo of [plantilla, entorno, vsixNuevo]) writeFileSync(archivo, "x");
    // La unidad arranco el 24-09 a las 10:00 UTC.
    const antes = new Date("2026-09-24T09:00:00Z");
    const despues = new Date("2026-09-24T11:00:00Z");
    utimesSync(plantilla, antes, antes);
    utimesSync(entorno, antes, antes);
    utimesSync(vsixNuevo, despues, despues);
    const resultado = await correrTunelComun(rutas, `
systemctl() {
  echo "TZ=\${TZ:-} $*" >> "$LOG_SYSTEMCTL"
  case "$5" in
    u-arriba) echo "Thu 2026-09-24 10:00:00 UTC" ;;
    u-nunca) echo "" ;;
    u-rara) echo "n/a" ;;
    *) return 1 ;;
  esac
}
si() { if tunel_desactualizado "$@"; then echo "si"; else echo "no"; fi; }
echo "viejos=$(si u-arriba "$PLANTILLA" "$ENTORNO")"
echo "vsix=$(si u-arriba "$PLANTILLA" "$ENTORNO" /no/existe "$VSIX_NUEVO")"
echo "faltan=$(si u-arriba /no/existe)"
echo "nunca=$(si u-nunca "$VSIX_NUEVO")"
echo "rara=$(si u-rara "$VSIX_NUEVO")"
echo "falla=$(si u-otra "$VSIX_NUEVO")"
`.replaceAll("$PLANTILLA", plantilla).replaceAll("$ENTORNO", entorno).replaceAll("$VSIX_NUEVO", vsixNuevo));
    assert.equal(resultado.codigo, 0, resultado.stderr);
    assert.match(resultado.stdout, /^viejos=no$/m, "archivos anteriores al arranque: no se reinicia");
    assert.match(resultado.stdout, /^vsix=si$/m, "VSIX cambiado despues de arrancar: se reinicia");
    assert.match(resultado.stdout, /^faltan=no$/m);
    assert.match(resultado.stdout, /^nunca=no$/m, "sin hora de arranque no se reinicia");
    assert.match(resultado.stdout, /^rara=no$/m);
    assert.match(resultado.stdout, /^falla=no$/m);
    // systemctl se consulta en UTC (la fecha la formatea el cliente).
    assert.match(readFileSync(rutas.log, "utf8"), /^TZ=UTC show -p ActiveEnterTimestamp --value u-arriba$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- spike-serve-web.sh (docs/workspaces-serve-web.md) ---
// Se carga con `source` y se llama a main con rutas temporales; systemctl,
// useradd, userdel, getent y sudo son funciones falsas (sudo corre el comando
// como el usuario de la prueba, con el HOME que le pasa el script).
const SPIKE_SERVE_WEB = path.join(CARPETA, "spike-serve-web.sh");

function correrSpikeWeb(rutas, guion, extra = {}) {
  return correr("bash", ["-c", `set -euo pipefail
source "$SPIKE_SERVE_WEB"
systemctl() {
  echo "systemctl $*" >> "$LOG_SYSTEMCTL"
  case "$1" in is-active | is-enabled) return 1 ;; show) echo "" ;; esac
}
useradd() { mkdir -p "$DIR_HOMES/\${!#}"; }
userdel() { rm -rf "$DIR_HOMES/\${!#}"; }
getent() { [ -d "$DIR_HOMES/$2" ]; }
sudo() { shift 3; "$@"; }
exigir_root() { :; }
${guion}`], {
    env: {
      ...process.env,
      SPIKE_SERVE_WEB,
      ADACEEN_VSIX: rutas.vsix,
      ADACEEN_WS_ENV: path.join(rutas.homes, "no-existe.env"),
      DIR_HOMES: rutas.homes,
      DIR_WEB: rutas.web,
      DIR_ENTORNOS_TUNEL: rutas.entornos,
      UNIDAD_WEB: rutas.unidad,
      CODE_BIN: "/bin/true",
      ESPERA_SERVIDOR_S: "0",
      LOG_SYSTEMCTL: rutas.log,
      LOG_INSTALL: rutas.instalaciones,
      ...extra,
    },
  });
}

function crearRepoOrigen(dir) {
  const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.name=p", "-c", "user.email=p@p", ...args], { stdio: "pipe" });
  mkdirSync(path.join(dir, "src"), { recursive: true });
  // Dos archivos: detectar-lenguajes.sh pide al menos dos por lenguaje.
  writeFileSync(path.join(dir, "src", "Main.java"), "class Main {}");
  writeFileSync(path.join(dir, "src", "Util.java"), "class Util {}");
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "origen");
}

// 20000 + CRC(login) mod 10000, el mismo calculo que el script (cksum).
function puertoEsperado(login) {
  const crc = Number(execFileSync("bash", ["-c", `printf '%s' "$1" | cksum | cut -d' ' -f1`, "-", login]).toString().trim());
  return 20000 + (crc % 10000);
}

function escaparRegExp(texto) {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("spike-serve-web.sh: token de root fuera de la linea de comandos, puerto estable por login, plantilla sin secretos y quitar", { skip: FALTAN.length ? `faltan ${FALTAN.join(", ")}` : false }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "serve-web-"));
  try {
    const rutas = {
      homes: path.join(dir, "home"),
      web: path.join(dir, "etc", "adaceen-web"),
      entornos: path.join(dir, "etc", "adaceen-tunnels"),
      unidad: path.join(dir, "etc", "adaceen-web@.service"),
      vsix: path.join(dir, "opt", "adaceen.vsix"),
      log: path.join(dir, "systemctl.log"),
      instalaciones: path.join(dir, "instalaciones.log"),
    };
    mkdirSync(path.join(dir, "etc"), { recursive: true });
    mkdirSync(path.join(dir, "opt"));
    mkdirSync(rutas.homes);
    const origen = path.join(dir, "origen");
    crearRepoOrigen(origen);

    // Primera preparacion: usuario, clon, token, puerto, plantilla, servicio.
    const primera = await correrSpikeWeb(rutas, `main ana "${origen}"`);
    assert.equal(primera.codigo, 0, primera.stderr);
    const puerto = puertoEsperado("ana");
    assert.match(primera.stdout, new RegExp(`^--- puerto ${puerto} para ws-ana, token nuevo`, "m"));
    const token = readFileSync(path.join(rutas.web, "ws-ana.token"), "utf8");
    assert.match(token, /^[0-9a-f]{64}\n$/, "64 hex de openssl rand");
    assert.equal(modo(path.join(rutas.web, "ws-ana.token")), 0o600);
    assert.equal(modo(rutas.web), 0o700);
    assert.deepEqual(leerEntorno(path.join(rutas.web, "ws-ana.env")), { PUERTO: String(puerto), HOST_WEB: "127.0.0.1" });
    assert.equal(modo(path.join(rutas.web, "ws-ana.env")), 0o600);
    // Sin --mostrar-token el token no sale por la salida.
    assert.equal(primera.stdout.includes(token.trim()), false);
    assert.match(primera.stdout, new RegExp(`http://127\\.0\\.0\\.1:${puerto}/ws-ana/\\?tkn=<token>`));
    assert.match(primera.stdout, /AVISO: el CLI aun no bajo el servidor web/);
    assert.match(primera.stdout, new RegExp(`-L ${puerto}:127\\.0\\.0\\.1:${puerto}`), "reenvio por SSH a traves de IAP");

    // Plantilla: el token entra por LoadCredential (nunca --connection-token <valor>),
    // un camino por estudiante, nada de /etc/adaceen-ws.env.
    const unidad = readFileSync(rutas.unidad, "utf8");
    assert.equal(modo(rutas.unidad), 0o644);
    assert.match(unidad, /^User=%i$/m);
    assert.match(unidad, /^LoadCredential=token:\/etc\/adaceen-web\/%i\.token$/m);
    assert.match(unidad, /^EnvironmentFile=\/etc\/adaceen-web\/%i\.env$/m);
    assert.match(unidad, /^ExecStart=\/usr\/local\/bin\/code serve-web --host \$\{HOST_WEB\} --port \$\{PUERTO\} --server-base-path \/%i\/ --connection-token-file %d\/token --default-folder \/home\/%i\/proyecto --accept-server-license-terms/m);
    assert.doesNotMatch(unidad, /^ExecStart=.*--connection-token[ =]/m, "el valor del token nunca va en la linea de comandos");
    assert.doesNotMatch(unidad, /--without-connection-token/);
    assert.doesNotMatch(unidad, /EnvironmentFile=\/etc\/adaceen-ws\.env/);
    assert.match(unidad, /^After=network-online\.target adaceen-ws-metadata\.service$/m);

    // Home del estudiante: 0700, clon y ajustes de maquina escritos como el (sudo falso).
    const home = path.join(rutas.homes, "ws-ana");
    assert.equal(modo(home), 0o700);
    assert.equal(existsSync(path.join(home, "proyecto", ".git")), true);
    assert.equal(existsSync(path.join(home, "proyecto", "src", "Main.java")), true);
    const ajustes = JSON.parse(readFileSync(path.join(home, ".vscode-server", "data", "Machine", "settings.json"), "utf8"));
    assert.equal(ajustes["adaceen.backend.baseUrl"], "https://app-adaceen-api-eyder05232002.azurewebsites.net");
    assert.equal(modo(path.join(home, ".vscode-server", "data", "Machine", "settings.json")), 0o644);

    const log1 = readFileSync(rutas.log, "utf8");
    assert.match(log1, /^systemctl daemon-reload$/m);
    assert.match(log1, /^systemctl enable adaceen-web@ws-ana\.service$/m);
    assert.match(log1, /^systemctl start adaceen-web@ws-ana\.service$/m);

    // Segunda vez: idempotente (mismo token y puerto, sin daemon-reload) y, con el
    // servidor ya bajado por el CLI, instala la extension con el (serve-web no tiene
    // --install-extension). --mostrar-token imprime la URL completa.
    const servidor = path.join(home, ".vscode/cli/serve-web/abc123/bin/code-server");
    mkdirSync(path.dirname(servidor), { recursive: true });
    writeFileSync(servidor, "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$LOG_INSTALL\"\n");
    chmodSync(servidor, 0o755);
    const segunda = await correrSpikeWeb(rutas, `main ana "${origen}" --mostrar-token`);
    assert.equal(segunda.codigo, 0, segunda.stderr);
    assert.match(segunda.stdout, new RegExp(`^--- puerto ${puerto} para ws-ana, token de antes$`, "m"));
    assert.equal(readFileSync(path.join(rutas.web, "ws-ana.token"), "utf8"), token);
    assert.match(segunda.stdout, new RegExp(`http://127\\.0\\.0\\.1:${puerto}/ws-ana/\\?tkn=${token.trim()}`));
    assert.equal(readFileSync(rutas.log, "utf8").match(/daemon-reload/g).length, 1, "la plantilla no cambio");
    const instalado = readFileSync(rutas.instalaciones, "utf8");
    assert.match(instalado, /--accept-server-license-terms --install-extension adaceen\.adaceen/, "sin VSIX, la del Marketplace");
    if (BASH_4) assert.match(instalado, /--install-extension vscjava\.vscode-java-pack/, "repo Java: su extension");
    assert.deepEqual(readdirSync(rutas.web).sort(), ["ws-ana.env", "ws-ana.token"], "sin temporales");

    // Con VSIX en /opt/adaceen gana el VSIX.
    writeFileSync(rutas.vsix, vsix("adaceen", "0.0.33"));
    const conVsix = await correrSpikeWeb(rutas, `main ana "${origen}"`);
    assert.equal(conVsix.codigo, 0, conVsix.stderr);
    assert.match(readFileSync(rutas.instalaciones, "utf8"), new RegExp(`--install-extension ${escaparRegExp(rutas.vsix)}`));

    // Choque de puertos: otro login ya tiene el puerto que le toca a carla; se usa el siguiente.
    const puertoCarla = puertoEsperado("carla");
    writeFileSync(path.join(rutas.web, "ws-otro.env"), `PUERTO=${puertoCarla}\nHOST_WEB=127.0.0.1\n`);
    const carla = await correrSpikeWeb(rutas, `main Carla "${origen}"`);
    assert.equal(carla.codigo, 0, carla.stderr);
    assert.equal(leerEntorno(path.join(rutas.web, "ws-carla.env")).PUERTO, String(20000 + ((puertoCarla - 20000 + 1) % 10000)));
    assert.notEqual(readFileSync(path.join(rutas.web, "ws-carla.token"), "utf8"), token, "un token por estudiante");

    // rotar: token nuevo y reinicio; el de ana no se toca.
    const rotar = await correrSpikeWeb(rutas, "main rotar carla");
    assert.equal(rotar.codigo, 0, rotar.stderr);
    assert.match(readFileSync(path.join(rutas.web, "ws-carla.token"), "utf8"), /^[0-9a-f]{64}\n$/);
    assert.match(readFileSync(rutas.log, "utf8"), /^systemctl restart adaceen-web@ws-carla\.service$/m);
    assert.equal(readFileSync(path.join(rutas.web, "ws-ana.token"), "utf8"), token);

    // quitar: servicio, puerto y token fuera; el usuario y ~/proyecto siguen salvo --borrar-usuario.
    const quitar = await correrSpikeWeb(rutas, "main quitar carla");
    assert.equal(quitar.codigo, 0, quitar.stderr);
    assert.match(readFileSync(rutas.log, "utf8"), /^systemctl disable --now adaceen-web@ws-carla\.service$/m);
    assert.equal(existsSync(path.join(rutas.web, "ws-carla.env")), false);
    assert.equal(existsSync(path.join(rutas.web, "ws-carla.token")), false);
    assert.equal(existsSync(path.join(rutas.homes, "ws-carla", "proyecto")), true);
    const borrar = await correrSpikeWeb(rutas, "main quitar carla --borrar-usuario");
    assert.equal(borrar.codigo, 0, borrar.stderr);
    assert.equal(existsSync(path.join(rutas.homes, "ws-carla")), false);
    assert.equal(existsSync(path.join(rutas.homes, "ws-ana", "proyecto")), true, "solo el login pedido");

    // Entradas que no se aceptan. (Como nuevo-tunel.sh, el login se sanea:
    // 'Mal;login' pasa a 'mallogin'; lo que no vale es vacio o mas de 28.)
    assert.notEqual((await correrSpikeWeb(rutas, `main ';;;' "${origen}"`)).codigo, 0, "login vacio tras sanear");
    assert.notEqual((await correrSpikeWeb(rutas, `main ${"a".repeat(29)} "${origen}"`)).codigo, 0, "login de 29");
    assert.equal(existsSync(path.join(rutas.homes, "ws-mallogin")), false);
    assert.notEqual((await correrSpikeWeb(rutas, "main bob --evil")).codigo, 0, "url del repo que parece opcion");
    assert.notEqual((await correrSpikeWeb(rutas, "main rotar nadie")).codigo, 0, "rotar sin token");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
