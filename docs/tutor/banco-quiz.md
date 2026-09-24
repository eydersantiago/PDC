# Banco de preguntas del mini-quiz (FPOO)

| | |
|---|---|
| Jira | A8.5 · ADACEEN-80 (plantilla mini-quiz, ≥ 10 ítems); validación docente en A8.7 · ADACEEN-82 |
| Datos | `data/quiz/banco-fpoo.json` (versión 1.0, 2026-09-23) |
| Código | `src/services/quiz-bank.ts` (`pickQuizFromBank`), uso en `src/routes/quiz-routes.ts` |
| Pruebas | `tests/services/quiz-bank-and-matrix.test.ts` |

El mini-quiz normal lo genera el modelo a partir del cambio que el estudiante
aceptó o del tema que lanza el docente (`src/services/quiz.ts`). El banco es el
**respaldo**: si el modelo no está disponible (GPU apagada o desalojada) o no
devuelve una pregunta válida, se toma una pregunta ya revisada. Así el quiz no
depende de la GPU y no inventa.

## Contenido

17 preguntas de opción múltiple (4 opciones, una correcta), repartidas por
resultado de aprendizaje: RA1 4, RA2 4, RA3 5, RA4 4.

| Id | RA | Tema | Lenguaje | Pregunta |
|---|---|---|---|---|
| `RA1-01` | RA1 | referencias en C++ | cpp | En C++: `int a = 5; int& r = a; r = 8;` ¿Cuánto vale `a` después? |
| `RA1-02` | RA1 | paso por valor en C++ | cpp | En C++: `void duplicar(int x) { x = x * 2; }` y en `main`: `int n = 4; duplicar(n);` ¿Cuánto vale `n` al final? |
| `RA1-03` | RA1 | new y delete | cpp | En C++, después de `int* p = new int(3); delete p;` ¿qué es cierto? |
| `RA1-04` | RA1 | referencias en Python | python | En Python: `a = [1, 2]`, `b = a`, `b.append(3)`. ¿Qué imprime `print(a)`? |
| `RA2-01` | RA2 | visibilidad por defecto | cpp | En C++: `class Cuenta { double saldo; public: void depositar(double m); };` ¿Qué visibilidad tiene `saldo`? |
| `RA2-02` | RA2 | encapsulamiento | cualquiera | ¿Cuál es la principal ventaja del encapsulamiento? |
| `RA2-03` | RA2 | atributos internos en Python | python | En Python, ¿qué significa el guion bajo en `self._saldo`? |
| `RA2-04` | RA2 | constructores | cpp | ¿Para qué sirve el constructor de una clase? |
| `RA3-01` | RA3 | metodos virtuales | cpp | `Figura` declara `virtual double area() const;` y `Circulo` la redefine. Con `Figura* f = new Circulo(2); f->area();` ¿qué versión se ejecuta? |
| `RA3-02` | RA3 | enlace estatico | cpp | Si en el caso anterior `area` NO fuera `virtual`, ¿qué se ejecutaría con `f->area()`? |
| `RA3-03` | RA3 | polimorfismo en lugar de condicionales | cualquiera | Un programa calcula áreas con `if (tipo == "circulo") ... else if (tipo == "cuadrado") ...`. ¿Qué propone la programación orientada a objetos? |
| `RA3-04` | RA3 | composicion | cualquiera | "Un Carro tiene un Motor, y ese motor no existe sin el carro". ¿Qué relación es? |
| `RA3-05` | RA3 | herencia | cualquiera | ¿Cuándo es adecuado que la clase B herede de la clase A? |
| `RA4-01` | RA4 | pruebas unitarias | python | En una prueba: `assert suma(2, 3) == 5`. Si `suma` devuelve 6, ¿qué pasa? |
| `RA4-02` | RA4 | proposito de las pruebas | cualquiera | ¿Para qué sirve una prueba unitaria? |
| `RA4-03` | RA4 | depuracion de segmentation fault | cpp | Un programa en C++ termina con "Segmentation fault". ¿Cuál es la causa más probable? |
| `RA4-04` | RA4 | estilo y nombres | cualquiera | ¿Cuál es el mejor nombre para un método que devuelve el saldo de una cuenta? |

## Formato de un ítem

```json
{
  "id": "RA2-01",
  "ra": "RA2",
  "tema": "visibilidad por defecto",
  "lenguaje": "cpp",
  "palabras": [
    "class",
    "private",
    "public",
    "visibilidad",
    "atributo"
  ],
  "pregunta": "En C++: `class Cuenta { double saldo; public: void depositar(double m); };` ¿Qué visibilidad tiene `saldo`?",
  "opciones": [
    "private",
    "public",
    "protected",
    "Depende del compilador"
  ],
  "correcta": 0,
  "explicacion": "En una `class`, los miembros son `private` hasta que aparece otra etiqueta. En un `struct` serían `public`.",
  "abierta": "¿Por qué conviene que `saldo` sea privado en esta clase?"
}
```

- `palabras`: raíces que activan el ítem cuando aparecen en el contexto (sin
  tildes ni mayúsculas). Las palabras de 1 a 3 letras y las frases se buscan
  como palabra completa, para que «if» no coincida dentro de «verificar».
- `lenguaje`: `cpp`, `python` o vacío (sirve para cualquiera).
- `correcta`: índice de la opción correcta en el archivo. Al servirla, las
  opciones se barajan y el índice se recalcula.
- `explicacion`: se muestra después de contestar. `abierta`: pregunta de
  seguimiento («explícalo con tus palabras») si el estudiante falla y el docente
  la activó.

## Cómo se elige una pregunta

1. Se descartan las preguntas de otro lenguaje y las ya usadas (`excludeIds`).
2. Cada pregunta suma 2 puntos por palabra encontrada en el contexto (el cambio
   aceptado, la sugerencia o el tema del docente), 3 si aparece el tema y 1 si
   aparece el RA.
3. Se elige al azar entre las de mayor puntaje; si ninguna coincide, cualquiera
   compatible con el lenguaje.
4. El tema de la pregunta queda como `banco RA#: <tema>`, así se distingue en
   la telemetría y en el resumen del docente de una pregunta generada por el modelo.

## Cuándo se usa

| Momento | Sin modelo o sin pregunta válida |
|---|---|
| Después de aceptar una sugerencia en VS Code (`POST /api/quiz/after-accept`) | Pregunta del banco según el código del cambio y el lenguaje del archivo. |
| El docente lanza un quiz a la clase (`POST /api/quiz/launches` con tema) | Pregunta del banco según el tema; si ni el banco tiene una, responde 502. |

## Cómo actualizar el banco (proceso para A8.7)

1. El docente propone o corrige preguntas (texto, opciones, respuesta,
   explicación y pregunta abierta) en una copia del archivo o en una tabla con
   las mismas columnas.
2. Quien mantiene el repositorio las pasa a `data/quiz/banco-fpoo.json` con un
   `id` nuevo (`RA#-NN`), sube `version` y `actualizado`.
3. `npm test` valida que haya 4 opciones distintas, la correcta dentro del
   rango, explicación y pregunta abierta, ids únicos y el reparto por RA.
4. El docente revisa el resultado en la demo o lanzando un quiz de prueba y deja
   constancia de la aprobación (correo o acta) en A8.7.
5. Al desplegar, el backend lee el archivo de nuevo.

Hasta esa aprobación el banco es una propuesta técnica: las preguntas salen del
material del curso, pero no las ha validado el docente.
