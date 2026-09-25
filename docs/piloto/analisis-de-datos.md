# Análisis de datos del piloto

| | |
|---|---|
| Jira | A14.2 · ADACEEN-116 (monitoreo en vivo), A14.3 · ADACEEN-117 (limpieza), A14.4 · ADACEEN-118 (análisis de KPIs), A14.7 · ADACEEN-121 (trazabilidad) |
| Código | `src/services/kpis.ts`, `src/services/pilot-dataset.ts`, `src/services/pilot-report.ts`, `src/services/stats.ts`, `scripts/piloto-*.ts` |
| Pruebas | `tests/services/kpis.test.ts`, `tests/services/pilot-dataset.test.ts`, `tests/scripts/piloto-pipeline.test.ts` |
| Relacionados | [Protocolo](protocolo.md), [catálogo de KPIs](../metricas/catalogo-kpis.md), [diccionario de telemetría](../telemetria/diccionario-eventos.md) |

Los datos salen de la base del piloto (PostgreSQL en Azure). La cadena es:

```
sesión ──> telemetry_events (seudonimizada, con bloque/cohorte/condición)
   │            │
   │            ├─ en vivo:        npm run piloto:monitor        (A14.2)
   │            ├─ al cerrar:      npm run piloto:dataset        (A14.3)  -> dataset.csv, excluidos.csv, limpieza.md
   │            └─ al terminar:    npm run piloto:analisis       (A14.4)  -> informe-kpis.md, kpis.csv, gráficas
   │                                   + encuesta (Forms) + plan del piloto
   └─ trazabilidad KPI -> hallazgo -> evidencia: trazabilidad.csv (A14.7)
```

Todas las salidas van a `exportes/` (en `.gitignore`): nunca se suben al
repositorio.

## 1. Durante la sesión: monitor (A14.2)

```bash
npm run piloto:monitor -- --url=<backend> --email=<docente> --password=<clave> --desde=<inicio de la sesión en ISO>
```

Cada 30 segundos imprime una línea: bloque vigente, worker, servidores de
inferencia vivos agrupados por tipo (por ejemplo «Google Cloud - V100 x1, Mac
del laboratorio - M2 x3»), estudiantes activos en los últimos 5 minutos por
condición, latencia p50 de los últimos 10 minutos, respuestas sin fallo,
eventos perdidos y total de eventos. Alerta si no hay worker, si los
servidores vivos usan modelos distintos, si ningún servidor vivo acepta
imágenes, si la latencia pasa de 8 s, si las respuestas sin fallo bajan del 95
%, si los perdidos pasan del 2 % o los duplicados del 1 %, si aparecen
clientes sin sesión (VS Code sin la sesión compartida), si la VM de editores
no está conectada al relay o si hay un bloque activo sin actividad en 5
minutos. Cada lectura queda en `exportes/monitor-<fecha>.jsonl`: es la
evidencia de disponibilidad de la sesión y la base del criterio de validez de
bloque del protocolo.

## 2. Al cerrar cada sesión: limpieza (A14.3)

```bash
# con DATABASE_URL y TELEMETRY_SALT (los del App Service) en .env
npm run piloto:dataset -- --desde=2026-10-13T13:00:00-05:00 --hasta=2026-10-13T17:00:00-05:00 --plan=data/piloto/plan-piloto.json
# sin acceso a la base: exportar desde el backend y limpiar el archivo
npm run telemetria:exportar -- --url=<backend> --email=<docente> --password=<clave> --formato=csv --desde=... --hasta=...
npm run piloto:dataset -- --entrada=exportes/telemetria-<fecha>.csv
```

**Reglas de exclusión** (se aplica la primera que corresponda; lo excluido va
a `excluidos.csv` con su regla y nada se borra de la base):

| Regla | Qué excluye |
|---|---|
| D1 no_estudiante | Eventos de docentes, administradores o del sistema sin estudiante |
| D2 cliente_anonimo | Clientes sin sesión: no tienen condición (revisar la sesión compartida de VS Code) |
| D3 cuenta_de_prueba | Cuentas del equipo listadas en `cuentasPrueba` del plan (necesita la base y la sal) |
| D4 sin_condicion | Estudiantes fuera de los bloques del piloto o sin cohorte |
| D5 duplicado | Copias de un evento (mismo `client_session_id` y `seq`); se queda el primero |

**Marcas** (el evento se queda, con la marca en `limpieza_marcas`): M1 fecha
corregida (Q5, Q6), M2 decisión huérfana (I5), M3 orden inválido (I3).

Salidas: `dataset.csv` (columnas del diccionario más `limpieza_marcas`),
`excluidos.csv`, `limpieza.md` (conteos por regla y por cohorte),
`diccionario-dataset.md`, y con la base y la sal: `quices.csv` (intentos del
mini-quiz de los mismos estudiantes, para P8) y `bloques.csv` (historial de
cambios de bloque, con el docente seudonimizado).

Revisar `limpieza.md` después de cada sesión: si D2 tiene eventos, algunos
estudiantes trabajaron sin sesión y su trabajo no cuenta; se corrige antes de
la siguiente sesión.

## 3. Al terminar el piloto: análisis de KPIs (A14.4)

```bash
npm run piloto:analisis -- --dataset=exportes/piloto-<fecha> \
  --encuesta=exportes/encuesta-forms.csv --plan=data/piloto/plan-piloto.json
```

- **Entradas.** El dataset limpio de todo el piloto (un `piloto:dataset` con
  una ventana que cubra todas las sesiones: lo que pasa entre sesiones queda
  fuera por la regla D4), la exportación de la encuesta (CSV de Forms; las
  columnas se reconocen por el código al inicio de cada pregunta) y el plan del
  piloto (`data/piloto/plan-piloto.ejemplo.json`: consentimientos, presentes
  por sesión, cuentas de prueba y los KPIs manuales T7, T8, T10, T11 y P5).
- **Salidas** (en `<dataset>/analisis/`): `informe-kpis.md` (tabla de KPIs
  con semáforo y lectura automática, P1 con sus análisis complementarios,
  latencia, encuesta, uso de intervenciones, cobertura y avisos), `kpis.csv`,
  `trazabilidad.csv`, `respuestas-abiertas.csv` y `graficas/*.svg`.
- **P1 en detalle.** Mediana por estudiante y condición; reducción de la
  mediana de las medianas; Wilcoxon pareado (exacto hasta 30 pares sin
  empates) con correlación biserial de rangos; análisis del cruzado AB/BA
  (Hills y Armitage: efecto del tutor y de periodo con Mann-Whitney entre
  cohortes); reducción por cohorte; sensibilidad sin episodios corregidos desde
  otro archivo; episodios que cruzan de bloque (excluidos) y sin cierre
  (censurados, P2).
- **Lectura automática.** Cada KPI trae una frase con el valor, el n y si
  cumple. La interpretación (por qué pasó, qué significa para el curso) se
  escribe en el capítulo de resultados (A16.3) con apoyo de lo cualitativo.

El ensayo técnico (`npm run piloto:simular`) corre esta misma cadena con
estudiantes sintéticos: [evidencia](../evidencias/ensayo-tecnico-piloto.md).

## 4. Trazabilidad KPI → hallazgo → evidencia (A14.7)

`trazabilidad.csv` tiene una fila por KPI con el objetivo específico (OE),
el umbral, el valor, si cumple y los archivos de evidencia (informe, gráficas,
dataset, encuesta o registro). Al escribir los hallazgos (A14.5):

1. Cada hallazgo se ancla a uno o más KPIs y se escribe en la columna
   «hallazgo» de sus filas (por ejemplo «H3: la latencia de VS Code sube en la
   primera consulta tras encender la GPU»).
2. Cada mejora que se decida va en la columna «acción» con su estado; las
   mejoras críticas implementadas dan el KPI P5.
3. La tabla completa va como anexo del documento final (A16.4).

## 5. Retiro de un participante

`npm run piloto:retiro -- --correo=<correo>` (con `--confirmar` para borrar):
borra su telemetría y sus datos de uso, cierra sus sesiones y anonimiza la
cuenta. Después se regenera el dataset. Ver [consentimiento](consentimiento.md),
parte 3.
