// ADACEEN | Capa 4 - UI: estilos de la pestaña Quices del docente y tarjetas de preguntas/resultados.
// Extraído de overlay/content-styles.js (líneas 3661-3819).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const OVERLAY_QUIZZES_STYLES = `      /* Pestana «Quices» (0.7.15) */
      .quiz-launch-field {
        margin-bottom: 8px;
      }

      .quizzes-columns {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
        gap: 10px;
      }

      .quizzes-block h3 {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 0 0 2px;
        font-size: 0.8rem;
      }

      .quiz-bank-list {
        display: grid;
        gap: 6px;
        max-height: 250px;
        margin: 6px 0 0;
        padding: 0;
        overflow: auto;
        list-style: none;
      }

      .quiz-bank-item {
        padding: 7px 9px;
        border: 1px solid var(--adaceen-border);
        border-radius: 8px;
        background: var(--adaceen-panel-soft);
      }

      .quiz-bank-item.is-live {
        border-color: #bfe3cd;
        box-shadow: inset 3px 0 0 #1f7a4d;
      }

      .quiz-bank-head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 5px;
      }

      .quiz-bank-topic {
        flex: 1 1 auto;
        min-width: 0;
        color: var(--adaceen-ink);
        font-size: 0.72rem;
        font-weight: 800;
      }

      .quiz-bank-question {
        margin: 3px 0 0;
        color: var(--adaceen-ink);
        font-size: 0.66rem;
        line-height: 1.35;
      }

      .quiz-bank-meta {
        margin: 3px 0 0;
        color: var(--adaceen-muted);
        font-size: 0.6rem;
      }

      .quiz-bank-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        margin-top: 5px;
      }

      .quiz-bank-actions .primary-button {
        width: auto;
      }

      .quiz-attempts-wrap {
        max-height: 250px;
        margin-top: 6px;
        overflow: auto;
        border: 1px solid var(--adaceen-border);
        border-radius: 10px;
        background: #fff;
      }

      .quiz-attempts-table {
        min-width: 0;
        table-layout: fixed;
      }

      .quiz-attempts-table th,
      .quiz-attempts-table td {
        padding: 8px 10px;
        vertical-align: top;
        overflow-wrap: anywhere;
      }

      .quiz-attempts-table th {
        position: sticky;
        top: 0;
        z-index: 1;
      }

      .quiz-attempts-table th:nth-child(1) { width: 36%; }
      .quiz-attempts-table th:nth-child(2) { width: 26%; }
      .quiz-attempts-table th:nth-child(3) { width: 22%; }
      .quiz-attempts-table th:nth-child(4) { width: 16%; }

      .quiz-attempts-table .admin-user-email {
        font-size: 0.6rem;
      }

      .quiz-attempts-table .quiz-result {
        white-space: normal;
        line-height: 1.25;
      }

      /* Sigue siendo una celda de tabla (antes display: grid cortaba las lineas de la fila). */
      .quiz-attempt-topic > span {
        display: block;
      }

      .quiz-attempt-origin {
        margin-top: 2px;
        color: var(--adaceen-muted);
        font-size: 0.6rem;
      }

      .quiz-attempt-date {
        color: var(--adaceen-muted);
        font-size: 0.62rem;
      }

      .quiz-launch-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto auto;
        gap: 6px;
        align-items: center;
      }

      .quiz-launch-row .save-button,
      .quiz-launch-row .ghost-button {
        width: auto;
        white-space: nowrap;
      }

      .quiz-result.is-correct {
        background: #e8f6ee;
        border-color: #bfe3cd;
        color: #1f7a4d;
      }

      .quiz-result.is-wrong {
        background: var(--adaceen-danger-soft);
        border-color: #f2c4bf;
        color: var(--adaceen-danger);
      }

      .quiz-result.is-pending,
      .quiz-result.is-skipped {
        background: var(--adaceen-soft);
        color: #42566c;
      }

`;
