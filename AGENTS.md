# AGENTS.md

Guidance for coding agents working in this repository.

## Repository Shape

- The active application repo is `agente-proxy-azure`.
- The parent workspace `/Users/EyderSS/repos/PDC` also contains exported browser-extension artifacts, so do not assume the parent folder is the git root.
- `vscode-ext-prod` is a git submodule. Commit and push changes inside that submodule first, then commit the updated submodule pointer in this repo.
- The Azure deployment branch for this repo is `feature/azure-config-observability`.

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
```

The lint command may report existing style warnings, but it should not report errors.

## Browser Extension Artifacts

There are three browser-extension load paths to keep aligned when changing `browser-ext-prod`:

- `agente-proxy-azure/browser-ext-prod`
- `/Users/EyderSS/repos/PDC/browser-ext-prod`
- `/Users/EyderSS/repos/PDC/browser-ext-prod.zip`

After changing the repo copy, sync the standalone folder and rebuild the ZIP:

```bash
cp -R browser-ext-prod/* ../browser-ext-prod/
cd ..
rm -f browser-ext-prod.zip
zip -qr browser-ext-prod.zip browser-ext-prod
```

Then confirm the two folders match:

```bash
diff -qr agente-proxy-azure/browser-ext-prod browser-ext-prod
```

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
