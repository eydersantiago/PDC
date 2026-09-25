# Catálogo de KPIs del piloto

> Documento generado desde `src/services/kpi-catalog.ts` con `npm run kpis:catalogo`. No lo edites a mano: cambia el catálogo y regenéralo.

| | |
|---|---|
| Jira | A3.1 (técnicos), A3.2 (UX y pedagógicos), A3.3 (operacionalización), A3.5 (umbrales), A3.6 (reporte) |
| Cálculo | `src/services/kpis.ts` (pruebas en `tests/services/kpis.test.ts`) |
| En vivo | `GET /api/telemetry/kpis` y `npm run piloto:monitor` |
| Informe final | `npm run piloto:analisis` |

Cada KPI dice qué pregunta responde, cómo se calcula (fórmula, unidad y ventana), de dónde salen los datos, con qué umbral se juzga y de dónde viene ese umbral. Los KPIs automáticos se calculan con la telemetría, la encuesta y la asistencia; los manuales se registran en el plan del piloto (`data/piloto/plan-piloto.ejemplo.json`).

**Regla para las contradicciones del anteproyecto:** manda la sección 5.4, que es la tabla de KPIs. Por eso la latencia se juzga con ≤ 8 s (no con los ≤ 10 s de A9) y las mejoras críticas con ≥ 65 % (no con el ≥ 70 % de A13).

**Línea base del tiempo hasta desbloqueo:** el mismo estudiante sin tutor, en un diseño intra-sujeto contrabalanceado AB/BA (la mitad del grupo empieza con el tutor). Ver el protocolo del piloto.

## Resumen

| ID | KPI | Dimensión | Umbral | Origen | Cálculo |
|---|---|---|---|---|---|
| T1 ★ | Latencia del tutor (mediana) | Técnicos | ≤ 8 s | Anteproyecto 5.4 (arquitectura híbrida). | Automático |
| T2 | Latencia del tutor (p95) | Técnicos | ≤ 15 s | Propuesto: el anteproyecto no fija un p95. | Automático |
| T3 | Respuestas del tutor sin fallo | Técnicos | ≥ 95 % | Propuesto a partir de «cero fallos críticos» (A9, A10) y «funcionalidad del MVP ≥ 95 %» (5.4). | Automático |
| T4 | Pérdida de eventos | Técnicos | ≤ 2 % | Propuesto. | Automático |
| T5 | Eventos duplicados | Técnicos | ≤ 1 % | Propuesto. | Automático |
| T6 | Sesiones con telemetría | Técnicos | ≥ 90 % | Anteproyecto 5.4 (telemetría en ≥ 90 % de las sesiones). | Automático |
| T7 | Incidentes críticos en clase | Técnicos | = 0 | Anteproyecto (A9 y A10: cero fallos críticos). | Manual |
| T8 | Pruebas de humo | Técnicos | ≥ 95 % | Anteproyecto 5.4 (funcionalidad del MVP ≥ 95 % en pruebas de humo). | Manual |
| T9 | Respuestas ancladas en material autorizado | Técnicos | ≥ 80 % | Anteproyecto 5.4 (≥ 80 % de respuestas ancladas cuando aplica). | Automático |
| T10 | Tiempo de instalación | Técnicos | ≤ 15 min | Anteproyecto (guía de instalación y uso, instalación ≤ 15 min). | Manual |
| T11 | Cumplimiento de privacidad, ética y seguridad | Técnicos | ≥ 80 % | Anteproyecto (A5 y A13.4: checklist ≥ 80 %). | Manual |
| T12 | Eventos útiles en el diccionario | Técnicos | ≥ 10 | Anteproyecto (A4: al menos 10 eventos útiles). | Automático |
| U1 ★ | Experiencia de uso del tutor | Experiencia de uso (UX) | ≥ 4,0 / 5 | Anteproyecto 5.4 (UX ≥ 4/5). | Automático |
| U2 | Usabilidad (SUS) | Experiencia de uso (UX) | ≥ 68 | Propuesto: 68 es el promedio de referencia de la escala SUS. | Automático |
| U3 | Ayudas valoradas como útiles | Experiencia de uso (UX) | Descriptivo | Sin umbral en el anteproyecto. | Automático |
| U4 | Cambios del tutor aplicados en VS Code | Experiencia de uso (UX) | Descriptivo | Sin umbral en el anteproyecto. | Automático |
| U5 | Respuesta de la encuesta | Experiencia de uso (UX) | Descriptivo | Sin umbral en el anteproyecto. | Automático |
| P1 ★ | Reducción del tiempo hasta desbloqueo | Pedagógicos | ≥ 20 % | Anteproyecto 5.4 (tiempo hasta desbloqueo −20 %). | Automático |
| P2 | Episodios de bloqueo resueltos | Pedagógicos | Descriptivo (acompaña a P1) | Sin umbral en el anteproyecto. | Automático |
| P3 | Participación | Pedagógicos | ≥ 70 % | Anteproyecto 5.4 (participación ≥ 70 %). | Automático |
| P4 | Percepción de apoyo al aprendizaje | Pedagógicos | ≥ 4,0 / 5 | Anteproyecto 5.4 (percepción ≥ 4/5). | Automático |
| P5 | Mejoras críticas implementadas | Pedagógicos | ≥ 65 % | Anteproyecto 5.4. | Manual |
| P6 | Cumplimiento del límite anti-solución | Pedagógicos | = 100 % | Anteproyecto (A2 y 7.1: nunca la solución completa). | Automático |
| P7 | Bloqueos de la política y uso por etapa | Pedagógicos | Descriptivo | Sin umbral en el anteproyecto. | Automático |
| P8 | Aciertos en el mini-quiz | Pedagógicos | Descriptivo | Sin umbral en el anteproyecto. | Automático |

★ KPI principal: el anteproyecto pide al menos uno técnico, uno de UX y uno pedagógico (T1, U1 y P1).

## Técnicos

### T1. Latencia del tutor (mediana)

| | |
|---|---|
| Pregunta | ¿Cuánto espera el estudiante por una ayuda del tutor? |
| Fórmula | Mediana (p50) de latency_ms de los eventos tutor_decision con blocked = false y sin caché, en segundos. Percentil con interpolación lineal (PERCENTIL.INC). |
| Unidad | s |
| Ventana | Cada sesión y el piloto completo; por canal (overlay y VS Code) y por servidor de inferencia (GPU de Google Cloud o Mac del laboratorio). |
| Fuente | telemetría (telemetry_events) |
| Eventos | `tutor_decision` |
| Umbral | ≤ 8 s |
| Origen del umbral | Anteproyecto 5.4 (arquitectura híbrida). |
| Decisión | El anteproyecto dice ≤ 8 s en 5.4 y ≤ 10 s en A9; manda 5.4. La latencia es la del servidor (de la petición a la respuesta), no incluye la red de la sala. Si una sesión reparte los trabajos entre servidores de inferencia distintos, el umbral se juzga sobre el total y la tabla por servidor solo describe la diferencia de hardware. |
| Cálculo | Automático (`npm run piloto:analisis`) |
| Gráfica o tabla | Diagrama de caja por canal; p50 y p95 por sesión y por servidor de inferencia en tablas. |
| Jira | A3.1, A3.3, A12.2 |

### T2. Latencia del tutor (p95)

| | |
|---|---|
| Pregunta | ¿Cuánto esperan los casos lentos? |
| Fórmula | Percentil 95 de la misma serie de T1, en segundos. |
| Unidad | s |
| Ventana | Cada sesión y el piloto completo; por canal y por servidor de inferencia. |
| Fuente | telemetría (telemetry_events) |
| Eventos | `tutor_decision` |
| Umbral | ≤ 15 s |
| Origen del umbral | Propuesto: el anteproyecto no fija un p95. |
| Decisión | 15 s deja margen para el sondeo de la cola (8 s) sobre la inferencia en caliente medida (2 a 7 s). |
| Cálculo | Automático (`npm run piloto:analisis`) |
| Gráfica o tabla | Junto con T1 en el diagrama de caja. |
| Jira | A3.1, A3.5, A12.2 |

### T3. Respuestas del tutor sin fallo

| | |
|---|---|
| Pregunta | ¿Qué parte de las ayudas llega del modelo y no del respaldo por falla? |
| Fórmula | 1 − (decisiones con reason_code = model_error_fallback / decisiones no bloqueadas sin caché). |
| Unidad | % |
| Ventana | Cada sesión y el piloto completo. |
| Fuente | telemetría (telemetry_events) |
| Eventos | `tutor_decision` |
| Umbral | ≥ 95 % |
| Origen del umbral | Propuesto a partir de «cero fallos críticos» (A9, A10) y «funcionalidad del MVP ≥ 95 %» (5.4). |
| Decisión | Una respuesta degradada (sin worker) cuenta como fallo aunque el estudiante reciba un mensaje controlado. |
| Cálculo | Automático (`npm run piloto:analisis`) |
| Gráfica o tabla | Semáforo en la tabla de KPIs. |
| Jira | A3.1, A3.5 |

### T4. Pérdida de eventos

| | |
|---|---|
| Pregunta | ¿Se pierde telemetría entre el cliente y la base? |
| Fórmula | Eventos faltantes por huecos de seq / eventos esperados, por client_session_id (regla I1). |
| Unidad | % |
| Ventana | Cada sesión y el piloto completo. |
| Fuente | telemetría (telemetry_events) |
| Eventos | (todos los eventos con seq) |
| Umbral | ≤ 2 % |
| Origen del umbral | Propuesto. |
| Decisión | Solo cuenta a los clientes que numeran sus eventos (overlay y VS Code); los del backend no llevan seq. |
| Cálculo | Automático (`npm run piloto:analisis`) |
| Gráfica o tabla | Semáforo; en vivo, alerta del monitor. |
| Jira | A3.1, A3.5, A14.2 |

### T5. Eventos duplicados

| | |
|---|---|
| Pregunta | ¿Llegan eventos repetidos? |
| Fórmula | Eventos con el mismo client_session_id y seq / eventos con seq (regla I2). |
| Unidad | % |
| Ventana | Cada sesión y el piloto completo. |
| Fuente | telemetría (telemetry_events) |
| Eventos | (todos los eventos con seq) |
| Umbral | ≤ 1 % |
| Origen del umbral | Propuesto. |
| Decisión | En la limpieza (A14.3) se conserva el primero y se descartan las copias. |
| Cálculo | Automático (`npm run piloto:analisis`) |
| Gráfica o tabla | Semáforo. |
| Jira | A3.1, A3.5, A14.3 |

### T6. Sesiones con telemetría

| | |
|---|---|
| Pregunta | ¿Se registró el trabajo de los estudiantes que asistieron? |
| Fórmula | Estudiantes con al menos un evento con condición del piloto en la fecha / estudiantes presentes según la asistencia, sumado sobre las sesiones. |
| Unidad | % |
| Ventana | Cada sesión del piloto. |
| Fuente | telemetría (telemetry_events); lista de asistencia y consentimientos |
| Eventos | (eventos con pilot_condition) |
| Umbral | ≥ 90 % |
| Origen del umbral | Anteproyecto 5.4 (telemetría en ≥ 90 % de las sesiones). |
| Decisión | La asistencia entra como conteo por sesión (sin nombres). Un estudiante sin la sesión compartida de VS Code configurada no tiene condición y cuenta como sesión sin telemetría. |
| Cálculo | Automático (`npm run piloto:analisis`) |
| Gráfica o tabla | Barras por sesión: presentes contra estudiantes con telemetría. |
| Jira | A3.1, A14.1 |

### T7. Incidentes críticos en clase

| | |
|---|---|
| Pregunta | ¿El sistema dejó a la clase sin trabajar? |
| Fórmula | Incidentes de severidad 1 del registro del plan de soporte durante las sesiones. |
| Unidad | incidentes |
| Ventana | Piloto completo. |
| Fuente | registro manual |
| Eventos | — |
| Umbral | = 0 |
| Origen del umbral | Anteproyecto (A9 y A10: cero fallos críticos). |
| Decisión | Severidad 1 = la clase o más de la mitad del grupo no puede seguir trabajando (ver plan de soporte). |
| Cálculo | Manual: se registra en el plan del piloto |
| Gráfica o tabla | Tabla de incidentes por sesión. |
| Jira | A3.1, A13.5 |

### T8. Pruebas de humo

| | |
|---|---|
| Pregunta | ¿Funciona el MVP de punta a punta antes de cada sesión? |
| Fórmula | Comprobaciones correctas de npm run demo:escenarios contra producción / comprobaciones totales. |
| Unidad | % |
| Ventana | Antes de cada sesión. |
| Fuente | pruebas de humo |
| Eventos | — |
| Umbral | ≥ 95 % |
| Origen del umbral | Anteproyecto 5.4 (funcionalidad del MVP ≥ 95 % en pruebas de humo). |
| Decisión | Se registra la de cada sesión; el KPI es la peor. |
| Cálculo | Manual: se registra en el plan del piloto |
| Gráfica o tabla | Tabla por sesión. |
| Jira | A3.1, A12.1 |

### T9. Respuestas ancladas en material autorizado

| | |
|---|---|
| Pregunta | ¿El tutor responde con el material del curso? |
| Fórmula | Decisiones no bloqueadas con al menos una fuente autorizada (metadata.ragSources ≥ 1) / decisiones no bloqueadas de eventos del curso. |
| Unidad | % |
| Ventana | Piloto completo; por canal. |
| Fuente | telemetría (telemetry_events) |
| Eventos | `tutor_decision` |
| Umbral | ≥ 80 % |
| Origen del umbral | Anteproyecto 5.4 (≥ 80 % de respuestas ancladas cuando aplica). |
| Decisión | «Cuando aplica» = eventos del curso: se excluyen out_of_domain y las consultas de flujo de trabajo (git, GitHub). Con fuentes, la cita es obligatoria (ensureMentorResultRagCitations). |
| Cálculo | Automático (`npm run piloto:analisis`) |
| Gráfica o tabla | Semáforo por canal. |
| Jira | A3.1, A8.6 |

### T10. Tiempo de instalación

| | |
|---|---|
| Pregunta | ¿Un estudiante nuevo queda listo en poco tiempo? |
| Fórmula | Mediana de los minutos desde abrir la guía hasta tener el overlay con sesión y el editor por túnel con ADACEEN, en la validación de la guía (A16.8). |
| Unidad | min |
| Ventana | Validación de la guía. |
| Fuente | registro manual |
| Eventos | — |
| Umbral | ≤ 15 min |
| Origen del umbral | Anteproyecto (guía de instalación y uso, instalación ≤ 15 min). |
| Decisión | Se cronometra con al menos 3 personas que no conocen el proyecto. |
| Cálculo | Manual: se registra en el plan del piloto |
| Gráfica o tabla | Tabla de tiempos por persona. |
| Jira | A3.1, A16.8 |

### T11. Cumplimiento de privacidad, ética y seguridad

| | |
|---|---|
| Pregunta | ¿El piloto cumple lo prometido en datos y ética? |
| Fórmula | Ítems cumplidos / ítems aplicables de la lista de cumplimiento (A13.4). |
| Unidad | % |
| Ventana | Antes del piloto. |
| Fuente | registro manual |
| Eventos | — |
| Umbral | ≥ 80 % |
| Origen del umbral | Anteproyecto (A5 y A13.4: checklist ≥ 80 %). |
| Decisión | Los ítems críticos (consentimiento, seudonimización, sal configurada) son obligatorios aunque el total pase del 80 %. |
| Cálculo | Manual: se registra en el plan del piloto |
| Gráfica o tabla | Tabla de la lista con su estado. |
| Jira | A3.1, A13.4 |

### T12. Eventos útiles en el diccionario

| | |
|---|---|
| Pregunta | ¿La telemetría tiene suficientes eventos con propósito? |
| Fórmula | Eventos del catálogo que alimentan al menos un KPI. |
| Unidad | eventos |
| Ventana | Versión del diccionario. |
| Fuente | catálogo de eventos |
| Eventos | — |
| Umbral | ≥ 10 |
| Origen del umbral | Anteproyecto (A4: al menos 10 eventos útiles). |
| Decisión | Se cuenta desde src/services/telemetry-catalog.ts. |
| Cálculo | Automático (`npm run piloto:analisis`) |
| Gráfica o tabla | Número en la tabla de KPIs. |
| Jira | A3.1, A4.1 |

## Experiencia de uso (UX)

### U1. Experiencia de uso del tutor

| | |
|---|---|
| Pregunta | ¿A los estudiantes les resultó cómodo y útil trabajar con el tutor? |
| Fórmula | Promedio de los ítems UX1 a UX6 de la encuesta final (escala de 1 a 5), primero por persona y luego entre personas. |
| Unidad | /5 |
| Ventana | Al final del piloto. |
| Fuente | encuesta final (A13.2) |
| Eventos | — |
| Umbral | ≥ 4,0 / 5 |
| Origen del umbral | Anteproyecto 5.4 (UX ≥ 4/5). |
| Decisión | Se reporta también la distribución por ítem; una persona cuenta si respondió al menos 4 de los 6 ítems. |
| Cálculo | Automático (`npm run piloto:analisis`) |
| Gráfica o tabla | Barras divergentes por ítem (de «totalmente en desacuerdo» a «totalmente de acuerdo»). |
| Jira | A3.2, A13.2 |

### U2. Usabilidad (SUS)

| | |
|---|---|
| Pregunta | ¿Qué tan usable es el sistema frente a una referencia estándar? |
| Fórmula | Puntaje SUS de 0 a 100 por persona (ítems impares: valor − 1; pares: 5 − valor; suma × 2,5) y su promedio. |
| Unidad | puntos |
| Ventana | Al final del piloto. |
| Fuente | encuesta final (A13.2) |
| Eventos | — |
| Umbral | ≥ 68 |
| Origen del umbral | Propuesto: 68 es el promedio de referencia de la escala SUS. |
| Decisión | Solo cuentan las encuestas con los 10 ítems SUS respondidos. |
| Cálculo | Automático (`npm run piloto:analisis`) |
| Gráfica o tabla | Histograma de puntajes SUS. |
| Jira | A3.2, A13.2 |

### U3. Ayudas valoradas como útiles

| | |
|---|---|
| Pregunta | ¿En el momento, las ayudas le sirvieron al estudiante? |
| Fórmula | «Me sirvió» / («Me sirvió» + «No me sirvió») en el overlay (tutor_response_accepted y tutor_response_rejected). |
| Unidad | % |
| Ventana | Piloto completo. |
| Fuente | telemetría (telemetry_events) |
| Eventos | `tutor_response_accepted`, `tutor_response_rejected` |
| Umbral | Descriptivo |
| Origen del umbral | Sin umbral en el anteproyecto. |
| Decisión | Las ayudas sin valoración (ignoradas) se reportan aparte. |
| Cálculo | Automático (`npm run piloto:analisis`) |
| Gráfica o tabla | Barras apiladas: útil, no útil, sin valorar. |
| Jira | A3.2 |

### U4. Cambios del tutor aplicados en VS Code

| | |
|---|---|
| Pregunta | ¿Los estudiantes usan las sugerencias del editor? |
| Fórmula | suggestion_completion_applied / vscode_suggestion_shown. |
| Unidad | % |
| Ventana | Piloto completo. |
| Fuente | telemetría (telemetry_events) |
| Eventos | `vscode_suggestion_shown`, `suggestion_completion_applied` |
| Umbral | Descriptivo |
| Origen del umbral | Sin umbral en el anteproyecto. |
| Decisión | Una aplicación alta no es buena por sí sola: se lee junto con P1 y P6. |
| Cálculo | Automático (`npm run piloto:analisis`) |
| Gráfica o tabla | Número en la tabla de KPIs. |
| Jira | A3.2, A10.8 |

### U5. Respuesta de la encuesta

| | |
|---|---|
| Pregunta | ¿Cuántos participantes respondieron la encuesta? |
| Fórmula | Encuestas válidas / participantes con consentimiento. |
| Unidad | % |
| Ventana | Al final del piloto. |
| Fuente | encuesta final (A13.2); lista de asistencia y consentimientos |
| Eventos | — |
| Umbral | Descriptivo |
| Origen del umbral | Sin umbral en el anteproyecto. |
| Decisión | Con menos del 70 % se discute el sesgo de no respuesta en los resultados. |
| Cálculo | Automático (`npm run piloto:analisis`) |
| Gráfica o tabla | Número en la tabla de KPIs. |
| Jira | A3.2, A14.3 |

## Pedagógicos

### P1. Reducción del tiempo hasta desbloqueo

| | |
|---|---|
| Pregunta | ¿El tutor acorta el tiempo que un estudiante pasa atascado en un error? |
| Fórmula | 1 − (mediana, entre estudiantes, de su mediana con tutor / mediana, entre estudiantes, de su mediana sin tutor). Un episodio va de la aparición del error a su desaparición (blocking_resolved.durationMs) y solo cuenta si el error llegó a bloqueo (blocking_detected). Solo estudiantes con episodios resueltos en las dos condiciones. Prueba de Wilcoxon de rangos con signo sobre las medianas pareadas. |
| Unidad | % |
| Ventana | Bloques del piloto (condición vigente al empezar el episodio). |
| Fuente | telemetría (telemetry_events) |
| Eventos | `blocking_detected`, `blocking_resolved` |
| Umbral | ≥ 20 % |
| Origen del umbral | Anteproyecto 5.4 (tiempo hasta desbloqueo −20 %). |
| Decisión | Línea base: el mismo estudiante sin tutor (diseño intra-sujeto AB/BA, 24 de septiembre de 2026). Se excluyen los episodios que cruzan un cambio de bloque; los corregidos desde otro archivo entran (cota superior) y se reporta el resultado sin ellos. Fuente: VS Code (el overlay no cierra episodios). |
| Cálculo | Automático (`npm run piloto:analisis`) |
| Gráfica o tabla | Puntos pareados por estudiante (sin tutor → con tutor) y caja por condición; tabla por cohorte para ver el efecto de orden. |
| Jira | A3.2, A3.3, A14.4 |

### P2. Episodios de bloqueo resueltos

| | |
|---|---|
| Pregunta | ¿Cuántos bloqueos terminan resueltos en cada condición? |
| Fórmula | Episodios con blocking_resolved / episodios con blocking_detected, por condición. |
| Unidad | % |
| Ventana | Bloques del piloto. |
| Fuente | telemetría (telemetry_events) |
| Eventos | `blocking_detected`, `blocking_resolved` |
| Umbral | Descriptivo (acompaña a P1) |
| Origen del umbral | Sin umbral en el anteproyecto. |
| Decisión | Un episodio sin cierre queda censurado: no entra en la mediana de P1 y se cuenta aquí. |
| Cálculo | Automático (`npm run piloto:analisis`) |
| Gráfica o tabla | Barras por condición. |
| Jira | A3.2, A14.4 |

### P3. Participación

| | |
|---|---|
| Pregunta | ¿Cuántos participantes completaron las dos condiciones? |
| Fórmula | Estudiantes con actividad registrada en los dos bloques (con y sin tutor) / estudiantes con consentimiento. |
| Unidad | % |
| Ventana | Piloto completo. |
| Fuente | telemetría (telemetry_events); lista de asistencia y consentimientos |
| Eventos | (eventos con pilot_condition) |
| Umbral | ≥ 70 % |
| Origen del umbral | Anteproyecto 5.4 (participación ≥ 70 %). |
| Decisión | El número de consentimientos se registra en el plan del piloto (sin nombres). |
| Cálculo | Automático (`npm run piloto:analisis`) |
| Gráfica o tabla | Número en la tabla de KPIs. |
| Jira | A3.2, A14.1 |

### P4. Percepción de apoyo al aprendizaje

| | |
|---|---|
| Pregunta | ¿Los estudiantes sienten que el tutor los ayudó a aprender y no solo a terminar? |
| Fórmula | Promedio de los ítems PA1 a PA5 de la encuesta final (1 a 5), primero por persona. |
| Unidad | /5 |
| Ventana | Al final del piloto. |
| Fuente | encuesta final (A13.2) |
| Eventos | — |
| Umbral | ≥ 4,0 / 5 |
| Origen del umbral | Anteproyecto 5.4 (percepción ≥ 4/5). |
| Decisión | Una persona cuenta si respondió al menos 3 de los 5 ítems. |
| Cálculo | Automático (`npm run piloto:analisis`) |
| Gráfica o tabla | Barras divergentes por ítem. |
| Jira | A3.2, A13.2 |

### P5. Mejoras críticas implementadas

| | |
|---|---|
| Pregunta | ¿Se corrigió lo importante que mostró el piloto? |
| Fórmula | Mejoras críticas implementadas / mejoras críticas identificadas en los hallazgos (A14.5). |
| Unidad | % |
| Ventana | Después del piloto. |
| Fuente | registro manual |
| Eventos | — |
| Umbral | ≥ 65 % |
| Origen del umbral | Anteproyecto 5.4. |
| Decisión | 5.4 dice ≥ 65 % y A13 ≥ 70 %; manda 5.4. |
| Cálculo | Manual: se registra en el plan del piloto |
| Gráfica o tabla | Tabla de hallazgos con su estado. |
| Jira | A3.2, A14.5 |

### P6. Cumplimiento del límite anti-solución

| | |
|---|---|
| Pregunta | ¿Todo cambio de código aplicado pasó por la política del docente? |
| Fórmula | 1 − (cambios aplicados sin verificación previa / cambios aplicados), con la regla I6. |
| Unidad | % |
| Ventana | Piloto completo. |
| Fuente | telemetría (telemetry_events) |
| Eventos | `code_application_checked`, `suggestion_completion_applied` |
| Umbral | = 100 % |
| Origen del umbral | Anteproyecto (A2 y 7.1: nunca la solución completa). |
| Decisión | Los recortes del guardarraíl (código más largo que el límite de la etapa) se reportan aparte como evidencia de que el límite actuó. |
| Cálculo | Automático (`npm run piloto:analisis`) |
| Gráfica o tabla | Número en la tabla de KPIs. |
| Jira | A3.2, A10.2, A10.8 |

### P7. Bloqueos de la política y uso por etapa

| | |
|---|---|
| Pregunta | ¿Qué tipo de ayuda dio el tutor y cuántas bloqueó la política? |
| Fórmula | Distribución de tutor_decision por etapa de ayuda y tipo de intervención; porcentaje bloqueado por la política sin contar el bloque sin tutor. |
| Unidad | % |
| Ventana | Piloto completo; por canal. |
| Fuente | telemetría (telemetry_events) |
| Eventos | `tutor_decision` |
| Umbral | Descriptivo |
| Origen del umbral | Sin umbral en el anteproyecto. |
| Decisión | Las decisiones con reason_code = pilot_no_tutor no son bloqueos de la política: son la condición sin tutor. |
| Cálculo | Automático (`npm run piloto:analisis`) |
| Gráfica o tabla | Barras apiladas por etapa y canal. |
| Jira | A3.2, A9.8 |

### P8. Aciertos en el mini-quiz

| | |
|---|---|
| Pregunta | ¿Los estudiantes entienden el cambio que aceptaron? |
| Fórmula | Respuestas correctas / respuestas del mini-quiz. |
| Unidad | % |
| Ventana | Piloto completo. |
| Fuente | intentos del mini-quiz |
| Eventos | — |
| Umbral | Descriptivo |
| Origen del umbral | Sin umbral en el anteproyecto. |
| Decisión | Se exporta con npm run piloto:dataset (tabla student_quizzes con el actor seudonimizado). |
| Cálculo | Automático (`npm run piloto:analisis`) |
| Gráfica o tabla | Número en la tabla de KPIs. |
| Jira | A3.2, A8.5 |

## Umbrales por aprobar (A3.5)

Estos umbrales no están en el anteproyecto: los propone este catálogo y los aprueba el director antes de la primera sesión del piloto. Después de aprobados no se cambian.

| KPI | Umbral propuesto | Por qué |
|---|---|---|
| T2. Latencia del tutor (p95) | ≤ 15 s | 15 s deja margen para el sondeo de la cola (8 s) sobre la inferencia en caliente medida (2 a 7 s). |
| T3. Respuestas del tutor sin fallo | ≥ 95 % | Una respuesta degradada (sin worker) cuenta como fallo aunque el estudiante reciba un mensaje controlado. |
| T4. Pérdida de eventos | ≤ 2 % | Solo cuenta a los clientes que numeran sus eventos (overlay y VS Code); los del backend no llevan seq. |
| T5. Eventos duplicados | ≤ 1 % | En la limpieza (A14.3) se conserva el primero y se descartan las copias. |
| U2. Usabilidad (SUS) | ≥ 68 | Solo cuentan las encuestas con los 10 ítems SUS respondidos. |

También se someten a aprobación las dos decisiones sobre contradicciones del anteproyecto (T1 y P5) y la línea base de P1.

## Reporte mínimo y periodicidad (A3.6)

| Momento | Cómo | KPIs | Qué más |
|---|---|---|---|
| Durante cada sesión (monitor, cada 30 s) | npm run piloto:monitor | T1, T3, T4, T5 | Worker vivo, estudiantes activos en los últimos 5 minutos, eventos por minuto, bloque vigente y alertas. |
| Al cerrar cada sesión | npm run piloto:dataset y npm run piloto:analisis sobre la fecha | T1, T2, T3, T4, T5, T6, T9, P2, P7 | Informe corto de la sesión para ajustar la siguiente (sin cambiar el tutor a mitad del piloto). |
| Al terminar el piloto | npm run piloto:analisis con la encuesta y el plan | T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, U1, U2, U3, U4, U5, P1, P2, P3, P4, P5, P6, P7, P8 | Informe completo con gráficas, trazabilidad KPI → hallazgo → evidencia y los KPIs manuales. |

El informe final (`npm run piloto:analisis`) tiene, en este orden:

1. **Tabla de KPIs** con valor, n, umbral y si cumple (semáforo).
2. **Tiempo hasta desbloqueo (P1):** puntos pareados por estudiante (sin tutor → con tutor), caja por condición y tabla por cohorte (efecto de orden).
3. **Latencia (T1, T2):** caja por canal, tabla por sesión y tabla por servidor de inferencia (GPU de Google Cloud o Mac del laboratorio).
4. **Encuesta (U1, U2, P4):** barras por ítem e histograma SUS.
5. **Uso de intervenciones (P7):** barras por etapa de ayuda.
6. **Trazabilidad KPI → hallazgo → evidencia (A14.7):** una fila por KPI con el archivo de evidencia y una columna de hallazgo para completar.
