# Plan de soporte durante el piloto

| | |
|---|---|
| Jira | A13.5 · ADACEEN-113 |
| Relacionados | [Runbook](../operacion/runbook.md), [contingencia](../operacion/contingencia.md), [monitoreo](../operacion/monitoreo.md), [protocolo](protocolo.md) |
| Registro | `data/piloto/plantillas/registro-incidentes.csv` (copiar uno por sesión, fuera del repositorio) |

## 1. Quién atiende

| Rol | Persona | Contacto | Qué atiende |
|---|---|---|---|
| Responsable técnico | Eyder Santiago Suárez Chávez (investigador) | En la sala; [teléfono o chat] | Todo lo técnico: extensión, editor, túnel, GPU, backend |
| Docente del curso | [por confirmar] | En la sala | Dudas del curso, orden de la clase, decisión de suspender |
| Director | Víctor Andrés Bucheli Guerrero, PhD | [correo] | Decisiones de protocolo (repetir una sesión, cambiar fechas) |
| Canal del grupo | [por definir: chat del curso] | — | Avisos a todos los estudiantes |

Fuera de las sesiones las consultas llegan al correo del investigador y se
responden en un día hábil.

## 2. Severidad y tiempos de respuesta

| Severidad | Qué es | Ejemplos | Respuesta | Resolución o decisión |
|---|---|---|---|---|
| S1 crítica | La clase, o más de la mitad del grupo, no puede trabajar | Backend caído; VM de editores apagada; túneles caídos para muchos; sin GPU en un bloque con tutor por más de 10 min | Inmediata (≤ 5 min) | En ≤ 15 min: seguir en modo degradado, cambiar de plan o suspender (la sesión se repite) |
| S2 alta | Un estudiante o un grupo pequeño no puede trabajar | Sin sesión en la extensión; «Preparar entorno» falla; VS Code sin la sesión compartida | ≤ 5 min | ≤ 15 min; si no, el estudiante trabaja sin ADACEEN y se anota |
| S3 media | Se trabaja, pero con degradación | Latencia alta; respuestas degradadas aisladas; un error de la extensión con alternativa | ≤ 15 min o al terminar el bloque | Durante la sesión si es posible |
| S4 baja | Dudas y sugerencias | «¿Por qué no me dio el código?»; ideas de mejora | Al final de la sesión | Se anotan para los hallazgos |

Los incidentes S1 cuentan para el KPI T7 (meta: cero en todo el piloto).

## 3. Flujo de un incidente

1. **Detectar.** Alerta del monitor (`npm run piloto:monitor`), estudiante que
   levanta la mano, observador o alerta de Azure o GitHub.
2. **Registrar.** Hora de inicio y síntoma en el registro, antes de tocar nada.
3. **Diagnosticar.** Tabla de síntomas del [runbook](../operacion/runbook.md).
4. **Responder.** Según el [plan de contingencia](../operacion/contingencia.md).
5. **Comunicar.** Con los mensajes de la sección 4.
6. **Cerrar.** Hora de fin, causa, respuesta y evidencia en el registro. Si fue
   en un bloque con tutor y duró más de 10 minutos, marcar el bloque como
   degradado (criterio de validez del protocolo).

## 4. Mensajes para los estudiantes

- **Tutor lento o caído:** «El tutor está tardando o no responde. Sigan con el
  ejercicio como en cualquier clase; les aviso cuando vuelva.»
- **Tutor de vuelta:** «El tutor ya responde de nuevo.»
- **Editor caído para todos:** «Estamos revisando el editor. No cierren la
  pestaña; en unos minutos les digo cómo seguir.»
- **Suspensión:** «Por un problema técnico no podemos seguir con la actividad
  de hoy. La repetimos [fecha]. Gracias por la paciencia.»
- **Problema de un estudiante:** el investigador va al puesto; el resto sigue.

## 5. Registro de incidentes

Una fila por incidente, con las columnas de `registro-incidentes.csv`:
fecha · hora de inicio · hora de fin · severidad · síntoma · afectados
(número, sin nombres) · causa · respuesta · responsable · evidencia (captura o
línea del monitor).

Después de cada sesión: revisar el registro con el del monitor
(`exportes/monitor-<fecha>.jsonl`), anotar los S1 en el plan del piloto
(`registros.T7`) y las mejoras que salgan (hallazgos, A14.5).

## 6. Antes de cada sesión (30 minutos)

- Lista «Antes de cada sesión» de los [prerrequisitos](../operacion/prerrequisitos.md).
- Monitor corriendo con la hora de inicio de la sesión.
- Registro de incidentes de la fecha abierto.
- Teléfono o chat del canal del grupo a mano.
- Portátil del investigador con `gcloud`, acceso al portal de Azure y la
  opción 1 del `.bat` de la GPU lista.
