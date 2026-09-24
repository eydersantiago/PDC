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
  Verificar: `gcloud compute instances describe <vm> --zone=us-central1-a --format="value(metadata.items[].key)"`.
- [ ] **VM de editores** creada (`deploy/gcp/workspaces/create-ws-vm.sh`),
  e2-standard-4, **sin Spot**, con el agente de entornos activo.

## 2. Antes de cada sesión

### Red de la sala (desde un equipo de la sala)

- [ ] `https://vscode.dev` abre.
- [ ] `https://github.com` y `https://github.com/login/device` abren.
- [ ] `https://app-adaceen-api-eyder05232002.azurewebsites.net/api/health` responde JSON.
- [ ] Dev Tunnels: con un túnel de prueba, `https://vscode.dev/tunnel/<túnel>` conecta
  (el dominio del relay de Dev Tunnels no debe estar bloqueado por el proxy de la sala).
- [ ] Campus Virtual abre con la cuenta del docente (si la sesión lo usa).

### Servicio

- [ ] GPU encendida con `ADACEEN-GPU.bat` (opción 1) al menos 10 minutos antes:
  `GET /api/agent/health` → 200 y `alive_workers` ≥ 1.
- [ ] Calentamiento hecho (la opción 1 manda un trabajo de calentamiento) y
  prueba de humo en verde:
  `npm run demo:escenarios -- --url=<backend> --email=<estudiante de prueba> --password=<clave>`.
- [ ] VM de editores encendida; un túnel de prueba abre en `vscode.dev`.
- [ ] Crédito disponible suficiente para la duración de la sesión.

### Estudiantes

- [ ] Extensión instalada y sesión iniciada (encabezado con su nombre).
- [ ] En `vscode.dev` iniciaron sesión **con GitHub**, no con una cuenta
  Microsoft (si no, `vscode.dev` dice que no encuentra el túnel).
- [ ] Sesión compartida configurada en VS Code («ADACEEN: Configurar sesión
  compartida»), para que se aplique la política de su docente.
