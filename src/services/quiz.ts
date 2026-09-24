import { runTextByMode } from "./agent-mode.js";
import { trimText } from "./text-utils.js";

/**
 * Mini quiz de comprension.
 *
 * Despues de aceptar una sugerencia (o cuando el docente lanza uno para la
 * clase) el estudiante recibe UNA pregunta de opcion multiple sobre el cambio.
 * Si falla, una pregunta abierta corta para que explique con sus palabras,
 * calificada por el modelo. Aqui vive lo que no depende de HTTP ni de la base
 * de datos: ajustes por defecto, prompts, parseo y calificacion.
 */

export {
  DEFAULT_QUIZ_SETTINGS,
  normalizeQuizSettings,
  QUIZ_SESSION_WINDOW_MS,
  QUIZ_TRIGGERS,
} from "./quiz-settings.js";

// ---------------------------------------------------------------------------
// Modelo: inyectable para las pruebas (no hay Ollama en CI).
// ---------------------------------------------------------------------------

export type QuizModelRunner = (prompt: string) => Promise<string>;

const defaultRunner: QuizModelRunner = (prompt) => runTextByMode(prompt, { route: "quiz", source: "quiz" });
let activeRunner: QuizModelRunner = defaultRunner;

export function setQuizModelRunnerForTests(runner: QuizModelRunner | null) {
  activeRunner = runner || defaultRunner;
}

/** Saca el primer objeto JSON de la salida del modelo (con o sin ```json). */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = String(text || "")
    .replace(/```(?:json)?/gi, "")
    .trim();
  const candidates = [cleaned];
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(cleaned.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // se prueba el siguiente candidato
    }
  }
  return null;
}

function cut(value: unknown, max: number) {
  const text = trimText(value).replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------------------------------------------------------------------------
// Generacion
// ---------------------------------------------------------------------------

export type GeneratedQuiz = {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  followupQuestion: string;
  topic: string;
};

export type QuizCodeContext = {
  filePath: string;
  language: string;
  applyMode: "insert" | "replace" | "delete";
  originalCode: string;
  newCode: string;
  suggestionText: string;
};

const JSON_SHAPE =
  '{"question":"...","options":["...","...","...","..."],"correct_index":0,"explanation":"...","followup_question":"...","topic":"..."}';

function codeBlock(language: string, code: string, max = 2500) {
  const body = String(code || "").slice(0, max);
  return body.trim() ? `\`\`\`${language}\n${body}\n\`\`\`` : "(vacio)";
}

export function buildAfterAcceptQuizPrompt(context: QuizCodeContext, ragBlock = "") {
  const accion = context.applyMode === "delete"
    ? "eliminar codigo"
    : context.applyMode === "replace"
      ? "modificar codigo"
      : "insertar codigo";
  return [
    "Eres ADACEEN, tutor de programacion para estudiantes universitarios de primeros semestres.",
    "El estudiante acaba de aceptar un cambio sugerido en su codigo. Escribe UNA pregunta de opcion multiple",
    "que compruebe si entiende POR QUE el cambio es correcto o QUE hace. No preguntes sintaxis memorizada.",
    "",
    "Reglas:",
    "- Espanol claro y breve.",
    "- Exactamente 4 opciones; solo una correcta. Las incorrectas son errores de comprension plausibles.",
    "- No copies el codigo completo en la pregunta; puedes nombrar un identificador.",
    "- explanation: 1 o 2 frases que expliquen la respuesta correcta.",
    "- followup_question: una pregunta abierta corta para que el estudiante explique el concepto clave con sus palabras.",
    "- topic: el concepto evaluado en 2 a 5 palabras.",
    "Devuelve SOLO JSON valido, sin markdown ni texto adicional, con esta forma:",
    JSON_SHAPE,
    "",
    `Archivo: ${context.filePath || "(sin nombre)"} (${context.language || "codigo"})`,
    `Accion aplicada: ${accion}`,
    `Recomendacion que recibio: ${cut(context.suggestionText, 600) || "(sin texto)"}`,
    "Codigo antes (o contexto):",
    codeBlock(context.language, context.originalCode),
    context.applyMode === "delete" ? "Codigo eliminado: el de arriba." : "Codigo nuevo:",
    context.applyMode === "delete" ? "" : codeBlock(context.language, context.newCode),
    ragBlock ? `\nMaterial del curso (usalo si aplica):\n${ragBlock}` : "",
  ].filter((line) => line !== "").join("\n");
}

export function buildTopicQuizPrompt(topic: string, courseCode: string, ragBlock = "") {
  return [
    "Eres ADACEEN, tutor de programacion para estudiantes universitarios de primeros semestres.",
    `El docente quiere comprobar la comprension del tema: "${cut(topic, 300)}"${courseCode ? ` (curso ${courseCode})` : ""}.`,
    "Escribe UNA pregunta de opcion multiple de comprension (no de memoria).",
    "",
    "Reglas:",
    "- Espanol claro y breve.",
    "- Exactamente 4 opciones; solo una correcta. Las incorrectas son errores de comprension plausibles.",
    "- explanation: 1 o 2 frases que expliquen la respuesta correcta.",
    "- followup_question: una pregunta abierta corta para que el estudiante explique el concepto con sus palabras.",
    "- topic: el concepto evaluado en 2 a 5 palabras.",
    "Devuelve SOLO JSON valido, sin markdown ni texto adicional, con esta forma:",
    JSON_SHAPE,
    ragBlock ? `\nMaterial del curso (usalo si aplica):\n${ragBlock}` : "",
  ].filter((line) => line !== "").join("\n");
}

/** Baraja las opciones y recalcula el indice correcto (los modelos tienden a poner la correcta primero). */
export function shuffleQuizOptions(quiz: GeneratedQuiz, random: () => number = Math.random): GeneratedQuiz {
  const indexed = quiz.options.map((option, index) => ({ option, correct: index === quiz.correctIndex }));
  for (let i = indexed.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [indexed[i], indexed[j]] = [indexed[j], indexed[i]];
  }
  return {
    ...quiz,
    options: indexed.map((item) => item.option),
    correctIndex: indexed.findIndex((item) => item.correct),
  };
}

export function parseGeneratedQuiz(text: string): GeneratedQuiz | null {
  const data = extractJsonObject(text);
  if (!data) return null;

  const question = cut(data.question, 400);
  const rawOptions = Array.isArray(data.options) ? data.options : [];
  const options = rawOptions.map((option) => cut(option, 220)).filter(Boolean);
  const uniqueOptions = new Set(options.map((option) => option.toLowerCase()));
  const correctIndex = Number(data.correct_index ?? data.correctIndex);

  if (!question || options.length < 3 || options.length > 5 || uniqueOptions.size !== options.length) {
    return null;
  }
  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
    return null;
  }

  return {
    question,
    options,
    correctIndex,
    explanation: cut(data.explanation, 600),
    followupQuestion: cut(data.followup_question ?? data.followupQuestion, 300)
      || "Explica con tus palabras que hace este cambio y por que es necesario.",
    topic: cut(data.topic, 80),
  };
}

export async function generateQuizFromPrompt(prompt: string): Promise<{ quiz: GeneratedQuiz | null; error: string }> {
  let output = "";
  try {
    output = await activeRunner(prompt);
  } catch (error) {
    return { quiz: null, error: error instanceof Error ? error.message : String(error) };
  }
  const parsed = parseGeneratedQuiz(output);
  if (!parsed) {
    return { quiz: null, error: "El modelo no devolvio una pregunta valida." };
  }
  return { quiz: shuffleQuizOptions(parsed), error: "" };
}

// ---------------------------------------------------------------------------
// Calificacion de la respuesta abierta
// ---------------------------------------------------------------------------

export type FollowUpGrade = { score: number | null; feedback: string };

export function buildFollowUpGradingPrompt(input: {
  question: string;
  correctOption: string;
  explanation: string;
  followupQuestion: string;
  answer: string;
}) {
  return [
    "Eres ADACEEN, tutor de programacion. Califica la explicacion de un estudiante que fallo una pregunta.",
    "Evalua si entendio el concepto, no la redaccion. Se amable y concreto.",
    "Devuelve SOLO JSON valido, sin markdown: {\"score\": 0, \"feedback\": \"...\"}",
    "- score: entero de 0 a 100.",
    "- feedback: 1 o 2 frases; di que estuvo bien y que falto. No escribas codigo completo.",
    "",
    `Pregunta de opcion multiple: ${cut(input.question, 400)}`,
    `Respuesta correcta: ${cut(input.correctOption, 220)}`,
    `Explicacion de referencia: ${cut(input.explanation, 600) || "(no hay)"}`,
    `Pregunta abierta: ${cut(input.followupQuestion, 300)}`,
    `Respuesta del estudiante: ${cut(input.answer, 2000)}`,
  ].join("\n");
}

export function parseFollowUpGrade(text: string): FollowUpGrade | null {
  const data = extractJsonObject(text);
  if (!data) return null;
  const score = Number(data.score);
  const feedback = cut(data.feedback, 500);
  if (!Number.isFinite(score) || !feedback) return null;
  return { score: Math.min(100, Math.max(0, Math.round(score))), feedback };
}

export async function gradeFollowUp(prompt: string): Promise<FollowUpGrade> {
  try {
    const parsed = parseFollowUpGrade(await activeRunner(prompt));
    if (parsed) return parsed;
  } catch {
    // cae al mensaje de respaldo
  }
  return {
    score: null,
    feedback: "Tu respuesta quedo guardada. No pude calificarla ahora; tu docente podra revisarla.",
  };
}
