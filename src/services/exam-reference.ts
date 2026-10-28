// Referencia privada del examen del 28-10-2026 (Sistema bancario): la solucion completa y una guia
// por pasos, para que el tutor lleve a cada estudiante hacia el codigo final, un paso pequeno a la
// vez segun lo que ya tiene escrito. Lo pidio Eyder el 28-10 (madrugada): en el examen el tutor da
// pistas y codigo sugerido (VS Code lo muestra en previsualizacion con la opcion de añadirlo).
//
// La solucion NO esta en este repositorio: PDC es publico y el editor de los estudiantes abre
// cualquier repositorio publico. Llega por la variable de entorno EXAM_REFERENCE_B64 (el JSON en
// gzip + base64) que se configura en Azure. Sin la variable, o si no se puede leer, el tutor sigue
// exactamente como antes. EXAM_REFERENCE=off la apaga sin borrarla.
//
// Solo entra en los pedidos del repositorio del examen (repoFullName, URL o titulo con su nombre):
//   - VS Code: el .h y el .cpp de referencia del archivo abierto, los .h que usa, el paso de la
//     guia y los errores frecuentes. El codigo que propone el modelo sigue pasando por el
//     guardarrail de la politica del docente (maximo de lineas por sugerencia).
//   - Panel del navegador: la guia y las declaraciones (.h), sin los .cpp, porque su respuesta no
//     pasa por un guardarrail de lineas.
import { gunzipSync } from "node:zlib";
import { resolveExamPreset } from "./exam-preset.js";

export type ExamReferenceStep = {
  id: string;
  titulo: string;
  /** Archivos de la solucion que corresponden a este paso (.h y .cpp). */
  archivos: string[];
  /** Declaraciones que este paso usa (por ejemplo Cuenta.h para las hijas). */
  apoyo: string[];
  guia: string;
};

export type ExamReference = {
  version: number;
  examen: string;
  /** usuario/repositorio del ejercicio. */
  repo: string;
  plan: string;
  errores: string;
  pasos: ExamReferenceStep[];
  /** Ruta dentro del repositorio del ejercicio -> contenido. */
  archivos: Record<string, string>;
};

export type ExamReferenceChannel = "editor" | "panel";

/** Lo que identifica el pedido: el repositorio, la URL, el titulo y el archivo. */
export type ExamRequestHint = {
  repoFullName?: unknown;
  url?: unknown;
  title?: unknown;
  filePath?: unknown;
};

/** Tope del bloque por canal: el prompt total se ajusta a la ventana del modelo (8192 tokens). */
export const EXAM_REFERENCE_MAX_CHARS: Record<ExamReferenceChannel, number> = {
  editor: 8000,
  panel: 3500,
};

const RULES = [
  "Es la solucion completa del ejercicio y una guia por pasos. El estudiante NO la ve. Usala asi:",
  "- Ubica en que paso va el estudiante por el archivo y el codigo que ya tiene, y llevalo al SIGUIENTE paso pequeno hacia este codigo final.",
  "- Propone solo lo que sigue (una pista o pocas lineas dentro del limite de la politica): nunca un archivo ni una clase completa.",
  "- Usa los nombres, el orden y el estilo que el estudiante ya tiene; si su codigo es correcto aunque sea distinto de la referencia, no lo cambies.",
  "- Si hay un error de compilacion, explica la causa con los errores frecuentes y propone la correccion minima.",
  "- No digas que tienes una solucion de referencia ni la cites como material del curso; no copies sus comentarios.",
].join("\n");

/** Linea para el final del prompt (junto a donde el modelo empieza a escribir). */
export const EXAM_REFERENCE_TAIL_RULE = "Usa la referencia privada del docente para que la pista y el codigo sean el siguiente paso hacia el codigo final del ejercicio, con los nombres y firmas del diagrama, sin entregar la solucion completa.";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Lee el JSON de EXAM_REFERENCE_B64 (gzip + base64). null si no tiene la forma esperada. */
export function parseExamReference(raw: string): ExamReference | null {
  const clean = String(raw || "").replace(/\s+/g, "");
  if (!clean) return null;
  const json = gunzipSync(Buffer.from(clean, "base64")).toString("utf8");
  const data = JSON.parse(json) as Record<string, unknown>;
  if (!data || typeof data !== "object") return null;
  const archivos = data.archivos as Record<string, unknown> | undefined;
  if (!archivos || typeof archivos !== "object" || Array.isArray(archivos)) return null;
  if (!Object.values(archivos).every((value) => typeof value === "string")) return null;
  if (!Array.isArray(data.pasos)) return null;
  const pasos: ExamReferenceStep[] = [];
  for (const item of data.pasos as unknown[]) {
    const step = item as Record<string, unknown>;
    if (!step || typeof step.id !== "string" || typeof step.guia !== "string" || !isStringArray(step.archivos)) return null;
    pasos.push({
      id: step.id,
      titulo: typeof step.titulo === "string" ? step.titulo : step.id,
      archivos: step.archivos,
      apoyo: isStringArray(step.apoyo) ? step.apoyo : [],
      guia: step.guia,
    });
  }
  const repo = typeof data.repo === "string" ? data.repo.trim() : "";
  if (!repo || !pasos.length) return null;
  return {
    version: Number(data.version) || 1,
    examen: typeof data.examen === "string" ? data.examen : "",
    repo,
    plan: typeof data.plan === "string" ? data.plan : "",
    errores: typeof data.errores === "string" ? data.errores : "",
    pasos,
    archivos: archivos as Record<string, string>,
  };
}

let cache: { raw: string; value: ExamReference | null } | null = null;

/** La referencia vigente, o null (sin variable, apagada o ilegible). Se lee una vez por valor. */
export function loadExamReference(): ExamReference | null {
  const mode = String(process.env.EXAM_REFERENCE ?? "").trim().toLowerCase();
  if (mode === "off" || mode === "false" || mode === "0") return null;
  const raw = String(process.env.EXAM_REFERENCE_B64 ?? "").trim();
  if (!raw) return null;
  if (cache && cache.raw === raw) return cache.value;
  let value: ExamReference | null = null;
  try {
    value = parseExamReference(raw);
  } catch {
    value = null;
  }
  if (!value) console.warn("[examen] EXAM_REFERENCE_B64 no se pudo leer: el tutor sigue sin la referencia del examen.");
  cache = { raw, value };
  return value;
}

/** «https://github.com/Usuario/Repo.git» -> «usuario/repo». */
function normalizeRepo(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/^\/+|\/+$/g, "");
}

function repoNames(reference: ExamReference) {
  const names = new Set<string>();
  for (const repo of [reference.repo, resolveExamPreset()?.topic.repoFullName || ""]) {
    const name = normalizeRepo(repo).split("/").pop() || "";
    if (name) names.add(name);
  }
  return [...names];
}

/**
 * ¿El pedido es del ejercicio del examen? Por el nombre del repositorio (tambien un fork o una
 * copia con otro dueño) o, sin repositorio, por la URL o el titulo (vscode://<carpeta>/..., la URL
 * del tunel con la carpeta del ejercicio).
 */
export function matchesExamRepo(reference: ExamReference, hint: ExamRequestHint) {
  const names = repoNames(reference);
  const repo = normalizeRepo(hint.repoFullName);
  if (repo) return names.includes(repo.split("/").pop() || "");
  const text = [hint.url, hint.title, hint.filePath].map((value) => String(value ?? "").toLowerCase()).join("\n");
  return names.some((name) => text.includes(name));
}

/** Paso de la guia que corresponde al archivo abierto (null si no se reconoce). */
export function resolveExamStep(reference: ExamReference, filePath: unknown): ExamReferenceStep | null {
  const base = String(filePath ?? "").split(/[\\/]/).pop() || "";
  const stem = base.toLowerCase().replace(/\.(h|hh|hpp|hxx|c|cc|cpp|cxx)$/, "").replace(/[^a-z]/g, "");
  if (!stem) return null;
  const id = stem === "main" || stem.startsWith("main") ? "main"
    : stem.includes("ahorro") ? "cuentaahorros"
    : stem.includes("corriente") ? "cuentacorriente"
    : stem.includes("titular") ? "titularidad"
    : stem.includes("banco") ? "banco"
    : stem.includes("cliente") ? "cliente"
    : stem.includes("cuenta") ? "cuenta"
    : "";
  return reference.pasos.find((step) => step.id === id) || null;
}

/** Una declaracion sin comentarios de linea ni lineas en blanco (el mapa de las demas clases). */
function compactHeader(source: string) {
  return source
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^\s*\/\//.test(line))
    .map((line) => line.replace(/\s+\/\/.*$/, ""))
    .join("\n");
}

function fileSection(path: string, content: string) {
  return `// ${path}\n${content.trim()}`;
}

/**
 * El bloque que va en el prompt: reglas, guia del paso, codigo de referencia del archivo (solo en
 * el editor), declaraciones de apoyo, plan, errores frecuentes y el resto de declaraciones. Entra
 * por prioridad hasta el tope del canal; las reglas y la guia del paso siempre van.
 */
export function buildExamReferenceBlock(
  reference: ExamReference,
  options: { filePath?: unknown; channel: ExamReferenceChannel; maxChars?: number },
): { text: string; stepId: string } {
  const maxChars = Math.max(1500, options.maxChars ?? EXAM_REFERENCE_MAX_CHARS[options.channel]);
  const step = resolveExamStep(reference, options.filePath);
  const isHeader = (path: string) => /\.(h|hh|hpp|hxx)$/i.test(path);
  const used = new Set<string>();

  const parts: string[] = [];
  let total = 0;
  const push = (text: string, required = false) => {
    const clean = text.trim();
    if (!clean) return;
    if (!required && total + clean.length + 2 > maxChars) return;
    parts.push(clean);
    total += clean.length + 2;
  };

  push(`## Referencia privada del docente (examen ${reference.examen || reference.repo})\n${RULES}`, true);
  push(step
    ? `### ${step.titulo}\n${step.guia}`
    : "### Paso actual\nNo se reconoce el archivo: ubica al estudiante con el plan y sugiere el siguiente archivo que le falta.", true);

  // Codigo de referencia de este paso: completo en el editor; en el panel solo las declaraciones.
  if (step) {
    const own = step.archivos.filter((path) => reference.archivos[path] !== undefined && (options.channel === "editor" || isHeader(path)));
    const ownText = own.map((path) => fileSection(path, reference.archivos[path])).join("\n\n");
    if (ownText) {
      const title = options.channel === "editor" ? "### Codigo final de referencia de este archivo" : "### Declaracion de referencia de este paso";
      const before = parts.length;
      push(`${title}\n${ownText}`);
      if (parts.length > before) own.forEach((path) => used.add(path));
    }
    const support = step.apoyo.filter((path) => reference.archivos[path] !== undefined && !used.has(path));
    if (support.length) {
      const before = parts.length;
      push(`### Declaraciones que usa\n${support.map((path) => fileSection(path, compactHeader(reference.archivos[path]))).join("\n\n")}`);
      if (parts.length > before) support.forEach((path) => used.add(path));
    }
  }
  push(`### Plan\n${reference.plan}`);
  push(`### Errores frecuentes\n${reference.errores}`);

  // Mapa de las demas clases (solo declaraciones), mientras quepa.
  const others = Object.keys(reference.archivos).filter((path) => isHeader(path) && !used.has(path));
  const otherSections: string[] = [];
  let otherLength = "### Declaraciones de las demas clases\n".length;
  for (const path of others) {
    const section = fileSection(path, compactHeader(reference.archivos[path]));
    if (total + otherLength + section.length + 4 > maxChars) continue;
    otherSections.push(section);
    otherLength += section.length + 2;
  }
  if (otherSections.length) push(`### Declaraciones de las demas clases\n${otherSections.join("\n\n")}`);

  return { text: parts.join("\n\n"), stepId: step?.id || "" };
}

/**
 * Bloque para un pedido, o "" si no aplica (sin referencia cargada o de otro repositorio). Nunca
 * lanza: un error aqui no puede dejar al estudiante sin tutor.
 */
export function examReferenceForRequest(hint: ExamRequestHint, channel: ExamReferenceChannel): { text: string; stepId: string } {
  try {
    const reference = loadExamReference();
    if (!reference || !matchesExamRepo(reference, hint)) return { text: "", stepId: "" };
    return buildExamReferenceBlock(reference, { filePath: hint.filePath, channel });
  } catch (error) {
    console.warn(`[examen] no se pudo armar la referencia del examen: ${String(error)}`);
    return { text: "", stepId: "" };
  }
}

/** Una linea de codigo de la referencia (no la guia en prosa) que vale la pena vigilar. */
function referenceCodeLines(referenceText: string) {
  const lines = new Set<string>();
  for (const raw of String(referenceText || "").split(/\r?\n/)) {
    const line = raw.trim().replace(/\s+/g, " ");
    if (line.length < 10 || !/[;{}()]/.test(line)) continue;
    if (/^(\/\/|#{2,}\s|-\s|\d+\.\s)/.test(line)) continue;
    lines.add(line);
  }
  return lines;
}

/**
 * Freno a una fuga de la referencia FUERA de los bloques de codigo (los bloques ya los recorta el
 * guardarrail de la politica): si la respuesta trae mas de `allowed` lineas que son copia exacta
 * de la referencia fuera de un bloque, desde la siguiente se quitan. Las primeras se dejan: una
 * pista puede citar una o dos lineas que el estudiante ya tiene.
 */
export function guardExamReferenceLeak(output: string, referenceText: string, allowed = 3) {
  const text = String(output || "");
  if (!referenceText || !text) return { text, removed: 0 };
  const watched = referenceCodeLines(referenceText);
  if (!watched.size) return { text, removed: 0 };
  let insideFence = false;
  let matched = 0;
  let removed = 0;
  const kept: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) {
      insideFence = !insideFence;
      kept.push(raw);
      continue;
    }
    if (!insideFence && watched.has(raw.trim().replace(/^[-*>]\s+/, "").replace(/\s+/g, " "))) {
      matched += 1;
      if (matched > allowed) {
        removed += 1;
        continue;
      }
    }
    kept.push(raw);
  }
  return { text: removed ? kept.join("\n").replace(/\n{3,}/g, "\n\n") : text, removed };
}

/**
 * Deja solo el primer bloque de codigo de la respuesta (el que VS Code muestra y aplica). Quita los
 * demas y un bloque final sin cerrar (respuesta cortada): el tope de lineas de la politica es por
 * bloque, y con la referencia en el prompt no puede salir el archivo partido en varios bloques.
 */
export function keepFirstCodeBlock(output: string) {
  const lines = String(output || "").split(/\r?\n/);
  const kept: string[] = [];
  let blocks = 0;
  let removed = 0;
  let inside = false;
  let dropping = false;
  let pending: string[] = [];
  for (const line of lines) {
    const fence = /^\s*```/.test(line);
    if (!inside && fence) {
      inside = true;
      blocks += 1;
      dropping = blocks > 1;
      pending = dropping ? [] : [line];
      continue;
    }
    if (inside) {
      if (fence) {
        inside = false;
        if (dropping) removed += 1;
        else kept.push(...pending, line);
        pending = [];
        continue;
      }
      if (!dropping) pending.push(line);
      continue;
    }
    kept.push(line);
  }
  if (inside) removed += 1; // bloque sin cerrar: se descarta entero
  if (!removed) return { text: String(output || ""), removed: 0 };
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
}

/** Para /api/health: si la referencia esta cargada (sin contenido). */
export function describeExamReference() {
  let reference: ExamReference | null = null;
  try {
    reference = loadExamReference();
  } catch {
    reference = null;
  }
  return { exam_reference_loaded: Boolean(reference) };
}
