# Revision de seguridad del overlay de la extension de navegador

Jira: A12.8 / ADACEEN-139. Rama `feat/cierre-pendientes-jira`, extension 0.7.8.
Alcance: todo `browser-ext-prod/` (content scripts del overlay, service worker y popup).

## Metodo

1. Inventario de sumideros con busqueda en todo el codigo:
   `innerHTML`, `insertAdjacentHTML`, `outerHTML`, `document.write`, `eval`,
   `new Function`, temporizadores con texto, `DOMParser`, `href`/`src` asignados,
   `location.href`/`location.assign` y `window.open`.
2. Para cada sumidero, origen del dato: **constante** (plantilla del propio
   codigo), **backend** (respuestas de la API), **modelo** (texto generado por la
   IA que llega via backend), **pagina** (DOM de GitHub, Campus o VS Code web) o
   **almacenamiento** (`chrome.storage`, que la pagina no puede escribir pero un
   valor viejo o manipulado si).
3. Regla aplicada: todo dato no confiable se pinta con `textContent` o escapado;
   toda URL no constante se valida con `toSafeHttpUrl` (solo `http:`/`https:`,
   bloquea `javascript:`, `data:`, `vbscript:`, `blob:`, `file:`...) y los enlaces
   a otra pestana llevan `rel="noopener noreferrer"` (o `window.open(..., "noopener,noreferrer")`).
4. Prueba automatica nueva para que no vuelvan `eval`/`new Function` (ver al final).

La utilidad central es `toSafeHttpUrl(value, baseUrl)` en
`browser-ext-prod/overlay/content-context.js` (capa 2, disponible para todos los
archivos). En el ciclo de vida, `openExternalUrlSafely(url)`
(`overlay/content-lifecycle.js`) la combina con `window.open(..., "noopener,noreferrer")`.

## Hallazgos y correcciones

| ID | Severidad | Donde | Problema | Estado |
|---|---|---|---|---|
| S1 | Alta | `services/github.service.js` `navigatePendingCodespaceWindow`, `updateCodespaceWaitingWindow` | La URL del Codespace / tunel que devuelve el backend (`web_url`, `fallbackUrl`, `workspace.webUrl`, `deviceCode.verificationUrl`) se asignaba sin validar a `location.href` de la ventana de espera y a `href` de sus enlaces. Esa ventana es `about:blank` abierta por el content script y **hereda el origen de la pagina** (github.com, campusvirtual...): una URL `javascript:` ejecutaria codigo con ese origen. | Corregido: `toSafeHttpUrl`; si no es http/https se cierra la ventana y no se navega. |
| S2 | Media | `overlay/content-render.js` `buildRagSourceViewerHref`, `renderRagSourcesPanel` | Para enlaces RAG que no eran el visor de ADACEEN se devolvia el texto original del backend/modelo (podia ser `javascript:` o `data:`); el enlace usaba `rel="noreferrer"` sin `noopener` explicito. | Corregido: solo http/https (rutas relativas se resuelven contra el backend) y `rel="noopener noreferrer"`. |
| S3 | Media | `overlay/content-render.js` `buildRagSourceViewerHref` | El `sessionId` se agregaba a **cualquier** URL cuya ruta fuera `/api/rag/sources/<id>/view`, sin mirar el origen: una fuente con URL de otro dominio y esa ruta recibia la sesion del estudiante. | Corregido: la sesion solo se agregaba si el origen era el del backend. Desde 0.7.8 no se agrega nunca (ver R2). |
| S4 | Media | `services/campus.service.js` `openCampusDateSourceWithLeftClick` | `window.location.assign(url)` con la URL de la fuente de fechas que viene del analisis del backend, sin validar esquema (ejecucion en el origen de Campus). | Corregido: `toSafeHttpUrl(url, location.href)`. |
| S5 | Media | `services/github.service.js` `startGithubUserOAuthFlow`, `startGithubAppInstallFlow` | `authorizeUrl` e `installUrl` del backend se asignaban a `location.href` de una ventana `about:blank` (mismo origen que la pagina) sin validar. | Corregido: se exige http/https; si no, error visible y no se navega. |
| S6 | Baja | `overlay/content-lifecycle.js` (`openCodespacesPage`, `openCodespacesManualPage`, accion `open_setup_pr`, `openCampusCalendarDraft`) y `services/campus.service.js` `syncCampusCalendarToGoogle` | `window.open` con URLs del backend (Codespace, PR) y de Google Calendar (`htmlLink`) ya usaban `noopener,noreferrer`, pero sin validar el esquema. | Corregido: `openExternalUrlSafely` / `toSafeHttpUrl`; mensaje "El enlace ... no es valido" si se rechaza. |
| S7 | Baja | `popup/popup.js` `renderVisualRecommendations` | `article.innerHTML` interpolaba `language`, que puede derivarse del contexto de la pagina, en el contexto privilegiado de la extension (`chrome-extension://`). | Corregido: nodos creados con `textContent`. |
| S8 | Baja | `overlay/content-render.js` `saveSettingsFromOverlay`, `state/preferences.state.js` `resolveStoredBackendUrl` | La URL del backend configurable (y la guardada en storage) no se validaba; es la base de enlaces y peticiones. | Corregido: solo http/https; un valor invalido conserva el anterior (ajustes) o vuelve al valor por defecto (storage). |
| S9 | Baja | `overlay/content-lifecycle.js` `ensureOverlay` | El shadow root era `open`: cualquier script de la pagina anfitriona podia leer los campos del overlay (incluida la contrasena del login) con `host.shadowRoot`. | Mitigado: `attachShadow({ mode: "closed" })`. Ver riesgo R1: la pagina aun puede observar pulsaciones. |
| S10 | Info | `overlay/content-render.js` `renderAdminUsersTable` | `adminCreateTeacher.innerHTML = ""` (solo limpieza, sin dato). | Cambiado a `textContent = ""` por consistencia. |

## Inventario de sumideros tras la revision

| Archivo : funcion | Sumidero | Dato | Veredicto |
|---|---|---|---|
| `overlay/content-lifecycle.js` : `ensureOverlay` | `overlayRoot.innerHTML = buildOverlayMarkup()` | Constante: plantilla del shell; solo interpola `OVERLAY_STYLES` y `ADACEEN_BROWSER_EXTENSION_LABEL` (constantes). | Seguro. Todo dato dinamico se pinta despues con `textContent`. |
| `services/github.service.js` : `openCodespaceWaitingWindow` | `pendingWindow.document.write(...)` | Constantes + `repo`, etiqueta de version y diapositivas, todo pasado por `escapeWaitingPageText`; URLs de fondo de `chrome.runtime.getURL` pasadas por `escapeWaitingPageCssUrl`. | Seguro (escapado). |
| `services/github.service.js` : `updateCodespaceWaitingSlides` | `panelsMount.innerHTML`, `dotsMount.innerHTML` | Diapositivas con datos de sesion, proyecto, agenda y RAG: cada texto pasa por `escapeWaitingPageText`. | Seguro (escapado). |
| `services/github.service.js` : `updateCodespaceWaitingWindow` | `directLink.href`, `quickstartLink.href` | Backend. | Corregido (S1). |
| `services/github.service.js` : `navigatePendingCodespaceWindow` | `pendingWindow.location.href`, `window.open` | Backend. | Corregido (S1). Antes de navegar se pone `pendingWindow.opener = null`. |
| `services/github.service.js` : OAuth / instalacion | `location.href` de ventana pendiente, `window.open` | Backend. | Corregido (S5). |
| `overlay/content-render.js` : `renderRagSourcesPanel` | `link.href` | Backend / modelo. | Corregido (S2, S3). |
| `services/campus.service.js` : `openCampusDateSourceWithLeftClick` | `window.location.assign` | Backend (analisis de Campus). | Corregido (S4). |
| `services/campus.service.js` : `downloadTeacherBitacoraTemplate` | `anchor.href = URL.createObjectURL(blob)` | Blob creado localmente. | Seguro. |
| `services/campus.service.js` : `extractCampusDocumentUrlFromHtml` | `new DOMParser().parseFromString(html)` | Pagina / Campus. | Seguro: documento inerte (no ejecuta scripts ni se inserta en el DOM); las URL que extrae pasan por `resolveCampusUrl`, que descarta `javascript:`, `data:`, `mailto:` y `tel:`. |
| `overlay/content-context.js` : `extractCampusSectionHtml` | `clone.outerHTML` (lectura) | Pagina. | No es sumidero: se lee y se envia al backend como texto. |
| `overlay/content-lifecycle.js` : `openExternalUrlSafely` | `window.open(safeUrl, "_blank", "noopener,noreferrer")` | Backend / constantes. | Seguro. |
| `popup/popup.js` | `innerHTML` | Pagina. | Corregido (S7). |
| Todo `browser-ext-prod` | `eval`, `new Function`, `setTimeout("...")` | — | No hay ninguno. Prueba estatica nueva. |

Otros controles revisados sin cambios:

- **Texto del modelo y del backend**: ideas, guia, resumen, fuentes RAG, bitacora,
  analisis de Campus, sugerencias de VS Code y mensajes de error se pintan con
  `textContent` (`fillList`, `buildOverlayIdeaItemTemplate`, `renderConnectionGrid`,
  `renderTelemetryList`, `renderTeacherRagSourceList`, etc.). No hay Markdown
  renderizado como HTML en el overlay.
- **`postMessage` del callback OAuth**: el listener de `bindGithubOAuthCallbackListener`
  solo acepta el tipo `ADACEEN_GITHUB_OAUTH_CONNECTED` desde el origen del backend
  configurado (`isTrustedAdaceenBackendOrigin`).
- **Mensajes del runtime**: sin `externally_connectable`, solo la propia extension
  puede enviar mensajes al service worker y a los content scripts.
- **Peticiones al backend**: `credentials: "omit"` (sin cookies); la identidad va en
  `x-session-id` y `x-adaceen-client-id`. El registro local de peticiones
  (`adaceenBackendRequestLog`) guarda metodo, ruta sin query y tamanos, nunca cuerpos.
- **Telemetria** (`services/telemetry.service.js`): claves fijas del esquema v1.1,
  cadenas recortadas y sin caracteres de control, `metadata` solo con primitivos.
  El texto de error (`errorText`, max. 300) solo viaja en el evento: la
  deduplicacion usa un hash FNV-1a del texto normalizado y nada se guarda en
  `chrome.storage` (el servidor lo convierte en `errorHash`).
- **CSP**: MV3 impone `script-src 'self'` a las paginas de la extension; `popup.html`
  no tiene scripts en linea.

## Riesgos aceptados o pendientes (fuera del alcance de este cambio)

| ID | Riesgo | Recomendacion |
|---|---|---|
| R1 | El overlay vive dentro de la pagina anfitriona: aunque el shadow root ya es cerrado, un script de la pagina puede observar las pulsaciones del formulario de login (eventos de teclado *composed*). Con `activeTab` el overlay puede abrirse en cualquier sitio. | Priorizar "Continuar con Google" (el token lo obtiene el service worker). Para credenciales, mover el formulario a un `iframe` de origen `chrome-extension://` (recurso accesible) o al popup. |
| R2 | El visor RAG recibia `sessionId` en la query y podia quedar en historial, capturas y logs. | **Resuelto en 0.7.8:** la ruta `/api/rag/sources/:id/view` no usa la sesion, asi que el backend ya no la agrega a `viewerUrl` y el overlay la quita de cualquier enlace al visor. |
| R3 | El formulario de acceso se precarga con la cuenta demo (`estudiante@adaceen.edu.co`) y muestra las credenciales demo. | Desactivar las cuentas demo en produccion o precargarlas solo en la variante `-dev`. |
| R4 | La ventana de OAuth de GitHub se abre sin `noopener` porque el callback usa `window.opener.postMessage`. | Aceptado: destino validado (http/https) y el listener valida el origen del mensaje. |
| R5 | La pagina de espera del Codespace se construye con `document.write` en una ventana `about:blank`. | Aceptado: todo dato dinamico se escapa. Si crece, pasar a una pagina propia de la extension (`web_accessible_resources`). |

## Prevencion de regresiones

- `tests/scripts/browser-ext-structure.test.ts`, prueba
  "sin eval, new Function ni temporizadores con codigo en texto (A12.8)": recorre el
  AST de todos los `.js` de `state/`, `overlay/`, `services/`, `popup/`,
  `background.js` y `content.js` y falla si aparece `eval(...)`, `Function(...)` /
  `new Function(...)` (tambien como `window.eval` o `globalThis["eval"]`) o
  `setTimeout`/`setInterval` con codigo en texto. Al ir sobre el AST, los comentarios y
  las cadenas no dan falsos positivos.
- La prueba "permisos minimos (A12.7)" del mismo archivo impide volver a meter hosts
  `http://` o comodines de `azurewebsites.net` en el manifest de produccion.

## Verificacion realizada (2026-09-23)

Chromium 141 headless con la extension real y un backend simulado (scripts de prueba
fuera del repo): la fuente RAG con `url: "javascript:alert(1)"` no genera enlace; la de
otro dominio con ruta `/api/rag/sources/x/view` se enlaza sin `sessionId` (desde 0.7.8
tampoco la propia); todos los enlaces tienen `rel="noopener noreferrer"`;
`document.getElementById("adaceen-overlay-host").shadowRoot` es `null` desde la pagina.
Arnes de Node con los scripts reales: `toSafeHttpUrl` rechaza `javascript:` (tambien con
espacios y mayusculas), `data:` y `vbscript:`; `resolveStoredBackendUrl` vuelve al
backend por defecto ante un valor `javascript:` guardado.

## Como verificarlo a mano

1. `npm test` (incluye las pruebas anteriores).
2. En la consola de una pagina de GitHub con el overlay abierto:
   `document.getElementById("adaceen-overlay-host").shadowRoot` devuelve `null`.
3. Con un backend de prueba que devuelva `web_url: "javascript:alert(1)"` en
   `/github/prepare-environment`, la ventana de espera se cierra sin ejecutar nada y el
   overlay muestra el error; lo mismo con `authorizeUrl`/`installUrl`.
4. Una fuente RAG con `url: "javascript:alert(1)"` no muestra el enlace
   "Abrir parte usada"; una con `https://otro-dominio/api/rag/sources/x/view` se enlaza
   sin `sessionId`.
