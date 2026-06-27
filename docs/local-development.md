# ADACEEN local development

Este flujo evita depender del App Service cuando estas trabajando en tu Mac.

## Backend local con Ollama

1. Abre Ollama y confirma el modelo:

```bash
curl http://127.0.0.1:11434/api/tags
```

Si no aparece `qwen2.5-coder:7b`, instalalo:

```bash
ollama pull qwen2.5-coder:7b
```

2. Arranca el backend local:

```bash
npm run dev:local
```

3. Verifica:

```bash
curl http://127.0.0.1:3000/api/health
```

Debe responder `mode: "local"`.

## Extension Chrome local

En la configuracion de ADACEEN usa:

```text
http://127.0.0.1:3000
```

La extension ya no reemplaza esa URL por produccion. Si quieres volver a Azure, cambia el valor a:

```text
https://app-adaceen-api-eyder05232002.azurewebsites.net
```

## Worker para produccion queue

Cuando Azure este en `mode: "queue"` y necesites que tu Mac procese jobs de produccion:

```bash
cp .env.worker.example .env.worker
npm run worker:queue
```

Completa los secretos en `.env.worker`. La cola de resultados debe coincidir con Azure: `llm-results-sessions`.
