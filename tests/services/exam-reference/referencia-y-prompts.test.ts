import assert from "node:assert/strict";
import test from "node:test";
import { env } from "../../../src/config/env.js";
import { keepFirstCodeBlock } from "../../../src/services/vscode/markdown-fences.js";
import {
  buildExamReferenceBlock,
  describeExamReference,
  guardExamReferenceLeak,
  loadExamReference,
  matchesExamRepo,
  parseExamReference,
  resolveExamReferenceForRequest,
  resolveExamStep,
  type ExamReference,
} from "../../../src/services/exam/exam-reference.js";
import { buildMentorPrompt } from "../../../src/services/tutor/mentor-core.js";
import { buildCursorSelectionSuggestionPrompt } from "../../../src/services/vscode/tab-suggestion-prompt.js";
import { promptBudgetChars } from "../../../src/services/tutor/text-generation.js";
import { FAKE, encode, withEnv, ACCESS } from "./helpers.js";

test("referencia del examen: se lee de EXAM_REFERENCE_B64 y sin ella (o apagada o rota) no hay nada", () => {
  const parsed = parseExamReference(encode(FAKE));
  assert.equal(parsed?.repo, FAKE.repo);
  assert.equal(parsed?.pasos.length, 4);
  assert.equal(parseExamReference("esto-no-es-gzip"), null, "nunca lanza");
  assert.equal(parseExamReference(""), null);

  withEnv({}, () => {
    assert.equal(loadExamReference(), null);
    assert.deepEqual(describeExamReference(), { exam_reference_loaded: false });
    assert.equal(resolveExamReferenceForRequest({ repoFullName: FAKE.repo, filePath: "src/modelo/Cuenta.cpp" }, ACCESS), null);
  });
  for (const mode of ["off", "OFF", "false", "0"]) {
    withEnv({ b64: encode(FAKE), mode }, () => assert.equal(loadExamReference(), null, mode));
  }
  withEnv({ b64: "esto-no-es-gzip" }, () => {
    assert.equal(loadExamReference(), null);
    assert.equal(resolveExamReferenceForRequest({ repoFullName: FAKE.repo, filePath: "src/main.cpp" }, ACCESS), null);
  });
  withEnv({ b64: encode({ ...FAKE, pasos: "mal" }) }, () => {
    assert.equal(loadExamReference(), null);
  });
  withEnv({ b64: encode(FAKE) }, () => {
    assert.equal(loadExamReference()?.repo, FAKE.repo);
    assert.deepEqual(describeExamReference(), { exam_reference_loaded: true });
  });
});

test("referencia del examen: una sola puerta; sin sesion o sin politica no hay referencia", () => {
  withEnv({ b64: encode(FAKE) }, () => {
    const hint = { repoFullName: FAKE.repo, filePath: "src/modelo/Cuenta.cpp" };
    assert.equal(resolveExamReferenceForRequest(hint, { ...ACCESS, session: null }), null, "sin sesion");
    assert.equal(resolveExamReferenceForRequest(hint, { ...ACCESS, decision: null }), null, "sin politica");
    assert.equal(resolveExamReferenceForRequest(hint, { ...ACCESS, decision: { blocked: true } }), null, "ayuda bloqueada");
    assert.equal(resolveExamReferenceForRequest({ ...hint, repoFullName: "alumno/otro" }, ACCESS), null, "otro repositorio");
    // EXAM_REPO vale aunque EXAM_PRESET este apagado: son interruptores independientes.
    const previous = { repo: env.examRepo, preset: env.examPreset };
    env.examRepo = "profe/copia-del-examen";
    env.examPreset = "off";
    try {
      assert.ok(resolveExamReferenceForRequest({ ...hint, repoFullName: "otro/copia-del-examen" }, ACCESS), "EXAM_REPO con EXAM_PRESET=off");
    } finally {
      env.examRepo = previous.repo;
      env.examPreset = previous.preset;
    }
    const editor = resolveExamReferenceForRequest(hint, ACCESS);
    assert.ok(editor);
    assert.equal(editor.stepId, "cuenta");
    assert.match(editor.tailRule, /siguiente paso hacia el codigo final/);
    assert.match(editor.text, /5, luego 10 y luego el maximo del docente/, "los topes salen de EDITOR_STAGE_CODE_CAP");
    // El editor deja un solo bloque; el panel no toca los bloques.
    const two = "Uno:\n```cpp\na();\n```\nDos:\n```cpp\nb();\n```";
    assert.equal(editor.keepFirstBlock(two).removedBlocks, 1);
    const panel = resolveExamReferenceForRequest(hint, { ...ACCESS, channel: "panel" });
    assert.ok(panel);
    assert.deepEqual(panel.keepFirstBlock(two), { text: two, removedBlocks: 0 });
    assert.doesNotMatch(panel.text, /IMPL-/);
  });
});

test("referencia del examen: solo para el repositorio del ejercicio", () => {
  assert.ok(matchesExamRepo(FAKE, { repoFullName: "eydersantiago/sistema-bancario-fpoo" }));
  assert.ok(matchesExamRepo(FAKE, { repoFullName: "https://github.com/EyderSantiago/Sistema-Bancario-FPOO.git" }));
  assert.ok(matchesExamRepo(FAKE, { repoFullName: "https://github.com/eydersantiago/sistema-bancario-fpoo/tree/main/src" }), "con /tree/main");
  assert.ok(matchesExamRepo(FAKE, { repoFullName: "otro/copia-del-examen" }, ["profe/copia-del-examen"]), "otro repositorio del ejercicio (EXAM_REPO), como argumento");
  assert.ok(matchesExamRepo(FAKE, { repoFullName: "otro-usuario/sistema-bancario-fpoo" }), "un fork del ejercicio");
  assert.ok(matchesExamRepo(FAKE, { url: "vscode://sistema-bancario-fpoo/src/modelo/Cuenta.cpp" }), "sin remoto, por la carpeta");
  assert.ok(!matchesExamRepo(FAKE, { repoFullName: "eydersantiago/FadaProyecto", url: "vscode://sistema-bancario-fpoo/x" }), "el repositorio manda");
  assert.ok(!matchesExamRepo(FAKE, { url: "vscode://taller/src/area.cpp", title: "src/area.cpp" }));
});

test("referencia del examen: el paso sale del nombre del archivo", () => {
  const step = (path: string) => resolveExamStep(FAKE, path)?.id || "";
  assert.equal(step("src/modelo/Cliente.h"), "cliente");
  assert.equal(step("src/modelo/Cuenta.cpp"), "cuenta");
  assert.equal(step("sistema-bancario-fpoo/src/modelo/CuentaCorriente.cpp"), "cuentacorriente");
  assert.equal(step("src\\modelo\\cuenta_corriente.hpp"), "cuentacorriente");
  assert.equal(step("src/main.cpp"), "main");
  assert.equal(step("README.md"), "");
  assert.equal(step(""), "");
  // Por los archivos de cada paso, no por una lista fija: el nombre igual gana, despues el que
  // empieza igual (main2.cpp) y despues el mas largo que contiene (y los patrones del JSON).
  assert.equal(step("src/main2.cpp"), "main");
  assert.equal(step("tests/CuentaCorrienteTest.cpp"), "cuentacorriente");
  assert.equal(step("src/corriente_utils.cpp"), "cuentacorriente", "por su patron");
  const other: ExamReference = {
    ...FAKE,
    pasos: [
      { id: "a", titulo: "A", archivos: ["src/Figura.h"], apoyo: [], guia: "G", patrones: [] },
      { id: "b", titulo: "B", archivos: ["src/FiguraCirculo.h"], apoyo: [], guia: "G", patrones: ["circulo"] },
    ],
  };
  assert.equal(resolveExamStep(other, "src/FiguraCirculo.cpp")?.id, "b");
  assert.equal(resolveExamStep(other, "src/Figura.cpp")?.id, "a");
  assert.equal(resolveExamStep(other, "src/circulo.cpp")?.id, "b");
});

test("referencia del examen: el editor recibe el .cpp del paso; el panel solo declaraciones", () => {
  const editor = buildExamReferenceBlock(FAKE, { filePath: "src/modelo/CuentaCorriente.cpp", channel: "editor" });
  assert.equal(editor.stepId, "cuentacorriente");
  assert.match(editor.text, /Referencia privada del docente/);
  assert.match(editor.text, /GUIA-CORRIENTE/);
  assert.match(editor.text, /IMPL-CORRIENTE-CPP/);
  assert.match(editor.text, /virtual bool retirarDinero/, "la declaracion de la base que usa");
  assert.match(editor.text, /Errores: falta ;/);
  assert.match(editor.text, /class Cliente \{\n  string nombre;/, "las demas declaraciones, sin comentarios");
  assert.doesNotMatch(editor.text, /IMPL-CLIENTE-CPP|IMPL-CUENTA-CPP|IMPL-MAIN/, "solo el .cpp del archivo abierto");

  const panel = buildExamReferenceBlock(FAKE, { filePath: "src/modelo/CuentaCorriente.cpp", channel: "panel" });
  assert.match(panel.text, /GUIA-CORRIENTE/);
  assert.match(panel.text, /class CuentaCorriente : public Cuenta/);
  assert.doesNotMatch(panel.text, /IMPL-/, "el panel no lleva implementaciones");

  const unknown = buildExamReferenceBlock(FAKE, { filePath: "README.md", channel: "editor" });
  assert.equal(unknown.stepId, "");
  assert.match(unknown.text, /No se reconoce el archivo/);
  assert.doesNotMatch(unknown.text, /IMPL-/);

  // Con poco espacio quedan las reglas y la guia del paso; lo demas sale.
  const tight = buildExamReferenceBlock(FAKE, { filePath: "src/modelo/Cuenta.cpp", channel: "editor", maxChars: 1500 });
  assert.match(tight.text, /GUIA-CUENTA/);
  assert.ok(tight.text.length <= 1500 + 50);
});

test("referencia del examen: en el prompt del editor va despues del codigo, el codigo cede espacio y no pasa del presupuesto", () => {
  const reference = buildExamReferenceBlock(FAKE, { filePath: "src/modelo/Cuenta.cpp", channel: "editor" });
  const block = reference.text;
  const huge = Array.from({ length: 2500 }, (_, index) => `long linea${index} = ${index};`).join("\n");
  const prompt = buildCursorSelectionSuggestionPrompt({
    tabContent: huge,
    question: "Como hago retirarDinero?",
    tabTitle: "src/modelo/Cuenta.cpp",
    reference,
    languageHint: "cpp",
  });
  assert.ok(prompt.includes(block), "la referencia entra completa");
  assert.ok(prompt.indexOf("Contexto de seleccion/cursor:") < prompt.indexOf("Referencia privada del docente"));
  assert.ok(prompt.indexOf("Referencia privada del docente") < prompt.indexOf("## Lo que tienes que responder"));
  assert.match(prompt, /Usa la referencia privada del docente para que la pista y el codigo sean el siguiente paso/);
  assert.ok(prompt.length <= promptBudgetChars() + 200, `prompt de ${prompt.length} caracteres`);

  const without = buildCursorSelectionSuggestionPrompt({ tabContent: "int main() {}", question: "x", tabTitle: "a.cpp" });
  assert.doesNotMatch(without, /referencia privada/i, "fuera del examen el prompt no cambia");
});

test("referencia del examen: el panel la recibe como ExamReference", () => {
  const prompt = buildMentorPrompt({
    context: { pageContext: "github", pageType: "codespace", filePath: "src/modelo/Cuenta.cpp" },
    question: "como empiezo la clase Cuenta",
    maxItems: 4,
    heuristic: { ideas: [], searches: [], guide: [], welcome_message: "", analysis_summary: "" },
    referenceContext: "GUIA-DE-PRUEBA",
  });
  assert.match(prompt, /ExamReference:\nGUIA-DE-PRUEBA/);
  assert.match(prompt, /ExamReference es privada del docente/);
  const without = buildMentorPrompt({
    context: { pageContext: "github", pageType: "codespace" },
    question: "x",
    maxItems: 4,
    heuristic: { ideas: [], searches: [], guide: [], welcome_message: "", analysis_summary: "" },
  });
  assert.doesNotMatch(without, /ExamReference/);
});

test("referencia del examen: no sale copiada fuera de los bloques de codigo", () => {
  // Codigo ficticio: la solucion real no puede aparecer en este repositorio (es publico).
  const reference = [
    "## Referencia privada del docente",
    "- Sin .h: #include \"Foo.h\"; class Foo : public Base (guia en prosa)",
    "int Foo::bar(int x) {",
    "    if (x <= 0 || x > tope + margen) {",
    "        return 0;",
    "    }",
    "    acumular(valorActual() + x);",
    "    return 1;",
    "}",
    "Foo::Foo(string nombre, int tope, int margen) : Base(nombre, tope) {",
    "    this->margen = margen;",
  ].join("\n");
  const leaked = [
    "1) Resumen:",
    "- Aqui va todo:",
    "int Foo::bar(int x) {",
    "    if (x <= 0 || x > tope + margen) {",
    "    acumular(valorActual() + x);",
    "Foo::Foo(string nombre, int tope, int margen) : Base(nombre, tope) {",
    "    this->margen = margen;",
    "```cpp",
    "    acumular(valorActual() + x);",
    "```",
  ].join("\n");
  const guarded = guardExamReferenceLeak({ output: leaked, referenceText: reference });
  assert.equal(guarded.removedLines, 2, "pasan las 3 primeras, salen las demas fuera del bloque");
  assert.doesNotMatch(guarded.text, /this->margen = margen;/);
  assert.match(guarded.text, /```cpp\n    acumular\(valorActual\(\) \+ x\);\n```/, "el bloque de codigo no se toca (lo limita la politica)");

  const hint = "1) Resumen:\n- Usa `acumular(valorActual() + x);` en vez de tocar el atributo.\n```cpp\n    acumular(valorActual() + x);\n```";
  assert.deepEqual(guardExamReferenceLeak({ output: hint, referenceText: reference }), { text: hint, removedLines: 0 }, "una pista normal no cambia");
  assert.deepEqual(guardExamReferenceLeak({ output: hint, referenceText: "" }), { text: hint, removedLines: 0 });
  assert.equal(guardExamReferenceLeak({ output: leaked, referenceText: reference, allowedVerbatimLines: 0 }).removedLines, 5);
});

test("referencia del examen: solo queda el primer bloque de codigo; los demas se quitan aunque no cierren", () => {
  const many = ["1) Resumen:", "- Pista.", "```cpp", "a();", "```", "Texto.", "```cpp", "b();", "```", "```cpp", "c();"].join("\n");
  const single = keepFirstCodeBlock(many);
  assert.equal(single.removedBlocks, 2);
  assert.match(single.text, /```cpp\na\(\);\n```/);
  assert.doesNotMatch(single.text, /b\(\);|c\(\);/);
  assert.match(single.text, /Texto\./);
  const one = "1) Resumen:\n```cpp\na();\n```";
  assert.deepEqual(keepFirstCodeBlock(one), { text: one, removedBlocks: 0 });
  // 31-10-2026: un primer bloque cortado se queda; el guardarrail lo cierra y lo deja como guia.
  assert.deepEqual(keepFirstCodeBlock("```cpp\nsolo();"), { text: "```cpp\nsolo();", removedBlocks: 0 });
});
