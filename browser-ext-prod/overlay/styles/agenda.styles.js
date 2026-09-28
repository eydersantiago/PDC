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
        border: 1px solid #b9dfe1;
        border-radius: 8px;
        background: linear-gradient(180deg, #f1fbfb 0%, #ffffff 100%);
      }

      .agenda-week-card[hidden] {
        display: none;
      }

      .agenda-week-card .eyebrow {
        margin-bottom: 0;
      }

      .agenda-week-topic {
        color: var(--adaceen-ink);
        font-size: 0.86rem;
        line-height: 1.3;
      }

      .agenda-week-activities {
        display: grid;
        gap: 2px;
        margin: 2px 0 0;
        padding-left: 18px;
        color: #3e5362;
        font-size: 0.72rem;
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
        border-radius: 8px;
        background: #fff;
      }

      .agenda-block[hidden] {
        display: none;
      }

      .agenda-block h3 {
        margin: 0 0 6px;
        font-size: 0.78rem;
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
        border-radius: 8px;
        background: var(--adaceen-panel-soft);
        box-shadow: inset 3px 0 0 var(--adaceen-border-strong);
      }

      .agenda-upcoming-item.is-parcial {
        box-shadow: inset 3px 0 0 var(--adaceen-danger);
      }

      .agenda-upcoming-item.is-proyecto {
        box-shadow: inset 3px 0 0 var(--adaceen-accent);
      }

      .agenda-upcoming-item.is-quiz {
        box-shadow: inset 3px 0 0 #d99a1e;
      }

      .agenda-upcoming-date {
        grid-row: span 2;
        align-self: center;
        color: var(--adaceen-primary-strong);
        font-size: 0.72rem;
        font-weight: 800;
      }

      .agenda-upcoming-title {
        color: var(--adaceen-ink);
        font-size: 0.74rem;
        line-height: 1.3;
        overflow-wrap: anywhere;
      }

      .agenda-upcoming-meta {
        color: var(--adaceen-muted);
        font-size: 0.66rem;
      }

      .agenda-empty {
        color: var(--adaceen-muted);
        font-size: 0.72rem;
      }

      .agenda-calendar-actions {
        grid-template-columns: 1fr;
        margin-top: 8px;
      }

      .agenda-calendar-actions .primary-button,
      .agenda-calendar-actions .ghost-button {
        min-height: 34px;
        padding: 8px 10px;
        font-size: 0.74rem;
      }

      .agenda-calendar-status {
        margin-top: 6px;
        font-size: 0.72rem;
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
        border-radius: 8px;
        cursor: pointer;
      }

      .agenda-suggestion input {
        margin-top: 2px;
      }

      .agenda-suggestion-text {
        display: grid;
        gap: 1px;
        font-size: 0.72rem;
      }

      .agenda-suggestion-text span {
        color: var(--adaceen-muted);
      }

      .agenda-suggestion.is-added label {
        border-color: #bfe3cd;
        background: #f3fbf6;
      }

      .agenda-suggestion-add {
        width: auto;
        margin-top: 8px;
        min-height: 34px;
        padding: 8px 12px;
        font-size: 0.74rem;
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
        border-radius: 8px;
        background: var(--adaceen-panel-soft);
        font-size: 0.72rem;
      }

      .agenda-week-row.is-current {
        border: 1px solid #a6d7d9;
        background: var(--adaceen-primary-soft);
      }

      .agenda-week-row.is-extra {
        opacity: 0.8;
      }

      .agenda-week-row-head {
        color: var(--adaceen-primary-strong);
        font-weight: 800;
      }

      .agenda-week-row-topic {
        color: #3e5362;
        line-height: 1.35;
      }

      .agenda-week-row-tag {
        justify-self: start;
        padding: 1px 7px;
        border-radius: 999px;
        background: var(--adaceen-accent-soft);
        color: var(--adaceen-accent-strong);
        font-size: 0.64rem;
        font-weight: 800;
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
        margin: -2px 0 10px;
        padding: 6px 10px;
        border: 1px solid #b9dfe1;
        border-radius: 8px;
        background: #f1fbfb;
        color: var(--adaceen-ink);
        font: inherit;
        font-size: 0.74rem;
        text-align: left;
        cursor: pointer;
      }

      .tutor-week-line[hidden] {
        display: none;
      }

      .tutor-week-line:hover,
      .tutor-week-line:focus-visible {
        border-color: var(--adaceen-border-strong);
        background: var(--adaceen-primary-soft);
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
        border-radius: 8px;
        background: #fff;
      }

      .bitacora-start-row label {
        color: #475569;
        font-size: 0.73rem;
        font-weight: 800;
      }

      .bitacora-start-row input[type="date"] {
        border: 1px solid var(--adaceen-control-border);
        border-radius: 8px;
        padding: 6px 8px;
        color: var(--adaceen-ink);
        font: inherit;
        font-size: 0.76rem;
      }

      .bitacora-start-row .ghost-button {
        width: auto;
        min-height: 32px;
        padding: 6px 10px;
        font-size: 0.72rem;
      }

      .bitacora-start-note {
        flex: 1 1 100%;
        color: var(--adaceen-muted);
        font-size: 0.68rem;
      }

      .compact-list.bitacora-week-list li.is-current {
        border-color: #a6d7d9;
        background: var(--adaceen-primary-soft);
      }

      @media (max-width: 640px) {
        .agenda-columns {
          grid-template-columns: 1fr;
        }
      }

`;
