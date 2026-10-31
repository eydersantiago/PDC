import assert from "node:assert/strict";
import test from "node:test";
import { seedTeacherPolicy } from "../../src/db/seeds.js";
import {
  buildPartialReplacement,
  countChangedLines,
  cutCodePrefix,
  detectCodeFamily,
  measureBracketShape,
} from "../../src/services/code-cut.js";
import { applyTemplateLimits, CODE_OMITTED_NOTE, limitCodeBlocks } from "../../src/services/intervention-templates.js";
import {
  applySuggestionGuardrail,
  checkCodeApplication,
  countEditorHelpReceived,
  evaluateSuggestionPolicy,
  isExplicitSuggestionRequest,
  type SuggestionPolicyDecision,
} from "../../src/services/suggestion-policy.js";
import type { TeacherPolicy } from "../../src/types/app.js";

/**
 * Recorte del codigo del tutor sin «...» (30-10-2026, src/services/code-cut.ts). El caso real:
 * un estudiante selecciona `int main(){...}` (4 lineas), pide ayuda y el modelo escribe un main
 * de 14 lineas. Antes el guardarrail lo cortaba en 5 lineas, agregaba
 * «// ... recortado por la politica del docente: completa el resto tu» y quitaba «Aplicar:»;
 * VS Code leia esa linea como codigo resumido y escondia la sugerencia, y como no se podia
 * aplicar, la etapa no subia nunca. Codigo ficticio: nada de la solucion del taller.
 */

// --- Las reglas de VS Code 0.0.35 (suggestion-code.ts, isElisionLine), copiadas tal cual -----
const ELLIPSIS_ALONE = /^(?:\.{3,}|…)\s*(?:(?:\/\/|#|\/\*|<!--|--).*)?$/;
const COMMENTED_ELLIPSIS = /^(?:\/\/+|#+|\/\*+|<!--|--)\s*(?:\.{3,}|…)/;
const ELISION_PHRASE = /\b(?:resto|demas|demás)\b.*\b(?:codigo|código|metodo|método|clase|archivo|funcion|función|igual|bloque)\b|\b(?:sin cambios|igual que antes|se mantiene|codigo existente|código existente|existing code|rest of (?:the )?code|unchanged)\b/i;
const COMMENT_START = /^(?:\/\/+|#(?!\s*(?:include|define|undef|if|ifdef|ifndef|elif|else|endif|pragma)\b)|\/\*+|<!--|--\s)/;

function extensionSeesElision(line: string) {
  const text = line.trim();
  if (!text) return false;
  if (ELLIPSIS_ALONE.test(text) || COMMENTED_ELLIPSIS.test(text)) return true;
  return COMMENT_START.test(text) && ELISION_PHRASE.test(text);
}

function fences(markdown: string) {
  return [...markdown.matchAll(/```([^\n]*)\n([\s\S]*?)```/g)].map((match) => match[2].replace(/\n$/, ""));
}

/** Ningun bloque de la salida tiene una linea que VS Code tome por codigo resumido ni «...». */
function assertNoElision(markdown: string, label = "") {
  for (const code of fences(markdown)) {
    for (const line of code.split("\n")) {
      assert.ok(!extensionSeesElision(line), `${label}: linea de resumen en el bloque: ${line}`);
      assert.ok(!/\.{3}|…/.test(line), `${label}: puntos suspensivos en el bloque: ${line}`);
      assert.ok(!/\bresto\b/i.test(line), `${label}: «resto» en el bloque: ${line}`);
    }
  }
}

function policy(overrides: Partial<TeacherPolicy> = {}): TeacherPolicy {
  return {
    ...seedTeacherPolicy,
    eventRules: { ...seedTeacherPolicy.eventRules },
    codeApplication: { ...seedTeacherPolicy.codeApplication },
    updatedAt: "2026-10-30T00:00:00.000Z",
    ...overrides,
  } as TeacherPolicy;
}

const MAIN_SELECTION = ["int main(){", "    cout << \"Hola\";", "    return 0;", "}"].join("\n");

const MAIN_PROPOSED = [
  "int main() {",
  "    Persona persona(\"001\", \"Ana\");",
  "    Caja caja(1, 1000);",
  "    cout << \"Total inicial: \" << caja.getTotal() << endl;",
  "    if (caja.sacar(200)) {",
  "        cout << \"Listo\" << endl;",
  "    } else {",
  "        cout << \"No alcanza\" << endl;",
  "    }",
  "    caja.meter(500);",
  "    cout << \"Total final: \" << caja.getTotal() << endl;",
  "    cout << \"Hola\";",
  "    return 0;",
  "}",
].join("\n");

function answer(code: string, applyLine = "Aplicar: replace", language = "cpp") {
  return [
    "1) Resumen:",
    "- El main todavia no usa las clases.",
    "",
    "4) Accion:",
    applyLine,
    `\`\`\`${language}`,
    code,
    "```",
    "",
    "5) Riesgos:",
    "- Compila despues de cada cambio.",
  ].filter((line) => line !== null).join("\n");
}

/** Decision del editor con el tope de la etapa: 0 aplicaciones y 0, 1 o 2 pedidos explicitos. */
function editorDecision(explicitRequestsBefore: number, base = policy()) {
  return evaluateSuggestionPolicy({
    policy: base,
    signals: { tabContent: MAIN_SELECTION, selection: MAIN_SELECTION, languageHint: "cpp", filePath: "src/main.cpp", question: "Mejora el main." },
    applicationsUsed: 0,
    explicitRequestsBefore,
  });
}

test("recorte (caso real): el main de 4 lineas reemplazado por uno de 14 queda como reemplazo parcial aplicable, sin «...»", () => {
  const hint1 = editorDecision(0);
  assert.equal(hint1.helpStage, "hint_1");
  assert.equal(hint1.codeApplication.maxLines, 5);
  assert.equal(countChangedLines(MAIN_SELECTION, MAIN_PROPOSED), 11);

  const guarded = applySuggestionGuardrail(answer(MAIN_PROPOSED), hint1, { requestedAction: "replace", selection: MAIN_SELECTION, languageHint: "cpp" });
  assert.equal(guarded.outcome, "applicable", "se puede aplicar: la etapa puede avanzar");
  assert.equal(guarded.applyRemoved, false);
  assert.match(guarded.text, /^Aplicar: replace$/m);
  assertNoElision(guarded.text, "pista 1");

  const [code] = fences(guarded.text);
  const changed = countChangedLines(MAIN_SELECTION, code);
  assert.ok(changed >= 1 && changed <= 5, `cambia ${changed} lineas`);
  for (const line of MAIN_SELECTION.split("\n")) {
    assert.ok(code.split("\n").some((kept) => kept.trim() === line.trim()), `la linea del estudiante sigue: ${line}`);
  }
  const shape = measureBracketShape(code, "brace");
  assert.deepEqual([shape.paren, shape.bracket, shape.brace], [0, 0, 0], "llaves cerradas");
  assert.match(code, /Persona persona/);
  assert.doesNotMatch(code, /caja\.meter/, "lo que no cabe se queda afuera");
  // La nota va fuera del bloque, en cursiva.
  assert.match(guarded.text, /```\n\n_El tutor propone \d+ de 11 lineas nuevas o distintas para tu bloque; tus demas lineas quedan como estan y el resto lo escribes tu\._/);
  assert.deepEqual(guarded.cutSummary, { kind: "partial", changesApplied: changed, changesTotal: 11 });

  // apply-check (mismo conteo que countChangedLines y que measureCodeChange de VS Code) lo deja aplicar.
  const check = checkCodeApplication(policy(), { linesChanged: changed }, 0);
  assert.equal(check.allowed, true);

  // Pista 2 (10 lineas): entra el if/else completo; el ejemplo parcial (20) lo deja entero.
  const hint2 = applySuggestionGuardrail(answer(MAIN_PROPOSED), editorDecision(1), { requestedAction: "replace", selection: MAIN_SELECTION, languageHint: "cpp" });
  assert.equal(hint2.outcome, "applicable");
  const [code2] = fences(hint2.text);
  assert.ok(countChangedLines(MAIN_SELECTION, code2) <= 10);
  assert.match(code2, /\} else \{/);
  assertNoElision(hint2.text, "pista 2");
  const example = applySuggestionGuardrail(answer(MAIN_PROPOSED), editorDecision(2), { requestedAction: "replace", selection: MAIN_SELECTION, languageHint: "cpp" });
  assert.equal(editorDecision(2).codeApplication.maxLines, 20);
  assert.equal(example.outcome, "none");
  assert.equal(example.cutSummary, null);
  assert.equal(example.text, answer(MAIN_PROPOSED));
});

test("recorte: sin permiso de aplicar el reemplazo parcial queda como guia y sin «Aplicar:»", () => {
  const disabled = policy({ codeApplication: { ...seedTeacherPolicy.codeApplication, allowed: false } });
  const decision = editorDecision(0, disabled);
  const guarded = applySuggestionGuardrail(answer(MAIN_PROPOSED), decision, { requestedAction: "replace", selection: MAIN_SELECTION, languageHint: "cpp" });
  assert.equal(guarded.outcome, "guide");
  assert.equal(guarded.applyRemoved, true);
  assert.doesNotMatch(guarded.text, /aplicar\s*:/i);
  assertNoElision(guarded.text, "sin permiso");
});

test("recorte: un reemplazo que no es una version del bloque (o que no cierra) queda como guia", () => {
  const decision = editorDecision(0);
  const rewrite = Array.from({ length: 9 }, (_, index) => `    paso_${index + 1}();`).join("\n");
  const guarded = applySuggestionGuardrail(answer(rewrite), decision, { requestedAction: "replace", selection: MAIN_SELECTION, languageHint: "cpp" });
  assert.equal(guarded.outcome, "guide");
  assert.equal(guarded.applyRemoved, true);
  assert.match(guarded.text, /paso_5\(\);/);
  assert.doesNotMatch(guarded.text, /paso_6\(\);/);
  assert.match(guarded.text, /```\n\n_El tutor muestra 5 de 9 lineas: el resto lo escribes tu\._/);
  assert.deepEqual(guarded.cutSummary, { kind: "prefix", linesShown: 5, linesTotal: 9, bracketsClosed: true });
  assertNoElision(guarded.text, "reescritura");

  // La propuesta resume lineas con «// ...»: no se sabe cuales son, asi que no hay parcial.
  const elided = MAIN_PROPOSED.replace("    caja.meter(500);", "    // ... resto igual");
  assert.equal(buildPartialReplacement(MAIN_SELECTION, elided, 5, "brace"), null);
  const guide = applySuggestionGuardrail(answer(elided), decision, { requestedAction: "replace", selection: MAIN_SELECTION, languageHint: "cpp" });
  assert.equal(guide.outcome, "guide");
  assertNoElision(guide.text, "propuesta con resumen");

  // Un cambio que solo cabe abriendo un bloque sin cerrarlo no se aplica a medias.
  const opensBlock = ["int main(){", "    while (true) {", "        a();", "        b();", "        c();", "        d();", "        e();", "    }", "    cout << \"Hola\";", "    return 0;", "}"].join("\n");
  assert.equal(buildPartialReplacement(MAIN_SELECTION, opensBlock, 5, "brace"), null);
});

test("recorte: un insert se corta donde todo queda cerrado y se puede insertar; si no hay corte asi, es guia", () => {
  const decision = editorDecision(0);
  const menu = [
    "cout << \"Menu\" << endl;",
    "cout << \"1. Meter\" << endl;",
    "cout << \"2. Sacar\" << endl;",
    "int opcion;",
    "cin >> opcion;",
    "if (opcion == 1) {",
    "    caja.meter(100);",
    "}",
  ].join("\n");
  const insert = applySuggestionGuardrail(answer(menu, "Aplicar: insert"), decision, { languageHint: "cpp" });
  assert.equal(insert.outcome, "applicable");
  assert.match(insert.text, /^Aplicar: insert$/m);
  assert.match(insert.text, /cin >> opcion;\n```/);
  assert.doesNotMatch(insert.text, /if \(opcion == 1\)/);
  assert.match(insert.text, /_El tutor muestra 5 de 8 lineas: el resto lo escribes tu\._/);
  assertNoElision(insert.text, "insert");

  // Llaves anidadas: con 4 lineas no hay un punto cerrado (todo esta dentro del for).
  const nested = ["for (int i = 0; i < 3; i++) {", "    if (i % 2 == 0) {", "        cout << i;", "    }", "}", "cout << \"fin\";", "total++;"].join("\n");
  assert.deepEqual(cutCodePrefix(nested, 4, "brace"), { code: nested.split("\n").slice(0, 4).join("\n"), shown: 4, total: 7, clean: false });
  assert.deepEqual(cutCodePrefix(nested, 6, "brace"), { code: nested.split("\n").slice(0, 6).join("\n"), shown: 6, total: 7, clean: true });
  // Con 5 lineas el for entero cabe: se puede insertar.
  const nestedFits = applySuggestionGuardrail(answer(nested, "Aplicar: insert"), decision, { languageHint: "cpp" });
  assert.equal(nestedFits.outcome, "applicable");
  assert.match(nestedFits.text, / {4}\}\n\}\n```/);
  const deep = ["for (int i = 0; i < 3; i++) {", "    if (i % 2 == 0) {", "        cout << i;", "        cout << endl;", "    }", "}", "fin();"].join("\n");
  const nestedGuide = applySuggestionGuardrail(answer(deep, "Aplicar: insert"), decision, { languageHint: "cpp" });
  assert.equal(nestedGuide.outcome, "guide", "sin corte cerrado: guia");
  assert.deepEqual(nestedGuide.cutSummary, { kind: "prefix", linesShown: 5, linesTotal: 7, bracketsClosed: false });
  assert.equal(nestedGuide.applyRemoved, true);
  assertNoElision(nestedGuide.text, "anidado");

  // Una firma o un if sin su llave, o una linea que sigue en la siguiente, no cierran el corte.
  const signature = ["int doble(int x)", "{", "    return 2 * x;", "}"].join("\n");
  assert.equal(cutCodePrefix(signature, 1, "brace").clean, false);
  const continued = ["int total = a +", "    b;", "x++;"].join("\n");
  assert.deepEqual(cutCodePrefix(continued, 2, "brace").shown, 2);
  assert.equal(cutCodePrefix(continued, 1, "brace").clean, false);
});

test("recorte: las llaves dentro de cadenas, caracteres y comentarios no cuentan", () => {
  const tricky = ["cout << \"{\";", "// } cierre falso", "char c = '}';", "/* { */", "int x = 1;", "x++;", "y++;"].join("\n");
  const shape = measureBracketShape(tricky, "brace");
  assert.deepEqual([shape.paren, shape.bracket, shape.brace], [0, 0, 0]);
  assert.deepEqual(cutCodePrefix(tricky, 5, "brace"), { code: tricky.split("\n").slice(0, 5).join("\n"), shown: 5, total: 7, clean: true });
  // Un comentario de bloque que cruza lineas tampoco.
  const multiline = ["/* inicio {", "   sigue } */", "int y = 2;", "z();"].join("\n");
  assert.equal(cutCodePrefix(multiline, 3, "brace").clean, true);
  // En Python el # es comentario y las cadenas triples cruzan lineas.
  const python = ["texto = \"\"\"una {", "llave\"\"\"", "# ( sin cerrar", "x = 1", "y = 2"].join("\n");
  assert.equal(cutCodePrefix(python, 4, "indent").clean, true);
});

test("recorte: en Python el corte cae donde la sangria vuelve al nivel de la primera linea", () => {
  const code = [
    "def promedio(notas):",
    "    if not notas:",
    "        return 0",
    "    return sum(notas) / len(notas)",
    "print(promedio([1, 2]))",
    "print(promedio([]))",
  ].join("\n");
  assert.equal(detectCodeFamily({ fenceInfo: "python", code }), "indent");
  assert.equal(detectCodeFamily({ code }), "indent", "sin lenguaje, por la forma");
  assert.equal(detectCodeFamily({ languageHint: "cpp", code: "int x = 1;" }), "brace");
  assert.equal(cutCodePrefix(code, 3, "indent").clean, false, "no corta la funcion por la mitad");
  assert.deepEqual(cutCodePrefix(code, 5, "indent"), { code: code.split("\n").slice(0, 5).join("\n"), shown: 5, total: 6, clean: true });

  const decision = editorDecision(0);
  const guarded = applySuggestionGuardrail(answer(code, "Aplicar: insert", "python"), decision, { languageHint: "python" });
  assert.equal(guarded.outcome, "applicable");
  assert.match(guarded.text, /print\(promedio\(\[1, 2\]\)\)\n```/);
  assertNoElision(guarded.text, "python");

  // Reemplazo parcial en Python: el cambio que abre un bloque entra con su cuerpo.
  const selection = ["def promedio(notas):", "    return sum(notas) / len(notas)"].join("\n");
  const proposed = [
    "def promedio(notas):",
    "    if not notas:",
    "        return 0",
    "    for nota in notas:",
    "        validar(nota)",
    "        registrar(nota)",
    "        avisar(nota)",
    "    return sum(notas) / len(notas)",
  ].join("\n");
  const partial = buildPartialReplacement(selection, proposed, 3, "indent");
  assert.ok(partial);
  assert.equal(partial.code, ["def promedio(notas):", "    if not notas:", "        return 0", "    return sum(notas) / len(notas)"].join("\n"));
  assert.equal(partial.changed, 2);
});

test("recorte: sin tope (0) el codigo se omite con la nota fuera de cualquier bloque", () => {
  const noCode = limitCodeBlocks(answer(MAIN_PROPOSED), 0);
  assert.equal(noCode.truncated, true);
  assert.equal(fences(noCode.text).length, 0);
  assert.ok(noCode.text.includes(CODE_OMITTED_NOTE));
  assert.equal(noCode.firstTruncatedBlock, null);

  const zero = { ...editorDecision(0) } as SuggestionPolicyDecision;
  zero.codeApplication = { ...zero.codeApplication, maxLines: 0 };
  const guarded = applySuggestionGuardrail(answer(MAIN_PROPOSED), zero, { requestedAction: "replace", selection: MAIN_SELECTION });
  assert.equal(guarded.outcome, "guide");
  assert.equal(guarded.cutSummary, null);
  assert.doesNotMatch(guarded.text, /```|aplicar\s*:/i);
  assert.ok(guarded.text.includes(CODE_OMITTED_NOTE));
});

test("recorte: con varios bloques cada uno se corta como guia; sin exceso, nada cambia", () => {
  const decision = editorDecision(0);
  const block = (name: string, lines: number) => ["```cpp", ...Array.from({ length: lines }, (_, index) => `${name}_${index + 1}();`), "```"].join("\n");
  const two = ["1) Resumen:", "- Dos pasos.", "", "Aplicar: insert", block("uno", 8), "", "Luego:", block("dos", 7)].join("\n");
  const guarded = applySuggestionGuardrail(two, decision, { languageHint: "cpp" });
  assert.equal(guarded.outcome, "guide", "VS Code solo aplica el primero: con varios, guia");
  assert.equal(guarded.applyRemoved, true);
  assert.deepEqual(fences(guarded.text).map((code) => code.split("\n").length), [5, 5]);
  assert.deepEqual(guarded.cutSummary, { kind: "prefix", linesShown: 5, linesTotal: 8, bracketsClosed: true });
  assertNoElision(guarded.text, "varios bloques");

  const small = ["Aplicar: insert", block("uno", 3), "", block("dos", 2)].join("\n");
  const untouched = applySuggestionGuardrail(small, decision, { languageHint: "cpp" });
  assert.equal(untouched.outcome, "none");
  assert.equal(untouched.text, small);
});

test("recorte: las lineas «...» que trae el modelo no quedan en un bloque recortado", () => {
  const decision = editorDecision(0);
  const withElision = ["a();", "// ...", "b();", "# ... resto igual", "c();", "…", "d();", "// resto del codigo igual", "e();", "f();", "g();"].join("\n");
  const guarded = applySuggestionGuardrail(answer(withElision, "Aplicar: insert"), decision, { languageHint: "cpp" });
  assert.notEqual(guarded.outcome, "none");
  assertNoElision(guarded.text, "modelo con resumen");
  assert.match(guarded.text, /a\(\);\nb\(\);\nc\(\);\nd\(\);\ne\(\);\n```/);
});

test("recorte del overlay: el limite de la plantilla deja la nota fuera del bloque", () => {
  const code = Array.from({ length: 12 }, (_, index) => `paso_${index + 1}();`).join("\n");
  const result = applyTemplateLimits({
    ideas: [`Idea con codigo:\n\`\`\`cpp\n${code}\n\`\`\``, "Idea 2", "Idea 3"],
    searches: ["a", "b", "c"],
    guide: ["1", "2", "3", "4"],
    welcome_message: "Hola",
    analysis_summary: "Resumen",
  }, "hint_2");
  assert.match(result.ideas[0], /```cpp\npaso_1\(\);\npaso_2\(\);\n```\n\n_El tutor muestra 2 de 12 lineas: el resto lo escribes tu\._/);
  assertNoElision(result.ideas[0], "overlay");
  const hint1 = applyTemplateLimits({ ideas: [`\`\`\`cpp\n${code}\n\`\`\``], searches: [], guide: [], welcome_message: "", analysis_summary: "" }, "hint_1");
  assert.equal(hint1.ideas[0], CODE_OMITTED_NOTE);
});

test("etapa del editor: los pedidos explicitos suben la etapa; los automaticos no; aplicar y pedir no se suman", () => {
  assert.equal(isExplicitSuggestionRequest({ scope: "cursor", trigger: "manual" }), true);
  assert.equal(isExplicitSuggestionRequest({ scope: "selection", trigger: "selection", requestedAction: "replace" }), true);
  assert.equal(isExplicitSuggestionRequest({ scope: "cursor", trigger: "cursor_idle", requestedAction: "insert" }), true);
  assert.equal(isExplicitSuggestionRequest({ scope: "file_summary", trigger: "manual" }), false, "el resumen del archivo no cuenta");
  assert.equal(isExplicitSuggestionRequest({ scope: "general", requestedAction: "replace" }), false);
  for (const trigger of ["cursor_idle", "selection", "file_open", "blocking", "panel", ""]) {
    assert.equal(isExplicitSuggestionRequest({ scope: "cursor", trigger, requestedAction: "" }), false, trigger);
  }
  // Lo mayor, no la suma: pedir una sugerencia y aplicarla es un solo paso.
  assert.equal(countEditorHelpReceived({ applicationsUsed: 1, explicitRequestsBefore: 1 }), 1);
  assert.equal(countEditorHelpReceived({ applicationsUsed: 1, explicitRequestsBefore: 2 }), 2);
  assert.equal(countEditorHelpReceived({ applicationsUsed: 3, explicitRequestsBefore: 0 }), 3);
  assert.equal(countEditorHelpReceived({ applicationsUsed: -1, explicitRequestsBefore: Number.NaN }), 0);

  const stage = (explicitRequestsBefore: number, applicationsUsed = 0) => {
    const decision = evaluateSuggestionPolicy({
      policy: policy(),
      signals: { tabContent: MAIN_SELECTION, languageHint: "cpp", filePath: "src/main.cpp", question: "Ayuda" },
      applicationsUsed,
      explicitRequestsBefore,
    });
    return [decision.helpStage, decision.codeApplication.maxLines, decision.codeApplication.remaining];
  };
  assert.deepEqual([0, 1, 2, 5].map((before) => stage(before)), [
    ["hint_1", 5, 3],
    ["hint_2", 10, 3],
    ["partial_example", 20, 3],
    ["partial_example", 20, 3],
  ], "el cupo de aplicaciones (remaining) no cambia con los pedidos");
  assert.deepEqual(stage(1, 1), ["hint_2", 10, 2], "pedir y aplicar la misma sugerencia es un paso");
  assert.deepEqual(stage(0, 2), ["partial_example", 20, 1]);
});

test("recorte: un bloque sin cerrar (respuesta cortada) de 40 lineas sale con el tope de la etapa y sin «Aplicar:»", () => {
  const decision = editorDecision(0);
  const forty = Array.from({ length: 40 }, (_, index) => `    paso_${index + 1}();`).join("\n");
  const cutOff = ["1) Resumen:", "- Version mejorada.", "", "Aplicar: insert", "```cpp", forty].join("\n");
  const guarded = applySuggestionGuardrail(cutOff, decision, { languageHint: "cpp" });
  assert.equal(guarded.outcome, "guide", "una respuesta cortada no se aplica");
  assert.equal(guarded.applyRemoved, true);
  assert.doesNotMatch(guarded.text, /aplicar\s*:/i);
  assert.match(guarded.text, /paso_5\(\);\n```\n\n_El tutor muestra 5 de 40 lineas/);
  assert.doesNotMatch(guarded.text, /paso_6\(\);/);
  assert.deepEqual(guarded.cutSummary, { kind: "prefix", linesShown: 5, linesTotal: 40, bracketsClosed: true });
  assertNoElision(guarded.text, "sin cerrar");

  // Una valla a mitad de linea tambien cuenta como bloque (VS Code 0.0.37 la toma como tal).
  const inline = `Mira esto: \`\`\`cpp\n${forty}\n\`\`\``;
  const inlineGuarded = applySuggestionGuardrail(inline, decision, { languageHint: "cpp" });
  assert.notEqual(inlineGuarded.outcome, "none");
  assert.doesNotMatch(inlineGuarded.text, /paso_6\(\);/);
});
