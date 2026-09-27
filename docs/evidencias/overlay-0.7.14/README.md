# Capturas del overlay 0.7.14: pestañas, Estudiantes, Usuarios, RAG y tuerca

Extensión real (`browser-ext-prod`, 0.7.14) cargada en Chromium con Playwright y un
backend simulado con las mismas respuestas del contrato (datos de muestra, ninguna
cuenta real). Ventana de 1600 × 900. En cada captura se midió el cuerpo del overlay:
salvo donde se indica, `scrollHeight` = `clientHeight` (cabe sin desplazamiento).
Reemplaza a `overlay-pestanas-0.7.13/`.

| Archivo | Rol y pestaña | Qué muestra |
|---|---|---|
| `01-admin-inicio.png` | Administrador · Inicio | Contexto, acción recomendada y resumen; barra Inicio · Estudiantes · Usuarios |
| `02-admin-estudiantes.png` | Administrador · Estudiantes | Indicadores del grupo y tabla con sesiones, actividad, intervenciones, quices y nota |
| `03-admin-estudiante-detalle.png` | Administrador · Estudiantes (detalle) | Indicadores, línea de tiempo, quices y calificaciones, sesiones, intervenciones y actividad |
| `04-admin-estudiantes-busqueda.png` | Administrador · Estudiantes | Búsqueda local |
| `05-admin-usuarios.png` | Administrador · Usuarios | Filas legibles (nombre y correo completos, etiquetas) |
| `06-docente-inicio.png` | Docente · Inicio | Barra Inicio · Tutor · Estudiantes · RAG · Usuarios |
| `07-docente-estudiantes.png` | Docente · Estudiantes | Solo sus estudiantes |
| `12-docente-usuarios.png` | Docente · Usuarios | Filas legibles con «Editar» y «Eliminar» |
| `13-docente-usuarios-editar.png` | Docente · Usuarios | Fila en edición: campos a todo el ancho con «Guardar» y «Cancelar» (la tabla desplaza dentro de la pestaña) |
| `14-docente-rag.png` | Docente · RAG | Cursos plegables con fuentes base y propias, «Cargar fuente», «Material base», «Ver» y «Retirar» |
| `15-docente-configuracion.png` | Docente · Configuración | Secciones plegables, «Politica del tutor» abierta y «Guardar cambios» fijo |
| `09-estudiante-inicio.png` | Estudiante · Inicio | Barra Inicio · Tutor |
| `10-estudiante-tutor-bloqueado.png` | Estudiante · Tutor (Campus sin curso) | Aviso de cómo se activa el tutor |
| `11-estudiante-tutor-vscode.png` | Estudiante · Tutor (`vscode.dev`) | Metas en una fila, «Fuentes RAG usadas» plegada con el conteo, pistas, pasos, valoración y la línea de estado separada |
| `16-estudiante-fuentes-rag.png` | Estudiante · Tutor | «Fuentes RAG usadas» desplegada: una línea por fuente agrupada por curso, «+» y «Abrir» (con la lista abierta sí hay desplazamiento) |
| `17-estudiante-configuracion.png` | Estudiante · Configuración | «Sesion y tutor» abierta y el resto plegado |

En las capturas del editor (`11`, `16`, `17`) se ocultó el panel flotante «Contexto de
trabajo» de VS Code, que en la ventana de prueba tapaba la barra de pestañas.

Cómo se generaron: arnés local de Playwright que copia la extensión con el shadow root
abierto para poder mirar dentro, sin cambiar el código. Para repetirlas basta cargar
`dist/extension/adaceen-chromium-0.7.14.zip` en Chrome con una cuenta de docente o
administrador.
