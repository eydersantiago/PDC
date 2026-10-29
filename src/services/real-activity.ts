// Que cuenta como actividad de un estudiante (examen del 28-10-2026).
//
// Antes «activo ahora» salia de app_sessions.last_seen_at, que renueva cualquier llamada con sesion,
// tambien la que el overlay hace sola cada 9 s para saber que pestana tiene la sesion: un estudiante
// salio activo 9 h 37 min con una pestana abierta. Ahora cada evento se clasifica en:
//   tutor   pidio o recibio ayuda: pistas, sugerencias, aplicar codigo, quices;
//   editor  trabajo en VS Code (cualquier evento de la extension de VS Code) o en su entorno:
//           errores de compilacion, bloqueos, preparar o abrir el editor;
//   tab     solo tiene ADACEEN abierto: navegacion (pestana visible u oculta, overlay abierto o
//           cerrado) y las consultas automaticas.
// Solo tutor y editor cuentan como activos. La misma regla la usan el panel «Estudiantes»
// (student-progress.ts) y los activos del monitor del piloto (readLiveKpis).

export type ActivityKind = "tutor" | "editor" | "tab";

/** Estado de un estudiante en la ventana: el de su actividad mas fuerte. */
export type PresenceState = ActivityKind | "none";

const TUTOR_CATEGORIES = new Set(["tutor", "suggestion", "code_application", "quiz", "intervention"]);
const EDITOR_CATEGORIES = new Set(["signal", "workflow", "codespace", "cursor_idle", "error"]);

export function classifyActivity(event: { source?: string | null; category?: string | null }): ActivityKind {
  const category = String(event.category || "").trim().toLowerCase();
  if (TUTOR_CATEGORIES.has(category)) return "tutor";
  if (String(event.source || "").trim().toLowerCase() === "vscode_extension") return "editor";
  if (EDITOR_CATEGORIES.has(category)) return "editor";
  return "tab";
}

export function isRealActivity(kind: ActivityKind | PresenceState) {
  return kind === "tutor" || kind === "editor";
}

export const PRESENCE_LABELS: Record<PresenceState, string> = {
  tutor: "Con el tutor",
  editor: "En el editor",
  tab: "Solo pestaña abierta",
  none: "Sin actividad reciente",
};
