import assert from "node:assert/strict";
import test from "node:test";
import { seedTeacherPolicy } from "../../src/db/seeds.js";
import { finalizeEditorSuggestion, truncationTelemetryReason, type EditorOutputReference } from "../../src/services/suggestion-output.js";
import { evaluateSuggestionPolicy } from "../../src/services/suggestion-policy.js";
import type { TeacherPolicy } from "../../src/types/app.js";

/**
 * La salida de /suggest-tab (src/services/suggestion-output.ts, 30-10-2026): los pasos sobre el
 * texto del modelo en un orden fijo. Codigo ficticio.
 */

function policy(overrides: Partial<TeacherPolicy> = {}): TeacherPolicy {
  return {
    ...seedTeacherPolicy,
    eventRules: { ...seedTeacherPolicy.eventRules },
    codeApplication: { ...seedTeacherPolicy.codeApplication },
    updatedAt: "2026-10-30T00:00:00.000Z",
    ...overrides,
  } as TeacherPolicy;
}

function decisionFor(base = policy(), applicationsUsed = 0) {
  return evaluateSuggestionPolicy({
    policy: base,
    signals: { tabContent: "int main() {}", languageHint: "cpp", filePath: "src/main.cpp", question: "Ayuda" },
    applicationsUsed,
  });
}

const lines = (count: number, name = "paso") => Array.from({ length: count }, (_, index) => `${name}_${index + 1}();`).join("\n");

/** Una referencia de juguete que anota en que orden la llamaron. */
function recordingReference(calls: string[]): EditorOutputReference {
  return {
    keepFirstBlock(output) {
      calls.push(`keepFirstBlock:${(output.match(/```/g) || []).length}`);
      const cut = output.indexOf("\nDespues:");
      return cut >= 0 ? { text: output.slice(0, cut), removedBlocks: 1 } : { text: output, removedBlocks: 0 };
    },
    removeLeakedReferenceLines(output) {
      calls.push(`removeLeakedReferenceLines:${/_El tutor muestra/.test(output) ? "despues-del-recorte" : "antes"}`);
      return { text: output.replace("COPIA-DE-LA-REFERENCIA;\n", ""), removedLines: output.includes("COPIA-DE-LA-REFERENCIA;") ? 1 : 0 };
    },
  };
}

test("salida del editor: el orden es vallas, «Aplicar:», un solo bloque, recorte, permiso y referencia", () => {
  const calls: string[] = [];
  // La valla esta a mitad de linea, «Aplicar:» dentro del bloque, hay un segundo bloque y una
  // linea copiada de la referencia fuera de los bloques.
  const raw = [
    "1) Resumen:",
    "COPIA-DE-LA-REFERENCIA;",
    "Codigo: ```cpp",
    "Aplicar: insert",
    lines(8),
    "```",
    "Despues:",
    "```cpp",
    lines(2, "otro"),
    "```",
  ].join("\n");
  const result = finalizeEditorSuggestion(raw, { decision: decisionFor(), options: { languageHint: "cpp" }, examReference: recordingReference(calls) });
  // keepFirstBlock ve los dos bloques ya con las vallas en su linea; la limpieza ve el recorte hecho.
  assert.deepEqual(calls, ["keepFirstBlock:4", "removeLeakedReferenceLines:despues-del-recorte"]);
  assert.equal(result.counters.removedBlocks, 1);
  assert.equal(result.counters.removedLines, 1);
  assert.equal(truncationTelemetryReason(result), "codigo_parcial_aplicable");
  // El recorte se hizo sobre el unico bloque: un insert cerrado se puede aplicar.
  assert.equal(result.truncation, "applicable");
  assert.deepEqual(result.cutSummary, { kind: "prefix", linesShown: 5, linesTotal: 8, endsCleanly: true });
  assert.match(result.text, /^Aplicar: insert$/m, "la linea salio del bloque y se conserva");
  assert.match(result.text, /Codigo:\nAplicar: insert\n\n```cpp\npaso_1\(\);/);
  assert.doesNotMatch(result.text, /paso_6\(\);|otro_1|COPIA-DE-LA-REFERENCIA/);
  assert.equal(result.codeApplication?.allowed, true);
  assert.equal(result.counters.applyLineRemoved, false);

  // Sin la referencia, los dos bloques quedan: VS Code solo aplica el primero, asi que es guia.
  const plain = finalizeEditorSuggestion(raw, { decision: decisionFor(), options: { languageHint: "cpp" } });
  assert.equal(plain.truncation, "guide");
  assert.equal(plain.codeApplication?.allowed, false);
  assert.equal(plain.codeApplication?.reasonCode, "code_application_too_large");
  assert.match(String(plain.codeApplication?.reason), /pasaba de 5 lineas y se recorto/);
  assert.equal(plain.guideCause, "cap");
  assert.equal(truncationTelemetryReason(plain), "codigo_recortado_guia");
  assert.equal(plain.counters.applyLineRemoved, true);
  assert.doesNotMatch(plain.text, /aplicar\s*:/i);
});

test("salida del editor: un recorte de guia conserva el motivo si aplicar ya no estaba permitido", () => {
  const raw = ["Aplicar: replace", "```cpp", lines(9), "```"].join("\n");
  const disabled = decisionFor(policy({ codeApplication: { ...seedTeacherPolicy.codeApplication, allowed: false } }));
  const result = finalizeEditorSuggestion(raw, { decision: disabled, options: { languageHint: "cpp" } });
  assert.equal(result.truncation, "guide");
  assert.equal(result.codeApplication?.reasonCode, "code_application_disabled");
  const exhausted = finalizeEditorSuggestion(raw, { decision: decisionFor(policy(), 3), options: { languageHint: "cpp" } });
  assert.equal(exhausted.codeApplication?.reasonCode, "code_application_limit_reached");
});

test("salida del editor: una respuesta cortada es su propio motivo (no el tope); sin decision no se toca", () => {
  const cutOff = ["Aplicar: insert", "```cpp", lines(3)].join("\n");
  const result = finalizeEditorSuggestion(cutOff, { decision: decisionFor(), options: { languageHint: "cpp" } });
  assert.equal(result.truncation, "guide");
  assert.equal(result.guideCause, "incomplete_reply");
  assert.match(result.text, /```cpp\npaso_1\(\);\npaso_2\(\);\npaso_3\(\);\n```/, "sale cerrado, como guia");
  assert.match(String(result.codeApplication?.reason), /llego cortada/);
  assert.equal(result.codeApplication?.reasonCode, "code_application_incomplete_reply");
  assert.equal(truncationTelemetryReason(result), "codigo_incompleto_guia");
  // Cortada y ademas larga: sigue siendo una respuesta cortada, no un limite del docente.
  const longCutOff = finalizeEditorSuggestion(["```cpp", lines(30)].join("\n"), { decision: decisionFor(), options: { languageHint: "cpp" } });
  assert.equal(longCutOff.codeApplication?.reasonCode, "code_application_incomplete_reply");
  assert.deepEqual(longCutOff.cutSummary, { kind: "prefix", linesShown: 5, linesTotal: 30, endsCleanly: true });
  assert.deepEqual(result.cutSummary, { kind: "prefix", linesShown: 3, linesTotal: 3, endsCleanly: true });

  const noPolicy = finalizeEditorSuggestion("```cpp\na();\n```", { decision: null, options: {} });
  assert.deepEqual(noPolicy, {
    text: "```cpp\na();\n```",
    codeApplication: null,
    truncation: "none",
    guideCause: null,
    cutSummary: null,
    counters: { removedBlocks: 0, removedLines: 0, applyLineRemoved: false },
  });
});
