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

`;
