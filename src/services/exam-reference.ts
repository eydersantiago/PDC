// Referencia privada del examen del 28-10-2026 (Sistema bancario): la solucion completa y una guia
// por pasos, para que el tutor lleve a cada estudiante hacia el codigo final, un paso pequeno a la
// vez segun lo que ya tiene escrito. Lo pidio Eyder el 28-10 (madrugada): en el examen el tutor da
// pistas y codigo sugerido (VS Code lo muestra en previsualizacion con la opcion de añadirlo). El
// repositorio del examen es tambien el del taller, asi que vale para el taller.
//
// La solucion NO esta en este repositorio: PDC es publico y el editor de los estudiantes abre
// cualquier repositorio publico. Llega por la variable de entorno EXAM_REFERENCE_B64 (el JSON en
// gzip + base64) que se configura en Azure y se lee en config/env.ts. Sin la variable, o si no se
// puede leer, el tutor sigue exactamente como antes. EXAM_REFERENCE=off la apaga sin borrarla.
//
// Una sola puerta (resolveExamReferenceForRequest): solo con sesion iniciada, con la politica del
// docente activa y en los pedidos del repositorio del ejercicio (el de la referencia o EXAM_REPO;
// EXAM_PRESET=off apaga el tema del examen, no la referencia: son interruptores independientes).
// Lo que devuelve trae tambien como limpiar la respuesta:
//   - VS Code: el .h y el .cpp de referencia del archivo abierto, los .h que usa, el paso de la
//     guia y los errores frecuentes. La respuesta queda con un solo bloque de codigo
//     (keepFirstBlock, antes del guardarrail de lineas de la politica) y sin lineas copiadas de la
//     referencia fuera de los bloques (removeLeakedReferenceLines, despues).
//   - Panel del navegador: la guia y las declaraciones (.h), sin los .cpp; su respuesta tambien
//     pasa por removeLeakedReferenceLinesInTexts, con un cupo comun para todos sus textos.
import { gunzipSync } from "node:zlib";
import type { AppSession } from "../types/app.js";
import { env, isOffSwitch } from "../config/env.js";
import { parseGithubRepoRef } from "./github-repo-ref.js";
import { EDITOR_STAGE_CODE_CAP } from "./intervention-templates.js";
import { keepFirstCodeBlock, parseFences } from "./markdown-fences.js";

export type ExamReferenceStep = {
  id: string;
  titulo: string;
  /** Archivos de la solucion que corresponden a este paso (.h y .cpp). */
  archivos: string[];
  /** Declaraciones que este paso usa (por ejemplo Cuenta.h para las hijas). */
  apoyo: string[];
  guia: string;
  /**
   * Otros nombres de archivo que corresponden a este paso (opcional), ademas de los de archivos:
   * por ejemplo "titular" para Titularidad. Se comparan sin mayusculas ni signos.
   */
  patrones: string[];
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
  repoFullName?: string;
  url?: string;
  title?: string;
  filePath?: string;
};

/** Tope del bloque por canal: el prompt total se ajusta a la ventana del modelo (8192 tokens). */
export const EXAM_REFERENCE_MAX_CHARS: Record<ExamReferenceChannel, number> = {
  editor: 8000,
  panel: 3500,
};

/** Lineas copiadas de la referencia que se dejan fuera de los bloques (una pista puede citar alguna). */
export const EXAM_REFERENCE_ALLOWED_VERBATIM_LINES = 3;

/** Los topes del editor por etapa (intervention-templates.ts), para la regla de cuanto proponer. */
function stageLimitsText() {
  const first = EDITOR_STAGE_CODE_CAP.hint_1;
  const second = EDITOR_STAGE_CODE_CAP.hint_2;
  return first && second
    ? `${first}, luego ${second} y luego el maximo del docente`
    : "segun la etapa de ayuda";
}

function rules() {
  return [
    "Es la solucion completa del ejercicio y una guia por pasos. El estudiante NO la ve. Usala asi:",
    "- Ubica en que paso va el estudiante por el archivo y el codigo que ya tiene, y llevalo al SIGUIENTE paso pequeno hacia este codigo final.",
    `- Propone solo lo que sigue, con el maximo de lineas que indica la politica en esta respuesta (crece si el estudiante pide mas ayuda: ${stageLimitsText()}): nunca un archivo ni una clase completa.`,
    "- Usa los nombres, el orden y el estilo que el estudiante ya tiene; si su codigo es correcto aunque sea distinto de la referencia, no lo cambies.",
    "- Si hay un error de compilacion, explica la causa con los errores frecuentes y propone la correccion minima.",
    "- No digas que tienes una solucion de referencia ni la cites como material del curso; no copies sus comentarios.",
  ].join("\n");
}

/** Linea para el final del prompt (junto a donde el modelo empieza a escribir). */
const TAIL_RULE = "Usa la referencia privada del docente para que la pista y el codigo sean el siguiente paso hacia el codigo final del ejercicio, con los nombres y firmas del diagrama, sin entregar la solucion completa.";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function readExamReference(raw: string): ExamReference | null {
  const clean = String(raw || "").replace(/\s+/g, "");
  if (!clean) return null;
  const data = JSON.parse(gunzipSync(Buffer.from(clean, "base64")).toString("utf8")) as Record<string, unknown>;
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
      patrones: isStringArray(step.patrones) ? step.patrones : [],
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

/** Lee el JSON de EXAM_REFERENCE_B64 (gzip + base64). Nunca lanza: null si no se puede leer. */
export function parseExamReference(raw: string): ExamReference | null {
  try {
    return readExamReference(raw);
  } catch {
    return null;
  }
}

let cache: { raw: string; value: ExamReference | null } | null = null;

/** La referencia vigente, o null (sin variable, apagada o ilegible). Se lee una vez por valor. */
export function loadExamReference(): ExamReference | null {
  if (isOffSwitch(env.examReferenceSwitch)) return null;
  const raw = String(env.examReferenceB64 || "").trim();
  if (!raw) return null;
  if (cache && cache.raw === raw) return cache.value;
  const value = parseExamReference(raw);
  if (!value) console.warn("[examen] EXAM_REFERENCE_B64 no se pudo leer: el tutor sigue sin la referencia del examen.");
  cache = { raw, value };
  return value;
}

function repoNames(repos: string[]) {
  const names = new Set<string>();
  for (const repo of repos) {
    const name = parseGithubRepoRef(repo)?.name.toLowerCase();
    if (name) names.add(name);
  }
  return [...names];
}

/**
 * ¿El pedido es del ejercicio del examen? Por el nombre del repositorio (tambien un fork o una
 * copia con otro dueño) o, sin repositorio, por la URL o el titulo (vscode://<carpeta>/..., la URL
 * del tunel con la carpeta del ejercicio). `otherRepos`: otros repositorios del mismo ejercicio
 * (el del tema del examen, EXAM_REPO).
 */
export function matchesExamRepo(reference: ExamReference, hint: ExamRequestHint, otherRepos: string[] = []) {
  const names = repoNames([reference.repo, ...otherRepos]);
  if (String(hint.repoFullName || "").trim()) {
    const name = parseGithubRepoRef(hint.repoFullName)?.name.toLowerCase();
    return Boolean(name) && names.includes(name as string);
  }
  const text = [hint.url, hint.title, hint.filePath].map((value) => String(value ?? "").toLowerCase()).join("\n");
  return names.some((name) => text.includes(name));
}

/** Nombre de un archivo sin carpeta, extension ni signos, en minusculas («cuenta_corriente.hpp» -> «cuentacorriente»). */
function fileStem(path: unknown) {
  const base = String(path ?? "").split(/[\\/]/).pop() || "";
  return base.toLowerCase().replace(/\.[a-z0-9+]+$/, "").replace(/[^a-z]/g, "");
}

function stepPatterns(step: ExamReferenceStep) {
  const patterns = [...step.archivos.map(fileStem), ...step.patrones.map((pattern) => String(pattern).toLowerCase().replace(/[^a-z]/g, ""))];
  return [...new Set(patterns.filter(Boolean))];
}

/**
 * Paso de la guia que corresponde al archivo abierto, con los nombres de los archivos de cada paso
 * (y sus patrones): primero un nombre igual, despues uno con que empieza (main2.cpp va con
 * main.cpp) y despues el mas largo que contiene (CuentaCorrienteTest va con CuentaCorriente y no
 * con Cuenta). null si ninguno coincide.
 */
export function resolveExamStep(reference: ExamReference, filePath: unknown): ExamReferenceStep | null {
  const stem = fileStem(filePath);
  if (!stem) return null;
  let best: { step: ExamReferenceStep; score: number } | null = null;
  for (const step of reference.pasos) {
    for (const pattern of stepPatterns(step)) {
      const score = stem === pattern ? 3000 + pattern.length
        : stem.startsWith(pattern) ? 2000 + pattern.length
          : stem.includes(pattern) ? pattern.length
            : 0;
      if (score > (best?.score || 0)) best = { step, score };
    }
  }
  return best?.step || null;
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

export type ExamReferenceBlock = {
  text: string;
  stepId: string;
  /** Linea para el final del prompt del editor (tab-suggestion-prompt.ts). */
  tailRule: string;
};

/**
 * El bloque que va en el prompt: reglas, guia del paso, codigo de referencia del archivo (solo en
 * el editor), declaraciones de apoyo, plan, errores frecuentes y el resto de declaraciones. Entra
 * por prioridad hasta el tope del canal; las reglas y la guia del paso siempre van.
 */
export function buildExamReferenceBlock(
  reference: ExamReference,
  options: { filePath?: string; channel: ExamReferenceChannel; maxChars?: number },
): ExamReferenceBlock {
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

  push(`## Referencia privada del docente (examen ${reference.examen || reference.repo})\n${rules()}`, true);
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

  return { text: parts.join("\n\n"), stepId: step?.id || "", tailRule: TAIL_RULE };
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
 * Una linea como se compara con la referencia: sin espacios de mas, sin viñeta y sin la etiqueta
 * de cita que el panel agrega al final ([RAG-FPOO-...#c1], rag-sources.ts).
 */
function comparableLine(raw: string) {
  return raw.trim().replace(/^[-*>]\s+/, "").replace(/\s*\[[A-Za-z0-9#._-]+\]$/, "").replace(/\s+/g, " ");
}

/** Quita de un texto las lineas copiadas de la referencia fuera de los bloques, con un cupo comun. */
function trimLeakedLines(text: string, watched: Set<string>, budget: { matched: number; allowed: number }) {
  const insideFence = new Set<number>();
  for (const fence of parseFences(text)) {
    const first = text.slice(0, fence.start).split("\n").length - 1;
    const last = text.slice(0, fence.end).split("\n").length - 1;
    for (let line = first; line <= last; line += 1) insideFence.add(line);
  }
  let removedLines = 0;
  const kept = text.split(/\r?\n/).filter((raw, index) => {
    if (insideFence.has(index)) return true;
    if (!watched.has(comparableLine(raw))) return true;
    budget.matched += 1;
    if (budget.matched <= budget.allowed) return true;
    removedLines += 1;
    return false;
  });
  return { text: removedLines ? kept.join("\n").replace(/\n{3,}/g, "\n\n") : text, removedLines };
}

/**
 * Freno a una fuga de la referencia FUERA de los bloques de codigo (los bloques ya los recorta el
 * guardarrail de la politica): si la respuesta trae mas de `allowedVerbatimLines` lineas que son
 * copia exacta de la referencia fuera de un bloque, desde la siguiente se quitan. Las primeras se
 * dejan: una pista puede citar una o dos lineas que el estudiante ya tiene.
 */
export function guardExamReferenceLeak(options: { output: string; referenceText: string; allowedVerbatimLines?: number }) {
  const guarded = guardExamReferenceLeakInTexts({ ...options, outputs: [options.output] });
  return { text: guarded.texts[0], removedLines: guarded.removedLines };
}

/** Igual, para varios textos de una misma respuesta (el panel): el cupo es de toda la respuesta. */
function guardExamReferenceLeakInTexts(options: { outputs: string[]; referenceText: string; allowedVerbatimLines?: number }) {
  const outputs = options.outputs.map((output) => String(output || ""));
  const watched = options.referenceText ? referenceCodeLines(options.referenceText) : new Set<string>();
  if (!watched.size) return { texts: outputs, removedLines: 0 };
  const budget = { matched: 0, allowed: options.allowedVerbatimLines ?? EXAM_REFERENCE_ALLOWED_VERBATIM_LINES };
  const results = outputs.map((output) => trimLeakedLines(output, watched, budget));
  return {
    texts: results.map((result) => result.text),
    removedLines: results.reduce((sum, result) => sum + result.removedLines, 0),
  };
}

/** Lo que el tutor recibe de la referencia para un pedido, y como limpiar su respuesta. */
export type ExamReferenceContext = ExamReferenceBlock & {
  channel: ExamReferenceChannel;
  /** Editor: deja un solo bloque de codigo (antes del guardarrail). Panel: no cambia nada. */
  keepFirstBlock(output: string): { text: string; removedBlocks: number };
  /** Quita las lineas copiadas de la referencia fuera de los bloques (despues del guardarrail). */
  removeLeakedReferenceLines(output: string): { text: string; removedLines: number };
  /** Lo mismo para los textos de una respuesta del panel, con un cupo comun. */
  removeLeakedReferenceLinesInTexts(outputs: string[]): { texts: string[]; removedLines: number };
};

/** Lo que decide si el pedido puede llevar la referencia: la sesion y la decision de la politica. */
export type ExamReferenceAccess = {
  channel: ExamReferenceChannel;
  /** La sesion del pedido (null sin sesion iniciada). */
  session: Pick<AppSession, "user"> | null;
  /** La decision de la politica del docente (null sin politica cargada). */
  decision: { blocked: boolean } | null;
};

/** Otros repositorios del mismo ejercicio: EXAM_REPO, si esta (no depende de EXAM_PRESET). */
function otherExamRepos() {
  const repo = String(env.examRepo || "").trim();
  return repo ? [repo] : [];
}

/**
 * La unica puerta de la referencia: null sin sesion iniciada, sin la politica del docente o con
 * la ayuda bloqueada, sin referencia cargada o en otro repositorio. Nunca lanza: un error aqui no
 * puede dejar al estudiante sin tutor.
 */
export function resolveExamReferenceForRequest(hint: ExamRequestHint, access: ExamReferenceAccess): ExamReferenceContext | null {
  if (!access.session || !access.decision || access.decision.blocked) return null;
  try {
    const reference = loadExamReference();
    if (!reference || !matchesExamRepo(reference, hint, otherExamRepos())) return null;
    const block = buildExamReferenceBlock(reference, { filePath: hint.filePath, channel: access.channel });
    return {
      ...block,
      channel: access.channel,
      keepFirstBlock: (output) => (access.channel === "editor" ? keepFirstCodeBlock(output) : { text: String(output || ""), removedBlocks: 0 }),
      removeLeakedReferenceLines: (output) => guardExamReferenceLeak({ output, referenceText: block.text }),
      removeLeakedReferenceLinesInTexts: (outputs) => guardExamReferenceLeakInTexts({ outputs, referenceText: block.text }),
    };
  } catch (error) {
    console.warn(`[examen] no se pudo armar la referencia del examen: ${String(error)}`);
    return null;
  }
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
