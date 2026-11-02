import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import { createApp } from "../../../src/app.js";
import { suggestTabCourseCode } from "../../../src/routes/tutor/agent-suggest-tab-helpers.js";
import { env } from "../../../src/config/env.js";
import { createDatabase, type AppDatabase } from "../../../src/db/database.js";
import { setTextModelOverrideForTests } from "../../../src/services/tutor/agent-mode.js";
import {
  buildExamReferenceBlock,
  guardExamReferenceLeak,
  parseExamReference,
  type ExamReference,
} from "../../../src/services/exam/exam-reference.js";
import { FAKE, encode } from "./helpers.js";

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
    assert.deepEqual(exam.code_application?.cut, { kind: "prefix", linesShown: 5, linesTotal: 12, endsCleanly: true });
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
      // El saludo trae las declaraciones de la referencia en un bloque de codigo (W4).
      welcome_message: "Vamos paso a paso:\n```cpp\nclass Cuenta {\n  long saldo;\n  virtual bool retirarDinero(long cantidad);\n};\n```",
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
    return await response.json() as { ok: boolean; result: { ideas: string[]; welcome_message: string } };
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
    // Los cinco textos pasan por el tope de la etapa: en la pista 1 el saludo no trae codigo.
    assert.doesNotMatch(withSession.result.welcome_message, /retirarDinero|long saldo|```/, "el saludo no trae el codigo de la referencia");
    assert.match(withSession.result.welcome_message, /codigo omitido/);
  } finally {
    setTextModelOverrideForTests(null);
    env.examReferenceB64 = previous.b64;
    env.examReferenceSwitch = previous.mode;
    await stopTestServer(server, database);
  }
});

// --- Revision independiente del 31-10-2026 (referencia de juguete) ----------------------------

const TOY_REFERENCE = [
  "int Caja::sacar(int monto) {",
  "  if (monto > total + margen) {",
  "    return -1;",
  "  }",
  "  total -= monto;",
  "  return monto;",
  "}",
].join("\n");

test("referencia del examen (31-10-2026): numerada, con viñeta, entre comillas invertidas o con otros espacios tambien es copia", () => {
  // 5 lineas vigiladas (las de «}» son cortas); pasan 3 y salen 2, igual que la copia tal cual.
  const lines = TOY_REFERENCE.split("\n");
  const variants: Record<string, string> = {
    tal_cual: TOY_REFERENCE,
    numerada: lines.map((line, index) => `${index + 1}. ${line.trim()}`).join("\n"),
    numerada_parentesis: lines.map((line, index) => `${index + 1}) ${line.trim()}`).join("\n"),
    vinetas: lines.map((line) => `- ${line.trim()}`).join("\n"),
    asteriscos: lines.map((line) => `* ${line.trim()}`).join("\n"),
    cita: lines.map((line) => `> ${line}`).join("\n"),
    comillas_invertidas: lines.map((line) => "`" + line.trim() + "`").join("\n"),
    vineta_y_comillas: lines.map((line) => "- `" + line.trim() + "`").join("\n"),
    espacio_antes_del_punto_y_coma: lines.map((line) => line.replace(/;/g, " ;")).join("\n"),
    espacios_en_parentesis: lines.map((line) => line.replace(/\(/g, "( ").replace(/\)/g, " )")).join("\n"),
    operadores_pegados: lines.map((line) => line.replace(/ ([>+]|-=) /g, "$1")).join("\n"),
  };
  for (const [name, output] of Object.entries(variants)) {
    const guarded = guardExamReferenceLeak({ output: `1) Resumen:\n- Mira:\n${output}`, referenceText: TOY_REFERENCE });
    assert.equal(guarded.removedLines, 2, name);
    assert.match(guarded.text, /^1\) Resumen:\n- Mira:/, `${name}: la prosa se queda`);
    assert.doesNotMatch(guarded.text, /return monto/, `${name}: la quinta linea copiada sale`);
  }
  // El cupo de siempre: con 0 permitidas salen las 5.
  assert.equal(guardExamReferenceLeak({ output: variants.numerada, referenceText: TOY_REFERENCE, allowedVerbatimLines: 0 }).removedLines, 5);
  // Dentro de un bloque de codigo no se toca (lo limita la politica).
  const fenced = "```cpp\n" + variants.numerada + "\n```";
  assert.deepEqual(guardExamReferenceLeak({ output: fenced, referenceText: TOY_REFERENCE, allowedVerbatimLines: 0 }), { text: fenced, removedLines: 0 });
});

test("referencia del examen (31-10-2026): las lineas cortas como «}» o «return 0;» nunca cuentan como copia", () => {
  // La regla de siempre (menos de 10 caracteres o sin ; { } ( )), en la referencia y en la respuesta,
  // tambien con las marcas que ahora se quitan antes de comparar.
  const reference = ["int main() {", "  return 0;", "}", "{", "  i++;", "  x = 1;"].join("\n");
  const output = ["}", "`}`", "1. }", "> }", "- `}`", "return 0;", "`return 0;`", "- return 0;", "3) return 0;", "i++;", "x = 1;", "x=1;", "{"].join("\n");
  assert.deepEqual(guardExamReferenceLeak({ output, referenceText: reference, allowedVerbatimLines: 0 }), { text: output, removedLines: 0 });
  // Y en una referencia con lineas largas, las cortas de la respuesta tampoco gastan el cupo.
  const mixed = ["}", "return 0;", "}", "`}`", TOY_REFERENCE.split("\n")[0]].join("\n");
  assert.equal(guardExamReferenceLeak({ output: mixed, referenceText: `${TOY_REFERENCE}\n  return 0;`, allowedVerbatimLines: 1 }).removedLines, 0);
});

test("referencia del examen (31-10-2026): en apoyo solo van declaraciones; un .cpp se ignora con un aviso sin contenido", () => {
  const withCpp: ExamReference = {
    ...FAKE,
    pasos: FAKE.pasos.map((step) => (step.id === "cuentacorriente" ? { ...step, apoyo: ["src/modelo/Cuenta.h", "src/modelo/Cuenta.cpp"] } : step)),
  };
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  let parsed: ExamReference | null = null;
  try {
    parsed = parseExamReference(encode(withCpp));
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(parsed);
  assert.deepEqual(parsed.pasos.find((step) => step.id === "cuentacorriente")?.apoyo, ["src/modelo/Cuenta.h"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[examen\] paso cuentacorriente: se ignoran 1 archivos de apoyo/);
  assert.doesNotMatch(warnings[0], /IMPL-|Cuenta\.cpp|class /, "el aviso no lleva contenido ni rutas");

  // Armada a mano (sin readExamReference), el bloque tampoco mete el .cpp de apoyo.
  const block = buildExamReferenceBlock(withCpp, { filePath: "src/modelo/CuentaCorriente.cpp", channel: "editor" });
  assert.equal(block.stepId, "cuentacorriente");
  assert.match(block.text, /IMPL-CORRIENTE-CPP/, "el .cpp del paso si va (editor)");
  assert.match(block.text, /### Declaraciones que usa\n\/\/ src\/modelo\/Cuenta\.h/);
  assert.doesNotMatch(block.text, /IMPL-CUENTA-CPP/, "el .cpp de otra clase no");
});

test("/suggest-tab (31-10-2026, CA-015): un codigo de curso armado no saca de la cache la salida hecha con la referencia", async () => {
  // Antes la clave unia sus partes con «||»: sin sesion, courseCode «examen:cuenta||» armaba la
  // misma clave que el pedido con la referencia (paso cuenta) y recibia esa salida sin el freno de
  // fugas. Ahora la clave es un JSON con el paso y la entrada guarda el paso con que se genero.
  const previous = { b64: env.examReferenceB64, mode: env.examReferenceSwitch };
  env.examReferenceB64 = encode(FAKE);
  env.examReferenceSwitch = "";
  const prompts: string[] = [];
  setTextModelOverrideForTests(async (input) => {
    prompts.push(input);
    const marker = /Referencia privada del docente/.test(input) ? "CON-REFERENCIA" : "SIN-REFERENCIA";
    return ["1) Resumen:", `- Pista ${marker}.`, "", "Aplicar: insert", "```cpp", "    revisar();", "```"].join("\n");
  });
  const { server, database, baseUrl } = await startTestServer();
  const body = {
    tab_content: "#include \"Cuenta.h\"\n\nbool Cuenta::retirarDinero(long cantidad) {\n\n}\n",
    question: "Que sigue?",
    tab_title: "src/modelo/Cuenta.cpp",
    tab_url: "vscode://eydersantiago/sistema-bancario-fpoo/src/modelo/Cuenta.cpp",
    filePath: "src/modelo/Cuenta.cpp",
    repoFullName: "eydersantiago/sistema-bancario-fpoo",
    suggestion_scope: "cursor",
    languageHint: "cpp",
    trigger: "cursor_idle",
  };
  try {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ email: "estudiante@adaceen.edu.co", password: "Estudiante123!" }),
    });
    const sessionId = String(((await login.json()) as { session?: { id?: string } }).session?.id || "");
    assert.ok(sessionId);
    const post = async (extra: Record<string, unknown>, headers: Record<string, string>) => {
      const response = await fetch(`${baseUrl}/suggest-tab`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
        body: JSON.stringify({ ...body, ...extra }),
      });
      return await response.json() as { ok: boolean; output_text: string; cached: boolean };
    };

    const withReference = await post({}, { "x-session-id": sessionId });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Referencia privada del docente/);
    assert.match(withReference.output_text, /CON-REFERENCIA/);
    // La cache sigue sirviendo al mismo estudiante.
    const again = await post({}, { "x-session-id": sessionId });
    assert.equal(again.cached, true);
    assert.equal(prompts.length, 1);

    const forged = await post({ courseCode: "examen:cuenta||" }, { "x-adaceen-client-id": "vscode-sin-sesion-0001" });
    assert.equal(forged.ok, true);
    assert.equal(forged.cached, false, "no sale de la cache de la referencia");
    assert.equal(prompts.length, 2, "el modelo responde al pedido sin sesion");
    assert.doesNotMatch(prompts[1], /Referencia privada del docente/);
    assert.match(forged.output_text, /SIN-REFERENCIA/);
    assert.doesNotMatch(forged.output_text, /CON-REFERENCIA/);
    // Otra forma del mismo truco: el codigo de curso no valido queda vacio, asi que puede salir de
    // la cache del pedido anterior sin sesion, pero nunca de la que se hizo con la referencia.
    const forgedAgain = await post({ courseCode: "examen:cuenta||FPOO" }, { "x-adaceen-client-id": "vscode-sin-sesion-0001" });
    assert.match(forgedAgain.output_text, /SIN-REFERENCIA/);
    assert.doesNotMatch(forgedAgain.output_text, /CON-REFERENCIA/);
    assert.ok(prompts.slice(1).every((prompt) => !/Referencia privada del docente/.test(prompt)));
  } finally {
    setTextModelOverrideForTests(null);
    env.examReferenceB64 = previous.b64;
    env.examReferenceSwitch = previous.mode;
    await stopTestServer(server, database);
  }
});

test("/suggest-tab (31-10-2026, CA-015): el codigo de curso solo admite letras, numeros, «_» y «-»", () => {
  assert.equal(suggestTabCourseCode("FPOO"), "FPOO");
  assert.equal(suggestTabCourseCode(" fpoo-01 "), "fpoo-01");
  assert.equal(suggestTabCourseCode("FP_OE"), "FP_OE");
  assert.equal(suggestTabCourseCode(""), "");
  assert.equal(suggestTabCourseCode(undefined), "");
  assert.equal(suggestTabCourseCode("examen:cuenta||FPOO"), "");
  assert.equal(suggestTabCourseCode("FP OO"), "");
  assert.equal(suggestTabCourseCode("x".repeat(41)), "");
  assert.equal(suggestTabCourseCode("x".repeat(40)), "x".repeat(40));
});
