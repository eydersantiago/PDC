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

**Todavia no esta enganchado a ninguna superficie.** Este es el paso 1 de la
migracion: el archivo existe y no cambia nada en pantalla. La seccion "Migracion"
del sistema traza los cinco pasos, cada uno reversible por separado, y explica por
que no conviene reescribir `content-styles.js` de una sola vez.

## Regenerarlo

El sistema publica su propio `tokens.css` compilado desde `tokens.json`. Pidele a
Claude Code que lo regenere cuando cambies un token, o descargalo desde la pagina
del sistema.
