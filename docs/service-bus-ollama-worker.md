# ADACEEN Queue Mode: App Service + Service Bus + Ollama local

Este modo permite que el App Service productivo reciba solicitudes HTTP y delegue la inferencia a un worker con Ollama usando Azure Service Bus. El worker puede ser una GPU de Google Cloud, una Mac del laboratorio de la universidad ([worker-mac.md](operacion/worker-mac.md)) o cualquier equipo con Ollama.

## App Service

Configura estas variables:

```env
AGENT_TARGET=queue
AZURE_SERVICEBUS_CONNECTION_STRING=<connection-string>
JOBS_QUEUE_NAME=llm-jobs
RESULTS_QUEUE_NAME=llm-results-sessions
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
JOBS_QUEUE_NAME=llm-jobs
RESULTS_QUEUE_NAME=llm-results-sessions
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

El worker lee `.env` y luego `.env.worker` de la carpeta donde se ejecuta. Si
`ADACEEN_WORKER_ENV_FILE` apunta a otro archivo, lee ese en lugar de
`.env.worker`. Las Mac del laboratorio lo usan para guardar su configuración en
`~/.adaceen/worker.env`, fuera del repositorio.

### Opciones del worker

| Variable | Por defecto | Para qué |
|---|---|---|
| `SERVICE_BUS_TRANSPORT` | `amqp` | `amqp` usa el puerto 5671. `websockets` usa el mismo AMQP dentro de un WebSocket por HTTPS 443 y sale por `HTTPS_PROXY` si existe (respeta `NO_PROXY`). Las Mac del laboratorio usan `websockets`. |
| `QUEUE_WORKER_CONCURRENCY` | `1` | Trabajos a la vez (1 a 8), cada uno con su receptor. Debe coincidir con `OLLAMA_NUM_PARALLEL` de Ollama. |
| `QUEUE_WORKER_KINDS` | `text,image` | Tipos de trabajo que acepta. Un worker sin modelo de visión declara `text`: libera los trabajos de imagen para que los tome otro. |
| `QUEUE_WORKER_PRIORITY` | `normal` | `backup` (o `respaldo`) solo toma los trabajos que los demás no alcanzan a tomar: espera 1 s por consulta y descansa `QUEUE_WORKER_BACKUP_IDLE_MS` (3000) entre consultas vacías. Sirve para una Mac lenta junto a la GPU. |
| `QUEUE_WORKER_WARMUP` | `1` | Al arrancar precarga el modelo de texto en Ollama (`/api/generate` con `keep_alive: -1`) para que el primer estudiante no espere la carga. `0` lo desactiva. |
| `QUEUE_WORKER_LAST_JOB_FILE` | (vacío) | Archivo donde el worker escribe la hora tras cada trabajo atendido (crea la carpeta si falta; un fallo al escribir solo deja un aviso en el log). La GPU de Google Cloud lo usa en `/var/lib/adaceen/ultimo-trabajo`: su apagado por inactividad mira la fecha de ese archivo, no la del log, que un latido fallido renovaba cada 5 min. Vacío: no escribe nada. |

## Varios workers (PC principal, PC secundario, respaldo)

El worker es *pull-based*: cualquier maquina con la connection string y el mismo `WORKER_SHARED_SECRET` puede ejecutar `npm run worker:queue`. Service Bus reparte los jobs entre todos los workers conectados (*competing consumers*), asi que cambiar de PC es solo arrancar el worker en la otra maquina; no hay que tocar App Service ni Azure.

Reglas del worker:

- Cada receptor procesa un job a la vez (`receiveMessages(1)` en `peekLock`); con `QUEUE_WORKER_CONCURRENCY` mayor que 1 hay varios receptores sobre la misma conexión. Si uno pierde la conexión, los demás terminan su job y el worker se reconecta.
- El lock del mensaje se renueva automaticamente durante `QUEUE_REQUEST_TIMEOUT_MS + 30s` (o `QUEUE_WORKER_LOCK_RENEWAL_MS` si es mayor), para que un job lento no se re-entregue a otro worker mientras se procesa.
- Si el fallo es transitorio (Ollama caido, red, sin memoria, HTTP 5xx/429), el worker **libera el job** (`abandon`) y espera `QUEUE_WORKER_RETRY_DELAY_MS` antes de volver a competir, para que otro worker lo tome. Tras `QUEUE_WORKER_MAX_ATTEMPTS` entregas responde el error al backend.
- Un job invalido (schema, secreto, campos faltantes) va a la **dead-letter queue** y el backend recibe el error de inmediato.
- Un job cuya edad supera `QUEUE_REQUEST_TIMEOUT_MS` se descarta sin procesar: el backend ya dejo de esperarlo. Esto evita que un worker recien encendido gaste GPU en jobs viejos antes de atender los nuevos. El backend ademas publica cada job con `timeToLive` igual a ese timeout.

Usa `QUEUE_WORKER_ID` distinto por maquina para saber en logs y resultados (`workerId`) quien atendio cada job.

### Credenciales minimas por worker

No uses `RootManageSharedAccessKey` en las maquinas worker (menos aun en un celular o portatil). Crea una *Shared access policy* dedicada:

- En `llm-jobs`: solo `Listen`.
- En `llm-results-sessions`: solo `Send`.

Y entrega a cada worker la connection string de esa politica. Si una maquina se pierde, basta con regenerar esa clave. Una politica por colas funciona con conexiones separadas por cola; el worker usa una sola cadena, asi que en la practica se usa una politica del namespace con `Listen` y `Send`, una para las GPU (`colab-worker`) y otra para las Mac del laboratorio (`worker-mac`), que se revocan por separado.

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

## Origen de la inferencia (indicador en la extension)

Cada maquina que corre el worker se etiqueta con `QUEUE_WORKER_ID`. Ese id
viaja dentro del mensaje de resultado y el API lo devuelve, de modo que un
cliente puede decir de donde salio la GPU sin adivinarlo.

Convencion de ids:

| Maquina                    | `QUEUE_WORKER_ID` |
|----------------------------|-------------------|
| VM con GPU en Google Cloud | `gce-l4`          |
| Notebook de Colab          | `colab-t4`        |
| Mac del laboratorio        | `mac-lab07-m2`    |
| Portatil Apple Silicon     | `mac-m3`          |
| Equipo de escritorio       | `pc-eyder`        |

El prefijo decide el proveedor y el sufijo el acelerador, asi que
`gce-l4` se muestra como **Google Cloud - L4** y `mac-lab07-m2` como
**Mac del laboratorio - M2**. Un id fuera de la convencion no rompe nada:
se muestra tal cual. El id queda en `metadata.worker` de cada
`tutor_decision`, y el informe del piloto separa la latencia por servidor.

El latido (`POST /api/agent/heartbeat`) lleva, ademas del id, el modelo, los
trabajos procesados, la plataforma (`linux-x64`, `darwin-arm64`), la
concurrencia y los tipos de trabajo; `GET /api/agent/backend` los devuelve en
`listening[]`. Si la red exige proxy, el latido tambien sale por
`HTTPS_PROXY`.

Dos puntos de lectura:

- `POST /run-text` incluye ahora un campo `worker` junto a `output_text`.
  Es aditivo; los clientes que solo leen `output_text` siguen igual.
- `GET /api/agent/backend` devuelve el modo (`local` / `azure` / `queue`),
  el ultimo worker que atendio un job y, en modo cola, los nombres de las
  colas. Sirve para mostrar el origen antes de lanzar el primer job.

En modo `azure` el API propaga el `worker` que reporte el backend remoto,
de forma que un encadenado azure -> queue sigue nombrando la maquina real
que puso la GPU y no el App Service intermedio.
