# Capturas del overlay 0.7.13: pestañas y panel «Estudiantes»

Extensión real (`browser-ext-prod`, 0.7.13) cargada en Chromium con Playwright y un
backend simulado con las mismas respuestas que `GET /api/admin/students` y
`GET /api/admin/students/:userId` (datos de muestra, ninguna cuenta real). Ventana de
1600 × 900; en todas las capturas el cuerpo del overlay cabe sin desplazamiento
(`scrollHeight` = `clientHeight`, medido en cada captura).

| Archivo | Rol y pestaña | Qué muestra |
|---|---|---|
| `01-admin-inicio.png` | Administrador · Inicio | Contexto, acción recomendada y resumen de sesión; barra de pestañas Inicio · Estudiantes · Usuarios |
| `02-admin-estudiantes.png` | Administrador · Estudiantes | Cinco indicadores del grupo y tabla con sesiones, última actividad, intervenciones, quices y nota |
| `03-admin-estudiante-detalle.png` | Administrador · Estudiantes (detalle) | Indicadores del estudiante, línea de tiempo de 14 días, quices y calificaciones, sesiones, intervenciones y actividad |
| `04-admin-estudiantes-busqueda.png` | Administrador · Estudiantes | Búsqueda local por nombre o correo |
| `05-admin-usuarios.png` | Administrador · Usuarios | Administración de usuarios (el formulario «Agregar usuario» aparece al pulsar el botón) |
| `06-docente-inicio.png` | Docente · Inicio | Barra Inicio · Tutor · Estudiantes · Usuarios y política aplicada |
| `07-docente-estudiantes.png` | Docente · Estudiantes | Solo sus estudiantes, con los mismos indicadores |
| `09-estudiante-inicio.png` | Estudiante · Inicio | Barra Inicio · Tutor |
| `10-estudiante-tutor-bloqueado.png` | Estudiante · Tutor (Campus sin curso) | Aviso de cómo se activa el tutor en vez de una pestaña vacía |
| `11-estudiante-tutor-vscode.png` | Estudiante · Tutor (`vscode.dev` por túnel) | Metas en una fila, pistas, siguiente paso y valoración |

Cómo se generaron: `scripts` no las regenera; se hicieron con un arnés local de
Playwright que copia la extensión con el shadow root abierto para poder mirar
dentro, sin cambiar el código. Para repetirlas basta cargar `dist/extension/
adaceen-chromium-0.7.13.zip` en Chrome con una cuenta de docente o administrador.
