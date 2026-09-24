import type { GithubMentorResult, HelpStage, PolicyRule, TeacherPolicy } from "../types/app.js";

/**
 * Plantillas de intervencion (A8.3 pista, A8.4 ejemplo parcial, A10.1
 * formatos por tipo y nivel) y etapas de ayuda graduales (A2.2, A9.8).
 *
 * Cada plantilla dice que estructura debe tener la respuesta, que limites
 * tiene (sobre todo de codigo) y que instruccion se agrega al prompt. Los
 * limites se vuelven a aplicar sobre la salida del modelo, porque el modelo
 * no siempre obedece.
 */

export type InterventionTemplate = {
  stage: HelpStage;
  label: string;
  purpose: string;
  structure: string[];
  /** Maximo de lineas de codigo por bloque; 0 = sin codigo. */
  maxCodeLines: number;
  promptInstruction: string;
  genericExample: string;
  antiSolutionChecklist: string[];
};

export const INTERVENTION_TEMPLATES: Record<HelpStage, InterventionTemplate> = {
  hint_1: {
    stage: "hint_1",
    label: "Pista nivel 1",
    purpose: "Orientar sin dar la respuesta: senalar donde mirar y hacer una pregunta guia.",
    structure: [
      "Que parece estar pasando (1 frase, sin juzgar).",
      "Donde mirar: la linea, el concepto o el mensaje de error relevante.",
      "Una pregunta guia que el estudiante pueda responder solo.",
      "Siguiente paso concreto y pequeno.",
    ],
    maxCodeLines: 0,
    promptInstruction:
      "Etapa de ayuda: PISTA NIVEL 1. No escribas codigo. Senala donde mirar, haz una pregunta guia y propone un paso pequeno.",
    genericExample:
      "Parece que el objeto se usa antes de crearse. Mira la linea donde declaras el puntero: ¿en que momento se reserva la memoria? Prueba imprimir su valor justo antes de usarlo.",
    antiSolutionChecklist: [
      "No contiene codigo.",
      "No dice la linea corregida.",
      "Termina en una pregunta o un paso que el estudiante ejecuta.",
    ],
  },
  hint_2: {
    stage: "hint_2",
    label: "Pista nivel 2",
    purpose: "Pista mas concreta cuando la primera no basto: nombra la causa probable y el concepto del curso.",
    structure: [
      "Causa probable, nombrando el concepto del curso (por ejemplo, encapsulamiento o referencia).",
      "Que revisar en su codigo, sin reescribirlo.",
      "Como comprobar si el arreglo funciono.",
      "Fuente del material autorizado, si aplica.",
    ],
    maxCodeLines: 2,
    promptInstruction:
      "Etapa de ayuda: PISTA NIVEL 2. Nombra la causa probable y el concepto del curso. Como maximo 2 lineas de pseudocodigo; nunca el codigo corregido del estudiante.",
    genericExample:
      "El error viene de acceder a un atributo privado desde fuera de la clase (encapsulamiento, RA2). Revisa que metodo publico deberia exponer ese dato y comprueba compilando otra vez.",
    antiSolutionChecklist: [
      "A lo sumo 2 lineas de pseudocodigo.",
      "No reescribe la funcion del estudiante.",
      "Incluye como comprobar el arreglo.",
    ],
  },
  partial_example: {
    stage: "partial_example",
    label: "Ejemplo parcial",
    purpose: "Mostrar el patron con otro dominio y otros nombres, dejando el hueco que el estudiante debe completar.",
    structure: [
      "Idea del patron en 1 frase.",
      "Ejemplo corto en OTRO dominio y con OTROS nombres (maximo 8 lineas).",
      "Un comentario TODO donde el estudiante debe completar.",
      "Que debe adaptar a su ejercicio.",
    ],
    maxCodeLines: 8,
    promptInstruction:
      "Etapa de ayuda: EJEMPLO PARCIAL. Usa otro dominio y otros nombres que los del estudiante, maximo 8 lineas de codigo, deja un TODO para que el complete. Nunca resuelvas su ejercicio.",
    genericExample:
      "class Cuenta {\n  double saldo; // privado\npublic:\n  void depositar(double monto) {\n    // TODO: valida el monto antes de sumarlo\n  }\n};",
    antiSolutionChecklist: [
      "Maximo 8 lineas de codigo.",
      "Nombres y dominio distintos a los del estudiante.",
      "Deja al menos un TODO.",
      "No se puede pegar tal cual en el ejercicio del estudiante.",
    ],
  },
  explanation: {
    stage: "explanation",
    label: "Explicacion breve",
    purpose: "Aclarar un concepto del curso cuando la duda es conceptual.",
    structure: [
      "Definicion en 1 o 2 frases con palabras del curso.",
      "Por que importa en su ejercicio.",
      "Un ejemplo minimo (maximo 4 lineas) o una analogia.",
      "Fuente del material autorizado.",
    ],
    maxCodeLines: 4,
    promptInstruction:
      "Etapa de ayuda: EXPLICACION BREVE del concepto. Maximo 5 frases, un ejemplo de maximo 4 lineas y la cita del material autorizado.",
    genericExample:
      "Polimorfismo: un mismo mensaje (metodo) produce comportamientos distintos segun el objeto que lo recibe. Evita cadenas de if por tipo (RA3).",
    antiSolutionChecklist: ["Maximo 4 lineas de codigo.", "Cita la fuente cuando existe."],
  },
  mini_quiz: {
    stage: "mini_quiz",
    label: "Mini-quiz",
    purpose: "Verificar comprension con una pregunta de opcion multiple (ver src/services/quiz.ts y data/quiz/banco-fpoo.json).",
    structure: [
      "Una pregunta sobre el concepto o el cambio.",
      "3 a 5 opciones, una correcta.",
      "Explicacion de la respuesta, que se muestra despues de contestar.",
    ],
    maxCodeLines: 6,
    promptInstruction:
      "Etapa de ayuda: MINI-QUIZ. Propone una sola pregunta de opcion multiple sobre el concepto; no des la respuesta en el mismo mensaje.",
    genericExample:
      "¿Que pasa si un atributo es private y lo lees desde main? a) Compila b) Error de acceso c) Se copia d) Se vuelve public",
    antiSolutionChecklist: ["La respuesta correcta no aparece antes de contestar."],
  },
  controlled: {
    stage: "controlled",
    label: "Mensaje controlado",
    purpose: "Responder sin inventar cuando falta contexto, la consulta sale del curso o la politica no permite ayudar.",
    structure: [
      "Por que no se puede ayudar todavia (motivo corto).",
      "Que contexto hace falta (enunciado, error visible o fragmento).",
    ],
    maxCodeLines: 0,
    promptInstruction: "",
    genericExample:
      "No tengo suficiente contexto para ayudarte sin inventar. Comparte el enunciado, el error que ves o un fragmento corto del codigo.",
    antiSolutionChecklist: ["No contiene codigo.", "No inventa datos del ejercicio."],
  },
};

/** Tipo de intervencion de cada etapa, para cruzarlo con allowedInterventions del docente. */
export const STAGE_INTERVENTION: Record<HelpStage, string> = {
  hint_1: "hint",
  hint_2: "hint",
  partial_example: "example",
  explanation: "explanation",
  mini_quiz: "mini_quiz",
  controlled: "controlled_message",
};

/** Si el docente no permite el tipo de la etapa, se prueba la siguiente de la lista. */
const STAGE_FALLBACKS: Record<HelpStage, HelpStage[]> = {
  hint_1: ["hint_1", "explanation", "partial_example"],
  hint_2: ["hint_2", "explanation", "partial_example"],
  partial_example: ["partial_example", "hint_2", "explanation"],
  explanation: ["explanation", "hint_1", "partial_example"],
  mini_quiz: ["mini_quiz", "hint_1", "explanation"],
  controlled: ["controlled"],
};

/**
 * Ajusta la etapa a las intervenciones habilitadas por el docente
 * (allowedInterventions). Lista vacia = sin restriccion (politicas viejas).
 * Si ningun tipo de la cadena esta permitido, la etapa queda "controlled" y
 * quien llama responde con el mensaje del docente.
 */
export function restrictStageToAllowed(stage: HelpStage, allowedInterventions: readonly string[] | null | undefined): HelpStage {
  const allowed = (allowedInterventions || []).map((item) => String(item));
  if (!allowed.length || stage === "controlled") return stage;
  return STAGE_FALLBACKS[stage].find((candidate) => allowed.includes(STAGE_INTERVENTION[candidate])) || "controlled";
}

/**
 * Etapa de ayuda segun la regla del evento, el nivel de ayuda del docente,
 * cuantas pistas ya uso el estudiante en ese ejercicio (A2.2: pista 1,
 * pista 2, ejemplo parcial) y las intervenciones que el docente habilito.
 */
export function resolveHelpStage(input: {
  policy: Pick<TeacherPolicy, "helpLevel" | "allowMiniQuiz"> & Partial<Pick<TeacherPolicy, "allowedInterventions">>;
  rule: Pick<PolicyRule, "interventionType"> | null | undefined;
  hintsUsed: number;
  blocked?: boolean;
}): HelpStage {
  if (input.blocked || !input.rule) return "controlled";
  const stage = baseHelpStage({ policy: input.policy, rule: input.rule, hintsUsed: input.hintsUsed });
  return restrictStageToAllowed(stage, input.policy.allowedInterventions);
}

function baseHelpStage(input: {
  policy: Pick<TeacherPolicy, "helpLevel" | "allowMiniQuiz">;
  rule: Pick<PolicyRule, "interventionType">;
  hintsUsed: number;
}): HelpStage {
  const type = input.rule.interventionType;
  if (type === "controlled_message") return "controlled";
  if (type === "explanation") return "explanation";
  if (type === "mini_quiz") return input.policy.allowMiniQuiz ? "mini_quiz" : "hint_1";
  if (type === "example") return "partial_example";

  const used = Math.max(0, Math.floor(input.hintsUsed || 0));
  if (input.policy.helpLevel === "hint_only") {
    return used === 0 ? "hint_1" : "hint_2";
  }
  if (input.policy.helpLevel === "partial_example") {
    return used === 0 ? "hint_1" : "partial_example";
  }
  // progressive (por defecto)
  if (used === 0) return "hint_1";
  if (used === 1) return "hint_2";
  return "partial_example";
}

const FENCE = /```[^\n]*\n([\s\S]*?)```/g;

/**
 * Recorta los bloques de codigo a maxLines lineas (0 = quita el codigo).
 * Devuelve si hubo recorte para que quien llama pueda quitar la opcion de
 * aplicar el cambio.
 */
export function limitCodeBlocks(text: string, maxLines: number) {
  let truncated = false;
  let codeLines = 0;
  const output = String(text || "").replace(FENCE, (block, body: string) => {
    const header = block.slice(0, block.indexOf("\n") + 1);
    const lines = body.replace(/\n$/, "").split("\n");
    codeLines += lines.length;
    if (maxLines <= 0) {
      truncated = true;
      return "_(codigo omitido: en esta etapa la ayuda es solo una pista)_";
    }
    if (lines.length <= maxLines) return block;
    truncated = true;
    const kept = lines.slice(0, maxLines);
    kept.push("// ... recortado por la politica del docente: completa el resto tu");
    return `${header}${kept.join("\n")}\n\`\`\``;
  });
  return { text: output, truncated, codeLines };
}

/** Aplica los limites de la plantilla a cada item de una respuesta estructurada del overlay. */
export function applyTemplateLimits(result: GithubMentorResult, stage: HelpStage): GithubMentorResult {
  const template = INTERVENTION_TEMPLATES[stage];
  const limit = (items: string[]) => items.map((item) => limitCodeBlocks(item, template.maxCodeLines).text);
  return {
    ...result,
    ideas: limit(result.ideas),
    searches: limit(result.searches),
    guide: limit(result.guide),
  };
}

export function templateInstruction(stage: HelpStage) {
  return INTERVENTION_TEMPLATES[stage].promptInstruction;
}

/**
 * Tope de lineas de codigo por etapa en el editor (VS Code). En el overlay la
 * pista 1 no lleva codigo; en el editor si puede llevar un cambio pequeno,
 * porque la sugerencia se aplica sobre el archivo y sin codigo no habria
 * nada que aplicar (ni mini-quiz despues de aceptar). La ayuda se gradua por
 * tamano del cambio: 5 lineas, luego 10, luego el maximo del docente
 * (codeApplication.maxLines), que siempre manda.
 */
const EDITOR_STAGE_CODE_CAP: Record<HelpStage, number | null> = {
  hint_1: 5,
  hint_2: 10,
  partial_example: null,
  explanation: 4,
  mini_quiz: 6,
  controlled: 0,
};

export function editorCodeLineLimit(stage: HelpStage, teacherMaxLines: number) {
  const teacherMax = Math.max(0, Math.floor(Number(teacherMaxLines) || 0));
  const cap = EDITOR_STAGE_CODE_CAP[stage];
  return cap === null ? teacherMax : Math.min(cap, teacherMax);
}

/** Instruccion de la etapa para el prompt de VS Code, con el tope de lineas ya resuelto. */
export function editorStageInstruction(stage: HelpStage, maxLines: number) {
  switch (stage) {
    case "hint_1":
      return `Etapa de ayuda: PISTA NIVEL 1 (editor). Explica en 1 o 2 frases donde esta el problema y haz una pregunta guia. Si propones un cambio de codigo, que sea el minimo y solo del fragmento relevante (maximo ${maxLines} lineas).`;
    case "hint_2":
      return `Etapa de ayuda: PISTA NIVEL 2 (editor). Nombra la causa probable y el concepto del curso, y di como comprobar el arreglo. Si propones un cambio, maximo ${maxLines} lineas y solo del fragmento relevante.`;
    case "partial_example":
      return `Etapa de ayuda: EJEMPLO PARCIAL (editor). Muestra el patron sobre el fragmento del estudiante (maximo ${maxLines} lineas) y deja un comentario TODO en la parte que el debe completar. Nunca completes todo el ejercicio.`;
    case "explanation":
      return `Etapa de ayuda: EXPLICACION BREVE del concepto. Maximo 5 frases y, si ayuda, un ejemplo de maximo ${maxLines} lineas; cita el material autorizado si existe.`;
    default:
      return templateInstruction(stage);
  }
}
