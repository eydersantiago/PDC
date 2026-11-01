// ADACEEN: como se le pide el texto al modelo (perfil de generacion y mensaje de sistema).
//
// Revision de precision del 21/10/2026. Antes cada pedido iba envuelto en un agente generico
// («Copiloto de Aprendizaje»: explica complejidad, riesgos y «un ejemplo minimo»; responde
// SIEMPRE en Markdown con 1) Resumen 2) recomendaciones 3) Riesgos) que contradecia el formato
// que pide cada prompt (secciones con la linea «Aplicar:» y un bloque de codigo, o JSON), sin
// temperatura (Ollama usa 0.8) y con la ventana de contexto por defecto de Ollama, que corta en
// silencio el comienzo de un prompt largo, justo donde van las reglas del formato.
//
// Ahora: un mensaje de sistema corto que no compite con el prompt, un perfil por tipo de pedido
// (temperatura, tope de salida, JSON) y una ventana de contexto explicita (MODEL_NUM_CTX).

export type TextGenerationProfile = "editor" | "json" | "json_strict" | "creative" | "default";

export type TextGenerationOptions = {
  profile?: TextGenerationProfile;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** La salida debe ser un objeto JSON (Ollama format "json" / response_format json_object). */
  json?: boolean;
};

export type ResolvedTextGeneration = {
  profile: TextGenerationProfile;
  temperature: number;
  topP: number;
  topK: number;
  repeatPenalty: number;
  maxTokens: number;
  json: boolean;
  numCtx: number;
  /** Semilla fija (MODEL_SEED) para corridas de evaluacion reproducibles; null fuera de ellas. */
  seed: number | null;
};

/**
 * Perfiles:
 *  - editor: sugerencias de VS Code (pista y codigo para aplicar). Temperatura baja: el codigo
 *    tiene que calzar con el del estudiante, no variar en cada pedido.
 *  - json: respuestas en JSON del tutor del navegador y del contexto del proyecto.
 *  - json_strict: calificar o clasificar (el mismo texto debe dar el mismo resultado).
 *  - creative: generar preguntas de quiz (algo de variedad entre quices).
 *  - default: el resto (resumen del archivo, pestaña del navegador).
 */
// top_p 0.8, top_k 20 y repeat_penalty 1.05 son los valores que Qwen publica para
// Qwen2.5-Coder (generation_config.json); la temperatura baja es la que usan los asistentes de
// codigo para editar (Aider usa 0). Sin temperatura, la API de Ollama compatible con OpenAI
// usaba 1.0 (openai/openai.go), no la del modelo.
const PROFILES: Record<TextGenerationProfile, Omit<ResolvedTextGeneration, "profile" | "numCtx" | "seed">> = {
  editor: { temperature: 0.2, topP: 0.8, topK: 20, repeatPenalty: 1.05, maxTokens: 1000, json: false },
  json: { temperature: 0.2, topP: 0.8, topK: 20, repeatPenalty: 1.05, maxTokens: 1200, json: true },
  json_strict: { temperature: 0, topP: 1, topK: 20, repeatPenalty: 1.0, maxTokens: 500, json: true },
  creative: { temperature: 0.6, topP: 0.8, topK: 20, repeatPenalty: 1.05, maxTokens: 1600, json: true },
  default: { temperature: 0.3, topP: 0.8, topK: 20, repeatPenalty: 1.05, maxTokens: 1200, json: false },
};

/**
 * Semilla fija solo si MODEL_SEED esta definida (corridas de evaluacion de la tesis). En uso
 * normal no se fija: «Otra sugerencia» tiene que poder dar otra respuesta.
 */
export function modelSeed() {
  const raw = String(process.env.MODEL_SEED ?? "").trim();
  if (!raw) return null;
  const value = Math.floor(Number(raw));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Ventana de contexto que se le pide al modelo (tokens). El prompt del backend se ajusta a ella. */
export function modelNumCtx() {
  const value = Math.floor(Number(process.env.MODEL_NUM_CTX));
  return Number.isFinite(value) && value >= 2048 ? Math.min(value, 131072) : 8192;
}

function clamp(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

/** Solo los perfiles definidos ("constructor" o "toString" no son perfiles: revision independiente). */
function isProfile(value: unknown): value is TextGenerationProfile {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PROFILES, value);
}

export function resolveTextGeneration(options: TextGenerationOptions = {}): ResolvedTextGeneration {
  const profile: TextGenerationProfile = isProfile(options.profile) ? options.profile : "default";
  const base = PROFILES[profile];
  return {
    profile,
    temperature: clamp(options.temperature, 0, 2, base.temperature),
    topP: clamp(options.topP, 0.05, 1, base.topP),
    topK: base.topK,
    repeatPenalty: base.repeatPenalty,
    maxTokens: Math.round(clamp(options.maxTokens, 64, 8192, base.maxTokens)),
    json: typeof options.json === "boolean" ? options.json : base.json,
    numCtx: modelNumCtx(),
    seed: modelSeed(),
  };
}

/** Lo que viaja en el job de la cola (sin numCtx: lo decide el worker con su MODEL_NUM_CTX). */
export function serializableGeneration(options: TextGenerationOptions | undefined) {
  if (!options) return undefined;
  const out: TextGenerationOptions = {};
  if (isProfile(options.profile)) out.profile = options.profile;
  if (Number.isFinite(Number(options.temperature))) out.temperature = Number(options.temperature);
  if (Number.isFinite(Number(options.topP))) out.topP = Number(options.topP);
  if (Number.isFinite(Number(options.maxTokens))) out.maxTokens = Math.round(Number(options.maxTokens));
  if (typeof options.json === "boolean") out.json = options.json;
  return Object.keys(out).length ? out : undefined;
}

/**
 * Mensaje de sistema: corto y sin formato propio, para no competir con el del prompt (antes el
 * agente pedia otro formato y el modelo mezclaba los dos).
 */
export const ADACEEN_SYSTEM_PROMPT = [
  "Eres ADACEEN, tutor de programacion de la Universidad del Valle.",
  "Sigue exactamente las instrucciones y el formato que pide el mensaje (Markdown o JSON).",
  "Responde en espanol. No inventes codigo, archivos, lineas ni datos que no esten en el contexto.",
].join(" ");

/**
 * Caracteres de prompt que caben en la ventana de contexto dejando lugar a la respuesta. Para
 * codigo y espanol se cuentan unos 3 caracteres por token (conservador: el codigo con simbolos
 * da menos caracteres por token que el texto).
 */
export function promptBudgetChars(numCtx = modelNumCtx(), reservedOutputTokens = 1100) {
  return Math.max(6000, Math.floor((numCtx - reservedOutputTokens) * 3));
}
