// La salida de /suggest-tab ya lista para el estudiante (30-10-2026): todos los pasos sobre el
// texto del modelo, en un orden fijo y en un modulo puro, para que la ruta solo registre la
// decision, escriba los logs y arme la respuesta.
//
// Orden (cada paso depende del anterior):
//   1. las vallas a mitad de linea pasan a su propia linea (normalizeFenceLines);
//   2. la linea «Aplicar:» que el modelo escribio dentro del bloque sale afuera;
//   3. con la referencia del examen, queda un solo bloque de codigo (el primero, cerrado);
//   4. el guardarrail de la politica recorta el codigo al tope de la etapa (sobre el bloque que
//      quedo: asi el reemplazo parcial es el del codigo que va a ver el estudiante);
//   5. un recorte de guia ya no se puede aplicar (code_application.allowed=false);
//   6. con la referencia del examen, sin lineas copiadas de ella fuera de los bloques.
import type { CutSummary } from "./code-cut.js";
import { normalizeFenceLines } from "./markdown-fences.js";
import {
  applySuggestionGuardrail,
  moveApplyLinesOutOfCodeFences,
  type CodeApplicationDecision,
  type GuardrailOutcome,
  type SuggestionPolicyDecision,
  type SuggestionRequestOptions,
} from "./suggestion-policy.js";

/** Lo que este paso usa de la referencia del examen (ExamReferenceContext de exam-reference.ts). */
export type EditorOutputReference = {
  keepFirstBlock(output: string): { text: string; removedBlocks: number };
  sanitize(output: string): { text: string; removedLines: number };
};

export type FinalizedEditorSuggestion = {
  text: string;
  /** La decision de aplicar codigo, ya sin permiso si el recorte quedo como guia. */
  codeApplication: CodeApplicationDecision | null;
  /** code_application.truncation de la respuesta. */
  truncation: GuardrailOutcome;
  /** code_application.cut de la respuesta; null si no se recorto nada. */
  cutSummary: CutSummary | null;
  /** Para los logs. */
  counters: { extraBlocksRemoved: number; leakedLinesRemoved: number; applyLineRemoved: boolean };
};

/**
 * Motivo de un recorte de guia. Un bloque que llego sin cerrar y sin pasar del tope no se recorto
 * por largo: la respuesta del modelo se corto.
 */
function guideReason(maxLines: number, cut: CutSummary | null) {
  if (cut?.kind === "prefix" && cut.linesShown >= cut.linesTotal) {
    return "La respuesta del tutor llego cortada: usa el codigo como guia.";
  }
  return `El codigo sugerido pasaba de ${maxLines} lineas y se recorto: usalo como guia.`;
}

export function finalizeEditorSuggestion(
  rawOutput: string,
  input: {
    decision: SuggestionPolicyDecision | null;
    options: SuggestionRequestOptions;
    examReference?: EditorOutputReference | null;
  },
): FinalizedEditorSuggestion {
  let text = moveApplyLinesOutOfCodeFences(normalizeFenceLines(String(rawOutput || "")));
  const counters = { extraBlocksRemoved: 0, leakedLinesRemoved: 0, applyLineRemoved: false };

  if (input.examReference) {
    const single = input.examReference.keepFirstBlock(text);
    text = single.text;
    counters.extraBlocksRemoved = single.removedBlocks;
  }

  let codeApplication = input.decision?.codeApplication || null;
  let truncation: GuardrailOutcome = "none";
  let cutSummary: CutSummary | null = null;
  if (input.decision) {
    const guarded = applySuggestionGuardrail(text, input.decision, input.options);
    text = guarded.text;
    truncation = guarded.outcome;
    cutSummary = guarded.cutSummary;
    counters.applyLineRemoved = guarded.applyRemoved;
    // Un recorte que se puede aplicar deja aplicar (asi la etapa puede avanzar); uno de guia no.
    // Si ya no se podia aplicar (docente, cupo, piloto), queda el motivo que ya tenia.
    if (truncation === "guide" && codeApplication?.allowed) {
      codeApplication = {
        ...codeApplication,
        allowed: false,
        reason: guideReason(codeApplication.maxLines, cutSummary),
        reasonCode: "code_application_too_large",
      };
    }
  }

  if (input.examReference) {
    const sanitized = input.examReference.sanitize(text);
    text = sanitized.text;
    counters.leakedLinesRemoved = sanitized.removedLines;
  }

  return { text, codeApplication, truncation, cutSummary, counters };
}
