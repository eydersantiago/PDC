export const schemaStatements = [
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
    generated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
  );
  `,
  `
  create index if not exists project_context_racks_user_created_idx
    on project_context_racks (user_id, created_at desc);
  `,
  `
  create table if not exists github_app_install_states (
    id text primary key,
    state text not null unique,
    session_id text references app_sessions(id),
    user_id text not null references users(id),
    repo_full_name text not null default '',
    expires_at timestamptz not null,
    consumed_at timestamptz,
    created_at timestamptz not null default now()
  );
  `,
  `
  create index if not exists github_app_install_states_state_idx
    on github_app_install_states (state);
  `,
  `
  create table if not exists github_app_installations (
    id text primary key,
    installation_id text not null unique,
    user_id text not null references users(id),
    account_login text not null default '',
    account_type text not null default '',
    repository_selection text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  `,
  `
  create index if not exists github_app_installations_user_updated_idx
    on github_app_installations (user_id, updated_at desc);
  `,
];
