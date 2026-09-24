/**
 * Catalogo de eventos y diccionario de campos de la telemetria v1.1 (A4.1, A4.3).
 *
 * Es la fuente de verdad: el backend lo usa para validar lo que llega y el
 * script `scripts/generar-diccionario-telemetria.ts` lo convierte en
 * `docs/telemetria/diccionario-eventos.md`. Si se agrega un evento en un
 * cliente, se agrega primero aqui.
 */

export type TelemetrySource = "browser_extension" | "vscode_extension" | "backend" | "system";

export type TelemetryCategory =
  | "suggestion"
  | "cursor_idle"
  | "codespace"
  | "github_pr"
  | "navigation"
  | "project_context"
  | "intervention"
  | "error"
  | "workflow"
  | "tutor"
  | "signal"
  | "code_application"
  | "quiz";

export const TELEMETRY_CATEGORIES: TelemetryCategory[] = [
  "suggestion",
  "cursor_idle",
  "codespace",
  "github_pr",
  "navigation",
  "project_context",
  "intervention",
  "error",
  "workflow",
  "tutor",
  "signal",
  "code_application",
  "quiz",
];

export type EventCatalogEntry = {
  eventType: string;
  category: TelemetryCategory;
  sources: TelemetrySource[];
  /** Quien lo provoca. */
  actor: "estudiante" | "docente" | "sistema" | "estudiante o docente";
  /** Cuando ocurre, en una frase. */
  when: string;
  /** Para que sirve en el analisis. */
  purpose: string;
  /** Campos propios del evento, ademas de los comunes. */
  fields: string[];
  /** KPI del anteproyecto que alimenta (5.4 y 8.3). */
  kpis: string[];
  /** Debe llevar decisionId para enlazarse con la decision del tutor. */
  requiresDecision?: boolean;
};

export const EVENT_CATALOG: EventCatalogEntry[] = [
  // --- Decisiones del tutor (backend) --------------------------------------
  {
    eventType: "tutor_decision",
    category: "tutor",
    sources: ["backend"],
    actor: "sistema",
    when: "Cada vez que el motor de politicas decide una intervencion (overlay o VS Code), bloqueada o no.",
    purpose: "Trazabilidad de la decision: evento de politica, tipo de intervencion, etapa de ayuda, motivo y latencia.",
    fields: ["decisionId", "channel", "policyEventType", "interventionType", "helpStage", "reasonCode", "blocked", "latencyMs", "errorHash", "contextHash", "exerciseHash"],
    kpis: ["latencia p50/p95", "tasa de bloqueo por politica", "uso efectivo de intervenciones"],
  },
  {
    eventType: "code_application_checked",
    category: "code_application",
    sources: ["backend"],
    actor: "sistema",
    when: "VS Code pregunta si puede aplicar un cambio de codigo del tutor (POST /api/suggestions/apply-check).",
    purpose: "Cumplimiento del limite de aplicacion de codigo (sin solucion completa) y conteo de pistas por ejercicio.",
    fields: ["decisionId", "blocked", "reasonCode", "exerciseHash", "metadata.applyMode", "metadata.linesChanged"],
    kpis: ["uso efectivo de intervenciones", "aplicaciones bloqueadas por politica"],
  },
  // --- Overlay del navegador -----------------------------------------------
  {
    eventType: "overlay_opened",
    category: "navigation",
    sources: ["browser_extension"],
    actor: "estudiante o docente",
    when: "Se abre el overlay (metadata.trigger: user, restore o sync).",
    purpose: "Uso del tutor en el navegador; filtrar por trigger=user para no contar aperturas sincronizadas.",
    fields: ["metadata.trigger"],
    kpis: ["uso del agente"],
  },
  {
    eventType: "overlay_closed",
    category: "navigation",
    sources: ["browser_extension"],
    actor: "estudiante o docente",
    when: "Se cierra el overlay.",
    purpose: "Tiempo de uso por apertura.",
    fields: ["durationMs"],
    kpis: ["uso del agente"],
  },
  {
    eventType: "tutor_request_submitted",
    category: "tutor",
    sources: ["browser_extension"],
    actor: "estudiante",
    when: "El estudiante pide ayuda (value: manual, shortcut o auto).",
    purpose: "Demanda de ayuda bajo demanda frente a automatica.",
    fields: ["value", "metadata.pageType"],
    kpis: ["uso efectivo de intervenciones"],
  },
  {
    eventType: "tutor_response_received",
    category: "tutor",
    sources: ["browser_extension"],
    actor: "sistema",
    when: "Llega la respuesta del backend al overlay.",
    purpose: "Latencia percibida por el estudiante (clic a respuesta).",
    fields: ["decisionId", "latencyMs", "value", "metadata.blocked"],
    kpis: ["latencia p50/p95"],
    requiresDecision: true,
  },
  {
    eventType: "tutor_response_shown",
    category: "tutor",
    sources: ["browser_extension"],
    actor: "sistema",
    when: "La respuesta del tutor se pinta en el overlay.",
    purpose: "Denominador de la tasa de aceptacion.",
    fields: ["decisionId"],
    kpis: ["aceptacion de sugerencias"],
    requiresDecision: true,
  },
  {
    eventType: "tutor_response_accepted",
    category: "tutor",
    sources: ["browser_extension"],
    actor: "estudiante",
    when: "El estudiante marca \"Me sirvio\".",
    purpose: "Aceptacion y oportunidad de la sugerencia.",
    fields: ["decisionId", "durationMs"],
    kpis: ["aceptacion de sugerencias", "oportunidad"],
    requiresDecision: true,
  },
  {
    eventType: "tutor_response_rejected",
    category: "tutor",
    sources: ["browser_extension"],
    actor: "estudiante",
    when: "El estudiante marca \"No me sirvio\".",
    purpose: "Rechazo explicito de la sugerencia.",
    fields: ["decisionId", "durationMs"],
    kpis: ["aceptacion de sugerencias"],
    requiresDecision: true,
  },
  {
    eventType: "tutor_response_ignored",
    category: "tutor",
    sources: ["browser_extension"],
    actor: "estudiante",
    when: "Una respuesta mostrada se reemplaza o se cierra sin que el estudiante la califique.",
    purpose: "Respuestas no atendidas.",
    fields: ["decisionId", "durationMs"],
    kpis: ["aceptacion de sugerencias"],
    requiresDecision: true,
  },
  {
    eventType: "rag_source_opened",
    category: "tutor",
    sources: ["browser_extension"],
    actor: "estudiante",
    when: "El estudiante abre una fuente del material autorizado citada por el tutor.",
    purpose: "Uso del material autorizado (RAG).",
    fields: ["decisionId", "value"],
    kpis: ["uso de material autorizado"],
  },
  {
    eventType: "error_detected",
    category: "signal",
    sources: ["browser_extension"],
    actor: "sistema",
    when: "El overlay ve un error en la pagina (se deduplica 60 s).",
    purpose: "Senal de dificultad; el texto solo llega como hash.",
    fields: ["errorHash", "pageContext"],
    kpis: ["tiempo hasta desbloqueo"],
  },
  {
    eventType: "blocking_detected",
    category: "signal",
    sources: ["browser_extension", "vscode_extension"],
    actor: "sistema",
    when: "El mismo error sigue presente 120 s (navegador) o 90 s (VS Code), o aparece 3 veces en 10 min.",
    purpose: "Inicio de un episodio de bloqueo; base del tiempo hasta desbloqueo.",
    fields: ["errorHash", "language", "durationMs", "count"],
    kpis: ["tiempo hasta desbloqueo"],
  },
  // --- VS Code ---------------------------------------------------------------
  {
    eventType: "vscode_suggestion_shown",
    category: "suggestion",
    sources: ["vscode_extension"],
    actor: "sistema",
    when: "Se muestra una sugerencia en VS Code.",
    purpose: "Denominador de aceptacion en VS Code; latencia de la sugerencia.",
    fields: ["decisionId", "latencyMs", "language", "filePath"],
    kpis: ["aceptacion de sugerencias", "latencia p50/p95"],
    requiresDecision: true,
  },
  {
    eventType: "vscode_suggestion_actions_revealed",
    category: "suggestion",
    sources: ["vscode_extension"],
    actor: "estudiante",
    when: "El estudiante despliega las acciones de una sugerencia.",
    purpose: "Interes en la sugerencia.",
    fields: ["decisionId"],
    kpis: ["uso efectivo de intervenciones"],
  },
  {
    eventType: "suggestion_completion_applied",
    category: "suggestion",
    sources: ["vscode_extension"],
    actor: "estudiante",
    when: "Se aplica en el archivo el cambio sugerido (value: insert, replace o delete).",
    purpose: "Aceptacion efectiva con cambio de codigo.",
    fields: ["decisionId", "value", "metadata.linesChanged"],
    kpis: ["aceptacion de sugerencias", "uso efectivo de intervenciones"],
    requiresDecision: true,
  },
  {
    eventType: "vscode_suggestion_panel_opened",
    category: "suggestion",
    sources: ["vscode_extension"],
    actor: "estudiante",
    when: "Se abre el panel de sugerencias.",
    purpose: "Uso del panel.",
    fields: [],
    kpis: ["uso del agente"],
  },
  {
    eventType: "vscode_suggestion_manual_refresh",
    category: "suggestion",
    sources: ["vscode_extension"],
    actor: "estudiante",
    when: "El estudiante pide una sugerencia nueva a mano.",
    purpose: "Ayuda bajo demanda en VS Code.",
    fields: [],
    kpis: ["uso efectivo de intervenciones"],
  },
  {
    eventType: "vscode_rag_source_opened",
    category: "suggestion",
    sources: ["vscode_extension"],
    actor: "estudiante",
    when: "Se abre una fuente citada desde VS Code.",
    purpose: "Uso del material autorizado.",
    fields: ["decisionId", "value"],
    kpis: ["uso de material autorizado"],
  },
  {
    eventType: "vscode_suggestion_ignored",
    category: "suggestion",
    sources: ["vscode_extension"],
    actor: "estudiante",
    when: "Una sugerencia mostrada se reemplaza o se descarta sin aplicarse.",
    purpose: "Sugerencias no atendidas en VS Code.",
    fields: ["decisionId", "durationMs", "value"],
    kpis: ["aceptacion de sugerencias"],
    requiresDecision: true,
  },
  {
    eventType: "vscode_suggestion_blocked_by_policy",
    category: "tutor",
    sources: ["vscode_extension"],
    actor: "sistema",
    when: "La respuesta de /suggest-tab llega bloqueada por la politica.",
    purpose: "Efecto visible de la politica en el estudiante.",
    fields: ["decisionId", "value"],
    kpis: ["tasa de bloqueo por politica"],
    requiresDecision: true,
  },
  {
    eventType: "compile_error_detected",
    category: "signal",
    sources: ["vscode_extension"],
    actor: "sistema",
    when: "VS Code reporta un error en el archivo activo (se deduplica 60 s).",
    purpose: "Senal de dificultad; el texto solo llega como hash.",
    fields: ["errorHash", "language", "metadata.line"],
    kpis: ["tiempo hasta desbloqueo"],
  },
  {
    eventType: "code_application_blocked",
    category: "code_application",
    sources: ["vscode_extension"],
    actor: "sistema",
    when: "VS Code no aplica un cambio porque la politica o la regla sin red lo impide.",
    purpose: "Cumplimiento del limite de aplicacion de codigo visto desde el cliente.",
    fields: ["decisionId", "value", "metadata.linesChanged"],
    kpis: ["aplicaciones bloqueadas por politica"],
  },
  // --- Existentes (entorno y pestana) ----------------------------------------
  { eventType: "active_tab_seen", category: "navigation", sources: ["backend"], actor: "estudiante o docente", when: "La pestana activa del overlay cambia a visible.", purpose: "Contexto de uso.", fields: ["pageContext"], kpis: ["uso del agente"] },
  { eventType: "active_tab_hidden", category: "navigation", sources: ["backend"], actor: "estudiante o docente", when: "La pestana activa deja de estar visible.", purpose: "Contexto de uso.", fields: ["durationMs"], kpis: ["uso del agente"] },
  { eventType: "prepare_environment_started", category: "workflow", sources: ["backend"], actor: "estudiante", when: "El estudiante pide preparar su entorno (Codespaces o tunel).", purpose: "Tiempo y exito de preparacion del entorno.", fields: ["repoFullName"], kpis: ["estabilidad"] },
  { eventType: "prepare_environment_retry_started", category: "workflow", sources: ["backend"], actor: "estudiante", when: "Reintento de preparar el entorno.", purpose: "Fallos del entorno.", fields: ["repoFullName"], kpis: ["estabilidad"] },
  { eventType: "prepare_environment_failed", category: "workflow", sources: ["backend"], actor: "sistema", when: "Fallo la preparacion del entorno.", purpose: "Fallos del entorno.", fields: ["repoFullName", "value"], kpis: ["estabilidad"] },
  { eventType: "prepare_environment_retry_failed", category: "workflow", sources: ["backend"], actor: "sistema", when: "Fallo el reintento.", purpose: "Fallos del entorno.", fields: ["repoFullName", "value"], kpis: ["estabilidad"] },
  { eventType: "bootstrap_pr_created", category: "github_pr", sources: ["backend"], actor: "sistema", when: "La GitHub App abre el PR del devcontainer.", purpose: "Preparacion del repositorio.", fields: ["repoFullName"], kpis: ["estabilidad"] },
  { eventType: "bootstrap_pr_reused", category: "github_pr", sources: ["backend"], actor: "sistema", when: "Se reutiliza un PR de devcontainer existente.", purpose: "Preparacion del repositorio.", fields: ["repoFullName"], kpis: ["estabilidad"] },
  { eventType: "codespace_ready", category: "codespace", sources: ["backend"], actor: "sistema", when: "El Codespace quedo listo.", purpose: "Tiempo hasta entorno listo.", fields: ["repoFullName", "durationMs"], kpis: ["estabilidad"] },
  { eventType: "codespace_fallback", category: "codespace", sources: ["backend"], actor: "sistema", when: "Se uso el camino de respaldo del Codespace.", purpose: "Fallos del entorno.", fields: ["repoFullName"], kpis: ["estabilidad"] },
  { eventType: "tunnel_workspace_device_code", category: "workflow", sources: ["backend"], actor: "sistema", when: "El entorno por tunel pide el codigo de dispositivo de GitHub.", purpose: "Primera conexion del estudiante al tunel.", fields: ["repoFullName"], kpis: ["estabilidad"] },
  { eventType: "tunnel_workspace_ready", category: "workflow", sources: ["backend"], actor: "sistema", when: "El entorno por tunel quedo listo.", purpose: "Tiempo hasta editor listo.", fields: ["repoFullName", "durationMs"], kpis: ["estabilidad"] },
];

const CATALOG_BY_TYPE = new Map(EVENT_CATALOG.map((entry) => [entry.eventType, entry]));

export function findCatalogEntry(eventType: string) {
  return CATALOG_BY_TYPE.get(eventType) || null;
}

export type FieldSensitivity = "ninguna" | "seudonimizada" | "derivada (hash)" | "cuasi-identificador";

export type FieldDictionaryEntry = {
  field: string;
  type: string;
  description: string;
  sensitivity: FieldSensitivity;
  /** Por que se guarda y que se deja fuera. */
  minimization: string;
};

/** Columnas de telemetry_events (el dataset que se analiza). */
export const FIELD_DICTIONARY: FieldDictionaryEntry[] = [
  { field: "id", type: "text (uuid)", description: "Id unico del evento.", sensitivity: "ninguna", minimization: "Generado por el servidor." },
  { field: "schema_version", type: "text", description: "Version del esquema con que se registro (1.0 si el cliente no la mando).", sensitivity: "ninguna", minimization: "—" },
  { field: "occurred_at", type: "timestamptz", description: "Cuando ocurrio segun el cliente (se corrige si viene del futuro).", sensitivity: "ninguna", minimization: "—" },
  { field: "received_at", type: "timestamptz", description: "Cuando lo recibio el servidor.", sensitivity: "ninguna", minimization: "—" },
  { field: "source", type: "text", description: "browser_extension, vscode_extension, backend o system.", sensitivity: "ninguna", minimization: "—" },
  { field: "channel", type: "text", description: "Canal del tutor: overlay, vscode o backend.", sensitivity: "ninguna", minimization: "—" },
  { field: "category", type: "text", description: "Categoria del catalogo.", sensitivity: "ninguna", minimization: "—" },
  { field: "event_type", type: "text", description: "Nombre del evento (ver catalogo).", sensitivity: "ninguna", minimization: "—" },
  { field: "actor_anon_id", type: "text", description: "HMAC-SHA256 del actor (user:<id> o client:<id>) con TELEMETRY_SALT; recortado a 20 hex.", sensitivity: "seudonimizada", minimization: "Nunca se guarda el id, el correo ni el nombre. Sin la sal no se puede revertir." },
  { field: "actor_kind", type: "text", description: "user (con sesion) o client (anonimo con x-adaceen-client-id) o system.", sensitivity: "ninguna", minimization: "—" },
  { field: "actor_role", type: "text", description: "student, teacher, admin o vacio si es anonimo.", sensitivity: "ninguna", minimization: "—" },
  { field: "teacher_anon_id", type: "text", description: "HMAC del docente del estudiante, para agrupar por grupo.", sensitivity: "seudonimizada", minimization: "Igual que actor_anon_id." },
  { field: "client_session_id", type: "text", description: "Id aleatorio por carga de pagina o activacion de VS Code.", sensitivity: "ninguna", minimization: "Aleatorio; no identifica a la persona." },
  { field: "seq", type: "integer", description: "Contador monotono del cliente dentro de client_session_id; los huecos estiman eventos perdidos.", sensitivity: "ninguna", minimization: "—" },
  { field: "decision_id", type: "text", description: "Enlaza el evento con la decision del tutor (tutor_decision).", sensitivity: "ninguna", minimization: "—" },
  { field: "course_code", type: "text", description: "Curso del material autorizado (por ejemplo 750015C).", sensitivity: "ninguna", minimization: "—" },
  { field: "exercise_hash", type: "text", description: "HMAC del ejercicio (actividad o archivo).", sensitivity: "derivada (hash)", minimization: "No se guarda la ruta ni el nombre del archivo; solo su hash y la extension." },
  { field: "language", type: "text", description: "Lenguaje del archivo (cpp, python, java...).", sensitivity: "ninguna", minimization: "—" },
  { field: "file_ext", type: "text", description: "Extension del archivo (.cpp, .py...).", sensitivity: "ninguna", minimization: "Sin ruta." },
  { field: "policy_event_type", type: "text", description: "Evento de politica detectado (compile_error, code_suggestion...).", sensitivity: "ninguna", minimization: "—" },
  { field: "intervention_type", type: "text", description: "hint, explanation, example, mini_quiz o controlled_message.", sensitivity: "ninguna", minimization: "—" },
  { field: "help_stage", type: "text", description: "Etapa de ayuda: hint_1, hint_2, partial_example, explanation, mini_quiz, controlled.", sensitivity: "ninguna", minimization: "—" },
  { field: "reason_code", type: "text", description: "Motivo corto de la decision (ok, hint_limit_reached...).", sensitivity: "ninguna", minimization: "—" },
  { field: "blocked", type: "boolean", description: "La politica bloqueo la intervencion o la aplicacion.", sensitivity: "ninguna", minimization: "—" },
  { field: "latency_ms", type: "integer", description: "Latencia medida (servidor o cliente segun el evento).", sensitivity: "ninguna", minimization: "—" },
  { field: "duration_ms", type: "integer", description: "Duracion propia del evento (tiempo visible, tiempo abierto, persistencia del error).", sensitivity: "ninguna", minimization: "—" },
  { field: "count_value", type: "integer", description: "Conteo propio del evento (repeticiones del error...).", sensitivity: "ninguna", minimization: "—" },
  { field: "value_text", type: "text", description: "Valor corto del evento (trigger, applyMode, reasonCode...). Maximo 120 caracteres.", sensitivity: "ninguna", minimization: "Se recorta; los clientes no mandan texto libre aqui." },
  { field: "error_hash", type: "text", description: "SHA-256 (16 hex) del error normalizado.", sensitivity: "derivada (hash)", minimization: "El texto del error nunca se guarda: el servidor lo convierte en hash al recibirlo." },
  { field: "context_hash", type: "text", description: "SHA-256 (16 hex) del contexto usado por el tutor.", sensitivity: "derivada (hash)", minimization: "Sin codigo ni texto del estudiante." },
  { field: "metadata", type: "jsonb", description: "Datos adicionales del evento, filtrados por lista blanca de claves.", sensitivity: "ninguna", minimization: "Solo claves de la lista blanca (trigger, pageType, applyMode, linesChanged, line, cached, blocked, scope, mode, reason...)." },
  { field: "quality_flags", type: "jsonb", description: "Avisos de calidad del evento (reglas Q#).", sensitivity: "ninguna", minimization: "—" },
];

/** Tablas anteriores que siguen existiendo y su tratamiento. */
export const LEGACY_TABLES = [
  {
    table: "intervention_telemetry",
    description: "Decisiones del overlay con sesion (una fila por intervencion). La lee el panel del docente.",
    sensitivity: "Personal: ids de estudiante y docente; context_summary sin texto de error ni ruta completa desde v1.1.",
    exported: "No. El dataset del piloto sale de telemetry_events.",
  },
  {
    table: "user_behavior_events",
    description: "Eventos de comportamiento de usuarios con sesion (v1.0). Se siguen escribiendo y ademas se copian a telemetry_events.",
    sensitivity: "Personal: user_id y ruta de archivo.",
    exported: "No.",
  },
  {
    table: "student_quizzes / quiz_launches",
    description: "Intentos del mini quiz (pregunta, opciones, respuesta, calificacion).",
    sensitivity: "Personal si el estudiante tenia sesion (user_id); client_key si no.",
    exported: "Se exportan aparte con el actor seudonimizado (ver exportar-telemetria).",
  },
];

/** Reglas de calidad por evento (A4.4) y del conjunto de datos (A7.6). */
export type QualityRule = {
  code: string;
  scope: "evento" | "dataset";
  severity: "error" | "aviso" | "info";
  action: "rechazar" | "marcar" | "corregir y marcar" | "reportar";
  description: string;
};

export const QUALITY_RULES: QualityRule[] = [
  { code: "Q1_esquema_invalido", scope: "evento", severity: "error", action: "rechazar", description: "El evento no cumple el esquema (campo desconocido, tipo o longitud invalidos). La peticion responde 400." },
  { code: "Q2_sin_actor", scope: "evento", severity: "error", action: "rechazar", description: "Sin sesion ni x-adaceen-client-id valido. La peticion responde 401." },
  { code: "Q3_evento_desconocido", scope: "evento", severity: "aviso", action: "marcar", description: "event_type no esta en el catalogo." },
  { code: "Q4_categoria_distinta", scope: "evento", severity: "aviso", action: "marcar", description: "La categoria no coincide con la del catalogo." },
  { code: "Q5_fecha_futura", scope: "evento", severity: "aviso", action: "corregir y marcar", description: "occurred_at mas de 5 min en el futuro: se guarda received_at." },
  { code: "Q6_fecha_antigua", scope: "evento", severity: "aviso", action: "marcar", description: "occurred_at con mas de 7 dias de antiguedad." },
  { code: "Q7_sin_version", scope: "evento", severity: "info", action: "marcar", description: "El cliente no mando schemaVersion (se asume 1.0)." },
  { code: "Q8_sin_decision", scope: "evento", severity: "aviso", action: "marcar", description: "Evento que debe enlazarse a una decision del tutor llega sin decisionId." },
  { code: "Q9_texto_descartado", scope: "evento", severity: "info", action: "marcar", description: "Llego errorText y se guardo solo su hash." },
  { code: "I1_eventos_perdidos", scope: "dataset", severity: "aviso", action: "reportar", description: "Huecos en seq dentro de un client_session_id: estimacion de eventos perdidos." },
  { code: "I2_duplicados", scope: "dataset", severity: "aviso", action: "reportar", description: "Mismo (client_session_id, seq) repetido." },
  { code: "I3_orden_invalido", scope: "dataset", severity: "aviso", action: "reportar", description: "Aceptada, rechazada o ignorada antes de mostrarse (misma decision)." },
  { code: "I4_respuesta_contradictoria", scope: "dataset", severity: "aviso", action: "reportar", description: "La misma decision aparece aceptada y rechazada." },
  { code: "I5_decision_huerfana", scope: "dataset", severity: "info", action: "reportar", description: "Evento con decisionId que no tiene su tutor_decision en el conjunto." },
  { code: "I6_aplicada_sin_verificar", scope: "dataset", severity: "info", action: "reportar", description: "suggestion_completion_applied sin code_application_checked de la misma decision." },
];
