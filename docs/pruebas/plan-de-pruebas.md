# Plan de pruebas de ADACEEN

| | |
|---|---|
| Jira | A12.1 · ADACEEN-103 |
| Alcance | Backend (PDC), extensión de navegador (`browser-ext-prod`), extensión de VS Code (`vscode-ext-prod`), worker GPU y entorno por túnel |
| Fecha de corte | 24 de septiembre de 2026, rama `feat/segunda-tanda-jira` (segunda entrega). Filas actualizadas el 25 de septiembre en `claude/serene-heisenberg-0te9s9` (acceso simplificado), marcadas con la fecha |
| Relación con KPIs | Los KPIs los define y mide la parte de ciencia de datos (A3, A14). Este plan dice qué prueba técnica alimenta cada uno y con qué criterio se considera lista la versión para el piloto. |

## 1. Niveles

| Nivel | Qué cubre | Cómo se corre | Automatizado |
|---|---|---|---|
| Unitarias (backend) | Motor de políticas, plantillas y guardarraíl, telemetría (seudonimización, calidad, integridad), banco de quiz, matriz, clasificador, GitHub App, cola. | `npm test` | Sí |
| Integración (backend) | Rutas HTTP con base PostgreSQL en memoria y un modelo de referencia: `/intervene`, `/suggest-tab`, `apply-check`, `/api/behavior/events`, exportación, calidad, latido y salud, quiz, RAG, entornos. | `npm test` | Sí |
| Unitarias (VS Code) | Identidad del cliente, telemetría v1.1 con `seq`, señales de error y bloqueo, guard de aplicación de código (incluida la regla sin red). | `npm run test:unit` en `vscode-ext-prod` | Sí |
| Estructura (navegador) | Orden de los scripts del manifiesto igual al de `background.js`, archivos presentes, permisos. | `npm test` (`browser-ext-structure.test.ts`) y `node --check` | Sí |
| Humo y demo (E2E sobre API) | Escenarios S1–S5 en overlay y editor, ayuda gradual, aplicación de código y degradación, contra un backend en memoria o desplegado. | `npm run demo:escenarios [-- --url=… --email=… --password=…]` | Sí (sale con 1 si algo falla) |
| E2E con navegador real | Instalación de las extensiones, overlay en Campus/GitHub/vscode.dev, túnel, aplicar un cambio y quiz. | Lista manual de la sección 5 | No (manual) |
| Rendimiento | Latencia p50/p95 por canal y escenario. | `npm run medir:latencia` | Sí (la medición real necesita la GPU encendida) |
| Estabilidad | Eventos perdidos, duplicados y orden; errores HTTP bajo carga. | `npm run estabilidad:eventos -- --simular` y, con datos del piloto, `--desde-bd` | Sí |
| Seguridad y privacidad | Casos negativos (no inventar, no dar la solución, no guardar datos sensibles), permisos mínimos, overlay seguro. | `npm test` + revisiones en `docs/seguridad/` | Parcial |
| Accesibilidad | Vistas clave del overlay con criterios WCAG 2.1 AA. | Lista en `docs/accesibilidad/checklist-wcag-overlay.md` | No (manual) |

## 2. Estado actual

| Suite | Pruebas | Resultado (24-sep-2026, salvo otra fecha) |
|---|---|---|
| Backend `npm test` | 247 | 247 pasan (25-sep-2026; 130 el 24-sep y 106 en la primera entrega) |
| VS Code `npm run test:unit` | 136 | 136 pasan (25-sep-2026, extensión 0.0.31; 59 el 24-sep y 54 en la primera entrega) |
| VS Code `npm run compile` y `npm run lint` | — | Sin errores |
| Backend `npm run build` (tsc) | — | Sin errores |
| Demo de escenarios en memoria | 92 comprobaciones | 92 correctas ([evidencia](../evidencias/demo-escenarios.md)) |
| Estabilidad simulada (400 eventos, 16 descartados a propósito en el cliente, 4 envíos en paralelo) | — | El servidor guardó los 384 enviados, sin duplicados; el estimador por `seq` detectó los 16 descartes ([evidencia](../evidencias/estabilidad-eventos-simulacion.md)) |
| Latencia en entorno controlado (60 peticiones, salida de referencia) | — | Costo del servidor sin modelo: p50 129 ms (editor) y 147 ms (overlay) ([evidencia](../evidencias/latencia-entorno-controlado.md)); la latencia con el modelo se mide con la GPU encendida |
| Ensayo técnico del piloto (12 estudiantes sintéticos, cohortes, bloques, limpieza, análisis y KPIs manuales desde plantillas llenas sintéticas) | 12 comprobaciones | 12 correctas, con T7, T8, T10, T11 y P5 calculados desde las plantillas (25-sep-2026, [evidencia](../evidencias/ensayo-tecnico-piloto.md)) |

Las cifras al día de cada suite (pruebas por componente, rutas, KPIs) las da
`npx tsx scripts/cifras-documento.ts` en [cifras-documento.md](../evidencias/cifras-documento.md).

## 3. Trazabilidad: prueba → requisito → KPI

| Prueba (archivo o comando) | Qué comprueba | Jira | KPI o criterio que alimenta |
|---|---|---|---|
| `tests/routes/tutor-scenarios.test.ts` (escenarios del overlay) | S1–S5: evento, etapa, bloqueo y motivo; mensajes controlados sin modelo; traza sin datos sensibles. | A9.5, A10.5, A5.5 | Tasa de bloqueo por política; cumplimiento de «no inventar» |
| `tests/routes/tutor-scenarios.test.ts` (ayuda gradual) | Pista 1 → pista 2 → ejemplo parcial → bloqueo por límite de pistas; código recortado por etapa. | A2.2, A10.1, A10.2 | Uso efectivo de intervenciones; ayuda sin solución completa |
| `tests/routes/tutor-scenarios.test.ts` (editor y aplicación) | Límite de líneas por etapa, quitar «Aplicar:», apply-check, cupo por archivo. | A9.10, A10.8 | Aplicaciones bloqueadas por política |
| `tests/routes/tutor-scenarios.test.ts` (degradación) | Sin modelo: heurística / mensaje controlado; cola sin worker: respuesta rápida y salud 503; latido. | A12.10, A15.4 | Disponibilidad; fallos controlados |
| `tests/services/suggestion-policy.test.ts` | Clasificación del editor, etapas, intervenciones habilitadas, guardarraíl con todas las variantes de «Aplicar:», apply-check. | A9.10, A10.2, A10.5, A10.8 | Igual que arriba |
| `tests/services/telemetry.test.ts` | Seudonimización, minimización, reglas Q3–Q9, integridad I1–I6, exportación sin identificadores. | A4.4, A4.5, A7.1, A7.2, A7.6 | Pérdida de eventos; calidad del dataset |
| `tests/routes/telemetry-routes.test.ts` | Eventos sin sesión, rechazo Q1/Q2, exportación y calidad solo para docentes, catálogo, retención. | A4.5, A7.2, A7.6, A11.2 | Calidad del dataset |
| `tests/scripts/telemetry-dictionary.test.ts` | El diccionario publicado coincide con el catálogo del código. | A4.1, A4.3 | — |
| `tests/scripts/exportes.test.ts` | La exportación de quices seudonimiza igual que la telemetría y no lleva textos del estudiante. | A7.2 | — |
| `tests/services/quiz-bank-and-matrix.test.ts` | Banco válido (17 ítems), elección por contexto, barajado; matriz escenario-recurso. | A8.5, A8.6 | Comprensión (mini-quiz) |
| `tests/routes/quiz-routes.test.ts` | Mini-quiz tras aceptar y lanzado por el docente; respaldo del banco. | A8.5, A11.7 | Comprensión (mini-quiz) |
| `tests/routes/workspace-routes.test.ts`, `deploy/gcp/workspaces/agente/*.test.mjs` | Proveedor de entornos por túnel, agente de la VM y lectura del código de dispositivo. | A15.3 | Tiempo hasta entorno listo |
| `tests/scripts/browser-ext-structure.test.ts` | Estructura del paquete de la extensión de navegador. | A12.7, A15.9 | Instalación correcta |
| `src/unit-tests/*.test.ts` (VS Code) | Identidad, telemetría con `seq`, señales, guard de aplicación. | A6.2, A6.8, A10.8, A11.2 | Pérdida de eventos; aplicaciones bloqueadas |
| `npm run demo:escenarios` | Humo de punta a punta sobre la API, con evidencia en Markdown. | A11.4, A10.7 | Criterio de salida (sección 4) |
| `npm run medir:latencia` | p50/p95 por canal y escenario; `--desde-bd` con la latencia registrada en cada decisión. | A12.2 | Latencia p50/p95 |
| `npm run estabilidad:eventos` | Pérdida, duplicados y orden de eventos. | A12.3, A7.6 | Pérdida de eventos; estabilidad |
| `tests/services/pilot.test.ts`, `tests/routes/pilot-routes.test.ts` | Asignación balanceada y reproducible de cohortes, condición por bloque, permisos, aviso sin modelo en el bloque sin tutor, apply-check bloqueado, condición en cada evento. | A13.1 | P1 (condición de cada episodio); validez del diseño |
| `tests/services/kpis.test.ts` | Percentiles, Wilcoxon exacto y normal, Mann-Whitney, emparejamiento de episodios, cruzado AB/BA y los 25 KPIs con datos conocidos. | A3.3, A14.4 | Todos los KPIs automáticos |
| `tests/services/pilot-dataset.test.ts` | Reglas de limpieza D1 a D5 y marcas M1 a M3. | A14.3 | Calidad del dataset del piloto |
| `tests/scripts/piloto-pipeline.test.ts` | Cadena completa: dataset, encuesta, análisis, informe, gráficas y trazabilidad; KPIs manuales desde las plantillas; lista de cumplimiento; retiro de un participante (datos, códigos de emparejamiento y sesiones de VS Code). | A14.4, A14.7, A13.3, A13.4 | Reporte de KPIs; T11 |
| `tests/scripts/kpi-catalog-doc.test.ts` | El catálogo publicado coincide con el código y cada KPI está operacionalizado. | A3.1 a A3.6 | — |
| `tests/scripts/contrato-api.test.ts` | Toda ruta del backend está en el contrato de la API. | A9.6 | Cobertura de requisitos de arquitectura |
| `tests/scripts/cli.test.ts` | Opciones numéricas de los scripts (regresión: una opción ausente no se vuelve el mínimo). | A15.7 | — |
| `deploy/gcp/workspaces/agente/relay.test.mjs` y el caso relay de `workspace-routes.test.ts` | Relay de la VM de editores: sondeo largo, respuestas, token, agente desconectado. | A15.3 | Tiempo hasta entorno listo |
| `npm run piloto:simular` | Ensayo técnico del piloto por la API, con evidencia en Markdown. | A13.6 | Criterio de salida (sección 4) |

## 4. Criterio de salida hacia el piloto

La versión está lista para el ensayo del piloto (A13.6) cuando:

1. `npm run build`, `npm test`, `npm run compile`, `npm run lint` y `npm run test:unit` pasan sin errores.
2. `npm run demo:escenarios -- --url=<producción> --email=<estudiante de prueba> --password=<clave>` termina con todas las comprobaciones correctas, con la GPU encendida.
3. `npm run medir:latencia -- --url=<producción> --n=30` con la GPU encendida y el modelo cargado deja un p95 dentro del umbral que fije A3 (el anteproyecto menciona ≤ 8 s y ≤ 10 s para el modo híbrido; hay que unificarlo con el director).
4. `npm run estabilidad:eventos -- --simular --url=<producción> --email=<docente> --password=<clave>` no pierde eventos del servidor ni crea duplicados.
5. La lista manual de la sección 5 queda completa en Chromium y en Firefox.
6. La lista de accesibilidad y las revisiones de seguridad no tienen pendientes críticos.

## 5. Lista manual E2E (por navegador)

| # | Paso | Resultado esperado | Chromium | Firefox |
|---|---|---|---|---|
| 1 | Instalar el paquete de `npm run empaquetar:extension` siguiendo la [guía](../guia-instalacion-uso.md) | Instalada en 15 minutos o menos | [ ] | [ ] |
| 2 | Iniciar sesión (correo; Google solo en Chromium) | Encabezado con nombre y rol | [ ] | [ ] |
| 3 | Pedir ayuda en Campus con un error visible (S1) | Pista 1 sin código y cita del material | [ ] | [ ] |
| 4 | Pregunta fuera del curso (S5b) | Mensaje controlado del docente | [ ] | [ ] |
| 5 | «Preparar mi editor» con el túnel | `vscode.dev/tunnel/ad-<login>/…` abierto con GitHub y la barra de VS Code en «ADACEEN: <nombre>» sin pegar nada ([prueba de inicio a fin](../piloto/prueba-inicio-a-fin.md), P1) | [ ] | [ ] |
| 6 | Seleccionar código con un error en VS Code | Ventana flotante con la sugerencia y el límite de líneas | [ ] | [ ] |
| 7 | Aplicar un cambio corto | Confirmación, cambio aplicado, mini-quiz | [ ] | [ ] |
| 8 | Aplicar tres cambios más en el mismo archivo | El cuarto se bloquea por cupo | [ ] | [ ] |
| 9 | Apagar la GPU y pedir ayuda | Mensaje controlado; barra «GPU: sin worker activo» | [ ] | [ ] |
| 10 | Revisar `GET /api/telemetry/quality` (docente) | Sin eventos perdidos de la sesión de prueba | [ ] | [ ] |

## 6. Datos de prueba

- Pruebas automáticas y demo: base PostgreSQL en memoria (`pg-mem`) con los
  usuarios y la política de `src/db/seeds.ts`; nunca tocan la base del piloto.
- Modelo: salida de referencia de `src/services/tutor-scenarios.ts` (siempre
  trae más código del permitido) o `setTextModelOverrideForTests` en las pruebas.
- Contra producción: usar cuentas de prueba y anotar la ventana de tiempo que
  imprimen los scripts para excluirla del análisis del piloto; los eventos de
  estabilidad usan `client_session_id` con prefijo `estabilidad-`.

## 7. Lo que no cubre este plan

- Pruebas con estudiantes, instrumentos UX y análisis de KPIs: A13 y A14
  (ciencia de datos).
- E2E automatizado con un navegador real sobre las extensiones: queda manual.
- Carga con decenas de estudiantes simultáneos sobre la GPU: se mide en el
  ensayo del piloto con `medir:latencia --concurrencia`.
