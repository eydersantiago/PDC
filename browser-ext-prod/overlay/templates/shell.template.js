function buildOverlayShellTemplate() {
  return `${OVERLAY_STYLES}
    <div class="shell" id="shell">
      <div class="window" id="window">
        <header class="header" id="dragHandle">
          <div class="brand">
            <span class="brand-dot"></span>
            <div>
              <strong id="headerUserTitle">ADACEEN</strong>
              <span id="headerUserSubtitle">overlay de aprendizaje</span>
            </div>
          </div>
          <div class="header-actions">
            <button class="icon-button" id="settingsBtn" type="button" aria-label="Configuracion">&#9881;</button>
            <button class="icon-button text-button" id="logoutHeaderBtn" type="button" aria-label="Salir">Salir</button>
            <button class="icon-button" id="closeBtn" type="button" aria-label="Salir">&times;</button>
          </div>
        </header>

        <div class="body">
          <section class="view" id="welcomeView">
            <span class="pill" id="welcomeContext">Contexto</span>
            <h1>Bienvenido</h1>
            <p class="copy" id="welcomeCopy">Abriremos una vista flotante simple para acompanarte paso a paso.</p>
            <p class="policy-lead">Despues de pulsar Empezar se mostrara el inicio de sesion.</p>
            <div class="button-row">
              <button class="primary-button" id="startBtn" type="button">Empezar</button>
            </div>
          </section>

          <section class="view" id="authView" hidden>
            <span class="pill">Acceso</span>
            <h1>Inicia sesion</h1>
            <p class="copy">Continua con Google o ingresa tus credenciales. El sistema detecta automaticamente si eres estudiante, profesor o admin.</p>
            <div class="auth-card">
              <button class="google-button" id="googleAuthBtn" type="button">
                <span class="google-mark" aria-hidden="true">G</span>
                Continuar con Google
              </button>
              <div class="auth-divider"><span>o usa credenciales</span></div>
              <div class="field">
                <label for="authEmail">Correo</label>
                <input id="authEmail" type="text" placeholder="usuario@adaceen.edu.co" />
              </div>
              <div class="field">
                <label for="authPassword">Contrasena</label>
                <input id="authPassword" type="password" placeholder="Ingresa tu contrasena" />
              </div>
              <p class="settings-note" id="authHelper">
                Demo estudiante: estudiante@adaceen.edu.co / Estudiante123!<br />
                Demo profesor: docente@adaceen.edu.co / Docente123!<br />
                Demo admin: admin@adaceen.edu.co / Admin123!
              </p>
              <p class="status" id="authError"></p>
            </div>
            <div class="button-row split">
              <button class="ghost-button" id="authBackBtn" type="button">Volver</button>
              <button class="primary-button" id="authSubmitBtn" type="button">Entrar</button>
            </div>
          </section>

          <section class="view" id="setupView" hidden>
            <span class="pill">Configuracion inicial</span>
            <h1>Preparar repositorio</h1>
            <p class="copy">Antes del dashboard confirmaremos el repo, daremos acceso a la GitHub App y prepararemos el PR de configuracion para Codespaces.</p>

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

            <div class="summary-card" id="setupStepOneCard" style="margin-top:12px;">
              <span class="eyebrow">Paso 1 de 3</span>
              <h2 style="margin:0 0 8px;">Confirmar repositorio</h2>
              <p class="settings-note" style="margin-bottom:10px;">Este es el proyecto donde ADACEEN creara una rama y un PR de preparacion. No se modifica la rama principal.</p>
              <div class="field">
                <label for="setupRepoInput">Repositorio a preparar (owner/repo o URL)</label>
                <input id="setupRepoInput" type="text" placeholder="ejemplo: eydersantiago/finagent o https://github.com/eydersantiago/finagent" />
              </div>
              <div class="button-row split" style="margin-top:10px;">
                <button class="ghost-button" id="setupExploreBtn" type="button">Leer archivos del repo</button>
                <button class="ghost-button" id="setupDetectRepoBtn" type="button">Autodetectar desde pagina</button>
              </div>
              <div class="button-row" style="margin-top:10px;">
                <button class="primary-button" id="setupToStep2Btn" type="button">Continuar: autorizar repositorio</button>
              </div>
            </div>

            <div class="summary-card" id="setupStepTwoCard" style="margin-top:12px;" hidden>
              <span class="eyebrow">Paso 2 de 3</span>
              <h2 style="margin:0 0 8px;">Autorizar GitHub App</h2>
              <p class="settings-note" style="margin-bottom:10px;">La GitHub App permite a ADACEEN crear la rama y el PR de configuracion. Luego se verifica el acceso antes de avanzar.</p>
              <div class="button-row split" style="margin-top:10px;">
                <button class="ghost-button" id="setupInstallAppBtn" type="button">Abrir instalacion de GitHub App</button>
                <button class="ghost-button" id="setupRefreshAppBtn" type="button">Ya la instale, verificar acceso</button>
              </div>
              <div class="button-row split" style="margin-top:10px;">
                <button class="ghost-button" id="setupBackToStep1Btn" type="button">Volver</button>
                <button class="primary-button" id="setupToStep3Btn" type="button">Continuar: preparar entorno</button>
              </div>
            </div>

            <div class="summary-card" id="setupStepThreeCard" style="margin-top:12px;" hidden>
              <span class="eyebrow">Paso 3 de 3</span>
              <h2 style="margin:0 0 8px;">Preparar Codespaces</h2>
              <p class="settings-note" style="margin-bottom:10px;">ADACEEN creara o reutilizara el PR, creara o reanudara el Codespace asociado y abrira el entorno automaticamente.</p>
              <div class="button-row" style="margin-top:10px;">
                <button class="save-button" id="setupCreatePrBtn" type="button">Crear PR de configuracion</button>
              </div>
              <div class="button-row split" style="margin-top:10px;">
                <button class="ghost-button" id="setupBackToStep2Btn" type="button">Volver</button>
                <button class="primary-button" id="setupContinueBtn" type="button">Finalizar e ir al dashboard</button>
              </div>
            </div>

            <p class="status" id="setupStatusText">Paso 1/3: confirma el repositorio que vamos a preparar.</p>
            <div class="button-row">
              <button class="ghost-button" id="setupLogoutBtn" type="button">Cerrar sesion</button>
            </div>
          </section>

          <section class="view" id="mainView" hidden>
            <div class="main-top">
              <div style="display:flex; gap:8px; flex-wrap:wrap;">
                <span class="pill" id="mainContext">Contexto</span>
                <span class="pill role-pill" id="roleBadge">Rol</span>
              </div>
              <div style="display:flex; gap:8px; flex-wrap:wrap;">
                <button class="ghost-button" id="refreshBtn" type="button" style="width:auto; padding:9px 12px; font-size:0.76rem;">Actualizar</button>
              </div>
            </div>

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

            <div class="summary-card">
              <div class="summary-head">
                <span class="eyebrow">Resumen de sesion</span>
                <div style="display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end;">
                  <button class="ghost-button analyze-button" id="analyzeProjectBtn" type="button">Explorar proyecto</button>
                  <button class="ghost-button analyze-button" id="rerunOcrBtn" type="button">Reintentar OCR</button>
                </div>
              </div>
              <div class="summary-title" id="detailTitle">Sin detalle detectado</div>
              <div class="summary-meta" id="detailMeta">Sin contexto</div>
              <p class="signal" id="signalText">Sin senales detectadas.</p>
              <p class="policy-lead" id="policyLead">La politica activa aparecera aqui.</p>
              <p class="session-badge" id="sessionBadge">Sesion sin iniciar.</p>
            </div>

            <section class="panel-section" id="adminUsersSection" hidden>
              <div class="summary-head" style="margin-bottom:8px;">
                <span class="eyebrow" style="margin-bottom:0;">Administracion de usuarios</span>
                <button class="ghost-button analyze-button" id="adminReloadUsersBtn" type="button">Recargar</button>
              </div>
              <p class="policy-lead" id="adminUsersStatus">Carga los usuarios para empezar.</p>

              <div class="field" style="margin-top:10px;">
                <label for="adminCreateRole">Agregar usuario</label>
                <div class="button-row split" style="margin-top:0;">
                  <select id="adminCreateRole">
                    <option value="student">Estudiante</option>
                    <option value="teacher">Profesor</option>
                  </select>
                  <input id="adminCreateName" type="text" placeholder="Nombre completo" />
                </div>
                <div class="button-row split" style="margin-top:0;">
                  <input id="adminCreateEmail" type="text" placeholder="correo@adaceen.edu.co" />
                  <input id="adminCreatePassword" type="password" placeholder="Contrasena temporal" />
                </div>
                <div class="button-row split" style="margin-top:0;">
                  <select id="adminCreateTeacher">
                    <option value="">Profesor por defecto</option>
                  </select>
                  <button class="save-button" id="adminCreateBtn" type="button">Crear usuario</button>
                </div>
              </div>

              <div class="admin-table-wrap" style="margin-top:10px;">
                <table class="admin-table">
                  <thead>
                    <tr>
                      <th>Nombre</th>
                      <th>Correo</th>
                      <th>Rol</th>
                      <th>Profesor</th>
                      <th>Estado</th>
                      <th>Acciones</th>
                    </tr>
                  </thead>
                  <tbody id="adminUsersTableBody"></tbody>
                </table>
              </div>
            </section>

            <section class="panel-section" id="studentGoalSection">
              <h2>Hoy quiero reforzar</h2>
              <div class="goal-grid" id="goalGrid"></div>
            </section>

            <section class="panel-section" id="studentIdeasSection">
              <h2>Pistas de hoy</h2>
              <ul id="ideaList"></ul>
            </section>

            <section class="panel-section" id="nextStepSection">
              <h2>Siguiente paso</h2>
              <ol id="guideList"></ol>
            </section>

            <section class="panel-section teacher-only" id="teacherPolicySection" hidden>
              <h2>Politica docente</h2>
              <ul class="compact-list" id="teacherPolicyList"></ul>
            </section>

            <section class="panel-section teacher-only" id="teacherTelemetrySection" hidden>
              <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px;">
                <h2 style="margin:0;">Telemetria reciente</h2>
                <button class="ghost-button" id="reloadTelemetryBtn" type="button" style="width:auto; padding:8px 10px; font-size:0.74rem;">Recargar</button>
              </div>
              <ul class="telemetry-list" id="telemetryList"></ul>
            </section>

            <div class="preview-card" id="previewSection">
              <details>
                <summary>Ver fragmento detectado</summary>
                <pre id="previewText">(Sin fragmento detectado)</pre>
              </details>
            </div>

            <p class="status" id="statusText"></p>
          </section>
        </div>

        <section class="confirmation-modal" id="firstLoginModal" hidden role="dialog" aria-modal="true" aria-labelledby="firstLoginTitle">
          <div class="confirmation-dialog">
            <span class="pill">Primer ingreso</span>
            <h2 id="firstLoginTitle">Confirma tu sesion</h2>
            <p class="copy" id="firstLoginCopy">
              Es la primera vez que ingresas a ADACEEN con esta cuenta. Confirma para activar tu sesion y continuar con el tutor.
            </p>
            <div class="button-row split">
              <button class="ghost-button" id="firstLoginLogoutBtn" type="button">Cerrar sesion</button>
              <button class="primary-button" id="firstLoginConfirmBtn" type="button">Confirmar</button>
            </div>
          </div>
        </section>

        <section class="confirmation-modal process-modal" id="processNoticeModal" hidden role="dialog" aria-modal="true" aria-labelledby="processNoticeTitle">
          <div class="confirmation-dialog">
            <span class="pill">Preparacion</span>
            <h2 id="processNoticeTitle">Esto puede tardar cerca de 2 minutos</h2>
            <p class="copy">
              ADACEEN creara o reutilizara el PR, solicitara el Codespace y esperara a que GitHub deje listo el contenedor.
              Puedes dejar esta ventana abierta; si no se redirige automaticamente, quedara disponible la opcion de abrirlo manualmente.
            </p>
            <div class="button-row">
              <button class="primary-button" id="processNoticeConfirmBtn" type="button">Entendido</button>
            </div>
          </div>
        </section>

        <aside class="settings-panel" id="settingsPanel">
          <div class="settings-head">
            <div>
              <strong>Configuracion</strong>
              <p class="settings-note">El profesor ajusta la politica RF-05 y el estudiante conserva solo opciones tecnicas y de sesion.</p>
            </div>
            <button class="icon-button" id="settingsCloseBtn" type="button" aria-label="Cerrar">&times;</button>
          </div>

          <div class="settings-grid">
            <div class="field">
              <label for="settingsSessionLabel">Sesion</label>
              <input id="settingsSessionLabel" type="text" readonly />
            </div>

            <div class="field">
              <label for="settingsSessionMeta">Detalle de sesion</label>
              <textarea id="settingsSessionMeta" readonly></textarea>
            </div>

            <div class="switch-row">
              <span>Tutor activo</span>
              <input id="teacherEnabled" type="checkbox" />
            </div>

            <div class="switch-row">
              <span>Configuracion automatica (archivo principal)</span>
              <input id="autoConfigEnabled" type="checkbox" />
            </div>

            <div class="field">
              <label for="backendUrlInput">Base URL del backend</label>
              <input id="backendUrlInput" type="text" placeholder="http://127.0.0.1:3000" />
            </div>

            <div class="settings-role-block" id="advancedGithubBlock" hidden>
              <div class="field">
                <label>Ajustes avanzados GitHub App</label>
                <p class="settings-note" id="advancedGithubNote">
                  Si necesitas forzar una nueva rama/PR de bootstrap para este repo, hazlo desde aquí.
                </p>
                <div class="button-row" style="margin-top:8px;">
                  <button class="save-button" id="githubAppBootstrapBtn" type="button">Rehacer PR devcontainer</button>
                </div>
              </div>

              <section class="settings-subcard" id="githubAppSection">
                <div class="settings-subhead">
                  <div>
                    <h3>GitHub App estable</h3>
                    <p class="settings-note" id="githubAppStatusText">Abre un repositorio para conectar la app.</p>
                  </div>
                  <div style="display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end; margin-top:0;">
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

            <div class="settings-role-block" id="teacherSettingsBlock" hidden>
              <div class="field">
                <label for="teacherPolicyName">Nombre de la politica</label>
                <input id="teacherPolicyName" type="text" placeholder="RF-05 base del piloto" />
              </div>

            <div class="field">
              <label for="teacherOutcome">Resultado de aprendizaje</label>
              <select id="teacherOutcome">
                <option value="RA1">RA1</option>
                <option value="RA2">RA2</option>
                <option value="RA3">RA3</option>
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

            <div class="switch-row">
              <span>Permitir mini quiz</span>
              <input id="teacherMiniQuiz" type="checkbox" />
            </div>

            <div class="switch-row">
              <span>Bloquear solucion completa</span>
              <input id="teacherNoSolution" type="checkbox" />
            </div>

            <div class="field">
              <label for="teacherMaxHints">Maximo de pistas por ejercicio</label>
              <input id="teacherMaxHints" type="number" min="1" step="1" placeholder="3" />
            </div>

            <div class="field">
              <label>Intervenciones habilitadas</label>
              <div class="check-grid">
                <label class="check-item"><span>Explicacion</span><input id="teacherAllowExplanation" type="checkbox" /></label>
                <label class="check-item"><span>Pista</span><input id="teacherAllowHint" type="checkbox" /></label>
                <label class="check-item"><span>Ejemplo parcial</span><input id="teacherAllowExample" type="checkbox" /></label>
                <label class="check-item"><span>Mini quiz</span><input id="teacherAllowMiniQuizType" type="checkbox" /></label>
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
          </div>

          <div class="button-row">
            <button class="ghost-button" id="logoutSettingsBtn" type="button">Cerrar sesion</button>
            <button class="save-button" id="saveSettingsBtn" type="button">Guardar cambios</button>
          </div>
        </aside>

        <section class="analysis-window" id="analysisWindow" hidden>
          <div class="analysis-head">
            <div>
              <strong>Analisis de archivos en Codespaces</strong>
              <p class="analysis-meta" id="analysisStats">Pulsa Explorar proyecto para leer archivos y carpetas del explorador.</p>
            </div>
            <button class="icon-button" id="analysisCloseBtn" type="button" aria-label="Cerrar analisis">&times;</button>
          </div>
          <div class="analysis-body">
            <ul class="analysis-tree" id="analysisFileList"></ul>
          </div>
        </section>
      </div>
    </div>
`;
}
