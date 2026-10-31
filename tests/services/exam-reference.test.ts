import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { gzipSync } from "node:zlib";
import { createApp } from "../../src/app.js";
import { env } from "../../src/config/env.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { setTextModelOverrideForTests } from "../../src/services/agent-mode.js";
import {
  buildExamReferenceBlock,
  describeExamReference,
  guardExamReferenceLeak,
  keepFirstCodeBlock,
  loadExamReference,
  matchesExamRepo,
  parseExamReference,
  resolveExamReferenceForRequest,
  resolveExamStep,
  type ExamReference,
} from "../../src/services/exam-reference.js";
import { buildMentorPrompt } from "../../src/services/mentor-core.js";
import { buildCursorSelectionSuggestionPrompt } from "../../src/services/tab-suggestion-prompt.js";
import { promptBudgetChars } from "../../src/services/text-generation.js";

/**
 * Referencia privada del examen del 28-10-2026 (exam-reference.ts). La solucion real NO esta en
 * el repositorio (es publico): llega por EXAM_REFERENCE_B64. Aqui se usa una referencia de juguete
 * con la misma forma.
 */

const FAKE: ExamReference = {
  version: 1,
  examen: "prueba",
  repo: "eydersantiago/sistema-bancario-fpoo",
  plan: "Plan: 1. Cliente 2. Cuenta",
  errores: "Errores: falta ; al final de la clase",
  pasos: [
    { id: "cliente", titulo: "Paso 1 - Cliente", archivos: ["src/modelo/Cliente.h", "src/modelo/Cliente.cpp"], apoyo: [], guia: "GUIA-CLIENTE", patrones: [] },
    { id: "cuenta", titulo: "Paso 2 - Cuenta", archivos: ["src/modelo/Cuenta.h", "src/modelo/Cuenta.cpp"], apoyo: [], guia: "GUIA-CUENTA", patrones: [] },
    { id: "cuentacorriente", titulo: "Paso 4 - CuentaCorriente", archivos: ["src/modelo/CuentaCorriente.h", "src/modelo/CuentaCorriente.cpp"], apoyo: ["src/modelo/Cuenta.h"], guia: "GUIA-CORRIENTE", patrones: ["corriente"] },
    { id: "main", titulo: "Paso 7 - main", archivos: ["src/main.cpp"], apoyo: [], guia: "GUIA-MAIN", patrones: [] },
  ],
  archivos: {
    "src/modelo/Cliente.h": "class Cliente {\n  // comentario\n  string nombre;\n};",
    "src/modelo/Cliente.cpp": "IMPL-CLIENTE-CPP",
    "src/modelo/Cuenta.h": "class Cuenta {\n  long saldo;\n  virtual bool retirarDinero(long cantidad);\n};",
    "src/modelo/Cuenta.cpp": "IMPL-CUENTA-CPP",
    "src/modelo/CuentaCorriente.h": "class CuentaCorriente : public Cuenta {};",
    "src/modelo/CuentaCorriente.cpp": "IMPL-CORRIENTE-CPP",
    "src/main.cpp": "IMPL-MAIN",
  },
};

function encode(value: unknown) {
  return gzipSync(Buffer.from(JSON.stringify(value), "utf8")).toString("base64");
}

/** EXAM_REFERENCE_B64 y EXAM_REFERENCE llegan por config/env.ts: la prueba cambia esos campos. */
function withEnv<T>(values: { b64?: string; mode?: string }, run: () => T): T {
  const previous = { b64: env.examReferenceB64, mode: env.examReferenceSwitch };
  env.examReferenceB64 = values.b64 ?? "";
  env.examReferenceSwitch = values.mode ?? "";
  try {
    return run();
  } finally {
    env.examReferenceB64 = previous.b64;
    env.examReferenceSwitch = previous.mode;
  }
}

const ACCESS = { channel: "editor" as const, authenticated: true, policyActive: true };

test("referencia del examen: se lee de EXAM_REFERENCE_B64 y sin ella (o apagada o rota) no hay nada", () => {
  const parsed = parseExamReference(encode(FAKE));
  assert.equal(parsed?.repo, FAKE.repo);
  assert.equal(parsed?.pasos.length, 4);
  assert.equal(parseExamReference("esto-no-es-gzip"), null, "nunca lanza");
  assert.equal(parseExamReference(""), null);

  withEnv({}, () => {
    assert.equal(loadExamReference(), null);
    assert.deepEqual(describeExamReference(), { exam_reference_loaded: false });
    assert.equal(resolveExamReferenceForRequest({ repoFullName: FAKE.repo, filePath: "src/modelo/Cuenta.cpp" }, ACCESS), null);
  });
  for (const mode of ["off", "OFF", "false", "0"]) {
    withEnv({ b64: encode(FAKE), mode }, () => assert.equal(loadExamReference(), null, mode));
  }
  withEnv({ b64: "esto-no-es-gzip" }, () => {
    assert.equal(loadExamReference(), null);
    assert.equal(resolveExamReferenceForRequest({ repoFullName: FAKE.repo, filePath: "src/main.cpp" }, ACCESS), null);
  });
  withEnv({ b64: encode({ ...FAKE, pasos: "mal" }) }, () => {
    assert.equal(loadExamReference(), null);
  });
  withEnv({ b64: encode(FAKE) }, () => {
    assert.equal(loadExamReference()?.repo, FAKE.repo);
    assert.deepEqual(describeExamReference(), { exam_reference_loaded: true });
  });
});

test("referencia del examen: una sola puerta; sin sesion o sin politica no hay referencia", () => {
  withEnv({ b64: encode(FAKE) }, () => {
    const hint = { repoFullName: FAKE.repo, filePath: "src/modelo/Cuenta.cpp" };
    assert.equal(resolveExamReferenceForRequest(hint, { ...ACCESS, authenticated: false }), null, "sin sesion");
    assert.equal(resolveExamReferenceForRequest(hint, { ...ACCESS, policyActive: false }), null, "sin politica activa");
    assert.equal(resolveExamReferenceForRequest({ ...hint, repoFullName: "alumno/otro" }, ACCESS), null, "otro repositorio");
    const editor = resolveExamReferenceForRequest(hint, ACCESS);
    assert.ok(editor);
    assert.equal(editor.stepId, "cuenta");
    assert.match(editor.tailRule, /siguiente paso hacia el codigo final/);
    assert.match(editor.text, /5, luego 10 y luego el maximo del docente/, "los topes salen de EDITOR_STAGE_CODE_CAP");
    // El editor deja un solo bloque; el panel no toca los bloques.
    const two = "Uno:\n```cpp\na();\n```\nDos:\n```cpp\nb();\n```";
    assert.equal(editor.keepFirstBlock(two).removedBlocks, 1);
    const panel = resolveExamReferenceForRequest(hint, { ...ACCESS, channel: "panel" });
    assert.ok(panel);
    assert.deepEqual(panel.keepFirstBlock(two), { text: two, removedBlocks: 0 });
    assert.doesNotMatch(panel.text, /IMPL-/);
  });
});

test("referencia del examen: solo para el repositorio del ejercicio", () => {
  assert.ok(matchesExamRepo(FAKE, { repoFullName: "eydersantiago/sistema-bancario-fpoo" }));
  assert.ok(matchesExamRepo(FAKE, { repoFullName: "https://github.com/EyderSantiago/Sistema-Bancario-FPOO.git" }));
  assert.ok(matchesExamRepo(FAKE, { repoFullName: "https://github.com/eydersantiago/sistema-bancario-fpoo/tree/main/src" }), "con /tree/main");
  assert.ok(matchesExamRepo(FAKE, { repoFullName: "otro/copia-del-examen" }, ["profe/copia-del-examen"]), "el repositorio del tema del examen, como argumento");
  assert.ok(matchesExamRepo(FAKE, { repoFullName: "otro-usuario/sistema-bancario-fpoo" }), "un fork del ejercicio");
  assert.ok(matchesExamRepo(FAKE, { url: "vscode://sistema-bancario-fpoo/src/modelo/Cuenta.cpp" }), "sin remoto, por la carpeta");
  assert.ok(!matchesExamRepo(FAKE, { repoFullName: "eydersantiago/FadaProyecto", url: "vscode://sistema-bancario-fpoo/x" }), "el repositorio manda");
  assert.ok(!matchesExamRepo(FAKE, { url: "vscode://taller/src/area.cpp", title: "src/area.cpp" }));
});

test("referencia del examen: el paso sale del nombre del archivo", () => {
  const step = (path: string) => resolveExamStep(FAKE, path)?.id || "";
  assert.equal(step("src/modelo/Cliente.h"), "cliente");
  assert.equal(step("src/modelo/Cuenta.cpp"), "cuenta");
  assert.equal(step("sistema-bancario-fpoo/src/modelo/CuentaCorriente.cpp"), "cuentacorriente");
  assert.equal(step("src\\modelo\\cuenta_corriente.hpp"), "cuentacorriente");
  assert.equal(step("src/main.cpp"), "main");
  assert.equal(step("README.md"), "");
  assert.equal(step(""), "");
  // Por los archivos de cada paso, no por una lista fija: el nombre igual gana, despues el que
  // empieza igual (main2.cpp) y despues el mas largo que contiene (y los patrones del JSON).
  assert.equal(step("src/main2.cpp"), "main");
  assert.equal(step("tests/CuentaCorrienteTest.cpp"), "cuentacorriente");
  assert.equal(step("src/corriente_utils.cpp"), "cuentacorriente", "por su patron");
  const other: ExamReference = {
    ...FAKE,
    pasos: [
      { id: "a", titulo: "A", archivos: ["src/Figura.h"], apoyo: [], guia: "G", patrones: [] },
      { id: "b", titulo: "B", archivos: ["src/FiguraCirculo.h"], apoyo: [], guia: "G", patrones: ["circulo"] },
    ],
  };
  assert.equal(resolveExamStep(other, "src/FiguraCirculo.cpp")?.id, "b");
  assert.equal(resolveExamStep(other, "src/Figura.cpp")?.id, "a");
  assert.equal(resolveExamStep(other, "src/circulo.cpp")?.id, "b");
});

test("referencia del examen: el editor recibe el .cpp del paso; el panel solo declaraciones", () => {
  const editor = buildExamReferenceBlock(FAKE, { filePath: "src/modelo/CuentaCorriente.cpp", channel: "editor" });
  assert.equal(editor.stepId, "cuentacorriente");
  assert.match(editor.text, /Referencia privada del docente/);
  assert.match(editor.text, /GUIA-CORRIENTE/);
  assert.match(editor.text, /IMPL-CORRIENTE-CPP/);
  assert.match(editor.text, /virtual bool retirarDinero/, "la declaracion de la base que usa");
  assert.match(editor.text, /Errores: falta ;/);
  assert.match(editor.text, /class Cliente \{\n  string nombre;/, "las demas declaraciones, sin comentarios");
  assert.doesNotMatch(editor.text, /IMPL-CLIENTE-CPP|IMPL-CUENTA-CPP|IMPL-MAIN/, "solo el .cpp del archivo abierto");

  const panel = buildExamReferenceBlock(FAKE, { filePath: "src/modelo/CuentaCorriente.cpp", channel: "panel" });
  assert.match(panel.text, /GUIA-CORRIENTE/);
  assert.match(panel.text, /class CuentaCorriente : public Cuenta/);
  assert.doesNotMatch(panel.text, /IMPL-/, "el panel no lleva implementaciones");

  const unknown = buildExamReferenceBlock(FAKE, { filePath: "README.md", channel: "editor" });
  assert.equal(unknown.stepId, "");
  assert.match(unknown.text, /No se reconoce el archivo/);
  assert.doesNotMatch(unknown.text, /IMPL-/);

  // Con poco espacio quedan las reglas y la guia del paso; lo demas sale.
  const tight = buildExamReferenceBlock(FAKE, { filePath: "src/modelo/Cuenta.cpp", channel: "editor", maxChars: 1500 });
  assert.match(tight.text, /GUIA-CUENTA/);
  assert.ok(tight.text.length <= 1500 + 50);
});

test("referencia del examen: en el prompt del editor va despues del codigo, el codigo cede espacio y no pasa del presupuesto", () => {
  const reference = buildExamReferenceBlock(FAKE, { filePath: "src/modelo/Cuenta.cpp", channel: "editor" });
  const block = reference.text;
  const huge = Array.from({ length: 2500 }, (_, index) => `long linea${index} = ${index};`).join("\n");
  const prompt = buildCursorSelectionSuggestionPrompt({
    tabContent: huge,
    question: "Como hago retirarDinero?",
    tabTitle: "src/modelo/Cuenta.cpp",
    reference,
    languageHint: "cpp",
  });
  assert.ok(prompt.includes(block), "la referencia entra completa");
  assert.ok(prompt.indexOf("Contexto de seleccion/cursor:") < prompt.indexOf("Referencia privada del docente"));
  assert.ok(prompt.indexOf("Referencia privada del docente") < prompt.indexOf("## Lo que tienes que responder"));
  assert.match(prompt, /Usa la referencia privada del docente para que la pista y el codigo sean el siguiente paso/);
  assert.ok(prompt.length <= promptBudgetChars() + 200, `prompt de ${prompt.length} caracteres`);

  const without = buildCursorSelectionSuggestionPrompt({ tabContent: "int main() {}", question: "x", tabTitle: "a.cpp" });
  assert.doesNotMatch(without, /referencia privada/i, "fuera del examen el prompt no cambia");
});

test("referencia del examen: el panel la recibe como ExamReference", () => {
  const prompt = buildMentorPrompt({
    context: { pageContext: "github", pageType: "codespace", filePath: "src/modelo/Cuenta.cpp" },
    question: "como empiezo la clase Cuenta",
    maxItems: 4,
    heuristic: { ideas: [], searches: [], guide: [], welcome_message: "", analysis_summary: "" },
    referenceContext: "GUIA-DE-PRUEBA",
  });
  assert.match(prompt, /ExamReference:\nGUIA-DE-PRUEBA/);
  assert.match(prompt, /ExamReference es privada del docente/);
  const without = buildMentorPrompt({
    context: { pageContext: "github", pageType: "codespace" },
    question: "x",
    maxItems: 4,
    heuristic: { ideas: [], searches: [], guide: [], welcome_message: "", analysis_summary: "" },
  });
  assert.doesNotMatch(without, /ExamReference/);
});

test("referencia del examen: no sale copiada fuera de los bloques de codigo", () => {
  // Codigo ficticio: la solucion real no puede aparecer en este repositorio (es publico).
  const reference = [
    "## Referencia privada del docente",
    "- Sin .h: #include \"Foo.h\"; class Foo : public Base (guia en prosa)",
    "int Foo::bar(int x) {",
    "    if (x <= 0 || x > tope + margen) {",
    "        return 0;",
    "    }",
    "    acumular(valorActual() + x);",
    "    return 1;",
    "}",
    "Foo::Foo(string nombre, int tope, int margen) : Base(nombre, tope) {",
    "    this->margen = margen;",
  ].join("\n");
  const leaked = [
    "1) Resumen:",
    "- Aqui va todo:",
    "int Foo::bar(int x) {",
    "    if (x <= 0 || x > tope + margen) {",
    "    acumular(valorActual() + x);",
    "Foo::Foo(string nombre, int tope, int margen) : Base(nombre, tope) {",
    "    this->margen = margen;",
    "```cpp",
    "    acumular(valorActual() + x);",
    "```",
  ].join("\n");
  const guarded = guardExamReferenceLeak({ output: leaked, referenceText: reference });
  assert.equal(guarded.removedLines, 2, "pasan las 3 primeras, salen las demas fuera del bloque");
  assert.doesNotMatch(guarded.text, /this->margen = margen;/);
  assert.match(guarded.text, /```cpp\n    acumular\(valorActual\(\) \+ x\);\n```/, "el bloque de codigo no se toca (lo limita la politica)");

  const hint = "1) Resumen:\n- Usa `acumular(valorActual() + x);` en vez de tocar el atributo.\n```cpp\n    acumular(valorActual() + x);\n```";
  assert.deepEqual(guardExamReferenceLeak({ output: hint, referenceText: reference }), { text: hint, removedLines: 0 }, "una pista normal no cambia");
  assert.deepEqual(guardExamReferenceLeak({ output: hint, referenceText: "" }), { text: hint, removedLines: 0 });
  assert.equal(guardExamReferenceLeak({ output: leaked, referenceText: reference, allowedVerbatimLines: 0 }).removedLines, 5);
});

test("referencia del examen: solo queda el primer bloque de codigo y uno sin cerrar se descarta", () => {
  const many = ["1) Resumen:", "- Pista.", "```cpp", "a();", "```", "Texto.", "```cpp", "b();", "```", "```cpp", "c();"].join("\n");
  const single = keepFirstCodeBlock(many);
  assert.equal(single.removedBlocks, 2);
  assert.match(single.text, /```cpp\na\(\);\n```/);
  assert.doesNotMatch(single.text, /b\(\);|c\(\);/);
  assert.match(single.text, /Texto\./);
  const one = "1) Resumen:\n```cpp\na();\n```";
  assert.deepEqual(keepFirstCodeBlock(one), { text: one, removedBlocks: 0 });
  assert.equal(keepFirstCodeBlock("```cpp\nsolo();").text, "", "un unico bloque cortado no se muestra a medias");
});

async function startTestServer() {
  const database = await createDatabase();
  const app = createApp(database);
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No se pudo iniciar servidor de prueba.");
  return { database, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopTestServer(server: Server, database: AppDatabase) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await database.close();
}

test("/suggest-tab: en el repositorio del examen el modelo recibe la referencia y el codigo sigue con el tope de la politica", async () => {
  const previous = { b64: env.examReferenceB64, mode: env.examReferenceSwitch };
  env.examReferenceB64 = encode(FAKE);
  env.examReferenceSwitch = "";
  const prompts: string[] = [];
  const longCode = Array.from({ length: 12 }, (_, index) => `    saldo = saldo - ${index};`).join("\n");
  setTextModelOverrideForTests(async (input) => {
    prompts.push(input);
    return ["1) Resumen:", "- Falta validar el saldo.", "", "4) Accion:", "Aplicar: insert", "```cpp", longCode, "```"].join("\n");
  });
  const { server, database, baseUrl } = await startTestServer();
  const payload = (extra: Record<string, unknown>) => ({
    tab_content: "#include \"Cuenta.h\"\n\nbool Cuenta::retirarDinero(long cantidad) {\n\n}\n",
    question: "Como hago retirarDinero?",
    tab_title: "src/modelo/Cuenta.cpp",
    filePath: "src/modelo/Cuenta.cpp",
    suggestion_scope: "cursor",
    languageHint: "cpp",
    trigger: "manual",
    ...extra,
  });
  try {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ email: "estudiante@adaceen.edu.co", password: "Estudiante123!" }),
    });
    const sessionId = String(((await login.json()) as { session?: { id?: string } }).session?.id || "");
    assert.ok(sessionId);
    const post = async (body: unknown, withSession = true) => {
      const response = await fetch(`${baseUrl}/suggest-tab`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "x-adaceen-client-id": "vscode-examen-0001",
          ...(withSession ? { "x-session-id": sessionId } : {}),
        },
        body: JSON.stringify(body),
      });
      return await response.json() as {
        ok: boolean;
        output_text: string;
        code_application: { allowed: boolean; maxLines: number; truncation?: string; cut?: Record<string, unknown> } | null;
      };
    };
    const exam = await post(payload({ repoFullName: "eydersantiago/sistema-bancario-fpoo", tab_url: "vscode://eydersantiago/sistema-bancario-fpoo/src/modelo/Cuenta.cpp" }));
    assert.equal(exam.ok, true);
    assert.match(prompts[0], /Referencia privada del docente/);
    assert.match(prompts[0], /GUIA-CUENTA/);
    assert.match(prompts[0], /IMPL-CUENTA-CPP/);
    // El guardarrail de la politica sigue igual: 12 lineas pasan el tope de la pista 1 (5). Desde
    // el 30-10-2026 el corte cae donde todo queda cerrado y, como es un insert, se puede aplicar.
    assert.equal(exam.code_application?.maxLines, 5);
    assert.equal(exam.code_application?.allowed, true);
    assert.equal(exam.code_application?.truncation, "applicable");
    assert.deepEqual(exam.code_application?.cut, { kind: "prefix", linesShown: 5, linesTotal: 12, bracketsClosed: true });
    assert.match(exam.output_text, /^Aplicar: insert$/m);
    assert.match(exam.output_text, /saldo - 4;\n```/);
    assert.doesNotMatch(exam.output_text, /saldo - 5;|saldo - 11;/);

    await post(payload({ repoFullName: "alumno/taller", tab_url: "vscode://alumno/taller/src/modelo/Cuenta.cpp" }));
    assert.doesNotMatch(prompts[1], /Referencia privada del docente|IMPL-/, "otro repositorio no la recibe");

    await post(payload({ repoFullName: "eydersantiago/sistema-bancario-fpoo", question: "sin sesion" }), false);
    assert.doesNotMatch(prompts[2], /Referencia privada del docente|IMPL-/, "sin sesion iniciada no la recibe");

    const health = await (await fetch(`${baseUrl}/api/health`)).json() as Record<string, unknown>;
    assert.equal(health.exam_reference_loaded, true);
  } finally {
    setTextModelOverrideForTests(null);
    env.examReferenceB64 = previous.b64;
    env.examReferenceSwitch = previous.mode;
    await stopTestServer(server, database);
  }
});

test("/intervene (panel): sin sesion nunca recibe la referencia, y una respuesta que la copia sale recortada", async () => {
  const previous = { b64: env.examReferenceB64, mode: env.examReferenceSwitch };
  env.examReferenceB64 = encode(FAKE);
  env.examReferenceSwitch = "";
  const prompts: string[] = [];
  // Ficticio: copia 5 lineas de las declaraciones de prueba en una idea, fuera de un bloque.
  const copied = ["Copia esto:", "class Cuenta {", "  long saldo;", "  virtual bool retirarDinero(long cantidad);", "class Cliente {", "  string nombre;"].join("\n");
  setTextModelOverrideForTests(async (input) => {
    prompts.push(input);
    return JSON.stringify({
      ideas: [copied, "Revisa el saldo antes de retirar.", "Compila otra vez."],
      searches: ["herencia en C++", "metodos virtuales", "clases en C++"],
      guide: ["Lee el error.", "Ubica la linea.", "Corrige.", "Compila."],
      welcome_message: "Vamos paso a paso.",
      analysis_summary: "Falta la clase Cuenta.",
    });
  });
  const { server, database, baseUrl } = await startTestServer();
  const body = {
    question: "Que significa este error?",
    max_items: 5,
    context: {
      pageType: "github_code",
      repoFullName: "eydersantiago/sistema-bancario-fpoo",
      filePath: "src/modelo/Cuenta.cpp",
      languageHint: "cpp",
      activityTitle: "Sistema bancario",
      visibleError: "src/modelo/Cuenta.cpp:6:48: error: expected ';' before '}' token",
      codeSnippet: "class Cuenta {\n  long saldo\n};",
    },
  };
  const intervene = async (headers: Record<string, string>) => {
    const response = await fetch(`${baseUrl}/intervene`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
      body: JSON.stringify(body),
    });
    return await response.json() as { ok: boolean; result: { ideas: string[] } };
  };
  try {
    const anonymous = await intervene({ "x-adaceen-client-id": "panel-examen-0001" });
    assert.equal(anonymous.ok, true);
    assert.equal(prompts.length, 1);
    assert.doesNotMatch(prompts[0], /ExamReference|Referencia privada|GUIA-CUENTA/, "sin sesion no va la referencia");

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ email: "estudiante@adaceen.edu.co", password: "Estudiante123!" }),
    });
    const sessionId = String(((await login.json()) as { session?: { id?: string } }).session?.id || "");
    const withSession = await intervene({ "x-session-id": sessionId });
    assert.equal(withSession.ok, true);
    assert.match(prompts[1], /ExamReference:/, "con sesion y politica, si");
    assert.match(prompts[1], /GUIA-CUENTA/);
    const idea = withSession.result.ideas.find((item) => item.startsWith("Copia esto:")) || "";
    assert.match(idea, /class Cuenta \{/, "las 3 primeras se dejan");
    assert.doesNotMatch(idea, /class Cliente \{|string nombre;/, "desde la cuarta se quitan");
  } finally {
    setTextModelOverrideForTests(null);
    env.examReferenceB64 = previous.b64;
    env.examReferenceSwitch = previous.mode;
    await stopTestServer(server, database);
  }
});
