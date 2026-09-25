# Diapositivas de la sustentación

| | |
|---|---|
| Jira | A16.5 · ADACEEN-133 |
| Guion | [guion.md](guion.md): tiempos, qué decir, demostraciones y plan B |
| Cifras | [cifras-documento.md](../evidencias/cifras-documento.md) (`npx tsx scripts/cifras-documento.ts`) |
| Estado | Borrador. Resultados del piloto como `[RESULTADO PENDIENTE: …]`; datos que no están en el repositorio como `[por verificar: …]` |

Texto listo para pasar a PowerPoint: una sección por diapositiva, con el título, el
texto que va en la diapositiva, la figura y las notas del orador (versión corta del
guion). Convenciones:

- † marca una cifra de `docs/evidencias/cifras-documento.md` (del 25 de septiembre de
  2026, commit `f510225` con cambios sin commit). El día anterior, regenerar primero
  las evidencias que hayan cambiado y después ese archivo, y actualizar las cifras que
  cambien ([guion](guion.md#antes-de-la-sustentación)).
- Los únicos marcadores son `[RESULTADO PENDIENTE: …]` y `[por verificar: …]`.
- Los textos entre comillas angulares son de la interfaz, copiados del código.
- Plantilla: [por verificar: si el programa tiene una plantilla institucional para
  la sustentación]. Si no, fondo claro, una idea por diapositiva y letra de 24 puntos o
  más en el texto.

## Figuras: de dónde salen

| Figura | Archivo del repositorio | Cómo pasarla a imagen | Diapositivas |
|---|---|---|---|
| Contenedores (C4, nivel 2) | [vistas.md](../arquitectura/vistas.md), sección 1 (bloque Mermaid) | Copiar el bloque a un archivo `.mmd` y `npx -p @mermaid-js/mermaid-cli mmdc -i <bloque>.mmd -o <salida>.png` (comando de “Cómo mantenerlo” en vistas.md) | 9 |
| Secuencia: ayuda del tutor en VS Code | [vistas.md](../arquitectura/vistas.md), sección 2 | Igual | 11 (opcional), A4 |
| Secuencia: preparar el entorno por el relay | [vistas.md](../arquitectura/vistas.md), sección 3 | Igual | A3 |
| Cadena de una decisión | [trazabilidad-decisiones.md](../telemetria/trazabilidad-decisiones.md), “Cadena de una decisión” | Igual | 11 |
| Ruta de datos | [ruta-de-datos.svg](../arquitectura/ruta-de-datos.svg) | Insertar el SVG [por verificar: que la versión de PowerPoint del portátil acepte SVG; si no, exportarlo a PNG] | 15, A5 |
| Servidores de inferencia intercambiables | [worker-mac.md](../operacion/worker-mac.md), sección 1 (bloque Mermaid) | Como el C4 | A6 |
| Gráficas del piloto | `exportes/piloto-<fecha>/analisis/graficas/*.svg`, que genera `npm run piloto:analisis` | Insertar el SVG | 17, 18, 19 |
| Gráficas de ejemplo (sintéticas) | `docs/evidencias/ensayo-tecnico/analisis/graficas/*.svg` | Solo para armar el diseño antes del piloto, o en el plan B con el sello “DATOS SINTÉTICOS” | B18 |
| Ciclo de CRISP-DM | No hay figura en el repositorio | Dibujarla en PowerPoint (un ciclo de seis fases) | 7 |

`docs/diagrama-contexto-adaceen.svg` y `docs/adaceen-current-flow.svg` son de junio de
2026 y muestran Codespaces como entorno principal: no usarlos para la arquitectura
actual.

---

## 1. Portada

**En la diapositiva**

- [por verificar: título del trabajo de grado, tal como está en el anteproyecto]
- ADACEEN: agente de aprendizaje contextual en el navegador
- Eyder Santiago Suárez Chávez
- Director: Víctor Andrés Bucheli Guerrero, PhD
- [por verificar: programa, Facultad de Ingeniería, Universidad del Valle]
- [por verificar: fecha de la sustentación]

**Figura:** ninguna (logos institucionales si la plantilla los pide).

**Notas del orador:** presentarse y presentar el sistema en una frase.

## 2. Agenda

**En la diapositiva**

1. Problema y pregunta
2. Objetivos
3. Marco de referencia y metodología
4. Arquitectura
5. Implementación y demostración
6. Piloto y resultados
7. Conclusiones y trabajo futuro

**Notas del orador:** “Primero el problema y los objetivos; luego cómo lo construí,
con una demostración; después la evaluación y las conclusiones”.

## 3. El problema

**En la diapositiva**

Título: El estudiante se bloquea; la IA general le da la solución

| Bloqueo | Ejemplo del curso |
|---|---|
| Error de compilación | `expected ';' before '}' token` |
| Falla al ejecutar | `ZeroDivisionError: division by zero` |
| Duda de concepto | ¿Qué es el polimorfismo en POO? |
| Bloqueo de diseño | ¿Cómo organizo las responsabilidades del enunciado? |

Frase destacada: Pistas, no la solución.

[por verificar: una cifra o cita del planteamiento del problema del anteproyecto, con
su fuente]

**Figura:** ninguna; cuatro tarjetas con los ejemplos (salen de
`src/services/tutor-scenarios.ts`).

**Notas del orador:** FPOO (750015C), C++. Un asistente general resuelve al instante
pero entrega la solución completa y el docente no controla la ayuda. Regla del
anteproyecto: nunca la solución completa (A2 y 7.1).

## 4. Pregunta de investigación e hipótesis

**En la diapositiva**

Pregunta: ¿Un agente de aprendizaje contextual, integrado al navegador y al editor,
ayuda a estudiantes de programación a salir de los bloqueos sin entregarles la
solución? ¿Cómo lo viven? [por verificar: redacción literal del anteproyecto]

| | Hipótesis | KPI | Umbral |
|---|---|---|---|
| H1 | Con el tutor se desbloquean más rápido que sin él | P1 | reducción ≥ 20 % |
| H2 | Califican bien la experiencia de uso | U1 | ≥ 4,0 / 5 |
| H3 | Perciben apoyo a su aprendizaje | P4 | ≥ 4,0 / 5 |

**Notas del orador:** H1 es la principal; cada estudiante se compara consigo mismo.

## 5. Objetivos

**En la diapositiva**

Objetivo general: [por verificar: texto literal del anteproyecto]

| OE1 · Diseñar | OE2 · Construir y desplegar | OE3 · Evaluar |
|---|---|---|
| [por verificar: texto literal] | [por verificar: texto literal] | [por verificar: texto literal] |
| Políticas, telemetría, gobernanza, motor de decisión e intervención con límites, arquitectura C4 | Captura de contexto, integración de punta a punta, despliegue en la nube y operación | Pruebas internas, piloto con estudiantes, KPIs y hallazgos |
| A1, A2, A4, A5, A7–A10; también A3, A6, A11, A12 | A15; también A6 y A11 | A13, A14; también A3 y A12 |
| KPIs T11, T12 | KPIs T1–T5, T7–T10, P6, P7 | KPIs T6, U1–U5, P1–P5, P8 |

**Notas del orador:** las actividades siguen las épicas ADACEEN-1 a ADACEEN-6, que
asignan A3, A6, A11 y A12 a dos objetivos; A16 (documento y sustentación) sirve a los
tres. Cada KPI del catálogo está atado a un objetivo (columna objetivo de
`src/services/kpi-catalog.ts`); así se retoman en las conclusiones.

## 6. Marco de referencia

**En la diapositiva**

- **Ayuda gradual:** pista 1 → pista 2 → ejemplo parcial
- **Política docente:** el docente decide ayudas, pistas y código permitido
- **RAG:** respuestas ancladas en el material autorizado del curso, con cita
- **Evaluación:** diseño cruzado AB/BA · Wilcoxon · SUS (Brooke, 1996)

[por verificar: 3 o 4 referencias clave del capítulo de marco teórico, en formato
corto]

**Figura:** tres íconos, uno por idea.

**Notas del orador:** no es un chat; es un tutor que dosifica la ayuda. El modelo queda
subordinado a reglas del docente.

## 7. Metodología: CRISP-DM

**En la diapositiva**

| Fase | Qué se hizo |
|---|---|
| Comprensión del negocio | Alcance pedagógico, políticas de intervención, KPIs (A1–A3) |
| Comprensión de los datos | Diccionario de telemetría, privacidad y consentimiento (A4–A5) |
| Preparación de los datos | Captura de contexto, seudonimización, material autorizado (A6–A8) |
| Modelado | Motor de políticas, intervención con límites, integración (A9–A11) |
| Evaluación | Pruebas, preparación y ejecución del piloto (A12–A14) |
| Despliegue | Operación en la nube y contingencia, documento y sustentación (A15–A16) |

**Figura:** ciclo de CRISP-DM dibujado en PowerPoint.

**Notas del orador:** primero se definió qué medir y con qué privacidad; por eso el
piloto se analiza con un comando.

## 8. Qué hace y qué no hace el tutor

**En la diapositiva**

| Hace | No hace |
|---|---|
| Detecta el tipo de bloqueo (compilación, ejecución, concepto, diseño) | Dar la solución completa: código limitado por etapa (overlay 0, 2 y 8 líneas; VS Code 5, 10 y el máximo del docente) |
| Da la ayuda de la etapa que toca, según las ayudas ya usadas | Pasar de 3 pistas por ejercicio (piloto) |
| Cita el material del curso | Inventar: sin contexto o fuera del curso responde el mensaje del docente, sin llamar al modelo |
| En VS Code, aplica un cambio corto con confirmación | Aplicar código sin verificación del servidor (sin red, solo cambios de hasta 12 líneas) |

**Notas del orador:** los límites se vuelven a aplicar sobre la respuesta del modelo;
si trae más código, se recorta y se quita la opción de aplicar. Sin red, VS Code
aplica cambios de hasta 12 líneas sin la confirmación del docente ni el cupo
(`adaceen.codeApplication.offlineMaxLines`; en 0 no aplica nada sin el servidor)
[por verificar: si para el piloto se deja en 0].

## 9. Arquitectura

**En la diapositiva**

Título: Los estudiantes solo hablan con un API; lo demás abre conexiones de salida

- Azure: API (App Service), PostgreSQL, Service Bus
- Google Cloud: worker con GPU (`qwen2.5-coder:14b`) y VM de editores sin IP pública
- Laboratorio de Univalle: Mac como servidores de inferencia

**Figura:** contenedores C4 de [vistas.md](../arquitectura/vistas.md), sección 1 (8
contenedores†).

**Notas del orador:** dos canales (overlay y VS Code), un solo API. El trabajo de
inferencia va por cola; el worker lo toma con conexión de salida. La VM de editores
recibe las peticiones por el relay (sondeo por HTTPS de salida).

## 10. Decisiones frente al anteproyecto (ADR-001)

**En la diapositiva**

| Tema | Anteproyecto | Hoy |
|---|---|---|
| Modelo | GPU del laboratorio GUÍA | GPU en Google Cloud o Mac del laboratorio, por cola |
| Azure | Pasarela sin inferencia | Backend completo |
| Entorno | — | `vscode.dev` por túnel o VS Code instalado |

- `/run-text` en caliente: 2,2 a 6,9 s (V100)
- Entorno listo: ~80 s por túnel, frente a 20–50 min de un Codespace

Estado: propuesto, pendiente de aprobación del director [por verificar: fecha de
aprobación]

**Notas del orador:** cuatro decisiones registradas: motor único, backend en Azure con
cola, editor por túnel, servidores intercambiables. Motivo: disponibilidad desde
cualquier sala.

## 11. Motor de políticas y trazabilidad

**En la diapositiva**

Título: Cada respuesta se puede explicar, sin guardar en el evento el código del
estudiante

- Un motor para los dos canales: `POST /intervene` (overlay) y `POST /suggest-tab`
  (VS Code)
- Cada decisión: evento `tutor_decision` con `decision_id`, etapa, motivo y latencia
- En el evento: código y texto del error solo como hash, sin ruta del archivo, actor
  seudonimizado

**Figura:** cadena de una decisión de
[trazabilidad-decisiones.md](../telemetria/trazabilidad-decisiones.md).

**Notas del orador:** con el `decision_id` se sabe si la ayuda se mostró, se aplicó o
se ignoró.

## 12. Demostración

**En la diapositiva**

Título: Demostración: una pista, un límite y una confirmación

- Error de compilación en `cuenta.cpp` (escenario S1)
- Pista sin la solución
- Cambio corto con confirmación («Aplicar») y Ctrl+Z

**Figura:** el video `demo-1-vscode-ayuda-gradual.mp4` incrustado (se reproduce solo
si la demostración en vivo falla).

**Notas del orador:** seguir la [demostración 1 del guion](guion.md#demostración-1-ayuda-gradual-y-aplicación-con-confirmación-en-vs-code).
Cerrar con: la demostración reproducible pasa 92 de 92 comprobaciones†.

## 13. Implementación y verificación en cifras

**En la diapositiva**

| Componente | Líneas† | Pruebas† |
|---|---|---|
| Backend (API) | 31 684 | 153 |
| Scripts de consola | 6672 | 39 |
| Extensión de navegador 0.7.11 | 20 407 | 15 |
| Extensión de VS Code 0.0.31 | 10 361 | 137 |
| Agente de la VM, despliegue y operación | 6156 | 100 |
| **Total** | **75 280** | **444** |

- 112 rutas del API†, todas en el contrato (lo comprueba una prueba)
- Escenarios S1–S5: 92 de 92 comprobaciones†
- Estabilidad: 16 de 16 eventos perdidos detectados†
- Ensayo técnico del piloto: todas las comprobaciones correctas (12 de 12†)

Pie: líneas sin contar las vacías; latencia del servidor sin modelo: mediana de 129 ms
(editor) y 147 ms (overlay)†.

**Notas del orador:** `npm test` corre 247 pruebas† antes de cada despliegue. La
latencia con el modelo se mide en el piloto. El número del ensayo técnico sube cuando
el simulador suma comprobaciones: regenerar su evidencia antes de citarlo
(`npm run piloto:simular -- --evidencia`).

## 14. Acceso y operación en clase

**En la diapositiva**

Título de la tabla: Objetivo del diseño

| | Antes | Después (objetivo) |
|---|---|---|
| Primera vez | ~20-25 clics y copiar/pegar | ~10 clics y un código de dispositivo, una vez |
| Volver otro día | 3-4 clics | 1 clic: «Abrir mi editor» |
| Docente | 10-15 comandos en 4 lugares | `deploy/clase.sh iniciar` |

Medido: [RESULTADO PENDIENTE: clics de P3.2 y P3.3 y minutos de P1.6 de la prueba de
inicio a fin]

Meta: instalación en 15 minutos o menos (T10) [RESULTADO PENDIENTE: T10]

**Figura:** captura de `/empezar` o de la barra «ADACEEN: <nombre>» en `vscode.dev`
(tomarla después del despliegue, sin datos personales).

**Notas del orador:** «Conectar GitHub», un código una sola vez y VS Code queda
conectado solo.

## 15. Privacidad y gobernanza de los datos

**En la diapositiva**

- Telemetría (`telemetry_events`): actor seudonimizado (HMAC con sal secreta); código
  y errores solo como hash; 365 días de retención (purga con
  `npm run telemetria:purgar`)
- Otras tablas guardan fragmentos de código para el tutor (contexto de proyecto,
  acciones de código, quices): sin plazo de retención todavía
- 36 eventos† en el diccionario, todos atados a un KPI
- Lista de cumplimiento: 30 ítems†, 8 críticos†; el piloto exige ≥ 80 % y todos los
  críticos (T11) [RESULTADO PENDIENTE: T11]
- Consentimiento informado y retiro: `npm run piloto:retiro`

**Figura:** [ruta-de-datos.svg](../arquitectura/ruta-de-datos.svg).

**Notas del orador:** se mide solo lo que alimenta un KPI. El hash del código y del
error vale para la telemetría, que es lo que se analiza; el detalle de las otras
tablas está en la [ruta de datos](../arquitectura/ruta-de-datos.md), tramo 4, y en la
diapositiva de respaldo A5.

## 16. Diseño del piloto (AB/BA)

**En la diapositiva**

| Cohorte | Bloque 1 (40 min) | Bloque 2 (40 min) |
|---|---|---|
| A | con tutor | sin tutor |
| B | sin tutor | con tutor |

- ~30 estudiantes de FPOO, 2 sesiones de 2 h [por verificar: grupo y fechas]
- Asignación al azar por el sistema; en el bloque sin tutor todo se registra igual
- P1: mediana por estudiante con y sin tutor; Wilcoxon pareado y tamaño del efecto
- Potencia ≈ 0,74 con 30 pares y efecto moderado: evidencia de un piloto

**Notas del orador:** cada estudiante es su propio control; el contrabalanceo reparte
el efecto de orden.

## 17. Resultados técnicos

**En la diapositiva**

Título: [RESULTADO PENDIENTE: frase sobre T1, T3 y T6]

| KPI | Umbral | Resultado |
|---|---|---|
| T1 Latencia (mediana) | ≤ 8 s | [RESULTADO PENDIENTE: T1] |
| T2 Latencia (p95) | ≤ 15 s | [RESULTADO PENDIENTE: T2] |
| T3 Respuestas sin fallo | ≥ 95 % | [RESULTADO PENDIENTE: T3] |
| T6 Sesiones con telemetría | ≥ 90 % | [RESULTADO PENDIENTE: T6] |
| T7 Incidentes críticos | = 0 | [RESULTADO PENDIENTE: T7] |
| T9 Respuestas ancladas | ≥ 80 % | [RESULTADO PENDIENTE: T9] |

**Figura:** `graficas/t1-latencia.svg` del análisis del piloto.

**Notas del orador:** primero lo que cumple; luego lo que no, con su causa (monitor e
incidentes). T4, T5 y T8 quedan en la diapositiva de respaldo A2.

## 18. Resultados pedagógicos y de experiencia

**En la diapositiva**

Título: [RESULTADO PENDIENTE: frase con la respuesta a H1]

| KPI | Umbral | Resultado |
|---|---|---|
| P1 Reducción del tiempo hasta desbloqueo | ≥ 20 % | [RESULTADO PENDIENTE: P1, n pareados, p y correlación biserial] |
| U1 Experiencia de uso | ≥ 4,0 / 5 | [RESULTADO PENDIENTE: U1] |
| P4 Percepción de apoyo | ≥ 4,0 / 5 | [RESULTADO PENDIENTE: P4] |
| U2 SUS | ≥ 68 | [RESULTADO PENDIENTE: U2] |
| P3 Participación | ≥ 70 % | [RESULTADO PENDIENTE: P3] |

**Figura:** `graficas/p1-pareado.svg`; si hay espacio, `graficas/u1-likert.svg`.

**Notas del orador:** magnitud y significancia por separado; efecto de periodo y
cohortes: [RESULTADO PENDIENTE: análisis de Hills y Armitage].

## 19. Hallazgos y mejoras

**En la diapositiva**

1. [RESULTADO PENDIENTE: hallazgo 1 · KPI · evidencia]
2. [RESULTADO PENDIENTE: hallazgo 2 · KPI · evidencia]
3. [RESULTADO PENDIENTE: hallazgo 3 · KPI · evidencia]

Mejoras críticas implementadas: [RESULTADO PENDIENTE: P5] (umbral ≥ 65 %) ·
Límite anti-solución: [RESULTADO PENDIENTE: P6] (umbral = 100 %)

**Figura:** `graficas/p7-etapas.svg`.

**Notas del orador:** un hallazgo por frase, con su dato; cerrar con la mejora hecha.

## 20. Conclusiones por objetivo

**En la diapositiva**

| Objetivo | Estado | Evidencia |
|---|---|---|
| OE1 · Diseñar | Cumplido [por verificar con el director] | ADR-001, vistas C4, 25 KPIs†, 36 eventos†, trazabilidad |
| OE2 · Construir y desplegar | [RESULTADO PENDIENTE: T7, T8, T10] | 444 pruebas†, evidencias reproducibles, despliegue |
| OE3 · Evaluar | [RESULTADO PENDIENTE: H1, H2, H3] | Informe de KPIs del piloto |

**Notas del orador:** la fila de OE3 responde la pregunta de la diapositiva 4.

## 21. Limitaciones y trabajo futuro

**En la diapositiva**

| Limitaciones | Trabajo futuro |
|---|---|
| Muestra pequeña (potencia ≈ 0,74) | Piloto más largo y en más cursos |
| Un curso, dos lenguajes (C++ y Python) | Estado compartido para escalar el API a varias instancias |
| Arrastre y contaminación entre bloques | Reducir el contexto que envía VS Code (hoy hasta 12 000 caracteres) |
| Latencia del servidor, sin la red de la sala | Evaluar el clúster de Mac con Exo (Thunderbolt 5) |
| GPU en la nube (Spot, cupo, créditos) y Dev Tunnels | Prueba con lectores de pantalla (WCAG 2.1 AA) |

**Notas del orador:** evidencia de un piloto, no prueba general de eficacia.

## 22. Cierre

**En la diapositiva**

- Gracias
- `<backend>/empezar`
- [por verificar: enlace al repositorio, si se muestra]

**Notas del orador:** abrir las preguntas; usar el banco de A16.6 · ADACEEN-134 y las
diapositivas de respaldo.

---

## Plan B: diapositivas que reemplazan a la 17, 18 y 19

Solo si el piloto no alcanza (casos C y D del [guion](guion.md#plan-b-si-el-piloto-no-alcanza)).

### B17. Verificación técnica y ensayo

- Escenarios S1–S5: 92 de 92†; latencia del servidor: 129 ms (editor) y 147 ms
  (overlay)†; 16 de 16 eventos perdidos detectados†; ensayo técnico: todas las
  comprobaciones correctas (12 de 12†)
- Prueba de inicio a fin con 2 cuentas: [RESULTADO PENDIENTE: pasos en `ok`]
- Instalación: [RESULTADO PENDIENTE: T10 con al menos 3 personas]
- Latencia con el modelo: [RESULTADO PENDIENTE: p50 y p95 de `npm run medir:latencia`]
- Ensayo con personas (caso C): [RESULTADO PENDIENTE: hallazgos del ensayo]

### B18. La evaluación, lista para ejecutar

- Monitor → dataset → análisis → trazabilidad, probado con 12 estudiantes sintéticos†
- Sello grande: “DATOS SINTÉTICOS: no son evidencia del tutor”
- Calendario del piloto: [por verificar: fechas]

**Figura:** `docs/evidencias/ensayo-tecnico/analisis/graficas/p1-pareado.svg` con el
sello.

---

## Diapositivas de respaldo

Van después del cierre, para las preguntas del jurado. No cuentan en los 30 minutos.

### A1. Contrato de la API

- 112 rutas† en 21 módulos†, todas documentadas en
  [contrato-api.md](../arquitectura/contrato-api.md); `tests/scripts/contrato-api.test.ts`
  falla si una ruta del código no está en el documento.
- Interfaces del tutor: `POST /intervene`, `POST /suggest-tab`,
  `POST /api/suggestions/apply-check`, `POST /api/behavior/events`.

**Figura:** la tabla por módulo de `docs/evidencias/cifras-documento.md`, sección 3.

### A2. Catálogo de KPIs

- 25 KPIs†: 12 técnicos, 5 de experiencia de uso y 8 pedagógicos†
- Principales: T1, U1 y P1†
- 20 automáticos y 5 manuales (T7, T8, T10, T11 y P5)†
- 19 con umbral (5 propuestos, no están en el anteproyecto) y 6 descriptivos†

**Figura:** la tabla “Resumen” de [catalogo-kpis.md](../metricas/catalogo-kpis.md).
Después del piloto, `kpis.csv` completo.

### A3. Preparar el entorno por el relay

**Figura:** secuencia de [vistas.md](../arquitectura/vistas.md), sección 3.

**Notas:** la VM no tiene IP pública; su agente sondea `GET /api/workspaces/agent/next`
y responde por `POST /api/workspaces/agent/responses`.

### A4. Una ayuda del tutor en VS Code

**Figura:** secuencia de [vistas.md](../arquitectura/vistas.md), sección 2.

### A5. Ruta de datos y retención

**Figura:** [ruta-de-datos.svg](../arquitectura/ruta-de-datos.svg).

**Notas:** clases de dato P (personal), S (seudonimizado) y N (sin datos personales);
qué viaja por cada tramo y cuánto se guarda: [ruta-de-datos.md](../arquitectura/ruta-de-datos.md).
Si preguntan por el código: la telemetría solo guarda hashes, pero
`project_context_racks`, `project_code_actions` y `student_quizzes.code_context`
guardan fragmentos (tramo 4 y puntos 1 y 2 de “Hallazgos y pendientes para A4.3 y
A5”), sin plazo de retención todavía.

### A6. Rendimiento y costo de la inferencia

Del ADR-001, “Motivos”:

| | V100 | A100 Spot | L4 Spot |
|---|---|---|---|
| Generación | 66,5 tok/s | 83,5 tok/s | 26,5 tok/s |
| Costo aproximado | ~2,9 USD/h | ~2,2 USD/h | ~0,85 USD/h |

- 300 USD de crédito en Google Cloud; la GPU se apaga sola tras 180 min sin actividad
- VM de editores: ~0,13 USD/h
- Mac del laboratorio: mismo modelo, sin costo por hora; si es lenta, trabaja como
  respaldo de la GPU

**Figura:** [worker-mac.md](../operacion/worker-mac.md), sección 1.

### A7. Amenazas a la validez del piloto

Del [protocolo](../piloto/protocolo.md), sección 2: arrastre, dificultad distinta de
los ejercicios, contaminación, efecto Hawthorne, fallas técnicas en el bloque con
tutor, servidores de inferencia distintos, editor distinto y tamaño de muestra, cada
una con lo que se hace.

### A8. Contingencia

Del [plan de contingencia](../operacion/contingencia.md): desalojo de la GPU, falta de
cupo, arranque en frío, caída del worker, caída de Azure o de la red, VM de editores o
Dev Tunnels, datos durante un incidente y rollback. En clase, sin GPU, el tutor
responde degradado y la barra dice «GPU: sin worker activo».

### A9. Lista de cumplimiento

- 30 ítems†: privacidad y datos 12, ética de la investigación 6 y seguridad 12†
- 8 críticos† y 13 de verificación automática† (`npm run piloto:verificar`)

**Figura:** [checklist-cumplimiento.md](../piloto/checklist-cumplimiento.md).

### A10. Emparejar VS Code sin copiar y pegar

- Sesiones por tipo: `browser`, `editor` (30 días) y `cli`; entrar otra vez en el
  navegador ya no deja a VS Code sin sesión
- Código de un solo uso `XXXX-XXXX` que vence en 10 minutos; en la base solo queda su
  SHA-256
- «Con mi cuenta de GitHub (recomendado)» o «Tengo un código o sesión» (VS Code
  0.0.32)

**Figura:** [acceso-simplificado.md](../arquitectura/acceso-simplificado.md), secciones
1 a 3.
