import assert from "node:assert/strict";
import test from "node:test";
import type { RagSource, RagSourceChunk } from "../../src/types/app.js";
import { buildOllamaChatBody, resolveOllamaNativeBase } from "../../runText.js";
import {
  ADACEEN_SYSTEM_PROMPT,
  modelNumCtx,
  promptBudgetChars,
  resolveTextGeneration,
  serializableGeneration,
} from "../../src/services/text-generation.js";
import {
  buildCompactRagPromptBlock,
  buildEditorRagSearchQuery,
  buildRagChunksForSource,
  codeConceptTerms,
  codeIdentifierTerms,
  errorQueryTerms,
  languageFamilyForHint,
  rankRagSources,
} from "../../src/services/rag-sources.js";
import { extractEditorCode, fitEditorContent, parseEditorContent } from "../../src/services/editor-context.js";
import { prepareEditorModelOutput, stripCodeFenceGutters } from "../../src/services/suggestion-output.js";
import {
  buildCursorSelectionSuggestionPrompt,
  editorCodeProblem,
  editorCodeRetryInstruction,
} from "../../src/services/tab-suggestion-prompt.js";

// Revision de precision del 21/10/2026: perfil de generacion y ventana de contexto, consulta y
// filtro del RAG, contexto del editor ajustado a la ventana y prompt con las reglas al final.

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("generacion: perfiles con temperatura baja, valores de Qwen y ventana explicita", () => {
  withEnv({ MODEL_NUM_CTX: undefined, MODEL_SEED: undefined }, () => {
    const editor = resolveTextGeneration({ profile: "editor" });
    assert.equal(editor.temperature, 0.2);
    assert.equal(editor.topP, 0.8);
    assert.equal(editor.topK, 20);
    assert.equal(editor.json, false);
    assert.equal(editor.numCtx, 8192);
    assert.equal(editor.seed, null, "sin MODEL_SEED no se fija semilla: «Otra sugerencia» cambia");
    assert.equal(resolveTextGeneration({ profile: "json_strict" }).temperature, 0);
    assert.equal(resolveTextGeneration({ profile: "json" }).json, true);
    assert.equal(resolveTextGeneration({ profile: "nada" as never }).profile, "default");
    const proto = resolveTextGeneration({ profile: "constructor" as never });
    assert.equal(proto.profile, "default", "un nombre del prototipo no es un perfil");
    assert.equal(proto.maxTokens, 1200);
    assert.equal(serializableGeneration({ profile: "toString" as never }), undefined);
    assert.equal(resolveTextGeneration({ profile: "editor", temperature: 5 }).temperature, 2, "se acota");
  });
  withEnv({ MODEL_NUM_CTX: "16384", MODEL_SEED: "7" }, () => {
    assert.equal(modelNumCtx(), 16384);
    assert.equal(resolveTextGeneration({ profile: "editor" }).seed, 7);
  });
  withEnv({ MODEL_NUM_CTX: "100" }, () => assert.equal(modelNumCtx(), 8192, "un valor absurdo vuelve al de siempre"));
  assert.deepEqual(serializableGeneration({ profile: "editor", temperature: 0.35 }), { profile: "editor", temperature: 0.35 });
  assert.equal(serializableGeneration(undefined), undefined);
  assert.ok(promptBudgetChars(8192) >= 20000 && promptBudgetChars(8192) <= 22000);
});

test("generacion: con Ollama se usa /api/chat con num_ctx y sin el agente generico de antes", () => {
  withEnv({ MODEL_NUM_CTX: "8192", MODEL_SEED: undefined }, () => {
    const body = buildOllamaChatBody("hola", resolveTextGeneration({ profile: "json" }), "qwen2.5-coder:14b");
    assert.equal(body.options.num_ctx, 8192);
    assert.equal(body.options.temperature, 0.2);
    assert.equal(body.options.top_k, 20);
    assert.equal(body.format, "json");
    assert.equal(body.stream, false);
    assert.equal(body.messages[0].content, ADACEEN_SYSTEM_PROMPT);
    assert.doesNotMatch(ADACEEN_SYSTEM_PROMPT, /Riesgos|recomendaciones/i, "sin el formato que contradecia al del prompt");
    assert.equal("seed" in body.options, false);
  });
  assert.equal(resolveOllamaNativeBase({ OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1" }), "http://127.0.0.1:11434");
  assert.equal(resolveOllamaNativeBase({ OPENAI_BASE: "http://127.0.0.1:11434/v1" }), "http://127.0.0.1:11434");
  assert.equal(resolveOllamaNativeBase({ OPENAI_BASE: "http://127.0.0.1:8080/v1" }), "", "llama-server del cluster: API compatible");
  assert.equal(resolveOllamaNativeBase({ OPENAI_BASE: "http://127.0.0.1:11434/v1", TEXT_MODEL_API: "openai" }), "");
  assert.equal(resolveOllamaNativeBase({}), "http://127.0.0.1:11434");
});

function ragSource(id: string, title: string, text: string, metadata: Record<string, unknown> = {}): RagSource {
  const source: RagSource = {
    id,
    scope: "default",
    teacherUserId: null,
    sourceKey: id,
    title,
    sourceType: "pdf",
    fileName: `${id}.pdf`,
    mimeType: "application/pdf",
    contentSha256: id,
    contentText: text,
    metadata: { courseCode: "FPOO", knowledge_tier: "primary", ...metadata },
    isActive: true,
    createdByUserId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  source.chunks = buildRagChunksForSource({
    title: source.title,
    sourceType: source.sourceType,
    fileName: source.fileName,
    sourceKey: source.sourceKey,
    contentText: text,
    metadata: source.metadata,
  }).map((chunk): RagSourceChunk => ({
    id: `${id}:chunk:${chunk.chunkIndex}`,
    sourceId: id,
    scope: source.scope,
    teacherUserId: null,
    sourceKey: id,
    sourceTitle: title,
    sourceType: source.sourceType,
    fileName: source.fileName,
    mimeType: source.mimeType,
    sourceMetadata: source.metadata,
    isActive: true,
    ...chunk,
    createdAt: source.createdAt,
  }));
  return source;
}

const POLY_CPP = `class Figura {
public:
  virtual double area() const = 0;
  virtual ~Figura() {}
};
class Rectangulo : public Figura {
  double base, altura;
public:
  double area() const override { return base * altura; }
};`;

test("RAG: conceptos del codigo y consulta del editor sin la pregunta de formato", () => {
  assert.equal(languageFamilyForHint("cpp"), "cpp");
  assert.equal(languageFamilyForHint("py"), "python");
  const concepts = codeConceptTerms(POLY_CPP, "cpp");
  assert.ok(concepts.includes("polimorfismo"));
  assert.ok(concepts.includes("herencia"));
  assert.ok(concepts.includes("destructor"));
  assert.ok(codeConceptTerms("class Perro(Animal):\n    pass", "python").includes("herencia"));
  assert.ok(!codeConceptTerms("class Perro:\n    def ladrar(self):\n        pass", "python").includes("herencia"), "class X: no es herencia");
  assert.ok(codeConceptTerms("std::vector<int> datos;\ndatos.push_back(3);", "cpp").includes("vector"));
  assert.deepEqual(codeIdentifierTerms("double calcularIMC(double pesoKg) { return pesoKg; }"), ["calcular", "imc", "peso"]);
  assert.equal(errorQueryTerms("src/cuenta.cpp:6:48: error: 'cout' was not declared in this scope"), "cout declared this scope");

  const query = buildEditorRagSearchQuery({ focusCode: POLY_CPP, fileCode: POLY_CPP, languageHint: "cpp", filePath: "src/figura.cpp", visibleError: "" });
  assert.match(query, /polimorfismo/);
  assert.match(query, /c\+\+/);
  assert.doesNotMatch(query, /analiza la seleccion|Repositorio|Workspace|FPOO/);
});

test("RAG: el lenguaje del archivo baja las fuentes de otro lenguaje y el codigo del curso no cuenta", () => {
  const ruby = ragSource("ruby-doc", "Bibliografía FPOO - Ruby documentation", "Clases, objetos, herencia y polimorfismo en Ruby: metodos que se sobrescriben en la subclase.", { category: "documentacion_lenguaje", description: "Documentación de Ruby" });
  const cpp = ragSource("thinking-cpp", "Thinking in C++", "Polimorfismo con funciones virtual: la subclase sobrescribe el metodo virtual de la clase base.", { category: "libro_abierto+c++" });
  const general = ragSource("semana-12", "Semana 12 - Polimorfismo", "Polimorfismo: un mismo mensaje, distinta respuesta segun la clase del objeto.", {});
  const query = buildEditorRagSearchQuery({ focusCode: POLY_CPP, fileCode: POLY_CPP, languageHint: "cpp" });
  const ranked = rankRagSources([ruby, cpp, general], query, 5, { languageHint: "cpp", minRelativeScore: 0.5, maxPerSource: 2, minMatchedTerms: 2 });
  assert.ok(ranked.length >= 1);
  assert.notEqual(ranked[0].sourceId, "ruby-doc", "la documentacion de Ruby no gana para un archivo C++");
  const rubyRank = ranked.findIndex((item) => item.sourceId === "ruby-doc");
  const cppRank = ranked.findIndex((item) => item.sourceId === "thinking-cpp");
  assert.ok(cppRank >= 0 && (rubyRank < 0 || rubyRank > cppRank));

  // Sin languageHint ni umbral (overlay y quiz de antes) sigue funcionando como siempre.
  assert.ok(rankRagSources([ruby, cpp], "polimorfismo herencia", 5).length === 2);

  // "FPOO" en la consulta ya no infla las fuentes con FPOO en el titulo.
  const onlyCourse = rankRagSources([ruby], "FPOO", 5, { minMatchedTerms: 1 });
  assert.equal(onlyCourse.length, 1, "consulta vacia tras quitar el codigo del curso: puntaje base, como sin consulta");
  assert.equal(onlyCourse[0].ftsScore, 1);
});

test("RAG: si ningun fragmento trae dos terminos del tema, no se cita nada", () => {
  const unrelated = ragSource("stl", "STL Programmer's Guide", "Contenedores e iteradores de la biblioteca estandar de C++.", { category: "documentacion_lenguaje+c++" });
  const query = buildEditorRagSearchQuery({ focusCode: "int suma = a + b;", fileCode: "int suma = a + b;", languageHint: "cpp" });
  assert.deepEqual(rankRagSources([unrelated], query, 5, { languageHint: "cpp", minRelativeScore: 0.5, minMatchedTerms: 2 }), []);
});

test("RAG: bloque corto con la etiqueta de cita, sin URL ni puntajes", () => {
  const cpp = ragSource("thinking-cpp", "Thinking in C++", "Polimorfismo con funciones virtual: la subclase sobrescribe el metodo virtual.", { category: "libro_abierto+c++", original_url: "https://example.test/tic.zip" });
  const ranked = rankRagSources([cpp], "polimorfismo virtual", 3);
  const block = buildCompactRagPromptBlock(ranked, { maxItems: 3 });
  assert.match(block, /\[thinking-cpp#c1\] Thinking in C\+\+/);
  assert.match(block, /Usalo solo si aplica/);
  assert.doesNotMatch(block, /https?:\/\/|Ranking|FTS|Alcance/);
  assert.equal(buildCompactRagPromptBlock([]), "");
});

const OLD_CONTENT = [
  "Repositorio: univalle/taller",
  "Archivo activo: src/main.cpp",
  "Lenguaje: cpp",
  "Bloque seleccionado por el usuario: lineas 3-4",
  "Lineas analizadas de la seleccion: 2",
  "El foco principal es todo este bloque seleccionado, no solamente la linea del cursor.",
  "int a = 1;",
  "int b = 2;",
  "",
  "Texto visible del editor:",
  "x".repeat(1500),
  "",
  "Codigo del archivo activo (recorte local):",
  ...Array.from({ length: 200 }, (_, index) => `int v${index} = ${index};`),
  "",
  "Mapa local del proyecto generado por VS Code: 3 archivo(s) indexado(s).",
  ...Array.from({ length: 30 }, (_, index) => `- src/archivo${index}.cpp | cpp | 40 lineas | 900 bytes | preview: ${"y".repeat(80)}`),
].join("\n");

test("editor: el contexto se recorta por partes (mapa, texto visible, codigo) y no a ciegas", () => {
  const kinds = parseEditorContent(OLD_CONTENT).map((section) => section.kind);
  assert.deepEqual(kinds.filter((kind) => kind !== "meta"), ["selection", "visible", "code", "map"]);
  const fitted = fitEditorContent(OLD_CONTENT, 2500, "focus");
  assert.ok(fitted.text.length <= 2500);
  assert.deepEqual(fitted.omitted, ["map", "visible"]);
  assert.equal(fitted.trimmedCode, true);
  assert.match(fitted.text, /Bloque seleccionado por el usuario: lineas 3-4\n[\s\S]*int b = 2;/, "la seleccion se queda");
  assert.match(fitted.text, /linea\(s\) omitidas abajo/);
  assert.equal(fitEditorContent("corto", 4500).text, "corto");
});

const NEW_CONTENT = [
  "Archivo activo: src/figura.cpp (cpp, 300 lineas)",
  "Cursor: linea 150, columna 3",
  "",
  "Codigo alrededor del foco (lineas 100-200 de 300; las lineas del foco llevan \">\"):",
  ...Array.from({ length: 101 }, (_, index) => {
    const line = 100 + index;
    return `${String(line).padStart(4)}${line === 150 ? ">" : " "}| int v${line} = ${line};`;
  }),
  "",
  "Estructura del resto del archivo (numero de linea: declaracion):",
  "5: class Figura {",
  "250: int main() {",
  "",
  "Otros archivos del proyecto: src/main.cpp (cpp, 40 lineas).",
].join("\n");

test("editor: el codigo numerado se recorta alrededor de las lineas del foco", () => {
  assert.deepEqual(parseEditorContent(NEW_CONTENT).map((section) => section.kind), ["meta", "code", "outline", "map"]);
  const fitted = fitEditorContent(NEW_CONTENT, 1200, "focus");
  assert.ok(fitted.text.length <= 1200);
  assert.deepEqual(fitted.omitted, ["map", "outline"]);
  assert.match(fitted.text, / 150>\| int v150 = 150;/);
  assert.match(fitted.text, /omitidas arriba/);
  assert.match(fitted.text, /omitidas abajo/);
  const code = extractEditorCode(NEW_CONTENT);
  assert.equal(code.focusCode, "int v150 = 150;", "sin seleccion, el foco son las lineas marcadas");
  assert.match(code.fileCode, /^int v100 = 100;/, "sin el margen numerado");
});

test("editor: la linea de dependencias del resumen (VS Code 0.0.36) es una parte propia", () => {
  const summary = [
    "Archivo activo: src/figura.h (cpp, 12 lineas)",
    "",
    "Codigo del archivo con numero de linea (lineas 1-12 de 12):",
    ...Array.from({ length: 12 }, (_, index) => `${String(index + 1).padStart(2)} | int v${index + 1} = ${index + 1};`),
    "",
    "Dependencias del archivo: bibliotecas string; lo usan src/main.cpp, src/rectangulo.h.",
    "",
    "Otros archivos del proyecto: " + Array.from({ length: 20 }, (_, index) => `src/f${index}.cpp (cpp, 10 lineas)`).join(", ") + ".",
  ].join("\n");
  assert.deepEqual(parseEditorContent(summary).map((section) => section.kind), ["meta", "code", "deps", "map"]);
  const tight = fitEditorContent(summary, 560, "file_summary");
  assert.deepEqual(tight.omitted, ["map"], "en el resumen se va primero el mapa");
  assert.match(tight.text, /^Dependencias del archivo: bibliotecas string; lo usan src\/main\.cpp/m);
  const tighter = fitEditorContent(summary, 400, "file_summary");
  assert.deepEqual(tighter.omitted, ["map", "deps"]);
  assert.match(tighter.text, / 6 \| int v6 = 6;/, "el codigo se queda");
});

test("prompt del editor: el contexto primero, el formato al final y dentro de la ventana", () => {
  const huge = `${NEW_CONTENT}\n${"// relleno\n".repeat(4000)}`;
  const prompt = buildCursorSelectionSuggestionPrompt({ tabContent: huge, question: "Mejora el bloque.", requestedAction: "replace", languageHint: "cpp", ragContext: "Material del curso recuperado...\n- [x#c1] Libro" });
  assert.ok(prompt.length <= promptBudgetChars() + 200, `prompt de ${prompt.length} caracteres`);
  const contextAt = prompt.indexOf("Contexto de seleccion/cursor:");
  const formatAt = prompt.indexOf("Responde en Markdown con este formato estricto:");
  const requestAt = prompt.indexOf("Pedido del estudiante: MEJORAR");
  assert.ok(contextAt > 0 && formatAt > contextAt && requestAt > contextAt, "las reglas van despues del contexto");
  assert.match(prompt.slice(-400), /Responde solo en espanol/);
  assert.match(prompt, /no los copies en el bloque/);
});

test("pedido de codigo: se detecta la respuesta sin codigo real y el reintento dice por que", () => {
  assert.equal(editorCodeProblem("1) Resumen:\n- Revisa el area."), "sin_bloque");
  assert.equal(editorCodeProblem("Aplicar: replace\n```cpp\n// TODO: corrige\n```"), "solo_marcador");
  assert.equal(editorCodeProblem("Aplicar: insert\n```cpp\n#include <vector>\n```"), "");
  assert.equal(editorCodeProblem("Aplicar: insert\n```cpp\ncout << total;\n```"), "");
  const retry = editorCodeRetryInstruction("replace", "cpp");
  assert.match(retry, /`Aplicar: replace`/);
  assert.match(retry, /```cpp/);
  assert.match(retry, /COMPLETO/);
});

test("respuesta del modelo: se quita el margen numerado copiado, solo si todas las lineas lo traen", () => {
  const answer = "Aplicar: replace\n```cpp\n  12>| double a = base * altura / 2;\n  13 |   return a;\n```\nfin";
  assert.equal(stripCodeFenceGutters(answer), "Aplicar: replace\n```cpp\ndouble a = base * altura / 2;\n  return a;\n```\nfin");
  const mixed = "```cpp\n12| x = 1;\nreturn x;\n```";
  assert.equal(stripCodeFenceGutters(mixed), mixed, "si no lo traen todas, no se toca");
  // editorCodeProblem recibe la salida ya preparada (sin margen): un TODO con margen no es codigo.
  assert.equal(editorCodeProblem(prepareEditorModelOutput("Aplicar: insert\n```cpp\n  12>|   // TODO: completa\n```")), "solo_marcador", "un TODO con margen no es codigo");
});
