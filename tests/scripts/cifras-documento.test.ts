import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectCifras,
  countLines,
  countTableRows,
  countTestsInSource,
  DEFAULT_OUTPUT,
  evidenceFigures,
  formatNumber,
  importsOfTestIndex,
  main,
  renderCifrasMarkdown,
  routesFromSource,
  routesInContractInventory,
  writeCifras,
} from "../../scripts/cifras-documento.js";
import { KPI_CATALOG } from "../../src/services/kpi-catalog.js";
import { EVENT_CATALOG } from "../../src/services/telemetry-catalog.js";
import { TUTOR_SCENARIOS } from "../../src/services/tutor-scenarios.js";

/**
 * A16.2 · ADACEEN-130 y A16.5 · ADACEEN-133: las cifras que cita el documento
 * final salen de un comando reproducible (npx tsx scripts/cifras-documento.ts)
 * y no de conteos a mano; el guion y las diapositivas de docs/sustentacion solo
 * citan textos, rutas y comandos que existen, y el guion cabe en 30 minutos.
 */

const FIXED_DATE = new Date("2026-09-25T15:00:00.000Z");

test("cifras: conteo de pruebas, lineas, numeros y filas de tabla", () => {
  const source = [
    'import test from "node:test";',
    'test("uno", () => {});',
    "  test.skip('dos', () => {});",
    "describe('grupo', () => {",
    "  it('tres', () => {});",
    "  it.only('cuatro', () => {});",
    "});",
    "// una prueba(test) en un comentario no cuenta",
    "const latest = attest('x');",
  ].join("\n");
  assert.equal(countTestsInSource(source), 4);
  assert.deepEqual(countLines("a\n\n  \nb\n"), { lines: 4, nonBlank: 2 });
  assert.deepEqual(countLines("a\r\nb"), { lines: 2, nonBlank: 2 });
  assert.deepEqual(countLines(""), { lines: 0, nonBlank: 0 });
  assert.equal(formatNumber(7034), "7034");
  assert.equal(formatNumber(75039), "75 039");
  assert.equal(formatNumber(1234567), "1 234 567");
  const table = "texto\n| Contenedor | X |\n|---|---|\n| A | 1 |\n| B | 2 |\n\n| C | 3 |";
  assert.equal(countTableRows(table, "| Contenedor |"), 2);
  assert.equal(countTableRows(table, "| Otra |"), 0);
});

test("cifras: rutas del codigo, inventario del contrato e importaciones de npm test", () => {
  const routeSource = [
    'const POLICY = "/privacy-policy";',
    'app.get("/api/a", handler);',
    'app.post(["/intervene", "/github-mentor"], handler);',
    "app.get(`${POLICY}.json`, handler);",
    "app.delete(\"/api/a/:id\", handler);",
  ].join("\n");
  assert.deepEqual(routesFromSource(routeSource), ["DELETE /api/a/:id", "GET /api/a", "GET /privacy-policy.json", "POST /github-mentor", "POST /intervene"]);

  const doc = [
    "## 2. Interfaces",
    "- `POST /workspaces` del agente y `GET /user` de GitHub no son rutas del API.",
    "## 3. Inventario de rutas",
    "| Módulo | Rutas | Para qué |",
    "|---|---|---|",
    "| `agent-routes.ts` | `POST /intervene`, `POST /github-mentor` | Tutor |",
    "| | `GET /api/agent/health` | Salud |",
    "| `rag-routes.ts` | `GET /api/rag/sources/:id/view` | Ver |",
    "## 4. Cómo mantenerlo",
    "`GET /no-cuenta`",
  ].join("\n");
  const inventory = routesInContractInventory(doc);
  assert.deepEqual(inventory.routes, ["GET /api/agent/health", "GET /api/rag/sources/:id/view", "POST /github-mentor", "POST /intervene"]);
  assert.deepEqual(inventory.byModule.get("agent-routes.ts"), ["POST /intervene", "POST /github-mentor", "GET /api/agent/health"]);
  assert.deepEqual(routesInContractInventory("sin inventario").routes, []);

  const index = 'import "./scripts/a.test.js";\nimport "../deploy/x/b.test.mjs";\nimport "./routes/c.test.js";\n';
  const existing = new Set(["tests/scripts/a.test.ts"]);
  assert.deepEqual(importsOfTestIndex(index, (relative) => existing.has(relative)), [
    "tests/scripts/a.test.ts",
    "deploy/x/b.test.mjs",
    "tests/routes/c.test.js",
  ]);
});

test("cifras: el repositorio da cifras coherentes con los catalogos y archivos", async () => {
  const cifras = await collectCifras({ now: FIXED_DATE });
  const root = process.cwd();
  const manifest = JSON.parse(readFileSync(path.join(root, "browser-ext-prod/manifest.json"), "utf8")) as { version: string };
  const quiz = JSON.parse(readFileSync(path.join(root, "data/quiz/banco-fpoo.json"), "utf8")) as { items: unknown[] };

  assert.equal(cifras.generadoEn, FIXED_DATE.toISOString());
  assert.match(cifras.git.commit ?? "", /^[0-9a-f]{7}$/, "falta el commit de PDC");
  assert.equal(cifras.versiones.extensionNavegador, manifest.version);
  assert.equal(cifras.versiones.esquemaTelemetria, "1.1");
  assert.equal(cifras.versiones.modeloPiloto, "qwen2.5-coder:14b");

  // Pruebas: cada componente suma al total y npm test cuenta lo que importa el índice.
  assert.equal(cifras.pruebas.total, cifras.pruebas.suites.reduce((sum, suite) => sum + suite.tests, 0));
  assert.equal(cifras.pruebas.npmTest, cifras.pruebas.suites.reduce((sum, suite) => sum + suite.inNpmTest, 0));
  assert.ok(cifras.pruebas.npmTest > 200, `npm test deberia tener mas de 200 pruebas y se contaron ${cifras.pruebas.npmTest}`);
  const indexImports = readFileSync(path.join(root, "tests/index.test.ts"), "utf8").match(/^import /gm)?.length ?? 0;
  assert.equal(cifras.pruebas.archivosNpmTest, indexImports);
  const ownTests = countTestsInSource(readFileSync(path.join(root, "tests/scripts/cifras-documento.test.ts"), "utf8"));
  const scriptsSuite = cifras.pruebas.suites.find((suite) => suite.id === "scripts-docs");
  assert.ok(scriptsSuite && scriptsSuite.tests >= ownTests, "las pruebas de tests/scripts no se contaron");
  for (const suite of cifras.pruebas.suites) {
    assert.ok(suite.inNpmTest <= suite.tests, `${suite.id}: mas pruebas en npm test que declaradas`);
    // La columna «Cómo se corren» va entre comillas invertidas: tiene que poderse copiar tal cual.
    assert.ok(!/[()]/.test(suite.command), `${suite.id}: el comando no se puede copiar tal cual: ${suite.command}`);
  }

  // Rutas: el inventario del contrato y el código coinciden (lo exige también contrato-api.test.ts).
  assert.ok(cifras.rutas.codigo >= 100, `se esperaban mas de 100 rutas y se leyeron ${cifras.rutas.codigo}`);
  assert.equal(cifras.rutas.codigo, Object.values(cifras.rutas.porMetodo).reduce((sum, value) => sum + value, 0));
  assert.deepEqual(cifras.rutas.soloEnCodigo, [], "hay rutas del codigo fuera del inventario del contrato");

  // Catálogos.
  assert.equal(cifras.kpis.total, KPI_CATALOG.length);
  assert.deepEqual(cifras.kpis.principales, KPI_CATALOG.filter((kpi) => kpi.primary).map((kpi) => kpi.id));
  assert.equal(cifras.kpis.automaticos + cifras.kpis.manuales.length, cifras.kpis.total);
  assert.equal(cifras.kpis.conUmbral + cifras.kpis.descriptivos, cifras.kpis.total);
  assert.equal(cifras.telemetria.eventos, EVENT_CATALOG.length);
  assert.equal(cifras.tutor.escenarios.length, TUTOR_SCENARIOS.length);
  assert.equal(cifras.tutor.preguntasBanco, quiz.items.length);
  assert.equal(Object.values(cifras.tutor.bancoPorRa).reduce((sum, value) => sum + value, 0), quiz.items.length);
  assert.ok(cifras.tutor.etapas.includes("hint_1") && cifras.tutor.etapas.includes("controlled"));
  assert.ok(cifras.tutor.eventosPolitica.includes("out_of_domain"));
  assert.ok(cifras.interfaces.contenedoresC4 >= 5, "no se leyeron los contenedores de la vista C4");

  // Líneas y evidencias.
  for (const row of cifras.lineas) {
    assert.ok(row.files > 0, `${row.id}: sin archivos`);
    assert.ok(row.nonBlank <= row.lines, `${row.id}: mas lineas sin blanco que lineas`);
  }
  for (const figure of cifras.evidencias) assert.ok(figure.valor, `no se encontro «${figure.cifra}» en ${figure.documento}`);
  assert.deepEqual(cifras.avisos, []);
});

test("cifras: el documento lleva fecha, commit y todas las secciones, y se escribe donde se pide", async () => {
  const cifras = await collectCifras({ now: FIXED_DATE });
  const markdown = renderCifrasMarkdown(cifras);
  assert.match(markdown, /^# Cifras del repositorio para el documento final/);
  assert.ok(markdown.includes("npx tsx scripts/cifras-documento.ts"));
  assert.ok(markdown.includes("25 de septiembre de 2026"), "falta la fecha en espanol");
  assert.ok(markdown.includes("`2026-09-25T15:00:00.000Z`"));
  assert.ok(markdown.includes(`\`${cifras.git.commit}\``), "falta el commit");
  for (const heading of ["## Resumen para citar", "## 1. Versiones", "## 2. Pruebas por componente", "## 3. Rutas del API", "## 4. Telemetría", "## 5. KPIs", "## 6. Tutor", "## 7. Piloto y gobernanza", "## 8. Interfaces y documentación", "## 9. Líneas por componente", "## 10. Cifras de las evidencias ya generadas", "## Avisos"]) {
    assert.ok(markdown.includes(`\n${heading}\n`), `falta la seccion ${heading}`);
  }
  assert.ok(!/undefined|NaN|\[object Object\]/.test(markdown), "el documento tiene valores sin resolver");

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "adaceen-cifras-"));
  try {
    const target = path.join(dir, "sub", "cifras.md");
    await writeCifras(target, cifras);
    assert.equal(await fsp.readFile(target, "utf8"), markdown);

    const viaMain = path.join(dir, "main.md");
    const log = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      await main([`--salida=${viaMain}`]);
    } finally {
      console.log = log;
    }
    const written = await fsp.readFile(viaMain, "utf8");
    assert.ok(written.startsWith("# Cifras del repositorio para el documento final"));
    assert.ok(lines.some((line) => line.includes("[cifras] Escrito")));
    assert.equal(DEFAULT_OUTPUT, "docs/evidencias/cifras-documento.md");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// --- Guion y diapositivas de la sustentación (docs/sustentacion) ------------------------
// Lo que citan tiene que existir: textos entre «» en el código, rutas del repositorio,
// enlaces relativos con su ancla y los `npm run …`. "<...>" es una parte que cambia y
// "…" un recorte; los tramos fijos van en orden y en un mismo archivo.

const SUSTENTACION = ["docs/sustentacion/guion.md", "docs/sustentacion/diapositivas.md"];

function listTree(dir: string, accept: (file: string) => boolean, skip = new Set<string>()): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && !skip.has(entry.name)) out.push(...listTree(full, accept, skip));
    } else if (accept(full)) {
      out.push(full);
    }
  }
  return out;
}

function codeCorpus(root: string) {
  const files = [
    ...listTree(path.join(root, "browser-ext-prod"), (file) => /\.(js|html|json)$/.test(file)),
    ...listTree(path.join(root, "vscode-ext-prod", "src"), (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"), new Set(["test", "unit-tests"])),
    path.join(root, "vscode-ext-prod", "package.json"),
    ...listTree(path.join(root, "src"), (file) => file.endsWith(".ts")),
    ...listTree(path.join(root, "scripts"), (file) => /\.(ts|mjs)$/.test(file)),
    ...listTree(path.join(root, "deploy"), (file) => /\.(sh|command|mjs)$/.test(file) && !file.endsWith(".test.mjs")),
  ];
  return files.filter((file) => fs.existsSync(file)).map((file) => fs.readFileSync(file, "utf8").replace(/\\"/g, "\"").replace(/\\'/g, "'"));
}

function quotedTexts(markdown: string) {
  return [...new Set([...markdown.replace(/\\\|/g, "|").matchAll(/«([^«»]+)»/g)].map((match) => match[1].replace(/\s+/g, " ").trim()))];
}

function fixedParts(text: string) {
  return text.split(/<[^<>]+>|…/).map((part) => part.trim()).filter(Boolean);
}

function appearsInCode(text: string, sources: string[]) {
  const parts = fixedParts(text);
  if (!parts.length) return false;
  return sources.some((source) => {
    let from = 0;
    for (const part of parts) {
      const at = source.indexOf(part, from);
      if (at < 0) return false;
      from = at + part.length;
    }
    return true;
  });
}

function repoPaths(markdown: string) {
  const found = new Set<string>();
  const pattern = /(?<![\w./~<-])((?:deploy|scripts|docs|data|src|tests|browser-ext-prod|vscode-ext-prod|\.github)\/[A-Za-z0-9._/-]+)/g;
  for (const match of markdown.matchAll(pattern)) {
    const next = markdown[(match.index ?? 0) + match[0].length] || "";
    if (next === "<" || next === "*") continue;
    found.add(match[1].replace(/[.,;:)]+$/, "").replace(/\/+$/, ""));
  }
  return [...found];
}

function anchor(title: string) {
  return title.trim().toLowerCase().replace(/`/g, "").replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-");
}

function anchorsOf(markdown: string) {
  return new Set([...markdown.matchAll(/^#{1,6} (.+)$/gm)].map((match) => anchor(match[1])));
}

test("sustentacion: ayudas del chequeo de textos, rutas y anclas", () => {
  assert.deepEqual(quotedTexts("Pulsa «Abrir mi\n  editor» y «A \\| B»."), ["Abrir mi editor", "A | B"]);
  assert.deepEqual(fixedParts("ADACEEN: ¿Aplicar el cambio del tutor…?"), ["ADACEEN: ¿Aplicar el cambio del tutor", "?"]);
  assert.equal(appearsInCode("GPU: <servidor>", ["`GPU: ${origin.label}`"]), true);
  assert.equal(appearsInCode("…", ["…"]), false);
  assert.equal(appearsInCode("Hola <x>, adios", ["adios", "Hola"]), false);
  assert.deepEqual(repoPaths("`src/a.ts`, `<repo>/src/cuenta.cpp`, `deploy/x/*.test.mjs` y docs/b.md."), ["src/a.ts", "docs/b.md"]);
  assert.equal(anchor("Demostración 1: ayuda gradual y aplicación con confirmación en VS Code"), "demostración-1-ayuda-gradual-y-aplicación-con-confirmación-en-vs-code");
});

test("sustentacion: guion y diapositivas citan textos, rutas, enlaces y comandos que existen", () => {
  const root = process.cwd();
  const sources = codeCorpus(root);
  assert.ok(sources.length > 60, "no se encontraron los fuentes (¿falta el submodulo vscode-ext-prod?)");
  const rootScripts = Object.keys((JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts);
  const vscodeScripts = Object.keys((JSON.parse(readFileSync(path.join(root, "vscode-ext-prod/package.json"), "utf8")) as { scripts: Record<string, string> }).scripts);
  const problems: string[] = [];
  let quotedTotal = 0;
  for (const doc of SUSTENTACION) {
    const markdown = readFileSync(path.join(root, doc), "utf8");
    const texts = quotedTexts(markdown);
    quotedTotal += texts.length;
    for (const text of texts) if (!appearsInCode(text, sources)) problems.push(`${doc}: «${text}» no esta en el codigo`);
    for (const repoPath of repoPaths(markdown)) if (!fs.existsSync(path.join(root, repoPath))) problems.push(`${doc}: no existe ${repoPath}`);
    for (const match of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (/^[a-z]+:/i.test(target)) continue;
      const [file, hash] = target.split("#");
      const targetPath = file ? path.resolve(path.dirname(path.join(root, doc)), file) : path.join(root, doc);
      if (!fs.existsSync(targetPath)) {
        problems.push(`${doc}: enlace roto ${target}`);
        continue;
      }
      if (hash && targetPath.endsWith(".md") && !anchorsOf(readFileSync(targetPath, "utf8")).has(decodeURIComponent(hash))) {
        problems.push(`${doc}: ancla que no existe ${target}`);
      }
    }
    for (const match of markdown.matchAll(/npm run ([a-z][\w:-]*)/g)) {
      if (!rootScripts.includes(match[1]) && !vscodeScripts.includes(match[1])) problems.push(`${doc}: no existe npm run ${match[1]}`);
    }
    // Solo los marcadores de la leyenda del guion: buscarlos tiene que encontrar todo lo pendiente.
    for (const match of markdown.matchAll(/\[(por\s+[a-záéíóúñ]+)/gi)) {
      if (match[1].replace(/\s+/g, " ") !== "por verificar") problems.push(`${doc}: marcador fuera de la leyenda [${match[1]}; usar [por verificar: …]`);
    }
  }
  assert.ok(quotedTotal >= 30, `los documentos citan solo ${quotedTotal} textos entre «»`);
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("sustentacion: el guion cabe en 30 minutos y cada diapositiva tiene su tiempo", () => {
  const guion = readFileSync(path.join(process.cwd(), "docs/sustentacion/guion.md"), "utf8");
  const seconds = (value: string) => {
    const [min, sec] = value.split(":").map(Number);
    return min * 60 + sec;
  };
  const rows = [...guion.matchAll(/^\| (\d+) \| [^|]+ \| [^|]+ \| (\d+:\d{2}) \| (\d+:\d{2}) \|$/gm)];
  assert.ok(rows.length >= 15, `la tabla de tiempos tiene solo ${rows.length} filas`);
  let clock = 0;
  for (const [, number, time, total] of rows) {
    clock += seconds(time);
    assert.equal(clock, seconds(total), `diapositiva ${number}: el reloj acumulado no cuadra`);
  }
  assert.ok(clock <= 27 * 60, `el guion dura ${clock} s y debe dejar margen dentro de 30 min`);
  const headings = [...guion.matchAll(/^### (\d+)\. .+ · (\d+:\d{2}) \(reloj (\d+:\d{2})\)$/gm)];
  assert.equal(headings.length, rows.length, "cada fila de la tabla debe tener su seccion en el guion");
  for (const [, number, time, total] of headings) {
    const row = rows.find((match) => match[1] === number);
    assert.ok(row && row[2] === time && row[3] === total, `diapositiva ${number}: el tiempo de la seccion no es el de la tabla`);
  }
  const demos = [...guion.matchAll(/^### Demostración (\d): /gm)].map((match) => match[1]);
  assert.deepEqual(demos, ["1", "2", "3", "4", "5"]);
  assert.ok(guion.includes("[RESULTADO PENDIENTE:"), "faltan los marcadores de resultados del piloto");
  assert.ok(guion.includes("## Plan B si el piloto no alcanza"));
});

test("cifras: sin git recorre las carpetas y avisa lo que falta en vez de fallar", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "adaceen-cifras-sin-git-"));
  try {
    const write = async (relative: string, text: string) => {
      await fsp.mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
      await fsp.writeFile(path.join(dir, relative), text, "utf8");
    };
    await write("tests/index.test.ts", 'import "./services/a.test.js";\nimport "./routes/falta.test.js";\n');
    await write("tests/services/a.test.ts", 'test("a", () => {});\ntest("b", () => {});\n');
    await write("tests/services/node_modules/ignorada.test.ts", 'test("no", () => {});\n');
    await write("src/routes/x-routes.ts", 'app.get("/api/x", h);\napp.post("/api/y", h);\n');
    await write("docs/arquitectura/contrato-api.md", "## 3. Inventario de rutas\n\n| Módulo | Rutas |\n|---|---|\n| `x-routes.ts` | `GET /api/x` |\n");
    await write("docs/evidencias/demo-escenarios.md", "- Fecha: 2026-01-01T00:00:00Z\n- Resultado: 3 de 4 comprobaciones correctas\n");

    const cifras = await collectCifras({ root: dir, now: FIXED_DATE, useGit: false });
    assert.equal(cifras.git.commit, null);
    const services = cifras.pruebas.suites.find((suite) => suite.id === "backend-servicios");
    assert.deepEqual({ files: services?.files, tests: services?.tests, inNpmTest: services?.inNpmTest }, { files: 1, tests: 2, inNpmTest: 2 });
    assert.equal(cifras.pruebas.npmTest, 2);
    assert.equal(cifras.rutas.codigo, 2);
    assert.equal(cifras.rutas.contrato, 1);
    assert.deepEqual(cifras.rutas.soloEnCodigo, ["POST /api/y"]);
    assert.equal(cifras.versiones.extensionNavegador, null);
    assert.equal(evidenceFigures((relative) => (relative.endsWith("demo-escenarios.md") ? "- Resultado: 3 de 4 comprobaciones correctas" : null))[0].valor, "3 de 4");
    assert.equal(cifras.evidencias[0].valor, "3 de 4");
    assert.ok(cifras.avisos.some((aviso) => aviso.includes("vscode-ext-prod")), "no avisa que falta el submodulo");
    assert.ok(cifras.avisos.some((aviso) => aviso.includes("tests/routes/falta.test.js")), "no avisa la importacion rota");

    const markdown = renderCifrasMarkdown(cifras);
    assert.ok(markdown.includes("sin git"));
    assert.ok(markdown.includes("`POST /api/y`"));
    assert.ok(markdown.includes("no encontrado"));
    assert.ok(!/undefined|NaN/.test(markdown));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
