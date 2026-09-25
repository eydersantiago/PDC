# Análisis de datos del piloto

| | |
|---|---|
| Jira | A14.2 · ADACEEN-116 (monitoreo en vivo), A14.3 · ADACEEN-117 (limpieza), A14.4 · ADACEEN-118 (análisis de KPIs), A14.7 · ADACEEN-121 (trazabilidad) |
| Código | `src/services/kpis.ts`, `src/services/pilot-dataset.ts`, `src/services/pilot-report.ts`, `src/services/stats.ts`, `scripts/piloto-*.ts`, `scripts/lib/piloto.ts` |
| Plantillas | `data/piloto/plantillas/` (KPIs manuales T7, T8, T10, T11 y P5, sección 3.1) |
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
   │                                   + plantillas llenas (--registros)       -> registros-manuales.csv
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
  --encuesta=exportes/encuesta-forms.csv --plan=data/piloto/plan-piloto.json \
  --registros=exportes/registros-piloto
```

- **Entradas.** El dataset limpio de todo el piloto (un `piloto:dataset` con
  una ventana que cubra todas las sesiones: lo que pasa entre sesiones queda
  fuera por la regla D4), la exportación de la encuesta (CSV de Forms; las
  columnas se reconocen por el código al inicio de cada pregunta) y el plan del
  piloto (`data/piloto/plan-piloto.ejemplo.json`: consentimientos, presentes
  por sesión y cuentas de prueba). Los KPIs manuales T7, T8, T10, T11 y P5
  salen de las plantillas llenas de `--registros` (sección 3.1); el bloque
  `registros` del plan queda como respaldo.
- **Salidas** (en `<dataset>/analisis/`): `informe-kpis.md` (tabla de KPIs
  con semáforo y lectura automática, P1 con sus análisis complementarios,
  latencia, encuesta, uso de intervenciones, cobertura, avisos y, en la
  sección 9, el origen de los KPIs manuales), `kpis.csv`, `trazabilidad.csv`,
  `registros-manuales.csv` (con `--registros`), `respuestas-abiertas.csv` y
  `graficas/*.svg`.
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
estudiantes sintéticos y plantillas llenas sintéticas (con filas inválidas a
propósito), en 12 comprobaciones: [evidencia](../evidencias/ensayo-tecnico-piloto.md).
Si la evidencia dice 10 comprobaciones y que los KPIs manuales quedan sin
valor, es anterior a las plantillas: se regenera con
`npm run piloto:simular -- --evidencia`.

### 3.1 KPIs manuales desde las plantillas (T7, T8, T10, T11, P5)

Antes estos cinco valores se calculaban a mano después de cada sesión y se
transcribían al bloque `registros` del plan. Ahora se llena una copia de la
plantilla (fuera del repositorio, en una carpeta solo para las hojas, por
ejemplo `exportes/registros-piloto/`) y `piloto:analisis` la lee con
`--registros=<carpeta>`: valida cada fila, calcula el KPI y deja el trazado.
Los archivos se reconocen por el principio del nombre, así que puede haber
varias copias (una por sesión). No uses `exportes/` directamente: el paso P7.4
de la [prueba de inicio a fin](prueba-inicio-a-fin.md) escribe ahí
`exportes/prueba-inicio-a-fin.csv`, que es telemetría y no la hoja de la prueba
(se descartaría por «faltan columnas»).

| KPI | Plantilla en `data/piloto/plantillas/` | Copias que lee | Una fila por | Cálculo |
|---|---|---|---|---|
| T7 | `registro-incidentes.csv` | `registro-incidentes*.csv` | Incidente, con `severidad` S1 a S4 del [plan de soporte](plan-de-soporte.md) | Incidentes S1 con `fecha` en las sesiones del plan. Una copia sin filas cuenta como sesión sin incidentes solo si su nombre tiene la fecha (`registro-incidentes-2026-10-13.csv`) |
| T8 | `pruebas-humo.csv` | `pruebas-humo*.csv` y `demo-escenarios*.md` | Corrida de `npm run demo:escenarios` (`correctas` y `total` de «Resultado: N de M comprobaciones correctas») | Solo las corridas contra un `destino` o «Backend» `https://` y, con `--plan`, del mismo día de una sesión (el [runbook](../operacion/runbook.md) la pide en «Antes de la clase (T − 30 min)»): la de otro día, como la de la prueba de inicio a fin o una a mitad del despliegue, queda `ignorada`. Si un día hay varias, cuenta la última (por `hora`); el KPI es la peor sesión. Los `.md` son la evidencia que escribe `demo:escenarios` con `--salida` |
| T10 | `tiempos-instalacion.csv` | `tiempos-instalacion*.csv`; para el camino (túnel o Mac) del que no den ninguna fila válida, `prueba-inicio-a-fin*.csv` | Persona cronometrada, con `camino` `tunel` o `mac` | Mediana de los minutos del camino por túnel (`minutos_totales` o, si está vacío, de `inicio` a `editor_listo`). La Mac se informa aparte. Avisa si hay menos de 3 personas |
| T11 | `cumplimiento.csv` | `cumplimiento*.csv`: si hay varias, una sola, la de fecha más reciente en el nombre (`cumplimiento-AAAA-MM-DD.csv`) entre las que tienen algún ítem marcado. Una copia sin fecha (la plantilla copiada tal cual) solo cuenta si ninguna con ítems marcados tiene fecha; entre copias sin fecha, la que tenga más ítems marcados | Ítem de la [lista de cumplimiento](checklist-cumplimiento.md), con `estado` `cumple`, `no cumple`, `no aplica` o `pendiente` | Cumplidos / aplicables. Si un crítico no cumple o está sin marcar, T11 no cumple aunque pase del 80 %. Los automáticos se copian de `npm run piloto:verificar` |
| P5 | `hallazgos.csv` | `hallazgos*.csv` | Hallazgo (A14.5), con `kpis`, `critica` (si o no) y `estado` (`implementada`, `en curso`, `pendiente` o `descartada`) | Críticos implementados / críticos. Además llena «hallazgo» y «acción» de `trazabilidad.csv` en las filas de los KPIs que toca |

Para T10 desde la hoja de la [prueba de inicio a fin](prueba-inicio-a-fin.md)
(`prueba-inicio-a-fin.csv`), por cada cuenta `E1`, `E2`…: el cronómetro del
túnel son los `minutos` de P1.6 («Minutos totales») o, si están vacíos, de
`hora_inicio` de P1.1 a `hora_fin` de P1.6. El de la Mac va de `hora_inicio`
de P4.1 a `hora_fin` de P4.3; los `minutos` de P4.3 solo se usan si faltan esas
horas, porque P4.3 no dice si son los del paso o los totales. Si los minutos y
las horas difieren en más de 2 minutos, la lectura del KPI lo avisa. Un P1.6 o
P4.3 con `resultado` `falla` no cuenta. La hoja solo aporta el camino que
`tiempos-instalacion*.csv` no trae: si esa hoja tiene solo la Mac, el túnel sale
de la prueba, y al revés.

Reglas comunes:

- Fechas `AAAA-MM-DD` o `DD/MM/AAAA` (Excel en español) y horas `HH:MM`, con
  separador `,` o `;`. Los minutos aceptan coma decimal (`12,5`) solo con
  separador `;` o con el valor entre comillas (`"12,5"`); en una hoja separada
  por comas, `12,5` sin comillas corre las columnas. Una fila con más celdas que
  la cabecera se descarta con ese motivo. Si a esa fila le faltan las celdas
  vacías del final, el número de celdas cuadra y no se puede detectar: revisa
  el motivo de las descartadas.
- Guarda las hojas como «CSV UTF-8». Si llegan en Windows-1252 (Excel «CSV
  (delimitado por comas)»), el análisis las vuelve a leer así y lo avisa en la
  consola; sin eso, «Sí» se leería mal y la fila se descartaría.
- `registros-manuales.csv` tiene una fila por fila leída (o por archivo):
  `kpi`, `archivo`, `fila` (la cabecera es la 1; no cuenta filas vacías),
  `estado` y `motivo`. `usada` entra al KPI; `descartada` está mal llenada y
  hay que corregirla; `ignorada` es válida pero no aplica (fuera de las
  sesiones, contra un backend que no es producción, reemplazada por una
  corrida posterior o una plantilla sin llenar). La consola y la sección 9 del
  informe listan las descartadas y las hojas ignoradas enteras (por ejemplo,
  una copia de `cumplimiento*.csv` que no es la que cuenta).
- La plantilla gana sobre el plan. Si las dos tienen valor y no coinciden, la
  lectura del KPI lo avisa. Sin plantilla válida se usa el plan, y la sección 9
  dice de dónde salió cada valor.
- En `trazabilidad.csv` la evidencia de un KPI manual es el archivo de la
  plantilla y `registros-manuales.csv`.
- Las plantillas del repositorio están vacías (la de cumplimiento trae los
  ítems). Si cambia su formato o la lista de cumplimiento, se regeneran con
  `npm run piloto:analisis -- --escribir-plantillas`;
  `tests/services/kpis.test.ts` falla si quedaron desactualizadas.

## 4. Trazabilidad KPI → hallazgo → evidencia (A14.7)

`trazabilidad.csv` tiene una fila por KPI con el objetivo específico (OE),
el umbral, el valor, si cumple y los archivos de evidencia (informe, gráficas,
dataset, encuesta, plantilla o registro). Al escribir los hallazgos (A14.5):

1. Cada hallazgo va en una fila de la copia de `hallazgos.csv`, con los KPIs a
   los que se ancla en `kpis` (por ejemplo `T1; T2`). El análisis escribe
   «H3: <hallazgo>» en la columna «hallazgo» de esas filas de
   `trazabilidad.csv`.
2. La mejora que se decida va en `accion` con su `estado`; sale en la columna
   «acción» y las mejoras críticas implementadas dan el KPI P5.
3. La tabla completa va como anexo del documento final (A16.4).

## 5. Retiro de un participante

`npm run piloto:retiro -- --correo=<correo>` (con `--confirmar` para borrar):
borra su telemetría y sus datos de uso, cierra sus sesiones y anonimiza la
cuenta. Después se regenera el dataset. Ver [consentimiento](consentimiento.md),
parte 3.
