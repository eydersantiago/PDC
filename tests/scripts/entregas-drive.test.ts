import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

/**
 * Apps Script de las entregas en Drive (deploy/drive/entregas-drive.gs, 02-11-2026): se carga en un
 * contexto de node:vm sin los servicios de Google y se prueban sus funciones puras y la
 * sincronizacion con un almacen, un Drive y unas hojas de mentiras. Lo que el docente ve en Drive
 * lleva solo el codigo del analisis.
 */

type Json = Record<string, any>;

const RAIZ = process.cwd();
const SCRIPT = path.join(RAIZ, "deploy", "drive", "entregas-drive.gs");
const MANIFIESTO_APPS = path.join(RAIZ, "deploy", "drive", "appsscript.json");

function cargar() {
  const contexto: Json = {};
  vm.createContext(contexto);
  // const y let del archivo no quedan en el contexto: se exponen al final del mismo script.
  const exportar = "globalThis.__ = { ENTREGAS, HOJA_INDICE, HOJA_ULTIMO, HOJA_PROBLEMAS, validarConfig, normalizarPrefijo, urlListado, urlObjeto, partesDelObjeto, manifiestosPendientes, validarManifiesto, nombreDelZip, nombreDeCarpeta, fechaLegible, hexDeBytes, celdaSegura, filaIndice, filaUltimo, decidirUltimo, fechaDeRevision, mensajeDeAcceso, sincronizarCon_ };";
  vm.runInContext(`${fs.readFileSync(SCRIPT, "utf8")}\n${exportar}`, contexto, { filename: SCRIPT });
  return contexto.__ as Json;
}

const gs = cargar();
const PREFIJO = "entregas/";
const CODIGO = "0123456789abcdef0123";
const OBJETO = `${PREFIJO}sistema-bancario-fpoo/${CODIGO}/2026-11-02_1430.json`;
const ZIP = Buffer.from("PK\u0003\u0004 zip de prueba");
const SHA = createHash("sha256").update(ZIP).digest("hex");
const plano = (valor: unknown) => JSON.parse(JSON.stringify(valor));

function manifiesto(extra: Json = {}) {
  return { version: 1, taller: "sistema-bancario-fpoo", titulo: "Sistema bancario", codigo: CODIGO, fecha: "2026-11-02T14:30:05-05:00", sha256: SHA, bytes: ZIP.length, archivos: 7, avance: 42, compila: true, ...extra };
}

test("entregas en Drive: el manifiesto de Apps Script pide la zona de Bogota, V8 y solo los permisos del script", () => {
  const datos = JSON.parse(fs.readFileSync(MANIFIESTO_APPS, "utf8"));
  assert.equal(datos.timeZone, "America/Bogota");
  assert.equal(datos.runtimeVersion, "V8");
  assert.deepEqual([...datos.oauthScopes].sort(), [
    "https://www.googleapis.com/auth/devstorage.read_only",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/script.scriptapp",
    "https://www.googleapis.com/auth/spreadsheets",
  ]);
  const texto = fs.readFileSync(SCRIPT, "utf8");
  for (const funcion of ["instalar", "sincronizar", "desinstalar"]) assert.match(texto, new RegExp(`^function ${funcion}\\(\\)`, "m"), funcion);
  assert.match(texto, /LockService\.getScriptLock\(\)/);
  assert.match(texto, /everyMinutes\(ENTREGAS\.minutosEntreCorridas\)/);
  assert.equal(gs.ENTREGAS.minutosEntreCorridas, 30);
  assert.ok(gs.ENTREGAS.tiempoMaximoMs <= 5 * 60 * 1000, "para antes de los 6 minutos de Apps Script");
});

test("entregas en Drive: las propiedades del script se revisan (bucket, prefijo con barra, carpeta)", () => {
  const bien = gs.validarConfig({ BUCKET: "gs://adaceen-508504-adaceen-respaldos/", CARPETA_ID: "1AbC-dEf_ghIJklmnop" });
  assert.deepEqual(plano(bien), { ok: true, config: { bucket: "adaceen-508504-adaceen-respaldos", prefijo: "entregas/", carpetaId: "1AbC-dEf_ghIJklmnop", hojaId: "" } });
  assert.equal(gs.validarConfig({ BUCKET: "b-ok", PREFIJO: "otro/sub", CARPETA_ID: "1AbC-dEf_ghIJklmnop" }).config.prefijo, "otro/sub/");
  const mal = gs.validarConfig({ BUCKET: "Mal Bucket", PREFIJO: "../x", CARPETA_ID: "", HOJA_ID: "a b" });
  assert.equal(mal.ok, false);
  assert.equal(mal.errores.length, 4);
  assert.match(mal.errores.join(" "), /BUCKET.*PREFIJO.*CARPETA_ID.*HOJA_ID/);
  assert.equal(gs.normalizarPrefijo(undefined), "entregas/");
  assert.equal(gs.normalizarPrefijo("/entregas"), "entregas/");
  assert.equal(gs.normalizarPrefijo("a//b/"), "");
  assert.equal(gs.normalizarPrefijo("../x"), "");
  assert.equal(gs.normalizarPrefijo("x/../y"), "");
  assert.equal(gs.normalizarPrefijo("entregas.v2/"), "entregas.v2/");
});

test("entregas en Drive: URLs de la API JSON de Storage con el prefijo, la pagina y los campos", () => {
  const url = new URL(gs.urlListado("mi-bucket", "entregas/", "tok/en=", 0));
  assert.equal(url.origin + url.pathname, "https://storage.googleapis.com/storage/v1/b/mi-bucket/o");
  assert.equal(url.searchParams.get("prefix"), "entregas/");
  assert.equal(url.searchParams.get("pageToken"), "tok/en=");
  assert.equal(url.searchParams.get("fields"), "nextPageToken,items(name,size,updated)");
  assert.equal(url.searchParams.get("maxResults"), null);
  assert.equal(new URL(gs.urlListado("b", "p/", "", 1)).searchParams.get("maxResults"), "1");
  assert.equal(gs.urlObjeto("mi-bucket", OBJETO), `https://storage.googleapis.com/storage/v1/b/mi-bucket/o/${encodeURIComponent(OBJETO)}?alt=media`);
});

test("entregas en Drive: solo los manifiestos nuevos, en orden, con el tamano de su zip", () => {
  const zip = OBJETO.replace(/json$/, "zip");
  const otro = `${PREFIJO}sistema-bancario-fpoo/${CODIGO}/2026-11-02_1300.json`;
  const items = [
    { name: OBJETO, size: "300" },
    { name: zip, size: String(ZIP.length) },
    { name: otro, size: "300" },
    { name: `${PREFIJO}sistema-bancario-fpoo/${CODIGO}/2026-11-01_0900.json`, size: "300" },
    { name: `${PREFIJO}sistema-bancario-fpoo/login-no-codigo/2026-11-02_1430.json`, size: "1" },
    { name: "respaldos/ana/2026-11-02/1430.tar.gz", size: "9" },
    { name: `${PREFIJO}../fuera.json`, size: "1" },
  ];
  const pendientes = plano(gs.manifiestosPendientes(items, PREFIJO, [`${PREFIJO}sistema-bancario-fpoo/${CODIGO}/2026-11-01_0900.json`]));
  assert.deepEqual(pendientes, [
    { objeto: otro, zip: otro.replace(/json$/, "zip"), tamanoZip: null },
    { objeto: OBJETO, zip, tamanoZip: ZIP.length },
  ]);
  assert.deepEqual(plano(gs.partesDelObjeto(OBJETO, PREFIJO)), { taller: "sistema-bancario-fpoo", codigo: CODIGO, dia: "2026-11-02", hora: "1430", tipo: "json" });
  assert.equal(gs.partesDelObjeto(OBJETO, "otro/"), null);
});

test("entregas en Drive: el manifiesto se valida estricto y coincide con el nombre del objeto", () => {
  const bien = gs.validarManifiesto(manifiesto({ titulo: "Sistema\nbancario" }), OBJETO, PREFIJO);
  assert.equal(bien.ok, true, bien.motivo);
  assert.equal(bien.manifiesto.titulo, "Sistema bancario", "sin saltos de linea");
  assert.equal(gs.validarManifiesto(manifiesto({ compila: null }), OBJETO, PREFIJO).ok, true);
  const casos: Array<[Json, RegExp]> = [
    [{ version: 2 }, /version/],
    [{ codigo: "ana-gh" }, /codigo del analisis/],
    [{ codigo: "0123456789abcdef0124" }, /nombre del objeto/],
    [{ taller: "Otro Taller" }, /taller no es valido/],
    [{ taller: "otro-taller" }, /nombre del objeto/],
    [{ fecha: "2026-11-02" }, /fecha no es ISO/],
    [{ fecha: "2026-11-02T15:30:05-05:00" }, /fecha no es la del nombre/],
    [{ sha256: "abc" }, /SHA-256/],
    [{ bytes: 0 }, /bytes/],
    [{ bytes: 60 * 1024 * 1024 }, /bytes/],
    [{ archivos: 1.5 }, /archivos/],
    [{ avance: 101 }, /avance/],
    [{ avance: "42" }, /avance/],
    [{ compila: "si" }, /compila/],
  ];
  for (const [cambio, motivo] of casos) {
    const revisado = gs.validarManifiesto(manifiesto(cambio), OBJETO, PREFIJO);
    assert.equal(revisado.ok, false, JSON.stringify(cambio));
    assert.match(revisado.motivo, motivo, JSON.stringify(cambio));
  }
  assert.equal(gs.validarManifiesto([], OBJETO, PREFIJO).ok, false);
  assert.match(gs.validarManifiesto(manifiesto(), OBJETO.replace(/json$/, "zip"), PREFIJO).motivo, /nombre no es/);
});

test("entregas en Drive: nombres, fechas, filas de la hoja y la regla del ultimo por estudiante", () => {
  const m = gs.validarManifiesto(manifiesto({ titulo: "Taller/1: =SUMA" }), OBJETO, PREFIJO).manifiesto;
  assert.equal(gs.nombreDelZip(m), `2026-11-02 1430 · 42 % · ${SHA.slice(0, 12)}.zip`);
  assert.equal(gs.nombreDeCarpeta(m.titulo), "Taller-1: =SUMA");
  assert.equal(gs.fechaLegible(m.fecha), "2026-11-02 14:30");
  assert.equal(gs.hexDeBytes([-1, 0, 15, 127, -128]), "ff000f7f80", "computeDigest da bytes con signo");
  assert.equal(gs.celdaSegura("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(gs.celdaSegura("Sistema bancario"), "Sistema bancario");
  const enlaces = { zip: "https://drive/zip", carpeta: "https://drive/carpeta" };
  const indice = plano(gs.filaIndice(m, OBJETO, enlaces));
  assert.equal(indice.length, gs.HOJA_INDICE.columnas.length);
  assert.deepEqual(plano(gs.HOJA_INDICE.columnas), ["Fecha", "Código del análisis", "Taller", "Avance (%)", "Compila", "Archivos", "SHA-256", "Zip", "Carpeta", "Objeto"]);
  assert.deepEqual(indice, ["2026-11-02 14:30", CODIGO, "Taller/1: =SUMA", 42, "Sí", 7, SHA, enlaces.zip, enlaces.carpeta, OBJETO]);
  const ultimo = plano(gs.filaUltimo(m, enlaces));
  assert.equal(ultimo.length, gs.HOJA_ULTIMO.columnas.length);
  assert.equal(gs.HOJA_ULTIMO.nombre, "Último por estudiante");
  assert.deepEqual(plano(gs.decidirUltimo([], ultimo)), { accion: "agregar" });
  const viejo = [CODIGO, "Taller/1: =SUMA", "2026-11-02 13:00", "10"];
  assert.deepEqual(plano(gs.decidirUltimo([["otro", "x", "z"], viejo], ultimo)), { accion: "reemplazar", indice: 1 });
  assert.deepEqual(plano(gs.decidirUltimo([[CODIGO, "Taller/1: =SUMA", "2026-11-02 15:00"]], ultimo)), { accion: "nada" }, "uno mas nuevo no se pisa");
  assert.deepEqual(plano(gs.decidirUltimo([[CODIGO, "Otro taller", "2026-11-01 15:00"]], ultimo)), { accion: "agregar" }, "uno por codigo y taller");
  assert.equal(gs.fechaDeRevision(Date.parse("2026-11-02T19:30:00Z")), "2026-11-02 14:30");
  assert.match(gs.mensajeDeAcceso(403, "b", "entregas/"), /respaldos\.sh compartir/);
});

/** Un almacen, un Drive y unas hojas de mentiras para sincronizarCon_. */
function entorno(objetos: Map<string, Buffer | number>, opciones: { reloj?: () => number } = {}) {
  const hojas = { indice: [] as unknown[][], ultimo: [] as unknown[][], problemas: [] as unknown[][] };
  const drive: Array<{ partes: string[]; nombre: string; bytes: Buffer }> = [];
  return {
    hojas,
    drive,
    servicios: {
      ahora: opciones.reloj || (() => Date.parse("2026-11-02T20:00:00Z")),
      texto: (bytes: Buffer) => bytes.toString("utf8"),
      sha256: (bytes: Buffer) => [...createHash("sha256").update(bytes).digest()].map((b) => (b > 127 ? b - 256 : b)),
      almacen: {
        listar: (prefijo: string) => [...objetos.entries()].filter(([nombre]) => nombre.startsWith(prefijo))
          // Un objeto que responde un error (un numero) se lista con el tamano del zip de prueba.
          .map(([nombre, valor]) => ({ name: nombre, size: String(typeof valor === "number" ? ZIP.length : valor.length) })),
        leer: (nombre: string) => {
          const valor = objetos.get(nombre);
          if (valor === undefined) return { codigo: 404, bytes: null };
          if (typeof valor === "number") return { codigo: valor, bytes: null };
          return { codigo: 200, bytes: valor };
        },
      },
      drive: {
        guardarZip: (partes: string[], nombre: string, bytes: Buffer) => {
          drive.push({ partes, nombre, bytes });
          return { zip: `https://drive/${nombre}`, carpeta: `https://drive/${partes.join("/")}` };
        },
      },
      hojas: {
        objetosVistos: () => [...hojas.indice.map((fila) => String(fila[9])), ...hojas.problemas.map((fila) => String(fila[1]))],
        agregarAlIndice: (fila: unknown[]) => hojas.indice.push(fila),
        actualizarUltimo: (fila: unknown[]) => {
          const decision = gs.decidirUltimo(hojas.ultimo.map((actual) => actual.map(String)), fila);
          if (decision.accion === "agregar") hojas.ultimo.push(fila);
          if (decision.accion === "reemplazar") hojas.ultimo[decision.indice] = fila;
        },
        anotarProblema: (fila: unknown[]) => hojas.problemas.push(fila),
      },
    },
  };
}

const CONFIG = { bucket: "mi-bucket", prefijo: PREFIJO, carpetaId: "1AbC-dEf_ghIJklmnop", hojaId: "" };

test("entregas en Drive: sincronizar pasa cada zip nuevo a <titulo>/<codigo>/, verifica el SHA-256 y no repite", () => {
  const otraHora = `${PREFIJO}sistema-bancario-fpoo/${CODIGO}/2026-11-02_1530.json`;
  const otroZip = Buffer.from("PK otra entrega mas nueva");
  const objetos = new Map<string, Buffer | number>([
    [OBJETO, Buffer.from(JSON.stringify(manifiesto()))],
    [OBJETO.replace(/json$/, "zip"), ZIP],
    [otraHora, Buffer.from(JSON.stringify(manifiesto({ fecha: "2026-11-02T15:30:00-05:00", sha256: createHash("sha256").update(otroZip).digest("hex"), bytes: otroZip.length, avance: 60 })))],
    [otraHora.replace(/json$/, "zip"), otroZip],
  ]);
  const e = entorno(objetos);
  const resumen = plano(gs.sincronizarCon_(e.servicios, CONFIG));
  assert.deepEqual(resumen, { nuevas: 2, problemas: 0, reintentar: 0, cortado: false });
  assert.deepEqual(e.drive.map((d) => [d.partes.join("/"), d.nombre]), [
    [`Sistema bancario/${CODIGO}`, `2026-11-02 1430 · 42 % · ${SHA.slice(0, 12)}.zip`],
    [`Sistema bancario/${CODIGO}`, `2026-11-02 1530 · 60 % · ${createHash("sha256").update(otroZip).digest("hex").slice(0, 12)}.zip`],
  ]);
  assert.ok(e.drive[0].bytes.equals(ZIP));
  assert.equal(e.hojas.indice.length, 2);
  assert.equal(e.hojas.ultimo.length, 1, "una fila por codigo");
  assert.equal(e.hojas.ultimo[0][3], 60, "la mas reciente");
  // La segunda corrida no repite nada (el indice tiene los objetos).
  assert.deepEqual(plano(gs.sincronizarCon_(e.servicios, CONFIG)), { nuevas: 0, problemas: 0, reintentar: 0, cortado: false });
  assert.equal(e.drive.length, 2);
});

test("entregas en Drive: un SHA-256 distinto, un manifiesto invalido o sin zip van a «Problemas»; un error de red se reintenta", () => {
  const base = `${PREFIJO}sistema-bancario-fpoo/${CODIGO}`;
  const objetos = new Map<string, Buffer | number>([
    [`${base}/2026-11-02_1000.json`, Buffer.from(JSON.stringify(manifiesto({ fecha: "2026-11-02T10:00:00-05:00" })))],
    // Mismo tamano, otro contenido: lo que atrapa es el SHA-256.
    [`${base}/2026-11-02_1000.zip`, Buffer.from(ZIP.toString("latin1").replace("prueba", "prueBa"), "latin1")],
    [`${base}/2026-11-02_1100.json`, Buffer.from("{ no es json")],
    [`${base}/2026-11-02_1200.json`, Buffer.from(JSON.stringify(manifiesto({ fecha: "2026-11-02T12:00:00-05:00" })))],
    [`${base}/2026-11-02_1300.json`, Buffer.from(JSON.stringify(manifiesto({ fecha: "2026-11-02T13:00:00-05:00" })))],
    [`${base}/2026-11-02_1300.zip`, 503],
  ]);
  const e = entorno(objetos);
  const resumen = plano(gs.sincronizarCon_(e.servicios, CONFIG));
  assert.deepEqual(resumen, { nuevas: 0, problemas: 3, reintentar: 1, cortado: false });
  assert.deepEqual(e.hojas.problemas.map((fila) => [String(fila[1]).slice(-20), fila[2]]), [
    ["2026-11-02_1000.json", "el SHA-256 del zip no es el del manifiesto"],
    ["2026-11-02_1100.json", "el manifiesto no es JSON"],
    ["2026-11-02_1200.json", `falta el zip ${base}/2026-11-02_1200.zip`],
  ]);
  assert.equal(e.drive.length, 0, "nada sin verificar llega a Drive");
  // Lo anotado en «Problemas» no se vuelve a intentar; lo de la red, si.
  objetos.set(`${base}/2026-11-02_1300.zip`, ZIP);
  objetos.set(`${base}/2026-11-02_1300.json`, Buffer.from(JSON.stringify(manifiesto({ fecha: "2026-11-02T13:00:00-05:00" }))));
  assert.deepEqual(plano(gs.sincronizarCon_(e.servicios, CONFIG)), { nuevas: 1, problemas: 0, reintentar: 0, cortado: false });
});

test("entregas en Drive: sin permiso de lectura corta con el comando que falta; con poco tiempo sigue en la proxima", () => {
  const objetos = new Map<string, Buffer | number>([[OBJETO, 403], [OBJETO.replace(/json$/, "zip"), ZIP]]);
  assert.throws(() => gs.sincronizarCon_(entorno(objetos).servicios, CONFIG), /respaldos\.sh compartir/);
  // El reloj avanza 6 minutos por cada consulta: para despues de la primera.
  let ahora = 0;
  const lento = new Map<string, Buffer | number>([
    [OBJETO, Buffer.from(JSON.stringify(manifiesto()))],
    [OBJETO.replace(/json$/, "zip"), ZIP],
    [OBJETO.replace("1430", "1530"), Buffer.from("{}")],
  ]);
  const e = entorno(lento, { reloj: () => (ahora += 3 * 60 * 1000) });
  const resumen = plano(gs.sincronizarCon_(e.servicios, CONFIG));
  assert.equal(resumen.cortado, true);
  assert.equal(resumen.nuevas + resumen.problemas, 1);
});

test("entregas en Drive: un manifiesto y su zip como los arma respaldo-ws.py pasan la validacion del Apps Script", { skip: process.platform === "win32" && "respaldo-ws.py arma entregas en Linux" }, async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "adaceen-drive-"));
  try {
    mkdirSync(path.join(dir, "home", "ws-ana", "sistema-bancario-fpoo", "src"), { recursive: true });
    writeFileSync(path.join(dir, "home", "ws-ana", "sistema-bancario-fpoo", "src", "main.cpp"), "int main() { return 0; }\n");
    // Python arma la entrega con las funciones reales y en vez de subir la deja en un archivo.
    const codigo = `
import importlib.util, json, sys
from datetime import datetime
spec = importlib.util.spec_from_file_location("respaldo", ${JSON.stringify(path.join(RAIZ, "deploy", "gcp", "workspaces", "respaldo-ws.py"))})
r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)
r.HOMES = ${JSON.stringify(path.join(dir, "home"))}
subidas = {}
r.subir = lambda bucket, nombre, datos, token, espera, tipo="application/gzip": subidas.__setitem__(nombre, datos.hex())
import os; os.makedirs(${JSON.stringify(path.join(dir, "estado"))}, exist_ok=True)
opciones = {"prefijo": "entregas", "cada_min": 60, "al_apagar": True, "estado": ${JSON.stringify(path.join(dir, "estado"))}}
taller = {"taller": "sistema-bancario-fpoo", "titulo": "Sistema bancario", "carpeta": "sistema-bancario-fpoo"}
datos = {"codigo": "${CODIGO}", "avance": 42, "compila": None}
ahora = datetime(2026, 11, 2, 14, 30, 5, tzinfo=r.BOGOTA)
print(r.entregar_estudiante("b", opciones, taller, "ana", datos, ahora, lambda: "t", 5))
print(json.dumps(subidas))
`;
    const [estado, json] = execFileSync("python3", ["-c", codigo], { encoding: "utf8" }).trim().split("\n");
    assert.equal(estado, "subida");
    const subidas = JSON.parse(json) as Record<string, string>;
    const nombres = Object.keys(subidas).sort();
    assert.deepEqual(nombres, [OBJETO, OBJETO.replace(/json$/, "zip")]);
    const manifiestoPy = JSON.parse(Buffer.from(subidas[OBJETO], "hex").toString("utf8"));
    const zipPy = Buffer.from(subidas[OBJETO.replace(/json$/, "zip")], "hex");
    const revisado = gs.validarManifiesto(manifiestoPy, OBJETO, PREFIJO);
    assert.equal(revisado.ok, true, revisado.motivo);
    assert.equal(revisado.manifiesto.sha256, createHash("sha256").update(zipPy).digest("hex"));
    assert.equal(revisado.manifiesto.compila, null);
    assert.equal(gs.nombreDelZip(revisado.manifiesto), `2026-11-02 1430 · 42 % · ${revisado.manifiesto.sha256.slice(0, 12)}.zip`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
