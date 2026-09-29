// ADACEEN | Capa 4 - UI: markup de la tuerca (panel de ajustes por secciones).
// Texto identico al que estaba dentro de buildOverlayShellTemplate().
// Sin "use strict": sale de shell.template.js (modo no estricto) y se conserva igual.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.

function buildSettingsPanelTemplate() {
  return `<aside class="settings-panel" id="settingsPanel" role="dialog" aria-modal="false" aria-labelledby="settingsTitle" tabindex="-1">
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

            <!-- Entorno de los estudiantes (0.7.19): administrador o docente. Se aplica con «Guardar cambios». -->
            <details class="settings-section" id="settingsSectionWorkspace" hidden>
              <summary><span>Entorno de los estudiantes</span><span class="settings-section-hint" id="settingsSectionWorkspaceHint">Editor en la nube o Codespaces</span></summary>
              <div class="settings-section-body">
            <div class="field">
              <label for="workspaceProviderSelect">Dónde abren su editor</label>
              <select id="workspaceProviderSelect" aria-describedby="workspaceProviderNote">
                <option value="tunnel" id="workspaceProviderTunnelOption">Editor en la nube (túnel de VS Code)</option>
                <option value="codespaces">GitHub Codespaces</option>
                <option value="server" id="workspaceProviderServerOption">Lo que diga el servidor</option>
              </select>
            </div>

            <div class="settings-kv-grid">
              <div class="settings-kv">
                <span>Activo ahora</span>
                <strong id="workspaceProviderActiveValue">Sin datos</strong>
              </div>
              <div class="settings-kv">
                <span>VM de editores</span>
                <strong id="workspaceAgentValue">Sin datos</strong>
              </div>
              <div class="settings-kv">
                <span>Variable del servidor</span>
                <strong id="workspaceProviderServerValue">Sin datos</strong>
              </div>
              <div class="settings-kv">
                <span>Último cambio</span>
                <strong id="workspaceProviderUpdatedValue">Sin datos</strong>
              </div>
            </div>
            <p class="settings-note" id="workspaceProviderNote" role="status"></p>
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
        </aside>`;
}
