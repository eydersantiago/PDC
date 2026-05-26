import { AppDatabase } from "../db/database.js";
import type {
  AppSession,
  GithubMentorContext,
  GithubMentorResult,
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
  normalizeLearningGoal,
  resolvePageContext,
  trimText,
} from "./text-utils.js";

type MentorEvaluationInput = {
  question: string;
  context: GithubMentorContext;
  maxItems: number;
  session: AppSession | null;
  database: AppDatabase;
};

type MentorEvaluationOutput = {
  source: "ai" | "heuristic" | "policy";
  result: GithubMentorResult;
  telemetryId: string | null;
  policy: {
    name: string;
    eventType: PolicyEventType;
    detailLevel: PolicyDetailLevel;
    interventionType: string;
    blocked: boolean;
  } | null;
};

type LogbookUploadPoint = {
  label: string;
  url: string;
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
    trimText(context.filePath),
    trimText(context.visibleError),
    trimText(context.selection),
    trimText(context.codeSnippet),
  ].filter(Boolean);

  return signals.length;
}

function buildContextSummary(context: GithubMentorContext) {
  return [
    trimText(context.activityTitle),
    trimText(context.filePath),
    trimText(context.visibleError),
    trimText(context.title),
  ]
    .filter(Boolean)
    .join(" | ")
    .slice(0, 260);
}

function formatControlReason(reason: string) {
  const clean = trimText(reason);
  if (!clean) return "";
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
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
      `Motivo de control: ${formatControlReason(reason)}`,
    ],
    welcome_message: message,
    analysis_summary: reason,
  };
}

function firstTextFromContext(
  context: GithubMentorContext,
  keys: Array<keyof GithubMentorContext>,
) {
  for (const key of keys) {
    const value = trimText(context[key]);
    if (value) return value;
  }

  return "";
}

function normalizeBooleanLike(value: unknown) {
  if (typeof value === "boolean") return value;

  const normalized = trimText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s-]+/g, "_");

  if (!normalized) return null;

  if (/^(true|yes|si|uploaded|submitted|sent|done|complete|completed|entregada|subida)$/.test(normalized)) {
    return true;
  }

  if (/^(false|no|pending|missing|not_uploaded|not_submitted|none|sin_subir|sin_entregar|pendiente)$/.test(normalized)) {
    return false;
  }

  return null;
}

function resolveTeacherLogbookUploaded(context: GithubMentorContext) {
  const statusKeys: Array<keyof GithubMentorContext> = [
    "teacherLogbookUploaded",
    "bitacoraUploaded",
    "logbookUploaded",
    "journalUploaded",
    "bitacoraStatus",
    "logbookStatus",
  ];

  for (const key of statusKeys) {
    const parsed = normalizeBooleanLike(context[key]);
    if (parsed !== null) return parsed;
  }

  return null;
}

function resolveTeacherLogbookUploadPoint(context: GithubMentorContext): LogbookUploadPoint | null {
  let url = firstTextFromContext(context, [
    "bitacoraUploadUrl",
    "logbookUploadUrl",
    "journalUploadUrl",
  ]);
  let label = firstTextFromContext(context, [
    "bitacoraUploadTitle",
    "logbookUploadTitle",
    "journalUploadTitle",
  ]);

  const currentUrl = trimText(context.url);
  const currentTitle = trimText(context.title);
  const currentPage = `${currentTitle} ${currentUrl}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (!url && currentUrl && /bitacora|logbook|journal/.test(currentPage) && /subida|subir|entrega|upload|submission/.test(currentPage)) {
    url = currentUrl;
  }

  if (!label && currentTitle && /bitacora|logbook|journal/.test(currentPage)) {
    label = currentTitle;
  }

  if (!url && !label) return null;

  return {
    label: label || "Punto de subida de la bitacora",
    url,
  };
}

function shouldShowTeacherLogbookUpload(session: AppSession, context: GithubMentorContext) {
  if (session.user.role !== "teacher") return false;

  const uploaded = resolveTeacherLogbookUploaded(context);
  if (uploaded === true) return false;
  if (uploaded === false) return true;

  return false;
}

function buildTeacherLogbookUploadResult(context: GithubMentorContext, reason: string): GithubMentorResult {
  const uploadPoint = resolveTeacherLogbookUploadPoint(context) || {
    label: "Punto de subida de la bitacora",
    url: "",
  };
  const location = uploadPoint.url
    ? `${uploadPoint.label}: ${uploadPoint.url}`
    : uploadPoint.label;
  const message = "Antes de continuar, falta subir la bitacora del curso.";

  return {
    ideas: [
      message,
      `Punto de subida: ${location}`,
      "Cuando la bitacora quede subida, vuelve a pedir la intervencion con el contexto del curso.",
    ],
    searches: [
      "Abre el punto de subida de la bitacora en Campus Virtual.",
      "Verifica que el archivo o evidencia corresponde a la actividad actual.",
      "Confirma que la plataforma marque la entrega como enviada.",
    ],
    guide: [
      `Punto de subida de la bitacora: ${location}`,
      "Sube la bitacora pendiente.",
      "Confirma que la entrega quede registrada para este profesor.",
      `Motivo de control: ${formatControlReason(reason)}`,
    ],
    welcome_message: message,
    analysis_summary: reason,
  };
}

function buildInsufficientContextResult(
  session: AppSession,
  context: GithubMentorContext,
  message: string,
  reason: string,
) {
  if (shouldShowTeacherLogbookUpload(session, context)) {
    return buildTeacherLogbookUploadResult(context, reason);
  }

  return buildControlledResult(message, reason);
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
  const normalizedQuestion = `${question} ${trimText(context.activityTitle)} ${trimText(context.filePath)}`
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

  if (/syntaxerror|undefined reference|compil|compilation failed|no such file|cannot find/i.test(visibleError)) {
    return "compile_error";
  }

  if (/traceback|exception|segmentation fault|nullpointer|typeerror|nameerror|runtime/i.test(visibleError)) {
    return "runtime_error";
  }

  if (/github|codespace|rama|commit|pull request|diff/.test(normalizedQuestion)) {
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
) {
  return [
    `politica ${policy.policyName}`,
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

export async function evaluateMentorIntervention(
  input: MentorEvaluationInput,
): Promise<MentorEvaluationOutput> {
  const heuristic = buildHeuristicMentorResult(input.context, input.question, input.maxItems);

  if (!input.session) {
    try {
      const prompt = buildMentorPrompt({
        context: input.context,
        question: input.question,
        maxItems: input.maxItems,
        heuristic,
      });
      const aiRaw = await runTextByMode(prompt);
      const parsed = parseMentorResultFromText(aiRaw, input.maxItems);
      if (parsed) {
        return { source: "ai", result: parsed, telemetryId: null, policy: null };
      }
    } catch {
      return { source: "heuristic", result: heuristic, telemetryId: null, policy: null };
    }

    return { source: "heuristic", result: heuristic, telemetryId: null, policy: null };
  }

  const policy = await input.database.getTeacherPolicyForUser(input.session.user);
  if (!policy) {
    return { source: "heuristic", result: heuristic, telemetryId: null, policy: null };
  }

  const eventType = detectEventType(input.question, input.context, policy);
  const rule = policy.eventRules[eventType];
  const exerciseKey = buildExerciseKey(input.context);
  const currentHintUsage = input.session.user.role === "student"
    ? await input.database.getHintUsage(input.session.user.id, exerciseKey)
    : 0;

  let result: GithubMentorResult = heuristic;
  let blocked = false;
  let source: MentorEvaluationOutput["source"] = "heuristic";
  let reason = "";

  if (shouldShowTeacherLogbookUpload(input.session, input.context)) {
    blocked = true;
    reason = "La bitacora del profesor esta pendiente de subida.";
    result = buildTeacherLogbookUploadResult(input.context, reason);
    source = "policy";
  } else if (!rule || !rule.enabled) {
    blocked = true;
    reason = "La politica docente desactivo este tipo de intervencion.";
    result = buildControlledResult(policy.fallbackMessage, reason);
    source = "policy";
  } else if (countVisibleSignals(input.context) < rule.activationThreshold) {
    blocked = true;
    reason = "Falta contexto suficiente para activar una intervencion segura.";
    result = buildInsufficientContextResult(input.session, input.context, policy.fallbackMessage, reason);
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
    result = eventType === "insufficient_context"
      ? buildInsufficientContextResult(input.session, input.context, policy.fallbackMessage, reason)
      : buildControlledResult(policy.fallbackMessage, reason);
    source = "policy";
  } else {
    try {
      const prompt = buildMentorPrompt({
        context: input.context,
        question: input.question,
        maxItems: Math.min(input.maxItems, detailLevelToMaxItems(rule.detailLevel)),
        heuristic,
        policyInstruction: buildPolicyInstruction(policy, eventType, rule, currentHintUsage),
      });
      const aiRaw = await runTextByMode(prompt);
      const parsed = parseMentorResultFromText(aiRaw, input.maxItems);
      if (parsed) {
        result = parsed;
        source = "ai";
      }
    } catch {
      source = "heuristic";
    }

    result = trimResultByPolicy(result, policy, rule);

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

  return {
    source,
    result,
    telemetryId,
    policy: {
      name: policy.policyName,
      eventType,
      detailLevel: rule?.detailLevel || "brief",
      interventionType: blocked ? "controlled_message" : rule?.interventionType || "hint",
      blocked,
    },
  };
}
