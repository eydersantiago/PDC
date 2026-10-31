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
import type { RequestedEditorAction } from "./editor-request.js";
import {
  buildPartialReplacement,
  countChangedLines,
  cutCodePrefix,
  detectCodeFamily,
  formatPartialReplacementNote,
  formatPrefixCutNote,
  isSignificantCodeLine,
  nonBlankTrimmedLines,
  renderCutFence,
  summarizePartialReplacement,
  summarizePrefixCut,
  type CutSummary,
} from "./code-cut.js";
import {
  mapFences,
  normalizeFenceLines,
  parseFences,
  renderFence,
  replaceFence,
  textOutsideFences,
  type MarkdownFence,
} from "./markdown-fences.js";

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

// Las listas de alcances, disparadores y acciones viven en editor-request.ts; se reexportan
// porque la politica y sus pruebas las usan desde aqui.
export {
  EDITOR_FOCUS_SCOPES,
  EXPLICIT_ACTIONS,
  EXPLICIT_TRIGGERS,
  isEditorFocusScope,
  isExplicitSuggestionRequest,
  type EditorFocusScope,
  type ExplicitAction,
  type ExplicitTrigger,
} from "./editor-request.js";

/** Ventana de los pedidos explicitos anteriores que suben la etapa del editor. */
export const EXPLICIT_REQUEST_WINDOW_MS = 30 * 60 * 1000;

/**
 * Cuanta ayuda ya recibio el estudiante en este archivo, para la etapa (A2.2 en el editor): lo
 * mayor entre los cambios que aplico y los pedidos explicitos anteriores que el tutor respondio
 * (quien llama pasa 0 pedidos si este no es explicito). El maximo y no la suma: pedir una
 * sugerencia y aplicarla es un solo paso, asi la etapa sigue 5 -> 10 -> maximo del docente.
 * Antes solo contaban las aplicaciones: un codigo recortado ya no se podia aplicar y la etapa no
 * pasaba nunca de la pista 1 (5 lineas).
 */
export function countEditorHelpReceived(input: { applicationsUsed: number; explicitRequestsBefore: number }) {
  const whole = (value: number) => Math.max(0, Math.floor(Number(value) || 0));
  return Math.max(whole(input.applicationsUsed), whole(input.explicitRequestsBefore));
}

export function evaluateSuggestionPolicy(input: {
  policy: TeacherPolicy;
  signals: SuggestionSignals;
  /** Cambios del tutor ya aplicados en este archivo: el cupo de aplicaciones (remaining). */
  applicationsUsed: number;
  /**
   * Pedidos explicitos anteriores en este archivo dentro de EXPLICIT_REQUEST_WINDOW_MS, solo si
   * este pedido tambien es explicito (isExplicitSuggestionRequest); 0 en los automaticos.
   */
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

  // A2.2 en el editor: la etapa avanza con la ayuda ya recibida en el archivo (aplicaciones o
  // pedidos explicitos, countEditorHelpReceived) y fija cuantas lineas puede traer esta sugerencia
  // (5, 10 o el maximo del docente). apply-check sigue validando contra el maximo; el cupo de
  // aplicaciones (remaining) sigue contando solo las aplicaciones.
  const hintsUsed = countEditorHelpReceived({
    applicationsUsed: input.applicationsUsed,
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
  requestedAction?: RequestedEditorAction | "";
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

/**
 * El modelo a veces escribe la linea "Aplicar: ..." DENTRO del bloque de codigo (examen 28-10:
 * VS Code propuso reemplazar el codigo del estudiante por el texto «Aplicar: replace»). Se saca
 * del bloque y, si la respuesta no la trae afuera, queda justo antes de ese bloque. Un bloque que
 * solo traia esa linea queda vacio: editorCodeProblem lo ve sin codigo (reintento) y no se cachea.
 * Un bloque sin cerrar sigue sin cerrar: el guardarrail decide despues que hacer con el.
 */
export function moveApplyLinesOutOfCodeFences(markdown: string) {
  const text = String(markdown || "");
  if (!APPLY_LINE_ANY.test(text)) return text;
  let hasOutside = APPLY_LINE_ANY.test(textOutsideFences(text));
  // mapFences llama en el orden del texto: el primer bloque con la linea la recibe afuera.
  return mapFences(text, (fence) => {
    let action = "";
    const kept = fence.code.split("\n").filter((line) => {
      const match = line.match(APPLY_LINE_ONE);
      if (!match) return true;
      action = action || match[1].toLowerCase();
      return false;
    });
    if (!action) return null;
    const rendered = renderFence({ info: fence.info, code: kept.join("\n"), closed: fence.closed });
    if (hasOutside) return rendered;
    hasOutside = true;
    return `Aplicar: ${action}\n\n${rendered}`;
  });
}

/** Accion de la linea "Aplicar:" de una respuesta (vacio si no trae). */
export function parseApplyAction(markdown: string): "insert" | "replace" | "delete" | "" {
  const match = String(markdown || "").match(APPLY_LINE_ANY);
  const action = (match?.[1] || "").toLowerCase();
  return action === "insert" || action === "replace" || action === "delete" ? action : "";
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
 * Como queda el codigo de la respuesta despues del guardarrail (30-10-2026); es tambien
 * code_application.truncation de /suggest-tab:
 *   - none: no hizo falta recortar;
 *   - applicable: se recorto y todavia se puede aplicar (un trozo cerrado para insertar o un
 *     reemplazo parcial que no le quita lineas al estudiante);
 *   - guide: se recorto (o el bloque venia sin cerrar) y solo sirve de guia: no se ofrece aplicar.
 */
export type CodeTruncation = "none" | "applicable" | "guide";

/**
 * Por que un recorte quedo como guia: el tope de la etapa (cap; tambien con varios bloques o sin
 * permiso de aplicar) o un bloque que no termina porque la respuesta del modelo se corto
 * (incomplete_reply), que no es un limite del docente.
 */
export type GuideCause = "cap" | "incomplete_reply";

export type GuardrailResult = {
  text: string;
  outcome: CodeTruncation;
  /** Solo con outcome "guide". */
  guideCause: GuideCause | null;
  /** Cuanto se mostro del bloque recortado (code_application.cut); null si no se recorto un bloque. */
  cutSummary: CutSummary | null;
  /** Se quito una linea «Aplicar:» de la respuesta. */
  applyRemoved: boolean;
};

/** Pone (o cambia) la linea «Aplicar:» de la respuesta: justo antes del bloque si no la traia. */
function withApplyAction(markdown: string, action: "insert" | "replace", fence: MarkdownFence) {
  if (APPLY_LINE_ANY.test(markdown)) return markdown.replace(APPLY_LINE_ALL, `Aplicar: ${action}`);
  return replaceFence(markdown, { start: fence.start, end: fence.start }, `Aplicar: ${action}\n\n`);
}

type EditorCodeLimit = { text: string; outcome: CodeTruncation; incompleteReply: boolean; cutSummary: CutSummary | null };

/**
 * Recorte de una respuesta con un solo bloque de codigo cerrado (el que VS Code aplica), segun
 * la accion:
 *   - replace sobre la seleccion: si cambia hasta maxLines lineas, entero (el bloque mejorado
 *     repite las que no cambian); si cambia mas, un reemplazo parcial que se puede aplicar o,
 *     si no se puede armar, null (queda como guia);
 *   - insert: las primeras lineas hasta un punto donde todo queda cerrado; se puede insertar;
 *   - cualquier otra (sin accion o replace sin seleccion): las primeras lineas, como guia.
 */
function limitSingleEditorBlock(
  markdown: string,
  fence: MarkdownFence,
  maxLines: number,
  options: SuggestionRequestOptions,
): EditorCodeLimit | null {
  const action = effectiveApplyAction(markdown, fence.code, options);
  const selection = String(options.selection || "");
  const family = detectCodeFamily({ fenceInfo: fence.info, languageHint: options.languageHint, code: fence.code });
  const untouched: EditorCodeLimit = { text: markdown, outcome: "none", incompleteReply: false, cutSummary: null };
  if (action === "replace" && selection.trim()) {
    if (countChangedLines(selection, fence.code) <= maxLines) return untouched;
    const partial = buildPartialReplacement({ original: selection, proposed: fence.code, maxChangedLines: maxLines, family });
    if (!partial) return null;
    const rendered = renderCutFence({ info: fence.info, code: partial.code, note: formatPartialReplacementNote(partial) });
    const withFence = replaceFence(markdown, fence, rendered);
    return {
      text: withApplyAction(withFence, "replace", { ...fence, end: fence.start + rendered.length }),
      outcome: "applicable",
      incompleteReply: false,
      cutSummary: summarizePartialReplacement(partial),
    };
  }
  if (fence.code.split("\n").length <= maxLines) return untouched;
  const prefix = cutCodePrefix(fence.code, maxLines, family);
  const rendered = renderCutFence({ info: fence.info, code: prefix.code, note: formatPrefixCutNote(prefix) });
  return {
    text: replaceFence(markdown, fence, rendered),
    outcome: action === "insert" && prefix.endsCleanly ? "applicable" : "guide",
    incompleteReply: false,
    cutSummary: summarizePrefixCut(prefix),
  };
}

/**
 * Recorta el codigo de la respuesta al tope de la etapa. Con varios bloques (VS Code solo aplica
 * el primero), con un bloque sin cerrar (respuesta cortada) o sin tope (0), cada bloque se
 * recorta como guia.
 */
function limitEditorCode(markdown: string, maxLines: number, options: SuggestionRequestOptions): EditorCodeLimit {
  const fences = parseFences(markdown);
  if (!fences.length) return { text: markdown, outcome: "none", incompleteReply: false, cutSummary: null };
  if (maxLines > 0 && fences.length === 1 && fences[0].closed) {
    const single = limitSingleEditorBlock(markdown, fences[0], maxLines, options);
    if (single) return single;
  }
  const limited = limitCodeBlocks(markdown, maxLines, options.languageHint || "");
  return {
    text: limited.text,
    outcome: limited.truncated ? "guide" : "none",
    incompleteReply: limited.incompleteReply,
    cutSummary: limited.firstTruncatedBlock,
  };
}

/**
 * Salida de /suggest-tab ya revisada por la politica (A10.2): recorta el codigo al tope de la
 * etapa sin dejar lineas «...» dentro del bloque (la nota va fuera) y quita la linea «Aplicar:»
 * cuando lo que queda no se puede aplicar (un recorte de guia) o la politica no deja aplicar.
 * Un recorte que se puede aplicar conserva la linea: el estudiante puede seguir aplicando y la
 * etapa avanza (30-10-2026). Si la politica no deja aplicar, un recorte es siempre guia.
 */
export function applySuggestionGuardrail(
  markdown: string,
  decision: SuggestionPolicyDecision,
  options: SuggestionRequestOptions = {},
): GuardrailResult {
  const limited = limitEditorCode(normalizeFenceLines(String(markdown || "")), decision.codeApplication.maxLines, options);
  const outcome: CodeTruncation = limited.outcome === "applicable" && !decision.codeApplication.allowed ? "guide" : limited.outcome;
  const guideCause: GuideCause | null = outcome !== "guide" ? null : limited.incompleteReply ? "incomplete_reply" : "cap";
  const removeApply = !decision.codeApplication.allowed || outcome === "guide";
  const hadApplyLine = APPLY_LINE_ANY.test(limited.text);
  const text = removeApply ? limited.text.replace(APPLY_LINE_ALL, "").replace(/\n{3,}/g, "\n\n").trim() : limited.text;
  return {
    text,
    outcome,
    guideCause,
    cutSummary: outcome === "none" ? null : limited.cutSummary,
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
