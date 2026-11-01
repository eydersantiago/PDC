// Motor de decision del tutor en el overlay: evaluateMentorIntervention (politica, piloto, modelo, referencia del examen y telemetria).
import { NO_PILOT, PILOT_NO_TUTOR_MESSAGE, PILOT_NO_TUTOR_REASON } from "../pilot/pilot.js";
import { randomUUID } from "node:crypto";
import type {
  DecisionReasonCode,
  GithubMentorContext,
  GithubMentorResult,
  HelpStage,
  PolicyDetailLevel,
  PolicyEventType,
} from "../../types/app.js";
import { describeTutorOutage, runTextByModeDetailed } from "./agent-mode.js";
import { resolveExamReferenceForRequest, type ExamReferenceAccess, type ExamReferenceContext } from "../exam/exam-reference.js";
import {
  buildHeuristicMentorResult,
  buildMentorPrompt,
  parseMentorResultFromText,
} from "./mentor-core.js";
import { rankRagSources } from "../rag/rag-sources.js";
import {
  buildRagPromptBlock,
  enrichMentorResultWithRag,
  ensureMentorResultRagCitations,
} from "../rag/rag-prompt.js";
import { trimText } from "../shared/text-utils.js";
import {
  applyTemplateLimits,
  listMentorResultTexts,
  replaceMentorResultTexts,
  resolveHelpStage,
  templateInstruction,
} from "./intervention-templates.js";
import { explainBlock, overlayBlockCause, type BlockExplanation } from "./block-messages.js";
import { type EffectiveRagLot } from "../rag/rag-lots.js";
import { prioritizeRagSourcesForScenario } from "./scenario-resources.js";
import { resolveMentorRagContext } from "./mentor-rag-context.js";
import { type MentorEvaluationInput, recordOverlayDecision, buildExerciseKey, detectEventType, countVisibleSignals, shouldCountTowardsHintLimit, reasonCodeFor, detailLevelToMaxItems, buildPolicyInstruction, trimResultByPolicy, buildContextSummary } from "./mentor-decision-helpers.js";

/**
 * Referencia privada del examen para el panel (exam-reference.ts): null sin sesion, sin la
 * politica del docente o fuera del ejercicio (la puerta esta en resolveExamReferenceForRequest).
 */
function examReferenceForMentor(context: GithubMentorContext, access: Omit<ExamReferenceAccess, "channel">) {
  return resolveExamReferenceForRequest({
    repoFullName: trimText(context.repoFullName),
    url: trimText(context.url),
    title: trimText(context.title),
    filePath: trimText(context.filePath),
  }, { channel: "panel", ...access });
}

/**
 * Con la referencia del examen, ningun texto de la respuesta del panel (los cinco campos) trae mas
 * codigo que la etapa, y ninguno trae lineas copiadas de ella fuera de los bloques (cupo comun).
 */
function protectMentorResultFromReference(result: GithubMentorResult, reference: ExamReferenceContext | null, stage: HelpStage): GithubMentorResult {
  if (!reference) return result;
  const capped = applyTemplateLimits(result, stage, { allFields: true });
  const { texts } = reference.removeLeakedReferenceLinesInTexts(listMentorResultTexts(capped));
  return replaceMentorResultTexts(capped, texts);
}

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
  ragLot: EffectiveRagLot;
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

/**
 * Respuesta de un bloqueo: lo que paso y que hacer segun la causa (block-messages.ts), en
 * welcome_message y analysis_summary (el overlay los muestra como saludo y estado) y en la guia.
 */
function buildControlledResult(explanation: BlockExplanation, reason: string): GithubMentorResult {
  const steps = explanation.steps.length
    ? explanation.steps
    : ["Ubica el ejercicio o archivo del curso.", "Comparte una senal concreta del bloqueo.", "Vuelve a pedir ayuda con ese contexto minimo."];
  return {
    ideas: [explanation.message],
    searches: [
      "Comparte el enunciado exacto, el error visible o un fragmento corto del codigo.",
      "Limita la pregunta a contenidos de POO, C++, Python, GitHub o Codespaces del curso.",
      "Si necesitas ayuda conceptual, indica el RA o indicador que quieres reforzar.",
    ],
    guide: [...steps, `Motivo de control: ${reason}.`],
    welcome_message: explanation.message,
    analysis_summary: explanation.message,
  };
}

/**
 * Sin servidor del modelo (28-10-2026): el aviso («el tutor se esta encendiendo...» o «no esta
 * disponible») va primero, como saludo y estado; las pistas generales siguen debajo.
 */
function withTutorNotice(result: GithubMentorResult, notice: string): GithubMentorResult {
  if (!notice) return result;
  return {
    ...result,
    ideas: [notice, ...result.ideas.filter((idea) => idea !== notice)],
    welcome_message: notice,
    analysis_summary: notice,
  };
}

export async function evaluateMentorIntervention(
  input: MentorEvaluationInput,
): Promise<MentorEvaluationOutput> {
  const startedAt = Date.now();
  const resolved = await resolveMentorRagContext(input);
  const ragCourseCode = resolved.ragCourseCode;
  const ragLot = resolved.ragLot;
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
      ragLot,
      blocked: false,
      helpStage: "hint_1",
      latencyMs: 0,
      ragSources,
      ragCourseCode,
      policy: null,
    };
    let worker = "";
    try {
      const prompt = buildMentorPrompt({
        context: input.context,
        question: input.question,
        maxItems: input.maxItems,
        heuristic,
        ragContext,
        policyInstruction: templateInstruction("hint_1"),
        // Sin sesion no va la referencia del examen: resolveExamReferenceForRequest la niega.
      });
      // Sin sesion, despierta la GPU solo un cliente identificado (x-adaceen-client-id).
      const run = await runTextByModeDetailed(prompt, { route: "mentor" }, { profile: "json" }, { wakeGpu: input.actor?.kind === "user" });
      worker = run.worker.id;
      const parsed = parseMentorResultFromText(run.outputText, input.maxItems);
      if (parsed) {
        output = {
          ...output,
          source: "ai",
          result: applyTemplateLimits(ensureMentorResultRagCitations(parsed, ragSources), "hint_1"),
        };
      }
    } catch (error) {
      // se queda la heuristica, con el aviso si no hay servidor del modelo
      output = { ...output, result: withTutorNotice(output.result, describeTutorOutage(error)) };
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
      worker,
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
      ragLot,
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
  // A13.1: en el bloque del piloto sin tutor no se llama al modelo ni se cuentan pistas.
  const pilot = await input.database.getPilotStateForUser(input.session.user).catch(() => NO_PILOT);

  if (pilot.condition === "sin_tutor") {
    blocked = true;
    reason = PILOT_NO_TUTOR_REASON;
  } else if (!rule || !rule.enabled) {
    blocked = true;
    reason = "La politica docente desactivo este tipo de intervencion.";
  } else if (countVisibleSignals(input.context) < rule.activationThreshold) {
    blocked = true;
    reason = "Falta contexto suficiente para activar una intervencion segura.";
  } else if (
    input.session.user.role === "student"
    && shouldCountTowardsHintLimit(rule)
    && policy.maxHintsPerExercise !== null
    && currentHintUsage >= policy.maxHintsPerExercise
  ) {
    blocked = true;
    reason = `Se alcanzo el maximo de pistas por ejercicio (${policy.maxHintsPerExercise}).`;
  } else if (rule.interventionType === "controlled_message") {
    blocked = true;
    reason = eventType === "out_of_domain"
      ? "Consulta fuera del dominio autorizado del curso."
      : "Contexto insuficiente para responder sin inventar.";
  }

  // A2.2 / A9.8: etapa de ayuda segun las pistas ya usadas en el ejercicio.
  const helpStage = resolveHelpStage({ policy, rule, hintsUsed: currentHintUsage, blocked });
  if (!blocked && helpStage === "controlled") {
    // Ninguna intervencion habilitada por el docente sirve para este evento.
    blocked = true;
    reason = "La politica docente desactivo este tipo de ayuda.";
  }
  // Un bloqueo dice su causa y que hacer (28-10-2026): sin codigo en pantalla no es lo mismo que
  // la politica del docente.
  const blockCause = blocked
    ? overlayBlockCause({ reasonCode: reasonCodeFor(reason, eventType), eventType, context: input.context })
    : undefined;
  if (blockCause) {
    result = buildControlledResult(explainBlock(blockCause, {
      fallbackMessage: blockCause === "pilot_no_tutor" ? PILOT_NO_TUTOR_MESSAGE : policy.fallbackMessage,
      maxHints: policy.maxHintsPerExercise,
    }), reason);
    source = "policy";
  }
  let modelFailed = false;
  let worker = "";
  let outageNotice = "";

  if (!blocked && rule) {
    const examReference = examReferenceForMentor(input.context, { session: input.session, decision: { blocked } });
    try {
      const prompt = buildMentorPrompt({
        context: input.context,
        question: input.question,
        maxItems: Math.min(input.maxItems, detailLevelToMaxItems(rule.detailLevel)),
        heuristic,
        policyInstruction: buildPolicyInstruction(policy, eventType, rule, currentHintUsage, helpStage),
        ragContext,
        referenceContext: examReference?.text,
      });
      const run = await runTextByModeDetailed(prompt, { route: "mentor" }, { profile: "json" }, { wakeGpu: true });
      worker = run.worker.id;
      const parsed = parseMentorResultFromText(run.outputText, input.maxItems);
      if (parsed) {
        result = ensureMentorResultRagCitations(parsed, ragSources);
        source = "ai";
      } else {
        modelFailed = true;
      }
    } catch (error) {
      source = "heuristic";
      modelFailed = true;
      outageNotice = describeTutorOutage(error);
    }

    // A10.2: limites de la plantilla (codigo) ademas del recorte por nivel de detalle. Con la
    // referencia del examen, tampoco salen lineas copiadas de ella fuera de los bloques.
    result = withTutorNotice(ensureMentorResultRagCitations(
      protectMentorResultFromReference(applyTemplateLimits(trimResultByPolicy(result, policy, rule), helpStage), examReference, helpStage),
      ragSources,
    ), outageNotice);

    // Sin servidor del modelo no hubo pista del tutor: no gasta su cupo.
    if (input.session.user.role === "student" && shouldCountTowardsHintLimit(rule) && !outageNotice) {
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
    worker,
    cause: blockCause,
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
    ragLot,
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
