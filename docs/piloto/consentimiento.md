# Consentimiento informado y logística

| | |
|---|---|
| Jira | A13.3 · ADACEEN-111 (absorbe A5.2) |
| Estado | **Borrador para aprobación del director** (y del comité de ética de la Facultad, si lo exige) |
| Relacionados | [Protocolo](protocolo.md), [lista de cumplimiento](checklist-cumplimiento.md) (C01, C07, C11, C13), política de privacidad (`/privacy-policy` del backend, versión 2026-05-26) |

Tres partes: el formato para estudiantes mayores de edad (parte 1), el
asentimiento y la autorización del acudiente para menores de 18 años (parte 2)
y la logística de recolección, almacenamiento y retiro (parte 3). Los campos
entre corchetes se llenan antes de imprimir.

## Parte 1. Consentimiento informado (estudiantes mayores de edad)

**Proyecto:** Agente de aprendizaje contextual en el navegador para apoyo al
aprendizaje de la programación (ADACEEN). Trabajo de grado, Ingeniería de
Sistemas, Universidad del Valle.

**Investigador:** Eyder Santiago Suárez Chávez, [correo institucional].
**Director:** Víctor Andrés Bucheli Guerrero, PhD, [correo institucional].

**¿De qué se trata?** Estamos evaluando ADACEEN, un tutor basado en
inteligencia artificial que acompaña a estudiantes de programación en VS Code y
en el navegador: cuando te atascas con un error, te da pistas graduadas y te
remite al material del curso, sin darte la solución completa.

**¿Qué harías?** En [dos] sesiones de laboratorio del curso [FPOO] trabajarás
dos ejercicios cortos por sesión: uno con el tutor y otro sin él (el orden lo
decide el sistema al azar). Al final responderás una encuesta anónima de 10
minutos y, si quieres, una entrevista de 10 a 15 minutos.

**¿Qué datos se recogen?**

- Mientras trabajas, ADACEEN registra eventos de uso: cuándo aparece un error y
  cuándo desaparece, cuándo pides ayuda, qué tipo de ayuda recibiste, si la
  aplicaste o la valoraste, y cuánto tardó el tutor. **No se guarda tu código,
  el texto de tus errores, los nombres de tus archivos ni tu correo en estos
  registros**: solo resúmenes cifrados (hashes) y un seudónimo que no revela
  quién eres.
- Para darte cada ayuda, el tutor envía al servidor del proyecto (Microsoft
  Azure) el archivo que tienes abierto en el editor (hasta 12 000 caracteres),
  el error que ves y tu pregunta; el servidor los pasa al modelo de lenguaje,
  que corre en máquinas del proyecto en Google Cloud (Estados Unidos). Ese
  contenido se usa para responderte: no entra en los datos del estudio y no se
  usa para entrenar modelos. Si usas «Explorar proyecto» en el navegador, se
  lee tu repositorio con el permiso que das en ese momento.
- La encuesta es anónima. De la observación de la clase solo se anota lo que
  pasa en el grupo, sin nombres. De la entrevista se toman notas con un código;
  el audio solo se graba si lo autorizas abajo.
- Tu cuenta de ADACEEN (nombre y correo) queda en la aplicación como en
  cualquier uso del curso; no hace parte del conjunto de datos que se analiza.

**Riesgos y beneficios.** El riesgo es mínimo: es una clase normal. Puede que
el bloque sin tutor te resulte más lento o frustrante, igual que cualquier
ejercicio. Beneficios: practicas con ayuda guiada y contribuyes a mejorar una
herramienta pensada para el curso.

**Participación voluntaria y retiro.** Participar es voluntario. Si no
aceptas, trabajas la clase igual, sin ADACEEN, y **no afecta tu nota**. Puedes
retirarte en cualquier momento, sin dar razones, escribiendo al investigador:
tus datos se borran en un plazo de 5 días hábiles.

**Confidencialidad y uso de los datos.** Los datos se usan solo para este
trabajo de grado y sus publicaciones académicas, siempre de forma agregada (sin
identificar a nadie). Solo el investigador y el director tienen acceso a la
base del piloto. La telemetría se guarda como máximo [365 días] y luego se
borra; los resultados agregados pueden conservarse en el documento de grado.
El tratamiento de datos personales sigue la Ley 1581 de 2012 y la política de
privacidad de ADACEEN (versión 2026-05-26).

**Sobre la inteligencia artificial.** El tutor puede equivocarse. Tómalo como
una pista, no como una respuesta segura, y verifica lo que te sugiere.

**Preguntas.** Investigador: [correo]. Director: [correo].

| Autorización | Sí | No |
|---|---|---|
| Acepto participar en el piloto y que se registren los datos de uso descritos | ☐ | ☐ |
| Acepto que la entrevista (si participo) se grabe en audio | ☐ | ☐ |
| Soy mayor de 18 años | ☐ | ☐ |

Nombre: ______________________________ Código estudiantil: ______________

Firma: ______________________________ Fecha: ______________

## Parte 2. Asentimiento y autorización del acudiente (menores de 18 años)

**Asentimiento del estudiante.** Me explicaron en qué consiste el piloto, que
es voluntario, que no afecta mi nota y que me puedo retirar cuando quiera.
Quiero participar: ☐ Sí ☐ No

Nombre del estudiante: ______________________________ Firma: ______________

**Autorización del padre, madre o acudiente.** Leí la información de la parte
1 y autorizo que el estudiante participe y que se registren los datos de uso
descritos: ☐ Sí ☐ No

Nombre: ______________________________ Documento: ______________

Relación con el estudiante: ______________ Teléfono o correo: ______________

Firma: ______________________________ Fecha: ______________

## Parte 3. Logística

### Cómo se recoge

1. Una clase antes de la sesión 1, el investigador presenta el piloto (5
   minutos) y entrega el formato impreso o el enlace al formulario de
   consentimiento; los menores de edad se llevan la parte 2 para su acudiente.
2. Se reciben los formatos hasta el inicio de la sesión 1. Nadie participa sin
   formato firmado (ítem crítico C01).
3. El investigador arma la lista de participantes y el docente crea sus cuentas
   de ADACEEN en el grupo del piloto; **solo** los que aceptaron quedan en ese
   grupo. El número de consentimientos se anota en el plan del piloto
   (`participantesConConsentimiento`), sin nombres.

### Dónde y cuánto tiempo se guarda

| Qué | Dónde | Quién accede | Cuánto tiempo |
|---|---|---|---|
| Formatos firmados (papel) | Sobre cerrado bajo llave, [oficina o laboratorio] | Investigador y director | Hasta [un año] después de la sustentación; luego se destruyen |
| Formatos digitales (si se usa formulario) | Carpeta institucional con acceso restringido, fuera de cualquier repositorio | Investigador y director | Igual |
| Lista de participantes (nombre ↔ cuenta) | Solo en la aplicación (vista del docente); no se exporta | Docente, investigador | Hasta el cierre del piloto |
| Telemetría seudonimizada | Base PostgreSQL del piloto (Azure) | Investigador y director | `TELEMETRY_RETENTION_DAYS` (365 días); luego `npm run telemetria:purgar -- --confirmar` |
| Exportaciones para el análisis | Carpeta `exportes/` del equipo del investigador (fuera del repositorio) | Investigador | Hasta la sustentación |

### Retiro de un participante

1. El estudiante escribe al investigador (no hace falta dar razones).
2. El investigador corre, con la base del piloto y la sal del servidor:
   `npm run piloto:retiro -- --correo=<correo>` (cuenta lo que se borraría) y
   luego `--confirmar`. El script borra su telemetría y sus datos de uso,
   cierra sus sesiones y anonimiza su cuenta.
3. Si ya había exportaciones, se vuelven a generar (`npm run piloto:dataset`).
4. En el registro de consentimientos se anota la fecha y el seudónimo que
   imprime el script (no el correo). Plazo: 5 días hábiles.
5. Si la encuesta ya se respondió, no se puede retirar (es anónima); así se
   informa en el formato.
