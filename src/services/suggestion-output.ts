// La salida de /suggest-tab ya lista para el estudiante (30-10-2026): todos los pasos sobre el
// texto del modelo, en un orden fijo y en un modulo puro, para que la ruta solo registre la
// decision, escriba los logs y arme la respuesta.
//
// prepareEditorModelOutput (la ruta la usa apenas llega la respuesta del modelo, antes de decidir
// si reintenta o si la guarda en la cache; finalizeEditorSuggestion la repite al comienzo):
//   1. las vallas a mitad de linea pasan a su propia linea (normalizeFenceLines);
//   2. sin el margen numerado que el modelo copio del contexto (stripCodeFenceGutters);
//   3. la linea «Aplicar:» que el modelo escribio dentro del bloque sale afuera.
// finalizeEditorSuggestion, despues:
//   4. con la referencia del examen, queda un solo bloque de codigo (el primero, cerrado);
//   5. el guardarrail de la politica recorta el codigo al tope de la etapa (sobre el bloque que
//      quedo: asi el reemplazo parcial es el del codigo que va a ver el estudiante);
//   6. un recorte de guia ya no se puede aplicar (code_application.allowed=false);
//   7. con la referencia del examen, sin lineas copiadas de ella fuera de los bloques.
import type { CutSummary } from "./code-cut.js";
import { mapFences, normalizeFenceLines, renderFence } from "./markdown-fences.js";
import { GUARDRAIL_TRUNCATION_REASON } from "./telemetry-catalog.js";
import {
  applySuggestionGuardrail,
  moveApplyLinesOutOfCodeFences,
  type CodeApplicationDecision,
  type CodeTruncation,
  type GuideCause,
  type SuggestionPolicyDecision,
  type SuggestionRequestOptions,
} from "./suggestion-policy.js";

const COPIED_GUTTER = /^[ \t]*\d+[ \t]*>?[ \t]*[|│] ?/;

/**
 * Quita de los bloques de codigo de la respuesta el margen numerado que el modelo copio del
 * contexto ("  16>| codigo"), solo si TODAS sus lineas con texto lo traen (revision
 * independiente del 21/10/2026: con el margen, el guardarrail contaba todas las lineas como
 * cambiadas y un «// TODO» pasaba por codigo). Un bloque sin cerrar sigue sin cerrar.
 */
export function stripCodeFenceGutters(markdown: string) {
  return mapFences(String(markdown || ""), (fence) => {
    const lines = fence.code.split("\n");
    const withText = lines.filter((line) => line.trim());
    if (!withText.length || !withText.every((line) => COPIED_GUTTER.test(line))) return null;
    const code = lines.map((line) => (line.trim() ? line.replace(COPIED_GUTTER, "") : "")).join("\n");
    return renderFence({ info: fence.info, code, closed: fence.closed });
  });
}

/**
 * La respuesta del modelo con las vallas en su linea, sin margen numerado y con «Aplicar:» fuera
 * de los bloques (pasos 1 a 3). Aplicarla dos veces da lo mismo.
 */
export function prepareEditorModelOutput(rawOutput: string) {
  return moveApplyLinesOutOfCodeFences(stripCodeFenceGutters(normalizeFenceLines(String(rawOutput || ""))));
}

/** Lo que este paso usa de la referencia del examen (ExamReferenceContext de exam-reference.ts). */
export type EditorOutputReference = {
  keepFirstBlock(output: string): { text: string; removedBlocks: number };
  removeLeakedReferenceLines(output: string): { text: string; removedLines: number };
};

export type FinalizedEditorSuggestion = {
  text: string;
  /** La decision de aplicar codigo, ya sin permiso si el recorte quedo como guia. */
  codeApplication: CodeApplicationDecision | null;
  /** code_application.truncation de la respuesta. */
  truncation: CodeTruncation;
  /** Por que un recorte quedo como guia: el tope de la etapa o una respuesta cortada. */
  guideCause: GuideCause | null;
  /** code_application.cut de la respuesta; null si no se recorto nada. */
  cutSummary: CutSummary | null;
  /** Para los logs. */
  counters: { removedBlocks: number; removedLines: number; applyLineRemoved: boolean };
};

const GUIDE_REASON: Record<GuideCause, { reason: (maxLines: number) => string; reasonCode: CodeApplicationDecision["reasonCode"] }> = {
  cap: {
    reason: (maxLines) => `El codigo sugerido pasaba de ${maxLines} lineas y se recorto: usalo como guia.`,
    reasonCode: "code_application_too_large",
  },
  incomplete_reply: {
    reason: () => "La respuesta del tutor llego cortada (el bloque de codigo no termina): usa el codigo como guia.",
    reasonCode: "code_application_incomplete_reply",
  },
};

export function finalizeEditorSuggestion(
  rawOutput: string,
  input: {
    decision: SuggestionPolicyDecision | null;
    options: SuggestionRequestOptions;
    examReference?: EditorOutputReference | null;
  },
): FinalizedEditorSuggestion {
  let text = prepareEditorModelOutput(rawOutput);
  const counters = { removedBlocks: 0, removedLines: 0, applyLineRemoved: false };

  if (input.examReference) {
    const single = input.examReference.keepFirstBlock(text);
    text = single.text;
    counters.removedBlocks = single.removedBlocks;
  }

  let codeApplication = input.decision?.codeApplication || null;
  let truncation: CodeTruncation = "none";
  let guideCause: GuideCause | null = null;
  let cutSummary: CutSummary | null = null;
  if (input.decision) {
    const guarded = applySuggestionGuardrail(text, input.decision, input.options);
    text = guarded.text;
    truncation = guarded.outcome;
    guideCause = guarded.guideCause;
    cutSummary = guarded.cutSummary;
    counters.applyLineRemoved = guarded.applyRemoved;
    // Un recorte que se puede aplicar deja aplicar (asi la etapa puede avanzar); uno de guia no.
    // Si ya no se podia aplicar (docente, cupo, piloto), queda el motivo que ya tenia.
    if (truncation === "guide" && guideCause && codeApplication?.allowed) {
      const guide = GUIDE_REASON[guideCause];
      codeApplication = { ...codeApplication, allowed: false, reason: guide.reason(codeApplication.maxLines), reasonCode: guide.reasonCode };
    }
  }

  if (input.examReference) {
    const cleaned = input.examReference.removeLeakedReferenceLines(text);
    text = cleaned.text;
    counters.removedLines = cleaned.removedLines;
  }

  return { text, codeApplication, truncation, guideCause, cutSummary, counters };
}

/** metadata.reason de tutor_decision para el recorte de esta salida ("" si no se recorto). */
export function truncationTelemetryReason(finalized: Pick<FinalizedEditorSuggestion, "truncation" | "guideCause">) {
  if (finalized.truncation === "applicable") return GUARDRAIL_TRUNCATION_REASON.applicable;
  if (finalized.truncation === "guide") {
    return finalized.guideCause === "incomplete_reply" ? GUARDRAIL_TRUNCATION_REASON.incomplete : GUARDRAIL_TRUNCATION_REASON.guide;
  }
  return "";
}
