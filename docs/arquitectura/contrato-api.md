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
| Sesión | Cabecera `x-session-id` (también se acepta `sessionId` en el cuerpo o la cookie de sesión). Roles: `student`, `teacher`, `admin`. Tipos: `browser` (overlay), `editor` (VS Code; vence a los `EDITOR_SESSION_TTL_DAYS` días, 30 por defecto) y `cli` (scripts de consola); un inicio de sesión solo desactiva las sesiones anteriores de su tipo. |
| Sesión inválida | Toda respuesta a una petición con `x-session-id` inactivo, vencido o inexistente lleva `x-adaceen-session: invalid` (expuesta por CORS), salvo las que entregan una sesión nueva (login y canjes del editor). Las rutas que aceptan anónimos siguen respondiendo como anónimo; las que exigen sesión siguen con 401. |
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
  guarda), `metadata` (lista blanca de claves; VS Code 0.0.30 agrega
  `editorHost` y `editorUi` a cada evento).
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
- `PUT /api/pilot/block`: `block` 0, 1 o 2; queda en el historial. Si se
  inicia el bloque 1 o 2 y el docente no tiene ningún estudiante asignado,
  asigna los grupos como `POST /api/pilot/assign` (misma función, al azar y en
  partes iguales, con la semilla guardada o una nueva; nadie que ya tenga
  grupo cambia) y lo dice en la respuesta: `assignedAutomatically: true`,
  `added` y `message` (texto para mostrar junto al estado: cuenta la
  asignación y su semilla, que el protocolo pide anotar; el bloque y los
  conteos siguen en `description` y `counts`). Con menos de 2 estudiantes
  activos no asigna solo: responde 409 (sin estudiantes, o con uno solo, que
  se puede asignar a mano con `POST /api/pilot/assign`) y no inicia el bloque.
- `GET /api/pilot/me`: condición del estudiante que consulta.

### 2.6 Cola de inferencia y salud

- El API deja cada trabajo en Service Bus (`llm-jobs`) y espera el resultado
  en `llm-results-sessions`; el worker no tiene rutas propias. Los workers
  pueden ser GPU de Google Cloud, Mac del laboratorio o un clúster de Mac
  ([worker-mac](../operacion/worker-mac.md)); el resultado trae su id
  (`workerId`), que queda en `metadata.worker` de cada `tutor_decision`.
- `POST /api/agent/heartbeat` (`x-worker-token`): latido del worker cada 30 s
  con `workerId`, `model`, `jobsProcessed`, `lastJobAt`, `startedAt`,
  `platform` (`linux-x64`, `darwin-arm64`), `concurrency` y `kinds`
  (`text,image`). Los textos se limpian y recortan.
- `GET /api/agent/health`: 503 si no hay ningún worker vivo (lo usa la alarma).
- `GET /api/agent/backend`: modo, colas y `listening[]` con cada worker que
  escucha (`id`, `label` como «Mac del laboratorio - M2», `alive`, `model`,
  `platform`, `concurrency`, `kinds`).
- `GET /api/health`: estado general, sin secretos (sal y token configurados,
  retención, versión de la política de privacidad, agente de entornos,
  `workspace_agent_transport`, `workspace_vm_autostart`, `model_workers_alive`
  y `model_workers_known_down`, que lee `/empezar`; `known_down` solo es `true`
  si hubo latidos y todos vencieron, así un backend recién reiniciado o sin
  token de latidos no se muestra como caído).

### 2.7 Entornos por túnel y relay

- `POST /api/workspaces/prepare` (`repoFullName`, `force`) y
  `GET /api/workspaces/status`: los usa el overlay. Responden
  `{ ok, provider, status, workspace, deviceCode?, message?, code?, retryable? }`.
  `retryable: true` marca los errores transitorios del agente
  (`agent_unreachable`, `agent_timeout`) y `status: "pending"` con
  `code: "vm_starting"` (VM encendiéndose, con `WORKSPACE_VM_AUTOSTART=gcp`):
  la extensión sigue consultando en vez de cortar la espera.
- `prepare` crea (o reutiliza si le quedan más de 7 días) una sesión `editor`
  con label `tunnel` y la manda al agente en el cuerpo de `POST /workspaces`:
  `editorSession: { sessionId, backendUrl, expiresAt, userName, userEmail }`
  (`backendUrl` = `PUBLIC_BASE_URL`, si no `PUBLIC_API_URL`, si no la URL de la
  petición, pasada a `https` fuera de localhost y sin puerto propio porque el
  agente rechaza `http`; solo si la sesión llegó en `x-session-id`). Si el `POST` no llegó
  al agente (desconectado, VM apagada o, en modo relay, nunca recogido de la
  cola), el siguiente `status` lo reenvía, así la espera termina sola cuando la
  VM vuelve. Si tras una espera transitoria el agente responde `not_found`
  (el `POST` se perdió aunque pareciera entregado), `status` lo reenvía una
  vez sin `force` en vez de cortar la espera.
- Con autoencendido, si la VM está `STOPPING` (alguien la apagó, p. ej.
  `deploy/clase.sh terminar`) no se enciende sola durante 15 minutos, y un
  `instances.start` rechazado (permisos, cuota) responde `agent_unreachable`
  en vez de `vm_starting`.
- `WORKSPACE_ALLOWED_LOGINS=*` (o vacía) deja preparar editor a cualquier
  usuario activo con GitHub conectado.
- `GET /api/workspaces/agent/next?wait=25` (sondeo largo) y
  `POST /api/workspaces/agent/responses` (`responses` con `id`, `status` y
  `json`): los usa el agente de la VM con `x-agent-token`.
- `GET /api/workspaces/agent/status`: si el agente está conectado.

### 2.8 Emparejar VS Code

Detalle en [acceso simplificado](acceso-simplificado.md), sección 2.

- `POST /api/auth/editor/pairing-code` (sesión `browser` en `x-session-id`; la
  cookie sola no basta): código de un solo uso `XXXX-XXXX` que vence en 10
  minutos (`{ ok, code, expiresAt, ttlSeconds }`). Pedir uno nuevo invalida los
  anteriores; se guarda solo su SHA-256.
- `POST /api/auth/editor/claim` (`code`, `editorHost?`, `label?`, sin sesión):
  canje atómico por una sesión `editor` (`{ ok, sessionId, expiresAt, user }`).
  Errores: 400 `invalid_code`, 404 `code_not_found`, 429 `too_many_attempts`.
- `POST /api/auth/editor/github` (`githubToken`, `editorHost?`, sin sesión):
  lee el login con `GET /user` y busca al usuario cuyo OAuth de ADACEEN tiene
  ese login (`{ ok, sessionId, expiresAt, user, githubLogin }`). Errores: 400
  `missing_token`, 401 `github_token_invalid`, 404 `github_login_not_linked`,
  429 `too_many_attempts`, 502 `github_unavailable`. El token no se guarda.
  Solo vincula estudiantes: un docente o administrador recibe 404
  `github_login_not_linked` con `reason: "staff_requires_code"` y se vincula
  con el código del navegador (GitHub acepta cualquier token de la cuenta, y
  una sesión de staff de 30 días abre admin, exportes y piloto).
- Límite: 20 intentos fallidos por minuto e IP en cada ruta de canje (los
  canjes buenos no gastan cupo: un laboratorio sale por la misma IP). En
  `github` solo cuenta `github_token_invalid`: un login sin vincular exige un
  token válido, así que no sirve para adivinar.
- Dos `pairing-code` simultáneos del mismo usuario (doble clic) pueden dejar
  los dos códigos válidos (no se serializan): son del mismo usuario, de un
  solo uso y vencen en 10 minutos.
- Las respuestas a otras personas (`GET /api/behavior/events`, la telemetría
  de intervenciones del docente en login y `/api/auth/me`) no llevan ids de
  sesión: con uno se actúa como el estudiante.
- `POST /api/auth/logout` desactiva la sesión actual y las `editor` del
  usuario. `POST /api/auth/login` acepta `sessionKind: "cli"`.

### 2.9 Mini-quiz

- `POST /api/quiz/after-accept`: la extensión de VS Code pide un quiz después
  de aceptar un cambio.
- `GET /api/quiz/pending`, `POST /api/quiz/:id/answer`,
  `POST /api/quiz/:id/followup`, `POST /api/quiz/:id/skip`: ciclo del
  estudiante.
- `POST /api/quiz/launches`, `GET /api/quiz/launches`,
  `POST /api/quiz/launches/:id/close`, `GET /api/quiz/summary`: quiz lanzado
  por el docente.
- Un quiz lanzado solo llega si la política tiene `allowMiniQuiz` y
  `quizSettings.triggers` con `teacher_launch`. Si falta alguno,
  `POST /api/quiz/launches` lo activa y lo guarda después de crear el
  lanzamiento (si crearlo falla, responde 400 y la política no cambia) y
  responde `{ ok, launch, autoEnabled: true, message, policy }` (`policy` es
  la política guardada, para refrescar el formulario). Si `allowMiniQuiz`
  estaba apagado, los disparadores quedan solo en `teacher_launch`: el quiz
  tras aceptar sigue sin salir y, si «Tras aceptar una sugerencia» estaba
  marcado, `message` dice que quedó sin marcar. `allowMiniQuiz` es el
  interruptor general del mini quiz: también deja pasar la etapa de mini quiz
  en las reglas del tutor cuando `allowedInterventions` incluye `mini_quiz`.
  Si el lanzamiento se creó pero no se pudo guardar la política, responde
  `{ ok, launch, message }` con el aviso para activarlo a mano. Sin cambios,
  la respuesta es `{ ok, launch }`.

### 2.10 Sesión y privacidad aceptada

- `POST /api/auth/login`, `POST /api/auth/google-login` y `GET /api/auth/me`
  devuelven, además de `session` y `policy`,
  `privacy: { version: string|null, acceptedAt: string|null }`: la última
  versión de la política de privacidad que aceptó ese usuario, en cualquier
  navegador o equipo (`null` si nunca la aceptó o si no se pudo leer; el login
  no falla por eso). La extensión compara `privacy.version` con su propia
  versión de la política y, si coincide, no muestra el modal.
- `POST /api/auth/privacy-acceptance` (`version`, exige sesión): registra
  que el usuario aceptó esa versión y responde
  `{ ok, privacy: { version, acceptedAt } }` con la versión más nueva que
  aceptó. Solo acepta versiones publicadas por el servidor
  (`PUBLISHED_PRIVACY_POLICY_VERSIONS`, la vigente es `policy.updatedAt` de
  `GET /api/privacy-policy`, hoy `2026-05-26`); otra responde 400. En
  `user_privacy_acceptances` queda una fila por usuario y versión con la
  fecha de la primera aceptación: aceptar de nuevo no la cambia y aceptar una
  versión anterior no baja la devuelta. Un backend anterior responde 404: la
  extensión guarda la aceptación solo en el navegador, como antes.

### 2.11 Instalación de la GitHub App (Codespaces)

- `POST /api/github-app/install-url` entrega la URL de instalación con un
  `state` de un solo uso. GitHub vuelve a `GET /api/github-app/callback`, que
  vincula la instalación al usuario y muestra una página que dice que se puede
  cerrar la pestaña y que ADACEEN lo detecta solo (y, como respaldo, que si
  la pestaña de ADACEEN no avanza en un minuto la recargue: al entrar, la
  extensión vuelve a leer el estado). Un `installation_id` que no sea un
  número responde 400 sin gastar el `state`.
- La extensión (desde 0.7.12), tras abrir la instalación, consulta
  `GET /api/github-app/status` cada pocos segundos (con límite) y avanza
  cuando `status.installation` deja de ser `null` (y, con `repoFullName`,
  `hasRepoAccess` es `true`). La pestaña de la instalación se abre sin
  `opener`, así que la página de retorno no manda `postMessage`.

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
| `quiz-routes.ts` | `POST /api/quiz/after-accept`, `GET /api/quiz/pending`, `POST /api/quiz/:id/answer`, `POST /api/quiz/:id/followup`, `POST /api/quiz/:id/skip` | Mini-quiz del estudiante (2.9) |
| | `POST /api/quiz/launches`, `GET /api/quiz/launches`, `POST /api/quiz/launches/:id/close`, `GET /api/quiz/summary` | Quiz lanzado por el docente (2.9) |
| `workspace-routes.ts` | `GET /api/workspaces/provider`, `POST /api/workspaces/prepare`, `GET /api/workspaces/status` | Entornos por túnel (2.7) |
| | `GET /api/workspaces/agent/next`, `POST /api/workspaces/agent/responses`, `GET /api/workspaces/agent/status` | Relay con el agente de la VM (2.7) |
| `rag-routes.ts` | `GET /api/rag/courses`, `GET /api/rag/sources`, `POST /api/rag/sources`, `DELETE /api/rag/sources/:id`, `GET /api/rag/sources/:id/view` | Material autorizado del curso: listar, cargar, retirar y ver la parte citada |
| `auth-routes.ts` | `POST /api/auth/login`, `POST /api/auth/google-login`, `GET /api/auth/me`, `POST /api/auth/logout` | Sesión con correo y contraseña o con Google; traen la privacidad aceptada (2.10) |
| | `POST /api/auth/privacy-acceptance` | Guardar la aceptación de la política de privacidad del usuario (2.10) |
| `editor-auth-routes.ts` | `POST /api/auth/editor/pairing-code`, `POST /api/auth/editor/claim`, `POST /api/auth/editor/github` | Emparejar VS Code con un código o con su cuenta de GitHub (2.8) |
| `admin-routes.ts` | `GET /api/admin/users`, `POST /api/admin/users`, `PUT /api/admin/users/:userId`, `DELETE /api/admin/users/:userId` | Usuarios y cursos (docente o administrador) |
| `github-app-routes.ts` | `GET /api/github/oauth/status`, `POST /api/github/oauth/start`, `GET /auth/github/callback`, `GET /api/github-app/oauth/callback` | Autorización OAuth de GitHub |
| | `GET /api/github-app/status`, `POST /api/github-app/install-url`, `POST /api/github-app/link-installation-auto`, `GET /api/github-app/callback` | Instalación de la GitHub App en el repositorio del estudiante (2.11) |
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
| `start-page-routes.ts` | `GET /empezar` | Página de inicio para el estudiante: descargas, pasos para cargar la extensión, detección de la extensión y estado del servicio (de `GET /api/health`) |
| | `GET /descargas/adaceen-navegador.zip`, `GET /descargas/adaceen.vsix`, `GET /descargas/Preparar-Mac-ADACEEN.zip`, `GET /descargas/Preparar-Mac-ADACEEN.command` | Archivos del paquete desplegado (los arma el workflow); 404 con una página amable si faltan |

## 4. Cómo mantenerlo

Al agregar una ruta: documentarla aquí (en la tabla de su módulo y, si es una
interfaz entre módulos, en la sección 2) y correr `npm test`. Si la ruta
cambia datos que viajan entre sistemas, actualizar también la
[ruta de datos](ruta-de-datos.md).
