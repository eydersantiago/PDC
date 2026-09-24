# Guía de instalación y uso de ADACEEN

Manual breve para estudiantes y docentes del piloto (Jira A16.8, ADACEEN-150). Describe la extensión de navegador 0.7.8 (2026-09-24), la extensión de VS Code 0.0.28 y el editor en `vscode.dev` por túnel de VS Code.

- Los textos entre comillas angulares («…») son los de la interfaz, copiados tal cual; algunos van sin tilde porque así están en esta versión.
- Lo marcado «por verificar» no se pudo confirmar en el código: revísalo en la validación (sección 6).
- Para dudas y fallos usa el canal definido por el docente del curso.

## Guía rápida para estudiantes (15 minutos o menos)

Antes de empezar ten a mano:

- Google Chrome actualizado (también sirven Edge, Brave o Firefox 128+, con las limitaciones de 1.1).
- El archivo `adaceen-chromium-<versión>.zip` (o `adaceen-firefox-<versión>.zip`) que te entregó tu docente.
- Tu acceso a ADACEEN: tu cuenta de Google institucional, o el correo y la contraseña que te dio tu docente.
- Tu usuario de GitHub (el nombre de usuario, no el correo) y un repositorio **público** con tu ejercicio.

| # | Qué haces | Tiempo |
|---|---|---|
| 1 | Descomprime el zip en una carpeta que no vayas a borrar. Abre `chrome://extensions`, activa «Modo desarrollador», pulsa «Cargar descomprimida», elige esa carpeta y fija el icono de ADACEEN en la barra. | 3 min |
| 2 | Abre tu repositorio en `github.com`, pulsa el icono de ADACEEN y luego «Empezar». Entra con «Continuar con Google» o con «Correo», «Contrasena» y «Entrar». Pulsa «Aceptar y continuar» y elige tu curso con «Practicar este curso». | 2 min |
| 3 | En «Preparar repositorio» pulsa, en orden: «Autodetectar», «Autorizar repositorio», «Abrir instalacion» (instala la GitHub App solo en tu repositorio), «Verificar acceso», «Preparar entorno» y «Conectar GitHub para Codespace» (autoriza a ADACEEN en GitHub). | 3 min |
| 4 | Si no arrancó solo, pulsa «Preparar editor en la nube» y «Entendido». En la pestaña nueva aparece un código: abre `https://github.com/login/device`, escríbelo y autoriza. Espera a que cargue `https://vscode.dev/tunnel/ad-<tu-usuario>/...`. | 3 min |
| 5 | Si `vscode.dev` te pide iniciar sesión, elige **GitHub**, nunca una cuenta Microsoft. | 1 min |
| 6 | En el overlay, panel «Contexto de trabajo», pulsa «Copiar sesion». En VS Code pulsa `F1`, ejecuta «ADACEEN: Configurar sesión compartida», pega y pulsa Enter. | 2 min |
| 7 | Abre un archivo de tu proyecto, selecciona unas líneas y espera la ventana flotante de ADACEEN. | 1 min |

Cómo sé que quedó bien:

- [ ] El encabezado del overlay muestra tu nombre y «Estudiante | tutor contextual».
- [ ] La dirección es `https://vscode.dev/tunnel/ad-<tu-usuario>/home/ws-<tu-usuario>/proyecto` y ves tus archivos.
- [ ] La barra de estado de VS Code muestra «ADACEEN: <archivo>» y «GPU: …». Si dice «GPU: sin worker activo», la instalación está bien pero el modelo está apagado (ver 3.1).
- [ ] El panel «Contexto de trabajo» del overlay dice «VS Code conectado».
- [ ] Al seleccionar código aparece la ventana «Sugerencia para la seleccion» (mientras espera dice «consultando al backend»).

Si un paso falla, busca el mensaje en la sección 3.1.

## 1. Estudiantes

### 1.1 Instalar la extensión del navegador

Chrome, Edge o Brave:

1. Descomprime `adaceen-chromium-<versión>.zip` (hoy `adaceen-chromium-0.7.8.zip`) en una carpeta fija. El navegador carga la extensión desde allí: si la mueves o la borras, deja de funcionar.
2. Abre `chrome://extensions` (en Edge `edge://extensions`, en Brave `brave://extensions`).
3. Activa «Modo desarrollador» (en inglés, "Developer mode").
4. Pulsa «Cargar descomprimida» ("Load unpacked") y elige la carpeta que contiene `manifest.json`. Estos nombres pueden variar según el navegador y el idioma.
5. En el menú de extensiones (icono de pieza de rompecabezas) fija ADACEEN. Recarga las pestañas de GitHub o Campus que ya tenías abiertas.

En Edge y Brave, «Continuar con Google» y la sincronización con Google Calendar pueden fallar porque dependen de `chrome.identity.getAuthToken`, una función de Chrome (por verificar). Si fallan, entra con correo y contraseña.

Firefox (versión 128 o superior):

1. Abre `about:debugging`, entra en «Este Firefox» (nombre exacto por verificar) y pulsa «Cargar complemento temporal…».
2. Elige `adaceen-firefox-<versión>.zip` (o el `manifest.json` de la carpeta descomprimida).
3. Ten en cuenta:
   - Un complemento temporal se quita al cerrar Firefox: debes cargarlo de nuevo en cada sesión. Una instalación permanente exige un paquete firmado por Mozilla (por verificar: hoy no lo está).
   - No hay inicio de sesión con Google ni Google Calendar: Firefox no tiene `chrome.identity.getAuthToken` y el overlay muestra «Chrome Identity API no disponible.». Entra con correo y contraseña.
   - Si el overlay no aparece en un sitio del piloto, revisa en `about:addons`, ADACEEN, que los permisos de esos sitios estén concedidos.

### 1.2 Iniciar sesión

1. Abre un sitio del piloto: tu repositorio en `github.com`, Campus Virtual (`campusvirtual.univalle.edu.co`) o tu editor en `vscode.dev`.
2. Pulsa el icono de ADACEEN. Aparece el overlay con «ADACEEN listo»; pulsa «Empezar».
3. Pulsa «Continuar con Google» (solo Chrome) o escribe «Correo» y «Contrasena» y pulsa «Entrar». Usa la cuenta que te indicó tu docente. Si tu cuenta no existía y entras con Google, se crea como estudiante del docente por defecto: si en «Mis parametros asignados» no ves la política de tu docente, avísale.
4. La primera vez aparece «Acepta la politica de privacidad»: léela y pulsa «Aceptar y continuar».
5. En «Elige el curso que quieres reforzar» marca tu curso y pulsa «Practicar este curso». El tutor usará el material autorizado de ese curso.

Para cerrar la sesión pulsa «Salir» (encabezado del overlay) o «Cerrar sesion» (Configuración).

### 1.3 Usar el overlay

El overlay es una ventana flotante que ADACEEN pone sobre la página. No aparece solo: sale cuando pulsas el icono y se mantiene en las páginas siguientes hasta que lo cierras con «×» o `Escape`; «−» lo minimiza. Partes principales:

- «Accion recomendada»: el siguiente paso según la página (por ejemplo «Preparar entorno ADACEEN»).
- «Mis parametros asignados»: la política de tu docente (tono, frecuencia, nivel de ayuda, pistas).
- «Hoy quiero reforzar»: elige una meta («Clases y objetos», «Encapsulamiento», «Herencia y polimorfismo», «Resolver errores», «GitHub y Codespaces»); al elegirla, el tutor responde de nuevo.
- «Pistas de hoy» y «Siguiente paso»: la respuesta del tutor (sección 2). «Fuentes RAG usadas»: el material del curso que la respalda (2.2).
- «¿Te sirvió esta ayuda?»: pulsa «Me sirvió» o «No me sirvió»; así tu docente sabe qué ayuda funciona. «Ver fragmento detectado» muestra lo que ADACEEN leyó de la página.
- En el editor, «Explorar repo» lee los archivos del proyecto para dar más contexto (pide permiso la primera vez, ver 5.1). En Campus el botón es «Analizar Campus»: abre un curso y pulsa antes «Verificar acceso»; «Sincronizar agenda» guarda las fechas de las actividades en tu Google Calendar (solo Chrome).
- Configuración (icono de tuerca): «Tutor activo», «Configuracion automatica (archivo principal)» y «Base URL del backend» (no la cambies salvo que tu docente lo indique). Guarda con «Guardar cambios».

Teclado: `Tab` recorre los controles; `Escape` cierra la capa abierta y luego el overlay; `Ctrl+Enter` (`Cmd+Enter` en macOS) pide ayuda, igual que el botón «Actualizar».

### 1.4 Preparar el entorno (VS Code en el navegador)

Tu editor es VS Code real en `vscode.dev`, conectado por un túnel a una máquina en la nube donde ADACEEN clona tu repositorio. Se hace una vez por repositorio:

1. Abre tu repositorio en `github.com` con el overlay abierto y la sesión iniciada.
2. En «Preparar repositorio» sigue los tres pasos:
   - «Paso 1 de 3»: confirma el repositorio con «Autodetectar» (o escribe `owner/repo`) y pulsa «Autorizar repositorio».
   - «Paso 2 de 3»: pulsa «Abrir instalacion», instala la GitHub App en tu repositorio (verás «GitHub App conectada correctamente.»), vuelve, pulsa «Verificar acceso» y luego «Preparar entorno».
   - «Paso 3 de 3»: pulsa «Conectar GitHub para Codespace» y autoriza a ADACEEN en GitHub. Con el túnel no se crea ningún Codespace: el nombre del botón es heredado.
3. ADACEEN suele continuar solo; si no, pulsa «Preparar editor en la nube» (o «Preparar entorno ADACEEN» en «Accion recomendada»). En el aviso «Esto puede tardar cerca de 2 minutos» pulsa «Entendido».
4. Se abre una pestaña de espera. La primera vez muestra «Codigo de autorizacion: XXXX-XXXX» (el overlay también dice «Autoriza tu editor: codigo …»). Abre `https://github.com/login/device` (la pestaña trae el enlace), escribe el código **una sola vez** y autoriza con **la misma cuenta de GitHub** que conectaste en ADACEEN. El código vence en unos 15 minutos y ADACEEN espera hasta 12.
5. Cuando el editor está listo verás «Editor listo. Redirigiendo...» y se abrirá `https://vscode.dev/tunnel/ad-<tu-usuario>/home/ws-<tu-usuario>/proyecto`. Si no se abre, usa «Abrir editor» en el overlay. Guarda esa dirección en tus marcadores.
6. Si `vscode.dev` pide iniciar sesión para entrar al túnel, elige **GitHub** (texto exacto del botón por verificar). Con una cuenta Microsoft, `vscode.dev` dirá que no encuentra el túnel ("not found").

Datos útiles:

- El túnel se llama `ad-<tu-usuario>`: `ad-` más los primeros 17 caracteres de tu usuario de GitHub, en minúsculas.
- Solo se clonan repositorios públicos, y hay un proyecto por estudiante. Para cambiar de repositorio hay que rehacer el entorno: con la sesión en el panel principal, Configuración → «Ajustes avanzados GitHub App» → «Rehacer PR devcontainer» (con el túnel rehace el editor y guarda la copia anterior como respaldo; flujo completo por verificar), o pídeselo a tu docente.
- La máquina de editores se apaga sola tras un tiempo sin uso (2 horas por defecto). Si al volver el editor no carga, pulsa otra vez «Preparar entorno ADACEEN».
- Si tu docente indica que el piloto usa Codespaces en vez del túnel, los mismos botones crean un PR de configuración y abren un Codespace; el resto de la guía aplica igual.

### 1.5 Usar la extensión de VS Code

En tu editor de `vscode.dev` la extensión ADACEEN ya viene instalada (la instala la máquina del túnel). Solo tienes que conectarla con tu sesión:

1. En el overlay, panel «Contexto de trabajo», pulsa «Copiar sesion».
2. En VS Code pulsa `F1` (o `Ctrl+Shift+P`), ejecuta «ADACEEN: Configurar sesión compartida», pega y pulsa Enter. Sin este paso el tutor funciona, pero aplica la política del docente por defecto y tus quices no quedan asociados a tu cuenta.
3. Abre un archivo. El panel del overlay debe pasar a «VS Code conectado».

Dónde aparece la ayuda:

- Barra de estado: «ADACEEN: <archivo>» (un clic abre el panel) y «GPU: <origen>» (por ejemplo «GPU: Google Cloud - L4»), que indica si el modelo está disponible.
- Sobre la línea (CodeLens): «ADACEEN: <resumen>» y, si puedes aplicar el cambio, «Aceptar ayuda: Insertar», «Aceptar ayuda: Modificar» o «Aceptar ayuda: Eliminar».
- Ventana flotante al seleccionar código («Sugerencia para la seleccion»): la recomendación, el código propuesto y las acciones «Insertar debajo», «Modificar seleccion», «Eliminar seleccion», «Ver panel» y «Otra sugerencia»; la recomendada va en negrita con «(recomendada)». Analiza hasta 20 líneas.
- Al pasar el ratón sobre la línea: la sugerencia, «Ver panel», «Aceptar ayuda: …» y la fuente del material. Con el arreglo rápido (`Ctrl+.`): «ADACEEN: Aceptar ayuda - agregar debajo (recomendado)» y variantes.
- Barra de actividades → ADACEEN → «Quiz y seguimiento»: mini quiz e «Historial» de recomendaciones. Puedes arrastrarlo a la barra lateral derecha o al panel inferior.
- El overlay sobre `vscode.dev` también muestra el resumen del archivo y la sugerencia de línea; si eliges ahí una opción de reemplazo, VS Code la aplica con las mismas reglas.

Aplicar un cambio:

1. Pulsa «Aceptar ayuda» o una acción de la ventana flotante.
2. ADACEEN pregunta al servidor si tu docente lo permite. Si pide confirmación verás «ADACEEN: ¿Aplicar el cambio del tutor en <archivo>?» con el número de líneas: pulsa «Aplicar», o cierra para cancelar.
3. Todo se deshace con `Ctrl+Z`. Si la política no lo permite verás el motivo y el código queda como guía (2.3).
4. Después puede aparecer un mini quiz en «Quiz y seguimiento» (2.4).

### 1.6 Activación bajo demanda

Nada se aplica en tu archivo sin tu clic. Lo que activa al tutor, según el código actual:

| Dónde | Se activa solo | Lo pides tú |
|---|---|---|
| Overlay | El overlay no se abre solo: aparece al pulsar el icono. Abierto, el tutor responde una vez al iniciar sesión o entrar al panel. | «Actualizar» (`Ctrl+Enter`) o una meta de «Hoy quiero reforzar». |
| VS Code | Cursor quieto 3 s (`cursor_idle`); selección quieta 1,2 s (`selection`); primera consulta al abrir un archivo (`file_open`); bloqueo: el mismo error 90 s o 3 veces en 10 min (`blocking`). «Aceptar ayuda» aparece tras unos 10 s con el cursor quieto (unos 2 s si seleccionaste). | «ADACEEN: Actualizar sugerencias del archivo activo» u «Otra sugerencia»; «ADACEEN: Abrir panel de quiz y seguimiento» o clic en «ADACEEN» de la barra de estado. |

Para que intervenga menos:

- Overlay: Configuración → desmarca «Tutor activo» → «Guardar cambios» (verás «El tutor esta pausado. Puedes reactivarlo en configuracion.»).
- VS Code (Configuración, busca `adaceen`): `adaceen.triggers.suggestOnBlocking` en `false` evita la consulta automática por bloqueo; `adaceen.suggestions.selectionWidget` en `false` quita la ventana flotante.
- Esta versión no tiene un modo «solo bajo demanda» en VS Code: `adaceen.suggestions.enabled` en `false` apaga también las consultas manuales.

## 2. Cómo interpretar las respuestas

### 2.1 Etapas de ayuda

Con el nivel «Progresiva» (el del piloto), cada ayuda en el mismo ejercicio (la misma actividad de Campus o el mismo archivo) sube de etapa:

| Etapa | Cuándo aparece | Qué trae | Qué hacer |
|---|---|---|---|
| Pista 1 | Primera ayuda del ejercicio. | Dónde mirar (línea, concepto o mensaje de error) y una pregunta guía. Sin código en el overlay («codigo omitido: en esta etapa la ayuda es solo una pista»). | Responde la pregunta tú y da el paso pequeño que propone. |
| Pista 2 | Segunda ayuda. | La causa probable y el concepto del curso; como máximo 2 líneas de pseudocódigo, nunca tu código corregido. | Revisa tu código con ese concepto y comprueba como te indica. |
| Ejemplo parcial | Tercera ayuda. | El patrón en otro dominio y con otros nombres (máximo 8 líneas) y un `TODO` para completar. | Adáptalo a tu ejercicio: no sirve pegarlo tal cual. |
| Explicación breve | Preguntas de concepto («¿qué es el polimorfismo?»). | Definición corta, por qué importa, un ejemplo de hasta 4 líneas y la cita del material. | Úsala para entender y vuelve a tu código. |
| Mensaje controlado | Falta contexto, la consulta está fuera del curso o la política no permite ayudar. | El mensaje de tu docente (en el piloto: «No puedo ayudar con ese tema o con tan poco contexto. Muestrame el ejercicio, el error o un fragmento del codigo del curso.») y un «Motivo de control». | Agrega el enunciado, el error visible o selecciona el fragmento, y vuelve a pedir ayuda. |

- Con «Solo pistas» verás Pista 1 y luego Pista 2; con «Ejemplo parcial», Pista 1 y luego Ejemplo parcial.
- Al llegar al máximo de pistas del ejercicio (3 en el piloto) el overlay responde «Ya alcanzaste el limite de pistas definido por el docente para este ejercicio (3).»: intenta el siguiente paso por tu cuenta.
- En VS Code la ayuda se gradúa por tamaño del cambio: hasta 5 líneas, luego 10 y luego el máximo de tu docente. Al agotar las aplicaciones del archivo verás «Ya usaste las 3 ayudas con codigo que tu docente permite para este archivo. Intenta el siguiente paso por tu cuenta.».

### 2.2 Citas del material autorizado

- Las pistas terminan con una etiqueta como `[RAG-FPOO-15#c1]` o `[RAG-FPOO-15#c1 p.3]`: `RAG-FPOO-15` es la fuente (material autorizado del curso FPOO), `#c1` el fragmento usado y `p.3` la página.
- La etiqueta del texto no es un enlace. Búscala en «Fuentes RAG usadas» (título, curso, «RAG principal» o «Suplementario» si viene de la bitácora, página y etiqueta) y pulsa «Abrir parte usada»: el fragmento exacto se abre en otra pestaña.
- En VS Code pasa el ratón sobre la sugerencia: «Fuente RAG: …» (o «Contexto suplementario: …») y el enlace «Abrir fuente o detalle». También sirve «ADACEEN: Ver fuente RAG».
- Una pista sin cita no se apoyó en el material del curso: contrástala con tus apuntes o con tu docente.

### 2.3 «Aplicar» en VS Code y por qué a veces no aparece

«Aplicar» es cualquier acción que escribe en tu archivo: «Aceptar ayuda: …», «Insertar debajo», «Modificar seleccion», «Eliminar seleccion», el arreglo rápido o el botón «Aplicar» de la confirmación.

| Lo que ves | Por qué | Qué hacer |
|---|---|---|
| No hay «Aceptar ayuda» ni botones en la ventana flotante; dice «solo guia» o «Usa el codigo como guia y escribelo tu.» | Tu docente desactivó la aplicación de código, o la respuesta es un mensaje controlado. | Escribe el cambio tú. |
| «El cambio tiene N lineas y tu docente permite aplicar como maximo M. Aplica una parte y escribe el resto tu.» | El cambio es más largo de lo permitido (20 líneas en el piloto). Si el servidor recortó el código, quita la opción de aplicar. | Aplica una parte o escríbelo tú. |
| «Ya usaste las N ayudas con codigo…» o «Te quedan N aplicaciones en este archivo.» | Cada aplicación cuenta como pista y el cupo del archivo se agotó (o está por agotarse). | Sigue por tu cuenta o consulta a tu docente. |
| «pista local (el backend no respondio)» | El servidor no respondió; las pistas locales no se aplican. | Pide «Otra sugerencia» más tarde. |
| «No se pudo confirmar con el servidor si puedes aplicar este cambio…» | Sin conexión solo se aplican cambios de hasta 12 líneas (`adaceen.codeApplication.offlineMaxLines`). | Revisa tu conexión y reintenta. |

### 2.4 Mini quiz

- Cuándo: después de aplicar una sugerencia (en el piloto, cada vez, con un máximo de 5 por sesión de 12 horas) o cuando tu docente lanza uno a la clase.
- Dónde: VS Code → ADACEEN → «Quiz y seguimiento». Si tu docente lanza uno verás «ADACEEN: tu docente lanzo un quiz sobre "<tema>".»: pulsa «Responder». El panel revisa cada 30 s; también puedes pulsar «Buscar quiz del docente» o ejecutar «ADACEEN: Buscar quiz del docente».
- Formato: una pregunta de opción múltiple (normalmente 4 opciones, de A a D) sobre qué hace el cambio o por qué es correcto. Al responder verás «Correcto.» o «No es esa.» y la explicación.
- Si fallas y tu docente activó la pregunta de seguimiento, escribe en «Explicalo con tus palabras...» y pulsa «Enviar explicacion». El modelo la califica de 0 a 100 con un comentario; si no puede, verás «Tu respuesta quedo guardada. No pude calificarla ahora; tu docente podra revisarla.». «Omitir» salta la pregunta y «Listo» la cierra.
- Si el modelo no está disponible, la pregunta sale de un banco de preguntas validadas del curso (`data/quiz/banco-fpoo.json`), así que el quiz funciona aunque el servidor del modelo esté apagado.

## 3. Si algo falla

### 3.1 Problemas frecuentes

| Lo que ves | Causa probable | Qué hacer |
|---|---|---|
| `vscode.dev` dice que no encuentra el túnel ("not found"). | Entraste a `vscode.dev` con una cuenta Microsoft, o autorizaste el código con otra cuenta de GitHub. | En el menú de cuentas de `vscode.dev` (icono de persona, abajo a la izquierda) cierra la sesión Microsoft y entra con GitHub, la misma cuenta que conectaste. Si autorizaste con otra cuenta, avisa a tu docente para reiniciar tu entorno. |
| «El codigo XXXX no se autorizo a tiempo. Pulsa "Preparar entorno" de nuevo para recibir otro.» | El código de GitHub venció. | Pulsa «Preparar entorno ADACEEN» y usa el código nuevo. |
| «No se pudo clonar el repositorio: no existe o es privado…» | El túnel solo clona repositorios públicos. | Haz público el repositorio o consulta a tu docente. |
| «La cuenta de GitHub <usuario> no esta en la lista del piloto. Pide al docente que la agregue.» | Tu usuario no está autorizado en el piloto. | Pide a tu docente que lo agregue. |
| «No se pudo contactar la VM de editores (puede estar apagada)…» o `vscode.dev` no conecta. | La máquina de editores está apagada. | Reintenta en un momento; si sigue, avisa a tu docente. |
| «Tu editor ya tiene clonado <repositorio>…» | Ya tienes otro repositorio en el túnel. | Rehaz el entorno (1.4, «Datos útiles»). |
| «El tutor no esta disponible en este momento: el servidor del modelo no respondio.», «GPU: sin worker activo» o «Se usa apoyo local por ahora.» | El servidor del modelo (GPU) está apagado u ocupado; se enciende para las sesiones del curso. | Intenta más tarde. «ADACEEN: Ver de donde sale la GPU» muestra el estado. Si pasa en clase, avisa a tu docente. |
| No aparece «Aceptar ayuda». | Política del docente, cambio muy largo, cupo agotado o todavía no pasan unos 10 s con el cursor quieto. | Ver 2.3 y 1.6. |
| «Ya hay una sesión activa» o «Sesion activa en otra pestaña: …» | El overlay de tu sesión está abierto en otra pestaña. | Ciérralo allí (× o `Escape`) o cierra esa pestaña y pulsa «Revisar nuevamente». |
| «VS Code aun no publico contexto» o «Esperando extension VS Code». | VS Code no está conectado con tu sesión o no hay un archivo abierto. | Repite 1.5 y abre un archivo. |
| «Conecta tu cuenta de GitHub en ADACEEN…» o «Tu conexion con GitHub ya no es valida…» | Falta la autorización de GitHub o la revocaste. | Pulsa «Conectar GitHub» y autoriza de nuevo. |
| «Chrome Identity API no disponible.» | Firefox (u otro navegador sin esa función). | Entra con correo y contraseña. |
| «La cuenta de Google no pertenece al dominio permitido.» | El piloto solo acepta el dominio institucional. | Usa tu cuenta institucional o pide credenciales a tu docente. |
| «Primero tienes que salir de la sesion activa.» | Hay otra cuenta con la sesión abierta. | Pulsa «Salir» y vuelve a entrar. |
| Al pulsar el icono no pasa nada. | La pestaña se abrió antes de instalar la extensión, o es una página interna (`chrome://…`). | Recarga la página o abre un sitio del piloto. |
| En Firefox la extensión desapareció. | Los complementos temporales se borran al cerrar Firefox. | Cárgala de nuevo (1.1). |

### 3.2 Cómo reportar un error

«Me sirvió» y «No me sirvió» sirven para opinar sobre una respuesta, no para reportar fallos. Para un fallo escribe por el canal definido por el docente del curso e incluye:

1. Fecha y hora aproximada, dónde estabas (Campus, GitHub, `vscode.dev` o VS Code) y qué estabas haciendo, paso a paso.
2. Qué esperabas que pasara y qué pasó, con el mensaje exacto (cópialo) y una captura de pantalla.
3. Navegador y versión; versión de la extensión (se ve en la vista «Inicia sesion», por ejemplo «Browser v0.7.8 - 2026-09-24») y de la extensión de VS Code (vista Extensiones, ADACEEN).
4. Tu usuario de GitHub, si el problema es del editor o del túnel.
5. Si te lo piden, las líneas relevantes de VS Code en «Output» → «ADACEEN».

Nunca incluyas contraseñas, tokens de GitHub o Google, el código que copias con «Copiar sesion» ni el código de `github.com/login/device`. Tapa esos datos si salen en una captura. (Desde esta versión los enlaces de «Abrir parte usada» ya no llevan tu sesión en la dirección.)

## 4. Docentes

### 4.1 Instalación y cuenta

1. Instala la extensión del navegador como en 1.1.
2. Tu cuenta debe tener rol «Profesor». Pide a quien administra el piloto que la cree antes de tu primer ingreso: si entras con «Continuar con Google» y la cuenta no existe, se crea como estudiante.
3. Inicia sesión (1.2). El overlay muestra «Profesor» y la tarjeta «Politica aplicada».
4. Para ver lo que ve un estudiante en VS Code, haz el flujo de 1.4 con tu cuenta de GitHub y un repositorio público. Otra opción es VS Code de escritorio: instala `adaceen-<versión>.vsix` (vista Extensiones → menú «…» → "Install from VSIX...") y pon en Configuración `adaceen.backend.baseUrl` = `https://app-adaceen-api-eyder05232002.azurewebsites.net`, porque fuera del túnel el valor por defecto es `http://127.0.0.1:3000`. Versión publicada en el Marketplace (`adaceen.adaceen`): por verificar.
5. En «Administracion de usuarios» puedes crear cuentas de estudiante asignadas a ti: «Agregar usuario», nombre, correo, contraseña temporal (6 caracteres o más) y cursos, y luego «Crear usuario». Es útil para quien use Firefox.

### 4.2 Configurar la política

Abre Configuración (icono de tuerca), ajusta los campos y pulsa «Guardar cambios» (verás «Politica docente guardada.»). La política se aplica a tus estudiantes; en VS Code, a los que configuraron la sesión compartida (1.5).

| Campo | Valores | Piloto | Efecto |
|---|---|---|---|
| «Nombre de la politica» | 3 a 120 caracteres | RF-05 base del piloto | Se muestra en el resumen del estudiante. |
| «Resultado de aprendizaje» | RA1, RA2, RA3 | RA1 | Se muestra en el resumen y se envía al modelo como resultado de aprendizaje objetivo (overlay y VS Code). |
| «Tono del tutor» | Calido, Directo, Socratico | Calido | Estilo de redacción (overlay y VS Code). |
| «Frecuencia de intervencion» | Baja, Media, Alta | Media | Solo se envía como indicación al modelo del overlay; no cambia cuándo se activa el tutor (1.6). |
| «Nivel de ayuda» | Progresiva, Solo pistas, Ejemplo parcial | Progresiva | Orden de las etapas (2.1). |
| «Maximo de pistas por ejercicio» | 1 o más; vacío = ilimitado | 3 | Tope de pistas por actividad o archivo; con «Cuenta como pista», también es el cupo de aplicaciones de código por archivo. |
| «Bloquear solucion completa» | sí / no | sí | Pide al modelo no dar la solución completa; los límites de código por etapa se aplican siempre. |
| «Intervenciones habilitadas» | Explicacion, Pista, Ejemplo parcial, Mini quiz | todas | Limita las etapas de 2.1: sin «Ejemplo parcial», la tercera ayuda se queda en Pista 2; sin «Pista», las pistas pasan a explicación breve; si ningún tipo habilitado sirve para el evento, el estudiante recibe el mensaje controlado. |
| «Mensaje controlado» | 10 a 280 caracteres | «No puedo ayudar con ese tema…» | Respuesta ante falta de contexto o consulta fuera del curso. |
| «Nota docente» | hasta 600 caracteres | «Prioriza pistas graduales, preguntas orientadoras y trazabilidad para el piloto.» | Instrucción adicional para el modelo. |
| «Permitir mini quiz» | sí / no | sí | Activa el mini quiz. |
| «Cuando sale el mini quiz en VS Code» | «Tras aceptar una sugerencia», «Cuando yo lo lance a la clase», «Si falla, pedir que explique» | las tres | Disparadores y pregunta abierta tras un fallo. |
| «Un quiz cada cuantas sugerencias aceptadas» | 1 a 20 | 1 | Frecuencia del quiz tras aceptar. |
| «Maximo de quices por sesion (vacio = sin limite)» | 1 a 50 | 5 | Tope por ventana de 12 horas. |
| «Permitir aplicar código desde VS Code» | sí / no | sí | Apagado, VS Code muestra el código solo como guía. |
| «Máximo de líneas por aplicación (1 a 200)» | 1 a 200 | 20 | Los cambios más largos no se aplican; el estudiante ve el motivo. |
| «Cuenta como pista» | sí / no | sí | Cada aplicación descuenta del máximo de pistas del archivo. |
| «Pedir confirmación» | sí / no | sí | VS Code pregunta antes de aplicar, aunque el estudiante tenga activada la aplicación automática. |

Temas permitidos y reglas por evento no tienen campos en el overlay: se cambian con `PUT /api/policies/current` (sesión de docente, campos `allowedTopics` y `eventRules`) con apoyo de quien administra el piloto.

- Temas del piloto: RA1 a RA3, IL1 a IL8, clases, objetos, encapsulamiento, herencia, polimorfismo, C++, Python, GitHub y Codespaces. Una pregunta que no los menciona puede recibir el mensaje controlado.
- Reglas: una por evento (`compile_error`, `runtime_error`, `concept_question`, `design_block`, `workflow_guidance`, `insufficient_context`, `out_of_domain`, `code_suggestion`) con `enabled`, `interventionType`, `detailLevel`, `activationThreshold` (1 a 5) y `maxUsesPerSession`. En el piloto: errores, diseño, flujo de trabajo y sugerencias de código → pista; conceptos → explicación breve; falta de contexto y fuera del curso → mensaje controlado.

«Tutor activo» y «Configuracion automatica (archivo principal)» son ajustes de tu navegador, no de la política. «Configurar RAG» y «Bitacora» (botones del panel) gestionan las fuentes del curso que el tutor cita.

### 4.3 Lanzar un quiz a la clase

1. Deja marcados «Permitir mini quiz» y «Cuando yo lo lance a la clase».
2. En Configuración, campo «Lanzar un quiz a la clase», escribe el tema (mínimo 3 letras, por ejemplo «encapsulamiento») y pulsa «Lanzar quiz». El modelo genera la pregunta con el material del curso; si no responde, la toma del banco validado.
3. La línea de estado muestra «Activo: "<tema>" (N respuestas, M correctas, explicaciones X/100).». El quiz dura 60 minutos o hasta que pulses «Cerrar quiz activo».
4. Tus estudiantes lo ven en VS Code en menos de un minuto (2.4), siempre que hayan configurado la sesión compartida; sin ella reciben el del docente por defecto.
5. Por API puedes lanzar una pregunta tuya: `POST /api/quiz/launches` con `topic`, `question`, `options` (3 a 5) y `correctIndex`.

### 4.4 Panel de la clase y resumen de comportamiento

- «Telemetria reciente» (botón «Recargar»): últimas intervenciones de tus estudiantes (nombre, evento, política, tipo y fecha) y métricas de VS Code por tipo de evento. «Politica docente» resume tu política. Estas secciones aparecen tras «Explorar repo» o «Analizar Campus», y directamente en `vscode.dev`.
- «Administracion de usuarios»: tus estudiantes, sus cursos y su estado.
- Quices: la línea de estado de 4.3 da el resultado del último. Por API, `GET /api/quiz/summary` resume todos (tras aceptar y lanzados: respuestas, correctas, porcentaje, promedio de explicaciones y omitidos).

### 4.5 Exportar la telemetría

Solo docentes y administradores. El conjunto está seudonimizado (5.2).

- Desde el repositorio (con Node.js):

  ```bash
  npm run telemetria:exportar -- --url=https://app-adaceen-api-eyder05232002.azurewebsites.net \
    --email=<tu-correo> --password=<tu-clave> --formato=csv --desde=2026-09-01
  ```

  El archivo queda en `exportes/`, que no se sube al repositorio. La contraseña queda en el historial de la terminal: ejecútalo solo en tu equipo y borra el historial, o pide la exportación a quien administra el piloto. `--con-quices` agrega los intentos del mini quiz, pero solo con acceso directo a la base.
- Desde el backend: `GET /api/telemetry/export?format=csv&since=2026-09-01&until=2026-12-15` con la cabecera `x-session-id` de una sesión de docente o administrador; descarga `telemetria-adaceen.csv` (o `.jsonl` con `format=jsonl`).
- Qué significa cada columna: `docs/telemetria/diccionario-eventos.md`.

## 5. Privacidad y permisos

### 5.1 Qué datos lee el tutor

| Componente | Qué lee | Cuándo |
|---|---|---|
| Overlay del navegador | De la pestaña activa: dirección, título, texto visible, selección, error visible, código visible, repositorio, rama y archivo; en Campus, actividades y fechas visibles. Al servidor envía dirección, título, repositorio, rama, archivo, selección, error visible, fragmento de código, actividad y fecha, meta y curso. | Lee mientras el overlay está abierto en esa pestaña; envía cuando pides ayuda (y una vez al entrar al panel). |
| «OCR visual» | Una captura de la pestaña del editor, sin el overlay. | Al pulsarlo o tras «Explorar repo», solo con «Configuracion automatica (archivo principal)» activa. |
| «Explorar repo» | Los archivos de código del proyecto (hasta 200, de hasta 300 KB), leídos por la extensión de VS Code y guardados como contexto del proyecto. | Solo si aceptas «Dar permiso para leer, modificar y hacer analisis sobre tu entorno?» (se pide una vez). |
| Extensión de VS Code | Ruta y contenido del archivo activo (hasta 24.000 caracteres), selección (hasta 20 líneas), línea del cursor, errores del editor y un mapa del proyecto (hasta 90 archivos: nombre, tamaño y primeros 220 caracteres). | Con cada sugerencia (1.6). |
| GitHub | GitHub App: repositorio, ramas y PR; en el modo Codespaces crea una rama y un PR de configuración (permisos exactos de la app por verificar). OAuth: tu usuario y correo, con los permisos que fija el piloto (recomendados: `repo codespace read:user user:email`). | Al autorizar en «Preparar repositorio» y al preparar el entorno. |
| Google | Correo y nombre al entrar con Google. Calendar: permiso `calendar.events` para crear eventos «ADACEEN entrega: …» con las fechas de las actividades; el código no lee tus otros eventos. | Al pulsar «Continuar con Google»; Calendar, al pulsar «Sincronizar agenda» o «Sincronizar Calendar». |
| Máquina del túnel | Tu repositorio clonado en el usuario `ws-<tu-usuario>`. | Desde que preparas el entorno hasta que se borra tu usuario. |

### 5.2 Qué se guarda

- Telemetría del piloto (`telemetry_events`, versión 1.1): seudonimizada con HMAC; sin textos de error (solo su hash), sin código, sin rutas (solo hash y extensión del archivo) y sin correos. Es lo que se exporta y se conserva 365 días por defecto. Detalle: `docs/telemetria/diccionario-eventos.md`.
- Registros de operación que sí te identifican y no se exportan tal cual: sesión y política, intervenciones del overlay (tu id y un resumen del contexto), eventos con sesión (tu id y la ruta del archivo), intentos del mini quiz (pregunta, respuestas, explicación y un fragmento del cambio aceptado de hasta 3.000 caracteres; se exportan con el actor seudonimizado), el contexto del proyecto si usaste «Explorar repo» y las capturas del OCR.
- En tu navegador: sesión, preferencias e id anónimo (`adaceenClientId`) en el almacenamiento de la extensión.
- Política de privacidad: `https://app-adaceen-api-eyder05232002.azurewebsites.net/privacy-policy`.

### 5.3 Cómo revocar permisos

1. Pausar: Configuración → desmarca «Tutor activo» → «Guardar cambios». «Salir» cierra la sesión en el servidor, y el código que pegaste en VS Code deja de servir.
2. Quitar las extensiones: en `chrome://extensions` (o `edge://extensions`, `brave://extensions`) quita ADACEEN; se borran su sesión y preferencias locales. En Firefox, desde `about:addons`. En VS Code, vista Extensiones → ADACEEN → desinstalar o deshabilitar; en el túnel la extensión es de la máquina y se reinstala al reiniciar el servicio (por verificar), así que cerrar la pestaña de `vscode.dev` es lo que detiene la lectura.
3. GitHub, Settings → Applications:
   - «Authorized OAuth Apps»: revoca la app OAuth de ADACEEN y, si ya no usarás el túnel, la de Visual Studio Code que autorizaste con el código de dispositivo (nombres exactos por verificar).
   - «Installed GitHub Apps»: en la GitHub App de ADACEEN (nombre exacto por verificar), «Configure» → quita tu repositorio o desinstálala.
   - Borra a mano la rama o el PR de configuración si ADACEEN llegó a crearlos.
4. Google: Cuenta de Google → Seguridad → acceso de terceros (nombre exacto por verificar) → ADACEEN → quitar el acceso. Los eventos ya creados («ADACEEN entrega: …») no se borran solos.
5. Máquina del túnel: pide a tu docente que solicite a quien administra la máquina borrar tu usuario `ws-<tu-usuario>`. Eso elimina tu copia del proyecto y detiene el túnel `ad-<tu-usuario>`.
6. Datos del servidor: para pedir acceso, corrección o borrado, usa el canal definido por el docente del curso.

## 6. Validación (indicador A16.8)

El indicador pide instalación en 15 minutos o menos siguiendo esta guía y la validación del docente o del director. Cómo medir: cronometra desde que abres el zip hasta que se cumplen todas las casillas de «Cómo sé que quedó bien», sin más ayuda que la guía. Anota una fila por persona.

| Quién validó (nombre y rol) | Fecha | Navegador y sistema | Tiempo real de instalación (min) | ¿15 min o menos? | Observaciones (paso más lento, errores) |
|---|---|---|---|---|---|
| | | | | | |
| | | | | | |
| | | | | | |

Visto bueno del docente o del director: ______________________  Fecha: ____________

Puntos por verificar en la primera validación:

- Textos de los navegadores y servicios externos: «Este Firefox», el botón de GitHub en `vscode.dev`, los nombres de la GitHub App, de la app OAuth de ADACEEN y de Visual Studio Code en GitHub, y la ruta de «acceso de terceros» en la cuenta de Google.
- «Continuar con Google» y Google Calendar en Edge y Brave; firma del paquete de Firefox para una instalación permanente.
- Cambio de repositorio con «Rehacer PR devcontainer» en el modo túnel.
- Si la extensión de VS Code se reinstala en el túnel tras desinstalarla, y qué versión está publicada en el Marketplace.
