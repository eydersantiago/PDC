# Runbook del piloto: operación diaria y solución de problemas

| | |
|---|---|
| Jira | A15.7 · ADACEEN-128 (absorbe el runbook MVP de A11.6) |
| Para quién | Quien opera el piloto (estudiante de la tesis o su reemplazo) |
| Relacionados | [Prerrequisitos](prerrequisitos.md) · [despliegue a producción](despliegue.md) · [Mac del laboratorio](worker-mac.md) · [monitoreo](monitoreo.md) · [contingencia y rollback](contingencia.md) · [evidencias](evidencias-despliegue.md) · [plan de soporte](../piloto/plan-de-soporte.md) · [guía de instalación y uso](../guia-instalacion-uso.md) · `docs/gcp-worker-operacion.md` y `docs/gcp-worker-infraestructura.md` (rama `master`) · [túneles](../workspaces-tunnel.md) |

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
MACS    = Mac del laboratorio (mac-labNN-<chip>), con deploy/mac/worker-mac.sh
EDITORES = VM adaceen-ws (túneles ad-<login>)
```

## Chuleta

| Quiero… | Cómo |
|---|---|
| Iniciar la clase (GPU, editores y enlace) | Cloud Shell: `bash deploy/clase.sh iniciar` ([ciclo de cada clase](#0-ciclo-de-cada-clase)) |
| Terminar la clase | `bash deploy/clase.sh terminar` |
| ¿Está todo listo? | `bash deploy/clase.sh estado` (no cambia nada) |
| Encender o apagar la GPU desde Windows | `ADACEEN-GPU.bat`, opción 1 (V100 → A100 → L4, con calentamiento) u opción 9 (apagar todas) |
| ¿Hay GPU escuchando? | `curl -s $BACKEND/api/agent/health` (200 / 503 `sin_worker`) |
| ¿Qué GPU? | `curl -s $BACKEND/api/agent/backend` → `listening[]`, `alive_workers` |
| Encender o revisar una Mac del laboratorio | En la Mac: doble clic en `deploy/mac/Estado-servidor-ADACEEN.command` (o `bash deploy/mac/worker-mac.sh estado` / `… iniciar`; [worker-mac](worker-mac.md)) |
| Preparar la Mac de un estudiante (VS Code, `git`, extensión) | Doble clic en `Preparar-Mac-ADACEEN.command`, que se descarga de `$BACKEND/empezar` ([worker-mac §11](worker-mac.md#11-mac-de-los-estudiantes-vs-code-con-doble-clic)) |
| Llevar un cambio de `startup-script.sh` (o de rama) a las GPU | `bash deploy/gcp/actualizar-gpus.sh` (con `RAMA=<rama con latido>` para fijar la misma rama en todas); muestra la rama que usará cada GPU |
| ¿Qué servidores atienden? | `npm run piloto:monitor` → «servidores N (Mac del laboratorio - M2 x3, Google Cloud - V100 x1)» |
| ¿Está bien configurado? | `curl -s $BACKEND/api/health` |
| Prueba de humo | `npm run demo:escenarios -- --url=$BACKEND --email=<estudiante de prueba> --password=<clave>` |
| Latencia | `npm run medir:latencia -- --url=$BACKEND --n=30` |
| Calidad de los eventos | `GET $BACKEND/api/telemetry/quality` con sesión de docente, o `npm run estabilidad:eventos -- --desde-bd` |
| Exportar datos | `npm run telemetria:exportar -- --desde=<fecha> [--con-quices]` |
| Log del backend | `az webapp log tail --name app-adaceen-api-eyder05232002 --resource-group rg-adaceen-azure` |
| Log del worker | `gcloud compute ssh <vm> --zone=us-central1-a --tunnel-through-iap --command='sudo tail -f /var/log/adaceen-worker.log'` |

## 0. Ciclo de cada clase

Todo desde **Cloud Shell** (`https://shell.cloud.google.com`), con el
repositorio PDC en la rama que usa producción. La primera vez:
`git clone -b feature/azure-config-observability https://github.com/eydersantiago/PDC.git`;
las siguientes: `cd PDC && git pull`.

```bash
bash deploy/clase.sh iniciar     # T − 15 min: enciende, espera e imprime el enlace
bash deploy/clase.sh estado      # cuando quieras: qué hay encendido y si está listo (no cambia nada)
bash deploy/clase.sh terminar    # al terminar: apaga la GPU y la VM de editores
```

`iniciar`:

1. **Enciende una GPU:** la primera que encienda en el orden V100 → A100 → L4
   (la cuota del proyecto es de una GPU). Si una ya está encendida, no enciende
   otra. Si a una le falta cupo o cuota, dice por qué y prueba la siguiente. Las
   zonas se leen de las propias VMs.
2. **Enciende la VM de editores** `adaceen-ws`, solo con el proveedor `tunnel`
   (lo lee de `/api/health`; con `codespaces` no hace falta).
3. **Espera** (hasta 15 min) a que `/api/health` diga que el agente de editores
   está conectado (`workspace_agent_online`) y que algún servidor del modelo
   manda latido (`model_workers_alive` ≥ 1). Si encendió una GPU, espera también
   el latido de la GPU; si al final solo falta ella pero ya atiende una Mac del
   laboratorio, termina con un aviso. Cada cambio se muestra en pantalla.
4. **Imprime el enlace para estudiantes:** `$BACKEND/empezar`.

Si algo no queda listo, sale con código 1 y dice qué falta (editor o modelo) y
dónde mirar (sección 5). Si el proyecto no tiene ninguna de las VMs (Cloud
Shell apunta a otro proyecto) o falta la VM de editores con el proveedor
`tunnel`, lo dice enseguida en vez de esperar los 15 min:
`PROYECTO=adaceen-508504 bash deploy/clase.sh iniciar` o
`gcloud config set project adaceen-508504`. Se puede repetir sin miedo: no enciende lo que ya está
encendido ni apaga nada. `terminar` apaga las GPU y la VM de editores, espera a
que queden apagadas y no toca las Mac del laboratorio (no cuestan por hora).

Ninguno de los tres muestra secretos: solo lee el estado de las VMs,
`/api/health` y `/api/agent/backend`.

| Variable | Defecto | Para qué |
|---|---|---|
| `PROYECTO` | el de `gcloud config`, o `adaceen-508504` | Proyecto de Google Cloud |
| `GPUS` | `adaceen-worker-v100 adaceen-worker-a100 adaceen-worker` | Orden de preferencia; `ninguna` para una clase solo con Mac del laboratorio |
| `GPU_MODO` | `una` | `todas` enciende todas las de la lista (necesita cuota para varias) |
| `VM_EDITORES` | `adaceen-ws` | `ninguna` para no tocarla |
| `BACKEND` | la URL de producción | Otro App Service |
| `ESPERA_MAX` | `900` | Segundos máximos de espera |

Por ejemplo: `GPUS=adaceen-worker bash deploy/clase.sh iniciar` usa solo la L4.

Si se olvida `terminar`, las VMs se apagan solas: la GPU tras 30 min sin
trabajos (180 min las copias A100 y V100), contados desde el último trabajo
atendido (con su `startup-script` al día: `bash deploy/gcp/actualizar-gpus.sh`),
y la de editores tras 120 min sin nadie conectado.

`ADACEEN-GPU.bat` (Windows) sigue sirviendo para la GPU, pero no toca la VM de
editores ni espera al agente.

**Opcional, una vez: que la VM de editores se encienda sola.** Con
`bash deploy/gcp/crear-cuenta-autoencendido.sh` (Cloud Shell) el backend puede
encender `adaceen-ws` cuando un estudiante pide su editor y está apagada. El
script crea una cuenta de servicio con un rol propio que solo tiene
`compute.instances.get` y `compute.instances.start`, concedido sobre esa VM y no
sobre el proyecto; crea una clave (archivo con permisos 600, nunca en pantalla)
y muestra el comando `az webapp config appsettings set` que carga
`WORKSPACE_VM_AUTOSTART=gcp`, `WORKSPACE_VM_PROJECT`, `WORKSPACE_VM_ZONE`,
`WORKSPACE_VM_NAME` y `GCP_SERVICE_ACCOUNT_JSON` (la clave en base64). Con
`RG=rg-adaceen-azure` y la CLI de Azure disponible, la carga él mismo y borra la copia
local. Cloud Shell de Google no trae `az`: no descargues la clave a tu equipo;
instala `az` ahí mismo (`curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash`
y `az login --use-device-code`) y corre el script con `RG=rg-adaceen-azure` (si la clave
ya estaba creada, el comando `az` que imprimió y luego borra la copia). Comprobar:
`/api/health` → `"workspace_vm_autostart": true`.
La clave es un secreto de más alcance del que parece: `instances.get` devuelve
también la metadata de `adaceen-ws`, que incluye `workspace-agent-token` (con
ese token se podrían recibir las sesiones de editor de los estudiantes). Si se
filtra: revocarla (`gcloud iam service-accounts keys delete <id> …`, el script
imprime el comando) **y** rotar `WORKSPACE_AGENT_TOKEN` en el App Service y en
la metadata de la VM ([túneles](../workspaces-tunnel.md), «rotar el token del
agente»). Para quitar todo, también si la VM ya no existe,
`bash deploy/gcp/crear-cuenta-autoencendido.sh borrar`.
Si la organización prohíbe las claves (`iam.disableServiceAccountKeyCreation`),
el script lo dice y explica la excepción que debe pedir un administrador; sin
autoencendido todo sigue igual y la VM se enciende con `clase.sh iniciar`.

## 1. Antes de la clase (T − 30 min)

1. **Revisar la configuración:** `curl -s $BACKEND/api/health` debe mostrar
   `"mode": "queue"`, `"queue_configured": true`, `"database_provider": "postgres"`,
   `"telemetry_salt_configured": true` y `"worker_heartbeat_configured": true`.
   Si algo falla, ver la sección 5.
2. **Iniciar la clase (T − 15 min):** `bash deploy/clase.sh iniciar` en Cloud
   Shell (sección 0). Enciende la GPU y la VM de editores y espera a que Azure
   vea el latido y el agente. Si ninguna GPU tiene cupo, sigue con la
   [contingencia 2](contingencia.md#2-falta-de-cupo-de-gpu). Si la sesión usa
   Mac del laboratorio, en cada una: doble clic en
   `deploy/mac/Estado-servidor-ADACEEN.command` (debe decir que Azure la ve viva;
   si no, responde «s» para encender los servicios).
3. **Confirmar el latido:** `clase.sh iniciar` ya lo esperó. A mano:
   `curl -s $BACKEND/api/agent/health` → 200 y `alive_workers` ≥ 1 (el latido
   llega cada 30 s).
4. **Prueba de humo:** `npm run demo:escenarios -- --url=$BACKEND --email=<estudiante de prueba> --password=<clave> --salida=exportes/humo-<fecha>.md`.
   Debe terminar sin fallos. Anota la ventana de tiempo que imprime: sus eventos
   se excluyen del análisis.
5. **Editor:** `clase.sh iniciar` ya confirmó que el agente de la VM de editores
   está conectado; un túnel de prueba abre en `vscode.dev`.
6. **Prerrequisitos de la sala:** sección 2 de [prerrequisitos](prerrequisitos.md).
7. **Enlace para estudiantes:** el que imprimió `clase.sh` (`$BACKEND/empezar`):
   descargas, pasos para cargar la extensión y estado del servicio.

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

1. **Apagar GPU y editores:** `bash deploy/clase.sh terminar` (u opción 9 del
   .bat para las GPU). Si se olvida, el temporizador de inactividad apaga la GPU
   tras 30 min sin trabajos (180 min las copias A100 y V100) y la VM de editores
   tras 120 min sin editores abiertos; el disco sigue costando.
   Las Mac del laboratorio no cuestan por hora: se pueden dejar encendidas o
   apagar con `bash deploy/mac/worker-mac.sh detener`.
2. **Calidad de los datos:** `GET $BACKEND/api/telemetry/quality?since=<inicio>`
   con sesión de docente. Revisa `eventLoss.rate` y las reglas I1–I6.
3. **Exportar** (si el protocolo del piloto lo pide por sesión):
   `npm run telemetria:exportar -- --desde=<inicio> --hasta=<fin> --con-quices`.
   Los archivos quedan en `exportes/` (no se versiona); guárdalos donde indique
   el protocolo de datos.
4. **Latencia de la sesión:** `npm run medir:latencia -- --desde-bd --desde=<inicio>`.
5. **Bitácora:** anota incidentes, servidores usados (GPU y Mac del laboratorio)
   y resultados de la prueba de humo en [evidencias](evidencias-despliegue.md).

## 4. Semanal

- Créditos y gasto: `bash deploy/gcp/teardown.sh` (estado y costo de VMs,
  discos, snapshots y NAT) y consola → Facturación → Créditos (el crédito de
  300 USD vence el 12-dic-2026). Para una ausencia larga,
  `bash deploy/gcp/teardown.sh stop` apaga todas las GPU y
  `bash deploy/gcp/teardown.sh destroy` las borra con sus discos, **incluida la
  L4** (`adaceen-worker`, el disco del que `clone-worker.sh` saca las copias; el
  snapshot `adaceen-worker-snap` se conserva): pide escribir `BORRAR`. Para
  borrar solo una, `NOMBRE=<vm> bash deploy/gcp/teardown.sh destroy`. El NAT y
  el router solo se borran si ya no queda ninguna VM en la región (la de
  editores sale a internet por ese NAT).
- Retención: `npm run telemetria:purgar` (solo cuenta; con `--confirmar` borra lo
  que pase de `TELEMETRY_RETENTION_DAYS`). Exporta antes lo que se vaya a analizar.
- Revisar que los tres workers arranquen con el código actual: el arranque trae
  la rama de la metadata `branch` y deja el código en su último commit. Cada VM
  corre la copia de `deploy/gcp/startup-script.sh` que guarda en su metadata:
  después de cambiar el script en el repositorio, o para cambiar de rama,
  `bash deploy/gcp/actualizar-gpus.sh` (con `RAMA=<rama>`); surte efecto en el
  próximo arranque. De paso, a una GPU sin `heartbeat-url`/`heartbeat-token` o
  sin `branch` (las copias A100 y V100 hechas con el `clone-worker.sh`
  anterior) le copia los de otra GPU de la lista (la L4), sin mostrar el
  latido. Cada línea dice la rama que usará esa GPU: tiene que ser una rama
  cuyo worker mande latido (A15.4); si no, `clase.sh` no ve la GPU. Una GPU sin
  metadata `branch` sigue en la rama que ya tiene su clon.
- Logs de la GPU: `/var/log/adaceen-worker.log` y `/var/log/adaceen-startup.log`
  rotan solos al pasar de 50 MB (logrotate, cada hora; se guardan 5 comprimidos).
- Versiones: anotar las de backend, extensiones y modelo en las [notas de versión](../versiones/notas-de-version.md).

## 5. Solución de problemas

Los fallos del editor por túnel y de VS Code con el acceso simplificado
(«El editor esta apagado; avisa al docente», «ADACEEN: sin conectar», códigos
de la Mac, «Demasiados intentos seguidos»…) tienen su propia tabla, con la
severidad de cada uno, en el [plan de soporte](../piloto/plan-de-soporte.md),
sección 7. Aquí van los de la GPU, el backend y la VM.

| Síntoma | Causa probable | Cómo confirmarlo | Qué hacer |
|---|---|---|---|
| El tutor dice «no esta disponible» / VS Code «GPU: sin worker activo» | GPU apagada o desalojada | `/api/agent/health` → 503; `bash deploy/clase.sh estado` → GPU `TERMINATED` | `bash deploy/clase.sh iniciar` (u opción 1 del .bat) |
| HTTP 500 a los 120 s | Desalojo **o** primer envío en frío | VM `TERMINATED` (desalojo) o `RUNNING` con `queue.result.send.done` ≈ 180000 ms (frío) | Desalojo: encender otra GPU. Frío: calentar antes de clase |
| Primera respuesta muy lenta (~1 min) | Modelo cargándose en la GPU | `ollama ps` en la VM | Esperar; calentar antes de clase |
| Una Mac del laboratorio no aparece en `listening[]` | Servicio apagado, Mac dormida, sesión cerrada (modo sesión) o red sin salida al 443 | En la Mac: `bash deploy/mac/worker-mac.sh estado` | `… iniciar`; ver [worker-mac](worker-mac.md), sección 8 |
| Latencia alta desde que entraron las Mac | Mac con chip base atendiendo a la par de la GPU | Monitor: servidores; informe: latencia por servidor | Reinstalar esas Mac con `--respaldo`, o dejarlas apagadas mientras la GPU esté viva |
| `alive_workers` = 0 con la VM `RUNNING` | Worker caído o sin token de latido | `systemctl status adaceen-worker`; metadata `heartbeat-token` | `sudo systemctl restart adaceen-worker`; revisar el token. Si a la VM le falta `heartbeat-token` (copias A100/V100 antiguas): `bash deploy/gcp/actualizar-gpus.sh` y reiniciarla |
| Latido responde 401 | Token distinto entre App Service y worker | Log del worker | Igualar `WORKER_HEARTBEAT_TOKEN` y reiniciar el worker |
| `/api/agent/health` siempre 200 aunque no haya GPU | Sin `WORKER_HEARTBEAT_TOKEN` en el App Service o modo distinto de `queue` | `/api/health` → `worker_heartbeat_configured: false` | Configurar el token |
| Trabajos que nunca llegan al worker | Nombres de cola distintos | `/api/health` → `jobs_queue_name`, `results_queue_name` vs. `.env.worker` | Igualar nombres |
| El worker responde con otro `worker-id` o código viejo | Arranque sin reiniciar el servicio (corregido en `fix/worker-gpus`) | `/api/agent/backend` | `sudo systemctl restart adaceen-worker` |
| `vscode.dev` «no encuentra el túnel» | Sesión Microsoft en vez de GitHub | Menú de cuentas de `vscode.dev` | Cerrar la sesión Microsoft y entrar con GitHub |
| El código de dispositivo venció | Pasaron ~15 min (ADACEEN espera hasta 12) | Mensaje del overlay | «Abrir mi editor» (o «Preparar mi editor», si el editor todavía no estaba guardado) de nuevo: da otro código |
| El túnel no arranca (servicio en bucle) | Nombre de túnel de más de 20 caracteres | `journalctl -u adaceen-tunnel@ws-<login>` | Nombre `ad-<login>` (automático); revisar logins largos |
| «Preparar mi editor» o «Abrir mi editor» no llega a la VM | El agente no está conectado al relay (VM apagada, token distinto o agente caído) | La ventana de espera dice «El editor esta apagado; avisa al docente» y **sigue esperando** (no es un error); `GET /api/health` → `workspace_agent_online: false` | Encender la VM (`bash deploy/clase.sh iniciar`): cuando el agente vuelve, las ventanas que esperan abren el editor solas. `journalctl -u adaceen-workspaces-agent` debe decir «conectado al relay»; si dice que rechazó el token, igualar `WORKSPACE_AGENT_TOKEN` y la metadata `workspace-agent-token` ([despliegue](despliegue.md), parte "VM de editores"). Respaldo: preparar el túnel a mano con `nuevo-tunel.sh` |
| `clase.sh iniciar` termina con `editor no listo: VM encendida; el agente todavia no se conecta (tarda 1-2 min)` | Agente caído o `WORKSPACE_AGENT_TOKEN` distinto del de la metadata | `gcloud compute ssh adaceen-ws --tunnel-through-iap --command='sudo journalctl -u adaceen-workspaces-agent -n 30'` | Igualar el token y reiniciar el agente; volver a correr `clase.sh iniciar` (no repite lo hecho) |
| `clase.sh iniciar` termina con «modelo no listo» | La GPU no arrancó el worker (driver, modelo o rama), no tiene `heartbeat-token` o su rama no manda latido | `sudo tail -n 50 /var/log/adaceen-startup.log` en la GPU (un «AVISO: el worker de la rama … no manda latido» es la rama); metadata `heartbeat-token` | Ver las filas de latido de arriba; rama sin latido: `RAMA=<rama con latido> bash deploy/gcp/actualizar-gpus.sh` y reiniciar la GPU; mientras tanto, otra GPU con `GPUS=<otra> bash deploy/clase.sh iniciar` |
| `clase.sh iniciar` dice «no encuentro ninguna de las VMs … en el proyecto …» | Cloud Shell apunta a otro proyecto | La primera línea («proyecto …») | `PROYECTO=adaceen-508504 bash deploy/clase.sh iniciar` o `gcloud config set project adaceen-508504` |
| La GPU no se apaga sola, o sigue con el código viejo tras cambiar la metadata `branch` | La VM corre un `startup-script` viejo: su apagado miraba la fecha del log (que un latido fallido renovaba cada 5 min) y un cambio de rama abortaba el arranque | `gcloud compute instances describe <vm> --zone=<zona> --format="value(metadata.items.startup-script)" \| grep -c ultimo-trabajo` → 0 | `bash deploy/gcp/actualizar-gpus.sh` (con `RAMA=<rama>` si hace falta) y reiniciar la GPU |
| Un estudiante con Mac no puede abrir `Preparar-Mac-ADACEEN.command` («no se puede abrir porque es de un desarrollador no identificado») | Gatekeeper: archivo descargado sin firma | — | Clic derecho sobre el archivo → **Abrir** → **Abrir** (en macOS 15: Ajustes del Sistema → Privacidad y seguridad → «Abrir igualmente»). Si eso pide una clave que no tiene: abrir Terminal y escribir `bash ~/Downloads/Preparar-Mac-ADACEEN.command` (así Gatekeeper no interviene) |
| `Preparar-Mac-ADACEEN.command` dice que falta `git` y el instalador de Apple pide clave de administrador | Cuenta estándar del laboratorio | — | Lo instala soporte del laboratorio (una vez por equipo, `xcode-select --install`); mejor antes de la clase ([prerrequisitos](prerrequisitos.md)) |
| «Abrir en VS Code de este equipo» no abre VS Code en una Mac | VS Code recién instalado y nunca abierto: macOS aún no lo tiene como el que abre los enlaces `vscode://` | — | Abrir VS Code una vez a mano, cerrarlo y volver a pulsar el botón |
| VS Code aplica la política equivocada o sus eventos llegan sin usuario | VS Code sin sesión: la barra dice «ADACEEN: sin conectar» | Overlay: «Esperando extension VS Code»; monitor: `sesiones de cliente sin usuario` | En el túnel, «Abrir mi editor» en el navegador (vuelve a escribir la sesión); en VS Code, clic en la barra → «ADACEEN: Conectar» → «Con mi cuenta de GitHub (recomendado)» ([plan de soporte](../piloto/plan-de-soporte.md), sección 7) |
| No aparece «Aplicar» | Política, cambio largo o cupo agotado | Mensaje de VS Code | Ver la [guía](../guia-instalacion-uso.md), sección 2.3 |
| Muchos eventos perdidos | Red inestable o pestañas cerradas de golpe | `/api/telemetry/quality` → `eventLoss` | Revisar red; anotar la ventana |
| `/api/health` → `telemetry_salt_configured: false` | Falta la sal | — | Configurarla **antes** de la primera sesión y no cambiarla después |
| El backend se comporta como una versión vieja tras un despliegue | Azure reiniciando | Esperar unos minutos | Si sigue, rollback ([contingencia 8](contingencia.md#8-rollback)) |

## 6. Despliegue y rollback

- **Procedimiento paso a paso:** [despliegue a producción](despliegue.md): en
  Cloud Shell, `bash deploy/produccion.sh revisar`, `aplicar` y `verificar`
  (variables del App Service, push, verificación, VM de editores, GPU,
  extensiones, registro y rollback). Después, la
  [prueba de inicio a fin](../piloto/prueba-inicio-a-fin.md) y la foto de lo
  publicado con `npm run evidencias:despliegue -- --backend $BACKEND`
  ([evidencias](evidencias-despliegue.md)).
- El backend se despliega con cada push a `feature/azure-config-observability`
  **o** a `master` (hay un flujo de GitHub Actions por rama, ambos al mismo App
  Service). No empujes a `master`: dejaría producción con el código de esa rama.
  Antes de cualquier push a `feature/azure-config-observability`: `npm run build`
  y `npm test`.
- Las ramas de trabajo (por ejemplo `feat/cierre-pendientes-jira`) no despliegan.
- Rollback del backend: [despliegue](despliegue.md), sección "Rollback" (un
  commit que restaura el árbol anterior y un push normal). Base de datos y
  versiones anteriores de las extensiones: [contingencia 8](contingencia.md#8-rollback).

## 7. Instalación

Estudiantes y docentes: [guía de instalación y uso](../guia-instalacion-uso.md)
y la página `$BACKEND/empezar`. Mac de estudiantes con VS Code: doble clic en
`Preparar-Mac-ADACEEN.command` ([worker-mac §11](worker-mac.md#11-mac-de-los-estudiantes-vs-code-con-doble-clic)).
Infraestructura desde cero:

- `bash deploy/gcp/create-vm.sh l4` (worker GPU): se lanza desde cualquier
  carpeta; sin IP pública (política `vmExternalIpAccess`), sale por el Cloud NAT
  `adaceen-nat`, que crea si falta; pide la cadena de Service Bus, el
  `WORKER_SHARED_SECRET` y el `WORKER_HEARTBEAT_TOKEN` sin mostrarlos y los pasa
  por archivo, y deja en la metadata el latido y la rama (`RAMA`, defecto
  `feature/azure-config-observability`).
- `bash deploy/gcp/clone-worker.sh v100` (y `a100`): copia del disco de la L4 con
  toda su metadata (incluido el latido) y el `startup-script.sh` del repositorio.
- `deploy/mac/Instalar-servidor-ADACEEN.command` (doble clic) o
  `deploy/mac/instalar-worker-mac.sh` (Mac del laboratorio, [guía](worker-mac.md)).
- `deploy/gcp/workspaces/create-ws-vm.sh` (VM de editores) y, opcional,
  `deploy/gcp/crear-cuenta-autoencendido.sh` (sección 0).
- `docs/gcp-worker-operacion.md` §7 (rama `master`).
