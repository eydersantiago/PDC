import assert from "node:assert/strict";
import test from "node:test";
import { loadQuizBank, pickQuizFromBank, scoreQuizBankItem } from "../../src/services/quiz-bank.js";
import {
  loadScenarioMatrix,
  matchScenarioRules,
  prioritizeRagSourcesForScenario,
} from "../../src/services/scenario-resources.js";
import type { RagContextItem } from "../../src/types/app.js";

/**
 * A8.5 (banco de respaldo del mini-quiz) y A8.6 (matriz escenario-recurso).
 */

/** Generador pseudoaleatorio con semilla para que la eleccion sea reproducible. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test("banco de quiz: 17 preguntas validas repartidas en RA1-RA4", () => {
  const items = loadQuizBank();
  assert.equal(items.length, 17);
  const byRa = items.reduce<Record<string, number>>((acc, item) => {
    acc[item.ra] = (acc[item.ra] || 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(byRa, { RA1: 4, RA2: 4, RA3: 5, RA4: 4 });
  const ids = new Set(items.map((item) => item.id));
  assert.equal(ids.size, items.length, "ids unicos");
  for (const item of items) {
    assert.equal(item.opciones.length, 4, item.id);
    assert.equal(new Set(item.opciones.map((option) => option.toLowerCase())).size, 4, `${item.id} opciones distintas`);
    assert.ok(item.explicacion.length > 20, `${item.id} explicacion`);
    assert.ok(item.abierta.length > 10, `${item.id} pregunta abierta`);
    assert.ok(["", "cpp", "python"].includes(item.lenguaje), item.id);
  }
});

test("banco de quiz: elige por contexto y lenguaje y conserva la respuesta correcta al barajar", () => {
  const items = loadQuizBank();
  const context = { text: "Figura* f = new Circulo(); f->area(); // sin virtual no hay polimorfismo", language: "cpp" };
  for (let seed = 1; seed <= 20; seed += 1) {
    const quiz = pickQuizFromBank(context, seeded(seed));
    assert.ok(quiz);
    const item = items.find((entry) => entry.id === quiz.bankId);
    assert.ok(item);
    assert.equal(item.id, "RA3-01", "virtual y polimorfismo: metodos virtuales (RA3)");
    assert.equal(quiz.options[quiz.correctIndex], item.opciones[item.correcta], "la correcta sigue siendo la correcta");
    assert.match(quiz.topic, /^banco RA3: /);
  }

  const python = pickQuizFromBank({ text: "assert promedio([10, 20]) == 15  # prueba unitaria", language: "py" }, seeded(3));
  assert.equal(python?.bankId, "RA4-01");

  // excludeIds evita repetir la misma pregunta.
  const excluded = pickQuizFromBank({ ...context, excludeIds: ["RA3-01"] }, seeded(1));
  assert.ok(excluded && excluded.bankId !== "RA3-01");

  // Sin coincidencias igual devuelve una pregunta compatible con el lenguaje.
  const fallback = pickQuizFromBank({ text: "zzzz", language: "python" }, seeded(7));
  assert.ok(fallback);
  const fallbackItem = items.find((entry) => entry.id === fallback.bankId);
  assert.ok(fallbackItem && ["", "python"].includes(fallbackItem.lenguaje));
});

test("banco de quiz: las palabras cortas no coinciden dentro de otras", () => {
  const polymorphism = loadQuizBank().find((item) => item.id === "RA3-03");
  assert.ok(polymorphism);
  assert.equal(scoreQuizBankItem(polymorphism, "voy a verificar y modificar el metodo"), 0, "\"if\" no esta en verificar");
  assert.ok(scoreQuizBankItem(polymorphism, "uso un if por cada tipo de figura") >= 4);
  assert.ok(scoreQuizBankItem(polymorphism, "if tipo", "java") >= 4, "sin lenguaje fijo, sirve para cualquiera");
  const cppOnly = loadQuizBank().find((item) => item.id === "RA1-01");
  assert.ok(cppOnly);
  assert.equal(scoreQuizBankItem(cppOnly, "referencia", "python"), -1);
});

function ragItem(id: string, title: string, metadata: Record<string, unknown> = {}): RagContextItem {
  return {
    id,
    sourceId: `source-${id}`,
    chunkId: `${id}:0`,
    scope: "default",
    title,
    sourceType: "text",
    fileName: `${id}.txt`,
    excerpt: "",
    score: 1,
    ftsScore: 1,
    semanticScore: 0,
    usageReason: "",
    matchedTerms: [],
    isOpenable: true,
    citation: { label: title } as RagContextItem["citation"],
    citationLabel: title,
    pageStart: null,
    pageEnd: null,
    chunkIndex: 0,
    metadata,
  };
}

test("matriz escenario-recurso (A8.6): reglas por evento y prioridad del material autorizado", () => {
  const matrix = loadScenarioMatrix();
  assert.ok(matrix.reglas.length >= 9);
  assert.ok(matrix.reglas.every((rule) => rule.recursos.length > 0 && rule.eventos.length > 0));

  const compile = matchScenarioRules("compile_error", "error: 'total' was not declared in this scope");
  assert.equal(compile[0].escenario, "S1");
  assert.match(compile[0].tema, /Compilacion/);

  const outside = matchScenarioRules("out_of_domain", "cual es la capital de francia");
  assert.deepEqual(outside.map((rule) => rule.escenario), ["S5"]);

  const items = [
    ragItem("a", "Guia de estilo del curso"),
    ragItem("b", "Semana 12 (24-06-2026) - Polimorfismo"),
    ragItem("c", "Material sin titulo conocido", { id: "RAG-FPOO-16" }),
    ragItem("d", "Otra lectura"),
  ];
  const prioritized = prioritizeRagSourcesForScenario(items, "concept_question", "que es el polimorfismo?");
  assert.deepEqual(prioritized.items.map((item) => item.id), ["b", "c", "a", "d"]);
  assert.ok(prioritized.recommended.some((resource) => resource.id === "RAG-FPOO-15"));

  const untouched = prioritizeRagSourcesForScenario(items, "workflow_guidance", "como hago commit");
  assert.deepEqual(untouched.items.map((item) => item.id), ["a", "b", "c", "d"], "sin regla no cambia el orden");
  assert.deepEqual(prioritizeRagSourcesForScenario([], "concept_question", "polimorfismo").items, []);
});
