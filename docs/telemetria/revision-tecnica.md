# Revisión técnica de la telemetría y cierre del diccionario (v1.1)

| | |
|---|---|
| Jira | A4.7 · ADACEEN-54 (revisión y cierre). Cubre también A4.2 · ADACEEN-49 (esquema versionado), A4.5 · ADACEEN-52 (ids y hashes) y A7.1 · ADACEEN-69 (normalización) |
| Fecha | 24 de septiembre de 2026 |
| Versión revisada | Esquema `1.1`, rama `feat/cierre-pendientes-jira` |
| Diccionario | [diccionario-eventos.md](diccionario-eventos.md) (generado desde `src/services/telemetry-catalog.ts`) |
| Ruta de datos | [../arquitectura/ruta-de-datos.md](../arquitectura/ruta-de-datos.md) |

## 1. Qué se revisó

| Pieza | Archivo | Resultado |
|---|---|---|
| Catálogo de eventos y diccionario de campos | `src/services/telemetry-catalog.ts` | 35 eventos documentados con propósito, actor, momento, campos y KPI; 32 columnas con sensibilidad y minimización. |
| Construcción de filas, seudonimización y calidad | `src/services/telemetry.ts` | Conforme. Probado en `tests/services/telemetry.test.ts`. |
| Ingesta | `POST /api/behavior/events` (`src/routes/behavior-routes.ts`) | Esquema estricto (zod), con sesión o `x-adaceen-client-id`; devuelve los avisos Q#. |
| Decisiones del backend | `tutor_decision` (overlay y VS Code), `code_application_checked` | Una fila por decisión con `decision_id`, etapa, motivo y latencia. |
| Clientes | `browser-ext-prod/services/telemetry.service.js`, `vscode-ext-prod/src/telemetry.ts` | Mandan `schemaVersion: "1.1"`, `seq` y `clientSessionId`; el error viaja como texto corto y el servidor lo convierte en hash. |
| Almacenamiento | Tabla `telemetry_events` (`src/db/schema.ts`) | Sin llaves foráneas, para aceptar clientes anónimos; índices por tiempo, actor, tipo y decisión. |
| Exportación, calidad, retención | `GET /api/telemetry/export`, `GET /api/telemetry/quality`, `scripts/exportar-telemetria.ts`, `scripts/purgar-telemetria.ts` | Solo docentes y administradores; columnas del diccionario; purga con simulación previa. |

## 2. Esquema versionado (A4.2)

- Cada evento lleva `schema_version`. Los clientes mandan `schemaVersion: "1.1"`;
  si no la mandan se guarda `1.0` y el evento queda con el aviso `Q7_sin_version`.
  Los eventos del backend llevan la versión del servidor (`TELEMETRY_SCHEMA_VERSION`).
- **1.0 → 1.1:** eventos sin sesión (`x-adaceen-client-id`), categorías `tutor`,
  `signal`, `code_application` y `quiz`, campos `seq`, `clientSessionId`,
  `decisionId`, `latencyMs`, `errorText` (solo para calcular el hash),
  `errorHash` y `contextHash`, y la tabla única `telemetry_events`.
- **Compatibilidad:** los campos de 1.0 (`repoFullName`, `branch`, `subjectId`,
  `value`…) se siguen aceptando. Con sesión, el evento se guarda además en la
  tabla anterior `user_behavior_events`, que usa el panel del docente.
- **Cómo evolucionar a 1.2:** agregar el evento o el campo primero en el
  catálogo; si cambia el significado de un campo, subir la versión; aceptar la
  versión anterior mientras haya clientes viejos; regenerar el diccionario
  (`npm run telemetria:diccionario`); la prueba `telemetry-dictionary.test.ts`
  falla si el documento quedó desactualizado.

## 3. Normalización (A7.1)

| Aspecto | Regla |
|---|---|
| Nombres | `camelCase` en el cuerpo de la petición; `snake_case` en la tabla y en la exportación. |
| Tiempo | ISO 8601 en UTC. `occurred_at` viene del cliente; si está más de 5 min en el futuro se reemplaza por `received_at` (`Q5`); si tiene más de 7 días se marca (`Q6`). `received_at` lo pone el servidor. |
| Textos | Recortados a su largo máximo; `language` en minúsculas; `value_text` hasta 120 caracteres. |
| Números | Enteros acotados: `seq` 0 a 10⁹, `latency_ms` hasta 1 h, `duration_ms` hasta 24 h. |
| Rutas | Solo la extensión (`file_ext`); la ruta completa no se guarda. |
| Metadata | Solo claves de la lista blanca, con valores número, booleano o texto de hasta 120 caracteres; lo demás se descarta. |
| Canal | `overlay`, `vscode` o `backend`, derivado del origen si el cliente no lo manda. |

## 4. Identificadores y hashes (A4.5)

| Campo | Cómo se calcula | Para qué | Riesgo y control |
|---|---|---|---|
| `actor_anon_id` | HMAC-SHA256 con `TELEMETRY_SALT` de `user:<id>` o `client:<id>`, recortado a 20 hex (80 bits). | Agrupar por estudiante sin saber quién es; unir telemetría y quices. | Sin la sal no se revierte. Con la sal y la lista de ids sí: la sal es secreta y vive solo en la configuración del App Service. Sigue siendo dato personal en sentido legal. |
| `teacher_anon_id` | Igual, con `user:<id del docente>`. | Agrupar por grupo del docente. | Igual. |
| `exercise_hash` | HMAC de `exercise:<actividad, archivo o URL>` en minúsculas. | Contar ayudas por ejercicio sin guardar su nombre. | El nombre de archivo puede ser personal; por eso se guarda solo el HMAC. |
| `error_hash` | SHA-256 (16 hex) del error **normalizado**: minúsculas, rutas → `<ruta>`, textos entre comillas → `'_'`, números → `#`. | Comparar el mismo error entre estudiantes y sesiones. | El texto del error nunca se guarda (aviso `Q9_texto_descartado`). |
| `context_hash` | SHA-256 (16 hex) del contexto usado por el tutor. | Saber si dos decisiones vieron el mismo contexto. | Sin código ni texto. |
| `decision_id` | UUID generado por el backend en cada decisión. | Unir la decisión con lo que el estudiante hizo después. | No identifica a nadie. |
| `client_session_id` | Id aleatorio por carga de página (overlay) o activación (VS Code). | Ordenar eventos y estimar pérdidas con `seq`. | No identifica a nadie. |
| `seq` | Contador del cliente dentro de `client_session_id`. | Detectar eventos perdidos (hueco) y duplicados. | — |

Colisiones: con 80 bits, la probabilidad de que dos actores distintos del piloto
compartan `actor_anon_id` es despreciable (el límite del cumpleaños está cerca
de 2⁴⁰ actores). Con 64 bits en los hashes de error pasa lo mismo.

## 5. Calidad e integridad (A4.4, A7.6)

- Reglas por evento Q1–Q9: Q1 (esquema) y Q2 (sin actor) rechazan la petición;
  Q3–Q9 guardan el evento con su aviso en `quality_flags`, que también vuelve en
  la respuesta.
- Reglas del conjunto I1–I6 (`analyzeTelemetryDataset`): eventos perdidos por
  huecos de `seq`, duplicados, orden inválido, respuestas contradictorias,
  decisiones huérfanas y aplicaciones sin verificar. Se consultan en
  `GET /api/telemetry/quality` y con `npm run estabilidad:eventos`.
- Prueba sintética (400 eventos numerados, 16 descartados a propósito en el
  cliente, 4 envíos en paralelo): el servidor guardó los 384 enviados, sin
  duplicados, y el estimador por `seq` detectó los 16 descartes
  ([evidencia](../evidencias/estabilidad-eventos-simulacion.md)).
- Límite conocido: una pérdida al final de una sesión (el último evento) no deja
  hueco y no se detecta; los clientes vacían la cola al cerrar la página
  (`pagehide` con `keepalive`) para reducirla.

## 6. Retención y borrado

- `telemetry_events`: `TELEMETRY_RETENTION_DAYS` (365 por defecto) con
  `npm run telemetria:purgar` (simula sin `--confirmar`). La purga se corre a mano.
- Tablas anteriores con datos personales (`intervention_telemetry`,
  `user_behavior_events`, `student_quizzes`, contexto de proyecto): sin plazo
  en el código. Queda como decisión de A4.3/A5 (hallazgo H2).

## 7. Hallazgos

| # | Hallazgo | Severidad | Estado |
|---|---|---|---|
| H1 | Sin `TELEMETRY_SALT` el servidor usa una sal de desarrollo conocida y los seudónimos se pueden recalcular. | Alta | Configurar la sal en el App Service antes del piloto y no cambiarla después (runbook). |
| H2 | Las tablas anteriores guardan datos personales sin plazo; `student_quizzes.code_context` guarda hasta 3 000 caracteres de código. | Media | Plazo y purga por tabla: decisión de A4.3/A5 con el director. |
| H3 | Los logs del App Service registran repositorio, ruta de archivo e ids recortados en algunas rutas. | Media | Retención de 12 h; revisar si se pasan a hash. |
| H4 | El worker no fijaba `timeToLive` al resultado: un resultado no leído quedaba hasta el TTL de la cola. | Media | **Corregido** en esta rama: el resultado expira al doble de `QUEUE_REQUEST_TIMEOUT_MS`. |
| H5 | Los enlaces del visor de fuentes llevaban el `sessionId` en la URL (historial, capturas). | Media | **Corregido** en esta rama: el backend ya no lo agrega y el overlay lo quita. |
| H6 | `/suggest-tab` no revisa `user_workspace_consents`. | Baja | Decidir en A5 si el consentimiento del espacio de trabajo cubre las sugerencias de VS Code. |
| H7 | Cifrado hacia PostgreSQL (`DATABASE_SSL_MODE=require`) y ausencia de una `OPENAI_API_KEY` real en el App Service (trazas del SDK). | Baja | Por verificar en la configuración del App Service. |

## 8. Cierre del diccionario

Con esta revisión el diccionario v1.1 queda **cerrado**: los 35 eventos del
catálogo, las 32 columnas de `telemetry_events` con su sensibilidad y
minimización, las reglas Q1–Q9 e I1–I6 y el tratamiento de las tablas
anteriores. Cualquier cambio posterior entra por el catálogo, se regenera el
documento y, si cambia un significado, sube la versión del esquema. Los plazos
de retención de las tablas anteriores (H2) quedan fuera de este cierre y pasan
a A4.3/A5.
