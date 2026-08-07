-- Admin no longer needs Contact Email / Contact Phone on clients - dropped everywhere (schema, DTOs, CSV import, admin UI).
ALTER TABLE "clients" DROP COLUMN IF EXISTS "contact_email";
ALTER TABLE "clients" DROP COLUMN IF EXISTS "contact_phone";
