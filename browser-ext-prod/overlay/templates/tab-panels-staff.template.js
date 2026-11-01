// ADACEEN | Capa 4 - UI: markup de las pestanas del docente y del administrador (Estudiantes, RAG, Quices,
// Bitacora y Usuarios). Movido sin cambios de tab-panels.template.js; shell.template.js las interpola igual.

function buildTabPanelEstudiantesTemplate() {
  return `<div class="tab-panel" id="tabPanelEstudiantes" role="tabpanel" aria-labelledby="tabBtnEstudiantes" hidden>
            <!-- Tema del piloto (0.7.21): semana de la bitácora y ejercicio; los estudiantes lo ven en Inicio. -->
            <section class="panel-section pilot-topic-section" id="pilotTopicSection" aria-labelledby="pilotTopicTitle" hidden>
              <div class="section-title-row">
                <h2 id="pilotTopicTitle">Tema del piloto</h2>
                <span class="state-chip" id="pilotTopicChip">Sin tema</span>
              </div>
              <p class="policy-lead" id="pilotTopicStatus" role="status">Consultando el tema del piloto...</p>
              <div class="pilot-topic-form">
                <label class="field field-stack" id="pilotTopicTeacherField" hidden>
                  <span class="field-title">Docente</span>
                  <select id="pilotTopicTeacher"></select>
                </label>
                <label class="field field-stack">
                  <span class="field-title">Semana de la bitácora</span>
                  <select id="pilotTopicWeek"></select>
                </label>
                <label class="field field-stack">
                  <span class="field-title">Tema</span>
                  <input id="pilotTopicTitleInput" type="text" maxlength="160" placeholder="Tema de la clase" autocomplete="off" />
                </label>
                <label class="field field-stack">
                  <span class="field-title">Ejercicio: repositorio público de GitHub</span>
                  <input id="pilotTopicRepo" type="text" maxlength="300" placeholder="usuario/repositorio o enlace de GitHub" autocomplete="off" spellcheck="false" />
                </label>
                <button class="ghost-button pilot-topic-page-repo" id="pilotTopicUsePageRepoBtn" type="button" hidden>Usar el repositorio de esta página</button>
              </div>
              <div class="button-row split tight-row">
                <button class="ghost-button danger-button" id="pilotTopicClearBtn" type="button">Quitar tema</button>
                <button class="save-button" id="pilotTopicSaveBtn" type="button">Guardar tema</button>
              </div>
            </section>

            <!-- Lista de estudiantes con sesiones, intervenciones, quices y nota (GET /api/admin/students). -->
            <section class="panel-section students-section" id="studentsSection" aria-labelledby="studentsTitle">
              <div class="kpi-grid students-kpis" id="studentsKpis" role="group" aria-label="Resumen de los estudiantes"></div>
              <div class="section-title-row students-toolbar">
                <h2 id="studentsTitle">Estudiantes</h2>
                <div class="summary-actions">
                  <input class="students-search" id="studentsSearchInput" type="search" aria-label="Buscar estudiante" placeholder="Buscar por nombre o correo" autocomplete="off" />
                  <!-- Gestión como en «Usuarios» (0.7.22): los mismos formularios se abren aquí. -->
                  <button class="ghost-button analyze-button" id="studentsToggleImportBtn" type="button" aria-controls="adminImportPanel" aria-expanded="false">Importar lista</button>
                  <button class="ghost-button analyze-button" id="studentsToggleCreateBtn" type="button" aria-controls="adminCreateForm" aria-expanded="false">Agregar estudiante</button>
                  <button class="ghost-button analyze-button" id="studentsReloadBtn" type="button">Recargar</button>
                </div>
              </div>
              <p class="policy-lead" id="studentsStatus" role="status">Abre la pestaña para cargar el progreso.</p>
              <div class="admin-forms-host" id="studentsFormsHost"></div>
              <div class="users-bulk-bar" id="studentsBulkBar" role="region" aria-label="Estudiantes seleccionados" hidden>
                <span class="users-bulk-count" id="studentsBulkCount">0 seleccionados</span>
                <button class="ghost-button analyze-button" id="studentsBulkClearBtn" type="button">Quitar selección</button>
                <button class="ghost-button analyze-button danger-button" id="studentsBulkDeleteBtn" type="button">Eliminar seleccionados</button>
              </div>
              <div class="admin-table-wrap table-section students-table-wrap">
                <table class="admin-table students-table" aria-label="Progreso de los estudiantes">
                  <thead>
                    <tr>
                      <th class="admin-select-cell"><input type="checkbox" id="studentsSelectAll" aria-label="Seleccionar todos los estudiantes de la lista" /></th>
                      <th>Estudiante</th>
                      <th>Sesiones</th>
                      <th>Ultima actividad</th>
                      <th>Tutor</th>
                      <th>Quices</th>
                      <th>Nota</th>
                      <th>Acciones</th>
                    </tr>
                  </thead>
                  <tbody id="studentsTableBody"></tbody>
                </table>
              </div>
              <details class="students-telemetry teacher-only" id="teacherTelemetrySection" hidden>
                <summary>
                  <span>Telemetria reciente</span>
                  <button class="ghost-button analyze-button" id="reloadTelemetryBtn" type="button">Recargar</button>
                </summary>
                <ul class="telemetry-list" id="telemetryList"></ul>
              </details>
            </section>

            <!-- Detalle de un estudiante (GET /api/admin/students/:userId). -->
            <section class="panel-section student-detail" id="studentDetailSection" aria-labelledby="studentDetailTitle" hidden>
              <div class="section-title-row student-detail-head">
                <div class="student-detail-heading">
                  <button class="ghost-button analyze-button" id="studentDetailBackBtn" type="button">&larr; Estudiantes</button>
                  <div>
                    <h2 id="studentDetailTitle">Estudiante</h2>
                    <p class="summary-meta" id="studentDetailMeta">Sin datos</p>
                  </div>
                </div>
                <div class="summary-actions">
                  <span class="state-chip" id="studentDetailChip">Sin sesiones</span>
                  <button class="ghost-button analyze-button" id="studentDetailReloadBtn" type="button">Recargar</button>
                </div>
              </div>
              <p class="policy-lead student-detail-status" id="studentDetailStatus" role="status" hidden></p>
              <div class="kpi-grid student-detail-kpis" id="studentDetailKpis" role="group" aria-label="Indicadores del estudiante"></div>
              <div class="student-timeline" id="studentDetailTimeline" role="img" aria-label="Actividad de los ultimos 14 dias"></div>
              <div class="timeline-legend" id="studentDetailTimelineLegend" aria-hidden="true" hidden><span class="is-sessions">Sesiones</span><span class="is-interventions">Intervenciones</span><span class="is-quizzes">Quices</span><span>Ultimos 14 dias, un dia por columna</span></div>
              <div class="student-detail-columns">
                <section class="student-detail-block" aria-labelledby="studentDetailQuizzesTitle">
                  <h3 id="studentDetailQuizzesTitle">Quices y calificaciones</h3>
                  <ul class="compact-list student-detail-list" id="studentDetailQuizzes"></ul>
                </section>
                <section class="student-detail-block" aria-labelledby="studentDetailSessionsTitle">
                  <h3 id="studentDetailSessionsTitle">Sesiones recientes</h3>
                  <ul class="compact-list student-detail-list" id="studentDetailSessions"></ul>
                </section>
                <section class="student-detail-block" aria-labelledby="studentDetailInterventionsTitle">
                  <h3 id="studentDetailInterventionsTitle">Intervenciones del tutor</h3>
                  <ul class="compact-list student-detail-list" id="studentDetailInterventions"></ul>
                </section>
                <section class="student-detail-block" aria-labelledby="studentDetailActivityTitle">
                  <h3 id="studentDetailActivityTitle">Actividad y ejercicios</h3>
                  <ul class="compact-list student-detail-list" id="studentDetailActivity"></ul>
                </section>
              </div>
            </section>
            </div>`;
}

function buildTabPanelRagTemplate() {
  return `<div class="tab-panel" id="tabPanelRag" role="tabpanel" aria-labelledby="tabBtnRag" hidden>
            <!-- RAG por curso (0.7.14): todos los cursos del docente, con cargar y retirar por curso. -->
            <section class="panel-section rag-courses-section" id="ragCoursesSection" aria-labelledby="ragCoursesTitle" hidden>
              <div class="section-title-row rag-courses-head">
                <div>
                  <h2 id="ragCoursesTitle">RAG por curso</h2>
                  <p class="summary-meta" id="ragCoursesStatus">Cargando cursos, lotes y fuentes...</p>
                </div>
                <div class="summary-actions">
                  <button class="ghost-button analyze-button" id="ragCoursesRefreshBtn" type="button">Actualizar</button>
                </div>
              </div>
              <!-- Administrador (0.7.22): el docente cuyo RAG se gestiona (el RAG es de cada docente). -->
              <div class="field bitacora-owner-field" id="ragOwnerField" hidden>
                <label for="ragOwnerSelect">Docente</label>
                <select id="ragOwnerSelect"></select>
                <p class="settings-note" id="ragOwnerNote">El RAG es de cada docente: lo que cargues aquí queda en el RAG de ese docente y lo reciben sus estudiantes.</p>
              </div>
              <div class="rag-course-groups" id="ragCourseGroups"></div>
              <p class="status" id="ragCoursesMessage" role="status"></p>
            </section>
            </div>`;
}

function buildTabPanelQuicesTemplate() {
  return `<div class="tab-panel" id="tabPanelQuices" role="tabpanel" aria-labelledby="tabBtnQuices" hidden>
            <!-- Quices del docente (0.7.15): lanzar por tema, el banco propio y los quices hechos por los estudiantes. -->
            <section class="panel-section quizzes-section" id="quizzesSection" aria-labelledby="quizzesTitle" hidden>
              <div class="section-title-row">
                <div>
                  <h2 id="quizzesTitle">Quices</h2>
                  <p class="summary-meta" id="quizzesStatus">Cargando quices...</p>
                </div>
                <div class="summary-actions">
                  <button class="ghost-button analyze-button" id="quizzesRefreshBtn" type="button">Actualizar</button>
                  <!-- «Monitor»: la pagina /docente/monitor del backend en otra pestana (lo de npm run piloto:monitor). -->
                  <button class="ghost-button analyze-button" id="quizzesMonitorBtn" type="button" title="Monitor en vivo del piloto: backend, modelo, editor en la nube, bloque, estudiantes activos y alertas">Monitor</button>
                  <button class="primary-button analyze-button" id="quizzesCreateBtn" type="button">Crear quiz</button>
                </div>
              </div>
              <div class="field quiz-launch-field">
                <label for="teacherQuizTopic">Lanzar un quiz a la clase</label>
                <div class="quiz-launch-row">
                  <input id="teacherQuizTopic" type="text" placeholder="Tema, por ejemplo: encapsulamiento" />
                  <button class="save-button" id="teacherQuizLaunchBtn" type="button">Lanzar quiz</button>
                  <button class="ghost-button" id="teacherQuizCloseBtn" type="button">Cerrar quiz activo</button>
                </div>
                <p class="quiz-status" id="teacherQuizStatus" role="status"></p>
              </div>
              <div class="quizzes-columns">
                <section class="quizzes-block" aria-labelledby="quizzesBankTitle">
                  <h3 id="quizzesBankTitle">Mis quices <span class="tab-count" id="quizzesBankCount" hidden></span></h3>
                  <p class="summary-meta">Los que creaste en «Crear quiz». Lanzar los manda a tus estudiantes 60 minutos.</p>
                  <ul class="quiz-bank-list" id="quizzesBankList"></ul>
                  <p class="students-empty" id="quizzesBankEmpty" hidden>Todavia no tienes quices propios. «Crear quiz» abre la pagina para escribirlos o generarlos.</p>
                </section>
                <section class="quizzes-block" aria-labelledby="quizzesDoneTitle">
                  <h3 id="quizzesDoneTitle">Quices hechos <span class="tab-count" id="quizzesDoneCount" hidden></span></h3>
                  <p class="summary-meta" id="quizzesDoneSummary">Respuestas de tus estudiantes, del mini quiz y de los lanzados.</p>
                  <div class="table-section quiz-attempts-wrap">
                    <table class="admin-table quiz-attempts-table" aria-label="Quices hechos por estudiantes">
                      <thead>
                        <tr><th>Estudiante</th><th>Tema</th><th>Resultado</th><th>Fecha</th></tr>
                      </thead>
                      <tbody id="quizzesDoneBody"></tbody>
                    </table>
                  </div>
                  <p class="students-empty" id="quizzesDoneEmpty" hidden>Tus estudiantes no han respondido quices todavia.</p>
                </section>
              </div>
              <p class="status" id="quizzesMessage" role="status"></p>
            </section>
            </div>`;
}

function buildTabPanelBitacoraTemplate() {
  return `<div class="tab-panel" id="tabPanelBitacora" role="tabpanel" aria-labelledby="tabBtnBitacora" hidden>
            <!-- Bitácora del docente (0.7.16): antes era una página aparte que se abría con el botón «Bitacora» de Inicio. -->
            <section class="panel-section bitacora-section" id="teacherBitacoraSection" aria-labelledby="teacherBitacoraTitle">
              <div class="section-title-row">
                <div>
                  <h2 id="teacherBitacoraTitle">Bitácora del curso</h2>
                  <p class="summary-meta" id="teacherBitacoraStatusText">Consultando la bitácora...</p>
                </div>
                <div class="summary-actions">
                  <span class="state-chip" id="teacherBitacoraStateChip">Consultando</span>
                  <button class="ghost-button analyze-button" id="teacherBitacoraRefreshBtn" type="button">Actualizar</button>
                </div>
              </div>
              <!-- Administrador (0.7.22): el docente cuya bitácora se gestiona (la bitácora es de cada docente). -->
              <div class="field bitacora-owner-field" id="teacherBitacoraOwnerField" hidden>
                <label for="teacherBitacoraOwnerSelect">Docente</label>
                <select id="teacherBitacoraOwnerSelect"></select>
                <p class="settings-note" id="teacherBitacoraOwnerNote">La bitácora es de cada docente: sus estudiantes la ven en «Agenda» y el tutor la usa para saber en qué semana van.</p>
              </div>
              <div class="bitacora-dropzone" id="teacherBitacoraDropZone">
                <p class="bitacora-dropzone-title" id="teacherBitacoraLatestText">Aún no hay bitácora cargada.</p>
                <p class="bitacora-dropzone-hint" id="teacherBitacoraDropHint">Arrastra aquí el Excel o el PDF de la bitácora, o elígelo con el botón.</p>
                <button class="primary-button bitacora-upload-button" id="teacherBitacoraChooseFileBtn" type="button">Subir bitácora (Excel/PDF)</button>
                <p class="bitacora-dropzone-note">Excel (.xlsx, .xls) o PDF, hasta 12 MB. Si ya hay una bitácora, la nueva la reemplaza.</p>
              </div>
              <!-- Inicio del semestre (0.7.17): corre las fechas de la bitácora cargada. -->
              <div class="bitacora-start-row" id="teacherBitacoraStartRow">
                <label for="teacherBitacoraStartDateInput">Inicio del semestre</label>
                <input id="teacherBitacoraStartDateInput" type="date" />
                <button class="ghost-button" id="teacherBitacoraStartApplyBtn" type="button">Correr fechas</button>
                <p class="bitacora-start-note" id="teacherBitacoraStartNote">La semana 1 queda ese día y las demás conservan su distancia (cada 7 días).</p>
              </div>
              <input id="teacherBitacoraFileInput" type="file" accept=".xlsx,.xls,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" hidden />
              <div class="button-row bitacora-tools">
                <button class="ghost-button" id="teacherBitacoraDownloadTemplateBtn" type="button">Descargar plantilla</button>
                <button class="ghost-button" id="teacherBitacoraExportXlsxBtn" type="button">Exportar bitácora (Excel)</button>
                <button class="ghost-button" id="teacherBitacoraExportCsvBtn" type="button">Exportar bitácora (CSV)</button>
              </div>
              <p class="settings-note bitacora-tools-note">La plantilla trae las columnas Semana, Fecha, Tema, Clasificación, Actividades en clase y Actividades evaluación; también puedes guardarla como PDF. Lo exportado en Excel se puede volver a subir aquí y el CSV sirve para Excel o Power BI.</p>
              <details class="bitacora-fold" id="teacherBitacoraWeeksFold">
                <summary>Semanas cargadas <span class="tab-count" id="teacherBitacoraWeekCount" hidden></span></summary>
                <ul class="compact-list" id="teacherBitacoraAgendaList"></ul>
              </details>
              <details class="bitacora-fold" id="teacherBitacoraManualFold">
                <summary>Registro manual</summary>
                <p class="settings-note">Agrega una actividad sin subir un archivo; queda en la bitácora cargada.</p>
                <div class="bitacora-manual-grid">
                  <div class="field">
                    <label for="teacherBitacoraManualWeekInput">Semana</label>
                    <input id="teacherBitacoraManualWeekInput" type="number" min="1" max="20" inputmode="numeric" placeholder="1">
                  </div>
                  <div class="field">
                    <label for="teacherBitacoraManualDateInput">Fecha</label>
                    <input id="teacherBitacoraManualDateInput" type="text" placeholder="aaaa-mm-dd">
                  </div>
                  <div class="field">
                    <label for="teacherBitacoraManualCategorySelect">Clasificación</label>
                    <select id="teacherBitacoraManualCategorySelect">
                      <option value="Actividad">Actividad</option>
                      <option value="Proyecto">Proyecto</option>
                      <option value="Ejercicio">Ejercicio</option>
                      <option value="Parcial">Parcial</option>
                      <option value="Quiz">Quiz</option>
                    </select>
                  </div>
                  <div class="field">
                    <label for="teacherBitacoraManualTitleInput">Título</label>
                    <input id="teacherBitacoraManualTitleInput" type="text" maxlength="260" placeholder="Actividad o entrega">
                  </div>
                  <div class="field bitacora-manual-full">
                    <label for="teacherBitacoraManualDescriptionInput">Detalle</label>
                    <textarea id="teacherBitacoraManualDescriptionInput" maxlength="1600" placeholder="Tema, evidencia o instrucciones"></textarea>
                  </div>
                </div>
                <div class="button-row split">
                  <button class="primary-button" id="teacherBitacoraManualSaveBtn" type="button">Guardar registro</button>
                  <button class="ghost-button" id="teacherBitacoraManualClearBtn" type="button">Limpiar</button>
                </div>
              </details>
              <details class="bitacora-fold is-danger" id="teacherBitacoraDataFold">
                <summary>Borrar datos</summary>
                <p class="settings-note">«Eliminar bitácora» quita la más reciente (si subiste otra antes, esa vuelve a quedar como la cargada). «Borrar todos los datos» quita todas: tus estudiantes se quedan sin agenda hasta que subas otra.</p>
                <div class="button-row split">
                  <button class="ghost-button danger-button" id="teacherBitacoraDeleteLatestBtn" type="button">Eliminar bitácora</button>
                  <button class="ghost-button danger-button" id="teacherBitacoraClearDataBtn" type="button">Borrar todos los datos</button>
                </div>
              </details>
            </section>
            </div>`;
}

function buildTabPanelUsuariosTemplate() {
  return `<div class="tab-panel" id="tabPanelUsuarios" role="tabpanel" aria-labelledby="tabBtnUsuarios" hidden>
            <section class="panel-section" id="adminUsersSection" aria-labelledby="adminUsersTitle" hidden>
              <!-- Dirección B (0.7.22): título con el conteo, búsqueda y acciones en una fila. -->
              <div class="users-toolbar">
                <div class="users-toolbar-title">
                  <h2 id="adminUsersTitle">Usuarios</h2>
                  <p class="users-count" id="adminUsersStatus">Carga los usuarios para empezar.</p>
                </div>
                <label class="sr-only" for="adminUsersSearch">Buscar por nombre, correo o código</label>
                <input class="users-search" id="adminUsersSearch" type="search" autocomplete="off" placeholder="Nombre, correo o código" />
                <div class="summary-actions">
                  <button class="ghost-button analyze-button" id="adminToggleImportBtn" type="button" aria-controls="adminImportPanel" aria-expanded="false">Importar lista</button>
                  <button class="ghost-button analyze-button" id="adminToggleCreateUserBtn" type="button" aria-controls="adminCreateForm" aria-expanded="false">Agregar usuario</button>
                  <button class="ghost-button analyze-button" id="adminReloadUsersBtn" type="button">Recargar</button>
                </div>
              </div>

              <!-- «Eliminar seleccionados» (0.7.22): aparece al marcar estudiantes en la tabla. -->
              <div class="users-bulk-bar" id="adminUsersBulkBar" role="region" aria-label="Estudiantes seleccionados" hidden>
                <span class="users-bulk-count" id="adminUsersBulkCount">0 seleccionados</span>
                <button class="ghost-button analyze-button" id="adminUsersBulkClearBtn" type="button">Quitar selección</button>
                <button class="ghost-button analyze-button danger-button" id="adminUsersBulkDeleteBtn" type="button">Eliminar seleccionados</button>
              </div>

              <!-- Codigo de estudiante (0.7.22): correos nuevos que piden entrar a la cuenta de un codigo que ya entro. -->
              <div class="admin-access-requests" id="adminAccessRequests" role="region" aria-labelledby="adminAccessRequestsTitle" hidden>
                <span class="field-title" id="adminAccessRequestsTitle">Solicitudes de acceso</span>
                <p class="field-hint">Alguien entró con un correo nuevo y escribió un código que ya tiene una cuenta. Si es la misma persona, aprueba: ese correo pasa a ser otro acceso de su cuenta.</p>
                <ul class="compact-list admin-access-request-list" id="adminAccessRequestList"></ul>
              </div>

              <!-- Docente de las cuentas nuevas (0.7.21, solo administrador): quien entra por primera vez con Google queda con él. -->
              <div class="admin-default-teacher" id="adminDefaultTeacherRow" hidden>
                <label class="field-title" for="adminDefaultTeacherSelect">Docente de las cuentas nuevas</label>
                <select id="adminDefaultTeacherSelect"></select>
                <p class="field-hint" id="adminDefaultTeacherNote">Quien entra por primera vez con Google queda con este docente.</p>
              </div>

              <!-- Los formularios de importar y agregar viven aquí y se mudan a «Estudiantes» cuando esa pestaña está a la vista (0.7.22). -->
              <div class="admin-forms-host" id="adminUsersFormsHost">
              <!-- Importar la lista de un curso de Campus (0.7.21): CSV de «Participantes» o la tabla pegada. -->
              <div class="field field-stack admin-import-panel" id="adminImportPanel" role="group" aria-labelledby="adminImportTitle" hidden>
                <span class="field-title" id="adminImportTitle">Importar la lista de un curso de Campus</span>
                <div class="admin-import-source">
                  <button class="ghost-button" id="adminImportFileBtn" type="button">Elegir CSV de Campus</button>
                  <span class="admin-import-file" id="adminImportFileName"></span>
                </div>
                <input id="adminImportFileInput" type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" hidden />
                <textarea id="adminImportText" rows="3" aria-label="Lista de participantes pegada desde Campus" placeholder="...o pega aquí la tabla de «Participantes» (nombre, correo y rol)"></textarea>
                <p class="policy-lead admin-import-summary" id="adminImportSummary" role="status"></p>
                <ul class="compact-list admin-import-teachers" id="adminImportTeachers" hidden></ul>
                <div class="button-row split tight-row">
                  <select id="adminImportTeacher" aria-label="Docente de los estudiantes importados"></select>
                  <select id="adminImportCourse" aria-label="Curso de los estudiantes importados"></select>
                </div>
                <label class="check-row" id="adminImportIncludeOtherRow" hidden><input id="adminImportIncludeOther" type="checkbox" /> <span id="adminImportIncludeOtherLabel">Incluir también los de otro correo</span></label>
                <label class="check-row" id="adminImportSetDefaultRow" hidden><input id="adminImportSetDefault" type="checkbox" checked /> <span id="adminImportSetDefaultLabel">Quien entre por primera vez con Google también queda con este docente</span></label>
                <div class="button-row split tight-row">
                  <button class="ghost-button" id="adminImportCancelBtn" type="button">Cancelar</button>
                  <button class="save-button" id="adminImportBtn" type="button">Importar</button>
                </div>
                <ul class="compact-list admin-import-result" id="adminImportResult" hidden></ul>
              </div>

              <div class="field field-stack admin-create-form" id="adminCreateForm" role="group" aria-labelledby="adminCreateTitle" hidden>
                <span class="field-title" id="adminCreateTitle">Agregar usuario</span>
                <div class="button-row split tight-row">
                  <select id="adminCreateRole" aria-label="Rol del nuevo usuario">
                    <option value="student">Estudiante</option>
                    <option value="teacher">Profesor</option>
                  </select>
                  <input id="adminCreateName" type="text" aria-label="Nombre completo" placeholder="Nombre completo" />
                </div>
                <div class="button-row split tight-row">
                  <input id="adminCreateEmail" type="text" aria-label="Correo del nuevo usuario" placeholder="correo@adaceen.edu.co" />
                  <input id="adminCreatePassword" type="password" autocomplete="new-password" aria-label="Contraseña temporal" placeholder="Contrasena temporal" />
                </div>
                <input id="adminCreateStudentCode" class="admin-create-code" type="text" inputmode="numeric" autocomplete="off" aria-label="Código de estudiante (opcional, 7 dígitos)" placeholder="Código de estudiante (opcional, 7 dígitos)" />
                <div class="button-row split tight-row">
                  <select id="adminCreateTeacher" aria-label="Profesor asignado">
                    <option value="">Profesor por defecto</option>
                  </select>
                  <button class="save-button" id="adminCreateBtn" type="button">Crear usuario</button>
                </div>
                <div class="course-picker" id="adminCreateCoursePicker">
                  <span class="eyebrow" id="adminCreateCoursesTitle">Cursos del estudiante</span>
                  <div class="course-chip-grid" id="adminCreateCourseGrid" role="group" aria-labelledby="adminCreateCoursesTitle"></div>
                </div>
              </div>
              </div>

              <div class="admin-table-wrap table-section users-table-wrap">
                <table class="admin-table admin-users-table" aria-label="Usuarios administrables">
                  <thead>
                    <tr>
                      <th class="admin-select-cell"><input type="checkbox" id="adminUsersSelectAll" aria-label="Seleccionar todos los estudiantes de la lista" /></th>
                      <th>Usuario</th>
                      <th>Código</th>
                      <th class="admin-teacher-head">Profesor</th>
                      <th>Cursos</th>
                      <th>RAG aplicado</th>
                      <th>Estado</th>
                      <th>Acciones</th>
                    </tr>
                  </thead>
                  <tbody id="adminUsersTableBody"></tbody>
                </table>
              </div>
            </section>
            </div>`;
}
