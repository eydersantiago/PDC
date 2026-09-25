# Evidencias de despliegue y validación técnica

| | |
|---|---|
| Jira | A15.6 · ADACEEN-127 (absorbe notas de versión, checklist de release y evidencia técnica de A11.5) |
| Dónde van las evidencias | Anexos del documento final (A16.4). Las capturas se guardan fuera del repositorio; aquí queda el registro. |
| Relacionados | [Runbook](runbook.md), [notas de versión](../versiones/notas-de-version.md), [plan de pruebas](../pruebas/plan-de-pruebas.md) |

## 1. Evidencia automática (se genera con un comando)

| Evidencia | Comando | Resultado |
|---|---|---|
| Escenarios S1–S5 contra producción | `npm run demo:escenarios -- --url=$BACKEND --email=<estudiante de prueba> --password=<clave> --salida=docs/evidencias/demo-produccion-<fecha>.md` | Markdown con cada escenario, sus comprobaciones y un extracto de la respuesta |
| Escenarios en entorno controlado | `npm run demo:escenarios -- --salida=docs/evidencias/demo-escenarios.md` | Ídem, con base en memoria y salida de referencia ([actual](../evidencias/demo-escenarios.md)) |
| Latencia p50/p95 | `npm run medir:latencia -- --url=$BACKEND --n=30 --salida=docs/evidencias/latencia-<fecha>.md` | Tabla por canal y escenario |
| Estabilidad de eventos | `npm run estabilidad:eventos -- --simular --url=$BACKEND --email=<docente> --password=<clave> --salida=docs/evidencias/estabilidad-<fecha>.md` | Enviados, guardados, perdidos, duplicados |
| Pruebas automáticas | `npm run build && npm test` (PDC); `npm run compile && npm run lint && npm run test:unit` (vscode-ext-prod) | Salida de consola (captura o texto) |
| Paquetes | `npm run empaquetar:extension` | Zip de Chromium y de Firefox y `SHA256SUMS.txt` en `dist/extension/` |

La evidencia contra producción deja eventos en la base del piloto: el script
imprime la ventana de tiempo para excluirla del análisis.

## 2. Capturas y registros a recoger

| # | Evidencia | Cómo obtenerla |
|---|---|---|
| 1 | Configuración sana del backend | `curl -s $BACKEND/api/health` (texto) |
| 2 | Worker vivo y cuál | `curl -s $BACKEND/api/agent/backend` (texto) |
| 3 | GPU en la VM | `gcloud compute ssh <vm> --zone=us-central1-a --tunnel-through-iap --command='nvidia-smi; ollama ps'` |
| 4 | Log del worker procesando un trabajo | `sudo grep -a -E "queue.job.process.done|queue.result.send.done" /var/log/adaceen-worker.log | tail -5` |
| 5 | Despliegue del backend | GitHub → Actions → ejecución del flujo del commit desplegado (captura) |
| 6 | Overlay en Campus y en GitHub | Captura de una pista (S1) y de un mensaje controlado (S5b) |
| 7 | Editor por túnel | Captura de `vscode.dev/tunnel/ad-<login>/…` con la barra «GPU: …» |
| 8 | Aplicación de código controlada | Captura de la confirmación «¿Aplicar el cambio del tutor…?» y del bloqueo por cupo |
| 9 | Mini-quiz | Captura de «Quiz y seguimiento» tras aceptar un cambio |
| 10 | Modo degradado | Captura con la GPU apagada: mensaje controlado y «GPU: sin worker activo» |
| 11 | Calidad de la telemetría | `GET $BACKEND/api/telemetry/quality` (docente) tras una sesión de prueba |
| 12 | Firefox | Captura de la extensión cargada en Firefox y del overlay funcionando |
| 13 | Monitor de la sesión | `exportes/monitor-<fecha>.jsonl` de `npm run piloto:monitor` (una línea por lectura) |
| 14 | Alertas configuradas | `az monitor metrics alert list --resource-group <grupo> --output table` (texto) |
| 15 | Relay de la VM de editores | `GET /api/health` → `workspace_agent_online: true` y la línea «conectado al relay» de `journalctl -u adaceen-workspaces-agent` |

Antes de guardar una captura, tapa correos, tokens, el código de dispositivo de
GitHub y cualquier `sessionId`.

## 3. Checklist de release

- [ ] `npm run build` y `npm test` en PDC sin errores.
- [ ] `npm run compile`, `npm run lint` y `npm run test:unit` en vscode-ext-prod sin errores.
- [ ] `node --check` sobre los archivos cambiados de `browser-ext-prod`.
- [ ] Versión subida: `browser-ext-prod/manifest.json` (`version` y `version_name`),
  `vscode-ext-prod/package.json` y su `CHANGELOG.md`.
- [ ] Notas de versión actualizadas ([notas-de-version.md](../versiones/notas-de-version.md)).
- [ ] Paquetes generados (`npm run empaquetar:extension`) y `.vsix` (`npx @vscode/vsce package` en vscode-ext-prod); sumas SHA-256 anotadas.
- [ ] Submódulo `vscode-ext-prod` con su commit empujado **antes** del commit de PDC que actualiza el puntero.
- [ ] Variables nuevas configuradas en el App Service (ver `.env.example`).
- [ ] Prueba de humo contra producción en verde tras el despliegue.
- [ ] Alertas de Azure Monitor creadas o actualizadas (`deploy/azure/crear-alertas.sh`) y flujo `salud-produccion.yml` activo en la rama por defecto.
- [ ] `npm run piloto:verificar -- --url=<backend>` sin críticos automáticos en falla (guardar la salida con `--salida=docs/evidencias/verificacion-cumplimiento-<fecha>.md`).
- [ ] `.vsix` nuevo copiado a la VM de editores (`/opt/adaceen/adaceen.vsix`) si no se usa el Marketplace.

## 4. Registro de despliegues

| Fecha | Commit del backend | Extensión navegador | VSIX | GPU usada | Prueba de humo | Evidencia (enlace o archivo) | Observaciones |
|---|---|---|---|---|---|---|---|
| | | | | | | | |
| | | | | | | | |

## 5. Validación técnica

La validación técnica del despliegue se da por cumplida cuando, en la misma
fecha y con la versión anotada en el registro:

1. La prueba de humo contra producción pasa todas sus comprobaciones.
2. `/api/agent/health` responde 200 con la GPU encendida y 503 con ella apagada
   (y el tutor responde degradado en segundos).
3. Las capturas 6 a 15 están tomadas.
4. La calidad de la telemetría de la sesión de prueba no muestra eventos perdidos
   ni duplicados del servidor.
