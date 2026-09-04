-- ============================================================
-- Phase 2, Week 1 Mon: Inventory / Assets and Site Inspections
-- tables. Purely additive — no existing table is touched.
-- ============================================================

create type inventory_status as enum ('IN_STOCK', 'LOW_STOCK', 'NEEDS_REPAIR', 'OUT_OF_SERVICE');
create type inspection_session_status as enum ('OPEN', 'COMPLETED');
create type inspection_rating as enum ('EXCELLENT', 'ABOVE_AVERAGE', 'AVERAGE', 'BELOW_AVERAGE', 'VERY_POOR');

-- ============================================================
-- INVENTORY_ITEMS
-- Site-level supply/asset records (discovery doc §1.3).
-- item_type is plain text, not an enum — the client's full type
-- list isn't finalized, so this stays flexible.
-- ============================================================
create table inventory_items (
    id uuid primary key default gen_random_uuid(),
    site_id uuid not null references sites(id) on delete cascade,
    item_type text not null,
    status inventory_status not null,
    quantity integer not null,
    last_supply_date timestamptz,
    notes text,
    created_by uuid references admin_users(id),
    updated_by uuid references admin_users(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index idx_inventory_items_site on inventory_items(site_id);

-- ============================================================
-- INVENTORY_HISTORY
-- Snapshot of an inventory item's PRE-update values. Capped at
-- the 10 most recent rows per item — pruned in application code
-- (InventoryService), not a DB constraint. Confirmed with the
-- user 2026-08-29 ("Q3").
-- ============================================================
create table inventory_history (
    id uuid primary key default gen_random_uuid(),
    inventory_item_id uuid not null references inventory_items(id) on delete cascade,
    previous_quantity integer not null,
    previous_status inventory_status not null,
    previous_notes text,
    changed_by uuid references admin_users(id),
    changed_at timestamptz not null default now()
);

create index idx_inventory_history_item on inventory_history(inventory_item_id);

-- ============================================================
-- SITE_INSPECTIONS
-- One inspection session per site. A session can span multiple
-- visits/days and stays OPEN until every space/item is covered
-- (rated or marked Not Applicable) and explicitly finished —
-- confirmed with the user 2026-08-29 ("Q1"/"Q2"). Only one OPEN
-- session per site at a time (partial unique index below).
-- ============================================================
create table site_inspections (
    id uuid primary key default gen_random_uuid(),
    site_id uuid not null references sites(id) on delete cascade,
    status inspection_session_status not null default 'OPEN',
    average_score integer,
    meets_standard boolean,
    created_by uuid references admin_users(id),
    completed_by uuid references admin_users(id),
    started_at timestamptz not null default now(),
    completed_at timestamptz
);

create index idx_site_inspections_site on site_inspections(site_id);
create index idx_site_inspections_status on site_inspections(status);

-- Only one OPEN inspection session per site at a time.
create unique index uq_site_open_inspection on site_inspections(site_id) where status = 'OPEN';

-- ============================================================
-- INSPECTION_ITEMS
-- One row per space/area/item inspected within a session.
-- rating/percentage are null when is_not_applicable is true.
-- ============================================================
create table inspection_items (
    id uuid primary key default gen_random_uuid(),
    inspection_id uuid not null references site_inspections(id) on delete cascade,
    space_name text not null,
    is_not_applicable boolean not null default false,
    rating inspection_rating,
    percentage integer,
    notes text,
    created_by uuid references admin_users(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index idx_inspection_items_inspection on inspection_items(inspection_id);

-- ============================================================
-- INSPECTION_MEDIA
-- Attachments for an inspection item. No stored URL — derive it
-- from cloudinary_public_id + resource_type at read time, same
-- pattern as feedback_media. Reuses the existing media_resource_type
-- / media_status enums from the init migration.
-- ============================================================
create table inspection_media (
    id uuid primary key default gen_random_uuid(),
    inspection_item_id uuid not null references inspection_items(id) on delete cascade,
    cloudinary_public_id text not null unique,
    resource_type media_resource_type not null,
    original_filename text,
    mime_type text not null,
    size_bytes integer not null,
    status media_status not null default 'PENDING',
    uploaded_at timestamptz not null default now()
);

create index idx_inspection_media_item on inspection_media(inspection_item_id);

-- ============================================================
-- UPDATED_AT AUTO-TOUCH TRIGGERS
-- (reuses set_updated_at() defined in the init migration)
-- ============================================================
create trigger trg_inventory_items_updated_at
before update on inventory_items
for each row execute function set_updated_at();

create trigger trg_inspection_items_updated_at
before update on inspection_items
for each row execute function set_updated_at();

-- ============================================================
-- RLS — same "active admins only" defense-in-depth pattern as
-- the rest of the schema (20260806070000). anon has never been
-- granted access to these new tables in the first place (they're
-- created after the earlier anon-revoke migration), so no REVOKE
-- is needed here. RLS is enabled explicitly rather than relying
-- on the project's "automatic RLS" event trigger firing reliably
-- for tables created via a direct pg connection.
-- ============================================================
alter table inventory_items enable row level security;
alter table inventory_history enable row level security;
alter table site_inspections enable row level security;
alter table inspection_items enable row level security;
alter table inspection_media enable row level security;

create policy "active admins only" on inventory_items for all to authenticated using (is_active_admin()) with check (is_active_admin());
create policy "active admins only" on inventory_history for all to authenticated using (is_active_admin()) with check (is_active_admin());
create policy "active admins only" on site_inspections for all to authenticated using (is_active_admin()) with check (is_active_admin());
create policy "active admins only" on inspection_items for all to authenticated using (is_active_admin()) with check (is_active_admin());
create policy "active admins only" on inspection_media for all to authenticated using (is_active_admin()) with check (is_active_admin());
