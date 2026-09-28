# Capturas del overlay 0.7.16: pestaña «Bitácora»

Extensión real (`browser-ext-prod`, 0.7.16) cargada en Chromium 141 con Playwright y un
backend simulado con las mismas respuestas del contrato (datos de muestra, ninguna cuenta
real). Ventana de 1600 × 900, salvo la `09` (600 × 900). En cada captura se midió el cuerpo
del overlay: donde no se dice otra cosa, `scrollHeight` = `clientHeight` (cabe sin
desplazamiento). Las capturas de la 0.7.15 (`overlay-0.7.15/`) siguen valiendo para lo que
no cambió (RAG, Usuarios, Quices y Configuración).

| Archivo | Rol y pestaña | Qué muestra |
|---|---|---|
| `01-docente-inicio-sin-bitacora.png` | Docente · Inicio (repositorio en GitHub) | La barra con «Bitácora» y el punto naranja; la acción recomendada «Sube la bitácora del curso» con «Subir bitácora»; la línea «Bitácora del curso» con «Falta» y «Abrir». El cuerpo desplaza 56 px (el final del resumen de sesión) |
| `02-docente-bitacora-sin-cargar.png` | Docente · Bitácora | Sin bitácora: «Falta» y «Actualizar», la zona punteada con «Subir bitácora (Excel/PDF)», «Descargar plantilla», los dos «Exportar» desactivados y los plegables «Semanas cargadas», «Registro manual» y «Borrar datos» |
| `03-docente-bitacora-arrastrando.png` | Docente · Bitácora | Arrastrando un Excel sobre la pestaña: la zona se resalta |
| `04-docente-bitacora-cargada.png` | Docente · Bitácora | Tras soltar el Excel: «Cargada», el archivo, 8 semanas y «actualizada ahora mismo»; exportar habilitado; el estado dice «Bitácora subida: 8 registro(s) detectado(s).» |
| `05-docente-bitacora-semanas.png` | Docente · Bitácora | «Semanas cargadas» desplegado: una tarjeta por semana con fecha, tema y etiqueta de color por tipo (la lista desplaza dentro, hasta 260 px; el cuerpo desplaza al desplegar) |
| `06-docente-bitacora-registro-manual.png` | Docente · Bitácora | «Registro manual» desplegado (el cuerpo desplaza al desplegar) |
| `07-docente-inicio-con-bitacora.png` | Docente · Inicio | La línea con «Cargada» y el resumen de la bitácora; la acción recomendada vuelve a «Panel docente». Tras subir una bitácora Inicio muestra también «Politica docente», como en la 0.7.15, y el cuerpo desplaza |
| `08-docente-campus-bitacora-requerida.png` | Docente · Inicio en un curso de Campus | «Bitacora requerida» con «Subir bitácora»; la misma verificación del curso dio el estado de la línea (una sola consulta). El cuerpo desplaza 40 px |
| `09-docente-ventana-angosta.png` | Docente · Inicio, ventana de 600 px | Las siete pestañas caben en la barra (si no cupieran, se desplaza) y la línea de la bitácora se recorta con «…» |

La `03` y la subida de la `04` se hicieron con eventos de arrastre reales del navegador
(`DragEvent` con un `DataTransfer` que lleva el archivo) sobre la pestaña; la subida pasó por
`POST /api/documents/bitacora/import` del backend simulado.

Cómo se generaron: arnés local de Playwright que copia la extensión con el shadow root
abierto para poder mirar dentro, sin cambiar el código, siembra la sesión de un docente en
`chrome.storage.local` y abre el overlay con el mismo mensaje que manda el icono. Para
repetirlas basta cargar `dist/extension/adaceen-chromium-0.7.16.zip` en Chrome con una
cuenta de docente.
