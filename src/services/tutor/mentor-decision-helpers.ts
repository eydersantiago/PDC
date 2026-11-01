// Decision del tutor (overlay): senales visibles, evento de la politica, instruccion, recorte del resultado y registro de la decision.
import { PILOT_NO_TUTOR_REASON } from "../pilot/pilot.js";
import { AppDatabase } from "../../db/database.js";
import type { AppSession, DecisionReasonCode, GithubMentorContext, GithubMentorResult, HelpStage, PolicyDetailLevel, PolicyEventType, PolicyRule, TeacherPolicy } from "../../types/app.js";
import { normalizeLearningGoal, resolvePageContext, trimText } from "../shared/text-utils.js";
import { templateInstruction } from "./intervention-templates.js";
import { type BlockCause } from "./block-messages.js";
import { editorExerciseKey, type TelemetryActor } from "../telemetry/telemetry-actors.js";
import { fileExtension, hashErrorText } from "../telemetry/telemetry-hash.js";

export type MentorEvaluationInput = {
  question: string;
  context: GithubMentorContext;
  maxItems: number;
  session: AppSession | null;
  database: AppDatabase;
  /** Actor para la telemetria v1.1 (sesion o cliente anonimo). */
  actor?: TelemetryActor | null;
};

export function buildExerciseKey(context: GithubMentorContext) {
  const activity = trimText(context.activityTitle);
  if (activity) return `activity:${activity.toLowerCase()}`;

  const filePath = trimText(context.filePath);
  if (filePath) return editorExerciseKey(filePath);

  const url = trimText(context.url);
  if (url) return `url:${url.toLowerCase()}`;

  return "exercise:general";
}

export function countVisibleSignals(context: GithubMentorContext) {
  const signals = [
    trimText(context.activityTitle),
    trimText(context.activityDeadline),
    trimText(context.filePath),
    trimText(context.visibleError),
    trimText(context.selection),
    trimText(context.codeSnippet),
  ].filter(Boolean);

  return signals.length;
}

/**
 * Resumen de contexto para intervention_telemetry (A5.5): sirve para leer la
 * traza sin guardar datos sensibles. Nada de ruta completa, titulo de la
 * pagina (en GitHub incluye usuario y repositorio) ni texto del error: solo
 * la actividad, la extension del archivo y la clase del error con su hash.
 */
export function buildContextSummary(context: GithubMentorContext) {
  const error = trimText(context.visibleError);
  const errorClass = error.match(/\b([A-Z][A-Za-z]*(?:Error|Exception))\b/)?.[1]
    || (/\berror\b/i.test(error) ? "error" : "");
  return [
    trimText(context.activityTitle).slice(0, 120),
    trimText(context.activityDeadline),
    fileExtension(context.filePath) ? `archivo ${fileExtension(context.filePath)}` : "",
    errorClass ? `${errorClass} #${hashErrorText(error)}` : "",
  ]
    .filter(Boolean)
    .join(" | ")
    .slice(0, 260);
}

export function detailLevelToMaxItems(level: PolicyDetailLevel) {
  if (level === "brief") return 3;
  if (level === "guided") return 4;
  return 6;
}

export function trimResultByPolicy(
  result: GithubMentorResult,
  policy: TeacherPolicy,
  rule: PolicyRule,
): GithubMentorResult {
  const maxItems = detailLevelToMaxItems(rule.detailLevel);
  const shouldKeepMiniQuiz = policy.allowMiniQuiz;

  const filteredIdeas = shouldKeepMiniQuiz
    ? result.ideas
    : result.ideas.filter((item) => !/quiz/i.test(item));
  const filteredSearches = shouldKeepMiniQuiz
    ? result.searches
    : result.searches.filter((item) => !/quiz/i.test(item));
  const filteredGuide = shouldKeepMiniQuiz
    ? result.guide
    : result.guide.filter((item) => !/quiz/i.test(item));

  return {
    ...result,
    ideas: filteredIdeas.slice(0, maxItems),
    searches: filteredSearches.slice(0, maxItems),
    guide: filteredGuide.slice(0, Math.max(4, maxItems)),
    analysis_summary: `${result.analysis_summary} Politica: ${rule.interventionType} con detalle ${rule.detailLevel}.`,
  };
}

function isCourseDomain(question: string, context: GithubMentorContext, policy: TeacherPolicy) {
  // Un error visible en pantalla ya es evidencia de que la consulta es del
  // curso (A9.5, escenarios S1/S2): se revisa junto con la pregunta.
  const normalizedQuestion = `${question} ${trimText(context.activityTitle)} ${trimText(context.filePath)} ${trimText(context.visibleError)}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const goal = normalizeLearningGoal(context.learningGoal);
  const domainKeywords = [
    "poo",
    "clase",
    "objeto",
    "encapsul",
    "herenc",
    "polimorf",
    "g++",
    "python",
    "github",
    "codespace",
    "taller",
    "quiz",
    "caso",
    "c++",
    "error",
    "compil",
    "ejercicio",
    "ra1",
    "ra2",
    "ra3",
    goal.replace("_", " "),
  ];

  if (policy.allowedTopics.some((topic) => normalizedQuestion.includes(String(topic).toLowerCase()))) {
    return true;
  }

  return domainKeywords.some((keyword) => normalizedQuestion.includes(keyword));
}

export function detectEventType(question: string, context: GithubMentorContext, policy: TeacherPolicy): PolicyEventType {
  const pageContext = resolvePageContext(context.pageContext, context.pageType);
  const signalCount = countVisibleSignals(context);
  const visibleError = trimText(context.visibleError).toLowerCase();
  const normalizedQuestion = question
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (signalCount === 0 || (pageContext === "unknown" && !trimText(context.codeSnippet))) {
    return "insufficient_context";
  }

  if (!isCourseDomain(question, context, policy)) {
    return "out_of_domain";
  }

  if (/syntaxerror|undefined reference|compil|compilation failed|no such file|cannot find|was not declared|expected [^\n]{1,40} before|no matching function|has no member|invalid conversion|is private within/i.test(visibleError)) {
    return "compile_error";
  }

  if (/traceback|exception|segmentation fault|nullpointer|typeerror|nameerror|runtime/i.test(visibleError)) {
    return "runtime_error";
  }

  // Con limites de palabra: "diagrama" contiene "rama" y no es una duda de flujo de trabajo.
  if (/github|codespace|\bramas?\b|\bcommits?\b|pull request|\bdiff\b/.test(normalizedQuestion)) {
    return "workflow_guidance";
  }

  if (/encapsul|herenc|polimorf|clase|objeto|abstrac|poo/.test(normalizedQuestion)) {
    return "concept_question";
  }

  if (/diseno|diseño|model|enunciado|traducir|diagrama|responsabilidad/.test(normalizedQuestion)) {
    return "design_block";
  }

  if (trimText(context.visibleError)) {
    return "compile_error";
  }

  return pageContext === "github" ? "workflow_guidance" : "concept_question";
}

export function buildPolicyInstruction(
  policy: TeacherPolicy,
  eventType: PolicyEventType,
  rule: PolicyRule,
  currentHintUsage: number,
  stage?: HelpStage,
) {
  return [
    stage ? templateInstruction(stage) : "",
    `politica ${policy.policyName}`,
    policy.outcome ? `resultado de aprendizaje ${policy.outcome}` : "",
    `evento ${eventType}`,
    `tono ${policy.tone}`,
    `frecuencia ${policy.frequency}`,
    `nivel ${policy.helpLevel}`,
    `intervencion ${rule.interventionType}`,
    `detalle ${rule.detailLevel}`,
    `sin solucion completa ${policy.strictNoSolution ? "si" : "no"}`,
    `limite pistas por ejercicio ${policy.maxHintsPerExercise ?? "ilimitado"}`,
    `uso actual ${currentHintUsage}`,
    policy.customInstruction ? `nota docente ${policy.customInstruction}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

export function shouldCountTowardsHintLimit(rule: PolicyRule) {
  return rule.interventionType === "hint" || rule.interventionType === "example";
}

/** Registra la decision en telemetry_events (v1.1); nunca rompe la respuesta. */
export async function recordOverlayDecision(input: MentorEvaluationInput, details: {
  decisionId: string;
  eventType: PolicyEventType | "";
  interventionType: string;
  helpStage: HelpStage;
  reasonCode: DecisionReasonCode | "";
  blocked: boolean;
  latencyMs: number;
  source: string;
  exerciseKey: string;
  ragCourseCode: string;
  ragSources: number;
  /** Servidor de inferencia que respondio (QUEUE_WORKER_ID), si llego al modelo. */
  worker?: string;
  /** Por que se bloqueo (block-messages.ts), si se bloqueo. */
  cause?: BlockCause;
}) {
  if (!input.actor) return;
  await input.database.insertTelemetryEvents([
    {
      source: "backend",
      channel: "overlay",
      category: "tutor",
      eventType: "tutor_decision",
      decisionId: details.decisionId,
      courseCode: details.ragCourseCode,
      exerciseKey: details.exerciseKey,
      language: trimText(input.context.languageHint),
      filePath: trimText(input.context.filePath),
      policyEventType: details.eventType,
      interventionType: details.interventionType,
      helpStage: details.helpStage,
      reasonCode: details.reasonCode,
      blocked: details.blocked,
      latencyMs: details.latencyMs,
      errorText: trimText(input.context.visibleError) || undefined,
      contextText: [input.question, input.context.selection, input.context.codeSnippet].map((item) => trimText(item)).join("\n"),
      metadata: {
        source: details.source,
        pageType: trimText(input.context.pageType),
        ragSources: details.ragSources,
        mode: "overlay",
        ...(details.worker ? { worker: details.worker } : {}),
        ...(details.cause ? { cause: details.cause } : {}),
      },
    },
  ], input.actor).catch((error) => {
    console.warn("[telemetria] no se pudo registrar la decision del overlay:", String(error));
  });
}

export function reasonCodeFor(reason: string, eventType: PolicyEventType): DecisionReasonCode {
  if (!reason) return "ok";
  if (reason === PILOT_NO_TUTOR_REASON) return "pilot_no_tutor";
  if (/desactivo/.test(reason)) return "rule_disabled";
  if (/maximo de pistas/.test(reason)) return "hint_limit_reached";
  if (eventType === "out_of_domain" || /fuera del dominio/.test(reason)) return "out_of_domain";
  if (/contexto/.test(reason)) return "insufficient_context";
  return "controlled_message";
}
