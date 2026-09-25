# Notas de versión

| | |
|---|---|
| Jira | A15.9 · ADACEEN-149 (empaquetado, decisión sobre Firefox, VSIX y notas de versión) |
| Evidencias de cada despliegue | [evidencias-despliegue.md](../operacion/evidencias-despliegue.md) |

## Auditoría de redundancias del 25 de septiembre de 2026 (rama `claude/serene-heisenberg-0te9s9`)

| Componente | Versión | Base |
|---|---|---|
| Extensión de navegador | **0.7.12** (2026-09-25) | 0.7.11 (PDC `b280b2c`) |
| Extensión de VS Code | **0.0.32** (2026-09-25; el commit de vscode-ext-prod sale al integrar esta entrega) | 0.0.31 (vscode-ext-prod `b21231e`) |
| Backend, worker y scripts | Rama `claude/serene-heisenberg-0te9s9`, sobre `b280b2c` | `b280b2c` |
| Base de datos | Tabla nueva `user_privacy_acceptances` (solo agrega) | — |
| Esquema de telemetría | 1.1 sin cambios | — |

Qué se corrigió: [auditoría de redundancias](../arquitectura/acceso-simplificado.md#8-auditoría-de-redundancias-navegador-0712-y-vs-code-0032),
de mayor a menor impacto (13 ítems). El camino del túnel no cambia de pasos y
Codespaces sigue creando el PR y el Codespace.

### Cambios

**Backend** (contrato: [contrato de la API](../arquitectura/contrato-api.md), secciones 2.5,
2.9, 2.10 y 2.11)

- Privacidad en el servidor: `POST /api/auth/privacy-acceptance { version }` (con
  sesión; solo versiones publicadas) y el campo `privacy: { version, acceptedAt }` en
  `/api/auth/login`, `/api/auth/google-login` y `/api/auth/me`. Si la lectura falla, el
  login no se cae (`null`).
- `PUT /api/pilot/block` sin grupos los asigna como «Asignar grupos A y B» (desde 2
  estudiantes activos; con 0 o 1 responde 409 y no inicia el bloque) y responde
  `assignedAutomatically`, `added` y `message` con la semilla.
- `POST /api/quiz/launches`, si la política no deja llegar el quiz, activa y guarda
  «Permitir mini quiz» y «Cuando yo lo lance a la clase» (después de crear el
  lanzamiento) y responde `autoEnabled`, `message` y `policy`.
- Página de retorno de la GitHub App: dice que se puede cerrar la pestaña y que ADACEEN
  lo detecta solo; `lang`, título y detalles técnicos plegados; `installation_id` solo
  numérico; el JSON de los scripts en línea se escapa.
- `/empezar`: el icono está en el menú de extensiones de Chrome hasta fijarlo, y la
  primera vez se pulsa «Aceptar y continuar».
- El aviso `staff_requires_code` (solo lo muestran tal cual VS Code 0.0.31 y anteriores)
  nombra «Copiar codigo para VS Code».
- `npm run piloto:retiro` borra también `user_privacy_acceptances`.

**Extensión de navegador 0.7.12** (detalle en `browser-ext-prod/readme.md`)

- Sin «Empezar»: el icono abre el login sin sesión y entra directo con sesión.
- Privacidad según el servidor: otro navegador no vuelve a pedir «Aceptar y continuar».
  En otro navegador, con el editor ya preparado, ofrece «Abrir mi editor» en vez del
  tour.
- Túnel sin GitHub App en la tuerca ni en las filas del contexto, y sin consultar su
  estado; la vista se titula «Preparar tu editor». Los avisos nombran el botón que se ve
  («Abrir mi editor» o «Preparar mi editor»).
- `vscode.dev` sin textos de Codespaces ni «Empezar». «Copiar sesion» pasa a «Copiar
  codigo para VS Code» y se oculta con VS Code conectado.
- Codespaces con un botón a la vez; la GitHub App se detecta sola (consulta cada 4 s,
  5 min como máximo), sin «Verificar acceso», las tarjetas 2 y 3 ni «Entendido».
- Docente: entra al «Panel docente»; una sola casilla de mini quiz; «Lanzar quiz» e
  «Iniciar bloque 1» muestran el aviso del backend.
- Campus: acceso y bitácora verificados al entrar; una sola acción.
- Un solo «Salir»; la Mac recuerda la última elección de editor; menos peticiones
  repetidas; `popup/` y `content.js` borrados (código muerto; 32 archivos en el paquete).

**Extensión de VS Code 0.0.32** (detalle en su `CHANGELOG.md`)

- «ADACEEN: Conectar» con una sola opción para escribir o pegar: «Tengo un código o
  sesión».
- El clic explícito cuenta como la confirmación de «Pedir confirmación» en cambios de
  hasta 5 líneas que no borran código; los reemplazos recién elegidos en el overlay se
  aplican sin «Aplicar reemplazo» si VS Code encuentra el código donde se eligió.
- Con la ventana flotante abierta, el CodeLens y la pista en línea no repiten «Aceptar
  ayuda».
- El aviso de sesión perdida nombra el botón que ofrece.

### Clics por flujo

Contados con los content scripts reales en el arnés de
`tests/scripts/browser-ext-flujo-tunel.test.ts` (icono incluido; sin contar lo que se
hace en GitHub ni escribir las credenciales), 0.7.11 → 0.7.12:

| Flujo | 0.7.11 | 0.7.12 |
|---|---|---|
| Túnel, primera vez sin sesión, hasta `vscode.dev` | 5 | 4 |
| Túnel, otro navegador con el editor ya preparado | 5 | 3 |
| Volver otro día (mismo navegador), repositorio o `github.com/` | 2 | 2 |
| `vscode.dev` con el overlay fijado | 1 | 0 |
| Mac del laboratorio, primera vez y otro día | 3 | 2 |
| Codespaces con sesión, hasta el Codespace (más 2 pasos en GitHub) | 5 | 3 |
| Campus: entrar al curso y analizarlo | 4 | 2 |
| Docente: lanzar un quiz con el mini quiz apagado (tuerca incluida) | 5 | 2 |
| Docente: iniciar el bloque 1 sin grupos (tuerca incluida) | 3 | 2 |
| VS Code: aplicar un cambio corto con la confirmación del docente | 2 | 1 |
| Reemplazo elegido en el overlay, hasta que se aplica | 2 | 1 |

### Compatibilidad

- Base de datos: solo agrega la tabla `user_privacy_acceptances`
  (`create table if not exists` al arrancar). Un backend anterior sigue funcionando con
  la base nueva.
- Navegador 0.7.12 con un backend anterior: la privacidad se guarda solo en ese
  navegador (la ruta responde 404), «Iniciar bloque 1» sin grupos responde 409 como
  antes y «Lanzar quiz» no avisa.
- Navegador 0.7.11 con el backend nuevo: funciona igual; la página de retorno de la App
  pide recargar la pestaña de ADACEEN si no avanza.
- VS Code 0.0.31 con el backend y el navegador nuevos: funciona (su opción se llama
  «Tengo un código del navegador»). Si la VM no encuentra el VSIX 0.0.32 del commit del
  submódulo, conserva el 0.0.31.

### Paquetes

`scripts/empaquetar-extension.mjs` (reproducible) sobre el árbol de esta entrega; el
VSIX lo empaqueta `vsce` y no es reproducible byte a byte (lleva la fecha): la suma es
la del archivo `vscode-ext-prod/adaceen-0.0.32.vsix` que se sube al submódulo con
`git add -f`.

```text
89db8ecafb6f314420845f0d373332340bbab4937734a0f0631da41eb254b872  adaceen-chromium-0.7.12.zip
232615e0d67cbf4d2473c1a5c3974fb5fa704e57884f94a041f37763fe75a01d  adaceen-firefox-0.7.12.zip
f3d3d5e89b113b3d4bae1442402515a28ab9d7c263eeab261f8e6e1c828bf744  adaceen-0.0.32.vsix
```

### Verificación

- PDC: `npm run build` y `npm test` (279 de 279 el 25 de septiembre; en `b280b2c` eran 252), con el arnés del navegador
  (`tests/scripts/browser-ext-flujo-tunel.test.ts`) y la integración del túnel de punta
  a punta.
- `node --test` de `deploy/` (agente de la VM, operación, Mac y `produccion.sh`):
  122 de 122.
- vscode-ext-prod: `npm run compile`, `npm run lint` y `npm run test:unit` (175 de 175;
  la 0.0.31 tenía 136).

**Falta probarlo en un navegador real, en la VM real y en una Mac real**:
[prueba de inicio a fin](../piloto/prueba-inicio-a-fin.md).

## Acceso simplificado del 25 de septiembre de 2026 (rama `claude/serene-heisenberg-0te9s9`)

| Componente | Versión | Base |
|---|---|---|
| Extensión de navegador | **0.7.11** (2026-09-25) | 0.7.10 (`feat/macs-laboratorio`, commit `b58f97b`) |
| Extensión de VS Code | **0.0.31** (2026-09-25; vscode-ext-prod `b21231e`) | 0.0.30 (vscode-ext-prod `787bb1c`) |
| Backend, worker y scripts | Rama `claude/serene-heisenberg-0te9s9` (PDC `f510225`) | `b58f97b` |
| VM de editores | `startup-ws.sh`, agente, `instalar-vsix.sh` y `tunel-comun.sh` de la misma rama | — |
| Esquema de telemetría | 1.1 sin cambios; metadata nueva: `retryable` | — |

> **Producción sigue en `9f51643`.** No tiene esta entrega ni las tres anteriores:
> desplegar es un push fast-forward, pero también hay que cargar las variables de
> esas entregas y actualizar la VM de editores y las GPU. Orden, comandos y rollback:
> [despliegue](../operacion/despliegue.md).

### Cambios

Contrato y desviaciones: `docs/arquitectura/acceso-simplificado.md`. En el primer
ingreso por túnel se pasa de unos 20-25 clics con copiar y pegar a unos 10 clics más
el código de dispositivo, que se escribe una sola vez. Al volver otro día basta un
clic.

**Backend**

- Sesiones por tipo (`browser`, `editor`, `cli`). Un inicio de sesión solo desactiva
  las del mismo tipo, así que entrar otra vez en el navegador ya no deja a VS Code sin
  sesión (antes sus eventos quedaban anónimos, regla D2). Las sesiones de editor
  vencen a los 30 días (`EDITOR_SESSION_TTL_DAYS`). Cerrar sesión desactiva también
  las de editor del usuario. Una sesión inválida recibe la cabecera
  `x-adaceen-session: invalid`, expuesta por CORS.
- Emparejar VS Code sin copiar y pegar:
  - `POST /api/auth/editor/pairing-code` y `/claim`: código `XXXX-XXXX` de un solo uso
    que vale 10 minutos; en la base solo queda su SHA-256.
  - `POST /api/auth/editor/github`: canje con la cuenta de GitHub de VS Code. Solo
    para estudiantes; docentes y administradores usan el código.
- `/api/workspaces/prepare` crea o reutiliza una sesión de editor `tunnel` y se la
  manda al agente de la VM. Nunca vuelve al navegador.
- `agent_unreachable` y `agent_timeout` llevan `retryable: true`. `/status` reenvía una
  vez la preparación que no llegó, así que la espera termina sola cuando la VM vuelve.
- Autoencendido opcional de la VM de editores (`WORKSPACE_VM_*` y
  `GCP_SERVICE_ACCOUNT_JSON`). También se acepta `WORKSPACE_ALLOWED_LOGINS=*`.
- Página `/empezar`: descargas de la extensión de navegador, del VSIX y del instalador
  de Mac (`/descargas/*`, que empaqueta el flujo de despliegue), los pasos para cargar
  la extensión y el estado del editor y del modelo.
- `/api/health` suma `workspace_agent_transport`, `workspace_vm_autostart`,
  `model_workers_alive` y `model_workers_known_down`.
- Los scripts de consola inician sesión como `cli`, así que ya no cierran la sesión
  del overlay del docente.

**Extensión de navegador 0.7.11**

- Con el túnel, un solo paso: «Conectar GitHub». Al volver del OAuth se prepara el
  editor en la misma ventana, sin la GitHub App.
- El setup y la URL del editor se guardan por usuario y repositorio, y ya no se borran
  al volver.
- Al volver otro día, el overlay entra directo con «Abrir mi editor».
- Con la VM apagada, la espera sigue y dice «Encendiendo la VM de editores...» o «El
  editor esta apagado; avisa al docente».
- En `github.com/login/device`, un recuadro con el código y «Copiar codigo».
- «Abrir en VS Code de este equipo» abre `vscode://adaceen.adaceen/abrir` con un
  código de un solo uso, y «Copiar sesion» copia ese código.
- El formulario de inicio de sesión ya no viene con la cuenta demo.
- `/empezar` detecta la extensión instalada.

**Extensión de VS Code 0.0.31**

- La sesión se toma, en orden, del llavero de VS Code, de
  `~/.adaceen/editor-session.json` (lo escribe la VM) y del ajuste heredado.
- Barra de estado «ADACEEN: sin conectar» o «ADACEEN: <nombre>», y comando «ADACEEN:
  Conectar» con «Con mi cuenta de GitHub (recomendado)», «Tengo un código del
  navegador» y «Pegar sesión».
- Una sola advertencia por ventana cuando la sesión deja de valer.
- Enlaces `vscode://adaceen.adaceen/abrir` y `/conectar`, que clonan o abren el
  repositorio en VS Code de escritorio.
- El visor de fuentes ya no lleva el `sessionId` en la URL.
- Detalle en su `CHANGELOG.md`.

**VM de editores**

- El agente escribe `~/.adaceen/editor-session.json`: archivo 600 del estudiante,
  escritura atómica y sin seguir enlaces. Nunca registra el `sessionId`.
- VSIX automático: `instalar-vsix.sh` baja el de la versión que fija el submódulo y,
  si no lo encuentra, usa `/descargas/adaceen.vsix`.
- Correcciones de seguridad. Antes de esta entrega un estudiante podía leer el token
  del agente, por `~/.adaceen/tunnel.env` o por `/proc/<pid>/environ` de
  `code tunnel user show`, y veía `WORKER_SHARED_SECRET` en su terminal. Además, el
  `chown` de `nuevo-tunel.sh` le daba la propiedad de cualquier archivo de la VM, y los
  homes de los estudiantes eran 0755. Ahora:
  - el entorno de cada túnel vive en `/etc/adaceen-tunnels/`;
  - `worker-secret` ya no se usa;
  - los procesos hijos del agente no reciben `AGENT_TOKEN`;
  - la unidad `adaceen-ws-metadata` bloquea la metadata a los `ws-*` en cada arranque;
  - los homes quedan en 0700.

  Al desplegar hay que rotar `WORKSPACE_AGENT_TOKEN`.

**Operación**

- `deploy/clase.sh iniciar | terminar | estado` (Cloud Shell): enciende una GPU y la VM
  de editores, espera a que Azure las vea e imprime `<backend>/empezar`.
- `deploy/gcp/crear-cuenta-autoencendido.sh`: rol con solo `compute.instances.get` y
  `start` sobre la VM de editores.
- `deploy/gcp/actualizar-gpus.sh`: lleva el `startup-script` y el latido a las GPU ya
  creadas.
- Mac:
  - `deploy/mac/estudiante/Preparar-Mac-ADACEEN.command`: git, VS Code, comando `code`
    y la extensión, con doble clic;
  - `Instalar-servidor-ADACEEN.command` y `Estado-servidor-ADACEEN.command` para la
    Mac servidor.
- GPU:
  - el arranque ya no aborta al cambiar la rama;
  - apaga por inactividad según el último trabajo;
  - rota el log a los 50 MB;
  - reinicia el worker en cada arranque;
  - precarga el modelo (`OLLAMA_KEEP_ALIVE=-1`).
- `teardown.sh`, `clone-worker.sh` (copia el latido) y `create-vm.sh` (sin IP pública
  por defecto), corregidos.

### Documentación nueva

Contrato del acceso simplificado (`docs/arquitectura/`),
[despliegue a producción](../operacion/despliegue.md),
[prueba de inicio a fin](../piloto/prueba-inicio-a-fin.md) con su hoja
`data/piloto/plantillas/prueba-inicio-a-fin.csv`, y
[pendientes y responsables](../piloto/pendientes.md). Se actualizaron los túneles, el
runbook, los prerrequisitos, la guía de las Mac y el contrato de la API.

### Configuración nueva

- **App Service:**
  - `PUBLIC_BASE_URL`;
  - `EDITOR_SESSION_TTL_DAYS` (opcional);
  - autoencendido opcional: `WORKSPACE_VM_AUTOSTART`, `WORKSPACE_VM_PROJECT`,
    `WORKSPACE_VM_ZONE`, `WORKSPACE_VM_NAME` y `GCP_SERVICE_ACCOUNT_JSON`.

  Como producción está en `9f51643`, también hacen falta las de las entregas
  anteriores (`TELEMETRY_SALT`, `WORKER_HEARTBEAT_TOKEN`,
  `ADACEEN_WORKSPACE_PROVIDER`, `WORKSPACE_AGENT_TOKEN`…): ver
  [despliegue](../operacion/despliegue.md), sección 1.
- **VM de editores:** metadata `scan-worker-key`, solo si PDC exige
  `ADACEEN_SCAN_WORKER_KEY`. `worker-secret` se puede borrar.

### Compatibilidad

- Base de datos: solo agrega. `app_sessions` suma `kind`, `expires_at` y `label`, y
  hay una tabla nueva, `editor_pairing_codes`. Las sesiones anteriores quedan como
  `browser` y sin vencimiento. Un backend anterior sigue funcionando con la base
  nueva.
- Backend nuevo con la VM vieja: funciona, pero el agente viejo ignora la sesión y
  VS Code queda «ADACEEN: sin conectar». Hay que actualizar la VM el mismo día.
- VS Code 0.0.31 con un backend anterior: solo «Pegar sesión» y el ajuste heredado.
- VS Code 0.0.30 no atiende `vscode://adaceen.adaceen/abrir`.

### Paquetes

Generados desde `f510225` (el empaquetado de la extensión de navegador es
reproducible). El VSIX es el del commit `b21231e` de vscode-ext-prod. El de
`/descargas/adaceen.vsix` lo vuelve a empaquetar el flujo de despliegue y puede tener
otra suma. Después de `f510225` cambió el código de la extensión de navegador sin
cambiar su versión (0.7.11), así que el zip del commit desplegado tiene otra suma:
`bash deploy/produccion.sh verificar` compara el publicado con el que arma
`scripts/empaquetar-extension.mjs` en ese mismo commit, y los navegadores que ya tenían
una 0.7.11 cargada tienen que reemplazar la carpeta.

```text
87e9dd6ea19a0df660aa3cdd7e83d03a34dc9d607f4948d56f783c15a0e4f4bf  adaceen-chromium-0.7.11.zip
3c7b90ae77ab0525437dd9b2a6a5920f67ffa79906c297c45462f0b1be2d2923  adaceen-firefox-0.7.11.zip
bfb582b6d247b38ba6af9776daccde7dbd7e151b9a7bce0d97cde93e8ec5c328  adaceen-0.0.31.vsix
```

### Verificación

- PDC: `npm run build` y `npm test`. Son 204 pruebas en `f510225`, con la integración
  de punta a punta `tests/integration/acceso-simplificado.test.ts`, más las que se
  agregaron en esta entrega (entre ellas, las que comprueban los textos de la guía, del
  despliegue y de la prueba de inicio a fin). La cifra final es la que da `npm test` en
  el commit desplegado.
- vscode-ext-prod: `npm run test:unit` con 136 pruebas, que se volvió a correr el 25
  de septiembre sobre `b21231e`, además de `npm run compile` y `npm run lint`.
- ShellCheck y `bash -n` en los scripts de `deploy/`.

**Falta probarlo en un navegador real** (el OAuth hacia `github.com/login/device` y
`vscode.dev`, y Firefox), **en la VM real y en una Mac real**:
[prueba de inicio a fin](../piloto/prueba-inicio-a-fin.md).

## Mac del laboratorio del 24 de septiembre de 2026 (rama `feat/macs-laboratorio`)

| Componente | Versión | Base |
|---|---|---|
| Extensión de navegador | **0.7.10** (2026-09-24) | 0.7.9 (`feat/segunda-tanda-jira`, commit `2b66fdd`) |
| Extensión de VS Code | **0.0.30** (2026-09-24) | 0.0.29 (`feat/segunda-tanda-jira`, commit `9d1c999`) |
| Backend, worker y scripts | Rama `feat/macs-laboratorio` | `2b66fdd` |
| Esquema de telemetría | 1.1 sin cambios; metadata nueva: `worker` (en `tutor_decision`), `editorHost` y `editorUi` | — |

### Cambios

**Servidores de inferencia intercambiables (A15.10 · ADACEEN-151, decisión 4 del ADR)**

- Las Mac del laboratorio pueden atender la cola igual que la GPU de Google
  Cloud, a la vez o en su lugar. `deploy/mac/instalar-worker-mac.sh` deja Ollama y
  el worker como servicios de launchd. Los servicios se reinician si fallan, no
  dejan dormir la Mac y precargan el modelo. Los secretos van en
  `~/.adaceen/worker.env` (600). Operación diaria con `deploy/mac/worker-mac.sh`
  (`estado`, `iniciar`, `detener`, `logs`, `velocidad`, `desinstalar`). Guía:
  `docs/operacion/worker-mac.md`.
- Worker: `SERVICE_BUS_TRANSPORT=websockets` (AMQP dentro de WebSocket por el
  443, por el proxy HTTPS si existe; el latido también sale por el proxy),
  `QUEUE_WORKER_CONCURRENCY`, `QUEUE_WORKER_KINDS`, `QUEUE_WORKER_PRIORITY=backup`
  (una Mac lenta solo toma lo que la GPU no alcanza), `QUEUE_WORKER_WARMUP`
  (precarga del modelo al arrancar), `QUEUE_WORKER_READY_URL` (no toma trabajos
  mientras el modelo no está listo) y `ADACEEN_WORKER_ENV_FILE`.
- El latido informa plataforma, concurrencia y tipos de trabajo. Los ids
  `mac-lab…` se muestran como «Mac del laboratorio - M2», y los `mac-lab-cluster…`
  como «Clúster de Mac del laboratorio».
- Cada `tutor_decision` guarda qué servidor la atendió (`metadata.worker`). El
  informe del piloto trae la tabla de latencia por servidor, y el monitor agrupa
  los servidores vivos y avisa si usan modelos distintos o si ninguno acepta
  imágenes.
- Modo clúster: varias Mac juntan su memoria para correr un modelo más grande
  con llama.cpp RPC (`--rol=coordinador` y `--rol=nodo`). Exige una red aislada
  entre las Mac, porque el RPC no tiene autenticación, y es más lento que un
  modelo que cabe en una sola Mac.
- Rol `local`: el `npm run dev:local` de siempre como servicio, escuchando solo
  en `127.0.0.1` (`ADACEEN_LISTEN_HOST`).

**Editor en dos modos**

- VS Code 0.0.30: si en el equipo corre un backend local de ADACEEN, lo usa
  igual que antes. Si no, va a producción, así que VS Code instalado en las Mac
  del laboratorio funciona sin configurar nada. La telemetría registra
  `editorHost` y `editorUi`. Detalle en su `CHANGELOG.md`.
- Extensión de navegador 0.7.10: «Abrir en VS Code de este equipo» clona el
  repositorio en el VS Code local y copia la sesión compartida.

**Correcciones**

- El worker leía `src/config/env.ts` antes de cargar `.env.worker` por un import
  nuevo de esta misma rama: arrancaba sin la cadena de conexión. Se corrigió
  antes de entregar y quedó una prueba de regresión
  (`tests/scripts/worker-config.test.ts`).
- `docs/service-bus-ollama-worker.md` usaba nombres de cola viejos
  (`adaceen-jobs`); ahora usa `llm-jobs` y `llm-results-sessions`.

### Configuración nueva

- App Service: nada obligatorio. `SERVICE_BUS_TRANSPORT` se deja en `amqp`.
- Azure: una política de Service Bus propia de las Mac (`worker-mac`, Listen y
  Send), con el mismo `WORKER_HEARTBEAT_TOKEN` del App Service.

### Compatibilidad

- Base de datos y esquema de telemetría sin cambios. Un backend anterior
  descarta de la metadata `worker`, `editorHost` y `editorUi`.
- La GPU de Google Cloud sigue igual (`amqp`, `.env.worker`).
- VS Code: quien tenía escrito `adaceen.backend.baseUrl` conserva ese valor.

### Paquetes

```text
f67e912675f7234f771d54d479e15235b1f1404aafe8ff0f1c440ac46a9c83d6  adaceen-chromium-0.7.10.zip
befb7ab2925585f32c8554321dd78aff9485f8271434e2540e8e7124b6359933  adaceen-firefox-0.7.10.zip
517d7c47874cc4e5981bfe57a76beddd2b864a7a9309496154755e858482705e  adaceen-0.0.30.vsix
```

### Verificación

`npm test` (142 pruebas) y `npm run build` en PDC; `npm run compile`,
`npm run lint` y `npm run test:unit` (70 pruebas) en vscode-ext-prod;
ShellCheck sin avisos en `deploy/mac/`. Instalación completa probada en Linux
con un macOS de prueba (launchd, Ollama y llama.cpp simulados, worker y backend
reales): los roles servidor, local, nodo y coordinador, reinstalación, cambio de
rol, `estado`, `detener`, `iniciar` y `desinstalar`. Falta la prueba en una Mac
real del laboratorio.

## Segunda entrega del 24 de septiembre de 2026 (rama `feat/segunda-tanda-jira`)

| Componente | Versión | Base |
|---|---|---|
| Extensión de navegador | **0.7.9** (2026-09-24) | 0.7.8 (`feat/cierre-pendientes-jira`, commit `6c656ac`) |
| Extensión de VS Code | **0.0.29** (2026-09-24) | 0.0.28 (`feat/cierre-pendientes-jira`, commit `6cbcb7c`) |
| Backend y scripts | Rama `feat/segunda-tanda-jira` | `6c656ac` |
| Esquema de telemetría | 1.1, con `blocking_resolved` y las columnas del piloto | — |

### Cambios

**Piloto con y sin tutor (A13.1)**

- Diseño intra-sujeto AB/BA: el docente asigna al azar los grupos A y B y cambia
  de bloque desde el overlay (sección «Piloto con y sin tutor») o con
  `npm run piloto:bloque`. Rutas `GET /api/pilot`, `POST /api/pilot/assign`,
  `PUT /api/pilot/block` y `GET /api/pilot/me`; historial de bloques en la base.
- En el bloque sin tutor el motor responde un aviso sin llamar al modelo
  (`reasonCode: pilot_no_tutor`) y no deja aplicar código. Cada evento de
  telemetría de un estudiante lleva su bloque, cohorte y condición.

**KPIs y análisis (A3.1 a A3.6, A14.2 a A14.4, A14.7)**

- Catálogo de 25 KPIs con fórmula, fuente, umbral y origen
  (`docs/metricas/catalogo-kpis.md`, generado), cálculo en `src/services/kpis.ts`
  y KPIs en vivo en `GET /api/telemetry/kpis`.
- Scripts del piloto: `piloto:monitor` (en vivo), `piloto:dataset` (limpieza con
  reglas D1 a D5), `piloto:analisis` (informe con Wilcoxon, cruzado AB/BA,
  gráficas y trazabilidad), `piloto:simular` (ensayo técnico), `piloto:verificar`
  (lista de cumplimiento), `piloto:retiro` (retiro de un participante),
  `kpis:catalogo` y `quiz:revision`.
- Las decisiones de VS Code registran cuántas fuentes del material acompañan la
  respuesta (KPI T9).

**Entornos por túnel (A15.3)**

- Relay para la VM de editores sin IP pública: el agente sondea
  `GET /api/workspaces/agent/next` y responde en
  `POST /api/workspaces/agent/responses`, por HTTPS de salida y con
  `x-agent-token`. Es el modo por defecto si no hay `WORKSPACE_AGENT_URL`.
- `nuevo-tunel.sh`: la comprobación de la sesión del túnel ya no confunde
  «not logged in» con una sesión iniciada.

**Monitoreo (A15.4)**

- `deploy/azure/crear-alertas.sh` (alertas de Azure Monitor por 5xx, health check
  y tiempo de respuesta) y el flujo programado `salud-produccion.yml`.
- `/api/health` informa además la retención de la telemetría, la versión de la
  política de privacidad y si el agente de entornos está conectado.

**Extensión de VS Code 0.0.29**

- Evento `blocking_resolved`: fin de cada episodio de bloqueo con su duración
  (tiempo hasta desbloqueo, KPI P1). Detalle en su `CHANGELOG.md`.

**Extensión de navegador 0.7.9**

- Sección «Piloto con y sin tutor» para el docente, accesible.

**Correcciones**

- `readIntArg` (scripts) devolvía el mínimo permitido cuando faltaba la opción.
  Con eso, `npm run telemetria:purgar -- --confirmar` sin `--dias` habría
  borrado la telemetría de más de **un día** en lugar de usar
  `TELEMETRY_RETENTION_DAYS`, y `medir:latencia` sin `--n` habría tomado una
  sola muestra. Corregido con prueba de regresión. En la rama
  `feat/cierre-pendientes-jira` no hay que correr la purga sin `--dias`.
- El ensayo técnico usa ids fijos para las cuentas sintéticas: con la misma
  semilla da los mismos datos.

### Documentación nueva

Paquete de validación para el director y el docente, protocolo, instrumentos,
consentimiento, lista de cumplimiento, plan de soporte y análisis de datos del
piloto (`docs/piloto/`); vistas de la arquitectura (C4 y secuencias) y contrato
de la API verificado por prueba (`docs/arquitectura/`); revisión docente del
banco del quiz; evidencia del ensayo técnico.

### Configuración nueva en el App Service

`WORKSPACE_AGENT_TRANSPORT` (opcional: `relay` o `direct`). Para el relay basta
con `WORKSPACE_AGENT_TOKEN` sin `WORKSPACE_AGENT_URL`, y en la VM de editores la
metadata del relay (ver `docs/workspaces-tunnel.md`).

### Compatibilidad

- Base de datos: cambios aditivos (tres tablas del piloto y tres columnas en
  `telemetry_events`, con `add column if not exists`).
- Las extensiones 0.7.8 y 0.0.28 siguen funcionando con este backend; la 0.0.28
  no envía `blocking_resolved`, así que sin la 0.0.29 no hay P1.

### Paquetes

```text
2dc9b5dcd62c06d308d110c06a098cc71751fa22c847359360846de838d48048  adaceen-chromium-0.7.9.zip
77bd55fdc79886ad78987006a056d0990cb9e25e022fe6632e0ad3ca44e548d6  adaceen-firefox-0.7.9.zip
```

### Verificación

`npm test` (130 pruebas) y `npm run build` en PDC; `npm run compile`,
`npm run lint` y `npm run test:unit` (59 pruebas) en vscode-ext-prod;
`npm run piloto:simular` con 10 de 10 comprobaciones.

## Entrega del 24 de septiembre de 2026 (rama `feat/cierre-pendientes-jira`)

| Componente | Versión | Base |
|---|---|---|
| Extensión de navegador | **0.7.8** (2026-09-24) | Línea de despliegue `feature/azure-config-observability` (0.7.5, commit `9f51643`) |
| Extensión de VS Code | **0.0.28** (2026-09-24) | `feat/quiz-panel` (0.0.27, commit `ff298f2`) |
| Backend y worker | Rama `feat/cierre-pendientes-jira` | `9f51643` |
| Esquema de telemetría | 1.1 | — |
| Modelo | `qwen2.5-coder:14b` en Ollama | — |

> **Divergencia con `master`.** `master` tiene 12 commits que no están en la
> línea de despliegue (división del overlay en módulos, sistema de diseño,
> extensión 0.7.7). Esta entrega sale de la línea de despliegue, así que **no
> incluye** esos cambios; se numeró 0.7.8 para no repetir el 0.7.7 de `master`.
> Los iconos se tomaron de `master` (ya redimensionados), por eso no chocan al
> fusionar. Al unir las dos líneas hay que resolver conflictos en el overlay.

### Decisión sobre Firefox

**Se soporta Firefox**, con una limitación declarada:

- La extensión funciona en Firefox (el dueño del proyecto la instaló y la usó).
  `npm run empaquetar:extension` genera un paquete propio para Firefox con el
  mismo código, `browser_specific_settings.gecko` (id `adaceen@univalle.edu.co`,
  Firefox 128 o superior) y `background.scripts`.
- **Limitación:** en Firefox no hay inicio de sesión con Google ni sincronización
  con Google Calendar, porque dependen de `chrome.identity.getAuthToken`, que
  Firefox no implementa. Se entra con correo y contraseña de ADACEEN. Pasar esas
  dos funciones a `identity.launchWebAuthFlow` queda como mejora futura.
- **Instalación:** como complemento temporal desde `about:debugging` (se quita
  al cerrar Firefox). Una instalación permanente necesita firmar el paquete en
  addons.mozilla.org (no hecho).

Esta decisión reemplaza lo que decía el informe de brechas del 23 de septiembre
(«solo Chromium»).

### Empaquetado

| Paquete | Cómo se genera | Salida |
|---|---|---|
| Extensión de navegador | `npm run empaquetar:extension` (producción) o `npm run empaquetar:extension:dev` (agrega el backend local) | `dist/extension/adaceen-chromium-<versión>.zip`, `adaceen-firefox-<versión>.zip` y `SHA256SUMS.txt` |
| Extensión de VS Code | `npm run package` y `npx @vscode/vsce package` en `vscode-ext-prod` | `adaceen-<versión>.vsix` |

- El empaquetado de la extensión de navegador es reproducible: sin
  dependencias, fecha de las entradas fija (`SOURCE_DATE_EPOCH` o la fecha de
  `version_name`) y verificación de cada zip (vuelve a leerlo y compara CRC y
  tamaño). Con las mismas fuentes, el zip sale idéntico byte a byte.
- Paquetes de esta entrega (2,66 MiB cada uno; antes 11,7 MiB por los iconos sin
  redimensionar):

  ```text
  b1493b2ab62072d1744723c6833fb9c98d2af8c840d2bc52534c5579d87d175f  adaceen-chromium-0.7.8.zip
  30eb243ecb7981ece80ef766c7dac7d6ccdbdced7bc287cb54ef1e5601fa469e  adaceen-firefox-0.7.8.zip
  ```

- La extensión de VS Code no está publicada en el Marketplace desde esta
  entrega: la VM de editores instala `/opt/adaceen/adaceen.vsix` si existe (si
  no, `adaceen.adaceen` del Marketplace). Publicarla queda para cuando esté
  probada en más de una máquina.

### Cambios

**Backend**

- Motor de políticas en VS Code (A9.10): `/suggest-tab` clasifica el evento,
  aplica la regla del docente, gradúa la ayuda y registra cada decisión;
  `POST /api/suggestions/apply-check` limita y registra la aplicación de código (A10.8).
- Plantillas de intervención con límites de código por etapa y guardarraíl
  anti-solución que quita «Aplicar:» si el código se recortó (A8.3, A8.4, A10.1, A10.2).
- La etapa de ayuda respeta las intervenciones habilitadas por el docente, y el
  resultado de aprendizaje de la política llega al modelo.
- Matriz escenario → recurso autorizado (A8.6) y banco de 17 preguntas validadas
  para el mini-quiz cuando no hay modelo (A8.5).
- Telemetría v1.1 (A4.x, A7.x): tabla única `telemetry_events` con actor
  seudonimizado, hashes en lugar de textos, reglas de calidad, integridad por
  `seq`, exportación y revisión de calidad para docentes, catálogo público y
  retención.
- Latido de los workers, `/api/agent/health` (503 sin worker) y modo degradado:
  sin workers vivos no se encola y el tutor responde controlado en segundos (A15.4, A12.10).
- `/api/health` informa si la sal de telemetría y el token de latido están configurados.
- Entornos por túnel: proveedor `tunnel`, rutas `/api/workspaces/*` y agente de
  la VM de editores (A15.3).
- Detección del overlay: «diagrama» ya no se toma como «rama»; más errores de
  compilación de C++ reconocidos; un error visible cuenta como consulta del curso.
- Seguridad: los enlaces del visor de fuentes ya no llevan el `sessionId`; las
  citas del material no rompen los bloques de código.
- Scripts: demo de escenarios, latencia, estabilidad de eventos, exportación,
  purga y diccionario de telemetría.

**Worker GPU**

- Latido cada 30 s al backend (`WORKER_HEARTBEAT_URL`, `WORKER_HEARTBEAT_TOKEN`;
  metadata `heartbeat-url` y `heartbeat-token` en las VMs).
- El resultado expira si nadie lo lee (antes quedaba hasta el TTL de la cola).

**Extensión de navegador 0.7.8**

- Telemetría v1.1 y señales de error y bloqueo; «Me sirvió» / «No me sirvió»;
  `Ctrl+Enter` para pedir ayuda.
- Ajustes del docente para aplicar código desde VS Code.
- Accesibilidad WCAG 2.1 AA en las vistas clave (A12.9), revisión de seguridad
  (A12.8) y permisos mínimos (A12.7): sin `tabs`, sin `localhost` ni comodines de
  `*.azurewebsites.net` en producción (la variante `-dev` agrega el backend local).
- Iconos redimensionados (los de `master`).

**Extensión de VS Code 0.0.28**

- Identidad unificada (`x-adaceen-client-id`), telemetría v1.1 con `seq`,
  señales de error y bloqueo, campos de política en `/suggest-tab`, guard de
  aplicación de código con confirmación y regla sin red, indicador «GPU: sin
  worker activo». Detalle en su `CHANGELOG.md`.
- 0.0.27 (en `feat/quiz-panel`): «Insertar debajo» ya no reemplaza el código.

### Configuración nueva en el App Service

`TELEMETRY_SALT` (obligatoria; no cambiarla durante el piloto),
`TELEMETRY_RETENTION_DAYS`, `WORKER_HEARTBEAT_TOKEN`, `WORKER_HEARTBEAT_STALE_MS`,
`ADACEEN_WORKSPACE_PROVIDER`, `WORKSPACE_AGENT_URL`, `WORKSPACE_AGENT_TOKEN`,
`WORKSPACE_AGENT_TIMEOUT_MS`, `WORKSPACE_ALLOWED_LOGINS`. Ver `.env.example`.

### Compatibilidad

- Base de datos: cambios aditivos (tabla `telemetry_events` y columna
  `code_application_settings`); una versión anterior del backend sigue
  funcionando con la base nueva.
- Las extensiones anteriores siguen funcionando con este backend: los eventos
  sin `schemaVersion` se guardan como 1.0 con un aviso de calidad.

### Verificación

`npm run build` y `npm test` (106 pruebas) en PDC; `npm run compile`,
`npm run lint` y `npm run test:unit` (54 pruebas) en vscode-ext-prod;
`npm run demo:escenarios` con todas las comprobaciones correctas.
