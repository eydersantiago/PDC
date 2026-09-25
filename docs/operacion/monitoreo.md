# Monitoreo básico y alarma

| | |
|---|---|
| Jira | A15.4 · ADACEEN-125 |
| Código | `src/routes/health-routes.ts`, `src/routes/agent-routes.ts` (`/api/agent/*`), `src/services/worker-heartbeat.ts`, `src/services/workspace-relay.ts`, `scripts/service-bus-ollama-worker.ts` (`startHeartbeat`), `scripts/evidencias-despliegue.ts`, `scripts/piloto-simulacro.ts` |
| Relacionados | [Runbook](runbook.md), [contingencia](contingencia.md), [Mac del laboratorio](worker-mac.md), `docs/gcp-worker-operacion.md` (rama `master`) |

## 1. Puntos de control

| Endpoint | Quién | Qué dice | Uso |
|---|---|---|---|
| `GET /api/health` (también `/health`) | Público | Modo (`queue`), colas configuradas y sus nombres, proveedor de base, GitHub App, Google, `telemetry_salt_configured`, `worker_heartbeat_configured`, `workspace_provider` y `workspace_agent_online`. Desde la tanda «acceso simplificado», también `workspace_agent_transport`, `workspace_vm_autostart`, `model_workers_alive` y `model_workers_known_down` (cuántos servidores del modelo mandan latido y si todos vencieron, sin nombres ni tokens). | Revisión antes de cada sesión. **Es el que debe usar el «Health check» del App Service** (no depende de la GPU). |
| `GET /api/agent/health` | Público | 200 `{ok, mode, alive_workers}`; en modo `queue` sin ningún worker vivo, **503** `{ok:false, reason:"sin_worker"}`. | Alarma de disponibilidad del tutor durante las sesiones. |
| `GET /api/agent/backend` | Público | Modo, último worker que atendió un trabajo, `listening[]` (cada worker con `id`, `label`, `alive`, `lastSeenAt`, `model`, `jobsProcessed`, `platform`, `concurrency` y `kinds`) y `alive_workers`. | Ver qué servidores de inferencia (GPU o Mac del laboratorio) están escuchando la cola. La barra de VS Code muestra «GPU: …» con esto y, en el recuadro, los servidores vivos. |
| `POST /api/agent/heartbeat` | Workers (`x-worker-token`) | 204 si el token coincide; 401 si no; 503 si el servidor no tiene `WORKER_HEARTBEAT_TOKEN`. | Latido cada 30 s (`WORKER_HEARTBEAT_INTERVAL_MS`). |
| `GET /api/telemetry/quality` | Docente o administrador | Eventos perdidos por huecos de `seq`, duplicados, orden y avisos de calidad. | Revisión después de cada sesión. |

Un worker cuenta como vivo si su último latido tiene menos de
`WORKER_HEARTBEAT_STALE_MS` (120 s por defecto). El registro de latidos vive en
la memoria del App Service: tras un reinicio, los workers reaparecen con su
siguiente latido (≤ 30 s). Mientras haya latidos registrados y ninguno esté
vivo, el backend **no encola** trabajos: responde en segundos en modo degradado
en vez de esperar el timeout de la cola (120 s).

El agente de la VM de editores cuenta como conectado (`workspace_agent_online`)
si sondeó el relay en los últimos 60 s (`src/services/workspace-relay.ts`).

Para guardar todo esto de una vez, con códigos HTTP y sin secretos:
`npm run evidencias:despliegue -- --backend <backend>` (sección 5).

## 2. Métricas mínimas

Durante y después de cada sesión. Las consultas son de solo lectura sobre la
base del piloto (o sobre una exportación).

| Métrica | Cómo | Alerta si |
|---|---|---|
| Workers vivos | `GET /api/agent/backend` → `alive_workers`; `npm run piloto:monitor` los agrupa por tipo | 0 durante la sesión |
| Servidores coherentes | `npm run piloto:monitor` | Modelos distintos entre servidores vivos, o ninguno que acepte imágenes |
| Latencia por servidor | Informe final: tabla «Servidor de inferencia» (sección 3); cada `tutor_decision` guarda `metadata.worker` | Un servidor con mediana mucho mayor que los demás (candidato a `--respaldo`) |
| Latencia p50/p95 del tutor | `npm run medir:latencia -- --desde-bd --desde=<inicio de la sesión>` (latencia registrada en cada `tutor_decision`) | p95 por encima del umbral que fije A3 |
| Respuestas degradadas | Consulta 1 (motivo `model_error_fallback`) | > 10 % de las decisiones de la sesión |
| Bloqueos por política | Consulta 1 (`blocked = true` por motivo) | Cambio brusco frente a la sesión anterior (revisar reglas) |
| Eventos perdidos | `GET /api/telemetry/quality` → `eventLoss.rate` | > 2 % (umbral sugerido; lo fija A3) |
| Errores del backend | Logs del App Service (`level":"error"`) | Cualquier ráfaga |

```sql
-- Consulta 1: decisiones de la sesión por canal, motivo y bloqueo
select channel, reason_code, blocked, count(*) as decisiones,
       percentile_cont(0.5) within group (order by latency_ms) as p50_ms,
       percentile_cont(0.95) within group (order by latency_ms) as p95_ms
from telemetry_events
where event_type = 'tutor_decision'
  and occurred_at >= '<inicio de la sesión>'
group by channel, reason_code, blocked
order by channel, decisiones desc;
```

## 3. Logs

| Log | Dónde | Retención | Cómo verlo |
|---|---|---|---|
| Backend (JSON estructurado) | App Service → Registro de App Service | 12 h con el registro en sistema de archivos | `az webapp log tail --name app-adaceen-api-eyder05232002 --resource-group <grupo>` o «Secuencia de registro» en el portal |
| Worker GPU | `/var/log/adaceen-worker.log` en la VM | logrotate a los 50 MB, 5 copias comprimidas, revisado cada hora (`adaceen-logrotate.timer`); lo instala el `startup-script.sh` nuevo (`deploy/gcp/actualizar-gpus.sh`) | `gcloud compute ssh <vm> --zone=us-central1-a --tunnel-through-iap --command='sudo tail -f /var/log/adaceen-worker.log'` |
| Arranque de la VM de GPU | `/var/log/adaceen-startup.log` | Igual | Buscar la última línea `=== listo. worker=... ===` |
| VM de editores y agente | `journalctl -u adaceen-workspaces-agent` y `adaceen-tunnel@ws-<login>` | Journal de systemd | `gcloud compute ssh adaceen-ws …` |

El log del worker solo tiene tamaños y hashes de los prompts, no su contenido.
Para buscar los últimos trabajos: `sudo grep -a -E "queue.job.process.done|queue.result.send.done" /var/log/adaceen-worker.log | tail -5`
(el `-a` es necesario porque el log tiene bytes de control).

## 4. Alarma simple

La GPU se apaga fuera de clase por diseño, así que la disponibilidad del tutor
(`/api/agent/health`) solo se vigila **durante las sesiones**. El resto se
vigila siempre. Son cuatro piezas; las tres primeras ya están en el repositorio.

| Pieza | Qué vigila | Cuándo | Cómo se activa |
|---|---|---|---|
| **a) Monitor del piloto** (`npm run piloto:monitor`) | Worker vivo, bloque vigente, estudiantes activos, latencia p50 de los últimos 10 min, respuestas sin fallo, eventos perdidos, duplicados, clientes sin sesión y la VM de editores conectada al relay | Toda la sesión, en la terminal de quien opera | `npm run piloto:monitor -- --url=<backend> --email=<docente> --password=<clave> --desde=<inicio>`; deja `exportes/monitor-<fecha>.jsonl` como evidencia |
| **b) Alertas de Azure Monitor** (`deploy/azure/crear-alertas.sh`) | Respuestas 5xx (> 5 en 5 min), health check del App Service sobre `/api/health`, tiempo de respuesta promedio > 10 s | Siempre | Una vez: `RG=<grupo> CORREO=<correo> bash deploy/azure/crear-alertas.sh` (con `az login`; se puede correr desde Cloud Shell). Crea el grupo de acciones `adaceen-alertas`, activa el health check y las tres alertas; si ya existen, las actualiza |
| **c) Revisión programada en GitHub Actions** (`.github/workflows/salud-produccion.yml`) | `/api/health` cada 15 min (base PostgreSQL, sal configurada, cola); con la variable `ADACEEN_PILOTO_EN_SESION=true`, también `/api/agent/health` | Siempre; el worker solo en sesión | Corre desde la rama por defecto. GitHub avisa por correo cuando falla (a quien editó el flujo por última vez). Encender la variable al empezar la sesión y apagarla al terminar |
| d) Prueba de disponibilidad de Application Insights | `/api/agent/health` desde fuera | Opcional | Solo si hay Application Insights; ver el portal (Disponibilidad → prueba estándar) |

**Por qué el health check del App Service usa `/api/health` y no
`/api/agent/health`:** con la GPU apagada, `/api/agent/health` responde 503 y
el App Service creería que la instancia está mal y la reiniciaría.

**Qué hacer con cada alerta:** ver la tabla de síntomas del
[runbook](runbook.md) y el [plan de contingencia](contingencia.md); durante el
piloto, el [plan de soporte](../piloto/plan-de-soporte.md) dice quién responde y
en cuánto tiempo.

## 5. Evidencia del despliegue y simulacro

Dos comandos convierten en evidencia lo que antes se sacaba a mano con `curl`.
Ninguno apaga, enciende ni cambia configuración en Azure o en Google Cloud. El
simulacro solo hace `GET`; `evidencias:despliegue`, con credenciales o con
`--cumplimiento`, además inicia sesiones de consola (ver abajo).

### Evidencias de un despliegue

```bash
npm run evidencias:despliegue -- --backend <backend> [--salida <carpeta>] [--timeout <s>] [--cumplimiento]
```

| Qué | De dónde |
|---|---|
| Configuración sana del backend | `GET /api/health` (todos los campos, en tabla) |
| Servidores del modelo y latidos | `GET /api/agent/backend` (`listening[]`: id, etiqueta, vivo, último latido, modelo, plataforma, tipos, trabajos) y `GET /api/agent/health` |
| Página de inicio y descargas | `GET /empezar` y `HEAD` de `/descargas/adaceen-navegador.zip`, `/descargas/adaceen.vsix`, `/descargas/Preparar-Mac-ADACEEN.zip` y `/descargas/Preparar-Mac-ADACEEN.command` (código HTTP y tamaño; si el servidor no acepta `HEAD`, descarga y cuenta) |
| Versión publicada | Las versiones que muestra `/empezar`, comparadas con `browser-ext-prod/manifest.json` y `vscode-ext-prod/package.json` del repositorio local, y si `/api/health` ya trae los campos de la tanda «acceso simplificado». El backend no publica su commit: se anota desde GitHub Actions |
| Estado del piloto | `GET /api/pilot` con la cuenta de docente: bloque, descripción y cuántos hay en A, B y sin asignar (sin la lista de estudiantes). Solo contra un backend con la tanda «acceso simplificado» |
| Verificación de cumplimiento | Las comprobaciones automáticas de `npm run piloto:verificar` (repositorio y backend). La de la sesión de VS Code (C24) queda «no verificado», porque hace «Salir» con la cuenta usada: se corre con `piloto:verificar` y una cuenta de prueba. C25 se revisa solo en el código |

- **Credenciales de docente** (opcionales): `ADACEEN_DOCENTE_EMAIL` y
  `ADACEEN_DOCENTE_PASSWORD`, en el entorno o en `.env`. La clave no se acepta
  en la línea de comandos. El inicio de sesión es de consola (`sessionKind: "cli"`,
  como `scripts/lib/cli.ts`): reemplaza las otras sesiones de consola del
  docente (`piloto:monitor` vuelve a entrar solo), pero no la del navegador ni la
  de VS Code. Con credenciales también corre la verificación de cumplimiento;
  sin ellas, solo con `--cumplimiento`.
- **Contra un backend anterior a la tanda** (sin `workspace_agent_transport` ni
  `model_workers_alive` en `/api/health`, como producción en `9f51643`) no inicia
  sesión como docente: ese backend ignora `sessionKind` y su inicio de sesión
  cierra todas las sesiones de la cuenta, también la del navegador y la de VS
  Code. El estado del piloto sale como aviso. Aun así, lo más seguro es correrlo
  sin `ADACEEN_DOCENTE_EMAIL` ni `ADACEEN_DOCENTE_PASSWORD` antes de desplegar.
- **Salida:** `exportes/evidencias-despliegue/<fecha UTC>/evidencias.md` y
  `evidencias.json` (con `--salida` cambia la carpeta base; si ya existe una del
  mismo minuto, crea `<fecha>-2`). `exportes/` no se versiona.
- **Sin secretos:** todo pasa por un filtro que cambia por `[redactado]` los
  valores de claves como `token`, `secret`, `password`, `clave` o `sessionId` y
  los textos con forma de token (JWT, tokens de GitHub, `Bearer`, `clave=valor`
  de URLs y cadenas de conexión, UUID, hex o base64 largos). Revisa igual el
  archivo antes de adjuntarlo.
- **Código de salida 1** si alguna comprobación falla.

| Comprobación | Falla si | Aviso si |
|---|---|---|
| `/api/health` responde | no da 200 con `ok: true` | — |
| Tanda «acceso simplificado» | faltan `workspace_agent_transport` y `model_workers_alive` | — |
| Base, sal y cola | `database_provider` no es `postgres`, `telemetry_salt_configured: false`, o modo `queue` sin cola (lo mismo que revisa `salud-produccion.yml`) | el backend no informa el campo |
| Latidos | — | `worker_heartbeat_configured: false` |
| Servidores del modelo vivos | — | ninguno (normal fuera de clase: la GPU se apaga por diseño) |
| VM de editores conectada | — | proveedor `tunnel` con `workspace_agent_online: false` (normal con la VM apagada) |
| `/empezar`, zip del navegador y VSIX | no dan 200 | — |
| Instalador de Mac | — | ni el `.zip` ni el `.command` dan 200 |
| Versiones publicadas | — | distintas de las del repositorio local, o `/empezar` no las muestra |
| HTTPS | — | la URL del backend no es `https://` |
| Piloto (con credenciales) | no se pudo iniciar sesión | `/api/pilot` no da 200, hay estudiantes sin cohorte, o el backend es anterior a la tanda y no se inició sesión |
| Cumplimiento | algún crítico automático no cumple | — |

Contra un backend anterior a la tanda «acceso simplificado» (producción en
`9f51643`), lo esperado es que fallen la comprobación de la tanda, `/empezar` y
las descargas, porque esas rutas y campos son nuevos, y que los campos que ese
backend no informa salgan como aviso. Con credenciales o `--cumplimiento` también
falla «Verificación de cumplimiento»: C02, que es crítico, no encuentra
`telemetry_salt_configured` en `/api/health`.

### Simulacro de contingencia

`npm run piloto:simulacro -- --backend <backend> --escenario gpu|editor|azure`
es la guía con cronómetro de la sección 9 del [plan de contingencia](contingencia.md).
Sondea `/api/health` cada 5 s y mide cuánto tarda este monitoreo en ver una
caída y una recuperación. Los tiempos esperados salen de lo que se explica en la
sección 1:

- La GPU se ve caída cuando vence su último latido (`WORKER_HEARTBEAT_STALE_MS`,
  120 s por defecto). Como el latido va cada 30 s y el worker no manda uno al
  detenerse, eso ocurre entre 90 y 120 s después de que se detiene.
- La VM de editores se ve desconectada 60 s después de su último sondeo al
  relay. Ese sondeo largo dura hasta 25 s, así que tarda entre 60 y 85 s.

El simulacro mide desde el Enter del operador, así que su meta suma 30 s de
margen para que el comando llegue a la VM (un margen estimado, no medido) y el
intervalo de consulta: ≤ 2 min 35 s con la GPU y ≤ 2 min con la VM de editores
([contingencia](contingencia.md), sección 9).

