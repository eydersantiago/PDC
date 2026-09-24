import { TELEMETRY_SCHEMA_VERSION } from "./telemetry.js";
import {
  EVENT_CATALOG,
  FIELD_DICTIONARY,
  LEGACY_TABLES,
  QUALITY_RULES,
  TELEMETRY_CATEGORIES,
} from "./telemetry-catalog.js";

/**
 * Genera docs/telemetria/diccionario-eventos.md (A4.1, A4.3, A4.4) desde el
 * catalogo, que es la fuente de verdad. La prueba
 * tests/scripts/telemetry-dictionary.test.ts falla si el documento quedo
 * desactualizado: se regenera con `npm run telemetria:diccionario`.
 */

function cell(value: unknown) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderTelemetryDictionaryMarkdown() {
  const lines: string[] = [
    "# Diccionario de eventos de telemetria (v" + TELEMETRY_SCHEMA_VERSION + ")",
    "",
    "> Documento generado desde `src/services/telemetry-catalog.ts` con `npm run telemetria:diccionario`. No lo edites a mano: cambia el catalogo y regeneralo.",
    "",
    "La telemetria del piloto vive en la tabla `telemetry_events`: un solo formato para el overlay del navegador, la extension de VS Code y el backend. Cada fila es un evento con el actor seudonimizado (HMAC-SHA256 con `TELEMETRY_SALT`), sin textos de error, codigo, rutas ni correos. Los clientes mandan los eventos a `POST /api/behavior/events` con sesion (`x-session-id`) o, sin sesion, con `x-adaceen-client-id`; el backend registra sus propias decisiones (`tutor_decision`, `code_application_checked`).",
    "",
    "## Como se enlazan los eventos",
    "",
    "- `decision_id` une cada respuesta del tutor con lo que paso despues: `tutor_decision` (backend) -> `tutor_response_shown` / `vscode_suggestion_shown` -> aceptada, rechazada, ignorada o aplicada.",
    "- `client_session_id` + `seq` ordenan los eventos de un cliente; un hueco en `seq` es un evento perdido (regla I1).",
    "- `actor_anon_id` agrupa por estudiante sin saber quien es; `teacher_anon_id` agrupa por grupo del docente.",
    "- `exercise_hash` agrupa por actividad o archivo sin guardar su nombre.",
    "",
    "## Categorias",
    "",
    TELEMETRY_CATEGORIES.map((category) => `\`${category}\``).join(", "),
    "",
    "## Catalogo de eventos",
    "",
    "| Evento | Categoria | Origen | Actor | Cuando ocurre | Para que sirve | Campos propios | KPI | Requiere decision |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const entry of EVENT_CATALOG) {
    lines.push(
      `| \`${entry.eventType}\` | ${entry.category} | ${entry.sources.join(", ")} | ${cell(entry.actor)} | ${cell(entry.when)} | ${cell(entry.purpose)} | ${entry.fields.map((field) => `\`${field}\``).join(", ") || "-"} | ${cell(entry.kpis.join(", "))} | ${entry.requiresDecision ? "si" : "no"} |`,
    );
  }

  lines.push(
    "",
    "## Campos de `telemetry_events`",
    "",
    "| Campo | Tipo | Descripcion | Sensibilidad | Minimizacion |",
    "|---|---|---|---|---|",
  );
  for (const field of FIELD_DICTIONARY) {
    lines.push(`| \`${field.field}\` | ${cell(field.type)} | ${cell(field.description)} | ${cell(field.sensitivity)} | ${cell(field.minimization)} |`);
  }

  lines.push(
    "",
    "## Reglas de calidad",
    "",
    "Las reglas Q se aplican a cada evento al recibirlo: Q1 y Q2 rechazan la peticion; las demas guardan el evento con su aviso en `quality_flags`. Las reglas I revisan el conjunto (`GET /api/telemetry/quality`, `npm run estabilidad:eventos`).",
    "",
    "| Regla | Alcance | Severidad | Accion | Descripcion |",
    "|---|---|---|---|---|",
  );
  for (const rule of QUALITY_RULES) {
    lines.push(`| \`${rule.code}\` | ${rule.scope} | ${rule.severity} | ${rule.action} | ${cell(rule.description)} |`);
  }

  lines.push(
    "",
    "## Tablas anteriores",
    "",
    "| Tabla | Que guarda | Sensibilidad | Se exporta |",
    "|---|---|---|---|",
  );
  for (const table of LEGACY_TABLES) {
    lines.push(`| \`${table.table}\` | ${cell(table.description)} | ${cell(table.sensitivity)} | ${cell(table.exported)} |`);
  }

  lines.push(
    "",
    "## Exportacion y retencion",
    "",
    "- `npm run telemetria:exportar` escribe el conjunto en JSONL o CSV con estas columnas (y, con `--con-quices`, los intentos del mini quiz con el mismo `actor_anon_id`). La carpeta `exportes/` no se versiona.",
    "- `GET /api/telemetry/export` hace lo mismo desde el backend, solo para docentes y administradores.",
    "- `npm run telemetria:purgar` borra los eventos mas viejos que `TELEMETRY_RETENTION_DAYS` (365 por defecto). Sin `--confirmar` solo cuenta.",
    "- La sal `TELEMETRY_SALT` no se cambia durante el piloto: cambiarla rompe la union de eventos de un mismo actor.",
    "",
  );
  return lines.join("\n");
}
