// Esquema, parte 1 de 3: roles, usuarios, sesiones, politica, RAG, progreso, cursos, consentimiento, pestana activa y contexto del proyecto.
export const coreSchemaStatements = [
  `
  create table if not exists roles (
    id text primary key,
    code text not null unique,
    name text not null,
    created_at timestamptz not null default now()
  );
  `,
  `
  create table if not exists users (
    id text primary key,
    role_id text not null references roles(id),
    teacher_user_id text references users(id),
    email text not null unique,
    display_name text not null,
    password_hash text not null,
    is_active boolean not null default true,
    created_at timestamptz not null default now()
  );
  `,
  `
  create table if not exists app_sessions (
    id text primary key,
    user_id text not null references users(id),
    created_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    is_active boolean not null default true
  );
  `,
  `
  create table if not exists teacher_policies (
    id text primary key,
    teacher_user_id text not null unique references users(id),
    policy_name text not null,
    outcome text not null,
    tone text not null,
    frequency text not null,
    help_level text not null,
    allow_mini_quiz boolean not null default true,
    strict_no_solution boolean not null default true,
    max_hints_per_exercise integer,
    fallback_message text not null,
    custom_instruction text not null default '',
    allowed_interventions jsonb not null default '[]'::jsonb,
    allowed_topics jsonb not null default '[]'::jsonb,
    event_rules jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
  );
  `,
  `
  create table if not exists rag_sources (
    id text primary key,
    scope text not null default 'default',
    teacher_user_id text references users(id),
    source_key text not null default '',
    title text not null,
    source_type text not null default 'document',
    file_name text not null default '',
    mime_type text not null default '',
    content_sha256 text not null default '',
    content_text text not null default '',
    metadata jsonb not null default '{}'::jsonb,
    is_active boolean not null default true,
    created_by_user_id text references users(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  `,
  `
  create index if not exists rag_sources_scope_teacher_idx
    on rag_sources (scope, teacher_user_id, is_active, created_at desc);
  `,
  `
  create index if not exists rag_sources_source_key_idx
    on rag_sources (source_key);
  `,
  `
  create table if not exists rag_source_chunks (
    id text primary key,
    source_id text not null references rag_sources(id) on delete cascade,
    chunk_index integer not null,
    content_text text not null default '',
    search_text text not null default '',
    token_count integer not null default 0,
    char_start integer not null default 0,
    char_end integer not null default 0,
    page_start integer,
    page_end integer,
    citation_label text not null default '',
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    unique(source_id, chunk_index)
  );
  `,
  `
  create index if not exists rag_source_chunks_source_idx
    on rag_source_chunks (source_id, chunk_index);
  `,
  `
  create table if not exists student_exercise_progress (
    id text primary key,
    student_user_id text not null references users(id),
    exercise_key text not null,
    hint_count integer not null default 0,
    last_intervention_at timestamptz not null default now(),
    unique(student_user_id, exercise_key)
  );
  `,
  `
  create table if not exists intervention_telemetry (
    id text primary key,
    session_id text not null references app_sessions(id),
    student_user_id text references users(id),
    teacher_user_id text references users(id),
    event_type text not null,
    intervention_type text not null,
    detail_level text not null,
    policy_name text not null,
    exercise_key text,
    blocked boolean not null default false,
    reason text not null default '',
    context_summary text not null default '',
    policy_snapshot jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  );
  `,
  `
  create table if not exists user_course_assignments (
    id text primary key,
    user_id text not null references users(id),
    course_code text not null,
    assigned_by_user_id text references users(id),
    created_at timestamptz not null default now(),
    unique(user_id, course_code)
  );
  `,
  `
  create index if not exists user_course_assignments_user_idx
    on user_course_assignments (user_id, course_code);
  `,
  `
  create table if not exists user_workspace_consents (
    id text primary key,
    user_id text not null unique references users(id),
    can_read boolean not null default false,
    can_modify boolean not null default false,
    can_analyze boolean not null default false,
    granted_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  `,
  `
  create table if not exists user_active_tabs (
    id text primary key,
    user_id text not null unique references users(id),
    session_id text references app_sessions(id),
    tab_id text not null default '',
    tab_url text not null default '',
    tab_title text not null default '',
    view_context text not null default '',
    is_active boolean not null default true,
    seen_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  `,
  `
  create table if not exists project_context_racks (
    id text primary key,
    session_id text references app_sessions(id),
    user_id text not null references users(id),
    source text not null default 'codespace',
    repo_full_name text not null default '',
    branch text not null default '',
    total_entries integer not null default 0,
    total_files integer not null default 0,
    total_folders integer not null default 0,
    files jsonb not null default '[]'::jsonb,
    folders jsonb not null default '[]'::jsonb,
    active_file_path text not null default '',
    active_code_snippet text not null default '',
    active_suggestion text not null default '',
    replacement_options jsonb not null default '[]'::jsonb,
    generated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  `,
  `
  alter table project_context_racks
    add column if not exists active_suggestion text not null default '';
  `,
  `
  alter table project_context_racks
    add column if not exists replacement_options jsonb not null default '[]'::jsonb;
  `,
  `
  alter table project_context_racks
    add column if not exists updated_at timestamptz not null default now();
  `,
  `
  create index if not exists project_context_racks_user_created_idx
    on project_context_racks (user_id, created_at desc);
  `,
  `
  create table if not exists project_code_actions (
    id text primary key,
    session_id text references app_sessions(id),
    user_id text not null references users(id),
    repo_full_name text not null default '',
    branch text not null default '',
    file_path text not null default '',
    action_type text not null default 'replace_selection',
    title text not null default '',
    original_text text not null default '',
    replacement_text text not null default '',
    status text not null default 'pending',
    source text not null default 'browser_extension',
    worker_instance text not null default '',
    error_message text not null default '',
    metadata jsonb not null default '{}'::jsonb,
    requested_at timestamptz not null default now(),
    claimed_at timestamptz,
    completed_at timestamptz,
    updated_at timestamptz not null default now()
  );
  `,
  `
  create index if not exists project_code_actions_user_repo_status_idx
    on project_code_actions (user_id, repo_full_name, status, requested_at asc);
  `,
  `
  create index if not exists project_code_actions_session_status_idx
    on project_code_actions (session_id, status, requested_at asc);
  `,
  // Cola de cambios de codigo con lease (A12.12): hasta cuando es de VS Code el cambio que
  // reclamo y cuantas veces se reclamo. Un reclamo vencido vuelve a la cola una vez.
  `
  alter table project_code_actions
    add column if not exists lease_until timestamptz;
  `,
  `
  alter table project_code_actions
    add column if not exists attempts integer not null default 0;
  `,
];
