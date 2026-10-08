# Publicar la extensión de navegador: Chrome Web Store, Firefox (AMO) y política de equipos

Cómo dejar de pedir «Modo de desarrollador» + «Cargar descomprimida» (el paso más largo del indicador T10, instalación en 15 minutos) y cómo hacer permanente la instalación en Firefox. Son tres canales independientes; `/empezar` ofrece cada uno solo cuando existe lo que necesita, y el zip con los 4 pasos y la carga temporal de Firefox siguen como alternativa. Esta página es para quien administra el piloto; la de estudiantes es `docs/guia-instalacion-uso.md` (1.1).

| Canal | Qué resuelve | Qué hace falta | Quién |
|---|---|---|---|
| 1. Chrome Web Store, visibilidad «No listada» | Un enlace; Chrome y Edge instalan y actualizan solos | Cuenta de desarrollador (5 USD, una vez) y pasar la revisión de Google | Dueño del proyecto |
| 2. XPI firmado por addons.mozilla.org (AMO) | «Instalar en Firefox» con un clic, permanente | Cuenta en AMO con credenciales de API; firmar cada versión | Dueño del proyecto |
| 3. CRX firmado + política `ExtensionInstallForcelist` | En los equipos del laboratorio se instala sola | Clave RSA propia (secreto del flujo) y que Sistemas aplique la política | Dueño y Sistemas |

Los textos entre comillas de la consola de Chrome, de AMO, de Chrome o de Firefox son traducciones orientativas (por verificar al hacerlo); los de ADACEEN son los de `/empezar`.

## 0. El id de la extensión y las claves

- `browser-ext-prod/manifest.json` trae el campo `key` (una clave pública). Por eso la extensión tiene siempre el mismo id al cargar la carpeta o el zip: **`gkkcnlcbdjdjcibkkbhpopichconbojg`** (SHA-256 de la clave, primeros 16 bytes, cada dígito hexadecimal como letra de la `a` a la `p`). Ese id está registrado en el cliente OAuth de Google del manifest (`oauth2.client_id`): «Continuar con Google» y Google Calendar solo funcionan con ese id.
- Cada canal fija el id de otra forma:
  - Chrome Web Store: la tienda genera su propia clave, así que el id de la tienda **será otro**; hay que registrarlo en el cliente OAuth (1.7).
  - CRX propio: el id sale de la clave con que se firma. Con la clave privada que generó el `key` del manifest (si se conserva) el id sigue siendo `gkkc…`; con una clave nueva cambia, y `scripts/empaquetar-crx.mjs` lo avisa.
  - Firefox: el id es `adaceen@univalle.edu.co` (`browser_specific_settings.gecko.id`), independiente de lo anterior.
- Las claves privadas no van al repositorio: el `.pem` fuera del repo (con respaldo) y, para el flujo, como secreto de GitHub.

## 1. Chrome Web Store (no listada)

### 1.1 Cuenta de desarrollador

1. Entra en `https://chrome.google.com/webstore/devconsole` con la cuenta de Google que será dueña del ítem. Mejor una cuenta institucional del proyecto que una personal: la cuenta que paga el registro queda como administradora (después se puede pasar a un «editor de grupo»).
2. Acepta el acuerdo de desarrollador y paga el registro: 5 USD, un único pago por cuenta, con tarjeta.
3. Activa la verificación en dos pasos de esa cuenta de Google: la consola la exige para publicar.
4. En «Cuenta», escribe el correo de contacto y verifícalo (sin esto no deja enviar a revisión).

### 1.2 Preparar el paquete

```bash
npm run empaquetar:extension
```

Se sube `dist/extension/adaceen-chromium-<versión>.zip`, el mismo zip que publica `/empezar`. Reglas:

- la `version` del manifest tiene que subir en cada envío: la tienda no acepta repetir una versión;
- si la consola rechaza el zip por el campo `key` del manifest, quítalo de una copia del zip para la tienda, no del repositorio (la tienda usa su propia clave de todas formas);
- `name` y `description` van tal como están; el icono de 128 px ya está en el paquete.

### 1.3 Crear el ítem y la ficha

Consola → «Nuevo elemento» → subir el zip. En la pestaña de la ficha («Store listing»):

- Título «ADACEEN»; resumen (máximo 132 caracteres) y descripción: para qué sirve (tutor contextual del curso de programación: pistas graduales sin resolver el ejercicio), quién la usa (estudiantes del piloto de la Universidad del Valle) y dónde actúa (Campus Virtual, GitHub, github.dev y vscode.dev, el backend de ADACEEN).
- Categoría «Educación»; idioma «español».
- Al menos una captura de 1280×800 (o 640×400): el overlay sobre un repositorio de GitHub y otra sobre Campus Virtual. Icono de la tienda: el `icon-128.png` del paquete.
- Sitio web y soporte: `https://app-adaceen-api-eyder05232002.azurewebsites.net/empezar`.

### 1.4 Prácticas de privacidad (pestaña «Privacidad»)

Google revisa esta pestaña a mano; si está incompleta o vaga, la revisión se alarga o se rechaza. Qué poner:

- **Finalidad única:** «Tutor contextual del curso de programación: lee la página o el código que el estudiante está viendo en Campus Virtual, GitHub o el editor en la nube y muestra pistas graduales definidas por el docente, sin resolver el ejercicio.»
- **Justificación de permisos** (los de `browser-ext-prod/manifest.json`):

| Permiso | Justificación |
|---|---|
| `identity` | Inicio de sesión con la cuenta institucional de Google (`chrome.identity.getAuthToken`) y, si el estudiante lo pide, guardar las fechas del curso en su Google Calendar. |
| `storage` | Guardar en el navegador la sesión de ADACEEN, las preferencias del overlay y el estado de la pestaña. |
| `scripting` | Inyectar el overlay cuando el estudiante pulsa el icono en una pestaña de los sitios del piloto; en otros sitios no se inyecta nada. |
| `activeTab` | Leer la pestaña activa solo cuando el estudiante pulsa el icono de ADACEEN. |
| Host `campusvirtual.univalle.edu.co` | Leer el curso, la bitácora y las fechas de Campus Virtual para el tutor y la agenda. |
| Hosts `github.com`, `github.dev`, `*.github.dev`, `app.github.dev`, `*.app.github.dev` | Detectar el repositorio y leer el código del ejercicio en GitHub, github.dev y Codespaces; preparar el editor y autorizar el túnel. |
| Hosts `vscode.dev`, `insiders.vscode.dev` | Mostrar el overlay sobre el editor en la nube del estudiante. |
| Host `www.googleapis.com` | Perfil de la cuenta de Google y Google Calendar (crear eventos). |
| Host `app-adaceen-api-eyder05232002.azurewebsites.net` | El backend de ADACEEN: sesión, política del docente, sugerencias del tutor, telemetría del piloto y la página `/empezar`. |
| Código remoto | «No»: todo el código va en el paquete (los content scripts son los del manifest). |

- **Uso de datos** (casillas): información de identificación personal (nombre y correo de la cuenta), información de autenticación (sesión de ADACEEN y de GitHub), contenido del sitio web (código y texto de la página que analiza el tutor) y actividad del usuario (telemetría del piloto: uso del tutor, pistas aceptadas). Marca las tres certificaciones: no se venden, no se usan para fines ajenos a la finalidad, no se usan para evaluar solvencia ni crédito.
- **Política de privacidad:** `https://app-adaceen-api-eyder05232002.azurewebsites.net/privacy-policy` (la sirve el backend, `src/routes/privacy-policy-routes.ts`).

### 1.5 Distribución

Pestaña «Distribución»: visibilidad **«No listada»** (solo llega quien tiene el enlace; no aparece en búsquedas de la tienda), gratuita, todas las regiones (o solo Colombia). Sin publicación programada.

### 1.6 Enviar a revisión y tiempos

«Enviar para revisión», con la publicación automática al aprobarse. Tiempos orientativos (Google no los garantiza): la mayoría de los envíos se resuelven en 1 a 3 días; una extensión con permisos amplios de host como esta puede tardar hasta 2 o 3 semanas la primera vez, y las actualizaciones suelen ser más rápidas. Mientras está en revisión no se puede subir otra versión. Si la rechazan, el correo dice el motivo (casi siempre la justificación de permisos o la política de privacidad): se corrige la ficha y se reenvía. Planifica el primer envío al menos un mes antes del piloto.

### 1.7 Después de publicar

1. La página del ítem es `https://chromewebstore.google.com/detail/<id-de-la-tienda>`. Ponla en el App Service como `CHROME_WEB_STORE_URL` (sección 1 del anexo de `docs/operacion/despliegue.md`). Con eso `/empezar` muestra «Instalar desde Chrome Web Store» antes de «Descargar la extension» y los 4 pasos del zip quedan como alternativa.
2. Registra el id de la tienda en el cliente OAuth de Google (Google Cloud → Credenciales → el cliente «Extensión de Chrome» del `oauth2.client_id` → «ID del elemento»). Si no, en la versión de la tienda «Continuar con Google» falla (entrar con correo y contraseña sigue funcionando). Para que la carpeta y el zip tengan el mismo id que la tienda, copia la clave pública que muestra la consola (pestaña «Paquete» → «Ver clave pública») al campo `key` del manifest: decisión del dueño, porque cambia el id actual `gkkc…`.
3. Cada versión nueva: `npm run empaquetar:extension`, subir el zip en la consola y «Enviar para revisión». El flujo de Azure no sube nada a la tienda.
4. Política con la tienda (equipos gestionados): con el id de la tienda ya no hace falta el CRX propio: el valor de `ExtensionInstallForcelist` es `<id-de-la-tienda>;https://clients2.google.com/service/update2/crx` (3.4), y Chrome lo acepta también en Windows sin dominio.

## 2. Firefox permanente: XPI firmado por AMO

Firefox solo instala de forma permanente complementos firmados por Mozilla. La firma no se puede automatizar sin credenciales de addons.mozilla.org, que son personales; por eso el flujo firma solo si se le dan esos secretos (opción B) y, si no, publica el XPI que se guarde en el repositorio (opción A).

### 2.1 Cuenta y credenciales de AMO

1. Crea una cuenta en `https://addons.mozilla.org` (cuenta de Mozilla) con el correo del proyecto y activa la verificación en dos pasos, obligatoria para desarrolladores.
2. En `https://addons.mozilla.org/developers/addon/api/key/` genera las credenciales de la API: «JWT issuer» (`user:…:…`) y «JWT secret». Guárdalas fuera del repositorio; el secreto se muestra una sola vez.

### 2.2 Lo que el manifest de Firefox ya trae

`npm run empaquetar:extension` genera `dist/extension/adaceen-firefox-<versión>.zip` con `browser_specific_settings.gecko`: id `adaceen@univalle.edu.co`, `strict_min_version` 128.0 y `data_collection_permissions`, obligatorio para firmar envíos nuevos desde noviembre de 2025: `required` = `personalInfo`, `authenticationInfo`, `websiteContent`, `websiteActivity`. Firefox lo muestra al instalar y en `about:addons`. Si cambia lo que la extensión envía, ajusta `FIREFOX_DATOS_RECOGIDOS` en `scripts/empaquetar-extension.mjs`; una categoría declarada no se puede quitar en versiones posteriores sin revisión. `technicalAndInteraction` solo puede ser opcional y Firefox mostraría una casilla que la extensión no lee, por eso no se declara.

### 2.3 Firmar a mano (una vez por versión)

AMO firma cada versión una sola vez: para volver a firmar hay que subir la `version` del manifest. `web-ext` no se agrega a `package.json`; se usa con `npx`:

```bash
npm run empaquetar:extension
rm -rf /tmp/adaceen-firefox && mkdir -p /tmp/adaceen-firefox/fuente /tmp/adaceen-firefox/firmado
unzip -q dist/extension/adaceen-firefox-<versión>.zip -d /tmp/adaceen-firefox/fuente
npx --yes web-ext@8 sign \
  --source-dir /tmp/adaceen-firefox/fuente \
  --artifacts-dir /tmp/adaceen-firefox/firmado \
  --channel unlisted \
  --api-key "<JWT issuer>" --api-secret "<JWT secret>"
```

En PowerShell, `Expand-Archive` en vez de `unzip`. `--channel unlisted`: el complemento no aparece en addons.mozilla.org, solo se firma; la primera vez crea el complemento en la cuenta con ese id. La validación es automática (minutos) y `web-ext` descarga el XPI firmado en `--artifacts-dir` (`adaceen-<versión>.xpi`). Errores típicos: «Version already exists» (esa versión ya se firmó: descarga el XPI desde la cuenta de AMO, «Administrar» → versiones, o sube la versión del manifest) y errores de validación del manifest (el mensaje dice cuál; las claves de Chrome como `oauth2` o `key` solo dan avisos).

### 2.4 Publicar el XPI en /empezar

El job `build` del flujo copia el XPI a `deploy-package/descargas/adaceen.xpi`, en este orden:

- **Opción A (recomendada, sin credenciales en el flujo):** guarda el XPI firmado como `deploy/extension/adaceen-firefox-<versión>.xpi` y haz commit (unos 2,8 MB por versión; borra el de la versión anterior). El flujo lo copia solo si la versión coincide con la del manifest, así una versión nueva sin firmar no publica un XPI viejo. No sirve como secreto de GitHub: el límite es 48 KB.
- **Opción B:** secretos `AMO_JWT_ISSUER` y `AMO_JWT_SECRET` en el repositorio (Settings → Secrets and variables → Actions). El flujo descomprime el zip de Firefox y corre `npx --yes web-ext@8 sign --channel unlisted` con ellos. Como AMO firma cada versión una sola vez, el siguiente despliegue de la misma versión no la firma (aviso en el flujo) y `/empezar` vuelve a la carga temporal: tras el primer despliegue firmado, descarga `/descargas/adaceen.xpi` y guárdalo como en la opción A.
- Sin A ni B: `::notice` en el flujo y `/empezar` muestra la carga temporal.

### 2.5 Cómo queda /empezar

Con el XPI publicado, bajo «Firefox» aparece «Instalar en Firefox»: enlace directo a `/descargas/adaceen.xpi`, servido como `application/x-xpinstall` y sin atributo `download`, que es lo que hace que Firefox instale en vez de guardar. Firefox avisa que el sitio quiere instalar un complemento: «Permitir» y luego «Agregar». La instalación es permanente y Firefox busca actualizaciones en AMO. En Firefox sigue sin haber inicio de sesión con Google (`chrome.identity.getAuthToken`); se entra con correo y contraseña.

## 3. Instalación por política: CRX firmado + manifiesto de actualización

Para los equipos del laboratorio que administra Sistemas: Chrome y Edge instalan la extensión sin que el estudiante haga nada, desde un CRX firmado con la clave del proyecto y publicado en el backend. **La política la aplica Sistemas** (Windows por GPO o registro, Linux por archivo); el proyecto entrega el id, la URL del manifiesto y el JSON de esta sección.

### 3.1 La clave (una sola vez)

```bash
openssl genrsa -out adaceen-crx.pem 2048
```

Guárdala fuera del repositorio y con respaldo: el id de la extensión depende de ella, y perderla obliga a cambiar la política en todos los equipos. Si se conserva la clave privada que generó el `key` del manifest, úsala: el CRX tendrá el id `gkkc…` y «Continuar con Google» seguirá funcionando en esos equipos. Con una clave nueva el id cambia (el script lo imprime y avisa) y quedan dos opciones: registrar ese id en el cliente OAuth de Google (como en 1.7) o aceptar que en esos equipos se entre con correo y contraseña. Reemplazar el `key` del manifest por la clave pública de `adaceen-crx.pem` unifica los ids (carpeta, zip y CRX) pero cambia el id actual: decisión del dueño.

### 3.2 Generar el CRX

```bash
npm run empaquetar:extension
CRX_PRIVATE_KEY_PEM_FILE=adaceen-crx.pem npm run empaquetar:crx
```

`scripts/empaquetar-crx.mjs` (Node puro, sin dependencias) envuelve `dist/extension/adaceen-chromium-<versión>.zip` en un CRX3 (cabecera `Cr24`, `CrxFileHeader` en protobuf, firma RSA PKCS#1 v1.5 con SHA-256), lo vuelve a leer para verificar cabecera, `crx_id` y firma, y escribe `dist/extension/adaceen-<versión>.crx` y `dist/extension/adaceen-update.xml`:

```xml
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='<id>'>
    <updatecheck codebase='https://app-adaceen-api-eyder05232002.azurewebsites.net/descargas/adaceen.crx' version='<versión>'/>
  </app>
</gupdate>
```

Imprime el id, el valor de `ExtensionInstallForcelist` y la huella de la clave. Sin clave sale con código 2 y no toca los zip ni `SHA256SUMS.txt`. `CRX_CODEBASE_URL` cambia la URL del `.crx` del manifiesto (otro servidor). En PowerShell: `$env:CRX_PRIVATE_KEY_PEM_FILE = "adaceen-crx.pem"; npm run empaquetar:crx`.

### 3.3 En el flujo de Azure

- Secreto `CRX_PRIVATE_KEY_PEM`: el contenido completo de `adaceen-crx.pem`, con las líneas `BEGIN`/`END`. Variable opcional `CRX_CODEBASE_URL`.
- El job `build` corre el script y copia `adaceen.crx` y `adaceen-update.xml` a `deploy-package/descargas/`; sin secreto, `::notice` y sigue.
- El backend los sirve en `/descargas/adaceen.crx` (`application/x-chrome-extension`) y `/descargas/adaceen-update.xml` (`application/xml`), y `/empezar` muestra la nota «Instalacion por politica (equipos del laboratorio)» con el id, la URL del manifiesto y el valor de la política, para copiarlo.
- Actualizar: subir la `version` del manifest y desplegar. Chrome consulta el manifiesto cada pocas horas y actualiza solo (o `chrome://extensions` → «Actualizar»).

### 3.4 La política (la aplica Sistemas)

Valor, con el id que imprime el script y muestra `/empezar`:

```text
<id>;https://app-adaceen-api-eyder05232002.azurewebsites.net/descargas/adaceen-update.xml
```

- **Windows con GPO:** plantillas ADMX de Chrome (y de Edge). Configuración del equipo → Plantillas administrativas → Google → Google Chrome → Extensiones → «Configurar la lista de aplicaciones y extensiones de instalación forzosa» (`ExtensionInstallForcelist`): habilitar y agregar el valor. Opcional: «Configurar fuentes de instalación de extensiones, aplicaciones y secuencias de comandos de usuario» (`ExtensionInstallSources`) con `https://app-adaceen-api-eyder05232002.azurewebsites.net/*`, para que además el clic en `adaceen.crx` de `/empezar` instale sin modo de desarrollador. Edge: lo mismo bajo Microsoft Edge → Extensiones.
- **Windows con el registro (sin GPO):** archivo `.reg` ejecutado como administrador:

```text
Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist]
"1"="<id>;https://app-adaceen-api-eyder05232002.azurewebsites.net/descargas/adaceen-update.xml"

[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\ExtensionInstallSources]
"1"="https://app-adaceen-api-eyder05232002.azurewebsites.net/*"
```

  Edge: las mismas claves bajo `HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Microsoft\Edge\`.
- **Linux:** `/etc/opt/chrome/policies/managed/adaceen.json` (Chromium: `/etc/chromium/policies/managed/`), propietario root y permisos 644:

```json
{
  "ExtensionInstallForcelist": [
    "<id>;https://app-adaceen-api-eyder05232002.azurewebsites.net/descargas/adaceen-update.xml"
  ],
  "ExtensionInstallSources": [
    "https://app-adaceen-api-eyder05232002.azurewebsites.net/*"
  ]
}
```

- **macOS:** perfil de configuración (MDM) con la clave `ExtensionInstallForcelist` del dominio `com.google.Chrome`, o `defaults write com.google.Chrome ExtensionInstallForcelist -array "<id>;https://app-adaceen-api-eyder05232002.azurewebsites.net/descargas/adaceen-update.xml"`.

Avisos:

- **Windows sin dominio:** Chrome solo acepta en `ExtensionInstallForcelist` extensiones fuera de la Chrome Web Store en equipos unidos a un dominio de Active Directory o inscritos en una gestión (Chrome Browser Cloud Management, Intune). En equipos sueltos la entrada se ignora sin error visible: ahí la salida es la tienda (1.7, punto 4) o el zip.
- Comprobar en un equipo: `chrome://policy` → «Volver a cargar políticas» debe listar `ExtensionInstallForcelist` sin error, y `chrome://extensions` muestra ADACEEN como instalada por el administrador (el estudiante no puede quitarla). Si el manifiesto no carga, `chrome://policy` lo marca: revisa que `/descargas/adaceen-update.xml` responda 200 por https y que el `.crx` sea de la misma versión.
- Si `/empezar` no muestra la nota de política, el despliegue no incluyó el CRX (secreto ausente o aviso en el flujo).

## 4. Variables, secretos y archivos

| Dónde | Nombre | Para qué |
|---|---|---|
| App Service (variable) | `CHROME_WEB_STORE_URL` | Página de la tienda; `/empezar` muestra «Instalar desde Chrome Web Store». |
| GitHub, secreto | `CRX_PRIVATE_KEY_PEM` | Clave RSA del CRX; publica `adaceen.crx` y `adaceen-update.xml`. |
| GitHub, variable | `CRX_CODEBASE_URL` | URL del `.crx` en el manifiesto (por defecto la de Azure). |
| GitHub, secretos | `AMO_JWT_ISSUER`, `AMO_JWT_SECRET` | Firma del XPI en el flujo (opción B). |
| Repositorio | `deploy/extension/adaceen-firefox-<versión>.xpi` | XPI firmado a mano (opción A). |

## 5. Qué muestra /empezar según lo publicado

| Publicado | /empezar |
|---|---|
| Nada extra | «Descargar la extension» (zip) y los 4 pasos; bajo «Firefox», la carga temporal. |
| `CHROME_WEB_STORE_URL` | «Instalar desde Chrome Web Store» antes del zip y la nota con «Agregar a Chrome». |
| `adaceen.crx` + `adaceen-update.xml` | Nota «Instalacion por politica (equipos del laboratorio)» con id, manifiesto y valor de la política. |
| `adaceen.xpi` | «Instalar en Firefox» (permanente) en vez de la carga temporal. |
