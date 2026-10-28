import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { gzipSync } from "node:zlib";
import { createApp } from "../../src/app.js";
import { createDatabase, type AppDatabase } from "../../src/db/database.js";
import { setTextModelOverrideForTests } from "../../src/services/agent-mode.js";
import {
  buildExamReferenceBlock,
  describeExamReference,
  guardExamReferenceLeak,
  keepFirstCodeBlock,
  examReferenceForRequest,
  loadExamReference,
  matchesExamRepo,
  parseExamReference,
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
    { id: "cliente", titulo: "Paso 1 - Cliente", archivos: ["src/modelo/Cliente.h", "src/modelo/Cliente.cpp"], apoyo: [], guia: "GUIA-CLIENTE" },
    { id: "cuenta", titulo: "Paso 2 - Cuenta", archivos: ["src/modelo/Cuenta.h", "src/modelo/Cuenta.cpp"], apoyo: [], guia: "GUIA-CUENTA" },
    { id: "cuentacorriente", titulo: "Paso 4 - CuentaCorriente", archivos: ["src/modelo/CuentaCorriente.h", "src/modelo/CuentaCorriente.cpp"], apoyo: ["src/modelo/Cuenta.h"], guia: "GUIA-CORRIENTE" },
    { id: "main", titulo: "Paso 7 - main", archivos: ["src/main.cpp"], apoyo: [], guia: "GUIA-MAIN" },
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

function withEnv<T>(values: Record<string, string | undefined>, run: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return run();
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("referencia del examen: se lee de EXAM_REFERENCE_B64 y sin ella (o apagada o rota) no hay nada", () => {
  const parsed = parseExamReference(encode(FAKE));
  assert.equal(parsed?.repo, FAKE.repo);
  assert.equal(parsed?.pasos.length, 4);

  withEnv({ EXAM_REFERENCE_B64: undefined, EXAM_REFERENCE: undefined }, () => {
    assert.equal(loadExamReference(), null);
    assert.deepEqual(describeExamReference(), { exam_reference_loaded: false });
    assert.equal(examReferenceForRequest({ repoFullName: FAKE.repo, filePath: "src/modelo/Cuenta.cpp" }, "editor").text, "");
  });
  withEnv({ EXAM_REFERENCE_B64: encode(FAKE), EXAM_REFERENCE: "off" }, () => {
    assert.equal(loadExamReference(), null);
  });
  withEnv({ EXAM_REFERENCE_B64: "esto-no-es-gzip", EXAM_REFERENCE: undefined }, () => {
    assert.equal(loadExamReference(), null);
    assert.equal(examReferenceForRequest({ repoFullName: FAKE.repo, filePath: "src/main.cpp" }, "editor").text, "");
  });
  withEnv({ EXAM_REFERENCE_B64: encode({ ...FAKE, pasos: "mal" }), EXAM_REFERENCE: undefined }, () => {
    assert.equal(loadExamReference(), null);
  });
  withEnv({ EXAM_REFERENCE_B64: encode(FAKE), EXAM_REFERENCE: undefined }, () => {
    assert.equal(loadExamReference()?.repo, FAKE.repo);
    assert.deepEqual(describeExamReference(), { exam_reference_loaded: true });
  });
});

test("referencia del examen: solo para el repositorio del ejercicio", () => {
  assert.ok(matchesExamRepo(FAKE, { repoFullName: "eydersantiago/sistema-bancario-fpoo" }));
  assert.ok(matchesExamRepo(FAKE, { repoFullName: "https://github.com/EyderSantiago/Sistema-Bancario-FPOO.git" }));
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
  const block = buildExamReferenceBlock(FAKE, { filePath: "src/modelo/Cuenta.cpp", channel: "editor" }).text;
  const huge = Array.from({ length: 2500 }, (_, index) => `long linea${index} = ${index};`).join("\n");
  const prompt = buildCursorSelectionSuggestionPrompt({
    tabContent: huge,
    question: "Como hago retirarDinero?",
    tabTitle: "src/modelo/Cuenta.cpp",
    referenceContext: block,
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
  const guarded = guardExamReferenceLeak(leaked, reference);
  assert.equal(guarded.removed, 2, "pasan las 3 primeras, salen las demas fuera del bloque");
  assert.doesNotMatch(guarded.text, /this->margen = margen;/);
  assert.match(guarded.text, /```cpp\n    acumular\(valorActual\(\) \+ x\);\n```/, "el bloque de codigo no se toca (lo limita la politica)");

  const hint = "1) Resumen:\n- Usa `acumular(valorActual() + x);` en vez de tocar el atributo.\n```cpp\n    acumular(valorActual() + x);\n```";
  assert.deepEqual(guardExamReferenceLeak(hint, reference), { text: hint, removed: 0 }, "una pista normal no cambia");
  assert.deepEqual(guardExamReferenceLeak(hint, ""), { text: hint, removed: 0 });
});

test("referencia del examen: solo queda el primer bloque de codigo y uno sin cerrar se descarta", () => {
  const many = ["1) Resumen:", "- Pista.", "```cpp", "a();", "```", "Texto.", "```cpp", "b();", "```", "```cpp", "c();"].join("\n");
  const single = keepFirstCodeBlock(many);
  assert.equal(single.removed, 2);
  assert.match(single.text, /```cpp\na\(\);\n```/);
  assert.doesNotMatch(single.text, /b\(\);|c\(\);/);
  assert.match(single.text, /Texto\./);
  const one = "1) Resumen:\n```cpp\na();\n```";
  assert.deepEqual(keepFirstCodeBlock(one), { text: one, removed: 0 });
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
  const previous = { b64: process.env.EXAM_REFERENCE_B64, mode: process.env.EXAM_REFERENCE };
  process.env.EXAM_REFERENCE_B64 = encode(FAKE);
  delete process.env.EXAM_REFERENCE;
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
      return await response.json() as { ok: boolean; output_text: string; code_application: { allowed: boolean; maxLines: number } | null };
    };
    const exam = await post(payload({ repoFullName: "eydersantiago/sistema-bancario-fpoo", tab_url: "vscode://eydersantiago/sistema-bancario-fpoo/src/modelo/Cuenta.cpp" }));
    assert.equal(exam.ok, true);
    assert.match(prompts[0], /Referencia privada del docente/);
    assert.match(prompts[0], /GUIA-CUENTA/);
    assert.match(prompts[0], /IMPL-CUENTA-CPP/);
    // El guardarrail de la politica sigue igual: 12 lineas pasan el tope de la pista 1 y no se aplican.
    assert.equal(exam.code_application?.allowed, false);
    assert.doesNotMatch(exam.output_text, /saldo - 11;/);

    await post(payload({ repoFullName: "alumno/taller", tab_url: "vscode://alumno/taller/src/modelo/Cuenta.cpp" }));
    assert.doesNotMatch(prompts[1], /Referencia privada del docente|IMPL-/, "otro repositorio no la recibe");

    await post(payload({ repoFullName: "eydersantiago/sistema-bancario-fpoo", question: "sin sesion" }), false);
    assert.doesNotMatch(prompts[2], /Referencia privada del docente|IMPL-/, "sin sesion iniciada no la recibe");

    const health = await (await fetch(`${baseUrl}/api/health`)).json() as Record<string, unknown>;
    assert.equal(health.exam_reference_loaded, true);
  } finally {
    setTextModelOverrideForTests(null);
    if (previous.b64 === undefined) delete process.env.EXAM_REFERENCE_B64; else process.env.EXAM_REFERENCE_B64 = previous.b64;
    if (previous.mode === undefined) delete process.env.EXAM_REFERENCE; else process.env.EXAM_REFERENCE = previous.mode;
    await stopTestServer(server, database);
  }
});
