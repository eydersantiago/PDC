# Diccionario de eventos de telemetria (v1.1)

> Documento generado desde `src/services/telemetry-catalog.ts` con `npm run telemetria:diccionario`. No lo edites a mano: cambia el catalogo y regeneralo.

La telemetria del piloto vive en la tabla `telemetry_events`: un solo formato para el overlay del navegador, la extension de VS Code y el backend. Cada fila es un evento con el actor seudonimizado (HMAC-SHA256 con `TELEMETRY_SALT`), sin textos de error, codigo, rutas ni correos. Los clientes mandan los eventos a `POST /api/behavior/events` con sesion (`x-session-id`) o, sin sesion, con `x-adaceen-client-id`; el backend registra sus propias decisiones (`tutor_decision`, `code_application_checked`).

## Como se enlazan los eventos

- `decision_id` une cada respuesta del tutor con lo que paso despues: `tutor_decision` (backend) -> `tutor_response_shown` / `vscode_suggestion_shown` -> aceptada, rechazada, ignorada o aplicada.
- `client_session_id` + `seq` ordenan los eventos de un cliente; un hueco en `seq` es un evento perdido (regla I1).
- `actor_anon_id` agrupa por estudiante sin saber quien es; `teacher_anon_id` agrupa por grupo del docente.
- `exercise_hash` agrupa por actividad o archivo sin guardar su nombre.

## Categorias

`suggestion`, `cursor_idle`, `codespace`, `github_pr`, `navigation`, `project_context`, `intervention`, `error`, `workflow`, `tutor`, `signal`, `code_application`, `quiz`

## Catalogo de eventos

| Evento | Categoria | Origen | Actor | Cuando ocurre | Para que sirve | Campos propios | KPI | Requiere decision |
|---|---|---|---|---|---|---|---|---|
| `tutor_decision` | tutor | backend | sistema | Cada vez que el motor de politicas decide una intervencion (overlay o VS Code), bloqueada o no. | Trazabilidad de la decision: evento de politica, tipo de intervencion, etapa de ayuda, motivo y latencia. | `decisionId`, `channel`, `policyEventType`, `interventionType`, `helpStage`, `reasonCode`, `blocked`, `latencyMs`, `errorHash`, `contextHash`, `exerciseHash` | latencia p50/p95, tasa de bloqueo por politica, uso efectivo de intervenciones | no |
| `code_application_checked` | code_application | backend | sistema | VS Code pregunta si puede aplicar un cambio de codigo del tutor (POST /api/suggestions/apply-check). | Cumplimiento del limite de aplicacion de codigo (sin solucion completa) y conteo de pistas por ejercicio. | `decisionId`, `blocked`, `reasonCode`, `exerciseHash`, `metadata.applyMode`, `metadata.linesChanged` | uso efectivo de intervenciones, aplicaciones bloqueadas por politica | no |
| `overlay_opened` | navigation | browser_extension | estudiante o docente | Se abre el overlay (metadata.trigger: user, restore o sync). | Uso del tutor en el navegador; filtrar por trigger=user para no contar aperturas sincronizadas. | `metadata.trigger` | uso del agente | no |
| `overlay_closed` | navigation | browser_extension | estudiante o docente | Se cierra el overlay. | Tiempo de uso por apertura. | `durationMs` | uso del agente | no |
| `tutor_request_submitted` | tutor | browser_extension | estudiante | El estudiante pide ayuda (value: manual, shortcut o auto). | Demanda de ayuda bajo demanda frente a automatica. | `value`, `metadata.pageType` | uso efectivo de intervenciones | no |
| `tutor_response_received` | tutor | browser_extension | sistema | Llega la respuesta del backend al overlay. | Latencia percibida por el estudiante (clic a respuesta). | `decisionId`, `latencyMs`, `value`, `metadata.blocked` | latencia p50/p95 | si |
| `tutor_response_shown` | tutor | browser_extension | sistema | La respuesta del tutor se pinta en el overlay. | Denominador de la tasa de aceptacion. | `decisionId` | aceptacion de sugerencias | si |
| `tutor_response_accepted` | tutor | browser_extension | estudiante | El estudiante marca "Me sirvio". | Aceptacion y oportunidad de la sugerencia. | `decisionId`, `durationMs` | aceptacion de sugerencias, oportunidad | si |
| `tutor_response_rejected` | tutor | browser_extension | estudiante | El estudiante marca "No me sirvio". | Rechazo explicito de la sugerencia. | `decisionId`, `durationMs` | aceptacion de sugerencias | si |
| `tutor_response_ignored` | tutor | browser_extension | estudiante | Una respuesta mostrada se reemplaza o se cierra sin que el estudiante la califique. | Respuestas no atendidas. | `decisionId`, `durationMs` | aceptacion de sugerencias | si |
| `rag_source_opened` | tutor | browser_extension | estudiante | El estudiante abre una fuente del material autorizado citada por el tutor. | Uso del material autorizado (RAG). | `decisionId`, `value` | uso de material autorizado | no |
| `error_detected` | signal | browser_extension | sistema | El overlay ve un error en la pagina (se deduplica 60 s). | Senal de dificultad; el texto solo llega como hash. | `errorHash`, `pageContext` | tiempo hasta desbloqueo | no |
| `blocking_detected` | signal | browser_extension, vscode_extension | sistema | El mismo error sigue presente 120 s (navegador) o 90 s (VS Code), o aparece 3 veces en 10 min. | Inicio de un episodio de bloqueo; base del tiempo hasta desbloqueo. | `errorHash`, `language`, `durationMs`, `count` | tiempo hasta desbloqueo | no |
| `vscode_suggestion_shown` | suggestion | vscode_extension | sistema | Se muestra una sugerencia en VS Code. | Denominador de aceptacion en VS Code; latencia de la sugerencia. | `decisionId`, `latencyMs`, `language`, `filePath` | aceptacion de sugerencias, latencia p50/p95 | si |
| `vscode_suggestion_actions_revealed` | suggestion | vscode_extension | estudiante | El estudiante despliega las acciones de una sugerencia. | Interes en la sugerencia. | `decisionId` | uso efectivo de intervenciones | no |
| `suggestion_completion_applied` | suggestion | vscode_extension | estudiante | Se aplica en el archivo el cambio sugerido (value: insert, replace o delete). | Aceptacion efectiva con cambio de codigo. | `decisionId`, `value`, `metadata.linesChanged` | aceptacion de sugerencias, uso efectivo de intervenciones | si |
| `vscode_suggestion_panel_opened` | suggestion | vscode_extension | estudiante | Se abre el panel de sugerencias. | Uso del panel. | - | uso del agente | no |
| `vscode_suggestion_manual_refresh` | suggestion | vscode_extension | estudiante | El estudiante pide una sugerencia nueva a mano. | Ayuda bajo demanda en VS Code. | - | uso efectivo de intervenciones | no |
| `vscode_rag_source_opened` | suggestion | vscode_extension | estudiante | Se abre una fuente citada desde VS Code. | Uso del material autorizado. | `decisionId`, `value` | uso de material autorizado | no |
| `vscode_suggestion_ignored` | suggestion | vscode_extension | estudiante | Una sugerencia mostrada se reemplaza o se descarta sin aplicarse. | Sugerencias no atendidas en VS Code. | `decisionId`, `durationMs`, `value` | aceptacion de sugerencias | si |
| `vscode_suggestion_blocked_by_policy` | tutor | vscode_extension | sistema | La respuesta de /suggest-tab llega bloqueada por la politica. | Efecto visible de la politica en el estudiante. | `decisionId`, `value` | tasa de bloqueo por politica | si |
| `compile_error_detected` | signal | vscode_extension | sistema | VS Code reporta un error en el archivo activo (se deduplica 60 s). | Senal de dificultad; el texto solo llega como hash. | `errorHash`, `language`, `metadata.line` | tiempo hasta desbloqueo | no |
| `code_application_blocked` | code_application | vscode_extension | sistema | VS Code no aplica un cambio porque la politica o la regla sin red lo impide. | Cumplimiento del limite de aplicacion de codigo visto desde el cliente. | `decisionId`, `value`, `metadata.linesChanged` | aplicaciones bloqueadas por politica | no |
| `active_tab_seen` | navigation | backend | estudiante o docente | La pestana activa del overlay cambia a visible. | Contexto de uso. | `pageContext` | uso del agente | no |
| `active_tab_hidden` | navigation | backend | estudiante o docente | La pestana activa deja de estar visible. | Contexto de uso. | `durationMs` | uso del agente | no |
| `prepare_environment_started` | workflow | backend | estudiante | El estudiante pide preparar su entorno (Codespaces o tunel). | Tiempo y exito de preparacion del entorno. | `repoFullName` | estabilidad | no |
| `prepare_environment_retry_started` | workflow | backend | estudiante | Reintento de preparar el entorno. | Fallos del entorno. | `repoFullName` | estabilidad | no |
| `prepare_environment_failed` | workflow | backend | sistema | Fallo la preparacion del entorno. | Fallos del entorno. | `repoFullName`, `value` | estabilidad | no |
| `prepare_environment_retry_failed` | workflow | backend | sistema | Fallo el reintento. | Fallos del entorno. | `repoFullName`, `value` | estabilidad | no |
| `bootstrap_pr_created` | github_pr | backend | sistema | La GitHub App abre el PR del devcontainer. | Preparacion del repositorio. | `repoFullName` | estabilidad | no |
| `bootstrap_pr_reused` | github_pr | backend | sistema | Se reutiliza un PR de devcontainer existente. | Preparacion del repositorio. | `repoFullName` | estabilidad | no |
| `codespace_ready` | codespace | backend | sistema | El Codespace quedo listo. | Tiempo hasta entorno listo. | `repoFullName`, `durationMs` | estabilidad | no |
| `codespace_fallback` | codespace | backend | sistema | Se uso el camino de respaldo del Codespace. | Fallos del entorno. | `repoFullName` | estabilidad | no |
| `tunnel_workspace_device_code` | workflow | backend | sistema | El entorno por tunel pide el codigo de dispositivo de GitHub. | Primera conexion del estudiante al tunel. | `repoFullName` | estabilidad | no |
| `tunnel_workspace_ready` | workflow | backend | sistema | El entorno por tunel quedo listo. | Tiempo hasta editor listo. | `repoFullName`, `durationMs` | estabilidad | no |

## Campos de `telemetry_events`

| Campo | Tipo | Descripcion | Sensibilidad | Minimizacion |
|---|---|---|---|---|
| `id` | text (uuid) | Id unico del evento. | ninguna | Generado por el servidor. |
| `schema_version` | text | Version del esquema con que se registro (1.0 si el cliente no la mando). | ninguna | — |
| `occurred_at` | timestamptz | Cuando ocurrio segun el cliente (se corrige si viene del futuro). | ninguna | — |
| `received_at` | timestamptz | Cuando lo recibio el servidor. | ninguna | — |
| `source` | text | browser_extension, vscode_extension, backend o system. | ninguna | — |
| `channel` | text | Canal del tutor: overlay, vscode o backend. | ninguna | — |
| `category` | text | Categoria del catalogo. | ninguna | — |
| `event_type` | text | Nombre del evento (ver catalogo). | ninguna | — |
| `actor_anon_id` | text | HMAC-SHA256 del actor (user:<id> o client:<id>) con TELEMETRY_SALT; recortado a 20 hex. | seudonimizada | Nunca se guarda el id, el correo ni el nombre. Sin la sal no se puede revertir. |
| `actor_kind` | text | user (con sesion) o client (anonimo con x-adaceen-client-id) o system. | ninguna | — |
| `actor_role` | text | student, teacher, admin o vacio si es anonimo. | ninguna | — |
| `teacher_anon_id` | text | HMAC del docente del estudiante, para agrupar por grupo. | seudonimizada | Igual que actor_anon_id. |
| `client_session_id` | text | Id aleatorio por carga de pagina o activacion de VS Code. | ninguna | Aleatorio; no identifica a la persona. |
| `seq` | integer | Contador monotono del cliente dentro de client_session_id; los huecos estiman eventos perdidos. | ninguna | — |
| `decision_id` | text | Enlaza el evento con la decision del tutor (tutor_decision). | ninguna | — |
| `course_code` | text | Curso del material autorizado (por ejemplo 750015C). | ninguna | — |
| `exercise_hash` | text | HMAC del ejercicio (actividad o archivo). | derivada (hash) | No se guarda la ruta ni el nombre del archivo; solo su hash y la extension. |
| `language` | text | Lenguaje del archivo (cpp, python, java...). | ninguna | — |
| `file_ext` | text | Extension del archivo (.cpp, .py...). | ninguna | Sin ruta. |
| `policy_event_type` | text | Evento de politica detectado (compile_error, code_suggestion...). | ninguna | — |
| `intervention_type` | text | hint, explanation, example, mini_quiz o controlled_message. | ninguna | — |
| `help_stage` | text | Etapa de ayuda: hint_1, hint_2, partial_example, explanation, mini_quiz, controlled. | ninguna | — |
| `reason_code` | text | Motivo corto de la decision (ok, hint_limit_reached...). | ninguna | — |
| `blocked` | boolean | La politica bloqueo la intervencion o la aplicacion. | ninguna | — |
| `latency_ms` | integer | Latencia medida (servidor o cliente segun el evento). | ninguna | — |
| `duration_ms` | integer | Duracion propia del evento (tiempo visible, tiempo abierto, persistencia del error). | ninguna | — |
| `count_value` | integer | Conteo propio del evento (repeticiones del error...). | ninguna | — |
| `value_text` | text | Valor corto del evento (trigger, applyMode, reasonCode...). Maximo 120 caracteres. | ninguna | Se recorta; los clientes no mandan texto libre aqui. |
| `error_hash` | text | SHA-256 (16 hex) del error normalizado. | derivada (hash) | El texto del error nunca se guarda: el servidor lo convierte en hash al recibirlo. |
| `context_hash` | text | SHA-256 (16 hex) del contexto usado por el tutor. | derivada (hash) | Sin codigo ni texto del estudiante. |
| `metadata` | jsonb | Datos adicionales del evento, filtrados por lista blanca de claves. | ninguna | Solo claves de la lista blanca (trigger, pageType, applyMode, linesChanged, line, cached, blocked, scope, mode, reason...). |
| `quality_flags` | jsonb | Avisos de calidad del evento (reglas Q#). | ninguna | — |

## Reglas de calidad

Las reglas Q se aplican a cada evento al recibirlo: Q1 y Q2 rechazan la peticion; las demas guardan el evento con su aviso en `quality_flags`. Las reglas I revisan el conjunto (`GET /api/telemetry/quality`, `npm run estabilidad:eventos`).

| Regla | Alcance | Severidad | Accion | Descripcion |
|---|---|---|---|---|
| `Q1_esquema_invalido` | evento | error | rechazar | El evento no cumple el esquema (campo desconocido, tipo o longitud invalidos). La peticion responde 400. |
| `Q2_sin_actor` | evento | error | rechazar | Sin sesion ni x-adaceen-client-id valido. La peticion responde 401. |
| `Q3_evento_desconocido` | evento | aviso | marcar | event_type no esta en el catalogo. |
| `Q4_categoria_distinta` | evento | aviso | marcar | La categoria no coincide con la del catalogo. |
| `Q5_fecha_futura` | evento | aviso | corregir y marcar | occurred_at mas de 5 min en el futuro: se guarda received_at. |
| `Q6_fecha_antigua` | evento | aviso | marcar | occurred_at con mas de 7 dias de antiguedad. |
| `Q7_sin_version` | evento | info | marcar | El cliente no mando schemaVersion (se asume 1.0). |
| `Q8_sin_decision` | evento | aviso | marcar | Evento que debe enlazarse a una decision del tutor llega sin decisionId. |
| `Q9_texto_descartado` | evento | info | marcar | Llego errorText y se guardo solo su hash. |
| `I1_eventos_perdidos` | dataset | aviso | reportar | Huecos en seq dentro de un client_session_id: estimacion de eventos perdidos. |
| `I2_duplicados` | dataset | aviso | reportar | Mismo (client_session_id, seq) repetido. |
| `I3_orden_invalido` | dataset | aviso | reportar | Aceptada, rechazada o ignorada antes de mostrarse (misma decision). |
| `I4_respuesta_contradictoria` | dataset | aviso | reportar | La misma decision aparece aceptada y rechazada. |
| `I5_decision_huerfana` | dataset | info | reportar | Evento con decisionId que no tiene su tutor_decision en el conjunto. |
| `I6_aplicada_sin_verificar` | dataset | info | reportar | suggestion_completion_applied sin code_application_checked de la misma decision. |

## Tablas anteriores

| Tabla | Que guarda | Sensibilidad | Se exporta |
|---|---|---|---|
| `intervention_telemetry` | Decisiones del overlay con sesion (una fila por intervencion). La lee el panel del docente. | Personal: ids de estudiante y docente; context_summary sin texto de error ni ruta completa desde v1.1. | No. El dataset del piloto sale de telemetry_events. |
| `user_behavior_events` | Eventos de comportamiento de usuarios con sesion (v1.0). Se siguen escribiendo y ademas se copian a telemetry_events. | Personal: user_id y ruta de archivo. | No. |
| `student_quizzes / quiz_launches` | Intentos del mini quiz (pregunta, opciones, respuesta, calificacion). | Personal si el estudiante tenia sesion (user_id); client_key si no. | Se exportan aparte con el actor seudonimizado (ver exportar-telemetria). |

## Exportacion y retencion

- `npm run telemetria:exportar` escribe el conjunto en JSONL o CSV con estas columnas (y, con `--con-quices`, los intentos del mini quiz con el mismo `actor_anon_id`). La carpeta `exportes/` no se versiona.
- `GET /api/telemetry/export` hace lo mismo desde el backend, solo para docentes y administradores.
- `npm run telemetria:purgar` borra los eventos mas viejos que `TELEMETRY_RETENTION_DAYS` (365 por defecto). Sin `--confirmar` solo cuenta.
- La sal `TELEMETRY_SALT` no se cambia durante el piloto: cambiarla rompe la union de eventos de un mismo actor.
