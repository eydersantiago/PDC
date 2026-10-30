# Análisis de aprendizaje en Excel y Power BI

Cómo llevar los datos de ADACEEN a Excel o Power BI para ver, por estudiante, cómo avanza en el
taller y cómo usa el tutor, **sin datos personales**. Desde el 29-10-2026.

## Qué datos hay y qué no

Cada estudiante aparece con su **código del análisis**: 20 caracteres (0-9 y a-f), el seudónimo
`actor_anon_id`. Es un HMAC de `user:<id>` con `TELEMETRY_SALT`, el mismo en la telemetría y en la
historia del avance, así que las tablas se cruzan por esa columna. Ningún exporte ni vista trae
nombre, correo, login de GitHub, código estudiantil ni id de cuenta.

Así lo pide el [consentimiento](../piloto/consentimiento.md): el nombre y el correo no hacen parte
del conjunto que se analiza, y la lista nombre ↔ cuenta no se exporta.

Lo que **sí** hay:

| Tabla (vista `bi.` o CSV) | Una fila por | Para qué |
|---|---|---|
| `eventos` (`telemetria-*.csv`) | evento de la telemetría de un estudiante | Cuándo trabajó, qué pidió al tutor, bloqueos, latencias, errores (`error` es un hash: el mismo error de dos estudiantes da el mismo valor) |
| `eventos_por_dia` | estudiante, día y tipo de evento | La base de casi cualquier tabla dinámica |
| `avance` (`-avance.csv`) | foto del avance en un taller; solo se guarda cuando algo cambió | La curva de avance de cada estudiante: porcentaje, si compila, puntos hechos, parciales y faltantes |
| `avance_actual` | estudiante y taller | Dónde va cada uno hoy |
| `avance_puntos` (`-avance-puntos.csv`) | foto y punto del taller (`hecho`, `parcial`, `falta`) | Qué historia de usuario le cuesta a quién, y cuánto tarda cada una |
| `puntos` (`-avance-definiciones.csv`) | punto del taller | Lo que vale cada punto (`hu`, `texto`, `peso`), para unir con `avance_puntos` |
| `estudiantes` | estudiante | Resumen: días activos, eventos, eventos de ayuda, bloqueos, talleres y mejor porcentaje |

Fuera del análisis quedan:
- las cuentas de muestra (demo, de prueba y rutas demo);
- las cuentas del equipo que anotes en `ANALYTICS_EXCLUDE_EMAILS` del App Service (correos separados
  por coma; las mismas de `cuentasPrueba` del plan del piloto, por ejemplo E1 y E2). Se aplican al
  arrancar el backend;
- los docentes y administradores;
- VS Code sin sesión (un cliente sin cuenta no se puede atribuir a un estudiante).

Sobre la historia del avance:
- La VM de editores mide cada 10 minutos.
- Un resultado reusado (con nota `tiempo`, `pendiente` o `error`) no cuenta como medición nueva.
- Si el mismo login de GitHub lo tienen dos cuentas sin unir, esa medición se aparta (`ambiguous`
  en la respuesta del informe) en vez de adivinar de quién es: une las cuentas y vuelve a contar.
- La historia empieza el 29-10-2026; lo anterior no se guardó.

## ¿De quién es un código?

En el **monitor del docente** (`/docente/monitor`), en la tarjeta «¿Quién es este código?»:
- Pegas un código del análisis y ves el nombre y el código estudiantil, para ubicarlo en el SIRA.
- Al revés: escribes un código estudiantil (7 dígitos) y ves su código del análisis, para buscarlo
  en Excel o Power BI (y los de sus cuentas unidas, si tenía otra).
- El administrador ve a todos; el docente, solo a sus estudiantes. Un código de otro grupo
  responde «no es de tus estudiantes» y no confirma que exista. Las cuentas de muestra (demo y de
  prueba, con claves compartidas) no pueden consultar ni exportar.
- Va de a uno: cada consulta queda registrada (`pseudonym_lookups`: quién, en qué sentido, el
  código del análisis y si lo encontró; nunca el nombre ni el código estudiantil) y hay un tope de
  30 por hora, que vale también con pedidos en paralelo.
- El resultado se borra solo de la pantalla a los 2 minutos.

El código del análisis no sale en ninguna otra pantalla ni respuesta: junto con la lista de
«Estudiantes» armaría la tabla código ↔ nombre completa.

No pegues nombres en el Excel ni en el Power BI. Si alguien necesita saber quién es, lo consulta
en ADACEEN.

## Opción 1: archivos CSV, sin tocar la base

Desde el PC, con la carpeta del repositorio y una cuenta de administrador (o de docente, que
exporta solo su grupo):

```
npm run telemetria:exportar -- --url=https://app-adaceen-api-eyder05232002.azurewebsites.net --email=<tu correo> --password=<tu clave> --formato=csv --con-avance
```

Deja en `exportes/`:
- `telemetria-<fecha>.csv`;
- `telemetria-<fecha>-avance.csv`, `-avance-puntos.csv` y `-avance-definiciones.csv`.

`exportes/` está en `.gitignore`: no subas exportaciones al repositorio. Con acceso directo a la
base (`DATABASE_URL` y `TELEMETRY_SALT`) también vale `--con-quices`.

Para que se actualice solo, guarda la carpeta de exportes en el **OneDrive de Univalle**. Power BI
en la nube la lee sin instalar nada y los datos quedan dentro de la universidad. Excel, en
cambio, se comparte con el director por OneDrive o Teams sin licencia extra; Power BI gratis no
deja compartir.

- **Excel:** *Datos → Obtener datos → De un archivo → De una carpeta* (o *De texto/CSV*),
  delimitador coma, origen «65001: Unicode (UTF-8)». Luego *Cargar en → Agregar al modelo de
  datos* y relaciona las tablas por `actor_anon_id` (y `taller` + `punto` con las definiciones).
- **Power BI Desktop:** *Obtener datos → Carpeta*, el mismo modelo.

## Opción 2: conectado a la base, en vivo

Se hace una vez, en la Cloud Shell de Azure (shell.azure.com), con la rama desplegada:

```
cd ~ && git clone https://github.com/eydersantiago/PDC.git && cd PDC
bash deploy/bi/crear-bi.sh --ip=<la IP pública de tu PC>
cat ~/adaceen-powerbi-lector.txt
```

[`deploy/bi/crear-bi.sh`](../../deploy/bi/crear-bi.sh) hace cuatro cosas:
- Crea el esquema `bi` con las vistas de arriba ([`deploy/bi/vistas-bi.sql`](../../deploy/bi/vistas-bi.sql)).
- Crea el usuario `powerbi_lector`:
  - solo puede leer `bi` (ni las tablas de ADACEEN, ni escribir);
  - tiene un máximo de 5 conexiones y consultas de hasta 2 minutos;
  - su clave nunca sale en pantalla ni llega en claro al servidor (solo el verificador SCRAM).
- Guarda la conexión en `~/adaceen-powerbi-lector.txt`, con permisos 600.
- Abre el cortafuegos de la base para tu PC (`--ip`; búscala en el navegador del PC con «cuál es
  mi IP»). Si tu IP cambia, vuelve a correrlo con la nueva.

Otros usos:
- `bash deploy/bi/crear-bi.sh estado`: qué hay.
- `--rotar`: clave nueva.
- `quitar`: borra el usuario y las vistas, no los datos.

Conexión (PostgreSQL):
- **Power BI Desktop:** *Obtener datos → Base de datos PostgreSQL*. Servidor y base, del archivo;
  modo *Importar*; credenciales *Base de datos* con `powerbi_lector` y la clave. Elige las tablas
  del esquema `bi`.
- **Excel:** *Datos → Obtener datos → De una base de datos → De una base de datos PostgreSQL*. Si
  pide el conector, instala Npgsql (la versión que indique Excel). SSL obligatorio.
- **Power BI en la nube (tu espacio personal):** publica desde Desktop y programa la
  actualización, hasta 8 veces al día. Para leer la base, el servicio necesita que su cortafuegos
  permita «servicios de Azure». Esa regla abre el puerto de la base a máquinas de cualquier cliente
  de Azure (quedan la clave y SSL); `crear-bi.sh estado` dice si ya está, porque el backend puede
  depender de ella. **No la actives solo para Power BI**: si no está, actualiza en la nube desde los
  CSV en OneDrive (opción 1) o usa Desktop o Excel con `--ip`. Con la licencia gratuita de
  Univalle no se puede compartir el tablero publicado; compártelo como PDF o `.pbix`.

## Análisis sugeridos

| Pregunta | Con qué |
|---|---|
| ¿Cómo avanza cada estudiante en el taller? | `avance`: `fecha`/`hora` en el eje, `porcentaje` como valor, `actor_anon_id` como leyenda o segmentación |
| ¿Qué historia de usuario cuesta más? | `avance_puntos` + `puntos`: por `hu`, cuántos estudiantes la tienen `falta` en el tiempo y cuánto tardan en pasar a `hecho` |
| ¿Pedir ayuda se relaciona con avanzar? | `eventos_por_dia` (eventos `tutor` y `suggestion`) junto a `avance` por estudiante y día |
| ¿Quién está atascado? | `avance_actual` con poco porcentaje y muchos `bloqueados` en `estudiantes`; su código se consulta en el monitor |
| Con y sin tutor (piloto AB/BA) | `eventos.condicion` y `cohorte` ([protocolo](../piloto/protocolo.md)); el informe de KPIs sale de `npm run piloto:analisis` ([análisis de datos](../piloto/analisis-de-datos.md)) |
| Errores frecuentes | `eventos.error` (hash) agrupado: cuántos estudiantes distintos tuvieron el mismo error |

## Retención y retiro

- `npm run telemetria:purgar` borra también las fotos del avance y las consultas de códigos más
  viejas que `TELEMETRY_RETENTION_DAYS`.
- `npm run piloto:retiro` borra la historia del avance del participante y las consultas de su
  código.
- Si ya habías exportado o cargado los datos en Power BI, vuelve a exportar o actualizar después
  de un retiro.

## Al terminar (después de la tesis, al apagar todo)

`powerbi_lector` no vence solo, por decisión de Eyder: vale hasta el cierre. Cuando se apague todo:

1. Exporta lo que se vaya a conservar del análisis (la opción 1, con `--con-avance`).
2. `bash deploy/bi/crear-bi.sh quitar`: borra el usuario y las vistas `bi`, sin tocar los datos.
3. Borra las reglas `powerbi-*` del cortafuegos de la base (portal o `az postgres flexible-server firewall-rule delete`).
4. Borra `~/adaceen-powerbi-lector.txt` donde lo hayas copiado y las fuentes de datos guardadas en Excel o Power BI.
5. Los datos siguen la retención del consentimiento: `npm run telemetria:purgar -- --confirmar` a más tardar 365 días después del piloto.
