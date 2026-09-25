# Prueba de inicio a fin del acceso simplificado

| | |
|---|---|
| Jira | A15.3 · ADACEEN-124: su criterio de cierre es el entorno verificado con al menos 2 cuentas distintas. También sirve de parte del ensayo A13.6 · ADACEEN-114, del cronómetro de instalación (T10) de A16.8 · ADACEEN-150 y del simulacro de A15.5 · ADACEEN-126 |
| Cuándo | Después del [despliegue](../operacion/despliegue.md) completo: backend, VM de editores y GPU |
| Hoja de registro | `data/piloto/plantillas/prueba-inicio-a-fin.csv`: cópiala fuera del repositorio y llena una fila por paso y cuenta (`resultado`: `ok`, `falla` o `no aplica`). Para T10 llena también `data/piloto/plantillas/tiempos-instalacion.csv` |
| Relacionados | [Contrato del acceso simplificado](../arquitectura/acceso-simplificado.md), [runbook](../operacion/runbook.md) (sección 5, síntomas), [contingencia](../operacion/contingencia.md), [plan de soporte](plan-de-soporte.md), [pendientes](pendientes.md) |

- Los textos entre comillas angulares son los de la interfaz, copiados del código
  (algunos van sin tilde porque así están). `<nombre>`, `<login>` y `<código>` son
  valores de cada cuenta.
- Lo que no está en el código (pantallas de GitHub, de VS Code o de macOS) va sin
  comillas angulares y se anota tal como aparezca.
- Antes de guardar una captura, tapa correos, tokens, el código de dispositivo, los
  códigos `XXXX-XXXX` y cualquier `sessionId`.
- `tests/scripts/docs-despliegue-prueba.test.ts` (parte de `npm test`) comprueba que
  cada texto entre comillas angulares, ruta, enlace y script de este guion existe, y que
  la hoja tiene los mismos pasos.

## Qué hace falta

| Quién | Cuenta | Necesita |
|---|---|---|
| **E1** | Estudiante de prueba 1 de ADACEEN | Rol estudiante; cuenta de GitHub **A** y un repositorio **público** de A (el túnel solo clona repositorios públicos) |
| **E2** | Estudiante de prueba 2 de ADACEEN, **distinta** de E1 | Cuenta de GitHub **B** distinta de A, y un repositorio público de B |
| **D** | Docente | Rol «Profesor», con E1 y E2 asignados como sus estudiantes («Administracion de usuarios»), para los bloques del piloto |
| **Operador** | Quien corre los comandos (el dueño) | Cloud Shell con `~/PDC` en `feature/azure-config-observability`; dos ventanas de PowerShell en la carpeta de su clon de `eydersantiago/PDC` (la ruta en su equipo está por verificar; [despliegue](../operacion/despliegue.md), sección 0), con `npm ci` hecho; la contraseña de D para los scripts |

| Equipo | Para qué |
|---|---|
| PC 1 con Chrome | E1 |
| PC 2 con Chrome (u otro perfil o navegador con la extensión, si solo hay un PC) | E2 |
| Segundo navegador en PC 1 (por ejemplo Edge, con la extensión cargada) | Paso P2 (segundo inicio de sesión de E1) |
| Mac del laboratorio (opcional) | Paso P4 |

**Cuidado con el docente D.** «Asignar grupos A y B» asigna una cohorte a **todos** los
estudiantes activos de ese docente y guarda la semilla de la asignación. Los pasos
siguientes la reutilizan. Ni el overlay ni `npm run piloto:bloque` pueden reiniciarla:
el backend acepta `reset: true` en `POST /api/pilot/assign` solo con el bloque en 0, y
no tiene botón. Usa un docente de prueba cuyos únicos estudiantes sean E1 y E2.

**Sacar a E1 y E2 del dataset.** Anota sus correos en `cuentasPrueba` de tu copia de
`data/piloto/plan-piloto.ejemplo.json`. La regla D3 los excluye solo cuando el dataset
se genera desde la base con `--plan=<tu copia>`, que necesita `DATABASE_URL` y
`TELEMETRY_SALT` ([análisis de datos](analisis-de-datos.md)). Con `--entrada`, como en
P7.4, el script avisa `[dataset] Con --entrada no se pueden excluir las cuentas de
prueba …` y sus filas se revisan a mano en `excluidos.csv`. El dataset del piloto
también las deja fuera si su `--desde` es posterior a esta prueba.

Tres notas:

- Las cuentas de docente o administrador no se vinculan con «Con mi cuenta de GitHub»
  en VS Code: el backend responde `staff_requires_code`. Si D prueba VS Code, usa «Tengo
  un código del navegador».
- **Dos ventanas de PowerShell.** La **ventana 1** es para los comandos sueltos (P0.2,
  P2.3, P3.2, P5 y P7) y la **ventana 2** para el monitor de P0.4, que la deja ocupada.
  Las variables de PowerShell (`$B`, `$INICIO`, `$RECONEXION`) solo existen en la
  ventana donde se definen: P0.4 vuelve a definir `$B` y `$INICIO` en la ventana 2. Para
  ver si una ventana las tiene, escribe `$B` o `$INICIO` y Enter.
- En PowerShell escribe cada comando en una línea. Pon la contraseña entre comillas
  simples (`'--password=<clave>'`). Si un script responde
  `[error] Uso: npm run piloto:monitor -- --url=…`, primero revisa que `$B` tenga valor
  en esa ventana: si está vacía, el script recibe `--url=` sin nada y da ese mismo
  error. `[error] Fecha invalida:` sin fecha es lo mismo con `$INICIO` o `$RECONEXION`.
  Si la variable tiene valor, PowerShell se comió el `--`: repite con
  `npx tsx scripts/piloto-monitor.ts --url=… --email=… --password=…` (lo mismo con los
  otros scripts de `scripts/`).

## P0. Chequeo previo (T − 30 min)

| # | Acción | Resultado esperado | Anota | Si falla |
|---|---|---|---|---|
| P0.1 | Cloud Shell: `cd ~/PDC && git pull --ff-only && bash deploy/clase.sh estado` y, si no está listo, `bash deploy/clase.sh iniciar` | `estado` lista las 3 GPU y `adaceen-ws` y dice `backend: modo queue, proveedor de editores tunnel`. `iniciar` termina con `clase lista. Enlace para estudiantes:` y `…/empezar` | Hora; GPU que encendió; salida de `modelo:` (por ejemplo `1 servidor(es) vivo(s): gce-v100`) | [Runbook](../operacion/runbook.md), sección 5 (filas de `clase.sh`). Si falta la GPU, la prueba sigue: el tutor responde degradado y se anota |
| P0.2 | PowerShell, **ventana 1**: `$B = "https://app-adaceen-api-eyder05232002.azurewebsites.net"`, `$INICIO = Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz"`, `$INICIO` (muestra el valor) y `Invoke-RestMethod "$B/api/health" \| Select-Object workspace_provider,workspace_agent_transport,workspace_agent_online,model_workers_alive,telemetry_salt_configured` | `$INICIO` con fecha, hora y zona horaria, sin espacios (formato `yyyy-MM-ddTHH:mm:sszzz`). Luego `tunnel`, `relay`, `True`, `1` o más, `True`. De paso calienta el backend: el código para VS Code tiene un límite de 3,5 s | Valores; el valor de `$INICIO` (para P0.4 y para excluir la prueba del análisis) | `workspace_agent_online` en `False`: [despliegue](../operacion/despliegue.md), sección 4.5 |
| P0.3 | Abrir `$B/empezar` en PC 1 | «Empieza con ADACEEN». En «Estado»: «Editor en la nube:» con «Encendido» y «listo para preparar tu editor.»; «Tutor (modelo):» con «Disponible». Antes de instalar la extensión: «No detectada» | Captura | «Apagado» y «la VM de editores esta apagada. Avisa al docente.»: repetir P0.1 |
| P0.4 | PowerShell, **ventana 2** (en la misma carpeta): `$B = "https://app-adaceen-api-eyder05232002.azurewebsites.net"`, `$INICIO = "<valor anotado en P0.2>"` y `npm run piloto:monitor -- --url=$B --email=<docente> '--password=<clave>' "--desde=$INICIO" --intervalo=15`. La ventana queda ocupada; lo demás va en la ventana 1 | Primera línea `[monitor] … desde <$INICIO>; cada 15 s; registro en exportes/monitor-<fecha>.jsonl`. Luego, cada 15 s, una línea `… \| bloque 0 \| worker ok \| servidores 1 (…) \| …`, sin líneas `ALERTA:` | La ruta del registro | `[error] Uso: …` o `[error] Fecha invalida:`: `$B` o `$INICIO` vacías en esta ventana (tercera nota). `worker CAIDO`: P0.1. El monitor inicia sesión como `cli` y no cierra la sesión del overlay de D |

## P1. Primera vez por túnel (E1 en PC 1; luego E2 en PC 2)

Cronómetro T10: **arranca** al abrir `/empezar` en P1.1 y **para** cuando se cumple
P1.6. Meta: 15 minutos o menos.

| # | Acción | Resultado esperado | Anota | Si falla |
|---|---|---|---|---|
| P1.1 | En `/empezar`: «Descargar la extension», descomprimir, `chrome://extensions` («Copiar direccion»), «Modo de desarrollador», «Cargar descomprimida», elegir la carpeta `adaceen-navegador` y volver a `/empezar` | «Extension del navegador:» con «Instalada» y «lista (version <versión>).», con la versión 0.7.11 | Hora de inicio del cronómetro; minutos hasta aquí | «No detectada»: recargar la página. «Actualizar»: se cargó una carpeta vieja |
| P1.2 | Abrir `https://github.com/<login A>/<repo>`, pulsar el icono de ADACEEN, «Empezar», entrar con «Continuar con Google» o con «Correo», «Contrasena» y «Entrar». La primera vez: «Aceptar y continuar» y «Practicar este curso» | El formulario de «Inicia sesion» llega vacío: no ofrece cuentas demo. El encabezado muestra `<nombre>` y «<rol> \| tutor contextual», con el rol «Estudiante» | ¿Apareció algún texto de cuenta demo? (no debe) | [Guía](../guia-instalacion-uso.md), sección 3.1 |
| P1.3 | Mirar la tarjeta «Accion recomendada» | Título «Conectar GitHub», texto «Un solo paso: conecta tu cuenta de GitHub…» y **un solo** botón: «Conectar GitHub». La fila «GitHub App» dice «No requerida» y la otra fila se llama «Editor». No aparecen «Autorizar repositorio», «Abrir instalacion» ni el aviso «Entendido» | Captura | Si pide la GitHub App, el backend no está en `tunnel` (P0.2) |
| P1.4 | «Conectar GitHub» y autorizar a ADACEEN en GitHub (pantalla de GitHub) | La **misma** ventana vuelve y muestra «ADACEEN esta preparando tu editor» («Clonando el repositorio en la nube y registrando el tunel...»). Luego va sola a `github.com/login/device` con el recuadro «ADACEEN · tu codigo», el código, «Copiar codigo» y «Pegalo aqui y autoriza. Cuando GitHub confirme, esta pestana abrira tu editor sola.». El overlay dice «Autoriza tu editor: codigo <código>» | ¿La ventana pasó sola al dispositivo? ¿El código quedó copiado sin clic? (depende del navegador) | «La cuenta de GitHub <login> no esta en la lista del piloto»: `WORKSPACE_ALLOWED_LOGINS` ([despliegue](../operacion/despliegue.md), 1.2). «El editor esta apagado; avisa al docente»: la ventana sigue esperando; `bash deploy/clase.sh iniciar`. Si la ventana se cerró: «Preparar mi editor» de nuevo |
| P1.5 | Pegar el código en GitHub y autorizar con la **misma** cuenta A (pantallas de GitHub) | La ventana abre `https://vscode.dev/tunnel/ad-<login>/home/ws-<login>/proyecto` con los archivos del repositorio. Si `vscode.dev` pide iniciar sesión: GitHub, nunca una cuenta Microsoft | Textos de las pantallas de GitHub y de `vscode.dev` (por verificar en la guía) | Código vencido (unos 15 min; ADACEEN espera hasta 12): «Abrir mi editor» da otro. `vscode.dev` no encuentra el túnel: sesión Microsoft ([runbook](../operacion/runbook.md), sección 5) |
| P1.6 | Mirar la barra de estado de VS Code **sin tocar nada** (ni F1 ni pegar) | «ADACEEN: <nombre>» (no «ADACEEN: sin conectar»). Al pasar el ratón: «Conectado como <nombre>» y el origen «editor preparado desde el navegador (túnel)». También «GPU: <servidor>» | **Para el cronómetro.** Minutos totales. Operador: [despliegue](../operacion/despliegue.md), 4.5 (archivo `600` de `ws-<login>` y «sesion del editor escrita») | «ADACEEN: sin conectar» más de 20 s: la VM tiene la VSIX 0.0.30 o el agente viejo (log de arranque, `AVISO VSIX`); mientras tanto, clic en la barra → «Con mi cuenta de GitHub (recomendado)» |
| P1.7 | Abrir un archivo, seleccionar unas líneas | Ventana «Sugerencia para la seleccion» (mientras espera, «consultando al backend»). En el overlay, panel «Contexto de trabajo»: «VS Code conectado» | Segundos hasta la sugerencia | «GPU: sin worker activo»: modelo apagado (la sesión puede estar bien). Sin sugerencia: log de VS Code (salida «ADACEEN») |
| P1.8 | **E2 en PC 2:** repetir P1.1 a P1.7 con la cuenta B | Túnel `ad-<login B>` y barra «ADACEEN: <nombre de E2>». En la terminal de `vscode.dev` de E2: `ls /home/ws-<login A>` da `Permission denied` | Minutos de T10 de E2. Monitor: `activos 5 min 2` | Si E2 ve el nombre de E1, **para**: sesión cruzada; guarda la hora e informa |

Con P1.6 y P1.8 en verde para las dos cuentas se cumple el criterio de cierre de
ADACEEN-124 (entorno verificado con 2 cuentas distintas).

## P2. Segundo inicio de sesión sin desconectar VS Code (E1)

| # | Acción | Resultado esperado | Anota | Si falla |
|---|---|---|---|---|
| P2.1 | Con el `vscode.dev` de E1 abierto, entrar con E1 en el **segundo navegador** de PC 1 (P1.1 y P1.2 allí) | El nuevo navegador queda con sesión. El overlay del primer navegador puede pedir entrar de nuevo, por ejemplo «La sesion ya no es valida. Inicia sesion nuevamente.»: es lo esperado (una sesión de navegador por usuario) | Hora | — |
| P2.2 | Volver al `vscode.dev` de E1, seleccionar código | La barra **sigue** en «ADACEEN: <nombre>», llega la sugerencia y **no** aparece la advertencia «ADACEEN: tu sesión dejó de valer (por ejemplo, cerraste sesión en el navegador).» | Captura de la barra | Si VS Code se desconecta, el backend desplegado no separa las sesiones por tipo: revisar el commit desplegado y anotar la hora (esos eventos quedan anónimos) |
| P2.3 | Operador, ventana 1: `npm run piloto:monitor -- --url=$B --email=<docente> '--password=<clave>' "--desde=$INICIO" --una-vez` | Una línea con `eventos` mayor que 0 y **sin** `ALERTA: … sesiones de cliente sin usuario: revisa la sesion compartida de VS Code` | Número de eventos | Con esa alerta: hubo VS Code sin sesión desde `$INICIO`. Anotar cuál (P1.6 o P2.2) |

## P3. Salir y volver otro día (E1)

| # | Acción | Resultado esperado | Anota | Si falla |
|---|---|---|---|---|
| P3.1 | En el overlay del **segundo navegador** de P2.1, que tiene el último inicio de sesión de E1: «Salir». Luego, en el `vscode.dev` de E1 (Chrome de PC 1), seleccionar código (la siguiente petición al backend) | VS Code muestra **una sola vez** la advertencia «ADACEEN: tu sesión dejó de valer (por ejemplo, cerraste sesión en el navegador).», que pide volver a pulsar «Abrir mi editor», con el botón «Conectar». La barra pasa a «ADACEEN: sin conectar» | Hora de «Salir» (desde aquí los eventos de VS Code son anónimos hasta P3.2) | Si no avisa, comprueba que el overlay donde pulsaste «Salir» tenía la sesión vigente: en el Chrome de PC 1, que P2.1 dejó sin sesión, «Salir» no desvincula VS Code. Entra otra vez con E1 en ese overlay (su sesión pasa a ser la vigente), pulsa «Salir» y anota |
| P3.2 | Cerrar la pestaña de `vscode.dev`. Entrar otra vez con E1 en el overlay del Chrome de PC 1 (en el repositorio de A) y pulsar «Abrir mi editor» (tarjeta «Tu editor»). Operador, ventana 1, cuando la barra vuelve a «ADACEEN: <nombre>»: `$RECONEXION = Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz"` | Se abre la ventana de espera y luego `vscode.dev`, **sin** código de dispositivo (el túnel ya estaba autorizado). La barra vuelve sola a «ADACEEN: <nombre>» (el archivo se relee; como mucho unos 20 s) | Hora de reconexión (queda en `$RECONEXION`, para P7.2); clics desde el inicio de sesión | Si pide el código de dispositivo, el túnel perdió su sesión de GitHub: autorizar y anotar. Si queda «sin conectar»: clic en la barra → «Con mi cuenta de GitHub (recomendado)» |
| P3.3 | "Otro día" con la sesión viva: cerrar **todo** el navegador sin «Salir», volver a abrirlo, ir a la página del repositorio y pulsar el icono de ADACEEN | El overlay entra directo, sin «Empezar», con «Abrir mi editor»: **un clic** hasta `vscode.dev`. El marcador de `vscode.dev` también abre el editor ya conectado | Clics hasta el editor | Si reaparece el tour: anotar (es el fallo que esta tanda corrige) |
| P3.4 | (Opcional, tarda más de 2 horas) Dejar la VM sin nadie conectado 120 min (se apaga sola) o `bash deploy/clase.sh terminar`, y pulsar «Abrir mi editor» | Sin autoencendido: «El editor esta apagado; avisa al docente» y la ventana **sigue esperando**. Tras `bash deploy/clase.sh iniciar`, abre sola el editor. Con autoencendido: «Encendiendo la VM de editores...» | Minutos hasta el editor | Si la ventana corta la espera con un error: anotar el texto |

Riesgo conocido (hallazgo 5a, abierto): si E1 sale en un navegador y antes de 7 días
pulsa «Abrir mi editor» en **otro**, el editor abre con la sesión ya desactivada y
VS Code avisa una vez. Se arregla repitiendo «Abrir mi editor» o conectando a mano.

## P4. Mac del laboratorio (opcional, si hay una a mano)

Nada de esto se ha probado en una Mac real. Cronómetro T10 aparte: arranca en P4.1 y
para en P4.3.

| # | Acción | Resultado esperado | Anota | Si falla |
|---|---|---|---|---|
| P4.1 | En `/empezar` de la Mac: «Preparar Mac del laboratorio», descomprimir y doble clic en `Preparar-Mac-ADACEEN.command` | Si macOS lo bloquea: clic derecho → «Abrir»; en macOS 15, Ajustes del Sistema → Privacidad y seguridad → «Abrir igualmente». La Terminal termina con `listo: esta Mac ya esta preparada para ADACEEN. Sigue los pasos de la pagina que se abrio.` y abre `/empezar` | Versión de macOS y de VS Code; minutos; qué pidió | `falta git`: se abre el instalador de Apple, que suele pedir clave de administrador (lo instala soporte del laboratorio). VS Code anterior a 1.96: actualizarlo |
| P4.2 | En Chrome de la Mac: P1.1 y P1.2 con E2 (o E1). En la página del repositorio: «Abrir en VS Code de este equipo» | El overlay dice «Abriendo <owner/repo> en el VS Code de este equipo: si ya estaba clonado se abre esa carpeta; si no, elige donde guardarlo. ADACEEN se conecta solo.». VS Code pregunta la primera vez si permite abrir el enlace (texto de VS Code, anotarlo), pide la carpeta padre, clona y abre | Textos de VS Code y de macOS | No abre VS Code: abrirlo una vez a mano, cerrarlo y repetir. Si la Mac tiene un backend local en `127.0.0.1:3000`, VS Code canjea contra él y el código de producción da `code_not_found` |
| P4.3 | Mirar VS Code | Notificación «ADACEEN: VS Code quedó conectado», seguida del nombre, y barra «ADACEEN: <nombre>» | **Para el cronómetro de la Mac** | Si el overlay dijo «No se pudo pedir el codigo de conexion»: repetir el botón, o en VS Code clic en «ADACEEN: sin conectar» → «Con mi cuenta de GitHub (recomendado)» |

## P5. Bloques con y sin tutor (D con E1 y E2)

| # | Acción | Resultado esperado | Anota | Si falla |
|---|---|---|---|---|
| P5.1 | D entra en el overlay, «Configuración» → «Piloto con y sin tutor» → «Asignar grupos A y B» (ver "Cuidado con el docente D") | El estado dice cuántos quedaron en el grupo A y en el B. Para ver quién quedó en cada uno: `npm run piloto:bloque -- --url=$B --email=<docente> '--password=<clave>' --lista` | Cohorte de E1 y de E2; la semilla (`Semilla de la asignacion:`) | E1 o E2 no aparecen: no son estudiantes de D («Administracion de usuarios») |
| P5.2 | «Iniciar bloque 1». E1 y E2 seleccionan código en VS Code y piden ayuda en el overlay | Estado: «En curso: bloque 1 (A con tutor, B sin tutor).». El del grupo B ve «En este bloque del piloto trabajas sin el tutor. Sigue con tu ejercicio como lo harias en clase; el tutor vuelve en el siguiente bloque.» sin llamar al modelo. El del grupo A recibe su sugerencia. Monitor: `bloque 1` y `activos 5 min 2 (con tutor 1, sin tutor 1)` | Hora del cambio; capturas | El del grupo B recibe ayuda: VS Code sin sesión (sus eventos no tienen condición) |
| P5.3 | «Iniciar bloque 2» y repetir | «En curso: bloque 2 (A sin tutor, B con tutor).» y los papeles al revés | Hora | Ídem |
| P5.4 | «Terminar piloto» | «Sin piloto activo: el tutor funciona para todos.». Monitor: `bloque 0` | Hora | `npm run piloto:bloque -- --url=$B --email=<docente> '--password=<clave>' --bloque=0` |

## P6. Simulacro de contingencia

Casos 8, 1 y 2 del [plan de contingencia](../operacion/contingencia.md) (sección 9); el
caso 9 es P5. Anota los tiempos también en la tabla de esa sección.

Para cronometrar, en una tercera ventana de PowerShell (con `$B` definida):
`npm run piloto:simulacro -- --backend $B --escenario editor` para P6.1 y P6.2, y
`--escenario gpu` para P6.3 y P6.4. No apaga ni enciende nada: muestra cada paso,
sondea `/api/health` y mide los tiempos cuando pulsas Enter (contingencia, sección 9).
Si no lo usas, los tiempos se anotan a mano.

| # | Acción | Resultado esperado | Anota | Si falla |
|---|---|---|---|---|
| P6.1 | Caso 8. Cloud Shell: `gcloud compute ssh adaceen-ws --zone=us-central1-a --tunnel-through-iap --command='sudo systemctl stop adaceen-workspaces-agent'`. Al minuto, E1 pulsa «Abrir mi editor» | En 60 s o menos, `/api/health` da `workspace_agent_online: false` y el monitor da `ALERTA: la VM de editores no esta conectada al relay…`. La ventana de E1 dice «El editor esta apagado; avisa al docente» («El editor esta apagado. Avisa al docente; esta ventana seguira esperando.») y **no** corta la espera | Segundos hasta la alerta | — |
| P6.2 | Mismo comando con `start` en vez de `stop` | En uno o dos minutos como mucho, `workspace_agent_online: true`, y la ventana de E1 abre el editor **sola** | Segundos hasta el editor | Si la ventana se rindió (espera máxima de 12 min), «Abrir mi editor» otra vez; anotar |
| P6.3 | Caso 1. Antes, `model_workers_alive` debe ser `1` (P0.2): si hay más servidores vivos (otra GPU o una Mac del laboratorio con su worker), apágalos también, porque mientras uno mande latido el monitor sigue en `worker ok`. Luego `gcloud compute instances stop <GPU encendida> --zone=<zona>` | En 2 minutos o menos el monitor dice `worker CAIDO`, VS Code «GPU: sin worker activo» y el tutor responde degradado en segundos | Minutos hasta `worker CAIDO` | Sigue en `worker ok` y `servidores` mayor que 0: queda otro servidor vivo; ver la columna Acción |
| P6.4 | Caso 2. `bash deploy/clase.sh iniciar` | `worker ok` en el monitor y sugerencias normales otra vez | Minutos hasta `worker ok` | [Runbook](../operacion/runbook.md), sección 5 |

## P7. Los eventos no quedan anónimos

| # | Acción | Resultado esperado | Anota | Si falla |
|---|---|---|---|---|
| P7.1 | Durante toda la prueba: mirar el monitor de P0.4 (ventana 2) | Ninguna `ALERTA: … sesiones de cliente sin usuario…` antes de P3.1 | Hora de la primera alerta, si la hubo | Anotar el paso: esos eventos se pierden para el análisis (regla D2) |
| P7.2 | Al terminar, ventana 1: `npm run piloto:monitor -- --url=$B --email=<docente> '--password=<clave>' "--desde=$RECONEXION" --una-vez --registro=exportes/monitor-p7.jsonl` | `anonymousClientSessions` igual a 0 en la última línea de `exportes/monitor-p7.jsonl`, y ninguna alerta de sesiones sin usuario. No mires el registro de P0.4: cuenta desde `$INICIO` y sí incluye el hueco esperado entre P3.1 y P3.2 | Valor | `[error] Fecha invalida:` sin fecha: `$RECONEXION` vacía; defínela en la ventana 1 con la hora de P3.2 en el mismo formato que `$INICIO`. Con un valor mayor que 0: ídem P7.1 |
| P7.3 | Ventana 1: `npm run piloto:verificar -- --url=$B --email=<docente> '--password=<clave>' --salida=docs/evidencias/verificacion-cumplimiento-<fecha>.md` | `Automaticos: … cumplen` y código de salida 0: ningún ítem crítico automático falla (revisa, entre otros, la sal, el latido, PostgreSQL, HTTPS y que las cuentas demo no entren) | Resultado | El ítem que falla dice qué configurar |
| P7.4 | (Opcional, ventana 1) `npm run telemetria:exportar -- --url=$B --email=<docente> '--password=<clave>' "--desde=$INICIO" --formato=csv --salida=exportes/prueba-inicio-a-fin.csv` y `npm run piloto:dataset -- --entrada=exportes/prueba-inicio-a-fin.csv --salida=exportes/prueba-inicio-a-fin-dataset` | En `limpieza.md`, la regla `D2_cliente_anonimo` solo cuenta eventos entre P3.1 y P3.2 | Números por regla | — |

## P8. Cierre

| # | Acción | Resultado esperado | Anota | Si falla |
|---|---|---|---|---|
| P8.1 | Cortar el monitor (Ctrl+C) y `bash deploy/clase.sh terminar` | `apagada` por cada VM | Hora de fin | `bash deploy/clase.sh estado` a los pocos minutos |
| P8.2 | Llenar [evidencias de despliegue](../operacion/evidencias-despliegue.md) (sección 4 y capturas 6, 7, 13, 15 a 18) y pasar a [pendientes](pendientes.md) lo que falló | — | — | — |

Un fallo en P1, P2 o P3 bloquea el piloto: se corrige y se repite la prueba. Un fallo
en P4 solo afecta a las Mac. Un fallo en P6 se anota en la contingencia.
