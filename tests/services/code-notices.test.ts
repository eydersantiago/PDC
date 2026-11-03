import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import {
  CODE_NOTICE_FILE_PATH_MAX,
  CODE_NOTICE_IDS,
  CODE_NOTICE_PATHS_MAX,
  CODE_NOTICE_TEXT_MAX,
  CODE_NOTICES,
  CODE_NOTICES_MAX,
  fitFileList,
  isCFamilySource,
  sanitizeCodeNotices,
  studentNoticeText,
  teacherNoticeText,
  tutorNoticeIds,
  tutorNoticeInstruction,
} from "../../src/services/code-notices.js";
import { editorCodeLines, stripLineGutter } from "../../src/services/editor-context.js";
import {
  buildCursorSelectionSuggestionPrompt,
  buildFileSummarySuggestionPrompt,
  buildTabSuggestionPrompt,
} from "../../src/services/tab-suggestion-prompt.js";

/**
 * Avisos del revisor automatico (02-11-2026, el caso de Alan): «Class Cliente» con mayuscula no es
 * C++ y su avance sale en 0 %. La VM lo sigue puntuando asi, pero el estudiante lo lee en VS Code,
 * el docente en el monitor y el tutor se lo dice primero si lo ve en el codigo abierto. Codigo
 * ficticio (el repositorio es publico: nada de la solucion del taller).
 */

const CODE_HEADER = "Codigo del archivo activo (lineas 1-6 de 6):";

function numbered(lines: string[], focus: number[] = []) {
  return lines.map((line, index) => `${String(index + 1).padStart(2)}${focus.includes(index + 1) ? ">" : " "}| ${line}`.trimEnd()).join("\n");
}

const WITH_CAPITAL = ["#pragma once", "#include <string>", "Class Cliente {", "    std::string nombre;", "public:", "};"];

test("avisos: el texto del estudiante y del docente nombra los archivos, cabe en 160 y se acorta con gracia", () => {
  const one = studentNoticeText({ id: "class-mayuscula", paths: ["src/modelo/Cliente.h"] });
  assert.match(one, /^Escribe class en minúscula en Cliente\.h: C\+\+ no reconoce Class/);
  assert.ok(one.length <= CODE_NOTICE_TEXT_MAX, `${one.length}`);
  const two = studentNoticeText({ id: "class-mayuscula", paths: ["src/modelo/Cliente.h", "src/modelo/Cuenta.h"] });
  assert.match(two, / en Cliente\.h y Cuenta\.h: /);
  const many = Array.from({ length: 6 }, (_, index) => `src/modelo/ClaseConNombreLargo${index + 1}.h`);
  for (const id of CODE_NOTICE_IDS) {
    const fitted = studentNoticeText({ id, paths: many });
    assert.ok(fitted.length <= CODE_NOTICE_TEXT_MAX, fitted);
    assert.match(fitted, / y \d más: /, `${id}: los que no caben se cuentan`);
    assert.ok(teacherNoticeText({ id, paths: many }).length <= CODE_NOTICE_TEXT_MAX, id);
  }
  assert.match(studentNoticeText({ id: "class-mayuscula", paths: [] }), / en tus archivos: /);
  assert.match(teacherNoticeText({ id: "class-mayuscula", paths: ["Cliente.h"] }), /^Escribió Class con mayúscula en Cliente\.h/);
  // Struct tiene su propio aviso, con su palabra.
  assert.equal(studentNoticeText({ id: "struct-mayuscula", paths: ["Punto.h"] }), "Escribe struct en minúscula en Punto.h: C++ no reconoce Struct, así que no compila y esas estructuras no cuentan en tu avance.");
  assert.match(teacherNoticeText({ id: "struct-mayuscula", paths: ["Punto.h"] }), /^Escribió Struct con mayúscula en Punto\.h: .*\(C\+\+ solo reconoce struct\)\.$/);
  // Un id que no es del catalogo no compila (CodeNoticeId es una union); en ejecucion da "".
  // @ts-expect-error "no-existe" no es un CodeNoticeId
  assert.equal(studentNoticeText({ id: "no-existe", paths: [] }), "");
  // Ni un nombre cabe: va el texto de respaldo.
  assert.equal(fitFileList(["x".repeat(300)], (list) => `En ${list}.`, "tus archivos", 40), "En tus archivos.");
  for (const notice of CODE_NOTICES) assert.match(notice.id, /^[a-z0-9-]{1,34}$/, "con el prefijo aviso- cabe en los 40 de VS Code");
});

test("avisos: del informe solo se aceptan ids del catalogo, sin repetir, con archivos validos y topes", () => {
  assert.deepEqual(sanitizeCodeNotices(undefined), []);
  assert.deepEqual(sanitizeCodeNotices("class-mayuscula"), []);
  assert.deepEqual(sanitizeCodeNotices([
    { id: "otro-aviso", paths: ["a.h"] },
    { id: "class-mayuscula", paths: ["a.h", "a.h", "b\nc.h", 3, "x".repeat(121), " Cuenta.h ", "c.h", "d.h", "e.h", "f.h", "g.h"] },
    { id: "class-mayuscula", paths: ["otro.h"] },
    { id: "struct-mayuscula", files: ["el nombre viejo del campo no vale"] },
    null,
  ]), [
    { id: "class-mayuscula", paths: ["a.h", "Cuenta.h", "c.h", "d.h", "e.h", "f.h"] },
    { id: "struct-mayuscula", paths: [] },
  ]);
});

test("avisos: el tutor lo ve en C/C++ sin contar comentarios, textos ni class en minuscula", () => {
  const lines = (texts: string[]) => texts.map((text, index) => ({ line: index + 1, text }));
  const found = tutorNoticeInstruction({ languageHint: "cpp", lines: lines(WITH_CAPITAL) });
  assert.match(found, /^Aviso del revisor automatico: en la linea 3 escribio "Class Cliente" con mayuscula; en C\+\+ la palabra clave es class en minuscula/);
  assert.match(found, /Diselo primero, en una frase, antes de las demas sugerencias\.$/);
  // STRUCT (su propio aviso), con la llave en la linea siguiente.
  assert.match(tutorNoticeInstruction({ languageHint: "cpp", lines: lines(["STRUCT Punto", "{", "};"]) }), /"STRUCT Punto".*la palabra clave es struct/);
  assert.deepEqual(tutorNoticeIds({ languageHint: "cpp", lines: lines(["STRUCT Punto {};", "Class A {};"]) }), ["class-mayuscula", "struct-mayuscula"]);
  assert.match(tutorNoticeInstruction({ languageHint: "cpp", lines: lines(["Class Ahorros : public Cuenta {", "};"]) }), /"Class Ahorros"/);
  // Varias lineas: a lo sumo 3 numeros.
  const four = lines(["Class A {};", "Class B {};", "Class C {};", "Class D {};"]);
  assert.match(tutorNoticeInstruction({ languageHint: "cpp", lines: four }), /en las lineas 1, 2 y 3 escribio "Class A"/);
  // Sin numeros reales (codigo suelto): sin linea.
  assert.match(tutorNoticeInstruction({ languageHint: "cpp", lines: [{ line: null, text: "Class X {" }] }), /^Aviso del revisor automatico: en su codigo escribio "Class X"/);
  // Lo que no avisa.
  for (const code of [
    ["class Cliente {", "};"],
    ["// Class Cliente {", "};"],
    ["/* Class Cliente {", "   Class Cuenta { */", "class Cliente {};"],
    ["const char* s = \"Class Cliente {\";"],
    ["Class::metodo();"],
    ["int Class = 3;"],
  ]) {
    assert.equal(tutorNoticeInstruction({ languageHint: "cpp", lines: lines(code) }), "", code.join(" / "));
  }
  // Solo C y C++: por el lenguaje o, sin el, por la extension del archivo.
  assert.equal(tutorNoticeInstruction({ languageHint: "java", lines: lines(WITH_CAPITAL) }), "");
  assert.equal(tutorNoticeInstruction({ languageHint: "", fileName: "notas.txt", lines: lines(WITH_CAPITAL) }), "");
  assert.notEqual(tutorNoticeInstruction({ languageHint: "", fileName: "src/modelo/Cliente.h", lines: lines(WITH_CAPITAL) }), "");
  assert.equal(isCFamilySource({ languageHint: "C" }), true);
  assert.equal(isCFamilySource({ languageHint: "hpp" }), true);
  assert.equal(isCFamilySource({ languageHint: "python", fileName: "a.cpp" }), false, "manda el lenguaje que dice VS Code");
  assert.equal(isCFamilySource({ fileName: "Cuenta.HPP" }), true);
});

test("avisos: las lineas del editor salen con su numero real y sin el margen (foco, ventana y estructura)", () => {
  const content = [
    "Archivo activo: src/modelo/Cliente.h",
    "Lenguaje: cpp",
    "",
    "Bloque seleccionado por el usuario: lineas 3-3",
    "Class Cliente {",
    "",
    CODE_HEADER,
    numbered(WITH_CAPITAL, [3]),
    "",
    "Estructura del resto del archivo (numero de linea: declaracion):",
    "40: Class Cuenta {",
    "",
    "Declaraciones de archivos relacionados (numero de linea: firma):",
    "src/Otro.h:",
    "  7: Class Otro {",
  ].join("\n");
  const lines = editorCodeLines(content);
  assert.ok(lines.some((line) => line.line === 3 && line.text === "Class Cliente {"), JSON.stringify(lines));
  assert.ok(lines.some((line) => line.line === 40 && line.text === "Class Cuenta {"));
  assert.ok(!lines.some((line) => line.text.includes("Class Otro")), "lo de otros archivos no es del archivo abierto");
  assert.ok(lines.some((line) => line.line === null && line.text === "Class Cliente {"), "la seleccion, sin numero");
  // Margen con espacios («12 > | codigo»), como lo pide el revisor; stripLineGutter usa el mismo.
  assert.deepEqual(editorCodeLines(`${CODE_HEADER}\n 12 > | Class X {`), [{ line: 12, text: "Class X {" }]);
  assert.equal(stripLineGutter(" 12 > | Class X {"), "Class X {");
  assert.equal(stripLineGutter("  16>| codigo"), "codigo");
  assert.equal(stripLineGutter("  15 |   sangria"), "  sangria", "solo un espacio despues de la barra");
  assert.equal(stripLineGutter("sin margen | x"), "sin margen | x");
  assert.equal(stripLineGutter("12|x"), "12|x", "sin espacio ni > no es margen (como antes)");
  // Un texto sin partes (solo codigo) sale entero.
  assert.deepEqual(editorCodeLines("Class X {\n};").map((line) => line.text), ["Class X {", "};"]);
});

test("avisos: el prompt del tutor lleva UNA linea con el aviso cerca del comienzo de las instrucciones", () => {
  const tabContent = `Archivo activo: src/modelo/Cliente.h\n\n${CODE_HEADER}\n${numbered(WITH_CAPITAL, [3])}`;
  for (const build of [buildCursorSelectionSuggestionPrompt, buildFileSummarySuggestionPrompt]) {
    const prompt = build({ tabContent, question: "Ayudame.", tabTitle: "src/modelo/Cliente.h", languageHint: "cpp", policyInstruction: "Politica del docente: pistas." });
    const lines = prompt.split("\n");
    const at = lines.findIndex((line) => line.startsWith("Aviso del revisor automatico:"));
    assert.ok(at > 0, build.name);
    assert.equal(lines.filter((line) => line.startsWith("Aviso del revisor automatico:")).length, 1, build.name);
    assert.match(lines[at], /en la linea 3 escribio "Class Cliente"/);
    assert.equal(lines[at - 1], "Pregunta del usuario: Ayudame.", `${build.name}: justo despues de la pregunta`);
    assert.ok(at < lines.indexOf("Politica del docente: pistas."), `${build.name}: antes de la politica y del formato`);
  }
  // Sin el problema, o en otro lenguaje, el prompt es exactamente el de antes (sin la linea).
  const fixed = tabContent.replace("Class Cliente", "class Cliente");
  const base = { question: "Ayudame.", tabTitle: "src/modelo/Cliente.h", languageHint: "cpp" };
  assert.doesNotMatch(buildCursorSelectionSuggestionPrompt({ ...base, tabContent: fixed }), /Aviso del revisor/);
  assert.equal(
    buildCursorSelectionSuggestionPrompt({ ...base, tabContent, languageHint: "java" }),
    buildCursorSelectionSuggestionPrompt({ ...base, tabContent: fixed, languageHint: "java" }).replace("class Cliente", "Class Cliente"),
  );
  // La pestaña del navegador no es el editor: sin aviso.
  assert.doesNotMatch(buildTabSuggestionPrompt({ tabContent, question: "x", tabTitle: "Cliente.h" }), /Aviso del revisor/);
});

const FIXTURE = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", "avisos-codigo.json"), "utf8")) as {
  casos: Array<{ nombre: string; code: string; vm: string[]; tutor: string[] }>;
};

test("avisos: el detector del tutor da lo mismo que dice tests/fixtures/avisos-codigo.json (los mismos casos de la VM)", () => {
  assert.ok(FIXTURE.casos.length >= 10);
  for (const caso of FIXTURE.casos) {
    const lines = caso.code.split("\n").map((text) => ({ line: null, text }));
    assert.deepEqual(tutorNoticeIds({ languageHint: "cpp", lines }), caso.tutor, caso.nombre);
  }
  // Mientras no haya un motivo escrito en el caso, los dos detectores dicen lo mismo.
  for (const caso of FIXTURE.casos) assert.deepEqual(caso.tutor, caso.vm, `${caso.nombre}: la VM y el tutor difieren sin motivo`);
});

test("avisos: avance-ws.py tiene los mismos ids (DETECTORES) y los mismos topes que el catalogo", () => {
  const python = fs.readFileSync(path.join(process.cwd(), "deploy", "gcp", "workspaces", "avance-ws.py"), "utf8");
  const bloque = /^DETECTORES = \{\n([\s\S]*?)\n\}/m.exec(python);
  assert.ok(bloque, "DETECTORES en avance-ws.py");
  const ids = [...bloque[1].matchAll(/^\s+"([a-z0-9-]+)":/gm)].map((match) => match[1]);
  assert.deepEqual(ids, [...CODE_NOTICE_IDS], "los mismos avisos, en el mismo orden");
  assert.match(python, /^AVISOS = tuple\(DETECTORES\)$/m);
  const constante = (nombre: string) => Number(new RegExp(`^${nombre} = (\\d+)$`, "m").exec(python)?.[1]);
  assert.equal(constante("MAX_AVISOS"), CODE_NOTICES_MAX);
  assert.equal(constante("MAX_ARCHIVOS_AVISO"), CODE_NOTICE_PATHS_MAX);
  assert.equal(constante("MAX_RUTA_AVISO"), CODE_NOTICE_FILE_PATH_MAX);
  assert.match(python, /^PREFIJO_AVISO = "aviso-"$/m, "el mismo prefijo reservado que el backend");
});

test("avisos: CodeNoticeId es la union de los ids del catalogo (este archivo compila y su @ts-expect-error se cumple)", () => {
  // npm test corre con tsx, que no revisa tipos: se revisan aqui, con el compilador del proyecto.
  const archivo = path.join(process.cwd(), "tests", "services", "code-notices.test.ts");
  const config = ts.readConfigFile(path.join(process.cwd(), "tsconfig.json"), ts.sys.readFile).config;
  const { options } = ts.parseJsonConfigFileContent(config, ts.sys, process.cwd());
  const program = ts.createProgram([archivo], { ...options, noEmit: true });
  const errores = ts.getPreEmitDiagnostics(program).filter((d) => d.file?.fileName === archivo || !d.file);
  assert.deepEqual(errores.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), [], "sin errores de tipos (un @ts-expect-error que sobra tambien es error)");
});
