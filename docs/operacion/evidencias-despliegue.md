# Evidencias de despliegue y validación técnica

| | |
|---|---|
| Jira | A15.6 · ADACEEN-127 (absorbe notas de versión, checklist de release y evidencia técnica de A11.5) |
| Dónde van las evidencias | Anexos del documento final (A16.4). Las capturas se guardan fuera del repositorio; aquí queda el registro. |
| Relacionados | [Despliegue a producción](despliegue.md), [runbook](runbook.md), [notas de versión](../versiones/notas-de-version.md), [plan de pruebas](../pruebas/plan-de-pruebas.md), [prueba de inicio a fin](../piloto/prueba-inicio-a-fin.md) |

## 1. Evidencia automática (se genera con un comando)

| Evidencia | Comando | Resultado |
|---|---|---|
| Foto del despliegue: salud, servidores del modelo, página de inicio, descargas y versiones | `npm run evidencias:despliegue -- --backend $BACKEND` (credenciales de docente opcionales, solo en el entorno o en `.env`: `ADACEEN_DOCENTE_EMAIL` y `ADACEEN_DOCENTE_PASSWORD`) | `exportes/evidencias-despliegue/<fecha UTC>/evidencias.md` y `evidencias.json`, sin secretos: `/api/health`, `/api/agent/backend` y `/api/agent/health`, `/empezar` y cada `/descargas/*` (código HTTP y tamaño), versiones publicadas frente a las del repositorio y, con credenciales o `--cumplimiento`, la verificación de cumplimiento (C24 queda «no verificado»: ver la lista de release). Sale con código 1 si algo falla ([monitoreo](monitoreo.md), sección 5) |
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
| 1 | Configuración sana del backend | `npm run evidencias:despliegue -- --backend $BACKEND`: sección 4 (`/api/health`) de su `evidencias.md` (a mano: `curl -s $BACKEND/api/health`) |
| 2 | Worker vivo y cuál | El mismo `evidencias.md`, sección 5 (servidores del modelo: `/api/agent/backend` y `/api/agent/health`; a mano: `curl -s $BACKEND/api/agent/backend`) |
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
| 14 | Alertas configuradas | `az monitor metrics alert list --resource-group rg-adaceen-azure --output table` (texto) |
| 15 | Relay de la VM de editores | `GET /api/health` → `workspace_agent_online: true` y la línea «conectado al relay» de `journalctl -u adaceen-workspaces-agent` |
| 16 | Página de inicio y descargas | El mismo `evidencias.md`, secciones 2 y 3: versiones publicadas en `/empezar` frente a las del repositorio y código HTTP y tamaño de `/descargas/adaceen-navegador.zip`, `adaceen.vsix`, `Preparar-Mac-ADACEEN.zip` y `Preparar-Mac-ADACEEN.command` (deben dar 200). Además, captura de `$BACKEND/empezar` |
| 17 | Sesión del editor escrita por la VM | `ls -l /home/ws-<login>/.adaceen/editor-session.json` (600, del estudiante) y la línea «sesion del editor escrita» del agente, sin el id ([despliegue](despliegue.md), comprobación de la VM de editores) |
| 18 | Prueba de inicio a fin con 2 cuentas | Copia llena de `data/piloto/plantillas/prueba-inicio-a-fin.csv`, capturas de la barra «ADACEEN: <nombre>» de cada cuenta y el registro del monitor ([prueba](../piloto/prueba-inicio-a-fin.md)) |

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
- [ ] La rama de producción es ancestro de la que se despliega (`git merge-base --is-ancestor`), el push es sin `--force` y el commit anterior quedó anotado ([despliegue](despliegue.md), antes de empezar).
- [ ] Backend primero; después la VM de editores (`startup-ws.sh` y `workspace-agent-token`) y las GPU (`deploy/gcp/actualizar-gpus.sh`) ([despliegue](despliegue.md), VM de editores y GPU).
- [ ] Variables nuevas configuradas en el App Service (ver `.env.example`).
- [ ] Prueba de humo contra producción en verde tras el despliegue.
- [ ] Alertas de Azure Monitor creadas o actualizadas (`deploy/azure/crear-alertas.sh`) y flujo `salud-produccion.yml` activo en la rama por defecto.
- [ ] `npm run evidencias:despliegue -- --backend <backend>` sin fallas (su carpeta es la evidencia 1, 2 y 16).
- [ ] `npm run piloto:verificar -- --url=<backend> --email=<cuenta de prueba> --password=<clave>` sin críticos automáticos en falla (guardar la salida con `--salida=docs/evidencias/verificacion-cumplimiento-<fecha>.md`). La cuenta es la de un estudiante de prueba (E1 o E2 de la [prueba de inicio a fin](../piloto/prueba-inicio-a-fin.md), paso P7.3), no la del docente: el script cierra su sesión del navegador y desvincula sus VS Code. Sin `--email` y `--password` de una cuenta de prueba, C24 queda «no verificado» y C25 se revisa solo en el código.
- [ ] VSIX nuevo en la VM de editores: `/var/log/adaceen-ws-startup.log` dice `--- VSIX adaceen <versión> instalado …` o `… ya instalado …`. Lo baja `instalar-vsix.sh` del commit del submódulo, así que el `.vsix` tiene que estar en ese commit (`git add -f`, porque `*.vsix` está en el `.gitignore` del submódulo).

## 4. Registro de despliegues

En la columna "Observaciones" anota el commit que había antes en producción (para el
rollback), la rama anterior de `adaceen-ws` y la de cada GPU. Para la tanda "acceso simplificado"
el commit anterior es `9f51643` ([despliegue](despliegue.md)).

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
3. Las capturas 6 a 18 están tomadas.
4. La calidad de la telemetría de la sesión de prueba no muestra eventos perdidos
   ni duplicados del servidor.
