# Matriz escenario / política → recurso autorizado

| | |
|---|---|
| Jira | A8.6 · ADACEEN-81 |
| Datos | `data/rag/matriz-escenario-recurso.json` (versión 1.0, 2026-09-23) |
| Código | `src/services/scenario-resources.ts` (`prioritizeRagSourcesForScenario`) |
| Pruebas | `tests/services/quiz-bank-and-matrix.test.ts` |
| Curso | 750015C Fundamentos de Programacion Orientada a Objetos (FPOO 2026-1) |

La matriz dice qué material autorizado del curso conviene mostrar primero en
cada escenario (ver [escenarios.md](escenarios.md)). El motor (overlay y
VS Code) ya busca las fuentes RAG del curso por similitud con la pregunta; la matriz
**no agrega ni quita fuentes**: solo pone primero, entre las encontradas, las
que recomienda para el evento de política y las palabras del contexto. Así el
tutor cita, por ejemplo, la semana de «Polimorfismo» ante una duda de
polimorfismo aunque otro documento tenga más palabras en común.

## Cómo se aplica

1. El motor detecta el evento de política (`compile_error`, `concept_question`…).
2. `matchScenarioRules` toma las reglas de ese evento cuyas palabras aparecen en
   la pregunta, el error visible, la selección o el título de la actividad
   (sin tildes ni mayúsculas). Si ninguna coincide, usa las reglas del evento
   sin palabras (la de S5).
3. `prioritizeRagSourcesForScenario` pone primero las fuentes encontradas cuyo
   `metadata.id` coincide con un recurso de esas reglas (o cuyo título coincide),
   en el orden de la matriz; el resto conserva su orden.
4. El prompt y las citas usan ese orden (`buildRagPromptBlock`,
   `ensureMentorResultRagCitations`). En VS Code (`/suggest-tab`) se aplica
   igual a las fuentes que acompañan la sugerencia.

## Reglas vigentes

| Escenario | Eventos | Tema | Palabras que la activan | Recursos (en orden) |
|---|---|---|---|---|
| S1 | `compile_error` | Compilacion, tipos y ambitos (RA1) | compil, was not declared, undefined reference, no matching, expected, include, tipo, scope, ambito | `RAG-FPOO-02` Semana 2 (18-02-2026) - Programación orientada a objetos: El proceso de compilación, el hardware y los ámbitos de un programa<br>`RAG-FPOO-01` Semana 1 (11-02-2026) - Programación orientada a objetos: Uso del lenguaje de programación C++ sus tipos de datos básicos<br>`RAG-FPOO-BIB-04` Bibliografía FPOO - Thinking in C++, Volume 1 |
| S1 | `compile_error`, `runtime_error`, `concept_question` | Referencias, punteros y memoria (RA1) | puntero, pointer, referencia, reference, new, delete, nullptr, segmentation, vector | `RAG-FPOO-03` Semana 3 (25-02-2026) - Programa básico en C++ con vectores y referencias<br>`RAG-FPOO-BIB-04` Bibliografía FPOO - Thinking in C++, Volume 1<br>`RAG-FPOO-BIB-06` Bibliografía FPOO - Standard Template Library Programmer's Guide |
| S2 | `runtime_error` | Depuracion y pruebas unitarias (RA4) | traceback, exception, assert, test, prueba, segmentation, core dumped, index, keyerror, typeerror | `RAG-FPOO-09` Semana 7 (20-05-2026) - Ejercicio completo: abstracción, diseño, implementación y test<br>`RAG-FPOO-11` Semana 8 (27-05-2026) - Ejercicio: librerias, APis, Modulos y refactoring \| Nutrición<br>`RAG-FPI-BIB-02` Bibliografía FPI - Introducción a la programación con Python |
| S3 | `concept_question`, `compile_error` | Clases, encapsulamiento e interfaz publica (RA2) | encapsul, clase, class, objeto, atributo, private, privado, public, constructor, getter, setter | `RAG-FPOO-06` Semana 5 (11-03-2026) - Pilares del Paradigma OO. Conceptos y código en C++ (Clase invertida)<br>`RAG-FPOO-07` Semana 5 (11-03-2026) - Implementación de una clase: abstacción y encapsulamiento<br>`RAG-FPOO-17` Bibliografía - Conceptos Básicos, Fundamentos de Programación Orientada a Objetos |
| S3 | `concept_question`, `design_block` | Herencia (RA3) | herenc, hereda, inherit, base, derivada, override, super, protected | `RAG-FPOO-14` Semana 11 (17-06-2026) - Herencia<br>`RAG-FPOO-06` Semana 5 (11-03-2026) - Pilares del Paradigma OO. Conceptos y código en C++ (Clase invertida) |
| S3 | `concept_question`, `design_block`, `code_suggestion` | Polimorfismo para evitar condicionales por tipo (RA3) | polimorf, virtual, instanceof, isinstance, typeid, switch, dynamic_cast, if tipo | `RAG-FPOO-15` Semana 12 (24-06-2026) - Polimorfismo<br>`RAG-FPOO-16` Bibliografía - Cipriano & Alves (2024), LLMs Still Can't Avoid Instanceof |
| S4 | `design_block` | Analisis OO, historias de usuario y relaciones entre clases (RA3) | diseno, diagrama, relacion, responsabilidad, historia de usuario, uml, enunciado, modelar, asociacion, composicion | `RAG-FPOO-08` Semana 6 (13-05-2026) - HUs, Diagrama de clases y relación de uso \| Ejercicio completo: abstracción, diseño e implementación \| Registro de Medicamentos<br>`RAG-FPOO-12` Semana 10 (10-06-2026) - Abstraer relaciones de diferente tipo<br>`RAG-FPOO-13` Semana 10 (10-06-2026) - Discusión podcast e implementación de relaciones<br>`RAG-FPOO-BIB-01` Bibliografía FPOO - SOLID y GRASP. Buenas prácticas hacia el éxito en el desarrollo de software |
| S4 | `code_suggestion`, `design_block` | Modulos, librerias, estilo y refactoring (RA4) | refactor, modulo, libreria, api, estilo, documentacion, nombre, duplicado, solid, grasp | `RAG-FPOO-11` Semana 8 (27-05-2026) - Ejercicio: librerias, APis, Modulos y refactoring \| Nutrición<br>`RAG-FPOO-BIB-01` Bibliografía FPOO - SOLID y GRASP. Buenas prácticas hacia el éxito en el desarrollo de software |
| S5 | `insufficient_context`, `out_of_domain` | Contexto insuficiente o fuera del curso | (ninguna: se usa cuando no coincide otra regla del evento) | `RAG-FPOO-PDF-02` Programa del curso FPOO<br>`RAG-FPOO-PDF-01` Bitácora FPOO 2026-1 |

Los identificadores `RAG-…` son los de `data/rag/rag_sources_seed.jsonl`
(fuentes semilla del curso). Una fuente que el docente carga después aparece en
la matriz si se agrega su id o su título.

## Cómo actualizarla

1. Edita `data/rag/matriz-escenario-recurso.json`: cada regla tiene
   `escenario`, `eventos` (eventos de política), `tema`, `palabras` (raíces sin
   tildes, en minúsculas) y `recursos` (`id` y `titulo` de la fuente).
2. Sube `version` y `actualizado`.
3. Corre `npm test`: la prueba comprueba que todas las reglas tienen eventos y
   recursos, que S1 y S5 se activan con los casos de ejemplo y que el orden
   resultante es el esperado.
4. El backend lee el archivo al arrancar (se guarda en memoria): reinicia o
   despliega para que tome el cambio.

La validación pedagógica de la matriz con el docente es parte de A8.7
(ADACEEN-82).
