# Cifras del repositorio para el documento final

> Documento generado con `npx tsx scripts/cifras-documento.ts`. No lo edites a mano: vuelve a correr el comando antes de citar una cifra.

| | |
|---|---|
| Jira | A16.2 · ADACEEN-130 (metodología, arquitectura e implementación), A16.5 · ADACEEN-133 (diapositivas y guion) |
| Fecha | 25 de septiembre de 2026 (`2026-09-25T11:59:00.223Z`) |
| Commit | PDC `64a941c` en la rama `claude/serene-heisenberg-0te9s9`; árbol de trabajo: 33 archivo(s) con cambios sin commit |
| Submódulo | `vscode-ext-prod` `b21231e`; árbol de trabajo: limpio |
| Fuentes | Archivos versionados y nuevos no ignorados del árbol de trabajo; catálogos de `src/services/`; datos de `data/`; documentos de `docs/` |
| Prueba | `tests/scripts/cifras-documento.test.ts` |

Para que las cifras del documento final sean exactamente las de un commit, corre el comando sobre ese commit sin cambios pendientes: la fila Commit debe decir “limpio”.

## Resumen para citar

| Cifra | Valor | Sección |
|---|---|---|
| Pruebas automatizadas declaradas | 445 | 2 |
| Pruebas que corre `npm test` en PDC | 248 | 2 |
| Pruebas unitarias de la extensión de VS Code | 136 | 2 |
| Rutas del API en el inventario del contrato | 112 (en el código: 112) | 3 |
| Eventos del diccionario de telemetría | 36 (36 alimentan algún KPI) | 4 |
| KPIs del catálogo | 25 (principales: T1, U1, P1) | 5 |
| Escenarios del tutor | 6 (S1, S2, S3, S4, S5a, S5b) | 6 |
| Preguntas del banco del mini-quiz | 17 | 6 |
| Ítems de la lista de cumplimiento | 30 (8 críticos) | 7 |
| Extensión de navegador | 0.7.11 | 1 |
| Extensión de VS Code | 0.0.31 | 1 |
| Líneas de código sin líneas en blanco (sin pruebas ni documentación) | 76 808 | 9 |
| Líneas de pruebas sin líneas en blanco | 14 822 | 9 |

## 1. Versiones

| Pieza | Versión | Fuente |
|---|---|---|
| Extensión de navegador | 0.7.11 | `browser-ext-prod/manifest.json` |
| Extensión de VS Code | 0.0.31 (VS Code ^1.96.0) | `vscode-ext-prod/package.json` |
| Esquema de telemetría | 1.1 | `TELEMETRY_SCHEMA_VERSION` en `src/services/telemetry.ts` |
| Banco del mini-quiz | 1.0 | `data/quiz/banco-fpoo.json` |
| Matriz escenario → recurso | 1.0 | `data/rag/matriz-escenario-recurso.json` |
| Modelo de lenguaje del piloto | `qwen2.5-coder:14b` | ayuda de `--modelo` en `deploy/mac/instalar-worker-mac.sh` («el del piloto») |

## 2. Pruebas por componente

Conteo estático de las pruebas declaradas con `node:test` (`test(…)` o `it(…)` al inicio de una línea). Coincide con el total que informa el ejecutor mientras ninguna prueba se genere dentro de un bucle.

| Componente | Archivos | Pruebas | En `npm test` de PDC | Cómo se corren |
|---|---|---|---|---|
| Backend: servicios (motor, telemetría, KPIs, piloto, cola) | 16 | 98 | 98 | `npm test` |
| Backend: rutas HTTP con base en memoria | 11 | 54 | 54 | `npm test` |
| Integración de punta a punta (acceso simplificado) | 1 | 1 | 1 | `npm test` |
| Scripts, documentos generados y contrato de la API | 13 | 40 | 40 | `npm test` |
| Extensión de navegador (estructura, permisos y flujo del túnel) | 2 | 15 | 15 | `npm test` |
| Agente y scripts de la VM de editores | 4 | 46 | 40 | `node --test deploy/gcp/workspaces/agente/*.test.mjs` |
| Operación en Google Cloud (clase.sh, GPU) | 1 | 39 | 0 | `node --test deploy/gcp/operacion.test.mjs` |
| Instaladores de doble clic de la Mac | 1 | 15 | 0 | `node --test deploy/mac/doble-clic.test.mjs` |
| Extensión de VS Code: unitarias | 8 | 136 | 0 | `npm --prefix vscode-ext-prod run test:unit` |
| Extensión de VS Code: dentro de VS Code (vscode-test) | 1 | 1 | 0 | `npm --prefix vscode-ext-prod test` |
| **Total** | 58 | **445** | **248** | |

`npm test` corre los 46 archivos que importa `tests/index.test.ts`.

## 3. Rutas del API

- Inventario del [contrato de la API](../arquitectura/contrato-api.md) (sección 3): **112** rutas.
- Registradas en `src/routes/*.ts`: **112** (DELETE 4, GET 58, POST 47, PUT 3).
- En el código y no en el inventario: ninguna.
- En el inventario y no en el código: ninguna.

| Módulo | Rutas en el código | Rutas en el contrato |
|---|---|---|
| `admin-routes.ts` | 4 | 4 |
| `agent-routes.ts` | 9 | 9 |
| `auth-routes.ts` | 4 | 4 |
| `behavior-routes.ts` | 3 | 3 |
| `campus-routes.ts` | 1 | 1 |
| `document-routes.ts` | 11 | 11 |
| `editor-auth-routes.ts` | 3 | 3 |
| `github-app-routes.ts` | 12 | 12 |
| `health-routes.ts` | 2 | 2 |
| `pilot-routes.ts` | 4 | 4 |
| `policy-routes.ts` | 3 | 3 |
| `privacy-policy-routes.ts` | 6 | 6 |
| `project-context-routes.ts` | 13 | 13 |
| `project-scan-routes.ts` | 5 | 5 |
| `quiz-routes.ts` | 9 | 9 |
| `rag-routes.ts` | 5 | 5 |
| `start-page-routes.ts` | 5 | 5 |
| `suggestion-routes.ts` | 1 | 1 |
| `telemetry-routes.ts` | 4 | 4 |
| `ui-tab-routes.ts` | 2 | 2 |
| `workspace-routes.ts` | 6 | 6 |

## 4. Telemetría

Fuente: `src/services/telemetry-catalog.ts`, del que sale el [diccionario de eventos](../telemetria/diccionario-eventos.md).

| Cifra | Valor |
|---|---|
| Eventos del catálogo | 36 |
| Eventos que alimentan algún KPI (lo que mide T12) | 36 |
| Eventos que deben llevar `decisionId` | 9 |
| Eventos por origen (un evento puede tener varios) | backend 14, extensión de navegador 11, extensión de VS Code 12 |
| Categorías | 13 |
| Columnas del diccionario de campos | 35 |
| Reglas de calidad | 15 |

## 5. KPIs

Fuente: `src/services/kpi-catalog.ts`, del que sale el [catálogo de KPIs](../metricas/catalogo-kpis.md).

| Cifra | Valor |
|---|---|
| KPIs | 25 |
| Principales | T1, U1, P1 |
| Por dimensión | Técnicos 12, Experiencia de uso (UX) 5, Pedagógicos 8 |
| Por objetivo específico | OE1 2, OE2 11, OE3 12 |
| Automáticos (`npm run piloto:analisis`) | 20 |
| Manuales (plantillas del piloto) | 5 (T7, T8, T10, T11, P5) |
| Con umbral | 19, de ellos 5 con umbral propuesto (no está en el anteproyecto) |
| Descriptivos (sin umbral) | 6 |

## 6. Tutor

| Cifra | Valor | Fuente |
|---|---|---|
| Escenarios | 6: S1, S2, S3, S4, S5a, S5b | `src/services/tutor-scenarios.ts` |
| Peticiones de los escenarios | 6 del overlay y 5 del editor | `src/services/tutor-scenarios.ts` |
| Etapas de ayuda | 6: `hint_1`, `hint_2`, `partial_example`, `explanation`, `mini_quiz`, `controlled` | `src/services/intervention-templates.ts` |
| Tipos de evento de política | 8: `compile_error`, `runtime_error`, `concept_question`, `design_block`, `workflow_guidance`, `insufficient_context`, `out_of_domain`, `code_suggestion` | `PolicyEventType` en `src/types/app.ts` |
| Preguntas del banco del mini-quiz | 17 (RA1 4, RA2 4, RA3 5, RA4 4; cpp 8, python 3, cualquiera 6) | `data/quiz/banco-fpoo.json` |
| Reglas de la matriz escenario → recurso | 9, con 20 recursos distintos | `data/rag/matriz-escenario-recurso.json` |
| Fuentes del material autorizado (semilla) | 34 | `data/rag/rag_sources_seed.jsonl` |

## 7. Piloto y gobernanza

| Cifra | Valor | Fuente |
|---|---|---|
| Ítems de la lista de cumplimiento | 30 (Privacidad y datos 12, Ética de la investigación 6, Seguridad 12) | `src/services/compliance-checklist.ts` |
| Ítems críticos / de verificación automática | 8 / 13 | `src/services/compliance-checklist.ts` |
| Ítems cerrados de la encuesta final | 26 (SUS 10, UX 6, PA 5, CMP 2, AB 3) | `SURVEY_ITEM_COUNTS` en `src/services/survey.ts` |
| Plantillas CSV del piloto | 7 | `data/piloto/plantillas/` |

## 8. Interfaces y documentación

| Cifra | Valor | Fuente |
|---|---|---|
| Contenedores de la vista C4 | 8 | tabla de [vistas](../arquitectura/vistas.md), sección 1 |
| Comandos de la extensión de VS Code | 16 | `contributes.commands` de `vscode-ext-prod/package.json` |
| Permisos y hosts de la extensión de navegador | 4 permisos, 10 hosts | `browser-ext-prod/manifest.json` |
| Scripts de `npm run` en PDC | 29 | `package.json` |
| Documentos Markdown en `docs/` | 54 | `docs/**/*.md` |

## 9. Líneas por componente

**Líneas** son las líneas físicas de cada archivo; **sin blanco** descuenta las vacías (los comentarios cuentan).

| Componente | Alcance | Archivos | Líneas | Sin blanco |
|---|---|---|---|---|
| Backend (API) | `src/**/*.ts` y los `.ts` de la raíz | 87 | 34 438 | 31 698 |
| Scripts de consola (piloto, evidencias, worker) | `scripts/**/*.ts` y `.mjs` | 31 | 7203 | 6701 |
| Extensión de navegador | `browser-ext-prod/**/*.js`, `.html`, `.css` y `manifest.json` | 35 | 22 707 | 20 407 |
| Extensión de VS Code | `vscode-ext-prod/src/**/*.ts` sin las pruebas | 12 | 11 281 | 10 361 |
| Agente de la VM de editores | `deploy/gcp/workspaces/agente/*.mjs` sin las pruebas | 3 | 1647 | 1517 |
| Despliegue y operación (shell) | `deploy/**/*.sh`, `.command` y `.service` | 25 | 6537 | 6124 |
| Pruebas automatizadas | `tests/**`, `deploy/**/*.test.mjs` y las pruebas de `vscode-ext-prod/src` | 60 | 16 140 | 14 822 |
| Documentación | `docs/**/*.md` | 54 | 11 628 | 9495 |
| **Código (sin pruebas ni documentación)** | | 193 | 83 813 | **76 808** |

## 10. Cifras de las evidencias ya generadas

Se leen de los documentos de `docs/evidencias/`; cada uno dice con qué comando se generó y contra qué backend. Ninguna es un resultado del piloto.

| Documento | Cifra | Valor |
|---|---|---|
| [demo-escenarios.md](demo-escenarios.md) | Comprobaciones de los escenarios S1–S5 (overlay y editor) | 92 de 92 |
| [demo-escenarios.md](demo-escenarios.md) | Fecha de la corrida | 2026-09-24T22:51:45.231Z |
| [latencia-entorno-controlado.md](latencia-entorno-controlado.md) | Latencia del servidor, editor (salida de referencia, sin modelo) | p50 129 ms, p95 151 ms (n = 30) |
| [latencia-entorno-controlado.md](latencia-entorno-controlado.md) | Latencia del servidor, overlay (salida de referencia, sin modelo) | p50 147 ms, p95 169 ms (n = 30) |
| [estabilidad-eventos-simulacion.md](estabilidad-eventos-simulacion.md) | Eventos esperados, recibidos y perdidos a propósito | 400 esperados, 384 recibidos, 16 perdidos |
| [estabilidad-eventos-simulacion.md](estabilidad-eventos-simulacion.md) | Descartes que detectó el estimador por seq | 16 de 16 |
| [ensayo-tecnico-piloto.md](ensayo-tecnico-piloto.md) | Comprobaciones del ensayo técnico (estudiantes sintéticos) | 12 de 12 |
| [ensayo-tecnico-piloto.md](ensayo-tecnico-piloto.md) | Estudiantes sintéticos y eventos generados | 12 estudiantes, 364 eventos |

## Avisos

- Ninguno.
