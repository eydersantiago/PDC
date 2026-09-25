## GitHub Mentor - Extension MV3 (Con backend)

**Version 0.7.11 (2026-09-25)**, rama `claude/serene-heisenberg-0te9s9` (acceso simplificado, `docs/arquitectura/acceso-simplificado.md`, seccion 4):

- Tunel sin GitHub App: con el proveedor `tunnel` el tour tiene un solo paso, «Conectar GitHub»; al volver del OAuth se prepara el editor solo, en la misma ventana. El sondeo de respaldo del OAuth usa `flow.userHasCodespaceScope`. Sin botones que solo cambian de tarjeta («Autorizar repositorio», «Preparar entorno», «Autodetectar» con el repo ya inferido) ni el aviso «Entendido» con textos de Codespaces. Con Codespaces el tour sigue igual.
- Volver otro dia: el editor listo y el setup completado se guardan en `chrome.storage.local` por usuario y repo (`adaceenEditorByUser`, `adaceenSetupDoneByUser`) y `refreshGithubAppStatus` ya no los borra con el tunel. Con sesion valida y un editor guardado el overlay entra sin «Empezar» en GitHub y en paginas sin contexto (no en el editor ni en Campus, donde sigue «Empezar»), sin pedir ayuda al tutor y sin reportarse como pestana activa hasta el primer clic o tecla en el overlay; ofrece «Abrir mi editor»: consulta `/api/workspaces/status` y abre; si no esta listo, `prepare` (idempotente). Pasa directo por `prepare` (que renueva la sesion de VS Code en la VM) tras cerrar sesion, sin registro local o si el ultimo `prepare` fue hace mas de 7 dias (`sessionWrittenAt`).
- Proveedor: si `/api/workspaces/provider` falla por red, tiempo o 5xx, el valor es provisional (el tunel si hay un editor guardado) y se vuelve a consultar a los 15 s; solo un 404 fija Codespaces. Con el proveedor provisional no se borra el setup y antes de crear una PR se confirma.
- VM apagada: los errores con `retryable: true` no cortan la espera; la ventana sigue consultando y muestra el mensaje del backend («Encendiendo la VM de editores…» o «El editor esta apagado; avisa al docente»).
- Codigo de dispositivo en una sola pestana: la ventana de espera pasa a `github.com/login/device`, donde el overlay muestra el codigo con un boton «Copiar codigo», y al confirmar el tunel esa misma pestana abre `vscode.dev`. El codigo (`adaceenDeviceCodeHandoff`) queda ligado al usuario de ADACEEN, se borra al cerrar sesion y solo se copia solo si se emitio hace menos de 1 min. Si la espera termina sin editor (error, tiempo agotado) o deja de latir (la pestana de origen se recargo o se cerro), el aviso lo dice y pide volver a «Abrir mi editor». `navigatePendingCodespaceWindow` ya no cierra una ventana de otro origen (la del OAuth) por no poder escribir `opener`.
- «Abrir en VS Code de este equipo» pide un codigo de un solo uso (`POST /api/auth/editor/pairing-code`) y abre `vscode://adaceen.adaceen/abrir?code=…&repo=owner/repo` (VS Code 0.0.31 clona o abre y se vincula solo). El enlace se crea y se pulsa dentro de la shadow root cerrada del overlay, fuera del alcance de los scripts de la pagina. Si falla por tiempo, 5xx o red, abre `vscode://adaceen.adaceen/abrir?repo=…` sin codigo (VS Code se conecta con «ADACEEN: sin conectar») y no copia la sesion; solo con un backend anterior sin la ruta (404) usa el enlace de antes (`vscode://vscode.git/clone`) y copia la sesion. «Copiar sesion» copia un codigo de un solo uso para «ADACEEN: Conectar» (con un fallo pasajero pide reintentar).
- «VS Code conectado» exige un rack de la extension de VS Code (`source: vscode_extension`) de menos de 10 min; en github.com la fila «VS Code» del contexto aparece cuando VS Code publico hace poco para el repo actual. Esa consulta no retrasa la peticion al tutor.
- El login ya no viene precargado con la cuenta demo (solo con el backend local).
- `/empezar` del backend detecta la extension con un content script minimo propio (`inicio/pagina-inicio.content.js`, segunda entrada de `content_scripts`). En produccion solo corre en el backend https; el `/empezar` de `localhost:3000` y `127.0.0.1:3000` lo agrega la variante `-dev` (`node scripts/empaquetar-extension.mjs --dev`), como los hosts locales (A12.7).

**Version 0.7.10 (2026-09-24)**, rama `feat/macs-laboratorio`:

- Mac del laboratorio y VS Code instalado (A15.10 · ADACEEN-151): «Abrir en VS Code de este equipo» (en «Paso 1 de 3» de «Preparar repositorio» y en la tarjeta «Repositorio listo») clona el repositorio con el VS Code local (`vscode://vscode.git/clone`) y copia la sesion para pegarla en VS Code («ADACEEN: Configurar sesion compartida»). Con VS Code instalado no hacen falta la GitHub App ni el editor en la nube: el asistente se da por terminado. La extension de VS Code 0.0.30 se conecta sola a produccion cuando no hay backend local.
- Sin cambios de permisos: el enlace `vscode://` lo abre el navegador con su propia confirmacion.

**Version 0.7.9 (2026-09-24)**, rama `feat/segunda-tanda-jira`:

- Piloto con y sin tutor (A13.1): seccion «Piloto con y sin tutor» en la configuracion del docente para asignar los grupos A y B e iniciar o terminar los bloques (`/api/pilot`). En el bloque sin tutor el backend responde un aviso y no deja aplicar codigo.
- Accesibilidad de la seccion nueva (grupo con nombre y descripcion, `aria-pressed` en los bloques, estado con `role="status"`).

**Version 0.7.8 (2026-09-24)**, rama `feat/cierre-pendientes-jira`:

- Telemetria v1.1 del overlay (`services/telemetry.service.js`, A11.2/A4.2) y senales de error y bloqueo (A6.2). Ver seccion 10.
- Botones "Me sirvio" / "No me sirvio" bajo la respuesta del tutor y atajo `Ctrl+Enter` para pedir ayuda.
- Ajustes del docente para aplicar codigo desde VS Code (`policy.codeApplication`, A10.8).
- Accesibilidad WCAG 2.1 AA del overlay (A12.9): `docs/accesibilidad/checklist-wcag-overlay.md`.
- Revision de seguridad (A12.8): enlaces del backend solo http/https, shadow root cerrado y enlaces del visor de fuentes sin `sessionId`; `docs/seguridad/revision-overlay.md`.
- Permisos minimos (A12.7): sin `tabs`, sin `localhost` ni `*.azurewebsites.net` en produccion; `docs/seguridad/permisos-extension.md`.
- Empaquetado para Chromium y Firefox con `node scripts/empaquetar-extension.mjs` (A15.9). Ver seccion 11.

Extension para Chrome/Edge que:
- lee la pestana activa en GitHub,
- extrae codigo visible cuando estas en `github.com/.../blob/...`,
- detecta Codespaces (`github.dev` o `*.github.dev`) y muestra bienvenida,
- tiene interruptor Encendido/Apagado,
- consume backend `agente-proxy-azure` por `POST /github-mentor`,
- usa fallback local (heuristico) si backend no responde.

## Estructura del frontend

Los content scripts son scripts clasicos (sin `import`/`export`) que comparten un unico scope global. Se cargan en el orden de `manifest.json` (`content_scripts.js`), que debe coincidir con `CONTENT_SCRIPT_FILES` en `background.js`. El orden sigue capas: cada archivo solo usa, al cargar, cosas definidas en archivos anteriores.

```text
Capa 1 - Estado
  state/session.state.js        constantes, claves de storage, overlayState
  state/preferences.state.js    carga/persistencia en chrome.storage

Capa 2 - Contexto de la pagina (sin UI del overlay)
  overlay/content-context.js    lectura del DOM (GitHub, Codespaces, Campus), utilidades de texto/URL, parseo de repo
  overlay/content-guidance.js   ideas/guia/resumen heuristicos
  overlay/content-setup.js      estado del tour de configuracion

Capa 3 - Servicios (HTTP al backend y flujos)
  services/backend.service.js   mentor, proyecto, RAG, cursos
  services/telemetry.service.js telemetria v1.1: cola, lotes, ciclo del tutor, senales de error
  services/auth.service.js      login/logout, sesion compartida entre pestanas
  services/github.service.js    GitHub App, OAuth, Codespaces
  services/workspace.service.js entorno por tunel de VS Code (proveedor "tunnel")
  services/campus.service.js    Campus Virtual, bitacora, RAG docente, agenda

Capa 4 - UI
  overlay/content-styles.js     CSS del shadow DOM
  overlay/templates/*.js        textos y plantillas de items
  overlay/content-markup.js     ensambla el shell
  overlay/content-a11y.js       foco, teclado (Escape, Ctrl+Enter) y render idempotente
  overlay/content-render.js     pinta overlayState (renderOverlay, listas, paneles)
  overlay/content-project.js    exploracion del proyecto y ventana de analisis

Capa 5 - Ciclo de vida
  overlay/content-lifecycle.js  montaje, listeners, viewport, sincronizacion entre pestanas, arranque

inicio/pagina-inicio.content.js  /empezar del backend: avisa que la extension esta instalada (segunda entrada de content_scripts, aislada del overlay)
popup/                          scripts propios del popup (popup.html define su orden)
background.js                   service worker (Google auth, captura, inyeccion de content scripts)
```

Reglas:

- Una funcion o constante vive en un solo archivo. Si dos archivos la declaran, la ultima en cargar pisa a la primera sin aviso.
- Nada se ejecuta al cargar salvo declaraciones; las capas inferiores pueden llamar a `renderOverlay()` o a funciones de `content-lifecycle.js` **dentro de funciones**, nunca en el nivel superior del archivo.
- Al crear un archivo, agregalo en `manifest.json` y en `background.js` (misma posicion).
- `npm test` en `agente-proxy-azure` ejecuta `tests/scripts/browser-ext-structure.test.ts`, que falla si hay duplicados, nombres indefinidos, referencias adelantadas en tiempo de carga o listas de carga desincronizadas.
- `tests/scripts/browser-ext-flujo-tunel.test.ts` carga los content scripts reales en `node:vm` (chrome, DOM y backend falsos, reloj virtual) y simula el acceso simplificado: tunel sin GitHub App, VM apagada, codigo de dispositivo, volver otro dia con «Abrir mi editor», alcance de la entrada automatica, proveedor provisional, VS Code local y `/empezar`. Falla tambien si el overlay pide a su shadow root un id que no existe en el markup.

## 1) Cargar la extension

1. Abre `chrome://extensions/` (o `edge://extensions/`).
2. Activa `Modo desarrollador`.
3. Clic en `Cargar descomprimida`.
4. Selecciona esta carpeta: `browser-ext-prod`.

`manifest.json` es el de **produccion**: no incluye `http://127.0.0.1:3000` ni
`http://localhost:3000`. Para trabajar con el backend local usa la variante de
desarrollo (seccion 11): `node scripts/empaquetar-extension.mjs --dev`, descomprime
`dist/extension/adaceen-chromium-<version>-dev.zip` y carga esa carpeta.

## 2) Configurar backend

En Configuracion del overlay (icono de tuerca), campo `Base URL del backend`:
1. Ingresa la URL base del proxy (por ejemplo `http://127.0.0.1:3000` con la variante `-dev`). Solo se aceptan URL `http://` o `https://`.
2. Pulsa `Probar` para validar `/health`.
3. Verifica `Fuente de sugerencias`:
   - `backend/ai` o `backend/heuristic` cuando responde servidor,
   - `local/fallback` si hay error de conexion.

## 3) Credenciales demo

- Estudiante: `estudiante@adaceen.edu.co / Estudiante123!`
- Profesor: `docente@adaceen.edu.co / Docente123!`
- Admin: `admin@adaceen.edu.co / Admin123!`

## 4) Flujo contextual recomendado

La extension muestra un hub por modulos:

- `ADACEEN`: sesion del usuario.
- `GitHub App`: conexion/permisos para leer repo, rama y PR.
- `GitHub OAuth`: cuenta del estudiante para crear/reanudar su Codespace.
- `Campus`: deteccion de actividad academica.
- `Codespaces`: preparacion o estado del worker.

Cada vista responde:

1. Donde estoy.
2. Que detecto ADACEEN.
3. Cual es el siguiente paso.

No hay redireccion automatica a GitHub. La extension muestra primero el contexto y abre GitHub solo cuando el usuario pulsa `Conectar GitHub`.

## 5) Deteccion de contexto

- `github_code`: URL con `/blob/` y codigo visible.
- `github_general`: repo/pagina GitHub sin archivo abierto.
- `codespace`: dominios `github.dev`, `*.github.dev`, `app.github.dev`, `*.app.github.dev`.
- `other`: cualquier otro sitio.

Cuando detecta Codespace, el popup muestra bienvenida y mensaje de inicio para programar.

## 6) Endpoint esperado en backend

`POST /github-mentor`

Body esperado:
```json
{
  "question": "texto opcional",
  "max_items": 6,
  "context": {
    "url": "...",
    "title": "...",
    "pageType": "github_code",
    "repoFullName": "owner/repo",
    "filePath": "src/app.ts",
    "languageHint": "TypeScript",
    "codeSnippet": "...",
    "codeLineCount": 120
  }
}
```

Respuesta esperada:
```json
{
  "ok": true,
  "source": "ai",
  "result": {
    "ideas": ["..."],
    "searches": ["..."],
    "guide": ["..."],
    "welcome_message": "...",
    "analysis_summary": "..."
  }
}
```

## 7) Permisos usados

Justificacion completa en `docs/seguridad/permisos-extension.md`.

- `activeTab`: inyectar el overlay al pulsar el icono y capturar la pantalla para el OCR visual.
- `storage`: preferencias, sesion compartida entre pestanas, estado por pestana e id anonimo (`adaceenClientId`).
- `scripting`: reinyectar los content scripts desde el service worker.
- `identity`: login con Google y autorizacion de Google Calendar (`calendar.events`, para agendar las actividades que publica el profesor).
- `host_permissions`: Campus Virtual, GitHub/Codespaces, vscode.dev (tuneles), la API de Google Calendar y el backend de produccion `https://app-adaceen-api-eyder05232002.azurewebsites.net`. El backend local solo en la variante `-dev`.

## 8) Flujo estable con GitHub App

Para `estudiante` y `profesor` existe un **Tour de configuracion inicial** (antes del dashboard principal):

1. Confirmar o detectar el repositorio objetivo.
2. Pulsar `Conectar GitHub` para instalar/verificar la GitHub App sobre el repo.
3. Conectar la cuenta GitHub del estudiante por OAuth cuando ADACEEN lo pida.
4. Pulsar `Preparar entorno ADACEEN` para crear/reusar branch + PR con `.devcontainer/devcontainer.json`.
5. Al crear o detectar el PR, ADACEEN llama `POST /github/prepare-environment`.
6. El backend usa el token OAuth del estudiante para buscar un Codespace existente, reanudarlo si esta apagado o crear uno nuevo desde la PR por API.
7. Cuando GitHub devuelve `web_url`, la extension abre ese Codespace automaticamente.
8. Si GitHub exige login, cuota o confirmacion manual, ADACEEN conserva `codespaces.new` como fallback visual.
9. Al completar ese tour, se habilita el dashboard principal.

La UI bloquea la preparacion si falta GitHub App, acceso al repo u OAuth del estudiante con scope `codespace`.
Para produccion/piloto configura `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_CALLBACK_URL` y `GITHUB_OAUTH_SCOPES=repo codespace read:user user:email`.
`GITHUB_CODESPACES_USER_TOKEN` queda solo como respaldo de desarrollo.

Para `admin`:
- No se ejecuta el tour inicial.
- Entra directo al dashboard de administracion de usuarios.
- Si necesita conectar GitHub App o rehacer PR, lo hace manualmente desde `Configuracion` (icono de tuerca).

Endpoints usados:
- `GET /api/github-app/status`
- `POST /api/github-app/install-url`
- `GET /api/github-app/callback`
- `GET /api/github/oauth/status`
- `POST /api/github/oauth/start`
- `GET /auth/github/callback`
- `POST /github/prepare-environment`
- `POST /api/github-app/bootstrap-devcontainer`

## 9) Campus Virtual y agenda

En Campus Virtual, el hub prioriza actividad, fecha visible y accion academica. El boton `Agregar a agenda` abre un borrador en Google Calendar con el enlace de la pagina y la fecha detectada en detalles para que el estudiante la revise antes de guardar.

## 10) Telemetria v1.1 y senales

`services/telemetry.service.js` envia eventos a `POST {backend}/api/behavior/events`
(contrato de la rama `feat/cierre-pendientes-jira`):

- Cola en memoria; lote cada 5 s o al juntar 10 eventos (max. 50 por peticion); un
  reintento ante error de red, timeout, 429 o 5xx; al salir de la pagina (`pagehide`) se
  vacia con `fetch(..., { keepalive: true })`. Sin persistencia offline.
- Cabeceras: las de `buildApiHeaders()` (`x-session-id` si hay sesion) y siempre
  `x-adaceen-client-id` (se genera una vez y se guarda en `chrome.storage.local` con la
  clave `adaceenClientId`).
- Cada evento lleva `source: "browser_extension"`, `schemaVersion: "1.1"`, `seq`
  monotono y `clientSessionId` (uno por carga de pagina).
- Eventos: `overlay_opened` / `overlay_closed` (`metadata.trigger`/`reason`),
  `tutor_request_submitted` (`manual`, `shortcut` o `auto`), `tutor_response_received`
  (`decisionId`, `latencyMs`, `value` = origen, `metadata.blocked`),
  `tutor_response_shown`, `tutor_response_accepted` / `tutor_response_rejected`
  (botones bajo la respuesta), `tutor_response_ignored` (reemplazada, overlay cerrado o
  pagina abandonada sin opinion), `rag_source_opened`, `error_detected` y
  `blocking_detected` (mismo error visible >= 120 s o 3 veces en 10 min).
- El texto del error (`errorText`, max. 300) solo viaja en el evento; el servidor lo
  convierte en hash. Las senales solo se observan con el overlay abierto, iniciado y con
  el tutor activo.

## 11) Empaquetado (Chromium y Firefox)

```bash
node scripts/empaquetar-extension.mjs         # produccion
node scripts/empaquetar-extension.mjs --dev   # agrega el backend local
```

Genera en `dist/extension/` (ignorado por git): `adaceen-chromium-<version>.zip`,
`adaceen-firefox-<version>.zip` (mismo codigo + `browser_specific_settings.gecko`,
`strict_min_version 128.0` y `background.scripts`), las variantes `-dev` y
`SHA256SUMS.txt`. El script valida el manifest (archivos referenciados, orden de
`CONTENT_SCRIPT_FILES`, hosts de produccion), vuelve a leer cada zip y compara CRC y
contenido. Con las mismas fuentes el zip es identico byte a byte.
