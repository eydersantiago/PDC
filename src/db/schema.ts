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
];
