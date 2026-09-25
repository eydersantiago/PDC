#!/usr/bin/env node
// Empaqueta la extension de navegador ADACEEN (A15.9 ADACEEN-149).
//
//   node scripts/empaquetar-extension.mjs         -> paquetes de produccion
//   node scripts/empaquetar-extension.mjs --dev   -> variantes -dev (agregan el backend local)
//
// Salida en dist/extension/ (dist/ esta en .gitignore):
//   adaceen-chromium-<version>[-dev].zip  manifest.json del repo (produccion)
//   adaceen-firefox-<version>[-dev].zip   mismo codigo + browser_specific_settings.gecko y background.scripts
//   SHA256SUMS.txt                        sumas de todos los zip de la carpeta
//
// Node puro y sin dependencias: escritor ZIP minimo (deflate con zlib.deflateRawSync + CRC32)
// y una verificacion que vuelve a leer cada zip, descomprime cada entrada y compara CRC y tamano.
// Fecha de las entradas: SOURCE_DATE_EPOCH si existe; si no, la fecha de version_name del
// manifest. Con las mismas fuentes, el zip sale identico byte a byte.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const RAIZ_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CARPETA_EXTENSION = path.join(RAIZ_REPO, "browser-ext-prod");
const CARPETA_SALIDA = path.join(RAIZ_REPO, "dist", "extension");
// Solo la variante -dev habla con el backend local (A12.7: el manifest del repo es de produccion).
const HOSTS_DESARROLLO = ["http://127.0.0.1:3000/*", "http://localhost:3000/*"];
// La pagina /empezar del backend local tambien detecta la extension, pero solo en la variante
// -dev: el content script de /empezar de produccion corre solo en el backend https.
const PATRONES_INICIO_DESARROLLO = HOSTS_DESARROLLO.map((host) => host.replace(/\/\*$/, "/empezar*"));
const FIREFOX_GECKO_ID = "adaceen@univalle.edu.co";
const FIREFOX_VERSION_MINIMA = "128.0";

function mostrarAyuda() {
  console.log(`Uso: node scripts/empaquetar-extension.mjs [--dev]

  (sin opciones)  genera adaceen-chromium-<version>.zip y adaceen-firefox-<version>.zip
  --dev           genera las variantes -dev con ${HOSTS_DESARROLLO.join(" y ")}
  --help          muestra esta ayuda

Los paquetes quedan en ${path.relative(RAIZ_REPO, CARPETA_SALIDA)}/.`);
}

// ---- Archivos de la extension ----

function debeExcluirse(rutaRelativa) {
  const nombre = path.posix.basename(rutaRelativa);
  return rutaRelativa === "manifest.json" // se escribe aparte segun la variante
    || nombre.startsWith(".") // .DS_Store y otros ocultos
    || nombre === "Thumbs.db"
    || /\.(md|zip|map|log)$/i.test(nombre);
}

function listarArchivos(carpeta, prefijo = "") {
  const salida = [];
  const entradas = fs.readdirSync(carpeta, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (const entrada of entradas) {
    const relativa = prefijo ? `${prefijo}/${entrada.name}` : entrada.name;
    const absoluta = path.join(carpeta, entrada.name);
    if (entrada.isDirectory()) {
      if (entrada.name.startsWith(".")) continue;
      salida.push(...listarArchivos(absoluta, relativa));
    } else if (entrada.isFile() && !debeExcluirse(relativa)) {
      salida.push(relativa);
    }
  }
  return salida;
}

function leerOrdenBackground() {
  const texto = fs.readFileSync(path.join(CARPETA_EXTENSION, "background.js"), "utf8");
  const bloque = texto.match(/const CONTENT_SCRIPT_FILES = \[([\s\S]*?)\];/);
  return bloque ? [...bloque[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : null;
}

function validarManifest(manifest, archivos) {
  const errores = [];
  if (manifest.manifest_version !== 3) errores.push("manifest_version debe ser 3.");
  if (!/^\d+(\.\d+){0,3}$/.test(String(manifest.version || ""))) {
    errores.push(`version invalida: "${manifest.version}".`);
  }

  const disponibles = new Set(archivos);
  const referenciados = [
    manifest.background?.service_worker,
    ...Object.values(manifest.icons || {}),
    ...(manifest.content_scripts || []).flatMap((grupo) => [...(grupo.js || []), ...(grupo.css || [])]),
    ...(manifest.web_accessible_resources || []).flatMap((grupo) => grupo.resources || []),
  ].filter(Boolean);
  for (const referencia of referenciados) {
    if (!disponibles.has(referencia)) errores.push(`el manifest referencia ${referencia}, que no existe.`);
  }

  const inseguros = (manifest.host_permissions || []).filter((host) => !String(host).startsWith("https://"));
  if (inseguros.length) {
    errores.push(`manifest.json debe quedar de produccion; mueve a HOSTS_DESARROLLO: ${inseguros.join(", ")}.`);
  }
  // A12.7 tambien para content_scripts: un match http (localhost) inyecta scripts igual que un host.
  const matchesInseguros = (manifest.content_scripts || [])
    .flatMap((grupo) => grupo.matches || [])
    .filter((patron) => !String(patron).startsWith("https://"));
  if (matchesInseguros.length) {
    errores.push(`content_scripts de produccion solo con https; el backend local va en la variante -dev: ${matchesInseguros.join(", ")}.`);
  }

  const ordenManifest = manifest.content_scripts?.[0]?.js || [];
  const ordenBackground = leerOrdenBackground();
  if (!ordenBackground || JSON.stringify(ordenBackground) !== JSON.stringify(ordenManifest)) {
    errores.push("CONTENT_SCRIPT_FILES de background.js no coincide con content_scripts de manifest.json.");
  }
  return errores;
}

function construirManifest(base, { navegador, desarrollo }) {
  const manifest = structuredClone(base);
  if (desarrollo) {
    manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), ...HOSTS_DESARROLLO])];
    manifest.content_scripts = (manifest.content_scripts || []).map((grupo) => (
      (grupo.matches || []).some((patron) => /\/empezar\*$/.test(patron))
        ? { ...grupo, matches: [...new Set([...grupo.matches, ...PATRONES_INICIO_DESARROLLO])] }
        : grupo
    ));
    manifest.version_name = `${manifest.version_name || manifest.version} (dev)`;
  }
  if (navegador === "firefox") {
    // Firefox usa background.scripts (event page); Chrome usa service_worker e ignora scripts.
    manifest.background = {
      ...manifest.background,
      scripts: [manifest.background.service_worker],
    };
    manifest.browser_specific_settings = {
      gecko: {
        id: FIREFOX_GECKO_ID,
        strict_min_version: FIREFOX_VERSION_MINIMA,
      },
    };
  }
  return manifest;
}

// ---- ZIP minimo ----

const TABLA_CRC32 = (() => {
  const tabla = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabla[n] = c >>> 0;
  }
  return tabla;
})();

function crc32(datos) {
  let c = 0xffffffff;
  for (let i = 0; i < datos.length; i++) c = TABLA_CRC32[(c ^ datos[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function fechaHoraDos(fecha) {
  const anio = Math.min(2107, Math.max(1980, fecha.getUTCFullYear()));
  return {
    hora: (fecha.getUTCHours() << 11) | (fecha.getUTCMinutes() << 5) | Math.floor(fecha.getUTCSeconds() / 2),
    dia: ((anio - 1980) << 9) | ((fecha.getUTCMonth() + 1) << 5) | fecha.getUTCDate(),
  };
}

function crearZip(entradas, fecha) {
  if (entradas.length >= 0xffff) throw new Error("Demasiadas entradas para un ZIP sin ZIP64.");
  const { hora, dia } = fechaHoraDos(fecha);
  const partes = [];
  const directorio = [];
  let desplazamiento = 0;

  for (const { nombre, datos } of entradas) {
    const nombreBytes = Buffer.from(nombre, "utf8");
    const crc = crc32(datos);
    const comprimido = zlib.deflateRawSync(datos, { level: 9 });
    // Los PNG ya vienen comprimidos: si deflate no ahorra, se guardan tal cual (metodo 0).
    const usarDeflate = comprimido.length < datos.length;
    const cuerpo = usarDeflate ? comprimido : datos;
    const metodo = usarDeflate ? 8 : 0;
    if (cuerpo.length >= 0xffffffff || desplazamiento >= 0xffffffff) {
      throw new Error("Paquete demasiado grande para un ZIP sin ZIP64.");
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // firma de cabecera local
    local.writeUInt16LE(20, 4); // version necesaria: 2.0
    local.writeUInt16LE(0x0800, 6); // bit 11: nombre en UTF-8
    local.writeUInt16LE(metodo, 8);
    local.writeUInt16LE(hora, 10);
    local.writeUInt16LE(dia, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(cuerpo.length, 18);
    local.writeUInt32LE(datos.length, 22);
    local.writeUInt16LE(nombreBytes.length, 26);
    local.writeUInt16LE(0, 28); // sin campo extra
    partes.push(local, nombreBytes, cuerpo);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // firma del directorio central
    central.writeUInt16LE((3 << 8) | 20, 4); // creado en UNIX, version 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(metodo, 10);
    central.writeUInt16LE(hora, 12);
    central.writeUInt16LE(dia, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(cuerpo.length, 20);
    central.writeUInt32LE(datos.length, 24);
    central.writeUInt16LE(nombreBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comentario
    central.writeUInt16LE(0, 34); // disco
    central.writeUInt16LE(0, 36); // atributos internos
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // archivo regular rw-r--r--
    central.writeUInt32LE(desplazamiento, 42);
    directorio.push(central, nombreBytes);

    desplazamiento += local.length + nombreBytes.length + cuerpo.length;
  }

  const bloqueDirectorio = Buffer.concat(directorio);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); // fin del directorio central
  fin.writeUInt16LE(0, 4);
  fin.writeUInt16LE(0, 6);
  fin.writeUInt16LE(entradas.length, 8);
  fin.writeUInt16LE(entradas.length, 10);
  fin.writeUInt32LE(bloqueDirectorio.length, 12);
  fin.writeUInt32LE(desplazamiento, 16);
  fin.writeUInt16LE(0, 20);
  return Buffer.concat([...partes, bloqueDirectorio, fin]);
}

// Relee el zip como lo haria un lector estandar: directorio central -> cabecera local ->
// descompresion -> CRC32 y tamano. Devuelve { nombre: datos }.
function leerZip(buffer) {
  const inicioFin = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (inicioFin < 0) throw new Error("No se encontro el fin del directorio central.");
  const total = buffer.readUInt16LE(inicioFin + 10);
  let cursor = buffer.readUInt32LE(inicioFin + 16);
  const archivos = {};
  for (let i = 0; i < total; i++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error(`Entrada ${i}: firma central invalida.`);
    const metodo = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const tamanoComprimido = buffer.readUInt32LE(cursor + 20);
    const tamano = buffer.readUInt32LE(cursor + 24);
    const largoNombre = buffer.readUInt16LE(cursor + 28);
    const largoExtra = buffer.readUInt16LE(cursor + 30);
    const largoComentario = buffer.readUInt16LE(cursor + 32);
    const offsetLocal = buffer.readUInt32LE(cursor + 42);
    const nombre = buffer.subarray(cursor + 46, cursor + 46 + largoNombre).toString("utf8");
    cursor += 46 + largoNombre + largoExtra + largoComentario;

    if (buffer.readUInt32LE(offsetLocal) !== 0x04034b50) throw new Error(`${nombre}: firma local invalida.`);
    const inicioDatos = offsetLocal + 30 + buffer.readUInt16LE(offsetLocal + 26) + buffer.readUInt16LE(offsetLocal + 28);
    const cuerpo = buffer.subarray(inicioDatos, inicioDatos + tamanoComprimido);
    const datos = metodo === 8 ? zlib.inflateRawSync(cuerpo) : metodo === 0 ? Buffer.from(cuerpo) : null;
    if (!datos) throw new Error(`${nombre}: metodo de compresion ${metodo} no soportado.`);
    if (datos.length !== tamano || crc32(datos) !== crc) throw new Error(`${nombre}: CRC o tamano no coinciden.`);
    archivos[nombre] = datos;
  }
  return archivos;
}

function fechaDePaquete(manifest) {
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  if (Number.isFinite(epoch) && epoch > 0) return new Date(epoch * 1000);
  const fechaVersion = String(manifest.version_name || "").match(/(\d{4})-(\d{2})-(\d{2})/);
  if (fechaVersion) return new Date(Date.UTC(Number(fechaVersion[1]), Number(fechaVersion[2]) - 1, Number(fechaVersion[3])));
  return new Date();
}

function formatearTamano(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

// ---- Programa ----

function main() {
  const argumentos = process.argv.slice(2);
  if (argumentos.includes("--help") || argumentos.includes("-h")) {
    mostrarAyuda();
    return;
  }
  const desconocidos = argumentos.filter((arg) => arg !== "--dev");
  if (desconocidos.length) {
    console.error(`Opcion desconocida: ${desconocidos.join(" ")}\n`);
    mostrarAyuda();
    process.exitCode = 2;
    return;
  }
  const desarrollo = argumentos.includes("--dev");

  const manifestBase = JSON.parse(fs.readFileSync(path.join(CARPETA_EXTENSION, "manifest.json"), "utf8"));
  const archivos = listarArchivos(CARPETA_EXTENSION);
  const errores = validarManifest(manifestBase, archivos);
  if (errores.length) {
    console.error("No se empaqueto la extension:");
    for (const error of errores) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }

  const fecha = fechaDePaquete(manifestBase);
  const contenidos = archivos.map((relativa) => ({
    nombre: relativa,
    datos: fs.readFileSync(path.join(CARPETA_EXTENSION, relativa)),
  }));
  fs.mkdirSync(CARPETA_SALIDA, { recursive: true });

  const sufijo = desarrollo ? "-dev" : "";
  const generados = [];
  for (const navegador of ["chromium", "firefox"]) {
    const manifest = construirManifest(manifestBase, { navegador, desarrollo });
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const entradas = [{ nombre: "manifest.json", datos: manifestBytes }, ...contenidos];
    const zip = crearZip(entradas, fecha);

    const leidos = leerZip(zip);
    if (Object.keys(leidos).length !== entradas.length) throw new Error("El zip no contiene todas las entradas.");
    for (const entrada of entradas) {
      if (!leidos[entrada.nombre]?.equals(entrada.datos)) throw new Error(`${entrada.nombre} no coincide al releer.`);
    }

    const nombreZip = `adaceen-${navegador}-${manifestBase.version}${sufijo}.zip`;
    fs.writeFileSync(path.join(CARPETA_SALIDA, nombreZip), zip);
    generados.push({ nombreZip, bytes: zip.length, entradas: entradas.length, hosts: manifest.host_permissions.length });
  }

  const sumas = fs.readdirSync(CARPETA_SALIDA)
    .filter((nombre) => /^adaceen-.*\.zip$/.test(nombre))
    .sort()
    .map((nombre) => {
      const hash = createHash("sha256").update(fs.readFileSync(path.join(CARPETA_SALIDA, nombre))).digest("hex");
      return `${hash}  ${nombre}`;
    });
  fs.writeFileSync(path.join(CARPETA_SALIDA, "SHA256SUMS.txt"), `${sumas.join("\n")}\n`);

  console.log(`ADACEEN ${manifestBase.version}${desarrollo ? " (desarrollo)" : " (produccion)"} -> ${path.relative(RAIZ_REPO, CARPETA_SALIDA)}/`);
  for (const paquete of generados) {
    console.log(`  ${paquete.nombreZip}  ${formatearTamano(paquete.bytes)}  ${paquete.entradas} archivos  ${paquete.hosts} host_permissions  (verificado)`);
  }
  console.log(`  SHA256SUMS.txt (${sumas.length} paquetes)`);
}

try {
  main();
} catch (error) {
  console.error(`Error al empaquetar: ${error?.message || error}`);
  process.exitCode = 1;
}
