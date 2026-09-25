# Plan de contingencia

| | |
|---|---|
| Jira | A15.5 · ADACEEN-126 |
| Criterio de cierre | Runbook de contingencia probado en el ensayo del piloto (A13.6) — ver el simulacro de la sección 9 |
| Relacionados | [Runbook](runbook.md), [monitoreo](monitoreo.md), [prerrequisitos](prerrequisitos.md), `docs/gcp-worker-operacion.md` (rama `master`) |

Principio: **la clase no se detiene por el tutor.** Si falla la GPU o la red, el
tutor responde en modo controlado (sin inventar) y el docente sigue la sesión;
la telemetría registra el motivo (`model_error_fallback`) para el análisis.

## Resumen

| Riesgo | Cómo se detecta | Impacto en clase | Respuesta inmediata | Estado |
|---|---|---|---|---|
| 1. Desalojo Spot de la GPU | `alive_workers` = 0; VM `TERMINATED` con `compute.instances.preempted` | Respuestas degradadas hasta que otra GPU escuche | Encender la siguiente GPU (opción 1 del .bat) | Hecho: latido, modo degradado, orden V100 → A100 → L4 |
| 2. Sin cupo de GPU al encender | El .bat no logra arrancar ninguna | Toda la sesión en modo degradado | Probar las tres; si ninguna, avisar y seguir sin modelo | Parcial: sin respaldo en otra zona |
| 3. Arranque en frío | Primera respuesta lenta (~55 s de carga del modelo; 180 s en un primer envío en frío) | Solo la primera consulta | Encender 10 min antes y calentar | Hecho: precarga y `OLLAMA_KEEP_ALIVE=-1`; calentamiento en la opción 1 |
| 4. Caída del worker (proceso) | `alive_workers` = 0 con la VM `RUNNING` | Como 1 | `systemctl restart adaceen-worker` | Hecho: `Restart=always`; corregido el arranque con código viejo (rama `fix/worker-gpus`) |
| 5. Caída de Azure o de la red de la sala | `/api/health` no responde | Sin tutor ni telemetría | Seguir la clase sin tutor; el overlay avisa | Parcial: los eventos que no se envían se pierden (se mide con `seq`) |
| 6. Caída de la VM de editores o de Dev Tunnels | `vscode.dev` no conecta | Sin editor | Reiniciar la VM; plan B Codespaces | Parcial |
| 7. Versión defectuosa desplegada | Errores tras un despliegue | Variable | Rollback (sección 8) | Procedimiento documentado |

## 1. Desalojo Spot de la GPU

- **Señal:** `GET /api/agent/health` → 503 `sin_worker`; la barra de VS Code dice
  «GPU: sin worker activo»; `gcloud compute instances list` muestra la VM
  `TERMINATED` y `gcloud compute operations list --filter="operationType=compute.instances.preempted"`
  lo confirma. Visto: la L4 Spot fue desalojada 3 veces en una noche y la A100
  Spot a los 2,5 min de encender (23–24 sep).
- **Qué hace el sistema solo:** el trabajo en curso vuelve a la cola (lo toma
  otro worker si lo hay); sin workers vivos, el backend deja de encolar y
  responde en segundos: overlay con respuesta heurística, VS Code con «El tutor
  no esta disponible en este momento», quiz desde el banco validado.
- **Respuesta:** opción 1 de `ADACEEN-GPU.bat` (intenta V100 → A100 → L4). La
  V100 va primero porque es bajo demanda y no la desalojan.
- **Prevención:** para sesiones del piloto, preferir la V100 (estándar); no
  depender de una sola GPU Spot.

## 2. Falta de cupo de GPU

- **Señal:** el .bat no logra arrancar ninguna VM (`ZONE_RESOURCE_POOL_EXHAUSTED`
  o similar). El 23–24 sep la V100 bajo demanda no tuvo cupo en ninguna zona
  de `us-central1`: **bajo demanda protege del desalojo, no de la falta de cupo**.
- **Respuesta:** intentar de nuevo a los pocos minutos; si no hay GPU, avisar al
  docente y seguir en modo degradado (la actividad no depende del tutor).
- **Prevención (pendiente):** tener un worker de respaldo en otra zona o región
  (la cuota de V100 bajo demanda solo existe en `us-central1`), o el notebook de
  Colab como worker alterno (`scripts/adaceen_colab_worker (1).ipynb`).

## 3. Arranque en frío

- **Causa:** el modelo (~9 GB) se lee del disco a ~170 MB/s (pd-balanced de
  120 GB): ~55 s. Aparte, el **primer envío de un resultado** con la conexión a
  Service Bus en frío tardó 180 s una vez (22 sep).
- **Ya aplicado:** precarga del modelo en segundo plano al arrancar y
  `OLLAMA_KEEP_ALIVE=-1` (A100: primera petición de 61 s a 4,8 s); la opción 1
  del .bat manda un trabajo de calentamiento.
- **Cómo distinguirlo de un desalojo** (los dos dan HTTP 500 a los 120 s): en
  frío la VM sigue `RUNNING` y el log del worker muestra `queue.result.send.done`
  con ~180000 ms; en un desalojo la VM está `TERMINATED`.
- **Respuesta:** encender 10 min antes y correr la prueba de humo.
- **Pendiente:** disco pd-ssd (~30 s de carga, ~8 USD/mes más por disco).

## 4. Caída del worker (proceso)

- **Señal:** VM `RUNNING` pero `alive_workers` = 0 o trabajos que no se procesan.
- **Respuesta:** `gcloud compute ssh <vm> --zone=us-central1-a --tunnel-through-iap --command='sudo systemctl restart adaceen-worker'`;
  revisar `/var/log/adaceen-worker.log`. Si los nombres de cola no coinciden con
  los del App Service (`/api/health`), los trabajos mueren por timeout sin error.
- **Ya aplicado:** `Restart=always`; el arranque hace `enable` + `restart` para
  tomar el `.env.worker` y el código nuevos (antes arrancaba con los viejos).

## 5. Caída de Azure o de la red de la sala

- **Señal:** `/api/health` no responde desde la sala (probar también desde un
  celular con datos para separar red de sala y Azure).
- **Impacto:** sin tutor ni registro de eventos; el overlay muestra que el
  backend no respondió y VS Code usa pistas locales que **no se aplican**.
- **Respuesta:** seguir la clase sin tutor; anotar la hora para excluir la
  ventana del análisis. Si es la red de la sala, probar otra red.
- **Límite conocido:** la telemetría no guarda eventos sin conexión (sin cola
  persistente, decisión de alcance); la pérdida se mide con los huecos de `seq`.

## 6. VM de editores o Dev Tunnels

- **Señal:** `vscode.dev/tunnel/ad-<login>` no conecta para varios estudiantes.
- **Respuesta:** revisar que la VM esté `RUNNING` y reiniciar el servicio del
  túnel del estudiante (`adaceen-tunnel@ws-<login>`); si falla para todos,
  reiniciar la VM. Plan B: `ADACEEN_WORKSPACE_PROVIDER=codespaces` (lento: 20 a
  50 min de creación, solo como último recurso).
- **Si «Preparar entorno» falla para todos:** revisar que el agente siga
  conectado al relay (`GET /api/health` → `workspace_agent_online: true`; en la
  VM, `journalctl -u adaceen-workspaces-agent`). El camino Azure → VM va por el
  relay (la VM le pregunta a PDC por HTTPS de salida) y la revisión de sesión de
  `nuevo-tunel.sh` ya no confunde «not logged in» con una sesión (A15.3).
- **Si una sesión de GitHub quedó en un estado raro:** «vscode.dev dice que no
  encuentra el túnel» casi siempre es una sesión Microsoft en lugar de GitHub.

## 7. Datos durante un incidente

- Anotar inicio y fin del incidente; el análisis del piloto excluye o marca esa
  ventana.
- Después de la sesión: `GET /api/telemetry/quality` para ver eventos perdidos
  y exportar (`npm run telemetria:exportar`).

## 8. Rollback

| Pieza | Cómo volver atrás |
|---|---|
| Backend (App Service) | Cada push a `feature/azure-config-observability` **o** a `master` despliega en producción (hay un flujo para cada una). Para volver a la versión anterior: `git revert <commit>` en la rama desplegada y push (queda en el historial), o ejecutar el flujo a mano (*workflow_dispatch*) desde el commit bueno. No uses `push --force` en la rama de despliegue. Tras desplegar, Azure puede tardar unos minutos en reiniciar. |
| Variables de entorno | Portal → App Service → Configuración: revertir el valor y reiniciar. **Nunca cambiar `TELEMETRY_SALT` durante el piloto.** |
| Worker GPU | Metadata `branch` de la VM a la rama o commit anterior y `gcloud compute instances reset <vm> --zone=us-central1-a` (el arranque hace `git reset --hard` a la rama configurada). |
| Extensión de navegador | Volver a cargar el zip de la versión anterior (`dist/extension/` guarda los zip y `SHA256SUMS.txt`; conservar los de cada versión entregada). |
| Extensión de VS Code | En la VM de editores el túnel instala `/opt/adaceen/adaceen.vsix` si existe (si no, `adaceen.adaceen` del Marketplace) al arrancar: reemplazar ese archivo por el `.vsix` anterior y reiniciar los servicios `adaceen-tunnel@ws-<login>`. En VS Code de escritorio: «Install from VSIX...» con la versión anterior. |
| Base de datos | Los cambios de esquema son aditivos (`create table if not exists`, `add column if not exists`): una versión anterior del backend sigue funcionando con la base nueva. |

## 9. Simulacro para el ensayo del piloto (A13.6)

| # | Qué se simula | Cómo | Resultado esperado | ¿Pasó? |
|---|---|---|---|---|
| 1 | Desalojo | Apagar la GPU en plena sesión (`gcloud compute instances stop <vm>`) | En ≤ 2 min `/api/agent/health` da 503; el tutor responde degradado en segundos; la barra dice «GPU: sin worker activo» | [ ] |
| 2 | Recuperación | Opción 1 del .bat | `alive_workers` vuelve a 1 y la prueba de humo pasa | [ ] |
| 3 | Arranque en frío | Primera consulta tras encender | Tiempo anotado; dentro de lo esperado tras el calentamiento | [ ] |
| 4 | Worker caído | `sudo systemctl stop adaceen-worker` | Igual que 1; `systemctl start` lo recupera | [ ] |
| 5 | Red de la sala | Desconectar un equipo | El overlay avisa; al volver, `seq` muestra la pérdida | [ ] |
| 6 | Túnel | Reiniciar el servicio del túnel de un estudiante | `vscode.dev` reconecta | [ ] |
| 7 | Rollback | Redeploy del commit anterior en un entorno de prueba | El backend responde con la versión anterior | [ ] |
| 8 | VM de editores desconectada | `sudo systemctl stop adaceen-workspaces-agent` en la VM de editores | En ≤ 60 s `workspace_agent_online` pasa a `false`; «Preparar entorno» responde «No se pudo contactar la VM de editores» de inmediato; el monitor alerta; al hacer `start` vuelve | [ ] |
| 9 | Bloque sin tutor | Cambiar al bloque 1 con un estudiante de la cohorte B | Su VS Code y su overlay muestran el aviso del piloto sin llamar al modelo; los de la cohorte A reciben ayuda | [ ] |

### Cómo se corre el simulacro

1. **Antes:** GPU encendida, VM de editores encendida y el monitor corriendo en
   otra terminal (`npm run piloto:monitor -- --url=<backend> --email=<docente> --password=<clave> --intervalo=15`).
   Anota la hora de inicio.
2. **Prueba base:** `npm run demo:escenarios -- --url=<backend> --email=<estudiante de prueba> --password=<clave>` con todas las comprobaciones correctas.
3. **Caso 1:** apaga la GPU. Cronometra hasta que el monitor muestre
   `worker CAIDO` y hasta que una sugerencia de VS Code llegue en modo
   degradado (repite `demo:escenarios`: los escenarios del editor responden
   `degraded` en segundos).
4. **Caso 2:** enciende con la opción 1 del `.bat`; cronometra hasta
   `worker ok` y hasta que `demo:escenarios` vuelva a pasar completo.
5. **Casos 8 y 9:** como dice la tabla. Para el 9, el operador usa
   `npm run piloto:bloque -- --url=... --email=<docente> --password=... --bloque=1`
   y al terminar `--bloque=0`.
6. **Cierre:** guarda el registro del monitor (`exportes/monitor-<fecha>.jsonl`)
   y anota los tiempos en la tabla y en [evidencias de despliegue](evidencias-despliegue.md).
   Los eventos del simulacro quedan fuera del análisis porque ocurren fuera de
   los bloques del piloto (regla D4 de la limpieza) o con la cuenta de prueba (D3).
