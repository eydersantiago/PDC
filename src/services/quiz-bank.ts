import { readFileSync } from "node:fs";
import path from "node:path";
import { shuffleQuizOptions, type GeneratedQuiz } from "./quiz.js";

/**
 * Banco de respaldo del mini-quiz (A8.5): data/quiz/banco-fpoo.json.
 *
 * El mini-quiz normal lo genera el modelo (src/services/quiz.ts). Si el
 * modelo no esta disponible (worker de GPU apagado o desalojado) o no
 * devuelve una pregunta valida, se toma una pregunta validada del banco,
 * elegida por las palabras del contexto. Asi el quiz no depende de la GPU y
 * no inventa: todas las preguntas del banco estan revisadas.
 */

export type QuizBankItem = {
  id: string;
  ra: string;
  tema: string;
  lenguaje: string;
  palabras: string[];
  pregunta: string;
  opciones: string[];
  correcta: number;
  explicacion: string;
  abierta: string;
};

const BANK_PATH = path.resolve(process.cwd(), "data/quiz/banco-fpoo.json");
let cachedItems: QuizBankItem[] | null = null;

export function loadQuizBank(): QuizBankItem[] {
  if (cachedItems) return cachedItems;
  try {
    const parsed = JSON.parse(readFileSync(BANK_PATH, "utf8")) as { items?: QuizBankItem[] };
    cachedItems = (Array.isArray(parsed.items) ? parsed.items : []).filter((item) =>
      item
      && typeof item.pregunta === "string"
      && Array.isArray(item.opciones)
      && item.opciones.length >= 3
      && Number.isInteger(item.correcta)
      && item.correcta >= 0
      && item.correcta < item.opciones.length);
  } catch {
    cachedItems = [];
  }
  return cachedItems;
}

function normalize(text: unknown) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

const LANGUAGE_ALIASES: Record<string, string> = {
  "c++": "cpp",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  h: "cpp",
  hpp: "cpp",
  py: "python",
  python: "python",
};

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Las palabras de 1 a 3 letras (if, new) y las frases (es un, tiene un) se
 * buscan como palabra completa para que "if" no coincida dentro de
 * "verificar"; las raices (encapsul, polimorf) y los simbolos (&, int&) se
 * buscan como subcadena.
 */
function containsWord(haystack: string, word: string) {
  const clean = normalize(word).trim();
  if (!clean) return false;
  if (/^[a-z0-9]{1,3}$/.test(clean) || /^[a-z0-9]+( [a-z0-9]+)+$/.test(clean)) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(clean)}([^a-z0-9]|$)`).test(haystack);
  }
  return haystack.includes(clean);
}

/** Puntaje de un item: palabras que aparecen en el contexto y lenguaje compatible. */
export function scoreQuizBankItem(item: QuizBankItem, text: string, language = "") {
  const haystack = normalize(text);
  const lang = LANGUAGE_ALIASES[normalize(language)] || normalize(language);
  if (item.lenguaje && lang && item.lenguaje !== lang) return -1;
  let score = 0;
  for (const word of item.palabras) {
    if (containsWord(haystack, word)) score += 2;
  }
  if (haystack.includes(normalize(item.tema))) score += 3;
  if (haystack.includes(normalize(item.ra))) score += 1;
  return score;
}

/**
 * Pregunta del banco para un contexto. Entre las de mayor puntaje elige al
 * azar; si ninguna coincide, cualquiera compatible con el lenguaje. Las
 * opciones salen barajadas igual que las del modelo.
 */
export function pickQuizFromBank(
  context: { text: string; language?: string; excludeIds?: string[] },
  random: () => number = Math.random,
): (GeneratedQuiz & { bankId: string }) | null {
  const exclude = new Set(context.excludeIds || []);
  const candidates = loadQuizBank()
    .filter((item) => !exclude.has(item.id))
    .map((item) => ({ item, score: scoreQuizBankItem(item, context.text, context.language) }))
    .filter((entry) => entry.score >= 0);
  if (!candidates.length) return null;
  const best = Math.max(...candidates.map((entry) => entry.score));
  const pool = candidates.filter((entry) => entry.score === best);
  const chosen = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))].item;
  const quiz = shuffleQuizOptions({
    question: chosen.pregunta,
    options: [...chosen.opciones],
    correctIndex: chosen.correcta,
    explanation: chosen.explicacion,
    followupQuestion: chosen.abierta,
    topic: `banco ${chosen.ra}: ${chosen.tema}`,
  }, random);
  return { ...quiz, bankId: chosen.id };
}

export function resetQuizBankCacheForTests() {
  cachedItems = null;
}
