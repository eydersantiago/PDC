import type { DecisionReasonCode, GithubMentorContext, HelpStage, PolicyEventType } from "../types/app.js";

/**
 * Escenarios operativos S1-S5 del tutor (A9.5, A11.4, A10.7).
 *
 * Una sola definicion para las pruebas (tests/routes/tutor-scenarios.test.ts),
 * la demo reproducible (scripts/demo-escenarios.ts) y la documentacion
 * (docs/tutor/escenarios.md). Cada escenario trae la peticion del overlay
 * (/intervene) y la del editor (/suggest-tab) con el resultado esperado bajo
 * la politica base del piloto (src/db/seeds.ts).
 *
 * Tambien trae una salida de referencia del modelo: respuestas fijas, con
 * mas codigo del permitido a proposito, para mostrar el guardarrail sin GPU.
 */

export type ScenarioId = "S1" | "S2" | "S3" | "S4" | "S5a" | "S5b";

export type ScenarioExpectation = {
  eventType: PolicyEventType;
  blocked: boolean;
  helpStage: HelpStage;
  reasonCode: DecisionReasonCode;
};

export type EditorRequestBody = {
  tab_content: string;
  tab_title: string;
  filePath: string;
  languageHint: string;
  question?: string;
  visibleError?: string;
  diagnostics?: Array<{ message: string; severity: "error" | "warning"; line?: number }>;
  trigger: string;
  suggestion_scope?: string;
};

export type TutorScenario = {
  id: ScenarioId;
  titulo: string;
  descripcion: string;
  overlay: {
    question: string;
    context: GithubMentorContext;
    expected: ScenarioExpectation;
  };
  /** null cuando el escenario no aplica al editor (en VS Code siempre hay archivo). */
  editor: {
    body: EditorRequestBody;
    expected: ScenarioExpectation;
  } | null;
};

export const SCENARIO_CPP_CODE = [
  "#include <iostream>",
  "",
  "class Cuenta {",
  "  double saldo;",
  "public:",
  "  void depositar(double monto) { saldo += monto }",
  "  double getSaldo() const { return saldo; }",
  "};",
].join("\n");

export const SCENARIO_PY_CODE = [
  "def promedio(notas):",
  "    return sum(notas) / len(notas)",
  "",
  "print(promedio([]))",
].join("\n");

export const TUTOR_SCENARIOS: TutorScenario[] = [
  {
    id: "S1",
    titulo: "Error de compilacion",
    descripcion: "El estudiante ve un error del compilador (C++) y pide ayuda: pista gradual, sin la linea corregida.",
    overlay: {
      question: "Que significa este error?",
      context: {
        pageType: "github_code",
        repoFullName: "curso-fpoo/taller-1-demo",
        filePath: "src/cuenta.cpp",
        languageHint: "cpp",
        activityTitle: "Taller 1 - Cuenta bancaria",
        visibleError: "src/cuenta.cpp:6:48: error: expected ';' before '}' token",
        codeSnippet: SCENARIO_CPP_CODE,
      },
      expected: { eventType: "compile_error", blocked: false, helpStage: "hint_1", reasonCode: "ok" },
    },
    editor: {
      body: {
        tab_content: SCENARIO_CPP_CODE,
        tab_title: "cuenta.cpp",
        filePath: "src/cuenta.cpp",
        languageHint: "cpp",
        visibleError: "cuenta.cpp:6:48: error: expected ';' before '}' token",
        trigger: "blocking",
      },
      expected: { eventType: "compile_error", blocked: false, helpStage: "hint_1", reasonCode: "ok" },
    },
  },
  {
    id: "S2",
    titulo: "Falla en ejecucion o prueba",
    descripcion: "El programa compila pero falla al ejecutar (Python): se nombra la causa probable y como comprobarla.",
    overlay: {
      question: "Por que falla al ejecutar?",
      context: {
        pageType: "codespace",
        filePath: "notas.py",
        languageHint: "python",
        activityTitle: "Taller 2 - Promedios",
        visibleError: "Traceback (most recent call last):\n  File \"notas.py\", line 4, in <module>\nZeroDivisionError: division by zero",
        codeSnippet: SCENARIO_PY_CODE,
      },
      expected: { eventType: "runtime_error", blocked: false, helpStage: "hint_1", reasonCode: "ok" },
    },
    editor: {
      body: {
        tab_content: SCENARIO_PY_CODE,
        tab_title: "notas.py",
        filePath: "notas.py",
        languageHint: "python",
        diagnostics: [{ message: "ZeroDivisionError: division by zero", severity: "error", line: 2 }],
        trigger: "manual",
      },
      expected: { eventType: "runtime_error", blocked: false, helpStage: "hint_1", reasonCode: "ok" },
    },
  },
  {
    id: "S3",
    titulo: "Pregunta conceptual",
    descripcion: "Duda de un concepto del curso (polimorfismo): explicacion breve con la fuente autorizada.",
    overlay: {
      question: "Que es el polimorfismo en POO?",
      context: {
        pageType: "campus",
        activityTitle: "Taller 3 - Polimorfismo",
        selection: "Implemente la jerarquia Figura con el metodo area().",
      },
      expected: { eventType: "concept_question", blocked: false, helpStage: "explanation", reasonCode: "ok" },
    },
    editor: {
      body: {
        tab_content: SCENARIO_CPP_CODE,
        tab_title: "cuenta.cpp",
        filePath: "src/cuenta.cpp",
        languageHint: "cpp",
        question: "Que es el polimorfismo y para que me sirve aqui?",
        trigger: "panel",
      },
      expected: { eventType: "concept_question", blocked: false, helpStage: "explanation", reasonCode: "ok" },
    },
  },
  {
    id: "S4",
    titulo: "Bloqueo de diseno",
    descripcion: "No sabe como pasar el enunciado a clases y relaciones: pista sobre responsabilidades, sin el diseno resuelto.",
    overlay: {
      question: "Como organizo las responsabilidades del enunciado del taller?",
      context: {
        pageType: "campus",
        activityTitle: "Taller 4 - Banco",
        selection: "Un banco tiene clientes y cada cliente puede tener varias cuentas.",
      },
      expected: { eventType: "design_block", blocked: false, helpStage: "hint_1", reasonCode: "ok" },
    },
    editor: {
      body: {
        tab_content: SCENARIO_CPP_CODE,
        tab_title: "cuenta.cpp",
        filePath: "src/banco.cpp",
        languageHint: "cpp",
        question: "Como modelar la relacion entre Cuenta y Banco segun el enunciado?",
        trigger: "panel",
      },
      expected: { eventType: "design_block", blocked: false, helpStage: "hint_1", reasonCode: "ok" },
    },
  },
  {
    id: "S5a",
    titulo: "Contexto insuficiente",
    descripcion: "Pide ayuda sin enunciado, error ni codigo: mensaje controlado que pide el contexto, sin inventar.",
    overlay: {
      question: "Ayudame",
      context: {},
      expected: { eventType: "insufficient_context", blocked: true, helpStage: "controlled", reasonCode: "insufficient_context" },
    },
    editor: null,
  },
  {
    id: "S5b",
    titulo: "Fuera del dominio del curso",
    descripcion: "Pregunta que no es del curso: mensaje controlado del docente, sin llamar al modelo.",
    overlay: {
      question: "Cual es la capital de Francia?",
      context: {
        pageType: "campus",
        activityTitle: "Foro de bienvenida",
      },
      expected: { eventType: "out_of_domain", blocked: true, helpStage: "controlled", reasonCode: "out_of_domain" },
    },
    editor: {
      body: {
        tab_content: "Lista del mercado: arroz, papa, cebolla",
        tab_title: "mercado.txt",
        filePath: "notas/mercado.txt",
        languageHint: "plaintext",
        question: "Cual es la capital de Francia?",
        trigger: "panel",
      },
      expected: { eventType: "out_of_domain", blocked: true, helpStage: "controlled", reasonCode: "out_of_domain" },
    },
  },
];

/** Bloque de codigo largo (una "solucion completa") para probar el guardarrail. */
export function referenceSolutionBlock(lines = 14, language = "cpp") {
  const body = Array.from({ length: lines }, (_, index) => `  paso_${index + 1}();`).join("\n");
  return `\`\`\`${language}\n${body}\n\`\`\``;
}

/**
 * Salida de referencia del modelo: JSON para el overlay y Markdown para el
 * editor. Siempre trae 14 lineas de codigo y la linea "Aplicar:", mas de lo
 * que permite cualquier etapa inicial, para que el recorte sea visible.
 */
export function referenceModelOutput(prompt: string) {
  if (/Devuelve SOLO JSON valido/.test(prompt)) {
    return JSON.stringify({
      ideas: [
        `Revisa la linea que indica el mensaje y compara con este patron:\n${referenceSolutionBlock()}`,
        "Pregunta guia: que espera el compilador justo antes del cierre de la funcion?",
        "Compila de nuevo despues de cada cambio pequeno.",
      ],
      searches: ["punto y coma en C++", "estructura de una clase en C++", "mensajes de error de g++"],
      guide: [
        "Lee el primer error del compilador.",
        "Ubica la linea y la columna.",
        "Revisa la instruccion anterior al cierre.",
        "Compila otra vez y compara el mensaje.",
      ],
      welcome_message: "Vamos paso a paso.",
      analysis_summary: "Error de sintaxis en una instruccion de la clase.",
    });
  }
  return [
    "1) Resumen:",
    "- La instruccion antes del cierre de la funcion no termina correctamente.",
    "",
    "2) Sugerencias del archivo:",
    "- Compila despues de cada cambio pequeno.",
    "",
    "3) Sugerencias del codigo:",
    "- Revisa la linea que indica el compilador.",
    "",
    "4) Accion:",
    "Aplicar: replace",
    referenceSolutionBlock(),
    "",
    "5) Riesgos:",
    "- Verifica que el resto de metodos siga compilando.",
  ].join("\n");
}

/** Variante corta de la salida del editor: un cambio aplicable de 2 lineas. */
export function referenceSmallFixOutput() {
  return [
    "1) Resumen:",
    "- Falta el punto y coma en depositar.",
    "",
    "3) Sugerencias del codigo:",
    "- Que termina cada instruccion en C++?",
    "",
    "4) Accion:",
    "Aplicar: replace",
    "```cpp",
    "  void depositar(double monto) { saldo += monto; }",
    "  double getSaldo() const { return saldo; }",
    "```",
    "",
    "5) Riesgos:",
    "- Comprueba que saldo se inicialice en el constructor.",
  ].join("\n");
}
