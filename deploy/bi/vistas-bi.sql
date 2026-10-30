-- Vistas para Excel y Power BI: analitica de aprendizaje (29-10-2026).
--
-- Cada estudiante es su seudonimo (actor_anon_id: HMAC de "user:<id>" con TELEMETRY_SALT, el mismo en
-- la telemetria y en la historia del avance). Ninguna vista tiene nombres, correos, logins de GitHub,
-- codigos estudiantiles ni ids: docs/piloto/consentimiento.md dice que el nombre y el correo no hacen
-- parte del conjunto que se analiza. Para saber de quien es un codigo: la tarjeta «¿Quien es este
-- codigo?» del monitor del docente (de a uno, registrada).
--
-- Fuera del analisis: las cuentas de muestra (analytics_excluded_actors, lo llena el backend al
-- arrancar), los docentes y administradores, y los clientes de VS Code sin sesion.
--
-- Lo aplica deploy/bi/crear-bi.sh con el usuario de la app: es el dueno de las vistas y estas leen las
-- tablas con sus permisos. powerbi_lector solo tiene SELECT sobre las vistas, no sobre las tablas. Las
-- vistas son security_barrier: las condiciones de quien consulta se evaluan despues de los filtros de
-- la vista, asi que no pueden revelar las filas que la vista deja fuera. Se puede correr las veces que
-- haga falta: create or replace.

\set ON_ERROR_STOP on

create schema if not exists bi;

-- Un evento por fila (la telemetria v1.1 de los estudiantes), con fecha y hora de Bogota.
create or replace view bi.eventos with (security_barrier) as
select
  e.id as evento_id,
  e.occurred_at,
  (e.occurred_at at time zone 'America/Bogota')::date as fecha,
  to_char(e.occurred_at at time zone 'America/Bogota', 'HH24:MI') as hora,
  e.source as origen,
  e.channel as canal,
  e.category as categoria,
  e.event_type as evento,
  e.actor_anon_id,
  e.teacher_anon_id,
  e.client_session_id as sesion,
  e.course_code as curso,
  e.exercise_hash as ejercicio,
  e.language as lenguaje,
  e.file_ext as extension,
  e.policy_event_type,
  e.intervention_type as tipo_ayuda,
  e.help_stage as etapa_ayuda,
  e.reason_code as motivo,
  e.blocked as bloqueado,
  e.metadata ->> 'cause' as causa,
  e.latency_ms as latencia_ms,
  e.duration_ms as duracion_ms,
  e.count_value as cantidad,
  e.value_text as valor,
  e.error_hash as error,
  e.pilot_block as bloque_piloto,
  e.pilot_cohort as cohorte,
  e.pilot_condition as condicion
from telemetry_events e
where e.actor_kind = 'user'
  and e.actor_role = 'student'
  and e.actor_anon_id <> ''
  and e.actor_anon_id not in (select actor_anon_id from analytics_excluded_actors);

-- Eventos por estudiante, dia y tipo: la base de casi cualquier tabla dinamica.
create or replace view bi.eventos_por_dia with (security_barrier) as
select
  fecha,
  actor_anon_id,
  teacher_anon_id,
  canal,
  categoria,
  evento,
  count(*) as eventos,
  count(*) filter (where bloqueado) as bloqueados,
  round(avg(latencia_ms))::integer as latencia_media_ms,
  sum(duracion_ms) as duracion_total_ms
from bi.eventos
group by fecha, actor_anon_id, teacher_anon_id, canal, categoria, evento;

-- La historia del avance del taller: una fila por foto (solo cuando cambio algo).
create or replace view bi.avance with (security_barrier) as
select
  s.captured_at,
  (s.captured_at at time zone 'America/Bogota')::date as fecha,
  to_char(s.captured_at at time zone 'America/Bogota', 'HH24:MI') as hora,
  s.taller,
  s.actor_anon_id,
  s.teacher_anon_id,
  s.started as empezo,
  s.percent as porcentaje,
  s.compiles as compila,
  jsonb_array_length(s.done_points::jsonb) as puntos_hechos,
  jsonb_array_length(s.partial_points::jsonb) as puntos_parciales,
  jsonb_array_length(s.missing_points::jsonb) as puntos_faltantes,
  s.files as archivos,
  s.outside as fuera_de_src,
  s.last_change_at as ultimo_cambio
from workshop_progress_snapshots s
where s.actor_anon_id not in (select actor_anon_id from analytics_excluded_actors);

-- La ultima foto de cada estudiante en cada taller.
create or replace view bi.avance_actual with (security_barrier) as
select distinct on (taller, actor_anon_id) *
from bi.avance
order by taller, actor_anon_id, captured_at desc;

-- Una fila por foto y punto del taller (hecho, parcial o falta): que historia de usuario le cuesta a quien.
create or replace view bi.avance_puntos with (security_barrier) as
select s.captured_at, (s.captured_at at time zone 'America/Bogota')::date as fecha, s.taller, s.actor_anon_id, s.teacher_anon_id, p.punto, 'hecho'::text as estado
from workshop_progress_snapshots s cross join lateral jsonb_array_elements_text(s.done_points::jsonb) as p(punto)
where s.actor_anon_id not in (select actor_anon_id from analytics_excluded_actors)
union all
select s.captured_at, (s.captured_at at time zone 'America/Bogota')::date, s.taller, s.actor_anon_id, s.teacher_anon_id, p.punto, 'parcial'
from workshop_progress_snapshots s cross join lateral jsonb_array_elements_text(s.partial_points::jsonb) as p(punto)
where s.actor_anon_id not in (select actor_anon_id from analytics_excluded_actors)
union all
select s.captured_at, (s.captured_at at time zone 'America/Bogota')::date, s.taller, s.actor_anon_id, s.teacher_anon_id, p.punto, 'falta'
from workshop_progress_snapshots s cross join lateral jsonb_array_elements_text(s.missing_points::jsonb) as p(punto)
where s.actor_anon_id not in (select actor_anon_id from analytics_excluded_actors);

-- Lo que vale cada punto de cada taller (del ultimo informe de la VM): para unir con avance_puntos.
create or replace view bi.puntos with (security_barrier) as
select
  r.report ->> 'taller' as taller,
  r.report ->> 'titulo' as titulo,
  p.point ->> 'id' as punto,
  p.point ->> 'hu' as hu,
  p.point ->> 'texto' as texto,
  (p.point ->> 'peso')::numeric as peso
from (
  select setting_value::jsonb as report
  from app_settings
  where setting_key like 'workshop_progress:%'
) r
cross join lateral jsonb_array_elements(r.report -> 'points') as p(point);

-- Un resumen por estudiante: cuando estuvo, cuanto pidio ayuda y como va en cada taller.
create or replace view bi.estudiantes with (security_barrier) as
with actividad as (
  select
    actor_anon_id,
    (array_agg(teacher_anon_id order by occurred_at desc))[1] as teacher_anon_id,
    min(occurred_at) as primer_evento,
    max(occurred_at) as ultimo_evento,
    count(distinct fecha) as dias_activos,
    count(*) as eventos,
    count(*) filter (where categoria in ('tutor', 'suggestion')) as eventos_de_ayuda,
    count(*) filter (where bloqueado) as bloqueados
  from bi.eventos
  group by actor_anon_id
),
avance as (
  select actor_anon_id, (array_agg(teacher_anon_id order by captured_at desc))[1] as teacher_anon_id, max(porcentaje) as mejor_porcentaje,
         count(distinct taller) as talleres, max(captured_at) as ultima_foto
  from bi.avance_actual
  group by actor_anon_id
)
select
  coalesce(a.actor_anon_id, v.actor_anon_id) as actor_anon_id,
  coalesce(nullif(a.teacher_anon_id, ''), v.teacher_anon_id) as teacher_anon_id,
  a.primer_evento,
  a.ultimo_evento,
  coalesce(a.dias_activos, 0) as dias_activos,
  coalesce(a.eventos, 0) as eventos,
  coalesce(a.eventos_de_ayuda, 0) as eventos_de_ayuda,
  coalesce(a.bloqueados, 0) as bloqueados,
  coalesce(v.talleres, 0) as talleres,
  v.mejor_porcentaje,
  v.ultima_foto
from actividad a
full outer join avance v on v.actor_anon_id = a.actor_anon_id;

comment on schema bi is 'ADACEEN: vistas seudonimizadas para Excel y Power BI (deploy/bi/vistas-bi.sql). Sin nombres, correos, logins ni codigos estudiantiles.';
