import { PILOT_NO_TUTOR_MESSAGE, PILOT_NO_TUTOR_REASON, type PilotCondition } from "./pilot.js";
import type {
  CodeApplicationSettings,
  DecisionReasonCode,
  HelpStage,
  PolicyEventType,
  PolicyRule,
  TeacherPolicy,
} from "../types/app.js";
import { editorCodeLineLimit, editorStageInstruction, limitCodeBlocks, resolveHelpStage } from "./intervention-templates.js";

/**
 * Motor de politicas para el canal de VS Code (/suggest-tab y apply-check).
 * A9.10: clasifica el evento, aplica la regla del docente y da la etapa de
 * ayuda. A10.8: decide si se puede aplicar codigo y con que limite.
 *
 * Modulo puro para poder probar todos los escenarios sin base ni modelo.
 */

export type SuggestionDiagnostic = { message: string; severity: "error" | "warning"; line?: number };

export type SuggestionSignals = {
  question?: string;
  scope?: string;
  trigger?: string;
  visibleError?: string;
  diagnostics?: SuggestionDiagnostic[];
  selection?: string;
  tabContent?: string;
  languageHint?: string;
  filePath?: string;
};

function normalize(text: unknown) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

const RUNTIME_PATTERN = /traceback|exception|segmentation fault|core dumped|nullpointer|typeerror|nameerror|valueerror|indexerror|keyerror|zerodivision|runtime|panic|stack overflow/;
const CONCEPT_PATTERN = /encapsul|herenc|polimorf|abstrac|clase abstracta|interfaz|objeto|constructor|destructor|referencia|puntero|sobrecarga|que es|por que|para que sirve|diferencia entre/;
const DESIGN_PATTERN = /diseno|diagrama|responsabilidad|enunciado|modelar|relacion entre clases|traducir|historia de usuario|uml/;
const CODE_TOKENS = /[;{}()=]|\bdef \b|\bclass \b|#include|\bimport \b|\bpublic\b|\breturn\b|\bfunction\b|=>/;
const PROGRAMMING_WORDS = /codigo|code|funcion|metodo|clase|objeto|variable|error|compil|ejecut|prueba|test|bug|depur|python|c\+\+|java|javascript|archivo|linea|bucle|lista|arreglo|vector|puntero|referencia|git|repositorio|programa/;

const KNOWN_CODE_LANGUAGES = new Set([
  "c", "cpp", "c++", "python", "py", "java", "javascript", "typescript", "js", "ts", "csharp", "cs", "go", "rust", "kotlin", "php", "ruby",
]);

export function firstErrorText(signals: SuggestionSignals) {
  const visible = String(signals.visibleError || "").trim();
  if (visible) return visible;
  const error = (signals.diagnostics || []).find((item) => item.severity === "error");
  return error ? String(error.message || "").trim() : "";
}

function looksLikeCode(signals: SuggestionSignals) {
  if (KNOWN_CODE_LANGUAGES.has(normalize(signals.languageHint))) return true;
  return CODE_TOKENS.test(String(signals.tabContent || "").slice(0, 4000));
}

/** Cuantas senales de contexto hay (el umbral de activacion de la regla). */
export function countSuggestionSignals(signals: SuggestionSignals) {
  return [
    String(signals.tabContent || "").trim(),
    String(signals.selection || "").trim(),
    firstErrorText(signals),
    String(signals.filePath || "").trim(),
    String(signals.question || "").trim(),
  ].filter(Boolean).length;
}

/**
 * Evento de politica para una peticion de VS Code. En el editor el
 * estudiante esta programando, asi que por defecto la consulta es del
 * dominio; solo es "fuera de dominio" una pregunta que no habla de
 * programacion sobre un archivo que no es codigo.
 */
export function classifySuggestionEvent(signals: SuggestionSignals): PolicyEventType {
  const content = String(signals.tabContent || "").trim();
  if (!content) return "insufficient_context";

  const error = normalize(firstErrorText(signals));
  if (error) {
    return RUNTIME_PATTERN.test(error) ? "runtime_error" : "compile_error";
  }

  const question = normalize(signals.question);
  if (question && !PROGRAMMING_WORDS.test(question) && !looksLikeCode(signals)) {
    return "out_of_domain";
  }
  if (question && CONCEPT_PATTERN.test(question)) return "concept_question";
  if (question && DESIGN_PATTERN.test(question)) return "design_block";
  return "code_suggestion";
}

export type CodeApplicationDecision = {
  allowed: boolean;
  maxLines: number;
  remaining: number | null;
  requireConfirmation: boolean;
  countsAsHint: boolean;
  reason: string;
  reasonCode: DecisionReasonCode;
};

/** Estado de la aplicacion de codigo para un archivo, antes de saber el tamano del cambio. */
export function describeCodeApplication(
  policy: Pick<TeacherPolicy, "codeApplication" | "maxHintsPerExercise">,
  applicationsUsed: number,
): CodeApplicationDecision {
  const settings: CodeApplicationSettings = policy.codeApplication;
  const limit = settings.countsAsHint ? policy.maxHintsPerExercise : null;
  const remaining = limit === null || limit === undefined ? null : Math.max(0, limit - applicationsUsed);
  if (!settings.allowed) {
    return {
      allowed: false,
      maxLines: settings.maxLines,
      remaining,
      requireConfirmation: settings.requireConfirmation,
      countsAsHint: settings.countsAsHint,
      reason: "Tu docente desactivo la aplicacion automatica de codigo. Usa la sugerencia como guia y escribelo tu.",
      reasonCode: "code_application_disabled",
    };
  }
  if (remaining !== null && remaining <= 0) {
    return {
      allowed: false,
      maxLines: settings.maxLines,
      remaining: 0,
      requireConfirmation: settings.requireConfirmation,
      countsAsHint: settings.countsAsHint,
      reason: `Ya usaste las ${limit} ayudas con codigo que tu docente permite para este archivo. Intenta el siguiente paso por tu cuenta.`,
      reasonCode: "code_application_limit_reached",
    };
  }
  return {
    allowed: true,
    maxLines: settings.maxLines,
    remaining,
    requireConfirmation: settings.requireConfirmation,
    countsAsHint: settings.countsAsHint,
    reason: "",
    reasonCode: "ok",
  };
}

/** Decision final de apply-check con el tamano real del cambio. */
export function checkCodeApplication(
  policy: Pick<TeacherPolicy, "codeApplication" | "maxHintsPerExercise">,
  change: { linesChanged: number },
  applicationsUsed: number,
  pilotCondition: PilotCondition | "" = "",
): CodeApplicationDecision {
  const base = describeCodeApplication(policy, applicationsUsed);
  if (pilotCondition === "sin_tutor") {
    // A13.1: en el bloque sin tutor no hay cambios del tutor que aplicar.
    return { ...base, allowed: false, reason: PILOT_NO_TUTOR_REASON, reasonCode: "pilot_no_tutor" };
  }
  if (!base.allowed) return base;
  const lines = Math.max(0, Math.floor(Number(change.linesChanged) || 0));
  if (lines > base.maxLines) {
    return {
      ...base,
      allowed: false,
      reason: `El cambio tiene ${lines} lineas y tu docente permite aplicar como maximo ${base.maxLines}. Aplica una parte y escribe el resto tu.`,
      reasonCode: "code_application_too_large",
    };
  }
  return base;
}

export type SuggestionPolicyDecision = {
  eventType: PolicyEventType;
  rule: PolicyRule | null;
  blocked: boolean;
  reason: string;
  reasonCode: DecisionReasonCode;
  helpStage: HelpStage;
  codeApplication: CodeApplicationDecision;
};

export function evaluateSuggestionPolicy(input: {
  policy: TeacherPolicy;
  signals: SuggestionSignals;
  applicationsUsed: number;
  /** Condicion del estudiante en el piloto AB/BA (A13.1). */
  pilotCondition?: PilotCondition | "";
}): SuggestionPolicyDecision {
  const eventType = classifySuggestionEvent(input.signals);
  const rule = input.policy.eventRules[eventType] || null;
  const codeApplication = describeCodeApplication(input.policy, input.applicationsUsed);
  const blockedDecision = (reason: string, reasonCode: DecisionReasonCode): SuggestionPolicyDecision => ({
    eventType,
    rule,
    blocked: true,
    reason,
    reasonCode,
    helpStage: "controlled",
    codeApplication: { ...codeApplication, allowed: false, reason, reasonCode },
  });

  if (input.pilotCondition === "sin_tutor") {
    return blockedDecision(PILOT_NO_TUTOR_REASON, "pilot_no_tutor");
  }

  if (!rule || !rule.enabled) {
    return blockedDecision("La politica docente desactivo este tipo de ayuda.", "rule_disabled");
  }
  if (countSuggestionSignals(input.signals) < rule.activationThreshold) {
    return blockedDecision("Falta contexto suficiente para ayudar sin inventar.", "insufficient_context");
  }
  if (rule.interventionType === "controlled_message") {
    return eventType === "out_of_domain"
      ? blockedDecision("La consulta esta fuera de lo que cubre el tutor del curso.", "out_of_domain")
      : blockedDecision("Falta contexto suficiente para ayudar sin inventar.", "insufficient_context");
  }

  // A2.2 en el editor: la etapa avanza con los cambios ya aplicados en el
  // archivo y fija cuantas lineas puede traer esta sugerencia (5, 10 o el
  // maximo del docente). apply-check sigue validando contra el maximo.
  const helpStage = resolveHelpStage({ policy: input.policy, rule, hintsUsed: input.applicationsUsed });
  if (helpStage === "controlled") {
    // Ninguna intervencion habilitada por el docente (allowedInterventions) sirve para este evento.
    return blockedDecision("La politica docente desactivo este tipo de ayuda.", "rule_disabled");
  }
  return {
    eventType,
    rule,
    blocked: false,
    reason: "",
    reasonCode: "ok",
    helpStage,
    codeApplication: { ...codeApplication, maxLines: editorCodeLineLimit(helpStage, codeApplication.maxLines) },
  };
}

/** Linea de politica que se agrega al prompt del modelo. */
export function buildSuggestionPolicyInstruction(policy: TeacherPolicy, decision: SuggestionPolicyDecision) {
  const parts = [
    `Politica del docente "${policy.policyName}": evento ${decision.eventType}, tono ${policy.tone}.`,
    policy.outcome ? `Resultado de aprendizaje: ${policy.outcome}.` : "",
    editorStageInstruction(decision.helpStage, decision.codeApplication.maxLines),
    policy.strictNoSolution
      ? `No entregues la solucion completa. Si propones codigo, maximo ${decision.codeApplication.maxLines} lineas.`
      : `Si propones codigo, maximo ${decision.codeApplication.maxLines} lineas.`,
    decision.codeApplication.allowed ? "" : "No incluyas la linea `Aplicar:`; el estudiante no podra aplicar codigo.",
    policy.customInstruction ? `Nota docente: ${policy.customInstruction}` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

const APPLY_LINE_SOURCE = "^[ \\t>*-]*(?:\\d+\\)\\s*)?(?:acci[o\u00f3]n\\s*:?\\s*)?`?aplicar\\s*:\\s*`?(insert|replace|delete)`?[ \\t]*$";
const APPLY_LINE_ALL = new RegExp(APPLY_LINE_SOURCE, "gim");
const APPLY_LINE_ANY = new RegExp(APPLY_LINE_SOURCE, "im");

/**
 * Salida de /suggest-tab ya revisada por la politica (A10.2): recorta el
 * codigo al limite y, si hubo recorte o no se permite aplicar, quita la
 * linea "Aplicar:" para que VS Code no ofrezca aplicar un cambio incompleto.
 */
export function applySuggestionGuardrail(markdown: string, decision: SuggestionPolicyDecision) {
  const limited = limitCodeBlocks(markdown, decision.codeApplication.maxLines);
  const removeApply = limited.truncated || !decision.codeApplication.allowed;
  const hadApplyLine = APPLY_LINE_ANY.test(limited.text);
  const text = removeApply ? limited.text.replace(APPLY_LINE_ALL, "").replace(/\n{3,}/g, "\n\n").trim() : limited.text;
  return {
    text,
    truncated: limited.truncated,
    applyRemoved: removeApply && hadApplyLine,
  };
}

/** Respuesta en el formato Markdown que entiende VS Code, sin linea "Aplicar:". */
export function buildControlledSuggestionMarkdown(policy: Pick<TeacherPolicy, "fallbackMessage">, decision: SuggestionPolicyDecision) {
  if (decision.reasonCode === "pilot_no_tutor") {
    return [
      "1) Resumen:",
      `- ${PILOT_NO_TUTOR_MESSAGE}`,
      "",
      "5) Riesgos:",
      `- Motivo de control: ${decision.reason}`,
    ].join("\n");
  }
  return [
    "1) Resumen:",
    `- ${policy.fallbackMessage}`,
    "",
    "2) Sugerencias del codigo:",
    "- Comparte el enunciado, el error que ves o selecciona el fragmento donde estas bloqueado.",
    "- Si la duda es de otro tema, preguntale a tu docente.",
    "",
    "5) Riesgos:",
    `- Motivo de control: ${decision.reason}`,
  ].join("\n");
}

/**
 * A12.10: respuesta de /suggest-tab cuando el modelo no responde. No inventa
 * una sugerencia ni trae codigo para aplicar; orienta a lo que el estudiante
 * puede revisar solo mientras vuelve el servicio.
 */
export function buildUnavailableSuggestionMarkdown() {
  return [
    "1) Resumen:",
    "- El tutor no esta disponible en este momento: el servidor del modelo no respondio.",
    "",
    "2) Sugerencias del codigo:",
    "- Revisa el primer error que muestra el compilador o la prueba y la linea que indica.",
    "- Vuelve a pedir la sugerencia en unos minutos o consulta el material del curso.",
    "",
    "5) Riesgos:",
    "- Motivo de control: sin respuesta del modelo; no se inventa una sugerencia.",
  ].join("\n");
}
