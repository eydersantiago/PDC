# Lista de cumplimiento de privacidad, ética y seguridad

> Documento generado desde `src/services/compliance-checklist.ts` con `npm run piloto:checklist`. No lo edites a mano.

| | |
|---|---|
| Jira | A13.4 · ADACEEN-112 (absorbe A5.6) |
| Meta | KPI T11: ítems cumplidos / ítems aplicables ≥ 80 %, con todos los críticos cumplidos |
| Verificación automática | `npm run piloto:verificar -- --url=<backend> --email=<docente> --password=<clave>` |
| Cuándo | Antes de la primera sesión del piloto; se repite si cambia la configuración |

Los ítems **críticos** detienen el piloto si fallan, aunque el total pase del 80 %. Los automáticos los revisa el script; los manuales se marcan con la evidencia indicada. Un ítem que no aplica (por ejemplo C13 si todos son mayores de edad) se marca «no aplica» y sale del denominador.

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

## Resultado

La lista tiene 23 ítems (11 automáticos y 12 manuales; 7 críticos). El resultado de cada verificación se guarda en `docs/evidencias/verificacion-cumplimiento-<fecha>.md` y el porcentaje final se registra en el plan del piloto como T11.

| Fecha | Ítems aplicables | Cumplidos | % | Críticos en falla | Responsable |
|---|---|---|---|---|---|
| | | | | | |
