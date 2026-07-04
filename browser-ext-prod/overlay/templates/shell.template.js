function buildOverlayShellTemplate() {
  return `${OVERLAY_STYLES}
    <div class="shell" id="shell">
      <aside class="vscode-inline-palette" id="vscodeInlinePalette" aria-live="polite" hidden>
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
      <aside class="panel-section vscode-sync-bottom vscode-sync-overlay" id="vscodeSyncSection" aria-live="polite" hidden>
        <div class="summary-head section-head vscode-sync-drag-handle" id="vscodeSyncDragHandle">
          <span class="eyebrow">Contexto de trabajo</span>
          <div class="summary-actions">
            <button class="ghost-button analyze-button" id="vscodeCopySessionBtn" type="button">Copiar sesion</button>
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
            <button class="icon-button" id="minimizeBtn" type="button" aria-label="Minimizar ADACEEN">&minus;</button>
            <button class="icon-button" id="settingsBtn" type="button" aria-label="Configuracion">&#9881;</button>
            <button class="icon-button text-button" id="logoutHeaderBtn" type="button" aria-label="Salir">Salir</button>
            <button class="icon-button" id="closeBtn" type="button" aria-label="Salir">&times;</button>
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
            <p class="copy">Confirma el repo, autoriza GitHub y deja Codespaces listo para trabajar.</p>

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
              <span class="eyebrow">Paso 1 de 3</span>
              <h2>Confirmar repositorio</h2>
              <p class="settings-note">ADACEEN trabajara en una rama de preparacion; la rama principal no se toca.</p>
              <div class="field">
                <label for="setupRepoInput">Repositorio a preparar (owner/repo o URL)</label>
                <input id="setupRepoInput" type="text" placeholder="ejemplo: eydersantiago/finagent o https://github.com/eydersantiago/finagent" />
              </div>
              <div class="button-row split tight-row">
                <button class="ghost-button" id="setupExploreBtn" type="button">Leer archivos del repo</button>
                <button class="ghost-button" id="setupDetectRepoBtn" type="button">Autodetectar</button>
              </div>
              <div class="button-row tight-row">
                <button class="primary-button" id="setupToStep2Btn" type="button">Autorizar repositorio</button>
              </div>
            </div>

            <div class="summary-card setup-step-card" id="setupStepTwoCard" hidden>
              <span class="eyebrow">Paso 2 de 3</span>
              <h2>Autorizar GitHub App</h2>
              <p class="settings-note">La app permite crear el PR de configuracion y verificar acceso al repo.</p>
              <div class="button-row split tight-row">
                <button class="ghost-button" id="setupInstallAppBtn" type="button">Abrir instalacion</button>
                <button class="ghost-button" id="setupRefreshAppBtn" type="button">Verificar acceso</button>
              </div>
              <div class="button-row split tight-row">
                <button class="ghost-button" id="setupBackToStep1Btn" type="button">Volver</button>
                <button class="primary-button" id="setupToStep3Btn" type="button">Preparar entorno</button>
              </div>
            </div>

            <div class="summary-card setup-step-card" id="setupStepThreeCard" hidden>
              <span class="eyebrow">Paso 3 de 3</span>
              <h2>Preparar Codespaces</h2>
              <p class="settings-note">Se crea o reutiliza el PR y se abre el Codespace asociado.</p>
              <div class="button-row tight-row">
                <button class="save-button" id="setupCreatePrBtn" type="button">Crear PR</button>
              </div>
              <div class="button-row split tight-row">
                <button class="ghost-button" id="setupBackToStep2Btn" type="button">Volver</button>
                <button class="primary-button" id="setupContinueBtn" type="button">Ir al dashboard</button>
              </div>
            </div>

            <p class="status" id="setupStatusText">Paso 1/3: confirma el repositorio que vamos a preparar.</p>
            <div class="button-row">
              <button class="ghost-button" id="setupLogoutBtn" type="button">Cerrar sesion</button>
            </div>
          </section>

          <section class="view" id="mainView" hidden>
            <div class="main-top">
              <div class="main-top-left">
                <span class="pill" id="mainContext">Contexto</span>
                <span class="pill role-pill" id="roleBadge">Rol</span>
              </div>
              <div class="main-top-actions">
                <button class="ghost-button" id="refreshBtn" type="button">Actualizar</button>
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
                <div class="summary-actions">
                  <button class="ghost-button analyze-button teacher-only" id="teacherBitacoraUploadBtn" type="button" hidden>Bitacora</button>
                  <button class="ghost-button analyze-button teacher-only" id="teacherRagManageBtn" type="button" hidden>Configurar RAG</button>
                  <button class="ghost-button analyze-button" id="analyzeProjectBtn" type="button">Explorar</button>
                  <button class="ghost-button analyze-button" id="rerunOcrBtn" type="button">OCR</button>
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

            <section class="panel-section" id="adminUsersSection" hidden>
              <div class="summary-head section-head">
                <span class="eyebrow">Administracion de usuarios</span>
                <div class="summary-actions">
                  <button class="ghost-button analyze-button" id="adminToggleCreateUserBtn" type="button" aria-controls="adminCreateForm" aria-expanded="false">Agregar usuario</button>
                  <button class="ghost-button analyze-button" id="adminReloadUsersBtn" type="button">Recargar</button>
                </div>
              </div>
              <p class="policy-lead" id="adminUsersStatus">Carga los usuarios para empezar.</p>

              <div class="field field-stack admin-create-form" id="adminCreateForm" hidden>
                <label for="adminCreateRole">Agregar usuario</label>
                <div class="button-row split tight-row">
                  <select id="adminCreateRole">
                    <option value="student">Estudiante</option>
                    <option value="teacher">Profesor</option>
                  </select>
                  <input id="adminCreateName" type="text" placeholder="Nombre completo" />
                </div>
                <div class="button-row split tight-row">
                  <input id="adminCreateEmail" type="text" placeholder="correo@adaceen.edu.co" />
                  <input id="adminCreatePassword" type="password" placeholder="Contrasena temporal" />
                </div>
                <div class="button-row split tight-row">
                  <select id="adminCreateTeacher">
                    <option value="">Profesor por defecto</option>
                  </select>
                  <button class="save-button" id="adminCreateBtn" type="button">Crear usuario</button>
                </div>
                <div class="course-picker" id="adminCreateCoursePicker">
                  <span class="eyebrow">Cursos del estudiante</span>
                  <div class="course-chip-grid" id="adminCreateCourseGrid"></div>
                </div>
              </div>

              <div class="admin-table-wrap table-section">
                <table class="admin-table">
                  <thead>
                    <tr>
                      <th>Nombre</th>
                      <th>Correo</th>
                      <th>Rol</th>
                      <th>Profesor</th>
                      <th>Cursos</th>
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

            <section class="panel-section" id="ragSourcesSection" hidden>
              <div class="summary-head section-head">
                <span class="eyebrow">Fuentes RAG usadas</span>
                <span class="state-chip" id="ragActiveCourseBadge">FPOO</span>
              </div>
              <ul class="compact-list rag-citation-list" id="ragSourcesList"></ul>
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
              <div class="section-title-row">
                <h2>Telemetria reciente</h2>
                <button class="ghost-button analyze-button" id="reloadTelemetryBtn" type="button">Recargar</button>
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

        <section class="confirmation-modal course-modal" id="studentCourseModal" hidden role="dialog" aria-modal="true" aria-labelledby="studentCourseTitle">
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

        <section class="confirmation-modal conflict-modal" id="tabConflictModal" hidden role="dialog" aria-modal="true" aria-labelledby="tabConflictTitle">
          <div class="confirmation-dialog">
            <span class="pill">Sesion activa</span>
            <h2 id="tabConflictTitle">Ya hay una sesión activa</h2>
            <p class="copy" id="tabConflictNotice"></p>
            <div class="button-row">
              <button class="primary-button" id="tabConflictRefreshBtn" type="button">Revisar nuevamente</button>
            </div>
          </div>
        </section>

        <section class="teacher-bitacora-page" id="teacherBitacoraPage" hidden role="dialog" aria-modal="true" aria-labelledby="teacherBitacoraTitle">
          <div class="bitacora-page-head">
            <div>
              <span class="pill">Bitacora docente</span>
              <h2 id="teacherBitacoraTitle">Gestionar bitacora del curso</h2>
              <p id="teacherBitacoraStatusText">Consulta, descarga plantilla o carga un archivo Excel/PDF.</p>
            </div>
            <button class="icon-button" id="teacherBitacoraCloseBtn" type="button" aria-label="Volver">&times;</button>
          </div>
          <div class="bitacora-page-body">
            <section class="summary-card">
              <span class="eyebrow">Estado</span>
              <p class="teacher-summary" id="teacherBitacoraLatestText">Aun no hay bitacora cargada.</p>
              <ul class="compact-list" id="teacherBitacoraAgendaList"></ul>
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
            <p class="status" id="teacherBitacoraPageStatus"></p>
          </div>
        </section>

        <section class="teacher-rag-page" id="teacherRagPage" hidden role="dialog" aria-modal="true" aria-labelledby="teacherRagTitle">
          <div class="bitacora-page-head">
            <div>
              <span class="pill">RAG por curso</span>
              <h2 id="teacherRagTitle">Gestionar fuentes del curso</h2>
              <p id="teacherRagStatusText">FPOO queda como RAG por defecto; puedes cargar fuentes por curso.</p>
            </div>
            <button class="icon-button" id="teacherRagCloseBtn" type="button" aria-label="Volver">&times;</button>
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
            <p class="status" id="teacherRagPageStatus"></p>
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
              <input id="backendUrlInput" type="text" placeholder="https://app-adaceen-api-eyder05232002.azurewebsites.net" />
            </div>

            <div class="settings-role-block" id="advancedGithubBlock" hidden>
              <div class="field">
                <label>Ajustes avanzados GitHub App</label>
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
              <strong id="analysisTitle">Analisis de archivos en Codespaces</strong>
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
