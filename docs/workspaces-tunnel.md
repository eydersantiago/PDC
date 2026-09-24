# Entornos de edicion con VS Code Tunnels (plan B a Codespaces)

Rama: `feat/workspace-tunnel`. Scripts en `deploy/gcp/workspaces/`.

## Por que

La creacion de un Codespace tarda entre 20 y 50 min por el host de GitHub
(descarga de imagen a ~5 MB/s con paradas; ver el log del 20-09). Cambiar de
region no ayudo. El piloto no puede depender de eso.

Codespaces hace tres cosas por el estudiante: identidad (GitHub), un VS Code
en el navegador con la extension, y el repo clonado. Este plan las sustituye
con una VM en Google Cloud y Dev Tunnels; Azure, Service Bus, la GPU y el
GitHub App no cambian.

## Lo que se verifico en la documentacion antes de escribir nada

| Pregunta | Respuesta | Fuente |
|---|---|---|
| Quien puede abrir un tunel | Solo la misma cuenta de GitHub/Microsoft que lo registro. No hay ACL ni compartir. | docs de VS Code |
| Tuneles por cuenta | 10. Con uno por estudiante, registrado en SU cuenta, no se toca el limite. | docs de VS Code |
| Ancho de banda | "hay limites", no publicados. Riesgo a medir en el spike. | docs de VS Code |
| `code tunnel user login --access-token` con un token cualquiera de GitHub | **401 del API de Dev Tunnels**: solo acepta tokens de la app OAuth de VS Code. | microsoft/vscode#310726 |
| Login sin interaccion | No documentado; `--refresh-token` existe pero no hay forma publica de obtenerlo. | vscode-remote-release#10615 |
| Preinstalar extensiones en el servidor | `code tunnel --install-extension <id>`, Marketplace real. | CLI |

**Consecuencia para el diseño:** PDC no puede registrar el tunel "a nombre
del estudiante" con el token OAuth que ya guarda. Lo que si puede hacer es
lanzar el login por codigo de dispositivo en la VM y mostrarle al estudiante,
en el overlay de la extension de navegador, "abre github.com/login/device y
escribe XXXX-XXXX". Un clic y un codigo, una sola vez; el CLI guarda la sesion
en la VM. El spike prueba el token de PDC de todas formas, para tener la
evidencia y no la suposicion.

## Flujo objetivo

```
estudiante en github.com  --"Preparar entorno"-->  PDC
PDC: valida token con GitHub /user, comprueba que el login esta en la lista
     del piloto, llama al agente de la VM
VM:  nuevo-tunel.sh <login> <repo>  ->  usuario ws-<login>, clon, login por
     codigo de dispositivo (codigo devuelto a PDC), servicio adaceen-tunnel@
overlay: muestra el codigo; cuando el tunel esta arriba, boton
     "Abrir editor" -> https://vscode.dev/tunnel/adaceen-<login>/...
```

Codespaces queda como respaldo con una variable de entorno
(`ADACEEN_WORKSPACE_PROVIDER=codespaces|tunnel`); no se borra nada.

## Fases

1. **Spike a mano** (esta rama, hoy): `create-ws-vm.sh` + `spike-tunnel.sh`.
   Sale con tres numeros y una respuesta a la pregunta del token.
2. **Agente en la VM**: un HTTP minimo (Node, mismo repo) que exponga
   `POST /workspaces` (login, repo) -> `{deviceCode, verificationUrl}` y
   `GET /workspaces/:login` -> `{state, url}`. Autenticado con un secreto en
   metadata, escuchando solo en la IP interna; PDC llega por Cloud NAT o IAP.
3. **PDC**: `prepareWorkspaceForTarget` junto a `prepareCodespaceForTarget`,
   misma firma de salida; la extension de navegador solo aprende a mostrar
   el codigo de dispositivo.
4. **Extension de VS Code**: `remoteName === 'tunnel'` se trata como
   Codespaces para el `baseUrl` por defecto. (O nada: los ajustes de maquina
   ya lo fijan; decidir tras el spike.)

## Contrato backend <-> extension de navegador (fase 2 y 3)

La extension de navegador ya habla este contrato (`services/workspace.service.js`);
el backend lo implementa en la fase 2/3. Mientras la ruta no exista (404), la
extension asume `codespaces` y no cambia nada.

```
GET  /api/workspaces/provider
     -> { ok, provider: "tunnel" | "codespaces" }

POST /api/workspaces/prepare        { repoFullName, force? }
GET  /api/workspaces/status?repoFullName=...
     -> { ok, provider: "tunnel",
          status: "ready" | "device_code" | "pending" | "error",
          workspace:  { login, tunnelName, webUrl, repoFullName },
          deviceCode?: { userCode, verificationUrl, expiresAt },
          message?: string }
```

Semantica:
- `prepare` es idempotente: si el tunel de ese login ya existe y esta
  arriba, responde `ready` de una vez. `force` rehace el clon.
- `device_code` aparece solo la primera vez por estudiante (o si la sesion
  del CLI se perdio). La extension muestra el codigo, lo copia al
  portapapeles si puede, y sigue consultando `status` cada 3 s hasta 12 min.
- `webUrl` es `https://vscode.dev/tunnel/<tunnelName>/home/ws-<login>/proyecto`.
- El backend saca `login` del token OAuth del estudiante (`/user`), valida
  que este en la lista del piloto y llama al agente de la VM, que ejecuta
  `nuevo-tunel.sh` y captura el codigo de dispositivo de su salida.
- Con el proveedor `tunnel` la extension no exige el scope `codespace`:
  basta la cuenta conectada.

## Costo con los 300 USD de credito

| Recurso | Precio aprox. | Piloto (8 h/dia, 20 dias) |
|---|---|---|
| adaceen-ws e2-standard-4 | 0,134 USD/h | ~21 USD |
| disco 60 GB pd-balanced | ~6 USD/mes | 6 USD |
| adaceen-worker g2-standard-8 + L4 Spot | ~0,30-0,35 USD/h | ~50 USD (solo en sesiones) |
| Dev Tunnels / vscode.dev | 0 | 0 |

Sobra credito para duplicar la VM de editores si una sesion tiene mas de
~15 estudiantes activos a la vez (Java + language server ≈ 1 GB por persona).

## Spike: resultados

_(rellenar al correrlo)_

- Token OAuth de PDC acepta login del tunel: SI / NO
- Segundos hasta servicio arriba:
- Segundos hasta ver archivos en vscode.dev:
- Barra de estado mostro "GPU: Google Cloud - L4": SI / NO
- Observaciones (latencia de tecleo, cortes):
