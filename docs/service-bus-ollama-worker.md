# ADACEEN Queue Mode: App Service + Service Bus + Ollama local

Este modo permite que el App Service productivo reciba solicitudes HTTP y delegue la inferencia a un worker local con Ollama/GPU usando Azure Service Bus.

## App Service

Configura estas variables:

```env
AGENT_TARGET=queue
AZURE_SERVICEBUS_CONNECTION_STRING=<connection-string>
JOBS_QUEUE_NAME=adaceen-jobs
RESULTS_QUEUE_NAME=adaceen-results
WORKER_SHARED_SECRET=<secreto-compartido>
QUEUE_REQUEST_TIMEOUT_MS=120000
ADACEEN_LOG_LEVEL=info
ADACEEN_LOG_STACKS=0
```

Notas:

- `RESULTS_QUEUE_NAME` debe tener sesiones habilitadas. El backend espera la respuesta con `sessionId=jobId`.
- `AZURE_SERVER_URL` no se usa en `queue`; queda para `AGENT_TARGET=azure`.
- No pongas `OPENAI_BASE=http://127.0.0.1:11434/v1` en App Service esperando llegar a tu máquina. Ese `127.0.0.1` sería el propio App Service.

## Worker local

En la máquina con Ollama/GPU:

```env
AGENT_TARGET=local
AZURE_SERVICEBUS_CONNECTION_STRING=<connection-string>
JOBS_QUEUE_NAME=adaceen-jobs
RESULTS_QUEUE_NAME=adaceen-results
WORKER_SHARED_SECRET=<mismo-secreto>
OPENAI_BASE=http://127.0.0.1:11434/v1
OPENAI_API_KEY=dummy
MODEL_TEXT=qwen2.5:7b-instruct
OLLAMA_URL=http://127.0.0.1:11434
MODEL_VISION=qwen2.5vl:7b-gpu
ADACEEN_LOG_LEVEL=info
```

Ejecuta:

```bash
npm run worker:queue
```

## Verificacion

1. En App Service, `/health` debe mostrar:

```json
{
  "mode": "queue",
  "queue_configured": true
}
```

2. Con el worker local corriendo, prueba `/suggest-tab`.
3. En consola local deberias ver logs como:

```text
[queue-worker] Job recibido ...
[queue-worker] Job completado ...
```

El backend y el worker tambien emiten logs JSON con `component`, `event`, `requestId`, `jobId`, colas, duraciones y resumen de tamanos/hash de entradas y salidas. Sube a `ADACEEN_LOG_LEVEL=debug` para mas detalle y usa `ADACEEN_LOG_STACKS=1` temporalmente si necesitas stack traces en errores.
