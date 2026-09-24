# Latencia medida contra backend en memoria (salida de referencia: solo costo del servidor)

- Fecha: 2026-09-24T22:52:01.865Z
- Muestras: 60

| Grupo | n | p50 (ms) | p95 (ms) | max (ms) | media (ms) | errores | degradadas |
|---|---|---|---|---|---|---|---|
| editor (todos) | 30 | 129 | 151 | 423 | 138 | 0 | 0 |
| editor S1 | 8 | 129 | 423 | 423 | 166 | 0 | 0 |
| editor S2 | 8 | 129 | 130 | 130 | 126 | 0 | 0 |
| editor S3 | 7 | 131 | 137 | 137 | 128 | 0 | 0 |
| editor S4 | 7 | 132 | 138 | 138 | 130 | 0 | 0 |
| overlay (todos) | 30 | 147 | 169 | 457 | 153 | 0 | 0 |
| overlay S1 | 8 | 147 | 457 | 457 | 182 | 0 | 0 |
| overlay S2 | 8 | 147 | 154 | 154 | 138 | 0 | 0 |
| overlay S3 | 7 | 146 | 153 | 153 | 143 | 0 | 0 |
| overlay S4 | 7 | 148 | 169 | 169 | 145 | 0 | 0 |

p50/p95 por rango mas cercano. "degradadas": respuesta controlada sin modelo (editor) o heuristica (overlay).
