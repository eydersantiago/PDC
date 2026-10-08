#!/usr/bin/env node
// Empaqueta la extension de navegador ADACEEN como CRX3 firmado y genera el manifiesto de
// actualizacion de Google, para instalarla por politica (ExtensionInstallForcelist) en los
// equipos gestionados del laboratorio sin "Modo de desarrollador" ni "Cargar descomprimida"
// (docs/operacion/publicar-extension.md, seccion 3).
//
//   node scripts/empaquetar-crx.mjs                             -> dist/extension/adaceen-<version>.crx
//                                                                  y dist/extension/adaceen-update.xml
//   node scripts/empaquetar-crx.mjs --zip <ruta> --salida <dir>  -> otro zip de entrada u otra carpeta
//
// Entrada: el zip de Chromium que genera empaquetar-extension.mjs (correrlo antes) y la clave
// privada RSA en PEM: CRX_PRIVATE_KEY_PEM_FILE (ruta) o CRX_PRIVATE_KEY_PEM (contenido). Sin
// clave, el script explica como generarla y sale con codigo 2: el empaquetado normal no falla.
// CRX_CODEBASE_URL es la URL publica del .crx que va en el manifiesto (por defecto, la de
// /descargas/adaceen.crx del backend de Azure).
//
// Formato CRX3 (components/crx_file/crx3.proto de Chromium), escrito a mano porque son pocos campos:
//   "Cr24" | version 3 (LE32) | tamano de la cabecera (LE32) | CrxFileHeader (protobuf) | zip
//   CrxFileHeader { repeated AsymmetricKeyProof sha256_with_rsa = 2; bytes signed_header_data = 10000; }
//   AsymmetricKeyProof { bytes public_key = 1 (SPKI DER); bytes signature = 2; }
//   SignedData { bytes crx_id = 1; }   crx_id = primeros 16 bytes del SHA-256 de la clave publica
// Firma: RSA PKCS#1 v1.5 con SHA-256 sobre "CRX3 SignedData\0" + len(signed_header_data) LE32
// + signed_header_data + zip. El id de la extension son los 16 bytes del crx_id en hexadecimal
// con cada digito pasado a las letras a-p (0 -> a, ..., f -> p). Chrome exige que una de las
// claves de la cabecera sea la del crx_id (la "clave del desarrollador").
//
// Node puro y sin dependencias. Al terminar vuelve a leer el .crx y verifica cabecera, crx_id y
// firma con la clave publica, igual que lo haria Chrome.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { leerZip } from "./empaquetar-extension.mjs";

const RAIZ_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CARPETA_EXTENSION = path.join(RAIZ_REPO, "browser-ext-prod");
const CARPETA_SALIDA = path.join(RAIZ_REPO, "dist", "extension");
const CODEBASE_POR_DEFECTO = "https://app-adaceen-api-eyder05232002.azurewebsites.net/descargas/adaceen.crx";
const NOMBRE_MANIFIESTO = "adaceen-update.xml";
const COMANDO_CLAVE = "openssl genrsa -out adaceen-crx.pem 2048";

const MAGIA = Buffer.from("Cr24", "latin1");
const VERSION_CRX = 3;
const PREFIJO_FIRMA = Buffer.from("CRX3 SignedData\0", "latin1");
const CAMPO_PUBLIC_KEY = 1;
const CAMPO_SIGNATURE = 2;
const CAMPO_SHA256_WITH_RSA = 2;
const CAMPO_SIGNED_HEADER_DATA = 10000;
const CAMPO_CRX_ID = 1;
const LARGO_CRX_ID = 16;

function mostrarAyuda() {
  console.log(`Uso: node scripts/empaquetar-crx.mjs [--zip <ruta>] [--salida <carpeta>]

  --zip <ruta>        zip de Chromium a firmar (por defecto dist/extension/adaceen-chromium-<version>.zip,
                      que genera node scripts/empaquetar-extension.mjs)
  --salida <carpeta>  donde dejar adaceen-<version>.crx y ${NOMBRE_MANIFIESTO} (por defecto dist/extension/)
  --help              muestra esta ayuda

Variables de entorno:
  CRX_PRIVATE_KEY_PEM_FILE  ruta de la clave privada RSA (PEM); o
  CRX_PRIVATE_KEY_PEM       el contenido PEM de la clave
  CRX_CODEBASE_URL          URL publica del .crx en el manifiesto (por defecto ${CODEBASE_POR_DEFECTO})

Sin clave sale con codigo 2 y explica como generarla (${COMANDO_CLAVE}).`);
}

// ---- Protobuf minimo (solo campos de bytes) ----

function varint(valor) {
  const bytes = [];
  let resto = valor;
  while (resto >= 0x80) {
    bytes.push((resto & 0x7f) | 0x80);
    resto = Math.floor(resto / 128);
  }
  bytes.push(resto);
  return Buffer.from(bytes);
}

function campoBytes(numero, datos) {
  return Buffer.concat([varint(numero * 8 + 2), varint(datos.length), datos]);
}

function leerVarint(buffer, posicion) {
  let valor = 0;
  let factor = 1;
  let cursor = posicion;
  for (;;) {
    if (cursor >= buffer.length) throw new Error("protobuf truncado.");
    const byte = buffer[cursor];
    cursor += 1;
    valor += (byte & 0x7f) * factor;
    if (byte < 0x80) break;
    factor *= 128;
  }
  return { valor, siguiente: cursor };
}

/** Campos de un mensaje: { numero, bytes } para los de longitud (tipo 2); los demas se saltan. */
function leerCampos(buffer) {
  const campos = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const etiqueta = leerVarint(buffer, cursor);
    const numero = Math.floor(etiqueta.valor / 8);
    const tipo = etiqueta.valor % 8;
    cursor = etiqueta.siguiente;
    if (tipo === 2) {
      const largo = leerVarint(buffer, cursor);
      cursor = largo.siguiente;
      if (cursor + largo.valor > buffer.length) throw new Error(`protobuf truncado en el campo ${numero}.`);
      campos.push({ numero, bytes: buffer.subarray(cursor, cursor + largo.valor) });
      cursor += largo.valor;
    } else if (tipo === 0) {
      cursor = leerVarint(buffer, cursor).siguiente;
    } else if (tipo === 1) {
      cursor += 8;
    } else if (tipo === 5) {
      cursor += 4;
    } else {
      throw new Error(`protobuf: tipo de campo ${tipo} no soportado.`);
    }
  }
  return campos;
}

// ---- Id y firma ----

export function crxIdDe(clavePublicaDer) {
  return createHash("sha256").update(clavePublicaDer).digest().subarray(0, LARGO_CRX_ID);
}

/** Id de la extension como lo muestra chrome://extensions: 32 letras de la a a la p. */
export function idDeExtension(clavePublicaDer) {
  return [...crxIdDe(clavePublicaDer).toString("hex")]
    .map((digito) => String.fromCharCode(97 + parseInt(digito, 16)))
    .join("");
}

function le32(valor) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(valor, 0);
  return bytes;
}

function datosFirmados(signedHeaderData, zip) {
  return Buffer.concat([PREFIJO_FIRMA, le32(signedHeaderData.length), signedHeaderData, zip]);
}

/** Envuelve el zip en un CRX3 firmado con la clave privada (KeyObject o PEM). */
export function crearCrx(zip, clavePrivada) {
  const privada = typeof clavePrivada === "string" ? createPrivateKey(clavePrivada) : clavePrivada;
  if (privada.asymmetricKeyType !== "rsa") throw new Error("La clave privada debe ser RSA.");
  const clavePublica = createPublicKey(privada).export({ type: "spki", format: "der" });
  const signedHeaderData = campoBytes(CAMPO_CRX_ID, crxIdDe(clavePublica));
  const firma = sign("sha256", datosFirmados(signedHeaderData, zip), privada);
  const prueba = Buffer.concat([campoBytes(CAMPO_PUBLIC_KEY, clavePublica), campoBytes(CAMPO_SIGNATURE, firma)]);
  const cabecera = Buffer.concat([
    campoBytes(CAMPO_SHA256_WITH_RSA, prueba),
    campoBytes(CAMPO_SIGNED_HEADER_DATA, signedHeaderData),
  ]);
  const crx = Buffer.concat([MAGIA, le32(VERSION_CRX), le32(cabecera.length), cabecera, zip]);
  return { crx, id: idDeExtension(clavePublica), clavePublica };
}

/** Separa un CRX3 en sus partes sin verificar la firma. */
export function leerCrx(buffer) {
  if (buffer.length < 12 || !buffer.subarray(0, 4).equals(MAGIA)) throw new Error("No es un archivo CRX (falta la cabecera Cr24).");
  const version = buffer.readUInt32LE(4);
  if (version !== VERSION_CRX) throw new Error(`Version CRX ${version} no soportada (se esperaba ${VERSION_CRX}).`);
  const largoCabecera = buffer.readUInt32LE(8);
  if (12 + largoCabecera > buffer.length) throw new Error("Cabecera CRX truncada.");
  const cabecera = buffer.subarray(12, 12 + largoCabecera);
  const zip = buffer.subarray(12 + largoCabecera);

  const pruebas = [];
  let signedHeaderData = null;
  for (const campo of leerCampos(cabecera)) {
    if (campo.numero === CAMPO_SHA256_WITH_RSA) {
      const partes = leerCampos(campo.bytes);
      pruebas.push({
        clavePublica: partes.find((parte) => parte.numero === CAMPO_PUBLIC_KEY)?.bytes || Buffer.alloc(0),
        firma: partes.find((parte) => parte.numero === CAMPO_SIGNATURE)?.bytes || Buffer.alloc(0),
      });
    } else if (campo.numero === CAMPO_SIGNED_HEADER_DATA) {
      signedHeaderData = campo.bytes;
    }
  }
  if (!signedHeaderData) throw new Error("La cabecera CRX no trae signed_header_data.");
  const crxId = leerCampos(signedHeaderData).find((campo) => campo.numero === CAMPO_CRX_ID)?.bytes;
  if (!crxId || crxId.length !== LARGO_CRX_ID) throw new Error("La cabecera CRX no trae un crx_id de 16 bytes.");
  return { version, pruebas, signedHeaderData, crxId: Buffer.from(crxId), zip };
}

/**
 * Verifica el CRX como Chrome: una de las claves RSA es la del crx_id y todas las firmas
 * son validas sobre los datos firmados. Devuelve { id, clavePublica, zip }.
 */
export function verificarCrx(buffer) {
  const { pruebas, signedHeaderData, crxId, zip } = leerCrx(buffer);
  if (!pruebas.length) throw new Error("El CRX no trae ninguna firma sha256_with_rsa.");
  const datos = datosFirmados(signedHeaderData, zip);
  let claveDelDesarrollador = null;
  for (const prueba of pruebas) {
    let valida = false;
    try {
      valida = verify("sha256", datos, createPublicKey({ key: prueba.clavePublica, type: "spki", format: "der" }), prueba.firma);
    } catch {
      valida = false;
    }
    if (!valida) throw new Error("La firma del CRX no es valida (el contenido o la clave cambiaron).");
    if (crxIdDe(prueba.clavePublica).equals(crxId)) claveDelDesarrollador = prueba.clavePublica;
  }
  if (!claveDelDesarrollador) throw new Error("Ninguna clave del CRX corresponde al crx_id de la cabecera.");
  if (zip.length < 4 || zip.readUInt32LE(0) !== 0x04034b50) throw new Error("Despues de la cabecera CRX no viene un zip.");
  return { id: idDeExtension(claveDelDesarrollador), clavePublica: Buffer.from(claveDelDesarrollador), zip: Buffer.from(zip) };
}

// ---- Manifiesto de actualizacion ----

function escaparXml(valor) {
  return String(valor).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&apos;").replace(/"/g, "&quot;");
}

/** Manifiesto de actualizacion de Google (el que apunta ExtensionInstallForcelist). */
export function manifiestoActualizacion({ id, version, codebase }) {
  if (!/^[a-p]{32}$/.test(id)) throw new Error(`Id de extension invalido: ${id}`);
  if (!/^\d+(\.\d+){0,3}$/.test(version)) throw new Error(`Version invalida: ${version}`);
  return `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${id}'>
    <updatecheck codebase='${escaparXml(codebase)}' version='${version}'/>
  </app>
</gupdate>
`;
}

// ---- Programa ----

function leerClavePrivada() {
  const ruta = (process.env.CRX_PRIVATE_KEY_PEM_FILE || "").trim();
  const contenido = ruta ? fs.readFileSync(ruta, "utf8") : (process.env.CRX_PRIVATE_KEY_PEM || "");
  if (!contenido.trim()) return null;
  const clave = createPrivateKey(contenido);
  if (clave.asymmetricKeyType !== "rsa") throw new Error("CRX_PRIVATE_KEY_PEM debe ser una clave RSA.");
  const bits = clave.asymmetricKeyDetails?.modulusLength || 0;
  if (bits && bits < 2048) console.warn(`Aviso: la clave tiene ${bits} bits; se recomiendan 2048 (${COMANDO_CLAVE}).`);
  return clave;
}

function leerOpciones(argumentos) {
  const opciones = { zip: "", salida: "", ayuda: false };
  for (let i = 0; i < argumentos.length; i += 1) {
    const arg = argumentos[i];
    if (arg === "--help" || arg === "-h") opciones.ayuda = true;
    else if (arg === "--zip" && argumentos[i + 1]) opciones.zip = argumentos[++i];
    else if (arg === "--salida" && argumentos[i + 1]) opciones.salida = argumentos[++i];
    else throw new Error(`Opcion desconocida: ${arg}`);
  }
  return opciones;
}

function leerManifestDelZip(zip) {
  const archivos = leerZip(zip);
  if (!archivos["manifest.json"]) throw new Error("El zip no trae manifest.json en la raiz.");
  return JSON.parse(archivos["manifest.json"].toString("utf8"));
}

function main() {
  const opciones = leerOpciones(process.argv.slice(2));
  if (opciones.ayuda) {
    mostrarAyuda();
    return;
  }
  const clavePrivada = leerClavePrivada();
  if (!clavePrivada) {
    console.error(`No hay clave para firmar el CRX: define CRX_PRIVATE_KEY_PEM_FILE (ruta) o CRX_PRIVATE_KEY_PEM (contenido).
Para crear una (una sola vez; guardala fuera del repositorio, el id de la extension depende de ella):
  ${COMANDO_CLAVE}
Se omite el CRX; los zip de empaquetar-extension.mjs no cambian.`);
    process.exitCode = 2;
    return;
  }

  let rutaZip = opciones.zip ? path.resolve(opciones.zip) : "";
  if (!rutaZip) {
    const manifestRepo = JSON.parse(fs.readFileSync(path.join(CARPETA_EXTENSION, "manifest.json"), "utf8"));
    rutaZip = path.join(CARPETA_SALIDA, `adaceen-chromium-${manifestRepo.version}.zip`);
  }
  if (!fs.existsSync(rutaZip)) {
    throw new Error(`No existe ${path.relative(RAIZ_REPO, rutaZip)}; genera el zip antes con node scripts/empaquetar-extension.mjs.`);
  }
  const zip = fs.readFileSync(rutaZip);
  const manifest = leerManifestDelZip(zip);
  const version = String(manifest.version || "");
  const codebase = (process.env.CRX_CODEBASE_URL || "").trim() || CODEBASE_POR_DEFECTO;
  if (!/^https:\/\//.test(codebase)) console.warn(`Aviso: Chrome exige https para el manifiesto de actualizacion; CRX_CODEBASE_URL es ${codebase}.`);

  const { crx, id, clavePublica } = crearCrx(zip, clavePrivada);
  const verificado = verificarCrx(crx);
  if (verificado.id !== id || !verificado.zip.equals(zip)) throw new Error("El CRX no coincide al releerlo.");

  // Con "key" en el manifest, chrome://extensions muestra ese id al cargar la carpeta o el zip.
  // Si la clave PEM no es la misma, el CRX se instala con otro id (y oauth2.client_id de Google
  // esta atado al id del manifest).
  if (typeof manifest.key === "string" && manifest.key.trim()) {
    const idDelManifest = idDeExtension(Buffer.from(manifest.key.trim(), "base64"));
    if (idDelManifest !== id) {
      console.warn(`Aviso: la clave PEM no es la del campo "key" del manifest: el CRX se instala como ${id} y la carpeta/zip como ${idDelManifest}. Ver docs/operacion/publicar-extension.md.`);
    }
  }

  const salida = opciones.salida ? path.resolve(opciones.salida) : CARPETA_SALIDA;
  fs.mkdirSync(salida, { recursive: true });
  const nombreCrx = `adaceen-${version}.crx`;
  fs.writeFileSync(path.join(salida, nombreCrx), crx);
  fs.writeFileSync(path.join(salida, NOMBRE_MANIFIESTO), manifiestoActualizacion({ id, version, codebase }));

  const relativa = path.relative(RAIZ_REPO, salida) || ".";
  console.log(`ADACEEN ${version} -> ${relativa}/`);
  console.log(`  ${nombreCrx}  ${(crx.length / 1024).toFixed(1)} KiB  (CRX3, firma verificada)`);
  console.log(`  ${NOMBRE_MANIFIESTO}  appid ${id}  codebase ${codebase}`);
  console.log(`  Id de la extension: ${id}`);
  console.log(`  ExtensionInstallForcelist: ${id};${new URL(NOMBRE_MANIFIESTO, codebase).href}`);
  console.log(`  Huella SHA-256 de la clave publica: ${createHash("sha256").update(clavePublica).digest("hex")}`);
}

function esEsteArchivo(ruta) {
  if (!ruta) return false;
  try {
    return fs.realpathSync(path.resolve(ruta)) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (esEsteArchivo(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`Error al generar el CRX: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
