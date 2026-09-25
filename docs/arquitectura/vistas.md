# Vistas de la arquitectura: contenedores y secuencias

| | |
|---|---|
| Jira | A9.6 · ADACEEN-88 (ADR); insumo de A16.2 · ADACEEN-130 (capítulo de arquitectura) |
| Fecha | 24 de septiembre de 2026 |
| Relacionados | [ADR-001](adr-001-motor-y-arquitectura.md), [ruta de datos](ruta-de-datos.md), [contrato de la API](contrato-api.md), [escenarios](../tutor/escenarios.md), [entornos por túnel](../workspaces-tunnel.md) |

El anteproyecto (5.4, objetivo específico 1) pide un documento de arquitectura
con vista C4 y diagramas de secuencia de las intervenciones. Este documento
tiene la vista de contenedores (nivel 2 del modelo C4) y dos secuencias: una
ayuda del tutor en VS Code y la preparación del entorno por el relay. La vista
de despliegue, con lo que viaja por cada tramo, está en la
[ruta de datos](ruta-de-datos.md).

Los diagramas están en Mermaid, que GitHub dibuja directamente. Las imágenes
para el documento de grado se generan con `mmdc` (Mermaid CLI) a partir de
estos mismos bloques.

## 1. Contenedores (C4, nivel 2)

```mermaid
flowchart TB
  EST(["Estudiante"])
  DOC(["Docente"])

  subgraph EQ["Equipo del estudiante (sala de sistemas)"]
    OV["Extensión de navegador<br/>MV3, JavaScript<br/>overlay en Campus, GitHub y vscode.dev"]
    VD["vscode.dev<br/>VS Code en el navegador"]
    VL["VS Code instalado<br/>(p. ej. Mac del laboratorio)<br/>+ extensión ADACEEN"]
  end

  subgraph AZ["Microsoft Azure"]
    API["API ADACEEN<br/>App Service, Node.js y TypeScript<br/>motor de políticas, RAG, telemetría, piloto"]
    DB[("PostgreSQL<br/>cuentas, políticas, material,<br/>telemetría seudonimizada")]
    SB[["Service Bus<br/>llm-jobs · llm-results-sessions"]]
  end

  subgraph GCP["Google Cloud · us-central1"]
    VM["VM de editores<br/>VS Code Server + extensión ADACEEN<br/>+ agente de entornos"]
    WK["Worker GPU<br/>Ollama · qwen2.5-coder:14b<br/>V100, A100 o L4"]
  end

  subgraph UV["Laboratorio de Univalle"]
    MW["Mac servidor<br/>worker + Ollama"]
    MC["Clúster de Mac<br/>coordinadora + nodos (llama.cpp RPC)"]
  end

  GH["GitHub<br/>repositorios, OAuth, GitHub App"]
  GO["Google<br/>inicio de sesión y Calendar"]
  DT["Microsoft Dev Tunnels"]
  CV["Campus Virtual"]

  EST -->|"pide ayuda, practica"| OV
  EST -->|"programa"| VD
  DOC -->|"política, quiz, piloto"| OV
  OV -->|"HTTPS · /intervene, /api/*"| API
  OV -.->|"lee la página"| CV
  OV -.->|"solo Chromium"| GO
  VD <-->|"túnel ad-login"| DT
  DT <--> VM
  VM -->|"HTTPS · /suggest-tab, apply-check, telemetría"| API
  VM -->|"HTTPS de salida · relay de entornos"| API
  API -->|"SQL sobre TLS"| DB
  API <-->|"AMQP sobre TLS"| SB
  WK -->|"AMQP saliente · toma jobs, deja resultados"| SB
  WK -.->|"latido HTTPS"| API
  SB <-->|"AMQP en WebSocket 443<br/>(la Mac abre la conexión)"| MW
  SB <--> MC
  VL -->|"HTTPS · /suggest-tab, telemetría"| API
  EST -->|"programa"| VL
  API -->|"OAuth, GitHub App"| GH
  VM -->|"clona el repositorio"| GH
```

| Contenedor | Tecnología | Responsabilidad | Código |
|---|---|---|---|
| Extensión de navegador | WebExtensions MV3 (Chromium y Firefox 128+), JavaScript sin dependencias | Overlay con el tutor, captura del contexto de la página, configuración del docente, piloto con y sin tutor, telemetría del overlay | `browser-ext-prod/` |
| Extensión de VS Code | TypeScript, API de extensiones de VS Code | Sugerencias sobre el archivo activo, señales de error, bloqueo y desbloqueo, aplicación de código con verificación, mini-quiz | `vscode-ext-prod/` (submódulo) |
| API ADACEEN | Node.js, Express y TypeScript en Azure App Service | Autenticación, motor de políticas, plantillas y guardarraíles, RAG, cola de inferencia, telemetría, piloto, KPIs, relay de entornos | `src/` |
| PostgreSQL | Azure Database for PostgreSQL | Estado del sistema y telemetría seudonimizada | `src/db/schema.ts` |
| Service Bus | Azure Service Bus (cola de trabajos y cola de resultados con sesiones) | Desacoplar el API de la GPU: el worker solo abre conexiones salientes | `src/services/service-bus-agent.ts` |
| Worker GPU | Node.js y Ollama en VMs con GPU de Google Cloud | Inferencia del modelo de lenguaje; latido cada 30 s | `scripts/service-bus-ollama-worker.ts`, `deploy/gcp/` |
| Mac del laboratorio | El mismo worker con Ollama como servicio de launchd; o un clúster (llama-server en la coordinadora, ggml-rpc-server en los nodos) | Inferencia intercambiable con la GPU, desde hardware de la universidad; solo conexiones de salida por el 443 | `deploy/mac/`, [worker-mac](../operacion/worker-mac.md) |
| VM de editores | e2-standard-4 sin IP pública, VS Code Server, túneles por estudiante | Entorno de programación de cada estudiante con ADACEEN instalado | `deploy/gcp/workspaces/` |

## 2. Secuencia: una ayuda del tutor en VS Code

```mermaid
sequenceDiagram
  autonumber
  actor E as Estudiante
  participant V as Extensión de VS Code<br/>(VM de editores)
  participant A as API ADACEEN<br/>(Azure)
  participant D as PostgreSQL
  participant Q as Service Bus
  participant W as Worker GPU<br/>(Google Cloud)

  E->>V: Error que persiste (bloqueo) o código seleccionado
  V->>A: POST /suggest-tab (archivo activo, diagnósticos, disparador)
  A->>D: Política del docente, condición del piloto, ayudas usadas, material
  D-->>A: Política, bloque y cohorte, pistas usadas, extractos
  Note over A,D: Clasifica el evento y decide la etapa (pista 1, pista 2 o ejemplo parcial) y el límite de código
  alt Sin contexto, fuera del curso o bloque sin tutor
    A-->>V: Mensaje controlado, sin llamar al modelo
  else Ayuda permitida
    A->>Q: Job con la instrucción de la etapa y los extractos
    Q->>W: El worker toma el job (conexión saliente)
    Note over Q,W: Genera la respuesta con qwen2.5-coder:14b
    W->>Q: Resultado en la cola con sesiones
    Q-->>A: Resultado
    Note over A,D: Guardarraíl: recorta el código al límite y quita «Aplicar:» si no se puede aplicar
    A->>D: Evento tutor_decision (seudonimizado)
    A-->>V: Sugerencia, decision_id y code_application
  end
  E->>V: «Aplicar»
  V->>A: POST /api/suggestions/apply-check (líneas cambiadas, sin código)
  A-->>V: allowed, requireConfirmation, remaining
  V->>E: Confirmación y cambio aplicado (se deshace con Ctrl+Z)
  V-)A: Telemetría: suggestion_completion_applied y, al desaparecer el error, blocking_resolved
```

En el overlay del navegador la secuencia es la misma hasta el guardarraíl, con
`POST /intervene` en lugar de `/suggest-tab`: el mismo motor decide la etapa,
el límite de pistas y el mensaje controlado, y el overlay no aplica código.

## 3. Secuencia: preparar el entorno por el relay (A15.3)

```mermaid
sequenceDiagram
  autonumber
  actor E as Estudiante
  participant X as Extensión de navegador
  participant A as API ADACEEN<br/>(Azure)
  participant G as Agente de entornos<br/>(VM de editores)
  participant H as GitHub

  G->>A: GET /api/workspaces/agent/next?wait=25 (sondeo largo, x-agent-token)
  E->>X: «Preparar entorno»
  X->>A: POST /api/workspaces/prepare (repositorio)
  Note over A,G: Encola la petición (cola en memoria del API)
  A-->>G: Trabajo: preparar el editor de login con el repositorio
  G->>H: Clona el repositorio público
  Note over G,H: Crea el usuario ws-login y arranca el túnel ad-login
  G->>A: POST /api/workspaces/agent/responses (código de dispositivo, túnel, URL)
  A-->>X: Estado y código de dispositivo
  E->>H: Escribe el código en github.com/login/device y autoriza
  X->>A: GET /api/workspaces/status (sondeo)
  A-->>G: Trabajo: estado del editor (por el mismo relay)
  G->>A: Estado: listo
  A-->>X: Listo, con la URL del editor
  X->>E: Abre vscode.dev/tunnel/ad-login/…
```

La VM no tiene IP pública ni puertos de entrada: todo lo inicia el agente con
HTTPS de salida por Cloud NAT. Si el agente no ha sondeado en 60 s, el API
responde de inmediato que el entorno no está disponible, en vez de esperar.

## Cómo mantenerlo

- Si cambia un contenedor o una interfaz, actualizar este documento, la
  [ruta de datos](ruta-de-datos.md) y el [contrato de la API](contrato-api.md)
  en el mismo commit.
- Imágenes para Word: `npx -p @mermaid-js/mermaid-cli mmdc -i <bloque>.mmd -o <salida>.png`.
