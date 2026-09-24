import { randomUUID } from "node:crypto";
import { AppDatabase } from "../db/database.js";
import type {
  AppSession,
  DecisionReasonCode,
  GithubMentorContext,
  GithubMentorResult,
  HelpStage,
  PolicyDetailLevel,
  PolicyEventType,
  PolicyRule,
  TeacherPolicy,
} from "../types/app.js";
import { runTextByMode } from "./agent-mode.js";
import {
  buildHeuristicMentorResult,
  buildMentorPrompt,
  parseMentorResultFromText,
} from "./mentor-core.js";
import {
  buildRagPromptBlock,
  buildRagSearchQuery,
  enrichMentorResultWithRag,
  ensureMentorResultRagCitations,
  rankRagChunks,
  rankRagSources,
} from "./rag-sources.js";
import {
  DEFAULT_RAG_COURSE_CODE,
  getRagCourse,
  inferRagCourseCodeFromText,
  normalizeRagCourseCode,
  normalizeRagCourseCodes,
} from "./rag-courses.js";
import {
  normalizeLearningGoal,
  resolvePageContext,
  trimText,
} from "./text-utils.js";
import { applyTemplateLimits, resolveHelpStage, templateInstruction } from "./intervention-templates.js";
import { prioritizeRagSourcesForScenario } from "./scenario-resources.js";
import { fileExtension, hashErrorText, type TelemetryActor } from "./telemetry.js";

type MentorEvaluationInput = {
  question: string;
  context: GithubMentorContext;
  maxItems: number;
  session: AppSession | null;
  database: AppDatabase;
  /** Actor para la telemetria v1.1 (sesion o cliente anonimo). */
  actor?: TelemetryActor | null;
};

type MentorEvaluationOutput = {
  source: "ai" | "heuristic" | "policy";
  result: GithubMentorResult;
  telemetryId: string | null;
  /** Id de la decision para enlazar los eventos del cliente (igual a telemetryId si hay sesion). */
  decisionId: string | null;
  blocked: boolean;
  helpStage: HelpStage;
  latencyMs: number;
  ragSources: ReturnType<typeof rankRagSources>;
  ragCourseCode: string;
  policy: {
    name: string;
    eventType: PolicyEventType;
    detailLevel: PolicyDetailLevel;
    interventionType: string;
    blocked: boolean;
    helpStage: HelpStage;
    reasonCode: DecisionReasonCode;
  } | null;
};

function buildExerciseKey(context: GithubMentorContext) {
  const activity = trimText(context.activityTitle);
  if (activity) return `activity:${activity.toLowerCase()}`;

  const filePath = trimText(context.filePath);
  if (filePath) return `file:${filePath.toLowerCase()}`;

  const url = trimText(context.url);
  if (url) return `url:${url.toLowerCase()}`;

  return "exercise:general";
}

function countVisibleSignals(context: GithubMentorContext) {
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

function buildControlledResult(message: string, reason: string): GithubMentorResult {
  return {
    ideas: [message],
    searches: [
      "Comparte el enunciado exacto, el error visible o un fragmento corto del codigo.",
      "Limita la pregunta a contenidos de POO, C++, Python, GitHub o Codespaces del curso.",
      "Si necesitas ayuda conceptual, indica el RA o indicador que quieres reforzar.",
    ],
    guide: [
      "Ubica el ejercicio o archivo del curso.",
      "Comparte una senal concreta del bloqueo.",
      "Vuelve a pedir ayuda con ese contexto minimo.",
      `Motivo de control: ${reason}.`,
    ],
    welcome_message: message,
    analysis_summary: reason,
  };
}

function detailLevelToMaxItems(level: PolicyDetailLevel) {
  if (level === "brief") return 3;
  if (level === "guided") return 4;
  return 6;
}

function trimResultByPolicy(
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

function detectEventType(question: string, context: GithubMentorContext, policy: TeacherPolicy): PolicyEventType {
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

function buildPolicyInstruction(
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

function shouldCountTowardsHintLimit(rule: PolicyRule) {
  return rule.interventionType === "hint" || rule.interventionType === "example";
}

function resolveRagCourseCodeForSession(
  session: AppSession | null,
  requestedCourseCode: string,
  inferredCourseCode: string,
) {
  const requested = normalizeRagCourseCode(requestedCourseCode);
  const inferred = normalizeRagCourseCode(inferredCourseCode);
  const candidate = getRagCourse(requested)
    ? requested
    : getRagCourse(inferred)
      ? inferred
      : DEFAULT_RAG_COURSE_CODE;

  if (session?.user.role !== "student") {
    return candidate;
  }

  const assignedCourseCodes = normalizeRagCourseCodes(session.user.assignedCourseCodes, {
    fallbackToDefault: true,
    knownOnly: true,
  });
  if (assignedCourseCodes.includes(candidate)) {
    return candidate;
  }
  return assignedCourseCodes[0] || DEFAULT_RAG_COURSE_CODE;
}

export async function resolveMentorRagContext(input: {
  question: string;
  context: GithubMentorContext;
  session: AppSession | null;
  database: AppDatabase;
}) {
  const ragQuery = buildRagSearchQuery(input.question, input.context);
  const inferredRagCourseCode = inferRagCourseCodeFromText([
    input.question,
    input.context.activityTitle,
    input.context.learningGoal,
    input.context.repoFullName,
    input.context.url,
  ].map((item) => trimText(item)).filter(Boolean).join("\n"));
  const ragCourseCode = resolveRagCourseCodeForSession(
    input.session,
    input.context.ragCourseCode || input.context.courseCode || "",
    inferredRagCourseCode,
  );
  const accessibleRagChunks = await input.database
    .listRagChunksForUser(input.session?.user || null, 800, { courseCode: ragCourseCode, includeSupplemental: true })
    .catch(() => []);
  const ragSources = rankRagChunks(
    accessibleRagChunks,
    ragQuery,
  );

  return { ragSources, ragCourseCode };
}

/** Registra la decision en telemetry_events (v1.1); nunca rompe la respuesta. */
async function recordOverlayDecision(input: MentorEvaluationInput, details: {
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
      },
    },
  ], input.actor).catch((error) => {
    console.warn("[telemetria] no se pudo registrar la decision del overlay:", String(error));
  });
}

function reasonCodeFor(reason: string, eventType: PolicyEventType): DecisionReasonCode {
  if (!reason) return "ok";
  if (/desactivo/.test(reason)) return "rule_disabled";
  if (/maximo de pistas/.test(reason)) return "hint_limit_reached";
  if (eventType === "out_of_domain" || /fuera del dominio/.test(reason)) return "out_of_domain";
  if (/contexto/.test(reason)) return "insufficient_context";
  return "controlled_message";
}

export async function evaluateMentorIntervention(
  input: MentorEvaluationInput,
): Promise<MentorEvaluationOutput> {
  const startedAt = Date.now();
  const resolved = await resolveMentorRagContext(input);
  const ragCourseCode = resolved.ragCourseCode;
  let ragSources = resolved.ragSources;
  const scenarioText = [
    input.question,
    input.context.visibleError,
    input.context.selection,
    input.context.activityTitle,
  ].map((item) => trimText(item)).join("\n");

  if (!input.session) {
    const decisionId = randomUUID();
    const ragContext = buildRagPromptBlock(ragSources);
    const heuristic = enrichMentorResultWithRag(
      buildHeuristicMentorResult(input.context, input.question, input.maxItems),
      ragSources,
      input.maxItems,
    );
    let output: MentorEvaluationOutput = {
      source: "heuristic",
      result: heuristic,
      telemetryId: null,
      decisionId: input.actor ? decisionId : null,
      blocked: false,
      helpStage: "hint_1",
      latencyMs: 0,
      ragSources,
      ragCourseCode,
      policy: null,
    };
    try {
      const prompt = buildMentorPrompt({
        context: input.context,
        question: input.question,
        maxItems: input.maxItems,
        heuristic,
        ragContext,
        policyInstruction: templateInstruction("hint_1"),
      });
      const aiRaw = await runTextByMode(prompt);
      const parsed = parseMentorResultFromText(aiRaw, input.maxItems);
      if (parsed) {
        output = {
          ...output,
          source: "ai",
          result: applyTemplateLimits(ensureMentorResultRagCitations(parsed, ragSources), "hint_1"),
        };
      }
    } catch {
      // se queda la heuristica
    }
    output.latencyMs = Date.now() - startedAt;
    await recordOverlayDecision(input, {
      decisionId,
      eventType: "",
      interventionType: "hint",
      helpStage: output.helpStage,
      reasonCode: output.source === "heuristic" ? "model_error_fallback" : "ok",
      blocked: false,
      latencyMs: output.latencyMs,
      source: output.source,
      exerciseKey: buildExerciseKey(input.context),
      ragCourseCode,
      ragSources: ragSources.length,
    });
    return output;
  }

  const policy = await input.database.getTeacherPolicyForUser(input.session.user);
  if (!policy) {
    const heuristic = enrichMentorResultWithRag(
      buildHeuristicMentorResult(input.context, input.question, input.maxItems),
      ragSources,
      input.maxItems,
    );
    return {
      source: "heuristic",
      result: heuristic,
      telemetryId: null,
      decisionId: null,
      blocked: false,
      helpStage: "hint_1",
      latencyMs: Date.now() - startedAt,
      ragSources,
      ragCourseCode,
      policy: null,
    };
  }

  const eventType = detectEventType(input.question, input.context, policy);
  // A8.6: primero el material que la matriz recomienda para este escenario.
  ragSources = prioritizeRagSourcesForScenario(ragSources, eventType, scenarioText).items;
  const ragContext = buildRagPromptBlock(ragSources);
  const heuristic = enrichMentorResultWithRag(
    buildHeuristicMentorResult(input.context, input.question, input.maxItems),
    ragSources,
    input.maxItems,
  );
  const rule = policy.eventRules[eventType];
  const exerciseKey = buildExerciseKey(input.context);
  const currentHintUsage = input.session.user.role === "student"
    ? await input.database.getHintUsage(input.session.user.id, exerciseKey)
    : 0;

  let result: GithubMentorResult = heuristic;
  let blocked = false;
  let source: MentorEvaluationOutput["source"] = "heuristic";
  let reason = "";

  if (!rule || !rule.enabled) {
    blocked = true;
    reason = "La politica docente desactivo este tipo de intervencion.";
    result = buildControlledResult(policy.fallbackMessage, reason);
    source = "policy";
  } else if (countVisibleSignals(input.context) < rule.activationThreshold) {
    blocked = true;
    reason = "Falta contexto suficiente para activar una intervencion segura.";
    result = buildControlledResult(policy.fallbackMessage, reason);
    source = "policy";
  } else if (
    input.session.user.role === "student"
    && shouldCountTowardsHintLimit(rule)
    && policy.maxHintsPerExercise !== null
    && currentHintUsage >= policy.maxHintsPerExercise
  ) {
    blocked = true;
    reason = `Se alcanzo el maximo de pistas por ejercicio (${policy.maxHintsPerExercise}).`;
    result = buildControlledResult(
      `Ya alcanzaste el limite de pistas definido por el docente para este ejercicio (${policy.maxHintsPerExercise}).`,
      reason,
    );
    source = "policy";
  } else if (rule.interventionType === "controlled_message") {
    blocked = true;
    reason = eventType === "out_of_domain"
      ? "Consulta fuera del dominio autorizado del curso."
      : "Contexto insuficiente para responder sin inventar.";
    result = buildControlledResult(policy.fallbackMessage, reason);
    source = "policy";
  }

  // A2.2 / A9.8: etapa de ayuda segun las pistas ya usadas en el ejercicio.
  const helpStage = resolveHelpStage({ policy, rule, hintsUsed: currentHintUsage, blocked });
  if (!blocked && helpStage === "controlled") {
    // Ninguna intervencion habilitada por el docente sirve para este evento.
    blocked = true;
    reason = "La politica docente desactivo este tipo de ayuda.";
    result = buildControlledResult(policy.fallbackMessage, reason);
    source = "policy";
  }
  let modelFailed = false;

  if (!blocked && rule) {
    try {
      const prompt = buildMentorPrompt({
        context: input.context,
        question: input.question,
        maxItems: Math.min(input.maxItems, detailLevelToMaxItems(rule.detailLevel)),
        heuristic,
        policyInstruction: buildPolicyInstruction(policy, eventType, rule, currentHintUsage, helpStage),
        ragContext,
      });
      const aiRaw = await runTextByMode(prompt);
      const parsed = parseMentorResultFromText(aiRaw, input.maxItems);
      if (parsed) {
        result = ensureMentorResultRagCitations(parsed, ragSources);
        source = "ai";
      } else {
        modelFailed = true;
      }
    } catch {
      source = "heuristic";
      modelFailed = true;
    }

    // A10.2: limites de la plantilla (codigo) ademas del recorte por nivel de detalle.
    result = ensureMentorResultRagCitations(
      applyTemplateLimits(trimResultByPolicy(result, policy, rule), helpStage),
      ragSources,
    );

    if (input.session.user.role === "student" && shouldCountTowardsHintLimit(rule)) {
      await input.database.incrementHintUsage(input.session.user.id, exerciseKey);
    }
  }

  const telemetryId = await input.database.recordTelemetry({
    sessionId: input.session.id,
    studentUserId: input.session.user.role === "student" ? input.session.user.id : null,
    teacherUserId: input.session.user.role === "teacher"
      ? input.session.user.id
      : input.session.user.teacherUserId,
    eventType,
    interventionType: blocked ? "controlled_message" : rule?.interventionType || "hint",
    detailLevel: rule?.detailLevel || "brief",
    policyName: policy.policyName,
    exerciseKey,
    blocked,
    reason,
    contextSummary: buildContextSummary(input.context),
    policySnapshot: policy,
  });

  const reasonCode = blocked ? reasonCodeFor(reason, eventType) : modelFailed ? "model_error_fallback" : "ok";
  const latencyMs = Date.now() - startedAt;
  await recordOverlayDecision(input, {
    decisionId: telemetryId,
    eventType,
    interventionType: blocked ? "controlled_message" : rule?.interventionType || "hint",
    helpStage,
    reasonCode,
    blocked,
    latencyMs,
    source,
    exerciseKey,
    ragCourseCode,
    ragSources: ragSources.length,
  });

  return {
    source,
    result,
    telemetryId,
    decisionId: telemetryId,
    blocked,
    helpStage,
    latencyMs,
    ragSources,
    ragCourseCode,
    policy: {
      name: policy.policyName,
      eventType,
      detailLevel: rule?.detailLevel || "brief",
      interventionType: blocked ? "controlled_message" : rule?.interventionType || "hint",
      blocked,
      helpStage,
      reasonCode,
    },
  };
}
