// Esquema, parte 2 de 3: eventos de comportamiento, GitHub, escaneo del proyecto, clasificacion de documentos y quices.
export const activitySchemaStatements = [
  `
  create table if not exists user_behavior_events (
    id text primary key,
    user_id text not null references users(id),
    teacher_user_id text references users(id),
    session_id text references app_sessions(id),
    source text not null default 'browser_extension',
    category text not null,
    event_type text not null,
    page_context text not null default '',
    repo_full_name text not null default '',
    branch text not null default '',
    file_path text not null default '',
    language text not null default '',
    subject_id text not null default '',
    event_value text not null default '',
    duration_ms integer,
    count_value integer not null default 1,
    metadata jsonb not null default '{}'::jsonb,
    occurred_at timestamptz not null default now(),
    created_at timestamptz not null default now()
  );
  `,
  `
  create index if not exists user_behavior_events_user_time_idx
    on user_behavior_events (user_id, occurred_at desc);
  `,
  `
  create index if not exists user_behavior_events_teacher_time_idx
    on user_behavior_events (teacher_user_id, occurred_at desc);
  `,
  `
  create index if not exists user_behavior_events_category_idx
    on user_behavior_events (category, event_type, occurred_at desc);
  `,
  `
  create index if not exists user_behavior_events_repo_idx
    on user_behavior_events (repo_full_name, occurred_at desc);
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
  `
  create table if not exists github_oauth_states (
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
  create index if not exists github_oauth_states_state_idx
    on github_oauth_states (state);
  `,
  `
  create table if not exists github_user_tokens (
    id text primary key,
    user_id text not null unique references users(id),
    account_login text not null default '',
    account_email text not null default '',
    access_token text not null,
    token_type text not null default 'bearer',
    scopes text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  `,
  `
  create index if not exists github_user_tokens_user_updated_idx
    on github_user_tokens (user_id, updated_at desc);
  `,
  `
  create table if not exists github_repo_bootstrap_states (
    id text primary key,
    user_id text not null references users(id),
    repo_full_name text not null,
    is_bootstrapped boolean not null default false,
    source text not null default '',
    details text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(user_id, repo_full_name)
  );
  `,
  `
  create index if not exists github_repo_bootstrap_states_user_updated_idx
    on github_repo_bootstrap_states (user_id, updated_at desc);
  `,
  `
  create table if not exists project_scan_requests (
    id text primary key,
    repo_full_name text not null,
    status text not null default 'pending',
    requested_by_user_id text references users(id),
    requested_session_id text references app_sessions(id),
    worker_instance text not null default '',
    error_message text not null default '',
    snapshot_id text not null default '',
    requested_at timestamptz not null default now(),
    claimed_at timestamptz,
    completed_at timestamptz,
    updated_at timestamptz not null default now()
  );
  `,
  `
  create index if not exists project_scan_requests_repo_status_idx
    on project_scan_requests (repo_full_name, status, requested_at desc);
  `,
  `
  create table if not exists project_scan_snapshots (
    id text primary key,
    request_id text references project_scan_requests(id),
    repo_full_name text not null,
    source text not null default 'vscode_extension',
    runtime jsonb not null default '{}'::jsonb,
    mode jsonb not null default '{}'::jsonb,
    workspace_folders jsonb not null default '[]'::jsonb,
    selected_folders jsonb not null default '[]'::jsonb,
    total_files integer not null default 0,
    skipped_by_size integer not null default 0,
    total_bytes bigint not null default 0,
    storage_path text not null,
    created_at timestamptz not null default now()
  );
  `,
  `
  create index if not exists project_scan_snapshots_repo_created_idx
    on project_scan_snapshots (repo_full_name, created_at desc);
  `,
  `
  create table if not exists project_scan_snapshot_files (
    id text primary key,
    snapshot_id text not null references project_scan_snapshots(id) on delete cascade,
    path text not null,
    bytes integer not null default 0,
    lines integer not null default 0,
    preview text not null default '',
    extension text not null default '',
    content_sha256 text not null default '',
    created_at timestamptz not null default now()
  );
  `,
  `
  create index if not exists project_scan_snapshot_files_snapshot_idx
    on project_scan_snapshot_files (snapshot_id, path);
  `,
  `
  create table if not exists project_document_classifications (
    id text primary key,
    user_id text references users(id),
    session_id text references app_sessions(id),
    repo_full_name text not null default '',
    request_id text not null default '',
    snapshot_id text not null default '',
    file_path text not null default '',
    file_name text not null default '',
    mime_type text not null default '',
    extension text not null default '',
    label text not null default '',
    confidence double precision not null default 0,
    method text not null default 'rules',
    evidence jsonb not null default '[]'::jsonb,
    reason text not null default '',
    extracted_text_preview text not null default '',
    features jsonb not null default '{}'::jsonb,
    training_example jsonb not null default '{}'::jsonb,
    model_used boolean not null default false,
    model_error text not null default '',
    classified_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(repo_full_name, snapshot_id, file_path)
  );
  `,
  `
  create index if not exists project_document_classifications_repo_idx
    on project_document_classifications (repo_full_name, classified_at desc);
  `,
  `
  alter table teacher_policies
    add column if not exists quiz_settings jsonb not null default '{}'::jsonb;
  `,
  `
  create table if not exists quiz_launches (
    id text primary key,
    teacher_user_id text not null references users(id),
    course_code text not null default '',
    topic text not null default '',
    question text not null,
    choices jsonb not null default '[]'::jsonb,
    correct_index integer not null,
    explanation text not null default '',
    followup_question text not null default '',
    active boolean not null default true,
    created_at timestamptz not null default now(),
    expires_at timestamptz
  );
  `,
  `
  create index if not exists quiz_launches_teacher_idx
    on quiz_launches (teacher_user_id, created_at desc);
  `,
  `
  create table if not exists student_quizzes (
    id text primary key,
    client_key text not null,
    user_id text references users(id),
    teacher_user_id text,
    session_id text,
    trigger_kind text not null,
    launch_id text,
    status text not null default 'pending',
    language text not null default '',
    file_path text not null default '',
    topic text not null default '',
    question text not null,
    choices jsonb not null default '[]'::jsonb,
    correct_index integer not null,
    explanation text not null default '',
    followup_question text not null default '',
    chosen_index integer,
    correct boolean,
    followup_answer text not null default '',
    followup_score integer,
    followup_feedback text not null default '',
    code_context jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    answered_at timestamptz,
    completed_at timestamptz
  );
  `,
  `
  create index if not exists student_quizzes_client_idx
    on student_quizzes (client_key, created_at desc);
  `,
  `
  create index if not exists student_quizzes_teacher_idx
    on student_quizzes (teacher_user_id, created_at desc);
  `,
  `
  alter table teacher_policies
    add column if not exists code_application_settings jsonb not null default '{}'::jsonb;
  `,
];
