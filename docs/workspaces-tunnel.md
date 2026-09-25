# Entornos de edicion con VS Code Tunnels (plan B a Codespaces)

Spike en `feat/workspace-tunnel` (tag `spike-tunel-ok`). Fases 2 y 3
(agente en la VM + rutas de PDC) en `feat/cierre-pendientes-jira`, Jira
A15.3 / ADACEEN-124. Scripts y agente en `deploy/gcp/workspaces/`.

## Por que

La creacion de un Codespace tarda entre 20 y 50 min por el host de GitHub
(descarga de imagen a ~5 MB/s con paradas; ver el log del 20-09). Cambiar de
region no ayudo. El piloto no puede depender de eso.

Codespaces hace tres cosas por el estudiante: identidad (GitHub), un VS Code
en el navegador con la extension, y el repo clonado. Este plan las sustituye
con una VM en Google Cloud y Dev Tunnels; Azure, Service Bus, la GPU y el
GitHub App no cambian.

## Lo que se verifico en la documentacion antes de escribir nada

| Pregunta | Respuesta | Fuente |
|---|---|---|
| Quien puede abrir un tunel | Solo la misma cuenta de GitHub/Microsoft que lo registro. No hay ACL ni compartir. | docs de VS Code |
| Tuneles por cuenta | 10. Con uno por estudiante, registrado en SU cuenta, no se toca el limite. | docs de VS Code |
| Ancho de banda | "hay limites", no publicados. Riesgo a medir en el spike. | docs de VS Code |
| `code tunnel user login --access-token` con un token cualquiera de GitHub | **401 del API de Dev Tunnels**: solo acepta tokens de la app OAuth de VS Code. | microsoft/vscode#310726 |
| Login sin interaccion | No documentado; `--refresh-token` existe pero no hay forma publica de obtenerlo. | vscode-remote-release#10615 |
| Preinstalar extensiones en el servidor | `code tunnel --install-extension <id>`, Marketplace real. | CLI |
| Que imprime el CLI al pedir el codigo | `To grant access to the server, please log into https://github.com/login/device and use code XXXX-XXXX`, una linea por stdout; al vencer (15 min) pide otro e imprime otra linea. | `cli/src/auth.rs` |
| Que imprime `code tunnel user show` | `logged in with provider github` (salida 0) o `not logged in` (salida 1). | `cli/src/commands/tunnels.rs` |

**Consecuencia para el diseño:** PDC no puede registrar el tunel "a nombre
del estudiante" con el token OAuth que ya guarda. Lo que si puede hacer es
lanzar el login por codigo de dispositivo en la VM y mostrarle al estudiante,
en el overlay de la extension de navegador, "abre github.com/login/device y
escribe XXXX-XXXX". Un clic y un codigo, una sola vez; el CLI guarda la sesion
en la VM.

## Flujo

```
estudiante en github.com  --"Preparar entorno"-->  PDC  (POST /api/workspaces/prepare)
PDC: login de GitHub con el token OAuth guardado (GET /user), lo compara con
     WORKSPACE_ALLOWED_LOGINS y llama al agente de la VM (POST /workspaces)
VM:  agente -> nuevo-tunel.sh <login> https://github.com/<owner>/<repo>.git
     -> usuario ws-<login>, clon en ~/proyecto, servicio adaceen-tunnel@ws-<login>,
        codigo de dispositivo (de la salida del script o del journal del servicio)
overlay: muestra el codigo y consulta GET /api/workspaces/status cada 3 s;
     con "ready" abre https://vscode.dev/tunnel/ad-<login>/home/ws-<login>/proyecto
```

Codespaces queda como respaldo con una variable de entorno
(`ADACEEN_WORKSPACE_PROVIDER=codespaces|tunnel`, por defecto `codespaces`);
no se borra nada.

## Fases

1. **Spike a mano** — hecho (`create-ws-vm.sh` + `spike-tunnel.sh`).
2. **Agente en la VM** — **implementado**: `deploy/gcp/workspaces/agente/`
   (`agente-workspaces.mjs`, `parse.mjs`, unidad
   `adaceen-workspaces-agent.service`); `startup-ws.sh` lo instala y arranca
   con el token de la metadata. Detalle abajo.
3. **PDC** — **implementado**: `src/services/workspace-provider.ts` (cliente
   del agente) y `src/routes/workspace-routes.ts`
   (`registerWorkspaceRoutes(app, database)`), con pruebas en
   `tests/routes/workspace-routes.test.ts`. La extension de navegador ya
   hablaba el contrato (`browser-ext-prod/services/workspace.service.js`).
4. **Extension de VS Code**: `remoteName === 'tunnel'` se trata como
   Codespaces para el `baseUrl` por defecto. (O nada: los ajustes de maquina
   ya lo fijan; decidir tras el spike.)

El camino de red de Azure a la VM ya esta resuelto con el relay (seccion
"Como llega PDC al agente"). Falta para usarlo en clase: la primera prueba con
la VM real y dos cuentas de GitHub ("Probar a mano").

## Contrato backend <-> extension de navegador

```
GET  /api/workspaces/provider                     (publica, sin sesion)
     -> { ok, provider: "tunnel" | "codespaces", agentConfigured? }

POST /api/workspaces/prepare        { repoFullName, force? }      (sesion)
GET  /api/workspaces/status?repoFullName=...                      (sesion)
     -> { ok, provider: "tunnel",
          status: "ready" | "device_code" | "pending" | "error",
          workspace:  { login, tunnelName, webUrl, repoFullName },
          deviceCode?: { userCode, verificationUrl, expiresAt },
          message?: string, code?: string, error?: string }
```

Semantica:
- `prepare` es idempotente: si el tunel de ese login ya esta arriba (servicio
  activo y sesion del CLI iniciada) responde `ready` sin correr nada. `force`
  para el tunel, aparta el clon a `~/proyecto.bak-<fecha>` (no borra nada del
  estudiante) y vuelve a correr `nuevo-tunel.sh`.
- `device_code` aparece solo la primera vez por estudiante (o si la sesion
  del CLI se perdio). La extension muestra el codigo, lo copia al
  portapapeles si puede, y sigue consultando `status` cada 3 s hasta 12 min.
- `webUrl` es `https://vscode.dev/tunnel/<tunnelName>/home/ws-<login>/proyecto`
  con `tunnelName = ad-<primeros 17 caracteres del login>` (Dev Tunnels
  limita el nombre a 20). Si el CLI tuvo que registrar otro nombre, el agente
  lo lee del journal y lo devuelve.
- Con el proveedor `tunnel` la extension no exige el scope `codespace`:
  basta la cuenta conectada.

Codigos HTTP y `code`:

| Caso | HTTP | `code` |
|---|---|---|
| Sin sesion | 401 | `unauthorized` |
| `repoFullName` ausente o invalido | 400 | `invalid_request` |
| Proveedor `codespaces` | 409 | `provider_codespaces` (la extension sigue con Codespaces) |
| GitHub no conectado / token revocado | 409 | `github_not_connected` / `github_token_invalid` |
| Login fuera de `WORKSPACE_ALLOWED_LOGINS` | 403 | `login_not_allowed` |
| Login de mas de 28 caracteres | 409 | `login_unsupported` |
| Falta `WORKSPACE_AGENT_URL` o `_TOKEN` | 503 | `agent_not_configured` |
| Agente caido / lento / token rechazado / respuesta rara | **200**, `ok:false`, `status:"error"` | `agent_unreachable`, `agent_timeout`, `agent_unauthorized`, `agent_error`, ... |
| Error del script (clon, cola llena, otro repo ya clonado) | **200**, `status:"error"` | lo que diga el agente (`clone_failed`, `agent_busy`, `repo_mismatch`, ...) |

Los fallos del agente van con 200 a proposito: la extension ignora los
`status` que no son 2xx y seguiria consultando 12 min sin decir nada; con
`status:"error"` se detiene y muestra `message`. Nunca hay un 500 sin cuerpo.
Todo error trae `message` (para el estudiante) y `error` (lo mismo, para
`fetchJsonWithTimeout`).

Eventos de comportamiento (`source: backend`): `prepare_environment_started`
/ `prepare_environment_retry_started` (categoria `codespace`, `value:
"tunnel"`), `tunnel_workspace_device_code` y `tunnel_workspace_ready`
(`durationMs` desde que se pidio), y `prepare_environment_failed` /
`prepare_environment_retry_failed` (categoria `error`). Cada uno se registra
una sola vez por preparacion aunque la extension consulte `status` cada 3 s.

## Fase 2: agente HTTP en la VM

Node puro, sin dependencias; corre con el Node 18 de Debian 12 que ya instala
`startup-ws.sh` (no usa nada de Node 20+). Corre como root porque
`nuevo-tunel.sh` crea usuarios y unidades systemd.

```
POST /workspaces          {login, repo, force?}
     -> {login, state, tunnelName, webUrl, repo, deviceCode?, verificationUrl?, expiresAt?, message?, code?, detail?}
GET  /workspaces/:login   -> lo mismo (404 + code "not_found" si no hay nada para ese login)
GET  /health              -> {ok, running, queued, maxConcurrent}   (sin token; no revela logins)
```

- **Autenticacion**: cabecera `x-agent-token`, comparada en tiempo constante
  (SHA-256 + `timingSafeEqual`). Sin token valido: 401, incluso para rutas
  que no existen. El agente no arranca con un token de menos de 24
  caracteres (sale con codigo 78 y systemd no reintenta).
- **Entradas**: `login` con `^[a-z0-9][a-z0-9-]{0,27}$` (lo que acepta
  `nuevo-tunel.sh`); `repo` como `owner/nombre` o
  `https://github.com/owner/nombre(.git)`, siempre convertido a
  `https://github.com/owner/nombre.git`. El script se lanza con
  `spawn("/bin/bash", [script, login, url])`, sin shell.
- **Donde escucha**: `AGENT_HOST` (lista separada por comas); nunca
  `0.0.0.0` ni `::`. `startup-ws.sh` usa `127.0.0.1` y la IP interna.
- **Concurrencia**: `AGENT_MAX_CONCURRENT` scripts a la vez (3), el resto en
  cola (`AGENT_MAX_QUEUE`, 40; llena = 429). Cada script tiene
  `AGENT_SCRIPT_TIMEOUT_MS` (16 min) y se mata con todo su grupo de procesos.
  `POST` espera hasta `AGENT_PREPARE_WAIT_MS` (10 s) al codigo o al final del
  script y si no, responde `pending`.
- **Mismo login, otro repo**: si `~/proyecto` ya es otro repositorio, `POST`
  sin `force` responde 409 `repo_mismatch` con un mensaje para el estudiante.
- **Estado "ready"**: `systemctl show adaceen-tunnel@ws-<login>` activo y
  `code tunnel user show` (como `ws-<login>`) con sesion iniciada.

**De donde sale el codigo de dispositivo (dos caminos, los dos soportados).**
a) `nuevo-tunel.sh` corre `code tunnel user login` y el codigo sale en su
salida (solo con `LOGIN_EN_SCRIPT=1`, para el spike manual). b) Por defecto el
script no pide el login: lo pide el propio servicio `adaceen-tunnel@`, que lo
escribe en el journal, y el agente lo lee de ahi
(`journalctl _SYSTEMD_INVOCATION_ID=...`). Con b) el script termina en
segundos y el servicio espera la autorizacion aunque el agente se reinicie.
Antes b) pasaba por accidente: el paso 4 usaba `grep -qi "logged in"`, que
tambien casa con `not logged in`. Desde A15.3 el script revisa el codigo de
salida y el texto completo de `code tunnel user show` (`sesion_iniciada`) y b)
es una decision explicita.

Variables del agente (las escribe `startup-ws.sh` en
`/etc/adaceen-workspaces-agent.env`, modo 600):

| Variable | Defecto | Uso |
|---|---|---|
| `AGENT_TOKEN` | — (obligatoria) | secreto compartido con PDC; viene de la metadata `workspace-agent-token` |
| `AGENT_HOST` | `127.0.0.1` | IPs donde escuchar, separadas por comas (metadata `workspace-agent-host`; si falta, `127.0.0.1,<IP interna>`) |
| `AGENT_PORT` | `8787` | metadata `workspace-agent-port` |
| `AGENT_SCRIPT` | `/opt/adaceen/nuevo-tunel.sh` | |
| `AGENT_CODE_BIN` | `/usr/local/bin/code` | CLI de VS Code para `tunnel user show` |
| `AGENT_MAX_CONCURRENT` / `AGENT_MAX_QUEUE` | `3` / `40` | |
| `AGENT_SCRIPT_TIMEOUT_MS` | `960000` (16 min) | |
| `AGENT_PREPARE_WAIT_MS` | `10000` | debe ser menor que `WORKSPACE_AGENT_TIMEOUT_MS` de PDC |

**Metadata y seguridad.** Los estudiantes tienen terminal en la VM (usuarios
`ws-*`) y la metadata la puede leer cualquier proceso local. Por eso
`startup-ws.sh` bloquea con iptables el HTTP (80/443) hacia
`169.254.169.254` para todo lo que no sea root (el DNS, puerto 53, sigue
abierto). Sin esa regla, un estudiante podria leer el token del agente y
preparar tuneles a nombre de otros (ademas de la clave del worker y el token
de la cuenta de servicio de la VM, que ya estaban ahi).

### Instalar el agente en la VM que ya existe

La VM ejecuta el `startup-script` guardado en su metadata, no el del repo:
hay que subir el nuevo `startup-ws.sh`. Desde la raiz del repo:

```bash
TOKEN=$(openssl rand -hex 32)          # guardalo: va tambien en Azure
gcloud compute instances add-metadata adaceen-ws --zone=us-central1-a \
  --metadata=workspace-agent-token="$TOKEN",branch=feat/segunda-tanda-jira \
  --metadata-from-file=startup-script=deploy/gcp/workspaces/startup-ws.sh
gcloud compute ssh adaceen-ws --zone=us-central1-a --tunnel-through-iap \
  --command='sudo google_metadata_script_runner startup'
gcloud compute ssh adaceen-ws --zone=us-central1-a --tunnel-through-iap \
  --command='systemctl status adaceen-workspaces-agent --no-pager; curl -s http://127.0.0.1:8787/health'
```

`branch` es la rama de PDC de la que la VM copia scripts y agente: el defecto
de `startup-ws.sh` ahora es `feature/azure-config-observability` (la de
despliegue); mientras el agente no este fusionado ahi, usa la rama que lo
tenga. El relay (A15.3) esta en `feat/segunda-tanda-jira`: la VM la clona de
GitHub, asi que hay que empujarla antes. Si `branch` cambia, `startup-ws.sh`
vuelve a clonar `/opt/adaceen/repo`.
Una VM nueva: `create-ws-vm.sh` genera el token (o usa
`WORKSPACE_AGENT_TOKEN` si lo exportas), lo pone en la metadata y lo imprime.

Log: `journalctl -u adaceen-workspaces-agent -f` (una linea por preparacion,
nunca el token).

## Fase 3: PDC

| Variable (Azure App Settings) | Defecto | Uso |
|---|---|---|
| `ADACEEN_WORKSPACE_PROVIDER` | `codespaces` | `tunnel` activa este flujo; cualquier otro valor es `codespaces` |
| `WORKSPACE_AGENT_URL` | vacio | URL base del agente, sin barra final (p. ej. `http://10.128.0.5:8787` o la URL del tunel que lo publique) |
| `WORKSPACE_AGENT_TOKEN` | vacio | el mismo valor que la metadata `workspace-agent-token` |
| `WORKSPACE_AGENT_TIMEOUT_MS` | `15000` | tiempo maximo por llamada al agente; mayor que `AGENT_PREPARE_WAIT_MS` |
| `WORKSPACE_ALLOWED_LOGINS` | vacio (= cualquiera con GitHub conectado) | logins de GitHub del piloto, separados por comas, sin distinguir mayusculas |

- El login sale de `GET {GITHUB_API_BASE_URL}/user` con el token OAuth
  guardado del estudiante (`database.getGithubUserTokenForUser`). `prepare`
  lo valida siempre; `status` lo guarda 5 min en memoria para no llamar a
  GitHub cada 3 s.
- `fetch` y el lector del login son inyectables
  (`registerWorkspaceRoutes(app, database, { fetch, readGithubLogin, config })`);
  asi estan hechas las pruebas, sin red.
- Las llamadas al agente llevan `X-Tunnel-Skip-AntiPhishing-Page: true` por
  si se publica con Dev Tunnels (evita la pagina intermedia); en otros
  caminos no afecta.

## Como llega PDC al agente: relay por HTTPS de salida (A15.3)

La VM no tiene IP externa (politica `constraints/compute.vmExternalIpAccess`);
Cloud NAT solo da **salida**, no entrada; IAP TCP necesita `gcloud` en el
cliente (sirve desde un portatil, no desde App Service). Por eso Azure no puede
abrirle conexiones al agente.

**Solucion implementada: el agente le pregunta a PDC** (modo `relay`). Es el
mismo patron que ya usa el latido de los workers de GPU: la VM sale por HTTPS.

```
overlay -> PDC POST /api/workspaces/prepare
PDC:  pone la peticion en la cola del relay (memoria) y espera hasta
      WORKSPACE_AGENT_TIMEOUT_MS (15 s)
VM:   el agente sondea GET <api>/api/workspaces/agent/next?wait=25 (sondeo largo),
      recibe {id, method, path, body}, la pasa a su propia API local
      (http://127.0.0.1:8787/workspaces...) y devuelve la respuesta en
      POST <api>/api/workspaces/agent/responses
PDC:  entrega esa respuesta a la peticion del overlay (device_code, ready, error)
```

- **Autenticacion:** `x-agent-token` en los dos sentidos (el mismo
  `WORKSPACE_AGENT_TOKEN`), comparado en tiempo constante.
- **Solo dos rutas** se reenvian (`POST /workspaces`, `GET /workspaces/<login>`):
  el relay no deja llamar nada mas en la VM (`relay.mjs`, `rutaPermitida`).
- **Agente desconectado:** si nadie sondeo en 60 s, PDC responde de inmediato
  `agent_unreachable` («No se pudo contactar la VM de editores...»), sin
  esperar el timeout.
- **Conexion cortada:** si el agente corta el sondeo antes de recibir, los
  trabajos vuelven a la cola; si nunca responde, el estudiante ve
  `agent_timeout` y reintenta.
- **Una instancia:** la cola vive en memoria, como el registro de latidos;
  supone una sola instancia del App Service (la del piloto). Con varias
  instancias habria que pasarla a la base o a Service Bus.
- **Configuracion:** en PDC basta `ADACEEN_WORKSPACE_PROVIDER=tunnel` y
  `WORKSPACE_AGENT_TOKEN` (sin `WORKSPACE_AGENT_URL`, el modo es `relay`;
  `WORKSPACE_AGENT_TRANSPORT=direct|relay` lo fuerza). En la VM,
  `startup-ws.sh` escribe `AGENT_RELAY_URL=<api-url>/api/workspaces/agent` en
  `/etc/adaceen-workspaces-agent.env` (metadata `workspace-agent-relay=off`
  lo apaga).
- **Verificar:** `GET /api/health` → `"workspace_agent_online": true`; el
  docente o el agente pueden ver la cola en `GET /api/workspaces/agent/status`;
  en la VM, `journalctl -u adaceen-workspaces-agent` muestra `conectado al relay`.
- **Pruebas:** `deploy/gcp/workspaces/agente/relay.test.mjs` y el caso
  «modo relay» de `tests/routes/workspace-routes.test.ts` (PDC real, agente
  local falso, cliente del relay real).

El modo `direct` (PDC llama a `WORKSPACE_AGENT_URL`) sigue para desarrollo
local y para una VM alcanzable (VPN, Cloud Run con salida a la VPC).

## Probar a mano

Pruebas automaticas (sin VM):

```bash
node --test deploy/gcp/workspaces/agente/*.test.mjs        # parseo, validacion, HTTP con script falso
node --import tsx --test tests/routes/workspace-routes.test.ts
```

(En Node 22, `node --test <carpeta>/` no busca pruebas dentro de la carpeta;
usa el patron.)

En la VM, contra el agente:

```bash
sudo -i
TOKEN=$(grep '^AGENT_TOKEN=' /etc/adaceen-workspaces-agent.env | cut -d= -f2-)
curl -s http://127.0.0.1:8787/health
curl -s -H "x-agent-token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"login":"eydersantiago","repo":"eydersantiago/FadaProyecto"}' \
  http://127.0.0.1:8787/workspaces | jq
curl -s -H "x-agent-token: $TOKEN" http://127.0.0.1:8787/workspaces/eydersantiago | jq
```

La primera vez responde `device_code` (o `pending` si el clon tarda mas de
10 s: repetir el GET). Autorizar en github.com/login/device con **la misma
cuenta** y repetir el GET hasta `ready`.

Desde tu equipo con PDC local, por IAP (una vez: regla de firewall para el
rango de IAP):

```bash
gcloud compute firewall-rules create allow-iap-agente-ws --network=default \
  --allow=tcp:8787 --source-ranges=35.235.240.0/20
gcloud compute start-iap-tunnel adaceen-ws 8787 --local-host-port=localhost:8787 --zone=us-central1-a
# en otra terminal, en .env de PDC:
#   ADACEEN_WORKSPACE_PROVIDER=tunnel
#   WORKSPACE_AGENT_URL=http://localhost:8787
#   WORKSPACE_AGENT_TOKEN=<el de la metadata>
npm run dev
curl -s http://localhost:3000/api/workspaces/provider
curl -s -H "x-session-id: <sesion>" -H 'Content-Type: application/json' \
  -d '{"repoFullName":"eydersantiago/FadaProyecto"}' http://localhost:3000/api/workspaces/prepare
curl -s -H "x-session-id: <sesion>" \
  "http://localhost:3000/api/workspaces/status?repoFullName=eydersantiago/FadaProyecto"
```

(IAP entra por la IP interna de la VM: el agente debe escuchar en ella, que
es el defecto de `startup-ws.sh`.) La sesion es la de un estudiante con
GitHub conectado en ADACEEN; luego, el boton "Preparar entorno" de la
extension de navegador hace lo mismo.

## Limites conocidos

- **Solo repos publicos**: el clon es https anonimo; un repo privado falla con
  `clone_failed` y un mensaje claro. Para privados habria que pasarle a git un
  token de lectura del estudiante (no hecho).
- **Un proyecto por estudiante**: todo vive en `~/proyecto`; cambiar de repo
  exige `force` (el clon anterior queda como respaldo).
- **Misma cuenta**: si el estudiante autoriza el codigo con otra cuenta de
  GitHub, el tunel queda en esa cuenta y vscode.dev dira "tunel no
  encontrado". El agente no puede saber con que cuenta se autorizo.

## Costo con los 300 USD de credito

| Recurso | Precio aprox. | Piloto (8 h/dia, 20 dias) |
|---|---|---|
| adaceen-ws e2-standard-4 | 0,134 USD/h | ~21 USD |
| disco 60 GB pd-balanced | ~6 USD/mes | 6 USD |
| adaceen-worker g2-standard-8 + L4 Spot | ~0,30-0,35 USD/h | ~50 USD (solo en sesiones) |
| Dev Tunnels / vscode.dev | 0 | 0 |

Sobra credito para duplicar la VM de editores si una sesion tiene mas de
~15 estudiantes activos a la vez (Java + language server ≈ 1 GB por persona).

## Spike: resultados

_(rellenar al correrlo)_

- Token OAuth de PDC acepta login del tunel: SI / NO
- Segundos hasta servicio arriba:
- Segundos hasta ver archivos en vscode.dev:
- Barra de estado mostro "GPU: Google Cloud - L4": SI / NO
- Observaciones (latencia de tecleo, cortes):
