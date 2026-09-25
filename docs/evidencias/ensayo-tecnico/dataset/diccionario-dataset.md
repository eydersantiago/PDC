# Diccionario del dataset del piloto

Columnas de `dataset.csv` (una fila por evento). Son las del diccionario de telemetría (`docs/telemetria/diccionario-eventos.md`) más la marca de limpieza.

| Columna | Tipo | Descripción | Sensibilidad |
|---|---|---|---|
| id | text (uuid) | Id unico del evento. | ninguna |
| schema_version | text | Version del esquema con que se registro (1.0 si el cliente no la mando). | ninguna |
| occurred_at | timestamptz | Cuando ocurrio segun el cliente (se corrige si viene del futuro). | ninguna |
| received_at | timestamptz | Cuando lo recibio el servidor. | ninguna |
| source | text | browser_extension, vscode_extension, backend o system. | ninguna |
| channel | text | Canal del tutor: overlay, vscode o backend. | ninguna |
| category | text | Categoria del catalogo. | ninguna |
| event_type | text | Nombre del evento (ver catalogo). | ninguna |
| actor_anon_id | text | HMAC-SHA256 del actor (user:<id> o client:<id>) con TELEMETRY_SALT; recortado a 20 hex. | seudonimizada |
| actor_kind | text | user (con sesion) o client (anonimo con x-adaceen-client-id) o system. | ninguna |
| actor_role | text | student, teacher, admin o vacio si es anonimo. | ninguna |
| teacher_anon_id | text | HMAC del docente del estudiante, para agrupar por grupo. | seudonimizada |
| client_session_id | text | Id aleatorio por carga de pagina o activacion de VS Code. | ninguna |
| seq | integer | Contador monotono del cliente dentro de client_session_id; los huecos estiman eventos perdidos. | ninguna |
| decision_id | text | Enlaza el evento con la decision del tutor (tutor_decision). | ninguna |
| course_code | text | Curso del material autorizado (por ejemplo 750015C). | ninguna |
| exercise_hash | text | HMAC del ejercicio (actividad o archivo). | derivada (hash) |
| language | text | Lenguaje del archivo (cpp, python, java...). | ninguna |
| file_ext | text | Extension del archivo (.cpp, .py...). | ninguna |
| policy_event_type | text | Evento de politica detectado (compile_error, code_suggestion...). | ninguna |
| intervention_type | text | hint, explanation, example, mini_quiz o controlled_message. | ninguna |
| help_stage | text | Etapa de ayuda: hint_1, hint_2, partial_example, explanation, mini_quiz, controlled. | ninguna |
| reason_code | text | Motivo corto de la decision (ok, hint_limit_reached...). | ninguna |
| blocked | boolean | La politica bloqueo la intervencion o la aplicacion. | ninguna |
| latency_ms | integer | Latencia medida (servidor o cliente segun el evento). | ninguna |
| duration_ms | integer | Duracion propia del evento (tiempo visible, tiempo abierto, persistencia del error). | ninguna |
| count_value | integer | Conteo propio del evento (repeticiones del error...). | ninguna |
| value_text | text | Valor corto del evento (trigger, applyMode, reasonCode...). Maximo 120 caracteres. | ninguna |
| error_hash | text | SHA-256 (16 hex) del error normalizado. | derivada (hash) |
| context_hash | text | SHA-256 (16 hex) del contexto usado por el tutor. | derivada (hash) |
| metadata | jsonb | Datos adicionales del evento, filtrados por lista blanca de claves. | ninguna |
| quality_flags | jsonb | Avisos de calidad del evento (reglas Q#). | ninguna |
| pilot_block | integer | Bloque del piloto AB/BA vigente al recibir el evento (1 o 2; vacio fuera del piloto). Lo pone el servidor. | ninguna |
| pilot_cohort | text | Cohorte del estudiante en el piloto: A (empieza con tutor) o B (empieza sin tutor). | ninguna |
| pilot_condition | text | Condicion del estudiante en ese bloque: con_tutor o sin_tutor. | ninguna |
| limpieza_marcas | text | Marcas de la limpieza separadas por «;» (M1_fecha_corregida, M2_decision_huerfana, M3_orden_invalido). | ninguna |

`excluidos.csv` tiene las mismas columnas del diccionario más `regla` (D1 a D5, ver `limpieza.md`).
