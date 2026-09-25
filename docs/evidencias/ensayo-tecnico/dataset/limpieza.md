# Limpieza del dataset del piloto (A14.3)

| | |
|---|---|
| Generado | 2026-09-25T00:51:51.195Z |
| Fuente | backend en memoria (ensayo técnico) |
| Ventana | 2026-09-24T23:01:38.094Z a 2026-09-25T00:51:51.193Z |
| Eventos de entrada | 364 |
| Eventos que quedan | 360 |
| Estudiantes | 12 (cohorte A: 6, cohorte B: 6) |
| Eventos por condicion | con_tutor: 228, sin_tutor: 132 |
| Primer y ultimo evento | 2026-09-24T23:01:39.194Z / 2026-09-25T00:51:51.075Z |

## Exclusiones

| Regla | Que excluye | Eventos |
|---|---|---|
| D1_no_estudiante | Evento de un docente, un administrador o del sistema sin estudiante. | 1 |
| D2_cliente_anonimo | Cliente sin sesion: no se sabe su condicion (revisar la sesion compartida de VS Code). | 1 |
| D3_cuenta_de_prueba | Cuenta de prueba del equipo (listada en el plan del piloto). | 1 |
| D4_sin_condicion | Estudiante fuera de los bloques del piloto o sin cohorte asignada. | 0 |
| D5_duplicado | Copia de un evento ya recibido (mismo client_session_id y seq). | 1 |

**Atencion:** 1 sesiones de cliente sin sesion de usuario en la ventana. Si son estudiantes del piloto, su trabajo no tiene condicion y se pierde para el analisis: revisa que VS Code tenga la sesion compartida configurada.

## Marcas (el evento se queda)

| Marca | Que significa | Eventos |
|---|---|---|
| M1_fecha_corregida | El cliente mando una fecha futura (se uso la del servidor) o de mas de 7 dias atras. | 0 |
| M2_decision_huerfana | El evento cita una decision del tutor que no esta en el dataset. | 0 |
| M3_orden_invalido | La valoracion llego antes de que se mostrara la respuesta. | 0 |

Lo excluido esta en `excluidos.csv` con su regla; nada se borro de la base.
