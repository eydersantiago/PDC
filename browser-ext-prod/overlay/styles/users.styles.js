// ADACEEN | Capa 4 - UI: estilos de la pestaña Usuarios y administración de roles.
// Extraído de overlay/content-styles.js (líneas 2870-3052).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const OVERLAY_USERS_STYLES = `      /* Filas de usuarios (0.7.14): texto completo, etiquetas y edicion por fila. */
      .admin-users-table th {
        position: sticky;
        top: 0;
        z-index: 1;
      }

      /* Siete columnas en el panel ancho: un poco menos de aire a los lados que las demas tablas,
         para que «Acciones» quepa sin desplazar. */
      .admin-users-table th,
      .admin-users-table td {
        padding-left: 10px;
        padding-right: 10px;
      }

      .admin-users-table th:first-child,
      .admin-users-table td:first-child {
        padding-left: 12px;
      }

      .admin-users-table th:last-child,
      .admin-users-table td:last-child {
        padding-right: 12px;
      }

      .admin-identity-cell {
        min-width: 200px;
      }

      .admin-user-name {
        display: block;
        color: var(--adaceen-ink);
        font-weight: 800;
        line-height: 1.3;
        overflow-wrap: anywhere;
      }

      .admin-user-email {
        display: block;
        color: var(--adaceen-muted);
        font-size: 0.66rem;
        line-height: 1.3;
        overflow-wrap: anywhere;
      }

      .admin-teacher-cell {
        min-width: 96px;
        overflow-wrap: anywhere;
      }

      /* Docente: todos sus estudiantes son suyos, la columna «Profesor» sobra (0.7.15). */
      .admin-users-table.is-teacher-mode th:nth-child(3),
      .admin-users-table.is-teacher-mode td.admin-teacher-cell {
        display: none;
      }

      .admin-users-table.is-teacher-mode .admin-identity-cell {
        min-width: 170px;
      }

      .admin-chip-row {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }

      .admin-chip {
        display: inline-flex;
        align-items: center;
        padding: 2px 7px;
        border: 1px solid var(--adaceen-border);
        border-radius: 999px;
        background: var(--adaceen-soft);
        color: #42566c;
        font-size: 0.64rem;
        font-weight: 800;
        line-height: 1.3;
        white-space: nowrap;
      }

      .admin-chip.is-teacher {
        background: #edf2ff;
        border-color: #c7d2fe;
        color: #33418f;
      }

      .admin-chip.is-course {
        background: var(--adaceen-primary-soft);
        border-color: #b9dfe1;
        color: var(--adaceen-primary-strong);
      }

      .admin-chip.is-active {
        background: #e8f6ee;
        border-color: #bfe3cd;
        color: #1f7a4d;
      }

      .admin-chip.is-inactive {
        background: var(--adaceen-danger-soft);
        border-color: #f2c4bf;
        color: var(--adaceen-danger);
      }

      .admin-user-row.is-inactive .admin-user-name {
        color: var(--adaceen-muted);
      }

      .admin-user-row.is-editing td {
        background: var(--adaceen-primary-soft);
        border-bottom-color: transparent;
      }

      .admin-edit-row td {
        background: var(--adaceen-panel-soft);
        padding: 10px 12px 12px;
      }

      .admin-edit-form {
        display: grid;
        gap: 8px;
      }

      .admin-edit-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }

      .admin-edit-field {
        display: grid;
        gap: 4px;
        min-width: 0;
        color: #475569;
        font-size: 0.66rem;
        font-weight: 800;
        letter-spacing: 0.03em;
        text-transform: uppercase;
      }

      .admin-edit-field input,
      .admin-edit-field select {
        width: 100%;
        min-height: 34px;
        padding: 7px 9px;
        border: 1px solid var(--adaceen-control-border);
        border-radius: 8px;
        background: #fff;
        color: var(--adaceen-ink);
        font: inherit;
        font-size: 0.74rem;
        letter-spacing: 0;
        text-transform: none;
      }

      .admin-edit-field input:focus,
      .admin-edit-field select:focus {
        outline: none;
        border-color: var(--adaceen-primary);
        box-shadow: 0 0 0 3px rgba(0, 109, 119, 0.1);
      }

      .admin-edit-field .course-chip-grid {
        text-transform: none;
        letter-spacing: 0;
      }

      .admin-edit-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }

      .admin-edit-actions .ghost-button,
      .admin-edit-actions .save-button {
        width: auto;
        min-height: 34px;
        padding: 7px 14px;
      }

      .students-telemetry {
        margin-top: 10px;
      }

      .students-telemetry summary {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        cursor: pointer;
        color: var(--adaceen-primary-strong);
        font-size: 0.74rem;
        font-weight: 800;
      }

      .students-telemetry .telemetry-list {
        max-height: 180px;
        overflow: auto;
        margin-top: 8px;
      }

      /* «Docente de las cuentas nuevas» e «Importar lista» (0.7.21, piloto con FPOO-01). */
      .admin-default-teacher {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        align-items: center;
        gap: 6px 10px;
        margin: 0 0 12px;
        padding: 10px 12px;
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius);
        background: var(--adaceen-panel-soft);
      }

      .admin-default-teacher[hidden],
      .admin-import-panel[hidden],
      .admin-import-teachers[hidden],
      .admin-import-result[hidden],
      .admin-import-panel .check-row[hidden] {
        display: none !important;
      }

      .admin-default-teacher .field-hint {
        grid-column: 1 / -1;
        margin: 0;
        color: var(--adaceen-muted);
        font-size: 0.72rem;
        line-height: 1.35;
      }

      .admin-import-panel {
        margin: 0 0 12px;
        padding: 12px;
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius);
        background: var(--adaceen-panel);
      }

      .admin-default-teacher label {
        color: #475569;
        font-size: 0.74rem;
        font-weight: 800;
      }

      .admin-default-teacher select {
        width: 100%;
        min-width: 0;
      }

      .admin-import-source {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 8px;
      }

      .admin-import-source .ghost-button {
        flex: 0 0 auto;
        width: auto;
        padding: 0 14px;
      }

      .admin-import-file {
        min-width: 0;
        overflow: hidden;
        color: var(--adaceen-muted);
        font-size: 0.74rem;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .admin-import-panel textarea {
        width: 100%;
        min-height: 64px;
        resize: vertical;
        font: inherit;
        font-size: 0.76rem;
      }

      .admin-import-summary.is-warning {
        color: var(--adaceen-danger);
      }

      .admin-import-teacher {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 0.76rem;
      }

      .admin-import-panel .check-row {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        color: var(--adaceen-ink);
        font-size: 0.76rem;
        line-height: 1.35;
      }

      .admin-import-result li {
        font-size: 0.76rem;
        line-height: 1.4;
      }

`;
