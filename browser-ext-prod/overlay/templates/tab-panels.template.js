// ADACEEN | Capa 4 - UI: markup de las pestanas de la vista principal (Inicio, Tutor, Agenda,
// Estudiantes, RAG, Quices, Bitacora y Usuarios). Texto identico al que estaba dentro de
// buildOverlayShellTemplate(), que ahora las interpola con ${buildTabPanel...Template()}; la pestana
// «Bitacora» es de la 0.7.16 y «Agenda» (del estudiante) de la 0.7.17.
// Sin "use strict": sale de shell.template.js (modo no estricto) y se conserva igual.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

function buildTabPanelInicioTemplate() {
  return `<div class="tab-panel" id="tabPanelInicio" role="tabpanel" aria-labelledby="tabBtnInicio">
            <section class="context-hub" id="contextHubSection">
              <div class="context-hub-head">
                <div>
                  <span class="eyebrow" id="contextEyebrow">Contexto actual</span>
                  <h2 id="contextTitle">Detectando contexto</h2>
                  <p class="context-meta" id="contextMeta">Leyendo pagina activa.</p>
                </div>
                <span class="state-chip" id="contextStateChip">Pendiente</span>
              </div>
              <div class="connection-grid" id="connectionGrid"></div>
              <div class="operation-banner" id="contextOperationBanner" hidden>
                <span class="operation-spinner" aria-hidden="true"></span>
                <div>
                  <strong id="contextOperationTitle">Preparando entorno</strong>
                  <p id="contextOperationDetail">ADACEEN esta trabajando.</p>
                </div>
              </div>
              <div class="next-action">
                <div>
                  <span class="eyebrow">Accion recomendada</span>
                  <strong id="contextActionTitle">Siguiente paso</strong>
                  <p id="contextActionCopy">ADACEEN ajustara la accion segun el modulo detectado.</p>
                </div>
                <div class="button-row split context-actions">
                  <button class="ghost-button" id="contextSecondaryActionBtn" type="button">Actualizar</button>
                  <button class="primary-button" id="contextPrimaryActionBtn" type="button">Continuar</button>
                </div>
              </div>
              <!-- Un editor, varios repositorios (0.7.20): los que ya estan en tu editor en la nube, a un clic. -->
              <div class="editor-repos" id="editorReposSection" hidden>
                <span class="eyebrow" id="editorReposTitle">Tus repositorios en el editor</span>
                <ul class="editor-repos-list" id="editorReposList" aria-labelledby="editorReposTitle"></ul>
              </div>
            </section>

            <!-- Bitácora (0.7.16): su estado en una línea que lleva a la pestaña «Bitácora». -->
            <button class="bitacora-home-line teacher-only" id="teacherBitacoraHomeLine" type="button" aria-controls="tabPanelBitacora" hidden>
              <span class="bitacora-home-copy">
                <span class="eyebrow">Bitácora del curso</span>
                <span class="bitacora-home-text" id="teacherBitacoraHomeText">Consultando la bitácora...</span>
              </span>
              <span class="state-chip" id="teacherBitacoraHomeChip">Consultando</span>
              <span class="bitacora-home-go" aria-hidden="true">Abrir</span>
            </button>

            <!-- Agenda del estudiante (0.7.17): la semana del curso según la bitácora; lleva a «Agenda». -->
            <button class="bitacora-home-line agenda-home-line" id="agendaHomeLine" type="button" aria-controls="tabPanelAgenda" hidden>
              <span class="bitacora-home-copy">
                <span class="eyebrow" id="agendaHomeEyebrow">Agenda del curso</span>
                <span class="bitacora-home-text" id="agendaHomeText">Consultando la bitácora del curso...</span>
              </span>
              <span class="state-chip" id="agendaHomeChip">Consultando</span>
              <span class="bitacora-home-go" aria-hidden="true">Abrir</span>
            </button>

            <div class="teacher-card">
              <span class="eyebrow" id="policySectionTitle">Politica aplicada</span>
              <p class="teacher-summary" id="teacherSummary">Docente: tono calido | frecuencia media | ayuda progresiva | RA1</p>
            </div>

            <section class="panel-section teacher-only" id="teacherPolicySection" hidden>
              <h2>Politica docente</h2>
              <ul class="compact-list" id="teacherPolicyList"></ul>
            </section>

            <div class="summary-card">
              <div class="summary-head">
                <span class="eyebrow">Resumen de sesion</span>
                <div class="summary-actions">
                  <button class="ghost-button analyze-button teacher-only" id="teacherRagManageBtn" type="button" hidden>Configurar RAG</button>
                  <button class="ghost-button analyze-button" id="analyzeProjectBtn" type="button">Explorar repo</button>
                  <button class="ghost-button analyze-button" id="rerunOcrBtn" type="button">OCR visual</button>
                </div>
              </div>
              <input id="teacherRagFileInput" type="file" multiple accept=".pdf,.txt,.md,.doc,.docx,.html,.htm,.csv,.json,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden />
              <div class="summary-title" id="detailTitle">Sin detalle detectado</div>
              <div class="summary-meta" id="detailMeta">Sin contexto</div>
              <p class="signal" id="signalText">Sin senales detectadas.</p>
              <p class="policy-lead" id="policyLead">La politica activa aparecera aqui.</p>
              <p class="session-badge" id="sessionBadge">Sesion sin iniciar.</p>
            </div>
            </div>`;
}

function buildTabPanelTutorTemplate() {
  return `<div class="tab-panel" id="tabPanelTutor" role="tabpanel" aria-labelledby="tabBtnTutor" hidden>
            <div class="teacher-card tutor-locked-notice" id="tutorLockedNotice" hidden>
              <span class="eyebrow">Tutor</span>
              <p class="teacher-summary" id="tutorLockedCopy">El tutor se activa cuando ADACEEN lee tu proyecto o tu curso: en el editor pulsa «Explorar repo» y en un curso de Campus «Analizar Campus» (pestaña Inicio). En vscode.dev entra solo.</p>
            </div>
            <section class="panel-section" id="studentGoalSection" aria-labelledby="studentGoalTitle">
              <h2 id="studentGoalTitle">Hoy quiero reforzar</h2>
              <!-- Semana del curso (0.7.17): en el editor el estudiante entra al Tutor; lleva a «Agenda». -->
              <button class="tutor-week-line" id="tutorWeekLine" type="button" aria-controls="tabPanelAgenda" hidden>
                <span class="state-chip" id="tutorWeekChip">Semana</span>
                <span class="tutor-week-text" id="tutorWeekText"></span>
              </button>
              <div class="goal-grid" id="goalGrid" role="group" aria-labelledby="studentGoalTitle"></div>
            </section>

            <!-- Plegada por defecto (0.7.14): las pistas van primero; el resumen del tutor remite aqui. -->
            <details class="panel-section rag-sources-section" id="ragSourcesSection" hidden>
              <summary class="rag-sources-summary">
                <span class="eyebrow" id="ragSourcesTitle">Fuentes RAG usadas</span>
                <span class="rag-sources-count" id="ragSourcesCount"></span>
                <span class="state-chip" id="ragActiveCourseBadge">FPOO</span>
              </summary>
              <p class="rag-sources-note" id="ragSourcesNote">Pulsa + para ver por que se uso cada fuente.</p>
              <ul class="compact-list rag-citation-list" id="ragSourcesList"></ul>
            </details>

            <div class="tutor-response-region" id="tutorResponseRegion" role="region" aria-label="Respuesta del tutor" aria-live="polite" aria-busy="false">
              <section class="panel-section" id="studentIdeasSection" aria-labelledby="studentIdeasTitle">
                <h2 id="studentIdeasTitle">Pistas de hoy</h2>
                <ul id="ideaList"></ul>
              </section>

              <section class="panel-section" id="nextStepSection" aria-labelledby="nextStepTitle">
                <h2 id="nextStepTitle">Siguiente paso</h2>
                <ol id="guideList"></ol>
              </section>
            </div>

            <section class="panel-section tutor-feedback" id="tutorFeedbackSection" aria-labelledby="tutorFeedbackTitle" hidden>
              <h2 id="tutorFeedbackTitle">¿Te sirvió esta ayuda?</h2>
              <div class="tutor-feedback-actions" role="group" aria-labelledby="tutorFeedbackTitle">
                <button class="ghost-button feedback-button" id="tutorFeedbackAcceptBtn" type="button" data-feedback="accepted">Me sirvió</button>
                <button class="ghost-button feedback-button" id="tutorFeedbackRejectBtn" type="button" data-feedback="rejected">No me sirvió</button>
              </div>
              <p class="tutor-feedback-status" id="tutorFeedbackStatus" role="status" tabindex="-1"></p>
            </section>

            <div class="preview-card" id="previewSection">
              <details>
                <summary>Ver fragmento detectado</summary>
                <pre id="previewText">(Sin fragmento detectado)</pre>
              </details>
            </div>
            </div>`;
}

function buildTabPanelAgendaTemplate() {
  return `<div class="tab-panel" id="tabPanelAgenda" role="tabpanel" aria-labelledby="tabBtnAgenda" hidden>
            <!-- Agenda del estudiante (0.7.17): la semana del curso según la bitácora del docente, las
                 próximas evaluaciones, Google Calendar y bloques de estudio sugeridos. -->
            <section class="panel-section agenda-section" id="agendaSection" aria-labelledby="agendaTitle">
              <div class="section-title-row">
                <div>
                  <h2 id="agendaTitle">Agenda del curso</h2>
                  <p class="summary-meta" id="agendaStatusText">Consultando la bitácora del curso...</p>
                </div>
                <div class="summary-actions">
                  <span class="state-chip" id="agendaWeekChip">Consultando</span>
                  <button class="ghost-button analyze-button" id="agendaRefreshBtn" type="button">Actualizar</button>
                </div>
              </div>
              <div class="agenda-week-card" id="agendaWeekCard" hidden>
                <span class="eyebrow" id="agendaWeekEyebrow">Esta semana</span>
                <strong class="agenda-week-topic" id="agendaWeekTopic"></strong>
                <ul class="agenda-week-activities" id="agendaWeekActivities"></ul>
              </div>
              <div class="agenda-columns">
                <section class="agenda-block" aria-labelledby="agendaUpcomingTitle">
                  <h3 id="agendaUpcomingTitle">Próximas evaluaciones y entregas</h3>
                  <ul class="agenda-upcoming-list" id="agendaUpcomingList"></ul>
                </section>
                <section class="agenda-block" aria-labelledby="agendaCalendarTitle">
                  <h3 id="agendaCalendarTitle">Google Calendar</h3>
                  <p class="summary-meta" id="agendaCalendarNote">Pasa a tu calendario las evaluaciones y entregas que falten.</p>
                  <div class="button-row agenda-calendar-actions">
                    <button class="primary-button" id="agendaCalendarSyncBtn" type="button">Sincronizar con Google Calendar</button>
                    <button class="ghost-button" id="agendaSuggestBtn" type="button">Sugerir bloques de estudio</button>
                  </div>
                  <p class="status agenda-calendar-status" id="agendaCalendarStatus" role="status"></p>
                </section>
              </div>
              <section class="agenda-block agenda-suggestions" id="agendaSuggestionsBlock" aria-labelledby="agendaSuggestionsTitle" hidden>
                <h3 id="agendaSuggestionsTitle">Bloques de estudio sugeridos</h3>
                <p class="summary-meta" id="agendaSuggestionsNote"></p>
                <ul class="agenda-suggestion-list" id="agendaSuggestionList"></ul>
                <button class="primary-button agenda-suggestion-add" id="agendaSuggestionAddBtn" type="button">Agregar los marcados a Google Calendar</button>
              </section>
              <details class="bitacora-fold" id="agendaWeeksFold">
                <summary>Todas las semanas <span class="tab-count" id="agendaWeeksCount" hidden></span></summary>
                <ol class="agenda-weeks-list" id="agendaWeeksList"></ol>
              </details>
            </section>
            </div>`;
}

function buildTabPanelEstudiantesTemplate() {
  return `<div class="tab-panel" id="tabPanelEstudiantes" role="tabpanel" aria-labelledby="tabBtnEstudiantes" hidden>
            <!-- Lista de estudiantes con sesiones, intervenciones, quices y nota (GET /api/admin/students). -->
            <section class="panel-section students-section" id="studentsSection" aria-labelledby="studentsTitle">
              <div class="kpi-grid students-kpis" id="studentsKpis" role="group" aria-label="Resumen de los estudiantes"></div>
              <div class="section-title-row students-toolbar">
                <h2 id="studentsTitle">Estudiantes</h2>
                <div class="summary-actions">
                  <input class="students-search" id="studentsSearchInput" type="search" aria-label="Buscar estudiante" placeholder="Buscar por nombre o correo" autocomplete="off" />
                  <button class="ghost-button analyze-button" id="studentsReloadBtn" type="button">Recargar</button>
                </div>
              </div>
              <p class="policy-lead" id="studentsStatus" role="status">Abre la pestaña para cargar el progreso.</p>
              <div class="admin-table-wrap table-section students-table-wrap">
                <table class="admin-table students-table" aria-label="Progreso de los estudiantes">
                  <thead>
                    <tr>
                      <th>Estudiante</th>
                      <th>Sesiones</th>
                      <th>Ultima actividad</th>
                      <th>Tutor</th>
                      <th>Quices</th>
                      <th>Nota</th>
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
            <section class="panel-section" id="adminUsersSection" hidden>
              <div class="summary-head section-head">
                <span class="eyebrow">Administracion de usuarios</span>
                <div class="summary-actions">
                  <button class="ghost-button analyze-button" id="adminToggleCreateUserBtn" type="button" aria-controls="adminCreateForm" aria-expanded="false">Agregar usuario</button>
                  <button class="ghost-button analyze-button" id="adminReloadUsersBtn" type="button">Recargar</button>
                </div>
              </div>
              <p class="policy-lead" id="adminUsersStatus">Carga los usuarios para empezar.</p>

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

              <div class="admin-table-wrap table-section users-table-wrap">
                <table class="admin-table admin-users-table" aria-label="Usuarios administrables">
                  <thead>
                    <tr>
                      <th>Usuario</th>
                      <th>Rol</th>
                      <th>Profesor</th>
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
