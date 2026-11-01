// Ayudas de /suggest-tab: codigo de curso, cache por alcance, fuentes RAG y cargas de la politica.
import crypto from "node:crypto";
import type express from "express";
import type { AppDatabase } from "../../db/database.js";
import { resolveMentorRagContext } from "../../services/tutor/decision-engine.js";
import { errorSummary, type DiagnosticLogger } from "../../services/shared/diagnostics.js";
import { buildMaintenanceSuggestionMarkdown, type MaintenanceNotice } from "../../services/infra/maintenance.js";
import { buildEditorRagSearchQuery } from "../../services/rag/rag-sources.js";
import { extractEditorCode } from "../../services/vscode/editor-context.js";
import { isEditorFocusScope, type SuggestionScope } from "../../services/vscode/editor-request.js";
import { resolveEffectiveLot } from "../../services/rag/rag-lots.js";
import { trimText } from "../../services/shared/text-utils.js";
import { type CodeApplicationDecision, type SuggestionDiagnostic, type SuggestionPolicyDecision } from "../../services/policy/suggestion-policy.js";
import { type FinalizedEditorSuggestion } from "../../services/vscode/suggestion-output.js";
import type { GithubMentorContext, TeacherPolicy } from "../../types/app.js";
import { resolveSession } from "../route-utils.js";
import { attachRagViewerLinks } from "./agent-route-utils.js";

/** Codigo de curso valido en /suggest-tab: letras, numeros, «_» y «-», hasta 40 (FPOO, FPI...). */
const SUGGEST_TAB_COURSE_CODE = /^[A-Za-z0-9_-]{0,40}$/;

/**
 * El codigo de curso del pedido, o "" si no tiene esa forma (31-10-2026, CA-015): llega del
 * cliente, va a la clave de la cache y a la busqueda RAG (que con "" usa el curso por defecto).
 */
export function suggestTabCourseCode(value: unknown) {
  const clean = trimText(value);
  return SUGGEST_TAB_COURSE_CODE.test(clean) ? clean : "";
}

/** Respuesta de /suggest-tab con el aviso «Estamos actualizando»: sin codigo, sin decision ni cache. */
export function maintenanceSuggestTabReply(notice: MaintenanceNotice, request: { scope: string; cacheNamespace: string; courseCode: string }) {
  return {
    ok: true,
    output_text: buildMaintenanceSuggestionMarkdown(notice),
    suggestion_scope: request.scope,
    cache_namespace: request.cacheNamespace,
    cached: false,
    blocked: false,
    degraded: true,
    maintenance: true,
    decision_id: null,
    policy_applied: null,
    code_application: null,
    rag_course_code: request.courseCode,
    rag_sources: [],
  };
}

export function createSuggestTabHelpers(database: AppDatabase) {
  type SuggestTabCacheNamespace = "general" | "file_summary" | "focus";
  /**
   * referenceStepId: el paso de la referencia del examen con que se genero la salida (null sin
   * referencia). Solo la recibe un pedido con el mismo valor (31-10-2026, CA-015).
   */
  type SuggestTabCacheEntry = { output: string; createdAt: number; referenceStepId: string | null };
  const suggestTabCaches: Record<SuggestTabCacheNamespace, Map<string, SuggestTabCacheEntry>> = {
    general: new Map(),
    file_summary: new Map(),
    focus: new Map(),
  };
  const suggestTabCacheTtlMs = 120_000;
  const suggestTabCacheMaxEntries = 120;

  function cacheNamespaceForScope(scope: SuggestionScope): SuggestTabCacheNamespace {
    if (scope === "file_summary") return "file_summary";
    if (isEditorFocusScope(scope)) return "focus";
    return "general";
  }

  /**
   * Clave de la cache de /suggest-tab: sha256 de todas las partes en un arreglo JSON (31-10-2026,
   * CA-015). Antes se unian con «||» y un courseCode como «examen:<paso>||FPOO» sin sesion armaba
   * la misma clave que un pedido con la referencia del examen y recibia esa salida.
   */
  function buildSuggestTabCacheKey(params: {
    scope: SuggestionScope;
    tabContent: string;
    question: string;
    policyInstruction: string;
    policyUpdatedAt: string;
    requestedAction: string;
    tabTitle: string;
    tabUrl: string;
    courseCode: string;
    referenceStepId: string | null;
  }) {
    const contentHash = crypto.createHash("sha256").update(params.tabContent).digest("hex");
    return crypto.createHash("sha256")
      .update(JSON.stringify([
        params.scope,
        params.tabUrl,
        params.tabTitle,
        params.question,
        params.policyInstruction,
        params.policyUpdatedAt,
        params.requestedAction,
        params.courseCode,
        contentHash,
        params.referenceStepId,
      ]))
      .digest("hex");
  }

  async function buildSuggestTabRagPayload(
    req: express.Request,
    params: {
      question: string;
      tabContent: string;
      tabTitle: string;
      tabUrl: string;
      courseCode: string;
      scope: SuggestionScope;
      visibleError: string;
      logger?: DiagnosticLogger;
    },
  ) {
    const session = await resolveSession(database, req).catch((error) => {
      params.logger?.warn("suggest-tab.session.resolve.failed", {
        error: errorSummary(error),
      });
      return null;
    });
    const filePath = trimText(req.body?.filePath) || params.tabTitle;
    const context: GithubMentorContext = {
      url: params.tabUrl,
      title: params.tabTitle,
      pageContext: "github",
      pageType: "codespace",
      repoFullName: trimText(req.body?.repoFullName),
      filePath,
      languageHint: trimText(req.body?.languageHint),
      courseCode: params.courseCode,
      ragCourseCode: params.courseCode,
      selection: trimText(req.body?.selection),
      codeSnippet: params.tabContent.slice(0, 6000),
      codeLineCount: params.tabContent.split(/\r?\n/).length,
    };
    // Editor (cursor, seleccion y resumen del archivo): la consulta sale del codigo y del error,
    // no de la pregunta que arma VS Code (es una instruccion de formato) ni de los rotulos del
    // contexto. Se quedan las fuentes con al menos la mitad del puntaje de la mejor, que traen
    // dos terminos de la consulta o mas (sin contar el lenguaje), y a lo sumo dos fragmentos por
    // fuente; si ninguna llega, no se cita nada (revision de precision del 21/10/2026).
    const isEditorScope = params.scope !== "general";
    const editorCode = isEditorScope ? extractEditorCode(params.tabContent, context.selection) : null;
    const rag = await resolveMentorRagContext({
      question: params.question,
      context,
      session,
      database,
      ...(editorCode
        ? {
            queryOverride: buildEditorRagSearchQuery({
              focusCode: params.scope === "file_summary" ? "" : editorCode.focusCode,
              fileCode: editorCode.fileCode,
              visibleError: params.visibleError,
              languageHint: context.languageHint,
              filePath,
            }),
            rankOptions: { minRelativeScore: 0.5, maxPerSource: 2, minMatchedTerms: 2 },
          }
        : {}),
    }).catch((error) => {
      params.logger?.warn("suggest-tab.rag.resolve.failed", {
        error: errorSummary(error),
      });
      return {
        ragSources: [],
        ragCourseCode: params.courseCode,
        ragLot: resolveEffectiveLot({ courseCode: params.courseCode, lots: [], activeLotId: null }),
      };
    });

    return {
      rag_course_code: rag.ragCourseCode,
      rag_lot: { id: rag.ragLot.lotId, name: rag.ragLot.name, origin: rag.ragLot.origin },
      rag_sources: attachRagViewerLinks(req, rag.ragSources, rag.ragCourseCode),
    };
  }

  /** Fuentes que van en el prompt; el editor muestra como "material citado" estas mismas. */
  const SUGGEST_TAB_PROMPT_SOURCES = 3;
  /** Reintento de un pedido de codigo sin codigo: solo si la primera respuesta llego antes de esto. */
  const SUGGEST_TAB_RETRY_MAX_ELAPSED_MS = 50_000;
  /** Lo que espera VS Code por /suggest-tab (120 s) menos un margen para la respuesta. */
  const SUGGEST_TAB_CLIENT_WAIT_MS = 110_000;

  /** La salida guardada, solo si se genero con el mismo paso de la referencia (o sin ella). */
  function getCachedSuggestTabOutput(namespace: SuggestTabCacheNamespace, key: string, referenceStepId: string | null) {
    const cache = suggestTabCaches[namespace];
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > suggestTabCacheTtlMs) {
      cache.delete(key);
      return null;
    }
    if (entry.referenceStepId !== referenceStepId) return null;

    return entry.output;
  }

  function setCachedSuggestTabOutput(namespace: SuggestTabCacheNamespace, key: string, output: string, referenceStepId: string | null) {
    const cache = suggestTabCaches[namespace];
    cache.set(key, {
      output,
      createdAt: Date.now(),
      referenceStepId,
    });

    if (cache.size > suggestTabCacheMaxEntries) {
      const entries = [...cache.entries()]
        .sort((left, right) => left[1].createdAt - right[1].createdAt);
      for (const [entryKey] of entries.slice(0, cache.size - suggestTabCacheMaxEntries)) {
        cache.delete(entryKey);
      }
    }
  }

  function parseSuggestionDiagnostics(value: unknown): SuggestionDiagnostic[] {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 10).map((item) => {
      const source = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const line = Number(source.line);
      return {
        message: trimText(source.message).slice(0, 300),
        severity: source.severity === "warning" ? "warning" as const : "error" as const,
        ...(Number.isFinite(line) ? { line: Math.max(0, Math.round(line)) } : {}),
      };
    }).filter((item) => item.message);
  }

  function policyPayload(decision: SuggestionPolicyDecision | null, policy: TeacherPolicy | null) {
    if (!decision || !policy) return null;
    return {
      name: policy.policyName,
      eventType: decision.eventType,
      interventionType: decision.blocked ? "controlled_message" : decision.rule?.interventionType || "hint",
      detailLevel: decision.rule?.detailLevel || "brief",
      helpStage: decision.helpStage,
      blocked: decision.blocked,
      reason: decision.reason,
      reasonCode: decision.reasonCode,
    };
  }

  /**
   * code_application de /suggest-tab (contrato en docs/arquitectura/contrato-api.md, 2.2). Desde el
   * 30-10-2026 dice si el guardarrail recorto el codigo, sin que VS Code busque el texto de la nota:
   *   truncation: "none" (sin recorte), "applicable" (un trozo cerrado o un reemplazo parcial: se
   *               puede aplicar si allowed) o "guide" (solo guia: allowed false). Solo truncation
   *               (con allowed) dice si el codigo se puede aplicar; cut es informativo.
   *   cut: siempre presente; null sin recorte de un bloque (tambien en un "guide" con tope 0),
   *        { kind: "prefix", linesShown, linesTotal, endsCleanly } o
   *        { kind: "partial", changesShown, changesTotal }.
   *   reasonCode: en un recorte de guia, code_application_too_large (tope de la etapa) o
   *               code_application_incomplete_reply (el bloque de la respuesta no termina), salvo
   *               que ya no se pudiera aplicar (docente, cupo o piloto): entonces queda ese motivo.
   */
  function codeApplicationPayload(
    decision: CodeApplicationDecision | null,
    guardrail?: Pick<FinalizedEditorSuggestion, "truncation" | "cutSummary">,
  ) {
    if (!decision) return null;
    return {
      allowed: decision.allowed,
      maxLines: decision.maxLines,
      remaining: decision.remaining,
      requireConfirmation: decision.requireConfirmation,
      countsAsHint: decision.countsAsHint,
      reason: decision.reason,
      reasonCode: decision.reasonCode,
      truncation: guardrail?.truncation ?? "none",
      cut: guardrail?.cutSummary ?? null,
    };
  }

  return {
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
  };
}
