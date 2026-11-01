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
                  <span class="eyebrow">Acción recomendada</span>
                  <strong id="contextActionTitle">Siguiente paso</strong>
                  <p id="contextActionCopy">ADACEEN ajustara la accion segun el modulo detectado.</p>
                </div>
                <div class="button-row split context-actions">
                  <button class="ghost-button" id="contextSecondaryActionBtn" type="button">Actualizar</button>
                  <button class="primary-button" id="contextPrimaryActionBtn" type="button">Continuar</button>
                </div>
              </div>
              <!-- Tu VS Code (0.8.3): antes una tarjeta blanca flotante que seguia al puntero y tapaba
                   el panel; ahora una linea del centro de contexto, solo en paginas de editor. El
                   resumen del archivo y el material del curso estan en VS Code («Este archivo»). -->
              <div class="vscode-link is-idle" id="vscodeSyncSection" role="group" aria-label="Tu VS Code" hidden>
                <span class="vscode-link-dot" aria-hidden="true"></span>
                <div class="vscode-link-copy" role="status">
                  <strong id="vscodeSyncStatus">Esperando extension VS Code</strong>
                  <span id="vscodeSyncMeta">Abre el archivo en Codespaces y ejecuta ADACEEN en VS Code.</span>
                </div>
                <div class="vscode-link-actions">
                  <button class="ghost-button" id="vscodeCopySessionBtn" type="button" title="Copia un codigo de un solo uso para VS Code (ADACEEN: Conectar)">Copiar codigo para VS Code</button>
                  <button class="ghost-button" id="vscodeSyncRefreshBtn" type="button">Sincronizar</button>
                </div>
              </div>
              <!-- Un editor, varios repositorios (0.7.20): los que ya estan en tu editor en la nube, a un clic. -->
              <div class="editor-repos" id="editorReposSection" hidden>
                <span class="eyebrow" id="editorReposTitle">Tus repositorios en el editor</span>
                <ul class="editor-repos-list" id="editorReposList" aria-labelledby="editorReposTitle"></ul>
              </div>
            </section>

            <!-- Tema de la clase (0.7.21; dirección B en 0.7.22): el que eligió el docente para el
                 piloto, con su ejercicio, como pares clave y valor. -->
            <section class="pilot-topic-home" id="pilotTopicHome" aria-labelledby="pilotTopicHomeHeading" hidden>
              <div class="pilot-topic-home-head">
                <h2 id="pilotTopicHomeHeading">Tema de la clase</h2>
                <span class="pilot-topic-home-week" id="pilotTopicHomeWeek"></span>
              </div>
              <dl class="b-dl pilot-topic-home-list">
                <dt>tema</dt><dd id="pilotTopicHomeTitle"></dd>
                <dt id="pilotTopicHomeRepoLabel">ejercicio</dt><dd class="b-mono" id="pilotTopicHomeRepo"></dd>
              </dl>
              <button class="primary-button" id="pilotTopicOpenBtn" type="button">Abrir el ejercicio en mi editor</button>
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

            <!-- Dirección B (0.7.22): la política (o lo que hace el administrador) como pares clave y
                 valor, no como una línea con «|». -->
            <section class="teacher-card home-facts" aria-labelledby="policySectionTitle">
              <div class="home-facts-head">
                <span class="eyebrow" id="policySectionTitle">Política aplicada</span>
                <span class="home-facts-note" id="policyLead"></span>
              </div>
              <dl class="kv-grid" id="teacherSummary"></dl>
            </section>

            <section class="panel-section teacher-only" id="teacherPolicySection" hidden>
              <h2>Politica docente</h2>
              <ul class="compact-list" id="teacherPolicyList"></ul>
            </section>

            <div class="summary-card home-session">
              <div class="summary-head">
                <span class="eyebrow">Resumen de sesión</span>
                <div class="summary-actions">
                  <button class="ghost-button analyze-button teacher-only" id="teacherRagManageBtn" type="button" hidden>Configurar RAG</button>
                  <button class="ghost-button analyze-button" id="analyzeProjectBtn" type="button">Explorar repo</button>
                  <button class="ghost-button analyze-button" id="rerunOcrBtn" type="button">OCR visual</button>
                </div>
              </div>
              <input id="teacherRagFileInput" type="file" multiple accept=".pdf,.txt,.md,.doc,.docx,.html,.htm,.csv,.json,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden />
              <div class="summary-title" id="detailTitle">Sin detalle detectado</div>
              <p class="signal" id="signalText">Sin senales detectadas.</p>
              <!-- Página, lenguaje, repositorio, rama, contexto y cuenta; debajo, lo que leyó ADACEEN
                   del proyecto (archivo principal, consejo, OCR, captura) cuando lo hay. -->
              <dl class="kv-grid" id="detailMeta"></dl>
              <dl class="kv-grid kv-list" id="detailInsights" hidden></dl>
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
                <summary>Fragmento que leyó el tutor</summary>
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
