-- Rename clients.name to clients.client_name for clarity (was ambiguous
-- next to sites.business_name and admin_users.full_name).
ALTER TABLE "clients" RENAME COLUMN "name" TO "client_name";

-- The existing index on the old column name is renamed to match.
ALTER INDEX "idx_clients_name" RENAME TO "idx_clients_client_name";
