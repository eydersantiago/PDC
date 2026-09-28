// ADACEEN | Capa 4 - UI: markup de la pagina RAG del docente anterior a la pestana «RAG».
// Texto identico al que estaba dentro de buildOverlayShellTemplate(). La pagina de la bitacora
// salio de aqui en la 0.7.16: ahora es la pestana «Bitacora» (tab-panels.template.js).
// Sin "use strict": sale de shell.template.js (modo no estricto) y se conserva igual.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

function buildTeacherRagPageTemplate() {
  return `<section class="teacher-rag-page" id="teacherRagPage" hidden role="dialog" aria-modal="true" aria-labelledby="teacherRagTitle" tabindex="-1">
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
        </section>`;
}
