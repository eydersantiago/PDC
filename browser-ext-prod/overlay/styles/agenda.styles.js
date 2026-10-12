// ADACEEN | Capa 4 - UI: estilos de la agenda del curso (0.7.17): la pestaña «Agenda» del estudiante,
// su línea en Inicio (usa .bitacora-home-line), «Inicio del semestre» y la semana de hoy en la
// pestaña «Bitácora» del docente.
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const OVERLAY_AGENDA_STYLES = `      /* Agenda del curso (0.7.17) */
      .agenda-section .section-title-row {
        align-items: flex-start;
      }

      .agenda-section .section-title-row > div:first-child {
        min-width: 0;
      }

      .agenda-section .section-title-row .summary-actions {
        flex: 0 0 auto;
        flex-wrap: nowrap;
      }

      .agenda-week-card {
        display: grid;
        gap: 4px;
        margin-bottom: 10px;
        padding: 10px 12px;
        border: 1px solid var(--adaceen-primary-line);
        border-radius: var(--adaceen-radius-control);
        background: var(--adaceen-soft);
      }

      .agenda-week-card[hidden] {
        display: none;
      }

      .agenda-week-card .eyebrow {
        margin-bottom: 0;
      }

      .agenda-week-topic {
        color: var(--adaceen-ink);
        font-size: 0.9375rem;
        line-height: 1.3;
      }

      .agenda-week-activities {
        display: grid;
        gap: 2px;
        margin: 2px 0 0;
        padding-left: 18px;
        color: var(--adaceen-body);
        font-size: 0.8125rem;
        line-height: 1.35;
      }

      .agenda-columns {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 10px;
      }

      .agenda-block {
        min-width: 0;
        padding: 10px 12px;
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius-control);
        background: #fff;
      }

      .agenda-block[hidden] {
        display: none;
      }

      .agenda-block h3 {
        margin: 0 0 6px;
        font-size: 0.875rem;
      }

      .agenda-upcoming-list,
      .agenda-suggestion-list,
      .agenda-weeks-list {
        display: grid;
        gap: 6px;
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .agenda-upcoming-item {
        display: grid;
        grid-template-columns: 78px minmax(0, 1fr);
        column-gap: 8px;
        row-gap: 1px;
        padding: 6px 8px;
        border-radius: var(--adaceen-radius-control);
        background: var(--adaceen-panel-soft);
        box-shadow: none;
      }

      .agenda-upcoming-item.is-parcial {
        box-shadow: none;
      }

      .agenda-upcoming-item.is-proyecto {
        box-shadow: none;
      }

      .agenda-upcoming-item.is-quiz {
        box-shadow: none;
      }

      .agenda-upcoming-date {
        grid-row: span 2;
        align-self: center;
        color: var(--adaceen-primary-strong);
        font-size: 0.8125rem;
        font-weight: 600;
      }

      .agenda-upcoming-title {
        color: var(--adaceen-ink);
        font-size: 0.8125rem;
        line-height: 1.3;
        overflow-wrap: anywhere;
      }

      .agenda-upcoming-meta {
        color: var(--adaceen-muted);
        font-size: 0.75rem;
      }

      .agenda-empty {
        color: var(--adaceen-muted);
        font-size: 0.8125rem;
      }

      .agenda-calendar-actions {
        grid-template-columns: 1fr;
        margin-top: 8px;
      }

      .agenda-calendar-actions .primary-button,
      .agenda-calendar-actions .ghost-button {
        min-height: 34px;
        padding: 8px 10px;
        font-size: 0.8125rem;
      }

      .agenda-calendar-status {
        margin-top: 6px;
        font-size: 0.8125rem;
      }

      .agenda-suggestions {
        margin-top: 10px;
      }

      .agenda-suggestion label {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 6px 8px;
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius-control);
        cursor: pointer;
      }

      .agenda-suggestion input {
        margin-top: 2px;
      }

      .agenda-suggestion-text {
        display: grid;
        gap: 1px;
        font-size: 0.8125rem;
      }

      .agenda-suggestion-text span {
        color: var(--adaceen-muted);
      }

      .agenda-suggestion.is-added label {
        border-color: var(--adaceen-success-line);
        background: var(--adaceen-success-soft);
      }

      .agenda-suggestion-add {
        width: auto;
        margin-top: 8px;
        min-height: 34px;
        padding: 8px 12px;
        font-size: 0.8125rem;
      }

      .agenda-suggestion-add[hidden] {
        display: none;
      }

      .agenda-weeks-list {
        max-height: 260px;
        margin-top: 10px;
        overflow: auto;
      }

      .agenda-week-row {
        display: grid;
        gap: 2px;
        padding: 6px 8px;
        border-radius: var(--adaceen-radius-control);
        background: var(--adaceen-panel-soft);
        font-size: 0.8125rem;
      }

      .agenda-week-row.is-current {
        border: 1px solid var(--adaceen-primary-line);
        background: var(--adaceen-primary-soft);
      }

      .agenda-week-row.is-extra {
        opacity: 0.8;
      }

      .agenda-week-row-head {
        color: var(--adaceen-primary-strong);
        font-weight: 600;
      }

      .agenda-week-row-topic {
        color: var(--adaceen-body);
        line-height: 1.35;
      }

      .agenda-week-row-tag {
        justify-self: start;
        padding: 1px 7px;
        border-radius: 999px;
        background: var(--adaceen-accent-soft);
        color: var(--adaceen-accent-strong);
        font-size: 0.75rem;
        font-weight: 600;
      }

      .agenda-week-row-tag.is-parcial {
        background: var(--adaceen-danger-soft);
        color: var(--adaceen-danger);
      }

      /* La semana en el Tutor, bajo «Hoy quiero reforzar». */
      .tutor-week-line {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        min-height: 36px;
        margin: -2px 0 10px;
        padding: 6px 10px;
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius-control);
        background: #fff;
        color: var(--adaceen-ink);
        font: inherit;
        font-size: 0.8125rem;
        text-align: left;
        cursor: pointer;
      }

      .tutor-week-line[hidden] {
        display: none;
      }

      .tutor-week-line:hover,
      .tutor-week-line:focus-visible {
        border-color: var(--adaceen-border-strong);
        background: var(--adaceen-soft);
      }

      .tutor-week-line .state-chip {
        flex: 0 0 auto;
      }

      .tutor-week-text {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* «Inicio del semestre» en la pestaña «Bitácora» del docente. */
      .bitacora-start-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px 10px;
        margin-top: 10px;
        padding: 8px 10px;
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius-control);
        background: #fff;
      }

      .bitacora-start-row label {
        color: var(--adaceen-body);
        font-size: 0.8125rem;
        font-weight: 600;
      }

      .bitacora-start-row input[type="date"] {
        border: 1px solid var(--adaceen-control-border);
        border-radius: var(--adaceen-radius-control);
        padding: 6px 8px;
        color: var(--adaceen-ink);
        font: inherit;
        font-size: 0.875rem;
      }

      .bitacora-start-row .ghost-button {
        width: auto;
        min-height: 32px;
        padding: 6px 10px;
        font-size: 0.8125rem;
      }

      .bitacora-start-note {
        flex: 1 1 100%;
        color: var(--adaceen-muted);
        font-size: 0.75rem;
      }

      .compact-list.bitacora-week-list li.is-current {
        border-color: var(--adaceen-primary-line);
        background: var(--adaceen-primary-soft);
      }

      @media (max-width: 640px) {
        .agenda-columns {
          grid-template-columns: 1fr;
        }
      }

      /* «Tema de la clase» del estudiante en Inicio (0.7.21; dirección B en 0.7.22): un bloque plano
         con su título, la semana en monoespaciada, el tema y el ejercicio como pares clave y valor. */
      .pilot-topic-home {
        display: grid;
        gap: 12px;
        margin: 0 0 18px;
        padding: 16px 0 0;
        border: 0;
        border-top: 1px solid var(--adaceen-border);
        border-radius: 0;
        background: transparent;
        box-shadow: none;
      }

      .pilot-topic-home[hidden],
      .pilot-topic-home button[hidden],
      .pilot-topic-home [hidden] {
        display: none !important;
      }

      .pilot-topic-home-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        min-width: 0;
      }

      .pilot-topic-home-head h2 {
        margin: 0;
        font-size: 1rem;
      }

      .pilot-topic-home-week {
        flex: none;
        color: var(--adaceen-muted);
        font-family: var(--adaceen-mono);
        font-size: 0.8125rem;
        text-transform: lowercase;
      }

      .pilot-topic-home-week:empty {
        display: none;
      }

      .pilot-topic-home button {
        width: 100%;
      }

`;
