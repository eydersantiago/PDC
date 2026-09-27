// ADACEEN | Capa 4 - UI: markup completo del overlay (vistas, modales, configuracion).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
function buildOverlayShellTemplate() {
  return `${OVERLAY_STYLES}
    <div class="shell" id="shell">
      <aside class="vscode-inline-palette" id="vscodeInlinePalette" aria-label="Sugerencia de ADACEEN sobre el código" aria-live="polite" hidden>
        <div class="vscode-inline-head">
          <span class="vscode-inline-mark" aria-hidden="true">A</span>
          <div>
            <strong id="vscodeInlineStatus">Sugerencia ADACEEN</strong>
            <span id="vscodeInlineTarget">Esperando cursor de VS Code</span>
          </div>
        </div>
        <p id="vscodeInlineFile">Sin archivo activo</p>
        <p class="vscode-inline-suggestion" id="vscodeInlineSuggestion">La extension VS Code publicara aqui la ayuda de linea.</p>
        <div class="vscode-inline-actions" id="vscodeInlineActions"></div>
      </aside>
      <aside class="panel-section vscode-sync-bottom vscode-sync-overlay" id="vscodeSyncSection" aria-label="Contexto de trabajo con VS Code" aria-live="polite" hidden>
        <div class="summary-head section-head vscode-sync-drag-handle" id="vscodeSyncDragHandle">
          <span class="eyebrow">Contexto de trabajo</span>
          <div class="summary-actions">
            <button class="ghost-button analyze-button" id="vscodeCopySessionBtn" type="button" title="Copia un codigo de un solo uso para VS Code (ADACEEN: Conectar)">Copiar codigo para VS Code</button>
            <button class="ghost-button analyze-button" id="vscodeSyncRefreshBtn" type="button">Sincronizar</button>
          </div>
        </div>
        <div class="sync-panel">
          <div class="sync-status-row">
            <strong id="vscodeSyncStatus">Esperando extension VS Code</strong>
            <p id="vscodeSyncMeta">Abre el archivo en Codespaces y ejecuta ADACEEN en VS Code.</p>
          </div>
          <div class="sync-detail-grid">
            <article class="sync-detail-block">
              <span class="eyebrow">Resumen del archivo</span>
              <strong id="vscodeFileTitle">Sin archivo activo</strong>
              <p id="vscodeFileSummary">Cuando el backend analice el contexto, aqui se mostrara que hace el archivo actual.</p>
            </article>
            <article class="sync-detail-block sync-line-block">
              <span class="eyebrow">Sugerencia de linea</span>
              <pre class="sync-snippet" id="vscodeSuggestionText">(Sin sugerencia sincronizada)</pre>
            </article>
          </div>
          <div class="replacement-list" id="vscodeReplacementList"></div>
        </div>
      </aside>
      <button class="minimized-tab" id="minimizedTabBtn" type="button" aria-label="Restaurar ADACEEN" hidden>
        <span class="minimized-tab-mark" aria-hidden="true">A</span>
        <span class="minimized-tab-copy">
          <strong id="minimizedTabTitle">ADACEEN</strong>
          <span id="minimizedTabSubtitle">tutor contextual</span>
        </span>
      </button>
      <div class="window" id="window" role="dialog" aria-modal="false" aria-label="ADACEEN, tutor de programación" tabindex="-1">
        <header class="header" id="dragHandle">
          <div class="brand">
            <span class="brand-dot" aria-hidden="true"></span>
            <div>
              <strong id="headerUserTitle">ADACEEN</strong>
              <span id="headerUserSubtitle">overlay de aprendizaje</span>
            </div>
          </div>
          <div class="header-actions">
            <button class="icon-button" id="minimizeBtn" type="button" aria-label="Minimizar ADACEEN" title="Minimizar">&minus;</button>
            <button class="icon-button" id="settingsBtn" type="button" aria-label="Configuración" title="Configuración" aria-controls="settingsPanel" aria-expanded="false">&#9881;</button>
            <button class="icon-button text-button" id="logoutHeaderBtn" type="button" aria-label="Salir de la sesión">Salir</button>
            <button class="icon-button" id="closeBtn" type="button" aria-label="Cerrar ADACEEN" title="Cerrar (Escape)" aria-keyshortcuts="Escape">&times;</button>
          </div>
        </header>

        <div class="body">
          <section class="view" id="welcomeView">
            <span class="pill" id="welcomeContext">Contexto</span>
            <h1>ADACEEN listo</h1>
            <p class="copy" id="welcomeCopy">Vista contextual para Campus, GitHub y Codespaces.</p>
            <p class="policy-lead">Inicia sesion para activar las pistas del curso.</p>
            <div class="button-row">
              <button class="primary-button" id="startBtn" type="button">Empezar</button>
            </div>
          </section>

          <section class="view" id="authView" hidden>
            <span class="pill">Acceso</span>
            <span class="extension-version-badge">${ADACEEN_BROWSER_EXTENSION_LABEL}</span>
            <h1>Inicia sesion</h1>
            <p class="copy">Continua con Google o usa credenciales del piloto.</p>
            <div class="auth-card">
              <button class="google-button" id="googleAuthBtn" type="button">
                <span class="google-mark" aria-hidden="true">G</span>
                Continuar con Google
              </button>
              <div class="auth-divider"><span>o usa credenciales</span></div>
              <div class="field">
                <label for="authEmail">Correo</label>
                <input id="authEmail" type="text" autocomplete="username" placeholder="usuario@adaceen.edu.co" />
              </div>
              <div class="field">
                <label for="authPassword">Contrasena</label>
                <input id="authPassword" type="password" autocomplete="current-password" placeholder="Ingresa tu contrasena" />
              </div>
              <p class="settings-note" id="authHelper" hidden>
                Demo estudiante: estudiante@adaceen.edu.co / Estudiante123!<br />
                Demo profesor: docente@adaceen.edu.co / Docente123!<br />
                Demo admin: admin@adaceen.edu.co / Admin123!
              </p>
              <p class="status" id="authError" role="alert"></p>
            </div>
            <div class="button-row split">
              <button class="ghost-button" id="authBackBtn" type="button">Volver</button>
              <button class="primary-button" id="authSubmitBtn" type="button">Entrar</button>
            </div>
          </section>

          <section class="view" id="setupView" hidden>
            <span class="pill" id="setupViewPill">Configuracion inicial</span>
            <h1 id="setupViewTitle">Preparar repositorio</h1>
            <p class="copy" id="setupViewCopy">Confirma el repo, autoriza GitHub y deja Codespaces listo para trabajar.</p>

            <section class="context-hub" id="setupContextHub">
              <div class="context-hub-head">
                <div>
                  <span class="eyebrow" id="setupContextEyebrow">Contexto actual</span>
                  <h2 id="setupContextTitle">Detectando contexto</h2>
                  <p class="context-meta" id="setupContextMeta">Leyendo pagina activa.</p>
                </div>
                <span class="state-chip" id="setupContextStateChip">Pendiente</span>
              </div>
              <div class="connection-grid" id="setupConnectionGrid"></div>
              <div class="operation-banner" id="setupOperationBanner" hidden>
                <span class="operation-spinner" aria-hidden="true"></span>
                <div>
                  <strong id="setupOperationTitle">Preparando entorno</strong>
                  <p id="setupOperationDetail">ADACEEN esta trabajando.</p>
                </div>
              </div>
              <div class="next-action">
                <div>
                  <span class="eyebrow">Accion recomendada</span>
                  <strong id="setupActionTitle">Siguiente paso</strong>
                  <p id="setupActionCopy">ADACEEN mostrara el paso disponible segun el estado del repositorio.</p>
                </div>
                <div class="button-row split context-actions">
                  <button class="ghost-button" id="setupSecondaryActionBtn" type="button">Actualizar estado</button>
                  <button class="primary-button" id="setupPrimaryActionBtn" type="button">Continuar</button>
                </div>
              </div>
            </section>

            <div class="summary-card setup-step-card" id="setupStepOneCard">
              <span class="eyebrow" id="setupStepOneEyebrow">Repositorio</span>
              <h2 id="setupStepOneTitle">Tu repositorio</h2>
              <p class="settings-note" id="setupStepOneNote">ADACEEN trabajara en una rama de preparacion; la rama principal no se toca.</p>
              <div class="field">
                <label for="setupRepoInput">Repositorio a preparar (owner/repo o URL)</label>
                <input id="setupRepoInput" type="text" placeholder="ejemplo: eydersantiago/finagent o https://github.com/eydersantiago/finagent" />
              </div>
              <div class="button-row tight-row">
                <button class="ghost-button" id="setupDetectRepoBtn" type="button">Autodetectar</button>
              </div>
              <p class="settings-note">¿Usas VS Code instalado en este equipo (por ejemplo, una Mac del laboratorio)? No necesitas el editor en la nube: ADACEEN abre el repositorio en ese VS Code y lo conecta solo.</p>
              <div class="button-row tight-row">
                <button class="ghost-button" id="setupOpenLocalVscodeBtn" type="button">Abrir en VS Code de este equipo</button>
              </div>
            </div>

            <p class="status" id="setupStatusText" role="status">Paso 1/3: confirma el repositorio que vamos a preparar.</p>
          </section>

          <section class="view" id="mainView" hidden>
            <div class="main-top">
              <div class="main-top-left">
                <span class="pill" id="mainContext">Contexto</span>
                <span class="pill role-pill" id="roleBadge">Rol</span>
              </div>
              <div class="main-top-actions">
                <button class="ghost-button" id="refreshBtn" type="button" title="Pedir ayuda al tutor (Ctrl+Enter)" aria-keyshortcuts="Control+Enter">Actualizar</button>
              </div>
            </div>

            <!-- Pestañas de la vista principal (0.7.13): cada rol ve las suyas y cada una cabe en la ventana. -->
            <div class="tab-bar" id="mainTabBar" role="tablist" aria-label="Secciones de ADACEEN">
              <button class="tab-button" id="tabBtnInicio" type="button" role="tab" data-tab="inicio" aria-selected="true" aria-controls="tabPanelInicio">Inicio</button>
              <button class="tab-button" id="tabBtnTutor" type="button" role="tab" data-tab="tutor" aria-selected="false" aria-controls="tabPanelTutor" tabindex="-1" hidden>Tutor</button>
              <button class="tab-button" id="tabBtnEstudiantes" type="button" role="tab" data-tab="estudiantes" aria-selected="false" aria-controls="tabPanelEstudiantes" tabindex="-1" hidden>Estudiantes<span class="tab-count" id="tabCountEstudiantes" hidden></span></button>
              <button class="tab-button" id="tabBtnRag" type="button" role="tab" data-tab="rag" aria-selected="false" aria-controls="tabPanelRag" tabindex="-1" hidden>RAG</button>
              <button class="tab-button" id="tabBtnQuices" type="button" role="tab" data-tab="quices" aria-selected="false" aria-controls="tabPanelQuices" tabindex="-1" hidden>Quices</button>
              <button class="tab-button" id="tabBtnUsuarios" type="button" role="tab" data-tab="usuarios" aria-selected="false" aria-controls="tabPanelUsuarios" tabindex="-1" hidden>Usuarios</button>
            </div>

            <div class="tab-panel" id="tabPanelInicio" role="tabpanel" aria-labelledby="tabBtnInicio">
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
            </section>

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
                  <button class="ghost-button analyze-button teacher-only" id="teacherBitacoraUploadBtn" type="button" hidden>Bitacora</button>
                  <button class="ghost-button analyze-button teacher-only" id="teacherRagManageBtn" type="button" hidden>Configurar RAG</button>
                  <button class="ghost-button analyze-button" id="analyzeProjectBtn" type="button">Explorar repo</button>
                  <button class="ghost-button analyze-button" id="rerunOcrBtn" type="button">OCR visual</button>
                </div>
              </div>
              <input id="teacherBitacoraFileInput" type="file" accept=".xlsx,.xls,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" hidden />
              <input id="teacherRagFileInput" type="file" accept=".pdf,.txt,.md,.doc,.docx,.html,.htm,.csv,.json,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden />
              <div class="summary-title" id="detailTitle">Sin detalle detectado</div>
              <div class="summary-meta" id="detailMeta">Sin contexto</div>
              <p class="signal" id="signalText">Sin senales detectadas.</p>
              <p class="policy-lead" id="policyLead">La politica activa aparecera aqui.</p>
              <p class="session-badge" id="sessionBadge">Sesion sin iniciar.</p>
            </div>
            </div>

            <div class="tab-panel" id="tabPanelTutor" role="tabpanel" aria-labelledby="tabBtnTutor" hidden>
            <div class="teacher-card tutor-locked-notice" id="tutorLockedNotice" hidden>
              <span class="eyebrow">Tutor</span>
              <p class="teacher-summary" id="tutorLockedCopy">El tutor se activa cuando ADACEEN lee tu proyecto o tu curso: en el editor pulsa «Explorar repo» y en un curso de Campus «Analizar Campus» (pestaña Inicio). En vscode.dev entra solo.</p>
            </div>
            <section class="panel-section" id="studentGoalSection" aria-labelledby="studentGoalTitle">
              <h2 id="studentGoalTitle">Hoy quiero reforzar</h2>
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
            </div>

            <div class="tab-panel" id="tabPanelEstudiantes" role="tabpanel" aria-labelledby="tabBtnEstudiantes" hidden>
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
            </div>

            <div class="tab-panel" id="tabPanelRag" role="tabpanel" aria-labelledby="tabBtnRag" hidden>
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
            </div>

            <div class="tab-panel" id="tabPanelQuices" role="tabpanel" aria-labelledby="tabBtnQuices" hidden>
            <!-- Quices del docente (0.7.15): lanzar por tema, el banco propio y los quices hechos por los estudiantes. -->
            <section class="panel-section quizzes-section" id="quizzesSection" aria-labelledby="quizzesTitle" hidden>
              <div class="section-title-row">
                <div>
                  <h2 id="quizzesTitle">Quices</h2>
                  <p class="summary-meta" id="quizzesStatus">Cargando quices...</p>
                </div>
                <div class="summary-actions">
                  <button class="ghost-button analyze-button" id="quizzesRefreshBtn" type="button">Actualizar</button>
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
            </div>

            <div class="tab-panel" id="tabPanelUsuarios" role="tabpanel" aria-labelledby="tabBtnUsuarios" hidden>
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
            </div>

            <p class="status" id="statusText" role="status"></p>
          </section>
        </div>

        <section class="confirmation-modal" id="firstLoginModal" hidden role="dialog" aria-modal="true" tabindex="-1" aria-labelledby="firstLoginTitle">
          <div class="confirmation-dialog">
            <span class="pill">Privacidad</span>
            <h2 id="firstLoginTitle">Acepta la politica de privacidad</h2>
            <p class="copy" id="firstLoginCopy">
              Es la primera vez que ingresas a ADACEEN con esta cuenta. Revisa y acepta el uso de datos del piloto antes de continuar.
            </p>
            <div class="button-row split">
              <button class="ghost-button" id="firstLoginLogoutBtn" type="button">Cerrar sesion</button>
              <button class="primary-button" id="firstLoginConfirmBtn" type="button">Aceptar y continuar</button>
            </div>
          </div>
        </section>

        <section class="confirmation-modal course-modal" id="studentCourseModal" hidden role="dialog" aria-modal="true" tabindex="-1" aria-labelledby="studentCourseTitle">
          <div class="confirmation-dialog">
            <span class="pill">Curso a practicar</span>
            <h2 id="studentCourseTitle">Elige el curso que quieres reforzar</h2>
            <p class="copy" id="studentCourseCopy">
              ADACEEN usara el RAG del curso seleccionado para guiar tus recomendaciones.
            </p>
            <div class="student-course-options" id="studentCourseOptions"></div>
            <p class="status" id="studentCourseStatus"></p>
            <div class="button-row split">
              <button class="ghost-button" id="studentCourseLogoutBtn" type="button">Cerrar sesion</button>
              <button class="primary-button" id="studentCourseConfirmBtn" type="button">Practicar este curso</button>
            </div>
          </div>
        </section>

        <section class="confirmation-modal conflict-modal" id="tabConflictModal" hidden role="dialog" aria-modal="true" tabindex="-1" aria-labelledby="tabConflictTitle">
          <div class="confirmation-dialog">
            <span class="pill">Sesion activa</span>
            <h2 id="tabConflictTitle">Ya hay una sesión activa</h2>
            <p class="copy" id="tabConflictNotice"></p>
            <div class="button-row">
              <button class="primary-button" id="tabConflictRefreshBtn" type="button">Revisar nuevamente</button>
            </div>
          </div>
        </section>

        <section class="teacher-bitacora-page" id="teacherBitacoraPage" hidden role="dialog" aria-modal="true" aria-labelledby="teacherBitacoraTitle" tabindex="-1">
          <div class="bitacora-page-head">
            <div>
              <span class="pill">Bitacora docente</span>
              <h2 id="teacherBitacoraTitle">Gestionar bitacora del curso</h2>
              <p id="teacherBitacoraStatusText">Consulta, descarga plantilla o carga un archivo Excel/PDF.</p>
            </div>
            <button class="icon-button" id="teacherBitacoraCloseBtn" type="button" aria-label="Cerrar bitácora y volver" title="Volver">&times;</button>
          </div>
          <div class="bitacora-page-body">
            <section class="summary-card">
              <span class="eyebrow">Estado</span>
              <p class="teacher-summary" id="teacherBitacoraLatestText">Aun no hay bitacora cargada.</p>
              <ul class="compact-list" id="teacherBitacoraAgendaList"></ul>
              <div class="button-row split">
                <button class="ghost-button" id="teacherBitacoraExportXlsxBtn" type="button">Exportar bitacora (Excel)</button>
                <button class="ghost-button" id="teacherBitacoraExportCsvBtn" type="button">Exportar bitacora (CSV)</button>
              </div>
              <p class="settings-note">La exportacion usa el diseno de la plantilla: el Excel se puede volver a cargar aqui y el CSV sirve para Excel o Power BI.</p>
            </section>
            <section class="summary-card">
              <span class="eyebrow">Plantilla</span>
              <p class="settings-note">Formato Excel: Semana, Fecha, Tema, Clasificacion, Actividades en clase y Actividades evaluacion. Tambien puedes exportarla a PDF y subirla aqui.</p>
              <div class="button-row split">
                <button class="ghost-button" id="teacherBitacoraDownloadTemplateBtn" type="button">Descargar plantilla</button>
                <button class="primary-button" id="teacherBitacoraChooseFileBtn" type="button">Cargar Excel/PDF</button>
              </div>
            </section>
            <section class="summary-card bitacora-manual-card">
              <span class="eyebrow">Registro manual</span>
              <div class="bitacora-manual-grid">
                <div class="field">
                  <label for="teacherBitacoraManualWeekInput">Semana</label>
                  <input id="teacherBitacoraManualWeekInput" type="number" min="1" max="20" inputmode="numeric" placeholder="1">
                </div>
                <div class="field">
                  <label for="teacherBitacoraManualDateInput">Fecha</label>
                  <input id="teacherBitacoraManualDateInput" type="text" placeholder="yyyy-mm-dd">
                </div>
                <div class="field">
                  <label for="teacherBitacoraManualCategorySelect">Clasificacion</label>
                  <select id="teacherBitacoraManualCategorySelect">
                    <option value="Actividad">Actividad</option>
                    <option value="Proyecto">Proyecto</option>
                    <option value="Ejercicio">Ejercicio</option>
                    <option value="Parcial">Parcial</option>
                    <option value="Quiz">Quiz</option>
                  </select>
                </div>
                <div class="field">
                  <label for="teacherBitacoraManualTitleInput">Titulo</label>
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
            </section>
            <section class="summary-card">
              <span class="eyebrow">Datos</span>
              <div class="button-row split">
                <button class="ghost-button danger-button" id="teacherBitacoraDeleteLatestBtn" type="button">Eliminar bitacora</button>
                <button class="ghost-button danger-button" id="teacherBitacoraClearDataBtn" type="button">Borrar todos los datos</button>
              </div>
            </section>
            <p class="status" id="teacherBitacoraPageStatus" aria-live="polite"></p>
          </div>
        </section>

        <section class="teacher-rag-page" id="teacherRagPage" hidden role="dialog" aria-modal="true" aria-labelledby="teacherRagTitle" tabindex="-1">
          <div class="bitacora-page-head">
            <div>
              <span class="pill">RAG por curso</span>
              <h2 id="teacherRagTitle">Gestionar fuentes del curso</h2>
              <p id="teacherRagStatusText">FPOO queda como RAG por defecto; puedes cargar fuentes por curso.</p>
            </div>
            <button class="icon-button" id="teacherRagCloseBtn" type="button" aria-label="Cerrar fuentes RAG y volver" title="Volver">&times;</button>
          </div>
          <div class="bitacora-page-body">
            <section class="summary-card rag-course-card">
              <div class="rag-course-active">
                <div>
                  <span class="eyebrow">Curso activo</span>
                  <strong id="teacherRagCourseCode">FPOO</strong>
                  <p id="teacherRagCourseName">Fundamentos de programacion orientada a objetos</p>
                </div>
              </div>
              <div class="field rag-course-select-field">
                <label for="teacherRagCourseSelect">Cambiar curso</label>
                <select id="teacherRagCourseSelect"></select>
              </div>
              <div class="rag-course-summary" id="teacherRagCourseSummary">Cargando cursos RAG.</div>
              <div class="button-row split">
                <button class="primary-button" id="teacherRagUploadBtn" type="button">Cargar fuente</button>
                <button class="ghost-button" id="teacherRagRefreshBtn" type="button">Actualizar lista</button>
              </div>
            </section>
            <section class="summary-card">
              <span class="eyebrow">Fuentes</span>
              <ul class="compact-list rag-source-list" id="teacherRagSourceList"></ul>
            </section>
            <p class="status" id="teacherRagPageStatus" aria-live="polite"></p>
          </div>
        </section>

        <aside class="settings-panel" id="settingsPanel" role="dialog" aria-modal="false" aria-labelledby="settingsTitle" tabindex="-1">
          <div class="settings-head">
            <div>
              <h2 class="settings-title" id="settingsTitle">Configuración</h2>
              <p class="settings-note">El profesor ajusta la politica RF-05 y el estudiante conserva solo opciones tecnicas y de sesion.</p>
            </div>
            <button class="icon-button" id="settingsCloseBtn" type="button" aria-label="Cerrar configuración" title="Cerrar (Escape)">&times;</button>
          </div>

          <!-- Secciones plegables (0.7.14): cada una se abre y cierra; «Guardar cambios» queda fijo abajo. -->
          <div class="settings-grid">
            <details class="settings-section" id="settingsSectionSession" open>
              <summary><span>Sesion y tutor</span><span class="settings-section-hint" id="settingsSectionSessionHint">Tutor activo, archivo principal y backend</span></summary>
              <div class="settings-section-body">
            <div class="field">
              <label for="settingsSessionLabel">Sesion</label>
              <input id="settingsSessionLabel" type="text" readonly />
            </div>

            <div class="field">
              <label for="settingsSessionMeta">Detalle de sesion</label>
              <textarea id="settingsSessionMeta" readonly></textarea>
            </div>

            <label class="switch-row" for="teacherEnabled">
              <span>Tutor activo</span>
              <input id="teacherEnabled" type="checkbox" />
            </label>

            <label class="switch-row" for="autoConfigEnabled">
              <span>Configuracion automatica (archivo principal)</span>
              <input id="autoConfigEnabled" type="checkbox" />
            </label>

            <div class="field">
              <label for="backendUrlInput">Base URL del backend</label>
              <input id="backendUrlInput" type="text" placeholder="https://app-adaceen-api-eyder05232002.azurewebsites.net" />
            </div>
              </div>
            </details>

            <details class="settings-section" id="settingsSectionAdvanced" hidden>
              <summary><span>Avanzado</span><span class="settings-section-hint">GitHub App, contexto y versiones</span></summary>
              <div class="settings-section-body">
            <div class="settings-role-block" id="advancedGithubBlock" hidden>
              <div class="field">
                <span class="field-title">Ajustes avanzados GitHub App</span>
                <p class="settings-note" id="advancedGithubNote">
                  Si necesitas forzar una nueva rama/PR de bootstrap para este repo, hazlo desde aquí.
                </p>
                <div class="button-row tight-row">
                  <button class="save-button" id="githubAppBootstrapBtn" type="button">Rehacer PR devcontainer</button>
                </div>
              </div>

              <section class="settings-subcard" id="githubAppSection">
                <div class="settings-subhead">
                  <div>
                    <h3>GitHub App estable</h3>
                    <p class="settings-note" id="githubAppStatusText">Abre un repositorio para conectar la app.</p>
                  </div>
                  <div class="summary-actions">
                    <button class="ghost-button" id="githubAppInstallBtn" type="button">Conectar App</button>
                    <button class="ghost-button" id="githubAppRefreshBtn" type="button">Actualizar estado</button>
                  </div>
                </div>
              </section>

              <section class="settings-subcard" id="projectContextStatusSection">
                <div class="settings-subhead">
                  <div>
                    <h3>Contexto y versiones</h3>
                    <p class="settings-note" id="projectContextStatusText">Consulta el contexto guardado para este repositorio.</p>
                  </div>
                  <button class="ghost-button" id="projectContextRefreshBtn" type="button">Refrescar estado</button>
                </div>
                <div class="settings-kv-grid" id="projectContextKvGrid">
                  <div class="settings-kv">
                    <span>Estado</span>
                    <strong id="projectContextReadyValue">Sin datos</strong>
                  </div>
                  <div class="settings-kv">
                    <span>Versión</span>
                    <strong id="projectContextVersionValue">Sin datos</strong>
                  </div>
                  <div class="settings-kv">
                    <span>Request</span>
                    <strong id="projectContextRequestValue">Sin datos</strong>
                  </div>
                  <div class="settings-kv">
                    <span>Snapshot</span>
                    <strong id="projectContextSnapshotValue">Sin datos</strong>
                  </div>
                  <div class="settings-kv">
                    <span>Actualizado</span>
                    <strong id="projectContextUpdatedValue">Sin datos</strong>
                  </div>
                  <div class="settings-kv">
                    <span>Fuente</span>
                    <strong id="projectContextSourceValue">Sin datos</strong>
                  </div>
                </div>
              </section>

              <section class="settings-subcard" id="projectContextHistorySection">
                <div class="settings-subhead">
                  <div>
                    <h3>Historial de rebuilds</h3>
                    <p class="settings-note" id="projectContextHistoryText">Versiones guardadas para este repositorio.</p>
                  </div>
                  <button class="ghost-button" id="projectContextHistoryRefreshBtn" type="button">Recargar historial</button>
                </div>
                <ul class="settings-history-list" id="projectContextHistoryList"></ul>
              </section>
            </div>

              </div>
            </details>

            <div class="settings-role-block" id="teacherSettingsBlock" hidden>
            <details class="settings-section" id="settingsSectionPolicy" open>
              <summary><span>Politica del tutor</span><span class="settings-section-hint" id="settingsSectionPolicyHint">Tono, frecuencia, ayuda, pistas e intervenciones</span></summary>
              <div class="settings-section-body">
              <div class="field">
                <label for="teacherPolicyName">Nombre de la politica</label>
                <input id="teacherPolicyName" type="text" placeholder="RF-05 base del piloto" />
              </div>

            <div class="settings-two">
            <div class="field">
              <div class="label-row">
                <label for="teacherOutcome">Resultado de aprendizaje</label>
                <button class="help-button" id="teacherOutcomeHelpBtn" type="button" aria-label="Que es cada resultado de aprendizaje" aria-expanded="false" aria-controls="teacherOutcomeHelp" title="De que trata cada RA">?</button>
              </div>
              <select id="teacherOutcome">
                <option value="RA1">RA1</option>
                <option value="RA2">RA2</option>
                <option value="RA3">RA3</option>
                <option value="RA4">RA4</option>
                <option value="RA5">RA5</option>
              </select>
            </div>

            <div class="field">
              <label for="teacherTone">Tono del tutor</label>
              <select id="teacherTone">
                <option value="warm">Calido</option>
                <option value="direct">Directo</option>
                <option value="socratic">Socratico</option>
              </select>
            </div>
            </div>
            <div class="help-panel" id="teacherOutcomeHelp" role="region" aria-label="Resultados de aprendizaje del curso" hidden></div>

            <div class="settings-two">
            <div class="field">
              <label for="teacherFrequency">Frecuencia de intervencion</label>
              <select id="teacherFrequency">
                <option value="low">Baja</option>
                <option value="medium">Media</option>
                <option value="high">Alta</option>
              </select>
            </div>

            <div class="field">
              <label for="teacherHelpLevel">Nivel de ayuda</label>
              <select id="teacherHelpLevel">
                <option value="progressive">Progresiva</option>
                <option value="hint_only">Solo pistas</option>
                <option value="partial_example">Ejemplo parcial</option>
              </select>
            </div>
            </div>

            <label class="switch-row" for="teacherNoSolution">
              <span>Bloquear solucion completa</span>
              <input id="teacherNoSolution" type="checkbox" />
            </label>

            <div class="field">
              <label for="teacherMaxHints">Maximo de pistas por ejercicio</label>
              <input id="teacherMaxHints" type="number" min="1" step="1" placeholder="3" />
            </div>

            <div class="field" role="group" aria-labelledby="teacherInterventionsTitle">
              <span class="field-title" id="teacherInterventionsTitle">Intervenciones habilitadas</span>
              <div class="check-grid">
                <label class="check-item"><span>Explicacion</span><input id="teacherAllowExplanation" type="checkbox" /></label>
                <label class="check-item"><span>Pista</span><input id="teacherAllowHint" type="checkbox" /></label>
                <label class="check-item"><span>Ejemplo parcial</span><input id="teacherAllowExample" type="checkbox" /></label>
              </div>
            </div>

            <div class="field">
              <label for="teacherFallbackMessage">Mensaje controlado</label>
              <textarea id="teacherFallbackMessage" placeholder="Mensaje ante falta de contexto o consulta fuera del dominio."></textarea>
            </div>

            <div class="field">
              <label for="teacherCustomInstruction">Nota docente</label>
              <textarea id="teacherCustomInstruction" placeholder="Ejemplo: prioriza preguntas orientadoras y no des codigo completo."></textarea>
            </div>
              </div>
            </details>

            <details class="settings-section" id="settingsSectionQuiz">
              <summary><span>Quices</span><span class="settings-section-hint" id="settingsSectionQuizHint">Cuando sale el mini quiz en VS Code</span></summary>
              <div class="settings-section-body">
            <label class="switch-row" for="teacherMiniQuiz">
              <span>Permitir mini quiz</span>
              <input id="teacherMiniQuiz" type="checkbox" />
            </label>

            <div class="field" role="group" aria-labelledby="teacherQuizTriggersTitle">
              <span class="field-title" id="teacherQuizTriggersTitle">Cuando sale el mini quiz en VS Code</span>
              <div class="check-grid">
                <label class="check-item"><span>Tras aceptar una sugerencia</span><input id="teacherQuizAfterAccept" type="checkbox" /></label>
                <label class="check-item"><span>Cuando yo lo lance a la clase</span><input id="teacherQuizTeacherLaunch" type="checkbox" /></label>
                <label class="check-item"><span>Si falla, pedir que explique</span><input id="teacherQuizFollowUp" type="checkbox" /></label>
              </div>
            </div>

            <div class="settings-two">
            <div class="field">
              <label for="teacherQuizEveryN">Un quiz cada cuantas sugerencias aceptadas</label>
              <input id="teacherQuizEveryN" type="number" min="1" max="20" step="1" placeholder="1" />
            </div>

            <div class="field">
              <label for="teacherQuizMaxPerSession">Maximo de quices por sesion (vacio = sin limite)</label>
              <input id="teacherQuizMaxPerSession" type="number" min="1" max="50" step="1" placeholder="5" />
            </div>
            </div>

            <p class="settings-note">Para lanzar un quiz a la clase, crear los tuyos o ver los hechos, usa la pestaña «Quices».</p>

              </div>
            </details>

            <details class="settings-section" id="settingsSectionCodeApply">
              <summary><span>Codigo desde VS Code</span><span class="settings-section-hint" id="settingsSectionCodeApplyHint">Aplicar sugerencias y limite de lineas</span></summary>
              <div class="settings-section-body">
            <div class="field code-application-settings" role="group" aria-labelledby="teacherCodeApplyTitle">
              <span class="field-title" id="teacherCodeApplyTitle">Aplicar código desde VS Code</span>
              <div class="check-grid">
                <label class="check-item"><span>Permitir aplicar código desde VS Code</span><input id="teacherCodeApplyAllowed" type="checkbox" /></label>
                <label class="check-item"><span>Cuenta como pista</span><input id="teacherCodeApplyCountsAsHint" type="checkbox" /></label>
                <label class="check-item"><span>Pedir confirmación</span><input id="teacherCodeApplyRequireConfirmation" type="checkbox" /></label>
              </div>
            </div>

            <div class="field">
              <label for="teacherCodeApplyMaxLines">Máximo de líneas por aplicación (1 a 200)</label>
              <input id="teacherCodeApplyMaxLines" type="number" min="1" max="200" step="1" inputmode="numeric" placeholder="20" aria-describedby="teacherCodeApplyHelp" />
              <p class="settings-note" id="teacherCodeApplyHelp">VS Code no aplicará cambios más largos; el estudiante verá el motivo.</p>
            </div>

              </div>
            </details>
            </div>
          </div>

          <div class="button-row settings-actions">
            <button class="save-button" id="saveSettingsBtn" type="button">Guardar cambios</button>
          </div>
        </aside>

        <section class="analysis-window" id="analysisWindow" role="dialog" aria-modal="false" aria-labelledby="analysisTitle" tabindex="-1" hidden>
          <div class="analysis-head">
            <div>
              <strong id="analysisTitle">Analisis de archivos del proyecto</strong>
              <p class="analysis-meta" id="analysisStats">Pulsa Explorar repo para leer archivos y carpetas del explorador.</p>
            </div>
            <button class="icon-button" id="analysisCloseBtn" type="button" aria-label="Cerrar análisis" title="Cerrar (Escape)">&times;</button>
          </div>
          <div class="analysis-body">
            <ul class="analysis-tree" id="analysisFileList"></ul>
          </div>
        </section>
      </div>
    </div>
`;
}
