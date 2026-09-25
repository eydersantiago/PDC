# ADACEEN local development

Produccion sigue siendo la prioridad del browser extension. Este flujo se usa solo cuando necesitas trabajar contra el backend local de tu Mac o PC.

## Backend local con Ollama

1. Abre Ollama y confirma el modelo:

```bash
curl http://127.0.0.1:11434/api/tags
```

Si no aparece `qwen2.5-coder:7b`, instalalo:

```bash
ollama pull qwen2.5-coder:7b
```

2. Arranca el backend local. Este comando es compatible con macOS, Linux y Windows porque configura las variables desde Node:

```bash
npm run dev:local
```

3. Verifica:

```bash
curl http://127.0.0.1:3000/api/health
```

Debe responder `mode: "local"`.

## Extension Chrome local

Por defecto la extension apunta a produccion:

```text
https://app-adaceen-api-eyder05232002.azurewebsites.net
```

Cuando estes trabajando local, cambia manualmente la configuracion de ADACEEN a:

```text
http://127.0.0.1:3000
```

La extension conserva esa URL local solo porque la elegiste de forma explicita. Si quieres volver a produccion, cambia el valor a:

```text
https://app-adaceen-api-eyder05232002.azurewebsites.net
```

## Extension de VS Code local

Desde la version 0.0.30 no hay que configurar nada: si `npm run dev:local` esta corriendo en tu equipo, la extension de VS Code lo encuentra en `http://127.0.0.1:3000` (reconoce el `GET /health` de ADACEEN) y lo usa, como antes. Si no hay backend local, va a produccion. Lo revisa al abrir VS Code y cada 30 s, asi que encender o apagar `npm run dev:local` cambia el destino sin reiniciar VS Code.

Un valor escrito en `adaceen.backend.baseUrl` (o en `ADACEEN_BACKEND_URL`) sigue mandando. El canal «ADACEEN» muestra la eleccion (`[Backend] ...`), y el recuadro de «GPU: ...» en la barra de estado dice de donde salio.

## Worker para produccion queue

Cuando Azure este en `mode: "queue"` y necesites que tu Mac procese jobs de produccion:

```bash
cp .env.worker.example .env.worker
npm run worker:queue
```

Para dejar una Mac como servidor permanente (servicio de launchd, sin dormirse, con WebSocket por el 443 para la red de la universidad), o para juntar varias Mac en un cluster que corra un modelo mas grande, usa el instalador: [docs/operacion/worker-mac.md](operacion/worker-mac.md). El instalador guarda su configuracion en `~/.adaceen/worker.env` y no toca tu `.env.worker`.

Completa los secretos en `.env.worker`. La cola de resultados debe coincidir con Azure: `llm-results-sessions`.
