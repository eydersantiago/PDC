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

La GPU se apaga fuera de clase por diseño, así que la alarma de
`/api/agent/health` solo tiene sentido **durante las sesiones**. Se proponen
dos piezas, que debe crear el dueño de la suscripción (estos comandos **no se
han ejecutado**; confirma los parámetros con `--help` antes de usarlos):

**a) Health check del App Service sobre `/api/health`** (reinicia instancias
que no responden; no depende de la GPU). Portal: App Service → Supervisión →
Comprobación de estado → ruta `/api/health`. No uses `/api/agent/health` aquí:
con la GPU apagada el App Service creería que la instancia está mal y la reiniciaría.

**b) Prueba de disponibilidad de Application Insights sobre `/api/agent/health`**
con alerta por correo, activada solo en horario de clase:

```bash
# Grupo de acciones con el correo de quien opera el piloto
az monitor action-group create --resource-group <grupo> --name adaceen-alertas \
  --short-name adaceen --action email operador <correo>

# Prueba estándar cada 5 minutos desde una ubicación (verificar nombres con --help)
az monitor app-insights web-test create --resource-group <grupo> --name adaceen-tutor-disponible \
  --location <región> --kind standard --enabled true --frequency 300 --timeout 30 \
  --defined-web-test-name adaceen-tutor-disponible \
  --request-url "https://app-adaceen-api-eyder05232002.azurewebsites.net/api/agent/health" \
  --http-verb GET --expected-status-code 200 --retry-enabled true \
  --locations Id="us-va-ash-azr" \
  --tags "hidden-link:/subscriptions/<suscripción>/resourceGroups/<grupo>/providers/microsoft.insights/components/<app-insights>=Resource"
```

Luego, en el portal: Application Insights → Disponibilidad → la prueba →
«Abrir reglas (alertas)» → asociar el grupo `adaceen-alertas`. Para activarla y
desactivarla alrededor de cada sesión:
`az monitor app-insights web-test update --resource-group <grupo> --name adaceen-tutor-disponible --enabled true|false`.

Sin Application Insights, una alternativa mínima es revisar
`/api/agent/health` en la lista de la sección 2 del runbook al inicio y a la
mitad de cada sesión.
