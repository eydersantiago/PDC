# ADR-001: Motor de políticas y cambio de arquitectura (GUÍA + relay → Azure + Google Cloud)

| | |
|---|---|
| Estado | **Propuesto**, pendiente de aprobación del director |
| Fecha | 24 de septiembre de 2026 |
| Jira | A9.6 · ADACEEN-88 |
| Criterio de cierre | ADR aprobado por el director (correo o acta) y enlazado en A16.2 (ADACEEN-130) |
| Documentos relacionados | [Ruta de datos](ruta-de-datos.md), [escenarios](../tutor/escenarios.md), [plantillas](../tutor/plantillas-intervencion.md), [trazabilidad](../telemetria/trazabilidad-decisiones.md), `docs/workspaces-tunnel.md`, `docs/gcp-worker-infraestructura.md` (rama `master`) |

## Contexto

El anteproyecto planteó un tutor agéntico para el curso FPOO con la
**inferencia centralizada en el laboratorio GUÍA** (el servicio en un nodo del
laboratorio y el modelo en su GPU), **Azure solo como pasarela de conectividad,
sin inferencia**, y una pasarela autoalojada en infraestructura institucional
como contingencia. También justificó descartar la API de OpenAI por costos.
Durante la construcción cambiaron tres cosas que el anteproyecto no registra:

1. El backend completo (API, base de datos, políticas, RAG, telemetría) quedó en
   Azure App Service, y la inferencia en máquinas con GPU de Google Cloud
   conectadas por una cola de Azure Service Bus.
2. El entorno del estudiante pasó de GitHub Codespaces a VS Code en el
   navegador (`vscode.dev`) conectado por VS Code Tunnels a una máquina de
   editores en Google Cloud.
3. El motor de políticas del docente pasó de gobernar solo el overlay del
   navegador a gobernar también las sugerencias y la aplicación de código en
   VS Code.

Este ADR registra esas decisiones para el director y para el documento final.

## Decisión 1: motor de políticas del docente

Un solo motor, con la misma política del docente, decide en los dos canales:
el overlay del navegador (`POST /intervene`, `src/services/decision-engine.ts`)
y VS Code (`POST /suggest-tab` y `POST /api/suggestions/apply-check`,
`src/services/suggestion-policy.ts`).

| Aspecto | Decisión |
|---|---|
| Tipos de evento | `compile_error`, `runtime_error`, `concept_question`, `design_block`, `workflow_guidance`, `insufficient_context`, `out_of_domain` y, en VS Code, `code_suggestion`. Cada uno tiene una regla del docente: activa o no, tipo de intervención, nivel de detalle, umbral de señales y usos por sesión. |
| Prioridad de detección | Primero la falta de contexto y el dominio; luego el error visible (compilación antes que ejecución); luego la pregunta (flujo de trabajo, concepto, diseño). En VS Code un error visible manda sobre la pregunta. Detalle en [escenarios.md](../tutor/escenarios.md). |
| No inventar | Falta de contexto y consulta fuera del curso responden el mensaje controlado del docente **sin llamar al modelo**. |
| Ayuda gradual | Pista 1 → pista 2 → ejemplo parcial según las ayudas ya usadas en el ejercicio (nivel «Progresiva»); explicación breve para conceptos. Respeta las intervenciones que el docente habilitó. |
| Límite de pistas | `maxHintsPerExercise` (3 en el piloto). Overlay: al llegar al límite, bloqueo con `hint_limit_reached`. VS Code: la sugerencia sigue como guía y se bloquea la aplicación de código. |
| Límites anti-solución | Límite de código por etapa aplicado sobre la salida del modelo (overlay: 0, 2, 8 líneas; VS Code: 5, 10 y el máximo del docente). Si el código se recorta o no se puede aplicar, se quita la línea «Aplicar:». |
| Aplicación de código | Solo con verificación del servidor (apply-check), confirmación del estudiante y dentro del cupo por archivo; cuenta como pista. |
| Respaldo | Sin modelo: respuesta heurística (overlay), mensaje controlado (VS Code) y banco de preguntas validadas (mini-quiz). Con latidos de los workers, si no hay ninguno vivo el backend no encola y responde en segundos. |
| Trazabilidad | Cada decisión es un evento `tutor_decision` con `decision_id`, evento, etapa, motivo y latencia, sin textos ni identidades ([trazabilidad](../telemetria/trazabilidad-decisiones.md)). |

## Decisión 2: backend en Azure e inferencia en Google Cloud por cola

- **API:** Express/TypeScript en Azure App Service con PostgreSQL. Es el único
  punto al que hablan las extensiones.
- **Inferencia:** Ollama con `qwen2.5-coder:14b` en una máquina con GPU de
  Google Cloud. Hay tres configuradas y solo una encendida a la vez (la cuota
  de GPU del proyecto es 1): V100 bajo demanda primero, A100 Spot y L4 Spot.
- **Enlace:** Azure Service Bus (`AGENT_TARGET=queue`): el API deja el trabajo
  en una cola y espera el resultado en otra con sesiones. El worker solo abre
  conexiones salientes: no tiene IP pública ni puertos abiertos, y se puede
  cambiar de máquina (Colab, un portátil, otra GPU) sin tocar el API ni las
  extensiones.
- **Latido:** cada worker avisa al API cada 30 s; `/api/agent/health` responde
  503 si no hay ninguno vivo (alarma de disponibilidad).

## Decisión 3: entorno del estudiante con VS Code Tunnels

`vscode.dev` conectado por un túnel por estudiante (`ad-<login>`, registrado en
su propia cuenta de GitHub con un código de dispositivo que teclea una vez) a
una máquina de editores e2-standard-4 **sin Spot**, con la extensión ADACEEN y
las herramientas del curso. GitHub Codespaces queda como respaldo
(`ADACEEN_WORKSPACE_PROVIDER`).

## Motivos

| Motivo | Evidencia |
|---|---|
| Disponibilidad | El servicio tiene que estar accesible desde fuera de la red interna en el horario de clase. La nube quita la dependencia de la red y del laboratorio; con Service Bus, si una GPU cae, el trabajo vuelve a la cola y lo toma otra. (El motivo concreto por el que no se usó GUÍA debe quedar por escrito en la aprobación.) |
| Rendimiento | Medido el 24-sep-2026: `/run-text` en caliente de 2,2 a 6,9 s (V100) y de 3,5 a 6,8 s (A100); generación de 66,5 tok/s (V100) y 83,5 tok/s (A100) frente a 26,5 tok/s (L4). |
| Costo | 300 USD de crédito en Google Cloud. L4 ~0,85 USD/h, A100 Spot ~2,2 USD/h, V100 ~2,9 USD/h; máquina de editores ~0,13 USD/h. La GPU se enciende solo para las sesiones y se apaga sola tras 180 min sin actividad. |
| Arranque del entorno | Un Codespace tardaba de 20 a 50 min en crearse (descarga de la imagen del host de GitHub a ~5 MB/s). Con el túnel, el editor abre en segundos y el entorno queda listo en ~80 s. |

## Alternativas consideradas

| Alternativa | Por qué no |
|---|---|
| Mantener GUÍA + Azure como pasarela (anteproyecto) | Depende de la red interna y del laboratorio para un servicio que los estudiantes usan desde fuera; la pasarela sola no resolvía dónde viven las políticas, el RAG y la telemetría. |
| Inferencia en el propio App Service | Sin GPU; latencias inaceptables con un modelo de 14B. |
| API de un proveedor comercial de modelos (OpenAI) | El anteproyecto ya la descartó por costos; además enviaría el código de los estudiantes a un tercero. |
| GitHub Codespaces como entorno | 20 a 50 min de creación, fuera de nuestro control. Queda como respaldo. |
| openvscode-server / code-server | Extensiones desde Open VSX (ADACEEN no está), autenticación propia, más código. |
| Cloud Workstations | Identidad Google (no GitHub) y costo fijo del clúster. |
| Máquina de editores en Spot | Un desalojo tumba a toda la clase. |
| Registrar el túnel con el token OAuth de ADACEEN | El API de Dev Tunnels rechaza (401) tokens que no emite la app de VS Code. |

## Consecuencias

**Positivas:** respuestas en segundos con la GPU encendida; el worker se
reemplaza sin tocar el resto; entorno listo en minutos; una sola política
gobierna overlay y VS Code; cada decisión queda trazada sin datos sensibles.

**Negativas:** dos nubes que operar (Azure y Google Cloud) y un runbook más
largo; la GPU hay que encenderla para cada sesión; el código del estudiante
viaja al worker de Google Cloud para la inferencia (no se guarda allí, pero el
consentimiento debe decirlo); dependencia de Microsoft Dev Tunnels para el editor.

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Desalojo Spot de la GPU | La V100 bajo demanda va primero; el trabajo vuelve a la cola y otro worker lo toma; latido y salud 503 avisan; respuesta controlada mientras tanto. |
| Falta de cupo de GPU (visto el 23–24 sep, incluso bajo demanda) | Tres tipos de GPU en orden; encender antes de clase; respaldo en otra zona o región por evaluar; modo degradado. |
| Arranque en frío | Precarga del modelo al arrancar y `OLLAMA_KEEP_ALIVE=-1` (primera petición de 61 s a 4,8 s en la A100); trabajo de calentamiento antes de clase. |
| Vigencia de los créditos | Apagado automático por inactividad; seguimiento del gasto con `deploy/gcp/teardown.sh`. |
| Límites de Dev Tunnels (ancho de banda no publicado, 10 túneles por cuenta) | Un túnel por estudiante en su propia cuenta; medir en el ensayo del piloto; plan C: openvscode-server. |
| Privacidad de datos de estudiantes en la nube | Telemetría seudonimizada y minimizada; el worker no guarda prompts; retención definida; consentimiento que nombre las nubes y regiones (A5). |
| Camino de red Azure → agente de la máquina de editores | Pendiente de montar (propuesta en `docs/workspaces-tunnel.md`). |

## Qué cambia frente al anteproyecto (secciones 7.2 y 8.2)

| Tema | Anteproyecto | Hoy | Por confirmar con el director |
|---|---|---|---|
| Dónde corre el modelo | GPU del laboratorio GUÍA (servicio en un nodo del laboratorio) | GPU en Google Cloud por cola de Service Bus | Aceptar el cambio y cómo se documenta. |
| Papel de Azure | Pasarela de conectividad, sin inferencia | Backend completo (API, base, políticas, RAG, telemetría) | — |
| Contingencia | Pasarela autoalojada en infraestructura institucional | Varios workers en la cola, modo degradado con respuestas controladas, worker alterno (Colab o local) | — |
| Limitaciones (7.2) | Dependencia de la pasarela en Azure | Disponibilidad de GPU (Spot y cupo), vigencia de los créditos y límites de Dev Tunnels | Actualizar la sección de limitaciones. |
| Entorno del estudiante | — | `vscode.dev` + VS Code Tunnels; Codespaces de respaldo | — |
| Contexto que se envía | Limitado y explícitamente permitido (selección, errores, instrucciones) | VS Code envía el archivo activo (hasta 12 000 caracteres) | Aceptarlo en el consentimiento o reducir el envío. |
| Latencia objetivo | p50 ≤ 4 s (local) y ≤ 8 s (híbrido) en 5.4; ≤ 10 s en A9 | p50/p95 por medir con la GPU encendida (`npm run medir:latencia`); `/run-text` en caliente de 2,2 a 6,9 s | Unificar el umbral. |
| Navegadores | Extensión WebExtensions para Firefox y Chromium | Ambos; en Firefox sin inicio de sesión con Google ni Calendar | — |

## Aprobación

| Rol | Nombre | Decisión | Fecha | Medio (correo o acta) |
|---|---|---|---|---|
| Director | | | | |
| Estudiante | Eyder Santiago Suárez Chávez | Propone | 24-sep-2026 | Este documento |
