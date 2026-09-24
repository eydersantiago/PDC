import assert from "node:assert/strict";
import test from "node:test";
import { seedTeacherPolicy } from "../../src/db/seeds.js";
import {
  applyTemplateLimits,
  editorCodeLineLimit,
  limitCodeBlocks,
  resolveHelpStage,
} from "../../src/services/intervention-templates.js";
import {
  applySuggestionGuardrail,
  buildControlledSuggestionMarkdown,
  buildSuggestionPolicyInstruction,
  buildUnavailableSuggestionMarkdown,
  checkCodeApplication,
  classifySuggestionEvent,
  evaluateSuggestionPolicy,
  type SuggestionSignals,
} from "../../src/services/suggestion-policy.js";
import { SCENARIO_CPP_CODE, TUTOR_SCENARIOS } from "../../src/services/tutor-scenarios.js";
import type { TeacherPolicy } from "../../src/types/app.js";

/**
 * A9.5 / A10.5 (parte pura): escenarios S1-S5 del motor de politicas del
 * canal de VS Code, etapas de ayuda y guardarrail anti-solucion, sin base de
 * datos ni modelo.
 */

function policy(overrides: Partial<TeacherPolicy> = {}): TeacherPolicy {
  return {
    ...seedTeacherPolicy,
    eventRules: { ...seedTeacherPolicy.eventRules },
    codeApplication: { ...seedTeacherPolicy.codeApplication },
    updatedAt: "2026-09-23T00:00:00.000Z",
    ...overrides,
  } as TeacherPolicy;
}

const CPP_CODE = SCENARIO_CPP_CODE;

/** Escenarios del editor (src/services/tutor-scenarios.ts) como senales del motor. */
const SUGGESTION_SCENARIOS = TUTOR_SCENARIOS
  .filter((scenario) => scenario.editor)
  .map((scenario) => {
    const body = scenario.editor!.body;
    const signals: SuggestionSignals = {
      tabContent: body.tab_content,
      languageHint: body.languageHint,
      filePath: body.filePath,
      visibleError: body.visibleError,
      diagnostics: body.diagnostics,
      question: body.question,
      trigger: body.trigger,
    };
    return {
      id: scenario.id,
      label: scenario.titulo,
      signals,
      eventType: scenario.editor!.expected.eventType,
      blocked: scenario.editor!.expected.blocked,
      helpStage: scenario.editor!.expected.helpStage,
    };
  });

test("suggestion-policy: clasifica los escenarios S1-S5 del editor", () => {
  for (const scenario of SUGGESTION_SCENARIOS) {
    assert.equal(classifySuggestionEvent(scenario.signals), scenario.eventType, `${scenario.id}: ${scenario.label}`);
  }
  assert.equal(classifySuggestionEvent({ tabContent: "   " }), "insufficient_context");
  assert.equal(classifySuggestionEvent({ tabContent: CPP_CODE, languageHint: "cpp" }), "code_suggestion");
  // Un error visible manda aunque la pregunta sea conceptual.
  assert.equal(
    classifySuggestionEvent({ ...SUGGESTION_SCENARIOS[2].signals, visibleError: "error: 'saldo' is private" }),
    "compile_error",
  );
  // Una pregunta sin palabras de programacion sobre codigo sigue siendo del curso.
  assert.equal(
    classifySuggestionEvent({ tabContent: CPP_CODE, languageHint: "cpp", question: "Me ayudas con esto?" }),
    "code_suggestion",
  );
});

test("suggestion-policy: S1-S5 aplican la regla del docente con etapa y limite de codigo", () => {
  const base = policy();
  for (const scenario of SUGGESTION_SCENARIOS) {
    const decision = evaluateSuggestionPolicy({ policy: base, signals: scenario.signals, applicationsUsed: 0 });
    assert.equal(decision.eventType, scenario.eventType, scenario.id);
    assert.equal(decision.blocked, scenario.blocked, scenario.id);
    assert.equal(decision.helpStage, scenario.helpStage, scenario.id);
    if (scenario.blocked) {
      assert.equal(decision.helpStage, "controlled");
      assert.equal(decision.reasonCode, "out_of_domain");
      assert.equal(decision.codeApplication.allowed, false);
    } else {
      assert.equal(decision.reasonCode, "ok");
      assert.equal(decision.codeApplication.allowed, true);
    }
  }

  const s1 = evaluateSuggestionPolicy({ policy: base, signals: SUGGESTION_SCENARIOS[0].signals, applicationsUsed: 0 });
  assert.equal(s1.helpStage, "hint_1");
  assert.equal(s1.codeApplication.maxLines, 5);
  assert.equal(s1.codeApplication.remaining, 3);

  const s3 = evaluateSuggestionPolicy({ policy: base, signals: SUGGESTION_SCENARIOS[2].signals, applicationsUsed: 0 });
  assert.equal(s3.helpStage, "explanation");
  assert.equal(s3.codeApplication.maxLines, 4);

  const s4 = evaluateSuggestionPolicy({ policy: base, signals: SUGGESTION_SCENARIOS[3].signals, applicationsUsed: 0 });
  assert.equal(s4.helpStage, "hint_1");
});

test("suggestion-policy: la ayuda sube de etapa con cada cambio aplicado y se corta en el limite", () => {
  const base = policy();
  const signals = SUGGESTION_SCENARIOS[0].signals;
  const stages = [0, 1, 2, 3].map((used) => evaluateSuggestionPolicy({ policy: base, signals, applicationsUsed: used }));

  assert.deepEqual(stages.map((item) => item.helpStage), ["hint_1", "hint_2", "partial_example", "partial_example"]);
  assert.deepEqual(stages.map((item) => item.codeApplication.maxLines), [5, 10, 20, 20]);
  assert.deepEqual(stages.map((item) => item.codeApplication.remaining), [3, 2, 1, 0]);
  assert.equal(stages[3].blocked, false, "la sugerencia sigue, solo no se puede aplicar codigo");
  assert.equal(stages[3].codeApplication.allowed, false);
  assert.equal(stages[3].codeApplication.reasonCode, "code_application_limit_reached");

  // El maximo del docente siempre manda sobre el tope de la etapa.
  const strict = policy({ codeApplication: { ...base.codeApplication, maxLines: 3 } });
  assert.equal(evaluateSuggestionPolicy({ policy: strict, signals, applicationsUsed: 0 }).codeApplication.maxLines, 3);
  assert.equal(evaluateSuggestionPolicy({ policy: strict, signals, applicationsUsed: 2 }).codeApplication.maxLines, 3);
  assert.equal(editorCodeLineLimit("hint_2", 200), 10);
  assert.equal(editorCodeLineLimit("partial_example", 200), 200);
  assert.equal(editorCodeLineLimit("controlled", 20), 0);
});

test("suggestion-policy: regla desactivada y aplicacion de codigo desactivada", () => {
  const base = policy();
  const disabled = policy({
    eventRules: { ...base.eventRules, compile_error: { ...base.eventRules.compile_error, enabled: false } },
  });
  const decision = evaluateSuggestionPolicy({ policy: disabled, signals: SUGGESTION_SCENARIOS[0].signals, applicationsUsed: 0 });
  assert.equal(decision.blocked, true);
  assert.equal(decision.reasonCode, "rule_disabled");
  assert.match(buildControlledSuggestionMarkdown(disabled, decision), /Motivo de control: La politica docente desactivo/);

  const noApply = policy({ codeApplication: { ...base.codeApplication, allowed: false } });
  const noApplyDecision = evaluateSuggestionPolicy({ policy: noApply, signals: SUGGESTION_SCENARIOS[0].signals, applicationsUsed: 0 });
  assert.equal(noApplyDecision.blocked, false);
  assert.equal(noApplyDecision.codeApplication.allowed, false);
  assert.equal(noApplyDecision.codeApplication.reasonCode, "code_application_disabled");
  assert.match(buildSuggestionPolicyInstruction(noApply, noApplyDecision), /No incluyas la linea `Aplicar:`/);
});

test("suggestion-policy: la instruccion del editor no prohibe el codigo aplicable y exige no dar la solucion", () => {
  const base = policy();
  const decision = evaluateSuggestionPolicy({ policy: base, signals: SUGGESTION_SCENARIOS[0].signals, applicationsUsed: 0 });
  const instruction = buildSuggestionPolicyInstruction(base, decision);
  assert.match(instruction, /PISTA NIVEL 1 \(editor\)/);
  assert.match(instruction, /maximo 5 lineas/);
  assert.match(instruction, /No entregues la solucion completa/);
  assert.doesNotMatch(instruction, /No escribas codigo/);
  assert.doesNotMatch(instruction, /No incluyas la linea `Aplicar:`/);
});

function codeBlock(lines: number, language = "cpp") {
  const body = Array.from({ length: lines }, (_, index) => `linea_${index + 1}();`).join("\n");
  return `\`\`\`${language}\n${body}\n\`\`\``;
}

function suggestionMarkdown(lines: number, applyLine = "4) Accion: Aplicar: replace") {
  return [
    "1) Resumen:",
    "- Falta un punto y coma.",
    "",
    applyLine,
    codeBlock(lines),
    "",
    "5) Riesgos:",
    "- Revisa que compile.",
  ].join("\n");
}

test("suggestion-policy (A10.5): el guardarrail recorta la solucion completa y quita Aplicar", () => {
  const base = policy();
  const hint1 = evaluateSuggestionPolicy({ policy: base, signals: SUGGESTION_SCENARIOS[0].signals, applicationsUsed: 0 });

  const fullSolution = applySuggestionGuardrail(suggestionMarkdown(40), hint1);
  assert.equal(fullSolution.truncated, true);
  assert.equal(fullSolution.applyRemoved, true);
  assert.doesNotMatch(fullSolution.text, /Aplicar\s*:/i);
  assert.match(fullSolution.text, /linea_5\(\);/);
  assert.doesNotMatch(fullSolution.text, /linea_6\(\);/);
  assert.match(fullSolution.text, /recortado por la politica del docente/);

  const smallFix = applySuggestionGuardrail(suggestionMarkdown(3, "- Aplicar: `replace`"), hint1);
  assert.equal(smallFix.truncated, false);
  assert.equal(smallFix.applyRemoved, false);
  assert.match(smallFix.text, /Aplicar: `replace`/);

  const limitReached = evaluateSuggestionPolicy({ policy: base, signals: SUGGESTION_SCENARIOS[0].signals, applicationsUsed: 3 });
  for (const applyLine of ["Aplicar: insert", "- Aplicar: replace", "4) Acción: Aplicar: delete", "> Aplicar: `insert`", "* aplicar:replace"]) {
    const guarded = applySuggestionGuardrail(suggestionMarkdown(2, applyLine), limitReached);
    assert.equal(guarded.applyRemoved, true, applyLine);
    assert.doesNotMatch(guarded.text, /aplicar\s*:/i, applyLine);
    assert.match(guarded.text, /linea_2\(\);/, "el codigo corto se deja como guia");
  }

  const unavailable = buildUnavailableSuggestionMarkdown();
  assert.doesNotMatch(unavailable, /aplicar\s*:|```/i);
});

test("suggestion-policy (A10.8): apply-check valida tamano, desactivacion y cupo", () => {
  const base = policy();
  const tooLarge = checkCodeApplication(base, { linesChanged: 25 }, 0);
  assert.equal(tooLarge.allowed, false);
  assert.equal(tooLarge.reasonCode, "code_application_too_large");

  const ok = checkCodeApplication(base, { linesChanged: 20 }, 2);
  assert.equal(ok.allowed, true);
  assert.equal(ok.remaining, 1);
  assert.equal(ok.requireConfirmation, true);

  const exhausted = checkCodeApplication(base, { linesChanged: 1 }, 3);
  assert.equal(exhausted.allowed, false);
  assert.equal(exhausted.reasonCode, "code_application_limit_reached");

  const disabled = checkCodeApplication(policy({ codeApplication: { ...base.codeApplication, allowed: false } }), { linesChanged: 1 }, 0);
  assert.equal(disabled.reasonCode, "code_application_disabled");

  const notCounted = checkCodeApplication(policy({ codeApplication: { ...base.codeApplication, countsAsHint: false } }), { linesChanged: 1 }, 99);
  assert.equal(notCounted.allowed, true);
  assert.equal(notCounted.remaining, null);
});

test("intervention-templates (A2.2): etapas graduales del overlay y limites de codigo", () => {
  const progressive = { helpLevel: "progressive" as const, allowMiniQuiz: true };
  const hintRule = { interventionType: "hint" as const };
  assert.deepEqual(
    [0, 1, 2, 5].map((hintsUsed) => resolveHelpStage({ policy: progressive, rule: hintRule, hintsUsed })),
    ["hint_1", "hint_2", "partial_example", "partial_example"],
  );
  assert.deepEqual(
    [0, 3].map((hintsUsed) => resolveHelpStage({ policy: { ...progressive, helpLevel: "hint_only" }, rule: hintRule, hintsUsed })),
    ["hint_1", "hint_2"],
  );
  assert.equal(resolveHelpStage({ policy: progressive, rule: { interventionType: "explanation" }, hintsUsed: 4 }), "explanation");
  assert.equal(resolveHelpStage({ policy: { ...progressive, allowMiniQuiz: false }, rule: { interventionType: "mini_quiz" }, hintsUsed: 0 }), "hint_1");
  assert.equal(resolveHelpStage({ policy: progressive, rule: hintRule, hintsUsed: 0, blocked: true }), "controlled");

  const noCode = limitCodeBlocks(`Mira esto:\n${codeBlock(6)}`, 0);
  assert.equal(noCode.truncated, true);
  assert.doesNotMatch(noCode.text, /linea_1/);

  const result = applyTemplateLimits({
    ideas: [`Idea con codigo:\n${codeBlock(12)}`, "Idea 2", "Idea 3"],
    searches: ["a", "b", "c"],
    guide: ["1", "2", "3", "4"],
    welcome_message: "Hola",
    analysis_summary: "Resumen",
  }, "hint_2");
  assert.match(result.ideas[0], /linea_2\(\);/);
  assert.doesNotMatch(result.ideas[0], /linea_3\(\);/);
});

test("politica: las etapas respetan las intervenciones habilitadas por el docente", () => {
  const hintRule = { interventionType: "hint" as const };
  const withAllowed = (allowedInterventions: TeacherPolicy["allowedInterventions"]) => ({ helpLevel: "progressive" as const, allowMiniQuiz: true, allowedInterventions });

  // Sin "example", la tercera pista se queda en pista 2.
  assert.equal(resolveHelpStage({ policy: withAllowed(["hint", "explanation"]), rule: hintRule, hintsUsed: 2 }), "hint_2");
  // Sin "hint", la pista pasa a explicacion.
  assert.equal(resolveHelpStage({ policy: withAllowed(["explanation"]), rule: hintRule, hintsUsed: 0 }), "explanation");
  // Ningun tipo compatible: mensaje controlado.
  assert.equal(resolveHelpStage({ policy: withAllowed(["mini_quiz"]), rule: hintRule, hintsUsed: 0 }), "controlled");
  // Lista vacia (politicas anteriores): sin restriccion.
  assert.equal(resolveHelpStage({ policy: withAllowed([]), rule: hintRule, hintsUsed: 2 }), "partial_example");

  const onlyQuiz = policy({ allowedInterventions: ["mini_quiz"] });
  const decision = evaluateSuggestionPolicy({ policy: onlyQuiz, signals: SUGGESTION_SCENARIOS[0].signals, applicationsUsed: 0 });
  assert.equal(decision.blocked, true);
  assert.equal(decision.reasonCode, "rule_disabled");

  const withOutcome = policy({ outcome: "RA2" });
  const allowed = evaluateSuggestionPolicy({ policy: withOutcome, signals: SUGGESTION_SCENARIOS[0].signals, applicationsUsed: 0 });
  assert.match(buildSuggestionPolicyInstruction(withOutcome, allowed), /Resultado de aprendizaje: RA2\./);
});
