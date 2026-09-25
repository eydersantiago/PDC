# Instrumentos de evaluación del piloto

| | |
|---|---|
| Jira | A13.2 · ADACEEN-110 |
| Estado | **Borrador para aprobación del director** |
| Relacionados | [Protocolo](protocolo.md), [catálogo de KPIs](../metricas/catalogo-kpis.md) (U1, U2, U5, P4), [análisis de datos](analisis-de-datos.md) |

Son tres instrumentos, más dos registros de apoyo:

| # | Instrumento | Cuándo | Quién | Alimenta |
|---|---|---|---|---|
| 1 | Encuesta final | Al terminar la última sesión (10 min) | Todos los participantes | U1, U2, U5, P4 y lo cualitativo |
| 2 | Registro de observación | Durante cada bloque | Observador | Contexto de los resultados y amenazas a la validez |
| 3 | Guía de entrevista | Después de la última sesión | 5 o 6 estudiantes voluntarios de las dos cohortes y el docente | Hallazgos (A14.5) y mejoras |
| — | Hoja de tiempos de instalación | Validación de la guía | Investigador | T10 |
| — | Registro de incidentes | Durante cada sesión | Investigador | T7 |

Las plantillas en CSV están en `data/piloto/plantillas/` (`encuesta-codigos.csv`,
`tiempos-instalacion.csv`, `registro-incidentes.csv`).

## 1. Encuesta final

**Formato.** Microsoft Forms o Google Forms, **anónimo**: no pide nombre ni
correo y no guarda el correo de quien responde. Cada pregunta empieza con su
código (por ejemplo «UX3. Fue fácil pedirle ayuda…»): así la exportación del
formulario se lee directamente con `npm run piloto:analisis -- --encuesta=<archivo>`.
Las escalas van de 1 a 5: 1 totalmente en desacuerdo, 2 en desacuerdo, 3 ni de
acuerdo ni en desacuerdo, 4 de acuerdo, 5 totalmente de acuerdo.

**Texto de inicio.** «Esta encuesta es anónima y toma unos 10 minutos. Tus
respuestas nos ayudan a mejorar ADACEEN y no afectan tu nota. "El tutor" es la
ayuda de ADACEEN en VS Code y en el navegador; "el sistema" es ADACEEN
completo (extensión, editor y tutor).»

### Sección A. Usabilidad del sistema (SUS)

Escala de usabilidad de sistemas (SUS; Brooke, 1996), adaptada al español.
Puntaje de 0 a 100: ítems impares, valor − 1; ítems pares, 5 − valor; suma × 2,5.

| Código | Ítem |
|---|---|
| SUS1 | Creo que me gustaría usar este sistema con frecuencia. |
| SUS2 | Encontré el sistema innecesariamente complejo. |
| SUS3 | Pensé que el sistema era fácil de usar. |
| SUS4 | Creo que necesitaría el apoyo de una persona experta para poder usar este sistema. |
| SUS5 | Encontré que las distintas funciones del sistema estaban bien integradas. |
| SUS6 | Pensé que había demasiada inconsistencia en el sistema. |
| SUS7 | Imagino que la mayoría de las personas aprendería a usar este sistema muy rápido. |
| SUS8 | Encontré el sistema muy engorroso de usar. |
| SUS9 | Me sentí con mucha confianza al usar el sistema. |
| SUS10 | Necesité aprender muchas cosas antes de poder empezar a usar este sistema. |

### Sección B. Experiencia con el tutor (U1)

| Código | Ítem |
|---|---|
| UX1 | Las ayudas del tutor fueron claras y fáciles de entender. |
| UX2 | El tutor apareció en momentos oportunos, sin interrumpir mi trabajo. |
| UX3 | Fue fácil pedirle ayuda al tutor (en VS Code o en el navegador). |
| UX4 | Las ayudas se ajustaban a mi código y a mi error. |
| UX5 | El tutor respondió lo suficientemente rápido. |
| UX6 | Volvería a usar el tutor en otras actividades del curso. |

### Sección C. Apoyo al aprendizaje (P4)

| Código | Ítem |
|---|---|
| PA1 | El tutor me ayudó a entender la causa de mis errores. |
| PA2 | El tutor me orientó sin darme la solución completa. |
| PA3 | Con el tutor avancé más rápido cuando me quedé atascado. |
| PA4 | Aprendí algo que puedo aplicar en otros ejercicios. |
| PA5 | Las referencias al material del curso que dio el tutor me fueron útiles. |

### Sección D. Comparación de los bloques

| Código | Pregunta | Opciones |
|---|---|---|
| CMP1 | ¿En qué bloque sentiste que resolviste mejor tus errores? | Con tutor · Sin tutor · Igual |
| CMP2 | ¿Con cuál preferirías trabajar en el curso? | Con tutor · Sin tutor · Me da igual |

### Sección E. Preguntas abiertas

| Código | Pregunta |
|---|---|
| AB1 | ¿Qué fue lo más útil del tutor? |
| AB2 | ¿Qué mejorarías? |
| AB3 | ¿Hubo algún momento en que el tutor te estorbó o te confundió? Cuéntalo. |

### Sección F. Datos generales (opcionales)

| Pregunta | Opciones |
|---|---|
| Semestre | 1 · 2 · 3 · 4 o más |
| Experiencia previa programando | Menos de 1 año · 1 a 2 años · Más de 2 años |
| Uso previo de asistentes de IA para programar | Nunca · A veces · Con frecuencia |
| En el bloque sin tutor, ¿usaste otra ayuda de IA? | No · Sí, una vez · Sí, varias veces |

La última pregunta mide la contaminación del bloque sin tutor (amenaza a la
validez); se reporta, no se usa para excluir a nadie.

**Validez.** Una persona cuenta para U1 si respondió al menos 4 de los 6 ítems
UX; para P4, al menos 3 de 5; para SUS, los 10 ítems.

## 2. Registro de observación

Un registro por bloque. El observador anota a nivel de grupo (sin nombres) y
marca la hora de cualquier hecho relevante. Como las dos cohortes trabajan a la
vez, lo que se observa describe la sesión, no a una condición.

**Encabezado:** fecha · sesión · bloque · hora de inicio y fin · presentes ·
observador.

| # | Indicador | 0 | 1 | 2 | 3 |
|---|---|---|---|---|---|
| O1 | Autonomía ante el error: intentan antes de pedir ayuda | No se observa | Pocos | La mitad | Casi todos |
| O2 | Uso del tutor como guía: leen la pista y la aplican con sus palabras | No se observa | Pocos | La mitad | Casi todos |
| O3 | Búsqueda de la solución completa (copiar, insistir para que el tutor la dé) | No se observa | Pocos | La mitad | Casi todos |
| O4 | Consultas al docente | Ninguna | 1 a 3 | 4 a 8 | Más de 8 |
| O5 | Frustración visible (quejas, abandono del ejercicio) | No se observa | Pocos | La mitad | Casi todos |
| O6 | Problemas técnicos (editor, extensión, red) | Ninguno | Uno aislado | Varios | Afecta al grupo |
| O7 | Uso de otras ayudas (compañeros, otros asistentes de IA) | No se observa | Pocos | La mitad | Casi todos |

**Notas de campo** (cada 10 minutos o cuando pase algo): hora · qué pasó ·
cuántos estudiantes · cita textual si la hay (sin nombre).

## 3. Guía de entrevista

Semiestructurada, 10 a 15 minutos, al final de la última sesión. Se toman
notas con un código de entrevista (E1, E2…), sin nombre; audio solo si la
persona lo autoriza por separado.

### 3.1 Estudiantes (5 o 6 voluntarios de las dos cohortes)

1. Cuéntame de un momento en que te quedaste atascado hoy. ¿Qué hiciste para salir?
2. En ese momento, ¿el tutor te ayudó? ¿Qué te dijo y qué hiciste con eso?
3. ¿Cómo fue trabajar el bloque sin tutor? ¿Qué cambió para ti?
4. ¿Alguna vez el tutor te dio demasiado o muy poco? ¿Cómo te diste cuenta?
5. ¿Confiaste en lo que decía el tutor? ¿Lo comprobaste de alguna forma?
6. ¿Sientes que aprendiste algo que puedes aplicar en otro ejercicio? ¿Qué?
7. ¿Qué te molestó o te confundió de la herramienta (overlay, VS Code, instalación)?
8. Si pudieras cambiar una cosa del tutor, ¿cuál sería?

### 3.2 Docente

1. ¿Cómo vio a los estudiantes trabajar con y sin el tutor?
2. ¿Las ayudas respetaron lo que usted configuró (nivel de ayuda, límites, sin solución completa)?
3. ¿El tutor le quitó o le sumó trabajo durante la clase?
4. ¿Hubo ayudas que le parecieran pedagógicamente inadecuadas? ¿Cuáles y por qué?
5. ¿Qué le preocupa del uso de un tutor así en el curso (dependencia, evaluación, ética)?
6. ¿Qué ajustaría en la política, las plantillas o el banco de preguntas?
7. ¿Lo usaría en el curso el próximo semestre? ¿En qué condiciones?

## 4. Hoja de tiempos de instalación (T10)

En la validación de la guía (A16.8), con al menos 3 personas que no conozcan el
proyecto, se llena una fila por persona y camino en una copia de
`data/piloto/plantillas/tiempos-instalacion.csv`. El cronómetro va desde que la
persona abre `<backend>/empezar` hasta que la barra de estado de VS Code muestra
«ADACEEN: <nombre>», es decir, VS Code conectado con su cuenta (el mismo fin
que la [guía de instalación y uso](../guia-instalacion-uso.md), sección 6, y
que V10 de la [validación del director](validacion-director.md)). No depende de
que el servidor del modelo esté encendido.

| Columna | Qué se anota |
|---|---|
| `persona` | Un código (V1, V2…), sin nombre |
| `rol` | Estudiante, docente… |
| `fecha` | `AAAA-MM-DD` |
| `camino` | `tunel` (editor en la nube, `vscode.dev`) o `mac` (VS Code instalado en una Mac del laboratorio). Vacío cuenta como `tunel` |
| `navegador`, `sistema_operativo` | Los del equipo |
| `inicio` | Hora (`HH:MM`) al abrir `<backend>/empezar` |
| `overlay_con_sesion` | Hora en que el overlay muestra su nombre (sesión iniciada) |
| `editor_listo` | Hora en que la barra de VS Code muestra «ADACEEN: <nombre>»: fin de la medición |
| `minutos_totales` | De `inicio` a `editor_listo`. Si se deja vacío, el análisis lo calcula con esas dos horas; si los dos difieren en más de 2 minutos, gana `minutos_totales` y el análisis lo avisa |
| `ayuda_recibida` | `si` o `no`: si otra persona intervino |
| `observaciones` | Paso más lento, errores, casillas de *Cómo sé que quedó bien* que fallaron |

El KPI T10 es la mediana de los minutos del camino por túnel (umbral ≤ 15); la
Mac se informa aparte. `npm run piloto:analisis -- --registros=<carpeta>` lee
las copias (`tiempos-instalacion*.csv`); para el camino que no traigan usa la
hoja de la [prueba de inicio a fin](prueba-inicio-a-fin.md)
([análisis de datos](analisis-de-datos.md), sección 3.1).
