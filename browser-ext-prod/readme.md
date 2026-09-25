## GitHub Mentor - Extension MV3 (Con backend)

**Version 0.7.12 (2026-09-25)**, rama `claude/serene-heisenberg-0te9s9` (auditoria de redundancias, tanda 1: estudiante y tunel):

- Sin «Empezar»: al pulsar el icono (o al restaurar el overlay fijado), sin sesion se muestra el login y con sesion se entra directo. Con el icono y sin editor guardado entra como «Empezar» (confirma la sesion con `/api/auth/me`, con 10 s como maximo, y el tutor responde una vez); con un editor guardado (GitHub, paginas sin contexto y `vscode.dev`) o al restaurar una pagina con algo que hacer (un repositorio, el editor o Campus) entra sin pedir ayuda al tutor ni reportarse como pestana activa hasta el primer clic o tecla. Las paginas del propio flujo de GitHub (la ventana del OAuth, la instalacion de la GitHub App, `github.com/login/device`, ajustes) y las paginas sin contexto no entran al restaurar. Una sesion vencida (401) lleva al login con «La sesion ya no es valida. Inicia sesion nuevamente.».
- Privacidad en el backend (contrato (a)): login, google-login y `/api/auth/me` traen `privacy.version`; si coincide con `ADACEEN_PRIVACY_POLICY_VERSION` (`2026-05-26`) no se muestra «Aceptar y continuar» en ningun navegador. Al aceptar se llama a `POST /api/auth/privacy-acceptance` (con un backend sin la ruta, 404, queda solo en local). Una aceptacion local anterior a 0.7.12 se registra en el backend sin volver a preguntar.
- Otro navegador o equipo: con el tunel y sin editor guardado, al entrar se consulta una vez `GET /api/workspaces/status`; si el editor esta listo se guarda y se ofrece «Abrir mi editor» en vez del tour (el primer clic pasa por `prepare`, que renueva la sesion de VS Code en la VM).
- Tunel sin GitHub App en ningun sitio: ni «Ajustes avanzados GitHub App» en la tuerca ni la fila «GitHub App» del contexto, y `/api/github-app/status` no se consulta. La vista inicial se titula «Preparar tu editor» («Primera vez»). Con Codespaces todo sigue igual.
- `vscode.dev` sin textos de Codespaces («Tutor en tu editor», «Tu editor en la nube», «Analisis de archivos en tu editor»); el repo sale del editor guardado con ese tunel. «Copiar sesion» pasa a «Copiar codigo para VS Code» y no se muestra en `vscode.dev` con VS Code conectado.
- Los mensajes que mandan a pulsar el boton del editor citan el que se ve: «Abrir mi editor» o, sin editor guardado, «Preparar mi editor» (`myEditorButtonLabel`).
- Sin botones repetidos: «Explorar repo» y «OCR visual» solo en el editor; sin «Actualizar contexto» (era «Actualizar»); sin el segundo «Autodetectar»; sin filas «No requerida»/«No detectado»; un solo boton para cerrar sesion («Salir»); el docente no cae en el tour del estudiante.
- Mac del laboratorio: la ultima eleccion (`adaceenEditorChoiceByUser`: VS Code de este equipo o editor en la nube) es la accion principal al volver otro dia.
- Menos peticiones al entrar: `/api/rag/courses` se reutiliza 30 s (antes dos veces), `/api/github/oauth/status` recien consultado no se repite al preparar el editor.
- El popup y `content.js` (codigo muerto) se borraron en la 0.7.12: el icono abre el overlay desde `background.js`.

Tanda 2 de la misma auditoria (Codespaces, docente y Campus), misma version 0.7.12:

- Codespaces con boton unico, como el tunel: una sola tarjeta («Tu repositorio») y la accion recomendada lleva los pasos («Autorizar GitHub App», «Conectar GitHub», «Preparar entorno ADACEEN»). Sin las tarjetas «Paso 2 de 3» y «Paso 3 de 3» («Abrir instalacion», «Verificar acceso», «Volver», «Preparar entorno», «Crear PR», «Ir al dashboard»), sin «Autorizar repositorio» ni «Leer archivos del repo» (solo navegaban o no funcionaban en github.com), sin «Actualizar estado» al lado de cada paso y sin el aviso «Entendido». El paso sale del estado (`resolveCurrentSetupStep`).
- GitHub App sin «Verificar acceso» (contrato (d)): tras abrir la instalacion, `/api/github-app/status` se consulta cada 4 s durante 5 min como maximo (cada tres consultas sin acceso se intenta `link-installation-auto`, como hacia «Verificar acceso»). Al tener acceso el tour pasa solo al siguiente boton, sin abrir ventanas; si el repo ya tenia la preparacion de ADACEEN, entra al panel. Se deja de consultar al cerrar el overlay, al salir o al cambiar de repositorio. La ventana de la instalacion sigue sin `opener`, asi que el aviso por `postMessage` de la pagina de retorno no llega: basta la consulta.
- Con Codespaces se siguen creando el PR y el Codespace: al volver del OAuth, `POST /github/prepare-environment` y el Codespace se abre en la misma ventana.
- Docente: una sola casilla de mini quiz («Permitir mini quiz» escribe `allowMiniQuiz` y el tipo `mini_quiz` de «Intervenciones habilitadas», donde ya no esta «Mini quiz»). «Lanzar quiz» muestra el `message` del backend y, si este activo el quiz (`autoEnabled`, contrato (c)), marca las casillas como quedaron sin tocar lo demas que no se guardo. «Iniciar bloque 1» sin grupos los asigna el backend (contrato (b)) y el estado agrega su `message`; «Asignar grupos A y B» deja de ser un paso previo.
- Campus: el acceso al curso y la bitacora se verifican solos al entrar (`verifyCampusCourseAccessOnEntry`) y queda una sola accion: «Analizar Campus» y luego «Sincronizar agenda». «Verificar acceso» solo aparece para reintentar tras un fallo o cuando falta la bitacora. La cabecera del resumen ya no repite «Analizar Campus» ni «Sincronizar agenda» (esos botones solo quedan en el editor, como «Explorar repo» y «OCR visual»).

Revision de las tandas 1 y 2, misma version 0.7.12:

- Al restaurar el overlay fijado ya no se entra en las ventanas del propio flujo (el OAuth en `github.com/login/oauth/authorize`, la instalacion de la App en `github.com/apps/<app>/installations/new`): antes mostraban el tour con un repositorio «login/oauth» o «apps/<app>» y, con la pestana del overlay aun activa, el aviso «Sesion activa en otra pestaña». Las rutas de GitHub (`login`, `apps`, `settings`, `orgs`…) ya no se leen como owner (`parseRepoFullName`, `getGitHubInfo`). Al restaurar, otra pestana activa deja la pagina en la bienvenida sin el aviso de conflicto.
- Con la privacidad pendiente («Aceptar y continuar» abierto) el contexto de la pagina no va al tutor; la primera respuesta se pide al aceptar.
- En el editor (`vscode.dev` y Codespaces) la accion recomendada ya no repite «Actualizar» con «Solicitar tutoria» ni «OCR visual» con «Reintentar OCR»: dice «Pulsa Actualizar (Ctrl+Enter)…». En «Buscar contexto», con el tutor pausado («Actualizar» deshabilitado) vuelve «Actualizar contexto».
- El docente en GitHub tiene su propia accion («Panel docente» → «Configuracion») en vez de «Preparar mi editor»/«Abrir Codespaces», y no se busca un editor a su nombre.
- La tuerca se abre bajo la cabecera: «Salir» sigue a la vista con ella abierta.
- Codespaces: al llegar al paso de la App se intenta una vez `link-installation-auto`; si la App ya estaba instalada en la organizacion, el tour pasa a «Conectar GitHub» sin abrir la pestana de instalacion.
- Campus: si la verificacion al entrar falla o falta la bitacora, el aviso tambien va al estado (`role=status`) para los lectores de pantalla.
- «Tu VS Code» (Mac del laboratorio) ya no afirma que el repositorio de la pagina se abrio ahi ni que exista un editor en la nube; el editor de otra cuenta no se guarda si la cuenta cambia durante `GET /api/workspaces/status`; el texto de la ventana de analisis cita «Explorar repo».
- `ADACEEN_PRIVACY_POLICY_VERSION` se compara en las pruebas con `PRIVACY_POLICY_VERSION` del backend.

Integracion con VS Code 0.0.32, misma version 0.7.12:

- Los avisos de «Copiar codigo para VS Code» mandan a «Tengo un codigo o sesion», la opcion unica de «ADACEEN: Conectar» en VS Code 0.0.32 (en la 0.0.31 se llamaba «Tengo un codigo del navegador»).
- Tras elegir un reemplazo, el estado dice «Reemplazo enviado. VS Code lo aplica en unos segundos; si el cambio es grande o no encuentra el codigo, pregunta antes.»: VS Code 0.0.32 toma ese clic como la confirmacion.
- «Mis parametros asignados» describe «Pedir confirmación» como «pide confirmacion en cambios grandes o automaticos» (en un cambio corto el clic del estudiante vale como confirmacion).

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
2. Activa `Modo de desarrollador`.
3. Clic en `Cargar descomprimida`.
4. Selecciona esta carpeta: `browser-ext-prod`.

`manifest.json` es el de **produccion**: no incluye `http://127.0.0.1:3000` ni
`http://localhost:3000`. Para trabajar con el backend local usa la variante de
desarrollo (seccion 11): `node scripts/empaquetar-extension.mjs --dev`, descomprime
`dist/extension/adaceen-chromium-<version>-dev.zip` y carga esa carpeta.

## 2) Configurar backend

En Configuracion del overlay (icono de tuerca), campo `Base URL del backend`:
1. Ingresa la URL base del proxy (por ejemplo `http://127.0.0.1:3000` con la variante `-dev`). Solo se aceptan URL `http://` o `https://`.
2. Pulsa `Guardar cambios`.

(El boton `Probar` y la `Fuente de sugerencias` son del popup, que no esta conectado como `default_popup` y no va en el paquete.)

## 3) Credenciales demo

Desde 0.7.11 la vista de login solo las muestra (y precarga la de estudiante) con el backend en `localhost` o `127.0.0.1`.

- Estudiante: `estudiante@adaceen.edu.co / Estudiante123!`
- Profesor: `docente@adaceen.edu.co / Docente123!`
- Admin: `admin@adaceen.edu.co / Admin123!`

## 4) Flujo contextual recomendado

La extension muestra un hub por modulos:

- `ADACEEN`: sesion del usuario.
- `GitHub App`: conexion/permisos para leer repo, rama y PR (con el proveedor `tunnel` la fila no aparece).
- `GitHub OAuth`: cuenta del estudiante (con Codespaces, para crear/reanudar su Codespace; con el tunel, para registrar el editor a su nombre).
- `Campus`: deteccion de actividad academica.
- `Codespaces` (con el tunel se llama `Editor`): preparacion o estado del entorno.
- `VS Code`: aparece en GitHub cuando la extension de VS Code publico contexto hace poco para el repo actual.

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

Con el proveedor `tunnel` (el del piloto) el tour tiene un solo paso, «Conectar GitHub», y no usa la GitHub App: ver la version 0.7.11 arriba y `docs/guia-instalacion-uso.md`, seccion 1.4. Lo que sigue es el tour con el proveedor `codespaces`.

Para el `estudiante` existe un **Tour de configuracion inicial** (antes del dashboard principal), con una sola tarjeta y un boton unico en «Accion recomendada»:

1. Confirmar o detectar el repositorio objetivo (con el repositorio de la pagina no hace falta).
2. Pulsar «Autorizar GitHub App» para instalar la GitHub App sobre el repo. ADACEEN detecta la instalacion solo (consulta `/api/github-app/status` cada pocos segundos) y pasa al siguiente paso.
3. Pulsar «Conectar GitHub» para conectar la cuenta del estudiante por OAuth. Al volver, ADACEEN sigue solo con el paso 4 en esa misma ventana.
4. Si la cuenta ya estaba conectada, pulsar «Preparar entorno ADACEEN» para crear/reusar branch + PR con `.devcontainer/devcontainer.json`.
5. Al crear o detectar el PR, ADACEEN llama `POST /github/prepare-environment`.
6. El backend usa el token OAuth del estudiante para buscar un Codespace existente, reanudarlo si esta apagado o crear uno nuevo desde la PR por API.
7. Cuando GitHub devuelve `web_url`, la extension abre ese Codespace automaticamente.
8. Si GitHub exige login, cuota o confirmacion manual, ADACEEN conserva `codespaces.new` como fallback visual.
9. Al completar ese tour, se habilita el dashboard principal.

La UI bloquea la preparacion si falta GitHub App, acceso al repo u OAuth del estudiante con scope `codespace`.
Para produccion/piloto configura `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_CALLBACK_URL` y `GITHUB_OAUTH_SCOPES=repo codespace read:user user:email`.
`GITHUB_CODESPACES_USER_TOKEN` queda solo como respaldo de desarrollo.

Para `admin` y `profesor` (desde 0.7.12):
- No se ejecuta el tour inicial.
- Entran directo al panel principal (el admin, al de administracion de usuarios).
- Si necesita conectar GitHub App o rehacer PR, lo hace manualmente desde `Configuracion` (icono de tuerca).

Endpoints usados:
- `GET /api/github-app/status`
- `POST /api/github-app/install-url`
- `GET /api/github-app/callback`
- `GET /api/github/oauth/status`
- `POST /api/github/oauth/start`
- `GET /auth/github/callback`
- `POST /github/prepare-environment`
- `POST /api/github-app/link-installation-auto`

## 9) Campus Virtual y agenda

En Campus Virtual, el hub prioriza actividad, fecha visible y accion academica. Al entrar en un curso, ADACEEN verifica solo el acceso y la bitacora (`GET /api/documents/bitacora/status`); con eso, «Analizar Campus» lee las actividades visibles y «Sincronizar agenda» las guarda en Google Calendar. «Verificar acceso» solo aparece si la verificacion falla o falta la bitacora.

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

Sin `popup/` ni `content.js` (codigo muerto). Genera en `dist/extension/` (ignorado por git): `adaceen-chromium-<version>.zip`,
`adaceen-firefox-<version>.zip` (mismo codigo + `browser_specific_settings.gecko`,
`strict_min_version 128.0` y `background.scripts`), las variantes `-dev` y
`SHA256SUMS.txt`. El script valida el manifest (archivos referenciados, orden de
`CONTENT_SCRIPT_FILES`, hosts de produccion), vuelve a leer cada zip y compara CRC y
contenido. Con las mismas fuentes el zip es identico byte a byte.
