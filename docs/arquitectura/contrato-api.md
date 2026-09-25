# Contrato de la API de ADACEEN

| | |
|---|---|
| Jira | A9.6 · ADACEEN-88 (arquitectura); insumo de A16.2 · ADACEEN-130 |
| Código | `src/routes/*.ts` (registro en `src/routes/register-routes.ts`) |
| Prueba | `tests/scripts/contrato-api.test.ts`: falla si una ruta del código no aparece en este documento |
| Relacionados | [Vistas de la arquitectura](vistas.md), [ruta de datos](ruta-de-datos.md), [diccionario de telemetría](../telemetria/diccionario-eventos.md) |

El API en Azure App Service es el único punto al que hablan las extensiones, el
worker GPU y el agente de la VM de editores. Este documento fija las
convenciones, describe las interfaces entre módulos (las que usa el tutor) y
lista todas las rutas. El detalle de cada campo de telemetría está en el
diccionario.

## 1. Convenciones

| Aspecto | Regla |
|---|---|
| Transporte | HTTPS al host del App Service (en desarrollo, `http://localhost:3000`). CORS solo para los orígenes permitidos. |
| Formato | JSON (hasta 20 MB por petición; las imágenes van como `multipart/form-data`). Las respuestas llevan `ok: true` o `ok: false` con `error`. |
| Sesión | Cabecera `x-session-id` (también se acepta `sessionId` en el cuerpo o la cookie de sesión). Roles: `student`, `teacher`, `admin`. |
| Cliente sin sesión | Cabecera `x-adaceen-client-id` (id aleatorio del cliente): la telemetría y las decisiones se registran con ese actor seudonimizado. |
| Worker GPU | `x-worker-token` (`WORKER_HEARTBEAT_TOKEN`) en el latido. |
| Agente de la VM de editores | `x-agent-token` (`WORKSPACE_AGENT_TOKEN`), comparado en tiempo constante, en las rutas del relay. |
| Telemetría | Esquema versionado (`schemaVersion: "1.1"`); campos y reglas de calidad en el diccionario. |
| Errores de validación | 400 con el motivo; sin sesión, 401; rol insuficiente, 403. |

## 2. Interfaces entre módulos

### 2.1 Tutor en el overlay: `POST /intervene`

- **Quién:** extensión de navegador (`/github-mentor` es un alias).
- **Entrada:** `question`, `max_items` (3 a 8) y `context` (tipo y contexto de
  página, repositorio, archivo, error visible, selección, fragmento de código,
  meta de aprendizaje, curso).
- **Qué hace:** el motor de políticas clasifica el evento, aplica la regla del
  docente, la etapa de ayuda, el límite de pistas y la condición del piloto;
  si procede, consulta el material autorizado y el modelo, y recorta la salida
  con la plantilla de la etapa.
- **Salida:** `result` (resumen, ideas, búsquedas, guía), `policy_applied`,
  `decision_id`, `blocked`, `help_stage`, `latency_ms`, `rag_course_code`,
  `rag_sources` (citas con enlace al visor).

### 2.2 Sugerencias en VS Code: `POST /suggest-tab`

- **Quién:** extensión de VS Code.
- **Entrada:** `tab_content` (archivo activo, hasta 12 000 caracteres),
  `question`, `filePath`, `languageHint`, `selection`, `visibleError`,
  `diagnostics`, `trigger` (`manual`, `cursor_idle`, `selection`, `file_open`,
  `blocking`, `panel`), `suggestion_scope`, `clientSessionId`.
- **Salida:** `output_text` (Markdown con las secciones que entiende la
  extensión), `decision_id`, `policy_applied`, `code_application` (si se puede
  aplicar, máximo de líneas, confirmación, cupo), `rag_sources`, `cached` y,
  sin modelo, `degraded`.

### 2.3 Aplicación de código: `POST /api/suggestions/apply-check`

- **Quién:** extensión de VS Code, antes de escribir en el archivo.
- **Entrada:** `decisionId`, `filePath`, `language`, `applyMode` (`insert`,
  `replace`, `delete`), `linesChanged`, `charsChanged`, `trigger`. No recibe
  código.
- **Salida:** `allowed`, `reason`, `reasonCode`, `requireConfirmation`,
  `maxLines`, `remaining`, `decisionId`. Cada consulta queda como evento de
  telemetría.

### 2.4 Telemetría: `POST /api/behavior/events`

- **Quién:** las dos extensiones.
- **Entrada:** `events` (1 a 50) con `source`, `category`, `eventType`,
  `occurredAt`, `schemaVersion`, `seq`, `clientSessionId`, `decisionId`,
  `latencyMs`, `durationMs`, `errorText` (solo para calcular el hash; nunca se
  guarda), `metadata` (lista blanca de claves).
- **Qué hace:** seudonimiza el actor, calcula hashes, descarta lo que no está
  en la lista blanca, marca las reglas de calidad y pone el bloque, la cohorte
  y la condición del piloto.
- **Lectura (docente o administrador):** `GET /api/telemetry/export` (CSV o
  JSONL), `GET /api/telemetry/quality`, `GET /api/telemetry/kpis` y el catálogo
  público `GET /api/telemetry/catalog`.

### 2.5 Piloto con y sin tutor

- `GET /api/pilot`: bloque vigente y cohortes (docente o administrador).
- `POST /api/pilot/assign`: asigna al azar y en partes iguales los grupos A y B
  (`reset`, `seed`).
- `PUT /api/pilot/block`: `block` 0, 1 o 2; queda en el historial.
- `GET /api/pilot/me`: condición del estudiante que consulta.

### 2.6 Cola de inferencia y salud

- El API deja cada trabajo en Service Bus (`llm-jobs`) y espera el resultado
  en `llm-results-sessions`; el worker no tiene rutas propias.
- `POST /api/agent/heartbeat`: latido del worker cada 30 s.
- `GET /api/agent/health`: 503 si no hay ningún worker vivo (lo usa la alarma).
- `GET /api/agent/backend`: modo, colas y workers que escuchan.
- `GET /api/health`: estado general, sin secretos (sal y token configurados,
  retención, versión de la política de privacidad, agente de entornos).

### 2.7 Entornos por túnel y relay

- `POST /api/workspaces/prepare` (`repoFullName`, `force`) y
  `GET /api/workspaces/status`: los usa el overlay.
- `GET /api/workspaces/agent/next?wait=25` (sondeo largo) y
  `POST /api/workspaces/agent/responses` (`responses` con `id`, `status` y
  `json`): los usa el agente de la VM con `x-agent-token`.
- `GET /api/workspaces/agent/status`: si el agente está conectado.

### 2.8 Mini-quiz

- `POST /api/quiz/after-accept`: la extensión de VS Code pide un quiz después
  de aceptar un cambio.
- `GET /api/quiz/pending`, `POST /api/quiz/:id/answer`,
  `POST /api/quiz/:id/followup`, `POST /api/quiz/:id/skip`: ciclo del
  estudiante.
- `POST /api/quiz/launches`, `GET /api/quiz/launches`,
  `POST /api/quiz/launches/:id/close`, `GET /api/quiz/summary`: quiz lanzado
  por el docente.

## 3. Inventario de rutas

Todas las rutas registradas, por módulo. La prueba del contrato compara esta
lista con el código.

| Módulo | Rutas | Para qué |
|---|---|---|
| `agent-routes.ts` | `POST /intervene`, `POST /github-mentor` | Tutor del overlay (2.1) |
| | `POST /suggest-tab` | Sugerencias de VS Code (2.2) |
| | `POST /run`, `POST /run-text`, `POST /run-image` | Ejecución directa del modelo (texto o imagen). La usa otro backend configurado con `AGENT_TARGET=azure`; las extensiones no la llaman |
| | `POST /api/agent/heartbeat`, `GET /api/agent/health`, `GET /api/agent/backend` | Latido y salud de la cola (2.6) |
| `suggestion-routes.ts` | `POST /api/suggestions/apply-check` | Aplicación de código (2.3) |
| `behavior-routes.ts` | `POST /api/behavior/events` | Ingesta de telemetría (2.4) |
| | `GET /api/behavior/events`, `GET /api/behavior/summary` | Panel del docente: eventos recientes y resumen por tipo |
| `telemetry-routes.ts` | `GET /api/telemetry/export`, `GET /api/telemetry/kpis`, `GET /api/telemetry/quality`, `GET /api/telemetry/catalog` | Exportación, KPIs en vivo, calidad y catálogo (2.4) |
| `policy-routes.ts` | `GET /api/policies/current`, `PUT /api/policies/current` | Política del docente |
| | `GET /api/telemetry/interventions` | Intervenciones recientes para el panel del docente |
| `pilot-routes.ts` | `GET /api/pilot`, `POST /api/pilot/assign`, `PUT /api/pilot/block`, `GET /api/pilot/me` | Piloto AB/BA (2.5) |
| `quiz-routes.ts` | `POST /api/quiz/after-accept`, `GET /api/quiz/pending`, `POST /api/quiz/:id/answer`, `POST /api/quiz/:id/followup`, `POST /api/quiz/:id/skip` | Mini-quiz del estudiante (2.8) |
| | `POST /api/quiz/launches`, `GET /api/quiz/launches`, `POST /api/quiz/launches/:id/close`, `GET /api/quiz/summary` | Quiz lanzado por el docente (2.8) |
| `workspace-routes.ts` | `GET /api/workspaces/provider`, `POST /api/workspaces/prepare`, `GET /api/workspaces/status` | Entornos por túnel (2.7) |
| | `GET /api/workspaces/agent/next`, `POST /api/workspaces/agent/responses`, `GET /api/workspaces/agent/status` | Relay con el agente de la VM (2.7) |
| `rag-routes.ts` | `GET /api/rag/courses`, `GET /api/rag/sources`, `POST /api/rag/sources`, `DELETE /api/rag/sources/:id`, `GET /api/rag/sources/:id/view` | Material autorizado del curso: listar, cargar, retirar y ver la parte citada |
| `auth-routes.ts` | `POST /api/auth/login`, `POST /api/auth/google-login`, `GET /api/auth/me`, `POST /api/auth/logout` | Sesión con correo y contraseña o con Google |
| `admin-routes.ts` | `GET /api/admin/users`, `POST /api/admin/users`, `PUT /api/admin/users/:userId`, `DELETE /api/admin/users/:userId` | Usuarios y cursos (docente o administrador) |
| `github-app-routes.ts` | `GET /api/github/oauth/status`, `POST /api/github/oauth/start`, `GET /auth/github/callback`, `GET /api/github-app/oauth/callback` | Autorización OAuth de GitHub |
| | `GET /api/github-app/status`, `POST /api/github-app/install-url`, `POST /api/github-app/link-installation-auto`, `GET /api/github-app/callback` | Instalación de la GitHub App en el repositorio del estudiante |
| | `POST /github/prepare-environment`, `POST /api/github-app/prepare-environment`, `GET /api/github/codespaces/status`, `POST /api/github-app/bootstrap-devcontainer` | Entorno en GitHub Codespaces (respaldo del túnel) |
| `project-context-routes.ts` | `GET /api/projects/session/state`, `GET /api/projects/context/status`, `GET /api/projects/context/history`, `GET /api/projects/context/insight`, `POST /api/projects/context/rebuild`, `POST /api/projects/context/screenshot-insight`, `POST /api/projects/rack` | Contexto del proyecto del estudiante para el overlay |
| | `GET /api/projects/consent`, `POST /api/projects/consent` | Consentimiento para leer el espacio de trabajo |
| | `POST /api/projects/code-actions`, `GET /api/projects/code-actions/next`, `POST /api/projects/code-actions/:id/complete`, `POST /api/projects/code-actions/:id/fail` | Cambios de código pedidos desde el navegador que aplica VS Code |
| `project-scan-routes.ts` | `POST /api/projects/scan/request`, `GET /api/projects/scan/request/next`, `GET /api/projects/scan/request/:requestId`, `POST /api/projects/scan/request/:requestId/result`, `POST /api/projects/scan/request/:requestId/fail` | Escaneo del repositorio que hace la extensión de VS Code por pedido del overlay |
| `campus-routes.ts` | `POST /api/campus/analyze-page` | Análisis de la página de Campus Virtual (actividades y fechas) |
| `document-routes.ts` | `GET /api/documents/bitacora/status`, `DELETE /api/documents/bitacora/latest`, `DELETE /api/documents/bitacora/data`, `POST /api/documents/bitacora/import`, `POST /api/documents/bitacora/manual` | Bitácora de actividades del curso |
| | `GET /api/documents/bitacora-template`, `GET /api/documents/bitacora-teacher-workflow`, `GET /api/documents/bitacora-template-form`, `GET /api/documents/bitacora-pdf-guidelines` | Plantilla y guía de la bitácora para el docente |
| | `POST /api/documents/classify`, `GET /api/documents/classifications` | Clasificación de documentos del curso |
| `ui-tab-routes.ts` | `GET /api/ui/active-tab`, `POST /api/ui/active-tab` | Pestaña activa del estudiante (sincroniza el overlay entre pestañas) |
| `health-routes.ts` | `GET /health`, `GET /api/health` | Salud del servicio (2.6) |
| `privacy-policy-routes.ts` | `GET /privacy-policy`, `GET /politica-de-privacidad`, `GET /security-policy`, `GET /politica-de-seguridad` | Política de privacidad y seguridad en HTML |
| | `GET /api/privacy-policy`, `GET /privacy-policy.json` | La misma política en JSON, con versión |

## 4. Cómo mantenerlo

Al agregar una ruta: documentarla aquí (en la tabla de su módulo y, si es una
interfaz entre módulos, en la sección 2) y correr `npm test`. Si la ruta
cambia datos que viajan entre sistemas, actualizar también la
[ruta de datos](ruta-de-datos.md).
