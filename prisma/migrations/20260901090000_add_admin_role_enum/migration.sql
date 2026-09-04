-- ============================================================
-- Phase 2, Week 1 Mon: convert admin_users.role from a free-text
-- string (default 'admin') to a real enum (ADMIN / SUPERVISOR).
--
-- Explicit backfill sets EVERY existing row to ADMIN, regardless
-- of its prior string value. This is deliberate and confirmed
-- safe: Phase 1 never had multiple roles, so every account that
-- exists today should remain a full ADMIN — Supervisors are only
-- ever created going forward via the new User Management tab.
-- ============================================================

create type admin_role as enum ('ADMIN', 'SUPERVISOR');

alter table admin_users add column role_new admin_role;

update admin_users set role_new = 'ADMIN';

alter table admin_users alter column role_new set not null;
alter table admin_users alter column role_new set default 'ADMIN';

alter table admin_users drop column role;
alter table admin_users rename column role_new to role;
