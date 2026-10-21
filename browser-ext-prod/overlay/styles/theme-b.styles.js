// ADACEEN | Capa 4 - UI: dirección B del rediseño (0.7.22), «herramienta de código».
// Va después de los demás módulos (y antes de responsive) y cubre lo que es propio de la B:
// pares clave y valor en monoespaciada, la barra de «Usuarios», la tarjeta de la respuesta del
// tutor y, al final, el pase de 0.8.3 para que el panel no se vea monótono.
// Los tokens están en base.styles.js; el prototipo, en el lienzo «Rediseño del overlay de ADACEEN».
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const OVERLAY_THEME_B_STYLES = `      /* ---- Pares clave y valor: la clave en monoespaciada a la izquierda ---- */
      .b-dl {
        margin: 0;
        display: grid;
        grid-template-columns: 84px minmax(0, 1fr);
        row-gap: 10px;
        column-gap: 12px;
        font-size: 0.9375rem;
        line-height: 1.45;
      }

      .b-dl dt {
        padding-top: 2px;
        color: var(--adaceen-muted);
        font-family: var(--adaceen-mono);
        font-size: 0.8125rem;
      }

      .b-dl dd {
        margin: 0;
        min-width: 0;
        color: var(--adaceen-ink);
        overflow-wrap: anywhere;
      }

      .b-dl dt[hidden],
      .b-dl dd[hidden] {
        display: none;
      }

      .b-dl-box {
        padding: 12px 14px;
        border-radius: var(--adaceen-radius-control);
        background: var(--adaceen-soft);
        font-size: 0.875rem;
      }

      .b-mono,
      .b-dl dd.b-mono {
        font-family: var(--adaceen-mono);
        font-size: 0.875rem;
      }

      .student-code-card .b-dl-box {
        margin-top: 2px;
      }

      /* ---- Pares clave y valor en una franja suave (Inicio: política y resumen de sesión) ---- */
      .kv-grid {
        margin: 8px 0 0;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
        gap: 10px 16px;
        padding: 10px 12px;
        border-radius: var(--adaceen-radius-control);
        background: var(--adaceen-soft);
      }

      .kv-grid[hidden] {
        display: none;
      }

      .kv-item {
        min-width: 0;
        display: grid;
        gap: 2px;
      }

      .kv-item dt {
        color: var(--adaceen-muted);
        font-family: var(--adaceen-mono);
        font-size: 0.75rem;
        text-transform: lowercase;
      }

      .kv-item dd {
        margin: 0;
        min-width: 0;
        color: var(--adaceen-ink);
        font-size: 0.875rem;
        line-height: 1.4;
        overflow-wrap: anywhere;
      }

      .kv-item dd.b-mono {
        font-size: 0.8125rem;
      }

      /* Un correo o una ruta: dos columnas para no partirse en pedazos. */
      .kv-item.is-wide {
        grid-column: span 2;
      }

      .kv-grid.kv-list .kv-item.is-wide {
        grid-column: auto;
      }

      /* Variante en filas (frases): la clave a la izquierda y el texto a la derecha, sin franja. */
      .kv-grid.kv-list {
        grid-template-columns: minmax(0, 1fr);
        gap: 8px;
        padding: 0;
        background: transparent;
      }

      .kv-grid.kv-list .kv-item {
        grid-template-columns: 120px minmax(0, 1fr);
        column-gap: 12px;
        align-items: baseline;
      }

      .kv-grid.kv-list .kv-item dd {
        color: var(--adaceen-body);
      }

      .summary-card .kv-grid.kv-list {
        margin-top: 12px;
      }

      .home-facts-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
      }

      .home-facts-head .eyebrow {
        margin-bottom: 0;
      }

      .home-facts-note {
        color: var(--adaceen-muted);
        font-family: var(--adaceen-mono);
        font-size: 0.75rem;
      }

      .home-facts-note:empty {
        display: none;
      }

      .summary-card .signal {
        margin-top: 4px;
        color: var(--adaceen-body);
        font-size: 0.875rem;
      }

      @media (max-width: 520px) {
        .kv-grid.kv-list .kv-item {
          grid-template-columns: minmax(0, 1fr);
        }
      }

      /* ---- Capas de color (0.7.22): las vistas sueltas (bienvenida y entrar) van en una tarjeta
         blanca sobre el fondo del panel, como las secciones de las pestañas. ---- */
      #welcomeView.view,
      .view.auth-view {
        padding: 18px 18px 16px;
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius);
        background: var(--adaceen-panel);
      }

      /* La tuerca usa el mismo fondo que las pestañas; sus secciones son tarjetas blancas. */
      .settings-panel {
        background: var(--adaceen-canvas);
        backdrop-filter: none;
      }

      /* Tablas: la fila de títulos en una franja gris, con aire a los lados para que no toque el
         borde de la franja. */
      .admin-table th {
        background: var(--adaceen-soft);
      }

      .admin-table th:first-child,
      .admin-table td:first-child {
        padding-left: 10px;
      }

      .admin-table th:last-child,
      .admin-table td:last-child {
        padding-right: 10px;
      }

      /* «Estudiantes» con la gestión de «Usuarios» (0.7.22): casilla a la izquierda y «Editar» y
         «Eliminar» a la derecha; la analítica (sesiones, tutor, quices, nota) queda en medio. */
      .students-table .admin-select-cell {
        width: 32px;
        padding-right: 4px;
      }

      /* Para que las ocho columnas quepan en el panel: los títulos y las notas de cada dato bajan
         de línea, y «Editar» y «Eliminar» van uno sobre otro. */
      .students-table th {
        white-space: normal;
      }

      .students-table td:not(.student-cell):not(.admin-actions-cell):not(.admin-select-cell) {
        min-width: 64px;
        max-width: 132px;
        white-space: normal;
      }

      .students-table td.student-cell {
        min-width: 150px;
        max-width: 220px;
      }

      .students-table .grade-chip {
        white-space: nowrap;
      }

      .students-table .admin-actions-cell {
        width: 1%;
      }

      .students-table .admin-actions-cell > * + * {
        margin-left: 0;
        margin-top: 6px;
      }

      .students-table .admin-actions-cell .ghost-button {
        display: flex;
        justify-content: center;
        width: 100%;
        min-height: 32px;
        padding: 4px 10px;
        font-size: 0.875rem;
      }

      .students-table tbody tr.is-editing td {
        background: var(--adaceen-primary-soft);
        border-bottom-color: transparent;
      }

      .students-table tbody tr.admin-edit-row {
        cursor: default;
      }

      .students-table tbody tr.admin-edit-row:hover td {
        background: transparent;
      }

      .students-table .admin-edit-row td {
        white-space: normal;
      }

      /* Filas más altas (acciones una sobre otra): más alto el cuadro antes del scroll. */
      .students-table-wrap {
        max-height: 440px;
      }

      /* Con una fila en edición la tabla crece: el formulario no queda en una caja con scroll. */
      .students-table-wrap:has(.admin-edit-row) {
        max-height: none;
      }

      .admin-forms-host:empty {
        display: none;
      }

      /* Indicadores del panel: los neutros en gris suave; activos y avisos conservan su color. */
      .kpi-tile:not(.is-accent):not(.is-warning) {
        background: var(--adaceen-soft);
      }

      /* El título del resumen de sesión es el de la página: en dos líneas como mucho. */
      .summary-card .summary-title {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        overflow: hidden;
      }

      /* ---- Aviso de privacidad ---- */
      .confirmation-dialog .b-dl {
        grid-template-columns: 96px minmax(0, 1fr);
        margin-top: 12px;
        font-size: 0.875rem;
        line-height: 1.5;
      }

      .confirmation-dialog .b-dl dd {
        color: var(--adaceen-body);
      }

      .confirmation-dialog .consent-link {
        margin-top: 12px;
      }

      .confirmation-dialog .copy {
        font-size: 0.875rem;
      }

      .confirmation-dialog .pill {
        display: block;
        margin-bottom: 4px;
      }

      /* ---- Tutor: la respuesta en una sola tarjeta con borde (la única de la pestaña) ---- */
      .tutor-response-region {
        margin-bottom: 12px;
        padding: 14px 16px;
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius);
        background: var(--adaceen-panel);
      }

      /* Sin pistas ni pasos visibles (tutor bloqueado o pausado), la tarjeta no se dibuja vacía. */
      .tutor-response-region:not(:has(> .panel-section:not([hidden]))) {
        display: none;
      }

      /* Dentro de la tarjeta de la respuesta, «Pistas de hoy» y «Siguiente paso» no son tarjetas:
         van separadas por una línea. */
      .tutor-response-region .panel-section,
      .shell-expanded .tab-panel .tutor-response-region .panel-section {
        margin: 0;
        padding: 0;
        border: 0;
        border-radius: 0;
        background: transparent;
      }

      .tutor-response-region .panel-section:not([hidden]) ~ .panel-section:not([hidden]) {
        margin-top: 14px;
        padding-top: 14px;
        border-top: 1px solid var(--adaceen-border);
      }

      .tutor-response-region h2 {
        font-size: 0.9375rem;
      }

      .tutor-feedback h2 {
        color: var(--adaceen-muted);
        font-family: var(--adaceen-mono);
        font-size: 0.8125rem;
        font-weight: 400;
      }

      .rag-sources-summary .eyebrow {
        margin-bottom: 0;
      }

      .preview-card summary {
        color: var(--adaceen-muted);
        font-family: var(--adaceen-mono);
        font-size: 0.8125rem;
        font-weight: 400;
      }

      /* ---- Usuarios: barra con título, conteo, búsqueda y acciones ---- */
      .users-toolbar {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 10px;
        margin-bottom: 16px;
      }

      .users-toolbar-title {
        flex: 1 1 200px;
        min-width: 0;
        display: grid;
        gap: 2px;
      }

      .users-toolbar-title h2 {
        margin: 0;
        font-size: 1.125rem;
      }

      .users-count {
        color: var(--adaceen-muted);
        font-family: var(--adaceen-mono);
        font-size: 0.8125rem;
        line-height: 1.4;
      }

      .users-search {
        flex: 0 1 240px;
        min-width: 160px;
        min-height: 44px;
        padding: 0 12px;
        border: 1px solid var(--adaceen-control-border);
        border-radius: var(--adaceen-radius-control);
        background: #fff;
        color: var(--adaceen-ink);
        font-size: 0.875rem;
      }

      .users-search:focus {
        outline: none;
        border-color: var(--adaceen-primary);
        box-shadow: 0 0 0 1px var(--adaceen-primary);
      }

      .users-toolbar .summary-actions .analyze-button {
        min-height: 44px;
      }

      /* Etiquetas de la tabla: texto plano en monoespaciada, no pastillas. */
      .admin-chip {
        padding: 0;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: var(--adaceen-ink);
        font-family: var(--adaceen-mono);
        font-size: 0.8125rem;
        font-weight: 400;
        text-transform: lowercase;
      }

      .admin-chip.is-teacher,
      .admin-chip.is-active {
        background: transparent;
        color: var(--adaceen-ink);
      }

      .admin-chip.is-inactive {
        background: transparent;
        color: var(--adaceen-muted);
      }

      .admin-chip.is-course,
      .admin-chip.is-lot,
      .admin-chip.is-lot-student {
        padding: 1px 6px;
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius-control);
        background: var(--adaceen-soft);
        color: var(--adaceen-body);
        text-transform: none;
      }

      .admin-chip.is-code {
        text-transform: none;
      }

      .admin-chip.is-missing-code {
        color: var(--adaceen-warning);
        white-space: normal;
      }

      .admin-code-cell {
        min-width: 92px;
      }

      .admin-user-login-emails {
        font-family: var(--adaceen-mono);
      }

      .admin-user-row.is-editing td {
        background: transparent;
        border-bottom-color: transparent;
      }

      .admin-edit-row td {
        background: transparent;
        padding: 0 0 12px !important;
      }

      .admin-edit-form {
        padding: 14px;
        border-radius: var(--adaceen-radius-control);
        background: var(--adaceen-soft);
      }

      .admin-edit-field {
        color: var(--adaceen-muted);
        font-weight: 400;
      }

      .admin-edit-field input,
      .admin-edit-field select {
        min-height: 40px;
        font-family: var(--adaceen-sans);
        font-size: 0.875rem;
        font-weight: 400;
      }

      .admin-users-table th:first-child,
      .admin-users-table td:first-child {
        padding-left: 0;
      }

      .admin-users-table th:last-child,
      .admin-users-table td:last-child {
        padding-right: 0;
      }

      .admin-users-table .admin-actions-cell .ghost-button {
        min-height: 36px;
      }

      /* «Eliminar seleccionados» (0.7.22): casilla por estudiante y barra con el conteo. */
      .admin-users-table .admin-select-cell {
        width: 32px;
        padding-right: 4px;
      }

      .admin-select-cell input[type="checkbox"] {
        width: 18px;
        height: 18px;
        margin: 0;
        cursor: pointer;
        vertical-align: middle;
      }

      .users-bulk-bar {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
        margin: 0 0 14px;
        padding: 8px 12px;
        border: 1px solid var(--adaceen-border-strong);
        border-radius: var(--adaceen-radius-control);
        background: var(--adaceen-soft);
      }

      .users-bulk-bar[hidden] {
        display: none;
      }

      .users-bulk-count {
        flex: 1 1 auto;
        color: var(--adaceen-ink);
        font-family: var(--adaceen-mono);
        font-size: 0.8125rem;
      }

      /* Solicitudes de acceso: un recuadro con su cabecera, sin la franja de color a la izquierda. */
      .admin-access-requests {
        padding: 0;
        border: 1px solid var(--adaceen-border-strong);
        border-radius: var(--adaceen-radius-control);
      }

      .admin-access-requests > .field-title {
        display: block;
        padding: 10px 12px 0;
        font-size: 0.9375rem;
        font-weight: 600;
      }

      .admin-access-requests .field-hint {
        margin: 4px 12px 8px;
      }

      .admin-access-request-list .admin-access-request {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 10px;
        padding: 12px;
        border: 0;
        border-top: 1px solid var(--adaceen-border);
        border-radius: 0;
        background: transparent;
      }

      .admin-access-request-text {
        flex: 1 1 260px;
        color: var(--adaceen-body);
      }

      .admin-access-request-email {
        color: var(--adaceen-ink);
        font-family: var(--adaceen-mono);
        font-size: 0.8125rem;
      }

      .admin-access-request-actions {
        flex: none;
      }

      .admin-access-request-actions .ghost-button,
      .admin-access-request-actions .save-button {
        width: auto;
        min-height: 44px;
        padding: 0 16px;
        font-size: 0.875rem;
      }

      /* «Docente» del administrador en las pestañas «Bitácora» y «RAG» (0.7.22). */
      .bitacora-owner-field {
        max-width: 460px;
        margin: 2px 0 14px;
      }

      .bitacora-owner-field .settings-note {
        margin: 0;
      }

      .settings-note {
        color: var(--adaceen-muted);
        font-size: 0.8125rem;
        line-height: 1.5;
      }

      /* ==== 0.8.3 (piloto del 20/10/2026): menos monótono ====
         Antes todo empezaba igual: tarjeta blanca, rótulo gris en monoespaciada minúscula y valores
         del mismo color. Ahora: los títulos de sección son palabras (Plex Sans, en el color del
         texto) y la monoespaciada queda para los datos; cada estado lleva su luz de color; la acción
         recomendada tiene botones a su medida; y en Inicio solo el centro de contexto es tarjeta. */

      .eyebrow {
        margin-bottom: 8px;
        color: var(--adaceen-ink);
        font-family: var(--adaceen-sans);
        font-size: 0.875rem;
        font-weight: 600;
        line-height: 1.3;
        text-transform: none;
      }

      /* Antetítulo sobre un título más grande: discreto, para no apilar dos títulos. */
      .context-hub-head .eyebrow,
      .setup-step-card .eyebrow,
      .rag-course-active .eyebrow,
      .agenda-week-card .eyebrow {
        margin-bottom: 2px;
        color: var(--adaceen-muted);
        font-size: 0.8125rem;
        font-weight: 400;
      }

      .context-hub h2 {
        font-size: 1.0625rem;
      }

      /* En pantallas angostas la cabecera pasa a una columna: el estado, a lo ancho de su texto. */
      .context-hub-head .state-chip {
        justify-self: start;
      }

      .next-action .eyebrow {
        margin-bottom: 4px;
        color: var(--adaceen-primary-strong);
        font-size: 0.8125rem;
      }

      /* Luces de estado: verde listo, ámbar pendiente, gris sin empezar. */
      .connection-item strong {
        display: flex;
        align-items: flex-start;
        gap: 7px;
      }

      .connection-item strong::before {
        content: "";
        flex: 0 0 auto;
        width: 7px;
        height: 7px;
        margin-top: 0.5em;
        border-radius: 999px;
        background: var(--adaceen-border-strong);
      }

      .connection-item.is-ok strong::before {
        background: var(--adaceen-success);
      }

      .connection-item.is-warn strong::before {
        background: var(--adaceen-warning);
      }

      .connection-item.is-error strong::before {
        background: var(--adaceen-danger);
      }

      /* Acción recomendada: los botones a su medida y a la derecha, no dos mitades iguales. */
      .next-action .context-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 8px;
      }

      .next-action .context-actions > button {
        width: auto;
        min-width: 132px;
      }

      /* Inicio: después del centro de contexto, la política y el resumen de sesión van sobre el fondo
         del panel; sus datos, en una franja blanca. La tarjeta queda para lo principal. */
      #tabPanelInicio > .home-facts,
      #tabPanelInicio > .home-session {
        margin: 18px 0 12px;
        padding: 0 2px;
        border: 0;
        background: transparent;
      }

      #tabPanelInicio > .home-facts .kv-grid,
      #tabPanelInicio > .home-session .kv-grid:not(.kv-list) {
        border: 1px solid var(--adaceen-border);
        background: var(--adaceen-panel);
      }

      /* «Panel administrador» va en filas (kv-list): dentro de la franja, con su margen. */
      #tabPanelInicio > .home-facts .kv-grid.kv-list {
        padding: 10px 12px;
      }

      #tabPanelInicio > .home-session .summary-title {
        margin-top: 2px;
        font-size: 0.9375rem;
        font-weight: 600;
      }

      /* Indicadores del docente: el número manda. */
      .kpi-value {
        font-family: var(--adaceen-mono);
        font-size: 1.375rem;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
        line-height: 1.1;
      }

      /* «Tema del piloto»: «Quitar tema» y «Guardar tema» a su medida, como la acción recomendada. */
      .pilot-topic-section > .button-row.split {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .pilot-topic-section > .button-row.split > button {
        width: auto;
        min-width: 132px;
      }

      /* Tutor: las pistas con su marca de color y los pasos (que sí son una secuencia) numerados. */
      #ideaList li::marker {
        color: var(--adaceen-primary);
      }

      #guideList {
        padding-left: 0;
        list-style: none;
        counter-reset: adaceen-paso;
      }

      #guideList li {
        position: relative;
        padding-left: 32px;
        counter-increment: adaceen-paso;
      }

      #guideList li::before {
        content: counter(adaceen-paso);
        position: absolute;
        left: 0;
        top: 0.1em;
        width: 22px;
        height: 22px;
        display: grid;
        place-items: center;
        border-radius: 999px;
        background: var(--adaceen-primary-soft);
        color: var(--adaceen-primary-strong);
        font-family: var(--adaceen-mono);
        font-size: 0.8125rem;
        font-weight: 500;
        line-height: 1;
      }

`;
