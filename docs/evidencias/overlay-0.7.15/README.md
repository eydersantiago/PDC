# Capturas del overlay 0.7.15: lotes de RAG, Quices, ayuda de los RA y exportar bitácora

Extensión real (`browser-ext-prod`, 0.7.15) cargada en Chromium con Playwright y un
backend simulado con las mismas respuestas del contrato (datos de muestra, ninguna
cuenta real). Ventana de 1600 × 900. En cada captura se midió el cuerpo del overlay:
salvo donde se indica, `scrollHeight` = `clientHeight` (cabe sin desplazamiento). Las
capturas de la 0.7.14 (`overlay-0.7.14/`) siguen valiendo para lo que no cambió
(Estudiantes, Tutor, estudiante).

| Archivo | Rol y pestaña | Qué muestra |
|---|---|---|
| `01-docente-inicio.png` | Docente · Inicio | Barra Inicio · Tutor · Estudiantes · RAG · Quices · Usuarios |
| `02-docente-rag-lotes.png` | Docente · RAG | FPOO con «Lote activo», «Cargar en», «Nuevo lote», el grupo «Base del curso» (una fuente apagada, tachada, con «Activar») y, más abajo, los lotes (la lista de cursos desplaza dentro de la pestaña) |
| `03-docente-rag-nuevo-lote.png` | Docente · RAG | Formulario «Nuevo lote» (nombre, descripción, «Incluye la base del curso») y el lote activo con «Cargar fuente aqui» y «Retirar lote» |
| `04-docente-usuarios-rag-aplicado.png` | Docente · Usuarios | Columna «RAG aplicado» (sin la columna «Profesor», que como docente sobra) |
| `05-docente-usuarios-editar-lote.png` | Docente · Usuarios | Fila en edición con «Lote de RAG aplicado (se guarda al cambiar)» por curso (la tabla desplaza dentro de la pestaña) |
| `06-docente-quices.png` | Docente · Quices | «Lanzar un quiz a la clase», «Crear quiz», «Mis quices» (uno lanzado ahora) y «Quices hechos» con nombre, tema, origen, resultado y fecha |
| `07-docente-configuracion-ra.png` | Docente · Configuración | «Resultado de aprendizaje» RA1 a RA5 con la ayuda «?» abierta (peso de cada RA y su reparto); sin la sección del piloto |
| `08-docente-bitacora-exportar.png` | Docente · Bitácora | «Exportar bitacora (Excel)» y «Exportar bitacora (CSV)» bajo el estado de la bitácora cargada |
| `09-pagina-docente-quices.png` | Docente · página `/docente/quices` | Backend real en memoria: formulario para escribir o generar, «Mis quices» con «Lanzar a la clase», «Editar» y «Retirar», y abajo los quices hechos |
| `10-pagina-docente-quices-sin-sesion.png` | Docente · página `/docente/quices` | Sin la extensión (o sin sesión): la página pide correo y contraseña |

Las capturas `09` y `10` son de la página servida por el backend (1280 × 900 y 1280 × 600),
no del overlay.

Cómo se generaron: arnés local de Playwright que copia la extensión con el shadow root
abierto para poder mirar dentro, sin cambiar el código; para la página, el backend real con
la base en memoria (pg-mem) y el modelo simulado. Para repetirlas basta cargar
`dist/extension/adaceen-chromium-0.7.15.zip` en Chrome con una cuenta de docente.
