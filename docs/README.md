# Documentación de ADACEEN

Índice de los documentos técnicos del repositorio, con la actividad de Jira
(espacio ADACEEN) que respalda cada uno.

## Arquitectura

| Documento | Jira |
|---|---|
| [ADR-001: motor de políticas y cambio de arquitectura](arquitectura/adr-001-motor-y-arquitectura.md) | A9.6 · ADACEEN-88 |
| [Ruta de datos](arquitectura/ruta-de-datos.md) y [diagrama](arquitectura/ruta-de-datos.svg) | A7.5 · ADACEEN-73 |
| [Vistas: contenedores (C4) y secuencias](arquitectura/vistas.md) | A9.6 · ADACEEN-88, A16.2 |
| [Contrato de la API](arquitectura/contrato-api.md) (verificado por prueba) | A9.6 · ADACEEN-88, A16.2 |
| [Flujo de sugerencias](flujo-sugerencias.md) | — |
| [Worker con Service Bus y Ollama](service-bus-ollama-worker.md) (GPU, Mac del laboratorio y clúster) | A15.8 · ADACEEN-148, A15.10 · ADACEEN-151 |
| [Entornos con VS Code Tunnels y relay Azure → VM](workspaces-tunnel.md) | A15.3 · ADACEEN-124 |
| [Acceso simplificado: emparejamiento del editor y ciclo sin comandos](arquitectura/acceso-simplificado.md) (contrato y desviaciones) | A15.3 · ADACEEN-124 |

## Tutor

| Documento | Jira |
|---|---|
| [Escenarios S1–S5](tutor/escenarios.md) | A9.5 · ADACEEN-87, A11.4 · ADACEEN-100 |
| [Plantillas de intervención y guardarraíles](tutor/plantillas-intervencion.md) | A8.3, A8.4, A10.1, A10.2 |
| [Matriz escenario → recurso autorizado](tutor/matriz-escenario-recurso.md) | A8.6 · ADACEEN-81 |
| [Banco de preguntas del mini-quiz](tutor/banco-quiz.md) | A8.5 · ADACEEN-80 |
| [Revisión docente del banco](tutor/revision-banco-quiz.md) (generada) | A8.7 · ADACEEN-82 |

## Piloto y métricas

| Documento | Jira |
|---|---|
| [Índice del piloto](piloto/README.md) | A13, A14 |
| [Paquete de validación para el director y el docente](piloto/validacion-director.md) | A5.7 · ADACEEN-61 |
| [Protocolo del piloto (AB/BA)](piloto/protocolo.md) | A13.1 · ADACEEN-109, A13.6 · ADACEEN-114 |
| [Instrumentos de evaluación](piloto/instrumentos.md) | A13.2 · ADACEEN-110 |
| [Consentimiento y logística](piloto/consentimiento.md) | A13.3 · ADACEEN-111 |
| [Lista de cumplimiento](piloto/checklist-cumplimiento.md) (generada) | A13.4 · ADACEEN-112 |
| [Plan de soporte](piloto/plan-de-soporte.md) | A13.5 · ADACEEN-113 |
| [Prueba de inicio a fin del acceso simplificado](piloto/prueba-inicio-a-fin.md) (2 cuentas, T10 y simulacro) | A15.3 · ADACEEN-124, A13.6 · ADACEEN-114, A16.8 · ADACEEN-150 |
| [Pendientes y responsables](piloto/pendientes.md) (dueño, director, docente y sistemas) | A5.7 · ADACEEN-61, A13, A14, A15 |
| [Análisis de datos del piloto](piloto/analisis-de-datos.md) | A14.2, A14.3, A14.4, A14.7 |
| [Catálogo de KPIs](metricas/catalogo-kpis.md) (generado) | A3.1 a A3.6 |

## Telemetría y datos

| Documento | Jira |
|---|---|
| [Diccionario de eventos](telemetria/diccionario-eventos.md) (generado) | A4.1, A4.3, A4.4 |
| [Revisión técnica y cierre del diccionario](telemetria/revision-tecnica.md) | A4.7, A4.2, A4.5, A7.1 |
| [Trazabilidad de las decisiones del tutor](telemetria/trazabilidad-decisiones.md) | A5.5 · ADACEEN-59 |

## Pruebas y evidencias

| Documento | Jira |
|---|---|
| [Plan de pruebas](pruebas/plan-de-pruebas.md) | A12.1 · ADACEEN-103 |
| [Evidencia: escenarios S1–S5](evidencias/demo-escenarios.md) | A10.7 · ADACEEN-96 |
| [Evidencia: estabilidad de eventos (simulación)](evidencias/estabilidad-eventos-simulacion.md) | A12.3 · ADACEEN-105 |
| [Evidencia: latencia en entorno controlado](evidencias/latencia-entorno-controlado.md) | A12.2 · ADACEEN-104 |
| [Evidencia: ensayo técnico del piloto](evidencias/ensayo-tecnico-piloto.md) (generada) | A13.6 · ADACEEN-114 |
| [Evidencia: verificación de cumplimiento contra un backend local](evidencias/verificacion-cumplimiento-ejemplo.md) (ejemplo de `npm run piloto:verificar`) | A13.4 · ADACEEN-112 |
| [Cifras del repositorio para el documento final](evidencias/cifras-documento.md) (generado con `npx tsx scripts/cifras-documento.ts`) | A16.2 · ADACEEN-130, A16.5 · ADACEEN-133 |

Pruebas de los documentos (parte de `npm test`): los textos de interfaz que cita
la [guía de instalación y uso](guia-instalacion-uso.md) entre comillas angulares
los verifica `tests/scripts/guia-textos.test.ts`; los del
[despliegue](operacion/despliegue.md), la
[prueba de inicio a fin](piloto/prueba-inicio-a-fin.md) y los
[pendientes](piloto/pendientes.md), además de sus rutas, enlaces, scripts y
variables, `tests/scripts/docs-despliegue-prueba.test.ts`; y los del guion y las
diapositivas de la sustentación, `tests/scripts/cifras-documento.test.ts`. El
catálogo de KPIs, el diccionario de eventos y la lista de cumplimiento, que se
generan del código, tienen una prueba que falla si quedan desactualizados; las
evidencias generadas (ensayo técnico, cifras) no: se regeneran con su comando
antes de citarlas.

## Sustentación

| Documento | Jira |
|---|---|
| [Guion de la sustentación](sustentacion/guion.md) (30 minutos o menos, demostraciones y plan B) | A16.5 · ADACEEN-133 |
| [Diapositivas](sustentacion/diapositivas.md) (texto, figuras y notas del orador) | A16.5 · ADACEEN-133 |

Las cifras que citan salen de [cifras-documento.md](evidencias/cifras-documento.md).

## Seguridad y accesibilidad

| Documento | Jira |
|---|---|
| [Permisos de la extensión](seguridad/permisos-extension.md) | A12.7 · ADACEEN-138 |
| [Revisión de seguridad del overlay](seguridad/revision-overlay.md) | A12.8 · ADACEEN-139 |
| [Checklist WCAG 2.1 AA del overlay](accesibilidad/checklist-wcag-overlay.md) | A12.9 · ADACEEN-140 |

## Operación

| Documento | Jira |
|---|---|
| [Runbook](operacion/runbook.md) | A15.7 · ADACEEN-128 |
| [Despliegue a producción](operacion/despliegue.md) (`bash deploy/produccion.sh revisar`, `aplicar` y `verificar` en Cloud Shell; orden, variables, VM, GPU y rollback) | A15.6 · ADACEEN-127, A15.5 · ADACEEN-126 |
| [Prerrequisitos](operacion/prerrequisitos.md) | A15.1 · ADACEEN-122 |
| [Monitoreo y alarma](operacion/monitoreo.md) | A15.4 · ADACEEN-125 |
| [Contingencia y rollback](operacion/contingencia.md) | A15.5 · ADACEEN-126 |
| [Evidencias de despliegue](operacion/evidencias-despliegue.md) | A15.6 · ADACEEN-127 |
| [Mac del laboratorio: servidores, modo local y clúster](operacion/worker-mac.md) | A15.10 · ADACEEN-151 |
| [Notas de versión](versiones/notas-de-version.md) | A15.9 · ADACEEN-149 |
| [Guía de instalación y uso](guia-instalacion-uso.md) (sus textos de interfaz los verifica `tests/scripts/guia-textos.test.ts`) | A16.8 · ADACEEN-150 |
| [Desarrollo local](local-development.md), [login con Google y PostgreSQL](google-login-postgres.md) | — |

En la rama `master` hay además `gcp-worker-infraestructura.md`,
`gcp-worker-operacion.md` y `codespaces-rendimiento.md`.
