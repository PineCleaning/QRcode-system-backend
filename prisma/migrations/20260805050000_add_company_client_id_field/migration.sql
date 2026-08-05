-- Cache the ID of the "CLIENT ID" field that already exists on the
-- COMPANIES list, so Company lookups can match on a unique client_id
-- instead of an ambiguous, possibly-duplicated name. Additive/nullable,
-- no existing data affected.
ALTER TABLE "clickup_connections" ADD COLUMN "company_client_id_field_id" TEXT;
