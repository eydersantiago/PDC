// ADACEEN | Capa 4 - UI: dirección B en «Usuarios» y «Estudiantes» (barra, tabla, selección, solicitudes de
// acceso) y el campo «Docente» del administrador. Movido sin cambios de theme-b.styles.js.
"use strict";

const OVERLAY_THEME_B_USERS_STYLES = `      /* ---- Usuarios: barra con título, conteo, búsqueda y acciones ---- */
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

`;
