import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

function readPopupOrder(): string[] {
  return [...readExtFile("popup/popup.html").matchAll(/<script src="([^"]+)"/g)].map((m) => `popup/${m[1]}`);
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

test("browser-ext: popup sin duplicados, sin nombres indefinidos ni referencias adelantadas", () => {
  const popupOrder = readPopupOrder();
  assert.deepEqual([...popupOrder].sort(), listJsFiles("popup"));
  assertGroupStructure("popup", popupOrder);
});

test("browser-ext: background y content script sin nombres indefinidos", () => {
  assertGroupStructure("background", ["background.js"]);
  assertGroupStructure("content", ["content.js"]);
});
