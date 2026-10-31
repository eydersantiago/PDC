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
import { editorBlockCause, explainBlock } from "./block-messages.js";
import {
  buildPartialReplacement,
  codeFamily,
  countChangedLines,
  cutCodePrefix,
  isSignificantCodeLine,
  partialReplacementNote,
  prefixCutNote,
  renderCutFence,
  summarizePartialReplacement,
  summarizePrefixCut,
  type CutSummary,
} from "./code-cut.js";

// Antes vivia aqui; se mantiene la importacion de siempre (pruebas y rutas).
export { countChangedLines } from "./code-cut.js";

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

/**
 * Pedidos explicitos de ayuda del estudiante en VS Code (30-10-2026): «Otra sugerencia»
 * (trigger manual) o un pedido de codigo («Proponer una mejora», «Proponer codigo para
 * continuar»: requestedAction). Los automaticos (cursor quieto, seleccion, archivo abierto,
 * bloqueo, panel) no suben la etapa.
 */
export function isExplicitSuggestionRequest(input: { trigger?: string; requestedAction?: string }) {
  return input.trigger === "manual" || input.requestedAction === "insert" || input.requestedAction === "replace";
}

/** Ventana de los pedidos explicitos anteriores que suben la etapa del editor. */
export const EXPLICIT_REQUEST_WINDOW_MS = 30 * 60 * 1000;

/**
 * Cuanta ayuda ya recibio el estudiante en este archivo, para la etapa (A2.2 en el editor): los
 * cambios que aplico y, si este pedido es explicito, los pedidos explicitos anteriores de la
 * ventana. Antes solo contaban las aplicaciones: un codigo recortado ya no se podia aplicar y la
 * etapa no pasaba nunca de la pista 1 (5 lineas).
 */
export function editorHelpProgress(input: { applicationsUsed: number; explicitRequest: boolean; explicitRequestsBefore: number }) {
  const applications = Math.max(0, Math.floor(Number(input.applicationsUsed) || 0));
  const requests = input.explicitRequest ? Math.max(0, Math.floor(Number(input.explicitRequestsBefore) || 0)) : 0;
  return applications + requests;
}

export function evaluateSuggestionPolicy(input: {
  policy: TeacherPolicy;
  signals: SuggestionSignals;
  /** Cambios del tutor ya aplicados en este archivo: el cupo de aplicaciones (remaining). */
  applicationsUsed: number;
  /** Este pedido es explicito (isExplicitSuggestionRequest): solo asi cuentan los anteriores. */
  explicitRequest?: boolean;
  /** Pedidos explicitos anteriores en este archivo dentro de EXPLICIT_REQUEST_WINDOW_MS. */
  explicitRequestsBefore?: number;
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

  // A2.2 en el editor: la etapa avanza con los cambios ya aplicados en el archivo y con los
  // pedidos explicitos (editorHelpProgress), y fija cuantas lineas puede traer esta sugerencia
  // (5, 10 o el maximo del docente). apply-check sigue validando contra el maximo; el cupo de
  // aplicaciones (remaining) sigue contando solo las aplicaciones.
  const hintsUsed = editorHelpProgress({
    applicationsUsed: input.applicationsUsed,
    explicitRequest: Boolean(input.explicitRequest),
    explicitRequestsBefore: input.explicitRequestsBefore || 0,
  });
  const helpStage = resolveHelpStage({ policy: input.policy, rule, hintsUsed });
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

/** Opciones de la peticion que cambian la instruccion y el guardarrail (VS Code 0.0.34). */
export type SuggestionRequestOptions = {
  /** El estudiante pidio mejorar su seleccion (replace) o codigo nuevo debajo (insert). */
  requestedAction?: "insert" | "replace" | "";
  /** Texto seleccionado: con replace, el guardarrail cuenta solo las lineas que cambian. */
  selection?: string;
  /** Lenguaje del archivo: decide como se cuentan llaves y sangria al recortar (code-cut.ts). */
  languageHint?: string;
};

/** Linea de politica que se agrega al prompt del modelo. */
export function buildSuggestionPolicyInstruction(
  policy: TeacherPolicy,
  decision: SuggestionPolicyDecision,
  options: SuggestionRequestOptions = {},
) {
  const maxLines = decision.codeApplication.maxLines;
  const codeLimit = options.requestedAction === "replace"
    ? `Si propones codigo, cambia como maximo ${maxLines} lineas.`
    : options.requestedAction === "insert"
      ? `Si propones codigo, maximo ${maxLines} lineas.`
      : `Si propones codigo, maximo ${maxLines} lineas nuevas o cambiadas.`;
  const parts = [
    `Politica del docente "${policy.policyName}": evento ${decision.eventType}, tono ${policy.tone}.`,
    policy.outcome ? `Resultado de aprendizaje: ${policy.outcome}.` : "",
    editorStageInstruction(decision.helpStage, maxLines, options.requestedAction || ""),
    policy.strictNoSolution ? `No entregues la solucion completa. ${codeLimit}` : codeLimit,
    decision.codeApplication.allowed ? "" : "No incluyas la linea `Aplicar:`; el estudiante no podra aplicar codigo.",
    policy.customInstruction ? `Nota docente: ${policy.customInstruction}` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

const APPLY_LINE_SOURCE = "^[ \\t>*-]*(?:\\d+\\)\\s*)?(?:acci[o\u00f3]n\\s*:?\\s*)?`?aplicar\\s*:\\s*`?(insert|replace|delete)`?[ \\t]*$";
const APPLY_LINE_ALL = new RegExp(APPLY_LINE_SOURCE, "gim");
const APPLY_LINE_ANY = new RegExp(APPLY_LINE_SOURCE, "im");

const APPLY_LINE_ONE = new RegExp(APPLY_LINE_SOURCE, "i");
const CODE_FENCE_PARTS = /```([^\n]*)\n([\s\S]*?)```/g;

/**
 * El modelo a veces escribe la linea "Aplicar: ..." DENTRO del bloque de codigo (examen 28-10:
 * VS Code propuso reemplazar el codigo del estudiante por el texto «Aplicar: replace»). Se saca
 * del bloque y, si la respuesta no la trae afuera, queda justo antes de ese bloque. Un bloque que
 * solo traia esa linea queda vacio: editorCodeProblem lo ve sin codigo (reintento) y no se cachea.
 */
export function moveApplyLinesOutOfCodeFences(markdown: string) {
  const text = String(markdown || "");
  if (!APPLY_LINE_ANY.test(text)) return text;
  let hasOutside = APPLY_LINE_ANY.test(text.replace(CODE_FENCE_PARTS, ""));
  return text.replace(CODE_FENCE_PARTS, (whole, info: string, body: string) => {
    let action = "";
    const kept = body.split("\n").filter((line) => {
      const match = line.replace(/\r$/, "").match(APPLY_LINE_ONE);
      if (!match) return true;
      action = action || match[1].toLowerCase();
      return false;
    });
    if (!action) return whole;
    const fence = `\`\`\`${info}\n${kept.join("\n")}\`\`\``;
    if (hasOutside) return fence;
    hasOutside = true;
    return `Aplicar: ${action}\n\n${fence}`;
  });
}

/** Accion de la linea "Aplicar:" de una respuesta (vacio si no trae). */
export function parseApplyAction(markdown: string): "insert" | "replace" | "delete" | "" {
  const match = String(markdown || "").match(APPLY_LINE_ANY);
  const action = (match?.[1] || "").toLowerCase();
  return action === "insert" || action === "replace" || action === "delete" ? action : "";
}

function nonBlankTrimmedLines(text: string) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Parte de las lineas de la seleccion (sin sangria ni lineas en blanco) que
 * aparece en el codigo: una version del bloque copia las que no cambian; un
 * fragmento para insertar casi no repite ninguna. Igual que
 * retainedSelectionFraction de VS Code (suggestion-code.ts). Las lineas que son
 * solo una llave o una palabra suelta no cuentan (isSignificantCodeLine).
 */
function keptSelectionLines(selection: string, code: string) {
  const original = nonBlankTrimmedLines(selection).filter(isSignificantCodeLine);
  const pool = new Map<string, number>();
  for (const line of nonBlankTrimmedLines(code)) {
    pool.set(line, (pool.get(line) || 0) + 1);
  }
  let kept = 0;
  for (const line of original) {
    const available = pool.get(line) || 0;
    if (available > 0) {
      pool.set(line, available - 1);
      kept += 1;
    }
  }
  return { kept, total: original.length };
}

export function retainedSelectionFraction(selection: string, code: string) {
  const { kept, total } = keptSelectionLines(selection, code);
  return total ? kept / total : 0;
}

/**
 * Accion que va a usar VS Code 0.0.34 para el codigo de la respuesta: la linea
 * "Aplicar:", el pedido del estudiante o, si se contradicen (tambien un
 * "delete" con codigo cuando se pidio algo), el contenido: la mitad o mas de las
 * lineas significativas del bloque, replace; si no, insert. Un "insert" que ya
 * trae 2 o mas de esas lineas tambien es replace: insertarlo lo duplicaria.
 */
export function effectiveApplyAction(markdown: string, code: string, options: SuggestionRequestOptions = {}) {
  const explicit = parseApplyAction(markdown);
  const requested = options.requestedAction || "";
  const action = explicit || requested;
  if (!code.trim() || action === "") return action;
  const { kept, total } = keptSelectionLines(String(options.selection || ""), code);
  const keepsBlock = total > 0 && kept / total >= 0.5;
  if (explicit && requested && explicit !== requested) return keepsBlock ? "replace" : "insert";
  if (action === "insert" && keepsBlock && kept >= 2) return "replace";
  return action;
}

/**
 * Como queda el codigo de la respuesta despues del guardarrail (30-10-2026):
 *   - none: no hizo falta recortar;
 *   - applicable: se recorto y todavia se puede aplicar (un trozo cerrado para insertar o un
 *     reemplazo parcial que no le quita lineas al estudiante);
 *   - guide: se recorto y solo sirve de guia (no se ofrece aplicar).
 */
export type GuardrailCut = "none" | "applicable" | "guide";

/** El recorte como lo cuentan la respuesta (code_application.truncation) y la telemetria: "" sin recorte. */
export type GuardrailTruncation = Exclude<GuardrailCut, "none"> | "";

/** Valor de metadata.reason en tutor_decision cuando el guardarrail recorto codigo. */
export const GUARDRAIL_TRUNCATION_REASON = {
  applicable: "codigo_parcial_aplicable",
  guide: "codigo_recortado_guia",
} as const;

/** El de antes del 30-10-2026 (siempre guia): sigue en la telemetria historica. */
export const LEGACY_TRUNCATION_REASON = "codigo_recortado";

/** Pone (o cambia) la linea «Aplicar:» de la respuesta: justo antes del bloque si no la traia. */
function withApplyAction(markdown: string, action: "insert" | "replace") {
  if (APPLY_LINE_ANY.test(markdown)) return markdown.replace(APPLY_LINE_ALL, `Aplicar: ${action}`);
  return markdown.replace(/```/, `Aplicar: ${action}\n\n\`\`\``);
}

/**
 * Recorte de una respuesta con un solo bloque de codigo (el que VS Code aplica), segun la accion:
 *   - replace sobre la seleccion: si cambia hasta maxLines lineas, entero (el bloque mejorado
 *     repite las que no cambian); si cambia mas, un reemplazo parcial que se puede aplicar o,
 *     si no se puede armar, null (queda como guia);
 *   - insert: las primeras lineas hasta un punto donde todo queda cerrado; se puede insertar;
 *   - cualquier otra (sin accion o replace sin seleccion): las primeras lineas, como guia.
 */
type EditorCodeLimit = { text: string; cut: GuardrailCut; summary: CutSummary | null };

function limitSingleEditorBlock(
  markdown: string,
  block: { whole: string; info: string; code: string },
  maxLines: number,
  options: SuggestionRequestOptions,
): EditorCodeLimit | null {
  const action = effectiveApplyAction(markdown, block.code, options);
  const selection = String(options.selection || "");
  const family = codeFamily(block.info, options.languageHint || "", block.code);
  const swap = (replacement: string) => markdown.replace(block.whole, () => replacement);
  if (action === "replace" && selection.trim()) {
    if (countChangedLines(selection, block.code) <= maxLines) return { text: markdown, cut: "none", summary: null };
    const partial = buildPartialReplacement(selection, block.code, maxLines, family);
    if (!partial) return null;
    const fence = renderCutFence(block.info, partial.code, partialReplacementNote(partial.changed, partial.total));
    return { text: withApplyAction(swap(fence), "replace"), cut: "applicable", summary: summarizePartialReplacement(partial) };
  }
  if (block.code.split("\n").length <= maxLines) return { text: markdown, cut: "none", summary: null };
  const prefix = cutCodePrefix(block.code, maxLines, family);
  const fence = renderCutFence(block.info, prefix.code, prefixCutNote(prefix.shown, prefix.total));
  return {
    text: swap(fence),
    cut: action === "insert" && prefix.clean ? "applicable" : "guide",
    summary: summarizePrefixCut(prefix),
  };
}

/**
 * Recorta el codigo de la respuesta al tope de la etapa. Con varios bloques (VS Code solo aplica
 * el primero) o sin tope (0) cada bloque se recorta como guia.
 */
function limitEditorCode(markdown: string, maxLines: number, options: SuggestionRequestOptions): EditorCodeLimit {
  const blocks = [...markdown.matchAll(CODE_FENCE_PARTS)];
  if (!blocks.length) return { text: markdown, cut: "none", summary: null };
  if (maxLines > 0 && blocks.length === 1) {
    const [whole, info, body] = blocks[0];
    const single = limitSingleEditorBlock(markdown, { whole, info, code: body.replace(/\n$/, "") }, maxLines, options);
    if (single) return single;
  }
  const limited = limitCodeBlocks(markdown, maxLines, options.languageHint || "");
  return { text: limited.text, cut: limited.truncated ? "guide" : "none", summary: limited.firstCut };
}

/**
 * Salida de /suggest-tab ya revisada por la politica (A10.2): recorta el codigo al tope de la
 * etapa sin dejar lineas «...» dentro del bloque (la nota va fuera) y quita la linea «Aplicar:»
 * cuando lo que queda no se puede aplicar (un recorte de guia) o la politica no deja aplicar.
 * Un recorte que se puede aplicar (applicable) conserva la linea: el estudiante puede seguir
 * aplicando y la etapa avanza (30-10-2026).
 */
export function applySuggestionGuardrail(
  markdown: string,
  decision: SuggestionPolicyDecision,
  options: SuggestionRequestOptions = {},
) {
  const limited = limitEditorCode(String(markdown || ""), decision.codeApplication.maxLines, options);
  const truncated = limited.cut !== "none";
  const applicable = limited.cut === "applicable" && decision.codeApplication.allowed;
  const removeApply = !decision.codeApplication.allowed || (truncated && !applicable);
  const hadApplyLine = APPLY_LINE_ANY.test(limited.text);
  const text = removeApply ? limited.text.replace(APPLY_LINE_ALL, "").replace(/\n{3,}/g, "\n\n").trim() : limited.text;
  return {
    text,
    truncated,
    /** El codigo recortado se puede aplicar todavia (solo con truncated). */
    applicable: truncated && applicable,
    /** Cuanto se mostro del bloque recortado (code_application.cut); null sin recorte o sin codigo. */
    cutSummary: truncated ? limited.summary : null,
    applyRemoved: removeApply && hadApplyLine,
  };
}

/**
 * Respuesta en el formato Markdown que entiende VS Code, sin linea "Aplicar:". Dice la causa del
 * bloqueo y que hacer (block-messages.ts, 28-10-2026), no solo el mensaje generico del docente.
 */
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
  const explanation = explainBlock(editorBlockCause(decision.reasonCode), { fallbackMessage: policy.fallbackMessage, channel: "vscode" });
  return [
    "1) Resumen:",
    `- ${explanation.message}`,
    "",
    "2) Sugerencias del codigo:",
    ...explanation.steps.map((step) => `- ${step}`),
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
/**
 * Sin servidor vivo, con la GPU encendiendose (GPU_AUTOSTART, 28-10-2026): que vuelva en 2 o 3
 * minutos. Sin codigo ni «Aplicar:», como el de abajo.
 */
export function buildStartingSuggestionMarkdown(message: string) {
  return [
    "1) Resumen:",
    `- ${message}`,
    "",
    "2) Sugerencias del codigo:",
    "- Mientras tanto, revisa el primer error que muestra el compilador o la prueba y la linea que indica.",
    "",
    "5) Riesgos:",
    "- Motivo de control: el servidor del modelo se esta encendiendo; no se inventa una sugerencia.",
  ].join("\n");
}

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
