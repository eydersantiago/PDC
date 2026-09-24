import type {
  CodeApplicationSettings,
  PolicyEventType,
  PolicyRule,
  TeacherPolicy,
} from "../types/app.js";

/**
 * Ajustes de la politica del docente que se normalizan al leer la base.
 * Modulo puro (sin red ni base de datos), igual que quiz-settings.ts, para
 * que una politica guardada antes de un cambio de esquema siga siendo valida.
 */

export const POLICY_EVENT_TYPES: PolicyEventType[] = [
  "compile_error",
  "runtime_error",
  "concept_question",
  "design_block",
  "workflow_guidance",
  "insufficient_context",
  "out_of_domain",
  "code_suggestion",
];

export const DEFAULT_EVENT_RULES: Record<PolicyEventType, PolicyRule> = {
  compile_error: {
    enabled: true,
    interventionType: "hint",
    detailLevel: "guided",
    activationThreshold: 1,
    maxUsesPerSession: 4,
  },
  runtime_error: {
    enabled: true,
    interventionType: "hint",
    detailLevel: "guided",
    activationThreshold: 1,
    maxUsesPerSession: 4,
  },
  concept_question: {
    enabled: true,
    interventionType: "explanation",
    detailLevel: "brief",
    activationThreshold: 1,
    maxUsesPerSession: 5,
  },
  design_block: {
    enabled: true,
    interventionType: "hint",
    detailLevel: "progressive",
    activationThreshold: 1,
    maxUsesPerSession: 4,
  },
  workflow_guidance: {
    enabled: true,
    interventionType: "hint",
    detailLevel: "brief",
    activationThreshold: 1,
    maxUsesPerSession: 3,
  },
  insufficient_context: {
    enabled: true,
    interventionType: "controlled_message",
    detailLevel: "brief",
    activationThreshold: 1,
    maxUsesPerSession: null,
  },
  out_of_domain: {
    enabled: true,
    interventionType: "controlled_message",
    detailLevel: "brief",
    activationThreshold: 1,
    maxUsesPerSession: null,
  },
  // Sugerencias de VS Code sobre el archivo activo sin error visible ni
  // pregunta conceptual: pista guiada; el codigo que se pueda aplicar lo
  // limita codeApplication.
  code_suggestion: {
    enabled: true,
    interventionType: "hint",
    detailLevel: "guided",
    activationThreshold: 1,
    maxUsesPerSession: null,
  },
};

export const DEFAULT_CODE_APPLICATION_SETTINGS: CodeApplicationSettings = {
  allowed: true,
  maxLines: 20,
  countsAsHint: true,
  requireConfirmation: true,
};

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
}

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

const INTERVENTION_TYPES = new Set(["explanation", "hint", "example", "mini_quiz", "controlled_message"]);
const DETAIL_LEVELS = new Set(["brief", "guided", "progressive"]);

function normalizeRule(raw: unknown, fallback: PolicyRule): PolicyRule {
  const source = asRecord(raw);
  const interventionType = INTERVENTION_TYPES.has(String(source.interventionType))
    ? source.interventionType as PolicyRule["interventionType"]
    : fallback.interventionType;
  const detailLevel = DETAIL_LEVELS.has(String(source.detailLevel))
    ? source.detailLevel as PolicyRule["detailLevel"]
    : fallback.detailLevel;
  const maxUsesPerSession = source.maxUsesPerSession === null
    ? null
    : source.maxUsesPerSession === undefined
      ? fallback.maxUsesPerSession
      : clampInt(source.maxUsesPerSession, 1, 1000, fallback.maxUsesPerSession ?? 4);
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : fallback.enabled,
    interventionType,
    detailLevel,
    activationThreshold: clampInt(source.activationThreshold, 1, 5, fallback.activationThreshold),
    maxUsesPerSession,
  };
}

/**
 * Completa las reglas por evento: una politica guardada antes de que
 * existiera un tipo de evento (por ejemplo code_suggestion) recibe la regla
 * por defecto en vez de quedar bloqueada por "regla desactivada".
 */
export function normalizeEventRules(raw: unknown): Record<PolicyEventType, PolicyRule> {
  const source = asRecord(raw);
  const rules = {} as Record<PolicyEventType, PolicyRule>;
  for (const eventType of POLICY_EVENT_TYPES) {
    rules[eventType] = source[eventType] === undefined
      ? { ...DEFAULT_EVENT_RULES[eventType] }
      : normalizeRule(source[eventType], DEFAULT_EVENT_RULES[eventType]);
  }
  return rules;
}

/** Lo que venga de la base (jsonb vacio, parcial o viejo) sale completo y valido. */
export function normalizeCodeApplicationSettings(raw: unknown): CodeApplicationSettings {
  const source = asRecord(raw);
  return {
    allowed: typeof source.allowed === "boolean" ? source.allowed : DEFAULT_CODE_APPLICATION_SETTINGS.allowed,
    maxLines: clampInt(source.maxLines, 1, 200, DEFAULT_CODE_APPLICATION_SETTINGS.maxLines),
    countsAsHint: typeof source.countsAsHint === "boolean"
      ? source.countsAsHint
      : DEFAULT_CODE_APPLICATION_SETTINGS.countsAsHint,
    requireConfirmation: typeof source.requireConfirmation === "boolean"
      ? source.requireConfirmation
      : DEFAULT_CODE_APPLICATION_SETTINGS.requireConfirmation,
  };
}

/** Mezcla un PUT parcial con lo guardado antes de normalizar. */
export function mergeCodeApplicationSettings(
  current: CodeApplicationSettings | undefined,
  patch: Partial<CodeApplicationSettings> | undefined,
): CodeApplicationSettings {
  return normalizeCodeApplicationSettings({ ...(current || {}), ...(patch || {}) });
}

/** Politica minima para cuando no hay docente en la base (pruebas, demo). */
export function describePolicyForPrompt(policy: TeacherPolicy) {
  return {
    name: policy.policyName,
    strictNoSolution: policy.strictNoSolution,
    maxHintsPerExercise: policy.maxHintsPerExercise,
    codeApplication: policy.codeApplication,
  };
}
