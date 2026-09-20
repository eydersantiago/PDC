## GitHub Mentor - Extension MV3 (Con backend)

Extension para Chrome/Edge que:
- lee la pestana activa en GitHub,
- extrae codigo visible cuando estas en `github.com/.../blob/...`,
- detecta Codespaces (`github.dev` o `*.github.dev`) y muestra bienvenida,
- tiene interruptor Encendido/Apagado,
- consume backend `agente-proxy-azure` por `POST /github-mentor`,
- usa fallback local (heuristico) si backend no responde.

## Estructura del frontend

Los content scripts son scripts clasicos (sin `import`/`export`) que comparten un unico
scope global. Se cargan en el orden de `manifest.json` (`content_scripts.js`), que debe
coincidir con `CONTENT_SCRIPT_FILES` en `background.js`. El orden sigue capas: cada archivo
solo usa, al cargar, cosas definidas en archivos anteriores.

Cada archivo cubre una sola responsabilidad; ninguno pasa de ~850 lineas (salvo la hoja de
estilos, que es una unica hoja CSS).

```text
Capa 1 - Estado
  state/text.util.js                       utilidades de texto, numeros y URLs
  state/session.state.js                   constantes, claves de storage y overlayState
  state/preferences.state.js               carga/persistencia en chrome.storage

Capa 2 - Contexto de la pagina (sin UI del overlay)
  overlay/content-context.js               lectura del DOM (GitHub, Codespaces, Campus) y buildPayload
  overlay/content-guidance.js              ideas/guia/resumen heuristicos
  overlay/content-session.js               rol de la sesion y textos derivados del contexto
  overlay/content-setup.js                 estado del tour de configuracion
  overlay/content-action-model.js          accion recomendada y textos del hub

Capa 3 - Servicios (HTTP al backend y flujos)
  services/http.service.js                 fetch con timeout, cabeceras de sesion y log de peticiones
  services/rag-courses.service.js          catalogo RAG y curso activo del estudiante
  services/admin-users.service.js          politica, telemetria y usuarios del piloto
  services/vscode-sync.service.js          rack de contexto y acciones de codigo de VS Code
  services/project-context.service.js      consentimiento, escaneo, contexto guardado y rebuilds
  services/screenshot-ocr.service.js       captura de pantalla visible y OCR
  services/mentor.service.js               peticion de tutoria al backend
  services/auth.service.js                 login/logout y sesion compartida entre pestanas
  services/operation-progress.service.js   banner de operacion en curso
  services/codespace-waiting-window.*.js   ventana intermedia mientras GitHub prepara el Codespace
  services/codespaces.service.js           URLs, estado, sondeo y apertura del Codespace
  services/github-app.service.js           GitHub App: instalacion, acceso y PR de configuracion
  services/github-oauth.service.js         OAuth de la cuenta GitHub del estudiante
  services/campus-page.service.js          curso de Campus: acceso, bitacora y analisis del HTML
  services/campus-documents.service.js     deteccion, descarga y clasificacion de documentos
  services/campus-calendar.service.js      fechas visibles, eventos y Google Calendar
  services/teacher-rag.service.js          fuentes RAG por curso del docente
  services/teacher-bitacora.service.js     bitacora del docente

Capa 4 - UI
  overlay/content-styles.js                CSS del shadow DOM
  overlay/templates/*.js                   textos y plantillas de items
  overlay/content-markup.js                ensambla el shell
  overlay/render-payload-normalizers.js    normaliza respuestas del backend para pintarlas
  overlay/render-context-hub.js            hub de contexto, conexiones y accion recomendada
  overlay/render-rag-sources.js            panel de fuentes RAG citadas
  overlay/render-vscode-panel.js           panel y paleta flotante de VS Code
  overlay/render-admin-users.js            tabla de usuarios y modal de curso
  overlay/render-settings.js               panel de configuracion
  overlay/render-session-flow.js           empezar, login, logout y arrastre de la ventana
  overlay/content-render.js                renderOverlay y listas compartidas
  overlay/content-project.js               exploracion del proyecto y ventana de analisis

Capa 5 - Ciclo de vida
  overlay/overlay-viewport.js              posicion y arrastre dentro del viewport
  overlay/overlay-vscode-palette.js        sondeo del rack y envio de acciones a VS Code
  overlay/overlay-tab-session.js           instantanea del overlay por pestana
  overlay/overlay-cross-tab-sync.js        sincronizacion de sesion/preferencias entre pestanas
  overlay/overlay-active-tab.js            pestana activa, conflicto y heartbeat
  overlay/overlay-codespace-handoff.js     traspaso de estado al saltar al Codespace
  overlay/overlay-actions.js               acciones recomendadas del hub
  overlay/overlay-elements.js              mapa de elementos del shadow DOM
  overlay/overlay-listeners.js             listeners del overlay
  overlay/overlay-mount.js                 montaje y desmontaje del overlay
  overlay/content-lifecycle.js             refreshMentorSession y arranque del content script

popup/                                     scripts propios del popup (popup.html define su orden)
background.js                              service worker (Google auth, captura, inyeccion de scripts)
```

Reglas:

- Una funcion o constante vive en un solo archivo. Si dos archivos la declaran, Chrome
  aborta la carga: el scope lexico es compartido y `const`/`let` no se puede redeclarar.
- Nada se ejecuta al cargar salvo declaraciones. El unico arranque vive al final de
  `overlay/content-lifecycle.js`, que es el ultimo archivo de la lista.
- No se usan guardas `typeof f === "function"` entre archivos del mismo paquete: todos se
  cargan juntos y el test estructural garantiza que el nombre existe. Esas guardas escondian
  rutas de respaldo con comportamiento distinto al real.
- Al crear un archivo, agregalo en `manifest.json` y en `background.js` (misma posicion).
- `npm test` en `agente-proxy-azure` ejecuta `tests/scripts/browser-ext-structure.test.ts`, que
  falla si hay duplicados, nombres indefinidos, referencias adelantadas en tiempo de carga,
  listas de carga desincronizadas o si el paquete concatenado no parsea.

## 1) Cargar la extension

1. Abre `chrome://extensions/` (o `edge://extensions/`).
2. Activa `Modo desarrollador`.
3. Clic en `Cargar descomprimida`.
4. Selecciona esta carpeta: `browser-ext-prod`.

## 2) Configurar backend

En el popup, seccion `Backend`:
1. Ingresa la URL base del proxy (por ejemplo `http://127.0.0.1:3000`).
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

- `activeTab`, `tabs`: leer la pestana activa.
- `storage`: guardar estado del popup y URL del backend.
- `host_permissions`: GitHub/Codespaces y backend local/Azure.

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
