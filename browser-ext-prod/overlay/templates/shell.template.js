// ADACEEN | Capa 4 - UI: esqueleto del overlay (vistas, modales, ventana de analisis). Las pestanas, las
// paginas del docente y la tuerca vienen de tab-panels, teacher-pages y settings-panel.template.js.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
function buildOverlayShellTemplate() {
  return `${OVERLAY_STYLES}
    <div class="shell" id="shell">
      <button class="minimized-tab" id="minimizedTabBtn" type="button" aria-label="Restaurar ADACEEN" hidden>
        <span class="minimized-tab-mark" aria-hidden="true">A</span>
        <span class="minimized-tab-copy">
          <strong id="minimizedTabTitle">ADACEEN</strong>
          <span id="minimizedTabSubtitle">tutor contextual</span>
        </span>
      </button>
      <div class="window" id="window" role="dialog" aria-modal="false" aria-label="ADACEEN, tutor de programación" tabindex="-1">
        <header class="header" id="dragHandle">
          <!-- Cabecera (dirección B, 0.7.22): «adaceen» y, con sesión, las iniciales, el nombre y el
               rol de quien entró; sin sesión, la versión. -->
          <div class="brand" id="headerBrand">
            <span class="brand-mark" aria-hidden="true">adaceen</span>
            <span class="user-badge" id="headerUserBadge" aria-hidden="true" hidden></span>
            <div class="brand-user">
              <strong id="headerUserTitle"></strong>
              <span id="headerUserSubtitle">${ADACEEN_BROWSER_EXTENSION_VERSION}</span>
            </div>
          </div>
          <div class="header-actions">
            <button class="icon-button" id="minimizeBtn" type="button" aria-label="Minimizar ADACEEN" title="Minimizar"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 8h10"></path></svg></button>
            <button class="icon-button" id="settingsBtn" type="button" aria-label="Configuración" title="Configuración" aria-controls="settingsPanel" aria-expanded="false"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 4h6M11 4h3M2 8h2M7 8h7M2 12h8M13 12h1"></path><circle cx="9.5" cy="4" r="1.5"></circle><circle cx="5.5" cy="8" r="1.5"></circle><circle cx="11.5" cy="12" r="1.5"></circle></svg></button>
            <button class="icon-button text-button" id="logoutHeaderBtn" type="button" aria-label="Salir de la sesión">Salir</button>
            <button class="icon-button" id="closeBtn" type="button" aria-label="Cerrar ADACEEN" title="Cerrar (Escape)" aria-keyshortcuts="Escape"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 3l10 10M13 3L3 13"></path></svg></button>
          </div>
        </header>

        <div class="body">
          <section class="view" id="welcomeView">
            <span class="pill" id="welcomeContext">Contexto</span>
            <h1>ADACEEN está listo</h1>
            <p class="copy" id="welcomeCopy">Vista contextual para Campus, GitHub y Codespaces.</p>
            <p class="policy-lead">Inicia sesion para activar las pistas del curso.</p>
            <div class="button-row">
              <button class="primary-button" id="startBtn" type="button">Empezar</button>
            </div>
          </section>

          <section class="view auth-view" id="authView" hidden>
            <!-- Dirección B (0.7.22): la versión va en la cabecera («adaceen 0.7.22»). -->
            <p class="auth-step-line" id="studentCodeWhoLine" hidden><span id="studentCodeWho"></span><span class="auth-step-count" id="studentCodeStepCount">paso 2/2</span></p>
            <h1 id="authTitle">Entrar</h1>
            <p class="copy" id="authCopy">Con tu cuenta de Google de la universidad. La primera vez te pedimos tu código de estudiante.</p>
            <div class="auth-card" id="authLoginCard">
              <button class="google-button" id="googleAuthBtn" type="button">Continuar con Google</button>
              <div class="auth-divider"><span>o con correo y contraseña</span></div>
              <div class="field">
                <label for="authEmail">Correo</label>
                <input id="authEmail" type="text" autocomplete="username" placeholder="nombre@correounivalle.edu.co" />
              </div>
              <div class="field">
                <label for="authPassword">Contraseña</label>
                <input id="authPassword" type="password" autocomplete="current-password" />
              </div>
              <p class="settings-note" id="authHelper" hidden>
                Demo estudiante: estudiante@adaceen.edu.co / Estudiante123!<br />
                Demo profesor: docente@adaceen.edu.co / Docente123!<br />
                Demo admin: admin@adaceen.edu.co / Admin123!
              </p>
              <p class="status" id="authError" role="alert"></p>
            </div>
            <!-- Codigo de estudiante (0.7.22): despues de Google o de la clave, si el backend lo pide
                 o si el acceso espera la aprobacion del docente. -->
            <div class="auth-card student-code-card" id="studentCodeCard" hidden>
              <div class="field" id="studentCodeField">
                <label for="studentCodeInput">7 dígitos</label>
                <!-- Un solo campo sobre siete casillas dibujadas: pegar «2312345-3743», el
                     autocompletado y los lectores de pantalla funcionan como en cualquier campo. -->
                <div class="code-cells" id="studentCodeCells">
                  <div class="code-cells-grid" aria-hidden="true">
                    <span class="code-cell"></span><span class="code-cell"></span><span class="code-cell"></span><span class="code-cell"></span><span class="code-cell"></span><span class="code-cell"></span><span class="code-cell"></span>
                  </div>
                  <input id="studentCodeInput" class="student-code-input" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" maxlength="12" aria-describedby="studentCodeHint studentCodeStatus" />
                </div>
                <p class="settings-note" id="studentCodeHint">El de Univalle. Si lo pegas con el programa (2312345-3743), se toma el código.</p>
              </div>
              <dl class="b-dl b-dl-box" id="studentCodeReview" hidden>
                <dt>código</dt><dd class="b-mono" id="studentCodeReviewCode"></dd>
                <dt>entró con</dt><dd class="b-mono" id="studentCodeReviewEmail"></dd>
                <dt>pedido</dt><dd id="studentCodeReviewAt"></dd>
              </dl>
              <p class="status" id="studentCodeStatus" role="alert"></p>
            </div>
            <div class="button-row auth-actions">
              <button class="primary-button" id="authSubmitBtn" type="button">Entrar</button>
              <div class="auth-links">
                <button class="link-button" id="authBackBtn" type="button">Volver</button>
                <a class="policy-link" id="studentCodePolicyLink" href="https://app-adaceen-api-eyder05232002.azurewebsites.net/privacy-policy" target="_blank" rel="noopener noreferrer">Privacidad</a>
              </div>
            </div>
            <p class="settings-note auth-policy-note" id="authPolicyNote">Al entrar, ADACEEN guarda tu nombre, tu correo y tu código de estudiante. <a class="policy-link" id="authPolicyLink" href="https://app-adaceen-api-eyder05232002.azurewebsites.net/privacy-policy" target="_blank" rel="noopener noreferrer">Política de privacidad</a></p>
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
                  <span class="eyebrow">Acción recomendada</span>
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
            <!-- Pestañas de la vista principal (0.7.13): cada rol ve las suyas y cada una cabe en la ventana. -->
            <div class="tab-bar" id="mainTabBar" role="tablist" aria-label="Secciones de ADACEEN">
              <button class="tab-button" id="tabBtnInicio" type="button" role="tab" data-tab="inicio" aria-selected="true" aria-controls="tabPanelInicio">Inicio</button>
              <button class="tab-button" id="tabBtnTutor" type="button" role="tab" data-tab="tutor" aria-selected="false" aria-controls="tabPanelTutor" tabindex="-1" hidden>Tutor</button>
              <button class="tab-button" id="tabBtnAgenda" type="button" role="tab" data-tab="agenda" aria-selected="false" aria-controls="tabPanelAgenda" tabindex="-1" hidden>Agenda</button>
              <button class="tab-button" id="tabBtnEstudiantes" type="button" role="tab" data-tab="estudiantes" aria-selected="false" aria-controls="tabPanelEstudiantes" tabindex="-1" hidden>Estudiantes<span class="tab-count" id="tabCountEstudiantes" hidden></span></button>
              <button class="tab-button" id="tabBtnRag" type="button" role="tab" data-tab="rag" aria-selected="false" aria-controls="tabPanelRag" tabindex="-1" hidden>RAG</button>
              <button class="tab-button" id="tabBtnQuices" type="button" role="tab" data-tab="quices" aria-selected="false" aria-controls="tabPanelQuices" tabindex="-1" hidden>Quices</button>
              <button class="tab-button" id="tabBtnBitacora" type="button" role="tab" data-tab="bitacora" aria-selected="false" aria-controls="tabPanelBitacora" tabindex="-1" hidden>Bitácora<span class="tab-flag" id="tabFlagBitacora" title="Aún no has subido la bitácora" hidden><span class="sr-only">(falta subirla)</span></span></button>
              <button class="tab-button" id="tabBtnUsuarios" type="button" role="tab" data-tab="usuarios" aria-selected="false" aria-controls="tabPanelUsuarios" tabindex="-1" hidden>Usuarios</button>
            </div>

            <div class="main-top">
              <div class="main-top-left">
                <span class="pill" id="mainContext">Contexto</span>
                <span class="pill role-pill" id="roleBadge">Rol</span>
              </div>
              <div class="main-top-actions">
                <button class="ghost-button" id="refreshBtn" type="button" title="Pedir ayuda al tutor (Ctrl+Enter)" aria-keyshortcuts="Control+Enter">Actualizar</button>
              </div>
            </div>

            ${buildTabPanelInicioTemplate()}

            ${buildTabPanelTutorTemplate()}

            ${buildTabPanelAgendaTemplate()}

            ${buildTabPanelEstudiantesTemplate()}

            ${buildTabPanelRagTemplate()}

            ${buildTabPanelQuicesTemplate()}

            ${buildTabPanelBitacoraTemplate()}

            ${buildTabPanelUsuariosTemplate()}

            <p class="status" id="statusText" role="status"></p>
          </section>
        </div>

        <section class="confirmation-modal" id="firstLoginModal" hidden role="dialog" aria-modal="true" tabindex="-1" aria-labelledby="firstLoginTitle">
          <div class="confirmation-dialog">
            <p class="dialog-line" id="firstLoginVersion">privacidad · versión ${ADACEEN_PRIVACY_POLICY_VERSION}</p>
            <h2 id="firstLoginTitle">Antes de empezar</h2>
            <p class="copy" id="firstLoginCopy">
              Es la primera vez que ingresas a ADACEEN con esta cuenta. Revisa y acepta el uso de datos del piloto antes de continuar.
            </p>
            <!-- Aviso destacado (Chrome Web Store, 0.7.22): lo esencial de la politica antes de aceptar. -->
            <dl class="b-dl consent-points">
              <dt>guardamos</dt><dd>Tu nombre, tu correo y tu código de estudiante. Tu docente los ve junto con tu progreso.</dd>
              <dt>leemos</dt><dd>La página de Campus, GitHub o tu editor cuando pides ayuda. Tu repositorio, solo si das permiso.</dd>
              <dt>registramos</dt><dd>El uso del tutor, seudonimizado, para la investigación del piloto. Nada se vende ni se usa para publicidad.</dd>
            </dl>
            <p class="copy consent-link"><a id="firstLoginPolicyLink" href="https://app-adaceen-api-eyder05232002.azurewebsites.net/privacy-policy" target="_blank" rel="noopener noreferrer">Leer la política completa</a></p>
            <div class="button-row split">
              <button class="ghost-button" id="firstLoginLogoutBtn" type="button">Cerrar sesión</button>
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

        ${buildTeacherRagPageTemplate()}

        ${buildSettingsPanelTemplate()}

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
