# Checklist WCAG 2.1 AA del overlay de ADACEEN

Jira: A12.9 / ADACEEN-140. Extension de navegador 0.7.8, rama `feat/cierre-pendientes-jira`; la seccion del piloto de la 0.7.9 (`feat/segunda-tanda-jira`) se reviso con los mismos criterios (1.3.1, 4.1.2 y 4.1.3), y las piezas nuevas de la 0.7.11 (acceso simplificado) en la seccion "Revision de la 0.7.11".
Alcance: el overlay que ADACEEN inyecta en Campus Virtual, GitHub, Codespaces y
vscode.dev (shadow DOM), incluidas sus capas: configuracion, analisis, paginas del
docente y modales. Fuera de alcance: el popup (no esta conectado como `default_popup`)
y la ventana de espera del Codespace (documento aparte).

Metodo: revision del codigo y del marcado, calculo de contraste con la formula de
luminancia relativa de WCAG 2.1 sobre los colores de `overlay/content-styles.js`, y
pruebas automaticas de la estructura. **No** se hizo aun la prueba con lectores de
pantalla (NVDA/JAWS/VoiceOver): queda en "Verificacion manual" al final.

Estados: **Cumple**, **Cumple con observaciones** (hay detalles conocidos que no
impiden el uso) y **Pendiente**.

## Criterios revisados

| Criterio | Estado | Evidencia (archivo / funcion) |
|---|---|---|
| 1.1.1 Contenido no textual (A) | Cumple | Glifos decorativos con `aria-hidden="true"` (`brand-dot`, marcas "A", "G", spinners) en `overlay/templates/shell.template.js`. Botones de solo icono (&minus;, &#9881;, &times;) con `aria-label`: "Minimizar ADACEEN", "Configuración", "Cerrar ADACEEN" (antes decia "Salir", igual que cerrar sesion), "Cerrar configuración", "Cerrar análisis", "Cerrar bitácora y volver", "Cerrar fuentes RAG y volver". El overlay no usa imagenes informativas. |
| 1.3.1 Informacion y relaciones (A) | Cumple con observaciones | Dialogo principal `role="dialog"` con nombre; capas con `role="dialog"` y `aria-labelledby` (configuracion con `<h2 id="settingsTitle">`, analisis, bitacora, RAG, modales). Secciones con `h2` y `aria-labelledby` (metas, pistas, siguiente paso, fuentes RAG, opinion). Grupos de casillas con `role="group"` y titulo (`teacherQuizTriggersTitle`, `teacherCodeApplyTitle`, `teacherInterventionsTitle`, cursos); en 0.7.9 la seccion «Piloto con y sin tutor» es un `role="group"` con `aria-labelledby` (`teacherPilotTitle`) y `aria-describedby` (la nota que explica los bloques). Listas reales (`ul`/`ol`), tabla de usuarios con `th` y `aria-label`. Observacion: algunos rotulos de tarjeta siguen siendo `span.eyebrow` en vez de encabezados ("Resumen de sesion", "Contexto actual"). |
| 1.3.5 Identificar el proposito de la entrada (AA) | Cumple | `authEmail` con `autocomplete="username"`, `authPassword` con `current-password`, contrasena temporal del alta con `new-password` (`shell.template.js`). |
| 1.4.1 Uso del color (A) | Cumple | Estados con texto ademas del color (chips "Pendiente"/"Listo", "Gracias. Registramos..."); enlaces RAG subrayados (`.rag-citation-item a`). |
| 1.4.3 Contraste minimo (AA) | Cumple | Tabla de contraste abajo. Se corrigieron 4 pares que fallaban: `--adaceen-muted` (#647184 -> #566476), `--adaceen-warning` (#996a13 -> #875c0f), etiqueta "evaluacion" de la bitacora (#c25b32 -> `--adaceen-accent-strong` #9a4524) y el hover de los botones primarios (#008894 -> #00737d). |
| 1.4.11 Contraste de componentes no textuales (AA) | Cumple | Borde de campos y selects `--adaceen-control-border` #7b8a99 (3,54:1 sobre blanco; antes #d9e2ea, 1,31:1). Anillo de foco #00545d (8,66:1) o blanco sobre la cabecera oscura (>= 7,53:1); antes rgba(0,109,119,.22), 1,39:1. Casillas nativas del navegador. |
| 2.1.1 Teclado (A) | Cumple | Todo control es `button`, `a[href]`, `input`, `select`, `textarea` o `summary` nativo. Las opciones del quiz del docente (`teacherQuizAfterAccept`, `teacherQuizTeacherLaunch`, `teacherQuizFollowUp`, `teacherQuizEveryN`, `teacherQuizMaxPerSession`, lanzar/cerrar quiz) y las de aplicar codigo son casillas y campos nativos con etiqueta (Espacio/flechas). Las filas "switch" pasaron de `div` a `label for=` (`teacherEnabled`, `autoConfigEnabled`, `teacherMiniQuiz`, `teacherNoSolution`). Atajo `Ctrl+Enter` (Cmd+Enter en macOS) dentro del overlay pide ayuda al tutor (`requestTutorFromShortcut`, `overlay/content-a11y.js`), anunciado con `aria-keyshortcuts` en "Actualizar". Arrastrar el overlay es solo de puntero y no es necesario para usarlo. Los renders ya no recrean los controles sin cambios (`renderKeyChanged`, `fillList`, `renderGoalButtons`, opciones de curso, tabla de usuarios, historial, fuentes RAG), asi que el foco del teclado no se pierde con el refresco periodico (cada 5 s en Codespaces). |
| 2.1.2 Sin trampas para el foco del teclado (A) | Cumple | El overlay es un dialogo no modal (`aria-modal="false"`): Tab sale al resto de la pagina. `Escape` cierra la capa abierta o el overlay (`handleOverlayEscapeKey`). Mientras se escribe en un campo del overlay las teclas no llegan a los atajos de GitHub/VS Code web (`handleOverlayKeydown`, `stopEditableKeyPropagation`), lo que evita que la pagina "robe" el foco. |
| 2.4.3 Orden del foco (A) | Cumple | Al abrir por accion del usuario (icono de la extension) el foco entra al dialogo y al cerrar vuelve al elemento previo (`rememberOverlayFocusReturnTarget`, `focusOverlayAfterUserOpen`, `restoreOverlayFocusReturnTarget`; `openOverlay`/`closeOverlay` en `overlay/content-lifecycle.js`). Si se abre solo (overlay fijado al cargar o sincronizado desde otra pestana) no se roba el foco de la pagina. Capas: al aparecer reciben el foco y al cerrarse lo devuelven al control que las abrio (`syncOverlayLayerFocus`). Minimizar lleva el foco a la pestana minimizada y restaurar lo devuelve al dialogo. La configuracion cerrada queda con `visibility: hidden` (fuera del orden de tabulacion). Tras "Me sirvio"/"No me sirvio" el foco pasa al mensaje "Gracias" (los botones se deshabilitan). |
| 2.4.6 Encabezados y etiquetas (AA) | Cumple | Encabezados descriptivos ("Pistas de hoy", "Siguiente paso", "¿Te sirvio esta ayuda?", "Configuracion"); etiquetas visibles en todos los campos de texto. |
| 2.4.7 Foco visible (AA) | Cumple | Regla `:focus-visible` de 3 px (`.shell button/a/input/select/textarea/summary`, al final de `overlay/content-styles.js`) que prevalece sobre el antiguo `outline: none` de los campos; blanco en la cabecera. Los contenedores que reciben foco por programa (`tabindex="-1"`) no dibujan anillo porque no son operables. |
| 2.5.3 Etiqueta en el nombre (A) | Cumple | Los `aria-label` contienen el texto visible ("Salir de la sesion" para "Salir", "Guardar cambios de ..." para "Guardar", "Eliminar (desactivar) a ..." para "Eliminar", "Abrir parte usada de ..." para "Abrir parte usada"). |
| 3.3.2 Etiquetas o instrucciones (A) | Cumple | Campos del alta de usuarios y de la tabla con `aria-label` (antes solo `placeholder`). "Maximo de lineas por aplicacion (1 a 200)" con rango visible y ayuda `aria-describedby`. |
| 4.1.2 Nombre, funcion, valor (A) | Cumple | Dialogo con `role`/`aria-label`; `settingsBtn` con `aria-expanded`/`aria-controls`; metas, cursos y los botones «Iniciar bloque 1» e «Iniciar bloque 2» del piloto con `aria-pressed` (el bloque en curso); «Terminar piloto» se deshabilita sin piloto activo (`renderPilotButtons`); casillas con `label`; controles de aplicar codigo se deshabilitan cuando "Permitir aplicar codigo" esta apagado (`syncCodeApplicationInputsState`). |
| 4.1.3 Mensajes de estado (AA) | Cumple | Zona de respuestas del tutor con `role="region"` + `aria-live="polite"` y `aria-busy` mientras carga (`tutorResponseRegion`); `statusText`, `setupStatusText`, `teacherQuizStatus`, `teacherPilotStatus`, `tutorFeedbackStatus` con `role="status"`; `authError` con `role="alert"`. Solo se reescriben si cambia el texto (`setTextIfChanged`) para no repetir anuncios en cada render. |

## Contraste de los pares principales (texto normal >= 4,5:1; no texto >= 3:1)

Calculado con la formula de WCAG 2.1 sobre los colores de `overlay/content-styles.js`.

| Par (texto / fondo) | Antes | Ahora |
|---|---|---|
| Texto principal #14212f / blanco | 16,30 | 16,30 |
| Texto secundario (`--adaceen-muted`) / blanco | 4,96 | 6,03 |
| Texto secundario / fondo `--adaceen-soft` #eef3f6 (cabecera de tabla, parte baja del cuerpo) | **4,43** | 5,40 |
| Texto secundario / `--adaceen-panel-soft` #f8fafb | 4,73 | 5,76 |
| Texto secundario / `--adaceen-warning-soft` #fff7db | 4,62 | 5,63 |
| Texto secundario / `--adaceen-primary-soft` #e2f3f3 | — | 5,27 |
| Etiqueta de campo #475569 / blanco | 7,58 | 7,58 |
| Rotulo (`--adaceen-primary-strong`) / blanco | 8,66 | 8,66 |
| Pildora #00545d / #e2f3f3 | 7,56 | 7,56 |
| Chip de estado #42566c / #eef3f6 | 6,76 | 6,76 |
| Chip de advertencia (`--adaceen-warning`) / #fff7db | **4,42** | 5,49 |
| Peligro #b42318 / #fff1f0 | 5,98 | 5,98 |
| Etiqueta "evaluacion" de la bitacora / #fff0e9 | **3,91** | 5,81 |
| Boton primario: blanco / degradado #007c87 -> #00545d | 4,96 - 8,66 | 4,96 - 8,66 |
| Boton primario en hover: blanco / degradado | **4,24** - 7,20 | 5,60 - 9,71 |
| Subtitulo de cabecera rgba(255,255,255,.7) / #245c64 - #122033 | 4,63 - 8,60 | 4,63 - 8,60 |
| Resumen docente #38536a / #f1fbfb | 7,63 | 7,63 |
| Banner de operacion #355d63 / #e2f3f3 | 6,33 | 6,33 |
| Rol #33418f / #edf2ff | 8,17 | 8,17 |
| Version #7c4f06 / #fff8e7 | 6,66 | 6,66 |
| Accion "Agregar" #075985 / blanco | 7,56 | 7,56 |
| Accion "Modificar" #6b4e00 / blanco | 7,74 | 7,74 |
| Codigo #dbeafe / #0f172a | 14,63 | 14,63 |
| Sugerencia de linea #e6f4f1 / #122033 | 14,51 | 14,51 |
| Opinion elegida / "Gracias" #00545d / #e2f3f3 - blanco | — | 7,56 - 8,66 |
| (no texto) Borde de campo / blanco | **1,31** | 3,54 |
| (no texto) Borde de campo / #f8fafc | — | 3,38 |
| (no texto) Anillo de foco / blanco | **1,39** | 8,66 |
| (no texto) Anillo de foco blanco / cabecera | — | 7,53 - 16,40 |

Excepciones de WCAG que aplican: controles deshabilitados (opacidad 0,62) y la marca
"G" de Google (logotipo).

## Mapa de teclado del overlay

| Tecla | Efecto |
|---|---|
| Tab / Shift+Tab | Recorre los controles del overlay y sale a la pagina (no hay trampa). |
| Enter / Espacio | Activa botones, casillas y enlaces nativos. |
| Escape | Cierra, en este orden: configuracion, analisis, paginas del docente, aviso de preparacion, eleccion de curso; si no hay ninguna, cierra el overlay y devuelve el foco a la pagina. |
| Ctrl+Enter (Cmd+Enter) | Pide ayuda al tutor (equivale a "Actualizar"; se registra como `tutor_request_submitted` con `value: "shortcut"`). |

## Verificacion automatica realizada (2026-09-23)

Chromium 141 headless con la extension real cargada (`--load-extension`), paginas de
Codespaces y backend simulados con Playwright (scripts de prueba fuera del repo):

- **axe-core 4.10.2**, reglas `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, sobre el
  shadow DOM del overlay en cinco estados (bienvenida, login, modal de privacidad, vista
  principal del estudiante, configuracion del docente): **0 violaciones**. La misma
  auditoria sobre la version anterior (HEAD `9f51643`) daba 2 reglas criticas: `label`
  (casillas "Tutor activo", "Configuracion automatica", "Permitir mini quiz", "Bloquear
  solucion completa"; la configuracion cerrada seguia en el arbol de accesibilidad) y
  `select-name` (`adminCreateTeacher`).
- Recorrido con teclado: el foco entra al dialogo al abrirlo con el icono; `Escape`
  cierra Configuracion y devuelve el foco a la tuerca; un segundo `Escape` cierra el
  overlay y devuelve el foco al campo de la pagina que lo tenia; `Ctrl+Enter` pide
  ayuda; tras "Me sirvio" el foco queda en "Gracias"; el foco en una meta sobrevive al
  refresco de 5 s; lo que escribe el docente en Configuracion no se pisa con el refresco.
- Anillo de foco medido: `outline` solido de 3 px.

## Revision de la 0.7.11 (acceso simplificado, 2026-09-25)

Solo revision del codigo y del marcado, con los mismos criterios; sin lector de
pantalla ni navegador real. Piezas nuevas:

| Pieza | Criterios | Evidencia |
|---|---|---|
| Entrada automatica al volver otro dia («Abrir mi editor» sin «Empezar») | 2.4.3, 3.2.1 | Solo con el clic en el icono (`trigger: "user"`, el foco entra al dialogo como siempre) o al restaurar el overlay fijado en la pestana visible (`"restore"`, no mueve el foco); nunca por sincronizacion entre pestanas (desde la 0.7.12, `autoEnterOnOpen` y `openOverlay` en `overlay/content-lifecycle.js`). |
| Tarjeta unica del tunel («Tu repositorio», «Conectar GitHub») | 1.3.1, 4.1.3 | Mismo marcado de la tarjeta del paso 1; los botones que no aplican se ocultan con `hidden` (fuera del arbol de accesibilidad) y el estado sigue en `setupStatusText` (`role="status"`). |
| Aviso del codigo en `github.com/login/device` | 1.3.1, 1.4.3, 2.4.7, 4.1.2, 4.1.3 | `aside` con `role="region"` y `aria-label`; el estado con `role="status"`; «Copiar codigo» y el cierre (`aria-label="Ocultar el codigo"`) son `button` nativos con anillo de 3 px. Contraste: texto #f8fbff sobre #06131b 18,1:1; codigo #76efe5 13,7:1; boton #07353b sobre #dffffb 12,5:1; anillo #ffd08a 13,1:1 (`showGithubDeviceCodeHelper`, `services/workspace.service.js`). No mueve el foco de la pagina de GitHub. |
| Pagina `/empezar` del backend (fuera del overlay) | 1.3.1, 1.4.3, 2.4.1, 2.4.7, 4.1.3 | `lang="es"`, enlace «Saltar a los pasos», encabezados `h1`/`h2` con `aria-labelledby`, lista de estado con `aria-live="polite"` y aviso de copia en una region `sr-only` con `aria-live`; estado con texto ademas del color. Contraste: #172033 sobre blanco 16,3:1; #4a5868 sobre blanco 7,3:1; blanco sobre #0b5f59 7,5:1, sobre #8a4b00 6,8:1 y sobre #a3242a 7,4:1; anillo de 3 px #1d4ed8 6,7:1. Botones de descarga de 44 px de alto; «Copiar direccion», de 36 px (`src/routes/start-page-routes.ts`). |

## Revision de la 0.7.12 (auditoria de redundancias, 2026-09-25)

Solo revision del codigo y del marcado, con los mismos criterios; sin lector de
pantalla ni navegador real.

| Pieza | Criterios | Evidencia |
|---|---|---|
| Entrada sin «Empezar» (login directo sin sesion; panel con sesion) | 2.4.3, 3.2.1 | La entrada al abrir es `autoEnterOnOpen`: con el icono (`"user"`) el foco va al dialogo; al restaurar (`"restore"`) no se mueve el foco y no entra en las paginas del propio flujo de GitHub ni en paginas sin contexto. Mientras confirma la sesion, «Preparando...» deshabilitado (como mucho 10 s). |
| Un solo «Salir» y la tuerca bajo la cabecera | 2.4.3, 2.4.11 | La configuracion se abre debajo de la cabecera (`--adaceen-settings-top`, `setSettingsOpen`): «Salir» sigue visible y en el orden de tabulacion con la tuerca abierta. |
| Espera de la GitHub App (Codespaces) y verificacion de Campus al entrar | 4.1.3 | La espera de la App se anuncia en `setupStatusText` (`role="status"`); los fallos de la verificacion de Campus se escriben tambien en `statusText` (`role="status"`), y cuando sale bien no se anuncia nada nuevo. |

## Verificacion manual pendiente

1. Chrome + NVDA (Windows) y Safari/Chrome + VoiceOver (macOS): abrir el overlay con el
   icono, recorrerlo con Tab, pedir ayuda y confirmar que se anuncia la respuesta una sola
   vez; elegir "Me sirvio" y oir "Gracias...".
2. Zoom del navegador al 200 % y ancho de 320 px (1.4.4 / 1.4.10): el overlay usa
   `min(..., calc(100vw - 32px))` y la media query de 640 px; revisar que no se corte
   la configuracion.
3. Modo de alto contraste de Windows: el anillo de foco usa `outline`, que el sistema
   respeta.
4. Pendiente de diseno: convertir los rotulos `span.eyebrow` de tarjetas en encabezados
   (1.3.1) y revisar la ventana de espera del Codespace con el mismo checklist.
5. 0.7.11 con lector de pantalla: que el aviso del codigo en `github.com/login/device`
   se pueda alcanzar con Tab y se anuncie su estado, y que `/empezar` anuncie el cambio
   de «Buscando» a «Instalada» una sola vez.
