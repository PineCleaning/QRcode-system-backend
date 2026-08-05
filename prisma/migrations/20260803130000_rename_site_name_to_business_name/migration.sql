-- Rename sites.site_name to sites.business_name. Existing data is
-- preserved by ALTER TABLE ... RENAME COLUMN - no rows are touched,
-- only the column identifier changes.
ALTER TABLE "sites" RENAME COLUMN "site_name" TO "business_name";
