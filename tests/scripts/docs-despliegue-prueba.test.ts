// Despliegue, prueba de inicio a fin y pendientes (docs/operacion/despliegue.md,
// docs/piloto/prueba-inicio-a-fin.md y docs/piloto/pendientes.md): lo que citan tiene
// que existir en el repositorio, para que no se queden atras cuando cambia algo.
//
// - Cada texto entre comillas angulares («…») esta en el codigo que lo muestra: las
//   extensiones, el backend, los scripts de deploy/ o el flujo de despliegue. "<...>"
//   es una parte que cambia y "…" un recorte; los tramos fijos van en orden y en un
//   mismo archivo. Los saltos de linea del Markdown cuentan como un espacio.
// - Las rutas del repositorio, los enlaces relativos, los anclas del mismo documento,
//   los `npm run …` y las variables de entorno existen.
// - La hoja data/piloto/plantillas/prueba-inicio-a-fin.csv tiene los mismos pasos que
//   el guion, y P1 va para las dos cuentas (criterio de cierre de ADACEEN-124).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const RAIZ = process.cwd();
const DESPLIEGUE = "docs/operacion/despliegue.md";
const PRUEBA = "docs/piloto/prueba-inicio-a-fin.md";
const PENDIENTES = "docs/piloto/pendientes.md";
const HOJA = "data/piloto/plantillas/prueba-inicio-a-fin.csv";
const DOCUMENTOS = [DESPLIEGUE, PRUEBA, PENDIENTES];

function leerRepo(ruta: string) {
  return fs.readFileSync(path.join(RAIZ, ruta), "utf8");
}

function listar(carpeta: string, acepta: (ruta: string) => boolean, excluir = new Set<string>()): string[] {
  if (!fs.existsSync(carpeta)) return [];
  const salida: string[] = [];
  for (const entrada of fs.readdirSync(carpeta, { withFileTypes: true })) {
    const ruta = path.join(carpeta, entrada.name);
    if (entrada.isDirectory()) {
      if (entrada.name !== "node_modules" && !excluir.has(entrada.name)) salida.push(...listar(ruta, acepta, excluir));
    } else if (acepta(ruta)) {
      salida.push(ruta);
    }
  }
  return salida;
}

// Los textos del codigo vienen como literales JS/TS o HTML: sin escapes ni entidades.
function normalizarCodigo(texto: string) {
  return texto
    .replace(/\\"/g, "\"")
    .replace(/\\'/g, "'")
    .replace(/&rarr;/g, "→")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

let corpusEnCache: string[] | null = null;
function corpus() {
  if (corpusEnCache) return corpusEnCache;
  const archivos = [
    ...listar(path.join(RAIZ, "browser-ext-prod"), (ruta) => /\.(js|html|json)$/.test(ruta)),
    ...listar(
      path.join(RAIZ, "vscode-ext-prod", "src"),
      (ruta) => ruta.endsWith(".ts") && !ruta.endsWith(".test.ts"),
      new Set(["test", "unit-tests"]),
    ),
    path.join(RAIZ, "vscode-ext-prod", "package.json"),
    ...listar(path.join(RAIZ, "src"), (ruta) => ruta.endsWith(".ts")),
    ...listar(path.join(RAIZ, "deploy"), (ruta) => /\.(sh|command|mjs)$/.test(ruta) && !ruta.endsWith(".test.mjs")),
    ...listar(path.join(RAIZ, ".github", "workflows"), (ruta) => /\.ya?ml$/.test(ruta)),
  ];
  corpusEnCache = archivos.filter((ruta) => fs.existsSync(ruta)).map((ruta) => normalizarCodigo(fs.readFileSync(ruta, "utf8")));
  return corpusEnCache;
}

export function tramosFijos(texto: string) {
  return texto
    .split(/<[^<>]+>|…/)
    .map((tramo) => tramo.trim())
    .filter((tramo) => tramo.length > 0);
}

/** Textos entre «», con los saltos de linea y la sangria del Markdown como un espacio. */
export function textosCitados(markdown: string) {
  const limpio = markdown.replace(/\\\|/g, "|");
  return [...new Set([...limpio.matchAll(/«([^«»]+)»/g)].map((match) => match[1].replace(/\s+/g, " ").trim()))];
}

export function aparece(texto: string, fuentes: string[]) {
  const tramos = tramosFijos(texto);
  if (!tramos.length) return false;
  return fuentes.some((fuente) => {
    let desde = 0;
    for (const tramo of tramos) {
      const donde = fuente.indexOf(tramo, desde);
      if (donde < 0) return false;
      desde = donde + tramo.length;
    }
    return true;
  });
}

// Rutas del repositorio citadas: no las que siguen dentro de una URL ni las plantillas
// con una parte variable (…-<fecha>.md).
const PREFIJOS_REPO = "(?:deploy|scripts|docs|data|src|tests|browser-ext-prod|vscode-ext-prod|\\.github)";
export function rutasDelRepo(markdown: string) {
  const rutas = new Set<string>();
  const patron = new RegExp(`(?<![\\w./~-])(${PREFIJOS_REPO}/[A-Za-z0-9._/-]+)`, "g");
  for (const match of markdown.matchAll(patron)) {
    const siguiente = markdown[(match.index ?? 0) + match[0].length] || "";
    if (siguiente === "<" || siguiente === "*") continue;
    rutas.add(match[1].replace(/[.,;:)]+$/, "").replace(/\/+$/, ""));
  }
  return [...rutas];
}

// Ancla al estilo de GitHub: minusculas, sin puntuacion, espacios a guiones.
export function ancla(titulo: string) {
  return titulo
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

function leerCsv(texto: string) {
  const filas: string[][] = [];
  // \r?\n: en un clon de Windows con core.autocrlf=true la hoja llega con CRLF.
  for (const linea of texto.split(/\r?\n/).filter((l) => l.length > 0)) {
    const celdas: string[] = [];
    let actual = "";
    let entreComillas = false;
    for (let i = 0; i < linea.length; i += 1) {
      const c = linea[i];
      if (entreComillas) {
        if (c === "\"" && linea[i + 1] === "\"") {
          actual += "\"";
          i += 1;
        } else if (c === "\"") {
          entreComillas = false;
        } else {
          actual += c;
        }
      } else if (c === "\"") {
        entreComillas = true;
      } else if (c === ",") {
        celdas.push(actual);
        actual = "";
      } else {
        actual += c;
      }
    }
    celdas.push(actual);
    filas.push(celdas);
  }
  return filas;
}

test("docs de despliegue y prueba: ayudas del chequeo", () => {
  assert.deepEqual(textosCitados("Pulsa «Empieza con\n  ADACEEN» y «Salir \\| otro»."), ["Empieza con ADACEEN", "Salir | otro"]);
  assert.deepEqual(tramosFijos("ADACEEN: <nombre>"), ["ADACEEN:"]);
  assert.equal(aparece("Hola <x>, adios", ["`Hola ${x}, adios`"]), true);
  assert.equal(aparece("Hola <x>, adios", ["adios", "Hola"]), false);
  assert.deepEqual(
    rutasDelRepo("`deploy/clase.sh`, https://x/eydersantiago/vscode-ext-prod/abc/a.vsix y docs/evidencias/v-<fecha>.md."),
    ["deploy/clase.sh"],
  );
  assert.equal(ancla("0. Antes de empezar (PowerShell)"), "0-antes-de-empezar-powershell");
  assert.equal(ancla("8.2 Ejecución manual del flujo (no usar)"), "82-ejecución-manual-del-flujo-no-usar");
  assert.equal(ancla("4.3 Rama, token del agente y `startup-ws.sh`"), "43-rama-token-del-agente-y-startup-wssh");
  assert.deepEqual(leerCsv("a,\"b, c\",\"d \"\"e\"\"\"\n"), [["a", "b, c", "d \"e\""]]);
  assert.deepEqual(leerCsv("a,b\r\nc,\r\n"), [["a", "b"], ["c", ""]]);
});

test("docs de despliegue y prueba: cada texto entre «» existe en el codigo", () => {
  const fuentes = corpus();
  assert.ok(fuentes.length > 60, "no se encontraron los fuentes (¿falta el submodulo vscode-ext-prod?)");
  const faltan: string[] = [];
  let total = 0;
  for (const documento of DOCUMENTOS) {
    const textos = textosCitados(leerRepo(documento));
    total += textos.length;
    for (const texto of textos) {
      if (!aparece(texto, fuentes)) faltan.push(`${documento}: «${texto}»`);
    }
  }
  assert.ok(total >= 80, `los documentos citan solo ${total} textos entre «»`);
  assert.deepEqual(faltan, [], `Textos que no estan en el codigo (o citalos sin «» si no son de ADACEEN):\n${faltan.join("\n")}`);
});

test("docs de despliegue y prueba: rutas, enlaces, anclas, scripts y variables existen", () => {
  const raizScripts = JSON.parse(leerRepo("package.json")).scripts as Record<string, string>;
  const vscodeScripts = JSON.parse(leerRepo("vscode-ext-prod/package.json")).scripts as Record<string, string>;
  const configuracion = [
    leerRepo("src/config/env.ts"),
    leerRepo(".env.example"),
    ...listar(path.join(RAIZ, "deploy"), (ruta) => /\.(sh|command|mjs)$/.test(ruta)).map((ruta) => fs.readFileSync(ruta, "utf8")),
    ...listar(path.join(RAIZ, ".github", "workflows"), (ruta) => /\.ya?ml$/.test(ruta)).map((ruta) => fs.readFileSync(ruta, "utf8")),
  ].join("\n");
  const problemas: string[] = [];

  for (const documento of [...DOCUMENTOS, HOJA]) {
    const texto = leerRepo(documento);
    for (const ruta of rutasDelRepo(texto)) {
      if (!fs.existsSync(path.join(RAIZ, ruta))) problemas.push(`${documento}: la ruta ${ruta} no existe`);
    }
    for (const match of texto.matchAll(/npm run ([\w:.-]+)/g)) {
      const script = match[1];
      if (!(script in raizScripts) && !(script in vscodeScripts)) problemas.push(`${documento}: no existe el script npm ${script}`);
    }
    if (!documento.endsWith(".md")) continue;

    const anclas = new Set([...texto.matchAll(/^#{1,6} (.+)$/gm)].map((match) => ancla(match[1])));
    for (const match of texto.matchAll(/\]\(([^)\s]+)\)/g)) {
      const destino = match[1];
      if (/^[a-z]+:/.test(destino)) continue;
      if (destino.startsWith("#")) {
        if (!anclas.has(destino.slice(1))) problemas.push(`${documento}: no hay titulo para el ancla ${destino}`);
        continue;
      }
      const archivo = path.resolve(path.dirname(path.join(RAIZ, documento)), destino.split("#")[0]);
      if (!fs.existsSync(archivo)) problemas.push(`${documento}: enlace roto ${destino}`);
    }
    for (const match of texto.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?:=[^`]*)?`/g)) {
      const variable = match[1];
      if (!configuracion.includes(variable)) problemas.push(`${documento}: la variable ${variable} no aparece en env.ts, .env.example, deploy/ ni el flujo`);
    }
  }
  assert.deepEqual(problemas, [], problemas.join("\n"));
});

test("prueba de inicio a fin: la hoja tiene los pasos del guion y P1 para las dos cuentas", () => {
  const guion = leerRepo(PRUEBA);
  const filas = leerCsv(leerRepo(HOJA));
  const [cabecera, ...datos] = filas;
  assert.deepEqual(cabecera, [
    "paso", "cuenta", "equipo", "accion", "resultado_esperado",
    "hora_inicio", "hora_fin", "minutos", "resultado", "texto_observado", "evidencia", "observaciones",
  ]);
  for (const fila of datos) {
    assert.equal(fila.length, cabecera.length, `fila ${fila[0]} con ${fila.length} columnas`);
    assert.ok(fila.slice(5).every((celda) => celda === ""), `la fila ${fila[0]} de la plantilla debe venir sin resultados`);
  }
  const pasosGuion = new Set([...guion.matchAll(/^\| (P\d\.\d) \|/gm)].map((match) => match[1]));
  const pasosHoja = new Set(datos.map((fila) => fila[0]));
  assert.ok(pasosGuion.size >= 30, `el guion tiene solo ${pasosGuion.size} pasos en sus tablas`);
  assert.deepEqual([...pasosHoja].sort(), [...pasosGuion].sort(), "los pasos de la hoja y los del guion no coinciden");
  for (const paso of ["P1.1", "P1.2", "P1.3", "P1.4", "P1.5", "P1.6", "P1.7"]) {
    for (const cuenta of ["E1", "E2"]) {
      assert.ok(datos.some((fila) => fila[0] === paso && fila[1] === cuenta), `falta ${paso} para ${cuenta} en la hoja`);
    }
  }
});
