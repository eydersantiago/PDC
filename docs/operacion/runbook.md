# Runbook del piloto: operación diaria y solución de problemas

| | |
|---|---|
| Jira | A15.7 · ADACEEN-128 (absorbe el runbook MVP de A11.6) |
| Para quién | Quien opera el piloto (estudiante de la tesis o su reemplazo) |
| Relacionados | [Prerrequisitos](prerrequisitos.md) · [monitoreo](monitoreo.md) · [contingencia y rollback](contingencia.md) · [evidencias](evidencias-despliegue.md) · [guía de instalación y uso](../guia-instalacion-uso.md) · `docs/gcp-worker-operacion.md` y `docs/gcp-worker-infraestructura.md` (rama `master`) · [túneles](../workspaces-tunnel.md) |

**Dónde se ejecutan los comandos:** `gcloud` en Cloud Shell o en una terminal
con `gcloud` autenticado (las credenciales de Cloud Shell caducan cada ~hora);
`npm run …` en una copia del repositorio PDC con Node.js; `curl` desde
cualquier equipo (algunos entornos bloquean `*.azurewebsites.net`: en ese caso,
usa Cloud Shell o abre la URL en el navegador). En PowerShell escribe cada
comando en una sola línea.

Valores usados en todo el documento:

```text
BACKEND = https://app-adaceen-api-eyder05232002.azurewebsites.net
PROYECTO = adaceen-508504   ZONA = us-central1-a
GPUs    = adaceen-worker-v100 (gce-v100) · adaceen-worker-a100 (gce-a100) · adaceen-worker (gce-l4)
EDITORES = VM adaceen-ws (túneles ad-<login>)
```

## Chuleta

| Quiero… | Cómo |
|---|---|
| Encender la GPU | `ADACEEN-GPU.bat`, opción 1 (V100 → A100 → L4, con calentamiento) |
| Apagar todas las GPU | `ADACEEN-GPU.bat`, opción 9 |
| ¿Hay GPU escuchando? | `curl -s $BACKEND/api/agent/health` (200 / 503 `sin_worker`) |
| ¿Qué GPU? | `curl -s $BACKEND/api/agent/backend` → `listening[]`, `alive_workers` |
| ¿Está bien configurado? | `curl -s $BACKEND/api/health` |
| Prueba de humo | `npm run demo:escenarios -- --url=$BACKEND --email=<estudiante de prueba> --password=<clave>` |
| Latencia | `npm run medir:latencia -- --url=$BACKEND --n=30` |
| Calidad de los eventos | `GET $BACKEND/api/telemetry/quality` con sesión de docente, o `npm run estabilidad:eventos -- --desde-bd` |
| Exportar datos | `npm run telemetria:exportar -- --desde=<fecha> [--con-quices]` |
| Log del backend | `az webapp log tail --name app-adaceen-api-eyder05232002 --resource-group <grupo>` |
| Log del worker | `gcloud compute ssh <vm> --zone=us-central1-a --tunnel-through-iap --command='sudo tail -f /var/log/adaceen-worker.log'` |

## 1. Antes de la clase (T − 30 min)

1. **Revisar la configuración:** `curl -s $BACKEND/api/health` debe mostrar
   `"mode": "queue"`, `"queue_configured": true`, `"database_provider": "postgres"`,
   `"telemetry_salt_configured": true` y `"worker_heartbeat_configured": true`.
   Si algo falla, ver la sección 5.
2. **Encender la GPU (T − 15 min):** opción 1 de `ADACEEN-GPU.bat`. Espera a
   que termine el paso de calentamiento. Si ninguna GPU tiene cupo, sigue con la
   [contingencia 2](contingencia.md#2-falta-de-cupo-de-gpu).
3. **Confirmar el latido:** `curl -s $BACKEND/api/agent/health` → 200 y
   `alive_workers` ≥ 1 (el latido llega cada 30 s).
4. **Prueba de humo:** `npm run demo:escenarios -- --url=$BACKEND --email=<estudiante de prueba> --password=<clave> --salida=exportes/humo-<fecha>.md`.
   Debe terminar sin fallos. Anota la ventana de tiempo que imprime: sus eventos
   se excluyen del análisis.
5. **Editor:** la VM de editores está `RUNNING` (`gcloud compute instances list`)
   y un túnel de prueba abre en `vscode.dev`.
6. **Prerrequisitos de la sala:** sección 2 de [prerrequisitos](prerrequisitos.md).

## 2. Durante la clase

- Cada 20–30 min, o si alguien reporta lentitud: `curl -s $BACKEND/api/agent/health`.
  Un 503 `sin_worker` es la [contingencia 1](contingencia.md#1-desalojo-spot-de-la-gpu):
  encender otra GPU con la opción 1; mientras tanto el tutor responde en modo
  controlado.
- Los estudiantes ven el estado en la barra de VS Code («GPU: …»).
- Anota la hora de cualquier incidente (inicio y fin).
- Si el docente cambia la política, se aplica a la siguiente consulta; las
  respuestas en caché de VS Code (120 s) incluyen la versión de la política en su
  clave, así que no mezclan políticas.

## 3. Después de la clase

1. **Apagar las GPU:** opción 9 del .bat. (Si se olvida, el temporizador de
   inactividad apaga la VM tras 180 min sin trabajos; el disco sigue costando.)
2. **Calidad de los datos:** `GET $BACKEND/api/telemetry/quality?since=<inicio>`
   con sesión de docente. Revisa `eventLoss.rate` y las reglas I1–I6.
3. **Exportar** (si el protocolo del piloto lo pide por sesión):
   `npm run telemetria:exportar -- --desde=<inicio> --hasta=<fin> --con-quices`.
   Los archivos quedan en `exportes/` (no se versiona); guárdalos donde indique
   el protocolo de datos.
4. **Latencia de la sesión:** `npm run medir:latencia -- --desde-bd --desde=<inicio>`.
5. **Bitácora:** anota incidentes, GPU usada y resultados de la prueba de humo en
   [evidencias](evidencias-despliegue.md).
6. **VM de editores:** se apaga sola tras 120 min sin editores abiertos.

## 4. Semanal

- Créditos y gasto: `bash deploy/gcp/teardown.sh` (estado y costo) y consola →
  Facturación → Créditos (el crédito de 300 USD vence el 12-dic-2026).
- Retención: `npm run telemetria:purgar` (solo cuenta; con `--confirmar` borra lo
  que pase de `TELEMETRY_RETENTION_DAYS`). Exporta antes lo que se vaya a analizar.
- Revisar que los tres workers arranquen con el código actual (el arranque hace
  `git reset --hard` a la rama de la metadata `branch`).
- Versiones: anotar las de backend, extensiones y modelo en las [notas de versión](../versiones/notas-de-version.md).

## 5. Solución de problemas

| Síntoma | Causa probable | Cómo confirmarlo | Qué hacer |
|---|---|---|---|
| El tutor dice «no esta disponible» / VS Code «GPU: sin worker activo» | GPU apagada o desalojada | `/api/agent/health` → 503; `gcloud compute instances list` → `TERMINATED` | Opción 1 del .bat |
| HTTP 500 a los 120 s | Desalojo **o** primer envío en frío | VM `TERMINATED` (desalojo) o `RUNNING` con `queue.result.send.done` ≈ 180000 ms (frío) | Desalojo: encender otra GPU. Frío: calentar antes de clase |
| Primera respuesta muy lenta (~1 min) | Modelo cargándose en la GPU | `ollama ps` en la VM | Esperar; calentar antes de clase |
| `alive_workers` = 0 con la VM `RUNNING` | Worker caído o sin token de latido | `systemctl status adaceen-worker`; metadata `heartbeat-token` | `sudo systemctl restart adaceen-worker`; revisar el token |
| Latido responde 401 | Token distinto entre App Service y worker | Log del worker | Igualar `WORKER_HEARTBEAT_TOKEN` y reiniciar el worker |
| `/api/agent/health` siempre 200 aunque no haya GPU | Sin `WORKER_HEARTBEAT_TOKEN` en el App Service o modo distinto de `queue` | `/api/health` → `worker_heartbeat_configured: false` | Configurar el token |
| Trabajos que nunca llegan al worker | Nombres de cola distintos | `/api/health` → `jobs_queue_name`, `results_queue_name` vs. `.env.worker` | Igualar nombres |
| El worker responde con otro `worker-id` o código viejo | Arranque sin reiniciar el servicio (corregido en `fix/worker-gpus`) | `/api/agent/backend` | `sudo systemctl restart adaceen-worker` |
| `vscode.dev` «no encuentra el túnel» | Sesión Microsoft en vez de GitHub | Menú de cuentas de `vscode.dev` | Cerrar la sesión Microsoft y entrar con GitHub |
| El código de dispositivo venció | Pasaron ~15 min | Mensaje del overlay | «Preparar entorno» de nuevo |
| El túnel no arranca (servicio en bucle) | Nombre de túnel de más de 20 caracteres | `journalctl -u adaceen-tunnel@ws-<login>` | Nombre `ad-<login>` (automático); revisar logins largos |
| «Preparar entorno» no llega a la VM | El agente no está conectado al relay (VM apagada, token distinto o agente caído) | Error del overlay «No se pudo contactar la VM de editores»; `GET /api/health` → `workspace_agent_online: false` | Encender la VM; `journalctl -u adaceen-workspaces-agent` debe decir «conectado al relay»; si dice que rechazó el token, igualar `WORKSPACE_AGENT_TOKEN` y la metadata `workspace-agent-token`. Respaldo: preparar el túnel a mano con `nuevo-tunel.sh` |
| VS Code aplica la política equivocada | Sin sesión compartida | Overlay: «Esperando extension VS Code» | «ADACEEN: Configurar sesión compartida» |
| No aparece «Aplicar» | Política, cambio largo o cupo agotado | Mensaje de VS Code | Ver la [guía](../guia-instalacion-uso.md), sección 2.3 |
| Muchos eventos perdidos | Red inestable o pestañas cerradas de golpe | `/api/telemetry/quality` → `eventLoss` | Revisar red; anotar la ventana |
| `/api/health` → `telemetry_salt_configured: false` | Falta la sal | — | Configurarla **antes** de la primera sesión y no cambiarla después |
| El backend se comporta como una versión vieja tras un despliegue | Azure reiniciando | Esperar unos minutos | Si sigue, rollback ([contingencia 8](contingencia.md#8-rollback)) |

## 6. Despliegue y rollback

- El backend se despliega con cada push a `feature/azure-config-observability`
  **o** a `master` (hay un flujo de GitHub Actions por rama, ambos al mismo App
  Service). Antes de cualquier push a esas ramas: `npm run build` y `npm test`.
- Las ramas de trabajo (por ejemplo `feat/cierre-pendientes-jira`) no despliegan.
- Rollback y versiones anteriores de las extensiones: [contingencia 8](contingencia.md#8-rollback).

## 7. Instalación

Estudiantes y docentes: [guía de instalación y uso](../guia-instalacion-uso.md).
Infraestructura desde cero: `deploy/gcp/create-vm.sh` (worker GPU),
`deploy/gcp/workspaces/create-ws-vm.sh` (VM de editores) y
`docs/gcp-worker-operacion.md` §7 (rama `master`).
