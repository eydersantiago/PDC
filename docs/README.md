# Documentación de ADACEEN

Índice de los documentos técnicos del repositorio, con la actividad de Jira
(espacio ADACEEN) que respalda cada uno.

## Arquitectura

| Documento | Jira |
|---|---|
| [ADR-001: motor de políticas y cambio de arquitectura](arquitectura/adr-001-motor-y-arquitectura.md) | A9.6 · ADACEEN-88 |
| [Ruta de datos](arquitectura/ruta-de-datos.md) y [diagrama](arquitectura/ruta-de-datos.svg) | A7.5 · ADACEEN-73 |
| [Flujo de sugerencias](flujo-sugerencias.md) | — |
| [Worker con Service Bus y Ollama](service-bus-ollama-worker.md) | A15.8 |
| [Entornos con VS Code Tunnels](workspaces-tunnel.md) | A15.3 · ADACEEN-124 |

## Tutor

| Documento | Jira |
|---|---|
| [Escenarios S1–S5](tutor/escenarios.md) | A9.5 · ADACEEN-87, A11.4 · ADACEEN-100 |
| [Plantillas de intervención y guardarraíles](tutor/plantillas-intervencion.md) | A8.3, A8.4, A10.1, A10.2 |
| [Matriz escenario → recurso autorizado](tutor/matriz-escenario-recurso.md) | A8.6 · ADACEEN-81 |
| [Banco de preguntas del mini-quiz](tutor/banco-quiz.md) | A8.5 · ADACEEN-80 |

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
| [Prerrequisitos](operacion/prerrequisitos.md) | A15.1 · ADACEEN-122 |
| [Monitoreo y alarma](operacion/monitoreo.md) | A15.4 · ADACEEN-125 |
| [Contingencia y rollback](operacion/contingencia.md) | A15.5 · ADACEEN-126 |
| [Evidencias de despliegue](operacion/evidencias-despliegue.md) | A15.6 · ADACEEN-127 |
| [Notas de versión](versiones/notas-de-version.md) | A15.9 · ADACEEN-149 |
| [Guía de instalación y uso](guia-instalacion-uso.md) | A16.8 · ADACEEN-150 |
| [Desarrollo local](local-development.md), [login con Google y PostgreSQL](google-login-postgres.md) | — |

En la rama `master` hay además `gcp-worker-infraestructura.md`,
`gcp-worker-operacion.md` y `codespaces-rendimiento.md`.
