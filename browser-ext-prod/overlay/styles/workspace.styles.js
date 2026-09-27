// ADACEEN | Capa 4 - UI: estilos de la paleta flotante integrada en VS Code / editor web.
// Extraído de overlay/content-styles.js (líneas 117-272).
// Orden de carga: manifest.json (content_scripts) y background.js (CONTENT_SCRIPT_FILES) deben coincidir.
"use strict";

const OVERLAY_WORKSPACE_STYLES = `      .vscode-inline-palette {
        position: fixed;
        left: 24px;
        top: 24px;
        z-index: 2147483647;
        width: min(340px, calc(100vw - 24px));
        border: 1px solid rgba(8, 126, 139, 0.28);
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.98);
        color: var(--adaceen-ink);
        box-shadow: 0 18px 44px rgba(15, 23, 42, 0.18);
        padding: 10px;
        pointer-events: auto;
        transform: translate3d(0, 0, 0);
      }

      .vscode-inline-palette[hidden] {
        display: none !important;
      }

      .vscode-inline-palette::before {
        content: "";
        position: absolute;
        left: -7px;
        top: 20px;
        width: 12px;
        height: 12px;
        border-left: 1px solid rgba(8, 126, 139, 0.28);
        border-bottom: 1px solid rgba(8, 126, 139, 0.28);
        background: rgba(255, 255, 255, 0.98);
        transform: rotate(45deg);
      }

      .vscode-inline-palette.is-left::before {
        left: auto;
        right: -7px;
        border-left: 0;
        border-bottom: 0;
        border-right: 1px solid rgba(8, 126, 139, 0.28);
        border-top: 1px solid rgba(8, 126, 139, 0.28);
      }

      .vscode-inline-head {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 9px;
        align-items: center;
      }

      .vscode-inline-mark {
        display: inline-grid;
        place-items: center;
        width: 30px;
        height: 30px;
        border-radius: 9px;
        background: linear-gradient(180deg, #087e8b, #00545d);
        color: #fff;
        font-size: 0.76rem;
        font-weight: 900;
      }

      .vscode-inline-head strong,
      .vscode-inline-head span,
      .vscode-inline-file,
      .vscode-inline-suggestion {
        min-width: 0;
        overflow-wrap: anywhere;
      }

      .vscode-inline-head strong {
        display: block;
        font-size: 0.78rem;
        line-height: 1.2;
      }

      .vscode-inline-head span {
        display: block;
        margin-top: 2px;
        color: var(--adaceen-muted);
        font-size: 0.68rem;
        line-height: 1.25;
      }

      #vscodeInlineFile {
        margin: 8px 0 0;
        color: #315169;
        font-size: 0.7rem;
        line-height: 1.3;
        overflow-wrap: anywhere;
      }

      .vscode-inline-suggestion {
        margin: 8px 0 0;
        border-radius: 8px;
        background: #eef8f8;
        color: #15333a;
        padding: 8px;
        font-size: 0.72rem;
        line-height: 1.38;
        max-height: 86px;
        overflow: auto;
      }

      .vscode-inline-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 7px;
        margin-top: 9px;
      }

      .vscode-inline-action {
        min-height: 31px;
        border: 1px solid rgba(0, 109, 119, 0.22);
        border-radius: 8px;
        background: #fff;
        color: var(--adaceen-primary-strong);
        cursor: pointer;
        font: inherit;
        font-size: 0.7rem;
        font-weight: 800;
        padding: 7px 10px;
        transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
      }

      .vscode-inline-action:hover {
        transform: translateY(-1px);
        border-color: rgba(0, 109, 119, 0.5);
        background: var(--adaceen-primary-soft);
      }

      .vscode-inline-action:focus-visible {
        outline: 3px solid rgba(0, 109, 119, 0.2);
        outline-offset: 2px;
      }

      .vscode-inline-action[data-mode="insert"] {
        color: #075985;
        border-color: rgba(14, 116, 144, 0.28);
      }

      .vscode-inline-action[data-mode="replace"] {
        color: #6b4e00;
        border-color: rgba(153, 106, 19, 0.3);
      }

      .vscode-inline-action[data-mode="delete"] {
        color: var(--adaceen-danger);
        border-color: rgba(180, 35, 24, 0.26);
      }

      .vscode-inline-action:disabled {
        opacity: 0.55;
        cursor: not-allowed;
        transform: none;
      }

`;
