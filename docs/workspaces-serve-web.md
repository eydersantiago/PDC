# Entornos de edicion con VS Code Web servido desde la VM (`code serve-web`, sin Dev Tunnels)

Spike **documentado, no corrido en la VM** (8 de octubre de 2026). Entregables:
este documento, `deploy/gcp/workspaces/spike-serve-web.sh` (prueba manual para
UN login) y su prueba sin VM en `deploy/gcp/workspaces/agente/vm-scripts.test.mjs`.
Lo que esta en produccion sigue siendo el tunel de
[workspaces-tunnel.md](workspaces-tunnel.md); nada de lo de aqui cambia PDC
todavia. Sin Jira asignado.

## Por que

Con el tunel, el primer ingreso de un estudiante pasa por **dos pantallas de
GitHub** ademas del OAuth de ADACEEN: `github.com/login/device` con el codigo
(la extension 0.7.21 ya lo escribe sola, pero el estudiante sigue teniendo que
pulsar Continue y autorizar) y luego el inicio de sesion de vscode.dev con **la
misma cuenta**. Si en esa segunda pantalla elige la cuenta Microsoft o la de
otro GitHub, vscode.dev dice "tunel no encontrado" y nadie en la VM puede saber
por que ("Misma cuenta" en los limites conocidos del tunel). Ademas Dev Tunnels
limita a 10 tuneles por cuenta (hoy no pega porque cada tunel va en la cuenta
del estudiante, pero obliga a que cada estudiante tenga cuenta de GitHub y la
autorice) y tiene limites de ancho de banda que Microsoft no publica.

`code serve-web` es el otro modo del mismo CLI que ya corre en la VM: en vez de
registrar un tunel en Dev Tunnels y mandar al estudiante a vscode.dev, **sirve
el VS Code web completo desde la propia VM** (pagina, extension host, terminal
y archivos) en un puerto, protegido por un token de conexion. El navegador solo
necesita la URL y el token, que PDC ya puede entregar porque el estudiante esta
autenticado en ADACEEN. Resultado: cero pantallas de GitHub despues del OAuth
de ADACEEN, imposible equivocarse de cuenta, sin limite de tuneles y sin
Microsoft en medio del trafico. Lo que no cambia: la VM `adaceen-ws`, los
usuarios `ws-<login>`, el agente y el relay, la sesion del editor en
`~/.adaceen/editor-session.json`, el VSIX automatico, el apagado por
inactividad y la GPU.

Lo que si hace falta y hoy no existe: una **entrada publica** hasta la VM (no
tiene IP externa), que es la decision de este spike.

## Lo que se verifico en la documentacion antes de escribir nada

Fuente: codigo de `microsoft/vscode` (rama `main`, leido en
raw.githubusercontent.com el 8-10-2026). La pagina de docs
(`https://code.visualstudio.com/docs/remote/vscode-server`) y la descarga del
CLI para correr `code serve-web --help` **no se pudieron consultar** desde esta
sesion (el proxy de salida rechaza code.visualstudio.com); queda como primer
criterio del spike confirmar `--help` en la VM, donde el CLI ya esta.

| Pregunta | Respuesta | Fuente |
|---|---|---|
| Opciones reales de `code serve-web` | `--host` (defecto `localhost`), `--port` (defecto 8000; 0 = libre), `--socket-path`, `--connection-token`, `--connection-token-file`, `--without-connection-token`, `--accept-server-license-terms`, `--server-base-path`, `--server-data-dir`, `--default-folder`, `--default-workspace`, `--disable-telemetry`, `--commit-id`; globales `--cli-data-dir` (`VSCODE_CLI_DATA_DIR`), `--verbose`, `--log` | `cli/src/commands/args.rs` (`ServeWebArgs`, `GlobalOptions`) |
| `--install-extension`, `--extensions-dir`, `--user-data-dir` en `serve-web` | **No existen** (si en `code tunnel`, `BaseServerArgs`). El servidor que el CLI baja (`bin/code-server`) si acepta `--install-extension`, `--extensions-dir`, `--server-data-dir`; sin `--start-server` instala y sale | `args.rs`, `src/server-main.ts` |
| Donde deja el CLI el servidor web | `<cli-data>/serve-web/<commit>/` (`web_server_storage()`), con `<cli-data>` = `~/.vscode/cli` en la build de Microsoft (la misma carpeta de `~/.vscode/cli/servers` que hoy mira el apagado por inactividad); paquete `server-linux-x64-web` | `cli/src/state.rs`, `cli/src/update_service.rs` |
| Que hace el CLI con `--connection-token-file` | Lo lee y recorta, lo guarda en `<cli-data>/serve-web-token` (0600) y arranca el servidor con `--connection-token-file` apuntando a esa copia; nunca le pasa `--connection-token <valor>` | `cli/src/commands/serve_web.rs` |
| Carpeta de datos del servidor | `--server-data-dir`, si no `VSCODE_AGENT_FOLDER`, si no `~/<serverDataFolderName>` (`.vscode-server` en la build de Microsoft); extensiones en `<datos>/extensions` y ajustes de maquina en `<datos>/data/Machine/settings.json`: **las mismas rutas que ya usa el tunel** | `src/vs/server/node/server.main.ts` |
| Como se comprueba el token | Query `tkn` o cookie `vscode-tkn` (ninguna cabecera); igualdad estricta; formato `^[0-9A-Za-z_-]+$`; el archivo se lee **una vez** al arrancar | `src/vs/base/common/network.ts`, `src/vs/server/node/serverConnectionToken.ts` |
| Sin token valido | HTTP 403 `Forbidden.` para `/` y los recursos; el WebSocket se cierra con `Unauthorized client refused: auth mismatch`; solo `/version` y `/delay-shutdown` responden sin token | `src/vs/server/node/remoteExtensionHostAgentServer.ts` |
| Como llega el token al navegador | Con `?tkn=` el servidor pone la cookie `vscode-tkn` (`SameSite=lax`, `Max-Age=604800`: 7 dias, sin `Path` explicito) y responde 302 a la misma URL sin el token; en cada carga la renueva | `src/vs/server/node/webClientServer.ts` |
| Proxy inverso y base path | `--server-base-path /x/` se normaliza a `/x/`; `remoteAuthority` sale de `x-original-host`, `x-forwarded-host` o `host` (+`x-forwarded-port`); `x-forwarded-prefix` solo si es un path seguro; CSP del workbench: `connect-src 'self' ws: wss: https:`, `frame-src 'self' https://*.vscode-cdn.net`, `script-src ... http://<remoteAuthority>` | `webClientServer.ts` |
| Inicio de sesion con GitHub/Microsoft | **No hay pantalla de inicio de sesion ni ACL por cuenta**: la unica puerta es el token. (Dev Tunnels exige la cuenta que registro el tunel; aqui nadie lo registra.) | `serverConnectionToken.ts`, `webClientServer.ts` |
| Licencia | `--accept-server-license-terms` evita la pregunta; sin TTY y sin la opcion, el servidor sale con 1 | `src/server-main.ts` |

**Consecuencia para el diseño:** la extension de VS Code de ADACEEN ya se
conecta con `~/.adaceen/editor-session.json` (contrato 2.3 de
[acceso-simplificado.md](arquitectura/acceso-simplificado.md)), que el agente
escribe en cada «Preparar mi editor». No hace falta ninguna cuenta dentro del
editor: ni GitHub, ni Microsoft, ni Settings Sync. El token sustituye al login
de vscode.dev y la sesion de ADACEEN sustituye al codigo de dispositivo.

## Que es `code serve-web`

El binario `/usr/local/bin/code` que `startup-ws.sh` ya instala. Con
`serve-web` baja (una vez por commit) la build web del servidor a
`~/.vscode/cli/serve-web/<commit>/` y sirve en un puerto el workbench
(HTML/JS) y el servidor remoto (extension host de Node, terminal, archivos),
hablando HTTP y WebSocket con el navegador directamente. El comando por
estudiante, que es el `ExecStart` de la plantilla `adaceen-web@.service` del
script:

```
code serve-web --host 127.0.0.1 --port <puerto> --server-base-path /ws-<login>/ \
  --connection-token-file <archivo> --default-folder /home/ws-<login>/proyecto \
  --accept-server-license-terms --disable-telemetry
```

| Opcion | Para que |
|---|---|
| `--host 127.0.0.1` | solo dentro de la VM; la entrada publica llega por el proxy de rutas (abajo). `HOST_WEB=<ip-interna>` en el script para probar con `start-iap-tunnel` |
| `--port <puerto>` | uno por estudiante, estable: `20000 + CRC(login) mod 10000`, el siguiente libre si choca; guardado en `/etc/adaceen-web/ws-<login>.env` |
| `--server-base-path /ws-<login>/` | un camino por estudiante, para que **un solo host** sirva a todos: `https://<entrada>/ws-ana/`, `https://<entrada>/ws-bob/` |
| `--connection-token-file` | el token de ese estudiante; ver "Seguridad" (por que archivo y no `--connection-token`) |
| `--default-folder` | la URL sin `?folder=` abre `~/proyecto` |
| `--accept-server-license-terms` | sin pregunta interactiva (es un servicio) |
| `--disable-telemetry` | la VM no manda telemetria a Microsoft |

Al arrancar imprime `Web UI available at http://127.0.0.1:<puerto>/ws-<login>/?tkn=<token>`
(queda en `journalctl -u adaceen-web@ws-<login>`; el agente podria leerlo de ahi
como hoy lee el codigo de dispositivo, pero no hace falta: el token lo tiene root).

**Extension ADACEEN.** `serve-web` no tiene `--install-extension`, asi que no
se puede preinstalar desde la unidad como hace `adaceen-tunnel@`. Lo que si
funciona: el servidor que el CLI baja acepta `--install-extension`, y sin
`--start-server` instala y termina. El script lo hace como el estudiante
despues de arrancar el servicio (espera a que el CLI baje el servidor, hasta
`ESPERA_SERVIDOR_S`, 90 s):

```
~/.vscode/cli/serve-web/<commit>/bin/code-server --accept-server-license-terms \
  --install-extension /opt/adaceen/adaceen.vsix [--install-extension <id por lenguaje>...]
```

La extension queda en `~/.vscode-server/extensions`, la misma carpeta del
tunel, y los ajustes de maquina en `~/.vscode-server/data/Machine/settings.json`,
el mismo archivo que escribe `nuevo-tunel.sh`. Si no hay VSIX en
`/opt/adaceen` se instala `adaceen.adaceen` del Marketplace (la build de
Microsoft usa el Marketplace real, como el servidor del tunel). En produccion
esto lo haria `nuevo-web.sh` y, al cambiar el VSIX, `startup-ws.sh`.

**`vscode.env.remoteName`.** Con el tunel vale `tunnel`; con `serve-web` el
workbench se conecta con `remoteAuthority` = host de la pagina (sin prefijo
`tunnel+`), asi que `detectEditorHost` (`vscode-ext-prod/src/backend-url.ts`)
devolvera `remote`, no `tunnel`. La lectura de `~/.adaceen/editor-session.json`
no depende de eso (la unica guarda es `uiKind === Web && !remoteName`, que es
vscode.dev sin remoto); confirmar en el spike es un criterio de exito.

## Flujo propuesto

```
estudiante en github.com  --"Preparar mi editor"-->  PDC  (POST /api/workspaces/prepare)
PDC: login de GitHub con el token OAuth guardado (GET /user), WORKSPACE_ALLOWED_LOGINS,
     POST /workspaces al agente de la VM (por el relay, como hoy)
VM:  agente -> nuevo-web.sh <login> <repo>        (hoy: spike-serve-web.sh, a mano)
     -> usuario ws-<login>, clon en ~/proyecto, token en /etc/adaceen-web/,
        servicio adaceen-web@ws-<login>, extension ADACEEN, nginx: /ws-<login>/ -> 127.0.0.1:<puerto>
     -> responde ready con webUrl = https://<entrada>/ws-<login>/?tkn=<token>
overlay: con "ready" abre webUrl en la ventana de espera (sin codigo, sin pantalla de vscode.dev)
navegador: el servidor pone la cookie vscode-tkn y quita el token de la URL (302); VS Code
     abre ~/proyecto; la extension ADACEEN lee ~/.adaceen/editor-session.json y queda conectada
```

El estado `device_code` desaparece: `prepare` responde `pending` mientras clona
y arranca, y `ready` cuando la unidad esta activa y el servidor responde.

## Entrada publica: opciones

La VM no tiene IP externa (`constraints/compute.vmExternalIpAccess`), Cloud NAT
solo da salida e IAP necesita `gcloud` en el cliente (sirve para el spike desde
un portatil, no para 20 estudiantes). Lo que hace falta es un host HTTPS
publico que reenvie `/ws-<login>/` (HTTP y WebSocket) a la VM.

| Opcion | Costo aprox. | Seguridad | Esfuerzo | WebSockets | Dominio propio | Politica de la organizacion |
|---|---|---|---|---|---|---|
| (a) Cloud Run con proxy inverso + salida a la VPC | ~0,09 USD por hora con estudiantes conectados; ~10-15 USD el piloto | TLS de Google en `*.run.app`; el token es la unica puerta; trafico Google <-> VM dentro de la VPC | medio: un `Caddyfile`, un `gcloud run deploy`, una regla de firewall y nginx en la VM | si (tiempo maximo por peticion 60 min: VS Code reconecta solo) | no | hay que comprobar que no haya una restriccion de ingreso publico en Cloud Run (`constraints/run.allowedIngress`) |
| (b) Cloudflare Tunnel (`cloudflared`, conexion de salida) | 0 (plan gratuito); dominio ~10-15 USD/año | TLS de Cloudflare; subdominio por estudiante posible (origen separado); un tercero termina el TLS y ve el trafico | bajo-medio: `cloudflared` como servicio en la VM, DNS en Cloudflare | si | **si, obligatorio** en el DNS de Cloudflare (los Quick Tunnels `*.trycloudflare.com` no lo exigen, pero la URL cambia y no tienen garantia: solo para el spike) | no la toca (es salida, como el relay) |
| (c) IP externa en la VM + Caddy con TLS automatico | 0 (IP efimera ~3 USD/mes) | TLS de Let's Encrypt; la VM queda expuesta directamente | bajo | si | si (o `sslip.io`/`nip.io` sobre la IP) | **prohibido** hoy por `compute.vmExternalIpAccess` |
| (c') Balanceador HTTPS externo + grupo de instancias con la VM | ~18-20 USD/mes (regla de reenvio) + proceso | TLS gestionado por Google; la VM sigue sin IP externa | alto: NEG/grupo, backend, health check, certificado | si (timeout del backend configurable) | si (certificado gestionado) | permitido (la politica es sobre IPs de VM) |
| (d) App Service de Azure como proxy sobre el relay actual | 0 extra | — | muy alto | no: el relay es cola de peticion/respuesta | no | — |

**(a) Cloud Run.** Un contenedor minimo con Caddy que reenvia todo a la IP
interna de la VM; Cloud Run da `https://<servicio>-<hash>.<region>.run.app`
con TLS sin dominio. La salida a la VPC se hace con **Direct VPC egress**
(`--network default --subnet default --vpc-egress private-ranges-only`, sin
costo propio) y no con un conector de Serverless VPC Access (dos instancias
`e2-micro` siempre encendidas, ~11-15 USD/mes). El mapa `/ws-<login>/` ->
puerto vive en la VM (nginx, abajo) para que agregar un estudiante no exija
redesplegar el proxy; Cloud Run queda como reenvio tonto, intercambiable por
(b) sin tocar nada mas. `--allow-unauthenticated` a proposito: la puerta es el
token; la autenticacion IAM de Cloud Run obligaria a una cuenta de Google.

```
# deploy/gcp/workspaces/entrada/Caddyfile (propuesta)
:8080
reverse_proxy http://<ip-interna-vm>:8080 {
  header_up Host {host}
  header_up X-Forwarded-Host {host}
}
# Dockerfile: FROM caddy:2.8-alpine + COPY Caddyfile /etc/caddy/Caddyfile
gcloud run deploy adaceen-editores --source deploy/gcp/workspaces/entrada --region us-central1 \
  --network default --subnet default --vpc-egress private-ranges-only \
  --allow-unauthenticated --timeout 3600 --min-instances 0 --max-instances 2
gcloud compute firewall-rules create allow-entrada-ws --network default --allow tcp:8080 \
  --source-ranges <rango-de-la-subred> --target-tags adaceen-ws
```

```
# /etc/nginx/conf.d/adaceen-web.conf en la VM (propuesta; nuevo-web.sh regeneraria el mapa)
map $login $puerto { include /etc/adaceen-web/puertos.map; }   # "ana 20123;" por linea
server {
  listen <ip-interna>:8080;
  location ~ ^/ws-(?<login>[a-z0-9-]+)/ {
    proxy_pass http://127.0.0.1:$puerto;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 1h;
    proxy_buffering off;
    client_max_body_size 50m;
  }
}
```

**(b) Cloudflare Tunnel.** `cloudflared` corre en la VM como servicio y abre
una conexion de salida (como el relay); en el panel se asigna
`editores.<dominio>` -> `http://127.0.0.1:8080` (el nginx de arriba). Gratis y
sin tocar la politica, pero exige un dominio propio en el DNS de Cloudflare y
mete un tercero que termina el TLS y ve el codigo de los estudiantes (hoy Dev
Tunnels hace lo mismo; es un cambio de proveedor, no de principio, pero hay
que decirlo en el consentimiento). Ventaja real frente a (a): un
**subdominio por estudiante** (`ana.editores.<dominio>`) separa origenes en el
navegador (cookies y almacenamiento), y Cloudflare Access (gratis hasta 50
usuarios) podria añadir un codigo por correo si algun dia hiciera falta. Para
el spike, un Quick Tunnel (`cloudflared tunnel --url http://127.0.0.1:8080`)
da en segundos una URL `https://<azar>.trycloudflare.com` sin dominio: sirve
para medir, no para clase.

**(c) IP externa + Caddy.** Lo mas simple si se pudiera: Caddy en la VM con
`reverse_proxy` y certificado automatico. Lo prohibe la politica de la
organizacion; pedir la excepcion no depende de nosotros y expondria la VM
(SSH, agente) a internet. (c') es la version permitida (la VM sin IP, el
balanceador delante), pero cuesta mas que toda la VM, exige dominio para el
certificado y tres o cuatro recursos mas que mantener: solo si (a) resulta
bloqueada por politica y no se quiere (b).

**(d) App Service como proxy sobre el relay: descartada.** El relay
(`relay.mjs`, `/api/workspaces/agent/next`) es una cola de
**peticion/respuesta** en memoria: el agente sondea con esperas de 25 s, PDC
entrega la respuesta a una sola peticion y solo deja pasar dos rutas. Un editor
necesita un WebSocket persistente y bidireccional con latencia de milisegundos
y volumen continuo (cada tecla, cada salida de terminal, cada archivo), uno por
estudiante y durante toda la clase. Hacerlo pasar por el relay seria escribir
nuestro propio tunel (multiplexar N WebSockets sobre conexiones de salida de la
VM) dentro del mismo proceso de Node que sirve la API, en una sola instancia
del App Service, y cada byte cruzaria Azure dos veces (de ida por el relay y
de vuelta al navegador). Es rehacer Dev Tunnels, peor, en el componente mas
delicado del piloto. Tampoco encaja la autenticacion: el relay usa un unico
`WORKSPACE_AGENT_TOKEN` y el navegador necesitaria una por estudiante encima.

**Recomendacion: (a)**, Cloud Run con Direct VPC egress y el mapa de rutas en
nginx dentro de la VM. Es lo unico que no exige dominio ni tercero nuevo, usa
solo `gcloud` (reproducible en `deploy/`), respeta la politica de IPs y cuesta
menos que una tarde de GPU. Primer paso del spike: comprobar que la
organizacion permite ingreso publico en Cloud Run; si no, (b) con Quick Tunnel
para medir esa misma tarde y la decision del dominio para el dueño.

## Seguridad

- **Token de conexion por estudiante.** 64 hexadecimales de `openssl rand`,
  en `/etc/adaceen-web/ws-<login>.token`, **0600 de root** (carpeta 0700),
  como los entornos del tunel en `/etc/adaceen-tunnels`. De root y no del
  estudiante porque el agente tiene que conocerlo para armar `webUrl`, porque
  rotarlo es decision de root y porque un archivo del estudiante podria
  cambiarse por uno adivinable o borrarse. El servicio lo recibe por
  `LoadCredential=token:/etc/adaceen-web/%i.token` y
  `--connection-token-file %d/token`: systemd lo lee como root y lo deja en un
  directorio privado del servicio (`%d` = `$CREDENTIALS_DIRECTORY`, systemd
  250+; Debian 12 trae 252). Asi **nunca va en la linea de comandos**, que
  `ps` muestra a cualquier `ws-*` (por eso `--connection-token <valor>` queda
  prohibido y la prueba lo comprueba), ni en un archivo legible por otros.
  El CLI lo copia a `~/.vscode/cli/serve-web-token` (0600 del propio
  estudiante, en su home 0700): es su llave, no la de nadie mas. Si `%d`
  fallara en el spike, el plan B es `--connection-token-file
  /etc/adaceen-web/%i.token` con el archivo `0640 root:ws-<login>`.
- **Como llega al navegador.** PDC devuelve `webUrl` con `?tkn=` en
  `prepare`/`status`, que ya exigen la sesion de ADACEEN y pasan por el relay
  cifrado; la extension abre esa URL una vez; el servidor pone la cookie
  `vscode-tkn` (7 dias, `SameSite=lax`, path por defecto = `/ws-<login>/`) y
  redirige sin el token. Reglas: PDC no registra `webUrl` en eventos ni logs
  (hoy `tunnel_workspace_ready` solo lleva `durationMs`: mantenerlo), la
  extension de navegador guarda la URL **sin** la query y vuelve a pedir
  `status` para abrirla (lo hace ya), y nadie pega la URL completa en un chat.
- **Aislamiento entre estudiantes.** Usuario Linux distinto (home 0700),
  proceso y puerto distintos en 127.0.0.1, camino distinto, token distinto.
  Desde su terminal un estudiante alcanza `127.0.0.1:<puerto de otro>`, pero
  sin el token del otro recibe 403 y el WebSocket se cierra; no puede leer ese
  token (root 0600, la copia del otro esta en un home 0700 y no aparece en
  `ps`). Lo que **si comparten** es el origen en el navegador
  (`https://<entrada>`): las cookies van por camino, pero en un equipo
  compartido (las Mac del laboratorio) la cookie de 7 dias del estudiante
  anterior sigue en ese navegador y abre `/ws-<anterior>/` sin token. Por eso
  la rotacion al salir (abajo) y, si se quiere mas, un subdominio por
  estudiante (opcion b).
- **CSP y origen.** La CSP la fija el servidor de VS Code (`connect-src 'self'
  ws: wss: https:`, `frame-src https://*.vscode-cdn.net`, `script-src ...
  http://<remoteAuthority>`); el proxy no debe añadir otra ni tocar los
  cuerpos. La red del laboratorio tiene que dejar salir a `*.vscode-cdn.net`
  (webviews) y, si se quiere instalar extensiones desde el editor, al
  Marketplace. `remoteAuthority` sale de `Host`/`X-Forwarded-Host`: el proxy
  los reenvia tal cual y pasa `Upgrade`/`Connection`, sin buffering y con
  timeouts largos. HTTPS hasta la entrada; el tramo entrada -> VM va en HTTP
  dentro de la VPC (como el agente).
- **Que pasa con la autenticacion.** Hoy GitHub autentica tres veces (OAuth de
  ADACEEN, codigo de dispositivo, inicio de sesion en vscode.dev). Con esto: la
  sesion de ADACEEN en el navegador, PDC confirma el login de GitHub con el
  token OAuth guardado y entrega `webUrl` con el token; dentro del editor, la
  sesion `editor` de `editor-session.json`. Se pierde que el editor vuelva a
  comprobar a la persona en cada apertura (el token es portador: quien tenga
  la URL entra hasta que se rote); se gana que no haya cuentas que confundir y
  que la telemetria siga saliendo con la sesion correcta. Para el piloto es
  el mismo nivel que un enlace de Codespaces abierto en el navegador.
- **Rotacion.** `spike-serve-web.sh rotar <login>`: token nuevo + reinicio
  (el servidor lee el archivo al arrancar), la cookie vieja deja de valer y el
  estudiante vuelve a entrar desde ADACEEN con un clic. Cuando: `POST
  /api/auth/logout` (que ya desactiva las sesiones `editor`), «Preparar mi
  editor» con `force`, `clase.sh terminar` y ante cualquier sospecha. El
  reinicio corta la conexion unos segundos; fuera de clase no se nota.
- **La VM no cambia de postura.** Metadata solo para root, homes 0700, nada
  de `/etc/adaceen-ws.env` ni secretos en el entorno del servicio (solo
  `PUERTO` y `HOST_WEB`), root no escribe en el home (mismo escritor `sudo -u`
  que `nuevo-tunel.sh`).

## Cambios que harian falta en PDC y en el agente

Lo que la extension de navegador ya hace: con `status: "ready"` abre
`workspace.webUrl` en la ventana de espera (`navigatePendingCodespaceWindow`
solo exige http/https). Lo que no: guardarlo como editor de ese estudiante
(`isTunnelEditorUrl` solo acepta `vscode.dev/tunnel/...`), y PDC tampoco lo
dejaria pasar (`validWebUrl`).

| Archivo | Cambio |
|---|---|
| `deploy/gcp/workspaces/spike-serve-web.sh` | pasa a `nuevo-web.sh` + `web-comun.sh` (plantilla, puerto, token, extensiones, mapa de nginx, reinicio al cambiar el VSIX, como `tunel-comun.sh`) |
| `deploy/gcp/workspaces/startup-ws.sh` | instala nginx y la plantilla, levanta los `adaceen-web@` habilitados al arrancar, instala extensiones cuando cambia el VSIX; `adaceen-ws-idle-check` busca `serve-web/[^/]*/bin` ademas de `cli/servers/` |
| `deploy/gcp/workspaces/agente/parse.mjs` | `urlEditor` -> `https://<entrada>/ws-<login>/?tkn=<token>` (`AGENT_WEB_BASE_URL`); `resolverEstado`: `ready` = unidad activa y `GET http://127.0.0.1:<puerto>/ws-<login>/version` responde (sin token); sin `sesion` ni `device_code`; `cuerpoRespuesta` sin `tunnelName`/`deviceCode` |
| `deploy/gcp/workspaces/agente/agente-workspaces.mjs` | `observar` sin `code tunnel user show` ni journal; lee `/etc/adaceen-web/ws-<login>.env` y `.token` como root; `AGENT_SCRIPT=/opt/adaceen/nuevo-web.sh`; ruta nueva `POST /workspaces/:login/rotate` |
| `deploy/gcp/workspaces/agente/relay.mjs`, relay de PDC | `rutaPermitida` admite la rotacion |
| `deploy/gcp/workspaces/entrada/` (nuevo) | `Dockerfile`, `Caddyfile`, `desplegar-entrada.sh` (`gcloud run deploy`, firewall) |
| `src/services/workspace-provider.ts` | `validWebUrl` acepta el host de `WORKSPACE_WEB_BASE_URL` con `?tkn=`; `buildTunnelWebUrl` deja de poder construirse sin el agente (sin token): `webUrl` vacio hasta `ready`; `WorkspaceState` sin `device_code` |
| `src/routes/workspace-routes.ts` | `tunnel_workspace_device_code` deja de emitirse; `webUrl` nunca en eventos; `prepare` con `force` y el logout piden la rotacion |
| Rutas de autenticacion (`logout`) | rotacion de mejor esfuerzo por el agente |
| `.env.example`, `deploy/produccion.sh`, `deploy/azure/` | `WORKSPACE_WEB_BASE_URL` (la URL de Cloud Run); `GET /api/workspaces/provider` la expone (`webBaseUrl`) |
| `browser-ext-prod/services/github.service.js` | `isTunnelEditorUrl` acepta el `webBaseUrl` que diga el backend |
| `browser-ext-prod/services/workspace.service.js` | `saveTunnelEditor`/`adoptExistingTunnelEditor` guardan la URL sin `?tkn=`; rama `device_code` y `showDeviceCodeStep` fuera; textos «vscode.dev/tunnel» tambien en `codespace-waiting-content.service.js` |
| `browser-ext-prod/manifest.json`, `background.js` | el host de la entrada en `content_scripts.matches`/`host_permissions` solo si se quiere el overlay dentro del editor (hoy, `vscode.dev`) |
| `vscode-ext-prod/src/backend-url.ts` | `detectEditorHost` da `remote` con serve-web; si `editorHost` importa para el dataset, un valor propio (`web-vm`) |
| `docs/arquitectura/contrato-api.md`, `guia-instalacion-uso.md`, `piloto/prueba-inicio-a-fin.md` (P1.4/P1.5), `operacion/despliegue.md`, `workspaces-tunnel.md` | contrato sin `device_code`, pasos del estudiante sin codigo, despliegue de la entrada |
| `tests/routes/workspace-routes.test.ts`, `tests/scripts/browser-ext-flujo-tunel.test.ts`, `deploy/gcp/workspaces/agente/*.test.mjs` | al dia con lo anterior |

No cambian: `create-ws-vm.sh`, el relay y su contrato, la sesion del editor,
`instalar-vsix.sh`, el autoencendido, la GPU. El proveedor puede seguir
llamandose `tunnel` en `ADACEEN_WORKSPACE_PROVIDER` y en la tuerca (es "editor
en la VM de Google Cloud"); un valor nuevo `web` solo si se quiere convivir con
el tunel durante la transicion.

## Costos

Precios de lista aproximados (us-central1), sin verificar en la calculadora; el
piloto son 8 h/dia por 20 dias = 160 h.

| Recurso | Precio aprox. | Piloto |
|---|---|---|
| adaceen-ws e2-standard-4 + disco (igual que hoy) | 0,134 USD/h + ~6 USD/mes | ~27 USD |
| Cloud Run (1 vCPU, 512 MiB; se cobra mientras haya WebSockets abiertos) | ~0,09 USD/h | ~15 USD, ~10 con el nivel gratuito |
| Direct VPC egress | 0 | 0 |
| (alternativa) conector de Serverless VPC Access | 2 x e2-micro siempre encendidos | ~11-15 USD/mes |
| (alternativa b) Cloudflare Tunnel | 0; dominio ~10-15 USD/año | ~15 USD una vez |
| (alternativa c') balanceador HTTPS externo | ~18-20 USD/mes | ~20 USD |
| Dev Tunnels / vscode.dev | 0 | ya no se usan |
| Salida a internet desde la VM (Cloud NAT, por los editores) | ~0,045 USD/GB | < 2 USD |

Disco en la VM: ~100 MB de servidor web por estudiante
(`~/.vscode/cli/serve-web/<commit>`), del mismo orden que los servidores del
tunel de hoy; con 60 GB sobra.

## Limites conocidos

- **Settings Sync y cuenta dentro del editor.** Siguen existiendo pero exigen
  iniciar sesion con GitHub/Microsoft; no hacen falta (ajustes de maquina y
  extension ya estan) y no se usan. No estorban.
- **Extensiones del Marketplace en serve-web.** El servidor de Microsoft usa
  el Marketplace real; el estudiante puede instalar desde la vista de
  extensiones (quedan en su `~/.vscode-server/extensions`). Lo que no hay es
  preinstalacion desde la unidad: se instala con el servidor bajado, despues
  del primer arranque (el script lo hace; en produccion, el agente).
- **Actualizaciones del CLI.** `startup-ws.sh` instala el CLI una vez.
  `serve-web` sirve cliente y servidor de **su propio commit**: no hay
  desfase con vscode.dev (hoy vscode.dev manda y el CLI baja el servidor que
  toca), pero tampoco actualizaciones solas. Actualizar = bajar el binario
  nuevo en `startup-ws.sh` y reiniciar los `adaceen-web@` fuera de clase; cada
  estudiante vuelve a bajar ~100 MB al abrir.
- **Un origen para todos** (con Cloud Run): cookies y almacenamiento del
  navegador compartidos entre estudiantes en el mismo equipo; ver
  "Seguridad". Subdominios por estudiante solo con dominio propio (b).
- **Cloud Run:** 60 min como maximo por conexion (VS Code reconecta solo,
  criterio del spike), 32 MiB por peticion (subidas por arrastre grandes),
  arranque en frio de 1-2 s si `min-instances=0`.
- **El token se lee al arrancar:** rotar = reiniciar el servicio (corte de
  unos segundos).
- **Carpeta de datos del CLI por estudiante.** `--cli-data-dir` compartido no
  sirve: todos escribirian el mismo `serve-web-token`.
- **Apagado por inactividad.** `adaceen-ws-idle-check` busca
  `cli/servers/<version>/server`; con serve-web hay que mirar tambien
  `serve-web/<commit>/bin` (o las conexiones abiertas en nginx); si no, la VM
  se apagaria en mitad de la clase.
- **Primer arranque por estudiante:** ~1 min para bajar el servidor, como con
  el tunel; el script y el agente lo tratan como `pending`.

## Spike: plan paso a paso

Todo con la rama empujada a GitHub y la VM con esa rama en la metadata
`branch` (`startup-ws.sh` copia `deploy/gcp/workspaces/*.sh` a `/opt/adaceen`).
Un solo login de prueba (`pruebaweb`) o el tuyo. Nada de esto toca a los
estudiantes ni a los tuneles.

1. **El servicio arranca.** En la VM (`gcloud compute ssh adaceen-ws
   --zone=us-central1-a --tunnel-through-iap`):
   `sudo bash /opt/adaceen/spike-serve-web.sh <login> --mostrar-token` y antes
   `code serve-web --help` para anotar las opciones reales. Exito:
   `systemctl is-active adaceen-web@ws-<login>` = `active`; en
   `journalctl -u adaceen-web@ws-<login>` la linea `Web UI available at
   http://127.0.0.1:<puerto>/ws-<login>/?tkn=`; `curl -s -o /dev/null -w
   '%{http_code}' http://127.0.0.1:<puerto>/ws-<login>/` = `403` sin token y
   `302` con `?tkn=<token>`; existe
   `/home/ws-<login>/.vscode/cli/serve-web/*/bin/code-server`. Si `%d` no
   expande, aplicar el plan B del token y anotarlo.
2. **Idempotente y con extension.** Volver a correr el script. Exito: «token
   de antes», el mismo puerto, ningun `daemon-reload`, la extension en
   `ls /home/ws-<login>/.vscode-server/extensions` (`adaceen.adaceen-0.0.33`).
3. **Desde el portatil.** `gcloud compute ssh adaceen-ws --zone=us-central1-a
   --tunnel-through-iap -- -N -L <puerto>:127.0.0.1:<puerto>` y abrir
   `http://127.0.0.1:<puerto>/ws-<login>/?tkn=<token>`. Exito: arbol de
   archivos en menos de 60 s, la URL queda sin `?tkn=`, la terminal abre como
   `ws-<login>`, la barra de estado dice «ADACEEN» conectado tras escribir una
   sesion (procedimiento «A mano, solo con un login de prueba» de
   [workspaces-tunnel.md](workspaces-tunnel.md)) y, con `adaceen-worker`
   encendida, «GPU: Google Cloud - L4». Anotar `vscode.env.remoteName` (Ayuda
   > Acerca de, o un `console.log` de la extension) y la latencia de tecleo
   frente a vscode.dev.
4. **Dos estudiantes.** `spike-serve-web.sh otro`. Exito: puerto y token
   distintos; desde la terminal de `<login>`: `curl -s -o /dev/null -w
   '%{http_code}' http://127.0.0.1:<puerto-otro>/ws-otro/` = `403`,
   `cat /etc/adaceen-web/ws-otro.token` = permiso denegado, `ps -o args -u
   ws-otro` sin ningun token.
5. **Entrada publica.** nginx en la VM con el bloque de arriba y
   `gcloud run deploy` de la opcion (a). Exito: `https://<servicio>.run.app/ws-<login>/?tkn=`
   abre el editor, la terminal responde, la conexion sigue viva 10 min y se
   recupera sola al pasar de 60 min; costo de la tarde visible en Billing. Si
   la politica bloquea el ingreso publico: Quick Tunnel de Cloudflare sobre el
   mismo nginx para medir, y anotar que hace falta decision de dominio.
6. **Rotacion.** `spike-serve-web.sh rotar <login>`. Exito: la pestaña
   abierta pierde la conexion y al recargar da 403; la URL nueva (con el
   token nuevo) entra.
7. **Limpieza y decision.** `spike-serve-web.sh quitar <login>
   --borrar-usuario` para los logins de prueba; rellenar "Resultados" y
   decidir con el dueño (abajo). Si sale bien, la productizacion va por la
   tabla de cambios en una rama `feat/workspace-serve-web`, con el tunel como
   respaldo igual que Codespaces lo es hoy.

## Resultados

_(rellenar al correrlo)_

- `code serve-web --help` en la VM (version del CLI y opciones que difieran de la tabla):
- Servicio activo y `Web UI available` en el journal: SI / NO
- `%d/token` (LoadCredential) funciono: SI / NO (si NO, plan B aplicado: SI / NO)
- Ejecutable del servidor en `~/.vscode/cli/serve-web/<commit>/bin/code-server`: SI / NO
- Segundos hasta `Web UI available` (primer arranque):
- Segundos hasta ver archivos desde el portatil:
- Extension ADACEEN instalada con el servidor y conectada con `editor-session.json`: SI / NO; `remoteName` visto:
- Barra de estado "GPU: Google Cloud - L4": SI / NO
- 403 entre estudiantes y token ausente en `ps`: SI / NO
- Entrada publica probada: Cloud Run / Quick Tunnel / ninguna; politica de ingreso: ; URL:
- Reconexion tras 60 min (Cloud Run): SI / NO
- Latencia de tecleo frente a vscode.dev:
- Costo de la tarde (Billing):
- Observaciones:

## Decision pendiente para el dueño

Que entrada publica se adopta, porque de eso depende todo lo demas:
**(a) Cloud Run** en `*.run.app`, sin dominio ni terceros nuevos, si la
organizacion permite ingreso publico en Cloud Run (se sabe en el paso 5 del
spike), o **(b) Cloudflare Tunnel** con un dominio propio (gratis, subdominio
por estudiante, pero un proveedor mas viendo el trafico y un dominio que
comprar y mantener). Y, con la entrada elegida, si esto reemplaza al tunel
antes del piloto o queda como plan C detras de Codespaces y el tunel.
