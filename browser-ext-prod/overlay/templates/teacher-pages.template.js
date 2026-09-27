// ADACEEN | Capa 4 - UI: markup de las paginas del docente (bitacora y pagina RAG anterior a la pestana).
// Texto identico al que estaba dentro de buildOverlayShellTemplate().
// Sin "use strict": sale de shell.template.js (modo no estricto) y se conserva igual.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

function buildTeacherBitacoraPageTemplate() {
  return `<section class="teacher-bitacora-page" id="teacherBitacoraPage" hidden role="dialog" aria-modal="true" aria-labelledby="teacherBitacoraTitle" tabindex="-1">
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
        </section>`;
}

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
