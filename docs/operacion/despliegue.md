# Despliegue a producción: rama del acceso simplificado

| | |
|---|---|
| Jira | A15.6 · ADACEEN-127 (evidencias de despliegue), A15.3 · ADACEEN-124 (entorno por túnel), A15.5 · ADACEEN-126 (rollback) |
| Qué se despliega | La rama `claude/serene-heisenberg-0te9s9` (`f510225` o un commit posterior de la misma tanda) sobre la rama de producción `feature/azure-config-observability`, que hoy está en `9f51643` |
| Dónde | PowerShell en Windows, en la carpeta de tu clon de `eydersantiago/PDC` (la ruta en tu equipo está por verificar; la sección 0 lo comprueba), para git; Google Cloud Shell (`https://shell.cloud.google.com`) para `gcloud`, `az` y los scripts de `deploy/` |
| Relacionados | [Prueba de inicio a fin](../piloto/prueba-inicio-a-fin.md), [pendientes](../piloto/pendientes.md), [evidencias](evidencias-despliegue.md), [contingencia y rollback](contingencia.md), [runbook](runbook.md), [túneles](../workspaces-tunnel.md), [contrato del acceso simplificado](../arquitectura/acceso-simplificado.md) |

Producción no tiene nada de las últimas cuatro tandas (`feat/cierre-pendientes-jira`,
`feat/segunda-tanda-jira`, `feat/macs-laboratorio` y el acceso simplificado): son 21
commits. En `9f51643` no existen el proveedor `tunnel`, las rutas `/api/workspaces/*`
ni el relay, así que hoy el editor por túnel no funciona contra producción. La rama de
producción es ancestro de esta, así que desplegar es un push sin `--force`.

`npm test` comprueba que los textos de interfaz, las rutas, los enlaces, los scripts y
las variables que cita esta guía existen en el repositorio
(`tests/scripts/docs-despliegue-prueba.test.ts`). Los comandos contra Azure y Google
Cloud no se pudieron correr desde aquí: si uno falla, anota el error en
[pendientes](../piloto/pendientes.md).

## Orden

| # | Dónde | Qué | Sección |
|---|---|---|---|
| 0 | PowerShell | Comprobar que el push será fast-forward y anotar el commit para volver atrás | [0](#0-antes-de-empezar-powershell) |
| 1 | Cloud Shell | Revisar y crear las variables del App Service | [1](#1-variables-del-app-service-cloud-shell) |
| 2 | PowerShell | Push a `feature/azure-config-observability` y seguir el flujo de GitHub Actions | [2](#2-push-que-despliega-powershell) |
| 3 | PowerShell o navegador | Verificar `/api/health`, `/empezar` y `/descargas/*` | [3](#3-verificar-el-backend) |
| 4 | Cloud Shell | VM de editores: rama, token del agente y `startup-ws.sh` nuevo | [4](#4-vm-de-editores-cloud-shell) |
| 5 | Cloud Shell | GPU: `startup-script.sh` nuevo y rama de producción | [5](#5-gpu-cloud-shell) |
| 6 | Navegadores y Mac | Extensión de navegador 0.7.11 y VS Code 0.0.31 | [6](#6-extensiones) |
| 7 | Repositorio | Registro del despliegue | [7](#7-registro) |

Si algo falla, [rollback](#8-rollback).

### Por qué en este orden

- **Variables antes del push.** El código de `9f51643` no lee ninguna de las variables
  nuevas (`PUBLIC_BASE_URL`, `ADACEEN_WORKSPACE_PROVIDER`, `WORKSPACE_AGENT_TOKEN`,
  `TELEMETRY_SALT`, `WORKER_HEARTBEAT_TOKEN`, `EDITOR_SESSION_TTL_DAYS`,
  `WORKSPACE_VM_*`): no existen en su `src/config/env.ts`. Cargarlas antes no cambia
  nada en producción, y el backend nuevo arranca ya configurado. Cada cambio de
  variables reinicia el App Service (alrededor de 1 minuto).
- **Backend antes que la VM de editores.**
  - La VM clona de GitHub la rama de su metadata `branch` (por defecto
    `feature/azure-config-observability`). Antes del push esa rama es `9f51643` y no
    trae el agente nuevo, `instalar-vsix.sh` ni `tunel-comun.sh`.
  - El agente de la VM se conecta al relay (`/api/workspaces/agent`), que solo existe
    en el backend nuevo: hasta el push no puede quedar `workspace_agent_online: true`.
  - El respaldo de `instalar-vsix.sh` es `<backend>/descargas/adaceen.vsix`, que publica
    el flujo de despliegue. La fuente principal (el VSIX 0.0.31 en el commit `b21231e`
    de `vscode-ext-prod`) ya responde 200 en `raw.githubusercontent.com`
    (comprobado el 25 de septiembre).
  - Al revés no funciona: con el backend nuevo y la VM vieja, el agente viejo ignora
    `editorSession` y VS Code queda «ADACEEN: sin conectar». Por eso los dos pasos van
    el mismo día y antes de la prueba.
- **GPU al final.** `actualizar-gpus.sh` no enciende ni reinicia nada: el cambio se
  aplica en el próximo arranque de cada GPU.
- **Extensiones después del backend.** La 0.7.11 y la 0.0.31 usan rutas que solo trae
  el backend nuevo (`/api/auth/editor/*`, `/api/workspaces/*`). Con el backend viejo,
  VS Code 0.0.31 solo acepta «Pegar sesión».

### Qué no hacer

- No uses `git push --force` en `feature/azure-config-observability`.
- No empujes a `master`: su flujo (`master_app-adaceen-api-eyder05232002.yml`) también
  despliega en el mismo App Service y lo dejaría con el código de `master`.
- No cambies `TELEMETRY_SALT` si ya existe.
- No pegues tokens ni claves en chats, capturas o documentos. Todos los comandos de
  esta guía los guardan en variables de la terminal y nunca los muestran.
- No corras el primer `startup-ws.sh` nuevo durante una clase: reinicia todos los
  túneles, y quien esté conectado se reconecta a los pocos segundos.
- No subas el App Service a más de una instancia. El relay, los limitadores y las
  preparaciones en curso viven en la memoria del proceso.

## 0. Antes de empezar (PowerShell)

```powershell
cd "<carpeta de tu clon de eydersantiago/PDC>"   # por verificar: la ruta en tu equipo
git remote get-url origin                    # debe terminar en eydersantiago/PDC (o eydersantiago/PDC.git)
git status                                   # sin cambios tuyos a medio hacer
git fetch origin
git switch claude/serene-heisenberg-0te9s9   # la crea desde origin si no existe
git pull --ff-only
git submodule update --init --recursive      # git switch y git pull no mueven el submódulo
git log -1 --oneline                         # f510225 o un commit posterior de esta tanda
git -C vscode-ext-prod rev-parse HEAD        # el mismo commit que muestra git ls-tree en el punto 3
```

Si `git remote get-url origin` no termina en `eydersantiago/PDC`, estás en otra
carpeta (por ejemplo la carpeta padre, que no es el repositorio): busca el clon antes
de seguir.

1. **El push será fast-forward.**

   ```powershell
   git merge-base --is-ancestor origin/feature/azure-config-observability HEAD
   $LASTEXITCODE                              # 0 = sí; 1 = no; 128 = error
   ```

   Si no es `0`, **para**: alguien empujó a producción algo que esta rama no tiene. No
   uses `--force`: integra primero ese commit en esta rama.

2. **Anota el commit actual de producción**, para poder volver atrás:

   ```powershell
   git rev-parse origin/feature/azure-config-observability
   ```

   El 25 de septiembre era `9f5164390fa52bc6547536cd06907db54f25ef07`. Anótalo en
   [evidencias](evidencias-despliegue.md), sección 4.

3. **El submódulo está en GitHub con su VSIX.** El flujo hace `checkout` con
   `submodules: recursive`: si el commit de `vscode-ext-prod` no está en GitHub, falla
   y no despliega nada.

   ```powershell
   git ls-tree HEAD vscode-ext-prod
   # 160000 commit b21231e1723e559b77b976e2116cc5ba12699a95  vscode-ext-prod
   curl.exe -sI https://raw.githubusercontent.com/eydersantiago/vscode-ext-prod/b21231e1723e559b77b976e2116cc5ba12699a95/adaceen-0.0.31.vsix
   ```

   Debe responder `200`. Si `git ls-tree` muestra otro commit, usa ese en la URL. Un
   404 significa que falta el `git add -f adaceen-0.0.31.vsix` y el push del submódulo
   ([túneles](../workspaces-tunnel.md), párrafo "Para publicar una version").

4. **Opcional: pruebas locales.** El flujo corre `npm run build` y `npm test` antes de
   desplegar, y si fallan no despliega. Para verlo antes: `npm ci`, `npm run build` y
   `npm test` (Node 22, como el flujo). Necesitan el submódulo al día (el
   `git submodule update` de arriba): con el de la 0.0.30 falla
   `tests/integration/acceso-simplificado.test.ts`, que importa
   `vscode-ext-prod/src/editor-session.ts`, y fallan las pruebas de textos de los
   documentos. Esos fallos no aparecen en el flujo, que hace `checkout` con
   `submodules: recursive`.

## 1. Variables del App Service (Cloud Shell)

Usa **una sola ventana de Google Cloud Shell** para esta sección y las secciones 4 y 5.
Así el token nuevo del agente (sección 4) va de Azure a la VM sin salir de la terminal.
Google Cloud Shell no trae `az`; se instala en la sesión (hay que repetirlo si la
sesión se reinicia):

```bash
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
az login --use-device-code
gcloud config set project adaceen-508504
RG=rg-adaceen-azure
APP=app-adaceen-api-eyder05232002
```

`rg-adaceen-azure` es el grupo que usa el paso `Restart Azure Web App` del flujo de
despliegue. Las variables también se pueden revisar en Azure Cloud Shell
(`https://shell.azure.com`, que ya trae `az`), pero ahí no hay `gcloud`.

**Siempre con `--output none`** en `appsettings set` y `appsettings delete`: sin eso,
`az` imprime todas las variables con sus valores, secretos incluidos.

### 1.1 Qué hay hoy (solo nombres)

```bash
az webapp config appsettings list -g $RG -n $APP --query "[].{nombre:name,vacia:value==''}" -o table
```

La tabla muestra cada nombre y si está vacío, sin los valores.

### 1.2 Qué revisar o crear

| Variable | Qué debe tener | Si no | Cómo se comprueba después del push |
|---|---|---|---|
| `ADACEEN_WORKSPACE_PROVIDER` | `tunnel` | Crearla (comando de abajo). Sin ella el proveedor es `codespaces` y el túnel no se usa | `/api/health` → `"workspace_provider": "tunnel"` |
| `PUBLIC_BASE_URL` | `https://app-adaceen-api-eyder05232002.azurewebsites.net` | Crearla. Sin ella se usa `PUBLIC_API_URL` y, si tampoco está, la URL de la petición | En la VM, `backendUrl` de `editor-session.json` (sección 4.5) |
| `WORKSPACE_AGENT_URL` | Vacía o ausente | Borrarla (comando de abajo). Con valor, el transporte es `direct` y Azure no llega a la VM, que no tiene IP pública | `/api/health` → `"workspace_agent_transport": "relay"` |
| `WORKSPACE_AGENT_TRANSPORT` | Vacía, ausente o `relay` | Borrarla o poner `relay` | Ídem |
| `WORKSPACE_AGENT_TOKEN` | El mismo valor que la metadata `workspace-agent-token` de `adaceen-ws` | Se crea o se rota en la sección 4.3, no aquí | `workspace_agent_online: true` tras la sección 4 |
| `TELEMETRY_SALT` | Un valor que **no cambia** durante el piloto | Si no existe: crearla (comando de abajo). Si existe: no tocarla | `"telemetry_salt_configured": true` |
| `WORKER_HEARTBEAT_TOKEN` | El mismo valor que la metadata `heartbeat-token` de las GPU (y que `~/.adaceen/worker.env` de las Mac) | Copiarlo de una GPU (1.4) | `"worker_heartbeat_configured": true`; con una GPU encendida, `model_workers_alive` ≥ 1 |
| `AGENT_TARGET` | `queue` | Revisar la configuración de la cola ([prerrequisitos](prerrequisitos.md)) | `"mode": "queue"`, `"queue_configured": true` |
| `ADACEEN_SCAN_WORKER_KEY` | Vacía o ausente | Si tiene valor: poner esa misma clave en la metadata `scan-worker-key` de la VM (1.4). Si no, el worker de escaneo del túnel recibe 401 | — |
| `ALLOWED_ORIGINS` | Vacía (se aceptan todos los orígenes) o una lista con los orígenes del overlay | Ver 1.5 | El overlay responde en GitHub, Campus y `vscode.dev` |
| `WORKSPACE_ALLOWED_LOGINS` | Opcional. Vacía o `*` deja pasar a cualquier estudiante con GitHub conectado; si es una lista, debe incluir los logins de la prueba | Poner `*` o agregar los logins | «Preparar mi editor» no responde «no esta en la lista del piloto» |
| `EDITOR_SESSION_TTL_DAYS` | Opcional (30 días si no está) | — | — |
| `WORKSPACE_VM_AUTOSTART`, `WORKSPACE_VM_PROJECT`, `WORKSPACE_VM_ZONE`, `WORKSPACE_VM_NAME`, `GCP_SERVICE_ACCOUNT_JSON` | Opcionales (autoencendido, 1.6) | Sin ellas, el docente enciende la VM con `bash deploy/clase.sh iniciar` | `"workspace_vm_autostart": true` |
| `GITHUB_OAUTH_SCOPES` | Sin cambios | — | — |

### 1.3 Comandos

Las que faltan, en un solo cambio (un solo reinicio):

```bash
az webapp config appsettings set -g $RG -n $APP --output none --settings \
  ADACEEN_WORKSPACE_PROVIDER=tunnel \
  PUBLIC_BASE_URL=https://app-adaceen-api-eyder05232002.azurewebsites.net
```

`WORKSPACE_AGENT_URL` con valor (solo si 1.1 la muestra):

```bash
az webapp config appsettings delete -g $RG -n $APP --setting-names WORKSPACE_AGENT_URL --output none
```

`TELEMETRY_SALT` **solo si no existe** (el valor no se muestra):

```bash
az webapp config appsettings set -g $RG -n $APP --output none --settings TELEMETRY_SALT="$(openssl rand -hex 32)"
```

`WORKSPACE_ALLOWED_LOGINS` abierta a todos (opcional):

```bash
az webapp config appsettings set -g $RG -n $APP --output none --settings 'WORKSPACE_ALLOWED_LOGINS=*'
```

### 1.4 Tokens compartidos con las VMs (sin mostrarlos)

Zonas de las GPU (las copias A100 y V100 pueden estar en otra zona):

```bash
gcloud compute instances list --filter="name~^adaceen-" --format="table(name,zone.basename(),status)"
```

**`WORKER_HEARTBEAT_TOKEN`.** Si ya existe, compara las huellas: los 12 caracteres
deben coincidir.

```bash
gcloud compute instances describe adaceen-worker --zone=<zona> --format="value(metadata.items.heartbeat-token)" | sha256sum | cut -c1-12
az webapp config appsettings list -g $RG -n $APP --query "[?name=='WORKER_HEARTBEAT_TOKEN'].value" -o tsv | sha256sum | cut -c1-12
```

Si no existe en Azure, cópialo de la GPU:

```bash
HB=$(gcloud compute instances describe adaceen-worker --zone=<zona> --format="value(metadata.items.heartbeat-token)")
[ -n "$HB" ] && az webapp config appsettings set -g $RG -n $APP --output none --settings WORKER_HEARTBEAT_TOKEN="$HB"
unset HB
```

Si la GPU tampoco lo tiene, ver `deploy/gcp/create-vm.sh` y la fila del latido en el
[runbook](runbook.md), sección 5.

**`ADACEEN_SCAN_WORKER_KEY`**, solo si 1.1 dice que tiene valor:

```bash
K=$(az webapp config appsettings list -g $RG -n $APP --query "[?name=='ADACEEN_SCAN_WORKER_KEY'].value" -o tsv)
gcloud compute instances add-metadata adaceen-ws --zone=us-central1-a --metadata=scan-worker-key="$K"
unset K
```

Esa clave llega a la terminal de cada estudiante (comentario de `startup-ws.sh`).

### 1.5 `ALLOWED_ORIGINS`

No es secreta; para ver su valor:

```bash
az webapp config appsettings list -g $RG -n $APP --query "[?name=='ALLOWED_ORIGINS'].value" -o tsv
```

- **Vacía:** no la toques para la prueba. CORS acepta cualquier origen con
  credenciales. Es un riesgo anterior a esta tanda, anotado en
  [pendientes](../piloto/pendientes.md).
- **Con valor:** debe incluir los orígenes donde corre el overlay
  (`browser-ext-prod/manifest.json`): `https://campusvirtual.univalle.edu.co`,
  `https://github.com`, `*.github.dev`, `https://vscode.dev` e
  `https://insiders.vscode.dev`. `*.dominio` cubre los subdominios
  (`isOriginAllowed` en `src/config/env.ts`). La extensión web de VS Code en
  `vscode.dev` sin túnel podría necesitar además el origen de sus iframes
  (`*.vscode-cdn.net`, por verificar en la consola del navegador). En el túnel,
  VS Code habla con el backend desde la VM y no pasa por CORS.

### 1.6 Autoencendido (opcional)

No hace falta para la prueba. Si lo quieres:

```bash
RG=rg-adaceen-azure bash deploy/gcp/crear-cuenta-autoencendido.sh
```

Se corre desde `~/PDC`, después de la sección 4.1. Crea una cuenta de servicio que
solo puede leer y encender `adaceen-ws`, y carga las cinco variables sin mostrar la
clave. Esa clave también deja leer la metadata de la VM, incluido
`workspace-agent-token`. Si se filtra: revocarla y rotar el token
([runbook](runbook.md), sección 0).

### 1.7 Una sola instancia

```bash
az appservice plan show --ids "$(az webapp show -g $RG -n $APP --query appServicePlanId -o tsv)" --query sku.capacity -o tsv
```

Debe dar `1`. Revisa también que no haya una regla de escalado automático en el portal
(App Service → Escalar horizontalmente; por verificar).

## 2. Push que despliega (PowerShell)

```powershell
git push origin claude/serene-heisenberg-0te9s9:feature/azure-config-observability
```

Debe decir `9f51643..<commit>  claude/serene-heisenberg-0te9s9 -> feature/azure-config-observability`.
Si dice `rejected` o `non-fast-forward`, **para** y vuelve a la sección 0. No uses
`--force`.

**Seguir el flujo:** `https://github.com/eydersantiago/PDC/actions/workflows/feature-azure-config-observability_app-adaceen-api-eyder05232002.yml`,
la ejecución con el mensaje del último commit. Hay dos flujos con el mismo nombre
(«Build and deploy Node.js app to Azure Web App - app-adaceen-api-eyder05232002»): el
de producción es el de ese archivo. Con la CLI de GitHub (`gh`, si está instalada):
`gh run watch`.

| Paso del flujo | Qué mirar |
|---|---|
| `npm install, build, and test` | Todas las pruebas en verde. Si falla, no se despliega nada y producción sigue en `9f51643` |
| `Build ADACEEN VSIX` | Genera `adaceen-0.0.31.vsix` |
| `Create deployment package` | El `ls -la deploy-package/descargas` lista `adaceen-navegador.zip`, `Preparar-Mac-ADACEEN.command`, `Preparar-Mac-ADACEEN.zip` y `versiones.json`. Un aviso `No se pudo empaquetar la extension de navegador` significa que `/descargas/adaceen-navegador.zip` no queda publicado (el despliegue sigue) |
| `Deploy to Azure Web App`, `Restart Azure Web App` | Sin errores |
| `Verify privacy policy route` | Cada intento imprime `/api/health`. Termina cuando `/privacy-policy` responde 200 |

Las últimas cinco ejecuciones tardaron entre 3 y 5 minutos. Esta tiene más pruebas
y empaqueta más archivos: puede tardar algo más. Justo después, Azure puede responder
un rato con la versión anterior o tardar mientras reinicia (AGENTS.md).

## 3. Verificar el backend

```powershell
$B = "https://app-adaceen-api-eyder05232002.azurewebsites.net"
Invoke-RestMethod "$B/api/health" | Select-Object ok,mode,queue_configured,database_provider,telemetry_salt_configured,worker_heartbeat_configured,workspace_provider,workspace_agent_transport,workspace_agent_online,workspace_vm_autostart,model_workers_alive,model_workers_known_down
```

(En Windows PowerShell 5.1, `curl` es otro comando: usa `curl.exe` o `Invoke-RestMethod`.)

| Campo | Esperado ahora | Nota |
|---|---|---|
| `ok` | `True` | — |
| `mode`, `queue_configured` | `queue`, `True` | — |
| `database_provider` | `postgres` | La migración (columnas nuevas de `app_sessions` y la tabla `editor_pairing_codes`) corre sola al arrancar y solo agrega |
| `telemetry_salt_configured`, `worker_heartbeat_configured` | `True`, `True` | Ninguno de estos campos existe en `9f51643`: si aparecen, está la versión nueva |
| `workspace_provider`, `workspace_agent_transport` | `tunnel`, `relay` | — |
| `workspace_agent_online` | `False` hasta la sección 4, `True` después | — |
| `workspace_vm_autostart` | `False`, o `True` con 1.6 | — |
| `model_workers_alive`, `model_workers_known_down` | `0` y `False` con las GPU apagadas | — |

**Página de inicio.** Abre `$B/empezar` en el navegador. Debe mostrar «Empieza con
ADACEEN», la sección «Estado» y los botones «Descargar la extension» («zip, version
<versión>», que debe ser 0.7.11), «Preparar Mac del laboratorio» y «Descargar extension
de VS Code» («VSIX, version <versión>», que debe ser 0.0.31). Un archivo que no se publicó aparece como «todavia no esta publicado
en este servidor. Avisa al docente.».

**Descargas:**

```powershell
curl.exe -sI "$B/descargas/adaceen-navegador.zip"
curl.exe -sI "$B/descargas/adaceen.vsix"
curl.exe -sI "$B/descargas/Preparar-Mac-ADACEEN.zip"
```

Cada una debe dar `200` con `Content-Disposition: attachment; filename="…"`. Un 404
significa que el flujo no la empaquetó (sección 2). El zip del navegador es
reproducible: construido desde `f510225`, su SHA-256 es
`2ec93765cba81fd48c6f7fc4752da9bb4d6814460a9854faab013096ad7e7668`, si ningún commit
posterior tocó `browser-ext-prod` (por verificar contra el publicado):

```powershell
curl.exe -sS -o "$env:TEMP\adaceen-navegador.zip" "$B/descargas/adaceen-navegador.zip"
Get-FileHash "$env:TEMP\adaceen-navegador.zip" -Algorithm SHA256
```

## 4. VM de editores (Cloud Shell)

### 4.1 Repositorio en Cloud Shell

```bash
cd ~ && [ -d PDC ] || git clone https://github.com/eydersantiago/PDC.git
cd ~/PDC && git fetch origin && git checkout feature/azure-config-observability && git pull --ff-only
git log -1 --oneline          # el commit que acabas de desplegar
bash deploy/clase.sh estado   # encuentra las 3 GPU y adaceen-ws
```

### 4.2 Guardar lo de antes (para volver atrás)

```bash
gcloud compute instances describe adaceen-ws --zone=us-central1-a --format="value(status,metadata.items.branch)"
gcloud compute instances describe adaceen-ws --zone=us-central1-a --format=json \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next((i["value"] for i in d["metadata"]["items"] if i["key"]=="startup-script"), ""))' \
  > ~/startup-ws-anterior.sh
```

Anota la rama. Si sale vacía, la VM usa la que tenga por defecto el script que acabas
de guardar, que depende de la tanda de la que venga (en `9f51643` es
`feat/workspace-tunnel`; en esta rama, `feature/azure-config-observability`). Para
verla:

```bash
grep 'BRANCH=' ~/startup-ws-anterior.sh     # BRANCH=${BRANCH:-<rama por defecto>}
```

El script de arranque no tiene secretos: los lee de la metadata al correr.

### 4.3 Rama, token del agente y `startup-ws.sh`

Fuera de clase. Entre el cambio en Azure y el de la VM, «Preparar mi editor» no
funciona (PDC y el agente no se reconocen).

Primero comprueba que `az` sigue listo. Entre la sección 1 y esta pasan el push, el
flujo y las verificaciones, y en ese tiempo Cloud Shell se puede reiniciar (se pierden
`az`, `$RG` y `$APP`) o vencer el `az login`:

```bash
cd ~/PDC
command -v az >/dev/null && [ -n "$RG" ] && [ -n "$APP" ] && az account show -o none && echo "az listo"
```

Si no imprime `az listo`, repite el primer bloque de la sección 1 (instalar `az`,
`az login`, `RG` y `APP`). Luego, la rama y el token encadenados con `&&`: si `az`
falla, la VM no recibe el token nuevo y los dos lados siguen con el mismo.

```bash
gcloud compute instances add-metadata adaceen-ws --zone=us-central1-a --metadata=branch=feature/azure-config-observability
TOKEN=$(openssl rand -hex 32) \
  && az webapp config appsettings set -g $RG -n $APP --output none --settings WORKSPACE_AGENT_TOKEN="$TOKEN" \
  && gcloud compute instances add-metadata adaceen-ws --zone=us-central1-a \
       --metadata=workspace-agent-token="$TOKEN" \
       --metadata-from-file=startup-script=deploy/gcp/workspaces/startup-ws.sh \
  && echo "token rotado en Azure y en la VM"
unset TOKEN
```

Si no aparece `token rotado en Azure y en la VM`, repite este bloque completo: genera
otro token y lo pone en los dos lados.

Se rota el token porque antes de esta tanda un estudiante podía leerlo desde su
terminal ([túneles](../workspaces-tunnel.md), "Seguridad de la VM").

### 4.4 Correr el arranque nuevo

La VM ejecuta el `startup-script` de su metadata, no el del repositorio.

- **Si está `RUNNING`:**

  ```bash
  gcloud compute ssh adaceen-ws --zone=us-central1-a --tunnel-through-iap \
    --command='sudo google_metadata_script_runner startup; sudo tail -n 30 /var/log/adaceen-ws-startup.log'
  ```

- **Si está `TERMINATED`:** `gcloud compute instances start adaceen-ws --zone=us-central1-a`
  (el arranque corre solo). A los 2 o 3 minutos:
  `gcloud compute ssh adaceen-ws --zone=us-central1-a --tunnel-through-iap --command='sudo tail -n 30 /var/log/adaceen-ws-startup.log'`.

En el log deben aparecer, en este orden:

```text
--- PDC feature/azure-config-observability @ <commit corto>
--- VSIX adaceen 0.0.31 instalado en /opt/adaceen/adaceen.vsix (…)     (o «… ya instalado …»)
--- agente de entornos en … (puerto 8787); relay https://app-adaceen-api-eyder05232002.azurewebsites.net/api/workspaces/agent
=== listo. api=https://app-adaceen-api-eyder05232002.azurewebsites.net idle=120min extension=/opt/adaceen/adaceen.vsix ===
```

| Si el log dice | Qué pasa | Qué hacer |
|---|---|---|
| `--- AVISO VSIX: …` | Quedó el VSIX anterior (0.0.30 no lee `editor-session.json`) | Sección 0.3; luego volver a correr 4.4 |
| `--- AVISO: sin metadata workspace-agent-token; agente de entornos apagado` | Falló el `add-metadata` de 4.3 | Repetir 4.3 |
| `--- AVISO: la rama … no trae deploy/gcp/workspaces/agente` | La metadata `branch` apunta a otra rama | Repetir 4.3 |

### 4.5 Comprobar

```bash
curl -sS https://app-adaceen-api-eyder05232002.azurewebsites.net/api/health | python3 -m json.tool | grep workspace_agent
gcloud compute ssh adaceen-ws --zone=us-central1-a --tunnel-through-iap \
  --command='systemctl is-active adaceen-ws-metadata adaceen-workspaces-agent; sudo journalctl -u adaceen-workspaces-agent -n 20 --no-pager'
bash deploy/clase.sh estado
```

- `"workspace_agent_online": true` (en 1 a 2 minutos) y `"workspace_agent_transport": "relay"`.
- `active` dos veces, y la línea «conectado al relay» en el journal, sin avisos de
  token rechazado. Si el journal dice «el relay rechazo el token», Azure y la VM tienen
  tokens distintos (por ejemplo, falló un paso de 4.3): repite 4.3 completo y luego
  4.4.
- `clase.sh estado`: `editor: listo (agente de adaceen-ws conectado)`.

Después del primer «Preparar mi editor» real (paso P1.4 de la
[prueba](../piloto/prueba-inicio-a-fin.md)), con `<login>` el usuario de GitHub en
minúsculas:

```bash
gcloud compute ssh adaceen-ws --zone=us-central1-a --tunnel-through-iap --command='
  sudo ls -l /home/ws-<login>/.adaceen/editor-session.json;
  sudo jq -r .backendUrl /home/ws-<login>/.adaceen/editor-session.json;
  sudo journalctl -u adaceen-workspaces-agent -n 50 --no-pager | grep "sesion del editor escrita";
  sudo -u ws-<login> curl -s -m 3 -H "Metadata-Flavor: Google" http://169.254.169.254/ && echo "MAL: el estudiante lee la metadata" || echo "bien: metadata bloqueada"'
```

- El archivo: `-rw-------`, dueño `ws-<login>`.
- `backendUrl`: `https://app-adaceen-api-eyder05232002.azurewebsites.net` (`jq` muestra
  solo ese campo, nunca el `sessionId`).
- La línea «sesion del editor escrita» aparece sin el id.
- `bien: metadata bloqueada`.

Opcional, ya no se usa: `gcloud compute instances remove-metadata adaceen-ws --zone=us-central1-a --keys=worker-secret`
(solo en `adaceen-ws`; las GPU sí usan su `worker-secret`).

## 5. GPU (Cloud Shell)

Primero anota la rama y el `worker-id` de cada GPU (para volver atrás y para
`clase.sh`):

```bash
for vm in adaceen-worker-v100 adaceen-worker-a100 adaceen-worker; do
  zona=$(gcloud compute instances list --filter="name=$vm" --format="value(zone.basename())")
  [ -n "$zona" ] && echo "$vm $zona $(gcloud compute instances describe $vm --zone=$zona --format='value(metadata.items.worker-id,metadata.items.branch)')"
done
```

`worker-id` debe empezar por `gce-` (`gce-v100`, `gce-a100`, `gce-l4`): así
`clase.sh` reconoce la GPU en `/api/agent/backend`. Si no:
`gcloud compute instances add-metadata <vm> --zone=<zona> --metadata=worker-id=gce-<perfil>`.

```bash
RAMA=feature/azure-config-observability bash deploy/gcp/actualizar-gpus.sh
```

Esperado, una línea por GPU y el total:

```text
[adaceen] ✓ adaceen-worker-v100 (<zona>): startup-script al dia, rama feature/azure-config-observability
[adaceen] 3 VM(s) actualizadas. Toman el cambio en su proximo arranque (bash deploy/clase.sh iniciar).
```

Algunas líneas pueden terminar en `, latido copiado de adaceen-worker`. Si aparece
`AVISO: <vm> no tiene heartbeat-token`, esa GPU no manda latido y `clase.sh` no la ve
([runbook](runbook.md), sección 5). No enciende nada: el cambio vale desde el próximo
`bash deploy/clase.sh iniciar`, que debe terminar con
`modelo: 1 servidor(es) vivo(s): gce-…`.

## 6. Extensiones

- **Navegador 0.7.11.** En cada navegador del laboratorio y en el tuyo: descargar
  «Descargar la extension» de `/empezar`, reemplazar la carpeta y pulsar recargar en
  `chrome://extensions`. `/empezar` muestra «Instalada» con «lista (version
  <versión>).» (0.7.11), o «Actualizar» si la versión es anterior. Si cargas la extensión desde
  una carpeta fuera del repositorio (AGENTS.md), reemplázala también.
- **VS Code 0.0.31.**
  - En la VM de editores la instala la sección 4.
  - En cada Mac: doble clic otra vez en `Preparar-Mac-ADACEEN.command`, que actualiza
    la extensión.
  - En otro equipo: «Descargar extension de VS Code» y «Instalar desde VSIX».
  - Con la 0.0.30, el enlace `vscode://adaceen.adaceen/abrir` no hace nada.

## 7. Registro

En [evidencias de despliegue](evidencias-despliegue.md), sección 4:

- una fila con la fecha, el commit desplegado, 0.7.11, 0.0.31 y la GPU;
- en la columna "Observaciones", el commit anterior (`9f51643`), la rama anterior de `adaceen-ws`
  y la de cada GPU;
- capturas 5 (flujo), 15 (relay) y 16 a 18.

## 8. Rollback

| Pieza | Cómo volver atrás |
|---|---|
| Backend | 8.1: un commit que restaura el árbol anterior y un push normal, sin `--force`. No uses la ejecución manual del flujo (8.2) |
| Variables | Dejarlas: el código de `9f51643` no las lee. Si cambiaste `WORKSPACE_ALLOWED_LOGINS` o `ALLOWED_ORIGINS`, vuelve al valor anterior. **Nunca** cambies `TELEMETRY_SALT` |
| Base de datos | Nada: los cambios solo agregan columnas y tablas, y `kind` tiene `default 'browser'`, así que el código anterior sigue funcionando ([contingencia](contingencia.md), sección 8) |
| VM de editores | Si en 4.2 anotaste una rama: `gcloud compute instances add-metadata adaceen-ws --zone=us-central1-a --metadata=branch=<rama anotada en 4.2> --metadata-from-file=startup-script=$HOME/startup-ws-anterior.sh`. Si estaba vacía: `gcloud compute instances add-metadata adaceen-ws --zone=us-central1-a --metadata-from-file=startup-script=$HOME/startup-ws-anterior.sh` y `gcloud compute instances remove-metadata adaceen-ws --zone=us-central1-a --keys=branch`, para que vuelva a mandar la rama por defecto de ese script. Luego 4.4 |
| GPU | `RAMA=<rama anotada> bash deploy/gcp/actualizar-gpus.sh` (vale desde el próximo arranque) |
| Extensiones | Zip y VSIX anteriores ([contingencia](contingencia.md), sección 8) |

**Qué se pierde al volver a `9f51643`:** esa versión no tiene túnel, relay, sesiones de
editor ni `/empezar`. El editor vuelve a ser Codespaces (con la GitHub App), y la
telemetría v1.1 y el piloto con y sin tutor tampoco existen ahí. Los commits
intermedios (por ejemplo `b58f97b`, final de `feat/macs-laboratorio`, con túnel y relay
pero sin sesiones de editor) nunca se probaron en Azure.

### 8.1 Commit que restaura el árbol anterior (plan principal)

```powershell
git fetch origin
git switch -c volver-a-9f51643 origin/feature/azure-config-observability
git read-tree -u --reset 9f5164390fa52bc6547536cd06907db54f25ef07
git commit -m "revert: produccion vuelve al arbol de 9f51643"
git push origin volver-a-9f51643:feature/azure-config-observability
```

Es un commit nuevo encima de producción (fast-forward), con los archivos, el flujo y el
puntero del submódulo de `9f51643`. Se probó en un clon local el 25 de septiembre:
después del commit, `git diff 9f51643 HEAD` sale vacío. El push dispara el despliegue
normal desde la misma rama de siempre, así que el inicio de sesión en Azure del flujo
no cambia. Tarda lo mismo que un despliegue (sección 2). Para volver después a lo
nuevo: `git revert <ese commit>` en la misma rama y push.

### 8.2 Ejecución manual del flujo (no usar)

El archivo del flujo tiene `workflow_dispatch`, pero ejecutarlo a mano desde otra rama
(por ejemplo, una rama `rollback-produccion` en `9f51643`) tiene dos problemas:

- **El inicio de sesión en Azure probablemente falla.** El trabajo `deploy` entra con
  `azure/login@v2` por OIDC (`client-id`, `tenant-id` y `subscription-id`, con
  `id-token: write`) y no declara `environment:`, así que Azure recibe la rama como
  sujeto del token. El flujo lo generó el Centro de implementación de Azure (commit
  `956e085`), y la credencial federada que crea ese asistente queda atada a la rama
  configurada. Desde otra rama, el paso `Login to Azure` fallaría después de la
  compilación, a los 3 o 4 minutos, aunque `gh workflow run` no dé error. **Por
  verificar** en Azure: identidad del flujo → Credenciales federadas (qué ramas
  acepta).
- **Puede que ni siquiera se pueda lanzar.** Según la documentación de GitHub (por
  verificar en este repositorio), `workflow_dispatch` necesita el archivo del flujo en
  la rama por defecto (`master`), y en `master` (`6b27925`) solo está
  `master_app-adaceen-api-eyder05232002.yml`.
  Además, este flujo nunca se corrió a mano: en GitHub hay cero ejecuciones con
  `workflow_dispatch`.

En una incidencia usa 8.1.
