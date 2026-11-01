// Esquema, parte 3 de 3: telemetria, piloto, acceso simplificado, privacidad, lotes de RAG, quices del docente, ajustes, codigo de estudiante y analitica.
export const pilotSchemaStatements = [
  // Telemetria v1.1 (A4/A7): un solo registro de eventos, sin llaves foraneas,
  // para que tambien entren los clientes anonimos del piloto (x-adaceen-client-id).
  // Nunca guarda correo, id de usuario en claro, texto de error ni codigo:
  // el actor va seudonimizado (HMAC) y los textos solo como hash.
  `
  create table if not exists telemetry_events (
    id text primary key,
    schema_version text not null default '1.1',
    occurred_at timestamptz not null default now(),
    received_at timestamptz not null default now(),
    source text not null default 'backend',
    channel text not null default '',
    category text not null default '',
    event_type text not null,
    actor_anon_id text not null default '',
    actor_kind text not null default '',
    actor_role text not null default '',
    teacher_anon_id text not null default '',
    client_session_id text not null default '',
    seq integer,
    decision_id text not null default '',
    course_code text not null default '',
    exercise_hash text not null default '',
    language text not null default '',
    file_ext text not null default '',
    policy_event_type text not null default '',
    intervention_type text not null default '',
    help_stage text not null default '',
    reason_code text not null default '',
    blocked boolean,
    latency_ms integer,
    duration_ms integer,
    count_value integer,
    value_text text not null default '',
    error_hash text not null default '',
    context_hash text not null default '',
    metadata jsonb not null default '{}'::jsonb,
    quality_flags jsonb not null default '[]'::jsonb
  );
  `,
  `
  create index if not exists telemetry_events_time_idx
    on telemetry_events (occurred_at);
  `,
  `
  create index if not exists telemetry_events_actor_idx
    on telemetry_events (actor_anon_id, occurred_at);
  `,
  `
  create index if not exists telemetry_events_type_idx
    on telemetry_events (event_type, occurred_at);
  `,
  `
  create index if not exists telemetry_events_decision_idx
    on telemetry_events (decision_id);
  `,
  // Piloto con y sin tutor (A13.1, diseno AB/BA). La cohorte es del
  // estudiante y el bloque vigente es de su docente; el historial de bloques
  // sirve para reconstruir las ventanas de cada condicion en el analisis.
  `
  create table if not exists pilot_blocks (
    teacher_user_id text primary key references users(id),
    block integer not null default 0,
    seed text not null default '',
    updated_by_user_id text,
    updated_at timestamptz not null default now()
  );
  `,
  `
  create table if not exists pilot_assignments (
    student_user_id text primary key references users(id),
    teacher_user_id text not null references users(id),
    cohort text not null,
    assigned_at timestamptz not null default now()
  );
  `,
  `
  create table if not exists pilot_block_log (
    id text primary key,
    teacher_user_id text not null references users(id),
    block integer not null,
    changed_by_user_id text,
    changed_at timestamptz not null default now()
  );
  `,
  `
  alter table telemetry_events
    add column if not exists pilot_block integer;
  `,
  `
  alter table telemetry_events
    add column if not exists pilot_cohort text not null default '';
  `,
  `
  alter table telemetry_events
    add column if not exists pilot_condition text not null default '';
  `,
  // Acceso simplificado (docs/arquitectura/acceso-simplificado.md): sesiones
  // por tipo. Las filas anteriores quedan como browser y sin vencimiento.
  `
  alter table app_sessions
    add column if not exists kind text not null default 'browser';
  `,
  `
  alter table app_sessions
    add column if not exists expires_at timestamptz;
  `,
  `
  alter table app_sessions
    add column if not exists label text;
  `,
  `
  create index if not exists app_sessions_user_kind_idx
    on app_sessions (user_id, kind, is_active);
  `,
  // Codigos de un solo uso para emparejar VS Code: solo se guarda el SHA-256
  // del codigo normalizado, nunca el codigo.
  `
  create table if not exists editor_pairing_codes (
    code_hash text primary key,
    user_id text not null references users(id),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    used_at timestamptz
  );
  `,
  `
  create index if not exists editor_pairing_codes_user_idx
    on editor_pairing_codes (user_id, used_at);
  `,
  // Versiones de la politica de privacidad que acepto cada usuario, con la
  // fecha de la primera aceptacion de cada una (constancia del consentimiento):
  // asi otro navegador o equipo no vuelve a pedir «Aceptar y continuar».
  `
  create table if not exists user_privacy_acceptances (
    user_id text not null references users(id),
    policy_version text not null,
    accepted_at timestamptz not null default now(),
    primary key (user_id, policy_version)
  );
  `,
  // Lotes de RAG por curso (navegador 0.7.15): cada curso tiene la base (las fuentes
  // default, que el docente puede desactivar) y los lotes que el docente crea para
  // cambiar el enfoque. Un lote activo por curso y docente; un estudiante puede tener
  // otro asignado. La fuente de un lote lleva metadata.lotId; sin lotId es de la base.
  `
  create table if not exists rag_lots (
    id text primary key,
    teacher_user_id text not null references users(id),
    course_code text not null,
    name text not null,
    description text not null default '',
    includes_base boolean not null default true,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  `,
  `
  create index if not exists rag_lots_teacher_course_idx
    on rag_lots (teacher_user_id, course_code, is_active);
  `,
  `
  create table if not exists rag_course_lot_settings (
    teacher_user_id text not null references users(id),
    course_code text not null,
    active_lot_id text,
    updated_at timestamptz not null default now(),
    primary key (teacher_user_id, course_code)
  );
  `,
  `
  create table if not exists rag_source_overrides (
    teacher_user_id text not null references users(id),
    source_id text not null references rag_sources(id),
    is_active boolean not null default true,
    updated_at timestamptz not null default now(),
    primary key (teacher_user_id, source_id)
  );
  `,
  `
  create table if not exists rag_student_lots (
    student_user_id text not null references users(id),
    course_code text not null,
    lot_id text not null references rag_lots(id),
    assigned_by_user_id text references users(id),
    updated_at timestamptz not null default now(),
    primary key (student_user_id, course_code)
  );
  `,
  // Quices personalizados del docente (navegador 0.7.15): el banco propio que se lanza
  // a la clase desde la pestana «Quices» o desde la pagina /docente/quices.
  `
  create table if not exists teacher_quizzes (
    id text primary key,
    teacher_user_id text not null references users(id),
    course_code text not null default '',
    topic text not null default '',
    question text not null,
    choices jsonb not null default '[]'::jsonb,
    correct_index integer not null,
    explanation text not null default '',
    followup_question text not null default '',
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  `,
  `
  create index if not exists teacher_quizzes_teacher_idx
    on teacher_quizzes (teacher_user_id, is_active, created_at desc);
  `,
  // Un lanzamiento hecho desde el banco propio recuerda de que quiz salio.
  `
  alter table quiz_launches
    add column if not exists custom_quiz_id text not null default '';
  `,
  // Ajustes del sistema que el administrador cambia desde la extension (navegador 0.7.19).
  // Por ahora uno: workspace_provider ("tunnel" o "codespaces"), el entorno donde los
  // estudiantes abren su editor. Sin fila manda ADACEEN_WORKSPACE_PROVIDER.
  `
  create table if not exists app_settings (
    setting_key text primary key,
    setting_value text not null,
    updated_by_user_id text references users(id),
    updated_at timestamptz not null default now()
  );
  `,
  // Tema del piloto (navegador 0.7.21, 9 de octubre de 2026): la semana de la bitacora, el
  // titulo y el repositorio del ejercicio que el docente (o el administrador por el) elige en
  // «Estudiantes». Sus estudiantes lo ven en Inicio con un boton para abrir el ejercicio y el
  // tutor se enfoca en esa semana. Una fila por docente; sin fila no hay tema. app_settings
  // guarda ademas default_teacher_user_id: el docente de las cuentas nuevas (Google o creadas
  // sin docente), que se elige en «Usuarios».
  `
  create table if not exists pilot_topics (
    teacher_user_id text primary key references users(id),
    course_code text not null default 'FPOO',
    week integer not null default 0,
    title text not null default '',
    repo_full_name text not null default '',
    updated_by_user_id text,
    updated_at timestamptz not null default now()
  );
  `,
  // Codigo de estudiante como identidad (navegador 0.7.22, src/services/auth/student-code.ts). Un
  // estudiante no entra sin codigo; el codigo es unico (llave) y cada cuenta tiene uno solo
  // (user_id unique). Tabla aparte y no columna de users: sin indices parciales (pg-mem) y sin
  // tocar las consultas que ya leen users.
  `
  create table if not exists student_codes (
    code text primary key,
    user_id text not null unique references users(id),
    assigned_by_user_id text references users(id),
    created_at timestamptz not null default now()
  );
  `,
  // Otros correos con los que entra una cuenta (Gmail ademas del institucional, por ejemplo).
  // El login busca aqui antes que en users.email: un correo de una cuenta unida a otra entra a
  // la que prevalece.
  `
  create table if not exists user_login_emails (
    email text primary key,
    user_id text not null references users(id),
    approved_by_user_id text references users(id),
    created_at timestamptz not null default now()
  );
  `,
  `
  create index if not exists user_login_emails_user_idx
    on user_login_emails (user_id);
  `,
  // Un correo nuevo con un codigo de una cuenta que ya entro: queda pendiente hasta que el
  // docente del estudiante o el administrador lo apruebe. source_user_id es la cuenta que ya
  // tenia ese correo (una importada de Campus, por ejemplo), que al aprobar se une a la otra.
  `
  create table if not exists student_access_requests (
    id text primary key,
    email text not null,
    display_name text not null default '',
    student_code text not null,
    target_user_id text not null references users(id),
    source_user_id text references users(id),
    status text not null default 'pending',
    created_at timestamptz not null default now(),
    decided_at timestamptz,
    decided_by_user_id text references users(id)
  );
  `,
  `
  create index if not exists student_access_requests_status_idx
    on student_access_requests (status, created_at);
  `,
  // Cuenta unida a otra (al aprobar una solicitud): queda desactivada y apunta a la que
  // prevalece (la lista de «Usuarios» la oculta y sus correos entran a la otra).
  `
  alter table users
    add column if not exists merged_into_user_id text;
  `,
  // Analitica de aprendizaje (29-10-2026, src/services/analytics/learning-analytics.ts). El avance del taller
  // se guarda como historia (una foto por estudiante solo cuando cambia) con el mismo seudonimo de
  // la telemetria (actor_anon_id = HMAC de "user:<id>"), nunca con el login de GitHub ni el nombre:
  // asi se cruza con telemetry_events en Excel o Power BI sin datos personales.
  `
  create table if not exists workshop_progress_snapshots (
    id text primary key,
    taller text not null,
    actor_anon_id text not null,
    teacher_anon_id text not null default '',
    captured_at timestamptz not null,
    received_at timestamptz not null default now(),
    started boolean not null default false,
    percent integer not null default 0,
    compiles boolean,
    done_points text not null default '[]',
    partial_points text not null default '[]',
    missing_points text not null default '[]',
    files integer not null default 0,
    outside integer not null default 0,
    last_change_at timestamptz,
    fingerprint text not null
  );
  `,
  `
  create index if not exists workshop_progress_snapshots_taller_idx
    on workshop_progress_snapshots (taller, actor_anon_id, captured_at);
  `,
  // La ultima foto de cada estudiante por taller: decide si el informe nuevo cambia algo sin leer
  // toda la historia.
  `
  create table if not exists workshop_progress_last (
    taller text not null,
    actor_anon_id text not null,
    fingerprint text not null,
    captured_at timestamptz not null,
    primary key (taller, actor_anon_id)
  );
  `,
  // Seudonimos que el analisis deja fuera (cuentas de muestra: demo, prueba, rutas demo). Lo llena
  // el backend al arrancar (la sal no sale del servidor); lo usan las vistas de deploy/bi/vistas-bi.sql.
  `
  create table if not exists analytics_excluded_actors (
    actor_anon_id text primary key,
    reason text not null default 'muestra',
    updated_at timestamptz not null default now()
  );
  `,
  // Reidentificacion dentro de ADACEEN («¿Quien es este codigo?»): cada consulta queda registrada
  // (quien, en que sentido, el seudonimo, si lo encontro) y cuenta para el tope por hora. Nunca se
  // guarda el nombre ni el codigo estudiantil.
  `
  create table if not exists pseudonym_lookups (
    id text primary key,
    viewer_user_id text not null references users(id),
    direction text not null default 'codigo',
    code text not null default '',
    found boolean not null default false,
    outcome text not null default '',
    created_at timestamptz not null default now()
  );
  `,
  `
  create index if not exists pseudonym_lookups_viewer_idx
    on pseudonym_lookups (viewer_user_id, created_at);
  `,
];
