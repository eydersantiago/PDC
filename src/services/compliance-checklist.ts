/**
 * Lista de cumplimiento de privacidad, ética y seguridad del piloto (A13.4,
 * absorbe A5.6). Es la fuente de verdad del documento
 * docs/piloto/checklist-cumplimiento.md (npm run piloto:checklist) y de
 * `npm run piloto:verificar`, que revisa solo los ítems automáticos.
 *
 * KPI T11: ítems cumplidos / ítems aplicables ≥ 80 %, y todos los críticos
 * cumplidos. Un ítem crítico en falla detiene el piloto aunque el total pase.
 */

export type ComplianceArea = "privacidad" | "etica" | "seguridad";

export type ComplianceItem = {
  id: string;
  area: ComplianceArea;
  item: string;
  critical: boolean;
  verification: "automatica" | "manual";
  /** Qué se revisa y dónde queda la evidencia. */
  how: string;
  /** De dónde sale la exigencia. */
  basis: string;
};

export const COMPLIANCE_AREA_LABEL: Record<ComplianceArea, string> = {
  privacidad: "Privacidad y datos",
  etica: "Ética de la investigación",
  seguridad: "Seguridad",
};

export const COMPLIANCE_ITEMS: ComplianceItem[] = [
  // --- Privacidad -------------------------------------------------------------
  {
    id: "C01",
    area: "privacidad",
    item: "Cada participante firmó el consentimiento informado vigente antes de su primera sesión.",
    critical: true,
    verification: "manual",
    how: "Consentimientos archivados (físicos o del formulario) y su conteo igual a «participantesConConsentimiento» del plan del piloto.",
    basis: "Ley 1581 de 2012 (autorización previa); anteproyecto A5 y A13.3.",
  },
  {
    id: "C02",
    area: "privacidad",
    item: "La telemetría seudonimiza al estudiante con HMAC-SHA256 y una sal secreta configurada en el servidor.",
    critical: true,
    verification: "automatica",
    how: "GET /api/health → telemetry_salt_configured = true (npm run piloto:verificar -- --url=...).",
    basis: "Anteproyecto 8.3 (identificadores anonimizados); A4 y A7.",
  },
  {
    id: "C03",
    area: "privacidad",
    item: "La telemetría no guarda textos de error, código, rutas ni correos: solo hashes y metadatos de una lista blanca.",
    critical: true,
    verification: "automatica",
    how: "El diccionario de campos no tiene columnas de texto libre y la lista blanca de metadata no admite claves de texto (revisión del código por el script).",
    basis: "Anteproyecto 7.2 (contexto limitado) y A6.4.",
  },
  {
    id: "C04",
    area: "privacidad",
    item: "La exportación del dataset no tiene identificadores en claro (ni id de usuario, ni correo, ni nombre).",
    critical: false,
    verification: "automatica",
    how: "Las columnas de exportación salen del diccionario y ninguna es un identificador directo.",
    basis: "Anteproyecto A7.2.",
  },
  {
    id: "C05",
    area: "privacidad",
    item: "La lista que une nombres con cohortes A y B solo la ve el docente en la aplicación y no se exporta.",
    critical: false,
    verification: "manual",
    how: "Revisar que dataset.csv y bloques.csv no tengan nombres; la vista del docente es la única con nombres.",
    basis: "Minimización (Ley 1581, principio de finalidad).",
  },
  {
    id: "C06",
    area: "privacidad",
    item: "La retención de la telemetría está definida y hay un procedimiento de purga.",
    critical: false,
    verification: "automatica",
    how: "GET /api/health → telemetry_retention_days; existe scripts/purgar-telemetria.ts.",
    basis: "Anteproyecto 8.3 (retención).",
  },
  {
    id: "C07",
    area: "privacidad",
    item: "Un participante puede retirarse y pedir que se borren sus datos; el procedimiento está escrito.",
    critical: false,
    verification: "manual",
    how: "Consentimiento (sección de retiro) y plan de soporte (quién recibe la solicitud y en cuánto tiempo).",
    basis: "Ley 1581 de 2012 (derechos del titular).",
  },
  {
    id: "C08",
    area: "privacidad",
    item: "Solo el investigador y el director tienen acceso a la base del piloto y a las exportaciones.",
    critical: false,
    verification: "manual",
    how: "Roles del recurso en Azure y carpeta de exportaciones fuera de cualquier repositorio o carpeta compartida.",
    basis: "Anteproyecto 8.3 (control de acceso).",
  },
  {
    id: "C09",
    area: "privacidad",
    item: "La extensión de navegador pide los permisos mínimos (sin tabs, sin localhost ni comodines amplios en producción).",
    critical: false,
    verification: "automatica",
    how: "Revisión de browser-ext-prod/manifest.json.",
    basis: "Minimización; revisión de permisos A12.7.",
  },
  {
    id: "C10",
    area: "privacidad",
    item: "La política de privacidad está publicada y tiene versión.",
    critical: false,
    verification: "automatica",
    how: "GET /api/privacy-policy responde y /api/health informa privacy_policy_version.",
    basis: "Ley 1581 de 2012 (deber de informar).",
  },
  // --- Ética --------------------------------------------------------------------
  {
    id: "C11",
    area: "etica",
    item: "La participación es voluntaria y no participar no afecta la nota del curso.",
    critical: true,
    verification: "manual",
    how: "Texto del consentimiento y guion de apertura del docente (protocolo, paso 1).",
    basis: "Voluntariedad (Resolución 8430 de 1993, investigación con riesgo mínimo).",
  },
  {
    id: "C12",
    area: "etica",
    item: "El bloque sin tutor no pone en desventaja a nadie: las actividades del piloto no son calificables o se califican igual para las dos cohortes.",
    critical: true,
    verification: "manual",
    how: "Protocolo del piloto (actividades) y confirmación escrita del docente.",
    basis: "Justicia y no maleficencia en un diseño con condición de control.",
  },
  {
    id: "C13",
    area: "etica",
    item: "Si hay participantes menores de 18 años, hay autorización del acudiente además de su asentimiento.",
    critical: false,
    verification: "manual",
    how: "Formato de autorización del acudiente archivado junto al consentimiento (no aplica si todos son mayores de edad).",
    basis: "Ley 1098 de 2006 y Resolución 8430 de 1993.",
  },
  {
    id: "C14",
    area: "etica",
    item: "El protocolo, los instrumentos y el consentimiento tienen el aval del director (y del comité de ética si la facultad lo exige).",
    critical: false,
    verification: "manual",
    how: "Acta o correo de aprobación (paquete de validación para el director).",
    basis: "Anteproyecto A5.7 y A13.",
  },
  {
    id: "C15",
    area: "etica",
    item: "Los estudiantes saben que el tutor es una inteligencia artificial que puede equivocarse y que no entrega soluciones completas.",
    critical: false,
    verification: "manual",
    how: "Consentimiento, guía de instalación y uso, y guion de apertura.",
    basis: "Transparencia en el uso de IA.",
  },
  {
    id: "C16",
    area: "etica",
    item: "El tutor no entrega la solución completa: los guardarraíles pasan las pruebas de escenarios.",
    critical: false,
    verification: "manual",
    how: "npm run demo:escenarios contra producción con todas las comprobaciones correctas (evidencia de la sesión).",
    basis: "Anteproyecto A2 y 7.1.",
  },
  // --- Seguridad ----------------------------------------------------------------
  {
    id: "C17",
    area: "seguridad",
    item: "Los secretos no están en el repositorio: .env no se versiona y las exportaciones están en .gitignore.",
    critical: true,
    verification: "automatica",
    how: "git ls-files no lista .env y .gitignore incluye .env y exportes/.",
    basis: "Buenas prácticas (OWASP, gestión de secretos).",
  },
  {
    id: "C18",
    area: "seguridad",
    item: "El backend de producción solo se usa por HTTPS.",
    critical: false,
    verification: "automatica",
    how: "La URL del backend empieza por https:// (y el App Service fuerza HTTPS).",
    basis: "Protección de datos en tránsito.",
  },
  {
    id: "C19",
    area: "seguridad",
    item: "El latido de los workers exige token.",
    critical: false,
    verification: "automatica",
    how: "GET /api/health → worker_heartbeat_configured = true.",
    basis: "Operación segura del worker (A15.4).",
  },
  {
    id: "C20",
    area: "seguridad",
    item: "Las cuentas de demostración no entran en producción.",
    critical: true,
    verification: "automatica",
    how: "El script intenta entrar con las tres cuentas demo del código y todas deben fallar.",
    basis: "Credenciales conocidas públicamente en el repositorio.",
  },
  {
    id: "C21",
    area: "seguridad",
    item: "La base del piloto es PostgreSQL gestionada (no la base en memoria).",
    critical: false,
    verification: "automatica",
    how: "GET /api/health → database_provider = postgres.",
    basis: "Persistencia y respaldo de los datos del piloto.",
  },
  {
    id: "C22",
    area: "seguridad",
    item: "Las VMs de GPU y de editores no tienen IP pública y se administran por IAP.",
    critical: false,
    verification: "manual",
    how: "gcloud compute instances describe (sin accessConfigs) y regla de firewall allow-iap-ssh.",
    basis: "Política vmExternalIpAccess de la organización.",
  },
  {
    id: "C23",
    area: "seguridad",
    item: "El equipo conoce el plan de soporte y el de contingencia antes de la primera sesión.",
    critical: false,
    verification: "manual",
    how: "Ensayo (A13.6) con el simulacro de caída del worker.",
    basis: "Anteproyecto A13.5 y A15.5.",
  },
  // --- Acceso simplificado (VS Code y VM de editores) y Mac del laboratorio ------
  {
    id: "C24",
    area: "seguridad",
    item: "Las sesiones de VS Code (tipo editor) vencen en 30 días como máximo y «Salir» en el navegador las revoca.",
    critical: false,
    verification: "automatica",
    how: "Con --email y --password de una cuenta de prueba, el script pide un código en POST /api/auth/editor/pairing-code, lo canjea en POST /api/auth/editor/claim, comprueba en GET /api/auth/me que la sesión es editor y vence en 30 días o menos, cierra la sesión del navegador (POST /api/auth/logout) y comprueba que la sesión de VS Code recibe 401 con x-adaceen-session: invalid. Cierra la sesión del navegador de esa cuenta y desvincula su VS Code.",
    basis: "Consentimiento (la sesión del editor vale 30 días o hasta cerrar sesión) y equipos compartidos del laboratorio; contrato del acceso simplificado, sección 1.",
  },
  {
    id: "C25",
    area: "seguridad",
    item: "Los códigos para vincular VS Code son de un solo uso y en la base solo se guarda su hash.",
    critical: false,
    verification: "automatica",
    how: "Código del repositorio: la tabla editor_pairing_codes guarda code_hash (SHA-256) y ninguna columna con el código. Contra el backend (con --email y --password): el segundo canje del mismo código responde 404 code_not_found.",
    basis: "Contrato del acceso simplificado, sección 2.1.",
  },
  {
    id: "C26",
    area: "seguridad",
    item: "En la VM de editores, el archivo editor-session.json de cada estudiante tiene permisos 600 y es de su usuario ws-<login>.",
    critical: false,
    verification: "manual",
    how: "Después del primer «Preparar mi editor» real: sudo ls -l /home/ws-<login>/.adaceen/editor-session.json da -rw------- con dueño ws-<login>, y journalctl -u adaceen-workspaces-agent muestra «sesion del editor escrita» sin el id (despliegue, sección 4.5).",
    basis: "Contrato del acceso simplificado, sección 2.3; ruta de datos, tramo 9.",
  },
  {
    id: "C27",
    area: "seguridad",
    item: "Ningún secreto llega al entorno del estudiante en la VM de editores: ni el token del agente ni el secreto del worker, y la metadata de la VM está bloqueada para los usuarios ws-*.",
    critical: true,
    verification: "manual",
    how: "En la VM (despliegue, sección 4.5): systemctl is-active adaceen-ws-metadata da active y sudo -u ws-<login> curl -s -m 3 -H \"Metadata-Flavor: Google\" http://169.254.169.254/ falla («bien: metadata bloqueada»). En la terminal de vscode.dev del estudiante, env no muestra AGENT_TOKEN, WORKSPACE_AGENT_TOKEN ni WORKER_SHARED_SECRET.",
    basis: "Un estudiante con el token del agente podría preparar o leer entornos de otros; gestión de secretos (OWASP).",
  },
  {
    id: "C28",
    area: "privacidad",
    item: "En las Mac del laboratorio no quedan copias locales con secretos o con el trabajo de los estudiantes: el adaceen-mac.env copiado al Escritorio o a Descargas se borra al instalar, y los repositorios clonados en el equipo se borran al terminar el piloto.",
    critical: false,
    verification: "manual",
    how: "Al instalar cada Mac servidor, responder que sí cuando Instalar-servidor-ADACEEN.command ofrece borrar adaceen-mac.env (o borrarlo a mano y vaciar la Papelera). Al cierre del piloto, borrar en cada Mac las carpetas que clonó «Abrir en VS Code de este equipo». No aplica si el piloto no usa Mac del laboratorio.",
    basis: "Minimización y retención (Ley 1581 de 2012); ruta de datos, tramo 2 (el repositorio queda en el equipo hasta que se borre la carpeta).",
  },
  {
    id: "C29",
    area: "privacidad",
    item: "En los equipos compartidos del laboratorio cada estudiante cierra su sesión al terminar: «Salir» en el overlay y, en VS Code, «Desconectar este equipo».",
    critical: false,
    verification: "manual",
    how: "Al cierre de cada sesión, el docente o el observador revisa que cada estudiante pulse «Salir» en el overlay y, con VS Code instalado, «ADACEEN: Conectar» → «Desconectar este equipo» (guía de instalación y uso, secciones 1.2 y 5.3). El paso de cierre está en el protocolo del piloto, sección 6 («Cierre en los equipos compartidos»). C24 comprueba que «Salir» revoca también las sesiones de VS Code. No aplica si nadie trabaja en equipos compartidos.",
    basis: "Equipos compartidos: el siguiente usuario no debe quedar identificado como el anterior (telemetría mal atribuida y acceso a su trabajo).",
  },
  {
    id: "C30",
    area: "seguridad",
    item: "El worker de las Mac del laboratorio solo abre conexiones de salida (HTTPS 443) y Ollama escucha solo en 127.0.0.1; los nodos de un clúster de Mac solo van en una red aislada.",
    critical: false,
    verification: "manual",
    how: "En cada Mac: bash deploy/mac/worker-mac.sh estado, y revisar que ningún servicio de ADACEEN escuche fuera de 127.0.0.1 (comando exacto en macOS por verificar); con modo clúster, instalado con --red-aislada (Mac del laboratorio, secciones 1, 7 y 9). No aplica si el piloto no usa Mac como servidores.",
    basis: "Sin puertos de entrada ni excepciones en el firewall de la universidad; ggml-rpc-server no tiene autenticación.",
  },
];

export type ComplianceCheckResult = {
  id: string;
  status: "cumple" | "no cumple" | "no verificado" | "manual";
  detail: string;
};

export function complianceScore(results: Array<{ id: string; status: string }>) {
  const byId = new Map(results.map((result) => [result.id, result.status]));
  const applicable = COMPLIANCE_ITEMS.filter((item) => byId.get(item.id) !== "no aplica");
  const met = applicable.filter((item) => byId.get(item.id) === "cumple").length;
  const criticalFailed = COMPLIANCE_ITEMS.filter((item) => item.critical && byId.get(item.id) === "no cumple").map((item) => item.id);
  return {
    applicable: applicable.length,
    met,
    pct: applicable.length ? (met / applicable.length) * 100 : 0,
    criticalFailed,
  };
}

export function renderComplianceChecklistMarkdown() {
  const lines = [
    "# Lista de cumplimiento de privacidad, ética y seguridad",
    "",
    "> Documento generado desde `src/services/compliance-checklist.ts` con `npm run piloto:checklist`. No lo edites a mano.",
    "",
    "| | |",
    "|---|---|",
    "| Jira | A13.4 · ADACEEN-112 (absorbe A5.6) |",
    "| Meta | KPI T11: ítems cumplidos / ítems aplicables ≥ 80 %, con todos los críticos cumplidos |",
    "| Verificación automática | `npm run piloto:verificar -- --url=<backend> --email=<cuenta de prueba> --password=<clave>` |",
    "| Cuándo | Antes de la primera sesión del piloto; se repite si cambia la configuración |",
    "| Registro para T11 | Copia de `data/piloto/plantillas/cumplimiento.csv` con la fecha en el nombre (`cumplimiento-AAAA-MM-DD.csv`) y el estado de cada ítem; `npm run piloto:analisis -- --dataset=<dataset> --registros=<carpeta>` calcula T11 con la copia de fecha más reciente que tenga algún ítem marcado |",
    "| Ejemplo | [Verificación contra un backend local en memoria](../evidencias/verificacion-cumplimiento-ejemplo.md) |",
    "",
    "Los ítems **críticos** detienen el piloto si fallan, aunque el total pase del 80 %. Los automáticos los revisa el script; los manuales se marcan con la evidencia indicada. Un ítem que no aplica (por ejemplo C13 si todos son mayores de edad, o C28 a C30 si el piloto no usa Mac del laboratorio) se marca «no aplica» y sale del denominador.",
    "",
    "C24 y C25 necesitan `--email` y `--password`: el script inicia sesión como navegador, pide un código para VS Code, lo canjea, cierra esa sesión y comprueba que la de VS Code deja de valer. Eso cierra la sesión del navegador de esa cuenta y desvincula su VS Code, así que conviene una cuenta de estudiante de prueba (en la [prueba de inicio a fin](prueba-inicio-a-fin.md), paso P7.3, la cuenta E1, no la del docente). Sin esas opciones, C24 queda «no verificado» y C25 se revisa solo en el código.",
    "",
  ];
  for (const area of ["privacidad", "etica", "seguridad"] as ComplianceArea[]) {
    lines.push(`## ${COMPLIANCE_AREA_LABEL[area]}`, "", "| ID | Ítem | Crítico | Verificación | Cómo y evidencia | Base | Estado |", "|---|---|---|---|---|---|---|");
    for (const item of COMPLIANCE_ITEMS.filter((entry) => entry.area === area)) {
      lines.push(`| ${item.id} | ${item.item} | ${item.critical ? "Sí" : "No"} | ${item.verification === "automatica" ? "Automática" : "Manual"} | ${item.how} | ${item.basis} | ☐ |`);
    }
    lines.push("");
  }
  const total = COMPLIANCE_ITEMS.length;
  const automatic = COMPLIANCE_ITEMS.filter((item) => item.verification === "automatica").length;
  lines.push(
    "## Resultado",
    "",
    `La lista tiene ${total} ítems (${automatic} automáticos y ${total - automatic} manuales; ${COMPLIANCE_ITEMS.filter((item) => item.critical).length} críticos). El resultado de cada verificación se guarda en \`docs/evidencias/verificacion-cumplimiento-<fecha>.md\`. El estado de todos los ítems se anota en una copia de \`data/piloto/plantillas/cumplimiento.csv\` (cumple, no cumple, no aplica o pendiente) y \`npm run piloto:analisis -- --dataset=<dataset> --registros=<carpeta>\` calcula T11 con los críticos obligatorios; si no se usa la plantilla, el porcentaje se registra a mano en el plan del piloto.`,
    "",
    "| Fecha | Ítems aplicables | Cumplidos | % | Críticos en falla | Responsable |",
    "|---|---|---|---|---|---|",
    "| | | | | | |",
    "",
  );
  return lines.join("\n");
}
