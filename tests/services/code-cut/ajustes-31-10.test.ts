import assert from "node:assert/strict";
import test from "node:test";
import { countChangedLines } from "../../../src/services/vscode/code-cut.js";
import { buildPartialReplacement } from "../../../src/services/vscode/code-cut-partial.js";
import { cutCodePrefix } from "../../../src/services/vscode/code-cut-prefix.js";
import { applySuggestionGuardrail } from "../../../src/services/policy/suggestion-guardrail.js";
import { fences, answer, editorDecision } from "./helpers.js";

// --- Revision independiente del 31-10-2026 (codigo de juguete) --------------------------------

/** Lineas sin sangria de un bloque, para comparar sin depender de la sangria del parcial. */
function trimmedLines(code: string) {
  return code.split("\n").map((line) => line.trim()).filter(Boolean);
}

const TERMO_SELECTION = [
  "class Termo {",
  "  int litros;",
  "  string marca;",
  "public:",
  "  void llenar(int ml) { litros = ml; }",
  "};",
].join("\n");

const TERMO_PROPOSED = [
  "class Termo {",
  "  double litros;",
  "  std::string marca;",
  "  int codigo;",
  "  bool lleno;",
  "public:",
  "  Termo(int c);",
  "  void llenar(double ml) {",
  "    if (ml <= 0) return;",
  "    litros += ml;",
  "  }",
  "  double getLitros() const { return litros; }",
  "};",
].join("\n");

test("reemplazo parcial (31-10-2026): un cambio de tipo no deja la declaracion vieja junto a la nueva", () => {
  // Antes: `int litros;` -> `double litros;` se parece 0,5 (< 0,6) y quedaba como quitar + agregar;
  // el parcial aplicaba la nueva, dejaba la vieja y lo ofrecia como aplicable (redeclaracion).
  const decision = editorDecision(0);
  assert.equal(decision.codeApplication.maxLines, 5);
  assert.equal(countChangedLines(TERMO_SELECTION, TERMO_PROPOSED), 10);
  const guarded = applySuggestionGuardrail(answer(TERMO_PROPOSED), decision, { requestedAction: "replace", selection: TERMO_SELECTION, languageHint: "cpp" });
  assert.equal(guarded.outcome, "applicable");
  const [code] = fences(guarded.text);
  const kept = trimmedLines(code);
  assert.ok(kept.includes("double litros;"), "el cambio de tipo entra");
  assert.ok(!kept.includes("int litros;"), "y la declaracion vieja sale");
  assert.ok(!kept.includes("string marca;") || !kept.includes("std::string marca;"), "marca una sola vez");
  assert.ok(countChangedLines(TERMO_SELECTION, code) <= 5);
  assert.deepEqual(guarded.cutSummary, { kind: "partial", changesShown: countChangedLines(TERMO_SELECTION, code), changesTotal: 10 });

  // Inicializaciones: `int x = 0;` -> `double x = 0.0;` (parecido 0,33) con tope 3.
  const original = ["void f() {", "  int x = 0;", "  int y = 0;", "  cout << x;", "}"].join("\n");
  const proposed = ["void f() {", "  double x = 0.0;", "  double y = 0.5;", "  double z = x + y;", "  cout << x << y;", "  cout << z << endl;", "  return;", "}"].join("\n");
  const partial = buildPartialReplacement({ original, proposed, maxChangedLines: 3, family: "brace" });
  assert.ok(partial, "hay un parcial aplicable");
  const lines = trimmedLines(partial.code);
  assert.ok(lines.includes("double x = 0.0;") && lines.includes("double y = 0.5;"));
  assert.ok(!lines.includes("int x = 0;") && !lines.includes("int y = 0;"), "sin redeclarar x ni y");
  assert.ok(partial.changesShown <= 3);
  assert.equal(partial.changesTotal, 6);
});

test("reemplazo parcial (31-10-2026): un tramo que quita y agrega se aplica entero o no se aplica", () => {
  const original = ["void f() {", "  a();", "  cout << \"Hola\";", "  b();", "}"].join("\n");
  // El tramo quita `cout << "Hola";` (no se parece a nada) y agrega dos lineas: cuesta 2.
  const onlyHunk = ["void f() {", "  a();", "  x1();", "  x2();", "  b();", "}"].join("\n");
  assert.equal(buildPartialReplacement({ original, proposed: onlyHunk, maxChangedLines: 1, family: "brace" }), null, "no cabe entero y no hay nada antes: guia");

  // Con un cambio antes del tramo: el parcial se detiene antes del tramo...
  const withBefore = ["void f() {", "  n1();", "  a();", "  x1();", "  x2();", "  b();", "}"].join("\n");
  const stopped = buildPartialReplacement({ original, proposed: withBefore, maxChangedLines: 2, family: "brace" });
  assert.ok(stopped);
  assert.deepEqual(trimmedLines(stopped.code), ["void f() {", "n1();", "a();", "cout << \"Hola\";", "b();", "}"]);
  assert.equal(stopped.changesShown, 1);
  // ...y si el tramo cabe, entra entero: agrega las dos lineas y quita la que reemplazan.
  const whole = buildPartialReplacement({ original, proposed: withBefore, maxChangedLines: 3, family: "brace" });
  assert.ok(whole);
  assert.deepEqual(trimmedLines(whole.code), ["void f() {", "n1();", "a();", "x1();", "x2();", "b();", "}"]);
  assert.equal(countChangedLines(original, whole.code), 3);

  // A traves del guardarrail: un tramo que no cabe nunca sale como «agregar sin quitar».
  const decision = editorDecision(0);
  const big = ["void f() {", "  a();", ...Array.from({ length: 7 }, (_, index) => `  nuevo_${index + 1}();`), "  b();", "}"].join("\n");
  const guarded = applySuggestionGuardrail(answer(big), decision, { requestedAction: "replace", selection: original, languageHint: "cpp" });
  assert.equal(guarded.outcome, "guide");
  assert.equal(guarded.applyRemoved, true);
});

test("recorte (31-10-2026): un corte no separa un try, un do o un if de su catch, while o else", () => {
  const tryCatch = [
    "try {",
    "    termo.servir(ml);",
    "    cout << \"listo\" << endl;",
    "}",
    "catch (const std::exception& e) {",
    "    cout << e.what() << endl;",
    "}",
  ].join("\n");
  assert.equal(cutCodePrefix(tryCatch, 5, "brace").endsCleanly, false, "el } del try antes del catch no cierra");
  assert.equal(cutCodePrefix(tryCatch, 4, "brace").endsCleanly, false);
  assert.equal(cutCodePrefix(tryCatch, 7, "brace").endsCleanly, true, "con el catch entero si");
  // Si hay un punto cerrado antes del try, el corte cae ahi.
  const before = ["int ml = 5;", tryCatch].join("\n");
  assert.deepEqual(cutCodePrefix(before, 5, "brace"), { code: "int ml = 5;", linesShown: 1, linesTotal: 8, endsCleanly: true });

  const doWhile = ["do {", "    cin >> opcion;", "    procesar(opcion);", "}", "while (opcion != 0);"].join("\n");
  assert.equal(cutCodePrefix(doWhile, 4, "brace").endsCleanly, false, "el do sin su while no compila");
  assert.equal(cutCodePrefix(doWhile, 5, "brace").endsCleanly, true);
  const sameLine = ["do {", "    x++;", "} while (x < 3);", "fin();"].join("\n");
  assert.equal(cutCodePrefix(sameLine, 3, "brace").endsCleanly, true, "«} while (...);» en la misma linea termina el do");

  const ifElse = ["if (ml > 0) {", "    servir(ml);", "}", "else {", "    avisar();", "}"].join("\n");
  assert.equal(cutCodePrefix(ifElse, 4, "brace").endsCleanly, false, "el if sin su else");
  assert.equal(cutCodePrefix(ifElse, 6, "brace").endsCleanly, true);
  const elseSameLine = ["if (ml > 0) {", "    servir(ml);", "} else {", "    avisar();", "}", "fin();"].join("\n");
  assert.equal(cutCodePrefix(elseSameLine, 5, "brace").endsCleanly, true);
  // Un while nuevo despues de un bloque no es la cola de un do.
  const newLoop = ["if (a) {", "    b();", "}", "while (c) {", "    d();", "}"].join("\n");
  assert.equal(cutCodePrefix(newLoop, 4, "brace").endsCleanly, true);

  // A traves del guardarrail: el insert del try cortado ya no se ofrece para aplicar.
  const guarded = applySuggestionGuardrail(answer(tryCatch, "Aplicar: insert"), editorDecision(0), { languageHint: "cpp" });
  assert.equal(guarded.outcome, "guide");
  assert.equal(guarded.applyRemoved, true);

  // En un reemplazo parcial tampoco: el try entra con su catch o no entra.
  const original = ["void f() {", "    a();", "}"].join("\n");
  const proposed = ["void f() {", "    a();", "    try {", "        b();", "    }", "    catch (...) {", "        c();", "    }", "}"].join("\n");
  assert.equal(buildPartialReplacement({ original, proposed, maxChangedLines: 3, family: "brace" }), null);
  const withCatch = buildPartialReplacement({ original, proposed, maxChangedLines: 6, family: "brace" });
  assert.ok(withCatch && /catch \(\.\.\.\)/.test(withCatch.code));

  // Python: un try sin su except tampoco.
  const python = ["try:", "    servir(ml)", "except ValueError:", "    avisar()"].join("\n");
  assert.equal(cutCodePrefix(python, 2, "indent").endsCleanly, false);
  assert.equal(cutCodePrefix(python, 4, "indent").endsCleanly, true);
});
