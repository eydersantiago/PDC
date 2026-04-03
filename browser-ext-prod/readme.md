## GitHub Mentor - Extension MV3 (Con backend)

Extension para Chrome/Edge que:
- lee la pestana activa en GitHub,
- extrae codigo visible cuando estas en `github.com/.../blob/...`,
- detecta Codespaces (`github.dev` o `*.github.dev`) y muestra bienvenida,
- tiene interruptor Encendido/Apagado,
- consume backend `agente-proxy-azure` por `POST /github-mentor`,
- usa fallback local (heuristico) si backend no responde.

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

## 3) Flujo de uso

1. Abre un repo o archivo de codigo en GitHub.
2. Abre el popup y deja `Encendido`.
3. Pulsa `Actualizar analisis`.
4. Revisa:
   - Ideas para crear,
   - Que buscar en GitHub para reforzar,
   - Guia para crear repo y programar en Codespaces.

## 4) Deteccion de contexto

- `github_code`: URL con `/blob/` y codigo visible.
- `github_general`: repo/pagina GitHub sin archivo abierto.
- `codespace`: dominios `github.dev`, `*.github.dev`, `app.github.dev`, `*.app.github.dev`.
- `other`: cualquier otro sitio.

Cuando detecta Codespace, el popup muestra bienvenida y mensaje de inicio para programar.

## 5) Endpoint esperado en backend

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

## 6) Permisos usados

- `activeTab`, `tabs`: leer la pestana activa.
- `storage`: guardar estado del popup y URL del backend.
- `host_permissions`: GitHub/Codespaces y backend local/Azure.

## 7) Flujo estable con GitHub App

Ahora existe un **Tour de configuracion inicial** (antes del dashboard principal):

1. Confirmar o detectar el repositorio objetivo.
2. Pulsar `Conectar GitHub App`.
3. Pulsar `Verificar acceso`.
4. Pulsar `Crear PR en este repositorio` para branch + PR con `.devcontainer/devcontainer.json`.
5. Al completar ese tour, se habilita el dashboard principal.

Endpoints usados:
- `GET /api/github-app/status`
- `POST /api/github-app/install-url`
- `GET /api/github-app/callback`
- `POST /api/github-app/bootstrap-devcontainer`
