# Guion de la sustentación

| | |
|---|---|
| Jira | A16.5 · ADACEEN-133 (diapositivas de 30 minutos o menos y guion). Apoya a A16.2 · ADACEEN-130 (metodología, arquitectura e implementación), A16.6 · ADACEEN-134 (banco de preguntas) y A16.7 · ADACEEN-135 (ensayo y lista de entrega) |
| Estado | **Borrador.** Los resultados del piloto todavía no existen: van como `[RESULTADO PENDIENTE: …]`. Si el piloto no alcanza a hacerse, se usa el [plan B](#plan-b-si-el-piloto-no-alcanza) |
| Duración | 22 diapositivas en **25 min 40 s**, con **4 min 20 s de margen** para llegar a 30 min |
| Texto de las diapositivas | [diapositivas.md](diapositivas.md): texto final, notas del orador y figuras |
| Cifras | [cifras-documento.md](../evidencias/cifras-documento.md), generado con `npx tsx scripts/cifras-documento.ts` |
| Relacionados | [ADR-001](../arquitectura/adr-001-motor-y-arquitectura.md), [vistas](../arquitectura/vistas.md), [protocolo del piloto](../piloto/protocolo.md), [catálogo de KPIs](../metricas/catalogo-kpis.md), [análisis de datos](../piloto/analisis-de-datos.md), [prueba de inicio a fin](../piloto/prueba-inicio-a-fin.md), [contingencia](../operacion/contingencia.md) |
| Prueba | `tests/scripts/cifras-documento.test.ts` comprueba que cada texto entre comillas angulares, ruta y enlace de este guion existe |

## Cómo leer este guion

- Cada diapositiva tiene mensaje clave, contenido visual, qué decir y minutos. **Reloj**
  es el tiempo acumulado al terminarla: en el ensayo dice si vas adelantado o atrasado.
- **Qué decir** está escrito para decirlo en voz alta, en primera persona, entre
  comillas “así”. No hay que leerlo: son las ideas y el orden.
- Los textos entre comillas angulares son los de la interfaz o de la salida de un
  comando, copiados del código (algunos van sin tilde porque así están en el código).
  `<nombre>` es una parte que cambia, y los puntos suspensivos, un recorte.
- Marcadores:
  - `[RESULTADO PENDIENTE: …]`: valor que sale del análisis del piloto
    (`npm run piloto:analisis`). La [tabla del final](#marcadores-pendientes) dice de
    qué archivo sale cada uno.
  - `[por verificar: …]`: dato que no está en el repositorio o que decide una persona
    (título exacto, texto literal de los objetivos, citas del marco teórico, fechas,
    grupo del piloto, aprobación del ADR). Se completa con el anteproyecto, el
    documento final o el director; si no se puede confirmar, se quita.
  - † en una cifra: sale de `docs/evidencias/cifras-documento.md`. El día anterior se
    regeneran primero las evidencias que hayan cambiado y después ese archivo
    (`npx tsx scripts/cifras-documento.ts`), y se actualizan las cifras que cambien
    (ver [antes de la sustentación](#antes-de-la-sustentación)).
  - No hay otros marcadores: buscar `[RESULTADO PENDIENTE` y `[por verificar` basta
    para encontrar todo lo que falta. La prueba lo comprueba.
- El reglamento (Resolución 137 de 2023 de la Facultad de Ingeniería, anotado en
  ADACEEN-129) pide sustentación pública (Art. 21). El límite de 30 minutos sale del
  título de A16.5. [por verificar: tiempo que fija el jurado o el Comité de Programa y
  si incluye las preguntas].

## Tiempos

| # | Diapositiva | Parte | Tiempo | Reloj |
|---|---|---|---|---|
| 1 | Portada | Apertura | 0:20 | 0:20 |
| 2 | Agenda | Apertura | 0:20 | 0:40 |
| 3 | El problema | Problema | 2:00 | 2:40 |
| 4 | Pregunta de investigación e hipótesis | Problema | 1:00 | 3:40 |
| 5 | Objetivos | Objetivos | 1:15 | 4:55 |
| 6 | Marco de referencia | Marco | 1:30 | 6:25 |
| 7 | Metodología: CRISP-DM | Metodología | 1:30 | 7:55 |
| 8 | Qué hace y qué no hace el tutor | Arquitectura | 1:15 | 9:10 |
| 9 | Arquitectura (C4, contenedores) | Arquitectura | 1:45 | 10:55 |
| 10 | Decisiones frente al anteproyecto (ADR-001) | Arquitectura | 1:15 | 12:10 |
| 11 | Motor de políticas y trazabilidad | Arquitectura | 1:15 | 13:25 |
| 12 | Demostración | Implementación | 2:30 | 15:55 |
| 13 | Implementación y verificación en cifras | Implementación | 1:15 | 17:10 |
| 14 | Acceso y operación en clase | Implementación | 0:45 | 17:55 |
| 15 | Privacidad y gobernanza de los datos | Implementación | 0:45 | 18:40 |
| 16 | Diseño del piloto (AB/BA) | Piloto | 1:15 | 19:55 |
| 17 | Resultados técnicos | Resultados | 1:00 | 20:55 |
| 18 | Resultados pedagógicos y de experiencia | Resultados | 1:30 | 22:25 |
| 19 | Hallazgos y mejoras | Resultados | 0:45 | 23:10 |
| 20 | Conclusiones por objetivo | Conclusiones | 1:15 | 24:25 |
| 21 | Limitaciones y trabajo futuro | Conclusiones | 1:00 | 25:25 |
| 22 | Cierre | Cierre | 0:15 | 25:40 |

Si en el ensayo el reloj pasa de 16:30 al terminar la demostración (diapositiva 12),
recortar en este orden: la 14 (se dice en una frase dentro de la 13), la 6 (solo los
tres conceptos) y la 15 (la figura y una frase).

## Guion por diapositiva

### 1. Portada · 0:20 (reloj 0:20)

- **Mensaje clave:** quién presenta y qué.
- **Visual:** título del trabajo [por verificar: título exacto del anteproyecto]; el
  nombre del sistema, ADACEEN, y el del proyecto en Jira, “Agente de aprendizaje
  contextual en el navegador”; autor, director, programa y fecha.
- **Qué decir:** “Buenos días. Soy Eyder Santiago Suárez Chávez y presento ADACEEN, un
  agente de aprendizaje contextual que acompaña a estudiantes de programación en el
  navegador y en el editor. El director es el profesor Víctor Andrés Bucheli
  Guerrero”.

### 2. Agenda · 0:20 (reloj 0:40)

- **Mensaje clave:** el recorrido sigue la estructura del documento.
- **Visual:** problema → objetivos → marco → metodología → arquitectura →
  implementación → piloto y resultados → conclusiones.
- **Qué decir:** “Primero el problema y los objetivos; luego cómo lo construí, con una
  demostración; después la evaluación con estudiantes y las conclusiones”.

### 3. El problema · 2:00 (reloj 2:40)

- **Mensaje clave:** el estudiante de programación se bloquea, y un asistente que le da
  la solución resuelve el ejercicio, pero no el aprendizaje.
- **Visual:** cuatro bloqueos típicos del curso, tomados de los escenarios del tutor
  (`src/services/tutor-scenarios.ts`):
  - error de compilación: `expected ';' before '}' token`;
  - falla al ejecutar: `ZeroDivisionError: division by zero`;
  - pregunta de concepto: “¿Qué es el polimorfismo en POO?”;
  - bloqueo de diseño: “¿Cómo organizo las responsabilidades del enunciado del
    taller?”.

  Al lado, una frase: “Pistas, no la solución”.
- **Qué decir:**
  - “En Fundamentos de Programación Orientada a Objetos (FPOO, 750015C) el estudiante
    pasa buena parte de la clase atascado en uno de estos cuatro tipos de bloqueo”.
  - “Un asistente de IA general los resuelve al instante, pero entrega la solución
    completa: el estudiante avanza sin entender, y el docente no controla qué ayuda
    recibe”.
  - “El anteproyecto fijó una regla que atraviesa todo el trabajo: el tutor nunca da
    la solución completa”. (Catálogo de KPIs, P6: anteproyecto A2 y 7.1).
  - [por verificar: datos o citas del planteamiento del problema del anteproyecto; solo
    si están allí con su fuente].

### 4. Pregunta de investigación e hipótesis · 1:00 (reloj 3:40)

- **Mensaje clave:** la pregunta se responde con tres hipótesis medibles.
- **Visual:** la pregunta y la tabla de hipótesis del
  [protocolo](../piloto/protocolo.md), sección 1:

  | # | Hipótesis | KPI | Umbral |
  |---|---|---|---|
  | H1 (principal) | Con el tutor baja la mediana del tiempo hasta desbloqueo de cada estudiante frente a su propio trabajo sin tutor | P1 | reducción ≥ 20 % |
  | H2 | Los estudiantes califican bien la experiencia de uso del tutor | U1 | ≥ 4,0 / 5 |
  | H3 | Los estudiantes perciben que el tutor apoya su aprendizaje | P4 | ≥ 4,0 / 5 |
- **Qué decir:** “La pregunta es si un agente integrado al navegador y al editor ayuda a
  salir de los bloqueos sin entregar la solución, y cómo lo viven los estudiantes. La
  hipótesis principal es que cada estudiante se desbloquea al menos un 20 % más rápido
  con el tutor que sin él”. [por verificar: redacción literal de la pregunta en el
  anteproyecto].

### 5. Objetivos · 1:15 (reloj 4:55)

- **Mensaje clave:** tres objetivos específicos: diseñar; construir y desplegar;
  evaluar.
- **Visual:** el objetivo general y tres columnas. El texto literal va del
  anteproyecto [por verificar]; debajo de cada uno, qué lo respalda en el trabajo.
  Las actividades salen de las descripciones de las épicas ADACEEN-1 a ADACEEN-6, que
  asignan varias a dos objetivos (van en las dos filas, con “también”), y los KPIs, de
  la columna objetivo de `src/services/kpi-catalog.ts`:

  | Objetivo | Qué lo respalda |
  |---|---|
  | OE1 · diseño del agente | Alcance, políticas, telemetría, gobernanza, normalización, material autorizado, motor de decisión e intervención con límites (A1, A2, A4, A5, A7 a A10; también A3, A6, A11 y A12). El anteproyecto (5.4) pide la arquitectura con vista C4 y diagramas de secuencia. KPIs T11 y T12 |
  | OE2 · implementación, integración y despliegue | Despliegue operativo y contingencia (A15; también la captura de contexto A6 y la integración de punta a punta A11). KPIs T1 a T5, T7 a T10, P6 y P7 |
  | OE3 · evaluación con estudiantes | Preparación y ejecución del piloto (A13 y A14; también las métricas A3 y las pruebas internas A12). KPIs T6, U1 a U5, P1 a P5 y P8 |

  A16 (documento final y sustentación) sirve a los tres objetivos.
- **Qué decir:** “El primer objetivo es el diseño; el segundo, el sistema funcionando
  en la nube y en el aula; el tercero, la evaluación con estudiantes. Cada KPI del
  catálogo está atado a uno de ellos, y así los retomo en las conclusiones”.

### 6. Marco de referencia · 1:30 (reloj 6:25)

- **Mensaje clave:** tres ideas sostienen el diseño: ayuda gradual, IA subordinada a
  la política del docente y respuestas ancladas en el material del curso.
- **Visual:** tres bloques con un ícono cada uno:
  1. Ayuda gradual (andamiaje): pista 1 → pista 2 → ejemplo parcial, según las ayudas
     ya usadas en el ejercicio.
  2. Política docente: el docente decide qué ayudas se permiten, cuántas pistas y
     cuánto código.
  3. Generación aumentada con recuperación (RAG) sobre el material autorizado del
     curso, con cita de la fuente.

  Abajo, los métodos de evaluación: diseño cruzado AB/BA (análisis de Hills y
  Armitage), prueba de rangos con signo de Wilcoxon y escala SUS (Brooke, 1996).
- **Qué decir:** “No construí un chat: construí un tutor que dosifica la ayuda. La
  literatura de tutoría inteligente y de andamiaje respalda dar primero una pista y
  solo después un ejemplo parcial [por verificar: citas del capítulo de marco teórico].
  El modelo de lenguaje queda subordinado a reglas del docente, y lo que explica se
  ancla en el material del curso”.

### 7. Metodología: CRISP-DM · 1:30 (reloj 7:55)

- **Mensaje clave:** el proyecto siguió las seis fases de CRISP-DM, adaptadas a un
  sistema que produce datos de uso.
- **Visual:** el ciclo de CRISP-DM con las actividades de Jira en cada fase (épicas
  ADACEEN-1 a ADACEEN-6):

  | Fase | Actividades |
  |---|---|
  | F1 Comprensión del negocio | A1 levantamiento pedagógico y de alcance, A2 políticas de intervención, A3 métricas y criterios de éxito |
  | F2 Comprensión de los datos | A4 telemetría (diccionario y calidad), A5 privacidad, consentimiento y trazabilidad |
  | F3 Preparación de los datos | A6 captura de contexto, A7 normalización y seudonimización, A8 material autorizado y plantillas |
  | F4 Modelado | A9 motor agéntico y backend de IA, A10 intervención con límites pedagógicos, A11 integración de punta a punta |
  | F5 Evaluación | A12 pruebas internas y métricas técnicas, A13 preparación del piloto, A14 ejecución y análisis |
  | F6 Despliegue | A15 despliegue operativo y contingencia, A16 documento final y sustentación |
- **Qué decir:** “Usé CRISP-DM porque el producto no es solo software: es un sistema
  que produce datos de uso y se evalúa con ellos. En la comprensión de los datos
  definí primero qué se mide y con qué privacidad, antes de escribir el tutor; por eso
  el piloto se analiza con un comando”.

### 8. Qué hace y qué no hace el tutor · 1:15 (reloj 9:10)

- **Mensaje clave:** los límites pedagógicos son reglas del sistema, no buenas
  intenciones del modelo.
- **Visual:** dos columnas (del [ADR-001](../arquitectura/adr-001-motor-y-arquitectura.md),
  decisión 1, y de los [escenarios](../tutor/escenarios.md)).
  - Hace: detecta el tipo de bloqueo; da la ayuda de la etapa que corresponde; cita el
    material del curso; en VS Code ofrece aplicar un cambio corto con confirmación.
  - No hace: dar la solución completa (límite de código por etapa: 0, 2 y 8 líneas en
    el overlay; 5, 10 y el máximo del docente en VS Code); pasar de 3 pistas por
    ejercicio en el piloto; inventar (sin contexto o fuera del curso responde el
    mensaje controlado del docente sin llamar al modelo); aplicar código sin
    verificación del servidor, salvo sin red: entonces aplica cambios de hasta 12
    líneas sin la confirmación que pide el docente y sin descontar cupo
    (`adaceen.codeApplication.offlineMaxLines`; en 0 no aplica nada sin el servidor).
    [por verificar: si para el piloto se deja en 0; hoy vale 12 por defecto].
- **Qué decir:** “El modelo no siempre obedece, así que los límites se vuelven a
  aplicar sobre su respuesta: si trae más código del permitido se recorta y se quita la
  opción de aplicar. Y hay dos casos en que ni siquiera se llama al modelo: cuando
  falta contexto y cuando la pregunta no es del curso”.

### 9. Arquitectura (C4, contenedores) · 1:45 (reloj 10:55)

- **Mensaje clave:** los estudiantes solo hablan con un API en Azure; la inferencia y
  los editores están detrás, en máquinas que solo abren conexiones de salida.
- **Visual:** la vista de contenedores de [vistas.md](../arquitectura/vistas.md),
  sección 1 (8 contenedores†): extensión de navegador, extensión de VS Code, API en
  Azure App Service, PostgreSQL, Service Bus, worker con GPU en Google Cloud, Mac del
  laboratorio y VM de editores.
- **Qué decir:**
  - “El estudiante trabaja en dos lugares: el navegador, con un overlay en Campus
    Virtual, GitHub y `vscode.dev`, y el editor, con la extensión de VS Code”.
  - “Las dos extensiones hablan con un solo API en Azure, que guarda la política, el
    material del curso y la telemetría en PostgreSQL”.
  - “El modelo, `qwen2.5-coder:14b` con Ollama, corre en una GPU de Google Cloud o en
    las Mac del laboratorio. El API deja el trabajo en una cola de Service Bus y el
    worker lo toma con una conexión de salida: no tiene IP pública ni puertos
    abiertos”.
  - “La VM de editores tampoco tiene IP pública: su agente le pregunta al API por
    HTTPS de salida. Eso es el relay”.

### 10. Decisiones frente al anteproyecto (ADR-001) · 1:15 (reloj 12:10)

- **Mensaje clave:** la arquitectura cambió frente al anteproyecto, con motivos
  medidos, y quedó registrada.
- **Visual:** la tabla “Qué cambia frente al anteproyecto” del ADR, resumida:

  | Tema | Anteproyecto | Hoy |
  |---|---|---|
  | Dónde corre el modelo | GPU del laboratorio GUÍA | GPU en Google Cloud o Mac del laboratorio, por cola |
  | Papel de Azure | Pasarela, sin inferencia | Backend completo |
  | Entorno del estudiante | — | `vscode.dev` con VS Code Tunnels, o VS Code instalado |

  Y dos cifras medidas (ADR, “Motivos”): `/run-text` en caliente de 2,2 a 6,9 s con la
  V100; un Codespace tardaba de 20 a 50 minutos en crearse y el entorno por túnel queda
  listo en unos 80 s.
- **Qué decir:** “Registré cuatro decisiones en un ADR: el motor de políticas único,
  el backend en Azure con inferencia por cola, el editor por túnel y los servidores de
  inferencia intercambiables. El motivo principal es la disponibilidad: el servicio
  tiene que funcionar desde cualquier sala y desde fuera de la red interna”. Estado del
  ADR hoy: propuesto, pendiente de aprobación del director [por verificar: fecha de
  la aprobación].

### 11. Motor de políticas y trazabilidad · 1:15 (reloj 13:25)

- **Mensaje clave:** cada respuesta del tutor se puede explicar después, sin guardar
  en el evento el código ni el texto del error del estudiante.
- **Visual:** la cadena de decisión de
  [trazabilidad-decisiones.md](../telemetria/trazabilidad-decisiones.md): señales →
  evento de política → regla del docente → etapa de ayuda → ¿llamar al modelo? →
  guardarraíl → `tutor_decision` con su `decision_id` → eventos del cliente con el
  mismo `decision_id`.
- **Qué decir:** “Un mismo motor decide en el overlay (`POST /intervene`) y en VS Code
  (`POST /suggest-tab`). Cada decisión queda como un evento `tutor_decision` con el
  evento detectado, la regla, la etapa, el motivo y la latencia, pero sin el código ni
  el texto del error (solo sus hashes), sin la ruta del archivo y con el actor
  seudonimizado. Con el `decision_id` sé si la ayuda se mostró, se aplicó o se
  ignoró”.

### 12. Demostración · 2:30 (reloj 15:55)

- **Mensaje clave:** verlo funcionar: pista, límite y confirmación.
- **Visual:** la
  [demostración 1](#demostración-1-ayuda-gradual-y-aplicación-con-confirmación-en-vs-code)
  en vivo o su video. Si el reloj va atrasado más de 1 minuto, pasar directo al video.
- **Qué decir:** narrar los pasos de la demostración 1. Al terminar: “Lo mismo se
  comprueba de forma automática: la demostración reproducible de los escenarios pasa
  92 de 92 comprobaciones†”.

### 13. Implementación y verificación en cifras · 1:15 (reloj 17:10)

- **Mensaje clave:** el sistema está construido y verificado con pruebas automáticas y
  evidencias reproducibles.
- **Visual:** una tabla de componentes y cuatro cifras de verificación (todas †, del 25
  de septiembre de 2026):

  | Componente | Líneas sin blanco | Pruebas |
  |---|---|---|
  | Backend (API) | 31 684 | 153: 98 de servicios, 54 de rutas y 1 de integración de punta a punta |
  | Scripts de consola (piloto, evidencias, worker) | 6672 | 39, junto con los documentos generados y el contrato |
  | Extensión de navegador (0.7.11) | 20 407 | 15 |
  | Extensión de VS Code (0.0.31) | 10 361 | 137 |
  | Agente de la VM, despliegue y operación | 6156 | 100 |

  Verificación: 112 rutas del API documentadas en un contrato que una prueba compara
  con el código; escenarios S1–S5 con 92 de 92 comprobaciones; 16 de 16 eventos
  perdidos a propósito detectados; ensayo técnico del piloto con todas sus
  comprobaciones correctas (10 de 10 en la evidencia del 25 de septiembre; el número
  sube cuando el simulador suma comprobaciones, así que se regenera la evidencia el
  día anterior, ver [antes de la sustentación](#antes-de-la-sustentación)).
- **Qué decir:** “En total hay 444 pruebas automáticas†; `npm test` corre 247† antes de
  cada despliegue. La latencia que medí en entorno controlado, con una salida de
  referencia en lugar del modelo, es el costo del servidor: una mediana de 129 ms en el
  editor y 147 ms en el overlay†. La latencia con el modelo se mide en el piloto”.

### 14. Acceso y operación en clase · 0:45 (reloj 17:55)

- **Mensaje clave:** entrar tenía que tomar menos que la clase.
- **Visual:** la tabla antes/después de la sección “Objetivo” del
  [acceso simplificado](../arquitectura/acceso-simplificado.md), titulada **objetivo
  del diseño**: son las metas de la tanda, no mediciones. Nadie contó los clics y el
  flujo no se ha probado en un navegador real. Cuando exista la hoja llena de la
  [prueba de inicio a fin](../piloto/prueba-inicio-a-fin.md), cambiar las cifras de
  “Después” por lo anotado en P3.2 y P3.3 (clics) y en P1.6 (minutos):

  | Momento | Antes | Después (objetivo) |
  |---|---|---|
  | Primera vez, túnel | ~20-25 clics, F1 + comando + pegar | ~10 clics + pegar el código de dispositivo (una vez) |
  | Volver otro día | 3-4 clics y a veces rehacer todo | 1 clic («Abrir mi editor») |
  | Docente, iniciar clase | 10-15 comandos en 4 lugares | `deploy/clase.sh iniciar` |

  [RESULTADO PENDIENTE: clics contados en P3.2 y P3.3 de la prueba de inicio a fin].
- **Qué decir:** “La meta del anteproyecto es instalar en 15 minutos o menos (KPI
  T10). El diseño busca que un estudiante entre con «Conectar GitHub», autorice un
  código una sola vez y VS Code quede conectado solo, y que el docente encienda todo
  con un comando”. [RESULTADO PENDIENTE: T10, minutos medidos con al menos 3
  personas].

### 15. Privacidad y gobernanza de los datos · 0:45 (reloj 18:40)

- **Mensaje clave:** se mide lo necesario, seudonimizado, con consentimiento y derecho
  de retiro.
- **Visual:** [ruta-de-datos.svg](../arquitectura/ruta-de-datos.svg) y tres cifras: 36
  eventos† en el diccionario, 30 ítems† en la lista de cumplimiento (8 críticos†) y el
  umbral T11 ≥ 80 %.
- **Qué decir:** “En la telemetría, que es lo que se analiza, el actor se guarda como
  un HMAC con una sal secreta, y el código y el texto del error van solo como hashes.
  Otras tablas sí guardan fragmentos de código para que el tutor funcione: el contexto
  de proyecto, las acciones de código y los quices; la ruta de datos dice cuáles y
  cuánto tiempo, y hoy solo la telemetría tiene plazo de retención. El piloto no empieza
  sin los ítems críticos de la lista y con al menos el 80 % del total, y un
  participante puede retirarse: `npm run piloto:retiro` borra sus datos, también los
  de esas tablas”. [RESULTADO PENDIENTE: T11, porcentaje de cumplimiento verificado].
- **Si preguntan por el código guardado:** [ruta de datos](../arquitectura/ruta-de-datos.md),
  tramo 4 y puntos 1 y 2 de “Hallazgos y pendientes para A4.3 y A5”
  (`project_context_racks`, `project_code_actions` y
  `student_quizzes.code_context`, con hasta 3 000 caracteres antes y después); es la
  diapositiva de respaldo A5.

### 16. Diseño del piloto (AB/BA) · 1:15 (reloj 19:55)

- **Mensaje clave:** cada estudiante es su propio control.
- **Visual:** la tabla de cohortes y la línea de tiempo de una sesión (del
  [protocolo](../piloto/protocolo.md), secciones 2 y 6):

  | Cohorte | Bloque 1 (40 min) | Bloque 2 (40 min) |
  |---|---|---|
  | A | con tutor | sin tutor |
  | B | sin tutor | con tutor |

  Participantes: unos 30 estudiantes de FPOO [por verificar: grupo, semestre y
  fechas]; dos sesiones de 2 horas; encuesta final y entrevistas.
- **Qué decir:** “En el bloque sin tutor la herramienta sigue abierta y registra igual
  los errores y los desbloqueos; solo desaparece la ayuda. El orden lo asigna el
  sistema al azar. P1 compara, para cada estudiante, la mediana de sus episodios de
  bloqueo con y sin tutor, con la prueba de Wilcoxon. Con unos 30 pares la potencia
  para un efecto moderado es de alrededor de 0,74: por eso reporto también el tamaño
  del efecto y leo los resultados como evidencia de un piloto”.

### 17. Resultados técnicos · 1:00 (reloj 20:55)

- **Mensaje clave:** [RESULTADO PENDIENTE: frase que diga si el sistema funcionó en
  clase según T1, T3 y T6].
- **Visual:** tabla semáforo con los KPIs técnicos y la gráfica
  `graficas/t1-latencia.svg` del análisis del piloto:
  - [RESULTADO PENDIENTE: T1, mediana de latencia en s, n, por canal; umbral ≤ 8 s]
  - [RESULTADO PENDIENTE: T2, p95 en s; umbral ≤ 15 s]
  - [RESULTADO PENDIENTE: T3, respuestas sin fallo en %; umbral ≥ 95 %]
  - [RESULTADO PENDIENTE: T4 y T5, pérdida y duplicados de eventos en %]
  - [RESULTADO PENDIENTE: T6, sesiones con telemetría en %; umbral ≥ 90 %]
  - [RESULTADO PENDIENTE: T7, incidentes críticos; umbral = 0]
  - [RESULTADO PENDIENTE: T8, pruebas de humo en %; umbral ≥ 95 %]
  - [RESULTADO PENDIENTE: T9, respuestas ancladas en el material en %; umbral ≥ 80 %]
- **Qué decir:** primero los que cumplen y después los que no, con la causa que diga el
  registro del monitor y el de incidentes. Si hubo bloques degradados (tutor caído más
  de 10 minutos), decirlo y dar el resultado del análisis de sensibilidad
  [RESULTADO PENDIENTE: bloques degradados].

### 18. Resultados pedagógicos y de experiencia · 1:30 (reloj 22:25)

- **Mensaje clave:** [RESULTADO PENDIENTE: frase con la respuesta a H1, por ejemplo
  “con el tutor, los estudiantes se desbloquearon un X % más rápido”].
- **Visual:** a la izquierda `graficas/p1-pareado.svg` (un punto por estudiante); a la
  derecha U1, P4 y U2:
  - [RESULTADO PENDIENTE: P1, reducción en %, n de estudiantes pareados, p de Wilcoxon
    y correlación biserial de rangos; umbral ≥ 20 %]
  - [RESULTADO PENDIENTE: P1 por cohorte y efecto de periodo (Hills y Armitage)]
  - [RESULTADO PENDIENTE: P2, episodios resueltos por condición]
  - [RESULTADO PENDIENTE: U1, promedio sobre 5 y n; umbral ≥ 4,0]
  - [RESULTADO PENDIENTE: P4, promedio sobre 5 y n; umbral ≥ 4,0]
  - [RESULTADO PENDIENTE: U2, SUS promedio; umbral ≥ 68]
  - [RESULTADO PENDIENTE: P3, participación en %; umbral ≥ 70 %]
- **Qué decir:** “Magnitud y significancia van por separado: primero cuánto cambió, y
  después si la diferencia es estadísticamente distinguible con esta muestra”. Si P1
  cumple la magnitud pero no la significancia, decirlo así; no presentar el p como
  prueba de eficacia.

### 19. Hallazgos y mejoras · 0:45 (reloj 23:10)

- **Mensaje clave:** lo que dijeron e hicieron los estudiantes explica los números.
- **Visual:** tres hallazgos con su KPI y su evidencia (de `hallazgos.csv` y de
  `trazabilidad.csv`), y `graficas/p7-etapas.svg` (uso por etapa de ayuda):
  - [RESULTADO PENDIENTE: hallazgo 1, con KPI y cita de una respuesta abierta]
  - [RESULTADO PENDIENTE: hallazgo 2]
  - [RESULTADO PENDIENTE: hallazgo 3]
  - [RESULTADO PENDIENTE: P5, mejoras críticas implementadas en %; umbral ≥ 65 %]
  - [RESULTADO PENDIENTE: P6, cumplimiento del límite anti-solución; umbral = 100 %]
- **Qué decir:** un hallazgo por frase, cada uno con su dato. Cerrar con la mejora que
  ya se hizo.

### 20. Conclusiones por objetivo · 1:15 (reloj 24:25)

- **Mensaje clave:** qué se cumplió de cada objetivo, con su evidencia.
- **Visual:** tres filas (OE1, OE2 y OE3), cada una con cumplido, parcial o no
  cumplido y la evidencia al lado.
  - OE1: diseño documentado y verificado: ADR-001, vistas C4 y secuencias, catálogo de
    25 KPIs†, diccionario de 36 eventos† y trazabilidad de cada decisión.
  - OE2: sistema desplegado y operado en clase [RESULTADO PENDIENTE: T7, T8 y T10];
    pruebas y evidencias reproducibles (diapositiva 13).
  - OE3: [RESULTADO PENDIENTE: H1 (P1), H2 (U1) y H3 (P4), cada una con “se sostiene”
    o “no se sostiene” y su cifra].
- **Qué decir:** una frase por objetivo. La de OE3 responde la pregunta de la
  diapositiva 4.

### 21. Limitaciones y trabajo futuro · 1:00 (reloj 25:25)

- **Mensaje clave:** lo que este piloto no permite afirmar y lo que sigue.
- **Visual:** dos columnas.
  - Limitaciones: muestra pequeña (potencia ≈ 0,74 con 30 pares y efecto moderado);
    un solo curso y dos lenguajes (C++ y Python); arrastre entre bloques y posible
    contaminación en el bloque sin tutor; la latencia medida es la del servidor, sin la
    red de la sala; dependencia de GPU en la nube (desalojos Spot, cupo, créditos) y de
    Microsoft Dev Tunnels; la verificación con lectores de pantalla sigue pendiente
    ([checklist WCAG](../accesibilidad/checklist-wcag-overlay.md)).
  - Trabajo futuro: evaluar el clúster de Mac con Exo (RDMA por Thunderbolt 5); estado
    compartido para escalar el API a varias instancias (hoy el relay y los limitadores
    viven en memoria); reducir el contexto que envía VS Code (hoy el archivo activo,
    hasta 12 000 caracteres); un piloto más largo y en más cursos.
- **Qué decir:** “Estos resultados son evidencia de un piloto, no una prueba general de
  eficacia”. Nombrar dos limitaciones y dos líneas de trabajo futuro; el resto queda
  escrito.

### 22. Cierre · 0:15 (reloj 25:40)

- **Mensaje clave:** gracias y preguntas.
- **Visual:** el nombre del sistema, la dirección de la página de inicio
  (`<backend>/empezar`) y el repositorio [por verificar: si el repositorio se muestra
  público].
- **Qué decir:** “Gracias. Quedo atento a sus preguntas”. Para las preguntas: el banco
  de A16.6 · ADACEEN-134 (fuera del repositorio) y las
  [diapositivas de respaldo](diapositivas.md#diapositivas-de-respaldo).

## Demostraciones

Cinco demostraciones posibles. En la exposición va una sola (la 1, en la diapositiva
12); las otras quedan para las preguntas o para reemplazar a la 1 si algo falla. Cada
una tiene un video de respaldo y, cuando se puede, un comando que corre sin red.

| # | Demostración | Duración | Necesita red | Respaldo sin red |
|---|---|---|---|---|
| 1 | Ayuda gradual y aplicación con confirmación en VS Code | 2:30 | Sí: backend, GPU y editor | Video; `npm run demo:escenarios` |
| 2 | El tutor no inventa y dosifica la ayuda (escenarios S1–S5) | 1:30 | No | Es la misma demostración |
| 3 | Acceso de un estudiante nuevo | 1:30 (video) o 0:30 («Abrir mi editor») | Sí: GitHub y VM de editores | Video |
| 4 | El docente: política y bloques del piloto | 2:00 | Sí: backend | Video |
| 5 | De los eventos al informe de KPIs | 2:00 | No | Es la misma demostración |

### Videos de respaldo

- Grabar cada demostración después del despliegue, con el flujo real y las cuentas de
  prueba, a pantalla completa y con letra grande. Cada video dura lo que dice la tabla.
- Antes de guardar, tapar correos, tokens, el código de dispositivo, los códigos
  `XXXX-XXXX` y cualquier `sessionId` (misma regla de la
  [prueba de inicio a fin](../piloto/prueba-inicio-a-fin.md)).
- Nombres sugeridos: `demo-1-vscode-ayuda-gradual.mp4`, `demo-2-escenarios.mp4`,
  `demo-3-acceso.mp4`, `demo-4-docente-piloto.mp4`, `demo-5-informe-kpis.mp4`.
- Los videos **no van al repositorio**: van incrustados en el PowerPoint (no como
  enlace), en el portátil de la sustentación y en una memoria USB. [por verificar: la
  carpeta de borradores del documento de grado, fuera del repositorio, como copia
  adicional].

### Antes de la sustentación

| Cuándo | Qué | Cómo |
|---|---|---|
| El día anterior | Evidencias al día | Primero, si cambiaron la demostración o el simulador del piloto desde la última evidencia: `npm run demo:escenarios -- --salida=docs/evidencias/demo-escenarios.md` y `npm run piloto:simular -- --evidencia`. Señal de que la del ensayo quedó vieja: `npm run piloto:simular` imprime más líneas `[ensayo] ok` que las comprobaciones que dice `docs/evidencias/ensayo-tecnico-piloto.md` |
| El día anterior | Cifras al día | Después de las evidencias: `npx tsx scripts/cifras-documento.ts` y actualizar las cifras † de las diapositivas |
| El día anterior | Pruebas | `npm run build` y `npm test` en el portátil |
| El día anterior | Demostraciones sin red | `npm run demo:escenarios` y `npm run piloto:simular` corren en el portátil |
| T − 30 min | Nube encendida | En Cloud Shell: `bash deploy/clase.sh estado` y, si hace falta, `bash deploy/clase.sh iniciar` (termina con `clase lista. Enlace para estudiantes:`) |
| T − 30 min | Backend caliente | Abrir `<backend>/api/health` y `<backend>/empezar`. En el estado: «Editor en la nube:» con «Encendido» y «listo para preparar tu editor.»; «Tutor (modelo):» con «Disponible». Si el editor dice «Apagado», correr `bash deploy/clase.sh iniciar`. El código para VS Code tiene un límite de 3,5 s, y un backend frío lo pasa |
| T − 15 min | Cuentas de demostración | Dos perfiles de navegador (o dos navegadores), cada uno con la extensión: uno con la cuenta de docente de prueba y otro con la de estudiante. La extensión guarda una sola sesión por perfil (`chrome.storage.local`, compartida por todas las pestañas): entrar con otra cuenta en el mismo perfil saca a la primera. Nada de cuentas reales ni del piloto |
| T − 15 min | Pantalla | Notificaciones apagadas; VS Code y la terminal con letra grande; pestañas de las demostraciones ya abiertas |
| Al terminar | Nube apagada | `bash deploy/clase.sh terminar` |

### Demostración 1: ayuda gradual y aplicación con confirmación en VS Code

- **Qué muestra:** el escenario S1 en el editor: pista sin la solución, cambio corto
  con confirmación y límite de cupo.
- **Prepara:** un repositorio público de demostración con el archivo
  `<repositorio de demostración>/src/cuenta.cpp` igual a `SCENARIO_CPP_CODE` de
  `src/services/tutor-scenarios.ts` (la clase `Cuenta` con el punto y coma que falta); el editor de la cuenta de estudiante de prueba ya abierto
  en `vscode.dev` (o VS Code instalado con la extensión 0.0.31); la GPU encendida.
- **Pasos:**
  1. Mostrar la barra de estado: «ADACEEN: <nombre>» y «GPU: <servidor>».
  2. Seleccionar las líneas del método `depositar`. Aparece «Sugerencia para la
     seleccion» (mientras espera, «consultando al backend»): una pista con una
     pregunta guía, sin la clase corregida.
  3. Pulsar «Modificar seleccion». Aparece «ADACEEN: ¿Aplicar el cambio del tutor…?»
     con «Tu docente pide confirmar antes de aplicar código del tutor. Puedes
     deshacerlo con Ctrl+Z.».
  4. «Aplicar»; mostrar el cambio y deshacerlo con Ctrl+Z.
  5. Si sobra tiempo: «Otra sugerencia», y mostrar que el servidor decide la etapa
     según las ayudas ya usadas; no forzarlo en vivo.
- **Qué decir mientras tanto:** “La extensión le pregunta al servidor si puede aplicar
  (`POST /api/suggestions/apply-check`) sin enviarle el código: solo cuántas líneas
  cambian. La aplicación cuenta como pista y tiene un cupo por ejercicio”.
- **Si falla:** «GPU: sin worker activo» significa que el modelo está apagado (el
  tutor responde degradado): pasar al video. Sin red: `npm run demo:escenarios` y
  mostrar la sección «Aplicacion de codigo en VS Code (A10.8)» de la salida: el cambio
  de 25 líneas se bloquea (`code_application_too_large`) y el cupo se agota en 3
  aplicaciones.

### Demostración 2: el tutor no inventa y dosifica la ayuda (escenarios S1–S5)

- **Qué muestra:** los seis escenarios contra el backend real levantado en memoria, con
  una salida de referencia en lugar del modelo. No necesita red ni GPU (unos 4 s).
- **Pasos:**
  1. En la terminal: `npm run demo:escenarios`.
  2. Mostrar la línea `Resultado: 92 de 92 comprobaciones correctas`.
  3. Mostrar la sección «Ayuda gradual en el overlay (A2.2)»: `hint_1 -> hint_2 ->
     partial_example -> controlled` y el motivo `hint_limit_reached`.
  4. Mostrar S5b en el editor: evento `out_of_domain`, etapa `controlled` y la
     respuesta «No puedo ayudar con ese tema o con tan poco contexto…», sin código.
- **Qué decir:** “Esta misma demostración es una prueba de humo: sale con error si una
  sola comprobación falla”.
- **Variante contra producción** (solo si se pide, y fuera del periodo del piloto):
  `npm run demo:escenarios -- --url=<backend> --email=<estudiante de prueba>
  --password=<clave>`. Deja eventos en la base del piloto: el script imprime la ventana
  de tiempo para excluirla del análisis.

### Demostración 3: acceso de un estudiante nuevo

- **Qué muestra:** el acceso simplificado, de la página de inicio al editor conectado.
- **En video (1:30, editado):** los pasos P1.1 a P1.6 de la
  [prueba de inicio a fin](../piloto/prueba-inicio-a-fin.md):
  1. En `<backend>/empezar`, «Descargar la extension» y cargarla; la página dice
     «Instalada».
  2. En GitHub, el icono de ADACEEN, «Empezar» e inicio de sesión.
  3. En «Accion recomendada», un solo botón: «Conectar GitHub».
  4. La misma ventana muestra «ADACEEN esta preparando tu editor» y pasa sola a
     `github.com/login/device`, con «ADACEEN · tu codigo» y «Copiar codigo».
  5. Se autoriza en GitHub y se abre `vscode.dev` con los archivos del repositorio.
  6. La barra de VS Code dice «ADACEEN: <nombre>» sin haber pegado nada.
- **En vivo (0:30):** con una cuenta que ya hizo la primera vez, en el overlay, «Abrir
  mi editor»: un clic y se abre el editor.
- **Si falla:** con la VM apagada, la ventana dice «El editor esta apagado; avisa al
  docente» y sigue esperando: correr `bash deploy/clase.sh iniciar` o pasar al video.

### Demostración 4: el docente, la política y los bloques del piloto

- **Qué muestra:** que el docente gobierna el tutor y cómo se opera el diseño AB/BA.
- **Prepara:** una cuenta de **docente de prueba** cuyos únicos estudiantes sean las
  cuentas de demostración. «Asignar grupos A y B» asigna una cohorte a todos los
  estudiantes activos de ese docente y no se puede reiniciar desde el overlay: nunca
  usar el docente del piloto. Anotar las cuentas de demostración en `cuentasPrueba`
  del plan del piloto (regla D3 de la limpieza). El docente y el estudiante van en
  **perfiles de navegador distintos** (ver [antes de la sustentación](#antes-de-la-sustentación)).
  La asignación reparte al azar y balanceado (`assignPilotCohorts` en
  `src/services/pilot.ts`): con un solo estudiante de demostración, puede quedar en
  el grupo A, que en el bloque 1 tiene tutor; con dos, uno queda en cada grupo.
- **Pasos:**
  1. Overlay con la cuenta de docente: «Politica docente», con «Maximo de pistas por
     ejercicio» y el campo del mensaje controlado («Mensaje ante falta de contexto o
     consulta fuera del dominio.»).
  2. En «Piloto con y sin tutor»: «Asignar grupos A y B». La línea de estado dice
     «Grupo A: <n>, grupo B: <n>».
  3. «Iniciar bloque 1» si el estudiante de demostración que se va a usar quedó en el
     grupo B, o «Iniciar bloque 2» si quedó en el A. El overlay solo muestra los
     conteos: con un estudiante, el conteo dice su grupo; con dos, probar con uno y,
     si el tutor le responde normal, usar el otro.
  4. En el perfil del estudiante, pedir ayuda: aparece «En este bloque del piloto
     trabajas sin el tutor. Sigue con tu ejercicio como lo harias en clase; el tutor
     vuelve en el siguiente bloque.».
  5. En la terminal: `npm run piloto:monitor -- --url=<backend> --email=<docente>
     --password=<clave> --desde=<inicio>`: una línea cada 30 s con el bloque, los
     servidores vivos y los estudiantes activos por condición.
  6. «Terminar piloto».
- **Si falla:** video. Escribir la contraseña del monitor antes, con el proyector
  apagado: no debe quedar en pantalla.

### Demostración 5: de los eventos al informe de KPIs

- **Qué muestra:** la cadena de análisis completa con estudiantes sintéticos: cohortes,
  bloques, bloqueos, ayudas, limpieza del dataset, KPIs y gráficas. Sin red (unos 20 s).
- **Pasos:**
  1. `npm run piloto:simular` (salida en `exportes/ensayo-tecnico/`, que no se sube al
     repositorio).
  2. Mostrar las líneas `[ensayo] ok …` de la terminal. Deben ser tantas como las
     comprobaciones del ensayo técnico que dicen las diapositivas 13 y B17; si hay más,
     la evidencia quedó vieja (ver [antes de la sustentación](#antes-de-la-sustentación)).
  3. Abrir `exportes/ensayo-tecnico/analisis/informe-kpis.md`, sección «2. Tiempo
     hasta desbloqueo (P1, P2)», y `exportes/ensayo-tecnico/analisis/graficas/p1-pareado.svg`.
- **Qué decir:** “Los tiempos son sintéticos y se generaron distintos a propósito:
  esto prueba que la cadena mide y compara bien, **no dice nada del efecto del
  tutor**. Con los datos del piloto se corre la misma cadena: `piloto:dataset` y
  `piloto:analisis`”.

## Si falla la red en la sala

- Todas las figuras van como imagen en el PowerPoint; ninguna depende de internet.
- Los videos van incrustados. Llevar además el PowerPoint exportado a PDF.
- Las demostraciones 2 y 5 corren en el portátil sin red: dejar el repositorio con
  `node_modules` instalado y probarlas el día anterior.
- Si se cae la red en la demostración 1: “paso al video grabado con el sistema
  desplegado”, y seguir; no intentar reconectar frente al jurado.
- [por verificar: si la sala tiene red cableada o si hace falta compartir la conexión
  del celular].

## Plan B si el piloto no alcanza

El protocolo prevé dos sesiones; con una sola el diseño se mantiene y se reporta como
limitación ([protocolo](../piloto/protocolo.md), sección 4). Según lo que se alcance:

| Situación | Qué cambia en la exposición |
|---|---|
| **A. Piloto completo** | Nada: el guion de arriba |
| **B. Piloto parcial** (una sesión, o menos estudiantes de los esperados) | Las diapositivas 17 a 19 se mantienen con el n real. En la 18 va el número de estudiantes pareados y, si es bajo, la magnitud y las medianas con la prueba exacta de Wilcoxon, sin afirmar significancia. En la 21 va primero la limitación de muestra |
| **C. Sin piloto con estudiantes, con el ensayo con 1 o 2 personas y la prueba de inicio a fin** | Las diapositivas 17 a 19 se reemplazan por B17 y B18 (abajo), y la 20 cambia en OE3 |
| **D. Sin piloto ni ensayo con personas** | Como C, sin la parte de personas de B17 |

### B17. Verificación técnica y ensayo · 1:45

- **Mensaje clave:** el sistema funciona de punta a punta y la evaluación está lista
  para correr.
- **Visual:**
  - evidencias automáticas (†): escenarios 92 de 92; latencia del servidor (mediana 129
    ms en el editor y 147 ms en el overlay, sin modelo); 16 de 16 eventos perdidos
    detectados; ensayo técnico con todas sus comprobaciones correctas (10 de 10 en la
    evidencia del 25 de septiembre; regenerarla antes, como dice la diapositiva 13);
  - prueba de inicio a fin con 2 cuentas [RESULTADO PENDIENTE: pasos P0 a P8 en `ok`,
    de la copia llena de `data/piloto/plantillas/prueba-inicio-a-fin.csv`];
  - tiempo de instalación [RESULTADO PENDIENTE: T10 con al menos 3 personas];
  - latencia con el modelo encendido [RESULTADO PENDIENTE: p50 y p95 de
    `npm run medir:latencia -- --url=<backend> --n=30`];
  - ensayo con personas, solo en el caso C [RESULTADO PENDIENTE: hallazgos del ensayo
    del protocolo, sección 11].
- **Qué decir:** “Sin el piloto no puedo afirmar nada sobre el aprendizaje. Lo que sí
  muestro es que el sistema funciona en las condiciones del aula y que la medición
  está validada”.

### B18. La evaluación, lista para ejecutar · 1:30

- **Mensaje clave:** el piloto se puede hacer con lo que ya existe.
- **Visual:** la cadena de [análisis de datos](../piloto/analisis-de-datos.md)
  (monitor → dataset → análisis → trazabilidad) y
  `docs/evidencias/ensayo-tecnico/analisis/graficas/p1-pareado.svg`, con un sello grande
  “DATOS SINTÉTICOS” sobre la gráfica. Al lado, el calendario del piloto [por
  verificar: fechas].
- **Qué decir:** “Con 12 estudiantes sintéticos la cadena detecta lo que tiene que
  detectar: excluye al docente, a la cuenta de prueba y al duplicado, y calcula P1 con
  Wilcoxon. Esos datos los generé yo: no son evidencia del tutor”.

### Diapositiva 20 en los casos C y D

- OE1 y OE2 como en el guion; en OE2, T7, T8 y T10 salen de la prueba de inicio a fin y
  del cronómetro de instalación, no de clases.
- OE3: “parcialmente cumplido: protocolo, instrumentos, consentimiento y cadena de
  análisis listos y ensayados; la ejecución con estudiantes queda pendiente”, con la
  fecha prevista [por verificar: fecha prevista del piloto]. No afirmar H1, H2 ni H3.
- Los tiempos no cambian: B17 (1:45) y B18 (1:30) suman 3:15, lo mismo que las
  diapositivas 17 a 19 (1:00 + 1:30 + 0:45), y el reloj sigue terminando en 25:40.

## Marcadores pendientes

Todos los `[RESULTADO PENDIENTE: …]` salen de la carpeta del análisis del piloto,
`exportes/piloto-<fecha>/analisis/` (`npm run piloto:analisis -- --dataset=…
--encuesta=… --plan=… --registros=…`, ver [análisis de datos](../piloto/analisis-de-datos.md)).

| Marcador | Archivo | Dónde |
|---|---|---|
| T1 a T12, U1 a U5, P1 a P8 | `kpis.csv` | columnas `valor_texto`, `n`, `cumple` y `lectura` |
| P1 completo (Wilcoxon, correlación biserial, cohortes, periodo, sensibilidad) | `informe-kpis.md` | sección «2. Tiempo hasta desbloqueo (P1, P2)» |
| T1 y T2 por canal y por servidor | `informe-kpis.md` | sección «3. Latencia del tutor (T1, T2)» |
| U1, U2, P4 y U5 | `informe-kpis.md` | sección «4. Encuesta (U1, U2, P4, U5)» |
| T7, T8, T10, T11 y P5 | `registros-manuales.csv` | plantillas llenas de `data/piloto/plantillas/` |
| Hallazgos | `trazabilidad.csv` | columnas `hallazgo` y `accion` (desde la copia de `hallazgos.csv`) |
| Gráficas | `graficas/` | `t1-latencia.svg`, `t6-sesiones.svg`, `p1-pareado.svg`, `p1-caja.svg`, `u1-likert.svg`, `p4-likert.svg`, `u2-sus.svg`, `p7-etapas.svg` |
| Bloques degradados | `exportes/monitor-<fecha>.jsonl` | registro del monitor de cada sesión |

## Ensayo

El formato para calificar el ensayo y el registro de ensayos están en la lista de
entrega de A16.7 · ADACEEN-135 (fuera del repositorio). Para este guion:

- Cronometrar con la columna Reloj y anotar dónde se pasó.
- Hacer al menos un ensayo con la demostración 1 en vivo y otro con su video.
- Hacer un ensayo del plan B (caso C) aunque el piloto vaya bien.
