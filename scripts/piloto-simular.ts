import path from "node:path";
import { formatValue } from "../src/services/kpis.js";
import { hasFlag, readArg, readIntArg, writeTextFile } from "./lib/cli.js";
import { runPilotSimulation } from "./lib/simulacion-piloto.js";

/**
 * Ensayo tecnico del piloto (A13.6, parte automatizable): simula un piloto
 * AB/BA con estudiantes sinteticos contra el backend en memoria y corre la
 * limpieza y el analisis. No reemplaza el ensayo con personas.
 *
 *   npm run piloto:simular                                   # 12 estudiantes, salida en exportes/
 *   npm run piloto:simular -- --estudiantes=30 --semilla=otra
 *   npm run piloto:simular -- --evidencia                    # deja la evidencia en docs/evidencias/
 *
 * Sale con codigo 1 si alguna comprobacion falla.
 */

async function main() {
  const evidence = hasFlag("evidencia");
  const outDir = path.resolve(process.cwd(), readArg("salida", evidence ? "docs/evidencias/ensayo-tecnico" : "exportes/ensayo-tecnico"));
  const students = readIntArg("estudiantes", 12, 4, 60);
  const seed = readArg("semilla", "ensayo-tecnico-adaceen");
  const startedAt = Date.now();
  const result = await runPilotSimulation({ students, seed, outDir });
  const seconds = Math.round((Date.now() - startedAt) / 1000);

  for (const check of result.checks) {
    console.log(`[ensayo] ${check.ok ? "ok " : "NO "} ${check.name}: ${check.detail}`);
  }
  const failed = result.checks.filter((check) => !check.ok);

  const lines = [
    "# Ensayo técnico del piloto con estudiantes sintéticos",
    "",
    "| | |",
    "|---|---|",
    "| Jira | A13.6 · ADACEEN-114 (parte automatizable del ensayo; el ensayo con 1 o 2 personas sigue pendiente) |",
    `| Comando | \`npm run piloto:simular -- --evidencia --estudiantes=${students} --semilla=${seed}\` |`,
    `| Estudiantes | ${result.students} sintéticos más la cuenta de prueba (que la limpieza debe excluir) |`,
    `| Eventos generados | ${result.events} |`,
    `| Duración | ${seconds} s |`,
    `| Resultado | ${failed.length ? `**${failed.length} comprobaciones fallaron**` : `${result.checks.length} de ${result.checks.length} comprobaciones correctas`} |`,
    "",
    "## Qué se ensayó",
    "",
    "El ensayo levanta el backend real con una base en memoria y recorre, por la API, lo mismo que una sesión de clase del piloto AB/BA: el docente asigna las cohortes y pasa del bloque 1 al 2; cada estudiante sintético se atasca en errores de compilación (episodios de bloqueo con su cierre), pide ayuda en VS Code y en el overlay, aplica algunos cambios y valora algunas respuestas. Después corre la limpieza del dataset (`piloto:dataset`) y el análisis (`piloto:analisis`) con una encuesta sintética y las plantillas de los KPIs manuales llenas con datos sintéticos (incidentes, pruebas de humo, tiempos de instalación, cumplimiento y hallazgos).",
    "",
    "Los tiempos de desbloqueo son sintéticos y se generaron con medianas distintas a propósito (170 s con tutor y 240 s sin tutor): el ensayo prueba que la cadena mide y compara bien, **no dice nada sobre el efecto del tutor**.",
    "",
    "Con la misma semilla el ensayo genera los mismos datos y los mismos resultados; solo cambian T1 y T2, que son latencias medidas en la corrida.",
    "",
    "## Comprobaciones",
    "",
    "| Comprobación | Resultado | Detalle |",
    "|---|---|---|",
    ...result.checks.map((check) => `| ${check.name} | ${check.ok ? "Correcta" : "**Falló**"} | ${check.detail.replace(/\|/g, "\\|")} |`),
    "",
    "## KPIs del ensayo",
    "",
    "| ID | KPI | Valor | n | Cumple |",
    "|---|---|---|---|---|",
    ...result.kpis.map((kpi) => `| ${kpi.id} | ${kpi.name} | ${formatValue(kpi.value, kpi.unit)} | ${kpi.n ?? "—"} | ${kpi.meets === null ? "—" : kpi.meets ? "Sí" : "No"} |`),
    "",
    "Los KPIs manuales (T7, T8, T10, T11 y P5) salen de plantillas llenas sintéticas (`ensayo-tecnico/registros/`, con las columnas de `data/piloto/plantillas/`), leídas como en el piloto con `npm run piloto:analisis -- --registros=<carpeta>`. Tres filas están mal a propósito: una prueba de humo contra el backend en memoria, otra reemplazada por una corrida posterior del mismo día y un tiempo de instalación escrito con letras; `ensayo-tecnico/analisis/registros-manuales.csv` muestra que quedan fuera y por qué. P8 queda sin valor porque el ensayo no genera intentos del mini-quiz.",
    "",
    "## Archivos",
    "",
    "- Informe generado: [ensayo-tecnico/analisis/informe-kpis.md](ensayo-tecnico/analisis/informe-kpis.md)",
    "- Tabla de KPIs: `ensayo-tecnico/analisis/kpis.csv`; trazabilidad: `ensayo-tecnico/analisis/trazabilidad.csv`; origen fila por fila de los KPIs manuales: `ensayo-tecnico/analisis/registros-manuales.csv`",
    "- Limpieza: [ensayo-tecnico/dataset/limpieza.md](ensayo-tecnico/dataset/limpieza.md)",
    "- Plantillas llenas sintéticas (ejemplo de cómo se llenan): `ensayo-tecnico/registros/`",
    "- El dataset sintético (`ensayo-tecnico/dataset/*.csv`) no se versiona: se regenera con el comando de arriba.",
    "",
    "## Qué no cubre",
    "",
    "- Personas reales: el ensayo con 1 o 2 estudiantes (A13.6) sigue pendiente y prueba lo que aquí no se ve: la instalación, los túneles, la red de la sala y la comprensión de las instrucciones.",
    "- La GPU y la cola: el modelo se reemplaza por la salida de referencia con una espera aleatoria corta.",
    "- La extensión de VS Code real: los eventos se envían como los enviaría, con el mismo formato y numeración.",
    "",
  ];
  if (evidence) {
    // El dataset sintetico no se versiona: solo el informe, la limpieza y las graficas.
    const written = await writeTextFile("docs/evidencias/ensayo-tecnico-piloto.md", lines.join("\n"));
    console.log(`[ensayo] Evidencia: ${path.relative(process.cwd(), written)}`);
  }
  console.log(`[ensayo] Salida en ${path.relative(process.cwd(), outDir)} (${result.files.length} archivos, ${seconds} s).`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error("[ensayo] Fallo:", error);
  process.exitCode = 1;
});
