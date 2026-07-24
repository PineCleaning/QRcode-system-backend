-- ============================================================
-- Pine Cleaning QR Feedback System — Database Schema (v1.5)
-- PostgreSQL / Supabase
--
-- Source: pine-cleaning-schema-v1_5.sql, with two deviations
-- confirmed by the user on 2026-07-24:
--   1. feedback_submissions' text column is named `feedback`,
--      not `message`.
--   2. client_site_status is 2-state (ACTIVE/INACTIVE) — the
--      source SQL's third ARCHIVED state was dropped.
--
-- Applied manually via a `pg`-based script rather than
-- `prisma migrate dev`/`db push`, because this machine's Windows
-- Smart App Control policy blocks Prisma's native schema-engine
-- binary from running. Prisma Client itself (query execution) is
-- unaffected — it runs on Prisma 7's WASM engine, no native
-- binary involved. See backend/CLAUDE.md for details.
-- ============================================================

create extension if not exists "pgcrypto"; -- for gen_random_uuid()

-- ============================================================
-- ENUM TYPES
-- ============================================================
create type admin_status as enum ('ACTIVE', 'INACTIVE');

create type clickup_connection_status as enum ('CONNECTED', 'DISCONNECTED', 'RECONNECT_REQUIRED');

create type client_site_status as enum ('ACTIVE', 'INACTIVE');

create type feedback_status as enum ('DRAFT', 'SUBMITTED', 'DELIVERY_PENDING', 'DELIVERED', 'DELIVERY_FAILED');

create type media_resource_type as enum ('IMAGE', 'VIDEO');

create type media_status as enum ('PENDING', 'VERIFIED', 'REJECTED');

create type csv_batch_status as enum ('PROCESSING', 'COMPLETED', 'FAILED');

create type csv_row_status as enum ('SUCCESS', 'ERROR');

create type integration_job_status as enum ('PENDING', 'PROCESSING', 'RETRYING', 'SUCCEEDED', 'FAILED');

-- ============================================================
-- ADMIN_USERS
-- Profile table only — NOT auth. id references Supabase Auth's
-- own auth.users table; sign-in/passwords are fully owned by
-- Supabase Auth and never stored here.
-- ============================================================
create table admin_users (
    id uuid primary key references auth.users(id) on delete cascade,
    email text not null unique,
    full_name text,
    role text not null default 'admin',
    status admin_status not null default 'ACTIVE',
    created_at timestamptz not null default now()
);

-- ============================================================
-- CLICKUP_CONNECTIONS
-- One row per authorised ClickUp Workspace connection (OAuth).
-- ============================================================
create table clickup_connections (
    id uuid primary key default gen_random_uuid(),
    workspace_id text not null unique,
    workspace_name text,
    encrypted_access_token text not null,
    status clickup_connection_status not null default 'CONNECTED',
    connected_by uuid references admin_users(id),
    connected_at timestamptz not null default now()
);

create index idx_clickup_connections_status on clickup_connections(status);

-- ============================================================
-- CLIENTS
-- One row per client company of the cleaning business.
-- ============================================================
create table clients (
    id uuid primary key default gen_random_uuid(),
    client_code text not null unique,
    name text not null,
    contact_email text,
    contact_phone text,
    status client_site_status not null default 'ACTIVE',
    clickup_entity_id text,
    created_by uuid references admin_users(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index idx_clients_status on clients(status);
create index idx_clients_name on clients(name);

-- ============================================================
-- SITES
-- One row per physical location. Owns the permanent QR slug.
-- ============================================================
create table sites (
    id uuid primary key default gen_random_uuid(),
    client_id uuid not null references clients(id) on delete cascade,
    site_code text not null,
    slug text not null unique,
    site_name text not null,
    address text,
    status client_site_status not null default 'ACTIVE',
    clickup_entity_id text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint uq_client_site_code unique (client_id, site_code)
);

create index idx_sites_client_id on sites(client_id);
create index idx_sites_status on sites(status);
create index idx_sites_slug on sites(slug);

-- ============================================================
-- FEEDBACK_SUBMISSIONS
-- One row per customer feedback scan+submit. idempotency_key
-- guarantees a submission can never accidentally create more
-- than one ClickUp task.
-- ============================================================
create table feedback_submissions (
    id uuid primary key default gen_random_uuid(),
    site_id uuid not null references sites(id) on delete restrict,
    idempotency_key text not null unique,
    feedback text not null check (char_length(feedback) between 1 and 5000),
    mobile_number text check (char_length(mobile_number) <= 32),
    status feedback_status not null default 'SUBMITTED',
    clickup_task_id text,
    submitted_at timestamptz not null default now(),
    delivered_at timestamptz
);

create index idx_feedback_site_id on feedback_submissions(site_id);
create index idx_feedback_submitted_at on feedback_submissions(submitted_at);
create index idx_feedback_status on feedback_submissions(status);

-- ============================================================
-- FEEDBACK_MEDIA
-- Photos/videos attached to a feedback submission.
-- ============================================================
create table feedback_media (
    id uuid primary key default gen_random_uuid(),
    feedback_id uuid not null references feedback_submissions(id) on delete cascade,
    cloudinary_public_id text not null unique,
    resource_type media_resource_type not null,
    original_filename text,
    mime_type text not null,
    size_bytes integer not null check (size_bytes > 0),
    status media_status not null default 'PENDING',
    created_at timestamptz not null default now()
);

create index idx_feedback_media_feedback_id on feedback_media(feedback_id);

-- ============================================================
-- CSV_IMPORT_BATCHES
-- One row per bulk CSV upload event.
-- ============================================================
create table csv_import_batches (
    id uuid primary key default gen_random_uuid(),
    uploaded_by uuid references admin_users(id),
    filename text not null,
    status csv_batch_status not null default 'PROCESSING',
    total_rows integer not null default 0,
    success_count integer not null default 0,
    error_count integer not null default 0,
    created_at timestamptz not null default now()
);

create index idx_csv_batches_created_at on csv_import_batches(created_at);
create index idx_csv_batches_status on csv_import_batches(status);

-- ============================================================
-- CSV_IMPORT_ROWS
-- One row per line in a CSV upload, with per-row result.
-- ============================================================
create table csv_import_rows (
    id uuid primary key default gen_random_uuid(),
    batch_id uuid not null references csv_import_batches(id) on delete cascade,
    row_number integer not null,
    client_id uuid references clients(id) on delete set null,
    site_id uuid references sites(id) on delete set null,
    status csv_row_status not null,
    error_message text,
    created_at timestamptz not null default now(),

    constraint uq_batch_row_number unique (batch_id, row_number)
);

create index idx_csv_rows_batch_id on csv_import_rows(batch_id);

-- ============================================================
-- INTEGRATION_JOBS
-- The ClickUp delivery/retry engine for a feedback submission.
-- ============================================================
create table integration_jobs (
    id uuid primary key default gen_random_uuid(),
    feedback_id uuid not null references feedback_submissions(id) on delete cascade,
    job_type text not null default 'clickup_task_creation',
    status integration_job_status not null default 'PENDING',
    attempt_count integer not null default 0,
    next_attempt_at timestamptz,
    external_id text,
    last_error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint uq_feedback_job_type unique (feedback_id, job_type)
);

create index idx_integration_jobs_status on integration_jobs(status);
create index idx_integration_jobs_next_attempt on integration_jobs(next_attempt_at);

-- ============================================================
-- UPDATED_AT AUTO-TOUCH TRIGGER
-- ============================================================
create or replace function set_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

create trigger trg_clients_updated_at
before update on clients
for each row execute function set_updated_at();

create trigger trg_sites_updated_at
before update on sites
for each row execute function set_updated_at();

create trigger trg_integration_jobs_updated_at
before update on integration_jobs
for each row execute function set_updated_at();
