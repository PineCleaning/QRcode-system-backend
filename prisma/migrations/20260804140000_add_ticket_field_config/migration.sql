-- Cache the ClickUp field IDs needed to write a ticket's Request Details
-- and Request Type fields, alongside the existing cached Client Name
-- field ID. All nullable/additive - no existing data affected.
ALTER TABLE "clickup_connections" ADD COLUMN "request_details_field_id" TEXT;
ALTER TABLE "clickup_connections" ADD COLUMN "request_type_field_id" TEXT;
ALTER TABLE "clickup_connections" ADD COLUMN "request_type_other_option_id" TEXT;
