// Por que el tutor no respondio y que hacer, segun la causa (examen del 28-10-2026).
//
// Un estudiante tuvo 8 bloqueos en 15 intervenciones: 2 en paginas de GitHub sin codigo y 6 en el
// editor sin archivo abierto (5 en el mismo minuto). Todos decian el mensaje generico del docente,
// que no le decia que hacer. Ahora cada bloqueo dice su causa y el paso que lo resuelve; el mensaje
// del docente (fallbackMessage) sigue saliendo cuando la causa es su politica.
//
// Lo usan el overlay (decision-engine.ts, /intervene) y VS Code (suggestion-policy.ts, /suggest-tab).
// La causa tambien va a la telemetria (metadata.cause) para separar estos bloqueos de los de politica.
import type { DecisionReasonCode, GithubMentorContext, PolicyEventType } from "../types/app.js";
import { normalizePageType, resolvePageContext, trimText } from "./text-utils.js";

export type BlockCause =
  | "pilot_no_tutor"
  | "rule_disabled"
  | "hint_limit"
  | "out_of_domain"
  | "github_sin_archivo"
  | "editor_sin_archivo"
  | "campus_sin_actividad"
  | "sin_contexto";

export type BlockExplanation = {
  cause: BlockCause;
  /** Que paso y que hacer, en una o dos frases para el estudiante. */
  message: string;
  /** Pasos concretos (la guia del overlay). */
  steps: string[];
};

/** Causa de un bloqueo del overlay a partir del motivo y de la pagina en que estaba el estudiante. */
export function overlayBlockCause(input: {
  reasonCode: DecisionReasonCode | "";
  eventType: PolicyEventType | "";
  context: GithubMentorContext;
}): BlockCause {
  if (input.reasonCode === "pilot_no_tutor") return "pilot_no_tutor";
  // Sin nada que leer en pantalla, eso es lo que hay que resolver, aunque la regla de ese evento
  // este desactivada.
  if (input.reasonCode === "rule_disabled" && input.eventType !== "insufficient_context") return "rule_disabled";
  if (input.reasonCode === "hint_limit_reached") return "hint_limit";
  if (input.reasonCode === "out_of_domain" || input.eventType === "out_of_domain") return "out_of_domain";
  const context = input.context;
  const hasCode = Boolean(trimText(context.codeSnippet) || trimText(context.selection));
  const pageType = normalizePageType(context.pageType);
  if (!hasCode && pageType === "codespace") return "editor_sin_archivo";
  if (!hasCode && (pageType === "github_general" || pageType === "github_code")) return "github_sin_archivo";
  const campus = resolvePageContext(context.pageContext, context.pageType) === "campus";
  if (campus && !trimText(context.activityTitle)) return "campus_sin_actividad";
  return "sin_contexto";
}

/** Causa de un bloqueo de VS Code: alli siempre hay un archivo abierto (sin el no se pide). */
export function editorBlockCause(reasonCode: DecisionReasonCode): BlockCause {
  if (reasonCode === "pilot_no_tutor") return "pilot_no_tutor";
  if (reasonCode === "rule_disabled") return "rule_disabled";
  if (reasonCode === "hint_limit_reached") return "hint_limit";
  if (reasonCode === "out_of_domain") return "out_of_domain";
  return "sin_contexto";
}

export function explainBlock(cause: BlockCause, options: { fallbackMessage?: string; maxHints?: number | null; channel?: "overlay" | "vscode" } = {}): BlockExplanation {
  const fallback = trimText(options.fallbackMessage);
  const vscode = options.channel === "vscode";
  switch (cause) {
    case "github_sin_archivo":
      return {
        cause,
        message: "En esta página de GitHub no hay código que yo pueda leer. Abre el archivo en el que trabajas (por ejemplo, main.cpp) y vuelve a pedir ayuda.",
        steps: [
          "En la lista de archivos del repositorio, haz clic en el archivo de código.",
          "Cuando veas el código en pantalla, pulsa Actualizar en ADACEEN.",
          "Si ya trabajas en tu editor, pide la ayuda desde allí: ADACEEN lee el archivo abierto.",
        ],
      };
    case "editor_sin_archivo":
      return {
        cause,
        message: "No hay ningún archivo abierto en el editor. Abre el archivo en el que trabajas (doble clic en el explorador de la izquierda) y vuelve a pedir ayuda.",
        steps: [
          "En el explorador de la izquierda, haz doble clic en tu archivo (por ejemplo, main.cpp).",
          "Con el código a la vista, pulsa Actualizar en ADACEEN.",
          "Si tienes un error, déjalo visible: el tutor lo lee.",
        ],
      };
    case "campus_sin_actividad":
      return {
        cause,
        message: "No veo una actividad abierta en el Campus. Abre el enunciado de la actividad y vuelve a pedir ayuda.",
        steps: [
          "Entra a la actividad o tarea del curso en el Campus.",
          "Con el enunciado en pantalla, pulsa Actualizar en ADACEEN.",
        ],
      };
    case "out_of_domain":
      // Fuera del dominio es la politica del docente: va su mensaje (escenario S5b).
      return {
        cause,
        message: fallback || "Tu pregunta parece de otro tema. El tutor ayuda con la programación del curso: pregunta por tu código, el error que ves o el enunciado.",
        steps: [
          "Escribe la duda sobre tu código o el ejercicio.",
          "Si es de otro tema, pregúntale a tu docente.",
        ],
      };
    case "hint_limit":
      return {
        cause,
        // El texto de siempre (A2.2, lo cita la guia), con el paso que sigue.
        message: options.maxHints
          ? `Ya alcanzaste el limite de pistas definido por el docente para este ejercicio (${options.maxHints}). Intenta el siguiente paso por tu cuenta.`
          : "Ya alcanzaste el limite de pistas definido por el docente para este ejercicio. Intenta el siguiente paso por tu cuenta.",
        steps: ["Revisa las pistas anteriores y prueba un cambio pequeño.", "Si sigues bloqueado, pregúntale a tu docente."],
      };
    case "rule_disabled":
      return {
        cause,
        message: [fallback, "Tu docente desactivó este tipo de ayuda por ahora."].filter(Boolean).join(" "),
        steps: ["Sigue con el ejercicio por tu cuenta.", "Si lo necesitas, pregúntale a tu docente."],
      };
    case "pilot_no_tutor":
      return { cause, message: fallback, steps: [] };
    default:
      return {
        cause: "sin_contexto",
        message: vscode
          ? "Me falta contexto para ayudarte sin inventar. Selecciona el fragmento donde estás bloqueado o escribe tu pregunta, y vuelve a pedir la sugerencia."
          : "Me falta contexto para ayudarte sin inventar. Deja a la vista el código o el error, o escribe tu pregunta, y vuelve a pedir ayuda.",
        steps: [
          "Selecciona el fragmento de código donde estás bloqueado.",
          "Si hay un error, déjalo visible o cópialo en tu pregunta.",
          "Vuelve a pedir ayuda con ese contexto.",
        ],
      };
  }
}
