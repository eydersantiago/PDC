# Plan de contingencia

| | |
|---|---|
| Jira | A15.5 · ADACEEN-126 |
| Criterio de cierre | Runbook de contingencia probado en el ensayo del piloto (A13.6) — ver el simulacro de la sección 9; el registro de `npm run piloto:simulacro` es la evidencia |
| Relacionados | [Runbook](runbook.md), [monitoreo](monitoreo.md), [prerrequisitos](prerrequisitos.md), `docs/gcp-worker-operacion.md` (rama `master`) |

Principio: **la clase no se detiene por el tutor.** Si falla la GPU o la red, el
tutor responde en modo controlado (sin inventar) y el docente sigue la sesión;
la telemetría registra el motivo (`model_error_fallback`) para el análisis.

## Resumen

| Riesgo | Cómo se detecta | Impacto en clase | Respuesta inmediata | Estado |
|---|---|---|---|---|
| 1. Desalojo Spot de la GPU | `alive_workers` = 0; VM `TERMINATED` con `compute.instances.preempted` | Respuestas degradadas hasta que otra GPU escuche | Encender la siguiente GPU (opción 1 del .bat) | Hecho: latido, modo degradado, orden V100 → A100 → L4 |
| 2. Sin cupo de GPU al encender | El .bat no logra arrancar ninguna | Toda la sesión en modo degradado, salvo que haya Mac del laboratorio | Probar las tres; si ninguna, encender las Mac del laboratorio (`worker-mac.sh iniciar`) o seguir sin modelo | Hecho con las Mac del laboratorio como servidores ([worker-mac](worker-mac.md)); más lentas que la GPU |
| 3. Arranque en frío | Primera respuesta lenta (~55 s de carga del modelo; 180 s en un primer envío en frío) | Solo la primera consulta | Encender 10 min antes y calentar | Hecho: precarga y `OLLAMA_KEEP_ALIVE=-1`; calentamiento en la opción 1 |
| 4. Caída del worker (proceso) | `alive_workers` = 0 con la VM `RUNNING` | Como 1 | `systemctl restart adaceen-worker` | Hecho: `Restart=always`; corregido el arranque con código viejo (rama `fix/worker-gpus`) |
| 5. Caída de Azure o de la red de la sala | `/api/health` no responde | Sin tutor ni telemetría | Seguir la clase sin tutor; el overlay avisa | Parcial: los eventos que no se envían se pierden (se mide con `seq`) |
| 6. Caída de la VM de editores o de Dev Tunnels | `vscode.dev` no conecta | Sin editor | Reiniciar la VM; plan B: VS Code instalado en los equipos de la sala (guía 1.8) o Codespaces | Parcial |
| Una Mac del laboratorio se cae o se duerme ([worker-mac](worker-mac.md)) | Desaparece de `listening[]`; el monitor cuenta un servidor menos | Nada si hay otros servidores: sus trabajos vuelven a la cola | `worker-mac.sh iniciar` en esa Mac | Hecho: servicios con reinicio, `caffeinate` y modo sistema |
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
- **Respaldo con las Mac del laboratorio:** si están instaladas
  ([worker-mac](worker-mac.md)), se encienden con `bash deploy/mac/worker-mac.sh
  iniciar` y atienden la cola sin tocar Azure. Son más lentas que la GPU: si la
  latencia pasa de 8 s, el bloque se anota como degradado, con el mismo
  criterio del protocolo.
- **Otra prevención:** un worker de respaldo en otra zona o región (la cuota de
  V100 bajo demanda solo existe en `us-central1`), o el notebook de Colab como
  worker alterno (`scripts/adaceen_colab_worker (1).ipynb`).

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
- **Red del laboratorio que bloquea el puerto 5671 (AMQP) o exige proxy:** los
  workers de las Mac usan WebSocket por el 443
  (`SERVICE_BUS_TRANSPORT=websockets`) y el proxy HTTPS de la Mac. El instalador
  prueba la salida antes de instalar.
- **Sin internet en el laboratorio:** una Mac en modo local (`--rol=local`)
  sigue dando tutor a quien trabaje en esa misma Mac. Los datos quedan en
  memoria, así que ese tiempo no entra en el piloto.
- **Para medirlo en el ensayo:** `npm run piloto:simulacro -- --backend <backend> --escenario azure`
  cronometra cuánto tarda `/api/health` en caer y en volver (casos 5 y 10 de la
  sección 9).

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

Después de un despliegue o de un rollback, `npm run evidencias:despliegue -- --backend <backend>`
deja en una carpeta fechada lo que quedó publicado: `/api/health`, servidores del
modelo, `/empezar`, descargas y versiones ([monitoreo](monitoreo.md), sección 5, y
[evidencias de despliegue](evidencias-despliegue.md)). Si `/api/health` no trae
`workspace_agent_transport` ni `model_workers_alive`, el backend que responde es
anterior a la tanda «acceso simplificado».

## 9. Simulacro para el ensayo del piloto (A13.6)

La columna `--escenario` dice qué casos cronometra `npm run piloto:simulacro`
(ver «Cómo se corre el simulacro»); los demás se anotan a mano.

| # | Qué se simula | Cómo | `--escenario` | Resultado esperado | ¿Pasó? |
|---|---|---|---|---|---|
| 1 | Desalojo | Apagar la GPU en plena sesión: `VM_EDITORES=ninguna bash deploy/clase.sh terminar` (apaga solo las GPU) o `gcloud compute instances stop <vm> --zone=<zona>` | `gpu` | Entre 90 y 120 s después de que se detiene el worker, `/api/agent/health` da 503 (el simulacro acepta hasta 2 min 35 s desde el Enter); desde ahí el tutor responde degradado en segundos; la barra dice «GPU: sin worker activo» | [ ] |
| 2 | Recuperación | `VM_EDITORES=ninguna bash deploy/clase.sh iniciar` (o la opción 1 del .bat) | `gpu` | `alive_workers` vuelve a 1 y la prueba de humo pasa | [ ] |
| 3 | Arranque en frío | Primera consulta tras encender | — | Tiempo anotado; dentro de lo esperado tras el calentamiento | [ ] |
| 4 | Worker caído | `sudo systemctl stop adaceen-worker` | `gpu` | Igual que 1; `systemctl start` lo recupera | [ ] |
| 5 | Red de la sala | Desconectar un equipo (el que corre el simulacro, si se quiere cronometrar) | `azure` | El overlay avisa; al volver, `seq` muestra la pérdida | [ ] |
| 6 | Túnel | Reiniciar el servicio del túnel de un estudiante | — | `vscode.dev` reconecta | [ ] |
| 7 | Rollback | Redeploy del commit anterior en un entorno de prueba | — | El backend responde con la versión anterior (`npm run evidencias:despliegue` deja la foto de `/api/health` y `/empezar`; el commit se anota desde GitHub Actions) | [ ] |
| 8 | VM de editores desconectada | `sudo systemctl stop adaceen-workspaces-agent` en la VM de editores | `editor` | Entre 60 y 85 s después de parar el agente, `workspace_agent_online` pasa a `false` (el simulacro acepta hasta 2 min desde el Enter); «Abrir mi editor» muestra «El editor esta apagado. Avisa al docente; esta ventana seguira esperando.» y sigue esperando; el monitor alerta; al hacer `start` vuelve | [ ] |
| 9 | Bloque sin tutor | Cambiar al bloque 1 con un estudiante de la cohorte B | — | Su VS Code y su overlay muestran el aviso del piloto sin llamar al modelo; los de la cohorte A reciben ayuda | [ ] |
| 10 | Caída breve de Azure | Fuera de clase: `az webapp restart --resource-group rg-adaceen-azure --name app-adaceen-api-eyder05232002` (el mismo comando del flujo de despliegue), en el Cloud Shell de Azure o en un equipo con `az login`, porque el Cloud Shell de Google no trae `az`; o Portal → App Service → reiniciar | `azure` | `/api/health` vuelve a responder; los servidores del modelo reaparecen con su siguiente latido y el agente de editores con su siguiente sondeo, sin tocar las VM | [ ] |

### Cómo se corre el simulacro

`npm run piloto:simulacro` es la guía con cronómetro. Muestra cada paso con el
comando que hay que correr, sondea `/api/health` (y `/api/agent/health` con la
GPU) cada 5 s y mide los tiempos. **No apaga ni enciende nada** y no necesita
gcloud ni credenciales: el operador corre los comandos en el Cloud Shell de
Google (a mano o con `deploy/clase.sh`; el caso 10, con `az`, en el de Azure) y
pulsa Enter en la terminal del simulacro al lanzar cada comando y al ver cada
aviso que el simulacro pide confirmar.

```bash
npm run piloto:simulacro -- --backend <backend> --escenario gpu
```

| Escenario | Casos | Qué hace el operador | Qué mira el simulacro |
|---|---|---|---|
| `gpu` (por defecto) | 1, 2 y 4 | Apaga la GPU o su worker, y después la enciende | Caída: `model_workers_alive: 0` en `/api/health` o 503 en `/api/agent/health`. Degradado: `model_workers_known_down: true`. Recuperación: `model_workers_alive` ≥ 1 |
| `editor` | 8 | `stop` y después `start` de `adaceen-workspaces-agent` en `adaceen-ws` (o `GPUS=ninguna bash deploy/clase.sh terminar` e `iniciar`, que apagan y encienden la VM) | Caída: `workspace_agent_online: false`. Degradado: el operador confirma el aviso de «Abrir mi editor». Recuperación: `workspace_agent_online: true` |
| `azure` | 5 y 10 | Reinicia el App Service o desconecta el equipo de la red | Caída: `/api/health` deja de responder 200. Degradado: el operador confirma el aviso del overlay (o un error con «HTTP 502» o «HTTP 503», si Azure contesta mientras reinicia) y «pista local (el backend no respondio)» en VS Code. Recuperación: `/api/health` 200; después, los servidores y el agente que había al empezar |

| Tiempo | Desde → hasta | Esperado |
|---|---|---|
| Detección | la marca «caída» del operador → primera lectura que la ve | ≤ 2 min 35 s con `gpu`: 120 s hasta que vence el latido, 30 s de margen para que el comando llegue a la VM y 5 s de consulta. ≤ 2 min con `editor`: 60 s sin sondeo del relay, hasta 25 s del último sondeo largo del agente, los mismos 30 s y 5 s. Con otro `--intervalo`, la meta cambia en la misma medida |
| Degradado | caída → `model_workers_known_down: true` (`gpu`) o la confirmación del operador (`editor`, `azure`) | con `gpu`, la misma lectura que la detección: `model_workers_known_down` pasa a `true` cuando vence el último latido |
| Recuperación | la marca «encender» (`gpu`, `editor`) o la caída (`azure`) → primera lectura de la racha sana final | — |
| Fuera de servicio | detección → recuperación | — |

- En la terminal: Enter marca el paso, «o» + Enter lo omite, y «f» + Enter o
  Ctrl+C terminan y guardan el registro.
- Opciones: `--intervalo <s>` (5), `--limite <s>` (900: espera máxima de cada
  paso automático, como `ESPERA_MAX` de `deploy/clase.sh`), `--timeout <s>` (10),
  `--salida <carpeta>` (`exportes`) y `--sin-pausas` (las acciones se marcan
  solas al llegar y las confirmaciones quedan omitidas).
- Deja `exportes/simulacro-<escenario>-<fecha>.jsonl` (una línea por lectura y
  por paso) y `.md` (tiempos, «¿Pasó?» de cada caso y cambios de estado). La
  fecha del nombre y las horas del resumen son UTC. Sale con código 1 si el
  simulacro no pasó; «por confirmar» quiere decir que falta la confirmación del
  operador.
- Necesita el backend con la tanda «acceso simplificado» (`model_workers_alive`
  en `/api/health`). Al empezar avisa si el estado no es sano: sin
  `WORKER_HEARTBEAT_TOKEN`, sin ningún servidor vivo, o con más de un servidor
  vivo (al apagar una GPU, los demás, por ejemplo las Mac del laboratorio,
  siguen atendiendo y la caída no se ve).

Pasos del ensayo:

1. **Antes:** GPU y VM de editores encendidas (`bash deploy/clase.sh iniciar`),
   la foto inicial con `npm run evidencias:despliegue -- --backend <backend>` y
   el monitor corriendo en otra terminal
   (`npm run piloto:monitor -- --url=<backend> --email=<docente> --password=<clave> --intervalo=15`).
2. **Prueba base:** `npm run demo:escenarios -- --url=<backend> --email=<estudiante de prueba> --password=<clave>` con todas las comprobaciones correctas.
3. **Casos 1 y 2:** `npm run piloto:simulacro -- --backend <backend> --escenario gpu`.
   Cuando el simulacro marque el modo degradado (`model_workers_known_down: true`),
   repite `demo:escenarios`: los escenarios del editor responden `degraded` en
   segundos. Antes de esa marca el backend todavía encola, y cada consulta espera
   el timeout de la cola (120 s). Tras la recuperación,
   `demo:escenarios` debe volver a pasar completo (el resumen lo recuerda como
   pendiente del caso 2). Para el caso 4 usa el mismo escenario con
   `systemctl stop` y `start` del worker, y anótalo.
4. **Caso 8:** `--escenario editor`, con un estudiante de prueba que pulsa
   «Abrir mi editor» cuando el simulacro lo pide.
5. **Caso 9:** el operador usa
   `npm run piloto:bloque -- --url=... --email=<docente> --password=... --bloque=1`
   y al terminar `--bloque=0`.
6. **Caso 10 (fuera de clase, opcional):** `--escenario azure` y el reinicio del
   App Service.
7. **Cierre:** guarda los registros del simulacro y del monitor
   (`exportes/monitor-<fecha>.jsonl`), marca «¿Pasó?» en la tabla con el resumen
   del simulacro y anota los tiempos en [evidencias de despliegue](evidencias-despliegue.md).
   Los eventos del simulacro quedan fuera del análisis porque ocurren fuera de
   los bloques del piloto (regla D4 de la limpieza) o con la cuenta de prueba (D3).
