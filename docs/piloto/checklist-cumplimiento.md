# Lista de cumplimiento de privacidad, ética y seguridad

> Documento generado desde `src/services/compliance-checklist.ts` con `npm run piloto:checklist`. No lo edites a mano.

| | |
|---|---|
| Jira | A13.4 · ADACEEN-112 (absorbe A5.6) |
| Meta | KPI T11: ítems cumplidos / ítems aplicables ≥ 80 %, con todos los críticos cumplidos |
| Verificación automática | `npm run piloto:verificar -- --url=<backend> --email=<cuenta de prueba> --password=<clave>` |
| Cuándo | Antes de la primera sesión del piloto; se repite si cambia la configuración |
| Registro para T11 | Copia de `data/piloto/plantillas/cumplimiento.csv` con la fecha en el nombre (`cumplimiento-AAAA-MM-DD.csv`) y el estado de cada ítem; `npm run piloto:analisis -- --dataset=<dataset> --registros=<carpeta>` calcula T11 con la copia de fecha más reciente que tenga algún ítem marcado |
| Ejemplo | [Verificación contra un backend local en memoria](../evidencias/verificacion-cumplimiento-ejemplo.md) |

Los ítems **críticos** detienen el piloto si fallan, aunque el total pase del 80 %. Los automáticos los revisa el script; los manuales se marcan con la evidencia indicada. Un ítem que no aplica (por ejemplo C13 si todos son mayores de edad, o C28 a C30 si el piloto no usa Mac del laboratorio) se marca «no aplica» y sale del denominador.

C24 y C25 necesitan `--email` y `--password`: el script inicia sesión como navegador, pide un código para VS Code, lo canjea, cierra esa sesión y comprueba que la de VS Code deja de valer. Eso cierra la sesión del navegador de esa cuenta y desvincula su VS Code, así que conviene una cuenta de estudiante de prueba (en la [prueba de inicio a fin](prueba-inicio-a-fin.md), paso P7.3, la cuenta E1, no la del docente). Sin esas opciones, C24 queda «no verificado» y C25 se revisa solo en el código.

## Privacidad y datos

| ID | Ítem | Crítico | Verificación | Cómo y evidencia | Base | Estado |
|---|---|---|---|---|---|---|
| C01 | Cada participante firmó el consentimiento informado vigente antes de su primera sesión. | Sí | Manual | Consentimientos archivados (físicos o del formulario) y su conteo igual a «participantesConConsentimiento» del plan del piloto. | Ley 1581 de 2012 (autorización previa); anteproyecto A5 y A13.3. | ☐ |
| C02 | La telemetría seudonimiza al estudiante con HMAC-SHA256 y una sal secreta configurada en el servidor. | Sí | Automática | GET /api/health → telemetry_salt_configured = true (npm run piloto:verificar -- --url=...). | Anteproyecto 8.3 (identificadores anonimizados); A4 y A7. | ☐ |
| C03 | La telemetría no guarda textos de error, código, rutas ni correos: solo hashes y metadatos de una lista blanca. | Sí | Automática | El diccionario de campos no tiene columnas de texto libre y la lista blanca de metadata no admite claves de texto (revisión del código por el script). | Anteproyecto 7.2 (contexto limitado) y A6.4. | ☐ |
| C04 | La exportación del dataset no tiene identificadores en claro (ni id de usuario, ni correo, ni nombre). | No | Automática | Las columnas de exportación salen del diccionario y ninguna es un identificador directo. | Anteproyecto A7.2. | ☐ |
| C05 | La lista que une nombres con cohortes A y B solo la ve el docente en la aplicación y no se exporta. | No | Manual | Revisar que dataset.csv y bloques.csv no tengan nombres; la vista del docente es la única con nombres. | Minimización (Ley 1581, principio de finalidad). | ☐ |
| C06 | La retención de la telemetría está definida y hay un procedimiento de purga. | No | Automática | GET /api/health → telemetry_retention_days; existe scripts/purgar-telemetria.ts. | Anteproyecto 8.3 (retención). | ☐ |
| C07 | Un participante puede retirarse y pedir que se borren sus datos; el procedimiento está escrito. | No | Manual | Consentimiento (sección de retiro) y plan de soporte (quién recibe la solicitud y en cuánto tiempo). | Ley 1581 de 2012 (derechos del titular). | ☐ |
| C08 | Solo el investigador y el director tienen acceso a la base del piloto y a las exportaciones. | No | Manual | Roles del recurso en Azure y carpeta de exportaciones fuera de cualquier repositorio o carpeta compartida. | Anteproyecto 8.3 (control de acceso). | ☐ |
| C09 | La extensión de navegador pide los permisos mínimos (sin tabs, sin localhost ni comodines amplios en producción). | No | Automática | Revisión de browser-ext-prod/manifest.json. | Minimización; revisión de permisos A12.7. | ☐ |
| C10 | La política de privacidad está publicada y tiene versión. | No | Automática | GET /api/privacy-policy responde y /api/health informa privacy_policy_version. | Ley 1581 de 2012 (deber de informar). | ☐ |
| C28 | En las Mac del laboratorio no quedan copias locales con secretos o con el trabajo de los estudiantes: el adaceen-mac.env copiado al Escritorio o a Descargas se borra al instalar, y los repositorios clonados en el equipo se borran al terminar el piloto. | No | Manual | Al instalar cada Mac servidor, responder que sí cuando Instalar-servidor-ADACEEN.command ofrece borrar adaceen-mac.env (o borrarlo a mano y vaciar la Papelera). Al cierre del piloto, borrar en cada Mac las carpetas que clonó «Abrir en VS Code de este equipo». No aplica si el piloto no usa Mac del laboratorio. | Minimización y retención (Ley 1581 de 2012); ruta de datos, tramo 2 (el repositorio queda en el equipo hasta que se borre la carpeta). | ☐ |
| C29 | En los equipos compartidos del laboratorio cada estudiante cierra su sesión al terminar: «Salir» en el overlay y, en VS Code, «Desconectar este equipo». | No | Manual | Al cierre de cada sesión, el docente o el observador revisa que cada estudiante pulse «Salir» en el overlay y, con VS Code instalado, «ADACEEN: Conectar» → «Desconectar este equipo» (guía de instalación y uso, secciones 1.2 y 5.3). El protocolo del piloto todavía no trae ese paso de cierre (por agregar). C24 comprueba que «Salir» revoca también las sesiones de VS Code. No aplica si nadie trabaja en equipos compartidos. | Equipos compartidos: el siguiente usuario no debe quedar identificado como el anterior (telemetría mal atribuida y acceso a su trabajo). | ☐ |

## Ética de la investigación

| ID | Ítem | Crítico | Verificación | Cómo y evidencia | Base | Estado |
|---|---|---|---|---|---|---|
| C11 | La participación es voluntaria y no participar no afecta la nota del curso. | Sí | Manual | Texto del consentimiento y guion de apertura del docente (protocolo, paso 1). | Voluntariedad (Resolución 8430 de 1993, investigación con riesgo mínimo). | ☐ |
| C12 | El bloque sin tutor no pone en desventaja a nadie: las actividades del piloto no son calificables o se califican igual para las dos cohortes. | Sí | Manual | Protocolo del piloto (actividades) y confirmación escrita del docente. | Justicia y no maleficencia en un diseño con condición de control. | ☐ |
| C13 | Si hay participantes menores de 18 años, hay autorización del acudiente además de su asentimiento. | No | Manual | Formato de autorización del acudiente archivado junto al consentimiento (no aplica si todos son mayores de edad). | Ley 1098 de 2006 y Resolución 8430 de 1993. | ☐ |
| C14 | El protocolo, los instrumentos y el consentimiento tienen el aval del director (y del comité de ética si la facultad lo exige). | No | Manual | Acta o correo de aprobación (paquete de validación para el director). | Anteproyecto A5.7 y A13. | ☐ |
| C15 | Los estudiantes saben que el tutor es una inteligencia artificial que puede equivocarse y que no entrega soluciones completas. | No | Manual | Consentimiento, guía de instalación y uso, y guion de apertura. | Transparencia en el uso de IA. | ☐ |
| C16 | El tutor no entrega la solución completa: los guardarraíles pasan las pruebas de escenarios. | No | Manual | npm run demo:escenarios contra producción con todas las comprobaciones correctas (evidencia de la sesión). | Anteproyecto A2 y 7.1. | ☐ |

## Seguridad

| ID | Ítem | Crítico | Verificación | Cómo y evidencia | Base | Estado |
|---|---|---|---|---|---|---|
| C17 | Los secretos no están en el repositorio: .env no se versiona y las exportaciones están en .gitignore. | Sí | Automática | git ls-files no lista .env y .gitignore incluye .env y exportes/. | Buenas prácticas (OWASP, gestión de secretos). | ☐ |
| C18 | El backend de producción solo se usa por HTTPS. | No | Automática | La URL del backend empieza por https:// (y el App Service fuerza HTTPS). | Protección de datos en tránsito. | ☐ |
| C19 | El latido de los workers exige token. | No | Automática | GET /api/health → worker_heartbeat_configured = true. | Operación segura del worker (A15.4). | ☐ |
| C20 | Las cuentas de demostración no entran en producción. | Sí | Automática | El script intenta entrar con las tres cuentas demo del código y todas deben fallar. | Credenciales conocidas públicamente en el repositorio. | ☐ |
| C21 | La base del piloto es PostgreSQL gestionada (no la base en memoria). | No | Automática | GET /api/health → database_provider = postgres. | Persistencia y respaldo de los datos del piloto. | ☐ |
| C22 | Las VMs de GPU y de editores no tienen IP pública y se administran por IAP. | No | Manual | gcloud compute instances describe (sin accessConfigs) y regla de firewall allow-iap-ssh. | Política vmExternalIpAccess de la organización. | ☐ |
| C23 | El equipo conoce el plan de soporte y el de contingencia antes de la primera sesión. | No | Manual | Ensayo (A13.6) con el simulacro de caída del worker. | Anteproyecto A13.5 y A15.5. | ☐ |
| C24 | Las sesiones de VS Code (tipo editor) vencen en 30 días como máximo y «Salir» en el navegador las revoca. | No | Automática | Con --email y --password de una cuenta de prueba, el script pide un código en POST /api/auth/editor/pairing-code, lo canjea en POST /api/auth/editor/claim, comprueba en GET /api/auth/me que la sesión es editor y vence en 30 días o menos, cierra la sesión del navegador (POST /api/auth/logout) y comprueba que la sesión de VS Code recibe 401 con x-adaceen-session: invalid. Cierra la sesión del navegador de esa cuenta y desvincula su VS Code. | Consentimiento (la sesión del editor vale 30 días o hasta cerrar sesión) y equipos compartidos del laboratorio; contrato del acceso simplificado, sección 1. | ☐ |
| C25 | Los códigos para vincular VS Code son de un solo uso y en la base solo se guarda su hash. | No | Automática | Código del repositorio: la tabla editor_pairing_codes guarda code_hash (SHA-256) y ninguna columna con el código. Contra el backend (con --email y --password): el segundo canje del mismo código responde 404 code_not_found. | Contrato del acceso simplificado, sección 2.1. | ☐ |
| C26 | En la VM de editores, el archivo editor-session.json de cada estudiante tiene permisos 600 y es de su usuario ws-<login>. | No | Manual | Después del primer «Preparar mi editor» real: sudo ls -l /home/ws-<login>/.adaceen/editor-session.json da -rw------- con dueño ws-<login>, y journalctl -u adaceen-workspaces-agent muestra «sesion del editor escrita» sin el id (despliegue, sección 4.5). | Contrato del acceso simplificado, sección 2.3; ruta de datos, tramo 9. | ☐ |
| C27 | Ningún secreto llega al entorno del estudiante en la VM de editores: ni el token del agente ni el secreto del worker, y la metadata de la VM está bloqueada para los usuarios ws-*. | Sí | Manual | En la VM (despliegue, sección 4.5): systemctl is-active adaceen-ws-metadata da active y sudo -u ws-<login> curl -s -m 3 -H "Metadata-Flavor: Google" http://169.254.169.254/ falla («bien: metadata bloqueada»). En la terminal de vscode.dev del estudiante, env no muestra AGENT_TOKEN, WORKSPACE_AGENT_TOKEN ni WORKER_SHARED_SECRET. | Un estudiante con el token del agente podría preparar o leer entornos de otros; gestión de secretos (OWASP). | ☐ |
| C30 | El worker de las Mac del laboratorio solo abre conexiones de salida (HTTPS 443) y Ollama escucha solo en 127.0.0.1; los nodos de un clúster de Mac solo van en una red aislada. | No | Manual | En cada Mac: bash deploy/mac/worker-mac.sh estado, y revisar que ningún servicio de ADACEEN escuche fuera de 127.0.0.1 (comando exacto en macOS por verificar); con modo clúster, instalado con --red-aislada (Mac del laboratorio, secciones 1, 7 y 9). No aplica si el piloto no usa Mac como servidores. | Sin puertos de entrada ni excepciones en el firewall de la universidad; ggml-rpc-server no tiene autenticación. | ☐ |

## Resultado

La lista tiene 30 ítems (13 automáticos y 17 manuales; 8 críticos). El resultado de cada verificación se guarda en `docs/evidencias/verificacion-cumplimiento-<fecha>.md`. El estado de todos los ítems se anota en una copia de `data/piloto/plantillas/cumplimiento.csv` (cumple, no cumple, no aplica o pendiente) y `npm run piloto:analisis -- --dataset=<dataset> --registros=<carpeta>` calcula T11 con los críticos obligatorios; si no se usa la plantilla, el porcentaje se registra a mano en el plan del piloto.

| Fecha | Ítems aplicables | Cumplidos | % | Críticos en falla | Responsable |
|---|---|---|---|---|---|
| | | | | | |
