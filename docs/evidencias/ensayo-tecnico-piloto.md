# Ensayo técnico del piloto con estudiantes sintéticos

| | |
|---|---|
| Jira | A13.6 · ADACEEN-114 (parte automatizable del ensayo; el ensayo con 1 o 2 personas sigue pendiente) |
| Comando | `npm run piloto:simular -- --evidencia --estudiantes=12 --semilla=ensayo-tecnico-adaceen` |
| Estudiantes | 12 sintéticos más la cuenta de prueba (que la limpieza debe excluir) |
| Eventos generados | 364 |
| Duración | 17 s |
| Resultado | 10 de 10 comprobaciones correctas |

## Qué se ensayó

El ensayo levanta el backend real con una base en memoria y recorre, por la API, lo mismo que una sesión de clase del piloto AB/BA: el docente asigna las cohortes y pasa del bloque 1 al 2; cada estudiante sintético se atasca en errores de compilación (episodios de bloqueo con su cierre), pide ayuda en VS Code y en el overlay, aplica algunos cambios y valora algunas respuestas. Después corre la limpieza del dataset (`piloto:dataset`) y el análisis (`piloto:analisis`) con una encuesta sintética.

Los tiempos de desbloqueo son sintéticos y se generaron con medianas distintas a propósito (170 s con tutor y 240 s sin tutor): el ensayo prueba que la cadena mide y compara bien, **no dice nada sobre el efecto del tutor**.

Con la misma semilla el ensayo genera los mismos datos y los mismos resultados; solo cambian T1 y T2, que son latencias medidas en la corrida.

## Comprobaciones

| Comprobación | Resultado | Detalle |
|---|---|---|
| Cohortes balanceadas | Correcta | A = 6, B = 7 (incluye la cuenta de prueba) |
| Sin tutor: el motor responde el mensaje del piloto sin llamar al modelo | Correcta | 12 de 12 pedidos con reasonCode pilot_no_tutor |
| Con tutor: el modelo responde | Correcta | 24 de 24 pedidos respondidos |
| Cada evento de los estudiantes lleva bloque, cohorte y condición | Correcta | 361 de 361 eventos con condición |
| La limpieza saca docente, cliente anónimo, cuenta de prueba y duplicado | Correcta | D1 1, D2 1, D3 1, D4 0, D5 1 |
| P1 se calcula con estudiantes pareados y prueba de Wilcoxon | Correcta | 12 estudiantes pareados; Mediana con tutor 154 s y sin tutor 252 s en 12 estudiantes: reducción de 38,9 %. La diferencia es estadísticamente significativa (Wilcoxon exacto, p = 0,002). Sin los episodios corregidos desde otro archivo: 34 %. Cumple el umbral (≥ 20 %). |
| El episodio que cruza de bloque queda fuera de P1 | Correcta | 1 episodio(s) cruzando de bloque |
| T4 detecta el evento perdido y T5 el duplicado queda fuera | Correcta | T4 = 0,3 %; T5 = 0 % en el dataset limpio |
| La encuesta se lee sin avisos y da U1, U2 y P4 | Correcta | 11 respuestas |
| El informe, los CSV y las gráficas quedan escritos | Correcta | 12 archivos, 8 gráficas |

## KPIs del ensayo

| ID | KPI | Valor | n | Cumple |
|---|---|---|---|---|
| T1 | Latencia del tutor (mediana) | 0,2 s | 32 | Sí |
| T2 | Latencia del tutor (p95) | 0,3 s | 32 | Sí |
| T3 | Respuestas del tutor sin fallo | 100 % | 32 | Sí |
| T4 | Pérdida de eventos | 0,3 % | 287 | Sí |
| T5 | Eventos duplicados | 0 % | 286 | Sí |
| T6 | Sesiones con telemetría | 100 % | 12 | Sí |
| T7 | Incidentes críticos en clase | sin dato | — | — |
| T8 | Pruebas de humo | sin dato | — | — |
| T9 | Respuestas ancladas en material autorizado | 100 % | 36 | Sí |
| T10 | Tiempo de instalación | sin dato | — | — |
| T11 | Cumplimiento de privacidad, ética y seguridad | sin dato | — | — |
| T12 | Eventos útiles en el diccionario | 36 eventos | 36 | Sí |
| U1 | Experiencia de uso del tutor | 3,99 / 5 | 11 | No |
| U2 | Usabilidad (SUS) | 70,9 puntos | 11 | Sí |
| U3 | Ayudas valoradas como útiles | 83,3 % | 12 | — |
| U4 | Cambios del tutor aplicados en VS Code | 58,3 % | 24 | — |
| U5 | Respuesta de la encuesta | 91,7 % | 12 | — |
| P1 | Reducción del tiempo hasta desbloqueo | 38,9 % | 12 | Sí |
| P2 | Episodios de bloqueo resueltos | 87,5 % | 77 | — |
| P3 | Participación | 100 % | 12 | Sí |
| P4 | Percepción de apoyo al aprendizaje | 3,75 / 5 | 11 | No |
| P5 | Mejoras críticas implementadas | sin dato | — | — |
| P6 | Cumplimiento del límite anti-solución | 100 % | 14 | Sí |
| P7 | Bloqueos de la política y uso por etapa | 0 % | 36 | — |
| P8 | Aciertos en el mini-quiz | sin dato | — | — |

Los KPIs manuales (T7, T8, T10, T11 y P5) quedan sin valor a propósito: en el piloto se registran en el plan. P8 queda sin valor porque el ensayo no genera intentos del mini-quiz.

## Archivos

- Informe generado: [ensayo-tecnico/analisis/informe-kpis.md](ensayo-tecnico/analisis/informe-kpis.md)
- Tabla de KPIs: `ensayo-tecnico/analisis/kpis.csv`; trazabilidad: `ensayo-tecnico/analisis/trazabilidad.csv`
- Limpieza: [ensayo-tecnico/dataset/limpieza.md](ensayo-tecnico/dataset/limpieza.md)
- El dataset sintético (`ensayo-tecnico/dataset/*.csv`) no se versiona: se regenera con el comando de arriba.

## Qué no cubre

- Personas reales: el ensayo con 1 o 2 estudiantes (A13.6) sigue pendiente y prueba lo que aquí no se ve: la instalación, los túneles, la red de la sala y la comprensión de las instrucciones.
- La GPU y la cola: el modelo se reemplaza por la salida de referencia con una espera aleatoria corta.
- La extensión de VS Code real: los eventos se envían como los enviaría, con el mismo formato y numeración.
