# Notas de versión

| | |
|---|---|
| Jira | A15.9 · ADACEEN-149 (empaquetado, decisión sobre Firefox, VSIX y notas de versión) |
| Evidencias de cada despliegue | [evidencias-despliegue.md](../operacion/evidencias-despliegue.md) |

## Mac del laboratorio del 24 de septiembre de 2026 (rama `feat/macs-laboratorio`)

| Componente | Versión | Base |
|---|---|---|
| Extensión de navegador | **0.7.10** (2026-09-24) | 0.7.9 (`feat/segunda-tanda-jira`, commit `2b66fdd`) |
| Extensión de VS Code | **0.0.30** (2026-09-24) | 0.0.29 (`feat/segunda-tanda-jira`, commit `9d1c999`) |
| Backend, worker y scripts | Rama `feat/macs-laboratorio` | `2b66fdd` |
| Esquema de telemetría | 1.1 sin cambios; metadata nueva: `worker` (en `tutor_decision`), `editorHost` y `editorUi` | — |

### Cambios

**Servidores de inferencia intercambiables (A15.10 · ADACEEN-151, decisión 4 del ADR)**

- Las Mac del laboratorio pueden atender la cola igual que la GPU de Google
  Cloud, a la vez o en su lugar. `deploy/mac/instalar-worker-mac.sh` deja Ollama y
  el worker como servicios de launchd. Los servicios se reinician si fallan, no
  dejan dormir la Mac y precargan el modelo. Los secretos van en
  `~/.adaceen/worker.env` (600). Operación diaria con `deploy/mac/worker-mac.sh`
  (`estado`, `iniciar`, `detener`, `logs`, `velocidad`, `desinstalar`). Guía:
  `docs/operacion/worker-mac.md`.
- Worker: `SERVICE_BUS_TRANSPORT=websockets` (AMQP dentro de WebSocket por el
  443, por el proxy HTTPS si existe; el latido también sale por el proxy),
  `QUEUE_WORKER_CONCURRENCY`, `QUEUE_WORKER_KINDS`, `QUEUE_WORKER_PRIORITY=backup`
  (una Mac lenta solo toma lo que la GPU no alcanza), `QUEUE_WORKER_WARMUP`
  (precarga del modelo al arrancar), `QUEUE_WORKER_READY_URL` (no toma trabajos
  mientras el modelo no está listo) y `ADACEEN_WORKER_ENV_FILE`.
- El latido informa plataforma, concurrencia y tipos de trabajo. Los ids
  `mac-lab…` se muestran como «Mac del laboratorio - M2», y los `mac-lab-cluster…`
  como «Clúster de Mac del laboratorio».
- Cada `tutor_decision` guarda qué servidor la atendió (`metadata.worker`). El
  informe del piloto trae la tabla de latencia por servidor, y el monitor agrupa
  los servidores vivos y avisa si usan modelos distintos o si ninguno acepta
  imágenes.
- Modo clúster: varias Mac juntan su memoria para correr un modelo más grande
  con llama.cpp RPC (`--rol=coordinador` y `--rol=nodo`). Exige una red aislada
  entre las Mac, porque el RPC no tiene autenticación, y es más lento que un
  modelo que cabe en una sola Mac.
- Rol `local`: el `npm run dev:local` de siempre como servicio, escuchando solo
  en `127.0.0.1` (`ADACEEN_LISTEN_HOST`).

**Editor en dos modos**

- VS Code 0.0.30: si en el equipo corre un backend local de ADACEEN, lo usa
  igual que antes. Si no, va a producción, así que VS Code instalado en las Mac
  del laboratorio funciona sin configurar nada. La telemetría registra
  `editorHost` y `editorUi`. Detalle en su `CHANGELOG.md`.
- Extensión de navegador 0.7.10: «Abrir en VS Code de este equipo» clona el
  repositorio en el VS Code local y copia la sesión compartida.

**Correcciones**

- El worker leía `src/config/env.ts` antes de cargar `.env.worker` por un import
  nuevo de esta misma rama: arrancaba sin la cadena de conexión. Se corrigió
  antes de entregar y quedó una prueba de regresión
  (`tests/scripts/worker-config.test.ts`).
- `docs/service-bus-ollama-worker.md` usaba nombres de cola viejos
  (`adaceen-jobs`); ahora usa `llm-jobs` y `llm-results-sessions`.

### Configuración nueva

- App Service: nada obligatorio. `SERVICE_BUS_TRANSPORT` se deja en `amqp`.
- Azure: una política de Service Bus propia de las Mac (`worker-mac`, Listen y
  Send), con el mismo `WORKER_HEARTBEAT_TOKEN` del App Service.

### Compatibilidad

- Base de datos y esquema de telemetría sin cambios. Un backend anterior
  descarta de la metadata `worker`, `editorHost` y `editorUi`.
- La GPU de Google Cloud sigue igual (`amqp`, `.env.worker`).
- VS Code: quien tenía escrito `adaceen.backend.baseUrl` conserva ese valor.

### Paquetes

```text
f67e912675f7234f771d54d479e15235b1f1404aafe8ff0f1c440ac46a9c83d6  adaceen-chromium-0.7.10.zip
befb7ab2925585f32c8554321dd78aff9485f8271434e2540e8e7124b6359933  adaceen-firefox-0.7.10.zip
517d7c47874cc4e5981bfe57a76beddd2b864a7a9309496154755e858482705e  adaceen-0.0.30.vsix
```

### Verificación

`npm test` (142 pruebas) y `npm run build` en PDC; `npm run compile`,
`npm run lint` y `npm run test:unit` (70 pruebas) en vscode-ext-prod;
ShellCheck sin avisos en `deploy/mac/`. Instalación completa probada en Linux
con un macOS de prueba (launchd, Ollama y llama.cpp simulados, worker y backend
reales): los roles servidor, local, nodo y coordinador, reinstalación, cambio de
rol, `estado`, `detener`, `iniciar` y `desinstalar`. Falta la prueba en una Mac
real del laboratorio.

## Segunda entrega del 24 de septiembre de 2026 (rama `feat/segunda-tanda-jira`)

| Componente | Versión | Base |
|---|---|---|
| Extensión de navegador | **0.7.9** (2026-09-24) | 0.7.8 (`feat/cierre-pendientes-jira`, commit `6c656ac`) |
| Extensión de VS Code | **0.0.29** (2026-09-24) | 0.0.28 (`feat/cierre-pendientes-jira`, commit `6cbcb7c`) |
| Backend y scripts | Rama `feat/segunda-tanda-jira` | `6c656ac` |
| Esquema de telemetría | 1.1, con `blocking_resolved` y las columnas del piloto | — |

### Cambios

**Piloto con y sin tutor (A13.1)**

- Diseño intra-sujeto AB/BA: el docente asigna al azar los grupos A y B y cambia
  de bloque desde el overlay (sección «Piloto con y sin tutor») o con
  `npm run piloto:bloque`. Rutas `GET /api/pilot`, `POST /api/pilot/assign`,
  `PUT /api/pilot/block` y `GET /api/pilot/me`; historial de bloques en la base.
- En el bloque sin tutor el motor responde un aviso sin llamar al modelo
  (`reasonCode: pilot_no_tutor`) y no deja aplicar código. Cada evento de
  telemetría de un estudiante lleva su bloque, cohorte y condición.

**KPIs y análisis (A3.1 a A3.6, A14.2 a A14.4, A14.7)**

- Catálogo de 25 KPIs con fórmula, fuente, umbral y origen
  (`docs/metricas/catalogo-kpis.md`, generado), cálculo en `src/services/kpis.ts`
  y KPIs en vivo en `GET /api/telemetry/kpis`.
- Scripts del piloto: `piloto:monitor` (en vivo), `piloto:dataset` (limpieza con
  reglas D1 a D5), `piloto:analisis` (informe con Wilcoxon, cruzado AB/BA,
  gráficas y trazabilidad), `piloto:simular` (ensayo técnico), `piloto:verificar`
  (lista de cumplimiento), `piloto:retiro` (retiro de un participante),
  `kpis:catalogo` y `quiz:revision`.
- Las decisiones de VS Code registran cuántas fuentes del material acompañan la
  respuesta (KPI T9).

**Entornos por túnel (A15.3)**

- Relay para la VM de editores sin IP pública: el agente sondea
  `GET /api/workspaces/agent/next` y responde en
  `POST /api/workspaces/agent/responses`, por HTTPS de salida y con
  `x-agent-token`. Es el modo por defecto si no hay `WORKSPACE_AGENT_URL`.
- `nuevo-tunel.sh`: la comprobación de la sesión del túnel ya no confunde
  «not logged in» con una sesión iniciada.

**Monitoreo (A15.4)**

- `deploy/azure/crear-alertas.sh` (alertas de Azure Monitor por 5xx, health check
  y tiempo de respuesta) y el flujo programado `salud-produccion.yml`.
- `/api/health` informa además la retención de la telemetría, la versión de la
  política de privacidad y si el agente de entornos está conectado.

**Extensión de VS Code 0.0.29**

- Evento `blocking_resolved`: fin de cada episodio de bloqueo con su duración
  (tiempo hasta desbloqueo, KPI P1). Detalle en su `CHANGELOG.md`.

**Extensión de navegador 0.7.9**

- Sección «Piloto con y sin tutor» para el docente, accesible.

**Correcciones**

- `readIntArg` (scripts) devolvía el mínimo permitido cuando faltaba la opción.
  Con eso, `npm run telemetria:purgar -- --confirmar` sin `--dias` habría
  borrado la telemetría de más de **un día** en lugar de usar
  `TELEMETRY_RETENTION_DAYS`, y `medir:latencia` sin `--n` habría tomado una
  sola muestra. Corregido con prueba de regresión. En la rama
  `feat/cierre-pendientes-jira` no hay que correr la purga sin `--dias`.
- El ensayo técnico usa ids fijos para las cuentas sintéticas: con la misma
  semilla da los mismos datos.

### Documentación nueva

Paquete de validación para el director y el docente, protocolo, instrumentos,
consentimiento, lista de cumplimiento, plan de soporte y análisis de datos del
piloto (`docs/piloto/`); vistas de la arquitectura (C4 y secuencias) y contrato
de la API verificado por prueba (`docs/arquitectura/`); revisión docente del
banco del quiz; evidencia del ensayo técnico.

### Configuración nueva en el App Service

`WORKSPACE_AGENT_TRANSPORT` (opcional: `relay` o `direct`). Para el relay basta
con `WORKSPACE_AGENT_TOKEN` sin `WORKSPACE_AGENT_URL`, y en la VM de editores la
metadata del relay (ver `docs/workspaces-tunnel.md`).

### Compatibilidad

- Base de datos: cambios aditivos (tres tablas del piloto y tres columnas en
  `telemetry_events`, con `add column if not exists`).
- Las extensiones 0.7.8 y 0.0.28 siguen funcionando con este backend; la 0.0.28
  no envía `blocking_resolved`, así que sin la 0.0.29 no hay P1.

### Paquetes

```text
2dc9b5dcd62c06d308d110c06a098cc71751fa22c847359360846de838d48048  adaceen-chromium-0.7.9.zip
77bd55fdc79886ad78987006a056d0990cb9e25e022fe6632e0ad3ca44e548d6  adaceen-firefox-0.7.9.zip
```

### Verificación

`npm test` (130 pruebas) y `npm run build` en PDC; `npm run compile`,
`npm run lint` y `npm run test:unit` (59 pruebas) en vscode-ext-prod;
`npm run piloto:simular` con 10 de 10 comprobaciones.

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
