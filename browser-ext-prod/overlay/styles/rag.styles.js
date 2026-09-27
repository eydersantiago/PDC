// ADACEEN | Capa 4 - UI: estilos de la pestaña RAG por curso, listado de fuentes y citas compactas.
// Extraído de overlay/content-styles.js (líneas 2523-2869).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const OVERLAY_RAG_STYLES = `      /* Pestana RAG por curso (0.7.14). */
      .rag-courses-head h2 {
        margin: 0 0 2px;
      }

      .rag-courses-head .summary-meta {
        margin: 0;
      }

      .rag-course-groups {
        display: grid;
        gap: 8px;
        max-height: 456px;
        overflow: auto;
        padding-right: 2px;
      }

      .rag-course-group {
        border: 1px solid var(--adaceen-border);
        border-radius: 8px;
        background: #fff;
      }

      .rag-course-group > summary {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 9px 12px;
        list-style: none;
        cursor: pointer;
        font-size: 0.76rem;
        font-weight: 800;
        color: var(--adaceen-ink);
      }

      .rag-course-group > summary::-webkit-details-marker {
        display: none;
      }

      .rag-course-group > summary::before {
        content: "";
        flex: 0 0 auto;
        width: 0;
        height: 0;
        border-top: 5px solid transparent;
        border-bottom: 5px solid transparent;
        border-left: 6px solid var(--adaceen-primary-strong);
        transition: transform 120ms ease;
      }

      .rag-course-group[open] > summary::before {
        transform: rotate(90deg);
      }

      .rag-course-group[open] > summary {
        border-bottom: 1px solid var(--adaceen-border);
      }

      .rag-course-code {
        flex: 0 0 auto;
        padding: 2px 8px;
        border: 1px solid #b9dfe1;
        border-radius: 7px;
        background: var(--adaceen-primary-soft);
        color: var(--adaceen-primary-strong);
        font-size: 0.64rem;
        letter-spacing: 0.04em;
      }

      .rag-course-name {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .rag-course-counts {
        flex: 0 0 auto;
        color: var(--adaceen-muted);
        font-size: 0.66rem;
        font-weight: 700;
        white-space: nowrap;
      }

      .rag-course-counts.is-empty {
        color: var(--adaceen-warning);
      }

      .rag-course-body {
        display: grid;
        gap: 8px;
        padding: 10px 12px 12px;
      }

      .rag-course-toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }

      .rag-course-toolbar .primary-button {
        width: auto;
      }

      .rag-course-hint {
        flex: 1 1 160px;
        color: var(--adaceen-muted);
        font-size: 0.64rem;
        line-height: 1.3;
      }

      .rag-source-link {
        display: inline-flex;
        align-items: center;
        text-decoration: none;
      }

      .rag-course-sources {
        display: grid;
        gap: 6px;
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .rag-course-source {
        padding: 7px 9px;
        border: 1px solid var(--adaceen-border);
        border-radius: 8px;
        background: var(--adaceen-panel-soft);
      }

      .rag-course-source.is-teacher {
        border-color: #b9dfe1;
        background: #f6fcfc;
      }

      .rag-course-source.is-empty {
        color: var(--adaceen-muted);
        font-size: 0.7rem;
      }

      .rag-course-source-head {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .rag-course-source-titles {
        flex: 1 1 auto;
        min-width: 0;
        display: grid;
        gap: 2px;
      }

      .rag-course-source-title {
        color: var(--adaceen-ink);
        font-size: 0.72rem;
        font-weight: 800;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .rag-course-source-meta {
        color: var(--adaceen-muted);
        font-size: 0.62rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .rag-course-source-actions {
        flex: 0 0 auto;
        display: flex;
        gap: 6px;
      }

      .rag-course-source-actions .analyze-button {
        min-height: 28px;
        padding: 4px 9px;
        font-size: 0.66rem;
      }

      .rag-course-source-preview {
        margin: 6px 0 0;
        color: var(--adaceen-muted);
        font-size: 0.64rem;
        line-height: 1.35;
      }

      /* «Fuentes RAG usadas» compacta (0.7.14): una linea por fuente, agrupadas por curso. */
      .rag-citation-group {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 2px 0 0;
        border: 0;
        background: transparent;
        color: var(--adaceen-primary-strong);
        font-size: 0.64rem;
        font-weight: 800;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }

      .rag-citation-group span {
        color: var(--adaceen-muted);
        font-weight: 700;
        letter-spacing: 0;
        text-transform: none;
      }

      .rag-citation-item {
        gap: 0;
        padding: 6px 9px;
      }

      .rag-cite-head {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }

      .rag-cite-toggle {
        flex: 0 0 auto;
        width: 22px;
        height: 22px;
        padding: 0;
        border: 1px solid var(--adaceen-border);
        border-radius: 6px;
        background: #fff;
        color: var(--adaceen-primary-strong);
        font: inherit;
        font-size: 0.7rem;
        line-height: 1;
        cursor: pointer;
      }

      .rag-cite-toggle[aria-expanded="true"] {
        background: var(--adaceen-primary-soft);
      }

      .rag-cite-title {
        flex: 1 1 auto;
        min-width: 0;
        color: var(--adaceen-ink);
        font-size: 0.72rem;
        font-weight: 800;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .rag-cite-meta {
        flex: 0 0 auto;
        color: var(--adaceen-muted);
        font-size: 0.62rem;
        white-space: nowrap;
      }

      .rag-cite-link {
        flex: 0 0 auto;
        color: var(--adaceen-primary-strong);
        font-size: 0.66rem;
        font-weight: 800;
        white-space: nowrap;
      }

      .rag-cite-detail {
        display: grid;
        gap: 3px;
        margin-top: 6px;
        padding-top: 6px;
        border-top: 1px dashed var(--adaceen-border);
        color: var(--adaceen-muted);
        font-size: 0.64rem;
        line-height: 1.35;
      }

      .rag-cite-detail[hidden] {
        display: none !important;
      }

      .rag-sources-section {
        padding: 6px 10px;
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius);
        background: var(--adaceen-panel);
      }

      .rag-sources-section[hidden] {
        display: none !important;
      }

      .rag-sources-summary {
        display: flex;
        align-items: center;
        gap: 8px;
        list-style: none;
        cursor: pointer;
      }

      .rag-sources-summary::-webkit-details-marker {
        display: none;
      }

      .rag-sources-summary .eyebrow {
        flex: 1 1 auto;
        margin: 0;
      }

      .rag-sources-summary::before {
        content: "";
        flex: 0 0 auto;
        width: 0;
        height: 0;
        border-top: 5px solid transparent;
        border-bottom: 5px solid transparent;
        border-left: 6px solid var(--adaceen-primary-strong);
        transition: transform 120ms ease;
      }

      .rag-sources-section[open] > .rag-sources-summary::before {
        transform: rotate(90deg);
      }

      .rag-sources-section[open] > .rag-sources-summary {
        margin-bottom: 8px;
      }

      .rag-sources-count {
        flex: 0 0 auto;
        color: var(--adaceen-muted);
        font-size: 0.66rem;
        font-weight: 700;
      }

      .rag-sources-note {
        margin: 0 0 6px;
        color: var(--adaceen-muted);
        font-size: 0.66rem;
      }

`;
