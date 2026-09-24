import { readFileSync } from "node:fs";
import path from "node:path";
import type { PolicyEventType, RagContextItem } from "../types/app.js";

/**
 * Matriz escenario/politica -> recurso autorizado sugerido (A8.6).
 * Vive en data/rag/matriz-escenario-recurso.json para que el docente pueda
 * ajustarla sin tocar codigo. El motor la usa para poner primero, entre las
 * fuentes RAG ya encontradas, las que la matriz recomienda para el evento.
 */

export type ScenarioResource = { id: string; titulo: string };

export type ScenarioRule = {
  escenario: string;
  eventos: string[];
  tema: string;
  palabras: string[];
  recursos: ScenarioResource[];
};

type ScenarioMatrix = { version: string; reglas: ScenarioRule[] };

const MATRIX_PATH = path.resolve(process.cwd(), "data/rag/matriz-escenario-recurso.json");
let cachedMatrix: ScenarioMatrix | null = null;

export function loadScenarioMatrix(): ScenarioMatrix {
  if (cachedMatrix) return cachedMatrix;
  try {
    const parsed = JSON.parse(readFileSync(MATRIX_PATH, "utf8")) as ScenarioMatrix;
    cachedMatrix = { version: String(parsed.version || ""), reglas: Array.isArray(parsed.reglas) ? parsed.reglas : [] };
  } catch {
    cachedMatrix = { version: "", reglas: [] };
  }
  return cachedMatrix;
}

function normalize(text: unknown) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Reglas que aplican a un evento y un texto: primero las que coinciden por
 * palabra; si ninguna coincide, las del evento sin palabras (escenario S5).
 */
export function matchScenarioRules(eventType: PolicyEventType | string, text: string, matrix = loadScenarioMatrix()) {
  const haystack = normalize(text);
  const forEvent = matrix.reglas.filter((rule) => rule.eventos.includes(eventType));
  const byWords = forEvent.filter((rule) => rule.palabras.some((word) => haystack.includes(normalize(word))));
  if (byWords.length) return byWords;
  return forEvent.filter((rule) => rule.palabras.length === 0);
}

function itemMatchesResource(item: RagContextItem, resource: ScenarioResource) {
  const metadataId = normalize((item.metadata as Record<string, unknown> | undefined)?.id);
  if (metadataId && metadataId === normalize(resource.id)) return true;
  const title = normalize(item.title);
  const wanted = normalize(resource.titulo);
  return Boolean(title) && (title === wanted || title.startsWith(wanted) || wanted.startsWith(title));
}

/**
 * Reordena las fuentes RAG: primero las recomendadas por la matriz (en el
 * orden de la matriz), luego el resto en su orden original. No agrega ni
 * quita fuentes: solo cambia la prioridad.
 */
export function prioritizeRagSourcesForScenario<T extends RagContextItem>(
  items: T[],
  eventType: PolicyEventType | string,
  text: string,
  matrix = loadScenarioMatrix(),
) {
  const rules = matchScenarioRules(eventType, text, matrix);
  const resources = rules.flatMap((rule) => rule.recursos);
  if (!resources.length || !items.length) {
    return { items, rules, recommended: resources };
  }
  const picked: T[] = [];
  const pickedIds = new Set<string>();
  for (const resource of resources) {
    for (const item of items) {
      if (!pickedIds.has(item.id) && itemMatchesResource(item, resource)) {
        picked.push(item);
        pickedIds.add(item.id);
      }
    }
  }
  const rest = items.filter((item) => !pickedIds.has(item.id));
  return { items: [...picked, ...rest], rules, recommended: resources };
}

export function resetScenarioMatrixCacheForTests() {
  cachedMatrix = null;
}
