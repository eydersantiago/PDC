# Plantillas de intervención y límites anti-solución

| | |
|---|---|
| Jira | A8.3 · ADACEEN-78 (pista), A8.4 · ADACEEN-79 (ejemplo parcial), A10.1 · ADACEEN-90 (formatos por tipo y nivel), A10.2 · ADACEEN-91 (guardarraíles) |
| Fuente de verdad | `src/services/intervention-templates.ts` (`INTERVENTION_TEMPLATES`) |
| Aplicación de la política | `src/services/decision-engine.ts` (overlay), `src/services/suggestion-policy.ts` (VS Code) |
| Pruebas | `tests/services/suggestion-policy.test.ts`, `tests/routes/tutor-scenarios.test.ts` |

Cada respuesta del tutor sigue una plantilla según su **etapa de ayuda**. La
plantilla dice qué estructura debe tener, qué límites tiene (sobre todo de
código) y qué instrucción se agrega al prompt del modelo. Los límites se
vuelven a aplicar sobre la salida del modelo, porque el modelo no siempre obedece.

## Niveles y tipos

| Nivel (A10.1) | Etapa | Tipo de intervención | Cuándo |
|---|---|---|---|
| 1 | Pista 1 (`hint_1`) | `hint` | Primera ayuda del ejercicio. |
| 2 | Pista 2 (`hint_2`) | `hint` | Segunda ayuda del ejercicio. |
| 3 | Ejemplo parcial (`partial_example`) | `example` | Tercera ayuda en adelante (nivel «Progresiva»). |
| — | Explicación breve (`explanation`) | `explanation` | Preguntas de concepto. |
| — | Mini-quiz (`mini_quiz`) | `mini_quiz` | Regla del evento con mini-quiz y el docente lo permite. |
| — | Mensaje controlado (`controlled`) | `controlled_message` | Falta contexto, consulta fuera del curso o la política no permite ayudar. |

El nivel de ayuda del docente cambia la secuencia: «Progresiva» 1 → 2 → 3;
«Solo pistas» 1 → 2 → 2…; «Ejemplo parcial» 1 → 3 → 3…. Las intervenciones
habilitadas por el docente también cuentan: sin «Ejemplo parcial» la tercera
ayuda se queda en pista 2; sin «Pista», las pistas pasan a explicación breve;
si ningún tipo habilitado sirve para el evento, se responde el mensaje controlado
(`restrictStageToAllowed`).

## Plantilla «Pista» (A8.3)

### Pista nivel 1

- **Propósito:** orientar sin dar la respuesta: señalar dónde mirar y hacer una pregunta guía.
- **Estructura:**
  1. Qué parece estar pasando (una frase, sin juzgar).
  2. Dónde mirar: la línea, el concepto o el mensaje de error relevante.
  3. Una pregunta guía que el estudiante pueda responder solo.
  4. Siguiente paso concreto y pequeño.
- **Límite de código:** 0 líneas en el overlay (el código se reemplaza por
  «_(codigo omitido: en esta etapa la ayuda es solo una pista)_»); 5 líneas en el editor.
- **Instrucción al modelo:** «Etapa de ayuda: PISTA NIVEL 1. No escribas codigo.
  Senala donde mirar, haz una pregunta guia y propone un paso pequeno.»
- **Ejemplo genérico:** «Parece que el objeto se usa antes de crearse. Mira la
  línea donde declaras el puntero: ¿en qué momento se reserva la memoria? Prueba
  imprimir su valor justo antes de usarlo.»
- **Lista anti-solución:** no contiene código; no dice la línea corregida;
  termina en una pregunta o un paso que el estudiante ejecuta.

### Pista nivel 2

- **Propósito:** pista más concreta cuando la primera no bastó: nombra la causa probable y el concepto del curso.
- **Estructura:**
  1. Causa probable, nombrando el concepto del curso (por ejemplo, encapsulamiento o referencia).
  2. Qué revisar en su código, sin reescribirlo.
  3. Cómo comprobar si el arreglo funcionó.
  4. Fuente del material autorizado, si aplica.
- **Límite de código:** 2 líneas de pseudocódigo en el overlay; 10 líneas en el editor.
- **Instrucción al modelo:** «Etapa de ayuda: PISTA NIVEL 2. Nombra la causa
  probable y el concepto del curso. Como maximo 2 lineas de pseudocodigo; nunca
  el codigo corregido del estudiante.»
- **Ejemplo genérico:** «El error viene de acceder a un atributo privado desde
  fuera de la clase (encapsulamiento, RA2). Revisa qué método público debería
  exponer ese dato y comprueba compilando otra vez.»
- **Lista anti-solución:** a lo sumo 2 líneas de pseudocódigo; no reescribe la
  función del estudiante; incluye cómo comprobar el arreglo.

## Plantilla «Ejemplo parcial» (A8.4)

- **Propósito:** mostrar el patrón con otro dominio y otros nombres, dejando el
  hueco que el estudiante debe completar.
- **Estructura:**
  1. Idea del patrón en una frase.
  2. Ejemplo corto en **otro dominio** y con **otros nombres** (máximo 8 líneas).
  3. Un comentario `TODO` donde el estudiante debe completar.
  4. Qué debe adaptar a su ejercicio.
- **Mínimo autorizado:** 8 líneas de código en el overlay. En el editor el
  ejemplo va sobre el fragmento del estudiante, hasta el máximo del docente
  (`codeApplication.maxLines`, 20 en el piloto) y con un `TODO` en la parte que
  él debe escribir.
- **Instrucción al modelo:** «Etapa de ayuda: EJEMPLO PARCIAL. Usa otro dominio
  y otros nombres que los del estudiante, maximo 8 lineas de codigo, deja un TODO
  para que el complete. Nunca resuelvas su ejercicio.»
- **Ejemplo genérico:**

  ```cpp
  class Cuenta {
    double saldo; // privado
  public:
    void depositar(double monto) {
      // TODO: valida el monto antes de sumarlo
    }
  };
  ```

- **Lista anti-solución:**
  - [ ] Máximo 8 líneas de código.
  - [ ] Nombres y dominio distintos a los del estudiante.
  - [ ] Deja al menos un `TODO`.
  - [ ] No se puede pegar tal cual en el ejercicio del estudiante.

## Otras plantillas

| Etapa | Estructura | Límite de código (overlay / editor) | Lista anti-solución |
|---|---|---|---|
| Explicación breve | Definición en 1 o 2 frases con palabras del curso; por qué importa en su ejercicio; un ejemplo mínimo o una analogía; fuente del material autorizado. Máximo 5 frases. | 4 / 4 | Máximo 4 líneas; cita la fuente cuando existe. |
| Mini-quiz | Una pregunta sobre el concepto o el cambio; 3 a 5 opciones, una correcta; explicación que se muestra después de contestar. | 6 / 6 | La respuesta correcta no aparece antes de contestar. |
| Mensaje controlado | Por qué no se puede ayudar todavía (motivo corto); qué contexto hace falta (enunciado, error visible o fragmento). | 0 / 0 | Sin código; no inventa datos del ejercicio. |

El mini-quiz de VS Code (tras aceptar una sugerencia o lanzado por el docente)
tiene su propio formato en `src/services/quiz.ts` y un banco de respaldo
validado: ver [banco-quiz.md](banco-quiz.md).

## Formato en VS Code

`/suggest-tab` responde en Markdown con secciones fijas que la extensión
entiende: `1) Resumen`, `2) Sugerencias del archivo`, `3) Sugerencias del
codigo`, `4) Accion` con la línea `Aplicar: insert | replace | delete` y el
bloque de código, y `5) Riesgos`. La instrucción de la etapa para el editor
(`editorStageInstruction`) no prohíbe el código, porque sin código no habría
nada que aplicar ni mini-quiz después de aceptar; lo que gradúa es el tamaño
del cambio: 5 líneas en la pista 1, 10 en la pista 2 y el máximo del docente
desde el ejemplo parcial. El máximo del docente siempre manda.

## Guardarraíles (A10.2)

| Dónde | Qué hace | Código |
|---|---|---|
| Prompt | Agrega la instrucción de la etapa, «Nunca entregues la solucion completa del ejercicio» y la política del docente (resultado de aprendizaje, tono, nivel, límite de pistas, nota docente). | `buildMentorPrompt`, `buildSuggestionPolicyInstruction` |
| Salida del overlay | Recorta cada bloque de código de ideas, búsquedas y guía al límite de la etapa; con límite 0 lo reemplaza por «código omitido». | `applyTemplateLimits` |
| Salida del editor | Recorta cada bloque al límite de la etapa y, si recortó o no se puede aplicar código, **quita la línea «Aplicar:»** (con sus variantes: viñetas, «Acción:», comillas invertidas, tildes). La respuesta marca `code_application.allowed = false` con `code_application_too_large`. | `applySuggestionGuardrail` |
| Aplicación de código | Antes de escribir en el archivo, VS Code consulta `POST /api/suggestions/apply-check`: tamaño máximo, aplicación desactivada, cupo por archivo y confirmación del estudiante. | `checkCodeApplication`, `src/code-application-guard.ts` (VS Code) |
| Sin contexto o fuera del curso | Mensaje controlado del docente sin llamar al modelo. | `buildControlledResult`, `buildControlledSuggestionMarkdown` |
| Sin modelo | Overlay: respuesta heurística; editor: mensaje controlado sin código (`degraded: true`); quiz: banco validado. | `buildHeuristicMentorResult`, `buildUnavailableSuggestionMarkdown`, `pickQuizFromBank` |
| Límite de pistas | Overlay: bloqueo al llegar al máximo por ejercicio. Editor: la sugerencia sigue como guía, sin «Aplicar». | `evaluateMentorIntervention`, `describeCodeApplication` |

Las pruebas de casos negativos (A10.5) comprueban que una «solución completa»
de 40 líneas sale recortada al límite de la etapa, que «Aplicar:» desaparece en
todas sus variantes, que los mensajes controlados no llaman al modelo y que la
traza no guarda datos sensibles (ver [escenarios.md](escenarios.md)).
