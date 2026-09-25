# Paquete de validación para el director y el docente

| | |
|---|---|
| Jira | A5.7 · ADACEEN-61 (validación final y aprobación). Reúne las aprobaciones de A9.6, A3.5, A13.1 a A13.5, A10.6, A8.7 y A16.8 |
| Estado | **Para firmar antes de la primera sesión del piloto** |
| Evidencia | Este documento firmado, o un correo del director que lo apruebe, cumple el ítem C14 de la [lista de cumplimiento](checklist-cumplimiento.md) |
| Relacionados | [Protocolo](protocolo.md), [instrumentos](instrumentos.md), [consentimiento](consentimiento.md), [lista de cumplimiento](checklist-cumplimiento.md), [plan de soporte](plan-de-soporte.md), [catálogo de KPIs](../metricas/catalogo-kpis.md), [ADR-001](../arquitectura/adr-001-motor-y-arquitectura.md) |

Cada ítem dice qué se aprueba, dónde está el detalle y qué hay que decidir. El
revisor marca una decisión y anota los cambios. Si pide cambios, el
investigador los hace, actualiza el documento y anota aquí la fecha. Lo
aprobado queda fijo durante el piloto: los umbrales, los instrumentos y las
plantillas no cambian entre sesiones.

## Resumen

| # | Qué se aprueba | Documento | Jira | Revisa |
|---|---|---|---|---|
| V1 | Motor de políticas y cambio de arquitectura | ADR-001 | A9.6 | Director |
| V2 | KPIs, umbrales y línea base | Catálogo de KPIs | A3.1 a A3.6 | Director |
| V3 | Diseño y protocolo del piloto | Protocolo | A13.1, A13.6 | Director y docente |
| V4 | Instrumentos de evaluación | Instrumentos | A13.2 | Director |
| V5 | Consentimiento y logística | Consentimiento | A13.3 | Director (y comité de ética, si aplica) |
| V6 | Lista de cumplimiento y plan de soporte | Lista de cumplimiento, plan de soporte | A13.4, A13.5 | Director |
| V7 | Navegadores permitidos en el piloto | Guía de instalación, sección 1.1 | A16.8 | Director y docente |
| V8 | Plantillas de intervención (calidad pedagógica) | Plantillas de intervención | A10.6 | Docente |
| V9 | Banco de preguntas del mini-quiz | Revisión del banco | A8.7 | Docente |
| V10 | Guía de instalación y uso (15 minutos o menos) | Guía de instalación y uso | A16.8 | Docente o director |

## V1. ADR-001: motor de políticas y arquitectura (A9.6)

Documento: `docs/arquitectura/adr-001-motor-y-arquitectura.md`, con la [ruta de datos](../arquitectura/ruta-de-datos.md).

Se aprueban tres decisiones y el registro de lo que cambió frente al
anteproyecto (secciones 7.2 y 8.2):

1. **Motor de políticas del docente.** La política del docente decide cada
   ayuda (etapa, límite de código, intervenciones habilitadas, resultado de
   aprendizaje) antes de llamar al modelo, y los límites se vuelven a aplicar
   sobre la respuesta.
2. **Backend en Azure e inferencia en Google Cloud por cola.** El backend
   completo (API, base de datos, políticas, material del curso, telemetría)
   corre en Azure App Service con PostgreSQL. El modelo (Ollama con
   `qwen2.5-coder:14b`) corre en una VM con GPU de Google Cloud (V100 bajo
   demanda; A100 y L4 Spot de respaldo) que toma las peticiones de Azure
   Service Bus. La inferencia no está en el laboratorio GUÍA, como decía el
   anteproyecto.
3. **Entorno del estudiante con VS Code Tunnels.** Una VM de editores en Google
   Cloud, sin IP pública, con la extensión ADACEEN; el backend le pasa las
   peticiones por un relay por HTTPS de salida.

| Decisión | ☐ Aprobado | ☐ Aprobado con cambios | ☐ No aprobado |
|---|---|---|---|
| Cambios o comentarios | | | |

## V2. KPIs, umbrales y línea base (A3.1 a A3.6)

Documento: `docs/metricas/catalogo-kpis.md` (25 KPIs; los principales son T1, U1 y P1).

**Umbrales que no están en el anteproyecto** (propuestos por el catálogo):

| KPI | Propuesta | Aprobado | Cambio |
|---|---|---|---|
| T2. Latencia del tutor, p95 | ≤ 15 s | ☐ | |
| T3. Respuestas del tutor sin fallo | ≥ 95 % | ☐ | |
| T4. Pérdida de eventos | ≤ 2 % | ☐ | |
| T5. Eventos duplicados | ≤ 1 % | ☐ | |
| U2. Usabilidad (SUS) | ≥ 68 | ☐ | |

**Contradicciones del anteproyecto.** Se propone que mande la sección 5.4,
que es la tabla de KPIs:

| KPI | En conflicto | Propuesta | Aprobado |
|---|---|---|---|
| T1. Latencia del tutor, mediana | ≤ 8 s (5.4) frente a ≤ 10 s (A9) | ≤ 8 s | ☐ |
| P5. Mejoras críticas implementadas | ≥ 65 % (5.4) frente a ≥ 70 % (A13) | ≥ 65 % | ☐ |

**Línea base de P1** (tiempo hasta desbloqueo, −20 %): el mismo estudiante sin
tutor, con el diseño intra-sujeto AB/BA de V3. Se reportan por separado la
magnitud (reducción de la mediana de las medianas) y la significancia
(Wilcoxon de rangos con signo, con la correlación biserial de rangos como
tamaño del efecto). ☐ Aprobado

**Reporte (A3.6):** una línea del monitor cada 30 s en la sesión, un informe
corto al cerrar cada sesión y el informe completo al final, con tablas,
gráficas y trazabilidad KPI → hallazgo → evidencia. ☐ Aprobado

| Decisión | ☐ Aprobado | ☐ Aprobado con cambios | ☐ No aprobado |
|---|---|---|---|
| Cambios o comentarios | | | |

## V3. Diseño y protocolo del piloto (A13.1, A13.6)

Documento: `docs/piloto/protocolo.md`.

- Diseño intra-sujeto contrabalanceado AB/BA: cada estudiante trabaja un bloque
  con tutor y otro sin tutor. El sistema asigna las cohortes al azar y en partes
  iguales.
- Dos sesiones de 2 horas, cada una con dos bloques de 40 minutos y ejercicios
  comparables. Si solo hay tiempo para una, el diseño se mantiene y se reporta
  como limitación.
- Criterio de validez: un bloque con tutor que estuvo caído o degradado más de
  10 minutos entra en el análisis y se repite el análisis sin él. Si la clase no
  pudo trabajar (severidad 1), la sesión se repite.
- Ensayo técnico automatizado hecho
  ([evidencia](../evidencias/ensayo-tecnico-piloto.md)). Falta el ensayo con 1
  o 2 personas, al menos una semana antes de la sesión 1.

**Lo que decide el docente con el equipo:**

| Decisión | Respuesta |
|---|---|
| Curso, grupo y semestre | |
| Docente del curso | |
| Fechas de la sesión 1 y la sesión 2 | |
| Ejercicios X e Y de cada sesión | |
| ¿Una o dos sesiones? (propuesta: dos) | |
| ¿Las actividades del piloto se califican? Si se califican, igual para las dos cohortes (C12) | |
| Observador de las sesiones | |
| Fecha del ensayo con 1 o 2 personas | |

| Decisión | ☐ Aprobado | ☐ Aprobado con cambios | ☐ No aprobado |
|---|---|---|---|
| Cambios o comentarios | | | |

## V4. Instrumentos de evaluación (A13.2)

Documento: `docs/piloto/instrumentos.md`.

- **Encuesta final, anónima:** SUS (10 ítems), experiencia con el tutor (UX1 a
  UX6), apoyo al aprendizaje (PA1 a PA5), comparación de bloques (CMP1, CMP2),
  tres preguntas abiertas y datos generales opcionales. Escala de 1 a 5.
- **Registro de observación** por bloque, a nivel de grupo y sin nombres
  (O1 a O7).
- **Guía de entrevista** semiestructurada: 8 preguntas para estudiantes y 7
  para el docente.
- Reglas de validez: U1 con al menos 4 de los 6 ítems UX; P4 con al menos 3 de
  5; SUS con los 10.

| Decisión | ☐ Aprobado | ☐ Aprobado con cambios | ☐ No aprobado |
|---|---|---|---|
| Cambios o comentarios | | | |

## V5. Consentimiento y logística (A13.3)

Documento: `docs/piloto/consentimiento.md`.

- Tres partes: consentimiento para mayores de edad; asentimiento y
  autorización del acudiente para menores de 18 años; logística de
  recolección, almacenamiento y retiro.
- El formato informa qué se registra (eventos de uso seudonimizados, sin código
  ni texto de errores), qué se envía para responder (archivo abierto, error y
  pregunta, al servidor en Azure y al modelo en Google Cloud) y cómo retirarse
  (datos borrados en 5 días hábiles con `npm run piloto:retiro`).

**Lo que falta completar:**

| Campo | Propuesta | Respuesta |
|---|---|---|
| Correos del investigador y del director | Correos institucionales | |
| Retención de la telemetría | 365 días | |
| Conservación de los formatos firmados | Un año después de la sustentación | |
| Lugar de los formatos en papel | Oficina o laboratorio con llave | |
| ¿Hace falta aval del comité de ética de la Facultad? | Riesgo mínimo (Resolución 8430 de 1993) | ☐ Sí ☐ No |

| Decisión | ☐ Aprobado | ☐ Aprobado con cambios | ☐ No aprobado |
|---|---|---|---|
| Cambios o comentarios | | | |

## V6. Lista de cumplimiento y plan de soporte (A13.4, A13.5)

Documentos: `docs/piloto/checklist-cumplimiento.md` y `docs/piloto/plan-de-soporte.md`.

- 23 ítems de privacidad, ética y seguridad; 7 son críticos (C01, C02, C03,
  C11, C12, C17 y C20). Regla: el piloto no empieza sin todos los críticos y con
  menos del 80 % del total (KPI T11). `npm run piloto:verificar` revisa los
  automáticos contra el backend de producción.
- Plan de soporte: roles, severidades S1 a S4 con tiempos de respuesta
  (inmediata a 5 minutos para S1 y S2), flujo de incidentes, mensajes para los
  estudiantes y registro de incidentes (KPI T7).

| Decisión | ☐ Aprobado | ☐ Aprobado con cambios | ☐ No aprobado |
|---|---|---|---|
| Cambios o comentarios | | | |

## V7. Navegadores permitidos en el piloto

La extensión funciona en Chrome, Edge, Brave y Firefox 128 o superior. En
Firefox se carga como complemento temporal (hay que cargarla de nuevo al
abrir el navegador) y no tiene «Continuar con Google» ni Google Calendar: se
entra con correo y contraseña.

| Opción | Marque una |
|---|---|
| Solo Chrome en las salas del piloto (recomendado: es lo que se probó más) | ☐ |
| Chrome, Edge o Brave | ☐ |
| Cualquiera de los cuatro, con las limitaciones de Firefox | ☐ |

Observaciones: ______________________________________________

## V8. Plantillas de intervención: revisión del docente (A10.6)

Documento: `docs/tutor/plantillas-intervencion.md`. Con ejemplos reales: la
[evidencia de los escenarios S1 a S5](../evidencias/demo-escenarios.md) y, con
la GPU encendida, `npm run demo:escenarios` contra producción o una prueba
en vivo durante el ensayo.

Califique cada plantilla de 1 (no cumple) a 4 (cumple del todo) en cuatro
criterios: **(a)** es clara y del nivel del curso; **(b)** orienta sin dar la
solución; **(c)** remite al material del curso cuando aplica; **(d)** el tono
es respetuoso y motiva a seguir intentando.

| Plantilla | Límite de código (overlay / editor) | (a) | (b) | (c) | (d) | Cambios que pide |
|---|---|---|---|---|---|---|
| Pista nivel 1 | 0 / 5 líneas | | | | | |
| Pista nivel 2 | 2 / 10 líneas | | | | | |
| Ejemplo parcial (otro dominio, con TODO) | 8 / máximo del docente (20) | | | | | |
| Explicación breve | 4 / 4 líneas | | | | | |
| Mini-quiz | 6 / 6 líneas | | | | | |
| Mensaje controlado (falta contexto, fuera del curso) | 0 / 0 | | | | | |
| Aviso del bloque sin tutor (piloto) | 0 / 0 | | | | | |

**Política del piloto.** El tutor se probó con la política «RF-05 base del
piloto»: ayuda progresiva (pista 1 → pista 2 → ejemplo parcial), 3 pistas por
ejercicio, sin solución completa y aplicar código desde VS Code hasta 20 líneas
con confirmación del estudiante. ¿Son los valores que usted quiere para la
clase? (Se cambian en Configuración del overlay.)
☐ Sí ☐ Con cambios: ______________________________________________

**Cómo se hacen los ajustes (cierre de A10.6).** Cada cambio pedido se hace en
`src/services/intervention-templates.ts` (o en la política, desde el overlay),
se corren las pruebas de escenarios y de casos negativos, se actualiza
`plantillas-intervencion.md` y se anota en las notas de versión con la fecha
de esta revisión. Los cambios se hacen antes de la sesión 1; durante el piloto
las plantillas no cambian.

| Decisión | ☐ Aprobado | ☐ Aprobado con cambios | ☐ No aprobado |
|---|---|---|---|
| Cambios o comentarios | | | |

## V9. Banco de preguntas del mini-quiz (A8.7)

Documento: `docs/tutor/revision-banco-quiz.md` (17 preguntas, versión 1.0).
El docente marca cada pregunta como aprobada, aprobada con cambios o
descartada. Con los cambios, el investigador edita `data/quiz/banco-fpoo.json`,
sube la versión del banco, corre las pruebas y regenera la hoja con
`npm run quiz:revision` (proceso completo en [banco-quiz.md](../tutor/banco-quiz.md)).

| Resultado | Número |
|---|---|
| Aprobadas | |
| Aprobadas con cambios | |
| Descartadas | |

| Decisión | ☐ Banco aprobado | ☐ Aprobado cuando se hagan los cambios | ☐ No aprobado |
|---|---|---|---|
| Cambios o comentarios | | | |

## V10. Guía de instalación y uso (A16.8)

Documento: `docs/guia-instalacion-uso.md`. Con al menos 3 personas que no
conozcan el proyecto se mide el tiempo de instalación siguiendo solo la guía
(hoja de tiempos del [instrumento](instrumentos.md), sección 4). El KPI T10 es
la mediana de los minutos (umbral ≤ 15).

| Persona (rol) | Navegador y sistema | Minutos | ¿15 o menos? | Paso más lento o confuso |
|---|---|---|---|---|
| | | | | |
| | | | | |
| | | | | |

Mediana: ______ minutos.

| Decisión | ☐ Guía aprobada | ☐ Aprobada con cambios | ☐ No aprobada |
|---|---|---|---|
| Cambios o comentarios | | | |

## Registro de la aprobación

| Ítem | Decisión | Fecha | Quién | Evidencia (acta, correo) |
|---|---|---|---|---|
| V1 | | | | |
| V2 | | | | |
| V3 | | | | |
| V4 | | | | |
| V5 | | | | |
| V6 | | | | |
| V7 | | | | |
| V8 | | | | |
| V9 | | | | |
| V10 | | | | |

Director: Víctor Andrés Bucheli Guerrero, PhD

Firma: ______________________________ Fecha: ______________

Docente del curso: ______________________________

Firma: ______________________________ Fecha: ______________

Investigador: Eyder Santiago Suárez Chávez

Firma: ______________________________ Fecha: ______________
