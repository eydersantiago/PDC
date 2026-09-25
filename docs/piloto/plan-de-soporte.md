# Plan de soporte durante el piloto

| | |
|---|---|
| Jira | A13.5 · ADACEEN-113 |
| Relacionados | [Runbook](../operacion/runbook.md), [contingencia](../operacion/contingencia.md), [monitoreo](../operacion/monitoreo.md), [protocolo](protocolo.md), [guía de instalación y uso](../guia-instalacion-uso.md) (sección 3.1), [acceso simplificado](../arquitectura/acceso-simplificado.md) |
| Registro | `data/piloto/plantillas/registro-incidentes.csv`: una copia por sesión, fuera del repositorio, con la fecha en el nombre (`registro-incidentes-<fecha>.csv`, por ejemplo `registro-incidentes-2026-10-13.csv`) |

## 1. Quién atiende

| Rol | Persona | Contacto | Qué atiende |
|---|---|---|---|
| Responsable técnico | Eyder Santiago Suárez Chávez (investigador) | En la sala; [teléfono o chat] | Todo lo técnico: extensión, editor, túnel, GPU, backend |
| Docente del curso | [por confirmar] | En la sala | Dudas del curso, orden de la clase, decisión de suspender |
| Director | Víctor Andrés Bucheli Guerrero, PhD | [correo] | Decisiones de protocolo (repetir una sesión, cambiar fechas) |
| Canal del grupo | [por definir: chat del curso] | — | Avisos a todos los estudiantes |

Fuera de las sesiones las consultas llegan al correo del investigador y se
responden en un día hábil.

## 2. Severidad y tiempos de respuesta

| Severidad | Qué es | Ejemplos | Respuesta | Resolución o decisión |
|---|---|---|---|---|
| S1 crítica | La clase, o más de la mitad del grupo, no puede trabajar | Backend caído; VM de editores apagada; túneles caídos para muchos; VS Code «sin conectar» para todos; sin GPU en un bloque con tutor por más de 10 min | Inmediata (≤ 5 min) | En ≤ 15 min: seguir en modo degradado, cambiar de plan o suspender (la sesión se repite) |
| S2 alta | Un estudiante o un grupo pequeño no puede trabajar | Sin sesión en la extensión; «Abrir mi editor» falla; VS Code en «ADACEEN: sin conectar» | ≤ 5 min | ≤ 15 min; si no, el estudiante trabaja sin ADACEEN y se anota |
| S3 media | Se trabaja, pero con degradación | Latencia alta; respuestas degradadas aisladas; un error de la extensión con alternativa | ≤ 15 min o al terminar el bloque | Durante la sesión si es posible |
| S4 baja | Dudas y sugerencias | «¿Por qué no me dio el código?»; ideas de mejora | Al final de la sesión | Se anotan para los hallazgos |

Los incidentes S1 cuentan para el KPI T7 (meta: cero en todo el piloto).

## 3. Flujo de un incidente

1. **Detectar.** Alerta del monitor (`npm run piloto:monitor`), estudiante que
   levanta la mano, observador o alerta de Azure o GitHub.
2. **Registrar.** Hora de inicio y síntoma en el registro, antes de tocar nada.
3. **Diagnosticar.** Tabla de síntomas del [runbook](../operacion/runbook.md) y, para el editor y VS Code, la sección 7.
4. **Responder.** Según el [plan de contingencia](../operacion/contingencia.md).
5. **Comunicar.** Con los mensajes de la sección 4.
6. **Cerrar.** Hora de fin, causa, respuesta y evidencia en el registro. Si fue
   en un bloque con tutor y duró más de 10 minutos, marcar el bloque como
   degradado (criterio de validez del protocolo).

## 4. Mensajes para los estudiantes

- **Tutor lento o caído:** «El tutor está tardando o no responde. Sigan con el
  ejercicio como en cualquier clase; les aviso cuando vuelva.»
- **Tutor de vuelta:** «El tutor ya responde de nuevo.»
- **Editor caído para todos:** «Estamos revisando el editor. No cierren la
  pestaña; en unos minutos les digo cómo seguir.»
- **VM de editores encendiéndose:** «El editor se está encendiendo. No cierren
  la ventana de ADACEEN: se abre sola en uno o dos minutos.»
- **VS Code sin conectar:** «Vuelvan al navegador y pulsen Abrir mi editor; si
  sigue sin conectar, en VS Code pulsen ADACEEN: sin conectar y elijan Con mi
  cuenta de GitHub.»
- **Suspensión:** «Por un problema técnico no podemos seguir con la actividad
  de hoy. La repetimos [fecha]. Gracias por la paciencia.»
- **Problema de un estudiante:** el investigador va al puesto; el resto sigue.

## 5. Registro de incidentes

Una fila por incidente, con las columnas de `registro-incidentes.csv`:
fecha · hora de inicio · hora de fin · severidad · síntoma · afectados
(número, sin nombres) · causa · respuesta · responsable · evidencia (captura o
línea del monitor).

Después de cada sesión: revisar el registro con el del monitor
(`exportes/monitor-<fecha>.jsonl`), guardar la copia
`registro-incidentes-<fecha>.csv` en la carpeta de las hojas del piloto (la que
se pasa con `--registros`) y anotar las mejoras que salgan (hallazgos, A14.5).
El KPI T7 sale de esas copias: `npm run piloto:analisis -- --registros=<carpeta>`
cuenta los incidentes S1 con `fecha` en las sesiones del plan. Una copia sin
filas cuenta como sesión sin incidentes solo si su nombre tiene la fecha
([análisis de datos](analisis-de-datos.md), sección 3.1). El bloque `registros`
del plan del piloto queda como respaldo si no hay plantilla válida.

## 6. Antes de cada sesión (30 minutos)

- `bash deploy/clase.sh iniciar` en Cloud Shell (enciende la GPU y la VM de
  editores y espera a que estén listas; [runbook](../operacion/runbook.md),
  sección 0). Después, `<backend>/empezar`: «Editor en la nube» en «Encendido»
  y «Tutor (modelo)» en «Disponible». Con transporte directo (sin relay) la
  página solo dice «Configurado»: confirmar con `bash deploy/clase.sh estado`.
  «En reposo» después de `iniciar` no es listo: la VM está encendida pero el
  agente todavía no se conecta; esperar un minuto o revisar el agente
  (sección 7, fila «Encendiendo la VM de editores...»). Abrir esa página
  también despierta al backend: en frío tarda y «Abrir en VS Code de este
  equipo» solo espera 3,5 s el código.
- Lista «Antes de cada sesión» de los [prerrequisitos](../operacion/prerrequisitos.md).
- Monitor corriendo con la hora de inicio de la sesión.
- Registro de incidentes de la fecha abierto.
- Teléfono o chat del canal del grupo a mano.
- Portátil del investigador con `gcloud` (o Cloud Shell con el repositorio en
  la rama de producción), acceso al portal de Azure y, de respaldo, la opción 1
  del `.bat` de la GPU.
- Al terminar: `bash deploy/clase.sh terminar`.

## 7. Fallos del editor y de VS Code (acceso simplificado)

Extensión de navegador 0.7.11, VS Code 0.0.31. Lo que ve el estudiante está en
la [guía](../guia-instalacion-uso.md), sección 3.1; aquí va lo que hace el
responsable técnico.

| Síntoma | Severidad | Causa probable | Respuesta |
|---|---|---|---|
| Muchos estudiantes con «El editor esta apagado; avisa al docente» | S1 | VM de editores apagada y sin encendido automático. Con encendido automático también sale si la VM se está apagando o se apagó hace menos de 15 minutos (por ejemplo, tras `clase.sh terminar`: el backend no la enciende en ese lapso), o si Google Cloud rechazó el encendido (permisos, cuota). La ventana de cada estudiante sigue esperando. | `bash deploy/clase.sh iniciar`. Cuando `/empezar` diga «Encendido», las ventanas abren solas; si alguna ya se rindió, «Abrir mi editor». Con encendido automático, el motivo queda en el log del App Service: `[workspaces] autoencendido de la VM no disponible: <motivo>`. |
| «Encendiendo la VM de editores...» por más de 3 minutos | S1 si es de todos | La VM encendió pero el agente no se conecta (o arranca lento), o Google Cloud la tiene todavía en arranque o reparación (`STAGING`, `REPAIRING`). Con la VM ya en marcha, el backend dice «Encendiendo» hasta 5 minutos después de pedir el encendido; pasado ese tiempo, sin agente, pasa a «El editor esta apagado; avisa al docente». | `bash deploy/clase.sh estado` y revisar el agente: `gcloud compute ssh adaceen-ws --zone=us-central1-a --tunnel-through-iap --command='sudo journalctl -u adaceen-workspaces-agent -n 50'` (debe decir «conectado al relay»; [runbook](../operacion/runbook.md), sección 5). `iniciar` solo vuelve a esperar. |
| Todos los VS Code del túnel sin «ADACEEN: <nombre>» ni «ADACEEN: sin conectar» en la barra de estado, y sin «ADACEEN: Conectar» en `F1` | S1 | La VM tiene la extensión 0.0.30: no lee `editor-session.json`, no tiene «Con mi cuenta de GitHub» y su «ADACEEN: Configurar sesión compartida» guarda como sesión cualquier texto; con el backend nuevo, «Copiar sesion» copia un código `XXXX-XXXX`, que esa versión no canjea. Pasa si se desplegó el backend sin actualizar la VM. | No hay arreglo en clase: los eventos de VS Code quedan anónimos. Actualizar la VSIX antes de la clase ([túneles](../workspaces-tunnel.md)): en `/var/log/adaceen-ws-startup.log` debe salir `--- VSIX adaceen 0.0.31 instalado …` (o `ya instalado`, sin `AVISO VSIX`). |
| Todos los VS Code del túnel en «ADACEEN: sin conectar» | S1 | La VM tiene la extensión 0.0.31 pero el agente anterior, que ignora la sesión y no escribe `editor-session.json`. El navegador igual da el editor por preparado. | Mientras tanto: «ADACEEN: Conectar» → «Con mi cuenta de GitHub (recomendado)» en VS Code. Actualizar el agente fuera de clase ([túneles](../workspaces-tunnel.md)). Para comprobarlo hace falta una preparación real: un «Abrir mi editor» con el editor guardado hace menos de 7 días solo consulta el estado y no escribe la sesión mientras la del túnel siga activa. Con una cuenta de prueba: «Salir», entrar de nuevo y «Abrir mi editor» (o «Preparar mi editor» en otro navegador). Después, `/home/ws-<login>/.adaceen/editor-session.json` con permisos 600 y «sesion del editor escrita» en `journalctl -u adaceen-workspaces-agent`. |
| Un estudiante con «ADACEEN: sin conectar» o el aviso de sesión que dejó de valer | S2 | Cerró sesión en este u otro equipo, o la sesión venció (30 días). | «Abrir mi editor» (si el overlay pide entrar, entrar antes): si cerró sesión en ese navegador pasa por la preparación, y si la cerró en otro el backend ve que no queda sesión del túnel y reenvía la preparación antes de abrir. En los dos casos la VM recibe una sesión nueva. Si no se arregla, en VS Code «ADACEEN: Conectar» → «Con mi cuenta de GitHub». |
| Un docente o administrador no puede conectar VS Code con GitHub | S3 | Esas cuentas no se vinculan por GitHub (`staff_requires_code`). | «Abrir en VS Code de este equipo», o «Copiar sesion» en `vscode.dev` y «Tengo un código del navegador». |
| Mac: VS Code dice que el código no existe, ya se usó o venció | S2 | El código venció (10 min) o ya se usó; o en esa Mac corre un backend local (`127.0.0.1:3000`) y VS Code canjea contra él. | Pulsar el botón otra vez. Si el aviso nombra el backend local, apagarlo o fijar `adaceen.backend.baseUrl` a producción en ese equipo. |
| Mac: el repo se abre en VS Code, pero «sin conectar» | S2 | El backend tardó más de 3,5 s en dar el código (arranque en frío). | Pulsar el botón otra vez, o «Con mi cuenta de GitHub». Prevención: abrir `/empezar` antes de la clase. |
| Mac: el enlace no abre VS Code o no pasa nada | S2 | VS Code nunca se abrió en ese equipo, o tiene la extensión 0.0.30. La primera vez VS Code pregunta si deja abrir el enlace. | Doble clic en `Preparar-Mac-ADACEEN.command` (actualiza la extensión) y abrir VS Code una vez a mano. |
| Mac: Gatekeeper bloquea el instalador o falta `git` | S2 | Archivo descargado sin firma; Mac sin herramientas de Apple. | [Runbook](../operacion/runbook.md), sección 5. En VS Code, «Instalar git» y luego cerrar y abrir VS Code. |
| «Demasiados intentos seguidos» en varios equipos | S3 | Más de 20 intentos fallidos por minuto desde la misma IP (el laboratorio sale por una sola). | Esperar un minuto; revisar si alguien está probando códigos viejos. |
| «todavía no permite conectar VS Code así» | S2 | El backend de producción no tiene esta versión. | Desplegar; mientras tanto, «Pegar sesión» con el ID del navegador. |
| El código de GitHub (`github.com/login/device`) venció o «ADACEEN dejo de esperar.» | S3 | No se autorizó en unos 12 minutos, o se cerró la pestaña de ADACEEN. | «Abrir mi editor» y usar el código nuevo. |
| `/empezar` dice que una descarga «todavia no esta publicado» | S3 | El despliegue no empaquetó ese archivo. | Repartir el zip o el VSIX por otro medio y revisar el paso de empaquetado del workflow de despliegue. |
| El relay o los códigos fallan al azar | S1 | El App Service tiene más de una instancia: el relay, los limitadores y las preparaciones en curso viven en la memoria de cada una. | Dejar una sola instancia. |
