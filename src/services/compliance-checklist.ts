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
    "| Verificación automática | `npm run piloto:verificar -- --url=<backend> --email=<docente> --password=<clave>` |",
    "| Cuándo | Antes de la primera sesión del piloto; se repite si cambia la configuración |",
    "",
    "Los ítems **críticos** detienen el piloto si fallan, aunque el total pase del 80 %. Los automáticos los revisa el script; los manuales se marcan con la evidencia indicada. Un ítem que no aplica (por ejemplo C13 si todos son mayores de edad) se marca «no aplica» y sale del denominador.",
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
    `La lista tiene ${total} ítems (${automatic} automáticos y ${total - automatic} manuales; ${COMPLIANCE_ITEMS.filter((item) => item.critical).length} críticos). El resultado de cada verificación se guarda en \`docs/evidencias/verificacion-cumplimiento-<fecha>.md\` y el porcentaje final se registra en el plan del piloto como T11.`,
    "",
    "| Fecha | Ítems aplicables | Cumplidos | % | Críticos en falla | Responsable |",
    "|---|---|---|---|---|---|",
    "| | | | | | |",
    "",
  );
  return lines.join("\n");
}
