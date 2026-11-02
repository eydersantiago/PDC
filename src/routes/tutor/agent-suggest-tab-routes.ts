// Ruta POST /suggest-tab: sugerencias del tutor para VS Code y la pestana del navegador.
import { NO_PILOT } from "../../services/pilot/pilot.js";
import crypto from "node:crypto";
import type express from "express";
import { runSuggestTab } from "../../../runSuggestTab.js";
import { env } from "../../config/env.js";
import type { AppDatabase } from "../../db/database.js";
import { durationMs, errorSummary, shortHash, textStats, urlSummary } from "../../services/shared/diagnostics.js";
import { hasTextModelOverride, isTutorStartingError, runTextByModeDetailed } from "../../services/tutor/agent-mode.js";
import { editorBlockCause } from "../../services/tutor/block-messages.js";
import { tutorStartingMessage } from "../../services/infra/gpu-autostart.js";
import { readMaintenance } from "../../services/infra/maintenance.js";
import { buildDeterministicGradeAnswer, buildMissingPdfTextAnswer } from "../../services/vscode/tab-fallbacks.js";
import { buildCompactRagPromptBlock } from "../../services/rag/rag-prompt.js";
import { isEditorFocusScope, isExplicitSuggestionRequest, isExplicitTrigger, normalizeRequestedAction, normalizeSuggestionScope, normalizeSuggestionTrigger } from "../../services/vscode/editor-request.js";
import { prioritizeRagSourcesForScenario } from "../../services/tutor/scenario-resources.js";
import { avoidRepeatInstruction, buildScopedTabSuggestionPrompt, buildTabSuggestionPrompt, editorCodeProblem, editorCodeRetryInstruction, hasClosedCodeBlock, modernizeEditorQuestion } from "../../services/vscode/tab-suggestion-prompt.js";
import { trimText } from "../../services/shared/text-utils.js";
import { buildControlledSuggestionMarkdown, buildStartingSuggestionMarkdown, buildUnavailableSuggestionMarkdown, buildSuggestionPolicyInstruction, evaluateSuggestionPolicy, EXPLICIT_REQUEST_WINDOW_MS, firstErrorText, type CodeApplicationDecision } from "../../services/policy/suggestion-policy.js";
import { actorAnonId, editorExerciseKey, type TelemetryActor } from "../../services/telemetry/telemetry-actors.js";
import { exerciseHash } from "../../services/telemetry/telemetry-hash.js";
import { createReferenceLineCheck, resolveExamReferenceForRequest } from "../../services/exam/exam-reference.js";
import { createLiveProseTracker } from "../../services/vscode/live-prose.js";
import { createSuggestTabReply } from "./suggest-tab-stream.js";
import { finalizeEditorSuggestion, prepareEditorModelOutput, truncationTelemetryReason } from "../../services/vscode/suggestion-output.js";
import type { DecisionReasonCode, RagContextItem } from "../../types/app.js";
import { resolvePolicyForSession, resolveRequestActor } from "../route-utils.js";
import { getRequestId, agentRoutesLog, summarizeRagSourcesForLog } from "./agent-route-utils.js";
import { createSuggestTabHelpers, suggestTabCourseCode, maintenanceSuggestTabReply } from "./agent-suggest-tab-helpers.js";

export function registerAgentSuggestTabRoutes(app: express.Express, database: AppDatabase) {
  const {
    cacheNamespaceForScope,
    buildSuggestTabCacheKey,
    buildSuggestTabRagPayload,
    SUGGEST_TAB_PROMPT_SOURCES,
    SUGGEST_TAB_RETRY_MAX_ELAPSED_MS,
    SUGGEST_TAB_CLIENT_WAIT_MS,
    getCachedSuggestTabOutput,
    setCachedSuggestTabOutput,
    parseSuggestionDiagnostics,
    policyPayload,
    codeApplicationPayload,
  } = createSuggestTabHelpers(database);

  app.post("/suggest-tab", async (req, res) => {
    const requestId = getRequestId(req);
    const startedAt = Date.now();
    let logger = agentRoutesLog.child({ requestId, route: "/suggest-tab", mode: env.targetMode });
    // Respuesta en vivo (01-11-2026, suggest-tab-stream.ts): con «Accept: application/x-ndjson»
    // la prosa sale por partes y al final el mismo objeto JSON de siempre; sin la cabecera, igual
    // que antes. Todas las salidas de la ruta pasan por reply.send.
    const reply = createSuggestTabReply(req, res);
    try {
      const tabContent = trimText(req.body?.tab_content);
      logger.info("suggest-tab.request.received", {
        contentLength: trimText(req.header("content-length")),
        tabContent: textStats(tabContent),
        question: textStats(req.body?.question),
        tabTitle: textStats(req.body?.tab_title),
        tabUrl: urlSummary(req.body?.tab_url),
        repoFullName: trimText(req.body?.repoFullName),
        filePath: trimText(req.body?.filePath),
      });
      if (!tabContent) {
        logger.warn("suggest-tab.request.invalid", {
          reason: "tab_content requerido",
        });
        return reply.send({ ok: false, error: "tab_content requerido" }, 400);
      }

      const rawQuestion = trimText(req.body?.question);
      const tabTitle = trimText(req.body?.tab_title);
      const tabUrl = trimText(req.body?.tab_url);
      const courseCode = suggestTabCourseCode(req.body?.ragCourseCode || req.body?.rag_course_code || req.body?.courseCode || req.body?.course_code);
      const scope = normalizeSuggestionScope(req.body?.suggestion_scope ?? req.body?.suggestionScope, rawQuestion, tabContent);
      const cacheNamespace = cacheNamespaceForScope(scope);
      // Editor: sin las instrucciones de "comentario TODO" de las extensiones anteriores a la
      // 0.0.34 (modernizeEditorQuestion) y con la accion que pidio el estudiante, si la hay.
      const isEditorFocus = isEditorFocusScope(scope);
      const question = isEditorFocus ? modernizeEditorQuestion(rawQuestion) : rawQuestion;
      const requestedAction = isEditorFocus ? normalizeRequestedAction(req.body?.requestedAction ?? req.body?.requested_action) : "";

      // Aviso «Estamos actualizando» (28-10-2026): el tutor responde el aviso, sin decision del
      // tutor ni cache (no es una sugerencia).
      const maintenance = await readMaintenance(database);
      if (maintenance.active) {
        logger.info("suggest-tab.request.maintenance", { durationMs: durationMs(startedAt) });
        return reply.send(maintenanceSuggestTabReply(maintenance, { scope, cacheNamespace, courseCode }));
      }

      // --- Politica del docente (A9.10) -------------------------------------
      const trigger = normalizeSuggestionTrigger(req.body?.trigger);
      const filePath = trimText(req.body?.filePath) || tabTitle;
      const languageHint = trimText(req.body?.languageHint);
      const visibleError = trimText(req.body?.visibleError).slice(0, 2000);
      const diagnosticsList = parseSuggestionDiagnostics(req.body?.diagnostics);
      const signals = {
        question,
        scope,
        trigger,
        visibleError,
        diagnostics: diagnosticsList,
        selection: trimText(req.body?.selection),
        tabContent,
        languageHint,
        filePath,
      };
      const exerciseKey = editorExerciseKey(filePath);
      const { session: actorSession, actor } = await resolveRequestActor(database, req);
      const policy = await resolvePolicyForSession(database, actorSession).catch(() => null);
      const applicationsUsed = actor
        ? await database.countAllowedCodeApplications(actorAnonId(actor), exerciseHash(exerciseKey)).catch(() => 0)
        : 0;
      // 30-10-2026: «Otra sugerencia» y los pedidos de codigo sobre el cursor o la seleccion
      // tambien suben la etapa (5, 10 y el maximo del docente); los automaticos no.
      const explicitRequest = isExplicitSuggestionRequest({ scope, trigger, requestedAction });
      const explicitRequestsBefore = actor && explicitRequest
        ? await database.countRecentExplicitEditorRequests(
          actorAnonId(actor),
          exerciseHash(exerciseKey),
          new Date(Date.now() - EXPLICIT_REQUEST_WINDOW_MS),
        ).catch(() => 0)
        : 0;
      // A13.1: condicion del estudiante en el piloto AB/BA (vacia fuera del piloto).
      const pilot = await database.getPilotStateForUser(actorSession?.user).catch(() => NO_PILOT);
      const decision = policy
        ? evaluateSuggestionPolicy({ policy, signals, applicationsUsed, explicitRequestsBefore, pilotCondition: pilot.condition })
        : null;
      // Examen 28-10-2026: solucion y guia privadas del docente (exam-reference.ts), solo para el
      // repositorio del ejercicio, con sesion iniciada y con la politica activa (su guardarrail
      // limita el codigo). El resumen del archivo no propone codigo: recibe lo del panel (sin .cpp).
      const examReference = scope === "general"
        ? null
        : resolveExamReferenceForRequest(
          { repoFullName: trimText(req.body?.repoFullName), url: tabUrl, title: tabTitle, filePath },
          { channel: scope === "file_summary" ? "panel" : "editor", session: actorSession, decision },
        );
      const decisionId = crypto.randomUUID();
      const errorForPrompt = firstErrorText(signals);
      const effectiveQuestion = [question, errorForPrompt ? `Error visible en el editor: ${errorForPrompt.slice(0, 500)}` : ""]
        .filter(Boolean)
        .join("\n");
      const policyInstruction = policy && decision && !decision.blocked
        ? buildSuggestionPolicyInstruction(policy, decision, { requestedAction })
        : "";
      // null sin referencia; "" con la referencia pero sin un paso reconocido.
      const referenceStepId = examReference ? examReference.stepId : null;
      const cacheKey = buildSuggestTabCacheKey({
        scope,
        tabContent,
        question: effectiveQuestion,
        policyInstruction,
        policyUpdatedAt: policy?.updatedAt || "",
        requestedAction,
        tabTitle,
        tabUrl,
        courseCode,
        referenceStepId,
      });
      logger = logger.child({
        scope,
        cacheNamespace,
        cacheHash: shortHash(cacheKey),
        courseCode,
        policyEvent: decision?.eventType || "",
      });

      const recordDecision = async (details: {
        latencyMs: number;
        source: string;
        cached: boolean;
        /** metadata.reason del recorte del guardarrail (truncationTelemetryReason); "" sin recorte. */
        truncationReason?: string;
        /** Sin respuesta del modelo (mensaje controlado): no cuenta como ayuda recibida. */
        degraded?: boolean;
        codeApplication: CodeApplicationDecision | null;
        actorForEvent: TelemetryActor | null;
        reasonCode?: DecisionReasonCode;
        /** Fuentes autorizadas que acompanan la respuesta (KPI de anclaje RAG). */
        ragSources?: number;
        /** Servidor de inferencia que respondio (QUEUE_WORKER_ID). */
        worker?: string;
        /** Otra sugerencia pedida sobre el mismo codigo poco despues («Otra sugerencia»). */
        repeated?: boolean;
      }) => {
        // Respuesta en vivo (01-11-2026): se pidio NDJSON y, si salio prosa antes del final, cuanto
        // tardo el primer parcial desde que llego el pedido.
        const firstPartialMs = reply.firstPartialAt === null ? null : Math.max(0, reply.firstPartialAt - startedAt);
        if (!details.actorForEvent) return;
        await database.insertTelemetryEvents([
          {
            source: "backend",
            channel: "vscode",
            category: "tutor",
            eventType: "tutor_decision",
            decisionId,
            courseCode,
            exerciseKey,
            language: languageHint,
            filePath,
            policyEventType: decision?.eventType || "",
            interventionType: decision ? (decision.blocked ? "controlled_message" : decision.rule?.interventionType || "hint") : "",
            helpStage: decision?.helpStage || "",
            reasonCode: details.reasonCode || decision?.reasonCode || "",
            blocked: decision?.blocked ?? false,
            latencyMs: details.latencyMs,
            errorText: errorForPrompt || undefined,
            contextText: tabContent.slice(0, 6000),
            metadata: {
              trigger,
              scope,
              cached: details.cached,
              source: details.source,
              mode: env.targetMode,
              ...(requestedAction ? { requestedAction } : {}),
              ...(details.truncationReason ? { reason: details.truncationReason } : {}),
              // Pedido explicito que el tutor respondio: sube la etapa (countRecentExplicitEditorRequests).
              ...(explicitRequest && !details.degraded && !decision?.blocked ? { explicitRequest: true } : {}),
              ...(typeof details.ragSources === "number" ? { ragSources: details.ragSources } : {}),
              ...(details.worker ? { worker: details.worker } : {}),
              ...(decision?.blocked ? { cause: editorBlockCause(decision.reasonCode) } : {}),
              ...(details.repeated ? { repeated: true } : {}),
              ...(reply.streaming ? { streamed: true } : {}),
              ...(firstPartialMs !== null ? { firstPartialMs } : {}),
              ...(details.codeApplication ? { allowed: details.codeApplication.allowed, maxLines: details.codeApplication.maxLines } : {}),
              ...(details.codeApplication && details.codeApplication.remaining !== null ? { remaining: details.codeApplication.remaining } : {}),
            },
          },
        ], details.actorForEvent).catch((error) => {
          logger.warn("suggest-tab.telemetry.failed", { error: errorSummary(error) });
        });
      };

      if (decision?.blocked && policy) {
        const output = buildControlledSuggestionMarkdown(policy, decision);
        await recordDecision({
          latencyMs: durationMs(startedAt),
          source: "policy",
          cached: false,
          codeApplication: decision.codeApplication,
          actorForEvent: actor,
        });
        logger.info("suggest-tab.request.blocked", {
          durationMs: durationMs(startedAt),
          reasonCode: decision.reasonCode,
        });
        return reply.send({
          ok: true,
          output_text: output,
          suggestion_scope: scope,
          cache_namespace: cacheNamespace,
          cached: false,
          blocked: true,
          decision_id: actor ? decisionId : null,
          policy_applied: policyPayload(decision, policy),
          code_application: codeApplicationPayload(decision.codeApplication),
          rag_course_code: courseCode,
          rag_sources: [],
        });
      }

      // Revisa la salida con la politica (A10.2) y arma la respuesta comun. Los pasos sobre el
      // texto (y su orden) estan en finalizeEditorSuggestion; aqui solo logs, telemetria y respuesta.
      const finish = async (
        rawOutput: string,
        meta: { cached: boolean; source: string; degraded?: boolean; worker?: string; starting?: boolean; repeated?: boolean },
        ragPayload: { rag_course_code: string; rag_sources: unknown[] },
      ) => {
        // Tambien la de la cache: una respuesta guardada antes del arreglo del 28-10 puede traer
        // la linea «Aplicar:» dentro del bloque de codigo.
        const finalized = finalizeEditorSuggestion(rawOutput, {
          decision,
          options: { requestedAction, selection: signals.selection, languageHint },
          examReference,
        });
        const { text: output, codeApplication, counters } = finalized;
        if (counters.removedBlocks) {
          logger.warn("suggest-tab.exam_reference.extra_blocks_removed", { removedBlocks: counters.removedBlocks });
        }
        if (counters.removedLines) {
          logger.warn("suggest-tab.exam_reference.leak_trimmed", { removedLines: counters.removedLines });
        }
        if (finalized.truncation !== "none") {
          logger.info("suggest-tab.guardrail.truncated", {
            truncation: finalized.truncation,
            guideCause: finalized.guideCause,
            applyLineRemoved: counters.applyLineRemoved,
          });
        }
        await recordDecision({
          latencyMs: durationMs(startedAt),
          source: meta.source,
          cached: meta.cached,
          truncationReason: truncationTelemetryReason(finalized),
          degraded: meta.degraded,
          codeApplication,
          actorForEvent: actor,
          reasonCode: meta.degraded ? "model_error_fallback" : undefined,
          ragSources: Array.isArray(ragPayload.rag_sources) ? ragPayload.rag_sources.length : 0,
          worker: meta.worker,
          repeated: meta.repeated,
        });
        return {
          ok: true,
          output_text: output,
          suggestion_scope: scope,
          cache_namespace: cacheNamespace,
          cached: meta.cached,
          blocked: false,
          requested_action: requestedAction || null,
          ...(meta.degraded ? { degraded: true } : {}),
          ...(meta.starting ? { tutor_starting: true } : {}),
          decision_id: actor ? decisionId : null,
          policy_applied: policyPayload(decision, policy),
          code_application: codeApplicationPayload(codeApplication, finalized),
          ...ragPayload,
        };
      };

      logger.info("suggest-tab.request.start", {
        tabContent: textStats(tabContent),
        question: textStats(question),
        tabTitle: textStats(tabTitle),
        tabUrl: urlSummary(tabUrl),
        repoFullName: trimText(req.body?.repoFullName),
        filePath: trimText(req.body?.filePath),
        languageHint,
        trigger,
        helpStage: decision?.helpStage || "",
        ...(examReference ? { examReferenceStep: examReference.stepId || "general", examReferenceChars: examReference.text.length } : {}),
      });
      let ragPayloadPromise: Promise<{ rag_course_code: string; rag_sources: unknown[] }> | null = null;
      const getRagPayload = () => {
        if (!ragPayloadPromise) {
          ragPayloadPromise = buildSuggestTabRagPayload(req, {
            question: effectiveQuestion,
            tabContent,
            tabTitle,
            tabUrl,
            courseCode,
            scope,
            visibleError: errorForPrompt || visibleError,
            logger,
          }).then((payload) => {
            let items = payload.rag_sources as RagContextItem[];
            if (decision && items.length) {
              // A8.6: primero el material que la matriz recomienda para el evento.
              items = prioritizeRagSourcesForScenario(
                items,
                decision.eventType,
                [question, visibleError, signals.selection].filter(Boolean).join("\n"),
              ).items;
            }
            // En el editor, las fuentes que se devuelven son las que vio el modelo.
            if (scope !== "general") items = items.slice(0, SUGGEST_TAB_PROMPT_SOURCES);
            return { ...payload, rag_sources: items };
          });
        }
        return ragPayloadPromise;
      };
      // Un pedido explicito del estudiante en VS Code («Otra sugerencia», «Proponer una
      // mejora»: trigger manual) le pregunta otra vez al modelo; la respuesta nueva si se
      // guarda para los pedidos automaticos.
      const cachedOutput = isExplicitTrigger(trigger) ? null : getCachedSuggestTabOutput(cacheNamespace, cacheKey, referenceStepId);
      // Pedido repetido (28-10-2026: dos pistas identicas a las 11:09 sobre el mismo archivo): si
      // pide otra sugerencia sobre el mismo codigo antes de 2 min, el modelo ve la anterior y se le
      // pide una distinta, con algo mas de variedad.
      const previousOutput = isExplicitTrigger(trigger) ? getCachedSuggestTabOutput(cacheNamespace, cacheKey, referenceStepId) : null;
      if (cachedOutput) {
        logger.info("suggest-tab.cache.hit", {
          output: textStats(cachedOutput),
        });
        const ragStartedAt = Date.now();
        const ragPayload = await getRagPayload();
        logger.info("suggest-tab.rag.done", {
          durationMs: durationMs(ragStartedAt),
          ragCourseCode: ragPayload.rag_course_code,
          ragSources: ragPayload.rag_sources.length,
          selectedSources: summarizeRagSourcesForLog(ragPayload.rag_sources),
        });
        logger.info("suggest-tab.request.done", {
          durationMs: durationMs(startedAt),
          cached: true,
          output: textStats(cachedOutput),
        });
        return reply.send(await finish(cachedOutput, { cached: true, source: "cache" }, ragPayload));
      }

      logger.info("suggest-tab.cache.miss");
      const ragStartedAt = Date.now();
      const ragPayload = await getRagPayload();
      logger.info("suggest-tab.rag.done", {
        durationMs: durationMs(ragStartedAt),
        ragCourseCode: ragPayload.rag_course_code,
        ragSources: ragPayload.rag_sources.length,
        selectedSources: summarizeRagSourcesForLog(ragPayload.rag_sources),
      });
      // Bloque corto: etiqueta, titulo y parrafo que coincide (antes 6000 caracteres de metadatos).
      const ragContext = buildCompactRagPromptBlock(ragPayload.rag_sources as RagContextItem[], {
        maxItems: scope === "general" ? 4 : SUGGEST_TAB_PROMPT_SOURCES,
      });
      const missingPdfText = buildMissingPdfTextAnswer({ question, tabContent });
      if (scope === "general" && missingPdfText) {
        setCachedSuggestTabOutput(cacheNamespace, cacheKey, missingPdfText, referenceStepId);
        logger.info("suggest-tab.response.missing-pdf-text", {
          durationMs: durationMs(startedAt),
          output: textStats(missingPdfText),
        });
        return reply.send(await finish(missingPdfText, { cached: false, source: "deterministic" }, ragPayload));
      }

      const deterministic = buildDeterministicGradeAnswer({ question, tabContent });
      if (scope === "general" && deterministic) {
        setCachedSuggestTabOutput(cacheNamespace, cacheKey, deterministic, referenceStepId);
        logger.info("suggest-tab.response.deterministic", {
          durationMs: durationMs(startedAt),
          output: textStats(deterministic),
        });
        return reply.send(await finish(deterministic, { cached: false, source: "deterministic" }, ragPayload));
      }

      let output = "";
      let outputSource = "ai";
      let outputWorker = "";
      const diagnostics = { requestId, route: "/suggest-tab", scope, cacheNamespace };
      // Prosa en vivo (live-prose.ts): solo lineas completas antes del primer bloque de codigo, sin
      // «Aplicar:» y, con la referencia del examen, sin lo que parezca copiado de ella. El codigo
      // sale solo en el final, ya recortado.
      const liveProse = reply.streaming
        ? createLiveProseTracker(examReference ? { isReferenceLine: createReferenceLineCheck(examReference.text) } : {})
        : null;
      const onModelText = liveProse
        ? (accumulated: string, info?: { restarted?: boolean }) => {
          // El job se reintento en otro worker (cola): lo mostrado era del intento que fallo. Como
          // en el reintento de abajo, VS Code lo borra (restart solo sale si ya se vio algo).
          if (info?.restarted) {
            liveProse.reset();
            reply.restart();
          }
          const prose = liveProse.update(accumulated);
          if (prose) reply.partial(prose);
        }
        : undefined;
      try {
        // El agente con herramientas (runSuggestTab) necesita un modelo en esta maquina: solo en
        // modo local. En modo queue el API no tiene GPU y antes fallaba siempre antes de usar la cola.
        if (scope === "general" && env.targetMode === "local" && !hasTextModelOverride()) {
          try {
            const modelStartedAt = Date.now();
            logger.info("suggest-tab.model.advanced.start", {
              runner: "runSuggestTab",
            });
            output = await runSuggestTab({
              tabContent,
              question: effectiveQuestion,
              tabTitle,
              tabUrl,
              maxTabContentChars: env.maxTabContentChars,
              diagnostics: { ...diagnostics, source: "advanced" },
              policyInstruction,
            });
            logger.info("suggest-tab.model.advanced.done", {
              durationMs: durationMs(modelStartedAt),
              output: textStats(output),
            });
          } catch (error) {
            logger.warn("suggest-tab.model.advanced.failed_fallback", {
              error: errorSummary(error),
            });
            outputSource = "ai_fallback";
            const run = await runTextByModeDetailed(
              buildTabSuggestionPrompt({ tabContent, question: effectiveQuestion, tabTitle, tabUrl, ragContext, policyInstruction }),
              { ...diagnostics, source: "advanced-fallback" },
              { profile: "default" },
              { wakeGpu: actor?.kind === "user" },
            );
            output = run.outputText;
            outputWorker = run.worker.id;
          }
        } else {
          logger.info("suggest-tab.model.scoped.start", {
            runner: "runTextByMode",
          });
          const scopedPrompt = buildScopedTabSuggestionPrompt(scope, {
            tabContent,
            question: effectiveQuestion,
            tabTitle,
            tabUrl,
            ragContext,
            policyInstruction,
            requestedAction,
            languageHint,
            reference: examReference,
          });
          logger.info("suggest-tab.prompt.built", { prompt: textStats(scopedPrompt), repeated: Boolean(previousOutput) });
          const run = await runTextByModeDetailed(
            previousOutput ? `${scopedPrompt}\n\n${avoidRepeatInstruction(previousOutput)}` : scopedPrompt,
            { ...diagnostics, source: previousOutput ? "scoped-repeat" : "scoped" },
            // Editor: temperatura baja (el codigo tiene que calzar con el del estudiante).
            previousOutput
              ? { profile: isEditorFocus ? "editor" : "default", temperature: 0.5 }
              : { profile: isEditorFocus ? "editor" : "default" },
            // Sin servidor vivo, despierta la GPU solo un estudiante identificado (sesion o cliente).
            { wakeGpu: actor?.kind === "user", ...(onModelText ? { onPartial: onModelText } : {}) },
          );
          // Preparada antes de decidir el reintento y la cache (prepareEditorModelOutput): vallas en
          // su linea, sin el margen numerado y sin «Aplicar:» dentro del bloque (si era lo unico,
          // cuenta como sin codigo).
          output = isEditorFocus ? prepareEditorModelOutput(run.outputText) : run.outputText;
          outputWorker = run.worker.id;
          // El estudiante pidio codigo («Proponer una mejora» o «...para continuar») y volvio sin
          // un bloque de codigo real: un reintento con el motivo al final. Si el reintento falla o
          // tampoco trae codigo, queda la primera respuesta (VS Code avisa que vino sin codigo).
          // Solo si la primera tardo poco: VS Code deja de esperar a los 120 s.
          const codeProblem = requestedAction && decision?.codeApplication.allowed !== false
            ? editorCodeProblem(output)
            : "";
          // Si VS Code ya se fue (respuesta en vivo cortada), no se gasta otra llamada al modelo.
          if (requestedAction && codeProblem && reply.clientClosed) {
            logger.info("suggest-tab.model.code_retry_skipped", { reason: codeProblem, cause: "cliente_cerro" });
          } else if (requestedAction && codeProblem && Date.now() - startedAt < SUGGEST_TAB_RETRY_MAX_ELAPSED_MS) {
            logger.warn("suggest-tab.model.code_retry", { reason: codeProblem });
            // Lo que se vio en vivo era de la primera respuesta: VS Code lo borra.
            liveProse?.reset();
            reply.restart();
            try {
              // El reintento tiene que terminar antes de que VS Code deje de esperar (120 s): si no,
              // el estudiante se quedaria tambien sin la primera respuesta.
              const retry = await runTextByModeDetailed(
                `${scopedPrompt}\n\n${editorCodeRetryInstruction(requestedAction, languageHint)}`,
                { ...diagnostics, source: "scoped-retry" },
                { profile: "editor", temperature: 0.35 },
                {
                  timeoutMs: Math.max(15_000, SUGGEST_TAB_CLIENT_WAIT_MS - (Date.now() - startedAt)),
                  ...(onModelText ? { onPartial: onModelText } : {}),
                },
              );
              const retryOutput = prepareEditorModelOutput(retry.outputText);
              if (!editorCodeProblem(retryOutput)) {
                output = retryOutput;
                outputWorker = retry.worker.id;
                outputSource = "ai_retry";
              }
            } catch (error) {
              logger.warn("suggest-tab.model.code_retry_failed", { error: errorSummary(error) });
            }
          }
        }
      } catch (error) {
        // A12.10: sin modelo (GPU apagada, cola sin worker, error del
        // proveedor) el estudiante recibe un mensaje controlado, no un 500.
        // No se guarda en cache para reintentar cuando vuelva el modelo.
        logger.warn("suggest-tab.model.failed_degraded", {
          durationMs: durationMs(startedAt),
          error: errorSummary(error),
        });
        // Sin servidor vivo y con la GPU encendiendose (GPU_AUTOSTART, 28-10-2026): que vuelva en
        // 2 o 3 minutos, no un fallo.
        const starting = isTutorStartingError(error);
        return reply.send(await finish(
          starting ? buildStartingSuggestionMarkdown(tutorStartingMessage()) : buildUnavailableSuggestionMarkdown(),
          { cached: false, source: "degraded", degraded: true, starting },
          ragPayload,
        ));
      }
      // Un pedido de codigo que volvio sin codigo no se guarda: el siguiente intento le
      // pregunta otra vez al modelo.
      if (!requestedAction || hasClosedCodeBlock(output)) {
        setCachedSuggestTabOutput(cacheNamespace, cacheKey, output, referenceStepId);
      }
      logger.info("suggest-tab.request.done", {
        durationMs: durationMs(startedAt),
        cached: false,
        output: textStats(output),
      });

      if (reply.clientClosed) {
        logger.info("suggest-tab.client.closed", { durationMs: durationMs(startedAt) });
      }
      return reply.send(await finish(output, { cached: false, source: outputSource, worker: outputWorker, repeated: Boolean(previousOutput) }, ragPayload));
    } catch (error) {
      logger.error("suggest-tab.request.failed", {
        durationMs: durationMs(startedAt),
        error: errorSummary(error),
      });
      return reply.send({ ok: false, error: String(error) }, 500);
    }
  });
}
