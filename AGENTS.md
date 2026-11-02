# AGENTS.md

Guidance for coding agents working in this repository.

## Repository Shape

- The repo root is the backend (`agente-local`: Express + TypeScript), with `browser-ext-prod/` (browser extension) and `vscode-ext-prod/` (VS Code extension). On Eyder's PC it lives at `E:\Univalle\16. Décimo Semestre\TGII\Código\PDC`; older notes that mention `agente-proxy-azure` or `/Users/EyderSS/repos/PDC` refer to the same code.
- `vscode-ext-prod` is a git submodule. Commit and push changes inside that submodule first, then commit the updated submodule pointer in this repo.
- The Azure deployment branch for this repo is `feature/azure-config-observability`.
- `refactor/modularizacion-v2` is the same code reorganized into domain folders with short files. It is not deployed. Production commits are brought into it with `node scripts/sincronizar-modularizacion.mjs [--con-submodulos] [--commit]`: a git merge that also carries a change into the file where its code now lives and fixes import paths. Exit code 0 means merged (or already up to date), 1 means conflicts remain for a person, 2 means error. Fix changes in production first; never merge the modular branch into the deployment branch.

## Code Layout

- Files stay short: aim for 150-450 lines and do not let a source file pass 500. When one grows, split it by topic (one route group, one helper area) rather than adding to it.
- Domain folders: routes live in `src/routes/<domain>/` (admin, auth, bitacora, documents, github, pages, pilot, platform, projects, quiz, rag, tutor, workspace) and are all registered, in order, from `src/routes/register-routes.ts`. Services live in `src/services/<domain>/` (accounts, analytics, auth, bitacora, documents, exam, extensions, github, infra, kpi, pilot, policy, progress, queue, quiz, rag, shared, telemetry, tutor, vscode, workspace). New code goes into the folder of its domain; `shared/` is only for helpers used by several domains. Imports use relative paths with the `.js` ending.
- `src/db/database.ts`: `AppDatabase` is the last class of a chain in `src/db/repos/` (core -> auth -> auth-sign-in -> auth-sessions -> users -> users-access -> users-admin -> users-import (course members) -> policy -> rag-lots -> rag-sources -> rag-sources-write -> github -> github-tokens -> workspace -> pilot -> telemetry -> telemetry-behavior -> progress -> quiz -> analytics -> seed-accounts -> seed-demo-routes -> seed-rag-exam -> AppDatabase). Add a method to the class of its domain; callers keep using `db.method()`. A class may only call methods of its own class or of earlier ones. A `private` member used from another class of the chain must be `protected`. Row types and mappers live in `src/db/rows.ts`, `rag-rows.ts`, `quiz-rows.ts` and `telemetry-rows.ts`. `src/db/schema.ts` joins the statement lists of `schema-core.ts`, `schema-activity.ts` and `schema-pilot.ts`.
- Backend services that grew too big were split behind a facade: `src/services/github/github-app.ts` and `src/services/kpi/kpis.ts` only `export *` from their parts (github-api, github-codespaces, github-devcontainer-*; kpi-compute, kpi-manual-*), so importers are unchanged. Large route files register their routes through one function per group of routes (e.g. `registerGithubAppRoutes` calls `registerGithubOAuthRoutes`, `registerGithubAppInstallRoutes`...), each in its own file. Keep that order: Express matches routes in registration order.
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
