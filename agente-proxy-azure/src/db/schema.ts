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
];
