# Verificación de cumplimiento: ejemplo contra un backend local

| | |
|---|---|
| Jira | A13.4 · ADACEEN-112 |
| Qué es | La salida de `npm run piloto:verificar` contra un backend local con la base en memoria (`npm run dev:local`), el 2026-09-25, en la rama `claude/serene-heisenberg-0te9s9` |
| Qué no es | La verificación de producción: esa la corre el dueño contra Azure (sección 2) y se guarda como `docs/evidencias/verificacion-cumplimiento-<fecha>.md` |
| Lista | [Lista de cumplimiento](../piloto/checklist-cumplimiento.md) (30 ítems: 13 automáticos y 17 manuales) |
| Resultado | 8 de 13 automáticos cumplen; código de salida 1 porque fallan C02 y C20, que son críticos. Es lo esperado en local (sección 1) |

Sirve para ver qué revisa cada ítem automático y cómo se ve la evidencia, en
especial los dos ítems nuevos del acceso simplificado: C24 (las sesiones de
VS Code vencen y «Salir» las revoca) y C25 (códigos de un solo uso guardados
como hash). No dice nada de producción.

## 1. Cómo se generó

En una terminal, el backend local en un puerto libre y sin `.env` (base en
memoria, sin sal ni token de latidos):

```bash
PORT=3917 ADACEEN_LISTEN_HOST=127.0.0.1 npm run dev:local
```

En otra, la verificación con la cuenta demo de estudiante (su clave está en el
código del repositorio; no se copia aquí):

```bash
npm run piloto:verificar -- --url=http://127.0.0.1:3917 --email=estudiante@adaceen.edu.co --password=<clave demo> --salida=<archivo>
```

La sección 3 es ese archivo tal cual, sin su título y con los títulos de área
un nivel más abajo. La línea «Comando» no muestra `--email` ni `--password`: el script no escribe
credenciales en la evidencia. Para regenerarlo (por ejemplo si la lista cambia;
`tests/services/compliance-checklist.test.ts` avisa si falta un ítem), se
repiten los dos comandos y se reemplaza la sección 3.

Qué falla en local y por qué:

| Ítem | En local | Por qué | En producción |
|---|---|---|---|
| C02 (crítico) | no cumple | Sin `TELEMETRY_SALT` | Cumple si el App Service tiene `TELEMETRY_SALT` (por verificar en la corrida del dueño) |
| C18 | no cumple | La URL es `http://127.0.0.1:3917` | Cumple: la URL de producción es `https://…azurewebsites.net` |
| C19 | no cumple | Sin `WORKER_HEARTBEAT_TOKEN` | Cumple si el App Service tiene `WORKER_HEARTBEAT_TOKEN` (por verificar) |
| C20 (crítico) | no cumple | La base en memoria crea las cuentas demo. La de administrador no aparece porque su inicio de sesión falla en la base en memoria por un límite de pg-mem (`lookups on joins`), no porque esté bloqueada | Cumple si ninguna cuenta demo entra (por verificar) |
| C21 | no cumple | `database_provider = memory-postgres` | Cumple si `/api/health` da `postgres` (por verificar) |
| C24 y C25 | cumple | El backend local es de esta rama | Solo cumplen **después de desplegar** esta rama. Producción (`feature/azure-config-observability`, commit `9f51643`) no tiene `POST /api/auth/editor/pairing-code`: hoy darían «no cumple» con el detalle «versión anterior al acceso simplificado» |

## 2. La verificación de producción (la corre el dueño)

Después del [despliegue](../operacion/despliegue.md) completo, y como paso P7.3
de la [prueba de inicio a fin](../piloto/prueba-inicio-a-fin.md), **con la
cuenta E1 (o E2) de la prueba, no con la del docente**:

```bash
npm run piloto:verificar -- --url=https://app-adaceen-api-eyder05232002.azurewebsites.net --email=<cuenta E1> --password=<clave de E1> --salida=docs/evidencias/verificacion-cumplimiento-<fecha>.md
```

- **P7.3 dice `--email=<docente>`: ahí va la cuenta E1.** Para C24 y C25 el
  script inicia sesión como navegador (cierra la sesión del navegador de esa
  cuenta), pide un código para VS Code, lo canjea dos veces (el segundo canje
  debe fallar), cierra esa sesión y comprueba que la sesión de VS Code deja de
  valer (esto desvincula todos los VS Code de esa cuenta). Con la cuenta del
  docente se cerraría su overlay y se desvincularía su VS Code. P7.3 va al final
  de la prueba: después solo quedan P7.4, que usa la cuenta del docente, y el
  cierre (P8). Si luego hace falta una captura con E1, basta volver a entrar en
  el overlay. Una cuenta de estudiante de prueba sin uso sirve igual.
- En PowerShell, la clave entre comillas simples: `'--password=<clave>'`.
- Sin `--email` ni `--password`, C24 queda «no verificado» y C25 se revisa solo
  en el código del repositorio.
- Si `/api/health` no responde (por ejemplo, Azure reiniciando tras el
  despliegue), los ítems del backend, C24 incluido, salen «no verificado» con
  el detalle «No se pudo leer <url>/api/health: el backend no respondió, no se
  intentó.». Espera a que `/api/health` responda y repite el comando.
- Código de salida 0: ningún ítem crítico automático falla. Un «no verificado»
  no cuenta como falla (con el backend caído el código también es 0): revisa
  que en la salida no quede ninguno. Los 17 manuales
  (incluidos C26 y C27 en la VM de editores y C28 a C30 en las Mac del
  laboratorio) se marcan con su evidencia en una copia de
  `data/piloto/plantillas/cumplimiento.csv` con la fecha en el nombre
  (`cumplimiento-AAAA-MM-DD.csv`; si en la carpeta hay varias, cuenta la de
  fecha más reciente con algún ítem marcado), junto con el estado de los
  automáticos que dio el script, y
  `npm run piloto:analisis -- --dataset=<dataset> --registros=<carpeta>` calcula
  T11 ([análisis de datos](../piloto/analisis-de-datos.md), sección 3.1).

## 3. Salida de `npm run piloto:verificar`

| | |
|---|---|
| Comando | `npm run piloto:verificar -- --url=http://127.0.0.1:3917` |
| Ítems automáticos | 8 de 13 cumplen |
| Críticos automáticos en falla | C02, C20 |
| Ítems manuales | 17 por marcar con su evidencia |

El KPI T11 (≥ 80 %) se calcula cuando los manuales estén marcados: ítems cumplidos / ítems aplicables, con todos los críticos cumplidos.

### Privacidad y datos

| ID | Ítem | Crítico | Estado | Detalle |
|---|---|---|---|---|
| C01 | Cada participante firmó el consentimiento informado vigente antes de su primera sesión. | Sí | manual | Consentimientos archivados (físicos o del formulario) y su conteo igual a «participantesConConsentimiento» del plan del piloto. |
| C02 | La telemetría seudonimiza al estudiante con HMAC-SHA256 y una sal secreta configurada en el servidor. | Sí | no cumple | telemetry_salt_configured = false |
| C03 | La telemetría no guarda textos de error, código, rutas ni correos: solo hashes y metadatos de una lista blanca. | Sí | cumple | Lista blanca de metadata con 35 claves, ninguna de texto libre; columnas de texto: ninguna (value_text recortado a 120 caracteres, sin texto libre de los clientes). |
| C04 | La exportación del dataset no tiene identificadores en claro (ni id de usuario, ni correo, ni nombre). | No | cumple | 35 columnas exportadas, ninguna es un identificador directo (el actor va como actor_anon_id). |
| C05 | La lista que une nombres con cohortes A y B solo la ve el docente en la aplicación y no se exporta. | No | manual | Revisar que dataset.csv y bloques.csv no tengan nombres; la vista del docente es la única con nombres. |
| C06 | La retención de la telemetría está definida y hay un procedimiento de purga. | No | cumple | scripts/purgar-telemetria.ts existe; .env.example documenta TELEMETRY_RETENTION_DAYS. |
| C07 | Un participante puede retirarse y pedir que se borren sus datos; el procedimiento está escrito. | No | manual | Consentimiento (sección de retiro) y plan de soporte (quién recibe la solicitud y en cuánto tiempo). |
| C08 | Solo el investigador y el director tienen acceso a la base del piloto y a las exportaciones. | No | manual | Roles del recurso en Azure y carpeta de exportaciones fuera de cualquier repositorio o carpeta compartida. |
| C09 | La extensión de navegador pide los permisos mínimos (sin tabs, sin localhost ni comodines amplios en producción). | No | cumple | permissions: activeTab, storage, scripting, identity; hosts amplios o locales: ninguno. |
| C10 | La política de privacidad está publicada y tiene versión. | No | cumple | /api/privacy-policy responde; version 2026-05-26. |
| C28 | En las Mac del laboratorio no quedan copias locales con secretos o con el trabajo de los estudiantes: el adaceen-mac.env copiado al Escritorio o a Descargas se borra al instalar, y los repositorios clonados en el equipo se borran al terminar el piloto. | No | manual | Al instalar cada Mac servidor, responder que sí cuando Instalar-servidor-ADACEEN.command ofrece borrar adaceen-mac.env (o borrarlo a mano y vaciar la Papelera). Al cierre del piloto, borrar en cada Mac las carpetas que clonó «Abrir en VS Code de este equipo». No aplica si el piloto no usa Mac del laboratorio. |
| C29 | En los equipos compartidos del laboratorio cada estudiante cierra su sesión al terminar: «Salir» en el overlay y, en VS Code, «Desconectar este equipo». | No | manual | Al cierre de cada sesión, el docente o el observador revisa que cada estudiante pulse «Salir» en el overlay y, con VS Code instalado, «ADACEEN: Conectar» → «Desconectar este equipo» (guía de instalación y uso, secciones 1.2 y 5.3). El protocolo del piloto todavía no trae ese paso de cierre (por agregar). C24 comprueba que «Salir» revoca también las sesiones de VS Code. No aplica si nadie trabaja en equipos compartidos. |

### Ética de la investigación

| ID | Ítem | Crítico | Estado | Detalle |
|---|---|---|---|---|
| C11 | La participación es voluntaria y no participar no afecta la nota del curso. | Sí | manual | Texto del consentimiento y guion de apertura del docente (protocolo, paso 1). |
| C12 | El bloque sin tutor no pone en desventaja a nadie: las actividades del piloto no son calificables o se califican igual para las dos cohortes. | Sí | manual | Protocolo del piloto (actividades) y confirmación escrita del docente. |
| C13 | Si hay participantes menores de 18 años, hay autorización del acudiente además de su asentimiento. | No | manual | Formato de autorización del acudiente archivado junto al consentimiento (no aplica si todos son mayores de edad). |
| C14 | El protocolo, los instrumentos y el consentimiento tienen el aval del director (y del comité de ética si la facultad lo exige). | No | manual | Acta o correo de aprobación (paquete de validación para el director). |
| C15 | Los estudiantes saben que el tutor es una inteligencia artificial que puede equivocarse y que no entrega soluciones completas. | No | manual | Consentimiento, guía de instalación y uso, y guion de apertura. |
| C16 | El tutor no entrega la solución completa: los guardarraíles pasan las pruebas de escenarios. | No | manual | npm run demo:escenarios contra producción con todas las comprobaciones correctas (evidencia de la sesión). |

### Seguridad

| ID | Ítem | Crítico | Estado | Detalle |
|---|---|---|---|---|
| C17 | Los secretos no están en el repositorio: .env no se versiona y las exportaciones están en .gitignore. | Sí | cumple | Archivos .env versionados: ninguno; .gitignore ignora .env y ignora exportes/. |
| C18 | El backend de producción solo se usa por HTTPS. | No | no cumple | URL del backend: http://127.0.0.1:3917 |
| C19 | El latido de los workers exige token. | No | no cumple | worker_heartbeat_configured = false |
| C20 | Las cuentas de demostración no entran en producción. | Sí | no cumple | Entran con la clave del repositorio: docente@adaceen.edu.co, estudiante@adaceen.edu.co |
| C21 | La base del piloto es PostgreSQL gestionada (no la base en memoria). | No | no cumple | database_provider = memory-postgres |
| C22 | Las VMs de GPU y de editores no tienen IP pública y se administran por IAP. | No | manual | gcloud compute instances describe (sin accessConfigs) y regla de firewall allow-iap-ssh. |
| C23 | El equipo conoce el plan de soporte y el de contingencia antes de la primera sesión. | No | manual | Ensayo (A13.6) con el simulacro de caída del worker. |
| C24 | Las sesiones de VS Code (tipo editor) vencen en 30 días como máximo y «Salir» en el navegador las revoca. | No | cumple | Sesión de VS Code de tipo editor: vence en 30,0 días (máximo 30). Tras «Salir» en el navegador, GET /api/auth/me con esa sesión responde HTTP 401 con x-adaceen-session: invalid. |
| C25 | Los códigos para vincular VS Code son de un solo uso y en la base solo se guarda su hash. | No | cumple | Primer canje: HTTP 200; segundo canje del mismo código: HTTP 404 (code_not_found). En el código: editor_pairing_codes tiene code_hash, user_id, created_at, expires_at, used_at, sin columna con el código; la ruta guarda el SHA-256 del código normalizado. |
| C26 | En la VM de editores, el archivo editor-session.json de cada estudiante tiene permisos 600 y es de su usuario ws-<login>. | No | manual | Después del primer «Preparar mi editor» real: sudo ls -l /home/ws-<login>/.adaceen/editor-session.json da -rw------- con dueño ws-<login>, y journalctl -u adaceen-workspaces-agent muestra «sesion del editor escrita» sin el id (despliegue, sección 4.5). |
| C27 | Ningún secreto llega al entorno del estudiante en la VM de editores: ni el token del agente ni el secreto del worker, y la metadata de la VM está bloqueada para los usuarios ws-*. | Sí | manual | En la VM (despliegue, sección 4.5): systemctl is-active adaceen-ws-metadata da active y sudo -u ws-<login> curl -s -m 3 -H "Metadata-Flavor: Google" http://169.254.169.254/ falla («bien: metadata bloqueada»). En la terminal de vscode.dev del estudiante, env no muestra AGENT_TOKEN, WORKSPACE_AGENT_TOKEN ni WORKER_SHARED_SECRET. |
| C30 | El worker de las Mac del laboratorio solo abre conexiones de salida (HTTPS 443) y Ollama escucha solo en 127.0.0.1; los nodos de un clúster de Mac solo van en una red aislada. | No | manual | En cada Mac: bash deploy/mac/worker-mac.sh estado, y revisar que ningún servicio de ADACEEN escuche fuera de 127.0.0.1 (comando exacto en macOS por verificar); con modo clúster, instalado con --red-aislada (Mac del laboratorio, secciones 1, 7 y 9). No aplica si el piloto no usa Mac como servidores. |
