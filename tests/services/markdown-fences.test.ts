import assert from "node:assert/strict";
import test from "node:test";
import { stripCodeFenceGutters } from "../../src/services/editor-context.js";
import { keepFirstCodeBlock } from "../../src/services/exam-reference.js";
import {
  firstFence,
  mapFences,
  normalizeFenceLines,
  parseFences,
  renderFence,
  replaceFence,
  textOutsideFences,
} from "../../src/services/markdown-fences.js";
import { moveApplyLinesOutOfCodeFences } from "../../src/services/suggestion-policy.js";
import { editorCodeProblem, hasClosedCodeBlock } from "../../src/services/tab-suggestion-prompt.js";

/**
 * Un solo lector de bloques de codigo (src/services/markdown-fences.ts, 30-10-2026). Antes cada
 * modulo tenia su expresion regular y un bloque sin cerrar (respuesta cortada) no contaba como
 * bloque: pasaba entero sin el tope de la etapa.
 */

test("bloques: abren al comienzo de una linea, cierran con una linea de ``` y uno sin cerrar cuenta", () => {
  const text = ["Antes", "```cpp", "a();", "b();", "```", "Medio", "  ```python", "x = 1", "  ```", "```", "cortado();", "sigue();"].join("\n");
  const fences = parseFences(text);
  assert.deepEqual(fences.map((fence) => [fence.info, fence.code, fence.closed]), [
    ["cpp", "a();\nb();", true],
    ["python", "x = 1", true],
    ["", "cortado();\nsigue();", false],
  ]);
  assert.equal(text.slice(fences[0].start, fences[0].end), "```cpp\na();\nb();\n```");
  assert.equal(fences[2].end, text.length, "el bloque sin cerrar llega al final");
  assert.equal(firstFence(text)?.info, "cpp");
  assert.equal(firstFence("sin codigo"), null);
  // Una valla a mitad de linea no abre (para eso esta normalizeFenceLines): la que queda sola abre.
  assert.deepEqual(parseFences("Mira: ```cpp\na();\n```"), [{ start: 18, end: 21, info: "", code: "", closed: false }]);
  assert.deepEqual(parseFences(normalizeFenceLines("Mira: ```cpp\na();\n```")).map((fence) => [fence.info, fence.code, fence.closed]), [["cpp", "a();", true]]);
  // Saltos de linea de Windows.
  assert.deepEqual(parseFences("x\r\n```cpp\r\na();\r\n```\r\nfin").map((fence) => [fence.code, fence.closed]), [["a();", true]]);
  // Un bloque vacio y uno que abre en la ultima linea.
  assert.deepEqual(parseFences("```cpp\n```").map((fence) => [fence.code, fence.closed]), [["", true]]);
  assert.deepEqual(parseFences("texto\n```").map((fence) => [fence.code, fence.closed]), [["", false]]);
});

test("bloques: reemplazar, recorrer, el texto de afuera y las vallas a mitad de linea", () => {
  const text = "a\n```cpp\nx;\n```\nb\n```py\ny\n```\nc";
  assert.equal(mapFences(text, (fence, index) => (index === 1 ? "[B]" : null)), "a\n```cpp\nx;\n```\nb\n[B]\nc");
  assert.equal(replaceFence(text, parseFences(text)[0], "[A]"), "a\n[A]\nb\n```py\ny\n```\nc");
  assert.equal(textOutsideFences(text), "a\n\nb\n\nc");
  assert.equal(renderFence("cpp", "x;"), "```cpp\nx;\n```");
  assert.equal(renderFence("cpp", ""), "```cpp\n```");

  assert.equal(normalizeFenceLines("Mira: ```cpp\n    x = 1;```"), "Mira:\n```cpp\n    x = 1;\n```");
  assert.equal(normalizeFenceLines("```x```"), "```x\n```");
  assert.equal(normalizeFenceLines("```cpp int y;"), "```cpp\nint y;");
  assert.equal(normalizeFenceLines("````md\nsin cambios\n```cpp"), "````md\nsin cambios\n```cpp", "lo que ya esta en su linea no cambia");
  assert.equal(normalizeFenceLines("sin vallas"), "sin vallas");
});

test("bloques: todos los usuarios tratan igual un bloque sin cerrar", () => {
  const cutOff = "1) Resumen:\n- Pista.\n\n```cpp\nAplicar: replace\na();\nb();";
  // «Aplicar:» sale del bloque y el bloque sigue sin cerrar (el guardarrail decide).
  const moved = moveApplyLinesOutOfCodeFences(cutOff);
  assert.equal(moved, "1) Resumen:\n- Pista.\n\nAplicar: replace\n\n```cpp\na();\nb();");
  assert.equal(parseFences(moved)[0].closed, false);
  // El examen descarta un bloque sin cerrar, aunque sea el unico.
  assert.deepEqual(keepFirstCodeBlock(cutOff), { text: "1) Resumen:\n- Pista.", removedBlocks: 1 });
  // El reintento de un pedido de codigo lo ve como un problema; la cache no la guarda.
  assert.equal(editorCodeProblem(cutOff), "sin_cerrar");
  assert.equal(editorCodeProblem("sin bloque"), "sin_bloque");
  assert.equal(editorCodeProblem("```cpp\n// TODO: completa\n```"), "solo_marcador");
  assert.equal(editorCodeProblem("```cpp\na();\n```"), "");
  assert.equal(hasClosedCodeBlock(cutOff), false);
  assert.equal(hasClosedCodeBlock("```cpp\n\n```"), false);
  assert.equal(hasClosedCodeBlock("```cpp\na();\n```"), true);
  // El margen numerado se quita igual, cerrado o no.
  assert.equal(stripCodeFenceGutters("```cpp\n 16>| a();\n 17 | b();\n```"), "```cpp\na();\nb();\n```");
  assert.equal(stripCodeFenceGutters("```cpp\n 16>| a();\n 17 | b();"), "```cpp\na();\nb();");
});
