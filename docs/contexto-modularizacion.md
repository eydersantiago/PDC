# Contexto para modularizar ADACEEN (PDC) con Gemini Flash 3.8 High en Antigravity

Preparado el 27 sep 2026 sobre `Código\PDC`, rama `claude/serene-heisenberg-0te9s9` en `ff25fae` (navegador 0.7.15, `npm test` 288/288), con el submódulo `vscode-ext-prod` en `e631350` (0.0.32).

**Para Eyder:** abre `E:\Univalle\16. Décimo Semestre\TGII\Código\PDC` en Antigravity, selecciona Gemini Flash 3.8 High y pega el prompt de la sección 10. Aprueba cada movimiento solo después de revisar su mapa de archivos.

---

## Estado verificado en esta ejecución (27 sep 2026)

- El checkout de la rama base coincide con `ff25fae6690710d266a15e53544f1ff2289edb0b`; el submódulo `vscode-ext-prod` coincide con `e631350c2175ca52260481954dee17548efe23ac`.
- En este entorno (Node v24.13.0, npm 11.6.2): `npm run build` pasó; `npm test` terminó con 251/288 aprobadas, 37 fallidas y 0 omitidas. No se corrigió ningún fallo. La cifra histórica de 288/288 corresponde a la medición anterior indicada arriba, no a esta ejecución.
- En `vscode-ext-prod`: `npm run compile`, `npm run lint` y `npm run test:unit` pasaron; las pruebas unitarias dieron 175/175.
- Usa estos resultados como la línea base de esta ejecución. No atribuyas al refactor los fallos ya presentes antes de mover código; no los arregles dentro de este trabajo.
## 1. Objetivo

Partir los archivos gigantes en módulos por responsabilidad **sin cambiar el comportamiento**. Es un refactor de estructura: se mueve código, no se reescribe. Meta orientativa: ningún archivo fuente de más de ~800–1000 líneas y un archivo por pestaña o dominio.

## 2. Reglas no negociables

1. **Mismo comportamiento.** No cambian los textos de la UI, ids, clases CSS, rutas HTTP, JSON de respuesta, claves de storage, SQL, esquema de base de datos, ids de comandos ni ajustes de VS Code. Si ves un bug, anótalo en la lista final (fase 4) y no lo arregles aquí.
2. **Mover, no reescribir.** Copia los bloques tal cual: mismas comillas, indentación y nombres. No reformatees archivos completos ni «modernices» (`var`→`const`, funciones→clases, etc.).
3. **Pasos pequeños.** Un archivo (o una parte) por paso → validar (sección 8) → commit. Si algo falla y la causa no es obvia, `git restore` del paso y pártelo más pequeño.
4. **Git.** Rama nueva `refactor/modularizacion` desde `claude/serene-heisenberg-0te9s9`. Sin push ni merge; no tocar `master` ni `feature/azure-config-observability` (de ahí se despliega). Commits en español: `refactor(navegador|backend|vscode): … (sin cambios de comportamiento)`.
5. **Versiones:** no se tocan (manifest 0.7.15, VS Code 0.0.32) salvo que Eyder lo pida.
6. **No tocar:** `.env*`, `node_modules/`, `dist/`, `uploads/`, `data/`, `*.traineddata`, los `.zip` de la raíz, `docs/evidencias/`, `deploy/`, los scripts sueltos de la raíz (`run*.ts`, `vision.ts`) ni la carpeta suelta `Código\browser-ext-prod` (copia vieja 0.7.5; la buena es `Código\PDC\browser-ext-prod`).
7. **Fin de línea.** El PC es Windows y git convierte CRLF↔LF. No conviertas finales de línea. Si `git status` muestra archivos que no tocaste, revisa `git diff --ignore-cr-at-eol --stat`; si no hay cambio real, `git checkout -- <archivo>` y fuera del commit. Los `.sh` van siempre en LF (`.gitattributes`).
8. **`AGENTS.md`** vale para validación y seguridad, pero sus rutas están viejas (`agente-proxy-azure`, rutas de Mac): la raíz del repo es `Código\PDC`. Ignora su sección de copiar la extensión a la carpeta suelta y rehacer `browser-ext-prod.zip`; los paquetes se arman con `npm run empaquetar:extension`.
9. **Estilo.** Comentarios en español, como los vecinos. Cada archivo nuevo empieza con una cabecera que diga qué contiene y de dónde salió (modelo: `browser-ext-prod/overlay/content-quizzes.js`).

## 3. Mapa del repo

- **Backend** (raíz de `Código\PDC`, paquete `agente-local`): Node + TypeScript en ESM (`"type": "module"`, imports con extensión `.js`), Express, Postgres (`pg`) y `pg-mem` en pruebas, OpenAI Agents, Azure Service Bus (worker de Ollama/GPU), `exceljs`, `zod`. Entrada `server.ts` → `src/app.ts` → `src/routes/register-routes.ts`. `src/routes/` (un archivo por dominio), `src/services/` (lógica, casi toda pura), `src/db/` (`database.ts`, `schema.ts`), `src/config`, `src/http`, `src/types`. Pruebas en `tests/` (`routes/`, `services/`, `scripts/`, `integration/`).
- **Extensión del navegador** `browser-ext-prod/` (MV3; el empaquetador saca Chromium y Firefox): overlay sobre Campus Virtual (Moodle), GitHub, github.dev y vscode.dev. `state/` (estado), `services/` (llamadas al backend y a APIs), `overlay/` (UI) con `overlay/templates/` (HTML en template strings), `inicio/` (dos content scripts que solo corren en el backend de producción: `/empezar` y `/docente/quices`) y `background.js` (service worker).
- **Extensión de VS Code** `vscode-ext-prod/`: submódulo git (repo aparte `eydersantiago/vscode-ext-prod`), TypeScript + webpack (`dist/extension.js`), eslint y pruebas unitarias con `node --test`.

## 4. Archivos a partir (líneas en `ff25fae`)

| Parte | Archivo | Líneas | Prioridad |
|---|---|---:|---|
| Navegador | `overlay/content-styles.js` | 3837 | Alta (mecánico y verificable byte a byte) |
| Navegador | `overlay/content-lifecycle.js` | 3310 | Alta |
| Navegador | `services/campus.service.js` | 2810 | Media |
| Navegador | `overlay/content-render.js` | 2806 | Alta |
| Navegador | `services/github.service.js` | 2186 | Media |
| Navegador | `services/backend.service.js` | 2104 | Media |
| Navegador | `overlay/content-setup.js` | 1090 | Baja |
| Navegador | `overlay/templates/shell.template.js` | 931 | Baja |
| Backend | `src/db/database.ts` | 5134 | Alta |
| Backend | `src/services/github-app.ts` / `kpis.ts` | 1543 / 1528 | Baja |
| Backend | `src/routes/project-context-routes.ts` / `document-routes.ts` / `github-app-routes.ts` | 1424 / 1408 / 1319 | Baja |
| VS Code | `vscode-ext-prod/src/extension.ts` | 6573 | Alta (el más grande de todos) |

Fuera de este trabajo: las pruebas (p. ej. `tests/scripts/browser-ext-flujo-tunel.test.ts`, 3020 líneas) y `src/db/schema.ts`.

## 5. Extensión del navegador

### 5.1 Cómo se carga (lo que no se puede romper)

- **No hay bundler ni `import`/`export`.** `manifest.json` → `content_scripts[0].js` lista 27 scripts clásicos que se ejecutan en ese orden en el mismo contexto: lo que un archivo declara en el nivel superior (`const`, `let`, `function`, `class`) lo ven los demás. No introduzcas esbuild/webpack ni módulos ES en este trabajo.
- **Dos listas iguales.** `background.js` declara `const CONTENT_SCRIPT_FILES = [...]` con la misma lista y en el mismo orden (el service worker inyecta esos archivos al pulsar el ícono). Todo archivo nuevo va en las dos.
- **Orden actual:** `state/session.state.js`, `state/preferences.state.js`, `overlay/content-context.js`, `overlay/content-guidance.js`, `overlay/content-setup.js`, `services/backend.service.js`, `services/telemetry.service.js`, `services/auth.service.js`, `services/github.service.js`, `services/workspace.service.js`, `services/campus.service.js`, `overlay/content-styles.js`, las 7 plantillas de `overlay/templates/` (welcome, auth, setup, main, guide-list, idea-list, shell), `overlay/content-markup.js`, `overlay/content-a11y.js`, `overlay/content-render.js`, `overlay/content-students.js`, `overlay/content-rag.js`, `overlay/content-quizzes.js`, `overlay/content-project.js` y **`overlay/content-lifecycle.js` al final** (arranca todo).
- **Estado compartido:** `overlayState` (`state/session.state.js`, ~línea 338) y `overlayEls` (referencias a elementos). El overlay vive en un shadow root **cerrado** (`attachShadow({ mode: "closed" })`, `content-lifecycle.js` ~línea 2102) y el CSS entra como `<style>` dentro de un template string (`content-styles.js`); por eso no sirve pasarlo al campo `css` del manifest.
- **No cambies los `matches`** del manifest (también los lee `deploy/produccion.sh`).

### 5.2 Lo que vigila `tests/scripts/browser-ext-structure.test.ts`

- `CONTENT_SCRIPT_FILES` = orden del manifest.
- Todo `.js` de `state/`, `overlay/` y `services/` está en el manifest.
- Sin declaraciones de nivel superior duplicadas entre archivos (duplicar = `SyntaxError` al cargar).
- Sin referencias **en tiempo de carga** a archivos posteriores: el código que corre al cargar (constantes calculadas, IIFE, `addEventListener` sueltos) solo puede usar nombres de archivos anteriores. Dentro de funciones no importa, porque se llaman después.
- Sin nombres sin definir; el zip no lleva `popup/` ni `content.js`.

El arnés `tests/scripts/browser-ext-flujo-tunel.test.ts` lee el manifest y ejecuta los scripts en ese orden dentro de `vm`, así que los archivos nuevos entran solos. Antes de mover algo, busca si una prueba o script lee ese archivo por nombre: `git grep -n "content-render.js" -- tests scripts deploy`.

**Receta al sacar código a un archivo nuevo:** (1) bórralo del original (nada duplicado); (2) agrega el archivo en las dos listas, en su lugar; (3) si solo declara funciones, basta con que vaya antes de `content-lifecycle.js`; si ejecuta algo al cargar, va después de todo lo que usa.

### 5.3 Partición propuesta (confirmar con el mapa antes de mover)

Primero genera el mapa: por archivo, funciones y constantes de nivel superior con su rango de líneas, quién las usa y a qué pestaña pertenecen. El modelo son los módulos recientes (`content-students.js`, `content-rag.js`, `content-quizzes.js`): **un archivo por pestaña con su render y sus eventos**.

1. **`content-styles.js` → `overlay/styles/*.styles.js`**, cortando en bloques **contiguos** (el orden del CSS es la cascada: no reordenar reglas). Por ejemplo: base (variables, reset), shell y pestañas, tutor, estudiantes, usuarios, RAG, quices, tuerca, workspace, responsive/accesibilidad. Cada archivo declara una constante con su trozo; `content-styles.js` conserva el nombre que expone hoy y arma el mismo texto concatenando en el orden original. Los `*.styles.js` van justo antes de `content-styles.js` en las dos listas. **Prueba de oro:** antes y después, cargar los scripts en `vm` con node, volcar el CSS final a un archivo temporal y comparar: debe ser idéntico byte a byte (truco: `vm.runInContext(codigo + ";globalThis.__out = NOMBRE;", ctx)`, porque los `const` de nivel superior no quedan como propiedades del contexto).
2. **`content-render.js` + `content-lifecycle.js` → un archivo por pestaña o área** con su render y sus manejadores, p. ej. `content-home.js` (Inicio, contexto, acción recomendada), `content-tutor.js` (resumen del tutor, pistas, «Fuentes RAG usadas»), `content-users.js` (tabla de usuarios, edición por fila, «RAG aplicado»), `content-settings.js` (tuerca por secciones y ayuda de los RA con `LEARNING_OUTCOME_HELP`), `content-tabs.js` (pestañas por rol y teclado), `content-auth.js` (entrar/salir). En `content-render.js` quedan los helpers comunes; en `content-lifecycle.js`, solo montar el host y el shadow root, inyectar estilos y plantillas, y la secuencia de arranque que llama a los `bind…()`/`render…()`.
3. **Servicios:** `backend.service.js` conserva la base (URL, `fetch` con sesión, manejo de errores) y las llamadas pasan a `services/backend-<dominio>.service.js`, justo después en las listas (tutor, quices, RAG, admin/estudiantes, documentos/bitácora). `campus.service.js` y `github.service.js` se parten por subtema según el mapa (lectura del Campus, bitácora y exportación, calendario; auth/App, repos y PR, codespaces/túneles).
4. **Baja prioridad:** `content-setup.js` y `templates/shell.template.js` (este por paneles, con la misma prueba de oro sobre el HTML final).

## 6. Backend: `src/db/database.ts`

- Hasta la línea 753 hay tipos y helpers; desde la 754, `export class AppDatabase` con todos los métodos; además exporta 2 funciones sueltas. Lo importan 22 archivos de rutas (`import type { AppDatabase } from "../db/database.js"`) y las pruebas lo usan con pg-mem.
- **Estrategia (la API pública no cambia):**
  1. Tipos de filas y DTO a `src/db/types/<dominio>.ts`, re-exportados desde `database.ts` para que ningún import cambie.
  2. Cuerpos de los métodos a `src/db/repos/<dominio>.ts` como funciones que reciben el ejecutor que use la clase (revisa el constructor). En `AppDatabase` quedan métodos de una línea que delegan. **No** cambiar a `db.rag.algo()`: rompería rutas y dobles de prueba.
  3. Dominios probables (confirmar con el mapa): usuarios, auth, sesiones y cursos; telemetría y eventos; tutor, sugerencias e intervenciones; quices (lanzamientos, intentos, banco `teacher_quizzes`); RAG (fuentes, `rag_lots`, `rag_course_lot_settings`, `rag_source_overrides`, `rag_student_lots`); documentos y bitácora; progreso de estudiantes (`listStudentProgressRows`, `getStudentProgressDetailRows`); piloto; workspaces, editor y GitHub.
  4. Sin tocar SQL ni `schema.ts`. Un commit por dominio.
- **Trampas conocidas:** `decision-engine.test.ts` usa una base falsa sin `resolveRagLotForUser` (el motor lo tolera con `typeof … === "function"`). pg-mem devuelve vacío si se combina `is not null` con el filtro por docente en el mismo `where` (por eso hay filtros en el servicio) y el login del admin no funciona en pg-mem (las pruebas crean la sesión directo). `tests/index.test.ts` importa a mano cada archivo de prueba: si creas uno, regístralo ahí.
- **Opcional después:** sacar lógica de las rutas grandes a servicios y partir `kpis.ts` / `github-app.ts` por subtema. `teacher-quiz-page-routes.ts` genera HTML con CSP y nonce: si se toca, el HTML debe quedar idéntico.

## 7. VS Code: `vscode-ext-prod/src/extension.ts`

- Es otro repo (submódulo) en `e631350`, rama `claude/serene-heisenberg-0te9s9`: crea ahí también `refactor/modularizacion`. Commits dentro del submódulo primero; después, en PDC, un commit aparte que actualice el puntero (`git add vscode-ext-prod`).
- Aquí webpack sí permite `import`/`export` normales. Meta: `extension.ts` solo con `activate`/`deactivate` conectando piezas; `src/commands/` (registro de comandos por grupo), `src/views/` (webviews, barra de estado), `src/services/` (backend, auth, túnel/emparejamiento) y el estado compartido en su propio módulo. Sigue el estilo de `editor-session.ts`, `editor-connect.ts`, `code-application-guard.ts` y `quiz-view.ts`.
- No cambian `contributes` de `package.json`, ids de comandos, claves de configuración ni eventos de activación.

## 8. Validación

**Fase 0 (base, en PowerShell dentro de `Código\PDC`):**

```powershell
git status                      # debe estar limpio (ver regla 7)
git switch -c refactor/modularizacion
npm run build
npm test                        # en ff25fae: 288/288 (medido en Linux)
```

Si en Windows alguna prueba ya falla antes de tocar nada, anota cuáles y no las arregles: el criterio es «lo que pasaba sigue pasando». En `vscode-ext-prod`: `npm run compile`, `npm run lint` (0 errores; los warnings viejos no importan) y `npm run test:unit` (si falta `node_modules`, `npm ci` dentro).

**En cada paso:** `node --check` a cada `.js` tocado de la extensión; `npm run build` y `npm test`; revisar `git diff --stat` (lo quitado ≈ lo añadido) y `git diff --color-moved=zebra` (debe verse como código movido, no modificado); prueba de oro para CSS y plantillas.

**Al final (Eyder, a mano):** cargar `Código\PDC\browser-ext-prod` en Chrome (`chrome://extensions` → Cargar descomprimida), entrar al Campus como admin, docente y estudiante y recorrer Inicio, Tutor, Estudiantes, Usuarios, RAG, Quices y la tuerca, con la consola sin errores nuevos. `npm run empaquetar:extension` debe armar los zips sin errores (no los subas al repo).

## 9. Orden de trabajo

- **Fase 0.** Base, rama y commit de este archivo (`docs: contexto de modularización`).
- **Fase 1, navegador.** 1a estilos → 1b pestañas (render + lifecycle) → 1c servicios → 1d setup y plantilla shell (opcional).
- **Fase 2, backend.** 2a tipos de `database.ts` → 2b repos por dominio → 2c rutas y servicios grandes (opcional).
- **Fase 3, VS Code.**
- **Fase 4, docs.** Mapa de archivos en `browser-ext-prod/readme.md`, `AGENTS.md` al día (rutas actuales, regla de las dos listas de carga, cómo validar) y la lista de bugs vistos sin tocar.
- **Cierre:** resumen para Eyder con los commits, las líneas por archivo antes y después, el resultado de las pruebas y lo pendiente.

## 10. Prompt para pegar en Antigravity

```text
Trabaja en E:\Univalle\16. Décimo Semestre\TGII\Código\PDC.
Lee completo docs/contexto-modularizacion.md y luego AGENTS.md; si se contradicen, manda el primero.
Objetivo: modularizar sin cambiar comportamiento, por fases (0 a 4), como dice el documento.
Empieza por la Fase 0 y repórtame el resultado de npm run build y npm test.
En cada paso siguiente: 1) muéstrame el mapa (bloques con rangos de líneas -> archivo nuevo) y espera mi OK;
2) mueve el código sin reescribirlo; 3) valida (node --check, build, test y la prueba de oro en CSS y
plantillas); 4) haz un commit pequeño. Nunca hagas push ni merge. Si una validación falla y no es obvio
por qué, revierte el paso y pártelo más pequeño.
```
