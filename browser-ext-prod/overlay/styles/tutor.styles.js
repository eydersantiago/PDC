// ADACEEN | Capa 4 - UI: estilos de la pestaña Tutor, bitácora pedagógica, metas y telemetría.
// Extraído de overlay/content-styles.js (líneas 1003-1816).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const OVERLAY_TUTOR_STYLES = `      .summary-title {
        color: var(--adaceen-ink);
        font-size: 1rem;
        font-weight: 600;
        line-height: 1.3;
        margin-bottom: 4px;
      }

      /* Texto secundario bajo un título: frases, en la letra del texto (los datos van en monoespaciada). */
      .summary-meta {
        color: var(--adaceen-muted);
        font-size: 0.875rem;
        line-height: 1.5;
        margin-bottom: 8px;
      }

      .signal {
        color: var(--adaceen-body);
        font-size: 0.9375rem;
      }

      /* Parámetros del tutor que fijó el docente: una línea en monoespaciada. */
      .teacher-summary {
        color: var(--adaceen-muted);
        font-family: var(--adaceen-mono);
        font-size: 0.8125rem;
        line-height: 1.6;
      }

      /* El aviso del Tutor bloqueado es una frase, no datos: va en la letra del texto. */
      .tutor-locked-notice .teacher-summary {
        color: var(--adaceen-body);
        font-family: var(--adaceen-sans);
        font-size: 0.9375rem;
        line-height: 1.5;
      }

      .policy-lead {
        margin-top: 8px;
        color: var(--adaceen-body);
        font-size: 0.9375rem;
      }

      .teacher-only[hidden],
      .settings-role-block[hidden] {
        display: none;
      }

      .compact-list,
      .telemetry-list {
        list-style: none;
        padding-left: 0 !important;
      }

      .compact-list li,
      .telemetry-list li {
        padding: 8px 10px;
        border-radius: var(--adaceen-radius-control);
        border: 1px solid var(--adaceen-border);
        background: var(--adaceen-panel-soft);
      }

      .bitacora-week-list {
        display: grid;
        gap: 8px;
        margin-top: 10px;
      }

      .compact-list.bitacora-week-list li {
        padding: 10px;
        border-radius: var(--adaceen-radius-control);
        background: var(--adaceen-panel-soft);
      }

      .bitacora-week-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        color: var(--adaceen-ink);
        font-size: 0.875rem;
      }

      .bitacora-week-head span {
        color: var(--adaceen-muted);
        white-space: nowrap;
      }

      .bitacora-topic {
        margin: 6px 0 8px;
        color: var(--adaceen-ink);
        font-size: 0.8125rem;
        font-weight: 700;
        line-height: 1.3;
      }

      .bitacora-week-lines {
        display: grid;
        gap: 6px;
      }

      .bitacora-line {
        display: grid;
        grid-template-columns: 74px minmax(0, 1fr);
        gap: 8px;
        align-items: start;
        font-size: 0.8125rem;
        line-height: 1.35;
      }

      .bitacora-line-label {
        border-radius: 999px;
        padding: 3px 7px;
        text-align: center;
        font-weight: 600;
        font-size: 0.75rem;
        font-family: var(--adaceen-mono);
        text-transform: lowercase;
        letter-spacing: 0;
      }

      .bitacora-line-class .bitacora-line-label {
        color: var(--adaceen-primary-strong);
        background: var(--adaceen-primary-soft);
      }

      .bitacora-line-evaluation .bitacora-line-label {
        color: var(--adaceen-accent-strong);
        background: var(--adaceen-accent-soft);
      }

      .bitacora-line-body {
        color: var(--adaceen-body);
        overflow-wrap: anywhere;
      }

      .bitacora-week-empty {
        color: #667482;
        font-size: 0.8125rem;
      }

      .rag-course-card {
        display: grid;
        gap: 12px;
      }

      .rag-course-active {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
      }

      .rag-course-active strong {
        display: block;
        color: var(--adaceen-ink);
        font-size: 1.02rem;
        line-height: 1.15;
        margin-top: 3px;
      }

      .rag-course-active p {
        margin: 3px 0 0;
        color: var(--adaceen-muted);
        font-size: 0.875rem;
        line-height: 1.32;
      }

      .rag-course-select-field {
        margin-top: 0;
      }

      .rag-course-summary {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .rag-course-stat {
        border: 1px solid #d7e2ea;
        border-radius: var(--adaceen-radius-control);
        background: var(--adaceen-soft);
        color: #405366;
        padding: 5px 8px;
        font-size: 0.75rem;
        font-weight: 600;
        line-height: 1.15;
      }

      .rag-course-stat.is-ok {
        border-color: var(--adaceen-primary-line);
        background: var(--adaceen-soft);
        color: var(--adaceen-primary-strong);
      }

      .rag-course-stat.is-warn {
        border-color: var(--adaceen-warning-line);
        background: var(--adaceen-warning-soft);
        color: #7a5718;
      }

      .rag-source-list {
        display: grid;
        gap: 8px;
        margin-top: 10px;
      }

      .rag-source-item {
        display: grid;
        gap: 7px;
      }

      .rag-source-head {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        align-items: flex-start;
      }

      .rag-source-title {
        color: var(--adaceen-ink);
        font-size: 0.875rem;
        font-weight: 600;
        line-height: 1.25;
      }

      .rag-source-meta {
        color: var(--adaceen-muted);
        font-size: 0.75rem;
        line-height: 1.3;
      }

      .rag-source-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
      }

      .rag-source-tag {
        border-radius: var(--adaceen-radius-control);
        padding: 3px 7px;
        background: var(--adaceen-primary-soft);
        color: var(--adaceen-primary-strong);
        font-size: 0.75rem;
        font-weight: 600;
        font-family: var(--adaceen-mono);
        text-transform: lowercase;
        letter-spacing: 0;
      }

      .rag-source-item .ghost-button {
        width: auto;
        padding: 7px 9px;
        font-size: 0.75rem;
      }

      .sync-panel {
        display: grid;
        gap: 12px;
      }

      .vscode-sync-bottom {
        border-color: var(--adaceen-primary-line);
        background: var(--adaceen-soft);
      }

      .vscode-sync-overlay {
        position: fixed;
        left: 24px;
        top: 96px;
        z-index: 2147483645;
        width: min(520px, calc(100vw - 24px));
        max-height: min(72vh, 640px);
        margin-bottom: 0;
        overflow: auto;
        box-shadow: var(--adaceen-shadow);
        pointer-events: auto;
        transform: translate3d(0, 0, 0);
      }

      .vscode-sync-overlay[hidden] {
        display: none !important;
      }

      .vscode-sync-overlay.is-dragging {
        user-select: none;
      }

      .vscode-sync-drag-handle {
        cursor: grab;
        touch-action: none;
        user-select: none;
      }

      .vscode-sync-drag-handle:active,
      .vscode-sync-overlay.is-dragging .vscode-sync-drag-handle {
        cursor: grabbing;
      }

      .vscode-sync-drag-handle .summary-actions {
        cursor: default;
        touch-action: auto;
      }

      .sync-status-row strong {
        display: block;
        color: var(--adaceen-ink);
        font-size: 0.875rem;
        line-height: 1.25;
        margin-bottom: 4px;
      }

      .sync-status-row p {
        color: var(--adaceen-muted);
        font-size: 0.8125rem;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }

      .sync-detail-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 12px;
        align-items: start;
      }

      .sync-detail-block {
        min-width: 0;
        display: grid;
        gap: 6px;
        padding-top: 10px;
        border-top: 1px solid var(--adaceen-border);
      }

      .sync-detail-block .eyebrow {
        margin-bottom: 0;
      }

      .sync-detail-block > strong {
        color: var(--adaceen-ink);
        font-size: 0.875rem;
        line-height: 1.25;
        overflow-wrap: anywhere;
      }

      .sync-detail-block > p {
        color: var(--adaceen-body);
        font-size: 0.8125rem;
        line-height: 1.42;
        overflow-wrap: anywhere;
      }

      .sync-snippet {
        min-height: 96px;
        max-height: 170px;
        margin: 0;
        background: var(--adaceen-ink);
        border-color: var(--adaceen-ink);
        color: #e6f4f1;
      }

      .sync-snippet.is-loading {
        color: #bceee8;
      }

      .sync-snippet.is-loading::after,
      .policy-lead.is-loading-note::after,
      .admin-loading-cell.is-loading-note::after,
      .settings-note.is-loading-note::after {
        content: "";
        display: inline-block;
        width: 1.4em;
        text-align: left;
        animation: adaceen-loading-dots 1.2s steps(4, end) infinite;
      }

      @keyframes adaceen-loading-dots {
        0% { content: ""; }
        25% { content: "."; }
        50% { content: ".."; }
        75%, 100% { content: "..."; }
      }

      .replacement-list {
        display: grid;
        gap: 8px;
      }

      .replacement-item {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
        align-items: center;
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius-control);
        background: var(--adaceen-panel-soft);
        padding: 9px;
      }

      .replacement-item strong {
        display: block;
        color: var(--adaceen-ink);
        font-size: 0.875rem;
        line-height: 1.25;
      }

      .replacement-item-head {
        display: flex;
        gap: 7px;
        align-items: center;
        justify-content: space-between;
        min-width: 0;
      }

      .replacement-item-head strong {
        min-width: 0;
      }

      .replacement-mode {
        flex: 0 0 auto;
        border: 1px solid color-mix(in srgb, var(--adaceen-accent) 28%, var(--adaceen-border));
        border-radius: 999px;
        background: color-mix(in srgb, var(--adaceen-accent) 10%, #fff);
        color: color-mix(in srgb, var(--adaceen-accent) 78%, #1f2937);
        font-size: 0.75rem;
        font-weight: 600;
        line-height: 1;
        padding: 4px 6px;
        font-family: var(--adaceen-mono);
        text-transform: lowercase;
      }

      .replacement-item p {
        margin-top: 3px;
        color: var(--adaceen-muted);
        font-size: 0.8125rem;
        line-height: 1.35;
      }

      .replacement-item .save-button {
        width: auto;
        min-width: 78px;
        min-height: 32px;
        padding: 7px 10px;
        font-size: 0.8125rem;
      }

      .rag-citation-list {
        display: grid;
        gap: 8px;
      }

      .rag-citation-item {
        display: grid;
        gap: 5px;
      }

      .rag-citation-item strong {
        display: block;
        color: var(--adaceen-ink);
        font-size: 0.875rem;
        line-height: 1.25;
      }

      .rag-citation-item span,
      .rag-citation-item p,
      .rag-citation-item a {
        color: var(--adaceen-muted);
        font-size: 0.8125rem;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }

      .rag-citation-item a {
        color: var(--adaceen-primary-strong);
        font-weight: 600;
        text-decoration: none;
      }

      .course-picker {
        margin-top: 8px;
      }

      .course-chip-grid {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .course-chip {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius-control);
        padding: 5px 8px;
        background: #fff;
        color: var(--adaceen-ink);
        font-size: 0.75rem;
        font-weight: 600;
        cursor: pointer;
      }

      .course-chip input {
        width: 13px !important;
        height: 13px;
        margin: 0;
        padding: 0 !important;
      }

      .course-chip:has(input:checked) {
        border-color: var(--adaceen-primary);
        background: var(--adaceen-primary-soft);
        color: var(--adaceen-primary-strong);
      }

      /* 120px bastan para dos o tres cursos; el espacio que sobraba lo toman el correo y el lote. */
      .admin-course-cell {
        min-width: 120px;
      }

      .student-course-options {
        display: grid;
        gap: 8px;
        margin: 12px 0 6px;
      }

      .student-course-option {
        display: grid;
        gap: 3px;
        width: 100%;
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius-control);
        background: #fff;
        color: var(--adaceen-ink);
        cursor: pointer;
        padding: 10px;
        text-align: left;
      }

      .student-course-option strong {
        font-size: 0.875rem;
      }

      .student-course-option span {
        color: var(--adaceen-muted);
        font-size: 0.8125rem;
        line-height: 1.3;
      }

      .student-course-option.is-selected {
        border-color: var(--adaceen-primary);
        background: var(--adaceen-primary-soft);
        box-shadow: none;
      }

      .course-empty {
        color: var(--adaceen-muted);
        font-size: 0.875rem;
        line-height: 1.35;
      }

      .telemetry-list li strong {
        display: block;
        margin-bottom: 3px;
      }

      .telemetry-list li span {
        display: block;
        color: var(--adaceen-muted);
        font-size: 0.8125rem;
      }

      .goal-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }

      .goal-button {
        min-height: 44px;
        border: 1px solid var(--adaceen-control-border);
        border-radius: var(--adaceen-radius-control);
        background: #fff;
        color: var(--adaceen-ink);
        cursor: pointer;
        padding: 8px 10px;
        text-align: left;
        font-size: 0.9375rem;
        line-height: 1.3;
      }

      .goal-button:hover {
        background: var(--adaceen-soft);
      }

      .goal-button.is-selected {
        border: 2px solid var(--adaceen-primary);
        padding: 7px 9px;
        background: var(--adaceen-primary-soft);
        color: var(--adaceen-primary-strong);
        font-weight: 500;
      }

      .panel-section ul,
      .panel-section ol {
        margin: 0;
        padding-left: 18px;
        display: grid;
        gap: 8px;
        color: var(--adaceen-body);
        font-size: 0.9375rem;
        line-height: 1.55;
      }

      .admin-table-wrap {
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
