# Sistema de diseno de ADACEEN

Este directorio es la fuente de verdad de los tokens de diseno del producto.
El sistema completo —paleta en dos temas, escala tipografica, espaciado, radios
y nueve componentes con vista previa en vivo— vive en:

https://claude.ai/artifact/GcmmoeFVbHZFa4hH5thAQa

`tokens.css` esta **generado** desde ese sistema. No lo edites a mano: cambia el
token en el sistema y vuelve a generarlo.

## De donde salieron los valores

Los valores del tema claro son exactamente los que hoy estan en produccion, leidos de:

- `browser-ext-prod/overlay/content-styles.js`
- `browser-ext-prod/popup/popup.css`

Los nombres tambien son los que ya usa ese CSS (`--adaceen-ink`, `--adaceen-primary`,
`--adaceen-radius`...). Por eso incluir este archivo no cambia ningun valor existente:
solo anade los que faltaban.

Lo que se anade encima y hoy no existe en el codigo:

- el tema oscuro completo, con todos los pares de texto verificados a 4.5:1 o mas;
- la escala de espaciado de paso 2px y la de radios;
- los siete estilos de texto que absorben los 21 tamanos sueltos del overlay;
- las paradas de los degradados de la cabecera y del boton primario, que estaban
  como literales;
- los 15 tokens del popup, con sus valores exactos, a la espera de la decision de
  unificar o no las dos paletas.

## Como se consume

El archivo declara cada bloque con dos enganches, `:root` y `:host`, para que sirva
igual en un documento normal (el popup) y dentro del shadow DOM del overlay.

El tema oscuro se activa solo con `prefers-color-scheme`, y se puede forzar con
`data-theme="light"` o `data-theme="dark"` en el elemento raiz o en el host.

## Estado de la migracion

Los cinco pasos que traza la seccion "Migracion" del sistema, cada uno reversible
por separado:

| Paso | Que hace | Estado |
| --- | --- | --- |
| 1 | Los tokens dentro del overlay | hecho |
| 2 | Literales por tokens | hecho |
| 3 | Tema oscuro | hecho |
| 4 | Escala tipografica | pendiente |
| 5 | La paleta del popup | pendiente, decision de producto |

Los pasos 1 a 3 estan aplicados en `browser-ext-prod/overlay/content-styles.js`.
El contenido de `tokens.css` esta pegado al principio de la plantilla de estilos
del overlay, porque la extension no tiene build: el navegador carga el JS tal
cual. Si cambias un token aqui, vuelve a pegarlo alli.

De los 170 literales de color que tenia el overlay quedan 14, a proposito:

- el azul y el cuadro blanco del logotipo de Google, que es marca ajena;
- `pre` y `.sync-snippet`, bloques de codigo ya oscuros en los dos temas;
- el indigo de `.role-pill` y los tonos de insertar y reemplazar de la paleta
  en linea, que no tienen equivalente en la paleta y reciben su propio bloque
  oscuro al final de la hoja.

El paso 4 no se hizo por lo que dice el propio plan: es el que mas diffs genera
y conviene hacerlo al tocar cada archivo por otra razon, no como barrido. Las
siete clases de texto (`.adaceen-title`, `.adaceen-body`...) ya estan declaradas
en la hoja y todavia no las usa nadie: son el punto de entrada de ese paso.

El paso 5 sigue esperando la decision entre unificar las dos paletas, mantener
la division o retemplar el popup. `popup.css` no se toco.

## Regenerarlo

El sistema publica su propio `tokens.css` compilado desde `tokens.json`. Pidele a
Claude Code que lo regenere cuando cambies un token, o descargalo desde la pagina
del sistema.
