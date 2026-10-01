# Guía de instalación y uso de ADACEEN

Manual breve para estudiantes y docentes del piloto (Jira A16.8, ADACEEN-150). Describe la extensión de navegador 0.7.20 (2026-10-01), la extensión de VS Code 0.0.33 y el backend con la página de inicio `/empezar`. Hay dos editores: `vscode.dev` por túnel de VS Code (editor en la nube) o VS Code instalado en el equipo, por ejemplo en las Mac del laboratorio.

- Los textos entre comillas angulares son los de la interfaz, copiados tal cual; algunos van sin tilde porque así están en esta versión. `<…>` marca una parte que cambia (tu nombre, un archivo, un código). `tests/scripts/guia-textos.test.ts` comprueba que cada texto de ADACEEN existe en el código. Los de Chrome, macOS o VS Code que ADACEEN copia en sus instrucciones (por ejemplo «Modo de desarrollador» o «Abrir igualmente», que muestra `/empezar`) solo se contrastan con esa copia; los demás de GitHub, Firefox, Windows o VS Code no se comprueban.
- Lo marcado *por verificar* no se pudo confirmar en el código (textos de GitHub, Chrome o macOS, o pasos no probados en un equipo real): revísalo en la validación (sección 6).
- `<backend>` es la dirección del servidor de ADACEEN. En producción: `https://app-adaceen-api-eyder05232002.azurewebsites.net`. Si `<backend>/empezar` no carga (error 404), ese servidor todavía no tiene esta versión: avisa a quien administra el piloto.
- Para dudas y fallos usa el canal definido por el docente del curso.

## Guía rápida para estudiantes (15 minutos o menos)

Antes de empezar ten a mano:

- Google Chrome actualizado (también sirve Edge u otro navegador basado en Chromium; Firefox, ver 1.1).
- El enlace `<backend>/empezar` que te da tu docente. Toda la instalación empieza ahí.
- Tu acceso a ADACEEN: tu cuenta de Google institucional, o el correo y la contraseña que te dio tu docente.
- Tu cuenta de GitHub y un repositorio **público** con tu ejercicio.

### Con el editor en la nube (`vscode.dev`)

| # | Qué haces | Tiempo aprox. |
|---|---|---|
| 1 | Abre `<backend>/empezar`. En «1. Instala la extension del navegador» pulsa «Descargar la extension» y descomprime el archivo (doble clic en macOS; en Windows, clic derecho sobre el zip → «Extraer todo…», por verificar): queda la carpeta `adaceen-navegador`. Déjala donde no la borres. | 1 min |
| 2 | Abre una pestaña nueva y escribe `chrome://extensions` (el botón «Copiar direccion» de la página lo copia). Activa «Modo de desarrollador», pulsa «Cargar descomprimida» y elige la carpeta `adaceen-navegador`. Vuelve a `/empezar` y recarga la página (`F5`): en «Estado» debe decir «Instalada». La pestaña que ya estaba abierta no ve la extensión recién cargada y se queda en «No detectada». Fija el icono de ADACEEN en la barra (menú de extensiones, icono de pieza de rompecabezas). | 3 min |
| 3 | Abre tu repositorio en `github.com` y pulsa el icono de ADACEEN: el overlay abre directamente «Inicia sesion». Entra con «Continuar con Google» o con «Correo», «Contrasena» y «Entrar». La primera vez pulsa «Aceptar y continuar» (se pide una sola vez por cuenta, en cualquier navegador). | 2 min |
| 4 | En «Preparar tu editor», la acción recomendada es «Conectar GitHub»: púlsala y autoriza a ADACEEN en la página de GitHub que se abre. Esa misma ventana se queda esperando con «ADACEEN esta preparando tu editor». | 1 min |
| 5 | Solo la primera vez: la ventana pasa a `github.com/login/device` y arriba aparece el aviso «ADACEEN · tu codigo». Pulsa «Copiar codigo», pégalo en el primer cuadro de GitHub, continúa y autoriza con **la misma cuenta de GitHub** que conectaste. Es el único código que escribes. | 2 min |
| 6 | Cuando GitHub confirma, esa misma pestaña abre `https://vscode.dev/tunnel/ad-<tu-usuario>/home/ws-<tu-usuario>/<repositorio>`. Si `vscode.dev` pide iniciar sesión, elige **GitHub**, nunca una cuenta Microsoft. VS Code se conecta solo con tu cuenta: no pegues nada. Guarda la dirección en tus marcadores. | 3 min |
| 7 | Abre un archivo de tu proyecto, selecciona unas líneas y espera la ventana flotante de ADACEEN. | 1 min |

### Con VS Code instalado (Mac del laboratorio)

Una vez por equipo (lo puede dejar listo el docente):

1. En `<backend>/empezar`, sección «3. VS Code en este equipo (opcional)», pulsa «Preparar Mac del laboratorio», descomprime y haz doble clic en `Preparar-Mac-ADACEEN.command`. Si macOS no lo deja abrir, clic derecho sobre el archivo y «Abrir»; en macOS 15 o posterior, «Ajustes del Sistema» → «Privacidad y seguridad» → «Abrir igualmente». El instalador deja `git`, VS Code 1.96 o posterior y la extensión ADACEEN de VS Code, y al final abre `/empezar`.
2. Si el navegador de esa Mac no tiene la extensión, haz los pasos 1 y 2 de la tabla anterior.

Cada vez:

1. Abre tu repositorio en `github.com`, pulsa el icono de ADACEEN y entra (paso 3 de la tabla anterior).
2. Pulsa «Abrir en VS Code de este equipo» (tarjeta «Tu repositorio» de «Preparar tu editor», o botón de «Accion recomendada»: ADACEEN recuerda tu última elección y, al volver otro día, es el botón principal). No hace falta «Conectar GitHub».
3. El navegador pregunta si quieres abrir Visual Studio Code: acepta. La primera vez VS Code pregunta si permite que la extensión ADACEEN abra el enlace: acepta (textos exactos por verificar).
4. Si el repositorio no estaba en este equipo, elige una carpeta y pulsa «Clonar aquí». VS Code clona, abre el proyecto y avisa «ADACEEN: VS Code quedó conectado como <tu nombre>.».

Cómo sé que quedó bien:

- [ ] El encabezado del overlay muestra tu nombre y «<rol> | tutor contextual» (con «Estudiante»).
- [ ] Túnel: la dirección es `https://vscode.dev/tunnel/ad-<tu-usuario>/home/ws-<tu-usuario>/<repositorio>` y ves tus archivos. Mac: VS Code abrió la carpeta de tu repositorio.
- [ ] La barra de estado de VS Code muestra «ADACEEN: <tu nombre>» (tu cuenta), «ADACEEN: <archivo>» (el tutor) y «GPU: …». Si dice «ADACEEN: sin conectar», ve a 1.7. Si dice «GPU: sin worker activo», la instalación está bien pero el modelo está apagado (ver 3.1).
- [ ] En `vscode.dev`, el panel «Contexto de trabajo» del overlay dice «VS Code conectado».
- [ ] Al seleccionar código aparece la ventana «Sugerencia para la seleccion» (mientras espera dice «consultando al backend»).

Si un paso falla, busca el mensaje en la sección 3.1.

## 1. Estudiantes

### 1.1 Instalar la extensión del navegador

Chrome, Edge u otro navegador basado en Chromium, desde `<backend>/empezar`:

1. Pulsa «Descargar la extension» (descarga `adaceen-navegador.zip`) y descomprímelo en una carpeta fija. En Windows el doble clic solo muestra el contenido del zip: usa clic derecho → «Extraer todo…» (por verificar). El navegador carga la extensión desde allí: si la mueves o la borras, deja de funcionar.
2. Abre `chrome://extensions` (en Edge `edge://extensions`).
3. Activa «Modo de desarrollador» (arriba a la derecha; en Edge, abajo a la izquierda).
4. Pulsa «Cargar descomprimida» (o «Cargar extension sin empaquetar») y elige la carpeta que contiene `manifest.json`. Los nombres pueden variar según el navegador y el idioma.
5. Vuelve a `/empezar` y recarga la página: la pestaña abierta antes de cargar la extensión no la detecta. En «Estado», «Extension del navegador» debe decir «Instalada». Si sigue en «No detectada», revisa que la extensión esté activada en `chrome://extensions`; si dice «Actualizar», hay una versión más nueva (paso siguiente). Recarga también las pestañas de GitHub o Campus que ya tenías abiertas.

Para actualizarla: descarga el zip de nuevo, reemplaza la carpeta y pulsa el botón de recargar de ADACEEN en `chrome://extensions`.

En Edge y Brave, «Continuar con Google» y la sincronización con Google Calendar pueden fallar porque dependen de `chrome.identity.getAuthToken`, una función de Chrome (por verificar). Si fallan, entra con correo y contraseña.

Firefox (versión 128 o superior): `/empezar` solo publica el paquete para Chromium. El de Firefox, `adaceen-firefox-<versión>.zip`, lo entrega tu docente.

1. Abre `about:debugging`, entra en «Este Firefox» y pulsa «Cargar complemento temporal…» (nombres por verificar). Elige el zip.
2. Un complemento temporal se quita al cerrar Firefox: debes cargarlo de nuevo en cada sesión (una instalación permanente exige un paquete firmado por Mozilla, que hoy no hay).
3. No hay inicio de sesión con Google ni Google Calendar: el overlay muestra «Chrome Identity API no disponible.». Entra con correo y contraseña.

### 1.2 Iniciar sesión

1. Abre un sitio del piloto: tu repositorio en `github.com`, Campus Virtual (`campusvirtual.univalle.edu.co`) o tu editor en `vscode.dev`.
2. Pulsa el icono de ADACEEN. Sin sesión, el overlay abre directamente «Inicia sesion»; con la sesión abierta entra al panel sin más clics (mientras confirma la sesión, el botón dice «Preparando...»). Si tu sesión venció o cerraste sesión en otro equipo, verás «La sesion ya no es valida. Inicia sesion nuevamente.».
3. En «Inicia sesion» pulsa «Continuar con Google» (solo Chrome) o escribe «Correo» y «Contrasena» y pulsa «Entrar». Usa la cuenta que te indicó tu docente. Si tu cuenta no existía y entras con Google, se crea como estudiante del docente por defecto: si en «Mis parametros asignados» no ves la política de tu docente, avísale.
4. La primera vez aparece «Acepta la politica de privacidad»: léela y pulsa «Aceptar y continuar». La aceptación queda guardada en el servidor con tu cuenta: otro navegador u otro equipo ya no la pide (solo vuelve si la política cambia de versión). Mientras el aviso está abierto, el tutor no lee la página.
5. Si tienes más de un curso asignado aparece «Elige el curso que quieres reforzar»: marca tu curso y pulsa «Practicar este curso». Con un solo curso no se pregunta.

Para cerrar la sesión pulsa «Salir», en el encabezado del overlay (es el único botón para cerrar sesión; sigue visible con Configuración abierta). Salir también desconecta VS Code de tu cuenta (5.3).

### 1.3 Usar el overlay

El overlay es una ventana flotante que ADACEEN pone sobre la página. No aparece solo: sale cuando pulsas el icono y se mantiene en las páginas siguientes hasta que lo cierras con «×» o `Escape`; «−» lo minimiza. Desde la 0.7.13 el contenido va en pestañas para que todo quepa sin desplazarse: «Inicio» (contexto, acción recomendada y resumen de sesión), «Tutor» (meta, pistas, siguiente paso y fragmento) y, desde la 0.7.17, «Agenda» (la semana del curso y tus evaluaciones, ver 1.10). Al pulsar «Actualizar» o llegar pistas nuevas, el overlay abre «Tutor» solo; las flechas del teclado cambian de pestaña. Partes principales:

- «Accion recomendada»: el siguiente paso según la página (por ejemplo «Abrir mi editor»).
- «Mis parametros asignados»: la política de tu docente (tono, frecuencia, nivel de ayuda, pistas).
- «Hoy quiero reforzar»: elige una meta («Clases y objetos», «Encapsulamiento», «Herencia y polimorfismo», «Resolver errores», «GitHub y Codespaces»); al elegirla, el tutor responde de nuevo.
- «Pistas de hoy» y «Siguiente paso»: la respuesta del tutor (sección 2). «Fuentes RAG usadas» (plegada; desde la 0.7.14 muestra cuántas fuentes hay y se abre con un clic): el material del curso que la respalda, una línea por fuente y el motivo con «+» (2.2). La línea de estado de abajo resume la respuesta en tres partes: qué se detectó, la política aplicada y cuántas fuentes se usaron.
- «¿Te sirvió esta ayuda?»: pulsa «Me sirvió» o «No me sirvió»; así tu docente sabe qué ayuda funciona. «Ver fragmento detectado» muestra lo que ADACEEN leyó de la página.
- En el editor, «Explorar repo» y «OCR visual» leen el proyecto y la pantalla para dar más contexto (pide permiso la primera vez, ver 5.1); fuera del editor no aparecen. En Campus, al entrar en un curso ADACEEN verifica solo tu acceso y la bitácora, y la acción recomendada es una sola: «Analizar Campus» y, después, «Sincronizar agenda», que guarda las fechas de las actividades en tu Google Calendar (solo Chrome). «Verificar acceso» solo aparece si esa verificación falla o falta la bitácora.
- Configuración (icono de tuerca): desde la 0.7.14 va en secciones que se pliegan; la tuya es «Sesion y tutor», con «Tutor activo», «Configuracion automatica (archivo principal)» y «Base URL del backend» (no la cambies salvo que tu docente lo indique). Guarda con «Guardar cambios», que queda siempre visible abajo.

Teclado: `Tab` recorre los controles; `Escape` cierra la capa abierta y luego el overlay; `Ctrl+Enter` (`Cmd+Enter` en macOS) pide ayuda, igual que el botón «Actualizar».

### 1.4 Preparar tu editor en la nube (túnel)

Tu editor es VS Code real en `vscode.dev`, conectado por un túnel a una máquina en la nube (la VM de editores) donde ADACEEN clona tu repositorio. Si usas VS Code instalado en el equipo, sigue la parte *Con VS Code instalado (Mac del laboratorio)* de la guía rápida.

**Lo más rápido (0.7.20):** con la sesión de ADACEEN iniciada, abre el repositorio en `github.com` y pulsa **«Abrir en mi editor»**. Es el botón verde junto a Watch, Fork y Star; no hace falta abrir el overlay. Abre ese repositorio en tu editor y, si todavía no estaba, lo agrega en su propia carpeta. Mientras prepara dice «Preparando tu editor…». Sirve para cualquier repositorio que tu cuenta de GitHub pueda ver, también los privados de GitHub Classroom. El código de GitHub del paso 3 se pide una sola vez: con el segundo repositorio ya no.

Paso a paso, la primera vez:

1. Abre tu repositorio en `github.com` con el overlay abierto y la sesión iniciada. «Preparar tu editor» (etiqueta «Primera vez») muestra una sola tarjeta, «Tu repositorio», con el repositorio de la página (si no lo detecta, escribe `owner/repo` o pulsa «Autodetectar repositorio» en «Accion recomendada»). Con el túnel no se usa la GitHub App ni se crean ramas ni PR: el contexto muestra solo las filas «ADACEEN», «GitHub OAuth» y «Editor», y Configuración no tiene ajustes de la GitHub App.
2. En «Accion recomendada» pulsa «Conectar GitHub» y autoriza a ADACEEN en GitHub (nombre de la app y botón de GitHub por verificar). Al volver, ADACEEN prepara el editor en esa misma ventana, sin otro clic. Si la cuenta ya estaba conectada, el botón es «Preparar mi editor».
3. La ventana de espera dice «ADACEEN esta preparando tu editor». La primera vez GitHub pide un código de un solo uso: la ventana pasa a `https://github.com/login/device` con el aviso «ADACEEN · tu codigo» y el botón «Copiar codigo» (el overlay también dice «Autoriza tu editor: codigo …»). Pega el código **una sola vez** y autoriza con la misma cuenta de GitHub. El código vence en unos 15 minutos y ADACEEN espera hasta 12.
4. Cuando el editor está listo, esa misma pestaña abre `https://vscode.dev/tunnel/ad-<tu-usuario>/home/ws-<tu-usuario>/<repositorio>` (si la ventana de espera de ADACEEN está a la vista, antes dice «Editor listo. Redirigiendo...»). Si no se abre, usa «Abrir en mi editor» en GitHub o «Abrir mi editor» en el overlay.
5. Si `vscode.dev` pide iniciar sesión para entrar al túnel, elige **GitHub** (texto exacto del botón por verificar). Con una cuenta Microsoft, `vscode.dev` dirá que no encuentra el túnel ("not found").

Datos útiles:

- El túnel se llama `ad-<tu-usuario>`: `ad-` más los primeros 17 caracteres de tu usuario de GitHub.
- Cada repositorio va en su propia carpeta del mismo editor: abrir otro no borra ni cambia el anterior. En Inicio, «Tus repositorios en el editor» los lista para abrirlos con un clic, también desde Campus.
- Si ADACEEN dice que GitHub no muestra el repositorio para tu cuenta: revisa que exista y que tengas acceso (en GitHub Classroom, acepta primero la invitación de la tarea). Si es privado y te pide volver a conectar GitHub, hazlo desde el overlay. Si dice que la organización no aprobó ADACEEN, avisa al docente.
- Para hacer commit y push desde el editor no hace falta configurar nada: tu nombre de git es tu usuario de GitHub y el push usa la cuenta con la que abriste `vscode.dev`.
- Si la VM de editores está apagada, la ventana no se cierra: dice «Encendiendo la VM de editores...» (se enciende sola en 1 o 2 minutos, si el piloto lo configuró) o «El editor esta apagado; avisa al docente», y sigue esperando.
- La VM se apaga sola tras 120 minutos sin nadie conectado (valor por defecto).
- Si tu docente indica que el piloto usa Codespaces en vez del túnel, la vista se llama «Preparar repositorio» y también va de un botón a la vez en «Accion recomendada»: «Autorizar GitHub App» abre la instalación en otra pestaña (al terminar puedes cerrarla: ADACEEN la detecta sola, mientras dice «Esperando la GitHub App»), y luego «Conectar GitHub» crea el PR y el Codespace y lo abre en esa misma ventana. Si tu cuenta ya estaba conectada, el botón es «Preparar entorno ADACEEN». El resto de la guía aplica igual.

### 1.5 Usar la extensión de VS Code

En `vscode.dev` la extensión ADACEEN ya viene instalada (la instala la VM de editores) y se conecta sola: cada vez que se prepara tu editor (la primera vez, después de «Salir» en ese navegador o cada 7 días), la VM deja tu sesión en un archivo de tu usuario y la extensión lo lee. En la Mac la conecta el botón «Abrir en VS Code de este equipo». No hay que copiar ni pegar nada.

Dónde aparece la ayuda:

- Barra de estado: «ADACEEN: <tu nombre>» (tu cuenta; un clic abre «ADACEEN: Conectar», ver 1.7), «ADACEEN: <archivo>» (un clic abre el panel) y «GPU: <origen>» (por ejemplo `Google Cloud - L4`), que indica si el modelo está disponible.
- Sobre la línea (CodeLens): «ADACEEN: <resumen>» y, si puedes aplicar el cambio, «Aceptar ayuda: <acción>», donde la acción es «Insertar», «Modificar» o «Eliminar». Mientras la ventana flotante está abierta en ese archivo, «Aceptar ayuda» y la pista en línea no se repiten (las acciones están en la ventana); si la cierras con la «×», esa sugerencia no se vuelve a ofrecer hasta que llegue otra.
- Ventana flotante al seleccionar código («Sugerencia para la seleccion»): la recomendación, el código propuesto y las acciones «Insertar debajo», «Modificar seleccion», «Eliminar seleccion», «Ver panel» y «Otra sugerencia»; la recomendada va en negrita con «(recomendada)». Analiza hasta 20 líneas.
- Al pasar el ratón sobre la línea: la sugerencia, «Ver panel», «Aceptar ayuda: …» y la fuente del material. Con el arreglo rápido (`Ctrl+.`): «ADACEEN: Aceptar ayuda - agregar debajo» y variantes; la recomendada lleva «(recomendado)».
- Barra de actividades → ADACEEN → «Quiz y seguimiento»: mini quiz e «Historial» de recomendaciones. Puedes arrastrarlo a la barra lateral derecha o al panel inferior.
- El overlay sobre `vscode.dev` también muestra el resumen del archivo y la sugerencia de línea; si eliges ahí una opción de reemplazo, VS Code la aplica en unos segundos con las mismas reglas (tu clic en el overlay cuenta como confirmación). Solo pregunta «Aplicar reemplazo» u «Omitir» si el código que elegiste ya no está donde lo viste, si el cambio es grande o si el pedido esperó más de 10 minutos (VS Code estaba cerrado).

Aplicar un cambio:

1. Pulsa «Aceptar ayuda» o una acción de la ventana flotante.
2. ADACEEN pregunta al servidor si tu docente lo permite. Tu clic es la confirmación: un cambio de hasta 5 líneas que no borra código se aplica sin otra pregunta. Si tu docente pide confirmar y el cambio es más largo o borra código (o lo aplicó ADACEEN solo), verás «ADACEEN: ¿Aplicar el cambio del tutor …?», con el nombre del archivo y el número de líneas: pulsa «Aplicar», o cierra para cancelar.
3. Todo se deshace con `Ctrl+Z` (`Cmd+Z` en Mac). Si la política no lo permite verás el motivo y el código queda como guía (2.3).
4. Después puede aparecer un mini quiz en «Quiz y seguimiento» (2.4).

En la Mac: **guarda tu trabajo en GitHub** (commit y push) antes de irte; en los equipos del laboratorio tu copia puede borrarse al cerrar sesión o al reiniciar. Usa `Cmd` donde la guía dice `Ctrl`.

### 1.6 Volver otro día

Con el editor en la nube:

1. Abre tu repositorio en `github.com` y pulsa «Abrir en mi editor», junto a Watch, Fork y Star. También puedes ir a cualquier página que no sea Campus ni el editor y pulsar el icono de ADACEEN: si tu sesión sigue abierta, el overlay entra directo y ofrece «Abrir mi editor», además de tus otros repositorios en «Tus repositorios en el editor». En otro navegador o equipo, entra (1.2): no se vuelve a pedir la privacidad y, como tu editor ya existe en el servidor, el overlay ofrece también «Abrir mi editor» en vez del tour; se abre sin pedir otra vez el código de GitHub.
2. Pulsa «Abrir mi editor». ADACEEN comprueba el editor y lo abre; si la VM estaba apagada, espera a que encienda (1.4). No vuelve a pedir el código de GitHub.
3. VS Code se conecta solo. Si cerraste sesión («Salir») en este navegador o pasaron más de 7 días, «Abrir mi editor» renueva tu sesión en la VM antes de abrir.

También sirve el marcador de `vscode.dev` que guardaste, siempre que la VM esté encendida. Si tu sesión del navegador se cerró, entra de nuevo (1.2) y pulsa «Abrir mi editor».

Con VS Code instalado (Mac): entra en el overlay y pulsa otra vez «Abrir en VS Code de este equipo», que ahora es el botón principal de «Accion recomendada» (ADACEEN recuerda que la última vez elegiste VS Code de este equipo). Si el repositorio ya está en ese equipo, VS Code abre esa carpeta (no vuelve a clonar) y queda conectado con tu cuenta. Si otra persona usó ese VS Code, el aviso «ADACEEN: VS Code quedó conectado como <tu nombre> (antes: <otra cuenta>). ¿No eres tú? …» es normal; si no eres tú, pulsa «Desconectar».

### 1.7 Si VS Code dice «ADACEEN: sin conectar»

Sin conexión el tutor funciona, pero aplica la política del docente por defecto y tus sugerencias, métricas y quices no quedan a tu nombre. Para conectarlo:

1. En el editor en la nube lo más rápido es el paso 2 con «Con mi cuenta de GitHub (recomendado)». La otra forma es volver a preparar el editor: en el overlay del navegador pulsa «Salir», entra de nuevo (1.2) y pulsa «Abrir mi editor». Así pasa por la preparación, la VM escribe una sesión nueva y VS Code la toma sola en unos segundos. Si VS Code se desconectó porque cerraste sesión (en este u otro equipo), basta con entrar y pulsar «Abrir mi editor»: ADACEEN ve que tu sesión de VS Code ya no vale y la VM escribe otra. Si no cerraste sesión y preparaste el editor en este navegador hace menos de 7 días, pulsar solo «Abrir mi editor» no basta: abre el editor sin escribir la sesión.
2. En el túnel o en la Mac, pulsa «ADACEEN: sin conectar» en la barra de estado (o `F1` → «ADACEEN: Conectar») y elige una opción:

| Opción | Qué hace | Cuándo |
|---|---|---|
| «Con mi cuenta de GitHub (recomendado)» | VS Code pide permiso para usar tu cuenta de GitHub: un clic en «Permitir». ADACEEN busca la cuenta de ADACEEN que conectó esa misma cuenta de GitHub. | Estudiantes que ya pulsaron «Conectar GitHub» en el overlay. |
| «Tengo un código o sesión» | Pide el código de 8 caracteres (`XXXX-XXXX`); también acepta el ID de sesión de versiones anteriores. El código se obtiene con «Copiar codigo para VS Code», en el panel «Contexto de trabajo» del overlay sobre `vscode.dev` (el botón se oculta cuando VS Code ya está conectado): sirve una sola vez y dura 10 minutos. En la Mac no hace falta: «Abrir en VS Code de este equipo» manda el código solo. | Cuentas de docente o administrador, si GitHub no funciona o si el backend todavía no tiene esta versión. |

- Las cuentas de **docente o administrador** no se pueden conectar con «Con mi cuenta de GitHub»: el backend responde «Las cuentas de docente y administrador se vinculan con un codigo del navegador…». Usen «Tengo un código o sesión» o «Abrir en VS Code de este equipo».
- Si la sesión actual está guardada en ese VS Code (la conectaste con una de estas opciones o, en la Mac, con el botón del navegador), el mismo menú ofrece «Desconectar este equipo» (olvida esa sesión). Si la sesión viene del archivo que escribe la VM del túnel, esa opción no aparece.
- Cuando la sesión deja de valer (por ejemplo, cerraste sesión en el navegador) VS Code avisa una vez con el botón «Conectar»; en el túnel también basta volver a pulsar «Abrir mi editor» en el navegador.
- «ADACEEN: Configurar sesión compartida» sigue existiendo (por compatibilidad) y abre la misma caja que «Tengo un código o sesión».

### 1.8 Activación bajo demanda

Nada se aplica en tu archivo sin tu clic. Lo que activa al tutor, según el código actual:

| Dónde | Se activa solo | Lo pides tú |
|---|---|---|
| Overlay | El overlay no se abre solo: aparece al pulsar el icono. Abierto, el tutor responde una vez al iniciar sesión o entrar al panel (al volver otro día con «Abrir mi editor», no hasta que lo uses). | «Actualizar» (`Ctrl+Enter`) o una meta de «Hoy quiero reforzar». |
| VS Code | Cursor quieto 3 s (`cursor_idle`); selección quieta 1,2 s (`selection`); primera consulta al abrir un archivo (`file_open`); bloqueo: el mismo error 90 s o 3 veces en 10 min (`blocking`). «Aceptar ayuda» aparece tras unos 10 s con el cursor quieto (unos 2 s si seleccionaste). | «ADACEEN: Actualizar sugerencias del archivo activo» u «Otra sugerencia»; «ADACEEN: Abrir panel de quiz y seguimiento» o clic en «ADACEEN: <archivo>» de la barra de estado. |

Para que intervenga menos:

- Overlay: Configuración → desmarca «Tutor activo» → «Guardar cambios» (verás «El tutor esta pausado. Puedes reactivarlo en configuracion.»).
- VS Code (Configuración, busca `adaceen`): `adaceen.triggers.suggestOnBlocking` en `false` evita la consulta automática por bloqueo; `adaceen.suggestions.selectionWidget` en `false` quita la ventana flotante.
- Esta versión no tiene un modo "solo bajo demanda" en VS Code: `adaceen.suggestions.enabled` en `false` apaga también las consultas manuales.

### 1.9 Bloques del piloto con y sin tutor

En el piloto cada sesión tiene dos bloques: en uno trabajas con el tutor y en el otro sin él. El orden lo decide el sistema al azar (grupo A o B) y no cambia durante el piloto.

- En el bloque sin tutor, cuando pidas ayuda o el tutor se active solo, verás «En este bloque del piloto trabajas sin el tutor. Sigue con tu ejercicio como lo harias en clase; el tutor vuelve en el siguiente bloque.» y «Aplicar» no estará disponible. No es una falla: no reinstales nada.
- Trabaja como en cualquier clase: puedes preguntarle a tu docente, pero no uses otros asistentes de inteligencia artificial.
- En los dos bloques se registra lo mismo (cuándo aparece y desaparece un error, sin tu código ni el texto del error): así se comparan los bloques.
- Para que cuente tu trabajo, VS Code debe estar conectado con tu cuenta: la barra de estado dice «ADACEEN: <tu nombre>» y no «ADACEEN: sin conectar» (1.7).

### 1.10 Agenda del curso y Google Calendar

Desde la 0.7.17, si tu docente subió la bitácora del curso, ADACEEN sabe en qué semana vas:

- En «Inicio», la línea «Estás en <curso> · semana <n> de <total>» (por ejemplo, FPOO, semana 5 de 16) muestra el tema de la semana y la próxima evaluación con su fecha («Próximo: <evaluación>, <fecha>», por ejemplo el primer parcial el martes 6 de octubre, en 9 días). Al pulsarla se abre «Agenda». Si tu docente aún no la sube, dice «Tu docente aún no sube la bitácora del curso.».
- «Agenda»: «Esta semana» (tema y lo que se hace en clase), «Próximas evaluaciones y entregas», «Todas las semanas» (plegado, con la de hoy marcada) y «Actualizar». En tu editor la tarjeta «Contexto de trabajo» no aparece en esta pestaña, para no tapar la agenda.
- En «Tutor», bajo «Hoy quiero reforzar», la misma semana en una línea («Semana <n> de <total>» y «<curso>: <tema>»); al pulsarla se abre «Agenda». En el editor el overlay suele quedar en «Tutor», así que ahí también sabes en qué semana vas.
- El tutor recibe la semana y el tema con cada pregunta, para que las pistas vayan con lo que se está viendo en clase.
- «Sincronizar con Google Calendar» pasa a tu calendario las evaluaciones y entregas que faltan desde hoy, con aviso un día y una hora antes (la bitácora no trae hora: quedan a las 9:00 y puedes moverlas). Solo funciona si entraste a ADACEEN con tu correo de la universidad (…@correounivalle.edu.co) y si la cuenta de Google de Chrome es esa misma; si no, el botón queda apagado o el aviso te dice qué cuenta tiene Chrome. No se repite nada: las que ADACEEN ya puso quedan como están (aunque las hayas movido de hora o de día) y, si ya tenías la evaluación con otro nombre ese mismo día (por ejemplo "Entregar proyecto 3 de POO", o la que vino de Campus), tampoco se crea («ya lo tenías con otro nombre»). Si tu docente cambió las fechas, se pasan al día nuevo con la hora que tenían. Chrome pide permiso la primera vez.
- «Sugerir bloques de estudio» propone sesiones antes de las tres próximas evaluaciones (dos antes de un parcial, dos antes de una entrega) en horas libres de tu calendario: entre semana en la tarde o la noche y el fin de semana en la mañana o la tarde. Marca las que quieras y pulsa «Agregar los marcados a Google Calendar».

## 2. Cómo interpretar las respuestas

### 2.1 Etapas de ayuda

Con el nivel «Progresiva» (el del piloto), cada ayuda en el mismo ejercicio (la misma actividad de Campus o el mismo archivo) sube de etapa:

| Etapa | Cuándo aparece | Qué trae | Qué hacer |
|---|---|---|---|
| Pista 1 | Primera ayuda del ejercicio. | Dónde mirar (línea, concepto o mensaje de error) y una pregunta guía. Sin código en el overlay («codigo omitido: en esta etapa la ayuda es solo una pista»). | Responde la pregunta tú y da el paso pequeño que propone. |
| Pista 2 | Segunda ayuda. | La causa probable y el concepto del curso; como máximo 2 líneas de pseudocódigo, nunca tu código corregido. | Revisa tu código con ese concepto y comprueba como te indica. |
| Ejemplo parcial | Tercera ayuda. | El patrón en otro dominio y con otros nombres (máximo 8 líneas) y un `TODO` para completar. | Adáptalo a tu ejercicio: no sirve pegarlo tal cual. |
| Explicación breve | Preguntas de concepto ("¿qué es el polimorfismo?"). | Definición corta, por qué importa, un ejemplo de hasta 4 líneas y la cita del material. | Úsala para entender y vuelve a tu código. |
| Mensaje controlado | Falta contexto, la consulta está fuera del curso o la política no permite ayudar. | El mensaje de tu docente (en el piloto: «No puedo ayudar con ese tema o con tan poco contexto. Muestrame el ejercicio, el error o un fragmento del codigo del curso.») y un «Motivo de control». | Agrega el enunciado, el error visible o selecciona el fragmento, y vuelve a pedir ayuda. |

- Con «Solo pistas» verás Pista 1 y luego Pista 2; con «Ejemplo parcial», Pista 1 y luego Ejemplo parcial.
- Al llegar al máximo de pistas del ejercicio (3 en el piloto) el overlay responde «Ya alcanzaste el limite de pistas definido por el docente para este ejercicio (<N>).»: intenta el siguiente paso por tu cuenta.
- En VS Code la ayuda se gradúa por tamaño del cambio: hasta 5 líneas, luego 10 y luego el máximo de tu docente. Al agotar las aplicaciones del archivo verás «Ya usaste las <N> ayudas con codigo que tu docente permite para este archivo. Intenta el siguiente paso por tu cuenta.».

### 2.2 Citas del material autorizado

- Las pistas terminan con una etiqueta como `[RAG-FPOO-15#c1]` o `[RAG-FPOO-15#c1 p.3]`: `RAG-FPOO-15` es la fuente (material autorizado del curso FPOO), `#c1` el fragmento usado y `p.3` la página.
- La etiqueta del texto no es un enlace. Abre «Fuentes RAG usadas»: cada fuente va en una línea (título, «RAG principal» o «Suplementario» si viene de la bitácora, página, etiqueta y puntaje), agrupadas por curso; «+» muestra por qué se usó y «Abrir» abre el fragmento exacto en otra pestaña.
- En VS Code pasa el ratón sobre la sugerencia: «Fuente RAG» (o «Contexto suplementario») con el título del material, y el enlace «Abrir fuente o detalle». También sirve «ADACEEN: Ver fuente RAG».
- Una pista sin cita no se apoyó en el material del curso: contrástala con tus apuntes o con tu docente.

### 2.3 «Aplicar» en VS Code y por qué a veces no aparece

«Aplicar» es cualquier acción que escribe en tu archivo: «Aceptar ayuda: …», «Insertar debajo», «Modificar seleccion», «Eliminar seleccion», el arreglo rápido o el botón «Aplicar» de la confirmación.

| Lo que ves | Por qué | Qué hacer |
|---|---|---|
| No hay «Aceptar ayuda» ni botones en la ventana flotante; dice «solo guia» o «Usa el codigo como guia y escribelo tu.» | Tu docente desactivó la aplicación de código, o la respuesta es un mensaje controlado. | Escribe el cambio tú. |
| «El cambio tiene <N> lineas y tu docente permite aplicar como maximo <M>. Aplica una parte y escribe el resto tu.» | El cambio es más largo de lo permitido (20 líneas en el piloto). Si el servidor recortó el código, quita la opción de aplicar. | Aplica una parte o escríbelo tú. |
| «Ya usaste las <N> ayudas con codigo…» o «Te quedan <N> aplicaciones en este archivo.» | Cada aplicación cuenta como pista y el cupo del archivo se agotó (o está por agotarse). | Sigue por tu cuenta o consulta a tu docente. |
| «pista local (el backend no respondio)» | El servidor no respondió; las pistas locales no se aplican. | Pide «Otra sugerencia» más tarde. |
| «No se pudo confirmar con el servidor si puedes aplicar este cambio…» | Sin conexión solo se aplican cambios de hasta 12 líneas (`adaceen.codeApplication.offlineMaxLines`). | Revisa tu conexión y reintenta. |

### 2.4 Mini quiz

- Cuándo: después de aplicar una sugerencia (en el piloto, cada vez, con un máximo de 5 por sesión de 12 horas) o cuando tu docente lanza uno a la clase.
- Dónde: VS Code → ADACEEN → «Quiz y seguimiento». Si tu docente lanza uno verás «ADACEEN: tu docente lanzo un quiz…» con el tema: pulsa «Responder». El panel revisa cada 30 s; también puedes pulsar «Buscar quiz del docente» o ejecutar «ADACEEN: Buscar quiz del docente».
- Formato: una pregunta de opción múltiple (normalmente 4 opciones, de A a D) sobre qué hace el cambio o por qué es correcto. Al responder verás «Correcto.» o «No es esa.» y la explicación.
- Si fallas y tu docente activó la pregunta de seguimiento, escribe en «Explicalo con tus palabras...» y pulsa «Enviar explicacion». El modelo la califica de 0 a 100 con un comentario; si no puede, verás «Tu respuesta quedo guardada. No pude calificarla ahora; tu docente podra revisarla.». «Omitir» salta la pregunta y «Listo» la cierra.
- Si el modelo no está disponible, la pregunta sale de un banco de preguntas validadas del curso (`data/quiz/banco-fpoo.json`), así que el quiz funciona aunque el servidor del modelo esté apagado.

## 3. Si algo falla

### 3.1 Mensajes y qué hacer

Editor en la nube (overlay y ventana de espera):

| Lo que ves | Causa probable | Qué hacer |
|---|---|---|
| «Encendiendo la VM de editores...» | La VM de editores estaba apagada y el backend la está encendiendo (código `vm_starting`). | Espera 1 o 2 minutos sin cerrar la ventana: el editor se abre solo. |
| «El editor esta apagado; avisa al docente» | La VM de editores está apagada y el piloto no la enciende solo, o no pudo encenderla (código `agent_unreachable`, reintentable). | No cierres la ventana: sigue consultando. Avisa a tu docente para que inicie la clase (4.1). Si se agota la espera, pulsa «Abrir mi editor» cuando la enciendan. |
| «Esperando a la VM de editores» con «La VM de editores no respondio a tiempo. Intenta de nuevo en un momento.» | La VM está ocupada o lenta (código `agent_timeout`, reintentable). | Espera; la ventana sigue consultando. |
| «El editor no confirmo a tiempo» y «El codigo <código> no se autorizo a tiempo. Pulsa "<botón>" de nuevo para recibir otro.» | El código de GitHub venció sin autorizar. | Pulsa el botón que nombra el aviso («Abrir mi editor», o «Preparar mi editor» si es la primera vez) y usa el código nuevo. |
| En `github.com/login/device`: «ADACEEN dejo de esperar.» o «ADACEEN ya no espera este codigo.…» | La pestaña de ADACEEN se cerró o recargó, o la espera terminó. | Vuelve a la pestaña de ADACEEN y pulsa el botón que nombra el aviso («Abrir mi editor» o «Preparar mi editor»). |
| `vscode.dev` dice que no encuentra el túnel ("not found"). | Entraste a `vscode.dev` con una cuenta Microsoft, o autorizaste el código con otra cuenta de GitHub. | En el menú de cuentas de `vscode.dev` (icono de persona, abajo a la izquierda) cierra la sesión Microsoft y entra con GitHub, la misma cuenta que conectaste. Si autorizaste con otra cuenta, avisa a tu docente para reiniciar tu entorno. |
| «GitHub no muestra <repositorio> para tu cuenta <usuario>.…» | El repositorio no existe, tu cuenta no tiene acceso (en GitHub Classroom, falta aceptar la invitación) o tu conexión de GitHub no tiene permiso para repositorios privados. | Revisa el enlace y acepta la invitación. Si el aviso pide volver a conectar GitHub, pulsa «Conectar GitHub» en el overlay. |
| «La organizacion <organizacion> todavia no aprobo ADACEEN…» | La organización del repositorio restringe las apps de terceros y no aprobó ADACEEN para sus repositorios privados. | Avisa a tu docente: el dueño de la organización lo aprueba una vez en GitHub. |
| «No se pudo clonar el repositorio: no existe o tu cuenta de GitHub no tiene acceso.…» | La VM no pudo clonar el repositorio con tu cuenta. | Revisa el acceso y vuelve a pulsar «Abrir en mi editor»; si se repite, avisa a tu docente. |
| «Tu editor esta terminando de preparar <repositorio>.…» | Pediste otro repositorio mientras la VM terminaba de agregar uno. | Espera: la ventana sigue sola y abre el que pediste. |
| «La cuenta de GitHub <usuario> no esta en la lista del piloto. Pide al docente que la agregue.» | Tu usuario no está autorizado en el piloto. | Pide a tu docente que lo agregue. |
| «Conecta tu cuenta de GitHub: el editor se registra a tu nombre.» o «Tu conexion con GitHub ya no es valida.…» | Falta la autorización de GitHub o la revocaste. | Pulsa «Conectar GitHub» y autoriza de nuevo. |

VS Code:

| Lo que ves | Causa probable | Qué hacer |
|---|---|---|
| «ADACEEN: sin conectar» en la barra de estado | VS Code no tiene tu sesión: la VM todavía no escribió el archivo, la sesión venció (30 días) o cerraste sesión. | Sección 1.7. |
| «ADACEEN: tu sesión dejó de valer (por ejemplo, cerraste sesión en el navegador).…» con el botón «Conectar» | Pulsaste «Salir» en el navegador (en este u otro equipo) o la sesión venció. | Túnel: pulsa «Abrir mi editor» en el navegador (si el overlay te pide iniciar sesión, entra primero): ADACEEN escribe una sesión nueva y VS Code se conecta solo. También sirve «Conectar» → «Con mi cuenta de GitHub (recomendado)». Mac: pulsa otra vez «Abrir en VS Code de este equipo», o «Conectar». |
| «El código no existe, ya se usó o venció (dura 10 minutos). Pide uno nuevo en el navegador.» | El código ya se usó, pasaron más de 10 minutos o pediste otro después. | Pide otro con «Copiar codigo para VS Code» o con el botón del overlay. Si el aviso dice que VS Code usa el backend local de este equipo, ver la última fila. |
| «Las cuentas de docente y administrador se vinculan con un codigo del navegador…» | Cuenta de docente o administrador con «Con mi cuenta de GitHub». | «Tengo un código o sesión» (1.7). |
| «Conecta tu cuenta de GitHub en ADACEEN (overlay del navegador) y vuelve a intentar.» | Esa cuenta de GitHub no está conectada a ninguna cuenta de estudiante de ADACEEN. | Pulsa «Conectar GitHub» en el overlay, o usa «Tengo un código o sesión». |
| «Demasiados intentos seguidos. Espera un minuto y vuelve a intentar.» | Muchos intentos fallidos desde la misma red (el laboratorio comparte una IP). | Espera un minuto. |
| «todavía no permite conectar VS Code así» | El backend no tiene esta versión. | «Tengo un código o sesión» con el ID de sesión que copia el navegador, y avisa al docente. |
| «ADACEEN: VS Code quedó conectado como <nombre> (antes: <otra cuenta>). ¿No eres tú? …» | En un equipo compartido, otra persona había conectado ese VS Code. | Si eres tú, nada. Si no, pulsa «Desconectar» y vuelve a pulsar el botón del navegador. |
| Mac: el overlay dice «No se pudo pedir el codigo de conexion (…)» | El backend tardó (por ejemplo, recién encendido) y VS Code abrió el repositorio sin conectar. | Pulsa el botón otra vez, o en VS Code «ADACEEN: sin conectar» → «Con mi cuenta de GitHub (recomendado)». |
| Mac: «ADACEEN: para clonar <repositorio> hace falta git y no está instalado en este equipo.…» | Mac sin las herramientas de línea de comandos de Apple. | Pulsa «Instalar git» (o «Descargar git», «Copiar comando»), espera a que termine, cierra y abre VS Code y vuelve a pulsar el botón del navegador. |
| Mac: el navegador no ofrece abrir VS Code, o se abre y no pasa nada. | VS Code no está instalado, nunca se abrió en ese equipo o tiene una extensión anterior a la 0.0.31. | Haz doble clic otra vez en `Preparar-Mac-ADACEEN.command`, abre VS Code una vez a mano y vuelve a pulsar el botón. |
| El recuadro de «GPU: …» dice «Backend: <dirección> …» con `http://127.0.0.1:3000` | En ese equipo corre un backend local de ADACEEN y la extensión lo usa (el recuadro dice «backend local detectado en esta maquina»), o alguien fijó `adaceen.backend.baseUrl` en esa dirección («ajuste adaceen.backend.baseUrl»); los códigos del navegador de producción no le sirven. | Avisa al docente. Si ese equipo no debe usar un backend local, apágalo o pon en `adaceen.backend.baseUrl` (Configuración, busca `adaceen`) la dirección de producción, `https://app-adaceen-api-eyder05232002.azurewebsites.net`. Dejar el ajuste vacío solo sirve si estaba fijado a mano en `http://127.0.0.1:3000` y no corre un backend local. |

Tutor, sesión y navegador:

| Lo que ves | Causa probable | Qué hacer |
|---|---|---|
| «El tutor no esta disponible en este momento: el servidor del modelo no respondio.», «GPU: sin worker activo» o «Se usa apoyo local por ahora.» | El servidor del modelo (GPU) está apagado u ocupado; se enciende para las sesiones del curso. | Intenta más tarde. «ADACEEN: Ver de donde sale la GPU» muestra el estado. Si pasa en clase, avisa a tu docente. |
| No aparece «Aceptar ayuda». | Política del docente, cambio muy largo, cupo agotado o todavía no pasan unos 10 s con el cursor quieto. | Ver 2.3 y 1.8. |
| «Ya hay una sesión activa» o «Sesion activa en otra pestaña: …» | El overlay de tu sesión está abierto en otra pestaña. | Ciérralo allí (× o `Escape`) o cierra esa pestaña y pulsa «Revisar nuevamente». |
| «La sesion ya no es valida. Inicia sesion nuevamente.» | Tu sesión venció, o cerraste sesión («Salir») o entraste en otro navegador. | Entra de nuevo (1.2). |
| «VS Code aun no publico contexto» o «Esperando extension VS Code». | VS Code no está conectado con tu cuenta o no hay un archivo abierto. | Revisa la barra de estado de VS Code (1.7) y abre un archivo. |
| «Chrome Identity API no disponible.» | Firefox (u otro navegador sin esa función). | Entra con correo y contraseña. |
| «La cuenta de Google no pertenece al dominio permitido.» | El piloto solo acepta el dominio institucional. | Usa tu cuenta institucional o pide credenciales a tu docente. |
| «Primero tienes que salir de la sesion activa.» | Hay otra cuenta con la sesión abierta. | Pulsa «Salir» y vuelve a entrar. |
| En `/empezar`, «No detectada» | La extensión no está cargada en este navegador, o la página se abrió antes de cargarla. | Recarga la página; si sigue, repite 1.1. |
| Al pulsar el icono no pasa nada. | La pestaña se abrió antes de instalar la extensión, o es una página interna (`chrome://…`). | Recarga la página o abre un sitio del piloto. |
| En Firefox la extensión desapareció. | Los complementos temporales se borran al cerrar Firefox. | Cárgala de nuevo (1.1). |

### 3.2 Cómo reportar un error

«Me sirvió» y «No me sirvió» sirven para opinar sobre una respuesta, no para reportar fallos. Para un fallo escribe por el canal definido por el docente del curso e incluye:

1. Fecha y hora aproximada, dónde estabas (Campus, GitHub, `vscode.dev` o VS Code) y qué estabas haciendo, paso a paso.
2. Qué esperabas que pasara y qué pasó, con el mensaje exacto (cópialo) y una captura de pantalla.
3. Navegador y versión; versión de la extensión (se ve en la vista «Inicia sesion», por ejemplo «Browser v<versión> - <fecha>») y de la extensión de VS Code (vista Extensiones, ADACEEN).
4. Tu usuario de GitHub, si el problema es del editor o del túnel.
5. Si te lo piden, las líneas relevantes de VS Code en «Output» → «ADACEEN».

Nunca incluyas contraseñas, tokens de GitHub o Google, el código que copia «Copiar codigo para VS Code», el código de `github.com/login/device` ni el contenido de `~/.adaceen/editor-session.json`. Tapa esos datos si salen en una captura.

## 4. Docentes

### 4.1 Iniciar y terminar la clase

Todo desde **Cloud Shell** (`https://shell.cloud.google.com`, proyecto `adaceen-508504`), con el repositorio PDC en la rama que usa producción (detalle y variables en el [runbook](operacion/runbook.md), sección 0, *Ciclo de cada clase*). Mientras esta versión no esté desplegada, `deploy/clase.sh` solo está en la rama `claude/serene-heisenberg-0te9s9`.

```bash
bash deploy/clase.sh iniciar     # unos 15 minutos antes: enciende, espera e imprime el enlace
bash deploy/clase.sh estado      # cuando quieras: qué hay encendido (no cambia nada)
bash deploy/clase.sh terminar    # al terminar: apaga la GPU y la VM de editores
```

- `iniciar` enciende una GPU (la primera que arranque en el orden V100, A100, L4) y la VM de editores, espera hasta 15 minutos a que el servicio las vea listas y termina imprimiendo `<backend>/empezar`: ese es el enlace para los estudiantes. Se puede repetir sin miedo.
- Si algo no queda listo, sale con error y dice qué falta (editor o modelo).
- Si se olvida `terminar`, las VMs se apagan solas: la GPU tras 30 minutos sin trabajos (180 las copias A100 y V100) y la de editores tras 120 minutos sin nadie conectado.

Antes de que entren los estudiantes, abre `<backend>/empezar` y mira «Estado» (la página lee `/api/health`; abrirla también despierta al backend, que en frío tarda en responder):

| Fila | Qué ves | Qué significa |
|---|---|---|
| «Editor en la nube» | «Encendido» | La VM de editores está conectada: listo. |
| | «En reposo» | Apagada, pero se enciende sola cuando un estudiante prepara su editor (1 o 2 minutos). |
| | «Apagado» | Apagada y sin encendido automático: corre `bash deploy/clase.sh iniciar`. |
| | «Configurado» | Túnel con conexión directa al agente: la página no sabe si la VM está encendida; mira `clase.sh estado`. |
| | «Codespaces» | El piloto usa Codespaces: no hay VM de editores que encender. |
| «Tutor (modelo)» | «Disponible» | Al menos un servidor del modelo (GPU o Mac del laboratorio) manda latido. |
| | «Sin equipos» | Los servidores del modelo dejaron de responder: revisa `clase.sh estado`. |
| | «Configurado» | Modelo configurado, todavía sin latidos (por ejemplo, recién encendido). |
| | «Revisar» | La configuración del modelo no es válida: avisa a quien administra el piloto. |
| Cualquiera | «Sin datos» | No se pudo consultar el servicio: recarga en un momento. |

En las Mac del laboratorio, antes de la primera clase, haz doble clic en `Preparar-Mac-ADACEEN.command` en cada equipo (guía rápida, parte *Con VS Code instalado*).

### 4.2 Instalación y cuenta

1. Instala la extensión del navegador como en 1.1.
2. Tu cuenta debe tener rol «Profesor». Pide a quien administra el piloto que la cree antes de tu primer ingreso: si entras con «Continuar con Google» y la cuenta no existe, se crea como estudiante.
3. Inicia sesión (1.2). El overlay muestra «Profesor» y la tarjeta «Politica aplicada». En `github.com` entras al panel, no al tour del estudiante: la acción recomendada es «Panel docente», con «Configuracion» y, en un repositorio, «Abrir en VS Code de este equipo» (mientras no hayas subido la bitácora del curso, es «Subir bitácora»: ver 4.3).
4. Para ver lo que ve un estudiante en el editor en la nube, haz el flujo de 1.4 con una **cuenta de estudiante de prueba** (créala en el punto 6) y un repositorio público: con tu cuenta de docente el overlay no muestra el tour ni «Preparar mi editor». También puedes usar VS Code instalado: descarga la extensión con «Descargar extension de VS Code» en `/empezar` e instálala («Instalar desde VSIX» en la vista Extensiones). No hace falta configurar la dirección del servidor: con `adaceen.backend.baseUrl` vacío, la extensión usa el backend local si corre en ese equipo y, si no, el de producción.
5. Tu cuenta de docente se conecta a VS Code con un código, no con GitHub: en VS Code instalado usa «Abrir en VS Code de este equipo» desde tu repositorio en `github.com`; en `vscode.dev`, «Copiar codigo para VS Code» y luego «ADACEEN: Conectar» → «Tengo un código o sesión» (1.7).
6. En «Administracion de usuarios» puedes crear cuentas de estudiante asignadas a ti: «Agregar usuario», nombre, correo, contraseña temporal (6 caracteres o más) y cursos, y luego «Crear usuario». Es útil para quien use Firefox.

### 4.3 Configurar la política

Abre Configuración (icono de tuerca): desde la 0.7.14 está en secciones que se pliegan («Sesion y tutor», «Politica del tutor», «Quices» y «Codigo desde VS Code»; empiezas en «Politica del tutor»; la sección del piloto ya no está: desde la 0.7.15 el piloto se maneja por terminal, ver 4.7). Ajusta los campos y pulsa «Guardar cambios», siempre visible abajo (verás «Politica docente guardada.»). La política se aplica a tus estudiantes; en VS Code, a los que tienen VS Code conectado con su cuenta (1.5).

| Campo | Valores | Piloto | Efecto |
|---|---|---|---|
| «Nombre de la politica» | 3 a 120 caracteres | RF-05 base del piloto | Se muestra en el resumen del estudiante. |
| «Resultado de aprendizaje» | RA1 a RA5 | RA1 | Se muestra en el resumen y se envía al modelo como resultado de aprendizaje objetivo (overlay y VS Code). El botón «?» de al lado (desde la 0.7.15) explica cada RA: su enunciado y competencia (desde la 0.7.18, tabla de abajo), su peso en la nota del curso (RA1 15 %, RA2 21 %, RA3 29 %, RA4 29 %, RA5 7 %) y cómo se reparte entre parciales, laboratorios y proyecto. |
| «Tono del tutor» | Calido, Directo, Socratico | Calido | Estilo de redacción (overlay y VS Code). |
| «Frecuencia de intervencion» | Baja, Media, Alta | Media | Solo se envía como indicación al modelo del overlay; no cambia cuándo se activa el tutor (1.8). |
| «Nivel de ayuda» | Progresiva, Solo pistas, Ejemplo parcial | Progresiva | Orden de las etapas (2.1). |
| «Maximo de pistas por ejercicio» | 1 o más; vacío = ilimitado | 3 | Tope de pistas por actividad o archivo; con «Cuenta como pista», también es el cupo de aplicaciones de código por archivo. |
| «Bloquear solucion completa» | sí / no | sí | Pide al modelo no dar la solución completa; los límites de código por etapa se aplican siempre. |
| «Intervenciones habilitadas» | Explicacion, Pista, Ejemplo parcial (el mini quiz se habilita con «Permitir mini quiz») | todas | Limita las etapas de 2.1: sin «Ejemplo parcial», la tercera ayuda se queda en Pista 2; sin «Pista», las pistas pasan a explicación breve; si ningún tipo habilitado sirve para el evento, el estudiante recibe el mensaje controlado. |
| «Mensaje controlado» | 10 a 280 caracteres | «No puedo ayudar con ese tema…» | Respuesta ante falta de contexto o consulta fuera del curso. |
| «Nota docente» | hasta 600 caracteres | «Prioriza pistas graduales, preguntas orientadoras y trazabilidad para el piloto.» | Instrucción adicional para el modelo. |
| «Permitir mini quiz» | sí / no | sí | Activa el mini quiz y lo habilita como tipo de intervención (es una sola casilla para las dos cosas). |
| «Cuando sale el mini quiz en VS Code» | «Tras aceptar una sugerencia», «Cuando yo lo lance a la clase», «Si falla, pedir que explique» | las tres | Disparadores y pregunta abierta tras un fallo. |
| «Un quiz cada cuantas sugerencias aceptadas» | 1 a 20 | 1 | Frecuencia del quiz tras aceptar. |
| «Maximo de quices por sesion (vacio = sin limite)» | 1 a 50 | 5 | Tope por ventana de 12 horas. |
| «Permitir aplicar código desde VS Code» | sí / no | sí | Apagado, VS Code muestra el código solo como guía. |
| «Máximo de líneas por aplicación (1 a 200)» | 1 a 200 | 20 | Los cambios más largos no se aplican; el estudiante ve el motivo. |
| «Cuenta como pista» | sí / no | sí | Cada aplicación descuenta del máximo de pistas del archivo. |
| «Pedir confirmación» | sí / no | sí | VS Code pregunta antes de aplicar los cambios que borran código o tienen más de 5 líneas, los que se aplican solos y los reemplazos del overlay que no encuentra donde el estudiante los eligió; en un cambio corto, el clic del estudiante vale como confirmación. |

Resultados de aprendizaje de Fundamentos de Programación Orientada a Objetos (750015C), según el programa del curso. El programa numera RA2.1 a RA5.1; el overlay los llama RA2 a RA5.

| RA | Competencia | Enunciado | Peso |
|---|---|---|---|
| RA1 | C.E.3 | Usa los tipos de datos básicos y los agregados que proporciona el lenguaje, para modelar correctamente los datos de un problema y los atributos de los objetos. | 15 % |
| RA2 (RA2.1) | C.E.3 | Crea nuevos tipos de datos (clases) cuando los que ofrece el lenguaje no son suficientes para modelar el problema. | 21 % |
| RA3 (RA3.1) | C.E.3 | Mapea un problema real en un conjunto de objetos con sus relaciones, usando los 3 tipos de polimorfismo (sobrecarga, subtipado y tipo abstracto de dato) para evitar estructuras condicionales, y para desacoplar objetos. | 29 % |
| RA4 (RA4.1) | C.E.13 | Diseña, documenta, implementa y depura un programa, para minimizar los errores que pueda tener, aumentar su confiabilidad y permitir que otras personas del equipo puedan entender y extender el diseño. | 29 % |
| RA5 (RA5.1) | C.G.4 | Trabaja en equipo, desempeñando unas tareas específicas y comunicando sus ideas, para desarrollar programas. | 7 % |

Temas permitidos y reglas por evento no tienen campos en el overlay: se cambian con `PUT /api/policies/current` (sesión de docente, campos `allowedTopics` y `eventRules`) con apoyo de quien administra el piloto.

- Temas del piloto: RA1 a RA3, IL1 a IL8, clases, objetos, encapsulamiento, herencia, polimorfismo, C++, Python, GitHub y Codespaces. Una pregunta que no los menciona puede recibir el mensaje controlado.
- Reglas: una por evento (`compile_error`, `runtime_error`, `concept_question`, `design_block`, `workflow_guidance`, `insufficient_context`, `out_of_domain`, `code_suggestion`) con `enabled`, `interventionType`, `detailLevel`, `activationThreshold` (1 a 5) y `maxUsesPerSession`. En el piloto: errores, diseño, flujo de trabajo y sugerencias de código → pista; conceptos → explicación breve; falta de contexto y fuera del curso → mensaje controlado.

«Tutor activo» y «Configuracion automatica (archivo principal)» son ajustes de tu navegador, no de la política.

**Bitácora del curso.** Desde la 0.7.16 tiene su pestaña, «Bitácora» (antes era un botón del resumen de sesión que abría una página aparte). Arriba dice si está «Cargada» (con el archivo, las semanas, cuándo se actualizó y, desde la 0.7.17, en qué semana va hoy) o si «Falta»; «Actualizar» vuelve a consultar. Para subirla, arrastra el Excel o el PDF a la zona punteada de la pestaña o pulsa «Subir bitácora (Excel/PDF)» (hasta 12 MB; la nueva reemplaza a la anterior). Desde la 0.7.17 un PDF con una fila por semana (Semana, Fecha, Tema y otra columna, como el que se exporta de Google Sheets) se lee completo: el tema de cada semana, lo que va en la otra columna y cada examen o entrega aparte. «Inicio del semestre» con «Correr fechas» reutiliza la bitácora de otro semestre: la semana 1 queda en la fecha elegida y todas las demás se corren igual (la de FPOO 2025 con inicio el 25 de agosto de 2026 llega hasta el 8 de diciembre); tus estudiantes la ven así en su «Agenda». «Descargar plantilla» da el Excel con las columnas Semana, Fecha, Tema, Clasificación, Actividades en clase y Actividades evaluación; «Exportar bitácora (Excel)» descarga la bitácora cargada con el mismo diseño de la plantilla (se puede volver a subir) y «Exportar bitácora (CSV)» la deja lista para Excel o Power BI. Debajo, plegados: «Semanas cargadas», «Registro manual» («Guardar registro» agrega actividades una a una) y «Borrar datos» («Eliminar bitácora» quita la más reciente y «Borrar todos los datos», todas). En «Inicio», la línea «Bitácora del curso» muestra el mismo estado y lleva a la pestaña. Mientras no la subas, la pestaña lleva un punto naranja y la acción recomendada es «Subir bitácora», que abre la pestaña y el selector de archivo; en un curso de Campus es «Bitacora requerida» y, al subirla, pasa sola a «Analizar Campus». Las fuentes que el tutor cita se administran en la pestaña «RAG» (4.5), a la que también lleva «Configurar RAG».

### 4.4 Quices: lanzar, crear los tuyos y ver los hechos

Desde la 0.7.15 todo esto va en la pestaña «Quices» del panel (4.5); en Configuración → «Quices» solo queda cuándo sale el mini quiz en VS Code.

1. En la pestaña «Quices», campo «Lanzar un quiz a la clase», escribe el tema (mínimo 3 letras, por ejemplo «encapsulamiento») y pulsa «Lanzar quiz». El modelo genera la pregunta con el material del curso; si no responde, la toma del banco validado. No hace falta marcar nada antes: si «Permitir mini quiz» o «Cuando yo lo lance a la clase» estaban sin marcar, el servidor los activa y los guarda, las casillas quedan marcadas y la línea de estado empieza con el aviso («Quiz lanzado. Se activo …»). Si el mini quiz estaba apagado, «Tras aceptar una sugerencia» queda sin marcar.
2. La línea de estado muestra «Activo: "<tema>" (<resultados>).», con las respuestas, las correctas y, si hay, el promedio de las explicaciones sobre 100. El quiz dura 60 minutos o hasta que pulses «Cerrar quiz activo».
3. Tus estudiantes lo ven en VS Code en menos de un minuto (2.4), siempre que tengan VS Code conectado con su cuenta; si no, reciben el del docente por defecto.
4. **Tus propios quices** («Mis quices»): «Crear quiz» abre en otra pestaña del navegador la página `/docente/quices` del backend (la extensión le pasa tu sesión; si no llega, la página pide tu correo y contraseña). Allí escribes el tema, la pregunta, 3 a 5 opciones (marcas la correcta), la explicación y la pregunta abierta de seguimiento, o pulsas «Generar pregunta» para que el modelo la escriba con el material del curso y la corriges; «Guardar en mi banco» la guarda y «Guardar y lanzar» además la manda a la clase. Al volver al overlay, «Actualizar» trae los nuevos; en cada uno, «Lanzar» lo envía a tus estudiantes por 60 minutos (misma regla de activación que el punto 1), «Cerrar» termina el lanzamiento y «Retirar» lo saca del banco (los resultados registrados se conservan).
5. **Quices hechos**: la tabla de la derecha lista los quices respondidos por tus estudiantes, con nombre y correo, tema, origen («Tras aceptar», «Lanzado» o «Mi banco»), resultado (correcta o incorrecta, con la nota de la explicación si la hubo, omitido o sin responder) y fecha; la línea de arriba resume respondidos, correctos, con explicación y omitidos. La misma página `/docente/quices` muestra la lista completa con un buscador.
6. Por API: `POST /api/quiz/launches` con `topic`, `question`, `options` (3 a 5) y `correctIndex` lanza una pregunta tuya; `GET/POST /api/quiz/custom` y `POST /api/quiz/custom/:id/launch` manejan el banco; `GET /api/quiz/attempts` lista los quices hechos.

### 4.5 Panel de la clase y resumen de comportamiento

Desde la 0.7.13 el panel va en pestañas: «Inicio» (contexto, estado de la bitácora, «Politica docente» y resumen de sesión), «Tutor», «Estudiantes», «RAG» (desde la 0.7.14), «Quices» (desde la 0.7.15, ver 4.4), «Bitácora» (desde la 0.7.16, ver 4.3) y «Usuarios». El administrador ve «Inicio», «Estudiantes» y «Usuarios».

- «Estudiantes»: al abrir la pestaña, el overlay pide al backend el progreso de tus estudiantes (`GET /api/admin/students`; el administrador ve a todos) y muestra cinco indicadores del grupo («Estudiantes», «Activos ahora», «Con quices», «Nota promedio» e «Intervenciones») y una tabla con, por estudiante, sesiones (navegador y VS Code), última actividad, intervenciones del tutor (pistas y bloqueadas), quices (correctas/respondidas) y la nota. «Buscar por nombre o correo» filtra sin volver a pedir nada; «Recargar» trae datos nuevos (la lista se reutiliza durante un minuto). Un punto verde marca a quien tiene una sesión viva en los últimos 15 minutos.
- Detalle (clic en el nombre o en la fila): sesiones recientes con su duración, «Quices y calificaciones» (opción elegida, la correcta si falló, nota del seguimiento y comentario), «Intervenciones del tutor» (evento, tipo, política y motivo), «Actividad y ejercicios» (pistas usadas por ejercicio y eventos por categoría) y una línea de tiempo de 14 días. Nunca viajan ids de sesión. «Estudiantes» vuelve a la lista.
- «Nota de quices»: 60 % del porcentaje de aciertos más 40 % del promedio de la pregunta de seguimiento (0 a 100, con su equivalente en la escala 0 a 5); si solo hay uno de los dos, vale ese solo. Alto desde 80, medio desde 60, bajo por debajo. Sale de `student_quizzes`; no reemplaza la calificación del curso.
- «Telemetria reciente» (plegado al final de «Estudiantes», botón «Recargar»): últimas intervenciones de tus estudiantes (nombre, evento, política, tipo y fecha) y métricas de VS Code por tipo de evento. Aparece tras «Explorar repo» o «Analizar Campus», y directamente en `vscode.dev`.
- «RAG» → «RAG por curso»: todos tus cursos, cada uno plegable. Desde la 0.7.15 cada curso tiene una **base** (las fuentes del programa del curso, que salen del material base en Drive, y las que cargaste sin lote) y **lotes**: conjuntos de fuentes con otro enfoque. Solo un lote está activo por curso (selector «Lote activo»; «Base del curso» = sin lote) y eso es lo que reciben tus estudiantes; la cabecera del curso lo dice («Activo: …»). «Nuevo lote» pide nombre, descripción y si «Incluye la base del curso» (con la base, el lote suma sus fuentes a las del programa; sin ella, el estudiante solo recibe las del lote); en cada lote, «Activar en el curso», «Cargar fuente aqui» y «Retirar lote» (sus fuentes quedan guardadas, el curso vuelve a la base y los estudiantes que lo tenían asignado también). «Cargar fuente» sube un archivo a la base o al lote elegido en «Cargar en»; «Material base» abre el material del curso. En cada fuente, «Ver» la abre, «Desactivar» la apaga para tus estudiantes sin borrarla (vale también para las del programa; «Activar» la devuelve) y «Retirar» (solo las tuyas) la saca. «Actualizar» vuelve a pedir cursos, lotes y fuentes. El estudiante nunca ve esta administración: el tutor solo consulta el lote que le aplica y las fuentes encendidas.
- «Usuarios» → «Administracion de usuarios»: cada fila muestra el nombre y el correo completos y, como etiquetas, el rol, el profesor, los cursos, el «RAG aplicado» (desde la 0.7.15: por curso, el lote que recibe ese estudiante; en naranja si se le asignó a él y no al curso) y el estado. «Editar» abre los campos de esa fila (nombre, correo, rol, profesor y cursos) con «Guardar» y «Cancelar»; como docente, también «Lote de RAG aplicado (se guarda al cambiar)»: por cada curso del estudiante eliges «Lote activo del curso» o un lote concreto, y el cambio se guarda al momento. «Eliminar» desactiva la cuenta.
- Quices: la línea de estado de 4.4 da el resultado del último. Por API, `GET /api/quiz/summary` resume todos (tras aceptar y lanzados: respuestas, correctas, porcentaje, promedio de explicaciones y omitidos).

### 4.6 Exportar la telemetría

Solo docentes y administradores. El conjunto está seudonimizado (5.2).

- Desde el repositorio (con Node.js):

  ```bash
  npm run telemetria:exportar -- --url=https://app-adaceen-api-eyder05232002.azurewebsites.net \
    --email=<tu-correo> --password=<tu-clave> --formato=csv --desde=2026-09-01
  ```

  El archivo queda en `exportes/`, que no se sube al repositorio. La contraseña queda en el historial de la terminal: ejecútalo solo en tu equipo y borra el historial, o pide la exportación a quien administra el piloto. `--con-quices` agrega los intentos del mini quiz, pero solo con acceso directo a la base.
- Desde el backend: `GET /api/telemetry/export?format=csv&since=2026-09-01&until=2026-12-15` con la cabecera `x-session-id` de una sesión de docente o administrador; descarga `telemetria-adaceen.csv` (o `.jsonl` con `format=jsonl`).
- Qué significa cada columna: `docs/telemetria/diccionario-eventos.md`.

### 4.7 Piloto con y sin tutor

Desde la 0.7.15 el piloto AB/BA no se maneja desde el overlay (va por dentro, sin botones): la sección de la tuerca desapareció y quien opera el piloto usa la terminal, con la misma cuenta de docente (o de administrador con `--docente=<id>`):

```bash
npm run piloto:bloque -- --url=https://app-adaceen-api-eyder05232002.azurewebsites.net --email=<docente> '--password=<clave>'            # estado
npm run piloto:bloque -- ... --asignar [--semilla=<texto>]   # grupos A y B (opcional: iniciar un bloque los asigna si no existen)
npm run piloto:bloque -- ... --bloque=1                     # bloque 1: grupo A con tutor, B sin tutor
npm run piloto:bloque -- ... --bloque=2                     # bloque 2: al revés
npm run piloto:bloque -- ... --bloque=0                     # terminar: el tutor vuelve para todos
```

Sin tutor, el estudiante solo ve un aviso; sus errores y bloqueos se siguen registrando. La semilla de la asignación queda guardada: anótala en el acta. Detalles en `docs/piloto/protocolo.md`.

### 4.8 Entorno de los estudiantes (docente o administrador)

Con la cuenta de docente o de administrador, la tuerca tiene la sección «Entorno de los estudiantes» (es uno solo para todo el piloto). En «Dónde abren su editor» se elige «Editor en la nube (túnel de VS Code)», «GitHub Codespaces» o «Lo que diga el servidor» (la variable `ADACEEN_WORKSPACE_PROVIDER` de Azure) y se aplica con «Guardar cambios».

- «Activo ahora» dice qué entorno usan los estudiantes y si se eligió en la tuerca o sale del servidor; «Último cambio», cuándo y quién.
- Tu overlay cambia enseguida. El de los estudiantes, al recargar la página o en unos minutos.
- Si «VM de editores» dice «Sin configurar», falta conectar la VM una vez: `bash deploy/produccion.sh aplicar` en Cloud Shell ([despliegue](operacion/despliegue.md)). Mientras tanto no se puede elegir el editor en la nube.
- Con el editor en la nube, la VM de editores tiene que estar encendida para la clase: `bash deploy/clase.sh iniciar` (4.1).

## 5. Privacidad y permisos

### 5.1 Qué datos lee el tutor

| Componente | Qué lee | Cuándo |
|---|---|---|
| Overlay del navegador | De la pestaña activa: dirección, título, texto visible, selección, error visible, código visible, repositorio, rama y archivo; en Campus, actividades y fechas visibles. Al servidor envía dirección, título, repositorio, rama, archivo, selección, error visible, fragmento de código, actividad y fecha, meta y curso. | Lee mientras el overlay está abierto en esa pestaña; envía cuando pides ayuda (y una vez al entrar al panel). |
| «OCR visual» | Una captura de la pestaña del editor, sin el overlay. | Al pulsarlo o tras «Explorar repo», solo con «Configuracion automatica (archivo principal)» activa. |
| «Explorar repo» | Los archivos de código del proyecto (hasta 200, de hasta 300 KB y 3 MB en total), leídos por la extensión de VS Code y guardados como contexto del proyecto. Desde VS Code 0.0.33 no se envía lo que ignora tu `.gitignore` ni archivos con claves o contraseñas (`.env`, llaves `.pem`/`.key`, `credentials.json`, tokens en archivos de configuración). | Solo si aceptas «Dar permiso para leer, modificar y hacer analisis sobre tu entorno?» (se pide una vez) y, desde VS Code 0.0.33, cada vez en VS Code: «Permitir», «Permitir siempre en este repo» o «No» (sin respuesta en 2 minutos, no se envía nada). |
| Extensión de VS Code | Ruta del archivo activo, un recorte de su contenido (hasta 7.200 caracteres), la selección (hasta 20 líneas), las líneas visibles, la línea del cursor, errores del editor y un mapa del proyecto (nombres de archivos y carpetas). El servidor usa como máximo 12.000 caracteres de ese bloque. | Con cada sugerencia (1.8). |
| GitHub | OAuth de ADACEEN: tu usuario y correo, con los permisos que fija el piloto (recomendados: `repo codespace read:user user:email`). Con Codespaces, además la GitHub App (repositorio, ramas y PR; permisos exactos por verificar). | Al pulsar «Conectar GitHub» y al preparar el entorno. |
| «Con mi cuenta de GitHub» en VS Code | VS Code entrega al backend un permiso de GitHub (`read:user`). El backend lo usa **una sola vez** para leer tu usuario de GitHub y buscar tu cuenta de ADACEEN; no lo guarda ni lo registra. | Solo al conectar VS Code con esa opción (o en silencio al arrancar, si ya le diste permiso antes). |
| Google | Correo y nombre al entrar con Google. Calendar: permiso `calendar.events` para crear eventos «ADACEEN entrega: …» con las fechas de las actividades; el código no lee tus otros eventos. | Al pulsar «Continuar con Google»; Calendar, al pulsar «Sincronizar agenda». |
| Máquina del túnel | Tu repositorio clonado en el usuario `ws-<tu-usuario>` y tu sesión del editor en `/home/ws-<tu-usuario>/.adaceen/editor-session.json`: el ID de una sesión de ADACEEN solo para VS Code, la dirección del backend, su vencimiento, tu nombre y tu correo. El archivo solo lo puede leer tu usuario (permisos 600). | Desde que preparas el entorno hasta que se borra tu usuario. La sesión se escribe en cada «Preparar mi editor» o «Abrir mi editor» que pasa por la preparación, vence a los 30 días y se renueva cuando le quedan 7 días o menos. |
| Equipo con VS Code instalado | Tu repositorio clonado en la carpeta que elegiste, y la sesión de VS Code en el almacenamiento de secretos de VS Code, no en los ajustes. | Hasta que borres la carpeta o desconectes; la sesión vence a los 30 días. |
| Servidor del modelo (GPU de Google Cloud o Mac del laboratorio) | La pregunta del tutor: el fragmento de código, el error visible y la instrucción. La procesa en memoria y no la guarda; su registro solo tiene tamaños y un hash. | Con cada ayuda. |

### 5.2 Qué se guarda

- Telemetría del piloto (`telemetry_events`, versión 1.1): seudonimizada con HMAC; sin textos de error (solo su hash), sin código, sin rutas (solo hash y extensión del archivo) y sin correos. Es lo que se exporta y se conserva 365 días por defecto. Detalle: `docs/telemetria/diccionario-eventos.md`.
- Registros de operación que sí te identifican y no se exportan tal cual: sesión y política, intervenciones del overlay (tu id y un resumen del contexto), eventos con sesión (tu id y la ruta del archivo), intentos del mini quiz (pregunta, respuestas, explicación y el código antes y después del cambio aceptado, hasta 3.000 caracteres de cada uno; se exportan con el actor seudonimizado y sin el código), el contexto del proyecto si usaste «Explorar repo» y las capturas del OCR.
- Privacidad: la versión de la política que aceptaste y la fecha de la primera aceptación (tabla `user_privacy_acceptances`), para no volver a preguntarla en otro navegador. `npm run piloto:retiro` la borra con el resto de tus datos.
- Sesiones de VS Code: cada conexión crea una sesión de tipo editor que vence a los 30 días; el servidor deja activas como mucho 10 por persona. Los códigos `XXXX-XXXX` se guardan solo como hash (SHA-256), sirven una vez y vencen a los 10 minutos.
- En tu navegador (almacenamiento de la extensión): sesión, preferencias, id anónimo (`adaceenClientId`), la dirección de tu editor por repositorio (`adaceenEditorByUser`, que incluye tu usuario de GitHub en `ad-<tu-usuario>` y `ws-<tu-usuario>`; se conserva al pulsar «Salir», a propósito, para ofrecer «Abrir mi editor» al volver, y solo se borra al quitar la extensión: en un equipo compartido queda en ese navegador) la última elección de editor (`adaceenEditorChoiceByUser`: VS Code de este equipo o editor en la nube) y, mientras dura la espera, el código de GitHub del editor (`adaceenDeviceCodeHandoff`, como mucho 15 minutos; se borra al salir).
- Política de privacidad: `https://app-adaceen-api-eyder05232002.azurewebsites.net/privacy-policy`.

### 5.3 Cómo revocar permisos

1. Pausar: Configuración → desmarca «Tutor activo» → «Guardar cambios».
2. Cerrar sesión: «Salir» cierra tu sesión en el servidor **y** desactiva todas tus sesiones de VS Code (la del túnel y las de otros equipos): VS Code avisa una vez que la sesión dejó de valer. El archivo `editor-session.json` sigue en la máquina del túnel, pero ya no sirve; el próximo «Abrir mi editor», en cualquier navegador y después de volver a entrar, escribe uno nuevo.
3. VS Code instalado: «ADACEEN: Conectar» → «Desconectar este equipo» olvida la sesión guardada en ese equipo.
4. Quitar las extensiones: en `chrome://extensions` (o `edge://extensions`) quita ADACEEN; se borran su sesión y preferencias locales. En Firefox, desde `about:addons`. En VS Code, vista Extensiones → ADACEEN → desinstalar o deshabilitar; en el túnel la extensión es de la máquina y se reinstala al reiniciar el servicio (por verificar), así que cerrar la pestaña de `vscode.dev` es lo que detiene la lectura.
5. GitHub, Settings → Applications:
   - «Authorized OAuth Apps»: revoca la app OAuth de ADACEEN y, si ya no usarás el túnel ni «Con mi cuenta de GitHub», la de Visual Studio Code (nombres exactos por verificar).
   - «Installed GitHub Apps» (solo si usaste Codespaces): en la GitHub App de ADACEEN (nombre exacto por verificar), «Configure» → quita tu repositorio o desinstálala. Borra a mano la rama o el PR de configuración si ADACEEN llegó a crearlos.
6. Google: Cuenta de Google → Seguridad → acceso de terceros (nombre exacto por verificar) → ADACEEN → quitar el acceso. Los eventos ya creados («ADACEEN entrega: …») no se borran solos.
7. Máquina del túnel: pide a tu docente que solicite a quien administra la máquina borrar tu usuario `ws-<tu-usuario>`. Eso elimina tu copia del proyecto y el archivo de sesión, y detiene el túnel `ad-<tu-usuario>`.
8. Datos del servidor: para pedir acceso, corrección o borrado, usa el canal definido por el docente del curso.

## 6. Validación (indicador A16.8)

El indicador pide instalación en 15 minutos o menos siguiendo esta guía y la validación del docente o del director. Cómo medir: cronometra desde que se abre `<backend>/empezar` hasta que la barra de estado de VS Code muestra «ADACEEN: <tu nombre>» (VS Code conectado con su cuenta), sin más ayuda que la guía. Es el mismo fin que V10 de `docs/piloto/validacion-director.md` y la hora `editor_listo` de `data/piloto/plantillas/tiempos-instalacion.csv`; así el tiempo no depende de que el servidor del modelo esté encendido. Después revisa las demás casillas de *Cómo sé que quedó bien* y anota en observaciones las que fallen. Anota una fila por persona y el camino (túnel o Mac).

| Quién validó (nombre y rol) | Fecha | Camino, navegador y sistema | Tiempo real de instalación (min) | ¿15 min o menos? | Observaciones (paso más lento, errores) |
|---|---|---|---|---|---|
| | | | | | |
| | | | | | |
| | | | | | |

Visto bueno del docente o del director: ______________________  Fecha: ____________

Puntos por verificar en la primera validación:

- Textos de servicios externos: el botón de autorización de la app OAuth de ADACEEN en GitHub, la página `github.com/login/device`, el botón de GitHub en `vscode.dev`, los nombres de las apps en «Authorized OAuth Apps» e «Installed GitHub Apps», la ruta de acceso de terceros en la cuenta de Google y «Este Firefox».
- Navegador real (hasta ahora solo se probó con una simulación): el paso de la ventana del OAuth a `github.com/login/device` y luego a `vscode.dev`; el aviso con el código y su copia automática; la detección de la extensión en `/empezar`; desde la 0.7.12, la entrada con el icono sin «Empezar», que otro navegador no vuelva a pedir «Aceptar y continuar» y ofrezca «Abrir mi editor», y (con Codespaces) que la GitHub App se detecte sola al cerrar su pestaña.
- Mac real: `Preparar-Mac-ADACEEN.command` (Gatekeeper, instalación de `git` y de VS Code), la pregunta de VS Code para abrir el enlace `vscode://` y el botón «Abrir en VS Code de este equipo» en Chrome, Edge y Brave. Cronometrar también este camino.
- «Continuar con Google» y Google Calendar en Edge y Brave; firma del paquete de Firefox para una instalación permanente.
- Si la extensión de VS Code se reinstala en el túnel tras desinstalarla, y qué versión está publicada en el Marketplace (`adaceen.adaceen`).
