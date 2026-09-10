-- Adds two new admin_role values (confirmed with the user 2026-09-10):
-- Manager and Admin Support get identical access to Supervisor today -
-- this app's whole authorization model is already binary (ADMIN vs.
-- everyone else, via @Roles('ADMIN') allow-lists), so no new guard
-- logic is needed for these to work - just the two enum values.
--
-- Kept in its own migration file, deliberately not combined with any
-- statement that USES these values (e.g. the single-admin partial
-- unique index or a data migration) - Postgres disallows using a
-- newly-added enum value in the same transaction it was added in.
ALTER TYPE admin_role ADD VALUE 'MANAGER';
ALTER TYPE admin_role ADD VALUE 'ADMIN_SUPPORT';
