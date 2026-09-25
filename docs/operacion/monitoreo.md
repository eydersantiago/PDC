# Monitoreo básico y alarma

| | |
|---|---|
| Jira | A15.4 · ADACEEN-125 |
| Código | `src/routes/health-routes.ts`, `src/routes/agent-routes.ts` (`/api/agent/*`), `src/services/worker-heartbeat.ts`, `scripts/service-bus-ollama-worker.ts` (`startHeartbeat`) |
| Relacionados | [Runbook](runbook.md), [contingencia](contingencia.md), `docs/gcp-worker-operacion.md` (rama `master`) |

## 1. Puntos de control

| Endpoint | Quién | Qué dice | Uso |
|---|---|---|---|
| `GET /api/health` (también `/health`) | Público | Modo (`queue`), colas configuradas y sus nombres, proveedor de base, GitHub App, Google, `telemetry_salt_configured`, `worker_heartbeat_configured`, `workspace_provider`. | Revisión antes de cada sesión. **Es el que debe usar el «Health check» del App Service** (no depende de la GPU). |
| `GET /api/agent/health` | Público | 200 `{ok, mode, alive_workers}`; en modo `queue` sin ningún worker vivo, **503** `{ok:false, reason:"sin_worker"}`. | Alarma de disponibilidad del tutor durante las sesiones. |
| `GET /api/agent/backend` | Público | Modo, último worker que atendió un trabajo, `listening[]` (cada worker con `workerId`, `alive`, `lastSeenAt`, `model`, `jobsProcessed`) y `alive_workers`. | Ver qué GPU está escuchando la cola. La barra de VS Code muestra «GPU: …» con esto. |
| `POST /api/agent/heartbeat` | Workers (`x-worker-token`) | 204 si el token coincide; 401 si no; 503 si el servidor no tiene `WORKER_HEARTBEAT_TOKEN`. | Latido cada 30 s (`WORKER_HEARTBEAT_INTERVAL_MS`). |
| `GET /api/telemetry/quality` | Docente o administrador | Eventos perdidos por huecos de `seq`, duplicados, orden y avisos de calidad. | Revisión después de cada sesión. |

Un worker cuenta como vivo si su último latido tiene menos de
`WORKER_HEARTBEAT_STALE_MS` (120 s por defecto). El registro de latidos vive en
la memoria del App Service: tras un reinicio, los workers reaparecen con su
siguiente latido (≤ 30 s). Mientras haya latidos registrados y ninguno esté
vivo, el backend **no encola** trabajos: responde en segundos en modo degradado
en vez de esperar el timeout de la cola (120 s).

## 2. Métricas mínimas

Durante y después de cada sesión. Las consultas son de solo lectura sobre la
base del piloto (o sobre una exportación).

| Métrica | Cómo | Alerta si |
|---|---|---|
| Workers vivos | `GET /api/agent/backend` → `alive_workers` | 0 durante la sesión |
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
| Worker GPU | `/var/log/adaceen-worker.log` en la VM | Sin rotación configurada (por verificar) | `gcloud compute ssh <vm> --zone=us-central1-a --tunnel-through-iap --command='sudo tail -f /var/log/adaceen-worker.log'` |
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
