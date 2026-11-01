// ADACEEN | Capa 4 - UI: tabla de administración, detalles, código, línea de estado, ventanas de confirmación
// y páginas del docente (RAG y bitácora). Movido sin cambios del final de tutor.styles.js.
"use strict";

const OVERLAY_TABLES_DIALOGS_STYLES = `      .admin-table-wrap {
        overflow: auto;
        border: 0;
        border-radius: 0;
        background: #fff;
      }

      /* separate (no collapse): con collapse, la cabecera fija (sticky) perdia su linea
         inferior al desplazar y se confundia con la primera fila. */
      .admin-table {
        width: 100%;
        min-width: 640px;
        border-collapse: separate;
        border-spacing: 0;
      }

      .admin-table th,
      .admin-table td {
        border-bottom: 1px solid var(--adaceen-table-line);
        padding: 10px 8px;
        text-align: left;
        vertical-align: middle;
        font-size: 0.9375rem;
        line-height: 1.4;
      }

      /* Sin divisiones de columna (dirección B): solo líneas entre filas. */
      .admin-table th + th,
      .admin-table td + td {
        border-left: 0;
      }

      .admin-table th:first-child,
      .admin-table td:first-child {
        padding-left: 0;
      }

      .admin-table th:last-child,
      .admin-table td:last-child {
        padding-right: 0;
      }

      .admin-table th {
        padding-top: 9px;
        padding-bottom: 9px;
        border-bottom-color: var(--adaceen-border-strong);
        font-family: var(--adaceen-mono);
        font-size: 0.9375rem;
        font-weight: 400;
        letter-spacing: 0;
        line-height: 1.3;
        text-transform: lowercase;
        color: var(--adaceen-muted);
        background: #fff;
      }

      /* La ultima fila no suma su linea al borde del contenedor (se veia doble). */
      .admin-table tbody tr:last-child > td {
        border-bottom: 0;
      }

      .admin-loading-cell,
      .admin-empty-cell {
        color: var(--adaceen-body);
        font-weight: 400;
        line-height: 1.45;
        padding: 14px 12px !important;
        text-align: center !important;
      }

      .admin-loading-cell {
        background: var(--adaceen-soft);
      }

      .admin-table td input,
      .admin-table td select {
        width: 100%;
        border: 1px solid var(--adaceen-control-border);
        border-radius: var(--adaceen-radius-control);
        padding: 8px;
        font-size: 0.9375rem;
        background: #fff;
      }

      /* Sigue siendo una celda de tabla (con display: flex sus lineas no coincidian con las de
         la fila); los botones van uno al lado del otro. */
      .admin-actions-cell {
        white-space: nowrap;
      }

      .admin-actions-cell > * + * {
        margin-left: 6px;
      }

      .admin-actions-cell .ghost-button,
      .admin-actions-cell .save-button {
        display: inline-flex;
        align-items: center;
        width: auto;
        min-height: 36px;
        padding: 6px 10px;
        font-size: 0.9375rem;
      }

      details summary {
        cursor: pointer;
        font-weight: 500;
        font-size: 0.9375rem;
        color: var(--adaceen-ink);
      }

      /* Código y fragmentos: fondo suave y monoespaciada, como el resto de los datos. */
      pre {
        margin: 10px 0 0;
        max-height: 160px;
        overflow: auto;
        border-radius: var(--adaceen-radius-control);
        background: var(--adaceen-soft);
        border: 0;
        color: var(--adaceen-ink);
        padding: 10px 12px;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: var(--adaceen-mono);
        font-size: 0.9375rem;
        line-height: 1.5;
      }

      .status {
        min-height: 18px;
        margin-top: 12px;
        color: var(--adaceen-muted);
        font-size: 0.9375rem;
        line-height: 1.45;
      }

      .status.is-warning {
        color: var(--adaceen-danger);
        font-weight: 500;
      }

      .confirmation-modal {
        position: absolute;
        inset: 0;
        z-index: 5;
        display: grid;
        place-items: center;
        padding: 14px;
        background: rgba(27, 29, 31, 0.45);
      }

      .confirmation-modal[hidden] {
        display: none;
      }

      .confirmation-dialog {
        width: min(372px, 100%);
        border: 1px solid var(--adaceen-border-strong);
        border-radius: var(--adaceen-radius);
        background: #fff;
        box-shadow: none;
        padding: 18px;
      }

      .confirmation-dialog h2 {
        margin: 6px 0 8px;
        font-size: 1.25rem;
        line-height: 1.25;
      }

      .dialog-line {
        color: var(--adaceen-muted);
        font-family: var(--adaceen-mono);
        font-size: 0.9375rem;
      }

      .teacher-rag-page {
        position: absolute;
        inset: 0;
        z-index: 9;
        display: flex;
        flex-direction: column;
        background: rgba(248, 250, 252, 0.99);
        backdrop-filter: blur(10px);
      }

      .teacher-rag-page[hidden] {
        display: none;
      }

      .bitacora-page-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        border-bottom: 1px solid var(--adaceen-border);
        background: #fff;
        padding: 16px;
      }

      .bitacora-page-head h2 {
        margin: 10px 0 4px;
        font-size: 1rem;
        line-height: 1.2;
      }

      .bitacora-page-head p {
        color: var(--adaceen-muted);
        font-size: 0.875rem;
        line-height: 1.35;
      }

      .bitacora-page-body {
        flex: 1 1 auto;
        overflow: auto;
        padding: 14px 16px 16px;
      }

      .bitacora-manual-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }

      .bitacora-manual-full {
        grid-column: 1 / -1;
      }

      @media (max-width: 520px) {
        .bitacora-manual-grid {
          grid-template-columns: 1fr;
        }

        .bitacora-manual-full {
          grid-column: auto;
        }
      }

      .course-modal .confirmation-dialog {
        width: min(360px, 100%);
        border-color: var(--adaceen-primary-line);
        background: #fff;
      }

      .conflict-modal .confirmation-dialog {
        border-color: var(--adaceen-danger-line);
        background: #fff;
      }

`;
