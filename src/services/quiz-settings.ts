import type { QuizSettings, QuizTrigger } from "../types/app.js";

/**
 * Ajustes del mini quiz que el docente parametriza en su politica.
 * Modulo puro (sin modelo ni red) para que la base de datos pueda
 * normalizarlos al leer la politica sin arrastrar dependencias.
 */

export const QUIZ_TRIGGERS: QuizTrigger[] = ["after_accept", "teacher_launch"];

export const DEFAULT_QUIZ_SETTINGS: QuizSettings = {
  triggers: ["after_accept", "teacher_launch"],
  everyNAccepts: 1,
  maxPerSession: 5,
  followUpOnWrong: true,
};

/** Ventana que se considera "una sesion" para el limite por sesion. */
export const QUIZ_SESSION_WINDOW_MS = 12 * 60 * 60 * 1000;

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/** Lo que venga de la base (jsonb vacio, parcial o viejo) sale completo y valido. */
export function normalizeQuizSettings(raw: unknown): QuizSettings {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const triggers = Array.isArray(source.triggers)
    ? QUIZ_TRIGGERS.filter((trigger) => (source.triggers as unknown[]).includes(trigger))
    : DEFAULT_QUIZ_SETTINGS.triggers;
  const maxPerSession = source.maxPerSession === null
    ? null
    : clampInt(source.maxPerSession, 1, 50, DEFAULT_QUIZ_SETTINGS.maxPerSession ?? 5);
  return {
    triggers,
    everyNAccepts: clampInt(source.everyNAccepts, 1, 20, DEFAULT_QUIZ_SETTINGS.everyNAccepts),
    maxPerSession,
    followUpOnWrong: typeof source.followUpOnWrong === "boolean"
      ? source.followUpOnWrong
      : DEFAULT_QUIZ_SETTINGS.followUpOnWrong,
  };
}
