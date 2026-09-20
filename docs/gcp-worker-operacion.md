# Worker en Google Cloud — operación diaria

Comandos para encender, apagar, vigilar y diagnosticar la VM `adaceen-worker`.
El porqué de cada pieza está en
[gcp-worker-infraestructura.md](gcp-worker-infraestructura.md).

> **Dónde se ejecutan estos comandos.** En **Cloud Shell** (botón `>_` en la
> consola de GCP) o en cualquier terminal con `gcloud` autenticado. No sirve
> PowerShell de Windows sin `gcloud` instalado: los `\` de continuación de línea
> y `chmod` son sintaxis POSIX. Si usas PowerShell, escribe cada comando en una
> sola línea.

Valores por defecto asumidos en todo el documento:

```
PROYECTO=adaceen-508504    ZONA=us-central1-a    VM=adaceen-worker
```

---

## Chuleta

| Quiero… | Comando |
|---|---|
| Ver si está encendida | `gcloud compute instances list` |
| **Encender** | `gcloud compute instances start adaceen-worker --zone=us-central1-a` |
| **Apagar** | `gcloud compute instances stop adaceen-worker --zone=us-central1-a` |
| Ver el log del worker | ver [§3](#3-logs) |
| Entrar por SSH | `gcloud compute ssh adaceen-worker --zone=us-central1-a --tunnel-through-iap` |
| Estado + costos vivos | `bash deploy/gcp/teardown.sh` |
| Borrar todo (gasto a cero) | `bash deploy/gcp/teardown.sh destroy` |

---

## 1. Antes de empezar a trabajar

### 1.1 Ver el estado

```bash
gcloud compute instances list
```

```
NAME: adaceen-worker
ZONE: us-central1-a
MACHINE_TYPE: g2-standard-8
PREEMPTIBLE: true
INTERNAL_IP: 10.128.0.3
EXTERNAL_IP:
STATUS: RUNNING          <-- esto es lo que importa
```

- `RUNNING` → lista para recibir jobs.
- `TERMINATED` → apagada (por el timer de inactividad, por un desalojo de Spot o
  porque la apagaste tú). **Hay que encenderla a mano.**

Solo el estado, para usar en scripts:

```bash
gcloud compute instances list --filter="name=adaceen-worker" --format="value(status)"
```

### 1.2 Encender

```bash
gcloud compute instances start adaceen-worker --zone=us-central1-a
```

Tarda unos **40 segundos** en quedar `RUNNING`. El disco conserva Node, Ollama,
el repo y el modelo, así que **no** repite la instalación: el startup script
comprueba cada pieza y se salta lo que ya está.

El worker arranca solo (`systemd`, `Restart=always`). No hay que hacer nada más.

### 1.3 Confirmar que el worker está vivo

```bash
gcloud compute ssh adaceen-worker --zone=us-central1-a --tunnel-through-iap --command='
  systemctl is-active adaceen-worker ollama
  nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv
  curl -s http://127.0.0.1:11434/api/tags | head -c 300
'
```

Esperado: dos `active`, la L4 con su VRAM, y el JSON con el modelo cargado.

---

## 2. Al terminar

### 2.1 Apagar (pausa de horas o días)

```bash
gcloud compute instances stop adaceen-worker --zone=us-central1-a
```

o, equivalente y con aviso de costos:

```bash
bash deploy/gcp/teardown.sh stop
```

> **La GPU y las vCPU dejan de facturar, el disco no.** 120 GB de `pd-balanced`
> cuestan del orden de **$12/mes** aunque la VM esté apagada.

### 2.2 Si no la vas a usar en semanas

```bash
bash deploy/gcp/teardown.sh destroy
```

Borra la VM, el NAT y el router. Conserva la regla de firewall `allow-iap-ssh`,
que no cuesta nada. El gasto queda en cero.

Para volver:

```bash
cd deploy/gcp
bash create-vm.sh l4      # ~12 min: reinstala driver, Node, Ollama y el modelo
```

### 2.3 Apagado automático

No hace falta acordarse: un timer de systemd apaga la VM tras el tiempo de
inactividad configurado (metadata `idle-minutes`, actualmente **180 min**). La
señal de actividad es la `mtime` del log del worker.

Ver cuánto lleva sin actividad:

```bash
gcloud compute ssh adaceen-worker --zone=us-central1-a --tunnel-through-iap --command='
  echo "ultima actividad: $(( ($(date +%s) - $(stat -c %Y /var/log/adaceen-worker.log)) / 60 )) min"
  systemctl list-timers adaceen-idle.timer --no-pager
'
```

Cambiar el umbral (requiere reiniciar para que el script regenere el chequeo):

```bash
gcloud compute instances add-metadata adaceen-worker --zone=us-central1-a \
  --metadata=idle-minutes=60
gcloud compute instances reset adaceen-worker --zone=us-central1-a
```

---

## 3. Logs

### 3.1 Log del worker (el que usarás el 90% de las veces)

```bash
gcloud compute ssh adaceen-worker --zone=us-central1-a --tunnel-through-iap \
  --command='sudo tail -f /var/log/adaceen-worker.log'
```

Últimos jobs procesados:

```bash
gcloud compute ssh adaceen-worker --zone=us-central1-a --tunnel-through-iap --command='
  sudo grep -a -E "queue.job.process.done|queue.result.send.done" /var/log/adaceen-worker.log | tail -5
'
```

> El `-a` de `grep` es necesario: el log contiene bytes de control de las barras
> de progreso de la descarga del modelo, y sin `-a` grep lo trata como binario y
> no imprime nada.

### 3.2 Log de arranque (instalación, driver, descarga del modelo)

```bash
gcloud compute ssh adaceen-worker --zone=us-central1-a --tunnel-through-iap \
  --command='sudo tail -f /var/log/adaceen-startup.log'
```

Busca la última línea: `=== listo. worker=... modelo=... idle=...min ===`.
Si no está, el arranque no terminó.

### 3.3 Consola serie (cuando SSH todavía no responde)

Útil en los primeros segundos tras `start`, o si SSH falla:

```bash
gcloud compute instances get-serial-port-output adaceen-worker --zone=us-central1-a | tail -60
```

> Si responde `The resource ... is not ready`, la VM está apagada o arrancando.

---

## 4. Mantenimiento

### 4.1 Actualizar el código del worker

El startup script hace `git reset --hard` a la rama configurada en cada arranque.
La forma limpia de desplegar un cambio es **reiniciar**:

```bash
gcloud compute instances reset adaceen-worker --zone=us-central1-a
```

O sin reiniciar, volviendo a ejecutar el startup script:

```bash
gcloud compute ssh adaceen-worker --zone=us-central1-a --tunnel-through-iap \
  --command='sudo google_metadata_script_runner startup'
```

### 4.2 Cambiar de rama

```bash
gcloud compute instances add-metadata adaceen-worker --zone=us-central1-a \
  --metadata=branch=master
gcloud compute instances reset adaceen-worker --zone=us-central1-a
```

### 4.3 Cambiar el modelo

```bash
gcloud compute instances add-metadata adaceen-worker --zone=us-central1-a \
  --metadata=model-text=qwen2.5-coder:32b
gcloud compute instances reset adaceen-worker --zone=us-central1-a
```

Descargar uno a mano sin reiniciar (recuerda: por la API, **no** con
`ollama pull`, que guardaría en el directorio equivocado):

```bash
gcloud compute ssh adaceen-worker --zone=us-central1-a --tunnel-through-iap --command='
  curl -sS -X POST http://127.0.0.1:11434/api/pull \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"qwen2.5-coder:32b\"}" | tail -2
'
```

Caben en los 24 GB de la L4: hasta 14B con holgura, un 32B en Q4 justo.

### 4.4 Rotar los secretos

Si regeneras la SAS de Service Bus:

```bash
gcloud compute instances add-metadata adaceen-worker --zone=us-central1-a \
  --metadata=sb-conn='Endpoint=sb://...'
gcloud compute instances reset adaceen-worker --zone=us-central1-a
```

> Este comando **sí** deja el secreto en el historial del shell. Si te importa,
> usa `--metadata-from-file=sb-conn=archivo.txt` y borra el archivo después.

### 4.5 Reiniciar solo el worker

```bash
gcloud compute ssh adaceen-worker --zone=us-central1-a --tunnel-through-iap \
  --command='sudo systemctl restart adaceen-worker && sleep 3 && systemctl status adaceen-worker --no-pager'
```

---

## 5. Diagnóstico

| Síntoma | Causa más probable | Qué hacer |
|---|---|---|
| SSH: `4003: failed to connect to backend` | **La VM está apagada**, no es problema de red | `gcloud compute instances list`, y `start` si está `TERMINATED` |
| La VM está `RUNNING` pero los jobs nunca llegan | El worker no arrancó, o nombres de cola distintos | §5.1 y §5.2 |
| Primer job tarda ~57 s | Ollama recargando el modelo en VRAM | Normal. Manda un job de calentamiento antes de la demo |
| La VM se apagó sola | Timer de inactividad o desalojo de Spot | `start`; ver §2.3 |
| `Network is unreachable` sobre IPv6 en el startup | Cloud NAT solo hace IPv4 | Es advertencia, no error; apt reintenta por IPv4 |
| `npm ci` falla en el arranque | Sin salida a internet: falta el NAT | §5.3 |

### 5.1 Verificar que el worker está conectado a la cola

```bash
gcloud compute ssh adaceen-worker --zone=us-central1-a --tunnel-through-iap --command='
  systemctl status adaceen-worker --no-pager | head -20
  sudo tail -20 /var/log/adaceen-worker.log
'
```

### 5.2 Verificar que las colas coinciden con el backend

El worker escucha en `llm-jobs` y responde en `llm-results-sessions`. El App
Service tiene que usar **esos mismos nombres**. Comprobarlo desde fuera:

```bash
curl -s https://<tu-app-service>.azurewebsites.net/health | python3 -m json.tool
```

Debe mostrar:

```json
{
  "mode": "queue",
  "queue_configured": true,
  "jobs_queue_name": "llm-jobs",
  "results_queue_name": "llm-results-sessions"
}
```

> Si los nombres no coinciden, el backend publica en una cola que nadie escucha:
> los jobs mueren por timeout **sin ningún mensaje de error**. Es el fallo más
> difícil de diagnosticar del sistema.

### 5.3 Verificar la red de salida

```bash
gcloud compute routers nats list --router=adaceen-router --region=us-central1
```

Debe listar `adaceen-nat`. Si no existe, recrearlo:

```bash
gcloud compute routers create adaceen-router --network=default --region=us-central1
gcloud compute routers nats create adaceen-nat \
  --router=adaceen-router --region=us-central1 \
  --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges
```

Y la regla de SSH por IAP:

```bash
gcloud compute firewall-rules list --filter="name=allow-iap-ssh"
```

---

## 6. Costos

### 6.1 Estado de los recursos que facturan

```bash
bash deploy/gcp/teardown.sh
```

Lista la VM, **los discos** (que cuestan aunque la VM esté apagada), el router,
el NAT y las GPUs en uso.

### 6.2 Créditos restantes

Consola → **Facturación → Créditos**. Recordatorio de fechas:

- Free Trial ($300): **vence el 12 de diciembre de 2026**. No lo guardes.
- Developer Program ($10/mes): renovable hasta el 12 de septiembre de 2027. En
  Spot, unas 60 h de GPU al mes.

### 6.3 Alerta de presupuesto

```bash
gcloud billing budgets list --billing-account=<ID-de-facturacion>
```

> Una alerta de presupuesto **solo notifica, no apaga nada**. El mecanismo que de
> verdad protege el crédito es el timer de inactividad (§2.3).

---

## 7. Recrear todo desde cero

Si borraste con `destroy`, o quieres una VM en otra zona:

```bash
cd deploy/gcp
bash create-vm.sh l4
```

Pide por teclado (sin eco, no queda en el historial):

1. la connection string SAS de Service Bus — la política `colab-worker`, con
   `Listen` en `llm-jobs` y `Send` en `llm-results-sessions`;
2. el `WORKER_SHARED_SECRET` — el mismo que tiene el App Service.

Variables que puedes anteponer: `ZONA`, `NOMBRE`, `MAQUINA`, `MODELO`, `DISCO`,
`SIN_IP=1`.

Perfiles disponibles:

| Perfil | Máquina | GPU | Modelo por defecto |
|---|---|---|---|
| `cpu` | `c3-standard-8` | — | `qwen2.5:3b-instruct` |
| `t4` | `n1-standard-4` | T4 16 GB | `qwen2.5:7b-instruct` |
| `gpu` / `l4` | `g2-standard-8` | L4 24 GB | `qwen2.5-coder:14b` |
| `l4x2` | `g2-standard-24` | 2× L4 48 GB | `qwen2.5:72b-instruct` |

> `create-vm.sh` crea la VM **con IP pública efímera** salvo que uses `SIN_IP=1`.
> La instancia actual se creó sin IP, que es lo que obliga a tener Cloud NAT.
> Si lanzas con `SIN_IP=1` y el NAT no existe, el startup script muere en el
> primer `apt-get`.
