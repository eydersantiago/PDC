import assert from "node:assert/strict";
import test from "node:test";
import { moveApplyLinesOutOfCodeFences, parseApplyAction } from "../../src/services/suggestion-policy.js";
import { editorCodeProblem } from "../../src/services/tab-suggestion-prompt.js";

// Examen 28-10: el modelo escribio «Aplicar: replace» dentro del bloque y VS Code propuso
// reemplazar el codigo del estudiante por ese texto.

test("un bloque que solo trae la linea Aplicar queda vacio y cuenta como sin codigo", () => {
  const raw = "1) Resumen:\n- Mueve el codigo dentro de main.\n\n```cpp\nAplicar: replace\n```\n";
  const out = moveApplyLinesOutOfCodeFences(raw);
  assert.equal(editorCodeProblem(raw), "", "antes del arreglo pasaba como codigo real");
  assert.equal(editorCodeProblem(out), "solo_marcador");
  assert.equal(parseApplyAction(out), "replace");
  assert.ok(!/```cpp\nAplicar/.test(out));
});

test("la linea Aplicar dentro del bloque sale y queda antes del bloque, una sola vez", () => {
  const raw = "Resumen.\n\n```cpp\nAplicar: replace\nint main() {\n    Banco banco;\n    return 0;\n}\n```";
  const out = moveApplyLinesOutOfCodeFences(raw);
  assert.equal(out, "Resumen.\n\nAplicar: replace\n\n```cpp\nint main() {\n    Banco banco;\n    return 0;\n}\n```");
  assert.equal(editorCodeProblem(out), "");
});

test("si ya viene afuera, solo se quita la de adentro", () => {
  const raw = "Aplicar: insert\n\n```cpp\n`Aplicar: insert`\nbanco.iniciar();\n```";
  const out = moveApplyLinesOutOfCodeFences(raw);
  assert.equal(out, "Aplicar: insert\n\n```cpp\nbanco.iniciar();\n```");
  assert.equal((out.match(/Aplicar/g) || []).length, 1);
});

test("una respuesta con el formato correcto no cambia", () => {
  const ok = "4) Accion:\nAplicar: replace\n\n```cpp\nint main() {\n    return 0;\n}\n```";
  assert.equal(moveApplyLinesOutOfCodeFences(ok), ok);
  const sinAplicar = "```cpp\n// Aplicar el descuento\nint x = 1;\n```";
  assert.equal(moveApplyLinesOutOfCodeFences(sinAplicar), sinAplicar);
  assert.equal(moveApplyLinesOutOfCodeFences(""), "");
});

test("acepta finales de linea de Windows", () => {
  const out = moveApplyLinesOutOfCodeFences("```cpp\r\nAplicar: delete\r\n```");
  assert.equal(parseApplyAction(out), "delete");
  assert.equal(editorCodeProblem(out), "solo_marcador");
});
