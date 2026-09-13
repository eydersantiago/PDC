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

## Varios workers (PC principal, PC secundario, respaldo)

El worker es *pull-based*: cualquier maquina con la connection string y el mismo `WORKER_SHARED_SECRET` puede ejecutar `npm run worker:queue`. Service Bus reparte los jobs entre todos los workers conectados (*competing consumers*), asi que cambiar de PC es solo arrancar el worker en la otra maquina; no hay que tocar App Service ni Azure.

Reglas del worker:

- Cada job se procesa de a uno por worker (`receiveMessages(1)` en `peekLock`), lo que balancea la carga de forma natural.
- El lock del mensaje se renueva automaticamente durante `QUEUE_REQUEST_TIMEOUT_MS + 30s` (o `QUEUE_WORKER_LOCK_RENEWAL_MS` si es mayor), para que un job lento no se re-entregue a otro worker mientras se procesa.
- Si el fallo es transitorio (Ollama caido, red, sin memoria, HTTP 5xx/429), el worker **libera el job** (`abandon`) y espera `QUEUE_WORKER_RETRY_DELAY_MS` antes de volver a competir, para que otro worker lo tome. Tras `QUEUE_WORKER_MAX_ATTEMPTS` entregas responde el error al backend.
- Un job invalido (schema, secreto, campos faltantes) va a la **dead-letter queue** y el backend recibe el error de inmediato.
- Un job cuya edad supera `QUEUE_REQUEST_TIMEOUT_MS` se descarta sin procesar: el backend ya dejo de esperarlo. Esto evita que un worker recien encendido gaste GPU en jobs viejos antes de atender los nuevos. El backend ademas publica cada job con `timeToLive` igual a ese timeout.

Usa `QUEUE_WORKER_ID` distinto por maquina para saber en logs y resultados (`workerId`) quien atendio cada job.

### Credenciales minimas por worker

No uses `RootManageSharedAccessKey` en las maquinas worker (menos aun en un celular o portatil). Crea una *Shared access policy* dedicada:

- En `adaceen-jobs`: solo `Listen`.
- En `adaceen-results`: solo `Send`.

Y entrega a cada worker la connection string de esa politica. Si una maquina se pierde, basta con regenerar esa clave.

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
