# Entregas automáticas en Google Drive (por código del análisis)

| | |
|---|---|
| Desde | 02-11-2026 |
| Qué | Cada hora (si cambió), la carpeta del taller de cada estudiante llega como `.zip` a una carpeta de Google Drive y a una hoja de cálculo, identificada **solo por su código del análisis** |
| Dónde | Drive de `eysansuc@gmail.com` (la cuenta a la que se le da lectura); el docente la ve como Lector |
| Relacionados | [Runbook: respaldos](runbook.md#horario-del-tutor-y-respaldos) y [avance del taller](runbook.md#avance-del-taller), [Excel y Power BI](../analitica/excel-power-bi.md), [consentimiento](../piloto/consentimiento.md), [contrato de la API](../arquitectura/contrato-api.md) |

## Cómo funciona

1. **El avance** (`deploy/gcp/workspaces/avance-ws.py`, cada 10 min en la VM de editores) avisa
   al backend como siempre (`POST /api/workspaces/progress-report`). El backend responde, además,
   el código del análisis de cada login de GitHub que tiene la carpeta del taller
   (`analysisCodes`): el mismo seudónimo de 20 caracteres de la telemetría, de Excel y de Power
   BI. No van las cuentas de muestra, los logins sin cuenta ni los que están en dos cuentas a la
   vez. El avance deja esa lista en `/var/lib/adaceen-avance/para-entregas.json` (solo root,
   `0600`), por taller y estudiante: el código, **la carpeta que evaluó** (`entrada`), el
   porcentaje, si compila, cuándo lo midió y, si es un resultado reusado, por qué (`nota`). Si el
   informe de un taller no llega al backend, o el backend no pudo leer las cuentas
   (`analysisCodes: null`), ese taller conserva lo anterior mientras tenga menos de 2 horas.
   Esta lista nunca sale de la VM.
2. **La copia de respaldo** (`deploy/gcp/workspaces/respaldo-ws.py`, cada 15 min y al apagar
   la VM), después de la copia de siempre, arma por cada estudiante de esa lista un `.zip` de
   la carpeta del taller y lo sube al mismo bucket de los respaldos:

   ```text
   gs://<bucket>/entregas/<taller>/<código del análisis>/<aaaa-mm-dd>_<hhmm>.zip
   gs://<bucket>/entregas/<taller>/<código del análisis>/<aaaa-mm-dd>_<hhmm>.json   (manifiesto)
   ```

   - La carpeta es **exactamente la que evaluó el avance** (`sistema-bancario-fpoo` o la más
     reciente de `sistema-bancario-fpoo-<algo>`: un segundo clon o la copia de GitHub Classroom).
     Solo el avance elige; si esa carpeta ya no está (o ahora es un enlace), no hay entrega de ese
     estudiante hasta la siguiente vuelta del avance.
   - Dentro del `.zip` todo va bajo `sistema-bancario-fpoo/` (el nombre del taller, aunque la
     carpeta real se llame de otra forma). Sin `.git`, `build`, `node_modules`, binarios, archivos
     ocultos (`.vscode`, `.env`...), enlaces simbólicos ni archivos de más de 20 MB; a lo sumo
     45 MB por entrega. Un enlace hacia la carpeta de otro estudiante no se sigue.
   - El manifiesto dice `{ version, taller, titulo, codigo, fecha, sha256, bytes, archivos, avance,
     compila, avanceMedidoEn, avanceAlDia }`. `avanceMedidoEn` es cuándo se calculó ese avance y
     `avanceAlDia` es `false` si era un resultado reusado (el cálculo no alcanzó o falló): el avance
     puede no ser el del código del zip. Ni el `.zip` ni el manifiesto llevan login, nombre ni la
     ruta del home.
   - Se sube solo si algo cambió en la carpeta y pasaron 60 min desde la anterior de ese
     estudiante (`ENTREGA_CADA_MIN`, fijo). Al apagar la VM (fin de la clase) no espera los 60 min.
   - Si una entrega falla, la copia de respaldo vale igual y la entrega se reintenta en la
     siguiente corrida.
3. **El Apps Script** (`deploy/drive/entregas-drive.gs`), en la hoja «Entregas ADACEEN · índice»
   del Drive de `eysansuc@gmail.com`, revisa el bucket cada 30 min. Por cada manifiesto nuevo
   lo valida, baja el `.zip`, comprueba su SHA-256 y lo guarda en
   `<carpeta de entregas>/<título del taller> (<taller>)/<código del análisis>/` (el nombre corto
   del taller va entre paréntesis: dos talleres con el mismo título no se mezclan) con el nombre
   `<aaaa-mm-dd hhmm> · <avance> % · <primeros 12 del SHA-256>.zip`. Anota cada entrega en la hoja:

   | Hoja | Qué tiene |
   |---|---|
   | «Índice» | Una fila por entrega: fecha, código del análisis, taller (título e id), avance, cuándo se midió el avance («Avance medido»), si compila, archivos, SHA-256, enlace al zip y a la carpeta, y el objeto del bucket. Un avance reusado sale como «42 % (sin medir de nuevo)» |
   | «Último por estudiante» | Una fila por código e id del taller, con la entrega más reciente (con las mismas columnas de avance) |
   | «Problemas» | Lo que no se pudo pasar y por qué (manifiesto inválido, SHA-256 distinto, falta el zip). No se reintenta |

## Por qué solo el código del análisis

El consentimiento del piloto ([consentimiento](../piloto/consentimiento.md)) dice que el nombre
y el correo no hacen parte de lo que se analiza y que la lista nombre ↔ cuenta no se exporta.
El docente revisa las entregas como revisa Excel y Power BI: por código. Cuando necesita saber
de quién es una, usa «¿Quién es este código?» en el monitor del docente (`/docente/monitor`): de
a un código, registrada y con tope por hora. La lista login ↔ código solo la tienen el backend y
la VM; ni el bucket, ni Drive, ni la hoja la llevan.

Para esto, desde el 02-11-2026 **el token del agente recibe la tabla login ↔ código** de los
estudiantes que tienen la carpeta del taller (la respuesta de `POST
/api/workspaces/progress-report`). En la VM queda solo en el archivo de root
`/var/lib/adaceen-avance/para-entregas.json` (`0600`, en una carpeta `0700`), no se exporta ni
se copia al bucket, y el backend solo anota cuántos códigos entregó, nunca cuáles. Quien tenga el
token del agente o root en la VM ya podía ver los logins y el trabajo de todos; ahora además
puede unir cada login con su código.

`deploy/gcp/recoger-entregas.sh` **no cambia**: sigue sacando, para el administrador y a mano,
un `.zip` con el login, el nombre y el correo de cada estudiante (`entregas/LISTA.csv`), en su
Cloud Shell. Es para el administrador, no se comparte con el docente.

**Cuidado:** el código del estudiante puede llevar su nombre (un comentario `// Hecho por ...`, un
`cout` de bienvenida). El script no lee ni cambia el código; si eso importa, se le pide al grupo
que no firme los archivos.

## Ponerlo en marcha (una vez)

Necesita el backend y la VM con esta rama: el backend desplegado (responde `analysisCodes`) y la VM
de editores con el arranque al día (`bash deploy/gcp/respaldos.sh activar` o
`bash deploy/gcp/avance-taller.sh activar`, y reiniciarla cuando no haya nadie).

1. **Dar lectura de las entregas** (Cloud Shell, con la cuenta dueña del proyecto):

   ```bash
   cd ~/PDC && git pull
   bash deploy/gcp/respaldos.sh compartir eysansuc@gmail.com
   ```

   Da `roles/storage.objectViewer` en el bucket a esa cuenta, con una condición de IAM que deja
   leer y listar **solo** `entregas/` (las copias de `respaldos/` llevan el login y no se
   comparten). `bash deploy/gcp/respaldos.sh estado` muestra el nombre del bucket y quién lee las
   entregas.

   **Si la condición no funciona.** La condición usa `storage.googleapis.com/objectListPrefix`,
   que Google documenta para los límites de acceso de credenciales; no está probada en la
   política de un bucket. Si `compartir` falla, o si `instalar` (paso 5) dice «Esta cuenta no
   puede leer gs://...» aunque ya se compartió, queda la alternativa:

   ```bash
   bash deploy/gcp/respaldos.sh dejar-de-compartir eysansuc@gmail.com
   bash deploy/gcp/respaldos.sh compartir eysansuc@gmail.com --todo-el-bucket
   ```

   Da lectura de **todo** el bucket, también de `respaldos/<login>/`, que lleva el login de cada
   estudiante (lo avisa al correr). Solo es aceptable si esa cuenta es la del propio
   administrador, que ya ve los respaldos; **nunca** para la cuenta del docente. El docente sigue
   viendo solo Drive y la hoja, con códigos.
2. **La hoja y la carpeta**, en el Drive de `eysansuc@gmail.com`: una hoja de cálculo nueva
   llamada «Entregas ADACEEN · índice» y una carpeta para los zip (por ejemplo «Entregas
   ADACEEN»). De la carpeta se copia el id: lo que sigue a `/folders/` en su enlace.
3. **El script**: en la hoja, Extensiones → Apps Script. Se pega `deploy/drive/entregas-drive.gs`
   en `Código.gs`. En Configuración del proyecto se marca «Mostrar el archivo de manifiesto
   "appsscript.json" en el editor» y se reemplaza su contenido por `deploy/drive/appsscript.json`.
4. **Las propiedades del script** (Configuración del proyecto → Propiedades del script):

   | Propiedad | Valor |
   |---|---|
   | `BUCKET` | el bucket, sin `gs://` (lo dice `respaldos.sh estado`; por defecto `<proyecto>-adaceen-respaldos`) |
   | `CARPETA_ID` | el id de la carpeta del paso 2 |
   | `HOJA_ID` | vacía (solo si el script se creó suelto, fuera de la hoja) |

5. **Instalar**: en el editor se elige la función `instalar` y se pulsa Ejecutar. Google pide
   autorizar los permisos (Drive, hojas de cálculo, conectarse a un servicio externo,
   disparadores y leer Cloud Storage). `instalar` revisa las propiedades, hace un listado de
   prueba de `entregas/` (sin permiso se detiene y dice qué correr, con la alternativa
   `--todo-el-bucket`), prueba la carpeta, deja **un** disparador cada 30 min y corre la primera
   vez. En la hoja aparece el menú «Entregas ADACEEN» → «Sincronizar ahora». El prefijo
   `entregas/` es fijo: el mismo en `respaldo-ws.py`, `respaldos.sh` y el script.
6. **Compartir con el docente**: la carpeta de las entregas y la hoja, como **Lector**. El
   docente no necesita acceso a Google Cloud.

## Verificar

- En la VM (o con `bash deploy/gcp/respaldos.sh ahora`), el resumen de la copia dice cuántas
  entregas subió: `respaldo ...: ...; 3 entregas, 0 fallidas`. Si dice `sin entregas: todavia no
  hay para-entregas.json` o `tiene mas de 2 horas`, el avance del taller no está corriendo o el
  backend no tiene esta rama. `entregas apagadas (metadata entregas=off)`: ver abajo.
- `gcloud storage ls "gs://<bucket>/entregas/**"` lista los zip y manifiestos (solo con códigos).
- En Apps Script, Ejecuciones muestra cada corrida con «Entregas: N nuevas, ...». La hoja
  «Problemas» dice lo que no pasó. Un error «Esta cuenta no puede leer gs://...» es que falta el
  paso 1, que `BUCKET` no es el del bucket o que la condición no funcionó (la alternativa del
  paso 1).
- Si Cloud Storage responde que su API no está habilitada en el proyecto del script («... has not
  been used in project ...»), el script usa el proyecto de Google Cloud que Apps Script crea solo.
  En Configuración del proyecto → Proyecto de Google Cloud se cambia al número del proyecto de
  ADACEEN (`gcloud projects describe adaceen-508504 --format='value(projectNumber)'`) y se vuelve
  a correr `instalar`.

## Cambiar o apagar

| Quiero… | Cómo |
|---|---|
| Que deje de traer entregas a Drive | En Apps Script, ejecutar `desinstalar` (quita el disparador; lo que está en Drive queda) |
| Quitarle a la cuenta la lectura del bucket | `bash deploy/gcp/respaldos.sh dejar-de-compartir eysansuc@gmail.com` |
| Que la VM no arme entregas | `gcloud compute instances add-metadata adaceen-ws --metadata=entregas=off` (en Cloud Shell, con `--zone` de la VM) y reiniciar la VM cuando no haya nadie: el arranque escribe `ENTREGAS=off` en `/etc/adaceen-respaldo.env` y la copia de respaldo sigue. `respaldos.sh estado` lo muestra |
| Volver a encenderlas | `gcloud compute instances remove-metadata adaceen-ws --keys=entregas` y reiniciar la VM |

El intervalo (60 min) y el prefijo (`entregas/`) son fijos: se cambian en el código
(`ENTREGA_CADA_MIN` y `ENTREGAS_PREFIJO` de `respaldo-ws.py`, con el mismo prefijo en
`respaldos.sh` y `ENTREGAS_PREFIJO` del Apps Script), no en la VM: el arranque reescribe
`/etc/adaceen-respaldo.env` en cada encendido. Las entregas del bucket se borran solas con la
retención de los respaldos (30 días, `respaldos.sh activar`); las de Drive quedan hasta que
alguien las borre.
