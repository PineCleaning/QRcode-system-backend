-- ============================================================
-- Add one-time-per-workspace ClickUp config columns to
-- clickup_connections, per the resolution of Open Decision #3
-- (2026-07-24): feedback becomes Tasks in one shared TICKETS list;
-- clients map to existing records in a COMPANIES list, linked via a
-- pre-existing Relationship custom field ("CLIENT NAME"). See
-- backend/CLAUDE.md and prisma/schema.prisma for full context.
--
-- site_field_id is added now but stays unused/null — reserved for if
-- sites become a structured ClickUp concept later. No new ClickUp
-- Lists, Folders, or custom fields are ever created programmatically;
-- these columns just cache IDs of things that already exist in the
-- client's workspace.
-- ============================================================

alter table clickup_connections
    add column tickets_list_id text,
    add column companies_list_id text,
    add column client_field_id text,
    add column site_field_id text;
