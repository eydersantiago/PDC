# Acceso simplificado: emparejamiento del editor y ciclo sin comandos

Estado: contrato de la tanda "acceso simplificado" (rama `claude/serene-heisenberg-0te9s9`,
sobre `feat/macs-laboratorio`). Versiones: extensión de navegador 0.7.11, extensión de
VS Code 0.0.31. La [sección 8](#8-auditoría-de-redundancias-navegador-0712-y-vs-code-0032)
resume lo que cambió con la auditoría de redundancias (navegador 0.7.12, VS Code 0.0.32):
donde contradiga a las secciones 3 y 4, vale la 8.

## Problema

En el primer ingreso con el túnel el estudiante hacía unos 20-25 clics y tres cosas a mano
(escribir `chrome://extensions`, el código de dispositivo de GitHub y el comando de VS Code
con copiar/pegar la sesión). Además:

- el tour exigía la GitHub App aunque el túnel no la usa (solo usa el OAuth del estudiante
  para conocer su login, y la VM clona el repo público sin credenciales);
- al volver otro día reaparecía el tour: `refreshGithubAppStatus` borraba el setup
  completado y la URL del editor, que tampoco se guardaba de forma durable;
- cada inicio de sesión en el navegador desactivaba **todas** las sesiones del usuario, así
  que la sesión pegada en VS Code moría en silencio y sus eventos quedaban anónimos
  (regla D2 del dataset del piloto);
- con la VM de editores apagada, «Preparar entorno» cortaba con un error.

## Objetivo

| Momento | Antes | Después |
|---|---|---|
| Primera vez, túnel | ~20-25 clics, F1 + comando + pegar | ~10 clics + pegar el código de dispositivo (inevitable, una vez) |
| Volver otro día, túnel | 3-4 clics + a veces rehacer todo | 1 clic («Abrir mi editor») o el marcador de vscode.dev |
| Mac del laboratorio | instalar VSIX por comando, clonar, F1 + pegar | doble clic una vez por equipo; luego 1 botón que clona/abre y vincula |
| Docente, iniciar clase | 10-15 comandos en 4 lugares | `deploy/clase.sh iniciar` en Cloud Shell (y `terminar`) |

## 1. Sesiones por tipo (backend)

`app_sessions` gana tres columnas (migración con `alter table ... add column if not exists`):

| Columna | Tipo | Uso |
|---|---|---|
| `kind` | `text not null default 'browser'` | `browser`, `editor` o `cli` |
| `expires_at` | `timestamptz null` | vencimiento; `null` = sin vencimiento (compatibilidad) |
| `label` | `text null` | origen legible: `tunnel`, `vscode-local`, `github`, `codigo` |

Reglas:

- Un inicio de sesión (`/api/auth/login`, `/api/auth/google-login`) desactiva solo las
  sesiones anteriores **del mismo tipo** (`browser` por defecto). El cuerpo puede pedir
  `sessionKind: "cli"` (lo usan los scripts de consola), que desactiva solo las `cli`.
- Las sesiones `editor` vencen a los 30 días (`EDITOR_SESSION_TTL_DAYS`, por defecto 30).
  `getSession` rechaza las vencidas.
- `POST /api/auth/logout` desactiva la sesión actual **y** las sesiones `editor` del mismo
  usuario (equipos compartidos: salir en el navegador desvincula también VS Code). En el
  túnel el siguiente «Abrir mi editor» vuelve a escribir una sesión nueva en la VM, y en la
  Mac el botón vuelve a vincular; no hay pasos nuevos para el estudiante.
- Toda respuesta a una petición que trae `x-session-id` inválido, inactivo o vencido lleva
  la cabecera `x-adaceen-session: invalid` (las rutas que aceptan anónimos siguen
  respondiendo como anónimo; las que exigen sesión siguen dando 401). La cabecera se expone
  por CORS (`Access-Control-Expose-Headers`).

## 2. Emparejar VS Code sin copiar/pegar (backend)

### 2.1 Código de un solo uso

```
POST /api/auth/editor/pairing-code          (requiere sesión browser activa)
  -> 200 { ok, code: "K7P4-M2QX", expiresAt, ttlSeconds: 600 }

POST /api/auth/editor/claim                 (sin sesión)
  { code, editorHost?: "local"|"tunnel"|"codespaces"|"remote"|"web", label? }
  -> 200 { ok, sessionId, expiresAt, user: { id, role, email, displayName } }
  -> 400 { ok:false, error:"invalid_code" }          formato inválido
  -> 404 { ok:false, error:"code_not_found" }        no existe, ya usado o vencido
  -> 429 { ok:false, error:"too_many_attempts" }     más de 20 intentos/min por IP
```

- Código: 8 caracteres de `ABCDEFGHJKMNPQRSTUVWXYZ23456789` en dos grupos (`XXXX-XXXX`);
  al canjear se normaliza (mayúsculas, sin guion ni espacios).
- Se guarda solo el SHA-256 del código normalizado en `editor_pairing_codes`
  (`code_hash text primary key, user_id, created_at, expires_at, used_at`). Pedir un
  código nuevo invalida los no usados del mismo usuario. Canjear es atómico
  (`update ... set used_at = now() where code_hash = $1 and used_at is null and
  expires_at > now() returning user_id`).
- El canje crea una sesión `editor` (label `codigo` o el que llegue).

### 2.2 Canje con la cuenta de GitHub de VS Code

```
POST /api/auth/editor/github                (sin sesión)
  { githubToken, editorHost? }
  -> 200 { ok, sessionId, expiresAt, user, githubLogin }
  -> 400 { ok:false, error:"missing_token" }
  -> 401 { ok:false, error:"github_token_invalid" }
  -> 404 { ok:false, error:"github_login_not_linked",
           message:"Conecta tu cuenta de GitHub en ADACEEN (overlay del navegador) y vuelve a intentar." }
  -> 429 { ok:false, error:"too_many_attempts" }
```

- El backend llama a `GET https://api.github.com/user` con el token (reutiliza el lector de
  login de `workspace-provider.ts`), toma `login` y busca el usuario de ADACEEN cuya fila de
  `github_user_tokens` tiene ese `account_login` (sin distinguir mayúsculas; si hay varias,
  la más reciente). Ese vínculo lo creó el propio OAuth de ADACEEN, así que el estudiante
  ya demostró que controla esa cuenta.
- El token de VS Code no se guarda ni se registra en logs.

### 2.3 Sesión escrita por la VM (túnel, cero clics)

`POST /api/workspaces/prepare` crea (o reutiliza si le quedan más de 7 días) una sesión
`editor` con label `tunnel` para el usuario y la manda al agente de la VM en el cuerpo:

```
POST /workspaces   (agente de la VM, directo o por relay)
{ login, repo, force, editorSession?: {
    sessionId, backendUrl, expiresAt, userName, userEmail } }
```

El agente la escribe **siempre** que llega (también si el túnel ya estaba `ready` o
esperando código) en `/home/ws-<login>/.adaceen/editor-session.json`, carpeta `0700` y
archivo `0600`, dueño `ws-<login>`, con escritura atómica (archivo temporal + rename):

```json
{ "version": 1, "sessionId": "…", "backendUrl": "https://…", "expiresAt": "ISO",
  "userName": "…", "userEmail": "…", "writtenAt": "ISO" }
```

`backendUrl` sale de `PUBLIC_BASE_URL` (o de la URL de la petición si no está definida).
El agente nunca devuelve ni registra el `sessionId`.

## 3. Extensión de VS Code 0.0.31

Orden para resolver la sesión:

1. SecretStorage `adaceen.editorSession` (sesiones emparejadas).
2. `~/.adaceen/editor-session.json` (túnel). Se relee al arrancar, cuando el backend
   responde `x-adaceen-session: invalid` y cuando el archivo cambia.
3. Ajuste heredado `adaceen.backend.sessionId` y variable `ADACEEN_SESSION_ID`
   (compatibilidad; «Configurar sesión compartida» sigue existiendo).

Sin sesión válida:

- Al arrancar intenta en silencio `vscode.authentication.getSession('github',
  ['read:user'], { silent: true })` y, si hay sesión, la canjea (2.2): cero clics cuando
  la extensión ya tenía permiso.
- Barra de estado: «ADACEEN: sin conectar» → clic → «ADACEEN: Conectar» (comando
  `adaceen.connect`) con tres opciones: «Con mi cuenta de GitHub (recomendado)»
  (`createIfNone`, un clic en «Permitir»), «Tengo un código del navegador» (acepta el
  código `XXXX-XXXX` o, por compatibilidad, el UUID de «Copiar sesion») y «Pegar sesión».
- Una advertencia única por ventana cuando la sesión deja de valer, con botón «Conectar».

URI handler (VS Code de escritorio, Mac del laboratorio):

```
vscode://adaceen.adaceen/abrir?code=XXXX-XXXX&repo=owner/repo
vscode://adaceen.adaceen/conectar?code=XXXX-XXXX
```

- Canjea el código (2.1) contra el backend **ya resuelto** por la extensión; un parámetro
  `backend` en el enlace se ignora salvo que coincida con ese backend (evita que un enlace
  malicioso desvíe el código del estudiante a otro servidor).
- Con `repo`: si ya se clonó en este equipo (mapa repo → carpeta en `globalState` y la
  carpeta existe) abre esa carpeta; si no, pide la carpeta padre, clona
  `https://github.com/<owner>/<repo>.git` y la abre. Si `git` no está, lo explica y ofrece
  el comando de instalación.

## 4. Extensión de navegador 0.7.11

- Con el proveedor `tunnel` el tour no pide la GitHub App: el paso único es «Conectar
  GitHub»; al volver del OAuth se prepara el editor solo. El sondeo de respaldo del OAuth
  usa `flow.userHasCodespaceScope` (que ya contempla el túnel), no el scope crudo.
- El setup completado y la URL del editor se guardan en `chrome.storage.local` por usuario
  y repo, y `refreshGithubAppStatus` ya no los borra con el túnel.
- Al volver: si hay sesión y editor guardado, el overlay entra directo (sin «Empezar») y
  ofrece «Abrir mi editor», que consulta `/api/workspaces/status` y abre (o prepara, que es
  idempotente).
- Errores transitorios del túnel (`retryable: true`, ver 5) no cortan la espera: la
  ventana sigue consultando y dice «Encendiendo la VM de editores…» o «El editor está
  apagado; avisa al docente».
- El login ya no viene precargado con la cuenta demo.
- «Abrir en VS Code de este equipo» pide un código (2.1) y abre
  `vscode://adaceen.adaceen/abrir?code=…&repo=…`; si falla, cae al enlace anterior
  (`vscode://vscode.git/clone`). «Copiar sesion» copia un código de un solo uso.
- `/empezar` del backend detecta la extensión con un content script mínimo propio.

## 5. Encendido automático de la VM de editores

Opcional, detrás de configuración (si falta, todo sigue igual):

| Variable | Ejemplo |
|---|---|
| `WORKSPACE_VM_AUTOSTART` | `gcp` |
| `WORKSPACE_VM_PROJECT` | `adaceen-…` |
| `WORKSPACE_VM_ZONE` | `us-central1-a` |
| `WORKSPACE_VM_NAME` | `adaceen-ws` |
| `GCP_SERVICE_ACCOUNT_JSON` | clave JSON (o base64) de una cuenta con solo `compute.instances.get/start` sobre esa VM |

Cuando `prepare`/`status` encuentran el agente desconectado, el backend pide
`instances.start` (como mucho una vez cada 2 minutos) y responde
`{ status: "pending", code: "vm_starting", retryable: true, message: "Encendiendo la VM de
editores (1-2 min)…" }`. Sin autoencendido responde `{ status: "error", code:
"agent_unreachable", retryable: true, message: "El editor está apagado. Avisa al docente;
esta ventana seguirá esperando." }`. `deploy/gcp/crear-cuenta-autoencendido.sh` crea la
cuenta de servicio con un rol mínimo y muestra cómo cargar la clave.

`WORKSPACE_ALLOWED_LOGINS=*` permite preparar editor a cualquier usuario activo de ADACEEN
con GitHub conectado (sin mantener la lista a mano).

## 6. Página de inicio `/empezar`

HTML servido por el backend, sin dependencias externas: descarga de la extensión de
navegador (`/descargas/adaceen-navegador.zip`), del VSIX (`/descargas/adaceen.vsix`) y del
instalador de Mac para estudiantes; instrucciones de 4 pasos para cargar la extensión;
detección de la extensión instalada; estado del servicio (editor y modelo) leído de
`/api/health`. El workflow de despliegue empaqueta esos archivos.

## 7. Desviaciones de la implementación

Lo implementado difiere del texto anterior en estos puntos (desviaciones mínimas, cada
una con su prueba):

- **Backend.** `backendUrl` sale de `PUBLIC_BASE_URL`, si no de `PUBLIC_API_URL` y, si
  tampoco está, de la petición (`x-forwarded-proto/host`). Fuera de localhost y sin
  puerto propio se escribe siempre en `https`, porque el agente de la VM rechaza `http`
  hacia otras máquinas.
- **Backend.** `pairing-code` y el `editorSession` de `prepare` exigen la sesión en
  `x-session-id` (la cookie sola no basta: defensa CSRF). Una sesión `editor`/`cli` recibe
  403 `browser_session_required`.
- **Backend.** El límite de 20/min por IP cuenta solo los intentos fallidos, con cupos
  separados para `claim` y `github` (el laboratorio sale por una sola IP). `github` no
  cuenta el 404 `github_login_not_linked` y responde 502 `github_unavailable` si GitHub
  no contesta.
- **Backend.** `github` solo vincula estudiantes: un docente o administrador recibe 404
  `github_login_not_linked` con `reason: "staff_requires_code"` y se vincula con el código.
- **Backend.** Las respuestas que entregan una sesión nueva (login, canje) no llevan
  `x-adaceen-session: invalid` aunque llegue un `x-session-id` viejo.
- **Backend.** `/status` reenvía una sola vez el `POST /workspaces` que no llegó al agente
  (VM apagada), así la espera termina sola cuando la VM vuelve. Con la VM en `STOPPING` no
  se vuelve a encender durante 15 minutos (`clase.sh terminar`).
- **Backend.** Con el editor `ready`, `/status` reenvía el `POST /workspaces` (sin
  `force`, con `editorSession`) si el usuario no tiene una sesión `tunnel` que `prepare`
  reutilizaría, y espera la respuesta del agente antes de contestar. Cubre «Salir» en otro
  navegador (hallazgo 5a): ese navegador no marca su editor guardado y su «Abrir mi
  editor» solo consulta `status`. Solo con la sesión en `x-session-id`; si el reenvío
  falla, `status` responde igual que antes.
- **Backend.** Se conservan las 10 sesiones `editor` más recientes por usuario (siempre
  la `tunnel` más reciente). Dos `pairing-code` simultáneos del mismo usuario pueden dejar
  dos códigos válidos (mismo usuario, un solo uso, 10 minutos).
- **Agente de la VM.** Una `editorSession` con `sessionId` que no es UUID, `backendUrl`
  que no es `https` (o `http` local) o `expiresAt` vencido no se escribe (se registra el
  motivo sin el valor); el editor se prepara igual.
- **VS Code 0.0.31.** La sesión de SecretStorage solo se usa con el backend donde se
  obtuvo; en el túnel, un archivo escrito después de guardarla gana. Tras un rechazo del
  backend o «Desconectar» no se canjea GitHub en silencio hasta una conexión hecha a mano
  (equipos compartidos). «Configurar sesión compartida» guarda en SecretStorage, no en
  el ajuste.
- **Navegador 0.7.11.** Al volver otro día el overlay entra solo, sin pedir ayuda al tutor
  hasta la primera interacción (no infla la telemetría). «Abrir mi editor» va directo a
  `prepare` si se cerró sesión en ese navegador o el último `prepare` fue hace más de 7
  días; si se cerró sesión en otro, lo resuelve `/status` (ver Backend). La primera vez
  la ventana de espera es la del OAuth, que queda en el callback del backend (otro
  origen, no se puede escribir en ella): el progreso y los errores le llegan por
  `postMessage` (`ADACEEN_WAIT_UPDATE`, solo al origen del backend) y la página del
  callback los muestra como texto si vienen de la ventana que la abrió. `/empezar`
  en localhost solo se detecta con el paquete `--dev`.

## 8. Auditoría de redundancias (navegador 0.7.12 y VS Code 0.0.32)

Misma rama, 25 de septiembre de 2026. Se quitaron clics, botones y peticiones que se
repetían; el camino del túnel (sección 4) y Codespaces siguen funcionando. Contrato nuevo
entre backend y navegador (detalle en el [contrato de la API](contrato-api.md), secciones
2.5, 2.9, 2.10 y 2.11):

- **(a) Privacidad en el servidor.** `POST /api/auth/privacy-acceptance { version }`
  (exige sesión; solo versiones publicadas, hoy `2026-05-26`) responde
  `{ ok, privacy: { version, acceptedAt } }`. Login, `google-login` y `/api/auth/me`
  traen `privacy` (la versión más nueva aceptada por el usuario, o `null`). Si coincide
  con `ADACEEN_PRIVACY_POLICY_VERSION`, la extensión no muestra «Aceptar y continuar» en
  ningún navegador; con un backend sin la ruta (404) guarda solo en local, como antes.
  Tabla `user_privacy_acceptances` (una fila por usuario y versión); el retiro la borra.
- **(b) Piloto.** `PUT /api/pilot/block` sin grupos los asigna (como «Asignar grupos A y
  B», con 2 estudiantes activos o más) y responde `assignedAutomatically: true`, `added` y
  `message` con la semilla; el overlay agrega el `message` al estado.
- **(c) Quiz lanzado.** `POST /api/quiz/launches`, si la política no deja llegar el quiz,
  activa «Permitir mini quiz» y «Cuando yo lo lance a la clase», lo guarda y responde
  `autoEnabled: true`, `message` y `policy`; el overlay muestra el `message` y marca las
  casillas.
- **(d) GitHub App (Codespaces).** La página de retorno dice que se puede cerrar la
  pestaña. La extensión abre la instalación sin `opener` y consulta
  `/api/github-app/status` cada 4 s (5 min como máximo; cada tres consultas prueba
  `link-installation-auto`) y avanza sola, sin «Verificar acceso».

Navegador 0.7.12 (detalle en `browser-ext-prod/readme.md`):

- Sin «Empezar»: el icono abre el login sin sesión y entra directo con sesión.
- Túnel: sin GitHub App en la tuerca ni en las filas del contexto (quedan «ADACEEN»,
  «GitHub OAuth» y «Editor»), sin consultar `/api/github-app/status`; la vista se titula
  «Preparar tu editor». En otro navegador, si `GET /api/workspaces/status` responde
  `ready`, ofrece «Abrir mi editor» en vez del tour.
- `vscode.dev` sin textos de Codespaces; entra solo con sesión y editor guardado.
  «Copiar sesion» pasa a «Copiar codigo para VS Code» y se oculta con VS Code conectado.
- Codespaces con botón único («Autorizar GitHub App», «Conectar GitHub» o «Preparar
  entorno ADACEEN»), sin las tarjetas 2 y 3 ni el aviso de espera.
- Docente: entra al «Panel docente», no al tour; una sola casilla de mini quiz.
- Campus: acceso y bitácora verificados al entrar; una sola acción («Analizar Campus» y
  luego «Sincronizar agenda»).
- Un solo botón para cerrar sesión («Salir»); `popup/` y `content.js` borrados.

VS Code 0.0.32 (detalle en su `CHANGELOG.md`):

- «ADACEEN: Conectar» con una sola opción para escribir o pegar, «Tengo un código o
  sesión» (código `XXXX-XXXX` o el ID de sesión de antes); sin «Tengo un código del
  navegador» ni «Pegar sesión». «Configurar sesión compartida» abre la misma caja.
- El clic explícito del estudiante vale como la confirmación de `requireConfirmation` en
  cambios de hasta 5 líneas que no borran código; el diálogo queda para cambios más
  grandes, eliminaciones, aplicaciones automáticas y reemplazos del overlay viejos (más de
  10 minutos) o que no se encuentran donde se eligieron.
- Con la ventana flotante abierta, el CodeLens y la pista en línea no repiten «Aceptar
  ayuda».

Clics medidos con los content scripts reales (arnés de
`tests/scripts/browser-ext-flujo-tunel.test.ts`), de 0.7.11 a 0.7.12: primera vez por
túnel sin sesión 5 → 4; otro navegador con el editor ya preparado 5 → 3; `vscode.dev` con
el overlay fijado 1 → 0; Mac otro día 3 → 2; Codespaces con sesión 5 → 3 (más la
instalación y la autorización en GitHub); Campus hasta el análisis 4 → 2.
