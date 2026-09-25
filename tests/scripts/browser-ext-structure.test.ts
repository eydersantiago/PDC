import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { PRIVACY_POLICY_VERSION } from "../../src/routes/privacy-policy-routes.js";

/**
 * La extension de navegador son scripts clasicos (sin modulos) que comparten un
 * unico scope global. Estas pruebas detectan los errores tipicos de esa
 * fragmentacion antes de cargar la extension en Chrome:
 *  - listas de carga desincronizadas (manifest.json vs background.js) o archivos huerfanos,
 *  - la misma funcion/constante declarada en dos archivos (la ultima pisa a la primera),
 *  - nombres usados que no existen en ningun archivo del grupo,
 *  - codigo ejecutado al cargar que usa algo definido en un archivo posterior.
 */

const EXT_ROOT = fileURLToPath(new URL("../../browser-ext-prod/", import.meta.url));
const VIRTUAL_GLOBALS = path.join(EXT_ROOT, "__adaceen_globals.d.ts");
const VIRTUAL_GLOBALS_SOURCE = "declare const chrome: any;\ndeclare const browser: any;\n";

type DeclarationKind = "function" | "class" | "const" | "let" | "var";
type Declaration = { name: string; kind: DeclarationKind; file: string; line: number; index: number };

function readExtFile(rel: string) {
  return fs.readFileSync(path.join(EXT_ROOT, rel), "utf8");
}

function readManifestOrder(): string[] {
  const manifest = JSON.parse(readExtFile("manifest.json"));
  return manifest.content_scripts[0].js;
}

function readBackgroundOrder(): string[] {
  const match = readExtFile("background.js").match(/const CONTENT_SCRIPT_FILES = \[([\s\S]*?)\];/);
  assert.ok(match, "background.js debe declarar CONTENT_SCRIPT_FILES");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function listJsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(EXT_ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(rel));
    else if (entry.name.endsWith(".js")) out.push(rel);
  }
  return out.sort();
}

function parse(rel: string) {
  return ts.createSourceFile(rel, readExtFile(rel), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
}

function bindingNames(name: ts.BindingName, out: string[]) {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) bindingNames(element.name, out);
  }
}

function topLevelDeclarations(source: ts.SourceFile, index: number): Declaration[] {
  const out: Declaration[] = [];
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      out.push({ name: statement.name.text, kind: "function", file: source.fileName, line: line(statement), index });
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      out.push({ name: statement.name.text, kind: "class", file: source.fileName, line: line(statement), index });
    } else if (ts.isVariableStatement(statement)) {
      const flags = statement.declarationList.flags;
      const kind: DeclarationKind = flags & ts.NodeFlags.Const ? "const" : flags & ts.NodeFlags.Let ? "let" : "var";
      for (const declaration of statement.declarationList.declarations) {
        const names: string[] = [];
        bindingNames(declaration.name, names);
        names.forEach((name) => out.push({ name, kind, file: source.fileName, line: line(declaration), index }));
      }
    }
  }
  return out;
}

function isReferenceIdentifier(node: ts.Identifier) {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if (ts.isParameter(parent) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name === node) return false;
  if (ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) return parent.name !== node;
  return true;
}

/** Identificadores evaluados al cargar el archivo (fuera de cualquier funcion o clase). */
function loadTimeReferences(source: ts.SourceFile) {
  const out: { name: string; line: number }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isIdentifier(node) && isReferenceIdentifier(node)) {
      out.push({ name: node.text, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  source.statements.forEach(visit);
  return out;
}

function unresolvedNames(files: string[]) {
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    types: [],
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const baseGetSourceFile = host.getSourceFile;
  const baseFileExists = host.fileExists;
  const baseReadFile = host.readFile;
  host.fileExists = (fileName) => fileName === VIRTUAL_GLOBALS || baseFileExists(fileName);
  host.readFile = (fileName) => (fileName === VIRTUAL_GLOBALS ? VIRTUAL_GLOBALS_SOURCE : baseReadFile(fileName));
  host.getSourceFile = (fileName, languageVersion, onError) => fileName === VIRTUAL_GLOBALS
    ? ts.createSourceFile(fileName, VIRTUAL_GLOBALS_SOURCE, languageVersion, true)
    : baseGetSourceFile(fileName, languageVersion, onError);

  const program = ts.createProgram([...files.map((f) => path.join(EXT_ROOT, f)), VIRTUAL_GLOBALS], options, host);
  return ts.getPreEmitDiagnostics(program)
    .filter((d) => d.code === 2304 || d.code === 2552)
    .map((d) => {
      const where = d.file ? `${path.relative(EXT_ROOT, d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}` : "?";
      return `${where} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
    });
}

function assertGroupStructure(label: string, files: string[]) {
  const sources = files.map(parse);
  const declarations = sources.flatMap(topLevelDeclarations);
  const byName = new Map<string, Declaration[]>();
  for (const declaration of declarations) {
    const list = byName.get(declaration.name) || [];
    list.push(declaration);
    byName.set(declaration.name, list);
  }

  const duplicates = [...byName.values()]
    .filter((list) => list.length > 1)
    .map((list) => list.map((d) => `${d.file}:${d.line} (${d.kind})`).join(" y "));
  assert.deepEqual(duplicates, [], `${label}: declaraciones duplicadas entre archivos`);

  const forwardAtLoad: string[] = [];
  sources.forEach((source, index) => {
    for (const ref of loadTimeReferences(source)) {
      const later = (byName.get(ref.name) || []).find((d) => d.index > index);
      if (later) {
        forwardAtLoad.push(`${source.fileName}:${ref.line} usa ${ref.name} al cargar, pero se define en ${later.file}:${later.line}`);
      }
    }
  });
  assert.deepEqual([...new Set(forwardAtLoad)], [], `${label}: referencias en tiempo de carga a archivos posteriores`);

  assert.deepEqual(unresolvedNames(files), [], `${label}: nombres sin definicion`);
}

test("browser-ext: manifest y background cargan los mismos content scripts en el mismo orden", () => {
  const manifestOrder = readManifestOrder();
  assert.deepEqual(readBackgroundOrder(), manifestOrder);
  for (const rel of manifestOrder) {
    assert.ok(fs.existsSync(path.join(EXT_ROOT, rel)), `falta ${rel}`);
  }
  const overlayFiles = [...listJsFiles("state"), ...listJsFiles("overlay"), ...listJsFiles("services")].sort();
  assert.deepEqual([...manifestOrder].sort(), overlayFiles, "todo .js de state/overlay/services debe estar en manifest.json");
});

test("browser-ext: overlay sin duplicados, sin nombres indefinidos ni referencias adelantadas", () => {
  assertGroupStructure("overlay", readManifestOrder());
});

test("browser-ext: background sin nombres indefinidos", () => {
  assertGroupStructure("background", ["background.js"]);
});

/**
 * El popup y content.js eran codigo muerto (auditoria de redundancias, item 12): manifest.json no
 * declara default_popup (el icono abre el overlay desde background.js). Se borraron; esta prueba
 * evita que vuelvan al paquete o que algo empaquetado los referencie.
 */
test("browser-ext: sin popup ni content.js en el paquete, y nada los carga", async () => {
  const manifest = JSON.parse(readExtFile("manifest.json"));
  assert.equal(manifest.action?.default_popup, undefined, "el icono abre el overlay, no un popup");
  const empaquetado = await import("../../scripts/empaquetar-extension.mjs");
  const archivos: string[] = empaquetado.listarArchivos(empaquetado.CARPETA_EXTENSION);
  assert.deepEqual(archivos.filter((rel) => rel.startsWith("popup/") || rel === "content.js"), [], "fuera del zip");
  for (const rel of ["background.js", "overlay/content-lifecycle.js", "inicio/pagina-inicio.content.js", "icon-128.png"]) {
    assert.ok(archivos.includes(rel), `${rel} va en el paquete`);
  }
  assert.deepEqual(empaquetado.validarManifest(manifest, archivos), [], "el manifest valida sin el popup ni content.js");
  const referencias = archivos
    .filter((rel) => /\.(js|json|html)$/.test(rel))
    .filter((rel) => /popup\/|(^|[\s"'/])content\.js/.test(readExtFile(rel)));
  assert.deepEqual(referencias, [], "nada de lo empaquetado referencia popup/ ni content.js");
  // Si el manifest volviera a declarar el popup, el empaquetado lo rechaza.
  const conPopup = { ...manifest, action: { ...manifest.action, default_popup: "popup/popup.html" } };
  assert.match(empaquetado.validarManifest(conPopup, archivos).join(" "), /default_popup/);
});

/**
 * Segunda entrada de content_scripts (acceso simplificado, seccion 4): un script minimo y
 * aislado que solo corre en /empezar del backend para avisar que la extension esta instalada.
 * La primera entrada (el overlay) conserva sus reglas: nada del overlay entra aqui y nada de
 * aqui entra en el overlay. El /empezar del backend local lo agrega solo la variante -dev
 * (scripts/empaquetar-extension.mjs --dev), como los hosts locales (A12.7).
 */
const START_PAGE_MATCHES = ["https://app-adaceen-api-eyder05232002.azurewebsites.net/empezar*"];

test("browser-ext: la pagina /empezar tiene su propio content script minimo y aislado", () => {
  const manifest = JSON.parse(readExtFile("manifest.json"));
  const groups: Array<{ matches: string[]; js: string[]; css?: string[]; all_frames?: boolean }> = manifest.content_scripts;
  assert.equal(groups.length, 2, "solo el overlay y la deteccion de /empezar");

  const [overlay, startPage] = groups;
  assert.deepEqual(
    overlay.matches.filter((match) => match.includes("azurewebsites.net") || !match.startsWith("https://")),
    [],
    "el overlay no corre en el backend ni en http",
  );
  assert.deepEqual([...startPage.matches].sort(), [...START_PAGE_MATCHES].sort(), "solo /empezar del backend de produccion");
  assert.deepEqual(startPage.js, ["inicio/pagina-inicio.content.js"]);
  assert.equal(startPage.css, undefined, "sin estilos en /empezar");
  assert.notEqual(startPage.all_frames, true, "solo el marco principal");
  assert.deepEqual(listJsFiles("inicio"), startPage.js, "todo .js de inicio/ va en la segunda entrada");
  assert.deepEqual(overlay.js.filter((rel) => startPage.js.includes(rel)), [], "el overlay no carga el script de /empezar");
  assertGroupStructure("pagina-inicio", startPage.js);

  const source = readExtFile("inicio/pagina-inicio.content.js");
  assert.match(source, /dataset\.adaceenExtension\s*=/, "marca data-adaceen-extension");
  assert.match(source, /type:\s*"adaceen:extension"/, "avisa con window.postMessage");
  assert.match(source, /postMessage\([^)]*location\.origin\)/, "el mensaje va solo al mismo origen");
  assert.doesNotMatch(source, /sessionId|chrome\.storage|fetch\(/, "no lee sesion, storage ni red");
});

/**
 * Seguridad del overlay (A12.8): ningun script de la extension ejecuta texto como codigo.
 * Se revisa el AST (no el texto), asi que comentarios y cadenas no dan falsos positivos.
 */
function dynamicCodeSinks(rel: string) {
  const source = parse(rel);
  const out: string[] = [];
  const where = (node: ts.Node) => `${rel}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  const calleeName = (callee: ts.Expression) => {
    if (ts.isIdentifier(callee)) return callee.text;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
      return callee.argumentExpression.text;
    }
    return "";
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = calleeName(node.expression);
      if (name === "eval" || name === "Function") {
        out.push(`${where(node)} usa ${name}`);
      }
      const first = node.arguments?.[0];
      if ((name === "setTimeout" || name === "setInterval")
        && first
        && (ts.isStringLiteralLike(first) || ts.isTemplateExpression(first))) {
        out.push(`${where(node)} usa ${name} con codigo en texto`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

test("browser-ext: sin eval, new Function ni temporizadores con codigo en texto (A12.8)", () => {
  const files = [
    ...listJsFiles("state"),
    ...listJsFiles("overlay"),
    ...listJsFiles("services"),
    ...listJsFiles("inicio"),
    "background.js",
  ];
  assert.deepEqual(files.flatMap(dynamicCodeSinks), [], "ejecucion dinamica de codigo prohibida en la extension");
});

test("browser-ext: el manifest de produccion pide permisos minimos (A12.7)", () => {
  const manifest = JSON.parse(readExtFile("manifest.json"));
  const hosts: string[] = manifest.host_permissions || [];
  assert.deepEqual(hosts.filter((host) => !host.startsWith("https://")), [], "hosts sin https (localhost va solo en la variante -dev)");
  const contentMatches: string[] = (manifest.content_scripts || []).flatMap((group: { matches?: string[] }) => group.matches || []);
  assert.deepEqual(
    contentMatches.filter((match) => !match.startsWith("https://")),
    [],
    "content_scripts sin http (el /empezar local va solo en la variante -dev)",
  );
  assert.deepEqual(hosts.filter((host) => host.includes("*.azurewebsites.net")), [], "nada de comodines de azurewebsites.net");
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ["activeTab", "identity", "scripting", "storage"],
    "un permiso nuevo debe justificarse en docs/seguridad/permisos-extension.md y aqui",
  );
  const stateVersion = readExtFile("state/session.state.js").match(/ADACEEN_BROWSER_EXTENSION_VERSION = "([^"]+)"/);
  assert.equal(stateVersion?.[1], manifest.version, "la version del overlay debe coincidir con manifest.json");
});

test("browser-ext: la version de la politica de privacidad es la del backend (contrato (a))", () => {
  // Si no coinciden, privacy.version del backend nunca es la de la extension y «Aceptar y
  // continuar» vuelve en cada navegador (y el POST con la version vieja no lo arregla).
  const match = readExtFile("state/session.state.js").match(/const ADACEEN_PRIVACY_POLICY_VERSION = "([^"]+)";/);
  assert.ok(match, "session.state.js declara ADACEEN_PRIVACY_POLICY_VERSION");
  assert.equal(match[1], PRIVACY_POLICY_VERSION, "cambia ADACEEN_PRIVACY_POLICY_VERSION junto con PRIVACY_POLICY_VERSION");
});
