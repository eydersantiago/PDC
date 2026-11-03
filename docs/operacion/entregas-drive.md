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
   el código del análisis de cada login de GitHub que conoce (`pseudonyms`): el mismo seudónimo
   de 20 caracteres de la telemetría, de Excel y de Power BI. No van las cuentas de muestra, los
   logins sin cuenta ni los que están en dos cuentas a la vez. El avance deja esa lista en
   `/var/lib/adaceen-avance/para-entregas.json` (solo root, `0600`), con el porcentaje y si
   compila. Esta lista nunca sale de la VM.
2. **La copia de respaldo** (`deploy/gcp/workspaces/respaldo-ws.py`, cada 15 min y al apagar
   la VM), después de la copia de siempre, arma por cada estudiante de esa lista un `.zip` de
   la carpeta del taller y lo sube al mismo bucket de los respaldos:

   ```text
   gs://<bucket>/entregas/<taller>/<código del análisis>/<aaaa-mm-dd>_<hhmm>.zip
   gs://<bucket>/entregas/<taller>/<código del análisis>/<aaaa-mm-dd>_<hhmm>.json   (manifiesto)
   ```

   - La carpeta es la del avance: `sistema-bancario-fpoo` o, si no, la más reciente de
     `sistema-bancario-fpoo-<algo>` (un segundo clon o la copia de GitHub Classroom).
   - Dentro del `.zip` todo va bajo `sistema-bancario-fpoo/` (el nombre del taller, aunque la
     carpeta real se llame de otra forma). Sin `.git`, `build`, `node_modules`, binarios, archivos
     ocultos (`.vscode`, `.env`...), enlaces simbólicos ni archivos de más de 20 MB; a lo sumo
     45 MB por entrega. Un enlace hacia la carpeta de otro estudiante no se sigue.
   - El manifiesto dice `{ version, taller, titulo, codigo, fecha, sha256, bytes, archivos, avance,
     compila }`. Ni el `.zip` ni el manifiesto llevan login, nombre ni la ruta del home.
   - Se sube solo si algo cambió en la carpeta y pasaron 60 min desde la anterior de ese
     estudiante (`ENTREGA_CADA_MIN`). Al apagar la VM (fin de la clase) no espera los 60 min.
   - Si una entrega falla, la copia de respaldo vale igual y la entrega se reintenta en la
     siguiente corrida.
3. **El Apps Script** (`deploy/drive/entregas-drive.gs`), en la hoja «Entregas ADACEEN · índice»
   del Drive de `eysansuc@gmail.com`, revisa el bucket cada 30 min. Por cada manifiesto nuevo
   lo valida, baja el `.zip`, comprueba su SHA-256 y lo guarda en
   `<carpeta de entregas>/<título del taller>/<código del análisis>/` con el nombre
   `<aaaa-mm-dd hhmm> · <avance> % · <primeros 12 del SHA-256>.zip`. Anota cada entrega en la hoja:

   | Hoja | Qué tiene |
   |---|---|
   | «Índice» | Una fila por entrega: fecha, código del análisis, taller, avance, si compila, archivos, SHA-256, enlace al zip y a la carpeta, y el objeto del bucket |
   | «Último por estudiante» | Una fila por código y taller, con la entrega más reciente |
   | «Problemas» | Lo que no se pudo pasar y por qué (manifiesto inválido, SHA-256 distinto, falta el zip). No se reintenta |

## Por qué solo el código del análisis

El consentimiento del piloto ([consentimiento](../piloto/consentimiento.md)) dice que el nombre
y el correo no hacen parte de lo que se analiza y que la lista nombre ↔ cuenta no se exporta.
El docente revisa las entregas como revisa Excel y Power BI: por código. Cuando necesita saber
de quién es una, usa «¿Quién es este código?» en el monitor del docente (`/docente/monitor`): de
a un código, registrada y con tope por hora. La lista login ↔ código solo la tienen el backend y
la VM; ni el bucket, ni Drive, ni la hoja la llevan.

`deploy/gcp/recoger-entregas.sh` **no cambia**: sigue sacando, para el administrador y a mano,
un `.zip` con el login, el nombre y el correo de cada estudiante (`entregas/LISTA.csv`), en su
Cloud Shell. Es para el administrador, no se comparte con el docente.

**Cuidado:** el código del estudiante puede llevar su nombre (un comentario `// Hecho por ...`, un
`cout` de bienvenida). El script no lee ni cambia el código; si eso importa, se le pide al grupo
que no firme los archivos.

## Ponerlo en marcha (una vez)

Necesita el backend y la VM con esta rama: el backend desplegado (responde `pseudonyms`) y la VM
de editores con el arranque al día (`bash deploy/gcp/respaldos.sh activar` o
`bash deploy/gcp/avance-taller.sh activar`, y reiniciarla cuando no haya nadie).

1. **Dar lectura de las entregas** (Cloud Shell, con la cuenta dueña del proyecto):

   ```bash
   cd ~/PDC && git pull
   bash deploy/gcp/respaldos.sh compartir eysansuc@gmail.com
   ```

   Da `roles/storage.objectViewer` en el bucket a esa cuenta, con una condición que deja leer y
   listar **solo** `entregas/` (las copias de `respaldos/` llevan el login y no se comparten).
   `bash deploy/gcp/respaldos.sh estado` muestra el nombre del bucket y quién lee las entregas.
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
   | `PREFIJO` | `entregas/` (se puede dejar vacía) |
   | `CARPETA_ID` | el id de la carpeta del paso 2 |
   | `HOJA_ID` | vacía (solo si el script se creó suelto, fuera de la hoja) |

5. **Instalar**: en el editor se elige la función `instalar` y se pulsa Ejecutar. Google pide
   autorizar los permisos (Drive, hojas de cálculo, conectarse a un servicio externo,
   disparadores y leer Cloud Storage). `instalar` revisa las propiedades, prueba que puede leer
   el bucket y la carpeta, deja **un** disparador cada 30 min y corre la primera vez. En la
   hoja aparece el menú «Entregas ADACEEN» → «Sincronizar ahora».
6. **Compartir con el docente**: la carpeta de las entregas y la hoja, como **Lector**. El
   docente no necesita acceso a Google Cloud.

## Verificar

- En la VM (o con `bash deploy/gcp/respaldos.sh ahora`), el resumen de la copia dice cuántas
  entregas subió: `respaldo ...: ...; 3 entregas, 0 fallidas`. Si dice `sin entregas: todavia no
  hay para-entregas.json` o `tiene mas de 2 horas`, el avance del taller no está corriendo o el
  backend no tiene esta rama.
- `gcloud storage ls "gs://<bucket>/entregas/**"` lista los zip y manifiestos (solo con códigos).
- En Apps Script, Ejecuciones muestra cada corrida con «Entregas: N nuevas, ...». La hoja
  «Problemas» dice lo que no pasó. Un error «Esta cuenta no puede leer gs://...» es que falta el
  paso 1 (o `BUCKET`/`PREFIJO` no son los del bucket).

## Cambiar o apagar

| Quiero… | Cómo |
|---|---|
| Que deje de traer entregas a Drive | En Apps Script, ejecutar `desinstalar` (quita el disparador; lo que está en Drive queda) |
| Quitarle a la cuenta la lectura del bucket | `bash deploy/gcp/respaldos.sh dejar-de-compartir eysansuc@gmail.com` |
| Que la VM no arme entregas | `ENTREGAS=off` en `/etc/adaceen-respaldo.env` de la VM (la copia de respaldo sigue) |
| Otro intervalo | `ENTREGA_CADA_MIN=<minutos>` en `/etc/adaceen-respaldo.env` (60 por defecto; `0`: cada cambio, como mucho cada 15 min) |

`/etc/adaceen-respaldo.env` lo reescribe el arranque de la VM: un cambio a mano dura hasta el
siguiente encendido. Las entregas del bucket se borran solas con la retención de los respaldos
(30 días, `respaldos.sh activar`); las de Drive quedan hasta que alguien las borre.
