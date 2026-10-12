// ADACEEN | Capa 4 - UI: estilos de la vista detallada de estudiante e historial pedagógico.
// Extraído de overlay/content-styles.js (líneas 3053-3302).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const OVERLAY_STUDENT_DETAIL_STYLES = `      /* ---- Detalle de un estudiante ---- */
      .student-detail-head {
        align-items: flex-start;
      }

      .student-detail-heading {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
      }

      .student-detail-heading h2 {
        margin: 0;
        font-size: 0.92rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .student-detail-heading .summary-meta {
        margin: 2px 0 0;
      }

      .student-timeline {
        display: grid;
        grid-template-columns: repeat(14, minmax(0, 1fr));
        gap: 3px;
        align-items: end;
        height: 52px;
        padding: 6px 8px;
        margin-bottom: 4px;
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius-control);
        background: #fff;
      }

      .student-timeline:empty {
        display: none;
      }

      .timeline-day {
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        gap: 1px;
        height: 100%;
        min-width: 0;
      }

      .timeline-bar {
        display: block;
        flex: 0 0 auto;
        width: 100%;
        min-height: 3px;
        border-radius: 2px 2px 0 0;
      }

      .timeline-bar.is-sessions {
        background: var(--adaceen-primary-line);
      }

      .timeline-bar.is-interventions {
        background: var(--adaceen-primary);
      }

      .timeline-bar.is-quizzes {
        background: var(--adaceen-accent);
      }

      .timeline-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin: 0 0 8px;
        color: var(--adaceen-muted);
        font-size: 0.75rem;
      }

      .timeline-legend[hidden] {
        display: none !important;
      }

      .timeline-legend span::before {
        content: "";
        display: inline-block;
        width: 8px;
        height: 8px;
        margin-right: 4px;
        border-radius: 2px;
        background: var(--adaceen-border-strong);
        vertical-align: middle;
      }

      .timeline-legend .is-sessions::before {
        background: var(--adaceen-primary-line);
      }

      .timeline-legend .is-interventions::before {
        background: var(--adaceen-primary);
      }

      .timeline-legend .is-quizzes::before {
        background: var(--adaceen-accent);
      }

      .student-detail-columns {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }

      .student-detail-block {
        min-width: 0;
        padding: 7px 10px;
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius-control);
        background: #fff;
      }

      .student-detail-block h3 {
        margin: 0 0 6px;
        color: var(--adaceen-primary-strong);
        font-size: 0.75rem;
        font-weight: 600;
        letter-spacing: 0;
        font-family: var(--adaceen-mono);
        text-transform: lowercase;
      }

      .student-detail-list {
        max-height: 124px;
        overflow: auto;
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .student-detail-list li {
        padding: 6px 0;
        border: 0;
        border-bottom: 1px solid var(--adaceen-border);
        border-radius: 0;
        background: transparent;
        font-size: 0.8125rem;
        line-height: 1.35;
      }

      .student-detail-list li:last-child {
        border-bottom: 0;
      }

      .item-title {
        display: block;
        color: var(--adaceen-ink);
        font-weight: 600;
      }

      .item-meta {
        display: block;
        color: var(--adaceen-muted);
        font-size: 0.75rem;
      }

      .quiz-result {
        font-weight: 600;
      }

      .quiz-result.is-ok {
        color: var(--adaceen-success);
      }

      .quiz-result.is-wrong {
        color: var(--adaceen-danger);
      }

      .quiz-result.is-pending {
        color: var(--adaceen-muted);
      }

      @media (max-width: 640px) {
        .student-detail-columns {
          grid-template-columns: 1fr;
        }

        .tab-button {
          font-size: 0.75rem;
          padding: 6px 6px;
        }

        .students-search {
          min-width: 0;
          width: 100%;
        }
      }

      @media (max-width: 640px) {
        :host {
          right: 12px;
          left: 12px;
          bottom: 12px;
        }

        .shell {
          width: 100%;
        }

        .shell.is-minimized {
          width: min(244px, 100%);
        }

        .shell.shell-expanded {
          width: 100%;
        }

        .goal-grid {
          grid-template-columns: 1fr;
        }

        .context-hub-head,
        .next-action {
          display: grid;
        }

        .connection-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .context-actions {
          width: 100%;
          flex-basis: auto;
        }

        .replacement-item {
          grid-template-columns: 1fr;
        }

        .sync-detail-grid {
          grid-template-columns: 1fr;
        }

        .button-row.split,
        .segmented {
          grid-template-columns: 1fr;
        }

        .analysis-window {
          inset: 54px 10px 10px;
        }
      }

`;
