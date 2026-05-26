# ADACEEN con Azure Service Bus y workers Ollama

## Arquitectura

El backend `agente-proxy-azure` corre en Azure App Service y no ejecuta Ollama. Su responsabilidad es autenticar, validar, persistir jobs, publicar mensajes en Azure Service Bus y exponer endpoints para consultar estado.

Flujo MVP:

1. La extension llama al backend en App Service.
2. `POST /api/jobs` crea un registro `jobs` en PostgreSQL con `status=queued`.
3. El backend publica el mensaje en la cola `llm-jobs`.
4. Un worker local, en un computador con Ollama, consume `llm-jobs`.
5. El worker marca `running`, llama a Ollama local y publica el resultado en `llm-results`.
6. El backend consume `llm-results` y actualiza PostgreSQL. El worker tambien intenta avisar por HTTP interno como respaldo idempotente.
7. La extension consulta `GET /api/jobs/:jobId`.

## Variables en Azure App Service

```env
NODE_ENV=production
PORT=8080
LOG_LEVEL=info
DATABASE_URL=...
DATABASE_SSL_MODE=require
AZURE_SERVICEBUS_CONNECTION_STRING=...
JOBS_QUEUE_NAME=llm-jobs
RESULTS_QUEUE_NAME=llm-results
JWT_SECRET=...
AGENT_TARGET=queue
MAX_TAB_CONTENT_CHARS=12000
MAX_MENTOR_CODE_CHARS=6000
MAX_UPLOAD_BYTES=8388608
PUBLIC_API_URL=https://app-adaceen-api-eyder05232002.azurewebsites.net
APPLICATIONINSIGHTS_CONNECTION_STRING=...
WORKER_SHARED_SECRET=...
WEBSITE_WARMUP_PATH=/api/health
WEBSITE_WARMUP_STATUSES=200
```

`DATABASE_SSL_MODE` tambien puede quedar en `auto`; en ese caso el backend activa SSL si `DATABASE_URL` incluye `?sslmode=require`.

El backend responde health checks en `/health` y `/api/health`. En Azure App Service, `WEBSITE_WARMUP_PATH=/api/health` evita que el warm-up use la ruta por defecto `/robots933456.txt`.

`AZURE_SERVICEBUS_CONNECTION_STRING`, `DATABASE_URL` y `WORKER_SHARED_SECRET` nunca deben estar en la extension.

Cloudflare no es parte de la ruta de produccion. Para probar desde otro dispositivo usa la URL publica de Azure App Service. Cloudflare queda solo como tunel local opcional cuando `AGENT_TARGET=local`.

## Variables del worker local

```env
WORKER_ID=pc-central-gpu
WORKER_ROLE=local_gpu_coder
OLLAMA_BASE_URL=http://127.0.0.1:11434
AZURE_SERVICEBUS_CONNECTION_STRING=...
JOBS_QUEUE_NAME=llm-jobs
RESULTS_QUEUE_NAME=llm-results
OLLAMA_MODEL=qwen3-coder:30b
OLLAMA_CONTEXT=8192
OLLAMA_STATUS_TIMEOUT_MS=2500
OLLAMA_FAST_MODEL=qwen2.5-coder:7b
OLLAMA_FAST_CONTEXT=4096
OLLAMA_CLASSIFIER_MODEL=qwen2.5:7b
OLLAMA_CLASSIFIER_CONTEXT=4096
# OLLAMA_EXPERIMENTAL_MODEL=qwen3-coder-next
VRAM_GB=48
WORKER_MAX_CONCURRENCY=1
MAX_PARALLEL_JOBS=1
ADACEEN_API_URL=https://app-adaceen-api-eyder05232002.azurewebsites.net
WORKER_SHARED_SECRET=...
```

El worker carga `.env` y luego los valores no vacios de `.env.worker`; si una variable existe con valor en ambos, gana `.env.worker`. Para la URL del backend acepta `ADACEEN_API_URL`, `PUBLIC_API_URL` o `AZURE_SERVER_URL`, en ese orden.

El worker usa una arquitectura hibrida:

- `OLLAMA_MODEL` es el modelo principal para tutor de codigo, analisis de repositorios, errores, PRs e intervenciones complejas.
- `OLLAMA_FAST_MODEL` atiende tareas simples de resumen, extraccion e intencion cuando el job lo indique o el router detecte una tarea corta.
- `OLLAMA_CLASSIFIER_MODEL` atiende `document_classification` y tareas de clasificacion.
- `OLLAMA_EXPERIMENTAL_MODEL` queda reservado para pruebas como `qwen3-coder-next`; no lo uses como default estable.

`SUPPORTED_MODELS` es opcional. Si queda vacio, el worker lo calcula desde los modelos configurados. Si lo defines, el worker rechaza cualquier modelo fuera de esa lista y envia el job a dead-letter.

Con 3 GPUs de 16 GB, empieza con `WORKER_MAX_CONCURRENCY=1` y `OLLAMA_CONTEXT=8192`. `OLLAMA_NUM_PARALLEL=1` debe configurarse en el proceso que arranca `ollama serve`; el worker no expone Ollama ni debe cambiar infraestructura de Azure.

El heartbeat del worker reporta:

- VRAM total declarada por el worker (`VRAM_GB`).
- VRAM observada en modelos cargados por Ollama (`/api/ps`).
- modelos soportados y modelos cargados actualmente.

## Migraciones y backend

```bash
npm install
npm run db:migrate
npm run build
npm start
```

En App Service, el backend escucha `process.env.PORT`. En local, si `DATABASE_URL` esta vacio, usa PostgreSQL en memoria para el piloto.

## Worker Ollama

En desarrollo:

```bash
npm run dev:worker
```

Con build:

```bash
npm run build
npm run worker:ollama:prod
```

Ollama debe estar corriendo en el computador local y tener disponible el modelo configurado, por ejemplo:

```bash
ollama pull qwen3-coder:30b
ollama serve
```

Prueba local Node -> Ollama antes de tocar Service Bus:

```bash
npm run test:ollama
```

Para probar un auxiliar:

```bash
npm run test:ollama -- --route=fast
npm run test:ollama -- --route=classifier
```

## Pruebas rapidas

URL de produccion actual:

```bash
PUBLIC_API_URL=https://app-adaceen-api-eyder05232002.azurewebsites.net
PRIVACY_POLICY_URL=https://app-adaceen-api-eyder05232002.azurewebsites.net/privacy-policy
PRIVACY_POLICY_API_URL=https://app-adaceen-api-eyder05232002.azurewebsites.net/api/privacy-policy
```

Desde otro computador, primero valida que la pasarela publica responda:

```bash
curl "$PUBLIC_API_URL/api/health"
curl "$PRIVACY_POLICY_URL"
curl "$PRIVACY_POLICY_API_URL"
curl "$PUBLIC_API_URL/api/workers"
curl "$PUBLIC_API_URL/api/ollama/status?min_vram_gb=48&model=qwen3-coder:30b"
```

Crear job:

```bash
curl -X POST "$PUBLIC_API_URL/api/jobs" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "text",
    "model": "qwen2.5:7b-instruct",
    "input": "Explica encapsulamiento en POO con un ejemplo corto.",
    "minVramGb": 8
  }'
```

Consultar estado:

```bash
curl "$PUBLIC_API_URL/api/jobs/<job-id>"
```

Ver workers:

```bash
curl "$PUBLIC_API_URL/api/workers"
```

Ver estado Ollama/VRAM de la pasarela desde otro dispositivo:

```bash
curl "$PUBLIC_API_URL/api/ollama/status?min_vram_gb=48&model=qwen3-coder:30b"
```

Si quieres exigir que el modelo ya este cargado en VRAM:

```bash
curl "$PUBLIC_API_URL/api/ollama/status?min_vram_gb=48&min_loaded_vram_gb=1&model=qwen3-coder:30b&require_loaded_model=true"
```

Encolar una prueba real Azure -> Service Bus -> worker local:

```bash
curl -X POST "$PUBLIC_API_URL/api/ollama/smoke-test" \
  -H "Content-Type: application/json" \
  -H "x-worker-secret: $WORKER_SHARED_SECRET" \
  -d '{
    "modelRoute": "primary",
    "minVramGb": 48,
    "prompt": "Confirma que ADACEEN responde desde el worker local Ollama."
  }'
```

Luego consulta:

```bash
curl "$PUBLIC_API_URL/api/jobs/<job-id>"
```

Heartbeat manual:

```bash
curl -X POST "$PUBLIC_API_URL/api/workers/heartbeat" \
  -H "Content-Type: application/json" \
  -H "x-worker-secret: $WORKER_SHARED_SECRET" \
  -d '{
    "workerId": "control-local",
    "hostname": "equipo-local",
    "vramGb": 8,
    "supportedModels": ["qwen2.5:7b-instruct"],
    "maxParallelJobs": 1
  }'
```

## Logs de produccion

El backend y el worker escriben logs JSON a stdout. En Azure App Service se ven en Log Stream. Activa el log de aplicacion una vez:

```bash
az webapp log config \
  --resource-group rg-adaceen-azure \
  --name app-adaceen-api-eyder05232002 \
  --application-logging filesystem \
  --level information
```

Luego abre el stream mientras pruebas la extension desde el otro computador:

```bash
az webapp log tail \
  --resource-group rg-adaceen-azure \
  --name app-adaceen-api-eyder05232002
```

Eventos esperados:

- `http_request`: entro una solicitud al App Service. Revisa `path`, `status_code`, `origin` y `user_agent`.
- `github_mentor_job_enqueued` o `job_enqueued`: la solicitud de la extension se convirtio en job.
- `servicebus_job_sent`: el job entro a `llm-jobs`.
- `worker_heartbeat`: el worker local esta reportandose al backend.
- `job_running`, `job_completed` o `job_failed`: avance del job reportado por el worker.
- `servicebus_result_processed`: el backend consumio `llm-results`.

Si quieres ver solo los eventos clave:

```bash
az webapp log tail \
  --resource-group rg-adaceen-azure \
  --name app-adaceen-api-eyder05232002 \
  | grep -E '"event":"(http_request|github_mentor_job_enqueued|job_enqueued|servicebus_job_sent|worker_heartbeat|job_running|job_completed|job_failed|servicebus_result_processed)"'
```

Tambien conviene mirar la cola cuando algo quede en espera:

```bash
az servicebus queue show \
  --resource-group rg-adaceen-azure \
  --namespace-name sb-adaceen-eyder05232002 \
  --name llm-jobs \
  --query '{active:countDetails.activeMessageCount,dead:countDetails.deadLetterMessageCount,scheduled:countDetails.scheduledMessageCount}'
```

## Compatibilidad con `/github-mentor`

Con `AGENT_TARGET=queue`, `POST /github-mentor` ya no intenta ejecutar Ollama en Azure. Crea un job `kind=github_mentor` y responde:

```json
{
  "mode": "queue",
  "job_id": "...",
  "status": "queued"
}
```

Con `AGENT_TARGET=local` o `AGENT_TARGET=azure`, conserva el comportamiento anterior.

Para profesores, el `context` de `/intervene` y `/github-mentor` puede incluir estado de bitacora del Campus:

```json
{
  "bitacoraUploaded": false,
  "bitacoraStatus": "pending",
  "bitacoraUploadUrl": "https://campusvirtual.univalle.edu.co/...",
  "bitacoraUploadTitle": "Bitacora"
}
```

Cuando la sesion corresponde a un profesor y la bitacora aparece pendiente, la politica devuelve un mensaje controlado con el punto de subida en lugar de una intervencion pedagogica normal.

## Que no debe ir en la extension

La extension solo debe conocer la URL publica del backend y, si aplica, su token o sesion de usuario. No debe incluir:

- `AZURE_SERVICEBUS_CONNECTION_STRING`
- `DATABASE_URL`
- `WORKER_SHARED_SECRET`
- credenciales de PostgreSQL
- claves de Application Insights o infraestructura

## Cloudflare solo local

Cloudflare no debe reemplazar la pasarela de Azure para produccion ni pruebas remotas del piloto. Si se usa, debe ser solo como tunel local temporal para `AGENT_TARGET=local`.
