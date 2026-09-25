# Despliegue a producción: rama del acceso simplificado

| | |
|---|---|
| Jira | A15.6 · ADACEEN-127 (evidencias de despliegue), A15.3 · ADACEEN-124 (entorno por túnel), A15.5 · ADACEEN-126 (rollback) |
| Qué se despliega | La rama `claude/serene-heisenberg-0te9s9` (su último commit) sobre la rama de producción `feature/azure-config-observability`, que hoy está en `9f51643` |
| Dónde | PowerShell en Windows, en la carpeta de tu clon de `eydersantiago/PDC` (la ruta en tu equipo está por verificar; la sección 0 lo comprueba), para git; Google Cloud Shell (`https://shell.cloud.google.com`) para `bash deploy/produccion.sh`, que usa `gcloud` y `az` |
| Relacionados | [Prueba de inicio a fin](../piloto/prueba-inicio-a-fin.md), [pendientes](../piloto/pendientes.md), [evidencias](evidencias-despliegue.md), [contingencia y rollback](contingencia.md), [runbook](runbook.md), [túneles](../workspaces-tunnel.md), [contrato del acceso simplificado](../arquitectura/acceso-simplificado.md) |

Producción no tiene nada de las últimas cuatro tandas (`feat/cierre-pendientes-jira`,
`feat/segunda-tanda-jira`, `feat/macs-laboratorio` y el acceso simplificado): son 21
commits. En `9f51643` no existen el proveedor `tunnel`, las rutas `/api/workspaces/*`
ni el relay, así que hoy el editor por túnel no funciona contra producción. La rama de
producción es ancestro de esta, así que desplegar es un push sin `--force`.

`npm test` comprueba que los textos de interfaz, las rutas, los enlaces, los scripts y
las variables que cita esta guía existen en el repositorio
(`tests/scripts/docs-despliegue-prueba.test.ts`). `deploy/produccion.sh` se probó con
`gcloud`, `az` y `git` falsos (`node --test deploy/produccion.test.mjs`), no contra
Azure ni Google Cloud: si algo falla, anota el error en
[pendientes](../piloto/pendientes.md) y sigue con el [anexo](#anexo-procedimiento-manual-si-el-script-falla),
que es el mismo procedimiento a mano.

## Camino corto

| Paso | Dónde | Qué | Sección |
|---|---|---|---|
| 1 | PowerShell | Comprobar que el push será fast-forward y anotar el commit para volver atrás | [0](#0-antes-de-empezar-powershell) |
| 2 | Cloud Shell | Preparar la terminal y `bash deploy/produccion.sh revisar` (solo lee) | [Revisar](#revisar-cloud-shell) |
| 3 | Cloud Shell y PowerShell | `bash deploy/produccion.sh aplicar`; cuando diga «falta el push», el push | [Aplicar](#aplicar-cloud-shell) y [2](#2-push-que-despliega-powershell) |
| 4 | Cloud Shell y navegador | `bash deploy/produccion.sh verificar` y mirar `/empezar` | [Verificar](#verificar-cloud-shell) |
| 5 | Navegadores y Mac | Extensión de navegador 0.7.11 y VS Code 0.0.31 | [6](#6-extensiones) |
| 6 | Repositorio | Registro del despliegue | [7](#7-registro) |

Toda la parte de Cloud Shell, en una sola ventana. **Pega y corre un comando a la vez**
y espera a que termine antes de pegar el siguiente: `az login` y `aplicar` pueden hacer
preguntas, y una línea pegada de más contestaría por ti. (`aplicar` descarta lo que se
pegó antes de su pregunta y lo avisa, pero esas líneas no se ejecutan.)

1. `curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash` (Cloud Shell de Google no
   trae `az`)
2. `az login --use-device-code`
3. `gcloud config set project adaceen-508504`
4. `cd ~ && [ -d PDC ] || git clone https://github.com/eydersantiago/PDC.git`
5. `cd ~/PDC && git fetch origin && git checkout claude/serene-heisenberg-0te9s9 && git pull --ff-only`
6. `bash deploy/produccion.sh revisar` (solo lee)
7. `bash deploy/produccion.sh aplicar` (cuando diga «falta el push», el push en
   PowerShell)
8. `bash deploy/produccion.sh verificar`

Si algo falla: el [anexo](#anexo-procedimiento-manual-si-el-script-falla) hace lo mismo a
mano, sección por sección, y el [rollback](#8-rollback) vuelve atrás.

### Por qué en este orden

`aplicar` sigue este orden: carga las variables, espera a que Azure muestre la versión
nueva y solo entonces toca la VM de editores y, al final, las GPU.

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
  túneles, y quien esté conectado se reconecta a los pocos segundos. `aplicar` lo
  avisa y pide confirmación antes de rotar el token y subir el `startup-ws.sh`.
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
git log -1 --oneline                         # el último commit de la rama (igual que en GitHub)
git ls-tree HEAD deploy/produccion.sh        # debe listar el archivo (el camino corto lo usa)
git -C vscode-ext-prod rev-parse HEAD        # el mismo commit que muestra git ls-tree en el punto 3
```

Si `git ls-tree HEAD deploy/produccion.sh` no lista nada, esta rama todavía no trae el
script y en Cloud Shell `bash deploy/produccion.sh` fallaría (`No such file or
directory`). No sigas con el camino corto: usa el
[anexo](#anexo-procedimiento-manual-si-el-script-falla).

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

## Revisar (Cloud Shell)

Usa **una sola ventana de Google Cloud Shell** para esta sección, la siguiente y la de
verificar. Google Cloud Shell no trae `az`: se instala en la sesión, y hay que
repetirlo si la sesión se reinicia (`revisar` lo detecta y muestra el comando). Pega y
corre una línea a la vez: si la cuenta tiene varias suscripciones, `az login` puede
preguntar cuál usar, y la línea siguiente, si ya está pegada, contestaría esa pregunta.

```bash
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
az login --use-device-code
gcloud config set project adaceen-508504
cd ~ && [ -d PDC ] || git clone https://github.com/eydersantiago/PDC.git
cd ~/PDC && git fetch origin && git checkout claude/serene-heisenberg-0te9s9 && git pull --ff-only
git log -1 --oneline          # el mismo commit que muestra git log -1 en PowerShell (sección 0)
bash deploy/produccion.sh revisar
```

Antes del push, `feature/azure-config-observability` (`9f51643`) no trae
`deploy/produccion.sh`: por eso `~/PDC` va en `claude/serene-heisenberg-0te9s9`. Después
del push las dos ramas están en el mismo commit, y el script compara commits, no
nombres de rama. `bash deploy/produccion.sh` sin acción también es `revisar`.

`revisar` no cambia nada: no escribe en Azure ni en la metadata de las VMs y no entra
por IAP. Muestra, por bloques:

| Bloque | Qué dice |
|---|---|
| herramientas | `gcloud`, `curl`, `python3` y `git`; `az` con la sesión iniciada (si falta, el comando para instalarlo o `az login --use-device-code`) |
| repositorio | El commit de `~/PDC` y el de `feature/azure-config-observability` en GitHub: antes del push, «el push sera fast-forward» y el comando del push; después, «es lo desplegado en» |
| App Service | Las variables de la tabla [1.2](#12-qué-revisar-o-crear) con `ausente`, `vacia` o `con valor` (nunca el valor) y qué haría `aplicar`. De las cinco de autoencendido muestra `WORKSPACE_VM_AUTOSTART` y cuántas tienen valor; `GITHUB_OAUTH_SCOPES` no aparece. Y si el plan tiene una sola instancia |
| `/api/health` | Si la versión desplegada es la nueva (trae `workspace_vm_autostart`, campo que solo existe desde `5d94351`) y los campos de la sección [3](#3-verificar-el-backend) |
| VM de editores y GPU | Estado, rama (`branch`), `worker-id` y si su `startup-script` es el de `~/PDC` |
| huellas | Los 12 primeros caracteres del SHA-256 de `WORKSPACE_AGENT_TOKEN`, `WORKER_HEARTBEAT_TOKEN` y `ADACEEN_SCAN_WORKER_KEY`, en Azure y en la metadata de cada VM. Iguales = mismo valor. Son las mismas huellas que dan los comandos de [1.4](#14-tokens-compartidos-con-las-vms-sin-mostrarlos) |
| plan | La lista numerada de lo que haría `aplicar`, en su orden |

Termina con «revisar no cambio nada» o, si algo impide aplicar, con «antes de aplicar:»
y el motivo (por ejemplo, `az` sin sesión o `~/PDC` en otro commit).

Revisa a mano, porque el script no lo ve: que no haya una regla de escalado automático
en el portal (App Service → Escalar horizontalmente; por verificar), y la tabla de
[1.2](#12-qué-revisar-o-crear) para lo opcional (`WORKSPACE_ALLOWED_LOGINS`,
`ALLOWED_ORIGINS`, autoencendido).

## Aplicar (Cloud Shell)

Fuera de clase:

```bash
bash deploy/produccion.sh aplicar
```

Se puede correr antes del push: carga las variables y se queda esperando. Cuando dice
«falta el push», haz la sección [2](#2-push-que-despliega-powershell) en PowerShell;
`aplicar` sigue solo cuando Azure muestra la versión nueva. Se puede repetir las veces
que haga falta: compara lo que hay y solo hace lo que falta (la segunda vez no cambia
nada).

Qué hace, en orden (entre paréntesis, la sección del anexo que hace lo mismo a mano):

1. **Comprueba antes de cambiar nada:** `az` con sesión, `~/PDC` en el commit que se
   despliega (o con el push pendiente), que existe `adaceen-ws` y que `az` puede leer
   las variables. Si algo falla, corta sin tocar nada.
2. **Variables** ([1.3](#13-comandos) y [1.4](#14-tokens-compartidos-con-las-vms-sin-mostrarlos)):
   un solo `az webapp config appsettings set --output none` con las que faltan:
   `ADACEEN_WORKSPACE_PROVIDER=tunnel`, `PUBLIC_BASE_URL`,
   `WORKSPACE_AGENT_TRANSPORT=relay` (solo si tenía otro valor), `TELEMETRY_SALT` (solo
   si no existe) y `WORKER_HEARTBEAT_TOKEN` copiado de la metadata `heartbeat-token` de
   la primera GPU con `heartbeat-url` y `heartbeat-token` (en el orden de
   `deploy/clase.sh`; es la misma GPU de la que `actualizar-gpus.sh` copia el latido a
   las que no lo tienen). Después borra `WORKSPACE_AGENT_URL` si tiene valor. Si `az`
   falla, corta: la VM y las GPU no se tocan.
3. **Espera la versión nueva** (hasta 15 minutos; `ESPERA_MAX` en segundos): que
   `/api/health` traiga `workspace_vm_autostart` con `workspace_provider: tunnel` y
   `workspace_agent_transport: relay`. Si el push no llegó, corta con
   «todavia no se hizo el push» sin tocar la VM ni las GPU: haz el push y vuelve a
   correr `aplicar`.
4. **Comprueba otra vez** que `~/PDC` es exactamente el commit desplegado y sin cambios
   en los scripts de arranque (los que se suben a la metadata salen de ahí) y que `az`
   sigue con sesión.
5. **Pide confirmación** antes de rotar el token («No lo hagas durante una clase»). Sin
   terminal, o para no preguntar: `CONFIRMAR=1 bash deploy/produccion.sh aplicar`.
6. **Respaldo** ([4.2](#42-guardar-lo-de-antes-para-volver-atrás)) en
   `~/adaceen-respaldo-<fecha>/`: la rama y el `startup-script` de `adaceen-ws`
   (`startup-ws-anterior.sh`), la rama y el `worker-id` de cada GPU, los nombres de las
   variables de Azure (sin valores) y `volver-atras.txt` con los comandos de la sección
   [8](#8-rollback) ya completos.
7. **`scan-worker-key`** ([1.4](#14-tokens-compartidos-con-las-vms-sin-mostrarlos)),
   solo si Azure tiene `ADACEEN_SCAN_WORKER_KEY` con valor y la VM no tiene la misma.
8. **Rama, token y `startup-ws.sh`** ([4.3](#43-rama-token-del-agente-y-startup-wssh)),
   en una sola cadena: token nuevo, luego Azure y luego la metadata de `adaceen-ws`
   (`branch=feature/azure-config-observability`, `workspace-agent-token` y el
   `startup-ws.sh` de `~/PDC`). Si `az` falla, la VM no recibe nada y los dos lados
   siguen con el mismo token. No rota si la VM ya tiene el `startup-ws.sh` nuevo y el
   mismo token que Azure: por eso repetir `aplicar` no vuelve a rotar. Si solo falta la
   rama, cambia `branch` sin rotar ni preguntar.
9. **Arranque** ([4.4](#44-correr-el-arranque-nuevo)): con la VM `RUNNING`, lo corre por
   IAP y muestra las líneas `---` y `===` del último arranque. Con la VM apagada no la
   enciende: el arranque corre la próxima vez que se encienda
   (`bash deploy/clase.sh iniciar`), o ya mismo con
   `bash deploy/produccion.sh aplicar --encender-vm`.
10. **Espera** `workspace_agent_online: true` (1 a 2 minutos; Azure se reinicia tras el
    cambio de token).
11. **GPU** ([5](#5-gpu-cloud-shell)): `RAMA=feature/azure-config-observability bash deploy/gcp/actualizar-gpus.sh`,
    solo si alguna GPU no tiene el `startup-script` de `~/PDC`, esa rama o el latido. No
    enciende nada. Una GPU que ya tiene un `heartbeat-token` distinto del de Azure no
    se cambia: `aplicar` lo marca con ✗ y termina con pendientes (tabla de abajo).

Termina con «aplicar termino. Siguiente: bash deploy/produccion.sh verificar» y la ruta
de `volver-atras.txt`. No muestra secretos: de los tokens solo imprime huellas. A la
metadata los valores llegan desde archivos privados (`--metadata-from-file`) que se
borran al terminar; a Azure van como argumentos de `az`, igual que en el anexo (1.3,
1.4 y 4.3), sin imprimirse. Si `az` o `gcloud` fallan, su error se muestra con los
secretos conocidos cambiados por `***`.

Opciones: `--sin-vm` (no toca la VM de editores ni `WORKSPACE_AGENT_TOKEN`), `--sin-gpu`
(no toca las GPU) y `--encender-vm`. Variables: `RG`, `APP`, `PROYECTO`, `ESPERA_MAX`,
`INTERVALO` y `CONFIRMAR`.

| Si `aplicar` dice | Qué hacer |
|---|---|
| «falta el push» | La sección [2](#2-push-que-despliega-powershell) en PowerShell. `aplicar` sigue esperando |
| «todavia no se hizo el push» | El push y otra vez `bash deploy/produccion.sh aplicar` |
| «/api/health no muestra la version nueva» | El push llegó, pero el flujo no terminó o falló: sección [2](#2-push-que-despliega-powershell). Luego otra vez `aplicar` |
| «no es lo desplegado en» | `~/PDC` está en otro commit: los comandos que muestra (`git pull --ff-only`) y otra vez `aplicar` |
| «az no pudo cargar las variables» | No se tocó nada más. Revisa `az login` y el grupo (`RG`) y repite |
| «no hay terminal para confirmar» | `CONFIRMAR=1 bash deploy/produccion.sh aplicar`, fuera de clase |
| «Azure ya tiene el token nuevo pero» | Otra vez `aplicar`: genera otro token y lo pone en los dos lados |
| «no pude entrar por IAP» | El arranque a mano: [4.4](#44-correr-el-arranque-nuevo) |
| «el agente de … no se conecta al relay» | `bash deploy/produccion.sh verificar`. Si el journal dice «el relay rechazo el token», otra vez `aplicar` |
| Una línea `--- AVISO` del arranque | La tabla de [4.4](#44-correr-el-arranque-nuevo) |
| «el heartbeat-token de … no es igual» | Esa GPU manda un latido que Azure no acepta y `clase.sh` no la ve. Si las otras GPU coinciden con Azure: `gcloud compute instances remove-metadata <vm> --zone=<zona> --keys=heartbeat-token` y otra vez `aplicar` (`actualizar-gpus.sh` le copia el latido de la GPU que lo tiene). Si no coincide ninguna: [1.4](#14-tokens-compartidos-con-las-vms-sin-mostrarlos) y [runbook](runbook.md), sección 5 |
| «descarte … linea(s) escritas o pegadas antes de esta pregunta» | Se pegaron varias líneas juntas. Esas líneas no se ejecutaron: córrelas después, una a la vez |

## 2. Push que despliega (PowerShell)

Mientras `aplicar` espera (dice «falta el push»), o antes de correrlo:

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

## Verificar (Cloud Shell)

```bash
bash deploy/produccion.sh verificar
```

No cambia nada. Hace las comprobaciones de las secciones [3](#3-verificar-el-backend) y
[4.5](#45-comprobar) que no necesitan a un estudiante, una línea con ✓ o ✗ cada una:

- **Backend:** los campos de `/api/health` de la tabla de la sección 3; `/empezar` con
  «Empieza con ADACEEN», sin archivos «todavia no esta publicado en este servidor» y con
  las versiones de `browser-ext-prod/manifest.json` y de `vscode-ext-prod` (la del
  commit que fija el submódulo, aunque la copia de trabajo del submódulo en `~/PDC` esté
  en otro); `/descargas/*` con `200` y `Content-Disposition: attachment`; y el
  SHA-256 del zip publicado contra el que arma `scripts/empaquetar-extension.mjs` en
  `~/PDC` (queda en `dist/extension/`, que git ignora).
- **Azure:** `ADACEEN_WORKSPACE_PROVIDER`, `PUBLIC_BASE_URL`, sin `WORKSPACE_AGENT_URL`,
  `TELEMETRY_SALT` y `WORKER_HEARTBEAT_TOKEN`, y una sola instancia.
- **VM de editores:** rama y `startup-script` de la metadata; el mismo
  `WORKSPACE_AGENT_TOKEN` en Azure y en la metadata (por huella); por IAP,
  `adaceen-ws-metadata` y `adaceen-workspaces-agent` en `active`, el último evento del
  relay en las últimas 200 líneas del journal (✓ si es «conectado al relay»; ✗ si es
  «el relay rechazo el token» o «relay sin conexion; se reintenta»), la metadata
  bloqueada para quien no es root (el usuario `nobody` tiene que recibir «conexion
  rechazada»; si la VM no tiene `nobody` o `curl`, queda sin comprobar) y el último
  arranque sin avisos; y `bash deploy/clase.sh estado` con el editor listo.
- **GPU:** `startup-script`, rama, `heartbeat-token` igual a `WORKER_HEARTBEAT_TOKEN` y
  `worker-id` que empieza por `gce-`.

Termina con «verificar: … ✓, 0 ✗». Si hay ✗, cada una dice qué hacer (casi siempre,
otra vez `aplicar`). Sin `az`, lo de Azure queda sin comprobar.

Falta, a mano:

- **`/empezar` en el navegador:** la sección «Estado» y los botones, como dice la
  sección [3](#3-verificar-el-backend) (lo que muestra el navegador no se ve con `curl`).
- **Con un estudiante:** después del primer «Preparar mi editor» real (paso P1.4 de la
  [prueba](../piloto/prueba-inicio-a-fin.md)), el bloque de `editor-session.json` de la
  sección [4.5](#45-comprobar).

## 6. Extensiones

- **Navegador 0.7.11.** En cada navegador del laboratorio y en el tuyo: descargar
  «Descargar la extension» de `/empezar`, reemplazar la carpeta y pulsar recargar en
  `chrome://extensions`. `/empezar` muestra «Instalada» con «lista (version
  <versión>).» (0.7.11), o «Actualizar» si la versión es anterior. Si cargas la extensión desde
  una carpeta fuera del repositorio (AGENTS.md), reemplázala también.
- **VS Code 0.0.31.**
  - En la VM de editores la instala el arranque nuevo (`aplicar`, o la sección 4 del
    anexo).
  - En cada Mac: doble clic otra vez en `Preparar-Mac-ADACEEN.command`, que actualiza
    la extensión.
  - En otro equipo: «Descargar extension de VS Code» y «Instalar desde VSIX».
  - Con la 0.0.30, el enlace `vscode://adaceen.adaceen/abrir` no hace nada.

## 7. Registro

En [evidencias de despliegue](evidencias-despliegue.md), sección 4:

- una fila con la fecha, el commit desplegado, 0.7.11, 0.0.31 y la GPU;
- en la columna "Observaciones", el commit anterior (`9f51643`), la rama anterior de `adaceen-ws`
  y la de cada GPU (están en `volver-atras.txt` del respaldo que deja `aplicar`);
- capturas 5 (flujo), 15 (relay) y 16 a 18.

## 8. Rollback

| Pieza | Cómo volver atrás |
|---|---|
| Backend | 8.1: un commit que restaura el árbol anterior y un push normal, sin `--force`. No uses la ejecución manual del flujo (8.2) |
| Variables | Dejarlas: el código de `9f51643` no las lee. Si cambiaste `WORKSPACE_ALLOWED_LOGINS` o `ALLOWED_ORIGINS`, vuelve al valor anterior. **Nunca** cambies `TELEMETRY_SALT` |
| Base de datos | Nada: los cambios solo agregan columnas y tablas, y `kind` tiene `default 'browser'`, así que el código anterior sigue funcionando ([contingencia](contingencia.md), sección 8) |
| VM de editores | Con `aplicar`: los comandos de `~/adaceen-respaldo-<fecha>/volver-atras.txt` (el primer respaldo, el más antiguo). A mano: si en 4.2 anotaste una rama: `gcloud compute instances add-metadata adaceen-ws --zone=us-central1-a --metadata=branch=<rama anotada en 4.2> --metadata-from-file=startup-script=$HOME/startup-ws-anterior.sh`. Si estaba vacía: `gcloud compute instances add-metadata adaceen-ws --zone=us-central1-a --metadata-from-file=startup-script=$HOME/startup-ws-anterior.sh` y `gcloud compute instances remove-metadata adaceen-ws --zone=us-central1-a --keys=branch`, para que vuelva a mandar la rama por defecto de ese script. Luego 4.4 |
| GPU | `RAMA=<rama anotada> bash deploy/gcp/actualizar-gpus.sh` (vale desde el próximo arranque). Con `aplicar`, la rama de cada GPU está en `gpus.txt` del respaldo |
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

## Anexo: procedimiento manual (si el script falla)

Lo mismo que hace `deploy/produccion.sh`, a mano. Las secciones conservan su número
(otros documentos las citan así). En orden: 0 (arriba), 1, 2 (arriba), 3, 4 y 5. La 1,
la 4 y la 5 van en una sola ventana de Google Cloud Shell; la 3, en PowerShell y el
navegador.

### 1. Variables del App Service (Cloud Shell)

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

#### 1.1 Qué hay hoy (solo nombres)

```bash
az webapp config appsettings list -g $RG -n $APP --query "[].{nombre:name,vacia:value==''}" -o table
```

La tabla muestra cada nombre y si está vacío, sin los valores.

#### 1.2 Qué revisar o crear

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

#### 1.3 Comandos

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

#### 1.4 Tokens compartidos con las VMs (sin mostrarlos)

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

#### 1.5 `ALLOWED_ORIGINS`

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

#### 1.6 Autoencendido (opcional)

No hace falta para la prueba. Si lo quieres:

```bash
RG=rg-adaceen-azure bash deploy/gcp/crear-cuenta-autoencendido.sh
```

Se corre desde `~/PDC`, después de la sección 4.1. Crea una cuenta de servicio que
solo puede leer y encender `adaceen-ws`, y carga las cinco variables sin mostrar la
clave. Esa clave también deja leer la metadata de la VM, incluido
`workspace-agent-token`. Si se filtra: revocarla y rotar el token
([runbook](runbook.md), sección 0).

#### 1.7 Una sola instancia

```bash
az appservice plan show --ids "$(az webapp show -g $RG -n $APP --query appServicePlanId -o tsv)" --query sku.capacity -o tsv
```

Debe dar `1`. Revisa también que no haya una regla de escalado automático en el portal
(App Service → Escalar horizontalmente; por verificar).

### 3. Verificar el backend

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
reproducible: construido desde la 0.7.11 de esta rama, su SHA-256 es
`2ec93765cba81fd48c6f7fc4752da9bb4d6814460a9854faab013096ad7e7668`, si ningún commit
posterior tocó `browser-ext-prod` (`bash deploy/produccion.sh verificar` hace esta
comparación solo):

```powershell
curl.exe -sS -o "$env:TEMP\adaceen-navegador.zip" "$B/descargas/adaceen-navegador.zip"
Get-FileHash "$env:TEMP\adaceen-navegador.zip" -Algorithm SHA256
```

### 4. VM de editores (Cloud Shell)

#### 4.1 Repositorio en Cloud Shell

```bash
cd ~ && [ -d PDC ] || git clone https://github.com/eydersantiago/PDC.git
cd ~/PDC && git fetch origin && git checkout feature/azure-config-observability && git pull --ff-only
git log -1 --oneline          # el commit que acabas de desplegar
bash deploy/clase.sh estado   # encuentra las 3 GPU y adaceen-ws
```

#### 4.2 Guardar lo de antes (para volver atrás)

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

#### 4.3 Rama, token del agente y `startup-ws.sh`

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

#### 4.4 Correr el arranque nuevo

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

#### 4.5 Comprobar

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

### 5. GPU (Cloud Shell)

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
