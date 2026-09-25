# Piloto con estudiantes

Documentos para preparar, ejecutar y analizar el piloto de ADACEEN en el curso
FPOO. El diseño es intra-sujeto contrabalanceado AB/BA: cada estudiante trabaja
un bloque con el tutor y otro sin él.

| Orden | Documento | Para qué | Jira |
|---|---|---|---|
| 1 | [Paquete de validación](validacion-director.md) | Aprobaciones del director y del docente antes de empezar | A5.7 · ADACEEN-61 |
| 2 | [Protocolo](protocolo.md) | Diseño, población, calendario, procedimiento de cada sesión y ensayo | A13.1 · ADACEEN-109, A13.6 · ADACEEN-114 |
| 3 | [Instrumentos](instrumentos.md) | Encuesta, observación, entrevista y hoja de tiempos | A13.2 · ADACEEN-110 |
| 4 | [Consentimiento y logística](consentimiento.md) | Formatos, almacenamiento y retiro | A13.3 · ADACEEN-111 |
| 5 | [Lista de cumplimiento](checklist-cumplimiento.md) (generada) | Privacidad, ética y seguridad (KPI T11 ≥ 80 %) | A13.4 · ADACEEN-112 |
| 6 | [Plan de soporte](plan-de-soporte.md) | Quién atiende, severidades y registro de incidentes | A13.5 · ADACEEN-113 |
| 7 | [Análisis de datos](analisis-de-datos.md) | Monitor en vivo, limpieza, análisis de KPIs y trazabilidad | A14.2, A14.3, A14.4, A14.7 |

Antes de la primera sesión:

| Documento | Para qué | Jira |
|---|---|---|
| [Pendientes y responsables](pendientes.md) | Qué falta y quién lo hace: dueño, director, docente o sistemas | A5.7 · ADACEEN-61, A13, A14, A15 |
| [Despliegue a producción](../operacion/despliegue.md) | Llevar la rama al App Service, a la VM de editores y a las GPU, y volver atrás | A15.6 · ADACEEN-127 |
| [Prueba de inicio a fin](prueba-inicio-a-fin.md) | Guion con 2 cuentas de estudiante y el docente, cronómetro T10 y simulacro; hoja `data/piloto/plantillas/prueba-inicio-a-fin.csv` | A15.3 · ADACEEN-124, A13.6 · ADACEEN-114 |

Relacionados: [catálogo de KPIs](../metricas/catalogo-kpis.md),
[diccionario de telemetría](../telemetria/diccionario-eventos.md),
[evidencia del ensayo técnico](../evidencias/ensayo-tecnico-piloto.md),
[prerrequisitos](../operacion/prerrequisitos.md) y
[guía de instalación y uso](../guia-instalacion-uso.md).

## Comandos

| Comando | Cuándo |
|---|---|
| `bash deploy/clase.sh iniciar` (y `estado`, `terminar`), en Cloud Shell | Antes y después de cada sesión y de la prueba de inicio a fin |
| `npm run piloto:verificar -- --url=<backend> --email=<docente> --password=<clave>` | Antes de la primera sesión (lista de cumplimiento) |
| `npm run piloto:bloque -- --url=<backend> --email=<docente> --password=<clave> --asignar` (o `--bloque=1`, `2` o `0`) | Asignar cohortes y cambiar de bloque sin el overlay |
| `npm run piloto:monitor -- --url=<backend> --email=<docente> --password=<clave> --desde=<inicio>` | Durante cada sesión |
| `npm run piloto:dataset -- --desde=<inicio> --hasta=<fin>` | Al cerrar cada sesión y al final |
| `npm run piloto:analisis -- --dataset=<carpeta> --encuesta=<csv> --plan=<json>` | Al terminar el piloto |
| `npm run piloto:simular` | Ensayo técnico con estudiantes sintéticos |
| `npm run piloto:retiro -- --correo=<correo>` | Retiro de un participante |

Todas las salidas quedan en `exportes/`, que no se sube al repositorio.
