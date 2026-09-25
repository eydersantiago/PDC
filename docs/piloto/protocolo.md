# Protocolo del piloto

| | |
|---|---|
| Jira | A13.1 · ADACEEN-109 (protocolo); A13.6 · ADACEEN-114 (ensayo, sección 11) |
| Estado | **Borrador para aprobación del director.** Los campos «[por confirmar]» los decide el equipo con el docente del curso |
| Relacionados | [Instrumentos](instrumentos.md), [consentimiento](consentimiento.md), [lista de cumplimiento](checklist-cumplimiento.md), [plan de soporte](plan-de-soporte.md), [análisis de datos](analisis-de-datos.md), [catálogo de KPIs](../metricas/catalogo-kpis.md), [prerrequisitos](../operacion/prerrequisitos.md) |

## 1. Propósito

El piloto responde la pregunta de investigación del anteproyecto con evidencia
de uso real: si ADACEEN, un agente de aprendizaje contextual integrado al
navegador y al editor, ayuda a estudiantes de programación a salir de los
bloqueos sin entregarles la solución, y cómo lo viven ellos.

Hipótesis operativas, con los umbrales del [catálogo de KPIs](../metricas/catalogo-kpis.md):

| # | Hipótesis | KPI | Umbral |
|---|---|---|---|
| H1 (principal) | Con el tutor, la mediana del tiempo hasta desbloqueo de cada estudiante baja frente a su propio trabajo sin tutor | P1 | reducción ≥ 20 % |
| H2 | Los estudiantes califican bien la experiencia de uso del tutor | U1 | ≥ 4,0 / 5 |
| H3 | Los estudiantes perciben que el tutor apoya su aprendizaje | P4 | ≥ 4,0 / 5 |
| — | El sistema funciona en clase (latencia, fallas, telemetría, participación) | T1, T3, T6, P3 | ≤ 8 s, ≥ 95 %, ≥ 90 %, ≥ 70 % |

## 2. Diseño

**Estudio piloto con diseño intra-sujeto contrabalanceado AB/BA** (cruzado de
dos periodos). Cada estudiante trabaja dos bloques con ejercicios comparables:
uno con el tutor y otro sin él. El orden se contrabalancea:

| Cohorte | Bloque 1 | Bloque 2 |
|---|---|---|
| A | con tutor | sin tutor |
| B | sin tutor | con tutor |

- **Por qué este diseño.** Cada estudiante es su propio control, así que las
  diferencias entre estudiantes (experiencia, ritmo) no se mezclan con el efecto
  del tutor; con unos 30 estudiantes es más sólido que dos grupos de 15. El
  contrabalanceo reparte entre las dos condiciones el efecto de orden
  (aprendizaje o cansancio entre bloques). Decisión del 24 de septiembre de 2026.
- **Asignación.** Aleatoria y balanceada, la hace el sistema al pulsar
  «Asignar grupos A y B» (o `npm run piloto:bloque -- --asignar`) con una
  semilla que queda registrada. Si el docente pulsa «Iniciar bloque 1» sin haber
  asignado, el sistema hace esa misma asignación en ese momento (con 2
  estudiantes activos o más) y la línea de estado muestra la semilla, que se
  anota igual. Un estudiante no cambia de cohorte durante el piloto; los que se
  sumen después van a la cohorte más pequeña.
- **Condición «con tutor».** ADACEEN completo: overlay en el navegador y
  extensión de VS Code con ayudas graduadas según la política del docente.
- **Condición «sin tutor».** La misma herramienta abierta: el estudiante ve un
  aviso («En este bloque del piloto trabajas sin el tutor…») y no recibe
  ayudas ni puede aplicar código del tutor; sus errores, bloqueos y
  desbloqueos se siguen registrando igual. Así la única diferencia entre
  condiciones es la ayuda.
- **Cambio de bloque.** El docente pulsa «Iniciar bloque 1», «Iniciar bloque 2» y
  «Terminar piloto» en la sección «Piloto con y sin tutor» del overlay (o el
  operador con `npm run piloto:bloque`). Cada evento de telemetría de un
  estudiante queda con su bloque, cohorte y condición, y el historial de
  cambios de bloque queda en la base.

**Amenazas a la validez y cómo se atienden**

| Amenaza | Qué se hace |
|---|---|
| Arrastre: lo aprendido con el tutor en el bloque 1 ayuda en el bloque 2 (cohorte A) | Ejercicios distintos pero comparables por bloque; se reporta el efecto de periodo y la reducción por cohorte (análisis del cruzado de Hills y Armitage) |
| Diferente dificultad de los ejercicios | Todos hacen el ejercicio X en el bloque 1 y el Y en el 2: como las cohortes tienen órdenes opuestos, la dificultad se reparte entre condiciones |
| Contaminación: ayuda de compañeros u otros asistentes de IA en el bloque sin tutor | Instrucción explícita al inicio, observación (instrumento 2) y pregunta en la encuesta; se reporta como limitación |
| Efecto Hawthorne (saberse observado) | Afecta a las dos condiciones por igual; se discute en los resultados |
| Fallas técnicas en el bloque con tutor | Criterio de validez de bloque (sección 8) y análisis de sensibilidad |
| Servidores de inferencia distintos entre sesiones o dentro de una sesión (GPU de Google Cloud y Mac del laboratorio) | Todos usan el mismo modelo (`qwen2.5-coder:14b`; el monitor avisa si no). Cada decisión guarda qué servidor la atendió y la latencia se reporta por servidor. Una Mac lenta se enciende solo como respaldo de la GPU ([worker-mac.md](../operacion/worker-mac.md)) |
| Editor distinto entre estudiantes (`vscode.dev` por túnel o VS Code instalado en las Mac del laboratorio) | El mismo tutor y la misma política en los dos. La telemetría guarda el modo (`metadata.editorHost`) para comparar si hace falta; se recomienda un solo modo por sesión |
| Tamaño de muestra pequeño | Con unos 30 pares, la potencia de la prueba de Wilcoxon para un efecto moderado (d ≈ 0,5, α = 0,05 bilateral) es de alrededor de 0,74; llegar a 0,8 pide unos 36 pares, y con un efecto de 0,6 o más pasa de 0,85. Por eso se reporta el tamaño del efecto además del p, y los resultados se leen como evidencia de un piloto |

## 3. Población y participantes

| | |
|---|---|
| Curso | Fundamentos de Programación Orientada a Objetos (FPOO, 750015C), en C++ [por confirmar grupo y semestre] |
| Docente | [por confirmar] |
| Participantes | Estudiantes matriculados que firmen el consentimiento; meta de unos 30 (anteproyecto) |
| Inclusión | Matriculado en el grupo, consentimiento firmado, cuenta de ADACEEN y de GitHub |
| Exclusión | Sin consentimiento (trabaja igual la clase, sin ADACEEN); cuentas del equipo (se excluyen en la limpieza, regla D3) |
| Análisis pareado (P1) | Estudiantes con al menos un episodio de bloqueo resuelto en cada condición |

Los estudiantes sin consentimiento no reciben cuenta en el grupo del piloto:
así no producen datos con condición. Si alguno usa la extensión sin sesión,
sus eventos llegan como cliente anónimo y la limpieza los excluye (regla D2).

## 4. Duración y calendario

| Paso | Cuándo | Duración |
|---|---|---|
| Aprobación del director (protocolo, KPIs, instrumentos, consentimiento) | [por confirmar] | — |
| Ensayo técnico automatizado | Hecho: [ensayo-tecnico-piloto.md](../evidencias/ensayo-tecnico-piloto.md) | — |
| Ensayo con 1 o 2 personas (sección 11) | Al menos una semana antes de la sesión 1 | 1 h 30 min |
| Consentimiento e instalación (15 min de guía) | En la clase anterior a la sesión 1 o al inicio de la sesión 1 | 20 min |
| Sesión 1 | [por confirmar] | 2 h |
| Sesión 2 | Una semana después [por confirmar] | 2 h |
| Encuesta final y entrevistas | Al final de la sesión 2 | 15 min + 10 a 15 min por entrevista |
| Limpieza, análisis e informe | La semana siguiente | — |

Dos sesiones dan más episodios de bloqueo por estudiante y condición, y
medianas más estables. Si solo hay tiempo para una, el diseño se mantiene
(cada sesión tiene sus dos bloques) y se reporta como limitación.

## 5. Actividades del curso

Cada sesión tiene dos ejercicios comparables (X para el bloque 1 y Y para el
bloque 2), preparados con el docente sobre temas ya vistos: clases y objetos,
encapsulamiento, constructores, relaciones de uso, herencia y polimorfismo.

- Cada estudiante trabaja en **su repositorio público de GitHub** con el código
  inicial del ejercicio y lo abre en **VS Code en el navegador** por túnel
  (VM de editores) desde las salas de sistemas.
- Los ejercicios del piloto **no son calificables**, o se califican igual para
  las dos cohortes (ítem crítico C12 de la lista de cumplimiento): el bloque sin
  tutor no puede poner a nadie en desventaja.
- Los ejercicios deben producir errores de compilación y de ejecución
  habituales en el curso (es lo que activa el tutor), sin trampas artificiales.

| Sesión | Bloque 1 (ejercicio X) | Bloque 2 (ejercicio Y) |
|---|---|---|
| 1 | [por confirmar con el docente] | [por confirmar] |
| 2 | [por confirmar] | [por confirmar] |

## 6. Procedimiento de cada sesión

| Minuto | Qué pasa | Quién |
|---|---|---|
| −30 | Lista «Antes de cada sesión» de los [prerrequisitos](../operacion/prerrequisitos.md): servidores de inferencia encendidos y calentados (GPU y, si se usan, Mac del laboratorio con `worker-mac.sh estado`), prueba de humo, VM de editores o VS Code instalado en los equipos de la sala, monitor corriendo | Investigador |
| 0 | Apertura con el guion (abajo) | Docente |
| 5 | Verificar que todos tienen el overlay con sesión y el editor abierto con VS Code conectado a su cuenta: la barra de estado dice «ADACEEN: <nombre>» y no «ADACEEN: sin conectar» | Investigador |
| 10 | **Bloque 1** (40 min): el docente pulsa «Iniciar bloque 1» | Docente |
| 50 | Pausa (10 min) | — |
| 60 | **Bloque 2** (40 min): el docente pulsa «Iniciar bloque 2» | Docente |
| 100 | «Terminar piloto» (bloque 0). En la última sesión: encuesta (10 min) y entrevistas | Docente e investigador |
| 108 | Cierre en los equipos compartidos (ver abajo): cada estudiante sale de su cuenta antes de irse | Estudiantes; lo revisa el observador (C29) |
| 110 | Cierre: guardar el registro del monitor, anotar incidentes (`registro-incidentes-<fecha>.csv`), `npm run piloto:dataset` de la fecha | Investigador |

**Cierre en los equipos compartidos de la sala** (ítem C29 de la
[lista de cumplimiento](checklist-cumplimiento.md)): el siguiente que use el
equipo no debe quedar identificado como el anterior. Cada estudiante, antes de
irse:

1. En el overlay pulsa «Salir» (encabezado). Eso cierra su sesión en el
   servidor **y** desactiva sus sesiones de VS Code, también la del túnel
   (C24); en `vscode.dev` cierra la pestaña.
2. Si trabajó con VS Code instalado (Mac del laboratorio): en VS Code, clic en
   la barra de estado (o `F1` → «ADACEEN: Conectar») y elige «Desconectar este
   equipo», que olvida la sesión guardada en ese equipo. Si la opción no
   aparece, VS Code ya no guarda ninguna sesión emparejada. Después de
   «Desconectar» (o de que el servidor rechace la sesión tras «Salir»), VS Code
   no se vuelve a conectar solo con la cuenta de GitHub hasta que alguien lo
   conecte a mano.
3. Si inició sesión en GitHub en el navegador o en VS Code, la cierra también
   (pantallas de GitHub y de VS Code, textos por verificar en el ensayo): la
   opción «Con mi cuenta de GitHub (recomendado)» de VS Code usa la cuenta de
   GitHub que tenga VS Code, que en un equipo compartido puede ser la del
   estudiante anterior.

El observador lo revisa puesto por puesto y anota en el registro de
incidentes los equipos donde quedó una sesión abierta.

**Guion de apertura** (el docente lo lee o lo dice con sus palabras):

1. Hoy trabajamos dos ejercicios cortos. En uno de los dos bloques tendrán el
   tutor ADACEEN y en el otro no; el orden cambia entre compañeros y lo decide
   el sistema al azar.
2. Participar es voluntario y no afecta la nota: los ejercicios de hoy no se
   califican [o: se califican igual para todos].
3. El tutor es una inteligencia artificial: puede equivocarse y no da la
   solución completa, da pistas.
4. En el bloque sin tutor trabajen como en cualquier clase: pueden preguntarme a
   mí, pero no usen otros asistentes de inteligencia artificial.
5. Si algo falla (el editor, la extensión), levanten la mano: el investigador
   los ayuda.

## 7. Roles

| Rol | Persona | Qué hace |
|---|---|---|
| Docente del curso | [por confirmar] | Conduce la clase, lee el guion, cambia de bloque, responde dudas del curso como siempre |
| Investigador | Eyder Santiago Suárez Chávez | Opera el sistema (prerrequisitos, monitor, soporte técnico), registra incidentes, aplica encuesta y entrevistas |
| Observador | [por confirmar; puede ser el investigador si no hay otra persona] | Llena el registro de observación (instrumento 2) |
| Director | Víctor Andrés Bucheli Guerrero, PhD | Aprueba el protocolo y los instrumentos; revisa los resultados |

## 8. Datos que se recogen

| Dato | Cómo | Identificación | Instrumento |
|---|---|---|---|
| Telemetría de uso (errores, bloqueos, desbloqueos, ayudas, aplicaciones de código, valoraciones) | Automática (`telemetry_events`) | Seudónimo (HMAC con sal secreta); sin código, texto de errores, rutas ni correos | [Diccionario](../telemetria/diccionario-eventos.md) |
| Encuesta final (SUS, UX, percepción, comparación, abiertas) | Formulario anónimo, sin correo | Anónima | Instrumento 1 |
| Observación de la sesión | Registro por bloque, a nivel de grupo | Sin nombres | Instrumento 2 |
| Entrevistas (voluntarias) | Notas; audio solo con permiso aparte | Código de entrevista, sin nombre en las notas | Instrumento 3 |
| Asistencia | Conteo de presentes por sesión | Sin nombres en el plan del piloto | Plan del piloto |
| Incidentes técnicos | Registro del plan de soporte | Sin nombres | Plan de soporte |
| Consentimientos | Formato firmado | Nominal; se guarda aparte y no entra al análisis | Consentimiento |

**Criterio de validez de un bloque.** Si en un bloque con tutor el tutor
estuvo caído o degradado más de 10 minutos (lo dice el registro del monitor),
el bloque se marca como degradado: entra en el análisis principal y se repite
el análisis sin ese bloque (sensibilidad). Si la clase no pudo trabajar
(incidente de severidad 1), la sesión se repite.

## 9. Análisis

El detalle operativo está en [análisis de datos](analisis-de-datos.md); los
KPIs y umbrales, en el [catálogo](../metricas/catalogo-kpis.md).

- **H1 (P1).** Para cada estudiante, mediana de la duración de sus episodios de
  bloqueo resueltos en cada condición. Reducción = 1 − (mediana de las medianas
  con tutor / mediana de las medianas sin tutor). Prueba de rangos con signo de
  Wilcoxon sobre los pares (exacta hasta 30 pares sin empates) y correlación
  biserial de rangos como tamaño del efecto. Complementos: análisis del cruzado
  AB/BA (efecto del tutor y efecto de periodo con Mann-Whitney entre cohortes),
  reducción por cohorte, sensibilidad sin los episodios corregidos desde otro
  archivo y tasa de episodios resueltos por condición (P2).
- **H2 y H3 (U1, P4).** Promedio por persona y luego del grupo; distribución por
  ítem; SUS (U2) como referencia estándar.
- **KPIs técnicos.** Latencia p50 y p95 por canal y por servidor de inferencia,
  respuestas sin fallo, pérdida de eventos, sesiones con telemetría, anclaje en
  el material.
- **Cualitativo.** Respuestas abiertas, entrevistas y observación: codificación
  temática (categorías que emergen, con ejemplos), para explicar los números y
  proponer mejoras (A14.5, P5).
- **Decisión.** Cada KPI se juzga contra el umbral aprobado antes del piloto;
  para P1 se reportan la magnitud y la significancia por separado. Los
  resultados se interpretan como evidencia de un piloto, no como prueba
  general de eficacia.

## 10. Ética, privacidad y riesgos

- Riesgo mínimo: la actividad es la de una clase normal; el riesgo es el
  tiempo invertido y cierta frustración en el bloque sin tutor, igual que en
  cualquier clase.
- Consentimiento informado antes de la primera sesión; retiro en cualquier
  momento sin consecuencias (`npm run piloto:retiro` borra sus datos).
- Datos seudonimizados, acceso restringido, retención definida. Ver la
  [lista de cumplimiento](checklist-cumplimiento.md): el piloto no empieza sin
  sus ítems críticos cumplidos y con al menos el 80 % del total.
- Contingencias técnicas: [plan de contingencia](../operacion/contingencia.md) y
  [plan de soporte](plan-de-soporte.md).

## 11. Ensayo antes del piloto (A13.6)

**Ensayo técnico automatizado (hecho).** `npm run piloto:simular` recorre un
piloto completo con estudiantes sintéticos por la API real (cohortes, bloques,
bloqueos, ayudas, limpieza y análisis): [evidencia](../evidencias/ensayo-tecnico-piloto.md).

**Ensayo con 1 o 2 personas (pendiente).** Con personas que no conozcan el
proyecto, en una sala de sistemas, con el procedimiento completo acortado
(bloques de 15 minutos):

| Qué se prueba | Criterio de éxito |
|---|---|
| Instalación con la guía | Cada persona queda lista en 15 minutos o menos (T10) |
| Entorno por túnel desde la sala | «Preparar mi editor» llega a la VM (relay), `vscode.dev` abre el editor y la barra de VS Code dice «ADACEEN: <nombre>» sin pegar nada |
| Cambio de bloque | El aviso del bloque sin tutor aparece y desaparece al cambiar |
| Telemetría | El monitor muestra a las personas activas con su condición; `piloto:dataset` las encuentra sin reglas D2 |
| Instrumentos | Las personas entienden la encuesta y el guion; se anota lo confuso |
| Simulacro de contingencia | Casos 1, 2, 8 y 9 del [plan de contingencia](../operacion/contingencia.md), cronometrados con `npm run piloto:simulacro` (escenarios `gpu` y `editor`) |
| Cierre en equipos compartidos | Cada persona sale con «Salir» y, en VS Code instalado, «Desconectar este equipo»; el siguiente que abre el equipo no queda con su cuenta |

Lo que falle se corrige antes de la sesión 1 y se anota en el protocolo.

## 12. Decisiones pendientes

| Decisión | Quién | Estado |
|---|---|---|
| Curso, grupo, docente y fechas | Equipo y docente | [por confirmar] |
| Ejercicios de cada bloque | Docente | [por confirmar] |
| Una o dos sesiones | Equipo y docente | Propuesta: dos |
| Calificación de las actividades del piloto (C12) | Docente | [por confirmar] |
| ¿Hace falta comité de ética de la Facultad? | Director | [por confirmar] |
| Aprobación de umbrales propuestos (A3.5) | Director | Ver el [paquete de validación](validacion-director.md) |
