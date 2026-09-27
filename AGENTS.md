# AGENTS.md

Guidance for coding agents working in this repository.

## Repository Shape

- The repo root is the backend (`agente-local`: Express + TypeScript), with `browser-ext-prod/` (browser extension) and `vscode-ext-prod/` (VS Code extension). On Eyder's PC it lives at `E:\Univalle\16. Décimo Semestre\TGII\Código\PDC`; older notes that mention `agente-proxy-azure` or `/Users/EyderSS/repos/PDC` refer to the same code.
- `vscode-ext-prod` is a git submodule. Commit and push changes inside that submodule first, then commit the updated submodule pointer in this repo.
- The Azure deployment branch for this repo is `feature/azure-config-observability`.

## Code Layout

- `src/db/database.ts`: `AppDatabase` is the last class of a chain in `src/db/repos/` (core -> auth -> users -> policy -> rag-lots -> rag-sources -> github -> workspace -> pilot -> telemetry -> progress -> quiz -> AppDatabase). Add a method to the class of its domain; callers keep using `db.method()`. A class may only call methods of its own class or of earlier ones. A `private` member used from another class of the chain must be `protected`. Row types and mappers live in `src/db/rows.ts`, `quiz-rows.ts` and `telemetry-rows.ts`.
- `browser-ext-prod/`: classic content scripts that share one global scope (no bundler, no `import`). See "Estructura del frontend" in `browser-ext-prod/readme.md`. Every new `.js` file goes into both `manifest.json` (`content_scripts[0].js`) and `background.js` (`CONTENT_SCRIPT_FILES`), in the same position. There is one file per tab or area with its render functions and its `bind...()` function, and `ensureOverlay()` only calls those functions.
- `vscode-ext-prod/src/extension.ts` keeps `activate()` and `deactivate()`. Helpers live in modules under `src/` (settings, workspace-scan, backend-http, git-repo, editor-snapshot, active-suggestion, suggestion-*, code-actions, status-bar...). Mutable state read by several modules lives in its own module with a setter (`connection-state.ts`).

## Validation

Run these checks before pushing backend or route changes:

```bash
npm run build
npm test
```

For browser-extension JavaScript touched in `browser-ext-prod`, run `node --check` on the modified files.

For VS Code extension changes inside `vscode-ext-prod`, run:

```bash
npm run compile
npm run lint
npm run test:unit
```

The lint command may report existing style warnings, but it should not report errors.

## Browser Extension Artifacts

- Load `browser-ext-prod/` from this repo (the loose `Código\browser-ext-prod` folder next to it is an old copy).
- Build the Chromium and Firefox packages with `npm run empaquetar:extension`. The packages go to `dist/extension/`, which is not committed.

## Azure Checks

Production API:

```text
https://app-adaceen-api-eyder05232002.azurewebsites.net
```

Useful smoke checks:

```bash
curl -sS https://app-adaceen-api-eyder05232002.azurewebsites.net/api/health
curl -sS -I https://app-adaceen-api-eyder05232002.azurewebsites.net/privacy-policy
```

The GitHub Actions workflow deploys on pushes to `feature/azure-config-observability`.

## Safety Notes

- Do not commit `.env`, local logs, `node_modules`, or generated build output unless explicitly requested.
- Preserve local credential and environment files when replacing or syncing artifacts.
- If a browser-extension issue appears stale, check every load path above before blaming the backend.
- If a route was just deployed, Azure may briefly return old behavior or time out while the Web App restarts.
