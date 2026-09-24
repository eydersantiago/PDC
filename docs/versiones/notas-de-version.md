# Notas de versión

| | |
|---|---|
| Jira | A15.9 · ADACEEN-149 (empaquetado, decisión sobre Firefox, VSIX y notas de versión) |
| Evidencias de cada despliegue | [evidencias-despliegue.md](../operacion/evidencias-despliegue.md) |

## Entrega del 24 de septiembre de 2026 (rama `feat/cierre-pendientes-jira`)

| Componente | Versión | Base |
|---|---|---|
| Extensión de navegador | **0.7.8** (2026-09-24) | Línea de despliegue `feature/azure-config-observability` (0.7.5, commit `9f51643`) |
| Extensión de VS Code | **0.0.28** (2026-09-24) | `feat/quiz-panel` (0.0.27, commit `ff298f2`) |
| Backend y worker | Rama `feat/cierre-pendientes-jira` | `9f51643` |
| Esquema de telemetría | 1.1 | — |
| Modelo | `qwen2.5-coder:14b` en Ollama | — |

> **Divergencia con `master`.** `master` tiene 12 commits que no están en la
> línea de despliegue (división del overlay en módulos, sistema de diseño,
> extensión 0.7.7). Esta entrega sale de la línea de despliegue, así que **no
> incluye** esos cambios; se numeró 0.7.8 para no repetir el 0.7.7 de `master`.
> Los iconos se tomaron de `master` (ya redimensionados), por eso no chocan al
> fusionar. Al unir las dos líneas hay que resolver conflictos en el overlay.

### Decisión sobre Firefox

**Se soporta Firefox**, con una limitación declarada:

- La extensión funciona en Firefox (el dueño del proyecto la instaló y la usó).
  `npm run empaquetar:extension` genera un paquete propio para Firefox con el
  mismo código, `browser_specific_settings.gecko` (id `adaceen@univalle.edu.co`,
  Firefox 128 o superior) y `background.scripts`.
- **Limitación:** en Firefox no hay inicio de sesión con Google ni sincronización
  con Google Calendar, porque dependen de `chrome.identity.getAuthToken`, que
  Firefox no implementa. Se entra con correo y contraseña de ADACEEN. Pasar esas
  dos funciones a `identity.launchWebAuthFlow` queda como mejora futura.
- **Instalación:** como complemento temporal desde `about:debugging` (se quita
  al cerrar Firefox). Una instalación permanente necesita firmar el paquete en
  addons.mozilla.org (no hecho).

Esta decisión reemplaza lo que decía el informe de brechas del 23 de septiembre
(«solo Chromium»).

### Empaquetado

| Paquete | Cómo se genera | Salida |
|---|---|---|
| Extensión de navegador | `npm run empaquetar:extension` (producción) o `npm run empaquetar:extension:dev` (agrega el backend local) | `dist/extension/adaceen-chromium-<versión>.zip`, `adaceen-firefox-<versión>.zip` y `SHA256SUMS.txt` |
| Extensión de VS Code | `npm run package` y `npx @vscode/vsce package` en `vscode-ext-prod` | `adaceen-<versión>.vsix` |

- El empaquetado de la extensión de navegador es reproducible: sin
  dependencias, fecha de las entradas fija (`SOURCE_DATE_EPOCH` o la fecha de
  `version_name`) y verificación de cada zip (vuelve a leerlo y compara CRC y
  tamaño). Con las mismas fuentes, el zip sale idéntico byte a byte.
- Paquetes de esta entrega (2,66 MiB cada uno; antes 11,7 MiB por los iconos sin
  redimensionar):

  ```text
  b1493b2ab62072d1744723c6833fb9c98d2af8c840d2bc52534c5579d87d175f  adaceen-chromium-0.7.8.zip
  30eb243ecb7981ece80ef766c7dac7d6ccdbdced7bc287cb54ef1e5601fa469e  adaceen-firefox-0.7.8.zip
  ```

- La extensión de VS Code no está publicada en el Marketplace desde esta
  entrega: la VM de editores instala `/opt/adaceen/adaceen.vsix` si existe (si
  no, `adaceen.adaceen` del Marketplace). Publicarla queda para cuando esté
  probada en más de una máquina.

### Cambios

**Backend**

- Motor de políticas en VS Code (A9.10): `/suggest-tab` clasifica el evento,
  aplica la regla del docente, gradúa la ayuda y registra cada decisión;
  `POST /api/suggestions/apply-check` limita y registra la aplicación de código (A10.8).
- Plantillas de intervención con límites de código por etapa y guardarraíl
  anti-solución que quita «Aplicar:» si el código se recortó (A8.3, A8.4, A10.1, A10.2).
- La etapa de ayuda respeta las intervenciones habilitadas por el docente, y el
  resultado de aprendizaje de la política llega al modelo.
- Matriz escenario → recurso autorizado (A8.6) y banco de 17 preguntas validadas
  para el mini-quiz cuando no hay modelo (A8.5).
- Telemetría v1.1 (A4.x, A7.x): tabla única `telemetry_events` con actor
  seudonimizado, hashes en lugar de textos, reglas de calidad, integridad por
  `seq`, exportación y revisión de calidad para docentes, catálogo público y
  retención.
- Latido de los workers, `/api/agent/health` (503 sin worker) y modo degradado:
  sin workers vivos no se encola y el tutor responde controlado en segundos (A15.4, A12.10).
- `/api/health` informa si la sal de telemetría y el token de latido están configurados.
- Entornos por túnel: proveedor `tunnel`, rutas `/api/workspaces/*` y agente de
  la VM de editores (A15.3).
- Detección del overlay: «diagrama» ya no se toma como «rama»; más errores de
  compilación de C++ reconocidos; un error visible cuenta como consulta del curso.
- Seguridad: los enlaces del visor de fuentes ya no llevan el `sessionId`; las
  citas del material no rompen los bloques de código.
- Scripts: demo de escenarios, latencia, estabilidad de eventos, exportación,
  purga y diccionario de telemetría.

**Worker GPU**

- Latido cada 30 s al backend (`WORKER_HEARTBEAT_URL`, `WORKER_HEARTBEAT_TOKEN`;
  metadata `heartbeat-url` y `heartbeat-token` en las VMs).
- El resultado expira si nadie lo lee (antes quedaba hasta el TTL de la cola).

**Extensión de navegador 0.7.8**

- Telemetría v1.1 y señales de error y bloqueo; «Me sirvió» / «No me sirvió»;
  `Ctrl+Enter` para pedir ayuda.
- Ajustes del docente para aplicar código desde VS Code.
- Accesibilidad WCAG 2.1 AA en las vistas clave (A12.9), revisión de seguridad
  (A12.8) y permisos mínimos (A12.7): sin `tabs`, sin `localhost` ni comodines de
  `*.azurewebsites.net` en producción (la variante `-dev` agrega el backend local).
- Iconos redimensionados (los de `master`).

**Extensión de VS Code 0.0.28**

- Identidad unificada (`x-adaceen-client-id`), telemetría v1.1 con `seq`,
  señales de error y bloqueo, campos de política en `/suggest-tab`, guard de
  aplicación de código con confirmación y regla sin red, indicador «GPU: sin
  worker activo». Detalle en su `CHANGELOG.md`.
- 0.0.27 (en `feat/quiz-panel`): «Insertar debajo» ya no reemplaza el código.

### Configuración nueva en el App Service

`TELEMETRY_SALT` (obligatoria; no cambiarla durante el piloto),
`TELEMETRY_RETENTION_DAYS`, `WORKER_HEARTBEAT_TOKEN`, `WORKER_HEARTBEAT_STALE_MS`,
`ADACEEN_WORKSPACE_PROVIDER`, `WORKSPACE_AGENT_URL`, `WORKSPACE_AGENT_TOKEN`,
`WORKSPACE_AGENT_TIMEOUT_MS`, `WORKSPACE_ALLOWED_LOGINS`. Ver `.env.example`.

### Compatibilidad

- Base de datos: cambios aditivos (tabla `telemetry_events` y columna
  `code_application_settings`); una versión anterior del backend sigue
  funcionando con la base nueva.
- Las extensiones anteriores siguen funcionando con este backend: los eventos
  sin `schemaVersion` se guardan como 1.0 con un aviso de calidad.

### Verificación

`npm run build` y `npm test` (106 pruebas) en PDC; `npm run compile`,
`npm run lint` y `npm run test:unit` (54 pruebas) en vscode-ext-prod;
`npm run demo:escenarios` con todas las comprobaciones correctas.
