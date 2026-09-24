# Escenarios del tutor (S1–S5)

| | |
|---|---|
| Jira | A9.5 · ADACEEN-87 (pruebas por escenario), A11.4 · ADACEEN-100 (demo reproducible), A10.7 · ADACEEN-96 (evidencia) |
| Definición en código | `src/services/tutor-scenarios.ts` (la misma que usan las pruebas y la demo) |
| Pruebas | `tests/routes/tutor-scenarios.test.ts`, `tests/services/suggestion-policy.test.ts` |
| Demo y evidencia | `npm run demo:escenarios` → [evidencia](../evidencias/demo-escenarios.md) |
| Política con que se evalúan | «RF-05 base del piloto» (`src/db/seeds.ts`) |

Un escenario es una situación típica del estudiante en el curso FPOO con la
respuesta que el tutor debe dar según la política del docente. Los cinco
escenarios cubren los eventos de política del motor y los dos casos en que el
tutor no debe responder con el modelo (falta de contexto y consulta fuera del
curso). Cada escenario tiene una petición del overlay (`POST /intervene`) y,
cuando aplica, una del editor (`POST /suggest-tab`).

## Resumen

| Id | Escenario | Evento de política | Etapa esperada | ¿Llama al modelo? | Motivo (`reason_code`) |
|---|---|---|---|---|---|
| S1 | Error de compilación (C++) | `compile_error` | Pista 1 (`hint_1`) | Sí | `ok` |
| S2 | Falla en ejecución o prueba (Python) | `runtime_error` | Pista 1 | Sí | `ok` |
| S3 | Pregunta conceptual (polimorfismo) | `concept_question` | Explicación breve (`explanation`) | Sí | `ok` |
| S4 | Bloqueo de diseño (responsabilidades, relaciones) | `design_block` | Pista 1 | Sí | `ok` |
| S5a | Contexto insuficiente | `insufficient_context` | Mensaje controlado (`controlled`) | No | `insufficient_context` |
| S5b | Fuera del dominio del curso | `out_of_domain` | Mensaje controlado | No | `out_of_domain` |

S5a solo existe en el overlay: en el editor siempre hay un archivo abierto y
`/suggest-tab` rechaza con 400 una petición sin contenido.

## Definición operativa

### S1 · Error de compilación

- **Señales:** un error del compilador visible (en la página, en la terminal o
  en los diagnósticos del editor) y el código del archivo.
- **Ejemplo:** `src/cuenta.cpp:6:48: error: expected ';' before '}' token`
  sobre una clase `Cuenta` con un método `depositar` sin punto y coma.
- **Respuesta esperada:** pista 1 (dónde mirar y una pregunta guía). En el
  overlay sin código; en el editor, como máximo un cambio de 5 líneas que el
  estudiante puede aplicar con confirmación.
- **No debe pasar:** que el tutor devuelva la clase corregida completa.

### S2 · Falla en ejecución o prueba

- **Señales:** el programa compila pero falla al ejecutar o en una prueba:
  traza (`Traceback`), excepción, `Segmentation fault`, `ZeroDivisionError`,
  `NullPointerException`…
- **Ejemplo:** `promedio([])` en Python termina en `ZeroDivisionError: division by zero`.
- **Respuesta esperada:** pista 1 que nombre la causa probable y cómo comprobarla.
- **No debe pasar:** que la ayuda reescriba la función del estudiante.

### S3 · Pregunta conceptual

- **Señales:** una pregunta sobre un concepto del curso (encapsulamiento,
  herencia, polimorfismo, clase, objeto, constructor, referencia, puntero…).
- **Ejemplo:** «¿Qué es el polimorfismo en POO?» en la actividad «Taller 3 - Polimorfismo».
- **Respuesta esperada:** explicación breve (máximo 5 frases), un ejemplo de
  hasta 4 líneas y la cita del material autorizado. La matriz escenario-recurso
  pone primero la semana 12 «Polimorfismo» (`RAG-FPOO-15`).
- **No debe pasar:** una explicación sin fuente cuando el material la tiene.

### S4 · Bloqueo de diseño

- **Señales:** el estudiante no sabe cómo pasar el enunciado a clases,
  responsabilidades o relaciones.
- **Ejemplo:** «¿Cómo organizo las responsabilidades del enunciado del taller?»
  con el enunciado seleccionado.
- **Respuesta esperada:** pista 1 sobre responsabilidades y relaciones, con el
  material de análisis OO (`RAG-FPOO-08`, `RAG-FPOO-12`, `RAG-FPOO-13`).
- **No debe pasar:** el diagrama o el diseño resuelto.

### S5a · Contexto insuficiente

- **Señales:** ninguna: sin actividad, archivo, error, selección ni código
  (por ejemplo, solo «Ayúdame» en una página desconocida).
- **Respuesta esperada:** el mensaje controlado del docente y qué contexto
  falta. No se llama al modelo.
- **No debe pasar:** una respuesta inventada.

### S5b · Fuera del dominio del curso

- **Señales:** una pregunta que no habla del curso ni de programación, sobre
  una página o un archivo que no es código.
- **Ejemplo:** «¿Cuál es la capital de Francia?» en el foro de bienvenida, o
  sobre un archivo `mercado.txt` en el editor.
- **Respuesta esperada:** el mensaje controlado del docente. No se llama al modelo.
- **No debe pasar:** que el tutor responda la pregunta.

## Cómo decide el motor

Los dos canales usan la misma política del docente, pero cada uno detecta el
evento con las señales que tiene.

**Overlay** (`detectEventType` en `src/services/decision-engine.ts`), en este orden:

1. Sin señales, o página desconocida sin código → `insufficient_context`.
2. La pregunta, la actividad, el archivo y el error visible no mencionan
   ningún tema permitido ni palabra del curso → `out_of_domain`. Un error
   visible cuenta como evidencia de que la consulta es del curso.
3. El error visible parece de compilación (`syntaxerror`, `undefined reference`,
   `was not declared`, `expected … before`, `no matching function`, `cannot find`…) → `compile_error`.
4. El error parece de ejecución (`traceback`, `exception`, `segmentation fault`…) → `runtime_error`.
5. La pregunta habla de GitHub, Codespaces, ramas, commits o diff (palabras completas) → `workflow_guidance`.
6. La pregunta habla de un concepto (clase, objeto, encapsulamiento, herencia, polimorfismo…) → `concept_question`.
7. La pregunta habla de diseño (diseño, enunciado, diagrama, responsabilidad…) → `design_block`.
8. Queda un error visible no reconocido → `compile_error`; si no, flujo de trabajo en GitHub y concepto en las demás páginas.

**Editor** (`classifySuggestionEvent` en `src/services/suggestion-policy.ts`):

1. Sin contenido → `insufficient_context`.
2. Hay un error (visible o en los diagnósticos) → `runtime_error` si parece de ejecución; si no, `compile_error`.
3. La pregunta no tiene palabras de programación y el archivo no es código → `out_of_domain`.
4. Concepto → `concept_question`; diseño → `design_block`.
5. Lo demás → `code_suggestion` (sugerencia sobre el archivo activo).

Después, en los dos canales:

- **Regla del evento:** si el docente la desactivó, o faltan señales para su
  umbral de activación, la respuesta es el mensaje controlado (`rule_disabled`,
  `insufficient_context`).
- **Mensaje controlado sin modelo:** `insufficient_context` y `out_of_domain`
  usan la intervención `controlled_message`: responde el mensaje del docente y
  no se consulta al modelo («no inventar»).
- **Etapa de ayuda** (`resolveHelpStage` en `src/services/intervention-templates.ts`):
  con nivel progresivo, pista 1 → pista 2 → ejemplo parcial según las ayudas
  ya usadas en el ejercicio. En el overlay cuentan las pistas servidas; en el
  editor, los cambios de código ya aplicados en el archivo. La etapa respeta las
  intervenciones habilitadas por el docente.
- **Límite de pistas:** en el overlay, al llegar a `maxHintsPerExercise` (3 en
  el piloto) el tutor bloquea con `hint_limit_reached`. En el editor la
  sugerencia sigue como guía, pero ya no se puede aplicar código
  (`code_application_limit_reached`).
- **Guardarraíl:** la salida del modelo se recorta a los límites de la etapa;
  en el editor, si el código se recortó o no se puede aplicar, se quita la línea
  «Aplicar:» para que VS Code no ofrezca aplicar un cambio incompleto.

Las plantillas y los límites de cada etapa están en
[plantillas-intervencion.md](plantillas-intervencion.md); los recursos que se
priorizan en cada escenario, en [matriz-escenario-recurso.md](matriz-escenario-recurso.md).

## Casos límite cubiertos por las pruebas

| Caso | Resultado esperado | Prueba |
|---|---|---|
| Error visible y pregunta conceptual a la vez (editor) | Manda el error: `compile_error`. | `suggestion-policy.test.ts` |
| Pregunta sin palabras de programación sobre un archivo de código | Sigue siendo del curso: `code_suggestion`. | `suggestion-policy.test.ts` |
| «diagrama» contiene «rama»; «crear una rama» | El primero es diseño y el segundo flujo de trabajo (límites de palabra). | `tutor-scenarios.test.ts` (casos límite de detección) |
| Pregunta sin palabras del curso con un error en pantalla | Cuenta como del curso: `runtime_error`, no `out_of_domain`. | `tutor-scenarios.test.ts` (casos límite de detección) |
| Cuarta ayuda en el mismo ejercicio (overlay) | Bloqueo con `hint_limit_reached`, sin llamar al modelo. | `tutor-scenarios.test.ts` |
| El modelo devuelve 14 líneas de código en la pista 1 | Overlay: «código omitido»; editor: 5 líneas, sin «Aplicar:». | `tutor-scenarios.test.ts` |
| Cambio de 25 líneas en apply-check | Bloqueado con `code_application_too_large`; no gasta cupo. | `tutor-scenarios.test.ts` |
| Cuarta aplicación en el mismo archivo | Bloqueada con `code_application_limit_reached`. | `tutor-scenarios.test.ts` |
| Regla del evento desactivada | Mensaje controlado con `rule_disabled`. | `suggestion-policy.test.ts` |
| Ningún tipo de intervención habilitado sirve | Mensaje controlado con `rule_disabled`. | `suggestion-policy.test.ts` |
| El modelo falla | Overlay: respuesta heurística; editor: `degraded: true` y mensaje controlado; motivo `model_error_fallback`. | `tutor-scenarios.test.ts` |
| Cola sin worker vivo (latidos vencidos) | No se encola el job: respuesta degradada en segundos y `/api/agent/health` en 503. | `tutor-scenarios.test.ts` |
| Traza de decisiones | Una `tutor_decision` por respuesta, sin ids, correos, rutas, código ni texto del error. | `tutor-scenarios.test.ts` |

## Cómo reproducirlo

```bash
npm test                                     # pruebas automáticas (sin GPU)
npm run demo:escenarios -- --salida=docs/evidencias/demo-escenarios.md
```

La demo levanta el backend con una base en memoria, usuarios y política de
demostración y una **salida de referencia del modelo** que siempre trae más
código del permitido, para que se vea el recorte. Con `--modelo-real` usa el
modelo configurado en `AGENT_TARGET`; con `--url=<backend> --email=<estudiante>
--password=<clave>` corre contra un backend desplegado (los eventos quedan en
esa base: la demo imprime la ventana de tiempo para excluirla del análisis).
