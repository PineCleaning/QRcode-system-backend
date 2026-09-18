-- Removes the "Last Supplied" field entirely - confirmed unused anywhere
-- else in the app (no index, no unique constraint, no sort order, no
-- CSV export, no derived logic reads it) before this migration was written.
ALTER TABLE "inventory_items" DROP COLUMN "last_supplied";
