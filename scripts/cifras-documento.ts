import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Cifras que el documento final y la sustentación citan del repositorio
 * (A16.2 · ADACEEN-130 y A16.5 · ADACEEN-133).
 *
 *   npx tsx scripts/cifras-documento.ts                   # escribe docs/evidencias/cifras-documento.md
 *   npx tsx scripts/cifras-documento.ts --salida=<ruta>   # escribe en otro archivo
 *   npx tsx scripts/cifras-documento.ts --json            # imprime las cifras en JSON y no escribe
 *
 * Solo lee archivos y git: no necesita red, base de datos ni .env. Cuenta lo
 * que hay en el árbol de trabajo (archivos versionados y nuevos no ignorados)
 * y anota el commit y si había cambios sin commit, para que cualquiera pueda
 * repetir el cálculo sobre el mismo commit.
 */

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
export const DEFAULT_OUTPUT = "docs/evidencias/cifras-documento.md";
export const COMMAND = "npx tsx scripts/cifras-documento.ts";
const SUBMODULE = "vscode-ext-prod";
const SKIP_DIRS = new Set(["node_modules", "dist", "out", ".git", "exportes", "coverage", ".vscode-test"]);

// --- Utilidades puras ----------------------------------------------------------

/** Pruebas declaradas con node:test al inicio de una línea: test(…) o it(…), también .only/.skip/.todo. */
export function countTestsInSource(text: string) {
  return (text.match(/^[ \t]*(?:test|it)(?:\.(?:only|skip|todo))?[ \t]*\(/gm) ?? []).length;
}

/** Líneas físicas (sin contar el salto final) y líneas con algo más que espacios. */
export function countLines(text: string) {
  if (!text) return { lines: 0, nonBlank: 0 };
  const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  return { lines: lines.length, nonBlank: lines.filter((line) => line.trim() !== "").length };
}

/** Separador de miles con espacio desde 10 000 (como en los documentos del repo). */
export function formatNumber(value: number) {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value);
  if (Math.abs(rounded) < 10000) return String(rounded);
  return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/**
 * Rutas registradas en un archivo de src/routes: app.get("…"), app.post([…]).
 * Resuelve constantes de texto del mismo archivo y plantillas simples
 * (`${X}.json`), igual que tests/scripts/contrato-api.test.ts.
 */
export function routesFromSource(text: string) {
  const constants = new Map<string, string>();
  for (const match of text.matchAll(/const\s+([A-Z_][A-Z0-9_]*)\s*=\s*"([^"]+)"/g)) constants.set(match[1], match[2]);
  const resolve = (token: string) => {
    const clean = token.trim();
    if (!clean) return null;
    if (clean.startsWith("\"")) return clean.slice(1, -1);
    if (clean.startsWith("`")) {
      return clean.slice(1, -1).replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_all, name: string) => constants.get(name) ?? `\${${name}}`);
    }
    return constants.get(clean) ?? null;
  };
  const routes = new Set<string>();
  for (const match of text.matchAll(/app\.(get|post|put|patch|delete)\(\s*(\[[^\]]*\]|"[^"]+"|`[^`]+`)/g)) {
    const method = match[1].toUpperCase();
    const arg = match[2];
    const tokens = arg.startsWith("[") ? arg.slice(1, -1).split(",") : [arg];
    for (const token of tokens) {
      const route = resolve(token);
      if (route) routes.add(`${method} ${route}`);
    }
  }
  return [...routes].sort();
}

/**
 * Rutas del inventario (sección «3. Inventario de rutas») del contrato de la
 * API, agrupadas por el módulo de la primera columna de la tabla.
 */
export function routesInContractInventory(doc: string) {
  const start = doc.search(/^## 3\. Inventario de rutas/m);
  if (start < 0) return { routes: [] as string[], byModule: new Map<string, string[]>() };
  const rest = doc.slice(start + 3);
  const end = rest.search(/^## /m);
  const section = end < 0 ? rest : rest.slice(0, end);
  const routes = new Set<string>();
  const byModule = new Map<string, string[]>();
  let currentModule = "";
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2) continue;
    const moduleName = cells[0].match(/^`([^`]+\.ts)`$/)?.[1];
    if (moduleName) currentModule = moduleName;
    for (const match of (cells[1] ?? "").matchAll(/`((?:GET|POST|PUT|PATCH|DELETE) \/[^`]*)`/g)) {
      routes.add(match[1]);
      if (!currentModule) continue;
      const list = byModule.get(currentModule) ?? [];
      if (!list.includes(match[1])) list.push(match[1]);
      byModule.set(currentModule, list);
    }
  }
  return { routes: [...routes].sort(), byModule };
}

/** Archivos que importa tests/index.test.ts (lo que corre `npm test`), relativos a la raíz. */
export function importsOfTestIndex(indexText: string, exists: (relative: string) => boolean) {
  const files: string[] = [];
  for (const match of indexText.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) {
    const relative = path.posix.normalize(path.posix.join("tests", match[1]));
    const asTs = relative.replace(/\.js$/, ".ts");
    files.push(relative.endsWith(".js") && exists(asTs) ? asTs : relative);
  }
  return files;
}

/** Filas de datos de la primera tabla que empieza con la cabecera dada. */
export function countTableRows(doc: string, headerStart: string) {
  const lines = doc.split("\n");
  const index = lines.findIndex((line) => line.startsWith(headerStart));
  if (index < 0) return 0;
  let rows = 0;
  for (let i = index + 2; i < lines.length && lines[i].startsWith("|"); i += 1) rows += 1;
  return rows;
}

// --- Acceso a archivos y git ---------------------------------------------------

function toPosix(value: string) {
  return value.split(path.sep).join("/");
}

function runGit(cwd: string, args: string[]) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function isGitRoot(dir: string) {
  return fs.existsSync(path.join(dir, ".git")) && runGit(dir, ["rev-parse", "--show-toplevel"]) !== null;
}

function walk(base: string, relDir: string): string[] {
  const absolute = path.join(base, relDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absolute, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const relative = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(base, relative));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

/**
 * Archivos de una carpeta (relativos a `base`): con git, los versionados y
 * los nuevos no ignorados que existen en disco; sin git, se recorre la
 * carpeta saltando node_modules, dist, out y similares.
 */
export function listFiles(base: string, relDir: string, useGit = isGitRoot(base)) {
  if (useGit) {
    const output = runGit(base, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", relDir || "."]);
    if (output !== null) {
      return output
        .split("\0")
        .filter(Boolean)
        .map(toPosix)
        .filter((file) => {
          const absolute = path.join(base, file);
          return fs.existsSync(absolute) && fs.statSync(absolute).isFile();
        })
        .sort();
    }
  }
  return walk(base, relDir.replace(/\/$/, "")).sort();
}

function readText(absolute: string) {
  try {
    return fs.readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}

function readJson<T>(absolute: string): T | null {
  const text = readText(absolute);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// --- Tipos de salida ------------------------------------------------------------

export type GitInfo = {
  commit: string | null;
  commitFull: string | null;
  branch: string | null;
  commitDate: string | null;
  changedFiles: number | null;
};

export type TestSuiteCount = {
  id: string;
  name: string;
  files: number;
  tests: number;
  inNpmTest: number;
  command: string;
};

export type LocCount = { id: string; name: string; scope: string; files: number; lines: number; nonBlank: number };

export type EvidenceFigure = { documento: string; cifra: string; valor: string | null };

export type Cifras = {
  generadoEn: string;
  git: GitInfo;
  submodulo: GitInfo & { ruta: string };
  versiones: {
    extensionNavegador: string | null;
    extensionVsCode: string | null;
    vscodeMinimo: string | null;
    esquemaTelemetria: string | null;
    bancoQuiz: string | null;
    matrizEscenarios: string | null;
    modeloPiloto: string | null;
  };
  pruebas: { suites: TestSuiteCount[]; total: number; npmTest: number; archivosNpmTest: number };
  rutas: {
    codigo: number;
    contrato: number;
    soloEnCodigo: string[];
    soloEnContrato: string[];
    porMetodo: Record<string, number>;
    porModulo: Array<{ modulo: string; codigo: number; contrato: number }>;
  };
  telemetria: {
    eventos: number;
    utiles: number;
    conDecision: number;
    categorias: number;
    campos: number;
    reglasCalidad: number;
    porOrigen: Record<string, number>;
  };
  kpis: {
    total: number;
    principales: string[];
    porDimension: Record<string, number>;
    porObjetivo: Record<string, number>;
    automaticos: number;
    manuales: string[];
    conUmbral: number;
    descriptivos: number;
    umbralPropuesto: number;
  };
  tutor: {
    escenarios: string[];
    peticionesOverlay: number;
    peticionesEditor: number;
    etapas: string[];
    eventosPolitica: string[];
    preguntasBanco: number;
    bancoPorRa: Record<string, number>;
    bancoPorLenguaje: Record<string, number>;
    reglasMatriz: number;
    recursosMatriz: number;
    fuentesRagSemilla: number;
  };
  piloto: {
    itemsCumplimiento: number;
    itemsCriticos: number;
    itemsAutomaticos: number;
    cumplimientoPorArea: Record<string, number>;
    itemsEncuesta: number;
    encuestaPorEscala: Record<string, number>;
    plantillas: number;
  };
  interfaces: {
    scriptsNpm: number;
    comandosVsCode: number;
    permisosNavegador: number;
    hostsNavegador: number;
    contenedoresC4: number;
    documentosMarkdown: number;
  };
  lineas: LocCount[];
  evidencias: EvidenceFigure[];
  avisos: string[];
};

// --- Definiciones de componentes -------------------------------------------------

type Base = "pdc" | "vscode";

type SuiteDef = { id: string; name: string; base: Base; dir: string; include: (file: string) => boolean; command: string };

const isTestFile = (file: string) => /\.test\.(ts|mjs|js)$/.test(file);

const KNOWN_TEST_DIRS = ["tests/services/", "tests/routes/", "tests/integration/", "tests/scripts/"];

const SUITES: SuiteDef[] = [
  { id: "backend-servicios", name: "Backend: servicios (motor, telemetría, KPIs, piloto, cola)", base: "pdc", dir: "tests/services", include: isTestFile, command: "npm test" },
  { id: "backend-rutas", name: "Backend: rutas HTTP con base en memoria", base: "pdc", dir: "tests/routes", include: isTestFile, command: "npm test" },
  { id: "integracion", name: "Integración de punta a punta (acceso simplificado)", base: "pdc", dir: "tests/integration", include: isTestFile, command: "npm test" },
  {
    id: "scripts-docs",
    name: "Scripts, documentos generados y contrato de la API",
    base: "pdc",
    dir: "tests/scripts",
    include: (file) => isTestFile(file) && !path.posix.basename(file).startsWith("browser-ext-"),
    command: "npm test",
  },
  {
    id: "navegador",
    name: "Extensión de navegador (estructura, permisos y flujo del túnel)",
    base: "pdc",
    dir: "tests/scripts",
    include: (file) => isTestFile(file) && path.posix.basename(file).startsWith("browser-ext-"),
    command: "npm test",
  },
  {
    id: "otras-pdc",
    name: "Otras pruebas de PDC",
    base: "pdc",
    dir: "tests",
    include: (file) => isTestFile(file) && file !== "tests/index.test.ts" && !KNOWN_TEST_DIRS.some((dir) => file.startsWith(dir)),
    command: "npm test",
  },
  { id: "agente-vm", name: "Agente y scripts de la VM de editores", base: "pdc", dir: "deploy/gcp/workspaces/agente", include: isTestFile, command: "node --test deploy/gcp/workspaces/agente/*.test.mjs" },
  { id: "operacion-gcp", name: "Operación en Google Cloud (clase.sh, GPU)", base: "pdc", dir: "deploy/gcp", include: (file) => isTestFile(file) && !file.startsWith("deploy/gcp/workspaces/"), command: "node --test deploy/gcp/operacion.test.mjs" },
  { id: "mac", name: "Instaladores de doble clic de la Mac", base: "pdc", dir: "deploy/mac", include: isTestFile, command: "node --test deploy/mac/doble-clic.test.mjs" },
  { id: "vscode-unitarias", name: "Extensión de VS Code: unitarias", base: "vscode", dir: "src/unit-tests", include: isTestFile, command: `npm --prefix ${SUBMODULE} run test:unit` },
  { id: "vscode-integracion", name: "Extensión de VS Code: dentro de VS Code (vscode-test)", base: "vscode", dir: "src/test", include: isTestFile, command: `npm --prefix ${SUBMODULE} test` },
];

type LocDef = { id: string; name: string; scope: string; parts: Array<{ base: Base; dir: string; include: (file: string) => boolean }> };

const hasExt = (file: string, exts: string[]) => exts.some((ext) => file.endsWith(ext));

const LOC: LocDef[] = [
  {
    id: "backend",
    name: "Backend (API)",
    scope: "`src/**/*.ts` y los `.ts` de la raíz",
    parts: [
      { base: "pdc", dir: "src", include: (file) => hasExt(file, [".ts"]) },
      { base: "pdc", dir: "", include: (file) => !file.includes("/") && hasExt(file, [".ts"]) },
    ],
  },
  { id: "scripts", name: "Scripts de consola (piloto, evidencias, worker)", scope: "`scripts/**/*.ts` y `.mjs`", parts: [{ base: "pdc", dir: "scripts", include: (file) => hasExt(file, [".ts", ".mjs"]) }] },
  { id: "navegador", name: "Extensión de navegador", scope: "`browser-ext-prod/**/*.js`, `.html`, `.css` y `manifest.json`", parts: [{ base: "pdc", dir: "browser-ext-prod", include: (file) => hasExt(file, [".js", ".html", ".css", ".json"]) }] },
  {
    id: "vscode",
    name: "Extensión de VS Code",
    scope: "`vscode-ext-prod/src/**/*.ts` sin las pruebas",
    parts: [{ base: "vscode", dir: "src", include: (file) => hasExt(file, [".ts"]) && !file.startsWith("src/test/") && !file.startsWith("src/unit-tests/") }],
  },
  { id: "agente-vm", name: "Agente de la VM de editores", scope: "`deploy/gcp/workspaces/agente/*.mjs` sin las pruebas", parts: [{ base: "pdc", dir: "deploy/gcp/workspaces/agente", include: (file) => hasExt(file, [".mjs"]) && !isTestFile(file) }] },
  { id: "despliegue", name: "Despliegue y operación (shell)", scope: "`deploy/**/*.sh`, `.command` y `.service`", parts: [{ base: "pdc", dir: "deploy", include: (file) => hasExt(file, [".sh", ".command", ".service"]) }] },
  {
    id: "pruebas",
    name: "Pruebas automatizadas",
    scope: "`tests/**`, `deploy/**/*.test.mjs` y las pruebas de `vscode-ext-prod/src`",
    parts: [
      { base: "pdc", dir: "tests", include: (file) => hasExt(file, [".ts", ".mjs"]) },
      { base: "pdc", dir: "deploy", include: isTestFile },
      { base: "vscode", dir: "src", include: (file) => file.startsWith("src/test/") || file.startsWith("src/unit-tests/") },
    ],
  },
  { id: "docs", name: "Documentación", scope: "`docs/**/*.md`", parts: [{ base: "pdc", dir: "docs", include: (file) => hasExt(file, [".md"]) }] },
];

const CODE_LOC_IDS = ["backend", "scripts", "navegador", "vscode", "agente-vm", "despliegue"];

// --- Recolección ------------------------------------------------------------------

function gitInfo(dir: string, useGit: boolean): GitInfo {
  if (!useGit) return { commit: null, commitFull: null, branch: null, commitDate: null, changedFiles: null };
  const trim = (value: string | null) => (value === null ? null : value.trim() || null);
  const status = runGit(dir, ["status", "--porcelain", "--untracked-files=normal"]);
  return {
    commit: trim(runGit(dir, ["rev-parse", "--short=7", "HEAD"])),
    commitFull: trim(runGit(dir, ["rev-parse", "HEAD"])),
    branch: trim(runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"])),
    commitDate: trim(runGit(dir, ["log", "-1", "--format=%cI"])),
    changedFiles: status === null ? null : status.split("\n").filter((line) => line.trim() !== "").length,
  };
}

function tally<T>(items: T[], key: (item: T) => string | string[]) {
  const out: Record<string, number> = {};
  for (const item of items) {
    const keys = key(item);
    for (const value of Array.isArray(keys) ? keys : [keys]) out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

function sortRecord(record: Record<string, number>) {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

async function importOptional<T>(specifier: string, avisos: string[]): Promise<T | null> {
  try {
    return (await import(specifier)) as T;
  } catch (error) {
    avisos.push(`No se pudo cargar ${specifier}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function matchOne(text: string | null, regex: RegExp, format: (match: RegExpMatchArray) => string) {
  if (!text) return null;
  const match = text.match(regex);
  return match ? format(match) : null;
}

export function evidenceFigures(read: (relative: string) => string | null): EvidenceFigure[] {
  const demo = read("docs/evidencias/demo-escenarios.md");
  const latency = read("docs/evidencias/latencia-entorno-controlado.md");
  const stability = read("docs/evidencias/estabilidad-eventos-simulacion.md");
  const rehearsal = read("docs/evidencias/ensayo-tecnico-piloto.md");
  const latencyRow = (group: string) =>
    matchOne(latency, new RegExp(`^\\| ${group} \\(todos\\) \\| (\\d+) \\| (\\d+) \\| (\\d+) \\|`, "m"), (m) => `p50 ${m[2]} ms, p95 ${m[3]} ms (n = ${m[1]})`);
  return [
    { documento: "demo-escenarios.md", cifra: "Comprobaciones de los escenarios S1–S5 (overlay y editor)", valor: matchOne(demo, /Resultado: (\d+) de (\d+) comprobaciones correctas/, (m) => `${m[1]} de ${m[2]}`) },
    { documento: "demo-escenarios.md", cifra: "Fecha de la corrida", valor: matchOne(demo, /^- Fecha: (\S+)/m, (m) => m[1]) },
    { documento: "latencia-entorno-controlado.md", cifra: "Latencia del servidor, editor (salida de referencia, sin modelo)", valor: latencyRow("editor") },
    { documento: "latencia-entorno-controlado.md", cifra: "Latencia del servidor, overlay (salida de referencia, sin modelo)", valor: latencyRow("overlay") },
    {
      documento: "estabilidad-eventos-simulacion.md",
      cifra: "Eventos esperados, recibidos y perdidos a propósito",
      valor: matchOne(stability, /Eventos esperados por seq: (\d+), recibidos: (\d+), perdidos: (\d+)/, (m) => `${m[1]} esperados, ${m[2]} recibidos, ${m[3]} perdidos`),
    },
    { documento: "estabilidad-eventos-simulacion.md", cifra: "Descartes que detectó el estimador por seq", valor: matchOne(stability, /detecto (\d+) de (\d+) descartes/, (m) => `${m[1]} de ${m[2]}`) },
    { documento: "ensayo-tecnico-piloto.md", cifra: "Comprobaciones del ensayo técnico (estudiantes sintéticos)", valor: matchOne(rehearsal, /\| Resultado \| (\d+) de (\d+) comprobaciones correctas \|/, (m) => `${m[1]} de ${m[2]}`) },
    { documento: "ensayo-tecnico-piloto.md", cifra: "Estudiantes sintéticos y eventos generados", valor: rehearsal && /\| Estudiantes \| (\d+) sintéticos/.test(rehearsal) && /\| Eventos generados \| (\d+) \|/.test(rehearsal)
      ? `${rehearsal.match(/\| Estudiantes \| (\d+) sintéticos/)![1]} estudiantes, ${rehearsal.match(/\| Eventos generados \| (\d+) \|/)![1]} eventos`
      : null },
  ];
}

export type CollectOptions = { root?: string; now?: Date; useGit?: boolean };

export async function collectCifras(options: CollectOptions = {}): Promise<Cifras> {
  const root = path.resolve(options.root ?? REPO_ROOT);
  const now = options.now ?? new Date();
  const avisos: string[] = [];
  const pdcGit = options.useGit ?? isGitRoot(root);
  const vscodeRoot = path.join(root, SUBMODULE);
  const vscodeGit = options.useGit === false ? false : isGitRoot(vscodeRoot);
  const baseDir = (base: Base) => (base === "pdc" ? root : vscodeRoot);
  const baseGit = (base: Base) => (base === "pdc" ? pdcGit : vscodeGit);
  const read = (relative: string, base: Base = "pdc") => readText(path.join(baseDir(base), relative));
  const fileCache = new Map<string, string[]>();
  const files = (base: Base, dir: string) => {
    const key = `${base}:${dir}`;
    if (!fileCache.has(key)) {
      let list = listFiles(baseDir(base), dir, baseGit(base));
      // Con git en la raíz, el submódulo aparece como una sola entrada; sus archivos se listan aparte.
      if (base === "pdc" && dir === "") list = list.filter((file) => !file.startsWith(`${SUBMODULE}/`) && file !== SUBMODULE);
      fileCache.set(key, list);
    }
    return fileCache.get(key)!;
  };

  if (!fs.existsSync(path.join(vscodeRoot, "package.json"))) avisos.push(`No está ${SUBMODULE}/ (submódulo sin clonar): sus cifras salen en 0.`);

  // Pruebas.
  const indexText = read("tests/index.test.ts") ?? "";
  const npmTestFiles = new Set(importsOfTestIndex(indexText, (relative) => fs.existsSync(path.join(root, relative))));
  for (const file of npmTestFiles) if (!fs.existsSync(path.join(root, file))) avisos.push(`tests/index.test.ts importa ${file}, que no existe.`);
  const suites: TestSuiteCount[] = SUITES.flatMap((suite) => {
    const selected = files(suite.base, suite.dir).filter(suite.include);
    if (suite.id === "otras-pdc" && selected.length === 0) return [];
    let tests = 0;
    let inNpmTest = 0;
    for (const file of selected) {
      const count = countTestsInSource(read(file, suite.base) ?? "");
      tests += count;
      if (suite.base === "pdc" && npmTestFiles.has(file)) inNpmTest += count;
    }
    return [{ id: suite.id, name: suite.name, files: selected.length, tests, inNpmTest, command: suite.command }];
  });
  const npmTestTotal = [...npmTestFiles].reduce((sum, file) => sum + countTestsInSource(read(file) ?? ""), 0);
  const suiteNpm = suites.reduce((sum, suite) => sum + suite.inNpmTest, 0);
  if (suiteNpm !== npmTestTotal) avisos.push(`npm test importa archivos fuera de los componentes contados (${npmTestTotal} pruebas frente a ${suiteNpm}).`);

  // Rutas del API.
  const codeRoutesByModule = new Map<string, string[]>();
  for (const file of files("pdc", "src/routes").filter((file) => file.endsWith(".ts"))) {
    const found = routesFromSource(read(file) ?? "");
    if (found.length) codeRoutesByModule.set(path.posix.basename(file), found);
  }
  const codeRoutes = [...new Set([...codeRoutesByModule.values()].flat())].sort();
  const contractDoc = read("docs/arquitectura/contrato-api.md");
  if (contractDoc === null) avisos.push("No está docs/arquitectura/contrato-api.md.");
  const contract = routesInContractInventory(contractDoc ?? "");
  const modules = [...new Set([...codeRoutesByModule.keys(), ...contract.byModule.keys()])].sort();

  // Catálogos del código (se cargan del mismo repositorio que el script).
  type KpiModule = typeof import("../src/services/kpi-catalog.js");
  type TelemetryModule = typeof import("../src/services/telemetry-catalog.js");
  type ScenarioModule = typeof import("../src/services/tutor-scenarios.js");
  type TemplateModule = typeof import("../src/services/intervention-templates.js");
  type ComplianceModule = typeof import("../src/services/compliance-checklist.js");
  type SurveyModule = typeof import("../src/services/survey.js");
  const kpiModule = await importOptional<KpiModule>("../src/services/kpi-catalog.js", avisos);
  const telemetryModule = await importOptional<TelemetryModule>("../src/services/telemetry-catalog.js", avisos);
  const scenarioModule = await importOptional<ScenarioModule>("../src/services/tutor-scenarios.js", avisos);
  const templateModule = await importOptional<TemplateModule>("../src/services/intervention-templates.js", avisos);
  const complianceModule = await importOptional<ComplianceModule>("../src/services/compliance-checklist.js", avisos);
  const surveyModule = await importOptional<SurveyModule>("../src/services/survey.js", avisos);

  const kpis = kpiModule?.KPI_CATALOG ?? [];
  const events = telemetryModule?.EVENT_CATALOG ?? [];
  const scenarios = scenarioModule?.TUTOR_SCENARIOS ?? [];
  const compliance = complianceModule?.COMPLIANCE_ITEMS ?? [];
  const surveyCounts: Record<string, number> = { ...(surveyModule?.SURVEY_ITEM_COUNTS ?? {}) };
  const sourceLabel: Record<string, string> = { browser_extension: "extensión de navegador", vscode_extension: "extensión de VS Code", backend: "backend", system: "sistema" };

  // Datos del tutor.
  type QuizItem = { ra?: string; lenguaje?: string };
  const quiz = readJson<{ version?: string; items?: QuizItem[] }>(path.join(root, "data/quiz/banco-fpoo.json"));
  const matrix = readJson<{ version?: string; reglas?: Array<{ recursos?: Array<{ id?: string }> }> }>(path.join(root, "data/rag/matriz-escenario-recurso.json"));
  const ragSeed = read("data/rag/rag_sources_seed.jsonl");
  const typesText = read("src/types/app.ts") ?? "";
  const policyUnion = typesText.match(/export type PolicyEventType =([\s\S]*?);/)?.[1] ?? "";
  const policyEvents = [...policyUnion.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);

  // Versiones.
  const manifest = readJson<{ version?: string; permissions?: string[]; host_permissions?: string[] }>(path.join(root, "browser-ext-prod/manifest.json"));
  const vscodePackage = readJson<{ version?: string; engines?: { vscode?: string }; contributes?: { commands?: unknown[] } }>(path.join(vscodeRoot, "package.json"));
  const pdcPackage = readJson<{ scripts?: Record<string, string> }>(path.join(root, "package.json"));
  const schemaVersion = matchOne(read("src/services/telemetry.ts"), /TELEMETRY_SCHEMA_VERSION\s*=\s*"([^"]+)"/, (m) => m[1]);
  // El instalador de las Mac fija el modelo del piloto y avisa si otro servidor usa uno distinto.
  const model = matchOne(read("deploy/mac/instalar-worker-mac.sh"), /por defecto ([^\s,;]+), el del piloto/, (m) => m[1]);

  // Documentos.
  const docs = files("pdc", "docs").filter((file) => file.endsWith(".md"));
  const vistas = read("docs/arquitectura/vistas.md") ?? "";

  // Líneas de código.
  const lineas: LocCount[] = LOC.map((def) => {
    let fileCount = 0;
    let lines = 0;
    let nonBlank = 0;
    for (const part of def.parts) {
      for (const file of files(part.base, part.dir).filter(part.include)) {
        const counted = countLines(read(file, part.base) ?? "");
        fileCount += 1;
        lines += counted.lines;
        nonBlank += counted.nonBlank;
      }
    }
    return { id: def.id, name: def.name, scope: def.scope, files: fileCount, lines, nonBlank };
  });

  return {
    generadoEn: now.toISOString(),
    git: gitInfo(root, pdcGit),
    submodulo: { ruta: SUBMODULE, ...gitInfo(vscodeRoot, vscodeGit) },
    versiones: {
      extensionNavegador: manifest?.version ?? null,
      extensionVsCode: vscodePackage?.version ?? null,
      vscodeMinimo: vscodePackage?.engines?.vscode ?? null,
      esquemaTelemetria: schemaVersion,
      bancoQuiz: quiz?.version ?? null,
      matrizEscenarios: matrix?.version ?? null,
      modeloPiloto: model,
    },
    pruebas: {
      suites,
      total: suites.reduce((sum, suite) => sum + suite.tests, 0),
      npmTest: npmTestTotal,
      archivosNpmTest: npmTestFiles.size,
    },
    rutas: {
      codigo: codeRoutes.length,
      contrato: contract.routes.length,
      soloEnCodigo: codeRoutes.filter((route) => !contract.routes.includes(route)),
      soloEnContrato: contract.routes.filter((route) => !codeRoutes.includes(route)),
      porMetodo: tally(codeRoutes, (route) => route.split(" ")[0]),
      porModulo: modules.map((modulo) => ({
        modulo,
        codigo: codeRoutesByModule.get(modulo)?.length ?? 0,
        contrato: contract.byModule.get(modulo)?.length ?? 0,
      })),
    },
    telemetria: {
      eventos: events.length,
      utiles: events.filter((entry) => entry.kpis.length > 0).length,
      conDecision: events.filter((entry) => entry.requiresDecision).length,
      categorias: telemetryModule?.TELEMETRY_CATEGORIES.length ?? 0,
      campos: telemetryModule?.FIELD_DICTIONARY.length ?? 0,
      reglasCalidad: telemetryModule?.QUALITY_RULES.length ?? 0,
      porOrigen: tally(events, (entry) => entry.sources.map((source) => sourceLabel[source] ?? source)),
    },
    kpis: {
      total: kpis.length,
      principales: kpis.filter((kpi) => kpi.primary).map((kpi) => kpi.id),
      porDimension: tally(kpis, (kpi) => kpiModule?.KPI_DIMENSION_LABEL[kpi.dimension] ?? kpi.dimension),
      porObjetivo: sortRecord(tally(kpis, (kpi) => kpi.objective)),
      automaticos: kpis.filter((kpi) => kpi.automatic).length,
      manuales: kpis.filter((kpi) => !kpi.automatic).map((kpi) => kpi.id),
      conUmbral: kpis.filter((kpi) => kpi.threshold !== null).length,
      descriptivos: kpis.filter((kpi) => kpi.threshold === null).length,
      umbralPropuesto: kpis.filter((kpi) => kpi.threshold !== null && /^Propuesto/.test(kpi.origin)).length,
    },
    tutor: {
      escenarios: scenarios.map((scenario) => scenario.id),
      peticionesOverlay: scenarios.filter((scenario) => Boolean(scenario.overlay)).length,
      peticionesEditor: scenarios.filter((scenario) => Boolean(scenario.editor)).length,
      etapas: Object.keys(templateModule?.INTERVENTION_TEMPLATES ?? {}),
      eventosPolitica: policyEvents,
      preguntasBanco: quiz?.items?.length ?? 0,
      bancoPorRa: tally(quiz?.items ?? [], (item) => item.ra ?? "sin RA"),
      bancoPorLenguaje: tally(quiz?.items ?? [], (item) => item.lenguaje || "cualquiera"),
      reglasMatriz: matrix?.reglas?.length ?? 0,
      recursosMatriz: new Set((matrix?.reglas ?? []).flatMap((rule) => (rule.recursos ?? []).map((resource) => resource.id ?? ""))).size,
      fuentesRagSemilla: (ragSeed ?? "").split("\n").filter((line) => line.trim() !== "").length,
    },
    piloto: {
      itemsCumplimiento: compliance.length,
      itemsCriticos: compliance.filter((item) => item.critical).length,
      itemsAutomaticos: compliance.filter((item) => item.verification === "automatica").length,
      cumplimientoPorArea: tally(compliance, (item) => complianceModule?.COMPLIANCE_AREA_LABEL[item.area] ?? item.area),
      itemsEncuesta: Object.values(surveyCounts).reduce((sum, value) => sum + value, 0),
      encuestaPorEscala: surveyCounts,
      plantillas: files("pdc", "data/piloto/plantillas").filter((file) => file.endsWith(".csv")).length,
    },
    interfaces: {
      scriptsNpm: Object.keys(pdcPackage?.scripts ?? {}).length,
      comandosVsCode: vscodePackage?.contributes?.commands?.length ?? 0,
      permisosNavegador: manifest?.permissions?.length ?? 0,
      hostsNavegador: manifest?.host_permissions?.length ?? 0,
      contenedoresC4: countTableRows(vistas, "| Contenedor |"),
      documentosMarkdown: docs.length,
    },
    lineas,
    evidencias: evidenceFigures((relative) => read(relative)),
    avisos,
  };
}

// --- Documento ---------------------------------------------------------------------

function spanishDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString("es-CO", { timeZone: "America/Bogota", day: "numeric", month: "long", year: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}

function listRecord(record: Record<string, number>) {
  const entries = Object.entries(record);
  return entries.length ? entries.map(([key, value]) => `${key} ${formatNumber(value)}`).join(", ") : "—";
}

function orDash(value: string | null | undefined) {
  return value ? value : "—";
}

function code(value: string | null | undefined) {
  return value ? `\`${value}\`` : "—";
}

function workingTree(info: GitInfo) {
  if (info.changedFiles === null) return "sin git";
  return info.changedFiles === 0 ? "limpio" : `${info.changedFiles} archivo(s) con cambios sin commit`;
}

export function renderCifrasMarkdown(c: Cifras) {
  const out: string[] = [];
  const loc = (id: string) => c.lineas.find((row) => row.id === id);
  const codeLoc = c.lineas.filter((row) => CODE_LOC_IDS.includes(row.id));
  const codeTotal = codeLoc.reduce((sum, row) => sum + row.nonBlank, 0);
  const suite = (id: string) => c.pruebas.suites.find((row) => row.id === id);
  const vscodeUnit = suite("vscode-unitarias")?.tests ?? 0;

  out.push("# Cifras del repositorio para el documento final");
  out.push("");
  out.push(`> Documento generado con \`${COMMAND}\`. No lo edites a mano: vuelve a correr el comando antes de citar una cifra.`);
  out.push("");
  out.push("| | |");
  out.push("|---|---|");
  out.push("| Jira | A16.2 · ADACEEN-130 (metodología, arquitectura e implementación), A16.5 · ADACEEN-133 (diapositivas y guion) |");
  out.push(`| Fecha | ${spanishDate(c.generadoEn)} (\`${c.generadoEn}\`) |`);
  out.push(`| Commit | PDC ${code(c.git.commit)} en la rama ${code(c.git.branch)}; árbol de trabajo: ${workingTree(c.git)} |`);
  out.push(`| Submódulo | \`${c.submodulo.ruta}\` ${code(c.submodulo.commit)}; árbol de trabajo: ${workingTree(c.submodulo)} |`);
  out.push("| Fuentes | Archivos versionados y nuevos no ignorados del árbol de trabajo; catálogos de `src/services/`; datos de `data/`; documentos de `docs/` |");
  out.push("| Prueba | `tests/scripts/cifras-documento.test.ts` |");
  out.push("");
  out.push("Para que las cifras del documento final sean exactamente las de un commit, corre el comando sobre ese commit sin cambios pendientes: la fila Commit debe decir “limpio”.");
  out.push("");

  out.push("## Resumen para citar");
  out.push("");
  out.push("| Cifra | Valor | Sección |");
  out.push("|---|---|---|");
  out.push(`| Pruebas automatizadas declaradas | ${formatNumber(c.pruebas.total)} | 2 |`);
  out.push(`| Pruebas que corre \`npm test\` en PDC | ${formatNumber(c.pruebas.npmTest)} | 2 |`);
  out.push(`| Pruebas unitarias de la extensión de VS Code | ${formatNumber(vscodeUnit)} | 2 |`);
  out.push(`| Rutas del API en el inventario del contrato | ${formatNumber(c.rutas.contrato)} (en el código: ${formatNumber(c.rutas.codigo)}) | 3 |`);
  out.push(`| Eventos del diccionario de telemetría | ${formatNumber(c.telemetria.eventos)} (${formatNumber(c.telemetria.utiles)} alimentan algún KPI) | 4 |`);
  out.push(`| KPIs del catálogo | ${formatNumber(c.kpis.total)} (principales: ${c.kpis.principales.join(", ") || "—"}) | 5 |`);
  out.push(`| Escenarios del tutor | ${formatNumber(c.tutor.escenarios.length)} (${c.tutor.escenarios.join(", ") || "—"}) | 6 |`);
  out.push(`| Preguntas del banco del mini-quiz | ${formatNumber(c.tutor.preguntasBanco)} | 6 |`);
  out.push(`| Ítems de la lista de cumplimiento | ${formatNumber(c.piloto.itemsCumplimiento)} (${formatNumber(c.piloto.itemsCriticos)} críticos) | 7 |`);
  out.push(`| Extensión de navegador | ${orDash(c.versiones.extensionNavegador)} | 1 |`);
  out.push(`| Extensión de VS Code | ${orDash(c.versiones.extensionVsCode)} | 1 |`);
  out.push(`| Líneas de código sin líneas en blanco (sin pruebas ni documentación) | ${formatNumber(codeTotal)} | 9 |`);
  out.push(`| Líneas de pruebas sin líneas en blanco | ${formatNumber(loc("pruebas")?.nonBlank ?? 0)} | 9 |`);
  out.push("");

  out.push("## 1. Versiones");
  out.push("");
  out.push("| Pieza | Versión | Fuente |");
  out.push("|---|---|---|");
  out.push(`| Extensión de navegador | ${orDash(c.versiones.extensionNavegador)} | \`browser-ext-prod/manifest.json\` |`);
  out.push(`| Extensión de VS Code | ${orDash(c.versiones.extensionVsCode)} (VS Code ${orDash(c.versiones.vscodeMinimo)}) | \`vscode-ext-prod/package.json\` |`);
  out.push(`| Esquema de telemetría | ${orDash(c.versiones.esquemaTelemetria)} | \`TELEMETRY_SCHEMA_VERSION\` en \`src/services/telemetry.ts\` |`);
  out.push(`| Banco del mini-quiz | ${orDash(c.versiones.bancoQuiz)} | \`data/quiz/banco-fpoo.json\` |`);
  out.push(`| Matriz escenario → recurso | ${orDash(c.versiones.matrizEscenarios)} | \`data/rag/matriz-escenario-recurso.json\` |`);
  out.push(`| Modelo de lenguaje del piloto | ${code(c.versiones.modeloPiloto)} | ayuda de \`--modelo\` en \`deploy/mac/instalar-worker-mac.sh\` («el del piloto») |`);
  out.push("");

  out.push("## 2. Pruebas por componente");
  out.push("");
  out.push("Conteo estático de las pruebas declaradas con `node:test` (`test(…)` o `it(…)` al inicio de una línea). Coincide con el total que informa el ejecutor mientras ninguna prueba se genere dentro de un bucle.");
  out.push("");
  out.push("| Componente | Archivos | Pruebas | En `npm test` de PDC | Cómo se corren |");
  out.push("|---|---|---|---|---|");
  for (const row of c.pruebas.suites) {
    out.push(`| ${row.name} | ${formatNumber(row.files)} | ${formatNumber(row.tests)} | ${formatNumber(row.inNpmTest)} | \`${row.command}\` |`);
  }
  out.push(`| **Total** | ${formatNumber(c.pruebas.suites.reduce((sum, row) => sum + row.files, 0))} | **${formatNumber(c.pruebas.total)}** | **${formatNumber(c.pruebas.npmTest)}** | |`);
  out.push("");
  out.push(`\`npm test\` corre los ${formatNumber(c.pruebas.archivosNpmTest)} archivos que importa \`tests/index.test.ts\`.`);
  out.push("");

  out.push("## 3. Rutas del API");
  out.push("");
  out.push(`- Inventario del [contrato de la API](../arquitectura/contrato-api.md) (sección 3): **${formatNumber(c.rutas.contrato)}** rutas.`);
  out.push(`- Registradas en \`src/routes/*.ts\`: **${formatNumber(c.rutas.codigo)}** (${listRecord(c.rutas.porMetodo)}).`);
  out.push(`- En el código y no en el inventario: ${c.rutas.soloEnCodigo.length ? c.rutas.soloEnCodigo.map((route) => `\`${route}\``).join(", ") : "ninguna"}.`);
  out.push(`- En el inventario y no en el código: ${c.rutas.soloEnContrato.length ? c.rutas.soloEnContrato.map((route) => `\`${route}\``).join(", ") : "ninguna"}.`);
  out.push("");
  out.push("| Módulo | Rutas en el código | Rutas en el contrato |");
  out.push("|---|---|---|");
  for (const row of c.rutas.porModulo) out.push(`| \`${row.modulo}\` | ${formatNumber(row.codigo)} | ${formatNumber(row.contrato)} |`);
  out.push("");

  out.push("## 4. Telemetría");
  out.push("");
  out.push("Fuente: `src/services/telemetry-catalog.ts`, del que sale el [diccionario de eventos](../telemetria/diccionario-eventos.md).");
  out.push("");
  out.push("| Cifra | Valor |");
  out.push("|---|---|");
  out.push(`| Eventos del catálogo | ${formatNumber(c.telemetria.eventos)} |`);
  out.push(`| Eventos que alimentan algún KPI (lo que mide T12) | ${formatNumber(c.telemetria.utiles)} |`);
  out.push(`| Eventos que deben llevar \`decisionId\` | ${formatNumber(c.telemetria.conDecision)} |`);
  out.push(`| Eventos por origen (un evento puede tener varios) | ${listRecord(c.telemetria.porOrigen)} |`);
  out.push(`| Categorías | ${formatNumber(c.telemetria.categorias)} |`);
  out.push(`| Columnas del diccionario de campos | ${formatNumber(c.telemetria.campos)} |`);
  out.push(`| Reglas de calidad | ${formatNumber(c.telemetria.reglasCalidad)} |`);
  out.push("");

  out.push("## 5. KPIs");
  out.push("");
  out.push("Fuente: `src/services/kpi-catalog.ts`, del que sale el [catálogo de KPIs](../metricas/catalogo-kpis.md).");
  out.push("");
  out.push("| Cifra | Valor |");
  out.push("|---|---|");
  out.push(`| KPIs | ${formatNumber(c.kpis.total)} |`);
  out.push(`| Principales | ${c.kpis.principales.join(", ") || "—"} |`);
  out.push(`| Por dimensión | ${listRecord(c.kpis.porDimension)} |`);
  out.push(`| Por objetivo específico | ${listRecord(c.kpis.porObjetivo)} |`);
  out.push(`| Automáticos (\`npm run piloto:analisis\`) | ${formatNumber(c.kpis.automaticos)} |`);
  out.push(`| Manuales (plantillas del piloto) | ${formatNumber(c.kpis.manuales.length)} (${c.kpis.manuales.join(", ") || "—"}) |`);
  out.push(`| Con umbral | ${formatNumber(c.kpis.conUmbral)}, de ellos ${formatNumber(c.kpis.umbralPropuesto)} con umbral propuesto (no está en el anteproyecto) |`);
  out.push(`| Descriptivos (sin umbral) | ${formatNumber(c.kpis.descriptivos)} |`);
  out.push("");

  out.push("## 6. Tutor");
  out.push("");
  out.push("| Cifra | Valor | Fuente |");
  out.push("|---|---|---|");
  out.push(`| Escenarios | ${formatNumber(c.tutor.escenarios.length)}: ${c.tutor.escenarios.join(", ") || "—"} | \`src/services/tutor-scenarios.ts\` |`);
  out.push(`| Peticiones de los escenarios | ${formatNumber(c.tutor.peticionesOverlay)} del overlay y ${formatNumber(c.tutor.peticionesEditor)} del editor | \`src/services/tutor-scenarios.ts\` |`);
  out.push(`| Etapas de ayuda | ${formatNumber(c.tutor.etapas.length)}: ${c.tutor.etapas.map((stage) => `\`${stage}\``).join(", ") || "—"} | \`src/services/intervention-templates.ts\` |`);
  out.push(`| Tipos de evento de política | ${formatNumber(c.tutor.eventosPolitica.length)}: ${c.tutor.eventosPolitica.map((event) => `\`${event}\``).join(", ") || "—"} | \`PolicyEventType\` en \`src/types/app.ts\` |`);
  out.push(`| Preguntas del banco del mini-quiz | ${formatNumber(c.tutor.preguntasBanco)} (${listRecord(c.tutor.bancoPorRa)}; ${listRecord(c.tutor.bancoPorLenguaje)}) | \`data/quiz/banco-fpoo.json\` |`);
  out.push(`| Reglas de la matriz escenario → recurso | ${formatNumber(c.tutor.reglasMatriz)}, con ${formatNumber(c.tutor.recursosMatriz)} recursos distintos | \`data/rag/matriz-escenario-recurso.json\` |`);
  out.push(`| Fuentes del material autorizado (semilla) | ${formatNumber(c.tutor.fuentesRagSemilla)} | \`data/rag/rag_sources_seed.jsonl\` |`);
  out.push("");

  out.push("## 7. Piloto y gobernanza");
  out.push("");
  out.push("| Cifra | Valor | Fuente |");
  out.push("|---|---|---|");
  out.push(`| Ítems de la lista de cumplimiento | ${formatNumber(c.piloto.itemsCumplimiento)} (${listRecord(c.piloto.cumplimientoPorArea)}) | \`src/services/compliance-checklist.ts\` |`);
  out.push(`| Ítems críticos / de verificación automática | ${formatNumber(c.piloto.itemsCriticos)} / ${formatNumber(c.piloto.itemsAutomaticos)} | \`src/services/compliance-checklist.ts\` |`);
  out.push(`| Ítems cerrados de la encuesta final | ${formatNumber(c.piloto.itemsEncuesta)} (${listRecord(c.piloto.encuestaPorEscala)}) | \`SURVEY_ITEM_COUNTS\` en \`src/services/survey.ts\` |`);
  out.push(`| Plantillas CSV del piloto | ${formatNumber(c.piloto.plantillas)} | \`data/piloto/plantillas/\` |`);
  out.push("");

  out.push("## 8. Interfaces y documentación");
  out.push("");
  out.push("| Cifra | Valor | Fuente |");
  out.push("|---|---|---|");
  out.push(`| Contenedores de la vista C4 | ${formatNumber(c.interfaces.contenedoresC4)} | tabla de [vistas](../arquitectura/vistas.md), sección 1 |`);
  out.push(`| Comandos de la extensión de VS Code | ${formatNumber(c.interfaces.comandosVsCode)} | \`contributes.commands\` de \`vscode-ext-prod/package.json\` |`);
  out.push(`| Permisos y hosts de la extensión de navegador | ${formatNumber(c.interfaces.permisosNavegador)} permisos, ${formatNumber(c.interfaces.hostsNavegador)} hosts | \`browser-ext-prod/manifest.json\` |`);
  out.push(`| Scripts de \`npm run\` en PDC | ${formatNumber(c.interfaces.scriptsNpm)} | \`package.json\` |`);
  out.push(`| Documentos Markdown en \`docs/\` | ${formatNumber(c.interfaces.documentosMarkdown)} | \`docs/**/*.md\` |`);
  out.push("");

  out.push("## 9. Líneas por componente");
  out.push("");
  out.push("**Líneas** son las líneas físicas de cada archivo; **sin blanco** descuenta las vacías (los comentarios cuentan).");
  out.push("");
  out.push("| Componente | Alcance | Archivos | Líneas | Sin blanco |");
  out.push("|---|---|---|---|---|");
  for (const row of c.lineas) out.push(`| ${row.name} | ${row.scope} | ${formatNumber(row.files)} | ${formatNumber(row.lines)} | ${formatNumber(row.nonBlank)} |`);
  out.push(`| **Código (sin pruebas ni documentación)** | | ${formatNumber(codeLoc.reduce((sum, row) => sum + row.files, 0))} | ${formatNumber(codeLoc.reduce((sum, row) => sum + row.lines, 0))} | **${formatNumber(codeTotal)}** |`);
  out.push("");

  out.push("## 10. Cifras de las evidencias ya generadas");
  out.push("");
  out.push("Se leen de los documentos de `docs/evidencias/`; cada uno dice con qué comando se generó y contra qué backend. Ninguna es un resultado del piloto.");
  out.push("");
  out.push("| Documento | Cifra | Valor |");
  out.push("|---|---|---|");
  for (const row of c.evidencias) out.push(`| [${row.documento}](${row.documento}) | ${row.cifra} | ${row.valor ?? "no encontrado"} |`);
  out.push("");

  out.push("## Avisos");
  out.push("");
  if (c.avisos.length) for (const aviso of c.avisos) out.push(`- ${aviso}`);
  else out.push("- Ninguno.");
  out.push("");
  return out.join("\n");
}

export async function writeCifras(target: string, cifras: Cifras) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, renderCifrasMarkdown(cifras), "utf8");
}

export async function main(argv = process.argv.slice(2)) {
  const salida = argv.find((arg) => arg.startsWith("--salida="))?.slice("--salida=".length);
  const unknown = argv.filter((arg) => arg !== "--json" && !arg.startsWith("--salida="));
  if (unknown.length) {
    console.error(`[cifras] Opción desconocida: ${unknown.join(" ")}. Uso: ${COMMAND} [--salida=<ruta>] [--json]`);
    process.exitCode = 1;
    return;
  }
  const cifras = await collectCifras();
  if (argv.includes("--json")) {
    console.log(JSON.stringify(cifras, null, 2));
    return;
  }
  const target = path.resolve(process.cwd(), salida || path.join(REPO_ROOT, DEFAULT_OUTPUT));
  await writeCifras(target, cifras);
  console.log(`[cifras] Escrito ${path.relative(process.cwd(), target) || target} (commit ${cifras.git.commit ?? "sin git"}, ${workingTree(cifras.git)}).`);
  for (const aviso of cifras.avisos) console.log(`[cifras] Aviso: ${aviso}`);
}

const isDirectRun = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

if (isDirectRun) {
  main().catch((error) => {
    console.error("[cifras] Fallo:", error);
    process.exitCode = 1;
  });
}
