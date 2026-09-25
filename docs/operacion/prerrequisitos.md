# Prerrequisitos del piloto (lista verificable)

| | |
|---|---|
| Jira | A15.1 · ADACEEN-122 |
| Cuándo | Una vez al preparar el piloto (sección 1) y antes de cada sesión (sección 2) |
| Relacionados | [Runbook](runbook.md), [monitoreo](monitoreo.md), [contingencia](contingencia.md), [guía de instalación](../guia-instalacion-uso.md) |

Cada casilla tiene la forma de comprobarla. Marca con fecha y anota lo que no
pase; lo que falle en la sección 2 decide si la sesión empieza con el tutor o
en modo degradado (ver [contingencia](contingencia.md)).

## 1. Una vez, al preparar el piloto

### Cuentas y accesos

- [ ] **Cuenta de GitHub por estudiante**, con el nombre de usuario anotado (no
  el correo). Verificar: `https://github.com/<login>` abre su perfil.
- [ ] **Repositorio público** por estudiante con el ejercicio (el túnel solo
  clona repositorios públicos). Verificar: abrir `https://github.com/<login>/<repo>`
  en una ventana privada.
- [ ] **Logins autorizados** en `WORKSPACE_ALLOWED_LOGINS` del App Service (vacío
  = todos). Verificar en el portal de Azure → App Service → Configuración.
- [ ] **Cuentas de ADACEEN** creadas: docentes con rol «Profesor» antes de su
  primer ingreso (con Google, una cuenta nueva nace como estudiante) y
  estudiantes asignados a su docente. Verificar en «Administración de usuarios».
- [ ] **Nombre de túnel ≤ 20 caracteres**: el túnel se llama `ad-` más los
  primeros 17 caracteres del login en minúsculas; dos logins que compartan esos
  17 caracteres chocarían. Verificar con la lista de logins.

### Navegadores

- [ ] Chrome, Edge o Brave actualizados, o Firefox 128 o superior. Verificar:
  `chrome://version` o `about:support`.
- [ ] Paquetes generados con `npm run empaquetar:extension` (`dist/extension/`:
  zip de Chromium, zip de Firefox y `SHA256SUMS.txt`) y repartidos.
- [ ] En Firefox: sin inicio de sesión con Google ni Google Calendar
  (`chrome.identity.getAuthToken` no existe allí); los estudiantes con Firefox
  necesitan correo y contraseña de ADACEEN.

### Azure

- [ ] App Service con `AGENT_TARGET=queue`, cadena de Service Bus y los nombres
  de cola que usa el worker (`llm-jobs`, `llm-results-sessions`). Verificar:
  `GET /api/health` → `"mode": "queue"`, `"queue_configured": true` y los dos nombres.
- [ ] `TELEMETRY_SALT` configurada (secreta, 32 bytes aleatorios) y **sin cambios
  desde el inicio del piloto**. Verificar: `GET /api/health` →
  `"telemetry_salt_configured": true`.
- [ ] `WORKER_HEARTBEAT_TOKEN` igual en el App Service y en los workers.
  Verificar: `"worker_heartbeat_configured": true` y, con una GPU encendida,
  `GET /api/agent/backend` → `alive_workers` ≥ 1.
- [ ] `DATABASE_URL` apunta a la base PostgreSQL del piloto (no a la de
  memoria). Verificar: `GET /api/health` → `"database_provider": "postgres"`.
- [ ] `DATABASE_SSL_MODE=require` (por verificar en la configuración).
- [ ] Sin `OPENAI_API_KEY` real en el App Service (las trazas del SDK de agentes
  solo se apagan con la clave `dummy` o una URL local).

### Google Cloud (proyecto `adaceen-508504`, `us-central1`)

- [ ] **Cuota de GPU:** «GPUs (all regions)» = 1 y la cuota de cada tipo que se
  va a usar (V100 bajo demanda, A100 Spot, L4 Spot). Verificar: consola → IAM y
  administración → Cuotas.
- [ ] **Política `vmExternalIpAccess`:** las VMs se crean sin IP pública y salen
  por Cloud NAT. Verificar: `gcloud compute routers nats list --router=adaceen-router --region=us-central1`
  lista `adaceen-nat`.
- [ ] **SSH por IAP:** `gcloud compute firewall-rules list --filter="name=allow-iap-ssh"`.
- [ ] **Créditos:** consola → Facturación → Créditos. El crédito de prueba de
  300 USD vence el 12 de diciembre de 2026.
- [ ] **Latido en la metadata de cada VM de GPU:** claves `heartbeat-url`
  (`https://<app>.azurewebsites.net/api/agent/heartbeat`) y `heartbeat-token`.
  `create-vm.sh` las pone y `clone-worker.sh` las copia de la L4; a las copias
  A100/V100 antiguas que no las tengan se las copia `actualizar-gpus.sh`.
  Verificar: `gcloud compute instances describe <vm> --zone=<zona> --format="value(metadata.items[].key)"`.
- [ ] **`startup-script` al día en cada GPU** (apagado por inactividad según el
  último trabajo, cambio de rama sin abortar, rotación del log):
  `bash deploy/gcp/actualizar-gpus.sh` después de cada cambio de
  `deploy/gcp/startup-script.sh`. A las copias A100/V100 sin metadata `branch`
  les copia la de la L4. Verificar: termina con «3 VM(s) actualizadas» y cada
  línea dice una rama cuyo worker manda latido (la de producción cuando esta
  tanda esté integrada; mientras tanto, la rama que tenga `deploy/clase.sh`).
  Si no: `RAMA=<esa rama> bash deploy/gcp/actualizar-gpus.sh`.
- [ ] **Cloud Shell con el repositorio** (`git clone -b feature/azure-config-observability https://github.com/eydersantiago/PDC.git`)
  para `deploy/clase.sh`. Verificar: `bash deploy/clase.sh estado` lista las
  GPU, la VM de editores y el estado del servicio.
- [ ] **VM de editores** creada (`deploy/gcp/workspaces/create-ws-vm.sh`),
  e2-standard-4, **sin Spot**, con el agente de entornos activo.
- [ ] **Agente conectado a PDC por el relay:** `WORKSPACE_AGENT_TOKEN` en el App
  Service igual a la metadata `workspace-agent-token` de la VM, sin
  `WORKSPACE_AGENT_URL`. Verificar: `GET /api/health` →
  `"workspace_agent_online": true` con la VM encendida.
- [ ] (Opcional) **Autoencendido de la VM de editores:**
  `bash deploy/gcp/crear-cuenta-autoencendido.sh` (rol con solo
  `compute.instances.get` y `compute.instances.start` sobre `adaceen-ws`) y
  la configuración en el App Service con el comando que imprime (con
  `RG=<grupo>` y `az` instalado en el mismo Cloud Shell, sin descargar la clave
  a otro equipo). Verificar: `GET /api/health` → `"workspace_vm_autostart": true`,
  y la copia local de la clave borrada. La clave también deja leer la metadata
  de `adaceen-ws` (incluido `workspace-agent-token`): si se filtra, revocarla y
  rotar `WORKSPACE_AGENT_TOKEN`.

### Mac del laboratorio (si se usan como servidores o como editor)

Guía completa: [worker-mac.md](worker-mac.md).

- [ ] **Política de Service Bus `worker-mac`** con solo Listen y Send, distinta
  de la de las GPU. Verificar: `az servicebus namespace authorization-rule show
  --resource-group <grupo> --namespace-name <namespace> --name worker-mac`.
- [ ] **Cada Mac instalada** con doble clic en
  `deploy/mac/Instalar-servidor-ADACEEN.command` (o
  `deploy/mac/instalar-worker-mac.sh --equipo=NN`): Apple Silicon, macOS 14 o
  superior y 16 GB o más. Verificar: doble clic en
  `deploy/mac/Estado-servidor-ADACEEN.command` (o `bash deploy/mac/worker-mac.sh
  estado`) → «Azure ve a mac-labNN-…: vivo».
- [ ] **Velocidad medida** en cada Mac (`bash deploy/mac/worker-mac.sh
  velocidad`). Las que pasen de 8 s se instalan con `--respaldo` o no se usan
  en sesiones del piloto.
- [ ] **Mismo modelo que la GPU** (`qwen2.5-coder:14b`) en todas: el monitor no
  muestra la alerta «servidores con modelos distintos».
- [ ] **Sistemas del laboratorio** enterados: equipos que no se duermen, sin
  borrado al reiniciar (disco congelado) o con la instalación en una partición
  que se conserve, y salida HTTPS (443) a `*.servicebus.windows.net`.
- [ ] **Si el editor es VS Code instalado:** en cada Mac de la sala (una vez por
  equipo o por usuario), doble clic en `Preparar-Mac-ADACEEN.command`, que se
  descarga de `$BACKEND/empezar`: comprueba `git` (abre el instalador de Apple si
  falta), instala VS Code si no está, deja el comando `code`, instala la
  extensión (0.0.31 o la que publique el backend) y abre `/empezar`
  ([worker-mac §11](worker-mac.md#11-mac-de-los-estudiantes-vs-code-con-doble-clic)).
  Verificar: el archivo termina con «listo: esta Mac ya esta preparada»; si
  falta `git`, terminar la instalación de Apple.
- [ ] **`git` y VS Code al día en las Mac de estudiantes, por soporte del
  laboratorio:** las herramientas de línea de comandos de Apple
  (`xcode-select --install`) piden clave de administrador, que un estudiante
  no tiene; y la extensión necesita VS Code 1.96 o más nuevo (con uno anterior,
  `Preparar-Mac-ADACEEN.command` dice que hay que actualizarlo). Verificar en
  una Terminal de la Mac: `git --version` responde sin abrir el instalador.
  Probar también, con un estudiante de prueba, «Abrir en VS Code de este
  equipo» en `/empezar`: si no abre VS Code, abrir VS Code una vez a mano.
- [ ] **Si se usa el clúster de Mac** (sección 9 de [worker-mac](worker-mac.md)):
  red aislada entre las Mac (cable Thunderbolt con IP fija o VLAN propia),
  misma `--version-llama` en todas, y `worker-mac.sh estado` en la coordinadora
  con `llama-server` listo y todos los nodos alcanzables. Velocidad medida:
  si pasa de 8 s, el clúster queda como respaldo.

## 2. Antes de cada sesión

### Red de la sala (desde un equipo de la sala)

- [ ] `https://vscode.dev` abre.
- [ ] `https://github.com` y `https://github.com/login/device` abren.
- [ ] `https://app-adaceen-api-eyder05232002.azurewebsites.net/api/health` responde JSON.
- [ ] Dev Tunnels: con un túnel de prueba, `https://vscode.dev/tunnel/<túnel>` conecta
  (el dominio del relay de Dev Tunnels no debe estar bloqueado por el proxy de la sala).
- [ ] Campus Virtual abre con la cuenta del docente (si la sesión lo usa).

### Servicio

- [ ] `bash deploy/clase.sh iniciar` en Cloud Shell al menos 10 minutos antes:
  termina con «clase lista» y el enlace `…/empezar` (GPU y VM de editores
  encendidas, agente conectado y latido de la GPU). Alternativa para la GPU:
  `ADACEEN-GPU.bat` (opción 1), y `GET /api/agent/health` → 200 y
  `alive_workers` ≥ 1.
- [ ] Modelo cargado (el arranque de la GPU lo precarga; la opción 1 del .bat
  manda además un trabajo de calentamiento) y prueba de humo en verde:
  `npm run demo:escenarios -- --url=<backend> --email=<estudiante de prueba> --password=<clave>`.
- [ ] Un túnel de prueba abre en `vscode.dev`.
- [ ] Si se usan Mac del laboratorio: en cada una doble clic en
  `Estado-servidor-ADACEEN.command` (Azure la ve viva y el modelo está en
  memoria), y el monitor muestra cuántos servidores de cada tipo hay vivos.
- [ ] Crédito disponible suficiente para la duración de la sesión.

### Estudiantes

- [ ] Extensión instalada y sesión iniciada (encabezado con su nombre).
- [ ] En `vscode.dev` iniciaron sesión **con GitHub**, no con una cuenta
  Microsoft (si no, `vscode.dev` dice que no encuentra el túnel).
- [ ] VS Code vinculado a su cuenta de ADACEEN, para que se aplique la política
  de su docente: en el túnel es automático (la VM deja la sesión); en una Mac,
  «Abrir en VS Code de este equipo» lo vincula. La barra de estado no debe decir
  «ADACEEN: sin conectar»; si lo dice, clic → «ADACEEN: Conectar» («Configurar
  sesión compartida» sigue sirviendo).
- [ ] Con VS Code instalado: el recuadro de «GPU: …» dice «Backend:
  https://app-adaceen-api-…» (no `127.0.0.1`), y el repositorio se abrió con
  «Abrir en VS Code de este equipo» o `git clone`.
