const OVERLAY_STYLES = `
    <style>
      :host {
        all: initial;
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 2147483647;
        font-family: "Inter", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        --adaceen-ink: #14212f;
        --adaceen-muted: #647184;
        --adaceen-soft: #eef3f6;
        --adaceen-panel: #ffffff;
        --adaceen-panel-soft: #f8fafb;
        --adaceen-border: #d9e2ea;
        --adaceen-border-strong: #bccbd7;
        --adaceen-primary: #006d77;
        --adaceen-primary-strong: #00545d;
        --adaceen-primary-soft: #e2f3f3;
        --adaceen-accent: #c25b32;
        --adaceen-accent-soft: #fff0e9;
        --adaceen-danger: #b42318;
        --adaceen-danger-soft: #fff1f0;
        --adaceen-warning: #996a13;
        --adaceen-warning-soft: #fff7db;
        --adaceen-shadow: 0 22px 60px rgba(15, 23, 42, 0.22);
        --adaceen-shadow-soft: 0 12px 28px rgba(15, 23, 42, 0.1);
        --adaceen-radius: 8px;
      }

      * {
        box-sizing: border-box;
      }

      .shell {
        width: min(400px, calc(100vw - 32px));
        color: var(--adaceen-ink);
        letter-spacing: 0;
        transition: width 180ms ease, transform 180ms ease;
      }

      .shell.has-tab-conflict .window > .body {
        filter: blur(2px);
        pointer-events: none;
        transition: filter 160ms ease;
      }

      .shell.shell-expanded {
        width: min(860px, calc(100vw - 32px));
      }

      .window {
        position: relative;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        max-height: min(780px, calc(100dvh - 32px));
        border: 1px solid rgba(185, 199, 211, 0.95);
        border-radius: 12px;
        background: var(--adaceen-panel);
        box-shadow: var(--adaceen-shadow);
        backdrop-filter: blur(18px);
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
        background: linear-gradient(180deg, #008894 0%, #00616a 100%);
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

      .main-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 10px;
      }

      .main-top-left,
      .main-top-actions,
      .summary-actions,
      .compact-action-row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
      }

      .summary-actions {
        justify-content: flex-end;
      }

      .main-top .ghost-button {
        width: auto;
        min-height: 34px;
        padding: 8px 10px;
        font-size: 0.76rem;
      }

      .context-hub {
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius);
        background: var(--adaceen-panel);
        padding: 12px;
        margin-bottom: 12px;
        display: grid;
        gap: 10px;
        box-shadow: var(--adaceen-shadow-soft);
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
        font-size: 0.95rem;
        line-height: 1.2;
      }

      .context-meta {
        color: var(--adaceen-muted);
        font-size: 0.74rem;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }

      .state-chip {
        flex: 0 0 auto;
        border: 1px solid var(--adaceen-border);
        border-radius: 7px;
        background: var(--adaceen-soft);
        color: #42566c;
        padding: 6px 8px;
        font-size: 0.68rem;
        font-weight: 800;
        line-height: 1;
        white-space: nowrap;
      }

      .state-chip.is-ok {
        border-color: #a6d7d9;
        background: var(--adaceen-primary-soft);
        color: var(--adaceen-primary-strong);
      }

      .state-chip.is-warn {
        border-color: #f0d077;
        background: var(--adaceen-warning-soft);
        color: var(--adaceen-warning);
      }

      .connection-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 8px;
      }

      .connection-item {
        min-width: 0;
        border: 1px solid var(--adaceen-border);
        border-radius: 8px;
        background: var(--adaceen-panel-soft);
        padding: 8px;
        display: grid;
        gap: 5px;
      }

      .connection-item span {
        color: var(--adaceen-muted);
        font-size: 0.66rem;
        font-weight: 800;
        letter-spacing: 0.03em;
        text-transform: uppercase;
      }

      .connection-item strong {
        color: var(--adaceen-ink);
        font-size: 0.74rem;
        line-height: 1.25;
        overflow-wrap: anywhere;
      }

      .connection-item.is-ok {
        border-color: #b9dfe1;
        background: #f1fbfb;
      }

      .connection-item.is-warn {
        border-color: #f0d077;
        background: var(--adaceen-warning-soft);
      }

      .next-action {
        border-top: 1px solid var(--adaceen-border);
        padding-top: 10px;
      }

      .operation-banner {
        display: flex;
        align-items: center;
        gap: 10px;
        border: 1px solid #a6d7d9;
        border-radius: 8px;
        background: var(--adaceen-primary-soft);
        color: var(--adaceen-primary-strong);
        padding: 10px;
      }

      .operation-banner[hidden] {
        display: none !important;
      }

      .operation-banner strong {
        display: block;
        color: var(--adaceen-primary-strong);
        font-size: 0.82rem;
        line-height: 1.2;
      }

      .operation-banner p {
        color: #355d63;
        font-size: 0.72rem;
        line-height: 1.35;
        margin: 2px 0 0;
      }

      .operation-spinner {
        width: 18px;
        height: 18px;
        flex: 0 0 auto;
        border: 3px solid rgba(0, 109, 119, 0.2);
        border-top-color: var(--adaceen-primary);
        border-radius: 999px;
        animation: adaceen-spin 0.8s linear infinite;
      }

      .operation-banner.is-error {
        border-color: #ffc8c2;
        background: var(--adaceen-danger-soft);
        color: var(--adaceen-danger);
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
        color: var(--adaceen-ink);
        font-size: 0.86rem;
        line-height: 1.25;
        margin-bottom: 4px;
      }

      .next-action p {
        color: var(--adaceen-muted);
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
        border: 1px solid var(--adaceen-border);
        border-radius: var(--adaceen-radius);
        background: var(--adaceen-panel);
        padding: 12px;
        box-shadow: 0 8px 20px rgba(15, 23, 42, 0.05);
      }

      .summary-card,
      .teacher-card,
      .panel-section {
        margin-bottom: 12px;
      }

      .summary-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
      }

      .section-head {
        margin-bottom: 8px;
      }

      .section-head .eyebrow {
        margin-bottom: 0;
      }

      .section-title-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 8px;
      }

      .section-title-row h2 {
        margin: 0;
      }

      .setup-step-card {
        margin-top: 12px;
      }

      .setup-step-card h2 {
        margin: 0 0 8px;
      }

      .setup-step-card .settings-note {
        margin-bottom: 10px;
      }

      .tight-row {
        margin-top: 8px;
      }

      .field-stack {
        margin-top: 10px;
      }

      .table-section {
        margin-top: 10px;
      }

      .analyze-button {
        width: auto;
        min-height: 32px;
        padding: 7px 9px;
        font-size: 0.72rem;
      }

      .teacher-card {
        background: linear-gradient(180deg, #f1fbfb 0%, #ffffff 100%);
        border-color: #b9dfe1;
        margin-bottom: 8px;
      }

      .eyebrow {
        display: block;
        margin-bottom: 5px;
        color: var(--adaceen-primary-strong);
        font-size: 0.64rem;
        font-weight: 800;
        letter-spacing: 0.07em;
        text-transform: uppercase;
      }

      .summary-title {
        color: var(--adaceen-ink);
        font-size: 0.92rem;
        font-weight: 800;
        line-height: 1.25;
        margin-bottom: 6px;
      }

      .summary-meta {
        color: var(--adaceen-muted);
        font-size: 0.72rem;
        margin-bottom: 8px;
      }

      .signal {
        color: #334155;
        font-size: 0.78rem;
      }

      .teacher-summary {
        color: #38536a;
        font-size: 0.75rem;
      }

      .policy-lead {
        margin-top: 8px;
        color: #38536a;
        font-size: 0.75rem;
      }

      .session-badge {
        margin-top: 10px;
        padding: 8px 9px;
        border-radius: 8px;
        background: var(--adaceen-soft);
        border: 1px solid var(--adaceen-border);
        color: #475569;
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
        border-radius: 8px;
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
        border-radius: 8px;
        background: var(--adaceen-panel-soft);
      }

      .bitacora-week-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        color: var(--adaceen-ink);
        font-size: 0.76rem;
      }

      .bitacora-week-head span {
        color: var(--adaceen-muted);
        white-space: nowrap;
      }

      .bitacora-topic {
        margin: 6px 0 8px;
        color: #243b53;
        font-size: 0.74rem;
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
        font-size: 0.72rem;
        line-height: 1.35;
      }

      .bitacora-line-label {
        border-radius: 999px;
        padding: 3px 7px;
        text-align: center;
        font-weight: 800;
        font-size: 0.62rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      .bitacora-line-class .bitacora-line-label {
        color: var(--adaceen-primary-strong);
        background: var(--adaceen-primary-soft);
      }

      .bitacora-line-evaluation .bitacora-line-label {
        color: var(--adaceen-accent);
        background: var(--adaceen-accent-soft);
      }

      .bitacora-line-body {
        color: #3e5362;
        overflow-wrap: anywhere;
      }

      .bitacora-week-empty {
        color: #667482;
        font-size: 0.74rem;
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
        font-size: 0.76rem;
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
        border-radius: 7px;
        background: #f8fafc;
        color: #405366;
        padding: 5px 8px;
        font-size: 0.68rem;
        font-weight: 800;
        line-height: 1.15;
      }

      .rag-course-stat.is-ok {
        border-color: #b9dfe1;
        background: #eefafa;
        color: var(--adaceen-primary-strong);
      }

      .rag-course-stat.is-warn {
        border-color: #f3d69b;
        background: #fff8e8;
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
        font-size: 0.76rem;
        font-weight: 800;
        line-height: 1.25;
      }

      .rag-source-meta {
        color: var(--adaceen-muted);
        font-size: 0.68rem;
        line-height: 1.3;
      }

      .rag-source-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
      }

      .rag-source-tag {
        border-radius: 7px;
        padding: 3px 7px;
        background: var(--adaceen-primary-soft);
        color: var(--adaceen-primary-strong);
        font-size: 0.62rem;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }

      .rag-source-item .ghost-button {
        width: auto;
        padding: 7px 9px;
        font-size: 0.68rem;
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
        border-radius: 8px;
        padding: 5px 8px;
        background: #fff;
        color: #243b53;
        font-size: 0.68rem;
        font-weight: 800;
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

      .admin-course-cell {
        min-width: 170px;
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
        border-radius: 8px;
        background: #fff;
        color: var(--adaceen-ink);
        cursor: pointer;
        padding: 10px;
        text-align: left;
      }

      .student-course-option strong {
        font-size: 0.78rem;
      }

      .student-course-option span {
        color: var(--adaceen-muted);
        font-size: 0.72rem;
        line-height: 1.3;
      }

      .student-course-option.is-selected {
        border-color: var(--adaceen-primary);
        background: var(--adaceen-primary-soft);
        box-shadow: 0 10px 20px rgba(0, 109, 119, 0.12);
      }

      .course-empty {
        color: var(--adaceen-muted);
        font-size: 0.76rem;
        line-height: 1.35;
      }

      .telemetry-list li strong {
        display: block;
        margin-bottom: 3px;
      }

      .telemetry-list li span {
        display: block;
        color: var(--adaceen-muted);
        font-size: 0.7rem;
      }

      .goal-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }

      .goal-button {
        min-height: 58px;
        border: 1px solid var(--adaceen-border);
        border-radius: 8px;
        background: #fff;
        color: var(--adaceen-ink);
        cursor: pointer;
        padding: 10px;
        text-align: left;
        font-size: 0.74rem;
        line-height: 1.3;
      }

      .goal-button.is-selected {
        border-color: var(--adaceen-primary);
        background: var(--adaceen-primary-soft);
        color: var(--adaceen-primary-strong);
        box-shadow: 0 10px 18px rgba(0, 109, 119, 0.12);
      }

      .panel-section ul,
      .panel-section ol {
        margin: 0;
        padding-left: 18px;
        display: grid;
        gap: 6px;
        color: #334155;
        font-size: 0.78rem;
        line-height: 1.4;
      }

      .admin-table-wrap {
        overflow: auto;
        border: 1px solid var(--adaceen-border);
        border-radius: 8px;
        background: #fff;
      }

      .admin-table {
        width: 100%;
        min-width: 640px;
        border-collapse: collapse;
      }

      .admin-table th,
      .admin-table td {
        border-bottom: 1px solid var(--adaceen-border);
        padding: 8px;
        text-align: left;
        vertical-align: middle;
        font-size: 0.72rem;
      }

      .admin-table th {
        font-size: 0.7rem;
        letter-spacing: 0.03em;
        text-transform: uppercase;
        color: var(--adaceen-muted);
        background: var(--adaceen-soft);
      }

      .admin-table td input,
      .admin-table td select {
        width: 100%;
        border: 1px solid var(--adaceen-border);
        border-radius: 8px;
        padding: 7px 8px;
        font-size: 0.72rem;
        background: #fff;
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
        color: #243b53;
      }

      pre {
        margin: 10px 0 0;
        max-height: 160px;
        overflow: auto;
        border-radius: 8px;
        background: #0f172a;
        border: 1px solid #1e293b;
        color: #dbeafe;
        padding: 10px;
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 0.72rem;
        line-height: 1.4;
      }

      .status {
        min-height: 18px;
        margin-top: 12px;
        color: var(--adaceen-muted);
        font-size: 0.74rem;
        line-height: 1.35;
      }

      .status.is-warning {
        color: var(--adaceen-danger);
        font-weight: 700;
      }

      .confirmation-modal {
        position: absolute;
        inset: 0;
        z-index: 5;
        display: grid;
        place-items: center;
        padding: 18px;
        background: rgba(15, 23, 42, 0.42);
        backdrop-filter: blur(6px);
      }

      .confirmation-modal[hidden] {
        display: none;
      }

      .confirmation-dialog {
        width: min(330px, 100%);
        border: 1px solid var(--adaceen-border);
        border-radius: 10px;
        background: #fff;
        box-shadow: var(--adaceen-shadow);
        padding: 16px;
      }

      .confirmation-dialog h2 {
        margin: 12px 0 8px;
        font-size: 1rem;
        line-height: 1.2;
      }

      .teacher-bitacora-page,
      .teacher-rag-page {
        position: absolute;
        inset: 0;
        z-index: 9;
        display: flex;
        flex-direction: column;
        background: rgba(248, 250, 252, 0.99);
        backdrop-filter: blur(10px);
      }

      .teacher-bitacora-page[hidden],
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
        font-size: 0.76rem;
        line-height: 1.35;
      }

      .bitacora-page-body {
        flex: 1 1 auto;
        overflow: auto;
        padding: 14px 16px 16px;
      }

      .bitacora-manual-card {
        display: grid;
        gap: 12px;
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

      .process-modal .confirmation-dialog {
        border-color: #a6d7d9;
        background: #fff;
      }

      .course-modal .confirmation-dialog {
        width: min(360px, 100%);
        border-color: #a6d7d9;
        background: #fff;
      }

      .conflict-modal .confirmation-dialog {
        border-color: #ffc8c2;
        background: #fff;
      }

      .settings-panel {
        position: absolute;
        inset: 0;
        padding: 16px;
        overflow: auto;
        background: rgba(248, 250, 252, 0.99);
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
        padding-bottom: 10px;
        border-bottom: 1px solid var(--adaceen-border);
      }

      .settings-note {
        color: var(--adaceen-muted);
        font-size: 0.76rem;
        line-height: 1.4;
      }

      .settings-grid {
        display: grid;
        gap: 10px;
        overflow: auto;
      }

      .settings-subcard {
        border: 1px solid var(--adaceen-border);
        border-radius: 8px;
        background: #fff;
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
        border: 1px solid var(--adaceen-border);
        border-radius: 8px;
        background: var(--adaceen-panel-soft);
        padding: 9px 10px;
        display: grid;
        gap: 4px;
      }

      .settings-kv span {
        color: var(--adaceen-muted);
        font-size: 0.68rem;
        font-weight: 800;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      .settings-kv strong {
        color: var(--adaceen-ink);
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
        border: 1px solid var(--adaceen-border);
        border-radius: 8px;
        background: #fff;
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
        color: var(--adaceen-ink);
        font-size: 0.78rem;
        font-weight: 800;
        line-height: 1.3;
      }

      .settings-history-meta {
        margin-top: 3px;
        color: var(--adaceen-muted);
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
        color: var(--adaceen-muted);
        font-size: 0.74rem;
        line-height: 1.35;
      }

      .field {
        display: grid;
        gap: 6px;
      }

      .field label {
        color: #475569;
        font-size: 0.73rem;
        font-weight: 800;
      }

      .field select,
      .field input[type="text"],
      .field input[type="password"],
      .field input[type="number"],
      .field textarea {
        width: 100%;
        border: 1px solid var(--adaceen-border);
        border-radius: 8px;
        background: #fff;
        color: var(--adaceen-ink);
        padding: 10px;
        font: inherit;
        font-size: 0.78rem;
        outline: none;
        transition: border-color 140ms ease, box-shadow 140ms ease;
      }

      .field select:focus,
      .field input[type="text"]:focus,
      .field input[type="password"]:focus,
      .field input[type="number"]:focus,
      .field textarea:focus {
        border-color: var(--adaceen-primary);
        box-shadow: 0 0 0 3px rgba(0, 109, 119, 0.1);
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
        border: 1px solid var(--adaceen-border);
        border-radius: 8px;
        background: #fff;
        color: #334155;
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
        border: 1px solid var(--adaceen-border);
        border-radius: 8px;
        background: #fff;
        font-size: 0.75rem;
      }

      .analysis-window {
        position: absolute;
        inset: 58px 14px 14px;
        border: 1px solid var(--adaceen-border);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.98);
        box-shadow: var(--adaceen-shadow);
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
        border-bottom: 1px solid var(--adaceen-border);
        padding: 12px 12px 10px;
      }

      .analysis-head strong {
        display: block;
        color: var(--adaceen-ink);
        font-size: 0.83rem;
      }

      .analysis-meta {
        margin-top: 4px;
        color: var(--adaceen-muted);
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
        border: 1px solid var(--adaceen-border);
        border-radius: 8px;
        background: var(--adaceen-panel-soft);
        padding: 7px 9px;
        color: #243b53;
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
