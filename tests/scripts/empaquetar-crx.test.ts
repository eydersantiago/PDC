import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * CRX firmado y manifiesto de actualizacion (scripts/empaquetar-crx.mjs): el paquete que
 * instalan por politica los equipos gestionados del laboratorio. Se comprueba el formato
 * CRX3 (cabecera, crx_id, firma RSA-SHA256 verificable con node:crypto), el id derivado
 * de la clave publica, el XML de Google y el programa de linea de comandos (clave por
 * variable de entorno, salida 2 sin clave).
 */

const RAIZ = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = path.join(RAIZ, "scripts", "empaquetar-crx.mjs");

type Crx = typeof import("../../scripts/empaquetar-crx.mjs");
type Empaquetado = typeof import("../../scripts/empaquetar-extension.mjs");

function clavePrueba() {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

function zipDePrueba(empaquetado: Empaquetado, manifest: Record<string, unknown>) {
  return empaquetado.crearZip([
    { nombre: "manifest.json", datos: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8") },
    { nombre: "background.js", datos: Buffer.from("// prueba\n", "utf8") },
  ], new Date(Date.UTC(2026, 0, 1)));
}

function le32(valor: number) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(valor, 0);
  return bytes;
}

function correr(argumentos: string[], entorno: Record<string, string | undefined>) {
  const env: Record<string, string> = {};
  for (const [nombre, valor] of Object.entries({ ...process.env, ...entorno })) {
    if (typeof valor === "string") env[nombre] = valor;
  }
  return spawnSync(process.execPath, [SCRIPT, ...argumentos], { cwd: RAIZ, env, encoding: "utf8" });
}

test("empaquetar-crx: CRX3 con crx_id y firma verificables, id de la clave publica y XML de actualizacion", async () => {
  const crx: Crx = await import("../../scripts/empaquetar-crx.mjs");
  const empaquetado: Empaquetado = await import("../../scripts/empaquetar-extension.mjs");
  const { privateKey, publicKey } = clavePrueba();
  const zip = zipDePrueba(empaquetado, { manifest_version: 3, name: "ADACEEN", version: "0.7.20" });

  const { crx: bytes, id, clavePublica } = crx.crearCrx(zip, privateKey);
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  assert.ok(clavePublica.equals(spki), "la clave publica del CRX es la SPKI DER de la privada");
  assert.match(id, /^[a-p]{32}$/, "id como en chrome://extensions");
  assert.equal(id, crx.idDeExtension(spki));
  const hash = createHash("sha256").update(spki).digest();
  assert.equal(crx.idDeExtension(spki), [...hash.subarray(0, 16).toString("hex")].map((d) => String.fromCharCode(97 + parseInt(d, 16))).join(""));

  // Cabecera: "Cr24", version 3, tamano de la cabecera y el zip intacto al final.
  assert.equal(bytes.subarray(0, 4).toString("latin1"), "Cr24");
  assert.equal(bytes.readUInt32LE(4), 3);
  const largoCabecera = bytes.readUInt32LE(8);
  assert.ok(bytes.subarray(12 + largoCabecera).equals(zip), "el zip va completo despues de la cabecera");

  const leido = crx.leerCrx(bytes);
  assert.equal(leido.version, 3);
  assert.equal(leido.pruebas.length, 1);
  assert.ok(leido.pruebas[0].clavePublica.equals(spki));
  assert.ok(leido.crxId.equals(hash.subarray(0, 16)), "crx_id = primeros 16 bytes del SHA-256 de la clave");
  assert.ok(leido.zip.equals(zip));

  // La firma cubre "CRX3 SignedData\0" + len(signed_header_data) LE32 + signed_header_data + zip.
  const datos = Buffer.concat([Buffer.from("CRX3 SignedData\0", "latin1"), le32(leido.signedHeaderData.length), leido.signedHeaderData, zip]);
  assert.ok(verify("sha256", datos, publicKey, leido.pruebas[0].firma), "firma RSA PKCS#1 v1.5 con SHA-256");

  const verificado = crx.verificarCrx(bytes);
  assert.equal(verificado.id, id);
  assert.ok(verificado.zip.equals(zip));
  assert.deepEqual(Object.keys(empaquetado.leerZip(verificado.zip)).sort(), ["background.js", "manifest.json"]);

  // Cualquier byte cambiado del zip invalida la firma; otra clave en la cabecera no corresponde al crx_id.
  const alterado = Buffer.from(bytes);
  alterado[alterado.length - 1] ^= 0xff;
  assert.throws(() => crx.verificarCrx(alterado), /firma del CRX no es valida/);
  assert.throws(() => crx.leerCrx(Buffer.from("PK\u0003\u0004no-es-crx")), /Cr24/);
  const otraClave = clavePrueba();
  const otro = crx.crearCrx(zip, otraClave.privateKey);
  assert.notEqual(otro.id, id, "el id depende de la clave");
  assert.throws(() => crx.crearCrx(zip, generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey), /RSA/);

  const xml = crx.manifiestoActualizacion({ id, version: "0.7.20", codebase: "https://ejemplo.test/descargas/adaceen.crx" });
  assert.match(xml, /^<\?xml version='1\.0' encoding='UTF-8'\?>\n<gupdate xmlns='http:\/\/www\.google\.com\/update2\/response' protocol='2\.0'>/);
  assert.match(xml, new RegExp(`<app appid='${id}'>`));
  assert.match(xml, /<updatecheck codebase='https:\/\/ejemplo\.test\/descargas\/adaceen\.crx' version='0\.7\.20'\/>/);
  assert.throws(() => crx.manifiestoActualizacion({ id: "no-es-id", version: "1", codebase: "https://x" }), /Id de extension invalido/);
});

test("empaquetar-crx (programa): firma el zip con la clave del entorno; sin clave explica como crearla y sale con 2", async () => {
  const crx: Crx = await import("../../scripts/empaquetar-crx.mjs");
  const empaquetado: Empaquetado = await import("../../scripts/empaquetar-extension.mjs");
  const carpeta = await fsp.mkdtemp(path.join(os.tmpdir(), "adaceen-crx-"));
  try {
    const { privateKey, publicKey } = clavePrueba();
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
    const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
    const idEsperado = crx.idDeExtension(spki);
    const rutaZip = path.join(carpeta, "adaceen-chromium-0.7.20.zip");
    await fsp.writeFile(rutaZip, zipDePrueba(empaquetado, { manifest_version: 3, name: "ADACEEN", version: "0.7.20" }));
    const salida = path.join(carpeta, "salida");

    // Sin clave: codigo 2, el comando openssl, y no se escribe nada.
    const sinClave = correr(["--zip", rutaZip, "--salida", salida], { CRX_PRIVATE_KEY_PEM: undefined, CRX_PRIVATE_KEY_PEM_FILE: undefined });
    assert.equal(sinClave.status, 2, sinClave.stderr);
    assert.match(sinClave.stderr, /openssl genrsa -out adaceen-crx\.pem 2048/);
    assert.equal(await fsp.access(salida).then(() => true, () => false), false);

    // Clave por contenido (como el secreto del flujo) y URL del crx por variable.
    const conClave = correr(["--zip", rutaZip, "--salida", salida], {
      CRX_PRIVATE_KEY_PEM: pem,
      CRX_PRIVATE_KEY_PEM_FILE: undefined,
      CRX_CODEBASE_URL: "https://ejemplo.test/descargas/adaceen.crx",
    });
    assert.equal(conClave.status, 0, conClave.stderr);
    assert.match(conClave.stdout, new RegExp(`Id de la extension: ${idEsperado}`));
    assert.match(conClave.stdout, new RegExp(`ExtensionInstallForcelist: ${idEsperado};https://ejemplo\\.test/descargas/adaceen-update\\.xml`));
    const bytes = await fsp.readFile(path.join(salida, "adaceen-0.7.20.crx"));
    const verificado = crx.verificarCrx(bytes);
    assert.equal(verificado.id, idEsperado);
    assert.ok(verificado.clavePublica.equals(spki));
    assert.ok(verificado.zip.equals(await fsp.readFile(rutaZip)), "el CRX envuelve el zip tal cual");
    const xml = await fsp.readFile(path.join(salida, "adaceen-update.xml"), "utf8");
    assert.match(xml, new RegExp(`<app appid='${idEsperado}'>`));
    assert.match(xml, /codebase='https:\/\/ejemplo\.test\/descargas\/adaceen\.crx' version='0\.7\.20'/);

    // Clave por archivo y URL por defecto (la de /descargas/adaceen.crx del backend de Azure).
    const rutaPem = path.join(carpeta, "adaceen-crx.pem");
    await fsp.writeFile(rutaPem, pem);
    const porArchivo = correr(["--zip", rutaZip, "--salida", salida], { CRX_PRIVATE_KEY_PEM: undefined, CRX_PRIVATE_KEY_PEM_FILE: rutaPem, CRX_CODEBASE_URL: undefined });
    assert.equal(porArchivo.status, 0, porArchivo.stderr);
    assert.match(await fsp.readFile(path.join(salida, "adaceen-update.xml"), "utf8"), /codebase='https:\/\/app-adaceen-api-eyder05232002\.azurewebsites\.net\/descargas\/adaceen\.crx'/);

    // Con "key" en el manifest y otra clave PEM, avisa que el id del CRX no es el de la carpeta/zip.
    const manifestConKey = { manifest_version: 3, name: "ADACEEN", version: "0.7.20", key: clavePrueba().publicKey.export({ type: "spki", format: "der" }).toString("base64") };
    const rutaZipConKey = path.join(carpeta, "con-key.zip");
    await fsp.writeFile(rutaZipConKey, zipDePrueba(empaquetado, manifestConKey));
    const conKey = correr(["--zip", rutaZipConKey, "--salida", salida], { CRX_PRIVATE_KEY_PEM: pem, CRX_PRIVATE_KEY_PEM_FILE: undefined });
    assert.equal(conKey.status, 0, conKey.stderr);
    assert.match(conKey.stderr, /no es la del campo "key" del manifest/);

    // Sin el zip: error claro (codigo 1).
    const sinZip = correr(["--zip", path.join(carpeta, "no-existe.zip"), "--salida", salida], { CRX_PRIVATE_KEY_PEM: pem, CRX_PRIVATE_KEY_PEM_FILE: undefined });
    assert.equal(sinZip.status, 1);
    assert.match(sinZip.stderr, /empaquetar-extension\.mjs/);

    const ayuda = correr(["--help"], {});
    assert.equal(ayuda.status, 0);
    assert.match(ayuda.stdout, /CRX_PRIVATE_KEY_PEM_FILE/);
  } finally {
    await fsp.rm(carpeta, { recursive: true, force: true });
  }
});
