# Google en Firefox: cliente OAuth web para «Continuar con Google» y Google Calendar

| | |
|---|---|
| Para qué | Que la extensión en Firefox tenga «Continuar con Google» y la sincronización con Google Calendar, que en Chrome salen de `chrome.identity.getAuthToken` (Firefox no la implementa). |
| Quién | El dueño del proyecto (Google Cloud Console y variables del App Service) y el docente que genera el paquete de Firefox. |
| Dónde | Google Cloud Console (proyecto `adaceen`), Cloud Shell o Azure Cloud Shell para las variables, PowerShell en el clon del repo para empaquetar. |
| Código | `browser-ext-prod/background.js` (`getGoogleWebAuthToken`), `scripts/empaquetar-extension.mjs` (`GOOGLE_WEB_CLIENT_ID`), `src/services/google-auth.ts` (`GOOGLE_CLIENT_IDS`). |

## 1. Cómo funciona

- Firefox no tiene `chrome.identity.getAuthToken`, pero sí `chrome.identity.launchWebAuthFlow`
  y `chrome.identity.getRedirectURL`. Con ellas `background.js` hace el flujo implícito de
  Google (`https://accounts.google.com/o/oauth2/v2/auth?response_type=token&...`): abre una
  ventana de Google, el estudiante elige la cuenta y Google vuelve a la URL de redirección de la
  extensión con `#access_token=...&expires_in=...`.
- El backend verifica ese `access_token` igual que el de Chrome (`tokeninfo` + `userinfo`,
  `POST /api/auth/google-login`). Lo único nuevo es la **audiencia** del token: el cliente OAuth
  con el que se pidió. Por eso el backend acepta, además de `GOOGLE_CLIENT_ID` (cliente «Chrome
  Extension»), la lista `GOOGLE_CLIENT_IDS`.
- El cliente de Firefox tiene que ser de tipo **«Aplicación web»**: el de Chrome no admite la URI
  de redirección de Firefox (`redirect_uri_mismatch`). El empaquetador lo pone en el manifest del
  zip de Firefox como `adaceenGoogleWebClientId`; el zip de Chromium no cambia.
- El token se guarda en `chrome.storage.local` (`adaceen.googleWebToken`) con su vencimiento y
  los permisos concedidos; «Salir» lo borra. Un token vencido no se entrega: la siguiente acción
  vuelve a abrir la ventana de Google (el flujo implícito no renueva en silencio; el token dura
  una hora). Calendar pide `calendar.events` además del perfil: la primera sincronización abre
  otra ventana con ese permiso y el token resultante sirve también para el login
  (`include_granted_scopes=true`).
- Cada inicio de sesión abre el selector de cuentas de Google (`prompt=select_account`): en un
  equipo compartido el estudiante elige la suya. La agenda del curso sigue exigiendo que la cuenta
  de Google sea la del correo de la sesión (`…@correounivalle.edu.co`), como en Chrome.
- Si el paquete de Firefox se generó sin el cliente web, el overlay muestra «Inicio de sesion con
  Google no configurado en este paquete de la extension.» y se entra con correo y contraseña, como
  hasta la 0.7.20.

## 2. URI de redirección de Firefox

Firefox construye la URI de redirección a partir del id del complemento:
`https://<hash>.extensions.allizom.org/`, donde `<hash>` es el SHA-1 (hexadecimal) del id. El
paquete de Firefox fija el id en el manifest (`browser_specific_settings.gecko.id =
adaceen@univalle.edu.co`), también cuando se carga como complemento temporal, así que la URI es
siempre la misma:

```text
https://c9877db3762dafe589f3da2d95a4276b8e397dcf.extensions.allizom.org/
```

Para recalcularla:

```bash
node -e "console.log('https://' + require('crypto').createHash('sha1').update('adaceen@univalle.edu.co').digest('hex') + '.extensions.allizom.org/')"
```

Confirmarla una vez en un Firefox real, con el complemento cargado: `about:debugging` → «Este
Firefox» → ADACEEN → «Inspeccionar» → consola → `browser.identity.getRedirectURL()`. Si lo que
muestra la consola no coincide con la URI de arriba, registrar en Google la que muestra la
consola (y anotarlo aquí).

## 3. Google Cloud Console (una vez)

En el proyecto `adaceen` (el mismo del cliente de Chrome; la pantalla de consentimiento y los
permisos `userinfo.email`, `userinfo.profile` y `calendar.events` ya están):

1. «Google Auth Platform» → «Clients» → «Create client».
2. Tipo de aplicación: **Web application** («Aplicación web»). Nombre: `ADACEEN Firefox`.
3. «Authorized redirect URIs» → «Add URI» → la URI de la sección 2. No hace falta ningún
   «Authorized JavaScript origin».
4. «Create» y copiar el **Client ID** (termina en `.apps.googleusercontent.com`). Google también
   genera un *client secret*: el flujo implícito no lo usa; no copiarlo al repo ni al paquete.
5. Si la app sigue en modo «Testing» en la pantalla de consentimiento, las cuentas que entren
   desde Firefox tienen que estar en «Test users», igual que con Chrome.

## 4. Backend: aceptar el cliente web

Variable nueva del App Service (sección 1 de [despliegue](despliegue.md), con `--output none`):

```bash
az webapp config appsettings set -g $RG -n $APP --output none --settings GOOGLE_CLIENT_IDS="<client id web>"
az webapp restart -g $RG -n $APP
```

- `GOOGLE_CLIENT_IDS`: lista separada por comas de client_id aceptados como audiencia del token
  además de `GOOGLE_CLIENT_ID`. `GOOGLE_CLIENT_ID` no cambia (Chrome sigue con él).
- En local, lo mismo en `.env` (`.env.example` tiene las dos líneas).
- Comprobación: con un token de Firefox el backend responde la sesión; sin la variable responde
  `400` con «El token de Google no corresponde al cliente OAuth configurado.» (ese texto llega al
  overlay). `GET /api/health` no cambia (`google_auth_configured` sigue dependiendo de
  `GOOGLE_CLIENT_ID`).

## 5. Empaquetar el zip de Firefox con el cliente web

El empaquetador lee `GOOGLE_WEB_CLIENT_ID` del entorno o, si no está, de la línea
`GOOGLE_WEB_CLIENT_ID=...` del `.env` del repo (no se commitea):

```powershell
$env:GOOGLE_WEB_CLIENT_ID = "<client id web>"
npm run empaquetar:extension
```

```bash
GOOGLE_WEB_CLIENT_ID="<client id web>" npm run empaquetar:extension
```

La salida lo dice en la línea del paquete de Firefox: `Google por cliente web` (con la
variable) o `sin Google` (sin ella, con un aviso al inicio). El script se niega a empaquetar si el
valor no parece un client_id de Google o si es el cliente de Chrome del manifest
(`oauth2.client_id`). Para comprobar el zip:

```bash
unzip -p dist/extension/adaceen-firefox-<versión>.zip manifest.json | grep adaceenGoogleWebClientId
```

El zip de Chromium es idéntico con o sin la variable. El flujo de GitHub Actions publica solo el
zip de Chromium en `/empezar`; el de Firefox lo genera y reparte el docente, así que la variable
va en su equipo (o en `.env`), no en los secretos del flujo.

## 6. Probar en Firefox

1. Cargar `adaceen-firefox-<versión>.zip` desde `about:debugging` ([guía](../guia-instalacion-uso.md), 1.1).
   Firefox avisa de claves desconocidas del manifest (`key`, `oauth2`, `adaceenGoogleWebClientId`):
   es normal.
2. Abrir un sitio del piloto, pulsar el icono y «Continuar con Google»: se abre la ventana de
   Google, se elige la cuenta institucional y el overlay queda con la sesión.
3. «Agenda» → «Sincronizar con Google Calendar»: segunda ventana con el permiso de Calendar y
   después los eventos en el calendario.
4. «Salir» y volver a entrar: vuelve a pedir la cuenta (el token guardado se borró).
5. Anotar el resultado en la [lista E2E](../pruebas/plan-de-pruebas.md) (columna Firefox).

## 7. Problemas

| Lo que se ve | Causa | Qué hacer |
|---|---|---|
| Página de Google «Error 400: redirect_uri_mismatch» | La URI de redirección no está registrada en el cliente web, o el id del complemento es otro. | Sección 2 (confirmar con `browser.identity.getRedirectURL()`) y sección 3. |
| Página de Google «Error 401: invalid_client» o «deleted_client» | `GOOGLE_WEB_CLIENT_ID` mal copiado o cliente borrado. | Volver a copiar el Client ID y empaquetar de nuevo. |
| «El token de Google no corresponde al cliente OAuth configurado.» | El backend no tiene el cliente web en `GOOGLE_CLIENT_IDS`. | Sección 4. |
| «Inicio de sesion con Google no configurado en este paquete de la extension.» | El zip de Firefox se generó sin `GOOGLE_WEB_CLIENT_ID`. | Sección 5 y repartir el zip nuevo. |
| «Chrome Identity API no disponible.» | Navegador sin `chrome.identity` (ni `getAuthToken` ni `launchWebAuthFlow`). | Entrar con correo y contraseña. |
| «User cancelled or denied access.» | El estudiante cerró la ventana de Google. | Repetir. |
| «Google no autorizo el acceso (access_denied).» | El estudiante negó el permiso, o la cuenta no está en «Test users» con la app en modo Testing. | Sección 3, paso 5. |
| Vuelve a pedir la cuenta cada hora | Esperado: el flujo implícito no renueva en silencio. | — |
