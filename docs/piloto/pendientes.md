# Pendientes y responsables

| | |
|---|---|
| Fecha | 25 de septiembre de 2026, al cerrar la tanda "acceso simplificado" (rama `claude/serene-heisenberg-0te9s9`) |
| Fuentes | Jira ADACEEN (lectura del 25 de septiembre: estado y últimos comentarios de cada actividad abierta), [contrato del acceso simplificado](../arquitectura/acceso-simplificado.md), [despliegue](../operacion/despliegue.md), [prueba de inicio a fin](prueba-inicio-a-fin.md), [paquete de validación](validacion-director.md), [protocolo](protocolo.md), [prerrequisitos](../operacion/prerrequisitos.md) |
| Cómo se usa | Una fila por tarea, con quién la hace. Al cerrar una, anota la evidencia en el comentario de su actividad en Jira |

Quién:

- **Dueño:** Eyder Santiago Suárez Chávez, investigador y responsable técnico.
- **Director:** Víctor Andrés Bucheli Guerrero, PhD.
- **Docente:** el del curso del piloto (por confirmar en el protocolo).
- **Sistemas:** soporte de salas y equipos de la universidad.

Todas las actividades citadas están "En curso" en Jira, salvo ADACEEN-115, 119, 120,
131 y 133, que están en "Tareas por hacer".

## Ya resuelto (comprobado el 25 de septiembre)

- El VSIX 0.0.31 está en el commit `b21231e` de `vscode-ext-prod`, que fija la rama, y
  `raw.githubusercontent.com` lo sirve (HTTP 200). Ya no hace falta el `git add -f`
  pendiente.
- `claude/serene-heisenberg-0te9s9` está en GitHub (`f510225`), igual que la rama del
  submódulo (`b21231e`).
- `feature/azure-config-observability` (`9f51643`) es ancestro de la rama: el
  despliegue es un push fast-forward.

## Tabla

| # | Qué falta | Quién | Jira | Cuándo | Dónde |
|---|---|---|---|---|---|
| 1 | Revisar y crear las variables del App Service (`ADACEEN_WORKSPACE_PROVIDER`, `PUBLIC_BASE_URL`, sin `WORKSPACE_AGENT_URL`) y hacer el push fast-forward a `feature/azure-config-observability` | Dueño | A15.3 · ADACEEN-124, A15.6 · ADACEEN-127 | Antes de la prueba | [Despliegue](../operacion/despliegue.md), secciones 0 a 3 |
| 2 | `TELEMETRY_SALT` y `WORKER_HEARTBEAT_TOKEN` en el App Service (el latido igual al de las GPU y las Mac) | Dueño | A13.4 · ADACEEN-112, A15.4 · ADACEEN-125 | Antes de la prueba | Despliegue, 1.2 a 1.4 |
| 3 | VM de editores: metadata `branch`, `WORKSPACE_AGENT_TOKEN` rotado en los dos lados y `startup-ws.sh` nuevo, fuera de clase | Dueño | A15.3 · ADACEEN-124 | Antes de la prueba, después del push | Despliegue, 4 |
| 4 | GPU: `RAMA=feature/azure-config-observability bash deploy/gcp/actualizar-gpus.sh` y `worker-id` con `gce-` | Dueño | A15.4 · ADACEEN-125 | Antes de la prueba | Despliegue, 5 |
| 5 | Extensión de navegador 0.7.11 en los navegadores de la prueba (y en las rutas de carga de AGENTS.md) | Dueño | A15.3 · ADACEEN-124 | Antes de la prueba | Despliegue, 6 |
| 6 | Cuentas de la prueba: dos estudiantes con cuentas de GitHub distintas y repositorios públicos, y un docente de prueba con esos dos como sus estudiantes | Dueño | A15.3 · ADACEEN-124 | Antes de la prueba | [Prueba](prueba-inicio-a-fin.md), "Qué hace falta" |
| 7 | Prueba de inicio a fin con 2 cuentas distintas: es el criterio de cierre de ADACEEN-124 | Dueño | A15.3 · ADACEEN-124, A13.6 · ADACEEN-114 | Mañana | Prueba, P0 a P8 |
| 8 | Probar en Chrome real lo que solo se probó con la simulación en `node:vm`: el paso de la ventana del OAuth a `github.com/login/device` y a `vscode.dev`, el aviso con el código y su copia automática, y la detección en `/empezar` | Dueño | A15.3 · ADACEEN-124 | Mañana | Prueba, P0.3, P1.1 y P1.4 |
| 9 | Probar Firefox 128 o superior con `adaceen-firefox-0.7.11.zip`: no se probó en esta tanda | Dueño | A16.8 · ADACEEN-150 (V7) | Antes de la sesión 1 | [Guía](../guia-instalacion-uso.md), 1.1 |
| 10 | Hallazgo 5a, abierto: si el estudiante sale en un equipo y pulsa «Abrir mi editor» en otro antes de 7 días, VS Code abre con una sesión desactivada y avisa una vez. Decidir si se corrige antes del piloto | Dueño | A15.3 · ADACEEN-124 | Antes de la sesión 1 | Prueba, P3 |
| 11 | `ALLOWED_ORIGINS`: vacía, CORS acepta cualquier origen con credenciales (riesgo anterior a esta tanda). Decidir si se fija la lista del overlay | Dueño | A13.4 · ADACEEN-112 | Antes de la sesión 1 | Despliegue, 1.5 |
| 12 | Mantener una sola instancia del App Service: el relay y los limitadores viven en memoria | Dueño | A15.3 · ADACEEN-124 | Siempre | Despliegue, 1.7 |
| 13 | Rotar `WORKER_SHARED_SECRET` de forma coordinada (App Service, metadata `worker-secret` de las GPU y `~/.adaceen/worker.env` de las Mac) y quitar `worker-secret` de `adaceen-ws`. Antes, un estudiante lo veía en su terminal | Dueño | A15.3 · ADACEEN-124 | Antes de la sesión 1, fuera de clase | [Túneles](../workspaces-tunnel.md), "Seguridad de la VM" |
| 14 | Decidir el autoencendido de la VM de editores (opcional). Su clave también deja leer la metadata con el token del agente | Dueño | A15.3 · ADACEEN-124 | Opcional | Despliegue, 1.6 |
| 15 | Si se usa el autoencendido y la organización de Google Cloud prohíbe crear claves (`iam.disableServiceAccountKeyCreation`), pedir la excepción para el proyecto | Administrador de la organización de Google Cloud (por verificar quién es) | A15.3 · ADACEEN-124 | Solo con la fila 14 | [Runbook](../operacion/runbook.md), sección 0 |
| 16 | Crear las alertas de Azure Monitor: `deploy/azure/crear-alertas.sh` con `az login` | Dueño | A15.4 · ADACEEN-125 | Antes de la sesión 1 | [Monitoreo](../operacion/monitoreo.md) |
| 17 | Activar `salud-produccion.yml`. Solo corre desde la rama por defecto (`master`), y un push a `master` despliega `master` en producción. Decidir cómo activarlo sin ese efecto. Opciones, las dos por verificar: un commit a `master` que solo agregue `salud-produccion.yml`, con `[skip ci]` en el mensaje (GitHub no corre los flujos de push de ese commit, pero el siguiente push a `master` sin esa marca sí despliega), u otra rama por defecto | Dueño | A15.4 · ADACEEN-125 | Antes de la sesión 1 | Monitoreo; despliegue, "Qué no hacer" |
| 18 | `npm run piloto:verificar` contra producción, guardar la salida y marcar los ítems manuales: al menos 80 % y todos los críticos | Dueño | A13.4 · ADACEEN-112 | Después del despliegue | Prueba, P7.3; [lista de cumplimiento](checklist-cumplimiento.md) |
| 19 | Evidencias contra producción: `npm run demo:escenarios` con la GPU encendida, capturas 5 a 18 y registro de despliegue | Dueño | A15.6 · ADACEEN-127 | Después del despliegue | [Evidencias](../operacion/evidencias-despliegue.md) |
| 20 | Medir la latencia con la GPU encendida y al menos 30 muestras: `npm run medir:latencia -- --url=<backend> --n=30` | Dueño | A12.2 · ADACEEN-104 | Antes de la sesión 1 | Evidencias, sección 1 |
| 21 | Guía de instalación: en esta tanda se reescribe para la 0.7.11 y la 0.0.31. Falta confirmar en la prueba sus puntos *por verificar* (textos de GitHub, Chrome y macOS, y pasos no probados en un equipo real) | Dueño | A16.8 · ADACEEN-150 | Antes de medir T10 | [Guía](../guia-instalacion-uso.md), sección 6 |
| 22 | Medir T10 (instalación en 15 minutos o menos) con al menos 3 personas que no conozcan el proyecto, y dar el visto bueno (V10) | Dueño mide; Docente o Director validan | A16.8 · ADACEEN-150 | Antes de la sesión 1 | Guía, sección 6; `data/piloto/plantillas/tiempos-instalacion.csv` |
| 23 | Ensayo con 1 o 2 personas en una sala de sistemas (protocolo, sección 11), con el simulacro de los casos 1, 2, 8 y 9 | Dueño y Docente | A13.6 · ADACEEN-114, A15.5 · ADACEEN-126 | Antes de la sesión 1 | [Protocolo](protocolo.md), 11; [contingencia](../operacion/contingencia.md), 9 |
| 24 | Probar en una Mac real del laboratorio `Preparar-Mac-ADACEEN.command` (bash 3.2, `codesign`, `xcode-select`, `open`, `code --install-extension`) y el worker de la Mac | Dueño, con Sistemas | A15.10 · ADACEEN-151 | Antes de usar las Mac | Prueba, P4; [worker-mac](../operacion/worker-mac.md), 11 |
| 25 | Mac del laboratorio: `git` instalado con las herramientas de Apple (piden clave de administrador), VS Code 1.96 o más nuevo, sin suspensión y sin disco congelado | Sistemas | A15.10 · ADACEEN-151 | Antes de usar las Mac | [Prerrequisitos](../operacion/prerrequisitos.md), sección 1 |
| 26 | Red de la sala: `vscode.dev`, `github.com/login/device`, el relay de Dev Tunnels, `*.azurewebsites.net` y la salida HTTPS a `*.servicebus.windows.net` | Sistemas | A13.6 · ADACEEN-114 | Antes del ensayo | Prerrequisitos, sección 2 |
| 27 | Navegadores de la sala: que dejen activar el modo de desarrollador y cargar una extensión descomprimida (una política del equipo podría impedirlo; por verificar) | Sistemas | A16.8 · ADACEEN-150 | Antes del ensayo | Página `/empezar`, paso 1 |
| 28 | Cuentas del piloto: docente con rol «Profesor» antes de su primer ingreso y estudiantes asignados a su docente; `WORKSPACE_ALLOWED_LOGINS` vacía, `*` o con sus logins | Dueño | A14.1 · ADACEEN-115 | Antes de la sesión 1 | Prerrequisitos, sección 1 |
| 29 | Firmar el paquete de validación (V1 a V10) | Director (V3 y V7 con el Docente; V8 y V9 el Docente; V10 Docente o Director) | A5.7 · ADACEEN-61 | Antes de la sesión 1 | [Paquete de validación](validacion-director.md) |
| 30 | Aprobar el ADR-001 con la decisión 4 (Mac del laboratorio y editor en dos modos) | Director | A9.6 · ADACEEN-88 | Antes de la sesión 1 | Paquete, V1 |
| 31 | Aprobar los umbrales de los KPIs | Director | A3.5 · ADACEEN-45 | Antes de la sesión 1 | Paquete, V2 |
| 32 | Protocolo: curso, grupo y fechas; ejercicios de cada bloque; si las actividades se califican (C12); observador; aprobación (V3); decidir si hace falta el comité de ética | Docente y Dueño deciden; Director aprueba y decide lo del comité | A13.1 · ADACEEN-109 | Antes de la sesión 1 | Protocolo, sección 12 |
| 33 | Consentimiento: correos, plazo de retención (se propone 365 días), lugar de custodia, revisión del cambio sobre procesamiento en equipos del laboratorio y aprobación (V5) | Director aprueba; Dueño completa | A13.3 · ADACEEN-111 | Antes de imprimir los formatos | [Consentimiento](consentimiento.md) |
| 34 | Recoger los consentimientos firmados en la primera sesión | Docente y Dueño | A13.3 · ADACEEN-111 | Sesión 1 | Consentimiento |
| 35 | Revisar las plantillas de intervención (V8) y aplicar los ajustes antes de la sesión 1 | Docente revisa; Dueño aplica | A10.6 · ADACEEN-95 | Antes de la sesión 1 | Paquete, V8 |
| 36 | Revisar el banco del mini-quiz (V9) | Docente | A8.7 · ADACEEN-82 | Antes de la sesión 1 | [Revisión del banco](../tutor/revision-banco-quiz.md) |
| 37 | Ejecutar las sesiones, con el monitor en vivo | Dueño y Docente | A14.1 · ADACEEN-115, A14.2 · ADACEEN-116 | Piloto | [Runbook](../operacion/runbook.md), sección 0; [análisis](analisis-de-datos.md) |
| 38 | Limpieza del dataset, análisis de KPIs, hallazgos, discusión y trazabilidad | Dueño | ADACEEN-117, ADACEEN-118, ADACEEN-119, ADACEEN-120, ADACEEN-121 | Después del piloto | Análisis |
| 39 | Documento final, anexos, diapositivas, banco de preguntas y ensayo de la sustentación | Dueño, con revisión del Director | ADACEEN-129 a ADACEEN-135 | Después del piloto | — |
