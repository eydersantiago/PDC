# Evidencia: escenarios S1-S5 del tutor

- Fecha: 2026-09-24T22:51:45.231Z a 2026-09-24T22:51:49.104Z
- Backend: en memoria (usuarios y politica demo)
- Modelo: salida de referencia (src/services/tutor-scenarios.ts)
- Politica: "RF-05 base del piloto" (sin solucion completa: si, maximo de pistas por ejercicio: 3, aplicar codigo: hasta 20 lineas con confirmacion)
- Resultado: 92 de 92 comprobaciones correctas
- Latencia de la demo (no es la medicion A12.2): p50 79 ms, p95 434 ms, n=11

Definicion de los escenarios: docs/tutor/escenarios.md. Generado con `npm run demo:escenarios`.

## Resumen

| Escenario | Canal | Evento | Etapa | Bloqueado | Motivo | Latencia (ms) | Comprobaciones |
|---|---|---|---|---|---|---|---|
| S1 Error de compilacion | overlay | compile_error | hint_1 | no | ok | 434 | 7/7 OK |
| S2 Falla en ejecucion o prueba | overlay | runtime_error | hint_1 | no | ok | 119 | 7/7 OK |
| S3 Pregunta conceptual | overlay | concept_question | explanation | no | ok | 85 | 7/7 OK |
| S4 Bloqueo de diseno | overlay | design_block | hint_1 | no | ok | 69 | 7/7 OK |
| S5a Contexto insuficiente | overlay | insufficient_context | controlled | si | insufficient_context | 79 | 8/8 OK |
| S5b Fuera del dominio del curso | overlay | out_of_domain | controlled | si | out_of_domain | 72 | 8/8 OK |
| S1 Error de compilacion | editor | compile_error | hint_1 | no | ok | 80 | 8/8 OK |
| S2 Falla en ejecucion o prueba | editor | runtime_error | hint_1 | no | ok | 88 | 8/8 OK |
| S3 Pregunta conceptual | editor | concept_question | explanation | no | ok | 70 | 8/8 OK |
| S4 Bloqueo de diseno | editor | design_block | hint_1 | no | ok | 70 | 8/8 OK |
| S5b Fuera del dominio del curso | editor | out_of_domain | controlled | si | out_of_domain | 23 | 8/8 OK |

## Ayuda gradual en el overlay (A2.2)

Cuatro pedidos seguidos sobre el mismo ejercicio: hint_1 -> hint_2 -> partial_example -> controlled.

- OK pista 1 -> pista 2 -> ejemplo parcial -> bloqueo: hint_1 -> hint_2 -> partial_example -> controlled
- OK motivo del bloqueo: hint_limit_reached

## Aplicacion de codigo en VS Code (A10.8)

- sugerencia 1: etapa hint_1, maximo 5 lineas, cupo 3
- aplicar 2 lineas: permitido (ok), cupo 2
- aplicar 25 lineas: bloqueado (code_application_too_large), cupo 2
- aplicar 3 lineas: permitido (ok), cupo 1
- aplicar 3 lineas: permitido (ok), cupo 0
- aplicar 1 lineas: bloqueado (code_application_limit_reached), cupo 0
- sugerencia 2: etapa partial_example, aplicar permitido=false

- OK el primer cambio corto se aplica
- OK un cambio de 25 lineas se bloquea
- OK el cupo se agota en 3 aplicaciones
- OK sin cupo la sugerencia no ofrece Aplicar

## Degradacion sin modelo (A12.10)

- OK responde sin error 500: degraded=true
- OK no inventa ni trae codigo

## Detalle por escenario

### S1 (overlay): Error de compilacion

- OK HTTP 200: 200
- OK evento: compile_error (esperado compile_error)
- OK etapa: hint_1 (esperado hint_1)
- OK bloqueo: false (esperado false)
- OK motivo: ok (esperado ok)
- OK decision enlazable: 65b70a0e-1e38-41c9-9ff4-6338369ddae2
- OK codigo <= 0 lineas: 0 lineas

Respuesta (extracto):

````text
Vamos paso a paso.
- Revisa la linea que indica el mensaje y compara con este patron:
_(codigo omitido: en esta etapa la ayuda es solo una pista)_
[RAG-FPOO-BIB-04#c1]
- Pregunta guia: que espera el compilador justo antes del cierre de la funcion? [RAG-FPOO-PDF-02#c1]
````

### S2 (overlay): Falla en ejecucion o prueba

- OK HTTP 200: 200
- OK evento: runtime_error (esperado runtime_error)
- OK etapa: hint_1 (esperado hint_1)
- OK bloqueo: false (esperado false)
- OK motivo: ok (esperado ok)
- OK decision enlazable: de521890-6b17-4f44-bf35-dfa39cad8f14
- OK codigo <= 0 lineas: 0 lineas

Respuesta (extracto):

````text
Vamos paso a paso.
- Revisa la linea que indica el mensaje y compara con este patron:
_(codigo omitido: en esta etapa la ayuda es solo una pista)_
[RAG-FPOO-BIB-04#c1]
- Pregunta guia: que espera el compilador justo antes del cierre de la funcion? [RAG-FPOO-BIB-05#c1]
````

### S3 (overlay): Pregunta conceptual

- OK HTTP 200: 200
- OK evento: concept_question (esperado concept_question)
- OK etapa: explanation (esperado explanation)
- OK bloqueo: false (esperado false)
- OK motivo: ok (esperado ok)
- OK decision enlazable: c0b32a8e-bdbf-47f4-bee2-9ab76bcb7268
- OK codigo <= 4 lineas: 4 lineas

Respuesta (extracto):

````text
Vamos paso a paso.
- Revisa la linea que indica el mensaje y compara con este patron:
```cpp
  paso_1();
  paso_2();
  paso_3();
  paso_4();
// ... recortado por la politica del docente: completa el resto tu
```
[RAG-FPOO-15#c1]
- Pregunta guia: que espera el compilador justo antes del cierre de la funcion? [RAG-FPOO-04#c1]
````

### S4 (overlay): Bloqueo de diseno

- OK HTTP 200: 200
- OK evento: design_block (esperado design_block)
- OK etapa: hint_1 (esperado hint_1)
- OK bloqueo: false (esperado false)
- OK motivo: ok (esperado ok)
- OK decision enlazable: a4149904-d9a8-49f4-9f0b-3185eccd1967
- OK codigo <= 0 lineas: 0 lineas

Respuesta (extracto):

````text
Vamos paso a paso.
- Revisa la linea que indica el mensaje y compara con este patron:
_(codigo omitido: en esta etapa la ayuda es solo una pista)_
[RAG-FPOO-BIB-01#c1]
- Pregunta guia: que espera el compilador justo antes del cierre de la funcion? [RAG-FPOO-BIB-01#c1]
````

### S5a (overlay): Contexto insuficiente

- OK HTTP 200: 200
- OK evento: insufficient_context (esperado insufficient_context)
- OK etapa: controlled (esperado controlled)
- OK bloqueo: true (esperado true)
- OK motivo: insufficient_context (esperado insufficient_context)
- OK decision enlazable: 712c59e3-ce25-4972-a027-879c7ae06890
- OK codigo <= 0 lineas: 0 lineas
- OK mensaje controlado del docente, sin codigo: No puedo ayudar con ese tema o con tan poco contexto. Muestrame el ejercicio, el

Respuesta (extracto):

````text
No puedo ayudar con ese tema o con tan poco contexto. Muestrame el ejercicio, el error o un fragmento del codigo del curso.
- No puedo ayudar con ese tema o con tan poco contexto. Muestrame el ejercicio, el error o un fragmento del codigo del curso.
````

### S5b (overlay): Fuera del dominio del curso

- OK HTTP 200: 200
- OK evento: out_of_domain (esperado out_of_domain)
- OK etapa: controlled (esperado controlled)
- OK bloqueo: true (esperado true)
- OK motivo: out_of_domain (esperado out_of_domain)
- OK decision enlazable: 0d602a85-29dd-4ac6-8e55-cc9181c6d2fe
- OK codigo <= 0 lineas: 0 lineas
- OK mensaje controlado del docente, sin codigo: No puedo ayudar con ese tema o con tan poco contexto. Muestrame el ejercicio, el

Respuesta (extracto):

````text
No puedo ayudar con ese tema o con tan poco contexto. Muestrame el ejercicio, el error o un fragmento del codigo del curso.
- No puedo ayudar con ese tema o con tan poco contexto. Muestrame el ejercicio, el error o un fragmento del codigo del curso.
````

### S1 (editor): Error de compilacion

- OK HTTP 200: 200
- OK evento: compile_error (esperado compile_error)
- OK etapa: hint_1 (esperado hint_1)
- OK bloqueo: false (esperado false)
- OK motivo: ok (esperado ok)
- OK codigo <= 5 lineas: 5 lineas
- OK Aplicar solo si se puede aplicar: sin linea Aplicar
- OK decision enlazable: b477f54c-c934-4ec8-b495-150d70ed78d7

Respuesta (extracto):

````text
1) Resumen:
- La instruccion antes del cierre de la funcion no termina correctamente.

2) Sugerencias del archivo:
- Compila despues de cada cambio pequeno.

3) Sugerencias del codigo:
- Revisa la linea que indica el compilador.

```cpp
  paso_1();
  paso_2();
  paso_3();
  paso_4();
...
````

### S2 (editor): Falla en ejecucion o prueba

- OK HTTP 200: 200
- OK evento: runtime_error (esperado runtime_error)
- OK etapa: hint_1 (esperado hint_1)
- OK bloqueo: false (esperado false)
- OK motivo: ok (esperado ok)
- OK codigo <= 5 lineas: 5 lineas
- OK Aplicar solo si se puede aplicar: sin linea Aplicar
- OK decision enlazable: be805c7c-ee52-44ef-9ca0-0924ce7db042

Respuesta (extracto):

````text
1) Resumen:
- La instruccion antes del cierre de la funcion no termina correctamente.

2) Sugerencias del archivo:
- Compila despues de cada cambio pequeno.

3) Sugerencias del codigo:
- Revisa la linea que indica el compilador.

```cpp
  paso_1();
  paso_2();
  paso_3();
  paso_4();
...
````

### S3 (editor): Pregunta conceptual

- OK HTTP 200: 200
- OK evento: concept_question (esperado concept_question)
- OK etapa: explanation (esperado explanation)
- OK bloqueo: false (esperado false)
- OK motivo: ok (esperado ok)
- OK codigo <= 4 lineas: 4 lineas
- OK Aplicar solo si se puede aplicar: sin linea Aplicar
- OK decision enlazable: 1c3e6b04-2d2c-46cd-acb5-b087104bd398

Respuesta (extracto):

````text
1) Resumen:
- La instruccion antes del cierre de la funcion no termina correctamente.

2) Sugerencias del archivo:
- Compila despues de cada cambio pequeno.

3) Sugerencias del codigo:
- Revisa la linea que indica el compilador.

```cpp
  paso_1();
  paso_2();
  paso_3();
  paso_4();
...
````

### S4 (editor): Bloqueo de diseno

- OK HTTP 200: 200
- OK evento: design_block (esperado design_block)
- OK etapa: hint_1 (esperado hint_1)
- OK bloqueo: false (esperado false)
- OK motivo: ok (esperado ok)
- OK codigo <= 5 lineas: 5 lineas
- OK Aplicar solo si se puede aplicar: sin linea Aplicar
- OK decision enlazable: c5e49185-53e1-44d2-9114-63fb373bed7f

Respuesta (extracto):

````text
1) Resumen:
- La instruccion antes del cierre de la funcion no termina correctamente.

2) Sugerencias del archivo:
- Compila despues de cada cambio pequeno.

3) Sugerencias del codigo:
- Revisa la linea que indica el compilador.

```cpp
  paso_1();
  paso_2();
  paso_3();
  paso_4();
...
````

### S5b (editor): Fuera del dominio del curso

- OK HTTP 200: 200
- OK evento: out_of_domain (esperado out_of_domain)
- OK etapa: controlled (esperado controlled)
- OK bloqueo: true (esperado true)
- OK motivo: out_of_domain (esperado out_of_domain)
- OK codigo <= 20 lineas: 0 lineas
- OK Aplicar solo si se puede aplicar: sin linea Aplicar
- OK decision enlazable: 70ac5e11-aafb-46c2-9523-68d8c3dea9c7

Respuesta (extracto):

````text
1) Resumen:
- No puedo ayudar con ese tema o con tan poco contexto. Muestrame el ejercicio, el error o un fragmento del codigo del curso.

2) Sugerencias del codigo:
- Comparte el enunciado, el error que ves o selecciona el fragmento donde estas bloqueado.
- Si la duda es de otro tema, preguntale a tu docente.

5) Riesgos:
- Motivo de control: La consulta esta fuera de lo que cubre el tutor del curso.
````
