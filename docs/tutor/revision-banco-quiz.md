# Revisión docente del banco de preguntas del mini-quiz

> Generado con `npm run quiz:revision` desde `data/quiz/banco-fpoo.json` (versión 1.0, 2026-09-23). Si el banco cambia, se regenera.

| | |
|---|---|
| Jira | A8.7 · ADACEEN-82 (validación docente y proceso de actualización) |
| Curso | 750015C Fundamentos de Programacion Orientada a Objetos |
| Preguntas | 17 |
| Proceso | [banco-quiz.md](banco-quiz.md), sección «Cómo actualizar el banco» |

Para cada pregunta, marque una decisión y escriba los cambios si los hay. Criterios: la respuesta marcada es la única correcta; la pregunta es clara y del nivel del curso; la explicación enseña el concepto y no solo da la respuesta; la pregunta abierta invita a explicar con sus palabras.

## RA1-01 · RA1 · referencias en C++

**Pregunta** (cpp): En C++: `int a = 5; int& r = a; r = 8;` ¿Cuánto vale `a` después?

| Opción | Texto | Correcta |
|---|---|---|
| A | 8 | ✔ |
| B | 5 |  |
| C | Error de compilación |  |
| D | Un valor indefinido |  |

**Explicación:** `r` es una referencia: otro nombre para la misma variable `a`. Asignar a `r` cambia `a`.

**Pregunta abierta:** Explica con tus palabras qué diferencia hay entre una referencia y una copia.

| Decisión | ☐ Aprobada | ☐ Aprobada con cambios | ☐ Descartar |
|---|---|---|---|
| Cambios o comentarios | | | |

## RA1-02 · RA1 · paso por valor en C++

**Pregunta** (cpp): En C++: `void duplicar(int x) { x = x * 2; }` y en `main`: `int n = 4; duplicar(n);` ¿Cuánto vale `n` al final?

| Opción | Texto | Correcta |
|---|---|---|
| A | 4 | ✔ |
| B | 8 |  |
| C | 0 |  |
| D | No compila |  |

**Explicación:** El parámetro se pasa por valor: `x` es una copia de `n`, así que `n` no cambia. Con `int& x` sí cambiaría.

**Pregunta abierta:** ¿Cómo cambiarías la firma de `duplicar` para que modifique `n`, y por qué?

| Decisión | ☐ Aprobada | ☐ Aprobada con cambios | ☐ Descartar |
|---|---|---|---|
| Cambios o comentarios | | | |

## RA1-03 · RA1 · new y delete

**Pregunta** (cpp): En C++, después de `int* p = new int(3); delete p;` ¿qué es cierto?

| Opción | Texto | Correcta |
|---|---|---|
| A | La memoria del entero se liberó y `p` quedó apuntando a una dirección que ya no es válida | ✔ |
| B | `p` pasa a valer `nullptr` automáticamente |  |
| C | Se borra la variable `p` |  |
| D | Se llama al destructor de la clase `int*` |  |

**Explicación:** `delete` libera la memoria, pero no cambia el valor de `p`: queda como puntero colgante. Por eso conviene asignarle `nullptr` después.

**Pregunta abierta:** ¿Qué problema puede aparecer si usas `p` después de `delete p`?

| Decisión | ☐ Aprobada | ☐ Aprobada con cambios | ☐ Descartar |
|---|---|---|---|
| Cambios o comentarios | | | |

## RA1-04 · RA1 · referencias en Python

**Pregunta** (python): En Python: `a = [1, 2]`, `b = a`, `b.append(3)`. ¿Qué imprime `print(a)`?

| Opción | Texto | Correcta |
|---|---|---|
| A | [1, 2, 3] | ✔ |
| B | [1, 2] |  |
| C | [3] |  |
| D | Un error |  |

**Explicación:** `b = a` no copia la lista: ambos nombres referencian el mismo objeto. Para copiar se usa `a.copy()` o `list(a)`.

**Pregunta abierta:** ¿Cómo harías que `b` fuera una copia independiente de `a`?

| Decisión | ☐ Aprobada | ☐ Aprobada con cambios | ☐ Descartar |
|---|---|---|---|
| Cambios o comentarios | | | |

## RA2-01 · RA2 · visibilidad por defecto

**Pregunta** (cpp): En C++: `class Cuenta { double saldo; public: void depositar(double m); };` ¿Qué visibilidad tiene `saldo`?

| Opción | Texto | Correcta |
|---|---|---|
| A | private | ✔ |
| B | public |  |
| C | protected |  |
| D | Depende del compilador |  |

**Explicación:** En una `class`, los miembros son `private` hasta que aparece otra etiqueta. En un `struct` serían `public`.

**Pregunta abierta:** ¿Por qué conviene que `saldo` sea privado en esta clase?

| Decisión | ☐ Aprobada | ☐ Aprobada con cambios | ☐ Descartar |
|---|---|---|---|
| Cambios o comentarios | | | |

## RA2-02 · RA2 · encapsulamiento

**Pregunta** (cualquier lenguaje): ¿Cuál es la principal ventaja del encapsulamiento?

| Opción | Texto | Correcta |
|---|---|---|
| A | El objeto controla cómo cambia su estado a través de su interfaz pública | ✔ |
| B | El programa se ejecuta más rápido |  |
| C | Permite heredar de varias clases a la vez |  |
| D | Evita tener que escribir constructores |  |

**Explicación:** Al ocultar los atributos y exponer métodos, la clase puede validar los cambios (por ejemplo, no permitir un saldo negativo).

**Pregunta abierta:** Da un ejemplo de una regla que un método podría validar gracias al encapsulamiento.

| Decisión | ☐ Aprobada | ☐ Aprobada con cambios | ☐ Descartar |
|---|---|---|---|
| Cambios o comentarios | | | |

## RA2-03 · RA2 · atributos internos en Python

**Pregunta** (python): En Python, ¿qué significa el guion bajo en `self._saldo`?

| Opción | Texto | Correcta |
|---|---|---|
| A | Es una convención: el atributo es de uso interno, aunque Python no impide leerlo | ✔ |
| B | Python lanza un error si se usa desde fuera de la clase |  |
| C | Lo convierte en un atributo estático |  |
| D | Lo vuelve constante |  |

**Explicación:** Python no tiene `private` como C++: `_` avisa que es interno y `__` activa el name mangling, pero ninguno es una barrera real.

**Pregunta abierta:** ¿Cómo expondrías el saldo para leerlo sin permitir cambiarlo directamente?

| Decisión | ☐ Aprobada | ☐ Aprobada con cambios | ☐ Descartar |
|---|---|---|---|
| Cambios o comentarios | | | |

## RA2-04 · RA2 · constructores

**Pregunta** (cpp): ¿Para qué sirve el constructor de una clase?

| Opción | Texto | Correcta |
|---|---|---|
| A | Para dejar el objeto en un estado válido desde que se crea | ✔ |
| B | Para liberar la memoria del objeto |  |
| C | Para copiar la clase en otra |  |
| D | Para declarar los métodos virtuales |  |

**Explicación:** El constructor inicializa los atributos al crear el objeto. Liberar recursos es tarea del destructor.

**Pregunta abierta:** ¿Qué pasaría si una clase `Cuenta` no inicializara su saldo en el constructor?

| Decisión | ☐ Aprobada | ☐ Aprobada con cambios | ☐ Descartar |
|---|---|---|---|
| Cambios o comentarios | | | |

## RA3-01 · RA3 · metodos virtuales

**Pregunta** (cpp): `Figura` declara `virtual double area() const;` y `Circulo` la redefine. Con `Figura* f = new Circulo(2); f->area();` ¿qué versión se ejecuta?

| Opción | Texto | Correcta |
|---|---|---|
| A | Circulo::area | ✔ |
| B | Figura::area |  |
| C | Ninguna: no compila |  |
| D | Depende del orden de los includes |  |

**Explicación:** Con `virtual`, la llamada se resuelve en tiempo de ejecución según el tipo real del objeto (despacho dinámico).

**Pregunta abierta:** ¿Qué ventaja tiene poder guardar distintas figuras en un `vector<Figura*>`?

| Decisión | ☐ Aprobada | ☐ Aprobada con cambios | ☐ Descartar |
|---|---|---|---|
| Cambios o comentarios | | | |

## RA3-02 · RA3 · enlace estatico

**Pregunta** (cpp): Si en el caso anterior `area` NO fuera `virtual`, ¿qué se ejecutaría con `f->area()`?

| Opción | Texto | Correcta |
|---|---|---|
| A | Figura::area, porque se decide por el tipo del puntero | ✔ |
| B | Circulo::area |  |
| C | Se lanza una excepción |  |
| D | Error de compilación |  |

**Explicación:** Sin `virtual`, el compilador elige el método según el tipo declarado del puntero (enlace estático).

**Pregunta abierta:** ¿Cómo comprobarías en tu código si un método se está resolviendo de forma estática o dinámica?

| Decisión | ☐ Aprobada | ☐ Aprobada con cambios | ☐ Descartar |
|---|---|---|---|
| Cambios o comentarios | | | |

## RA3-03 · RA3 · polimorfismo en lugar de condicionales

**Pregunta** (cualquier lenguaje): Un programa calcula áreas con `if (tipo == "circulo") ... else if (tipo == "cuadrado") ...`. ¿Qué propone la programación orientada a objetos?

| Opción | Texto | Correcta |
|---|---|---|
| A | Que cada clase implemente su propio `area()` y se llame sin preguntar el tipo | ✔ |
| B | Agregar un `else if` por cada figura nueva |  |
| C | Guardar el tipo en una variable global |  |
| D | Convertir todo en funciones estáticas |  |

**Explicación:** Con polimorfismo, agregar una figura nueva no obliga a modificar los condicionales existentes (RA3: evitar condicionales por tipo).

**Pregunta abierta:** ¿Qué archivo o clase tendrías que tocar para agregar un triángulo en cada una de las dos soluciones?

| Decisión | ☐ Aprobada | ☐ Aprobada con cambios | ☐ Descartar |
|---|---|---|---|
| Cambios o comentarios | | | |

## RA3-04 · RA3 · composicion

**Pregunta** (cualquier lenguaje): "Un Carro tiene un Motor, y ese motor no existe sin el carro". ¿Qué relación es?

| Opción | Texto | Correcta |
|---|---|---|
| A | Composición | ✔ |
| B | Herencia |  |
| C | Dependencia de uso |  |
| D | Polimorfismo |  |

**Explicación:** Composición: la parte (Motor) vive y muere con el todo (Carro). Herencia sería "un Motor es un Carro", que no tiene sentido.

**Pregunta abierta:** ¿Cómo representarías esta relación en código C++ o Python?

| Decisión | ☐ Aprobada | ☐ Aprobada con cambios | ☐ Descartar |
|---|---|---|---|
| Cambios o comentarios | | | |

## RA3-05 · RA3 · herencia

**Pregunta** (cualquier lenguaje): ¿Cuándo es adecuado que la clase B herede de la clase A?

| Opción | Texto | Correcta |
|---|---|---|
| A | Cuando B "es un" A y puede usarse en cualquier lugar donde se espera un A | ✔ |
| B | Cuando B necesita llamar a un método de A |  |
| C | Cuando A y B tienen atributos con el mismo nombre |  |
| D | Siempre que se quiera reutilizar algo de código |  |

**Explicación:** La herencia modela "es un" y exige que la subclase pueda sustituir a la base. Para reutilizar código sin esa relación, suele ser mejor la composición.

**Pregunta abierta:** Da un ejemplo de tu curso donde la herencia sí tenga sentido y otro donde no.

| Decisión | ☐ Aprobada | ☐ Aprobada con cambios | ☐ Descartar |
|---|---|---|---|
| Cambios o comentarios | | | |

## RA4-01 · RA4 · pruebas unitarias

**Pregunta** (python): En una prueba: `assert suma(2, 3) == 5`. Si `suma` devuelve 6, ¿qué pasa?

| Opción | Texto | Correcta |
|---|---|---|
| A | Se lanza `AssertionError` y la prueba falla | ✔ |
| B | Se imprime 6 y sigue |  |
| C | La línea se ignora |  |
| D | Devuelve False sin avisar |  |

**Explicación:** `assert` detiene la prueba con `AssertionError` cuando la condición es falsa; así el framework la marca como fallida.

**Pregunta abierta:** ¿Qué otros dos casos de prueba agregarías para la función `suma`?

| Decisión | ☐ Aprobada | ☐ Aprobada con cambios | ☐ Descartar |
|---|---|---|---|
| Cambios o comentarios | | | |

## RA4-02 · RA4 · proposito de las pruebas

**Pregunta** (cualquier lenguaje): ¿Para qué sirve una prueba unitaria?

| Opción | Texto | Correcta |
|---|---|---|
| A | Para verificar automáticamente el comportamiento de una unidad (función o método) con entradas conocidas | ✔ |
| B | Para medir la velocidad del programa |  |
| C | Para reemplazar la compilación |  |
| D | Para documentar la interfaz gráfica |  |

**Explicación:** Una prueba unitaria fija qué debe devolver una unidad ante ciertas entradas y avisa si un cambio lo rompe.

**Pregunta abierta:** ¿Qué harías primero si una prueba que antes pasaba empieza a fallar?

| Decisión | ☐ Aprobada | ☐ Aprobada con cambios | ☐ Descartar |
|---|---|---|---|
| Cambios o comentarios | | | |

## RA4-03 · RA4 · depuracion de segmentation fault

**Pregunta** (cpp): Un programa en C++ termina con "Segmentation fault". ¿Cuál es la causa más probable?

| Opción | Texto | Correcta |
|---|---|---|
| A | Un acceso a memoria inválida: puntero nulo o colgante, o índice fuera de rango | ✔ |
| B | Un error de sintaxis |  |
| C | Falta un `#include` |  |
| D | Una división entre enteros |  |

**Explicación:** Los errores de sintaxis e includes los detecta el compilador; el segfault ocurre al ejecutar, al tocar memoria que no es tuya.

**Pregunta abierta:** ¿Qué pasos seguirías para encontrar la línea exacta que produce el fallo?

| Decisión | ☐ Aprobada | ☐ Aprobada con cambios | ☐ Descartar |
|---|---|---|---|
| Cambios o comentarios | | | |

## RA4-04 · RA4 · estilo y nombres

**Pregunta** (cualquier lenguaje): ¿Cuál es el mejor nombre para un método que devuelve el saldo de una cuenta?

| Opción | Texto | Correcta |
|---|---|---|
| A | obtenerSaldo() | ✔ |
| B | x() |  |
| C | hacer() |  |
| D | saldo2() |  |

**Explicación:** Un nombre que dice qué hace el método hace el código legible y reduce la necesidad de comentarios (RA4: estilo y documentación).

**Pregunta abierta:** Elige un nombre de tu proyecto que podrías mejorar y explica por qué.

| Decisión | ☐ Aprobada | ☐ Aprobada con cambios | ☐ Descartar |
|---|---|---|---|
| Cambios o comentarios | | | |

## Firma

| Docente | Fecha | Preguntas aprobadas | Con cambios | Descartadas |
|---|---|---|---|---|
| | | | | |
