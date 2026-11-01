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

`;
