// ADACEEN | Capa 4 - UI: estilos de la pestaña Estudiantes (indicadores KPI y tabla de seguimiento).
// Extraído de overlay/content-styles.js (líneas 2308-2522).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const OVERLAY_STUDENTS_STYLES = `      /* ---- Indicadores (pestaña Estudiantes y detalle) ---- */
      .kpi-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
        gap: 8px;
        margin-bottom: 8px;
      }

      .student-detail-status[hidden] {
        display: none !important;
      }

      .kpi-grid:empty {
        display: none;
      }

      .kpi-tile {
        display: grid;
        gap: 2px;
        min-width: 0;
        padding: 8px 10px;
        border: 1px solid var(--adaceen-border);
        border-radius: 8px;
        background: #fff;
      }

      .kpi-tile.is-accent {
        background: var(--adaceen-primary-soft);
        border-color: #b9dfe1;
      }

      .kpi-tile.is-warning {
        background: var(--adaceen-warning-soft);
        border-color: #efdca6;
      }

      .kpi-label {
        color: var(--adaceen-muted);
        font-size: 0.6rem;
        font-weight: 800;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .kpi-value {
        color: var(--adaceen-ink);
        font-size: 1.02rem;
        font-weight: 850;
        line-height: 1.15;
      }

      .kpi-note {
        color: var(--adaceen-muted);
        font-size: 0.64rem;
        line-height: 1.3;
      }

      /* ---- Tabla de estudiantes ---- */
      .students-toolbar h2 {
        margin: 0;
      }

      .students-search {
        min-width: 232px;
        min-height: 32px;
        padding: 6px 9px;
        border: 1px solid var(--adaceen-control-border);
        border-radius: 8px;
        background: #fff;
        color: var(--adaceen-ink);
        font: inherit;
        font-size: 0.72rem;
        outline: none;
      }

      .students-search:focus {
        border-color: var(--adaceen-primary);
        box-shadow: 0 0 0 3px rgba(0, 109, 119, 0.1);
      }

      .students-table-wrap {
        max-height: 292px;
      }

      .students-table th,
      .students-table td {
        white-space: nowrap;
      }

      .students-table th {
        position: sticky;
        top: 0;
        z-index: 1;
      }

      .students-table td.student-cell {
        white-space: normal;
        min-width: 170px;
        max-width: 240px;
      }

      .students-table tbody tr {
        cursor: pointer;
      }

      .students-table tbody tr:hover td {
        background: var(--adaceen-panel-soft);
      }

      .students-table tbody tr.is-selected td {
        background: var(--adaceen-primary-soft);
      }

      .students-table tbody tr.is-inactive td {
        color: var(--adaceen-muted);
      }

      .student-name {
        display: flex;
        align-items: center;
        width: 100%;
        margin: 0;
        padding: 0;
        border: 0;
        background: transparent;
        color: var(--adaceen-ink);
        font: inherit;
        font-weight: 800;
        text-align: left;
        cursor: pointer;
      }

      .student-name:focus-visible {
        outline: 2px solid var(--adaceen-focus);
        outline-offset: 2px;
        border-radius: 4px;
      }

      .student-email {
        display: block;
        color: var(--adaceen-muted);
        font-size: 0.64rem;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .cell-note {
        display: block;
        color: var(--adaceen-muted);
        font-size: 0.62rem;
      }

      .online-dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        margin-right: 5px;
        border-radius: 50%;
        background: #1f7a4d;
        vertical-align: middle;
      }

      .online-dot.is-off {
        background: var(--adaceen-border-strong);
      }

      .grade-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 3px 7px;
        border: 1px solid transparent;
        border-radius: 999px;
        font-size: 0.66rem;
        font-weight: 850;
        line-height: 1.2;
      }

      .grade-chip.is-alto {
        background: var(--adaceen-primary-soft);
        border-color: #b9dfe1;
        color: var(--adaceen-primary-strong);
      }

      .grade-chip.is-medio {
        background: var(--adaceen-warning-soft);
        border-color: #efdca6;
        color: var(--adaceen-warning);
      }

      .grade-chip.is-bajo {
        background: var(--adaceen-danger-soft);
        border-color: #f2c4bf;
        color: var(--adaceen-danger);
      }

      .grade-chip.is-sin_datos {
        background: var(--adaceen-soft);
        border-color: var(--adaceen-border);
        color: var(--adaceen-muted);
      }

      /* El atributo hidden perdia contra display: grid de .field-stack: el formulario de
         «Agregar usuario» se veia siempre. */
      .admin-create-form[hidden] {
        display: none !important;
      }

      .users-table-wrap {
        max-height: 470px;
      }

`;
