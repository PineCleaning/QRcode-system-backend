-- Pure naming swap, no data change: rename the human-readable client
-- code column to client_id, and the client foreign-key columns to
-- client_code. Each table only has ONE of the two names today, so
-- there is no in-table collision and no temp-column step is needed.
-- ALTER TABLE ... RENAME COLUMN preserves all existing data, FK
-- constraints (ON DELETE CASCADE / SET NULL), indexes, and the unique
-- constraint automatically - only the column identifier changes.

-- clients.client_code (the short human code, e.g. "horizon-retail") -> client_id
ALTER TABLE "clients" RENAME COLUMN "client_code" TO "client_id";

-- sites.client_id (the UUID FK to clients.id, ON DELETE CASCADE) -> client_code
ALTER TABLE "sites" RENAME COLUMN "client_id" TO "client_code";

-- csv_import_rows.client_id (the nullable UUID FK to clients.id, ON DELETE SET NULL) -> client_code
ALTER TABLE "csv_import_rows" RENAME COLUMN "client_id" TO "client_code";
