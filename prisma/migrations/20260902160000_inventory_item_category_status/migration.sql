-- ============================================================
-- Inventory form changes (confirmed with the user 2026-09-02):
--   1. inventory_items.item_type renamed to inventory_items.item -
--      it always held the specific item's name (e.g. "Toilet Paper"),
--      not a category; "Item Type" as a label was actively misleading
--      once a real category field was being added alongside it.
--   2. New inventory_items.category (new enum inventory_category) -
--      the actual "Types" dropdown: Chemical, PPE, Consumables (Paper
--      & Disposables), Cleaning Tools (Manual), Powered Equipment /
--      Machinery, Spare Parts, Other.
--   3. inventory_status expanded from 4 to 7 values: adds
--      URGENT_LOW_STOCK, OUT_OF_STOCK, GOOD alongside the existing
--      IN_STOCK, LOW_STOCK, NEEDS_REPAIR, OUT_OF_SERVICE.
-- ============================================================

alter table inventory_items rename column item_type to item;

create type inventory_category as enum (
  'CHEMICAL',
  'PPE',
  'CONSUMABLES',
  'CLEANING_TOOLS_MANUAL',
  'POWERED_EQUIPMENT_MACHINERY',
  'SPARE_PARTS',
  'OTHER'
);

-- Add nullable first so existing dev/test rows (no real production data
-- yet) can be backfilled before the NOT NULL constraint is applied -
-- same pattern as the admin_role backfill migration.
alter table inventory_items add column category inventory_category;
update inventory_items set category = 'OTHER' where category is null;
alter table inventory_items alter column category set not null;

-- Postgres allows ALTER TYPE ... ADD VALUE inside a transaction as long
-- as the new value isn't also used within that same transaction - these
-- three statements only add values, nothing here reads/writes them.
alter type inventory_status add value 'URGENT_LOW_STOCK';
alter type inventory_status add value 'OUT_OF_STOCK';
alter type inventory_status add value 'GOOD';
