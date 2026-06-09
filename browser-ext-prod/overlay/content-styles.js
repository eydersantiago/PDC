const OVERLAY_STYLES = `
    <style>
      :host {
        all: initial;
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 2147483647;
        font-family: "Trebuchet MS", "Segoe UI", sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      .shell {
        width: min(380px, calc(100vw - 32px));
        color: #173046;
        transition: width 160ms ease;
      }

      .shell.has-tab-conflict .window > .body {
        filter: blur(2px);
        pointer-events: none;
        transition: filter 160ms ease;
      }

      .shell.shell-expanded {
        width: min(780px, calc(100vw - 32px));
      }

      .window {
        position: relative;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        max-height: min(760px, calc(100dvh - 32px));
        border: 1px solid #d9cbb4;
        border-radius: 20px;
        background:
          radial-gradient(120% 120% at 0% 0%, #fff7ea 0%, transparent 52%),
          linear-gradient(180deg, #fffaf3 0%, #f5fbf9 100%);
        box-shadow: 0 18px 48px rgba(19, 48, 70, 0.18);
        backdrop-filter: blur(12px);
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 16px 10px;
        cursor: grab;
      }

      .brand {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .brand-dot {
        width: 12px;
        height: 12px;
        border-radius: 999px;
        background: linear-gradient(180deg, #c95f30, #94511c);
        box-shadow: 0 0 0 5px rgba(201, 95, 48, 0.12);
      }

      .brand strong {
        display: block;
        font-size: 0.97rem;
        line-height: 1;
        max-width: 190px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .brand span {
        display: block;
        color: #61707f;
        font-size: 0.7rem;
        margin-top: 3px;
      }

      .header-actions {
        display: flex;
        gap: 8px;
      }

      .icon-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 34px;
        height: 34px;
        border: 1px solid #e5d5bd;
        border-radius: 999px;
        background: #fff8ef;
        color: #173046;
        cursor: pointer;
      }

      .icon-button.text-button {
        width: auto;
        min-width: 34px;
        padding: 0 10px;
        border-radius: 999px;
        font-size: 0.72rem;
        font-weight: 700;
      }

      .body {
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
        overscroll-behavior: contain;
        padding: 0 16px 16px;
      }

      .view[hidden] {
        display: none;
      }

      .pill {
        display: inline-flex;
        align-items: center;
        padding: 5px 10px;
        border-radius: 999px;
        background: #edf8f5;
        border: 1px solid #c6e6dc;
        color: #0f766e;
        font-size: 0.68rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .role-pill {
        background: #fff4e8;
        border-color: #edc7a8;
        color: #9a4a1e;
      }

      h1 {
        margin: 12px 0 8px;
        font-size: 1.15rem;
        line-height: 1.15;
      }

      h2 {
        margin: 0 0 8px;
        font-size: 0.84rem;
      }

      p {
        margin: 0;
        line-height: 1.45;
      }

      .copy {
        color: #516070;
        font-size: 0.8rem;
      }

      .primary-button,
      .ghost-button,
      .google-button,
      .save-button {
        width: 100%;
        border: 0;
        border-radius: 14px;
        cursor: pointer;
        font-weight: 700;
        font-size: 0.84rem;
        padding: 12px 14px;
      }

      .primary-button,
      .save-button {
        color: #fff;
        background: linear-gradient(180deg, #c65c2b, #8d3813);
      }

      .ghost-button {
        color: #173046;
        background: #f6ede0;
        border: 1px solid #e3d1b5;
      }

      .google-button {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        color: #173046;
        background: #fff;
        border: 1px solid #d7e0ea;
        box-shadow: 0 10px 22px rgba(31, 47, 70, 0.08);
      }

      .google-mark {
        display: inline-grid;
        place-items: center;
        width: 20px;
        height: 20px;
        border-radius: 999px;
        color: #1a73e8;
        background: #fff;
        border: 1px solid #d7e0ea;
        font-weight: 800;
        font-size: 0.78rem;
      }

      .auth-divider {
        display: flex;
        align-items: center;
        gap: 10px;
        margin: 12px 0;
        color: #7b8794;
        font-size: 0.7rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .auth-divider::before,
      .auth-divider::after {
        content: "";
        flex: 1;
        height: 1px;
        background: #e8d9c3;
      }

      .primary-button:disabled,
      .ghost-button:disabled,
      .google-button:disabled,
      .save-button:disabled {
        cursor: not-allowed;
        opacity: 0.62;
      }

      .button-row {
        display: grid;
        gap: 10px;
        margin-top: 16px;
      }

      .button-row.split {
        grid-template-columns: 1fr 1fr;
      }

      .auth-card {
        border: 1px solid #e8d9c3;
        border-radius: 16px;
        background: rgba(255, 251, 245, 0.92);
        padding: 12px;
        margin-top: 12px;
      }

      .segmented {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 8px;
        margin-top: 14px;
      }

      .segment-button {
        border: 1px solid #e6d5bd;
        border-radius: 14px;
        background: #fff9f0;
        color: #173046;
        cursor: pointer;
        padding: 10px;
        text-align: center;
        font-size: 0.76rem;
        font-weight: 700;
      }

      .segment-button.is-selected {
        border-color: #c65c2b;
        background: #fff1e5;
        box-shadow: 0 10px 18px rgba(198, 92, 43, 0.12);
      }

      .main-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 12px;
      }

      .main-top .ghost-button {
        width: auto;
        padding: 9px 12px;
        font-size: 0.76rem;
      }

      .context-hub {
        border: 1px solid #d4e3df;
        border-radius: 16px;
        background: linear-gradient(180deg, #f6fbfb 0%, #fffdf8 100%);
        padding: 12px;
        margin-bottom: 12px;
        display: grid;
        gap: 10px;
      }

      .context-hub-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }

      .next-action {
        display: grid;
        gap: 10px;
      }

      .context-hub h2 {
        margin: 0 0 4px;
        font-size: 0.92rem;
        line-height: 1.2;
      }

      .context-meta {
        color: #526574;
        font-size: 0.74rem;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }

      .state-chip {
        flex: 0 0 auto;
        border: 1px solid #ccd8e4;
        border-radius: 999px;
        background: #f3f7fb;
        color: #36536a;
        padding: 6px 9px;
        font-size: 0.68rem;
        font-weight: 800;
        line-height: 1;
        white-space: nowrap;
      }

      .state-chip.is-ok {
        border-color: #b6ded6;
        background: #e9f8f4;
        color: #0d6d66;
      }

      .state-chip.is-warn {
        border-color: #e4c794;
        background: #fff6df;
        color: #8b5a10;
      }

      .connection-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 8px;
      }

      .connection-item {
        min-width: 0;
        border: 1px solid #e3d9ca;
        border-radius: 12px;
        background: #fffefb;
        padding: 8px;
        display: grid;
        gap: 5px;
      }

      .connection-item span {
        color: #657382;
        font-size: 0.66rem;
        font-weight: 800;
        letter-spacing: 0.03em;
        text-transform: uppercase;
      }

      .connection-item strong {
        color: #1f394d;
        font-size: 0.74rem;
        line-height: 1.25;
        overflow-wrap: anywhere;
      }

      .connection-item.is-ok {
        border-color: #bfe0d9;
        background: #f3fbf8;
      }

      .connection-item.is-warn {
        border-color: #ecd39d;
        background: #fff9e9;
      }

      .next-action {
        border-top: 1px solid #dbe7e4;
        padding-top: 10px;
      }

      .operation-banner {
        display: flex;
        align-items: center;
        gap: 10px;
        border: 1px solid #acd7cf;
        border-radius: 12px;
        background: #eefbf8;
        color: #143c3a;
        padding: 10px;
      }

      .operation-banner[hidden] {
        display: none !important;
      }

      .operation-banner strong {
        display: block;
        color: #0b625d;
        font-size: 0.82rem;
        line-height: 1.2;
      }

      .operation-banner p {
        color: #355c58;
        font-size: 0.72rem;
        line-height: 1.35;
        margin: 2px 0 0;
      }

      .operation-spinner {
        width: 18px;
        height: 18px;
        flex: 0 0 auto;
        border: 3px solid #cceae5;
        border-top-color: #0b7a75;
        border-radius: 999px;
        animation: adaceen-spin 0.8s linear infinite;
      }

      .operation-banner.is-error {
        border-color: #efb5a5;
        background: #fff1ec;
        color: #6f2414;
      }

      .operation-banner.is-error strong {
        color: #8d3813;
      }

      .operation-banner.is-error p {
        color: #6f3a2d;
      }

      .operation-banner.is-error .operation-spinner {
        border-color: #f3c8ba;
        border-top-color: #c65c2b;
        animation: none;
      }

      @keyframes adaceen-spin {
        to {
          transform: rotate(360deg);
        }
      }

      .next-action strong {
        display: block;
        color: #173046;
        font-size: 0.86rem;
        line-height: 1.25;
        margin-bottom: 4px;
      }

      .next-action p {
        color: #526574;
        font-size: 0.74rem;
        line-height: 1.35;
      }

      .context-actions {
        width: 100%;
        margin-top: 0;
      }

      .summary-card,
      .teacher-card,
      .panel-section,
      .preview-card {
        border: 1px solid #e8d9c3;
        border-radius: 16px;
        background: rgba(255, 251, 245, 0.92);
        padding: 12px;
      }

      .summary-card,
      .teacher-card,
      .panel-section {
        margin-bottom: 12px;
      }

      .summary-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      .analyze-button {
        width: auto;
        padding: 7px 10px;
        font-size: 0.72rem;
      }

      .teacher-card {
        background: linear-gradient(180deg, #eef9f6 0%, #f7fcfb 100%);
        border-color: #d1ebe3;
        margin-bottom: 8px;
      }

      .eyebrow {
        display: block;
        margin-bottom: 6px;
        color: #0f766e;
        font-size: 0.68rem;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .summary-title {
        font-size: 0.9rem;
        line-height: 1.25;
        margin-bottom: 6px;
      }

      .summary-meta {
        color: #667482;
        font-size: 0.72rem;
        margin-bottom: 8px;
      }

      .signal {
        color: #294355;
        font-size: 0.78rem;
      }

      .teacher-summary {
        color: #315467;
        font-size: 0.75rem;
      }

      .policy-lead {
        margin-top: 8px;
        color: #315467;
        font-size: 0.75rem;
      }

      .session-badge {
        margin-top: 10px;
        padding: 8px 10px;
        border-radius: 12px;
        background: #fff7ed;
        border: 1px solid #ecd6bd;
        color: #4a5c69;
        font-size: 0.74rem;
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
        border-radius: 12px;
        border: 1px solid #ebddca;
        background: #fffdf8;
      }

      .telemetry-list li strong {
        display: block;
        margin-bottom: 3px;
      }

      .telemetry-list li span {
        display: block;
        color: #667482;
        font-size: 0.7rem;
      }

      .goal-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }

      .goal-button {
        border: 1px solid #e6d5bd;
        border-radius: 14px;
        background: #fff9f0;
        color: #173046;
        cursor: pointer;
        padding: 10px;
        text-align: left;
        font-size: 0.74rem;
        line-height: 1.3;
      }

      .goal-button.is-selected {
        border-color: #c65c2b;
        background: #fff1e5;
        box-shadow: 0 10px 18px rgba(198, 92, 43, 0.12);
      }

      .panel-section ul,
      .panel-section ol {
        margin: 0;
        padding-left: 18px;
        display: grid;
        gap: 6px;
        color: #30485b;
        font-size: 0.78rem;
        line-height: 1.4;
      }

      .admin-table-wrap {
        overflow: auto;
        border: 1px solid #eadcc8;
        border-radius: 12px;
        background: #fffdf8;
      }

      .admin-table {
        width: 100%;
        min-width: 640px;
        border-collapse: collapse;
      }

      .admin-table th,
      .admin-table td {
        border-bottom: 1px solid #f0e4d2;
        padding: 8px;
        text-align: left;
        vertical-align: middle;
        font-size: 0.72rem;
      }

      .admin-table th {
        font-size: 0.7rem;
        letter-spacing: 0.03em;
        text-transform: uppercase;
        color: #5f6f7e;
        background: #fff7ee;
      }

      .admin-table td input,
      .admin-table td select {
        width: 100%;
        border: 1px solid #dccab0;
        border-radius: 10px;
        padding: 7px 8px;
        font-size: 0.72rem;
        background: #fffefb;
      }

      .admin-actions-cell {
        display: flex;
        gap: 6px;
      }

      .admin-actions-cell .ghost-button,
      .admin-actions-cell .save-button {
        width: auto;
        padding: 7px 9px;
        font-size: 0.7rem;
      }

      details summary {
        cursor: pointer;
        font-weight: 700;
        font-size: 0.78rem;
        color: #25465a;
      }

      pre {
        margin: 10px 0 0;
        max-height: 160px;
        overflow: auto;
        border-radius: 12px;
        background: #fffdf8;
        border: 1px solid #eadcc8;
        padding: 10px;
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 0.72rem;
        line-height: 1.4;
      }

      .status {
        min-height: 18px;
        margin-top: 12px;
        color: #667482;
        font-size: 0.74rem;
        line-height: 1.35;
      }

      .status.is-warning {
        color: #8c3d1c;
        font-weight: 700;
      }

      .confirmation-modal {
        position: absolute;
        inset: 0;
        z-index: 5;
        display: grid;
        place-items: center;
        padding: 18px;
        background: rgba(23, 48, 70, 0.36);
        backdrop-filter: blur(6px);
      }

      .confirmation-modal[hidden] {
        display: none;
      }

      .confirmation-dialog {
        width: min(330px, 100%);
        border: 1px solid #e5d4bd;
        border-radius: 16px;
        background: #fffaf3;
        box-shadow: 0 18px 42px rgba(19, 48, 70, 0.24);
        padding: 16px;
      }

      .confirmation-dialog h2 {
        margin: 12px 0 8px;
        font-size: 1rem;
        line-height: 1.2;
      }

      .process-modal .confirmation-dialog {
        border-color: #acd7cf;
        background: #fffefb;
      }

      .conflict-modal .confirmation-dialog {
        border-color: #f0beaa;
        background: #fff8f3;
      }

      .settings-panel {
        position: absolute;
        inset: 0;
        padding: 16px;
        overflow: auto;
        background: rgba(255, 249, 239, 0.98);
        backdrop-filter: blur(10px);
        transform: translateX(101%);
        transition: transform 160ms ease;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .window.settings-open .settings-panel {
        transform: translateX(0);
      }

      .settings-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }

      .settings-note {
        color: #62707d;
        font-size: 0.76rem;
        line-height: 1.4;
      }

      .settings-grid {
        display: grid;
        gap: 10px;
        overflow: auto;
      }

      .settings-subcard {
        border: 1px solid #e3d1b8;
        border-radius: 16px;
        background: rgba(255, 249, 241, 0.9);
        padding: 12px;
        display: grid;
        gap: 10px;
      }

      .settings-subhead {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
      }

      .settings-subhead h3 {
        margin: 0 0 4px;
        font-size: 0.86rem;
        line-height: 1.2;
      }

      .settings-subhead .ghost-button {
        width: auto;
        padding: 8px 10px;
        font-size: 0.74rem;
        white-space: nowrap;
      }

      .settings-kv-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }

      .settings-kv {
        border: 1px solid #eadcc8;
        border-radius: 12px;
        background: #fffdf8;
        padding: 9px 10px;
        display: grid;
        gap: 4px;
      }

      .settings-kv span {
        color: #6a7885;
        font-size: 0.68rem;
        font-weight: 800;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      .settings-kv strong {
        color: #173046;
        font-size: 0.78rem;
        line-height: 1.3;
        word-break: break-word;
      }

      .settings-history-list {
        list-style: none;
        padding-left: 0 !important;
        display: grid;
        gap: 8px;
      }

      .settings-history-item {
        border: 1px solid #eadcc8;
        border-radius: 14px;
        background: #fffdf8;
        padding: 10px;
        display: grid;
        gap: 8px;
      }

      .settings-history-top {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
      }

      .settings-history-title {
        margin: 0;
        color: #173046;
        font-size: 0.78rem;
        font-weight: 800;
        line-height: 1.3;
      }

      .settings-history-meta {
        margin-top: 3px;
        color: #667482;
        font-size: 0.7rem;
        line-height: 1.35;
      }

      .settings-history-item .ghost-button,
      .settings-history-item .save-button {
        width: auto;
        padding: 8px 10px;
        font-size: 0.72rem;
      }

      .settings-history-empty {
        margin: 0;
        color: #667482;
        font-size: 0.74rem;
        line-height: 1.35;
      }

      .field {
        display: grid;
        gap: 6px;
      }

      .field label {
        color: #526272;
        font-size: 0.73rem;
        font-weight: 700;
      }

      .field select,
      .field input[type="text"],
      .field input[type="password"],
      .field input[type="number"],
      .field textarea {
        width: 100%;
        border: 1px solid #dccab0;
        border-radius: 12px;
        background: #fffdf8;
        color: #173046;
        padding: 10px;
        font: inherit;
        font-size: 0.78rem;
        outline: none;
      }

      .field textarea {
        resize: vertical;
        min-height: 76px;
      }

      .switch-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 12px;
        border: 1px solid #e7d7c0;
        border-radius: 14px;
        background: #fffdf8;
        color: #344d5f;
        font-size: 0.76rem;
      }

      .switch-row input {
        width: 18px;
        height: 18px;
      }

      .check-grid {
        display: grid;
        gap: 8px;
      }

      .check-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 9px 11px;
        border: 1px solid #eadbc7;
        border-radius: 12px;
        background: #fffdf8;
        font-size: 0.75rem;
      }

      .analysis-window {
        position: absolute;
        inset: 58px 14px 14px;
        border: 1px solid #d8c4a9;
        border-radius: 16px;
        background: rgba(255, 250, 242, 0.98);
        box-shadow: 0 14px 28px rgba(39, 34, 28, 0.2);
        display: flex;
        flex-direction: column;
        z-index: 8;
      }

      .analysis-window[hidden] {
        display: none;
      }

      .analysis-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        border-bottom: 1px solid #e7d6c1;
        padding: 12px 12px 10px;
      }

      .analysis-head strong {
        display: block;
        color: #173046;
        font-size: 0.83rem;
      }

      .analysis-meta {
        margin-top: 4px;
        color: #5f6d79;
        font-size: 0.72rem;
        line-height: 1.35;
      }

      .analysis-body {
        padding: 10px 12px 12px;
        overflow: auto;
      }

      .analysis-tree {
        list-style: none;
        margin: 0;
        padding-left: 0 !important;
        display: grid;
        gap: 6px;
      }

      .analysis-tree li {
        border: 1px solid #ecdcc7;
        border-radius: 10px;
        background: #fffefb;
        padding: 7px 9px;
        color: #243d4f;
        font-size: 0.72rem;
        line-height: 1.35;
        font-family: Consolas, "Courier New", monospace;
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

        .button-row.split,
        .segmented {
          grid-template-columns: 1fr;
        }

        .analysis-window {
          inset: 54px 10px 10px;
        }
      }
    </style>
`;
