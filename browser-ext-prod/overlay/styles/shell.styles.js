// ADACEEN | Capa 4 - UI: estilos de la estructura del shell, cabecera, controles comunes y autenticación.
// Extraído de overlay/content-styles.js (líneas 273-691).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const OVERLAY_SHELL_STYLES = `      .minimized-tab-mark {
        display: inline-grid;
        place-items: center;
        flex: 0 0 auto;
        width: 30px;
        height: 30px;
        border-radius: 8px;
        background: linear-gradient(180deg, #f7b267, #c25b32);
        color: #fff;
        font-size: 0.78rem;
        font-weight: 900;
        line-height: 1;
      }

      .minimized-tab-copy {
        display: grid;
        min-width: 0;
        gap: 2px;
      }

      .minimized-tab-copy strong,
      .minimized-tab-copy span {
        display: block;
        max-width: 170px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .minimized-tab-copy strong {
        color: var(--adaceen-ink);
        font-size: 0.82rem;
        font-weight: 900;
        line-height: 1.1;
      }

      .minimized-tab-copy span {
        color: var(--adaceen-muted);
        font-size: 0.66rem;
        font-weight: 700;
        line-height: 1.25;
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        padding: 12px 14px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.12);
        background: linear-gradient(135deg, #122033 0%, #123e49 58%, #245c64 100%);
        color: #fff;
        cursor: grab;
      }

      .brand {
        display: flex;
        align-items: center;
        gap: 11px;
        min-width: 0;
      }

      .brand-dot {
        display: inline-grid;
        place-items: center;
        width: 30px;
        height: 30px;
        border-radius: 8px;
        background: linear-gradient(180deg, #f7b267, #c25b32);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.45), 0 10px 20px rgba(0, 0, 0, 0.18);
      }

      .brand-dot::after {
        content: "A";
        color: #fff;
        font-size: 0.78rem;
        font-weight: 900;
        line-height: 1;
      }

      .brand strong {
        display: block;
        color: #fff;
        font-size: 0.94rem;
        font-weight: 800;
        line-height: 1;
        max-width: 210px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .brand span {
        display: block;
        color: rgba(255, 255, 255, 0.7);
        font-size: 0.68rem;
        font-weight: 600;
        margin-top: 3px;
      }

      .header-actions {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .icon-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.12);
        color: #fff;
        cursor: pointer;
        font-size: 0.94rem;
        line-height: 1;
        transition: background 140ms ease, border-color 140ms ease, transform 140ms ease;
      }

      .icon-button:hover {
        background: rgba(255, 255, 255, 0.2);
        transform: translateY(-1px);
      }

      .body .icon-button,
      .settings-panel .icon-button,
      .teacher-bitacora-page .icon-button,
      .teacher-rag-page .icon-button,
      .analysis-window .icon-button,
      .confirmation-dialog .icon-button {
        border-color: var(--adaceen-border);
        background: #fff;
        color: var(--adaceen-ink);
      }

      .body .icon-button:hover,
      .settings-panel .icon-button:hover,
      .teacher-bitacora-page .icon-button:hover,
      .teacher-rag-page .icon-button:hover,
      .analysis-window .icon-button:hover,
      .confirmation-dialog .icon-button:hover {
        border-color: var(--adaceen-border-strong);
        background: var(--adaceen-soft);
      }

      .icon-button:focus-visible,
      .primary-button:focus-visible,
      .ghost-button:focus-visible,
      .google-button:focus-visible,
      .save-button:focus-visible,
      .segment-button:focus-visible,
      .goal-button:focus-visible,
      .student-course-option:focus-visible,
      .field input:focus-visible,
      .field select:focus-visible,
      .field textarea:focus-visible {
        outline: 3px solid rgba(0, 109, 119, 0.22);
        outline-offset: 2px;
      }

      .icon-button.text-button {
        width: auto;
        min-width: 32px;
        padding: 0 9px;
        font-size: 0.7rem;
        font-weight: 800;
      }

      .body {
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
        overscroll-behavior: contain;
        padding: 14px;
        background: linear-gradient(180deg, #f7fafb 0%, #eef3f6 100%);
      }

      .body::-webkit-scrollbar,
      .settings-grid::-webkit-scrollbar,
      .bitacora-page-body::-webkit-scrollbar,
      .analysis-body::-webkit-scrollbar {
        width: 10px;
      }

      .body::-webkit-scrollbar-thumb,
      .settings-grid::-webkit-scrollbar-thumb,
      .bitacora-page-body::-webkit-scrollbar-thumb,
      .analysis-body::-webkit-scrollbar-thumb {
        border: 3px solid transparent;
        border-radius: 999px;
        background: rgba(100, 113, 132, 0.35);
        background-clip: content-box;
      }

      .view[hidden] {
        display: none;
      }

      .pill {
        display: inline-flex;
        align-items: center;
        min-height: 24px;
        padding: 4px 8px;
        border-radius: 7px;
        background: var(--adaceen-primary-soft);
        border: 1px solid #b9dfe1;
        color: var(--adaceen-primary-strong);
        font-size: 0.64rem;
        font-weight: 850;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .extension-version-badge {
        display: inline-flex;
        align-items: center;
        min-height: 24px;
        max-width: 100%;
        margin-left: 6px;
        padding: 4px 8px;
        border: 1px solid #d7c49a;
        border-radius: 7px;
        background: #fff8e7;
        color: #7c4f06;
        font-size: 0.64rem;
        font-weight: 850;
        letter-spacing: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .role-pill {
        background: #edf2ff;
        border-color: #c7d2fe;
        color: #33418f;
      }

      h1 {
        margin: 12px 0 6px;
        color: var(--adaceen-ink);
        font-size: 1.18rem;
        font-weight: 850;
        line-height: 1.15;
      }

      h2 {
        margin: 0 0 8px;
        color: var(--adaceen-ink);
        font-size: 0.86rem;
        font-weight: 800;
      }

      p {
        margin: 0;
        line-height: 1.45;
      }

      .copy {
        color: var(--adaceen-muted);
        font-size: 0.8rem;
      }

      .primary-button,
      .ghost-button,
      .google-button,
      .save-button {
        width: 100%;
        min-height: 38px;
        border: 1px solid transparent;
        border-radius: 8px;
        cursor: pointer;
        font-weight: 800;
        font-size: 0.8rem;
        line-height: 1.15;
        padding: 10px 12px;
        transition: background 140ms ease, border-color 140ms ease, color 140ms ease, transform 140ms ease, box-shadow 140ms ease;
      }

      .primary-button,
      .save-button {
        color: #fff;
        background: linear-gradient(180deg, #007c87 0%, #00545d 100%);
        border-color: #00545d;
        box-shadow: 0 10px 22px rgba(0, 84, 93, 0.2);
      }

      .ghost-button {
        color: var(--adaceen-ink);
        background: #fff;
        border-color: var(--adaceen-border);
      }

      .danger-button {
        color: var(--adaceen-danger);
        background: var(--adaceen-danger-soft);
        border-color: #ffc8c2;
      }

      .primary-button:hover,
      .save-button:hover {
        background: linear-gradient(180deg, #00737d 0%, #004c54 100%);
        transform: translateY(-1px);
        box-shadow: 0 12px 26px rgba(0, 84, 93, 0.24);
      }

      .ghost-button:hover,
      .google-button:hover {
        background: #f8fbfc;
        border-color: var(--adaceen-border-strong);
        transform: translateY(-1px);
      }

      .google-button {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        color: var(--adaceen-ink);
        background: #fff;
        border-color: var(--adaceen-border);
        box-shadow: var(--adaceen-shadow-soft);
      }

      .google-mark {
        display: inline-grid;
        place-items: center;
        width: 20px;
        height: 20px;
        border-radius: 6px;
        color: #1a73e8;
        background: #fff;
        border: 1px solid var(--adaceen-border);
        font-weight: 800;
        font-size: 0.78rem;
      }

      .auth-divider {
        display: flex;
        align-items: center;
        gap: 10px;
        margin: 12px 0;
        color: var(--adaceen-muted);
        font-size: 0.66rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .auth-divider::before,
      .auth-divider::after {
        content: "";
        flex: 1;
        height: 1px;
        background: var(--adaceen-border);
      }

      .primary-button:disabled,
      .ghost-button:disabled,
      .google-button:disabled,
      .save-button:disabled {
        cursor: not-allowed;
        opacity: 0.62;
        transform: none;
        box-shadow: none;
      }

      .button-row {
        display: grid;
        gap: 8px;
        margin-top: 12px;
      }

      .button-row.split {
        grid-template-columns: 1fr 1fr;
      }

      .auth-card {
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius);
        background: var(--adaceen-panel);
        padding: 12px;
        margin-top: 12px;
        box-shadow: var(--adaceen-shadow-soft);
      }

      .segmented {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 8px;
        margin-top: 14px;
      }

      .segment-button {
        border: 1px solid var(--adaceen-border);
        border-radius: 8px;
        background: #fff;
        color: var(--adaceen-ink);
        cursor: pointer;
        padding: 10px;
        text-align: center;
        font-size: 0.76rem;
        font-weight: 700;
      }

      .segment-button.is-selected {
        border-color: var(--adaceen-primary);
        background: var(--adaceen-primary-soft);
        color: var(--adaceen-primary-strong);
        box-shadow: 0 10px 18px rgba(0, 109, 119, 0.12);
      }

`;
