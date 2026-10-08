# Permisos de la extension de navegador ADACEEN

Jira: A12.7 / ADACEEN-138. Version 0.7.8 (rama `feat/cierre-pendientes-jira`); la 0.7.9 no cambia permisos.
Archivo: `browser-ext-prod/manifest.json` (es el de **produccion**; la variante de
desarrollo la genera `scripts/empaquetar-extension.mjs --dev`).

Principio: cada permiso y cada host debe corresponder a una funcion que el codigo usa
hoy. La prueba "permisos minimos (A12.7)" de `tests/scripts/browser-ext-structure.test.ts`
falla si aparece un permiso nuevo, un host `http://` o un comodin de
`azurewebsites.net` en el manifest de produccion; si hace falta uno nuevo, se justifica
aqui y se actualiza la prueba.

## Cambios en 0.7.8

| Antes | Ahora | Motivo |
|---|---|---|
| `http://127.0.0.1:3000/*`, `http://localhost:3000/*` | Solo en la variante `-dev` | El backend local es de desarrollo; produccion no necesita hablar con `localhost`. |
| `https://*.azurewebsites.net/*` | `https://app-adaceen-api-eyder05232002.azurewebsites.net/*` | El comodin daba acceso a **cualquier** aplicacion de Azure App Service. El codigo solo usa el backend de produccion (`DEFAULT_BACKEND_URL` en `state/session.state.js`). |
| `https://app-agente-poc.azurewebsites.net/*` | (eliminado) | Backend de la prueba de concepto; ningun archivo lo usa. |
| permiso `tabs` | (eliminado) | Solo sirve para leer `url`/`title` de pestanas arbitrarias (aviso "Leer tu historial de navegacion"). El codigo usa `tabs.sendMessage`, `tabs.captureVisibleTab` y el `tab.id` de `action.onClicked`, que no lo requieren. El popup (no esta conectado como `default_popup`) lee `tab.url` con `tabs.query`; en los sitios del piloto esa URL sigue disponible por los `host_permissions`. |

## Permisos de API

| Permiso | Para que se usa | Donde |
|---|---|---|
| `activeTab` | Al pulsar el icono de ADACEEN, acceso temporal a la pestana actual: inyectar el overlay en paginas fuera de la lista de `content_scripts` y capturar la pantalla visible para el "OCR visual" en Codespaces (`tabs.captureVisibleTab` exige `activeTab` o `<all_urls>`; se prefiere `activeTab`). | `background.js`: `ensureContentScript`, `ADACEEN_CAPTURE_VISIBLE_TAB`. |
| `storage` | Preferencias (backend, meta de aprendizaje, curso RAG), sesion y su copia compartida entre pestanas, estado por pestana, id anonimo del navegador (`adaceenClientId`) y registro local de peticiones (sin cuerpos). | `state/preferences.state.js`, `services/auth.service.js`, `services/telemetry.service.js`, `overlay/content-lifecycle.js`. |
| `scripting` | `chrome.scripting.executeScript` desde el service worker para inyectar los content scripts en pestanas abiertas antes de instalar o actualizar la extension. | `background.js` (`CONTENT_SCRIPT_FILES`). |
| `identity` | `chrome.identity.getAuthToken` para "Continuar con Google" y para autorizar Google Calendar. | `background.js` (`getGoogleAuthToken`). |

## Alcances OAuth de Google (`oauth2.scopes`)

| Alcance | Para que | Cuando se pide |
|---|---|---|
| `userinfo.email` | Identificar al usuario en `POST /api/auth/google-login`. | Al pulsar "Continuar con Google". |
| `userinfo.profile` | Nombre visible del usuario en el overlay. | Igual. |
| `calendar.events` | **Se mantiene.** El estudiante agenda en su Google Calendar las actividades que publica el profesor (bitacora y actividades con fecha de Campus): "Sincronizar agenda" crea los eventos con `POST https://www.googleapis.com/calendar/v3/calendars/primary/events` desde el service worker (`createGoogleCalendarEvent`). Desde la 0.7.17 la pestana «Agenda» del estudiante (solo con sesion del correo `@correounivalle.edu.co`) ademas **lee** los eventos del calendario principal (`GET .../events` con `fields` limitado a id, titulo, inicio, fin, estado, transparencia, enlace y la propiedad privada de ADACEEN) para no repetir evaluaciones que ya estan y para proponer bloques de estudio en horas libres, y **mueve** de dia sus propios eventos cuando el docente corre la bitacora (`PATCH .../events/{id}`). Lo leido se usa en el navegador y no se manda al backend. Es el alcance que permite esto sin dar acceso a la configuracion ni a todos los calendarios (`calendar`). | Solo al pulsar «Sincronizar con Google Calendar», «Sugerir bloques de estudio» o «Agregar los marcados a Google Calendar» (y "Sincronizar agenda" en Campus): autorizacion incremental, el login pide `GOOGLE_PROFILE_SCOPES` y Calendar pide `GOOGLE_CALENDAR_SCOPES` en ese momento. |
| `userinfo.email` (con Calendar) | Desde la 0.7.17, antes de tocar el calendario se lee el correo de la cuenta que autorizo Calendar (`GET https://www.googleapis.com/oauth2/v3/userinfo`) y solo se sigue si es el de la sesion de ADACEEN, para no llenar el calendario de otra cuenta abierta en Chrome. | Con cada accion de la pestana «Agenda». |

Pendiente de evaluar (no se cambia en esta version): Google ofrece alcances mas
estrechos como `calendar.events.owned` o `calendar.app.created` (eventos solo en un
calendario secundario creado por la app). Cambiarlo implica volver a configurar el
cliente OAuth y la pantalla de consentimiento.

## Hosts (`host_permissions`)

| Host | Para que |
|---|---|
| `https://campusvirtual.univalle.edu.co/*` | Overlay en Campus Virtual: actividades, fechas, bitacora y descarga de documentos del curso para clasificarlos. |
| `https://www.googleapis.com/*` | El service worker llama a la API de Google Calendar con el token de `chrome.identity`. |
| `https://github.com/*` | Overlay en GitHub: repositorio, archivo, rama y PR; flujo de Codespaces y GitHub App. |
| `https://github.dev/*`, `https://*.github.dev/*`, `https://app.github.dev/*`, `https://*.app.github.dev/*` | Editor de Codespaces (`github.dev` y `<nombre>.github.dev`). `*.github.dev` ya cubre las otras tres; se dejan explicitas por legibilidad y no amplian el acceso. |
| `https://vscode.dev/*`, `https://insiders.vscode.dev/*` | Editor por tunel de VS Code (`vscode.dev/tunnel/<nombre>`), el plan B a Codespaces. |
| `https://app-adaceen-api-eyder05232002.azurewebsites.net/*` | Backend ADACEEN de produccion. En Chrome los `fetch` de los content scripts salen con el origen de la pagina y dependen del CORS del backend (`ALLOWED_ORIGINS`); el permiso se conserva para las paginas propias de la extension (popup) y por compatibilidad con Firefox. |

`content_scripts.matches` usa los mismos sitios del piloto (sin `googleapis` ni el
backend). `web_accessible_resources` expone solo las dos imagenes de fondo de la
ventana de espera del Codespace y solo a esos sitios.

`key` fija el id de la extension en Chrome; el cliente OAuth de `chrome.identity`
depende de ese id (Firefox lo ignora).

## Variante de desarrollo

```bash
node scripts/empaquetar-extension.mjs --dev
```

Genera `dist/extension/adaceen-chromium-<version>-dev.zip` y
`adaceen-firefox-<version>-dev.zip`, identicos a los de produccion salvo:

- `host_permissions` + `http://127.0.0.1:3000/*` y `http://localhost:3000/*`;
- `version_name` termina en `(dev)`.

Para Chrome, descomprimir el zip y usar "Cargar descomprimida"; en Firefox,
`about:debugging` -> "Cargar complemento temporal" y elegir el zip o su `manifest.json`.
Con el backend local hay que poner `http://127.0.0.1:3000` en Configuracion -> Base URL.

## Notas para Firefox

- El paquete de Firefox agrega `browser_specific_settings.gecko.id =
  "adaceen@univalle.edu.co"`, `strict_min_version: "128.0"` y `background.scripts`
  ademas de `service_worker` (Firefox no ejecuta service workers de extension; Chrome
  ignora `scripts` cuando hay `service_worker`).
- Firefox no implementa `identity.getAuthToken`: `background.js` usa
  `identity.launchWebAuthFlow` con el flujo implicito de Google y un cliente OAuth de
  tipo "Aplicacion web" que el empaquetador pone en el manifest de Firefox como
  `adaceenGoogleWebClientId` (variable `GOOGLE_WEB_CLIENT_ID`). La URI de redireccion es
  `https://<sha1 del id gecko>.extensions.allizom.org/` y el backend acepta ese cliente
  por `GOOGLE_CLIENT_IDS` (docs/operacion/google-oauth-firefox.md). El token queda en
  `chrome.storage.local` con su vencimiento y se borra al salir. Sin el cliente web el
  overlay muestra "Inicio de sesion con Google no configurado en este paquete de la
  extension."; el login con credenciales siempre funciona.
- `key` y `oauth2` son claves de Chrome; Firefox las ignora con un aviso (igual que
  `adaceenGoogleWebClientId`, que solo lee `background.js` con `runtime.getManifest()`).
- En Firefox los permisos de host de MV3 los puede revocar el usuario desde
  `about:addons`.
- Para publicar en AMO hay que declarar la recoleccion de datos
  (`browser_specific_settings.gecko.data_collection_permissions`); es una decision del
  proyecto (datos del sitio, actividad, telemetria) y no se agrego en este cambio.
