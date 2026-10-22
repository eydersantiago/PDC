import assert from "node:assert/strict";
import test from "node:test";
import { seedTeacherPolicy } from "../../src/db/seeds.js";
import { editorStageInstruction } from "../../src/services/intervention-templates.js";
import {
  gradeFollowUp,
  isTooShortExplanation,
  parseFollowUpGrade,
  setQuizModelRunnerForTests,
  SHORT_EXPLANATION_FEEDBACK,
} from "../../src/services/quiz.js";
import {
  applySuggestionGuardrail,
  buildSuggestionPolicyInstruction,
  countChangedLines,
  effectiveApplyAction,
  evaluateSuggestionPolicy,
  parseApplyAction,
  retainedSelectionFraction,
} from "../../src/services/suggestion-policy.js";
import {
  buildCursorSelectionSuggestionPrompt,
  modernizeEditorQuestion,
  normalizeRequestedAction,
} from "../../src/services/tab-suggestion-prompt.js";
import { stripForeignScript } from "../../src/services/text-utils.js";
import type { TeacherPolicy } from "../../src/types/app.js";

/**
 * Reunion del 20/10/2026 con una estudiante: las sugerencias del editor solo
 * agregaban un comentario TODO, "Modificar seleccion" cambiaba el bloque por un
 * fragmento y el modelo a veces escribia caracteres chinos. Partes puras de la
 * correccion (backend): preguntas, prompt, guardarrail con lineas cambiadas,
 * limpieza de la salida y calificacion de la explicacion del quiz.
 */

function policy(overrides: Partial<TeacherPolicy> = {}): TeacherPolicy {
  return {
    ...seedTeacherPolicy,
    eventRules: { ...seedTeacherPolicy.eventRules },
    codeApplication: { ...seedTeacherPolicy.codeApplication },
    updatedAt: "2026-10-20T00:00:00.000Z",
    ...overrides,
  } as TeacherPolicy;
}

const SELECTION = [
  "double calcularArea(double base, double altura) {",
  "  if (base < 0) {",
  "    return 0;",
  "  }",
  "  double area = base * altura;",
  "  cout << area;",
  "  return area;",
  "}",
].join("\n");

const OLD_CLIENT_QUESTION = "El estudiante selecciono un bloque del editor; analiza la seleccion completa recibida, con limite maximo de 20 lineas, como foco principal. No reduzcas el analisis a la linea del cursor si hay varias lineas seleccionadas. Describe en 1 bullet que parece estar intentando hacer el bloque seleccionado y da 2 sugerencias breves para continuar desde esa seleccion. Al final, si es seguro, incluye un unico bloque de codigo corto para continuar. Si no es seguro, usa un comentario TODO del lenguaje. Incluye una linea \"Aplicar: insert\", \"Aplicar: replace\" o \"Aplicar: delete\" segun corresponda; usa delete solo si la mejor ayuda es eliminar codigo. No des la solucion completa ni inventes datos que no esten en el contexto.";

function replaceAnswer(block: string) {
  return ["1) Resumen:", "- Calcula el area de un triangulo.", "", "4) Accion:", "Aplicar: replace", "```cpp", block, "```", "", "6) Riesgos:", "- Revisa las unidades."].join("\n");
}

test("editor: las preguntas de VS Code anteriores a la 0.0.34 ya no piden un comentario TODO", () => {
  const modern = modernizeEditorQuestion(OLD_CLIENT_QUESTION);
  assert.doesNotMatch(modern, /TODO/);
  assert.doesNotMatch(modern, /corto para continuar/);
  assert.match(modern, /un unico bloque de codigo segun la accion/);
  assert.match(modern, /Aplicar: insert/);
  const blocking = "Al final, si es seguro, incluye un unico bloque de codigo corto que ayude a corregirlo. Si no es seguro, usa un comentario TODO del lenguaje.";
  assert.equal(modernizeEditorQuestion(blocking), "Al final, si es seguro, incluye un unico bloque de codigo segun la accion.");
  assert.equal(modernizeEditorQuestion("Pregunta sin cambios."), "Pregunta sin cambios.");
});

test("editor: el prompt de seleccion pide codigo real segun la accion y respeta el pedido del estudiante", () => {
  const prompt = buildCursorSelectionSuggestionPrompt({ tabContent: SELECTION, question: OLD_CLIENT_QUESTION, languageHint: "cpp" });
  assert.doesNotMatch(prompt, /comentario TODO del lenguaje/);
  assert.match(prompt, /```cpp que corresponda a la accion elegida/);
  assert.match(prompt, /replace: el bloque seleccionado completo ya corregido o mejorado/);
  assert.match(prompt, /insert: solo las lineas nuevas/);
  assert.match(prompt, /nunca un comentario TODO solo/);
  assert.match(prompt, /Responde solo en espanol/);
  assert.doesNotMatch(prompt, /Pedido del estudiante/);

  const improve = buildCursorSelectionSuggestionPrompt({ tabContent: SELECTION, question: "Mejora el bloque.", requestedAction: "replace", languageHint: "cpp" });
  assert.match(improve, /Pedido del estudiante: MEJORAR el bloque seleccionado/);
  assert.match(improve, /`Aplicar: replace`/);
  const insert = buildCursorSelectionSuggestionPrompt({ tabContent: SELECTION, question: "Continua.", requestedAction: "insert" });
  assert.match(insert, /Pedido del estudiante: CODIGO NUEVO/);
  assert.match(insert, /`Aplicar: insert`/);

  assert.equal(normalizeRequestedAction("replace"), "replace");
  assert.equal(normalizeRequestedAction("Mejorar"), "replace");
  assert.equal(normalizeRequestedAction("insert"), "insert");
  assert.equal(normalizeRequestedAction("delete"), "", "eliminar no necesita codigo del modelo");
  assert.equal(normalizeRequestedAction(undefined), "");
});

test("editor: con el pedido de mejorar, la etapa limita las lineas que cambian", () => {
  assert.match(editorStageInstruction("hint_1", 5), /maximo 5 lineas/);
  assert.match(editorStageInstruction("hint_1", 5, "replace"), /cambia como maximo 5 lineas del bloque; las que no cambian se copian igual/);
  assert.doesNotMatch(editorStageInstruction("partial_example", 12), /deja un comentario TODO/);
  assert.match(editorStageInstruction("partial_example", 12), /codigo real/);

  const base = policy();
  const decision = evaluateSuggestionPolicy({
    policy: base,
    signals: { tabContent: SELECTION, selection: SELECTION, languageHint: "cpp", filePath: "src/area.cpp", question: "Mejora el bloque." },
    applicationsUsed: 0,
  });
  assert.equal(decision.helpStage, "hint_1");
  const instruction = buildSuggestionPolicyInstruction(base, decision, { requestedAction: "replace" });
  assert.match(instruction, /Si propones codigo, cambia como maximo 5 lineas\./);
  assert.match(buildSuggestionPolicyInstruction(base, decision), /Si propones codigo, maximo 5 lineas nuevas o cambiadas\./);
  assert.match(buildSuggestionPolicyInstruction(base, decision, { requestedAction: "insert" }), /Si propones codigo, maximo 5 lineas\./);
});

test("editor: el guardarrail cuenta las lineas cambiadas de un reemplazo, no las del bloque", () => {
  const decision = evaluateSuggestionPolicy({
    policy: policy(),
    signals: { tabContent: SELECTION, selection: SELECTION, languageHint: "cpp", filePath: "src/area.cpp", question: "Mejora el bloque." },
    applicationsUsed: 0,
  });
  assert.equal(decision.codeApplication.maxLines, 5);

  // 7 lineas, 2 cambian (area de triangulo y sin cout): se deja entera y se puede aplicar.
  const improved = SELECTION.replace("double area = base * altura;", "double area = base * altura / 2.0;").replace("  cout << area;\n", "");
  assert.equal(countChangedLines(SELECTION, improved), 2);
  const small = applySuggestionGuardrail(replaceAnswer(improved), decision, { selection: SELECTION });
  assert.equal(small.truncated, false);
  assert.equal(small.applyRemoved, false);
  assert.match(small.text, /Aplicar: replace/);
  assert.match(small.text, /return area;\n\}/, "la funcion queda completa");

  // Sin la seleccion se cuenta el bloque (8 > 5): recorte como antes.
  const withoutSelection = applySuggestionGuardrail(replaceAnswer(improved), decision);
  assert.equal(withoutSelection.truncated, true);

  // Reescritura grande: 7 lineas distintas, mas del tope.
  const rewrite = Array.from({ length: 7 }, (_, index) => `  paso_${index + 1}();`).join("\n");
  const large = applySuggestionGuardrail(replaceAnswer(rewrite), decision, { selection: SELECTION });
  assert.equal(large.truncated, true);
  assert.equal(large.applyRemoved, true);
  assert.doesNotMatch(large.text, /aplicar\s*:/i);

  // Un insert largo de codigo nuevo se sigue recortando aunque haya seleccion.
  const newCode = Array.from({ length: 7 }, (_, index) => `  cout << paso_${index + 1};`).join("\n");
  const insertAnswer = replaceAnswer(newCode).replace("Aplicar: replace", "Aplicar: insert");
  assert.equal(applySuggestionGuardrail(insertAnswer, decision, { selection: SELECTION }).truncated, true);
  // El bloque mejorado marcado como insert es un reemplazo (insertarlo lo duplicaria): no se recorta.
  const mislabeled = replaceAnswer(improved).replace("Aplicar: replace", "Aplicar: insert");
  assert.equal(applySuggestionGuardrail(mislabeled, decision, { selection: SELECTION }).truncated, false);
  // Sin linea Aplicar vale la accion pedida.
  const noApplyLine = replaceAnswer(improved).replace("Aplicar: replace\n", "");
  assert.equal(applySuggestionGuardrail(noApplyLine, decision, { selection: SELECTION, requestedAction: "replace" }).truncated, false);

  assert.equal(parseApplyAction("4) Accion: Aplicar: `replace`"), "replace");
  assert.equal(parseApplyAction("sin accion"), "");
  assert.equal(countChangedLines("a\nb\nc", "a\nb\nc"), 0);
  assert.equal(countChangedLines("a\nb", "a\nb\nc\nd"), 2);
  // Con «...» (0.0.35): las lineas resumidas no cuentan como borradas; VS Code las completa.
  const twelve = Array.from({ length: 12 }, (_, index) => `int v${index} = calcular(${index});`).join("\n");
  assert.equal(countChangedLines(twelve, "int v0 = calcular(0) + 1;\n// ... resto igual\nint v10 = calcular(10);\nint v11 = calcular(11);"), 1);
});

test("editor: si la linea Aplicar contradice el pedido, decide el contenido (igual que VS Code 0.0.34)", () => {
  const improved = SELECTION.replace("double area = base * altura;", "double area = base * altura / 2.0;");
  const snippet = "  cout << \"Area: \" << area << endl;";
  // 6 lineas significativas (las dos llaves de cierre no cuentan) y 5 quedan igual.
  assert.equal(retainedSelectionFraction(SELECTION, improved), 5 / 6);
  assert.equal(retainedSelectionFraction(SELECTION, snippet), 0);
  assert.equal(retainedSelectionFraction("", improved), 0);

  const insertAnswer = (code: string) => replaceAnswer(code).replace("Aplicar: replace", "Aplicar: insert");
  // Pidio mejorar y el modelo dijo insert: con el bloque completo es replace; con un fragmento, insert.
  assert.equal(effectiveApplyAction(insertAnswer(improved), improved, { selection: SELECTION, requestedAction: "replace" }), "replace");
  assert.equal(effectiveApplyAction(insertAnswer(snippet), snippet, { selection: SELECTION, requestedAction: "replace" }), "insert");
  // Pidio continuar y el modelo dijo replace con un fragmento: insert.
  assert.equal(effectiveApplyAction(replaceAnswer(snippet), snippet, { selection: SELECTION, requestedAction: "insert" }), "insert");
  // Sin conflicto manda la linea Aplicar (o el pedido si no hay linea).
  assert.equal(effectiveApplyAction(replaceAnswer(snippet), snippet, { selection: SELECTION }), "replace");
  assert.equal(effectiveApplyAction("sin linea", snippet, { selection: SELECTION, requestedAction: "replace" }), "replace");
  assert.equal(effectiveApplyAction(insertAnswer(snippet), snippet, { selection: SELECTION }), "insert");
  assert.equal(effectiveApplyAction("Aplicar: delete", "", { selection: SELECTION, requestedAction: "replace" }), "delete");
  // «Aplicar: delete» con el bloque mejorado cuando se pidio mejorar: replace.
  assert.equal(effectiveApplyAction("Aplicar: delete", improved, { selection: SELECTION, requestedAction: "replace" }), "replace");
  // Las llaves no cuentan: un metodo nuevo que termina en } no «conserva» un bloque que termina igual.
  const tail = "  return total;\n}";
  const newMethod = "int doble(int x) {\n  return 2 * x;\n}";
  assert.equal(effectiveApplyAction(insertAnswer(newMethod), newMethod, { selection: tail, requestedAction: "insert" }), "insert");
  assert.equal(effectiveApplyAction(insertAnswer("} else {\n  y = 0;\n}"), "} else {\n  y = 0;\n}", { selection: "if (x > 0) {\n}" }), "insert");
});

test("salida del modelo: se quitan los caracteres chinos sin tocar tildes ni la sangria", () => {
  assert.equal(stripForeignScript("La función 计算 el área."), "La función el área.");
  assert.equal(stripForeignScript("Revisa el valor计算de retorno"), "Revisa el valor de retorno");
  assert.equal(stripForeignScript("Linea final 计算\nsiguiente"), "Linea final\nsiguiente");
  assert.equal(stripForeignScript("    计算 x = 1;"), "    x = 1;");
  assert.equal(stripForeignScript("Usa（paréntesis）y：dos puntos，coma"), "Usa(paréntesis)y:dos puntos,coma");
  assert.equal(stripForeignScript("¿Qué hace?。Bien"), "¿Qué hace?. Bien");
  const clean = "  if (x > 0) {\n    return ñandú;\n  }";
  assert.equal(stripForeignScript(clean), clean, "sin caracteres extranos sale igual");
});

test("quiz: la explicacion abierta se califica aunque el modelo use claves en espanol, y la muy corta sin modelo", async () => {
  assert.deepEqual(parseFollowUpGrade('{"puntaje": "70/100", "retroalimentacion": "Bien, falto el porque."}'), { score: 70, feedback: "Bien, falto el porque." });
  assert.deepEqual(parseFollowUpGrade('```json\n{"score": 40, "feedback": "Falta el concepto."}\n```'), { score: 40, feedback: "Falta el concepto." });
  assert.equal(parseFollowUpGrade('{"score": 40}'), null);

  assert.equal(isTooShortExplanation("bla bla"), true);
  assert.equal(isTooShortExplanation("no se"), true);
  assert.equal(isTooShortExplanation("Porque si no, la matriz es null."), false);

  let calls = 0;
  setQuizModelRunnerForTests(async () => {
    calls += 1;
    return calls === 1 ? "No puedo responder en JSON 计算" : '{"score": 55, "feedback": "Explicas el cambio pero no el motivo."}';
  });
  try {
    const short = await gradeFollowUp("prompt", "bla bla");
    assert.deepEqual(short, { score: 0, feedback: SHORT_EXPLANATION_FEEDBACK });
    assert.equal(calls, 0, "no gasta la GPU");

    const retried = await gradeFollowUp("prompt", "Inicializa la matriz para que no quede nula al usarla.");
    assert.deepEqual(retried, { score: 55, feedback: "Explicas el cambio pero no el motivo." });
    assert.equal(calls, 2, "un segundo intento si la primera salida no era JSON");

    setQuizModelRunnerForTests(async () => {
      throw new Error("sin modelo");
    });
    const fallback = await gradeFollowUp("prompt", "Inicializa la matriz para que no quede nula al usarla.");
    assert.equal(fallback.score, null);
    assert.match(fallback.feedback, /No pude calificarla ahora/);
  } finally {
    setQuizModelRunnerForTests(null);
  }
});
