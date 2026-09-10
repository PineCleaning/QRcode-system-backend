-- Exactly one ADMIN row, ever - a hard DB guarantee, not just an
-- app-level check a future code path could accidentally bypass.
-- Confirmed with the user 2026-09-10: the existing test@example.com
-- account stays the only Admin; nothing else in the system can ever
-- create or be promoted to a second one.
CREATE UNIQUE INDEX uq_admin_users_single_admin ON admin_users(role) WHERE role = 'ADMIN';

-- Deleting a non-Admin user (manually, or via the 21-days-inactive
-- auto-delete cron) must not be blocked by rows they created/touched -
-- null out the reference instead of failing the delete with a foreign
-- key violation. All 9 FKs referencing admin_users currently default
-- to NO ACTION (verified directly against the DB before writing this).
ALTER TABLE clickup_connections DROP CONSTRAINT clickup_connections_connected_by_fkey,
  ADD CONSTRAINT clickup_connections_connected_by_fkey FOREIGN KEY (connected_by) REFERENCES admin_users(id) ON DELETE SET NULL;

ALTER TABLE clients DROP CONSTRAINT clients_created_by_fkey,
  ADD CONSTRAINT clients_created_by_fkey FOREIGN KEY (created_by) REFERENCES admin_users(id) ON DELETE SET NULL;

ALTER TABLE csv_import_batches DROP CONSTRAINT csv_import_batches_uploaded_by_fkey,
  ADD CONSTRAINT csv_import_batches_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES admin_users(id) ON DELETE SET NULL;

ALTER TABLE inspection_items DROP CONSTRAINT inspection_items_created_by_fkey,
  ADD CONSTRAINT inspection_items_created_by_fkey FOREIGN KEY (created_by) REFERENCES admin_users(id) ON DELETE SET NULL;

ALTER TABLE inventory_history DROP CONSTRAINT inventory_history_changed_by_fkey,
  ADD CONSTRAINT inventory_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES admin_users(id) ON DELETE SET NULL;

ALTER TABLE inventory_items DROP CONSTRAINT inventory_items_created_by_fkey,
  ADD CONSTRAINT inventory_items_created_by_fkey FOREIGN KEY (created_by) REFERENCES admin_users(id) ON DELETE SET NULL;

ALTER TABLE inventory_items DROP CONSTRAINT inventory_items_updated_by_fkey,
  ADD CONSTRAINT inventory_items_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES admin_users(id) ON DELETE SET NULL;

ALTER TABLE site_inspections DROP CONSTRAINT site_inspections_completed_by_fkey,
  ADD CONSTRAINT site_inspections_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES admin_users(id) ON DELETE SET NULL;

ALTER TABLE site_inspections DROP CONSTRAINT site_inspections_created_by_fkey,
  ADD CONSTRAINT site_inspections_created_by_fkey FOREIGN KEY (created_by) REFERENCES admin_users(id) ON DELETE SET NULL;
