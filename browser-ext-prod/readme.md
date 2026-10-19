## GitHub Mentor - Extension MV3 (Con backend)

**Version 0.8.2 (2026-10-19): «Entrar con <cuenta>» borra la sesion que vscode.dev guarda** (permiso nuevo `browsingData`):

- En el aviso de `vscode.dev` (`showTunnelNotFoundBanner`), «Entrar con <cuenta>» (`resetVscodeWebSession`) deja el aviso del paso 4 y pide al background `ADACEEN_RESET_VSCODE_SESSION`: `about:blank`, `chrome.browsingData.remove` solo para el origen de vscode.dev (Firefox: `hostnames`) y de vuelta al editor (`startVscodeSessionReset` en `background.js`). Sin el permiso, `clearVscodeWebStorageFromPage` y recarga.
- Los botones del aviso se ordenan por la causa (`tunnelNotFoundCause`: `device`, `vscode`, `after_reset` con `STORAGE_KEY_VSCODE_SESSION_RESET`, `unknown`).
- Cubierto por `tests/scripts/browser-ext-background-vscode.test.ts` y `browser-ext-flujo-tunel.test.ts` (pruebas «0.8.2»).

**Version 0.8.1 (2026-10-18): punto de restauracion cuando el editor queda a nombre de otra cuenta de GitHub** (la reconexion necesita el backend y el agente de la VM de esta entrega; lo demas funciona con el anterior):

- `vscode.dev` no encuentra el tunel (`watchTunnelNotFound` en `services/workspace.service.js`, desde `overlay/content-lifecycle.js`): durante 3 min despues de cargar busca el dialogo «No se pudo encontrar el tunel...» / «Could not find the tunnel...» (`TUNNEL_NOT_FOUND_PATTERNS`) y, si el editor es de quien tiene la sesion (editor guardado, aviso del paso 4 o cuenta anotada del codigo), muestra «ADACEEN · Tu editor no aparece con esta cuenta de GitHub» (`showTunnelNotFoundBanner`) con la causa (`tunnelNotFoundCause`: el codigo lo autorizo otra cuenta, la entrada a vscode.dev fue con otra, o no se sabe) y «Reconectar con mi cuenta».
- «Reconectar con mi cuenta» (`reconnectTunnelWorkspace`): abre la ventana de espera en el mismo clic y llama a `prepareTunnelWorkspace({ reconnect: true })`, que manda `reconnect: true` en `POST /api/workspaces/prepare`; despues siguen el paso 3 (codigo nuevo) y el paso 4. `prepareTunnelWorkspace` ahora devuelve si el editor quedo listo.
- «Usar otra cuenta de GitHub» (`switchTunnelGithubAccount`): para cuando la cuenta conectada a ADACEEN no es la del estudiante. `startGithubUserOAuthFlow({ selectAccount: true })` manda `selectAccount` (GitHub muestra su selector de cuentas) y la espera no sigue hasta que cambia `updatedAt` del token (`pendingGithubOAuthTarget.previousUpdatedAt`); despues `continueAfterGithubOAuth` prepara el editor a nombre de la cuenta elegida.
- Paso 3 con otra cuenta abierta (`showGithubDeviceCodeHelper`): no escribe el codigo, dice «No pegues el codigo con...» y ofrece «Cambiar de cuenta» (`github.com/logout`; el handoff guarda `switching`). `showGithubAccountSwitchHelper` acompana en `github.com/logout` y en la portada hasta volver a `github.com/login/device` con la cuenta del editor. Quien autoriza queda en `STORAGE_KEY_TUNNEL_DEVICE_ACCOUNT` (30 dias).
- Paso 4: `showVscodeGithubAuthorizeHelper` advierte en amarillo si la cuenta abierta en GitHub no es la del editor.
- Cubierto por `tests/scripts/browser-ext-flujo-tunel.test.ts` (pruebas «0.8.1»).

**Version 0.8.0 (2026-10-18): acompañamiento paso a paso de la primera vez** (funciona con el backend de esta entrega y con el anterior):

- Los cuatro pasos de la primera vez con los mismos nombres en todas las paginas (`FIRST_TIME_STEP_LABELS`, `firstTimeStepsMarkup` y `firstTimeStepHeading` en `services/codespace-waiting.service.js`): «Tu cuenta de GitHub», «Encender tu editor», «Autorizar tu editor» y «Entrar a VS Code». La ventana de espera los marca (`setTunnelWaitingStep`), y si ya esta en la pagina del callback del backend se los manda por `postMessage` (`postCodespaceWaitingStep`, `{type: "ADACEEN_WAIT_UPDATE", step}`).
- Paso 1 en GitHub (`showGithubOAuthStepHelper` en `services/github-auth.service.js`): en el inicio de sesion y en la autorizacion del OAuth de ADACEEN (solo con el `redirect_uri` del backend), un aviso arriba dice que pulsar y que la ventana sigue sola. Si GitHub rechaza la direccion de regreso sale el otro aviso (`showGithubOAuthRedirectErrorHelper`).
- Sin clic extra al volver de GitHub (`pendingGithubOAuthTarget`): «Abrir el ejercicio en mi editor» desde Inicio en una pagina sin repositorio (/empezar, Campus) recuerda el repositorio durante el OAuth y `continueAfterGithubOAuth` prepara el editor en la misma ventana (antes pedia volver y pulsar otra vez). `prepareTunnelWorkspace` pasa `repoFullName` y `buttonLabel` a `startGithubUserOAuthFlow`.
- Paso 3 obligatorio en `github.com/login/device` (`showGithubDeviceCodeHelper`): el aviso trae «Paso 3 de 4 · Autorizar tu editor · obligatorio la primera vez», la fila de pasos y por que hace falta; la ventana de espera dice lo mismo (`showDeviceCodeStep`).
- Paso 4 en `vscode.dev` (`showTunnelSignInHint`) y en la pagina de GitHub donde se autoriza «Visual Studio Code» (`showVscodeGithubAuthorizeHelper`): arriba, que pulsar («Allow», GitHub y no Microsoft, autorizar «Visual Studio Code») y con que cuenta. Ya no se gasta al mostrarse: sigue hasta «Ya entré» o hasta que vence (10 min).
- Cubierto por `tests/scripts/browser-ext-flujo-tunel.test.ts` (pruebas «0.8.0»).

**Version 0.7.22 (2026-10-11): codigo de estudiante, politica de privacidad 2026-10-11 y direccion B del diseño** (requiere el backend de esta entrega):

- Entrar (`overlay/content-auth.js`, `services/auth.service.js`): si el backend responde `ok: false` con `step` (`student_code`, `pending_approval` o `rejected`; el 400 de un codigo mal escrito llega en `error.payload`, que ahora pone `fetchJsonWithTimeout`), `loginToBackend` y `loginToBackendWithGoogle` devuelven el paso en vez de lanzar el error y la vista de acceso cambia a la tarjeta `studentCodeCard` (`renderStudentCodeStep`): «Código de estudiante» con el campo `studentCodeInput` sobre siete casillas dibujadas (`renderStudentCodeCells`; 7 digitos; `2312345-3743` vale y el backend guarda `2312345`), «Tu docente tiene que aprobar este correo» (sin campo; el resumen `studentCodeReview` dice el codigo, el correo enmascarado y cuando se pidio; «Revisar de nuevo» repite el login con el mismo codigo) o «Acceso no aprobado». La linea de arriba (`studentCodeWhoLine`) dice con que correo entro y «paso 2/2», «en revisión» o «no aprobado». «Usar otra cuenta» vuelve al inicio de sesion y, con Google, olvida el token para elegir otra cuenta. Con Google el segundo intento reutiliza el token de Chrome (no vuelve a preguntar). Estado: `overlayState.studentCodeStep`.
- «Usuarios» (`overlay/content-users.js`, `services/backend-admin.service.js`): la columna «Código» (antes «Rol») con el codigo o «sin código · no ha entrado» / «sin código · lo escribe al entrar»; la fila de un docente dice su rol. Bajo el correo, «También entra con …» con los correos de acceso extra. La barra de arriba trae el conteo (`adminUsersStatus`) y la busqueda por nombre, correo o codigo (`adminUsersSearch`, `overlayState.adminUsersQuery`; filtra en el navegador). «Editar» trae «Código de estudiante» (solo viaja si cambia; vacio lo quita) y «Otros correos de acceso» con «Quitar» (`DELETE /api/admin/users/:id/login-emails/:email`). «Solicitudes de acceso» (`adminAccessRequests`, `overlayState.adminAccessRequests` de `GET /api/admin/users`) con «Aprobar» (pide confirmar: dice que cuenta se une) y «Rechazar» (`POST /api/admin/access-requests/:id`). «Agregar usuario» acepta el codigo (`adminCreateStudentCode`).
- «Importar lista» (`services/course-roster.service.js`): lee el codigo de la columna «Número de ID» del CSV o de la celda `2312345-3743` de la tabla pegada (`readCourseRosterStudentCode`) y lo manda como `studentCode` solo si lo hay (un backend 0.7.21 rechaza campos que no conoce); el resultado dice cuantos codigos quedaron y cuales no.
- Privacidad: `ADACEEN_PRIVACY_POLICY_VERSION` pasa a `2026-10-11` (todos aceptan de nuevo, tambien quien acepto antes de 0.7.12). El aviso «Antes de empezar» resume lo que se guarda, lo que se lee y lo que se registra (`consent-points`) y enlaza la politica completa (`firstLoginPolicyLink`, `<backend>/privacy-policy`).
- Direccion B del diseño (prototipo en el lienzo «Rediseño del overlay de ADACEEN»): tokens nuevos en `overlay/styles/base.styles.js` (tinta #1b1d1f, lineas #deded8/#c4c4bd, acento #0b6466, aviso #8a4a00, error #b42318, radio 4 px el panel y 3 px los controles, sin sombras difusas ni degradados), IBM Plex Sans para el texto y IBM Plex Mono para datos, codigos, correos, rotulos y pestañas. Las fuentes (OFL, `assets/fonts/`, en `web_accessible_resources`) se registran en `document.fonts` con `ensureAdaceenFonts()` (`overlay/content-styles.js`) con nombres propios («ADACEEN Plex …»): un `@font-face` dentro del shadow root no se aplica y no se pide nada a Google Fonts; si la pagina las bloquea quedan las del sistema. Cabecera de 48 px («adaceen», un borde y, con sesion, las iniciales en un recuadro con el nombre y el rol en dos lineas, `getUserInitials`; sin sesion, la version y sin «Salir»), barra de pestañas con fondo suave y un borde entre pestañas (la activa subrayada con el acento), secciones en tarjetas (ver «Fondos por capas»), «Tema de la clase» con pares clave y valor (`pilotTopicHomeWeek`, `pilotTopicHomeRepo`), la respuesta del tutor en una sola tarjeta con borde y «Fragmento que leyó el tutor». Lo propio de la B va en `overlay/styles/theme-b.styles.js` (despues de los modulos y antes de `responsive`); los demas modulos se ajustaron en su sitio. Los ids no cambiaron.
- «Eliminar seleccionados» en «Usuarios» (`overlay/content-users.js`): primera columna con una casilla por estudiante (`isAdminUserSelectable`), `adminUsersSelectAll` en la cabecera (los visibles con la busqueda; a medias con `indeterminate`) y la barra `adminUsersBulkBar`. La seleccion vive en `overlayState.adminSelectedUserIds`; `deleteSelectedAdminUsers` confirma, llama a `bulkDeleteAdminUsers` (`services/backend-admin.service.js`, `POST /api/admin/users/bulk-delete`) y resume con `describeAdminUsersRemoval`.
- Inicio sin texto corrido: `renderKeyValueGrid` (`overlay/content-render.js`) pinta pares clave y valor en un `<dl class="kv-grid">` (franja suave) o `kv-list` (filas). La politica sale de `buildTeacherSummaryPairs` y el panel del administrador de `ADMIN_HOME_FACTS` (`overlay/content-setup.js`); el resumen de sesion usa `detailFacts` de `buildSummaryBlock` y lo leido del proyecto va en `detailInsights`. Ya no existen `sessionBadge` ni la linea con «|».
- «Bitácora» del administrador (`overlay/content-bitacora.js`, `services/bitacora.service.js`): la pestaña aparece tambien para el administrador con el campo «Docente» (`teacherBitacoraOwnerSelect`, `overlayState.bitacoraOwner` con `teacherUserId` y `teachers` del estado). Cada peticion de bitacora lleva `teacherUserId` (`withBitacoraOwnerQuery`, `withBitacoraOwnerBody` y el formulario de subida); sin docente elegido, `ensureBitacoraEditable` no deja cambiar nada. La linea de Inicio y la marca de la pestaña siguen siendo solo del docente.
- «RAG» del administrador (18 oct, `overlay/content-rag.js`, `overlay/content-rag-page.js`, `services/backend-rag.service.js`): `getAvailableMainTabs()` del administrador la pone antes de «Bitácora». Arriba el campo «Docente» (`ragOwnerField`, `ragOwnerSelect`, `overlayState.ragOwner` con `teacherUserId` y `teachers` de `GET /api/rag/sources`); al cambiarlo se vuelven a pedir fuentes y lotes. Cada peticion de RAG lleva `teacherUserId` (`withRagOwnerQuery` en la consulta y el campo del formulario de «Cargar fuente»); sin docente elegido no se carga ni se cambia nada. `canManageRagSession()` (docente o administrador) reemplaza a `isTeacherSession()` en la pestaña; los textos dicen «por el docente» y «sus estudiantes» para el administrador.
- Fondos por capas (12 oct): la cabecera de arriba ya no es blanca sino `--adaceen-header` (#0a5254) con texto blanco, rol en `--adaceen-header-muted` e iniciales en un recuadro blanco; la barra de pestañas usa `--adaceen-nav` (la activa toma `--adaceen-canvas` con el subrayado); el cuerpo (`.body`), la tuerca (`.settings-panel`) y las pantallas sueltas van sobre `--adaceen-canvas` (#f0f1ee) y cada seccion (`.summary-card`, `.teacher-card`, `.panel-section`, `.preview-card`, `.context-hub`, `.pilot-topic-home`, `.tutor-response-region`, `#welcomeView`, `.auth-view`) es una tarjeta blanca con borde. Dentro de la respuesta del tutor, «Pistas de hoy» y «Siguiente paso» no son tarjetas: van separadas por una linea. `.next-action` en verde suave; la fila de titulos de `.admin-table` y los `.kpi-tile` neutros en `--adaceen-soft`. Solo estilos: ids y textos iguales.
- «Estudiantes» gestiona como «Usuarios» (12 oct): la gestion compartida vive en `overlay/content-users.js` con un ambito (`"users"` o `"students"`) que elige la seleccion (`overlayState.adminSelectedUserIds` o `studentsPanel.checkedIds`), la fila en edicion (`adminEditingUserId` o `studentsPanel.editingId`) y donde sale el aviso (`adminUsersMessage` o `studentsPanel.actionMessage`): `buildAdminSelectBox` (Shift marca el tramo desde la ultima casilla, `ADMIN_SELECTION_ANCHORS`), `renderAdminBulkBar`, `buildAdminUserEditButton`, `buildAdminUserDeleteButton`, `buildAdminUserEditForm` y `deleteAdminStudents` (bulk-delete tambien para «Eliminar» de una fila de estudiante; un docente sigue con `deactivateAdminTeacher`). Tras cada cambio, `refreshAfterAdminUsersChange` recarga «Usuarios» y deja vieja «Estudiantes» (se recarga al momento si esta a la vista). En `overlay/content-students.js`, la tabla suma la casilla y la columna «Acciones» con la fila de edicion, sin tocar las columnas de analitica; `renderStudentsManagement` pinta la barra y los botones. «Importar lista» y «Agregar estudiante» (`studentsToggleImportBtn`, `studentsToggleCreateBtn`) abren `adminImportPanel` y `adminCreateForm`, que `placeAdminUserForms` (`overlay/content-users-import.js`) muda a `studentsFormsHost` o a `adminUsersFormsHost` segun la pestaña.
- Cubierto por `tests/scripts/browser-ext-flujo-tunel.test.ts` (pruebas «0.7.22» y la de privacidad) y, en el backend, `tests/routes/student-code-routes.test.ts`.

**Lista del curso y tema del piloto** (0.7.21 sin cambio de numero, 2026-10-10; requiere el backend de esta entrega):

- «Usuarios» (`overlay/content-users-import.js`, lectura y backend en `services/course-roster.service.js`): «Importar lista» lee el CSV de «Participantes» de Campus o la tabla pegada (`parseCourseRoster`: el CSV con separador `\t`, `;` o `,`, comillas y encabezados de Moodle en espanol o ingles; la tabla copiada de la pagina por registros, con el nombre del rotulo «Seleccionar '…'» de cada casilla y sin las iniciales del avatar, aunque el rol y el estatus queden en lineas aparte; nombres en tipo titulo; suspendidos fuera) y manda a `POST /api/admin/users/import` solo los de `@correounivalle.edu.co`, salvo que se marque incluir los de otro correo. Al importar corrige con `PUT /api/admin/users/:id` los nombres que una importacion anterior leyo mal (iniciales del avatar pegadas o el correo; `collectCourseRosterNameRepairs`). Los docentes de la lista salen con su estado en ADACEEN y el administrador les crea la cuenta de docente (`POST /api/admin/users`, clave al azar) o pasa a docente a quien entro como estudiante. «Docente de las cuentas nuevas» (solo administrador, `PUT /api/admin/default-teacher`): quien entra por primera vez con Google queda con el; `reloadAdminUsers` guarda `defaultTeacher` en `overlayState.adminDefaultTeacher`.
- «Estudiantes» (`overlay/content-pilot-topic.js`, datos en `services/pilot-topic.service.js`): tarjeta «Tema del piloto» con la semana de la bitacora (por defecto la de la proxima clase), el tema y el repositorio del ejercicio, `GET`/`PUT /api/pilot/topic`; el administrador elige el docente. El borrador del formulario solo se rehace cuando llegan datos nuevos (no pisa lo que se escribe).
- Inicio del estudiante: «Tema de la clase» con «Abrir el ejercicio en mi editor» (`openMyTunnelEditor` con ese repositorio) o «Ver el ejercicio en GitHub» con Codespaces. El estudiante consulta el tema al entrar (`refreshMentorSession`, como mucho cada 5 min) y `buildCourseWeekForTutor` manda la semana del tema (`buildPilotTopicWeekForTutor`) mientras este puesto en ese curso.
- Cubierto por `tests/scripts/browser-ext-flujo-tunel.test.ts` (importar la lista como administrador, tema del docente con un backend anterior y tema del estudiante con el tutor y el editor) y, en el backend, `tests/routes/admin-import-routes.test.ts` y `tests/routes/pilot-topic-routes.test.ts`.

**Monitor del piloto en el navegador** (0.7.21, 2026-10-08; en la rama de la nube iba sobre su 0.7.20, el codigo de GitHub puesto solo):

- Pestana «Quices» (`overlay/content-quizzes.js`): boton «Monitor» (`quizzesMonitorBtn`, junto a «Crear quiz») abre `<backend>/docente/monitor` con `window.open` (`openTeacherMonitorPage`, `buildTeacherPageUrl`): lo que muestra `npm run piloto:monitor` en PowerShell, sin terminal ni contrasena en la linea de comandos. La pagina lee `GET /api/pilot/monitor` cada 15 s con la sesion.
- `inicio/pagina-quices.content.js` (tercera entrada de `content_scripts`) pasa de `/docente/quices*` a `/docente/*`: el mismo script le pasa la sesion a las dos paginas del docente y no mira la ruta.
- Cubierto por `tests/scripts/browser-ext-flujo-tunel.test.ts` («Monitor» abre `/docente/monitor`), `tests/scripts/browser-ext-structure.test.ts` (match `/docente/*`) y, en el backend, `tests/routes/teacher-monitor-page-routes.test.ts` y `tests/services/pilot-monitor.test.ts`.

**Version 0.7.17 (2026-09-28)**, rama `refactor/modularizacion` (agenda del curso segun la bitacora y Google Calendar; requiere el backend de esta entrega para «Inicio del semestre»):

- Agenda del estudiante (`services/course-agenda.service.js`, UI en `overlay/content-agenda.js`, estilos en `overlay/styles/agenda.styles.js`): `getCourseAgendaView()` arma las semanas (`buildCourseWeeks`: fecha mas temprana, tema, actividades y evaluaciones de la hoja «Exámenes» o tareas Parcial/Proyecto/Quiz) y la semana de hoy (`resolveCourseWeek`) con la hora de Bogota (UTC-5 fijo); se recalcula solo si cambia la agenda, el curso o el dia. El estudiante lee la bitacora de su docente con `GET /api/documents/bitacora/status` (`canReadCourseBitacora`, una consulta al entrar; en Campus la trae la verificacion del curso).
- Inicio: `agendaHomeLine` «Estás en FPOO · semana 5 de 16» con el tema y la proxima evaluacion; lleva a la pestana «Agenda» (`MAIN_TAB_IDS` y pestanas del estudiante: Inicio, Tutor, Agenda). En «Tutor», `tutorWeekLine` («Semana 5 de 16» y «FPOO: <tema>») bajo «Hoy quiero reforzar», solo durante el semestre; en el editor el overlay suele quedar en «Tutor».
- Pestana «Agenda»: esta semana, proximas evaluaciones y entregas, «Todas las semanas» (la de hoy marcada) y Google Calendar. En paginas de editor la tarjeta «Contexto de trabajo» (`vscodeSyncSection`, sigue al puntero) se oculta en esta pestana: tapaba las sugerencias y el boton para agregarlas.
- Tutor: `buildCourseWeekForTutor()` manda `context.courseWeek` (curso, semana, total, tema, rango y tres proximas evaluaciones) con cada peticion; `refreshMentorSession` espera la bitacora hasta 1,5 s antes de la primera.
- Google Calendar (`services/google-calendar.service.js`; `background.js` agrega `ADACEEN_GOOGLE_CALENDAR_LIST`, `ADACEEN_GOOGLE_CALENDAR_PATCH` y `ADACEEN_GOOGLE_CALENDAR_ACCOUNT`): solo con sesion `@correounivalle.edu.co` y si la cuenta de Google de Chrome es la misma (`userinfo`). «Sincronizar con Google Calendar» crea las evaluaciones y entregas que faltan desde hoy (9:00, el parcial dos horas y el resto una; avisos 1 dia y 1 hora antes; `extendedProperties.private.adaceenKey` = `bitacora|<curso>|s<semana>|<titulo>`), deja como estan las que ya tienen la clave aunque el estudiante las mueva (cada evento guarda en `adaceenDate` la fecha de la bitacora con que se creo y solo se mueve si esa fecha cambia, al dia nuevo con su hora y duracion), y no crea las que el estudiante ya tenia ese dia con otro nombre (`isCourseCalendarTwin`: mismas palabras del titulo, con ordinales y plurales, o el curso y una palabra; tambien las de Campus «ADACEEN entrega: ...»).
- «Sugerir bloques de estudio» (`buildCourseStudySuggestions`, clave `study|<evaluacion>|<fecha>|<n>`): dos sesiones antes de un parcial (5 y 2 dias, 2 h), dos antes de una entrega (4 y 1 dia, 90 min) y una antes de un quiz, para las tres proximas evaluaciones, en horas libres del calendario (entre semana 18:30, 20:00 o 16:30; fin de semana 9:00, 15:00 o 11:00). El estudiante marca cuales agregar; sin permiso de Calendar se proponen igual sin mirar el calendario.
- Docente, pestana «Bitácora»: «Inicio del semestre» con «Correr fechas» (`applyTeacherBitacoraStartDate` → `PUT /api/documents/bitacora/start-date`) corre todas las semanas igual; el estado dice en que semana va hoy y la lista marca «esta semana».
- Cubierto por `tests/scripts/browser-ext-flujo-tunel.test.ts` (pruebas «0.7.17»), `tests/scripts/browser-ext-background-calendar.test.ts` y `tests/scripts/browser-ext-structure.test.ts`; simulacion de punta a punta en `docs/evidencias/overlay-0.7.17/`.

**Version 0.7.16 (2026-09-28)**, rama `refactor/modularizacion` (pestana «Bitacora» del docente; sobre la 0.7.15 modularizada, sin otros cambios de comportamiento):

- Pestana «Bitacora» (`overlay/content-bitacora.js`, `buildTabPanelBitacoraTemplate` en tab-panels.template.js, estilos en `overlay/styles/bitacora.styles.js`): `MAIN_TAB_IDS` y `getAvailableMainTabs()` del docente la ponen entre «Quices» y «Usuarios»; al abrirla, `ensureTeacherBitacoraLoaded()` consulta `GET /api/documents/bitacora/status` (se reutiliza un minuto, `TEACHER_BITACORA_STALE_MS`). Arriba el estado (`teacherBitacoraStateChip`: Cargada / Falta / Consultando / Error, `teacherBitacoraRefreshBtn`); la zona `teacherBitacoraDropZone` con «Subir bitácora (Excel/PDF)» (mismo id `teacherBitacoraChooseFileBtn`); plantilla y exportar; y `<details>` para las semanas (`teacherBitacoraWeekCount`), el registro manual y borrar. Los ids de los campos y botones de la pagina anterior se conservan.
- Arrastrar y soltar: toda la pestana (`tabPanelBitacora`) recibe el archivo (`dragenter`/`dragover`/`dragleave`/`drop`, clase `is-dragover` en la zona); se aceptan `.xlsx`, `.xls` y `.pdf` (`TEACHER_BITACORA_FILE_PATTERN`) y otro formato solo deja el aviso en el estado. La ventana del overlay hace `preventDefault` a los archivos que se sueltan fuera de la pestana para que el navegador no los abra.
- Inicio: `teacherBitacoraHomeLine` (texto y chip del estado) lleva a la pestana; sale `teacherBitacoraUploadBtn` del resumen. El estado se consulta una vez al entrar (`refreshMentorSession` → `ensureTeacherBitacoraLoaded({ onlyIfUnchecked: true })`); en Campus lo llena `verifyCampusCourseAccess` con la misma respuesta. `overlayState.teacherBitacoraStatus` guarda `checkedAt` (0 = sin consultar) y `checking`.
- Accion recomendada: sin bitacora (`isTeacherBitacoraMissing()`), «Sube la bitácora del curso» con «Subir bitácora» (`upload_teacher_bitacora` → `openTeacherBitacoraTab({ pickFile: true })`: pestana y selector de archivo en el mismo clic); en Campus, «Bitacora requerida» usa la misma accion. Subir, guardar un registro o borrar llama a `syncCampusAccessAfterBitacoraChange()`, que vuelve a verificar el curso de Campus abierto. `tabFlagBitacora` (punto naranja) marca la pestana mientras falte.
- Retirados: `buildTeacherBitacoraPageTemplate`, `teacherBitacoraPage`, `teacherBitacoraCloseBtn`, `teacherBitacoraPageStatus`, `openTeacherBitacoraPage`, `closeTeacherBitacoraPage`, `renderTeacherBitacoraPage` y `overlayState.teacherBitacoraPageOpen` (con su capa de foco y su `Escape`). Subir ya no abre la ventana de analisis; un archivo que no es bitacora no reemplaza la cargada.
- Cubierto por `tests/scripts/browser-ext-flujo-tunel.test.ts` (pruebas «0.7.16») y `tests/scripts/browser-ext-structure.test.ts`.

**Version 0.7.15 (2026-09-28)**, rama `claude/serene-heisenberg-0te9s9` (lotes de RAG por curso, pestana «Quices», ayuda de los RA y exportar bitacora):

- Pestana «RAG» (`overlay/content-rag.js`): catalogo de lotes de `GET /api/rag/lots` en `overlayState.ragLots` (se carga con las fuentes y se reutiliza un minuto). Por curso: selector «Lote activo» (`PUT /api/rag/courses/:code/active-lot`), «Cargar en» (`overlayState.ragUploadLotByCourse`, la carga manda `lotId`), «Nuevo lote» (formulario en linea, `POST /api/rag/lots`), grupo «Base del curso» y un `<details>` por lote con «Activar en el curso», «Cargar fuente aqui» y «Retirar lote» (`DELETE /api/rag/lots/:id`). Por fuente, «Desactivar» / «Activar» (`PUT /api/rag/sources/:id/active`; `isEnabled` y `disabledSourceIds`). Los cambios toman el `catalog` que devuelve el backend.
- «Usuarios»: columna «RAG aplicado» con `user.ragLots` (por curso: `lotName` y `origin` student | teacher | base) y, en la fila de edicion del docente, un `<select>` por curso que guarda al cambiar con `PUT /api/rag/students/:id/lot` y recarga la lista. La pestana carga los lotes al abrirse (`ensureRagLotsLoaded`).
- Pestana «Quices» (`overlay/content-quizzes.js`, `overlayState.quizzesPanel`): `GET /api/quiz/custom` + `GET /api/quiz/attempts` al abrir (se reutiliza un minuto), «Lanzar un quiz a la clase» (los ids `teacherQuizTopic`, `teacherQuizLaunchBtn`, `teacherQuizCloseBtn` y `teacherQuizStatus` se mudan de la tuerca), «Crear quiz» abre `<backend>/docente/quices` con `window.open`, «Mis quices» (`POST /api/quiz/custom/:id/launch`, `POST /api/quiz/launches/:id/close`, `DELETE /api/quiz/custom/:id`) y la tabla «Quices hechos».
- `inicio/pagina-quices.content.js` (tercera entrada de `content_scripts`, solo `/docente/quices*` del backend de produccion): lee `adaceenSessionId` de `chrome.storage.local` y lo manda a la pagina con `postMessage` a `location.origin` («adaceen:session»); responde a «adaceen:session-request».
- Tuerca: sin la seccion «Piloto con y sin tutor» (ids `teacherPilot*` y `settingsSectionPilot` retirados; el piloto va por `npm run piloto:bloque`); «Resultado de aprendizaje» RA1 a RA5 con el boton «?» (`teacherOutcomeHelpBtn` / `teacherOutcomeHelp`, `renderTeacherOutcomeHelp` con `LEARNING_OUTCOME_HELP` en content-render.js).
- Bitacora: «Exportar bitacora (Excel)» y «Exportar bitacora (CSV)» (`exportTeacherBitacora` en campus.service.js, `GET /api/documents/bitacora/export`), habilitados solo con una bitacora cargada.
- Cubierto por `tests/scripts/browser-ext-flujo-tunel.test.ts` (prueba «0.7.15») y `tests/scripts/browser-ext-structure.test.ts` (tres entradas de content scripts).

**Version 0.7.14 (2026-09-27)**, rama `claude/serene-heisenberg-0te9s9` (usuarios legibles, RAG por curso, resumen del tutor separado y tuerca por secciones):

- «Usuarios»: filas con nombre y correo completos como texto y etiquetas para rol, profesor, cursos y estado; «Editar» abre la fila de edicion (nombre, correo, rol, profesor y cursos a todo el ancho) con «Guardar» y «Cancelar». Estado en `overlayState.adminEditingUserId` (una fila a la vez).
- Pestana «RAG» del docente (`overlay/content-rag.js`): todos sus cursos como `<details>` plegables (el curso por defecto abierto), fuentes base y propias por curso, «Cargar fuente» por curso (fija `selectedCourseCode` y abre el selector de archivo), «Material base», «Ver» y «Retirar». Carga al abrir con `refreshTeacherRagSources` (cursos + `allCourses=true`) y reutiliza un minuto (`teacherRagLoadedAt`). «Configurar RAG» y `open_teacher_rag` abren la pestana; la pagina `teacherRagPage` queda en el markup sin uso.
- «Fuentes RAG usadas»: `<details>` plegado por defecto con el conteo; una linea por fuente agrupada por curso, «+» despliega motivo, fragmento y coincidencias, «Abrir» abre el fragmento (`renderRagSourcesPanel`).
- Resumen del tutor: `parseTutorSummary` y `formatTutorStatusText` (content-render.js) separan el `analysis_summary` en deteccion, politica y conteo de fuentes; la linea de estado, la nota del panel de fuentes y el resumen del panel de VS Code usan las partes. Los textos sin marcadores pasan tal cual.
- Tuerca en secciones `<details class="settings-section">` (Sesion y tutor, Avanzado, Politica del tutor, Quices, Piloto con y sin tutor, Codigo desde VS Code) con «Guardar cambios» fijo abajo (`.settings-grid` desplaza, `.settings-actions` no). La seccion inicial depende del rol (`settingsSectionsInitialized`, una vez por sesion). Campos cortos de a dos (`.settings-two`).
- Cubierto por `tests/scripts/browser-ext-flujo-tunel.test.ts` (prueba «0.7.14»).

**Version 0.7.13 (2026-09-25)**, rama `claude/serene-heisenberg-0te9s9` (vista principal en pestanas y pestana «Estudiantes»):

- La vista principal ya no es una sola columna larga: va en pestanas por rol, cada una cabe en la ventana sin scroll largo. Estudiante: «Inicio» (contexto, accion recomendada, resumen de sesion) y «Tutor» (meta, pistas, siguiente paso, valoracion y fragmento). Docente: «Inicio» (con «Politica docente»), «Tutor», «Estudiantes» y «Usuarios». Administrador: «Inicio», «Estudiantes» y «Usuarios». `Actualizar` (Ctrl+Enter) abre «Tutor» al llegar pistas; un refresco automatico respeta la pestana elegida. Flechas, Inicio y Fin cambian de pestana (tablist de WAI-ARIA). Estado en `overlayState.mainTab`; se reinicia al cerrar sesion.
- «Estudiantes» (docente: los suyos; administrador: todos) se carga al abrir la pestana con `GET /api/admin/students` y se reutiliza un minuto: cinco indicadores del grupo (estudiantes, activos ahora, con quices, nota promedio, intervenciones y bloqueadas) y una tabla con sesiones (navegador y VS Code), ultima actividad, intervenciones (pistas, bloqueadas), quices (correctas/respondidas, % aciertos) y la nota. Busqueda local por nombre, correo, docente, cohorte o curso; punto verde con sesion viva en 15 min.
- El detalle (clic en el nombre, que es un boton, o en la fila) pide `GET /api/admin/students/:userId` y reemplaza la lista (sin scroll): indicadores del estudiante, linea de tiempo de 14 dias (sesiones, intervenciones y quices), «Quices y calificaciones» (opcion elegida, la correcta si fallo, nota del seguimiento y comentario), «Sesiones recientes» (tipo, origen, duracion, vencimiento), «Intervenciones del tutor» y «Actividad y ejercicios». El backend no envia ids de sesion. «Estudiantes» vuelve a la lista y el foco regresa a «Recargar».
- «Nota de quices»: 60 % del porcentaje de aciertos + 40 % del promedio del seguimiento (0 a 100 y escala 0 a 5; alto >= 80, medio >= 60, bajo < 60; sin quices, «Sin quices»). La formula sale en el titulo del chip y en el indicador del detalle.
- «Telemetria reciente» del docente pasa a un bloque plegable al final de «Estudiantes»; «Politica docente» queda en «Inicio» junto a «Politica aplicada».
- Codigo nuevo en `overlay/content-students.js` (pestanas y panel) y `fetchStudentsProgress`/`fetchStudentProgressDetail` en `services/backend.service.js`; estilos `.tab-*`, `.kpi-*`, `.students-*` y `.student-detail-*`. Cubierto por `tests/scripts/browser-ext-flujo-tunel.test.ts` (roles, carga al abrir, busqueda, detalle, volver, recargar).

**Version 0.7.12 (2026-09-25)**, rama `claude/serene-heisenberg-0te9s9` (auditoria de redundancias, tanda 1: estudiante y tunel):

- Sin «Empezar»: al pulsar el icono (o al restaurar el overlay fijado), sin sesion se muestra el login y con sesion se entra directo. Con el icono y sin editor guardado entra como «Empezar» (confirma la sesion con `/api/auth/me`, con 10 s como maximo, y el tutor responde una vez); con un editor guardado (GitHub, paginas sin contexto y `vscode.dev`) o al restaurar una pagina con algo que hacer (un repositorio, el editor o Campus) entra sin pedir ayuda al tutor ni reportarse como pestana activa hasta el primer clic o tecla. Las paginas del propio flujo de GitHub (la ventana del OAuth, la instalacion de la GitHub App, `github.com/login/device`, ajustes) y las paginas sin contexto no entran al restaurar. Una sesion vencida (401) lleva al login con «La sesion ya no es valida. Inicia sesion nuevamente.».
- Privacidad en el backend (contrato (a)): login, google-login y `/api/auth/me` traen `privacy.version`; si coincide con `ADACEEN_PRIVACY_POLICY_VERSION` (`2026-05-26`) no se muestra «Aceptar y continuar» en ningun navegador. Al aceptar se llama a `POST /api/auth/privacy-acceptance` (con un backend sin la ruta, 404, queda solo en local). Una aceptacion local anterior a 0.7.12 se registra en el backend sin volver a preguntar.
- Otro navegador o equipo: con el tunel y sin editor guardado, al entrar se consulta una vez `GET /api/workspaces/status`; si el editor esta listo se guarda y se ofrece «Abrir mi editor» en vez del tour (el primer clic pasa por `prepare`, que renueva la sesion de VS Code en la VM).
- Tunel sin GitHub App en ningun sitio: ni «Ajustes avanzados GitHub App» en la tuerca ni la fila «GitHub App» del contexto, y `/api/github-app/status` no se consulta. La vista inicial se titula «Preparar tu editor» («Primera vez»). Con Codespaces todo sigue igual.
- `vscode.dev` sin textos de Codespaces («Tutor en tu editor», «Tu editor en la nube», «Analisis de archivos en tu editor»); el repo sale del editor guardado con ese tunel. «Copiar sesion» pasa a «Copiar codigo para VS Code» y no se muestra en `vscode.dev` con VS Code conectado.
- Los mensajes que mandan a pulsar el boton del editor citan el que se ve: «Abrir mi editor» o, sin editor guardado, «Preparar mi editor» (`myEditorButtonLabel`).
- Sin botones repetidos: «Explorar repo» y «OCR visual» solo en el editor; sin «Actualizar contexto» (era «Actualizar»); sin el segundo «Autodetectar»; sin filas «No requerida»/«No detectado»; un solo boton para cerrar sesion («Salir»); el docente no cae en el tour del estudiante.
- Mac del laboratorio: la ultima eleccion (`adaceenEditorChoiceByUser`: VS Code de este equipo o editor en la nube) es la accion principal al volver otro dia.
- Menos peticiones al entrar: `/api/rag/courses` se reutiliza 30 s (antes dos veces), `/api/github/oauth/status` recien consultado no se repite al preparar el editor.
- El popup y `content.js` (codigo muerto) se borraron en la 0.7.12: el icono abre el overlay desde `background.js`.

Tanda 2 de la misma auditoria (Codespaces, docente y Campus), misma version 0.7.12:

- Codespaces con boton unico, como el tunel: una sola tarjeta («Tu repositorio») y la accion recomendada lleva los pasos («Autorizar GitHub App», «Conectar GitHub», «Preparar entorno ADACEEN»). Sin las tarjetas «Paso 2 de 3» y «Paso 3 de 3» («Abrir instalacion», «Verificar acceso», «Volver», «Preparar entorno», «Crear PR», «Ir al dashboard»), sin «Autorizar repositorio» ni «Leer archivos del repo» (solo navegaban o no funcionaban en github.com), sin «Actualizar estado» al lado de cada paso y sin el aviso «Entendido». El paso sale del estado (`resolveCurrentSetupStep`).
- GitHub App sin «Verificar acceso» (contrato (d)): tras abrir la instalacion, `/api/github-app/status` se consulta cada 4 s durante 5 min como maximo (cada tres consultas sin acceso se intenta `link-installation-auto`, como hacia «Verificar acceso»). Al tener acceso el tour pasa solo al siguiente boton, sin abrir ventanas; si el repo ya tenia la preparacion de ADACEEN, entra al panel. Se deja de consultar al cerrar el overlay, al salir o al cambiar de repositorio. La ventana de la instalacion sigue sin `opener`, asi que el aviso por `postMessage` de la pagina de retorno no llega: basta la consulta.
- Con Codespaces se siguen creando el PR y el Codespace: al volver del OAuth, `POST /github/prepare-environment` y el Codespace se abre en la misma ventana.
- Docente: una sola casilla de mini quiz («Permitir mini quiz» escribe `allowMiniQuiz` y el tipo `mini_quiz` de «Intervenciones habilitadas», donde ya no esta «Mini quiz»). «Lanzar quiz» muestra el `message` del backend y, si este activo el quiz (`autoEnabled`, contrato (c)), marca las casillas como quedaron sin tocar lo demas que no se guardo. «Iniciar bloque 1» sin grupos los asigna el backend (contrato (b)) y el estado agrega su `message`; «Asignar grupos A y B» deja de ser un paso previo.
- Campus: el acceso al curso y la bitacora se verifican solos al entrar (`verifyCampusCourseAccessOnEntry`) y queda una sola accion: «Analizar Campus» y luego «Sincronizar agenda». «Verificar acceso» solo aparece para reintentar tras un fallo o cuando falta la bitacora. La cabecera del resumen ya no repite «Analizar Campus» ni «Sincronizar agenda» (esos botones solo quedan en el editor, como «Explorar repo» y «OCR visual»).

Revision de las tandas 1 y 2, misma version 0.7.12:

- Al restaurar el overlay fijado ya no se entra en las ventanas del propio flujo (el OAuth en `github.com/login/oauth/authorize`, la instalacion de la App en `github.com/apps/<app>/installations/new`): antes mostraban el tour con un repositorio «login/oauth» o «apps/<app>» y, con la pestana del overlay aun activa, el aviso «Sesion activa en otra pestaña». Las rutas de GitHub (`login`, `apps`, `settings`, `orgs`…) ya no se leen como owner (`parseRepoFullName`, `getGitHubInfo`). Al restaurar, otra pestana activa deja la pagina en la bienvenida sin el aviso de conflicto.
- Con la privacidad pendiente («Aceptar y continuar» abierto) el contexto de la pagina no va al tutor; la primera respuesta se pide al aceptar.
- En el editor (`vscode.dev` y Codespaces) la accion recomendada ya no repite «Actualizar» con «Solicitar tutoria» ni «OCR visual» con «Reintentar OCR»: dice «Pulsa Actualizar (Ctrl+Enter)…». En «Buscar contexto», con el tutor pausado («Actualizar» deshabilitado) vuelve «Actualizar contexto».
- El docente en GitHub tiene su propia accion («Panel docente» → «Configuracion») en vez de «Preparar mi editor»/«Abrir Codespaces», y no se busca un editor a su nombre.
- La tuerca se abre bajo la cabecera: «Salir» sigue a la vista con ella abierta.
- Codespaces: al llegar al paso de la App se intenta una vez `link-installation-auto`; si la App ya estaba instalada en la organizacion, el tour pasa a «Conectar GitHub» sin abrir la pestana de instalacion.
- Campus: si la verificacion al entrar falla o falta la bitacora, el aviso tambien va al estado (`role=status`) para los lectores de pantalla.
- «Tu VS Code» (Mac del laboratorio) ya no afirma que el repositorio de la pagina se abrio ahi ni que exista un editor en la nube; el editor de otra cuenta no se guarda si la cuenta cambia durante `GET /api/workspaces/status`; el texto de la ventana de analisis cita «Explorar repo».
- `ADACEEN_PRIVACY_POLICY_VERSION` se compara en las pruebas con `PRIVACY_POLICY_VERSION` del backend.

Integracion con VS Code 0.0.32, misma version 0.7.12:

- Los avisos de «Copiar codigo para VS Code» mandan a «Tengo un codigo o sesion», la opcion unica de «ADACEEN: Conectar» en VS Code 0.0.32 (en la 0.0.31 se llamaba «Tengo un codigo del navegador»).
- Tras elegir un reemplazo, el estado dice «Reemplazo enviado. VS Code lo aplica en unos segundos; si el cambio es grande o no encuentra el codigo, pregunta antes.»: VS Code 0.0.32 toma ese clic como la confirmacion.
- «Mis parametros asignados» describe «Pedir confirmación» como «pide confirmacion en cambios grandes o automaticos» (en un cambio corto el clic del estudiante vale como confirmacion).

**Version 0.7.11 (2026-09-25)**, rama `claude/serene-heisenberg-0te9s9` (acceso simplificado, `docs/arquitectura/acceso-simplificado.md`, seccion 4):

- Tunel sin GitHub App: con el proveedor `tunnel` el tour tiene un solo paso, «Conectar GitHub»; al volver del OAuth se prepara el editor solo, en la misma ventana. El sondeo de respaldo del OAuth usa `flow.userHasCodespaceScope`. Sin botones que solo cambian de tarjeta («Autorizar repositorio», «Preparar entorno», «Autodetectar» con el repo ya inferido) ni el aviso «Entendido» con textos de Codespaces. Con Codespaces el tour sigue igual.
- Volver otro dia: el editor listo y el setup completado se guardan en `chrome.storage.local` por usuario y repo (`adaceenEditorByUser`, `adaceenSetupDoneByUser`) y `refreshGithubAppStatus` ya no los borra con el tunel. Con sesion valida y un editor guardado el overlay entra sin «Empezar» en GitHub y en paginas sin contexto (no en el editor ni en Campus, donde sigue «Empezar»), sin pedir ayuda al tutor y sin reportarse como pestana activa hasta el primer clic o tecla en el overlay; ofrece «Abrir mi editor»: consulta `/api/workspaces/status` y abre; si no esta listo, `prepare` (idempotente). Pasa directo por `prepare` (que renueva la sesion de VS Code en la VM) tras cerrar sesion, sin registro local o si el ultimo `prepare` fue hace mas de 7 dias (`sessionWrittenAt`).
- Proveedor: si `/api/workspaces/provider` falla por red, tiempo o 5xx, el valor es provisional (el tunel si hay un editor guardado) y se vuelve a consultar a los 15 s; solo un 404 fija Codespaces. Con el proveedor provisional no se borra el setup y antes de crear una PR se confirma.
- VM apagada: los errores con `retryable: true` no cortan la espera; la ventana sigue consultando y muestra el mensaje del backend («Encendiendo la VM de editores…» o «El editor esta apagado; avisa al docente»).
- Codigo de dispositivo en una sola pestana: la ventana de espera pasa a `github.com/login/device`, donde el overlay muestra el codigo con un boton «Copiar codigo», y al confirmar el tunel esa misma pestana abre `vscode.dev`. El codigo (`adaceenDeviceCodeHandoff`) queda ligado al usuario de ADACEEN, se borra al cerrar sesion y solo se copia solo si se emitio hace menos de 1 min. Si la espera termina sin editor (error, tiempo agotado) o deja de latir (la pestana de origen se recargo o se cerro), el aviso lo dice y pide volver a «Abrir mi editor». `navigatePendingCodespaceWindow` ya no cierra una ventana de otro origen (la del OAuth) por no poder escribir `opener`.
- «Abrir en VS Code de este equipo» pide un codigo de un solo uso (`POST /api/auth/editor/pairing-code`) y abre `vscode://adaceen.adaceen/abrir?code=…&repo=owner/repo` (VS Code 0.0.31 clona o abre y se vincula solo). El enlace se crea y se pulsa dentro de la shadow root cerrada del overlay, fuera del alcance de los scripts de la pagina. Si falla por tiempo, 5xx o red, abre `vscode://adaceen.adaceen/abrir?repo=…` sin codigo (VS Code se conecta con «ADACEEN: sin conectar») y no copia la sesion; solo con un backend anterior sin la ruta (404) usa el enlace de antes (`vscode://vscode.git/clone`) y copia la sesion. «Copiar sesion» copia un codigo de un solo uso para «ADACEEN: Conectar» (con un fallo pasajero pide reintentar).
- «VS Code conectado» exige un rack de la extension de VS Code (`source: vscode_extension`) de menos de 10 min; en github.com la fila «VS Code» del contexto aparece cuando VS Code publico hace poco para el repo actual. Esa consulta no retrasa la peticion al tutor.
- El login ya no viene precargado con la cuenta demo (solo con el backend local).
- `/empezar` del backend detecta la extension con un content script minimo propio (`inicio/pagina-inicio.content.js`, segunda entrada de `content_scripts`). En produccion solo corre en el backend https; el `/empezar` de `localhost:3000` y `127.0.0.1:3000` lo agrega la variante `-dev` (`node scripts/empaquetar-extension.mjs --dev`), como los hosts locales (A12.7).

**Version 0.7.10 (2026-09-24)**, rama `feat/macs-laboratorio`:

- Mac del laboratorio y VS Code instalado (A15.10 · ADACEEN-151): «Abrir en VS Code de este equipo» (en «Paso 1 de 3» de «Preparar repositorio» y en la tarjeta «Repositorio listo») clona el repositorio con el VS Code local (`vscode://vscode.git/clone`) y copia la sesion para pegarla en VS Code («ADACEEN: Configurar sesion compartida»). Con VS Code instalado no hacen falta la GitHub App ni el editor en la nube: el asistente se da por terminado. La extension de VS Code 0.0.30 se conecta sola a produccion cuando no hay backend local.
- Sin cambios de permisos: el enlace `vscode://` lo abre el navegador con su propia confirmacion.

**Version 0.7.9 (2026-09-24)**, rama `feat/segunda-tanda-jira`:

- Piloto con y sin tutor (A13.1): seccion «Piloto con y sin tutor» en la configuracion del docente para asignar los grupos A y B e iniciar o terminar los bloques (`/api/pilot`). En el bloque sin tutor el backend responde un aviso y no deja aplicar codigo.
- Accesibilidad de la seccion nueva (grupo con nombre y descripcion, `aria-pressed` en los bloques, estado con `role="status"`).

**Version 0.7.8 (2026-09-24)**, rama `feat/cierre-pendientes-jira`:

- Telemetria v1.1 del overlay (`services/telemetry.service.js`, A11.2/A4.2) y senales de error y bloqueo (A6.2). Ver seccion 10.
- Botones "Me sirvio" / "No me sirvio" bajo la respuesta del tutor y atajo `Ctrl+Enter` para pedir ayuda.
- Ajustes del docente para aplicar codigo desde VS Code (`policy.codeApplication`, A10.8).
- Accesibilidad WCAG 2.1 AA del overlay (A12.9): `docs/accesibilidad/checklist-wcag-overlay.md`.
- Revision de seguridad (A12.8): enlaces del backend solo http/https, shadow root cerrado y enlaces del visor de fuentes sin `sessionId`; `docs/seguridad/revision-overlay.md`.
- Permisos minimos (A12.7): sin `tabs`, sin `localhost` ni `*.azurewebsites.net` en produccion; `docs/seguridad/permisos-extension.md`.
- Empaquetado para Chromium y Firefox con `node scripts/empaquetar-extension.mjs` (A15.9). Ver seccion 11.

Extension para Chrome/Edge que:
- lee la pestana activa en GitHub,
- extrae codigo visible cuando estas en `github.com/.../blob/...`,
- detecta Codespaces (`github.dev` o `*.github.dev`) y muestra bienvenida,
- tiene interruptor Encendido/Apagado,
- consume backend `agente-proxy-azure` por `POST /github-mentor`,
- usa fallback local (heuristico) si backend no responde.

## Estructura del frontend

Los content scripts son scripts clasicos (sin `import`/`export`) que comparten un unico scope global. Se cargan en el orden de `manifest.json` (`content_scripts.js`), que debe coincidir con `CONTENT_SCRIPT_FILES` en `background.js`. El orden sigue capas: cada archivo solo usa, al cargar, cosas definidas en archivos anteriores.

```text
Capa 1 - Estado
  state/session.state.js                constantes, claves de storage, overlayState
  state/preferences.state.js            carga/persistencia en chrome.storage

Capa 2 - Contexto de la pagina (sin UI del overlay)
  overlay/content-context.js            lectura del DOM (GitHub, Codespaces, Campus), utilidades de texto/URL, parseo de repo
  overlay/content-guidance.js           ideas/guia/resumen heuristicos
  overlay/content-setup.js              estado del tour de configuracion, roles de la sesion y bindSetupView
  overlay/content-setup-actions.js      textos de estado, conexiones y accion recomendada

Capa 3 - Servicios (HTTP al backend y flujos)
  services/backend.service.js           base HTTP (registro, fetchJsonWithTimeout, cabeceras) y pregunta al mentor
  services/backend-courses.service.js   cursos y curso del estudiante
  services/backend-quiz.service.js      quices de clase y banco del docente
  services/backend-rag.service.js       lotes de RAG y fuentes para la UI
  services/backend-admin.service.js     politica, telemetria, usuarios y progreso de estudiantes
  services/backend-vscode.service.js    consentimiento, rack y sincronizacion con VS Code
  services/backend-project.service.js   contexto del proyecto y captura con OCR
  services/telemetry.service.js         telemetria v1.1: cola, lotes, ciclo del tutor, senales de error
  services/auth.service.js              login/logout, sesion compartida entre pestanas
  services/github.service.js            preparacion del Codespace
  services/github-auth.service.js       OAuth de usuario y GitHub App
  services/codespace-waiting*.service.js  ventana de espera del Codespace (contenido y ventana)
  services/workspace.service.js         entorno por tunel de VS Code (proveedor "tunnel")
  services/campus.service.js            Campus: analisis de la pagina y acceso al curso
  services/campus-documents.service.js  documentos del Campus y clasificacion
  services/campus-calendar.service.js   agenda y Google Calendar
  services/course-agenda.service.js     agenda del curso (0.7.17): semanas, semana de hoy, evaluaciones y bloques de estudio
  services/google-calendar.service.js   la agenda del curso en Google Calendar (0.7.17): cuenta, crear, mover y bloques
  services/bitacora.service.js          datos y acciones de la bitacora del docente
  services/course-roster.service.js     «Importar lista» de Usuarios (0.7.21): lee la lista de Campus, importa y docente de las cuentas nuevas
  services/pilot-topic.service.js       tema del piloto (0.7.21): consulta, guarda y semana para el tutor

Capa 4 - UI
  overlay/styles/*.styles.js            CSS del shadow DOM en bloques contiguos (el orden es la cascada)
  overlay/content-styles.js             concatena los bloques en OVERLAY_STYLES
  overlay/templates/*.js                plantillas; tab-panels, teacher-pages (solo la pagina RAG) y settings-panel se interpolan en shell.template.js
  overlay/content-markup.js             ensambla el shell y queryOverlayElements() (overlayEls)
  overlay/content-a11y.js               foco, teclado (Escape, Ctrl+Enter) y render idempotente
  overlay/content-render.js             renderOverlay y listas comunes
  -- una pestana o area por archivo, con su render y su bind...() --
  overlay/content-home.js               «Inicio»: centro de contexto, acciones recomendadas, selector de cursos
  overlay/content-tutor.js              «Tutor»: refreshMentorSession, resumen, «Fuentes RAG usadas», opinion
  overlay/content-students.js           pestanas por rol y «Estudiantes» (progreso, detalle, telemetria)
  overlay/content-users.js              «Usuarios»
  overlay/content-users-import.js       «Importar lista» y «Docente de las cuentas nuevas» en «Usuarios» (0.7.21)
  overlay/content-rag.js                «RAG» del docente
  overlay/content-rag-page.js           pagina RAG anterior a la pestana
  overlay/content-quizzes.js            «Quices»
  overlay/content-bitacora.js           «Bitacora» del docente (0.7.16): pestana, linea de Inicio y arrastrar el archivo
  overlay/content-agenda.js             «Agenda» del estudiante (0.7.17): linea de Inicio y del Tutor, semanas y Google Calendar
  overlay/content-pilot-topic.js        «Tema del piloto» en «Estudiantes» y «Tema de la clase» en Inicio (0.7.21)
  overlay/content-settings.js           tuerca y ayuda de los RA
  overlay/content-auth.js               bienvenida, login, primer ingreso y «Salir»
  overlay/content-vscode.js             paleta en linea y panel de sincronizacion con VS Code
  overlay/content-project.js            exploracion del proyecto y ventana de analisis
  overlay/content-project-context.js    contexto del proyecto en la tuerca

Capa 5 - Ciclo de vida
  overlay/content-window.js             posicion, arrastre, minimizar y fijar la ventana
  overlay/content-tab-session.js        estado por pestana y sincronizacion entre pestanas
  overlay/content-active-tab.js         pestana activa y aviso de conflicto
  overlay/content-editor-open.js        abrir Codespaces o VS Code local y traspaso al navegar
  overlay/content-lifecycle.js          ensureOverlay (monta y llama a los bind...()), abrir/cerrar, entrada automatica, arranque

inicio/pagina-inicio.content.js  /empezar del backend: avisa que la extension esta instalada (segunda entrada de content_scripts, aislada del overlay)
inicio/pagina-quices.content.js  /docente/* del backend (/docente/quices y /docente/monitor): le pasa la sesion a la pagina (tercera entrada de content_scripts)
background.js                   service worker (Google auth: getAuthToken en Chrome, launchWebAuthFlow en Firefox; captura, inyeccion de content scripts)
```

Reglas:

- Una funcion o constante vive en un solo archivo. Si dos archivos la declaran, la ultima en cargar pisa a la primera sin aviso.
- Nada se ejecuta al cargar salvo declaraciones; las capas inferiores pueden llamar a `renderOverlay()` o a funciones de `content-lifecycle.js` **dentro de funciones**, nunca en el nivel superior del archivo.
- Al crear un archivo, agregalo en `manifest.json` y en `background.js` (misma posicion).
- Los listeners de cada pestana se registran en su `bind...()`; `ensureOverlay` solo monta el shadow root y llama a esas funciones.
- Algunos archivos no llevan `"use strict"` porque su codigo viene de archivos que no lo tenian (content-render, content-lifecycle, content-setup, backend.service...). No muevas codigo entre un archivo estricto y uno que no lo es sin revisar `this`, `arguments` y asignaciones a propiedades de solo lectura.
- `npm test` (raiz de PDC) ejecuta `tests/scripts/browser-ext-structure.test.ts`, que falla si hay duplicados, nombres indefinidos, referencias adelantadas en tiempo de carga o listas de carga desincronizadas.
- `tests/scripts/browser-ext-flujo-tunel.test.ts` carga los content scripts reales en `node:vm` (chrome, DOM y backend falsos, reloj virtual) y simula el acceso simplificado: tunel sin GitHub App, VM apagada, codigo de dispositivo, volver otro dia con «Abrir mi editor», alcance de la entrada automatica, proveedor provisional, VS Code local y `/empezar`. Falla tambien si el overlay pide a su shadow root un id que no existe en el markup.

## 1) Cargar la extension

1. Abre `chrome://extensions/` (o `edge://extensions/`).
2. Activa `Modo de desarrollador`.
3. Clic en `Cargar descomprimida`.
4. Selecciona esta carpeta: `browser-ext-prod`.

`manifest.json` es el de **produccion**: no incluye `http://127.0.0.1:3000` ni
`http://localhost:3000`. Para trabajar con el backend local usa la variante de
desarrollo (seccion 11): `node scripts/empaquetar-extension.mjs --dev`, descomprime
`dist/extension/adaceen-chromium-<version>-dev.zip` y carga esa carpeta.

## 2) Configurar backend

En Configuracion del overlay (icono de tuerca), campo `Base URL del backend`:
1. Ingresa la URL base del proxy (por ejemplo `http://127.0.0.1:3000` con la variante `-dev`). Solo se aceptan URL `http://` o `https://`.
2. Pulsa `Guardar cambios`.

(El boton `Probar` y la `Fuente de sugerencias` son del popup, que no esta conectado como `default_popup` y no va en el paquete.)

## 3) Credenciales demo

Desde 0.7.11 la vista de login solo las muestra (y precarga la de estudiante) con el backend en `localhost` o `127.0.0.1`.

- Estudiante: `estudiante@adaceen.edu.co / Estudiante123!`
- Profesor: `docente@adaceen.edu.co / Docente123!`
- Admin: `admin@adaceen.edu.co / Admin123!`

## 4) Flujo contextual recomendado

La extension muestra un hub por modulos:

- `ADACEEN`: sesion del usuario.
- `GitHub App`: conexion/permisos para leer repo, rama y PR (con el proveedor `tunnel` la fila no aparece).
- `GitHub OAuth`: cuenta del estudiante (con Codespaces, para crear/reanudar su Codespace; con el tunel, para registrar el editor a su nombre).
- `Campus`: deteccion de actividad academica.
- `Codespaces` (con el tunel se llama `Editor`): preparacion o estado del entorno.
- `VS Code`: aparece en GitHub cuando la extension de VS Code publico contexto hace poco para el repo actual.

Cada vista responde:

1. Donde estoy.
2. Que detecto ADACEEN.
3. Cual es el siguiente paso.

No hay redireccion automatica a GitHub. La extension muestra primero el contexto y abre GitHub solo cuando el usuario pulsa `Conectar GitHub`.

## 5) Deteccion de contexto

- `github_code`: URL con `/blob/` y codigo visible.
- `github_general`: repo/pagina GitHub sin archivo abierto.
- `codespace`: dominios `github.dev`, `*.github.dev`, `app.github.dev`, `*.app.github.dev`.
- `other`: cualquier otro sitio.

Cuando detecta Codespace, el popup muestra bienvenida y mensaje de inicio para programar.

## 6) Endpoint esperado en backend

`POST /github-mentor`

Body esperado:
```json
{
  "question": "texto opcional",
  "max_items": 6,
  "context": {
    "url": "...",
    "title": "...",
    "pageType": "github_code",
    "repoFullName": "owner/repo",
    "filePath": "src/app.ts",
    "languageHint": "TypeScript",
    "codeSnippet": "...",
    "codeLineCount": 120
  }
}
```

Respuesta esperada:
```json
{
  "ok": true,
  "source": "ai",
  "result": {
    "ideas": ["..."],
    "searches": ["..."],
    "guide": ["..."],
    "welcome_message": "...",
    "analysis_summary": "..."
  }
}
```

## 7) Permisos usados

Justificacion completa en `docs/seguridad/permisos-extension.md`.

- `activeTab`: inyectar el overlay al pulsar el icono y capturar la pantalla para el OCR visual.
- `storage`: preferencias, sesion compartida entre pestanas, estado por pestana e id anonimo (`adaceenClientId`).
- `scripting`: reinyectar los content scripts desde el service worker.
- `identity`: login con Google y autorizacion de Google Calendar (`calendar.events`, para agendar las actividades que publica el profesor y, desde la 0.7.17, la agenda del curso: leer eventos para no repetir y buscar horas libres, y mover los de ADACEEN).
- `host_permissions`: Campus Virtual, GitHub/Codespaces, vscode.dev (tuneles), la API de Google Calendar y el backend de produccion `https://app-adaceen-api-eyder05232002.azurewebsites.net`. El backend local solo en la variante `-dev`.

## 8) Flujo estable con GitHub App

Con el proveedor `tunnel` (el del piloto) el tour tiene un solo paso, «Conectar GitHub», y no usa la GitHub App: ver la version 0.7.11 arriba y `docs/guia-instalacion-uso.md`, seccion 1.4. Lo que sigue es el tour con el proveedor `codespaces`.

Para el `estudiante` existe un **Tour de configuracion inicial** (antes del dashboard principal), con una sola tarjeta y un boton unico en «Accion recomendada»:

1. Confirmar o detectar el repositorio objetivo (con el repositorio de la pagina no hace falta).
2. Pulsar «Autorizar GitHub App» para instalar la GitHub App sobre el repo. ADACEEN detecta la instalacion solo (consulta `/api/github-app/status` cada pocos segundos) y pasa al siguiente paso.
3. Pulsar «Conectar GitHub» para conectar la cuenta del estudiante por OAuth. Al volver, ADACEEN sigue solo con el paso 4 en esa misma ventana.
4. Si la cuenta ya estaba conectada, pulsar «Preparar entorno ADACEEN» para crear/reusar branch + PR con `.devcontainer/devcontainer.json`.
5. Al crear o detectar el PR, ADACEEN llama `POST /github/prepare-environment`.
6. El backend usa el token OAuth del estudiante para buscar un Codespace existente, reanudarlo si esta apagado o crear uno nuevo desde la PR por API.
7. Cuando GitHub devuelve `web_url`, la extension abre ese Codespace automaticamente.
8. Si GitHub exige login, cuota o confirmacion manual, ADACEEN conserva `codespaces.new` como fallback visual.
9. Al completar ese tour, se habilita el dashboard principal.

La UI bloquea la preparacion si falta GitHub App, acceso al repo u OAuth del estudiante con scope `codespace`.
Para produccion/piloto configura `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_CALLBACK_URL` y `GITHUB_OAUTH_SCOPES=repo codespace read:user user:email`.
`GITHUB_CODESPACES_USER_TOKEN` queda solo como respaldo de desarrollo.

Para `admin` y `profesor` (desde 0.7.12):
- No se ejecuta el tour inicial.
- Entran directo al panel principal (el admin, al de administracion de usuarios).
- Si necesita conectar GitHub App o rehacer PR, lo hace manualmente desde `Configuracion` (icono de tuerca).

Endpoints usados:
- `GET /api/github-app/status`
- `POST /api/github-app/install-url`
- `GET /api/github-app/callback`
- `GET /api/github/oauth/status`
- `POST /api/github/oauth/start`
- `GET /auth/github/callback`
- `POST /github/prepare-environment`
- `POST /api/github-app/link-installation-auto`

## 9) Campus Virtual y agenda

En Campus Virtual, el hub prioriza actividad, fecha visible y accion academica. Al entrar en un curso, ADACEEN verifica solo el acceso y la bitacora (`GET /api/documents/bitacora/status`); con eso, «Analizar Campus» lee las actividades visibles y «Sincronizar agenda» las guarda en Google Calendar. «Verificar acceso» solo aparece si la verificacion falla o falta la bitacora.

## 10) Telemetria v1.1 y senales

`services/telemetry.service.js` envia eventos a `POST {backend}/api/behavior/events`
(contrato de la rama `feat/cierre-pendientes-jira`):

- Cola en memoria; lote cada 5 s o al juntar 10 eventos (max. 50 por peticion); un
  reintento ante error de red, timeout, 429 o 5xx; al salir de la pagina (`pagehide`) se
  vacia con `fetch(..., { keepalive: true })`. Sin persistencia offline.
- Cabeceras: las de `buildApiHeaders()` (`x-session-id` si hay sesion) y siempre
  `x-adaceen-client-id` (se genera una vez y se guarda en `chrome.storage.local` con la
  clave `adaceenClientId`).
- Cada evento lleva `source: "browser_extension"`, `schemaVersion: "1.1"`, `seq`
  monotono y `clientSessionId` (uno por carga de pagina).
- Eventos: `overlay_opened` / `overlay_closed` (`metadata.trigger`/`reason`),
  `tutor_request_submitted` (`manual`, `shortcut` o `auto`), `tutor_response_received`
  (`decisionId`, `latencyMs`, `value` = origen, `metadata.blocked`),
  `tutor_response_shown`, `tutor_response_accepted` / `tutor_response_rejected`
  (botones bajo la respuesta), `tutor_response_ignored` (reemplazada, overlay cerrado o
  pagina abandonada sin opinion), `rag_source_opened`, `error_detected` y
  `blocking_detected` (mismo error visible >= 120 s o 3 veces en 10 min).
- El texto del error (`errorText`, max. 300) solo viaja en el evento; el servidor lo
  convierte en hash. Las senales solo se observan con el overlay abierto, iniciado y con
  el tutor activo.

## 11) Empaquetado (Chromium y Firefox)

```bash
node scripts/empaquetar-extension.mjs         # produccion
node scripts/empaquetar-extension.mjs --dev   # agrega el backend local
```

Sin `popup/` ni `content.js` (codigo muerto). Genera en `dist/extension/` (ignorado por git): `adaceen-chromium-<version>.zip`,
`adaceen-firefox-<version>.zip` (mismo codigo + `browser_specific_settings.gecko`,
`strict_min_version 128.0` y `background.scripts`), las variantes `-dev` y
`SHA256SUMS.txt`. El script valida el manifest (archivos referenciados, orden de
`CONTENT_SCRIPT_FILES`, hosts de produccion), vuelve a leer cada zip y compara CRC y
contenido. Con las mismas fuentes el zip es identico byte a byte. El manifest de Firefox
declara ademas `data_collection_permissions` (addons.mozilla.org lo exige para firmar).

Google en Firefox: `background.js` no tiene `chrome.identity.getAuthToken` alli y usa
`chrome.identity.launchWebAuthFlow` (flujo implicito de Google, token en
`chrome.storage.local` con su vencimiento). Necesita un cliente OAuth de tipo «Aplicacion web»
que el empaquetador pone en el manifest de Firefox como `adaceenGoogleWebClientId` desde la
variable `GOOGLE_WEB_CLIENT_ID` (entorno o `.env`); sin ella el zip de Firefox sale «sin
Google» y el overlay muestra «Inicio de sesion con Google no configurado en este paquete de la
extension.». El backend acepta ese cliente con `GOOGLE_CLIENT_IDS`. Pasos en
`docs/operacion/google-oauth-firefox.md`.

Paquetes firmados, opcionales (docs/operacion/publicar-extension.md): `node scripts/empaquetar-crx.mjs`
envuelve el zip de Chromium en un CRX3 firmado con la clave RSA de `CRX_PRIVATE_KEY_PEM_FILE`
(o `CRX_PRIVATE_KEY_PEM`) y genera `adaceen-update.xml`, el manifiesto que usa la politica
`ExtensionInstallForcelist` de los equipos gestionados; sin clave sale con codigo 2 y no toca
los zip. El XPI permanente de Firefox lo firma addons.mozilla.org (`npx web-ext sign`).
