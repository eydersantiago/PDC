# Estabilidad de eventos: simulacion contra backend en memoria

- Fecha: 2026-09-24T22:51:54.043Z
- Eventos revisados: 384 (con avisos de calidad: 0)
- Sesiones de cliente con seq: 1
- Eventos esperados por seq: 400, recibidos: 384, perdidos: 16 (tasa 4.00 %)
- Simulacion: 400 eventos numerados, 16 descartados por el cliente a proposito, 384 enviados en 20 lotes de hasta 20 (concurrencia 4) en 1544 ms.
- Lotes con error HTTP: 0.
- Guardados en telemetry_events: 384 de 384 enviados.
- El estimador por seq detecto 16 de 16 descartes (100 %).
- Sesion sintetica: estabilidad-mug4mm1k (excluirla del analisis si se corrio contra el piloto).

| Regla | Casos | Ejemplos |
|---|---|---|
| I1_eventos_perdidos | 16 | estabilidad-mug4mm1k |
| I2_duplicados | 0 | - |
| I3_orden_invalido | 0 | - |
| I4_respuesta_contradictoria | 0 | - |
| I5_decision_huerfana | 0 | - |
| I6_aplicada_sin_verificar | 0 | - |

| Aviso por evento | Casos |
|---|---|
| (ninguno) | 0 |
