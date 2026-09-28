# Simulación y capturas de la 0.7.17: agenda del curso y Google Calendar

Qué pidió Eyder: simular la bitácora real de FPOO («Bitacora FPOO - Hoja 1.pdf», del
semestre 2025) empezando el 25 de agosto de 2026, probarla como estudiante («estás en el
curso X, la semana X»), sincronizar con Google Calendar solo si entró con el correo de la
universidad y sin repetir los eventos que ya existen, y sugerir cuándo estudiar.

## Cómo se hizo

Simulación de punta a punta el lunes 28 de septiembre de 2026 a las 00:11 (hora de Bogotá,
último día de la semana 5), con el reloj real:

- **Backend real** (`src/`, `createApp` con PostgreSQL en memoria) en el mismo proceso, con
  los usuarios demo. El docente crea al estudiante `estudiante.prueba@correounivalle.edu.co`
  (curso FPOO) con `POST /api/admin/users`.
- **Extensión real** (`browser-ext-prod` 0.7.17) en Chromium 141 con Playwright. La copia de
  prueba solo cambia tres cosas: el shadow root abierto (para mirar dentro), el token de
  Google (`"token-simulado"` en vez de `chrome.identity`) y la dirección de la API de Google
  Calendar (un servidor local).
- **El PDF real**, arrastrado y soltado por el docente en la pestaña «Bitácora»
  (`tests/fixtures/bitacora-fpoo-2025.pdf`).
- **Simulado:** la API de Google Calendar (servidor local con la misma forma: lista con
  `privateExtendedProperty`, `timeMin` y `timeMax`, crear, `PATCH` y `userinfo`) y el modelo
  del tutor (`setTextModelOverrideForTests`: el prompt es el real del backend y la respuesta
  es un texto fijo armado con la línea `CourseWeek` que recibió). Nada toca cuentas ni datos
  reales.

El guion está en el arnés de capturas de la sesión (`sim-0717.mts`); las mismas situaciones
quedan como pruebas automáticas en `tests/scripts/browser-ext-flujo-tunel.test.ts`
(«0.7.17»).

## Resultado paso a paso

| Paso | Qué pasó |
|---|---|
| El docente suelta el PDF | `POST /api/documents/bitacora/import`: 23 filas (16 semanas, la sesión «OPCIONAL» y 6 evaluaciones o entregas). Fechas de 2025: «Inicio del semestre» trae el miércoles 20 de agosto de 2025 y el estado no marca semana (ese semestre ya terminó). |
| «Inicio del semestre» = 25/08/2026 y «Correr fechas» | `PUT /api/documents/bitacora/start-date` corre todo 370 días: «Fechas corridas: la semana 1 queda el mar 25 ago y la última fecha es el mar 15 dic (16 semanas).»; el estado dice «Cargada. Hoy va en la semana 5 de 16.» y la lista marca la semana 5 con «esta semana». |
| El estudiante abre su editor (túnel) | Inicio: «Estás en FPOO · semana 5 de 16» · «Uso de clases de bibliotecas, APIs, y reutilización de código · Próximo: Examen (Primer parcial), mar 6 oct (en 8 días)». En «Tutor», bajo «Hoy quiero reforzar»: «Semana 5 de 16» · «FPOO: Uso de clases de bibliotecas, APIs, y reutilización de código». |
| El tutor responde | `/intervene` llevó `context.courseWeek` (FPOO, semana 5 de 16, 2026-09-22 a 2026-09-28, el tema y las tres próximas evaluaciones) y el prompt del backend tuvo `CourseWeek: FPOO, semana 5 de 16 (2026-09-22 a 2026-09-28): Uso de clases de bibliotecas, APIs, y reutilización de código`, `UpcomingEvaluations: Examen (Primer parcial) (Parcial, 2026-10-06); Entrega de proyecto de curso 2 (Proyecto, 2026-10-13); Proyecto 3 entrega (Proyecto, 2026-11-24)` y la regla de no adelantar temas. |
| «Sincronizar con Google Calendar» (1.ª vez) | Comprueba la cuenta (`userinfo`), lista los eventos de ADACEEN del curso y los del calendario de hoy al 8 de diciembre: «Google Calendar al día: 5 eventos creados, 1 ya lo tenías con otro nombre.» El estudiante ya tenía «Entregar proyecto 3 de POO» el 24 de noviembre; su «Parcial de Cálculo I» del 1 de diciembre no cuenta como el segundo parcial de FPOO. |
| «Sincronizar con Google Calendar» (2.ª vez) | «Google Calendar al día: 5 ya estaban, 1 ya lo tenías con otro nombre.» No se crea nada. |
| «Sugerir bloques de estudio» | 6 sesiones en horas libres antes de las tres próximas evaluaciones: jue 1 oct 16:30–18:30 (a las 18:30 tenía «Monitoría de Cálculo»), dom 4 oct 15:00–17:00 (en la mañana tenía «Turno en la cafetería»), vie 9 oct y lun 12 oct 18:30–20:00, vie 20 nov y lun 23 nov 18:30–20:00. |
| Desmarca una y «Agregar los marcados a Google Calendar» | «Bloques de estudio: 5 agregados.» |
| Chrome con otra cuenta de Google | «Chrome tiene abierta la cuenta de Google estudiante.personal@gmail.com. Para no llenar otro calendario, sincroniza con la misma cuenta de tu sesión: estudiante.prueba@correounivalle.edu.co.» No se crea ni se mueve nada (14 eventos antes y después). |
| Estudiante demo (`estudiante@adaceen.edu.co`) | Ve la misma semana, pero «Sincronizar con Google Calendar» queda apagado: «Para sincronizar con Google Calendar entra a ADACEEN con tu correo de la universidad (…@correounivalle.edu.co); ahora estás con estudiante@adaceen.edu.co.» |

Sin errores del backend en ninguna petición.

## El semestre simulado (bitácora corrida al 25 de agosto de 2026)

| Semana | Días | Tema | Evaluaciones y entregas |
|---|---|---|---|
| 1 | mar 25 ago – lun 31 ago | Programa del curso y bitacora | — |
| 2 | mar 1 sep – lun 7 sep | Paradigma orientado a objetos y sus potencialidades | — |
| 3 | mar 8 sep – lun 14 sep | Paradigma Orientado a Objetos y pilares de la programación orientada a objetos | — |
| 4 | mar 15 sep – lun 21 sep | C++ y su semántica orientados a objetos: Abstraccion, Encapsulación y Utilizar diagramas de clase | — |
| **5** | **mar 22 sep – lun 28 sep** | **Uso de clases de bibliotecas, APIs, y reutilización de código (hoy)** | — |
| 6 | mar 29 sep – lun 5 oct | Desarrollar soluciones a problemas de programación. Utiliza el diagrama de clases para modelar la solución de requerimientos funcionales o historia de usuario | — |
| 7 | mar 6 oct – lun 12 oct | Examen (Primer parcial) | Examen (Primer parcial), mar 6 oct |
| 8 | mar 13 oct – lun 19 oct | Aplica las relaciones entre objetos, paso de mensajes por referencia o punteros. | Entrega de proyecto de curso 2, mar 13 oct |
| 9 | mar 20 oct – lun 26 oct | Actividad traer invitado de la industria | — |
| 10 | mar 27 oct – lun 2 nov | Abstraer desde los requerimientos: relaciones entre clases de diferentes tipos: Herencia, composición y conoce. | — |
| 11 | mar 3 nov – lun 9 nov | Diseño del diagrama de clases y su implementación en un lenguaje de programación | — |
| 12 | mar 10 nov – lun 16 nov | El diagrama de clases y su implementación de los conceptos: encapsulamiento y herencia | — |
| 13 | mar 17 nov – lun 23 nov | El diagrama de clases y su implementación de los conceptos polimorfismo | — |
| 14 | mar 24 nov – lun 30 nov | Polimorfismo | Proyecto 3 entrega, mar 24 nov |
| 15 | mar 1 dic – lun 7 dic | Examen (segundo parcial) | Examen (segundo parcial) y Entrega proyecto 4, mar 1 dic |
| 16 | mar 8 dic – lun 14 dic | Entrega proyecto final: Evaluar tareas específicas y comunicando ideas para integrar equipos de programación | Entrega proyecto final, mar 8 dic |
| — | mar 15 dic | OPCIONAL (fila sin semana) | — |

Los temas son los del PDF tal cual. La bitácora no trae horas: las evaluaciones quedan a
las 9:00 (el parcial dos horas, el resto una) con avisos un día y una hora antes; el
estudiante puede moverlas y ADACEEN no se las devuelve (solo las mueve si el docente cambia
la fecha en la bitácora).

## Capturas

Ventana de 1600 × 900. Donde el cuerpo del overlay desplaza, la captura va desplazada hasta
lo que muestra.

| Archivo | Rol y pestaña | Qué muestra |
|---|---|---|
| `01-docente-bitacora-pdf-2025.png` | Docente · Bitácora | El PDF recién subido (17 semanas en la lista, contando «OPCIONAL»), «Inicio del semestre» con la fecha de 2025 y «Bitácora subida: 23 registro(s) detectado(s).» |
| `02-docente-inicio-del-semestre.png` | Docente · Bitácora | Tras «Correr fechas» al 25/08/2026: «Hoy va en la semana 5 de 16», la nota con la semana 1 y la 16, y el mensaje «Fechas corridas…» |
| `03-docente-semana-de-hoy.png` | Docente · Bitácora | «Semanas cargadas» con la semana 5 marcada («22-9-2026 · esta semana») |
| `04-estudiante-inicio-semana.png` | Estudiante · Inicio (editor por túnel) | La línea «Estás en FPOO · semana 5 de 16» con el tema, la próxima evaluación, «Semana 5» y «Abrir» |
| `05-estudiante-tutor-semana.png` | Estudiante · Tutor | La línea de la semana bajo «Hoy quiero reforzar» y las pistas (texto del modelo simulado, citas del RAG del backend real) |
| `06-estudiante-agenda.png` | Estudiante · Agenda | «Esta semana», las próximas evaluaciones y entregas, el bloque de Google Calendar y «Todas las semanas» |
| `07-estudiante-calendar-sincronizado.png` | Estudiante · Agenda | Después de sincronizar: «Google Calendar al día: 5 eventos creados, 1 ya lo tenías con otro nombre.» |
| `08-estudiante-bloques-sugeridos.png` | Estudiante · Agenda | Las 6 sesiones sugeridas, marcadas |
| `09-estudiante-bloques-agregados.png` | Estudiante · Agenda | 5 agregadas («agregado») y una sin marcar |
| `10-estudiante-todas-las-semanas.png` | Estudiante · Agenda | «Todas las semanas» abierto, con la semana 5 marcada («hoy») |
| `11-estudiante-otra-cuenta-google.png` | Estudiante · Agenda | El aviso cuando Chrome tiene otra cuenta de Google |
| `12-estudiante-sin-correo-universidad.png` | Estudiante demo · Agenda | Sin correo de la universidad: el botón apagado y el motivo |
| `13-google-calendar-simulado.png` | — | El calendario simulado al final: eventos propios, las 5 evaluaciones y entregas creadas y los 5 bloques de estudio |

En las capturas el campo de fecha sale como 08/25/2026 porque el Chromium de prueba está en
inglés; en un Chrome en español se ve 25/08/2026.

## Lo que encontró la simulación (corregido antes de entregar)

1. **En el editor la tarjeta «Contexto de trabajo» tapaba la agenda.** La tarjeta sigue al
   puntero y, al pulsar «Sugerir bloques de estudio», caía encima de las sugerencias y del
   botón para agregarlas (Playwright no pudo pulsarlo). Ahora no aparece en la pestaña
   «Agenda».
2. **En el editor el overlay queda en «Tutor»**, no en Inicio, así que el estudiante no veía
   la semana sin cambiar de pestaña. Se agregó la línea de la semana en «Tutor».
3. **La hora que el estudiante le cambia a una evaluación se deshacía** en la siguiente
   sincronización (se comparaba la hora exacta). Ahora cada evento guarda la fecha de la
   bitácora con que se creó y solo se mueve si el docente la cambia, al día nuevo con la hora
   y la duración que tenga; si el estudiante lo movió de hora o de día, se queda así.
4. **Evaluaciones que el estudiante ya tenía con otro nombre se duplicaban.** Ahora se
   reconocen el mismo día por el título (también las que vienen de Campus como
   «ADACEEN entrega: …»), sin confundir el parcial de otra materia ese día.

## Pendiente

- Probarlo con el backend desplegado y una cuenta real de Google (`chrome.identity`) de un
  estudiante con correo de la universidad; la API de Google aquí fue simulada.
- La política de privacidad (`/privacy-policy`) no menciona Google Calendar (tampoco con
  «Sincronizar agenda» de Campus). La 0.7.17 además lee los eventos del calendario principal
  en el navegador, sin mandarlos al backend. Si se quiere decir explícito, es una versión
  nueva de la política y todos vuelven a aceptarla.
