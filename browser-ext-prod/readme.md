## GitHub Mentor - Extension MV3 (Con backend)

Extension para Chrome/Edge que:
- lee la pestana activa en GitHub,
- extrae codigo visible cuando estas en `github.com/.../blob/...`,
- detecta Codespaces (`github.dev` o `*.github.dev`) y muestra bienvenida,
- tiene interruptor Encendido/Apagado,
- consume backend `agente-proxy-azure` por `POST /github-mentor`,
- usa fallback local (heuristico) si backend no responde.

## Estructura del frontend

```text
popup/
  popup.html
  popup.css
  popup.js
  templates/

overlay/
  content-markup.js
  content-styles.js
  content-render.js
  templates/

services/
  backend.service.js
  auth.service.js
  github.service.js
  campus.service.js

state/
  preferences.state.js
  session.state.js
```

- `templates/`: piezas visuales reutilizables.
- `services/`: llamadas a backend, autenticacion, GitHub App y Campus.
- `state/`: preferencias persistidas y estado vivo del overlay.
- `overlay/content-render.js`: decide que vista mostrar segun el estado.

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
